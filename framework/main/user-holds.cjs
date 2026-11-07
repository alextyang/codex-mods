'use strict';
// The user's own actions, and the app's own notifications, held in framework-main before they happen (docs/design/public-hooks.md §3.5):
// one helper the areas that hold share. The Host says which operations something holds now (`held`: an interceptor or a policy would see
// them) and which a mod only observes (`observed`: its `after`, §3.4), each as `Type.operation`. An operation neither holds nor observes
// runs exactly as before: the app's own call, at once, its return kept. A held one asks the Host first and reports what it did once it
// went (the mods' `after` records say what happened, not what was allowed); an observed one goes at once and is reported after.

// longer than any decision the Host makes (a policy that asks waits five minutes for the user): a held action is refused when the Host
// never answers, never let through undecided
const HOLD_MS = 6 * 60_000;
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** What a call of the app's own did: its promise settled, or its value. */
async function outcomeOf(r) {
  try { await r; return { status: 'done' }; } catch (e) { return { status: 'failed', error: { message: String((e && e.message) || e) } }; }
}

/** @param {{ send: (msg: object) => void, holdMs?: number }} o  `holdMs`: how long an act on a mod's automation is waited for (tests) */
function createUserHolds({ send, holdMs = HOLD_MS }) {
  let held = new Set(), observed = new Set();
  let away = false;   // the Host went and has not said what it holds since: an act on a mod's is refused at once
  const waiting = new Map();   // requestId -> resolve
  let seq = 0;
  const post = (msg) => { try { send(msg); return true; } catch { return false; } };
  return {
    /** The Host's `user-holds`: what it holds and what it observes now. */
    set(msg) { away = false; held = new Set(list(msg && msg.held)); observed = new Set(list(msg && msg.observed)); },
    held: (key) => held.has(key),
    observed: (key) => observed.has(key),
    /** The Host's answer to a hold (`user-hold-answer`); an answer to nothing is ignored. */
    answer(msg) { const done = msg && waiting.get(msg.requestId); if (done) { waiting.delete(msg.requestId); done(msg); } },
    /** The Host went: nothing it ran holds anything now, and what waited on it goes on (its mods, and their policies, went with it). */
    hostGone() {
      away = true;
      held = new Set(); observed = new Set();
      for (const [id, done] of [...waiting]) { waiting.delete(id); done({ go: true, gone: true }); }
    },
    /**
     * Ask the Host about one held action: `{go: true, args, changedBy?, requestId}` (go, with the arguments as they ended), `{go: false,
     * message}` (refused: not done), `{go: false, handled: true}` (a mod did it in the app's place). `changes: false`: a change of its
     * arguments cannot be shown where the user made it, so the Host refuses one.
     */
    ask({ prefix, ref, operation, args, origin, changes = true, signal = null }) {
      const requestId = `${prefix}-${process.pid}-${++seq}`;
      return new Promise((resolve) => {
        // given up: refused here, and the Host is told, so nothing more of it is done there either
        const giveUp = (message) => { waiting.delete(requestId); post({ type: 'user-hold-cancel', requestId }); resolve({ go: false, message, cancelled: true, requestId }); };
        const t = setTimeout(() => giveUp('the framework did not decide in time'), HOLD_MS);
        if (t.unref) t.unref();
        // the app's own call given up while it waits (a git handle disposed): so is its hold (built review H6m2a)
        const onAbort = () => { if (waiting.has(requestId)) { clearTimeout(t); giveUp('cancelled'); } };
        if (signal && typeof signal.addEventListener === 'function') { if (signal.aborted) { queueMicrotask(onAbort); } else signal.addEventListener('abort', onAbort, { once: true }); }
        waiting.set(requestId, (a) => { clearTimeout(t); if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); resolve({ ...a, requestId }); });
        if (!post({ type: 'user-hold', requestId, ref, operation, args, ...(origin ? { origin } : {}), ...(changes ? {} : { changes: false }) })) {
          waiting.delete(requestId); clearTimeout(t); resolve({ go: true, requestId, unsent: true });
        }
      });
    },
    /**
     * The user's act on a mod's Automation (H7pa: `update` with the app's item, `delete`, `runNow`): its
     * provider's operation, done by the Host: `{handled: true, value}`, or `{go: false, message, uncertain?}` (`uncertain`: it may have
     * been done, as when it was under way and no answer came in time). Never the app's own call: the Host gone is a refusal.
     */
    act({ operation, id, item }) {
      const requestId = `act-${process.pid}-${++seq}`;
      if (away) return Promise.resolve({ go: false, message: 'the framework is not running', requestId });
      return new Promise((resolve) => {
        // given up: the Host is told, so what has not started of it never does (built review H7pa round 1); what has may still be done,
        // so it is not answered as refused (round 2)
        const t = setTimeout(() => { waiting.delete(requestId); post({ type: 'provided-act-cancel', requestId }); resolve({ go: false, uncertain: true, message: 'the framework did not answer in time', requestId }); }, holdMs);
        if (t.unref) t.unref();
        waiting.set(requestId, (a) => { clearTimeout(t); resolve(a && a.gone ? { go: false, uncertain: true, message: 'the framework went before it answered', requestId } : { ...a, requestId }); });
        if (!post({ type: 'provided-act', requestId, operation, ...(id !== undefined ? { id } : {}), ...(item ? { item } : {}) })) {
          waiting.delete(requestId); clearTimeout(t); resolve({ go: false, message: 'the framework is not running', requestId });
        }
      });
    },
    /** What a held action did once it went (`outcomeOf` its call): the Host completes its record. */
    done(requestId, outcome) { post({ type: 'user-hold-done', requestId, outcome }); },
    /** An action nothing held went while a mod observes it: what it did. */
    did({ ref, operation, args, origin, outcome }) { post({ type: 'user-did', ref, operation, args, ...(origin ? { origin } : {}), outcome }); },
  };
}

// one per framework-main (its hooks): every area that holds shares the Host's answers and its word on what is held
const shared = new WeakMap();
function userHoldsOf(hooks) {
  let h = shared.get(hooks);
  if (h) return h;
  h = createUserHolds({ send: (msg) => hooks.sendToHost(msg) });
  shared.set(hooks, h);
  const holds = h;
  hooks.onHostMessage?.('user-holds', (msg) => holds.set(msg));
  hooks.onHostMessage?.('user-hold-answer', (msg) => holds.answer(msg));
  hooks.onHostState?.((up) => { if (!up) holds.hostGone(); });
  return h;
}

module.exports = { createUserHolds, userHoldsOf, outcomeOf, HOLD_MS };
