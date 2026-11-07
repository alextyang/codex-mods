// Mux addition 5 (docs/design/interception.md I1): a clientRequest interceptor may return {defer: true}. The request leaves its chain, the
// mux holds it under a token, and the holder settles it once: release (sent on through the rest of the pipeline, optionally with other
// params, resolving with the response the client got), respond (the client is answered without the backend), or the hold ends (the client
// goes away, the mux closes, the safety bound passes, the holder is disposed). Headless: the real mux and the strict fake app-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness, leaseConnect, until, sleep } from './helpers.mjs';
import { openJournal } from '../../graph/journal.mjs';
import { createAppServerNs } from '../../ctx/appserver.mjs';

const A = 'mod:a', B = 'mod:b', C = 'mod:c';
const received = (h, name = 'primary') => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));
const saw = (h, method, name = 'primary') => received(h, name).filter((m) => m.method === method);
const DEFER = () => ({ defer: true });

/** A mod client that defers the given clientRequest methods (all of one prefix by default) and records what it is told. */
function holder(h, id = A, methods = ['echo/'], handler = DEFER, copts = {}) {
  const mod = h.mux.client(id, copts);
  const seen = { deferred: [], resolved: [] };
  mod.onDeferred((d) => seen.deferred.push(d));
  mod.onResolved((token, reason) => seen.resolved.push({ token, reason }));
  mod.intercept('clientRequest', methods, handler, { timeoutMs: 2000 });
  return { mod, seen };
}
const echoOf = (method, params) => ({ echo: { method, params } });

async function withHarness(opts, fn) {
  const h = await harness(opts);
  try { await h.up(); await fn(h); } finally { await h.close(); }
}

test('A5 1: defer then release unchanged: the backend sees it once, the app gets the answer, and release resolves with that response', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/held', params: { x: 1 } });
    await until(() => seen.deferred.length === 1, 5000, 'onDeferred');
    const d = seen.deferred[0];
    assert.match(d.token, /^dfr_[0-9a-f]{32}$/);
    assert.deepEqual(d.message, { id: 10, method: 'echo/held', params: { x: 1 } }, 'the message as the interceptor saw it, under the app\'s own id');
    assert.ok(Object.isFrozen(d.message));
    assert.deepEqual(d.info, { kind: 'clientRequest', method: 'echo/held', origin: 'app', backend: 'primary', session: { id: 1, client: 'test-app' } });
    assert.equal(h.mux.metrics().deferredPending, 1);
    await sleep(150);
    assert.equal(saw(h, 'echo/held').length, 0, 'the backend never saw it while it was held');
    assert.equal(h.app.inbox.some((m) => m.id === 10), false, 'and the app has no answer yet');

    const r = await mod.release(d.token);
    assert.deepEqual(r, { released: true, response: { result: echoOf('echo/held', { x: 1 }) } });
    assert.deepEqual((await h.app.reply(10)).result, echoOf('echo/held', { x: 1 }), 'the app got the same response');
    const seenByBackend = saw(h, 'echo/held');
    assert.equal(seenByBackend.length, 1);
    assert.deepEqual(seenByBackend[0].params, { x: 1 });
    assert.deepEqual(seen.resolved, [], 'a holder\'s own release is not reported back to it');
    assert.equal(h.mux.metrics().deferredPending, 0);
  });
});

test('A5 1b: the info carries the affinity key, and release routes by key like a request the chain had passed', async () => {
  await withHarness({}, async (h) => {
    await h.define(A, 'x');
    const { mod, seen } = holder(h, A, ['turn/start']);
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;   // pins the thread to the mod's backend 'x'
    h.app.send({ id: 10, method: 'turn/start', params: { threadId: t, input: [] } });
    await until(() => seen.deferred.length === 1, 5000, 'onDeferred');
    assert.equal(seen.deferred[0].info.affinityKey, t);
    assert.equal(seen.deferred[0].info.backend, 'x', 'the destination the pipeline had chosen for the key');
    await sleep(100);
    assert.equal(saw(h, 'turn/start', 'x').length, 0);
    const r = await mod.release(seen.deferred[0].token);
    assert.equal(r.released, true);
    assert.ok(r.response.result.turn.id);
    assert.equal(saw(h, 'turn/start', 'x').length, 1, 'sent to the key\'s backend');
    assert.equal(saw(h, 'turn/start', 'primary').length, 0);
  });
});

test('A5 1c: a route chosen earlier in the chain survives the hold; later interceptors of the chain never see the request', async () => {
  await withHarness({}, async (h) => {
    await h.define(B, 'y');
    const router = h.mux.client(B);
    router.intercept('clientRequest', ['echo/'], () => ({ route: 'y' }), { priority: 5 });
    const { mod, seen } = holder(h, A, ['echo/'], DEFER);
    const later = h.mux.client(C);
    let laterCalls = 0;
    later.intercept('clientRequest', ['echo/'], () => { laterCalls++; }, { priority: -5 });
    h.app.send({ id: 10, method: 'echo/routed', params: {} });
    await until(() => seen.deferred.length === 1, 5000, 'onDeferred');
    const r = await mod.release(seen.deferred[0].token);
    assert.equal(r.released, true);
    assert.equal(saw(h, 'echo/routed', 'y').length, 1, 'the route is applied when the request goes on');
    assert.equal(saw(h, 'echo/routed', 'primary').length, 0);
    assert.equal(laterCalls, 0, 'the chain ended at the defer, as it does for a deferred server request');
  });
});

test('A5 2: release with changed params: the backend sees the new params, with the client\'s id and the same method', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/p', params: { a: 1 } });
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    // Invalid params are refused and leave the hold open.
    await assert.rejects(mod.release(token, { params: 5 }), { code: 'Invalid' });
    await assert.rejects(mod.release(token, { params: 'text' }), { code: 'Invalid' });
    await assert.rejects(mod.release(token, 'nope'), { code: 'Invalid' });
    assert.equal(h.mux.metrics().deferredPending, 1);

    const params = { a: 2, extra: [true, { deep: 'x' }] };
    const r = await mod.release(token, { params });
    assert.deepEqual(r, { released: true, response: { result: echoOf('echo/p', { a: 2, extra: [true, { deep: 'x' }] }) } });
    assert.deepEqual((await h.app.reply(10)).result, echoOf('echo/p', params), 'the app\'s answer comes back under its own id');
    const sent = saw(h, 'echo/p');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, params);
    assert.equal(Object.isFrozen(params), false, 'the caller\'s object is not frozen');
  });
  // The changed params are also what routes: another thread's key sends the request to that thread's backend.
  await withHarness({}, async (h) => {
    await h.define(A, 'x');
    const { mod, seen } = holder(h, A, ['turn/start']);
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;
    h.app.send({ id: 10, method: 'turn/start', params: { threadId: 'thr-unpinned', input: [] } });
    await until(() => seen.deferred.length === 1);
    await mod.release(seen.deferred[0].token, { params: { threadId: t, input: [] } });
    await until(() => saw(h, 'turn/start', 'x').length === 1, 5000, 'turn/start on x');
    assert.equal(saw(h, 'turn/start', 'primary').length, 0);
  });
});

test('A5 3: respond with an error: the backend never sees the request and the app gets the error', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/no', params: { a: 1 } });
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    await assert.rejects(mod.respond(token, { error: { code: 'x', message: 'bad' } }), { code: 'Invalid' });
    await assert.rejects(mod.respond(token, { result: 1, error: { code: 1, message: 'm' } }), { code: 'Invalid' });
    assert.equal(h.mux.metrics().deferredPending, 1, 'an invalid answer leaves the hold open');

    const err = { code: -32011, message: 'refused by a mod', data: { why: 'policy' } };
    assert.deepEqual(await mod.respond(token, { error: err }), { outcome: 'delivered' });
    assert.deepEqual((await h.app.reply(10)).error, err);
    await sleep(150);
    assert.equal(saw(h, 'echo/no').length, 0, 'the backend never saw it');
    assert.deepEqual(seen.resolved, []);
    assert.equal(h.mux.metrics().deferredPending, 0);
  });
  // A result works too, and a mod requester gets it as its call's result.
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    const b = h.mux.client(B);
    const call = b.request('echo/r', { q: 1 });
    await until(() => seen.deferred.length === 1);
    assert.deepEqual(await mod.respond(seen.deferred[0].token, { result: { synthetic: true } }), { outcome: 'delivered' });
    assert.deepEqual(await call, { synthetic: true });
    assert.equal(saw(h, 'echo/r').length, 0);
  });
});

test('A5 4: other requests of the same app session flow while one is held, including a turn/interrupt on the same thread', async () => {
  await withHarness({}, async (h) => {
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const u = (await h.app.request(2, 'thread/start', {})).result.thread.id;
    // The decision itself takes a moment; what is behind the held request waits for neither the decision nor the human.
    const { mod, seen } = holder(h, A, ['turn/start'], async (m) => { await sleep(40); return m.params.threadId === t ? { defer: true } : undefined; });
    h.app.send({ id: 10, method: 'turn/start', params: { threadId: t, input: [] } });
    h.app.send({ id: 11, method: 'turn/interrupt', params: { threadId: t, turnId: 'turn-0' } });
    h.app.send({ id: 12, method: 'thread/list', params: {} });
    h.app.send({ id: 13, method: 'echo/ping', params: {} });
    h.app.send({ id: 14, method: 'turn/start', params: { threadId: u, input: [] } });   // another thread: decided, not held
    assert.deepEqual((await h.app.reply(11, 5000)).result, {}, 'the Stop was not behind the held request');
    assert.ok((await h.app.reply(12, 5000)).result.data);
    assert.ok((await h.app.reply(13, 5000)).result.echo);
    assert.ok((await h.app.reply(14, 5000)).result.turn.id);
    await h.app.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === u, 5000);
    assert.equal(h.app.inbox.some((m) => m.id === 10), false, 'the held one has no answer yet');
    assert.equal(seen.deferred.length, 1);
    assert.equal(h.mux.metrics().deferredPending, 1);
    assert.equal(saw(h, 'turn/interrupt').length, 1, 'the interrupt reached the backend');
    assert.equal(saw(h, 'turn/start').filter((m) => m.params.threadId === t).length, 0);

    const r = await mod.release(seen.deferred[0].token);
    assert.equal(r.released, true);
    assert.ok((await h.app.reply(10)).result.turn.id);
    assert.equal(saw(h, 'turn/start').filter((m) => m.params.threadId === t).length, 1);
  });
});

test('A5 4b: a held request of a mod client does not delay its other requests, and counts as in flight', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h, A, ['echo/'], (m) => (m.params?.hold ? { defer: true } : undefined));
    const b = h.mux.client(B, { maxInFlight: 2 });
    const held1 = b.request('echo/one', { hold: true });
    await until(() => seen.deferred.length === 1);
    assert.equal((await b.request('echo/two', {})).echo.method, 'echo/two', 'its other requests flow');
    assert.equal(await Promise.race([held1.then(() => 'done'), sleep(50).then(() => 'held')]), 'held');
    const held2 = b.request('echo/four', { hold: true });
    await until(() => seen.deferred.length === 2);
    await assert.rejects(b.request('echo/three', {}), { code: 'Busy' });   // both slots are held requests
    await mod.release(seen.deferred[0].token);
    assert.equal((await held1).echo.method, 'echo/one');
    assert.equal((await b.request('echo/three', {})).echo.method, 'echo/three', 'a slot is free again');
    assert.deepEqual(await mod.respond(seen.deferred[1].token, { result: { fine: true } }), { outcome: 'delivered' });
    assert.deepEqual(await held2, { fine: true });
  });
});

test('A5 5: the app disconnecting while its request is held gives appGone, and the backend never sees it', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/gone', params: {} });
    await until(() => seen.deferred.length === 1);
    const token = seen.deferred[0].token;
    h.app.destroy();
    await until(() => seen.resolved.length === 1, 12000, 'appGone');
    assert.deepEqual(seen.resolved, [{ token, reason: 'appGone' }]);
    assert.deepEqual(await mod.release(token), { released: false, reason: 'appGone' });
    assert.deepEqual(await mod.respond(token, { result: {} }), { outcome: 'notDelivered', reason: 'appGone' });
    await sleep(150);
    assert.equal(saw(h, 'echo/gone').length, 0);
    assert.equal(h.mux.metrics().deferredPending, 0);
  });
});

test('A5 5b: any client: a lease disconnecting, a mod requester being disposed, and a mod requester timing out all end the hold', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    // A lease client.
    const lease = await leaseConnect(h.sock, h.mux.issueLease(B, 'svc'));
    await lease.waitFor((m) => m.ok === true);
    lease.send({ id: 1, method: 'echo/lease', params: {} });
    await until(() => seen.deferred.length === 1);
    assert.equal(seen.deferred[0].info.origin.startsWith('client:'), true);
    lease.destroy();
    await until(() => seen.resolved.length === 1, 5000, 'lease gone');
    assert.equal(seen.resolved[0].reason, 'appGone');
    assert.deepEqual(await mod.release(seen.deferred[0].token), { released: false, reason: 'appGone' });
    // A mod requester that is disposed.
    const b = h.mux.client(B);
    const gone = b.request('echo/disposed', {}).catch((e) => e);
    await until(() => seen.deferred.length === 2);
    await b.dispose();
    assert.equal((await gone).code, 'Unavailable');
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['appGone', 'appGone']);
    // A mod requester whose own timeout passes while the request is held.
    const c = h.mux.client(C);
    const timed = c.request('echo/timeout', {}, { timeoutMs: 100 }).catch((e) => e);
    await until(() => seen.deferred.length === 3);
    assert.equal((await timed).code, 'Unavailable');
    assert.deepEqual(seen.resolved.map((r) => r.reason), ['appGone', 'appGone', 'cancelled'], 'the request ended without its holder');
    assert.deepEqual(await mod.release(seen.deferred[2].token), { released: false, reason: 'cancelled' });
    await sleep(100);
    for (const m of ['echo/lease', 'echo/disposed', 'echo/timeout']) assert.equal(saw(h, m).length, 0, m);
    assert.equal(h.mux.metrics().deferredPending, 0);
  });
});

test('A5 5c: the mux closing while a request is held tells the holder muxClosed and sends nothing', async () => {
  const h = await harness();
  try {
    await h.up();
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/closing', params: {} });
    await until(() => seen.deferred.length === 1);
    await h.mux.close();
    assert.deepEqual(seen.resolved, [{ token: seen.deferred[0].token, reason: 'muxClosed' }]);
    await assert.rejects(mod.release(seen.deferred[0].token), { code: 'Disposed' });
    assert.equal(saw(h, 'echo/closing').length, 0);
  } finally { await h.close(); }
});

test('A5 6: a hold not settled within tune.maxClientHoldMs is released unchanged, and the holder is told expired', async () => {
  await withHarness({ tuning: { maxClientHoldMs: 200 } }, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/slow-human', params: { a: 1 } });
    await until(() => seen.deferred.length === 1);
    assert.equal(seen.resolved.length, 0);
    const reply = await h.app.reply(10, 5000);
    assert.deepEqual(reply.result, echoOf('echo/slow-human', { a: 1 }), 'it went on unchanged');
    assert.deepEqual(seen.resolved, [{ token: seen.deferred[0].token, reason: 'expired' }]);
    assert.deepEqual(await mod.release(seen.deferred[0].token), { released: false, reason: 'expired' });
    assert.deepEqual(await mod.respond(seen.deferred[0].token, { result: {} }), { outcome: 'notDelivered', reason: 'expired' });
    assert.equal(saw(h, 'echo/slow-human').length, 1);
    assert.equal(h.mux.metrics().deferredPending, 0);
  });
  // A hold settled in time does not expire later.
  await withHarness({ tuning: { maxClientHoldMs: 150 } }, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/in-time', params: {} });
    await until(() => seen.deferred.length === 1);
    await mod.release(seen.deferred[0].token);
    await sleep(400);
    assert.deepEqual(seen.resolved, []);
    assert.equal(saw(h, 'echo/in-time').length, 1);
  });
});

test('A5 7: disposing the holding client releases its held requests unchanged', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    h.app.send({ id: 10, method: 'echo/one', params: { n: 1 } });
    h.app.send({ id: 11, method: 'echo/two', params: { n: 2 } });
    const b = h.mux.client(B);
    const third = b.request('echo/three', { n: 3 });
    await until(() => seen.deferred.length === 3);
    assert.equal(saw(h, 'echo/one').length + saw(h, 'echo/two').length, 0);
    await mod.dispose();   // disable or crash: the Runtime disposes the mux client
    assert.deepEqual((await h.app.reply(10)).result, echoOf('echo/one', { n: 1 }));
    assert.deepEqual((await h.app.reply(11)).result, echoOf('echo/two', { n: 2 }));
    assert.deepEqual(await third, echoOf('echo/three', { n: 3 }));
    for (const [m, n] of [['echo/one', 1], ['echo/two', 2], ['echo/three', 3]]) { const s = saw(h, m); assert.equal(s.length, 1, m); assert.deepEqual(s[0].params, { n }); }
    assert.deepEqual(seen.resolved, [], 'the disposed holder is not told');
    assert.equal(h.mux.metrics().deferredPending, 0);
    await assert.rejects(mod.release(seen.deferred[0].token), { code: 'Disposed' });
    // A re-enabled mod (same id, new client) cannot settle the old token.
    const again = h.mux.client(A);
    assert.deepEqual(await again.release(seen.deferred[0].token), { released: false, reason: 'released' });
    assert.deepEqual(await again.respond(seen.deferred[1].token, { result: {} }), { outcome: 'notDelivered', reason: 'released' });
  });
});

test('A5 8: a token closes once: a second settle reports the tombstone reason, whichever way the first went', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    const other = h.mux.client(B);
    const hold = async (id, method) => { h.app.send({ id, method, params: {} }); await until(() => seen.deferred.length === id - 9); return seen.deferred[id - 10].token; };

    const t1 = await hold(10, 'echo/a');   // release, then release, then respond
    assert.deepEqual(await other.release(t1), { released: false, reason: 'unknownToken' }, 'tokens are mod-bound');
    assert.deepEqual(await other.respond(t1, { result: {} }), { outcome: 'notDelivered', reason: 'unknownToken' });
    assert.equal((await mod.release(t1)).released, true);
    assert.deepEqual(await mod.release(t1), { released: false, reason: 'released' });
    assert.deepEqual(await mod.respond(t1, { result: {} }), { outcome: 'notDelivered', reason: 'released' });
    assert.equal(saw(h, 'echo/a').length, 1);

    const t2 = await hold(11, 'echo/b');   // respond, then respond, then release
    assert.deepEqual(await mod.respond(t2, { result: { n: 1 } }), { outcome: 'delivered' });
    assert.deepEqual(await mod.respond(t2, { result: { n: 2 } }), { outcome: 'notDelivered', reason: 'alreadyAnswered' });
    assert.deepEqual(await mod.release(t2), { released: false, reason: 'alreadyAnswered' });
    assert.deepEqual((await h.app.reply(11)).result, { n: 1 }, 'the first answer is the one the client got');
    assert.equal(saw(h, 'echo/b').length, 0);

    const t3 = await hold(12, 'echo/c');   // two settles at the same moment: exactly one wins
    const [r1, r2] = await Promise.all([mod.release(t3), mod.release(t3)]);
    assert.deepEqual([r1.released, r2.released].sort(), [false, true]);
    assert.equal([r1, r2].find((r) => !r.released).reason, 'released');
    const t4 = await hold(13, 'echo/d');
    const [a1, a2] = await Promise.all([mod.respond(t4, { result: { n: 1 } }), mod.respond(t4, { result: { n: 2 } })]);
    assert.deepEqual([a1.outcome, a2.outcome].sort(), ['delivered', 'notDelivered']);
    assert.equal(h.app.inbox.filter((m) => m.id === 13).length, 1, 'the client got one answer');

    assert.deepEqual(seen.resolved, [], 'nothing ended without the holder');
    assert.equal(h.mux.metrics().deferredPending, 0);
    await assert.rejects(mod.release(''), { code: 'Invalid' });
  });
});

test('A5 9: observers see a held-then-released request once, and a responded one as the answer only', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    const watcher = h.mux.client(C);
    const events = [];
    watcher.observe({ methods: ['echo/'] }, (m, info) => events.push({ kind: info.kind, method: info.method, params: m.params, origin: info.origin }));
    h.app.send({ id: 10, method: 'echo/obs', params: { n: 1 } });
    await until(() => seen.deferred.length === 1);
    await sleep(100);
    assert.deepEqual(events, [], 'a held request is not on the wire: observers see nothing yet');
    await mod.release(seen.deferred[0].token, { params: { n: 2 } });
    await h.app.reply(10);
    await sleep(100);
    assert.deepEqual(events.map((e) => [e.kind, e.method]), [['clientRequest', 'echo/obs'], ['serverResponse', 'echo/obs']], 'once each');
    assert.equal(events[0].origin, 'app');
    assert.deepEqual(events[0].params, { n: 2 }, 'the request observed is the one transmitted, with its changed params');
    // A responded request: the answer is observed (as for an interceptor\'s respond), and there is no request on the wire.
    events.length = 0;
    h.app.send({ id: 11, method: 'echo/obs2', params: {} });
    await until(() => seen.deferred.length === 2);
    await mod.respond(seen.deferred[1].token, { result: { ok: 1 } });
    await h.app.reply(11);
    await sleep(100);
    assert.deepEqual(events.map((e) => [e.kind, e.method]), [['serverResponse', 'echo/obs2']]);
    assert.equal(saw(h, 'echo/obs2').length, 0);
  });
});

test('A5 10: release goes through response interceptors, and its result is the response as the client got it', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h);
    const rewriter = h.mux.client(B);
    rewriter.intercept('serverResponse', ['echo/'], (m) => ({ replace: { id: m.id, result: { rewritten: true } } }));
    h.app.send({ id: 10, method: 'echo/si', params: {} });
    await until(() => seen.deferred.length === 1);
    assert.deepEqual(await mod.release(seen.deferred[0].token), { released: true, response: { result: { rewritten: true } } });
    assert.deepEqual((await h.app.reply(10)).result, { rewritten: true });
  });
});

test('A5 11: a release whose response is an error resolves with the error; a backend that dies first is an unknown outcome the client is told', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h, A, ['fake/']);
    h.app.send({ id: 10, method: 'fake/error', params: { code: -32099, message: 'backend says no' } });
    await until(() => seen.deferred.length === 1);
    assert.deepEqual(await mod.release(seen.deferred[0].token), { released: true, response: { error: { code: -32099, message: 'backend says no' } } });
    assert.deepEqual((await h.app.reply(10)).error, { code: -32099, message: 'backend says no' });
  });
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h, A, ['fake/slow']);
    h.app.send({ id: 10, method: 'fake/slow', params: { ms: 60_000 } });
    await until(() => seen.deferred.length === 1);
    const released = mod.release(seen.deferred[0].token);
    await until(() => saw(h, 'fake/slow').length === 1, 5000, 'sent');
    h.app.send({ id: 11, method: 'fake/exit', params: { code: 1 } });
    const r = await released;
    assert.equal(r.released, true);
    assert.equal(r.response.error.data.codexmods, 'OutcomeUnknown');
    assert.equal((await h.app.reply(10)).error.data.codexmods, 'OutcomeUnknown');
  });
});

test('A5 12: the client leaving after the release but before the response resolves released false with sent', async () => {
  await withHarness({}, async (h) => {
    const { mod, seen } = holder(h, A, ['fake/slow']);
    h.app.send({ id: 10, method: 'fake/slow', params: { ms: 60_000 } });
    await until(() => seen.deferred.length === 1);
    const released = mod.release(seen.deferred[0].token);
    await until(() => saw(h, 'fake/slow').length === 1, 5000, 'sent');
    h.app.destroy();
    assert.deepEqual(await released, { released: false, reason: 'appGone', sent: true }, 'it was sent, but its client will never get the response');
  });
});

test('A5 13: a held request from a client other than the app is claimed in the intent journal when it goes on, with the params it carries then', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-a5-'));
  const file = path.join(dir, 'intents.jsonl');
  const journal = openJournal(file);
  const h = await harness({ journal });
  try {
    await h.up();
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const { mod, seen } = holder(h, A, ['thread/name/set']);
    const b = h.mux.client(B);
    const call = b.request('thread/name/set', { threadId: t, name: 'first' });
    await until(() => seen.deferred.length === 1);
    const claims = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.phase === 'started');
    assert.equal(claims().length, 0, 'nothing is claimed while the request is only held');
    await mod.release(seen.deferred[0].token, { params: { threadId: t, name: 'second' } });
    await call;
    assert.deepEqual(claims().map((e) => [e.source, e.operation, e.caller]), [['mux', 'thread/name/set', B]]);
    assert.equal(saw(h, 'thread/name/set').at(-1).params.name, 'second');
    // A held request that is answered instead is never claimed: it changes nothing.
    const call2 = b.request('thread/name/set', { threadId: t, name: 'third' });
    await until(() => seen.deferred.length === 2);
    await mod.respond(seen.deferred[1].token, { result: {} });
    await call2;
    assert.equal(claims().length, 1);
  } finally { await h.close(); journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A5 14: defer on a client request needs the permission and a listener; otherwise the request goes on as if not deferred', async () => {
  await withHarness({}, async (h) => {
    const faults = []; h.mux.onFault((f) => faults.push(f));
    const { seen } = holder(h, A, ['echo/'], DEFER, { allowedMethods: { intercept: '*', observe: [], request: [] } });
    const r = await h.app.request(10, 'echo/denied', {});
    assert.ok(r.result.echo);
    assert.equal(seen.deferred.length, 0);
    assert.match(faults[0].message, /a mod does not defer requests/);
  });
  await withHarness({}, async (h) => {
    const mod = h.mux.client(B);   // no onDeferred listener: the token could never be learned
    mod.intercept('clientRequest', ['echo/'], DEFER);
    const r = await h.app.request(10, 'echo/nolistener', {});
    assert.ok(r.result.echo);
    assert.equal(h.mux.metrics().deferredPending, 0);
    assert.equal(saw(h, 'echo/nolistener').length, 1);
  });
  // `defer` stays a serverRequest/clientRequest result: notifications and responses cannot be deferred.
  await withHarness({}, async (h) => {
    const faults = []; h.mux.onFault((f) => faults.push(f));
    const mod = h.mux.client(B);
    mod.onDeferred(() => {});
    mod.intercept('clientNotification', ['note/x'], DEFER);
    mod.intercept('serverResponse', ['echo/'], DEFER);
    h.app.send({ method: 'note/x', params: {} });
    await h.app.request(10, 'echo/resp', {});
    await until(() => faults.length >= 2, 5000, 'two faults');
    assert.ok(faults.every((f) => /not allowed on/.test(f.message)));
  });
});

test('A5 15: release(token, {params}) on a deferred server request is Invalid and leaves it open', async () => {
  await withHarness({}, async (h) => {
    const mod = h.mux.client(A);
    const seen = [];
    mod.onDeferred((d) => seen.push(d));
    mod.intercept('serverRequest', ['item/tool/requestUserInput'], DEFER, { timeoutMs: 2000 });
    h.app.send({ id: 10, method: 'fake/serverRequest', params: { method: 'item/tool/requestUserInput', params: { threadId: 'thr-A', turnId: 't', questions: [] } } });
    await until(() => seen.length === 1);
    assert.equal(seen[0].info.kind, 'serverRequest');
    await assert.rejects(mod.release(seen[0].token, { params: { a: 1 } }), { code: 'Invalid' });
    assert.deepEqual(await mod.release(seen[0].token, {}), { released: true }, 'without params it behaves as before');
  });
});

test('graph-integrity G6.4: ctx.appServer has no deferral for a mod: no release, respond, onDeferred or onResolved, in any realm', () => {
  const ns = createAppServerNs();
  for (const name of ['release', 'respond']) assert.equal(ns.calls[name], undefined, name);
  for (const name of ['onDeferred', 'onResolved']) assert.equal(ns.subs[name], undefined, name);
});
