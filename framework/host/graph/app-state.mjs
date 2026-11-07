// The app's own state in the Host (breadth step D4; ARCHITECTURE.md 6.8): the app's settings, its version, whether its onboarding is done
// and the system's appearance, as framework-main reads them (framework/main/app-state.cjs). The native provider (providers/codex) puts them
// as Setting, SettingsSection, App and Theme instances. This store is the Host's copy:
// - `apply(report)` takes framework-main's `app-state` message: the settings' definitions on a reset, their values (all of them on a reset,
//   else the ones that changed), the app's facts and the appearance when they changed. Each report that changed something is announced to
//   the `onChange` listeners; a reset, or the first report the store hears, is `sync: true` (catching up: nobody did it, no event).
// - `op(op, args)` asks framework-main to run an operation the app's way (`write-setting {key, value}`) and settles with its
//   `app-state-op-done`: `{ok: true, result?}`, or `{ok: false, error, refused}` (refused: nothing was tried). The report of what the
//   operation changed comes first, so the store holds the result when the promise settles.
// While framework-main has no window (`available: false`) the store keeps what it knew and operations are refused, but for the mods'
// defaults (framework-main keeps them without a window). Node built-ins only.
import { randomBytes } from 'node:crypto';

const MAX_ID = 200;
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @typedef {{ key: string, agentAccess: 'read-write' | 'read-only', default: unknown, description: string | null, schema: object | null }} SettingDefinition */
/** @typedef {{ configured: unknown, effective: unknown }} SettingValue */
/** @typedef {{ version: string | null, buildNumber: string | null, appName: string | null, onboarded: boolean | null, launchedAt: number | null }} AppFacts */
/**
 * @typedef {{ sync: boolean, reset?: boolean, available?: boolean, definitions?: boolean, settings?: string[], app?: boolean, appearance?: boolean, quitting?: boolean }} AppStateChange
 *   `settings` lists the keys whose values changed; `definitions` that the set of settings changed; `reset` that framework-main read
 *   everything anew (it started again, or has a window again), whether or not anything changed.
 */

/**
 * @param {{ send?: (msg: object) => void, log?: { warn(m: string, d?: unknown): void }, timeoutMs?: number }} [o]
 */
export function createAppState(o = {}) {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const prefix = randomBytes(4).toString('hex');
  let available = false;
  let heard = false;
  /** @type {Map<string, SettingDefinition>} */
  let definitions = new Map();
  /** @type {Map<string, SettingValue>} */
  const values = new Map();
  /** @type {AppFacts | null} */
  let app = null;
  /** @type {'light' | 'dark' | null} */
  let appearance = null;
  const fns = new Set();
  const pending = new Map();
  let seq = 0;
  let disposed = false;

  function emit(change) { for (const fn of [...fns]) { try { fn(change); } catch (e) { o.log?.warn('app state: a listener failed', { message: String(e?.message ?? e) }); } } }

  function apply(msg) {
    if (disposed || !msg || typeof msg !== 'object') return;
    const sync = msg.reset === true || !heard;
    heard = true;
    /** @type {AppStateChange} */
    const change = { sync };
    if (msg.reset === true) change.reset = true;
    if (typeof msg.available === 'boolean' && msg.available !== available) { available = msg.available; change.available = available; }
    if (Array.isArray(msg.definitions)) {
      const next = new Map();
      for (const d of msg.definitions) if (d && isKey(d.key)) next.set(d.key, Object.freeze({ key: d.key, agentAccess: d.agentAccess === 'read-only' ? 'read-only' : 'read-write', default: d.default, description: typeof d.description === 'string' ? d.description : null, schema: d.schema && typeof d.schema === 'object' ? d.schema : null }));
      if (!same([...next.values()], [...definitions.values()])) change.definitions = true;
      definitions = next;
      for (const k of [...values.keys()]) if (!definitions.has(k)) values.delete(k);
    }
    if (msg.values && typeof msg.values === 'object') {
      const keys = [];
      for (const [k, v] of Object.entries(msg.values)) {
        if (!isKey(k) || !v || typeof v !== 'object') continue;
        const nv = Object.freeze({ configured: v.configured, effective: v.effective });
        if (!same(values.get(k), nv)) keys.push(k);
        values.set(k, nv);
      }
      if (keys.length) change.settings = keys;
    }
    if (msg.app && typeof msg.app === 'object') {
      const next = Object.freeze({ version: typeof msg.app.version === 'string' ? msg.app.version : null, buildNumber: typeof msg.app.buildNumber === 'string' ? msg.app.buildNumber : null,
        appName: typeof msg.app.appName === 'string' ? msg.app.appName : null, onboarded: typeof msg.app.onboarded === 'boolean' ? msg.app.onboarded : null,
        launchedAt: Number.isFinite(msg.app.launchedAt) ? msg.app.launchedAt : null });
      if (!same(next, app)) { app = next; change.app = true; }
    }
    if (msg.appearance === 'light' || msg.appearance === 'dark') { if (msg.appearance !== appearance) { appearance = msg.appearance; change.appearance = true; } }
    if (msg.quitting === true) change.quitting = true;
    if (Object.keys(change).length > 1) emit(change);
  }
  function settle(msg) {
    const p = msg && pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timer);
    p.resolve(msg.ok === true ? { ok: true, ...(msg.result === undefined ? {} : { result: msg.result }) } : { ok: false, error: String(msg.error ?? 'the app could not do it'), refused: msg.refused === true });
  }

  return {
    get available() { return available; },
    /** @returns {SettingDefinition[]} */
    definitions: () => [...definitions.values()],
    definition: (key) => definitions.get(key) ?? null,
    /** @returns {SettingValue | null} */
    value: (key) => values.get(key) ?? null,
    get app() { return app; },
    get appearance() { return appearance; },
    apply,
    settle,
    /**
     * Run an operation in the app (framework/main/app-state.cjs): 'write-setting' ({key, value}), 'setting-defaults' ({defaults: the
     * mods' defaults by key}), 'account', 'navigate' ({path}), 'open-help', 'quit', 'open-login' ({path}).
     * @returns {Promise<{ ok: true, result?: unknown } | { ok: false, error: string, refused: boolean }>}
     */
    op(op, args = {}) {
      if (disposed) return Promise.resolve({ ok: false, error: 'the Host is shutting down', refused: true });
      // the mods' defaults go while no window is open too (framework-main keeps them for the store, so one taken back is gone at once)
      if ((!available && op !== 'setting-defaults') || typeof o.send !== 'function') return Promise.resolve({ ok: false, error: 'the app\'s settings are not available', refused: true });
      const requestId = `${prefix}-${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({ ok: false, error: `framework-main did not answer in ${timeoutMs} ms`, refused: false });
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        const extra = Object.fromEntries(['key', 'value', 'path', 'defaults'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        try { o.send({ type: 'app-state-op', requestId, op, ...extra }); } catch (e) {
          pending.delete(requestId);
          clearTimeout(timer);
          resolve({ ok: false, error: String(e?.message ?? e), refused: true });
        }
      });
    },
    /** @param {(change: AppStateChange) => void} fn */
    onChange(fn) { fns.add(fn); return { dispose: () => fns.delete(fn) }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the Host is shutting down', refused: true }); }
      pending.clear();
      fns.clear();
    },
  };
}
