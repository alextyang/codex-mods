// Run with: node --test
// The SDK's testing kit is `@codexmods/sdk/testing`; inside the codexmods repository it is loaded from the checkout.
// createTestGraph runs the mod's host entry in a worker against the real graph; its `agent()` is the agent's side, offline: a message
// sent there runs the interceptors as the app's own send does, and answers what the agent would be given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('@codexmods/sdk/testing').catch(() => import('../../../testing/index.mjs'));
const here = fileURLToPath(new URL('..', import.meta.url));

test('a chat\'s focus goes with each message sent in that chat; a chat without one gets nothing', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const focused = agent.thread('t1'), other = agent.thread('t2');
  const mod = await g.mod(here);
  await mod.renderer().settings.set('focus', 'the release notes', { scope: { thread: focused } });
  const sent = await agent.send('t1', 'What is left?');
  assert.deepEqual(sent.params.additionalContext?.['mod:example.contribution'], { kind: 'application', value: 'Keep in mind in this chat: the release notes' });
  const plain = await agent.send(other.id, 'Hello');
  assert.equal(plain.params.additionalContext?.['mod:example.contribution'], undefined);
});

test('the chat\'s focus is set above its composer, with the framework\'s own setting row', async (t) => {
  const manifest = (await import('node:fs')).readFileSync(new URL('../mod.json', import.meta.url), 'utf8');
  const { control } = createFakeRendererContext({ manifest: JSON.parse(manifest) });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  const band = control.hostRules.get('focus');
  assert.deepEqual([band.presentation, band.slot], ['Composer', 'aboveInput']);
});
