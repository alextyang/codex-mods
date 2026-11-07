// Test harness: the whole renderer core wired to the shim DOM, the fake React, an in-memory Host port and a fake realm client.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDom } from '../dom.mjs';
import { createRuntimeCore } from '../core.mjs';
import { createFakeReact } from './fake-react.mjs';
import { createShimWindow, flush } from './dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const pack = JSON.parse(readFileSync(join(here, '..', '..', '..', 'adapters', '26.1007.21159-20052', 'adapter.json'), 'utf8'));

export const SHELL = `
<header data-app-shell-titlebar="true"></header>
<nav role="navigation" class="_Navigation_x"><div class="absolute inset-x-0 bottom-0"></div></nav>
<main data-app-shell-main-surface="default"><div data-app-shell-workspace-layout="s">
  <div data-app-shell-header-toolbar="true"></div>
  <div data-codex-composer-root=""><div data-codex-composer="true"><div class="ProseMirror" contenteditable="true"></div></div></div>
</div></main>
<a data-app-action-sidebar-thread-id="thr_1">Thread 1</a>`;

/** Two connected in-memory ports. */
export function portPair() {
  const mk = () => {
    const l = new Set();
    return { peer: null, sent: [], closed: false, listeners: l, start() {}, close() { this.closed = true; for (const f of [...(this.closeL ?? [])]) f(); },
      addEventListener(t, f) { if (t === 'message') l.add(f); else if (t === 'close') (this.closeL ??= new Set()).add(f); },
      removeEventListener(t, f) { l.delete(f); },
      postMessage(m) { this.sent.push(m); queueMicrotask(() => { for (const f of [...this.peer.listeners]) f({ data: m }); }); } };
  };
  const a = mk(); const b = mk(); a.peer = b; b.peer = a;
  return { host: a, runtime: b };
}

export async function setup({ html = SHELL, search = '', withReact = true, importModule, extra = {} } = {}) {
  const win = createShimWindow({ html, search });
  const dom = createDom(win);
  const { React, ReactDOM } = createFakeReact();
  const exportsObj = withReact ? { react: React, reactDom: ReactDOM } : {};
  const realmPorts = [];
  const realmContexts = [];
  const bridgeCalls = [];
  const modulesByUrl = new Map();
  const env = {
    dom,
    getExport: (k) => exportsObj[k],
    importModule: importModule ?? (async (url) => { const m = modulesByUrl.get(url); if (!m) throw new Error(`cannot load ${url}`); return m; }),
    createRealmClient: (port) => { realmPorts.push(port); return { context: (modId, realm, info) => { const c = { mod: info, log: {}, settings: {}, storage: {}, secrets: {}, events: {}, services: {}, appServer: {}, marker: `ctx:${modId}` }; realmContexts.push(c); return c; } }; },
    bridge: { frameworkModule: async (spec) => { bridgeCalls.push(['frameworkModule', spec]); if (extra.frameworkModules?.[spec]) return extra.frameworkModules[spec]; throw new Error(`no framework module ${spec}`); },
      pickFile: async (o) => { bridgeCalls.push(['pickFile', o]); return extra.pickedPath ?? null; } },
    log: () => {},
  };
  const boot = { adapter: pack, appBuild: '26.1007.21159-20052' };
  const core = createRuntimeCore(boot, env);
  const { host, runtime } = portPair();
  core.attachRenderer(runtime);
  const settle = async () => { await flush(); win.clock.tick(40); await flush(); };
  const send = async (msg) => { host.postMessage(msg); await settle(); };
  return { win, dom, React, ReactDOM, exportsObj, core, host, runtime, settle, send, modulesByUrl, realmPorts, realmContexts, bridgeCalls, env, boot,
    fromRuntime: (t) => runtime.sent.filter((m) => m.t === t),
    modulesMsg: (list) => ({ t: 'modules', modules: list.map((m) => ({ version: '1.0.0', dataDir: '/data', ...m })) }) };
}
