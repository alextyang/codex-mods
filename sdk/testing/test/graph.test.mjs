// The testing kit's graph (sdk/testing/graph.mjs): the real runtime, a fake provider of the app's chats, and a mod in its worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestGraph } from '../graph.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/graph-mod', import.meta.url));
const NOW = Date.parse('2026-11-05T00:00:00Z');

/** The app's own agent and one chat, from a fake native provider that renames and archives in memory. */
function codexChats(t) {
  const codex = t.provider('codex', {
    CodexAgent: {},
    CodexThread: {
      operations: {
        rename: (call) => { codex.update(call.ref, { state: { title: call.args[0] } }); },
        archive: (call) => { codex.update(call.ref, { state: { archived: true } }); },
      },
    },
  });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  const chat = (id, title) => {
    const ref = { type: 'CodexThread', provider: 'codex', id };
    codex.put(ref, { state: { title, status: 'idle', unread: false, archived: false, origin: 'user', createdAt: NOW, updatedAt: NOW }, links: { agent } });
    return ref;
  };
  return { codex, chat };
}

test('a mod runs in its worker against the real graph: its act is made as the mod, its interceptor refuses as the app', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const { chat } = codexChats(g);
  const a = chat('a', 'Plans'), keep = chat('k', 'keep: notes');
  const mod = await g.mod(FIXTURE);
  const seen = [];
  g.graph.onOperation((e) => seen.push(e));
  const out = await mod.call('fixture', 'rename', { ref: a, title: 'Renamed by the mod' });
  assert.equal(out.status, 'done');
  assert.equal(g.graph.resolve(a).state.title, 'Renamed by the mod');
  assert.deepEqual(seen.at(-1).caller, { kind: 'mod', id: 'example.graph-mod', owner: 'mod:example.graph-mod' });
  // the user's archive passes the mod's interceptor, except for the chat it keeps
  assert.equal((await g.invoke(a, 'archive')).status, 'done');
  const refused = await g.invoke(keep, 'archive');
  assert.deepEqual([refused.status, refused.reason, refused.message], ['refused', 'notAllowed', 'kept by the graph mod']);
  assert.equal(g.graph.resolve(keep).state.archived, false);
  assert.deepEqual(await mod.call('fixture', 'count'), { archived: 1 });
});

test('a mod holds only what it was granted: without its act grant, its rename is refused', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const { chat } = codexChats(g);
  const a = chat('a', 'Plans');
  const mod = await g.mod(FIXTURE, { grants: ['graph', 'graph.read:Thread', 'graph.intercept:Thread.archive'] });
  const out = await mod.call('fixture', 'rename', { ref: a, title: 'No' });
  assert.equal(out.status, 'refused');
  assert.equal(out.reason, 'notAllowed');
  assert.equal(g.graph.resolve(a).state.title, 'Plans');
});

test('the renderer realm reads and acts through the same graph, as the mod', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const { chat } = codexChats(g);
  const a = chat('a', 'Plans');
  const mod = await g.mod(FIXTURE);
  const ui = mod.renderer();
  assert.deepEqual((await ui.graph.list('Thread')).map((s) => s.state.title), ['Plans']);
  assert.equal((await ui.graph.invoke(a, 'rename', ['From the page'])).status, 'done');
  assert.equal(g.graph.resolve(a).state.title, 'From the page');
});

test('stopping a mod takes its interceptor with it', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const { chat } = codexChats(g);
  const keep = chat('k', 'keep: notes');
  const mod = await g.mod(FIXTURE);
  assert.equal((await g.invoke(keep, 'archive')).status, 'refused');
  await mod.stop();
  assert.equal((await g.invoke(keep, 'archive')).status, 'done');
});
