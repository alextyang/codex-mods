// Reactive theme tokens (ARCHITECTURE §9.2): semantic token → the app's CSS custom property, read live from <html>.
// Light/dark/accent changes arrive as attribute (data-theme, class, style) or media-query changes on <html>; no remount needed.

/**
 * @param {{ dom: import('./dom.mjs').Dom, tokens: Record<string,string>, log?: Function }} deps
 */
export function createTheme({ dom, tokens: map = {} }) {
  const listeners = new Set();
  let last = null;
  let disposers = [];

  const read = () => {
    const out = {};
    for (const [token, prop] of Object.entries(map)) out[token] = dom.cssVar(prop);
    return out;
  };
  const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
  const appearance = () => dom.rootTheme() ?? (dom.prefersDark() ? 'dark' : 'light');

  let lastAppearance = appearance();
  const check = () => {
    const now = read();
    const app = appearance();
    if (same(now, last) && app === lastAppearance) return;
    last = now; lastAppearance = app;
    for (const fn of [...listeners]) { try { fn({ ...now }); } catch { /* a listener's fault never reaches the others */ } }
  };
  const start = () => {
    if (disposers.length) return;
    last = read(); lastAppearance = appearance();
    disposers = [dom.observeRoot(check), dom.onPrefersChange(check)];
  };
  const stop = () => { for (const d of disposers) d(); disposers = []; };

  return {
    tokens: () => read(),
    onChange(fn) {
      if (disposers.length) check();   // a change not yet heard is the earlier listeners': this one hears what changes after it subscribed
      listeners.add(fn);
      start();
      return { dispose() { listeners.delete(fn); if (!listeners.size) stop(); } };
    },
    get appearance() { return appearance(); },
    /** Re-read now (used by the runtime after a mutation burst). */
    refresh: check,
    dispose() { listeners.clear(); stop(); },
  };
}
