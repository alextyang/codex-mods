// ui.mount (ARCHITECTURE §9.2): React portals into the app's own tree at named anchors.
// One shared MutationObserver per window drives reconcile(): an anchor that disappears unmounts its contributions and
// marks them degraded; one that reappears remounts them. Attribution is by modId end to end.
import { CodexModsError } from '../../sdk/errors.mjs';

/**
 * @param {{ dom: import('./dom.mjs').Dom, anchors: ReturnType<import('./anchors.mjs').createAnchors>, hostRoot: ReturnType<import('./host-root.mjs').createHostRoot> | (() => any),
 *           report?: (kind: 'mounted'|'degraded', modId: string, anchor: string) => void, onChange?: () => void, debounceMs?: number, log?: Function }} deps
 */
/**
 * Layout of the mount container per anchor. The default container is `display:contents` (it adds no box of its own). `settings.section` appends into the sections
 * container of the Settings page, whose layout belongs to the app (flex or grid, differs per page); a `display:contents` child there becomes a flex/grid item of that
 * container and gets squeezed into a narrow column. The container is therefore an ordinary full-width block that cannot shrink below its content (`min-width:0`),
 * spans every grid column and ignores the parent's flex direction.
 */
export const CONTAINER_STYLE = Object.freeze({
  'settings.section': 'display:block;width:100%;min-width:0;max-width:100%;box-sizing:border-box;grid-column:1/-1',
});
const DEFAULT_CONTAINER_STYLE = 'display:contents';

export function createMountManager({ dom, anchors, hostRoot, report = () => {}, onChange = () => {}, debounceMs = 16, log = () => {} }) {
  const mounts = new Map();         // id → record
  let seq = 0;
  let stopObserver = null;
  let cancelTimer = null;
  let disposed = false;
  const host = () => (typeof hostRoot === 'function' ? hostRoot() : hostRoot);

  function setState(m, next) {
    if (m.state === next) return;
    m.state = next;
    try { report(next, m.modId, m.anchor); } catch (e) { log('report failed', { error: String(e?.message ?? e) }); }
    onChange();
  }

  function detach(m) {
    if (m.container) dom.remove(m.container);
    m.anchorEl = null;
  }

  function reconcile() {
    if (disposed) return;
    const h = host();
    h?.ensureAttached?.();
    for (const m of mounts.values()) {
      const hit = anchors.resolve(m.anchor);
      if (!hit) { detach(m); setState(m, 'degraded'); continue; }
      const position = anchors.placementFor(m.anchor, m.position ?? undefined);
      // `placementFor` maps a locator placement to a position only when the mod gave none.
      const ok = m.container && dom.isConnected(m.container) && m.anchorEl === hit.element && dom.isPlaced(position, m.container, hit.element);
      if (!ok) {
        if (m.container) dom.remove(m.container);
        m.container ??= dom.createElement('div', { 'data-codexmods-mount': m.modId, 'data-codexmods-anchor': m.anchor, style: CONTAINER_STYLE[m.anchor] ?? DEFAULT_CONTAINER_STYLE });
        dom.insert(hit.element, m.container, position);
        m.anchorEl = hit.element;
      }
      setState(m, 'mounted');
    }
    h?.setMounts?.([...mounts.values()].filter((m) => m.state === 'mounted').map((m) => ({ id: m.id, modId: m.modId, component: m.component, props: m.props, container: m.container })));
  }

  function schedule() {
    if (cancelTimer || disposed) return;
    cancelTimer = dom.schedule(() => { cancelTimer = null; reconcile(); }, debounceMs);
  }

  function ensureObserver() { if (!stopObserver) stopObserver = dom.observeTree(schedule); }

  return {
    /** @returns {{ dispose(): void, readonly degraded: boolean }} */
    mount(modId, anchor, component, opts = {}) {
      if (!anchors.names().includes(anchor)) throw new CodexModsError('Invalid', `unknown anchor "${anchor}"`);
      if (typeof component !== 'function' && (typeof component !== 'object' || component === null)) throw new CodexModsError('Invalid', 'mount needs a React component');
      anchors.placementFor(anchor, opts.position);                  // validates opts.position (Invalid)
      const m = { id: ++seq, modId, anchor, component, props: opts.props, position: opts.position ?? null, state: 'new', container: null, anchorEl: null };
      mounts.set(m.id, m);
      ensureObserver();
      reconcile();
      return {
        dispose() { if (mounts.delete(m.id)) { detach(m); m.container = null; host()?.setMounts?.([...mounts.values()].filter((x) => x.state === 'mounted').map((x) => ({ id: x.id, modId: x.modId, component: x.component, props: x.props, container: x.container }))); onChange(); } },
        get degraded() { return m.state !== 'mounted'; },
      };
    },
    /** Remove every contribution of a mod (mod unload). */
    disposeMod(modId) {
      for (const [id, m] of [...mounts]) if (m.modId === modId) { mounts.delete(id); detach(m); }
      reconcile();
    },
    reconcile,
    /** [{modId, anchor, state}] */
    snapshot: () => [...mounts.values()].map((m) => ({ modId: m.modId, anchor: m.anchor, state: m.state })),
    count: () => mounts.size,
    dispose() { disposed = true; stopObserver?.(); stopObserver = null; cancelTimer?.(); cancelTimer = null; for (const m of mounts.values()) detach(m); mounts.clear(); },
  };
}
