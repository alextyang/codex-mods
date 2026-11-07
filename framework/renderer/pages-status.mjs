// A window's Mods pages as its page runtime reports them (docs/design/systems.md "The recovery entry", E6.1). They run once their route tree
// is reached, their navigation entry has rendered and the framework's graph has answered their first read; they failed on a fault in their
// boundary or when they could not start; otherwise they are missing. The recovery view (recovery/index.mjs) shows unless they run, and
// never needs to know why. Until a report, or `graceMs` after the window's runtime started, they are `starting` (they start once the
// graph's types arrive), so a window that is still coming up shows no recovery view. Running holds; failed holds until the page reloads.
// NO NODE API.

export const PAGES_GRACE_MS = 10000;
/** What must have happened for the pages to run. */
export const PAGE_PARTS = Object.freeze(['routes', 'nav', 'read']);

/** @param {{ schedule?: (fn: () => void, ms: number) => void, graceMs?: number }} [o] */
export function createPagesStatus({ schedule = (fn, ms) => setTimeout(fn, ms), graceMs = PAGES_GRACE_MS } = {}) {
  let state = 'starting', why = null;
  const parts = new Set();
  const listeners = new Set();
  const set = (next, reason) => {
    if (state === next || state === 'failed') return;
    state = next; why = reason ?? null;
    for (const fn of [...listeners]) { try { fn(state); } catch { /* the listener's own fault */ } }
  };
  schedule(() => { if (state === 'starting') set('missing', 'they have not started'); }, graceMs);
  return {
    /** 'starting' | 'running' | 'failed' | 'missing' */
    get: () => state,
    why: () => why,
    /** Whether one of PAGE_PARTS has happened (the route tree and the first read, say, before Settings was ever shown). */
    has: (part) => state === 'running' || parts.has(part),
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    /** One of PAGE_PARTS happened; with all of them the pages run. */
    mounted(part) {
      if (!PAGE_PARTS.includes(part) || state === 'running' || state === 'failed') return;
      parts.add(part);
      if (PAGE_PARTS.every((p) => parts.has(p))) set('running');
    },
    failed(reason) { set('failed', String(reason ?? 'they failed')); },
    /** The page runtime starts again (a new Host channel after a restart, E6 review): starting, its parts to report again. */
    reset() {
      parts.clear();
      if (state === 'starting') return;
      state = 'starting'; why = null;
      for (const fn of [...listeners]) { try { fn(state); } catch { /* the listener's own fault */ } }
      schedule(() => { if (state === 'starting') set('missing', 'they have not started'); }, graceMs);
    },
    /** They cannot start in this window (what they need is not there). */
    missing(reason) { if (state === 'starting') set('missing', String(reason ?? 'they are missing')); },
  };
}
