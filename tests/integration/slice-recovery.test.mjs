// Integration test 5: crash recovery. The Host process is killed (SIGKILL, no cleanup) during an `update` op, between
// journal phases, using a test mod with a slow migration (or a slow activation). The Host is restarted on the same root:
// `ops get` must show a truthful terminal outcome and the mod must be in exactly one coherent version with its data intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeKey, shortRoot, rmrf, startSlice, waitFor, sleep, MIGRATOR_ID, buildMigrator } from './slice-fixtures/kit.mjs';

const ID = MIGRATOR_ID;
const build = buildMigrator;

const opFile = (slice, opId) => join(slice.layout.ops, `${opId}.json`);
const lastPhase = (slice, opId) => {
  try { return JSON.parse(readFileSync(opFile(slice, opId), 'utf8')).phases.at(-1)?.name; } catch { return undefined; }
};

/**
 * Installs v1 (schema 1, enabled, settings.note = 'original'), starts an update to `v2File` without waiting, kills the Host as soon
 * as the op journals `killAt`, restarts the Host on the same root, and returns what is observable afterwards.
 */
async function crashDuring(t, { killAt, v2 }) {
  const work = shortRoot('cms-w');
  let slice = await startSlice();
  const root = slice.root;
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const v1File = build(work, key, '1.0.0', 1);
  const v2File = v2(work, key);
  assert.equal(slice.mutate(['mods', 'install', v1File]).op?.awaiting, 'consent');
  assert.equal(slice.mutate(['mods', 'consent', ID, '--approve', '--enable']).op?.outcome, 'succeeded');
  assert.equal(slice.mutate(['mods', 'configure', ID, '--set', 'note=original']).op?.outcome, 'succeeded');
  const settingsFile = join(slice.layout.data, ID, 'settings.json');
  const settingsBefore = readFileSync(settingsFile, 'utf8');
  const app = slice.app();
  await app.handshake();
  await app.request('thread/start', {});
  assert.equal(slice.threadStarts().at(-1).params.config.mod_version, '1.0.0');

  const started = slice.cli(['mods', 'update', ID, v2File, '--no-wait']);
  assert.equal(started.status, 0, started.stderr);
  const opId = started.json.opId;
  await waitFor(`the update to journal "${killAt}"`, () => lastPhase(slice, opId) === killAt, 20_000, 10);
  const phasesAtKill = JSON.parse(readFileSync(opFile(slice, opId), 'utf8')).phases.map((p) => p.name);
  assert.equal(JSON.parse(readFileSync(opFile(slice, opId), 'utf8')).outcome, 'running');
  await slice.host.killHard();
  app.kill();
  await sleep(200);

  // ---- restart on the same root
  slice = await startSlice({ root });
  const after = {
    work, root, opId, phasesAtKill, settingsBefore, settingsFile,
    op: slice.cli(['ops', 'get', opId]).json,
    detail: slice.inspect(ID),
    state: JSON.parse(readFileSync(slice.layout.state, 'utf8')),
    slice,
  };
  return after;
}

function assertCoherentV1(a) {
  const { slice } = a;
  assert.equal(a.detail.version, '1.0.0', 'exactly one coherent version: the old one');
  assert.equal(a.state.mods[ID].version, '1.0.0');
  assert.equal(a.state.mods[ID].dataSchemaVersion, 1, 'the data schema matches the version');
  assert.equal(a.state.mods[ID].pendingUpdate, undefined);
  assert.equal(readFileSync(a.settingsFile, 'utf8'), a.settingsBefore, 'the data is exactly what it was before the update');
  const dataEntries = readdirSync(slice.layout.data);
  assert.deepEqual(dataEntries.filter((n) => n.startsWith('.')), [], `no staging leftovers in data/: ${dataEntries}`);
  const running = slice.cli(['ops', 'list', '--running']).json.ops;
  assert.deepEqual(running, [], 'no op is left running');
}

test('crash during the migration: recovers to the old version, data untouched, outcome failed', async (t) => {
  const a = await crashDuring(t, { killAt: 'migrate', v2: (work, key) => build(work, key, '2.0.0', 2, { migrateMs: 30_000 }) });
  assert.deepEqual(a.phasesAtKill.slice(-3), ['stop', 'snapshot', 'migrate']);
  assert.notEqual(a.op.outcome, 'running', 'the op reached a terminal outcome');
  assert.equal(a.op.outcome, 'failed');
  assert.ok(a.op.endedAt);
  assert.match(a.op.note, /1\.0\.0/);
  assertCoherentV1(a);
  assert.equal(a.detail.status, 'enabled', 'the mod is running again after the restart');
  const app = a.slice.app();
  await app.handshake();
  await app.request('thread/start', {});
  assert.equal(a.slice.threadStarts().at(-1).params.config.mod_version, '1.0.0', 'v1 code is live');
  // the mod is not left locked by the dead op: a new update can be started (not waited for: its migration takes 30 s)
  const again = a.slice.cli(['mods', 'update', ID, join(a.work, '2.0.0.codexmod'), '--no-wait']);
  assert.equal(again.status, 0, again.stderr);
});

test('crash while the new version is starting: rolled back to the old version, outcome needs-attention, data restored', async (t) => {
  const a = await crashDuring(t, {
    killAt: 'activate',
    v2: (work, key) => build(work, key, '2.0.0', 2, { migrateMs: 0, activateDelayMs: 8000 }),
  });
  assert.ok(a.phasesAtKill.includes('migrate') && a.phasesAtKill.includes('swap') && a.phasesAtKill.includes('apply'), a.phasesAtKill.join(','));
  assert.equal(a.op.outcome, 'needs-attention', 'new code may have had effects: the op must not claim a clean outcome');
  assert.ok(a.op.endedAt);
  assert.match(a.op.note, /1\.0\.0/);
  assertCoherentV1(a);   // including: the migrated data was restored from the snapshot
  assert.equal(a.detail.status, 'enabled');
  const app = a.slice.app();
  await app.handshake();
  await app.request('thread/start', {});
  assert.equal(a.slice.threadStarts().at(-1).params.config.mod_version, '1.0.0');
});

test('crash inside the health window: reverted to the old version', async (t) => {
  const a = await crashDuring(t, { killAt: 'health', v2: (work, key) => build(work, key, '2.0.0', 2, { migrateMs: 0 }) });
  assert.ok(a.phasesAtKill.includes('activate'));
  assert.equal(a.op.outcome, 'reverted');
  assert.ok(a.op.endedAt);
  assertCoherentV1(a);
  assert.equal(a.detail.status, 'enabled');
  const app = a.slice.app();
  await app.handshake();
  await app.request('thread/start', {});
  assert.equal(a.slice.threadStarts().at(-1).params.config.mod_version, '1.0.0');
});

test('a Host killed with no operation running restarts cleanly with the mod still enabled', async (t) => {
  const work = shortRoot('cms-w');
  let slice = await startSlice();
  const root = slice.root;
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const v1File = build(work, key, '1.0.0', 1);
  slice.mutate(['mods', 'install', v1File]);
  slice.mutate(['mods', 'consent', ID, '--approve', '--enable']);
  await slice.host.killHard();
  // a stale app.sock/mgmt.sock may remain after SIGKILL; the restart must cope
  slice = await startSlice({ root });
  assert.equal(slice.inspect(ID).status, 'enabled');
  const app = slice.app();
  await app.handshake();
  await app.request('thread/start', {});
  assert.equal(slice.threadStarts().at(-1).params.config.mod_version, '1.0.0');
});
