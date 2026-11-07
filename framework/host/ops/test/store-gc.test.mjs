// Operations.gcStore: one store per root shared by every profile (contracts v1.5, review N1/N2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, readFile, utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { layout } from '../../../../contracts/layout.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';
import { createPackages } from '../../packages/index.mjs';
import { createOperations } from '../index.mjs';
import { harness, FakeBus, FakeRuntime, FakeRecovery, ADAPTER } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const storeList = async (H) => {
  const out = [];
  for (const id of (await H.ls(H.L.store)).filter((n) => !n.startsWith('.'))) for (const v of await H.ls(join(H.L.store, id))) out.push(`${id}@${v}`);
  return out.sort();
};
async function addVersion(H, id, version) {
  const archive = await H.pack({ id, version });
  await H.packages.store(await H.packages.verify(archive));
}
function otherProfile(H, name = 'other', extra = {}) {
  const L2 = layout(H.root, name);
  const packages = createPackages({ layout: L2, log: createTestLog(), frameworkVersion: '1.0.0' });
  const ops = createOperations({ layout: L2, log: createTestLog(), packages, runtime: new FakeRuntime(), bus: new FakeBus(), mux: { async disposeOwner() {} },
    adapter: ADAPTER, safeMode: false, recovery: new FakeRecovery(), healthWindowMs: 20, ...extra });
  return { L2, ops };
}

test('gcStore from an empty profile deletes nothing another profile uses; unreferenced versions go', async () => {
  const H = await harness();
  try {
    // profile "default": x@1.0.0 installed, x@1.1.0 staged for consent (pendingUpdate), x@0.9.0 only in a generation,
    // x@0.7.0 only named by a running rollback op, x@0.5.0 unreferenced
    await H.installApprove({ id: 'test.x', permissions: ['ui'] });
    const up = await H.run({ type: 'update', modId: 'test.x', source: await H.pack({ id: 'test.x', version: '1.1.0', permissions: ['ui', 'secrets'] }) });
    assert.equal(up.awaiting, 'consent');
    await addVersion(H, 'test.x', '0.9.0'); await addVersion(H, 'test.x', '0.7.0'); await addVersion(H, 'test.x', '0.5.0');
    await mkdir(H.L.generations, { recursive: true });
    await writeFile(join(H.L.generations, '3.json'), JSON.stringify({ n: 3, mods: [{ id: 'test.x', version: '0.9.0', dataSchemaVersion: 0 }], state: { schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 }, settings: {} }));
    await writeFile(join(H.L.generations, 'lkg'), '3');
    await writeFile(join(H.L.ops, 'op-aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'op-aaaaaaaaaaaaaaaa', input: { type: 'rollback', modId: 'test.x', toVersion: '0.7.0', restoreData: false }, outcome: 'running', phases: [], startedAt: 'x' }));
    // profile "other": nothing installed at all
    const { ops: empty } = otherProfile(H);
    assert.deepEqual(await storeList(H), ['test.x@0.5.0', 'test.x@0.7.0', 'test.x@0.9.0', 'test.x@1.0.0', 'test.x@1.1.0']);
    const { removed } = await empty.gcStore();
    assert.deepEqual(removed, ['test.x@0.5.0']);
    assert.deepEqual(await storeList(H), ['test.x@0.7.0', 'test.x@0.9.0', 'test.x@1.0.0', 'test.x@1.1.0']);
    // the same answer from the owning profile, and a second run is a no-op
    assert.deepEqual((await H.ops.gcStore()).removed, []);
    // once nothing references 0.7.0/0.9.0 any more they are collected (the unreadable-file guard is covered below)
    await writeFile(join(H.L.generations, '3.json'), JSON.stringify({ n: 3, mods: [], state: { schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 }, settings: {} }));
    await writeFile(join(H.L.ops, 'op-aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'op-aaaaaaaaaaaaaaaa', input: { type: 'rollback', modId: 'test.x', toVersion: '0.7.0', restoreData: false }, outcome: 'failed', phases: [], startedAt: 'x', endedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }));
    assert.deepEqual((await empty.gcStore()).removed.sort(), ['test.x@0.7.0', 'test.x@0.9.0']);
    assert.deepEqual(await storeList(H), ['test.x@1.0.0', 'test.x@1.1.0']);
  } finally { await H.cleanup(); }
});

test('gcStore refuses to guess: an unreadable state.json in any profile aborts it', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.x' });
    await addVersion(H, 'test.x', '0.5.0');
    const { L2, ops } = otherProfile(H);
    await mkdir(L2.profileDir, { recursive: true });
    await writeFile(L2.state, '{ not json');
    await assert.rejects(ops.gcStore(), (e) => e.code === 'Unavailable');
    assert.deepEqual(await storeList(H), ['test.x@0.5.0', 'test.x@1.0.0']);
  } finally { await H.cleanup(); }
});

test('an install racing gcStore is never deleted: GC waits for the store lock, which is held from verify through record', async () => {
  const H = await harness();
  try {
    let open;
    const gate = new Promise((r) => { open = r; });
    let atGate;
    const reachedGate = new Promise((r) => { atGate = r; });
    // pause the install after its package is in store/ but before state.json references it
    const ops = H.create({ crashAt: async (n) => { if (n === 'store:done') { atGate(); await gate; } } });
    const { ops: other } = otherProfile(H);
    const id = await ops.start({ type: 'install', source: await H.pack({ id: 'test.racer' }) });
    await reachedGate;
    assert.deepEqual(await storeList(H), ['test.racer@1.0.0']);
    let settled = false;
    const gc = other.gcStore().then((r) => { settled = true; return r; });
    await sleep(150);
    assert.equal(settled, false, 'GC must wait while the install holds the store lock');
    open();
    const op = await ops.whenSettled(id);
    assert.equal(op.outcome, 'succeeded');
    const { removed } = await gc;
    assert.deepEqual(removed, []);
    assert.deepEqual(await storeList(H), ['test.racer@1.0.0']);
    assert.ok(!(await H.ls(H.L.store)).includes('.lock'), 'the lock file is removed on release');
  } finally { await H.cleanup(); }
});

test('an update holds the store lock from verify through store; afterwards its journaled result protects the version', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.up' }, { enable: true });
    let open, atGate;
    const gate = new Promise((r) => { open = r; });
    const reached = new Promise((r) => { atGate = r; });
    const ops = H.create({ crashAt: async (n) => { if (n === 'store:done') { atGate(); await gate; } } });
    const id = await ops.start({ type: 'update', modId: 'test.up', source: await H.pack({ id: 'test.up', version: '1.1.0' }) });
    await reached;
    const { ops: other } = otherProfile(H);
    let settled = false;
    const gc = other.gcStore().then((r) => { settled = true; return r; });
    await sleep(120);
    assert.equal(settled, false);
    open();
    assert.equal((await ops.whenSettled(id)).outcome, 'succeeded');
    assert.deepEqual((await gc).removed, [], 'GC ran while the update was in flight: the old version is still needed for a revert');
    assert.deepEqual(await storeList(H), ['test.up@1.0.0', 'test.up@1.1.0']);
    assert.deepEqual((await other.gcStore()).removed, [], 'a terminal op of the last hour still protects the versions it names');
    for (const name of await H.ls(H.L.ops)) {
      const p = join(H.L.ops, name); const o = JSON.parse(await readFile(p, 'utf8'));
      if (o.endedAt) { o.endedAt = new Date(Date.now() - 2 * 3600_000).toISOString(); await writeFile(p, JSON.stringify(o)); }
    }
    assert.deepEqual((await other.gcStore()).removed, ['test.up@1.0.0'], 'an hour later the superseded version is collectable');
  } finally { await H.cleanup(); }
});

test('cross-process store lock: a live foreign pid blocks (Busy after the bound); a dead pid and our own leftover are taken over', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.x' });
    await mkdir(H.L.store, { recursive: true });
    const lockPath = join(H.L.store, '.lock');
    const { ops: impatient } = otherProfile(H, 'p2', { storeLockTimeoutMs: 250 });
    await writeFile(lockPath, JSON.stringify({ pid: process.ppid, token: 'foreign', at: 'x' }));      // the test runner's parent is alive
    await assert.rejects(impatient.gcStore(), (e) => e.code === 'Busy');
    // a stale lock is taken over well within its bound: a generous one, so a loaded machine's slow disk is not taken for a live holder
    const { ops: patient } = otherProfile(H, 'p3', { storeLockTimeoutMs: 10000 });
    // dead holder
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => child.on('exit', r));
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, token: 'dead', at: 'x' }));
    assert.deepEqual((await patient.gcStore()).removed, []);
    assert.ok(!(await H.ls(H.L.store)).includes('.lock'));
    // leftover of a previous incarnation of this very pid
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'old-me', at: 'x' }));
    assert.deepEqual((await patient.gcStore()).removed, []);
    // garbage that never gets completed becomes stale after the grace period (default 5 s is too long here: just check live handling)
    assert.deepEqual(await storeList(H), ['test.x@1.0.0']);
  } finally { await H.cleanup(); }
});

test('a crashed install does not leave the store locked', async () => {
  const H = await harness();
  try {
    const { crashAt, crashed } = H.crashAt('compatibility');
    const ops = H.create({ crashAt });
    await ops.start({ type: 'install', source: await H.pack() });
    await crashed;                  // verify (the staging writes) has finished by the time the crash fires
    await sleep(20);                // let the dead instance's lock release land
    const fresh = H.create();
    await fresh.recover();
    assert.deepEqual((await fresh.gcStore()).removed, []);
    assert.equal((await H.run({ type: 'install', source: await H.pack({ id: 'test.after' }) }, fresh)).outcome, 'succeeded');
  } finally { await H.cleanup(); }
});

test('while an update migrates (store lock already released) GC keeps its version, and other installs are not blocked', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.up' }, { enable: true });
    await H.writeData('test.up', 'd');
    let release;
    const gate = new Promise((r) => { release = r; });
    H.runtime.migrate = async () => { await gate; };
    const id = await H.ops.start({ type: 'update', modId: 'test.up', source: await H.pack({ id: 'test.up', version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, { 'migrate.js': 'x' }) });
    while (!H.runtime.calls.some((c) => c.fn === 'runMigration')) await sleep(5);
    const { ops: other } = otherProfile(H);
    assert.deepEqual((await other.gcStore()).removed, [], 'both versions are referenced: 1.0.0 by state, 2.0.0 by the running op');
    assert.equal((await H.run({ type: 'install', source: await H.pack({ id: 'test.other' }) })).outcome, 'succeeded');
    release();
    assert.equal((await H.ops.whenSettled(id)).outcome, 'succeeded');
  } finally { await H.cleanup(); }
});

test('GC racing an update that commits between its state read and its journal read keeps the new version', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.up' }, { enable: true });
    // the update stores 1.1.0 (lock released), then pauses just before it records the version in state.json
    let openUpdate, atApply;
    const updateGate = new Promise((r) => { openUpdate = r; });
    const updateAtApply = new Promise((r) => { atApply = r; });
    const updater = H.create({ crashAt: async (n) => { if (n === 'apply') { atApply(); await updateGate; } } });
    const upId = await updater.start({ type: 'update', modId: 'test.up', source: await H.pack({ id: 'test.up', version: '1.1.0' }) });
    await updateAtApply;
    // GC in another profile: reads every state (still 1.0.0), then waits before it reads the op journals
    let openGc, atStatesRead;
    const gcGate = new Promise((r) => { openGc = r; });
    const gcAtStates = new Promise((r) => { atStatesRead = r; });
    const { ops: other } = otherProfile(H, 'other', { gcHook: async (where) => { if (where === 'states-read') { atStatesRead(); await gcGate; } } });
    const gc = other.gcStore();
    await gcAtStates;
    openUpdate();
    const done = await updater.whenSettled(upId);                       // commits: state now says 1.1.0, the op is terminal
    assert.equal(done.outcome, 'succeeded');
    openGc();
    const { removed } = await gc;
    assert.ok(!removed.includes('test.up@1.1.0'), `the new version was collected: ${removed}`);
    assert.ok((await storeList(H)).includes('test.up@1.1.0'));
    // terminal ops older than an hour no longer protect anything
    const stale = JSON.parse(JSON.stringify(done));
    stale.id = 'op-bbbbbbbbbbbbbbbb'; stale.endedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    stale.result = { ...stale.result, plan: { modId: 'test.up', from: '0.1.0', to: '0.2.0' } };
    await addVersion(H, 'test.up', '0.1.0'); await addVersion(H, 'test.up', '0.2.0');
    await writeFile(join(H.L.ops, 'op-bbbbbbbbbbbbbbbb.json'), JSON.stringify(stale));
    assert.deepEqual((await other.gcStore()).removed.sort(), ['test.up@0.1.0', 'test.up@0.2.0']);
    stale.endedAt = new Date(Date.now() - 10 * 60_000).toISOString();     // 10 minutes ago: protected
    await addVersion(H, 'test.up', '0.1.0'); await addVersion(H, 'test.up', '0.2.0');
    await writeFile(join(H.L.ops, 'op-bbbbbbbbbbbbbbbb.json'), JSON.stringify(stale));
    assert.deepEqual((await other.gcStore()).removed, []);
  } finally { await H.cleanup(); }
});

test('GC aborts with Unavailable (deleting nothing) when an expected directory cannot be listed', async () => {
  const H = await harness();
  try {
    await H.installApprove({ id: 'test.x' });
    await addVersion(H, 'test.x', '0.5.0');
    await mkdir(H.L.generations, { recursive: true });
    const { ops } = otherProfile(H);
    await chmod(H.L.generations, 0o000);
    try {
      await assert.rejects(ops.gcStore(), (e) => e.code === 'Unavailable' && /generations/.test(e.message));
      assert.deepEqual(await storeList(H), ['test.x@0.5.0', 'test.x@1.0.0']);
    } finally { await chmod(H.L.generations, 0o700); }
    // a missing directory is fine; so is the same GC once readable
    assert.deepEqual((await ops.gcStore()).removed, ['test.x@0.5.0']);
    // the ops directory too
    await chmod(H.L.ops, 0o000);
    try { await assert.rejects(ops.gcStore(), (e) => e.code === 'Unavailable'); } finally { await chmod(H.L.ops, 0o700); }
    // and a stray file under profiles/ is not a profile
    await writeFile(join(H.root, 'profiles', 'README'), 'x');
    assert.deepEqual((await ops.gcStore()).removed, []);
  } finally { await H.cleanup(); }
});

test('stale-lock takeover is serialized by the reaper mutex: six processes contending for a dead holder never overlap', async () => {
  const H = await harness();
  try {
    await mkdir(H.L.store, { recursive: true, mode: 0o700 });
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.on('exit', r));
    await writeFile(join(H.L.store, '.lock'), JSON.stringify({ pid: dead.pid, token: 'dead', at: 'x' }));
    const logFile = join(H.root, 'lock.log');
    await writeFile(logFile, '');
    const child = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
    const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      const p = spawn(process.execPath, [child, H.L.store, logFile, String(i)], { stdio: 'inherit' });
      p.on('exit', resolve);
    }));
    assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0]);
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 12);
    for (let i = 0; i < lines.length; i += 2) {
      const [a, ida] = lines[i].split(' '); const [b, idb] = lines[i + 1].split(' ');
      assert.deepEqual([a, b], ['enter', 'exit'], `critical sections overlapped: ${lines.join(' | ')}`);
      assert.equal(ida, idb);
    }
    assert.deepEqual((await H.ls(H.L.store)).filter((n) => n.startsWith('.lock')), []);
  } finally { await H.cleanup(); }
});

test('reaper mutex: a fresh reap dir blocks takeover (Busy at the bound); one older than 30 s is reclaimed', async () => {
  const H = await harness();
  try {
    await mkdir(H.L.store, { recursive: true, mode: 0o700 });
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.on('exit', r));
    const lockPath = join(H.L.store, '.lock'), reap = join(H.L.store, '.lock.reap');
    await writeFile(lockPath, JSON.stringify({ pid: dead.pid, token: 'dead', at: 'x' }));
    await mkdir(reap);
    const { ops } = otherProfile(H, 'p2', { storeLockTimeoutMs: 250 });
    await assert.rejects(ops.gcStore(), (e) => e.code === 'Busy');
    assert.ok(await H.exists(lockPath), 'the stale lock was not touched without the reaper mutex');
    const old = new Date(Date.now() - 60_000);
    await utimes(reap, old, old);
    // the reclaim, with a bound of its own: the 250 ms above is only for the refusal (under the full suite's load it can take longer)
    const { ops: later } = otherProfile(H, 'p3', { storeLockTimeoutMs: 10_000 });
    assert.deepEqual((await later.gcStore()).removed, []);
    assert.deepEqual((await H.ls(H.L.store)).filter((n) => n.startsWith('.lock')), []);
  } finally { await H.cleanup(); }
});
