// Test helpers for the recovery tests. Fakes of the other modules' interfaces live here (never imported from their code).
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readAppBuildSync } from '../support.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout as makeLayout } from '../../../../contracts/layout.mjs';
import { writeJsonAtomic } from '../../fsutil.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';

export async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'cm-recovery-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export function fakeBus() {
  const subs = []; const states = new Map(); const published = [];
  return {
    published,
    publish(topic, data, opts) { published.push({ topic, data, state: !!opts?.state }); if (opts?.state) states.set(topic, data); for (const s of subs) if (s.pattern === topic) s.fn(data, topic); },
    subscribe(pattern, fn, opts) {
      const s = { pattern, fn }; subs.push(s);
      if (opts?.replay === 'state' && states.has(pattern)) fn(states.get(pattern), pattern);
      return { dispose() { subs.splice(subs.indexOf(s), 1); } };
    },
    state: (t) => states.get(t),
  };
}
export const baseAdapter = (over = {}) => ({
  adapterVersion: '1.0.0',
  build: { version: '26.1007.21159', bundleVersion: '20052', asarSha256: 'x', electronVersion: '40.0.0' },
  backend: { codexPath: 'Resources/codex-cli/bin/codex', method: 'replace' },
  asarPackageJson: 'package.json',
  protocol: { handshake: { request: 'initialize', notification: 'initialized' }, affinityKeyPaths: ['params.threadId'], affinityCreators: [],
    methods: { clientRequests: ['thread/start'], clientNotifications: [], serverRequests: [], serverNotifications: [] } },
  transforms: [], anchors: {}, components: {}, react: null, theme: {}, actions: {}, ...over,
});
export const modRecord = (id, over = {}) => ({ id, version: '1.0.0', status: 'enabled', publisher: null, grants: [], dataSchemaVersion: 0,
  installedAt: 't', updatedAt: 't', installSeq: 1, ...over });
export const emptyState = () => ({ schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 });

/** A recovery fixture: temp root, layout, bus, mutable state, fake Operations, recorded exits. */
export async function fixture(over = {}) {
  const t = await tempRoot();
  const layout = makeLayout(t.dir, 'default');
  await mkdir(layout.flags, { recursive: true });
  const state = over.state ?? emptyState();
  const calls = []; const exits = [];
  const operations = {
    async setSafeMode(enter) { calls.push(['setSafeMode', enter]); state.safeMode = enter; },
    async restoreFromGeneration(g) {
      calls.push(['restoreFromGeneration', g.n]);
      Object.assign(state, structuredClone(g.state)); 
      return over.restoreResult ?? { restored: Object.keys(g.state.mods), leftDisabled: [] };
    },
  };
  const bus = fakeBus();
  const log = createTestLog();
  const base = { layout, log, bus, operationsState: () => state, operations: () => operations, requestExit: (o) => exits.push(o),
    appBuild: '26.1007.21159-20052', frameworkVersion: '1.0.0', adapterVersion: '1.0.0', adapter: baseAdapter(), deps: { exitDelayMs: 0, appPid: () => 99999, ...(over.deps ?? {}) } };
  return { ...t, layout, bus, log, state, calls, exits, operations, base: { ...base, ...(over.opts ?? {}) } };
}
export const writeProfile = (layout, over = {}) => writeJsonAtomic(layout.profileConfig,
  { codexHome: layout.codexHome, guardStockApp: false, signingIdentity: '-', appPath: join(layout.root, 'Apps', 'ChatGPT Mods.app'), ...over });

export async function makeApp(path, short, bundle, { extra = '' } = {}) {
  await mkdir(join(path, 'Contents'), { recursive: true });
  await writeFile(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${short}</string><key>CFBundleVersion</key><string>${bundle}</string>${extra}</dict></plist>
`);
}
export async function makeFrameworkTree(dir, { version, marker = 'a' } = {}) {
  await mkdir(join(dir, 'framework', 'main'), { recursive: true });
  await writeFile(join(dir, 'framework', 'main', 'index.cjs'), `module.exports = { start() {}, marker: ${JSON.stringify(marker)} };\n`);
  for (const d of ['builder', 'loader', 'relay']) await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, 'loader', 'loader.cjs'), '// loader\n');
  await writeFile(join(dir, 'relay', 'relay'), '#!/bin/sh\n');
  if (version) await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'codexmods', version }));
}

/** The build-report.json the real builder writes for the inputs on a builder argv (only the fields recovery compares). */
export async function fakeBuildReport(args, inputsHash) {
  const arg = (n) => args[args.indexOf(n) + 1];
  const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
  let stock = { version: '?', bundleVersion: '?' };
  try { const b = readAppBuildSync(arg('--stock')); stock = { version: b.short, bundleVersion: b.bundle }; } catch { /* stock app absent in some tests */ }
  return { complete: true, inputsHash, frameworkVersion: arg('--framework-version'), stock,
    inputs: { adapter: { sha256: await sha(arg('--adapter')) }, loaderSha256: await sha(arg('--loader')), relaySha256: await sha(arg('--relay')) },
    signing: { identity: arg('--identity') } };
}
