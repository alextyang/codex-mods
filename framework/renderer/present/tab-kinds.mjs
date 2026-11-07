// The panels' tab kinds (docs/design/layouts.md §4.1; scout docs/research/layouts/wl2-tab-kinds.md): parts of the SidePanel's and the
// BottomPanel's `kinds`, hidden (`ui.hide(panel, {part})`) and ordered in the new-tab launcher (`ui.reorder(panel, {slot: 'kinds', order})`).
// - Hide: every kind object of the app's registry (those it has at boot, and each one it registers later: its `set`) gets `isVisible` in
//   place, a wrapper that reads the framework's epoch first (an atom of the app's own factory, exposure `atoms`: the panels' derived atoms
//   then recompute with no navigation), keeps the app's own answer, and hides a tab of a kind a rule hides in that panel, for that chat,
//   unless the tab needs the user (a file with unsaved edits, a side chat working, waiting for the user or failed, the agent's command kept
//   running as a terminal, or one whose chat the graph has not answered for yet; a shell of the user's is not held: the graph cannot
//   tell what it runs). The epoch moves when a rule comes or goes, and when anything those answers read changes (a subject, a chat id's
//   mapping, a related subject a rule's `where` read: the runtime's `track`), so a hidden side chat that comes to need the user shows. The
//   panels pass the tab (seam tab-visible); a build without it hides nothing (its rules say unsupported). The launcher leaves a hidden
//   kind out of its list for that panel. Nothing is ever closed, and a kind's availability is never touched.
// - Order: the launcher's list in the declared order (the named first, the others as they were), resolved for the chat as a hide is, and
//   the app's own order table for a git project (exposure `launcherOrder`) written to agree. The New tab page draws the tools with a
//   shortcut first: an order holds within that.
// What it writes into the app's objects (the kinds' `isVisible`, the registry's `set`, the order table) is given back exactly when the last
// rule goes (the table) and when the runtime is disposed (all of it).
// The New tab page (the app's own kind, or a browser tab on its start page where "New tab" opens one), a saved tab's placeholder and the
// framework's own kind are never parts. NO NODE API.

import { applyParts } from './rules.mjs';

/** The app's kind id -> its part (both builds); the launcher's action id -> its part (an MCP view's id is `host:server:tool`: apps). */
export const KIND_PART = Object.freeze({ 'workspace-file': 'files', review: 'changes', terminal: 'terminal', browser: 'browser', 'local-side-chat': 'sideChat',
  'cloud-desktop': 'desktop', 'space-page': 'newPage', 'mcp-extension': 'apps', plan: 'plan', subagents: 'subagents', goal: 'goal' });
export const LAUNCHER_PART = Object.freeze({ 'open-file': 'files', review: 'changes', terminal: 'terminal', browser: 'browser', 'side-chat': 'sideChat', desktop: 'desktop', 'new-page': 'newPage' });
const launcherPart = (item) => KIND_PART[item?.tabType?.kind] ?? LAUNCHER_PART[item?.id] ?? null;
const BUSY = new Set(['working', 'waitingForYou', 'error']);
/** A browser tab on its start page, no page yet (a build whose "New tab" opens the browser there, the launcher its start page). */
const blankBrowser = (tab) => tab?.durableRoute?.kind === 'browser' && tab.durableRoute.params?.restoreUrl === '';
const PANELS = Object.freeze({ right: 'SidePanel', bottom: 'BottomPanel' });
const KINDS = (r) => (r.presentation === 'SidePanel' || r.presentation === 'BottomPanel') && (r.kind === 'hide' || r.kind === 'reorder');

/**
 * @param {{ exports: () => object | null, resolve: (presentation: string, inst: object | null) => { parts: object[] }, thread: (id: string) => object | null,
 *   subject: (ref: object) => object | null | undefined, settled: (ref: object) => boolean, track: (fn: Function) => { value: any, keys: Set<string> },
 *   later: (fn: Function, ms: number) => void, log: (m: string, d?: object) => void }} o
 */
export function createTabKinds(o) {
  let epoch = 0, atom = null, armed = false, arming = false, disposed = false, sig = '', appOrder = null, stale = false;
  let registry = null, registrySet = null;   // the registry, and its own `set` descriptor before ours (null: it had none of its own)
  const subs = new Set();
  const decorated = new Map();   // kind object -> { own: the app's isVisible now, had: its own property descriptor before ours (or null), assigned }
  const cache = new Map();   // `${presentation}|${chat}` -> { parts, hidden } (this epoch)
  const watched = new Set();   // the keys the answers read since the epoch moved (the runtime's `track`): a change of one moves it again
  const ex = () => { try { return o.exports() ?? {}; } catch { return {}; } };

  /** `fn()`, with what it read watched (a change of any of it moves the epoch). */
  function deps(fn) {
    if (typeof o.track !== 'function') return fn();
    const { value, keys } = o.track(fn);
    for (const k of keys) watched.add(k);
    return value;
  }
  /** A subject a hide or a hold reads: `undefined` while the graph has not answered for it (`pending`), null when it has none. */
  function look(ref) {
    if (!ref) return undefined;
    const x = o.subject(ref);
    if (x === undefined) {
      if (typeof o.settled === 'function' && o.settled(ref)) return null;
      stale = true;   // read again at the page's next refresh too (no subject could be read yet)
      return undefined;
    }
    return x && !x.gone ? x : null;
  }
  /** The rules' parts in a panel for a chat (resolved against its Thread, as their `for`, `of` and `where` read it), and what they hide. */
  function ruled(presentation, chatId) {
    const key = `${presentation}|${chatId ?? ''}`;
    let out = cache.get(key);
    if (!out) {
      let parts;
      try { parts = deps(() => o.resolve(presentation, chatId ? look(o.thread(chatId)) ?? null : null).parts ?? []); } catch { parts = []; }
      const hidden = new Set();
      for (const r of parts) if (r.kind === 'hide' && (r.slot === undefined || r.slot === 'kinds')) for (const p of r.part ?? []) hidden.add(p);
      out = { parts, hidden };
      cache.set(key, out);
    }
    return out;
  }
  /** Does a tab need the user (it stays, whoever hides its kind)? */
  function held(tab) {
    if (!tab || typeof tab !== 'object') return false;
    if (tab.hasUnsavedChanges === true) return true;
    const chat = tab.props?.content?.conversationId ?? tab.props?.conversationId;
    if (typeof chat === 'string' && chat) {
      // its chat not answered for yet (the id's mapping or the subject): held until it is
      const x = look(o.thread(chat));
      if (x === undefined || BUSY.has(x?.state?.status)) return true;
    }
    if (typeof tab.tabId === 'string' && tab.tabId.startsWith('terminal:')) {
      const x = look({ type: 'Terminal', provider: 'codex', id: tab.tabId.slice('terminal:'.length) });
      // a shell of the user's is a live session whatever it runs (the graph cannot tell a command): only the agent's command kept running holds
      if (x?.state?.running === true && x.state.startedBy === 'agent') return true;
    }
    return false;
  }
  /** Which panel holds a tab: the bottom's when its ids list it (a raw atom: no cycle with the panels' visible tabs), else the right. */
  function panelOf(scope, tab) {
    const pc = ex().panelControllers;
    try { const ids = pc?.bottom?.tabIds$ ? scope.get(pc.bottom.tabIds$) : null; if (Array.isArray(ids) && ids.includes(tab.tabId)) return 'bottom'; } catch { /* the right */ }
    return 'right';
  }
  /** A kind's `isVisible`, in place: the epoch read first (so the panels recompute), the app's own answer kept, a rule's hide applied. */
  function decorate(kind) {
    if (disposed || !kind || typeof kind !== 'object' || decorated.has(kind) || !KIND_PART[kind.kind]) return;
    const st = { own: kind.isVisible, had: Object.getOwnPropertyDescriptor(kind, 'isVisible') ?? null };
    const part = KIND_PART[kind.kind];
    const wrapped = function isVisible(scope, tab) {
      try { if (atom && scope && typeof scope.get === 'function') scope.get(atom); } catch { /* not tracked */ }
      if (typeof st.own === 'function' && st.own.call(this, scope, tab) === false) return false;
      // without the tab (a build without the seam tab-visible) nothing is hidden: its rules say unsupported
      if (!scope || !tab || blankBrowser(tab)) return true;
      const chat = typeof scope.value?.conversationId === 'string' ? scope.value.conversationId : null;
      return !ruled(PANELS[panelOf(scope, tab)], chat).hidden.has(part) || deps(() => held(tab));
    };
    try {
      Object.defineProperty(kind, 'isVisible', { configurable: true, enumerable: true, get: () => wrapped, set: (v) => { st.own = v; st.assigned = true; } });
      decorated.set(kind, st);
    } catch (e) { o.log('a tab kind could not be decorated', { kind: kind.kind, message: String(e?.message ?? e) }); }
  }
  /** The registry's kinds decorated, and each kind it registers later (its `set`), once its exposures are there (polled for a while;
   *  asked again on each use until then). */
  function arm() {
    if (armed || arming || disposed) return;
    arming = true;
    let tries = 0;
    const tick = () => {
      if (disposed) { arming = false; return; }
      const x = ex();
      const reg = x.tabRegistry?.registry, external = x.atoms?.external, AppScope = x.AppScope;
      if (reg && typeof reg.set === 'function' && typeof external === 'function' && AppScope) {
        armed = true; arming = false;
        try { atom = external(AppScope, () => epoch, ({ set }) => { const f = () => set(epoch); subs.add(f); return () => subs.delete(f); }); } catch (e) { o.log('the tab kinds\' epoch could not be made', { message: String(e?.message ?? e) }); }
        for (const k of reg.values()) decorate(k);
        const set = reg.set;
        try {
          registrySet = Object.getOwnPropertyDescriptor(reg, 'set') ?? null;
          Object.defineProperty(reg, 'set', { configurable: true, writable: true, value(k, v) { decorate(v); return set.call(this, k, v); } });
          registry = reg;
        } catch { /* the kinds registered later stay the app's */ }
        return;
      }
      if (++tries < 300) o.later(tick, tries < 100 ? 20 : 200);
      else arming = false;
    };
    tick();
  }
  /** The epoch moves: the panels recompute what they show (each answer read anew). */
  function move() {
    epoch++;
    cache.clear();
    watched.clear();
    stale = false;
    for (const f of [...subs]) { try { f(); } catch { /* one subscriber */ } }
  }
  /** The app's own order table as it was (the ids the framework added taken out). */
  function giveTableBack() {
    const table = ex().launcherOrder?.table;
    if (!appOrder || !table || typeof table !== 'object') return;
    try {
      for (const k of Object.keys(table)) if (!Object.hasOwn(appOrder, k)) delete table[k];
      Object.assign(table, appOrder);
    } catch { /* the app's own order stays */ }
  }
  /** The rules changed: the panels recompute when what they hide or order does; with none left, the app's order table is its own again. */
  function changed(all) {
    arm();
    const mine = all.filter(KINDS);
    const next = JSON.stringify(mine.map((r) => [r.presentation, r.mod, r.id, r.kind, r.part, r.slot, r.data?.order, r.where, r.for, r.of]));
    if (next === sig) return;
    sig = next;
    if (!mine.length) giveTableBack();
    move();
  }
  /** Subjects changed (their keys), or the page refreshed (null): the epoch moves when the panels' answers read one of them. */
  function touched(keys) {
    if (disposed || !armed) return;
    if (keys === null ? stale : keys.some((k) => watched.has(k))) move();
  }
  /** The launcher's list for a panel: the hidden kinds left out, then in the declared order (and the app's order table written to agree). */
  function launcher(list, opts, scope) {
    arm();
    if (!Array.isArray(list)) return list;
    const target = opts?.target === 'bottom' ? 'bottom' : 'right';
    const chat = (() => { try { const v = scope?.()?.value; return typeof v?.conversationId === 'string' ? v.conversationId : null; } catch { return null; } })();
    const { parts, hidden: gone } = ruled(PANELS[target], chat);
    const reorders = parts.filter((r) => r.kind === 'reorder' && r.slot === 'kinds');
    const keep = (l) => (gone.size ? l.filter((x) => !gone.has(launcherPart(x))) : l);
    const order = (l) => (reorders.length ? applyParts(reorders, 'kinds', l, (x) => launcherPart(x) ?? x?.id ?? null) : l);
    // the app's own table, by which it sorts the list in a git project (an id it does not name goes by the list's length, so leaving one
    // out moves the others): while a rule hides or orders a kind, every id in the order the app would draw, the hidden left out and the
    // declared order applied; else the app's own given back, as it was
    const table = ex().launcherOrder?.table;
    if (table && typeof table === 'object') {
      try {
        if (!appOrder) appOrder = { ...table };
        giveTableBack();
        if (gone.size || reorders.length) {
          const rank = (x) => appOrder[x?.id] ?? list.length;
          order(keep([...list].sort((a, b) => rank(a) - rank(b)))).forEach((x, i) => { if (typeof x?.id === 'string') table[x.id] = i; });
        }
      } catch { /* the app's own order stays */ }
    }
    return order(keep(list));
  }
  /** Everything written into the app's objects given back: the order table, the registry's `set`, each kind's `isVisible` (the app's own, as it is now). */
  function dispose() {
    disposed = true;
    giveTableBack();
    if (registry) {
      try { if (registrySet) Object.defineProperty(registry, 'set', registrySet); else delete registry.set; } catch { /* the app's registry keeps ours */ }
      registry = null;
    }
    for (const [kind, st] of decorated) {
      try {
        if (st.had && !('value' in st.had)) Object.defineProperty(kind, 'isVisible', st.had);
        else if (st.had || st.assigned) Object.defineProperty(kind, 'isVisible', { configurable: true, enumerable: true, writable: true, value: st.own });
        else delete kind.isVisible;
      } catch { /* that kind keeps ours */ }
    }
    decorated.clear();
    // one last epoch, so the panels' cached answers are computed again by the app's own isVisible
    epoch++;
    for (const f of [...subs]) { try { f(); } catch { /* one subscriber */ } }
    subs.clear();
    cache.clear();
    watched.clear();
  }
  return { arm, changed, touched, launcher, dispose, hidden: (p, c) => new Set(ruled(p, c).hidden), get epoch() { return epoch; } };
}
