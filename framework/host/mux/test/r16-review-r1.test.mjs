// Review findings #12, #13, #14, #21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, leaseConnect, until, sleep } from './helpers.mjs';

const A = 'mod:a', B = 'mod:b';

test('R16 #12: the per-backend server queue is bounded; a hung interceptor plus a flood pauses stdout, drops nothing and resumes', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn, tuning: { queueMaxItems: 100 } });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    const mod = h.mux.client(A);
    let release; const gate = new Promise((r) => { release = r; });
    mod.intercept('serverNotification', ['flood/'], (m) => (m.params.n === 0 ? gate : undefined), { timeoutMs: 30_000 });
    const batch = (from) => Array.from({ length: 50 }, (_, i) => ({ method: 'flood/n', params: { n: from + i } }));
    for (let b = 0; b < 20; b++) procs[0].outMany(batch(b * 50));
    await until(() => procs[0].stdout.isPaused(), 5000, 'stdout paused');
    await sleep(100);
    const seen = h.mux.metrics().frames.serverNotification;
    assert.ok(seen <= 100 + 50 + 1, `the mux stopped reading (${seen} of 1000 frames consumed)`);
    assert.ok(h.logged('warn', /server queue is full/));
    assert.equal(h.app.inbox.filter((m) => m.method === 'flood/n').length, 0, 'the held notification holds the rest');
    release();
    await until(() => h.app.inbox.filter((m) => m.method === 'flood/n').length === 1000, 15000, 'all 1000 delivered');
    assert.deepEqual(h.app.inbox.filter((m) => m.method === 'flood/n').map((m) => m.params.n), Array.from({ length: 1000 }, (_, i) => i), 'in order, none dropped');
    assert.equal(procs[0].stdout.isPaused(), false, 'reading resumed');
  } finally { await h.close(); }
});

test('R16 #13: a request rewritten into thread/start records affinity under the effective method', async () => {
  const h = await harness();
  try {
    await h.up();
    const mod = h.mux.client(A);
    const seen = [];
    mod.intercept('clientRequest', ['legacy/start'], (m) => ({ replace: { ...m, method: 'thread/start' } }));
    mod.intercept('serverResponse', ['thread/start'], (m, info) => { seen.push(info.method); });
    const obs = [];
    mod.observe({ kinds: ['serverResponse'], methods: ['thread/start'] }, (m, info) => obs.push(info.method));
    const r = await h.app.request(1, 'legacy/start', {});
    const t = r.result.thread.id;
    assert.deepEqual(seen, ['thread/start'], 'response interceptors see the effective method');
    await until(() => obs.length === 1);
    // Ownership was recorded for the app session: a mod notification on that key for the thread does not reach... the app owns it, so it does.
    await mod.request('fake/notify', { method: 'thread/ping', params: { threadId: t }, threadId: t });
    await h.app.waitFor((m) => m.method === 'thread/ping');
    // And the key is pinned: a later request for the thread routes via affinity (primary here), not by default alone.
    const other = h.mux.client(B);
    await other.request('fake/notify', { method: 'thread/ping2', params: { threadId: t }, threadId: t });
    await h.app.waitFor((m) => m.method === 'thread/ping2');
  } finally { await h.close(); }
});

test('R16 #13: a rewritten request to thread/start by a mod makes that mod the owner', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    b.intercept('clientRequest', ['legacy/start'], (m) => ({ replace: { ...m, method: 'thread/start' } }));
    const t = (await a.request('legacy/start', {})).thread.id;
    await a.request('fake/notify', { method: 'thread/mine', params: { threadId: t }, threadId: t });
    await sleep(80);
    assert.ok(!h.app.inbox.some((m) => m.method === 'thread/mine'), 'the creator (mod a) owns the key; the app does not see it');
  } finally { await h.close(); }
});

test('R16 #14: a notification held by an interceptor is not transmitted after its client is disposed', async () => {
  const h = await harness();
  try {
    await h.up();
    const a = h.mux.client(A), b = h.mux.client(B);
    let release; const gate = new Promise((r) => { release = r; });
    b.intercept('clientNotification', ['note/held'], () => gate, { timeoutMs: 30_000 });
    a.notify('note/held', { x: 1 });
    await sleep(50);
    await a.dispose();
    release();
    await sleep(150);
    assert.ok(!h.serverLog().some((l) => l.includes('note/held')), 'nothing was transmitted');
    assert.equal(a.hasTransmitted, false);
  } finally { await h.close(); }
});

test('R16 #14: a notification waiting for the backend is cancelled by dispose', async () => {
  const h = await harness();
  try {
    const a = h.mux.client(A);
    a.notify('note/early', {});              // no app yet: waits for a session
    await sleep(30);
    await a.dispose();
    h.attach(); await h.app.handshake();
    await sleep(100);
    assert.ok(!h.serverLog().some((l) => l.includes('note/early')));
  } finally { await h.close(); }
});

test('R16 #21: a 64-char non-ASCII or non-hex token closes only that connection', async () => {
  const h = await harness();
  try {
    await h.up();
    const lease = h.mux.issueLease(A, 'svc');
    const good = await leaseConnect(h.sock, lease);
    const other = h.mux.issueLease(B, 'svc2');
    await good.waitFor((m) => m.ok);
    for (const token of ['é'.repeat(64), 'A'.repeat(64), 'g'.repeat(64), lease.token.toUpperCase(), lease.token + '0']) {
      const c = await leaseConnect(h.sock, other, { firstLine: JSON.stringify({ lease: other.id, token }) + '\n' });
      await c.closedP;
      assert.ok(!c.inbox.some((m) => m.ok));
    }
    assert.equal(good.closed, false, 'the authenticated connection is untouched');
    assert.deepEqual((await good.request(1, 'echo/alive', {})).result.echo.method, 'echo/alive');
    const ok = await leaseConnect(h.sock, other);
    assert.deepEqual(await ok.waitFor((m) => m.ok === true), { ok: true });
    ok.destroy(); good.destroy();
  } finally { await h.close(); }
});
