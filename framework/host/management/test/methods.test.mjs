import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createManagement } from '../index.mjs';
import { permissionText } from '../methods.mjs';
import { makeHarness, manifestOf, recordOf } from './fakes.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';

async function setup(t, over) {
  const h = await makeHarness(over);
  t.after(() => rm(h.root, { recursive: true, force: true }));
  const { operations, packages, runtime, recovery, mux, bus, log, layout } = h;
  const mgmt = createManagement({ operations, packages, runtime, recovery, mux, bus, log, layout, ...(over?.extra ?? {}) });
  const call = async (method, params) => mgmt.handle({ id: 1, method, params });
  return { h, mgmt, call };
}

const MUTATION_CASES = [
  ['mods.install', { source: '/tmp/a.codexmod', enable: true, dev: false }, { type: 'install', source: '/tmp/a.codexmod', enable: true, dev: false }],
  ['mods.install', { source: '/tmp/dir' }, { type: 'install', source: '/tmp/dir' }],
  ['mods.consent', { modId: 'acme.demo', approve: true, enable: true }, { type: 'consent', modId: 'acme.demo', approve: true, enable: true }],
  ['mods.consent', { modId: 'acme.demo', approve: false }, { type: 'consent', modId: 'acme.demo', approve: false }],
  ['mods.consent', { modId: 'acme.demo', approve: true, enable: true, allow: ['secrets'] }, { type: 'consent', modId: 'acme.demo', approve: true, enable: true, allow: ['secrets'] }],
  ['mods.enable', { modId: 'acme.demo' }, { type: 'enable', modId: 'acme.demo' }],
  ['mods.disable', { modId: 'acme.demo' }, { type: 'disable', modId: 'acme.demo' }],
  ['mods.clearQuarantine', { modId: 'acme.demo' }, { type: 'clear-quarantine', modId: 'acme.demo' }],
  ['mods.update', { modId: 'acme.demo', source: '/tmp/b.codexmod' }, { type: 'update', modId: 'acme.demo', source: '/tmp/b.codexmod' }],
  ['mods.rollback', { modId: 'acme.demo', toVersion: '1.0.0', restoreData: true }, { type: 'rollback', modId: 'acme.demo', toVersion: '1.0.0', restoreData: true }],
  ['mods.remove', { modId: 'acme.demo', deleteData: false }, { type: 'remove', modId: 'acme.demo', deleteData: false }],
  ['mods.reload', { modId: 'acme.demo' }, { type: 'reload', modId: 'acme.demo' }],
  ['mods.setPermission', { modId: 'acme.demo', grant: 'secrets', decision: 'ask' }, { type: 'set-permission', modId: 'acme.demo', grant: 'secrets', decision: 'ask' }],
  ['mods.reattach', { modId: 'acme.demo' }, { type: 'reattach', modId: 'acme.demo' }],
  ['mods.reattach', { modId: 'acme.demo', generation: '2026-10-11T09:30:00.000Z' }, { type: 'reattach', modId: 'acme.demo', generation: '2026-10-11T09:30:00.000Z' }],
  ['updates.framework', { version: '1.1.0', sourceDir: '/tmp/fw' }, { type: 'framework-update', version: '1.1.0', sourceDir: '/tmp/fw' }],
  ['updates.app.prepare', {}, { type: 'app-prepare' }],
  ['updates.apply', { plan: 'a'.repeat(32), anyway: true, consent: ['acme.demo'] }, { type: 'copy-update', plan: 'a'.repeat(32), anyway: true, consent: ['acme.demo'] }],
  ['recovery.safeMode', { enter: true }, { type: 'safe-mode', enter: true }],
  ['recovery.lkg', {}, { type: 'lkg-restore' }],
];

test('every mutation maps 1:1 to operations.start and returns {opId} without waiting for the op', async (t) => {
  const { h, call } = await setup(t);
  for (const [method, params, expected] of MUTATION_CASES) {
    h.operations.started.length = 0;
    const res = await call(method, params);
    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res)}`);
    assert.match(res.result.opId, /^op-/);
    assert.deepEqual(h.operations.started, [expected], method);
    assert.equal(h.operations.get(res.result.opId).outcome, 'running', 'the op is still running when the response is sent');
  }
});

test('mutation errors from Operations cross as {code,message}', async (t) => {
  const { h, call } = await setup(t);
  const { CodexModsError } = await import('../../../../sdk/errors.mjs');
  h.operations.startError = new CodexModsError('Conflict', 'acme.demo already has an operation running');
  const res = await call('mods.enable', { modId: 'acme.demo' });
  assert.deepEqual(res, { id: 1, ok: false, error: { code: 'Conflict', message: 'acme.demo already has an operation running' } });
  h.operations.startError = new Error('boom');
  const res2 = await call('mods.enable', { modId: 'acme.demo' });
  assert.equal(res2.ok, false);
  assert.equal(res2.error.code, 'Unavailable');
  assert.match(res2.error.message, /boom/);
});

test('params are validated with precise messages', async (t) => {
  const { h, call } = await setup(t);
  const bad = async (method, params, pattern) => {
    const res = await call(method, params);
    assert.equal(res.ok, false, `${method} ${JSON.stringify(params)}`);
    assert.equal(res.error.code, 'Invalid');
    assert.match(res.error.message, pattern);
  };
  await bad('mods.enable', {}, /mods\.enable: params\.modId is required/);
  await bad('mods.enable', { modId: 5 }, /params\.modId must be a mod id/);
  await bad('mods.enable', { modId: '../etc' }, /params\.modId must be a mod id/);
  await bad('mods.enable', { modId: 'acme.demo', extra: 1 }, /unknown parameter 'extra'/);
  await bad('mods.enable', 'nope', /params must be an object/);
  await bad('mods.install', { source: 'relative/path' }, /params\.source must be an absolute path/);
  await bad('mods.install', { source: '/a', enable: 'yes' }, /params\.enable must be a boolean/);
  await bad('mods.consent', { modId: 'acme.demo' }, /params\.approve is required/);
  await bad('mods.consent', { modId: 'acme.demo', approve: true, allow: 'secrets' }, /params\.allow must be a list of permissions/);
  await bad('mods.installFromGitHub', { repo: 5 }, /params\.repo must be a GitHub repository as owner\/repository/);
  await bad('mods.applyUpdate', { modId: '../x' }, /params\.modId must be a mod id/);
  await bad('framework.developerMode', {}, /params\.on is required/);
  await bad('mods.configure', { modId: 'acme.demo' }, /params\.patches/);
  await bad('mods.rollback', { modId: 'acme.demo', toVersion: '../1', restoreData: false }, /params\.toVersion/);
  await bad('mods.rollback', { modId: 'acme.demo', toVersion: '1.0.0' }, /params\.restoreData is required/);
  await bad('mods.remove', { modId: 'acme.demo' }, /params\.deleteData is required/);
  await bad('mods.reattach', { modId: 'acme.demo', generation: '../x' }, /params\.generation must be a preserved-data generation id/);
  await bad('mods.reattach', { modId: 'acme.demo', generation: 5 }, /params\.generation/);
  await bad('recovery.safeMode', {}, /params\.enter is required/);
  await bad('updates.app.apply', {}, /params\.candidate is required/);
  await bad('ops.get', { opId: 'nope' }, /params\.opId must be an operation id/);
  await bad('no.such.method', {}, /Unknown method "no\.such\.method"/);
  assert.deepEqual(h.operations.started, [], 'nothing was journaled for invalid input');
  const noId = await call('mods.list');
  assert.equal(noId.ok, true);
  const res = await createManagement({ ...h }).handle({ method: 'mods.list' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /needs a string or number "id"/);
  const res2 = await createManagement({ ...h }).handle({ id: 'x' });
  assert.match(res2.error.message, /needs a string "method"/);
});

test('mods.configure validates against the manifest before journaling', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf({ settings: [{ key: 'n', kind: 'number', title: 'N', default: 1, max: 5 }] }));
  const res = await call('mods.configure', { modId: 'acme.demo', patches: [{ key: 'n', scope: 'app', value: 9 }] });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'Invalid');
  assert.equal(h.operations.started.length, 0);
  const ok = await call('mods.configure', { modId: 'acme.demo', patches: [{ key: 'n', scope: 'app', value: 2 }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(h.operations.started[0].patches, [{ key: 'n', scope: 'app', value: 2 }]);
});

test('mods.order (E6): the user\'s order, every mod once; the rules are ranked again; mods.list follows it', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf({ id: 'a.one', installSeq: 1 }), manifestOf({ id: 'a.one', name: 'One' }));
  h.operations.addMod(recordOf({ id: 'b.two', installSeq: 2 }), manifestOf({ id: 'b.two', name: 'Two' }));
  const order = new Map();
  h.operations.byRank = (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  h.operations.setOrder = async (ids) => { ids.forEach((id, i) => order.set(id, i + 1)); return { mods: ids }; };
  let reranked = 0;
  h.runtime.reranked = () => { reranked++; };
  const res = await call('mods.order', { mods: ['b.two', 'a.one'] });
  assert.deepEqual(res.result, { mods: ['b.two', 'a.one'] });
  assert.equal(reranked, 1);
  assert.deepEqual((await call('mods.list')).result.mods.map((m) => m.id), ['b.two', 'a.one']);
  const bad = await call('mods.order', { mods: 'b.two' });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /mods must be a list of mod ids/);
});

test('mods.list builds ModViews', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf({ id: 'acme.demo', installSeq: 2, pendingUpdate: { version: '2.0.0', addedPermissions: ['network'] } }),
    manifestOf({ settings: [] }));
  h.operations.addMod(recordOf({ id: 'dev.mod', installSeq: 1, publisher: null, dev: { sourceDir: '/s' }, status: 'quarantined', quarantine: { reason: 'r', at: 'a' } }),
    manifestOf({ id: 'dev.mod', name: 'Dev Mod' }));
  h.operations.compat = (m) => ({ status: m.id === 'dev.mod' ? 'degraded' : 'compatible', missingRequired: [], missingOptional: [] });
  const res = await call('mods.list');
  assert.deepEqual(res.result.mods.map((m) => m.id), ['dev.mod', 'acme.demo']);
  const [dev, acme] = res.result.mods;
  assert.equal(dev.dev, true);
  assert.equal(dev.publisherFingerprint, null);
  assert.equal(dev.compatibility, 'degraded');
  assert.equal(dev.quarantine.reason, 'r');
  assert.equal(dev.hasSettings, false);
  assert.equal(acme.name, 'Demo');
  assert.equal(acme.hasSettings, true);
  assert.equal(acme.publisherFingerprint, publisherFingerprint('cHVibGlzaGVyLWtleQ=='));
  assert.equal(acme.pendingUpdate.version, '2.0.0');
});

test('mods.inspect builds ModDetail from the store, snapshots, data and settings', async (t) => {
  const { h, call } = await setup(t);
  const oldKey = 'b2xkLWtleQ==';
  const newKey = 'bmV3LWtleQ==';
  h.operations.addMod(recordOf({ publisher: oldKey, grants: ['ui'], pendingUpdate: { version: '2.0.0', addedPermissions: ['secrets', 'ui'], newPublisher: newKey } }),
    manifestOf({ permissions: ['ui', 'appServer.observe'], settings: [{ key: 'theme', kind: 'text', title: 'Theme', default: 'dark' }, { key: 'font', kind: 'number', title: 'Font', default: 10 }] }));
  await mkdir(join(h.layout.store, 'acme.demo', '1.0.0'), { recursive: true });
  await mkdir(join(h.layout.store, 'acme.demo', '1.2.0'), { recursive: true });
  await writeFile(join(h.layout.store, 'acme.demo', '1.0.0', 'mod.json'), JSON.stringify({ id: 'acme.demo', version: '1.0.0', data: { schemaVersion: 1 } }));
  await writeFile(join(h.layout.store, 'acme.demo', '1.2.0', 'mod.json'), JSON.stringify({ id: 'acme.demo', version: '1.2.0' }));
  await mkdir(join(h.layout.store, 'acme.demo', '1.1.0'), { recursive: true });
  await writeFile(join(h.layout.store, 'acme.demo', '1.1.0', 'mod.json'), JSON.stringify({ id: 'acme.demo', version: '1.1.0' }));
  await mkdir(join(h.layout.orphaned, 'acme.demo'), { recursive: true });
  await mkdir(join(h.layout.snapshots, 'acme.demo', '1.0.0'), { recursive: true });
  await utimes(join(h.layout.snapshots, 'acme.demo', '1.0.0'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
  await mkdir(join(h.layout.data, 'acme.demo', 'files'), { recursive: true });
  await writeFile(join(h.layout.data, 'acme.demo', 'store.json'), '12345');
  await writeFile(join(h.layout.data, 'acme.demo', 'files', 'x'), '123');
  await writeFile(join(h.layout.data, 'acme.demo', 'settings.json'), JSON.stringify({ font: 12 }));
  await h.operations.start({ type: 'enable', modId: 'acme.demo' });
  await h.operations.start({ type: 'enable', modId: 'other.mod' });

  const res = await call('mods.inspect', { modId: 'acme.demo' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = res.result;
  assert.equal(d.manifest.id, 'acme.demo');
  assert.deepEqual(d.grants, ['ui']);
  assert.deepEqual(d.versionsInStore, ['1.0.0', '1.1.0', '1.2.0']);
  // F6: record.dataSchemaVersion is 0. 1.0.0 used schema 1 and has a snapshot; 1.1.0 uses schema 0 and has none; 1.2.0 is current.
  assert.deepEqual(d.versions, [
    { version: '1.0.0', dataSchemaVersion: 1, hasSnapshot: true, rollback: { codeOnly: false, codeAndData: true } },
    { version: '1.1.0', dataSchemaVersion: 0, hasSnapshot: false, rollback: { codeOnly: true, codeAndData: false } },
    { version: '1.2.0', dataSchemaVersion: 0, hasSnapshot: false, rollback: { codeOnly: false, codeAndData: false } },
  ]);
  assert.equal(d.orphaned, true);
  assert.deepEqual(d.snapshots, [{ fromVersion: '1.0.0', at: '2026-09-01T00:00:00.000Z' }]);
  assert.equal(d.dataBytes, 5 + 3 + JSON.stringify({ font: 12 }).length);
  assert.deepEqual(d.settings, { theme: 'dark', font: 12 });
  assert.equal(d.recentOps.length, 1);
  assert.deepEqual(d.publisherChange, { oldFingerprint: publisherFingerprint(oldKey), newFingerprint: publisherFingerprint(newKey) });
  assert.deepEqual(d.permissionText.map((p) => p.risk), ['low', 'low']);
  assert.deepEqual(d.pendingPermissionText.map((p) => p.risk), ['high', 'low']);

  const missing = await call('mods.inspect', { modId: 'no.such' });
  assert.equal(missing.error.code, 'Unavailable');
});

test('mods.inspect: no pending update means no publisherChange; settings null without a schema', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf());
  const d = (await call('mods.inspect', { modId: 'acme.demo' })).result;
  assert.equal(d.publisherChange, null);
  assert.equal(d.settings, null);
  assert.deepEqual(d.versionsInStore, []);
  assert.deepEqual(d.versions, []);
  assert.equal(d.orphaned, false);
  assert.equal(d.dataBytes, 0);
});

test('mods.inspect versions: dev and pending-consent mods offer no rollback; an unreadable stored manifest blocks code-only', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf({ dev: { sourceDir: '/s' }, publisher: null }), manifestOf());
  await mkdir(join(h.layout.store, 'acme.demo', '1.0.0'), { recursive: true });
  await writeFile(join(h.layout.store, 'acme.demo', '1.0.0', 'mod.json'), JSON.stringify({ id: 'acme.demo', version: '1.0.0' }));
  const dev = (await call('mods.inspect', { modId: 'acme.demo' })).result;
  assert.deepEqual(dev.versions[0].rollback, { codeOnly: false, codeAndData: false });
  h.operations.addMod(recordOf({ id: 'b.mod', installSeq: 2 }), manifestOf({ id: 'b.mod' }));
  await mkdir(join(h.layout.store, 'b.mod', '0.9.0'), { recursive: true });
  await writeFile(join(h.layout.store, 'b.mod', '0.9.0', 'mod.json'), '{broken');
  const b = (await call('mods.inspect', { modId: 'b.mod' })).result;
  assert.deepEqual(b.versions, [{ version: '0.9.0', dataSchemaVersion: 0, hasSnapshot: false, rollback: { codeOnly: false, codeAndData: false } }]);
});

test('mods.inspect returns orphanedGenerations (newest first, from Operations); orphaned follows them', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf());
  assert.deepEqual((await call('mods.inspect', { modId: 'acme.demo' })).result.orphanedGenerations, []);
  const gens = [{ at: '2026-10-11T09:30:00.000Z', version: '1.2.0', dataSchemaVersion: 1 }, { at: '2026-09-01T00:00:00.000Z', version: '1.0.0', dataSchemaVersion: 0 }];
  h.operations.orphans['acme.demo'] = gens;
  await mkdir(join(h.layout.orphaned, 'acme.demo', gens[0].at), { recursive: true });
  await writeFile(join(h.layout.orphaned, 'acme.demo', gens[0].at, 'store.json'), '12345');
  const d = (await call('mods.inspect', { modId: 'acme.demo' })).result;
  assert.deepEqual(d.orphanedGenerations.map(({ bytes, ...g }) => g), gens);
  assert.deepEqual(d.orphanedGenerations.map((g) => g.bytes), [5, 0], 'size of each preserved copy (extra)');
  assert.equal(d.orphaned, true);
  delete h.operations.orphanedGenerations;   // an Operations without the extra: no generations, no crash
  assert.deepEqual((await call('mods.inspect', { modId: 'acme.demo' })).result.orphanedGenerations, []);
});

test('permissionText risk mapping and plain English', () => {
  const by = (perms) => permissionText(perms);
  const risk = (p) => by([p]).find((l) => !/Intercepting can block/.test(l.text))?.risk;
  assert.equal(risk('appServer.intercept'), 'high');
  assert.equal(risk('appServer.intercept:*'), 'high');
  assert.equal(risk('appServer.backends'), 'high');
  assert.equal(risk('secrets'), 'high');
  assert.equal(risk('processes'), 'high');
  assert.equal(risk('framework.updates'), 'high');
  assert.equal(risk('appServer.intercept:thread/compact/start'), 'medium');
  assert.equal(risk('appServer.request'), 'medium');
  assert.equal(risk('appServer.request:thread/list'), 'medium');
  assert.equal(risk('appServer.clients'), 'medium');
  assert.equal(risk('network'), 'medium');
  assert.equal(risk('appServer.observe'), 'low');
  assert.equal(risk('appServer.observe:turn/'), 'low');
  assert.equal(risk('ui'), 'low');
  // The graph (breadth.md D0.2): `graph` is the mod's own items; reading other providers' is medium when scoped, acting and intercepting high.
  assert.equal(risk('graph'), 'medium');
  assert.equal(risk('graph.read'), 'high');
  assert.equal(risk('graph.read:Draft'), 'medium');
  assert.equal(risk('graph.act:Thread.rename'), 'high');
  assert.equal(risk('graph.intercept:Thread.send'), 'high');
  assert.ok(by(['graph.intercept:Thread.send,Thread.stop']).some((l) => l.text === 'Can change or block in Codex: your messages, Thread.stop'), 'the agent\'s inputs in the user\'s words (G3.5)');
  assert.ok(by(['graph.intercept:CodexAgent._startThread']).some((l) => l.text === 'Can change or block in Codex: what new chats start with (the agent\'s instructions and tools)'));
  assert.ok(by(['graph.contribute:Thread,Project']).some((l) => l.text === 'Can add its own items to your chats and your projects'), 'G3.2, in the user\'s terms');
  assert.ok(by(['graph.act']).some((l) => l.text === 'Can do anything in Codex on your behalf'));
  const scoped = by(['appServer.intercept:thread/compact/start']);
  assert.ok(scoped.some((l) => l.risk === 'medium' && l.text === 'Can read and change Codex requests: thread/compact/start'));
  // Intercepting can block requests (onError 'reject' is unknown before runtime): flagged high.
  assert.ok(scoped.some((l) => l.risk === 'high' && /Intercepting can block requests/.test(l.text)));
  assert.ok(!by(['ui', 'appServer.observe']).some((l) => l.risk === 'high'));
  // ordered high -> medium -> low
  const mixed = by(['ui', 'network', 'secrets']);
  assert.deepEqual(mixed.map((l) => l.risk), ['high', 'medium', 'low']);
  assert.deepEqual(by(undefined), []);
});

test('diagnostics aggregates mux metrics, runtime status and fault counts from the bus', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf());
  h.operations.addMod(recordOf({ id: 'other.mod', installSeq: 2 }), manifestOf({ id: 'other.mod' }));
  h.runtime.active();
  const rt = h.runtime;
  rt.status = (id) => (id === 'acme.demo' ? 'active' : 'inactive');
  rt.active = () => ['acme.demo'];
  h.bus.publish('framework/health', { healthy: true }, { state: true });
  h.bus.publish('framework/fault', { modId: 'acme.demo', realm: 'host', kind: 'throw', message: 'one' });
  h.bus.publish('framework/fault', { modId: 'acme.demo', realm: 'renderer', kind: 'throw', message: 'two' });
  h.bus.publish('framework/fault', { modId: 'ghost', realm: 'mux', kind: 'timeout', message: 'x' });
  const d = (await call('diagnostics')).result;
  assert.equal(d.mods['acme.demo'].faults, 2);
  assert.equal(d.mods['acme.demo'].lastError.message, 'two');
  assert.equal(d.mods['acme.demo'].runtime, 'active');
  assert.equal(d.mods['other.mod'].faults, 0);
  assert.equal(d.mods['other.mod'].lastError, undefined);
  assert.equal(d.mux.latencyMs.p95, 2);
  assert.deepEqual(d.host.activeMods, ['acme.demo']);
  assert.deepEqual(d.host.health, { healthy: true });
  assert.equal(d.host.faults, 3);
});

test('compat.report: a mod whose graph types built on a departed mod\'s is degraded, saying which types and why (6b)', async (t) => {
  const degraded = [{ owner: 'mod:acme.demo', types: ['JiraTicket'], because: 'mod:acme.base', at: 1 }];
  const { h, call } = await setup(t, { extra: { graphStatus: () => ({ degraded }) } });
  h.operations.addMod(recordOf(), manifestOf());
  h.operations.compat = () => ({ status: 'compatible', missingRequired: [], missingOptional: [] });
  const c = (await call('compat.report')).result.mods['acme.demo'];
  assert.deepEqual(c, { status: 'degraded', missingRequired: [], missingOptional: [], missingTypes: ['JiraTicket'], missingBecause: 'acme.base' });
  assert.deepEqual((await call('diagnostics')).result.graph.degraded, degraded);
  degraded.length = 0;
  assert.equal((await call('compat.report')).result.mods['acme.demo'].status, 'compatible');
  // the overlay only raises: it never hides at risk or blocked (E4)
  degraded.push({ owner: 'mod:acme.demo', types: ['JiraTicket'], because: 'mod:acme.base', at: 2 });
  h.operations.compat = () => ({ status: 'atRisk', missingRequired: [], missingOptional: [] });
  assert.equal((await call('compat.report')).result.mods['acme.demo'].status, 'atRisk');
});

test('features.list: the feature log with the running build\'s status and its evidence; compat.report counts them (E4)', async (t) => {
  const log = { reference: { builds: ['b'] }, features: { 'graph:Thread': { title: 'the Thread type', version: 1, needs: ['protocol:thread/read', { anyOf: ['service:a', 'service:b'] }] } },
    mechanics: { 'protocol:thread/read': { title: 'the app-server method thread/read', units: ['core:conversation'] } } };
  const features = {
    log, hash: 'abc',
    current: () => ({ features: { 'graph:Thread': { status: 'missing', because: [{ id: 'protocol:thread/read', status: 'missing', why: 'it is not in this build\'s schema' }] } },
      mechanics: { 'protocol:thread/read': { status: 'missing', why: 'it is not in this build\'s schema' } } }),
    evidence: () => ({ build: '1-1', from: '/x/adapters/1-1', facts: {}, report: null, stale: [], live: { bindings: { a: {} }, anchors: ['sidebar'] } }),
    unlogged: () => ['x/y'],
  };
  const { call } = await setup(t, { extra: { features } });
  const r = (await call('features.list')).result;
  assert.deepEqual(r.log, { hash: 'abc', reference: ['b'] });
  assert.deepEqual(r.evidence, { build: '1-1', from: '/x/adapters/1-1', census: true, report: false, stale: [], live: { bindings: 1, anchors: 1 }, unlogged: ['x/y'] });
  assert.deepEqual(r.features, [{ id: 'graph:Thread', kind: 'feature', title: 'the Thread type', version: 1, status: 'missing',
    because: [{ id: 'protocol:thread/read', status: 'missing', why: 'it is not in this build\'s schema' }], needs: ['protocol:thread/read', { anyOf: ['service:a', 'service:b'] }] }]);
  assert.deepEqual(r.mechanics, [{ id: 'protocol:thread/read', kind: 'mechanic', title: 'the app-server method thread/read', status: 'missing', why: 'it is not in this build\'s schema', units: ['core:conversation'] }]);
  assert.deepEqual((await call('compat.report')).result.features, { build: '1-1', hash: 'abc', features: { missing: 1 }, mechanics: { missing: 1 } });
});

test('compat.report and updates.status', async (t) => {
  const { h, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf());
  h.operations.compat = () => ({ status: 'degraded', missingRequired: [], missingOptional: ['anchor:composer'] });
  h.bus.publish('framework/probe', { appBuild: '26.1007', at: 'x', items: { react: true, 'anchor:composer': false } }, { state: true });
  const c = (await call('compat.report')).result;
  assert.equal(c.appBuild, '26.1007');
  assert.deepEqual(c.probes, { react: true, 'anchor:composer': false });
  assert.equal(c.mods['acme.demo'].status, 'degraded');
  assert.equal(c.adapterVersion, 'unknown');
  assert.equal(c.complete, false);
  h.bus.publish('framework/probe', { appBuild: '26.1007', at: 'y', items: { react: true }, complete: true }, { state: true });
  assert.equal((await call('compat.report')).result.complete, true);
  assert.deepEqual((await call('diagnostics')).result.host.probe, { complete: true, at: 'y' });
  h.recovery.lkgValue = { n: 3, adapterVersion: '1.0.2' };
  assert.equal((await call('compat.report')).result.adapterVersion, '1.0.2');

  await mkdir(h.layout.framework, { recursive: true });
  await writeFile(h.layout.frameworkCurrent, '1.1.0\n');
  h.recovery.app = { stockBuild: 'B', copyBuild: 'A' };
  const u = (await call('updates.status')).result;
  assert.deepEqual(u.framework, { current: '1.1.0', previous: null });
  assert.deepEqual(u.app, { stockBuild: 'B', copyBuild: 'A' });
  assert.equal(u.lkg.n, 3);
});

test('ops.get and ops.list', async (t) => {
  const { h, call } = await setup(t);
  const a = (await call('mods.enable', { modId: 'acme.demo' })).result.opId;
  const b = (await call('mods.enable', { modId: 'other.mod' })).result.opId;
  h.operations.update(a, { outcome: 'succeeded' });
  assert.equal((await call('ops.get', { opId: a })).result.outcome, 'succeeded');
  assert.equal((await call('ops.get', { opId: 'op-ffffffffffffffff' })).error.code, 'Unavailable');
  assert.deepEqual((await call('ops.list', {})).result.ops.map((o) => o.id), [a, b]);
  assert.deepEqual((await call('ops.list', { modId: 'other.mod' })).result.ops.map((o) => o.id), [b]);
  assert.deepEqual((await call('ops.list', { running: true })).result.ops.map((o) => o.id), [b]);
});

test('events: op, mods (only on change) and compat/health events; sources are released with the last subscriber', async (t) => {
  const { h, mgmt, call } = await setup(t);
  h.operations.addMod(recordOf(), manifestOf());
  const seen = [];
  const sub = mgmt.subscribe((e) => seen.push(e));
  assert.equal(h.operations.listenerCount, 1);
  const opId = (await call('mods.disable', { modId: 'acme.demo' })).result.opId;
  h.operations.update(opId, { phases: [{ name: 'p', at: 'x' }] });
  assert.deepEqual(seen.map((e) => e.event), ['op'], 'no mods event while records are unchanged');
  h.operations.state().mods['acme.demo'].status = 'disabled';
  h.operations.update(opId, { outcome: 'succeeded' });
  assert.deepEqual(seen.map((e) => e.event), ['op', 'op', 'mods']);
  assert.equal(seen[2].data.mods[0].status, 'disabled');
  h.bus.publish('framework/probe', { appBuild: 'B', at: 'x', items: { react: true } }, { state: true });
  assert.equal(seen.at(-1).event, 'compat');
  assert.deepEqual(seen.at(-1).data.probes, { react: true });
  h.bus.publish('framework/health', { healthy: false, stockAppConflict: true });
  assert.deepEqual(seen.at(-1), { event: 'health', data: { healthy: false, stockAppConflict: true } });
  h.operations.state().mods['acme.demo'].status = 'quarantined';
  h.bus.publish('framework/quarantine', { modId: 'acme.demo', reason: 'faults' });
  assert.equal(seen.at(-1).event, 'mods');
  sub.dispose();
  sub.dispose();
  assert.equal(h.operations.listenerCount, 0);
  const n = seen.length;
  h.operations.update(opId, { note: 'later' });
  assert.equal(seen.length, n);
});

test('E3: mods.configure takes patches; a patch that changes nothing is no operation; mods.settings reads what is stored', async (t) => {
  const { h, mgmt, call } = await setup(t);
  const settings = [{ key: 'model', kind: 'choice', title: 'Model', description: 'Which', default: 'a', scope: 'thread', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }];
  h.operations.addMod(recordOf(), manifestOf({ settings }));
  await mkdir(join(h.layout.data, 'acme.demo'), { recursive: true });
  await writeFile(join(h.layout.data, 'acme.demo', 'settings.json'), JSON.stringify({ model: 'b', gone: 1 }));
  await writeFile(join(h.layout.data, 'acme.demo', 'settings.scopes.json'), JSON.stringify({ 'thread:codex:t1': { model: 'a' } }));
  const same = await call('mods.configure', { modId: 'acme.demo', patches: [{ key: 'model', scope: 'app', value: 'b' }] });
  assert.deepEqual(same.result, { opId: null, unchanged: true });
  assert.equal(h.operations.started.length, 0);
  const ok = await call('mods.configure', { modId: 'acme.demo', patches: [{ key: 'model', scope: { thread: { provider: 'codex', id: 't1' } }, unset: true }] });
  assert.match(ok.result.opId, /^op-/);
  assert.deepEqual(h.operations.started[0].patches, [{ key: 'model', scope: { thread: { provider: 'codex', id: 't1' } }, unset: true }]);
  const bad = await call('mods.configure', { modId: 'acme.demo', patches: [{ key: 'model', value: 'x', unset: true }] });
  assert.equal(bad.error.code, 'Invalid');
  const read = (await call('mods.settings', { modId: 'acme.demo' })).result;
  assert.deepEqual([read.declarations.map((d) => d.key), read.app, read.document, read.invalid.map((x) => x.key)], [['model'], { model: 'b', gone: 1 }, { model: 'b' }, ['gone']]);
  assert.deepEqual((await call('mods.inspect', { modId: 'acme.demo' })).result.scopedSettings, { 'thread:codex:t1': { model: 'a' } });
  // A finished configure says the mod's settings are to be read again.
  const seen = [];
  mgmt.subscribe((e) => seen.push(e.event));
  h.operations.update(ok.result.opId, { outcome: 'succeeded' });
  assert.ok(seen.includes('settings'));
});

test('the old apply is the update\'s gate (E5): refused without a staged plan for that candidate, else the plan\'s copy-update', async (t) => {
  let plan = null;
  const detector = { status: async () => ({ plan }), offer: () => null, check: async () => {}, stageNow: async () => null };
  const { h, call } = await setup(t, { extra: { updates: { detector, state: { update: async () => {}, load: async () => ({}) } } } });
  const refused = await call('updates.app.apply', { candidate: '/r/apps/b/ChatGPT.app' });
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /no staged plan/);
  plan = { hash: 'b'.repeat(32), candidate: '/r/apps/b/ChatGPT.app' };
  h.operations.started.length = 0;
  const ok = await call('updates.app.apply', { candidate: '/r/apps/b/ChatGPT.app' });
  assert.equal(ok.ok, true);
  assert.deepEqual(h.operations.started, [{ type: 'copy-update', plan: 'b'.repeat(32) }]);
  assert.deepEqual((await call('updates.status')).result.plan, plan, 'the status carries the plan');
});

test('F10 and F12: install from GitHub and an offered update go through the mod updates; Check for updates checks the mods too; ModView says where a mod came from and what is offered; Developer mode is stored', async (t) => {
  const asked = [];
  let checked = 0;
  const listeners = new Set();
  const modUpdates = {
    install: async (repo) => { asked.push(['install', repo]); return 'op-0000000000000042'; },
    apply: async (modId) => { asked.push(['apply', modId]); return 'op-0000000000000043'; },
    check: async () => { checked++; },
    offerOf: (id) => (id === 'acme.demo' ? { version: '2.0.0', notes: 'n', addedPermissions: [], verdict: 'compatible', publisherChange: false, tag: 'v2.0.0' } : null),
    problemOf: (id) => (id === 'acme.demo' ? 'no network' : null),
    onChange: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  const { h, mgmt, call } = await setup(t, { extra: { modUpdates } });
  const source = { kind: 'github', repo: 'acme/demo', repoId: 1, tag: 'v1.0.0', digest: `sha256:${'b'.repeat(64)}` };
  h.operations.addMod(recordOf({ source }), manifestOf());
  assert.deepEqual((await call('mods.installFromGitHub', { repo: 'acme/demo' })).result, { opId: 'op-0000000000000042' });
  assert.deepEqual((await call('mods.applyUpdate', { modId: 'acme.demo' })).result, { opId: 'op-0000000000000043' });
  assert.deepEqual(asked, [['install', 'acme/demo'], ['apply', 'acme.demo']]);
  assert.equal((await call('updates.check', {})).ok, true);
  assert.equal(checked, 1);
  const view = (await call('mods.list')).result.mods[0];
  assert.deepEqual([view.source, view.release.version, view.checkProblem], [source, '2.0.0', 'no network']);
  const seen = [];
  const sub = mgmt.subscribe((e) => seen.push(e.event));
  for (const fn of [...listeners]) fn();
  assert.ok(seen.includes('modUpdates'), 'an open page reads again');
  sub.dispose();
  assert.equal((await call('diagnostics')).result.host.developerMode, false);
  assert.deepEqual((await call('framework.developerMode', { on: true })).result, { developerMode: true });
  assert.equal((await call('diagnostics')).result.host.developerMode, true);
  const without = await setup(t);
  assert.equal((await without.call('mods.installFromGitHub', { repo: 'acme/demo' })).error.code, 'Unavailable');
});

test('F11: updates.status says how the last try of this offer ended; Later stops a preparation; Use original Codex opens the stock app', async (t) => {
  const offer = { id: 'o1', build: 'B', copyBuild: 'A', framework: null, dismissed: false };
  const detector = { status: async () => ({ offer, staging: null, plan: null, policy: 'offer', unknown: [], support: { status: 'notYet' }, auto: { will: false, why: 'off' } }), offer: () => offer };
  let cancelled = 0, opened = 0;
  const st = { dismissed: [] };
  const updates = { detector, state: { update: async (fn) => fn(st) }, onEvent: () => {}, cancel: async () => { cancelled++; }, openOriginal: async () => { opened++; } };
  const { h, call } = await setup(t, { extra: { updates } });
  h.operations.ops.push({ id: 'op-1', input: { type: 'copy-update', plan: 'x' }, outcome: 'reverted', note: 'it did not start healthy', result: { offer: 'o1' }, startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:05:00.000Z', phases: [] });
  h.operations.ops.push({ id: 'op-2', input: { type: 'copy-update', plan: 'y' }, outcome: 'failed', result: { offer: 'another' }, startedAt: '2026-11-03T11:00:00.000Z', phases: [] });
  const s = (await call('updates.status')).result;
  assert.deepEqual(s.lastApply, { outcome: 'reverted', op: 'op-1', at: '2026-11-03T10:05:00.000Z', note: 'it did not start healthy' }, 'this offer\'s, not another\'s');
  assert.deepEqual(s.support, { status: 'notYet' });
  h.operations.ops.push({ id: 'op-3', input: { type: 'copy-update', plan: 'z' }, outcome: 'succeeded', result: { offer: 'o1' }, startedAt: '2026-11-03T12:00:00.000Z', phases: [] });
  assert.equal((await call('updates.status')).result.lastApply, null, 'one that went through says nothing');
  await call('updates.later');
  assert.deepEqual([cancelled, st.dismissed], [1, ['o1']], 'Cancel while it prepares means later');
  assert.deepEqual((await call('updates.openOriginal')).result, { opened: true });
  assert.equal(opened, 1);
  const without = await setup(t);
  assert.equal((await without.call('updates.openOriginal')).error.code, 'Unavailable');
});
