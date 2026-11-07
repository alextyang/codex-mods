// A cancellation signal for a held operation (interception.md I7): what ends a call while its interceptors decide. Node built-ins only.

/** `{signal, abort(reason)}`; the signal is `{aborted, reason, onAbort(fn) -> Disposable}` (`fn` runs once, at once when already aborted). */
export function createAbort() {
  const fns = new Set();
  const signal = { aborted: false, reason: null, onAbort(fn) { if (signal.aborted) { queueMicrotask(fn); return { dispose() {} }; } fns.add(fn); return { dispose() { fns.delete(fn); } }; } };
  return {
    signal,
    abort(reason = 'cancelled') { if (signal.aborted) return; signal.aborted = true; signal.reason = reason; for (const fn of [...fns]) { try { fn(); } catch { /* the listener's own fault */ } } fns.clear(); },
  };
}
