// The SDK's agent helpers (sdk/agent.mjs, graph-integrity G3.5) through the testing kit's agent bridge: two mods' instructions in the
// order of their mods, on a start, a resume and a fork; a turn's context; a tool added under the mod's namespace and answered by it, and
// by the framework while it is off; the provider's referee refusing one mod's change of another's tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestGraph } from '../index.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const blocks = (text) => [...String(text ?? '').matchAll(/<mod_instructions mod="([^"]+)">/g)].map((m) => m[1]);

test('two mods\' instructions join a start, a resume that sends instructions and a fork, once each, in their mods\' order', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  await g.mod(fixture('agent-a'));
  await g.mod(fixture('agent-b'));
  const start = await agent.start({ cwd: '/repo', developerInstructions: 'The app\'s own.' });
  assert.ok(start.params.developerInstructions.startsWith('The app\'s own.'), 'the app\'s own first');
  assert.deepEqual(blocks(start.params.developerInstructions), ['example.agent-a', 'example.agent-b']);
  assert.deepEqual((await agent.start({ ephemeral: true })).params, { ephemeral: true }, 'the app\'s helpers\' threads get nothing');
  agent.thread('t1', { cwd: '/repo' });
  const resumed = await agent.resume('t1', { developerInstructions: start.params.developerInstructions });
  assert.deepEqual(blocks(resumed.params.developerInstructions), ['example.agent-a', 'example.agent-b'], 'once each: already there');
  assert.deepEqual((await agent.resume('t1', { excludeTurns: true })).params, { excludeTurns: true }, 'a resume that sends no instructions is left as it is');
  assert.deepEqual(blocks((await agent.fork('t1', {})).params.developerInstructions), ['example.agent-a', 'example.agent-b']);
  // a function's text goes with each turn, under the mod's own key
  const sent = await agent.send('t1', 'hello');
  assert.deepEqual(sent.params.additionalContext, { 'mod:example.agent-a': { kind: 'application', value: 'A this turn, in t1.' } });
});

test('a turn\'s context only in the chats a scope\'s where keeps (a role, say)', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  await g.mod(fixture('agent-c'));
  agent.thread('lead', { cwd: '/repo', title: 'Lead' });
  agent.thread('other', { cwd: '/repo', title: 'Other' });
  assert.deepEqual((await agent.send('lead', 'hi')).params.additionalContext, { 'mod:example.agent-c': { kind: 'application', value: 'C for the lead chat lead.' } });
  assert.deepEqual((await agent.send('other', 'hi')).params, {}, 'a chat the where does not keep gets nothing');
});

test('a tool joins a start under its mod\'s namespace and is answered by its mod; off, the framework says so; another mod may not add it', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const a = await g.mod(fixture('agent-a'));
  await g.mod(fixture('agent-b'));
  const start = await agent.start({ dynamicTools: [{ type: 'function', name: 'app_tool', description: 'the app\'s', inputSchema: { type: 'object' } }] });
  const ns = start.params.dynamicTools.find((x) => x.name === 'mod_example_agent-a');
  assert.deepEqual([start.params.dynamicTools[0].name, ns.type, ns.tools.map((x) => x.name)], ['app_tool', 'namespace', ['echo']], 'after the app\'s own');
  const out = await agent.call('mod_example_agent-a', 'echo', { text: 'hi' }, { call: 'c1' });
  assert.deepEqual([out.status, out.value], ['done', 'A-ECHO hi (c1)']);
  // another mod's change of a's tools is refused, naming it
  const forged = await agent.start({ forge: true });
  assert.equal(forged.refused?.reason, 'notAllowed');
  assert.match(forged.refused.message, /changed by example\.agent-b: it adds another mod's tools \(mod_example_agent-a\)/);
  // a mod that is off: its tool's call fails with a reason, never reaching anything else
  await a.stop();
  const off = await agent.call('mod_example_agent-a', 'echo', { text: 'hi' });
  assert.equal(off.status, 'refused');
  assert.match(off.message, /not available now/);
});
