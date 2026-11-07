// Integration test 3: the GOAL.md G1 lifecycle, headless, through the CLI only, on one mod
// (the counter fixture, tests/fixtures/mods/counter, id substituted): install, consent deny, install, approve, enable, configure, disable, re-enable,
// compatible update, changed-permission update with consent, rollback, remove keeping data, reinstall, reattach, remove deleting
// data. `codexmods mods inspect` state and the op outcome are asserted after every step.
//
// Updates of an ENABLED mod wait out the 60 s health window (ARCHITECTURE section 11.4; not configurable in the Host), so the
// updates here run while the mod is disabled; the enabled-update path is in slice-health.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeKey, packMod, shortRoot, rmrf, startSlice, counterCopy, waitFor, sleep } from './slice-fixtures/kit.mjs';

const ID = 'codexmods.g1-starter';
const OBSERVE = 'appServer.observe:thread/started';

test('G1 lifecycle through the CLI only', async (t) => {
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const pack = (version, permissions) => packMod(counterCopy(join(work, `src-${version}`), { id: ID, version, permissions }), key.keyFile, join(work, `${version}.codexmod`)).file;
  const v1 = pack('0.1.0', [OBSERVE, 'ui']);
  const v2 = pack('0.2.0', [OBSERVE, 'ui']);                       // compatible: same permissions
  const v3 = pack('0.3.0', [OBSERVE, 'ui', 'network']);            // adds a permission
  const op = (r, outcome = 'succeeded') => { assert.equal(r.op?.outcome, outcome, `${r.stdout}${r.stderr}`); return r.op; };
  const dataFile = (f) => join(slice.layout.data, ID, f);
  /** The counter keeps a thread/started count in its storage; read it from disk. */
  const counted = () => {
    if (!existsSync(dataFile('store.json'))) return 0;
    const raw = JSON.parse(readFileSync(dataFile('store.json'), 'utf8'));
    return (raw.data ?? raw).threads?.value ?? (raw.data ?? raw).threads ?? 0;
  };
  const app = slice.app();
  await app.handshake();
  const startThread = async () => { await app.request('thread/start', {}); };

  // ---- install; consent denied
  let r = slice.mutate(['mods', 'install', v1]);
  assert.equal(op(r).awaiting, 'consent');
  assert.equal(slice.inspect(ID).status, 'pending-consent');
  assert.equal(slice.inspect(ID).version, '0.1.0');
  assert.deepEqual(slice.list().map((m) => [m.id, m.status]), [[ID, 'pending-consent']]);
  r = slice.mutate(['mods', 'consent', ID, '--deny']);
  op(r);
  assert.equal(slice.inspect(ID), null, 'a denied install leaves no mod');
  assert.deepEqual(slice.list(), []);

  // ---- install again; approve without enabling
  r = slice.mutate(['mods', 'install', v1]);
  assert.equal(op(r).awaiting, 'consent');
  r = slice.mutate(['mods', 'consent', ID, '--approve']);
  op(r);
  let d = slice.inspect(ID);
  assert.equal(d.status, 'disabled');
  assert.deepEqual(d.grants, [OBSERVE, 'ui']);
  assert.deepEqual(d.versionsInStore, ['0.1.0']);
  await startThread();
  await sleep(300);
  assert.equal(counted(), 0, 'a disabled mod does not run');

  // ---- enable: it runs
  r = slice.mutate(['mods', 'enable', ID]);
  op(r);
  assert.equal(slice.inspect(ID).status, 'enabled');
  await startThread();
  await waitFor('the counter to count a thread', () => counted() === 1);

  // ---- configure
  r = slice.mutate(['mods', 'configure', ID, '--set', 'greeting=Hi from G1']);
  op(r);
  assert.deepEqual(slice.inspect(ID).settings, { greeting: 'Hi from G1' });
  r = slice.mutate(['mods', 'configure', ID, '--set', 'greeting=Second']);
  op(r);
  assert.deepEqual(slice.inspect(ID).settings, { greeting: 'Second' });
  const notText = slice.cli(['mods', 'configure', ID, '--set', 'greeting=5'], { json: false });
  assert.notEqual(notText.status, 0, 'a value not of its kind is refused');
  assert.deepEqual(slice.inspect(ID).settings, { greeting: 'Second' });

  // ---- disable, re-enable
  op(slice.mutate(['mods', 'disable', ID]));
  assert.equal(slice.inspect(ID).status, 'disabled');
  await startThread();
  await sleep(300);
  assert.equal(counted(), 1, 'disabled: not counting');
  op(slice.mutate(['mods', 'enable', ID]));
  assert.equal(slice.inspect(ID).status, 'enabled');
  await startThread();
  await waitFor('the re-enabled mod to count again', () => counted() === 2);

  // ---- compatible update (same permissions): applies without asking, data and settings kept
  op(slice.mutate(['mods', 'disable', ID]));
  r = slice.mutate(['mods', 'update', ID, v2]);
  assert.equal(op(r).awaiting, undefined, 'no consent needed for an update that adds no permissions');
  d = slice.inspect(ID);
  assert.equal(d.version, '0.2.0');
  assert.equal(d.status, 'disabled');
  assert.deepEqual(d.versionsInStore, ['0.1.0', '0.2.0']);
  assert.deepEqual(d.settings, { greeting: 'Second' });
  assert.equal(d.pendingUpdate, null);

  // ---- update that adds a permission: staged, waits for consent, the old version stays installed
  r = slice.mutate(['mods', 'update', ID, v3]);
  assert.equal(op(r).awaiting, 'consent');
  d = slice.inspect(ID);
  assert.equal(d.version, '0.2.0', 'the installed version does not change before consent');
  assert.deepEqual(d.pendingUpdate, { version: '0.3.0', addedPermissions: ['network'] });
  assert.ok(d.pendingPermissionText.some((p) => /network/i.test(p.text)), 'consent screen shows what the update adds');
  assert.deepEqual(d.grants, [OBSERVE, 'ui']);
  r = slice.mutate(['mods', 'consent', ID, '--approve']);
  op(r);
  d = slice.inspect(ID);
  assert.equal(d.version, '0.3.0');
  assert.deepEqual(d.grants, [OBSERVE, 'ui', 'network']);
  assert.equal(d.pendingUpdate, null);
  assert.deepEqual(d.versionsInStore, ['0.1.0', '0.2.0', '0.3.0']);

  // ---- a declined permission update changes nothing
  const v4 = pack('0.4.0', [OBSERVE, 'ui', 'network', 'processes']);
  r = slice.mutate(['mods', 'update', ID, v4]);
  assert.equal(op(r).awaiting, 'consent');
  assert.deepEqual(slice.inspect(ID).pendingUpdate.addedPermissions, ['processes']);
  r = slice.mutate(['mods', 'consent', ID, '--deny']);
  op(r);
  d = slice.inspect(ID);
  assert.equal(d.version, '0.3.0');
  assert.equal(d.pendingUpdate, null);
  assert.deepEqual(d.grants, [OBSERVE, 'ui', 'network']);

  // ---- rollback to 0.2.0 while enabled: grants shrink back, the mod runs again
  op(slice.mutate(['mods', 'enable', ID]));
  await startThread();
  await waitFor('0.3.0 to count', () => counted() === 3);
  r = slice.mutate(['mods', 'rollback', ID, '0.2.0']);
  op(r);
  d = slice.inspect(ID);
  assert.equal(d.version, '0.2.0');
  assert.equal(d.status, 'enabled');
  assert.deepEqual(d.grants, [OBSERVE, 'ui']);
  await startThread();
  await waitFor('the rolled-back version to count', () => counted() === 4);
  const bad = slice.cli(['mods', 'rollback', ID, '9.9.9'], { json: false });
  assert.notEqual(bad.status, 0, 'rollback to a version that is not in the store is refused');

  // ---- remove, keeping data
  const settingsBefore = readFileSync(dataFile('settings.json'), 'utf8');
  r = slice.mutate(['mods', 'remove', ID]);
  op(r);
  assert.equal(slice.inspect(ID), null);
  assert.deepEqual(slice.list(), []);
  // v1.13: kept data is a generation, orphaned/<id>/<ISO-timestamp>/ with .orphan.json inside (the newest sorts last)
  const generations = readdirSync(join(slice.layout.orphaned, ID)).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
  assert.ok(generations.length >= 1, 'a generation directory was created under orphaned/<id>/');
  const newest = join(slice.layout.orphaned, ID, generations.at(-1));
  assert.ok(existsSync(join(newest, 'settings.json')), 'data kept inside the newest orphan generation');
  const meta = JSON.parse(readFileSync(join(newest, '.orphan.json'), 'utf8'));
  assert.ok(meta.version, 'the generation records the removed version');
  assert.ok(meta.removedAt && Date.parse(meta.removedAt), 'the generation records when it was removed');
  assert.ok(!existsSync(join(slice.layout.data, ID)), 'live data directory gone');
  await startThread();
  await sleep(300);
  assert.ok(!existsSync(dataFile('store.json')), 'a removed mod does not run');

  // ---- reinstall, approve (not enabled), reattach the kept data
  r = slice.mutate(['mods', 'install', v2]);
  assert.equal(op(r).awaiting, 'consent');
  op(slice.mutate(['mods', 'consent', ID, '--approve']));
  assert.equal(slice.inspect(ID).status, 'disabled');
  r = slice.mutate(['mods', 'reattach', ID]);
  op(r);
  assert.equal(readFileSync(dataFile('settings.json'), 'utf8'), settingsBefore, 'the kept settings are back byte for byte');
  assert.deepEqual(slice.inspect(ID).settings, { greeting: 'Second' });
  assert.ok(!existsSync(join(slice.layout.orphaned, ID)), 'orphaned data consumed');

  // ---- remove, deleting data
  op(slice.mutate(['mods', 'enable', ID]));
  r = slice.mutate(['mods', 'remove', ID, '--delete-data']);
  op(r);
  assert.equal(slice.inspect(ID), null);
  for (const p of [join(slice.layout.data, ID), join(slice.layout.orphaned, ID), join(slice.layout.snapshots, ID), join(slice.layout.retained, ID)]) {
    assert.ok(!existsSync(p), `${p} deleted`);
  }

  // ---- the journal tells the whole story, and every op has a truthful terminal outcome
  const ops = slice.cli(['ops', 'list', '--mod', ID]).json.ops;
  assert.ok(ops.length >= 20, `journal has ${ops.length} ops`);
  assert.ok(ops.every((o) => o.outcome === 'succeeded'), JSON.stringify(ops.filter((o) => o.outcome !== 'succeeded').map((o) => [o.input.type, o.outcome])));
  assert.ok(ops.every((o) => o.endedAt && o.phases.length > 0));
  assert.deepEqual([...new Set(ops.map((o) => o.input.type))].sort(),
    ['configure', 'consent', 'disable', 'enable', 'install', 'reattach', 'remove', 'rollback', 'update']);
});
