'use strict';
// The menu bar's mod entries (docs/design/mod-surfaces.md §3.4, P4; E8.4). The Host sends the mods' entries (`set`, the whole list in rule
// order); the electron adapter's menu hold installs, in place of every menu the app builds, a composed one: the app's own items, then each
// app menu's mod entries in a section of their own after a separator, and a mod's own top-level menu before Window. The app's Menu object
// is never changed. A mod's key chord is its entry's accelerator when no one holds it: the app's menu (its accelerators, hidden items
// included, and role defaults) and earlier entries first; a conflict drops the chord, keeps the entry and is reported. Choosing an entry
// (the menu or its chord) is reported to the Host with the window in front, which runs the entry's callback.
const kit = require('../area-kit.cjs');
const { userHoldsOf, outcomeOf } = require('../user-holds.cjs');

const MENUS = { file: 'file-menu', edit: 'edit-menu', view: 'view-menu', window: 'window-menu', help: 'help-menu' };
const ID = 'codexmods:';
const MAX_ENTRIES = 200;
const MAX_TITLE = 80;
const TYPES = ['normal', 'checkbox', 'radio'];

/** An accelerator as one comparable string: its modifiers (Cmd, Ctrl, Alt, Shift) in order, then its key; null when it is none. */
function normalize(acc, mac = process.platform === 'darwin') {
  if (typeof acc !== 'string' || !acc.trim()) return null;
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop().toLowerCase();
  const mods = new Set();
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'cmdorctrl' || p === 'commandorcontrol') mods.add(mac ? 'cmd' : 'ctrl');
    else if (p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') mods.add('cmd');
    else if (p === 'ctrl' || p === 'control') mods.add('ctrl');
    else if (p === 'alt' || p === 'option' || p === 'altgr') mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else return null;
  }
  return [...['cmd', 'ctrl', 'alt', 'shift'].filter((m) => mods.has(m)), key].join('+');
}

/** Every accelerator the app's menu holds, by its normalized form, with its item's label (hidden items and role defaults included). */
function takenBy(menu) {
  const taken = new Map();
  const walk = (m) => {
    for (const it of (m && m.items) || []) {
      let acc = it.accelerator;
      if (!acc && it.role && typeof it.getDefaultRoleAccelerator === 'function') { try { acc = it.getDefaultRoleAccelerator(); } catch { acc = null; } }
      const n = normalize(acc);
      if (n && !taken.has(n)) taken.set(n, it.label || it.role || 'the app');
      if (it.submenu) walk(it.submenu);
    }
  };
  walk(menu);
  return taken;
}

// The app's own entries (E8.4b): each item of its menu bar with an action of its own, by its path of labels, reported as MenuEntry; choosing
// one is a click on it. Never a separator, a submenu, a role (the system's: copy, paste, quit, about, windows), a framework entry, a hidden
// one, nor the protected ones: on macOS the application menu as a whole (Settings, updates, signing out: the app's and the account's,
// whatever the language its labels are in; review 4), and anywhere the English labels of those. The Host also refuses an entry its title
// pairs with a protected Command. An entry is turned off when it or a menu above it is.
const PROTECTED = /^(settings|preferences|quit|about|log ?out|sign ?out)\b/i;
const MAX_APP_ENTRIES = 300;
const labelOf = (it) => (typeof it.label === 'string' ? it.label.trim() : '');
function* appItems(menu, path = [], enabled = true, mac = process.platform === 'darwin', hidden = false) {
  const items = (menu && menu.items) || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // a hidden item is never an entry; `hidden`: it is still the user's when its chord runs it (a second chord's alias of a visible one)
    if (!it || it.type === 'separator' || (it.visible === false && !hidden) || (typeof it.id === 'string' && it.id.startsWith(ID))) continue;
    if (mac && !path.length && i === 0) continue;   // the application menu
    const label = labelOf(it);
    if (!label) continue;
    const on = enabled && it.enabled !== false;
    if (it.submenu) { yield* appItems(it.submenu, [...path, label], on, mac, hidden); continue; }
    if (it.role || PROTECTED.test(label) || !path.length) continue;
    yield { item: it, path: [...path, label], enabled: on };
  }
}
/** The app's own entries of a menu bar, as reported: `{path, title, menu, shortcut?, enabled, checked?}`. */
function appEntries(menu, mac) {
  const out = [];
  for (const { item, path, enabled } of appItems(menu, [], true, mac)) {
    if (out.length >= MAX_APP_ENTRIES) break;
    const acc = typeof item.accelerator === 'string' && item.accelerator ? item.accelerator : null;
    out.push({ path, title: path.at(-1), menu: path.slice(0, -1).join(' › '), ...(acc ? { shortcut: acc } : {}), enabled,
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: item.checked === true } : {}) });
  }
  return out;
}

/** One entry as the Host sends it, checked: `{key, reg, mod, path, item: {id, title, in, keys?, type?, checked?, enabled?, visible?}}`. */
function entryOf(x) {
  if (!x || typeof x !== 'object' || typeof x.key !== 'string' || x.key.length > 200 || typeof x.path !== 'string') return null;
  const it = x.item;
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || typeof it.title !== 'string' || !it.title.trim() || it.title.length > MAX_TITLE) return null;
  const at = typeof it.in === 'string' ? (Object.hasOwn(MENUS, it.in) ? { menu: MENUS[it.in] } : null)
    : it.in && typeof it.in === 'object' && typeof it.in.menu === 'string' && it.in.menu.trim() && it.in.menu.length <= 40 ? { own: it.in.menu.trim(), before: it.in.before === 'help' ? 'help-menu' : 'window-menu' } : null;
  if (!at) return null;
  return { key: x.key, reg: typeof x.reg === 'string' ? x.reg : null, path: x.path, mod: typeof x.mod === 'string' ? x.mod : '', at,
    item: { id: it.id, title: it.title.trim(), keys: typeof it.keys === 'string' ? it.keys : null, type: TYPES.includes(it.type) ? it.type : 'normal',
      checked: it.checked === true, enabled: it.enabled !== false, visible: it.visible !== false } };
}

function register(hooks) {
  let entries = [];
  let toldEntries = '';
  let hostUp = true;
  let lastShortcuts = '';
  const hold = () => (hooks.electron && typeof hooks.electron.menuBar === 'function' ? hooks.electron.menuBar() : null);
  const focusedId = () => { try { return hooks.electron?.focusedWindow?.() ?? null; } catch { return null; } };

  function compose(appMenu) {
    const h = hold();
    if (!h || !entries.length) return appMenu;
    const { Menu, MenuItem } = h;
    // the chords, decided in rule order before anything is placed: the app's first, then the first mod entry that asks
    const taken = takenBy(appMenu);
    const results = [], held = new Map();
    for (const e of entries) {
      const keys = e.item.keys;
      if (!keys) continue;
      const n = normalize(keys);
      const owner = n ? taken.get(n) : null;
      if (n && !owner) { taken.set(n, e.item.title); held.set(e, keys); results.push({ key: e.key, keys, held: true }); }
      else results.push({ key: e.key, keys, held: false, conflict: n ? String(owner) : 'not a key chord' });
    }
    const itemOf = (e) => {
      const accelerator = held.get(e);
      return new MenuItem({
        id: `${ID}${e.key}/${e.item.id}`, label: e.item.title, type: e.item.type, checked: e.item.checked, visible: e.item.visible,
        enabled: hostUp && e.item.enabled, ...(accelerator ? { accelerator, registerAccelerator: true } : {}),
        click: (mi, win, ev) => {
          try {
            // the window as the framework names its windows (its page's webContents id, not the BrowserWindow's own id)
            const wc = win && !win.isDestroyed?.() ? win.webContents : null;
            hooks.areaReport('menus', { event: 'choose', key: e.key, reg: e.reg, path: e.path, windowId: wc && typeof wc.id === 'number' ? wc.id : focusedId(),
              checked: e.item.type === 'normal' ? null : mi.checked === true, via: ev && ev.triggeredByAccelerator ? 'keys' : 'menu' });
          } catch (x) { hooks.log?.warn('menus: a choice could not be told', { message: String(x?.message ?? x) }); }
        },
      });
    };
    const byMenu = new Map(), own = new Map();
    for (const e of entries) {
      if (e.at.menu) { if (!byMenu.has(e.at.menu)) byMenu.set(e.at.menu, []); byMenu.get(e.at.menu).push(e); }
      else { const k = `${e.at.before}\u0000${e.at.own}`; if (!own.has(k)) own.set(k, { label: e.at.own, before: e.at.before, list: [] }); own.get(k).list.push(e); }
    }
    const ownMenu = (o) => { const sub = new Menu(); for (const e of o.list) sub.append(itemOf(e)); return new MenuItem({ id: `${ID}menu:${o.label}`, label: o.label, submenu: sub }); };
    const out = new Menu();
    for (const top of appMenu.items) {
      for (const o of own.values()) if (o.before === top.id && !o.done) { o.done = true; out.append(ownMenu(o)); }
      const mine = byMenu.get(top.id);
      if (!mine || !top.submenu) { out.append(top); continue; }
      const sub = new Menu();
      for (const it of top.submenu.items) sub.append(it);
      sub.append(new MenuItem({ id: `${ID}separator:${top.id}`, type: 'separator' }));
      for (const e of mine) sub.append(itemOf(e));
      out.append(new MenuItem({ id: top.id, label: top.label, ...(top.role ? { role: top.role } : {}), submenu: sub }));
    }
    // a mod's own menu whose place the app's menu does not have (no Window or Help): at the end
    for (const o of own.values()) if (!o.done) out.append(ownMenu(o));
    const said = JSON.stringify(results);
    if (said !== lastShortcuts) { lastShortcuts = said; try { hooks.areaReport('menus', { event: 'shortcuts', results }); } catch { /* best effort */ } }
    return out;
  }

  /** The Host came or went: the mods' entries stay in their menus, disabled while nothing can run them, and the menus are built again. */
  function setHost(up) {
    if (hostUp === up) return;
    hostUp = up;
    const h = hold();
    if (h && entries.length) h.setCompose(compose);
  }
  if (typeof hooks.onHostState === 'function') hooks.onHostState(setHost);

  /** The app's own entries, told when they change (each menu the app installs, after the hold is there). */
  function tellEntries(menu) {
    const list = appEntries(menu);
    const said = JSON.stringify(list);
    if (said === toldEntries) return;
    toldEntries = said;
    try { hooks.areaReport('menus', { event: 'entries', entries: list }); } catch { /* best effort */ }
  }
  // The user's click on one of the app's own entries (H6m3b), or its chord: their Command.run of the command the entry names (the item's
  // own command id, `codexmodsCommand`, which the menu-command seam gives it; else the Host pairs the entry by its path, as it names the
  // MenuEntry), held while something holds it: the app's own click once the Host lets it go (refused, a notice says why), unless the window
  // in front or the app's menu changed meanwhile (the app's handler acts on what is in front then: not run); reported after it went while
  // a mod observes it. Each app item's click is wrapped in place as its menu is installed (the item keeps everything else, which a copy of
  // it could not: a hidden item's chord that works while hidden). A chord the app forwards to its page is held there as well. A mod's
  // choice of an entry (`choose`) is the mod's, never held as the user's. What it did is that the app's handler was called (an asynchronous
  // handler's own failure is not seen).
  const holds = userHoldsOf(hooks);
  const clicks = new WeakMap();   // an app item -> its own click
  let choosing = null;            // the item a mod's `choose` clicks now
  let generation = 0;             // the app's menus installed so far (one rebuilt while a click waits: the click is not run)
  function holdClicks(menu) {
    generation++;
    for (const { item, path } of appItems(menu, [], true, process.platform === 'darwin', true)) {
      if (clicks.has(item) || typeof item.click !== 'function') continue;
      const own = item.click;
      clicks.set(item, own);
      item.click = function click(event, win, wc) {
        const run = () => own.call(this, event, win, wc);
        if (choosing === item) return run();
        const command = typeof item.codexmodsCommand === 'string' && item.codexmodsCommand ? item.codexmodsCommand : null;
        const ref = command ? { type: 'Command', provider: 'codex', id: command } : { type: 'MenuEntry', provider: 'framework', path };
        const operation = command ? 'run' : 'choose';
        if (!holds.held('Command.run')) {
          if (!holds.observed('Command.run')) return run();
          let r;
          try { r = run(); } catch (e) { holds.did({ ref, operation, args: [], outcome: { status: 'failed', error: { message: String(e?.message ?? e) } } }); throw e; }
          void outcomeOf(r).then((outcome) => holds.did({ ref, operation, args: [], outcome }));
          return r;
        }
        const front = focusedId(), at = generation;
        void holds.ask({ prefix: 'menu', ref, operation, args: [], changes: false }).then((a) => {
          if (a.go !== true) return;
          if (focusedId() !== front || generation !== at) {
            holds.done(a.requestId, { status: 'failed', error: { message: 'not run: the window in front or the app\'s menu changed while it waited' } });
            hooks.log?.info?.('menus: a held click was not run (the window in front or the menu changed)', { operation });
            return;
          }
          let r;
          try { r = run(); } catch (e) { holds.done(a.requestId, { status: 'failed', error: { message: String(e?.message ?? e) } }); return; }
          void outcomeOf(r).then((outcome) => holds.done(a.requestId, outcome));
        });
        return undefined;
      };
    }
  }
  const h0 = hold();
  if (h0 && typeof h0.onAppMenu === 'function') {
    h0.onAppMenu((menu) => { tellEntries(menu); holdClicks(menu); });
    if (typeof h0.appMenu === 'function' && h0.appMenu()) holdClicks(h0.appMenu());
  }

  hooks.onAreaOp('menus', async (op, args = {}) => {
    const h = hold();
    if (!h) throw kit.refusal('the menu bar is not available here');
    if (op === 'set') {
      const list = Array.isArray(args.entries) ? args.entries.slice(0, MAX_ENTRIES).map(entryOf).filter(Boolean) : null;
      if (!list) throw kit.refusal('entries is a list');
      entries = list;
      h.setCompose(entries.length ? compose : null);
      return { entries: entries.length };
    }
    if (op === 'host') {   // the Host came or went: mod entries are disabled while it cannot run them
      setHost(args.up !== false);
      return {};
    }
    if (op === 'entries') {   // the app's own entries now (the Host's first read; later changes are reported)
      const list = appEntries(h.appMenu());
      toldEntries = JSON.stringify(list);
      return { entries: list };
    }
    if (op === 'choose') {   // one of the app's own entries, by its path of labels, as a click on it
      const want = Array.isArray(args.path) && args.path.length >= 2 && args.path.length <= 6 && args.path.every((x) => typeof x === 'string' && x) ? args.path.join('\u0000') : null;
      if (!want) throw kit.refusal('an entry is named by its path of labels');
      const found = [...appItems(h.appMenu())].find((x) => x.path.join('\u0000') === want);
      if (!found) throw kit.refusal('the app\'s menu has no such entry now');
      if (!found.enabled) throw kit.refusal('the app has that entry turned off now');
      if (typeof h.choose !== 'function') throw kit.refusal('the app\'s entries cannot be chosen here');
      choosing = found.item;
      try { h.choose(found.item); } finally { choosing = null; }
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register, normalize, takenBy, appEntries };
