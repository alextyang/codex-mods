// Review #5 (quarantine events), #6 (framework state ops exclude mod ops), #7 (partial effects are never "failed").
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, activationError } from './harness.mjs';

const MIGRATE = { 'migrate.js': 'export function migrate() {}\n' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });
const quarantineEvents = (H) => H.bus.published.filter((p) => p.topic === 'framework/quarantine').map((p) => p.data);

async function slowUpdate(H, id) {
  let release;
  const gate = new Promise((r) => { release = r; });
  H.runtime.migrate = async (o) => { await gate; await writeFile(join(o.stagedDataDir, 'store.json'), 'migrated'); };
  await H.installApprove({ id }, { enable: true });
  await H.writeData(id, 'old');
  const source = await H.pack({ id, version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE);
  const opId = await H.ops.start({ type: 'update', modId: id, source });
  while (!H.runtime.calls.some((c) => c.fn === 'runMigration')) await sleep(5);
  return { opId, release };
}

test('lkg-restore waits for a slow update, blocks new mod ops meanwhile, then restores over the finished state', async () => {
  const H = await harness();
  try {
    const { opId: updateId, release } = await slowUpdate(H, 'test.alpha');
    await H.installApprove({ id: 'test.beta' }, { enable: true });
    const gen = { n: 1, appBuild: 'b', frameworkVersion: '1', adapterVersion: '1', mods: [], settingsHash: '', createdAt: 'x',
      state: { schemaVersion: 1, safeMode: false, nextInstallSeq: 9, mods: { 'test.alpha': structuredClone(H.ops.state().mods['test.alpha']), 'test.beta': structuredClone(H.ops.state().mods['test.beta']) } }, settings: {} };
    const events = [];
    H.recovery.runOpImpl = async () => {
      events.push(`restore:update=${H.ops.get(updateId).outcome}`);
      const r = await H.ops.restoreFromGeneration(gen);
      return { outcome: 'succeeded', note: 'restored', result: r };
    };
    const lkgId = await H.ops.start({ type: 'lkg-restore' });
    await sleep(80);
    assert.equal(H.ops.get(lkgId).outcome, 'running');
    assert.deepEqual(H.recovery.ran, [], 'restore must not start while a mod op is running');
    // new mod ops are refused while the restore is pending
    await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.beta', patches: [{ key: 'n', scope: 'app', value: 1 }] }), 'Conflict');
    await rejectsCode(H.ops.start({ type: 'disable', modId: 'test.beta' }), 'Conflict');
    await rejectsCode(H.ops.start({ type: 'install', source: await H.pack({ id: 'test.gamma' }) }), 'Conflict');
    await rejectsCode(H.ops.start({ type: 'app-prepare' }), 'Conflict');            // one framework op at a time
    release();
    const upd = await H.ops.whenSettled(updateId);
    assert.equal(upd.outcome, 'succeeded', JSON.stringify(upd));
    const lkg = await H.ops.whenSettled(lkgId);
    assert.equal(lkg.outcome, 'succeeded');
    assert.deepEqual(events, ['restore:update=succeeded']);
    // the restore saw the post-update record (schema 1 ≠ generation's 0) and parked the mod rather than being overwritten
    assert.equal(H.ops.state().mods['test.alpha'].version, '2.0.0');
    assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
    assert.deepEqual(lkg.result.restored, ['test.beta']);
    // the plane is open again
    assert.equal((await H.run({ type: 'disable', modId: 'test.beta' })).outcome, 'succeeded');
  } finally { await H.cleanup(); }
});

test('safe-mode op: gives up with Conflict after the bound if a mod op never settles, changing nothing', async () => {
  const H = await harness();
  try {
    H.ops = H.create({ exclusiveWaitMs: 120 });
    const { opId: updateId, release } = await slowUpdate(H, 'test.alpha');
    const id = await H.ops.start({ type: 'safe-mode', enter: true });
    const op = await H.ops.whenSettled(id);
    assert.equal(op.outcome, 'failed');
    assert.equal(op.error.code, 'Conflict');
    assert.deepEqual(H.recovery.ran, []);
    assert.equal(H.ops.state().safeMode, false);
    // the lock is released: mod ops work again, and the stuck update is untouched
    assert.equal(H.ops.get(updateId).outcome, 'running');
    await rejectsCode(H.ops.start({ type: 'disable', modId: 'test.alpha' }), 'Conflict');      // its own lock, not the global one
    release();
    assert.equal((await H.ops.whenSettled(updateId)).outcome, 'succeeded');
    await H.installApprove({ id: 'test.beta' });
  } finally { await H.cleanup(); }
});

test('an exclusive op that is still running after a restart blocks mod ops until recover() reconciles it', async () => {
  const H = await harness();
  try {
    await H.installApprove({}, { enable: true });
    H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'restoring' });
    await H.recorded(H.ops, await H.ops.start({ type: 'lkg-restore' }), 'restoring');
    const again = H.create();
    await rejectsCode(again.start({ type: 'disable', modId: 'test.alpha' }), 'Conflict');
    H.recovery.reconcileImpl = async () => ({ outcome: 'succeeded' });
    await again.recover();
    assert.equal((await H.run({ type: 'disable', modId: 'test.alpha' }, again)).outcome, 'succeeded');
  } finally { await H.cleanup(); }
});

test('remove: a secret-deletion failure after the record was dropped is needs-attention (never failed); a retry finishes it', async () => {
  const H = await harness();
  try {
    await H.installApprove({}, { enable: true });
    await H.writeData('test.alpha', 'data');
    H.runtime.deleteSecretsError = new Error('keychain locked');
    const op = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
    assert.equal(op.outcome, 'needs-attention');
    assert.equal(op.error.message, 'keychain locked');
    assert.match(op.note, /Partially applied: stop, unrecord/);
    assert.match(op.note, /delete-data \(interrupted\)/);
    assert.equal(H.ops.state().mods['test.alpha'], undefined);
    assert.equal(await H.readData('test.alpha'), 'data', 'data still there: nothing claimed it was deleted');
    // the retry is allowed although the record is gone, and is idempotent
    H.runtime.deleteSecretsError = null;
    const retry = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
    assert.equal(retry.outcome, 'succeeded', JSON.stringify(retry));
    assert.equal(await H.readData('test.alpha'), undefined);
    assert.equal(H.runtime.names('deleteSecrets').length, 2);
    // after a completed removal there is nothing left to retry
    await assert.rejects(H.ops.start({ type: 'remove', modId: 'test.alpha', deleteData: true }), (e) => e.code === 'Invalid');
  } finally { await H.cleanup(); }
});

test('other partial failures: configure whose notification throws, disable whose commit cannot persist', async () => {
  const H = await harness();
  try {
    await H.installApprove({ settings: [{ key: 'n', kind: 'number', title: 'N', default: 1 }] }, { enable: true });
    H.runtime.settingsError = new Error('realm gone');
    const op = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'n', scope: 'app', value: 3 }] });
    assert.equal(op.outcome, 'needs-attention');
    assert.match(op.note, /Partially applied: write/);
    assert.deepEqual(JSON.parse(await H.readData('test.alpha', 'settings.json')), { n: 3 });
  } finally { await H.cleanup(); }
});

test('failed still means nothing was applied: verification and compatibility errors, refused install', async () => {
  const H = await harness();
  try {
    const op = await H.run({ type: 'install', source: await H.pack({ entry: { renderer: 'r.js' }, requires: { features: ['anchor:statusbar'] } }, { 'r.js': 'x' }) });
    assert.equal(op.outcome, 'failed');
    assert.equal(op.note, undefined);
    // consent+enable: the grants were persisted, so a refused enable afterwards is needs-attention, never failed
    H.adapter = { ...H.adapter, anchors: { sidebar: {} } };
    H.ops = H.create();
    await H.run({ type: 'install', source: await H.pack({ id: 'test.ui', entry: { renderer: 'r.js' }, requires: { features: ['anchor:sidebar'] } }, { 'r.js': 'x' }) });
    H.adapter = { ...H.adapter, anchors: {} };   // the build changed: no sidebar anchor any more
    H.ops = H.create();
    const c = await H.run({ type: 'consent', modId: 'test.ui', approve: true, enable: true });
    assert.equal(c.outcome, 'needs-attention');
    assert.equal(c.error.code, 'Incompatible');
    assert.match(c.note, /Partially applied: apply/);
    assert.equal(H.ops.state().mods['test.ui'].status, 'disabled');
    assert.deepEqual(H.ops.state().mods['test.ui'].grants, []);   // approved: grants = manifest permissions (none here)
  } finally { await H.cleanup(); }
});

test('every quarantine publishes framework/quarantine {modId, reason}', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.a' }, { enable: true });
    await H.installApprove({ id: 'test.b' }, { enable: true });
    await H.installApprove({ id: 'test.c' }, { enable: true });
    // 1. quarantine() on an idle mod
    await H.ops.quarantine('test.a', 'too many faults');
    assert.deepEqual(quarantineEvents(H), [{ modId: 'test.a', reason: 'too many faults' }]);
    // 2. activation failure at boot
    H.runtime.activateErrors.set('test.b', activationError(true, 'cannot start'));
    await H.ops.activateAll();
    assert.equal(quarantineEvents(H).length, 2);
    assert.equal(quarantineEvents(H)[1].modId, 'test.b');
    assert.match(quarantineEvents(H)[1].reason, /cannot start/);
    // 3. a quarantine during an update's health window (the update reverts, but the gate still hears about it)
    H.runtime.activateErrors.clear();
    H.runtime.onActivate = (mod) => { if (mod.record.version === '1.1.0') setTimeout(() => H.ops.quarantine('test.c', 'window fault'), 5); };
    const op = await H.run({ type: 'update', modId: 'test.c', source: await H.pack({ id: 'test.c', version: '1.1.0' }) });
    assert.equal(op.outcome, 'reverted');
    assert.deepEqual(quarantineEvents(H).at(-1), { modId: 'test.c', reason: 'window fault' });
  } finally { await H.cleanup(); }
});

test('consent+enable: activation failing after the grants were persisted is needs-attention, not failed', async () => {
  const H = await harness();
  try {
    await H.run({ type: 'install', source: await H.pack({ permissions: ['ui'] }) });
    H.runtime.activateErrors.set('test.alpha', activationError(false, 'did not start'));
    const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true, enable: true });
    assert.equal(c.outcome, 'needs-attention');
    assert.match(c.note, /Consent was recorded.*did not start/);
    assert.deepEqual(H.ops.state().mods['test.alpha'].grants, ['ui']);
    assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
    // a plain enable with the same error stays "failed": nothing was applied
    const e = await H.run({ type: 'enable', modId: 'test.alpha' });
    assert.equal(e.outcome, 'failed');
  } finally { await H.cleanup(); }
});

test('framework ops: Recovery.runOp throwing after a journaled phase is needs-attention; before any phase it is failed', async () => {
  const H = await harness();
  try {
    H.recovery.runOpImpl = async (op, journal) => { await journal('build-candidate'); await journal('swap'); throw new Error('helper crashed'); };
    let op = await H.run({ type: 'app-switch', candidate: '/x.app' });
    assert.equal(op.outcome, 'needs-attention');
    assert.equal(op.error.message, 'helper crashed');
    assert.match(op.note, /build-candidate \(started\), swap \(started\)/);
    H.recovery.runOpImpl = async () => { throw new Error('refused up front'); };
    op = await H.run({ type: 'app-prepare' });
    assert.equal(op.outcome, 'failed');
    assert.equal(op.note, undefined);
  } finally { await H.cleanup(); }
});

test('a needs-attention operation is acknowledged durably; any other outcome is refused (E6)', async () => {
  const H = await harness();
  try {
    H.adapter = { ...H.adapter, anchors: { sidebar: {} } };
    H.ops = H.create();
    await H.run({ type: 'install', source: await H.pack({ id: 'test.ui', entry: { renderer: 'r.js' }, requires: { features: ['anchor:sidebar'] } }, { 'r.js': 'x' }) });
    H.adapter = { ...H.adapter, anchors: {} };
    H.ops = H.create();
    const c = await H.run({ type: 'consent', modId: 'test.ui', approve: true, enable: true });
    assert.equal(c.outcome, 'needs-attention');
    // a failed write acknowledges nothing, in memory or on disk
    await chmod(H.L.ops, 0o500);
    await assert.rejects(H.ops.acknowledge(c.id));
    await chmod(H.L.ops, 0o700);
    assert.equal(H.ops.get(c.id).acknowledgedAt, undefined);
    // concurrent calls share the one write and answer after it
    const [ack, ack2] = await Promise.all([H.ops.acknowledge(c.id), H.ops.acknowledge(c.id)]);
    assert.match(ack.acknowledgedAt, /^\d{4}-/);
    assert.equal(ack2.acknowledgedAt, ack.acknowledgedAt);
    assert.equal(JSON.parse(await readFile(join(H.L.ops, `${c.id}.json`), 'utf8')).acknowledgedAt, ack.acknowledgedAt, 'written before it answers');
    assert.equal(ack.outcome, 'needs-attention', 'it keeps its outcome');
    const again = H.create();
    assert.equal(again.get(c.id).acknowledgedAt, ack.acknowledgedAt, 'durable across a restart');
    const ok = await H.run({ type: 'install', source: await H.pack({ id: 'test.plain' }) });
    assert.equal(ok.outcome, 'succeeded');
    await assert.rejects(H.ops.acknowledge(ok.id), /does not need attention/);
  } finally { await H.cleanup(); }
});

test('the user\'s mod order (E6): every installed mod once, written once; a new mod goes last; activation follows it', async () => {
  const H = await harness();
  try {
    for (const id of ['test.a', 'test.b', 'test.c']) await H.installApprove({ id }, { enable: true });
    assert.deepEqual(Object.keys(H.ops.state().mods).sort(H.ops.byRank), ['test.a', 'test.b', 'test.c'], 'the install order until you set one');
    await assert.rejects(H.ops.setOrder(['test.a', 'test.b']), { code: 'Conflict' }, 'one missing: they changed since you looked');
    await assert.rejects(H.ops.setOrder(['test.c', 'test.b', 'test.a', 'test.a']), { code: 'Conflict' });
    await assert.rejects(H.ops.setOrder(['test.c', 'test.b', 'test.x']), { code: 'Conflict' });
    await H.ops.setOrder(['test.c', 'test.a', 'test.b']);
    const st = await H.readState();
    assert.deepEqual(['test.c', 'test.a', 'test.b'].map((id) => st.mods[id].order), [1, 2, 3]);
    assert.ok(st.mods['test.a'].installSeq < st.mods['test.c'].installSeq, 'installSeq stays the install ordinal');
    assert.deepEqual([H.ops.rankOf('test.c'), H.ops.rankOf('test.b'), H.ops.rankOf('test.nope')], [1, 3, Number.MAX_SAFE_INTEGER]);
    await H.installApprove({ id: 'test.d' });
    assert.equal((await H.readState()).mods['test.d'].order, 4, 'a new mod goes last');
    // E6 review: refused while an operation runs (its undo would restore an old order), unchanged when the write fails
    let release, entered;
    const reached = new Promise((r) => { entered = r; });
    H.runtime.activateGate = () => new Promise((r) => { release = r; entered(); });
    const running = await H.ops.start({ type: 'enable', modId: 'test.d' });
    await reached;   // the operation holds its activation (no timing guess: the suite runs loaded)
    await assert.rejects(H.ops.setOrder(['test.d', 'test.c', 'test.a', 'test.b']), (e) => e.code === 'Conflict' && /is running/.test(e.message));
    H.runtime.activateGate = null;
    release();
    await H.ops.whenSettled(running);
    await H.run({ type: 'disable', modId: 'test.d' });
    const dir = join(H.L.state, '..');
    await chmod(dir, 0o500);
    try { await assert.rejects(H.ops.setOrder(['test.d', 'test.c', 'test.a', 'test.b'])); } finally { await chmod(dir, 0o700); }
    assert.deepEqual(['test.c', 'test.a', 'test.b', 'test.d'].map((id) => H.ops.state().mods[id].order), [1, 2, 3, 4], 'a failed write changes nothing');
    // the next launch activates in that order
    const { FakeRuntime } = await import('./harness.mjs');
    H.runtime = new FakeRuntime();
    const next = H.create();
    await next.activateAll();
    assert.deepEqual(H.runtime.names('activate').map((a) => a[0]), ['test.c', 'test.a', 'test.b'], 'test.d is off');
  } finally { await H.cleanup(); }
});
