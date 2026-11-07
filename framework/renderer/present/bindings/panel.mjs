// The side panel's presentations and slots (docs/graph/03 SidePanel, PanelTab, FilesView, FilePreview; systems.md E7.4, from a scout of 21477). On 21477 the panel's tabs are created by the panel host outside the JSX seam, so the
// bindings sit on the host, its strip, each tab's label, the file tree's search pane and the file header. Operations that act on the
// panel's own state go through its controller with the route's scope (the kernel keeps the scope's node on the mount record). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeRegion, nodeList, actionNode, appendNodes } from './slots.mjs';
import { declaredFilters, filterNotice } from './list-filter.mjs';
import { layoutWorkspace } from './workspace-layout.mjs';
import { bottomPlacement, setBottomPlacement, frameDrawn, spaceHeld, claimBeside, releaseBeside, besideOwner, columnsChanged, BESIDE } from './frame-regions.mjs';

const localThread = (route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' && route.conversationId ? route.conversationId : null);
/** The route's thread, as its presentations' parent (the concept is enough to find it). */
const threadOf = (route) => { const id = localThread(route); return id ? { type: 'Thread', provider: 'codex', id } : null; };
const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);

// The right panel (presents the route's Thread): its tabs' host, the right one of the app's two panels (the bottom panel is not on 03).
export const sidePanel = defineBinding({
  id: 'side.panel', presentation: 'SidePanel',
  place: { in: 'Window', slot: 'panel' },
  presents: ['Thread'],
  subject: (props, ctx, route) => (props.controller && props.controller.panelId === 'right' && localThread(route) ? ctx.thread(localThread(route)) : null),
  // the right panel's host only: the same component hosts the bottom panel's tabs (its BottomPanel twin)
  subjectOnly: true,
  // `tabs`: the mods' panel views (ui.panel, mod-surfaces.md §3.1) are tabs of the framework's own kind (present/mod-panels.mjs), opened
  // in the panel by its controller; nothing of them passes through this host's props. `stripBefore` and `empty` (layouts.md §4.1, WL2):
  // the mods' regions before the tab strip and in the panel while it has no tab, the host's own `beforeList` and `emptyState`.
  slots: { tabs: { kind: 'external' }, stripBefore: nodeRegion('beforeList'), empty: nodeRegion('emptyState') },
  // the bottom panel (the same host, its controller's panelId `bottom`): the BottomPanel's strip after its tabs, before them, and empty
  twins: [{ presentation: 'BottomPanel', subject: (props, ctx, route) => (props.controller && props.controller.panelId === 'bottom' && localThread(route) ? ctx.thread(localThread(route)) : null),
    slots: { toolbar: nodeRegion('afterList'), stripBefore: nodeRegion('beforeList'), empty: nodeRegion('emptyState') } }],
  // on a page the app keeps no tabs for (the new chat's, a remote task's), the mods' tabs the user had open reopen (the presence record)
  render(Original, props, factory, ctx, route, near, rec) {
    if (props.controller && typeof ctx.restorePanels === 'function') ctx.restorePanels(route, props.controller.panelId, rec);
    return undefined;
  },
});
// The right panel's frame (its width's motion values and mode; E8.9, scout E8-frame-slots §5.3): a part of the SidePanel, whose `resize`
// sets the width as the panel's ratio of the window's content (the panel's motion value, animated by the shell; exposure `panelWidth`,
// through the route's scope): this window's only, never the width the app keeps (layouts.md D4: that is the layout.panelShare Setting's,
// written only as Settings are), until the panel shows a tab kind of another width or another chat. Window.setRegion's side size. The
// app's own bounds hold (at least 320 px; at most the content less the main view's minimum).
const MIN_WIDTH = 320;
function paneWidth(props, width, ctx, rec) {
  const ex = ctx.exports?.()?.panelWidth;
  const node = rec?.scopeNode;
  const ratio = props.contentPaneWidthRatio, total = props.workspaceWidth;
  if (!ex || !node || typeof ratio?.set !== 'function' || typeof total?.get !== 'function') return { unavailable: 'this panel cannot be resized from here' };
  if (props.isContentPaneOpen !== true) return { unavailable: 'the panel is closed' };
  if (!Number.isFinite(width) || width < MIN_WIDTH) return { unavailable: `a width of at least ${MIN_WIDTH} px` };
  const mode = node.get(ex.unified) == null ? 'regular' : 'unified';
  const main = total.get();
  ratio.set(ex.toRatio(width, main, mode));
  return true;
}
export const sidePanelFrame = defineBinding({
  id: 'side.panel.frame', presentation: 'SidePanel', part: true,
  place: { in: 'Window', slot: 'panel' },
  presents: ['Thread'],
  subject: (props, ctx, route) => (localThread(route) ? ctx.thread(localThread(route)) : null),
  operations: {
    resize: (props, [width], ctx, rec) => paneWidth(props, width, ctx, rec),
    // the panel's share as it is now, and put back as it was (a layout's give-back, layouts.md D11): this window's, as above
    shareNow: (props) => { const v = props.contentPaneWidthRatio?.get?.(); return Number.isFinite(v) ? v : { unavailable: 'the panel is not drawn here' }; },
    putShare(props, [ratio]) {
      if (typeof props.contentPaneWidthRatio?.set !== 'function' || !Number.isFinite(ratio)) return { unavailable: 'this panel cannot be resized from here' };
      props.contentPaneWidthRatio.set(ratio);
      return true;
    },
    // The chat's bottom panel open or closed (Window.setRegion; layouts.md D4): the app's own setter, over the chat's scope (exposure
    // `windowRegions`); where the app has no bottom panel it stays closed (the Window says so).
    bottom(props, [open], ctx, rec) {
      const ex = ctx.exports?.()?.windowRegions;
      const node = rec?.scopeNode;
      if (typeof open !== 'boolean') return { unavailable: 'the bottom panel is open (true) or closed (false)' };
      if (!ex || typeof ex.setBottom !== 'function' || !node) return { unavailable: 'this window\'s bottom panel cannot be set from here' };
      ex.setBottom(node, open);
      return true;
    },
    // The workspace's layout (Window.setLayout; layouts.md D6, WL3): the chat alone (its panel closed), beside its tabs, or its tab filling
    // the workspace, through the app's own guarded setters (exposure `workspaceLayout`): a tab whose kind does not fill the workspace
    // (`allowFullWidth: false`) is refused before anything moves.
    layout: (props, [mode], ctx, rec) => layoutWorkspace(ctx, rec?.scopeNode, mode),
  },
});
// The bottom panel's frame (layouts.md WL4b; scout wl4-workspace.md §2.4): its height's motion value, which the workspace column hands it,
// a part of the chat's SidePanel (as the bottom panel's open and close are: the graph's BottomPanel is the window's region, which the page
// does not report) whose `bottomHeight` sets it within the app's own bounds (exposure `bottomHeight`: 160 px to half the main
// view's height): this window's only, never the height the app keeps (that is the layout.bottomHeight Setting's, which the app writes
// when the user's drag ends), for as long as the app's workspace column lives (a page of another kind starts from the kept height).
// Window.setRegion's bottom size.
function panelHeight(props, px, ctx, rec) {
  const clamp = ctx.exports?.()?.bottomHeight?.clamp;
  const height = props.bottomPanelHeight, main = props.mainContentHeight;
  if (typeof clamp !== 'function' || typeof height?.set !== 'function' || typeof main?.get !== 'function') return { unavailable: 'this window\'s bottom panel cannot be sized from here' };
  if (!Number.isFinite(px)) return { unavailable: 'a height in px' };
  const m = main.get();
  const lo = clamp(0, m), hi = clamp(Number.MAX_SAFE_INTEGER, m);
  if (px < lo - 2 || px > hi + 2) return { unavailable: `the bottom panel takes ${Math.round(lo)} to ${Math.round(hi)} px here` };
  // every mount of this chat's bottom panel (a page the app keeps for later holds its own): each set, the one shown shows it
  const chat = rec?.scopeNode?.value?.conversationId ?? null;
  const mounts = (typeof ctx.mountsOf === 'function' ? ctx.mountsOf('bottom.panel.frame') : [])
    .filter((x) => typeof x?.props?.bottomPanelHeight?.set === 'function' && typeof x.props.mainContentHeight?.get === 'function' && (x.scopeNode?.value?.conversationId ?? null) === chat);
  for (const x of mounts.length ? mounts : [{ props }]) x.props.bottomPanelHeight.set(clamp(px, x.props.mainContentHeight.get()));
  return true;
}
// Beside the chat (layouts.md WL4b; scout wl4-workspace.md §2.5): the app's own content of the panel (its tab host, `children`) is drawn in
// the column the frame's host keeps for it (frame-regions.mjs), left or right of the app's column, while the app has the panel open (its
// open flag stays the app's: its toggles and "open a terminal" keep working). The panel's frame keeps that content in one mount of its own
// from its first render (a container portalled into once and moved between the app's slot below and the column beside), so no move, the
// first and the allocator's included, remounts it (a terminal keeps its renderer); it stays in the slot below until the column is there.
// The content is kept a moment after the app closes the panel, while its close animates. Only the shown column's frame owns the column
// beside (the app keeps other pages mounted out of sight, their frames live: each registers its column, whose marker's parent says whether
// it is shown). Without the frame's host or ReactDOM's portal it stays below and the placement is refused.
const canBeside = (ctx) => frameDrawn(ctx) && typeof ctx.exports?.()?.reactDom?.createPortal === 'function';
/** The panel's frame once it has been beside: the app's frame below (its content a slot) or nothing (beside), and its content's one mount. */
export function BottomHost({ R, D, ctx, Original, props, factory, scope }) {
  const content = R.useRef(null);
  if (!content.current && globalThis.document?.createElement) {
    const el = globalThis.document.createElement('div');
    el.style.display = 'contents';
    el.setAttribute('data-codexmods-bottom-content', '');
    content.current = el;
  }
  const anchor = R.useRef(null);
  const token = R.useRef(null);
  if (!token.current) token.current = {};
  const place = bottomPlacement(ctx);
  const owner = besideOwner(ctx) === token.current;
  // beside only once the column is there (connected): until then the content stays in the app's slot below
  const beside = owner && place.at !== 'below' && !spaceHeld(ctx).beside && !!place.node && place.node.isConnected !== false;
  const open = props.isVisible === true;
  // the content kept while the app animates the panel closed (its frame draws it a moment longer)
  const [kept, setKept] = R.useState(open);
  R.useEffect(() => {
    if (open) { setKept(true); return undefined; }
    const t = setTimeout(() => setKept(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  // this column: its chat, its scope, whether it is shown (the marker's parent, the column's main area); the shown one owns what is beside
  const marker = R.useRef(null);
  const key = (typeof scope?.value?.conversationId === 'string' && scope.value.conversationId) || scope?.value?.pathname || null;
  R.useLayoutEffect(() => {
    const t = token.current;
    claimBeside(ctx, t, { key, scope, shown: () => { const el = marker.current?.parentElement; return !el || typeof el.checkVisibility !== 'function' || el.checkVisibility(); } });
    // a chat shown for the first time: its column can come after the one before it went out of sight, and what follows the arrangement (a layout held, the allocator) is told now
    let told = false;
    queueMicrotask(() => { if (!told) columnsChanged(ctx); });
    return () => { told = true; releaseBeside(ctx, t); };
  }, [ctx, key, scope]);
  // coming into sight or going out of it (a page the app keeps): its size goes from nothing or to nothing
  R.useEffect(() => {
    const el = marker.current?.parentElement, RO = globalThis.ResizeObserver;
    if (!el || typeof RO !== 'function') return undefined;
    let was = el.getClientRects?.().length > 0;
    const o = new RO(() => { const now = el.getClientRects?.().length > 0; if (now !== was) { was = now; columnsChanged(ctx); } });
    o.observe(el);
    return () => o.disconnect();
  }, [ctx]);
  R.useLayoutEffect(() => { if (owner && place.open !== open) setBottomPlacement(ctx, { open }); }, [owner, open, place.open, ctx]);
  // the content where it is drawn now: the column beside, else the app's slot below
  R.useLayoutEffect(() => {
    const el = content.current, target = beside ? place.node : anchor.current;
    if (el && target && el.parentNode !== target) target.appendChild(el);
  });
  const slot = beside ? null : factory(Original, { ...props, children: R.createElement('div', { ref: anchor, style: { display: 'contents' } }) });
  return R.createElement(R.Fragment, null, slot, (open || kept) && content.current ? D.createPortal(props.children, content.current) : null,
    R.createElement('span', { key: 'marker', ref: marker, hidden: true, 'data-codexmods-bottom-column': '' }));
}
const CLOSE_MS = 400;   // the app's close animation, with room
export const bottomPanelFrame = defineBinding({
  id: 'bottom.panel.frame', presentation: 'SidePanel', part: true,
  place: { in: 'Window', slot: 'panel' },
  presents: ['Thread'],
  subject: (props, ctx, route) => (localThread(route) ? ctx.thread(localThread(route)) : null),
  operations: {
    bottomHeight: (props, [px], ctx, rec) => panelHeight(props, px, ctx, rec),
    heightNow: (props) => { const v = props.bottomPanelHeight?.get?.(); return Number.isFinite(v) ? v : { unavailable: 'the bottom panel is not drawn here' }; },
    // where the panel is (Window.setRegion's bottom `at`): below (the app's own), left or right of the chat
    bottomAt(props, [at], ctx) {
      if (!['below', 'left', 'right'].includes(at)) return { unavailable: 'the bottom panel is below, left or right' };
      if (at !== 'below' && !canBeside(ctx)) return { unavailable: 'this window\'s frame cannot hold the bottom panel beside the chat' };
      setBottomPlacement(ctx, { at });
      return true;
    },
    // its width beside the chat (Window.setRegion's bottom size while it is beside)
    bottomWidth(props, [px], ctx) {
      if (bottomPlacement(ctx).at === 'below') return { unavailable: 'the bottom panel is below the chat: its size is its height' };
      if (!Number.isFinite(px) || px < BESIDE.min || px > BESIDE.max) return { unavailable: `the bottom panel beside the chat takes ${BESIDE.min} to ${BESIDE.max} px` };
      setBottomPlacement(ctx, { size: px });
      return true;
    },
  },
  render(Original, props, factory, ctx, route, near, rec) {
    // from its first render (no remount when it first goes beside); without ReactDOM's portal, the app's own panel
    bottomPlacement(ctx);
    const R = ctx.react(), D = ctx.exports?.()?.reactDom;
    return R && typeof D?.createPortal === 'function' ? R.createElement(BottomHost, { R, D, ctx, Original, props, factory, scope: rec?.scopeNode ?? null }) : undefined;
  },
});

// Its tab strip (in the panel, or in the title bar in the app's unified layout): mods' controls after the strip's own.
export const sidePanelStrip = defineBinding({
  id: 'side.panel.strip', presents: ['Thread'],
  twins: [{ presentation: 'SidePanel', subject: (props, ctx, route) => (props.focusArea === 'right-panel' && localThread(route) ? ctx.thread(localThread(route)) : null), slots: { toolbar: nodeRegion('after') } }],
});

const PLAN_FILE = /\/plans\/([^/]+)\/([^/]+)\/PLAN\.md$/;
/**
 * A plan's tab, in the route's chat (21477): the read-only one (kind `plan`, its turn's id as `planKey`), or, where plans are editable (the
 * desktop's way), the `plan` tab of its file `<codex home>/plans/<chat>/<turn>/PLAN.md`: `{turn, on}`, the Turn whose plan it shows and the
 * subject of the tab it is in (its File for the editable one).
 */
function planOf(tab, route) {
  const kind = tab && typeof tab === 'object' ? tab.kind ?? tab.tabType?.kind : null;
  const chat = localThread(route);
  if (!chat) return null;
  const key = kind === 'plan' ? tab.props?.planKey : null;
  if (typeof key === 'string' && key) { const turn = { type: 'Turn', provider: 'codex', id: key }; return { turn, on: turn }; }
  const path = kind === 'text-file-editor' && tab.tabId === 'plan' ? tab.props?.path : null;
  const m = typeof path === 'string' && path.startsWith('/') ? PLAN_FILE.exec(path) : null;
  return m && m[1] === chat ? { turn: { type: 'Turn', provider: 'codex', id: m[2] }, on: { type: 'File', provider: 'codex', id: path } } : null;
}
const planTurn = (tab, route) => planOf(tab, route)?.turn ?? null;
/** A terminal's tab on this Mac: its Terminal (the tab's id `terminal:<sessionId>`). */
function terminalOf(tab) {
  const id = tab && typeof tab === 'object' ? String(tab.tabId ?? '') : '';
  const host = tab?.props?.hostId;
  return id.startsWith('terminal:') && id.length > 9 && (host == null || host === 'local') ? { type: 'Terminal', provider: 'codex', id: id.slice('terminal:'.length) } : null;
}
/** An agent's command kept as a background terminal tab, on this Mac: the graph's Terminal of that command (`agent:<chat>:<item>`). */
function backgroundTerminal(p, route) {
  const chat = typeof p.conversationId === 'string' && p.conversationId ? p.conversationId : localThread(route);
  return chat && typeof p.terminalId === 'string' && p.terminalId && (p.hostId == null || p.hostId === 'local')
    ? { type: 'Terminal', provider: 'codex', id: `agent:${chat}:${p.terminalId}` } : null;
}
/** A panel tab's subject, from its kind and props: a terminal (the user's or an agent's), the browser's tab, a file or folder, a plan's turn. */
function tabSubject(tab, route) {
  if (!tab || typeof tab !== 'object') return null;
  const kind = tab.kind ?? tab.tabType?.kind;
  const id = String(tab.tabId ?? '');
  if (id.startsWith('terminal:')) return { type: 'Terminal', provider: 'codex', id: id.slice('terminal:'.length) };
  if (kind === 'plan' && planTurn(tab, route)) return planTurn(tab, route);
  if (kind === 'background-terminal') return backgroundTerminal(tab.props ?? {}, route);
  // the Changes tab (E7.5b): the chat's ChangeSet, which its ChangesView presents
  if (kind === 'review' && localThread(route)) return { type: 'ChangeSet', provider: 'codex', id: `thread:${localThread(route)}` };
  const p = tab.props ?? {};
  if (kind === 'browser' && typeof p.browserTabId === 'string') {
    const thread = typeof p.browserConversationId === 'string' ? p.browserConversationId : localThread(route);
    return thread ? { type: 'BrowserTab', provider: 'codex', id: `${thread}:${p.browserTabId}` } : null;
  }
  if ((kind === 'workspace-file' || kind === 'text-file-editor') && typeof p.path === 'string' && p.path.startsWith('/') && (p.hostId == null || p.hostId === 'local')) {
    return { type: 'File', provider: 'codex', id: p.path };
  }
  // a mod's view (E8 third review): its tab presents the Mod whose view it is
  if (kind === 'codexmods' && typeof p.mod === 'string' && p.mod) return { type: 'Mod', provider: 'codexmods.framework', id: p.mod };
  return null;
}
// One of the panel's tabs (its label: the component whose props carry the tab, its controller and its drag handle). Selecting and
// moving it are the controller's (what the panel shows); a terminal's or the browser's tab closes with its subject (their own close),
// another tab by the controller.
export const panelTab = defineBinding({
  id: 'panel.tab', presentation: 'PanelTab',
  place: (props, route) => { const t = threadOf(route); return t ? { in: 'SidePanel', on: t, slot: 'tabs' } : { in: null, slot: 'tabs' }; },
  presents: ['Terminal', 'BrowserTab', 'File', 'ChangeSet', 'Turn'],   // a terminal's tab, the user's or an agent's
  subject: (props, ctx, route) => tabSubject(props.tab, route),
  operations: {
    layout: (props, [mode], ctx, rec) => layoutWorkspace(ctx, rec?.scopeNode, mode),
    select(props, args, ctx, rec) {
      const c = props.controller, node = rec?.scopeNode;
      if (!c || typeof c.activateTab !== 'function' || !node) return { unavailable: 'this tab cannot be selected from here' };
      c.activateTab(node, props.tab.tabId);
      return true;
    },
    close(props, args, ctx, rec) {
      const c = props.controller, node = rec?.scopeNode, s = tabSubject(props.tab, rec?.scope);
      if (s && (s.type === 'Terminal' || s.type === 'BrowserTab')) return { unavailable: `a ${s.type}'s tab closes with it: close the ${s.type}` };
      if (props.tab?.isClosable === false) return { unavailable: 'this tab cannot be closed' };
      if (!c || typeof c.closeTab !== 'function' || !node) return { unavailable: 'this tab cannot be closed from here' };
      c.closeTab(node, props.tab.tabId);
      return true;
    },
    move(props, [position], ctx, rec) {
      const c = props.controller, node = rec?.scopeNode;
      if (!c || typeof c.reorderTab !== 'function' || !c.tabIds$ || !node) return { unavailable: 'this tab cannot be moved from here' };
      const ids = node.get(c.tabIds$);
      if (!Array.isArray(ids) || !Number.isInteger(position) || position < 0 || position >= ids.length) return { unavailable: 'no such position in the panel' };
      c.reorderTab(node, props.tab.tabId, ids[position]);
      return true;
    },
  },
});

/** Header rows of a tab's pane: the entries' actions in one row after the app's own rows (the tab's pane layout function, wrapped). */
const headerActions = {
  kind: 'list', field: 'actions',
  apply: (props, entries, env) => {
    // the pane's layout function: the body's own prop (21477, and a background terminal's body), or, where the body takes none (22943),
    // the third argument the body hands its tab's renderPanel (the same function every tab's content is given)
    const tab = props.tab;
    if ((typeof props.renderSlots !== 'function' && typeof tab?.renderPanel !== 'function') || !entries.length || !env.R) return props;
    const nodes = entries.map((e, i) => actionNode(env.R, env.ctx, e.item, `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`));
    const row = env.R.createElement('div', { className: 'flex items-center justify-end gap-1 px-2 py-1', 'data-codexmods-header': 'actions' }, ...nodes);
    const withRow = (renderSlots) => (arg) => renderSlots({ ...arg,
      headerRows: [...(Array.isArray(arg?.headerRows) ? arg.headerRows : []), { id: 'codexmods:actions', height: 'content', content: row }] });
    if (typeof props.renderSlots === 'function') return { ...props, renderSlots: withRow(props.renderSlots) };
    return { ...props, tab: { ...tab, renderPanel: (scope, onClose, renderSlots, ...rest) => tab.renderPanel(scope, onClose, typeof renderSlots === 'function' ? withRow(renderSlots) : renderSlots, ...rest) } };
  },
};
// A panel tab's body as the panel's host mounts it (21477: `{controller, tab, renderSlots, isVisible, isActive}`, every tab's; 22943
// drops `renderSlots` and passes the layout function to `tab.renderPanel` itself; each body lays its pane out with it, so its header
// rows go in here): a plan's tab (read-only, or its editable PLAN.md) is the
// PlanView of its turn, with the mods' actions as a header row; a terminal's takes its TerminalView's actions the same way
// (public-hooks.md §3.13, H7x).
export const panelTabBody = defineBinding({
  id: 'panel.tab.body', presentation: 'PlanView', presents: ['Turn'], subjectOnly: true,
  place: (props, route) => { const p = planOf(props.tab, route); return p ? { in: 'PanelTab', on: p.on, slot: 'view' } : { in: null, slot: 'view' }; },
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own plan panel
  subject: (props, ctx, route) => (planTurn(props.tab, route) && ctx.thread(localThread(route))?.provider === 'codex' ? planTurn(props.tab, route) : null),
  slots: { actions: headerActions },
  twins: [{ presentation: 'TerminalView', subject: (props) => terminalOf(props.tab), slots: { actions: headerActions } }],
});

// An agent's command's output kept as a background terminal tab (21477: its body, `{itemKey, hostId, renderSlots, setTabState,
// terminalId}`, lays its pane out with `renderSlots` itself): the TerminalView of that command's Terminal, the mods' actions as a header
// row (H7x review 1).
export const terminalBackground = defineBinding({
  id: 'terminal.background', presentation: 'TerminalView', presents: ['Terminal'], subjectOnly: true,
  place: (props, route) => { const t = backgroundTerminal(props, route); return t ? { in: 'PanelTab', on: t, slot: 'view' } : { in: null, slot: 'view' }; },
  subject: (props, ctx, route) => backgroundTerminal(props, route),
  slots: { actions: headerActions },
});

/** The folder a file tree's pane shows (its tree's root while searching, its git folder otherwise). */
const paneFolder = (props) => {
  const p = props.children && props.children.props;
  const root = p && (p.root ?? p.gitCwd);
  return typeof root === 'string' && root.startsWith('/') && (p.hostId == null || p.hostId === 'local') ? { type: 'Folder', provider: 'codex', id: root } : null;
};
// The file tree's pane (its search box and the tree: the all-files pane passes only these two): the FilesView's toolbar beside the
// search box, and its filter, the search the user types (the pane's own onQueryChange). A twin of the tree's FilesView. While the mods'
// filters of the list are on (`ui.filter('files', ...)`, files-view.mjs), their notice goes beside the search box, after the toolbar, in
// the Files tab's pane only: the Changes tab's list is this pane too (its tree the changed files' list, with their entries: the Changes
// list's filters, changes.mjs).
/** Is a pane's tree the Files tab's (not the Changes tab's list of changed files)? */
export const filesTabPane = (props) => !!props && typeof props === 'object' && !Array.isArray(props.children?.props?.entries);
export const filesPane = defineBinding({
  id: 'files.pane', presentation: 'FilesView',   // a site (addresses.json): the Files tab's tree is the one under it (files-view.mjs)
  place: { in: null, slot: 'panel' },
  presents: ['Folder'],
  subject: (props) => paneFolder(props),
  render(Original, props, factory, ctx) {
    const filters = declaredFilters(ctx, 'FilesView');
    const R = ctx.react();
    if (!filters.length || !R || !props.search || !filesTabPane(props)) return undefined;
    return factory(Original, { ...props, filterActions: appendNodes(R, props.filterActions, [filterNotice(R, ctx, 'FilesView', filters, { compact: true })]) });
  },
  // `rowActions`: entries of a file or folder row's own menu (the file-menu seam, mod-surfaces.md §3.5), not through these props
  slots: { toolbar: nodeRegion('filterActions'), rowActions: { kind: 'external' } },
  operations: {
    filter(props, [text]) {
      if (!props.search || typeof props.search.onQueryChange !== 'function') return { unavailable: 'this tree has no search here' };
      props.search.onQueryChange(typeof text === 'string' ? text : '');
      return true;
    },
  },
});

// A file's header (presents the File: its path, on this Mac): mods' controls in its trailing content, after the app's own.
export const filePreview = defineBinding({
  id: 'file.preview', presentation: 'FilePreview',
  place: { in: null, slot: 'preview' },
  presents: ['File'],
  subject: (props) => (typeof props.path === 'string' && props.path.startsWith('/') && (props.hostId == null || props.hostId === 'local') ? { type: 'File', provider: 'codex', id: props.path } : null),
  slots: { toolbar: nodeList('trailingContent', action, { field: 'actions' }) },
});
