// Update safety (GOAL G2) through the real Host: the 60 s health window, automatic revert on a fault or a failing migration, and
// rollback with data restore. Extends integration tests 3 and 5; it needs the test.migrator mod from slice-fixtures/kit.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeKey, shortRoot, rmrf, startSlice, MIGRATOR_ID as ID, buildMigrator as build } from './slice-fixtures/kit.mjs';

async function installV1(t) {
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const v1 = build(work, key, '1.0.0', 1);
  assert.equal(slice.mutate(['mods', 'install', v1]).op?.awaiting, 'consent');
  assert.equal(slice.mutate(['mods', 'consent', ID, '--approve', '--enable']).op?.outcome, 'succeeded');
  assert.equal(slice.mutate(['mods', 'configure', ID, '--set', 'note=original']).op?.outcome, 'succeeded');
  const app = slice.app();
  await app.handshake();
  const live = async () => { await app.request('thread/start', {}); return slice.threadStarts().at(-1).params.config?.mod_version; };
  const settings = () => readFileSync(join(slice.layout.data, ID, 'settings.json'), 'utf8');
  return { work, key, slice, live, settings, settingsBefore: settings() };
}

test('update of an enabled mod: stop, snapshot, migrate, swap, apply, activate, health window, commit', async (t) => {
  const { work, key, slice, live } = await installV1(t);
  assert.equal(await live(), '1.0.0');
  const v2 = build(work, key, '2.0.0', 2, { migrateMs: 0 });
  const t0 = Date.now();
  const r = slice.mutate(['mods', 'update', ID, v2], 100_000);
  const took = Date.now() - t0;
  assert.equal(r.op?.outcome, 'succeeded', `${r.stdout}${r.stderr}`);
  assert.deepEqual(r.op.phases.map((p) => p.name).filter((n) => n !== 'verify' && n !== 'store' && n !== 'compatibility'),
    ['stop', 'snapshot', 'migrate', 'swap', 'apply', 'activate', 'health', 'commit']);
  assert.ok(took >= 55_000, `the health window was observed (${took} ms)`);
  assert.equal(slice.inspect(ID).version, '2.0.0');
  assert.equal(slice.inspect(ID).status, 'enabled');
  assert.deepEqual(slice.inspect(ID).settings, { note: 'migrated' }, 'the migration ran on the data');
  assert.equal(await live(), '2.0.0');
  assert.deepEqual(slice.inspect(ID).snapshots.map((s) => s.fromVersion), ['1.0.0'], 'a snapshot of the old data exists');
});

test('update whose new version faults inside the health window is reverted automatically', async (t) => {
  const { work, key, slice, live, settings, settingsBefore } = await installV1(t);
  const v2 = build(work, key, '2.0.0', 2, { migrateMs: 0, faultAfterActivate: true });
  const t0 = Date.now();
  const r = slice.mutate(['mods', 'update', ID, v2]);
  assert.equal(r.op?.outcome, 'reverted', `${r.stdout}${r.stderr}`);
  assert.ok(Date.now() - t0 < 20_000, 'the revert did not wait out the window');
  assert.match(r.op.note, /1\.0\.0/);
  assert.equal(slice.inspect(ID).version, '1.0.0');
  assert.equal(slice.inspect(ID).status, 'enabled');
  assert.equal(settings(), settingsBefore, 'data restored from the snapshot');
  assert.equal(JSON.parse(readFileSync(slice.layout.state, 'utf8')).mods[ID].dataSchemaVersion, 1);
  assert.equal(await live(), '1.0.0', 'the old version runs again');
});

test('update whose migration fails is reverted with the data untouched', async (t) => {
  const { work, key, slice, live, settings, settingsBefore } = await installV1(t);
  const v2 = build(work, key, '2.0.0', 2, { migrateMs: 0, migrateThrows: true });
  const r = slice.mutate(['mods', 'update', ID, v2]);
  assert.ok(['failed', 'reverted'].includes(r.op?.outcome), `${r.stdout}${r.stderr}`);
  assert.equal(r.op.error?.code ?? 'Invalid', 'Invalid');
  assert.equal(slice.inspect(ID).version, '1.0.0');
  assert.equal(slice.inspect(ID).status, 'enabled');
  assert.equal(settings(), settingsBefore);
  assert.equal(await live(), '1.0.0');
  assert.ok(!existsSync(join(slice.layout.data, `.staging-${r.op.id}`)), 'staging directory cleaned up');
});

test('rollback with data restore returns code, schema and data to the earlier version', async (t) => {
  const { work, key, slice, live, settings, settingsBefore } = await installV1(t);
  const v2 = build(work, key, '2.0.0', 2, { migrateMs: 0 });
  // update while disabled: no health window to wait out
  assert.equal(slice.mutate(['mods', 'disable', ID]).op?.outcome, 'succeeded');
  assert.equal(slice.mutate(['mods', 'update', ID, v2]).op?.outcome, 'succeeded');
  assert.equal(slice.inspect(ID).version, '2.0.0');
  assert.notEqual(settings(), settingsBefore, 'the data was migrated');
  // a code-only rollback across a schema change is refused
  const refused = slice.cli(['mods', 'rollback', ID, '1.0.0'], { json: false });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /schema/);
  // with data restore it works
  const r = slice.mutate(['mods', 'rollback', ID, '1.0.0', '--restore-data']);
  assert.equal(r.op?.outcome, 'succeeded', `${r.stdout}${r.stderr}`);
  assert.equal(slice.inspect(ID).version, '1.0.0');
  assert.equal(settings(), settingsBefore);
  assert.equal(JSON.parse(readFileSync(slice.layout.state, 'utf8')).mods[ID].dataSchemaVersion, 1);
  assert.equal(slice.mutate(['mods', 'enable', ID]).op?.outcome, 'succeeded');
  assert.equal(await live(), '1.0.0');
});
