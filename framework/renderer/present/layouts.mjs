// The window's named layouts (docs/design/layouts.md D5, D6, D11, §5.3; scout docs/research/layouts/wl6-layouts.md): `ui.layouts.add` declares one;
// picking it is one claim per window, made of the app's own guarded setters, kept as the user moves between chats. A chat's panels are its own: the
// app restores them from the chat's checkpoint when it first mounts, so a held layout applies to a chat once that restore is done and the chat is
// the one shown, and journals what it writes and what was there before it to give back. Every change to a region the layout holds is told by its origin (D11):
// - the framework's own acts and the window's space rule run in a bracket (`around`), the app's resize handler and its handling of a mod's panel message are marked while they run: not a change of anyone's;
// - the app's restore says so in its source atom: followed by the layout applied again;
// - the user's: the app's layout counter moved (every source but its restore moves it), or an input came just before: a trusted pointer, a drag or a key, a
//   command, one of the app's panel messages from its native menu; or, for a size (a divider's drag writes no flag), the size is not what the layout set when an input on a divider ends.
//   It releases the region: the layout stays picked, the region is theirs, the Window says so;
// - anything else is the app's own (a preview it opens, the last tab closing): neither released nor fought.
// A wrong "user" costs one released region, and picking the layout again takes it back; a wrong "app" would make a layout fight the user.
// A panel held for space (D12) is not reopened by a layout: its intent waits, and the layout goes on when the allocator gives it back.
// The layout ends when the user picks another or the app's own, or its mod goes: each thing it wrote and the user has not released goes back as it was.
// The claim, its journal with it, goes on across a reload of its window (the page's session storage): the page takes it up once its mod and the app's chunks are here, and a window's
// default layout never goes first. A chat the app has let go of keeps what it had: its checkpoint says so. `keep: 'once'` arranges the window and releases everything at once. NO NODE API.
import { declaredRegions, regionState, setRegion, putRegionBack, moveSidebar, sidebarEdge, bottomPlacement, setBottomPlacement, shownColumn, onArrangement } from './bindings/frame-regions.mjs';

export const LAYOUT_CONTEXT = 'local:window.context';
const INPUT_MS = 400;   // how long after an input a change is taken for the user's
const PENDING_MS = 15000;   // how long a layout picked before a reload waits for its mod
const RETRY_MS = 250;
const SIZE_TRIES = 40;   // a size asked of a panel just opened waits for its frame to be drawn (a mount is a frame or two away, a lazy one more)
const SIZE_EVERY_MS = 50;
const JOURNAL = 'codexmods:layout-claim';   // the page's session storage: this window's, kept across its reloads
// a panel's size: its frame's operations, what it reads as and how much of a difference is someone else's (the share is a ratio)
const SIZES = Object.freeze({
  side: { binding: 'side.panel.frame', set: 'resize', now: 'shareNow', put: 'putShare', field: 'share', slack: 0.002 },
  bottom: { binding: 'bottom.panel.frame', set: 'bottomHeight', now: 'heightNow', put: 'bottomHeight', field: 'height', slack: 1 },
});
const PANEL_MESSAGES = new Set(['toggle-sidebar', 'toggle-diff-panel', 'toggle-bottom-panel', 'toggle-terminal', 'run-command']);
const editable = (t) => !!t && (t.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const session = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };
/** Where a mod comes in the user's order (a rule's order is its mod's rank, then its own priority). */
const rankOf = (rule) => (Number.isFinite(rule?.order) ? Math.floor(rule.order / 1e6) : Infinity);

/**
 * @param {{ ctx: object, exports: () => object, log?: (m: string, d?: object) => void, panelOp?: (binding: string, op: string, args: unknown[], node: object) => unknown,
 *   openTab?: (node: object, kind: string, target: 'right' | 'bottom') => true | { unavailable: string } | { id: string, opened: boolean, was: string | null },
 *   giveTab?: (node: object, tab: { target: 'right' | 'bottom', id: string, opened: boolean, was: string | null, instance?: string }) => void, frontTab?: (node: object, target: 'right' | 'bottom') => string | null, ruleOf?: (mod: string) => object | undefined, openPage?: (key: string) => boolean,
 *   space?: { sideHeld(node: object): boolean, takeSide(node: object): void, sidebarHeld(): boolean, takeSidebar(): void }, changed?: () => void, now?: () => number }} o
 *   `panelOp`: a binding's operation on the mount that holds this scope; `openTab`: that kind's tab at the front of its panel, opened only when there is none; `giveTab`: one so put, put back;
 *   `space`: what the allocator holds for space (D12); `changed`: what the window says or a where reads moved
 */
export function createLayouts(o) {
  const { ctx } = o;
  const now = o.now ?? (() => Date.now());
  const ex = () => { try { return o.exports() ?? {}; } catch { return {}; } };
  let claim = null;        // { key, rule, spec, released: Set, before: Map chat -> what it had, wrote: Map chat -> what was written, window: what the window had and what was written, applied: Map chat -> its node, dirty: Set chat, partial: Map region -> why, sized }
  let acting = 0;          // inside the framework's own act (no origin to tell)
  let resizing = false;    // the app's narrow-window handler is running
  let lastInput = -Infinity;
  let ownMessage = false;  // the app is handling a panel message of a mod's or the framework's (it moves the app's counter as the user's would)
  let onDivider = false;   // the pointer went down on a divider
  const chats = new Map(); // a chat's key -> { node, stop, last }
  let modeShown = null;    // the effective mode of the chat shown
  let disposed = false;
  let pending = null;      // a layout this window held before a reload, before its mod has started here: { key, from: its journal, until }

  const canWork = () => { const x = ex(); return !!x.responsive && !!x.workspaceLayout && !!x.workspaceState && !!x.windowRegions; };
  const declared = () => (typeof ctx.declared === 'function' ? ctx.declared('Window', 'layouts') : []).map((r) => {
    const l = r.data?.layout;
    return l && typeof l.title === 'string' ? { key: `${r.mod}/${r.id}`, mod: r.mod, id: r.id, title: l.title, spec: l, rule: r } : null;
  }).filter(Boolean);

  const around = (fn) => { acting++; try { return fn(); } finally { acting--; } };
  const say = () => { ctx.local?.touch?.(LAYOUT_CONTEXT); ctx.windowChanged?.(); o.changed?.(); };
  const held = (region) => !!claim && !claim.released.has(region);
  /** A mod behind the holder's in the user's order does not take the window from it. The refusal, or null. */
  const behind = (by) => {
    if (!by || !claim || claim.rule.mod === by) return null;
    const rule = o.ruleOf?.(by) ?? declared().find((d) => d.mod === by)?.rule;
    return rankOf(rule) > rankOf(claim.rule) ? { unavailable: `the layout ${claim.key} holds this window, and its mod comes first in the user's order` } : null;
  };
  /** A claim as plain data: what the page's session storage keeps, what it can go on from. */
  const plainOf = (c) => JSON.parse(JSON.stringify({ key: c.key, released: [...c.released], before: [...c.before], wrote: [...c.wrote], window: c.window ? { ...c.window, regions: [...c.window.regions] } : null, opened: c.opened }));
  function journal() {
    const c = claim;
    if (!c) return;
    try { session()?.setItem?.(JOURNAL, JSON.stringify(plainOf(c))); } catch { /* the page's storage is unavailable: it ends with the page */ }
  }
  const forget = () => { try { session()?.removeItem?.(JOURNAL); } catch { /* as above */ } };
  function journaled() {
    try { const j = JSON.parse(session()?.getItem?.(JOURNAL) ?? 'null'); return j && typeof j.key === 'string' ? j : null; } catch { return null; }
  }

  /** What it asks of a chat's own panels (never a region released): the regions, in the order they are set. */
  function chatRegions(spec) {
    return [...(spec.side ? ['side'] : []), ...(spec.bottom ? ['bottom'] : []), ...(spec.main === 'chat' || spec.main === 'tab' ? ['main'] : [])];
  }

  const isReady = (node, key) => {
    const ws = ex().workspaceState;
    try { return node.get(ws.ready) === true && (typeof node.value?.conversationId !== 'string' || node.get(ws.restored) === key); } catch { return false; }
  };
  const read = (node, atom) => { try { return atom === undefined ? undefined : node.get(atom); } catch { return undefined; } };

  /** A chat's panels as they are, to give back (one the allocator holds for space was open). */
  function snapshot(node) {
    const x = ex(), r = x.responsive, ws = x.workspaceState;
    return { side: read(node, r.sideOpen) === true || o.space?.sideHeld?.(node) === true, bottom: read(node, ws.bottomOpen) === true, mode: read(node, ws.mode) ?? null, preference: read(node, x.workspaceLayout?.preference) ?? null };
  }
  const sizeNow = (region, node) => { const s = SIZES[region]; try { const v = o.panelOp?.(s.binding, s.now, [], node); return Number.isFinite(v) ? v : null; } catch { return null; } };

  /**
   * A size asked of a panel: its frame's own operation, once the frame is drawn (it has just opened), what it was kept first; it settles when that is done; out of its bounds it says
   * so. `sink` is who asks (a claim on one chat, a mode's parameters): `live` is asked before each try: released, or a scope gone, it never writes.
   */
  function sizeWhenDrawn(region, px, node, sink) {
    const s = SIZES[region];
    let tries = 0;
    const closed = (why) => typeof why === 'string' && /is closed|not drawn|cannot be/.test(why);
    const attempt = () => {
      if (disposed || !sink.live(region, node)) { sink.finish(); return; }
      if (sink.before && sink.before[s.field] === undefined) { const was = sizeNow(region, node); if (was !== null) sink.before[s.field] = was; }
      const out = around(() => { try { return o.panelOp?.(s.binding, s.set, [px], node); } catch (e) { return { unavailable: String(e?.message ?? e) }; } });
      if (out && out !== true && closed(out.unavailable) && ++tries < SIZE_TRIES) { const t = setTimeout(attempt, SIZE_EVERY_MS); t?.unref?.(); return; }
      if (out && out !== true) sink.why(region, out.unavailable ?? 'its size was not set');
      else { sink.wrote[`${region}Size`] = true; sink.sized?.(region, sizeNow(region, node)); }
      sink.finish();
    };
    sink.start();
    attempt();
  }

  /** One region of a chat, as asked, through the app's guarded setters; what is not as asked says why (partial). `sink.wrote` journals what is written. */
  function setChatRegion(region, spec, node, sink) {
    const x = ex(), wl = x.workspaceLayout;
    const panelsOf = () => ({ side: read(node, x.responsive.sideOpen) === true, bottom: read(node, x.workspaceState.bottomOpen) === true, mode: read(node, x.workspaceState.mode) });
    const side = (open) => { wl.setPanel(node, open, { animate: false }); sink.wrote.side = true; };
    // a tab of a mod's own view, or of one of the app's kinds; another mod's view is not this mod's to open
    const tabOf = (want, target) => {
      if (typeof want.tab !== 'string') return null;
      if (want.tab.includes('/') && want.tab.slice(0, want.tab.indexOf('/')) !== sink.mod) return `the view ${want.tab} is another mod's`;
      const t = o.openTab?.(node, want.tab, target);
      if (t && t !== true && t.unavailable) return t.unavailable;
      if (t && t.id && !(sink.wrote.tabs ?? []).some((e) => e.id === t.id)) sink.wrote.tabs = [...(sink.wrote.tabs ?? []), { target, id: t.id, opened: t.opened === true, was: t.was ?? null, ...(t.instance ? { instance: t.instance } : {}) }];
      return null;
    };
    if (region === 'side') {
      const want = spec.side;
      const why = tabOf(want, 'right');
      if (why) return why;
      if (typeof want.open === 'boolean') {
        // held for space (D12): open waits for the allocator to give it back; closed, it is the layout's now
        if (o.space?.sideHeld?.(node)) {
          if (want.open) { sink.suspended?.(); return null; }
          o.space.takeSide(node);
        }
        side(want.open);
      }
      if (want.size !== undefined && want.open !== false) sizeWhenDrawn('side', want.size, node, sink);
      return typeof want.open === 'boolean' && panelsOf().side !== want.open ? (want.open ? 'the side panel did not open' : 'the side panel did not close') : null;
    }
    if (region === 'bottom') {
      const want = spec.bottom;
      const why = tabOf(want, 'bottom');
      if (why) return why;
      if (typeof want.open === 'boolean') { x.windowRegions.setBottom(node, want.open, { animate: false }); sink.wrote.bottom = true; }
      if (want.height !== undefined && want.open !== false) sizeWhenDrawn('bottom', want.height, node, sink);
      return typeof want.open === 'boolean' && panelsOf().bottom !== want.open ? 'this chat has no bottom panel' : null;
    }
    // the main region: the chat alone, or the side panel's tab filling the workspace, through the app's guarded setters (full last: it needs the tab)
    if (spec.main === 'tab') {
      if (o.space?.sideHeld?.(node)) { sink.suspended?.(); return null; }
      sink.wrote.main = true;
      wl.setPanel(node, true, { animate: false });
      if (read(node, wl.activeTab) == null) return 'there is no tab to fill the workspace';
      wl.setFull(node, true, { animate: false });
      return panelsOf().mode === 'full' ? null : 'its tab does not fill the workspace';
    }
    sink.wrote.main = true;
    wl.setFull(node, false, { animate: false });
    // the chat alone: no split left beside it, unless its side panel is asked for too
    if (spec.side?.open === true) return null;
    if (o.space?.sideHeld?.(node)) o.space.takeSide(node);
    wl.setPanel(node, false, { animate: false });
    return panelsOf().side ? 'the chat is not alone' : null;
  }

  /**
   * What was written on a chat, put back where its owner has not let it go (the size before the panel closes: its frame goes with it). A panel closed stays closed under the
   * full-width preference it had: only setting it says otherwise, and closing never touches it, so it is set first. One the allocator holds for space comes back with the space.
   */
  function restoreChat(node, b, w, free) {
    const x = ex(), wl = x.workspaceLayout;
    try {
      const main = w.main && free('main');
      const wantFull = b.side ? b.mode === 'full' : b.preference === 'full';
      if (main && (!b.side || !wantFull)) wl.setFull(node, wantFull, { animate: false });
      for (const tab of [...(w.tabs ?? [])].reverse()) if (free(tab.target === 'bottom' ? 'bottom' : 'side')) o.giveTab?.(node, tab);
      if (w.sideSize && free('side') && Number.isFinite(b.share)) o.panelOp?.(SIZES.side.binding, SIZES.side.put, [b.share], node);
      if ((w.side && free('side')) || main) {
        const heldForSpace = o.space?.sideHeld?.(node) === true;
        if (!(heldForSpace && b.side)) {
          if (heldForSpace) o.space.takeSide(node);
          wl.setPanel(node, b.side, { animate: false });
        }
      }
      if (w.bottomSize && free('bottom') && Number.isFinite(b.height)) o.panelOp?.(SIZES.bottom.binding, SIZES.bottom.put, [b.height], node);
      if (w.bottom && free('bottom')) x.windowRegions.setBottom(node, b.bottom, { animate: false });
      if (main && b.side && wantFull) wl.setFull(node, true, { animate: false });
    } catch { /* a chat the app has let go of: nothing to give back */ }
  }
  /** What was written on the window, put back. */
  function restoreWindow(w, free) {
    const x = ex(), node = anyNode();
    if (free('sidebar')) {
      try {
        // held for space: it comes back with the space; to stay closed, it is the layout's to close
        const heldForSpace = o.space?.sidebarHeld?.() === true;
        if (w.wrote.sidebar && typeof w.sidebar === 'boolean' && node && !(heldForSpace && w.sidebar)) {
          if (heldForSpace) o.space.takeSidebar();
          x.responsive.setSidebar(node, w.sidebar, { animate: false });
        }
      } catch { /* as it is */ }
      if (w.wrote.edge && w.edge !== sidebarEdge(ctx)) moveSidebar(ctx, w.edge);
    }
    if (w.wrote.at && free('bottom')) setBottomPlacement(ctx, { at: w.at });
    for (const [key, st] of w.regions ?? []) if (free(key)) putRegionBack(ctx, key, { open: st.open, size: st.size });
  }

  /** The sidebar asked of the window, the allocator's hold respected (D12). */
  function sidebarTo(open, node, wrote) {
    if (o.space?.sidebarHeld?.()) {
      if (open) return false;   // held for space: it comes back with the space
      o.space.takeSidebar();
    }
    ex().responsive.setSidebar(node, open, { animate: false });
    wrote.sidebar = true;
    return true;
  }
  const windowBefore = (node) => ({ sidebar: node ? read(node, ex().responsive.sidebarOpen) === true || o.space?.sidebarHeld?.() === true : null, edge: sidebarEdge(ctx), at: bottomPlacement(ctx).at, regions: new Map(), wrote: {} });

  /** The window's own regions, once per page: the sidebar, the mods' regions (only its own mod's), the bottom panel's place. What they were is kept for the claim's life. */
  function applyWindow() {
    const c = claim, s = c.spec;
    if (c.windowDone) return;
    const node = anyNode();
    // the sidebar is set through a scope, and a page just loaded has none yet: all of it waits for one
    if (s.sidebar && typeof s.sidebar.open === 'boolean' && !node) { if (++c.noScope < SIZE_TRIES) { const t = setTimeout(() => { if (claim === c && !disposed) apply(); }, RETRY_MS); t?.unref?.(); } else c.partial.set('sidebar', 'the window has no sidebar yet'); return; }
    c.windowDone = true;
    c.window ??= windowBefore(node);
    const w = c.window;
    around(() => {
      if (s.sidebar && held('sidebar')) {
        if (typeof s.sidebar.open === 'boolean') sidebarTo(s.sidebar.open, node, w.wrote);
        if (s.sidebar.edge) { const out = moveSidebar(ctx, s.sidebar.edge); if (out !== true) c.partial.set('sidebar', out?.unavailable ?? 'its edge was not set'); else w.wrote.edge = true; }
      }
      if (s.bottom?.at && held('bottom')) { setBottomPlacement(ctx, { at: s.bottom.at }); w.wrote.at = true; }
      for (const [id, want] of Object.entries(s.regions ?? {})) {
        const key = regionKey(c, id);
        if (key.slice(0, key.indexOf('/')) !== c.rule.mod) { c.partial.set(key, 'that region is another mod\'s'); continue; }
        const region = declaredRegions(ctx).find((r) => r.key === key);
        if (!region) { c.partial.set(key, 'that region is not declared in this window'); continue; }
        if (!held(key)) continue;
        const st = regionState(ctx, region);
        if (!w.regions.has(key)) w.regions.set(key, { open: st.open, size: st.size });
        setRegion(ctx, key, want);
        if (Number.isFinite(want.size)) c.regionSizes.set(key, regionState(ctx, region).size);
      }
    });
  }
  const regionKey = (c, id) => (id.includes('/') ? id : `${c.rule.mod}/${id}`);

  function anyNode() {
    for (const c of chats.values()) if (c.node) return c.node;
    return typeof ctx.anyScopeNode === 'function' ? ctx.anyScopeNode() : null;
  }

  /** Who asks of a chat's panels for a claim: what it writes journaled under that chat. */
  function sinkOf(c, key) {
    if (!c.wrote.has(key)) c.wrote.set(key, {});
    return {
      mod: c.rule.mod, wrote: c.wrote.get(key), before: c.before.get(key),
      live: (region, node) => claim === c && held(region) && chats.get(key)?.node === node,
      start() { c.waiting++; },
      finish() { c.waiting--; journal(); say(); },
      why(region, why) { c.partial.set(region, why); },
      sized(region, v) { if (v !== null) { if (!c.sized.has(key)) c.sized.set(key, {}); c.sized.get(key)[region] = v; } },
      suspended() { c.dirty.add(key); },
    };
  }

  /** A chat's own panels, when the layout holds them and its restore is done; again when its scope is a new one, or the app has restored it, or the space for it has come back. */
  function applyChat(key, node) {
    const c = claim;
    if (!c || !node || !canWork() || !isReady(node, key)) return false;
    if (c.applied.get(key) === node && !c.dirty.has(key)) return false;
    if (c.spec.keep === 'once' && c.applied.size > 0) return false;
    c.dirty.delete(key);
    c.applied.set(key, node);
    if (!c.before.has(key)) c.before.set(key, snapshot(node));
    const sink = sinkOf(c, key);
    around(() => {
      for (const region of chatRegions(c.spec)) {
        if (!held(region)) continue;
        c.partial.delete(region);
        let why;
        try { why = setChatRegion(region, c.spec, node, sink); } catch (e) { why = String(e?.message ?? e); }
        if (why) c.partial.set(region, why);
      }
    });
    return true;
  }

  /** What the layout holds applied here: the window's regions and the chat shown; then told. */
  function apply() {
    const c = claim;
    if (!c || !canWork()) return;
    const shown = shownColumn(ctx);
    if (shown) watchChat(shown.key, shown.scope);
    applyWindow();
    if (shown) applyChat(shown.key, shown.scope);
    if (c.spec.main && typeof c.spec.main === 'object' && !c.opened) { c.opened = true; if (!o.openPage?.(`${c.rule.mod}/${c.spec.main.page}`)) c.partial.set('main', 'its page cannot be opened'); }
    // nothing is held after a once: the window is arranged, and it is all the user's
    if (c.spec.keep === 'once' && c.applied.size > 0) for (const r of everyRegion(c)) c.released.add(r);
    c.settled = !!c.windowDone && (!shown || c.applied.has(shown.key) || c.spec.keep === 'once');
    journal();
    say();
  }

  // the main region's chat or tab is the side panel's too: it is held as the panel it opens or closes
  const everyRegion = (c) => { const s = c.spec; return [...(s.sidebar ? ['sidebar'] : []), ...(s.side || s.main === 'tab' || s.main === 'chat' ? ['side'] : []), ...(s.bottom ? ['bottom'] : []), ...(s.main ? ['main'] : []), ...Object.keys(s.regions ?? {}).map((id) => regionKey(c, id))]; };
  /** Did the claim write on that region, whatever it declares now (a mod's new version, across a reload)? It is still the claim's to give back, and the user's to take. */
  const wroteOn = (c, region) => {
    const w = c.window?.wrote ?? {};
    if (region === 'sidebar') return !!(w.sidebar || w.edge);
    if (c.window?.regions.has(region)) return true;
    if (region === 'bottom' && w.at) return true;
    return [...c.wrote.values()].some((x) => (region === 'side' && (x.side || x.sideSize || x.main || x.tabs?.some((tab) => tab.target !== 'bottom')))
      || (region === 'bottom' && (x.bottom || x.bottomSize || x.tabs?.some((tab) => tab.target === 'bottom'))) || (region === 'main' && x.main));
  };

  function release(region) {
    const c = claim;
    if (!c || c.released.has(region) || !(everyRegion(c).includes(region) || wroteOn(c, region))) return;
    c.released.add(region);
    c.partial.delete(region);
    journal();
    say();
  }
  /** An input on a divider has ended: a size the layout or a mode's parameters set that is not what they set now was the user's (a drag moves no flag). */
  function checkSizes() {
    const c = claim, shown = shownColumn(ctx), h = modeHeld;
    const set = shown && c ? c.sized.get(shown.key) : null;
    for (const region of ['side', 'bottom']) {
      if (shown && set?.[region] !== undefined && held(region)) {
        const v = sizeNow(region, shown.scope);
        if (v !== null && Math.abs(v - set[region]) > SIZES[region].slack) release(region);
      }
      if (shown && h && h.key === shown.key && h.sized[region] !== undefined && h.free(region)) {
        const v = sizeNow(region, shown.scope);
        if (v !== null && Math.abs(v - h.sized[region]) > SIZES[region].slack) modeReleased.add(`${h.mode}:${region}`);
      }
    }
    if (!c) return;
    for (const [key, size] of c.regionSizes) {
      const region = declaredRegions(ctx).find((r) => r.key === key);
      if (region && held(key) && regionState(ctx, region).size !== size) release(key);
    }
  }
  /** The user is working in a tab the layout opened: it is theirs, and stays when the layout ends. */
  function adoptTab(el) {
    const c = claim;
    const area = c ? el?.closest?.('[data-app-shell-focus-area="right-panel"],[data-app-shell-focus-area="bottom-panel"]') : null;
    if (!area) return;
    const shown = shownColumn(ctx);
    const target = area.getAttribute?.('data-app-shell-focus-area') === 'bottom-panel' ? 'bottom' : 'right';
    const front = shown ? o.frontTab?.(shown.scope, target) : null;
    const tab = front ? (c.wrote.get(shown.key)?.tabs ?? []).find((x) => x.target === target && x.id === front && x.opened) : null;
    if (tab) { tab.opened = false; tab.was = null; journal(); }
  }

  /** A chat's layout atoms watched from here on (one per chat: its scope node comes and goes with its mounts). */
  function watchChat(key, node) {
    const had = chats.get(key);
    if (had?.node === node) return;
    if (had?.stop) { try { had.stop(); } catch { /* gone */ } }
    const x = ex(), r = x.responsive, ws = x.workspaceState, ls = x.layoutSource;
    if (!r || !ws || typeof node?.watch !== 'function') { chats.set(key, { node, stop: null, last: null }); return; }
    const entry = { node, stop: null, last: null };
    chats.set(key, entry);
    const seen = (g) => {
      const get = (a) => { try { return a === undefined ? undefined : g.get(a); } catch { return undefined; } };
      return { side: get(r.sideOpen), bottom: get(ws.bottomOpen), mode: get(ws.mode), sidebar: get(r.sidebarOpen), ready: get(ws.ready), restored: get(ws.restored), counter: get(ls?.counter), source: get(ls?.source) };
    };
    try {
      entry.stop = node.watch((g) => {
        const v = seen(g), was = entry.last;
        entry.last = v;
        if (shownColumn(ctx)?.key === key && v.mode !== modeShown) {
          modeShown = v.mode;
          // a mode's parameters are for the user's and the app's moves into it: never for what the framework or the space rule has just written, or two modes' parameters would answer each other
          const own = acting > 0 || resizing || ownMessage;
          queueMicrotask(() => {
            say();
            if (disposed || own) return;
            // still that chat, on that scope, in that mode: another may be shown by now
            const now_ = shownColumn(ctx);
            if (now_?.key === key && now_.scope === node && read(node, ws.mode) === v.mode) modeChanged(v.mode);
          });
        }
        if (!was) return;
        // its restore done: what the layout holds goes on (not during the app's own write)
        if (isReadyValue(v, key, node) && !isReadyValue(was, key, node)) queueMicrotask(() => { if (disposed || shownColumn(ctx)?.key !== key) return; if (claim) { applyChat(key, node); claim.settled = true; journal(); say(); } else modeChanged(read(node, ws.mode)); });
        if (acting > 0 || resizing || ownMessage) return;
        // the app's restoration (its history): the layout goes on again, once the app's write is done; it can change only which tab is at the front, which no flag says
        const again = () => { if (claim) { claim.dirty.add(key); queueMicrotask(() => { if (!disposed && claim && shownColumn(ctx)?.key === key) { applyChat(key, node); journal(); say(); } }); } };
        if (was.source === 'restore' && v.source !== 'restore') again();
        const moved = [['side', v.side !== was.side], ['bottom', v.bottom !== was.bottom], ['main', v.mode !== was.mode], ['sidebar', v.sidebar !== was.sidebar]].filter(([, m]) => m).map(([n]) => n);
        if (!moved.length) return;
        if (v.source === 'restore') { again(); return; }
        const user = v.counter !== was.counter || typeof v.source === 'string' || now() - lastInput <= INPUT_MS;
        // what the user takes is theirs in the mode it is in now and in the one whose parameters wrote it (closing a split's panel leaves the chat mode). The side panel's flag is
        // the modes' own: its moves are how the user enters and leaves them, so it takes no parameter away, and only its opening or closing is not put back
        if (user) for (const region of moved) {
          release(region);
          if (region === 'side') { if (modeHeld) delete modeHeld.wrote.side; continue; }
          if (typeof v.mode === 'string') modeReleased.add(`${v.mode}:${region}`);
          if (modeHeld) modeReleased.add(`${modeHeld.mode}:${region}`);
        }
      });
    } catch (e) { o.log?.('layout: a chat could not be watched', { message: String(e?.message ?? e) }); }
  }
  const isReadyValue = (v, key, node) => v.ready === true && (typeof node.value?.conversationId !== 'string' || v.restored === key);

  // ------------------------------------------------------------- a mode's parameters (ui.layouts.mode, D5)
  // Applied as the window's effective mode becomes that mode, under the same rule: what the user changes while in it is theirs from then on, and what the parameters
  // wrote goes back as the window leaves it. A layout picked comes first: the parameters are for the app's own modes.
  const modeReleased = new Set();
  let modeHeld = null;   // the parameters applied now: { mode, key, node, before, wrote, window, free }
  function modeChanged(mode) {
    const shown = shownColumn(ctx);
    if (modeHeld && modeHeld.mode === mode && modeHeld.key === shown?.key) return;
    leaveMode();
    enterMode(mode);
  }
  function leaveMode() {
    const h = modeHeld;
    modeHeld = null;
    if (h) around(() => { restoreChat(chats.get(h.key)?.node ?? h.node, h.before, h.wrote, h.free); restoreWindow(h.window, h.free); });
  }
  function enterMode(mode) {
    if (claim || !canWork()) return;
    const rule = (typeof ctx.declared === 'function' ? ctx.declared('Window', 'layoutModes') : []).find((r) => r.data?.layoutMode?.mode === mode);
    const shown = shownColumn(ctx);
    if (!rule || !shown || !isReady(shown.scope, shown.key)) return;
    watchChat(shown.key, shown.scope);
    const spec = rule.data.layoutMode;
    const free = (region) => !modeReleased.has(`${mode}:${region}`);
    const h = { mode, key: shown.key, node: shown.scope, before: snapshot(shown.scope), wrote: {}, sized: {}, window: windowBefore(shown.scope), free };
    modeHeld = h;
    const sink = {
      mod: rule.mod, wrote: h.wrote, before: h.before,
      live: (region, node) => modeHeld === h && !claim && free(region) && chats.get(h.key)?.node === node,
      start() {}, finish() {},
      why(region, why) { o.log?.('layout: a mode\'s parameters', { mode, region, why }); },
      sized(region, v) { if (v !== null) h.sized[region] = v; },
    };
    around(() => {
      try {
        if (spec.sidebar && free('sidebar')) {
          if (typeof spec.sidebar.open === 'boolean') sidebarTo(spec.sidebar.open, shown.scope, h.window.wrote);
          if (spec.sidebar.edge && moveSidebar(ctx, spec.sidebar.edge) === true) h.window.wrote.edge = true;
        }
        if (spec.bottom?.at && free('bottom')) { setBottomPlacement(ctx, { at: spec.bottom.at }); h.window.wrote.at = true; }
        for (const region of ['side', 'bottom']) if (spec[region] && free(region)) { const why = setChatRegion(region, spec, shown.scope, sink); if (why) sink.why(region, why); }
      } catch (e) { o.log?.('layout: a mode\'s parameters', { mode, message: String(e?.message ?? e) }); }
    });
  }

  /** The claim ended: each thing it wrote and the user has not released goes back as it was. */
  function giveBack(c) {
    const free = (region) => !c.released.has(region);
    around(() => {
      for (const [key, b] of c.before) { const node = chats.get(key)?.node; if (node) restoreChat(node, b, c.wrote.get(key) ?? {}, free); }
      if (c.window) restoreWindow(c.window, free);
    });
  }

  function end() {
    const c = claim;
    if (!c) return;
    claim = null;
    forget();
    giveBack(c);
    say();
    // the app's own mode comes back with its parameters
    queueMicrotask(() => { if (!disposed && !claim) { const shown = shownColumn(ctx); if (shown) modeChanged(read(shown.scope, ex().workspaceState?.mode)); } });
  }

  // ------------------------------------------------------------- what says an input came
  const noteInput = () => { lastInput = now(); };
  const onKey = (e) => { if (e.isTrusted && (e.metaKey || e.ctrlKey || e.altKey || !editable(e.target))) noteInput(); };
  const separator = (el) => !!el?.closest?.('[role="separator"]');
  const onPointer = (e) => { if (e.isTrusted) { noteInput(); onDivider = separator(e.target); adoptTab(e.target); } };
  const onDrag = (e) => { if (e.isTrusted && e.buttons) noteInput(); };   // a drag held longer than the window above
  // the app's handler writes after this one: its own move, then whatever it does, is done when the next task runs. Only a divider's: a size also moves with the tab a panel shows
  const inputEnded = (e) => {
    const was = e?.type === 'keyup' ? separator(e.target) : onDivider;
    if (e?.type === 'pointerup') onDivider = false;
    if (e?.isTrusted !== false && was && (claim || modeHeld)) { const t = setTimeout(checkSizes, 0); t?.unref?.(); }
  };
  // first of the window's listeners: a mod's panel message moves the app's counter inside the app's own, in this task
  const onMessage = (e) => {
    const d = e?.data;
    if (!d || typeof d !== 'object' || !PANEL_MESSAGES.has(d.type)) return;
    if (d.codexmods !== true) { noteInput(); return; }
    ownMessage = true;
    const t = setTimeout(() => { ownMessage = false; }, 0);
    t?.unref?.();
  };
  const doc = globalThis.document, win = globalThis.window;
  doc?.addEventListener?.('pointerdown', onPointer, true);
  doc?.addEventListener?.('pointermove', onDrag, true);
  doc?.addEventListener?.('pointerup', inputEnded, true);
  doc?.addEventListener?.('keydown', onKey, true);
  doc?.addEventListener?.('keyup', inputEnded, true);
  win?.addEventListener?.('message', onMessage, true);
  // the chat shown changed (or the arrangement): the layout goes on it
  const unwatch = onArrangement(ctx, () => {
    const shown = shownColumn(ctx);
    if (shown) watchChat(shown.key, shown.scope);
    const next = shown ? read(shown.scope, ex().workspaceState?.mode) ?? null : null;
    const moved = next !== modeShown;
    if (moved) { modeShown = next; ctx.local?.touch?.(LAYOUT_CONTEXT); o.changed?.(); }
    if (claim) apply();
    else if (moved || (modeHeld && modeHeld.key !== shown?.key)) modeChanged(next);
  });

  let retry = null;
  function retrySoon() { if (retry === null && !disposed) { retry = setTimeout(() => { retry = null; tryPending(); }, RETRY_MS); retry?.unref?.(); } }
  // the layout the user has new windows start with (D9), once per page, once its mod has started here
  const startFrom = now();
  let started = false;
  function tryDefault() {
    if (started || claim || pending || disposed) return;
    const key = o.startsWith?.();
    if (!key) { started = true; return; }
    if (declared().some((d) => d.key === key) && canWork()) { started = true; api.pick(key); return; }
    if (now() - startFrom > PENDING_MS) { started = true; return; }
    retrySoon();
  }
  function tryPending() {
    tryDefault();
    const p = pending;
    if (!p || disposed) return;
    if (declared().some((d) => d.key === p.key) && canWork()) { api.pick(p.key, { from: p.from }); return; }
    if (now() > p.until) {
      // its mod did not come back: what it wrote on the window goes back, as its going would have
      pending = null;
      forget();
      const j = p.from;
      if (j.window) around(() => restoreWindow({ ...j.window, regions: new Map(j.window.regions ?? []) }, (region) => !j.released.includes(region)));
      say();
      return;
    }
    retrySoon();
  }

  const api = {
    /** The layouts declared in this window. */
    list: declared,
    /**
     * Pick one (Window.setLayout, the palette's row, this window's own again after a reload): the claim, or why not. `by`: the mod that asks, which the mods' order decides for
     * against another mod's layout held now (D6); the user's own pick has no `by`. `from`: the journal it goes on from.
     */
    pick(key, { by = null, from = null } = {}) {
      const l = declared().find((d) => d.key === key);
      if (!canWork()) return { unavailable: 'this build\'s window cannot be arranged that way' };
      if (!l) return { unavailable: `no layout ${key} in this window` };
      const refused = behind(by);
      if (refused) return refused;
      pending = null;
      leaveMode();
      if (claim) end();
      claim = { key, rule: l.rule, spec: l.spec, released: new Set(from?.released ?? []), before: new Map(from?.before ?? []), wrote: new Map(from?.wrote ?? []),
        window: from?.window ? { ...from.window, regions: new Map(from.window.regions ?? []) } : null, windowDone: false, applied: new Map(), dirty: new Set(), partial: new Map(), sized: new Map(), regionSizes: new Map(),
        opened: from?.opened === true, settled: false, waiting: 0, noScope: 0 };
      apply();
      return true;
    },
    /**
     * The app's own mode picked while a layout holds the window: the layout ends, each thing it wrote going back, then `run` sets the mode; one the app refuses then (what the
     * layout gives back may be a tab that does not fill the workspace) leaves the layout as it was. `by` as for a pick.
     */
    toAppMode(run, { by = null } = {}) {
      const c = claim;
      if (!c) return run();
      const refused = behind(by);
      if (refused) return refused;
      const from = plainOf(c);
      end();
      const out = run();
      if (out !== true && declared().some((d) => d.key === from.key)) api.pick(from.key, { from });
      return out;
    },
    /** The claim ended (the user picked the app's own, or another way). */
    end() { if (pending) forget(); pending = null; end(); },
    /** What the Window says of it: its id, what is not as asked, what the user took back, whether it has reached the chat shown. */
    facts: () => (pending ? { picked: pending.key, settled: false, ...(pending.from.released?.length ? { released: pending.from.released } : {}) } : claim ? { picked: claim.key, settled: claim.settled && claim.waiting === 0, holds: everyRegion(claim).filter(held), ...(claim.partial.size ? { partial: [...claim.partial].map(([region, why]) => ({ region, why })) } : {}), ...(claim.released.size ? { released: [...claim.released] } : {}) } : null),
    /** A size of the layout's or a mode's parameters is held: the framework owns the window's space (D12). */
    holdsSizes: () => (!!claim && ((claim.spec.side?.size !== undefined && held('side')) || (claim.spec.bottom?.height !== undefined && held('bottom')))) || (!!modeHeld && (!!modeHeld.wrote.sideSize || !!modeHeld.wrote.bottomSize)),
    /** The allocator gave something back: what the layout's intent waited for goes on. */
    spaceReturned() { if (claim && claim.dirty.size) apply(); },
    /** An input ended (the tests'; the page's own listeners call it). */
    inputEnded: () => checkSizes(),
    /** What a where's window context reads: the shown chat's effective mode (absent with no workspace) and the layout picked. */
    context() {
      ctx.local?.read?.(LAYOUT_CONTEXT);
      const shown = shownColumn(ctx);
      const mode = shown ? read(shown.scope, ex().workspaceState?.mode) ?? modeShown : null;
      return { ...(mode ? { mode } : {}), ...(claim ? { layout: claim.key } : {}) };
    },
    /** The effective mode of the chat shown, as last seen (what the window's space depends on). */
    modeNow: () => modeShown,
    /** Is this region held by another mod's layout? Its key, or null. */
    heldBy: (region) => (claim && claim.rule.mod && held(region) && everyRegion(claim).includes(region) ? claim.rule.mod : null),
    /** The framework's own act: no origin to tell inside it. */
    around,
    /** The app's narrow-window handler is about to run, synchronously: what it writes is neither the user's nor a layout's. */
    resizing() { resizing = true; queueMicrotask(() => { resizing = false; }); },
    /** The app's commands, as its dispatcher runs them: an input. */
    noteInput,
    /** The mods' layouts changed: a claim whose layout went (its mod off) ends; one declared again keeps going as declared now. */
    rulesChanged() {
      tryPending();
      if (!claim) return;
      const l = declared().find((d) => d.key === claim.key);
      if (!l) { end(); return; }
      claim.rule = l.rule; claim.spec = l.spec;
    },
    dispose() {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      doc?.removeEventListener?.('pointerdown', onPointer, true);
      doc?.removeEventListener?.('pointermove', onDrag, true);
      doc?.removeEventListener?.('pointerup', inputEnded, true);
      doc?.removeEventListener?.('keydown', onKey, true);
      doc?.removeEventListener?.('keyup', inputEnded, true);
      win?.removeEventListener?.('message', onMessage, true);
      unwatch?.();
      for (const c of chats.values()) { try { c.stop?.(); } catch { /* gone */ } }
      chats.clear();
    },
  };
  // this window held a layout before its reload: it goes on, once its mod is here, and no default comes before it
  const saved = journaled();
  if (saved) { pending = { key: saved.key, from: saved, until: now() + PENDING_MS }; retrySoon(); }
  return api;
}
