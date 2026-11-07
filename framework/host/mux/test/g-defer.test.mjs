// Gate G-defer (docs/research/gate-defer.md): a server request (item/tool/requestUserInput) can be taken out of the stream, answered later and
// cleaned up correctly. Headless: the real mux, the fake app-server process (tests/fixtures), the app side as a PassThrough pair.
// Each test is one scripted trace; `spawnWith` wraps the fake app-server's stdin so write failures and acknowledgement delays can be
// injected deterministically and every line the mux writes to the backend can be asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { harness, until, sleep } from './helpers.mjs';

const A = 'mod:a', B = 'mod:b';
const Q = 'item/tool/requestUserInput';
const questions = [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
const ANSWER = { answers: { color: { answers: ['Blue'] } } };

/** `ctl.hook(line)` may return 'throw' (sync write failure), 'error' (the write happens but its callback fails) or {delayMs}. */
function spawnWith(ctl = {}) {
  ctl.written = [];
  const spawn = (cmd, args, o) => {
    const p = nodeSpawn(cmd, args, o);
    const real = p.stdin.write.bind(p.stdin);
    p.stdin.write = (data, cb) => {
      const line = String(data).trim();
      let msg; try { msg = JSON.parse(line); } catch { /* not a frame */ }
      ctl.written.push({ args: args.join(' '), msg });
      const mode = ctl.hook?.(msg);
      if (mode === 'throw') throw new Error('injected: write after end');
      if (mode === 'error') return real(data, () => cb?.(Object.assign(new Error('injected EPIPE'), { code: 'EPIPE' })));
      if (mode && mode.delayMs) return real(data, (err) => setTimeout(() => cb?.(err), mode.delayMs));
      return real(data, cb);
    };
    return p;
  };
  return spawn;
}
const isAnswerTo = (id) => (w) => w.msg && w.msg.id === id && w.msg.method === undefined;

/** A mod that defers every requestUserInput; returns what it saw. */
function deferringMod(h, id = A, opts = {}) {
  const mod = h.mux.client(id, opts);
  const seen = { deferred: [], resolved: [] };
  mod.onDeferred((d) => seen.deferred.push(d));
  mod.onResolved((token, reason) => seen.resolved.push({ token, reason }));
  mod.intercept('serverRequest', [Q], opts.handler ?? (() => ({ defer: true })), { timeoutMs: 2000 });
  return { mod, seen };
}
const ask = (h, id, threadId = 'thr-A') => h.app.send({ id, method: 'fake/serverRequest', params: { method: Q, params: { threadId, turnId: 'turn-1', questions } } });
const appSawRequest = (h) => h.app.inbox.some((m) => m.method === Q);
const respondedOnWire = (h) => h.serverLog().filter((l) => l.includes('"id":"srv-1"') && !l.includes('"method"'));

async function withHarness(opts, fn) {
  const ctl = opts.ctl ?? {};
  const h = await harness({ ...opts.h, spawn: spawnWith(ctl) });
  try { await h.up(); await fn(h, ctl); } finally { await h.close(); }
}

test('G-defer 1: a deferred request leaves the stream, is answered later, and the model-side reply carries the answer', async () => {
  await withHarness({}, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1, 5000, 'onDeferred');
    const d = seen.deferred[0];
    assert.match(d.token, /^dfr_[0-9a-f]{32}$/);
    assert.equal(d.message.method, Q);
    assert.equal(d.message.params.threadId, 'thr-A');
    assert.equal(d.info.affinityKey, 'thr-A');
    assert.equal(h.mux.metrics().deferredPending, 1);
    await sleep(100);
    assert.equal(appSawRequest(h), false, 'the app never saw the question');
    assert.equal(respondedOnWire(h).length, 0, 'and the backend is still waiting');

    const r = await mod.respond(d.token, { result: ANSWER });
    assert.deepEqual(r, { outcome: 'delivered' });
    const reply = await h.app.reply(10);
    assert.deepEqual(reply.result.answer, { id: 'srv-1', result: ANSWER }, 'the backend received our answer under its own request id');
    assert.deepEqual(seen.resolved, [{ token: d.token, reason: 'answered' }]);
    assert.equal(h.mux.metrics().deferredPending, 0);
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 1);
  });
});

test('G-defer 2: other threads\' frames are delivered while a question is deferred (and a held interceptor, for contrast, stalls them)', async () => {
  await withHarness({}, async (h) => {
    // The decision itself takes 80 ms; the frame behind the request waits only for the decision, never for the human.
    const { mod, seen } = deferringMod(h, A, { handler: async () => { await sleep(80); return { defer: true }; } });
    ask(h, 10, 'thr-A');
    h.app.send({ id: 11, method: 'fake/notify', params: { method: 'item/agentMessage/delta', params: { threadId: 'thr-B', delta: 'other thread' } } });
    const delta = await h.app.waitFor((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === 'thr-B', 5000);
    assert.equal(delta.params.delta, 'other thread');
    assert.equal(seen.deferred.length, 1, 'the question was deferred before the other thread\'s frame was delivered');
    assert.equal(h.mux.metrics().deferredPending, 1, 'and it is still open: nobody has answered yet');
    // A whole turn on another thread streams while the question is open.
    const t = await h.app.request(12, 'turn/start', { threadId: 'thr-B' });
    assert.ok(t.result.turn.id);
    await h.app.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === 'thr-B', 5000);
    assert.equal(h.mux.metrics().deferredPending, 1);
    assert.equal((await mod.respond(seen.deferred[0].token, { result: ANSWER })).outcome, 'delivered');
  });

  // Contrast (ARCHITECTURE §6.4, better-questions §3.4): the same wait inside the interceptor holds every later frame.
  await withHarness({}, async (h) => {
    const mod = h.mux.client(B);
    mod.intercept('serverRequest', [Q], async () => { await sleep(500); return undefined; }, { timeoutMs: 2000 });
    const t0 = Date.now();
    ask(h, 10, 'thr-A');
    h.app.send({ id: 11, method: 'fake/notify', params: { method: 'item/agentMessage/delta', params: { threadId: 'thr-B', delta: 'x' } } });
    await h.app.waitFor((m) => m.method === 'item/agentMessage/delta', 5000);
    assert.ok(Date.now() - t0 >= 450, 'held: the other thread waited for the interceptor');
  });
});

test('G-defer 3a: serverRequest/resolved before the answer cancels the token; a late answer is notDelivered and nothing is written', async () => {
  await withHarness({}, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    h.app.send({ id: 11, method: 'fake/notify', params: { method: 'serverRequest/resolved', params: { threadId: 'thr-A', requestId: 'srv-1' } } });
    await until(() => seen.resolved.length === 1);
    assert.deepEqual(seen.resolved, [{ token, reason: 'cancelled' }]);
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'cancelled' });
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 0, 'the backend was not sent an answer for a finished request');
    assert.equal(h.mux.metrics().deferredPending, 0);
    // The notification itself still flows to the app (stream order untouched), under the mux's id for the request (addition 10).
    assert.ok(await h.app.waitFor((m) => m.method === 'serverRequest/resolved', 2000));
  });
});

test('G-defer 3b: the answer wins the race against a later serverRequest/resolved (one resolution, answered)', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    assert.equal((await mod.respond(seen.deferred[0].token, { result: ANSWER })).outcome, 'delivered');
    h.app.send({ id: 11, method: 'fake/notify', params: { method: 'serverRequest/resolved', params: { threadId: 'thr-A', requestId: 'srv-1' } } });
    await h.app.waitFor((m) => m.method === 'serverRequest/resolved', 2000);
    await sleep(50);
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['answered'], 'exactly one onResolved');
  });
});

test('G-defer 3c: Stop (a successful turn/interrupt) cancels the turn\'s deferred questions', async () => {
  await withHarness({}, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const other = deferringMod(h, B).seen; void other;
    await h.app.request(11, 'turn/interrupt', { threadId: 'thr-A', turnId: 'turn-1' });
    await until(() => seen.resolved.length === 1);
    assert.equal(seen.resolved[0].reason, 'cancelled');
    assert.deepEqual(await mod.respond(seen.deferred[0].token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'cancelled' });
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 0);
  });
  // An interrupt for a different turn or thread leaves the question open.
  await withHarness({}, async (h) => {
    const { seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    await h.app.request(11, 'turn/interrupt', { threadId: 'thr-A', turnId: 'turn-9' });
    await h.app.request(12, 'turn/interrupt', { threadId: 'thr-Z', turnId: 'turn-1' });
    assert.equal(h.mux.metrics().deferredPending, 1);
  });
});

test('G-defer 3d: serverRequest/resolved arriving while the answer is being written does not change the answer\'s outcome', async () => {
  const ctl = { hook: (m) => (m && m.id === 'srv-1' && m.method === undefined ? { delayMs: 300 } : undefined) };
  await withHarness({ ctl }, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const p = mod.respond(seen.deferred[0].token, { result: ANSWER });
    await until(() => ctl.written.some(isAnswerTo('srv-1')));
    h.app.send({ id: 11, method: 'fake/notify', params: { method: 'serverRequest/resolved', params: { threadId: 'thr-A', requestId: 'srv-1' } } });
    await h.app.waitFor((m) => m.method === 'serverRequest/resolved', 2000);
    assert.deepEqual(await p, { outcome: 'delivered' });
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['answered']);
  });
});

test('G-defer 4: a backend restart while pending resolves the token as backendGone; the old token never reaches the new process', async () => {
  await withHarness({ h: { tuning: { restartIntervalMs: 50 } } }, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    h.app.send({ id: 11, method: 'fake/exit', params: { code: 3 } });
    await until(() => seen.resolved.length === 1, 12000, 'backendGone');
    assert.equal(seen.resolved[0].reason, 'backendGone');
    await until(() => h.bus.count('appServer/ready') === 2, 12000, 'restart');
    const writtenBefore = ctl.written.length;
    assert.deepEqual(await mod.respond(seen.deferred[0].token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'backendGone' });
    assert.equal(ctl.written.length, writtenBefore, 'nothing was written to the restarted backend');
    assert.equal(h.mux.metrics().deferredPending, 0);
    // The new generation defers and answers normally.
    ask(h, 12);
    await until(() => seen.deferred.length === 2);
    assert.equal((await mod.respond(seen.deferred[1].token, { result: ANSWER })).outcome, 'delivered');
  });
});

test('G-defer 5: an app disconnect resolves the token as appGone and tells the backend; a late answer is notDelivered', async () => {
  await withHarness({}, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    h.app.destroy();
    await until(() => seen.resolved.length === 1, 12000, 'appGone');
    assert.equal(seen.resolved[0].reason, 'appGone');
    const err = ctl.written.find(isAnswerTo('srv-1'));
    assert.equal(err.msg.error.message, 'client disconnected', 'the backend is not left waiting');
    assert.deepEqual(await mod.respond(seen.deferred[0].token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'appGone' });
    assert.equal((await mod.release(seen.deferred[0].token)).released, false);
  });
});

test('G-defer 6a: disabling the mod releases its open questions to the app\'s native UI, which can still answer them', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    assert.equal(appSawRequest(h), false);
    await mod.dispose();                                    // disable or crash: the Runtime disposes the mux client
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['modDisabled']);
    const q = await h.app.waitFor((m) => m.method === Q, 3000);
    assert.equal(q.params.threadId, 'thr-A');
    h.app.send({ id: q.id, result: ANSWER });               // the user answers in the native panel
    const reply = await h.app.reply(10);
    assert.deepEqual(reply.result.answer, { id: 'srv-1', result: ANSWER });
    assert.equal(h.mux.metrics().deferredPending, 0);
    await assert.rejects(mod.respond(seen.deferred[0].token, { result: ANSWER }), { code: 'Disposed' });
    // A re-enabled mod (same id, new client) cannot use the old token either.
    const again = h.mux.client(A);
    assert.deepEqual(await again.respond(seen.deferred[0].token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'released' });
  });
});

test('G-defer 6b: disabling the mod cancels questions the app cannot receive (no app connection for the thread)', async () => {
  await withHarness({}, async (h, ctl) => {
    await h.define(A, 'x');
    const { mod, seen } = deferringMod(h);
    // The mod's own thread on its own backend: the owner is the mod client, which has no connection to receive a native panel.
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;
    const asked = mod.request('fake/serverRequest', { method: Q, params: { threadId: t, questions } }, { backend: 'x' }).catch((e) => e);
    await until(() => seen.deferred.length === 1);
    await mod.dispose();
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['modDisabled']);
    const err = ctl.written.find((w) => w.args.includes('--name x') && isAnswerTo('srv-1')(w));
    assert.equal(err.msg.error.message, 'client disconnected', 'cancelled towards the backend');
    assert.equal(appSawRequest(h), false);
    await asked;
  });
});

test('G-defer 7a: two answers in sequence: the first wins, the second is notDelivered and nothing more is written', async () => {
  await withHarness({}, async (h, ctl) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    assert.equal((await mod.respond(token, { result: ANSWER })).outcome, 'delivered');
    assert.deepEqual(await mod.respond(token, { result: { answers: { color: { answers: ['Red'] } } } }), { outcome: 'notDelivered', reason: 'alreadyAnswered' });
    assert.deepEqual(await mod.release(token), { released: false, reason: 'alreadyAnswered' });
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 1);
    assert.equal(appSawRequest(h), false);
  });
});

test('G-defer 7b: two answers at the same moment: exactly one is delivered (also while the first write is in flight)', async () => {
  const ctl = { hook: (m) => (m && m.id === 'srv-1' && m.method === undefined ? { delayMs: 150 } : undefined) };
  await withHarness({ ctl }, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    const [a, b] = await Promise.all([mod.respond(token, { result: ANSWER }), mod.respond(token, { result: { answers: {} } })]);
    assert.deepEqual([a.outcome, b.outcome], ['delivered', 'notDelivered']);
    assert.equal(b.reason, 'alreadyAnswered');
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 1);
    const reply = await h.app.reply(10);
    assert.deepEqual(reply.result.answer.result, ANSWER, 'the first answer is the one the model got');
  });
});

test('G-defer 7c: release then answer: the answer is notDelivered (the app owns the request now); tokens are mod-bound', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = deferringMod(h);
    const other = h.mux.client(B);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    assert.deepEqual(await other.respond(token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'unknownToken' }, 'another mod cannot use or probe the token');
    assert.deepEqual(await other.release(token), { released: false, reason: 'unknownToken' });
    assert.deepEqual(await mod.release(token), { released: true });
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'released' });
    const q = await h.app.waitFor((m) => m.method === Q, 3000);
    h.app.send({ id: q.id, result: ANSWER });
    assert.deepEqual((await h.app.reply(10)).result.answer, { id: 'srv-1', result: ANSWER });
    await assert.rejects(mod.respond(token, { bogus: 1 }), { code: 'Invalid' });
  });
});

test('G-defer 8a: a synchronous write failure is notDelivered, the question stays open, and a retry succeeds', async () => {
  let failures = 1;
  const ctl = { hook: (m) => (m && m.id === 'srv-1' && m.method === undefined && failures-- > 0 ? 'throw' : undefined) };
  await withHarness({ ctl }, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'writeFailed' });
    assert.equal(h.mux.metrics().deferredPending, 1, 'nothing was sent, so the question is still open');
    assert.deepEqual(seen.resolved, []);
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'delivered' });
  });
});

test('G-defer 8b: an asynchronous write error is uncertain, the token is consumed, and the answer is never resent', async () => {
  const ctl = { hook: (m) => (m && m.id === 'srv-1' && m.method === undefined ? 'error' : undefined) };
  await withHarness({ ctl }, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'uncertain', reason: 'writeNotConfirmed' });
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['answered']);
    assert.deepEqual(await mod.respond(token, { result: ANSWER }), { outcome: 'notDelivered', reason: 'alreadyAnswered' });
    assert.equal(ctl.written.filter(isAnswerTo('srv-1')).length, 1, 'the uncertain answer was written once and not replayed');
  });
});

test('G-defer 8c: an acknowledgement that never arrives is uncertain, not delivered', async () => {
  const ctl = { hook: (m) => (m && m.id === 'srv-1' && m.method === undefined ? { delayMs: 5000 } : undefined) };
  await withHarness({ ctl, h: { tuning: { writeAckMs: 150 } } }, async (h) => {
    const { mod, seen } = deferringMod(h);
    ask(h, 10);
    await until(() => seen.deferred.length === 1);
    assert.equal((await mod.respond(seen.deferred[0].token, { result: ANSWER })).outcome, 'uncertain');
  });
});

test('G-defer 9: idle shutdown never kills a backend that has an open deferred question', async () => {
  await withHarness({}, async (h) => {
    await h.define(A, 'x', { idleStopMs: 150 });
    const { mod, seen } = deferringMod(h);
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;
    // The client request that triggered the question times out, so only the deferred token keeps the backend busy.
    mod.request('fake/serverRequest', { method: Q, params: { threadId: t, questions } }, { backend: 'x', timeoutMs: 100 }).catch(() => {});
    await until(() => seen.deferred.length === 1);
    await sleep(900);
    assert.equal(h.mux.listBackends(A)[0].state, 'ready', 'still running 6 idle periods later');
    assert.equal((await mod.respond(seen.deferred[0].token, { result: ANSWER })).outcome, 'delivered');
    await until(() => h.mux.listBackends(A)[0].state === 'stopped', 12000, 'idle stop after the question closed');
  });
});

test('G-defer 10: defer needs the permission and a listener; otherwise the request is delivered to the app as before', async () => {
  await withHarness({}, async (h) => {
    // Restricted client without defer: a fault, onError "pass" delivers the request.
    const faults = []; h.mux.onFault((f) => faults.push(f));
    const { seen } = deferringMod(h, A, { allowedMethods: { intercept: '*', observe: [], request: [] } });
    ask(h, 10);
    const q = await h.app.waitFor((m) => m.method === Q, 3000);
    assert.equal(seen.deferred.length, 0);
    assert.match(faults[0].message, /a mod does not defer requests/);
    h.app.send({ id: q.id, result: ANSWER });
    await h.app.reply(10);
  });
  await withHarness({}, async (h) => {
    // No onDeferred listener: the token could never be learned, so the request is delivered rather than lost.
    const mod = h.mux.client(B);
    mod.intercept('serverRequest', [Q], () => ({ defer: true }));
    ask(h, 10);
    const q = await h.app.waitFor((m) => m.method === Q, 3000);
    assert.equal(h.mux.metrics().deferredPending, 0);
    h.app.send({ id: q.id, result: ANSWER });
    await h.app.reply(10);
  });
});
