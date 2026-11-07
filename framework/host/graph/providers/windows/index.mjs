// The windows provider (docs/design/systems.md S10, "E2c in detail"): what is on screen, as Presentation instances of their Window. Each
// Codex window's page reports its presentations (framework/renderer/present/instances.mjs): a generation per page load, then batches of
// puts and removes, and its user actions as events of their own. This provider keeps them in the graph:
// - a Window per window whose page reports, its subject the App, put once its page has said whether its sidebar is open, removed when
//   framework-main says the window closed;
// - its presentations under the page's generation (`<window>.<generation>.<n>`), all removed when that page goes (a reload, a closed
//   channel): a ref of an older generation is gone, so acting on it is refused. A ref names one subject in one place: a put that changes
//   them removes the presentation (the page numbers a new one);
// - each presentation's parent, from the place its binding states (`in`: the parent's presentation type; `via`: the subject's relation
//   that leads to the parent's subject, or none for the same subject): the subject's own link, then the presentations of that subject in
//   the same window and generation, the first presented. Absent while that parent is not presented (never guessed): looked for again when
//   a presentation of its type arrives, when the subject arrives or changes (a graph event) and when its parent goes;
// - the Window's `current` is the subject of its newest main view (its child in the `main` slot), and `history` the subjects it showed,
//   as observed (at most HISTORY; the app's own back and forward stack is private to its router); its arrangement (`navigation`,
//   `sidebar`, `side`, `bottom`, `layout`: docs/design/layouts.md §4) is what its page reads from the app's shell (the side panel is kept
//   per thread by the app, so it follows what is shown; the SidePanel's presentation stays while the panel is closed), `fullScreen` what
//   framework-main says;
// - events: `shown` and `hidden` when a presentation's hidden changes, `selected` when it becomes selected, `acted` for a user action, and
//   the Window's `opened`, `navigated` and `closed`.
// Operations go by ROUTES ("E7 in detail" decision 3). framework-main's `windows` area acts on the window the app's way (the messages the
// app's main sends its pages, its app actions in that window, Electron): Window.open (a thread, by the id the app knows it by, or a
// settings section), back, forward, focus, toggleSidebar, togglePanel and close (the app may hide its last window, or ask first);
// SidebarItem.select and StatusItem.open (the window opens the subject); the rename dialog of the chat a window shows; a project group's
// collapse, expand and show more; Composer.focus. Such a message tells the page and says nothing back: `done` is its delivery. What
// changes only what a window shows goes to the page of the presentation's generation as an `act` message, done by its binding over the
// mount's committed props (the app's own callbacks), its arguments first made the app's own where the page cannot (PREPARE: a turn as
// the app's turn id); the page answers (done, refused or failed) and an act it has not answered in ACT_MS failed. Anything more is the subject's own operation, invoked as the caller. Presentations outside a window (desktop notifications, the
// Dock, the menu bar) are reported by framework-main the same way once a binding presents one (E7.6). Node built-ins only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { CodexModsError } from '../../../../../sdk/errors.mjs';
import { isRef } from '../../types.mjs';
import { askValueOf } from '../../../packages/settings.mjs';

/** The provider id in refs (reserved: no mod can claim it, graph/policy.mjs). */
export const PROVIDER = 'codexmods.windows';
const HISTORY = 50;
const DESKTOP = 'desktop';   // the presentations outside a window (decision 5) are numbered here
export const ACT_MS = 5000;   // how long an act in the page may take before it failed
const SHOW_TRIES = 30, SHOW_EVERY_MS = 100;   // how long a chat Window.open showed may take to be reported (3 s)
/** The sidebar's kept width (the app's `sidebar-width` as a Setting: framework-main app-state.cjs) and the app's built-in one. */
const SIDEBAR_WIDTH = Object.freeze({ type: 'Setting', provider: 'codex', id: 'layout.sidebarWidth' });
const APP_SIDEBAR_WIDTH = 340;
const NEW_WINDOW_TRIES = 100;                 // how long a new window (App.openWindow) may take to come and its page to report (10 s)
const LOAD_MS = 3000;         // how long a subject that is not resident may take to load before its operation is tried
const MAX_PUTS = 1000;       // per batch: a page sends at most 200 (instances.mjs); anything beyond is a broken page

/** The pane an operation names, for the time it runs (layouts.md D8). A pane is an opaque token, `route` the window's own page. */
const paneNamed = new AsyncLocalStorage();
const paneKey = (pane) => pane ?? 'route';

export const refs = Object.freeze({
  window: (windowId) => Object.freeze({ type: 'Window', provider: PROVIDER, id: String(windowId) }),
  presentation: (type, windowId, gen, n) => Object.freeze({ type, provider: PROVIDER, id: `${windowId}.${gen}.${n}` }),
  // a region of the window's frame (layouts.md D1): one per window, named by its slot
  region: (type, windowId, slot) => Object.freeze({ type, provider: PROVIDER, id: `${windowId}.${slot}` }),
  app: () => Object.freeze({ type: 'App', provider: 'codex', id: 'codex' }),
});

/** The presentation types this provider puts: the ones the framework's bindings present, and Window. */
const TYPES = ['Window', 'TitleBar', 'Rail', 'MainRegion', 'BottomPanel', 'SidebarSection', 'SidebarItem', 'ThreadView', 'ThreadHeader', 'TurnView', 'MessageBlock', 'StepBlock', 'RequestCard',
  'Composer', 'Chip', 'StatusItem', 'PaletteResult', 'FilesView', 'NewThreadView', 'SettingsPage', 'Menu', 'QueueItem', 'ComposerPicker', 'Sidebar', 'Palette',
  'SidePanel', 'PanelTab', 'FilePreview', 'TerminalView', 'BrowserView', 'AutomationView', 'ChangesView', 'DiffView', 'DockBadge', 'MenuEntry', 'ListItem', 'PlanView'];
/** The framework's own presentations (E6.5), reported read-only by its pages, Dialogs, band and pickers: put, but not features of the app's
 * build, so not in `realizes.types` (the feature log advertises those); DetailView waits for its route. */
export const FRAMEWORK_TYPES = Object.freeze(['SettingsRow', 'Dialog', 'NotificationBanner', 'ComposerPicker', 'DetailView', 'Page', 'Region']);

/**
 * How each presentation operation is done ("E7 in detail" decision 3): `page` (what changes only what the window shows: its binding, over
 * the mount's committed props), `main` (framework-main, the app's way), or `{subject, then?}` (anything more: the subject's own
 * operation, invoked as the caller, with its grants, interceptors, approvals and outcomes; `then`, a page operation after it is done).
 */
export const ROUTES = Object.freeze({
  // openPalette, find (graph-layers.md §3.3): the public form of the Palette's open and the ThreadView's find, on the addressable Window
  Window: { focusPane: 'main', open: 'main', back: 'main', forward: 'main', focus: 'main', toggleSidebar: 'main', togglePanel: 'main', setSidebar: 'main', setPanel: 'main', setLayout: 'main', setRegion: 'main', openBrowser: 'main', close: 'main', openPalette: 'main', find: 'main' },   // setLayout: in the page, through its SidePanel (below)
  Sidebar: { newThread: 'main', filter: 'page' },   // filter: which chats the sidebar lists, in the page (E8.9j)
  Palette: { open: 'main', close: 'page' },
  SidebarSection: { collapse: 'main', expand: 'main', showMore: 'page' },   // showMore: the app's own expander state (E8.9)
  SidebarItem: { select: 'main', rename: 'main' },
  ThreadHeader: { rename: 'main' },
  ThreadView: { scrollTo: 'page', jumpToLatest: 'page', find: 'page' },   // the turn as the app's own id (PREPARE); find: the app's find bar
  TurnView: { collapse: 'page', expand: 'page' },
  StepBlock: { expand: 'page', collapse: 'page' },   // the app's step: its row's own chevron (G5.1)
  // insert: its Draft's, text or a mention as the Draft's Content, written in that composer's window (review 4)
  Composer: { focus: 'main', insert: 'main' },
  Chip: { open: { subject: 'open' }, remove: 'page' },
  PaletteResult: { choose: { subject: 'run', then: 'close' } },
  StatusItem: { open: 'main' },
  FilesView: { select: 'page', filter: 'page' },
  SidePanel: { open: 'main', close: 'main', resize: 'page' },   // resize: the app's own drag, in the page (E8.9)
  PanelTab: { select: 'page', close: 'page', move: 'page' },
  BrowserView: { focus: 'page' },
  TerminalView: { focus: 'page', copySelection: 'page' },
  ChangesView: { selectFile: 'page', setScope: 'page' },   // the list's selection; what the tab shows (the app remembers the last)
  DiffView: { commentOn: 'page', openFile: 'page' },   // the app's comment editor at lines; the file's tab opened in the panel
  QueueItem: { edit: 'page', sendNow: { subject: 'sendNow' }, remove: { subject: 'remove' }, move: { subject: 'move' } },
  ComposerPicker: { open: 'page', choose: { subject: 'set' } },
  Dialog: { confirm: 'ask', cancel: 'ask' },   // a mod's Dialog (decision 7): settled by the mod that asked, here
  // Outside a window (decision 5): a desktop notification's banner is its Notification's own; the Dock's badge framework-main holds.
  NotificationBanner: { open: { subject: 'open' }, dismiss: { subject: 'dismiss' } },
  DockBadge: { set: 'main', attention: 'main' },
  MenuEntry: { choose: 'main' },   // one of the app's own menu bar entries: a click on it, in framework-main (E8.4b)
});
/** Page operations whose effect leaves the window (journaled as the caller's, decision 3): the terminal's copy writes the clipboard. */
const EXTERNAL = new Set(['TerminalView.copySelection']);
/** framework-main's operations a mod's call asks the user about first, as the subject's own would (a page in the signed-in browser). */
const APPROVALS = Object.freeze({
  Window: { openBrowser: ({ args }) => ({ action: `open ${String(args[0]).slice(0, 300)} in the in-app browser`, detail: 'The in-app browser loads it with its own sign-ins and cookies.' }) },
});
/** The operations a presentation's page does, through its binding: type -> names. */
export const PAGE_OPERATIONS = Object.freeze(Object.fromEntries(Object.entries(ROUTES)
  .map(([t, ops]) => [t, [...Object.entries(ops).filter(([, r]) => r === 'page').map(([n]) => n), ...Object.values(ops).map((r) => r?.then).filter(Boolean)]])
  .filter(([, l]) => l.length)));

/**
 * A presentation operation's name in the graph: the Window's as it is; every other presentation's instances are the mechanism layer
 * (docs/design/graph-layers.md §2), their operations `_name` (the page's binding keeps the plain name).
 */
export const graphOp = (type, name) => (type === 'Window' ? name : `_${name}`);
/** What the provider declares (for coverage, as the native provider's realizes.mjs). */
export const realizes = {
  types: TYPES,
  operations: Object.fromEntries(Object.entries(ROUTES).map(([t, ops]) => [t, Object.keys(ops).map((n) => graphOp(t, n))])),
  supports: { Presentation: ['selected', 'expanded', 'focused', 'size'], Window: ['navigation', 'layout', 'title', 'position'], SidePanel: ['open'], DiffView: ['layout'] },   // `order` once a binding can tell a presentation's place in its slot
  events: { Presentation: ['shown', 'hidden', 'selected', 'acted'], Window: ['opened', 'navigated', 'closed'] },
  links: { Presentation: ['subject', 'window', 'parent'] },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The presentations whose own state says whether they are open (a panel's). */
const OPENS = new Set(['SidePanel', 'BottomPanel']);
/** A size as a presentation says it ({width?, height?} in px), or null. */
const sizeOf = (v) => {
  if (!isObject(v)) return null;
  const out = {};
  for (const k of ['width', 'height']) if (Number.isFinite(v[k]) && v[k] >= 0 && v[k] <= 100000) out[k] = Math.round(v[k]);
  return Object.keys(out).length ? out : null;
};
const sameRef = (a, b) => !!a && !!b && a.type === b.type && a.provider === b.provider && a.id === b.id;
const plainRef = (r) => Object.freeze({ type: r.type, provider: r.provider, id: r.id });
const DECORATION_KINDS = new Set(['badge', 'icon', 'label', 'tooltip', 'action']);

/**
 * @param {{ graph: object, mainOps?: { op(area: string, op: string, args?: object): Promise<object> } | null, bus?: object, log?: object,
 *   now?: () => number, routes?: Record<string, Record<string, string | object>>, setTimeout?: Function, clearTimeout?: Function }} o
 *   `routes` replaces ROUTES (tests)
 */
export function createWindowsSource(o) {
  const { graph } = o;
  const log = o.log ?? { info() {}, warn() {} };
  const now = o.now ?? Date.now;
  const setT = o.setTimeout ?? globalThis.setTimeout;
  const clearT = o.clearTimeout ?? globalThis.clearTimeout;
  const routes = o.routes ?? ROUTES;
  const windows = new Map();   // windowId -> { ref, gen, arrangement, fullScreen, current, history, put }
  const sidebarCalls = new Map();   // windowId -> the last Window.setSidebar call's promise (they run one at a time)
  const items = new Map();     // presentation id -> { ref, windowId, gen, n, type, subject, subjectKey, place, state, parent, written }
  const bySubject = new Map();   // subject key -> its presentations
  const orphans = new Map();     // parent presentation type -> the presentations that wait for one
  const mains = new Map();       // window id -> its main views (the presentations in its `main` slot)
  const fullScreens = new Map(); // window id -> what framework-main said
  const owns = new Map();        // window id -> what framework-main said of it (G5.5): {hasFocus?, title?, bounds?}
  const acts = new Map();        // act id -> { windowId, gen, settle } (an act the page has not answered yet)
  let genSeq = 0, actSeq = 0, disposed = false;
  const stats = { batches: 0, puts: 0, removes: 0, events: 0, bytes: 0, maxReportMs: 0 };

  // eslint-disable-next-line codexmods/no-provider-identity -- the windows provider's own presentations
  const windowOf = (ref) => (ref?.provider === PROVIDER ? (ref.type === 'Window' ? windows.get(Number(ref.id)) : windows.get(Number(String(ref.id).split('.')[0]))) : null);

  // ---------------------------------------------------------------- operations: the window that owns the presentation, the app's way
  async function main(op, args) {
    if (!o.mainOps) return { status: 'refused', reason: 'unavailable', message: 'framework-main is not running' };
    const r = await o.mainOps.op('windows', op, args);
    if (r.ok) return { status: 'done', value: null };
    return r.refused ? { status: 'refused', reason: 'unavailable', message: r.error } : { status: 'failed', error: { message: r.error } };
  }
  /** A ThreadView of `thread` in the window's current page, once it is reported (null when none comes in time). */
  async function viewOf(windowId, thread) {
    for (let i = 0; i < SHOW_TRIES; i++) {
      const w = windows.get(windowId);
      const v = [...items.values()].filter((it) => it.type === 'ThreadView' && it.windowId === windowId && w && it.gen === w.gen && it.subject && sameRef(it.subject, thread)).sort((a, b) => b.n - a.n)[0];
      if (v) return v;
      await new Promise((r) => { const t = setT(r, SHOW_EVERY_MS); t?.unref?.(); });
    }
    return null;
  }
  /**
   * Open `target` (a ref) in the window (graph-layers.md §3.2): a thread (Codex's; a mod's in its own view); a turn, a message or a step
   * (its chat, then that turn in it); a draft (its chat, or the new chat, its composer focused); a project (its new chat); a file (the
   * app's own preview); an automation (its own `open`, as the caller); the settings of a section; else the DetailView.
   */
  async function open(windowId, target, call = null) {
    // a mod's page (layouts.md D7): {page: '<mod>/<id>'}; one no mod declares (now) still opens, and says so with the mod's name
    if (target && typeof target === 'object' && typeof target.page === 'string') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.page)) return { status: 'refused', reason: 'invalid', message: 'a page is named <mod>/<id>' };
      const w = windows.get(windowId);
      const gen = w?.gen ?? null;
      // delivery is not being there: a window whose page is not running (a reload) cannot say it shows it
      if (gen === null) return gone('no page runs in that window');
      const r = await main('open', { windowId, page: target.page });
      if (r.status !== 'done') return r;
      return shown(w, gen, () => facts(w)?.page === target.page, 'open', 'the window does not show that page');
    }
    if (!isRef(target)) return { status: 'refused', reason: 'invalid', message: 'open takes a ref or {page}' };
    // the app's own chat in its thread view; a mod's is drawn in the view its subtype registers (graph-integrity G2.2), by the window's
    // page below
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own chat
    if (graph.type(target.type)?.chain.includes('Thread') && target.provider === 'codex') return main('open', { windowId, threadId: target.id });
    if (isA(target, 'Turn') || isA(target, 'Message') || isA(target, 'Step')) {
      const turn = isA(target, 'Turn') ? plainRef(target) : graph.resolve(target)?.links?.turn ?? null;
      const thread = isRef(turn) ? graph.resolve(turn)?.links?.thread ?? null : null;
      if (!isRef(thread)) return gone('its chat is not known');
      const shown = await open(windowId, thread);
      if (shown?.status !== 'done') return shown;
      const view = await viewOf(windowId, thread);
      if (!view) return gone('its chat was not shown in time');
      const args = turnIn(graph.resolve(view.ref) ?? { links: { subject: view.subject } }, turn);
      return Array.isArray(args) ? inPage(view.ref, 'scrollTo', args) : args;
    }
    if (isA(target, 'Draft')) {
      const thread = graph.resolve(target)?.links?.thread ?? null;
      // a chat's draft, or the new chat's; another without a chat (the panel's new chat) is not the window's main view
      // eslint-disable-next-line codexmods/no-provider-identity -- the app's own new-chat draft
      if (!isRef(thread) && !(target.provider === 'codex' && target.id === 'new:app:new-conversation')) return { status: 'refused', reason: 'unsupported', message: 'that draft is not shown in a window\'s main view' };
      const shown = isRef(thread) ? await open(windowId, thread) : await main('newChat', { windowId });
      if (shown?.status !== 'done') return shown;
      return main('focusComposer', { windowId });
    }
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own projects
    if (isA(target, 'Project') && target.provider === 'codex') {
      if (!o.mainOps) return gone('framework-main is not running');
      const r = await o.mainOps.op('composer', 'new-chat', { projectId: target.id, windowId });
      return r.ok ? { status: 'done', value: null } : r.refused ? gone(r.error) : { status: 'failed', error: { message: r.error } };
    }
    // eslint-disable-next-line codexmods/no-provider-identity -- a file of this Mac, in the app's tabs
    if (isA(target, 'File') && target.provider === 'codex') return main('appAction', { windowId, action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: target.id } } });
    if (isA(target, 'Automation') && call) return graph.invoke({ ref: plainRef(target), operation: 'open', args: [{ window: refs.window(windowId) }], caller: call.caller, origin: call.origin });
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own settings sections
    if (target.type === 'SettingsSection' && target.provider === 'codex') return main('open', { windowId, settings: target.id });
    // anything else (S11): the window's page shows it, the framework's own page for a framework-owned instance, else the DetailView
    if (typeof o.showDetail === 'function' && o.showDetail(windowId, plainRef(target))) return null;
    return { status: 'refused', reason: 'unsupported', message: `a window does not open a ${target.type} yet` };
  }
  const live = (ref) => {
    const w = windowOf(ref);
    if (!w) throw new CodexModsError('Unavailable', 'the window is gone');
    return w;
  };
  const gone = (message) => ({ status: 'refused', reason: 'unavailable', message });
  /** Do `operation` in the page of the presentation's generation, through its binding: the page's answer, or failed after ACT_MS. */
  function inPage(ref, operation, args) {
    const it = items.get(String(ref.id));
    const w = it ? windows.get(it.windowId) : null;
    if (!it || !w || w.gen !== it.gen || !w.channel) return gone('the presentation is no longer shown');
    return posted(w, it.gen, { t: 'act', n: it.n, operation, args: Array.isArray(args) ? args : [] });
  }
  /** The window's arrangement as its page now said it, or null (a reload's page has not said it yet: the old page's no longer counts). */
  const facts = (w) => (w.gen !== null && w.factsGen === w.gen ? w.arrangement : null);
  /** Wait until the window's page `gen` shows what was asked (`ok()`): done; failed with `why` when it shows something else; uncertain
   *  when that page went meanwhile (a reload: what it said no longer counts). */
  async function shown(w, gen, ok, operation, why) {
    for (let i = 0; i < SHOW_TRIES && w.gen === gen && !ok(); i++) await new Promise((res) => { const t = setT(res, SHOW_EVERY_MS); t?.unref?.(); });
    if (w.gen !== gen) return { status: 'uncertain', operation };
    if (ok()) return { status: 'done', value: null };
    // a window in the background draws no frame (its animations wait): it shows what was asked once it is in front, so not failed
    return w.pageHidden ? { status: 'uncertain', operation } : { status: 'failed', error: { message: why } };
  }
  /** A mod's region in a window (layouts.md WL4a): set in its page (the declaration's own act), done once the page says it so. */
  async function modRegion(w, key, want) {
    if (!/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/.test(key)) return { status: 'refused', reason: 'invalid', message: 'a region is sidebar, side, bottom or a mod\'s <mod>/<id>' };
    const gen = w.gen;
    if (gen === null || !w.channel) return gone('no page runs in that window');
    const r = await posted(w, gen, { t: 'decl-act', key, op: 'region.set', args: { ...(typeof want.open === 'boolean' ? { open: want.open } : {}), ...(want.size !== undefined ? { size: want.size } : {}) } });
    if (r.status !== 'done') return r;
    const out = await shown(w, gen, () => { const x = facts(w)?.regions?.[key]; return !!x && (want.open === undefined || x.open === want.open) && (want.size === undefined || Math.abs((x.size ?? 0) - want.size) <= 2); },
      'setRegion', `the window shows the region ${key} otherwise (its width stays within its bounds)`);
    // held for space (layouts.md D12): set, and shown once the window has room again
    return out.status === 'failed' && want.open !== false && (facts(w)?.suspended ?? []).includes(key) ? { status: 'uncertain', operation: 'setRegion' } : out;
  }
  /** The presentation of a type the window's page shows now: the one on the chat the window shows where it shows one (a page the app
   *  keeps for later stays mounted), else the newest. */
  function shownItem(w, type) {
    const mine = [...items.values()].filter((it) => it.type === type && it.windowId === w.windowId && it.gen === w.gen).sort((a, b) => b.n - a.n);
    const thread = w.place?.thread ?? null;
    return (thread && mine.find((it) => it.subject && sameRef(it.subject, thread))) || mine[0] || null;
  }
  /** The app's sidebar toggled only when it is not already as asked (its page reports whether it is open), one call at a time per window,
   *  each done once the page says it is as asked (a second call sees what the first did, never a report not yet made). */
  function sidebarTo(w, want, operation) {
    const run = (sidebarCalls.get(w.windowId) ?? Promise.resolve()).then(async () => {
      const gen = w.gen;
      if (gen === null) return gone('no page runs in that window');
      const open = () => facts(w)?.sidebar?.open;
      if (open() === want) return { status: 'done', value: null };
      // the app's core setter, in its page: its toggle is the "by hand" one, which looks like the user's and stops the app's own collapse in a narrow window (layouts.md D11); a page that has no such setter, the toggle
      let r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'sidebar.open', args: { open: want } });
      if (r.status === 'refused') r = await main('toggleSidebar', { windowId: w.windowId });
      if (r.status !== 'done') return r;
      for (let i = 0; i < SHOW_TRIES && w.gen === gen && open() !== want; i++) await new Promise((res) => { const t = setT(res, SHOW_EVERY_MS); t?.unref?.(); });
      return w.gen === gen && open() === want ? { status: 'done', value: null } : { status: 'uncertain', operation };
    });
    const tail = run.catch(() => {}).then(() => { if (sidebarCalls.get(w.windowId) === tail) sidebarCalls.delete(w.windowId); });
    sidebarCalls.set(w.windowId, tail);
    return run;
  }
  /** Post `body` to the page of `w` (generation `gen`) as an act it answers once: the graph's outcome (outcomeOf), or failed in time. */
  function posted(w, gen, body) {
    const id = ++actSeq;
    return new Promise((resolve) => {
      let timer = null;
      const settle = (outcome) => { if (!acts.delete(id)) return; if (timer !== null) clearT(timer); resolve(outcome); };
      const act = { windowId: w.windowId, gen, settle, posted: false };
      acts.set(id, act);
      timer = setT(() => settle({ status: 'failed', error: { message: 'the window did not answer in time: whether it was done is not known' } }), ACT_MS);
      timer?.unref?.();
      try { w.channel.post({ ...body, id, gen, expires: now() + ACT_MS }); act.posted = true; }
      catch { settle(gone('the window\'s page is gone')); }
    });
  }
  /** The page's answer to an act, as the graph's outcome. */
  const outcomeOf = (a) => {
    if (isObject(a) && a.ok === true) return { status: 'done', value: null };
    // a page's refusal: never possible there (invalid), or not now (unavailable: it may be later)
    if (isObject(a) && typeof a.refused === 'string') return { status: 'refused', reason: a.refused === 'invalid' ? 'invalid' : 'unavailable', message: typeof a.message === 'string' ? a.message.slice(0, 500) : 'the page cannot do this here' };
    return { status: 'failed', error: { message: isObject(a) && typeof a.failed === 'string' ? a.failed.slice(0, 500) : 'the page gave no answer it could say' } };
  };
  // An act the page was sent may have run before its page went: whether it did is not known (a failure, never a refusal a caller would
  // take as "nothing happened" and do again some other way).
  const settleActs = (windowId, gen, message) => {
    for (const a of [...acts.values()]) if (a.windowId === windowId && (gen === undefined || a.gen === gen)) {
      a.settle(a.posted ? { status: 'failed', error: { message: `${message} before it answered: whether it was done is not known` } } : gone(message));
    }
  };
  /** Text, a mention (a ref) or Content, as Content. */
  const contentOf = (x) => (typeof x === 'string' ? { parts: [{ kind: 'text', text: x }] } : isRef(x) ? { parts: [{ kind: 'mention', ref: plainRef(x) }] } : x);
  /**
   * `fn()`, with `ref` observed meanwhile when `needed` (its instance is not resident, say): a full observation, the one way the native
   * provider reads a file or loads a thread's turns, given LOAD_MS to load.
   */
  async function observing(ref, needed, fn) {
    let view = null;
    if (needed && typeof graph.subscribe === 'function') {
      try {
        view = graph.subscribe({ ref }, () => true);
        await Promise.race([view.loaded, new Promise((r) => { const t = setT(r, LOAD_MS); t?.unref?.(); })]);
      } catch (e) { log.warn('windows: a subject could not be observed', { message: String(e?.message ?? e) }); }
    }
    try { return await fn(); } finally { try { view?.dispose(); } catch { /* gone */ } }
  }
  /** The subject's own operation, as the caller (decision 3), then the page's follow-up when it was done. */
  async function onSubject({ ref, instance, args, caller, origin }, route) {
    const subject = instance.links?.subject;
    if (!isRef(subject)) return gone('the presentation has no subject');
    // A subject the page shows may not be resident in the graph (a file is read when observed): observed while its operation runs.
    const at = { ...(Number.isSafeInteger(route.window) ? { window: refs.window(route.window) } : {}), ...(typeof route.pane === 'string' ? { pane: route.pane } : {}) };
    const inWindow = Object.keys(at).length ? [at] : [];
    const out = await observing(subject, !graph.resolve(subject),
      () => graph.invoke({ ref: subject, operation: route.subject, args: route.args === 'content' ? [contentOf(args[0]), ...inWindow] : args, caller, origin }));
    const { id: _id, ...outcome } = out ?? {};
    if (outcome.status === 'done' && route.then) await inPage(ref, route.then, []);   // best effort: the subject's operation is what counts
    return outcome;
  }
  // ---------------------------------------------------------------- a mod's Dialog ("E7 in detail" decision 7)
  const asks = new Map();   // ask id -> { id, windowId, gen, requester, subject, actions, settle }
  const stops = new Map();  // mod id -> how many times it stopped (a question begun before a stop is not asked after it)
  let askSeq = 0;
  const cancelled = (by, reason) => ({ cancelled: true, by, reason });
  /** The window the user is in, by framework-main (the focused app window, else the one focused last), if its page reports. */
  async function askWindow() {
    if (!o.mainOps) return null;
    const r = await o.mainOps.op('windows', 'focused', {});
    const id = r?.ok ? r.result?.windowId : null;
    const w = Number.isSafeInteger(id) ? windows.get(id) : null;
    return w && w.gen !== null && w.channel ? w : null;
  }
  /**
   * Ask the user (decision 7): a Dialog in the window they are in, one at a time per window, after the framework's own (the page queues
   * them). Settled exactly once, as `{choice, by}` (the user's choice, or the requester's confirm: its first action) or `{cancelled,
   * by, reason}`: the user's or the requester's cancel, `until` passing (an interceptor's deadline), the subject going, the window's page
   * going (a reload, the window closing), the page's own end of it (removed from the app's modal stack, failed to render) or the
   * requester stopping. The requester is the framework's to name (the mod's id and name), never the mod's text.
   */
  async function ask({ requester, subject, purpose, title, message, actions, until, during, fields, withdraw }) {
    const epoch = stops.get(requester.id) ?? 0;
    const w = await askWindow();
    // withdrawn while its window was being found: nothing is asked
    if (withdraw && earlyWithdrawn.delete(`${requester.id}\n${withdraw}`)) return cancelled('requester', 'withdrawn');
    if (!w) throw new CodexModsError('Unavailable', 'no window is open to ask in');
    // the requester stopped while its window was being found: nothing is asked
    if ((stops.get(requester.id) ?? 0) !== epoch) return cancelled('framework', 'the mod that asked stopped');
    if (Number.isFinite(until) && until <= now()) return cancelled('framework', 'its time passed');
    const id = ++askSeq;
    return new Promise((resolve) => {
      let timer = null;
      const a = { id, windowId: w.windowId, gen: w.gen, requester, subject: plainRef(subject), actions, fields: fields ?? [], withdraw: withdraw ?? null };
      /** Settles it once; `tell`: the page closes it (not when the page is the one that ended it, or went). */
      let offDuring = null;
      a.settle = (result, tell = true) => {
        if (!asks.delete(id)) return;
        if (timer !== null) clearT(timer);
        try { offDuring?.(); } catch { /* gone */ }
        if (tell) { try { windows.get(a.windowId)?.gen === a.gen && windows.get(a.windowId).channel?.post({ t: 'askEnd', id }); } catch { /* the page went */ } }
        resolve(Object.freeze(result));
      };
      asks.set(id, a);
      if (Number.isFinite(until)) { timer = setT(() => a.settle(cancelled('framework', 'its time passed')), Math.max(0, until - now())); timer?.unref?.(); }
      // asked about an intercepted call (`call.ask`): it ends with the call (decided, expired, cancelled)
      if (typeof during === 'function') {
        offDuring = during(() => a.settle(cancelled('framework', 'the call it asked about went on')));
        if (offDuring === null) { a.settle(cancelled('framework', 'the call it asked about went on'), false); return; }
      }
      let sent;
      try { sent = w.channel.post({ t: 'ask', id, gen: w.gen, requester, subject: a.subject, purpose, title, message, actions, ...(a.fields.length ? { fields: a.fields } : {}) }) !== false; } catch { sent = false; }
      if (!sent) a.settle(cancelled('framework', 'the window\'s page went'), false);
    });
  }
  // ---------------------------------------------------------------- a mod's notifications (public-hooks.md §3.14)
  const notes = new Map();      // notification id (`<mod>:<key>`) -> {id, token, modId, where: 'toast' | 'desktop', windowId, gen, subject}
  const noteListeners = new Map();   // mod id -> Set of its `notices` emitters
  let noteSeq = 0;
  const NOTE_KINDS = new Set(['info', 'success', 'warning', 'error']);
  const ACTION_ID = /^[A-Za-z0-9._-]{1,40}$/;
  function noteSpec(spec) {
    const bad = (m) => { throw new CodexModsError('Invalid', `ui.notify: ${m}`); };
    if (!isObject(spec) || typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) bad('a title of at most 200 characters');
    if (spec.body !== undefined && (typeof spec.body !== 'string' || spec.body.length > 2000)) bad('body is at most 2000 characters');
    if (spec.kind !== undefined && !NOTE_KINDS.has(spec.kind)) bad('kind is info, success, warning or error');
    if (spec.subject !== undefined && !(isObject(spec.subject) && typeof spec.subject.type === 'string' && typeof spec.subject.provider === 'string' && typeof spec.subject.id === 'string')) bad('subject is a ref');
    if (spec.surface !== undefined && !['auto', 'desktop', 'toast'].includes(spec.surface)) bad('surface is auto, desktop or toast');
    if (spec.dedupe !== undefined && (typeof spec.dedupe !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(spec.dedupe))) bad('dedupe is an id');
    const actions = spec.actions ?? [];
    if (!Array.isArray(actions) || actions.length > 4 || !actions.every((a) => isObject(a) && ACTION_ID.test(a.id) && typeof a.title === 'string' && a.title.trim() && a.title.length <= 40)) bad('actions are at most 4 {id, title}');
    return { title: spec.title.trim(), body: typeof spec.body === 'string' ? spec.body : '', kind: spec.kind ?? 'info', subject: spec.subject ? plainRef(spec.subject) : null,
      surface: spec.surface ?? 'auto', dedupe: spec.dedupe ?? null, sticky: spec.sticky === true, actions: actions.map((a) => ({ id: a.id, title: a.title.trim() })) };
  }
  const tellMod = (modId, e) => { for (const f of [...(noteListeners.get(modId) ?? [])]) { try { f(Object.freeze(e)); } catch { /* the channel's own */ } } };
  /** A notification goes: its toast or its desktop notification closed; `tell`: the mod hears it went (not when replaced, nor when it closed it). */
  function closeNote(n, tell) {
    if (notes.get(n.id) !== n) return;
    notes.delete(n.id);
    if (n.where === 'toast') { try { windows.get(n.windowId)?.gen === n.gen && windows.get(n.windowId).channel?.post({ t: 'noticeEnd', id: n.id, token: n.token }); } catch { /* the page went */ } }
    else void o.mainOps?.op('notifications', 'dismiss', { id: desktopId(n) }).catch(() => {});
    if (tell) tellMod(n.modId, { id: n.id, gone: true });
  }
  // each showing of a notification has its own token: a click on, or the end of, an earlier one (replaced by its dedupe) is never this one's
  const desktopId = (n) => `codexmods:${n.id}#${n.token}`;
  /** Who sent it, in the framework's words: the mod's id first (its own, authenticated), then its name on one line (a name can say anything). */
  const sender = (requester) => {
    const name = typeof requester.name === 'string' ? requester.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    return name && name !== requester.id ? `${requester.id} (${name})` : requester.id;
  };
  const notifying = new Map();   // notification id -> the notify of it in flight: one of the same id waits for it (a dedupe replaces in order)
  /**
   * A mod's notification: the app's own toast in the window the user is in (`toast`, or `auto` while an app window is focused) or the app's
   * own desktop notification, named as the mod (`requester.name`) by the framework, never by the mod's text. One with the same `dedupe`
   * replaces the mod's earlier one. `at.windowId` (the framework's own notices): a toast in that window, not the focused one, and only in
   * its page `at.gen` when given (a page reloaded since is not told). Its id.
   */
  function notify(requester, spec0, at = null) {
    let spec;
    try { spec = noteSpec(spec0); } catch (e) { return Promise.reject(e); }
    const id = `${requester.id}:${spec.dedupe ?? `n${++noteSeq}`}`;
    const prior = notifying.get(id) ?? Promise.resolve();
    const run = prior.then(() => notifyNow(requester, spec, id, at), () => notifyNow(requester, spec, id, at));
    const tail = run.then(() => {}, () => {});
    notifying.set(id, tail);
    tail.then(() => { if (notifying.get(id) === tail) notifying.delete(id); });
    return run;
  }
  async function notifyNow(requester, spec, id, at = null) {
    if (disposed) throw new CodexModsError('Unavailable', 'the windows provider stopped');
    const epoch = stops.get(requester.id) ?? 0;
    const stopped = () => disposed || (stops.get(requester.id) ?? 0) !== epoch;
    const token = String(++noteSeq);
    const prev = notes.get(id);
    if (prev) closeNote(prev, false);
    let where = spec.surface, w = null;
    const fixed = at && Number.isSafeInteger(at.windowId) ? windows.get(at.windowId) : undefined;
    if (at && Number.isSafeInteger(at.windowId)) {
      // the window it is about: a toast there, or nothing (never another window's)
      if (where !== 'toast') throw new CodexModsError('Invalid', 'a notice for a window is a toast');
      if (fixed && fixed.gen !== null && fixed.channel && (at.gen == null || fixed.gen === at.gen)) w = fixed;
    } else if (where !== 'desktop' && o.mainOps) {
      const r = await o.mainOps.op('windows', 'focused', {}).catch(() => null);
      if (stopped()) throw new CodexModsError('Unavailable', 'the mod stopped');
      const wid = r?.ok ? r.result?.windowId : null;
      const cand = Number.isSafeInteger(wid) ? windows.get(wid) : null;
      const page = cand && cand.gen !== null && cand.channel ? cand : null;
      if (where === 'auto') where = page && r.result.appFocused !== false ? 'toast' : 'desktop';
      if (where === 'toast') w = page;
    }
    if (where === 'toast' && !w) throw new CodexModsError('Unavailable', 'no window is open to show it in');
    if (!o.mainOps && where === 'desktop') throw new CodexModsError('Unavailable', 'framework-main is not running');
    const n = { id, token, modId: requester.id, where, windowId: w?.windowId ?? null, gen: w?.gen ?? null, subject: spec.subject };
    notes.set(id, n);
    // the token is the handle's to end this showing by (never another one of the same id)
    if (where === 'toast') {
      let sent;
      try { sent = w.channel.post({ t: 'notice', id, token, gen: w.gen, requester: { id: requester.id, name: requester.name }, from: sender(requester), title: spec.title, body: spec.body, kind: spec.kind, sticky: spec.sticky, actions: spec.actions.slice(0, 2) }) !== false; }
      catch { sent = false; }
      if (!sent) { notes.delete(id); throw new CodexModsError('Unavailable', 'the window\'s page went'); }
      return { id, token };
    }
    // who sent it first, so no length of the mod's text pushes it out
    const r = await o.mainOps.op('notifications', 'show', { id: desktopId(n), title: spec.title, body: spec.body ? `${sender(requester)}\n${spec.body}` : sender(requester), actions: spec.actions });
    if (!r?.ok) { if (notes.get(id) === n) notes.delete(id); throw new CodexModsError('Unavailable', r?.error ?? 'the notification could not be shown'); }
    // the mod stopped while it was shown: it goes with it
    if (stopped()) { closeNote(n, false); throw new CodexModsError('Unavailable', 'the mod stopped'); }
    return { id, token };
  }
  /** framework-main: a mod's desktop notification was clicked (`action` null: its body, which opens its subject) or chosen, or went. */
  async function noticeDesktop(fullId, action, gone = false) {
    const at = typeof fullId === 'string' && fullId.startsWith('codexmods:') ? fullId.lastIndexOf('#') : -1;
    const n = at > 0 ? notes.get(fullId.slice('codexmods:'.length, at)) : null;
    if (!n || n.where !== 'desktop' || n.token !== fullId.slice(at + 1)) return false;   // an earlier showing's, or one that ended
    if (gone) { notes.delete(n.id); tellMod(n.modId, { id: n.id, gone: true }); return true; }
    const w = await askWindow().catch(() => null);
    if (notes.get(n.id) !== n) return false;   // it ended meanwhile (its mod stopped, it was replaced)
    if (action === null) { if (n.subject && w) await open(w.windowId, n.subject).catch(() => null); return true; }
    tellMod(n.modId, { id: n.id, action, ...(w ? { window: { type: 'Window', provider: PROVIDER, id: String(w.windowId) } } : {}) });
    return true;
  }
  /** The page's end of a toast in its window: an action chosen (`{action}`), or the toast went (`{gone}`). */
  function noticeAnswer(windowId, gen, id, outcome) {
    const n = notes.get(id);
    if (!n || n.where !== 'toast' || n.windowId !== windowId || n.gen !== gen || !isObject(outcome) || outcome.token !== n.token) return false;
    if (typeof outcome.action === 'string' && ACTION_ID.test(outcome.action)) { tellMod(n.modId, { id, action: outcome.action, window: { type: 'Window', provider: PROVIDER, id: String(windowId) } }); return true; }
    if (outcome.gone === true) { notes.delete(id); tellMod(n.modId, { id, gone: true }); return true; }
    return false;
  }

  /** The page's end of an ask in its window: the user's choice or cancel, or its own end (removed, failed to render). */
  function askAnswer(windowId, gen, id, outcome) {
    const a = asks.get(id);
    if (!a || a.windowId !== windowId || a.gen !== gen || !isObject(outcome)) return false;
    // the user's intent the page attested for the asking mod with this answer (graph-integrity G7.1): passed on to it as it is
    const asUser = typeof outcome.asUser === 'string' && /^att-[A-Za-z0-9]{16,64}$/.test(outcome.asUser) ? { asUser: outcome.asUser } : {};
    if (typeof outcome.choice === 'string' && a.actions.some((x) => x.id === outcome.choice)) a.settle({ choice: outcome.choice, by: 'user', ...(a.fields.length ? { values: valuesOf(a.fields, outcome.values) } : {}), ...asUser }, false);
    else a.settle(cancelled(outcome.by === 'user' ? 'user' : 'framework', typeof outcome.reason === 'string' ? outcome.reason.slice(0, 200) : 'closed'), false);
    return true;
  }
  /** The values the user gave a question's fields, by their keys, each as its kind takes it (a setting's: G4.2); its default otherwise. */
  function valuesOf(fields, given) {
    const v = isObject(given) ? given : {};
    return Object.fromEntries(fields.map((f) => [f.key, askValueOf(f, Object.hasOwn(v, f.key) ? v[f.key] : undefined)]));
  }
  const earlyWithdrawn = new Set();   // `${mod}\n${token}` withdrawn before the question was shown
  /** A mod withdraws its question (its own token): cancelled, by the requester (before it is shown too: then it never is). */
  function askWithdraw(modId, token) {
    const a = [...asks.values()].find((x) => x.requester.id === modId && x.withdraw === token);
    if (!a) {
      earlyWithdrawn.add(`${modId}\n${token}`);
      if (earlyWithdrawn.size > 256) earlyWithdrawn.delete(earlyWithdrawn.values().next().value);
      return true;
    }
    a.settle(cancelled('requester', 'withdrawn'));
    return true;
  }
  /** Dialog.confirm and cancel on a mod's Dialog: only the mod that asked settles it, recorded as its choice, never the user's. */
  function askOperation({ ref, caller }, name) {
    const a = asks.get(items.get(String(ref.id))?.ask);
    if (!a) return gone('this Dialog is not a question a mod asked, or it was answered');
    if (caller?.kind !== 'mod' || caller.id !== a.requester.id) return { status: 'refused', reason: 'notAllowed', message: 'only the mod that asked settles its Dialog' };
    a.settle(name === 'confirm' ? { choice: a.actions[0].id, by: 'requester', ...(a.fields.length ? { values: valuesOf(a.fields, {}) } : {}) } : cancelled('requester', 'cancelled'));
    return { status: 'done', value: null };
  }
  /** The operations framework-main does for a presentation (decision 3: what acts on the window or the app's chrome). */
  const MAIN = {
    // the app's own menu bar entry, by its path of labels (framework-main finds it in the app's menu now, and refuses one turned off)
    MenuEntry: {
      choose: async ({ ref }) => {
        const it = items.get(String(ref.id));
        if (!it?.menuPath) return gone('the entry is gone');
        if (isProtected(it.subject)) return { status: 'refused', reason: 'notAllowed', message: 'that entry is the user\'s' };
        if (!o.mainOps) return gone('framework-main is not running');
        const r = await o.mainOps.op('menus', 'choose', { path: it.menuPath });
        if (r.ok) return null;
        return r.refused ? gone(r.error) : { status: 'failed', error: { message: String(r.error) } };
      },
    },
    Window: {
      open: (call) => {
        const placement = call.args[1]?.placement ?? 'main';
        if (call.args[1] !== undefined && (typeof call.args[1] !== 'object' || !['main', 'window', 'side'].includes(placement))) return { status: 'refused', reason: 'invalid', message: 'open takes {placement: main | window | side}' };
        if (placement === 'side') return openBeside(live(call.ref), call.args[0]);
        // in a new window, the app's own way (App.openWindow's): the window it opened
        return placement === 'window' ? api.openWindow(call.args[0], call) : open(live(call.ref).windowId, call.args[0], call);
      },
      ...Object.fromEntries(['back', 'forward', 'focus', 'close'].map((name) => [name, ({ ref }) => main(name, { windowId: live(ref).windowId })])),
      ...Object.fromEntries([['toggleSidebar', 'sidebar'], ['togglePanel', 'side']].map(([name, region]) => [name, ({ ref, caller }) => heldFrom(live(ref), region, caller) ?? main(name, { windowId: live(ref).windowId })])),
      // the app's sidebar toggles, only when it is not already as asked (sidebarTo)
      setSidebar: ({ ref, args, caller }) => heldFrom(live(ref), 'sidebar', caller) ?? sidebarTo(live(ref), args[0], 'setSidebar'),
      // the app's panel toggle takes the state it is to be in
      setPanel: ({ ref, args, caller }) => heldFrom(live(ref), 'side', caller) ?? main('setPanel', { windowId: live(ref).windowId, open: args[0] }),
      // the app's own layouts of the workspace (its "Cycle workspace layout", "Full view"), set in its page through the app's guarded setters
      // (the SidePanel's page operation: a tab that does not fill the workspace is refused before anything moves; layouts.md D6), done once
      // its page shows it so: the app may not (a split or a full view with nothing to show beside the chat) (H7pl review 2)
      setLayout: async ({ ref, args, caller }) => {
        const w = live(ref);
        // a mod's named layout (layouts.md D6, D11): the window's one claim, made in its page; done once it says the layout reached what it shows, what could not be as asked said in its value
        if (typeof args[0] === 'string' && !['chat', 'split', 'full'].includes(args[0])) {
          const id = args[0];
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return { status: 'refused', reason: 'invalid', message: 'a layout is chat, split, full or a mod\'s <mod>/<id>' };
          const gen = w.gen;
          if (gen === null) return gone('no page runs in that window');
          // the mods' order decides between mods acting at once (D6); the user's own pick has no say of it
          const r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'layout.set', args: { id, ...(caller?.kind === 'mod' ? { by: caller.id } : {}) } });
          if (r.status !== 'done') return r;
          const out = await shown(w, gen, () => facts(w)?.claim?.picked === id && facts(w)?.claim?.settled === true, 'setLayout', 'the window does not say that layout');
          if (out.status !== 'done') return out;
          return { status: 'done', value: { layout: id, partial: facts(w).claim.partial ?? [] } };
        }
        const mode = () => facts(w)?.layout?.mode ?? null;
        const gen = w.gen;
        let r;
        if (facts(w)?.claim) {
          // the app's own mode ends a mod's layout, in its page at once: each thing it wrote goes back, and one the app then refuses leaves the layout as it was. The mods' order decides here too
          if (gen === null) return gone('no page runs in that window');
          r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'layout.app', args: { mode: args[0], ...(caller?.kind === 'mod' ? { by: caller.id } : {}) } });
        } else {
          // the chat's side panel, or a panel tab (a home page has tabs and no chat): the one the displayed page draws
          const panel = shownItem(w, 'SidePanel') ?? shownItem(w, 'PanelTab');
          if (!panel) return { status: 'refused', reason: 'unavailable', message: 'the window shows no workspace with a side panel' };
          r = await inPage(panel.ref, 'layout', [args[0]]);
        }
        if (r.status !== 'done') return r;
        for (let i = 0; i < SHOW_TRIES && w.gen === gen && mode() !== args[0]; i++) await new Promise((res) => { const t = setT(res, SHOW_EVERY_MS); t?.unref?.(); });
        if (w.gen !== gen) return { status: 'uncertain', operation: 'setLayout' };
        if (mode() === args[0]) return { status: 'done', value: null };
        return mode() ? { status: 'failed', error: { message: `the app shows ${mode()}, not ${args[0]}: it has nothing to show so` } } : { status: 'uncertain', operation: 'setLayout' };
      },
      // one of the window's regions, in this window now (layouts.md D4): open or closed, and its size (px), the app's live values, never
      // the ones it keeps (the user's own drag still keeps what they drag to); reversible, so never asked. Opened first, then sized (a
      // region is sized while open); done once the window shows it so
      setRegion: async ({ ref, args, caller }) => {
        const w = live(ref);
        const [region, want] = args;
        const taken = heldFrom(w, region, caller);
        if (taken) return taken;
        if (want.open === undefined && want.size === undefined && want.at === undefined && want.edge === undefined) return { status: 'refused', reason: 'invalid', message: 'setRegion takes open, size or both (and the bottom panel at, the sidebar edge)' };
        if (want.at !== undefined && (region !== 'bottom' || !['below', 'left', 'right'].includes(want.at))) return { status: 'refused', reason: 'invalid', message: 'only the bottom panel takes at: below, left or right' };
        if (want.edge !== undefined && (region !== 'sidebar' || !['left', 'right'].includes(want.edge))) return { status: 'refused', reason: 'invalid', message: 'only the sidebar takes edge: left or right' };
        if (want.size !== undefined && !(Number.isFinite(want.size) && want.size > 0)) return { status: 'refused', reason: 'invalid', message: 'a size is a number of px' };
        if (want.open === false && want.size !== undefined) return { status: 'refused', reason: 'invalid', message: 'a closed region has no size' };
        if (!['sidebar', 'side', 'bottom'].includes(region)) return modRegion(w, region, want);
        // one page from start to end: a reload meanwhile leaves it uncertain (what the old page said no longer counts)
        const gen = w.gen;
        if (gen === null) return gone('no page runs in that window');
        // the sidebar's edge first (layouts.md WL4c): done once the page says it there
        // asked explicitly: always sent (what the window draws now may be a hold for space, not the placement asked before)
        if (want.edge !== undefined) {
          // the window's own act (no presentation: a closed sidebar is not drawn)
          const r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'sidebar.edge', args: { edge: want.edge } });
          if (r.status !== 'done') return r;
          const moved = await shown(w, gen, () => (facts(w)?.sidebar?.edge ?? 'left') === want.edge, 'setRegion', `the app shows no sidebar at the ${want.edge} here`);
          if (moved.status !== 'done' || (want.open === undefined && want.size === undefined)) return moved;
        }
        // the bottom panel's place first (layouts.md WL4b): beside the chat, a column of the frame's host, done once the page says it there
        if (want.at !== undefined) {
          const panel = shownItem(w, 'SidePanel');
          if (!panel) return { status: 'refused', reason: 'unavailable', message: 'the window shows no chat with a bottom panel' };
          const r = await inPage(panel.ref, 'bottomAt', [want.at]);
          if (r.status !== 'done') return r;
          const placed = await shown(w, gen, () => (facts(w)?.bottom?.at ?? 'below') === want.at, 'setRegion', `the app shows no bottom panel ${want.at === 'below' ? 'below' : `at the ${want.at}`} here`);
          // held for space (layouts.md D12): placed, and shown there once the window has room again
          if (placed.status === 'failed' && (facts(w)?.suspended ?? []).includes('bottom')) return { status: 'uncertain', operation: 'setRegion' };
          if (placed.status !== 'done' || (want.open === undefined && want.size === undefined)) return placed;
        }
        if (typeof want.open === 'boolean') {
          let r;
          if (region === 'sidebar') r = await sidebarTo(w, want.open, 'setRegion');
          else if (region === 'side') {
            r = await main('setPanel', { windowId: w.windowId, open: want.open });
            if (r.status === 'done') r = await shown(w, gen, () => facts(w)?.side?.open === want.open, 'setRegion', `the app shows no side panel here`);
          } else {
            const panel = shownItem(w, 'SidePanel');
            if (!panel) return { status: 'refused', reason: 'unavailable', message: 'the window shows no chat with a bottom panel' };
            r = await inPage(panel.ref, 'bottom', [want.open]);
            if (r.status === 'done') r = await shown(w, gen, () => facts(w)?.bottom?.open === want.open, 'setRegion', 'the app shows no bottom panel here');
          }
          if (r.status !== 'done') return r;
        }
        if (want.size === undefined) return { status: 'done', value: null };
        const near = (v) => typeof v === 'number' && Math.abs(v - want.size) <= 2;
        if (region === 'sidebar') {
          const bar = shownItem(w, 'Sidebar');
          if (!bar || facts(w)?.sidebar?.open !== true) return { status: 'refused', reason: 'unavailable', message: 'the window\'s sidebar is closed' };
          const r = await inPage(bar.ref, 'width', [want.size]);
          return r.status === 'done' ? shown(w, gen, () => near(facts(w)?.sidebar?.width), 'setRegion', `the window has no room for a sidebar of ${want.size} px`) : r;
        }
        const panel = shownItem(w, 'SidePanel');
        if (!panel) return { status: 'refused', reason: 'unavailable', message: `the window shows no chat with a ${region === 'side' ? 'side' : 'bottom'} panel` };
        if (region === 'bottom') {
          // its height below, its width beside, by its frame, a part of the chat's SidePanel (the window's BottomPanel is the provider's
          // region, not the page's)
          if (facts(w)?.bottom?.open !== true) return { status: 'refused', reason: 'unavailable', message: 'the window\'s bottom panel is closed' };
          const beside = (facts(w)?.bottom?.at ?? 'below') !== 'below';
          const r = await inPage(panel.ref, beside ? 'bottomWidth' : 'bottomHeight', [want.size]);
          return r.status === 'done' ? shown(w, gen, () => near(facts(w)?.bottom?.[beside ? 'width' : 'height']), 'setRegion', `the window has no room for a bottom panel of ${want.size} px`) : r;
        }
        const r = await inPage(panel.ref, 'resize', [want.size]);
        return r.status === 'done' ? shown(w, gen, () => near(facts(w)?.side?.size), 'setRegion', `the window has no room for a side panel of ${want.size} px`) : r;
      },
      // a page in a new tab of its in-app browser: the BrowserTab the app opened (by the tab id framework-main gave it), once listed
      openBrowser: async ({ ref, args }) => {
        if (!o.mainOps) return { status: 'refused', reason: 'unavailable', message: 'framework-main is not running' };
        const r = await o.mainOps.op('windows', 'openBrowser', { windowId: live(ref).windowId, url: args[0] });
        if (!r.ok) return r.refused ? { status: 'refused', reason: 'unavailable', message: r.error } : { status: 'failed', error: { message: r.error } };
        const tabId = r.result?.browserTabId;
        if (typeof tabId !== 'string' || !tabId) return { status: 'uncertain', operation: 'openBrowser' };
        for (let i = 0; i < NEW_WINDOW_TRIES / 2; i++) {
          // the native provider's tab ids are `<its chat>:<tab id>`
          // eslint-disable-next-line codexmods/no-provider-identity -- the app's own browser tabs
          const tab = graph.list('BrowserTab').find((x) => !x.gone && x.ref.provider === 'codex' && x.ref.id.endsWith(`:${tabId}`));
          if (tab) return { status: 'done', value: plainRef(tab.ref) };
          await new Promise((res) => { const t = setT(res, SHOW_EVERY_MS); t?.unref?.(); });
        }
        return { status: 'uncertain', operation: 'openBrowser' };
      },
      // the app's palette in that window, searching the query when one is given (the app's own `command-menu` message)
      openPalette: ({ ref, args }) => {
        if (args[0] !== undefined && (typeof args[0] !== 'string' || args[0].length > 500)) return { status: 'refused', reason: 'invalid', message: 'a query of at most 500 characters' };
        return main('palette', { windowId: live(ref).windowId, ...(args[0] ? { query: args[0] } : {}) });
      },
      // the find bar of the chat the window shows (its ThreadView's own find); `{pane}`: that pane's, gone when it has closed; else the one the user is in. A hosted chat has none: its binding says so
      find: ({ ref, args }) => {
        if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > 500) return { status: 'refused', reason: 'invalid', message: 'find takes the text to find (1 to 500 characters)' };
        const w = live(ref);
        const views = [...items.values()].filter((it) => it.type === 'ThreadView' && it.windowId === w.windowId && it.gen === w.gen && !it.framework).sort((a, b) => b.n - a.n);
        const named = isObject(args[1]) && typeof args[1].pane === 'string' ? args[1].pane : undefined;
        if (named !== undefined && !views.some((it) => paneKey(it.pane) === named)) return { status: 'refused', reason: 'gone', message: 'that pane has closed' };
        const active = facts(w)?.panes?.active ?? null;
        // the pane the user is in, whatever it shows: never another's find bar in its stead
        if (named === undefined && active !== null && !views.some((it) => it.pane === active)) return { status: 'refused', reason: 'unavailable', message: "the pane the user is in has no find bar: name {pane: 'route'} for the chat the window shows" };
        const view = named !== undefined ? views.find((it) => paneKey(it.pane) === named) : views.find((it) => (it.pane ?? null) === active) ?? views[0];
        return view ? inPage(view.ref, 'find', [args[0]]) : gone('the window shows no chat');
      },
      // the keyboard into one of its panes (graph-integrity G5.1): 'next' and 'previous' in their order on the page, the main region the
      // first of them; 'main'; or a pane's token. Its page moves the focus (into that pane's composer, else the pane); done once it says
      // the user is in it.
      focusPane: async ({ ref, args }) => {
        const t = args[0];
        if (typeof t !== 'string' || !(t === 'next' || t === 'previous' || t === 'main' || /^[A-Za-z0-9._:-]{1,64}$/.test(t))) {
          return { status: 'refused', reason: 'invalid', message: "focusPane takes 'next', 'previous', 'main' or a pane's token" };
        }
        const w = live(ref);
        const gen = w.gen;
        if (gen === null || !w.channel) return gone('no page runs in that window');
        const panes = facts(w)?.panes ?? null;
        const stops = [null, ...(Array.isArray(panes?.list) ? panes.list.map((p) => p?.token).filter((x) => typeof x === 'string') : [])];
        const at = Math.max(0, stops.indexOf(panes?.active ?? null));
        const target = t === 'main' ? null : t === 'next' ? stops[(at + 1) % stops.length] : t === 'previous' ? stops[(at - 1 + stops.length) % stops.length] : t;
        if (target !== null && !stops.includes(target)) return { status: 'refused', reason: 'gone', message: 'that pane has closed' };
        const r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'pane.focus', args: { pane: target } });
        if (r.status !== 'done') return r;
        return shown(w, gen, () => (facts(w)?.panes?.active ?? null) === target, 'focusPane', 'the user is in another pane');
      },
    },
    SidebarItem: {
      select: ({ ref, instance }) => open(live(ref).windowId, instance.links.subject),
      // The app renames a chat through its rename dialog, which it opens for the chat its window shows (its overflow menu's command).
      rename: ({ ref, instance }) => {
        const w = live(ref);
        return sameRef(w.current, instance.links.subject) ? main('renameThread', { windowId: w.windowId }) : gone('the app renames only the chat its window shows');
      },
    },
    // The app renames the chat its window shows: a header of another chat (a stale mount) is refused.
    ThreadHeader: { rename: ({ ref, instance }) => { const w = live(ref); return sameRef(w.current, instance.links.subject) ? main('renameThread', { windowId: w.windowId }) : gone('the app renames only the chat its window shows'); } },
    // A project's group in the sidebar: the app's own sidebar actions, run in that window (its "Show more" is the page's: its action
    // looks for a toggle the group may not draw, E8.9).
    SidebarSection: Object.fromEntries([['collapse', { collapsed: true }], ['expand', { collapsed: false }]].map(([name, change]) => [name, ({ ref, instance }) => {
      const project = instance.links.subject;
      // eslint-disable-next-line codexmods/no-provider-identity -- the app groups only its own projects
      if (!isRef(project) || project.provider !== 'codex') return gone('the app groups only its own projects');
      return main('appAction', { windowId: live(ref).windowId, action: { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project: { projectId: project.id }, ...change } });
    }])),
    Composer: {
      focus: ({ ref }) => main('focusComposer', { windowId: live(ref).windowId }),
      // its Draft's insert, as the caller (its grant and interceptors apply), in the composer chosen: the Draft operation's own `{window}`
      // and `{pane}` (graph-layers.md §2; no state shared between concurrent inserts)
      insert: (call) => { const it = items.get(String(call.ref.id)); return onSubject(call, { subject: 'insert', args: 'content', window: it?.windowId, pane: it ? paneKey(it.pane) : undefined }); },
    },
    // A new chat, as the sidebar's own button starts one (E7.3).
    Sidebar: { newThread: ({ ref }) => main('newChat', { windowId: live(ref).windowId }) },
    // The open palette searches for the query (the app's own `command-menu` message); without one it is already open.
    Palette: { open: ({ ref, args }) => (typeof args[0] === 'string' && args[0] ? main('palette', { windowId: live(ref).windowId, query: args[0].slice(0, 500) }) : { status: 'done', value: null }) },
    // The right panel: a file's or the review's tab opened in it (the app's own action, run in that window), or the panel closed.
    SidePanel: {
      open: ({ ref, args }) => {
        const t = args[0];
        if (!isRef(t)) return { status: 'refused', reason: 'invalid', message: 'open takes a ref' };
        // eslint-disable-next-line codexmods/no-provider-identity -- a file of this Mac
        const target = graph.type(t.type)?.chain.includes('File') && t.provider === 'codex' ? { type: 'file', path: t.id }
          : graph.type(t.type)?.chain.includes('ChangeSet') ? { type: 'review' } : null;
        if (!target) return { status: 'refused', reason: 'unsupported', message: `the panel does not open a ${t.type}` };
        return main('appAction', { windowId: live(ref).windowId, action: { type: 'windows.tabs.open', windowId: 'current', target } });
      },
      close: ({ ref }) => main('setPanel', { windowId: live(ref).windowId, open: false }),
    },
    // A status item goes to its subject (03), in its window.
    StatusItem: { open: ({ ref, instance }) => open(live(ref).windowId, instance.links.subject) },
    // The Dock's badge: the caller's value while it holds it (null lets go); the latest holder's shows (decision 5).
    DockBadge: {
      set: async ({ args, caller }) => {
        const value = args[0] === undefined ? null : args[0];
        const count = (v) => Number.isSafeInteger(v) && v >= 0;
        if (value !== null && !count(value) && typeof value !== 'string' && !(value && typeof value === 'object' && Object.keys(value).length === 1 && count(value.add))) {
          return { status: 'refused', reason: 'invalid', message: 'set takes a count, text, {add: count} or null' };
        }
        if (!o.mainOps) return gone('framework-main is not running');
        // the caller's own badge of that key: the mod is the caller (authenticated), the key its declaration's
        const key = typeof args[1] === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(args[1]) ? args[1] : null;
        const holder = `${caller?.kind === 'mod' ? caller.id : 'user'}${key ? `:${key}` : ''}`;
        // held before main is asked: a stop while it answers still lets go (releaseBadge finds the holder)
        if (value !== null) badgeHolders.add(holder);
        const r = await o.mainOps.op('dock', 'badge', { holder, value });
        if (!r.ok) { if (value !== null) badgeHolders.delete(holder); return r.refused ? gone(r.error) : { status: 'failed', error: { message: r.error } }; }
        if (value === null) badgeHolders.delete(holder);
        return { status: 'done', value: null };
      },
      // the Dock icon asks for the user's attention (public-hooks.md §3.14)
      attention: async ({ args }) => {
        if (!o.mainOps) return gone('framework-main is not running');
        const r = await o.mainOps.op('dock', 'attention', { kind: args[0] });
        return r.ok ? { status: 'done', value: null } : r.refused ? gone(r.error) : { status: 'failed', error: { message: r.error } };
      },
    },
  };
  const badgeHolders = new Set();   // who holds the Dock's badge (let go when they stop)
  /** The id the app knows an instance by (a turn, a thread): Codex's own; null for another's (the app holds none of them). */
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own chat
  const appIdOf = (r) => (r.provider === 'codex' ? r.id : null);
  const isA = (r, concept) => isRef(r) && !!graph.type(r.type)?.chain.includes(concept);
  /** A turn of the chat a ThreadView shows, as the app's turn id for its page; or the refusal. */
  const turnIn = (instance, turn) => {
    const r = graph.resolve(turn);
    if (!r) return gone('the turn is not known');
    if (!sameRef(r.links?.thread, instance.links?.subject)) return { status: 'refused', reason: 'invalid', message: 'the turn is not in the chat this view shows' };
    const id = appIdOf(turn);
    return id ? [id] : gone('the app does not show this turn');
  };
  /** A page operation's arguments as its binding takes them (the app's own ids), or the refusal: type -> operation -> fn(call). */
  const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  const PREPARE = {
    Sidebar: {
      // text (1 to 200 characters), a chat's state fields ({status: 'idle', unread: true}; a list is any of its values), or null to show all
      // again; the page names the mod that filters it (the caller)
      filter: ({ args, caller }) => {
        const by = caller?.kind === 'mod' && typeof caller.id === 'string' ? caller.id : null;
        const q = args[0];
        if (q === null || q === undefined) return [null, by];
        if (typeof q === 'string' && q.trim() && q.length <= 200) return [q.trim(), by];
        const fields = isObject(q) ? Object.entries(q) : [];
        if (fields.length && fields.length <= 8 && fields.every(([k, v]) => /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k) && (scalar(v) || (Array.isArray(v) && v.length && v.length <= 20 && v.every(scalar))))) return [q, by];
        return { status: 'refused', reason: 'invalid', message: 'filter takes text (1 to 200 characters), {field: value} of a chat\'s state, or null to show all' };
      },
    },
    ThreadView: {
      scrollTo: ({ instance, args }) => (isA(args[0], 'Turn') ? turnIn(instance, args[0]) : { status: 'refused', reason: 'invalid', message: 'scrollTo takes a Turn' }),
      // the chat's latest turn: its turns load if they are not resident (the chat need not be observed by anyone)
      jumpToLatest: ({ instance }) => {
        const thread = instance.links?.subject;
        if (!isRef(thread)) return gone('the view shows no chat');
        const latest = () => graph.referrers(thread, 'thread').filter((x) => isA(x.ref, 'Turn'))
          .sort((a, b) => (a.state.startedAt ?? 0) - (b.state.startedAt ?? 0)).at(-1) ?? null;
        return observing(thread, !latest(), () => { const t = latest(); return t ? turnIn(instance, t.ref) : gone('the chat has no turn to show'); });
      },
      find: ({ args }) => (typeof args[0] === 'string' && args[0].trim() && args[0].length <= 500 ? [args[0]] : { status: 'refused', reason: 'invalid', message: 'find takes the text to find (1 to 500 characters)' }),
    },
    SidePanel: {
      resize: ({ args }) => (Number.isInteger(args[0]) && args[0] >= 320 && args[0] <= 10000 ? [args[0]] : { status: 'refused', reason: 'invalid', message: 'resize takes a width in pixels (320 to 10000)' }),
    },
  };
  // What the framework renders takes no act, whatever its subject ("E7 in detail" decision 6): its page reports it as the framework's.
  const unlessFramework = (fn) => (call) => (items.get(String(call.ref.id))?.framework ? { status: 'refused', reason: 'notAllowed', message: 'the framework\'s own presentations are the user\'s' } : fn(call));
  const operationsOf = (type) => Object.fromEntries(Object.entries(routes[type] ?? {}).map(([name, route]) => {
    const [, op] = operationOf(type, name, route);
    return [graphOp(type, name), op];
  }));
  function operationOf(type, name, route) {
    if (route === 'page') {
      const prepare = PREPARE[type]?.[name];
      return [name, { effect: EXTERNAL.has(`${type}.${name}`) ? 'external' : 'local', handler: unlessFramework(async (call) => { const args = prepare ? await prepare(call) : call.args; return Array.isArray(args) ? inPage(call.ref, name, args) : args; }) }];
    }
    if (route && typeof route === 'object' && route.subject) {
      // the new chat's own pickers (E8.3c: a draft-scope Setting, `new:app:...`, the graph does not serve): their page operation, the menu's
      // own choice (a Model's id, or its slug)
      const draftScoped = (call) => type === 'ComposerPicker' && name === 'choose' && call.instance?.links?.subject?.type === 'Setting' && String(call.instance.links.subject.id).startsWith('new:app:');
      return [name, { effect: 'local', handler: unlessFramework((call) => (draftScoped(call)
        ? inPage(call.ref, 'choose', [isRef(call.args[0]) ? call.args[0].id : call.args[0], call.args[1]])
        : onSubject(call, route))) }];
    }
    if (route === 'ask') return [name, { effect: 'local', handler: unlessFramework((call) => askOperation(call, name)) }];
    const fn = MAIN[type]?.[name];
    const approval = APPROVALS[type]?.[name];
    return [name, { effect: approval ? 'external' : 'local', ...(approval ? { approval } : {}), handler: unlessFramework(fn ?? (() => gone(`${type}.${name} is not available`))) }];
  }
  const handle = graph.registerProvider('native', PROVIDER, {
    types: {
      ...Object.fromEntries([...new Set([...TYPES, ...FRAMEWORK_TYPES])].map((t) => [t, { ...(routes[t] ? { operations: operationsOf(t) } : {}), ...(realizes.supports[t] ? { supports: realizes.supports[t] } : {}) }])),
      Presentation: { supports: realizes.supports.Presentation },
    },
  });

  // ---------------------------------------------------------------- the Window
  /**
   * Where the window is (its relations): the chat it shows, and the project of what it shows (that chat's, the one a new chat starts in:
   * its Draft's target, a project's own page), read from those instances while they are resident (their arrival or change looks again).
   */
  function placeOf(current) {
    const ref = (x) => (isRef(x) ? plainRef(x) : null);
    // its ref as the graph has it now (a subtype known since: CodexThread)
    if (isA(current, 'Thread')) { const t = graph.resolve(current); return { thread: plainRef(t?.ref ?? current), project: ref(t?.links?.project) }; }
    if (isA(current, 'Draft')) { const d = graph.resolve(current); return { thread: ref(d?.links?.thread), project: ref(d?.state?.target?.project) }; }
    if (isA(current, 'Project')) return { thread: null, project: plainRef(current) };
    return { thread: null, project: null };
  }
  /** The Window is put once its page has said whether its sidebar is open (nothing is guessed). */
  /** A chat beside the one shown (layouts.md D8): a tab of the right panel with the chat in it, a pane of its own; done once the page says that pane is there. */
  async function openBeside(w, target) {
    if (!isA(target, 'Thread')) return { status: 'refused', reason: 'invalid', message: 'only a chat opens beside another' };
    // eslint-disable-next-line codexmods/no-provider-identity -- only the app's own chats open beside another
    if (target.provider !== 'codex') return { status: 'refused', reason: 'unsupported', message: 'only a chat on this computer opens beside another' };
    const gen = w.gen;
    if (gen === null) return gone('no page runs in that window');
    const ref = plainRef(target);
    const r = await posted(w, gen, { t: 'decl-act', key: 'codexmods:window', op: 'chat.side', args: { ref } });
    if (r.status !== 'done') return r;
    return shown(w, gen, () => facts(w)?.panes?.list?.some((p) => p.thread?.id === ref.id) === true, 'open', 'the window does not show that chat beside');
  }
  /** A region another mod's layout holds is that layout's while it holds it (layouts.md D11): the user's own changes release it, a mod's call does not. The refusal, or null. */
  function heldFrom(w, region, caller) {
    const claim = facts(w)?.claim;
    if (!claim || caller?.kind !== 'mod' || claim.picked.split('/')[0] === caller.id || !claim.holds?.includes(region)) return null;
    return { status: 'refused', reason: 'notAllowed', message: `the layout ${claim.picked} holds that region` };
  }
  /** A named layout as its page says it, checked. */
  function claimOf(c) {
    if (!isObject(c) || typeof c.picked !== 'string') return null;
    const partial = Array.isArray(c.partial) ? c.partial.filter((x) => isObject(x) && typeof x.region === 'string' && typeof x.why === 'string').map((x) => ({ region: x.region, why: x.why })) : null;
    const released = Array.isArray(c.released) ? c.released.filter((x) => typeof x === 'string') : null;
    const holds = Array.isArray(c.holds) ? c.holds.filter((x) => typeof x === 'string') : null;
    return { picked: c.picked, settled: c.settled === true, ...(holds?.length ? { holds } : {}), ...(partial?.length ? { partial } : {}), ...(released?.length ? { released } : {}) };
  }
  /**
   * What a window presents now (graph-integrity G4.3): its main region's subject, then each pane's chat, once each; and the one of them the
   * user is in, a pane's when one has focus (its page says which), else its main region's.
   */
  function showsOf(w, a) {
    const out = [];
    const add = (r) => { if (isRef(r) && !out.some((x) => sameRef(x, r))) out.push(plainRef(r)); };
    add(w.current);
    for (const p of Array.isArray(a.panes?.list) ? a.panes.list : []) add(p?.thread);
    const pane = a.panes?.active ? (a.panes.list ?? []).find((p) => p?.token === a.panes.active) : null;
    return { shows: out, focusedSubject: isRef(pane?.thread) ? plainRef(pane.thread) : isRef(w.current) ? plainRef(w.current) : null };
  }
  /** What framework-main says of the window itself (G5.5): the user is in it, its title, its place and size on the screen. */
  const ownOf = (w) => ({
    ...(typeof w.hasFocus === 'boolean' ? { focused: w.hasFocus } : {}), ...(typeof w.title === 'string' ? { title: w.title } : {}),
    ...(w.bounds ? { position: { x: w.bounds.x, y: w.bounds.y }, size: { width: w.bounds.width, height: w.bounds.height } } : {}),
  });
  function putWindow(w) {
    const a = w.arrangement;
    if (!a?.sidebar) return;
    const place = placeOf(w.current);
    w.place = place;
    const { shows, focusedSubject } = showsOf(w, a);
    try {
      handle.put(w.ref, {
        state: { slot: '', hidden: false, decorations: [], current: w.current, history: w.history, shows, ...(focusedSubject ? { focusedSubject } : {}), ...ownOf(w), ...(a.navigation ? { navigation: a.navigation } : {}),
          sidebar: a.sidebar, side: a.side ?? { open: false }, bottom: a.bottom ?? { open: false },
          ...(a.layout || a.claim ? { layout: { ...(a.layout ?? {}), ...(a.claim ? { picked: a.claim.picked, ...(a.claim.partial ? { partial: a.claim.partial } : {}), ...(a.claim.released ? { released: a.claim.released } : {}) } : {}) } } : {}),
          ...(a.regions ? { regions: a.regions } : {}), ...(a.suspended ? { suspended: a.suspended } : {}), ...(a.page ? { page: a.page } : {}), ...(a.panes ? { panes: a.panes.list, ...(a.panes.active ? { activePane: a.panes.active } : {}) } : {}), fullScreen: w.fullScreen },
        links: { subject: refs.app(), parent: null, window: null, thread: place.thread, project: place.project },
      });
      if (!w.put) { w.put = true; handle.emit(w.ref, 'opened', null); }
    } catch (e) { log.warn('windows: a window not put', { message: String(e?.message ?? e) }); }
    putRegions(w);
  }
  /**
   * The window's frame as regions (layouts.md D1, WL1), children of its Window, from its arrangement: its title bar and main region always,
   * the app's rail where the app shows it, the bottom panel open or closed (the chat's, as its side panel). Put when they change.
   */
  const REGIONS = [['TitleBar', 'titleBar'], ['Rail', 'rail'], ['MainRegion', 'main'], ['BottomPanel', 'bottom']];
  function putRegions(w) {
    const a = w.arrangement;
    if (!a?.sidebar || !w.put) return;
    w.regions ??= new Map();
    const base = (slot) => ({ slot, hidden: false, decorations: [] });
    const want = {
      TitleBar: { state: base('titleBar'), subject: refs.app() },
      Rail: a.navigation === 'rail' || a.navigation === 'rail-and-sidebar' ? { state: base('rail'), subject: refs.app() } : null,
      MainRegion: { state: base('main'), subject: w.current ?? refs.app() },
      // its open and size are the Presentation's (G5.1), its place beside the chat its own
      BottomPanel: { state: { ...base('bottom'), open: a.bottom?.open === true, ...(sizeOf(a.bottom) ? { size: sizeOf(a.bottom) } : {}), ...(a.bottom?.at ? { at: a.bottom.at } : {}) }, subject: w.place?.thread ?? refs.app() },
    };
    for (const [type, slot] of REGIONS) {
      const ref = refs.region(type, w.windowId, slot);
      const next = want[type];
      const said = next ? JSON.stringify(next) : null;
      if (said === (w.regions.get(type) ?? null)) continue;
      try {
        if (next) handle.put(ref, { state: next.state, links: { subject: next.subject, window: w.ref, parent: w.ref } });
        else handle.remove(ref);
        if (said) w.regions.set(type, said); else w.regions.delete(type);
      } catch (e) { log.warn('windows: a region not put', { type, message: String(e?.message ?? e) }); }
    }
  }
  /**
   * The window's arrangement from its page's facts (core.mjs shellFactsOf): each region as said, what the page did not say kept, sizes whole
   * non-negative pixels; null when it says nothing of it.
   */
  /** The mods' regions a page says: `{'<mod>/<id>': {open, size, edge}}`, at most 32, or null for none. */
  function suspendedOf(x) {
    if (!Array.isArray(x)) return null;
    const out = [...new Set(x.filter((k) => ['bottom', 'side', 'sidebar'].includes(k) || (typeof k === 'string' && /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/.test(k))))].slice(0, 36);
    return out.length ? out : null;
  }
  function regionsOf(x) {
    if (!isObject(x)) return null;
    const out = {};
    for (const [k, v] of Object.entries(x).slice(0, 32)) {
      if (!/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/.test(k) || !isObject(v) || typeof v.open !== 'boolean' || !['left', 'right'].includes(v.edge)) continue;
      out[k] = { open: v.open, edge: v.edge, ...(Number.isFinite(v.size) && v.size > 0 ? { size: Math.round(v.size) } : {}), ...(v.unsupported === 'frame' ? { unsupported: 'frame' } : {}) };
    }
    return Object.keys(out).length ? out : null;
  }
  function arrangementOf(f, was) {
    const size = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
    const region = (x, prev, keys) => {
      if (!isObject(x) || typeof x.open !== 'boolean') return prev ?? null;
      const out = { open: x.open };
      for (const k of keys) { const v = k === 'full' ? (typeof x[k] === 'boolean' ? x[k] : undefined) : size(x[k]); if (v !== undefined) out[k] = v; }
      return out;
    };
    const next = {
      navigation: ['sidebar', 'rail', 'rail-and-sidebar'].includes(f.navigation) ? f.navigation : was?.navigation ?? null,
      // the sidebar: its width, and its edge where it is not the app's (layouts.md WL4c: `edge: 'right'`; absent: left)
      sidebar: (() => {
        const b = region(f.sidebar, was?.sidebar, ['width']);
        const edge = 'sidebarEdge' in f ? f.sidebarEdge : was?.sidebar?.edge;
        if (!b) return b;
        const { edge: _was, ...rest } = b;
        return edge === 'right' ? { ...rest, edge } : rest;
      })(),
      side: region(f.side, was?.side, ['size', 'full']),
      // the bottom panel: its height below, its width beside the chat, and where it is (layouts.md WL4b: `at` when it is not below)
      bottom: (() => {
        const b = region(f.bottom, was?.bottom, ['height', 'width']);
        const at = 'bottomAt' in f ? f.bottomAt : was?.bottom?.at;
        if (!b) return b;
        const { at: _was, ...rest } = b;
        return at === 'left' || at === 'right' ? { ...rest, at } : rest;
      })(),
      // its workspace's layout as its page shows it, or none (no workspace shown: what it said before no longer holds)
      layout: 'layout' in f ? (isObject(f.layout) && ['chat', 'split', 'full'].includes(f.layout.mode) ? { mode: f.layout.mode } : null) : was?.layout ?? null,
      // the mods' regions (layouts.md WL4a): each its open, width and edge, as the page says them
      regions: 'regions' in f ? regionsOf(f.regions) : was?.regions ?? null,
      // the chats it hosts (layouts.md D8)
      panes: 'panes' in f ? (isObject(f.panes) && Array.isArray(f.panes.list) ? { list: f.panes.list.filter((x) => isObject(x) && typeof x.token === 'string' && isRef(x.thread)).map((x) => ({ token: x.token, thread: plainRef(x.thread) })), active: typeof f.panes.active === 'string' ? f.panes.active : null } : null) : was?.panes ?? null,
      // the named layout it holds (layouts.md D6, D11): its id, whether it has reached what the window shows, what is not as asked, what the user took back
      claim: 'claim' in f ? claimOf(f.claim) : was?.claim ?? null,
      // the mod's page it shows (layouts.md D7), by '<mod>/<id>'
      page: 'page' in f ? (typeof f.page === 'string' ? f.page : null) : was?.page ?? null,
      // what the framework's allocator holds for space (layouts.md D12, WL4d): the mods' regions' keys, bottom, side, sidebar
      suspended: 'suspended' in f ? suspendedOf(f.suspended) : was?.suspended ?? null,
    };
    return next;
  }
  /** The Window's main view changed: its subject is what the window shows now (the newest main view of its generation). */
  function navigated(w) {
    let main = null;
    for (const it of mains.get(w.windowId) ?? []) if (it.gen === w.gen && (!main || it.n > main.n)) main = it;
    const current = main ? plainRef(main.subject) : null;
    if (sameRef(current, w.current) || (!current && !w.current)) return;
    w.current = current;
    if (current && !sameRef(w.history.at(-1), current)) w.history = [...w.history, current].slice(-HISTORY);
    putWindow(w);
    if (current && w.put) handle.emit(w.ref, 'navigated', null);
  }

  // ---------------------------------------------------------------- presentations
  const keyOf = (ref) => `${ref.provider}\u001f${graph.type(ref.type)?.concept ?? ref.type}\u001f${ref.id}`;
  const add = (map, k, it) => { let set = map.get(k); if (!set) map.set(k, (set = new Set())); set.add(it); };
  const drop = (map, k, it) => { const set = map.get(k); if (set && set.delete(it) && !set.size) map.delete(k); };
  const chainOf = (type) => graph.type(type)?.chain ?? [type];
  /**
   * The subject of the item's parent: its own subject, or the one its subject's `via` relation links (read from the subject's links,
   * so the parent's subject need not be resident). Null when there is none; undefined while the subject is not resident (its arrival
   * is a graph event, which looks again).
   */
  function parentSubjectOf(it) {
    const { via, on } = it.place;
    if (on) return on;   // the parent's subject named outright (a framework presentation whose subject has no link to it, E6.5)
    if (!via) return it.subject;
    const snap = graph.resolve(it.subject);
    if (!snap || snap.gone) return undefined;
    const m = graph.type(snap.ref.type)?.members.relations.get(via);
    if (!m || m.cardinality === 'many' || m.inverseOf) return null;   // the subject's type has no such link
    return snap.links?.[via] ?? (m.cardinality === 'one' ? undefined : null);
  }
  /** The parent the item's place names, in its window and generation (the first presented), or null: never guessed. */
  function parentOf(it) {
    const inType = it.place.in;
    if (!inType) return null;
    if (inType === 'Window') return windows.get(it.windowId)?.ref ?? null;
    const target = parentSubjectOf(it);
    if (!target) return null;
    let best = null;
    for (const other of bySubject.get(keyOf(target)) ?? []) {
      if (other === it || other.windowId !== it.windowId || other.gen !== it.gen || !chainOf(other.type).includes(inType)) continue;
      if (!best || other.n < best.n) best = other;
    }
    return best ? best.ref : null;
  }
  /** Put the item with its parent as it is now; an orphan waits for a presentation of its parent's type. */
  /**
   * The state a new presentation starts with until the user chooses (graph-integrity G5.2): as it appears, the first mod whose default fits
   * its subject runs the user's operation for it (as that mod, its origin the default), where its state differs or is not known (the app
   * deciding by itself: then its state is set as the default's). Never over the user's choice: a presentation of that subject in that place
   * whose state changed otherwise, in this window, takes none again.
   */
  const CHOSEN_MAX = 2000;
  function stateDefaults(w, it, was) {
    if (it.framework) return;
    const now = it.state.expanded;
    const key = `${it.type}\u001f${it.subjectKey}\u001f${it.place.in ?? ''}\u001f${it.place.via ?? ''}\u001f${it.pane ?? ''}`;
    if (it.applying !== undefined && now === it.applying) { it.applying = undefined; return; }   // the default's own, taken
    if (typeof was?.expanded === 'boolean' && typeof now === 'boolean' && was.expanded !== now) {
      it.applying = undefined;
      w.chosen ??= new Set();
      w.chosen.delete(key);
      w.chosen.add(key);
      if (w.chosen.size > CHOSEN_MAX) w.chosen.delete(w.chosen.values().next().value);
      return;
    }
    if (it.defaulted || typeof graph.presentationDefaults !== 'function') return;
    it.defaulted = true;
    if (w.chosen?.has(key)) return;
    const subject = graph.resolve(it.subject);
    if (!subject || subject.gone) return;
    let d = null;
    try { d = graph.presentationDefaults(it.type, subject).find((x) => typeof x.state.expanded === 'boolean') ?? null; } catch (e) { log.warn('windows: a default not read', { message: String(e?.message ?? e) }); }
    if (!d || d.state.expanded === now) return;
    it.applying = d.state.expanded;
    const operation = d.state.expanded ? '_expand' : '_collapse';
    Promise.resolve(graph.invoke({ ref: it.ref, operation, args: [], caller: { kind: 'mod', id: d.mod, owner: `mod:${d.mod}` }, origin: `default:${d.id}` }))
      .then((out) => { if (out?.status !== 'done') { it.applying = undefined; if (out?.status !== 'refused') log.warn('windows: a default not applied', { type: it.type, status: out?.status }); } })
      .catch((e) => { it.applying = undefined; log.warn('windows: a default not applied', { message: String(e?.message ?? e) }); });
  }
  /** What the window's own facts add to a presentation's state (G5.1): its side panel's open and width are its arrangement's. */
  function derivedOf(it) {
    if (it.type !== 'SidePanel') return null;
    const side = windows.get(it.windowId)?.arrangement?.side;
    return isObject(side) ? { open: side.open === true, ...(Number.isFinite(side.size) ? { size: { width: Math.round(side.size) } } : {}) } : null;
  }
  /** The window's arrangement moved: its presentations whose state it gives are put again where it changed. */
  function rederive(w) {
    for (const it of items.values()) {
      if (it.windowId !== w.windowId || it.gen !== w.gen || it.type !== 'SidePanel' || !it.written) continue;
      const next = { ...(it.reported ?? it.state), ...(derivedOf(it) ?? {}) };
      if (JSON.stringify(next) === JSON.stringify(it.state)) continue;
      it.state = next;
      try { handle.put(it.ref, { state: it.state, links: { subject: it.subject, window: w.ref, parent: it.parent } }); } catch (e) { log.warn('windows: a presentation not put', { message: String(e?.message ?? e) }); }
    }
  }
  function write(it) {
    const p = parentOf(it);
    if (it.place.in && it.place.in !== 'Window' && !p) add(orphans, it.place.in, it); else drop(orphans, it.place.in, it);
    if (it.written && sameRef(p, it.parent)) return;
    it.parent = p;
    it.written = true;
    handle.put(it.ref, { state: it.state, links: { subject: it.subject, window: windows.get(it.windowId)?.ref ?? null, parent: p } });
  }
  const tryWrite = (it) => { try { write(it); } catch (e) { log.warn('windows: a presentation not put', { message: String(e?.message ?? e) }); } };
  /** Forget an item in every index. */
  function unindex(it) {
    items.delete(it.ref.id);
    drop(bySubject, it.subjectKey, it);
    if (it.place.in) drop(orphans, it.place.in, it);
    drop(mains, it.windowId, it);
  }
  /** A presentation goes; its children look for their parent again (another presentation of the same subject, or none). */
  function removeItem(it) {
    const children = (graph.related(it.ref, 'children') ?? []).map((c) => items.get(c.ref.id)).filter(Boolean);
    unindex(it);
    try { handle.remove(it.ref); } catch { /* gone */ }
    for (const c of children) tryWrite(c);
  }
  // A mod's default of the sidebar's width (layouts.md D4, public-hooks.md §3.8): each window where the user kept no width of their own
  // shows it, set live in the window as Window.setRegion sets it, once per page and again when the default changes (back to the app's
  // own when it goes); the user's kept width wins (a window keeps what it shows, and windows made later read the user's).
  function sidebarDefault(w) {
    const s = graph.resolve(SIDEBAR_WIDTH);
    if (!w.gen || !s || s.state?.overridden === true || typeof s.state?.value !== 'number') return;
    const want = s.state.value;
    if ((w.sidebarDefault ?? APP_SIDEBAR_WIDTH) === want) return;
    const bar = shownItem(w, 'Sidebar');
    if (!bar) return;
    w.sidebarDefault = want;   // tried once for this value (a window too narrow for it keeps what it shows)
    inPage(bar.ref, 'width', [want, true]).then((r) => { if (r.status !== 'done') log.info('windows: a sidebar width default not shown', { windowId: w.windowId, outcome: r.status }); });
  }
  // A subject that arrives or changes may give its presentations another parent (a message's turn, a thread's project).
  const menuEntries = new Map();   // the app's menu bar entries (E8.4b): path key -> item
  const graphEvents = graph.onEvent?.((e) => {
    if (!disposed && e?.ref && sameRef(e.ref, SIDEBAR_WIDTH)) for (const w of windows.values()) sidebarDefault(w);
    if (!disposed && e?.kind === 'removed' && e.ref) for (const a of [...asks.values()]) if (sameRef(a.subject, e.ref)) a.settle(cancelled('framework', 'the subject went'));
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own notifications
    if (!disposed && e?.ref && e.ref.provider === 'codex' && isA(e.ref, 'Notification')) banner(e.ref, e.kind === 'removed' ? null : graph.resolve(e.ref));
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own commands
    if (!disposed && e?.ref && e.ref.provider === 'codex' && e.ref.type === 'Command' && (e.kind === 'added' || e.kind === 'changed') && menuEntries.size) pairMenuEntries();
    // eslint-disable-next-line codexmods/no-provider-identity -- the windows provider's own presentations
    if (disposed || !e?.ref || e.ref.provider === PROVIDER || (e.kind !== 'added' && e.kind !== 'changed')) return;
    // what a window shows arrived or changed (a chat moved to another project): where the window is, again
    // the same instance whatever subtype either ref names (H7w review 1)
    const one = (a, b) => isRef(a) && isRef(b) && a.provider === b.provider && a.id === b.id && (graph.type(a.type)?.concept ?? a.type) === (graph.type(b.type)?.concept ?? b.type);
    for (const w of windows.values()) {
      if (!w.put || !one(w.current, e.ref)) continue;
      const place = placeOf(w.current);
      const same = (a, b) => (a ?? null) === (b ?? null) || sameRef(a, b);
      if (!same(place.thread, w.place?.thread) || !same(place.project, w.place?.project)) putWindow(w);
    }
    const set = bySubject.get(keyOf(e.ref));
    if (set) for (const it of [...set]) if (it.place.via) tryWrite(it);
  });

  // ---------------------------------------------------------------- outside a window (decision 5)
  // Presentations no window holds (no `window` link): numbered under DESKTOP, generation 1, for this provider's life. The Dock's badge
  // (the App's) while framework-main runs; a banner for each of Codex's desktop notifications not yet read (opened or dismissed), as
  // the notifications framework-main observes say (breadth.md D9), gone once read or gone.
  let desktopN = 0;
  const desktopCount = () => { let n = 0; for (const it of items.values()) if (it.windowId === DESKTOP) n++; return n; };
  const banners = new Map();   // notification key -> item
  function putDesktop(type, subject, slot, own = {}) {
    const n = ++desktopN;
    const it = { ref: refs.presentation(type, DESKTOP, 1, n), windowId: DESKTOP, gen: 1, n, type, subject: plainRef(subject), subjectKey: keyOf(subject),
      place: { in: null, via: null, on: null }, framework: false, ask: null, written: false, parent: null, state: { slot, hidden: false, decorations: [], ...own } };
    items.set(it.ref.id, it);
    add(bySubject, it.subjectKey, it);
    tryWrite(it);
    return it;
  }
  function banner(ref, inst) {
    const key = keyOf(ref);
    const showing = !!inst && !inst.gone && inst.state?.read === false;
    const it = banners.get(key);
    if (showing && !it) banners.set(key, putDesktop('NotificationBanner', ref, 'desktop'));
    else if (!showing && it) { banners.delete(key); removeItem(it); }
  }
  if (o.mainOps) putDesktop('DockBadge', refs.app(), 'dock');

  // The app's own menu bar entries (E8.4b): one MenuEntry each, by its path of labels, its subject the Command its title names (the app's
  // command of that title) or else the App; framework-main tells them at the start and when they change (the app builds its menu again on
  // focus, keymap and locale).
  const normTitle = (t) => String(t).replace(/[.…]+$/u, '').trim().toLowerCase();
  // the app's commands no mod chooses from the menu bar (review 4): the user's settings and account
  const PROTECTED_COMMANDS = new Set(['settings', 'logOut', 'quit']);
  const isProtected = (subject) => subject?.type === 'Command' && PROTECTED_COMMANDS.has(subject.id);
  const commandOf = (title) => {
    const want = normTitle(title);
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own commands
    const c = (graph.list?.('Command') ?? []).find((x) => x?.ref?.provider === 'codex' && typeof x.state?.title === 'string' && normTitle(x.state.title) === want);
    return c ? plainRef(c.ref) : refs.app();
  };
  function syncMenuEntries(list) {
    if (disposed || !Array.isArray(list)) return;
    const seen = new Set();
    for (const e of list.slice(0, 300)) {
      if (!isObject(e) || !Array.isArray(e.path) || !e.path.every((x) => typeof x === 'string') || typeof e.title !== 'string') continue;
      const key = e.path.join('\u0000');
      seen.add(key);
      const state = { title: e.title, menu: typeof e.menu === 'string' ? e.menu : '', ...(typeof e.shortcut === 'string' ? { shortcut: e.shortcut } : {}), enabled: e.enabled !== false,
        ...(typeof e.checked === 'boolean' ? { checked: e.checked } : {}) };
      let it = menuEntries.get(key);
      if (!it) {
        const subject = commandOf(e.title);
        if (isProtected(subject)) { seen.delete(key); continue; }
        it = putDesktop('MenuEntry', subject, 'menuBar', state); it.menuPath = e.path; menuEntries.set(key, it); continue;
      }
      // the entry as the app's menu has it now (a shortcut or a check it lost is gone)
      const next = { slot: it.state.slot, hidden: it.state.hidden, decorations: it.state.decorations, ...state };
      if (JSON.stringify(next) !== JSON.stringify(it.state)) { it.state = next; it.written = false; tryWrite(it); }
    }
    for (const [key, it] of [...menuEntries]) if (!seen.has(key)) { menuEntries.delete(key); removeItem(it); }
  }
  /** The Command one of the app's menu bar entries names (by its path of labels), or null: an entry not known, or one that names none. */
  function menuEntryCommand(path) {
    if (!Array.isArray(path) || !path.every((x) => typeof x === 'string')) return null;
    const it = menuEntries.get(path.join('\u0000'));
    return it && it.subject?.type === 'Command' ? plainRef(it.subject) : null;
  }
  /** The app's commands came or changed: an entry that named none takes the one its title names now (it is put again, as that Command's). */
  function pairMenuEntries() {
    for (const [key, it] of [...menuEntries]) {
      if (it.subject.type !== 'App') continue;
      const c = commandOf(it.state.title);
      if (c.type === 'App') continue;
      removeItem(it);
      if (isProtected(c)) { menuEntries.delete(key); continue; }
      const again = putDesktop('MenuEntry', c, 'menuBar', { title: it.state.title, menu: it.state.menu, enabled: it.state.enabled,
        ...(it.state.shortcut !== undefined ? { shortcut: it.state.shortcut } : {}), ...(it.state.checked !== undefined ? { checked: it.state.checked } : {}) });
      again.menuPath = it.menuPath;
      menuEntries.set(key, again);
    }
  }
  const menuReports = o.mainOps?.onReport?.('menus', (r) => { if (r?.event === 'entries') syncMenuEntries(r.entries); }) ?? null;
  if (o.mainOps) o.mainOps.op('menus', 'entries', {}).then((r) => { if (r?.ok) syncMenuEntries(r.result?.entries); }, () => {});
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own notifications
  for (const n of graph.list?.('Notification') ?? []) if (n?.ref?.provider === 'codex') banner(n.ref, n);

  /** A report's item as this provider keeps it; throws Invalid. */
  function check(x) {
    if (!isObject(x) || !Number.isSafeInteger(x.n) || x.n <= 0) throw new CodexModsError('Invalid', 'a presentation needs its number');
    if (typeof x.type !== 'string' || !(TYPES.includes(x.type) || FRAMEWORK_TYPES.includes(x.type)) || x.type === 'Window') throw new CodexModsError('Invalid', `not a presentation type of this provider: ${x.type}`);
    if (!isRef(x.subject)) throw new CodexModsError('Invalid', 'a presentation needs its subject');
    const place = isObject(x.place) ? x.place : {};
    const decorations = (Array.isArray(x.decorations) ? x.decorations : []).filter((d) => isObject(d) && typeof d.by === 'string' && DECORATION_KINDS.has(d.kind) && typeof d.rule === 'string')
      .slice(0, 32).map((d) => ({ by: d.by, kind: d.kind, rule: d.rule }));
    return {
      type: x.type, subject: plainRef(x.subject), framework: x.framework === true, ask: x.type === 'Dialog' && Number.isSafeInteger(x.ask) ? x.ask : null,
      pane: typeof x.pane === 'string' && x.pane ? x.pane.slice(0, 64) : null,
      place: { in: typeof place.in === 'string' && place.in ? place.in : null, via: typeof place.via === 'string' && place.via ? place.via : null, on: isRef(place.on) ? plainRef(place.on) : null },
      state: {
        slot: typeof x.slot === 'string' ? x.slot.slice(0, 64) : '', hidden: x.hidden === true, decorations,
        ...(Number.isFinite(x.order) ? { order: x.order } : {}), ...(typeof x.selected === 'boolean' ? { selected: x.selected } : {}),
        ...(typeof x.expanded === 'boolean' ? { expanded: x.expanded } : {}),
        // what else of its user-visible state its binding can tell (graph-integrity G5.1)
        ...(typeof x.focused === 'boolean' ? { focused: x.focused } : {}), ...(typeof x.open === 'boolean' && OPENS.has(x.type) ? { open: x.open } : {}),
        ...(sizeOf(x.size) ? { size: sizeOf(x.size) } : {}),
        ...(x.type === 'DiffView' && (x.layout === 'unified' || x.layout === 'split') ? { layout: x.layout } : {}),
      },
    };
  }

  /**
   * App.openWindow's new window, the app's own way (framework-main asks a window's page: the app's "Open in New Window"), on the chat
   * `target` names, else on the app's home (`then`: anything else `target` names is opened in it after, by openWindow). Its Window once its
   * page has reported what it shows; failed when none came in time. One at a time (openWindow).
   */
  let opening = Promise.resolve();
  const EXACT_MS = 1500;   // a window that must be the one asked for (one that is then changed) is taken only after this long with no other new
  /**
   * `exact` (H7pl review 1): the window is then changed (a mod's view put in it), so it must be the one asked for, not one the user opened
   * at the same moment: the app says nothing of which request a window answers, so it is taken only once it alone came since the ask and a
   * while has passed with no other; else refused (the window opened stays as it is). `beforeCreate`: false refuses before anything opens.
   */
  async function openOne(target, { exact = false, beforeCreate = null } = {}) {
    if (target != null && !isRef(target)) return { status: 'refused', reason: 'invalid', message: 'openWindow takes a ref, or nothing' };
    const thread = target != null && graph.type(target.type)?.chain.includes('Thread');
    // a chat the graph knows (the app would open a window on any id), by the id the app knows it by
    const resident = thread ? graph.resolve(target) : null;
    const threadId = resident && !resident.gone ? appIdOf(target) : null;
    if (thread && resident && !resident.gone && !threadId) return { status: 'refused', reason: 'unsupported', message: 'a new window opens on one of the app\'s own chats: a mod\'s chat opens in a window (Window.open)' };
    if (thread && !threadId) return { status: 'refused', reason: 'unavailable', message: 'the app does not show this thread' };
    const known = new Set(windows.keys());
    const created = [];
    const sub = o.bus?.subscribe?.('window/created', (d) => { if (Number.isSafeInteger(d?.windowId) && !known.has(d.windowId)) created.push(d.windowId); });
    try {
      const front = await askWindow().catch(() => null);
      if (beforeCreate && !beforeCreate()) return { status: 'refused', reason: 'unavailable', message: 'it is no longer wanted' };
      const since = Date.now();
      const asked = await main('newWindow', { path: threadId ? `/local/${threadId}` : '/', ...(front ? { windowId: front.windowId } : {}) });
      if (asked.status !== 'done') return asked;
      // a window that came since it was asked and shows what was asked: the chat, or (the home) the new chat
      // (the chat by its resident identity: a ref to the concept names its CodexThread)
      const shows = (k) => { const w = windows.get(k); return !!w?.put && (thread ? sameRef(w.current, resident.ref) : w.current?.type === 'Draft'); };
      for (let i = 0; i < NEW_WINDOW_TRIES; i++) {
        const fresh = [...new Set([...created, ...[...windows.keys()].filter((k) => !known.has(k))])];
        if (exact && fresh.length > 1) return { status: 'refused', reason: 'unavailable', message: 'another window opened at the same moment: which one answers this is not known' };
        const id = fresh.find(shows);
        if (id !== undefined && (!exact || Date.now() - since >= EXACT_MS)) return { status: 'done', value: refs.window(id), windowId: id, then: target != null && !thread };
        await new Promise((r) => { const t = setT(r, SHOW_EVERY_MS); t?.unref?.(); });
      }
      return { status: 'failed', error: { message: 'the new window did not come in time' } };
    } finally { sub?.dispose?.(); }
  }
  const api = {
    handle,
    /**
     * Run a renderer-realm rule's function in a window's page (mod-surfaces.md §3.4: a menu bar entry chosen in that window): `{key, path,
     * env}`. False when the window has no page reporting now.
     */
    /**
     * Do a page operation on the presentation of `type` that shows `subject` (E8.3b: a Draft's live composer): the graph's outcome, or null
     * when no window's page shows one now. A page that cannot do it says so (refused), and the caller falls back.
     */
    async actOn(type, subject, operation, args, windowId = null) {
      if (!isRef(subject)) return null;
      const want = plainRef(subject);
      // `windowId`: an operation that already used a window (it showed the subject there) stays in it
      const shown = [...items.values()].filter((it) => it.type === type && it.subject && it.subject.type === want.type && it.subject.provider === want.provider
        && it.subject.id === want.id && windows.get(it.windowId)?.gen === it.gen && (windowId === null || it.windowId === windowId));
      if (!shown.length) return null;
      // one window: the one the user is in when it shows it, else the only one that does (a page numbers its own mounts, so mounts of
      // two windows are not compared); within it, its newest mount
      const ids = [...new Set(shown.map((it) => it.windowId))];
      let chosen = ids.length === 1 ? ids[0] : null;
      if (chosen === null) {
        const w = await askWindow().catch(() => null);
        if (!w || !ids.includes(w.windowId)) return { status: 'refused', reason: 'unavailable', message: 'more than one window shows it and none is the one in front' };
        chosen = w.windowId;
      }
      let mine = shown.filter((it) => it.windowId === chosen).sort((a, b) => b.n - a.n);
      // within a window, the pane the operation names (layouts.md D8); with none named, the one the user is in where that shows it, else its newest
      const held = paneNamed.getStore();
      const named = held?.pane;
      if (named !== undefined) {
        mine = mine.filter((it) => paneKey(it.pane) === named && (held.gen === undefined || it.gen === held.gen));
        if (!mine.length) return { status: 'refused', reason: 'gone', message: 'that pane has closed', windowId: chosen };
      } else {
        const active = facts(windows.get(chosen))?.panes?.active ?? null;
        const there = mine.filter((it) => (it.pane ?? null) === active);
        if (there.length) mine = there;
      }
      // the window it ran in goes along: an operation of several steps keeps to it (review 4)
      const out = await inPage(mine[0].ref, operation, Array.isArray(args) ? args : []);
      return out && typeof out === 'object' ? { ...out, windowId: chosen } : out;
    },
    /**
     * The one window an operation of several steps on `subject` keeps to (graph-layers.md §2): the window that shows a presentation of
     * `type` of it, or with several the one in front if it is one of them (else refused: which one is not known); when none shows it,
     * the window in front. `{windowId, shows}` (null: no window has a page; `shows`: that window shows it), or `{refused}`.
     */
    async chooseWindow(type, subject) {
      const want = isRef(subject) ? plainRef(subject) : null;
      const named = paneNamed.getStore()?.pane;
      const ids = want ? [...new Set([...items.values()].filter((it) => it.type === type && it.subject && sameRef(it.subject, want) && windows.get(it.windowId)?.gen === it.gen && (named === undefined || paneKey(it.pane) === named)).map((it) => it.windowId))] : [];
      if (ids.length === 1) return { windowId: ids[0], shows: true };
      const front = await this.frontWindow();
      if (!ids.length) return { windowId: front, shows: false };
      return ids.includes(front) ? { windowId: front, shows: true } : { refused: gone('more than one window shows it and none is the one in front') };
    },
    /** An operation (layouts.md D8): `fn` runs with the pane it names (`{pane}`), or with none until `capturePane`; what it acts on in a window is that pane's. */
    withPane(pane, fn) { return paneNamed.run({ pane: pane === undefined || pane === null ? undefined : String(pane), gen: undefined }, fn); },
    /** The pane the running operation has settled on, and that window's page: its later steps keep to them, whatever opens, takes the focus or reloads meanwhile. */
    capturePane(windowId, token) {
      const held = paneNamed.getStore();
      if (!held) return;
      held.pane ??= token;
      held.gen ??= windows.get(windowId)?.gen ?? undefined;
    },
    /** The pane the running operation keeps to, if it has one. */
    heldPane() { return paneNamed.getStore()?.pane; },
    /** The panes of that window's current page that show a presentation of `type` of `subject`: tokens, `route` for the window's own page. */
    panesOf(windowId, type, subject) {
      const w = windows.get(windowId);
      if (!w || w.gen === null || !isRef(subject)) return [];
      return [...new Set([...items.values()].filter((it) => it.type === type && it.windowId === windowId && it.gen === w.gen && it.subject && sameRef(it.subject, subject)).map((it) => paneKey(it.pane)))];
    },
    /** Does that window's current page show a presentation of `type` of `subject`? */
    showsIn(windowId, type, subject) {
      const w = windows.get(windowId);
      return !!w && w.gen !== null && isRef(subject) && [...items.values()].some((it) => it.type === type && it.windowId === windowId && it.gen === w.gen && it.subject && sameRef(it.subject, subject));
    },
    /**
     * App.openWindow: a new window the app's own way (framework-main asks a window's page: the app's "Open in New Window"), on the chat
     * `target` names, else on the app's home, where anything else `target` names is then opened (Window.open, as the caller). Its Window
     * once its page has reported; failed when none came in time.
     */
    async openWindow(target, call = null, opts = {}) {
      // one at a time, the window's coming only: a window is the one asked for by what it shows (the chat, or the home's new chat), so two
      // asks never share one; what is then opened in it (a settings section, an automation) runs after, out of the queue
      const run = opening.then(() => openOne(target, opts));
      opening = run.catch(() => {});
      const made = await run;
      if (made.status !== 'done') return made;
      if (!made.then) return { status: 'done', value: made.value };
      const shown = await open(made.windowId, target, call);
      return shown && shown.status !== 'done' ? shown : { status: 'done', value: refs.window(made.windowId) };
    },
    /** The window the user is in that has a page reporting (the one in front), or the only such window; null when neither. */
    async frontWindow() {
      const w = await askWindow().catch(() => null);
      if (w) return w.windowId;
      const live = [...windows.values()].filter((x) => x.gen !== null && x.channel);
      return live.length === 1 ? live[0].windowId : null;
    },
    /**
     * Run a renderer-realm rule's function in a window's page (a menu bar entry chosen there, a mod's Command run): the page answers
     * whether it ran (done), did not (refused: gone, registered again, off) or failed; a page that goes before answering leaves it not
     * known (failed). `msg.reg` is the window's own registration the run came from (review 4, round 2).
     */
    /** The chat a window shows (its Window's `thread`), or null. */
    threadOf(windowId) { return windows.get(windowId)?.place?.thread ?? null; },
    /** One of a mod's declarations, acted on in a window's page (graph-layers.md §3.1: a filter turned on, a panel view opened). */
    async declarationAct(windowId, key, op, args, reg = null) {
      const w = windows.get(windowId);
      if (!w || w.gen === null || !w.channel || typeof w.channel.post !== 'function') return gone('no page runs in that window');
      return posted(w, w.gen, { t: 'decl-act', key: String(key), op: String(op), args: args ?? {}, ...(typeof reg === 'string' ? { reg } : {}) });
    },
    /** The generation of the page in a window now (null: none reports): what a notice about that page names (notify's `at.gen`). */
    genOf(windowId) { return windows.get(windowId)?.gen ?? null; },
    /** The user's own pick of a named layout, from the menu bar (layouts.md D6): the framework's, no mod's call. */
    async pickLayout(windowId, id) {
      const w = windows.get(windowId);
      if (!w || w.gen === null) return gone('no page runs in that window');
      return posted(w, w.gen, { t: 'decl-act', key: 'codexmods:window', op: 'layout.set', args: { id } });
    },
    async runRule(windowId, msg) {
      const w = windows.get(windowId);
      if (!w || w.gen === null || !w.channel || typeof w.channel.post !== 'function') return gone('no page runs in that window');
      return posted(w, w.gen, { t: 'rule-run', key: String(msg.key), ...(typeof msg.reg === 'string' ? { reg: msg.reg } : {}), path: String(msg.path), env: msg.env ?? null });
    },
    /** A page reports for the first time (or again after a reload): a new generation; the previous one's presentations go. */
    open(windowId, channel = null) {
      if (!Number.isSafeInteger(windowId)) throw new CodexModsError('Invalid', 'a window id is a number');
      let w = windows.get(windowId);
      if (!w) {
        w = { windowId, ref: refs.window(windowId), gen: null, arrangement: null, fullScreen: fullScreens.get(windowId) === true, current: null, history: [], put: false, ...(owns.get(windowId) ?? {}) };
        windows.set(windowId, w);
      }
      if (w.gen !== null) this.close(windowId, w.gen);
      w.gen = ++genSeq;
      w.sidebarDefault = undefined;   // a new page starts with the app's own width (the kept one, or its built-in)
      w.channel = channel;
      putWindow(w);
      return w.gen;
    },
    /** A page's channel closed: the generation it opened ends (a later page's is not touched). */
    closeChannel(channel) {
      for (const w of windows.values()) if (channel && w.channel === channel && w.gen !== null) this.close(w.windowId, w.gen);
    },
    /** The page's deltas: {puts: [...], removes: [n...], window?: {navigation?, sidebar?, side?, bottom?, layout?, ...}}. A stale generation's report is ignored. */
    report(windowId, gen, batch) {
      const w = windows.get(windowId);
      if (!w || w.gen !== gen || !isObject(batch)) return false;
      const t0 = now();
      stats.batches++;
      try { stats.bytes += JSON.stringify(batch).length; } catch { /* not JSON: nothing to count */ }
      if (isObject(batch.page)) w.page = Object.fromEntries(Object.entries(batch.page).filter(([, v]) => Number.isFinite(v)).slice(0, 8));
      let mainChanged = false;
      for (const n of Array.isArray(batch.removes) ? batch.removes : []) {
        const it = items.get(`${windowId}.${gen}.${n}`);
        if (!it) continue;
        if (it.place.in === 'Window') mainChanged = true;
        removeItem(it);
        stats.removes++;
      }
      const added = new Set();   // the types (with their ancestors) of the presentations new in this batch
      for (const x of Array.isArray(batch.puts) ? batch.puts.slice(0, MAX_PUTS) : []) {
        let c;
        try { c = check(x); } catch (e) { log.warn('windows: a presentation refused', { message: String(e?.message ?? e) }); continue; }
        const id = `${windowId}.${gen}.${x.n}`;
        let it = items.get(id);
        // A ref names one subject in one place: the page gives a presentation that changes them a new number, so this one only goes.
        if (it && (it.type !== c.type || !sameRef(it.subject, c.subject) || it.place.in !== c.place.in || it.place.via !== c.place.via)) {
          log.warn('windows: a presentation changed its identity; it goes', { id });
          if (it.place.in === 'Window') mainChanged = true;
          removeItem(it);
          continue;
        }
        const was = it ? { hidden: it.state.hidden, selected: it.state.selected, expanded: it.state.expanded } : null;
        if (!it) {
          it = { ref: refs.presentation(c.type, windowId, gen, x.n), windowId, gen, n: x.n, type: c.type, subject: c.subject, subjectKey: keyOf(c.subject), place: c.place, framework: c.framework, ask: c.ask, written: false, parent: null, pane: c.pane };
          items.set(id, it);
          add(bySubject, it.subjectKey, it);
          if (c.place.in === 'Window' && c.state.slot === 'main') add(mains, windowId, it);
          for (const t of chainOf(c.type)) added.add(t);
        }
        it.reported = c.state;
        it.state = { ...c.state, ...(derivedOf(it) ?? {}) };
        if (c.place.in === 'Window') mainChanged = true;
        try {
          if (!it.written) write(it);
          else handle.put(it.ref, { state: it.state, links: { subject: it.subject, window: w.ref, parent: it.parent } });
          stats.puts++;
          if (was && was.hidden !== it.state.hidden) handle.emit(it.ref, it.state.hidden ? 'hidden' : 'shown', null);
          if (it.state.selected === true && was?.selected !== true) handle.emit(it.ref, 'selected', null);
        } catch (e) { unindex(it); log.warn('windows: a presentation not put', { message: String(e?.message ?? e) }); continue; }
        stateDefaults(w, it, was);
      }
      // The orphans whose parent's type was just presented look again.
      for (const t of added) for (const it of [...(orphans.get(t) ?? [])]) if (it.windowId === windowId && it.gen === gen) tryWrite(it);
      if (isObject(batch.window)) {
        const next = arrangementOf(batch.window, w.arrangement);
        // the shell's facts of this page (a report of its other facts before the shell is drawn leaves the old page's uncounted)
        if (['navigation', 'sidebar', 'side'].some((k) => k in batch.window)) { w.factsGen = gen; w.pageHidden = batch.window.hidden === true; }
        if (JSON.stringify(next) !== JSON.stringify(w.arrangement)) { w.arrangement = next; putWindow(w); rederive(w); }
      }
      sidebarDefault(w);
      // the new chat's target as this window's composer shows it (E8.3h): for the Draft's provider, when it changes
      if (isObject(batch.window) && 'newChat' in batch.window) {
        const target = isObject(batch.window.newChat) ? batch.window.newChat : null;
        const said = JSON.stringify(target);
        if (said !== w.newChat) { w.newChat = said; try { o.bus?.publish?.('window/newChat', { windowId, target }); } catch (e) { log.warn('windows: the new chat\'s target not told', { message: String(e?.message ?? e) }); } }
      }
      // its composers' attachments, by the Draft each shows (H8d): for the Draft's provider, when they change
      if (isObject(batch.window) && isObject(batch.window.attachments)) {
        const said = JSON.stringify(batch.window.attachments);
        if (said !== w.attachments) { w.attachments = said; try { o.bus?.publish?.('window/attachments', { windowId, drafts: batch.window.attachments }); } catch (e) { log.warn('windows: the composers\' attachments not told', { message: String(e?.message ?? e) }); } }
      }
      if (mainChanged) navigated(w);
      stats.maxReportMs = Math.max(stats.maxReportMs, now() - t0);
      return true;
    },
    /** The page's answer to an act it was sent (only the page of that act's window and generation answers it). */
    answer(windowId, gen, id, outcome) {
      const a = acts.get(id);
      if (!a || a.windowId !== windowId || a.gen !== gen) return false;
      a.settle(outcomeOf(outcome));
      return true;
    },
    /** The page's user actions, in order: [{n, operation, action?}]. */
    acted(windowId, gen, events) {
      const w = windows.get(windowId);
      if (!w || w.gen !== gen || !Array.isArray(events)) return 0;
      let count = 0;
      for (const e of events.slice(0, 64)) {
        const it = isObject(e) ? items.get(`${windowId}.${gen}.${e.n}`) : null;
        if (!it || typeof e.operation !== 'string' || !e.operation) continue;
        try { handle.emit(it.ref, 'acted', { operation: e.operation.slice(0, 64), ...(typeof e.action === 'string' ? { action: e.action.slice(0, 200) } : {}) }); count++; stats.events++; } catch (err) { log.warn('windows: an action not reported', { message: String(err?.message ?? err) }); }
      }
      return count;
    },
    /** The page of this generation went (a reload, its channel closed): its presentations go; the Window stays until the window closes. */
    close(windowId, gen) {
      const w = windows.get(windowId);
      if (!w || w.gen !== gen) return;
      for (const it of [...items.values()]) if (it.windowId === windowId && it.gen === gen) { unindex(it); try { handle.remove(it.ref); } catch { /* gone */ } }
      settleActs(windowId, gen, 'the window\'s page went');
      for (const a of [...asks.values()]) if (a.windowId === windowId && a.gen === gen) a.settle(cancelled('framework', 'the window\'s page went'), false);
      // its toasts went with it: their mods hear so (their actions can no longer be chosen)
      for (const n of [...notes.values()]) if (n.where === 'toast' && n.windowId === windowId && n.gen === gen) { notes.delete(n.id); tellMod(n.modId, { id: n.id, gone: true }); }
      w.gen = null;
      // its side panel is no longer known to be open (the page that said so went); what it said of the rest no longer counts for an
      // operation (`facts`) until the next page says it again
      if (w.arrangement?.side?.open) { w.arrangement = { ...w.arrangement, side: { open: false } }; putWindow(w); }
      w.channel = null;
      // its page's facts go with it (a reload, a new channel, the window closing): a new chat's target it showed no longer counts
      // (graph-layers.md §5)
      if (w.newChat !== undefined && w.newChat !== null && w.newChat !== 'null') {
        w.newChat = null;
        try { o.bus?.publish?.('window/newChat', { windowId, target: null }); } catch (e) { log.warn('windows: the new chat\'s target not let go', { message: String(e?.message ?? e) }); }
      }
      if (w.attachments !== undefined && w.attachments !== '{}') {
        w.attachments = '{}';
        try { o.bus?.publish?.('window/attachments', { windowId, drafts: {} }); } catch (e) { log.warn('windows: the composers\' attachments not let go', { message: String(e?.message ?? e) }); }
      }
      navigated(w);
    },
    ask,
    askAnswer,
    askWithdraw,
    notify,
    menuEntryCommand,
    /** A mod ends one of its notifications. */
    /** A mod ends one of its notifications: that showing (`token`), never a later one of the same id. */
    notifyEnd(modId, id, token) { const n = notes.get(id); if (!n || n.modId !== modId || (token !== undefined && token !== n.token)) return false; closeNote(n, false); return true; },
    noticeAnswer,
    noticeDesktop,
    /** What the user did with a mod's notifications, to that mod's realm. */
    onNotices(modId, fn) {
      if (!noteListeners.has(modId)) noteListeners.set(modId, new Set());
      noteListeners.get(modId).add(fn);
      return { dispose() { noteListeners.get(modId)?.delete(fn); } };
    },
    /** A mod stopped: the Dock's badge it held goes back (to the previous holder, then the app's own count). */
    async releaseBadge(modId) {
      if (!o.mainOps) return;
      for (const holder of [...badgeHolders].filter((h) => h === modId || h.startsWith(`${modId}:`))) {
        badgeHolders.delete(holder);
        // a failed release stays owed: the holder is kept, let go at the mod's next stop
        const r = await o.mainOps.op('dock', 'badge', { holder, value: null }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (!r?.ok) { badgeHolders.add(holder); log.warn('windows: the badge was not let go', { message: r?.error }); }
      }
    },
    /** The requester stopped (disabled, removed, quarantined): its open questions are cancelled. */
    cancelAsks(modId) {
      stops.set(modId, (stops.get(modId) ?? 0) + 1);
      for (const a of [...asks.values()]) if (a.requester.id === modId) a.settle(cancelled('framework', 'the mod that asked stopped'));
      // its notifications go with it
      for (const n of [...notes.values()]) if (n.modId === modId) closeNote(n, false);
    },
    /** framework-main: the window closed. */
    windowClosed(windowId) {
      sidebarCalls.delete(windowId);
      const w = windows.get(windowId);
      if (!w) return;
      if (w.gen !== null) this.close(windowId, w.gen);
      windows.delete(windowId);
      fullScreens.delete(windowId);
      owns.delete(windowId);
      for (const [type, slot] of REGIONS) if (w.regions?.has(type)) { try { handle.remove(refs.region(type, windowId, slot)); } catch { /* gone */ } }
      try { handle.emit(w.ref, 'closed', null); handle.remove(w.ref); } catch { /* gone */ }
    },
    /** framework-main: the window entered or left full screen (before its page reports, too). */
    fullScreen(windowId, value) {
      fullScreens.set(windowId, value === true);
      const w = windows.get(windowId);
      if (!w || w.fullScreen === (value === true)) return;
      w.fullScreen = value === true;
      putWindow(w);
    },
    /**
     * framework-main: what it says of a window itself (G5.5): the user is in it (`hasFocus`), its title, its bounds on the screen
     * ({x, y, width, height} in points). Kept before its page reports, put with the Window once it has.
     */
    windowOwn(windowId, change) {
      const next = { ...(owns.get(windowId) ?? {}) };
      if (typeof change?.hasFocus === 'boolean') next.hasFocus = change.hasFocus;
      if (typeof change?.title === 'string') next.title = change.title.slice(0, 500);
      const b = change?.bounds;
      if (isObject(b) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))) next.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
      owns.set(windowId, next);
      // the user is in one window at a time: another that had it no longer does
      if (change?.hasFocus === true) {
        for (const [id, x] of owns) {
          if (id === windowId || x.hasFocus !== true) continue;
          x.hasFocus = false;
          const other = windows.get(id);
          if (other) { other.hasFocus = false; putWindow(other); }
        }
      }
      const w = windows.get(windowId);
      if (!w) return;
      const said = JSON.stringify([w.hasFocus, w.title, w.bounds]);
      Object.assign(w, next);
      if (JSON.stringify([w.hasFocus, w.title, w.bounds]) !== said) putWindow(w);
    },
    /** The registry's size and traffic (the cost S10 asks to measure). */
    stats: () => ({
      windows: windows.size, presentations: items.size - desktopCount(), desktop: desktopCount(), orphans: [...orphans.values()].reduce((n, set) => n + set.size, 0), ...stats,
      pages: [...windows.values()].filter((w) => w.page).map((w) => ({ window: w.windowId, ...w.page })),
    }),
    dispose() {
      disposed = true;
      for (const a of [...acts.values()]) a.settle(gone('the windows provider stopped'));
      for (const a of [...asks.values()]) a.settle(cancelled('framework', 'the windows provider stopped'), false);
      for (const n of [...notes.values()]) closeNote(n, true);
      noteListeners.clear();
      graphEvents?.dispose();
      menuReports?.dispose?.();
      for (const sub of subs) sub.dispose?.();
      handle.dispose();
    },
  };
  // framework-main's window lifecycle (the bus topics the Host publishes from it).
  const subs = o.bus ? [
    o.bus.subscribe('window/closed', (d) => { if (Number.isSafeInteger(d?.windowId)) api.windowClosed(d.windowId); }),
    o.bus.subscribe('window/fullScreen', (d) => { if (Number.isSafeInteger(d?.windowId)) api.fullScreen(d.windowId, d.value === true); }),
    o.bus.subscribe('window/focused', (d) => { if (Number.isSafeInteger(d?.windowId)) api.windowOwn(d.windowId, { hasFocus: true }); }),
    o.bus.subscribe('window/blurred', (d) => { if (Number.isSafeInteger(d?.windowId)) api.windowOwn(d.windowId, { hasFocus: false }); }),
    o.bus.subscribe('window/bounds', (d) => { if (Number.isSafeInteger(d?.windowId)) api.windowOwn(d.windowId, { bounds: d.bounds }); }),
    o.bus.subscribe('window/title', (d) => { if (Number.isSafeInteger(d?.windowId)) api.windowOwn(d.windowId, { title: d.title }); }),
  ] : [];
  return api;
}
