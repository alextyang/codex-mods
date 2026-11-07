// Integration test 1: the M1.5 slice, headless. keygen -> pack -> install -> consent -> relay -> thread/start carries
// config.compact_prompt -> disable. Real Host, mux, runtime, ops, management, CLI and relay; the backend is the fake app-server.
//
// The mod is the test fixture test.compaction-interceptor (tests/integration/slice-fixtures/mods).
// Its `prompt` setting (default: the fixture's built-in prompt) is changed with `mods configure`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_MODS, makeKey, packMod, shortRoot, rmrf, startSlice } from './slice-fixtures/kit.mjs';

const MOD_ID = 'test.compaction-interceptor';

test('slice: keygen, pack, install, consent, relay, thread/start, disable', async (t) => {
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  t.after(async () => { await slice.stop(); rmrf(work); });
  const { COMPACT_PROMPT } = await import(pathToFileURL(join(FIXTURE_MODS, MOD_ID, 'host.mjs')).href);
  assert.ok(COMPACT_PROMPT.length > 100);

  // 1. keygen and pack through the real CLI
  const key = makeKey(work);
  assert.match(key.publicKey, /^[A-Za-z0-9+/=]{44}$/);
  const pkg = packMod(join(FIXTURE_MODS, MOD_ID), key.keyFile, join(work, 'bc.codexmod'));
  assert.ok(pkg.file.endsWith('.codexmod'));

  // 2. install: the op ends waiting for consent, the mod is pending-consent and inactive
  const inst = slice.mutate(['mods', 'install', pkg.file]);
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(inst.op.input.type, 'install');
  assert.equal(inst.op.outcome, 'succeeded');
  assert.equal(inst.op.awaiting, 'consent');
  const pending = slice.inspect(MOD_ID);
  assert.equal(pending.status, 'pending-consent');
  assert.equal(pending.publisherFingerprint, key.fingerprint);
  assert.ok(pending.permissionText.some((p) => /thread\/start/.test(p.text)), 'consent text names the intercepted methods');
  const app0 = slice.app();
  await app0.handshake();
  const r0 = await app0.request('thread/start', { config: {} });
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, undefined, 'a pending-consent mod does nothing');
  assert.ok(r0.result.thread.id);
  app0.kill();

  // 3. consent --approve --enable
  const cons = slice.mutate(['mods', 'consent', MOD_ID, '--approve', '--enable']);
  assert.equal(cons.status, 0, cons.stderr);
  assert.equal(cons.op.outcome, 'succeeded');
  const active = slice.inspect(MOD_ID);
  assert.equal(active.status, 'enabled');
  assert.deepEqual(active.grants, ['appServer.intercept:thread/start,thread/resume,thread/fork']);

  // 4/5. the app, through the real relay
  const app = slice.app();
  const init = await app.handshake();
  assert.equal(init.result.userAgent, 'fake/primary');
  const started = await app.request('thread/start', { config: {} });
  assert.ok(started.result.thread.id, 'the reply reaches the app');
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT, 'the backend received the mod\'s prompt');

  // other config overrides the app sent are preserved
  await app.request('thread/start', { config: { model: 'x' }, cwd: '/tmp/keep' });
  const merged = slice.threadStarts().at(-1).params;
  assert.deepEqual({ model: merged.config.model, cwd: merged.cwd, p: merged.config.compact_prompt }, { model: 'x', cwd: '/tmp/keep', p: COMPACT_PROMPT });

  // thread/resume and thread/fork carry it too (the mod's other two methods)
  await app.request('thread/resume', { threadId: 'thr-primary-1' });
  await app.request('thread/fork', { threadId: 'thr-primary-1' });
  const seen = slice.backendReceived().map((x) => x.msg).filter((m) => m?.method === 'thread/resume' || m?.method === 'thread/fork');
  assert.equal(seen.length, 2);
  for (const m of seen) assert.equal(m.params.config.compact_prompt, COMPACT_PROMPT, m.method);
  // a method the mod did not ask for is untouched
  await app.request('thread/list', {});
  assert.deepEqual(slice.backendReceived().map((x) => x.msg).filter((m) => m?.method === 'thread/list').at(-1).params, {});

  // 7. disable: the next thread/start carries no compact_prompt and the app connection still works
  const dis = slice.mutate(['mods', 'disable', MOD_ID]);
  assert.equal(dis.op.outcome, 'succeeded', dis.stderr);
  assert.equal(slice.inspect(MOD_ID).status, 'disabled');
  const after = await app.request('thread/start', { config: {} });
  assert.ok(after.result.thread.id, 'the app connection is still working');
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, undefined, 'no compact_prompt once disabled');
  assert.equal(app.child.exitCode, null, 'the relay (and so the app connection) is still alive');

  // re-enable restores it
  const en = slice.mutate(['mods', 'enable', MOD_ID]);
  assert.equal(en.op.outcome, 'succeeded', en.stderr);
  await app.request('thread/start', { config: {} });
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT);
});

test('slice: mods configure with a new prompt changes the next thread/start, and an invalid prompt is refused', async (t) => {
  const { COMPACT_PROMPT } = await import(pathToFileURL(join(FIXTURE_MODS, MOD_ID, 'host.mjs')).href);
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  t.after(async () => { await slice.stop(); rmrf(work); });
  const key = makeKey(work);
  const pkg = packMod(join(FIXTURE_MODS, MOD_ID), key.keyFile, join(work, 'bc.codexmod'));
  slice.mutate(['mods', 'install', pkg.file]);
  const c = slice.mutate(['mods', 'consent', MOD_ID, '--approve', '--enable']);
  assert.equal(c.op.outcome, 'succeeded', c.stderr);
  const app = slice.app();
  await app.handshake();
  await app.request('thread/start', { config: {} });
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT, 'the default prompt before configuring');

  const cfg = slice.mutate(['mods', 'configure', MOD_ID, '--set', 'prompt=NEW PROMPT']);
  assert.equal(cfg.op?.outcome, 'succeeded', cfg.stderr);
  await app.request('thread/start', { config: { model: 'x' } });
  const p = slice.threadStarts().at(-1).params;
  assert.equal(p.config.compact_prompt, 'NEW PROMPT');
  assert.equal(p.config.model, 'x', 'other overrides are preserved');
  assert.equal(app.child.exitCode, null, 'the app connection stayed up through the configure');

  const bad = slice.cli(['mods', 'configure', MOD_ID, '--set', 'prompt=5'], { json: false });
  assert.notEqual(bad.status, 0, 'a prompt is text');
  await app.request('thread/start', { config: {} });
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, 'NEW PROMPT', 'a refused configure changes nothing');
});
