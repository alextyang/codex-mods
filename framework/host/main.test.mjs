// startHost wiring tests with the fake factories (tests/integration/fixtures/fake-factories.mjs).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { layout as makeLayout } from '../../contracts/layout.mjs';
import { startHost, cleanupLeftovers, parsePsLine, sweepRelayFifos } from './main.mjs';
import { createFakeFactories } from '../../tests/integration/fixtures/fake-factories.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(here, '..', '..', 'tests', 'integration', 'fixtures', 'adapter.json');
const FAKE_SERVER = join(here, '..', '..', 'tests', 'fixtures', 'fake-app-server.mjs');

let root, L, adapterDir;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-h-'));
  L = makeLayout(root, 'default');
  adapterDir = join(root, 'adapters', 'test');
  mkdirSync(adapterDir, { recursive: true });
  copyFileSync(ADAPTER, join(adapterDir, 'adapter.json'));
  // The graph is on by default (E6); these fakes build no graph, so the tests that want it remove the off switch.
  mkdirSync(L.flags, { recursive: true });
  writeFileSync(join(L.flags, 'graph-off'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeParent() {
  const listeners = new Set(), posted = [];
  return { posted, post: (m) => posted.push(m), onMessage(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    onClose: () => ({ dispose() {} }), send: (m) => { for (const l of [...listeners]) l(m); }, listeners };
}
const opts = (extra = {}) => ({
  layout: L, profile: { codexHome: join(root, 'ch'), guardStockApp: false, signingIdentity: '-', appPath: '' },
  adapterDir, realCodexPath: FAKE_SERVER, frameworkVersion: 'fw-test', appBuild: '1-2', safeMode: false, ...extra,
});
const tick = () => new Promise((r) => setTimeout(r, 20));

test('creation order, startup order, and close() reverses it', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  factories.watchAppSocket(L);
  const parent = fakeParent();
  const origPost = parent.post;
  parent.post = (m) => { rec.push(`post:${m.type}`); origPost(m); };
  const host = await startHost(opts({ factories, parent }));
  assert.deepEqual(rec, [
    'createBus', 'createMux', 'createRuntime', 'mux.setLeaseServiceHandler', 'createPackages', 'createRecovery', 'createOperations', 'createManagement',
    'recovery.beginBoot',
    'operations.recover', 'operations.recover:app.sock=false',
    'management.listen', 'management.listen:app.sock=true',
    'operations.activateAll',
    'post:breadcrumbs', 'post:ready', 'recovery.report:host-ready',
  ]);
  assert.ok(existsSync(join(L.run, 'app.sock')) && existsSync(join(L.run, 'mgmt.sock')));
  assert.equal(readFileSync(join(L.run, 'mgmt.token'), 'utf8').trim(), 'fake-token');
  rec.length = 0;
  await host.close();
  assert.deepEqual(rec, ['management.dispose', 'runtime.close', 'runtime.close:app.sock=false', 'mux.close', 'mux.close:app.sock=false']);
  assert.ok(!existsSync(join(L.run, 'app.sock')), 'app.sock removed');
  await host.close();   // idempotent
});

test('the adapter protocol feeds the mux and log goes to layout.logs/host.log', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories }));
  const { opts: muxOpts } = factories.calls.mux;
  assert.equal(muxOpts.catalog.handshake.request, 'initialize');
  assert.equal(muxOpts.clientsSocketPath, join(L.run, 'clients.sock'));
  assert.equal(factories.calls.recovery.opts.adapterVersion, '0.0.0-test');
  assert.equal(factories.calls.packages.opts.frameworkVersion, 'fw-test');
  await host.close();
  assert.match(readFileSync(join(L.logs, 'host.log'), 'utf8'), /"msg":"host starting"/);
});

test('launchFor: primary uses the real codex path, the profile CODEX_HOME and the generation marker; named backends live under layout.backends', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories }));
  const { launchFor } = factories.calls.mux.opts;
  const p = launchFor('primary');
  assert.equal(p.command, FAKE_SERVER);
  assert.deepEqual(p.args, ['app-server']);
  assert.equal(p.codexHome, join(root, 'ch'));
  assert.equal(p.env.CODEX_HOME, join(root, 'ch'));
  assert.equal(p.env.CODEX_MODS_GENERATION, '7');
  const sess = launchFor('primary', undefined, { argv: ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'] });
  assert.deepEqual(sess.args, ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'], 'the app argv is used verbatim');
  assert.equal(sess.command, FAKE_SERVER); assert.equal(sess.env.CODEX_HOME, join(root, 'ch'));
  // Mux addition 9: with the app's environment (relay header v2) the launch env is only the overlay: CODEX_HOME and the markers.
  const withApp = launchFor('primary', undefined, { argv: ['app-server'], env: { CODEX_MCP_NODE_PATH: '/copy/node', CODEX_HOME: '/app/home' } });
  assert.deepEqual(Object.keys(withApp.env).sort(), ['CODEX_HOME', 'CODEX_MODS_BOOT', 'CODEX_MODS_GENERATION', ...(process.env.CODEX_MODS_RUN_DIR ? ['CODEX_MODS_RUN_DIR'] : [])].sort());
  assert.equal(withApp.env.CODEX_HOME, join(root, 'ch')); assert.equal(withApp.env.CODEX_MODS_GENERATION, '7');
  assert.equal(withApp.env.CODEX_MODS_BOOT, process.env.CODEX_MODS_BOOT);
  const namedWithSession = launchFor('mod:acme.x/work', { codexHome: 'work', args: ['--flag'] }, { argv: ['-c', 'k=v', 'app-server'] });
  assert.deepEqual(namedWithSession.args, ['-c', 'k=v', 'app-server', '--flag']);
  const n = launchFor('mod:acme.x/work', { codexHome: 'work', env: { A: '1' }, args: ['--flag'] });
  assert.equal(n.command, FAKE_SERVER);
  assert.deepEqual(n.args, ['app-server', '--flag']);
  assert.equal(n.codexHome, join(L.backends, 'acme.x', 'work'));
  assert.equal(n.env.A, '1'); assert.equal(n.env.CODEX_HOME, n.codexHome);
  const abs = launchFor('mod:acme.x/w2', { codexHome: join(root, 'elsewhere') });
  assert.equal(abs.codexHome, join(root, 'elsewhere'));
  await host.close();
});

test('stock-app conflict is informational: the primary start is NOT refused; framework/health carries the flag and keeps Recovery\'s health', async () => {
  const factories = createFakeFactories([], { stockAppConflict: true });
  const host = await startHost(opts({ factories }));
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false, 'never refuses');
  assert.deepEqual(host.bus.state('framework/health'), { healthy: false, stockAppConflict: true });
  host.bus.publish('framework/health', { healthy: true, stockAppConflict: true }, { state: true });
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false);
  assert.equal(host.bus.state('framework/health').healthy, true, 'a later session does not flip health back to false');
  await host.close();
});

test('conflict \'unknown\' (inspection failed) is published as such; a thrown inspection is treated as unknown; false publishes nothing', async () => {
  let factories = createFakeFactories([], { stockAppConflict: { conflict: 'unknown', processes: [], error: 'ps: no' } });
  let host = await startHost(opts({ factories }));
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false);
  assert.equal(host.bus.state('framework/health').stockAppConflict, 'unknown');
  await host.close();

  factories = createFakeFactories();
  factories.stockAppConflict = async () => { throw new Error('ps failed'); };
  host = await startHost(opts({ factories }));
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false);
  assert.equal(host.bus.state('framework/health').stockAppConflict, 'unknown');
  await host.close();

  factories = createFakeFactories([], { stockAppConflict: { conflict: false, processes: [] } });
  host = await startHost(opts({ factories }));
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false);
  assert.equal(host.bus.state('framework/health'), undefined);
  await host.close();
});

test('runningAppPath from framework-main is handed to Recovery', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories, runningAppPath: '/Apps/ChatGPT Mods.app' }));
  assert.equal(factories.calls.recovery.opts.runningAppPath, '/Apps/ChatGPT Mods.app');
  await host.close();
  const f2 = createFakeFactories();
  const h2 = await startHost(opts({ factories: f2 }));
  assert.equal('runningAppPath' in f2.calls.recovery.opts, false);
  await h2.close();
});

test('no conflict: beforePrimaryStart resolves false and publishes nothing', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories }));
  assert.equal(await factories.calls.mux.opts.beforePrimaryStart(), false);
  assert.equal(host.bus.state('framework/health'), undefined);
  await host.close();
});

test('lease services are routed to the runtime', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories }));
  const r = await factories.calls.mux.leaseHandler('mod:a', { name: 'svc', method: 'm', args: [] });
  assert.deepEqual(r, { owner: 'mod:a', call: { name: 'svc', method: 'm', args: [] } });
  await host.close();
});

test('rankOf binds lazily to Operations: the user\'s order, else installSeq; unknown mods rank last; onQuarantine reaches Operations', async () => {
  const rec = [];
  const state = { schemaVersion: 1, mods: { 'a.b': { installSeq: 4 }, 'c.d': { installSeq: 9, order: 1 } }, safeMode: false, nextInstallSeq: 10 };
  const factories = createFakeFactories(rec, { state });
  const host = await startHost(opts({ factories }));
  const ro = factories.calls.runtime.opts;
  assert.equal(ro.rankOf('a.b'), 4);
  assert.equal(ro.rankOf('c.d'), 1, 'its place in the user\'s order (E6)');
  assert.equal(ro.rankOf('zzz'), Number.MAX_SAFE_INTEGER);
  ro.onQuarantine('a.b', 'faulty');
  assert.ok(rec.includes('operations.quarantine:a.b:faulty'));
  await host.close();
});

test('safe mode skips activateAll', async () => {
  const rec = [];
  const host = await startHost(opts({ factories: createFakeFactories(rec), safeMode: true }));
  assert.ok(!rec.includes('operations.activateAll'));
  assert.ok(rec.includes('operations.recover'));
  await host.close();
});

test('MainToHost: window, health and recovery messages', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  const events = [];
  host.bus.subscribe('window/*', (d, t) => events.push([t, d]));
  parent.send({ type: 'window', event: 'created', windowId: 5 });
  // the window itself (graph-integrity G5.5): its bounds and title go along; bounds that are not numbers do not
  parent.send({ type: 'window', event: 'bounds', windowId: 5, bounds: { x: 1, y: 2, width: 800, height: 600, extra: true } });
  parent.send({ type: 'window', event: 'title', windowId: 5, title: 'Codex' });
  parent.send({ type: 'window', event: 'bounds', windowId: 5, bounds: { x: 'a', y: 2, width: 800, height: 600 } });
  parent.send({ type: 'window', event: 'closed', windowId: 5 });
  parent.send({ type: 'health', signal: 'window-rendered' });
  parent.send({ type: 'recovery', action: 'lkg-restore' });
  await tick();
  assert.deepEqual(events, [['window/created', { windowId: 5 }], ['window/bounds', { windowId: 5, bounds: { x: 1, y: 2, width: 800, height: 600 } }],
    ['window/title', { windowId: 5, title: 'Codex' }], ['window/bounds', { windowId: 5 }], ['window/closed', { windowId: 5 }]]);
  assert.ok(rec.includes('recovery.report:window-rendered'));
  assert.deepEqual(factories.calls.operations.started, [{ type: 'lkg-restore' }]);
  await host.close();
});

test('realm bridging: the first renderer message opens handleRealm; replies travel back as realm envelopes', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: { t: 'call', id: 1 } });
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: { t: 'call', id: 2 } });
  const [realm] = factories.calls.runtime.realms;
  assert.equal(factories.calls.runtime.realms.length, 1, 'one RealmPort per (window, channel)');
  assert.deepEqual([realm.realm, realm.identity], ['renderer', { windowId: 5 }]);
  assert.deepEqual(realm.received, [{ t: 'call', id: 1 }, { t: 'call', id: 2 }]);
  realm.port.post({ t: 'result', id: 1 });
  assert.deepEqual(parent.posted.at(-1), { type: 'realm', windowId: 5, channel: 'renderer', data: { t: 'result', id: 1 } });
  await host.close();
});

test('realm bridging: management channel goes to management.attach; windows and channels are independent', async () => {
  const factories = createFakeFactories();
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  parent.send({ type: 'realm', windowId: 5, channel: 'management', data: { id: 1, method: 'x' } });
  parent.send({ type: 'realm', windowId: 6, channel: 'renderer', data: {} });
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: {} });
  assert.equal(factories.calls.management.attached.length, 1);
  assert.deepEqual(factories.calls.management.attached[0].received, [{ id: 1, method: 'x' }]);
  assert.deepEqual(factories.calls.runtime.realms.map((r) => r.identity.windowId), [6, 5]);
  await host.close();
});

test('realm-close disposes the realm and fires onClose; a later message opens a fresh one (page reload)', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: 1 });
  const first = factories.calls.runtime.realms[0];
  let closed = 0; first.port.onClose(() => closed++);
  parent.send({ type: 'realm-close', windowId: 5, channel: 'renderer' });
  assert.equal(closed, 1); assert.ok(rec.includes('runtime.realm.dispose'));
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: 2 });
  assert.equal(factories.calls.runtime.realms.length, 2);
  assert.deepEqual(factories.calls.runtime.realms[1].received, [2]);
  assert.deepEqual(first.received, [1], 'the old realm gets nothing more');
  parent.send({ type: 'realm-close', windowId: 5, channel: 'renderer' });
  parent.send({ type: 'realm-close', windowId: 5, channel: 'renderer' });   // idempotent
  await host.close();
});

test('a closed window closes its realms; Host close disposes the rest', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  parent.send({ type: 'realm', windowId: 5, channel: 'renderer', data: 1 });
  parent.send({ type: 'realm', windowId: 5, channel: 'management', data: 1 });
  parent.send({ type: 'realm', windowId: 6, channel: 'renderer', data: 1 });
  parent.send({ type: 'window', event: 'closed', windowId: 5 });
  assert.equal(rec.filter((x) => x === 'runtime.realm.dispose').length, 1);
  assert.equal(rec.filter((x) => x === 'management.detach').length, 1);
  await host.close();
  assert.equal(rec.filter((x) => x === 'runtime.realm.dispose').length, 2);
});

test('createManagement gets appBuild and adapterVersion', async () => {
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories }));
  assert.equal(factories.calls.management.opts.appBuild, '1-2');
  assert.equal(factories.calls.management.opts.adapterVersion, '0.0.0-test');
  await host.close();
});

test('two Host crashes (hostCrashCount >= 2): breadcrumbed mods are quarantined as host-crash before activateAll, then count and breadcrumbs reset', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  mkdirSync(L.flags, { recursive: true });
  writeFileSync(join(L.flags, 'boot.json'), JSON.stringify({ generation: 3, startedAt: 't', state: 'booting', unhealthyCount: 0, breadcrumbs: ['a.b', 'c.d'], hostCrashCount: 2, lastHostCrashAt: new Date().toISOString() }));
  const host = await startHost(opts({ factories }));
  const q = rec.filter((x) => x.startsWith('operations.quarantine'));
  assert.deepEqual(q, ['operations.quarantine:a.b:host-crash', 'operations.quarantine:c.d:host-crash']);
  assert.ok(rec.indexOf(q[1]) < rec.indexOf('operations.activateAll'));
  assert.ok(rec.indexOf('recovery.beginBoot') < rec.indexOf(q[0]));
  const marker = JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8'));
  assert.equal(marker.breadcrumbs, undefined); assert.equal(marker.hostCrashCount, 0); assert.equal(marker.generation, 3);
  await host.close();
  rec.length = 0;
  const host2 = await startHost(opts({ factories: createFakeFactories(rec) }));
  assert.deepEqual(rec.filter((x) => x.startsWith('operations.quarantine')), [], 'not quarantined again on the next boot');
  await host2.close();
});

test('one Host crash (hostCrashCount 1): nothing is quarantined and the history is kept', async () => {
  const rec = [];
  mkdirSync(L.flags, { recursive: true });
  const marker0 = { state: 'booting', unhealthyCount: 0, breadcrumbs: ['a.b'], hostCrashCount: 1, lastHostCrashAt: new Date().toISOString() };
  writeFileSync(join(L.flags, 'boot.json'), JSON.stringify(marker0));
  const host = await startHost(opts({ factories: createFakeFactories(rec) }));
  assert.deepEqual(rec.filter((x) => x.startsWith('operations.quarantine')), []);
  const m = JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8'));
  assert.deepEqual(m.breadcrumbs, ['a.b']); assert.equal(m.hostCrashCount, 1);
  await host.close();
});

test('repeated crashes quarantine even in safe mode (activateAll skipped)', async () => {
  const rec = [];
  mkdirSync(L.flags, { recursive: true });
  writeFileSync(join(L.flags, 'boot.json'), JSON.stringify({ state: 'booting', unhealthyCount: 0, breadcrumbs: ['a.b'], hostCrashCount: 3 }));
  const host = await startHost(opts({ factories: createFakeFactories(rec), safeMode: true }));
  assert.ok(rec.includes('operations.quarantine:a.b:host-crash'));
  assert.ok(!rec.includes('operations.activateAll'));
  await host.close();
});

test('announceRenderer posts the full module map', async () => {
  const factories = createFakeFactories();
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  const { announceRenderer } = factories.calls.runtime.opts;
  announceRenderer('a.b', { packageDir: '/p/a', entry: 'r.js', rev: '1' });
  announceRenderer('c.d', { packageDir: '/p/c', entry: 'r.js', rev: '2' });
  announceRenderer('a.b', null);
  const maps = parent.posted.filter((m) => m.type === 'renderer-modules').map((m) => m.modules);
  assert.deepEqual(maps.at(-3), [{ modId: 'a.b', packageDir: '/p/a', entry: 'r.js', rev: '1' }]);
  assert.deepEqual(maps.at(-2).map((m) => m.modId), ['a.b', 'c.d']);
  assert.deepEqual(maps.at(-1), [{ modId: 'c.d', packageDir: '/p/c', entry: 'r.js', rev: '2' }]);
  await host.close();
});

test('breadcrumbs follow runtime.active() on framework/op and framework/quarantine, without duplicates', async () => {
  const factories = createFakeFactories();
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  const crumbs = () => parent.posted.filter((m) => m.type === 'breadcrumbs').map((m) => m.mods);
  assert.deepEqual(crumbs(), [[]]);
  factories.calls.runtime.active = ['a.b'];
  host.bus.publish('framework/op', { id: 'op-1' });
  host.bus.publish('framework/op', { id: 'op-1' });
  factories.calls.runtime.active = ['a.b', 'c.d'];
  host.bus.publish('framework/op', { id: 'op-2' });
  factories.calls.runtime.active = ['c.d'];
  host.bus.publish('framework/quarantine', { modId: 'a.b', reason: 'x' });
  assert.deepEqual(crumbs(), [[], ['a.b'], ['a.b', 'c.d'], ['c.d']]);
  await host.close();
});

test('recovery.requestExit becomes an exit message', async () => {
  const factories = createFakeFactories();
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  factories.calls.recovery.opts.requestExit({ relaunch: false, reason: 'app-switch' });
  assert.deepEqual(parent.posted.at(-1), { type: 'exit', relaunch: false, reason: 'app-switch' });
  await host.close();
});

test('shutdown from framework-main closes the Host', async () => {
  const rec = [];
  const parent = fakeParent();
  await startHost(opts({ factories: createFakeFactories(rec), parent }));
  parent.send({ type: 'shutdown' });
  await tick(); await tick();
  assert.ok(rec.includes('mux.close') && rec.includes('runtime.close'));
  assert.ok(!existsSync(join(L.run, 'app.sock')));
});

test('app.sock connections go to mux.attachApp', async () => {
  const rec = [];
  const host = await startHost(opts({ factories: createFakeFactories(rec) }));
  const c = createConnection(join(L.run, 'app.sock'));
  await new Promise((r) => c.once('connect', r));
  await tick();
  assert.ok(rec.includes('mux.attachApp'));
  c.destroy();
  await host.close();
});

test('a missing adapter fails the start and cleans up', async () => {
  const rec = [];
  await assert.rejects(startHost(opts({ factories: createFakeFactories(rec), adapterDir: join(root, 'adapters', 'nope') })), (e) => e.code === 'Unavailable');
  assert.ok(!rec.includes('createMux'));
});

test('a failing startup step closes what was already created, in reverse', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const orig = factories.createRecovery;
  factories.createRecovery = (o) => { const r = orig(o); r.beginBoot = async () => { throw new Error('boot fail'); }; return r; };
  await assert.rejects(startHost(opts({ factories })), /boot fail/);
  assert.deepEqual(rec.filter((x) => x.endsWith('.close')), ['runtime.close', 'mux.close']);
});

test('a live Host on the same run dir is a Conflict and does not disturb it', async () => {
  const f1 = createFakeFactories();
  const h1 = await startHost(opts({ factories: f1 }));
  await assert.rejects(startHost(opts({ factories: createFakeFactories() })), (e) => e.code === 'Conflict');
  assert.ok(existsSync(join(L.run, 'app.sock')), 'the first Host keeps its socket');
  await h1.close();
});

const RUN = '/Users/u/Library/Application Support/CodexMods/profiles/default/run';
const psLine = (pid, cmd, env) => `${String(pid).padStart(6)} ${cmd} USER=u HOME=/Users/u ${env} PWD=/x`;
const mark = (boot, run = RUN) => `CODEX_MODS_BOOT=${boot} CODEX_MODS_RUN_DIR=${run}`;

test('parsePsLine: both markers required; run dir with spaces; boot must be hex', () => {
  const l = parsePsLine(psLine(10, '/x/codex -c a=b app-server', mark('ab12cd34ef567890')));
  assert.deepEqual([l.pid, l.boot, l.runDir], [10, 'ab12cd34ef567890', RUN]);
  assert.equal(parsePsLine(psLine(11, '/x/node', 'CODEX_MODS_BOOT=ab12')), null);
  assert.equal(parsePsLine(psLine(12, '/x/node', `CODEX_MODS_RUN_DIR=${RUN}`)), null);
  assert.equal(parsePsLine(psLine(13, '/x/node', mark('zz'))), null);
  assert.equal(parsePsLine(psLine(15, '/x/node', `CODEX_MODS_GENERATION=3 CODEX_MODS_RUN_DIR=${RUN}`)), null, 'the generation marker alone no longer identifies anything');
  assert.equal(parsePsLine('garbage'), null);
  assert.equal(parsePsLine(`  14 /x/codex CODEX_MODS_BOOT=aa CODEX_MODS_RUN_DIR=${RUN}`).runDir, RUN, 'run dir as the final variable');
});

test('cleanupLeftovers signals only processes with BOTH markers, another boot id and this run dir, after a second identity check', async () => {
  const table = [
    psLine(100, '/x/codex app-server', mark('aaaa')),                                  // leftover
    psLine(101, '/x/node mod.js', mark('bbbb')),                                       // leftover
    psLine(102, '/x/codex app-server', mark('cccc')),                                  // current boot
    psLine(103, '/x/codex app-server', mark('aaaa', '/other/run')),                    // another profile
    psLine(104, '/x/codex app-server', 'CODEX_MODS_BOOT=aaaa'),                        // one marker only
    psLine(105, '/x/codex app-server', `CODEX_MODS_RUN_DIR=${RUN}`),                   // one marker only
    psLine(106, '/usr/bin/vim notes.txt', 'EDITOR=vim'),                               // unrelated
    psLine(process.pid, 'node host', mark('aaaa')),                                    // myself
    psLine(process.ppid, 'node main', mark('aaaa')),                                   // my parent
  ].join('\n');
  const killed = [];
  const r = await cleanupLeftovers({ currentBoot: 'cccc', runDir: RUN, uid: 501, ps: async (uid) => { assert.equal(uid, 501); return table; }, kill: (pid, sig) => killed.push([pid, sig]) });
  assert.deepEqual(r.found.map((x) => x.pid).sort(), [100, 101]);
  assert.deepEqual(killed.sort(), [[100, 'SIGTERM'], [101, 'SIGTERM']]);
  assert.deepEqual(r.signalled.sort(), [100, 101]);
});

test('cleanupLeftovers: a leftover of an UNCHANGED boot (same generation number) is still found, because only the boot id decides', async () => {
  const table = [psLine(110, '/x/codex app-server', `CODEX_MODS_GENERATION=7 ${mark('1111')}`)].join('\n');
  const killed = [];
  await cleanupLeftovers({ currentBoot: '2222', runDir: RUN, ps: async () => table, kill: (pid) => killed.push(pid) });
  assert.deepEqual(killed, [110]);
});

test('cleanupLeftovers: a pid whose command or environment changed between the two scans is not signalled', async () => {
  const scans = [
    [psLine(200, '/x/codex app-server', mark('aaaa')), psLine(201, '/x/codex app-server', mark('aaaa')), psLine(202, '/x/codex app-server', mark('aaaa'))],
    [psLine(200, '/x/other-program', mark('aaaa')),                                            // pid reused by another program
     psLine(201, '/x/codex app-server', mark('cccc')),                                         // environment no longer matches
     /* 202 vanished */],
  ];
  let n = 0;
  const killed = [];
  const r = await cleanupLeftovers({ currentBoot: 'cccc', runDir: RUN, ps: async () => scans[Math.min(n++, 1)].join('\n'), kill: (pid) => killed.push(pid) });
  assert.equal(r.found.length, 3);
  assert.deepEqual(killed, []);
});

test('cleanupLeftovers never throws: ps failure and kill failure are tolerated', async () => {
  assert.deepEqual(await cleanupLeftovers({ currentBoot: 'x', runDir: RUN, ps: async () => { throw new Error('no ps'); } }), { found: [], signalled: [] });
  const line = psLine(300, '/x/codex', mark('aaaa'));
  const r = await cleanupLeftovers({ currentBoot: 'bbbb', runDir: RUN, ps: async () => line, kill: () => { throw new Error('EPERM'); } });
  assert.deepEqual(r.signalled, []); assert.equal(r.found.length, 1);
});

test('startHost sets a fresh CODEX_MODS_BOOT (16 hex) per start, inherited by backend launches; it reports and signals the previous boot\'s leftovers on framework/leftovers; a failing ps never blocks the boot', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const killed = [];
  let currentBoot;
  const table = () => [psLine(400, '/x/codex app-server', mark('00000000deadbeef', L.run)), psLine(401, '/x/codex app-server', mark(currentBoot, L.run))].join('\n');
  const seen = [];
  const o = opts({ factories, ps: async () => { currentBoot = process.env.CODEX_MODS_BOOT; return table(); }, killProcess: (pid, sig) => killed.push([pid, sig]) });
  const bus = factories.createBus;
  factories.createBus = (x) => { const b = bus(x); b.subscribe('framework/leftovers', (d) => seen.push(d)); return b; };
  const host = await startHost(o);
  assert.match(currentBoot, /^[0-9a-f]{16}$/);
  assert.deepEqual(killed, [[400, 'SIGTERM']]);
  assert.deepEqual(seen, [{ found: [{ pid: 400 }], signalled: [400] }]);
  assert.equal(factories.calls.mux.opts.launchFor('primary').env.CODEX_MODS_BOOT, currentBoot, 'children inherit the boot id');
  assert.ok(rec.indexOf('recovery.beginBoot') < rec.indexOf('operations.recover'));
  await host.close();

  const host2 = await startHost(opts({ factories: createFakeFactories(), ps: async () => { throw new Error('ps broke'); } }));
  assert.notEqual(process.env.CODEX_MODS_BOOT, currentBoot, 'a new start gets a new boot id');
  await host2.close();
});

test('an adapter directory that holds codexmods-adapter.json (the copy\'s embedded adapter) is accepted', async () => {
  const dir = join(root, 'Resources');
  mkdirSync(dir, { recursive: true });
  copyFileSync(ADAPTER, join(dir, 'codexmods-adapter.json'));
  const factories = createFakeFactories();
  const host = await startHost(opts({ factories, adapterDir: dir }));
  assert.equal(factories.calls.recovery.opts.adapterVersion, '0.0.0-test');
  await host.close();
});

test('createRecovery gets activeMods and gcPackages (operations.gcStore, no arguments) wired', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  const host = await startHost(opts({ factories }));
  const o = factories.calls.recovery.opts;
  factories.calls.runtime.active = ['a.b'];
  assert.deepEqual(o.activeMods(), ['a.b']);
  const r = await o.gcPackages();
  assert.deepEqual(r, { removed: [] }); assert.equal(o.gcPackages.length, 0, 'takes no arguments');
  assert.ok(rec.includes('operations.gcStore'));
  await host.close();
});

test('framework/health {healthy:true} triggers operations.reconcileFramework exactly once; unhealthy and stockAppConflict-only reports do not', async () => {
  const rec = [];
  const host = await startHost(opts({ factories: createFakeFactories(rec), ps: async () => '' }));
  const count = () => rec.filter((x) => x === 'operations.reconcileFramework').length;
  host.bus.publish('framework/health', { healthy: false, stockAppConflict: true }, { state: true });
  host.bus.publish('framework/health', { healthy: false }, { state: true });
  await tick();
  assert.equal(count(), 0);
  host.bus.publish('framework/health', { healthy: true }, { state: true });
  host.bus.publish('framework/health', { healthy: true }, { state: true });
  await tick();
  assert.equal(count(), 1);
  host.bus.publish('framework/health', { healthy: false }, { state: true });
  host.bus.publish('framework/health', { healthy: true }, { state: true });
  await tick();
  assert.equal(count(), 1, 'once per Host start');
  await host.close();
});

test('a reconcileFramework failure is logged and does not disturb the Host', async () => {
  const rec = [];
  const host = await startHost(opts({ factories: createFakeFactories(rec, { reconcileThrows: true }), ps: async () => '' }));
  host.bus.publish('framework/health', { healthy: true }, { state: true });
  await tick();
  assert.match(readFileSync(join(L.logs, 'host.log'), 'utf8'), /reconcileFramework failed.*reconcile boom/);
  await host.close();
});

test('stale relay-<pid>.fifo files of dead relays are removed at Host start; live ones and other files stay', async () => {
  const { execSync } = await import('node:child_process');
  mkdirSync(L.run, { recursive: true });
  const dead = join(L.run, 'relay-999991.fifo'), live = join(L.run, `relay-${process.pid}.fifo`), other = join(L.run, 'notes.txt');
  for (const f of [dead, live]) execSync(`mkfifo '${f}'`);
  writeFileSync(other, 'x');
  assert.deepEqual(sweepRelayFifos(L.run, (pid) => pid === process.pid), ['relay-999991.fifo']);
  assert.ok(!existsSync(dead) && existsSync(live) && existsSync(other));
  execSync(`mkfifo '${dead}'`);
  const host = await startHost(opts({ factories: createFakeFactories(), ps: async () => '' }));
  assert.ok(existsSync(live), 'a live pid is never touched'); await host.close();
});

// ---- v1.20: primaryConfig from adapter.backend.configOverrides
const writePack = (patchBackend) => {
  const pack = JSON.parse(readFileSync(ADAPTER, 'utf8'));
  pack.backend = { ...pack.backend, ...patchBackend };
  writeFileSync(join(adapterDir, 'adapter.json'), JSON.stringify(pack));
};
test('createMux gets primaryConfig only when the pack has configOverrides; vars come from configOverrideVars', async () => {
  let f = createFakeFactories();
  let host = await startHost(opts({ factories: f }));
  assert.equal('primaryConfig' in f.calls.mux.opts, false, 'no overrides: nothing passed');
  await host.close();

  writePack({ configOverrides: {} });
  f = createFakeFactories(); host = await startHost(opts({ factories: f }));
  assert.equal('primaryConfig' in f.calls.mux.opts, false, 'an empty map passes nothing either');
  await host.close();

  writePack({ configOverrides: { notify: ['${relayPath}'], 'features.x': true, home: '${codexHome}' } });
  f = createFakeFactories(); host = await startHost(opts({ factories: f, runningAppPath: '/Apps/ChatGPT Mods.app' }));
  const pc = f.calls.mux.opts.primaryConfig;
  assert.deepEqual(pc.overrides, { notify: ['${relayPath}'], 'features.x': true, home: '${codexHome}' });
  assert.equal(pc.vars.relayPath, '/Apps/ChatGPT Mods.app/Contents/Resources/codexmods-relay');
  assert.equal(pc.vars.resources, '/Apps/ChatGPT Mods.app/Contents/Resources');
  assert.equal(pc.vars.codexHome, join(root, 'ch')); assert.equal(pc.vars.profileDir, L.profileDir); assert.equal(pc.vars.computerUseDir, L.computerUse);
  await host.close();
});

test('the graph runtime starts by default: its journal first, handed to the mux; the native types and the codex source; close reverses it', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  let muxOpts;
  const createMux = factories.createMux;
  factories.createMux = (o) => { muxOpts = o; return createMux(o); };
  const journal = { close: () => rec.push('journal.close') };
  factories.openJournal = (file) => { rec.push(`openJournal:${file === join(L.graph, 'intents.jsonl')}`); return journal; };
  factories.nativeTypes = () => [{ id: 'X' }];
  factories.createGraph = (o) => { rec.push(`createGraph:${o.journal === journal}`); graphMade = { registerTypes: (d, owner) => rec.push(`registerTypes:${d.length}:${owner}`), close: () => rec.push('graph.close') }; return graphMade; };
  factories.createCodexSource = (o) => { rec.push(`createCodexSource:${!!o.mux}:${!!o.bus}`); return { dispose: async () => { rec.push('codex.dispose'); } }; };
  let runtimeOpts, graphMade = null;
  let appOpsOpts;
  factories.createAppOps = (o) => { appOpsOpts = o; rec.push('createAppOps'); return { dispose: async () => { rec.push('appOps.dispose'); } }; };
  const createRuntime = factories.createRuntime;
  factories.createRuntime = (o) => { runtimeOpts = o; return createRuntime(o); };
  rmSync(join(L.flags, 'graph-off'), { force: true });
  const host = await startHost(opts({ factories }));
  assert.equal(muxOpts.journal, journal, 'the mux claims other clients\' requests in the same journal (addition 8)');
  assert.ok(rec.indexOf('openJournal:true') >= 0 && rec.indexOf('openJournal:true') < rec.indexOf('createMux'));
  assert.ok(rec.includes('createGraph:true') && rec.includes('registerTypes:1:native') && rec.includes('createCodexSource:true:true'));
  // The framework's own types (docs/graph/07) are registered with the native ones; its provider starts once management exists (S3).
  assert.ok(rec.includes('registerTypes:1:framework') && rec.indexOf('createFrameworkSource') > rec.indexOf('createManagement'));
  assert.ok(rec.includes('registerTypes:1:native') && rec.includes('createWindowsSource'), 'the presentation types and the windows provider (systems.md S10)');
  assert.equal(factories.calls.runtime.opts.windows, factories.calls.windows, 'the runtime\'s windows are the provider\'s');
  assert.ok(factories.calls.frameworkSource.graph && typeof factories.calls.frameworkSource.management?.handle === 'function');
  // Mods reach the graph through the runtime; the app-operation bridge (C4) gets the graph and the mux.
  assert.equal(runtimeOpts.graph, graphMade);
  assert.ok(appOpsOpts.graph === graphMade && appOpsOpts.mux, 'the app-operation bridge (C4) gets the graph and the mux');
  rec.length = 0;
  await host.close();
  const at = (x) => rec.indexOf(x);
  assert.ok(at('appOps.dispose') >= 0 && at('appOps.dispose') < at('runtime.close'), 'held operations are released before the mods stop');
  assert.ok(at('codex.dispose') >= 0 && at('codex.dispose') < at('graph.close') && at('graph.close') < at('mux.close') && at('mux.close') < at('journal.close'), rec.join(' '));
});

test('V12: with the graph on the Host has the app\'s read-state store: the codex source gets it, framework-main\'s reports reach it and its writes go back as read-state-set', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  factories.openJournal = () => ({ close() {} });
  factories.nativeTypes = () => [];
  factories.createGraph = () => ({ registerTypes() {}, close() {} });
  let rsOpts, codexOpts;
  const store = { applied: [], disposed: 0, apply(m) { this.applied.push(m); }, dispose() { this.disposed++; rec.push('readState.dispose'); } };
  factories.createReadState = (o) => { rsOpts = o; rec.push('createReadState'); return store; };
  factories.createCodexSource = (o) => { codexOpts = o; rec.push('createCodexSource'); return { dispose: async () => { rec.push('codex.dispose'); } }; };
  factories.createAppOps = () => ({ dispose: async () => {} });
  rmSync(join(L.flags, 'graph-off'), { force: true });
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  assert.ok(rec.indexOf('createReadState') >= 0 && rec.indexOf('createReadState') < rec.indexOf('createCodexSource'), 'the store exists before its readers');
  assert.equal(codexOpts.readState, store);
  // framework-main's report reaches the store; unrelated messages still go where they went.
  parent.send({ type: 'read-state', available: true, unread: ['a', 'b'], reset: true });
  assert.deepEqual(store.applied, [{ type: 'read-state', available: true, unread: ['a', 'b'], reset: true }]);
  // The store's writes go to framework-main.
  rsOpts.send({ type: 'read-state-set', id: 'x-1', threadId: 'a', unread: false });
  assert.deepEqual(parent.posted.at(-1), { type: 'read-state-set', id: 'x-1', threadId: 'a', unread: false });
  rec.length = 0;
  await host.close();
  assert.equal(store.disposed, 1);
  assert.ok(rec.indexOf('codex.dispose') < rec.indexOf('readState.dispose'), 'the readers close before the store: ' + rec.join(' '));
});

test('D3: with the graph on the Host has the app\'s projects store: the codex source gets it, framework-main\'s reports and answers reach it and its operations go to framework-main', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  factories.openJournal = () => ({ close() {} });
  factories.nativeTypes = () => [];
  factories.createGraph = () => ({ registerTypes() {}, close() {} });
  let apOpts, codexOpts;
  const store = { applied: [], settled: [], disposed: 0, apply(m) { this.applied.push(m); }, settle(m) { this.settled.push(m); }, dispose() { this.disposed++; rec.push('appProjects.dispose'); } };
  factories.createAppProjects = (o) => { apOpts = o; rec.push('createAppProjects'); return store; };
  factories.createCodexSource = (o) => { codexOpts = o; rec.push('createCodexSource'); return { dispose: async () => { rec.push('codex.dispose'); } }; };
  factories.createAppOps = () => ({ dispose: async () => {} });
  rmSync(join(L.flags, 'graph-off'), { force: true });
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  assert.ok(rec.indexOf('createAppProjects') >= 0 && rec.indexOf('createAppProjects') < rec.indexOf('createCodexSource'), 'the store exists before its reader');
  assert.equal(codexOpts.appProjects, store);
  parent.send({ type: 'projects', available: true, projects: [], reset: true });
  parent.send({ type: 'app-op-done', requestId: 'r1', ok: true });
  assert.deepEqual([store.applied, store.settled], [[{ type: 'projects', available: true, projects: [], reset: true }], [{ type: 'app-op-done', requestId: 'r1', ok: true }]]);
  apOpts.send({ type: 'app-op', requestId: 'r2', op: 'reveal', projectId: 'p1' });
  assert.deepEqual(parent.posted.at(-1), { type: 'app-op', requestId: 'r2', op: 'reveal', projectId: 'p1' });
  rec.length = 0;
  await host.close();
  assert.equal(store.disposed, 1);
  assert.ok(rec.indexOf('codex.dispose') < rec.indexOf('appProjects.dispose'), 'the reader closes before the store: ' + rec.join(' '));
});

test('R17: with the graph on the graph gets the approvals service; its prompts go to framework-main and the answers come back to it', async () => {
  const factories = createFakeFactories([]);
  factories.openJournal = () => ({ close() {} });
  factories.nativeTypes = () => [];
  let graphOpts, apOpts;
  factories.createGraph = (o) => { graphOpts = o; return { registerTypes() {}, close() {} }; };
  const store = { settled: [], disposed: 0, settle(m) { this.settled.push(m); }, dispose() { this.disposed++; } };
  factories.createApprovals = (o) => { apOpts = o; return store; };
  factories.createCodexSource = () => ({ dispose: async () => {} });
  factories.createAppOps = () => ({ dispose: async () => {} });
  rmSync(join(L.flags, 'graph-off'), { force: true });
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  assert.equal(graphOpts.approvals, store);
  assert.equal(apOpts.nameOf('mod.unknown'), 'mod.unknown', 'a mod the runtime does not know is named by its id');
  apOpts.send({ type: 'approval-ask', requestId: 'r1', message: 'm' });
  assert.deepEqual(parent.posted.at(-1), { type: 'approval-ask', requestId: 'r1', message: 'm' });
  parent.send({ type: 'approval-answer', requestId: 'r1', approved: true });
  assert.deepEqual(store.settled, [{ type: 'approval-answer', requestId: 'r1', approved: true }]);
  await host.close();
  assert.equal(store.disposed, 1);
});

test('V12: with flags/graph-off a read-state report from framework-main is ignored and no store exists', async () => {
  const factories = createFakeFactories();
  factories.createReadState = () => { throw new Error('must not be called'); };
  factories.createAppProjects = () => { throw new Error('must not be called'); };
  const parent = fakeParent();
  const host = await startHost(opts({ factories, parent }));
  assert.doesNotThrow(() => parent.send({ type: 'read-state', available: true, unread: ['a'] }));
  assert.doesNotThrow(() => parent.send({ type: 'projects', available: true, projects: [] }));
  assert.doesNotThrow(() => parent.send({ type: 'app-op-done', requestId: 'r', ok: true }));
  await host.close();
});

test('with flags/graph-off, nothing of the graph runtime is created and the mux gets no journal', async () => {
  const rec = [];
  const factories = createFakeFactories(rec);
  let muxOpts;
  const createMux = factories.createMux;
  factories.createMux = (o) => { muxOpts = o; return createMux(o); };
  factories.createGraph = () => { throw new Error('must not be called'); };
  const host = await startHost(opts({ factories }));
  assert.equal(muxOpts.journal, undefined);
  await host.close();
});

test('E6: a graph that fails while it starts is contained: what it created closes, the Host starts without it and says why', async () => {
  rmSync(join(L.flags, 'graph-off'), { force: true });
  const rec = [];
  const factories = createFakeFactories(rec);
  factories.openJournal = () => ({ close: () => rec.push('journal.close') });
  factories.nativeTypes = () => [{ id: 'X' }];
  factories.createGraph = () => { rec.push('createGraph'); return { registerTypes: (d, owner) => { if (owner === 'framework') throw new Error('a bad type'); }, close: () => rec.push('graph.close') }; };
  factories.createApprovals = () => ({ dispose: () => rec.push('approvals.dispose') });
  factories.createCodexSource = () => { throw new Error('must not be reached'); };
  const host = await startHost(opts({ factories }));
  assert.ok(rec.includes('createGraph') && rec.includes('approvals.dispose') && rec.includes('graph.close'), rec.join(' '));
  assert.ok(!rec.includes('createFrameworkSource'), 'no framework provider without a graph');
  const status = factories.calls.management.opts.graphStatus();
  assert.match(status.failed, /^start: a bad type/);
  assert.equal(factories.calls.runtime.opts.graph, null, 'the runtime gets no graph');
  await host.close();
});
