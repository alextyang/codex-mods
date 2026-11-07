// Attested user intent (graph-integrity G7.1): when a trusted input event reaches the callback of a surface the framework draws for a
// mod (a rule's action, a kit or lent part's control, an answer to its question, a SettingRow), the page mints a one-use attestation
// bound to that mod and this window, valid for a few seconds, and gives it to the callback (`asUser`). The mod passes it with a call of
// its own (`invoke(ref, op, args, {asUser})`); the Host checks it with this window (unexpired, unused, the mod's own) and runs the call as
// the user through that mod. The Host learns each attestation from the page as it is minted, ahead of any call that carries it (the same
// channel, in order).
// Only a genuine trusted input event counts, while it is being dispatched: checked with the platform's own accessors (taken when this module
// loads, before any mod), so an object that says `isTrusted` and an event kept after its dispatch count for nothing (review 2026-11-05
// #8). Honest limits: renderer mods share this page, so this is consent, not a boundary (as the permission prompts are): a mod's own
// hand-drawn DOM gets no attestation of its own, but one that calls a framework part's callback from its own handler, while the user's
// input in its surface is being dispatched, would; a host-realm call never carries one. NO NODE API.

export const ATTEST_MS = 5000;
const contexts = new WeakMap();   // React -> the context that names the mod whose content a part is drawn in
/** The platform's own accessor of an event's `isTrusted` (an event's own property, or its prototype's) and of its `eventPhase`. */
const accessor = (name) => {
  try {
    if (typeof Event !== 'function') return null;
    for (let o = new Event('codexmods'); o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, name); if (d && typeof d.get === 'function') return d.get; }
  } catch { /* no events here */ }
  return null;
};
const IS_TRUSTED = accessor('isTrusted');
const PHASE = accessor('eventPhase');
/** A genuine trusted event still being dispatched (its phase is not NONE): the platform's accessors refuse anything that is not an event. */
function dispatchingTrusted(e) {
  if (!e || typeof e !== 'object' || !IS_TRUSTED || !PHASE) return false;
  try { return IS_TRUSTED.call(e) === true && PHASE.call(e) !== 0; } catch { return false; }
}
let attestor = null;              // the page runtime's: (mod) => token | null
/**
 * The user's input being dispatched in this page, as the page saw it at capture: a component library may call a callback from a synthetic
 * event it dispatches inside the user's click (a menu's "select"), where neither the event given nor the page's current one is trusted,
 * while the user's own input is still being dispatched (reference-mods.md RM9: a mod's project menu entry). It counts only while that
 * genuine trusted input is mid-dispatch, as any other.
 */
let input = null;
export function noteInput(e) { input = e; }
const INPUTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup'];
try { if (typeof globalThis.addEventListener === 'function') for (const t of INPUTS) globalThis.addEventListener(t, noteInput, true); } catch { /* no page here */ }

/** The context naming the mod a node belongs to (provided by each mod's content boundary), per React. */
export function modContextOf(R) {
  if (!R || typeof R.createContext !== 'function') return null;
  let c = contexts.get(R);
  if (!c) contexts.set(R, (c = R.createContext(null)));
  return c;
}
/** The page runtime sets how an attestation is minted (and told to the Host); null while none runs. */
export function setAttestor(fn) { attestor = typeof fn === 'function' ? fn : null; }
/** Whether the user's own input is being dispatched now: the event given (or a React event's native one), else the page's current one. */
export function trustedNow(ev) {
  return dispatchingTrusted(ev?.nativeEvent) || dispatchingTrusted(ev) || dispatchingTrusted(globalThis.event) || dispatchingTrusted(input);
}
/** An attestation for `mod` now, when a trusted input event is being dispatched (`ev`, else the page's current one); else null. */
export function attestNow(mod, ev) {
  if (!attestor || typeof mod !== 'string' || !mod || !trustedNow(ev)) return null;
  try { return attestor(mod) ?? null; } catch { return null; }
}
const WRAPPED = Symbol('codexmods.withIntent');
/**
 * A part's callback that also gets `{asUser}` (its last argument), the mod's attestation when the user's own input called it (`mod`, or
 * `mod()`). Wrapped once: a callback a part passes on to another part is not wrapped again.
 */
export function withIntent(fn, mod) {
  if (typeof fn !== 'function' || fn[WRAPPED]) return fn;
  const w = (...args) => {
    const asUser = attestNow(typeof mod === 'function' ? mod() : mod, args.find((a) => a && typeof a === 'object' && ('isTrusted' in a || 'nativeEvent' in a)));
    return fn(...args, Object.freeze(asUser ? { asUser } : {}));
  };
  w[WRAPPED] = true;
  return w;
}
/** The mod whose content is being drawn (its boundary names it), in a component of React `R`; null outside every mod's. */
export function useModOf(R) {
  const M = modContextOf(R);
  return M && typeof R.useContext === 'function' ? R.useContext(M) : null;
}
/** A random token (the Web Crypto API where there is one). */
export function newToken() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return `att-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  return `att-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
