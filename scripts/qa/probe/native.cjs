// QA-only probe of the app's native mechanisms (docs/design/realization/; test builds only, never part of a product build).
/* global document, CompositionEvent -- functions serialized into the renderer (APP_OPS, JSX_PLANS) run there */
// `qa setup --probe native` prepends it to the copy's loader. It answers JSON commands:
//   <root>/qa/probe/in/<id>.json  ->  <root>/qa/probe/out/<id>.json      (written by `qa probe '<json>'`)
// G-apphost: at the app's `connect-app-host` listener it holds each window's AppHost (the services main exports to the window) and AppView
// session (the services the window exports back). It reaches the listener with one load-time edit of the app's main chunk, anchored by
// structure on the method names `createAppHost` and `registerAppView` (no minified name is assumed).
// G-bus: it observes the renderer->main `message-from-view` handler and main->renderer `message-for-view` sends by channel name, calls
// `fetch` handlers through the app's own handler, and sends host messages to a window.
// G-jsx: it edits the renderer's JSX factory as main serves it (`app://` through `protocol.handle`), anchored by structure on
// `X.Fragment=…,X.jsx=F,X.jsxs=F`: each call consults an optional page global hook and falls back to the app's own factory when the hook
// is absent or throws. Renderer plans are fixed in this file (`JSX_PLANS`); a command picks one by name.
// G-tap: two more serve-time edits in the renderer chunk that holds the command table: the webview command array
// (`X=[{id:`newTask`,…`, the list every derived table starts from) and the default handler map (`X=new Map([[`newTask`,…`) each gain the
// entries of a page global, which the boot prefix sets from page localStorage (`codexmods.tap`). A third edit, in the command-messages
// chunk, gives the palette a title for it (`X={...Y,"codex.command.importExternalAgent":…`, the map from title message id to message).
// G-lazy: one more edit in `app-shared` wraps the importer passed to Vite's preload helper (`X=function(a,b,c){let r=Promise.resolve();
// if(b&&b.length>0){let a=document.getElementsByTagName(`link`)…`), so a page hook sees each lazy load as (chunk base name, exports);
// the base name comes from the importer's own source. Boot plans come from page localStorage (`codexmods.lazyBoot`).
// G-el: wrappers on public Electron APIs in main, installed before app main: `Menu.setApplicationMenu` (observe; optionally append a
// QA menu), `app.setBadgeCount` and `app.dock.setBadge` (observe; optionally override), `Notification` (observe; optionally suppress), window creation (observe).
// G-app: seven exposure edits (app-initial, app-shared) put the app's own mechanics on `globalThis.__codexmodsApp`: the scope hook and the
// latest handle per scope, the panel tab registry and panel controllers, the modal controller, the toast getter, `AppShell` and the
// header slot stores. They only assign; behaviour is unchanged. Fixed page operations (`APP_OPS`) use them.
// Calls through wrapped methods and bus traffic counts are logged to <root>/qa/probe/probe.log.
(function codexmodsQaProbeNative() {
  'use strict';
  const ROOT = '__CODEXMODS_ROOT__';
  const fs = require('fs');
  const path = require('path');
  const Module = require('module');
  const dir = path.join(ROOT, 'qa', 'probe');
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  for (const d of [inDir, outDir]) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* ignore */ } }
  const start = Date.now();
  const log = (o) => { try { fs.appendFileSync(path.join(dir, 'probe.log'), `${JSON.stringify({ ms: Date.now() - start, ...o })}\n`); } catch { /* ignore */ } };

  /** JSON-safe, bounded rendering of any value (stubs and functions become markers). */
  const render = (v, max) => {
    max = max || 20000;
    const seen = new WeakSet();
    let text;
    try {
      text = JSON.stringify(v, (_k, x) => {
        if (typeof x === 'bigint') return `${x}n`;
        if (typeof x === 'function') return `[function ${x.name || ''}]`;
        if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
        return x;
      });
    } catch (e) { text = JSON.stringify(`[unrenderable: ${e && e.message}]`); }
    if (text === undefined) return undefined;
    return text.length > max ? { truncated: text.length, head: text.slice(0, max) } : JSON.parse(text);
  };

  // ---- the hold: one record per window's webContents
  const views = new Map();
  globalThis.__codexmodsQaAppHost = ({ sender, host, view, manager }) => {
    try {
      const id = sender.id;
      const rec = { sender, host, view, manager, wrapped: new Map() };
      views.set(id, rec);
      if (host) interposeAll(rec);
      sender.once('destroyed', () => views.delete(id));
      log({ ev: 'hold', wc: id, url: sender.getURL(), services: host ? Object.keys(host.services || {}).length : null });
    } catch (e) { log({ ev: 'hold.error', error: String(e && e.message || e) }); }
  };

  // ---- the load-time edit at the listener: 21477's own spelling, 22943's (the host made inline, which the framework's app-host
  // seam has already named `__cmH`), or 25679's (the host bound, a close listener between, the view made in its own declaration)
  const RE = /([$\w]+)=([$\w]+)\?\.createAppHost\(([$\w]+)\.sender\),([$\w]+)=([$\w]+)\(([$\w]+),\1\);\2\?\.registerAppView\(\3\.sender,\4\)/g;
  const RE_INLINE = /([$\w]+)=([$\w]+)\(([$\w]+)\.sender\),__cmH=\1\?\.createAppHost\(\3\.sender\),([$\w]+)=([$\w]+)\(([$\w]+),__cmH\);null!=\1&&\1\.registerAppView\(\3\.sender,\4\)/g;
  const RE_SPLIT = /([$\w]+)=([$\w]+)\?\.createAppHost\(([$\w]+)\.sender\),[^{}]{0,300}?;let ([$\w]+)=[$\w]+\([$\w]+,\1\);null!=\2&&\2\.registerAppView\(\3\.sender,\4\)/g;
  const compile = Module.prototype._compile;
  Module.prototype._compile = function probeCompile(content, filename) {
    if (typeof content === 'string' && /[\\/]\.vite[\\/]build[\\/](?:main-[^\\/]+|early-bootstrap(?:-[^\\/]+)?)\.js$/.test(String(filename))) {
      const n = (content.match(RE) || []).length;
      const m = (content.match(RE_INLINE) || []).length;
      const k = (content.match(RE_SPLIT) || []).length;
      if (n + m + k) log({ ev: 'edit', file: path.basename(filename), matches: n + m + k });
      if (k === 1 && n + m === 0) {
        content = content.replace(RE_SPLIT, (all, host, mgr, e, view) => all.replace(`;null!=${mgr}&&`,
          `;globalThis.__codexmodsQaAppHost?.({sender:${e}.sender,host:${host},view:${view},manager:${mgr}});null!=${mgr}&&`));
      } else if (n === 1 && m === 0) {
        content = content.replace(RE, (_m, r, mgr, e, i, session, port) => `${r}=${mgr}?.createAppHost(${e}.sender),${i}=${session}(${port},${r});`
          + `globalThis.__codexmodsQaAppHost?.({sender:${e}.sender,host:${r},view:${i},manager:${mgr}});${mgr}?.registerAppView(${e}.sender,${i})`);
      } else if (m === 1 && n === 0) {
        content = content.replace(RE_INLINE, (all, mgr, _get, e, i) => all.replace(`;null!=${mgr}&&`,
          `;globalThis.__codexmodsQaAppHost?.({sender:${e}.sender,host:__cmH,view:${i},manager:${mgr}});null!=${mgr}&&`));
      }
    }
    return compile.call(this, content, filename);
  };

  // ---- commands
  const pick = (wc) => {
    if (wc != null) { const v = views.get(Number(wc)); if (!v) throw new Error(`no held window ${wc}`); return v; }
    const live = [...views.values()].filter((v) => !v.sender.isDestroyed());
    if (!live.length) throw new Error('no held window');
    return live.find((v) => /app\.html|index\.html/.test(v.sender.getURL())) || live[0];
  };
  const resolve = (rec, p) => {
    let parent = null; let cur = rec.host.services;
    (p || []).forEach((k, i) => { parent = cur; cur = cur == null ? undefined : (i === 0 ? rec.wrapped.get(k)?.real ?? cur[k] : cur[k]); });
    return { parent, value: cur };
  };
  const methodsOf = (o) => {
    const names = new Set();
    for (let p = Object.getPrototypeOf(o); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(p, k).value === 'function') names.add(k);
    }
    return [...names].sort();
  };

  /**
   * Interposes on every entry of the window's services at the hold, before the window first reads them: the window keeps the stubs it
   * gets then, so a later replacement would never see its calls. Each entry becomes a pass-through proxy over the real service; `wrap`
   * then turns logging or refusal on per method (or `*` for the whole service) for this window only.
   */
  const interpose = (rec, svc) => {
    const services = rec.host.services;
    const real = services[svc];
    if (real == null || (typeof real !== 'object' && typeof real !== 'function')) return null;
    const entry = { real, modes: new Map() };
    rec.wrapped.set(svc, entry);
    services[svc] = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof v !== 'function') return v;
        const m = typeof k === 'string' ? (entry.modes.get(k) ?? entry.modes.get('*')) : undefined;
        if (!m) return v.bind(t);
        return async (...args) => {
          log({ ev: 'call', wc: rec.sender.id, method: `${svc}.${k}`, mode: m, args: render(args, 2000) });
          if (m === 'refuse') throw new Error(`refused by the G-apphost probe: ${svc}.${k}`);
          try { const r = await v.apply(t, args); log({ ev: 'call.done', wc: rec.sender.id, method: `${svc}.${k}`, result: render(r, 2000) }); return r; } catch (e) { log({ ev: 'call.error', method: `${svc}.${k}`, error: String(e && e.message || e) }); throw e; }
        };
      },
    });
    return entry;
  };
  // Modes applied at every hold (so calls a window makes while it loads are seen): set with `wrapBoot`.
  const bootModes = [];
  const interposeAll = (rec) => {
    for (const svc of Object.keys(rec.host.services || {})) interpose(rec, svc);
    for (const b of bootModes) { const e = rec.wrapped.get(b.svc); if (e) e.modes.set(b.method, b.mode); }
  };

  const wrap = (rec, svc, method, mode) => {
    const entry = rec.wrapped.get(svc) ?? interpose(rec, svc);
    if (!entry) throw new Error(`no service ${svc}`);
    if (method !== '*' && typeof entry.real[method] !== 'function') throw new Error(`no method ${svc}.${method}`);
    entry.modes.set(method, mode);
    return { wrapped: `${svc}.${method}`, mode };
  };

  // ---- the app bus (G-bus): matched by channel name only
  const FROM_VIEW = 'codex_desktop:message-from-view';
  const FOR_VIEW = 'codex_desktop:message-for-view';
  const bus = { fromView: null, counts: {}, recent: [], pending: new Map(), last: {} };
  // The last payload per message type, except protocol and fetch traffic (which can carry conversation content).
  const NO_PAYLOAD = /^(mcp-|fetch|log-message)/;
  const MCP_KEEP = /^(account\/rateLimits\/updated|thread\/status\/changed|thread\/queue\/changed|thread\/settings\/updated|thread\/readState\/changed|thread\/tokenUsage\/updated)$/;
  const note = (direction, msg) => {
    const type = msg && typeof msg === 'object' ? String(msg.type) : typeof msg;
    bus.counts[`${direction} ${type}`] = (bus.counts[`${direction} ${type}`] || 0) + 1;
    const rec = { direction, type };
    if (msg && msg.type === 'fetch' && typeof msg.url === 'string') rec.url = msg.url.split('?')[0];
    if (msg && msg.type === 'fetch-response') rec.requestId = msg.requestId;
    // Protocol traffic on the bus: count by host and method only (never content); record the message's top-level keys once.
    if (msg && (msg.type === 'mcp-request' || msg.type === 'mcp-notification' || msg.type === 'mcp-response')) {
      const inner = msg.request || msg.notification || msg.message || {};
      const method = inner.method ?? msg.method ?? '-';
      const key = `${direction} ${msg.type} ${msg.hostId ?? '?'} ${method}`;
      bus.counts[key] = (bus.counts[key] || 0) + 1;
      // Content-free notifications whose payloads the proofs need (status, rate limits, queue, settings, read state).
      if (msg.type === 'mcp-notification' && MCP_KEEP.test(method)) {
        const list = bus.last[`mcp ${method}`] || (bus.last[`mcp ${method}`] = []);
        list.push({ at: Date.now(), hostId: msg.hostId, params: render(msg.params, 800) });
        if (list.length > 8) list.shift();
      }
      if (!bus.mcpKeys) bus.mcpKeys = {};
      if (!bus.mcpKeys[msg.type]) bus.mcpKeys[msg.type] = { keys: Object.keys(msg), inner: Object.keys(inner) };
    }
    if (msg && typeof msg === 'object' && msg.type === undefined) rec.keys = Object.keys(msg).slice(0, 8);
    bus.recent.push(rec);
    if (bus.recent.length > 300) bus.recent.shift();
    if (msg && typeof msg === 'object' && typeof msg.type === 'string' && !NO_PAYLOAD.test(msg.type)) {
      const k = `${direction} ${msg.type}`;
      const list = bus.last[k] || (bus.last[k] = []);
      list.push({ at: Date.now(), msg: render(msg, 800) });
      if (list.length > 5) list.shift();
    }
  };
  let electron = null;
  try { electron = require('electron'); } catch { /* not in Electron (headless tests) */ }
  if (electron && electron.ipcMain && electron.app) {
    const { ipcMain, app } = electron;
    // X1: refusals at the bus handler (`refuse` op): `fetch:<handler>` refuses that fetch with an error response; any other entry drops
    // bus messages of that type. Each refusal is recorded.
    const refusedBy = (msg) => {
      const R = bus.refuse;
      if (!R || !R.size || !msg || typeof msg !== 'object') return null;
      if (msg.type === 'fetch') { const name = String(msg.url || '').replace(/^vscode:\/\/codex\//, '').split(/[?#]/)[0]; return R.has(`fetch:${name}`) ? `fetch:${name}` : null; }
      return R.has(msg.type) ? msg.type : null;
    };
    const observed = (fn) => function observedFromView(event, msg, ...rest) {
      note('from-view', msg);
      const hit = refusedBy(msg);
      if (hit) {
        bus.refusals = [...(bus.refusals || []).slice(-19), { at: Date.now(), what: hit, requestId: msg.requestId ?? null }];
        if (msg.type === 'fetch' && event && event.sender) event.sender.send(FOR_VIEW, { type: 'fetch-response', requestId: msg.requestId, responseType: 'error', status: 403, error: 'Refused by Codex Mods (QA)' });
        return undefined;
      }
      return fn.call(this, event, msg, ...rest);
    };
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => {
      const workerMatch = /^codex_desktop:worker:(.+):from-view$/.exec(String(channel));
      if (workerMatch) { (bus.workers || (bus.workers = {}))[workerMatch[1]] = fn; log({ ev: 'bus.worker-handler', worker: workerMatch[1] }); }
      // P7: the native context menu. The wrapper records each request's items (labels and ids) and, when `bus.menuAppend` is set, appends a
      // framework item; choosing it is answered here (the renderer gets no selection) and counted.
      if (channel === 'codex_desktop:show-context-menu') {
        log({ ev: 'bus.menu-handler' });
        return handle(channel, async (ev, items, opts, ...rest) => {
          const flat = (l) => (Array.isArray(l) ? l.map((x) => (x && typeof x === 'object' ? { id: x.id ?? null, label: x.label ?? x.type ?? null, sub: x.submenu ? flat(x.submenu).length : undefined } : x)) : l);
          bus.menus = [...(bus.menus || []).slice(-4), { items: flat(items), opts: render(opts, 600) }];
          const add = bus.menuAppend && Array.isArray(items) ? [...items, { type: 'separator' }, { id: 'codexmods-qa', label: 'Codex Mods QA item' }] : items;
          // `menus {choose: id}`: answer the next request with `{id}`, as main's handler does when the user picks that item (no popup).
          if (bus.menuChoose) { const id = bus.menuChoose; bus.menuChoose = null; bus.menus[bus.menus.length - 1].chose = id; return { id }; }
          const r = await fn(ev, add, opts, ...rest);
          if (r === 'codexmods-qa' || (r && r.id === 'codexmods-qa')) { bus.menuRuns = (bus.menuRuns || 0) + 1; return null; }
          return r;
        });
      }
      if (channel !== FROM_VIEW) return handle(channel, fn);
      bus.fromView = fn;
      log({ ev: 'bus.handler', channel, kind: 'handle' });
      return handle(channel, observed(fn));
    };
    const on = ipcMain.on.bind(ipcMain);
    ipcMain.on = (channel, fn) => {
      if (channel !== FROM_VIEW) return on(channel, fn);
      log({ ev: 'bus.handler', channel, kind: 'on' });
      return on(channel, observed(fn));
    };
    app.on('web-contents-created', (_e, wc) => {
      // Renderer warnings and errors, newest last (the `console` command reads them).
      wc.on('console-message', (ev, level, message) => {
        const lvl = ev && typeof ev === 'object' && 'level' in ev ? ev.level : level;
        const msg = ev && typeof ev === 'object' && 'message' in ev ? ev.message : message;
        if (lvl === 'warning' || lvl === 'error' || lvl === 2 || lvl === 3) { (bus.console ||= []).push({ wc: wc.id, level: lvl, message: String(msg).slice(0, 1500) }); if (bus.console.length > 60) bus.console.shift(); }
      });
      const send = wc.send.bind(wc);
      wc.send = (channel, msg, ...rest) => {
        if (/^codex_desktop:worker:.+:for-view$/.test(String(channel))) {
          const id = msg && msg.response ? msg.response.id : undefined;
          const settleW = id !== undefined ? bus.pending.get(`worker:${id}`) : undefined;
          if (settleW) { bus.pending.delete(`worker:${id}`); settleW(msg); return undefined; }
        }
        if (channel === FOR_VIEW) {
          note('for-view', msg);
          const settle = msg && msg.type === 'fetch-response' ? bus.pending.get(msg.requestId) : undefined;
          if (settle) { bus.pending.delete(msg.requestId); settle(msg); return undefined; }
          const wid = msg && msg.type === 'worker-response' && msg.response ? msg.response.id : undefined;
          const settleWorker = wid !== undefined ? bus.pending.get(`worker:${wid}`) : undefined;
          if (settleWorker) { bus.pending.delete(`worker:${wid}`); settleWorker(msg); return undefined; }
        }
        return send(channel, msg, ...rest);
      };
    });
  }

  // ---- the JSX seam (G-jsx): a serve-time edit of the renderer chunk that holds the JSX factory
  const JSX_RE = /([$\w]+)\.Fragment=([$\w]+|Symbol\.for\("react\.fragment"\)),\1\.jsx=([$\w]+),\1\.jsxs=\3\}/g;   // rspack (25679) writes the fragment inline
  const seamJsx = (text) => {
    const n = (text.match(JSX_RE) || []).length;
    if (n !== 1) return { text, n };
    return { n, text: text.replace(JSX_RE, (_m, ns, frag, f) => `${ns}.Fragment=${frag},globalThis.__codexmodsJsxFactory=${f},${ns}.jsx=${ns}.jsxs=function(a,b,c){var h=globalThis.__codexmodsJsx;`
      + `if(h===void 0)return ${f}(a,b,c);try{return h(${f},a,b,c)}catch(x){globalThis.__codexmodsJsxErrors=(globalThis.__codexmodsJsxErrors|0)+1;return ${f}(a,b,c)}}}`) };
  };
  // ---- exposures of the app's mechanics (G-app); each regex must match once in its chunk, or that edit is skipped and logged
  const NS = '(globalThis.__codexmodsApp||(globalThis.__codexmodsApp={}))';
  const APP_EDITS = [
    {
      name: 'appShell', chunk: 'app-initial',
      re: /([$\w]+)=(\{PaneHeaderRow:[$\w]+,[^;]{0,2500}?HeaderAction:\(0,[$\w]+\.memo\)\([$\w]+\),HeaderContextMenuItem:[^;]{0,2500}?DetailPanelOutlet:\(0,[$\w]+\.memo\)\([$\w]+\)\})/g,
      rep: (_m, name, lit) => `${name}=((o)=>(${NS}.AppShell=o,o))(${lit})`,
    },
    {
      name: 'tabRegistry', chunk: 'app-initial',
      re: /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=\{\.\.\.\4,externalDrop:\4\.externalDrop\?\?([$\w]+)\.get\(\2\)\?\.externalDrop,Component:\3,dropDestinations:\4\.dropDestinations\?\?([$\w]+),kind:\2\};return \6\.set\(\2,\5\),\5\}/g,
      rep: (m, bl, _a, _b, _c, _d, reg) => `${m};(function(a){a.registerTabType=${bl};Object.defineProperty(a,'tabRegistry',{configurable:true,get:function(){return ${reg}}})})(${NS});`,
    },
    {
      name: 'panelControllers', chunk: 'app-initial',
      re: /([$\w]+)=\(([$\w]+),([$\w]+),([$\w]+)\)=>\(\4\.target===`bottom`&&\3\.dropDestinations\.includes\(`bottom`\)\?([$\w]+):([$\w]+)\)\.openTab\(\2,\3,\4\)/g,
      rep: (m, open, _a, _b, _c, bottom, right) => `${m},(function(a){a.openPanelTab=${open};a.rightPanel=${right};a.bottomPanel=${bottom}})(${NS})`,
    },
    {
      name: 'modal', chunk: 'app-initial',
      re: /function (?<open>[$\w]+)\((?<s>[$\w]+),(?<c>[$\w]+),(?<p>[$\w]+),(?<o>[$\w]+)\)\{\k<s>\.set\((?<atom>[$\w]+),(?<m>[$\w]+)=>\{let (?<f>[$\w]+)=\k<m>\.modals\.find\(\k<m>=>(?<same>[$\w]+)\(\k<m>\.ModalComponent,\k<c>\)\),(?<n>[$\w]+)=\{key:\k<f>\?\.key\?\?\k<m>\.nextKey,ModalComponent:\k<c>,props:\k<p>,blocksOtherModals:\k<o>\?\.blocksOtherModals\?\?!0\};return \k<f>\?\{\.\.\.\k<m>,modals:\[\.\.\.\k<m>\.modals\.filter\(\k<m>=>!\k<same>\(\k<m>\.ModalComponent,\k<c>\)\),\k<n>\]\}:\{\.\.\.\k<m>,modals:\[\.\.\.\k<m>\.modals,\k<n>\],nextKey:\k<m>\.nextKey\+1\}\}\)\}function (?<close>[$\w]+)\(\k<s>,\k<c>\)\{\k<s>\.set\(\k<atom>,\k<m>=>\{let (?<r>[$\w]+)=\k<m>\.modals\.filter\(\k<m>=>!\k<same>\(\k<m>\.ModalComponent,\k<c>\)\);return \k<r>\.length===\k<m>\.modals\.length\?\k<m>:\{\.\.\.\k<m>,modals:\k<r>\}\}\)\}function (?<closeAll>[$\w]+)\(\k<s>\)\{\k<s>\.set\(\k<atom>,\k<m>=>\(\{\.\.\.\k<m>,modals:\[\]\}\)\)\}function (?<isOpen>[$\w]+)\(\k<s>,\k<c>\)\{return \k<s>\.get\(\k<atom>\)\.modals\.some\(\k<m>=>\k<same>\(\k<m>\.ModalComponent,\k<c>\)\)\}/g,
      rep: (m, ...rest) => { const g = rest[rest.length - 1]; return `${m};(function(a){a.openModal=${g.open};a.closeModal=${g.close};a.closeAllModals=${g.closeAll};a.isModalOpen=${g.isOpen}})(${NS});`; },
    },
    {
      name: 'toast', chunk: 'app-shared',
      re: /function ([$\w]+)\(\)\{return ([$\w]+)\}function ([$\w]+)\(([$\w]+)\)\{return \2=\4,\(\)=>\{\2===\4&&\(\2=([$\w]+)\)\}\}function ([$\w]+)\(([$\w]+),([$\w]+)\)\{return \7\.set\(([$\w]+),\8\),\(\)=>\{\7\.get\(\9\)===\8&&\7\.set\(\9,\5\),\8\.closeAll\(\)\}\}/g,
      rep: (m, getter, _cur, _reg, _p, _stub, _bind, _s, _t, atom) => `;(function(a){a.getToast=${getter};Object.defineProperty(a,'toastAtom',{configurable:true,get:function(){return ${atom}}})})(${NS});${m}`,
    },
    {
      // The app's message bus (a singleton class): `Bus.getInstance().dispatchHostMessage(msg)` delivers a host message in this window,
      // `dispatchMessage(type, payload)` sends to main (A13: a framework settings nav entry navigates with it).
      name: 'bus', chunk: 'app-shared',
      re: /(([$\w]+)=class e\{static instance=null;static getInstance\(\)\{return this\.instance\?\?=new e,this\.instance\})/g,
      rep: (_m, head) => `${head}static __codexmodsBus=(${NS}.Bus=e,0);`,
    },
    {
      // The app's React module (the CJS factory's exports), for hooks in framework components (P1: a stable wrapper on a store).
      name: 'react', chunk: 'app-shared',
      re: /(([$\w]+)\.useTransition=function\(\)\{return [$\w]+\.H\.useTransition\(\)\},\2\.version=`[\d.]+`)\}/g,
      rep: (_m, body, e) => `${body},${NS}.React=${e}}`,
    },
    {
      name: 'useScope', chunk: 'app-shared',
      re: /(?<head>function (?<f>[$\w]+)\((?<e>[$\w]+)\)\{let (?<t>[$\w]+)=\(0,(?<R>[$\w]+)\.useContext\)\([$\w]+\(\k<e>\)\),(?<n>[$\w]+)=[$\w]+\(\k<t>,\k<e>\),(?<r>[$\w]+)=[$\w]+\(\k<n>\),(?<i>[$\w]+)=\(0,\k<R>\.useRef\)\(null\);if\(\k<i>\.current==null\|\|\k<i>\.current\.node!==\k<n>\)\{let (?<a>[$\w]+)=\{chain:\k<t>,getOwnValue\([$\w]+\)\{[^]{0,6000}?\}else \k<i>\.current\.chain=\k<t>,\k<i>\.current\.value=\k<r>;)return \k<i>\.current\}/g,
      rep: (m, ...rest) => { const g = rest[rest.length - 1]; return `${g.head}return(${NS}.scopes||(${NS}.scopes={}))[${g.e}.__scopeBrand]=${g.i}.current}${NS}.useScope=${g.f};`; },
    },
    {
      name: 'headerSlots', chunk: 'app-initial',
      re: /([$\w]+)=(\{center:[$\w]+,left:[$\w]+,right:[$\w]+,main:[$\w]+,thread:[$\w]+,threadSummary:[$\w]+\})/g,
      rep: (_m, name, lit) => `${name}=((o)=>(${NS}.headerSlots=o,o))(${lit})`,
    },
  ];
  // Batch 5 exposures (G7, G8, P10, P12), found and verified by a scout (8 assignment-only edits, one optional seam that
  // calls a page hook on every command run). Kept in their own scope: their helper names stay local.
  const B5 = (function batch5() {
  // Serve-time exposure edits for build 26.1013.40934 (20770), batch 5 (G7, G8, P10, P12).
  // Same contract as APP_EDITS in scripts/qa/probe/native.cjs: `re` matches exactly once in the named chunk (global flag),
  // `rep` only assigns the app's own objects to globalThis.__codexmodsApp. Behaviour of the app is unchanged.
  // Chunk keys are the base names: 'app-initial', 'app-primary'. `app-primary` is NEW for the probe's protocol handler
  // (it needs one more branch for /assets/app-primary-*.js; see proposal.md).
  //
  // Rule used throughout: a module-level `var X` that the app assigns inside a lazy initializer (`X=cs(...)` inside `function lj(){...}`)
  // is exposed through a getter, never by value, because these statements run at chunk evaluation, before the initializer. Function
  // declarations are hoisted and are exposed by value.

  const NS = '(globalThis.__codexmodsApp||(globalThis.__codexmodsApp={}))';

  /** Build a RegExp from source text where `@name@` is a minified-name capture on first use and a back-reference after. */
  const rx = (text) => {
    const seen = new Set();
    const out = text.replace(/@(\w+)@/g, (_m, n) => {
      if (seen.has(n)) return `\\k<${n}>`;
      seen.add(n);
      return `(?<${n}>[$\\w]+)`;
    });
    return new RegExp(out, 'g');
  };
  const get = (obj, name, expr) => `Object.defineProperty(${obj},'${name}',{configurable:true,get:function(){return ${expr}}});`;

  const edits = [
    // ---- G7: the command handler stack and the runner -------------------------------------------------------------------
    {
      // function tbr(e,t,{isActive:n,priority:r=`normal`}){let i={handler:t,isActive:n,priority:r},a=Abr.get(e)??[];return a.push(i),Abr.set(e,a),()=>{...}}
      // function cj(e,t,n){return ibr(e,void 0,t,n)}  function nbr(e,t,n){return ibr(e,t,`keyboard_shortcut`,n)}  function rbr(e){return kbr.has(e)}
      // function ibr(e,t,n,r){let i=Abr.get(e);for(let e of[`normal`,`fallback`])...}  function abr(e){for(let[t,n]of kbr)if(t===e)return n}
      name: 'commandStack', chunk: 'app-initial',
      re: rx(
        String.raw`function @reg@\(@e1@,@t1@,\{isActive:@n1@,priority:@r1@=\`normal\`\}\)\{let @i1@=\{handler:@t1@,isActive:@n1@,priority:@r1@\},@a1@=@map@\.get\(@e1@\)\?\?\[\];return @a1@\.push\(@i1@\),@map@\.set\(@e1@,@a1@\),\(\)=>\{let @t2@=@map@\.get\(@e1@\);if\(!@t2@\)return;let @n2@=@t2@\.lastIndexOf\(@i1@\);@n2@!==-1&&\(@t2@\.splice\(@n2@,1\),@t2@\.length===0&&@map@\.delete\(@e1@\)\)\}\}`
        + String.raw`function @run@\(@e3@,@t3@,@n3@\)\{return @ibr@\(@e3@,void 0,@t3@,@n3@\)\}`
        + String.raw`function @key@\(@e4@,@t4@,@n4@\)\{return @ibr@\(@e4@,@t4@,\`keyboard_shortcut\`,@n4@\)\}`
        + String.raw`function @has@\(@e5@\)\{return @defs@\.has\(@e5@\)\}`
        + String.raw`function @ibr@\(@e6@,@t6@,@n6@,@r6@\)\{(?:var __cmH=globalThis\.__codexmodsRunHook;if\(__cmH!==void 0\)try\{__cmH\(@e6@,@n6@,@t6@,@r6@\)\}catch\(__cmX\)\{\})?let @i6@=@map@\.get\(@e6@\);for\(let @e7@ of\[\`normal\`,\`fallback\`\]\)for\(let @a6@=\(@i6@\?\.length\?\?0\)-1;@a6@>=0;@a6@--\)\{let @o6@=@i6@\?\.\[@a6@\];if\(@o6@\?\.priority===@e7@&&@o6@\.isActive\(@r6@\)&&@o6@\.handler\(@n6@,@t6@,@r6@\)!==!1\)return!0\}let @a7@=@def@\(@e6@\);return @a7@!=null&&@a7@\(@n6@\)!==!1\}`
        + String.raw`function @def@\(@e8@\)\{for\(let\[@t8@,@n8@\]of @defs@\)if\(@t8@===@e8@\)return @n8@\}`),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `${m};(function(a){var c=a.commands||(a.commands={});c.register=${g.reg};c.run=${g.run};c.runKeyboard=${g.key};c.runner=${g.ibr};`
          + `c.hasDefault=${g.has};c.defaultHandler=${g.def};${get('c', 'stack', g.map)}${get('c', 'defaults', g.defs)}})(${NS});`;
      },
    },
    {
      // The hook the app's components call: function uj(e,t,n){let r=(0,Nbr.c)(17),i;...n=tbr(e,_,{isActive:h,priority:f});return p.set(nj,n=>jbr(n,e,t)),()=>{n(),p.set(nj,n=>Mbr(n,e,t))},y=[...],...,(0,Pbr.useEffect)(v,y)}
      // then function jbr(e,t,n){return{...e,[t]:[...e[t]??[],n]}}  function Mbr(e,t,n){...splice...}
      // `nj` is the AppScope atom the palette reads (command-menu-dialog's `Br`; it hides a table command when Cyr(atom,id)===0, Cyr=e[t]?.length??0).
      name: 'commandRegistered', chunk: 'app-initial',
      re: rx(
        String.raw`function @hook@\(@e@,@t@,@n@\)\{let @r@=\(0,@c@\.c\)\(17\),`
        + String.raw`[^]{0,1800}?@un@=@reg@\(@e@,@fn@,\{isActive:@act@,priority:@pri@\}\);return @sc@\.set\(@atom@,@u@=>@add@\(@u@,@e@,@item@\)\),\(\)=>\{@un@\(\),@sc@\.set\(@atom@,@u@=>@rem@\(@u@,@e@,@item@\)\)\}`
        + String.raw`[^]{0,400}?\(0,@pr@\.useEffect\)\(@v@,@y@\)\}`
        + String.raw`function @add@\(@e2@,@t2@,@n2@\)\{return\{\.\.\.@e2@,\[@t2@\]:\[\.\.\.@e2@\[@t2@\]\?\?\[\],@n2@\]\}\}`
        + String.raw`function @rem@\(@e3@,@t3@,@n3@\)\{let @r3@=@e3@\[@t3@\];if\(@r3@==null\)return @e3@;let @i3@=@r3@\.lastIndexOf\(@n3@\);if\(@i3@===-1\)return @e3@;if\(@r3@\.length===1\)\{let @n4@=\{\.\.\.@e3@\};return delete @n4@\[@t3@\],@n4@\}let @a3@=\[\.\.\.@r3@\];return @a3@\.splice\(@i3@,1\),\{\.\.\.@e3@,\[@t3@\]:@a3@\}\}`),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `${m};(function(a){var c=a.commands||(a.commands={});c.useHandler=${g.hook};c.addRegistered=${g.add};c.removeRegistered=${g.rem};${get('c', 'registeredAtom', g.atom)}})(${NS});`;
      },
    },

    // ---- G8: the slash registry -----------------------------------------------------------------------------------------
    {
      // M0l=cs(U,[]),N0l=cs(xb,[]),P0l=cs(xb,0),F0l=Y(xb,({get:e})=>S0l((0,j0l.default)([...e(N0l),...e(M0l)],e=>e.id))),I0l=/^\s*\/[^/\r\n]*\s*$/})))()}
      // M0l = AppScope atom (written by hook g0l), N0l = ComposerScope atom (written by hook f0l), F0l = the merged, deduped list the slash menu reads.
      name: 'slashRegistry', chunk: 'app-initial',
      re: rx(
        String.raw`@app@=@cs@\(@appScope@,\[\]\),@comp@=@cs@\(@compScope@,\[\]\),@cnt@=@cs@\(@compScope@,0\),`
        + String.raw`@merged@=@Y@\(@compScope@,\(\{get:@g@\}\)=>@sort@\(\(0,@ld@\.default\)\(\[\.\.\.@g@\(@comp@\),\.\.\.@g@\(@app@\)\],@x@=>@x@\.id\)\)\),`
        + String.raw`@trig@=\/\^\\s\*\\\/\[\^\/\\r\\n\]\*\\s\*\$\/\}\)\)\)\(\)\}`),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `${m};(function(a){var s=a.slash||(a.slash={});${get('s', 'appAtom', g.app)}${get('s', 'composerAtom', g.comp)}${get('s', 'openCountAtom', g.cnt)}${get('s', 'mergedAtom', g.merged)}s.sortItems=${g.sort}})(${NS});`;
      },
    },

    {
      // The registration hooks, contiguous in the source:
      // function f0l(e){let t=(0,k0l.c)(7),n,r;...({dependencies:r,...n}=e...);...let a=i,o=hi(xb),s=(0,c5.useContext)(ly),c;...(c=e=>{o.set(N0l,e)}...),_0l(c,n,a,s)}   (ComposerScope item; 34 call sites in app-primary)
      // function p0l(e,t,n){let r=(0,k0l.c)(6),i=n!==void 0&&n,a=hi(xb),...}                                                                              (list form)
      // function g0l(e){...o=hi(U),s;...(s=e=>{o.set(M0l,e)}...),_0l(s,n,a,null)}                                                                          (AppScope item; the `feedback` item)
      name: 'slashHooks', chunk: 'app-initial',
      re: rx(
        String.raw`function @f0@\(@e1@\)\{let @t1@=\(0,@k@\.c\)\(7\),@n1@,@r1@;@t1@\[0\]===@e1@\?\(@n1@=@t1@\[1\],@r1@=@t1@\[2\]\):\(\{dependencies:@r1@,\.\.\.@n1@\}=@e1@,@t1@\[0\]=@e1@,@t1@\[1\]=@n1@,@t1@\[2\]=@r1@\);let @i1@;@t1@\[3\]===@r1@\?@i1@=@t1@\[4\]:\(@i1@=@r1@===void 0\?\[\]:@r1@,@t1@\[3\]=@r1@,@t1@\[4\]=@i1@\);let @a1@=@i1@,@o1@=@hi@\(@scC@\),@s1@=\(0,@c5@\.useContext\)\(@ctx@\),@c1@;@t1@\[5\]===@o1@\?@c1@=@t1@\[6\]:\(@c1@=@x1@=>\{@o1@\.set\(@atC@,@x1@\)\},@t1@\[5\]=@o1@,@t1@\[6\]=@c1@\),@core@\(@c1@,@n1@,@a1@,@s1@\)\}`
        + String.raw`function @p0@\(@e2@,@t2@,@n2@\)\{let @r2@=\(0,@k@\.c\)\(6\),@i2@=@n2@!==void 0&&@n2@,@a2@=@hi@\(@scC@\),`
        + String.raw`[^]{0,700}?`
        + String.raw`function @g0@\(@e3@\)\{let @t3@=\(0,@k@\.c\)\(7\),@n3@,@r3@;@t3@\[0\]===@e3@\?\(@n3@=@t3@\[1\],@r3@=@t3@\[2\]\):\(\{dependencies:@r3@,\.\.\.@n3@\}=@e3@,@t3@\[0\]=@e3@,@t3@\[1\]=@n3@,@t3@\[2\]=@r3@\);let @i3@;@t3@\[3\]===@r3@\?@i3@=@t3@\[4\]:\(@i3@=@r3@===void 0\?\[\]:@r3@,@t3@\[3\]=@r3@,@t3@\[4\]=@i3@\);let @a3@=@i3@,@o3@=@hi@\(@scA@\),@s3@;@t3@\[5\]===@o3@\?@s3@=@t3@\[6\]:\(@s3@=@x3@=>\{@o3@\.set\(@atA@,@x3@\)\},@t3@\[5\]=@o3@,@t3@\[6\]=@s3@\),@core@\(@s3@,@n3@,@a3@,null\)\}`),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `${m};(function(a){var s=a.slash||(a.slash={});s.useComposerItem=${g.f0};s.useComposerItems=${g.p0};s.useAppItem=${g.g0};s.registerCore=${g.core}})(${NS});`;
      },
    },

    // ---- P12: composer banners (chunk app-primary) ----------------------------------------------------------------------
    {
      // function kHe(e,t){for(let{id:n,areas:r}of jHe){...}return null}  function AHe(e,t){return{id:e,isEligible:...,isLoading:!1,content:t}}
      // var jHe;function iN(){return(iN=e((()=>{jHe=[{id:`misalignment-policy`,areas:[`home`,`task`]},...]})))()}
      // function aN(e){let t=(0,MHe.c)(6),{area:n,candidates:r,homeCandidates:i}=e,...  (the list component the lazy `ComposerBanners` chunk renders)
      name: 'composerBanners', chunk: 'app-primary',
      re: rx(
        String.raw`function @sel@\(@e@,@t@\)\{for\(let\{id:@n@,areas:@r@\}of @list@\)\{if\(!@r@\.some\(@e2@=>@e2@===@t@\)\)continue;let @i@=@e@\.find\(@e3@=>@e3@\.id===@n@\);if\(@i@\?\.isLoading&&!@i@\.showEligibleWhileLoading\)return;if\(@i@\?\.isEligible\)return @i@;if\(@i@\?\.isLoading\)return\}return null\}`
        + String.raw`function @mk@\(@e4@,@t4@\)\{return\{id:@e4@,isEligible:@t4@!=null&&typeof @t4@!=\`boolean\`,isLoading:!1,content:@t4@\}\}`
        + String.raw`var @list@;function @init@\(\)\{return\(@init@=@w@\(\(\(\)=>\{@list@=\[\{id:\`misalignment-policy\`,areas:\[\`home\`,\`task\`\]\}[^]{0,3200}?\]\}\)\)\)\(\)\}`
        + String.raw`function @comp@\(@p@\)\{let @c@=\(0,@mm@\.c\)\(6\),\{area:@a1@,candidates:@a2@,homeCandidates:@a3@\}=@p@,`),
      // inserted BEFORE the match (hoisted function declarations; jHe is read lazily because the lazy initializer assigns it)
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `;(function(a){var b=a.banners||(a.banners={});b.select=${g.sel};b.candidate=${g.mk};b.List=${g.comp};${get('b', 'order', g.list)}})(${NS});${m}`;
      },
    },

    // ---- P12: the app route table (chunk app-initial) ------------------------------------------------------------------
    {
      // ...Lxe(_Ol),vOl=(0,S8.jsx)(Wo,{element:void 0,children:_Ol}),yOl=Lxe(vOl)})))()}   ; used as `function GIu(e){return poe(yOl)}` (poe = useRoutes) and `u=DNe(yOl,s)`
      name: 'routes', chunk: 'app-initial',
      re: rx(String.raw`,@wrap@=\(0,@jsx@\.jsx\)\(@Route@,\{element:void 0,children:@inner@\}\),@table@=@create@\(@wrap@\)(?=\}\)\)\)\(\)\})`),
      rep: (_m, wrap, jsx, Route, inner, table, create) =>
        `,${wrap}=(0,${jsx}.jsx)(${Route},{element:void 0,children:${inner}}),${table}=((o)=>(${NS}.routes=o,o))(${create}(${wrap}))`,
    },

    // ---- P10: panel slot publishers (chunk app-initial) ----------------------------------------------------------------
    {
      // function t_o(e){let{children:t}=e;return wJ(hi(Qy),SXt,t),null}  x4: RightPanelTabsEmptyState, RightPanelTabListAfter, RightPanelTabListBefore, RightPanelTabListAfterSticky
      // function a_o(){return null}function o_o(){...}                       (BottomPanel, BottomPanelTabs)
      // then x4: BottomPanelTabsEmptyState, BottomPanelTabListAfter, BottomPanelTabListAfterSticky, BottomPanelOutlet
      // then function wJ(e,t,n){...(0,EJ.useLayoutEffect)(i,a)...e.set(t,null)...}.  Pairs are in source order; the probe maps a pair to an AppShell key with `AppShell[key].type===fn`.
      name: 'panelSlots', chunk: 'app-initial',
      re: (() => {
        const first = (k) => String.raw`function @f${k}@\(@e${k}@\)\{let\{children:@c${k}@\}=@e${k}@;return @pub@\(@hi@\(@sc@\),@a${k}@,@c${k}@\),null\}`;
        const next = (k) => String.raw`function @f${k}@\(@e${k}@\)\{let\{children:@c${k}@\}=@e${k}@;return @pub@\(@hi@\(@sc@\),@a${k}@,@c${k}@\),null\}`;
        const parts = [first(1), next(2), next(3), next(4), String.raw`[^]{0,400}?`, next(5), next(6), next(7), next(8),
          String.raw`function @pub@\(@we@,@wt@,@wn@\)\{let @wr@=\(0,@wm@\.c\)\(9\),`];
        return rx(parts.join(''));
      })(),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        const pairs = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => `[${g['f' + k]},${g['a' + k]}]`).join(',');
        return `;(function(a){var s=a.panelSlots||(a.panelSlots={});s.publish=${g.pub};${get('s', 'pairs', `[${pairs}]`)}})(${NS});${m}`;
      },
    },
    {
      // function v_o(e){let t=(0,b_o.c)(22),{children:n,className:r,contentFade:i,divider:a,desktopPlacement:o,inline:s,separator:c}=e,...
      //   (0,OJ.jsx)(Tz,{signal:jXt,value:p}) ... {signal:NXt,value:h} ... {signal:IXt,value:_} ... {signal:PXt,value:y} ... {signal:FXt,value:x}
      // function y_o(e){let t=(0,b_o.c)(2),{children:n}=e,r;return t[0]===n?r=t[1]:(r=(0,OJ.jsx)(Tz,{signal:MXt,value:n}),...)}   AppShell.Header / AppShell.PageBanner
      name: 'shellSignals', chunk: 'app-initial',
      re: rx(
        String.raw`function @hdr@\(@e@\)\{let @t@=\(0,@m@\.c\)\(22\),\{children:@n@,className:@cn@,contentFade:@cf@,divider:@dv@,desktopPlacement:@dp@,inline:@s@,separator:@sp@\}=@e@,`
        + String.raw`[^]{0,260}?\(0,@j@\.jsx\)\(@Tz@,\{signal:@sChildren@,value:@v1@\}\)`
        + String.raw`[^]{0,200}?\{signal:@sPlacement@,value:@v2@\}\)`
        + String.raw`[^]{0,200}?\{signal:@sFade@,value:@v3@\}\)`
        + String.raw`[^]{0,200}?\{signal:@sDivider@,value:@v4@\}\)`
        + String.raw`[^]{0,200}?\{signal:@sSeparator@,value:@v5@\}\)`
        + String.raw`[^]{0,900}?\}function @pb@\(@e2@\)\{let @t2@=\(0,@m@\.c\)\(2\),\{children:@n2@\}=@e2@,@r2@;return @t2@\[0\]===@n2@\?@r2@=@t2@\[1\]:\(@r2@=\(0,@j@\.jsx\)\(@Tz@,\{signal:@sBanner@,value:@n2@\}\),`),
      rep: (m, ...rest) => {
        const g = rest[rest.length - 1];
        return `;(function(a){var s=a.panelSlots||(a.panelSlots={});s.Signal=${g.Tz};`
          + get('s', 'header', `{component:${g.hdr},children:${g.sChildren},desktopPlacement:${g.sPlacement},contentFade:${g.sFade},divider:${g.sDivider},separator:${g.sSeparator}}`)
          + get('s', 'pageBanner', `{component:${g.pb},signal:${g.sBanner}}`) + `})(${NS});${m}`;
      },
    },
  ];


  /**
   * OPTIONAL, not an exposure: a page-hook seam in the style of the JSX and lazy seams (absent hook = identical behaviour; a throwing hook is swallowed).
   * It makes every run visible with its source and origin, including runs that an app handler consumes, which a stack observer cannot promise
   * (handlers are tried latest-first, so a handler mounted after the observer is asked first). Order-independent with `commandStack`.
   * Page side: `globalThis.__codexmodsRunHook = (id, source, event, origin) => {...}`; `source` is `command_menu`, `sidebar_trigger`, `host_run_command`, `keyboard_shortcut`, ...
   */
  const seams = [
    {
      name: 'commandObserve', chunk: 'app-initial',
      re: rx(String.raw`function @ibr@\(@e@,@t@,@n@,@r@\)\{(?<tail>let @i@=@map@\.get\(@e@\);for\(let @e2@ of\[\`normal\`,\`fallback\`\]\))`),
      rep: (_m, ...rest) => {
        const g = rest[rest.length - 1];
        return `function ${g.ibr}(${g.e},${g.t},${g.n},${g.r}){var __cmH=globalThis.__codexmodsRunHook;if(__cmH!==void 0)try{__cmH(${g.e},${g.n},${g.t},${g.r})}catch(__cmX){}${g.tail}`;
      },
    },
  ];

  return { edits, seams };
  })();
  APP_EDITS.push(...B5.edits);
  const B5_OBSERVE = B5.seams[0];
  const seamApp = (chunk, text) => {
    const counts = {};
    for (const e of APP_EDITS.filter((x) => x.chunk === chunk)) {
      const n = (text.match(e.re) || []).length;
      counts[e.name] = n;
      if (n === 1) text = text.replace(e.re, e.rep);
    }
    return { text, counts };
  };
  /** Page side of G-app: fixed operations on the exposed mechanics, with framework components built by the app's JSX factory. */
  /** Layouts WL0 experiments (page realm): the framework's exposures and a RouteScope node of a mounted binding. Plain data out. */
  const WL0_OPS = function wl0Ops(op, args) {
    const K = globalThis.__codexmods || {};
    const ex = K.exports || {};
    const recs = K.store && typeof K.store.mounted === 'function' ? K.store.mounted() : [];
    const nodeOf = (id) => (recs.find((r) => r && r.scopeNode && (!id || r.binding === id)) || {}).scopeNode || null;
    const node = nodeOf(args && args.binding) || nodeOf(null);
    const name = (n) => (n && n.type ? (typeof n.type === 'string' ? n.type : n.type.displayName || n.type.name || typeof n.type) : typeof n);
    const safe = (f) => { try { return f(); } catch (e) { return { error: String(e && e.message || e) }; } };
    switch (op) {
      case 'scopes': return { exposed: Object.keys(ex).sort(), bindings: [...new Set(recs.filter((r) => r && r.scopeNode).map((r) => r.binding))],
        node: node ? { keys: Object.keys(node).slice(0, 30), get: typeof node.get, set: typeof node.set, watch: typeof node.watch, value: node.value ? { routeKind: node.value.routeKind, pathname: node.value.pathname, routeTemplate: node.value.routeTemplate } : null } : null };
      case 'titlebar': {
        const S = ex.headerSlots; if (!S || !node) return { unavailable: !S ? 'headerSlots' : 'no scope node' };
        return Object.fromEntries(Object.keys(S).map((slot) => [slot, safe(() => { const st = S[slot]; const l = node.get(st.entries$) || [];
          return { storeKeys: Object.keys(st), entries: l.map((e) => ({ actionId: e.actionId, align: e.align, order: e.order, keys: Object.keys(e).sort(), node: name(e.node) })) }; })]));
      }
      case 'kinds': {
        const reg = ex.tabRegistry && ex.tabRegistry.registry; if (!reg) return { unavailable: 'tabRegistry' };
        return [...reg.entries()].map(([k, v]) => ({ kind: k, component: v.Component ? v.Component.displayName || v.Component.name || typeof v.Component : null, load: 'load' in v, dropDestinations: v.dropDestinations || null, allowFullWidth: v.allowFullWidth === undefined ? null : v.allowFullWidth, keys: Object.keys(v).sort() }));
      }
      case 'tabs': {
        const pc = ex.panelControllers; if (!pc || !node) return { unavailable: !pc ? 'panelControllers' : 'no scope node' };
        const reg = ex.tabRegistry && ex.tabRegistry.registry;
        return Object.fromEntries(['right', 'bottom'].map((side) => [side, safe(() => { const ctl = pc[side]; const tabs = node.get(ctl.tabs$) || []; const active = safe(() => node.get(ctl.activeTab$));
          const ids = (k) => safe(() => (ctl[k] ? node.get(ctl[k]) || [] : []).map((t) => (typeof t === 'string' ? t : t && (t.tabId || (t.tab && t.tab.tabId) || Object.keys(t).slice(0, 6).join(',')))));
          return { controllerKeys: Object.keys(ctl), active: active && active.tabId, visible: ids('visibleTabs$'), stored: ids('storedTabs$'), tabs: tabs.map((t) => ({ tabId: t.tabId, kind: t.kind || (t.tabType && t.tabType.kind), sameObject: reg ? t.tabType === reg.get(t.kind || (t.tabType && t.tabType.kind)) : null, title: typeof t.title === 'string' ? t.title.slice(0, 40) : typeof t.title })) }; })]));
      }
      case 'visible': {
        // each stored tab's kind asked directly (the route scope standing in for the panel's), and whether the kind's isVisible is the framework's
        const pc = ex.panelControllers; if (!pc || !node) return { unavailable: !pc ? 'panelControllers' : 'no scope node' };
        return Object.fromEntries(['right', 'bottom'].map((side) => [side, safe(() => { const ctl = pc[side];
          return (node.get(ctl.storedTabs$) || []).map((t) => { const k = t && t.tabType; const d = k ? Object.getOwnPropertyDescriptor(k, 'isVisible') : null;
            return { tabId: t && t.tabId, kind: k && k.kind, decorated: !!(d && d.get), record: safe(() => JSON.stringify(t, (key, v) => (key === 'tabType' || typeof v === 'function' ? undefined : v)).slice(0, 700)), answer: safe(() => (k && typeof k.isVisible === 'function' ? k.isVisible(node, t) : 'none')) }; }); })]));
      }
      case 'bottom': {
        // the bottom panel frame binding's mounts: their height motion values (and a set when asked: args.set px)
        return recs.filter((r) => r && r.binding === 'bottom.panel.frame').map((r) => safe(() => {
          const p = r.props || {};
          const read = () => ({ height: p.bottomPanelHeight && p.bottomPanelHeight.get(), clamped: p.clampedBottomPanelHeight && p.clampedBottomPanelHeight.get(), main: p.mainContentHeight && p.mainContentHeight.get(), visible: p.isVisible });
          const before = read();
          if (args && Number.isFinite(args.set)) p.bottomPanelHeight.set(args.set);
          return { conv: r.scopeNode && r.scopeNode.value ? r.scopeNode.value.conversationId : null, before, after: read(), keys: Object.keys(p).sort() };
        }));
      }
      case 'route': return { href: globalThis.location.href, initialRoute: new URL(globalThis.location.href).searchParams.get('initialRoute'), value: node && node.value ? { routeKind: node.value.routeKind, pathname: node.value.pathname, routeTemplate: node.value.routeTemplate, conversationId: node.value.conversationId || null } : null };
      case 'route-add': case 'route-remove': {
        const T = ex.routes; const R = ex.react; if (!Array.isArray(T) || !R) return { unavailable: !Array.isArray(T) ? 'routes' : 'react' };
        const walk = (l, f) => { for (const r of l) { if (f(r)) return r; if (Array.isArray(r.children)) { const x = walk(r.children, f); if (x) return x; } } return null; };
        const parent = walk(T, (r) => Array.isArray(r.children) && r.children.some((x) => x && x.path === '/codex-mobile'));
        if (!parent) return { unavailable: 'no route with a /codex-mobile child' };
        const at = parent.children.findIndex((x) => x && x.path === '/codexmods/page/:mod/:page');
        if (op === 'route-remove') { if (at >= 0) parent.children.splice(at, 1); return { removed: at >= 0, children: parent.children.length }; }
        if (at < 0) parent.children.push({ path: '/codexmods/page/:mod/:page', element: R.createElement('div', { id: 'cm-wl0-page', 'data-codexmods': 'wl0-page' }, 'WL0 page') });
        return { added: at < 0, children: parent.children.length, parentKeys: Object.keys(parent).sort(), handle: parent.handle ? typeof parent.handle : null };
      }
      // a pointer drag dispatched in the page (the window's trusted input does not reach a divider while it is in the background):
      // args { x, y, dx, dy, steps, hold } with hold true leaving the pointer down (a second call with { up: true } releases it)
      case 'drag': {
        const a = args || {}; const st = globalThis.__codexmodsQaDrag || (globalThis.__codexmodsQaDrag = {});
        const fire = (type, x, y, buttons) => { const t = st.target || document.elementFromPoint(x, y) || document.body; const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons };
          (type === 'pointerdown' ? t : t.ownerDocument || document).dispatchEvent(new globalThis.PointerEvent(type, o)); (type === 'pointerdown' ? t : document).dispatchEvent(new globalThis.MouseEvent(type.replace('pointer', 'mouse'), o)); return t; };
        if (a.up) { fire('pointerup', st.x, st.y, 0); st.target = null; return { up: true, at: { x: st.x, y: st.y } }; }
        st.target = null; st.x = Number(a.x); st.y = Number(a.y);
        const t = fire('pointerdown', st.x, st.y, 1); st.target = t;
        const steps = Math.max(1, Number(a.steps) || 10);
        for (let i = 1; i <= steps; i++) fire('pointermove', st.x + ((Number(a.dx) || 0) * i) / steps, st.y + ((Number(a.dy) || 0) * i) / steps, 1);
        st.x += Number(a.dx) || 0; st.y += Number(a.dy) || 0;
        if (!a.hold) { fire('pointerup', st.x, st.y, 0); st.target = null; }
        return { target: t ? (t.getAttribute('role') || t.tagName) + ' ' + String(t.className).slice(0, 60) : null, at: { x: st.x, y: st.y }, held: !!a.hold };
      }
      // the React components above an element (a porting aid: what a binding's address must match): args { selector, depth } ->
      // for each component fiber from the element up, its name and its props' keys (and whether it is wrapped by the framework)
      // layouts WL6: the layout's atoms in every mounted chat's scope, as they are now; `layoutWatch` logs each change with who may have made it
      case 'layout': {
        const X = K.exports || {}, ws = X.workspaceState, ls = X.layoutSource, r = X.responsive;
        const seen = new Map();
        for (const m of K.store.mounted()) if (m.scopeNode && m.scopeNode.value) seen.set(m.scopeNode, m);
        const read = (n, a) => { try { return a === undefined ? 'no-atom' : n.get(a); } catch (e) { return 'throws'; } };
        return [...seen.keys()].map((n) => ({ path: n.value.pathname, conv: n.value.conversationId ?? null, mode: read(n, ws?.mode), side: read(n, r?.sideOpen), tabs: read(n, ws?.tabsOpen), bottom: read(n, ws?.bottomOpen), restored: read(n, ws?.restored), ready: read(n, ws?.ready), counter: read(n, ls?.counter), source: read(n, ls?.source), memory: read(n, r?.remembered), sidebar: read(n, r?.sidebarOpen), auto: read(n, r?.autoCollapse) }));
      }
      case 'layoutWatch': {
        const X = K.exports || {}, ws = X.workspaceState, ls = X.layoutSource, r = X.responsive;
        const log = (globalThis.__cmLayoutLog ??= []);
        const now = () => Math.round(performance.now());
        const watched = (globalThis.__cmLayoutWatched ??= new Map());
        const sweep = () => {
          for (const m of K.store.mounted()) {
            const n = m.scopeNode;
            if (!n || !n.value || typeof n.watch !== 'function') continue;
            const key = n.value.conversationId ?? n.value.pathname;
            if (watched.has(key)) continue;
            watched.set(key, n);
            let last = '';
            log.push({ t: now(), at: String(key).slice(-12), first: m.binding });
            n.watch((g) => {
              const read = (a) => { try { return a === undefined ? 'no-atom' : g.get(a); } catch (e) { return 'throws'; } };
              const v = { mode: read(ws?.mode), side: read(r?.sideOpen), tabs: read(ws?.tabsOpen), bottom: read(ws?.bottomOpen), restored: read(ws?.restored) === key ? 'yes' : read(ws?.restored) == null ? null : 'other', ready: read(ws?.ready), counter: read(ls?.counter), source: read(ls?.source), memory: read(r?.remembered), sidebar: read(r?.sidebarOpen), auto: read(r?.autoCollapse) };
              const sig = JSON.stringify(v);
              if (sig !== last) { last = sig; log.push({ t: now(), at: String(key).slice(-12), ...v }); }
            });
          }
        };
        sweep();
        if (!globalThis.__cmLayoutInput) {
          globalThis.__cmLayoutInput = setInterval(sweep, 16);
          for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, (e) => { if (e.isTrusted) log.push({ t: now(), input: type, key: e.key, target: String(e.target?.getAttribute?.('aria-label') ?? e.target?.tagName ?? '').slice(0, 40) }); }, true);
          for (const [name, say] of [['command', (a) => ({ command: a[0], source: a[2] })], ['responsive', (a) => ({ resize: a[0]?.width })]]) {
            const was = K.store[name];
            if (typeof was === 'function') K.store[name] = function (...a) { log.push({ t: now(), ...say(a) }); return was.apply(this, a); };
          }
        }
        return { watching: watched.size, entries: log.length };
      }
      case 'layoutLog': { const log = globalThis.__cmLayoutLog ?? []; const out = log.slice(args?.from ?? 0); return { n: log.length, out }; }
      case 'fiber': {
        const a = args || {}; const el = document.querySelector(String(a.selector || 'body'));
        if (!el) return { found: false };
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let f = key ? el[key] : null; const out = [];
        while (f && out.length < (Number(a.depth) || 12)) {
          if (typeof f.type === 'function' || (f.type && typeof f.type === 'object')) {
            const t = f.type; const nm = typeof t === 'function' ? t.displayName || t.name : (t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || typeof t);
            out.push({ name: nm || '?', keys: f.memoizedProps && typeof f.memoizedProps === 'object' ? Object.keys(f.memoizedProps).sort() : [] });
          }
          f = f.return;
        }
        return out;
      }
      case 'mode': return { layout: [...document.querySelectorAll('[data-app-shell-workspace-layout]')].map((e) => e.getAttribute('data-app-shell-workspace-layout')),
        fullWidth: [...document.querySelectorAll('[data-app-shell-right-panel-full-width]')].map((e) => e.getAttribute('data-app-shell-right-panel-full-width')),
        rightPanel: (() => { const e = document.querySelector('aside[data-app-shell-focus-area="right-panel"]'); return e ? Math.round(e.getBoundingClientRect().width) : null; })(),
        rail: document.querySelectorAll('nav[data-app-navigation-rail]').length, navRoot: (() => { const e = document.querySelector('[data-sidebar-navigation-root]'); return e ? Math.round(e.getBoundingClientRect().width) : null; })() };
      default: return { unknown: op };
    }
  };

  const APP_OPS = function appOps(op) {
    const g = globalThis;
    const A = g.__codexmodsApp || {};
    const F = g.__codexmodsJsxFactory;
    const st = g.__codexmodsAppStats || (g.__codexmodsAppStats = { toastClicks: 0, modalCloses: 0 });
    const scopes = A.scopes || {};
    const route = scopes.RouteScope;
    const app = scopes.AppScope;
    if (!g.__codexmodsQaModal) {
      g.__codexmodsQaModal = (p) => F('div', { 'data-codexmods': 'g-app-modal', role: 'dialog', children: [F('span', { children: 'G-APP modal' }), F('button', { onClick: () => { st.modalCloses += 1; p.onClose && p.onClose(); }, children: 'Close' })] });
      g.__codexmodsQaTab = () => F('div', { 'data-codexmods': 'g-app-tab', children: 'G-APP panel tab' });
    }
    switch (op) {
      case 'state': return { exposed: Object.keys(A).sort(), scopes: Object.keys(scopes), routeKind: route && route.value ? route.value.routeKind || null : null, hasFactory: typeof F, stats: st };
      case 'toast': A.getToast().info('Codex Mods QA toast', { id: 'codexmods-qa-toast', description: 'G-app', primaryAction: { label: 'Run QA', onClick: () => { st.toastClicks += 1; } } }); return 'toast shown';
      case 'modal-open': A.openModal(app, g.__codexmodsQaModal, {}, { blocksOtherModals: false }); return { open: A.isModalOpen(app, g.__codexmodsQaModal) };
      // P11: a framework modal that blocks other modals while open.
      case 'modal-block': A.openModal(app, g.__codexmodsQaModal, {}, { blocksOtherModals: true }); return { open: A.isModalOpen(app, g.__codexmodsQaModal) };
      case 'modal-close': A.closeModal(app, g.__codexmodsQaModal); return { open: A.isModalOpen(app, g.__codexmodsQaModal) };
      case 'tab-open': {
        st.tabType = st.tabType || A.registerTabType('codexmods-qa', g.__codexmodsQaTab, { getId: () => 'codexmods-qa', isAvailable: () => true, getTitle: () => 'QA tab', dropDestinations: ['right'] });
        return { id: A.rightPanel.openTab(route, st.tabType, { id: 'codexmods-qa', props: {}, revealAndFocus: true }) };
      }
      case 'header-add': {
        const s = A.headerSlots.right;
        route.set(s.byId, 'codexmods-qa', { align: 'end', allowsThreadContentOverlap: false, desktopPlacement: 'titlebar', node: F('button', { 'data-codexmods': 'g-app-header', children: 'QA' }), order: 900 });
        route.set(s.ids$, (ids) => (ids.includes('codexmods-qa') ? ids : [...ids, 'codexmods-qa']));
        return 'header added';
      }
      case 'header-remove': {
        const s = A.headerSlots.right;
        route.set(s.byId, 'codexmods-qa', null);
        route.set(s.ids$, (ids) => ids.filter((x) => x !== 'codexmods-qa'));
        return 'header removed';
      }
      // G7: a framework handler on top of the app's command stack for `toggleSidebar` (it answers, so the app's own handler does not run).
      case 'cmd-override': {
        if (st.cmdOff) return 'already';
        st.cmdRuns = 0;
        st.cmdOff = A.commands.register('toggleSidebar', (source) => { st.cmdRuns += 1; st.cmdLast = source; return true; }, { isActive: () => true, priority: 'normal' });
        return 'registered';
      }
      case 'cmd-release': { if (st.cmdOff) { st.cmdOff(); st.cmdOff = null; } return { runs: st.cmdRuns, last: st.cmdLast }; }
      // G7: every command run (the batch-5 observe seam).
      case 'runs-on': st.runs = []; g.__codexmodsRunHook = (id, source) => { if (st.runs.length < 50) st.runs.push({ id, source }); }; return 'observing';
      case 'runs': return { runs: st.runs || [] };
      case 'runs-off': delete g.__codexmodsRunHook; return 'off';
      // G8: a global slash item through the app's AppScope slash atom.
      case 'slash-add': {
        st.slashRuns = st.slashRuns || 0;
        const item = { id: 'codexmods-qa', title: 'Codex Mods QA', description: 'QA slash item', requiresEmptyComposer: false, onSelect: () => { st.slashRuns += 1; } };
        app.set(A.slash.appAtom, (list) => [...(list || []).filter((x) => x.id !== item.id), item]);
        return 'added';
      }
      case 'slash-remove': app.set(A.slash.appAtom, (list) => (list || []).filter((x) => x.id !== 'codexmods-qa')); return { runs: st.slashRuns || 0 };
      // P10: a node in the right panel's tab list (the RightPanelTabListAfter slot), set from the route scope.
      case 'slot-set': case 'slot-clear': {
        const atom = A.panelSlots.pairs.find(([fn]) => A.AppShell.RightPanelTabListAfter.type === fn)?.[1];
        if (!atom) throw new Error('no atom for RightPanelTabListAfter');
        route.set(atom, op === 'slot-set' ? F('span', { 'data-codexmods': 'g-slot-after', children: 'QA slot' }) : null);
        return op;
      }
      // P12: the route table (the tree `useRoutes` reads on every render).
      case 'routes': {
        const walk = (rs, d) => rs.map((r) => ({ id: r.id, path: r.path ?? null, index: !!r.index, handle: r.handle ? Object.keys(r.handle) : null, children: d < 2 && r.children ? walk(r.children, d + 1) : (r.children ? r.children.length : 0) }));
        return walk(A.routes, 0);
      }
      // P10: the framework page mounts the app's shell parts: a header action, a header context-menu item, a page banner, a detail panel.
      case 'route-add': case 'route-remove': {
        if (!g.__codexmodsQaPage) {
          const S = A.AppShell;
          const has = (k) => (st.pageParts || ['action', 'menu', 'banner', 'detail']).includes(k);
          g.__codexmodsQaPage = () => F('div', { 'data-codexmods': 'g-route', children: [
            F('span', { children: 'Codex Mods QA page' }),
            has('action') && F(S.HeaderAction, { actionId: 'codexmods-qa-page', order: 900, align: 'end', slotPosition: 'right', children: F('button', { 'data-codexmods': 'g-page-action', children: 'QA page action' }) }),
            has('menu') && F(S.HeaderContextMenuItem, { id: 'codexmods-qa-menu', message: { id: 'codexmods.qa.pageMenu', defaultMessage: 'Codex Mods QA item' }, type: 'checkbox', checked: !!st.pageMenuChecked, onSelect: () => { st.pageMenuRuns = (st.pageMenuRuns || 0) + 1; st.pageMenuChecked = !st.pageMenuChecked; } }),
            has('banner') && F(S.PageBanner, { children: F('div', { 'data-codexmods': 'g-page-banner', children: 'QA page banner' }) }),
            has('detail') && F(S.DetailPanelOutlet, { isOpen: true, onClose: () => { st.detailCloses = (st.detailCloses || 0) + 1; }, children: F('div', { 'data-codexmods': 'g-page-detail', children: 'QA detail panel' }) }),
          ] });
        }

        const find = (rs) => { for (const r of rs) { if (r.children && r.children.some((c) => c.path === 'settings' || c.path === '/settings' || (c.path || '').startsWith('settings'))) return r.children; const x = r.children && find(r.children); if (x) return x; } return null; };
        const list = find(A.routes);
        if (!list) throw new Error('no route list holding settings');
        const at = list.findIndex((r) => r.id === 'codexmods-qa');
        if (at >= 0) list.splice(at, 1);
        if (op === 'route-add') list.unshift({ id: 'codexmods-qa', path: 'codexmods-qa', element: F(g.__codexmodsQaPage, {}), hasErrorBoundary: false });
        return { op, siblings: list.length };
      }
      case 'page-stats': return { menuRuns: st.pageMenuRuns || 0, checked: !!st.pageMenuChecked, detailCloses: st.detailCloses || 0 };
      // A13: a framework settings section as a static child of the `/settings` route (ahead of the app's `:section` param route).
      case 'settings-route-add': case 'settings-route-remove': {
        const find = (rs) => { for (const r of rs) { if (r.path === '/settings') return r; const x = r.children && find(r.children); if (x) return x; } return null; };
        const sr = find(A.routes);
        if (!sr) throw new Error('no /settings route');
        const at = sr.children.findIndex((r) => r.id === 'codexmods-qa-settings');
        if (at >= 0) sr.children.splice(at, 1);
        if (op === 'settings-route-add') sr.children.unshift({ id: 'codexmods-qa-settings', path: 'codexmods-qa', element: F('div', { 'data-codexmods': 'g-settings-page', children: [F('h2', { children: 'Codex Mods QA' }), F('p', { children: 'A framework settings section' })] }) });
        return { op, children: sr.children.map((r) => r.path ?? (r.index ? '(index)' : null)) };
      }
      case 'banner-off': { const o = A.banners.order; const i = o.findIndex((x) => x.id === 'codexmods-qa'); if (i >= 0) o.splice(i, 1); return { removed: i >= 0 }; }
      // P9: the right panel's tabs through the app's controller and the shared tab-type registry. `kind-*` ops take the kind after a colon.
      case 'tabs': {
        const P = A.rightPanel;
        const ids = route.get(P.tabIds$) || [];
        const visible = (route.get(P.visibleTabs$) || []).map((t) => (t && typeof t === 'object' ? t.tabId ?? t.id ?? Object.keys(t).slice(0, 6).join(',') : t));
        const active = route.get(P.activeTab$);
        return { route: route.value ? route.value.routeKind || null : null, active: active ? active.tabId : null, visible, tabs: ids.map((id) => { const r = route.get(P.tabById$, id) || {}; return { id, kind: r.tabType ? r.tabType.kind : null, title: typeof r.title === 'string' ? r.title : null, tooltip: r.tooltip ?? null, highlighted: !!r.isHighlighted, status: r.statusContent != null }; }) };
      }
      case 'tab-decorate': case 'tab-undecorate': {
        const P = A.rightPanel;
        const id = (route.get(P.tabIds$) || []).find((x) => { const r = route.get(P.tabById$, x); return r && r.tabType && r.tabType.kind === 'review'; });
        if (!id) throw new Error('no review tab open');
        P.updateTab(route, id, op === 'tab-decorate' ? { statusContent: F('span', { 'data-codexmods': 'g-tab-status', children: '◆' }), tooltip: 'QA tooltip', isHighlighted: true } : { statusContent: null, tooltip: null, isHighlighted: false });
        return { id };
      }
      default: break;
    }
    const at = op.indexOf(':');
    const verb = at < 0 ? op : op.slice(0, at);
    const kind = at < 0 ? '' : op.slice(at + 1);
    const reg = A.tabRegistry;
    st.savedKinds = st.savedKinds || {};
    switch (verb) {
      case 'kinds': return [...reg.entries()].map(([k, v]) => ({ kind: k, component: v.Component ? v.Component.displayName || v.Component.name || typeof v.Component : null, keys: Object.keys(v).length, isVisible: typeof v.isVisible, isAvailable: typeof v.isAvailable }));
      // The tab-type object is shared: an open tab's record holds the same object, so in-place changes reach open tabs; a new registry
      // entry (`kind-overwrite`) reaches only tabs created from the registry afterwards.
      case 'kind-hide': case 'kind-body': case 'kind-overwrite': {
        const cur = reg.get(kind);
        if (!cur) throw new Error(`no tab kind ${kind}`);
        const QaBody = (p) => F('div', { 'data-codexmods': 'g-tab-overwrite', children: `QA body for ${kind} (${Object.keys(p).sort().join(',')})` });
        if (!st.savedKinds[kind]) st.savedKinds[kind] = { entry: cur, isVisible: cur.isVisible, hadVisible: 'isVisible' in cur, Component: cur.Component };
        if (verb === 'kind-hide') cur.isVisible = () => false;
        else if (verb === 'kind-body') cur.Component = QaBody;
        else { const { Component: _c, kind: _k, ...opts } = cur; A.registerTabType(kind, QaBody, opts); }
        return { kind, sameEntry: reg.get(kind) === cur };
      }
      case 'kind-restore': {
        const s0 = st.savedKinds[kind];
        if (s0) { const e = s0.entry; if (s0.hadVisible) e.isVisible = s0.isVisible; else delete e.isVisible; e.Component = s0.Component; reg.set(kind, e); delete st.savedKinds[kind]; }
        return { kind, restored: !!s0 };
      }
      // P9: a tab kind with a durable route, so the app persists the tab with the thread's panel and restores it through `restore`.
      case 'tab-durable': case 'tab-durable-open': {
        const K = 'codexmods-qa-durable';
        const route0 = { kind: K, params: { qa: 1 }, payloadVersion: 1 };
        st.durableRestores = st.durableRestores || 0;
        if (!reg.get(K) || reg.get(K) !== st.durableType) {
          st.durableType = A.registerTabType(K, () => F('div', { 'data-codexmods': 'g-app-tab-durable', children: 'G-APP durable tab' }), {
            getId: () => K, isAvailable: () => true, getTitle: () => 'QA durable', dropDestinations: ['right'],
            durableRoute: { version: 1, serialize: (_s, _p, prev) => prev ?? route0, restore: (t) => { st.durableRestores += 1; A.rightPanel.openTab(t.scope, st.durableType, { id: t.descriptor.tabId, props: {}, revealAndFocus: false, durableRoute: route0 }); return true; } },
          });
        }
        if (verb === 'tab-durable-open') A.rightPanel.openTab(route, st.durableType, { id: K, props: {}, revealAndFocus: true, durableRoute: route0 });
        return { registered: true, restores: st.durableRestores };
      }
      case 'page-parts': st.pageParts = kind ? kind.split(',') : []; return { parts: st.pageParts };
      // P21: every tab open (files included) through the panel controllers' shared `openTab`, observed and passed on.
      case 'open-wrap': case 'open-unwrap': {
        for (const P of [A.rightPanel, A.bottomPanel]) {
          if (verb === 'open-wrap' && !P.__cmOrig) { P.__cmOrig = P.openTab; P.openTab = function (scope, type, opts) { (st.opens || (st.opens = [])).push({ kind: type && type.kind, id: opts && (opts.id || opts.tabId) || null, panel: P === A.rightPanel ? 'right' : 'bottom' }); return P.__cmOrig.apply(this, arguments); }; }
          if (verb === 'open-unwrap' && P.__cmOrig) { P.openTab = P.__cmOrig; delete P.__cmOrig; }
        }
        const opens = st.opens || [];
        if (verb === 'open-unwrap') st.opens = [];
        return { opens: opens.slice(-10) };
      }
      // P14: a synthetic composition in the composer's editor; `ime-check` reports whether the editor's node survived and how many
      // elements the JSX factory created since `ime-start`.
      case 'ime-start': case 'ime-check': case 'ime-end': {
        const el = document.querySelector('.ProseMirror');
        const calls = (g.__codexmodsJsxStats || {}).calls || 0;
        if (verb === 'ime-start') {
          st.imeEl = el; st.imeCalls = calls;
          if (el) { el.focus(); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' })); }
        }
        if (verb === 'ime-end' && el) el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }));
        return { found: !!el, same: el === st.imeEl, connected: !!(st.imeEl && st.imeEl.isConnected), callsSinceStart: calls - (st.imeCalls || 0), focused: document.activeElement === el };
      }
      case 'tab-close': { const id = kind || 'codexmods-qa'; A.rightPanel.closeTab(route, id, { recordCloseUndo: false }); return { id, open: (route.get(A.rightPanel.tabIds$) || []).includes(id) }; }
      default: throw new Error(`unknown app op ${op}`);
    }
  };

  // ---- the lazy seam (G-lazy)
  const LAZY_RE = /([$\w]+)=function\(([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=Promise\.resolve\(\);if\(\3&&\3\.length>0\)\{let \2=document\.getElementsByTagName\(`link`\)/g;
  const seamLazy = (text) => {
    const n = (text.match(LAZY_RE) || []).length;
    if (n !== 1) return { text, n };
    return { n, text: text.replace(LAZY_RE, (m, _name, imp) => m.replace('{let ', `{var __cmW=globalThis.__codexmodsLazy;if(__cmW!==void 0){let __cmI=${imp};${imp}=()=>Promise.resolve(__cmI()).then(function(__cmM){try{return __cmW(__cmI,__cmM)}catch(__cmX){globalThis.__codexmodsLazyErrors=(globalThis.__codexmodsLazyErrors|0)+1;return __cmM}})}let `)) };
  };
  /** Page side of G-lazy: `census` records (chunk, exports) per lazy load; `wrap-command-menu` wraps the palette's dialog export. */
  const LAZY_PLANS = function lazyPlans(plan) {
    const g = globalThis;
    const st = g.__codexmodsLazyStats || (g.__codexmodsLazyStats = { plan: null, loads: [], wrapped: 0 });
    const chunkOf = (importer) => ((String(importer).match(/import\(`\.\/([\w.-]+?)-[0-9a-f]{8,}\.js`\)/) || [])[1] || null);
    const plans = {
      census: (importer, mod) => { if (st.loads.length < 200) st.loads.push({ chunk: chunkOf(importer), exports: mod && typeof mod === 'object' ? Object.keys(mod) : [] }); return mod; },
      'wrap-command-menu': (importer, mod) => {
        const chunk = chunkOf(importer);
        if (st.loads.length < 200) st.loads.push({ chunk, exports: mod && typeof mod === 'object' ? Object.keys(mod) : [] });
        if (chunk !== 'command-menu-dialog' || !mod || typeof mod.CommandMenuDialog !== 'function') return mod;
        const Orig = mod.CommandMenuDialog;
        const F = g.__codexmodsJsxFactory;
        st.wrapped += 1;
        const Wrapped = (props) => F('div', { 'data-codexmods': 'g-lazy', style: { display: 'contents' }, children: [F('span', { 'data-codexmods': 'g-lazy-marker', hidden: true, children: 'G-LAZY wrapped CommandMenuDialog' }), F(Orig, props)] });
        return { ...mod, CommandMenuDialog: Wrapped };
      },
      // P11: the delete-thread confirmation, wrapped; the wrapper records the props the app opens it with and passes them through.
      'wrap-delete-dialog': (importer, mod) => {
        const chunk = chunkOf(importer);
        if (st.loads.length < 200) st.loads.push({ chunk, exports: mod && typeof mod === 'object' ? Object.keys(mod) : [] });
        if (chunk !== 'delete-thread-dialog' || !mod || typeof mod.DeleteThreadDialog !== 'function') return mod;
        const Orig = mod.DeleteThreadDialog;
        const F = g.__codexmodsJsxFactory;
        st.wrapped += 1;
        const Wrapped = (props) => {
          const f = props.returnFocusTo;
          st.lastProps = { keys: Object.keys(props).sort(), returnFocusTo: f && f.tagName ? { tag: f.tagName, label: f.getAttribute && f.getAttribute('aria-label'), text: (f.textContent || '').trim().slice(0, 60) } : null };
          return F('div', { 'data-codexmods': 'g-lazy', style: { display: 'contents' }, children: [F('span', { 'data-codexmods': 'g-lazy-delete', hidden: true, children: 'G-LAZY wrapped DeleteThreadDialog' }), F(Orig, props)] });
        };
        return { ...mod, DeleteThreadDialog: Wrapped };
      },
    };
    if (!plans[plan]) throw new Error(`unknown plan ${plan}`);
    g.__codexmodsLazy = plans[plan];
    st.plan = plan;
    return `installed ${plan}`;
  };

  // ---- descriptor taps (G-tap)
  const TABLE_RE = /([$\w]+)=\[\{id:`newTask`,/g;
  const MESSAGES_RE = /([$\w]+)=\{\.\.\.([$\w]+),"codex\.command\.importExternalAgent":/g;
  const HANDLERS_RE = /([$\w]+)=new Map\(\[\[`newTask`,/g;
  const seamTap = (text) => {
    const table = (text.match(TABLE_RE) || []).length;
    const handlers = (text.match(HANDLERS_RE) || []).length;
    if (table !== 1 || handlers !== 1) return { text, table, handlers };
    return {
      table, handlers,
      text: text.replace(TABLE_RE, (_m, name) => `${name}=[...(globalThis.__codexmodsTapCommands||[]),{id:\`newTask\`,`)
        .replace(HANDLERS_RE, (_m, name) => `${name}=new Map([...(globalThis.__codexmodsTapHandlers||[]),[\`newTask\`,`),
    };
  };
  /** Page side of G-tap: one QA command in the palette's panels group, and its default handler, which counts runs. */
  const TAP_BOOT = function tapBoot() {
    const g = globalThis;
    g.__codexmodsTapRuns = 0;
    g.__codexmodsTapCommands = [{ id: 'codexmodsQaTap', titleIntlId: 'codexmods.qa.tap', descriptionIntlId: 'codexmods.qa.tapDescription',
      commandMenuGroupKey: 'panels', commandMenu: true, electron: { menuTitle: 'Codex Mods QA tap' } }];
    g.__codexmodsTapMessages = { 'codexmods.qa.tap': { id: 'codexmods.qa.tap', defaultMessage: 'Codex Mods QA tap', description: 'QA command added by a tap' } };
    g.__codexmodsTapHandlers = [['codexmodsQaTap', () => { g.__codexmodsTapRuns += 1; return true; }]];
    // A copy built with the production tap seam (C5) reads the kernel's arrays instead: the same entries go there too.
    const K = g.__codexmods;
    if (K && K.taps) {
      K.taps.commands = [...(Array.isArray(K.taps.commands) ? K.taps.commands : []), ...g.__codexmodsTapCommands];
      K.taps.handlers = [...(Array.isArray(K.taps.handlers) ? K.taps.handlers : []), ...g.__codexmodsTapHandlers];
      K.taps.messages = { ...(K.taps.messages && typeof K.taps.messages === 'object' ? K.taps.messages : {}), ...g.__codexmodsTapMessages };
    }
  };
  if (electron && electron.protocol) {
    const handle = electron.protocol.handle.bind(electron.protocol);
    electron.protocol.handle = (scheme, fn) => {
      if (scheme !== 'app') return handle(scheme, fn);
      log({ ev: 'jsx.protocol', scheme });
      return handle(scheme, async (req) => {
        const res = await fn(req);
        let pathname = '';
        try { pathname = new URL(req.url).pathname; } catch { /* keep empty */ }
        if (/\/assets\/command-messages-[\w-]+\.js$/.test(pathname) && res && res.ok) {
          const body = await res.text();
          const n = (body.match(MESSAGES_RE) || []).length;
          log({ ev: 'tap.edit', file: pathname.split('/').pop(), messages: n });
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          const text = n === 1 ? body.replace(MESSAGES_RE, (_m, name, base) => `${name}={...(globalThis.__codexmodsTapMessages||{}),...${base},"codex.command.importExternalAgent":`) : body;
          return new Response(text, { status: res.status, statusText: res.statusText, headers });
        }
        if (/\/assets\/app-primary-[\w-]+\.js$/.test(pathname) && res && res.ok) {
          const exposed = seamApp('app-primary', await res.text());
          log({ ev: 'app.edit', file: pathname.split('/').pop(), counts: exposed.counts });
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          return new Response(exposed.text, { status: res.status, statusText: res.statusText, headers });
        }
        if (/\/assets\/app-initial-[\w-]+\.js$/.test(pathname) && res && res.ok) {
          // The command-observe seam (batch 5) calls `globalThis.__codexmodsRunHook` on every command run, when the page sets it.
          const observed = (await res.text()).replace(B5_OBSERVE.re, B5_OBSERVE.rep);
          const exposed = seamApp('app-initial', observed);
          log({ ev: 'app.edit', file: pathname.split('/').pop(), counts: exposed.counts });
          const tapped = seamTap(exposed.text);
          log({ ev: 'tap.edit', file: pathname.split('/').pop(), table: tapped.table, handlers: tapped.handlers });
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          return new Response(tapped.text, { status: res.status, statusText: res.statusText, headers });
        }
        if (!/\/assets\/app-shared-[\w-]+\.js$/.test(pathname) || !res || !res.ok) return res;
        const exposed = seamApp('app-shared', await res.text());
        log({ ev: 'app.edit', file: pathname.split('/').pop(), counts: exposed.counts });
        const lazy = seamLazy(exposed.text);
        log({ ev: 'lazy.edit', file: pathname.split('/').pop(), matches: lazy.n });
        const edited = seamJsx(lazy.text);
        log({ ev: 'jsx.edit', file: pathname.split('/').pop(), matches: edited.n });
        // The boot plan (page localStorage, set by `jsxBoot`) is installed at the top of the chunk, before the app's first render:
        // decisions made later miss memoized elements. The chunk text itself never changes, so a cached copy behaves the same.
        const boot = `try{var __cmBoot=localStorage.getItem('codexmods.jsxBoot');if(__cmBoot)(${JSX_PLANS.toString()})(__cmBoot)}catch(__cmErr){}`
          + `try{if(localStorage.getItem('codexmods.tap')==='1')(${TAP_BOOT.toString()})()}catch(__cmErr){}`
          + `try{var __cmLazy=localStorage.getItem('codexmods.lazyBoot');if(__cmLazy)(${LAZY_PLANS.toString()})(__cmLazy)}catch(__cmErr){}`;
        // A copy built with the production JSX seam (C5, adapters/tools/seams.mjs) no longer has the stock factory text: the probe's
        // plans then layer over the kernel's hook instead, seeing each element first with the kernel's own dispatch as their factory.
        const production = edited.n === 0 && edited.text.includes('globalThis.__codexmods?.jsx');
        const layer = `(function(){var K=globalThis.__codexmods;if(K&&!K.__qaLazy){K.__qaLazy=true;var kl=K.lazyHook;K.lazyHook=function(i,m){var h=globalThis.__codexmodsLazy;var r=h?h(i,m):m;return kl?kl(i,r):r}}})();`
          + `(function(){var K=globalThis.__codexmods;if(!K||typeof K.jsx!=='function'||K.__qaLayered)return;var kj=K.jsx;K.__qaLayered=true;`
          + `K.jsx=function(f,t,p,k){globalThis.__codexmodsJsxFactory=f;var h=globalThis.__codexmodsJsx;var d=function(a,b,c){var r=kj(f,a,b,c);return r==null?f(a,b,c):r};`
          + `if(h===void 0)return d(t,p,k);try{return h(d,t,p,k)}catch(x){globalThis.__codexmodsJsxErrors=(globalThis.__codexmodsJsxErrors|0)+1;return d(t,p,k)}}})();`;
        log({ ev: 'jsx.layer', file: pathname.split('/').pop(), production });
        const text = edited.n === 1 ? `${boot}\n${edited.text}` : production ? `${layer}\n${boot}\n${edited.text}` : edited.text;
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(text, { status: res.status, statusText: res.statusText, headers });
      });
    };
  }
  /** Renderer plans for the JSX hook, run in the page. `item` and `extraIconBadges` are the scouted props of the transcript item and the sidebar row. */
  const JSX_PLANS = function jsxPlans(plan) {
    const g = globalThis;
    const st = g.__codexmodsJsxStats || (g.__codexmodsJsxStats = { plan: null, calls: 0, hits: {}, sigs: {} });
    const hit = (k) => { st.hits[k] = (st.hits[k] || 0) + 1; };
    const WATCH = ['item', 'extraIconBadges', 'conversationId', 'turnId', 'pendingRequest'];
    const plans = {
      passthrough: (orig, t, p, k) => { st.calls++; return orig(t, p, k); },
      census: (orig, t, p, k) => {
        st.calls++;
        if (p && typeof t !== 'string') {
          const keys = Object.keys(p);
          if (keys.some((x) => WATCH.includes(x))) {
            const sig = keys.sort().join(',');
            if (st.sigs[sig] !== undefined || Object.keys(st.sigs).length < 300) st.sigs[sig] = (st.sigs[sig] || 0) + 1;
          }
        }
        return orig(t, p, k);
      },
      decorate: (orig, t, p, k) => {
        st.calls++;
        if (p && typeof t !== 'string' && 'extraIconBadges' in p) {
          hit('row');
          const badge = orig('span', { 'data-codexmods': 'g-jsx', children: '◆' });
          const prefix = orig('span', { 'data-codexmods': 'g-jsx-prefix', children: '◆ ' });
          return orig(t, { ...p, titlePrefix: p.titlePrefix ?? prefix, extraIconBadges: [...(Array.isArray(p.extraIconBadges) ? p.extraIconBadges : []), badge] }, k);
        }
        return orig(t, p, k);
      },
      replace: (orig, t, p, k) => {
        st.calls++;
        const it = p && typeof t !== 'string' ? p.item : undefined;
        if (it && typeof it === 'object' && typeof it.type === 'string') hit(`type:${it.type}`);
        if (it && typeof it === 'object' && it.type === 'exec') { hit('exec'); return orig('div', { 'data-codexmods': 'g-jsx', children: 'G-JSX replaced this step' }, k); }
        return orig(t, p, k);
      },
      // Props by name (list in page localStorage `codexmods.jsxWatch`): per prop, the signature, the value's type and keys, and the
      // latest props object (kept in `__codexmodsJsxCaptured[prop]` for reading).
      watch: (orig, t, p, k) => {
        st.calls++;
        if (p && typeof t !== 'string') {
          let names = g.__codexmodsJsxWatchNames;
          if (!names) { try { names = JSON.parse(localStorage.getItem('codexmods.jsxWatch') || '[]'); } catch { names = []; } g.__codexmodsJsxWatchNames = names; }
          for (const name of names) {
            if (!(name in p)) continue;
            const v = p[name];
            const w = st.sigs[name] || (st.sigs[name] = { count: 0, signature: Object.keys(p).sort().join(',').slice(0, 600), type: null, keys: null });
            w.count += 1;
            w.type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
            if (v && typeof v === 'object' && !Array.isArray(v)) w.keys = Object.keys(v).slice(0, 40);
            (g.__codexmodsJsxCaptured || (g.__codexmodsJsxCaptured = {}))[name] = p;
          }
        }
        return orig(t, p, k);
      },
      // P2: a marker after each assistant message (by the renderer's item type), re-applied on every render.
      'decorate-message': (orig, t, p, k) => {
        st.calls++;
        const it = p && typeof t !== 'string' ? p.item : undefined;
        if (it && typeof it === 'object' && it.type === 'assistant-message') {
          hit('message');
          return orig('div', { 'data-codexmods': 'g-msg-wrap', style: { display: 'contents' }, children: [orig(t, p, k), orig('span', { 'data-codexmods': 'g-msg', 'data-codexmods-id': String(it.id || ''), hidden: true, children: String(it.id || '') })] });
        }
        return orig(t, p, k);
      },
      // P12: a framework candidate in the composer banner list (the app's `banners.List`, matched by identity), first in the priority order.
      banner: (orig, t, p, k) => {
        st.calls++;
        const B = (g.__codexmodsApp || {}).banners;
        if (B && t === B.List && p && Array.isArray(p.candidates)) {
          hit(`banner:${p.area}`);
          if (!B.order.some((x) => x.id === 'codexmods-qa')) B.order.unshift({ id: 'codexmods-qa', areas: ['home', 'task', 'chat', 'work'] });
          const node = orig('div', { 'data-codexmods': 'g-banner', children: `Codex Mods QA banner (${p.area})` });
          return orig(t, { ...p, candidates: [...p.candidates, B.candidate('codexmods-qa', node)] }, k);
        }
        return orig(t, p, k);
      },
      // P1: a stable component in every sidebar row's title prefix from the first render; it reads a framework store with the app's React, so
      // turning the store on or off (`live-on`, `live-off`) re-renders only the badges, through the store.
      'decorate-live': (orig, t, p, k) => {
        st.calls++;
        const live = g.__codexmodsLive || (g.__codexmodsLive = { on: false, subs: new Set() });
        if (!g.__codexmodsLiveBadge) {
          g.__codexmodsLiveBadge = function CodexmodsLiveBadge() {
            const R = (g.__codexmodsApp || {}).React;
            const on = R ? R.useSyncExternalStore((cb) => { live.subs.add(cb); return () => live.subs.delete(cb); }, () => live.on) : live.on;
            st.liveRenders = (st.liveRenders || 0) + 1;
            return on ? orig('span', { 'data-codexmods': 'g-jsx-live', children: '◆' }) : null;
          };
        }
        if (p && typeof t !== 'string' && 'extraIconBadges' in p) {
          hit('row');
          return orig(t, { ...p, titlePrefix: orig(g.__codexmodsLiveBadge, {}) }, k);
        }
        // P14: the same live component beside the composer (once, on the component that holds the composer controller).
        if (p && typeof t !== 'string' && 'aboveComposerContent' in p && 'composerController' in p) {
          hit('composer');
          const Live = g.__codexmodsLiveBadge;
          if (Live) return orig(t, { ...p, aboveComposerContent: orig('span', { style: { display: 'contents' }, children: [p.aboveComposerContent ?? null, orig(Live, {})] }) }, k);
        }
        return orig(t, p, k);
      },
      // P1, P15, P18: rule-driven prop injection on elements that carry a prop (rules from `jsxInject`): `set` replaces the prop's value
      // with a marker, `wrap` keeps the value and adds a marker beside it, `null` returns no element, `empty` an element whose component
      // renders nothing, `replace` a marker instead of the element, `append` adds a marker to an array prop, `items` adds a menu item to a `getItems` builder. With `text`, only when one of its string props contains it.
      inject: (orig, t, p, k) => {
        st.calls++;
        if (!p) return orig(t, p, k);
        let rules = g.__codexmodsInjectRules;
        if (!rules) { try { rules = JSON.parse(localStorage.getItem('codexmods.jsxInject') || '[]'); } catch { rules = []; } g.__codexmodsInjectRules = rules; }
        let q = p;
        for (const r of rules) {
          if (!(r.prop in q)) continue;
          if (r.text && !Object.values(q).some((v) => typeof v === 'string' && v.includes(r.text))) continue;
          hit(`${r.mode}:${r.prop}`);
          if (r.mode === 'null') return null;
          // `after`: when the element's `label` is a message whose id contains `labelId`, a second element of the same component follows it,
          // with the framework's label, description and control (P22: a settings row; also nav items).
          if (r.mode === 'after') {
            const lid = q.label && q.label.props && q.label.props.id;
            const byAttr = r.attr && q[r.attr[0]] === r.attr[1];
            if (!byAttr && (!r.labelId || typeof lid !== 'string' || !lid.includes(r.labelId))) continue;
            const R = (g.__codexmodsApp || {}).React;
            const go = () => { const B = (g.__codexmodsApp || {}).Bus; if (B) B.getInstance().dispatchHostMessage({ type: 'navigate-to-route', path: r.path || '/' }); };
            const extra = r.nav
              ? orig(t, { ...q, label: 'Codex Mods QA', 'aria-label': 'Codex Mods QA', 'data-settings-panel-slug': 'codexmods-qa', 'data-codexmods': 'g-inj-nav', isActive: () => false, onClick: go }, `${k}-codexmods`)
              : orig(t, { ...q, label: 'Codex Mods QA row', description: 'Inserted after ' + lid, control: orig('span', { 'data-codexmods': 'g-inj-row', children: 'QA' }) }, `${k}-codexmods`);
            return R ? orig(R.Fragment, { children: [orig(t, q, k), extra] }) : orig('span', { style: { display: 'contents' }, children: [orig(t, q, k), extra] });
          }
          if (r.mode === 'replace') return orig('span', { 'data-codexmods': `g-inj-replace`, children: `QA replaced ${r.text || r.prop}` }, k);
          if (r.mode === 'empty') { const Empty = g.__codexmodsEmpty || (g.__codexmodsEmpty = function CodexmodsEmpty() { return null; }); return orig(Empty, q, k); }
          const marker = orig('span', { 'data-codexmods': `g-inj-${r.prop}`, children: `QA ${r.prop}` });
          // `items`: wraps a `getItems` prop (an action menu's item builder) and appends one framework item to what it returns.
          // P8 subject: a capture-phase listener notes the sidebar row (its `data-app-action-sidebar-thread-id`) under the pointer or the
          // context-menu event; the item takes the subject current when the menu builds its items and records it when chosen.
          if (r.mode === 'items' && typeof q.getItems === 'function') {
            if (!g.__codexmodsSubjectWatch && typeof document !== 'undefined') {
              g.__codexmodsSubjectWatch = true;
              const note = (e) => { const el = e.target && e.target.closest ? e.target.closest('[data-app-action-sidebar-thread-id]') : null; g.__codexmodsMenuSubject = el ? el.getAttribute('data-app-action-sidebar-thread-id') : null; };
              document.addEventListener('contextmenu', note, true);
              document.addEventListener('pointerdown', note, true);
            }
            const base = q.getItems;
            const add = (l) => {
              if (!Array.isArray(l)) return l;
              const subject = g.__codexmodsMenuSubject ?? null;
              (st.menuBuilt || (st.menuBuilt = [])).push(subject);
              return [...l, { id: 'codexmods-qa-item', message: { id: 'codexmods.qa.menuItem', defaultMessage: 'Codex Mods QA (renderer item)' }, onSelect: () => { st.itemRuns = (st.itemRuns || 0) + 1; (st.itemSubjects || (st.itemSubjects = [])).push(subject); } }];
            };
            q = { ...q, getItems: (...a) => { const v = base(...a); return v && typeof v.then === 'function' ? v.then(add) : add(v); } };
            continue;
          }
          if (r.mode === 'append') { q = { ...q, [r.prop]: [...(Array.isArray(q[r.prop]) ? q[r.prop] : []), orig('div', { 'data-codexmods': `g-inj-${r.prop}`, children: `QA ${r.prop}` }, 'codexmods-qa')] }; continue; }
          q = { ...q, [r.prop]: r.mode === 'wrap' ? orig('span', { style: { display: 'contents' }, children: [q[r.prop] ?? null, marker] }) : marker };
        }
        return orig(t, q, k);
      },
      throw: (orig, t, p, k) => { st.calls++; if (p && typeof t !== 'string' && p.item) { hit('throw'); throw new Error('g-jsx throw plan'); } return orig(t, p, k); },
    };
    if (plan === 'live-on' || plan === 'live-off') { const live = g.__codexmodsLive || (g.__codexmodsLive = { on: false, subs: new Set() }); live.on = plan === 'live-on'; for (const cb of [...live.subs]) cb(); return { on: live.on, subscribers: live.subs.size, renders: st.liveRenders || 0 }; }
    if (plan === 'off') { delete g.__codexmodsJsx; st.plan = null; return 'off'; }
    if (plan === 'stats') return { ...st, errors: g.__codexmodsJsxErrors | 0, installed: typeof g.__codexmodsJsx };
    if (plan === 'reset') { g.__codexmodsJsxStats = { plan: st.plan, calls: 0, hits: {}, sigs: {} }; g.__codexmodsJsxErrors = 0; return 'reset'; }
    if (!plans[plan]) throw new Error(`unknown plan ${plan}`);
    g.__codexmodsJsx = plans[plan];
    st.plan = plan;
    return `installed ${plan}`;
  };

  // ---- Electron wrappers (G-el)
  const el = { menus: 0, lastMenu: null, appendMenu: false, badges: [], badgeOverride: null, notifications: [], suppress: false, windows: [] };
  // Each wrapper is installed on its own and logs its failure, so one Electron difference never stops the app.
  const elStep = (name, fn) => { try { fn(); log({ ev: 'el.installed', name }); } catch (e) { log({ ev: 'el.error', name, error: String(e && e.message || e) }); } };
  if (electron && electron.Menu && electron.app) {
    const { Menu, app } = electron;
    const labels = (menu) => (menu ? menu.items.map((i) => i.label) : null);
    elStep('menu', () => {
      const setMenu = Menu.setApplicationMenu.bind(Menu);
      Menu.setApplicationMenu = (menu) => {
        el.menus += 1;
        if (menu && el.appendMenu) menu.append(new electron.MenuItem({ label: 'Codex Mods QA', submenu: [{ label: 'G-el menu item', click: () => log({ ev: 'el.menu.click' }) }] }));
        el.lastMenu = labels(menu);
        log({ ev: 'el.menu', items: el.lastMenu });
        return setMenu(menu);
      };
    });
    elStep('dock', () => {
      if (!app.dock || typeof app.dock.setBadge !== 'function') throw new Error('no app.dock.setBadge');
      const setBadge = app.dock.setBadge.bind(app.dock);
      app.dock.setBadge = (text) => {
        el.badges.push(String(text));
        if (el.badges.length > 50) el.badges.shift();
        log({ ev: 'el.badge', text: String(text), override: el.badgeOverride });
        return setBadge(el.badgeOverride ?? text);
      };
    });
    elStep('badge-count', () => {
      const setCount = app.setBadgeCount.bind(app);
      app.setBadgeCount = (count) => {
        el.badges.push(`count:${count}`);
        if (el.badges.length > 50) el.badges.shift();
        log({ ev: 'el.badge-count', count, override: el.badgeOverride });
        return setCount(el.badgeOverride == null ? count : Number(el.badgeOverride));
      };
    });
    elStep('notification', () => {
      const Orig = electron.Notification;
      const show = Orig.prototype.show;
      // Observe through the prototype: the constructor stays the app's own, so construction never differs.
      Orig.prototype.show = function observedShow(...args) {
        const rec = { title: this.title, body: String(this.body || '').slice(0, 120), suppressed: el.suppress, at: Date.now() };
        el.notifications.push(rec);
        if (el.notifications.length > 50) el.notifications.shift();
        log({ ev: 'el.notification', ...rec });
        if (el.suppress) return undefined;
        return show.apply(this, args);
      };
    });
    elStep('windows', () => {
      app.on('browser-window-created', (_e, win) => {
        const rec = { id: win.id, at: Date.now() };
        el.windows.push(rec);
        if (el.windows.length > 50) el.windows.shift();
        win.webContents.once('did-finish-load', () => { rec.url = win.webContents.getURL().split('?')[0]; rec.title = win.getTitle(); });
      });
    });
  }

  const ops = {
    elStats: () => ({ menus: el.menus, lastMenu: el.lastMenu, currentMenu: electron.Menu.getApplicationMenu()?.items.map((i) => i.label) ?? null,
      badges: el.badges.slice(-10), dockBadge: electron.app.dock ? electron.app.dock.getBadge() : null, notifications: el.notifications.slice(-10),
      windows: el.windows.slice(-10), suppress: el.suppress, badgeOverride: el.badgeOverride, appendMenu: el.appendMenu }),
    // Menu items (with submenus) whose label contains `label` (case-insensitive): path, accelerator, enabled.
    menuFind: (c) => {
      const out = [];
      const needle = String(c.label || '').toLowerCase();
      const walk = (menu, trail) => {
        for (const item of menu ? menu.items : []) {
          const label = String(item.label || '');
          if (label.toLowerCase().includes(needle)) out.push({ path: [...trail, label].join(' > '), accelerator: item.accelerator || null, enabled: item.enabled, visible: item.visible });
          if (item.submenu) walk(item.submenu, [...trail, label]);
        }
      };
      walk(electron.Menu.getApplicationMenu(), []);
      return out.slice(0, 40);
    },
    // A menu bar item clicked as the user's click is (Electron's menu delegate calls the item's click with the window in front): the
    // first item whose path of labels is `path` (QA copies only; H6m3b's hold sees it as the user's).
    menuClick: (c) => {
      const want = Array.isArray(c.path) ? c.path.join('\u0000') : '';
      let found = null;
      const walk = (menu, trail) => { for (const item of menu ? menu.items : []) { const p = [...trail, String(item.label || '')]; if (!found && p.join('\u0000') === want && !item.submenu) found = item; if (item.submenu) walk(item.submenu, p); } };
      walk(electron.Menu.getApplicationMenu(), []);
      if (!found) return { clicked: false };
      const win = electron.BrowserWindow.getFocusedWindow() || electron.BrowserWindow.getAllWindows()[0] || null;
      const r = found.click({ triggeredByAccelerator: false }, win || undefined, win ? win.webContents : undefined);
      return { clicked: true, returned: r === undefined ? 'undefined' : typeof r, command: typeof found.codexmodsCommand === 'string' ? found.codexmodsCommand : null };
    },
    // A file pasted into the composer whose editor matches `selector` (default: the first), as the user's paste is (QA copies only; H6m3b):
    // a ClipboardEvent carrying one file `name`, a 1x1 PNG unless `text`.
    pasteFile: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const ed = document.querySelector(${JSON.stringify(String(c.selector || '.ProseMirror'))}); if (!ed) return { pasted: false };
      ed.focus(); const dt = new DataTransfer();
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (ch) => ch.charCodeAt(0));
      dt.items.add(${c.text ? `new File(['qa'], ${JSON.stringify(String(c.name || 'qa-attach.txt'))}, { type: 'text/plain' })` : `new File([png], ${JSON.stringify(String(c.name || 'qa-attach.png'))}, { type: 'image/png' })`});
      const ok = ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return { pasted: true, defaultPrevented: !ok }; })()`),
    elSet: (c) => {
      if ('suppress' in c) el.suppress = !!c.suppress;
      if ('badgeOverride' in c) el.badgeOverride = c.badgeOverride == null ? null : String(c.badgeOverride);
      if ('appendMenu' in c) el.appendMenu = !!c.appendMenu;
      return { suppress: el.suppress, badgeOverride: el.badgeOverride, appendMenu: el.appendMenu };
    },
    // Raises a notification through the (wrapped) Electron API, as framework-main would for a mod.
    // A9: a framework notification; a click is recorded and, with `path`, navigates the window the way a framework would.
    elNotify: (c) => {
      const n = new electron.Notification({ title: String(c.title || 'Codex Mods QA'), body: String(c.body || 'G-el') });
      el.notifyClicks = el.notifyClicks || [];
      n.on('click', () => {
        el.notifyClicks.push({ at: Date.now(), title: String(c.title || 'Codex Mods QA') });
        if (c.path) { const v = pick(c.wc); const w = electron.BrowserWindow.fromWebContents(v.sender); if (w) { w.show(); w.focus(); } v.sender.send(FOR_VIEW, { type: 'navigate-to-route', path: String(c.path) }); }
      });
      (el.liveNotifications = el.liveNotifications || []).push(n);   // kept alive: a collected Notification never reports its click
      if (el.liveNotifications.length > 20) el.liveNotifications.shift();
      n.show();
      return { shown: true, clicks: el.notifyClicks.length };
    },
    elClicks: () => ({ clicks: el.notifyClicks || [] }),
    app: async (c) => pick(c.wc).sender.executeJavaScript(`(${APP_OPS.toString()})(${JSON.stringify(String(c.do))})`),
    lazyBoot: async (c) => pick(c.wc).sender.executeJavaScript(c.plan ? `localStorage.setItem('codexmods.lazyBoot', ${JSON.stringify(String(c.plan))}), 'lazy ' + ${JSON.stringify(String(c.plan))}` : `localStorage.removeItem('codexmods.lazyBoot'), 'lazy off'`),
    lazyStats: async (c) => pick(c.wc).sender.executeJavaScript(`({ ...(globalThis.__codexmodsLazyStats || {}), errors: globalThis.__codexmodsLazyErrors | 0 })`),
    tapBoot: async (c) => pick(c.wc).sender.executeJavaScript(c.on ? `localStorage.setItem('codexmods.tap', '1'), 'tap on'` : `localStorage.removeItem('codexmods.tap'), 'tap off'`),
    tapStats: async (c) => pick(c.wc).sender.executeJavaScript(`({ runs: globalThis.__codexmodsTapRuns, commands: (globalThis.__codexmodsTapCommands || []).length })`),
    // P13: the composer controller captured by the `watch` plan: read its text, or insert text through its editor view.
    composer: async (c) => pick(c.wc).sender.executeJavaScript(`(() => {
      const p = (globalThis.__codexmodsJsxCaptured || {}).composerController;
      const ctl = p && p.composerController;
      if (!ctl || !ctl.view) return { captured: false };
      const view = ctl.view;
      if (${JSON.stringify(c.do)} === 'insert') view.dispatch(view.state.tr.insertText(${JSON.stringify(String(c.text || ''))}));
      return { captured: true, text: view.state.doc.textContent, submitReady: ctl.submitReady, plainTextMode: ctl.plainTextMode };
    })()`),
    // Rules for the `inject` plan: [{prop, mode: set|wrap|null, text?}] (the plan re-reads them when the version changes).
    jsxInject: async (c) => pick(c.wc).sender.executeJavaScript(`localStorage.setItem('codexmods.jsxInject', ${JSON.stringify(JSON.stringify(c.rules || []))}), globalThis.__codexmodsInjectRules = null, 'inject set'`),
    jsxWatch: async (c) => pick(c.wc).sender.executeJavaScript(`localStorage.setItem('codexmods.jsxWatch', ${JSON.stringify(JSON.stringify(c.props || []))}), 'watch set'`),
    // The value of a prop the `watch` plan captured (or of another `field` of the same props), as plain data to `depth` levels (default 3,
    // at most 6): strings cut at 200, functions
    // and elements named, arrays to their first 5 items. For learning a component's props on a build (breadth.md D2).
    jsxCaptured: async (c) => pick(c.wc).sender.executeJavaScript(`(() => {
      const name = ${JSON.stringify(String(c.prop || ''))};
      const props = (globalThis.__codexmodsJsxCaptured || {})[name];
      if (!props) return { captured: false };
      const max = ${Math.min(Math.max(Number(c.depth) || 3, 1), 6)};
      const seen = new WeakSet();
      const sum = (v, d) => {
        if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
        if (typeof v === 'function') return '[fn ' + (v.displayName || v.name || '') + ']';
        if (typeof v !== 'object') return '[' + typeof v + ']';
        if (v.$$typeof) return '[element ' + (typeof v.type === 'string' ? v.type : (v.type && (v.type.displayName || v.type.name)) || '?') + ']';
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (Array.isArray(v)) return d >= max ? '[array ' + v.length + ']' : { length: v.length, items: v.slice(0, 5).map((x) => sum(x, d + 1)) };
        if (d >= max) return '[object ' + Object.keys(v).slice(0, 12).join(',') + ']';
        const out = {};
        for (const k of Object.keys(v).slice(0, 40)) out[k] = sum(v[k], d + 1);
        return out;
      };
      const field = ${JSON.stringify(String(c.field || ''))} || name;
      return { captured: true, keys: Object.keys(props), field, value: sum(props[field], 0) };
    })()`),
    jsxBoot: async (c) => pick(c.wc).sender.executeJavaScript(c.plan ? `localStorage.setItem('codexmods.jsxBoot', ${JSON.stringify(String(c.plan))}), 'boot ' + ${JSON.stringify(String(c.plan))}` : `localStorage.removeItem('codexmods.jsxBoot'), 'boot off'`),
    // Read-only: how many elements match a selector, and the text of the first few.
    count: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const all = (root, sel, out) => { out.push(...root.querySelectorAll(sel)); if (${c.deep ? 'true' : 'false'}) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) all(el.shadowRoot, sel, out); return out; }; const l = all(document, ${JSON.stringify(String(c.selector))}, []); return { count: l.length, first: l.slice(0, 5).map((e) => e.textContent.slice(0, 80)), attrs: l.slice(0, 5).map((e) => ({ checked: e.getAttribute('aria-checked'), label: e.getAttribute('aria-label'), expanded: e.getAttribute('aria-expanded'), path: e.getAttribute('data-item-path'), type: e.getAttribute('data-item-type'), row: (e.closest('[class]') && e.parentElement && e.parentElement.parentElement ? e.parentElement.parentElement.textContent.slice(0, 60) : null) })), last: l.slice(-3).map((e) => e.textContent.slice(-80)) }; })()`),
    // The kernel's mounted records of one binding (QA copies only; graph-integrity G5: what a build's component is given): each one's
    // props' keys, and the props named (`props`), each summed up (a function as [fn], an object by its keys).
    records: async (c) => pick(c.wc).sender.executeJavaScript(`(() => {
      const st = globalThis.__codexmods && globalThis.__codexmods.store;
      if (!st || typeof st.mounted !== 'function') return null;
      const want = ${JSON.stringify(String(c.binding || ''))}, names = ${JSON.stringify(Array.isArray(c.props) ? c.props.map(String) : [])};
      const sum = (v) => (v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function') ? v : typeof v === 'function' ? '[fn]'
        : Array.isArray(v) ? '[array ' + v.length + ']' : '{' + Object.keys(v).slice(0, 16).join(',') + '}');
      const all = st.mounted().filter((r) => r && r.binding === want);
      return { count: all.length, records: all.slice(0, ${Math.min(Math.max(Number(c.n) || 5, 1), 20)}).map((r) => ({ keys: Object.keys(r.props || {}).sort(), values: Object.fromEntries(names.map((k) => [k, sum((r.props || {})[k])])) })) };
    })()`),
    // A user-like click on the first element matching `selector` whose text starts with `text` (QA copies only).
    // C5 V3: whether the presentation kernel was in the main world before the app's chunks arrived (its install time against their timing).
    kernel: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const K = globalThis.__codexmods || null; const chunks = performance.getEntriesByType('resource').filter((e) => /\\/(app-shared|app-initial|app-primary)-/.test(e.name)).map((e) => ({ name: e.name.split('/').pop(), startTime: Math.round(e.startTime), responseEnd: Math.round(e.responseEnd) })); return { kernel: K && K.kernel ? K.kernel : null, hooks: K ? { jsx: typeof K.jsx, lazy: typeof K.lazy, store: !!K.store, exports: K.exports ? Object.keys(K.exports).length : 0 } : null, chunks }; })()`),
    // The kernel's content hooks and faults (QA copies only): whether the markdown text seam reaches the runtime.
    hookState: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const K = globalThis.__codexmods || null; if (!K) return null; const f = K.faults || {};
      if (${c.watch ? 'true' : 'false'} && !K.__qaText) { const own = K.markdownText; K.__qaText = { calls: 0, last: [] }; K.markdownText = function (props, rt) { const out = own.call(this, props, rt);
        K.__qaText.calls++; const t = (props && props.tokens) || []; K.__qaText.last.push({ kind: props && props.textStyle && props.textStyle.kind, tone: props && props.textStyle && props.textStyle.tone, conv: props && props.conversationId,
          text: JSON.stringify(t).slice(0, 80), answer: typeof out, same: out === rt }); if (K.__qaText.last.length > 8) K.__qaText.last.shift(); return out; }; }
      return { markdownText: typeof K.markdownText, markdownSite: typeof K.markdownSite, storeText: typeof (K.store && K.store.text), storeParts: typeof (K.store && K.store.parts),
        faults: Object.fromEntries(Object.entries(f).filter(([k, v]) => typeof v === 'number')), lastFault: f.last ? { where: f.last.where, message: String(f.last.message || f.last.error || '').slice(0, 300) } : null, text: K.__qaText || null }; })()`),
    focus: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, label: e.getAttribute('aria-label'), role: e.getAttribute('role'), text: (e.textContent || '').trim().slice(0, 60) } : null; })()`),
    click: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const l = [...document.querySelectorAll(${JSON.stringify(String(c.selector || '*'))})].filter((e) => e.textContent.trim().startsWith(${JSON.stringify(String(c.text || ''))})); const e = ${Number.isInteger(c.index) ? `l[${c.index}]` : 'l[l.length - 1]'}; if (!e) return { clicked: false }; e.click(); return { clicked: true, tag: e.tagName, matches: l.length }; })()`),
    // A synthetic key press into the window (QA copies only): `key` (for example `K`), `modifiers` (for example ["meta"]).
    key: (c) => {
      const wc = pick(c.wc).sender;
      const ev = { keyCode: String(c.key), modifiers: Array.isArray(c.modifiers) ? c.modifiers : [] };
      wc.sendInputEvent({ type: 'keyDown', ...ev });
      if (String(c.key).length === 1) wc.sendInputEvent({ type: 'char', ...ev });
      wc.sendInputEvent({ type: 'keyUp', ...ev });
      return { sent: ev };
    },
    // A synthetic mouse press at the centre of the first match of `selector` (or the `index`th), through the window's input events (QA
    // copies only): `button` left (opens a menu trigger that listens for pointer-down) or right (the app's own context-menu path).
    pointer: async (c) => {
      const wc = pick(c.wc).sender;
      // `deep: true` also searches open shadow roots (the app's file trees draw their rows in one); `text`: only the visible matches whose
      // text starts with it
      const at = await wc.executeJavaScript(`(() => { const all = (root, sel, out) => { out.push(...root.querySelectorAll(sel)); if (${c.deep ? 'true' : 'false'}) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) all(el.shadowRoot, sel, out); return out; }; const t = ${JSON.stringify(typeof c.text === 'string' ? c.text : null)}; const l = all(document, ${JSON.stringify(String(c.selector || '*'))}, []).filter((e) => t === null || (e.textContent.trim().startsWith(t) && e.getBoundingClientRect().width > 0)); const e = l[${Number.isInteger(c.index) ? c.index : 0}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), matches: l.length }; })()`);
      if (!at) return { found: false };
      const button = c.button === 'right' ? 'right' : 'left';
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button, clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button, clickCount: 1 });
      return { found: true, ...at, button };
    },
    // The window's content size (layouts WL0: the app's narrow-window thresholds): `w`, `h`; none reports it.
    winSize: (c) => {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.fromWebContents(pick(c.wc).sender);
      if (!win) return { unavailable: 'no window' };
      if (Number(c.w) > 0 && Number(c.h) > 0) win.setContentSize(Math.round(Number(c.w)), Math.round(Number(c.h)));
      const [w, h] = win.getContentSize();
      return { w, h };
    },
    // A trusted drag in phases (layouts WL0: when a divider writes its stored size): `phase` down (at the centre of `selector`, or `x`/`y`),
    // move (by `dx`/`dy` in `steps`), up; the pointer's place is kept between calls, so the storage can be read mid-drag.
    drag: async (c) => {
      const wc = pick(c.wc).sender;
      const st = bus.drag || (bus.drag = { x: 0, y: 0 });
      if (c.phase === 'down') {
        const at = c.selector ? await wc.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(String(c.selector))}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) : { x: Number(c.x), y: Number(c.y) };
        if (!at) return { found: false };
        Object.assign(st, at);
        wc.sendInputEvent({ type: 'mouseMove', x: st.x, y: st.y });
        wc.sendInputEvent({ type: 'mouseDown', x: st.x, y: st.y, button: 'left', clickCount: 1 });
        return { down: true, ...at };
      }
      if (c.phase === 'move') {
        const steps = Math.max(1, Number(c.steps) || 8);
        const dx = Number(c.dx) || 0; const dy = Number(c.dy) || 0;
        for (let i = 1; i <= steps; i++) {
          wc.sendInputEvent({ type: 'mouseMove', x: Math.round(st.x + (dx * i) / steps), y: Math.round(st.y + (dy * i) / steps), button: 'left', modifiers: ['leftButtonDown'] });
          await new Promise((r) => setTimeout(r, 16));
        }
        st.x += dx; st.y += dy;
        return { at: { x: st.x, y: st.y } };
      }
      if (c.phase === 'up') { wc.sendInputEvent({ type: 'mouseUp', x: st.x, y: st.y, button: 'left', clickCount: 1 }); return { up: true, at: { x: st.x, y: st.y } }; }
      return { unknown: c.phase };
    },
    // Trusted mouse-wheel input at the centre of the first match of `selector` (default the transcript's scroller): `deltaY` pixels
    // (negative: up), `count` times, `every` ms apart. The app pages its history on a user's scroll to the top, not on a programmatic one.
    wheel: async (c) => {
      const wc = pick(c.wc).sender;
      const at = await wc.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(String(c.selector || '[data-app-action-timeline-scroll]'))}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!at) return { found: false };
      const count = Math.min(Math.max(Number(c.count) || 1, 1), 1000), every = Math.min(Math.max(Number(c.every) || 16, 0), 5000), dy = Number(c.deltaY) || -120;
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      for (let i = 0; i < count; i++) {
        wc.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy, canScroll: true });
        await new Promise((r) => setTimeout(r, every));
      }
      return { found: true, ...at, count };
    },
    console: (c) => { const l = (bus.console || []).filter((x) => !c.match || x.message.includes(String(c.match))); if (c.clear) bus.console = []; return l.slice(-(Number(c.max) || 10)); },
    // Attributes of the first matches (`names`), and computed CSS properties (`props`, custom properties included) of the first match.
    attrs: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const l = [...document.querySelectorAll(${JSON.stringify(String(c.selector || 'html'))})].slice(0, ${Number(c.n) || 3}); return l.map((e) => Object.fromEntries(${JSON.stringify(c.names || [])}.map((n) => [n, e.getAttribute(n)]))); })()`),
    // Layout boxes and custom properties (layouts WL0): `rects` with `selectors` (each: count and the first match's box), `cssvar` with a
    // `selector` and `names` (computed values, custom properties included).
    rects: async (c) => pick(c.wc).sender.executeJavaScript(`(() => Object.fromEntries(${JSON.stringify(c.selectors || [])}.map((s) => { const l = document.querySelectorAll(s); const r = l[0] && l[0].getBoundingClientRect(); return [s, { count: l.length, ...(r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : {}) }]; })))()`),
    cssvar: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(String(c.selector || ':root'))}); if (!e) return null; const cs = getComputedStyle(e); return Object.fromEntries(${JSON.stringify(c.names || [])}.map((n) => [n, cs.getPropertyValue(n).trim()])); })()`),
    // Layouts WL0 experiments over the framework's own exposures (`__codexmods.exports`) and a mounted binding's RouteScope node:
    // `do` = scopes | titlebar | kinds | tabs | route | route-add | route-remove | mode.
    wl0: async (c) => pick(c.wc).sender.executeJavaScript(`(${WL0_OPS.toString()})(${JSON.stringify(String(c.do))}, ${JSON.stringify(c.args ?? null)})`),
    css: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(String(c.selector || 'html'))}); if (!e) return null; const cs = getComputedStyle(e); return Object.fromEntries(${JSON.stringify(c.props || [])}.map((p) => [p, cs.getPropertyValue(p).trim()])); })()`),
    menus: (c) => { if (c.append !== undefined) bus.menuAppend = !!c.append; if (c.choose !== undefined) bus.menuChoose = c.choose ? String(c.choose) : null; return { append: !!bus.menuAppend, runs: bus.menuRuns || 0, last: (bus.menus || []).slice(-(Number(c.max) || 2)) }; },
    refuse: (c) => { bus.refuse = new Set(Array.isArray(c.list) ? c.list : []); return { refusing: [...bus.refuse], refusals: (bus.refusals || []).slice(-10) }; },
    // The window's focus state: `minimize`, `restore`, or neither (report only).
    win: (c) => {
      const w = electron.BrowserWindow.fromWebContents(pick(c.wc).sender);
      if (!w) throw new Error('no window');
      if (c.do === 'minimize') w.minimize();
      if (c.do === 'restore') { w.restore(); w.focus(); }
      // `width`: the window's outer width in points (layouts WL4d: the allocator's sweeps)
      if (Number.isFinite(c.width)) { const b = w.getBounds(); w.setBounds({ x: b.x, y: b.y, width: Math.round(c.width), height: b.height }); }
      return { focused: w.isFocused(), minimized: w.isMinimized(), visible: w.isVisible(), bounds: w.getBounds() };
    },
    // P3: frame intervals in the page (requestAnimationFrame) between `start` and `stop`: count, p50, p95, frames over 16.7 ms, max.
    perf: async (c) => pick(c.wc).sender.executeJavaScript(c.do === 'start'
      ? `(() => { const g = globalThis; const st = g.__codexmodsPerf = { on: true, d: [], last: performance.now() }; const tick = (t) => { if (!st.on) return; st.d.push(t - st.last); st.last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 'started'; })()`
      : `(() => { const st = globalThis.__codexmodsPerf; if (!st) return null; st.on = false; const d = st.d.slice(1).sort((a, b) => a - b); const q = (x) => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(x * d.length))] * 10) / 10 : null; return { frames: d.length, p50: q(0.5), p95: q(0.95), over16: d.filter((x) => x > 16.7).length, max: d.length ? Math.round(d[d.length - 1] * 10) / 10 : null }; })()`),
    reload: (c) => { pick(c.wc).sender.reload(); return { reloaded: true }; },
    // Scroll an element (default the transcript's scroller) by `y` pixels, `count` times, `every` ms apart, from inside the page (what a
    // wheel does to the virtualized list, without input delivery); resolves when done with the final scrollTop (the frame budget, D2).
    scroll: async (c) => pick(c.wc).sender.executeJavaScript(`new Promise((resolve) => {
      const el = document.querySelector(${JSON.stringify(String(c.selector || '[data-app-action-timeline-scroll]'))});
      if (!el) { resolve({ found: false }); return; }
      const y = ${Number(c.y) || -800}, count = ${Math.min(Math.max(Number(c.count) || 1, 1), 500)}, every = ${Math.min(Math.max(Number(c.every) || 0, 0), 5000)};
      let i = 0;
      const step = () => { el.scrollBy({ top: y }); if (++i < count) setTimeout(step, every); else setTimeout(() => resolve({ found: true, scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight }), 50); };
      step();
    })`),
    jsx: async (c) => pick(c.wc).sender.executeJavaScript(`(${JSX_PLANS.toString()})(${JSON.stringify(String(c.plan))})`),
    busLast: (c) => Object.fromEntries(Object.entries(bus.last).filter(([k]) => !c.type || k.endsWith(` ${c.type}`))),
    busStats: () => ({ handler: !!bus.fromView, counts: bus.counts, recent: bus.recent.slice(-40), mcpKeys: bus.mcpKeys || null }),
    fetch: async (c) => {
      const rec = pick(c.wc);
      if (!bus.fromView) throw new Error('no message-from-view handler was registered');
      const requestId = `cmqa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const done = new Promise((resolveFetch, rejectFetch) => {
        bus.pending.set(requestId, resolveFetch);
        setTimeout(() => { if (bus.pending.delete(requestId)) rejectFetch(new Error('no fetch-response in 15 s')); }, 15000);
      });
      const event = { sender: rec.sender, senderFrame: rec.sender.mainFrame, processId: rec.sender.getProcessId(), frameId: rec.sender.mainFrame.routingId };
      await bus.fromView(event, { type: 'fetch', requestId, url: `vscode://codex/${c.name}`, method: 'POST', ...(c.headers ? { headers: c.headers } : {}), body: c.body === undefined ? undefined : JSON.stringify(c.body) });
      const r = await done;
      return render(r.bodyJsonString !== undefined ? { status: r.status, body: JSON.parse(r.bodyJsonString) } : r, c.max);
    },
    // A renderer->main message delivered to the app's own handler with the window as sender (as `fetch` does).
    post: async (c) => {
      const rec = pick(c.wc);
      if (!bus.fromView) throw new Error('no message-from-view handler was registered');
      const event = { sender: rec.sender, senderFrame: rec.sender.mainFrame, processId: rec.sender.getProcessId(), frameId: rec.sender.mainFrame.routingId };
      return render(await bus.fromView(event, c.message));
    },
    // A request to one of main's workers (the `git` worker), sent as the window would; the reply is taken out of the window's stream.
    worker: async (c) => {
      const rec = pick(c.wc);
      const workerId = c.workerId || 'git';
      const handler = (bus.workers || {})[workerId];
      if (!handler) throw new Error(`no handler for worker ${workerId}`);
      const id = `cmqa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const done = new Promise((resolveIt, rejectIt) => {
        bus.pending.set(`worker:${id}`, resolveIt);
        setTimeout(() => { if (bus.pending.delete(`worker:${id}`)) rejectIt(new Error('no worker-response in 20 s')); }, 20000);
      });
      const event = { sender: rec.sender, senderFrame: rec.sender.mainFrame, processId: rec.sender.getProcessId(), frameId: rec.sender.mainFrame.routingId };
      await handler(event, { type: 'worker-request', workerId, request: { id, method: c.method, params: c.params || {} } });
      const r = await done;
      return render(r.response, c.max);
    },
    send: (c) => { pick(c.wc).sender.send(FOR_VIEW, c.message); return { sent: c.message && c.message.type }; },
    // Read-only: the window's visible text (optionally under a CSS selector), for checking what the app rendered.
    text: async (c) => pick(c.wc).sender.executeJavaScript(`(() => { const el = ${JSON.stringify(c.selector || 'body')} === 'body' ? document.body : document.querySelector(${JSON.stringify(c.selector || 'body')}); return el ? el.innerText.slice(0, ${Number(c.max) || 8000}) : null; })()`),
    views: () => [...views.entries()].map(([wc, v]) => ({ wc, url: v.sender.isDestroyed() ? null : v.sender.getURL(), services: Object.keys(v.host.services || {}).sort(), wrapped: [...v.wrapped].flatMap(([svc, e]) => [...e.modes].map(([m, mode]) => `${svc}.${m}:${mode}`)) })),
    describe: (c) => {
      const { value } = resolve(pick(c.wc), c.path);
      if (value == null || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
      return { ctor: value.constructor && value.constructor.name, own: Object.keys(value), methods: methodsOf(value) };
    },
    // Main's window manager (held at the listener), for scouting main-side objects such as the app-server connection registry.
    // A path step is a property name, or {call, args} to call a method of the current value.
    mgrDescribe: async (c) => {
      let v = pick(c.wc).manager;
      for (const k of c.path || []) v = v == null ? undefined : (k && typeof k === 'object' ? await v[k.call](...(k.args || [])) : v[k]);
      if (v == null || (typeof v !== 'object' && typeof v !== 'function')) return { type: v === null ? 'null' : typeof v };
      return { ctor: v.constructor && v.constructor.name, own: Object.keys(v).slice(0, 80), methods: methodsOf(v).slice(0, 120) };
    },
    mgrCall: async (c) => {
      let parent = null; let v = pick(c.wc).manager;
      for (const k of c.path || []) { parent = v; v = v == null ? undefined : (k && typeof k === 'object' ? await v[k.call](...(k.args || [])) : v[k]); }
      if (typeof v !== 'function') throw new Error(`not a function: ${(c.path || []).join('.')}`);
      return render(await v.apply(parent, c.args || []), c.max);
    },
    call: async (c) => {
      const { parent, value } = resolve(pick(c.wc), c.path);
      if (typeof value !== 'function') throw new Error(`not a function: ${(c.path || []).join('.')}`);
      return render(await value.apply(parent, c.args || []), c.max);
    },
    action: async (c) => {
      const services = await pick(c.wc).view.services;
      return render(await services.appActions.run(c.args), c.max);
    },
    viewServices: async (c) => {
      const services = await pick(c.wc).view.services;
      return render(Object.keys(services || {}));
    },
    wrap: (c) => wrap(pick(c.wc), c.path[0], c.path[1] ?? '*', c.mode === 'refuse' ? 'refuse' : 'log'),
    // G4: a framework terminal session through the window's AppHost `terminal` service: create, subscribe, write, collect, close.
    termTest: async (c) => {
      const t = pick(c.wc).host.services.terminal;
      const sessionId = require('crypto').randomUUID();
      const events = [];
      // The service expects a Cap'n Web callback stub (`dup`, `onRpcBroken`, dispose); an in-process caller passes a function shaped like one.
      const cb = (ev) => { if (!ev || ev.sessionId === undefined || ev.sessionId === sessionId) events.push(render(ev, 400)); };
      cb.dup = () => cb; cb.onRpcBroken = () => {}; cb[Symbol.dispose] = () => {};
      const sub = await t.subscribe(cb);
      const created = await t.create({ sessionId, conversationId: c.conversationId || null, conversationTitle: null, hostId: 'local', cwd: c.cwd || null, cols: 80, rows: 24 });
      await new Promise((r) => setTimeout(r, 800));
      await t.write(sessionId, `${c.command || 'echo g4-terminal'}\r`);
      await new Promise((r) => setTimeout(r, 1500));
      const closed = await Promise.resolve().then(() => t.close(sessionId)).catch((e) => String(e && e.message || e));
      try { if (sub && typeof sub.cleanup === 'function') sub.cleanup(); else if (typeof sub === 'function') sub(); } catch { /* ignore */ }
      return { sessionId, created: render(created, 400), closed: render(closed, 200), events: events.slice(0, 30) };
    },
    // C3: a framework read-state session through AppHost `threadReadState.open(callback, options)`; `set` writes `c.state` when given.
    readState: async (c) => {
      const svc = pick(c.wc).host.services.threadReadState;
      const events = [];
      const cb = (ev) => { events.push(render(ev, 1500)); };
      cb.dup = () => cb; cb.onRpcBroken = () => {}; cb[Symbol.dispose] = () => {};
      const res = await svc.open(cb, c.options);
      await new Promise((r) => setTimeout(r, 500));
      let setResult;
      if (res && res.status === 'ready' && c.state !== undefined) { setResult = render(await res.session.set(c.state), 600); await new Promise((r) => setTimeout(r, 500)); }
      const out = { status: res && res.status, keys: res ? Object.keys(res) : null, events: events.slice(0, 10), setResult };
      if (res && res.session) res.session.unsubscribe();
      return out;
    },
    wrapBoot: (c) => {
      if (c.clear) { bootModes.length = 0; return { bootModes: [] }; }
      bootModes.push({ svc: c.path[0], method: c.path[1] ?? '*', mode: c.mode === 'refuse' ? 'refuse' : 'log' });
      return { bootModes };
    },
    unwrap: (c) => {
      const entry = pick(c.wc).wrapped.get(c.path[0]);
      if (!entry) return { unwrapped: false };
      if (c.path[1]) entry.modes.delete(c.path[1]); else entry.modes.clear();
      return { unwrapped: true };
    },
  };

  const busy = new Set();
  const poll = () => {
    let names;
    try { names = fs.readdirSync(inDir).filter((n) => n.endsWith('.json')); } catch { return; }
    for (const name of names) {
      if (busy.has(name)) continue;
      busy.add(name);
      const file = path.join(inDir, name);
      const id = name.slice(0, -5);
      let cmd;
      (async () => {
        cmd = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.rmSync(file, { force: true });
        const op = ops[cmd.op];
        if (!op) throw new Error(`unknown op ${cmd.op}`);
        return op(cmd);
      })().then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message || e) }))
        .then((r) => {
          try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
          fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify({ id, op: cmd && cmd.op, ...r }));
          log({ ev: 'command', id, op: cmd && cmd.op, ok: r.ok, error: r.error });
          busy.delete(name);
        });
    }
  };
  const timer = setInterval(poll, 250);
  if (timer.unref) timer.unref();
  log({ ev: 'probe.start', pid: process.pid });
})();
