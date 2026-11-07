// The app's read state in the Host (docs/design/presentations.md V12; ARCHITECTURE.md 6.8): which threads the app shows as unread, kept in step
// with the graph's `Thread.unread` of the app's own chats by the native provider (providers/codex); a mod's chats keep their own.
// The truth lives in the app (its global state, reached through framework-main's `threadReadState` session: framework/main/read-state.cjs).
// This store is the Host's copy of it, by the app's thread id:
// - `apply(report)` takes framework-main's `read-state` message. While `available`, the report's set is the app's. A change the app made
//   (the user opened a thread, marked one unread) is announced with origin 'app'. A change that is only catching up (the first report of
//   an account, a report after the app was unreachable, a write that expired) has origin 'sync': nobody did it, so nobody reacts to it.
// - `set(threadId, unread)` is the framework's own write (Thread.markRead on one of the app's chats). It takes effect here at once (origin 'framework') and is sent to framework-main as `read-state-set`, which applies the writes in
//   order and acks them (an ack means applied). Until a write is acked it stays on top of what the store hears, so a report sent before it
//   cannot undo it. A write carries the account epoch the store last heard: framework-main applies it in that account's session only. One it
//   drops (another account's, refused, failed) is reported, and its effect reverts here as a 'sync'; so does every pending write of an
//   account the reports no longer name (boundary review R3).
// Nothing sent to framework-main is ever sent back as a change of the app's: an echo finds the store already holding the value and changes
// nothing, so there is no loop. Writes made while the app has no session wait in framework-main's queue; a write nobody acks for
// `pendingTtlMs` is forgotten (its effect then reverts as a 'sync'). Node built-ins only.
import { randomBytes } from 'node:crypto';

/** @typedef {{ threadId: string, unread: boolean, origin: 'app' | 'framework' | 'sync' }} ReadStateChange */

/**
 * @param {{ send?: (msg: { type: 'read-state-set', id: string, threadId: string, unread: boolean, epoch: string | null }) => void,
 *   log?: { warn(m: string, d?: unknown): void }, now?: () => number, pendingTtlMs?: number, epoch?: string }} [o]
 */
export function createReadState(o = {}) {
  const now = o.now ?? Date.now;
  const log = o.log ?? { warn() {} };
  const ttl = o.pendingTtlMs ?? 5 * 60_000;
  const epoch = o.epoch ?? randomBytes(4).toString('hex');   // ids are unique per Host start; framework-main treats them as opaque
  let remote = new Set();      // what framework-main last said (kept while the app is unreachable)
  const pending = [];          // our writes it has not acked: {id, threadId, unread, at}, in the order sent
  let view = new Set();        // remote with the pending writes on top: what every reader here sees
  let available = false;
  let accountEpoch = null;     // the account epoch of the last report that had a session
  let seq = 0;
  let disposed = false;
  const changeFns = new Set(), availFns = new Set();

  const fire = (fns, arg) => {
    for (const fn of [...fns]) { try { fn(arg); } catch (e) { log.warn('read state: a listener failed', { message: String(e?.message ?? e) }); } }
  };
  /** The pending writes that have waited too long are forgotten: what they did to the view reverts, as a sync (nobody read or unread anything). */
  function expire() {
    const t = now();
    let n = 0;
    while (n < pending.length && t - pending[n].at > ttl) n++;
    if (n) { pending.splice(0, n); commit(overlay(), 'sync'); }
  }
  function overlay() {
    const next = new Set(remote);
    for (const p of pending) { if (p.unread) next.add(p.threadId); else next.delete(p.threadId); }
    return next;
  }
  /** Make `next` the view and announce what differs, in the order of the thread ids. */
  function commit(next, origin) {
    const prev = view;
    view = next;
    const changed = [];
    for (const id of next) if (!prev.has(id)) changed.push([id, true]);
    for (const id of prev) if (!next.has(id)) changed.push([id, false]);
    changed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [threadId, unread] of changed) fire(changeFns, { threadId, unread, origin });
  }

  return {
    /** Whether framework-main has a session with the app. While it has not, `set` is only a request that waits in its queue. */
    get available() { return available; },
    has: (threadId) => view.has(threadId),
    ids: () => [...view].sort(),
    /**
     * Mark a thread unread or read in the app. True when this changed what the store holds (and so was sent); false when it already held that.
     * @param {string} threadId a protocol thread id
     */
    set(threadId, unread) {
      if (disposed || typeof threadId !== 'string' || !threadId) return false;
      const want = unread === true;
      expire();
      if (view.has(threadId) === want) return false;
      const id = `${epoch}-${++seq}`;
      pending.push({ id, threadId, unread: want, at: now(), epoch: accountEpoch });
      if (want) view.add(threadId); else view.delete(threadId);
      fire(changeFns, { threadId, unread: want, origin: 'framework' });
      try { o.send?.({ type: 'read-state-set', id, threadId, unread: want, epoch: accountEpoch }); } catch (e) { log.warn('read state: the write could not be sent', { message: String(e?.message ?? e) }); }
      return true;
    },
    /** framework-main's `read-state` message. */
    apply(msg) {
      if (disposed || !msg || typeof msg !== 'object') return;
      const was = available;
      available = msg.available === true;
      if (typeof msg.ack === 'string') {
        const i = pending.findIndex((p) => p.id === msg.ack);
        if (i >= 0) pending.splice(0, i + 1);
      }
      // What dropped writes did reverts first, as a sync (nobody read or unread anything), before the report's own differences.
      const before = pending.length;
      if (Array.isArray(msg.dropped) && msg.dropped.length) {
        const gone = new Set(msg.dropped);
        for (let i = pending.length - 1; i >= 0; i--) if (gone.has(pending[i].id)) pending.splice(i, 1);
      }
      // Another account's session: the writes made for the previous one are dropped there, so they stop counting here at once.
      if (available && typeof msg.epoch === 'string' && msg.epoch !== accountEpoch) {
        accountEpoch = msg.epoch;
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].epoch !== null && pending[i].epoch !== accountEpoch) pending.splice(i, 1);
      }
      if (pending.length !== before) commit(overlay(), 'sync');
      expire();
      if (available) remote = new Set((Array.isArray(msg.unread) ? msg.unread : []).filter((x) => typeof x === 'string' && x));
      commit(overlay(), msg.reset === true || !was || !available ? 'sync' : 'app');
      if (was !== available) fire(availFns, available);
    },
    /** @param {(c: ReadStateChange) => void} fn  Called for every change of what the store holds. */
    onChange(fn) { changeFns.add(fn); return { dispose() { changeFns.delete(fn); } }; },
    /** @param {(available: boolean) => void} fn */
    onAvailability(fn) { availFns.add(fn); return { dispose() { availFns.delete(fn); } }; },
    /** The writes not acked yet (for tests and diagnostics). */
    get pending() { return pending.map((p) => ({ id: p.id, threadId: p.threadId, unread: p.unread, epoch: p.epoch })); },
    dispose() { disposed = true; changeFns.clear(); availFns.clear(); },
  };
}
