// A switch for each of the mods' layouts, regions and pages, and the user's default layout (docs/design/layouts.md D9): the user's own, per app, kept in the page's
// storage as a region's width is, and followed by every window of the app (the storage event). A thing switched off is not offered: a layout cannot be picked,
// a region is not drawn, a page says it is off. NO NODE API.

const OFF_KEY = 'codexmods:layouts-off';
const DEFAULT_KEY = 'codexmods:layout-default';
const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const readOff = () => { try { const v = JSON.parse(storage()?.getItem?.(OFF_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); } };

/**
 * @param {{ changed?: () => void }} o  `changed`: a switch or the default moved, here or in another window
 */
export function createLayoutSwitches(o = {}) {
  let off = readOff();
  const onStorage = (e) => { if (e?.key === OFF_KEY || e?.key === DEFAULT_KEY) { off = readOff(); o.changed?.(); } };
  globalThis.addEventListener?.('storage', onStorage);
  return {
    /** Is this `layout:<mod>/<id>`, `region:<mod>/<id>` or `page:<mod>/<id>` switched off? */
    isOff: (kind, key) => off.has(`${kind}:${key}`),
    set(kind, key, isOff) {
      const k = `${kind}:${key}`;
      if (isOff) off.add(k); else off.delete(k);
      try { storage()?.setItem?.(OFF_KEY, JSON.stringify([...off])); } catch { /* the page's storage is unavailable: this window's alone */ }
      o.changed?.();
    },
    /** The layout a window starts with, `<mod>/<id>`, or null. */
    defaultLayout() { try { const v = storage()?.getItem?.(DEFAULT_KEY); return typeof v === 'string' && v ? v : null; } catch { return null; } },
    setDefault(key) {
      try { if (key) storage()?.setItem?.(DEFAULT_KEY, key); else storage()?.removeItem?.(DEFAULT_KEY); } catch { /* as above */ }
      o.changed?.();
    },
    dispose() { globalThis.removeEventListener?.('storage', onStorage); },
  };
}
