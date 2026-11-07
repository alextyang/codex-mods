import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until, sleep, leaseConnect } from './helpers.mjs';
import { createAffinity } from '../affinity.mjs';

const A = 'mod:a', B = 'mod:b';
const received = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

// ---------------------------------------------------------------- R3 correlation
test('R3 correlation: backend ids are mux-allocated m:<seq>; the app and a mod both using id 1 never collide', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    h.app.send({ id: 1, method: 'fake/slow', params: { ms: 150 } });
    const modP = mod.request('fake/slow', { ms: 20 });
    assert.deepEqual(await modP, { slept: 20 });
    const appReply = await h.app.reply(1);
    assert.deepEqual(appReply.result, { slept: 150 });
    const slow = received(h, 'primary').filter((m) => m.method === 'fake/slow');
    assert.equal(slow.length, 2);
    assert.ok(slow.every((m) => /^m:\d+$/.test(m.id)));
    assert.notEqual(slow[0].id, slow[1].id);
    // Equal ids from two clients to the same backend resolve to the right requester.
    h.app.send({ id: 1, method: 'echo/who', params: { who: 'app' } });
    const echo = await mod.request('echo/who', { who: 'mod' });
    assert.equal(echo.echo.params.who, 'mod');
    assert.equal((await h.app.waitFor((m) => m.id === 1 && m.result?.echo)).result.echo.params.who, 'app');
  } finally { await h.close(); }
});

test('R3 correlation: server-request ids are rewritten toward clients and the client responses map back', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    // Both backends emit a server request with the same original id ("srv-1") to the app.
    const viaX = mod.request('fake/serverRequest', { method: 'item/ask', params: { q: 'x' } }, { backend: 'x' });
    h.app.send({ id: 10, method: 'fake/serverRequest', params: { method: 'item/ask', params: { q: 'primary' } } });
    const asks = await until(async () => { const l = h.app.inbox.filter((m) => m.method === 'item/ask'); return l.length === 2 ? l : null; }, 12000, 'two server requests');
    assert.notEqual(asks[0].id, asks[1].id);
    assert.ok(asks.every((m) => /^s:\d+$/.test(m.id)), 'rewritten');
    for (const a of asks) h.app.send({ id: a.id, result: { from: a.params.q } });
    assert.equal((await viaX).answer.id, 'srv-1', 'the original id is restored toward the backend');
    assert.deepEqual((await viaX).answer.result, { from: 'x' });
    const primaryReply = await h.app.reply(10);
    assert.equal(primaryReply.result.answer.id, 'srv-1');
    assert.deepEqual(primaryReply.result.answer.result, { from: 'primary' });
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R4 routing
test('R4 routing: route result > explicit backend > affinity > primary', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const modA = h.mux.client(A);
    const modB = h.mux.client(B);
    // Default: primary.
    assert.equal((await modA.request('thread/start', {})).thread.id, 'thr-primary-1');
    // A thread started on x pins to x (affinity) for later requests from anyone.
    const tx = (await modA.request('thread/start', {}, { backend: 'x' })).thread.id;
    assert.equal(tx, 'thr-x-1');
    const turn = await h.app.request(1, 'turn/start', { threadId: tx });
    assert.ok(turn.result.turn);
    assert.ok(received(h, 'x').some((m) => m.method === 'turn/start'), 'affinity routed the app request to x');
    assert.ok(!received(h, 'primary').some((m) => m.method === 'turn/start'));
    // Explicit backend beats affinity.
    await modA.request('turn/start', { threadId: tx }, { backend: 'primary' });
    assert.equal(received(h, 'primary').filter((m) => m.method === 'turn/start').length, 1);
    // A route result beats the explicit backend; and it re-pins the key's backend only.
    const reg = modB.intercept('clientRequest', ['turn/start'], () => ({ route: 'primary' }));
    await modA.request('turn/start', { threadId: tx }, { backend: 'x' });
    assert.equal(received(h, 'primary').filter((m) => m.method === 'turn/start').length, 2);
    reg.dispose();
    await h.app.request(2, 'turn/start', { threadId: tx });
    assert.equal(received(h, 'primary').filter((m) => m.method === 'turn/start').length, 3, 'the key is now pinned to primary');
    // Mux addition 11: the app's own successful turn/start subscribed it, so the thread's notifications reach it too.
    await modA.request('fake/notify', { method: 'thread/event', params: { threadId: tx }, threadId: tx });
    await sleep(100);
    assert.ok(h.app.inbox.some((m) => m.method === 'thread/event'));
  } finally { await h.close(); }
});

test('R4 routing: responses go to the requester; unkeyed server notifications go to the app', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    const seen = [];
    mod.observe({ methods: ['global/'] }, (m) => seen.push(m));
    await mod.request('fake/notify', { method: 'global/changed', params: {} });
    await h.app.waitFor((m) => m.method === 'global/changed');
    assert.equal(h.app.inbox.filter((m) => m.id === 1 && m.result).length, 0, "the mod's response is not leaked to the app");
    await until(() => seen.length === 1);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R5 affinity
test('R5 affinity: the app starts a thread, a mod resumes it on a named backend; notifications and server requests still go to the app', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    assert.equal(t, 'thr-primary-1');
    const resumed = await mod.request('thread/resume', { threadId: t }, { backend: 'x' });
    assert.equal(resumed.thread.id, t);
    // The backend moved to x, the owner stayed the app: a notification emitted by x reaches the app.
    await mod.request('fake/notify', { method: 'item/note', params: { threadId: t }, threadId: t });
    const n = await h.app.waitFor((m) => m.method === 'item/note');
    assert.equal(n.params.threadId, t);
    // Server request from x for that thread goes to the app; the app's answer goes back to x.
    const asked = mod.request('fake/serverRequest', { method: 'item/approve', params: { threadId: t }, threadId: t });
    const ask = await h.app.waitFor((m) => m.method === 'item/approve');
    h.app.send({ id: ask.id, result: { approved: true } });
    assert.deepEqual((await asked).answer.result, { approved: true });
    assert.ok(received(h, 'x').some((m) => m.method === 'fake/serverRequest'));
    // Later app requests for the thread follow the new backend.
    await h.app.request(2, 'turn/start', { threadId: t });
    assert.ok(received(h, 'x').some((m) => m.method === 'turn/start'));
  } finally { await h.close(); }
});

test('R5 affinity: keys read from every configured path; thread/started notification routes by params.thread.id', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const seen = [];
    mod.observe({ methods: ['thread/started'] }, (m, info) => seen.push(info));
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;
    await until(() => seen.length === 1);
    assert.equal(seen[0].affinityKey, t);
    assert.equal(seen[0].backend, 'x');
    await sleep(100);
    assert.ok(!h.app.inbox.some((m) => m.method === 'thread/started'), 'thread/started belongs to the mod that created the thread');
  } finally { await h.close(); }
});

test('R5 affinity: a disposed owner releases its keys (they route to the app) and the next creator from a live client acquires them', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    await h.define(B, 'y');
    const modA = h.mux.client(A);
    const modB = h.mux.client(B);
    const t = (await modA.request('thread/start', {}, { backend: 'x' })).thread.id;
    const emit = (via) => (via ?? modA).request('fake/notify', { method: 'thread/ping', params: { threadId: t }, threadId: t });
    await emit();
    await sleep(80);
    assert.equal(h.app.inbox.filter((m) => m.method === 'thread/ping').length, 0, 'owned by modA: the app does not see it');
    await modA.dispose();
    // The key is unowned: requests still follow the backend pin (x), notifications now route to the app.
    await h.app.request(1, 'fake/notify', { method: 'thread/ping', params: { threadId: t }, threadId: t });
    await until(() => h.app.inbox.filter((m) => m.method === 'thread/ping').length === 1, 12000, 'ping to the app');
    // modB resumes it on its own backend: it acquires the key.
    await modB.request('thread/resume', { threadId: t }, { backend: 'y' });
    const seenB = [];
    modB.observe({ methods: ['thread/ping'] }, (m, info) => seenB.push(info));
    await modB.request('fake/notify', { method: 'thread/ping', params: { threadId: t }, threadId: t });
    await until(() => seenB.length === 1);
    await sleep(80);
    assert.equal(h.app.inbox.filter((m) => m.method === 'thread/ping').length, 1, 'modB owns it now: no new ping at the app');
  } finally { await h.close(); }
});

test('R5 affinity: a revoked lease releases its keys', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok === true);
    const t = (await c.request(1, 'thread/start', {})).result.thread.id;
    // Owned by the lease: notifications go to the lease, not the app.
    await c.request(2, 'fake/notify', { method: 'thread/pong', params: { threadId: t }, threadId: t });
    await c.waitFor((m) => m.method === 'thread/pong');
    assert.ok(!h.app.inbox.some((m) => m.method === 'thread/pong'));
    h.mux.revokeLease(lease.id);
    await c.closedP;
    await h.app.request(3, 'fake/notify', { method: 'thread/pong', params: { threadId: t }, threadId: t });
    await h.app.waitFor((m) => m.method === 'thread/pong');
  } finally { await h.close(); }
});

test('R5 affinity: a route result on a keyed request re-pins that key\'s backend only', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const t = (await mod.request('thread/start', {}, { backend: 'x' })).thread.id;
    const other = h.mux.client(B);
    other.intercept('clientRequest', ['turn/start'], () => ({ route: 'primary' }));
    await h.app.request(1, 'turn/start', { threadId: t });           // routed to primary and re-pinned
    await h.app.request(2, 'turn/start', { threadId: t });           // no interceptor needed any more? it still runs; same result
    assert.equal(received(h, 'primary').filter((m) => m.method === 'turn/start').length, 2);
    // The re-pin did not move the thread to the app by itself. The app's turn/start went to primary (where the fake does not know
    // the thread), so it did not subscribe the app to x's thread: x's notifications for it still do not reach the app.
    await mod.request('fake/notify', { method: 'thread/zzz', params: { threadId: t } }, { backend: 'x' });
    await sleep(80);
    assert.ok(!h.app.inbox.some((m) => m.method === 'thread/zzz'));
  } finally { await h.close(); }
});

test('R5 affinity: a route to an unknown backend is an invalid handler result, counted as a fault', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    mod.intercept('clientRequest', ['thread/'], () => ({ route: 'nope' }), { onError: 'reject' });
    const r = await h.app.request(1, 'thread/list', {});
    assert.equal(r.error.code, -32001);
    assert.equal(h.mux.metrics().interceptorFaults[A], 1);
  } finally { await h.close(); }
});

test('R5 affinity: the table is bounded with LRU eviction (unit)', () => {
  const t = createAffinity({ max: 100_000 });
  for (let i = 0; i < 100_001; i++) t.set('k' + i, { client: 'c', backend: 'primary' });
  assert.equal(t.size, 100_000);
  assert.equal(t.peek('k0'), undefined, 'least recently used evicted');
  assert.ok(t.peek('k1'));
  t.get('k1'); t.set('new', { client: 'c', backend: 'primary' });
  assert.ok(t.peek('k1'), 'a touched key survives');
  assert.equal(t.peek('k2'), undefined);
});

test('R5 affinity: eviction takes effect in routing (bounded table via tuning)', async () => {
  const h = await harness({ tuning: { affinityMax: 2 } });
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await mod.request('thread/start', {}, { backend: 'x' })).thread.id);
    await mod.request('fake/notify', { method: 'thread/ev', params: { threadId: ids[2] }, threadId: ids[2] });
    await sleep(80);
    assert.equal(h.app.inbox.filter((m) => m.method === 'thread/ev').length, 0, 'recent key still owned by the mod');
    // The oldest key was evicted: it no longer pins to x or the mod, so a request for it goes to primary.
    await h.app.request(1, 'turn/start', { threadId: ids[0] });
    assert.ok(received(h, 'primary').some((m) => m.method === 'turn/start'));
  } finally { await h.close(); }
});
