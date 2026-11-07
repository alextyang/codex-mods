// Anchor resolution (ARCHITECTURE §9.2): adapter locators → live elements. DOM access only through Dom.
import { CodexModsError } from '../../sdk/errors.mjs';

export const ANCHOR_NAMES = Object.freeze(['settings.section', 'sidebar', 'workspace']);

/**
 * @param {{ dom: import('./dom.mjs').Dom, anchors: Record<string, { selectors: string[], placement: 'inside'|'before'|'after' }>, log?: (m: string, d?: object) => void }} deps
 */
export function createAnchors({ dom, anchors = {}, log = () => {} }) {
  const warned = new Set();
  return {
    names: () => ANCHOR_NAMES.slice(),
    /** True if the adapter pack has a locator for the anchor (not whether it is on screen right now). */
    defined: (name) => !!anchors[name]?.selectors?.length,
    /**
     * The element the anchor names now -> { element, placement, selector }, else null: in adapter order the first one shown (the app keeps
     * other pages' columns mounted, out of sight), else the first that matches. A selector the engine rejects is skipped once-logged.
     */
    resolve(name) {
      const loc = anchors[name];
      if (!loc) return null;
      let first = null;
      for (const selector of loc.selectors) {
        let all;
        try { all = dom.queryAll(selector); } catch (e) {
          if (!warned.has(selector)) { warned.add(selector); log('invalid anchor selector', { anchor: name, selector, error: String(e?.message ?? e) }); }
          continue;
        }
        const shown = all.find((n) => dom.isShown(n));
        if (shown) return { element: shown, placement: loc.placement, selector };
        if (!first && all[0]) first = { element: all[0], placement: loc.placement, selector };
      }
      return first;
    },
    placementFor(name, position) {
      const loc = anchors[name];
      const p = position ?? ({ inside: 'append', before: 'before', after: 'after' })[loc?.placement ?? 'inside'];
      if (!['append', 'prepend', 'before', 'after'].includes(p)) throw new CodexModsError('Invalid', `unknown mount position: ${String(p)}`);
      return p;
    },
  };
}
