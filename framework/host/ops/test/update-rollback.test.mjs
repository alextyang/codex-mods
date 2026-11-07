import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, activationError, keygen } from './harness.mjs';
import { CodexModsError } from '../../../../sdk/errors.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';

const withH = (fn, o) => async () => { const H = await harness(o); try { await fn(H); } finally { await H.cleanup(); } };
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });
const names = (op) => op.phases.map((p) => p.name);
const MIGRATE = { 'migrate.js': 'export function migrate() {}\n' };

test('update (compatible, same schema, enabled): stop → apply → activate → health → commit; old version stays in the store', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['verify', 'compatibility', 'store', 'stop', 'apply', 'activate', 'health', 'commit']);
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.1.0');
  assert.equal(r.status, 'enabled');
  assert.equal(r.installSeq, 1);
  assert.deepEqual(H.runtime.calls.map((c) => `${c.fn}:${c.args[0]}:${c.args[1]}`), ['deactivate:test.alpha:update', 'activate:test.alpha:1.1.0']);
  assert.deepEqual(await H.ls(join(H.L.store, 'test.alpha')), ['1.0.0', '1.1.0']);
  assert.deepEqual(await H.ls(H.L.snapshots), [], 'no snapshot without a schema change');
  assert.equal((await H.readState()).mods['test.alpha'].version, '1.1.0');
}));

test('update of a disabled mod does not start it; same version, other id and signed→dev are refused', withH(async (H) => {
  await H.installApprove();
  let op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0' }) });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(names(op), ['verify', 'compatibility', 'store', 'apply', 'commit']);
  assert.deepEqual(H.runtime.names('activate'), []);
  assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0' }) });
  assert.equal(op.error.code, 'Invalid');
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ id: 'test.other', version: '2.0.0' }) });
  assert.equal(op.error.code, 'Invalid');
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.devDir({ version: '1.3.0' }) });
  assert.equal(op.error.code, 'Denied');
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.2.0');
  assert.deepEqual(await H.ls(join(H.L.store, '.staging')), []);
}));

test('update with a schema change: snapshot, migrate on a staged copy, swap by rename, keep the snapshot', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.writeData('test.alpha', 'v0-data');
  let seenStaged;
  H.runtime.migrate = async (o) => {
    seenStaged = o.stagedDataDir;
    assert.equal(await readFile(join(o.stagedDataDir, 'store.json'), 'utf8'), 'v0-data');
    await writeFile(join(o.stagedDataDir, 'store.json'), 'v1-data');
    assert.equal(await readFile(join(H.L.data, 'test.alpha', 'store.json'), 'utf8'), 'v0-data', 'live data untouched during migration');
  };
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['verify', 'compatibility', 'store', 'stop', 'snapshot', 'migrate', 'swap', 'apply', 'activate', 'health', 'commit']);
  const [call] = H.runtime.calls.filter((c) => c.fn === 'runMigration');
  assert.deepEqual(call.args.slice(0, 3), ['test.alpha', 0, 1]);
  assert.equal(call.args[3], join(H.L.store, 'test.alpha', '2.0.0', 'migrate.js'));
  assert.equal(await H.readData('test.alpha'), 'v1-data');
  assert.equal(await readFile(join(H.L.snapshots, 'test.alpha', '1.0.0', 'store.json'), 'utf8'), 'v0-data');
  assert.equal(H.ops.state().mods['test.alpha'].dataSchemaVersion, 1);
  assert.equal(await H.exists(seenStaged), false);
  assert.deepEqual((await H.ls(H.L.data)).filter((n) => n.startsWith('.')), []);
}));

test('update: migration failure or timeout → failed, data untouched, old version restarted', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.writeData('test.alpha', 'v0-data');
  H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'half'); throw new CodexModsError('Timeout', 'migration timed out'); };
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Timeout');
  assert.equal(await H.readData('test.alpha'), 'v0-data');
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.0.0');
  assert.equal(r.dataSchemaVersion, 0);
  assert.equal(r.status, 'enabled');
  assert.deepEqual(H.runtime.calls.filter((c) => c.fn === 'activate').map((c) => c.args), [['test.alpha', '1.0.0']]);
  assert.ok(H.runtime.active.has('test.alpha'));
  assert.deepEqual((await H.ls(H.L.data)).filter((n) => n.startsWith('.')), []);
}));

test('update: a fault in the health window reverts, restores the snapshot and restarts the old version', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.writeData('test.alpha', 'v0-data');
  H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'v1-data'); };
  H.runtime.onActivate = (mod) => { if (mod.record.version === '2.0.0') setTimeout(() => H.runtime.emitFault('test.alpha', 'kaboom'), 5); };
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
  assert.equal(op.outcome, 'reverted', JSON.stringify(op));
  assert.match(op.note, /faulted during the health window.*kaboom/);
  assert.match(op.note, /not undone/);
  assert.equal(await H.readData('test.alpha'), 'v0-data');
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.0.0');
  assert.equal(r.dataSchemaVersion, 0);
  assert.equal(r.status, 'enabled');
  assert.deepEqual(H.runtime.calls.filter((c) => c.fn === 'activate').map((c) => c.args), [['test.alpha', '2.0.0'], ['test.alpha', '1.0.0']]);
  assert.ok(names(op).includes('revert') && names(op).includes('reactivate'));
  assert.equal((await H.readState()).mods['test.alpha'].version, '1.0.0');
}));

test('update: a quarantine call during the window counts as a fault; a fault after the window does not', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  H.runtime.onActivate = (mod) => { if (mod.record.version === '1.1.0') setTimeout(() => H.ops.quarantine('test.alpha', 'runtime says so'), 5); };
  let op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
  assert.equal(op.outcome, 'reverted');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'enabled', 'reverted, not quarantined');
  H.runtime.onActivate = null;
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0' }) });
  assert.equal(op.outcome, 'succeeded');
  H.runtime.emitFault('test.alpha');                                   // after the window: ignored by Operations
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.2.0');
}));

test('update: the health window is honoured (injectable) and a clean window commits', async () => {
  const H = await harness({ healthWindowMs: 150 });
  try {
    await H.installApprove({}, { enable: true });
    const t0 = Date.now();
    const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
    assert.equal(op.outcome, 'succeeded');
    assert.ok(Date.now() - t0 >= 140);
  } finally { await H.cleanup(); }
});

test('update: activation failure reverts (effectsAttempted false → reverted, true → needs-attention)', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  H.runtime.activateErrors.set('test.alpha', (mod) => (mod.record.version === '1.1.0' ? activationError(false, 'new code did not start') : undefined));
  let op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
  assert.equal(op.outcome, 'reverted');
  assert.match(op.note, /failed to start: new code did not start/);
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.0.0');
  assert.ok(H.runtime.active.has('test.alpha'));
  H.runtime.activateErrors.set('test.alpha', (mod) => (mod.record.version === '1.2.0' ? activationError(true, 'it already did things') : undefined));
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0' }) });
  assert.equal(op.outcome, 'needs-attention');
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.0.0');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'enabled');
}));

test('update: if the old version cannot restart after a revert, the mod is disabled and needs attention', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  H.runtime.activateErrors.set('test.alpha', () => activationError(false, 'nothing starts'));
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
  assert.equal(op.outcome, 'needs-attention');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.0.0');
}));

test('update with added permissions waits for consent while the old version keeps running; approve continues it', withH(async (H) => {
  await H.installApprove({ permissions: ['ui'] }, { enable: true });
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0', permissions: ['ui', 'secrets', 'appServer.request:thread/start'] }) });
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.awaiting, 'consent');
  assert.match(op.note, /secrets/);
  let r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.0.0');
  assert.deepEqual(r.pendingUpdate, { version: '1.1.0', addedPermissions: ['secrets', 'appServer.request:thread/start'] });
  assert.deepEqual(H.runtime.calls, [], 'old version untouched');
  const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  assert.equal(c.outcome, 'succeeded', JSON.stringify(c));
  assert.deepEqual(names(c), ['approve', 'stop', 'apply', 'activate', 'health', 'commit']);
  r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.1.0');
  assert.equal(r.pendingUpdate, undefined);
  assert.deepEqual(r.grants, ['ui', 'secrets', 'appServer.request:thread/start']);
  assert.equal(H.ops.list({ modId: 'test.alpha' }).filter((o) => o.input.type === 'consent').length, 2, 'install consent + update consent');
}));

test('update with added permissions: deny drops the pending update; a narrower scope under a bare grant is not an addition', withH(async (H) => {
  await H.installApprove({ permissions: ['appServer.observe'] }, { enable: true });
  let op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0', permissions: ['appServer.observe:turn/completed'] }) });
  assert.equal(op.awaiting, undefined, 'covered by the bare grant: applied directly');
  assert.equal(H.ops.state().mods['test.alpha'].version, '1.1.0');
  assert.deepEqual(H.ops.state().mods['test.alpha'].grants, ['appServer.observe:turn/completed']);
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0', permissions: ['processes'] }) });
  assert.equal(op.awaiting, 'consent');
  op = await H.run({ type: 'consent', modId: 'test.alpha', approve: false });
  assert.equal(op.outcome, 'succeeded');
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.pendingUpdate, undefined);
  assert.equal(r.version, '1.1.0');
  await rejectsCode(H.ops.start({ type: 'consent', modId: 'test.alpha', approve: true }), 'Invalid');
}));

test('update with a different publisher key needs consent; approval re-pins the key and deletes the old publisher\'s secrets', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  const newKey = keygen();
  const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0' }, {}, newKey) });
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.awaiting, 'consent');
  assert.match(op.note, /publisher change/);
  let r = H.ops.state().mods['test.alpha'];
  assert.deepEqual(r.pendingUpdate, { version: '2.0.0', addedPermissions: [], newPublisher: newKey.publicKey });
  assert.equal(r.publisher, H.key.publicKey);
  assert.deepEqual(H.runtime.names('deleteSecrets'), []);
  const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  assert.equal(c.outcome, 'succeeded', JSON.stringify(c));
  assert.deepEqual(names(c), ['approve', 'stop', 'apply', 'activate', 'health', 'commit', 'cleanup']);
  r = H.ops.state().mods['test.alpha'];
  assert.equal(r.publisher, newKey.publicKey);
  assert.equal(r.version, '2.0.0');
  assert.deepEqual(H.runtime.names('deleteSecrets'), [['test.alpha', publisherFingerprint(H.key.publicKey)]]);
  // and a later update must match the NEW pin
  const back = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.1.0' }, {}, H.key) });
  assert.equal(back.awaiting, 'consent');
}));

test('a reverted publisher-change update keeps the old pin and does not delete secrets', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  const newKey = keygen();
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0' }, {}, newKey) });
  H.runtime.activateErrors.set('test.alpha', (mod) => (mod.record.version === '2.0.0' ? activationError(false, 'bad') : undefined));
  const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  assert.equal(c.outcome, 'reverted');
  assert.equal(H.ops.state().mods['test.alpha'].publisher, H.key.publicKey);
  assert.deepEqual(H.runtime.names('deleteSecrets'), []);
}));

test('update of a development package re-reads the same directory', withH(async (H) => {
  const dir = await H.devDir({ id: 'dev.mod' });
  await H.run({ type: 'install', source: dir, dev: true });
  await H.run({ type: 'consent', modId: 'dev.mod', approve: true, enable: true });
  await writeFile(join(dir, 'mod.json'), JSON.stringify({ id: 'dev.mod', version: '1.0.1', name: 'Alpha', framework: '>=1 <2', entry: { host: 'host.js' } }));
  let op = await H.run({ type: 'update', modId: 'dev.mod', source: dir });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.equal(H.ops.state().mods['dev.mod'].version, '1.0.1');
  assert.equal(H.ops.state().mods['dev.mod'].publisher, null);
  assert.equal(H.ops.installed('dev.mod').packageDir, dir);
  op = await H.run({ type: 'update', modId: 'dev.mod', source: await H.devDir({ id: 'dev.mod', version: '1.0.2' }) });
  assert.equal(op.error.code, 'Invalid');                                // another directory
  // added permissions on a dev package also need consent, and consent re-verifies the directory
  await writeFile(join(dir, 'mod.json'), JSON.stringify({ id: 'dev.mod', version: '1.0.3', name: 'Alpha', framework: '>=1 <2', entry: { host: 'host.js' }, permissions: ['secrets'] }));
  op = await H.run({ type: 'update', modId: 'dev.mod', source: dir });
  assert.equal(op.awaiting, 'consent');
  op = await H.run({ type: 'consent', modId: 'dev.mod', approve: true });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(H.ops.state().mods['dev.mod'].grants, ['secrets']);
}));

test('update: snapshots keep only the last 2', withH(async (H) => {
  await H.installApprove({}, { enable: false });
  await H.writeData('test.alpha', 'd');
  for (const [v, s] of [['1.1.0', 1], ['1.2.0', 2], ['1.3.0', 3]]) {
    const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: v, data: { schemaVersion: s } }) });
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.deepEqual(await H.ls(join(H.L.snapshots, 'test.alpha')), ['1.1.0', '1.2.0']);
}));

// ------------------------------------------------------------------ rollback
test('rollback code-only: allowed when the data schema matches, keeps data', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0' }) });
  await H.writeData('test.alpha', 'current');
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: false });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['stop', 'apply', 'activate', 'commit']);
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.0.0');
  assert.equal(r.status, 'enabled');
  assert.equal(await H.readData('test.alpha'), 'current');
  assert.deepEqual(H.runtime.names('activate'), [['test.alpha', '1.0.0']]);
}));

test('rollback: blocked with a reason when the schema differs (code-only), the version is missing, or no snapshot exists', withH(async (H) => {
  await H.installApprove();
  await H.writeData('test.alpha', 'v0');
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1 } }) });
  await rejectsCode(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: false }), 'Invalid');
  await assert.rejects(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: false }), /data schema 0.*schema 1.*a snapshot exists/);
  await rejectsCode(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: '9.9.9', restoreData: false }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: '2.0.0', restoreData: false }), 'Invalid');
  // restoreData with no snapshot for the target
  await H.installApprove({ id: 'test.nosnap' });
  await H.run({ type: 'update', modId: 'test.nosnap', source: await H.pack({ id: 'test.nosnap', version: '1.1.0' }) });
  await assert.rejects(H.ops.start({ type: 'rollback', modId: 'test.nosnap', toVersion: '1.0.0', restoreData: true }), /no data snapshot/);
}));

test('rollback code+data: restores the snapshot of the target version, retained storage untouched', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.writeData('test.alpha', 'v0-data');
  await H.writeData('test.alpha', 'x', 'settings.json');
  H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'v1-data'); };
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
  await H.writeData('test.alpha', 'v1-data-changed-later');
  await H.writeData('test.alpha', 'retained', 'files.txt');
  H.runtime.calls.length = 0;
  const op = await H.run({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: true });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['stop', 'snapshot', 'restore-data', 'apply', 'activate', 'commit']);
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.version, '1.0.0');
  assert.equal(r.dataSchemaVersion, 0);
  assert.equal(await H.readData('test.alpha'), 'v0-data');
  assert.equal(await H.readData('test.alpha', 'files.txt'), undefined, 'data changed since the snapshot is lost');
  // the pre-rollback data is itself snapshotted under the version being left
  assert.equal(await readFile(join(H.L.snapshots, 'test.alpha', '2.0.0', 'store.json'), 'utf8'), 'v1-data-changed-later');
}));

test('rollback: refuses a version that needs ungranted permissions or another publisher; reverts when the old version will not start', withH(async (H) => {
  await H.installApprove({ permissions: ['secrets'] }, { enable: true });
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0', permissions: [] }) });
  await rejectsCode(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: false }), 'Denied');
  // activation failure on rollback reverts to the version that was running
  await H.installApprove({ id: 'test.beta' }, { enable: true });
  await H.run({ type: 'update', modId: 'test.beta', source: await H.pack({ id: 'test.beta', version: '1.1.0' }) });
  H.runtime.activateErrors.set('test.beta', (mod) => (mod.record.version === '1.0.0' ? activationError(false, 'old is broken now') : undefined));
  const op = await H.run({ type: 'rollback', modId: 'test.beta', toVersion: '1.0.0', restoreData: false });
  assert.equal(op.outcome, 'reverted');
  assert.equal(H.ops.state().mods['test.beta'].version, '1.1.0');
  assert.ok(H.runtime.active.has('test.beta'));
}));

test('defaults: 60 s migration timeout and 60 s health window (injectable for tests)', async () => {
  const H = await harness();
  try {
    await H.installApprove({}, { enable: false });
    await H.writeData('test.alpha', 'd');
    const ops = (await import('../index.mjs')).createOperations({
      layout: H.L, log: H.log, packages: H.packages, runtime: H.runtime, bus: H.bus, mux: H.mux, adapter: H.adapter, safeMode: false, recovery: H.recovery,
    });
    const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) }, ops);
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.equal(H.runtime.calls.find((c) => c.fn === 'runMigration').args[4], 60_000);
    // the default window is 60 s: enabled updates would sit in 'health' that long
    await H.run({ type: 'enable', modId: 'test.alpha' }, ops);
    const id = await ops.start({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '2.1.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
    for (let i = 0; i < 1000 && ops.get(id).phases.at(-1)?.name !== 'health'; i++) await new Promise((r) => setTimeout(r, 10));   // slow machines: wait for the window to open
    await new Promise((r) => setTimeout(r, 300));                     // still inside the 60 s window after 300 ms
    assert.equal(ops.get(id).outcome, 'running');
    assert.equal(ops.get(id).phases.at(-1).name, 'health');
    H.runtime.emitFault('test.alpha', 'stop waiting');
    assert.equal((await ops.whenSettled(id)).outcome, 'reverted');
  } finally { await H.cleanup(); }
});
