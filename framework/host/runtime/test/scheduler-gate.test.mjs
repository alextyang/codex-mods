// Gate G-sched: crash injection against a real Host runtime and real mod workers.
//
// "Host crash" is simulated two ways. crashHost() terminates the mod's worker without letting the runtime run any teardown
// (as if the whole Host process died), then a NEW runtime is started on the same root. rawTerminate() only terminates the
// worker, so the runtime's own crash handling (fault, quarantine, teardown) runs, and the mod is activated again.
//
// The external effect is a fake `turn/start`: every request the mod sends through ctx.appServer is appended to a shared
// `effects` list that outlives workers and runtimes, so a duplicate is visible as a second entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, installMod, waitFor, sleep, inWorker, createFakeMux } from './helpers.mjs';

const ID = 'test.sched';

const hostSource = (ctrl) => `
import fs from 'node:fs';
const CTRL = ${JSON.stringify(ctrl)};
const read = () => JSON.parse(fs.readFileSync(CTRL, 'utf8'));
const note = (o) => fs.appendFileSync(CTRL + '.log', JSON.stringify(o) + '\\n');
export default { async host(ctx) {
  ctx.services.provide('t', { async run({ body, args }) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try { return { ok: (await new AsyncFunction('ctx', 'args', body)(ctx, args)) ?? null }; }
    catch (e) { return { err: { code: e.code ?? null, message: String(e.message) } }; }
  } });
  const turnStart = (tag) => ctx.appServer.request('turn/start', { threadId: 'T1', tag });
  ctx.scheduler.on('resume', async (job) => {
    const { mode } = read();
    note({ deliver: job.delivery, generation: job.generation, tag: job.data.tag });
    if (job.delivery === 'uncertain') return;          // reconcile: never redo the effect
    await turnStart(job.data.tag);                      // the external effect
    if (mode === 'hang-after-effect') await new Promise(() => {});
    await job.done({ ok: true });
    if (mode === 'hang-after-done') await new Promise(() => {});
  });
  const cfg = read();
  for (const spec of cfg.ensure ?? []) { const r = await ctx.scheduler.schedule(spec); note({ ensure: spec.id, status: r.status }); }
  // A naive mod that keeps its intent in ordinary (snapshot-restored) storage, as a negative control.
  if ((await ctx.storage.get('naive/intent'))?.pending) {
    await turnStart('naive');
    await ctx.storage.set('naive/intent', { pending: false });
  }
} };`;

async function rig() {
  const effects = [];
  const mux = createFakeMux();
  const origClient = mux.client;
  mux.client = (id, opts) => {
    const c = origClient.call(mux, id, opts);
    const req = c.request;
    c.request = async (method, params, o) => { effects.push({ method, tag: params?.tag, threadId: params?.threadId }); return req.call(c, method, params, o); };
    return c;
  };
  const internals = { timing: { heartbeatTimeoutMs: 600000 } };       // an abandoned runtime must not run its own teardown
  const hosts = [];
  const boot = async (prev) => {
    const h = await makeHarness({ mux, internals, ...(prev ? { root: { root: prev.root, layout: prev.layout } } : {}) });
    hosts.push(h);
    return h;
  };
  const h1 = await boot();
  const ctrl = join(h1.root, 'ctrl.json');
  await writeFile(ctrl, JSON.stringify({ mode: 'normal' }));
  const mod = await installMod(h1.layout, { id: ID, host: hostSource(ctrl), grants: ['appServer.request'] });
  const r = {
    effects, mux, h: h1, mod, ctrl,
    setCtrl: (o) => writeFile(ctrl, JSON.stringify(o)),
    log: async () => (await readFile(ctrl + '.log', 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    deliveries: async () => (await r.log()).filter((l) => l.deliver).map((l) => `${l.deliver}:${l.tag}`),
    run: (body, args) => inWorker(r.h.runtime, ID, body, args),
    job: async (id = 'resume') => JSON.parse(await readFile(join(mod.retainedDir, 'store.json'), 'utf8')).data[`sched/job/${id}`],
    activate: () => r.h.runtime.activate(mod),
    /** The whole Host dies: the worker stops and nothing in the runtime gets to clean up. A fresh runtime takes over the root. */
    async crashHost() {
      for (const w of r.h.workers) { w.worker.removeAllListeners('exit'); await w.worker.terminate(); }
      r.h = await boot(r.h);
    },
    /** Only the worker is terminated; the runtime sees an unexpected exit and runs its crash handling. */
    async rawTerminate() {
      const before = r.h.workers.length;
      await r.h.workers.at(-1).worker.terminate();
      await waitFor(() => r.h.runtime.status(ID) === 'inactive', { what: 'teardown after crash' });
      assert.ok(r.h.workers.length === before);
    },
    // Abandoned runtimes (crashed Hosts) are not closed: their workers are gone. Only the live one is, then the root is removed.
    async close() { await r.h.runtime.close(); await rm(hosts[0].root, { recursive: true, force: true }); },
  };
  return r;
}
async function withRig(fn) { const r = await rig(); try { await fn(r); } finally { await r.close(); } }
const tags = (r) => r.effects.map((e) => e.tag);

test('crash before send: the job falls due while the Host is down and is delivered at activation, once, as overdue', async () => {
  await withRig(async (r) => {
    await r.activate();
    const at = Date.now() + 600;
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: args.at, generation: 1, data: { tag: 'A' } });`, { at });
    assert.equal((await r.job()).state, 'pending');
    await r.crashHost();
    assert.deepEqual(tags(r), [], 'no effect before the crash');
    await sleep(800);                                   // the deadline passes while nothing runs
    assert.deepEqual(tags(r), []);
    await r.activate();
    await waitFor(() => r.effects.length >= 1, { what: 'overdue delivery' });
    await waitFor(async () => (await r.job()).state === 'done');
    await sleep(300);
    assert.deepEqual(tags(r), ['A'], 'exactly one effect');
    assert.deepEqual(await r.deliveries(), ['overdue:A']);
    const job = await r.job();
    assert.equal(job.delivery, 'overdue'); assert.ok(job.lateMs >= 100);
  });
});

test('crash after the effect and before done: delivered once as uncertain, never retried, across further restarts', async () => {
  await withRig(async (r) => {
    await r.setCtrl({ mode: 'hang-after-effect' });
    await r.activate();
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 100, generation: 1, data: { tag: 'A' } });`);
    await waitFor(() => r.effects.length === 1, { what: 'the effect' });
    assert.equal((await r.job()).state, 'started', 'started is durable before and during the effect');
    await r.crashHost();
    await r.setCtrl({ mode: 'normal' });
    await r.activate();
    await waitFor(async () => (await r.deliveries()).length === 2, { what: 'uncertain delivery' });
    await sleep(300);
    assert.deepEqual(tags(r), ['A'], 'the framework did not repeat the effect');
    assert.deepEqual(await r.deliveries(), ['normal:A', 'uncertain:A']);
    const job = await r.job();
    assert.equal(job.state, 'uncertain'); assert.equal(job.notified, true);
    // two more restarts (graceful, then another crash): the outcome stays reported once and the effect is never repeated
    await r.h.runtime.deactivate(ID, 'test'); await r.activate();
    await r.crashHost(); await r.activate();
    await sleep(400);
    assert.deepEqual(tags(r), ['A']);
    assert.equal((await r.deliveries()).length, 2);
    assert.equal((await r.job()).state, 'uncertain');
  });
});

test('same crash point, but the worker alone is terminated (the runtime quarantines it): still one effect, one uncertain delivery', async () => {
  await withRig(async (r) => {
    await r.setCtrl({ mode: 'hang-after-effect' });
    await r.activate();
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'A' } });`);
    await waitFor(() => r.effects.length === 1);
    await r.rawTerminate();
    assert.ok(r.h.quarantines.some((q) => q.modId === ID && q.reason === 'crashed'));
    await r.setCtrl({ mode: 'normal' });
    await r.activate();
    await waitFor(async () => (await r.deliveries()).includes('uncertain:A'));
    await sleep(300);
    assert.deepEqual(tags(r), ['A']);
    assert.equal((await r.job()).state, 'uncertain');
  });
});

test('crash after done: nothing is delivered again, and re-running the activation code does not re-arm the job', async () => {
  await withRig(async (r) => {
    await r.setCtrl({ mode: 'hang-after-done' });
    await r.activate();
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'A' } });`);
    await waitFor(async () => (await r.job()).state === 'done');
    assert.deepEqual(tags(r), ['A']);
    await r.crashHost();
    // the new activation ensures the very same job again, as a mod's startup code would
    await r.setCtrl({ mode: 'normal', ensure: [{ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'A' } }] });
    await r.activate();
    await sleep(600);
    assert.deepEqual(tags(r), ['A']);
    assert.deepEqual(await r.deliveries(), ['normal:A']);
    assert.ok((await r.log()).some((l) => l.ensure === 'resume' && l.status === 'exists'));
    assert.equal((await r.job()).state, 'done');
  });
});

test('an old data snapshot restored after completion cannot resurrect the job (retained store); ordinary storage can, which is why intents are retained', async () => {
  await withRig(async (r) => {
    await r.setCtrl({ mode: 'normal' });
    await r.activate();
    // state at snapshot time: a naive intent in ordinary storage, and the framework job not yet created
    await r.run(`await ctx.storage.set('naive/intent', { pending: true });`);
    await r.h.runtime.deactivate(ID, 'snapshot');
    const snap = join(r.h.root, 'snapshot-data');
    await cp(r.mod.dataDir, snap, { recursive: true });            // what lifecycle takeSnapshot does (data dir only)
    await r.activate();                                            // the naive mod acts on its intent
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'A' } });`);
    await waitFor(async () => (await r.job()).state === 'done');
    assert.deepEqual(tags(r).sort(), ['A', 'naive']);
    // roll back with data restore: the data dir is replaced by the old snapshot, the retained dir is not touched
    await r.h.runtime.deactivate(ID, 'restore-data');
    await rm(r.mod.dataDir, { recursive: true, force: true });
    await cp(snap, r.mod.dataDir, { recursive: true });
    await r.setCtrl({ mode: 'normal', ensure: [{ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'A' } }] });
    await r.activate();
    await sleep(600);
    assert.equal(tags(r).filter((t) => t === 'A').length, 1, 'the framework job was not resurrected');
    assert.equal((await r.job()).state, 'done');
    assert.equal(tags(r).filter((t) => t === 'naive').length, 2, 'negative control: intent kept in restorable storage repeats its effect');
  });
});

test('a generation replaced while pending (across a crash): only the newer intent runs', async () => {
  await withRig(async (r) => {
    await r.activate();
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 700, generation: 1, data: { tag: 'gen1' } });`);
    await r.crashHost();
    await r.setCtrl({ mode: 'normal', ensure: [{ id: 'resume', at: Date.now() + 150, generation: 2, data: { tag: 'gen2' } }] });
    await r.activate();
    await waitFor(async () => (await r.job()).state === 'done');
    await sleep(1000);                                              // past gen1's original deadline
    assert.deepEqual(tags(r), ['gen2']);
    const job = await r.job();
    assert.equal(job.generation, 2);
    assert.deepEqual(job.superseded.map((e) => [e.generation, e.state]), [[1, 'cancelled']]);
    assert.deepEqual(await r.deliveries(), ['normal:gen2']);
  });
});

test('a generation replaced while the older one is mid-effect: the older is reported uncertain once, the newer runs once, nothing repeats', async () => {
  await withRig(async (r) => {
    await r.setCtrl({ mode: 'hang-after-effect' });
    await r.activate();
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: Date.now() + 50, generation: 1, data: { tag: 'gen1' } });`);
    await waitFor(() => r.effects.length === 1);
    await r.crashHost();
    await r.setCtrl({ mode: 'normal', ensure: [{ id: 'resume', at: Date.now() + 100, generation: 2, data: { tag: 'gen2' } }] });
    await r.activate();
    await waitFor(async () => (await r.job()).state === 'done');
    await sleep(400);
    assert.deepEqual(tags(r), ['gen1', 'gen2']);
    assert.deepEqual((await r.deliveries()).sort(), ['normal:gen1', 'normal:gen2', 'uncertain:gen1']);
    const job = await r.job();
    assert.deepEqual(job.superseded.map((e) => [e.generation, e.state, e.notified]), [[1, 'uncertain', true]]);
  });
});

test('jobs survive disable and enable: a job that fell due while the mod was disabled arrives overdue once', async () => {
  await withRig(async (r) => {
    await r.activate();
    // Due well after the disable ends (a loaded machine is slow to disable), and past by the time the mod is enabled again.
    const at = Date.now() + 1500;
    await r.run(`return await ctx.scheduler.schedule({ id: 'resume', at: args.at, generation: 1, data: { tag: 'A' } });`, { at });
    await r.h.runtime.deactivate(ID, 'disable');
    assert.ok(Date.now() < at, 'disabled before the job fell due');
    await sleep(at - Date.now() + 200);
    assert.deepEqual(tags(r), []);
    await r.activate();
    await waitFor(() => r.effects.length === 1);
    await sleep(300);
    assert.deepEqual(await r.deliveries(), ['overdue:A']);
  });
});
