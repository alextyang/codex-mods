// The native provider's feature areas (areas.mjs): an area's operations join a type the core registers, its feed hears the source's
// notifications, the answers to requests and the start, takes the refs it observes, reaches framework-main through its own area channel,
// and goes with the source. The real mux with the fake app-server and the graph runtime; a test area.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A test area: Thread.pin through framework-main, and what its feed heard. */
function testArea(heard) {
  return {
    realizes: { operations: { Thread: ['pin'] } },
    types: (feed) => ({ Thread: { operations: { pin: { effect: 'local', handler: ({ ref }) => feed().pin(ref) } } } }),
    createFeed(ctx) {
      heard.ctx = ctx;
      return {
        start() { heard.started = true; },
        serverUp() { heard.ups = (heard.ups ?? 0) + 1; },
        notified(method) { heard.notes.push(method); },
        responded(method) { heard.responses.push(method); },
        observe(ref) { if (ref.type === 'QueuedMessage') { heard.observed.push(ref.id); return Promise.resolve(); } return undefined; },
        async pin(ref) { const r = await ctx.mainOp('pin', { threadId: ref.id }); return r.ok ? null : { status: 'refused', reason: 'unavailable', message: r.error }; },
        dispose() { heard.disposed = true; },
      };
    },
  };
}

test('an area adds its operations, hears the source, reaches framework-main through its own channel and goes with the source', async () => {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-areas-'));
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const sent = [];
  let mainOps = null;
  mainOps = createMainOps({ log: quiet, send: (m) => { sent.push(m); queueMicrotask(() => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true })); } });
  const heard = { notes: [], responses: [], observed: [] };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, mainOps, areas: { pins: testArea(heard) } });
  try {
    await source.start();
    assert.equal(heard.started, true);
    const started = (await h.app.request(1, 'thread/start', { cwd: '/tmp' })).result;
    const ref = { type: 'CodexThread', provider: 'codex', id: started.thread.id };
    await until(() => graph.resolve(ref), 3000, 'the thread');
    await until(() => heard.notes.includes('thread/started'), 3000, 'a notification');
    await h.app.request(2, 'thread/name/set', { threadId: started.thread.id, name: 'Named' });
    await until(() => heard.responses.includes('thread/name/set'), 3000, 'the answer to the app\'s request');
    await h.app.request(3, 'thread/list', { limit: 5 });
    assert.equal((await graph.invoke({ ref, operation: 'pin', args: [], caller: { kind: 'mod', id: 'm.a' } })).status, 'done');
    assert.deepEqual(sent.map((m) => [m.type, m.area, m.op, m.args.threadId]), [['area-op', 'pins', 'pin', ref.id]], 'its own area name');
    assert.equal(typeof heard.ctx.area('pins').pin, 'function', 'an area by name');
    assert.equal(heard.ctx.area('nope'), null);
    assert.ok(heard.responses.includes('thread/start') && heard.responses.includes('thread/list'), 'every answer, the read methods\' too (after the core put the thread)');
    // the core keeps its own operations next to the area's
    assert.equal((await graph.invoke({ ref, operation: 'rename', args: ['x'], caller: { kind: 'mod', id: 'm.a' } })).status, 'done');
  } finally {
    await source.dispose();
    graph.close();
    mainOps.dispose();
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(heard.disposed, true);
});

test('two definitions of one operation are refused when the source is made', async () => {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-areas-'));
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  try {
    const twice = { types: () => ({ Thread: { operations: { rename: { effect: 'none', handler: () => null } } } }), createFeed: () => ({}) };
    assert.throws(() => createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, areas: { twice } }), /Thread\.rename is defined twice/);
  } finally { graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Setting an area owns: the core\'s Setting.set and reset hand it to the area, with the area\'s R17 prompt', async () => {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-areas-'));
  const prompts = [];
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals: { ask: async (q) => { prompts.push(q.action); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const writes = [];
  const owned = {
    createFeed(ctx) {
      const ref = { type: 'Setting', provider: 'codex', id: 'config:web_search' };
      ctx.handle.put(ref, { state: { title: 'Web search', value: 'cached', default: null, scope: 'app', kind: 'choice' }, links: { section: ctx.refs.settingsSection('agent'), definedBy: ctx.refs.agent() } });
      return { settings: {
        owns: (r) => r.id.startsWith('config:'),
        // The change lets the area ask nothing for a write that would change nothing.
        prompt: (instance, change) => (change.op === 'set' && change.value === instance.state.value ? null : { action: `${change.op} “${instance.state.title}”${change.op === 'set' ? ` to ${change.value}` : ''}`, detail: 'x' }),
        write: (r, value) => { writes.push(['write', r.id, value]); return null; },
        reset: (r) => { writes.push(['reset', r.id]); return null; },
      } };
    },
  };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, areas: { owned } });
  try {
    await source.start();
    const ref = { type: 'Setting', provider: 'codex', id: 'config:web_search' };
    const r1 = await graph.invoke({ ref, operation: 'set', args: ['live'], caller: { kind: 'mod', id: 'm.a' } });
    assert.equal(r1.status, 'done', JSON.stringify(r1));
    const r2 = await graph.invoke({ ref, operation: 'reset', args: [], caller: { kind: 'user', id: 'user', owner: 'app' } });
    assert.equal(r2.status, 'done', JSON.stringify(r2));
    const r3 = await graph.invoke({ ref, operation: 'set', args: ['cached'], caller: { kind: 'mod', id: 'm.a' } });
    assert.equal(r3.status, 'done', JSON.stringify(r3));
    const r4 = await graph.invoke({ ref, operation: 'reset', args: [], caller: { kind: 'mod', id: 'm.a' } });
    assert.equal(r4.status, 'done', JSON.stringify(r4));
    assert.deepEqual(writes, [['write', 'config:web_search', 'live'], ['reset', 'config:web_search'], ['write', 'config:web_search', 'cached'], ['reset', 'config:web_search']]);
    assert.deepEqual(prompts, ['set “Web search” to live', 'reset “Web search”'], 'the area\'s prompt with the change, for a mod\'s call only, none for a write that changes nothing');
  } finally { await source.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withLoadedThread: a request the app-server refuses with "thread not found" runs again after the thread is resumed; other errors pass', async () => {
  const h = await harness();
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const heard = { notes: [], responses: [], observed: [] };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, areas: { pins: testArea(heard) } });
  try {
    await source.start();
    const id = (await h.app.request(5, 'thread/start', { cwd: '/tmp' })).result.thread.id;
    let calls = 0;
    const out = await heard.ctx.withLoadedThread(id, async () => { calls += 1; if (calls === 1) throw new Error(`thread not found: ${id}`); return 'sent'; });
    assert.deepEqual([out, calls], ['sent', 2]);
    let queued = 0;   // thread/queue/start's own wording
    assert.equal(await heard.ctx.withLoadedThread(id, async () => { queued += 1; if (queued === 1) throw new Error('resume the thread before starting a queued message'); return 'started'; }), 'started');
    await until(() => heard.responses.includes('thread/resume'), 2000, 'the thread resumed in between');
    let other = 0;
    await assert.rejects(heard.ctx.withLoadedThread(id, async () => { other += 1; throw new Error('quota exceeded'); }), /quota exceeded/);
    assert.equal(other, 1, 'no resume and no second try for another error');
  } finally { await source.dispose(); graph.close(); await h.close(); }
});

test('the areas start at the first app-server ready when nothing calls start() (as the Host runs the source); later readies are serverUp', async () => {
  const h = await harness();
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const heard = { notes: [], responses: [], observed: [] };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, areas: { pins: testArea(heard) } });
  try {
    assert.equal(heard.started, undefined);
    h.bus.publish('appServer/ready', {});
    assert.deepEqual([heard.started, heard.ups], [true, undefined], 'the first ready starts the areas');
    h.bus.publish('appServer/ready', {});
    assert.equal(heard.ups, 1, 'a later ready is serverUp');
    await source.start();
    assert.equal(heard.ups, 1, 'start() does not start them twice');
  } finally { await source.dispose(); graph.close(); await h.close(); }
});
