// electron-adapter.cjs driven by a fake electron object (real Electron behavior is verified in native acceptance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createElectronAdapter } = createRequire(import.meta.url)('./electron-adapter.cjs');

function fake() {
  const appHandlers = {}, wcs = new Map(), wins = [], ipc = {}, st = { dialogs: [], revealed: [], sessions: [], protocolHandlers: {}, privileged: [], forks: [], ready: false };
  let readyCbs = [];
  class WC { constructor(id) { this.id = id; this.posted = []; this.mainFrame = { id: 'main' }; this.url = ''; this.destroyed = false; wcs.set(id, this); }
    postMessage(ch, m, t) { this.posted.push([ch, m, t]); } isDestroyed() { return this.destroyed; } getURL() { return this.url; } loadURL(u) { this.url = u; } close() { this.destroyed = true; } }
  class Win { constructor(idOrOpts) { const id = typeof idOrOpts === 'object' ? nextId++ : idOrOpts; this.opts = typeof idOrOpts === 'object' ? idOrOpts : undefined; this.webContents = new WC(id); this.browserViews = []; this.addBrowserView = (v) => { this.browserViews.push(v); }; this.removeBrowserView = (v) => { this.browserViews = this.browserViews.filter((x) => x !== v); }; this.contentView = { views: [], addChildView(v) { this.views.push(v); }, removeChildView(v) { this.views = this.views.filter((x) => x !== v); } }; this.destroyed = false; wins.push(this); }
    loadURL(u) { this.webContents.url = u; } close() { this.destroyed = true; } isDestroyed() { return this.destroyed; } on() {}
    isMinimized() { return this.minimized === true; } restore() { this.minimized = false; } show() { this.shown = true; } focus() { this.focused = true; } }
  let nextId = 100;
  const sessionObj = () => ({ preloads: [], registerPreloadScript(p) { this.preloads.push(p); },
    webRequest: { regs: [], onBeforeRequest(...a) { this.regs.push(a); } } });
  const defaultSession = sessionObj();
  const electron = {
    st, wcs, wins, ipc, appHandlers, defaultSession,
    app: { on: (e, f) => (appHandlers[e] ??= []).push(f), getAppPath: () => '/x', quit() {}, relaunch() {}, exit() {},
      isReady: () => st.ready, whenReady: () => new Promise((r) => { if (st.ready) r(); else readyCbs.push(r); }) },
    BrowserWindow: Object.assign(Win, { getAllWindows: () => wins, fromWebContents: (wc) => wins.find((w) => w.webContents === wc) || null }),
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: (ch, fn) => { ipc[ch] = fn; } },
    dialog: { showOpenDialog: async (...a) => { st.dialogs.push(a); return { canceled: false, filePaths: ['/f'] }; }, showMessageBox: async () => ({ response: 1 }) },
    shell: { showItemInFolder: (p) => st.revealed.push(p), openExternal: (u) => { (st.opened ??= []).push(u); } },
    session: { defaultSession },
    protocol: { registerSchemesAsPrivileged: (l) => st.privileged.push(l), handle: (s, fn) => { st.protocolHandlers[s] = fn; } },
    webContents: { fromId: (id) => wcs.get(id) || null },
    makeReady: async () => { st.ready = true; readyCbs.forEach((r) => r()); readyCbs = []; await new Promise((r) => setImmediate(r)); },
    newWindow(id) { const w = new Win(id); (appHandlers['browser-window-created'] ?? []).forEach((f) => f({}, w)); return w; },
    newSession() { const s = sessionObj(); (appHandlers['session-created'] ?? []).forEach((f) => f(s)); return s; },
  };
  return electron;
}

test('onWindowCreated reports existing and future windows with their webContents id', () => {
  const e = fake(); const a = createElectronAdapter(e);
  e.newWindow(1);
  const seen = [];
  a.onWindowCreated((_w, id) => seen.push(id));
  e.newWindow(2);
  assert.deepEqual(seen, [1, 2]);
});

test('postToWindow targets webContents.postMessage and ignores unknown or destroyed windows', () => {
  const e = fake(); const a = createElectronAdapter(e);
  const w = e.newWindow(7);
  a.postToWindow(7, 'codexmods:port', { m: 1 }, ['p']);
  a.postToWindow(99, 'x', {});
  w.webContents.destroyed = true; a.postToWindow(7, 'x', {});
  assert.deepEqual(w.webContents.posted, [['codexmods:port', { m: 1 }, ['p']]]);
});

test('handle: app windows pass, unknown senders and subframes are Denied', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  const w = e.newWindow(3);
  a.handle('codexmods:ping', (windowId, x) => `${windowId}:${x}`);
  const call = (ev, ...args) => e.ipc['codexmods:ping'](ev, ...args);
  assert.equal(await call({ sender: w.webContents, senderFrame: w.webContents.mainFrame }, 'a'), '3:a');
  assert.throws(() => call({ sender: { id: 999, mainFrame: {} }, senderFrame: {} }, 'a'), /Denied/);
  assert.throws(() => call({ sender: w.webContents, senderFrame: { id: 'iframe' } }, 'a'), /Denied/);
});

test('dialogs: null on cancel, paths otherwise, button index for message boxes', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  e.newWindow(3);
  assert.deepEqual(await a.showOpenDialog(3, { properties: ['openFile'] }), ['/f']);
  e.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await a.showOpenDialog(3, { properties: [] }), null);
  assert.equal(await a.showMessageBox({ message: 'm', buttons: ['a', 'b'] }), 1);
});

test('askUser: the native dialog with Don\'t Allow first, on the focused app window; an abort answers no', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  const seen = [];
  e.dialog.showMessageBox = async (...args) => { seen.push(args); return { response: 1, checkboxChecked: true }; };
  e.BrowserWindow.getFocusedWindow = () => null;
  assert.deepEqual(await a.askUser({ message: 'm', detail: 'd', checkboxLabel: 'c' }), { allowed: true, checked: true });
  assert.deepEqual(seen[0], [{ type: 'warning', message: 'm', detail: 'd', buttons: ['Don\u2019t Allow', 'Allow'], defaultId: 0, cancelId: 0, noLink: true, checkboxLabel: 'c', checkboxChecked: false }]);
  const w = e.newWindow(5);
  e.BrowserWindow.getFocusedWindow = () => w;
  const ac = new AbortController();
  await a.askUser({ message: 'm', signal: ac.signal });
  assert.equal(seen[1][0], w, 'a sheet on the focused window');
  assert.equal(seen[1][1].signal, ac.signal);
  e.dialog.showMessageBox = async () => { ac.abort(); return { response: 1 }; };
  assert.deepEqual(await a.askUser({ message: 'm', signal: ac.signal }), { allowed: false, checked: false });
});

test('revealPath: absolute paths go to the shell, anything else throws', () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.revealPath('/Users/x/repo');
  assert.deepEqual(e.st.revealed, ['/Users/x/repo']);
  for (const bad of ['repo', '', null]) assert.throws(() => a.revealPath(bad), /absolute path/);
  assert.deepEqual(e.st.revealed, ['/Users/x/repo']);
});

test('openExternal: https pages, and http only on the loopback; anything else throws', () => {
  const e = fake(); const a = createElectronAdapter(e);
  for (const url of ['https://auth.example.com/login', 'http://127.0.0.1:18765/authorize?x=1', 'http://localhost:9000/cb', 'http://[::1]:9/x']) a.openExternal(url);
  assert.deepEqual(e.st.opened, ['https://auth.example.com/login', 'http://127.0.0.1:18765/authorize?x=1', 'http://localhost:9000/cb', 'http://[::1]:9/x']);
  for (const bad of ['http://auth.example.com', 'http://127.0.0.1.example.com', 'file:///tmp/a', 'javascript:alert(1)', 'not a url', '', null]) assert.throws(() => a.openExternal(bad), /needs an https URL/);
  assert.equal(e.st.opened.length, 4);
});

test('appUrl: the first app window URL, else the default', () => {
  const e = fake(); const a = createElectronAdapter(e);
  assert.equal(a.appUrl(), 'app://-/index.html');
  const w = e.newWindow(1); w.webContents.url = 'app://-/index.html#/x';
  assert.equal(a.appUrl(), 'app://-/index.html#/x');
});

test('registerPreloadScript reaches the default session after ready, later sessions, and later registrations', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.session.registerPreloadScript({ type: 'frame', filePath: '/p1.js' });
  assert.deepEqual(e.defaultSession.preloads, []);
  await e.makeReady();
  assert.deepEqual(e.defaultSession.preloads, [{ type: 'frame', filePath: '/p1.js' }]);
  const s2 = e.newSession();
  assert.deepEqual(s2.preloads, [{ type: 'frame', filePath: '/p1.js' }]);
  a.session.registerPreloadScript({ type: 'frame', filePath: '/p2.js' });
  assert.equal(e.defaultSession.preloads.length, 2); assert.equal(s2.preloads.length, 2);
});

const PRIV = { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true };

test('registerScheme merges codexmod into the app\'s single registerSchemesAsPrivileged call (also through the app\'s proxy wrapper)', () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.registerScheme('codexmod');
  assert.equal(e.st.privileged.length, 0, 'nothing registered yet: the app has not made its call');
  // the app's Sentry bootstrap wraps whatever is installed now, then the app calls it with its own schemes
  const installed = e.protocol.registerSchemesAsPrivileged;
  e.protocol.registerSchemesAsPrivileged = (list) => installed.call(e.protocol, list);
  e.protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true } }]);
  assert.equal(e.st.privileged.length, 1, 'exactly one underlying call');
  assert.deepEqual(e.st.privileged[0], [{ scheme: 'app', privileges: { standard: true } }, { scheme: 'codexmod', privileges: PRIV }]);
  (e.appHandlers['will-finish-launching'] ?? []).forEach((f) => f());
  assert.equal(e.st.privileged.length, 1, 'no second call once the app made its own');
});

test('registerScheme registers on its own at will-finish-launching when the app never calls', () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.registerScheme('codexmod');
  e.appHandlers['will-finish-launching'].forEach((f) => f());
  assert.deepEqual(e.st.privileged, [[{ scheme: 'codexmod', privileges: PRIV }]]);
});

test('registerScheme registers immediately when the function cannot be wrapped', () => {
  const e = fake();
  Object.freeze(e.protocol);
  const a = createElectronAdapter(e);
  a.registerScheme('codexmod');
  assert.deepEqual(e.st.privileged, [[{ scheme: 'codexmod', privileges: PRIV }]]);
});

test('handleProtocol installs after ready and builds a Response', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.handleProtocol('codexmod', async (url, method) => ({ status: 200, headers: { 'X-A': '1' }, body: `${method} ${url}` }));
  assert.equal(e.st.protocolHandlers.codexmod, undefined, 'not before ready');
  await e.makeReady();
  const res = await e.st.protocolHandlers.codexmod({ url: 'codexmod://a/1/x', method: 'GET' });
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-a'), '1'); assert.equal(await res.text(), 'GET codexmod://a/1/x');
});

test('hello/pick-file style handlers keep sender validation (only app windows)', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  const w = e.newWindow(4);
  a.handle('codexmods:hello', (windowId, info) => ({ windowId, info }));
  a.handle('codexmods:pick-file', (windowId) => windowId);
  const ok = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  assert.deepEqual(await e.ipc['codexmods:hello'](ok, { v: 1 }), { windowId: 4, info: { v: 1 } });
  assert.equal(await e.ipc['codexmods:pick-file'](ok), 4);
  assert.throws(() => e.ipc['codexmods:hello']({ sender: { id: 77, mainFrame: {} }, senderFrame: {} }), /Denied/);
});

test('createChannel returns a MessageChannelMain pair', () => {
  const e = fake(); const a = createElectronAdapter(e);
  const ch = a.createChannel();
  assert.ok(ch.port1 && ch.port2);
});

// ---- codexmod:// is exempt from the app's webRequest filters
const appRegister = (ses, ...args) => ses.webRequest.onBeforeRequest(...args);
const lastReg = (ses) => ses.webRequest.regs.at(-1);

test('exempt: codexmod:// requests are allowed without reaching the app listener; others reach it unchanged (default and later sessions)', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  await e.makeReady();
  const s2 = e.newSession();
  for (const ses of [e.defaultSession, s2]) {
    const seen = [];
    appRegister(ses, (details, cb) => { seen.push(details.url); cb({ cancel: true }); });   // the app's deny-everything policy
    const [listener] = lastReg(ses);
    const got = [];
    listener({ url: 'codexmod://a.b/1/r.js' }, (r) => got.push(r));
    assert.deepEqual(got, [{}], 'allowed');
    assert.deepEqual(seen, [], 'the app listener never saw it');
    const d = { url: 'https://example.com/x', id: 7 };
    listener(d, (r) => got.push(r));
    assert.deepEqual(seen, ['https://example.com/x'], 'other URLs go to the app listener');
    assert.deepEqual(got.at(-1), { cancel: true }, 'its decision stands (filter semantics preserved)');
  }
});

test('exempt: the optional filter argument is passed through; null de-registration is not wrapped; re-registration replaces', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  await e.makeReady();
  const ses = e.defaultSession;
  const filter = { urls: ['https://*/*'] };
  const fn = (d, cb) => cb({});
  appRegister(ses, filter, fn);
  assert.equal(lastReg(ses)[0], filter, 'filter object untouched');
  assert.equal(typeof lastReg(ses)[1], 'function'); assert.notEqual(lastReg(ses)[1], fn, 'wrapped');
  appRegister(ses, null);
  assert.deepEqual(lastReg(ses), [null], 'removal passes through as given');
  appRegister(ses, filter, null);
  assert.deepEqual(lastReg(ses), [filter, null]);
  appRegister(ses, undefined);
  assert.deepEqual(lastReg(ses), [undefined]);
  const calls = [];
  appRegister(ses, () => calls.push('first'));
  appRegister(ses, (d, cb) => { calls.push('second'); cb({}); });
  lastReg(ses)[0]({ url: 'https://x/' }, () => {});
  assert.deepEqual(calls, ['second'], 'a later registration is what runs');
});

test('exempt: a scheme with a similar prefix is not exempted; only url.startsWith("codexmod://")', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  await e.makeReady();
  const seen = [];
  appRegister(e.defaultSession, (d, cb) => { seen.push(d.url); cb({ cancel: true }); });
  const [l] = lastReg(e.defaultSession);
  for (const url of ['codexmods://x/1/y', 'https://codexmod://x', 'app://-/codexmod://x', 'codexmod:/x']) l({ url }, () => {});
  assert.equal(seen.length, 4);
  l({ url: undefined }, () => {});                // malformed details never throw and go to the app
  assert.equal(seen.length, 5);
});

test('exempt: a session wrapped twice (default session also announced by session-created) is wrapped once', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  (e.appHandlers['session-created'] ?? []).forEach((f) => f(e.defaultSession));
  await e.makeReady();
  let n = 0;
  appRegister(e.defaultSession, (d, cb) => { n++; cb({}); });
  lastReg(e.defaultSession)[0]({ url: 'https://x' }, () => {});
  assert.equal(n, 1);
});

test('exempt: a session without a webRequest, or one that cannot be patched, never breaks startup', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  e.newSession.call(e);
  (e.appHandlers['session-created'] ?? []).forEach((f) => { f({}); f({ webRequest: Object.freeze({ onBeforeRequest() {} }) }); f(null); });
  await e.makeReady();
});

test('exempt: the default session is wrapped at the ready event, before an app ready handler registers its filter', () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.exemptSchemeFromAppNetworkFilters('codexmod');
  e.appHandlers.ready.forEach((f) => f());                                  // our handler runs first
  appRegister(e.defaultSession, (d, cb) => cb({ cancel: true }));           // the app's synchronous registration in its own handler
  const got = [];
  lastReg(e.defaultSession)[0]({ url: 'codexmod://m/1/r.js' }, (r) => got.push(r));
  assert.deepEqual(got, [{}]);
});

test('registerPreloadScript during/after the ready event registers on the default session immediately (the first app window must see it)', () => {
  const e = fake(); const a = createElectronAdapter(e);
  e.st.ready = true;                                // app.isReady() is true inside the ready event
  a.session.registerPreloadScript({ type: 'frame', filePath: '/p-late.js' });
  assert.deepEqual(e.defaultSession.preloads, [{ type: 'frame', filePath: '/p-late.js' }], 'synchronously, not via a later promise');
  a.session.registerPreloadScript({ type: 'frame', filePath: '/p-late2.js' });
  assert.equal(e.defaultSession.preloads.length, 2);
  assert.equal(new Set(e.defaultSession.preloads.map((p) => p.filePath)).size, 2, 'no duplicates');
});

test('hasWindow and focusWindow: app windows only, by their id; focusing restores and shows it first', () => {
  const e = fake(); const a = createElectronAdapter(e);
  const w = e.newWindow(7);
  w.minimized = true;
  assert.equal(a.hasWindow(7), true);
  assert.equal(a.hasWindow(99), false);
  assert.equal(a.focusWindow(7), true);
  assert.deepEqual([w.minimized, w.shown, w.focused], [false, true, true]);
  assert.equal(a.focusWindow(99), false);
  w.webContents.destroyed = true;
  assert.equal(a.hasWindow(7), false);
});

test('focusedWindow (E7.6c): the focused app window, else the app window focused last while it is open', () => {
  const e = fake(); const a = createElectronAdapter(e);
  a.onWindowCreated(() => {});
  const w7 = e.newWindow(7); e.newWindow(9);
  e.BrowserWindow.getFocusedWindow = () => null;
  assert.equal(a.focusedWindow(), null, 'none focused yet');
  e.BrowserWindow.getFocusedWindow = () => w7;
  assert.equal(a.focusedWindow(), 7);
  assert.equal(a.appFocused(), true, 'an app window in front');
  e.BrowserWindow.getFocusedWindow = () => null;
  assert.equal(a.focusedWindow(), 7, 'the app in the background: the one focused last');
  assert.equal(a.appFocused(), false, 'the app in the background (a mod\'s notification goes to the desktop then)');
  const w9 = e.wins.find((w) => w.webContents.id === 9);
  for (const f of e.appHandlers['browser-window-focus'] ?? []) f({}, w9);
  assert.equal(a.focusedWindow(), 9, 'focus events count too');
  w9.webContents.destroyed = true;
  assert.equal(a.focusedWindow(), null, 'gone');
});

test('badge (E7.6b): the app\'s own count passes through while nothing is held, is kept while something is, and comes back; text on the Dock', () => {
  const e = fake();
  const set = [], text = [];
  e.app.setBadgeCount = (n) => { set.push(n); return true; };
  e.app.getBadgeCount = () => 2;
  e.app.dock = { setBadge: (t) => text.push(t) };
  const a = createElectronAdapter(e);
  const b = a.badge();
  assert.equal(a.badge(), b, 'installed once');
  assert.equal(b.text, true);
  e.app.setBadgeCount(4);   // the app's own, nothing held: shown
  b.hold(9);
  e.app.setBadgeCount(5);   // the app's own while held: kept, not shown
  b.hold('NEW');
  b.hold(null);   // back to the app's latest
  assert.deepEqual(set, [4, 9, 5]);
  assert.deepEqual(text, ['NEW', '']);
  // a count added to the app's own (public-hooks.md §3.14 combine: add): kept as the app's count changes
  b.hold({ add: 3 });
  e.app.setBadgeCount(6);
  b.hold(null);
  assert.deepEqual(set, [4, 9, 5, 8, 9, 6]);
  const none = fake();
  assert.equal(createElectronAdapter(none).badge(), null, 'no badge to set');
});

test('attention (public-hooks.md §3.14): the Dock bounces once, or critically; nothing to bounce: false', () => {
  const e = fake();
  const bounced = [];
  e.app.dock = { bounce: (k) => { bounced.push(k); return 1; } };
  const a = createElectronAdapter(e);
  assert.deepEqual([a.attention('informational'), a.attention('critical'), a.attention('other')], [true, true, true]);
  assert.deepEqual(bounced, ['informational', 'critical', 'informational']);
  assert.equal(createElectronAdapter(fake()).attention('critical'), false);
});

test('closeWindow (E7.1): an app window by its id is asked to close, as its close button does; none other', () => {
  const e = fake(); const a = createElectronAdapter(e);
  const w = e.newWindow(7);
  assert.equal(a.closeWindow(99), false);
  assert.equal(a.closeWindow(7), true);
  assert.equal(w.destroyed, true);
  assert.equal(a.closeWindow(7), false, 'gone');
});

test('H7lr: framework-main holds one kind of the app\'s page messages before the app\'s own handler (changed, or not delivered); the rest go straight on', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  const got = [];
  // the app's own handler, registered after framework-main's start
  e.ipcMain.handle('codex_desktop:message-from-view', async (event, msg) => { got.push(msg); return 'app'; });
  const send = (msg, sender = { id: 7 }) => e.ipc['codex_desktop:message-from-view']({ sender }, msg);
  assert.equal(await send({ type: 'open-in-browser', url: 'https://a' }), 'app', 'nothing holds it yet');
  a.holdAppMessage('open-in-browser', async (windowId, msg) => (msg.url === 'https://stop' ? null : { ...msg, openTarget: `held in ${windowId}` }));
  await send({ type: 'open-in-browser', url: 'https://b' });
  assert.equal(await send({ type: 'open-in-browser', url: 'https://stop' }), undefined);
  await send({ type: 'other', x: 1 });
  a.holdAppMessage('open-in-browser', null);
  await send({ type: 'open-in-browser', url: 'https://c' });
  assert.deepEqual(got, [{ type: 'open-in-browser', url: 'https://a' }, { type: 'open-in-browser', url: 'https://b', openTarget: 'held in 7' }, { type: 'other', x: 1 },
    { type: 'open-in-browser', url: 'https://c' }]);
  // a hold that throws: the app's own goes on with the message as it was
  a.holdAppMessage('open-in-browser', () => { throw new Error('broken'); });
  await send({ type: 'open-in-browser', url: 'https://d' });
  assert.deepEqual(got.at(-1), { type: 'open-in-browser', url: 'https://d' });
});

test('H6m2b: the git worker\'s requests are held on their channel; a hold may answer one itself (it is not delivered) and hear what the app sends that page', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  const got = [];
  e.ipcMain.handle('codex_desktop:worker:git:from-view', async (event, msg) => { got.push(msg.request.id); event.sender.send('codex_desktop:worker:git:for-view', { response: { id: msg.request.id } }); });
  const sent = [];
  const sender = { id: 7, send(ch, m) { sent.push([ch, m]); }, isDestroyed: () => false };
  const heard = [];
  a.holdAppMessage('worker-request', (windowId, msg, page) => {
    if (msg.request.id === 'no') return { reply: ['codex_desktop:worker:git:for-view', { refused: true }] };
    page.replies('codex_desktop:worker:git:for-view', (m) => { heard.push(m.response?.id); return m.response?.id === msg.request.id; });
    return msg;
  }, 'codex_desktop:worker:git:from-view');
  await e.ipc['codex_desktop:worker:git:from-view']({ sender }, { type: 'worker-request', request: { id: 'yes' } });
  await e.ipc['codex_desktop:worker:git:from-view']({ sender }, { type: 'worker-request', request: { id: 'no' } });
  assert.deepEqual(got, ['yes'], 'the refused one never reached the app');
  assert.deepEqual(sent, [['codex_desktop:worker:git:for-view', { response: { id: 'yes' } }], ['codex_desktop:worker:git:for-view', { refused: true }]]);
  assert.deepEqual(heard, ['yes']);
  assert.throws(() => a.holdAppMessage('x', () => null, 'some:other:channel'), /holds no messages/);
});

test('H6m2b review: a held request\'s page going (closed, crashed, loaded again; not a frame\'s or an in-page navigation) is told once; a disposed listener is not', async () => {
  const e = fake(); const a = createElectronAdapter(e);
  e.ipcMain.handle('codex_desktop:worker:git:from-view', async () => {});
  const { EventEmitter } = await import('node:events');
  const pageOf = () => Object.assign(new EventEmitter(), { id: 7, send() {}, isDestroyed: () => false });
  const gone = [];
  let off = null;
  a.holdAppMessage('worker-request', (windowId, msg, page) => { off = page.gone(() => gone.push(msg.request.id)); return msg; }, 'codex_desktop:worker:git:from-view');
  const ask = async (sender, id) => { await e.ipc['codex_desktop:worker:git:from-view']({ sender }, { type: 'worker-request', request: { id } }); return off; };
  const s1 = pageOf();
  await ask(s1, 'a');
  s1.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  s1.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.deepEqual(gone, []);
  s1.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  s1.emit('destroyed');
  assert.deepEqual(gone, ['a'], 'once');
  assert.equal(s1.listenerCount('destroyed'), 0, 'its listeners removed');
  const s2 = pageOf();
  (await ask(s2, 'b'))();
  s2.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(gone, ['a'], 'disposed');
  const s3 = pageOf();
  await ask(s3, 'c');
  s3.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(gone, ['a', 'c']);
});
