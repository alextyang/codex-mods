'use strict';
// framework-main (ARCHITECTURE.md 4.1, 9.1, 12.4). Runs in Electron main, before app main, called
// synchronously by the loader as start({root, profile, safe}). Everything here is synchronous except what it schedules.
// Only electron-adapter.cjs touches 'electron'; `deps.electron` lets tests supply a fake.
const fs = require('node:fs');
const path = require('node:path');
const { layout: makeLayout } = require('./layout.cjs');
const { createCodexmodResolver, SCHEME } = require('./codexmod-protocol.cjs');
const { writeJsonSync, readJsonSync, createMainLog } = require('./fsx.cjs');
const { spawnHostProcess } = require('./host-process.cjs');
const { releaseInstanceLock } = require('./instance-lock.cjs');
const { installAppHost } = require('./apphost.cjs');

// Runtime teardown allows a 5 s worker drain, then stops processes, backends and views: 10 s covers the whole budget.
const SHUTDOWN_GRACE_MS = 10000;

/** Path up to and including the `Contents` directory of the enclosing .app, or null. */
function contentsDir(appPath) {
  const marker = `${path.sep}Contents`;
  const i = appPath.indexOf(marker + path.sep);
  if (i >= 0) return appPath.slice(0, i + marker.length);
  return appPath.endsWith(marker) ? appPath : null;
}

/** Canonical path of the .app bundle the process runs from (…/X.app of process.execPath), or undefined. */
function runningAppPathOf(execPath) {
  const m = /^(.*?\.app)(?:\/|$)/.exec(String(execPath || ''));
  if (!m) return undefined;
  try { return fs.realpathSync(m[1]); } catch { return m[1]; }
}

/** Minimal XML Info.plist reader for the two keys the adapter lookup needs. */
function readBundleVersions(infoPlist) {
  let text;
  try { text = fs.readFileSync(infoPlist, 'utf8'); } catch { return null; }
  const key = (k) => { const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(text); return m ? m[1].trim() : null; };
  const short = key('CFBundleShortVersionString'), build = key('CFBundleVersion');
  return short && build ? { short, build } : null;
}

/**
 * @param {{root: string, profile: string, safe: boolean}} args
 * @param {{ electron?: any, loadModule?: (name: string) => any, spawnHost?: typeof spawnHostProcess, runningDir?: string, execPath?: string, global?: object,
 *   areaModules?: string[] }} [deps] test seams (`global`: where `__codexmods` lives; `areaModules`: the feature-area modules, else ./areas/*.cjs)
 */
/** The feature-area modules (breadth.md D5, D10): every ./areas/<name>.cjs, in name order; each registers its area with `onAreaOp`. */
function listAreaModules() {
  try {
    return fs.readdirSync(path.join(__dirname, 'areas')).filter((f) => f.endsWith('.cjs') && !f.includes('.test.')).sort().map((f) => `./areas/${f}`);
  } catch { return []; }
}

function start({ root, profile, safe, instanceLock = null, deferStart = false }, deps = {}) {
  const L = makeLayout(root, profile);
  const release = () => releaseInstanceLock(instanceLock);
  const log = createMainLog(path.join(L.logs, 'main.log'));
  const electron = deps.electron || require('./electron-adapter.cjs').createElectronAdapter();
  const loadModule = deps.loadModule || ((name) => require(name));
  const areaModules = deps.areaModules || listAreaModules();
  const spawnHost = deps.spawnHost || spawnHostProcess;

  // ---- 1. profile.json
  const stored = readJsonSync(L.profileConfig, null);
  if (!stored) log.warn('profile.json missing or unreadable: using layout defaults');
  const profileConfig = { codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '', ...(stored || {}) };

  // ---- 2. adapter: the one embedded (signed, immutable) in THIS copy by the builder; the root's adapters/<build>/ is only the
  // builder's input and a fallback for copies built before v1.5.
  const contents = contentsDir(electron.app.getAppPath());
  const versions = contents && readBundleVersions(path.join(contents, 'Info.plist'));
  const embeddedFile = contents && path.join(contents, 'Resources', 'codexmods-adapter.json');
  let adapter = embeddedFile && readJsonSync(embeddedFile, null);
  let adapterDir = adapter ? path.dirname(embeddedFile) : null;
  if (!adapter && versions) {
    const dir = path.join(L.adapters, `${versions.short}-${versions.build}`);
    adapter = readJsonSync(path.join(dir, 'adapter.json'), null);
    if (adapter) { adapterDir = dir; log.warn('no embedded adapter in this copy: using the root adapter pack', { adapterDir: dir }); }
  }
  if (!adapter) {
    log.error('no adapter for this build: running unmodded', { appPath: electron.app.getAppPath(), build: versions && `${versions.short}-${versions.build}` });
    writeJsonSync(path.join(L.flags, 'safe'), { reason: 'no-adapter' });
    delete process.env.CODEX_CLI_PATH;   // the app keeps its own backend: nothing would answer on the relay
    return;
  }
  log.info('adapter loaded', { source: adapterDir === path.dirname(embeddedFile || '') ? 'embedded' : 'root-fallback', file: adapterDir === path.dirname(embeddedFile || '') ? embeddedFile : path.join(adapterDir, 'adapter.json') });
  if (!adapter.backend || !adapter.backend.nodePath) {
    log.error('adapter has no backend.nodePath: running unmodded');
    writeJsonSync(path.join(L.flags, 'safe'), { reason: 'no-node' });
    delete process.env.CODEX_CLI_PATH;
    return;
  }
  const appBuild = versions ? `${versions.short}-${versions.build}` : `${adapter.build.version}-${adapter.build.bundleVersion}`;
  const currentName = (() => { try { return fs.readFileSync(L.frameworkCurrent, 'utf8').trim(); } catch { return ''; } })();
  const frameworkDir = path.join(L.framework, currentName);
  // Framework dirs are content-addressed (<version>+<hash8>): the version Recovery compares generations against is the NAME of the
  // directory actually loaded. Only outside <root>/framework/<name> (headless tests, a symlinked checkout) does package.json decide.
  const runningDir = deps.runningDir || path.resolve(__dirname, '..', '..');
  const runningFromRoot = path.dirname(runningDir) === path.resolve(L.framework);
  const pkgVersion = (readJsonSync(path.join(frameworkDir, 'package.json'), null) || {}).version;
  const frameworkVersion = runningFromRoot ? path.basename(runningDir)
    : (typeof pkgVersion === 'string' && pkgVersion ? pkgVersion : currentName);
  const nodePath = path.join(contents, adapter.backend.nodePath);
  const realCodexPath = path.join(contents, adapter.backend.codexPath) + (adapter.backend.method === 'replace' ? '.real' : '');

  // ---- 3. environment inherited by the app's backend spawn (and so by the relay)
  for (const d of [L.run, L.flags, L.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  process.env.CODEX_MODS_RUN_DIR = L.run;
  process.env.CODEX_MODS_FLAGS_DIR = L.flags;
  process.env.CODEX_MODS_REAL_CODEX = realCodexPath;
  fs.mkdirSync(L.computerUse, { recursive: true, mode: 0o700 });
  process.env.CODEX_MODS_COMPUTER_USE_DIR = L.computerUse;      // the copy's own Computer Use helper install (cua-relocate-dir transform)

  // ---- 4. codexmod:// protocol
  const resolver = createCodexmodResolver();
  try {
    electron.registerScheme(SCHEME);
    if (typeof electron.exemptSchemeFromAppNetworkFilters === 'function') electron.exemptSchemeFromAppNetworkFilters(SCHEME);
    electron.handleProtocol(SCHEME, (url, method) => resolver.serve(url, method));
  } catch (e) { log.error('codexmod protocol registration failed', { message: String(e && e.message || e) }); }

  // ---- 4b. the AppHost hold (docs/design/presentations.md V12): the app's main code calls `globalThis.__codexmods.appHost(host, sender, view)` for each window
  // it serves (the adapter's `app-host` seam), so the hook is in place before that code runs, whether or not begin() is held back.
  const appHost = installAppHost({ log, ...(deps.global ? { global: deps.global } : {}) });

  // ---- 5-9 run in begin(): the Host, the bridge, the restart policy and the views/recovery modules. Everything above this line is
  // what MUST happen before the app is ready (scheme privileges, filters, env). With deferStart the loader holds begin() back until the
  // concurrency warning is answered: nothing else (no Host, no safe-mode dialog) starts before the owner picks Continue.
  let began = null;
  function begin() {
  if (began) return began;
  began = (() => {
  // v1.19: every relaunch framework-main performs leaves a one-shot token for the loader, so the next launch can inherit the owner's
  // answer to the concurrency warning instead of asking again. app.relaunch is wrapped here, which also covers the recovery module's own call.
  let relaunchReason = 'framework';
  const writeRelaunchIntent = (reason) => {
    try { writeJsonSync(path.join(L.run, 'relaunch-intent.json'), { at: new Date().toISOString(), reason, pid: process.pid }); }
    catch (e) { log.warn('could not write the relaunch token', { message: String(e && e.message || e) }); }
  };
  const originalRelaunch = electron.app.relaunch.bind(electron.app);
  electron.app.relaunch = (...a) => { writeRelaunchIntent(relaunchReason); relaunchReason = 'framework'; return originalRelaunch(...a); };
  // ---- 5-8. Host process, bridge, restart policy, shutdown
  const hostEntry = path.join(frameworkDir, 'framework', 'host', 'entry-node.mjs');
  const hostEnv = { ...process.env };
  delete hostEnv.CODEX_CLI_PATH;      // the Host spawns the real backend; it must never point back at the relay
  const runningAppPath = runningAppPathOf(deps.execPath || process.execPath);
  const initOptions = { layout: L, profile: profileConfig, adapterDir, realCodexPath, frameworkVersion, appBuild, safeMode: !!safe, ...(runningAppPath ? { runningAppPath } : {}) };
  const handlers = new Map();         // HostToMain type -> fns
  const hostStateFns = [];            // (up: boolean) => void: told when the Host goes (its process exits) and comes back (it says it is ready)
  const tellHostState = (up) => { for (const fn of hostStateFns) { try { fn(up); } catch (e) { log.warn('a host-state listener threw', { message: String(e && e.message || e) }); } } };
  let child = null, restarts = 0, shuttingDown = false, exiting = false;
  let breadcrumbs = [];
  const knownWindows = new Set();
  const shownWindows = new Set();   // the windows the user has seen: the app creates some hidden, to show later (the hotkey window)
  const bridges = new Map();
  const bridgeKey = (windowId, channel) => `${windowId}:${channel}`;

  const dispatch = (msg) => {
    for (const fn of handlers.get(msg.type) || []) {
      try { fn(msg); } catch (e) { log.error('host message handler failed', { type: msg.type, message: String(e && e.message || e) }); }
    }
  };
  const sendToHost = (msg) => {
    if (!child) {
      if (!shuttingDown && !exiting) log.warn('sendToHost with no Host running', { type: msg.type });   // silent once shutdown has begun
      return;
    }
    try { child.postMessage(msg); } catch (e) { log.error('sendToHost failed', { type: msg.type, message: String(e && e.message || e) }); }
  };

  function onHostMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'renderer-modules': resolver.setModules(msg.modules || []); break;
      case 'breadcrumbs': breadcrumbs = Array.isArray(msg.mods) ? msg.mods.slice() : []; break;
      case 'realm': {
        const b = bridges.get(bridgeKey(msg.windowId, msg.channel));
        if (b) { try { b.port.postMessage(msg.data); } catch (e) { log.warn('bridged port post failed', { channel: msg.channel, message: String(e && e.message || e) }); } }
        return;                      // not a hook-visible message: the bridge consumes it
      }
      case 'exit':
        exiting = true;
        log.info('Host requested exit', { relaunch: !!msg.relaunch, reason: msg.reason });
        release();
        relaunchReason = `exit:${msg.reason}`;
        if (!msg.relaunch) writeRelaunchIntent(relaunchReason);      // the swap helper reopens the app (app-switch): same hand-over
        if (msg.relaunch) electron.app.relaunch();
        electron.app.exit(0);
        break;
      default: break;
    }
    dispatch(msg);
  }

  /** The app does not respawn a dead backend (v1.2), so a Host crash ends in an app relaunch. */
  function relaunchApp(reason) {
    log.info('relaunching after Host crash', { reason });
    release();                                  // the relaunched instance must find the profile free
    relaunchReason = reason;
    electron.app.relaunch();
    electron.app.exit(0);
  }

  const CRASH_WINDOW_MS = 10 * 60 * 1000;
  /** Every Host crash: breadcrumbs plus a crash count that survives relaunches (contracts/state.d.ts BootMarker v1.3). */
  function recordCrash() {
    try {
      const file = path.join(L.flags, 'boot.json');
      const marker = readJsonSync(file, {}) || {};
      const last = Date.parse(marker.lastHostCrashAt || '');
      const recent = Number.isFinite(last) && Date.now() - last <= CRASH_WINDOW_MS;
      const count = recent ? (Number(marker.hostCrashCount) || 0) + 1 : 1;
      writeJsonSync(file, { ...marker, breadcrumbs: breadcrumbs.slice(), hostCrashCount: count, lastHostCrashAt: new Date().toISOString() });
      // Backstop: a third crash in the window means quarantining did not help; next boot is safe mode.
      if (count >= 3) writeJsonSync(path.join(L.flags, 'safe'), { reason: 'host-crash', breadcrumbs: breadcrumbs.slice() });
      return count;
    } catch (e) {
      log.error('could not record the Host crash', { message: String(e && e.message || e) });
      return 0;
    }
  }

  function onHostExit(code) {
    child = null;
    tellHostState(false);
    if (shuttingDown || exiting) return;
    const count = recordCrash();
    log.error('Host exited unexpectedly', { code, restarts, breadcrumbs, crashCount: count });
    if (restarts < 1) {
      restarts++;
      launchHost();
      for (const id of knownWindows) {
        sendToHost({ type: 'window', event: 'created', windowId: id });
        if (shownWindows.has(id)) sendToHost({ type: 'window', event: 'shown', windowId: id });
      }
    }
    relaunchApp(`host-crash-${count}`);
  }

  function launchHost() {
    child = spawnHost({ nodePath, entry: hostEntry, logFile: path.join(L.logs, 'host-stdio.log'), env: hostEnv });
    const mine = child;
    mine.onMessage(onHostMessage);
    mine.onExit((code) => { if (child === mine) onHostExit(code); });
    mine.postMessage({ type: 'init', options: initOptions });
    log.info('Host started', { frameworkVersion, appBuild, restarts });
  }
  launchHost();

  // Quit. The app owns the quit decision (its own confirmation runs in its before-quit chain), so framework-main NEVER pre-empts it: no
  // before-quit handler, no preventDefault, no second app.quit() (that would run the confirmation a second time, and a cancelled
  // confirmation would leave an app with no Host). The quit is certain only at will-quit: it follows an unprevented before-quit and the
  // closing of all windows. There the Host gets a bounded graceful shutdown, then app.exit(0), which skips every quit event.
  electron.app.on('will-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const host = child;
    if (!host) { release(); return; }                       // no Host to wait for: let the quit proceed as it is
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    let done = false;
    const finish = () => { if (done) return; done = true; release(); electron.app.exit(0); };
    host.onExit(finish);
    const timer = setTimeout(() => { try { host.kill(); } catch { /* already gone */ } finish(); }, SHUTDOWN_GRACE_MS);
    if (timer.unref) timer.unref();
    host.postMessage({ type: 'shutdown' });
  });

  // ---- 9. MainHooks for the views and recovery modules
  // Window lifecycle -> bus window/created|shown|focused|blurred|bounds|title|fullScreen|closed (the Host publishes them); `shown` the first
  // time the window is shown.
  // Duck-typed: no electron import here.
  electron.onWindowCreated((win, windowId) => {
    knownWindows.add(windowId);
    sendToHost({ type: 'window', event: 'created', windowId });
    const shown = () => {
      if (shownWindows.has(windowId) || !knownWindows.has(windowId)) return;
      shownWindows.add(windowId);
      sendToHost({ type: 'window', event: 'shown', windowId });
    };
    try { if (win && typeof win.isVisible === 'function' && win.isVisible()) shown(); } catch { /* destroyed */ }
    if (win && typeof win.on === 'function') {
      win.on('show', shown);
      win.on('focus', () => sendToHost({ type: 'window', event: 'focused', windowId }));
      // the window itself, for the graph's Window (graph-integrity G5.5): the user left it, its bounds (once it stops moving), its title
      win.on('blur', () => sendToHost({ type: 'window', event: 'blurred', windowId }));
      // a window that has the user before this follows it (a new window comes focused) says so now
      try { if (typeof win.isFocused === 'function' && win.isFocused()) sendToHost({ type: 'window', event: 'focused', windowId }); } catch { /* destroyed */ }
      let boundsTimer = null;
      const bounds = () => {
        boundsTimer = null;
        try {
          if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
          const b = typeof win.getBounds === 'function' ? win.getBounds() : null;
          if (b) sendToHost({ type: 'window', event: 'bounds', windowId, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
        } catch { /* destroyed */ }
      };
      const boundsSoon = () => { if (boundsTimer) clearTimeout(boundsTimer); boundsTimer = setTimeout(bounds, 200); if (boundsTimer.unref) boundsTimer.unref(); };
      win.on('resize', boundsSoon);
      win.on('move', boundsSoon);
      bounds();
      const title = (t) => { if (typeof t === 'string') sendToHost({ type: 'window', event: 'title', windowId, title: t.slice(0, 500) }); };
      win.on('page-title-updated', (_e, t) => title(t));
      try { if (typeof win.getTitle === 'function') title(win.getTitle()); } catch { /* destroyed */ }
      // Full screen, for the graph's Window (docs/design/systems.md S10).
      win.on('enter-full-screen', () => sendToHost({ type: 'window', event: 'fullScreen', windowId, value: true }));
      win.on('leave-full-screen', () => sendToHost({ type: 'window', event: 'fullScreen', windowId, value: false }));
      try { if (typeof win.isFullScreen === 'function' && win.isFullScreen()) sendToHost({ type: 'window', event: 'fullScreen', windowId, value: true }); } catch { /* destroyed */ }
      win.on('closed', () => {
        knownWindows.delete(windowId);
        shownWindows.delete(windowId);
        for (const key of [...bridges.keys()]) if (bridges.get(key).windowId === windowId) closeBridge(key, true);
        sendToHost({ type: 'window', event: 'closed', windowId });
      });
    }
  });
  /** Window channels bridged to the Host as {type:'realm'} envelopes (contracts/ipc.d.ts section 1). */
  function closeBridge(key, notify) {
    const b = bridges.get(key);
    if (!b) return;
    bridges.delete(key);
    try { b.port.close && b.port.close(); } catch { /* already closed */ }
    if (notify) sendToHost({ type: 'realm-close', windowId: b.windowId, channel: b.channel });
  }
  function bridgeRealm(windowId, channel, mainPort) {
    const key = bridgeKey(windowId, channel);
    closeBridge(key, true);            // a new page load replaces the old channel pair
    const entry = { windowId, channel, port: mainPort };
    bridges.set(key, entry);
    mainPort.on('message', (event) => { if (bridges.get(key) === entry) sendToHost({ type: 'realm', windowId, channel, data: event && event.data }); });
    mainPort.on('close', () => { if (bridges.get(key) === entry) closeBridge(key, true); });
    if (typeof mainPort.start === 'function') mainPort.start();
  }
  const hooks = {
    electron, layout: L, adapter, frameworkDir, safe: !!safe, sendToHost, bridgeRealm, appHost,
    onHostMessage: (type, fn) => { const list = handlers.get(type) || []; list.push(fn); handlers.set(type, list); },
    /** `fn(up)` when the Host goes (false) and when it is ready again (true): what it runs cannot be run meanwhile. */
    onHostState: (fn) => { if (typeof fn === 'function') hostStateFns.push(fn); },
    log,
  };
  hooks.onHostMessage('ready', () => tellHostState(true));
  // Feature areas (breadth.md D5, D10): a module registers its operations under an area name (`onAreaOp(area, fn)`); the Host's `area-op`
  // runs `fn(op, args)` and is answered with `area-op-done` (a throw is a failure, one whose error has `refused: true` says nothing was
  // tried). A module pushes what it reads from the app with `areaReport(area, report)`.
  const areaOps = new Map();
  hooks.onAreaOp = (area, fn) => { areaOps.set(area, fn); };
  hooks.areaReport = (area, report) => sendToHost({ type: 'area-report', area, report });
  hooks.onHostMessage('area-op', async (msg) => {
    const answer = (m) => sendToHost({ type: 'area-op-done', requestId: msg.requestId, ...m });
    const fn = areaOps.get(msg.area);
    if (typeof fn !== 'function') return answer({ ok: false, refused: true, error: `framework-main has no area ${String(msg.area)}` });
    try {
      const result = await fn(String(msg.op), msg.args && typeof msg.args === 'object' ? msg.args : {});
      return answer({ ok: true, ...(result === undefined ? {} : { result }) });
    } catch (e) {
      return answer({ ok: false, refused: !!(e && e.refused), error: String((e && e.message) || e).slice(0, 500) });
    }
  });
  for (const name of ['./views/index.cjs', './recovery/index.cjs', './read-state.cjs', './projects.cjs', './app-state.cjs', './approvals.cjs', './user-actions.cjs', ...areaModules]) {
    try {
      loadModule(name).register(hooks);
    } catch (e) {
      const absent = e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(name.slice(2));
      if (absent) log.info('optional main module absent', { module: name });
      else log.error('main module failed to register', { module: name, message: String(e && e.message || e) });
    }
  }
  return { hooks };
  })();
  return began;
  }
  return deferStart ? { begin } : begin();
}

module.exports = { start, contentsDir, readBundleVersions, runningAppPathOf };
