'use strict';
// The only file besides loader/loader.cjs that requires 'electron' (contracts/main-hooks.d.ts). Implements ElectronAdapter
// and, for framework-main's own use, a few extra members (marked "framework-main only") that other modules never receive in their types:
//   registerScheme, handleProtocol, exemptSchemeFromAppNetworkFilters.
// Not unit-testable against real Electron: electron-adapter.test.mjs drives it with a fake electron object, and real behavior
// is verified in the native acceptance phase.

const path = require('node:path');

const DEFAULT_APP_URL = 'app://-/index.html';

/** @param {any} [electron] injected in tests; defaults to the real module. */
function createElectronAdapter(electron) {
  const e = electron || require('electron');
  const { app, BrowserWindow, MessageChannelMain, ipcMain, dialog, protocol, webContents, shell, nativeTheme, Menu, MenuItem } = e;

  const wcOf = (windowId) => (webContents.fromId(windowId) || null);
  const winOf = (windowId) => { const wc = wcOf(windowId); return wc ? BrowserWindow.fromWebContents(wc) : null; };
  let lastFocused = null;   // the app window focused last (focusedWindow)
  let badgeHold = null;     // the Dock badge's hold (badge), once installed
  let menuHold = null;      // the application menu's hold (menuBar), once installed
  // The app's pages' messages to its main side (`codex_desktop:message-from-view`, and the git worker's requests on
  // `codex_desktop:worker:git:from-view`: one ipcMain.handle each, the app's): framework-main may hold one kind of them (holdAppMessage)
  // before the app's own handler takes it. Installed now, before the app's code registers its handlers (framework-main runs first); a kind
  // nothing holds goes straight on.
  const APP_MESSAGES = 'codex_desktop:message-from-view';
  const HELD_CHANNELS = new Set([APP_MESSAGES, 'codex_desktop:worker:git:from-view']);
  // `${channel}\n${type}` -> (windowId, msg, page) => msg | null | {reply: [channel, message]} | a Promise of one (null: not delivered;
  // reply: answered so, as the app answers it, and not delivered); `page.replies(channel, fn)` hears what the app sends that page on a
  // channel until fn says true (or the page goes; it returns the means to stop hearing): how a held request learns what the app did with
  // it; `page.gone(fn)`: fn() once the page goes (closed, crashed or loaded again: what it asked is no longer waited for), until disposed
  const messageHolds = new Map();
  const listening = new WeakMap();   // a page's webContents -> Map(channel -> Set of fn): its sends heard
  function repliesOf(sender) {
    return (channel, fn) => {
      let byChannel = listening.get(sender);
      if (!byChannel) {
        byChannel = new Map();
        listening.set(sender, byChannel);
        const send0 = sender.send;
        sender.send = function send(ch, ...args) {
          const fns = byChannel.get(ch);
          if (fns) for (const f of [...fns]) { let done; try { done = f(...args) === true; } catch { done = true; } if (done) fns.delete(f); }
          return send0.call(this, ch, ...args);
        };
      }
      const fns = byChannel.get(channel) ?? new Set();
      byChannel.set(channel, fns);
      fns.add(fn);
      return () => fns.delete(fn);
    };
  }
  function goneOf(sender) {
    return (fn) => {
      if (!sender || typeof sender.on !== 'function') return () => {};
      let fired = false;
      const off = () => { for (const [ev, h] of hs) try { sender.removeListener(ev, h); } catch { /* the page went */ } };
      const once = () => { if (fired) return; fired = true; off(); try { fn(); } catch { /* the listener's fault */ } };
      const hs = [['destroyed', once], ['render-process-gone', once], ['did-start-navigation', (d, _url, inPlace, mainFrame) => {
        // the main frame loads another document (Electron's details, or its older arguments)
        if (d && typeof d.isMainFrame === 'boolean' ? d.isMainFrame && !d.isSameDocument : mainFrame === true && !inPlace) once();
      }]];
      for (const [ev, h] of hs) sender.on(ev, h);
      if (sender.isDestroyed?.()) queueMicrotask(once);
      return off;
    };
  }
  if (ipcMain && typeof ipcMain.handle === 'function') {
    const handle0 = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = function handle(channel, listener) {
      if (!HELD_CHANNELS.has(channel) || typeof listener !== 'function') return handle0(channel, listener);
      return handle0(channel, async (event, msg, ...rest) => {
        const hold = msg && typeof msg === 'object' && typeof msg.type === 'string' ? messageHolds.get(`${channel}\n${msg.type}`) : undefined;
        const sender = event && event.sender;
        if (!hold || !sender) return listener(event, msg, ...rest);
        let next;
        try { next = await hold(sender.id, msg, { replies: repliesOf(sender), gone: goneOf(sender) }); } catch { next = msg; }   // the hold's fault: the app's own goes on
        if (next === null) return undefined;
        if (next && typeof next === 'object' && Array.isArray(next.reply)) {
          try { if (!sender.isDestroyed?.()) sender.send(next.reply[0], next.reply[1]); } catch { /* the page went */ }
          return undefined;
        }
        return listener(event, next && typeof next === 'object' ? next : msg, ...rest);
      });
    };
  }
  const preloads = [];
  const sessions = new Set();
  let preloadHooked = false;
  const knowSession = (ses) => {
    if (!ses || sessions.has(ses)) return;
    sessions.add(ses);
    for (const p of preloads) ses.registerPreloadScript(p);
  };

  const trustedSender = (event) => {
    const wc = event.sender;
    const win = wc && BrowserWindow.fromWebContents(wc);
    const mainFrame = !event.senderFrame || !wc.mainFrame || event.senderFrame === wc.mainFrame;
    return !!win && mainFrame;
  };
  return {
    app: {
      on: (event, fn) => app.on(event, fn),
      getAppPath: () => app.getAppPath(),
      quit: () => app.quit(),
      relaunch: () => app.relaunch(),
      exit: (code) => app.exit(code),
    },
    session: {
      /** Registers for the default session and every session created later (the app may use partitions). */
      registerPreloadScript(opts) {
        const p = { type: opts.type, filePath: opts.filePath };
        preloads.push(p);
        for (const ses of sessions) ses.registerPreloadScript(p);
        // Registered during/after the ready event (the framework may start only after the concurrency warning): the default session
        // exists now, and the app's own first window must already see the preload.
        try { if (typeof app.isReady === 'function' && app.isReady()) knowSession(e.session && e.session.defaultSession); } catch { /* not available yet */ }
        if (preloadHooked) return;
        preloadHooked = true;
        app.on('session-created', (ses) => knowSession(ses));
        app.whenReady().then(() => knowSession(e.session.defaultSession));
      },
    },
    createChannel() { return new MessageChannelMain(); },
    onWindowCreated(fn) {
      const seen = new Set();
      const notify = (win) => {
        const id = win.webContents.id;
        if (seen.has(id)) return;
        seen.add(id); fn(win, id);
      };
      app.on('browser-window-created', (_event, win) => notify(win));
      // the app window focused last, for focusedWindow while the app is in the background
      app.on('browser-window-focus', (_event, win) => { const id = win && !win.isDestroyed() ? win.webContents.id : null; if (id !== null) lastFocused = id; });
      for (const w of BrowserWindow.getAllWindows()) notify(w);
    },
    postToWindow(windowId, channel, message, transfer) {
      const wc = wcOf(windowId);
      if (wc && !wc.isDestroyed()) wc.postMessage(channel, message, transfer);
    },
    /** Whether an app window with this id is open (the graph's Window acts on it, docs/design/systems.md S10). */
    hasWindow(windowId) {
      const wc = wcOf(windowId);
      return !!wc && !wc.isDestroyed();
    },
    /** Bring an app window to the front, as the app's main shows one: restored, shown, the app focused, the window focused. */
    focusWindow(windowId) {
      const win = winOf(windowId);
      if (!win || win.isDestroyed()) return false;
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      if (typeof win.show === 'function') win.show();
      if (process.platform === 'darwin' && typeof app.focus === 'function') app.focus({ steal: true });
      win.focus();
      return true;
    },
    /**
     * The app window the user is in: the focused one, else the one focused last that is still open (the app in the background); null
     * when no app window is open (a mod's Dialog opens there, docs/design/systems.md "E7 in detail" decision 7).
     */
    /** Whether an app window is focused now (the app in front): a mod's notification is a toast there then, else on the desktop. */
    appFocused() {
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && !focused.isDestroyed();
    },
    focusedWindow() {
      const focused = BrowserWindow.getFocusedWindow();
      const id = focused && !focused.isDestroyed() ? focused.webContents.id : null;
      if (id !== null) { lastFocused = id; return id; }
      return lastFocused !== null && this.hasWindow(lastFocused) ? lastFocused : null;
    },
    /**
     * The Dock's badge (E7.6b): installed once, it keeps the app's own count (its setBadgeCount calls pass through only while nothing is
     * held). `hold(value)` shows a count, or text where the Dock shows text (`text`: macOS), or `{add: n}` the app's own count and n (kept
     * as the app's count changes), or with null the app's latest count again.
     * Null when the app has no badge to set. (A download's own `app.badgeCount =` cannot be wrapped: it shows until the next set.)
     */
    badge() {
      if (badgeHold) return badgeHold;
      if (typeof app.setBadgeCount !== 'function') return null;
      const original = app.setBadgeCount.bind(app);
      const dock = app.dock && typeof app.dock.setBadge === 'function' ? app.dock : null;
      const st = { app: typeof app.getBadgeCount === 'function' ? app.getBadgeCount() : 0, held: null, text: false };
      const added = () => st.held !== null && typeof st.held === 'object';
      app.setBadgeCount = function setBadgeCount(n) { st.app = n; return st.held === null ? original(n) : added() ? original((Number(n) || 0) + st.held.add) : true; };
      badgeHold = {
        text: !!dock,
        hold(value) {
          if (st.text) { dock.setBadge(''); st.text = false; }
          st.held = value === undefined ? null : value;
          if (st.held === null) return original(st.app);
          if (added()) return original((Number(st.app) || 0) + st.held.add);
          if (typeof st.held === 'string') { if (!dock) return false; dock.setBadge(st.held); st.text = true; return true; }
          return original(st.held);
        },
      };
      return badgeHold;
    },
    /** The Dock asks for the user's attention (public-hooks.md §3.14): one bounce (informational) or until the app comes forward (critical). */
    attention(kind) {
      if (!app.dock || typeof app.dock.bounce !== 'function') return false;
      app.dock.bounce(kind === 'critical' ? 'critical' : 'informational');
      return true;
    },
    /**
     * The application menu as the mods' entries join it (mod-surfaces.md §3.4, E8.4): installed once, it keeps the app's latest menu (the
     * app builds a new one on every window focus and keymap change) and installs, in its place, what `compose(appMenu)` makes of it: a new
     * Menu that reuses the app's own items and adds the mods'. The app's Menu object is never changed; with no compose, or one that throws,
     * the app's own menu is installed as it is. Null without Electron's Menu.
     */
    menuBar() {
      if (menuHold) return menuHold;
      const adapter = this;
      if (!Menu || typeof Menu.setApplicationMenu !== 'function' || typeof MenuItem !== 'function') return null;
      const original = Menu.setApplicationMenu.bind(Menu);
      const st = { app: typeof Menu.getApplicationMenu === 'function' ? Menu.getApplicationMenu() : null, compose: null, told: new Set() };
      const install = (menu) => {
        let out = menu;
        if (menu && st.compose) { try { out = st.compose(menu) || menu; } catch { out = menu; } }
        return original(out);
      };
      Menu.setApplicationMenu = function setApplicationMenu(menu) {
        st.app = menu;
        const out = install(menu);
        for (const fn of [...st.told]) { try { fn(menu); } catch { /* a listener's own fault */ } }
        return out;
      };
      menuHold = {
        Menu, MenuItem,
        /** The composer of the installed menu; the app's latest menu is composed again at once. */
        setCompose(fn) { st.compose = typeof fn === 'function' ? fn : null; if (st.app) install(st.app); },
        /** The app's own latest menu (not the composed one). */
        appMenu: () => st.app,
        /** Each menu the app installs from now on (its entries change with focus, keymap and locale). */
        onAppMenu(fn) { st.told.add(fn); return () => st.told.delete(fn); },
        /** One of the app's items chosen as a click on it chooses it: with the app window in front (the one focused last). */
        choose(item) {
          const id = adapter.focusedWindow();
          const w = id === null ? null : winOf(id);
          item.click({ triggeredByAccelerator: false }, w && !w.isDestroyed() ? w : undefined, w && !w.isDestroyed() ? w.webContents : undefined);
        },
      };
      return menuHold;
    },
    /** Ask an app window to close, as its close button does: the app's own close handler decides (it may hide its last window). */
    closeWindow(windowId) {
      const win = winOf(windowId);
      if (!win || win.isDestroyed()) return false;
      win.close();
      return true;
    },
    /**
     * framework-main only: hold one kind of the app's pages' messages to its main side, on `channel` (its messages, or the git worker's
     * requests): `fn(windowId, msg, page)` answers the message to deliver (changed or not), null to not deliver it, or `{reply: [channel,
     * message]}` to answer it so instead; `page.replies(channel, fn)` hears what the app sends that page; null lets it go again.
     */
    holdAppMessage(type, fn, channel = APP_MESSAGES) {
      if (!HELD_CHANNELS.has(channel)) throw new Error(`framework-main holds no messages on ${channel}`);
      if (typeof fn === 'function') messageHolds.set(`${channel}\n${type}`, fn); else messageHolds.delete(`${channel}\n${type}`);
    },
    handle(channel, fn) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!trustedSender(event, channel)) throw new Error('Denied: untrusted sender');
        return fn(event.sender.id, ...args);
      });
    },
    /** A synchronous request (ipcRenderer.sendSync), for what a page needs before its first render; an untrusted sender gets null. */
    handleSync(channel, fn) {
      ipcMain.on(channel, (event, ...args) => {
        try { event.returnValue = trustedSender(event, channel) ? (fn(event.sender.id, ...args) ?? null) : null; } catch { event.returnValue = null; }
      });
    },
    async showOpenDialog(windowId, opts) {
      const win = winOf(windowId);
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : r.filePaths;
    },
    async showMessageBox(opts) {
      const r = await dialog.showMessageBox({ type: 'question', message: opts.message, buttons: opts.buttons, defaultId: 0, cancelId: opts.buttons.length - 1 });
      return r.response;
    },
    /**
     * A question only the user can answer (graph approvals, runtime-core.md R17): the app's native dialog, on the focused app window when
     * there is one. Don't Allow is the first button, the default and the cancel; `checkboxLabel` adds a checkbox; `signal` (an
     * AbortSignal) closes it unanswered. Resolves `{allowed, checked}`.
     */
    async askUser({ message, detail, checkboxLabel, signal }) {
      const options = {
        type: 'warning', message: String(message), detail: String(detail ?? ''), buttons: ['Don\u2019t Allow', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
        ...(checkboxLabel ? { checkboxLabel: String(checkboxLabel), checkboxChecked: false } : {}), ...(signal ? { signal } : {}),
      };
      const focused = BrowserWindow.getFocusedWindow();
      const win = focused ?? null;
      const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      return { allowed: !(signal && signal.aborted) && r.response === 1, checked: r.checkboxChecked === true };
    },
    /** Shows a file or folder in Finder (its parent opens with it selected). An absolute path only. */
    revealPath(p) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('revealPath needs an absolute path');
      shell.showItemInFolder(p);
    },
    /** Quit the app the way Cmd+Q does: its own before-quit handlers (and their dialogs) decide. */
    quitApp() { app.quit(); },
    /** `fn()` when the app starts to quit (Electron's before-quit); returns the unsubscribe. */
    onBeforeQuit(fn) { const h = () => { try { fn(); } catch { /* the listener's fault */ } }; app.on('before-quit', h); return () => app.removeListener('before-quit', h); },
    /** Click the first item of one of the app's own menus (`menuId`, the id the app gives it, such as `help-menu`) as its menu service's
     *  invokeItem does, for the window `windowId`; returns the item's label, or null when the menu has none. Straight from the application
     *  menu: the service's ids last only until the window's page takes its next snapshot, and the app rebuilds its menu as focus moves. */
    clickAppMenuItem(menuId, windowId) {
      const menu = Menu && typeof Menu.getApplicationMenu === 'function' ? Menu.getApplicationMenu() : null;
      const parent = menu ? menu.getMenuItemById(menuId) : null;
      const item = ((parent && parent.submenu && parent.submenu.items) || []).find((x) => x.visible && x.enabled && x.type === 'normal');
      if (!item) return null;
      const win = winOf(windowId);
      item.click({ triggeredByAccelerator: false }, win || undefined, win ? win.webContents : undefined);
      return item.label || '';
    },
    /** Open an https page in the user's browser (shell.openExternal), or an http one on this Mac's loopback (a local server's sign-in
     *  page, as native apps use: RFC 8252 §7.3). */
    openExternal(url) {
      let u = null;
      try { u = typeof url === 'string' ? new URL(url) : null; } catch { /* refused below */ }
      const ok = u && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)));
      if (!ok) throw new Error('openExternal needs an https URL (or http on this Mac\'s loopback)');
      return shell.openExternal(url);
    },
    /** The appearance the system resolves now (the app's theme mode applied): 'light' or 'dark'. */
    systemAppearance() { return nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; },
    /** `fn(appearance)` when it changes (Electron's nativeTheme `updated`); returns the unsubscribe. */
    onSystemAppearance(fn) {
      if (!nativeTheme || typeof nativeTheme.on !== 'function') return () => {};
      const h = () => { try { fn(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'); } catch { /* the listener's fault */ } };
      nativeTheme.on('updated', h);
      return () => nativeTheme.removeListener('updated', h);
    },
    appUrl() {
      for (const w of BrowserWindow.getAllWindows()) {
        const u = w.webContents.getURL();
        if (u && u !== 'about:blank') return u;
      }
      return DEFAULT_APP_URL;
    },

    // ---- framework-main only ---------------------------------------------------------------------------------------------
    /**
     * Registers the scheme as privileged. Electron allows ONE registerSchemesAsPrivileged call, before app ready, and the app
     * makes its own (its Sentry bootstrap even Proxy-wraps it). So we wrap the function: whoever calls it, our scheme is merged
     * into that single call. If nobody has called it by 'will-finish-launching', we make the call ourselves.
     */
    registerScheme(scheme) {
      const privileges = { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true };
      const original = protocol.registerSchemesAsPrivileged;
      let done = false;
      const merge = (list) => {
        const mine = { scheme, privileges };
        const rest = (Array.isArray(list) ? list : []).filter((c) => !c || c.scheme !== scheme);
        return [...rest, mine];
      };
      const wrapped = function registerSchemesAsPrivileged(list) {
        done = true;
        return original.call(protocol, merge(list));
      };
      try { protocol.registerSchemesAsPrivileged = wrapped; } catch { /* read-only: fall back to registering ourselves below */ }
      app.on('will-finish-launching', () => { if (!done) { done = true; original.call(protocol, merge([])); } });
      if (protocol.registerSchemesAsPrivileged !== wrapped) { done = true; original.call(protocol, merge([])); }
    },
    /**
     * The framework's own scheme is exempt from the APP's network filters: the app's "desktop network policy" registers
     * session.webRequest.onBeforeRequest and cancels URLs outside its allowlist (everything, while the policy is still loading),
     * which blocked the first codexmod:// renderer import of each boot before our protocol handler saw it.
     * NARROW by design: only webRequest.onBeforeRequest, only for URLs that start with `<scheme>://`. For those the wrapper answers
     * callback({}) (allow) without calling the app's listener; every other request reaches the app's listener unchanged (same
     * details, same callback). The optional filter argument and de-registration with null/undefined pass through as the app gave them.
     * Applied to the default session (once ready) and to every session created later; must run before app main registers.
     */
    exemptSchemeFromAppNetworkFilters(scheme) {
      const prefix = `${scheme}://`;
      const done = new WeakSet();
      const wrap = (ses) => {
        try {
          const wr = ses && ses.webRequest;
          if (!wr || typeof wr.onBeforeRequest !== 'function' || done.has(wr)) return;
          done.add(wr);
          const original = wr.onBeforeRequest.bind(wr);
          const around = (listener) => (typeof listener === 'function'
            ? (details, callback) => (details && typeof details.url === 'string' && details.url.startsWith(prefix) ? callback({}) : listener(details, callback))
            : listener);
          wr.onBeforeRequest = function onBeforeRequest(...args) {
            // (listener) | (filter, listener) | (null) | (filter, null)
            if (args.length >= 2) return original(args[0], around(args[1]));
            return original(around(args[0]));
          };
        } catch { /* a session without a patchable webRequest: the app's own filter then applies */ }
      };
      app.on('session-created', (ses) => wrap(ses));
      app.on('ready', () => wrap(e.session && e.session.defaultSession));      // our listener precedes the app's own 'ready' handler
      app.whenReady().then(() => wrap(e.session && e.session.defaultSession));
    },
    /** handler(url, method) -> {status, headers, body}; installed once the app is ready. */
    handleProtocol(scheme, handler) {
      app.whenReady().then(() => {
        protocol.handle(scheme, async (request) => {
          const r = await handler(request.url, request.method);
          return new Response(r.body, { status: r.status, headers: r.headers });
        });
      });
    },
  };
}

module.exports = { createElectronAdapter };
