// Loader unit tests: real fs under a temp root, fake electron, loader source evaluated with an injected require/process.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readlinkSync, readdirSync, utimesSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from '../contracts/layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'loader.cjs'), 'utf8');
const realRequire = createRequire(import.meta.url);

let root, L;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cm-ldr-')); L = layout(root, 'default'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const writeText = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Installs framework/<version>/framework/main/index.cjs that records start() calls into process.__started. */
function installFramework(version, body) {
  writeText(join(L.framework, version, 'framework', 'main', 'index.cjs'),
    body ?? `exports.start = (o) => { (process.__started ||= []).push({ version: ${JSON.stringify(version)}, o }); };`);
}

function runLoader({ env = {}, electronThrows = false, source = SRC, pid = process.pid, ps, dialogChoice = 0, dialogRaw = null, dialogThrows = false, execPath = '/fake/App.app/Contents/MacOS/App', openStatus = 0, openThrows = false, argv = ['/fake/App'], procs = {} } = {}) {
  const calls = { setPath: [], relaunch: 0, exit: [], processExit: [], onExit: [], spawn: [], dialogs: [], ready: [], psArgs: [], signals: [] };
  const seq = Array.isArray(dialogChoice) ? [...dialogChoice] : null;
  const electron = { dialog: { showMessageBoxSync: (o) => { calls.dialogs.push(o); if (dialogThrows === true || (typeof dialogThrows === 'number' && calls.dialogs.length === dialogThrows)) throw new Error('no dialog'); return dialogRaw ? dialogRaw() : seq ? seq.shift() : dialogChoice; } }, app: {
    once: (ev, fn) => { if (ev === 'ready') calls.ready.push(fn); },
    setPath: (k, v) => calls.setPath.push([k, v]),
    relaunch: () => { calls.relaunch++; }, exit: (c) => calls.exit.push(c) } };
  const fakeProcess = { env: { ...env }, pid, argv, kill: (target, sig) => {
      const p = procs[target];
      if (!p) return process.kill(target, sig);                          // real pids (lock holders etc.) behave for real
      if (sig === 0) { if (!p.alive) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; }
      calls.signals.push([target, sig]);
      if ((sig === 'SIGKILL' && !p.immortal) || (sig === 'SIGTERM' && !p.survivesTerm)) p.alive = false;
      return true;
    }, execPath, exit: (c) => calls.processExit.push(c), on: (ev, fn) => { if (ev === 'exit') calls.onExit.push(fn); }, __started: [], resourcesPath: join(root, 'App.app', 'Contents', 'Resources') };
  const req = (id) => {
    if (id === 'electron') { if (electronThrows) throw new Error('no electron'); return electron; }
    if (id.startsWith('/') && id.endsWith('index.cjs')) {
      const m = realRequire(id);
      return { start: (o) => { fakeProcess.__started.push(o); return m.start(o); } };
    }
    if (id === 'child_process' && (ps !== undefined || true)) {
      return { execFileSync: (cmd, args) => { calls.psArgs.push([cmd, ...args]); const v = typeof ps === 'function' ? ps(calls.psArgs.length - 1) : ps; if (v instanceof Error) throw v; if (v === undefined) return ''; return v; },
        spawn: (cmd, args, o) => { calls.spawn.push([cmd, args, o]); return { unref() {} }; },
        spawnSync: (cmd, args, o) => { calls.spawn.push([cmd, args, o]); if (openThrows) throw new Error('spawnSync failed'); return { status: openStatus }; } };
    }
    return realRequire(id);
  };
  const src = source.replace('__CODEXMODS_ROOT__', root);
  new Function('require', 'process', src)(req, fakeProcess);
  return { calls, started: fakeProcess.__started, env: fakeProcess.env };
}

const core = (o) => ({ root: o.root, profile: o.profile, safe: o.safe });
const setup = ({ profile = true, version = 'v1' } = {}) => {
  if (profile) writeJson(L.profileConfig, { codexHome: join(root, 'custom-home'), guardStockApp: false, signingIdentity: '-', appPath: join(root, 'ChatGPT Mods.app') });
  if (version) { installFramework(version); writeText(L.frameworkCurrent, version + '\n'); }
};

test('layout parity: the loader resolves the paths contracts/layout.mjs defines', () => {
  setup();
  const r = runLoader();
  assert.deepEqual(r.calls.setPath, [['userData', L.userData]]);
  assert.ok(existsSync(join(L.flags, 'boot.json')));
  assert.equal(r.started.length, 1);
});

test('profile isolation: userData and CODEX_HOME from profile.json on a normal boot', () => {
  setup();
  const r = runLoader();
  assert.deepEqual(r.calls.setPath, [['userData', L.userData]]);
  assert.equal(r.env.CODEX_HOME, join(root, 'custom-home'));
  assert.deepEqual(r.started.map(core), [{ root, profile: 'default', safe: false }]);
});

test('profile isolation on passthrough (flags/disabled): applied, nothing else happens', () => {
  setup(); writeText(join(L.flags, 'disabled'), '');
  const r = runLoader();
  assert.deepEqual(r.calls.setPath, [['userData', L.userData]]);
  assert.equal(r.env.CODEX_HOME, join(root, 'custom-home'));
  assert.equal(r.started.length, 0);
  assert.ok(!existsSync(join(L.flags, 'boot.json')), 'passthrough must not touch the boot marker');
});

test('missing profile.json: layout defaults, never the stock state', () => {
  setup({ profile: false });
  const r = runLoader();
  assert.deepEqual(r.calls.setPath, [['userData', L.userData]]);
  assert.equal(r.env.CODEX_HOME, L.codexHome);
  assert.equal(r.started.length, 1);
});

test('unreadable profile.json: layout defaults', () => {
  setup({ profile: false }); writeText(L.profileConfig, '{not json');
  const r = runLoader();
  assert.equal(r.env.CODEX_HOME, L.codexHome);
  assert.deepEqual(r.calls.setPath, [['userData', L.userData]]);
});

test('CODEX_MODS_ROOT and CODEX_MODS_PROFILE override the baked root and default profile', () => {
  const other = mkdtempSync(join(tmpdir(), 'cm-ldr2-'));
  try {
    const L2 = layout(other, 'qa');
    writeJson(L2.profileConfig, { codexHome: L2.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '' });
    writeText(L2.frameworkCurrent, 'v9\n');
    writeText(join(L2.framework, 'v9', 'framework', 'main', 'index.cjs'), 'exports.start = () => {};');
    const r = runLoader({ env: { CODEX_MODS_ROOT: other, CODEX_MODS_PROFILE: 'qa' } });
    assert.deepEqual(r.calls.setPath, [['userData', L2.userData]]);
    assert.equal(r.env.CODEX_HOME, L2.codexHome);
    assert.deepEqual(r.started.map(core), [{ root: other, profile: 'qa', safe: false }]);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('boot marker: fresh boot writes booting/0; a healthy marker resets the count', () => {
  setup();
  runLoader();
  let m = readJson(join(L.flags, 'boot.json'));
  assert.equal(m.state, 'booting'); assert.equal(m.unhealthyCount, 0); assert.equal(m.generation, 0);
  assert.ok(Date.parse(m.startedAt));
  writeJson(join(L.flags, 'boot.json'), { generation: 7, startedAt: 'x', state: 'healthy', unhealthyCount: 1 });
  runLoader();
  m = readJson(join(L.flags, 'boot.json'));
  assert.equal(m.unhealthyCount, 0); assert.equal(m.generation, 7);
});

test('boot marker: a booting marker increments; the first unhealthy boot is not yet safe mode', () => {
  setup();
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 0 });
  const r = runLoader();
  const m = readJson(join(L.flags, 'boot.json'));
  assert.equal(m.unhealthyCount, 1); assert.equal(m.state, 'booting');
  assert.ok(!existsSync(join(L.flags, 'safe')));
  assert.equal(r.started[0].safe, false);
});

test('two unhealthy boots: safe flag written and passed to the framework; framework reverts to lkg', () => {
  setup(); installFramework('v0'); writeText(L.frameworkLkg, 'v0\n'); writeText(L.frameworkPrevious, 'vprev\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader();
  assert.deepEqual(readJson(join(L.flags, 'safe')), { reason: 'unhealthy-boots' });
  assert.equal(readFileSync(L.frameworkCurrent, 'utf8').trim(), 'v0');
  assert.equal(readFileSync(L.frameworkPrevious, 'utf8').trim(), 'vprev', 'previous is kept');
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].safe, true);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 2);
});

test('two unhealthy boots with lkg equal to current: safe flag only', () => {
  setup(); writeText(L.frameworkLkg, 'v1\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  runLoader();
  assert.equal(readFileSync(L.frameworkCurrent, 'utf8').trim(), 'v1');
  assert.ok(existsSync(join(L.flags, 'safe')));
});

test('a recorded lkg version whose directory is gone is ignored', () => {
  setup(); writeText(L.frameworkLkg, 'v-gone\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  runLoader();
  assert.equal(readFileSync(L.frameworkCurrent, 'utf8').trim(), 'v1');
});

test('two unhealthy boots with an app LKG: symlink re-pointed atomically, count reset, relaunch and exit, no framework start', () => {
  setup();
  const stable = join(root, 'ChatGPT Mods.app');
  const bad = join(root, 'apps', '2', 'ChatGPT.app'), good = join(root, 'apps', '1', 'ChatGPT.app');
  mkdirSync(bad, { recursive: true }); mkdirSync(good, { recursive: true });
  symlinkSync(bad, stable);
  writeText(L.lkgApp, good + '\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader();
  assert.equal(readlinkSync(stable), good);
  assert.equal(r.calls.relaunch, 0, 'no untargeted relaunch'); assert.deepEqual(r.calls.exit, [0]);
  assert.deepEqual(r.calls.spawn.map(([c, a]) => [c, a]), [['/usr/bin/open', ['-n', good]]], 'the exact LKG candidate is opened');
  assert.equal(r.started.length, 0);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 0);
  assert.ok(!existsSync(join(L.flags, 'safe')), 'a reopened LKG candidate must not inherit a safe flag written for the failing bundle');
  assert.ok(!readdirSync(root).some((n) => n.includes('.tmp')), 'no temp link left behind');
});

test('app LKG already linked: no relaunch, the boot continues in safe mode', () => {
  setup();
  const stable = join(root, 'ChatGPT Mods.app'), good = join(root, 'apps', '1', 'ChatGPT.app');
  mkdirSync(good, { recursive: true }); symlinkSync(good, stable); writeText(L.lkgApp, good);
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader({ execPath: join(good, 'Contents', 'MacOS', 'ChatGPT') });          // the running bundle IS the LKG candidate
  assert.equal(r.calls.relaunch, 0); assert.equal(r.calls.spawn.length, 0);
  assert.equal(r.started.length, 1); assert.equal(r.started[0].safe, true);
});

test('an existing safe flag is passed to the framework', () => {
  setup(); writeJson(join(L.flags, 'safe'), { reason: 'manual' });
  assert.equal(runLoader().started[0].safe, true);
});

test('an error thrown by framework code is recorded and the loader still returns', () => {
  setup({ version: 'bad' }); installFramework('bad', 'exports.start = () => { throw new Error("boom in framework"); };');
  const r = runLoader();
  const err = readJson(join(L.flags, 'last-loader-error.json'));
  assert.match(err.message, /boom in framework/); assert.equal(err.stage, 'framework');
  assert.equal(r.calls.setPath.length, 1, 'isolation was applied before the failure');
  assert.equal(r.env.CODEX_HOME, join(root, 'custom-home'));
});

test('a syntax error in framework code and a missing framework/current both still return', () => {
  setup({ version: 'broken' }); installFramework('broken', 'this is not javascript (');
  runLoader();
  assert.match(readJson(join(L.flags, 'last-loader-error.json')).message, /./);
  rmSync(join(L.flags, 'last-loader-error.json'));
  rmSync(L.frameworkCurrent);
  runLoader();
  assert.match(readJson(join(L.flags, 'last-loader-error.json')).message, /framework\/current/);
});

test('path traversal in framework/current is refused', () => {
  setup(); writeText(L.frameworkCurrent, '../../evil\n');
  const r = runLoader();
  assert.equal(r.started.length, 0);
  assert.ok(existsSync(join(L.flags, 'last-loader-error.json')));
});

test('electron failing still sets CODEX_HOME and records the error', () => {
  setup();
  const r = runLoader({ electronThrows: true });
  assert.equal(r.env.CODEX_HOME, join(root, 'custom-home'));
  assert.match(readJson(join(L.flags, 'last-loader-error.json')).message, /no electron/);
});

test('CODEX_CLI_PATH points at the relay in Contents/Resources when the framework is enabled', () => {
  setup();
  const r = runLoader();
  assert.equal(r.env.CODEX_CLI_PATH, join(root, 'App.app', 'Contents', 'Resources', 'codexmods-relay'));
});

test('CODEX_CLI_PATH is not set when the framework is disabled', () => {
  setup(); writeText(join(L.flags, 'disabled'), '');
  assert.equal(runLoader().env.CODEX_CLI_PATH, undefined);
});

test('CODEX_CLI_PATH is removed again when framework code fails, so the app keeps its own backend', () => {
  setup({ version: 'bad' }); installFramework('bad', 'exports.start = () => { throw new Error("boom"); };');
  assert.equal(runLoader().env.CODEX_CLI_PATH, undefined);
});

test('a failing setPath (Owl) does not stop the boot', () => {
  setup();
  const src = SRC.replace("app.setPath('userData', L.userData);", "throw new Error('setPath unsupported');");
  const r = runLoader({ source: src });
  assert.equal(r.started.length, 1);
  assert.ok(!existsSync(join(L.flags, 'last-loader-error.json')));
});

test('crash history (breadcrumbs, hostCrashCount, lastHostCrashAt) survives loader boots in every marker state', () => {
  setup();
  const hist = { breadcrumbs: ['a.b'], hostCrashCount: 2, lastHostCrashAt: '2026-10-11T10:00:00.000Z' };
  for (const state of ['healthy', 'booting']) {
    writeJson(join(L.flags, 'boot.json'), { generation: 1, startedAt: 'x', state, unhealthyCount: 0, ...hist });
    runLoader();
    const m = readJson(join(L.flags, 'boot.json'));
    assert.equal(m.hostCrashCount, 2, state); assert.equal(m.lastHostCrashAt, hist.lastHostCrashAt, state); assert.deepEqual(m.breadcrumbs, ['a.b'], state);
  }
  // also on the unhealthy-boots safe path
  writeJson(join(L.flags, 'boot.json'), { generation: 1, startedAt: 'x', state: 'booting', unhealthyCount: 1, ...hist });
  runLoader();
  assert.equal(readJson(join(L.flags, 'boot.json')).hostCrashCount, 2);
});

test('a marker without crash history does not gain any', () => {
  setup();
  runLoader();
  const m = readJson(join(L.flags, 'boot.json'));
  assert.equal('hostCrashCount' in m, false); assert.equal('lastHostCrashAt' in m, false);
});

test('the app auto-revert reads this profile\'s lkg-app, not a root-wide apps/lkg', () => {
  setup();
  const stable = join(root, 'ChatGPT Mods.app');
  const bad = join(root, 'apps', '2', 'ChatGPT.app'), good = join(root, 'apps', '1', 'ChatGPT.app'), other = join(root, 'apps', '0', 'ChatGPT.app');
  for (const d of [bad, good, other]) mkdirSync(d, { recursive: true });
  symlinkSync(bad, stable);
  writeText(join(root, 'apps', 'lkg'), other + '\n');           // the retired root-wide marker must be ignored
  writeText(L.lkgApp, good + '\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader();
  assert.equal(readlinkSync(stable), good);
  assert.equal(r.calls.spawn.length, 1); assert.equal(r.calls.relaunch, 0);
});

test('without a profile lkg-app the app copy is left alone (no revert, boot continues in safe mode)', () => {
  setup();
  const stable = join(root, 'ChatGPT Mods.app'), bad = join(root, 'apps', '2', 'ChatGPT.app');
  mkdirSync(bad, { recursive: true }); symlinkSync(bad, stable);
  writeText(join(root, 'apps', 'lkg'), join(root, 'apps', '1') + '\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader();
  assert.equal(readlinkSync(stable), bad); assert.equal(r.calls.relaunch, 0); assert.equal(r.started[0].safe, true);
});

// ---------------------------------------------------------------- per-profile instance lock (v1.8)
const lockFile = () => join(L.profileDir, 'run', 'instance.lock');
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '0']); return r.pid; };
const FAST = { CODEX_MODS_INSTANCE_WAIT_MS: '150' };

test('first instance takes the lock {pid, startedAt, appPath, token} and releases it on process exit', () => {
  setup();
  const r = runLoader({ pid: 900001, env: FAST });
  const lock = readJson(lockFile());
  assert.equal(lock.pid, 900001); assert.ok(Date.parse(lock.startedAt)); assert.equal(lock.appPath, '/fake/App.app/Contents/MacOS/App'); assert.ok(lock.token);
  assert.deepEqual(r.started[0].instanceLock, { file: lockFile(), token: lock.token });
  assert.equal(r.calls.onExit.length, 1);
  r.calls.onExit[0]();
  assert.ok(!existsSync(lockFile()), 'released');
});

test('a second instance (live holder) exits before app main without touching boot.json, flags, environment or userData', () => {
  setup();
  writeJson(join(L.flags, 'boot.json'), { generation: 9, startedAt: 'orig', state: 'booting', unhealthyCount: 2, hostCrashCount: 1 });
  const before = readFileSync(join(L.flags, 'boot.json'), 'utf8');
  const holder = { pid: process.ppid, startedAt: 'earlier', appPath: '/old/candidate/App', token: 'holder-token' };   // a live pid that is not ours
  writeJson(lockFile(), holder);
  const r = runLoader({ pid: 900002, env: FAST });
  assert.deepEqual(r.calls.exit, [0]); assert.deepEqual(r.calls.processExit, [0]);
  assert.equal(r.started.length, 0); assert.equal(r.calls.setPath.length, 0); assert.equal(r.calls.relaunch, 0);
  assert.equal(r.env.CODEX_HOME, undefined); assert.equal(r.env.CODEX_CLI_PATH, undefined);
  assert.equal(readFileSync(join(L.flags, 'boot.json'), 'utf8'), before, 'boot.json untouched');
  assert.deepEqual(readdirSync(L.flags).sort(), ['boot.json'], 'no flags written');
  assert.ok(!existsSync(join(L.flags, 'last-loader-error.json')));
  assert.deepEqual(readJson(lockFile()), holder, 'the holder keeps its lock');
  const lines = readFileSync(join(L.profileDir, 'logs', 'second-instance.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.holderPid, process.ppid); assert.equal(entry.holderApp, '/old/candidate/App'); assert.equal(entry.pid, 900002);
});

test('the lock also guards a disabled (passthrough) profile', () => {
  setup(); writeText(join(L.flags, 'disabled'), '');
  writeJson(lockFile(), { pid: process.ppid, startedAt: 'x', appPath: 'a', token: 't' });
  const r = runLoader({ pid: 900003, env: FAST });
  assert.deepEqual(r.calls.exit, [0]); assert.equal(r.calls.setPath.length, 0);
});

test('a stale lock (dead pid) is reclaimed: the new instance proceeds, takes the lock and leaves no reaper directory', () => {
  setup();
  writeJson(lockFile(), { pid: deadPid(), startedAt: 'x', appPath: 'a', token: 'dead' });
  const r = runLoader({ pid: 900004, env: FAST });
  assert.equal(r.started.length, 1); assert.deepEqual(r.calls.exit, []);
  assert.equal(readJson(lockFile()).pid, 900004);
  assert.ok(!existsSync(lockFile() + '.reap'));
});

test('stale variants: our own pid (previous incarnation) and old garbage are reclaimed; fresh garbage is respected', () => {
  setup();
  writeJson(lockFile(), { pid: 900005, startedAt: 'x', appPath: 'a', token: 'old' });
  assert.equal(runLoader({ pid: 900005, env: FAST }).started.length, 1, 'own pid');
  rmSync(lockFile());
  writeText(lockFile(), 'not json');
  assert.deepEqual(runLoader({ pid: 900006, env: FAST }).calls.exit, [0], 'fresh garbage may be a half-written lock: not taken over');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockFile(), old, old);
  assert.equal(runLoader({ pid: 900007, env: FAST }).started.length, 1, 'old garbage is reclaimed');
});

test('a stale reaper directory from a dead reaper (older than 30 s) does not wedge the next start', () => {
  setup();
  writeJson(lockFile(), { pid: deadPid(), startedAt: 'x', appPath: 'a', token: 'dead' });
  mkdirSync(lockFile() + '.reap');
  const old = new Date(Date.now() - 60_000); utimesSync(lockFile() + '.reap', old, old);
  const r = runLoader({ pid: 900008, env: { CODEX_MODS_INSTANCE_WAIT_MS: '2000' } });
  assert.equal(r.started.length, 1);
});

test('a predecessor that releases the lock during the grace wait (relaunch hand-off) lets the new instance proceed', () => {
  setup();
  writeJson(lockFile(), { pid: process.ppid, startedAt: 'x', appPath: 'a', token: 'old' });
  const t = setTimeout(() => {}, 0); clearTimeout(t);
  // release from a separate process shortly after the new instance starts waiting
  const rel = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').unlinkSync(${JSON.stringify(lockFile())}),400)`], { stdio: 'ignore' });
  const r = runLoader({ pid: 900009, env: { CODEX_MODS_INSTANCE_WAIT_MS: '3000' } });
  rel.kill();
  assert.equal(r.started.length, 1); assert.deepEqual(r.calls.exit, []);
});

test('concurrent starts: exactly one of four real processes proceeds', async () => {
  setup();
  const run = (startAt) => new Promise((resolve) => {
    const c = spawn(process.execPath, [join(here, 'instance-lock-child.mjs'), JSON.stringify({ root, startAt, waitMs: 1200 })], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const done = new Promise((r) => c.on('exit', r));
    const first = new Promise((r) => { const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); r(out.trim()); } }, 20); });
    resolve({ c, first, done });
  });
  const startAt = Date.now() + 700;
  const kids = await Promise.all([run(startAt), run(startAt), run(startAt), run(startAt)]);
  const results = await Promise.all(kids.map((k) => k.first));
  assert.deepEqual(results.slice().sort(), ['proceeded', 'second', 'second', 'second']);
  const winner = kids[results.indexOf('proceeded')];
  assert.equal(readJson(lockFile()).pid, winner.c.pid, 'the lock names the winner');
  winner.c.stdin.end();
  await winner.done;
  await Promise.all(kids.map((k) => k.done));
  assert.equal(readFileSync(join(L.profileDir, 'logs', 'second-instance.log'), 'utf8').trim().split('\n').length, 3, 'each loser logged one line');
});

test('concurrent starts over a STALE lock: exactly one proceeds (reaper mutex)', async () => {
  setup();
  writeJson(lockFile(), { pid: deadPid(), startedAt: 'x', appPath: 'a', token: 'dead' });
  const startAt = Date.now() + 700;
  const kids = [0, 1, 2, 3].map(() => {
    const c = spawn(process.execPath, [join(here, 'instance-lock-child.mjs'), JSON.stringify({ root, startAt, waitMs: 1200 })], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const done = new Promise((r) => c.on('exit', r));
    const first = new Promise((r) => { const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); r(out.trim()); } }, 20); });
    return { c, first, done };
  });
  const results = await Promise.all(kids.map((k) => k.first));
  assert.deepEqual(results.slice().sort(), ['proceeded', 'second', 'second', 'second']);
  kids[results.indexOf('proceeded')].c.stdin.end();
  await Promise.all(kids.map((k) => k.done));
  assert.ok(!existsSync(lockFile() + '.reap'));
});

test('an unusable lock directory never stops the app from starting', () => {
  setup();
  mkdirSync(join(L.profileDir, 'run'), { recursive: true });
  writeText(lockFile(), '');                       // empty file...
  rmSync(lockFile());
  mkdirSync(lockFile());                           // ...a DIRECTORY where the lock file should be: open(wx) fails with EEXIST/EISDIR
  const r = runLoader({ pid: 900010, env: FAST });
  assert.equal(r.started.length, 1, 'the app starts without a lock'); assert.equal(r.started[0].instanceLock, null); assert.deepEqual(r.calls.exit, []);
});

// ---------------------------------------------------------------- updater off, concurrency guard, targeted LKG reopen
test('CODEX_SPARKLE_ENABLED=false on every boot: enabled, passthrough, and the loader-error path', () => {
  setup();
  assert.equal(runLoader().env.CODEX_SPARKLE_ENABLED, 'false');
  writeText(join(L.flags, 'disabled'), '');
  assert.equal(runLoader().env.CODEX_SPARKLE_ENABLED, 'false', 'passthrough');
  rmSync(join(L.flags, 'disabled'));
  rmSync(L.frameworkCurrent);
  assert.equal(runLoader().env.CODEX_SPARKLE_ENABLED, 'false', 'framework error path');
  assert.equal(runLoader({ electronThrows: true }).env.CODEX_SPARKLE_ENABLED, 'false', 'electron failure path');
  setup({ profile: false }); writeText(L.profileConfig, '{garbage');
  assert.equal(runLoader().env.CODEX_SPARKLE_ENABLED, 'false', 'unreadable profile');
});

test('CODEX_SPARKLE_ENABLED overrides an environment that enabled it', () => {
  setup();
  assert.equal(runLoader({ env: { CODEX_SPARKLE_ENABLED: 'true' } }).env.CODEX_SPARKLE_ENABLED, 'false');
});

const guardProfile = (extra = {}) => writeJson(L.profileConfig, { codexHome: join(root, 'custom-home'), guardStockApp: true, signingIdentity: '-', appPath: '', launchArgs: [], ...extra });
const STOCK = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const HOME_ENV = (home) => `USER=u HOME=/Users/u PATH=/usr/bin ${home === undefined ? '' : `CODEX_HOME=${home}`} PWD=/x`;
const psLine = (pid, cmd, env) => `${String(pid).padStart(6)} ${cmd} ${env}`;
const readGuardLog = () => readFileSync(join(L.profileDir, 'logs', 'guard.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('guard off (guardStockApp false): no inspection, no dialog', () => {
  setup();
  const r = runLoader({ ps: psLine(1, STOCK, HOME_ENV()) });
  assert.deepEqual(r.calls.psArgs, []); assert.equal(r.calls.ready.length, 0);
});

test('guard: nothing found -> no dialog gate, no log', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: [psLine(10, '/usr/bin/vim x', HOME_ENV()), psLine(11, '/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper --type=renderer', HOME_ENV()), psLine(12, '/Applications/ChatGPT Mods.app/Contents/MacOS/ChatGPT', HOME_ENV())].join('\n') });
  assert.equal(r.calls.psArgs.length, 1); assert.equal(r.calls.ready.length, 0);
  assert.ok(!existsSync(join(L.profileDir, 'logs', 'guard.log')));
  assert.equal(r.started.length, 1);
});

test('guard: the stock app running -> a dialog at ready (Continue anyway default), the boot is not blocked, decision logged', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()) });
  assert.equal(r.started.length, 1, 'the boot proceeds; the dialog comes at ready');
  assert.equal(r.calls.dialogs.length, 0);
  r.calls.ready[0]();
  const d = r.calls.dialogs[0];
  assert.deepEqual(d.buttons, ['Continue anyway', 'Quit the other Codex', 'Quit']); assert.equal(d.defaultId, 2, 'Return means Quit'); assert.equal(d.cancelId, 2, 'Escape means Quit');
  assert.match(d.detail, /stock ChatGPT app is running \(pid 500\)/);
  assert.deepEqual(r.calls.exit, []);
  const log = readGuardLog();
  assert.equal(log.length, 1); assert.equal(log[0].decision, 'continue'); assert.equal(log[0].inspectionFailed, false);
});

test('guard: Quit exits the app and releases the instance lock; the decision is logged', () => {
  setup(); guardProfile();
  const r = runLoader({ pid: 910001, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 2 });
  assert.ok(existsSync(lockFile()));
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0]); assert.ok(!existsSync(lockFile()), 'lock released so a later launch is not blocked');
  assert.equal(readGuardLog()[0].decision, 'quit');
});

test('guard: a Codex app-server of this user on THIS codex home (explicit or default ~/.codex) that is not ours is detected', () => {
  setup(); guardProfile({ codexHome: join(root, 'custom-home') });
  const cli = '/Users/u/bin/codex -c a=b app-server --analytics-default-enabled';
  let r = runLoader({ ps: psLine(600, cli, HOME_ENV(join(root, 'custom-home'))) });
  assert.equal(r.calls.ready.length, 1); r.calls.ready[0](); assert.match(r.calls.dialogs[0].detail, /another Codex app-server \(pid 600\)/);
  // default home when CODEX_HOME is unset
  rmSync(join(L.profileDir, 'logs'), { recursive: true, force: true });
  guardProfile({ codexHome: join(homedir(), '.codex') });
  r = runLoader({ ps: psLine(601, cli, HOME_ENV()) });
  assert.equal(r.calls.ready.length, 1, 'unset CODEX_HOME means ~/.codex');
});

test('guard: ignored — another codex home, our own run dir, no app-server', () => {
  setup(); guardProfile({ codexHome: join(root, 'custom-home') });
  const cli = '/Users/u/bin/codex app-server';
  const ours = join(L.profileDir, 'run');
  const table = [
    psLine(700, cli, HOME_ENV('/somewhere/else')),
    psLine(701, cli, HOME_ENV(join(root, 'custom-home')) + ` CODEX_MODS_RUN_DIR=${ours}`),
    psLine(702, '/Users/u/bin/codex login status', HOME_ENV(join(root, 'custom-home'))),
    psLine(704, '/Users/u/bin/notcodex app-server', HOME_ENV(join(root, 'custom-home'))),
  ].join('\n');
  const r = runLoader({ ps: table });
  assert.equal(r.calls.ready.length, 0);
});

test('guard: a run dir with spaces on another profile is not mistaken for ours; ours with spaces is recognised', () => {
  setup(); guardProfile({ codexHome: join(root, 'custom-home') });
  const cli = '/Users/u/bin/codex app-server';
  const other = psLine(710, cli, HOME_ENV(join(root, 'custom-home')) + ' CODEX_MODS_RUN_DIR=/other profile/run');
  assert.equal(runLoader({ ps: other }).calls.ready.length, 1);
});

test('guard: an inspection failure warns too (dialog says so) and is logged as such', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: new Error('ps: Operation not permitted') });
  assert.equal(r.calls.ready.length, 1);
  r.calls.ready[0]();
  assert.match(r.calls.dialogs[0].message, /Could not fully check/);
  assert.equal(readGuardLog()[0].inspectionFailed, true);
});

test('guard: a dialog that cannot be shown QUITS with a logged reason (never continues unconfirmed) and releases the lock', () => {
  setup(); guardProfile();
  const r = runLoader({ pid: 930003, ps: psLine(500, STOCK, HOME_ENV()), dialogThrows: true });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0]); assert.ok(!existsSync(lockFile()));
  const e = readGuardLog()[0];
  assert.equal(e.decision, 'quit-dialog-failed'); assert.ok(e.reasons.some((x) => /dialog could not be shown/.test(x)));
});

test('guard: an app-server whose environment cannot be read is inspection-unknown and WARNS (not skipped)', () => {
  setup(); guardProfile({ codexHome: join(root, 'custom-home') });
  const r = runLoader({ ps: psLine(703, '/Users/u/bin/codex app-server', '') });
  assert.equal(r.calls.ready.length, 1);
  r.calls.ready[0]();
  assert.match(r.calls.dialogs[0].message, /Could not fully check/);
  assert.match(r.calls.dialogs[0].detail, /pid 703\) could not be inspected: its environment is unreadable/);
  const e = readGuardLog()[0];
  assert.equal(e.inspectionUnknown, true); assert.equal(e.decision, 'continue', 'warn but allow on confirmation');
});

test('guard: unknown + Quit quits', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: psLine(703, '/Users/u/bin/codex app-server', ''), dialogChoice: 1 });      // nothing identifiable: no "Quit the other Codex" button, Quit is index 1
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0]);
});

test('guard: also armed when the framework is disabled (independent of framework availability)', () => {
  setup(); guardProfile(); writeText(join(L.flags, 'disabled'), '');
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()) });
  assert.equal(r.started.length, 0); assert.equal(r.calls.ready.length, 1);
});

test('the app-revert opens the exact LKG candidate with the profile launchArgs (open -n <path> --args ...), detached, after releasing the lock', () => {
  setup();
  guardProfile({ guardStockApp: false, appPath: join(root, 'ChatGPT Mods.app'), launchArgs: ['--user-data-dir=/q a/ud', '--x'] });
  const stable = join(root, 'ChatGPT Mods.app'), bad = join(root, 'apps', '2', 'ChatGPT.app'), good = join(root, 'apps', '1', 'ChatGPT.app');
  mkdirSync(bad, { recursive: true }); mkdirSync(good, { recursive: true }); symlinkSync(bad, stable);
  writeText(L.lkgApp, good + '\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: 1 });
  const r = runLoader({ pid: 910002 });
  assert.deepEqual(r.calls.spawn.map(([c, a]) => [c, a]), [['/usr/bin/open', ['-n', good, '--args', '--user-data-dir=/q a/ud', '--x']]]);
  assert.equal(r.calls.relaunch, 0); assert.deepEqual(r.calls.exit, [0]);
  assert.ok(!existsSync(lockFile()), 'released before the new instance starts');
  assert.equal(readlinkSync(stable), good);
  assert.equal(r.started.length, 0);
});

// ---- v1.14: reopen by identity, and "done" only when open exits 0
const lkgSetup = ({ symlinkTo = 'bad', unhealthy = 1 } = {}) => {
  setup();
  const stable = join(root, 'ChatGPT Mods.app'), A = join(root, 'apps', '1', 'ChatGPT.app'), B = join(root, 'apps', '2', 'ChatGPT.app');
  mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true });
  symlinkSync(symlinkTo === 'bad' ? B : A, stable);
  writeText(L.lkgApp, A + '\n');
  writeJson(join(L.flags, 'boot.json'), { generation: 3, startedAt: 'x', state: 'booting', unhealthyCount: unhealthy });
  return { stable, A, B };
};
const lkgLog = () => readFileSync(join(L.profileDir, 'logs', 'lkg-reopen.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('B opened directly while the symlink already points at A (LKG), B unhealthy: A is reopened by identity', () => {
  const { stable, A, B } = lkgSetup({ symlinkTo: 'good' });
  assert.equal(readlinkSync(stable), A, 'no symlink repair is needed');
  const r = runLoader({ pid: 930001, execPath: join(B, 'Contents', 'MacOS', 'ChatGPT') });
  assert.deepEqual(r.calls.spawn.map(([c, a]) => [c, a]), [['/usr/bin/open', ['-n', A]]], 'exactly the LKG candidate');
  assert.deepEqual(r.calls.exit, [0]); assert.equal(r.started.length, 0);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 0);
  assert.ok(!existsSync(lockFile()), 'released');
  assert.equal(lkgLog()[0].ok, true);
});

test('the running bundle is compared canonically (symlinked path to the LKG candidate is the same bundle)', () => {
  const { A } = lkgSetup({ symlinkTo: 'good' });
  const alias = join(root, 'alias.app'); symlinkSync(A, alias);
  const r = runLoader({ execPath: join(alias, 'Contents', 'MacOS', 'ChatGPT') });
  assert.equal(r.calls.spawn.length, 0, 'same bundle through a symlink: no reopen');
  assert.equal(r.started.length, 1);
});

test('LKG is already the running bundle and the symlink is right: no reopen, safe mode in place', () => {
  const { A } = lkgSetup({ symlinkTo: 'good' });
  const r = runLoader({ execPath: join(A, 'Contents', 'MacOS', 'ChatGPT') });
  assert.equal(r.calls.spawn.length, 0); assert.equal(r.started[0].safe, true);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 2, 'the count is kept: nothing was reverted');
});

test('open exits non-zero: not reopened, logged, the boot falls to safe mode in the current bundle (no exit, no loop), unhealthy count kept', () => {
  const { B } = lkgSetup({ symlinkTo: 'bad' });
  const r = runLoader({ pid: 930002, execPath: join(B, 'Contents', 'MacOS', 'ChatGPT'), openStatus: 1 });
  assert.equal(r.calls.spawn.length, 1, 'tried once, no retry loop');
  assert.deepEqual(r.calls.exit, []); assert.equal(r.started.length, 1); assert.equal(r.started[0].safe, true);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 2, 'not reset: the reopen did not happen');
  assert.ok(existsSync(lockFile()), 'still the running instance');
  const entry = lkgLog()[0];
  assert.equal(entry.ok, false); assert.match(entry.note, /status 1/); assert.equal(entry.target.endsWith('apps/1/ChatGPT.app'), true);
});

test('open cannot be spawned at all: same fall-through', () => {
  lkgSetup({ symlinkTo: 'bad' });
  const r = runLoader({ openThrows: true });
  assert.deepEqual(r.calls.exit, []); assert.equal(r.started.length, 1); assert.equal(r.started[0].safe, true);
  assert.equal(lkgLog()[0].ok, false); assert.match(lkgLog()[0].note, /spawnSync failed/);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 2);
});

test('CODEX_MODS_COMPUTER_USE_DIR = <profile>/computer-use (created 0700) on every boot: enabled, passthrough, error path; never the Codex home', () => {
  const dir = join(L.profileDir, 'computer-use');
  setup();
  let r = runLoader();
  assert.equal(r.env.CODEX_MODS_COMPUTER_USE_DIR, dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(!r.env.CODEX_MODS_COMPUTER_USE_DIR.startsWith(join(root, 'custom-home')), 'not inside the Codex home');
  rmSync(dir, { recursive: true });
  writeText(join(L.flags, 'disabled'), '');
  r = runLoader();
  assert.equal(r.env.CODEX_MODS_COMPUTER_USE_DIR, dir, 'passthrough'); assert.ok(existsSync(dir));
  rmSync(join(L.flags, 'disabled'));
  rmSync(L.frameworkCurrent);
  assert.equal(runLoader().env.CODEX_MODS_COMPUTER_USE_DIR, dir, 'framework error path');
  assert.equal(runLoader({ electronThrows: true }).env.CODEX_MODS_COMPUTER_USE_DIR, dir, 'electron failure path');
});

test('the second-instance exit path sets no Computer Use directory', () => {
  setup();
  writeJson(lockFile(), { pid: process.ppid, startedAt: 'x', appPath: 'a', token: 't' });
  const r = runLoader({ pid: 920001, env: FAST });
  assert.equal(r.env.CODEX_MODS_COMPUTER_USE_DIR, undefined);
});

test('the loader\'s computer-use path matches layout.computerUse', () => {
  setup();
  assert.equal(runLoader().env.CODEX_MODS_COMPUTER_USE_DIR, L.computerUse);
});

// ---- the reopened LKG candidate boots normally and keeps running
test('B fails twice, the third open of B reopens A: A\'s first boot is NOT safe, counts from zero, takes the lock and is not a second instance', () => {
  const { stable, A, B } = lkgSetup({ symlinkTo: 'good', unhealthy: 1 });       // symlink and LKG on A; B already failed twice (counts 0, then 1)
  const bExec = join(B, 'Contents', 'MacOS', 'ChatGPT'), aExec = join(A, 'Contents', 'MacOS', 'ChatGPT');
  const rb = runLoader({ pid: 940001, execPath: bExec });                         // B's third open
  assert.deepEqual(rb.calls.spawn.map(([c, a]) => [c, a[1]]), [['/usr/bin/open', A]]);
  assert.deepEqual(rb.calls.exit, [0]);
  assert.ok(!existsSync(join(L.flags, 'safe')), 'no safe flag left for A to inherit');
  const marker = readJson(join(L.flags, 'boot.json'));
  assert.equal(marker.unhealthyCount, 0); assert.notEqual(marker.state, 'booting', 'A must not read B\'s marker as an unfinished boot');
  assert.ok(!existsSync(lockFile()), 'B released the instance lock before exiting');
  // A starts (a separate process)
  const ra = runLoader({ pid: 940002, execPath: aExec });
  assert.deepEqual(ra.calls.exit, [], 'A is not a second instance'); assert.deepEqual(ra.calls.spawn, [], 'A does not reopen anything');
  assert.equal(ra.started.length, 1); assert.equal(ra.started[0].safe, false, 'A boots normally');
  const after = readJson(join(L.flags, 'boot.json'));
  assert.equal(after.state, 'booting'); assert.equal(after.unhealthyCount, 0, 'A counts from zero');
  assert.ok(!existsSync(join(L.flags, 'safe')));
  assert.equal(readJson(lockFile()).pid, 940002, 'A holds the lock');
  assert.equal(readlinkSync(stable), A);
});

test('A launched while B still holds the instance lock (B exits a moment later) waits and proceeds, never mistaken for a second instance', () => {
  const { A } = lkgSetup({ symlinkTo: 'good', unhealthy: 0 });
  writeJson(lockFile(), { pid: process.ppid, startedAt: 'x', appPath: 'B', token: 'b' });         // B alive, still exiting
  const rel = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').unlinkSync(${JSON.stringify(lockFile())}),300)`], { stdio: 'ignore' });
  const ra = runLoader({ pid: 940003, execPath: join(A, 'Contents', 'MacOS', 'ChatGPT'), env: { CODEX_MODS_INSTANCE_WAIT_MS: '3000' } });
  rel.kill();
  assert.equal(ra.started.length, 1); assert.deepEqual(ra.calls.exit, []);
});

test('the reopen carries the failing instance\'s own switches (QA --use-mock-keychain) in addition to the profile launchArgs, without duplicates or helper/debug switches', () => {
  const { B, A } = lkgSetup({ symlinkTo: 'good' });
  writeJson(L.profileConfig, { codexHome: join(root, 'custom-home'), guardStockApp: false, signingIdentity: '-', appPath: join(root, 'ChatGPT Mods.app'), launchArgs: ['--user-data-dir=/q/ud'] });
  const r = runLoader({
    execPath: join(B, 'Contents', 'MacOS', 'ChatGPT'),
    argv: [join(B, 'Contents', 'MacOS', 'ChatGPT'), '--user-data-dir=/q/ud', '--use-mock-keychain', '--inspect=9229', '--type=renderer', 'positional', '--use-mock-keychain', '-psn_0_123'],
  });
  assert.deepEqual(r.calls.spawn[0][1], ['-n', A, '--args', '--user-data-dir=/q/ud', '--use-mock-keychain']);
});

test('without launchArgs and without own switches the reopen is a plain open -n <path>', () => {
  const { B, A } = lkgSetup({ symlinkTo: 'good' });
  const r = runLoader({ execPath: join(B, 'Contents', 'MacOS', 'ChatGPT'), argv: [join(B, 'Contents', 'MacOS', 'ChatGPT')] });
  assert.deepEqual(r.calls.spawn[0][1], ['-n', A]);
});

test('when the reopen fails the safe flag IS written (the boot stays in this bundle in safe mode)', () => {
  const { B } = lkgSetup({ symlinkTo: 'bad' });
  const r = runLoader({ execPath: join(B, 'Contents', 'MacOS', 'ChatGPT'), openStatus: 1 });
  assert.deepEqual(readJson(join(L.flags, 'safe')), { reason: 'unhealthy-boots' });
  assert.equal(r.started[0].safe, true);
});

// ---- v1.15: only an explicit "Continue anyway" proceeds
test('guard dialog: default button and cancel (Escape) are both Quit', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()) });
  r.calls.ready[0]();
  const d = r.calls.dialogs[0];
  assert.equal(d.buttons[d.defaultId], 'Quit'); assert.equal(d.buttons[d.cancelId], 'Quit');
  assert.equal(d.buttons[0], 'Continue anyway');
});

test('guard dialog: Escape/cancel (the dialog returns cancelId = the Quit index) quits', () => {
  setup(); guardProfile();
  const r = runLoader({ pid: 950001, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 2 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0]); assert.ok(!existsSync(lockFile()), 'lock released');
  assert.equal(readGuardLog()[0].decision, 'quit');
});

test('guard dialog: an unexpected return value (not exactly the Continue index) quits, logged', () => {
  for (const choice of [undefined, null, -1, 3, 7, '0', false, NaN, 1.5]) {
    rmSync(join(L.profileDir, 'logs'), { recursive: true, force: true });
    setup(); guardProfile();
    const r = runLoader({ pid: 950002, ps: psLine(500, STOCK, HOME_ENV()), dialogRaw: () => choice });
    r.calls.ready[0]();
    assert.deepEqual(r.calls.exit, [0], String(choice));
    const e = readGuardLog()[0];
    assert.equal(e.decision, 'quit-unexpected-result', String(choice));
    assert.ok(e.reasons.some((x) => /unexpected value/.test(x)));
  }
});

test('guard dialog: explicit Continue anyway (index 0) proceeds, no exit, logged', () => {
  setup(); guardProfile();
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, []);
  assert.equal(readGuardLog()[0].decision, 'continue'); assert.equal(r.started.length, 1);
});

// ---- a guard exit is not a boot attempt
const markerText = () => readFileSync(join(L.flags, 'boot.json'), 'utf8');
const guardQuit = (extra = {}) => {
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 2, ...extra });
  assert.equal(r.calls.ready.length, 1);
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0], 'the guard path quit');
  return r;
};

test('guard Quit twice, then a normal launch: the marker is byte-identical after each Quit, the count is unchanged and the launch is not safe', () => {
  setup(); guardProfile();
  const prior = JSON.stringify({ generation: 3, startedAt: '2026-10-12T00:00:00.000Z', state: 'healthy', unhealthyCount: 0, hostCrashCount: 0 }, null, 2) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  guardQuit({ pid: 960001 });
  assert.equal(markerText(), prior, 'first Quit leaves the marker exactly as it was');
  guardQuit({ pid: 960002 });
  assert.equal(markerText(), prior, 'second Quit too');
  assert.ok(!existsSync(join(L.flags, 'safe')));
  // a normal launch afterwards (no conflict any more)
  const r = runLoader({ pid: 960003, ps: '' });
  assert.equal(r.started.length, 1); assert.equal(r.started[0].safe, false);
  const m = readJson(join(L.flags, 'boot.json'));
  assert.equal(m.unhealthyCount, 0); assert.equal(m.state, 'booting', 'only now a real boot attempt is recorded');
  assert.ok(!existsSync(join(L.flags, 'safe')));
});

test('guard Quit with no marker at all leaves no marker behind', () => {
  setup(); guardProfile();
  guardQuit({ pid: 960004 });
  assert.ok(!existsSync(join(L.flags, 'boot.json')));
});

test('an existing unhealthy count of 1 stays 1 after a guard Quit (no increment, no safe flag, crash history untouched)', () => {
  setup(); guardProfile();
  const prior = JSON.stringify({ generation: 5, startedAt: 'x', state: 'booting', unhealthyCount: 1, hostCrashCount: 1, lastHostCrashAt: '2026-10-12T00:00:00.000Z', breadcrumbs: ['a.b'] }, null, 2) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  guardQuit({ pid: 960005 });
  assert.equal(markerText(), prior);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 1);
  assert.ok(!existsSync(join(L.flags, 'safe')), 'the safe flag this launch would have written (count 2) is removed again');
});

test('a safe flag that existed BEFORE this launch survives a guard Quit', () => {
  setup(); guardProfile();
  writeJson(join(L.flags, 'safe'), { reason: 'manual' });
  writeText(join(L.flags, 'boot.json'), JSON.stringify({ generation: 1, startedAt: 'x', state: 'booting', unhealthyCount: 1 }));
  guardQuit({ pid: 960006 });
  assert.deepEqual(readJson(join(L.flags, 'safe')), { reason: 'manual' });
});

test('guard dialog failure and unexpected result leave the count unchanged too', () => {
  setup(); guardProfile();
  const prior = JSON.stringify({ generation: 2, startedAt: 'x', state: 'booting', unhealthyCount: 1 }) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  guardQuit({ pid: 960007, dialogThrows: true });
  assert.equal(markerText(), prior, 'dialog failure');
  guardQuit({ pid: 960008, dialogRaw: () => 'what' });
  assert.equal(markerText(), prior, 'unexpected result');
  assert.ok(!existsSync(join(L.flags, 'safe')));
});

test('guard Continue still counts the boot normally (an unfinished previous boot becomes count 2 and safe mode)', () => {
  setup(); guardProfile();
  writeText(join(L.flags, 'boot.json'), JSON.stringify({ generation: 2, startedAt: 'x', state: 'booting', unhealthyCount: 1 }));
  const r = runLoader({ pid: 960009, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, []);
  assert.equal(readJson(join(L.flags, 'boot.json')).unhealthyCount, 2); assert.equal(readJson(join(L.flags, 'boot.json')).state, 'booting');
  assert.ok(existsSync(join(L.flags, 'safe')));
  assert.equal(r.started.length, 1);
});

test('guard Continue on a clean profile: the boot is recorded as booting with count 0', () => {
  setup(); guardProfile();
  writeText(join(L.flags, 'boot.json'), JSON.stringify({ generation: 2, startedAt: 'x', state: 'healthy', unhealthyCount: 0 }));
  const r = runLoader({ pid: 960010, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  r.calls.ready[0]();
  const m = readJson(join(L.flags, 'boot.json'));
  assert.equal(m.state, 'booting'); assert.equal(m.unhealthyCount, 0);
});

test('the second-instance exit leaves the marker exactly as it was (unchanged guarantee)', () => {
  setup();
  const prior = JSON.stringify({ generation: 4, startedAt: 'x', state: 'booting', unhealthyCount: 1 }) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  writeJson(lockFile(), { pid: process.ppid, startedAt: 'x', appPath: 'a', token: 't' });
  const r = runLoader({ pid: 960011, env: FAST });
  assert.deepEqual(r.calls.exit, [0]);
  assert.equal(markerText(), prior);
});

// ---- the guard decision comes BEFORE the framework, the Host or any recovery dialog
/** A framework whose start() honours deferStart like framework/main/index.cjs: records start args and begin() calls. */
function installDeferringFramework(version = 'v1') {
  installFramework(version, `
    exports.start = (o) => {
      (globalThis.__fw ||= { starts: [], begins: 0 }).starts.push({ deferStart: o.deferStart, safe: o.safe });
      const begin = () => { globalThis.__fw.begins++; return { hooks: {} }; };
      return o.deferStart ? { begin } : begin();
    };`);
  delete globalThis.__fw;
}

test('guard armed: start() is called deferred; begin() (Host, views, recovery dialog) does NOT run before the owner answers', () => {
  setup(); guardProfile(); installDeferringFramework();
  writeJson(join(L.flags, 'safe'), { reason: 'unhealthy-boots' });
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()) });
  assert.deepEqual(globalThis.__fw.starts, [{ deferStart: true, safe: true }]);
  assert.equal(globalThis.__fw.begins, 0, 'nothing of the framework runs while the warning is pending');
  assert.equal(r.calls.ready.length, 1);
});

test('guard Quit while a safe flag exists: exits without starting the Host or showing the safe dialog (begin never runs); the marker is restored', () => {
  setup(); guardProfile(); installDeferringFramework();
  writeJson(join(L.flags, 'safe'), { reason: 'unhealthy-boots' });
  const prior = JSON.stringify({ generation: 7, startedAt: 'x', state: 'healthy', unhealthyCount: 0 }) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  const r = runLoader({ pid: 970001, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 2 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, [0]);
  assert.equal(globalThis.__fw.begins, 0, 'no Host, no views, no recovery dialog');
  assert.equal(markerText(), prior); assert.deepEqual(readJson(join(L.flags, 'safe')), { reason: 'unhealthy-boots' }, 'the pre-existing safe flag is untouched');
  assert.ok(!existsSync(lockFile()));
});

test('guard Quit hard-exits the process if it is still alive shortly after app.exit', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setup(); guardProfile();
    const r = runLoader({ pid: 970002, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 2 });
    r.calls.ready[0]();
    assert.deepEqual(r.calls.processExit, []);
    mock.timers.tick(1499); assert.deepEqual(r.calls.processExit, []);
    mock.timers.tick(1); assert.deepEqual(r.calls.processExit, [0], 'hard exit fallback');
  } finally { mock.timers.reset(); }
});

test('guard Continue: begin() runs exactly once, after the answer, and the safe-mode path then proceeds normally', () => {
  setup(); guardProfile(); installDeferringFramework();
  writeJson(join(L.flags, 'safe'), { reason: 'unhealthy-boots' });
  const r = runLoader({ pid: 970003, ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  assert.equal(globalThis.__fw.begins, 0);
  r.calls.ready[0]();
  assert.equal(globalThis.__fw.begins, 1);
  assert.deepEqual(r.calls.exit, []);
  assert.equal(globalThis.__fw.starts[0].safe, true, 'the framework starts in safe mode as flagged');
  r.calls.ready[0]();                                   // a second ready callback must not begin twice
  assert.equal(globalThis.__fw.begins, 1);
});

test('no guard armed: the framework starts immediately and not deferred', () => {
  setup(); guardProfile(); installDeferringFramework();
  runLoader({ ps: '' });
  assert.deepEqual(globalThis.__fw.starts, [{ deferStart: false, safe: false }]);
  assert.equal(globalThis.__fw.begins, 1);
});

test('guard armed with a framework that does not honour deferStart (older version): it has already started, Continue is harmless', () => {
  setup(); guardProfile();                              // default stub: ignores deferStart, returns undefined
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  assert.equal(r.started.length, 1);
  r.calls.ready[0]();
  assert.deepEqual(r.calls.exit, []);
});

test('a begin() that throws after Continue is recorded and does not crash the loader', () => {
  setup(); guardProfile();
  installFramework('v1', 'exports.start = (o) => ({ begin() { throw new Error("begin boom"); } });');
  const r = runLoader({ ps: psLine(500, STOCK, HOME_ENV()), dialogChoice: 0 });
  r.calls.ready[0]();
  const err = readJson(join(L.flags, 'last-loader-error.json'));
  assert.equal(err.stage, 'framework-begin'); assert.match(err.message, /begin boom/);
});

// ---------------------------------------------------------------- v1.19: inherited decision, "Always allow this server"
const runDirP = () => join(L.profileDir, 'run');
const intentP = () => join(runDirP(), 'relaunch-intent.json');
const lastContinueP = () => join(runDirP(), 'guard-last-continue.json');
const writeIntent = (ageMs = 1000, extra = {}) => { mkdirSync(runDirP(), { recursive: true }); writeJson(intentP(), { at: new Date(Date.now() - ageMs).toISOString(), reason: 'safe-mode', pid: 1, ...extra }); };
const CLI_CMD = '/Users/u/bin/codex app-server --listen unix://';
const cliLine = (pid, cmd = CLI_CMD, home = join(root, 'custom-home')) => psLine(pid, cmd, HOME_ENV(home));
const fpOf = (cmd) => cmd.replace(/\s+/g, ' ').trim();

test('inherited: a recent relaunch token and the same conflicts the owner already allowed -> no dialog, decision "inherited", framework starts immediately', () => {
  setup(); guardProfile(); installDeferringFramework();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: 'x', fingerprints: [fpOf(CLI_CMD)] });
  writeIntent();
  const r = runLoader({ pid: 980001, ps: cliLine(600) });
  assert.equal(r.calls.ready.length, 0, 'no dialog gate');
  assert.deepEqual(globalThis.__fw.starts, [{ deferStart: false, safe: false }]); assert.equal(globalThis.__fw.begins, 1);
  const e = readGuardLog().at(-1);
  assert.equal(e.decision, 'inherited'); assert.deepEqual(e.fingerprints, [fpOf(CLI_CMD)]);
  assert.ok(!existsSync(intentP()), 'the token is single use');
});

test('inherited requires EVERY conflict to be in the stored set: a new conflict prompts', () => {
  setup(); guardProfile();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: 'x', fingerprints: [fpOf(CLI_CMD)] });
  writeIntent();
  const other = '/Users/u/bin/codex app-server --listen ws://127.0.0.1:9';
  const r = runLoader({ pid: 980002, ps: [cliLine(600), cliLine(601, other)].join('\n') });
  assert.equal(r.calls.ready.length, 1);
  assert.ok(!existsSync(intentP()), 'consumed even though it did not apply');
});

test('a stale relaunch token (older than 10 minutes) prompts, and is removed', () => {
  setup(); guardProfile();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: 'x', fingerprints: [fpOf(CLI_CMD)] });
  writeIntent(11 * 60 * 1000);
  const r = runLoader({ pid: 980003, ps: cliLine(600) });
  assert.equal(r.calls.ready.length, 1); assert.ok(!existsSync(intentP()));
});

test('a user launch without a token always prompts, even with an old stored Continue', () => {
  setup(); guardProfile();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: new Date().toISOString(), fingerprints: [fpOf(CLI_CMD)] });
  const r = runLoader({ pid: 980004, ps: cliLine(600) });
  assert.equal(r.calls.ready.length, 1);
});

test('a malformed token prompts; the token cannot be reused by the next launch', () => {
  setup(); guardProfile();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: 'x', fingerprints: [fpOf(CLI_CMD)] });
  writeText(intentP(), 'not json');
  assert.equal(runLoader({ pid: 980005, ps: cliLine(600) }).calls.ready.length, 1);
  assert.ok(!existsSync(intentP()));
  writeIntent();
  assert.equal(runLoader({ pid: 980006, ps: cliLine(600) }).calls.ready.length, 0, 'valid token: inherited');
  assert.equal(runLoader({ pid: 980007, ps: cliLine(600) }).calls.ready.length, 1, 'the second launch has no token any more');
});

test('inheritance never applies to a failed inspection (no fingerprints to compare)', () => {
  setup(); guardProfile();
  mkdirSync(runDirP(), { recursive: true });
  writeJson(lastContinueP(), { at: 'x', fingerprints: [fpOf(CLI_CMD)] });
  writeIntent();
  assert.equal(runLoader({ pid: 980008, ps: new Error('ps failed') }).calls.ready.length, 1);
});

test('an explicit Continue stores the conflict fingerprints (pid-free); a Quit clears them', () => {
  setup(); guardProfile();
  let r = runLoader({ pid: 980009, ps: [cliLine(600), psLine(500, STOCK, HOME_ENV())].join('\n'), dialogChoice: 0 });
  r.calls.ready[0]();
  const stored = readJson(lastContinueP());
  assert.ok(Date.parse(stored.at));
  assert.deepEqual(stored.fingerprints.sort(), [fpOf(CLI_CMD), '/Applications/ChatGPT.app'].sort());
  assert.ok(!JSON.stringify(stored).includes('600'), 'never the pid');
  r = runLoader({ pid: 980010, ps: cliLine(601), dialogChoice: 2 });
  r.calls.ready[0]();
  assert.ok(!existsSync(lastContinueP()), 'Quit clears the stored set');
});

test('inherited relaunch chain: Continue, then two framework relaunches in a row without further prompts', () => {
  setup(); guardProfile();
  let r = runLoader({ pid: 980011, ps: cliLine(600), dialogChoice: 0 });
  r.calls.ready[0]();
  for (const pid of [980012, 980013]) {
    writeIntent();
    r = runLoader({ pid, ps: cliLine(pid - 100000) });           // a different pid, same executable and argv
    assert.equal(r.calls.ready.length, 0, `relaunch ${pid} inherits`);
  }
});

test('a trusted entry plus a NEW process prompts, and only the new one is listed', () => {
  setup(); guardProfile({ guardTrusted: [fpOf(CLI_CMD)] });
  const newcomer = '/Users/u/bin/codex app-server --listen ws://0.0.0.0:7';
  const r = runLoader({ pid: 980019, ps: [cliLine(600), cliLine(601, newcomer)].join('\n') });
  assert.equal(r.calls.ready.length, 1);
  r.calls.ready[0]();
  assert.match(r.calls.dialogs[0].detail, /pid 601/); assert.doesNotMatch(r.calls.dialogs[0].detail, /pid 600/);
});

test('trusting does not hide an unreadable-environment server or the stock app', () => {
  setup(); guardProfile({ guardTrusted: [fpOf(CLI_CMD), '/Applications/ChatGPT.app'] });
  let r = runLoader({ pid: 980020, ps: psLine(700, CLI_CMD, '') });                 // environment unreadable
  assert.equal(r.calls.ready.length, 1);
  r = runLoader({ pid: 980021, ps: psLine(500, STOCK, HOME_ENV()) });
  assert.equal(r.calls.ready.length, 1);
});

test('the loader\'s own LKG reopen leaves a relaunch token for the reopened instance (and removes it when open fails)', () => {
  const { B, stable } = lkgSetup({ symlinkTo: 'good' });
  runLoader({ pid: 980023, execPath: join(B, 'Contents', 'MacOS', 'ChatGPT') });
  assert.ok(existsSync(intentP()), 'token left for the reopened bundle');
  assert.equal(readJson(intentP()).reason, 'lkg-reopen');
  rmSync(intentP()); rmSync(stable);
  lkgSetup({ symlinkTo: 'good' });
  runLoader({ pid: 980024, execPath: join(B, 'Contents', 'MacOS', 'ChatGPT'), openStatus: 1 });
  assert.ok(!existsSync(intentP()), 'nobody is coming, so no token');
});

// ---------------------------------------------------------------- v1.22: Quit the other Codex / Continue anyway -> Just this time | Always allow
const FASTWAIT = { CODEX_MODS_GUARD_QUIT_WAIT_MS: '300', CODEX_MODS_GUARD_FORCE_WAIT_MS: '300' };
/** A ps that lists only processes still alive in the fake process table. */
const livePs = (entries, procs) => () => entries.filter((e) => procs[e.pid]?.alive !== false).map((e) => e.line).join('\n');
const CLI_A = '/Users/u/bin/codex app-server --listen unix://';
const stockEntry = { pid: 500, line: psLine(500, STOCK, HOME_ENV()) };
const cliEntry = (pid, cmd = CLI_A) => ({ pid, line: cliLine(pid, cmd) });
const decisionLog = () => readGuardLog().at(-1);

test('v1.22 buttons: [Continue anyway, Quit the other Codex, Quit], default and cancel on Quit', () => {
  setup(); guardProfile();
  const r = runLoader({ pid: 990001, ps: cliLine(600), dialogChoice: 2 });
  r.calls.ready[0]();
  const d = r.calls.dialogs[0];
  assert.deepEqual(d.buttons, ['Continue anyway', 'Quit the other Codex', 'Quit']);
  assert.equal(d.defaultId, 2); assert.equal(d.cancelId, 2);
  assert.deepEqual(r.calls.exit, [0]);
});

test('no "Quit the other Codex" button when nothing identifiable can be quit (failed inspection, unreadable environment only)', () => {
  setup(); guardProfile();
  let r = runLoader({ pid: 990002, ps: new Error('ps broke'), dialogChoice: 1 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.dialogs[0].buttons, ['Continue anyway', 'Quit']);
  assert.deepEqual(r.calls.exit, [0], 'index 1 is Quit here');
  r = runLoader({ pid: 990003, ps: psLine(703, CLI_A, ''), dialogChoice: 1 });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.dialogs[0].buttons, ['Continue anyway', 'Quit']);
});

test('quit-others, everything exits gracefully: SIGTERM to exactly the listed pids, no second dialog, startup continues, logged', () => {
  setup(); guardProfile(); installDeferringFramework();
  const procs = { 500: { alive: true }, 600: { alive: true }, 700: { alive: true } };
  const other = cliEntry(700, '/Users/u/bin/codex app-server --listen ws://elsewhere');
  other.line = psLine(700, '/Users/u/bin/codex app-server --listen ws://elsewhere', HOME_ENV('/somewhere/else'));      // another Codex home: NOT in the warning
  const hidden = { pid: 703, line: psLine(703, '/Users/u/bin/codex app-server --x', '') };                                // unreadable environment: nothing to quit
  procs[703] = { alive: true };
  const r = runLoader({ pid: 990004, env: FASTWAIT, procs, dialogChoice: 1, ps: livePs([stockEntry, cliEntry(600), other, hidden], procs) });
  assert.equal(globalThis.__fw.begins, 0, 'held back while the warning is up');
  r.calls.ready[0]();
  assert.deepEqual(r.calls.signals.sort(), [[500, 'SIGTERM'], [600, 'SIGTERM']], 'only the identifiable listed processes, SIGTERM only');
  assert.equal(r.calls.dialogs.length, 1, 'no survivor dialog');
  assert.deepEqual(r.calls.exit, []); assert.equal(globalThis.__fw.begins, 1, 'startup continues normally');
  const e = decisionLog();
  assert.equal(e.decision, 'quit-others'); assert.deepEqual(e.pids.sort(), [500, 600]); assert.equal(e.outcome, 'exited');
  assert.ok(!('guardTrusted' in readJson(L.profileConfig)), 'quitting never trusts');
  assert.ok(!existsSync(lastContinueP()), 'there is nothing left to inherit');
});

test('quit-others on the stock app alone: SIGTERM to its main process, then continue', () => {
  setup(); guardProfile();
  const procs = { 500: { alive: true } };
  const r = runLoader({ pid: 990005, env: FASTWAIT, procs, dialogChoice: 1, ps: livePs([stockEntry], procs) });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.signals, [[500, 'SIGTERM']]);
  assert.deepEqual(r.calls.exit, []); assert.equal(decisionLog().decision, 'quit-others');
});

test('quit-others with a survivor, then Force quit: second dialog [Force quit, Cancel] (default and cancel on Cancel); SIGKILL only to the survivor', () => {
  setup(); guardProfile(); installDeferringFramework();
  const procs = { 500: { alive: true }, 600: { alive: true, survivesTerm: true } };
  const r = runLoader({ pid: 990006, env: FASTWAIT, procs, dialogChoice: [1, 0], ps: livePs([stockEntry, cliEntry(600)], procs) });
  r.calls.ready[0]();
  const d2 = r.calls.dialogs[1];
  assert.deepEqual(d2.buttons, ['Force quit', 'Cancel']); assert.equal(d2.defaultId, 1); assert.equal(d2.cancelId, 1);
  assert.match(d2.detail, /pid 600/); assert.doesNotMatch(d2.detail, /pid 500/);
  assert.deepEqual(r.calls.signals, [[500, 'SIGTERM'], [600, 'SIGTERM'], [600, 'SIGKILL']], 'SIGKILL goes to the survivor only');
  assert.deepEqual(r.calls.exit, []); assert.equal(globalThis.__fw.begins, 1);
  const e = decisionLog();
  assert.equal(e.decision, 'quit-others'); assert.equal(e.outcome, 'force-quit'); assert.deepEqual(e.forced, [600]);
});

test('quit-others with a survivor, then Cancel: the copy quits (guard-quit path: marker restored, lock released), no SIGKILL, framework never starts', () => {
  setup(); guardProfile(); installDeferringFramework();
  const prior = JSON.stringify({ generation: 3, startedAt: 'x', state: 'healthy', unhealthyCount: 0 }) + '\n';
  writeText(join(L.flags, 'boot.json'), prior);
  const procs = { 600: { alive: true, survivesTerm: true } };
  const r = runLoader({ pid: 990007, env: FASTWAIT, procs, dialogChoice: [1, 1], ps: livePs([cliEntry(600)], procs) });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.signals, [[600, 'SIGTERM']]);
  assert.deepEqual(r.calls.exit, [0]); assert.equal(globalThis.__fw.begins, 0);
  assert.equal(markerText(), prior); assert.ok(!existsSync(lockFile()));
  assert.equal(decisionLog().decision, 'quit-others-cancelled');
});

test('the survivor dialog: Escape (its cancelId = Cancel) and a dialog failure both cancel; Force quit that cannot kill quits too', () => {
  setup(); guardProfile();
  const procs = { 600: { alive: true, survivesTerm: true } };
  let r = runLoader({ pid: 990008, env: FASTWAIT, procs, dialogChoice: [1, 1], ps: livePs([cliEntry(600)], procs) });
  r.calls.ready[0](); assert.deepEqual(r.calls.exit, [0]);
  procs[600].alive = true;
  r = runLoader({ pid: 990009, env: FASTWAIT, procs, dialogChoice: [1], dialogThrows: 2, ps: livePs([cliEntry(600)], procs) });
  r.calls.ready[0](); assert.deepEqual(r.calls.exit, [0], 'a failing survivor dialog counts as Cancel');
  // a process that ignores even SIGKILL (uninterruptible): the copy still quits, logged
  const stuck = { 600: { alive: true, survivesTerm: true, immortal: true } };
  r = runLoader({ pid: 990010, env: FASTWAIT, procs: stuck, dialogChoice: [1, 0], ps: livePs([cliEntry(600)], stuck) });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.signals, [[600, 'SIGTERM'], [600, 'SIGKILL']]);
  assert.deepEqual(r.calls.exit, [0]); assert.equal(decisionLog().decision, 'quit-others-failed');
});

test('re-validation: a pid reused by another program (or gone) between the warning and the signal is NOT signalled', () => {
  setup(); guardProfile();
  const procs = { 600: { alive: true }, 601: { alive: true } };
  const first = [cliEntry(600), cliEntry(601)].map((e) => e.line).join('\n');
  const later = [cliLine(600, '/usr/bin/vim notes.txt'), ''].join('\n');            // 600 now another program; 601 not running any more
  const r = runLoader({ pid: 990011, env: FASTWAIT, procs, dialogChoice: 1, ps: (n) => (n === 0 ? first : later) });
  r.calls.ready[0]();
  assert.deepEqual(r.calls.signals, [], 'nothing signalled');
  const e = decisionLog();
  assert.deepEqual(e.skipped.sort(), [600, 601]); assert.deepEqual(r.calls.exit, []);
});

test('Continue anyway -> second dialog [Just this time, Always allow this server]: Just this time stores NO trust', () => {
  setup(); guardProfile(); installDeferringFramework();
  const r = runLoader({ pid: 990012, ps: cliLine(600), dialogChoice: [0, 0] });
  r.calls.ready[0]();
  const d2 = r.calls.dialogs[1];
  assert.deepEqual(d2.buttons, ['Just this time', 'Always allow this server']); assert.equal(d2.defaultId, 0); assert.equal(d2.cancelId, 0);
  assert.ok(!('guardTrusted' in readJson(L.profileConfig)));
  assert.equal(decisionLog().decision, 'continue'); assert.equal(globalThis.__fw.begins, 1);
  assert.ok(existsSync(lastContinueP()), 'v1.19 inheritance still records the Continue');
  const again = runLoader({ pid: 990013, ps: cliLine(601) });
  assert.equal(again.calls.ready.length, 1, 'a later launch prompts again');
});

test('Continue anyway -> Always allow this server stores the trust (other profile fields kept), logs continue-trusted, and the next launch does not prompt', () => {
  setup(); guardProfile({ launchArgs: ['--x'], signingIdentity: 'id' }); installDeferringFramework();
  const r = runLoader({ pid: 990014, ps: cliLine(600), dialogChoice: [0, 1] });
  r.calls.ready[0]();
  assert.deepEqual(readJson(L.profileConfig).guardTrusted, [fpOf(CLI_CMD)]);
  const prof = readJson(L.profileConfig); assert.equal(prof.signingIdentity, 'id'); assert.deepEqual(prof.launchArgs, ['--x']);
  assert.equal(decisionLog().decision, 'continue-trusted'); assert.equal(globalThis.__fw.begins, 1);
  const next = runLoader({ pid: 990015, ps: cliLine(601) });
  assert.equal(next.calls.ready.length, 0); assert.equal(next.started.length, 1);
});

test('Escape (cancelId) or an unexpected value on the second dialog takes its default: Just this time', () => {
  setup(); guardProfile();
  for (const second of [0, 9, -1, 'x']) {
    const r = runLoader({ pid: 990016, ps: cliLine(600), dialogChoice: [0, second] });
    r.calls.ready[0]();
    assert.equal(decisionLog().decision, 'continue', String(second));
    assert.ok(!('guardTrusted' in readJson(L.profileConfig)), String(second));
  }
  const f = runLoader({ pid: 990018, ps: cliLine(600), dialogChoice: [0], dialogThrows: 2 });
  f.calls.ready[0]();
  assert.equal(decisionLog().decision, 'continue', 'a failing second dialog is Just this time');
});

test('"Always allow" is never offered with the stock app (or unreadable/failed checks): Continue then proceeds directly', () => {
  setup(); guardProfile();
  for (const table of [psLine(500, STOCK, HOME_ENV()), [psLine(500, STOCK, HOME_ENV()), cliLine(600)].join('\n'), [cliLine(600), psLine(703, CLI_A + ' --hidden', '')].join('\n'), new Error('ps broke')]) {
    const r = runLoader({ pid: 990019, ps: table, dialogChoice: 0 });
    r.calls.ready[0]();
    assert.equal(r.calls.dialogs.length, 1, 'a single dialog: there is nothing to trust');
    assert.equal(decisionLog().decision, 'continue');
    assert.ok(!('guardTrusted' in readJson(L.profileConfig)));
  }
});

test('first dialog Escape = Quit on every variant (cancelId equals the Quit index)', () => {
  setup(); guardProfile();
  for (const table of [psLine(500, STOCK, HOME_ENV()), cliLine(600), new Error('ps broke')]) {
    const r = runLoader({ pid: 990020, ps: table, dialogChoice: 0 });
    r.calls.ready[0]();
    const d = r.calls.dialogs[0];
    assert.equal(d.buttons[d.cancelId], 'Quit'); assert.equal(d.buttons[d.defaultId], 'Quit');
  }
});
