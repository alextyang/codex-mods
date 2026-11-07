import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { createRecovery, stockAppConflict } from '../index.mjs';
import { readJson, writeJsonAtomic } from '../../fsutil.mjs';
import { readText, writeTextAtomic } from '../support.mjs';
import { buildInputsHash } from '../../../../builder/build.mjs';
import { fakeBuildReport, fixture, modRecord, makeApp, makeFrameworkTree, writeProfile, baseAdapter } from './helpers.mjs';

const exists = (p) => readFile(p).then(() => true, () => false);
const marker = (f) => readJson(join(f.layout.flags, 'boot.json'));

/** The loader's marker rules (ARCHITECTURE, recovery), re-implemented for the simulated sequence. */
async function simulateLoaderBoot(f) {
  const path = join(f.layout.flags, 'boot.json');
  const m = (await readJson(path, undefined)) ?? { generation: 0, state: 'healthy', unhealthyCount: 0 };
  let count = m.state === 'booting' ? m.unhealthyCount + 1 : 0;
  let reverted = false;
  if (count >= 2) {
    await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'unhealthy-boots' });
    const lkg = await readText(f.layout.frameworkLkg); const cur = await readText(f.layout.frameworkCurrent);
    if (lkg && lkg !== cur) { await writeTextAtomic(f.layout.frameworkCurrent, lkg); reverted = true; count = 0; }
  }
  await writeJsonAtomic(path, { ...m, state: 'booting', unhealthyCount: count, startedAt: new Date().toISOString() });
  return { count, reverted, safe: await exists(join(f.layout.flags, 'safe')) };
}
async function pass(rec, f) {
  rec.report('window-rendered'); rec.report('host-ready'); f.bus.publish('appServer/ready', {}, { state: true });
  await rec.idle();
}

test('beginBoot creates generation 1 with a restorable snapshot and writes it into boot.json', async () => {
  const f = await fixture();
  try {
    f.state.mods.a = modRecord('a', { dataSchemaVersion: 2 });
    f.state.mods.off = modRecord('off', { status: 'disabled' });
    await mkdir(join(f.layout.data, 'a'), { recursive: true });
    await writeFile(join(f.layout.data, 'a', 'settings.json'), JSON.stringify({ x: 1 }));
    await writeJsonAtomic(join(f.layout.flags, 'boot.json'), { state: 'booting', unhealthyCount: 1, startedAt: 't0' });
    const rec = createRecovery(f.base);
    const g = await rec.beginBoot();
    assert.equal(g.n, 1);
    assert.deepEqual(g.mods, [{ id: 'a', version: '1.0.0', dataSchemaVersion: 2 }]);
    assert.deepEqual(g.settings, { a: { x: 1 } });
    assert.equal(g.state.mods.off.status, 'disabled');
    assert.match(g.settingsHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readJson(join(f.layout.generations, '1.json')), g);
    // the loader owns state and unhealthyCount: they are untouched
    assert.deepEqual(await marker(f), { state: 'booting', unhealthyCount: 1, startedAt: 't0', generation: 1 });
    rec.report('fatal');
  } finally { await f.cleanup(); }
});

test('generation is reused when the tuple is equal and replaced when any part changes', async () => {
  const f = await fixture();
  try {
    f.state.mods.a = modRecord('a');
    const g1 = await createRecovery(f.base).beginBoot();
    const again = await createRecovery(f.base).beginBoot();
    assert.equal(again.n, g1.n);
    assert.deepEqual(await readdir(f.layout.generations), ['1.json']);
    // settings change
    await mkdir(join(f.layout.data, 'a'), { recursive: true });
    await writeFile(join(f.layout.data, 'a', 'settings.json'), '{"x":2}');
    assert.equal((await createRecovery(f.base).beginBoot()).n, 2);
    // mod version change
    f.state.mods.a.version = '1.1.0';
    assert.equal((await createRecovery(f.base).beginBoot()).n, 3);
    // framework, adapter and app build each create a generation
    assert.equal((await createRecovery({ ...f.base, frameworkVersion: '2.0.0' }).beginBoot()).n, 4);
    assert.equal((await createRecovery({ ...f.base, adapterVersion: '1.0.1' }).beginBoot()).n, 5);
    assert.equal((await createRecovery({ ...f.base, appBuild: '27.1-1' }).beginBoot()).n, 6);
    // a disabled mod's change is not part of the tuple
    f.state.mods.b = modRecord('b', { status: 'disabled' });
    assert.equal((await createRecovery({ ...f.base, appBuild: '27.1-1' }).beginBoot()).n, 6);
  } finally { await f.cleanup(); }
});

test('a mod\'s overrides at narrower scopes are part of its generation: in the hash and in the snapshot (docs/design/systems.md E3)', async () => {
  const f = await fixture();
  try {
    f.state.mods.a = modRecord('a');
    await mkdir(join(f.layout.data, 'a'), { recursive: true });
    await writeFile(join(f.layout.data, 'a', 'settings.json'), '{"x":1}');
    const g1 = await createRecovery(f.base).beginBoot();
    assert.deepEqual(g1.settingsScopes, {});
    await writeFile(join(f.layout.data, 'a', 'settings.scopes.json'), '{"thread:codex:t1":{"x":2}}');
    const g2 = await createRecovery(f.base).beginBoot();
    assert.equal(g2.n, 2, 'an override is a change of the tuple');
    assert.notEqual(g2.settingsHash, g1.settingsHash);
    assert.deepEqual(g2.settingsScopes, { a: { 'thread:codex:t1': { x: 2 } } });
  } finally { await f.cleanup(); }
});

test('health gate: three signals within 60 s write LKG pointers, the marker and publish healthy', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    await writeProfile(f.layout);
    const target = join(f.layout.apps, '26.1007.21159-20052', 'ChatGPT Mods.app');
    await mkdir(target, { recursive: true });
    await mkdir(join(f.layout.profileDir, '..'), { recursive: true });
    await symlink(target, join(f.layout.root, 'Apps-link'));
    await writeProfile(f.layout, { appPath: join(f.layout.root, 'Apps-link') });
    const rec = createRecovery({ ...f.base, deps: { ...f.base.deps, healthWindowMs: 60000 } });
    await rec.beginBoot();
    rec.report('window-rendered'); rec.report('host-ready');
    await rec.idle();
    assert.equal(rec.lkg(), undefined, 'two of three signals are not enough');
    mock.timers.tick(30000);
    f.bus.publish('appServer/ready', {}, { state: true });   // handshake via the bus subscription
    await rec.idle();
    const lkg = rec.lkg();
    assert.equal(lkg.n, 1);
    assert.ok(lkg.healthyAt);
    assert.equal(await readText(join(f.layout.generations, 'lkg')), '1');
    assert.equal(await readText(f.layout.frameworkLkg), '1.0.0');
    assert.equal(await readText(f.layout.lkgApp), target);
    assert.deepEqual(await marker(f), { ...(await marker(f)), generation: 1, state: 'healthy', unhealthyCount: 0 });
    assert.deepEqual(f.bus.state('framework/health'), { healthy: true });
    mock.timers.tick(60000);
    assert.deepEqual(f.bus.state('framework/health'), { healthy: true }, 'the timeout does nothing after health');
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('health gate: no health after 60 s publishes unhealthy, keeps the marker booting and ignores late signals', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    await writeJsonAtomic(join(f.layout.flags, 'boot.json'), { state: 'booting', unhealthyCount: 0, startedAt: 't' });
    const rec = createRecovery({ ...f.base, deps: { ...f.base.deps, healthWindowMs: 60000 } });
    await rec.beginBoot();
    rec.report('window-rendered'); rec.report('host-ready');
    mock.timers.tick(59999);
    assert.equal(f.bus.state('framework/health'), undefined);
    mock.timers.tick(1);
    assert.deepEqual(f.bus.state('framework/health'), { healthy: false });
    f.bus.publish('appServer/ready', {}, { state: true });
    await rec.idle();
    assert.equal(rec.lkg(), undefined);
    assert.equal((await marker(f)).state, 'booting');
    assert.equal(await exists(f.layout.frameworkLkg), false);
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('health gate: a quarantine event or fatal signal blocks health', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const rec = createRecovery(f.base);
    await rec.beginBoot();
    f.bus.publish('framework/quarantine', { modId: 'a', reason: 'faults' });
    assert.deepEqual(f.bus.state('framework/health'), { healthy: false });
    await pass(rec, f);
    assert.equal(rec.lkg(), undefined);
    assert.equal((await marker(f)).state, 'booting');
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('health preserves the stockAppConflict flag framework-main published', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    f.bus.publish('framework/health', { healthy: false, stockAppConflict: true }, { state: true });
    const rec = createRecovery(f.base);
    await rec.beginBoot();
    rec.report('fatal');
    assert.deepEqual(f.bus.state('framework/health'), { healthy: false, stockAppConflict: true });
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('unhealthy boots are counted with the loader marker sequence and the framework flips back to LKG', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0');
    // boot 1 (framework 1.0.0) is healthy
    assert.equal((await simulateLoaderBoot(f)).count, 0);
    let rec = createRecovery(f.base);
    await rec.beginBoot(); await pass(rec, f);
    assert.equal((await marker(f)).state, 'healthy');
    assert.equal(await readText(f.layout.frameworkLkg), '1.0.0');

    // framework update to 2.0.0 via runOp
    const src = join(f.dir, 'src2'); await makeFrameworkTree(src, { version: '2.0.0' });
    const phases = [];
    const res = await rec.runOp({ id: 'op-1', input: { type: 'framework-update', version: '2.0.0', sourceDir: src }, phases: [] }, async (p) => phases.push(p));
    assert.equal(res.outcome, 'running', 'the verdict comes from a later boot (the loader may still revert)');
    assert.deepEqual(phases, ['copy', 'previous', 'current']);
    assert.equal(await readText(f.layout.frameworkCurrent), '2.0.0');
    assert.equal(await readText(f.layout.frameworkPrevious), '1.0.0');
    assert.deepEqual(f.exits, [{ relaunch: true, reason: 'framework-update' }]);
    assert.ok(await exists(join(f.layout.framework, '2.0.0', 'framework', 'main', 'index.cjs')));

    // boots 2 and 3 never become healthy
    const b2 = await simulateLoaderBoot(f); assert.equal(b2.count, 0);   // previous marker was healthy
    rec = createRecovery({ ...f.base, frameworkVersion: '2.0.0' }); await rec.beginBoot();
    assert.equal((await marker(f)).generation, 2);
    rec.report('fatal');
    const b3 = await simulateLoaderBoot(f); assert.equal(b3.count, 1);
    rec = createRecovery({ ...f.base, frameworkVersion: '2.0.0' }); await rec.beginBoot();
    assert.equal((await marker(f)).generation, 2, 'same tuple: the generation is reused across unhealthy boots');
    const b4 = await simulateLoaderBoot(f);
    assert.equal(b4.reverted, true);
    assert.equal(b4.safe, true);
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.0', 'flipped back to the LKG framework');

    // boot 5 runs 1.0.0 again, reuses generation 1 and is healthy
    await simulateLoaderBoot(f);
    rec = createRecovery(f.base);
    assert.equal((await rec.beginBoot()).n, 3, 'the latest generation (2) differs, so a new one is recorded for the reverted tuple');
    await pass(rec, f);
    assert.equal(rec.lkg().n, 1, 'the loader set flags/safe: a safe-mode boot never becomes last-known-good');
    assert.deepEqual({ s: (await marker(f)).state, c: (await marker(f)).unhealthyCount }, { s: 'healthy', c: 0 });
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('framework-update rejects bad input without touching any pointer', async () => {
  const f = await fixture();
  try {
    const rec = createRecovery(f.base);
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0');
    const run = (input) => rec.runOp({ id: 'op-x', input, phases: [] }, async () => {});
    await assert.rejects(run({ type: 'framework-update', version: '../evil', sourceDir: f.dir }), { code: 'Invalid' });
    await assert.rejects(run({ type: 'framework-update', version: '2.0.0', sourceDir: f.dir }), { code: 'Invalid' });
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.0');
    const src = join(f.dir, 's'); await makeFrameworkTree(src);
    assert.equal((await run({ type: 'framework-update', version: '1.0.0', sourceDir: src })).note.includes('already current'), true);
    assert.deepEqual(f.exits, []);
  } finally { await f.cleanup(); }
});

test('reconcile framework-update: verdict from the pointers, what runs and the LKG', async () => {
  const f = await fixture();
  try {
    const op = (phases) => ({ id: 'op-f', outcome: 'running', input: { type: 'framework-update', version: '2.0.0', sourceDir: '/s' }, phases: phases.map((name) => ({ name, at: 't' })) });
    const rec = (v) => createRecovery({ ...f.base, frameworkVersion: v });
    const all = ['copy', 'previous', 'current'];
    // new framework runs, not yet healthy: stays running
    await writeTextAtomic(f.layout.frameworkCurrent, '2.0.0'); await writeTextAtomic(f.layout.frameworkLkg, '1.0.0');
    assert.equal(await rec('2.0.0').reconcileOp(op(all)), null);
    // healthy once (framework/lkg is the new version): succeeded
    await writeTextAtomic(f.layout.frameworkLkg, '2.0.0');
    assert.equal((await rec('2.0.0').reconcileOp(op(all))).outcome, 'succeeded');
    // current says 2.0.0 but this boot runs something else
    assert.equal((await rec('1.0.0').reconcileOp(op(all))).outcome, 'needs-attention');
    // the loader reverted: current is back on the LKG and that is what runs
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0'); await writeTextAtomic(f.layout.frameworkLkg, '1.0.0'); await writeTextAtomic(f.layout.frameworkPrevious, '1.0.0');
    const rv = await rec('1.0.0').reconcileOp(op(all));
    assert.equal(rv.outcome, 'reverted');
    assert.match(rv.note, /^reverted by loader after unhealthy boots: framework current is 1\.0\.0 \(last-known-good\), expected 2\.0\.0/);
    // pointer is somewhere unexplained
    await writeTextAtomic(f.layout.frameworkCurrent, '3.0.0');
    const na = await rec('1.0.0').reconcileOp(op(all));
    assert.equal(na.outcome, 'needs-attention');
    assert.match(na.note, /framework current is 3\.0\.0.*expected current 2\.0\.0/);
    // no pointer phase recorded: nothing applied, temp dirs cleaned
    await mkdir(join(f.layout.framework, '.install-2.0.0-ab.tmp'), { recursive: true });
    assert.equal((await rec('1.0.0').reconcileOp(op(['copy']))).outcome, 'failed');
    assert.deepEqual((await readdir(f.layout.framework)).filter((n) => n.startsWith('.install-')), []);
    assert.equal(await rec('1.0.0').reconcileOp({ ...op([]), outcome: 'succeeded' }), null);
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ app-switch
async function switchFixture(over = {}) {
  const f = await fixture(over);
  const prev = join(f.layout.apps, 'old', 'ChatGPT Mods.app');
  const cand = join(f.layout.apps, 'new', 'ChatGPT Mods.app');
  await mkdir(prev, { recursive: true }); await mkdir(cand, { recursive: true });
  const stable = join(f.dir, 'Applications', 'ChatGPT Mods.app');
  await mkdir(join(f.dir, 'Applications'), { recursive: true });
  await symlink(prev, stable);
  await writeProfile(f.layout, { appPath: stable, launchArgs: ['--user-data-dir=/qa/userData'] });
  return { ...f, prev, cand, stable };
}
const switchOp = (cand, phases = [], id = 'op-sw') => ({ id, outcome: 'running', input: { type: 'app-switch', candidate: cand }, phases: phases.map((name) => ({ name, at: 't' })) });

test('app-switch runOp journals swapping, spawns the helper detached, exits without relaunch and stays running', async () => {
  const spawned = [];
  const spawn = (cmd, args, o) => { spawned.push({ cmd, args, o }); const c = new (process.getBuiltinModule('node:events').EventEmitter)(); c.unref = () => { c.unrefd = true; }; setImmediate(() => c.emit('spawn')); return c; };
  const f = await switchFixture({ deps: { spawn, appPid: () => 4242 } });
  try {
    const rec = createRecovery(f.base);
    const phases = [];
    const res = await rec.runOp(switchOp(f.cand), async (p) => phases.push(p));
    assert.equal(res.outcome, 'running');
    assert.deepEqual(phases, ['swapping']);
    assert.equal(spawned.length, 1);
    const [cmd, args] = [spawned[0].cmd, spawned[0].args];
    assert.equal(cmd, '/bin/sh');
    assert.match(args[0], /builder\/swap-helper\.sh$/);
    assert.deepEqual(args.slice(1), ['4242', f.stable, f.cand, join(f.layout.flags, 'swap-op-sw.json'), '--user-data-dir=/qa/userData']);
    assert.equal(spawned[0].o.detached, true);
    assert.deepEqual(f.exits, [{ relaunch: false, reason: 'app-switch' }]);
    // a second framework op is refused while the restart is in progress
    await assert.rejects(rec.runOp(switchOp(f.cand, [], 'op-2'), async () => {}), { code: 'Busy' });
  } finally { await f.cleanup(); }
});

test('app-switch rejects candidates outside apps/ and a non-symlink stable path', async () => {
  const f = await switchFixture();
  try {
    const rec = createRecovery(f.base);
    await assert.rejects(rec.runOp(switchOp('/tmp/Evil.app'), async () => {}), { code: 'Invalid' });
    await rm(f.stable); await mkdir(f.stable);
    await assert.rejects(rec.runOp(switchOp(f.cand), async () => {}), { code: 'Conflict' });
    assert.deepEqual(f.exits, []);
  } finally { await f.cleanup(); }
});

test('reconcile app-switch: receipt ok -> succeeded; receipt failure -> failed with the error', async () => {
  const f = await switchFixture();
  try {
    const rec = createRecovery(f.base);
    const receipt = join(f.layout.flags, 'swap-op-sw.json');
    await writeJsonAtomic(receipt, { ok: true, previous: f.prev, at: 't' });
    assert.equal((await rec.reconcileOp(switchOp(f.cand, ['swapping']))).outcome, 'succeeded');
    await writeJsonAtomic(receipt, { ok: false, error: 'open failed; symlink restored to previous', previous: f.prev, at: 't' });
    const r = await rec.reconcileOp(switchOp(f.cand, ['swapping']));
    assert.equal(r.outcome, 'failed');
    assert.match(r.note, /open failed; symlink restored to previous/);
    assert.equal(await exists(receipt), true, 'receipts are never deleted');
  } finally { await f.cleanup(); }
});

test('reconcile app-switch: swapping receipt or none is decided from the actual symlink', async () => {
  const f = await switchFixture();
  try {
    const rec = createRecovery(f.base);
    const receipt = join(f.layout.flags, 'swap-op-sw.json');
    // no receipt, symlink unchanged
    let r = await rec.reconcileOp(switchOp(f.cand, ['swapping']));
    assert.deepEqual([r.outcome, r.note], ['failed', 'swap did not complete']);
    // swapping receipt, symlink on previous
    await writeJsonAtomic(receipt, { state: 'swapping', previous: f.prev, at: 't' });
    r = await rec.reconcileOp(switchOp(f.cand, ['swapping']));
    assert.deepEqual([r.outcome, r.note], ['failed', 'swap did not complete']);
    // swapping receipt, symlink on the candidate
    await rm(f.stable); await symlink(f.cand, f.stable);
    r = await rec.reconcileOp(switchOp(f.cand, ['swapping']));
    assert.deepEqual([r.outcome, r.note], ['succeeded', 'verified from symlink; receipt incomplete']);
    // no receipt at all, symlink on the candidate
    await rm(receipt);
    r = await rec.reconcileOp(switchOp(f.cand, ['swapping']));
    assert.deepEqual([r.outcome, r.note], ['succeeded', 'verified from symlink; receipt incomplete']);
    // a third target is not guessed at
    const other = join(f.layout.apps, 'third', 'ChatGPT Mods.app'); await mkdir(other, { recursive: true });
    await writeJsonAtomic(receipt, { state: 'swapping', previous: f.prev, at: 't' });
    await rm(f.stable); await symlink(other, f.stable);
    assert.equal((await rec.reconcileOp(switchOp(f.cand, ['swapping']))).outcome, 'needs-attention');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ safe-mode and lkg-restore
test('safe-mode op sets state, writes or removes the flag, and relaunches', async () => {
  const f = await fixture({ deps: { exitGraceMs: 0 } });
  try {
    const rec = createRecovery(f.base);
    const phases = [];
    let res = await rec.runOp({ id: 'op-s', input: { type: 'safe-mode', enter: true }, phases: [] }, async (p) => phases.push(p));
    assert.equal(res.outcome, 'succeeded');
    assert.equal(f.state.safeMode, true);
    assert.equal(await exists(join(f.layout.flags, 'safe')), true);
    assert.deepEqual(phases, ['set-state', 'set-flag']);
    res = await rec.runOp({ id: 'op-s2', input: { type: 'safe-mode', enter: false }, phases: [] }, async () => {});
    assert.equal(f.state.safeMode, false);
    assert.equal(await exists(join(f.layout.flags, 'safe')), false);
    assert.deepEqual(f.exits.map((e) => e.relaunch), [true, true]);
  } finally { await f.cleanup(); }
});

async function lkgFixture(deps) {
  const f = await switchFixture({ deps });
  f.state.mods.a = modRecord('a', { version: '1.0.0' });
  await mkdir(join(f.layout.framework, '1.0.0', 'framework', 'main'), { recursive: true });
  const rec1 = createRecovery({ ...f.base, deps: { ...f.base.deps, runningCopy: () => f.prev } });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await rec1.beginBoot(); await pass(rec1, f);
  mock.timers.reset();
  return f;
}
test('lkg-restore (same app build): restores records, leaves safe mode, sets the framework and relaunches', async () => {
  const f = await lkgFixture();
  try {
    // the world moved on: newer framework, safe mode, mod changed
    await writeTextAtomic(f.layout.frameworkCurrent, '2.0.0');
    await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'x' });
    f.state.safeMode = true; f.state.mods.a.version = '9.9.9';
    const rec = createRecovery(f.base);
    const phases = [];
    const res = await rec.runOp({ id: 'op-l', input: { type: 'lkg-restore' }, phases: [] }, async (p) => phases.push(p));
    assert.equal(res.outcome, 'succeeded');
    assert.deepEqual(phases, ['restore-records', 'leave-safe-mode', 'framework-current', 'relaunch']);
    assert.deepEqual(res.result.restored, ['a']);
    assert.equal(f.state.mods.a.version, '1.0.0');
    assert.equal(f.state.safeMode, false);
    assert.equal(await exists(join(f.layout.flags, 'safe')), false);
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.0');
    assert.equal(await readText(f.layout.frameworkPrevious), '2.0.0');
    assert.deepEqual(f.exits, [{ relaunch: true, reason: 'lkg-restore' }]);
  } finally { await f.cleanup(); }
});

test('lkg-restore switches to the LKG candidate path, also when the upstream build is the same (two same-build candidates)', async () => {
  const spawned = [];
  const spawn = (cmd, args) => { spawned.push(args); const c = new (process.getBuiltinModule('node:events').EventEmitter)(); c.unref = () => {}; setImmediate(() => c.emit('spawn')); return c; };
  const f = await lkgFixture({ spawn, appPid: () => 77, exitDelayMs: 0 });
  try {
    // lkg-app holds f.prev (candidate A). The stable path now runs candidate B of the SAME stock build (same appBuild).
    assert.equal(await readText(f.layout.lkgApp), f.prev);
    await rm(f.stable); await symlink(f.cand, f.stable);
    const rec = createRecovery(f.base);                              // appBuild is unchanged
    const phases = [];
    const res = await rec.runOp({ id: 'op-l2', input: { type: 'lkg-restore' }, phases: [] }, async (p) => phases.push(p));
    assert.equal(res.outcome, 'running');
    assert.deepEqual(phases, ['restore-records', 'leave-safe-mode', 'framework-current', 'swapping']);
    assert.deepEqual(spawned[0].slice(1), ['77', f.stable, f.prev, join(f.layout.flags, 'swap-op-l2.json'), '--user-data-dir=/qa/userData']);
    assert.deepEqual(f.exits, [{ relaunch: false, reason: 'app-switch' }]);
    assert.deepEqual(res.result.restored, ['a']);
    assert.equal(await readText(f.layout.lkgApp), f.prev, 'lkg-app still holds the exact candidate path');
  } finally { await f.cleanup(); }
});

test('beginBoot records the exact candidate path; another candidate of the same build is another generation', async () => {
  const f = await switchFixture();
  try {
    const g1 = await createRecovery(f.base).beginBoot();
    assert.equal(g1.appCandidate, f.prev);
    await rm(f.stable); await symlink(f.cand, f.stable);
    const g2 = await createRecovery(f.base).beginBoot();
    assert.equal(g2.appCandidate, f.cand);
    assert.equal(g2.n, g1.n + 1);
  } finally { await f.cleanup(); }
});

test('lkg-restore refuses, changing nothing, when the LKG generation\'s candidate path no longer exists; it never looks at other copies', async () => {
  const f = await lkgFixture();
  try {
    await rm(f.prev, { recursive: true });                     // the LKG candidate is gone; a same-build sibling (f.cand) still exists
    await assert.rejects(createRecovery(f.base).runOp({ id: 'o', input: { type: 'lkg-restore' }, phases: [] }, async () => {}),
      (e) => e.code === 'Unavailable' && e.message.includes(f.prev));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.exits, []);
  } finally { await f.cleanup(); }
});

test('lkg-restore with the stable path already on the LKG candidate just relaunches (no swap)', async () => {
  const spawned = [];
  const f = await lkgFixture({ spawn: (...a) => { spawned.push(a); throw new Error('no spawn expected'); } });
  try {
    const rec = createRecovery(f.base);
    const res = await rec.runOp({ id: 'op-l3', input: { type: 'lkg-restore' }, phases: [] }, async () => {});
    assert.equal(res.outcome, 'succeeded');
    assert.deepEqual(spawned, []);
    assert.deepEqual(f.exits, [{ relaunch: true, reason: 'lkg-restore' }]);
  } finally { await f.cleanup(); }
});

test('lkg-restore without an LKG fails with Unavailable and changes nothing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createRecovery(f.base).runOp({ id: 'o', input: { type: 'lkg-restore' }, phases: [] }, async () => {}), { code: 'Unavailable' });
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('reconcile lkg-restore: the three-way rule over every step postcondition', async () => {
  const f = await lkgFixture();
  try {
    const rec = createRecovery(f.base);
    const op = (phases) => ({ id: 'op-r', outcome: 'running', input: { type: 'lkg-restore' }, phases: phases.map((name) => ({ name, at: 't' })) });
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0');
    assert.equal((await rec.reconcileOp(op(['restore-records', 'leave-safe-mode', 'framework-current', 'relaunch']))).outcome, 'succeeded');
    // framework pointer was not reached
    await writeTextAtomic(f.layout.frameworkCurrent, '2.0.0');
    let r = await rec.reconcileOp(op(['restore-records', 'leave-safe-mode', 'framework-current']));
    assert.equal(r.outcome, 'needs-attention');
    assert.match(r.note, /framework current is 2\.0\.0, expected 1\.0\.0/);
    // safe mode still on
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0');
    f.state.safeMode = true;
    r = await rec.reconcileOp(op(['restore-records', 'leave-safe-mode']));
    assert.equal(r.outcome, 'needs-attention'); assert.match(r.note, /safe mode is still on/);
    f.state.safeMode = false;
    // records not restored
    f.state.mods.a.version = '9.9.9';
    r = await rec.reconcileOp(op(['restore-records']));
    assert.equal(r.outcome, 'needs-attention'); assert.match(r.note, /records not restored/);
    // no effect phase at all and the target not reached
    r = await rec.reconcileOp(op([]));
    assert.equal(r.outcome, 'failed');
    // a mod left disabled (schema mismatch) is a valid restored state
    f.state.mods.a.version = '1.0.0'; f.state.mods.a.status = 'disabled';
    assert.equal((await rec.reconcileOp(op(['restore-records', 'framework-current', 'leave-safe-mode']))).outcome, 'succeeded');
  } finally { await f.cleanup(); }
});

test('reconcile lkg-restore with a pending app-switch follows the app-switch rule (decided by candidate path)', async () => {
  const f = await lkgFixture();
  try {
    await rm(f.stable); await symlink(f.cand, f.stable);      // a same-build candidate B is selected; the LKG candidate is A (generation.appCandidate)
    await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0');
    const rec = createRecovery(f.base);
    const op = { id: 'op-r2', outcome: 'running', input: { type: 'lkg-restore' }, phases: ['restore-records', 'leave-safe-mode', 'framework-current', 'swapping'].map((name) => ({ name, at: 't' })) };
    let r = await rec.reconcileOp(op);
    assert.equal(r.outcome, 'needs-attention'); assert.match(r.note, /swap did not complete/);
    await rm(f.stable); await symlink(f.prev, f.stable);
    r = await rec.reconcileOp(op);
    assert.equal(r.outcome, 'succeeded'); assert.match(r.note, /verified from symlink/);
  } finally { await f.cleanup(); }
});

test('reconcile safe-mode and app-prepare', async () => {
  const f = await fixture();
  try {
    const rec = createRecovery(f.base);
    const sm = (enter, phases) => ({ id: 'o', outcome: 'running', input: { type: 'safe-mode', enter }, phases: phases.map((name) => ({ name, at: 't' })) });
    assert.equal((await rec.reconcileOp(sm(false, ['set-state']))).outcome, 'succeeded');
    f.state.safeMode = true;
    assert.equal((await rec.reconcileOp(sm(false, ['set-state']))).outcome, 'needs-attention');
    assert.equal((await rec.reconcileOp(sm(false, []))).outcome, 'failed');
    // app-prepare: the partial candidate is deleted, the one in use is not
    const part = join(f.layout.apps, 'B1'); await mkdir(part, { recursive: true }); await writeFile(join(part, 'junk'), 'x');
    const res = await rec.reconcileOp({ id: 'p', outcome: 'running', input: { type: 'app-prepare' }, phases: ['inspect', 'build:B1', 'build-copy'].map((name) => ({ name, at: 't' })) });
    assert.equal(res.outcome, 'failed');
    assert.equal(await exists(join(part, 'junk')), false);
    const used = join(f.layout.apps, 'B2'); await mkdir(used, { recursive: true });
    await writeTextAtomic(f.layout.lkgApp, join(used, 'ChatGPT Mods.app'));
    await rec.reconcileOp({ id: 'p', outcome: 'running', input: { type: 'app-prepare' }, phases: [{ name: 'build:B2', at: 't' }] });
    assert.equal((await readdir(f.layout.apps)).includes('B2'), true, 'a copy in use is never deleted');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ app-prepare
test('app-prepare uses an existing adapter pack, builds into apps/<build>/ and reports compatibility', async () => {
  const f = await fixture();
  try {
    const stock = join(f.dir, 'Stock.app'); await makeApp(stock, '27.0', '777');
    await makeFrameworkTree(join(f.layout.framework, '1.0.0'));
    await writeProfile(f.layout, { signingIdentity: 'Test Identity' });
    const pack = baseAdapter({ build: { version: '27.0', bundleVersion: '777', asarSha256: 'y', electronVersion: '40' }, anchors: { 'settings.section': { selectors: ['x'], placement: 'inside' } } });
    await writeJsonAtomic(join(f.layout.adapters, '27.0-777', 'adapter.json'), pack);
    // the candidate's census beside its pack (E4): its schema and its AppHost services, complete
    const fam = (values, extra = {}) => ({ status: 'ok', values, digestSha256: 'd', ...extra });
    await writeJsonAtomic(join(f.layout.adapters, '27.0-777', 'build-facts.json'), { census: 1, build: { name: 'x', version: '27.0', buildNumber: '777' },
      families: { 'protocol.schema': fam(['ClientRequest:thread/start'], { fingerprints: {} }), 'protocol.wireOnly': fam([]), 'apphost.services': fam(['openIn']) } });
    // installed mods: what each needs, against the candidate
    for (const id of ['ok', 'bad', 'deg', 'risky']) f.state.mods[id] = modRecord(id);
    const put = async (id, manifest) => { await mkdir(join(f.layout.store, id, '1.0.0'), { recursive: true }); await writeFile(join(f.layout.store, id, '1.0.0', 'mod.json'), JSON.stringify(manifest)); };
    await put('ok', { requires: { methods: ['thread/start'] } });
    await put('bad', { requires: { features: ['service:gitRepository'] } });   // the candidate's complete services list lacks it
    await put('deg', { optional: { features: ['anchor:composer.toolbar'] } });
    await put('risky', { requires: { methods: ['nope/missing'] } });   // in neither schema: it may be wire-only
    const builds = [];
    const runBuilder = async (args) => {
      builds.push(args);
      const out = args[args.indexOf('--out') + 1];
      await mkdir(join(out, 'ChatGPT Mods.app', 'Contents'), { recursive: true });
      // a fake build run that writes its report the way the real builder does: via the real buildInputsHash
      const arg = (n) => args[args.indexOf(n) + 1];
      const inputsHash = buildInputsHash({ adapterBytes: await readFile(arg('--adapter')), loaderBytes: await readFile(arg('--loader')),
        relayBytes: await readFile(arg('--relay')), identity: arg('--identity'), frameworkVersion: arg('--framework-version') });
      await writeFile(join(out, 'build-report.json'), JSON.stringify(await fakeBuildReport(args, inputsHash)));
    };
    const rec = createRecovery({ ...f.base, deps: { ...f.base.deps, stockApp: stock, runBuilder } });
    const phases = [];
    const res = await rec.runOp({ id: 'op-p', input: { type: 'app-prepare' }, phases: [] }, async (p) => phases.push(p));
    assert.equal(res.outcome, 'succeeded');
    assert.equal(phases.length, 3);
    assert.match(phases[1], /^build:27\.0-777-[0-9a-f]{16}$/);
    assert.equal(res.result.appBuild, '27.0-777');
    assert.equal(res.result.candidate, join(f.layout.apps, `27.0-777-${res.result.inputsHash}`, 'ChatGPT Mods.app'));
    assert.equal(phases[1], `build:27.0-777-${res.result.inputsHash}`);
    const report = JSON.parse(await readFile(join(f.layout.apps, `27.0-777-${res.result.inputsHash}`, 'build-report.json'), 'utf8'));
    assert.equal(basename(dirname(res.result.candidate)), `27.0-777-${report.inputsHash}`, 'directory name == <build>-<build-report.inputsHash>');
    assert.equal(builds[0][builds[0].indexOf('--framework-version') + 1], '1.0.0');
    assert.deepEqual(res.result.compatibility.summary, { compatible: 1, degraded: 1, atRisk: 1, blocked: 1, unknown: 0 });
    assert.deepEqual(res.result.compatibility.mods.bad.missingRequired, ['service:gitRepository']);
    assert.match(res.result.compatibility.mods.bad.reasons[0].sentence, /^It needs the app's gitRepository service, which this build of the app lacks/);
    assert.equal(res.result.compatibility.mods.risky.status, 'atRisk');
    const args = builds[0];
    assert.equal(args[args.indexOf('--identity') + 1], 'Test Identity');
    assert.equal(args[args.indexOf('--adapter') + 1], join(f.layout.adapters, '27.0-777', 'adapter.json'));
    assert.equal(args[args.indexOf('--root') + 1], f.layout.root);
    assert.equal(args[args.indexOf('--stock') + 1], stock);
    // preparing again reuses the complete candidate without rebuilding
    const again = await rec.runOp({ id: 'op-p2', input: { type: 'app-prepare' }, phases: [] }, async () => {});
    assert.equal(builds.length, 1);
    assert.equal(again.note, 'candidate already built');
    // #18: a changed adapter (same stock build) is a different input set -> a distinct, immutable candidate; the old one is untouched
    await writeJsonAtomic(join(f.layout.adapters, '27.0-777', 'adapter.json'), { ...pack, adapterVersion: '1.0.1' });
    const changed = await rec.runOp({ id: 'op-p3', input: { type: 'app-prepare' }, phases: [] }, async () => {});
    assert.equal(builds.length, 2);
    assert.notEqual(changed.result.candidate, res.result.candidate);
    assert.notEqual(changed.result.inputsHash, res.result.inputsHash);
    await readdir(join(res.result.candidate, 'Contents')); // the old candidate is untouched
    assert.equal((await readdir(f.layout.apps)).length, 2);
    // so does a different signing identity or framework version
    await writeProfile(f.layout, { signingIdentity: 'Other' });
    assert.equal((await rec.runOp({ id: 'op-p4', input: { type: 'app-prepare' }, phases: [] }, async () => {})).note, undefined);
    assert.equal(builds.length, 3);
  } finally { await f.cleanup(); }
});

test('app-prepare without a pack runs the refresh from the previous (running) pack and cleans up when the build fails', async () => {
  const f = await fixture();
  try {
    const stock = join(f.dir, 'Stock.app'); await makeApp(stock, '28.0', '1');
    await makeFrameworkTree(join(f.layout.framework, '1.0.0'));
    await writeProfile(f.layout);
    const refreshed = [];
    const refreshAdapter = async ({ previous, outDir }) => {
      refreshed.push(previous.adapterVersion);
      const adapter = { ...previous, build: { ...previous.build, version: '28.0', bundleVersion: '1' } };
      await mkdir(outDir, { recursive: true });
      await writeJsonAtomic(join(outDir, 'adapter.json'), adapter);
      return { adapterPath: join(outDir, 'adapter.json'), adapter, report: { transforms: { t1: { missed: true } }, anchors: { 'settings.section': { missed: true } }, protocol: { regenerated: false, reason: 'no tool' } } };
    };
    const runBuilder = async (args) => { await writeFile(join(args[args.indexOf('--out') + 1], 'partial'), 'x'); throw new Error('boom'); };
    const rec = createRecovery({ ...f.base, deps: { ...f.base.deps, stockApp: stock, refreshAdapter, runBuilder } });
    const phases = [];
    await assert.rejects(rec.runOp({ id: 'op-p', input: { type: 'app-prepare' }, phases: [] }, async (p) => phases.push(p)), /boom/);
    assert.equal(phases.length, 4);
    assert.deepEqual([phases[0], phases[1]], ['inspect', 'refresh-adapter']);
    assert.match(phases[2], /^build:28\.0-1-[0-9a-f]{16}$/);
    assert.deepEqual(refreshed, ['1.0.0']);
    assert.deepEqual(await readdir(f.layout.apps), [], 'the partial candidate is removed');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ misc
test('appUpdateAvailable compares the stock Info.plist with the adapter build', async () => {
  const f = await fixture();
  try {
    const stock = join(f.dir, 'Stock.app');
    const rec = () => createRecovery({ ...f.base, deps: { ...f.base.deps, stockApp: stock } });
    assert.equal(rec().appUpdateAvailable(), null, 'no stock app');
    await makeApp(stock, '26.1007.21159', '20052');
    assert.equal(rec().appUpdateAvailable(), null);
    await makeApp(stock, '26.1100.1', '30000');
    assert.deepEqual(rec().appUpdateAvailable(), { stockBuild: '26.1100.1-30000', copyBuild: '26.1007.21159-20052' });
  } finally { await f.cleanup(); }
});

test('stockAppConflict is informational: {conflict, processes}; inspection failure is "unknown", never silently false', async () => {
  const exe = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const ps = (lines) => async () => `  PID COMM\n${lines.join('\n')}\n`;
  assert.deepEqual(await stockAppConflict({ guardStockApp: true }, { ps: ps([`  101 ${exe}`, `  202 ${exe}`]) }),
    { conflict: true, processes: [{ pid: 101, command: exe }, { pid: 202, command: exe }] });
  assert.deepEqual(await stockAppConflict({ guardStockApp: false }, { ps: ps([`  101 ${exe}`]) }), { conflict: false, processes: [] });
  assert.deepEqual(await stockAppConflict({ guardStockApp: true }, { ps: ps(['  101 /Users/x/Applications/ChatGPT Mods.app/Contents/MacOS/ChatGPT', `  102 ${exe}-helper`]) }),
    { conflict: false, processes: [] });
  const unknown = await stockAppConflict({ guardStockApp: true }, { ps: async () => { throw new Error('ps failed'); } });
  assert.equal(unknown.conflict, 'unknown');
  assert.deepEqual(unknown.processes, []);
  assert.match(unknown.error, /ps failed/);
  // the real ps runs and finds nothing for a path that cannot exist
  assert.deepEqual(await stockAppConflict({ guardStockApp: true }, { stockExecutable: '/nonexistent/codexmods-test' }), { conflict: false, processes: [] });
});

test('Generation.appCandidate and lkg-app come from runningAppPath, not the symlink target; headless falls back to the symlink with a logged note', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = await switchFixture();                       // stable symlink -> f.prev
  try {
    const running = f.cand;                              // the bundle really running (e.g. launched from another path)
    const rec = createRecovery({ ...f.base, runningAppPath: running });
    const g = await rec.beginBoot();
    assert.equal(g.appCandidate, running);
    await pass(rec, f);
    assert.equal(rec.lkg().appCandidate, running);
    assert.equal(await readText(f.layout.lkgApp), running);
    // headless: no runningAppPath -> the symlink target, with a note in the log
    const f2 = await switchFixture();
    const g2 = await createRecovery(f2.base).beginBoot();
    assert.equal(g2.appCandidate, f2.prev);
    assert.ok(f2.log.entries.some((e) => /runningAppPath not provided/.test(e.msg)));
    await f2.cleanup();
  } finally { mock.timers.reset(); await f.cleanup(); }
});
