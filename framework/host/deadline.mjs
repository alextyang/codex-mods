// Deadlines on the Host's own time (ARCHITECTURE §7.3): a stall of the Host itself (a long synchronous job, the machine asleep) is not
// counted against whoever the deadline waits for.

/** A timer that fires later than this (or than half its length, for a short one) means the Host itself stalled. */
export const HOST_STALL_MS = 1000;

/**
 * Run `onExpire` once `ms` have passed, like a timer, with two differences. It runs only after the Host has had one more turn of its
 * event loop to read what arrived meanwhile, so a reply that is queued behind the timer settles first (the caller's `stop` then cancels
 * it). And a timer that fires late, past HOST_STALL_MS or half its length, means the Host itself stalled: the time that was left starts
 * again, once, since the stall was not the waited-for party's time. `pause` and `resume` stop and restart the clock (a graph interceptor's
 * clock stops while its `next` runs).
 * @param {number} ms
 * @param {() => void} onExpire
 * @param {{ unref?: boolean }} [opts]  unref (default true): the timer alone does not keep the process running
 */
export function hostDeadline(ms, onExpire, { unref = true } = {}) {
  let left = ms, startedAt = 0, timer = null, turn = null, restarted = false, done = false;
  const arm = () => {
    startedAt = performance.now();
    const due = startedAt + left;
    timer = setTimeout(() => {
      timer = null;
      if (done) return;
      if (!restarted && performance.now() - due > Math.min(HOST_STALL_MS, ms / 2)) { restarted = true; arm(); return; }
      left = 0;
      // Not unref'd: an unref'd immediate does not keep the loop from blocking in its poll phase, so it could wait for any later event.
      turn = setImmediate(() => { turn = null; if (done) return; done = true; onExpire(); });
    }, Math.max(0, left));
    if (unref) timer.unref?.();
  };
  arm();
  return {
    pause() {
      if (done) return;
      if (timer) { clearTimeout(timer); timer = null; left = Math.max(0, left - (performance.now() - startedAt)); }
      if (turn) { clearImmediate(turn); turn = null; }
    },
    resume() { if (!done && !timer && !turn) arm(); },
    stop() { done = true; clearTimeout(timer); clearImmediate(turn); timer = turn = null; },
  };
}
