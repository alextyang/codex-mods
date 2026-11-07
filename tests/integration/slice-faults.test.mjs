// Integration test 4: fault isolation, headless (G7). A mod whose host throws three times is quarantined while a
// second mod keeps answering; a mod whose host hangs is terminated and quarantined by the heartbeat timeout while the app connection
// keeps working. Test mods are developer-mode packages (unsigned directories) installed through the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TIMING } from '../../framework/host/runtime/index.mjs';
import { FIXTURE_MODS, makeKey, packMod, shortRoot, rmrf, startSlice, writeModDir, waitFor } from './slice-fixtures/kit.mjs';

const BC = 'test.compaction-interceptor';   // the healthy fixture mod (tests/integration/slice-fixtures/mods)
const manifest = (id, permissions = [], extra = {}) => ({ id, version: '1.0.0', name: id, framework: '>=1 <2', entry: { host: 'host.mjs' }, permissions, ...extra });

const THROWING_INTERCEPTOR = `
export default { async host(ctx) {
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => { throw new Error('boom from the interceptor'); }, { timeoutMs: 500, onError: 'pass' });
} };`;
// The host entry itself throws (outside any request): three uncaught errors after activation.
const THROWING_ENTRY = `
export default { async host(ctx) {
  for (let i = 0; i < 3; i++) setTimeout(() => { throw new Error('async boom ' + i); }, 200 + i * 150);
} };`;
// Registers an interceptor and then blocks the whole worker thread forever when a thread/start arrives.
const HANGING_INTERCEPTOR = `
export default { async host(ctx) {
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => { for (;;) {} }, { timeoutMs: 500, onError: 'pass' });
} };`;
// Hangs while activating.
const HANGING_ACTIVATION = `export default { async host(ctx) { for (;;) {} } };`;

async function setup(t) {
  const work = shortRoot('cms-w');
  const slice = await startSlice();
  // Every slice of the test, stopped last first: a later slice may run on an earlier one's root, which goes only once nothing writes to it.
  const slices = [slice];
  t.after(async () => { for (const s of slices.reverse()) await s.stop(); rmrf(work); });
  const key = makeKey(work);
  const bc = packMod(join(FIXTURE_MODS, BC), key.keyFile, join(work, 'bc.codexmod')).file;
  const { COMPACT_PROMPT } = await import(pathToFileURL(join(FIXTURE_MODS, BC, 'host.mjs')).href);
  const devMod = (id, hostSrc, permissions) => {
    const dir = writeModDir(join(work, id), manifest(id, permissions), { 'host.mjs': hostSrc });
    return dir;
  };
  const installDev = (dir, id) => {
    const i = slice.mutate(['mods', 'install', dir, '--dev']);
    assert.equal(i.op?.awaiting, 'consent', `${i.stdout}${i.stderr}`);
    return slice.mutate(['mods', 'consent', id, '--approve', '--enable']);
  };
  const installBc = () => {
    assert.equal(slice.mutate(['mods', 'install', bc]).op?.awaiting, 'consent');
    const c = slice.mutate(['mods', 'consent', BC, '--approve', '--enable']);
    assert.equal(c.op?.outcome, 'succeeded', c.stderr);
  };
  return { slice, slices, work, devMod, installDev, installBc, COMPACT_PROMPT };
}

test('a mod whose interceptor throws three times is quarantined; a second mod keeps answering', async (t) => {
  const { slice, devMod, installDev, installBc, COMPACT_PROMPT } = await setup(t);
  const id = 'test.thrower';
  installBc();
  const c = installDev(devMod(id, THROWING_INTERCEPTOR, ['appServer.intercept:thread/start']), id);
  assert.equal(c.op?.outcome, 'succeeded', `${c.stdout}${c.stderr}`);
  assert.equal(slice.inspect(id).status, 'enabled');

  const app = slice.app();
  await app.handshake();
  for (let i = 0; i < 3; i++) {
    const r = await app.request('thread/start', { config: {} });
    assert.ok(r.result?.thread?.id, `request ${i + 1} is answered despite the faulting mod (fail-open)`);
    assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT, `the healthy mod still applies on request ${i + 1}`);
  }
  await waitFor('the thrower to be quarantined', () => slice.inspect(id).status === 'quarantined');
  const q = slice.inspect(id);
  assert.match(q.quarantine.reason, /fault/);
  // the status shows the quarantine as it happens; its journal entry is written after it (under load, a moment later)
  await waitFor('the quarantine to be journaled', () => slice.cli(['ops', 'list', '--mod', id]).json.ops.some((o) => /Quarantined/.test(o.note ?? '')));

  // the survivor and the app connection are fine afterwards
  const r4 = await app.request('thread/start', { config: {} });
  assert.ok(r4.result.thread.id);
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT);
  assert.equal(slice.inspect(BC).status, 'enabled');
  assert.equal(app.child.exitCode, null);

  // clearing the quarantine returns the mod to disabled (the user decides whether to enable it again)
  const clr = slice.mutate(['mods', 'clear-quarantine', id]);
  assert.equal(clr.op?.outcome, 'succeeded', clr.stderr);
  assert.equal(slice.inspect(id).status, 'disabled');
  assert.equal(slice.inspect(id).quarantine, null);
});

test('a mod whose host entry throws three times outside any request is quarantined', async (t) => {
  const { slice, devMod, installDev, installBc, COMPACT_PROMPT } = await setup(t);
  const id = 'test.entry-thrower';
  installBc();
  const c = installDev(devMod(id, THROWING_ENTRY, []), id);
  assert.equal(c.op?.outcome, 'succeeded', `${c.stdout}${c.stderr}`);
  await waitFor('the entry-thrower to be quarantined', () => slice.inspect(id).status === 'quarantined', 8000);
  const app = slice.app();
  await app.handshake();
  const r = await app.request('thread/start', { config: {} });
  assert.ok(r.result.thread.id);
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT, 'the second mod keeps answering');
  assert.equal(slice.inspect(BC).status, 'enabled');
});

test('a mod whose host hangs is terminated and quarantined (heartbeat timeout plus slack); the app connection keeps working', async (t) => {
  const { slice, devMod, installDev, installBc, COMPACT_PROMPT } = await setup(t);
  const id = 'test.hanger';
  installBc();
  const c = installDev(devMod(id, HANGING_INTERCEPTOR, ['appServer.intercept:thread/start']), id);
  assert.equal(c.op?.outcome, 'succeeded', `${c.stdout}${c.stderr}`);

  const app = slice.app();
  await app.handshake();
  // Detection takes about heartbeatTimeoutMs (+ one heartbeat period) on an idle machine; the bound adds generous slack so a heavily
  // loaded machine (load average ~16 has been seen) does not flake. What matters is that it happens and the app never stalls.
  const BOUND_MS = TIMING.heartbeatTimeoutMs + TIMING.heartbeatMs + 15_000;
  const t0 = Date.now();
  // The first thread/start reaches the hanging interceptor: the mux deadline (500 ms) lets the request through (onError: pass).
  const first = await app.request('thread/start', { config: {} }, 5000);
  assert.ok(first.result.thread.id, 'the request is answered although the interceptor never returns');
  assert.ok(Date.now() - t0 < 8000, `answered via the interceptor deadline, not stuck (${Date.now() - t0} ms)`);
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT, 'the other mod still applied');
  // The app keeps working while the hang is being detected.
  const second = await app.request('thread/list', {}, 3000);
  assert.ok(Array.isArray(second.result.data));
  assert.equal(slice.cli(['mods', 'list']).status, 0, 'the Host answers management while the worker is hung');

  await waitFor('the hanger to be quarantined', () => slice.inspect(id).status === 'quarantined', BOUND_MS, 200);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= BOUND_MS, `quarantined ${elapsed} ms after the hang (bound ${BOUND_MS} ms)`);
  assert.match(slice.inspect(id).quarantine.reason, /unresponsive/);
  const after = await app.request('thread/start', { config: {} }, 3000);
  assert.ok(after.result.thread.id);
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT);
  assert.equal(slice.inspect(BC).status, 'enabled');
  assert.equal(app.child.exitCode, null, 'the app connection is still up');
});

test('a mod whose host hangs while starting is stopped within the activation limit and left disabled', async (t) => {
  const { slice, devMod, installBc, COMPACT_PROMPT } = await setup(t);
  const id = 'test.activation-hanger';
  installBc();
  const dir = devMod(id, HANGING_ACTIVATION, []);
  assert.equal(slice.mutate(['mods', 'install', dir, '--dev']).op?.awaiting, 'consent');
  const t0 = Date.now();
  const r = slice.mutate(['mods', 'consent', id, '--approve', '--enable']);
  const took = Date.now() - t0;
  assert.ok(['failed', 'needs-attention'].includes(r.op?.outcome), `${r.stdout}${r.stderr}`);
  assert.ok(took < 15_000, `gave up after ${took} ms`);
  assert.equal(slice.inspect(id).status, 'disabled');
  const app = slice.app();
  await app.handshake();
  await app.request('thread/start', { config: {} });
  assert.equal(slice.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT);
});

test('a quarantined mod stays quarantined across a Host restart; the survivor still runs', async (t) => {
  const { slice: first, slices, devMod, installDev, installBc, COMPACT_PROMPT } = await setup(t);
  const id = 'test.thrower';
  installBc();
  assert.equal(installDev(devMod(id, THROWING_INTERCEPTOR, ['appServer.intercept:thread/start']), id).op?.outcome, 'succeeded');
  const app = first.app();
  await app.handshake();
  for (let i = 0; i < 3; i++) await app.request('thread/start', {});
  await waitFor('quarantine', () => first.inspect(id).status === 'quarantined');
  // what a restart reads is the record on disk: the status is in memory a moment before it is written (under load, a stop could come between)
  await waitFor('quarantine written', () => { try { return JSON.parse(readFileSync(first.layout.state, 'utf8')).mods[id]?.status === 'quarantined'; } catch { return false; } });
  const root = first.root;
  await first.stop({ keepRoot: true });

  const second = await startSlice({ root });
  slices.push(second);
  assert.equal(second.inspect(id).status, 'quarantined');
  assert.equal(second.inspect(BC).status, 'enabled');
  const app2 = second.app();
  await app2.handshake();
  await app2.request('thread/start', { config: {} });
  assert.equal(second.threadStarts().at(-1).params.config.compact_prompt, COMPACT_PROMPT);
});

test('every app session sees the mods: two simultaneous connections both get the compaction prompt', async (t) => {
  const { slice, installBc, COMPACT_PROMPT } = await setup(t);
  installBc();
  const a = slice.app(), b = slice.app();
  await Promise.all([a.handshake(), b.handshake()]);
  await Promise.all([a.request('thread/start', { config: {} }), b.request('thread/start', { config: {} })]);
  const starts = slice.threadStarts();
  assert.equal(starts.length, 2);
  for (const s of starts) assert.equal(s.params.config.compact_prompt, COMPACT_PROMPT);
});
