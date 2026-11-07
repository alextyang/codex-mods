// Run with: node --test
// The SDK's testing kit is `@codexmods/sdk/testing`; inside the codexmods repository it is loaded from the checkout.
// createTestGraph runs the mod's host entry in a worker against the real graph, as the Host does; the test acts as the user would in
// the app (`invoke`, as the user by default). createFakeRendererContext draws its view, reading that graph as the mod.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('@codexmods/sdk/testing').catch(() => import('../../../testing/index.mjs'));
const here = fileURLToPath(new URL('..', import.meta.url));
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });
const words = (c) => c.parts.map((p) => p.text).join('');

test('its agent is listed with a first chat; a message gets a turn whose reply echoes it, word by word; its chats survive a restart', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const mod = await g.mod(here);
  const [agent] = g.graph.list('EchoAgent');
  assert.equal(agent.state.name, 'Echo agent');
  const made = await g.invoke(agent.ref, 'newThread', [null]);   // as the app's new-chat page asks it (with its Draft, here none)
  assert.equal(made.status, 'done');
  const chat = made.value;
  const sent = await g.invoke(chat, 'send', [text('hello there')]);
  assert.equal(sent.status, 'done');
  const turn = sent.value;
  const answer = await g.waitFor(() => {
    const a = g.graph.related(turn, 'answer');
    return a && a.state.streaming === false ? a : null;
  }, { what: 'the whole reply' });
  assert.equal(words(answer.state.content), 'You said: hello there');
  assert.deepEqual([g.graph.resolve(turn).state.status, g.graph.resolve(turn).state.startedBy], ['completed', { kind: 'user' }]);
  // the reply is whole before its chat is idle again: a reply waits to be read once the chat is
  assert.ok(await g.waitFor(() => { const c = g.graph.resolve(chat).state; return c.status === 'idle' && c.unread === true; }, { what: 'the chat idle, its reply unread' }), 'a reply waits to be read');
  // a restart: its chats, as it kept them
  await mod.stop();
  await g.mod(here);
  assert.ok(g.graph.list('EchoThread').some((x) => x.ref.id === chat.id && !x.gone));
  assert.equal(words(g.graph.related(turn, 'answer').state.content), 'You said: hello there');
});

test('its chats open to its own view, drawn with the parts the framework lends', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const mod = await g.mod(here);
  const [chat] = g.graph.list('EchoThread');
  const sent = await g.invoke(chat.ref, 'send', [text('draw me')]);
  await g.waitFor(() => g.graph.resolve(sent.value).state.status === 'completed', { what: 'the reply' });
  const { control } = createFakeRendererContext({ manifest: mod.manifest, graph: mod.renderer().graph });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  const view = control.rules.get('view');
  assert.deepEqual([view.kind, view.target, view.spec.for], ['replace', 'ThreadView', 'EchoThread']);
  const root = await control.render('view', { subject: g.graph.resolve(chat.ref) });
  await root.until(() => /You said: draw me/.test(root.text()));
  await g.waitFor(() => g.graph.resolve(chat.ref).state.unread === false, { what: 'read once shown' });
});
