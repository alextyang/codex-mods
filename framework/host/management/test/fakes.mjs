// Minimal fakes of the interfaces Management consumes (contracts/host.d.ts). Test-only.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '../../../../contracts/layout.mjs';

export function fakeBus() {
  const subs = new Set();
  const states = new Map();
  return {
    publish(topic, data, o) {
      if (o?.state) states.set(topic, data);
      for (const s of [...subs]) if (matches(s.pattern, topic)) s.fn(data, topic);
    },
    subscribe(pattern, fn) {
      const s = { pattern, fn };
      subs.add(s);
      return { dispose() { subs.delete(s); } };
    },
    state: (t) => states.get(t),
    get subscriberCount() { return subs.size; },
  };
}
const matches = (pattern, topic) => (pattern.endsWith('*') ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic);

export const manifestOf = (over = {}) => ({
  id: 'acme.demo', version: '1.2.0', name: 'Demo', framework: '>=1 <2', entry: { host: 'host.mjs' },
  permissions: [], ...over,
});
export const recordOf = (over = {}) => ({
  id: 'acme.demo', version: '1.2.0', status: 'enabled', publisher: 'cHVibGlzaGVyLWtleQ==', grants: [], dataSchemaVersion: 0,
  installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', installSeq: 1, ...over,
});

export function fakeOperations() {
  const listeners = new Set();
  const ops = [];
  const mods = {};
  const manifests = {};
  let seq = 0;
  const api = {
    started: [],
    startError: null,
    /** resolves after this promise when set (to prove mutations never wait for the op). */
    async start(input) {
      api.started.push(input);
      if (api.startError) throw api.startError;
      const id = `op-${String(++seq).padStart(16, '0')}`;
      const rec = { id, input, outcome: 'running', phases: [], startedAt: new Date(1_000 + seq).toISOString() };
      ops.push(rec);
      return id;
    },
    get: (id) => ops.find((o) => o.id === id),
    list: (f = {}) => ops.filter((o) => (f.modId === undefined || o.input.modId === f.modId) && (f.running === undefined || (o.outcome === 'running') === f.running)),
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    get listenerCount() { return listeners.size; },
    recover: async () => {}, activateAll: async () => {},
    state: () => ({ schemaVersion: 1, mods, safeMode: api.safeMode, ...(api.developerMode ? { developerMode: true } : {}), nextInstallSeq: 10 }),
    safeMode: false,
    developerMode: false,
    async setDeveloperMode(on) { api.developerMode = on; return { developerMode: on }; },
    installed(id) {
      if (!mods[id] || !manifests[id]) return undefined;
      return { record: mods[id], manifest: manifests[id], packageDir: '/x', dataDir: '/d', retainedDir: '/r', backendsDir: '/b' };
    },
    compatibility: (m) => api.compat?.(m) ?? { status: 'compatible', missingRequired: [], missingOptional: [] },
    compat: null,
    orphans: {},
    async orphanedGenerations(id) { return api.orphans[id] ?? []; },
    quarantine() {}, setSafeMode: async () => {}, restoreFromGeneration: async () => ({ restored: [], leftDisabled: [] }),
    // test helpers
    addMod(record, manifest) { mods[record.id] = record; manifests[record.id] = manifest; },
    update(opId, patch) {
      const o = ops.find((x) => x.id === opId);
      Object.assign(o, patch);
      for (const l of [...listeners]) l(structuredClone(o));
    },
    ops,
  };
  return api;
}

export const fakePackages = () => ({
  validateManifest: (m) => m, verify: async () => { throw new Error('unused'); }, store: async () => '', gc: async () => {},
});
export const fakeRuntime = () => ({ status: (id) => (fakeRuntime.active.includes(id) ? 'active' : 'inactive'), active: () => [...fakeRuntime.active] });
fakeRuntime.active = [];
export const fakeRecovery = () => ({ lkgValue: undefined, app: null,
  lkg() { return this.lkgValue; }, appUpdateAvailable() { return this.app; } });
export const fakeMux = () => ({ metrics: () => ({ frames: {}, interceptorCalls: {}, interceptorFaults: {}, latencyMs: { p50: 1, p95: 2 }, backends: [] }) });

export async function makeHarness(over = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cm-'));
  const lay = layout(root, 'p');
  await mkdir(lay.run, { recursive: true, mode: 0o700 });
  const bus = fakeBus();
  const operations = fakeOperations();
  const packages = fakePackages();
  fakeRuntime.active = [];
  const runtime = fakeRuntime();
  const recovery = fakeRecovery();
  const mux = fakeMux();
  const entries = [];
  const mk = () => ({ debug() {}, info() {}, warn: (m, d) => entries.push({ m, d }), error: (m, d) => entries.push({ m, d }), child: mk });
  return { root, layout: lay, bus, operations, packages, runtime, recovery, mux, log: mk('t'), logEntries: entries, ...over };
}

export async function writeFileDeep(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}
