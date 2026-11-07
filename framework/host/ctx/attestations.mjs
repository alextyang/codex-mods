// The user's intent a page attests for a mod (graph-integrity G7.1, G7.2): the page runtime tells the Host each attestation as it mints it
// (bound to the mod and that window, valid a few seconds); a mod's call that carries one takes it here, once: unexpired, unused, the mod's
// own, from the same page (its channel to the Host: a page that reloads or goes takes its own with it). Node built-ins only.

export const ATTEST_MS = 5000;
const TOKEN = /^att-[A-Za-z0-9]{16,64}$/;
const MAX_PER_WINDOW = 64;

/** @param {{ now?: () => number, ttlMs?: number }} [o] */
export function createAttestations({ now = Date.now, ttlMs = ATTEST_MS } = {}) {
  const byWindow = new WeakMap();   // a page's channel -> Map(token -> {mod, expires}); a reloaded page has a new channel, none of these
  const prune = (m, t) => { for (const [k, a] of m) if (a.expires <= t) m.delete(k); };
  return {
    /** The page minted one for `mod` in this window: kept until it is taken or it expires. False when it is not one. */
    mint(windowKey, token, mod) {
      if (!windowKey || typeof windowKey !== 'object' || typeof token !== 'string' || !TOKEN.test(token) || typeof mod !== 'string' || !mod) return false;
      const t = now();
      let m = byWindow.get(windowKey);
      if (!m) byWindow.set(windowKey, (m = new Map()));
      prune(m, t);
      if (m.size >= MAX_PER_WINDOW) m.delete(m.keys().next().value);
      m.set(token, { mod, expires: t + ttlMs });
      return true;
    },
    /** A call carries `token` for `mod` from this window: null when it is taken now (good), else why it is not. One use. */
    take(windowKey, token, mod) {
      const m = windowKey && typeof windowKey === 'object' ? byWindow.get(windowKey) : null;
      const a = typeof token === 'string' ? m?.get(token) : null;
      if (!a) return 'it is not one this window attested (or it was used)';
      m.delete(token);
      if (a.mod !== mod) return 'it was attested for another mod';
      if (a.expires <= now()) return 'it expired';
      return null;
    },
  };
}
