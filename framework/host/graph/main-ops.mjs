// framework-main's feature areas, seen from the Host (breadth.md D5, D10; ARCHITECTURE.md 4.1): one channel for every area module of
// framework-main (framework/main/*.cjs that register with `hooks.onAreaOp`), so an area needs no message types or Host routing of its own.
// - `op(area, op, args)` asks framework-main to run an operation the app's way: `area-op {area, requestId, op, args}`, answered by
//   `area-op-done {requestId, ok, result?, error?, refused?}` (refused: nothing was tried). An area's answer follows any report of what the
//   operation changed, so a caller that also listens to the reports sees the change first.
// - `onReport(area, fn)` hears the area's reports (`area-report {area, report}`): what framework-main reads from the app and pushes.
// Without framework-main (headless) every operation is refused at once. Node built-ins only.
import { randomBytes } from 'node:crypto';

const MAX_AREA = 64;
const isArea = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_AREA;

/**
 * @param {{ send?: (msg: object) => void, log?: { warn(m: string, d?: unknown): void }, timeoutMs?: number }} [o]
 */
export function createMainOps(o = {}) {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const prefix = randomBytes(4).toString('hex');
  const pending = new Map();
  const listeners = new Map();   // area -> Set of fns
  let seq = 0;
  let disposed = false;

  return {
    /**
     * Run an area's operation in framework-main.
     * @returns {Promise<{ ok: true, result?: unknown } | { ok: false, error: string, refused: boolean }>}
     */
    op(area, op, args = {}) {
      if (disposed) return Promise.resolve({ ok: false, error: 'the Host is shutting down', refused: true });
      if (typeof o.send !== 'function') return Promise.resolve({ ok: false, error: 'framework-main is not running', refused: true });
      if (!isArea(area) || typeof op !== 'string' || !op) return Promise.resolve({ ok: false, error: 'an area and an operation are needed', refused: true });
      const requestId = `${prefix}-${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({ ok: false, error: `framework-main did not answer in ${timeoutMs} ms`, refused: false });
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        try { o.send({ type: 'area-op', area, requestId, op, args }); } catch (e) {
          pending.delete(requestId);
          clearTimeout(timer);
          resolve({ ok: false, error: String(e?.message ?? e), refused: true });
        }
      });
    },
    /** framework-main's `area-op-done`. */
    settle(msg) {
      const p = msg && pending.get(msg.requestId);
      if (!p) return;
      pending.delete(msg.requestId);
      clearTimeout(p.timer);
      p.resolve(msg.ok === true ? { ok: true, ...(msg.result === undefined ? {} : { result: msg.result }) } : { ok: false, error: String(msg.error ?? 'the app could not do it'), refused: msg.refused === true });
    },
    /** framework-main's `area-report`: handed to the area's listeners. */
    report(msg) {
      if (disposed || !msg || !isArea(msg.area)) return;
      for (const fn of [...(listeners.get(msg.area) ?? [])]) {
        try { fn(msg.report); } catch (e) { o.log?.warn('main ops: a report listener failed', { area: msg.area, message: String(e?.message ?? e) }); }
      }
    },
    /** @param {(report: unknown) => void} fn */
    onReport(area, fn) {
      const set = listeners.get(area) ?? new Set();
      set.add(fn);
      listeners.set(area, set);
      return { dispose: () => set.delete(fn) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the Host is shutting down', refused: true }); }
      pending.clear();
      listeners.clear();
    },
  };
}
