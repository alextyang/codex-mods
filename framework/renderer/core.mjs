// The renderer runtime proper (ARCHITECTURE §9.1): composes dom, anchors, theme, components, the framework's own mounts, the probe
// and the module loader around the Host channel. Everything environment-specific arrives in `env`, so the same
// code runs in the page main world (runtime.mjs) and in tests (fakes).
import { CodexModsError } from '../../sdk/errors.mjs';
import { createAnchors } from './anchors.mjs';
import { createTheme } from './theme.mjs';
import { createComponents } from './components.mjs';
import { createHostRoot } from './host-root.mjs';
import { createMountManager } from './mount.mjs';
import { createProbe } from './probe.mjs';
import { createHostChannel } from './channel.mjs';
import { createManagementClient } from './management-client.mjs';
import { RULES } from '../shared/ui-rules-client.mjs';
import { createUiFactory } from './ui.mjs';
import { createModuleLoader } from './modules.mjs';
import { startPresentation } from './present/runtime.mjs';
import { joinWindowRule } from './present/rules.mjs';
import { createPagesStatus } from './pages-status.mjs';
import { BINDINGS } from './present/bindings/index.mjs';
import { createModPanels } from './present/mod-panels.mjs';

const BAND_ID = 'framework:band';   // the banner band's mount (E6.4)
const FRAMEWORK_ID = 'codexmods.framework';   // the page runtime's own id on the renderer channel (presentations.md V6)

/**
 * @typedef {object} Boot
 * @property {{ build: { version: string, bundleVersion: string }, anchors: object, components: Record<string,string>, react: { react: string, reactDom: string } | null, theme: Record<string,string> }} adapter
 * @property {string} appBuild      `<version>-<bundleVersion>`
 *
 * @typedef {object} Env
 * @property {import('./dom.mjs').Dom} dom
 * @property {(key: string) => unknown} getExport                  globalThis.__codexmods.exports[key]
 * @property {(url: string) => Promise<any>} importModule          dynamic import of codexmod:// modules
 * @property {(port: any) => { context(modId: string, realm: 'renderer', info: object): object }} createRealmClient   framework/shared/realm-client.mjs
 * @property {{ frameworkModule(spec: string): Promise<any>, pickFile(opts: { extensions?: string[], directory?: boolean }): Promise<string | null>,
 *   navigate?(path: string): Promise<boolean> }} bridge   preload bridge (`navigate`: the framework's own navigation of this window, E6.4)
 * @property {(m: string, d?: object) => void} [log]
 */

const FRAMEWORK_MOD = (spec) => `framework:${spec.replace(/[^A-Za-z0-9._-]+/g, '-')}`;

/** @param {Boot} boot @param {Env} env */
/**
 * The window's arrangement as the app's shell shows it (S10; docs/design/layouts.md §4, WL1): its navigation (the app's rail, its sidebar,
 * or both), whether its sidebar is open (`data-app-shell-sidebar-open` on the shell's frame) and how wide, its side panel (20770 and 21477:
 * the panel's pane frame, `data-app-shell-pane-frame`, is there only while it is open; 22943 has none, and keeps the right panel's aside
 * mounted at no width while it is closed) with its size and whether it fills the workspace, its bottom panel, and its workspace's layout
 * as the workspace shown says it (a page the app keeps for later stays mounted, hidden, so the shown one, else none: H7pl review 2). 21477
 * says `chat`, `split` or `full`; 22943 says only `split` or `full`, so its `split` with the panel closed is the chat alone (WL0). Sizes are
 * whole pixels, where the page can measure them.
 */
export function shellFactsOf(dom) {
  let el, pane, aside, ws, rail, navRoot, left, bottom;
  // a page the app keeps for later stays mounted, hidden: its workspace's parts are the shown page's only (layouts WL1-3 review)
  const shown = (sel) => dom.queryAll(sel).find((n) => (typeof dom.isShown === 'function' ? dom.isShown(n) : true)) ?? null;
  try {
    el = dom.query('[data-app-shell-frame]');
    if (!el) return null;
    pane = shown('[data-app-shell-pane-frame]');
    aside = shown('aside[data-app-shell-focus-area="right-panel"]');
    ws = shown('[data-app-shell-workspace-layout]');
    rail = dom.query('nav[data-app-navigation-rail]');
    navRoot = dom.query('[data-sidebar-navigation-root]');
    left = dom.query('aside.app-shell-left-panel');
    bottom = shown('[data-app-shell-focus-area="bottom-panel"]');
  } catch { return null; }
  const measure = typeof dom.width === 'function';
  const px = (n) => Math.round(n);
  const v = dom.attr(el, 'data-app-shell-sidebar-open');
  const sideSize = aside && measure ? dom.width(aside) : 0;
  const sideOpen = !!pane || sideSize > 1;
  const said = ws ? dom.attr(ws, 'data-app-shell-workspace-layout') : null;
  const mode = said === 'split' && !sideOpen ? 'chat' : ['chat', 'split', 'full'].includes(said) ? said : null;
  const navWidth = navRoot && measure ? dom.width(navRoot) : 0;
  // with the rail, the sidebar is the navigation root beside it; without, the left panel
  const sidebarWidth = measure ? (rail ? navWidth : left ? dom.width(left) : 0) : 0;
  const bottomHeight = bottom && typeof dom.height === 'function' ? dom.height(bottom) : 0;
  // the bottom panel beside the chat (layouts.md WL4b: its column of the frame's host) is sized by its width
  const besideAt = bottom ? dom.attr(bottom, 'data-codexmods-bottom-at') : null;
  const bottomWidth = besideAt && measure ? dom.width(bottom) : 0;
  const sidebarOpen = v === 'true' ? true : v === 'false' ? false : null;
  // a window in the background (occluded, minimized) draws no frame: what it was asked to show shows when it is in front again
  const hidden = typeof dom.pageHidden === 'function' && dom.pageHidden() === true;
  return {
    ...(hidden ? { hidden: true } : {}),
    navigation: rail ? (navWidth > 1 ? 'rail-and-sidebar' : 'rail') : 'sidebar',
    ...(sidebarOpen === null ? {} : { sidebar: { open: sidebarOpen, ...(sidebarOpen && sidebarWidth > 1 ? { width: px(sidebarWidth) } : {}) } }),
    side: { open: sideOpen, ...(sideOpen && sideSize > 1 ? { size: px(sideSize) } : {}), ...(sideOpen && ws ? { full: dom.attr(ws, 'data-app-shell-right-panel-full-width') === 'true' || mode === 'full' } : {}) },
    bottom: besideAt ? { open: bottomWidth > 1, ...(bottomWidth > 1 ? { width: px(bottomWidth) } : {}) }
      : { open: bottomHeight > 1, ...(bottomHeight > 1 ? { height: px(bottomHeight) } : {}) },
    layout: mode ? { mode } : null,
  };
}

export function createRuntimeCore(boot, env) {
  const { dom, getExport, bridge } = env;
  const log = env.log ?? (() => {});
  const adapter = boot.adapter;
  // The app's React and ReactDOM: the exports keys the pack names, else the ones the page seams' exposure blocks define (V10).
  const reactKeys = adapter.react ?? { react: 'react', reactDom: 'reactDom' };
  const getReact = () => { try { return getExport(reactKeys.react); } catch { return undefined; } };
  const getReactDom = () => { try { return getExport(reactKeys.reactDom); } catch { return undefined; } };

  let channel = null;
  let presentation = null;   // the page side of presentations, started with the renderer channel
  // The mods' panel views (mod-surfaces.md §3.1): their tab kind is named to the app from the page's first moments, so the app's
  // restore of a mod's tab waits for the presentation runtime instead of giving up on it.
  const modPanels = createModPanels({ getExport, schedule: (fn, ms) => dom.schedule(fn, ms), log: (m, d) => log(`presentation: ${m}`, d) });
  modPanels.arm();
  /** This window's report of its Mods pages, for the recovery view (pages-status.mjs, E6.1). */
  const pages = createPagesStatus({ schedule: (fn, ms) => dom.schedule(fn, ms) });
  let management = null;
  let realm = null;
  let hostRoot = null;
  const sendFault = (modId, err, where) => {
    const e = err instanceof Error ? err : new Error(String(err));
    channel?.send({ t: 'fault', ...(modId ? { modId } : {}), message: String(e.message).slice(0, 2000), stack: e.stack ? String(e.stack).slice(0, 8000) : undefined, ...(typeof where === 'string' ? { where } : {}) });
  };

  // ---- readiness: the app's chunks load after the preload injected us.
  const ready = (() => {
    let p = null;
    return () => (p ??= new Promise((resolve) => {
      const deadline = 20_000; let waited = 0;
      const poll = () => { if ((getReact() && getReactDom()) || (waited += 50) >= deadline) return resolve(); dom.schedule(poll, 50); };
      poll();
    }));
  })();

  const anchors = createAnchors({ dom, anchors: adapter.anchors, log });
  const theme = createTheme({ dom, tokens: adapter.theme });
  const comps = createComponents({ getExport, adapter, react: getReact, themeMap: adapter.theme, drops: () => presentation?.drops ?? null });

  const getHostRoot = () => {
    if (hostRoot) return hostRoot;
    const react = getReact(); const reactDom = getReactDom();
    if (!react || !reactDom) return null;
    hostRoot = createHostRoot({ react, reactDom, dom, onFault: sendFault });
    return hostRoot;
  };

  const mountHost = { setMounts: (list) => getHostRoot()?.setMounts(list), ensureAttached: () => getHostRoot()?.ensureAttached() };
  const mounts = createMountManager({ dom, anchors, hostRoot: mountHost, log });
  // The mods' presentation rules (docs/design/systems.md E2): the Host keeps each rule and tells this window; a renderer-realm rule's
  // functions and components are this window's (its handles), joined to the Host's rule when both are here.
  const hostRules = new Map();   // key -> the Host's rule
  const keyOfRule = (r) => `${r.mod}/${r.id}`;
  const handles = new Map();     // key -> the functions and components registered in this window, and that registration's token
  // a renderer rule here is this window's registration: the whole of it as this window registered it (its kind, presentation, slot,
  // `for`, `where`, data), its functions and its token (graph-layers.md §2: another window's update is that window's until this one's
  // module updates too; the Host's record, the newest, holds every window's); its order is the Host's
  const joined = (r) => (r.realm !== 'renderer' ? r : joinWindowRule(r, handles.get(keyOfRule(r))));
  const rejoin = (key) => {
    const r = hostRules.get(key);
    if (!r || !presentation) return;
    const j = joined(r);
    if (j) presentation.rules.put(j); else presentation.rules.remove(key);
  };
  const ruleHandles = { set(key, fns, reg, desc) { handles.set(key, { fns, reg, desc }); rejoin(key); }, delete(key) { handles.delete(key); rejoin(key); }, get: (key) => handles.get(key)?.fns };
  const followRules = (fw) => fw[RULES]?.follow((d) => {
    if (!presentation || !d) return;
    if (d.t === 'snapshot') {
      hostRules.clear();
      for (const r of Array.isArray(d.rules) ? d.rules : []) hostRules.set(keyOfRule(r), r);
      presentation.rules.reset([...hostRules.values()].map(joined).filter(Boolean));
    } else if (d.t === 'put' && d.rule) { hostRules.set(keyOfRule(d.rule), d.rule); rejoin(keyOfRule(d.rule)); }
    else if (d.t === 'remove' && typeof d.key === 'string') { hostRules.delete(d.key); presentation.rules.remove(d.key); }
  });
  const uiFactory = createUiFactory({
    getReact, components: comps.components, theme, kit: comps.kit,
    ruleHandles, onRuleRefused: (modId, id, e) => log('a presentation rule was refused', { modId, rule: id, message: String(e?.message ?? e) }),
    panels: { open: (modId, id, opts) => presentation?.openPanel?.(modId, id, opts) ?? false, close: (modId, id, opts) => presentation?.closePanel?.(modId, id, opts) ?? false },
    filters: { set: (modId, id, on) => presentation?.filterOn?.(modId, id, on) ?? false },
    settingsPages: { open: (modId, page) => presentation?.openSettings?.(modId, page) ?? false, openPage: (modId, id) => presentation?.openPage?.(modId, id) ?? false, hostThread: (ref, opts) => presentation?.hostThread?.(ref, opts) ?? null, hostTab: (kind, ref) => presentation?.hostTab?.(kind, ref) ?? null, hostSupported: () => presentation?.hostSupported?.() ?? null },
  });
  /** The page's one style sheet of the mods' `style` rules (S12): replaced as they change, removed when empty. */
  let removeStyle = null;
  let styleCss = '';
  const styleSheet = (css) => { removeStyle?.(); styleCss = css; removeStyle = css ? dom.addStyle(css, 'style-rules') : null; };
  /** The app's own values of its variables: read with the mods' style rules taken out a moment (E6.4b: the framework's roots keep them). */
  const appValues = (names) => {
    const had = Boolean(removeStyle);
    if (had) { removeStyle(); removeStyle = null; }
    const out = {};
    for (const n of names) out[n] = dom.cssVar(n);
    if (had) removeStyle = dom.addStyle(styleCss, 'style-rules');
    return out;
  };
  /**
   * What the framework's roots declare again (E6 review): every custom property whose value the rules' sheet `rootCss` changes, aliases
   * defined from an overridden variable included, each with the app's own value; read with no rules' sheet, then with this one, a moment.
   */
  const protectRoots = (rootCss) => {
    const had = Boolean(removeStyle);
    if (had) { removeStyle(); removeStyle = null; }
    const names = dom.customProperties?.() ?? [];
    const app = new Map(names.map((n) => [n, dom.cssVar(n)]));
    const probe = rootCss ? dom.addStyle(rootCss, 'style-rules-probe') : null;
    const changed = {};
    for (const n of names) { const v = dom.cssVar(n); if (v !== app.get(n)) changed[n] = app.get(n); }
    probe?.();
    if (had) removeStyle = dom.addStyle(styleCss, 'style-rules');
    return changed;
  };
  const shellFacts = () => shellFactsOf(dom);
  // a window coming to the front (or going behind) changes what it can show: its facts go with the next report
  try { globalThis.document?.addEventListener?.('visibilitychange', () => { presentation?.windowChanged?.(); }); } catch { /* no document: tests */ }
  const probe = createProbe({ appBuild: boot.appBuild, anchors, components: comps, getReact, post: (m) => channel?.send(m), schedule: (fn, ms) => dom.schedule(fn, ms), onTick: () => { mounts.reconcile(); presentation?.windowChanged?.(); }, bindingReport: () => presentation?.works?.() ?? {}, bindingStates: () => presentation?.states?.() ?? {}, rulesReport: () => presentation?.rulesReport?.() ?? {}, authoritative: true,
    // ready = the app React is exposed and the app shell is on screen (the sidebar, or the settings content)
    isReady: () => Boolean(getReact() && getReactDom() && (anchors.resolve('sidebar') || anchors.resolve('settings.section'))), log });

  let loader = null;
  let themeReport = null;

  const attachRenderer = (port) => {
    if (channel) { log('renderer port already attached'); return; }
    channel = createHostChannel(port);
    realm = env.createRealmClient(channel.realmPort);
    loader = createModuleLoader({
      importModule: env.importModule,
      makeContext: (m) => realm.context(m.modId, 'renderer', { id: m.modId, version: m.version, dataDir: m.dataDir }),
      uiFactory, ready, onFault: sendFault, schedule: (fn, ms) => dom.schedule(fn, ms), log,
    });
    channel.onDetail?.((ref) => { try { presentation?.showDetail?.(ref); } catch (e) { log('an instance could not be shown', { message: String(e?.message ?? e) }); } });
    channel.onAct?.((m) => { try { presentation?.act?.(m); } catch (e) { log('an act on a presentation failed', { message: String(e?.message ?? e) }); } });
    channel.onAsk?.((m) => { try { presentation?.ask?.(m); } catch (e) { log('a question could not be taken', { message: String(e?.message ?? e) }); } });
    channel.onRuleRun?.((m) => { try { presentation?.runRule?.(m); } catch (e) { log('a rule\'s function could not run', { message: String(e?.message ?? e) }); } });
    channel.onDeclAct?.((m) => { try { presentation?.declAct?.(m); } catch (e) { log('a declaration could not be acted on', { message: String(e?.message ?? e) }); } });
    channel.onModules((list) => {
      const p = loader.sync(Array.isArray(list) ? list : []);
      // the mods this window runs have loaded (and their rules had a moment to be accepted): a mod's tab whose view did not come says its
      // mod is off
      const settle = () => dom.schedule(() => presentation?.settlePanels?.(), 1500);
      p.then(settle, settle);
    });
    // the page runtime goes with its channel: the pages no longer run in this window until it starts again (E6 review)
    channel.onClose(() => { probe.stop(); if (presentation) pages?.failed('the page runtime stopped: its Host channel closed'); presentation?.dispose(); presentation = null; themeReport?.dispose(); themeReport = null; });
    // Presentations (docs/design/presentations.md): the framework's bindings read the graph under the framework's own id.
    if (env.kernel) {
      pages?.reset?.();
      try {
        const fw = realm.context(FRAMEWORK_ID, 'renderer', { id: FRAMEWORK_ID, version: boot.frameworkVersion ?? '0', dataDir: '' });
        presentation = startPresentation({ kernel: env.kernel(), graph: fw.graph, present: fw.present, instances: fw[RULES], windowFacts: shellFacts, cssVar: (n) => dom.cssVar(n), styleSink: styleSheet, appValues, protectRoots, onTheme: (fn) => theme.onChange(fn), appearance: () => theme.appearance, tokens: boot.adapter?.theme, bindings: BINDINGS, onModFault: sendFault, pages, pickFile: (o) => bridge.pickFile(o), modPanels, navigate: (path) => bridge.navigate?.(path), log: (m, d) => log(`presentation: ${m}`, d) });
        if (!presentation) pages?.missing('the page runtime is not there');
        // The banner band (E6.4) at the top of the window's content
        else if (presentation.Band) { try { mounts.mount(BAND_ID, 'workspace', presentation.Band, { position: 'prepend' }); } catch (e) { log('the band was not mounted', { message: String(e?.message ?? e) }); } }
        followRules(fw);
      } catch (e) { log('presentation did not start', { error: String(e?.message ?? e) }); pages?.failed(`the page runtime did not start: ${e?.message ?? e}`); }
    } else pages?.missing('the page runtime is not there');
    // Always speak first: the Host opens this window's realm (and sends `modules`) only after a renderer message; the report is refined once the app has loaded.
    probe.update();
    probe.start();      // the report stays incomplete until the app shell is ready (no timer path)
    // The app's theme as this window shows it (the token values and the appearance), for the graph's Theme (breadth.md D4): once the app
    // is ready, then on every change.
    const send = () => { try { channel?.send({ t: 'theme', tokens: theme.tokens(), appearance: theme.appearance }); } catch { /* the channel is gone */ } };
    ready().then(() => { if (!channel) return; send(); themeReport = theme.onChange(send); }, () => {});
  };

  const attachManagement = (port) => {
    if (management) return;
    management = createManagementClient(port);
    // The recovery entry, on its own: it must work when the graph or the Mods pages do not (E6.1).
    loadFrameworkModule('recovery/index.mjs', { pages }).catch((e) => log('the recovery entry not loaded', { error: String(e?.message ?? e) }));
    // Adjustments' views went with E6.6d: the Mods pages in the app's Settings are the framework's UI; the recovery entry stays (S22)
  };

  /**
   * Load a privileged built-in module (the recovery entry). `spec` is a framework-relative path ("recovery/index.mjs", delivered
   * by framework-main through the preload) or a full URL. Its default export is `(ctx) => void | Disposable`, or an object with
   * `renderer(ctx)` / `activate(ctx)`. ctx = { ui, management, pickFile, mountSettings, ...extra }. `mountSettings(component, opts)`: drawn in Settings by
   * the framework's own mount, which needs no graph, no rules and no page runtime (what the recovery entry stands on).
   */
  async function loadFrameworkModule(spec, extra = {}) {
    if (!management) throw new CodexModsError('Unavailable', 'the management port has not arrived');
    await ready();
    const mod = /^[a-z][a-z0-9+.-]*:\/\//i.test(spec) ? await env.importModule(spec) : await bridge.frameworkModule(spec);
    const def = mod?.default ?? mod;
    const fn = typeof def === 'function' ? def : def?.renderer ?? def?.activate;
    if (typeof fn !== 'function') throw new CodexModsError('Invalid', `${spec}: no default export function, renderer or activate`);
    const scope = uiFactory.forMod(FRAMEWORK_MOD(spec));
    const ctx = {
      ui: scope.ui, management,
      pickFile: (opts) => bridge.pickFile(opts),
      mountSettings: (component, opts) => mounts.mount(FRAMEWORK_MOD(spec), 'settings.section', component, opts),
      ...extra,
    };
    let result;
    try { result = await fn(ctx); } catch (e) { scope.dispose(); throw e; }
    const disposer = typeof result === 'function' ? result : result && typeof result.dispose === 'function' ? () => result.dispose() : null;
    return { dispose() { try { disposer?.(); } finally { mounts.disposeMod(FRAMEWORK_MOD(spec)); scope.dispose(); } } };
  }

  return {
    attachRenderer, attachManagement, loadFrameworkModule,
    // exposed for tests and diagnostics
    parts: { anchors, theme, components: comps, mounts, probe, get channel() { return channel; }, pages, get loader() { return loader; }, get hostRoot() { return hostRoot; }, uiFactory },
    async close() {
      probe.stop(); presentation?.dispose(); await loader?.close(); mounts.dispose(); theme.dispose(); hostRoot?.dispose(); management?.close(); channel?.close();
    },
  };
}
