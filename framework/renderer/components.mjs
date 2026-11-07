// ui.components (ARCHITECTURE §9.2): the app's real components where the adapter exposes them, themed fallbacks otherwise, and the kit (present/kit), which is the framework's own.
// Resolution is lazy and live: the app's chunks load after the runtime, so a getter asks again on every access and the
// real component wins as soon as it exists. Compound parts (Menu.Item, Dialog.Footer, …) come from the `MenuParts`/`DialogParts` exports keys.
import { createFallbacks } from './fallbacks.mjs';
import { createKit, KIT_NAMES } from './present/kit/index.mjs';
import { createLentParts, LENT_NAMES } from './present/lent/index.mjs';

export const COMPONENT_NAMES = Object.freeze(['Button', 'Switch', 'TextField', 'Menu', 'Dialog', 'SettingsSection', 'SettingsCard', 'SettingsRow', 'Tooltip', 'Icon', ...KIT_NAMES, ...LENT_NAMES]);
const PARTS = { Menu: 'MenuParts', Dialog: 'DialogParts' };

/**
 * @param {{ getExport: (key: string) => unknown, adapter: { components?: Record<string,string> }, react: () => unknown, themeMap?: Record<string,string>, drops?: () => object | null }} deps
 *   getExport reads globalThis.__codexmods.exports[key] and may throw (an init that failed) — treated as absent. `drops`: the page
 *   runtime's places that take drops, once it runs (the lent DropTarget and ChatRow's drag, graph-integrity G5.3).
 */
export function createComponents({ getExport, adapter, react, themeMap, drops }) {
  let fallbacks = null;
  let fallbacksReact = null;
  const fb = () => {
    const R = react();
    if (!R) return null;
    if (!fallbacks || fallbacksReact !== R) { fallbacks = createFallbacks(R, themeMap); fallbacksReact = R; }
    return fallbacks;
  };
  const safeGet = (key) => { try { return getExport(key); } catch { return undefined; } };
  const wrapped = new Map();

  /** The real component for a name, with compound parts attached, or undefined. */
  function real(name) {
    // The exports key the pack names, else the component's own name: the page seams' exposure blocks define them so (V10).
    const key = adapter.components?.[name] ?? name;
    const c = safeGet(key);
    if (c == null || (typeof c !== 'function' && typeof c !== 'object')) return undefined;
    const partsKey = PARTS[name];
    const parts = partsKey ? safeGet(partsKey) : undefined;
    if (!parts || typeof parts !== 'object' || typeof c !== 'function') return c;
    // Attach parts to a per-component wrapper so the app's function is never mutated.
    const cached = wrapped.get(name);
    if (cached && cached.c === c && cached.parts === parts) return cached.w;
    const w = (props) => c(props);
    Object.defineProperty(w, 'name', { value: name });
    const target = Object.assign(Object.create(null), parts);
    // A wrapper function would break React hooks inside `c` only if called as a function by us; React calls `w`, and `w` calls `c`
    // in the same render, so hooks run inside w's fiber. Parts are plain static members.
    Object.assign(w, target);
    wrapped.set(name, { c, parts, w });
    return w;
  }

  // the kit draws through the app's pieces where it has them, asked again each time, as the chunks arrive late
  const kit = createKit({ react, parts: () => { const items = safeGet('MenuParts'); return { Button: real('Button'), Menu: real('Menu'), MenuItem: items?.Item, Separator: items?.Separator }; } });
  // the parts the framework lends (graph-integrity G2.3): the app's conversation pieces with stable props, through its own where exposed
  const lent = createLentParts({ react, kit, exports: () => ({ ComposerDropdown: safeGet('ComposerDropdown'), MenuParts: safeGet('MenuParts') }), drops: () => drops?.() ?? null });
  const api = {};
  for (const name of COMPONENT_NAMES) {
    Object.defineProperty(api, name, { enumerable: true, get: () => (LENT_NAMES.includes(name) ? lent[name] : KIT_NAMES.includes(name) ? kit[name] : real(name) ?? fb()?.[name]) });
  }
  return {
    /** Record<ComponentName, component>; each property resolves on access. */
    components: api,
    /** The kit itself, for the framework's own pages. */
    kit,
    /** True if the adapter exposes the real component and it resolves right now (the probe's `component:<Name>`). */
    isReal: (name) => KIT_NAMES.includes(name) || LENT_NAMES.includes(name) || real(name) !== undefined,
    /** Fallback set (for safe re-render). */
    fallbacks: () => fb(),
  };
}
