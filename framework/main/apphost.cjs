'use strict';
// The AppHost hold of framework-main (docs/design/presentations.md V1, V2, V12; the build-time seam is `app-host` in adapters/tools/seams.mjs,
// the hook is PageHooks.appHost in contracts/adapter.d.ts).
// The app's main code creates an AppHost for each window it serves (the services main exports to the window over its `connect-app-host`
// port: `host.services.<name>`), and the seam makes it call `globalThis.__codexmods?.appHost?.(host, sender, view)` once per window, right
// after it registers the window's AppView. `view` is that AppView: the window's own services, which main calls over the same port
// (`view.services.<name>`, RPC: `clientCoordination` answers which window owns a chat and takes the app's thread-follower requests); a
// pack sealed before it was passed gives none. `host` may be undefined (a window without a context); a throw from this hook is counted by
// the seam in `__codexmods.faults.appHost`, so nothing here throws.
// framework-main runs before the app's main code (loader -> framework-main), so `start()` installs the hook early. It extends
// `globalThis.__codexmods` and never replaces it, and a hook someone installed before is still called (before ours).
// This module only keeps the live windows' hosts (and views) by sender id (dropped when the sender is destroyed, or when a reload of the page gives
// the same sender a new host). What uses them, such as the read-state module, is built on `subscribe` and `windows`. It is testable with
// fakes: `global` is injectable, and a host is any object, a sender anything with an `id` and, optionally, `once` and `isDestroyed`.

/**
 * @param {{ log?: { info(m: string, d?: unknown): void, error(m: string, d?: unknown): void, warn?(m: string, d?: unknown): void }, global?: object }} [o]
 * @returns {{ windows(): { id: number, host: any, view: any }[], first(): { id: number, host: any, view: any } | null, senderOf(id: number): any, subscribe(fn: (e: { type: 'added' | 'removed', id: number, host: any, view: any }) => void): { dispose(): void }, dispose(): void }}
 */
function installAppHost({ log, global: g = globalThis } = {}) {
  const warn = (m, d) => { try { (log?.warn ?? log?.error)?.call(log, m, d); } catch { /* logging never breaks the hold */ } };
  const info = (m, d) => { try { log?.info?.(m, d); } catch { /* ditto */ } };
  const windows = new Map();       // sender id -> {id, host, sender}, in the order the windows were held
  const listeners = new Set();
  let disposed = false;
  let noted = false;

  let ns = null;
  try {
    ns = g.__codexmods && typeof g.__codexmods === 'object' ? g.__codexmods : (g.__codexmods = {});
  } catch (e) { warn('AppHost hold: globalThis.__codexmods cannot be extended; windows will not be held', { message: String(e && e.message || e) }); }
  const previous = ns && typeof ns.appHost === 'function' ? ns.appHost : null;

  function emit(type, entry) {
    for (const fn of [...listeners]) {
      try { fn({ type, id: entry.id, host: entry.host, view: entry.view }); } catch (e) { warn('AppHost hold: a listener failed', { message: String(e && e.message || e) }); }
    }
  }
  function drop(entry) {
    if (windows.get(entry.id) !== entry) return;
    windows.delete(entry.id);
    emit('removed', entry);
  }

  function hold(host, sender, view) {
    if (previous) { try { previous(host, sender, view); } catch (e) { warn('AppHost hold: the earlier appHost hook failed', { message: String(e && e.message || e) }); } }
    if (disposed) return;
    try {
      if (host == null || typeof host !== 'object') {
        if (!noted) { noted = true; info('AppHost hold: a window came without an AppHost; it is not held'); }
        return;
      }
      const id = sender && Number.isSafeInteger(sender.id) ? sender.id : null;
      if (id === null) { warn('AppHost hold: the window has no sender id; it is not held'); return; }
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
      const old = windows.get(id);
      if (old) drop(old);                                  // a reload of the page: the same sender, a new host
      // The AppView is a Cap'n Web stub: a callable proxy (typeof 'function'), not a plain object.
      const entry = { id, host, sender, view: view != null && (typeof view === 'object' || typeof view === 'function') ? view : null };
      windows.set(id, entry);
      if (typeof sender.once === 'function') sender.once('destroyed', () => drop(entry));
      info('AppHost held', { window: id, services: host.services && typeof host.services === 'object' ? Object.keys(host.services).length : 0 });
      emit('added', entry);
    } catch (e) { warn('AppHost hold failed', { message: String(e && e.message || e) }); }
  }
  if (ns) {
    try { ns.appHost = hold; } catch (e) { warn('AppHost hold: the hook could not be installed', { message: String(e && e.message || e) }); }
  }

  return {
    windows: () => [...windows.values()].map((w) => ({ id: w.id, host: w.host, view: w.view })),
    first: () => { const w = windows.values().next().value; return w ? { id: w.id, host: w.host, view: w.view } : null; },
    /** A held window's web contents (what the app's own main-side services take for a window, such as its notifications' target), or null. */
    senderOf: (id) => windows.get(id)?.sender ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return { dispose: () => { listeners.delete(fn); } };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (ns && ns.appHost === hold) { if (previous) ns.appHost = previous; else delete ns.appHost; }
      } catch { /* a frozen namespace: nothing to restore */ }
      listeners.clear();
      windows.clear();
    },
  };
}

module.exports = { installAppHost };
