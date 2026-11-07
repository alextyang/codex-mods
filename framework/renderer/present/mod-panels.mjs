// Mods' panel views as the app's own panel tabs (docs/design/mod-surfaces.md §3.1; a scout of 21477). One tab kind, `codexmods`, serves every mod's view; each tab's props say which (`mod`, `view`, `instance`) and carry the
// view's title and icon, so the app can persist the tab and draw its chip before the mod has loaded.
// - **Persistent, like the app's own tabs.** The kind has a durable route: the app writes it with the panel's tabs (per chat, in the
//   primary window) and restores it on the chat's next open, after a restart too; "Reopen closed tab" works. The app registers its own
//   kinds in two phases, a stub that names the kind with a `load()` its restore waits for, then the kind itself: the framework does the
//   same, the stub from the page's first moments (before any restore can run), the kind once the presentation runtime starts.
// - **Stable.** A tab never closes because its mod is not there: it shows a quiet placeholder while the mods load, the view once its
//   mod's rule is here, and "turned off" with a Close button when the mod is disabled; the user's layout is the user's.
// - **Everywhere.** The kind is available on every route that has panels, in both panels; a view narrows that with `targets`.
// The views themselves are the mods' `host` rules on SidePanel's `tabs` slot (one rule per view: its render, its title, icon and
// options), so the Host checks their grant and keeps their lifetime as every rule's. NO NODE API.

export const KIND = 'codexmods';
const VERSION = 1;               // the durable route's payload version (the framework's own version is in its params)
const STUB_LOAD_MS = 20000;      // how long a restore waits for the presentation runtime before the app keeps the tab as unrestored
const ARM_FAST = 500;            // the stub looks for the app's tab registry every 10 ms for its first ~5 s (the restore can follow the
const ARM_TRIES = 1050;          // registry within a main-process round trip), then every 100 ms up to ~60 s
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MOD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGETS = ['right', 'bottom'];

/** A tab's id: one tab per view in a panel, or one per instance. */
export const tabKeyOf = (mod, view, instance) => `${KIND}:${mod}/${view}${instance ? `:${instance}` : ''}`;
/** The params a persisted tab carries (what restore reopens it from). */
export const paramsOk = (p) => !!p && typeof p === 'object' && p.v === 1 && typeof p.mod === 'string' && MOD.test(p.mod)
  && typeof p.view === 'string' && ID.test(p.view) && (p.instance === undefined || (typeof p.instance === 'string' && ID.test(p.instance)))
  && typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 80;
const paramsOf = (p) => ({ v: 1, mod: p.mod, view: p.view, ...(p.instance ? { instance: p.instance } : {}), title: p.title, ...(typeof p.icon === 'string' ? { icon: p.icon } : {}) });

/**
 * @param {{ getExport: (key: string) => unknown, schedule?: (fn: () => void, ms: number) => unknown, log?: (m: string, d?: object) => void }} o
 */
// A framework presence record (mod-surfaces.md §3.1): where the app keeps no layout (the new chat's page, the panel page's new chat, a remote
// task), the mods' tabs a user had open are remembered in the page's storage and opened again when that page's panel is shown (after a
// restart too); a tab the user closes there is forgotten. The app's own tabs keep the app's behaviour.
const PRESENCE = 'codexmods.panels.presence.v1';
const UNPERSISTED = new Set(['home', 'new-thread-panel', 'remote-thread']);
/** The key of a page the app keeps no tabs for (null for the others: a chat's tabs are the app's to restore). */
export const presenceKeyOf = (route) => {
  if (!route || !UNPERSISTED.has(route.routeKind)) return null;
  if (route.routeKind !== 'remote-thread') return route.routeKind;
  const id = route.taskId ?? route.remoteTaskId ?? route.conversationId;
  return typeof id === 'string' && id ? `remote-thread:${id}` : null;
};

export function createModPanels(o) {
  const log = o.log ?? (() => {});
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const safe = (k) => { try { return o.getExport(k); } catch { return undefined; } };
  const storage = o.storage !== undefined ? o.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  const readPresence = () => { try { const x = JSON.parse(storage?.getItem(PRESENCE) ?? '{}'); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } };
  const writePresence = (x) => { try { storage?.setItem(PRESENCE, JSON.stringify(x)); } catch { /* the page's storage is unavailable */ } };
  const sameTab = (a, b) => a.mod === b.mod && a.view === b.view && (a.instance ?? null) === (b.instance ?? null);
  const remember = (key, tab) => {
    const all = readPresence();
    const list = (Array.isArray(all[key]) ? all[key] : []).filter((t) => t && !sameTab(t, tab));
    all[key] = [...list, tab].slice(-8);
    writePresence(all);
  };
  const forget = (key, tab) => {
    const all = readPresence();
    const list = (Array.isArray(all[key]) ? all[key] : []).filter((t) => t && !sameTab(t, tab));
    if (list.length) all[key] = list; else delete all[key];
    writePresence(all);
  };
  const restoredIn = new WeakMap();   // route scope -> `${key}|${mod}/${view}/${instance}`: reopened once per scope (a closed one is forgotten anyway)
  const views = new Map();   // `${mod}/${view}` -> { mod, view, spec, render, headerRows, rule }
  const listeners = new Set();
  let version = 0, settled = false, tabType = null, host = null, armed = false;
  let release = null;
  const realKind = new Promise((resolve) => { release = resolve; });
  const bump = () => { version++; for (const fn of [...listeners]) { try { fn(); } catch { /* a tab's own */ } } };
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getVersion = () => version;

  /** The stub, as soon as the app's registry exists: the app's restore of a mod's tab then waits for the real kind. */
  function arm() {
    if (armed) return;
    armed = true;
    let tries = 0;
    const tick = () => {
      const reg = safe('tabRegistry');
      const map = reg && reg.registry;
      if (map && typeof map.get === 'function' && typeof map.set === 'function') {
        if (!map.has(KIND)) {
          map.set(KIND, {
            kind: KIND, dropDestinations: [...TARGETS], durableRoute: { version: VERSION },
            isAvailable: () => true,
            // the restore waits for the runtime (or gives the tab to the app's "unrestored" placeholder, which keeps its route)
            load: () => Promise.race([realKind, new Promise((r) => schedule(r, STUB_LOAD_MS))]),
          });
        }
        return;
      }
      if (++tries < ARM_TRIES) schedule(tick, tries < ARM_FAST ? 10 : 100);
    };
    tick();
  }

  const viewOf = (p) => (p ? views.get(`${p.mod}/${p.view}`) ?? null : null);
  const allows = (v, target) => !v || !Array.isArray(v.spec.targets) || v.spec.targets.includes(target ?? 'right');

  /**
   * The presentation runtime started: the real kind, with its shell (`node` puts a mod's component in its rule's boundary; `react` the
   * app's React; `route` reads the route scope's value in a component).
   * @param {{ react: () => any, node: (rule: object, type: unknown, props: object) => unknown, useRoute: () => object | null,
   *   pageParts?: () => { button?: Function } }} h
   */
  function attach(h) {
    host = h;
    arm();
    let tries = 0;
    // the runtime can start before the app has evaluated its registry: wait for it, as the stub does
    const go = () => {
      if (tabType) return;
      const reg = safe('tabRegistry');
      if (reg && typeof reg.register === 'function') { register(reg); return; }
      if (++tries < ARM_TRIES) schedule(go, 100);
      else log('panel views: the app\'s tab registry is not exposed');
    };
    go();
    return true;
  }
  function register(reg) {
    try {
      tabType = reg.register(KIND, ModTab, {
        dropDestinations: [...TARGETS],   // the side and bottom panels (restore, open and close know these two)
        getId: (scope, p) => (p ? tabKeyOf(p.mod, p.view, p.instance) : undefined),
        getTitle: (scope, p) => viewOf(p)?.spec.title ?? p?.title ?? '',
        // available on every route with panels; the restore asks with no props (then always yes)
        isAvailable: () => true,
        retainWhileInactive: (get, p) => viewOf(p)?.spec.retain !== false,
        defaultState: () => ({}),
        canUndoClose: () => true,   // "Reopen closed tab" brings it back (the app calls it)
        renderThumbnail: (p) => { const R = host?.react?.(); return R ? R.createElement('span', { className: 'px-2 text-sm' }, viewOf(p)?.spec.title ?? p?.title ?? '') : null; },
        durableRoute: {
          version: VERSION,
          // `persist: false` travels with the tab, so a tab of a view whose mod is off still stays out of the saved layout
          serialize: (scope, p) => (p && p.persist !== false && paramsOk(paramsOf(p)) ? { kind: KIND, payloadVersion: VERSION, params: paramsOf(p) } : undefined),
          shouldPersist: (scope, route) => paramsOk(route?.params),
          async restore(c) {
            const p = c?.descriptor?.params;
            if (!paramsOk(p)) return false;
            if (c.isDisconnected?.()) return true;
            return openIn(c.scope, { mod: p.mod, view: p.view, instance: p.instance, title: p.title, icon: p.icon },
              { id: c.descriptor.tabId, insertPosition: c.insertPosition, target: c.target, revealAndFocus: c.revealAndFocus === true });
          },
        },
      });
    } catch (e) { log('panel views: the kind could not be registered', { message: String(e?.message ?? e) }); return; }
    release?.();
    bump();
  }

  /** Open (or focus) a tab of a view in a route scope; true when the tab is there. */
  function openIn(scope, props, opts = {}) {
    const pc = safe('panelControllers');
    if (!tabType || !pc || typeof pc.openTab !== 'function' || !scope) return false;
    const target = TARGETS.includes(opts.target) ? opts.target : 'right';
    const id = opts.id ?? tabKeyOf(props.mod, props.view, props.instance);
    pc.openTab(scope, tabType, {
      id, title: props.title, props: { ...props, target }, target,
      ...(opts.insertPosition !== undefined ? { insertPosition: opts.insertPosition } : {}),
      ...(opts.replaceTabId !== undefined ? { replaceTabId: opts.replaceTabId } : {}),
      revealAndFocus: opts.revealAndFocus !== false,
    });
    const ctl = target === 'bottom' ? pc.bottom : pc.right;
    try { return ctl && ctl.tabById$ ? scope.get(ctl.tabById$, id) != null : true; } catch { return true; }
  }

  /**
   * The mods' views as tools of the panels' launcher (the "+" menus, the New tab page, the empty panel, the omnibox): one item per view
   * the target allows, after the app's own; choosing it opens the view (or focuses its tab) in that panel, in the route `scope()` names.
   */
  function launcherItems(list, opts, scope) {
    if (!tabType || !views.size) return list;
    const target = opts && TARGETS.includes(opts.target) ? opts.target : 'right';
    const R = host?.react?.();
    const items = [];
    for (const v of views.values()) {
      if (typeof v.render !== 'function' || !allows(v, target)) continue;
      const props = { mod: v.mod, view: v.view, title: v.spec.title, ...(typeof v.spec.icon === 'string' ? { icon: v.spec.icon } : {}), ...(v.spec.persist === false ? { persist: false } : {}) };
      items.push({
        id: tabKeyOf(v.mod, v.view), title: v.spec.title, tabType, requiresCodexAccess: false, singletonTabId: tabKeyOf(v.mod, v.view),
        icon: R ? R.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
          R.createElement('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2 }), R.createElement('path', { d: 'M10 2.5v11' })) : null,
        onSelect: (replaceTabId) => openIn(scope(), props, { target, ...(typeof replaceTabId === 'string' ? { replaceTabId } : {}) }),
      });
    }
    return items.length ? [...list, ...items] : list;
  }

  /** Close a tab by its id in a route scope, in whichever panel holds it; true when one was closed. */
  function closeIn(scope, id) {
    const pc = safe('panelControllers');
    if (!pc || !scope) return false;
    for (const ctl of [pc.right, pc.bottom]) {
      try {
        if (ctl && typeof ctl.closeTab === 'function' && (!ctl.tabById$ || scope.get(ctl.tabById$, id) != null)) { ctl.closeTab(scope, id); return true; }
      } catch { /* this panel does not hold it */ }
    }
    return false;
  }

  /** Is the tab with this id in one of the panels of that route scope? */
  function hasTab(scope, id) {
    const pc = safe('panelControllers');
    if (!pc || !scope) return false;
    for (const ctl of [pc.right, pc.bottom]) { try { if (ctl && ctl.tabById$ && scope.get(ctl.tabById$, id) != null) return true; } catch { /* not this panel's */ } }
    return false;
  }
  /** Reopen the remembered mod tabs of a page the app keeps none for, in its panel `panelId` (the side panel binding asks, after its render). */
  function restore(route, panelId, scope) {
    const key = presenceKeyOf(route);
    // the scope of the panel that asked (E8 third review): never another page's, and still that route's
    if (!key || !tabType || !scope || presenceKeyOf(scope.value ?? null) !== key) return;
    let done = restoredIn.get(scope);
    if (!done) restoredIn.set(scope, (done = new Set()));
    for (const t of Array.isArray(readPresence()[key]) ? readPresence()[key] : []) {
      if (!t || (t.target ?? 'right') !== panelId) continue;
      const once = `${key}|${t.mod}/${t.view}/${t.instance ?? ''}`;
      if (done.has(once)) continue;
      const v = views.get(`${t.mod}/${t.view}`);
      // its mod not here yet: asked again on a later render; once the mods have loaded, a view no mod offers (its mod off) reopens as the
      // placeholder the tab shows (decision 7: the user's layout is the user's)
      if (!v && (!settled || typeof t.title !== 'string')) continue;
      done.add(once);
      if ((v && !allows(v, panelId)) || hasTab(scope, tabKeyOf(t.mod, t.view, t.instance))) continue;
      const props = { mod: t.mod, view: t.view, ...(t.instance ? { instance: t.instance } : {}), title: (v?.spec.title ?? t.title ?? '').slice(0, 80),
        ...(v && typeof v.spec.icon === 'string' ? { icon: v.spec.icon } : {}) };
      openIn(scope, props, { target: panelId, revealAndFocus: false });
    }
  }

  /**
   * What a view is about, as its mod may read it (a hook: drawn again as it changes): `route` the one a tab is beside, undefined for a
   * view above the route (the window's route now). A host without the hook names nothing.
   */
  const contextOf = (rule, route) => (typeof host?.useViewContext === 'function' ? host.useViewContext(rule, route)
    : Object.freeze({ thread: null, draft: null, window: null, project: null }));
  /** The shell every mod tab renders: pending, the view, or turned off; always through the panel's own `renderSlots`. */
  function ModTab(props) {
    const R = host?.react?.();
    if (!R) return null;
    R.useSyncExternalStore(subscribe, getVersion, getVersion);
    const route = host.useRoute ? host.useRoute() : null;
    // the presence record: on a page the app keeps no tabs for, this tab is remembered while open; closed there by the user, forgotten
    const presenceKey = props.persist === false ? null : presenceKeyOf(route);
    R.useEffect(() => {
      if (!presenceKey || typeof props.mod !== 'string' || typeof props.view !== 'string') return undefined;
      const tab = { mod: props.mod, view: props.view, ...(props.instance ? { instance: props.instance } : {}), target: TARGETS.includes(props.target) ? props.target : 'right',
        ...(typeof props.title === 'string' ? { title: props.title.slice(0, 80) } : {}) };
      remember(presenceKey, tab);
      return () => {
        // navigating away keeps it; the same page without the tab in its panels is a close
        const scope = typeof host?.routeScope === 'function' ? host.routeScope() : null;
        if (!scope || presenceKeyOf(scope.value ?? null) !== presenceKey) return;
        if (!hasTab(scope, props.tabId)) forget(presenceKey, tab);
      };
    }, [presenceKey, props.tabId]);
    const v = viewOf(props);
    const slots = (content, headerRows) => (typeof props.renderSlots === 'function' ? props.renderSlots({ headerRows: headerRows ?? [], content }) : content);
    // what it is about (its chat, the Draft of the composer beside it, its window, its project), as its mod may read it (built review H7j-l)
    const about = contextOf(v?.rule ?? null, route);   // a hook: called on every render, whatever the view
    // the framework's own view: no mod's rule, no mod's context
    if (v && typeof v.own === 'function') return slots(v.own(props));
    if (v && typeof v.render === 'function') {
      const ctx = Object.freeze({
        mod: props.mod, view: props.view, instance: props.instance ?? null, tabId: props.tabId, isActive: props.isActive === true,
        isVisible: props.isVisible !== false, thread: about.thread,
        // the Draft of the composer beside it: its chat's, or the new chat's on the home page (E8 review: a dashboard writes into it)
        draft: about.draft,
        // the window it is in and the project it is about (public-hooks.md §3.14): its chat's, or the one the new chat targets
        window: about.window, project: about.project,
        state: props.tabState ?? null,
        setState: typeof props.setTabState === 'function' ? props.setTabState : () => {}, close: () => props.onClose?.(),
      });
      const rows = typeof v.headerRows === 'function' ? [host.node(v.rule, v.headerRows, { key: 'rows', ...ctx })] : [];
      return slots(host.node(v.rule, v.render, { key: `${v.mod}/${v.view}`, ...ctx }), rows);
    }
    const title = props.title ?? '';
    if (!settled) return slots(R.createElement('div', { className: 'flex h-full items-center justify-center text-sm text-secondary' }, `${title}`));
    const button = host.pageParts?.()?.button;
    const act = (label, fn) => (typeof button === 'function' ? button(label, fn, false, 'secondary') : R.createElement('button', { type: 'button', onClick: fn }, label));
    // what is known: the view is not here (its mod is off, removed, failed, or no longer has the view); the mod's page says which
    return slots(R.createElement('div', { className: 'flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-secondary' },
      R.createElement('div', null, `${title} is not available.`),
      R.createElement('div', { className: 'flex gap-2' },
        typeof host.openMod === 'function' ? act('Open its mod', () => host.openMod(props.mod)) : null,
        act('Close', () => props.onClose?.()))));
  }

  /**
   * A view shown in a modal (public-hooks.md §3.14, `ui.panels.open(id, {placement: 'modal'})`): the props a tab's view gets (the window's
   * route, read when it opens: it sits above the route, on the app's modal stack), its own state, and `close` closing the modal.
   */
  function ModalView({ mod, view, instance, onClose }) {
    const R = host?.react?.();
    if (!R) return null;
    R.useSyncExternalStore(subscribe, getVersion, getVersion);
    const [state, setState] = R.useState(null);
    const v = views.get(`${mod}/${view}`);
    // the window's route now (a modal sits above it: it follows navigation, and what it is about, as a tab beside the route does)
    const about = contextOf(v?.rule ?? null, undefined);
    if (!v || typeof v.render !== 'function') return R.createElement('div', { className: 'text-sm text-secondary' }, 'This view is not available.');
    const ctx = Object.freeze({
      mod, view, instance: instance ?? null, tabId: null, placement: 'modal', isActive: true, isVisible: true, ...about,
      state, setState, close: () => onClose?.(),
    });
    return host.node(v.rule, v.render, { key: `${mod}/${view}`, ...ctx });
  }

  return {
    arm, attach, openIn, closeIn, launcherItems, subscribe, restore, ModalView,
    /** Is that view's tab open in that scope's panels? */
    isOpen: (scope, mod, view, instance) => hasTab(scope, tabKeyOf(mod, view, instance)),
    get kind() { return tabType; },
    /** The views of the mods' rules in this window (the runtime calls it on every rule change). */
    setViews(rules) {
      for (const k of [...views.keys()]) if (!views.get(k).own) views.delete(k);
      for (const r of rules) {
        const spec = r.data?.view;
        if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string') continue;
        views.set(`${r.mod}/${r.id}`, { mod: r.mod, view: r.id, spec, render: r.fns?.render, headerRows: r.fns?.headerRows, rule: r });
      }
      bump();
    },
    /** A view of the framework's own (a chat beside another, layouts.md D8): its tabs keep their title in their params, as a mod's do, and are restored the same way. */
    setOwnView(mod, id, own) {
      views.set(`${mod}/${id}`, { mod, view: id, spec: {}, own, rule: null });
      bump();
    },
    /** A tab's title, as what it shows is called now: in the panel that holds it (the user can move it). */
    retitle(scope, props, title) {
      const pc = safe('panelControllers');
      const id = tabKeyOf(props.mod, props.view, props.instance);
      for (const ctl of [pc?.right, pc?.bottom]) {
        try {
          const tab = typeof ctl?.updateTab === 'function' ? scope.get(ctl.tabById$, id) : null;
          if (tab == null) continue;
          // the label, and what a restored tab is saved with: the app makes that from the tab's props
          const next = String(title).slice(0, 80);
          ctl.updateTab(scope, id, { title: next, props: { ...(tab.props ?? props), title: next } });
          return;
        } catch { /* as it was */ }
      }
    },
    /** The mods have loaded in this window: a tab with no view now says its mod is off. */
    settle() { if (!settled) { settled = true; bump(); } },
    view: (mod, id) => views.get(`${mod}/${id}`) ?? null,
    /** A view's props for a tab. */
    propsOf(mod, id, instance) {
      const v = views.get(`${mod}/${id}`);
      return v ? { mod, view: id, ...(instance ? { instance } : {}), title: v.spec.title.slice(0, 80), ...(typeof v.spec.icon === 'string' ? { icon: v.spec.icon } : {}), ...(v.spec.persist === false ? { persist: false } : {}) } : null;
    },
    allows,
  };
}
