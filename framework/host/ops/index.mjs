// Journaled lifecycle operations (ARCHITECTURE §10–§11). createOperations(...) implements contracts/host.d.ts `Operations`.
//
// Model:
//  - state.json (ProfileState) is the single source of truth, rewritten atomically after each phase that changes it.
//  - Every mutation is an OpRecord in ops/<id>.json. A phase is appended and persisted BEFORE its effects run (`step`).
//  - Each mod has at most one running op (a lock); framework-level ops share the key 'framework'.
//  - `recover()` finishes or undoes unfinished ops from their last journaled phase (see lifecycle.mjs recoverers).
//
// Test hooks (not part of the contract): opts.crashAt(phaseName) is called after a phase is journaled (`<name>`) and after its
// effects (`<name>:done`); if it throws, this instance behaves as a dead process: nothing more is written.
import { readFileSync, readdirSync } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { writeJsonAtomic, now, newId } from '../fsutil.mjs';
import { computeCompatibility, blockedBecause } from './compat.mjs';
import { evaluate, liveOfProbe } from '../features/status.mjs';

/** The feature log shipped with this framework, for operations made without the Host's feature state (tests, tools). */
let shipped;
const shippedLog = () => (shipped !== undefined ? shipped : (shipped = (() => { try { return JSON.parse(readFileSync(new URL('../features/log.json', import.meta.url), 'utf8')); } catch { return null; } })()));
import { createLifecycle } from './lifecycle.mjs';
import { getStoreLock } from './storelock.mjs';
import { createOrphans } from './orphans.mjs';

const FRAMEWORK_TYPES = new Set(['framework-update', 'app-prepare', 'app-switch', 'safe-mode', 'lkg-restore', 'copy-update']);
const FRAMEWORK_LOCK = 'framework';
// Framework ops that rewrite mod state: mutually exclusive with every mod op.
const EXCLUSIVE_TYPES = new Set(['lkg-restore', 'safe-mode']);
// The copy's update (docs/design/systems.md E5) excludes mod ops until its switch; after it, it waits for its verdict holding only the
// framework lock and the mods it changed (which refuse update, rollback and remove until then).
const UPDATE = 'copy-update';
const switched = (op) => op.phases.some((p) => p.name === 'swapping');
const exclusiveNow = (op) => EXCLUSIVE_TYPES.has(op.input.type) || (op.input.type === UPDATE && !switched(op));
const FAULT_WRITE_MS = 2000;
const GUARDED_BY_UPDATE = new Set(['update', 'rollback', 'remove', 'reattach']);
// Phases that only look or stage; completing them applies nothing to mod state.
const NON_EFFECT = new Set(['verify', 'compatibility', 'store', 'approve', 'stage', 'migrate']);   // stage and migrate write only to a staging copy
// Phases that are not atomic: if one throws midway, part of it may have been applied.
const PARTIAL_PHASES = new Set(['delete-data', 'move-data', 'attach', 'finish', 'swap', 'restore-data']);

class CrashSignal extends Error {
  constructor(phase, cause) { super(`simulated crash at ${phase}`); this.phase = phase; this.cause = cause; }
}
const isCrash = (e) => e instanceof CrashSignal;

export function createOperations(opts) {
  const { layout: L, log, packages, runtime, bus, mux, adapter, recovery } = opts;
  const healthWindowMs = opts.healthWindowMs ?? 60_000;
  const migrationTimeoutMs = opts.migrationTimeoutMs ?? 60_000;
  const crashAt = opts.crashAt;
  const exclusiveWaitMs = opts.exclusiveWaitMs ?? 60_000;

  // ------------------------------------------------------------------ state and journal storage
  let state = loadState();
  const ops = new Map();            // opId → OpRecord (live objects)
  const locks = new Map();          // lock key → opId
  const opLock = new Map();         // opId → lock key it holds
  const subscribers = new Set();
  const watchers = new Map();       // modId → health-window watcher
  const pendingQuarantine = new Map();
  const effectsDone = new Map();    // opId → effect phases that completed (this process only)
  const acknowledging = new Map();  // opId → the write of its acknowledgement (E6), shared by concurrent calls
  const inflight = new Map();       // opId → phase whose effects are running
  const idleChecks = new Set();     // callbacks run whenever an op settles
  const storeLock = getStoreLock(L.store, log, { timeoutMs: opts.storeLockTimeoutMs });
  const holds = new Set();          // store-lock holds of this instance (released if the instance 'crashes')
  const executing = new Set();      // ops whose handler is running in this process right now
  let reconcileChain = Promise.resolve();
  let exclusive = null;             // opId of a running exclusive framework op
  const manifestCache = new Map();  // store dir → manifest (store dirs are immutable)
  let dead = false;

  function loadState() {
    let parsed;
    try { parsed = JSON.parse(readFileSync(L.state, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return { schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 };
      throw new CodexModsError('Invalid', `state.json is unreadable: ${e.message}`);
    }
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.mods !== 'object') throw new CodexModsError('Invalid', 'state.json has an unsupported shape');
    parsed.safeMode = Boolean(parsed.safeMode);
    if (!Number.isInteger(parsed.nextInstallSeq)) parsed.nextInstallSeq = 1 + Math.max(0, ...Object.values(parsed.mods).map((m) => m.installSeq ?? 0));
    return parsed;
  }

  function loadOps() {
    let names;
    try { names = readdirSync(L.ops); } catch { return; }
    const loaded = [];
    for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))) {
      try {
        const op = JSON.parse(readFileSync(join(L.ops, name), 'utf8'));
        if (!op?.id || !op.input?.type) throw new Error('not an op record');
        loaded.push(op);
      } catch (e) { log.warn('ignoring unreadable op record', { file: name, error: String(e.message ?? e) }); }
    }
    loaded.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));   // chronological, like a fresh run
    for (const op of loaded) {
      ops.set(op.id, op);
      if (op.outcome === 'running') {
        if (exclusiveNow(op)) exclusive = op.id;
        const key = lockKeyOf(op);
        if (key && !locks.has(key)) { locks.set(key, op.id); opLock.set(op.id, key); }
      }
    }
  }

  const alive = () => { if (dead) throw new CrashSignal('(dead process)'); };

  let stateChain = Promise.resolve();
  function persistState() {
    alive();
    const p = stateChain.then(() => { alive(); return writeJsonAtomic(L.state, state); });
    stateChain = p.catch(() => {});
    return p;
  }

  const opChains = new Map();
  function saveOp(op) {
    alive();
    const prev = opChains.get(op.id) ?? Promise.resolve();
    const p = prev.then(() => { alive(); return writeJsonAtomic(join(L.ops, `${op.id}.json`), op); });
    opChains.set(op.id, p.catch(() => {}));
    return p;
  }

  function notify(op) {
    const snapshot = structuredClone(op);
    for (const fn of [...subscribers]) {
      try { fn(structuredClone(snapshot)); } catch (e) { log.warn('op subscriber threw', { error: String(e?.message ?? e) }); }
    }
    try { bus.publish('framework/op', snapshot); } catch (e) { log.warn('bus publish failed', { error: String(e?.message ?? e) }); }
  }

  // ------------------------------------------------------------------ keys and locks
  const opModId = (op) => op.input.modId ?? op.result?.modId ?? op.result?.plan?.modId;
  function lockKeyOf(op) {
    if (FRAMEWORK_TYPES.has(op.input.type)) return FRAMEWORK_LOCK;
    return opModId(op) ?? null;
  }
  function claim(op, key) {
    const held = opLock.get(op.id);
    if (held === key) return;
    if (exclusive && exclusive !== op.id && key !== FRAMEWORK_LOCK) throw new CodexModsError('Conflict', `a framework operation (${exclusive}) is restoring mod state; try again when it ends`);
    if (locks.has(key)) throw new CodexModsError('Conflict', `${key} already has a running operation (${locks.get(key)})`);
    if (held && locks.get(held) === op.id) locks.delete(held);
    locks.set(key, op.id); opLock.set(op.id, key);
  }
  function release(op) {
    const key = opLock.get(op.id);
    opLock.delete(op.id);
    if (key && locks.get(key) === op.id) { locks.delete(key); waiters.get(key)?.shift()?.wake(); }
    return key;
  }
  // Settings patches wait their turn behind the mod's running operation (docs/design/systems.md E3): in order, a few, not for long.
  const waiters = new Map();   // lock key -> [{wake}]
  const PATCH_WAIT_MS = opts.patchWaitMs ?? 10_000, PATCH_WAITERS = 16;   // patchWaitMs: a test hook
  function waitTurn(key, until) {
    const q = waiters.get(key) ?? [];
    if (q.length >= PATCH_WAITERS) return Promise.reject(new CodexModsError('Conflict', `${key} has too many settings changes waiting; try again`));
    waiters.set(key, q);
    return new Promise((resolve, reject) => {
      const w = { wake: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const i = q.indexOf(w);
        if (i >= 0) q.splice(i, 1);
        reject(new CodexModsError('Conflict', `${key} is busy with another operation; its settings were not changed`));
      }, Math.max(0, until - Date.now()));
      timer.unref?.();
      q.push(w);
    });
  }

  // ------------------------------------------------------------------ crash hook, journal, steps
  async function crash(name) {
    if (!crashAt) return;
    try { await crashAt(name); } catch (e) {
      dead = true;
      for (const h of [...holds]) void h.release();   // a dead process holds nothing
      throw new CrashSignal(name, e);
    }
  }

  /** Appends a phase (merging `patch` into op.result), persists the op, notifies, then hits the crash hook. */
  async function journal(op, name, patch) {
    alive();
    op.phases.push({ name, at: now() });
    if (patch) op.result = { ...(op.result ?? {}), ...patch };
    await saveOp(op);
    notify(op);
    await crash(name);
  }

  /** journal(name) → effects → crash hook `<name>:done`. */
  async function step(op, name, fn, patch) {
    await journal(op, name, patch);
    inflight.set(op.id, name);
    const out = fn ? await fn() : undefined;
    inflight.delete(op.id);
    if (fn && !NON_EFFECT.has(name)) { const l = effectsDone.get(op.id) ?? []; l.push(name); effectsDone.set(op.id, l); }
    await crash(`${name}:done`);
    return out;
  }

  /** Effect phases that completed (or may have partly run) before an error, in order. */
  function partialEffects(op) {
    // Recovery.runOp journals each phase before its effects, so any journaled phase may have partly run.
    if (FRAMEWORK_TYPES.has(op.input.type)) return op.phases.map((p) => `${p.name} (started)`);
    const list = [...(effectsDone.get(op.id) ?? [])];
    const running = inflight.get(op.id);
    if (running && PARTIAL_PHASES.has(running)) list.push(`${running} (interrupted)`);
    return list;
  }

  const errInfo = (e) => (e instanceof CodexModsError ? { code: e.code, message: e.message } : { code: 'Unavailable', message: String(e?.message ?? e) });

  /** Sets the final outcome, persists, releases the lock, then applies any quarantine that arrived meanwhile. */
  async function finish(op, d) {
    alive();
    op.outcome = d.outcome;
    if (d.error) op.error = d.error;
    if (d.note !== undefined) op.note = d.note;
    if (d.awaiting) op.awaiting = d.awaiting; else delete op.awaiting;
    if (d.result !== undefined) op.result = d.result;
    if (d.outcome !== 'running') op.endedAt = now();
    await saveOp(op);
    notify(op);
    if (d.outcome === 'running') return;
    effectsDone.delete(op.id); inflight.delete(op.id);
    if (FRAMEWORK_TYPES.has(op.input.type)) { try { opts.afterFrameworkOp?.(op); } catch { /* the listener's own */ } }
    const key = release(op);
    const wasExclusive = exclusive === op.id;
    if (wasExclusive) exclusive = null;
    for (const check of [...idleChecks]) check();
    const flush = async (modId) => {
      const reason = pendingQuarantine.get(modId);
      pendingQuarantine.delete(modId);
      await applyQuarantine(modId, reason).catch((e) => { if (!isCrash(e)) log.error('deferred quarantine failed', { modId, error: String(e?.message ?? e) }); });
    };
    if (key && pendingQuarantine.has(key) && !exclusive) await flush(key);
    if (wasExclusive) for (const modId of [...pendingQuarantine.keys()]) if (!locks.has(modId)) await flush(modId);
  }

  // ------------------------------------------------------------------ installed view, manifests
  const dataDirOf = (id) => join(L.data, id);
  const packageDirOf = (record) => (record.dev ? record.dev.sourceDir : join(L.store, record.id, record.version));

  function readManifestSync(dir, cache) {
    if (cache && manifestCache.has(dir)) return manifestCache.get(dir);
    try {
      const manifest = packages.validateManifest(JSON.parse(readFileSync(join(dir, 'mod.json'), 'utf8')));
      if (cache) manifestCache.set(dir, manifest);
      return manifest;
    } catch (e) {
      log.warn('cannot read manifest', { dir, error: String(e?.message ?? e) });
      return undefined;
    }
  }

  function viewOf(record, manifest, packageDir) {
    return {
      record: structuredClone(record), manifest, packageDir, dataDir: dataDirOf(record.id),
      retainedDir: join(L.retained, record.id), backendsDir: join(L.backends, record.id),
    };
  }

  function installed(modId) {
    const record = state.mods[modId];
    if (!record) return undefined;
    const packageDir = packageDirOf(record);
    const manifest = readManifestSync(packageDir, !record.dev);
    return manifest ? viewOf(record, manifest, packageDir) : undefined;
  }

  const probe = () => bus.state('framework/probe');
  // The build's status in the feature log (docs/design/systems.md "E4 in detail"): the Host's feature state, or, without one (tests),
  // the pack alone with what the windows saw.
  const featuresNow = () => (opts.features
    ? { log: opts.features.log, evaluation: opts.features.current() }
    : { log: shippedLog(), evaluation: evaluate(shippedLog(), { pack: adapter, facts: null, report: null, stale: [], live: liveOfProbe(probe()) }) });
  const compatibility = (manifest) => computeCompatibility(manifest, featuresNow());
  const safeModeActive = () => Boolean(opts.safeMode || state.safeMode);

  // ------------------------------------------------------------------ fault watching (update health window)
  function watchFaults(modId) {
    let resolveWindow = null, timer = null;
    const w = {
      fault: null,
      signal(reason) { if (!w.fault) { w.fault = reason; resolveWindow?.(); } },
      window(ms) {
        return new Promise((resolve) => {
          resolveWindow = resolve;
          if (w.fault) return resolve();
          timer = setTimeout(resolve, ms);
        }).finally(() => clearTimeout(timer));
      },
      dispose() { clearTimeout(timer); if (watchers.get(modId) === w) watchers.delete(modId); },
    };
    watchers.set(modId, w);
    return w;
  }

  // Its last fault is kept in its record (framework-ui.md F9), so a Host restart does not lose what stopped it; a flood of them is written at most once in a while.
  let faultWritten = 0;
  runtime.onFault((e) => {
    watchers.get(e.modId)?.signal(`${e.realm}/${e.kind}: ${e.message}`);
    const r = state.mods[e.modId];
    if (!r) return;
    r.lastFault = { at: now(), message: e.message, where: e.where ?? `${e.realm} (${e.kind})`, ...(e.stack ? { stack: e.stack } : {}) };
    if (Date.now() - faultWritten > FAULT_WRITE_MS) {
      faultWritten = Date.now();
      persistState().catch((err) => log.warn('a fault was not written', { modId: e.modId, error: String(err?.message ?? err) }));
    }
  });

  /** Deactivates, marks quarantined and journals a `disable` op carrying the reason. */
  async function applyQuarantine(modId, reason) {
    const r = state.mods[modId];
    if (!r || r.status !== 'enabled') return;
    try { await runtime.deactivate(modId, 'quarantine'); } catch (e) { log.warn('deactivate during quarantine failed', { modId, error: String(e?.message ?? e) }); }
    r.status = 'quarantined';
    r.quarantine = { reason, at: now() };
    r.updatedAt = now();
    await persistState();
    const t = now();
    const op = { id: newId('op'), input: { type: 'disable', modId }, outcome: 'succeeded', phases: [{ name: 'quarantine', at: t }], note: `Quarantined: ${reason}`, startedAt: t, endedAt: t };
    ops.set(op.id, op);
    await saveOp(op);
    notify(op);
    log.warn('mod quarantined', { modId, reason });
    try { bus.publish('framework/quarantine', { modId, reason }); } catch (e) { log.warn('bus publish failed', { error: String(e?.message ?? e) }); }
  }

  // ------------------------------------------------------------------ lifecycle (handlers live in lifecycle.mjs)
  const core = {
    L, log, packages, runtime, mux, bus, adapter, recovery,
    healthWindowMs, migrationTimeoutMs,
    /** A decision on an optional permission was written (F8): the Host's gate ends its prompts for it. */
    permissionChanged: (modId, grant, decision) => { try { bus.publish('framework/permission', { modId, grant, decision }); } catch (e) { log.warn('bus publish failed', { error: String(e?.message ?? e) }); } },
    get state() { return state; },
    set state(next) { state = next; },
    rec: (id) => state.mods[id],
    persistState, saveOp, notify, journal, step, finish, crash, claim, release,
    installed, viewOf, readManifestSync, packageDirOf, dataDirOf,
    async holdStore() {
      alive();
      const h = await storeLock.acquire();
      holds.add(h);
      return { release: async () => { holds.delete(h); await h.release(); } };
    },
    compatibility, safeModeActive, watchFaults, applyQuarantine, errInfo, isCrash,
    /** The update's switch is done: mod operations may run again (its verdict holds only the framework lock and its mods). */
    endExclusive(op) { if (exclusive === op.id) { exclusive = null; for (const check of [...idleChecks]) check(); } },
    swapWaitTicks: opts.swapWaitTicks, swapWaitMs: opts.swapWaitMs,
    allocInstallSeq: () => state.nextInstallSeq++,
    isActive: (modId) => runtime.status(modId) !== 'inactive',
    ops,
  };
  const life = createLifecycle(core);

  // ------------------------------------------------------------------ the public interface
  /** Waits (bounded) until no mod op is running, so a state-rewriting framework op has the mod plane to itself. */
  function drainModOps() {
    const busy = () => [...ops.values()].some((o) => o.outcome === 'running' && !FRAMEWORK_TYPES.has(o.input.type));
    if (!busy()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        idleChecks.delete(check);
        reject(new CodexModsError('Conflict', `mod operations were still running after ${Math.round(exclusiveWaitMs / 1000)} s; nothing was changed`));
      }, exclusiveWaitMs);
      const check = () => { if (!busy()) { clearTimeout(timer); idleChecks.delete(check); resolve(); } };
      idleChecks.add(check);
    });
  }

  async function execute(op) {
    executing.add(op.id);
    try {
      if (exclusiveNow(op)) await drainModOps();
      // A framework operation preempts an update's staging (docs/design/systems.md E5): it waits until the job has stopped.
      if (FRAMEWORK_TYPES.has(op.input.type)) await opts.beforeFrameworkOp?.(op);
      const done = await life.handlers[op.input.type](op);
      await finish(op, done ?? { outcome: 'succeeded' });
    } catch (e) {
      if (isCrash(e) || dead) return; // simulated process death: leave everything as the journal has it
      log.error('operation failed', { opId: op.id, type: op.input.type, error: String(e?.message ?? e) });
      // `failed` means nothing was applied. If an effect phase completed first, say so.
      const partial = partialEffects(op);
      const d = partial.length
        ? { outcome: 'needs-attention', error: errInfo(e), note: `Partially applied: ${partial.join(', ')} had run when it failed (${errInfo(e).message}). Local state may be incomplete; repeat the operation to finish it.` }
        : { outcome: 'failed', error: errInfo(e) };
      try { await finish(op, d); } catch (e2) { if (!isCrash(e2)) log.error('could not record failure', { opId: op.id }); }
    } finally { executing.delete(op.id); for (const check of [...idleChecks]) check(); }
  }

  /**
   * @param {object} input
   * @param {{ fromMod?: boolean }} [o]  `fromMod`: the mod itself asks (its own settings): it never waits on an operation of its own
   */
  async function start(input, o = {}) {
    alive();
    life.validateInput(input);
    const modId = FRAMEWORK_TYPES.has(input.type) ? null : (input.modId ?? await life.peekModId(input));
    let key = FRAMEWORK_TYPES.has(input.type) ? FRAMEWORK_LOCK : modId;
    if (!FRAMEWORK_TYPES.has(input.type) && exclusive) throw new CodexModsError('Conflict', `a framework operation (${exclusive}) is restoring mod state; try again when it ends`);
    // An update waiting for its verdict: its mods refuse what would change them under it; recovery is never kept waiting by it.
    const pending = [...ops.values()].find((o) => o.outcome === 'running' && o.input.type === UPDATE && switched(o));
    if (pending) {
      const changed = new Set([...(pending.result?.left ?? []), ...Object.keys(pending.result?.mods ?? {})]);
      if (GUARDED_BY_UPDATE.has(input.type) && changed.has(modId)) throw new CodexModsError('Conflict', `${modId} is part of the update ${pending.id}, which waits for the new build's first healthy boot`);
      if (input.type === 'safe-mode' && locks.get(FRAMEWORK_LOCK) === pending.id) key = null;   // safe mode does not wait for it
      if (input.type === 'lkg-restore' && locks.get(FRAMEWORK_LOCK) === pending.id && !executing.has(pending.id)) {
        await finish(pending, await life.concludeCopyUpdate(pending, 'Last known good was restored before the update was confirmed'));
      }
    }
    // A patch waits its turn; the mod's own waits only behind another settings change (whose notification may be what it answers),
    // never behind an operation that may be waiting on the mod itself (its activation).
    const patch = input.type === 'configure' && Array.isArray(input.patches);
    const mayWait = () => patch && (o.fromMod !== true || ops.get(locks.get(key))?.input?.type === 'configure');
    for (const until = Date.now() + PATCH_WAIT_MS; key && locks.has(key) && mayWait();) {
      await waitTurn(key, until);
      alive();
      if (exclusive) throw new CodexModsError('Conflict', `a framework operation (${exclusive}) is restoring mod state; try again when it ends`);
    }
    if (key && locks.has(key)) throw new CodexModsError('Conflict', `${key} already has a running operation (${locks.get(key)})`);
    life.preflight(input);                       // throws Invalid/Denied/Incompatible for impossible requests
    const op = { id: newId('op'), input: structuredClone(input), outcome: 'running', phases: [], startedAt: now() };
    if (modId && !input.modId) op.result = { modId };
    if (key) { locks.set(key, op.id); opLock.set(op.id, key); }
    if (exclusiveNow(op)) exclusive = op.id;
    ops.set(op.id, op);
    try { await saveOp(op); } catch (e) { release(op); if (exclusive === op.id) exclusive = null; ops.delete(op.id); throw e; }
    notify(op);
    setImmediate(() => { void execute(op); });
    return op.id;
  }

  const get = (opId) => (ops.has(opId) ? structuredClone(ops.get(opId)) : undefined);

  function list(filter = {}) {
    let all = [...ops.values()];
    if (filter.modId !== undefined) all = all.filter((o) => opModId(o) === filter.modId);
    if (filter.running !== undefined) all = all.filter((o) => (o.outcome === 'running') === filter.running);
    return all.map((o) => structuredClone(o));
  }

  /** Asks Recovery about every running framework-level op that no handler in this process is executing, and applies non-null verdicts. */
  async function reconcileRunningFramework() {
    const byStart = (a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
    const pending = [...ops.values()].filter((o) => o.outcome === 'running' && FRAMEWORK_TYPES.has(o.input.type) && !executing.has(o.id)).sort(byStart);
    for (const op of pending) {
      if (op.outcome !== 'running' || executing.has(op.id)) continue;
      if (op.input.type === UPDATE) {
        try { const r = await life.recoverCopyUpdate(op); if (r) await finish(op, r); } catch (e) {
          if (isCrash(e)) throw e;
          log.error('recovery of the update failed', { opId: op.id, error: String(e?.message ?? e) });
          await finish(op, { outcome: 'needs-attention', note: `Recovery could not complete: ${String(e?.message ?? e)}` });
        }
        continue;
      }
      try {
        const r = await recovery.reconcileOp(structuredClone(op));
        if (r) await finish(op, { outcome: r.outcome, note: r.note, result: r.result });
      } catch (e) {
        if (isCrash(e)) throw e;
        log.error('reconcileOp failed', { opId: op.id, error: String(e?.message ?? e) });
      }
    }
  }

  /** v1.9: re-run reconciliation now. Serialized with itself and with an exclusive framework op; idempotent. */
  function reconcileFramework() {
    const run = reconcileChain.then(async () => {
      // An exclusive framework op that is executing right now owns the mod plane: wait for it. (One merely left over from a previous
      // process is exactly what reconciliation resolves, so it does not wait.)
      if (exclusive && executing.has(exclusive)) {
        await new Promise((resolve) => { const check = () => { if (!exclusive || !executing.has(exclusive)) { idleChecks.delete(check); resolve(); } }; idleChecks.add(check); check(); });
      }
      await reconcileRunningFramework();
    });
    reconcileChain = run.catch(() => {});
    return run;
  }

  /** The copy's update reconciled before the boot's generation is recorded (docs/design/systems.md E5): undone, reverted, failed, or
   *  left waiting for its verdict; a boot's generation is then always recorded from settled state. */
  async function recoverEarly() {
    for (const op of [...ops.values()].filter((o) => o.outcome === 'running' && o.input.type === UPDATE && !executing.has(o.id))) {
      try { const r = await life.recoverCopyUpdate(op, { early: true }); if (r) await finish(op, r); } catch (e) {
        if (isCrash(e)) throw e;
        log.error('early recovery of the update failed', { opId: op.id, error: String(e?.message ?? e) });
        await finish(op, { outcome: 'needs-attention', note: `Recovery could not complete: ${String(e?.message ?? e)}` });
      }
    }
  }

  async function recover() {
    const running = [...ops.values()].filter((o) => o.outcome === 'running');
    const byStart = (a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
    // 1. framework-level ops: ask Recovery what happened.
    await reconcileFramework();
    // 2. mod ops: replay from the last journaled phase.
    for (const op of running.filter((o) => !FRAMEWORK_TYPES.has(o.input.type)).sort(byStart)) {
      try {
        const done = await life.recoverers[op.input.type](op);
        await finish(op, done);
      } catch (e) {
        if (isCrash(e)) throw e;
        log.error('recovery of op failed', { opId: op.id, error: String(e?.message ?? e) });
        await finish(op, { outcome: 'needs-attention', note: `Recovery could not complete: ${String(e?.message ?? e)}` });
      }
    }
    await life.cleanupStaging();
  }

  async function activateAll() {
    if (safeModeActive()) return;
    const ids = Object.keys(state.mods).filter((id) => state.mods[id].status === 'enabled').sort(byRank);   // in the user's order (E6)
    for (const id of ids) {
      if (locks.has(id)) continue;
      const view = installed(id);
      if (!view) { await applyQuarantine(id, 'package or manifest could not be loaded'); continue; }
      const compat = compatibility(view.manifest);
      if (compat.status === 'blocked') { await applyQuarantine(id, `incompatible with this app build. ${blockedBecause(compat)}`); continue; }
      try { await runtime.activate(view); } catch (e) {
        log.warn('activation failed', { modId: id, error: String(e?.message ?? e) });
        await applyQuarantine(id, `activation failed: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * Every store version still referenced by any profile under this root. Order matters: states and generations are
   * read FIRST, op journals LAST, so an update that commits between the two reads is seen by its (recent) journal even if the state
   * read predates it. Any enumeration or read error other than ENOENT aborts GC (nothing is deleted).
   */
  async function collectStoreRefs() {
    const refs = new Map();
    const add = (id, version) => { if (typeof id === 'string' && typeof version === 'string') { if (!refs.has(id)) refs.set(id, new Set()); refs.get(id).add(version); } };
    const addState = (st) => { for (const [id, r] of Object.entries(st?.mods ?? {})) { if (!r.dev) add(id, r.version); add(id, r.pendingUpdate?.version); } };
    const OP_GRACE_MS = 60 * 60 * 1000;
    const addOp = (o) => {
      const recent = o?.outcome === 'running' || !o?.endedAt || Date.now() - Date.parse(o.endedAt) < OP_GRACE_MS || Number.isNaN(Date.parse(o.endedAt));
      if (!recent) return;
      const m = o.input?.modId ?? o.result?.modId;
      add(m, o.input?.toVersion); add(m, o.result?.version); add(o.result?.plan?.modId ?? m, o.result?.plan?.to); add(o.result?.plan?.modId ?? m, o.result?.plan?.from);
    };
    const abort = (what, e) => new CodexModsError('Unavailable', `store GC aborted: ${what} could not be read (${e.message})`);
    const readJsonFile = async (path) => {
      try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw abort(path, e); }
    };
    const listDir = async (path) => {
      try { return await readdir(path); } catch (e) { if (e.code === 'ENOENT') return []; throw abort(path, e); }
    };
    const profilesDir = join(L.root, 'profiles');
    const profiles = [];
    for (const name of await listDir(profilesDir)) {
      const dir = join(profilesDir, name);
      let st;
      try { st = await lstat(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw abort(dir, e); }
      if (st.isDirectory()) profiles.push(dir);
    }
    for (const dir of profiles) {                                  // pass 1: states and generations
      addState(await readJsonFile(join(dir, 'state.json')));
      for (const name of await listDir(join(dir, 'generations'))) {
        if (!/^\d+\.json$/.test(name)) continue;
        const g = await readJsonFile(join(dir, 'generations', name));
        for (const m of g?.mods ?? []) add(m.id, m.version);
        addState(g?.state);
      }
    }
    addState(state);                                  // this instance's in-memory view may be ahead of its disk
    await opts.gcHook?.('states-read');
    for (const dir of profiles) {                                  // pass 2: op journals, running or recently ended
      for (const name of await listDir(join(dir, 'ops'))) if (name.endsWith('.json') && !name.startsWith('.')) addOp(await readJsonFile(join(dir, 'ops', name)));
    }
    for (const o of ops.values()) addOp(o);
    return refs;
  }

  async function gcStore() {
    const hold = await core.holdStore();
    try {
      const refs = await collectStoreRefs();
      const listStore = async (path) => {
        try { return await readdir(path); } catch (e) { if (e.code === 'ENOENT') return []; throw new CodexModsError('Unavailable', `store GC aborted: ${path} could not be listed (${e.message})`); }
      };
      const list = async () => {
        const out = [];
        for (const id of await listStore(L.store)) {
          if (id.startsWith('.')) continue;
          for (const v of await listStore(join(L.store, id))) out.push(`${id}@${v}`);
        }
        return out;
      };
      const before = await list();
      await packages.gc((id) => [...(refs.get(id) ?? [])]);
      const after = new Set(await list());
      const removed = before.filter((x) => !after.has(x));
      if (removed.length) log.info('store gc', { removed });
      return { removed };
    } finally { await hold.release(); }
  }

  async function setSafeMode(enter) {
    state.safeMode = Boolean(enter);
    await persistState();
  }

  function quarantine(modId, reason) {
    const w = watchers.get(modId);
    if (w) {
      w.signal(`quarantine: ${reason}`);
      try { bus.publish('framework/quarantine', { modId, reason }); } catch (e) { log.warn('bus publish failed', { error: String(e?.message ?? e) }); }
      return Promise.resolve();
    }
    if (locks.has(modId) || exclusive) { pendingQuarantine.set(modId, reason); return Promise.resolve(); }
    return applyQuarantine(modId, reason).catch((e) => { if (!isCrash(e)) log.error('quarantine failed', { modId, error: String(e?.message ?? e) }); });
  }

  loadOps();

  /** A mod's place in the user's order (E6): its `order` once the user set one, else its install ordinal. */
  const rankOf = (id) => { const m = state.mods[id]; return m ? (Number.isFinite(m.order) ? m.order : m.installSeq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER; };
  const byRank = (a, b) => rankOf(a) - rankOf(b) || (state.mods[a]?.installSeq ?? 0) - (state.mods[b]?.installSeq ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

  return {
    start, get, list,
    subscribe(fn) { subscribers.add(fn); return { dispose() { subscribers.delete(fn); } }; },
    recover, activateAll, rankOf, byRank,
    /** Developer mode (framework-ui.md F12): folder installs allowed and stacks shown; one stored flag, not an operation. */
    async setDeveloperMode(on) {
      alive();
      const before = state.developerMode === true;
      if (before === Boolean(on)) return { developerMode: before };
      state.developerMode = Boolean(on);
      try { await persistState(); } catch (e) { state.developerMode = before; throw e; }
      return { developerMode: state.developerMode };
    },
    /**
     * The user's mod order (E6, decision 11): a permutation of the installed mods (Conflict otherwise: an install or a remove since the
     * user looked), written once as `order` in their records (installSeq stays the install ordinal); refused while any operation runs
     * (an operation's undo restores a record it captured, order included: E6 review), and nothing changes when the write fails. The rules
     * follow at once (the caller re-ranks them); activation follows at the next launch.
     */
    async setOrder(ids) {
      alive();
      if (exclusive) throw new CodexModsError('Conflict', `a framework operation (${exclusive}) is restoring mod state; try again when it ends`);
      const busy = [...ops.values()].find((o) => o.outcome === 'running');
      if (busy) throw new CodexModsError('Conflict', `an operation (${busy.id}) is running; try again when it ends`);
      const have = Object.keys(state.mods);
      if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.includes(id))) {
        throw new CodexModsError('Conflict', 'the order must name every installed mod once: they changed since you looked; look again');
      }
      const before = new Map(ids.map((id) => [id, state.mods[id].order]));
      ids.forEach((id, i) => { state.mods[id].order = i + 1; });
      try { await persistState(); } catch (e) {
        for (const [id, o] of before) if (state.mods[id]) { if (o === undefined) delete state.mods[id].order; else state.mods[id].order = o; }
        throw e;
      }
      return { mods: [...ids] };
    },
    state: () => structuredClone(state),
    installed, compatibility, quarantine, setSafeMode, gcStore, reconcileFramework, recoverEarly,
    /**
     * E6: an operation that needs attention, acknowledged by the user (durably: it keeps its outcome and gains acknowledgedAt). It answers
     * once the acknowledgement is written; concurrent calls share that one write, and a failed write acknowledges nothing.
     */
    async acknowledge(opId) {
      alive();
      const op = ops.get(opId);
      if (!op) throw new CodexModsError('Unavailable', `no operation ${opId}`);
      if (op.outcome !== 'needs-attention') throw new CodexModsError('Invalid', `${opId} does not need attention (it ${op.outcome === 'running' ? 'is running' : `ended ${op.outcome}`})`);
      if (!op.acknowledgedAt) {
        let p = acknowledging.get(opId);
        if (!p) {
          const at = now();
          p = saveOp({ ...op, acknowledgedAt: at }).then(() => { op.acknowledgedAt = at; notify(op); }).finally(() => acknowledging.delete(opId));
          acknowledging.set(opId, p);
        }
        await p;
      }
      return structuredClone(op);
    },
    /** Extra (v1.13): preserved data of keep-data removals, newest first, for inspect's `orphanedGenerations`. */
    async orphanedGenerations(modId) {
      return createOrphans(L).list(modId).map(({ at, version, dataSchemaVersion }) => ({ at, version, dataSchemaVersion }));
    },
    restoreFromGeneration: (g) => life.restoreFromGeneration(g),
    /** Extra (not in the contract): resolves with the op record once its outcome is no longer 'running'. */
    whenSettled(opId) {
      return new Promise((resolve, reject) => {
        if (!ops.has(opId)) return reject(new CodexModsError('Invalid', `unknown operation ${opId}`));
        const check = () => { const o = ops.get(opId); if (o.outcome !== 'running') { sub.dispose(); resolve(structuredClone(o)); return true; } return false; };
        const sub = { dispose() { subscribers.delete(fn); } };
        const fn = (o) => { if (o.id === opId) check(); };
        subscribers.add(fn);
        check();
      });
    },
  };
}
