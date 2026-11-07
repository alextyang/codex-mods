// F3: headless reproductions of the framework-update path with the loader's marker rules, healthy and reverted.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRecovery } from '../index.mjs';
import { readJson, writeJsonAtomic } from '../../fsutil.mjs';
import { readText, writeTextAtomic } from '../support.mjs';
import { fixture, makeFrameworkTree } from './helpers.mjs';
import { readFile } from 'node:fs/promises';

const exists = (p) => readFile(p).then(() => true, () => false);
/** The loader's boot step (ARCHITECTURE, recovery): counts, reverts framework/current to framework/lkg at >= 2. */
async function loaderBoot(f) {
  const path = join(f.layout.flags, 'boot.json');
  const m = (await readJson(path, undefined)) ?? { generation: 0, state: 'healthy', unhealthyCount: 0 };
  let count = m.state === 'booting' ? m.unhealthyCount + 1 : 0;
  if (count >= 2) {
    await writeJsonAtomic(join(f.layout.flags, 'safe'), { reason: 'unhealthy-boots' });
    const lkg = await readText(f.layout.frameworkLkg); const cur = await readText(f.layout.frameworkCurrent);
    if (lkg && lkg !== cur) await writeTextAtomic(f.layout.frameworkCurrent, lkg);
  }
  await writeJsonAtomic(path, { ...m, state: 'booting', unhealthyCount: count });
  return { count, running: await readText(f.layout.frameworkCurrent) };    // the version this boot loads
}
const pass = async (rec, f) => { rec.report('window-rendered'); rec.report('host-ready'); f.bus.publish('appServer/ready', {}, { state: true }); await rec.idle(); };
const recFor = (f, v) => createRecovery({ ...f.base, frameworkVersion: v });
async function opFor(f, rec, id = 'op-fw') {
  const src = join(f.dir, 'src'); await makeFrameworkTree(src, { version: '1.0.1-phasef' });
  const op = { id, outcome: 'running', input: { type: 'framework-update', version: '1.0.1-phasef', sourceDir: src }, phases: [] };
  const res = await rec.runOp(op, async (p) => op.phases.push({ name: p, at: 't' }));
  return { op, res };
}
async function firstHealthyBoot(f) {
  await writeTextAtomic(f.layout.frameworkCurrent, '1.0.0-dev');
  await loaderBoot(f);
  const rec = recFor(f, '1.0.0-dev');
  await rec.beginBoot(); await pass(rec, f);
  assert.equal(await readText(f.layout.frameworkLkg), '1.0.0-dev');
  return rec;
}

test('F3: with a healthy boot marker the update is correct end to end (current written, previous kept, relaunch, healthy boot keeps it and writes LKG)', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const rec1 = await firstHealthyBoot(f);
    const { op, res } = await opFor(f, rec1);
    assert.equal(res.outcome, 'running');
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.1-phasef');
    assert.equal(await readText(f.layout.frameworkPrevious), '1.0.0-dev');
    assert.deepEqual(f.exits, [{ relaunch: true, reason: 'framework-update' }]);
    // boot 2: the loader loads the new framework; Operations.recover() asks Recovery before the gate has run
    assert.equal((await loaderBoot(f)).running, '1.0.1-phasef');
    const rec2 = recFor(f, '1.0.1-phasef');
    assert.equal(await rec2.reconcileOp(op), null, 'not proven yet: the op stays running, truthfully');
    const g = await rec2.beginBoot();
    assert.equal(g.frameworkVersion, '1.0.1-phasef');
    await pass(rec2, f);
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.1-phasef');
    assert.equal(await readText(f.layout.frameworkLkg), '1.0.1-phasef');
    assert.equal(rec2.lkg().frameworkVersion, '1.0.1-phasef');
    // boot 3: the verdict
    await loaderBoot(f);
    const verdict = await recFor(f, '1.0.1-phasef').reconcileOp(op);
    assert.equal(verdict.outcome, 'succeeded');
    assert.match(verdict.note, /passed the health gate/);
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('F3: a stale unhealthy marker (a rogue second instance, unhealthyCount 3) makes the loader revert; the op ends reverted with the reason, not succeeded', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const rec1 = await firstHealthyBoot(f);
    const { op } = await opFor(f, rec1);
    assert.equal(await readText(f.layout.frameworkCurrent), '1.0.1-phasef');
    // the rogue instance leaves the marker booting with count 3 before the relaunch
    const mp = join(f.layout.flags, 'boot.json');
    await writeJsonAtomic(mp, { ...(await readJson(mp)), state: 'booting', unhealthyCount: 3 });
    const boot = await loaderBoot(f);
    assert.equal(boot.running, '1.0.0-dev', 'the loader flipped current back to the LKG and the old framework loads');
    assert.ok(await exists(join(f.layout.flags, 'safe')));
    const rec2 = recFor(f, '1.0.0-dev');
    const verdict = await rec2.reconcileOp(op);
    assert.equal(verdict.outcome, 'reverted');
    assert.match(verdict.note, /^reverted by loader after unhealthy boots: framework current is 1\.0\.0-dev \(last-known-good\), expected 1\.0\.1-phasef/);
    assert.match(verdict.note, /previous is 1\.0\.0-dev/);
    assert.equal(verdict.result.reason, 'loader-revert');
    const g = await rec2.beginBoot();
    assert.equal(g.frameworkVersion, '1.0.0-dev', 'the next boot\'s Generation shows the old framework');
  } finally { mock.timers.reset(); await f.cleanup(); }
});

test('F3: the new framework boots twice without health: the op stays running until the loader reverts, then reports reverted', async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const rec1 = await firstHealthyBoot(f);
    const { op } = await opFor(f, rec1);
    for (let i = 0; i < 2; i++) {
      assert.equal((await loaderBoot(f)).running, '1.0.1-phasef');
      const rec = recFor(f, '1.0.1-phasef');
      assert.equal(await rec.reconcileOp(op), null, `boot ${i + 2}`);
      await rec.beginBoot(); rec.report('fatal');
    }
    assert.equal((await loaderBoot(f)).running, '1.0.0-dev');
    assert.equal((await recFor(f, '1.0.0-dev').reconcileOp(op)).outcome, 'reverted');
  } finally { mock.timers.reset(); await f.cleanup(); }
});
