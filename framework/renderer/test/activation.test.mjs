import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './harness.mjs';

const never = () => new Promise(() => {});

test('a renderer(ctx) that never settles times out after 10 s: scope disposed, fault activation-timeout, other mods load, a disable still applies', async () => {
  const t = await setup();
  let hungCtx; const log = [];
  t.modulesByUrl.set('codexmod://hung/1/r.mjs', { default: { renderer(ctx) { hungCtx = ctx; return never(); } } });
  t.modulesByUrl.set('codexmod://good/1/r.mjs', { default: { renderer() { log.push('good loaded'); return () => log.push('good disposed'); } } });
  const list = [{ modId: 'hung', url: 'codexmod://hung/1/r.mjs' }, { modId: 'good', url: 'codexmod://good/1/r.mjs' }];
  const first = t.send(t.modulesMsg(list));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, [], 'good waits behind the pending activation, but only until the deadline');
  t.win.clock.tick(9_900); await new Promise((r) => setImmediate(r));
  assert.equal(t.fromRuntime('fault').length, 0);
  t.win.clock.tick(200); await first;
  await t.settle();
  const faults = t.fromRuntime('fault');
  assert.equal(faults.length, 1);
  assert.equal(faults[0].modId, 'hung');
  assert.equal(faults[0].message, 'activation-timeout');
  assert.deepEqual(log, ['good loaded']);
  assert.throws(() => hungCtx.ui.status({ id: 's', place: 'titleBar', text: 'x' }), { code: 'Disposed' }, 'the hung mod\'s scope was disposed');
  // disable good while hung stays failed: the unload message is processed
  await t.send(t.modulesMsg([list[0]]));
  assert.deepEqual(log, ['good loaded', 'good disposed']);
  assert.equal(t.fromRuntime('fault').length, 1, 'the hung url is not retried');
});

test('late completion of a timed-out activation is ignored (its disposer still runs, nothing mounts)', async () => {
  const t = await setup();
  let release; const log = [];
  t.modulesByUrl.set('codexmod://slow/1/r.mjs', { default: { renderer() { return new Promise((r) => { release = () => r(() => log.push('late disposer')); }); } } });
  const p = t.send(t.modulesMsg([{ modId: 'slow', url: 'codexmod://slow/1/r.mjs' }]));
  await new Promise((r) => setImmediate(r));
  t.win.clock.tick(10_001); await p;
  release(); await t.settle();
  assert.deepEqual(log, ['late disposer']);
  assert.equal(t.core.parts.loader.isLoaded('slow'), false);
  assert.equal(t.fromRuntime('fault').length, 1);
});

test('an import that never resolves is bounded by the same deadline', async () => {
  const t = await setup({ importModule: () => never() });
  const p = t.send(t.modulesMsg([{ modId: 'stuck', url: 'codexmod://stuck/1/r.mjs' }]));
  await new Promise((r) => setImmediate(r));
  t.win.clock.tick(10_001); await p;
  assert.equal(t.fromRuntime('fault')[0].message, 'activation-timeout');
});

test('close() does not wait for an unsettled activation', async () => {
  const t = await setup();
  let disposed = 0;
  t.modulesByUrl.set('codexmod://hung/1/r.mjs', { default: { renderer() { return never(); } } });
  t.modulesByUrl.set('codexmod://ok/1/r.mjs', { default: { renderer() { return () => { disposed++; }; } } });
  t.send(t.modulesMsg([{ modId: 'ok', url: 'codexmod://ok/1/r.mjs' }, { modId: 'hung', url: 'codexmod://hung/1/r.mjs' }]));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const closed = await Promise.race([t.core.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('blocked'), 500))]);
  assert.equal(closed, 'closed');
  assert.equal(disposed, 1);
});

const tick = () => new Promise((r) => setImmediate(r));

test('N5: [hung, next] + close(): next never activates after close, even after the hung deadline passes', async () => {
  const t = await setup();
  const log = [];
  t.modulesByUrl.set('codexmod://hung/1/r.mjs', { default: { renderer() { return never(); } } });
  t.modulesByUrl.set('codexmod://next/1/r.mjs', { default: { renderer() { log.push('next activated'); } } });
  t.send(t.modulesMsg([{ modId: 'hung', url: 'codexmod://hung/1/r.mjs' }, { modId: 'next', url: 'codexmod://next/1/r.mjs' }]));
  await tick(); await tick();
  await t.core.close();
  t.win.clock.tick(20_000); await tick(); await tick();
  assert.deepEqual(log, []);
  assert.equal(t.core.parts.loader.loadedIds().length, 0);
  assert.equal(t.fromRuntime('fault').length, 0, 'closing is not a fault');
});

test('N5: an import that resolves after the deadline never calls renderer() and never creates a context or scope', async () => {
  let release; const calls = []; let forModCalls = 0;
  const t = await setup({ importModule: () => new Promise((r) => { release = () => r({ default: { renderer() { calls.push('renderer'); } } }); }) });
  const origForMod = t.core.parts.uiFactory.forMod;
  t.core.parts.uiFactory.forMod = (id) => { forModCalls++; return origForMod(id); };
  const realms = t.realmContexts.length;
  const p = t.send(t.modulesMsg([{ modId: 'late', url: 'codexmod://late/1/r.mjs' }]));
  await tick();
  t.win.clock.tick(10_100); await p;
  assert.equal(t.fromRuntime('fault')[0].message, 'activation-timeout');
  release(); await tick(); await tick(); await t.settle();
  assert.deepEqual(calls, []);
  assert.equal(forModCalls, 0);
  assert.equal(t.realmContexts.length, realms);
});

test('N5: unloading a mod whose import is still pending cancels that activation (no renderer call after the import lands)', async () => {
  let release; const calls = [];
  const t = await setup({ importModule: () => new Promise((r) => { release = () => r({ default: { renderer() { calls.push('renderer'); } } }); }) });
  t.send(t.modulesMsg([{ modId: 'm', url: 'codexmod://m/1/r.mjs' }]));
  await tick();
  await t.core.close();
  release(); await tick(); await tick();
  assert.deepEqual(calls, []);
});

test('F8: a failing import is retried at 250/500/1000 ms and a late-appearing module then loads without any fault', async () => {
  let attempts = 0; const stamps = [];
  const t = await setup({ importModule: async (url) => { attempts++; stamps.push(t.win.clock.now); if (attempts <= 3) throw new Error('Failed to fetch dynamically imported module: ' + url); return { default: { renderer() {} } }; } });
  t.host.postMessage(t.modulesMsg([{ modId: 'starter', url: 'codexmod://starter/rev/renderer.mjs' }]));
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(attempts, 1);
  t.win.clock.tick(249); await tick(); await tick(); assert.equal(attempts, 1);
  t.win.clock.tick(1); for (let i = 0; i < 4; i++) await tick(); assert.equal(attempts, 2);
  t.win.clock.tick(500); for (let i = 0; i < 4; i++) await tick(); assert.equal(attempts, 3);
  t.win.clock.tick(1000); for (let i = 0; i < 6; i++) await tick();
  assert.equal(attempts, 4);
  assert.equal(t.fromRuntime('fault').length, 0);
  assert.deepEqual(t.core.parts.loader.loadedIds(), ['starter']);
  assert.deepEqual(stamps.slice(1).map((s, i) => s - stamps[i]), [250, 500, 1000]);
});

test('F8: after the three retries a persistent import failure is one fault with the import error', async () => {
  let attempts = 0;
  const t = await setup({ importModule: async () => { attempts++; throw new Error('Failed to fetch dynamically imported module'); } });
  t.host.postMessage(t.modulesMsg([{ modId: 'gone', url: 'codexmod://gone/1/r.mjs' }]));
  for (const ms of [0, 250, 500, 1000]) { t.win.clock.tick(ms); for (let i = 0; i < 5; i++) await tick(); }
  assert.equal(attempts, 4);
  const f = t.fromRuntime('fault');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /Failed to fetch dynamically imported module/);
});

test('F8: renderer() errors are NOT retried, and closing during a retry wait stops the retries', async () => {
  let calls = 0;
  const t = await setup({ importModule: async () => ({ default: { renderer() { calls++; throw new Error('activation boom'); } } }) });
  await t.send(t.modulesMsg([{ modId: 'a', url: 'codexmod://a/1/r.mjs' }]));
  assert.equal(calls, 1);
  let imports = 0;
  const u = await setup({ importModule: async () => { imports++; throw new Error('nope'); } });
  u.host.postMessage(u.modulesMsg([{ modId: 'b', url: 'codexmod://b/1/r.mjs' }]));
  for (let i = 0; i < 6; i++) await tick();
  await u.core.close();
  u.win.clock.tick(5000); for (let i = 0; i < 6; i++) await tick();
  assert.equal(imports, 1);
});

test('F8: every retry imports a distinct URL (?attempt=n); the first attempt is the plain URL; query-bearing URLs get &attempt=n', async () => {
  const urls = [];
  const t = await setup({ importModule: async (url) => { urls.push(url); if (urls.length <= 3) throw new Error('Failed to fetch dynamically imported module'); return { default: { renderer() {} } }; } });
  t.host.postMessage(t.modulesMsg([{ modId: 'starter', url: 'codexmod://starter/rev-1/renderer.mjs' }]));
  for (const ms of [0, 250, 500, 1000]) { t.win.clock.tick(ms); for (let i = 0; i < 6; i++) await tick(); }
  assert.deepEqual(urls, ['codexmod://starter/rev-1/renderer.mjs', 'codexmod://starter/rev-1/renderer.mjs?attempt=1', 'codexmod://starter/rev-1/renderer.mjs?attempt=2', 'codexmod://starter/rev-1/renderer.mjs?attempt=3']);
  assert.equal(new Set(urls).size, 4, 'a failed dynamic import is cached per exact URL, so no URL may repeat');
  assert.equal(t.fromRuntime('fault').length, 0);

  const q = [];
  const u = await setup({ importModule: async (url) => { q.push(url); throw new Error('nope'); } });
  u.host.postMessage(u.modulesMsg([{ modId: 'm', url: 'codexmod://m/r/e.mjs?x=1' }]));
  for (const ms of [0, 250, 500, 1000]) { u.win.clock.tick(ms); for (let i = 0; i < 6; i++) await tick(); }
  assert.deepEqual(q.slice(0, 2), ['codexmod://m/r/e.mjs?x=1', 'codexmod://m/r/e.mjs?x=1&attempt=1']);
});

test('F8: framework-main\'s codexmod:// handler maps the path only, so ?attempt=n resolves to the same file', async () => {
  const { createRequire } = await import('node:module');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createCodexmodResolver } = createRequire(import.meta.url)('../../main/codexmod-protocol.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'cm-proto-'));
  try {
    writeFileSync(join(dir, 'renderer.mjs'), 'export default {}');
    const r = createCodexmodResolver(); r.setModules([{ modId: 'starter', packageDir: dir, rev: 'rev-1' }]);
    const plain = r.resolve('codexmod://starter/rev-1/renderer.mjs');
    const retry = r.resolve('codexmod://starter/rev-1/renderer.mjs?attempt=2');
    assert.equal(plain.status, 200);
    assert.deepEqual(retry, plain);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
