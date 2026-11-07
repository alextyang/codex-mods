// framework-main logic through a fake electron adapter (no Electron needed).
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from '../../contracts/layout.mjs';

const require = createRequire(import.meta.url);
const { start, contentsDir, readBundleVersions, runningAppPathOf } = require('./index.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = JSON.parse(readFileSync(join(here, '..', '..', 'tests', 'integration', 'fixtures', 'adapter.json'), 'utf8'));

let root, L, contents, savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'cm-main-'));
  L = layout(root, 'default');
  contents = join(root, 'Fake.app', 'Contents');
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist><dict>
    <key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string>
    <key>CFBundleVersion</key><string>456</string></dict></plist>`);
  mkdirSync(L.framework, { recursive: true });
  writeFileSync(L.frameworkCurrent, 'fw9\n');
  mkdirSync(L.profileDir, { recursive: true });
  writeFileSync(L.profileConfig, JSON.stringify({ codexHome: join(root, 'ch'), guardStockApp: true, signingIdentity: '-', appPath: '/x' }));
});
afterEach(() => {
  mock.timers.reset();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

const installAdapter = (patch = {}) => {
  const dir = join(L.adapters, '1.2.3-456');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'adapter.json'), JSON.stringify({ ...ADAPTER, ...patch }));
};

function fakeElectron() {
  const appHandlers = {}, children = [], calls = { relaunch: 0, exit: [], quit: 0, schemes: [], windows: [] };
  let protocolHandler = null, windowCb = null;
  const e = {
    calls, children,
    app: {
      on: (ev, fn) => { (appHandlers[ev] ??= []).push(fn); },
      getAppPath: () => join(contents, 'Resources', 'app.asar'),
      quit: () => { calls.quit++; e.lastQuit = e.simulateQuit(); }, relaunch: () => { calls.relaunch++; }, exit: (c) => { calls.exit.push(c); },
    },
    spawnHost(o) {
      const exitFns = [], msgFns = [];
      const c = { spawnOpts: o, entry: o.entry, posted: [], killed: 0,
        postMessage: (m) => c.posted.push({ m }), onMessage: (fn) => msgFns.push(fn), onExit: (fn) => exitFns.push(fn), kill: () => { c.killed++; },
        emit: (m) => msgFns.forEach((f) => f(m)), exit: (code = 1) => exitFns.forEach((f) => f(code)) };
      children.push(c); return c;
    },
    registerScheme: (s) => calls.schemes.push(s),
    exemptSchemeFromAppNetworkFilters: (s) => { (calls.exempt ??= []).push(s); },
    handleProtocol: (s, h) => { protocolHandler = h; },
    onWindowCreated: (fn) => { windowCb = fn; },
    emitApp: (ev, ...a) => (appHandlers[ev] || []).forEach((f) => f(...a)),
    /** Electron's quit sequence: before-quit (a listener may preventDefault = cancel), then will-quit (preventDefault holds the quit). */
    simulateQuit() {
      const be = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (appHandlers['before-quit'] || []).forEach((f) => f(be));
      if (be.defaultPrevented) return 'cancelled';
      const wq = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (appHandlers['will-quit'] || []).forEach((f) => f(wq));
      return wq.defaultPrevented ? 'held' : 'quitting';
    },
    get protocolHandler() { return protocolHandler; },
    createWindowEvent(id, visible = false) {
      const win = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, isVisible: () => visible };
      windowCb(win, id); return win;
    },
  };
  return e;
}
const run = (extra = {}, safe = false) => {
  const electron = fakeElectron();
  const modules = { './views/index.cjs': extra.views, './recovery/index.cjs': extra.recovery, './read-state.cjs': extra.readState, './projects.cjs': extra.projects, './approvals.cjs': extra.approvals };
  const loadModule = (name) => {
    if (modules[name] === undefined) { const e = new Error(`Cannot find module '${name}'`); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return modules[name];
  };
  const global = extra.global ?? {};   // where `__codexmods` lives: each run gets its own, so the hold of one run never chains into the next
  const result = start({ root, profile: 'default', safe }, { electron, loadModule, spawnHost: (o) => electron.spawnHost(o), global });
  return { electron, result, global };
};
const logText = () => (existsSync(join(L.logs, 'main.log')) ? readFileSync(join(L.logs, 'main.log'), 'utf8') : '');

test('contentsDir and readBundleVersions', () => {
  assert.equal(contentsDir('/a/B.app/Contents/Resources/app.asar'), '/a/B.app/Contents');
  assert.equal(contentsDir('/a/B.app/Contents'), '/a/B.app/Contents');
  assert.equal(contentsDir('/plain/dir'), null);
  assert.deepEqual(readBundleVersions(join(contents, 'Info.plist')), { short: '1.2.3', build: '456' });
  assert.equal(readBundleVersions('/nonexistent'), null);
});

test('start: env set before return, Host spawned on the bundled Node with init options (override: the codex path itself)', () => {
  installAdapter();
  mkdirSync(join(L.framework, 'fw9'), { recursive: true });
  writeFileSync(join(L.framework, 'fw9', 'package.json'), JSON.stringify({ version: '9.9.9' }));
  process.env.CODEX_CLI_PATH = '/the/relay';
  const { electron } = run();
  assert.equal(process.env.CODEX_MODS_RUN_DIR, L.run);
  assert.equal(process.env.CODEX_MODS_FLAGS_DIR, L.flags);
  assert.equal(process.env.CODEX_MODS_REAL_CODEX, join(contents, 'Resources/codex'));
  assert.ok(existsSync(L.run) && existsSync(L.flags));
  assert.equal(electron.children.length, 1);
  const c = electron.children[0];
  assert.equal(c.entry, join(L.framework, 'fw9', 'framework', 'host', 'entry-node.mjs'));
  assert.equal(c.spawnOpts.nodePath, join(contents, 'Resources/cua_node/bin/node'));
  assert.equal(c.spawnOpts.logFile, join(L.logs, 'host-stdio.log'));
  assert.equal(c.spawnOpts.env.CODEX_CLI_PATH, undefined, 'the Host must not inherit the relay override');
  assert.equal(process.env.CODEX_CLI_PATH, '/the/relay', 'main keeps it for the app');
  const init = c.posted[0].m;
  assert.equal(init.type, 'init');
  assert.deepEqual(init.options, {
    layout: JSON.parse(JSON.stringify(L)), profile: { codexHome: join(root, 'ch'), guardStockApp: true, signingIdentity: '-', appPath: '/x' },
    adapterDir: join(L.adapters, '1.2.3-456'), realCodexPath: join(contents, 'Resources/codex'),
    frameworkVersion: '9.9.9', appBuild: '1.2.3-456', safeMode: false,
  });
  assert.deepEqual(electron.calls.schemes, ['codexmod']);
});

test('frameworkVersion falls back to framework/current when package.json has no version', () => {
  installAdapter();
  const { electron } = run();
  assert.equal(electron.children[0].posted[0].m.options.frameworkVersion, 'fw9');
});

test('replace mode: the real binary is <codexPath>.real', () => {
  installAdapter({ backend: { codexPath: 'Resources/codex', nodePath: 'Resources/cua_node/bin/node', method: 'replace' } });
  const { electron } = run();
  assert.equal(process.env.CODEX_MODS_REAL_CODEX, join(contents, 'Resources/codex') + '.real');
  assert.equal(electron.children[0].posted[0].m.options.realCodexPath, join(contents, 'Resources/codex') + '.real');
});

test('an adapter without backend.nodePath runs unmodded and drops the relay override', () => {
  installAdapter({ backend: { codexPath: 'Resources/codex', method: 'override' } });
  process.env.CODEX_CLI_PATH = '/the/relay';
  const { electron } = run();
  assert.equal(electron.children.length, 0);
  assert.equal(process.env.CODEX_CLI_PATH, undefined);
  assert.equal(JSON.parse(readFileSync(join(L.flags, 'safe'), 'utf8')).reason, 'no-node');
});

test('safe is passed through to the Host', () => {
  installAdapter();
  const { electron } = run({}, true);
  assert.equal(electron.children[0].posted[0].m.options.safeMode, true);
});

test('no adapter: safe flag {reason:no-adapter}, nothing started, env untouched, relay override dropped', () => {
  delete process.env.CODEX_MODS_RUN_DIR;
  process.env.CODEX_CLI_PATH = '/the/relay';
  const { electron } = run();
  assert.deepEqual(JSON.parse(readFileSync(join(L.flags, 'safe'), 'utf8')), { reason: 'no-adapter' });
  assert.equal(electron.children.length, 0);
  assert.equal(process.env.CODEX_MODS_RUN_DIR, undefined);
  assert.equal(process.env.CODEX_CLI_PATH, undefined);
});

test('missing profile.json falls back to layout defaults', () => {
  installAdapter(); rmSync(L.profileConfig);
  const { electron } = run();
  assert.equal(electron.children[0].posted[0].m.options.profile.codexHome, L.codexHome);
});

test('exit: relaunch true -> relaunch then exit(0); false -> exit(0) only; no restart afterwards', () => {
  installAdapter();
  let { electron } = run();
  electron.children[0].emit({ type: 'exit', relaunch: true, reason: 'x' });
  assert.equal(electron.calls.relaunch, 1); assert.deepEqual(electron.calls.exit, [0]);
  electron.children[0].exit(0);
  assert.equal(electron.children.length, 1, 'Host death after an exit request is not a crash');
  ({ electron } = run());
  electron.children[0].emit({ type: 'exit', relaunch: false, reason: 'app-switch' });
  assert.equal(electron.calls.relaunch, 0); assert.deepEqual(electron.calls.exit, [0]);
});

test('every Host crash: breadcrumbs and a growing crash count are written, the Host restarted once and the app relaunched', () => {
  installAdapter();
  mkdirSync(L.flags, { recursive: true });
  writeFileSync(join(L.flags, 'boot.json'), JSON.stringify({ generation: 4, startedAt: 't', state: 'booting', unhealthyCount: 0 }));
  const { electron } = run();
  const boot = () => JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8'));
  electron.children[0].emit({ type: 'breadcrumbs', mods: ['a.b', 'c.d'] });
  electron.children[0].exit(139);
  assert.equal(electron.children.length, 2);
  assert.equal(electron.children[1].posted[0].m.type, 'init');
  assert.equal(electron.calls.relaunch, 1); assert.deepEqual(electron.calls.exit, [0]);
  assert.deepEqual(boot().breadcrumbs, ['a.b', 'c.d']);
  assert.equal(boot().hostCrashCount, 1); assert.ok(Date.parse(boot().lastHostCrashAt));
  assert.equal(boot().generation, 4); assert.equal(boot().state, 'booting');
  assert.ok(!existsSync(join(L.flags, 'safe')));
  electron.children[1].emit({ type: 'breadcrumbs', mods: ['c.d'] });
  electron.children[1].exit(139);
  assert.equal(electron.children.length, 2, 'only one restart per run');
  assert.equal(electron.calls.relaunch, 2);
  assert.deepEqual(boot().breadcrumbs, ['c.d']); assert.equal(boot().hostCrashCount, 2);
  assert.ok(!existsSync(join(L.flags, 'safe')), 'no safe flag below three crashes');
  assert.match(logText(), /Host exited unexpectedly/);
});

test('crash count survives relaunch, resets after ten quiet minutes, and a third crash in the window sets the safe flag', () => {
  installAdapter();
  mkdirSync(L.flags, { recursive: true });
  const boot = () => JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8'));
  const crashOnce = () => { const { electron } = run(); electron.children[0].exit(1); };
  writeFileSync(join(L.flags, 'boot.json'), JSON.stringify({ state: 'healthy', unhealthyCount: 0, hostCrashCount: 5, lastHostCrashAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  crashOnce();
  assert.equal(boot().hostCrashCount, 1, 'older than ten minutes: restarts at 1');
  crashOnce();
  assert.equal(boot().hostCrashCount, 2);
  assert.ok(!existsSync(join(L.flags, 'safe')));
  crashOnce();
  assert.equal(boot().hostCrashCount, 3);
  assert.equal(JSON.parse(readFileSync(join(L.flags, 'safe'), 'utf8')).reason, 'host-crash');
});

test('a stale exit event from a replaced Host is ignored', () => {
  installAdapter();
  const { electron } = run();
  electron.children[0].exit(1);
  electron.children[0].exit(1);   // duplicate delivery
  assert.equal(electron.children.length, 2);
  assert.equal(electron.calls.relaunch, 1);
});

test('window events are forwarded and replayed to a restarted Host; shown once, the first time the window is shown', () => {
  installAdapter();
  const { electron } = run();
  const win = electron.createWindowEvent(11);
  const hidden = electron.createWindowEvent(12);
  win.handlers.show(); win.handlers.show();
  win.handlers.focus();
  const first = electron.children[0].posted.map((p) => p.m).filter((m) => m.type === 'window');
  assert.deepEqual(first, [{ type: 'window', event: 'created', windowId: 11 }, { type: 'window', event: 'created', windowId: 12 },
    { type: 'window', event: 'shown', windowId: 11 }, { type: 'window', event: 'focused', windowId: 11 }]);
  electron.children[0].exit(1);
  assert.deepEqual(electron.children[1].posted.map((p) => p.m).filter((m) => m.type === 'window'), [{ type: 'window', event: 'created', windowId: 11 },
    { type: 'window', event: 'shown', windowId: 11 }, { type: 'window', event: 'created', windowId: 12 }]);
  win.handlers.closed();
  assert.deepEqual(electron.children[1].posted.at(-1).m, { type: 'window', event: 'closed', windowId: 11 });
  hidden.handlers.closed();
  const visible = electron.createWindowEvent(13, true);
  assert.deepEqual(electron.children[1].posted.slice(-2).map((p) => p.m), [{ type: 'window', event: 'created', windowId: 13 }, { type: 'window', event: 'shown', windowId: 13 }], 'visible when created');
  visible.handlers.closed();
});

/** The app's own quit confirmation, as the app registers it: one popup per owner-initiated quit; accepting calls app.quit() again. */
function appConfirmation(electron, answer) {
  const state = { popups: 0, accepted: false };
  electron.app.on('before-quit', (event) => {
    if (state.accepted) return;                         // already confirmed: this quit goes through
    state.popups++;
    event.preventDefault();
    if (answer() === 'accept') { state.accepted = true; electron.app.quit(); }
  });
  return state;
}

test('quit, confirmation ACCEPTED: exactly one confirmation; the Host is shut down only once the quit is certain; then the app exits (no second app.quit)', () => {
  installAdapter();
  const { electron } = run();
  const confirm = appConfirmation(electron, () => 'accept');
  const host = electron.children[0];
  electron.app.quit();                                   // the owner's quit
  assert.equal(confirm.popups, 1, 'exactly one confirmation');
  assert.equal(electron.calls.quit, 2, 'the owner\'s quit and the app\'s own re-quit after accepting; framework-main adds none');
  assert.deepEqual(host.posted.at(-1).m, { type: 'shutdown' }, 'Host asked to shut down at will-quit');
  assert.deepEqual(electron.calls.exit, [], 'waiting for the Host to stop (bounded)');
  host.exit(0);
  assert.deepEqual(electron.calls.exit, [0]);
  assert.equal(confirm.popups, 1);
  assert.equal(electron.children.length, 1, 'no restart during shutdown');
});

test('quit, confirmation CANCELLED: the Host and backends are untouched and nothing prompts again', () => {
  installAdapter();
  const { electron } = run();
  const confirm = appConfirmation(electron, () => 'cancel');
  const host = electron.children[0];
  const postedBefore = host.posted.length;
  electron.app.quit();
  assert.equal(confirm.popups, 1);
  assert.equal(host.posted.length, postedBefore, 'no shutdown message');
  assert.equal(host.killed, 0); assert.deepEqual(electron.calls.exit, []);
  assert.equal(electron.lastQuit, 'cancelled');
  // the app keeps running with its Host; a later confirmed quit still shuts it down
  confirm.accepted = true;
  electron.app.quit();
  assert.deepEqual(host.posted.at(-1).m, { type: 'shutdown' });
  host.exit(0); assert.deepEqual(electron.calls.exit, [0]);
});

test('quit WITHOUT any confirmation handler: before-quit passes, the Host shuts down, the app exits', () => {
  installAdapter();
  const { electron } = run();
  const host = electron.children[0];
  electron.app.quit();
  assert.equal(electron.calls.quit, 1, 'framework-main never calls quit itself');
  assert.deepEqual(host.posted.at(-1).m, { type: 'shutdown' });
  host.exit(0);
  assert.deepEqual(electron.calls.exit, [0]);
});

test('quit: a Host that does not answer within the 10 s budget is killed, then the app exits; shutdown is requested once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  installAdapter();
  const { electron } = run();
  const host = electron.children[0];
  electron.app.quit();
  electron.emitApp('will-quit', { preventDefault() {} });          // a repeated will-quit must not shut down twice
  assert.equal(host.posted.filter((p) => p.m.type === 'shutdown').length, 1);
  mock.timers.tick(9999);
  assert.deepEqual(electron.calls.exit, []); assert.equal(host.killed, 0, 'a slow disposer is not killed early');
  mock.timers.tick(1);
  assert.equal(host.killed, 1); assert.deepEqual(electron.calls.exit, [0]);
});

test('quit with no Host running: nothing is held back', () => {
  installAdapter();
  const { electron } = run();
  electron.children[0].exit(1); electron.children[1].exit(1);       // crash, restart, second crash: no Host left
  electron.calls.exit.length = 0;
  electron.app.quit();
  assert.equal(electron.lastQuit, 'quitting', 'will-quit is not prevented');
  assert.deepEqual(electron.calls.exit, []);
});

test('framework-main registers NO before-quit listener (it must never pre-empt the app\'s own quit decision)', () => {
  installAdapter();
  const { electron } = run();
  let count = 0;
  const be = { preventDefault() { count++; } };
  electron.emitApp('before-quit', be);
  assert.equal(count, 0);
});

test('MainHooks: contents, sendToHost, onHostMessage; views then recovery registered in order', () => {
  installAdapter();
  const order = [];
  let hooks;
  let electron;
  ({ electron } = run({
    views: { register: (h) => { order.push('views'); hooks = h; } },
    recovery: { register: () => { order.push('recovery'); } },
  }, true));
  assert.deepEqual(order, ['views', 'recovery']);
  assert.equal(hooks.layout.profile, 'default'); assert.equal(hooks.safe, true);
  assert.equal(hooks.frameworkDir, join(L.framework, 'fw9'));
  assert.equal(hooks.adapter.adapterVersion, '0.0.0-test');
  assert.equal(hooks.electron, electron);
  const seen = [];
  hooks.onHostMessage('ready', (m) => seen.push(m));
  hooks.onHostMessage('view-open', (m) => seen.push(m.requestId));
  electron.children[0].emit({ type: 'ready' }); electron.children[0].emit({ type: 'view-open', requestId: 'r1' }); electron.children[0].emit({ type: 'breadcrumbs', mods: [] });
  assert.deepEqual(seen, [{ type: 'ready' }, 'r1']);
  hooks.sendToHost({ type: 'health', signal: 'window-rendered' });
  assert.deepEqual(electron.children[0].posted.at(-1), { m: { type: 'health', signal: 'window-rendered' } });
  assert.equal(typeof hooks.bridgeRealm, 'function');
});

test('feature areas: an area-op runs the function its module registered and is answered; an unknown area is refused; reports go out', async () => {
  installAdapter();
  let hooks;
  const { electron } = run({ views: { register: (h) => { hooks = h; } }, recovery: { register: () => {} } }, true);
  hooks.onAreaOp('threads', async (op, args) => {
    if (op === 'pin') return { pinned: args.threadId };
    if (op === 'nothing') { const e = new Error('no such thread'); e.refused = true; throw e; }
    throw new Error('the app failed');
  });
  const done = () => electron.children[0].posted.map((p) => p.m).filter((m) => m.type === 'area-op-done');
  for (const [requestId, area, op] of [['r1', 'threads', 'pin'], ['r2', 'threads', 'nothing'], ['r3', 'threads', 'boom'], ['r4', 'skills', 'list']]) {
    electron.children[0].emit({ type: 'area-op', area, requestId, op, args: { threadId: 't1' } });
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(done().sort((a, b) => a.requestId.localeCompare(b.requestId)), [
    { type: 'area-op-done', requestId: 'r1', ok: true, result: { pinned: 't1' } },
    { type: 'area-op-done', requestId: 'r2', ok: false, refused: true, error: 'no such thread' },
    { type: 'area-op-done', requestId: 'r3', ok: false, refused: false, error: 'the app failed' },
    { type: 'area-op-done', requestId: 'r4', ok: false, refused: true, error: 'framework-main has no area skills' },
  ]);
  hooks.areaReport('threads', { pinned: ['t1'] });
  assert.deepEqual(electron.children[0].posted.at(-1).m, { type: 'area-report', area: 'threads', report: { pinned: ['t1'] } });
});

test('the AppHost hold is installed by start() before begin() and extends __codexmods; a window held meanwhile is in hooks.appHost', () => {
  installAdapter();
  const global = { __codexmods: { jsx: 'kept', faults: { jsx: 2 } } };
  const electron = fakeElectron();
  let hooks;
  const out = start({ root, profile: 'default', safe: false, deferStart: true }, { electron, loadModule: (n) => (n.includes('read-state') ? { register: (h) => { hooks = h; } } : { register() {} }), spawnHost: (o) => electron.spawnHost(o), global });
  assert.equal(typeof global.__codexmods.appHost, 'function', 'in place while begin() is still held back (the app\'s main code runs now)');
  assert.deepEqual([global.__codexmods.jsx, global.__codexmods.faults], ['kept', { jsx: 2 }], 'extends, never replaces');
  assert.equal(electron.children.length, 0, 'no Host yet');
  const host = { services: {} };
  global.__codexmods.appHost(host, { id: 41, once() {} });
  out.begin();
  assert.deepEqual(hooks.appHost.windows(), [{ id: 41, host, view: null }], 'held before begin(), and handed to the modules');
  assert.deepEqual(hooks.appHost.first(), { id: 41, host, view: null });
});

test('no window yet: hooks.appHost is empty and nothing throws', () => {
  installAdapter();
  let hooks;
  const { global } = run({ readState: { register: (h) => { hooks = h; } } });
  assert.deepEqual(hooks.appHost.windows(), []);
  assert.equal(hooks.appHost.first(), null);
  global.__codexmods.appHost(undefined, { id: 1 });   // a window with no AppHost: not held
  assert.deepEqual(hooks.appHost.windows(), []);
});

test('absent modules are logged and skipped; a throwing module does not stop the next', () => {
  installAdapter();
  let registered = 0;
  run({ recovery: { register: () => { registered++; } } });
  assert.equal(registered, 1);
  assert.match(logText(), /optional main module absent/);
  const order = [];
  run({ views: { register: () => { order.push('v'); throw new Error('views blew up'); } }, recovery: { register: () => order.push('r') } });
  assert.deepEqual(order, ['v', 'r']);
  assert.match(logText(), /views blew up/);
});

test('renderer-modules updates what codexmod:// serves', async () => {
  installAdapter();
  const pkg = join(root, 'pkg'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'r.js'), 'export default 1;');
  const { electron } = run();
  assert.equal((await electron.protocolHandler('codexmod://a.b/1/r.js', 'GET')).status, 404);
  electron.children[0].emit({ type: 'renderer-modules', modules: [{ modId: 'a.b', packageDir: pkg, entry: 'r.js', rev: '1' }] });
  const r = await electron.protocolHandler('codexmod://a.b/1/r.js', 'GET');
  assert.equal(r.status, 200); assert.equal(String(r.body), 'export default 1;');
  electron.children[0].emit({ type: 'renderer-modules', modules: [] });
  assert.equal((await electron.protocolHandler('codexmod://a.b/1/r.js', 'GET')).status, 404);
});

function fakeMainPort() {
  const l = {};
  return { sent: [], started: 0, closed: 0,
    on(ev, fn) { (l[ev] ??= []).push(fn); }, postMessage(m) { this.sent.push(m); }, start() { this.started++; }, close() { this.closed++; },
    emit(ev, v) { (l[ev] ?? []).forEach((f) => f(v)); } };
}
function runWithHooks() {
  installAdapter();
  let hooks;
  const { electron } = run({ views: { register: (h) => { hooks = h; } } });
  return { hooks, electron, host: electron.children[0] };
}
const postedRealm = (host) => host.posted.map((p) => p.m).filter((m) => m.type === 'realm' || m.type === 'realm-close');

test('bridgeRealm forwards port messages to the Host as realm envelopes and Host replies back to the port', () => {
  const { hooks, host } = runWithHooks();
  const port = fakeMainPort();
  hooks.bridgeRealm(7, 'renderer', port);
  assert.equal(port.started, 1);
  port.emit('message', { data: { t: 'call', id: 1 } });
  assert.deepEqual(postedRealm(host), [{ type: 'realm', windowId: 7, channel: 'renderer', data: { t: 'call', id: 1 } }]);
  host.emit({ type: 'realm', windowId: 7, channel: 'renderer', data: { t: 'result', id: 1 } });
  assert.deepEqual(port.sent, [{ t: 'result', id: 1 }]);
  host.emit({ type: 'realm', windowId: 7, channel: 'management', data: { nope: 1 } });
  assert.equal(port.sent.length, 1, 'a different channel is not delivered to this port');
});

test('bridgeRealm: a new page load replaces the bridge: old one closed with realm-close, then the new one works', () => {
  const { hooks, host } = runWithHooks();
  const first = fakeMainPort(), second = fakeMainPort();
  hooks.bridgeRealm(7, 'renderer', first);
  hooks.bridgeRealm(7, 'renderer', second);
  assert.equal(first.closed, 1);
  assert.deepEqual(postedRealm(host), [{ type: 'realm-close', windowId: 7, channel: 'renderer' }]);
  first.emit('message', { data: { stale: true } });          // the old page can no longer talk
  second.emit('message', { data: { fresh: true } });
  assert.deepEqual(postedRealm(host).slice(1), [{ type: 'realm', windowId: 7, channel: 'renderer', data: { fresh: true } }]);
  host.emit({ type: 'realm', windowId: 7, channel: 'renderer', data: 'x' });
  assert.deepEqual(first.sent, []); assert.deepEqual(second.sent, ['x']);
  first.emit('close');                                        // a late close of the replaced port must not close the new bridge
  assert.equal(postedRealm(host).filter((m) => m.type === 'realm-close').length, 1);
});

test('bridgeRealm: port close and window close send realm-close', () => {
  const { hooks, electron, host } = runWithHooks();
  const win = electron.createWindowEvent(9);
  const a = fakeMainPort(), b = fakeMainPort();
  hooks.bridgeRealm(9, 'renderer', a);
  hooks.bridgeRealm(9, 'management', b);
  a.emit('close');
  assert.deepEqual(postedRealm(host), [{ type: 'realm-close', windowId: 9, channel: 'renderer' }]);
  win.handlers.closed();
  assert.deepEqual(postedRealm(host).at(-1), { type: 'realm-close', windowId: 9, channel: 'management' });
  assert.equal(b.closed, 1);
});

test('realm messages from the Host are consumed by the bridge, not offered to hooks', () => {
  const { hooks, host } = runWithHooks();
  const seen = [];
  hooks.onHostMessage('realm', (m) => seen.push(m));
  host.emit({ type: 'realm', windowId: 1, channel: 'renderer', data: 1 });
  assert.deepEqual(seen, []);
});

const embedAdapter = (patch = {}, name = 'codexmods-adapter.json') => {
  writeFileSync(join(contents, 'Resources', name), JSON.stringify({ ...ADAPTER, adapterVersion: 'embedded-1', ...patch }));
};

test('the adapter embedded in the copy wins over the root adapter pack; adapterDir is the directory of the file used', () => {
  installAdapter({ adapterVersion: 'root-pack' });
  embedAdapter();
  const { electron } = run();
  const o = electron.children[0].posted[0].m.options;
  assert.equal(o.adapterDir, join(contents, 'Resources'));
  assert.ok(!/adapter pack/.test(logText()), 'no fallback warning');
  const hooks = (() => { let h; run({ views: { register: (x) => { h = x; } } }); return h; })();
  assert.equal(hooks.adapter.adapterVersion, 'embedded-1');
});

test('only the embedded adapter exists: no root pack needed, appBuild comes from the plist', () => {
  embedAdapter();
  const { electron } = run();
  assert.equal(electron.children.length, 1);
  assert.equal(electron.children[0].posted[0].m.options.appBuild, '1.2.3-456');
});

test('no embedded adapter: falls back to the root pack with a warning, adapterDir is the root pack dir', () => {
  installAdapter();
  const { electron } = run();
  assert.equal(electron.children[0].posted[0].m.options.adapterDir, join(L.adapters, '1.2.3-456'));
  assert.match(logText(), /no embedded adapter in this copy/);
});

test('embedded adapter without a readable Info.plist: appBuild from the adapter build', () => {
  embedAdapter();
  rmSync(join(contents, 'Info.plist'));
  const { electron } = run();
  assert.equal(electron.children[0].posted[0].m.options.appBuild, `${ADAPTER.build.version}-${ADAPTER.build.bundleVersion}`);
});

test('neither embedded nor root adapter: unmodded', () => {
  const { electron } = run();
  assert.equal(electron.children.length, 0);
  assert.equal(JSON.parse(readFileSync(join(L.flags, 'safe'), 'utf8')).reason, 'no-adapter');
});

test('startup logs which adapter file was loaded: embedded or root fallback', () => {
  embedAdapter();
  run();
  assert.match(logText(), /"msg":"adapter loaded".*"source":"embedded".*codexmods-adapter\.json/);
  rmSync(join(contents, 'Resources', 'codexmods-adapter.json'));
  installAdapter();
  run();
  assert.match(logText(), /"source":"root-fallback"/);
});

test('after shutdown has begun and the Host is gone, window and realm-close sends are dropped without warnings', () => {
  installAdapter();
  let hooks, win;
  const { electron } = run({ views: { register: (h) => { hooks = h; } } });
  win = electron.createWindowEvent(5);
  const port = { on() {}, postMessage() {}, close() {} };
  hooks.bridgeRealm(5, 'renderer', port);
  electron.app.quit();
  electron.children[0].exit(0);                         // the Host has exited as asked
  const warnsBefore = (logText().match(/sendToHost with no Host running/g) || []).length;
  hooks.bridgeRealm(5, 'renderer', port);               // replaces the bridge: sends realm-close to a gone Host
  win.handlers.focus(); win.handlers.closed();          // window events
  assert.equal((logText().match(/sendToHost with no Host running/g) || []).length, warnsBefore);
});

test('without shutdown, a send with no Host running still warns', () => {
  installAdapter();
  let hooks;
  const { electron } = run({ views: { register: (h) => { hooks = h; } } });
  electron.children[0].exit(1);                         // crash: restarted, so child exists again; kill the replacement too
  electron.children[1].exit(1);                         // second crash: no Host left, not shutting down
  hooks.sendToHost({ type: 'health', signal: 'window-rendered' });
  assert.match(logText(), /sendToHost with no Host running/);
});

// ---- per-profile instance lock (v1.8): the release side
const lockPath = () => join(L.run, 'instance.lock');
const takeLock = (token = 'tok-1') => { mkdirSync(L.run, { recursive: true }); writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token })); return { file: lockPath(), token }; };
const runWithLock = (instanceLock, extra = {}) => {
  const electron = fakeElectron();
  const loadModule = () => { const e = new Error('absent'); e.code = 'MODULE_NOT_FOUND'; throw e; };
  start({ root, profile: 'default', safe: false, instanceLock }, { electron, loadModule, spawnHost: (o) => electron.spawnHost(o), ...extra });
  return electron;
};

test('instance lock: released at will-quit, only when the token is ours', () => {
  installAdapter();
  const lock = takeLock();
  const electron = runWithLock(lock);
  assert.ok(existsSync(lockPath()), 'held while running');
  electron.emitApp('will-quit', { preventDefault() {} });
  assert.ok(existsSync(lockPath()), 'still held while the Host shuts down');
  electron.children[0].exit(0);
  assert.ok(!existsSync(lockPath()), 'released when the app exits');
  const foreign = takeLock('someone-else');
  const e2 = runWithLock({ file: lockPath(), token: 'mine' });
  e2.emitApp('will-quit', { preventDefault() {} }); e2.children[0].exit(0);
  assert.ok(existsSync(lockPath()), 'a lock with another token is never removed'); void foreign;
});

test('instance lock: released before every relaunch path so the new instance finds the profile free', () => {
  installAdapter();
  for (const trigger of ['exit-relaunch', 'crash']) {
    const electron = fakeElectron();
    const seen = [];
    electron.app.relaunch = () => { seen.push(existsSync(lockPath())); };
    takeLock();
    start({ root, profile: 'default', safe: false, instanceLock: { file: lockPath(), token: 'tok-1' } },
      { electron, loadModule: () => { const e = new Error('absent'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o) });
    if (trigger === 'exit-relaunch') electron.children[0].emit({ type: 'exit', relaunch: true, reason: 'x' }); else electron.children[0].exit(139);
    assert.deepEqual(seen, [false], trigger);
  }
});

test('no instance lock given (tests, old loader): nothing to release and nothing breaks', () => {
  installAdapter();
  const electron = runWithLock(null);
  electron.emitApp('will-quit');
  electron.children[0].emit({ type: 'exit', relaunch: false, reason: 'x' });
});

test('frameworkVersion is the name of the framework directory actually loaded (content-addressed), not package.json', () => {
  installAdapter();
  mkdirSync(join(L.framework, '1.0.0-dev+abcd1234'), { recursive: true });
  writeFileSync(join(L.framework, '1.0.0-dev+abcd1234', 'package.json'), JSON.stringify({ version: '1.0.0-dev' }));
  writeFileSync(L.frameworkCurrent, '1.0.0-dev+abcd1234\n');
  const electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; },
    spawnHost: (o) => electron.spawnHost(o), runningDir: join(L.framework, '1.0.0-dev+abcd1234') });
  assert.equal(electron.children[0].posted[0].m.options.frameworkVersion, '1.0.0-dev+abcd1234');
});

test('outside <root>/framework/<name> (headless, symlinked checkout) package.json supplies the version', () => {
  installAdapter();
  mkdirSync(join(L.framework, 'fw9'), { recursive: true });
  writeFileSync(join(L.framework, 'fw9', 'package.json'), JSON.stringify({ version: '3.2.1' }));
  const electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; },
    spawnHost: (o) => electron.spawnHost(o), runningDir: '/somewhere/else/checkout' });
  assert.equal(electron.children[0].posted[0].m.options.frameworkVersion, '3.2.1');
});

test('the framework scheme is exempted from the app network filters, after it is registered', () => {
  installAdapter();
  const { electron } = run();
  assert.deepEqual(electron.calls.exempt, ['codexmod']);
});

test('runningAppPath: the .app bundle of process.execPath is passed to the Host; absent when not running from a bundle', () => {
  assert.equal(runningAppPathOf('/Users/u/Applications/ChatGPT Mods.app/Contents/MacOS/ChatGPT'), '/Users/u/Applications/ChatGPT Mods.app');
  assert.equal(runningAppPathOf('/usr/local/bin/node'), undefined);
  installAdapter();
  const app = join(root, 'Real.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  let electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o), execPath: join(app, 'Contents', 'MacOS', 'ChatGPT') });
  assert.equal(electron.children[0].posted[0].m.options.runningAppPath, realpathSync(app));
  electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o), execPath: '/usr/local/bin/node' });
  assert.equal('runningAppPath' in electron.children[0].posted[0].m.options, false);
});

test('framework-main sets CODEX_MODS_COMPUTER_USE_DIR to layout.computerUse and creates it 0700', () => {
  installAdapter();
  delete process.env.CODEX_MODS_COMPUTER_USE_DIR;
  run();
  assert.equal(process.env.CODEX_MODS_COMPUTER_USE_DIR, L.computerUse);
  assert.equal(statSync(L.computerUse).mode & 0o777, 0o700);
});

test('deferStart: scheme/env are set before the app is ready, but no Host, no quit handlers and no modules until begin(); begin is idempotent', () => {
  installAdapter();
  const electron = fakeElectron();
  const registered = [];
  const loadModule = (name) => ({ register: () => registered.push(name) });
  const out = start({ root, profile: 'default', safe: true, deferStart: true }, { electron, loadModule, spawnHost: (o) => electron.spawnHost(o), areaModules: [] });
  assert.equal(typeof out.begin, 'function');
  assert.deepEqual(electron.calls.schemes, ['codexmod'], 'pre-ready work is done');
  assert.equal(process.env.CODEX_MODS_RUN_DIR, L.run);
  assert.equal(electron.children.length, 0, 'no Host yet');
  assert.deepEqual(registered, [], 'no views / recovery module (so no safe-mode dialog) yet');
  assert.equal(electron.protocolHandler !== null, true);
  out.begin();
  assert.equal(electron.children.length, 1); assert.deepEqual(registered, ['./views/index.cjs', './recovery/index.cjs', './read-state.cjs', './projects.cjs', './app-state.cjs', './approvals.cjs', './user-actions.cjs']);
  out.begin();
  assert.equal(electron.children.length, 1, 'idempotent');
});

test('without deferStart start() begins immediately (unchanged behaviour)', () => {
  installAdapter();
  const { electron, result } = run();
  assert.equal(electron.children.length, 1);
  assert.ok(result && result.hooks);
});

// ---- v1.19: the relaunch token
const tokenPath = () => join(L.run, 'relaunch-intent.json');
const readToken = () => JSON.parse(readFileSync(tokenPath(), 'utf8'));
test('every relaunch framework-main performs leaves the one-shot token {at, reason, pid} first: Host crash, Host-requested exit, recovery module', () => {
  installAdapter();
  const seenAtRelaunch = [];
  // Host crash
  let electron = fakeElectron();
  const origRelaunch = electron.app.relaunch;
  electron.app.relaunch = () => { seenAtRelaunch.push(existsSync(tokenPath())); origRelaunch(); };
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o) });
  electron.children[0].exit(139);
  assert.deepEqual(seenAtRelaunch, [true], 'the token exists BEFORE app.relaunch runs');
  let t = readToken();
  assert.ok(Date.parse(t.at)); assert.equal(t.pid, process.pid); assert.match(t.reason, /host-crash/);
  rmSync(tokenPath());
  // Host-requested exit with relaunch
  electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o) });
  electron.children[0].emit({ type: 'exit', relaunch: true, reason: 'framework-update' });
  assert.equal(electron.calls.relaunch, 1); assert.equal(readToken().reason, 'exit:framework-update');
  rmSync(tokenPath());
  // Host-requested exit WITHOUT app.relaunch (app-switch: the swap helper reopens): the token is still left
  electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o) });
  electron.children[0].emit({ type: 'exit', relaunch: false, reason: 'app-switch' });
  assert.equal(electron.calls.relaunch, 0); assert.equal(readToken().reason, 'exit:app-switch');
  rmSync(tokenPath());
  // the recovery module's own app.relaunch() (safe-mode dialog "Disable framework"), through hooks.electron
  electron = fakeElectron();
  let hooks;
  start({ root, profile: 'default', safe: false }, { electron, loadModule: (n) => (n.includes('recovery') ? { register: (h) => { hooks = h; } } : { register() {} }), spawnHost: (o) => electron.spawnHost(o) });
  hooks.electron.app.relaunch();
  assert.equal(electron.calls.relaunch, 1); assert.equal(readToken().reason, 'framework');
});

test('no relaunch, no token', () => {
  installAdapter();
  const electron = fakeElectron();
  start({ root, profile: 'default', safe: false }, { electron, loadModule: () => { const e = new Error('x'); e.code = 'MODULE_NOT_FOUND'; throw e; }, spawnHost: (o) => electron.spawnHost(o) });
  assert.ok(!existsSync(tokenPath()));
});
