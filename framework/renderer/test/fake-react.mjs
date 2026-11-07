// A minimal synchronous stand-in for React + ReactDOM, enough to exercise the renderer runtime's UI code in plain Node:
// function and class components (with getDerivedStateFromError / componentDidCatch), fragments, portals, createRoot, and the
// hooks the runtime uses. It renders to a plain host tree: { type, props, children } | string, which tests inspect with
// textOf / findAll. It does not diff: every state change re-renders the whole root (hook state is keyed by tree path).

const PORTAL = Symbol('portal');
const FRAGMENT = Symbol('fragment');
const MEMO = Symbol('memo');

export function createFakeReact() {
  let current = null;          // instance being rendered {hooks, i, path, root}
  const roots = [];

  class Component { constructor(props) { this.props = props; this.state = {}; } setState(s) { const inst = this.__inst; inst.state = { ...inst.state, ...(typeof s === 'function' ? s(inst.state, inst.props) : s) }; this.state = inst.state; inst.root.rerender(); } }
  Component.prototype.isReactComponent = true;

  const createElement = (type, props, ...children) => {
    const p = { ...(props ?? {}) };
    if (children.length) p.children = children.length === 1 ? children[0] : children;
    return { $$typeof: 'element', type, props: p, key: p.key ?? null };
  };
  const isElement = (x) => x && typeof x === 'object' && x.$$typeof === 'element';

  function hook(init) {
    const inst = current;
    if (!inst) throw new Error('hook called outside render');
    const i = inst.i++;
    if (!(i in inst.hooks)) inst.hooks[i] = init();
    return inst.hooks[i];
  }

  const React = {
    version: '19.2.7', Fragment: FRAGMENT, Component, createElement, isValidElement: isElement,
    // React's: the element's props merged with the given ones, and the given children (when any) in place of its own
    cloneElement: (el, props, ...children) => ({ ...el, props: { ...el.props, ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }, key: props?.key ?? el.key }),
    memo: (type) => ({ $$typeof: MEMO, type }),
    // A context's Provider renders its children with its value on the context's stack (rendering is synchronous and depth first);
    // reading one gives the nearest Provider's value, or the default.
    createContext(value) { const c = { _default: value, _stack: [] }; const Provider = ({ children }) => children ?? null; Provider._ctx = c; c.Provider = Provider; return c; },
    useContext(c) { return c ? (c._stack?.length ? c._stack[c._stack.length - 1] : c._default) : undefined; },
    useState(initial) { const cell = hook(() => ({ v: typeof initial === 'function' ? initial() : initial })); const inst = current;
      return [cell.v, (n) => { const nv = typeof n === 'function' ? n(cell.v) : n; if (!Object.is(nv, cell.v)) { cell.v = nv; inst.root.rerender(); } }]; },
    useRef(initial) { return hook(() => ({ current: initial })); },
    useMemo(fn, deps) { const cell = hook(() => ({ deps: null, v: undefined })); if (!cell.deps || !deps || deps.some((d, i) => !Object.is(d, cell.deps[i]))) { cell.v = fn(); cell.deps = deps; } return cell.v; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useId() { return hook(() => `:r${current.path}:`); },
    useEffect(fn, deps) { const cell = hook(() => ({ deps: null, cleanup: null })); const inst = current;
      if (!cell.deps || !deps || deps.some((d, i) => !Object.is(d, cell.deps[i]))) { cell.deps = deps; inst.root.effects.push(() => { cell.cleanup?.(); cell.cleanup = fn() ?? null; }); }
      inst.cells ??= []; if (!inst.cells.includes(cell)) inst.cells.push(cell); },
    useSyncExternalStore(subscribe, getSnapshot) { const inst = current; const cell = hook(() => ({ unsub: null }));
      if (!cell.unsub) { inst.root.effects.push(() => { if (!cell.unsub) cell.unsub = subscribe(() => inst.root.rerender()); }); inst.cells ??= []; inst.cells.push({ get cleanup() { return cell.unsub; }, set cleanup(v) {} , dispose() { cell.unsub?.(); } }); }
      return getSnapshot(); },
  };
  React.useLayoutEffect = React.useEffect;

  function renderNode(node, path, root, seen) {
    if (node == null || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((n, i) => renderNode(n, `${path}.${n && n.key != null ? `k${n.key}` : i}`, root, seen)).flat().filter((x) => x !== null);
    if (node.$$typeof === PORTAL) {
      const tree = renderNode(node.children, `${path}.p`, root, seen);
      root.portals.set(node.container, tree);
      root.livePortals.add(node.container);
      return null;
    }
    if (!isElement(node)) return null;
    const { type, props } = node;
    const kids = (c) => (c == null ? c : Array.isArray(c) ? c : [c]);
    if (type === FRAGMENT) return renderNode(kids(props.children), `${path}${node.key != null ? `#${node.key}` : ''}`, root, seen);
    if (type && typeof type === 'object' && type.$$typeof === MEMO) return renderNode({ ...node, type: type.type }, path, root, seen);
    if (typeof type === 'string') return { type, props: { ...props, children: undefined }, children: [renderNode(kids(props.children), `${path}/${type}`, root, seen)].flat().filter((x) => x !== null) };
    const key = `${path}/${type.name || 'anon'}${node.key ? `#${node.key}` : ''}`;
    let inst = root.instances.get(key);
    if (!inst || inst.type !== type) { inst = { type, hooks: [], i: 0, path: key, root, state: undefined }; root.instances.set(key, inst); }
    seen.add(key);
    inst.props = props;
    if (type.prototype?.isReactComponent) {
      if (!inst.obj) { inst.obj = new type(props); inst.obj.__inst = inst; inst.state = inst.obj.state; }
      inst.obj.props = props; inst.obj.state = inst.state;
      const attempt = () => renderNode(inst.obj.render(), key, root, seen);
      try { return attempt(); } catch (err) {
        if (typeof type.getDerivedStateFromError !== 'function') throw err;
        inst.state = { ...inst.state, ...type.getDerivedStateFromError(err) }; inst.obj.state = inst.state;
        inst.obj.componentDidCatch?.(err, { componentStack: key });
        return attempt();
      }
    }
    const prev = current; current = inst; inst.i = 0;
    const ctx = type._ctx;
    if (ctx) ctx._stack.push(props.value);
    try { return renderNode(type(props), key, root, seen); } finally { current = prev; if (ctx) ctx._stack.pop(); }
  }

  const ReactDOM = {
    createPortal: (children, container, key) => ({ $$typeof: PORTAL, children, container, key: key ?? null }),
    createRoot(container) {
      const root = {
        container, element: null, tree: null, portals: new Map(), livePortals: new Set(), instances: new Map(), effects: [], rendering: false, again: false, unmounted: false,
        rerender() {
          if (root.unmounted) return;
          if (root.rendering) { root.again = true; return; }
          root.rendering = true;
          try {
            do {
              root.again = false; root.livePortals = new Set(); root.effects = [];
              const seen = new Set();
              root.tree = renderNode(root.element, 'root', root, seen);
              for (const [k, inst] of [...root.instances]) if (!seen.has(k)) { for (const c of inst.cells ?? []) { if (c.dispose) c.dispose(); else c.cleanup?.(); } root.instances.delete(k); }
              for (const c of [...root.portals.keys()]) if (!root.livePortals.has(c)) root.portals.delete(c);
              for (const e of root.effects) e();
            } while (root.again);
          } finally { root.rendering = false; }
        },
        render(el) { root.element = el; root.rerender(); },
        unmount() { root.element = null; root.rerender(); root.unmounted = true; },
        /** every host tree of this root: the main tree and each portal's */
        trees() { return [root.tree, ...root.portals.values()]; },
      };
      roots.push(root);
      return root;
    },
  };
  return { React, ReactDOM, roots };
}

export const hostNodes = (tree) => (tree == null ? [] : Array.isArray(tree) ? tree.flatMap(hostNodes) : typeof tree === 'string' ? [] : [tree, ...tree.children.flatMap(hostNodes)]);
export const textOf = (tree) => (tree == null ? '' : Array.isArray(tree) ? tree.map(textOf).join('') : typeof tree === 'string' ? tree : tree.children.map(textOf).join(''));
export const findAll = (tree, pred) => hostNodes(tree).filter(pred);
export const rootText = (root) => root.trees().map(textOf).join('');
