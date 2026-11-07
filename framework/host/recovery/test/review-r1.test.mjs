// Review fixes: #5 effective LKG, #19 connectManagement settling, #22 retention.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createRecovery } from '../index.mjs';
import { connectManagement } from '../support.mjs';
import { run as recoveryCmd } from '../../../../cli/commands/recovery.mjs';
import { layout as makeLayout } from '../../../../contracts/layout.mjs';
import { readJson, writeJsonAtomic } from '../../fsutil.mjs';
import { fixture, modRecord } from './helpers.mjs';

const exists = (p) => readFile(p).then(() => true, () => false);
async function pass(rec, f) {
  rec.report('window-rendered'); rec.report('host-ready'); f.bus.publish('appServer/ready', {}, { state: true });
  await rec.idle();
}
const withTimers = async (fn) => { mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); try { await fn(); } finally { mock.timers.reset(); } };

test('#5 LKG certifies only mods that activated: unactivated enabled records are excluded and recorded disabled', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      f.state.mods.a = modRecord('a'); f.state.mods.b = modRecord('b');
      const rec = createRecovery({ ...f.base, activeMods: () => ['a'] });
      const boot = await rec.beginBoot();
      assert.deepEqual(boot.mods.map((m) => m.id), ['a', 'b'], 'the boot generation lists what was configured');
      await pass(rec, f);
      const lkg = rec.lkg();
      assert.deepEqual(lkg.mods.map((m) => m.id), ['a']);
      assert.equal(lkg.state.mods.b.status, 'disabled', 'a restore would not enable a mod that never ran');
      assert.equal(lkg.state.mods.a.status, 'enabled');
      assert.notEqual(lkg.n, boot.n);
      assert.equal((await readJson(join(f.layout.flags, 'boot.json'))).generation, lkg.n);
      assert.equal(f.state.mods.b.status, 'enabled', 'live state is not touched');
      // without activeMods every enabled record counts (back-compat); equal tuple reuses the boot generation
      const f2 = await fixture({ state: f.state });
      const rec2 = createRecovery(f2.base);
      const b2 = await rec2.beginBoot(); await pass(rec2, f2);
      assert.equal(rec2.lkg().n, b2.n);
      await f2.cleanup();
    } finally { await f.cleanup(); }
  });
});

test('#5 safe-mode boots never become LKG (flag, state.safeMode or opts.safeMode) but still reset the loader counter', async () => {
  for (const mode of ['flag', 'state', 'opt']) {
    const f = await fixture();
    await withTimers(async () => {
      try {
        await writeJsonAtomic(join(f.layout.flags, 'boot.json'), { state: 'booting', unhealthyCount: 1, startedAt: 't' });
        if (mode === 'flag') await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'x' });
        if (mode === 'state') f.state.safeMode = true;
        const rec = createRecovery({ ...f.base, ...(mode === 'opt' ? { safeMode: true } : {}) });
        await rec.beginBoot(); await pass(rec, f);
        assert.equal(rec.lkg(), undefined, mode);
        assert.equal(await exists(f.layout.frameworkLkg), false, mode);
        const m = await readJson(join(f.layout.flags, 'boot.json'));
        assert.deepEqual([m.state, m.unhealthyCount], ['healthy', 0], mode);
      } finally { await f.cleanup(); }
    });
  }
});

test('#5 any quarantine before health is fatal: bus event, op note, or a quarantined record stamped after boot start', async () => {
  for (const how of ['op-note', 'record', 'old-record-ignored']) {
    const f = await fixture();
    await withTimers(async () => {
      try {
        f.state.mods.a = modRecord('a');
        if (how === 'old-record-ignored') f.state.mods.old = modRecord('old', { status: 'quarantined', quarantine: { reason: 'r', at: '2000-01-01T00:00:00.000Z' } });
        const rec = createRecovery(f.base);
        await rec.beginBoot();
        if (how === 'op-note') f.bus.publish('framework/op', { id: 'op-1', input: { type: 'disable', modId: 'a' }, outcome: 'succeeded', note: 'quarantined: activation failed' });
        if (how === 'record') f.state.mods.a = modRecord('a', { status: 'quarantined', quarantine: { reason: 'r', at: new Date(Date.now() + 5).toISOString() } });
        await pass(rec, f);
        if (how === 'old-record-ignored') assert.ok(rec.lkg(), 'a quarantine from an earlier boot does not block health');
        else { assert.equal(rec.lkg(), undefined, how); assert.deepEqual(f.bus.state('framework/health'), { healthy: false }, how); }
      } finally { await f.cleanup(); }
    });
  }
});

test('#22 generations are pruned to the last 3 plus LKG and ones running ops reference; then gcPackages() is called with no arguments', async () => {
  const f = await fixture();
  await withTimers(async () => {
    try {
      const gcCalls = [];
      const gcPackages = async (...args) => gcCalls.push(args);
      f.state.mods.a = modRecord('a');
      for (let i = 1; i <= 5; i++) {
        f.state.mods.a.version = `1.${i}.0`;
        // an op that is still running and references generation 1 keeps it alive
        if (i === 2) await writeJsonAtomic(join(f.layout.ops, 'op-lkg.json'), { id: 'op-lkg', outcome: 'running', input: { type: 'lkg-restore' }, phases: [], result: { generation: 1 } });
        if (i === 4) await rm(join(f.layout.ops, 'op-lkg.json'));
        const rec = createRecovery({ ...f.base, gcPackages });
        await rec.beginBoot(); await pass(rec, f);
      }
      assert.deepEqual((await readdir(f.layout.generations)).sort(), ['3.json', '4.json', '5.json', 'lkg']);
      assert.equal(gcCalls.length, 5);
      assert.ok(gcCalls.every((a) => a.length === 0), 'no reference lists: Operations.gcStore owns cross-profile references and locking');
      // safe-mode boots neither prune nor GC
      await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'x' });
      f.state.mods.a.version = '1.6.0';
      const rec = createRecovery({ ...f.base, gcPackages });
      await rec.beginBoot(); await pass(rec, f);
      assert.equal(gcCalls.length, 5);
      assert.deepEqual((await readdir(f.layout.generations)).sort(), ['3.json', '4.json', '5.json', '6.json', 'lkg']);
    } finally { await f.cleanup(); }
  });
});

// ------------------------------------------------------------------ #19
async function shortLayout() {
  const root = await mkdtemp('/tmp/cm-');
  const l = makeLayout(root, 'default');
  await mkdir(l.run, { recursive: true, mode: 0o700 });
  return { root, l, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const timed = async (p, ms = 3500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('connectManagement hung')), ms))]);

test('#19 connectManagement settles null with a stale token and no socket, a stale socket file, or no token', async () => {
  const w = await shortLayout();
  try {
    assert.equal(await timed(connectManagement(w.l)), null, 'no token');
    await writeFile(join(w.l.run, 'mgmt.token'), 'stale-token\n');
    const t0 = Date.now();
    assert.equal(await timed(connectManagement(w.l)), null, 'token but no socket');
    assert.ok(Date.now() - t0 < 2500);
    await writeFile(join(w.l.run, 'mgmt.sock'), '');      // a leftover that is not a listening socket
    assert.equal(await timed(connectManagement(w.l)), null, 'stale socket file');
  } finally { await w.cleanup(); }
});

test('#19 connectManagement connects to a live management socket and settles null when the listener never answers the connect', async () => {
  const w = await shortLayout();
  try {
    await writeFile(join(w.l.run, 'mgmt.token'), 'tok\n');
    const server = createServer((c) => c.on('data', (d) => { const m = JSON.parse(d.toString().trim()); c.write(JSON.stringify({ id: m.id, ok: true, result: { echo: m.token } }) + '\n'); }));
    await new Promise((r) => server.listen(join(w.l.run, 'mgmt.sock'), r));
    try {
      const c = await timed(connectManagement(w.l));
      assert.deepEqual(await c.request('ops.list', {}), { echo: 'tok' });
      c.close();
    } finally { server.close(); }
  } finally { await w.cleanup(); }
});

test('#19 offline recovery commands reach their fallback with a stale token and no socket', async () => {
  const w = await shortLayout();
  try {
    await writeFile(join(w.l.run, 'mgmt.token'), 'stale\n');
    const out = []; const err = [];
    const code = await timed(recoveryCmd(['--root', w.root, 'safe', 'on'], { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {} }));
    assert.equal(code, 0, err.join(''));
    assert.ok(await exists(join(w.l.flags, 'safe')));
  } finally { await w.cleanup(); }
});
