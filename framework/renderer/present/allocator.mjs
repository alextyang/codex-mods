// The window's space (docs/design/layouts.md D12, §5.1 WL4d; scout docs/research/layouts/wl4-workspace.md §3, §5.3): while one of the
// framework's structural arrangements is active in a window (a mod's region open, the bottom panel beside the chat, the sidebar at the
// right), the app's narrow-window handler asks this allocator first (seam responsive) and stands aside, so the app's 960/720 thresholds
// never act on space they do not see. The allocator keeps the main view at least 480 px (more where the app's chat needs more beside its
// side panel: exposure `panelMaths`), budgeting what each part takes now (the sidebar's and the side panel's measured widths, a mod's
// region's and the panel beside's own), and when the window is too narrow it gives up, in this order, the mods' regions, the bottom panel
// beside (drawn below meanwhile), the side panel (the app's own close for the window's size, which remembers it: exposure `responsive`),
// then the sidebar (its core setter, never the "by hand" one); it gives each back, in reverse, once everything it gives back fits with a
// margin (never a loop), each counted at the width it had. What the user changes meanwhile is theirs: a side panel they open or close by
// hand (the app's memory of it cleared) and a sidebar they open are not touched again. With no arrangement of the framework's left (or the
// page going), everything it holds is given back, every chat's panel included, and the app's own handler takes over. It owns nothing
// without the app's setters and figures (a build without them keeps the app's thresholds). The app calls the handler for every column it
// keeps mounted, those out of sight too: only the shown one's question shares the window out (a hidden column's panel is not what the
// window draws); a hidden one is only told the framework owns the window. What it holds is said in the window's facts (`suspended`). NO NODE API.

import { declaredRegions, regionState, bottomPlacement, sidebarEdge, spaceHeld, holdForSpace, onArrangement, shownColumn } from './bindings/frame-regions.mjs';

const MAIN_MIN = 480;   // the main view's floor (D12)
const MARGIN = 40;      // what it must fit with before anything comes back
const ORDER = ['regions', 'beside', 'side', 'sidebar'];

/**
 * @param {{ ctx: object, exports: () => object, around?: (fn: () => unknown) => unknown, arranged?: () => boolean, back?: () => void, dom?: { sidebarOpen(): boolean | null, railWidth(): number, sidebarWidth(): number, sideWidth(): number } }} o
 *   `around`: its acts told apart from anyone else's (a held layout's origins, D11); `arranged`: an arrangement of a layout's it cannot see in the frame (its sizes); `back`: it gave something back
 */
export function createAllocator(o) {
  const ctx = o.ctx;
  const ex = () => { try { return o.exports() ?? {}; } catch { return {}; } };
  // a chat by its route (the handler's scope object is not the same from one call to the next): its conversation, else its path
  const chatOf = (scope) => (typeof scope?.value?.conversationId === 'string' && scope.value.conversationId) || (typeof scope?.value?.pathname === 'string' && scope.value.pathname) || scope;
  const closedSides = new Map();   // a chat whose side panel it closed -> { scope: the latest scope of it, width: the panel's }
  const userSides = new Set();     // the chats whose side panel the user opened or closed since: theirs (D11)
  let userSidebar = false;         // the user opened the sidebar it had closed: theirs until the arrangement ends
  let last = null;                 // { width, scope }: the latest the handler said
  const shown = (sel) => [...(globalThis.document?.querySelectorAll?.(sel) ?? [])].find((n) => (typeof n.checkVisibility === 'function' ? n.checkVisibility() : true)) ?? null;
  const dom = o.dom ?? {
    // the side panel's share for a chat: its frame's ratio motion value (side.panel.frame, the chat's mount)
    sideRatio(chat) {
      const m = (typeof ctx.mountsOf === 'function' ? ctx.mountsOf('side.panel.frame') : []).find((x) => (x?.scopeNode?.value?.conversationId ?? x?.scopeNode?.value?.pathname) === chat);
      const v = m?.props?.contentPaneWidthRatio?.get?.();
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
    },
    sidebarOpen() { const v = globalThis.document?.querySelector?.('[data-app-shell-frame]')?.getAttribute('data-app-shell-sidebar-open'); return v === 'true' ? true : v === 'false' ? false : null; },
    railWidth() { return globalThis.document?.querySelector?.('nav[data-app-navigation-rail]')?.offsetWidth ?? 0; },
    sidebarWidth() { return globalThis.document?.querySelector?.('aside.app-shell-left-panel')?.offsetWidth ?? 0; },
    sideWidth() { return shown('aside[data-app-shell-focus-area="right-panel"]')?.offsetWidth ?? 0; },
  };

  /** The app's setters and figures it works with (else it owns nothing: the app's thresholds stay). */
  function ready() {
    const r = ex().responsive, maths = ex().panelMaths;
    return !!r && ['closeSide', 'restoreSide', 'setSidebar'].every((k) => typeof r[k] === 'function') && r.sideOpen !== undefined && r.remembered !== undefined
      && r.sidebarOpen !== undefined && typeof maths?.bounds === 'function';
  }
  /** Is one of the framework's arrangements active in this window? */
  function arranged() {
    const place = bottomPlacement(ctx);
    return declaredRegions(ctx).some((r) => regionState(ctx, r).open) || (place.at !== 'below' && place.open && shownColumn(ctx) !== null) || sidebarEdge(ctx) === 'right' || o.arranged?.() === true;
  }
  /** What takes the window's width now (each part's width, whether it is there), and the floor. */
  function measure(scope) {
    const r = ex().responsive, maths = ex().panelMaths;
    const rail = dom.railWidth();
    let open;
    try { open = scope.get(r.sidebarOpen) === true; } catch { open = dom.sidebarOpen() === true; }
    let sideOpen = false;
    try { sideOpen = !!scope.get(r.sideOpen); } catch { /* no panel here */ }
    const place = bottomPlacement(ctx);
    const held = spaceHeld(ctx);
    // a tab filling the workspace is the main view, no chat beside it: it takes no width of its own and is not there to give up
    let filling = false;
    try { const mode = ex().workspaceState?.mode; filling = sideOpen && mode !== undefined && scope.get(mode) === 'full'; } catch { /* beside the chat */ }
    let floor = 320, chat = 352;
    try { chat = 1000 - maths.bounds(1000, 'regular').maximum; floor = maths.bounds(1000, 'regular').minimum; } catch { /* the figures above */ }
    // the sidebar's width beyond the rail: the app's own width atom (the whole box, the rail in it), also while it is held or just reopened
    // (the page's box lags the atom), and what is drawn when that is more (a route's own width)
    let kept = 0;
    try { kept = Number(scope.get(ex().windowRegions?.sidebarWidth)); } catch { /* what is drawn */ }
    const sidebarWide = Math.max(Number.isFinite(kept) ? kept - rail : 0, open ? dom.sidebarWidth() - rail : 0, 0);
    // the side panel is a share of the main view (the app's ratio between its bounds at that width: exposure `panelMaths`): with it, the
    // main view needs the least width at which the chat beside it keeps the floor; held, the share it had
    const sideNow = sideOpen ? Math.max(floor, dom.sideWidth()) : 0;
    let ratio = sideOpen ? dom.sideRatio?.(chatOf(scope)) : closedSides.get(chatOf(scope))?.ratio;
    if (!Number.isFinite(ratio)) ratio = null;
    const mainMin = Math.max(MAIN_MIN, chat);
    const withSide = (() => {
      if (ratio === null) return mainMin + (sideOpen ? sideNow : closedSides.get(chatOf(scope))?.width ?? floor);
      const panelAt = (w) => { const b = maths.bounds(w, 'regular'); return b.minimum + ratio * (b.maximum - b.minimum); };
      // a share that leaves the chat under the floor at any width (the panel near its maximum) is the user's: the app's own chat
      // minimum holds for it, never the panel's floor alone
      const least = (min) => {
        let lo = min, hi = 20000;
        if (hi - panelAt(hi) < min) return null;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (mid - panelAt(mid) >= min) hi = mid; else lo = mid; }
        return hi;
      };
      return least(mainMin) ?? least(chat) ?? mainMin + floor;
    })();
    return {
      widths: {
        regions: declaredRegions(ctx).filter((x) => regionState(ctx, x).open).reduce((n, x) => n + regionState(ctx, x).size, 0),
        beside: place.at !== 'below' && place.open && shownColumn(ctx) !== null ? place.size : 0,
        side: filling ? 0 : Math.max(0, withSide - mainMin),
        sidebar: sidebarWide,
      },
      ratio,
      // which are there now (held ones are not)
      there: { regions: !held.regions, beside: !held.beside, side: sideOpen, sidebar: open },
      held: { ...held, side: closedSides.has(chatOf(scope)) },
      sideNow,
      base: rail + mainMin,
    };
  }
  /** Hold one part for space (or give it back), through the app's own setters for the side panel and the sidebar. */
  function act(step, on, scope, width = 0, ratio = null) { return (o.around ?? ((fn) => fn()))(() => acted(step, on, scope, width, ratio)); }
  function acted(step, on, scope, width, ratio) {
    const r = ex().responsive;
    if (step === 'side') {
      try {
        const chat = chatOf(scope);
        if (on) { if (!scope.get(r.sideOpen)) return false; r.closeSide(scope); closedSides.set(chat, { scope, width, ratio }); }
        else { if (closedSides.has(chat) && scope.get(r.remembered) != null) r.restoreSide(scope); closedSides.delete(chat); }
      } catch { return false; }
      holdForSpace(ctx, 'side', closedSides.size > 0);
      return true;
    }
    if (step === 'sidebar') {
      try { r.setSidebar(scope, !on); } catch { return false; }
      holdForSpace(ctx, 'sidebar', on);
      return true;
    }
    holdForSpace(ctx, step, on);
    return true;
  }
  /** Share the window's width out: give up in order while it does not fit, give back in reverse while all it gives back fits with the margin. */
  function allocate(width, scope) {
    const r = ex().responsive;
    const m = measure(scope);
    const held = m.held;
    // what the user changed meanwhile is theirs: the sidebar they opened, the side panel whose memory the app cleared (their own close or open)
    if (held.sidebar && m.there.sidebar) { holdForSpace(ctx, 'sidebar', false); held.sidebar = false; userSidebar = true; }
    if (held.side) { try { if (scope.get(r.remembered) == null) { closedSides.delete(chatOf(scope)); userSides.add(chatOf(scope)); holdForSpace(ctx, 'side', closedSides.size > 0); held.side = false; } } catch { /* as it was */ } }
    if (closedSides.has(chatOf(scope))) closedSides.get(chatOf(scope)).scope = scope;   // its latest scope, for a later give-back
    const there = { ...m.there };
    const used = () => m.base + ORDER.reduce((n, s) => n + (there[s] ? m.widths[s] : 0), 0);
    for (const s of ORDER) {
      if (used() <= width) break;
      const mine = s === 'side' ? !userSides.has(chatOf(scope)) : s === 'sidebar' ? !userSidebar : true;
      if (!held[s] && there[s] && m.widths[s] > 0 && mine && act(s, true, scope, s === 'side' ? m.sideNow : 0, m.ratio)) { held[s] = true; there[s] = false; }
    }
    let back = false;
    for (const s of [...ORDER].reverse()) {
      if (!held[s]) continue;
      if (used() + m.widths[s] > width - MARGIN) break;
      if (act(s, false, scope)) { held[s] = false; there[s] = true; back = true; }
    }
    if (back) o.back?.();
  }
  /** Everything it holds given back: every chat's side panel it closed, the sidebar (unless the user opened it), the regions, the panel beside. */
  function release(scope) {
    const r = ex().responsive;
    for (const { scope: s } of [...closedSides.values()]) act('side', false, s);
    const at = scope ?? last?.scope;
    if (spaceHeld(ctx).sidebar) {
      let open = false;
      try { open = at?.get?.(r.sidebarOpen) === true; } catch { /* closed as far as it knows */ }
      if (open || !at) holdForSpace(ctx, 'sidebar', false); else act('sidebar', false, at);
    }
    for (const s of ['beside', 'regions']) if (spaceHeld(ctx)[s]) act(s, false, scope);
    userSidebar = false;
    userSides.clear();
  }
  /** The handler's question: true while the framework owns the window's arrangement. */
  function handle(width, scope) {
    if (!Number.isFinite(width) || !scope || typeof scope.get !== 'function') return undefined;
    if (!ready()) return undefined;
    // another column is what the window shows: the framework owns the window, but this is not it
    const showing = shownColumn(ctx);
    if (showing && showing.key !== chatOf(scope)) return arranged() ? true : undefined;
    last = { width, scope };
    if (!arranged()) {
      const h = spaceHeld(ctx);
      if (h.regions || h.beside || h.side || h.sidebar || closedSides.size) release(scope);
      return undefined;
    }
    allocate(width, scope);
    return true;
  }
  // the arrangement changed (a region came, the panel went beside): share the width out again, as the handler last said it
  onArrangement(ctx, () => { if (last) handle(last.width, shownColumn(ctx)?.scope ?? last.scope); });
  return {
    handle, release, dispose: () => { try { if (ready()) release(last?.scope ?? null); } catch { /* the page went first */ } }, get last() { return last; },
    /** A layout's sizes came or went: share the width out again. */
    rearranged() { if (last) handle(last.width, shownColumn(ctx)?.scope ?? last.scope); },
    // what it holds, for a layout that asks of the same panels (D12): one it wants open waits for it to come back; one it wants closed is the layout's from then on, its memory not the user's
    sideHeld: (scope) => closedSides.has(chatOf(scope)),
    // the app's close leaves its memory of the panel on a panel already closed: it is brought back first (in the same task, for the caller to close), or the app's own restore would reopen it later
    takeSide(scope) {
      const r = ex().responsive;
      (o.around ?? ((fn) => fn()))(() => { try { if (scope.get(r.remembered) != null) r.restoreSide(scope); } catch { /* no memory to clear */ } });
      closedSides.delete(chatOf(scope));
      holdForSpace(ctx, 'side', closedSides.size > 0);
    },
    sidebarHeld: () => spaceHeld(ctx).sidebar,
    takeSidebar() { holdForSpace(ctx, 'sidebar', false); },
  };
}
