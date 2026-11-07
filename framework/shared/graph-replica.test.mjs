// The page's graph replica (framework/shared/graph-replica.mjs) against a fake `subscribe` and a manual clock: the replica sees only
// the messages of contracts/graph.d.ts ViewMessage, so the Host side is not needed here (graph-renderer.test.mjs wires the real one).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createReplica } from './graph-replica.mjs';

const P = 'codex';
const ref = (id, type = 'CodexThread') => ({ type, provider: P, id });
const snap = (id, title = 'T', over = {}) => ({ ref: ref(id), liveness: 'live', version: 1, time: 1, state: { title }, links: {}, caps: null, summary: { title }, ...over });
const goneSnap = (id) => ({ ref: ref(id), liveness: 'gone', gone: true });
const snapshot = (seq, ...items) => ({ type: 'snapshot', seq, items });
const delta = (seq, kind, id, title) => ({ type: 'delta', seq, event: { seq, kind, ref: ref(id), ...(kind === 'removed' ? {} : { instance: snap(id, title) }) } });
const CONCEPTS = { CodexThread: 'Thread', TestAgentThread: 'Thread', Thread: 'Thread' };
const conceptOf = (typeId) => CONCEPTS[typeId];

/** A fake `subscribe` that records every view the replica opens, and a clock the test advances by hand. */
function rig(opts = {}) {
  const subs = [];
  const timers = new Set();
  let now = 0;
  const errors = [];
  const replica = createReplica({
    conceptOf,
    onError: (e) => errors.push(e),
    subscribe: (query, onMessage) => {
      if (opts.subscribe) return opts.subscribe(query, onMessage);
      const sub = { query, send: onMessage, disposed: false };
      subs.push(sub);
      return { dispose() { sub.disposed = true; } };
    },
    schedule: (fn, ms) => { const t = { fn, at: now + ms }; timers.add(t); return () => timers.delete(t); },
    ...(opts.replica ?? {}),
  });
  return {
    replica, subs, errors,
    live: () => subs.filter((s) => !s.disposed),
    timers: () => timers.size,
    tick(ms) { now += ms; for (const t of [...timers].filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) { timers.delete(t); t.fn(); } },
  };
}
/** Observe a ref and feed its view a snapshot. */
function follow(r, id, ...items) {
  const d = r.replica.observe(ref(id));
  const sub = r.subs.at(-1);
  sub.send(snapshot(10, ...items));
  return { d, sub };
}

test('observe opens one core view per instance; a snapshot fills get(), synchronously, under the instance\'s concept', () => {
  const r = rig();
  assert.equal(r.replica.get(ref('t1')), undefined, 'not known yet');
  const d = r.replica.observe(ref('t1'));
  assert.deepEqual(r.subs.map((s) => s.query), [{ ref: ref('t1'), depth: 'core' }], 'core by default');
  assert.equal(r.replica.get(ref('t1')), undefined, 'a view that has not answered holds nothing');
  const s1 = snap('t1', 'One');
  r.subs[0].send(snapshot(10, s1));
  assert.equal(r.replica.get(ref('t1')), s1, 'the very object the view delivered (a stable reference for useSyncExternalStore)');
  assert.equal(r.replica.get({ type: 'Thread', provider: P, id: 't1' }), s1, 'the same instance by any subtype of its concept');
  assert.equal(r.replica.get({ type: 'TestAgentThread', provider: P, id: 't1' }), s1);
  assert.equal(r.replica.get({ type: 'CodexThread', provider: 'other', id: 't1' }), undefined, 'the provider is part of the identity');
  assert.equal(r.replica.get({ type: 'CodexThread', provider: P, id: 't2' }), undefined);
  assert.equal(r.replica.get(null), undefined);
  assert.equal(r.replica.get({ type: 'CodexThread' }), undefined);
  d.dispose();
});

test('a type conceptOf does not know is its own concept (as in the graph\'s store); the view\'s query keeps the ref it was asked with', () => {
  const r = rig();
  r.replica.observe(ref('n1', 'Note'));
  r.subs[0].send(snapshot(1, { ...snap('n1'), ref: ref('n1', 'Note') }));
  assert.equal(r.replica.get(ref('n1', 'Note')).state.title, 'T');
  assert.equal(r.replica.get(ref('n1', 'Other')), undefined);
  assert.deepEqual(r.subs[0].query.ref, ref('n1', 'Note'));
});

test('observe: depth is core or full; each depth is its own view; bad refs and depths are refused', () => {
  const r = rig();
  r.replica.observe(ref('t1'));
  r.replica.observe(ref('t1'), { depth: 'full' });
  r.replica.observe(ref('t1'), { depth: 'core' });
  assert.deepEqual(r.subs.map((s) => s.query.depth), ['core', 'full'], 'core twice is one view');
  assert.throws(() => r.replica.observe(ref('t1'), { depth: 'deep' }), TypeError);
  assert.throws(() => r.replica.observe({ id: 'x' }), TypeError);
  assert.throws(() => r.replica.observe(null), TypeError);
  assert.throws(() => r.replica.watch({ id: 'x' }, () => {}), TypeError);
  assert.throws(() => r.replica.watch(ref('t1'), null), TypeError);
  assert.throws(() => createReplica({}), TypeError);
});

test('deltas: added and changed put the event\'s instance and tell the watchers; the same ref gets one entry; a repeat is ignored', () => {
  const r = rig();
  const { sub } = follow(r, 't1');                     // the view knows no such instance yet: an empty snapshot
  assert.equal(r.replica.get(ref('t1')), undefined);
  const seen = [];
  const w = r.replica.watch(ref('t1'), (v) => seen.push(v?.state.title));
  sub.send(delta(11, 'added', 't1', 'One'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'One');
  sub.send(delta(12, 'changed', 't1', 'Two'));
  sub.send(delta(12, 'changed', 't1', 'Repeated'));    // the same sequence number again
  sub.send(delta(11, 'changed', 't1', 'Late'));        // an older one
  sub.send({ type: 'complete', seq: 13, complete: true });
  sub.send({ type: 'delta', seq: 14, event: { seq: 14, kind: 'completeness', concept: 'Thread', complete: true } });
  assert.equal(r.replica.get(ref('t1')).state.title, 'Two');
  assert.deepEqual(seen, ['One', 'Two']);
  w.dispose();
  sub.send(delta(15, 'changed', 't1', 'Three'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Three');
  assert.deepEqual(seen, ['One', 'Two'], 'a disposed watcher hears nothing more');
  w.dispose();                                         // idempotent
});

test('a delta older than the snapshot it follows is not applied (the snapshot already has it)', () => {
  const r = rig();
  const { sub } = follow(r, 't1', snap('t1', 'Fresh'));   // snapshot at seq 10
  sub.send(delta(9, 'changed', 't1', 'Older'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Fresh');
  sub.send(delta(11, 'changed', 't1', 'Newer'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Newer');
});

test('removed: the instance becomes a gone marker, watchers are told, and a later added brings it back', () => {
  const r = rig();
  const { sub } = follow(r, 't1', snap('t1', 'One'));
  const seen = [];
  r.replica.watch(ref('t1'), (v) => seen.push(v === undefined ? 'unknown' : v.gone ? 'gone' : v.state.title));
  sub.send(delta(11, 'removed', 't1'));
  const g = r.replica.get(ref('t1'));
  assert.deepEqual([g.liveness, g.gone, g.ref], ['gone', true, ref('t1')]);
  sub.send(delta(12, 'added', 't1', 'Back'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Back');
  assert.deepEqual(seen, ['gone', 'Back']);
  // a snapshot that says the instance is gone (the graph remembers recently removed ones)
  sub.send(snapshot(20, goneSnap('t1')));
  assert.equal(r.replica.get(ref('t1')).gone, true);
  // gone markers are held like instances: they leave with the view
  r.replica.close();
  assert.equal(r.replica.get(ref('t1')), undefined);
});

test('a view of an instance the graph does not have: its snapshot is empty, and the instance arrives with an added delta', () => {
  const r = rig();
  const { sub } = follow(r, 'new');
  assert.equal(r.replica.get(ref('new')), undefined);
  assert.deepEqual(r.replica.stats(), { views: 1, instances: 0, watchers: 0 });
  sub.send(delta(11, 'added', 'new', 'Arrived'));
  assert.equal(r.replica.get(ref('new')).state.title, 'Arrived');
});

test('stale: the view ignores deltas until its next snapshot, which resynchronises it (changed values, and what it no longer holds)', () => {
  const r = rig();
  const { sub } = follow(r, 't1', snap('t1', 'Before'));
  const seen = [];
  r.replica.watch(ref('t1'), (v) => seen.push(v === undefined ? 'unknown' : v.state.title));
  sub.send({ type: 'stale', seq: 20 });
  sub.send(delta(21, 'changed', 't1', 'During'));      // not applicable: the view lost deltas, and this is not what it needs
  assert.equal(r.replica.get(ref('t1')).state.title, 'Before', 'the last known value stays readable while it waits');
  sub.send(snapshot(22, snap('t1', 'After')));
  assert.equal(r.replica.get(ref('t1')).state.title, 'After');
  sub.send(delta(23, 'changed', 't1', 'Live again'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Live again', 'deltas apply again, in sequence, after the snapshot');
  assert.deepEqual(seen, ['After', 'Live again']);
  // the new snapshot is authoritative: an instance it no longer holds is released
  sub.send({ type: 'stale', seq: 30 });
  sub.send(snapshot(31));
  assert.equal(r.replica.get(ref('t1')), undefined);
  assert.deepEqual(seen.at(-1), 'unknown');
  assert.equal(r.replica.stats().views, 1, 'the view itself carries on');
});

test('refcount: observers share one subscription; the last dispose starts a linger, not an unsubscribe; dispose is idempotent', () => {
  const r = rig();
  const a = r.replica.observe(ref('t1'));
  const b = r.replica.observe({ type: 'TestAgentThread', provider: P, id: 't1' });   // another subtype of the same concept: the same view
  assert.equal(r.subs.length, 1);
  r.subs[0].send(snapshot(10, snap('t1', 'One')));
  a.dispose(); a.dispose();                                                         // the second dispose must not count again
  assert.equal(r.live().length, 1);
  assert.equal(r.timers(), 0, 'still observed: no linger');
  assert.equal(r.replica.get(ref('t1')).state.title, 'One');
  b.dispose();
  assert.equal(r.live().length, 1, 'lingering');
  assert.equal(r.timers(), 1);
  assert.equal(r.replica.get(ref('t1')).state.title, 'One', 'readable while it lingers');
});

test('linger: a re-observe inside it reuses the view with no new subscription; after it the view is unsubscribed and what it held is dropped', () => {
  const r = rig({ replica: { lingerMs: 2000 } });
  const dropped = [];
  const first = r.replica.observe(ref('t1'));
  r.subs[0].send(snapshot(10, snap('t1', 'One')));
  r.replica.watch(ref('t1'), (v) => { if (v === undefined) dropped.push('dropped'); });
  first.dispose();
  r.tick(1500);
  assert.equal(r.live().length, 1);
  const second = r.replica.observe(ref('t1'));                    // within the linger: the unmount/mount of a re-rendering list
  assert.equal(r.subs.length, 1, 'no second subscription');
  assert.equal(r.timers(), 0, 'the linger was cancelled');
  r.tick(5000);
  assert.equal(r.live().length, 1, 'observed again: it stays');
  assert.equal(r.replica.get(ref('t1')).state.title, 'One', 'and the value never went away');
  second.dispose();
  r.tick(1999);
  assert.equal(r.live().length, 1, 'not yet');
  r.tick(1);
  assert.equal(r.live().length, 0, 'the linger ran out: unsubscribed');
  assert.equal(r.subs[0].disposed, true);
  assert.equal(r.replica.get(ref('t1')), undefined, 'what only it held is dropped');
  assert.deepEqual(dropped, ['dropped'], 'and its watchers are told');
  assert.deepEqual(r.replica.stats(), { views: 0, instances: 0, watchers: 1 });
  r.replica.observe(ref('t1'));                                   // a fresh view after the old one is gone
  assert.equal(r.subs.length, 2);
  assert.equal(r.replica.get(ref('t1')), undefined, 'and it starts empty');
});

test('linger: 0 unsubscribes at once; a message that arrives from a view already shut is ignored', () => {
  const r = rig({ replica: { lingerMs: 0 } });
  const d = r.replica.observe(ref('t1'));
  r.subs[0].send(snapshot(10, snap('t1')));
  d.dispose();
  assert.equal(r.subs[0].disposed, true);
  assert.equal(r.timers(), 0);
  r.subs[0].send(snapshot(11, snap('t1', 'Late')));
  r.subs[0].send(delta(12, 'changed', 't1', 'Late'));
  assert.equal(r.replica.get(ref('t1')), undefined);
});

test('an instance stays while any view holds it: a core and a full view of one ref, and a ref seen by two views', () => {
  const r = rig();
  const core = r.replica.observe(ref('t1'));
  const full = r.replica.observe(ref('t1'), { depth: 'full' });
  assert.equal(r.subs.length, 2);
  const [vCore, vFull] = r.subs;
  vCore.send(snapshot(10, snap('t1', 'Core')));
  vFull.send(snapshot(11, snap('t1', 'Full')));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Full', 'the latest message wins');
  vCore.send(delta(12, 'changed', 't1', 'Core 2'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Core 2');
  full.dispose();
  r.tick(2000);
  assert.equal(vFull.disposed, true);
  assert.equal(r.replica.get(ref('t1')).state.title, 'Core 2', 'the core view still holds it');
  core.dispose();
  r.tick(2000);
  assert.equal(r.replica.get(ref('t1')), undefined);
});

test('watchers: per ref, in order, isolated from each other\'s faults; watch before the data arrives', () => {
  const r = rig();
  const a = [], b = [];
  r.replica.watch(ref('t1'), () => { throw new Error('boom'); });
  r.replica.watch(ref('t1'), (v) => a.push(v.state.title));
  r.replica.watch({ type: 'TestAgentThread', provider: P, id: 't1' }, (v) => b.push(v.state.title));   // same instance by concept
  r.replica.watch(ref('t2'), () => assert.fail('another ref'));
  r.replica.observe(ref('t1'));
  r.subs[0].send(snapshot(10, snap('t1', 'One')));
  r.subs[0].send(delta(11, 'changed', 't1', 'Two'));
  assert.deepEqual([a, b], [['One', 'Two'], ['One', 'Two']]);
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].message, 'boom');
});

test('a subscribe that throws is reported and leaves nothing behind; the next observe tries again', () => {
  let fail = true;
  const live = [];
  const r = rig({ subscribe: (query, onMessage) => {
    if (fail) throw new Error('no channel');
    live.push({ query, onMessage }); return { dispose() {} };
  } });
  const d = r.replica.observe(ref('t1'));
  assert.equal(r.errors[0].message, 'no channel');
  assert.equal(r.replica.stats().views, 0);
  d.dispose();                                                    // harmless
  fail = false;
  r.replica.observe(ref('t1'));
  assert.equal(live.length, 1);
  live[0].onMessage(snapshot(1, snap('t1', 'Fine')));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Fine');
});

test('a view that answers while subscribe is still running (a synchronous transport) is handled', () => {
  const r = rig({ subscribe: (query, onMessage) => { onMessage(snapshot(5, snap('t1', 'Sync'))); return { dispose() {} }; } });
  r.replica.observe(ref('t1'));
  assert.equal(r.replica.get(ref('t1')).state.title, 'Sync');
});

test('close: every view is unsubscribed at once, the replica forgets, its watchers are told, and later observes do nothing', () => {
  const r = rig();
  r.replica.observe(ref('t1')); r.replica.observe(ref('t2'));
  r.subs[0].send(snapshot(10, snap('t1'))); r.subs[1].send(snapshot(10, snap('t2')));
  const lingering = r.replica.observe(ref('t3'));
  lingering.dispose();
  const told = [];
  r.replica.watch(ref('t1'), (v) => told.push(v));
  r.replica.close();
  assert.deepEqual(r.subs.map((s) => s.disposed), [true, true, true]);
  assert.deepEqual(told, [undefined]);
  assert.equal(r.replica.get(ref('t2')), undefined);
  assert.equal(r.timers(), 0, 'the linger timer was cancelled');
  const after = r.replica.observe(ref('t4'));
  assert.equal(r.subs.length, 3, 'no new subscription');
  after.dispose();
  r.replica.close();
});

test('graph-replica uses no Node API: it runs in a bare vm context with ECMAScript built-ins only', async () => {
  const src = await readFile(new URL('./graph-replica.mjs', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\bimport\b/.test(code) && !/\bnode:/.test(code), 'no imports');
  const hit = /\b(process|Buffer|require|setImmediate|queueMicrotask|console|__dirname|global)\b/.exec(code);
  assert.equal(hit, null, `Node global referenced: ${hit?.[0]}`);
  const sandbox = vm.createContext({});
  const createRep = vm.runInContext(`${src.replace(/^export function/m, 'function')}\ncreateReplica;`, sandbox);
  const sent = [];
  const rep = createRep({ subscribe: (q, onMessage) => { sent.push({ q, onMessage }); return { dispose() {} }; }, schedule: () => () => {} });
  rep.observe({ type: 'T', provider: 'p', id: '1' });
  sent[0].onMessage({ type: 'snapshot', seq: 1, items: [{ ref: { type: 'T', provider: 'p', id: '1' }, state: { a: 1 } }] });
  assert.equal(rep.get({ type: 'T', provider: 'p', id: '1' }).state.a, 1);
  // the default timer is the page's: globalThis.setTimeout, which a bare context lacks, only matters when no schedule is injected and a linger runs
  const bare = createRep({ subscribe: () => ({ dispose() {} }) });
  assert.equal(typeof bare.observe, 'function');
});

test('settled: a view that has answered tells "the graph has none" from "not yet"; a watcher hears an empty first answer', () => {
  const r = rig();
  const heard = [];
  r.replica.watch(ref('t9'), (v) => heard.push(v));
  assert.equal(r.replica.settled(ref('t9')), false, 'no view');
  r.replica.observe(ref('t9'));
  assert.equal(r.replica.settled(ref('t9')), false, 'asked, not answered');
  r.subs.at(-1).send(snapshot(10));
  assert.deepEqual([r.replica.settled(ref('t9')), r.replica.get(ref('t9')), heard], [true, undefined, [undefined]], 'answered with none: settled, and heard');
  const { sub } = follow(r, 't8', snap('t8', 'Eight'));
  assert.equal(r.replica.settled(ref('t8')), true);
  sub.send(snapshot(11, snap('t8', 'Eight again')));
  assert.equal(r.replica.settled(ref('t8')), true);
});
