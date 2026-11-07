// What the framework keeps of the agent's inputs (graph-integrity G3.5), at the real mux with the fake app-server: the `mod_` names are
// the framework's on every start the app makes (its own of that name are left out), and a mod's mention carries its context to the next
// message that keeps it (public-hooks.md §3.14). The agent's inputs themselves are the graph's acts (sdk/agent.mjs, app-ops, the provider).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../../mux/test/helpers.mjs';
import { createAgentHost, contentItems, namespaceOf } from '../index.mjs';

async function setup() {
  const m = await harness();
  const agent = createAgentHost({ mux: m.mux, log: m.log, nameOf: (id) => `Mod ${id}` });
  await m.up();
  let seq = 0;
  const received = (method) => m.serverLog().map((l) => JSON.parse(l.slice(l.indexOf(" ") + 1))).filter((x) => x.method === method);
  return { m, agent, request: (method, params) => m.app.request(`r${++seq}`, method, params), received, close: async () => { agent.dispose(); await m.close(); } };
}

test('the mod_ names are the framework\'s: a start the app makes has its own of that name left out, ephemeral or not; the others pass', async () => {
  const { request, received, close } = await setup();
  try {
    for (const ephemeral of [true, false]) {
      await request('thread/start', { ephemeral, dynamicTools: [{ type: 'namespace', name: 'mod_test_one', description: 'forged', tools: [] }, { type: 'function', name: 'app_tool', description: 'd', inputSchema: { type: 'object' } }] });
      assert.deepEqual(received('thread/start').at(-1).params.dynamicTools.map((t) => t.name), ['app_tool']);
    }
    await request('thread/start', { dynamicTools: [{ type: 'function', name: 'app_tool', description: 'd', inputSchema: { type: 'object' } }] });
    assert.deepEqual(received('thread/start').at(-1).params.dynamicTools.map((t) => t.name), ['app_tool'], 'nothing to leave out: as it came');
    assert.equal(namespaceOf('test.one'), 'mod_test_one');
    assert.equal(namespaceOf('a'.repeat(80)).length, 64, 'a long id: its start and a hash');
  } finally { await close(); }
});

test('a tool\'s result: text, {text}, {image}, a list; anything else, too many or too large is refused', () => {
  assert.deepEqual(contentItems(undefined), []);
  assert.deepEqual(contentItems('a'), [{ type: 'inputText', text: 'a' }]);
  assert.deepEqual(contentItems({ image: 'https://x/y.png' }), [{ type: 'inputImage', imageUrl: 'https://x/y.png' }]);
  assert.throws(() => contentItems({ image: 'file:///etc/passwd' }), /result is text/);
  assert.throws(() => contentItems([1]), /result is text/);
  assert.throws(() => contentItems(Array(65).fill('a')), /at most 64/);
  assert.throws(() => contentItems('a'.repeat(9 * 1024 * 1024)), /larger than 8 MB/);
});

test('public hooks §3.14: a mention\'s context goes with the next message from its draft that keeps the mention, as data naming the mod; once', async () => {
  const { agent, request, received, close } = await setup();
  try {
    const text = (t) => [{ type: 'text', text: t, text_elements: [] }];
    agent.mentioned('thr-1', { mod: 'test.m', label: 'T-7', context: 'Status: open. Owner: ana.' });
    agent.mentioned('thr-1', { mod: 'test.m', label: 'T-9', context: 'Closed.' });
    await request('turn/start', { threadId: 'thr-1', input: text('look at T-7 please'), additionalContext: { codex_git_state: { kind: 'untrusted', value: 'G' } } });
    assert.deepEqual(received('turn/start').at(-1).params.additionalContext, { codex_git_state: { kind: 'untrusted', value: 'G' },
      'mention:test.m': { kind: 'untrusted', value: '“T-7” (mentioned in this message; context from Mod test.m):\nStatus: open. Owner: ana.' } });
    await request('turn/start', { threadId: 'thr-1', input: text('T-7 again') });
    assert.equal(received('turn/start').at(-1).params.additionalContext, undefined, 'taken once; T-9 not in it, kept');
    await request('turn/start', { threadId: 'thr-1', input: text('and T-9') });
    assert.match(received('turn/start').at(-1).params.additionalContext['mention:test.m'].value, /“T-9”/);
    // a new chat's composer: its first message, whatever thread it starts
    agent.mentioned('new:app:new-conversation', { mod: 'test.m', label: 'QA-1', context: 'Priority high.' });
    await request('turn/start', { threadId: 'thr-new', input: text('fix QA-1') });
    assert.match(received('turn/start').at(-1).params.additionalContext['mention:test.m'].value, /Priority high/);
    assert.equal(agent.mentioned('thr-1', { mod: 'test.m', label: ' ', context: 'x' }), false);
  } finally { await close(); }
});
