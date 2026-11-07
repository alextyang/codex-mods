// Thread.unread and Thread.markRead of the native provider (docs/design/presentations.md V12): the app's read state, through the Host's
// read-state store. The real mux with the strict fake app-server, the graph runtime and the codex source; the store's writes
// (`read-state-set`) are captured instead of going to framework-main, and the test plays framework-main's reports (`read-state`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createReadState } from '../../../read-state.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const user = { kind: 'user', id: 'user' };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup({ withStore = true } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-rs-'));
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet });
  graph.registerTypes(NATIVE, 'native');
  await h.up();
  const writes = [];
  const readState = withStore ? createReadState({ send: (m) => writes.push(m), log: quiet }) : undefined;
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, ...(readState ? { readState } : {}) });
  return {
    h, graph, source, readState, writes, dir,
    report: (unread, extra = {}) => readState.apply({ type: 'read-state', available: true, unread, ...extra }),
    async thread() { const id = (await h.app.request(Math.floor(Math.random() * 1e9), 'thread/start', {})).result.thread.id; await until(() => graph.resolve(refs.thread(id)), 5000, 'the thread'); return id; },
    async close() { await source.dispose(); graph.close(); readState?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const unreadOf = (s, id) => s.graph.resolve(refs.thread(id)).state.unread;

test('Thread.unread follows the app\'s read state: when the app marks a thread unread or reads it, and when the thread is read again from Codex', async () => {
  const s = await setup();
  try {
    const t1 = await s.thread(), t2 = await s.thread();
    assert.deepEqual([unreadOf(s, t1), unreadOf(s, t2)], [false, false]);
    s.report([t1], { reset: true });
    assert.deepEqual([unreadOf(s, t1), unreadOf(s, t2)], [true, false]);
    s.report([t1, t2]);
    assert.deepEqual([unreadOf(s, t1), unreadOf(s, t2)], [true, true]);
    // Codex has no word on unread: reading the list again must not reset what the app says.
    await s.source.start();
    assert.deepEqual([unreadOf(s, t1), unreadOf(s, t2)], [true, true], 'put from the list keeps the app\'s state');
    s.report([t2]);                                    // the user opened the first one
    assert.deepEqual([unreadOf(s, t1), unreadOf(s, t2)], [false, true]);
    // A thread that appears after the report takes the store's value when it is put.
    s.readState.apply({ type: 'read-state', available: true, unread: [t2, 'future-thread'] });
    const events = [];
    s.graph.subscribe({ ref: refs.thread(t1) }, (m) => { if (m.type === 'delta') events.push(m.event.fields); });
    s.report([t1, t2]);
    await until(() => events.length, 2000, 'a delta');
    assert.deepEqual(events, [['unread']]);
  } finally { await s.close(); }
});

test('a thread put with the app\'s state already known starts with it', async () => {
  const s = await setup();
  try {
    const t1 = await s.thread();
    s.report([t1], { reset: true });
    // Forget the instance and read it from Codex again: thread/list is what puts it.
    s.source.provider.remove(refs.thread(t1));
    assert.equal(s.graph.resolve(refs.thread(t1)).gone, true);
    await s.source.start();
    assert.equal(unreadOf(s, t1), true);
  } finally { await s.close(); }
});

test('Thread.markRead is a local operation through the store: the app is told, Thread.unread is read at once, nothing is claimed in the journal', async () => {
  const s = await setup();
  try {
    const t = await s.thread();
    s.report([t], { reset: true });
    assert.equal(s.graph.can(refs.thread(t), 'markRead'), true);
    const out = await s.graph.invoke({ ref: refs.thread(t), operation: 'markRead', args: [], caller: user, origin: 'test' });
    assert.equal(out.status, 'done');
    assert.equal(out.intent, undefined, 'a local effect: no intent');
    assert.deepEqual(s.writes.map((w) => [w.type, w.threadId, w.unread]), [['read-state-set', t, false]]);
    assert.equal(unreadOf(s, t), false);
    // framework-main applies it and reports: nothing changes, nothing is sent again.
    s.report([], { ack: s.writes[0].id });
    await sleep(20);
    assert.equal(s.writes.length, 1);
    assert.equal(unreadOf(s, t), false);
    // Reading a thread that is read is done too, and sends nothing.
    assert.equal((await s.graph.invoke({ ref: refs.thread(t), operation: 'markRead', args: [], caller: user })).status, 'done');
    assert.equal(s.writes.length, 1);
    // The app's own mark-read is not held for interceptors (it has already happened).
    assert.equal(s.graph.interceptable(refs.thread(t), 'markRead'), 'graph only');
  } finally { await s.close(); }
});

test('Thread.markUnread is the same write with unread: the app is told, Thread.unread is read at once', async () => {
  const s = await setup();
  try {
    const t = await s.thread();
    s.report([], { reset: true });
    assert.equal(unreadOf(s, t), false);
    assert.equal(s.graph.can(refs.thread(t), 'markUnread'), true);
    const out = await s.graph.invoke({ ref: refs.thread(t), operation: 'markUnread', args: [], caller: user, origin: 'test' });
    assert.deepEqual([out.status, out.intent], ['done', undefined]);
    assert.deepEqual(s.writes.map((w) => [w.type, w.threadId, w.unread]), [['read-state-set', t, true]]);
    assert.equal(unreadOf(s, t), true);
    assert.equal(s.graph.interceptable(refs.thread(t), 'markUnread'), 'graph only');
  } finally { await s.close(); }
});

test('Thread.markRead is refused as unavailable while the app has no read-state session, and sends nothing', async () => {
  const s = await setup();
  try {
    const t = await s.thread();
    assert.equal(s.readState.available, false);
    const out = await s.graph.invoke({ ref: refs.thread(t), operation: 'markRead', args: [], caller: user });
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    assert.deepEqual(s.writes, []);
  } finally { await s.close(); }
});

test('without a store (no graph read state), unread is false and markRead is not available, as before', async () => {
  const s = await setup({ withStore: false });
  try {
    const t = await s.thread();
    assert.equal(unreadOf(s, t), false);
    assert.equal(s.graph.can(refs.thread(t), 'markRead'), false);
    assert.equal(s.graph.can(refs.thread(t), 'markUnread'), false);
    const out = await s.graph.invoke({ ref: refs.thread(t), operation: 'markRead', args: [], caller: user });
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
  } finally { await s.close(); }
});

test('a stale thread is not made live by a change of the app\'s state; it takes the state when it is read again', async () => {
  const s = await setup();
  try {
    const t = await s.thread();
    s.source.provider.markStale();
    assert.equal(s.graph.resolve(refs.thread(t)).liveness, 'stale');
    s.report([t], { reset: true });
    assert.equal(s.graph.resolve(refs.thread(t)).liveness, 'stale');
    assert.equal(unreadOf(s, t), false);
    await s.source.start();
    assert.deepEqual([s.graph.resolve(refs.thread(t)).liveness, unreadOf(s, t)], ['live', true]);
  } finally { await s.close(); }
});

test('ids it has not read in the store create and change nothing; after dispose the source hears nothing', async () => {
  const s = await setup();
  try {
    const t = await s.thread();
    const before = s.graph.list('Thread').length;
    s.report(['unknown-1', 'unknown-thread', t], { reset: true });
    s.readState.set('unknown-1', false);
    assert.equal(s.graph.list('Thread').length, before);
    assert.equal(unreadOf(s, t), true);
    await s.source.dispose();
    assert.doesNotThrow(() => s.report([]));
  } finally { await s.close(); }
});
