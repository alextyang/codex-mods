// Integration test 2: the test fixture test.cwd-interceptor (tests/integration/slice-fixtures/mods) through the real Host. thread/start without cwd gets the configured
// destination; with cwd it is untouched; `mods configure` moves the destination for the next thread/start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_MODS, makeKey, packMod, shortRoot, rmrf, startSlice } from './slice-fixtures/kit.mjs';

const MOD_ID = 'test.cwd-interceptor';

test('projectless: install, approve, enable; cwd filled in only when absent; configure moves it', async (t) => {
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const pkg = packMod(join(FIXTURE_MODS, MOD_ID), key.keyFile, join(work, 'pw.codexmod'));

  const inst = slice.mutate(['mods', 'install', pkg.file]);
  assert.equal(inst.op.awaiting, 'consent', inst.stderr);
  assert.equal(slice.inspect(MOD_ID).status, 'pending-consent');
  const cons = slice.mutate(['mods', 'consent', MOD_ID, '--approve', '--enable']);
  assert.equal(cons.op.outcome, 'succeeded', cons.stderr);
  const detail = slice.inspect(MOD_ID);
  assert.equal(detail.status, 'enabled');
  assert.equal(detail.hasSettings, true);
  assert.deepEqual(detail.settings, { destination: 'developer-codex' }, 'the schema default is the current setting');

  const app = slice.app();
  await app.handshake();

  // no cwd -> the configured (default) destination; the backend sees it and the reply carries it back to the app
  const home = homedir();
  const noCwd = await app.request('thread/start', {});
  assert.equal(slice.threadStarts().at(-1).params.cwd, join(home, 'Developer', 'Codex'));
  assert.equal(noCwd.result.thread.cwd, join(home, 'Developer', 'Codex'));
  // an explicit null cwd is also "projectless"
  const nullCwd = await app.request('thread/start', { cwd: null });
  assert.equal(nullCwd.result.thread.cwd, join(home, 'Developer', 'Codex'));
  // with cwd: untouched (and so are the other params, byte for byte as JSON)
  const withCwd = await app.request('thread/start', { cwd: '/tmp/my-project', model: 'm' });
  assert.equal(withCwd.result.thread.cwd, '/tmp/my-project');
  assert.deepEqual(slice.threadStarts().at(-1).params, { cwd: '/tmp/my-project', model: 'm' });
  // other methods are not intercepted
  await app.request('thread/list', {});
  assert.deepEqual(slice.backendReceived().map((x) => x.msg).filter((m) => m?.method === 'thread/list').at(-1).params, {});

  // configure: the next thread/start uses the new destination
  const cfg = slice.mutate(['mods', 'configure', MOD_ID, '--set', 'destination=documents-codex']);
  assert.equal(cfg.op.outcome, 'succeeded', cfg.stderr);
  assert.deepEqual(slice.inspect(MOD_ID).settings, { destination: 'documents-codex' });
  const moved = await app.request('thread/start', {});
  assert.equal(moved.result.thread.cwd, join(home, 'Documents', 'Codex'));

  // an invalid value is refused up front and changes nothing
  const bad = slice.cli(['mods', 'configure', MOD_ID, '--set', 'destination=/etc'], { json: false });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(slice.inspect(MOD_ID).settings, { destination: 'documents-codex' });

  // disabled: back to untouched
  assert.equal(slice.mutate(['mods', 'disable', MOD_ID]).op.outcome, 'succeeded');
  const off = await app.request('thread/start', {});
  assert.equal(slice.threadStarts().at(-1).params.cwd, undefined, 'the request reaches the backend without a cwd');
  assert.notEqual(off.result.thread.cwd, join(home, 'Documents', 'Codex'), 'the backend chose its own default');
});

test('projectless: the setting survives a Host restart and the mod comes back enabled', async (t) => {
  const work = shortRoot('cms-w');
  let slice = await startSlice();
  const root = slice.root;
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const pkg = packMod(join(FIXTURE_MODS, MOD_ID), key.keyFile, join(work, 'pw.codexmod'));
  slice.mutate(['mods', 'install', pkg.file]);
  slice.mutate(['mods', 'consent', MOD_ID, '--approve', '--enable']);
  assert.equal(slice.mutate(['mods', 'configure', MOD_ID, '--set', 'destination=home-codex']).op.outcome, 'succeeded');
  await slice.stop({ keepRoot: true });

  slice = await startSlice({ root });
  assert.equal(slice.inspect(MOD_ID).status, 'enabled');
  const app = slice.app();
  await app.handshake();
  const r = await app.request('thread/start', {});
  assert.equal(r.result.thread.cwd, join(homedir(), 'Codex'));
});
