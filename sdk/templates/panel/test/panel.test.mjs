// Run with: node --test
// The SDK's testing kit is `@codexmods/sdk/testing`; inside the codexmods repository it is loaded from the checkout.
// createTestGraph is the graph the mod meets in the app, offline (the app's own chats come from a provider the test declares);
// createFakeRendererContext draws what the mod declares, reading that graph as the mod.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('@codexmods/sdk/testing').catch(() => import('../../../testing/index.mjs'));
const here = fileURLToPath(new URL('..', import.meta.url));

test('the outline lists what was asked in each of the chat\'s turns, and follows the chat as it goes on', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  // the app's own chat, with one turn and its message (as the Codex provider puts them)
  const codex = g.provider('codex', { CodexAgent: {}, CodexThread: {}, CodexTurn: {}, UserMessage: {} });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  const chat = { type: 'CodexThread', provider: 'codex', id: 'c1' };
  codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(chat, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent } });
  const turn = (id, text, at) => {
    const ref = { type: 'CodexTurn', provider: 'codex', id };
    codex.put(ref, { state: { status: 'completed', startedAt: at, startedBy: { kind: 'user' } }, links: { thread: chat } });
    codex.put({ type: 'UserMessage', provider: 'codex', id: `${id}-m` }, { state: { content: { parts: [{ kind: 'text', text }] }, createdAt: at, steering: false }, links: { turn: ref } });
  };
  turn('t1', 'Plan the release', 10);

  const mod = await g.mod(here);
  const { control } = createFakeRendererContext({ manifest: mod.manifest, graph: mod.renderer().graph });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  assert.ok(control.panels.has('outline'), 'its tab is declared');
  const root = await control.render('outline', { thread: chat });
  await root.until(() => /Plan the release/.test(root.text()));
  turn('t2', 'Write the notes', 20);
  await root.until(() => /Plan the release.*Write the notes/s.test(root.text()));

  const none = await control.render('outline', { thread: null });
  assert.match(none.text(), /No chat here/);
});
