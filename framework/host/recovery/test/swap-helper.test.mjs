// builder/swap-helper.sh in a temp dir: fake .app directories, a symlink stable path, fake pids, fake `open`.
// Nothing here touches a real app or ~/Applications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, symlink, stat, rm, lstat } from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecovery } from '../index.mjs';
import { fixture, writeProfile } from './helpers.mjs';

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'builder', 'swap-helper.sh');

async function world(f) {
  const prev = join(f.dir, 'apps', 'old', 'ChatGPT Mods.app'); const cand = join(f.dir, 'apps', 'new', 'ChatGPT Mods.app');
  await mkdir(join(prev, 'Contents'), { recursive: true }); await mkdir(join(cand, 'Contents'), { recursive: true });
  const stable = join(f.dir, 'Applications', 'ChatGPT Mods.app');
  await mkdir(dirname(stable), { recursive: true });
  await symlink(prev, stable);
  // fake `open`: logs "<args> -> <symlink target at call time>"; fails on its first call when FAIL_FIRST is set
  const log = join(f.dir, 'open.log'); const count = join(f.dir, 'open.count');
  const openBin = join(f.dir, 'fake-open');
  await writeFile(openBin, `#!/bin/sh
n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"
echo "$* -> $(readlink "$2")" >> "${log}"
if [ -n "$FAIL_FIRST" ] && [ "$n" = 1 ]; then exit 1; fi
exit 0
`, { mode: 0o755 });
  // perl wrapper that refuses the symlink rename but still serves the receipt writer
  const perlBin = join(f.dir, 'fake-perl');
  await writeFile(perlBin, `#!/bin/sh
case "$2" in *'rename($ARGV[0], $ARGV[1]) or die $!'*) echo "rename refused" >&2; exit 1;; esac
exec /usr/bin/perl "$@"
`, { mode: 0o755 });
  const receipt = join(f.layout.flags, 'swap-op-test.json');
  return { prev, cand, stable, openBin, perlBin, receipt, openLog: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}
function runHelper(w, pid, env = {}, launchArgs = []) {
  const child = spawn('/bin/sh', [HELPER, String(pid), w.stable, w.cand, w.receipt, ...launchArgs], { env: { PATH: process.env.PATH, CODEXMODS_SWAP_OPEN: w.openBin, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res) => child.once('close', (code) => res({ code, err })));
  return { child, done };
}
const deadPid = async () => { const c = spawn('/bin/sh', ['-c', 'exit 0']); await new Promise((r) => c.once('close', r)); return c.pid; };
const readReceipt = async (w) => JSON.parse(await readFile(w.receipt, 'utf8'));

test('swap helper waits for the pid, replaces the symlink atomically, writes the receipt and opens the stable path', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    const app = spawn('sleep', ['60']);                // the "app"
    const { done } = runHelper(w, app.pid);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(readlinkSync(w.stable), w.prev, 'nothing changes while the app is still running');
    await assert.rejects(readFile(w.receipt), { code: 'ENOENT' });
    // watch the stable path while the helper swaps: it must never be missing
    let missing = 0, watching = true;
    const watcher = (async () => { while (watching) { try { readlinkSync(w.stable); } catch { missing++; } await new Promise((r) => setImmediate(r)); } })();
    app.kill('SIGKILL');
    const { code, err } = await done;
    watching = false; await watcher;
    assert.equal(code, 0, err);
    assert.equal(missing, 0, 'the stable path was never absent');
    assert.equal(readlinkSync(w.stable), w.cand);
    const r = await readReceipt(w);
    assert.equal(r.ok, true); assert.equal(r.previous, w.prev); assert.equal(r.candidate, w.cand); assert.ok(r.at);
    assert.equal((await stat(w.receipt)).mode & 0o777, 0o600);
    assert.deepEqual(await w.openLog(), [`-n ${w.stable} -> ${w.cand}`], 'opened once, after the swap');
    assert.deepEqual((await readdir(dirname(w.stable))).sort(), ['ChatGPT Mods.app'], 'no temp links left behind');
    // the bundles were never moved
    assert.ok((await lstat(join(w.prev, 'Contents'))).isDirectory()); assert.ok((await lstat(join(w.cand, 'Contents'))).isDirectory());
  } finally { await f.cleanup(); }
});

test('swap helper: an app that does not exit leaves the symlink alone, reports it and opens NOTHING (the original instance is still running)', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    const app = spawn('sleep', ['60']);
    try {
      const { code } = await runHelper(w, app.pid, { CODEXMODS_SWAP_WAIT_SECS: '1' }).done;
      assert.equal(code, 1);
      const r = await readReceipt(w);
      assert.deepEqual([r.ok, r.error, r.previous], [false, 'app did not exit', w.prev]);
      assert.equal(readlinkSync(w.stable), w.prev);
      assert.deepEqual(await w.openLog(), [], 'no competing instance is launched');
    } finally { app.kill('SIGKILL'); }
  } finally { await f.cleanup(); }
});

test('swap helper: a failing rename leaves the symlink unchanged, cleans up, reopens the old app and reports', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    const { code } = await runHelper(w, await deadPid(), { CODEXMODS_SWAP_PERL: w.perlBin }).done;
    assert.equal(code, 1);
    assert.equal(readlinkSync(w.stable), w.prev);
    const r = await readReceipt(w);
    assert.equal(r.ok, false); assert.match(r.error, /could not replace the symlink/); assert.equal(r.previous, w.prev);
    assert.deepEqual((await readdir(dirname(w.stable))).sort(), ['ChatGPT Mods.app'], 'the temp link was removed');
    assert.deepEqual(await w.openLog(), [`-n ${w.stable} -> ${w.prev}`]);
  } finally { await f.cleanup(); }
});

test('swap helper: when open fails it re-points the symlink to previous, reopens and reports ok:false', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    const { code } = await runHelper(w, await deadPid(), { FAIL_FIRST: '1' }).done;
    assert.equal(code, 1);
    assert.equal(readlinkSync(w.stable), w.prev, 'restored');
    const r = await readReceipt(w);
    assert.equal(r.ok, false); assert.match(r.error, /open failed; symlink restored to previous/); assert.equal(r.previous, w.prev);
    assert.deepEqual(await w.openLog(), [`-n ${w.stable} -> ${w.cand}`, `-n ${w.stable} -> ${w.prev}`]);
  } finally { await f.cleanup(); }
});

test('swap helper refuses a stable path that is not a symlink and a missing candidate', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    await rm(w.stable); await mkdir(join(w.stable, 'Contents'), { recursive: true });
    let res = await runHelper(w, await deadPid()).done;
    assert.equal(res.code, 1);
    assert.match((await readReceipt(w)).error, /not a symlink/);
    assert.ok((await lstat(join(w.stable, 'Contents'))).isDirectory(), 'the real bundle is untouched');
    await rm(w.stable, { recursive: true }); await symlink(w.prev, w.stable); await rm(w.cand, { recursive: true });
    res = await runHelper(w, await deadPid()).done;
    assert.equal(res.code, 1);
    assert.match((await readReceipt(w)).error, /candidate does not exist/);
    assert.equal(readlinkSync(w.stable), w.prev);
  } finally { await f.cleanup(); }
});

test('swap helper rejects a wrong argument count', async () => {
  const c = spawn('/bin/sh', [HELPER, '1', 'a']);
  const code = await new Promise((r) => c.once('close', r));
  assert.equal(code, 64);
});

test('reconcileOp reads the helper\'s real receipts: success, failure and a receipt cut off at "swapping"', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    await writeProfile(f.layout, { appPath: w.stable });
    const rec = createRecovery(f.base);
    const op = { id: 'op-test', outcome: 'running', input: { type: 'app-switch', candidate: w.cand }, phases: [{ name: 'swapping', at: 't' }] };
    // failure: rename refused -> failed with the helper's error
    await runHelper(w, await deadPid(), { CODEXMODS_SWAP_PERL: w.perlBin }).done;
    let r = await rec.reconcileOp(op);
    assert.equal(r.outcome, 'failed'); assert.match(r.note, /could not replace the symlink/);
    // success
    await runHelper(w, await deadPid()).done;
    r = await rec.reconcileOp(op);
    assert.equal(r.outcome, 'succeeded');
    // helper killed right after writing the swapping receipt (simulated): the symlink decides
    await writeFile(w.receipt, JSON.stringify({ state: 'swapping', previous: w.prev, candidate: w.cand, at: 't' }));
    r = await rec.reconcileOp(op);
    assert.deepEqual([r.outcome, r.note], ['succeeded', 'verified from symlink; receipt incomplete']);
    await rm(w.stable); await symlink(w.prev, w.stable);
    r = await rec.reconcileOp(op);
    assert.deepEqual([r.outcome, r.note], ['failed', 'swap did not complete']);
    assert.ok(await readFile(w.receipt, 'utf8'), 'the receipt is still there');
  } finally { await f.cleanup(); }
});

test('runOp app-switch with the real spawn: the detached helper waits for the app pid, swaps, and reconcileOp then reports succeeded', async () => {
  const f = await fixture({ deps: { exitDelayMs: 0 } });
  const saved = process.env.CODEXMODS_SWAP_OPEN;
  const app = spawn('sleep', ['60']);
  try {
    const w = await world(f);
    await writeProfile(f.layout, { appPath: w.stable });
    process.env.CODEXMODS_SWAP_OPEN = w.openBin;
    const rec = createRecovery({ ...f.base, deps: { ...f.base.deps, appPid: () => app.pid } });
    const op = { id: 'op-test', outcome: 'running', input: { type: 'app-switch', candidate: w.cand }, phases: [] };
    const res = await rec.runOp(op, async (p) => op.phases.push({ name: p, at: 't' }));
    assert.equal(res.outcome, 'running');
    assert.deepEqual(f.exits, [{ relaunch: false, reason: 'app-switch' }]);
    assert.equal(readlinkSync(w.stable), w.prev, 'still the old copy while the app has not exited');
    app.kill('SIGKILL');                                   // the app exits (relaunch:false); the helper takes over
    for (let i = 0; i < 100 && !(await readFile(w.receipt, 'utf8').then((t) => JSON.parse(t).ok === true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readlinkSync(w.stable), w.cand);
    // "next boot": a new Recovery finishes the op from the receipt
    const next = await createRecovery(f.base).reconcileOp(op);
    assert.equal(next.outcome, 'succeeded');
  } finally {
    app.kill('SIGKILL');
    if (saved === undefined) delete process.env.CODEXMODS_SWAP_OPEN; else process.env.CODEXMODS_SWAP_OPEN = saved;
    await f.cleanup();
  }
});

test('swap helper passes the profile launchArgs to every reopen: normal and rollback', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    const args = ['--user-data-dir=/qa/userData', '--flag with space'];
    const ud = `--user-data-dir=/qa/userData --flag with space`;
    let r = await runHelper(w, await deadPid(), {}, args).done;
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await w.openLog(), [`-n ${w.stable} --args ${ud} -> ${w.cand}`]);
    // open fails -> restore + reopen, both with the args
    await rm(join(f.dir, 'open.log')); await rm(join(f.dir, 'open.count'));
    await rm(w.stable); await symlink(w.prev, w.stable);
    r = await runHelper(w, await deadPid(), { FAIL_FIRST: '1' }, args).done;
    assert.equal(r.code, 1);
    assert.deepEqual(await w.openLog(), [`-n ${w.stable} --args ${ud} -> ${w.cand}`, `-n ${w.stable} --args ${ud} -> ${w.prev}`]);
    // the app does not exit
    await rm(join(f.dir, 'open.log')); await rm(join(f.dir, 'open.count'));
    const app = spawn('sleep', ['60']);
    try {
      await runHelper(w, app.pid, { CODEXMODS_SWAP_WAIT_SECS: '1' }, args).done;
      assert.deepEqual(await w.openLog(), [], 'a timed-out wait never reopens, with or without launchArgs');
    } finally { app.kill('SIGKILL'); }
  } finally { await f.cleanup(); }
});

// perl wrapper that refuses every symlink rename (restore included) once `open` has failed once
test('swap helper: open fails and the rollback also fails -> rollbackFailed receipt; reconcile sees the candidate selected -> needs-attention', async () => {
  const f = await fixture();
  try {
    const w = await world(f);
    await writeProfile(f.layout, { appPath: w.stable });
    // fake perl: allow the first symlink rename (the swap), refuse the second (the restore)
    const perl2 = join(f.dir, 'fake-perl2'); const seen = join(f.dir, 'renames');
    await writeFile(perl2, `#!/bin/sh
case "$2" in *'rename($ARGV[0], $ARGV[1]) or die $!'*)
  n=$(cat "${seen}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${seen}"
  if [ "$n" -ge 2 ]; then echo refused >&2; exit 1; fi;; esac
exec /usr/bin/perl "$@"
`, { mode: 0o755 });
    const { code } = await runHelper(w, await deadPid(), { CODEXMODS_SWAP_PERL: perl2, FAIL_FIRST: '1' }).done;
    assert.equal(code, 1);
    const r = await readReceipt(w);
    assert.equal(r.ok, false); assert.equal(r.rollbackFailed, true); assert.match(r.error, /could not restore the symlink/);
    assert.equal(readlinkSync(w.stable), w.cand, 'the candidate is still selected');
    const rec = createRecovery(f.base);
    const res = await rec.reconcileOp({ id: 'op-test', outcome: 'running', input: { type: 'app-switch', candidate: w.cand }, phases: [{ name: 'swapping', at: 't' }] });
    assert.equal(res.outcome, 'needs-attention');
    assert.match(res.note, /candidate/);
    // a plain ok:false receipt whose symlink really is on the candidate is also needs-attention, never failed
    await writeFile(w.receipt, JSON.stringify({ ok: false, error: 'x', previous: w.prev }));
    assert.equal((await rec.reconcileOp({ id: 'op-test', outcome: 'running', input: { type: 'app-switch', candidate: w.cand }, phases: [] })).outcome, 'needs-attention');
    await rm(w.stable); await symlink(w.prev, w.stable);
    assert.equal((await rec.reconcileOp({ id: 'op-test', outcome: 'running', input: { type: 'app-switch', candidate: w.cand }, phases: [] })).outcome, 'failed');
  } finally { await f.cleanup(); }
});
