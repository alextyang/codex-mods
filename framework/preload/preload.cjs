'use strict';
// Framework preload (ARCHITECTURE §9.1). Registered by framework-main for the app's sessions (session.registerPreloadScript), so
// the app's own preload is untouched. Runs sandboxed: only `electron`'s ipcRenderer/webFrame/contextBridge are used, no Node. It
//   0. installs the presentation kernel in the main world, synchronously, before the app's modules evaluate (`codexmods:kernel`,
//      docs/design/presentations.md V3): the hooks the build-time seams call, the armed bindings and the decision store;
//   1. asks framework-main for the bundled renderer runtime + adapter UI data (`codexmods:hello`), which also makes framework-main
//      post this page load's two MessagePorts (renderer channel, management channel) as `codexmods:port` messages;
//   2. injects the runtime into the main world with webFrame.executeJavaScript (not subject to the page CSP);
//   3. forwards the ports to the runtime with window.postMessage + transfer, and serves its two requests (privileged framework
//      modules, native file picker). Messages carry a per-load nonce so stray page messages are ignored.
// The page gets no general framework object: only the runtime's own channel.
const { ipcRenderer, webFrame, contextBridge } = require('electron');

/**
 * The presentation kernel (docs/design/presentations.md V3), run in the page's main world at document start, before the app's modules
 * evaluate, through `contextBridge.executeInMainWorld`. It is serialized there, so it is self-contained: no closure over this file.
 * It implements the inert hooks the build-time seams call (V1, V2): `jsx(factory, type, props, key)` (the JSX runtime), `lazy(importer,
 * module)` (the lazy loader), `taps` (the command tables), `menuItems(args, items)` (a thread menu's items), `launcher(list, opts)` (the panels'
 * tool list), `markdownComponents` and `markdownDirectives` (every markdown site's link, code and directives), `markdownText` (the renderer
 * of every markdown site's text tokens), `copy(content, event, origin)` (what the app's copy helper copies), `command(id, event, source, origin,
 * run)` (the page's command dispatcher), `attach(methods, args)` (a composer's attach methods), `reviewAction(arg, run)` (the review panel's git actions) and `exports` (the
 * app's
 * exposed objects, filled by the exposure blocks). It
 * holds the armed bindings (boot.bindings: {id, keys, exact?, canary?, scope?, site?, readsSite?, context?}, the prop keys a component's props carry, `exact` when they carry
 * no others, and the props' types it expects; or {id, exposure}, the component an exposure names, matched by identity where its props are
 * too generic to tell it: docs/design/systems.md E0)
 * and an empty decision store; the runtime, which arrives later, registers each binding's renderer and bumps the store, so wrappers in
 * place since the first render re-render from it. Absent a renderer, a wrapper renders the app's own component. A wrapper re-renders when
 * the store is bumped or when a subject its binding read in its last render is touched (subject-scoped invalidation, boundary review 4b).
 * @param {{ abi: number, bindings?: {id: string, keys?: string[], exact?: boolean, canary?: Record<string, string>, exposure?: string}[], taps?: object }} boot
 */
function codexmodsKernel(boot) {
  const g = globalThis;
  const K = g.__codexmods || (g.__codexmods = {});
  if (K.kernel) return K.kernel.abi;
  const now = () => (g.performance && g.performance.now ? g.performance.now() : 0);
  K.exports = K.exports || {};
  K.faults = K.faults || { count: 0, last: null };
  const fault = (where, e) => { K.faults.count++; K.faults.last = { where, message: String((e && e.message) || e) }; };
  K.taps = boot && boot.taps ? boot.taps : { commands: [], handlers: [], messages: {} };
  // Does this build's route tree have the framework's route for a mod's page (seam page-route)? Without it a path of its blanks the window: a
  // page kept in the address (an earlier build's) is taken out before the app reads it
  K.pageRouteOn = !!boot && boot.pageRoute === true;
  if (!K.pageRouteOn) {
    try {
      const u = new URL(g.location.href);
      if ((u.searchParams.get('initialRoute') ?? '').startsWith('/codexmods/')) { u.searchParams.delete('initialRoute'); g.history.replaceState(g.history.state, '', u.toString()); }
    } catch { /* no address here */ }
  }

  // The decision store the wrappers read at render time; the runtime sets renderers, bumps it (every wrapper) and touches subjects (the
  // wrappers whose binding read one). A wrapper's snapshot is the store's version and the versions of the subjects it read last.
  let version = 0;
  const listeners = new Set();
  const subjects = new Map();   // subject key -> version
  const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { fault('listener', e); } } };
  const store = {
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    version() { return version; },
    bump() { version++; notify(); },
    touch(keys) { for (const k of keys) subjects.set(k, (subjects.get(k) || 0) + 1); notify(); },
    reading: null,          // while a binding renders: the set its subject reads go to
    read(key) { if (store.reading) store.reading.add(key); },
    snapshot(keys) { let n = 0; if (keys) for (const k of keys) n += subjects.get(k) || 0; return `${version}|${n}`; },
    renderers: new Map(),   // binding id -> (Original, props, factory, record, scope) => element | undefined (undefined: the app's own)
    onFault: null,          // (bindingId, error) => void, set by the runtime to count a mod's fault
    menus: null,            // (args, items) => items, set by the runtime: a thread menu's items before they show
    // message content (E8.8), set by the runtime: a markdown part (`parts(kind, Native, props, at)`: an element, or undefined for the app's
    // own) and the mods' directives (`directives(options, defaults)`); each revision changes when what they answer may have
    parts: null,
    partsRev: 0,
    contentRev: 0,          // the content rules' revision (the redactions and text parts in force): every markdown renderer follows it
    directives: null,
    directivesRev: 0,
    copy: null,             // (content, place, origin) => content | null, set by the runtime: what the app copies, the mods' redactions masked
    copyPart: null,         // (type, data, place) => string | false | null: a selection's copy, one format (false: left out)
    command: null,          // (id, event, source, origin, run) => boolean | undefined: the page's command dispatcher, asked first
    attach: null,           // (methods, args, place) => methods | null: a composer's attach methods as the app makes them, the user's held
    reviewAction: null,     // (arg, run) => result | undefined: the review panel's git action, asked first
    pullRequestCreate: null, // (arg) => {refused} | {handled} | undefined (or a promise of one): a pull request the user creates, asked first
    sidebarGroups: null,    // (keys) => keys: the conversations sidebar's groups in the mods' order (layouts.md §4.1), set by the runtime
    groupsRev: 0,           // the groups rules' revision (and the state that decides them): the sidebar follows it
    responsive: null,       // ({width, scope}) => true | undefined: the framework's allocator owns the window's arrangement (layouts.md WL4d)
    pageRoute: null,        // the component the framework's route draws: the runtime's page host (layouts.md WL5a)
    destinations: null,     // (list, {location, navigate}) => list: the rail's and the sidebar's navigation, the mods' items in (layouts.md WL5b)
    destinationsRev: 0,     // the mods' destinations' revision: the provider follows it
    railMode: null,         // (location) => boolean: a mod's page asks for the app's contextual sidebar (layouts.md WL5c)
    // Committed mounts (docs/design/systems.md S10): a record {n, binding, props} per mounted wrapper, kept from the first render on (the
    // runtime arrives later and reads them); `onMount(kind, record)` ('mount', 'update' when a commit brought new props, 'unmount') is
    // set by the runtime.
    mounted: () => [...mounts],
    onMount: null,
  };
  K.store = store;
  const mounts = new Set();
  let mountSeq = 0;
  const mountEvent = (kind, rec) => { const fn = store.onMount; if (typeof fn !== 'function') return; try { fn(kind, rec); } catch (e) { fault('mounts', e); } };

  // Bindings: a component type is matched on sight by the keys its props carry; each matched type gets one stable wrapper type. At a
  // type's first match its props must pass the binding's canary (the types it expects); a type that fails is never wrapped and the binding
  // is off for the page (boundary review 4a): reported to the runtime's onFault, and kept in kernel.disarmed for a runtime that comes later.
  const armed = (boot && Array.isArray(boot.bindings) ? boot.bindings : []).filter((b) => b && typeof b.id === 'string'
    && ((Array.isArray(b.keys) && b.keys.length) || (typeof b.exposure === 'string' && b.exposure)));
  // A binding of a generic component (`element`: a menu's item, which the app draws for many things, E8.3f) is matched per element by its
  // props, never decided per type: its matching elements get one stable wrapper per type, the type's other elements stay the app's own.
  const elementBindings = armed.filter((b) => b.element === true && Array.isArray(b.keys) && b.keys.length);
  const bindings = armed.filter((b) => !elementBindings.includes(b));
  // A binding of a shared component that may first show long after the component's other uses (`rematch`: a queued follow-up's row, a row
  // of the composer's tray): still tried on a type the kernel stopped matching, and that type wrapped once it matches (H7x review 1).
  const rematch = bindings.filter((b) => b.rematch === true && Array.isArray(b.keys) && b.keys.length);
  const wrappers = new WeakMap();    // original type -> wrapper type
  const MARKDOWN_SITES = ['agent-message', 'user-message', 'reasoning', 'plan', 'file-preview', 'review-comment'];
  const misses = new WeakMap();      // original type -> times seen without a match (decided negative after a few)
  const MAX_MISSES = 16;
  const disarmed = new Map();        // binding id -> why its canary failed
  const canaryFails = (b, props) => {
    if (!b.canary || typeof b.canary !== 'object') return null;
    for (const k of Object.keys(b.canary)) {
      let want = String(b.canary[k]);
      const optional = want.endsWith('?');
      if (optional) want = want.slice(0, -1);
      const v = props[k];
      if (v === null || v === undefined) { if (optional || want === 'any') continue; return `${k} is ${v === null ? 'null' : 'absent'}, not ${want}`; }
      const got = Array.isArray(v) ? 'array' : typeof v;
      if (want !== 'any' && got !== want) return `${k} is ${got}, not ${want}`;
    }
    return null;
  };
  const disarm = (b, why) => {
    if (disarmed.has(b.id)) return;
    disarmed.set(b.id, why);
    for (const list of [bindings, elementBindings]) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
    const e = new Error(`its canary failed: ${why}`);
    fault(b.id, e);
    try { if (store.onFault) store.onFault(b.id, e); } catch { /* the runtime's own fault */ }
  };
  /** The component an exposure names (a dotted name reaches into one: `appShell.PageBanner`), or undefined (not exposed yet, or its getter
   *  threw: never this binding's then). */
  const exposed = (key) => {
    try { let v = K.exports; for (const part of key.split('.')) { if (v === null || v === undefined) return undefined; v = v[part]; } return v; } catch { return undefined; }
  };
  const keysMatch = (b, props) => {
    for (const k of b.keys) if (!(k in props)) return false;
    if (b.exact !== true) return true;
    const own = Object.keys(props);
    if (!b.optional) return own.length === b.keys.length;
    // `optional`: keys a build's call may also carry (22943's drift); any other key is not this component's
    if (own.length > b.keys.length + b.optional.length) return false;
    for (const k of own) if (!b.keys.includes(k) && !b.optional.includes(k)) return false;
    return true;
  };
  const matchFor = (props, type) => {
    for (const b of bindings) {
      if (b.exposure) { if (exposed(b.exposure) === type) return b; continue; }
      if (keysMatch(b, props)) return b;
    }
    return null;
  };
  const elementWrappers = new Map();   // an element binding's id -> (original type -> wrapper type)
  // An element whose props fail the canary is the app's own (another use of the generic component, not a drift of the build): it is not
  // wrapped, and the binding stays on (review 4). The check is a few `in` tests per element, its rarest key first in its address.
  const elementWrapper = (props, type, factory) => {
    for (const b of elementBindings) {
      if (!keysMatch(b, props) || canaryFails(b, props)) continue;
      let byType = elementWrappers.get(b.id);
      if (!byType) elementWrappers.set(b.id, byType = new WeakMap());
      let w = byType.get(type);
      if (!w) { w = makeWrapper(b, type, factory); byType.set(type, w); }
      return w;
    }
    return null;
  };
  function makeWrapper(b, Original, factory) {
    // The React exposure is read once: a wrapper either always subscribes or never does, so its hooks never change between renders.
    const R = K.exports.react;
    const sync = R && typeof R.useSyncExternalStore === 'function' ? R.useSyncExternalStore : null;
    const useRef = sync && typeof R.useRef === 'function' ? R.useRef : null;
    const useEffect = useRef && typeof R.useEffect === 'function' ? R.useEffect : null;
    // A binding whose component's props do not carry its subject may read one of the app's scopes (its address's `scope`, an exposure),
    // through the app's own scope hook: decided here, so the wrapper calls the same hooks on every render.
    const scopeDef = useRef && typeof b.scope === 'string' ? exposed(b.scope) : undefined;
    const useScope = scopeDef && typeof K.exports.useScope === 'function' ? K.exports.useScope : null;
    const siteOf = useRef && typeof b.site === 'string' && typeof R.createElement === 'function' ? K.markdownSite() : null;
    // only a markdown site is rendered again when the mods' directive names change
    const rekey = siteOf && MARKDOWN_SITES.includes(b.site);
    // a binding that reads the nearest site (a project's menu reads its section's project): read every render, so its hooks never change
    const nearOf = useRef && b.readsSite === true && typeof R.useContext === 'function' ? K.markdownSite() : null;
    const paneOf = useRef && typeof R.useContext === 'function' ? K.paneContext() : null;
    // a binding whose component sits in a context the app gives (a composer's controller, E8.3b): read every render, kept on its record
    const ctxDef = useRef && typeof b.context === 'string' && typeof R.useContext === 'function' ? exposed(b.context) : undefined;
    const readCtx = ctxDef && typeof ctxDef === 'object' ? ctxDef : null;
    // A wrapper's committed mount, in passive effects (after the commit, off the frame's critical path): mounted, every later commit (its
    // props, or its subject's state, may have changed), unmounted. Mounted is not visible (S10).
    const mountEffect = (self) => () => {
      const rec = self.current;
      mounts.add(rec);
      mountEvent('mount', rec);
      return () => { mounts.delete(rec); mountEvent('unmount', rec); };
    };
    function CodexmodsBound(props) {
      const deps = useRef ? useRef(null) : null;   // the subjects its binding read in its last render
      if (sync) sync(store.subscribe, deps ? () => store.snapshot(deps.current) : store.version);
      let scope, scopeNode = null;
      if (useScope) { try { const node = useScope(scopeDef); scopeNode = node || null; scope = node ? node.value : null; } catch (e) { scope = null; fault(b.id, e); } }
      const near = nearOf ? R.useContext(nearOf) : null;
      const pane = paneOf ? R.useContext(paneOf) : null;
      const given = readCtx ? R.useContext(readCtx) : undefined;
      const self = useEffect ? useRef(null) : null;   // this mount's record (S10)
      if (self) {
        if (self.current === null) self.current = { n: ++mountSeq, binding: b.id, props, ...(pane ? { pane } : {}), ...(useScope ? { scope } : {}), ...(readCtx ? { context: given ?? null } : {}), ...(nearOf ? { near } : {}) };
        useEffect(mountEffect(self), []);
        useEffect(() => {
          const rec = self.current;
          const again = rec.committed === true;   // the first commit is the mount
          rec.props = props;
          if (useScope) { rec.scope = scope; rec.scopeNode = scopeNode; }   // the node too: an act reads the scope's atoms through it (E7)
          if (readCtx) rec.context = given ?? null;
          if (nearOf) rec.near = near;
          rec.committed = true;
          if (again && mounts.has(rec)) mountEvent('update', rec);
        });
      }
      // a markdown site (E8.8): what it shows is told to the parts below it from the first render on, so the tree's shape never changes
      const at = siteOf ? useRef(null) : null;
      if (at) { if (at.current === null) at.current = { binding: b.id, site: b.site, props }; at.current.props = props; }
      const render = disarmed.has(b.id) ? null : store.renderers.get(b.id);
      let out;
      if (render) {
        const reading = new Set();
        const outer = store.reading;
        store.reading = reading;
        try {
          out = render(Original, props, factory, self ? self.current : null, scope, near);
        } catch (e) {
          out = undefined;
          fault(b.id, e);
          try { if (store.onFault) store.onFault(b.id, e); } catch { /* the runtime's own fault */ }
        } finally {
          store.reading = outer;
          if (deps) deps.current = reading;
        }
      }
      if (out === undefined) out = factory(Original, props);
      // the mods' directives are read when the site's markdown first renders: a change of their names renders the site again (rare)
      if (!at) return out;
      return R.createElement(siteOf.Provider, { value: at.current }, rekey ? R.createElement(R.Fragment, { key: `d${store.directivesRev}` }, out) : out);
    }
    CodexmodsBound.displayName = `Codexmods(${(Original && (Original.displayName || Original.name)) || b.id})`;
    return CodexmodsBound;
  }
  K.jsx = function jsx(factory, type, props, key) {
    if ((!bindings.length && !elementBindings.length) || !props || (typeof type !== 'function' && (typeof type !== 'object' || type === null))) return factory(type, props, key);
    if (elementBindings.length) { const e = elementWrapper(props, type, factory); if (e) return factory(e, props, key); }
    let w = wrappers.get(type);
    if (w === undefined) {
      const seen = misses.get(type) || 0;
      const b = seen >= MAX_MISSES ? rematch.find((x) => bindings.includes(x) && keysMatch(x, props)) : matchFor(props, type);
      if (seen >= MAX_MISSES && !b) return factory(type, props, key);
      if (!b) { misses.set(type, seen + 1); return factory(type, props, key); }
      const why = canaryFails(b, props);
      if (why) { disarm(b, why); misses.set(type, MAX_MISSES); return factory(type, props, key); }
      w = makeWrapper(b, type, factory);
      wrappers.set(type, w);
    }
    return factory(w, props, key);
  };

  // A thread menu's items (the menus seam): the runtime's rule decides them; without one, or when it throws or answers anything but a
  // list, the app's own items show.
  // `kind`: which menu (absent: a thread's; 'file-tree': a file or folder row's, E8.7; 'workspace-file': a file referenced anywhere, 'tab': a panel tab's, E8.7b)
  K.menuItems = function menuItems(args, items, kind) {
    const f = store.menus;
    if (typeof f !== 'function') return items;
    try { const out = f(args, items, kind); return Array.isArray(out) ? out : items; } catch (e) { fault('menuItems', e); return items; }
  };

  // The panels' launcher (the launcher seam, mod-surfaces.md §3.1): the runtime adds the mods' panel views to the app's tool list; without it,
  // or when it throws or answers anything but a list, the app's own list shows.
  K.launcher = function launcher(list, opts) {
    const f = store.launcher;
    if (typeof f !== 'function') return list;
    try { const out = f(list, opts); return Array.isArray(out) ? out : list; } catch (e) { fault('launcher', e); return list; }
  };

  // Message content (the markdown seam, mod-surfaces.md §3.3, E8.8). Every markdown site's link and code components pass through one stable
  // wrapper per app component (the app builds them once per options), which asks the runtime's `store.parts` for a mod's part with the
  // site it is in (`at`: what the nearest markdown site binding tells, null elsewhere); without one, or when it answers undefined or
  // throws, the app's own component with the same props. The app's default directives get the mods' own from `store.directives`.
  let siteContext = null;
  // Which hosted chat (a pane, layouts.md D8) a mount is inside: the framework's host provides it around the app's own view; none is the window's own page
  let paneContext = null;
  K.paneContext = function paneContextOf() {
    const R = K.exports.react;
    if (!paneContext && R && typeof R.createContext === 'function') paneContext = R.createContext(null);
    return paneContext;
  };
  K.markdownSite = function markdownSite() {
    const R = K.exports.react;
    if (!siteContext && R && typeof R.createContext === 'function') siteContext = R.createContext(null);
    return siteContext;
  };
  const partWrappers = new WeakMap();   // the app's component -> its wrapper
  const partOf = (kind, Native) => {
    if (typeof Native !== 'function' && (typeof Native !== 'object' || Native === null)) return Native;
    let w = partWrappers.get(Native);
    if (w) return w;
    const R = K.exports.react;
    const site = K.markdownSite();
    if (!site || typeof R.useSyncExternalStore !== 'function' || typeof R.useContext !== 'function' || typeof R.useRef !== 'function' || typeof R.createElement !== 'function') return Native;
    w = function CodexmodsPart(props) {
      // re-rendered when the part renderers change or a subject its last answer read (the site's) is touched, as a binding's wrapper is
      const deps = R.useRef(null);
      R.useSyncExternalStore(store.subscribe, () => { let n = 0; if (deps.current) for (const k of deps.current) n += subjects.get(k) || 0; return `${store.partsRev}|${n}`; });
      const at = R.useContext(site);
      const f = store.parts;
      if (typeof f === 'function') {
        const reading = new Set();
        const outer = store.reading;
        store.reading = reading;
        try { const out = f(kind, Native, props, at); if (out !== undefined) return out; } catch (e) { fault('markdown', e); } finally { store.reading = outer; deps.current = reading; }
      }
      return R.createElement(Native, props);
    };
    w.displayName = `CodexmodsPart(${kind})`;
    partWrappers.set(Native, w);
    return w;
  };
  K.markdownComponents = function markdownComponents(options, components) {
    if (!components || typeof components !== 'object') return components;
    try {
      const a = components.a ? partOf('a', components.a) : components.a;
      const code = components.code ? partOf('code', components.code) : components.code;
      return a === components.a && code === components.code ? components : { ...components, a, code };
    } catch (e) { fault('markdown', e); return components; }
  };
  K.markdownDirectives = function markdownDirectives(options, directives) {
    const f = store.directives;
    if (typeof f !== 'function') return directives;
    try { const out = f(options, directives); return out && typeof out === 'object' ? out : directives; } catch (e) { fault('markdown', e); return directives; }
  };
  // the markdown renderer's text tokens (seam markdown:text, H7u): the runtime answers the renderer to draw them with (a mod's text parts
  // and redactions), with the renderer's tokens (code masked) when they changed, or the site's own. It runs at the top of the renderer's
  // render and follows the content rules' revision there: one hook, the same on every render of every renderer (the kernel is there
  // before the app renders, and the React exposure is read once), so a renderer the app keeps (its own memo) draws again in place when the
  // redactions or text parts change: a chat shown, a plan in a side panel, a preview; nothing is remounted (built review: content live)
  let textSync;
  const contentRevOf = () => store.contentRev;
  K.markdownText = function markdownText(props, renderText) {
    if (textSync === undefined) { const R = K.exports.react; textSync = R && typeof R.useSyncExternalStore === 'function' ? R.useSyncExternalStore : null; }
    if (textSync) textSync(store.subscribe, contentRevOf);
    const f = store.text;
    if (typeof f !== 'function') return renderText;
    try { const out = f(props, renderText); return typeof out === 'function' || (out && typeof out === 'object') ? out : renderText; } catch (e) { fault('markdown', e); return renderText; }
  };

  // the conversations sidebar's groups (seam sidebar-groups, layouts.md §4.1): the runtime answers their order (a mod's, where the user has
  // not placed them). The sidebar calls it at the top of its render on every render, so it follows the groups' revision there (one hook,
  // the same on every render) and draws again when a groups rule comes, changes or goes
  let groupsSync;
  const groupsRevOf = () => store.groupsRev;
  K.sidebarGroups = function sidebarGroups(keys) {
    if (groupsSync === undefined) { const R = K.exports.react; groupsSync = R && typeof R.useSyncExternalStore === 'function' ? R.useSyncExternalStore : null; }
    if (groupsSync) groupsSync(store.subscribe, groupsRevOf);
    const f = store.sidebarGroups;
    if (typeof f !== 'function' || !Array.isArray(keys)) return keys;
    try { const out = f(keys); return Array.isArray(out) ? out : keys; } catch (e) { fault('sidebarGroups', e); return keys; }
  };

  // The workspace column's narrow-window handler (seam responsive, layouts.md WL4d): the runtime's allocator answers true while it owns the
  // window's arrangement for space (the handler then reads and writes nothing); anything else, or a throw, the app's thresholds
  K.responsive = function responsive(arg) {
    const f = store.responsive;
    if (typeof f !== 'function' || !arg || typeof arg !== 'object') return undefined;
    try { return f(arg) === true ? true : undefined; } catch (e) { fault('responsive', e); return undefined; }
  };

  // The framework's route for a mod's page (seam page-route, layouts.md WL5a): in the app's tree from module load, so this stands in for the
  // runtime's page host until it arrives, and follows it (the shell is drawn meanwhile; a reload on a page never blanks the window)
  // (the React exposure is read once: its hooks never change between renders)
  let pageSync;
  K.PageRoute = function CodexmodsPageRoute() {
    const R = K.exports.react;
    if (pageSync === undefined) pageSync = R && typeof R.useSyncExternalStore === 'function' && typeof R.createElement === 'function' ? R.useSyncExternalStore : null;
    if (!pageSync) return null;
    const Page = pageSync(store.subscribe, () => store.pageRoute);
    return Page ? R.createElement(Page) : null;
  };

  // The rail's and the sidebar's navigation (seam destinations, layouts.md WL5b): the runtime adds the mods' items before the app splits them
  K.destinations = function destinations(list, arg) {
    const f = store.destinations;
    if (typeof f !== 'function' || !Array.isArray(list)) return list;
    try { const out = f(list, arg); return Array.isArray(out) ? out : list; } catch (e) { fault('destinations', e); return list; }
  };
  let revSync;   // read once, as above: the provider's hooks never change between renders
  K.useDestinationsRev = function useDestinationsRev() {
    if (revSync === undefined) { const R = K.exports.react; revSync = R && typeof R.useSyncExternalStore === 'function' ? R.useSyncExternalStore : null; }
    return revSync ? revSync(store.subscribe, () => store.destinationsRev) : 0;
  };
  K.destinationsRev = function destinationsRev() { return store.destinationsRev; };
  // The rail's mode (seam rail-mode, layouts.md WL5c): a mod's page with a sidebar view gets the app's contextual column where the rail shows
  K.railMode = function railMode(location) {
    const f = store.railMode;
    if (typeof f !== 'function') return false;
    try { return f(location) === true; } catch (e) { fault('railMode', e); return false; }
  };

  // What the app copies (seam copy, F3): the runtime answers it with the mods' redactions of the chats it is from masked (a string, a
  // promise of one, or the app's {"text/plain", "text/html"}), or null for the content as it was. A thread action's copy says where it is
  // from (seam copy-origin: `origin`, {chat} or {content: false}); else the runtime decides from the place the copy was asked at
  // ({target, ranges}): the event's target, else the place the user last pointed at (within 2 s). A place in a floating layer (a menu, a
  // popover, a dialog: drawn apart from what it was opened on) is the place it was opened from: where the user last acted outside one (a
  // press, a right click, a key), with the selection a right click had (a message's menu copies the selection it was opened with); none
  // known, `{target: null, layer: true}`. The page's own `navigator.clipboard.writeText`, which a few of the app's copies call without its
  // helper (a command block's "Copy shell contents"), passes it too, and so does a selection's copy (the app's own copy handler's
  // `setData`: its text masked, its html left out when a rule applies), at the selection's place (its ranges: every chat it touches).
  const LAYER = '[data-radix-popper-content-wrapper],[role="menu"],[role="menubar"],[role="dialog"],[role="alertdialog"],[role="listbox"]';
  const elementOf = (node) => (node && node.nodeType === 1 ? node : node && node.parentElement ? node.parentElement : null);
  const layered = (node) => { const el = elementOf(node); return !!(el && typeof el.closest === 'function' && el.closest(LAYER) && !el.closest('[cmdk-root]')); };
  const rangesOf = (sel) => {
    const out = [];
    try { for (let i = 0; sel && i < sel.rangeCount; i++) { const r = sel.getRangeAt(i); if (!r.collapsed) out.push(r.cloneRange()); } } catch (e) { fault('copy', e); }
    return out;
  };
  let gesture = null;   // {target, at}: the last pointer press
  let opener = null;    // {target, ranges}: where the user last acted outside a floating layer (a right click with its selection)
  const opened = (e, withSelection) => { if (!layered(e.target)) opener = { target: e.target, ranges: withSelection && typeof g.getSelection === 'function' ? rangesOf(g.getSelection()) : [] }; };
  try {
    if (g.document && typeof g.document.addEventListener === 'function') {
      g.document.addEventListener('pointerdown', (e) => { gesture = { target: e.target, at: now() }; opened(e, false); }, true);
      // a drop and a paste are where the user acted too (an attach's place: seam attach)
      for (const type of ['drop', 'paste']) g.document.addEventListener(type, (e) => { gesture = { target: e.target, at: now() }; }, true);
      g.document.addEventListener('contextmenu', (e) => opened(e, true), true);
      g.document.addEventListener('keydown', (e) => opened(e, false), true);
    }
  } catch (e) { fault('copy', e); }
  const placeOf = (event) => {
    const t = event && event.target ? event.target : gesture && now() - gesture.at < 2000 ? gesture.target : null;
    if (t && layered(t)) return opener ? { target: opener.target, ranges: opener.ranges } : { target: null, ranges: [], layer: true };
    return t ? { target: t, ranges: [] } : null;
  };
  K.copy = function copy(content, event, origin) {
    const f = store.copy;
    if (typeof f !== 'function') return content;
    try { const out = f(content, placeOf(event), origin && typeof origin === 'object' ? origin : null); return out === undefined || out === null ? content : out; } catch (e) { fault('copy', e); return content; }
  };
  try {
    const clip = g.navigator && g.navigator.clipboard;
    const own = clip && clip.writeText;
    if (typeof own === 'function' && !own.codexmods) {
      const writeText = function writeText(text) { return own.call(this, typeof text === 'string' ? K.copy(text, null) : text); };
      writeText.codexmods = true;
      clip.writeText = writeText;
    }
    const DT = g.DataTransfer && g.DataTransfer.prototype;
    const set = DT && DT.setData;
    if (typeof set === 'function' && !set.codexmods) {
      const setData = function setData(type, data) {
        const f = store.copyPart;
        if (typeof f === 'function' && typeof data === 'string' && (type === 'text/plain' || type === 'text/html')) {
          try {
            const sel = typeof g.getSelection === 'function' ? g.getSelection() : null;
            const out = f(type, data, sel ? { target: sel.anchorNode, ranges: rangesOf(sel) } : null);
            if (out === false) return undefined;
            if (typeof out === 'string') data = out;
          } catch (e) { fault('copy', e); }
        }
        return set.call(this, type, data);
      };
      setData.codexmods = true;
      DT.setData = setData;
    }
  } catch (e) { fault('copy', e); }

  // A composer's attach methods (seam attach, H6m3b): the runtime answers them with the user's own (a picker's files, a paste, a drop) held
  // as their Draft.attach of the composer they are in, or null for the app's own; the place is where the user last acted.
  K.attach = function attach(methods, args) {
    const f = store.attach;
    if (typeof f !== 'function' || !methods || typeof methods !== 'object') return methods;
    try { const out = f(methods, args, placeOf(null)); return out && typeof out === 'object' ? out : methods; } catch (e) { fault('attach', e); return methods; }
  };

  // The review panel's git actions (seam review-action, H6m4): the runtime answers its result (it ran it or holds it), or undefined for the
  // app's own at once; `run()` runs once, and a throw once it started is the app's own.
  K.reviewAction = function reviewAction(arg, run) {
    const f = store.reviewAction;
    if (typeof f !== 'function') return undefined;
    let started = false;
    const once = () => { if (started) return undefined; started = true; return run(); };
    try { return f(arg, once); } catch (e) { if (started) throw e; fault('reviewAction', e); return undefined; }
  };

  // A pull request the user creates (seam pr-create, H6m4): the runtime answers a promise of the decision (`{refused}`: the page throws it;
  // `{handled: {url}}`: a mod made it), or undefined for the app's own at once. A fault is the app's own.
  K.pullRequestCreate = function pullRequestCreate(arg) {
    const f = store.pullRequestCreate;
    if (typeof f !== 'function') return undefined;
    try { return Promise.resolve(f(arg)).catch((e) => { fault('pullRequestCreate', e); return undefined; }); } catch (e) { fault('pullRequestCreate', e); return undefined; }
  };

  // The page's command dispatcher (seam command, H6m3): the runtime answers whether it ran or holds a command (`run(event?)`: the app's own
  // dispatch, at most once), or undefined for the app's own dispatch at once. A throw once it ran is the dispatcher's (never run again).
  K.command = function command(id, event, source, origin, run) {
    const f = store.command;
    if (typeof f !== 'function') return undefined;
    let started = false;
    const once = (e) => { if (started) return undefined; started = true; return run(e); };
    try { const out = f(id, event, source, origin, once); return typeof out === 'boolean' ? out : undefined; } catch (e) { if (started) throw e; fault('command', e); return undefined; }
  };

  // The lazy loader: the runtime sets `lazyHook(importer, module)` to wrap a page, dialog or panel export as it loads.
  K.lazyHook = null;
  K.lazy = function lazy(importer, mod) {
    const h = K.lazyHook;
    if (!h) return mod;
    try { const out = h(importer, mod); return out === undefined ? mod : out; } catch (e) { fault('lazy', e); return mod; }
  };

  // every armed binding, those matched per element too (the runtime renders only what this names)
  K.kernel = { abi: 1, at: now(), bindings: [...bindings, ...elementBindings].map((b) => b.id), disarmed };
  return K.kernel.abi;
}
if (typeof module === 'object' && module && module.exports) module.exports.codexmodsKernel = codexmodsKernel;   // for tests

(function main() {
  try {
    if (window.top !== window) return;                                   // main frame only
    if (location.protocol !== 'app:' || location.hostname !== '-') return; // the app's own pages only
  } catch { return; }

  // The presentation kernel first, synchronously, so the seams find their hooks at the app's first render (V3). A failure leaves the
  // page as the app made it; it is reported once the log channel is defined below.
  let kernelError = null;
  try {
    const kboot = ipcRenderer.sendSync('codexmods:kernel', { search: location.search });
    if (kboot && typeof kboot === 'object' && contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: codexmodsKernel, args: [kboot] });
    }
  } catch (e) { kernelError = e; }

  const nonce = (() => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); })();
  let runtimeReady = false;
  const queue = [];

  const forwardPort = (kind, port) => window.postMessage({ __codexmods: nonce, dir: 'to-runtime', kind: 'port', port: kind }, '*', [port]);
  ipcRenderer.on('codexmods:port', (event, msg) => {
    const port = event.ports && event.ports[0];
    if (!port || !msg || (msg.kind !== 'renderer' && msg.kind !== 'management')) return;
    if (runtimeReady) forwardPort(msg.kind, port); else queue.push([msg.kind, port]);
  });

  // A new window, the app's own way (App.openWindow): framework-main asks a window's page for it, and the page sends the app's main the
  // request its own bridge sends ("Open in New Window": `open-in-new-window` on the app's channel from its pages). Only that message, and
  // only on a path of the app's own form: its home, or a chat.
  const NEW_WINDOW_PATH = /^\/(?:local\/[A-Za-z0-9._:-]{1,200})?$/;
  ipcRenderer.on('codexmods:new-window', (_event, msg) => {
    if (!msg || typeof msg.path !== 'string' || !NEW_WINDOW_PATH.test(msg.path)) return;
    ipcRenderer.invoke('codex_desktop:message-from-view', { type: 'open-in-new-window', path: msg.path }).catch((e) => reportLog('new-window', e));
  });

  // Startup failures must never be silent: they go to framework-main, which writes them to the Host-visible log.
  let logged = 0;
  const reportLog = (phase, err) => {
    if (logged++ >= 20) return;
    try {
      ipcRenderer.invoke('codexmods:log', { phase: String(phase), message: String((err && err.message) || err).slice(0, 500), stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
        documentState: (() => { try { return { readyState: document.readyState, hasRoot: !!document.documentElement }; } catch { return undefined; } })() }).catch(() => {});
    } catch { /* ipc unavailable */ }
  };
  if (kernelError) reportLog('kernel', kernelError);
  const reply = (reqId, payload) => window.postMessage({ __codexmods: nonce, dir: 'to-runtime', reply: reqId, ...payload }, '*');
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || typeof m !== 'object' || m.__codexmods !== nonce || m.dir !== 'to-preload') return;
    if (m.op === 'runtime-ready') {
      runtimeReady = true;
      while (queue.length) { const [kind, port] = queue.shift(); forwardPort(kind, port); }
    } else if (m.op === 'log') {
      reportLog(typeof m.phase === 'string' ? `runtime:${m.phase}` : 'runtime', { message: m.message, stack: m.stack });
    } else if (m.op === 'framework-module' && typeof m.spec === 'string') {
      ipcRenderer.invoke('codexmods:framework-module', m.spec).then(async (expr) => {
        if (typeof expr !== 'string') return reply(m.reqId, { ok: false, error: 'unknown framework module' });
        const key = `${m.reqId}:${nonce}`;
        await webFrame.executeJavaScript(`(globalThis.__codexmods_fwm ??= {})[${JSON.stringify(key)}] = ${expr};`);
        reply(m.reqId, { ok: true, key });
      }).catch((e) => reply(m.reqId, { ok: false, error: String((e && e.message) || e) }));
    } else if (m.op === 'navigate') {
      ipcRenderer.invoke('codexmods:navigate', { path: typeof m.path === 'string' ? m.path : '' }).then((done) => reply(m.reqId, { ok: true, done: done === true }))
        .catch((e) => reply(m.reqId, { ok: false, error: String((e && e.message) || e) }));
    } else if (m.op === 'pick-file') {
      const extensions = Array.isArray(m.extensions) ? m.extensions.filter((x) => typeof x === 'string').slice(0, 16) : [];
      ipcRenderer.invoke('codexmods:pick-file', { extensions, directory: m.directory === true }).then((path) => reply(m.reqId, { ok: true, path: path ?? null }))
        .catch((e) => reply(m.reqId, { ok: false, error: String((e && e.message) || e) }));
    }
  });

  ipcRenderer.invoke('codexmods:hello', { search: location.search }).then((res) => {
    if (!res || typeof res.runtime !== 'string' || !res.boot) return;
    const boot = JSON.stringify({ ...res.boot, nonce });
    return webFrame.executeJavaScript(`(function (boot) { const E = ${res.runtime}; E.startRuntime(boot); })(${boot});`);
  }).catch((e) => { reportLog('inject', e); try { console.error('[codexmods] preload failed', e); } catch { /* console may be gone */ } });
})();
