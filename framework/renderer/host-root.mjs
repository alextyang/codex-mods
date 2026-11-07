// The runtime's single React root per window. It renders (a) a portal per mounted contribution into the container the mount
// manager placed at the anchor, each inside an error boundary attributed to its mod, and (b) framework overlays (toasts,
// dialogs, palette, panes, modals). Uses the app's own React (ui.react); DOM placement itself lives in mount.mjs via Dom.

/**
 * @param {{ react: any, reactDom: any, dom: import('./dom.mjs').Dom, onFault: (modId: string, err: unknown, info?: unknown) => void }} deps
 */
export function createHostRoot({ react: React, reactDom: ReactDOM, dom, onFault }) {
  const h = React.createElement;
  let version = 0;
  const listeners = new Set();
  let mounts = [];       // [{ id, modId, component, props, container }]  only currently placed mounts
  let overlays = [];     // [{ id, modId, render(): element, renderFallback?(): element }]
  let container = null;
  let root = null;

  const bump = () => { version++; for (const l of [...listeners]) l(); };
  const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
  const snapshot = () => version;

  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) { try { this.props.onFault(this.props.modId, error, 'render', info); } catch { /* reporting must not throw */ } }
    render() { return this.state.error ? (this.props.fallback ?? null) : this.props.children; }
  }

  function Root() {
    React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const portals = mounts.map((m) => ReactDOM.createPortal(
      h(Boundary, { key: m.id, modId: m.modId, onFault }, h(m.component, m.props ?? {})), m.container, String(m.id)));
    const layers = overlays.map((o) => h(Boundary, { key: o.id, modId: o.modId ?? 'framework', onFault, fallback: o.renderFallback?.() ?? null }, o.render()));
    return h(React.Fragment, null, ...portals, ...layers);
  }

  function ensure() {
    if (!container) container = dom.createElement('div', { 'data-codexmods-root': '', style: 'display:contents' });
    if (!dom.isConnected(container)) dom.body().appendChild(container);
    if (!root) { root = ReactDOM.createRoot(container); root.render(h(Root)); }
  }

  /** An element that attributes any render fault below it to `modId` (no UI of its own on failure unless `fallback`). */
  const boundary = (modId, children, fallback = null) => h(Boundary, { modId, onFault, fallback }, children);

  return {
    boundary,
    /** Replace the placed mounts (called by the mount manager after each reconcile). */
    setMounts(next) { mounts = next; ensure(); bump(); },
    addOverlay(overlay) { overlays = [...overlays, overlay]; ensure(); bump(); return () => { overlays = overlays.filter((o) => o !== overlay); bump(); }; },
    /** Re-render overlays that read live state (palette query etc.). */
    refresh: bump,
    /** Re-attach the host container if the app replaced <body> content. Returns true if it had to. */
    ensureAttached() { if (container && !dom.isConnected(container)) { dom.body().appendChild(container); return true; } return false; },
    isOverlayOpen: (id) => overlays.some((o) => o.id === id),
    overlayCount: () => overlays.length,
    get container() { return container; },
    get root() { return root; },
    dispose() { try { root?.unmount(); } catch { /* already gone */ } if (container) dom.remove(container); mounts = []; overlays = []; root = null; container = null; },
  };
}
