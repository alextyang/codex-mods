// Notification reports and operations through the source, graph, real mux and fake app-server. No notification protocol methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as notifications from '../areas/notifications.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' };
const payload = (id, fields = {}) => ({ id, kind: 'turn-complete', title: 'Finished', body: 'Done', conversationId: null, requestId: null, at: 1700000000000, ...fields });

async function setup() {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-notifications-'));
  const asked = [], ops = [], events = [], answers = new Map();
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals: { ask: async (q) => { asked.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let mainOps;
  mainOps = createMainOps({ log: quiet, send: (m) => {
    assert.equal(m.area, 'notifications');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        const answer = answers.get(m.op);
        const result = typeof answer === 'function' ? await answer(m.args) : answer;
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...(result ?? { ok: true, result: {} }) });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, error: e.message }); }
    });
  } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, mainOps, areas: { notifications } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Notification') events.push([e.ref.id, e.name, graph.resolve(e.ref).state.read]); });
  await source.start();
  let seq = 0;
  return {
    graph, source, mainOps, ops, events, asked, answers,
    ask: (method, params) => h.app.request(++seq, method, params),
    report: (event, notification) => mainOps.report({ type: 'area-report', area: 'notifications', report: { event, notification } }),
    invoke: (ref, operation) => graph.invoke({ ref, operation, args: [], caller: mod }),
    state: (id) => graph.resolve(refs.notification(id))?.state,
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('reports map every native kind, fall back to other and empty text, and carry the thread source and observation time', async () => {
  const s = await setup();
  try {
    for (const [kind, expected] of [['turn-complete', 'finished'], ['permission', 'approval'], ['question', 'question'], ['agent-message', 'other'], ['limit', 'other'], ['__proto__', 'other']]) {
      s.report('shown', payload(kind, { kind, conversationId: 't', at: 1234 }));
      assert.deepEqual(s.state(kind), { title: 'Finished', body: 'Done', kind: expected, createdAt: 1234, read: false, source: refs.thread('t') });
      assert.deepEqual(s.graph.resolve(refs.notification(kind)).links, {});
    }
    s.report('shown', { id: 'empty', kind: null, title: null, body: null, conversationId: '', at: 0 });
    assert.deepEqual(s.state('empty'), { title: '', body: '', kind: 'other', createdAt: 0, read: false });
    assert.deepEqual(s.events.map(([, event, read]) => [event, read]), Array.from({ length: 7 }, () => ['shown', false]), 'the first report is an event, never a sync');
    assert.deepEqual(s.ops, []);
  } finally { await s.close(); }
});

test('turn-complete is failed only when the source thread\'s latest resident Turn by startedAt failed', async () => {
  const s = await setup();
  try {
    const failed = (await s.ask('thread/start', { cwd: '/repo' })).result.thread.id;
    const completed = (await s.ask('thread/start', { cwd: '/repo' })).result.thread.id;
    for (const [threadId, id, status, startedAt] of [[failed, 'latest-failed', 'failed', 30], [failed, 'older-completed', 'completed', 10], [completed, 'latest-completed', 'completed', 40], [completed, 'older-failed', 'failed', 20]]) {
      await s.ask('fake/notify', { method: 'turn/completed', params: { threadId, turn: { id, status, startedAt, completedAt: startedAt + 1, error: null, items: [] } } });
      await until(() => s.graph.resolve(refs.turn(id)), 3000, 'the resident turn');
    }
    s.report('shown', payload('failed', { conversationId: failed }));
    s.report('shown', payload('finished', { conversationId: completed }));
    s.report('shown', payload('missing-thread', { conversationId: 'not-resident' }));
    s.report('shown', payload('approval', { kind: 'permission', conversationId: failed }));
    assert.equal(s.state('failed').kind, 'failed');
    assert.equal(s.state('finished').kind, 'finished');
    assert.equal(s.state('missing-thread').kind, 'finished');
    assert.equal(s.state('approval').kind, 'approval');
    s.source.provider.remove(refs.turn('latest-failed'));
    s.report('shown', payload('after-removal', { conversationId: failed }));
    assert.equal(s.state('after-removal').kind, 'finished', 'a removed turn is not resident');
    assert.equal(s.state('failed').kind, 'failed', 'the original notification keeps its observed kind');
  } finally { await s.close(); }
});

test('shown, opened and dismissed report their event with read set before delivery and preserve the first payload', async () => {
  const s = await setup();
  try {
    const n = payload('one', { at: 100 });
    s.report('shown', n);
    assert.equal(s.state('one').read, false);
    s.report('opened', { ...n, at: 200, title: 'Changed' });
    assert.equal(s.state('one').read, true);
    s.report('shown', n);
    assert.equal(s.state('one').read, true, 'a later shown cannot mark it unread');
    s.report('dismissed', n);
    assert.equal(s.state('one').createdAt, 100);
    assert.equal(s.state('one').title, 'Finished');
    s.report('opened', payload('opened-first'));
    s.report('dismissed', payload('dismissed-first'));
    assert.deepEqual(s.events, [['one', 'shown', false], ['one', 'opened', true], ['one', 'shown', true], ['one', 'dismissed', true], ['opened-first', 'opened', true], ['dismissed-first', 'dismissed', true]]);
    for (const report of [null, {}, { event: 'changed', notification: n }, { event: 'shown', notification: {} }, { event: 'shown', notification: { id: '' } }]) {
      s.mainOps.report({ area: 'notifications', report });
    }
    assert.equal(s.graph.list('Notification').length, 3);
    assert.equal(s.events.length, 6);
  } finally { await s.close(); }
});

test('only the newest 100 notifications stay resident; read events do not refresh their creation order', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 100; i++) s.report('shown', payload(String(i), { at: i }));
    s.report('opened', payload('0', { at: 9999 }));
    for (let i = 100; i < 105; i++) s.report('shown', payload(String(i), { at: i }));
    assert.deepEqual(s.graph.list('Notification').map((n) => Number(n.ref.id)).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 5));
    for (let i = 0; i < 5; i++) assert.equal(s.graph.resolve(refs.notification(String(i))).gone, true);
    s.report('shown', payload('late-old', { at: -1 }));
    assert.equal(s.graph.resolve(refs.notification('late-old')).gone, true);
    assert.equal(s.graph.list('Notification').length, 100);
  } finally { await s.close(); }
});

test('open and dismiss dispatch their exact main operations, mark read, and dismiss emits even without a close report; no R17', async () => {
  const s = await setup();
  try {
    s.report('shown', payload('open', { conversationId: 'thread', requestId: 'request' }));
    s.report('shown', payload('dismiss'));
    s.report('shown', payload('no-source'));
    for (const [id, operation] of [['open', 'open'], ['dismiss', 'dismiss'], ['no-source', 'open']]) {
      const out = await s.invoke(refs.notification(id), operation);
      assert.equal(out.status, 'done', JSON.stringify(out));
      assert.equal(out.value, null);
      assert.equal(out.intent, undefined, 'the operation has a local effect');
      assert.equal(s.state(id).read, true);
    }
    assert.deepEqual(s.ops, [['open', { id: 'open', conversationId: 'thread' }], ['dismiss', { id: 'dismiss' }], ['open', { id: 'no-source', conversationId: null }]]);
    assert.deepEqual(s.events, [['open', 'shown', false], ['dismiss', 'shown', false], ['no-source', 'shown', false], ['dismiss', 'dismissed', true]]);
    assert.deepEqual(s.asked, []);
  } finally { await s.close(); }
});

test('main refusals stay unavailable, attempted failures fail, and an unknown notification is refused without dispatch', async () => {
  const s = await setup();
  try {
    s.report('shown', payload('one'));
    for (const op of ['open', 'dismiss']) {
      s.answers.set(op, { ok: false, refused: true, error: 'the app has no notification service' });
      const refused = await s.invoke(refs.notification('one'), op);
      assert.deepEqual([refused.status, refused.reason, refused.message], ['refused', 'unavailable', 'the app has no notification service']);
      s.answers.set(op, () => { throw new Error('hide failed'); });
      const failed = await s.invoke(refs.notification('one'), op);
      assert.equal(failed.status, 'failed', JSON.stringify(failed));
      assert.equal(failed.error.message, 'hide failed');
      assert.equal(s.state('one').read, false);
    }
    const ref = refs.notification('unreported');
    const d = notifications.notificationData(payload(ref.id), { read: false, createdAt: 1, failed: false });
    s.source.provider.put(ref, { state: d.state, links: d.links });
    for (const op of ['open', 'dismiss']) {
      const out = await s.invoke(ref, op);
      assert.deepEqual([out.status, out.reason, out.message], ['refused', 'unavailable', 'the notification is gone']);
      const absent = await s.invoke(refs.notification('unknown'), op);
      assert.deepEqual([absent.status, absent.reason], ['refused', 'unavailable']);
    }
    assert.equal(s.ops.length, 4);
    assert.deepEqual(s.events, [['one', 'shown', false]]);
  } finally { await s.close(); }
});

test('an operation completing after eviction does not restore the notification', async () => {
  const s = await setup();
  try {
    const pending = Promise.withResolvers();
    s.answers.set('open', () => pending.promise);
    s.report('shown', payload('old', { at: 0 }));
    const opening = s.invoke(refs.notification('old'), 'open');
    await until(() => s.ops.length === 1, 3000, 'open dispatched');
    for (let i = 1; i <= 100; i++) s.report('shown', payload(String(i), { at: i }));
    pending.resolve({ ok: true, result: {} });
    assert.equal((await opening).status, 'done');
    assert.equal(s.graph.resolve(refs.notification('old')).gone, true);
    assert.equal(s.graph.list('Notification').length, 100);
  } finally { await s.close(); }
});
