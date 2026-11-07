// The frame's presentations and slots (docs/graph/03 Sidebar, SidebarSection, SidebarItem, ThreadHeader, Palette; systems.md E7.3, from a
// scout of 21477). Each binding's regions sit beside its component, as the app lays them out; the
// bindings that only realize another presentation's slots (twins) present nothing themselves. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { applyParts } from '../rules.mjs';
import { PARTS } from '../../../shared/parts.mjs';
import { actionNode, siblingList, siblingRegion, arrayRegion, renderedList, withoutSiblings, statusList, SIBLINGS, summarySlot, badgeNode } from './slots.mjs';
import { sidebarFilter, setSidebarFilter, clearSidebarFilter, describe } from './sidebar-filter.mjs';
import { hiddenCounts, showHidden } from './sidebar-hides.mjs';
import { orderedGroup } from './sidebar-section.mjs';
import { declaredRegions, regionState, regionFacts, drawnBottomAt, drawnSidebarEdge, sidebarEdge, suspendedFacts, followArrangement, FrameHost } from './frame-regions.mjs';
import { hideGroups } from './sidebar-groups.mjs';
import { createSidebarSections, declaredSections, sharedOf } from './sidebar-sections.mjs';

const APP = Object.freeze({ type: 'App', provider: 'codex', id: 'codex' });
const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);
/** A project group's local project (its props' group), or null for a remote one. */
const localProjectOf = (props) => { const g = props.group; return g && g.projectKind === 'local' && typeof g.projectId === 'string' && g.projectId ? { type: 'LocalProject', provider: 'codex', id: g.projectId } : null; };
/** The app's element first and unkeyed, then the regions beside it (React keeps the element's state when regions come and go). */
const beside = (Original, props, factory, ctx) => {
  const [own, after] = withoutSiblings(props);
  const R = ctx.react();
  if (!after.length || !R) return after.length ? factory(Original, own) : undefined;
  return R.createElement(R.Fragment, null, factory(Original, own), ...after);
};

// The sidebar (presents App): on 21477 its sections' list (the component whose props carry sidebarSectionNodes, the one part of the
// sidebar created as an element: its outer content component is called as a function); mods' sections after the app's.
// Its `filter` (E8.9j) is the window's sidebar filter: while one is set, a notice at the top of the list says which chats show and who
// filtered them, with the user's own way to show all again. Its `hidden` (public-hooks.md §3.12) are the chats and projects the mods hide
// (sidebar-hides.mjs): a notice for each mod that hides any now ("2 hidden by <mod>") with "Show".
export const sidebar = defineBinding({
  id: 'sidebar', presentation: 'Sidebar',
  place: { in: 'Window', slot: 'sidebar' },
  presents: ['App'],
  subject: () => APP,
  // `filter`: the mods' declared filters (ui.filter('sidebar')), applied by the lists' bindings when on in this window (sidebar-filter.mjs)
  // `hidden`: the chats and projects the mods hide (ui.hide('Thread' | 'Project')), left out by the lists' bindings (sidebar-hides.mjs)
  // `order`: the mods' declared orders (ui.sidebar.order), applied by the lists' bindings (sidebar-order.mjs)
  // `section`: the mods' declared sections (ui.sidebar.section), drawn by its render
  slots: { sections: arrayRegion('sidebarSectionNodes'), filter: { kind: 'list', field: 'filter', apply: (props) => props }, order: { kind: 'list', field: 'sort', apply: (props) => props },
    section: { kind: 'list', field: 'section', apply: (props) => props }, hidden: { kind: 'list', field: 'hide', apply: (props) => props } },
  operations: {
    filter(props, [query, by], ctx) { setSidebarFilter(ctx, query ?? null, by); return true; },
    // its width in this window (Window.setRegion; layouts.md D4): the app's live width (exposure `windowRegions`), never the stored key;
    // within the app's own bounds (the frame clamps to the window at use). The width asked is the sidebar's own, as the Window says it;
    // the app's holds the rail beside it too where the rail shows (`kept`: a width as the app keeps it, the layout.sidebarWidth Setting's)
    width(props, [width, kept], ctx) {
      const ex = ctx.exports?.()?.windowRegions;
      const node = ctx.anyScopeNode?.();
      if (!ex || typeof ex.clampSidebar !== 'function' || !ex.sidebarWidth || !node) return { unavailable: 'this window\'s sidebar cannot be sized from here' };
      const rail = kept === true ? 0 : railWidth();
      const whole = width + rail;
      if (!Number.isFinite(width) || ex.clampSidebar(whole) !== whole) return { unavailable: `a width from ${ex.clampSidebar(0) - rail} to ${ex.clampSidebar(1e6) - rail} px` };
      node.set(ex.sidebarWidth, whole);
      return true;
    },
  },
  // Its `section` (ui.sidebar.section): the mods' sections, drawn with the app's own group and list (sidebar-sections.mjs), before the app's
  // groups (`position: 'top'`) or after them, once one of the app's lists has shown what its rows are given.
  render(Original, props, factory, ctx) {
    const f = sidebarFilter(ctx);
    const counts = hiddenCounts(ctx);
    const R = ctx.react();
    if (!R || !Array.isArray(props.sidebarSectionNodes)) return undefined;
    // a mod's page with a sidebar view, where the rail does not show: the view in the conversations' place (layouts.md D7; below: where it shows)
    const view = ctx.mountsOf?.('sidebar.area')?.length ? null : ctx.pageSidebar?.();
    if (view) return factory(Original, { ...props, sidebarSectionNodes: [R.createElement(R.Fragment, { key: 'codexmods:view' }, view)] });
    const top = declaredSections(ctx, 'top'), end = declaredSections(ctx, 'end');
    // the groups of the agents the app does not hold (graph-integrity G2.1): their chats have no other place in the sidebar
    let s = modSections.get(ctx);
    if (!s) { s = createSidebarSections({ R, ctx }); modSections.set(ctx, s); }
    const agents = s.hasAgents();
    if (!f && !counts.length && !top.length && !end.length && !agents) return undefined;
    const shared = top.length || end.length ? sharedOf(ctx) : null;
    const notice = [...(f ? [R.createElement(FilterNotice, { key: 'codexmods:filter', text: describe(f, (id) => ctx.modName?.(id) ?? id), ctx, R })] : []),
      ...counts.map(([mod, n]) => R.createElement(HiddenNotice, { key: `codexmods:hidden:${mod}`, mod, n, ctx, R }))];
    return factory(Original, { ...props, sidebarSectionNodes: [...notice, ...s.nodesFor(top, shared), ...props.sidebarSectionNodes, ...(agents ? [s.agentsNode()] : []), ...s.nodesFor(end, shared)] });
  },
});
/** The rail's width where the app shows it beside the sidebar (the left panel holds both), else 0. */
function railWidth() {
  const d = globalThis.document;
  const left = d?.querySelector?.('aside.app-shell-left-panel'), nav = d?.querySelector?.('[data-sidebar-navigation-root]');
  const r = left && nav ? left.getBoundingClientRect().width - nav.getBoundingClientRect().width : 0;
  return r > 1 ? Math.round(r) : 0;
}
const modSections = new WeakMap();   // the runtime's ctx -> its mods' sidebar sections (one per window)
/** One mod's hides' notice: how many it hides now, and the user's "Show" (in this window). */
function HiddenNotice({ mod, n, ctx, R }) {
  const text = `${n} hidden by ${ctx.modName?.(mod) ?? mod}`;
  return R.createElement('div', { 'data-codexmods': 'sidebar-hidden', 'data-codexmods-mod': mod, className: 'flex items-center gap-2 px-3 py-1 text-sm text-token-text-secondary' },
    R.createElement('span', { className: 'min-w-0 flex-1 truncate', title: text }, text),
    actionNode(R, ctx, { title: 'Show', run: () => showHidden(ctx, mod) }, `codexmods:hidden-show:${mod}`));
}
/** The filter's notice: what shows, and the user's "Show all" (the app's own button). */
function FilterNotice({ text, ctx, R }) {
  return R.createElement('div', { 'data-codexmods': 'sidebar-filter', className: 'flex items-center gap-2 px-3 py-1 text-sm text-token-text-secondary' },
    R.createElement('span', { className: 'min-w-0 flex-1 truncate', title: text }, text),
    actionNode(R, ctx, { title: 'Show all', run: () => clearSidebarFilter(ctx) }, 'codexmods:filter-clear'));
}
// Its footer (the profile footer, whose one prop is showProfileDivider): regions beside it.
// Its `status` (ui.status, public-hooks.md §3.14): the mods' statuses in one row after the footer, in the footer's own metrics (its container
// is measured, so the list above pads itself).
const footerStatus = statusList((props, nodes, env) => ({ ...props, [SIBLINGS]: [...(props[SIBLINGS] ?? []), env.R.createElement('div', {
  key: 'codexmods:status', 'data-codexmods': 'sidebar-status', className: 'flex h-toolbar min-w-0 items-center gap-2 px-row-x text-sm' }, ...nodes)] }));
// Its `items` (layouts.md §4.1): the mods' entries as rows of the app's footer, after its account row and invite (at most four, so the
// account control stays in view).
const footerRow = ({ R, ctx }, item, key) => R.createElement('div', { key, 'data-codexmods': 'sidebar-footer-item', className: 'px-row-x' }, actionNode(R, ctx, item, `${key}:button`));
export const sidebarFooter = defineBinding({
  id: 'sidebar.footer', presents: ['App'],
  twins: [{ presentation: 'Sidebar', subject: () => APP, slots: { footer: siblingRegion(), items: siblingList(footerRow, { field: 'items', budget: 4 }), status: footerStatus } }],
  render: beside,
});
// The conversations sidebar's groups, hidden (layouts.md §4.1, D9; sidebar-groups.mjs): the sortable container they are drawn in (exposure
// `SidebarSortable`, every sortable list of the app: the others pass as they are). Their order is the seam `sidebarGroups`'s.
export const sidebarGroupsHide = defineBinding({
  id: 'sidebar.groups.hide', presents: ['App'],
  render(Original, props, factory, ctx) { const next = hideGroups(props, ctx); return next ? factory(Original, next) : undefined; },
});
// The sidebar's body by area where the rail shows (layouts.md D7, WL5c; scout wl5-pages.md §4.2): a mod's page with a sidebar view draws it in
// place of the conversations, the app's contextual column around it (seam rail-mode) and its footer kept.
// While the user hovers another destination the app previews its sidebar here (`isPreview`): that stays the app's.
export const sidebarArea = defineBinding({
  id: 'sidebar.area', presents: ['App'],
  render(Original, props, factory, ctx) {
    const view = props.isPreview === true ? null : ctx.pageSidebar?.();
    return view ? factory(Original, { ...props, children: view }) : undefined;
  },
});
// The footer's banners and buttons (layouts.md §4.1; scout wl2-groups-footer.md §2; exposure `sidebarFooter`): each the Sidebar's footer part
// it draws, not drawn where a mod hides it. The account control (the way to settings) and the update button are protected: no binding
// draws them as parts.
const FOOTER_PARTS = Object.freeze({ usageAlert: 'usage', checklist: 'gettingStarted', financeChecklist: 'gettingStarted', announcement: 'announcement', updateBanner: 'updateBanner', invite: 'invite' });
export const footerParts = Object.freeze(Object.entries(FOOTER_PARTS).map(([member, part]) => defineBinding({
  id: `sidebar.footer.${member}`, presents: ['App'],
  appPartsOf: 'Sidebar', appPartsSubject: () => APP, appParts: { [part]: 'self' }, render: () => undefined,
})));

// A sidebar row's hover actions (the row whose props carry renderActions): mods' actions after the app's archive, pin and "…", with room
// made for them (additionalHoverActionCount).
export const sidebarRow = defineBinding({
  id: 'sidebar.row', presents: ['Thread'],
  // its SidebarItem's indicators (public-hooks.md §3.10): the generic row's own props, and its icon badges by the app's ids
  appPartsOf: 'SidebarItem', appPartsSubject: (props, ctx) => ctx.thread(props.conversationId),
  appParts: {
    status: (p) => ({ ...p, hideStatusIndicator: true }),
    unread: (p) => ({ ...p, isUnread: false }),
    time: (p) => ({ ...p, metaHidden: true }),
    activeDot: (p) => (Array.isArray(p.extraIconBadges) ? { ...p, extraIconBadges: p.extraIconBadges.filter((x) => x?.id !== 'active-status') } : p),
    automation: (p) => (Array.isArray(p.extraIconBadges) ? { ...p, extraIconBadges: p.extraIconBadges.filter((x) => x?.id !== 'triggers') } : p),
  },
  twins: [{ presentation: 'SidebarItem', subject: (props, ctx) => ctx.thread(props.conversationId),
    slots: { trailingActions: renderedList('renderActions', action, { field: 'actions', count: 'additionalHoverActionCount' }) } }],
});
// The list row a sidebar row draws (its title what it shows; it names no chat): under a sidebar row (its nearest site, addresses.json), the
// title, subtitle and icon its chat's summary gives (public-hooks.md §3.13: decorate's `summary` on its SidebarItem): the subtitle its
// second line (`secondaryContent`, the app's own, as its avatar mode and Unreads list draw it; one the app gives stays), the icon its
// emoji (the app draws it before a text title, or as a pinned row's avatar). The generic row's own title override shows only where a row
// has no title.
export const sidebarRowTitle = defineBinding({
  id: 'sidebar.row.title', presents: ['Thread'],
  twins: [{ presentation: 'SidebarItem', subject: (props, ctx, scope, near) => (near?.binding === 'sidebar.row' ? ctx.thread(near.props?.conversationId) : null),
    slots: { summary: summarySlot((p, s) => ({ ...p,
      ...(s.title ? { title: s.title } : {}),
      // its accessible name reads the same (the original title in it replaced: built review H7j-l)
      ...(s.title && typeof p.ariaLabel === 'string' && typeof p.title === 'string' && p.title ? { ariaLabel: p.ariaLabel.split(p.title).join(s.title) } : {}),
      ...(s.subtitle && p.secondaryContent == null ? { secondaryContent: s.subtitle } : {}),
      // the icon: the row's emoji (21477), or before its title where the row has none (22943 removed it; 20770 never had it) and the app
      // put nothing there
      ...(s.icon ? ('emoji' in p ? { emoji: s.icon } : p.titlePrefix == null ? { titlePrefix: s.icon } : {}) : {}) })) } }],
});

// The card a sidebar row shows on hover (21477: the row builds it as it draws, `threadTitle` its title): under a sidebar row (its nearest
// site), the title its chat's summary gives, as the row shows it.
export const sidebarRowCard = defineBinding({
  id: 'sidebar.row.card', presents: ['Thread'],
  twins: [{ presentation: 'SidebarItem', subject: (props, ctx, scope, near) => (near?.binding === 'sidebar.row' ? ctx.thread(near.props?.conversationId) : null),
    slots: { summary: summarySlot((p, s) => (s.title ? { ...p, threadTitle: s.title } : p)) } }],
});

// The window's frame (layouts.md D10, §5.1 WL4a; scout wl4-frame.md): the component that lays out the left panel and the app's column in the
// workspace row (its props exactly `children, footer, leftPanelSlot`, and the declarative shell's `titleBar, hasCustomTitleBar`). With the
// shell's context there, its children are the frame host (frame-regions.mjs), with or without regions (so one that comes or goes never
// remounts the column): the regions beside the app's column, the column given the shell's context with their widths. Its window facts:
// the regions as it draws them.
export const frame = defineBinding({
  id: 'frame', presentation: 'Window', presents: ['App'],
  // `regions`: the mods' regions (ui.regions.add), drawn by its render (frame-regions.mjs)
  slots: { regions: { kind: 'external' } },
  // the regions, the bottom panel and the sidebar as it draws them (never as asked: what is held for space is said apart, `suspended`)
  windowFacts: (ctx) => ({ regions: regionFacts(ctx), bottomAt: drawnBottomAt(ctx), sidebarEdge: drawnSidebarEdge(), suspended: suspendedFacts(ctx) }),
  render(Original, props, factory, ctx) {
    followArrangement(ctx);   // the host draws again when the window's arrangement changes, with or without regions
    const nav = ctx.exports?.()?.navigationShell;
    const R = ctx.react();
    if (!R || !nav || !nav.Provider || typeof ctx.modNode !== 'function') return undefined;
    const open = declaredRegions(ctx).map((r) => ({ ...r, ...regionState(ctx, r) })).filter((r) => r.open);
    return factory(Original, { ...props, children: R.createElement(FrameHost, { R, nav, ctx, regions: open, original: props.children }) });
  },
});

// The sidebar's divider (layouts.md WL4c; scout wl4-frame.md §4 row 2, S3): the app's divider drawn with exactly these props (the docked
// sidebar's), on the sidebar's left edge while the sidebar is at the right (the app's divider takes `edge`: its handle there, its drag
// maths mirrored).
export const sidebarDivider = defineBinding({
  id: 'frame.divider', presents: ['App'],
  render(Original, props, factory, ctx) { return sidebarEdge(ctx) === 'right' ? factory(Original, { ...props, edge: 'left' }) : undefined; },
});

// The app's rail where the app shows it (layouts.md §4.1, WL2; WL0: its component takes a `header` the app leaves empty and a `footer`):
// the Rail's own ends, the mods' regions at its top (`header`) and after the app's own footer (`footer`).
const railEnd = (field) => ({ kind: 'region', apply: (props, nodes, env) => (nodes.length && env?.R
  ? { ...props, [field]: env.R.createElement(env.R.Fragment, null, props[field] ?? null, ...nodes) } : props) });
export const rail = defineBinding({
  id: 'rail', presents: ['App'],
  twins: [{ presentation: 'Rail', subject: () => APP, slots: { header: railEnd('header'), footer: railEnd('footer') } }],
});

// A project group's header actions (the component whose props carry its group and its new-chat action): mods' actions beside them.
/** The app's title-bar actions (`appShell.HeaderAction` actionIds) and the TitleBar's `actions` parts they are (public-hooks.md §3.10). */
const TITLE_PARTS = Object.freeze({ 'sidebar-trigger': 'sidebarToggle', 'history-navigation': 'history', 'new-chat': 'newChat', 'unified-thread-actions': 'threadActions',
  'unified-workspace-controls': 'workspaceControls', 'thread-side-panel-new-tab': 'newTab', 'thread-bottom-panel-toggle': 'bottomPanelToggle', 'thread-side-panel-close': 'sidePanelClose' });
// Every title-bar action the app registers is the app shell's HeaderAction (matched by identity); one whose actionId is a hidden part is
// not drawn. The mods' own (frame.mjs titleBar) carry ids of their own.
export const titleAction = defineBinding({
  id: 'title.action', presentation: 'TitleBar', part: true, presents: ['App'],
  appParts: Object.fromEntries(Object.entries(TITLE_PARTS).map(([actionId, part]) => [part, (p) => (p.actionId === actionId ? null : p)])),
  render: () => undefined,
});
// The app's header icon button where it draws the sidebar's toggle (22943 AAt, 21477 Pqa; wl2-seams §3): the TitleBar's sidebarToggle,
// relabelled (its accessible name, and its tooltip: the label when no tooltip is given). The binding takes the component, so its back and
// forward buttons pass through it too: told apart by the toggle's own view transition name, and not relabelled (one part, two buttons).
export const titleSidebarToggle = defineBinding({
  id: 'title.sidebarToggle', presents: ['App'],
  appPartsOf: 'TitleBar', appPartsSubject: () => APP,
  relabelParts: { sidebarToggle: (p, { label, tooltip }) => (p.viewTransitionName === 'sidebar-trigger'
    ? { ...p, ...(label ? { ariaLabel: label } : {}), tooltipContent: tooltip ?? label } : p) },
  render: () => undefined,
});

export const sectionActions = defineBinding({
  id: 'sidebar.section.actions', presents: ['Project'],
  twins: [{ presentation: 'SidebarSection',
    subject: (props) => localProjectOf(props),
    // its badges beside its actions (public-hooks.md §3.13)
    slots: { headerActions: siblingList(action, { field: 'actions' }), badges: siblingList(({ R, ctx }, item, key) => badgeNode(R, ctx, item, key), { field: 'badges' }) } }],
  render: beside,
});

// A project group's thread list (E8.9, scout E8-frame-slots §2.3: its 11 props exactly, one call on 21477 and 20770): its SidebarSection's
// footer, regions after the list, inside the group's collapse (they fold with it, under the app's own "Show more").
// Its chats in a declared order (ui.sidebar.order): reordered and marked precomputed, so the user's saved order does not replace it.
export const sectionList = defineBinding({
  id: 'sidebar.section.list', presents: ['Project'],
  twins: [{ presentation: 'SidebarSection', subject: localProjectOf, slots: { footer: siblingRegion() } }],
  render(Original, props, factory, ctx) {
    const ordered = orderedGroup(props, ctx);
    return beside(Original, ordered ?? props, factory, ctx) ?? (ordered ? factory(Original, ordered) : undefined);
  },
});

/**
 * The window's title bar (mod-surfaces.md §3.7, E8.9; scout E8-frame-slots §1; layouts.md D1, WL1): one component draws it (its props: the
 * content pane's width, the sidebar's motion, whether the page has a surface, and three flags). Its slots are the app's own six positions,
 * the TitleBar's `left`, `center`, `right`, `main`, `thread` and `threadSummary`: each mod entry is an `AppShell.HeaderAction` beside it,
 * the way the app puts its own buttons there, in that position. The Window keeps `status` and `banner`.
 */
const HEADER = '__codexmodsHeader';
const headerList = (position) => ({
  kind: 'list', field: 'actions',
  apply: (props, entries, env) => ({ ...props, [HEADER]: [...(props[HEADER] ?? []), ...entries.map((e, i) => {
    const key = `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`;
    return { position, key, node: actionNode(env.R, env.ctx, e.item, key) };
  })] }),
});
// The TitleBar's `menu` (layouts.md §4.1, WL2): the mods' entries in the title bar's context menu, as the app's own HeaderContextMenuItems
// beside the title bar (the app draws them in its menu, native or its own). Each registers its props by identity, so an entry's props are
// one object while what it shows is unchanged (a new object each render would register it again and draw the title bar again); its label
// is a plain-text message (the app formats `{id, defaultMessage}`; the id is no translation, so the text shows in every language).
const MENU = '__codexmodsMenu';
const menuList = { kind: 'list', field: 'items', apply: (props, entries) => ({ ...props, [MENU]: [...(props[MENU] ?? []), ...entries.map((e, i) => ({
  key: `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`, item: e.item }))] }) };
const menuProps = new Map();   // key -> { said, props, run }
export function menuItemProps(key, item) {
  const title = typeof item?.title === 'string' ? item.title : '';
  const type = item?.type === 'separator' ? 'separator' : typeof item?.checked === 'boolean' ? 'checkbox' : undefined;
  const said = JSON.stringify([title, type ?? null, item?.checked === true, item?.disabled === true]);
  let m = menuProps.get(key);
  if (!m || m.said !== said) {
    const entry = m ?? { run: null };
    entry.said = said;
    entry.props = { id: key, message: { id: `codexmods.menu.${key}`, defaultMessage: title || key }, ...(type ? { type } : {}),
      ...(type === 'checkbox' ? { checked: item.checked === true } : {}), ...(item?.disabled === true ? { enabled: false } : {}), onSelect: () => entry.run?.() };
    m = entry;
    menuProps.set(key, m);
  }
  m.run = typeof item?.run === 'function' && item.disabled !== true ? item.run : null;
  return m.props;
}
// The Window's `status` (ui.status, public-hooks.md §3.14): the mods' statuses on every page, in the right slot with its actions.
const headerStatus = statusList((props, nodes) => ({ ...props, [HEADER]: [...(props[HEADER] ?? []), ...nodes.map((node) => ({ position: 'right', key: String(node.key), node }))] }));
// The Window's banner (mod-surfaces.md §3.7, E8.9i; scout E8-frame-slots §1.3): the mods' regions in the app's own page banner, above the
// page, on every page. The app keeps one banner value per page and its composer pages always write one (`AppShell.PageBanner`), so there is
// one writer: while the mods have banners, the title bar writes the page's banner (the app's own content first, then the mods'), and the
// app's own writer (`page.banner`) stands down, its content read from its mount.
const BANNER = '__codexmodsBanner';
const bannerRegion = { kind: 'region', apply: (props, nodes) => ({ ...props, [BANNER]: [...(props[BANNER] ?? []), ...nodes] }) };
export const windowTitleBar = defineBinding({
  id: 'window.titlebar', presentation: 'Window', presents: ['App'],
  subject: () => APP,
  slots: { status: headerStatus, banner: bannerRegion },
  twins: [{ presentation: 'TitleBar', subject: () => APP,
    slots: { ...Object.fromEntries(['left', 'center', 'right', 'main', 'thread', 'threadSummary'].map((position) => [position, headerList(position)])), menu: menuList } }],
  render(Original, props, factory, ctx, route) {
    const { [HEADER]: entries, [BANNER]: banners, [MENU]: menu, ...own } = props;
    const shown = Array.isArray(entries) && entries.length > 0, bannered = Array.isArray(banners) && banners.length > 0, menued = Array.isArray(menu) && menu.length > 0;
    // the window's layouts, by the app's own controls (layouts.md D6)
    const picker = ctx.layoutPicker?.() ?? null;
    if (!shown && !bannered && !menued && !picker) return undefined;
    const R = ctx.react();
    const shell = ctx.exports?.()?.appShell;
    if (!R) return factory(Original, own);
    const out = [factory(Original, own)];   // the title bar first and unkeyed
    if (picker && shell?.HeaderAction) out.push(R.createElement(shell.HeaderAction, { key: 'codexmods:layouts', actionId: 'codexmods:layouts', slotPosition: 'right', align: 'end', order: 99, desktopPlacement: 'titlebar', children: picker }));
    // the entries (each registers itself into its slot of the route while mounted); a build without the app's header actions shows none
    if (shown && shell?.HeaderAction) out.push(...entries.map((x, i) => R.createElement(shell.HeaderAction, {
      key: x.key, actionId: x.key, slotPosition: x.position, align: 'end', order: 100 + i, desktopPlacement: 'titlebar', children: x.node,
    })));
    if (menued && shell?.HeaderContextMenuItem) out.push(...menu.map((x) => R.createElement(shell.HeaderContextMenuItem, { key: `menu:${x.key}`, ...menuItemProps(x.key, x.item) })));
    if (bannered && shell?.PageBanner) {
      // the app's own banner of this page only (a page kept mounted out of sight writes its own, review 4)
      const app = ctx.mountsOf('page.banner').filter((m) => samePage(m.scope, route)).map((m) => m.props?.children).filter((c) => c !== null && c !== undefined && c !== false);
      out.push(R.createElement(shell.PageBanner, { key: 'codexmods:banner' }, ...app, ...banners));
    }
    return R.createElement(R.Fragment, null, ...out);
  },
});
// The app's own page banner writer (a page's banner content, matched by identity): it stands down while the title bar of its page writes
// the page's banner (the mods have banners), its content drawn there first. Either way the app's shell draws the banner's value, so its
// content renders under the same providers. Pages are told apart by their route (RouteScope: its path and search).
const samePage = (a, b) => !!a && !!b && typeof a.pathname === 'string' && a.pathname === b.pathname && (a.search ?? '') === (b.search ?? '');
export const pageBanner = defineBinding({
  id: 'page.banner', presents: ['App'],
  subject: () => null,
  render(Original, props, factory, ctx, route) {
    if (!ctx.mountsOf('window.titlebar').some((m) => samePage(m.scope, route))) return undefined;
    const app = ctx.subject(APP);
    const ruled = ctx.ruled('Window', app && !app.gone ? app : null);
    return ruled?.regions?.banner?.length ? null : undefined;
  },
});

/** The project a site names: a project group's section actions (its group), a local project's. */
const projectOf = (near) => {
  const g = near && near.binding === 'sidebar.section.actions' ? near.props?.group : null;
  return g && g.projectKind === 'local' && typeof g.projectId === 'string' && g.projectId ? { type: 'LocalProject', provider: 'codex', id: g.projectId } : null;
};
/**
 * A project's menu (mod-surfaces.md §3.5, E8.7b): on 21477 a project row's "..." menu and its right-click are one component given
 * `getContextMenuItems` (the row's right-click asks the same function through its handle). It has no project of its own: it reads the
 * nearest site, the project group's section actions (`site` in their address). The mods' groups for that Project follow the app's items.
 */
export const projectMenu = defineBinding({
  id: 'menu.project', presentation: 'Menu', presents: ['Project'],
  subject: (props, ctx, scope, near) => projectOf(near),
  render(Original, props, factory, ctx, scope, near) {
    const ref = projectOf(near);
    const own = props.getContextMenuItems;
    if (!ref || typeof own !== 'function' || typeof ctx.projectMenu !== 'function') return undefined;
    return factory(Original, { ...props, getContextMenuItems: (...a) => {
      const items = own(...a);
      return items && typeof items.then === 'function' ? items.then((x) => ctx.projectMenu(ref, x)) : ctx.projectMenu(ref, items);
    } });
  },
});

// The command palette (presents App): the palette dialog, while it is open; closing it is its own `close()`.
export const palette = defineBinding({
  id: 'palette', presentation: 'Palette',
  place: { in: 'Window', slot: 'overlay' },
  presents: ['App'],
  subject: () => APP,
  // `resultSources`: the mods' sources (mod-surfaces.md §3.2) are sections of the app's own, written by a registrar mounted beside the
  // palette (present/palette-sources.mjs), not passed through its props
  // `groups`: a source with a title of its own is a group of the palette (the card's slot); the same rule shape
  // `hidden`: the commands the mods hide (ui.hide('Command')), left out by their rows (palette-hides.mjs)
  // `groups` and `commands` take reorders too (public-hooks.md §3.10): the app's command groups, and its commands in their group, drawn
  // in the mods' order by the palette's own list and groups (palette.list, palette.group below)
  slots: { resultSources: { kind: 'external' }, groups: { kind: 'external' }, hidden: { kind: 'external' }, commands: { kind: 'external' } },
  render(Original, props, factory, ctx) {
    const ps = ctx.paletteSources?.();
    const R = ctx.react?.();
    if (!ps || !R) return undefined;
    return R.createElement(R.Fragment, null, R.createElement(ps.Registrar, { key: 'codexmods-palette-sources', scopeNode: ctx.scopeNodeOf?.('palette'), close: props.close }), factory(Original, props));
  },
  operations: {
    close(props) {
      if (typeof props.close !== 'function') return { unavailable: 'the palette cannot be closed from here' };
      props.close();
      return true;
    },
  },
});

// Palette group order and rank (public-hooks.md §3.10: `ui.reorder('Palette', {slot: 'groups' | 'commands', order})`): the palette's own
// list and groups (cmdk's List and Group, by identity: the app draws other lists with them, which pass through) are drawn in the mods'
// order as the palette renders them; the app's own lists are never changed (its keyboard shortcut lists read the same group order, and the
// palette keeps its commands filtered across renders). The list's app groups (its elements keyed `group-<name>`) change places among
// themselves; a group's command rows (each names its command) do too, the named first in each rule's order (the last rule in order has the
// first places), the others after as they were. While text is typed, the palette ranks rows by their match (cmdk sorts them as the text
// changes, not as its children move): the order is not drawn then (built review, round 2), the text read from cmdk's state.
const paletteParts = (ctx, slot) => {
  const app = ctx.subject(APP);
  const parts = ctx.ruled?.('Palette', app && !app.gone ? app : null)?.parts ?? [];
  return parts.filter((r) => r.kind === 'reorder' && r.slot === slot && Array.isArray(r.data?.order));
};
/** `children` with the entries `nameOf` names (in it or in an array in it) in the rules' order among their own places; the same when none move. */
function ordered(children, slot, rules, nameOf) {
  const one = (list) => {
    const at = [], items = [];
    list.forEach((x, i) => { if (nameOf(x) !== null) { at.push(i); items.push(x); } });
    if (items.length < 2) return list;
    const next = applyParts(rules, slot, items, nameOf);
    if (next.every((x, i) => x === items[i])) return list;
    const out = [...list];
    at.forEach((i, k) => { out[i] = next[k]; });
    return out;
  };
  if (!Array.isArray(children)) return children;
  const top = one(children);
  const out = top.map((x) => (Array.isArray(x) ? one(x) : x));
  return out.some((x, i) => x !== children[i]) ? out : children;
}
// an app command group's element (its Quick actions, `group-suggested`, is not one of them: it keeps its place)
const groupOf = (el) => {
  const m = el && typeof el === 'object' && typeof el.key === 'string' ? /^group-([a-z]+)$/.exec(el.key) : null;
  return m && Object.hasOwn(PARTS.Palette.groups, m[1]) ? m[1] : null;
};
const commandOf = (el) => (el && typeof el === 'object' && el.props && typeof el.props.command?.id === 'string' ? el.props.command.id : null);
/**
 * The app's list or group drawn in the mods' order, by a component of the framework's own (the same one on every render, so the hook it
 * calls is too: a binding's render calls none, as a bound wrapper calls it only once the runtime is there): it reads the text typed in the
 * palette from cmdk's state, and while there is some draws the app's own children (cmdk ranks the rows by their match), else the ordered.
 */
function CodexmodsPaletteOrder({ codexmods: { Original, own, ordered: next, factory, ctx } }) {
  const ps = ctx.paletteSources?.();
  const search = ps && typeof ps.useSearch === 'function' ? String(ps.useSearch() ?? '').trim() : '';
  return factory(Original, search ? own : next);
}
const orderedRender = (slot, nameOf) => (Original, props, factory, ctx) => {
  const rules = paletteParts(ctx, slot);
  if (!rules.length) return undefined;
  const children = ordered(props.children, slot, rules, nameOf);
  return children === props.children ? undefined : factory(CodexmodsPaletteOrder, { codexmods: { Original, own: props, ordered: { ...props, children }, factory, ctx } });
};
export const paletteList = defineBinding({ id: 'palette.list', presents: ['App'], render: orderedRender('groups', groupOf) });
export const paletteGroup = defineBinding({ id: 'palette.group', presents: ['App'], render: orderedRender('commands', commandOf) });
