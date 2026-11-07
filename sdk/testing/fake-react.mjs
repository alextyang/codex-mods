// A tiny synchronous React stand-in for tests: elements, function components, useState/useEffect/useRef/useMemo/
// useCallback/useReducer, and a query API over the resolved host-element tree. It is not React; it only has to be
// faithful enough that mod renderer code written against `ctx.ui.react` runs and can be inspected.
const FRAGMENT = Symbol.for('codexmods.fake.fragment');
const flat = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false && x !== true);

export function createFakeReact() {
  let current = null; // the instance being rendered
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      const p = props ?? {};
      const kids = children.length ? flat(children) : (p.children === undefined ? [] : flat([p.children]));
      return { $$typeof: 'fake.element', type, props: p, key: p.key ?? null, children: kids };
    },
    isValidElement: (x) => Boolean(x && x.$$typeof === 'fake.element'),
    useState(initial) {
      const inst = current; const i = inst.hookIndex++;
      if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const h = inst.hooks[i];
      return [h.value, (next) => {
        const v = typeof next === 'function' ? next(h.value) : next;
        if (Object.is(v, h.value)) return;
        h.value = v; inst.root.schedule();
      }];
    },
    useReducer(reducer, initial) {
      const [state, set] = React.useState(initial);
      return [state, (action) => set((s) => reducer(s, action))];
    },
    useRef(initial) {
      const inst = current; const i = inst.hookIndex++;
      if (!(i in inst.hooks)) inst.hooks[i] = { ref: { current: initial } };
      return inst.hooks[i].ref;
    },
    useMemo(fn, deps) {
      const inst = current; const i = inst.hookIndex++;
      const h = inst.hooks[i];
      if (!h || depsChanged(h.deps, deps)) inst.hooks[i] = { deps, value: fn() };
      return inst.hooks[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const inst = current; const i = inst.hookIndex++;
      const h = inst.hooks[i] ?? (inst.hooks[i] = { deps: undefined, cleanup: undefined, pending: false });
      if (deps === undefined || depsChanged(h.deps, deps)) {
        h.deps = deps; h.pending = true; h.fn = fn;
        inst.root.effects.push(h);
      }
    },
  };
  React.useLayoutEffect = React.useEffect;

  function createRoot() {
    const root = {
      instances: new Map(), effects: [], scheduled: false, tree: null, element: null, unmounted: false, renders: 0,
      schedule() {
        if (root.scheduled || root.unmounted) return;
        root.scheduled = true;
        queueMicrotask(() => { root.scheduled = false; if (!root.unmounted) root.render(); });
      },
      render(element = root.element) {
        root.element = element; root.renders += 1;
        const seen = new Set();
        root.tree = resolve(root, element, 'r', seen);
        for (const [path, inst] of root.instances) {
          if (!seen.has(path)) { cleanupInstance(inst); root.instances.delete(path); }
        }
        const run = root.effects.splice(0);
        for (const h of run) {
          if (!h.pending) continue;
          h.pending = false;
          try { h.cleanup?.(); } catch { /* ignore */ }
          h.cleanup = h.fn() ?? undefined;
        }
        return root.tree;
      },
      /** Let queued state updates and effects settle. */
      async settle(turns = 5) { for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r)); },
      /** Wait (real time) until pred() is true, e.g. for an async load to land. Throws on timeout with the current text. */
      async until(pred, timeoutMs = 2000) {
        const start = Date.now();
        while (!pred()) {
          if (Date.now() - start > timeoutMs) throw new Error(`until() timed out; rendered: ${root.text()}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      },
      unmount() {
        root.unmounted = true;
        for (const inst of root.instances.values()) cleanupInstance(inst);
        root.instances.clear(); root.tree = null;
      },
      // ---- queries over the resolved tree
      nodes() { const out = []; walk(root.tree, (n) => out.push(n)); return out; },
      find(pred) { return root.nodes().filter(pred); },
      text() { return textOf(root.tree).replace(/\s+/g, ' ').trim(); },
      byText(text) {
        return root.nodes().filter((n) => typeof n !== 'string' && n.type !== FRAGMENT && textOf(n).includes(text));
      },
      /** The innermost clickable node containing `text`. */
      clickTarget(text) {
        const hits = root.byText(text).filter((n) => typeof n.props.onClick === 'function');
        return hits.at(-1);
      },
      async click(text) {
        const target = root.clickTarget(text);
        if (!target) throw new Error(`no clickable node with text "${text}"`);
        await target.props.onClick({ preventDefault() {}, target, currentTarget: target });
        await root.settle();
      },
      async type(label, value) {
        const node = root.find((n) => typeof n !== 'string' && typeof n.props.onChange === 'function'
          && (n.props['aria-label'] === label || n.props.placeholder === label || n.props.name === label))[0];
        if (!node) throw new Error(`no input labelled "${label}"`);
        await node.props.onChange({ target: { value, checked: value }, currentTarget: { value } });
        await root.settle();
      },
    };
    return root;
  }

  function cleanupInstance(inst) {
    for (const h of Object.values(inst.hooks)) { try { h?.cleanup?.(); } catch { /* ignore */ } }
  }

  function resolve(root, el, path, seen) {
    if (el === null || el === undefined || el === false || el === true) return null;
    if (typeof el === 'string' || typeof el === 'number') return String(el);
    if (Array.isArray(el)) return { type: FRAGMENT, props: {}, children: flat(el).map((c, i) => resolve(root, c, `${path}.${i}`, seen)).filter((x) => x !== null) };
    if (typeof el.type === 'function') {
      const p = `${path}/${el.key ?? ''}${el.type.name || 'C'}`;
      seen.add(p);
      let inst = root.instances.get(p);
      if (!inst) { inst = { hooks: {}, hookIndex: 0, root }; root.instances.set(p, inst); }
      inst.hookIndex = 0;
      const prev = current; current = inst;
      let out;
      try { out = el.type({ ...el.props, children: el.children.length === 1 ? el.children[0] : (el.children.length ? el.children : undefined) }); }
      finally { current = prev; }
      return resolve(root, out, p, seen);
    }
    const children = el.children.map((c, i) => resolve(root, c, `${path}.${c?.key ?? i}`, seen)).filter((x) => x !== null);
    return { type: el.type, props: el.props, children };
  }

  function walk(n, fn) {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') return;
    fn(n); for (const c of n.children) walk(c, fn);
  }
  function textOf(n) {
    if (n === null || n === undefined) return '';
    if (typeof n === 'string') return n;
    return n.children.map(textOf).join(' ');
  }

  return { React, createRoot };
}
