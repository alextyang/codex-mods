// The mods' regions at the workspace's edges (docs/design/layouts.md D10, §5.1 WL4a; scout docs/research/layouts/wl4-frame.md): add rules on
// the Window's `regions` (ui.regions.add), drawn by the frame's binding (frame.mjs) as flex items of the app's workspace row, left and right
// of the app's own column (its root is `display: contents`), with the shell's context given to the column with the regions' widths taken
// off the main view's (`mainContentWidth`, `workspaceTargetWidth`) and, for left regions, added to the left panel's (`leftPanelViewportWidth`,
// `sidebarMotion`), so the app's own maths (the side panel's ratio, the thread summary's overlay, the drop zones) see the real space.
// Each window holds its regions' state now (open, width: Window.setRegion), taken once from what the user kept when it first draws one: the
// width the user drags a region to (the app's own divider) is kept in the page's storage, which a window reads when it starts, never after.
// The window's facts are what it draws (each region's column, measured); a frame the binding cannot draw says so. NO NODE API.

import { createReport } from '../reports.mjs';
import { REGION_WIDTH } from '../../../shared/ui-rules-client.mjs';

const STATE_KEY = 'local:frame.regions';
const SHEET_ID = 'codexmods-frame-regions';
const KEPT = 'codexmods:region-width:';
const states = new WeakMap();   // the runtime's ctx (one per window) -> region key -> {open, size}
const hosted = new WeakSet();   // the runtime's ctxs whose frame the host draws now

const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
/** A region's width bounds and default, from its declaration. */
export function boundsOf(region) {
  const w = region?.width ?? {};
  const min = w.min ?? REGION_WIDTH.min, max = w.max ?? REGION_WIDTH.max;
  return { min, max, default: w.default ?? Math.min(Math.max(REGION_WIDTH.default, min), max) };
}
const clamp = (v, b) => Math.round(Math.max(b.min, Math.min(v, b.max)));
/** The width the user dragged a region to (kept in the page's storage), or null. */
function kept(key) { const v = Number(storage()?.getItem?.(KEPT + key)); return Number.isFinite(v) && v > 0 ? v : null; }
function keep(key, width) { try { storage()?.setItem?.(KEPT + key, String(Math.round(width))); } catch { /* the page's storage is unavailable */ } }

/** The mods' regions declared in this window, in rule order: `{key, rule, edge, title, icon, bounds, render}` (read: a render that reads
 *  them renders again when they change). */
export function declaredRegions(ctx) {
  if (typeof ctx.declared !== 'function') return [];
  return ctx.declared('Window', 'regions').map((r) => {
    const region = r.data?.region;
    const render = r.fns?.region?.render;
    if (!region || (region.edge !== 'left' && region.edge !== 'right') || typeof render !== 'function') return null;
    return { key: `${r.mod}/${r.id}`, rule: r, edge: region.edge, title: region.title, icon: region.icon, bounds: boundsOf(region), render };
  }).filter(Boolean);
}
/** A region's state in this window: open, and its width (this window's: from its first read, the one the user kept, else its default). */
export function regionState(ctx, region) {
  ctx.local?.read?.(STATE_KEY);
  let m = states.get(ctx);
  if (!m) states.set(ctx, (m = new Map()));
  let s = m.get(region.key);
  // taken once: a drag in another window keeps a width for windows to come, never moves this one's
  if (!s) m.set(region.key, (s = { open: true, size: kept(region.key) ?? region.bounds.default }));
  return { open: s.open, size: clamp(s.size, region.bounds) };
}
/** Set a region in this window (Window.setRegion): open or closed, and its width, within its bounds; false when it is not declared here. */
export function setRegion(ctx, key, { open, size } = {}) {
  const region = declaredRegions(ctx).find((r) => r.key === key);
  if (!region) return false;
  const cur = regionState(ctx, region);
  states.get(ctx).set(key, { open: typeof open === 'boolean' ? open : cur.open, size: Number.isFinite(size) ? clamp(size, region.bounds) : cur.size });
  ctx.local?.touch?.(STATE_KEY);
  return true;
}
/** A region's state put back as it was, declared now or not (a layout ending as its mod goes: the declaration left first, and comes back with it). */
export function putRegionBack(ctx, key, { open, size }) {
  if (setRegion(ctx, key, { open, size })) return;
  let m = states.get(ctx);
  if (!m) states.set(ctx, (m = new Map()));
  m.set(key, { open, size });
  ctx.local?.touch?.(STATE_KEY);
}
/** A region's column as the window draws it: its layout width (CSS px, as its size and the app's divider count them, whatever the
 *  page's zoom), or null when it is not drawn (none, or not laid out). */
function drawnWidth(key) {
  const d = globalThis.document;
  if (typeof d?.querySelectorAll !== 'function') return null;
  for (const el of d.querySelectorAll('aside[data-codexmods-region]')) {
    if (el.getAttribute('data-codexmods-region') !== key) continue;
    const w = el.offsetWidth;
    return Number.isFinite(w) && el.getClientRects?.().length ? w : null;
  }
  return null;
}
/**
 * The regions as the window draws them (its facts): `{[key]: {open, size?, edge, unsupported?}}`, each open only while its column is
 * drawn, at the width measured; one this window would show while the frame's host is not drawn (a frame of another shape) is
 * `unsupported: 'frame'`. Always an object (none declared: `{}`), so a region that goes leaves the Window's state too.
 */
export function regionFacts(ctx, measure = drawnWidth) {
  const out = {};
  for (const r of declaredRegions(ctx)) {
    const w = measure(r.key);
    if (Number.isFinite(w) && w > 1) { out[r.key] = { open: true, size: Math.round(w), edge: r.edge }; continue; }
    out[r.key] = { open: false, edge: r.edge, ...(regionState(ctx, r).open && !hosted.has(ctx) ? { unsupported: 'frame' } : {}) };
  }
  return out;
}

// The bottom panel beside the chat (layouts.md WL4b; scout wl4-workspace.md §2.5): this window's placement of it (Window.setRegion's `at`),
// its width beside (this window's, from its first read the one the user dragged it to, else 420), whether the app has it open (its frame
// says), and the column the frame's host draws for it, which the bottom panel's frame fills with the app's own content through a portal.
const BOTTOM = 'codexmods/bottom';   // its kept width's key
export const BESIDE = Object.freeze({ min: 320, max: 960, default: 420 });
const placements = new WeakMap();   // the runtime's ctx -> { at, size, open, node }
function placementOf(ctx) {
  let p = placements.get(ctx);
  if (!p) placements.set(ctx, (p = { at: 'below', size: kept(BOTTOM) ?? BESIDE.default, open: false, node: null, columns: new Map() }));
  return p;
}
/**
 * The workspace columns in this window (one per page the app keeps mounted, whose narrow-window handler and bottom panel frame stay live
 * though it is out of sight), each registered by its bottom panel's frame: its chat (`key`), its latest scope, and whether it is shown (its
 * marker's parent). The shown one owns the column beside and is what the allocator shares the window out for.
 */
export function claimBeside(ctx, token, column) { const p = placementOf(ctx); p.columns.delete(token); p.columns.set(token, column); ctx.local?.touch?.(STATE_KEY); }
export function releaseBeside(ctx, token) {
  const p = placementOf(ctx);
  if (!p.columns.delete(token)) return;
  if (!p.columns.size) p.open = false;   // no frame of the panel left: nothing is open beside
  ctx.local?.touch?.(STATE_KEY);
}
/** The column shown now (the latest registered, among any the page says are shown): `{token, key, scope}`, or null. Read. */
export function shownColumn(ctx) {
  ctx.local?.read?.(STATE_KEY);
  for (const [token, c] of [...placementOf(ctx).columns].reverse()) { try { if (c.shown()) return { token, key: c.key, scope: c.scope }; } catch { /* not measurable: not it */ } }
  return null;
}
export const besideOwner = (ctx) => shownColumn(ctx)?.token ?? null;
/** A column came into sight or went out of it: the frame and the allocator follow. */
export function columnsChanged(ctx) { ctx.local?.touch?.(STATE_KEY); tellWatchers(ctx); }
/** The window's arrangement as the frame follows it (read: the frame draws again when a placement, an edge or a hold changes). */
export function followArrangement(ctx) { ctx.local?.read?.(STATE_KEY); }
/** The bottom panel's placement in this window: `{at: 'below' | 'left' | 'right', size, open, node}` (read: a render follows it). */
export function bottomPlacement(ctx) {
  ctx.local?.read?.(STATE_KEY);
  const p = placementOf(ctx);
  return { at: p.at, size: clamp(p.size, BESIDE), open: p.open, node: p.node };
}
/** Change it (each field given): its place, its width beside (within its bounds), the app's open, the column's node. */
export function setBottomPlacement(ctx, { at, size, open, node } = {}) {
  const p = placementOf(ctx);
  let changed = false;
  const put = (k, v) => { if (v !== undefined && p[k] !== v) { p[k] = v; changed = true; } };
  put('at', ['below', 'left', 'right'].includes(at) ? at : undefined);
  put('size', Number.isFinite(size) ? clamp(size, BESIDE) : undefined);
  put('open', typeof open === 'boolean' ? open : undefined);
  put('node', node === undefined ? undefined : node);
  if (changed) ctx.local?.touch?.(STATE_KEY);
}
/** Where the bottom panel is drawn (the window's facts): the column beside it is in when there is one, else below while the app has it
 *  open (the frame cannot hold it beside, or it is held for space), else where it will open. */
export function drawnBottomAt(ctx) {
  const el = [...(globalThis.document?.querySelectorAll?.('[data-codexmods-bottom-at]') ?? [])].find((n) => (typeof n.checkVisibility === 'function' ? n.checkVisibility() : true));
  const at = el?.getAttribute('data-codexmods-bottom-at');
  if (at === 'left' || at === 'right') return at;
  const place = bottomPlacement(ctx);
  return place.at === 'below' || place.open ? 'below' : place.at;
}
/** Where the sidebar is drawn (the window's facts): at the right while the frame's stylesheet puts it there. */
export const drawnSidebarEdge = () => (globalThis.document?.documentElement?.getAttribute?.('data-codexmods-sidebar-side') === 'right' ? 'right' : 'left');
/** Does this window's frame host draw (so a column beside can be drawn)? */
export const frameDrawn = (ctx) => hosted.has(ctx);

// What the framework's allocator gave up for space in this window (layouts.md D12, WL4d; allocator.mjs): the mods' regions, the bottom
// panel beside (drawn below meanwhile), and the app's side panel and sidebar it closed (the app's own setters; said in the window's facts).
const holds = new WeakMap();   // the runtime's ctx -> { regions, beside, side, sidebar }
const NONE = Object.freeze({ regions: false, beside: false, side: false, sidebar: false });
/** What is held for space in this window (read: a render follows it). */
export function spaceHeld(ctx) { ctx.local?.read?.(STATE_KEY); return holds.get(ctx) ?? NONE; }
/** Hold or give back one of them. */
export function holdForSpace(ctx, what, on) {
  const h = { ...(holds.get(ctx) ?? NONE) };
  if (!(what in h) || h[what] === on) return;
  h[what] = on;
  holds.set(ctx, h);
  ctx.local?.touch?.(STATE_KEY);
}
/** The window's regions held for space, as its facts say them (`suspended`): the mods' regions' keys, `bottom`, `side`, `sidebar`. */
export function suspendedFacts(ctx) {
  const h = holds.get(ctx) ?? NONE;
  return [...(h.regions ? declaredRegions(ctx).filter((r) => regionState(ctx, r).open).map((r) => r.key) : []), ...(h.beside ? ['bottom'] : []), ...(h.side ? ['side'] : []), ...(h.sidebar ? ['sidebar'] : [])];
}
const watchers = new WeakMap();   // the runtime's ctx -> who follows the arrangement (the allocator, a held layout)
function tellWatchers(ctx) { for (const fn of watchers.get(ctx) ?? []) { try { fn(); } catch { /* its own */ } } }
/** Follow the window's arrangement (a region that comes, a placement beside, the column shown): `fn` runs after each change the host draws. Gives the way to stop. */
export function onArrangement(ctx, fn) {
  let set = watchers.get(ctx);
  if (!set) watchers.set(ctx, (set = new Set()));
  set.add(fn);
  return () => { set.delete(fn); };
}

// The sidebar on the right edge (layouts.md WL4c; scout wl4-frame.md §4): this window's edge for it (Window.setRegion('sidebar', {edge})),
// drawn by the frame's one stylesheet keyed on the root's `data-codexmods-sidebar-side` (the left panel after the workspace, its rail
// after its root, the page surface's insets, borders and radii mirrored), its divider on its left edge (binding frame.divider), and the
// shell's title-bar maths told the left panel holds only the mods' left regions (the sidebar's width is the title bar's right budget).
// Only where the app shows its rail: the rail-less hover peek reads the pointer from the window's left edge (a source edit, not made).
const edges = new WeakMap();   // the runtime's ctx -> 'right' (absent: the app's own, left)
/** The sidebar's edge in this window: 'left' (the app's) or 'right' (read: a render follows it). */
export function sidebarEdge(ctx) { ctx.local?.read?.(STATE_KEY); return edges.get(ctx) ?? 'left'; }
/** Put it there (false: not an edge). */
export function setSidebarEdge(ctx, edge) {
  if (edge !== 'left' && edge !== 'right') return false;
  if ((edges.get(ctx) ?? 'left') !== edge) { if (edge === 'right') edges.set(ctx, edge); else edges.delete(ctx); ctx.local?.touch?.(STATE_KEY); }
  return true;
}
/** Move it (Window.setRegion's sidebar `edge`): to the right only where the app shows its rail and this window's frame host draws. */
export function moveSidebar(ctx, edge) {
  if (edge !== 'left' && edge !== 'right') return { unavailable: 'the sidebar is at the left or the right' };
  if (edge === 'right' && !globalThis.document?.querySelector?.('nav[data-app-navigation-rail]')) return { unavailable: 'the sidebar goes to the right only where the app shows its rail' };
  if (edge === 'right' && !hosted.has(ctx)) return { unavailable: 'this window\'s frame cannot hold the sidebar at the right' };
  setSidebarEdge(ctx, edge);
  return true;
}
const SIDE_ATTR = 'data-codexmods-sidebar-side';
/** The frame's stylesheet: the title bar shortened over what is at the right; with the sidebar on the right, the frame mirrored. */
const SHEET = [
  ':root [data-app-shell-titlebar] { inset-inline-end: var(--codexmods-edge-right, 0px); }',
  `:root[${SIDE_ATTR}=right] [data-app-shell-workspace-row] > aside.app-shell-left-panel { order: 1; }`,
  // its inner box (absolute at the start, as wide as the panel: its rail and root overflow it while the sidebar is closed and show while
  // it peeks), at the end, its content overflowing towards the start, so the rail is what shows; not its divider
  `:root[${SIDE_ATTR}=right] aside.app-shell-left-panel > div:not([class*="panel-resizer"]) { inset-inline-start: auto; inset-inline-end: 0; justify-content: flex-end; }`,
  `:root[${SIDE_ATTR}=right] aside.app-shell-left-panel :has(> nav[data-app-navigation-rail]) { flex-direction: row-reverse; }`,
  `:root[${SIDE_ATTR}=right] [class*="_PageSurface_"] { inset-inline: 0 var(--app-shell-navigation-rail-width, 0px); }`,
].join('\n');

/** A motion value following `base` through `f` (the app's own class: `new base.constructor`), made once per base and kept current. */
function follower(cache, base, f) {
  let e = cache.get(base);
  if (!e) {
    const mv = new base.constructor(f(base.get()));
    e = { mv, f };
    base.on('change', (v) => e.mv.set(e.f(v)));
    cache.set(base, e);
  }
  if (e.f !== f) { e.f = f; e.mv.set(f(base.get())); }
  return e.mv;
}

/**
 * The frame's host: the mods' regions left and right of the app's column, the shell's context narrowed for it. `nav` is the shell's
 * context (exposure `navigationShell`); `regions` the open ones with their widths; `original` the app's column. Drawn with no region
 * too (the shell's context as it is), so the first region that comes or the last that goes never changes the column's ancestry.
 */
const reports = new WeakMap();
const reportOf = (R, ctx) => { let c = reports.get(ctx); if (!c) reports.set(ctx, (c = createReport(R, ctx))); return c; };
export function FrameHost({ R, nav, ctx, regions: declared, original }) {
  let regions = declared;
  const shell = R.useContext(nav);
  const cache = R.useRef(new WeakMap()).current;
  // the shell's context as the regions' maths need it (the main view's width, a motion value), else no region is drawn and the window
  // says so (`unsupported: 'frame'`): a frame of another shape keeps the app's own arrangement whole
  const fits = typeof shell?.mainContentWidth?.get === 'function' && typeof shell.mainContentWidth.on === 'function';
  R.useEffect(() => { if (fits) hosted.add(ctx); else hosted.delete(ctx); ctx.local?.touch?.(STATE_KEY); return () => { hosted.delete(ctx); }; }, [ctx, fits]);
  const held = spaceHeld(ctx);
  if (!fits || held.regions) regions = [];
  // the sidebar on the right: only with the rail (the frame's rail width), in a frame that fits
  const right = fits && sidebarEdge(ctx) === 'right';
  // the bottom panel beside the chat: a column next to the app's, while the app has the panel open
  const place = bottomPlacement(ctx);
  const beside = fits && place.at !== 'below' && place.open && !held.beside && besideOwner(ctx) !== null ? { key: BOTTOM, edge: place.at, size: place.size, title: 'Bottom panel', bounds: BESIDE } : null;
  const nodeRef = R.useCallback((n) => { setBottomPlacement(ctx, { node: n }); }, [ctx]);
  // what it draws is the window's facts (measured): each change committed goes with the next report
  const drawn = [...regions, ...(beside ? [beside] : [])].map((r) => `${r.key}:${r.edge}:${r.size}`).join('|') + (right ? '|sidebar:right' : '');
  // what is asked of the window (a region opened or closed though held for space, a placement, the edge): the allocator follows it too
  const asked = declaredRegions(ctx).map((r) => `${r.key}:${regionState(ctx, r).open}`).join('|') + `|${place.at}:${place.open}|${sidebarEdge(ctx)}`;
  R.useEffect(() => { ctx.windowChanged?.(); tellWatchers(ctx); }, [drawn, asked, ctx]);
  const wl = regions.filter((r) => r.edge === 'left').reduce((n, r) => n + r.size, 0) + (beside?.edge === 'left' ? beside.size : 0);
  const wr = regions.filter((r) => r.edge === 'right').reduce((n, r) => n + r.size, 0) + (beside?.edge === 'right' ? beside.size : 0);
  // the title bar spans the window (fixed, inset 0): it is shortened over right regions, by a variable its one rule reads
  R.useEffect(() => {
    const d = globalThis.document;
    if (!d?.documentElement?.style) return undefined;
    if (!d.getElementById(SHEET_ID) && d.head) {
      const el = d.createElement('style');
      el.id = SHEET_ID;
      el.textContent = SHEET;
      d.head.appendChild(el);
    }
    // the title bar's right budget: what is at the right of the workspace, and the sidebar's live width while it is there
    const panel = right ? shell?.leftPanelViewportWidth : null;
    const put = () => d.documentElement.style.setProperty('--codexmods-edge-right', `${wr + (panel ? Math.max(0, panel.get()) : 0)}px`);
    put();
    const off = panel && typeof panel.on === 'function' ? panel.on('change', put) : null;
    if (right) d.documentElement.setAttribute(SIDE_ATTR, 'right'); else d.documentElement.removeAttribute(SIDE_ATTR);
    return () => { off?.(); d.documentElement.style.removeProperty('--codexmods-edge-right'); d.documentElement.removeAttribute(SIDE_ATTR); };
  }, [wr, right, shell]);
  const value = R.useMemo(() => {
    const both = wl + wr;
    if ((!both && !right) || !fits) return shell;
    const out = { ...shell };
    // stable per width: a new function only when the widths change, so the followers are recomputed then
    out.mainContentWidth = follower(cache, shell.mainContentWidth, (v) => Math.max(0, v - both));
    if (typeof shell.workspaceTargetWidth?.get === 'function') out.workspaceTargetWidth = follower(cache, shell.workspaceTargetWidth, (v) => Math.max(0, v - both));
    // the title bar's left side: the left regions count as the left panel; with the sidebar on the right they are all of it
    const shift = (v) => (right ? wl : v + wl);
    if ((wl > 0 || right) && typeof shell.leftPanelViewportWidth?.get === 'function') out.leftPanelViewportWidth = follower(cache, shell.leftPanelViewportWidth, shift);
    if ((wl > 0 || right) && shell.sidebarMotion && typeof shell.sidebarMotion.visibleWidth?.get === 'function') {
      out.sidebarMotion = { ...shell.sidebarMotion, closedWidth: right ? wl : (shell.sidebarMotion.closedWidth ?? 0) + wl, visibleWidth: follower(cache, shell.sidebarMotion.visibleWidth, shift) };
    }
    return out;
  }, [shell, wl, wr, cache, fits, right]);
  const aside = (r) => R.createElement('aside', {
    key: r.key, 'data-codexmods-region': r.key, 'data-codexmods-region-edge': r.edge, 'data-pip-obstacle': 'codexmods-region',
    className: 'relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden', style: { width: r.size, paddingTop: 'var(--app-shell-titlebar-height, 0px)' },
  }, ctx.modNode(r.rule, r.render, { key: 'content', region: { key: r.key, edge: r.edge, size: r.size } }), divider(R, ctx, r),
  R.createElement(reportOf(R, ctx), { type: 'Region', subject: { type: 'Mod', provider: 'codexmods.framework', id: r.rule.mod }, place: { in: 'Window', slot: 'regions' } }));
  // the column the bottom panel's frame portals the app's own content into, beside the app's column (inside the mods' regions)
  const column = beside && R.createElement('aside', {
    key: BOTTOM, 'data-codexmods-bottom-beside': beside.edge, 'data-pip-obstacle': 'codexmods-region',
    className: 'relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden', style: { width: beside.size, paddingTop: 'var(--app-shell-titlebar-height, 0px)' },
  }, R.createElement('div', { key: 'content', ref: nodeRef, 'data-app-shell-focus-area': 'bottom-panel', 'data-codexmods-bottom-at': beside.edge, className: 'relative flex h-full min-h-0 w-full flex-col' }),
  divider(R, ctx, { ...beside, set: (size) => setBottomPlacement(ctx, { size }) }));
  return R.createElement(R.Fragment, null,
    ...regions.filter((r) => r.edge === 'left').map(aside),
    ...(column && beside.edge === 'left' ? [column] : []),
    R.createElement(nav.Provider, { key: 'app', value }, original),
    ...(column && beside.edge === 'right' ? [column] : []),
    ...regions.filter((r) => r.edge === 'right').map(aside));
}

/**
 * A region's divider on its inner edge (the bottom panel's column beside too: `region.set`): the app's own (exposure `ResizeDivider`: its pointer maths at the app's zoom, its keys, its
 * indicator), whose drag sets this window's width and, when it ends after a move, keeps it for windows to come. None where the app's
 * divider is not exposed (the region is then sized by Window.setRegion only).
 */
function divider(R, ctx, region) {
  const D = ctx.exports?.()?.ResizeDivider;
  if (typeof D !== 'function') return null;
  return R.createElement(D, {
    key: 'divider', edge: region.edge === 'left' ? 'right' : 'left', ariaLabel: `Resize ${region.title}`,
    defaultSize: region.bounds.default, minimumSize: region.bounds.min, maximumSize: region.bounds.max, currentSize: region.size,
    getCurrentSize: () => (region.set ? bottomPlacement(ctx).size : regionState(ctx, region).size),
    setSize: (size) => { if (region.set) region.set(size); else setRegion(ctx, region.key, { size }); },
    onResizeEnd: (size) => { if (Number.isFinite(size)) keep(region.key, clamp(size, region.bounds)); },
  });
}
