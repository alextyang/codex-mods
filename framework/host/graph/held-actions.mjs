// The app's own actions a place held and let go (docs/design/public-hooks.md §3.4, §3.5: framework-main's settings and notifications, the
// page's card answers and new chat sends), until that place says what each did. The graph's record of a held action completes with it (a
// mod's `after` says what happened, not what was allowed); one that was let through unheld (nothing decided on it) is recorded as
// observed once told. A place that never says is recorded uncertain after DONE_MS. Node built-ins only.

export const DONE_MS = 30_000;

const isRef = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string' && typeof v.provider === 'string' && typeof v.id === 'string';
/** What a place says an action did, as the graph takes it: done (with what it made, a ref), failed (with why) or uncertain. */
export function outcomeOf(o) {
  if (o && o.status === 'done') return isRef(o.value) ? { status: 'done', value: { type: o.value.type, provider: o.value.provider, id: o.value.id } } : { status: 'done' };
  if (o && o.status === 'failed') return { status: 'failed', error: { message: String(o.error?.message ?? 'failed').slice(0, 500) } };
  return { status: 'uncertain' };
}

/** @param {{ graph: () => { recordApp(r: object): boolean } | null, doneMs?: number }} o */
export function createHeldActions({ graph, doneMs = DONE_MS }) {
  const waiting = new Map();   // token -> {resolve?, record?, timer}
  function finish(token, outcome) {
    const w = waiting.get(token);
    if (!w) return false;
    waiting.delete(token);
    clearTimeout(w.timer);
    const out = outcomeOf(outcome);
    if (w.resolve) w.resolve(out);
    else if (w.record) { try { graph()?.recordApp({ ...w.record, outcome: out }); } catch { /* a record is information only */ } }
    return true;
  }
  const timer = (fn) => { const t = setTimeout(fn, doneMs); t.unref?.(); return t; };
  return {
    /** A held action's forward, once it went: resolves with what it did when told (uncertain after `doneMs`). */
    completion(token) {
      return new Promise((resolve) => { waiting.set(token, { resolve, timer: timer(() => finish(token, null)) }); });
    },
    /** A held action let through unchanged, nothing having decided on it: recorded as observed once told what it did. */
    released(token, record) { waiting.set(token, { record, timer: timer(() => { waiting.delete(token); }) }); },
    /** What the action did, from the place that held it; false when nothing waits on that token. */
    done: (token, outcome) => finish(token, outcome),
    dispose() { for (const token of [...waiting.keys()]) finish(token, null); },
  };
}
