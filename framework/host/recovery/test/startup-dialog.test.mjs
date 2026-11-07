// waiting on a blocking startup dialog never counts as a failed start. Safe mode off: an explicit "try normally" ends the streak.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRecovery } from '../index.mjs';
import { readJson, writeJsonAtomic } from '../../fsutil.mjs';
import { run as recoveryCmd } from '../../../../cli/commands/recovery.mjs';
import { fixture } from './helpers.mjs';

const { register } = createRequire(import.meta.url)('../../../main/recovery/index.cjs');
const exists = (p) => readFile(p).then(() => true, () => false);
const marker = (f) => readJson(join(f.layout.flags, 'boot.json'));
const dialogFile = (f) => join(f.layout.flags, 'startup-dialog.json');
const signals = async (rec, f) => { rec.report('window-rendered'); rec.report('host-ready'); f.bus.publish('appServer/ready', {}, { state: true }); await rec.idle(); };

/** framework-main side with a controllable dialog. */
function mainSide(f, _reason = 'unhealthy-boots') {
  const sent = []; const handlers = {}; const calls = [];
  let answer; const shown = new Promise((r) => { answer = r; });
  const hooks = {
    safe: true, layout: { flags: f.layout.flags }, sendToHost: (m) => sent.push(m), onHostMessage() {}, log: { info() {}, error() {} },
    electron: {
      app: { on: (e, fn) => { handlers[e] = fn; }, relaunch: () => calls.push('relaunch'), exit: (c) => calls.push(`exit:${c}`) },
      onWindowCreated() {},
      showMessageBox: () => shown,
    },
  };
  return { hooks, sent, handlers, calls, choose: answer, open: async () => { register(hooks); const p = handlers.ready(); await new Promise((r) => setImmediate(r)); return p; } };
}
async function boot(f, { unhealthyCount = 1, reason = 'unhealthy-boots' } = {}) {
  await writeJsonAtomic(join(f.layout.flags, 'boot.json'), { state: 'booting', unhealthyCount, startedAt: 't' });
  await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason });
  const rec = createRecovery(f.base);
  await rec.beginBoot();
  return rec;
}
const withTimers = async (fn) => { mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); try { await fn(); } finally { mock.timers.reset(); } };

test('a dialog open far longer than the window, then Continue: the boot reaches healthy, the count resets, nothing was published unhealthy', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      const rec = await boot(f, { unhealthyCount: 1 });
      const m = mainSide(f);
      const done = m.open();
      assert.equal(await exists(dialogFile(f)), true, 'the dialog marks itself open');
      mock.timers.tick(5 * 60_000);                                     // 5 minutes at the dialog
      assert.equal(f.bus.state('framework/health'), undefined, 'no unhealthy verdict while the dialog waits');
      m.choose(0); await done;
      assert.equal(await exists(dialogFile(f)), false, 'Continue clears the mark: the window resumes');
      mock.timers.tick(10_000);
      await signals(rec, f);
      assert.deepEqual(f.bus.state('framework/health'), { healthy: true });
      assert.deepEqual([(await marker(f)).state, (await marker(f)).unhealthyCount], ['healthy', 0]);
      assert.ok(f.bus.published.every((p) => p.topic !== 'framework/health' || p.data.healthy === true));
    } finally { await f.cleanup(); }
  });
});

test('safe mode you chose holds no start: no dialog marks itself, and the boot reaches healthy in its window (E6.4)', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      const rec = await boot(f, { unhealthyCount: 0, reason: 'safe-mode-op' });
      const m = mainSide(f);
      await m.open();
      assert.equal(await exists(dialogFile(f)), false, 'no message box');
      await signals(rec, f);
      assert.deepEqual(f.bus.state('framework/health'), { healthy: true });
    } finally { await f.cleanup(); }
  });
});

test('the window resumes after the dialog: only time outside the dialog counts', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      await boot(f);
      mock.timers.tick(10_000);                                         // 10 s of real startup
      await writeFile(dialogFile(f), JSON.stringify({ pid: process.pid, kind: 'safe-mode' }));
      mock.timers.tick(190_000);
      assert.equal(f.bus.state('framework/health'), undefined);
      await (await import('node:fs/promises')).rm(dialogFile(f));
      mock.timers.tick(49_000);
      assert.equal(f.bus.state('framework/health'), undefined, '10 s + 49 s < 60 s');
      mock.timers.tick(1_000);
      assert.deepEqual(f.bus.state('framework/health'), { healthy: false });
    } finally { await f.cleanup(); }
  });
});

test('a stale dialog mark of a dead process does not pause the window', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      const dead = spawn('/bin/sh', ['-c', 'exit 0']); await new Promise((r) => dead.once('close', r));
      await boot(f);
      await writeFile(dialogFile(f), JSON.stringify({ pid: dead.pid, kind: 'safe-mode' }));
      mock.timers.tick(60_000);
      assert.deepEqual(f.bus.state('framework/health'), { healthy: false });
    } finally { await f.cleanup(); }
  });
});

test('Restore last-known-good is an explicit choice: the count does not increment, the Host asked for the op, the window stays paused', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      await boot(f, { unhealthyCount: 1 });
      const m = mainSide(f);
      const done = m.open();
      mock.timers.tick(30_000);
      m.choose(1); await done;
      assert.deepEqual(m.sent, [{ type: 'recovery', action: 'lkg-restore' }]);
      const mk = await marker(f);
      assert.deepEqual([mk.state, mk.unhealthyCount], ['healthy', 0], 'the loader will not count this boot');
      mock.timers.tick(5 * 60_000);
      assert.equal(f.bus.state('framework/health'), undefined, 'no unhealthy verdict while the app is leaving');
    } finally { await f.cleanup(); }
  });
});

test('Disable framework is an explicit choice: the count does not increment; flags/disabled is written and the app relaunches', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      await boot(f, { unhealthyCount: 1 });
      const m = mainSide(f);
      const done = m.open();
      mock.timers.tick(90_000);
      m.choose(2); await done;
      const mk = await marker(f);
      assert.deepEqual([mk.state, mk.unhealthyCount], ['healthy', 0]);
      assert.equal(await exists(join(f.layout.flags, 'disabled')), true);
      assert.deepEqual(m.calls, ['relaunch', 'exit:0']);
      assert.equal(f.bus.state('framework/health'), undefined);
    } finally { await f.cleanup(); }
  });
});

test('quitting while the dialog waits is not a failed start either', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      await boot(f, { unhealthyCount: 1 });
      const m = mainSide(f);
      m.open();
      m.handlers['before-quit']();
      const mk = await marker(f);
      assert.deepEqual([mk.state, mk.unhealthyCount, mk.resetBy], ['healthy', 0, 'quit-during-dialog']);
    } finally { await f.cleanup(); }
  });
});

// ------------------------------------------------------------------ explicit "safe off"
const cliIo = (deps = {}) => ({ stdout: { write() {} }, stderr: { write() {} }, env: {}, deps });

test('recovery safe off (offline) resets the unhealthy streak: state healthy, count 0; safe on leaves the marker alone', async () => {
  const f = await fixture();
  try {
    const mp = join(f.layout.flags, 'boot.json');
    await writeJsonAtomic(mp, { generation: 4, state: 'booting', unhealthyCount: 2, startedAt: 't' });
    await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'unhealthy-boots' });
    const offline = cliIo({ connectManagement: async () => null });
    assert.equal(await recoveryCmd(['--root', f.layout.root, 'safe', 'on'], offline), 0);
    assert.deepEqual([(await readJson(mp)).state, (await readJson(mp)).unhealthyCount], ['booting', 2]);
    assert.equal(await recoveryCmd(['--root', f.layout.root, 'safe', 'off'], offline), 0);
    const m = await readJson(mp);
    assert.deepEqual([m.state, m.unhealthyCount, m.generation], ['healthy', 0, 4]);
    assert.equal(await exists(join(f.layout.flags, 'safe')), false);
    // without any marker it is simply fine
    await (await import('node:fs/promises')).rm(mp);
    assert.equal(await recoveryCmd(['--root', f.layout.root, 'safe', 'off'], offline), 0);
  } finally { await f.cleanup(); }
});

test('safe off through the Host (the safe-mode operation) resets the unhealthy streak too', async () => {
  const f = await fixture({ deps: { exitGraceMs: 0 } });
  try {
    const mp = join(f.layout.flags, 'boot.json');
    await writeJsonAtomic(mp, { generation: 4, state: 'booting', unhealthyCount: 2, startedAt: 't' });
    await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'cli' });
    const rec = createRecovery(f.base);
    const res = await rec.runOp({ id: 'op-s', input: { type: 'safe-mode', enter: false }, phases: [] }, async () => {});
    assert.equal(res.outcome, 'succeeded');
    const m = await readJson(mp);
    assert.deepEqual([m.state, m.unhealthyCount], ['healthy', 0]);
    assert.equal(f.state.safeMode, false);
    // entering safe mode does not touch it
    await writeJsonAtomic(mp, { generation: 4, state: 'booting', unhealthyCount: 1, startedAt: 't' });
    await rec.runOp({ id: 'op-s2', input: { type: 'safe-mode', enter: true }, phases: [] }, async () => {});
    assert.deepEqual([(await readJson(mp)).state, (await readJson(mp)).unhealthyCount], ['booting', 1]);
  } finally { await f.cleanup(); }
});
