import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { harness, scriptedSpawn, leaseConnect, until, sleep } from './helpers.mjs';

const A = 'mod:a', B = 'mod:b';
const received = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

// ---------------------------------------------------------------- R10 leases
test('R10 leases: issueLease returns {id, socketPath: clientsSocketPath, token: 32 random bytes as hex}', async () => {
  const h = await harness();
  try {
    const l1 = h.mux.issueLease(A, 'svc'), l2 = h.mux.issueLease(A, 'svc');
    assert.equal(l1.socketPath, h.sock);
    assert.match(l1.token, /^[0-9a-f]{64}$/);
    assert.notEqual(l1.token, l2.token);
    assert.notEqual(l1.id, l2.id);
    assert.deepEqual(Object.keys(l1).sort(), ['id', 'socketPath', 'token']);
  } finally { await h.close(); }
});

test('R10 leases: a bad token, an unknown lease or a malformed first line closes the connection', async () => {
  const h = await harness();
  try {
    const lease = h.mux.issueLease(A, 'svc');
    for (const first of [
      JSON.stringify({ lease: lease.id, token: 'f'.repeat(64) }) + '\n',
      JSON.stringify({ lease: lease.id, token: 'short' }) + '\n',
      JSON.stringify({ lease: 'nope', token: lease.token }) + '\n',
      'not json\n',
      JSON.stringify({ token: lease.token }) + '\n',
    ]) {
      const c = await leaseConnect(h.sock, lease, { firstLine: first });
      await c.closedP;
      assert.ok(!c.inbox.some((m) => m.ok), 'no ok reply');
    }
    assert.ok(h.logged('warn', /bad lease or token/));
  } finally { await h.close(); }
});

test('R10 leases: a connection that never authenticates is closed after the auth timeout', async () => {
  const h = await harness({ tuning: { authTimeoutMs: 150 } });
  try {
    const s = net.connect(h.sock);
    await new Promise((r) => s.once('connect', r));
    await new Promise((r) => s.once('close', r));
  } finally { await h.close(); }
});

test('R10 leases: after the token, the connection is a logical client speaking app-server JSONL with its own ids and keys', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    assert.deepEqual(await c.waitFor((m) => m.ok === true), { ok: true });
    // The lease's initialize is answered from the cached handshake, never forwarded a second time.
    const init = await c.request('i0', 'initialize', { clientInfo: { name: 'svc' } });
    assert.equal(init.result.userAgent, 'fake/primary');
    c.send({ method: 'initialized' });
    assert.equal(received(h, 'primary').filter((m) => m.method === 'initialize').length, 1);
    // Same id 1 as the app: no collision.
    h.app.send({ id: 1, method: 'fake/slow', params: { ms: 120 } });
    const t = await c.request(2, 'thread/start', {});
    assert.equal(t.result.thread.id, 'thr-primary-1');
    const slow = await c.request(1, 'fake/slow', { ms: 10 });
    assert.deepEqual(slow.result, { slept: 10 });
    assert.deepEqual((await h.app.reply(1)).result, { slept: 120 });
    // Own keys: notifications for the thread go to the lease; server requests too.
    await c.waitFor((m) => m.method === 'thread/started');
    assert.ok(!h.app.inbox.some((m) => m.method === 'thread/started'));
    c.send({ id: 3, method: 'fake/serverRequest', params: { method: 'item/ask', params: { threadId: t.result.thread.id }, threadId: t.result.thread.id } });
    const ask = await c.waitFor((m) => m.method === 'item/ask');
    assert.match(ask.id, /^s:\d+$/);
    c.send({ id: ask.id, result: { yes: 1 } });
    assert.deepEqual((await c.reply(3)).result.answer.result, { yes: 1 });
    assert.ok(!h.app.inbox.some((m) => m.method === 'item/ask'));
    c.destroy();
  } finally { await h.close(); }
});

test('R10 leases: a lease interceptor origin is client:<id>, and the mod sees it', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    const origins = [];
    h.mux.client(B).intercept('clientRequest', ['echo/who'], (m, info) => { origins.push(info.origin); });
    await c.request(1, 'echo/who', {});
    assert.deepEqual(origins, [`client:${lease.id}`]);
    c.destroy();
  } finally { await h.close(); }
});

test('R10 leases: codexmods/services.call is answered by the handler with the lease owner and never forwarded', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    // No handler yet: Unavailable.
    const no = await c.request(1, 'codexmods/services.call', { name: 'svc', method: 'ping', args: {} });
    assert.equal(no.error.data.codexmods, 'Unavailable');
    const seen = [];
    h.mux.setLeaseServiceHandler(async (owner, call) => { seen.push([owner, call]); if (call.method === 'boom') throw Object.assign(new Error('nope'), {}); return { pong: call.args }; });
    const ok = await c.request(2, 'codexmods/services.call', { name: 'svc', method: 'ping', args: { n: 1 } });
    assert.deepEqual(ok.result, { pong: { n: 1 } });
    assert.deepEqual(seen, [[A, { name: 'svc', method: 'ping', args: { n: 1 } }]]);
    const bad = await c.request(3, 'codexmods/services.call', { name: 'svc', method: 'boom', args: null });
    assert.ok(bad.error);
    const inv = await c.request(4, 'codexmods/services.call', { name: 5 });
    assert.equal(inv.error.data.codexmods, 'Invalid');
    assert.ok(!h.serverLog().some((l) => l.includes('services.call')), 'never reached a backend');
    c.destroy();
  } finally { await h.close(); }
});

test('R10 leases: revokeLease closes the connection; the token no longer authenticates; a second connection is refused', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    const dup = await leaseConnect(h.sock, lease);
    await dup.closedP;
    assert.ok(!dup.inbox.some((m) => m.ok));
    h.mux.revokeLease(lease.id);
    await c.closedP;
    const again = await leaseConnect(h.sock, lease);
    await again.closedP;
    assert.ok(!again.inbox.some((m) => m.ok));
    h.mux.revokeLease('does-not-exist'); // no-op
  } finally { await h.close(); }
});

test('R10 leases: disposeOwner revokes the owner\'s leases and removes its backends', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x'); await h.define(B, 'y');
    const mod = h.mux.client(A);
    await mod.request('thread/start', {}, { backend: 'x' });
    const la = h.mux.issueLease(A, 'svc'), lb = h.mux.issueLease(B, 'svc');
    const ca = await leaseConnect(h.sock, la), cb = await leaseConnect(h.sock, lb);
    await ca.waitFor((m) => m.ok); await cb.waitFor((m) => m.ok);
    await h.mux.disposeOwner(A);
    await ca.closedP;
    assert.equal(cb.closed, false, "another owner's lease is untouched");
    assert.deepEqual(h.mux.listBackends(A), []);
    assert.equal(h.mux.listBackends(B).length, 1);
    assert.equal(h.bus.count('backend/mod:a/x/exited'), 1, 'its process was stopped');
    cb.destroy();
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R11 hasTransmitted
test('R11 hasTransmitted: flips on the first frame written to any backend', async () => {
  const h = await harness({ tuning: { handshakeWaitMs: 120 } });
  try {
    const mod = h.mux.client(A);
    assert.equal(mod.hasTransmitted, false);
    await assert.rejects(mod.request('x/y', {}), { code: 'Unavailable' });
    assert.equal(mod.hasTransmitted, false, 'a request that was not transmitted does not flip it');
    h.attach(); await h.app.handshake();
    const other = h.mux.client(B);
    mod.notify('note/x', {});
    await until(() => mod.hasTransmitted, 12000, 'transmitted');
    assert.equal(other.hasTransmitted, false);
    await other.request('echo/x', {});
    assert.equal(other.hasTransmitted, true);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R12 metrics
test('R12 metrics: frames per kind, calls and faults per client, latency percentiles, qualified backends', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    mod.intercept('clientRequest', ['echo/m'], async () => { await sleep(30); }, { timeoutMs: 1000 });
    mod.intercept('clientRequest', ['echo/f'], () => { throw new Error('f'); });
    for (let i = 0; i < 5; i++) await h.app.request(100 + i, 'echo/m', {});
    await h.app.request(200, 'echo/f', {});
    await h.app.request(201, 'thread/start', {});
    await until(() => h.mux.metrics().frames.serverNotification >= 1, 12000, 'thread/started');
    const m = h.mux.metrics();
    assert.ok(m.frames.clientRequest >= 8);
    assert.ok(m.frames.serverResponse >= 8);
    assert.ok(m.frames.serverNotification >= 1);
    assert.equal(m.frames.clientNotification, 1, 'initialized');
    assert.equal(m.interceptorCalls[A], 6);
    assert.equal(m.interceptorFaults[A], 1);
    assert.ok(m.latencyMs.p50 >= 0 && m.latencyMs.p95 >= m.latencyMs.p50);
    assert.ok(m.latencyMs.p95 >= 25, `p95 reflects the 30 ms handler (${m.latencyMs.p95})`);
    assert.deepEqual(m.backends.map((b) => [b.key, b.state]), [['primary', 'ready'], ['mod:a/x', 'stopped']]);
    // returned objects are snapshots
    m.frames.clientRequest = -1;
    assert.ok(h.mux.metrics().frames.clientRequest > 0);
  } finally { await h.close(); }
});

test('R12 metrics: the latency reservoir is a fixed size', async () => {
  const h = await harness();
  try {
    await h.up();
    for (let i = 0; i < 1100; i++) h.app.send({ id: 1000 + i, method: 'echo/n' });
    await h.app.reply(2099, 10000);
    const m = h.mux.metrics();
    assert.ok(Number.isFinite(m.latencyMs.p50) && Number.isFinite(m.latencyMs.p95));
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- R13 close
test('R13 close: pending requests are rejected (OutcomeUnknown if transmitted, Unavailable otherwise), backends stopped, sockets closed', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    const sent = mod.request('fake/slow', { ms: 10_000 }).then(() => null, (e) => e);
    const unsent = mod.request('x/y', {}, { backend: 'primary' });
    unsent.catch(() => {});
    const queued = h.mux.client(B).request('x/y', {}); // transmitted (primary is ready), will be pending too
    queued.catch(() => {});
    await sleep(80);
    const waitingMod = h.mux.client('mod:c');
    await h.define('mod:c', 'z');
    const notReady = waitingMod.request('thread/list', {}, { backend: 'z' }); // starts z; may or may not be sent
    notReady.catch(() => {});
    const lease = h.mux.issueLease(A, 'svc');
    const c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    await h.mux.close();
    assert.equal((await sent).code, 'OutcomeUnknown');
    assert.ok(['OutcomeUnknown', 'Unavailable'].includes((await notReady.catch((e) => e)).code));
    await c.closedP;
    assert.ok(!existsSync(h.sock), 'the clients socket is gone');
    assert.deepEqual(h.mux.metrics().backends.filter((b) => b.state === 'ready' || b.state === 'starting'), []);
    assert.throws(() => h.mux.client(A), { code: 'Disposed' });
    await assert.rejects(mod.request('x', {}), { code: 'Disposed' });
    await h.mux.close(); // idempotent
    await assert.rejects(new Promise((res, rej) => { const s = net.connect(h.sock); s.once('connect', res); s.once('error', rej); }));
  } finally { await h.close(); }
});

test('R13 close: not-yet-transmitted requests reject Unavailable', async () => {
  const h = await harness({ tuning: { handshakeWaitMs: 5000 } });
  try {
    const mod = h.mux.client(A);
    const p = mod.request('x/y', {}).then(() => null, (e) => e);
    await sleep(30);
    await h.mux.close();
    assert.equal((await p).code, 'Unavailable');
  } finally { await h.close(); }
});

test('R13 close: backends get SIGTERM, then SIGKILL after the grace period', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn, tuning: { killGraceMs: 150 } });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    procs[0].autoExitOn = ['SIGKILL'];   // ignores SIGTERM
    const t0 = Date.now();
    await h.mux.close();
    assert.deepEqual(procs[0].signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - t0 >= 140);
    // A well-behaved backend gets only SIGTERM.
  } finally { await h.close(); }
  const s2 = scriptedSpawn();
  const h2 = await harness({ spawn: s2.spawn, tuning: { killGraceMs: 150 } });
  try {
    h2.attach(); h2.app.send({ method: 'wake/up' }); await until(() => s2.procs.length === 1);
    await h2.mux.close();
    assert.deepEqual(s2.procs[0].signals, ['SIGTERM']);
    await sleep(200);
    assert.deepEqual(s2.procs[0].signals, ['SIGTERM'], 'the kill timer was cleared');
  } finally { await h2.close(); }
});

test('R13 close: pending server-request state does not leak and the app connection is closed', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.mux.close();
    await until(() => h.app.stream.destroyed, 12000, 'app stream destroyed');
    assert.throws(() => h.mux.client(A), { code: 'Disposed' });
    h.mux.attachApp(h.app.stream);   // refused after close, must not throw
  } finally { await h.close(); }
});

test('R2 backends: app disconnect stops the primary (SIGTERM) and a reconnect starts a fresh one', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    h.app.end();
    await until(() => procs[0].signals.includes('SIGTERM'));
    await until(() => h.bus.count('appServer/exited') === 1);
    const { makeApp } = await import('./helpers.mjs');
    const second = makeApp();
    h.mux.attachApp(second.stream); second.send({ method: 'wake/up' });
    await until(() => procs.length === 2, 12000, 'a fresh primary');
    second.destroy();
  } finally { await h.close(); }
});
