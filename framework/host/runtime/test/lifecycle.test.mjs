import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexModsError } from '../../../../sdk/errors.mjs';
import { TIMING } from '../index.mjs';
import { makeHarness, installMod, waitFor, sleep } from './helpers.mjs';

test('activate runs host(ctx) in a worker with the 256 MB limit; deactivate runs disposers and is idempotent', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.life', host: `
      export default { async host(ctx) {
        await ctx.storage.set('started', true);
        ctx.events.on('mod/test.life/ping', () => {});
        return async () => { await ctx.storage.set('disposed', true); };
      } };` });
    assert.equal(h.runtime.status('test.life'), 'inactive');
    const p = h.runtime.activate(mod);
    assert.equal(h.runtime.status('test.life'), 'activating');
    assert.deepEqual(h.runtime.active(), ['test.life']);
    await p;
    assert.equal(h.runtime.status('test.life'), 'active');
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].worker.resourceLimits.maxOldGenerationSizeMb, 256);
    const store = JSON.parse(await readFile(join(mod.dataDir, 'store.json'), 'utf8'));
    assert.deepEqual(store.data, { started: true });
    await h.runtime.activate(mod); // already active: no-op
    assert.equal(h.workers.length, 1);

    await h.runtime.deactivate('test.life', 'test');
    assert.equal(h.runtime.status('test.life'), 'inactive');
    assert.deepEqual(h.runtime.active(), []);
    const after = JSON.parse(await readFile(join(mod.dataDir, 'store.json'), 'utf8'));
    assert.equal(after.data.disposed, true, 'the returned disposer ran in the worker');
    await h.runtime.deactivate('test.life', 'again'); // idempotent
    assert.deepEqual(h.mux.calls.filter((c) => c[0] === 'client.dispose' || c[0] === 'disposeOwner'),
      [['client.dispose', 'mod:test.life'], ['disposeOwner', 'mod:test.life']]);
  } finally { await h.close(); }
});

test('mux client is created per mod with rank and allowedMethods derived from grants', async () => {
  const h = await makeHarness({ rankOf: (id) => (id === 'test.a' ? 7 : 1) });
  try {
    const mod = await installMod(h.layout, {
      id: 'test.a', host: 'export default { host() {} };',
      grants: ['appServer.intercept:thread/compact/start,thread/list', 'appServer.request', 'appServer.observe:thread/', 'appServer.observe:turn/', 'ui'],
    });
    await h.runtime.activate(mod);
    const c = h.mux.clients.get('mod:test.a');
    assert.equal(c.opts.rank, 7);
    assert.deepEqual(c.opts.allowedMethods, {
      intercept: ['thread/compact/start', 'thread/list'], request: '*', observe: ['thread/', 'turn/'], defer: false,
    });
    const bare = await installMod(h.layout, { id: 'test.b', host: 'export default { host() {} };', grants: ['appServer.intercept'] });
    await h.runtime.activate(bare);
    assert.equal(h.mux.clients.get('mod:test.b').opts.allowedMethods.intercept, '*');
    assert.deepEqual(h.mux.clients.get('mod:test.b').opts.allowedMethods.request, []);
  } finally { await h.close(); }
});

test('activation failure: throwing host → CodexModsError with ActivationError details, no effects', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.bad', host: 'export default { host() { throw new Error("nope"); } };' });
    await assert.rejects(h.runtime.activate(mod), (e) => {
      assert.ok(e instanceof CodexModsError);
      assert.equal(e.details.code, e.code);
      assert.match(e.details.message, /nope/);
      assert.equal(e.details.effectsAttempted, false);
      return true;
    });
    assert.equal(h.runtime.status('test.bad'), 'inactive');
    assert.equal(h.workers[0].worker.threadId, -1, 'the worker was terminated');
    assert.deepEqual(h.runtime.active(), []);
    assert.ok(h.mux.clients.get('mod:test.bad').disposed);
  } finally { await h.close(); }
});

test('activation failure: missing host file and syntax error are rejected too', async () => {
  const h = await makeHarness();
  try {
    const syntax = await installMod(h.layout, { id: 'test.syntax', host: 'export default { host( };' });
    await assert.rejects(h.runtime.activate(syntax), (e) => e instanceof CodexModsError && e.details.effectsAttempted === false);
    const missing = await installMod(h.layout, { id: 'test.missing', host: 'export default {};' });
    missing.manifest.entry.host = 'nowhere.mjs';
    await assert.rejects(h.runtime.activate(missing), (e) => e instanceof CodexModsError);
    const escape = await installMod(h.layout, { id: 'test.escape', host: 'export default {};' });
    escape.manifest.entry.host = '../../outside.mjs';
    await assert.rejects(h.runtime.activate(escape), (e) => e.code === 'Invalid');
  } finally { await h.close(); }
});

test('activation that never settles rejects Timeout and terminates the worker', async () => {
  const h = await makeHarness({ internals: { timing: { activationMs: 400 } } });
  try {
    const mod = await installMod(h.layout, { id: 'test.slow', host: 'export default { host() { return new Promise(() => {}); } };' });
    const t0 = Date.now();
    await assert.rejects(h.runtime.activate(mod), (e) => e.code === 'Timeout' && e.details.code === 'Timeout' && e.details.effectsAttempted === false);
    assert.ok(Date.now() - t0 < 400 + 10000, 'rejected near the activation limit, not much later');
    assert.equal(h.workers[0].worker.threadId, -1);
    assert.equal(h.runtime.status('test.slow'), 'inactive');
  } finally { await h.close(); }
});

test('the default activation timeout is 10 s, heartbeat limits are 1 s / 5 s, and a watchdog tick 2 s late is the Host\'s own stall', async () => {
  const { TIMING, WORKER_LIMITS } = await import('../index.mjs');
  assert.equal(TIMING.activationMs, 10000);
  assert.equal(TIMING.heartbeatMs, 1000);
  assert.equal(TIMING.heartbeatTimeoutMs, 5000);
  assert.equal(TIMING.hostStallMs, 2000);
  assert.equal(TIMING.drainMs, 5000);
  assert.equal(WORKER_LIMITS.maxOldGenerationSizeMb, 256);
});

test('effectsAttempted is true when the mod called a service, started a lease, or transmitted before failing', async () => {
  const h = await makeHarness();
  try {
    const svc = await installMod(h.layout, { id: 'test.fx1', host: `
      export default { async host(ctx) { await ctx.services.call('framework', 'nothing', 'x').catch(() => {}); throw new Error('late'); } };` });
    await assert.rejects(h.runtime.activate(svc), (e) => e.details.effectsAttempted === true);

    const lease = await installMod(h.layout, { id: 'test.fx2', grants: ['appServer.clients'], host: `
      export default { async host(ctx) { await ctx.appServer.clients.issue({ name: 'x' }); throw new Error('late'); } };` });
    await assert.rejects(h.runtime.activate(lease), (e) => e.details.effectsAttempted === true);

    const tx = await installMod(h.layout, { id: 'test.fx3', grants: ['appServer.request'], host: `
      export default { async host(ctx) { await ctx.appServer.request('thread/list', {}); throw new Error('late'); } };` });
    await assert.rejects(h.runtime.activate(tx), (e) => e.details.effectsAttempted === true);
    assert.equal(h.mux.clients.get('mod:test.fx3').hasTransmitted, true);

    const denied = await installMod(h.layout, { id: 'test.fx4', host: `
      export default { async host(ctx) { await ctx.appServer.request('thread/list', {}).catch(() => {}); throw new Error('late'); } };` });
    await assert.rejects(h.runtime.activate(denied), (e) => e.details.effectsAttempted === false);
  } finally { await h.close(); }
});

test('a deactivate drain that never completes is terminated after the drain limit', async () => {
  const h = await makeHarness({ internals: { timing: { drainMs: 300 } } });
  try {
    const mod = await installMod(h.layout, { id: 'test.stuck', host: `
      export default { host() { return () => new Promise(() => {}); } };` });
    await h.runtime.activate(mod);
    const t0 = Date.now();
    await h.runtime.deactivate('test.stuck', 'test');
    const ms = Date.now() - t0;
    assert.ok(ms >= 250 && ms < 300 + 10000, `drain took ${ms} ms`);
    assert.equal(h.workers[0].worker.threadId, -1);
    assert.equal(h.runtime.status('test.stuck'), 'inactive');
  } finally { await h.close(); }
});

test('a mod with only a renderer entry gets no worker and is announced; rev changes on every activation', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.ui', renderer: 'export default { renderer() {} };' });
    await h.runtime.activate(mod);
    assert.equal(h.workers.length, 0);
    assert.equal(h.runtime.status('test.ui'), 'active');
    assert.equal(h.announces.length, 1);
    const first = h.announces[0].module;
    assert.deepEqual({ ...first, rev: undefined }, { packageDir: mod.packageDir, entry: 'renderer.mjs', rev: undefined });
    await h.runtime.deactivate('test.ui', 'test');
    assert.equal(h.announces.at(-1).module, null);
    await h.runtime.activate(mod);
    assert.notEqual(h.announces.at(-1).module.rev, first.rev, 'dev reloads must bypass caches');
  } finally { await h.close(); }
});

test('uncaught errors in the worker become faults on framework/fault (and the mod stays active below the limit)', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.f1', host: `
      export default { host() { setTimeout(() => { throw new Error('async boom'); }, 20); } };` });
    await h.runtime.activate(mod);
    await waitFor(() => h.topic('framework/fault').length >= 1, { what: 'fault' });
    const f = h.topic('framework/fault')[0];
    assert.equal(f.modId, 'test.f1'); assert.equal(f.realm, 'host'); assert.match(f.message, /async boom/);
    assert.equal(h.runtime.status('test.f1'), 'active');
    assert.deepEqual(h.quarantines, []);
  } finally { await h.close(); }
});

test('a throwing mod is quarantined after three faults (onQuarantine + framework/quarantine, once)', async () => {
  const h = await makeHarness();
  try {
    const seen = [];
    h.runtime.onFault((e) => seen.push(e));
    const mod = await installMod(h.layout, { id: 'test.thrower', host: `
      export default { host() { let n = 0; const t = setInterval(() => { if (++n > 6) clearInterval(t); throw new Error('boom ' + n); }, 30); } };` });
    await h.runtime.activate(mod);
    await waitFor(() => h.quarantines.length >= 1, { what: 'quarantine' });
    await sleep(300);
    assert.deepEqual(h.quarantines, [{ modId: 'test.thrower', reason: 'faults' }]);
    assert.deepEqual(h.topic('framework/quarantine'), [{ modId: 'test.thrower', reason: 'faults' }]);
    assert.ok(h.topic('framework/fault').length >= 3);
    assert.ok(seen.length >= 3);
  } finally { await h.close(); }
});

test('faults from mux.onFault (clientId mod:<id>) count toward quarantine and are published as realm "mux"', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.mf', host: 'export default { host() {} };' });
    await h.runtime.activate(mod);
    for (let i = 0; i < 3; i++) h.mux.emitFault({ clientId: 'mod:test.mf', kind: 'timeout', message: `slow ${i}` });
    h.mux.emitFault({ clientId: 'client:lease-1', kind: 'throw', message: 'ignored' });
    assert.deepEqual(h.quarantines, [{ modId: 'test.mf', reason: 'faults' }]);
    await sleep(20);
    const faults = h.topic('framework/fault');
    assert.equal(faults.length, 3);
    assert.ok(faults.every((f) => f.realm === 'mux' && f.kind === 'timeout' && f.modId === 'test.mf'));
  } finally { await h.close(); }
});

test('faults older than 10 minutes do not count', async () => {
  const h = await makeHarness({ internals: { timing: { faultWindowMs: 150 } } });
  try {
    const mod = await installMod(h.layout, { id: 'test.old', host: 'export default { host() {} };' });
    await h.runtime.activate(mod);
    h.mux.emitFault({ clientId: 'mod:test.old', kind: 'throw', message: 'a' });
    h.mux.emitFault({ clientId: 'mod:test.old', kind: 'throw', message: 'b' });
    await sleep(250);
    h.mux.emitFault({ clientId: 'mod:test.old', kind: 'throw', message: 'c' });
    assert.deepEqual(h.quarantines, []);
  } finally { await h.close(); }
});

test('hung mod: terminated after missing heartbeats and quarantined, while a second mod keeps answering service calls', async () => {
  const h = await makeHarness(); // real timings: heartbeat 1 s, limit 5 s
  try {
    const hung = await installMod(h.layout, { id: 'test.hung', host: `
      export default { async host(ctx) {
        ctx.services.provide('s', { ping: () => 'hung-pong' });
        setTimeout(() => { for (;;) {} }, 200);
      } };` });
    const good = await installMod(h.layout, { id: 'test.good', host: `
      export default { host(ctx) { ctx.services.provide('s', { ping: (a) => ({ pong: a }) }); } };` });
    await h.runtime.activate(good);
    await h.runtime.activate(hung);
    const t0 = Date.now();
    let answers = 0;
    while (h.quarantines.length === 0) {
      assert.deepEqual(await h.runtime.callServiceForLease('mod:test.good', { name: 's', method: 'ping', args: answers }), { pong: answers });
      answers++;
      await sleep(250);
      assert.ok(Date.now() - t0 < TIMING.heartbeatTimeoutMs + 30000, 'hung mod was not terminated');
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= TIMING.heartbeatTimeoutMs - 1500 && elapsed <= TIMING.heartbeatTimeoutMs + 30000, `terminated after ${elapsed} ms`);
    assert.deepEqual(h.quarantines, [{ modId: 'test.hung', reason: 'unresponsive' }]);
    assert.equal(h.workers.find((w) => w.modId === 'test.hung').worker.threadId, -1);
    assert.equal(h.runtime.status('test.hung'), 'inactive');
    assert.equal(h.runtime.status('test.good'), 'active');
    await assert.rejects(h.runtime.callServiceForLease('mod:test.hung', { name: 's', method: 'ping', args: null }), { code: 'Unavailable' });
    assert.deepEqual(await h.runtime.callServiceForLease('mod:test.good', { name: 's', method: 'ping', args: 'after' }), { pong: 'after' });
    assert.ok(answers >= 10, `second mod kept answering (${answers} answers)`);
  } finally { await h.close(); }
});

/**
 * Block the Host's own event loop, as a long synchronous job inside it would. It runs outside the timers phase (as the census did, in
 * an I/O callback), so the loop's next turn runs the watchdog's late ticks before it reads the heartbeats queued meanwhile.
 */
const stallHost = (ms) => new Promise((resolve) => setImmediate(() => {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* the Host is busy */ }
  resolve();
}));
const QUICK = { heartbeatMs: 100, heartbeatTimeoutMs: 800, hostStallMs: 250 };

test('the Host stalling for several heartbeat timeouts quarantines no mod: the stall is not counted as the mods\' silence', async () => {
  const h = await makeHarness({ internals: { timing: QUICK } });
  try {
    for (const id of ['test.calm1', 'test.calm2']) await h.runtime.activate(await installMod(h.layout, { id, host: 'export default { host() {} };' }));
    await sleep(300);
    await stallHost(3 * QUICK.heartbeatTimeoutMs);
    await sleep(2 * QUICK.heartbeatTimeoutMs);
    await stallHost(3 * QUICK.heartbeatTimeoutMs);
    await sleep(2 * QUICK.heartbeatTimeoutMs);
    assert.deepEqual(h.quarantines, []);
    assert.deepEqual(h.topic('framework/fault'), []);
    assert.equal(h.runtime.status('test.calm1'), 'active');
    assert.equal(h.runtime.status('test.calm2'), 'active');
  } finally { await h.close(); }
});

test('a worker that stops answering is still quarantined, with the Host idle or stalling meanwhile; the mod that answers is not', async () => {
  const h = await makeHarness({ internals: { timing: QUICK } });
  try {
    await h.runtime.activate(await installMod(h.layout, { id: 'test.calm', host: 'export default { host() {} };' }));
    await h.runtime.activate(await installMod(h.layout, { id: 'test.stuck', host: `
      export default { host() { setTimeout(() => { for (;;) {} }, 50); } };` }));
    const t0 = Date.now();
    await waitFor(() => h.quarantines.length > 0, { timeout: 10000, what: 'the stuck mod quarantined while the Host is idle' });
    assert.ok(Date.now() - t0 >= QUICK.heartbeatTimeoutMs - 2 * QUICK.heartbeatMs, `quarantined after ${Date.now() - t0} ms`);
    assert.deepEqual(h.quarantines, [{ modId: 'test.stuck', reason: 'unresponsive' }]);

    await h.runtime.activate(await installMod(h.layout, { id: 'test.stuck2', host: `
      export default { host() { setTimeout(() => { for (;;) {} }, 50); } };` }));
    await sleep(200);
    await stallHost(3 * QUICK.heartbeatTimeoutMs);
    await waitFor(() => h.quarantines.length > 1, { timeout: 10000, what: 'the stuck mod quarantined after the Host stalled' });
    assert.deepEqual(h.quarantines, [{ modId: 'test.stuck', reason: 'unresponsive' }, { modId: 'test.stuck2', reason: 'unresponsive' }]);
    assert.equal(h.runtime.status('test.calm'), 'active');
  } finally { await h.close(); }
});

test('with the Host slow for good (every watchdog tick late), a stuck worker is still quarantined and the one that answers is not', async () => {
  const h = await makeHarness({ internals: { timing: QUICK } });
  try {
    await h.runtime.activate(await installMod(h.layout, { id: 'test.calm', host: 'export default { host() {} };' }));
    await h.runtime.activate(await installMod(h.layout, { id: 'test.stuck', host: `
      export default { host() { setTimeout(() => { for (;;) {} }, 50); } };` }));
    const t0 = Date.now();
    while (h.quarantines.length === 0 && Date.now() - t0 < 15000) await stallHost(2 * QUICK.hostStallMs);
    assert.deepEqual(h.quarantines, [{ modId: 'test.stuck', reason: 'unresponsive' }]);
    for (let i = 0; i < 10; i++) await stallHost(2 * QUICK.hostStallMs);
    assert.deepEqual(h.quarantines, [{ modId: 'test.stuck', reason: 'unresponsive' }]);
    assert.equal(h.runtime.status('test.calm'), 'active');
  } finally { await h.close(); }
});

test('a stall of the Host while a mod activates is not the mod\'s time: its activation, answered meanwhile, settles', async () => {
  const h = await makeHarness({ internals: { timing: { ...QUICK, activationMs: 300 } } });
  try {
    const p = h.runtime.activate(await installMod(h.layout, { id: 'test.prompt', host: 'export default { host() {} };' }));
    while (!h.workers.length) await new Promise((r) => setImmediate(r));   // the worker is launched and its activation deadline runs
    await stallHost(1500);
    await p;
    assert.equal(h.runtime.status('test.prompt'), 'active');
  } finally { await h.close(); }
});

test('a worker that dies on its own is torn down, faulted and quarantined as crashed', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.die', host: `
      export default { host() { setTimeout(() => process.exit(3), 50); } };` });
    await h.runtime.activate(mod);
    await waitFor(() => h.quarantines.length, { what: 'quarantine' });
    assert.deepEqual(h.quarantines, [{ modId: 'test.die', reason: 'crashed' }]);
    await waitFor(() => h.runtime.status('test.die') === 'inactive');
  } finally { await h.close(); }
});

test('deactivate while activating aborts the activation', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.abort', host: 'export default { host() { return new Promise(() => {}); } };' });
    const p = h.runtime.activate(mod);
    p.catch(() => {});
    await sleep(100);
    await h.runtime.deactivate('test.abort', 'abort');
    await assert.rejects(p, (e) => e instanceof CodexModsError);
    assert.equal(h.runtime.status('test.abort'), 'inactive');
  } finally { await h.close(); }
});

test('the 256 MB heap limit is enforced: a runaway mod is stopped and quarantined as crashed, the Host survives', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.oom', host: `
      export default { host() { setTimeout(() => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }, 50); } };` });
    const other = await installMod(h.layout, { id: 'test.fine', host: `export default { host(ctx) { ctx.services.provide('s', { ok: () => 'ok' }); } };` });
    await h.runtime.activate(other);
    await h.runtime.activate(mod);
    await waitFor(() => h.quarantines.length === 1, { timeout: 30000, what: 'OOM quarantine' });
    assert.deepEqual(h.quarantines, [{ modId: 'test.oom', reason: 'crashed' }]);
    await sleep(20);
    assert.match(h.topic('framework/fault').find((f) => f.kind === 'crash').message, /memory|heap/i);
    assert.equal(await h.runtime.callServiceForLease('mod:test.fine', { name: 's', method: 'ok', args: null }), 'ok');
  } finally { await h.close(); }
});
