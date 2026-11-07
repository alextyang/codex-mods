// Renderer runtime entry. Runs in the page MAIN world (no Node), injected by framework/preload/preload.cjs through
// webFrame.executeJavaScript after framework-main bundled this module graph into one script (framework/main/views/bundle.cjs).
// The preload hands over, by window.postMessage with transferred MessagePorts:
//   kind 'renderer'   → the Host channel (contracts/ipc.d.ts §2–3)
//   kind 'management' → the Adjustments management channel (contracts/management.d.ts)
// and serves two requests for us: privileged framework modules (they cannot be imported: the page CSP only allows 'self'),
// and the native file picker.
import { createDom } from './dom.mjs';
import { createRuntimeCore } from './core.mjs';
import { createRealmClient } from '../shared/realm-client.mjs';

let current = null;

/** Load a privileged built-in module (see core.mjs loadFrameworkModule). Rejects Unavailable before the runtime started. */
export function loadFrameworkModule(spec, extra) {
  if (!current) return Promise.reject(new Error('the renderer runtime has not started'));
  return current.loadFrameworkModule(spec, extra);
}

/** Run `fn` once `document.documentElement` exists (the preload can inject while readyState is 'loading' and <html> is still null). */
export function whenDocumentReady(win, fn) {
  const doc = win.document;
  if (doc.documentElement) return fn();
  let done = false;
  const go = () => {
    if (done || !doc.documentElement) return;
    done = true;
    try { mo?.disconnect(); } catch { /* observer already gone */ }
    doc.removeEventListener?.('readystatechange', go);
    doc.removeEventListener?.('DOMContentLoaded', go);
    fn();
  };
  const mo = typeof win.MutationObserver === 'function' ? new win.MutationObserver(go) : null;
  mo?.observe(doc, { childList: true });
  doc.addEventListener?.('readystatechange', go);
  doc.addEventListener?.('DOMContentLoaded', go);
  return undefined;
}

/** @param {{ nonce: string, adapter: object, appBuild: string }} boot
 *  Returns at once. The runtime itself is constructed when the document exists; any failure goes to the Host log through the preload. */
export function startRuntime(boot, win = globalThis.window) {
  if (started) return;
  started = true;
  const nonce = boot.nonce;
  const report = (phase, err) => {
    try { win.postMessage({ __codexmods: nonce, dir: 'to-preload', op: 'log', phase, message: String(err?.message ?? err).slice(0, 500), stack: err?.stack ? String(err.stack).slice(0, 2000) : undefined }, '*'); } catch { /* nowhere left to report */ }
  };
  win.addEventListener('error', (ev) => { if (!current) report('startup-error-event', ev?.error ?? ev?.message ?? 'error'); });
  whenDocumentReady(win, () => {
    try { construct(boot, win, report); } catch (e) { report('construct', e); }
  });
}

let started = false;

function construct(boot, win, report) {
  const dom = createDom(win);
  const nonce = boot.nonce;
  const pendingReplies = new Map();
  let reqSeq = 0;
  const toPreload = (op, payload) => new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    pendingReplies.set(reqId, { resolve, reject });
    win.postMessage({ __codexmods: nonce, dir: 'to-preload', op, reqId, ...payload }, '*');
  });
  const bridge = {
    async frameworkModule(spec) {
      const r = await toPreload('framework-module', { spec });
      const store = win.__codexmods_fwm;
      const mod = store?.[r.key];
      if (store) delete store[r.key];
      if (!mod) throw new Error(`framework module ${spec} did not register`);
      return mod;
    },
    pickFile: (opts) => toPreload('pick-file', { extensions: opts?.extensions ?? [], directory: opts?.directory === true }).then((r) => r.path ?? null),
    navigate: (path) => toPreload('navigate', { path: String(path) }).then((r) => r.done === true),
  };

  const core = createRuntimeCore(
    { adapter: boot.adapter, appBuild: boot.appBuild },
    {
      dom, bridge, createRealmClient,
      getExport: (k) => win.__codexmods?.exports?.[k],
      kernel: () => win.__codexmods,   // the presentation kernel the preload installed before the first render (presentations.md V3)
      importModule: (url) => import(url),
      log: (m, d) => report('runtime-log', new Error(d ? `${m} ${JSON.stringify(d).slice(0, 300)}` : m)),
    },
  );
  current = core;
  const onFail = (phase) => (e) => report(phase, e);

  win.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== win || !m || typeof m !== 'object' || m.__codexmods !== nonce || m.dir !== 'to-runtime') return;
    if (m.kind === 'port') {
      const port = ev.ports?.[0];
      if (!port) return;
      try {
        if (m.port === 'renderer') core.attachRenderer(port);
        else if (m.port === 'management') core.attachManagement(port);
      } catch (e) { onFail(`attach-${m.port}`)(e); }
    } else if (typeof m.reply === 'number') {
      const p = pendingReplies.get(m.reply);
      if (!p) return;
      pendingReplies.delete(m.reply);
      if (m.ok) p.resolve(m); else p.reject(new Error(String(m.error ?? 'request failed')));
    }
  });
  // Tell the preload we are listening; it flushes the ports it queued.
  win.postMessage({ __codexmods: nonce, dir: 'to-preload', op: 'runtime-ready' }, '*');
}
