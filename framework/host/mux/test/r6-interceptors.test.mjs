import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { harness, scriptedSpawn, until, sleep } from './helpers.mjs';

const A = 'mod:a', B = 'mod:b', C = 'mod:c';
const received = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

test('R6 interceptors: methods match exactly, by prefix (trailing /) and with *', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    const hits = { exact: [], prefix: [], all: [] };
    mod.intercept('clientRequest', ['thread/start'], (m) => { hits.exact.push(m.method); });
    mod.intercept('clientRequest', ['turn/'], (m) => { hits.prefix.push(m.method); });
    mod.intercept('clientRequest', '*', (m) => { hits.all.push(m.method); });
    await h.app.request(1, 'thread/start', {});
    await h.app.request(2, 'thread/list', {});
    await h.app.request(3, 'turn/start', { threadId: 'zz' });
    await h.app.request(4, 'turn/interrupt', { threadId: 'zz' });
    assert.deepEqual(hits.exact, ['thread/start']);
    assert.deepEqual(hits.prefix, ['turn/start', 'turn/interrupt']);
    assert.equal(hits.all.length, 4, 'the four requests (the handshake was earlier)');
  } finally { await h.close(); }
});

test('R6 interceptors: a non-matching interceptor has zero invocations (metrics)', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A), other = h.mux.client(B);
    let calls = 0;
    mod.intercept('clientRequest', ['never/'], () => { calls++; });
    mod.intercept('serverNotification', ['never/matches'], () => { calls++; });
    other.intercept('clientRequest', ['thread/list'], () => undefined);
    await h.app.request(1, 'thread/start', {});
    await h.app.request(2, 'thread/list', {});
    assert.equal(calls, 0);
    assert.equal(h.mux.metrics().interceptorCalls[A] ?? 0, 0);
    assert.equal(h.mux.metrics().interceptorCalls[B], 1);
  } finally { await h.close(); }
});

test('R6 interceptors: order is priority desc, then rank asc, then registration order; each handler sees the previous output', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A, { rank: 2 }), b = h.mux.client(B, { rank: 1 }), c = h.mux.client(C, { rank: 3 });
    const order = [];
    const step = (tag) => (m) => { order.push(tag); return { replace: { ...m, params: { ...m.params, trail: [...(m.params.trail ?? []), tag] } } }; };
    a.intercept('clientRequest', ['echo/t'], step('a-p0-first'));
    a.intercept('clientRequest', ['echo/t'], step('a-p0-second'));
    b.intercept('clientRequest', ['echo/t'], step('b-p0'));
    c.intercept('clientRequest', ['echo/t'], step('c-p5'), { priority: 5 });
    a.intercept('clientRequest', ['echo/t'], step('a-p1'), { priority: 1 });
    const r = await h.app.request(1, 'echo/t', {});
    assert.deepEqual(order, ['c-p5', 'a-p1', 'b-p0', 'a-p0-first', 'a-p0-second']);
    assert.deepEqual(r.result.echo.params.trail, order, 'the backend saw the accumulated output');
  } finally { await h.close(); }
});

test('R6 interceptors: respond ends the chain and nothing reaches the backend', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    let later = 0;
    a.intercept('clientRequest', ['thread/list'], () => ({ respond: { result: { data: ['synthetic'] } } }), { priority: 1 });
    b.intercept('clientRequest', ['thread/list'], () => { later++; });
    const r = await h.app.request(1, 'thread/list', {});
    assert.deepEqual(r.result, { data: ['synthetic'] });
    assert.equal(later, 0);
    assert.ok(!received(h, 'primary').some((m) => m.method === 'thread/list'));
    // An error response, and to a mod requester.
    a.intercept('clientRequest', ['thread/err'], () => ({ respond: { error: { code: -32011, message: 'nope' } } }));
    const e = await h.app.request(2, 'thread/err', {});
    assert.deepEqual(e.error, { code: -32011, message: 'nope' });
    await assert.rejects(b.request('thread/err', {}), (err) => err.code === 'Invalid' && err.details.rpcError.code === -32011);
  } finally { await h.close(); }
});

test('R6 interceptors: drop ends the chain for notifications (both directions)', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    let later = 0;
    a.intercept('serverNotification', ['drop/'], () => ({ drop: true }), { priority: 1 });
    b.intercept('serverNotification', ['drop/'], () => { later++; });
    a.intercept('clientNotification', ['client/dropped'], () => ({ drop: true }));
    await h.app.request(1, 'fake/notify', { method: 'drop/me', params: {} });
    await h.app.request(2, 'fake/notify', { method: 'keep/me', params: {} });
    await h.app.waitFor((m) => m.method === 'keep/me');
    assert.ok(!h.app.inbox.some((m) => m.method === 'drop/me'));
    assert.equal(later, 0);
    h.app.send({ method: 'client/dropped', params: {} });
    h.app.send({ method: 'client/kept', params: {} });
    await until(() => h.serverLog().some((l) => l.includes('client/kept')));
    assert.ok(!h.serverLog().some((l) => l.includes('client/dropped')));
  } finally { await h.close(); }
});

test('R6 interceptors: results not allowed for the kind are invalid (handler error)', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    const faults = [];
    h.mux.onFault((f) => faults.push(f));
    a.intercept('clientRequest', ['echo/bad1'], () => ({ drop: true }));                         // drop is notifications only
    a.intercept('serverNotification', ['bad/'], () => ({ respond: { result: 1 } }));              // respond is requests only
    a.intercept('serverResponse', ['echo/bad2'], () => ({ route: 'primary' }));                   // route is clientRequest only
    a.intercept('clientRequest', ['echo/bad3'], () => ({ replace: { id: 999, method: 'echo/bad3' } })); // id change
    a.intercept('clientRequest', ['echo/bad4'], () => ({ drop: true, route: 'primary' }));        // two keys
    for (const [i, m] of ['echo/bad1', 'echo/bad2', 'echo/bad3', 'echo/bad4'].entries()) {
      const r = await h.app.request(10 + i, m, {});
      assert.ok(r.result, `${m} passes through on onError:pass`);
    }
    await h.app.request(20, 'fake/notify', { method: 'bad/note', params: {} });
    await h.app.waitFor((m) => m.method === 'bad/note');
    assert.equal(faults.length, 5);
    assert.ok(faults.every((f) => f.clientId === A && f.kind === 'invalid'));
    assert.equal(h.mux.metrics().interceptorFaults[A], 5);
  } finally { await h.close(); }
});

test('R6 interceptors: replace validation (same id; method only on clientRequest; JSON-RPC shaped)', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    const faults = [];
    h.mux.onFault((f) => faults.push(f.kind));
    // Method may change on a clientRequest.
    const reg = a.intercept('clientRequest', ['echo/old'], (m) => ({ replace: { ...m, method: 'echo/new' } }));
    assert.equal((await h.app.request(1, 'echo/old', {})).result.echo.method, 'echo/new');
    reg.dispose();
    // ... but not on a serverNotification, nor may a notification gain an id, nor a response lose its shape.
    a.intercept('serverNotification', ['n/'], (m) => ({ replace: { ...m, method: 'n/other' } }));
    a.intercept('serverResponse', ['echo/shape'], () => ({ replace: { id: 1 } }));
    await h.app.request(2, 'fake/notify', { method: 'n/x', params: {} });
    await h.app.waitFor((m) => m.method === 'n/x');
    assert.ok(!h.app.inbox.some((m) => m.method === 'n/other'));
    const r = await h.app.request(3, 'echo/shape', {});
    assert.ok(r.result?.echo, 'invalid replacement ignored');
    assert.deepEqual(faults, ['invalid', 'invalid']);
  } finally { await h.close(); }
});

test('R6 interceptors: async handlers; a held clientRequest delays only itself', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    a.intercept('clientRequest', ['echo/held'], async (m) => { await sleep(300); return { replace: { ...m, params: { held: true } } }; }, { timeoutMs: 2000 });
    const t0 = Date.now();
    h.app.send({ id: 1, method: 'echo/held', params: {} });
    h.app.send({ id: 2, method: 'echo/free', params: {} });
    await h.app.reply(2);
    assert.ok(Date.now() - t0 < 250, 'the free request was not held');
    const held = await h.app.reply(1);
    assert.ok(Date.now() - t0 >= 280);
    assert.deepEqual(held.result.echo.params, { held: true });
  } finally { await h.close(); }
});

test("R6 interceptors: onError 'pass' on timeout continues with the pre-handler message, discards the late result and emits onFault", async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    const faults = [];
    h.mux.onFault((f) => faults.push(f));
    a.intercept('clientRequest', ['echo/slowhandler'], async (m) => { await sleep(300); return { replace: { ...m, params: { late: true } } }; }, { timeoutMs: 60 });
    const r = await h.app.request(1, 'echo/slowhandler', { orig: true });
    assert.deepEqual(r.result.echo.params, { orig: true });
    await sleep(350);
    assert.deepEqual(received(h, 'primary').filter((m) => m.method === 'echo/slowhandler').map((m) => m.params), [{ orig: true }], 'the late result was never sent');
    assert.equal(faults.length, 1);
    assert.equal(faults[0].kind, 'timeout');
    assert.equal(h.mux.metrics().interceptorFaults[A], 1);
  } finally { await h.close(); }
});

test('R6 interceptors: a stall of the Host is not the handler\'s time: its answer, queued while the Host stalled past the deadline, applies and no fault is emitted', async () => {
  const h = await harness();
  const { port1, port2 } = new MessageChannel();
  try {
    await h.up();
    const a = h.mux.client(A);
    const faults = [];
    h.mux.onFault((f) => faults.push(f));
    a.intercept('clientRequest', ['echo/stalled'], (m) => new Promise((resolve) => {
      port2.once('message', () => resolve({ replace: { ...m, params: { answered: true } } }));
      // The handler answers at once, as a worker's message would arrive; the Host then stalls past the deadline before it reads it.
      setImmediate(() => { port1.postMessage('answer'); const end = performance.now() + 700; while (performance.now() < end) { /* the Host is busy */ } });
    }), { timeoutMs: 300 });
    const r = await h.app.request(1, 'echo/stalled', { orig: true });
    assert.deepEqual(r.result.echo.params, { answered: true });
    assert.deepEqual(faults, []);
  } finally { port1.close(); port2.close(); await h.close(); }
});

test("R6 interceptors: onError 'pass' after a throw continues with the previous output (sync and async)", async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    const faults = [];
    h.mux.onFault((f) => faults.push(f.kind));
    a.intercept('clientRequest', ['echo/t'], (m) => ({ replace: { ...m, params: { step: 1 } } }), { priority: 3 });
    a.intercept('clientRequest', ['echo/t'], () => { throw new Error('boom'); }, { priority: 2 });
    b.intercept('clientRequest', ['echo/t'], async () => { throw new Error('async boom'); }, { priority: 1 });
    const r = await h.app.request(1, 'echo/t', {});
    assert.deepEqual(r.result.echo.params, { step: 1 });
    assert.deepEqual(faults, ['throw', 'throw']);
  } finally { await h.close(); }
});

test("R6 interceptors: onError 'reject' per kind (request error, response error, notification dropped)", async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    const faults = [];
    h.mux.onFault((f) => faults.push(f.kind));
    a.intercept('clientRequest', ['rej/req'], () => { throw new Error('x'); }, { onError: 'reject' });
    a.intercept('serverResponse', ['rej/resp'], () => { throw new Error('y'); }, { onError: 'reject' });
    a.intercept('serverNotification', ['rej/note'], () => { throw new Error('z'); }, { onError: 'reject' });
    const e1 = await h.app.request(1, 'rej/req', {});
    assert.equal(e1.error.code, -32001);
    assert.ok(!received(h, 'primary').some((m) => m.method === 'rej/req'), 'nothing was sent upstream');
    const e2 = await h.app.request(2, 'rej/resp', {});
    assert.equal(e2.error.code, -32001);
    assert.ok(received(h, 'primary').some((m) => m.method === 'rej/resp'), 'the request was sent; its response was replaced');
    await h.app.request(3, 'fake/notify', { method: 'rej/note', params: {} });
    await h.app.request(4, 'fake/notify', { method: 'ok/note', params: {} });
    await h.app.waitFor((m) => m.method === 'ok/note');
    assert.ok(!h.app.inbox.some((m) => m.method === 'rej/note'));
    assert.deepEqual(faults, ['throw', 'throw', 'throw']);
  } finally { await h.close(); }
});

test("R6 interceptors: a mod's own traffic skips its own interceptors but passes through others'", async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    const callsA = [], callsB = [];
    a.intercept('clientRequest', ['echo/own'], (m, info) => { callsA.push(info.origin); });
    b.intercept('clientRequest', ['echo/own'], (m, info) => { callsB.push(info.origin); });
    a.intercept('serverResponse', ['echo/own'], (m, info) => { callsA.push('resp:' + info.origin); });
    await a.request('echo/own', {});
    assert.deepEqual(callsA, [], 'no interceptor of A ran for A\'s own request or its response');
    assert.deepEqual(callsB, [A]);
    await h.app.request(1, 'echo/own', {});
    assert.deepEqual(callsA, ['app', 'resp:app']);
    assert.deepEqual(callsB, [A, 'app']);
  } finally { await h.close(); }
});

test('R6 interceptors: info carries kind, method, origin, local/qualified backend and affinity key', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const a = h.mux.client(A), b = h.mux.client(B);
    const seen = [];
    a.intercept('clientRequest', ['turn/start'], (m, info) => { seen.push(['A', info]); });
    b.intercept('clientRequest', ['turn/start'], (m, info) => { seen.push(['B', info]); });
    const t = (await a.request('thread/start', {}, { backend: 'x' })).thread.id;
    await h.app.request(1, 'turn/start', { threadId: t });
    const byMod = Object.fromEntries(seen.map(([k, i]) => [k, i]));
    assert.deepEqual({ ...byMod.A }, { kind: 'clientRequest', method: 'turn/start', origin: 'app', backend: 'x', affinityKey: t });
    assert.equal(byMod.B.backend, 'mod:a/x');
  } finally { await h.close(); }
});

test('R6 interceptors: serverRequest respond is answered by the mux and the app never sees it; clientResponse replace', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    a.intercept('serverRequest', ['item/auto'], () => ({ respond: { result: { auto: true } } }));
    h.app.send({ id: 1, method: 'fake/serverRequest', params: { method: 'item/auto', params: {} } });
    const r = await h.app.reply(1);
    assert.deepEqual(r.result.answer.result, { auto: true });
    assert.ok(!h.app.inbox.some((m) => m.method === 'item/auto'));
    // clientResponse replace
    a.intercept('clientResponse', ['item/ask'], (m) => ({ replace: { id: m.id, result: { patched: true } } }));
    h.app.send({ id: 2, method: 'fake/serverRequest', params: { method: 'item/ask', params: {} } });
    const ask = await h.app.waitFor((m) => m.method === 'item/ask');
    h.app.send({ id: ask.id, result: { original: true } });
    assert.deepEqual((await h.app.reply(2)).result.answer.result, { patched: true });
  } finally { await h.close(); }
});

test('R6 interceptors: serverNotifications from one backend are processed in order; a held one holds later ones', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    const a = h.mux.client(A);
    const seen = [];
    a.observe({ methods: ['seq/'] }, (m) => seen.push([m.params.n, Date.now()]));
    a.intercept('serverNotification', ['seq/1'], async () => { await sleep(150); }, { timeoutMs: 2000 });
    const t0 = Date.now();
    procs[0].outMany([{ method: 'seq/1', params: { n: 1 } }, { method: 'seq/2', params: { n: 2 } }, { method: 'seq/3', params: { n: 3 } }]);
    await until(() => seen.length === 3);
    assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3]);
    assert.ok(seen[1][1] - t0 >= 130, 'seq/2 waited for seq/1');
  } finally { await h.close(); }
});

test('R6 interceptors: registrations validate timeoutMs (max 30000), kinds, and are removed by dispose', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A);
    assert.throws(() => a.intercept('clientRequest', '*', () => {}, { timeoutMs: 30001 }), { code: 'Invalid' });
    assert.throws(() => a.intercept('bogus', '*', () => {}), { code: 'Invalid' });
    assert.throws(() => a.intercept('clientRequest', [], () => {}), { code: 'Invalid' });
    let n = 0;
    const d = a.intercept('clientRequest', ['echo/d'], () => { n++; });
    await h.app.request(1, 'echo/d', {});
    d.dispose();
    await h.app.request(2, 'echo/d', {});
    assert.equal(n, 1);
    const d2 = a.intercept('clientRequest', ['echo/d'], () => { n++; });
    await a.dispose();
    await h.app.request(3, 'echo/d', {});
    assert.equal(n, 1, 'dispose removes every registration');
    void d2;
  } finally { await h.close(); }
});

test('R6 interceptors: throughput with five non-matching interceptors and 10 000 notifications', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    let calls = 0;
    const mods = ['mod:t1', 'mod:t2', 'mod:t3', 'mod:t4', 'mod:t5'].map((id) => h.mux.client(id));
    for (const m of mods) {
      m.intercept('serverNotification', ['never/'], () => { calls++; });
      m.intercept('serverNotification', ['also/never'], () => { calls++; });
    }
    const batch = [];
    for (let i = 0; i < 10_000; i++) batch.push({ method: 'item/agentMessage/delta', params: { threadId: 'T', delta: 'd' + i } });
    const t0 = Date.now();
    for (let i = 0; i < batch.length; i += 500) procs[0].outMany(batch.slice(i, i + 500));
    await until(() => h.app.inbox.length >= 10_000, 20_000, '10 000 notifications at the app');
    assert.equal(calls, 0);
    const counts = h.mux.metrics().interceptorCalls;
    for (const m of ['mod:t1', 'mod:t2', 'mod:t3', 'mod:t4', 'mod:t5']) assert.equal(counts[m] ?? 0, 0);
    assert.equal(h.mux.metrics().frames.serverNotification, 10_000);
    assert.ok(Date.now() - t0 < 10_000);
  } finally { await h.close(); }
});
