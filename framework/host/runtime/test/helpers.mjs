// Test helpers for the runtime: temp layouts, mod fixtures written to disk, a recording fake Mux, in-process realm ports.
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { layout as makeLayout } from '../../../../contracts/layout.mjs';
import { createBus } from '../bus.mjs';
import { createRuntime } from '../index.mjs';
import { createRealmClient } from '../../../shared/realm-client.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 20000, interval = 20, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

/** A short root under /tmp (Unix socket paths must stay under ~100 bytes). */
export async function makeRoot() {
  const root = await mkdtemp('/tmp/cm-rt-');
  const layout = makeLayout(root, 'default');
  return { root, layout, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Write a mod package under layout.store and return an InstalledMod.
 * host / renderer: source text of the entry module. files: extra {relativePath: text}.
 */
export async function installMod(layout, spec) {
  const { id, version = '1.0.0', name = id, host, renderer, grants = [], publisher = null, settings, processes, files = {}, data } = spec;
  const packageDir = join(layout.store, id, version);
  await mkdir(packageDir, { recursive: true });
  const entry = {};
  if (host !== undefined) { await writeFile(join(packageDir, 'host.mjs'), host); entry.host = 'host.mjs'; }
  if (renderer !== undefined) { await writeFile(join(packageDir, 'renderer.mjs'), renderer); entry.renderer = 'renderer.mjs'; }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(packageDir, rel)), { recursive: true });
    await writeFile(join(packageDir, rel), text);
    if (rel.endsWith('.sh') || rel.startsWith('bin/')) await chmod(join(packageDir, rel), 0o755);
  }
  const manifest = { id, version, name, framework: '>=1 <2', entry, permissions: grants, ...(settings ? { settings } : {}), ...(processes ? { processes } : {}), ...(data ? { data } : {}) };
  const t = new Date().toISOString();
  return {
    record: { id, version, status: 'enabled', publisher, grants, dataSchemaVersion: 0, installedAt: t, updatedAt: t, installSeq: spec.installSeq ?? 1 },
    manifest, packageDir,
    dataDir: join(layout.data, id), retainedDir: join(layout.retained, id), backendsDir: join(layout.backends, id),
  };
}

// ---------------------------------------------------------------- fake Mux
export function createFakeMux() {
  const clients = new Map();
  const faultFns = new Set();
  const leases = new Map();
  const backends = new Map();
  const calls = [];
  let leaseSeq = 0;
  const mux = {
    clients, calls, leases, backends,
    client(id, opts) {
      const c = {
        id, opts, hasTransmitted: false, disposed: false,
        requests: [], notifies: [], observers: [], interceptors: [],
        async request(method, params, o) { c.hasTransmitted = true; c.requests.push({ method, params, o }); return { echo: { method, params } }; },
        notify(method, params, o) { c.hasTransmitted = true; c.notifies.push({ method, params, o }); },
        observe(filter, listener, o) {
          const rec = { filter, listener, o, disposed: false }; c.observers.push(rec);
          return { dispose() { rec.disposed = true; } };
        },
        intercept(kind, methods, handler, o) {
          const rec = { kind, methods, handler, o, disposed: false }; c.interceptors.push(rec);
          return { dispose() { rec.disposed = true; } };
        },
        async dispose() { c.disposed = true; calls.push(['client.dispose', id]); },
      };
      clients.set(id, c);
      return c;
    },
    async defineBackend(owner, key, def) { calls.push(['defineBackend', owner, key]); backends.set(`${owner}/${key}`, { key, owner, def, state: 'stopped' }); },
    async removeBackend(owner, key) { calls.push(['removeBackend', owner, key]); backends.delete(`${owner}/${key}`); },
    listBackends(owner) { return [...backends.values()].filter((b) => !owner || b.owner === owner).map((b) => ({ key: `${b.owner}/${b.key}`, owner: b.owner, state: b.state })); },
    issueLease(owner, name) { const l = { id: `lease-${++leaseSeq}`, socketPath: '/tmp/x.sock', token: 'tok' }; leases.set(l.id, { owner, name }); calls.push(['issueLease', owner, name]); return l; },
    revokeLease(id) { calls.push(['revokeLease', id]); leases.delete(id); },
    async disposeOwner(owner) { calls.push(['disposeOwner', owner]); for (const [id, l] of leases) if (l.owner === owner) leases.delete(id); },
    setLeaseServiceHandler() {},
    onFault(fn) { faultFns.add(fn); return { dispose() { faultFns.delete(fn); } }; },
    emitFault(e) { for (const fn of faultFns) fn(e); },
    metrics() { return {}; },
    async close() {},
    attachApp() {},
    /** Run the interceptors a client registered, like the real mux would (stops at the first non-pass result). */
    async runInterceptors(clientId, kind, message, info = { kind, method: message.method, origin: 'app', backend: 'primary' }) {
      const c = clients.get(clientId);
      for (const rec of c.interceptors.filter((r) => r.kind === kind && !r.disposed && (r.methods === '*' || r.methods.some((m) => m === message.method || (m.endsWith('/') && message.method?.startsWith(m)))))) {
        const r = await rec.handler(message, info);
        if (r !== undefined) return r;
      }
      return undefined;
    },
  };
  return mux;
}

// ---------------------------------------------------------------- runtime harness
export async function makeHarness(opts = {}) {
  const { root, layout, cleanup } = opts.root ? { root: opts.root.root, layout: opts.root.layout, cleanup: async () => {} } : await makeRoot();
  const log = createTestLog();
  const bus = createBus({ log });
  const mux = opts.mux ?? createFakeMux();
  const quarantines = [], announces = [], viewCalls = [], workers = [];
  let viewSeq = 0;
  const views = {
    async open(req) { viewCalls.push(['open', req]); if (opts.viewsFail) throw new Error('nope'); return `view-${++viewSeq}`; },
    async close(h) { viewCalls.push(['close', h]); },
  };
  const runtime = createRuntime({
    mux, bus, log, layout,
    rankOf: opts.rankOf ?? (() => 1),
    onQuarantine: (modId, reason) => quarantines.push({ modId, reason }),
    announceRenderer: (modId, m) => announces.push({ modId, module: m }),
    views,
    ...(opts.graph ? { graph: opts.graph } : {}),
    ...(opts.requests ? { requests: opts.requests } : {}),
    internals: { ...(opts.internals ?? {}), onWorker: (modId, worker) => workers.push({ modId, worker }) },
  });
  const events = [];
  bus.subscribe('*', (data, topic) => events.push({ topic, data }));
  return {
    root, layout, log, bus, mux, runtime, quarantines, announces, viewCalls, workers, events,
    topic: (t) => events.filter((e) => e.topic === t).map((e) => e.data),
    async close() { await runtime.close(); await cleanup(); },
  };
}

// ---------------------------------------------------------------- in-process realm ports
export function portPair() {
  const sides = [{ fns: new Set(), closers: new Set() }, { fns: new Set(), closers: new Set() }];
  const mk = (self, other) => {
    const port = {
      sent: [],
      post(m) {
        const c = JSON.parse(JSON.stringify(m)); port.sent.push(c);
        if (port.hold?.(c)) { port.held.push(c); return; }
        queueMicrotask(() => { for (const fn of [...other.fns]) fn(c); });
      },
      held: [],
      release() { const h = port.held.splice(0); queueMicrotask(() => { for (const c of h) for (const fn of [...other.fns]) fn(c); }); },
      onMessage(fn) { self.fns.add(fn); return { dispose() { self.fns.delete(fn); } }; },
      onClose(fn) { self.closers.add(fn); return { dispose() { self.closers.delete(fn); } }; },
      close() { for (const fn of [...self.closers]) fn(); for (const fn of [...other.closers]) fn(); },
    };
    return port;
  };
  return [mk(sides[0], sides[1]), mk(sides[1], sides[0])];
}

/** Attach a window's renderer channel to the runtime; returns a realm client and a record of host→realm control messages. */
export function attachWindow(runtime, windowId = 1) {
  const [hostPort, realmPort] = portPair();
  const control = [];
  realmPort.onMessage((m) => { if (m.t === 'modules' || m.t === 'settings') control.push(m); });
  const disposable = runtime.handleRealm('renderer', hostPort, { windowId });
  const client = createRealmClient(realmPort, { onError: (e) => control.push({ t: 'sub-error', error: e }) });
  return { client, control, hostPort, realmPort, disposable, post: (m) => realmPort.post(m),
    ctx: (modId, info) => client.context(modId, 'renderer', { id: modId, version: '1.0.0', dataDir: '/x', ...info }),
    lastModules: () => control.filter((m) => m.t === 'modules').at(-1)?.modules };
}

export const infoOf = (mod) => ({ id: mod.manifest.id, version: mod.record.version, dataDir: mod.dataDir });

// ---------------------------------------------------------------- run code inside a mod's worker
/** Host source that exposes `t.run({body, args})` so a test can execute async code against the real worker-side ctx. */
export const EVAL_HOST = `
export default { host(ctx) {
  ctx.services.provide('t', { async run({ body, args }) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('ctx', 'args', body);
    try { const v = await fn(ctx, args); return { ok: v === undefined ? null : v }; }
    catch (e) { return { err: { code: e.code ?? null, message: String(e.message) } }; }
  } });
} };`;
/** Run body in the worker of modId (which must use EVAL_HOST-style provider). Returns the value or throws {code,message}. */
export async function inWorker(runtime, modId, body, args = null) {
  const r = await runtime.callServiceForLease(`mod:${modId}`, { name: 't', method: 'run', args: { body, args } });
  if (r.err) { const e = new Error(r.err.message); e.code = r.err.code; throw e; }
  return r.ok;
}
