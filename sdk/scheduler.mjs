// ctx.scheduler: a durable, wall-clock scheduler with at-most-once delivery per intent (gate G-sched).
//
// NO NODE API HERE. Like framework/shared/realm-client.mjs this runs in the mod's worker thread, so it uses only ECMAScript built-ins plus
// setTimeout/clearTimeout/Date, all injectable. It keeps every record in the mod's *retained* store (`ctx.storage.retained`),
// which a data snapshot restore never touches, so a restored snapshot cannot resurrect a completed job.
//
// One record per job id, key `sched/job/<id>`:
//   { v, id, generation, at, data, state, createdAt, startedAt?, endedAt?, delivery?, lateMs?, outcome?, notified?, superseded? }
//   state: pending → started → done | uncertain | failed;  pending → cancelled;  uncertain → done (reconciliation only)
//
// Delivery protocol (the whole point):
//   1. CLAIM. A retained-store transaction moves pending → started and commits (fsync'd by the Host) BEFORE the handler runs.
//   2. The handler performs its external effect, then records the outcome through its context: done(), uncertain(), failed().
//   3. Whoever finds a record in `started` without a live run (that is only possible after a crash or a hard stop) moves it to
//      `uncertain` and delivers it ONCE, with delivery:'uncertain'. It is never claimed again, so the effect is never repeated
//      by the framework. `notified` is committed before the uncertain delivery, so a crash inside that delivery does not
//      deliver it a second time (the record stays queryable through get()/list()).
//
// Time: deadlines are wall-clock (Date.now()). The engine never arms one long timer. It wakes at most every `wakeMs`
// (default 60 s, hard cap 2^31-1 ms, the setTimeout overflow limit) and compares the deadline to the clock, so delays beyond
// 2^31 ms work and a Mac sleep (during which macOS timers do not advance) delays delivery by at most one tick after wake.
import { CodexModsError } from './errors.mjs';

export const MAX_TIMER_MS = 2 ** 31 - 1;
export const KEY_PREFIX = 'sched/job/';
const MAX_ID = 200;
const MAX_DATA_BYTES = 64 * 1024;
const HISTORY = 3;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (id) => `${KEY_PREFIX}${id}`;

/** All entries of a record that may carry an outcome: the current one and the superseded generations. */
const entries = (rec) => [rec, ...(rec.superseded ?? [])];
const locate = (rec, generation) => entries(rec).find((e) => e.generation === generation);

function validateSchedule(spec) {
  if (!isObject(spec)) throw new CodexModsError('Invalid', 'schedule needs { id, at, data?, generation? }');
  const { id, data = null, generation = 0 } = spec;
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID) throw new CodexModsError('Invalid', `job id must be a non-empty string of at most ${MAX_ID} characters`);
  const at = spec.at instanceof Date ? spec.at.getTime() : spec.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new CodexModsError('Invalid', 'at must be a finite wall-clock time in ms since the epoch (or a Date)');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new CodexModsError('Invalid', 'generation must be a non-negative integer');
  let json;
  try { json = JSON.stringify(data); } catch { json = undefined; }
  if (json === undefined) throw new CodexModsError('Invalid', 'data must be JSON');
  if (json.length > MAX_DATA_BYTES) throw new CodexModsError('Invalid', `data is larger than ${MAX_DATA_BYTES} bytes`);
  return { id, at, data: JSON.parse(json), generation };
}

/**
 * @param {object} o
 * @param {{transaction<R>(fn: (tx: any) => R): Promise<R>}} o.store  the mod's retained store
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {(h: any) => void} [o.clearTimer]
 * @param {number} [o.wakeMs]          tick period; clamped to [1, 2^31-1]
 * @param {number} [o.overdueGraceMs]  a firing later than this after its deadline is reported overdue (sleep, a stalled worker)
 * @param {(e: unknown) => void} [o.onError]
 */
export function createScheduler({ store, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, wakeMs = 60_000, overdueGraceMs = 30_000, onError = () => {} }) {
  const tick = Math.min(MAX_TIMER_MS, Math.max(1, wakeMs));
  const handlers = new Map();      // job id → handler
  const inflight = new Set();      // promises of running handlers
  let activatedAt = now();
  let timer = null;
  let closed = false;
  let pumping = null;              // the running pump promise
  let again = false;

  // ------------------------------------------------------------------ store access
  /** Run a synchronous read-modify-write on the whole retained store, retrying optimistic Conflicts. */
  async function tx(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await store.transaction(fn); }
      catch (e) { if (e?.code === 'Conflict' && attempt < 25) continue; throw e; }
    }
  }
  const loadAll = () => tx((t) => t.list(KEY_PREFIX).map((k) => t.get(k)).filter(isObject));

  // ------------------------------------------------------------------ recovery (once, at construction)
  // Anything still `started` belongs to a previous incarnation of the worker (this scheduler has not claimed anything yet).
  const ready = tx((t) => {
    const at = now();
    let n = 0;
    for (const k of t.list(KEY_PREFIX)) {
      const rec = t.get(k);
      if (!isObject(rec)) continue;
      let changed = false;
      for (const e of entries(rec)) {
        if (e.state !== 'started') continue;
        e.state = 'uncertain'; e.uncertainAt = at; e.notified = false;
        e.outcome = { note: 'the worker stopped after the job started and before an outcome was recorded; the effect may or may not have happened' };
        changed = true; n++;
      }
      if (changed) t.set(k, rec);
    }
    return n;
  }).then((n) => { activatedAt = now(); return n; });
  ready.catch((e) => onError(e));

  // ------------------------------------------------------------------ outcome recording (used by the handler context)
  async function record(id, generation, to, { result, note, reconcile = false } = {}) {
    return tx((t) => {
      const rec = t.get(keyOf(id));
      if (!isObject(rec)) return { recorded: false, state: 'unknown' };
      const e = locate(rec, generation);
      if (!e) return { recorded: false, state: 'unknown' };
      const from = e.state;
      const legal = from === 'started' || (reconcile && from === 'uncertain' && to === 'done');
      if (!legal) return { recorded: false, state: from };          // first outcome wins
      e.state = to; e.endedAt = now();
      e.outcome = { ...(result === undefined ? {} : { result }), ...(note === undefined ? {} : { note }), ...(reconcile ? { reconciledFromUncertain: true } : {}) };
      t.set(keyOf(id), rec);
      return { recorded: true, state: to };
    });
  }

  function jobContext(e, delivery) {
    const ctx = {
      id: e.id, generation: e.generation, at: e.at, data: structuredClone(e.data),
      delivery,                                   // 'normal' | 'overdue' | 'uncertain'
      overdue: delivery === 'overdue', uncertain: delivery === 'uncertain',
      lateMs: e.lateMs ?? 0, startedAt: e.startedAt, previousOutcome: e.outcome === undefined ? undefined : structuredClone(e.outcome),
    };
    const rec = (to, o) => record(e.id, e.generation, to, { ...o, reconcile: delivery === 'uncertain' });
    ctx.done = (result) => rec('done', { result });
    ctx.uncertain = (note) => rec('uncertain', { note });
    ctx.failed = (note) => rec('failed', { note });
    return Object.freeze(ctx);
  }

  // ------------------------------------------------------------------ delivery
  function track(p) { inflight.add(p); p.finally(() => inflight.delete(p)); return p; }

  async function runClaimed(e, delivery, handler) {
    const ctx = jobContext(e, delivery);
    try {
      await handler(ctx);
      // A clean return without an explicit outcome is the handler asserting success. For an uncertain delivery it asserts nothing.
      if (delivery !== 'uncertain') await record(e.id, e.generation, 'done', { note: 'handler returned without recording an outcome' });
    } catch (err) {
      onError(err);
      if (delivery !== 'uncertain') await record(e.id, e.generation, 'uncertain', { note: `the handler threw: ${String(err?.message ?? err).slice(0, 500)}` }).catch(onError);
    }
  }

  /** CLAIM: commit pending → started, then (and only then) run the handler. */
  async function claim(rec, handler) {
    const t0 = now();
    const claimed = await tx((t) => {
      const cur = t.get(keyOf(rec.id));
      if (!isObject(cur) || cur.generation !== rec.generation || cur.state !== 'pending') return null;
      const late = Math.max(0, t0 - cur.at);
      const delivery = (cur.createdAt < activatedAt && cur.at <= activatedAt) || late > overdueGraceMs ? 'overdue' : 'normal';
      cur.state = 'started'; cur.startedAt = t0; cur.delivery = delivery; cur.lateMs = late;
      t.set(keyOf(rec.id), cur);
      return { entry: structuredClone(cur), delivery };
    });
    if (!claimed) return;
    track(runClaimed(claimed.entry, claimed.delivery, handler));
  }

  /** Deliver an uncertain outcome once: commit notified:true first, then call the handler. */
  async function notifyUncertain(rec, generation, handler) {
    const marked = await tx((t) => {
      const cur = t.get(keyOf(rec.id));
      const e = isObject(cur) ? locate(cur, generation) : undefined;
      if (!e || e.state !== 'uncertain' || e.notified !== false) return null;
      e.notified = true; e.notifiedAt = now();
      t.set(keyOf(rec.id), cur);
      return structuredClone(e);
    });
    if (marked) track(runClaimed(marked, 'uncertain', handler));
  }

  async function pumpOnce() {
    await ready;
    if (closed) return;
    const recs = await loadAll();
    const t = now();
    let nextAt = Infinity;
    const dispatch = [];
    for (const rec of recs) {
      const handler = handlers.get(rec.id);
      for (const e of entries(rec)) {
        if (e.state === 'uncertain' && e.notified === false && handler) dispatch.push({ at: e.uncertainAt ?? 0, run: () => notifyUncertain(rec, e.generation, handler) });
      }
      if (rec.state === 'pending' && handler) {
        if (rec.at <= t) dispatch.push({ at: rec.at, run: () => claim(rec, handler) });
        else nextAt = Math.min(nextAt, rec.at);
      }
    }
    dispatch.sort((a, b) => a.at - b.at);
    for (const d of dispatch) { if (closed) return; try { await d.run(); } catch (e) { onError(e); } }
    if (closed) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (nextAt !== Infinity) timer = setTimer(() => { timer = null; kick(); }, Math.min(tick, Math.max(0, nextAt - now())));
  }

  /** Coalescing single-flight pump: a request during a run schedules exactly one more run. */
  function kick() {
    if (closed) return Promise.resolve();
    if (pumping) { again = true; return pumping; }
    pumping = (async () => {
      try { do { again = false; await pumpOnce(); } while (again && !closed); }
      catch (e) { onError(e); }
      finally { pumping = null; }
    })();
    return pumping;
  }

  // ------------------------------------------------------------------ public API
  const api = {
    /**
     * Idempotent per (id, generation): an existing record of the same generation wins, whatever its state (so re-running
     * activation code never re-arms a job that is done, cancelled or running). A higher generation replaces the old job:
     * a pending one is dropped, a running or uncertain one keeps its outcome in `superseded`. A lower generation is refused.
     */
    async schedule(spec) {
      const s = validateSchedule(spec);
      if (closed) throw new CodexModsError('Disposed', 'the scheduler is closed');
      await ready;
      const result = await tx((t) => {
        const cur = t.get(keyOf(s.id));
        if (isObject(cur)) {
          if (s.generation < cur.generation) throw new CodexModsError('Conflict', `generation ${s.generation} of ${s.id} is older than the current generation ${cur.generation}`);
          if (s.generation === cur.generation) return { status: 'exists', job: cur };
        }
        const next = { v: 1, id: s.id, generation: s.generation, at: s.at, data: s.data, state: 'pending', createdAt: now() };
        let status = 'scheduled';
        if (isObject(cur)) {
          status = 'replaced';
          const old = { ...cur }; delete old.superseded;
          const keep = (cur.superseded ?? []);
          // A pending predecessor never ran: it is cancelled by the newer generation. Others keep their outcome.
          const prior = old.state === 'pending' ? { ...old, state: 'cancelled', endedAt: now(), outcome: { note: `superseded by generation ${s.generation}` } } : old;
          next.superseded = [prior, ...keep].slice(0, HISTORY);
        }
        t.set(keyOf(s.id), next);
        return { status, job: next };
      });
      kick();
      return { status: result.status, job: structuredClone(result.job) };
    },

    /** Cancels a pending job. A job that already started cannot be undone: the answer says so and nothing changes. */
    async cancel(id) {
      if (typeof id !== 'string' || id === '') throw new CodexModsError('Invalid', 'cancel needs a job id');
      await ready;
      const r = await tx((t) => {
        const cur = t.get(keyOf(id));
        if (!isObject(cur)) return { cancelled: false, state: 'unknown' };
        if (cur.state !== 'pending') return { cancelled: false, state: cur.state };
        cur.state = 'cancelled'; cur.endedAt = now(); cur.outcome = { note: 'cancelled' };
        t.set(keyOf(id), cur);
        return { cancelled: true, state: 'cancelled' };
      });
      kick();
      return r;
    },

    /** One handler per job id. Registering triggers delivery of anything already due, or uncertain and not yet reported. */
    on(id, handler) {
      if (typeof id !== 'string' || id === '' || typeof handler !== 'function') throw new CodexModsError('Invalid', 'on needs (id, handler)');
      if (handlers.has(id)) throw new CodexModsError('Conflict', `a handler for ${id} is already registered`);
      handlers.set(id, handler);
      kick();
      return { dispose() { if (handlers.get(id) === handler) handlers.delete(id); } };
    },

    async get(id) { await ready; const r = await tx((t) => t.get(keyOf(id))); return isObject(r) ? structuredClone(r) : undefined; },
    async list(o = {}) {
      await ready;
      const all = await loadAll();
      return all.filter((r) => o.state === undefined || r.state === o.state).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    },

    /** Stop timers; wait for running handlers (the Host bounds the drain). Records stay as they are. */
    async close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      await Promise.allSettled([...inflight]);
    },
  };
  Object.defineProperty(api, 'ready', { value: ready.then(() => undefined) });
  Object.defineProperty(api, 'settled', { value: async () => { await kick(); await Promise.allSettled([...inflight]); await kick(); } });
  return api;
}

export { TERMINAL as TERMINAL_STATES };
