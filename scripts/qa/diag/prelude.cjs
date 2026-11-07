// QA-only diagnostic prelude (scripts/qa, test builds only; never part of a product build). Prepended to loader/loader.cjs (or used alone
// for the stock-equivalent control). It only OBSERVES: it logs to <root>/qa/diag.log and never changes behaviour.
//   quit tracing (always): before-quit / will-quit / quit / window-all-closed, whether a before-quit was default-prevented, app.quit calls
//   full tracing (DIAG_FULL): ipcMain.handle registrations and invocations (sender, url, outcome), webContents lifecycle and console
//   messages, preload-error, page-state polling (what window/URL loaded, is the framework runtime present), MessageChannelMain ports
//   and the first messages the renderer sends over them, registered preload scripts per session.
(function codexmodsQaDiag() {
  'use strict';
  const DIAG_ROOT = '__CODEXMODS_ROOT__';
  const DIAG_FULL = __DIAG_FULL__;
  const DIAG_CONTROL = __DIAG_CONTROL__;
  const TAP_SOURCE = __TAP_SOURCE__;
  const fs = require('fs');
  const path = require('path');
  const start = Date.now();
  const file = path.join(DIAG_ROOT, 'qa', 'diag.log');
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  const log = (o) => { try { fs.appendFileSync(file, `${JSON.stringify({ ms: Date.now() - start, pid: process.pid, ...o })}\n`); } catch { /* ignore */ } };
  const safe = (label, fn) => { try { return fn(); } catch (e) { log({ ev: 'diag.error', label, error: String(e && e.message || e) }); return undefined; } };
  let electron;
  try { electron = require('electron'); } catch (e) { log({ ev: 'diag.no-electron', error: String(e) }); return; }
  const { app, ipcMain } = electron;
  log({ ev: 'diag.start', full: DIAG_FULL, control: DIAG_CONTROL, versions: process.versions.electron });

  if (DIAG_CONTROL) {
    // stock-equivalent isolation: same user data / CODEX_HOME treatment the real loader gives, and nothing else
    const home = path.join(DIAG_ROOT, 'codex-home');
    safe('control-env', () => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); process.env.CODEX_HOME = home; });
    // protocol tap around the REAL backend (observation only): CODEX_CLI_PATH is the app's own documented override
    safe('control-tap', () => {
      const res = path.dirname(app.getAppPath());
      const node = path.join(res, 'cua_node', 'bin', 'node');
      const real = path.join(res, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
      const tap = path.join(DIAG_ROOT, 'qa', 'tap.mjs');
      fs.writeFileSync(tap, TAP_SOURCE);
      const wrapper = path.join(DIAG_ROOT, 'qa', 'ctl-backend');
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${node}" "${tap}" "${real}" "${DIAG_ROOT}/qa/ctl-$$" "$@"\n`, { mode: 0o755 });
      process.env.CODEX_CLI_PATH = wrapper;
    });
  }

  // ---- dialogs: who asks the user something (the main thread of a stuck quit was inside NSAlert runModal)
  safe('dialog', () => {
    const { dialog } = electron;
    for (const name of ['showMessageBoxSync', 'showMessageBox', 'showErrorBox']) {
      const orig = dialog[name]; if (typeof orig !== 'function') continue;
      const wrapped = function patched(...args) {
        const opts = args.find((a) => a && typeof a === 'object' && !a.webContents) || {};
        log({ ev: `dialog.${name}`, type: opts.type, title: opts.title, message: String(opts.message || args[1] || '').slice(0, 200), detail: String(opts.detail || '').slice(0, 200), buttons: opts.buttons,
          stack: String(new Error().stack).split('\n').slice(2, 9).map((l) => l.trim().replace(/\(?(?:file:\/\/)?[^()]*\/(?=[^/]+:\d+:\d+\)?$)/, '(')) });
        return orig.apply(this, args);
      };
      try { dialog[name] = wrapped; } catch { /* readonly */ }
      if (dialog[name] !== wrapped) try { Object.defineProperty(dialog, name, { value: wrapped, configurable: true, writable: true }); } catch (e) { log({ ev: 'diag.error', label: `dialog-${name}`, error: String(e) }); }
    }
  });

  // ---- quit tracing
  safe('quit', () => {
    for (const ev of ['before-quit', 'will-quit', 'quit', 'window-all-closed']) {
      app.on(ev, (event) => {
        const rec = { ev: `app.${ev}` };
        if (event && typeof event.preventDefault === 'function') {
          // our listener is registered first: look again after every other listener has run
          process.nextTick(() => log({ ev: `app.${ev}.after-listeners`, defaultPrevented: !!event.defaultPrevented }));
        }
        log(rec);
      });
    }
    const quit = app.quit.bind(app);
    app.quit = (...a) => { log({ ev: 'app.quit() called' }); return quit(...a); };
    const exit = app.exit.bind(app);
    app.exit = (...a) => { log({ ev: 'app.exit() called', code: a[0] }); return exit(...a); };
    app.on('browser-window-created', (_e, win) => {
      const id = win.id;
      win.on('close', (event) => { log({ ev: 'win.close', id }); process.nextTick(() => log({ ev: 'win.close.after-listeners', id, defaultPrevented: !!event.defaultPrevented })); });
      win.on('closed', () => log({ ev: 'win.closed', id }));
    });
    app.on('activate', () => log({ ev: 'app.activate' }));
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => log({ ev: `process.${sig}` }));
    process.on('exit', (code) => log({ ev: 'process.exit', code }));
  });

  if (!DIAG_FULL) return;

  // ---- ipcMain.handle
  safe('ipc', () => {
    const orig = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => {
      log({ ev: 'ipc.handle.register', channel });
      return orig(channel, async (event, ...args) => {
        const wc = event.sender;
        const rec = { ev: 'ipc.invoke', channel, senderId: wc && wc.id, url: safe('url', () => wc.getURL()), mainFrame: safe('mf', () => !event.senderFrame || event.senderFrame === wc.mainFrame), arg: safe('arg', () => JSON.stringify(args[0]).slice(0, 120)) };
        try {
          const r = await fn(event, ...args);
          rec.ok = true; rec.resultType = r == null ? String(r) : typeof r;
          if (r && typeof r === 'object' && typeof r.runtime === 'string') rec.runtimeBytes = r.runtime.length;
          log(rec); return r;
        } catch (e) { rec.ok = false; rec.error = String(e && e.message || e); log(rec); throw e; }
      });
    };
  });

  // ---- which adapter file framework-main reads (observation of fs.readFileSync on adapter paths)
  safe('fs-adapter', () => {
    const orig = fs.readFileSync;
    fs.readFileSync = function patched(p, ...rest) {
      try { const s = typeof p === 'string' ? p : ''; if (/adapter/i.test(s) && !s.includes(`${path.sep}qa${path.sep}`)) log({ ev: 'fs.readFileSync', path: s }); } catch { /* ignore */ }
      return orig.call(this, p, ...rest);
    };
  });

  // ---- the Host IPC (main <-> Host node process): message types, realm envelopes, probes (observation only)
  safe('host-ipc', () => {
    const cp = require('child_process');
    const origSpawn = cp.spawn;
    let outN = 0; let inN = 0;
    const describe = (m) => {
      if (!m || typeof m !== 'object') return { kind: typeof m };
      const d = { type: m.type };
      if (m.type === 'init') d.adapterDir = m.options && m.options.adapterDir;
      if (m.type === 'realm') {
        d.windowId = m.windowId; d.channel = m.channel;
        const x = m.data;
        d.t = x && x.t;
        if (x && x.t === 'probe' && x.report) { const items = x.report.items || {}; d.probe = { complete: x.report.complete, items: Object.keys(items).length, trueItems: Object.values(items).filter((v) => v === true).length, true: Object.entries(items).filter(([, v]) => v === true).map(([k]) => k), appBuild: x.report.appBuild }; }
        if (x && (x.t === 'degraded' || x.t === 'mounted')) { d.modId = x.modId; d.anchor = x.anchor; }
        if (x && x.t === 'fault') { d.modId = x.modId; d.message = String(x.message || '').slice(0, 160); }
        if (x && x.t === 'modules') d.modules = Array.isArray(x.modules) ? x.modules.length : undefined;
      }
      if (m.type === 'realm-close') { d.windowId = m.windowId; d.channel = m.channel; }
      if (m.type === 'window') { d.event = m.event; d.windowId = m.windowId; }
      return d;
    };
    cp.spawn = function patchedSpawn(cmd, args, opts, ...rest) {
      const child = origSpawn.call(this, cmd, args, opts, ...rest);
      try {
        if (child && typeof child.send === 'function' && Array.isArray(args) && /entry-node\.mjs$/.test(String(args[0]))) {
          log({ ev: 'host.spawned', pid: child.pid });
          const send = child.send.bind(child);
          child.send = (m, ...r) => { if (outN++ < 400) log({ ev: 'host.ipc.out', ...describe(m) }); return send(m, ...r); };
          child.on('message', (m) => { if (inN++ < 400) log({ ev: 'host.ipc.in', ...describe(m) }); });
        }
      } catch (e) { log({ ev: 'diag.error', label: 'host-ipc-wrap', error: String(e) }); }
      return child;
    };
  });

  // ---- MessageChannelMain: which ports exist and what the renderer sends over them
  safe('mcm', () => {
    const Orig = electron.MessageChannelMain;
    let n = 0;
    const Wrapped = class extends Orig {
      constructor() {
        super();
        const id = ++n;
        log({ ev: 'port.channel.created', id });
        let seen = 0;
        this.port1.on('message', (e) => { if (seen++ < 12) log({ ev: 'port.main.recv', id, data: safe('d', () => JSON.stringify(e.data).slice(0, 160)) }); });
      }
    };
    Object.defineProperty(electron, 'MessageChannelMain', { value: Wrapped, configurable: true, writable: true });
    log({ ev: 'mcm.patched', ok: electron.MessageChannelMain === Wrapped });
  });

  // ---- what the document looks like when a preload runs (our own observation-only preload, registered next to the framework's)
  safe('docstate', () => {
    const f = path.join(DIAG_ROOT, 'qa', 'diag-preload.cjs');
    fs.writeFileSync(f, `const { ipcRenderer } = require('electron');
try { if (window.top === window) ipcRenderer.send('codexmods-qa-diag', { href: location.href, readyState: document.readyState, documentElement: document.documentElement === null ? null : document.documentElement.tagName, head: document.head === null ? null : 'HEAD', body: document.body === null ? null : 'BODY', scripts: document.scripts.length }); } catch (e) { ipcRenderer.send('codexmods-qa-diag', { error: String(e) }); }\n`);
    ipcMain.on('codexmods-qa-diag', (e, d) => log({ ev: 'preload.document-state', senderId: e.sender.id, ...d }));
    app.whenReady().then(() => safe('reg', () => { electron.session.defaultSession.registerPreloadScript({ type: 'frame', filePath: f }); log({ ev: 'diag-preload.registered' }); }));
  });

  // ---- webContents lifecycle, console, page state
  const sessionsSeen = new Set();
  const noteSession = (ses, label) => {
    if (!ses || sessionsSeen.has(ses)) return; sessionsSeen.add(ses);
    log({ ev: 'session', label, preloads: safe('gps', () => ses.getPreloadScripts().map((p) => ({ type: p.type, filePath: p.filePath }))) });
  };
  if (typeof app.on === 'function') {
    app.whenReady().then(() => safe('ready', () => { log({ ev: 'app.ready' }); noteSession(electron.session.defaultSession, 'default'); }));
    app.on('session-created', () => log({ ev: 'session-created' }));
    app.on('web-contents-created', (_e, wc) => {
      const id = wc.id;
      log({ ev: 'wc.created', id, type: safe('t', () => wc.getType()) });
      safe('wc-post', () => { const post = wc.postMessage.bind(wc); wc.postMessage = (channel, msg, transfer) => { log({ ev: 'wc.postMessage', id, channel, kind: msg && msg.kind, ports: transfer ? transfer.length : 0 }); return post(channel, msg, transfer); }; });
      noteSession(safe('s', () => wc.session), `wc${id}`);
      for (const name of ['did-start-navigation', 'did-navigate', 'dom-ready', 'did-finish-load', 'did-fail-load', 'render-process-gone', 'unresponsive']) {
        wc.on(name, (...a) => log({ ev: `wc.${name}`, id, url: safe('u', () => wc.getURL()), extra: name === 'did-start-navigation' || name === 'did-navigate' ? undefined : safe('x', () => a.slice(1, 4).map((v) => (typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : v))) }));
      }
      wc.on('preload-error', (_e2, p, err) => log({ ev: 'wc.preload-error', id, preload: p, error: String(err && err.message || err) }));
      wc.on('console-message', (...a) => {
        // (event, level, message, line, sourceId) or a details object, depending on the runtime
        const d = a.length === 2 && a[1] && typeof a[1] === 'object' ? a[1] : { level: a[1], message: a[2], sourceId: a[4] };
        const msg = String(d.message || '');
        if (/codexmods/i.test(msg) || /error|denied|refus|fail/i.test(msg) || d.level >= 2) log({ ev: 'wc.console', id, level: d.level, message: msg.slice(0, 300), source: String(d.sourceId || '').slice(-80) });
      });
      const probe = () => {
        if (wc.isDestroyed()) return;
        wc.executeJavaScript(`(() => { const g = globalThis; return { href: location.href, readyState: document.readyState, title: document.title,
          hasCodexmods: typeof g.__codexmods, codexmodsKeys: Object.keys(g.__codexmods || {}).slice(0, 12), exportsKeys: Object.keys((g.__codexmods || {}).exports || {}).slice(0, 12),
          nonceMarker: Object.keys(g).filter((k) => /codexmods/i.test(k)).slice(0, 8), react: typeof g.React,
          body: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160), rootChildren: document.body ? document.body.children.length : -1 }; })()`)
          .then((v) => log({ ev: 'wc.page-state', id, ...v })).catch((e) => log({ ev: 'wc.page-state.error', id, error: String(e && e.message || e) }));
      };
      let polls = 0;
      const timer = setInterval(() => { if (wc.isDestroyed() || polls++ > 24) { clearInterval(timer); return; } probe(); }, 3000);
      if (timer.unref) timer.unref();
    });
  }
})();
