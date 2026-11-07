import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, until, sleep } from './helpers.mjs';
import { createRing } from '../observers.mjs';

const A = 'mod:a', B = 'mod:b';
const received = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

// ---------------------------------------------------------------- R7 requests
test('R7 requests: resolves with the result; a JSON-RPC error rejects with the error details', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    assert.deepEqual(await mod.request('echo/a', { v: 1 }), { echo: { method: 'echo/a', params: { v: 1 } } });
    await assert.rejects(mod.request('fake/error', { code: -32602, message: 'bad params' }), (e) => e.name === 'CodexModsError' && e.details.rpcError.code === -32602 && e.message === 'bad params');
  } finally { await h.close(); }
});

test('R7 requests: not transmitted rejects Unavailable (unknown backend, no primary)', async () => {
  const h = await harness({ tuning: { handshakeWaitMs: 150 } });
  try {
    const mod = h.mux.client(A);
    await assert.rejects(mod.request('x/y', {}, { backend: 'ghost' }), { code: 'Unavailable' });
    await assert.rejects(mod.request('x/y', {}), { code: 'Unavailable' }, 'no app has connected yet');
    assert.equal(mod.hasTransmitted, false);
  } finally { await h.close(); }
});

test('R7 requests: transmitted but unanswered rejects OutcomeUnknown (timeout, backend exit) and is never retried', async () => {
  const h = await harness({ tuning: { restartIntervalMs: 50 } });
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    // timeout
    await assert.rejects(mod.request('fake/slow', { ms: 600 }, { timeoutMs: 100 }), { code: 'OutcomeUnknown' });
    // backend exit while a request is pending (named backend)
    await mod.request('thread/start', {}, { backend: 'x' });
    const pending = mod.request('fake/slow', { ms: 5000 }, { backend: 'x' });
    await sleep(50);
    await mod.request('fake/exit', {}, { backend: 'x' }).catch(() => {});
    await assert.rejects(pending, { code: 'OutcomeUnknown' });
    assert.equal(received(h, 'x').filter((m) => m.method === 'fake/slow').length, 1, 'sent exactly once');
    // primary exit with a pending request
    const p2 = mod.request('fake/slow', { ms: 5000 });
    await sleep(50);
    h.app.send({ id: 9, method: 'fake/exit', params: {} });
    await assert.rejects(p2, { code: 'OutcomeUnknown' });
    await until(() => h.bus.count('appServer/ready') === 2, 12000, 'restart');
    assert.equal(received(h, 'primary').filter((m) => m.method === 'fake/slow' && m.params.ms === 5000).length, 1, 'never retried after the restart');
  } finally { await h.close(); }
});

test('R7 requests: the app receives a JSON-RPC error for requests in flight when the primary exits', async () => {
  const h = await harness({ tuning: { restartIntervalMs: 50 } });
  try {
    await h.up();
    h.app.send({ id: 1, method: 'fake/slow', params: { ms: 5000 } });
    await sleep(50);
    h.app.send({ id: 2, method: 'fake/exit', params: {} });
    const r = await h.app.reply(1);
    assert.equal(r.error.data.codexmods, 'OutcomeUnknown');
  } finally { await h.close(); }
});

test('R7 requests: notify is fire-and-forget and reaches the backend', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    assert.equal(mod.notify('note/one', { a: 1 }), undefined);
    await until(() => received(h, 'primary').some((m) => m.method === 'note/one'));
    const m = received(h, 'primary').find((x) => x.method === 'note/one');
    assert.equal(m.id, undefined);
    assert.deepEqual(m.params, { a: 1 });
  } finally { await h.close(); }
});

test('R7 requests: the per-client in-flight cap is maxInFlight (default 32); exceeding it gives Busy', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A, { maxInFlight: 2 });
    const p1 = mod.request('fake/slow', { ms: 200 }), p2 = mod.request('fake/slow', { ms: 200 });
    await assert.rejects(mod.request('fake/slow', { ms: 1 }), { code: 'Busy' });
    await Promise.all([p1, p2]);
    await mod.request('echo/ok', {}); // slots are free again
    const def = h.mux.client(B);
    const many = Array.from({ length: 32 }, () => def.request('fake/slow', { ms: 150 }));
    await assert.rejects(def.request('echo/x', {}), { code: 'Busy' });
    await Promise.all(many);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R8 observation
test('R8 observation: frozen copies, in order, with filters by kind and method (names and prefixes)', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    const all = [], reqs = [], prefixed = [];
    mod.observe({}, (m, info) => all.push([m, info]));
    mod.observe({ kinds: ['clientRequest'], methods: ['thread/start'] }, (m, info) => reqs.push(info));
    mod.observe({ kinds: ['serverNotification'], methods: ['turn/'] }, (m) => prefixed.push(m.method));
    await h.app.request(1, 'thread/start', {});
    await h.app.request(2, 'turn/start', { threadId: 'thr-primary-1' });
    await until(() => prefixed.length >= 2, 12000, 'turn notifications');
    assert.deepEqual(prefixed, ['turn/started', 'turn/completed']);
    assert.equal(reqs.length, 1);
    assert.deepEqual({ ...reqs[0] }, { kind: 'clientRequest', method: 'thread/start', origin: 'app', backend: 'primary', session: { id: 1, client: 'test-app' } });
    assert.ok(all.every(([m, i]) => Object.isFrozen(m) && Object.isFrozen(i)));
    const seq = all.map(([, i]) => i.method + ':' + i.kind);
    assert.ok(seq.indexOf('thread/start:clientRequest') < seq.indexOf('thread/start:serverResponse'));
    assert.ok(seq.indexOf('thread/start:serverResponse') < seq.indexOf('thread/started:serverNotification'));
  } finally { await h.close(); }
});

test('R8 observation: copies are deep-frozen and shared safely between observers', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    const mod = h.mux.client(A), other = h.mux.client(B);
    let got, threw = false;
    mod.observe({ methods: ['f/'] }, (m) => { got = m; try { m.params.nested.x = 2; } catch { threw = true; } });
    const seen = [];
    other.observe({ methods: ['f/'] }, (m) => seen.push(m.params.nested.x));
    procs[0].out({ method: 'f/n', params: { nested: { x: 1 } } });
    await until(() => seen.length === 1);
    assert.ok(Object.isFrozen(got.params.nested));
    assert.ok(threw, 'mutation throws in strict mode');
    assert.deepEqual(seen, [1]);
    assert.equal((await h.app.waitFor((m) => m.method === 'f/n')).params.nested.x, 1);
  } finally { await h.close(); }
});

test('R8 observation: overflow drops, delivers {gap} and never blocks forwarding', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    const mod = h.mux.client(A);
    const got = [];
    mod.observe({ methods: ['burst/'] }, (m) => got.push(m), { queue: 10 });
    procs[0].outMany(Array.from({ length: 100 }, (_, i) => ({ method: 'burst/n', params: { i } })));
    await until(() => h.app.inbox.filter((m) => m.method === 'burst/n').length === 100, 12000, 'all 100 forwarded');
    await until(() => got.some((g) => g.gap), 12000, 'a gap');
    const delivered = got.filter((g) => !g.gap).map((g) => g.params.i);
    const gap = got.find((g) => g.gap).gap;
    assert.deepEqual(delivered, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'the first 10 fit the queue');
    assert.deepEqual(gap, { from: 11, to: 100, reason: 'overflow' });
    assert.ok(got.at(-1).gap, 'the gap follows the delivered messages');
    procs[0].out({ method: 'burst/after', params: { i: 1000 } });
    await until(() => got.some((g) => g.params?.i === 1000), 12000, 'delivery resumes');
  } finally { await h.close(); }
});

test('R8 observation: replay boot delivers the primary session frames from the start (the handshake) first', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.app.request(1, 'thread/start', {});
    const mod = h.mux.client(A);
    const got = [];
    mod.observe({}, (m, info) => got.push(info ? info.kind + ':' + info.method : 'gap'), { replay: 'boot' });
    await sleep(60);
    await h.app.request(2, 'thread/list', {});
    await until(() => got.includes('serverResponse:thread/list'));
    assert.deepEqual(got.slice(0, 3), ['clientRequest:initialize', 'serverResponse:initialize', 'clientNotification:initialized']);
    assert.ok(got.indexOf('serverNotification:thread/started') < got.indexOf('clientRequest:thread/list'), 'replay precedes live traffic, in order');
    const late = []; mod.observe({}, (m, info) => late.push(info?.method));
    await h.app.request(3, 'thread/list', {});
    await until(() => late.includes('thread/list'));
    assert.ok(!late.includes('initialize'), 'no replay without the option');
  } finally { await h.close(); }
});

test('R8 observation: the boot ring keeps only the last 4 MiB (unit)', () => {
  const ring = createRing();
  const line = JSON.stringify({ method: 'm', params: { pad: 'x'.repeat(1024 * 1024 - 40) } });
  for (let i = 0; i < 10; i++) ring.add({ kind: 'serverNotification', method: 'm', origin: 'app', backendId: 'primary' }, line.replace('"m"', `"m${i}"`));
  assert.ok(ring.bytes <= 4 * 1024 * 1024);
  const snap = ring.snapshot();
  assert.equal(snap.length, 4);
  assert.match(snap.at(-1).line, /"m9"/);
  assert.match(snap[0].line, /"m6"/);
  ring.clear(); assert.equal(ring.bytes, 0);
});

test('R8 observation: the boot ring keeps a secret-bearing frame in order but never its content', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.app.request(1, 'account/login/start', { type: 'apiKey', apiKey: 'sk-test-secret-value' }).catch(() => {});
    await h.app.request(2, 'thread/list', {});
    const mod = h.mux.client(A);
    const got = [];
    mod.observe({}, (m, info) => got.push({ method: info?.method, kind: info?.kind, m }), { replay: 'boot' });
    await until(() => got.some((g) => g.method === 'thread/list' && g.kind === 'serverResponse'));
    const secret = got.filter((g) => g.method === 'account/login/start');
    assert.ok(secret.length >= 1, 'the frame keeps its place in the replay');
    for (const g of secret) assert.deepEqual(Object.keys(g.m).sort(), g.m.id === undefined ? ['method', 'redacted'] : ['id', 'method', 'redacted']);
    assert.ok(!JSON.stringify(got).includes('sk-test-secret-value'), 'no secret in the replay');
    assert.ok(got.findIndex((g) => g.method === 'account/login/start') < got.findIndex((g) => g.method === 'thread/list'), 'order is kept');
  } finally { await h.close(); }
});

test('R8 observation: a new app session starts a fresh boot ring', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.app.request(1, 'echo/FIRST-SESSION', {});
    const first = h.app;
    first.end();
    await until(() => h.mux.metrics().backends.find((b) => b.key === 'primary').state === 'stopped', 12000, 'primary stopped');
    const { makeApp } = await import('./helpers.mjs');
    const second = makeApp();
    h.mux.attachApp(second.stream);
    await second.handshake();
    const mod = h.mux.client(A);
    const got = [];
    mod.observe({}, (m, info) => got.push(info?.method), { replay: 'boot' });
    await sleep(60);
    assert.ok(got.includes('initialize'));
    assert.ok(!got.includes('echo/FIRST-SESSION'));
    second.destroy();
  } finally { await h.close(); }
});

test('R8 observation: backend names are local for the owner and qualified for others', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const a = h.mux.client(A), b = h.mux.client(B);
    const ga = [], gb = [];
    a.observe({ methods: ['thread/started'] }, (m, i) => ga.push(i.backend));
    b.observe({ methods: ['thread/started'] }, (m, i) => gb.push(i.backend));
    await a.request('thread/start', {}, { backend: 'x' });
    await until(() => ga.length && gb.length);
    assert.deepEqual([ga[0], gb[0]], ['x', 'mod:a/x']);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R9 permissions
test('R9 permissions: operations outside allowedMethods throw Denied; absent means all allowed', async () => {
  const h = await harness();
  try {
    await h.up();
    const open = h.mux.client(B);
    assert.ok(await open.request('echo/anything', {}));
    open.observe({ methods: '*' }, () => {});
    open.intercept('clientRequest', '*', () => {});

    const mod = h.mux.client(A, { allowedMethods: { request: ['thread/', 'echo/ok'], observe: ['thread/started'], intercept: ['turn/start'] } });
    assert.ok(await mod.request('thread/list', {}));
    assert.ok(await mod.request('echo/ok', {}));
    await assert.rejects(mod.request('echo/nope', {}), { code: 'Denied' });
    assert.throws(() => mod.notify('echo/nope', {}), { code: 'Denied' });
    assert.doesNotThrow(() => mod.notify('thread/x', {}));
    assert.throws(() => mod.observe({ methods: '*' }, () => {}), { code: 'Denied' });
    assert.throws(() => mod.observe({}, () => {}), { code: 'Denied' }, 'default methods is *');
    assert.throws(() => mod.observe({ methods: ['turn/started'] }, () => {}), { code: 'Denied' });
    assert.doesNotThrow(() => mod.observe({ methods: ['thread/started'] }, () => {}));
    assert.throws(() => mod.intercept('clientRequest', '*', () => {}), { code: 'Denied' });
    assert.throws(() => mod.intercept('clientRequest', ['thread/start'], () => {}), { code: 'Denied' });
    assert.doesNotThrow(() => mod.intercept('clientRequest', ['turn/start'], () => {}));

    const wild = h.mux.client('mod:wild', { allowedMethods: { observe: '*' } });
    assert.doesNotThrow(() => wild.observe({}, () => {}));
    assert.ok(await wild.request('echo/x', {}), 'unlisted operation categories stay open');
  } finally { await h.close(); }
});

test('R9 permissions: a disposed client throws Disposed', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    await mod.dispose();
    await assert.rejects(mod.request('echo/x', {}), { code: 'Disposed' });
    assert.throws(() => mod.notify('x', {}), { code: 'Disposed' });
    assert.throws(() => mod.observe({}, () => {}), { code: 'Disposed' });
    const fresh = h.mux.client(A);
    assert.ok(await fresh.request('echo/x', {}));
  } finally { await h.close(); }
});
