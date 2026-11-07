// The Mods pages in the app's Settings (docs/design/framework-ui.md F2; systems.md S15, S21). Three parts, all in the app's own UI:
// - the routes, children of the app's `/settings` route (the `routes` exposure: the tree the router reads on every render), so the pages render inside the settings layout with its
//   navigation: the Mods list, Update, Developer, the DetailView, and a mod's page with its tabs; kept in step with the framework's mods (CodexMods.mods) and taken out on disposal;
// - a "Mods" group in the settings navigation after the app's first group, with Update while one is offered, Mods and Developer (the `settings.navgroup` binding), which navigate
//   through the navigation's own `onSelect` (the app's guard for unsaved changes) and are active on their pages, while the app's own entries are not (the `settings.nav` binding);
// - the pages: the list (mods-overview.mjs), Update (mods-update-page.mjs), Developer (mods-developer.mjs), a mod's page (mod-page.mjs, its settings in setting-rows.mjs), with their
//   Dialogs (dialogs.mjs: the app's Dialog, or a fallback);
// all drawn with the app's settings frame, sections, card and rows (the SettingsPageFrame, SettingsSection, SettingsCard and SettingsRow exposures) and the kit (kit/), from the
// framework's graph.
// The window's router is in memory (the page's URL never changes), so the page itself says when it is shown. NO NODE API.
import { createSettingRows } from './setting-rows.mjs';
import { createModsOverview } from './mods-overview.mjs';
import { createUpdatePage } from './mods-update-page.mjs';
import { createDeveloperPage } from './mods-developer.mjs';
import { createModPage } from './mod-page.mjs';
import { createPageCommon } from './mods-common.mjs';
import { createDialogs } from './dialogs.mjs';
import { readState } from './band.mjs';
import { issuesIn, shortBuild, text } from './mods-text.mjs';
import { createReport } from './reports.mjs';
import { createDetailView } from './detail-view.mjs';
import { createKit } from './kit/index.mjs';
import { INTERNAL_MOD_IDS } from '../../shared/internal-mods.mjs';

export const FRAMEWORK_REF = Object.freeze({ type: 'CodexMods', provider: 'codexmods.framework', id: 'codexmods' });
export const modRef = (id) => Object.freeze({ type: 'Mod', provider: 'codexmods.framework', id });
/** The settings section a mod page stands for, in the navigation's `activeSection` (no app entry has it, so none is active). */
export const ACTIVE_SECTION = 'codexmods';
/** A mod's page, or one of its tabs ('permissions', 'activity'). */
export const pathOf = (modId, tab) => `/settings/codexmods/${modId}${tab ? `/${tab}` : ''}`;
/** A mod's own page (ui.settings.page, E8.9a): its route under the mod's; in the Mods group it is a tab of its page (framework-ui.md F2). */
export const pagePathOf = (modId, pageId) => `/settings/codexmods/${modId}/~${pageId}`;
/** The navigation group a NavGroup is: one of the app's own by its heading's message id (personal, integrations, coding), else null. */
export function groupOf(props) {
  const id = props?.title && typeof props.title === 'object' ? props.title.props?.id : null;
  const m = typeof id === 'string' ? /^settings\.nav\.heading\.(personal|integrations|coding)$/.exec(id) : null;
  return m ? m[1] : null;
}
/** The Mods list's path, and what `state.active` says while it is shown (no mod id has a colon). */
export const OVERVIEW_PATH = '/settings/codexmods';
export const OVERVIEW = ':overview';
/** The Update and Developer pages. `~` is in no mod id. */
export const UPDATE_PATH = '/settings/codexmods/~update';
export const UPDATE = ':update';
export const DEVELOPER_PATH = '/settings/codexmods/~developer';
export const DEVELOPER = ':developer';
/** What `state.active` says while a mod's page that is not there is shown. */
export const GONE = ':gone';
/** The DetailView's path (S11), and what `state.active` says while it is shown. `~` is in no mod id. */
export const DETAIL_PATH = '/settings/codexmods/~detail';
export const DETAIL = ':detail';
const DETAIL_KEY = 'local:detail';
/**
 * A framework-owned instance's own page (S11): a Mod's, its settings' mod's, the list for CodexMods, the Update page for the CopyUpdate, an Operation's mod's Activity while it is
 * installed and else Developer's Recent activity; null for one with none (a Feature).
 * @param {object} ref
 * @param {(ref: object) => object | undefined} [read]  the graph's instance, which says whose an Operation is
 */
export function ownPageOf(ref, read) {
  if (!ref || ref.provider !== FRAMEWORK_REF.provider) return null;
  if (ref.type === 'Mod') return pathOf(ref.id);
  if (ref.type === 'CodexMods') return OVERVIEW_PATH;
  if (ref.type === 'CopyUpdate') return UPDATE_PATH;
  if (ref.type === 'Operation') {
    const mod = read?.(ref)?.links?.mod?.id;
    const there = mod ? read(modRef(mod)) : null;
    return there && !there.gone ? pathOf(mod, 'activity') : DEVELOPER_PATH;
  }
  if (ref.type === 'SettingsSection') { const m = /^mod:([^:]+)/.exec(ref.id); return m ? pathOf(m[1]) : OVERVIEW_PATH; }
  if (ref.type === 'Setting') { const i = ref.id.indexOf('/'); return i > 0 ? pathOf(ref.id.slice(0, i)) : null; }   // `<mod>/<key>[@<scope>]`
  return null;
}
/** What the settings pages need of the app: the route tree and the settings components. Without one of them there are no mod pages. */
export const NEEDS = Object.freeze(['routes', 'SettingsPageFrame', 'SettingsSection', 'SettingsCard', 'SettingsRow', 'NavGroup', 'NavItem']);
const ROUTE_MARK = '__codexmodsSettingsPage';
const STATE_KEY = 'local:settings-pages';
const FIRST_GROUP = 'settings.nav.heading.personal';   // the intl id of the app's first navigation group's heading

/** The route object whose path is `/settings`, searched through the tree (it is not at the top). */
export function findSettingsRoute(routes) {
  const stack = Array.isArray(routes) ? [...routes] : [];
  while (stack.length) {
    const r = stack.shift();
    if (!r || typeof r !== 'object') continue;
    if (r.path === '/settings' && Array.isArray(r.children)) return r;
    if (Array.isArray(r.children)) stack.push(...r.children);
  }
  return null;
}

/** Puts the given child routes ({id, path, element}) under the settings route, before its catch-all, replacing the ones put before. Returns how many. */
export function syncRoutes(settings, routes) {
  if (!settings) return 0;
  const kept = settings.children.filter((c) => !c?.[ROUTE_MARK]);
  const ours = routes.map((r) => ({ [ROUTE_MARK]: true, id: r.id, path: r.path, element: r.element }));
  const star = kept.findIndex((c) => c?.path === '*');
  settings.children.splice(0, settings.children.length, ...(star < 0 ? [...kept, ...ours] : [...kept.slice(0, star), ...ours, ...kept.slice(star)]));
  return ours.length;
}

/** Is this NavGroup the app's first navigation group (its heading is the Personal message)? */
export function isFirstGroup(props) {
  const t = props?.title;
  return !!t && typeof t === 'object' && t.props?.id === FIRST_GROUP;
}

let current = null;   // the window's settings pages (one runtime per page realm)
let starter = null;   // how the runtime starts them: the app's exposures may not be defined yet when it arrives, so it is tried again
/**
 * The window's settings pages, for its bindings; null when they cannot start. The runtime can arrive before the app's chunks have run
 * their exposure blocks, so a binding's render (by then the app's settings are on screen) starts them when the runtime could not.
 */
export const settingsPages = () => current ?? (starter ? starter() : null);
/** The runtime's way to start them (or null to stop trying). */
export function setSettingsPagesStarter(fn) { starter = typeof fn === 'function' ? fn : null; }

/**
 * @param {{ exports: () => object | null | undefined, observe: (ref: object) => { dispose(): void }, get: (ref: object) => object | undefined,
 *   watch: (ref: object, fn: () => void) => { dispose(): void }, ctx: object, log?: (m: string, d?: object) => void,
 *   subscribe?: (query: object, fn: Function) => { dispose(): void }, invoke?: (ref: object, op: string, args?: unknown[]) => Promise<object> }} o
 *   `subscribe` and `invoke`: the graph's, for the mods' settings (E3) and the pages' actions (E6.2)
 *   `pickFile`: the app's file chooser ({extensions} for a file, {directory: true} for a folder), for installing and updating
 *   `typeOf`: the graph's reflection of a type, for the DetailView (S11)
 *   `onModFault`: a fault
 *   in one, counted to its mod
 *   `pages`: the window's report of its Mods pages (../pages-status.mjs): they run once the route tree is reached, the navigation group
 *   has rendered and the framework's instance has been read; a fault in their boundary makes them failed (E6.1)
 */
export function startSettingsPages(o) {
  const x = o.exports() ?? {};
  const missing = NEEDS.filter((k) => { try { return !x[k]; } catch { return true; } });
  if (missing.length) { o.onMissing?.(missing); return null; }
  const { ctx } = o;
  const R = ctx.react();
  if (!R) return null;
  const state = { active: null, onSelect: null, navShown: 0 };
  const changed = () => ctx.local.touch(STATE_KEY);
  const pages = o.pages ?? null;
  // A fault in the navigation group or a page takes that part out (the app's settings go on) and reports the pages failed.
  const Boundary = typeof R.Component === 'function' ? class ModsPagesBoundary extends R.Component {
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(err) { o.log?.('settings pages: a fault', { message: String(err?.message ?? err) }); pages?.failed(`a fault: ${err?.message ?? err}`); }
    render() { return this.state?.failed ? null : this.props.children; }
  } : null;
  const guarded = (el) => (Boundary ? R.createElement(Boundary, null, el) : el);
  /** Navigate within Settings by the navigation's own `onSelect` (its guard for unsaved changes). */
  const navigate = (path) => { const go = state.onSelect; if (typeof go === 'function') go(ACTIVE_SECTION, undefined, path); };
  /** A root of the framework's own UI: no mod's style rule reaches inside (E6.4b); it adds no box. */
  const frameworkRoot = (child) => R.createElement('div', { 'data-codexmods-framework': '', style: { display: 'contents' } }, child);
  const Report = createReport(R, ctx);
  /** While its child is shown, the navigation marks `id` active (a mod's id, or one of the pages'); the pages are reported as a SettingsPage of the window's main view whose subject
   * is CodexMods or the Mod (E6.5); the DetailView reports itself. */
  function Shown({ id, mod, children }) {
    R.useEffect(() => { state.active = id; changed(); return () => { if (state.active === id) { state.active = null; changed(); } }; }, [id]);
    const subject = mod ? modRef(mod) : id === DETAIL ? null : id[0] === ':' ? FRAMEWORK_REF : modRef(id);
    return frameworkRoot(R.createElement(R.Fragment, null, children, R.createElement(Report, { type: 'SettingsPage', subject, place: { in: 'Window', slot: 'main' } })));
  }
  // The list's Review… opens the mod's page with its consent's Dialog.
  const reviews = new Set();
  const review = (id) => { reviews.add(id); navigate(pathOf(id)); };
  const takeReview = (id) => reviews.delete(id);
  // What the band asked the Update page to open (its update's review), taken by the page when it is shown, or at once when it already
  // is (E6 review): read with ctx.local, so a shown page hears it
  const intents = new Set();
  const INTENT_KEY = 'local:intents';
  const invoke = o.invoke ?? (() => Promise.reject(new Error('the graph cannot be acted on here')));
  const dialogs = createDialogs({ R, exports: o.exports, ctx });
  // the kit, drawing through the app's pieces where it has them, asked again each time, as the chunks arrive late
  const kit = createKit({ react: () => R, parts: () => { const ex = o.exports() ?? {}; return { Button: ex.Button, Menu: ex.Menu, MenuItem: ex.MenuParts?.Item, Separator: ex.MenuParts?.Separator }; } });
  const common = createPageCommon({ R, kit, exports: o.exports, invoke, frameworkRef: FRAMEWORK_REF, dialogs });
  const overview = createModsOverview({ R, ctx, kit, common, LayoutsSection: o.LayoutsSection ?? null, exports: o.exports, invoke, pickFile: o.pickFile, navigate, frameworkRef: FRAMEWORK_REF, pathOf, review, dialogs });
  const overviewElement = guarded(R.createElement(Shown, { id: OVERVIEW }, R.createElement(overview.Overview)));
  const updatePage = createUpdatePage({ R, ctx, kit, common, exports: o.exports, invoke, frameworkRef: FRAMEWORK_REF, dialogs, takeIntent: (k) => intents.delete(k), hasIntent: (k) => { ctx.local.read(INTENT_KEY); return intents.has(k); },
    ...(o.subscribe ? { subscribe: o.subscribe } : {}) });
  const updateElement = guarded(R.createElement(Shown, { id: UPDATE }, R.createElement(updatePage.UpdatePage)));
  const developerPage = createDeveloperPage({ R, ctx, common, exports: o.exports, invoke, pickFile: o.pickFile, frameworkRef: FRAMEWORK_REF, dialogs });
  const developerElement = guarded(R.createElement(Shown, { id: DEVELOPER }, R.createElement(developerPage.DeveloperPage)));
  // The DetailView (S11): what it shows is the window's own (read with ctx.local), set before it is navigated to
  let detailRef = null;
  const setDetail = (ref) => { detailRef = ref ? { type: ref.type, provider: ref.provider, id: ref.id } : null; ctx.local.touch(DETAIL_KEY); };
  const openOwn = (ref) => { const path = ownPageOf(ref, o.get); if (!path) return; if (ref.type === 'CopyUpdate') { intents.add('update'); ctx.local.touch(INTENT_KEY); } navigate(path); };
  const detail = createDetailView({ R, ctx, exports: o.exports, invoke, typeOf: (t) => o.typeOf?.(t) ?? null, observe: (ref) => o.observe(ref),
    current: () => { ctx.local.read(DETAIL_KEY); return detailRef; }, show: (ref) => { setDetail(ref); navigate(DETAIL_PATH); }, ownPage: (ref) => ownPageOf(ref, o.get), openOwn, dialogs });
  const detailElement = guarded(R.createElement(Shown, { id: DETAIL }, R.createElement(detail.DetailPage)));
  const rows = o.subscribe && o.invoke ? createSettingRows({ R, kit, exports: o.exports, subscribe: o.subscribe, invoke: o.invoke, ctx, log: o.log }) : null;
  const { ModPage, NotInstalled } = createModPage({ R, ctx, kit, common, exports: o.exports, invoke, ...(o.subscribe ? { subscribe: o.subscribe } : {}), pickFile: o.pickFile, navigate, frameworkRef: FRAMEWORK_REF, overviewPath: OVERVIEW_PATH, pathOf, ownPathOf: pagePathOf,
    rows, dialogs, takeReview, onModFault: o.onModFault, lostRulesOf: o.lostRulesOf, showDetail: (ref) => { setDetail(ref); navigate(DETAIL_PATH); },
    ownTabs: (modId) => { ctx.local.read(STATE_KEY); return [...ownPages.values()].filter((p) => p.mod === modId && p.group === 'mods'); },
    renderOwn: (modId, id) => { const p = ownPages.get(`${modId}/${id}`); return p && o.node ? o.node(p.rule, p.render, { mod: p.mod, page: p.id }) : null; } });
  const goneElement = guarded(R.createElement(Shown, { id: GONE }, R.createElement(NotInstalled)));

  // ---------------------------------------------------------------- a mod's own pages (ui.settings.page, E8.9a)
  // In the Mods group each is a tab of its mod's page; in one of the app's own groups, a route under its mod's, drawn in the app's frame with its title, the mod's component in its
  // rule's boundary, with its entry in that group. A page comes and goes as its mod runs, so its route stays while the mod is installed.
  let ownPages = new Map();   // key `${mod}/${id}` -> { key, mod, id, title, group, render, rule }: registered now
  const knownPages = new Map();   // the same, for every page seen while its mod is installed
  const pageId = (p) => `page:${p.key}`;
  function OwnPage({ pageKey }) {
    const p = ctx.use(() => { ctx.local.read(STATE_KEY); return ownPages.get(pageKey) ?? null; });
    const ex = o.exports();
    const Frame = ex?.SettingsPageFrame;
    if (!Frame) return null;
    if (!p) { const k = knownPages.get(pageKey); return R.createElement(Frame, { title: k?.title ?? 'Mods' }, R.createElement(kit.EmptyState, { glyph: 'plugin', title: 'This page isn\u2019t available', description: 'The mod it belongs to isn\u2019t running.', ...(k ? { actions: [{ label: 'Open the mod', onClick: () => navigate(pathOf(k.mod)) }] } : {}) })); }
    return R.createElement(Frame, { title: p.title }, o.node ? o.node(p.rule, p.render, { mod: p.mod, page: p.id }) : null);
  }
  const ownElements = new Map();   // key -> its route element (one per page, kept while it is known)
  const ownElementOf = (p) => {
    let el = ownElements.get(p.key);
    if (!el) {
      el = p.group === 'mods' ? guarded(R.createElement(Shown, { id: p.mod }, R.createElement(ModPage, { modId: p.mod, tab: `~${p.id}` })))
        : guarded(R.createElement(Shown, { id: pageId(p), mod: p.mod }, R.createElement(OwnPage, { pageKey: p.key })));
      ownElements.set(p.key, el);
    }
    return el;
  };
  const pageItem = (Item, p) => R.createElement(Item, { key: `codexmods:${p.key}`, icon: R.createElement(kit.Glyph, { name: 'plugin' }), label: p.title, isActive: state.active === pageId(p), weightClassName: 'font-normal',
    onClick: () => navigate(pagePathOf(p.mod, p.id)) });

  // ---------------------------------------------------------------- the navigation group
  const ModsGroup = () => guarded(frameworkRoot(R.createElement(ModsGroupEntries)));
  /** The Update entry's trailing text: what the update is at, else what it brings: a build, or a framework alone. */
  const updateTrailing = (u) => (u?.state === 'ready' ? 'Ready' : u?.state === 'downloading' ? 'Preparing' : u?.build?.to ? shortBuild(u.build.to) : text(u?.framework?.to) || text(u?.version));
  function ModsGroupEntries() {
    // the route tree is there whenever Settings is; while this group is mounted, Settings' navigation (and its guard) is on screen
    R.useEffect(() => { sync(); pages?.mounted('nav'); state.navShown = (state.navShown | 0) + 1; return () => { state.navShown = Math.max(0, (state.navShown | 0) - 1); }; }, []);
    const ex = o.exports();
    const { NavGroup: Group, NavItem: Item } = ex;
    const { mods, update } = ctx.use(() => {
      ctx.local.read(STATE_KEY);
      const st = readState(ctx, FRAMEWORK_REF);
      return { mods: (st?.mods ?? []).map(({ mod }) => (mod && !mod.gone ? mod.state ?? {} : {})), update: st?.update && !st.update.gone ? st.update.state ?? {} : null };
    });
    const e = R.createElement;
    const entry = (key, label, glyph, active, path, meta) => e(Item, { key, icon: e(kit.Glyph, { name: glyph }), label, isActive: active, weightClassName: 'font-normal', onClick: () => navigate(path),
      ...(meta ? { trailing: e('span', { className: 'cmk-meta' }, meta) } : {}) });
    const active = state.active;
    const issues = issuesIn(mods);
    return e(Group, { title: 'Mods' },
      ...(update ? [entry(UPDATE, 'Update', 'download', active === UPDATE, UPDATE_PATH, updateTrailing(update))] : []),
      entry(OVERVIEW, 'Mods', 'plugin', Boolean(active) && active !== UPDATE && active !== DEVELOPER && !active.startsWith('page:'), OVERVIEW_PATH, issues ? `${issues} issue${issues === 1 ? '' : 's'}` : String(mods.length)),
      entry(DEVELOPER, 'Developer', 'terminal', active === DEVELOPER, DEVELOPER_PATH));
  }

  // ---------------------------------------------------------------- the routes, in step with the mods
  const settings = () => findSettingsRoute(o.exports()?.routes);
  const elements = new Map();   // `${mod}/${tab}` -> its route element (one per page, kept while the mod is installed)
  const elementOf = (id, tab) => { const k = `${id}/${tab ?? ''}`; let el = elements.get(k); if (!el) { el = guarded(R.createElement(Shown, { id }, R.createElement(ModPage, { modId: id, tab }))); elements.set(k, el); } return el; };
  let installed = null;   // the mod ids whose routes are in the tree (with the pages'), once they are
  function sync() {
    const fw = o.get(FRAMEWORK_REF);
    if (fw && !fw.gone) pages?.mounted('read');
    const ids = fw && !fw.gone ? (fw.links?.mods ?? []).map((r) => r.id).filter((id) => typeof id === 'string') : [];
    // a page stays while its mod is installed; an internal mod's (never in the user's list) while it is registered
    for (const [k, p] of [...knownPages]) if (!ids.includes(p.mod) && !(INTERNAL_MOD_IDS.includes(p.mod) && ownPages.has(k))) { knownPages.delete(k); ownElements.delete(k); }
    const own = [...knownPages.values()];
    const key = [...ids, '|', ...own.map((p) => p.key)].join('\u001f');
    if (key === installed) return;
    for (const k of [...elements.keys()]) if (!ids.includes(k.slice(0, k.lastIndexOf('/')))) elements.delete(k);
    try {
      const tree = settings();
      if (!tree) return;
      syncRoutes(tree, [{ id: 'codexmods', path: 'codexmods', element: overviewElement }, { id: 'codexmods-update', path: 'codexmods/~update', element: updateElement },
        { id: 'codexmods-developer', path: 'codexmods/~developer', element: developerElement }, { id: 'codexmods-detail', path: 'codexmods/~detail', element: detailElement },
        ...ids.flatMap((id) => [{ id: `codexmods-${id}`, path: `codexmods/${id}`, element: elementOf(id, undefined) },
          { id: `codexmods-${id}-permissions`, path: `codexmods/${id}/permissions`, element: elementOf(id, 'permissions') },
          { id: `codexmods-${id}-activity`, path: `codexmods/${id}/activity`, element: elementOf(id, 'activity') }]),
        ...own.map((p) => ({ id: `codexmods-${p.mod}-~${p.id}`, path: `codexmods/${p.mod}/~${p.id}`, element: ownElementOf(p) })),
        { id: 'codexmods-gone', path: 'codexmods/*', element: goneElement }]);
      installed = key;
      pages?.mounted('routes');
    } catch (err) { o.log?.('settings pages: the routes could not be changed', { message: String(err?.message ?? err) }); }
  }
  const view = o.observe(FRAMEWORK_REF);
  const watcher = o.watch(FRAMEWORK_REF, sync);
  sync();

  current = {
    state,
    ModsGroup,
    /** The navigation's own `onSelect`, kept for the Mods entries (its guard for unsaved changes applies to them). */
    setOnSelect(fn) { state.onSelect = typeof fn === 'function' ? fn : null; },
    /** The Update page opens this when it is next shown ('update': the update's review). */
    intend(kind) { intents.add(kind); ctx.local.touch(INTENT_KEY); },
    /** What the DetailView shows when it is next shown (S11). */
    setDetail,
    read() { ctx.local.read(STATE_KEY); return state.active; },
    /** The mods' own pages (the runtime gives them as their rules change): routes and navigation entries follow. */
    setOwnPages(list) {
      // routes match without regard to case: of two pages of a mod whose ids differ only in case, the first in order keeps its route
      const seen = new Set();
      ownPages = new Map((Array.isArray(list) ? list : []).filter((p) => {
        if (!p || typeof p.key !== 'string') return false;
        const k = p.key.toLowerCase();
        if (seen.has(k)) { o.log?.('settings pages: a page id differs from another only in case', { page: p.key }); return false; }
        seen.add(k);
        return true;
      }).map((p) => [p.key, p]));
      for (const p of ownPages.values()) knownPages.set(p.key, p);
      sync();
      changed();
    },
    /** The navigation entries of the mods' pages in one of the app's own groups (read in that group's render). */
    entriesFor(group) {
      ctx.local.read(STATE_KEY);
      const Item = o.exports()?.NavItem;
      if (!Item || !group) return [];
      return [...ownPages.values()].filter((p) => p.group === group).map((p) => pageItem(Item, p));
    },
    /** Navigate within Settings by its navigation's own `onSelect` (its unsaved-changes guard): false when Settings is not open. */
    go(path) { if (typeof state.onSelect !== 'function' || !(state.navShown > 0)) return false; navigate(path); return true; },
    /** Is this mod's own page registered here? */
    hasPage: (mod, id) => ownPages.has(`${mod}/${id}`),
    dispose() {
      try { watcher.dispose(); view.dispose(); } catch { /* gone */ }
      try { syncRoutes(settings(), []); } catch { /* the app's tree went first */ }
      if (current?.state === state) current = null;
    },
  };
  return current;
}
