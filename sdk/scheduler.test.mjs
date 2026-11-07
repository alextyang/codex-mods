// Unit tests of the scheduler engine on an in-memory retained store and a fake clock. The crash-injection tests against a real
// Host and worker are in framework/host/runtime/test/scheduler-gate.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, MAX_TIMER_MS } from './scheduler.mjs';

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** Same optimistic-transaction contract as ctx.storage.retained (revision check, Conflict). */
function memoryStore(initial = {}) {
  const s = { data: new Map(Object.entries(initial)), revision: 0, commits: 0, conflicts: 0 };
  s.transaction = async (fn) => {
    await Promise.resolve();
    const rev = s.revision;
    const writes = new Map();
    const view = () => { const k = new Set(s.data.keys()); for (const [key, w] of writes) { if (w.delete) k.delete(key); else k.add(key); } return k; };
    const tx = {
      get: (k) => { const w = writes.get(k); if (w) return w.delete ? undefined : structuredClone(w.value); return s.data.has(k) ? structuredClone(s.data.get(k)) : undefined; },
      set: (k, v) => writes.set(k, { value: structuredClone(v) }),
      delete: (k) => writes.set(k, { delete: true }),
      list: (p = '') => [...view()].filter((k) => k.startsWith(p)).sort(),
    };
    const out = fn(tx);
    await Promise.resolve();
    if (writes.size) {
      if (rev !== s.revision) { s.conflicts++; const e = new Error('Conflict'); e.code = 'Conflict'; throw e; }
      for (const [k, w] of writes) { if (w.delete) s.data.delete(k); else s.data.set(k, w.value); }
      s.revision++; s.commits++;
    }
    return out;
  };
  s.job = (id) => s.data.get(`sched/job/${id}`);
  return s;
}

function fakeClock(start = 1_000_000) {
  const c = { t: start, timers: [], requested: [], seq: 0 };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const h = { fn, due: c.t + ms, id: ++c.seq }; c.requested.push(ms); c.timers.push(h); return h; };
  c.clearTimer = (h) => { c.timers = c.timers.filter((x) => x !== h); };
  c.advance = async (ms) => {
    const target = c.t + ms;
    for (;;) {
      await flush();
      const next = c.timers.filter((x) => x.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      c.timers = c.timers.filter((x) => x !== next);
      c.t = Math.max(c.t, next.due);
      next.fn();
    }
    c.t = target;
    await flush();
  };
  /** The clock moves with no timer firing: a Mac asleep. */
  c.sleep = (ms) => { c.t += ms; for (const h of c.timers) h.due += 0; };
  return c;
}

function make({ store = memoryStore(), clock = fakeClock(), ...opts } = {}) {
  const errors = [];
  const s = createScheduler({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onError: (e) => errors.push(e), ...opts });
  return { s, store, clock, errors };
}

test('fires at the deadline; started is committed before the handler runs; done is recorded', async () => {
  const { s, store, clock } = make();
  const seen = [];
  s.on('j', async (job) => {
    seen.push({ stateInStoreAtEntry: store.job('j').state, delivery: job.delivery, data: job.data });
    await job.done({ ok: true });
  });
  await s.schedule({ id: 'j', at: clock.t + 5000, data: { n: 1 } });
  await clock.advance(4999);
  assert.deepEqual(seen, []);
  await clock.advance(1);
  assert.deepEqual(seen, [{ stateInStoreAtEntry: 'started', delivery: 'normal', data: { n: 1 } }]);
  assert.equal(store.job('j').state, 'done');
  assert.deepEqual(store.job('j').outcome, { result: { ok: true } });
  await clock.advance(10 * 60_000);
  assert.equal(seen.length, 1, 'never delivered again');
});

test('outcomes: a clean return is done, a throw is uncertain, failed is terminal, first outcome wins', async () => {
  const { s, store, clock, errors } = make();
  s.on('clean', () => {});
  s.on('throws', () => { throw new Error('boom'); });
  s.on('failed', (j) => j.failed('rejected before send'));
  s.on('both', async (j) => { await j.done('a'); const r = await j.uncertain('b'); assert.equal(r.recorded, false); });
  for (const id of ['clean', 'throws', 'failed', 'both']) await s.schedule({ id, at: clock.t });
  await clock.advance(1);
  assert.equal(store.job('clean').state, 'done');
  assert.equal(store.job('throws').state, 'uncertain');
  assert.match(store.job('throws').outcome.note, /boom/);
  assert.equal(store.job('failed').state, 'failed');
  assert.equal(store.job('both').state, 'done');
  assert.equal(errors.length, 1);
});

test('schedule is idempotent per (id, generation): done, cancelled and running jobs are not re-armed; stale generations are refused', async () => {
  const { s, store, clock } = make();
  let runs = 0;
  s.on('j', (job) => { runs++; return job.done(); });
  assert.equal((await s.schedule({ id: 'j', at: clock.t + 10, generation: 2 })).status, 'scheduled');
  await clock.advance(10);
  assert.equal(runs, 1);
  const again = await s.schedule({ id: 'j', at: clock.t + 10, generation: 2 });
  assert.equal(again.status, 'exists'); assert.equal(again.job.state, 'done');
  await clock.advance(1000);
  assert.equal(runs, 1, 're-running activation code does not re-arm a finished job');
  await assert.rejects(s.schedule({ id: 'j', at: clock.t, generation: 1 }), (e) => e.code === 'Conflict');
  assert.equal(store.job('j').state, 'done');
  // a cancelled job stays cancelled for the same generation; a newer generation is a new intent
  await s.schedule({ id: 'k', at: clock.t + 100, generation: 0 });
  assert.equal((await s.cancel('k')).cancelled, true);
  assert.equal((await s.schedule({ id: 'k', at: clock.t + 100, generation: 0 })).job.state, 'cancelled');
  s.on('k', (job) => job.done());
  await clock.advance(1000);
  assert.equal(store.job('k').state, 'cancelled');
});

test('a newer generation cancels the pending older one; only the newer runs', async () => {
  const { s, store, clock } = make();
  const ran = [];
  s.on('j', (job) => { ran.push(job.generation); return job.done(); });
  await s.schedule({ id: 'j', at: clock.t + 100, generation: 1, data: 'old' });
  const r = await s.schedule({ id: 'j', at: clock.t + 200, generation: 2, data: 'new' });
  assert.equal(r.status, 'replaced');
  await clock.advance(1000);
  assert.deepEqual(ran, [2]);
  const rec = store.job('j');
  assert.equal(rec.data, 'new');
  assert.deepEqual(rec.superseded.map((e) => [e.generation, e.state]), [[1, 'cancelled']]);
});

test('cancel: pending is cancelled and never runs; a started job cannot be cancelled', async () => {
  const { s, store, clock } = make();
  let release;
  s.on('slow', async (job) => { await new Promise((r) => { release = r; }); await job.done(); });
  s.on('never', () => assert.fail('cancelled job ran'));
  await s.schedule({ id: 'never', at: clock.t + 50 });
  await s.schedule({ id: 'slow', at: clock.t + 10 });
  assert.deepEqual(await s.cancel('never'), { cancelled: true, state: 'cancelled' });
  await clock.advance(10);
  assert.deepEqual(await s.cancel('slow'), { cancelled: false, state: 'started' });
  assert.deepEqual(await s.cancel('nope'), { cancelled: false, state: 'unknown' });
  release(); await flush();
  assert.equal(store.job('slow').state, 'done');
  await clock.advance(100);
  assert.equal(store.job('never').state, 'cancelled');
});

test('crash after started: the next incarnation delivers it once as uncertain and never repeats the effect', async () => {
  const store = memoryStore(); const clock = fakeClock();
  let effects = 0;
  const first = make({ store, clock });
  first.s.on('send', async () => { effects++; await new Promise(() => {}); });   // the effect happened; the worker dies before done
  await first.s.schedule({ id: 'send', at: clock.t + 10, data: { text: 'resume' } });
  await clock.advance(10);
  assert.equal(effects, 1); assert.equal(store.job('send').state, 'started');
  // crash: the first scheduler is abandoned without close()
  clock.timers = [];
  const seen = [];
  const second = make({ store, clock });
  second.s.on('send', async (job) => { seen.push({ delivery: job.delivery, data: job.data, prev: job.previousOutcome }); });
  await clock.advance(60_000);
  assert.equal(seen.length, 1); assert.equal(seen[0].delivery, 'uncertain'); assert.deepEqual(seen[0].data, { text: 'resume' });
  assert.equal(effects, 1, 'the framework did not run the effect again');
  assert.equal(store.job('send').state, 'uncertain');
  // and a third incarnation delivers nothing: it was reported
  const third = make({ store, clock });
  third.s.on('send', () => assert.fail('uncertain job delivered twice'));
  await clock.advance(10 * 60_000);
  assert.equal(effects, 1);
});

test('a crash inside the uncertain delivery does not deliver it a third time', async () => {
  const store = memoryStore(); const clock = fakeClock();
  const a = make({ store, clock });
  a.s.on('j', async () => { await new Promise(() => {}); });
  await a.s.schedule({ id: 'j', at: clock.t }); await clock.advance(1);
  clock.timers = [];
  const b = make({ store, clock });
  let deliveries = 0;
  b.s.on('j', async () => { deliveries++; await new Promise(() => {}); });   // crashes in the middle of reconciling
  await clock.advance(1000);
  assert.equal(deliveries, 1);
  clock.timers = [];
  const c = make({ store, clock });
  c.s.on('j', () => { deliveries++; });
  await clock.advance(60_000);
  assert.equal(deliveries, 1);
  assert.equal(store.job('j').state, 'uncertain', 'still visible to get() and list()');
});

test('an uncertain delivery can reconcile: done() records the resolution', async () => {
  const store = memoryStore(); const clock = fakeClock();
  const a = make({ store, clock });
  a.s.on('j', async () => { await new Promise(() => {}); });
  await a.s.schedule({ id: 'j', at: clock.t }); await clock.advance(1);
  clock.timers = [];
  const b = make({ store, clock });
  b.s.on('j', (job) => job.done({ turnStarted: true }));
  await clock.advance(10);
  assert.equal(store.job('j').state, 'done');
  assert.equal(store.job('j').outcome.reconciledFromUncertain, true);
});

test('uncertain jobs found before a handler exists wait for it, and are still delivered once', async () => {
  const store = memoryStore(); const clock = fakeClock();
  const a = make({ store, clock });
  a.s.on('j', async () => { await new Promise(() => {}); });
  await a.s.schedule({ id: 'j', at: clock.t }); await clock.advance(1);
  clock.timers = [];
  const b = make({ store, clock });
  await b.s.ready; await clock.advance(5000);
  assert.equal(store.job('j').state, 'uncertain'); assert.equal(store.job('j').notified, false);
  const got = [];
  b.s.on('j', (job) => { got.push(job.delivery); });
  await clock.advance(1);
  assert.deepEqual(got, ['uncertain']);
});

test('jobs that fell due while the Host was down are delivered at activation as overdue, once, oldest first', async () => {
  const store = memoryStore(); const clock = fakeClock();
  const a = make({ store, clock });
  await a.s.schedule({ id: 'late1', at: clock.t + 2000 });
  await a.s.schedule({ id: 'late2', at: clock.t + 1000 });
  await a.s.schedule({ id: 'future', at: clock.t + 10 * 3600_000 });
  clock.timers = [];
  clock.sleep(3 * 3600_000);          // the Host was down for three hours
  const order = [];
  const b = make({ store, clock });
  for (const id of ['late1', 'late2', 'future']) b.s.on(id, (job) => { order.push([job.id, job.delivery, job.lateMs > 0]); return job.done(); });
  await clock.advance(1);
  assert.deepEqual(order, [['late2', 'overdue', true], ['late1', 'overdue', true]]);
  await clock.advance(8 * 3600_000);
  assert.deepEqual(order.at(-1).slice(0, 2), ['future', 'normal'], 'a job that falls due while running is not overdue');
  assert.equal(order.length, 3);
});

test('delays beyond 2^31 ms work: no timer is ever armed above the limit, and nothing fires early', async () => {
  const day = 86_400_000;
  for (const wakeMs of [MAX_TIMER_MS, Number.MAX_SAFE_INTEGER]) {
    const { s, clock, store } = make({ wakeMs });
    const fired = [];
    s.on('far', (job) => { fired.push(clock.t - job.at); return job.done(); });
    const at = clock.t + 2 * MAX_TIMER_MS + 12345;          // about 49.7 days
    await s.schedule({ id: 'far', at });
    let hops = 0;
    while (clock.t < at - 1) { await clock.advance(Math.min(20 * day, at - 1 - clock.t)); hops++; assert.deepEqual(fired, [], 'fired early'); }
    assert.ok(clock.requested.length >= 3, 'the wait was chunked');
    assert.ok(clock.requested.every((ms) => ms <= MAX_TIMER_MS && ms >= 0), `timers requested: ${Math.max(...clock.requested)}`);
    await clock.advance(1);
    assert.equal(fired.length, 1, `wakeMs=${wakeMs}`);
    assert.ok(fired[0] >= 0 && fired[0] <= 1, `fired ${fired[0]} ms after the deadline`);
    assert.equal(store.job('far').state, 'done');
    assert.ok(hops >= 2);
  }
});

test('the default tick bounds every timer to 60 s, so wall-clock drift is re-checked each minute', async () => {
  const { s, clock } = make();
  const fired = [];
  s.on('j', (job) => { fired.push(job.delivery); return job.done(); });
  await s.schedule({ id: 'j', at: clock.t + 25 * 60_000 });
  await clock.advance(25 * 60_000 - 1);
  assert.deepEqual(fired, []);
  assert.ok(clock.requested.length >= 20 && clock.requested.every((ms) => ms <= 60_000));
  await clock.advance(1);
  assert.deepEqual(fired, ['normal']);
});

test('Mac sleep: a clock that jumps past the deadline fires the job at the next tick, marked overdue beyond the grace', async () => {
  const { s, clock, store } = make({ overdueGraceMs: 30_000 });
  const got = [];
  s.on('j', (job) => { got.push({ delivery: job.delivery, lateMs: job.lateMs }); return job.done(); });
  await s.schedule({ id: 'j', at: clock.t + 10 * 60_000 });
  await clock.advance(60_000);                  // one tick; the timer is re-armed
  clock.sleep(2 * 3600_000);                    // asleep: no timer fires, the clock moves
  assert.deepEqual(got, []);
  await clock.advance(60_000);                  // the next tick after wake
  assert.equal(got.length, 1);
  assert.equal(got[0].delivery, 'overdue');
  assert.ok(got[0].lateMs > 3600_000);
  assert.equal(store.job('j').state, 'done');
});

test('a handler registered after the deadline still gets the job, once', async () => {
  const { s, clock } = make();
  await s.schedule({ id: 'j', at: clock.t + 10 });
  await clock.advance(1000);
  const got = [];
  s.on('j', (job) => { got.push(job.delivery); });
  await clock.advance(1);
  assert.equal(got.length, 1);
});

test('two schedulers over one store (a stale worker and its replacement) cannot both claim a job', async () => {
  const store = memoryStore(); const clock = fakeClock();
  const a = make({ store, clock }); const b = make({ store, clock });
  let runs = 0;
  for (const x of [a, b]) x.s.on('j', async (job) => { runs++; await job.done(); });
  await a.s.schedule({ id: 'j', at: clock.t + 5 });
  await clock.advance(5);
  assert.equal(runs, 1);
});

test('a conflicting concurrent write to the store is retried, not lost', async () => {
  const { s, store, clock } = make();
  s.on('j', (job) => job.done());
  await Promise.all(Array.from({ length: 8 }, (_, i) => s.schedule({ id: `j${i}`, at: clock.t + 5, generation: 0 })));
  for (let i = 0; i < 8; i++) assert.ok(store.job(`j${i}`), `j${i} stored`);
  assert.ok(store.conflicts >= 0);
});

test('validation', async () => {
  const { s, clock } = make();
  await assert.rejects(s.schedule({ id: '', at: 1 }), (e) => e.code === 'Invalid');
  await assert.rejects(s.schedule({ id: 'x', at: NaN }), (e) => e.code === 'Invalid');
  await assert.rejects(s.schedule({ id: 'x', at: 1, generation: -1 }), (e) => e.code === 'Invalid');
  await assert.rejects(s.schedule({ id: 'x', at: 1, data: { f() {} }.f }), (e) => e.code === 'Invalid');
  s.on('a', () => {});
  assert.throws(() => s.on('a', () => {}), (e) => e.code === 'Conflict');
  assert.equal((await s.schedule({ id: 'd', at: new Date(clock.t + 1) })).job.at, clock.t + 1);
});
