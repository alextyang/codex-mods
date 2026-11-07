// Mux additions 11 (routing by subscription) and 4 (union subscription), docs/design/runtime-core.md R12 and R13. Headless: the real mux,
// the strict fake app-server, the app's connection and lease connections.
// Native evidence: realization/proofs/batch-9.md (routing): the app did not follow a thread a lease had started, until it re-read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { harness, leaseConnect, until, sleep } from './helpers.mjs';

const A = 'mod:a';

/** Records every frame the mux writes to a backend. */
function recordingSpawn(written) {
  return (cmd, args, o) => {
    const p = nodeSpawn(cmd, args, o);
    const real = p.stdin.write.bind(p.stdin);
    p.stdin.write = (data, cb) => { try { written.push(JSON.parse(String(data))); } catch { /* not a frame */ } return real(data, cb); };
    return p;
  };
}
async function withHarness(fn, { handshake } = {}) {
  const written = [];
  const h = await harness({ spawn: recordingSpawn(written) });
  try {
    if (handshake) {
      h.attach(); await h.app.handshake(handshake);
      await until(() => h.bus.count('appServer/ready') >= 1, 12000, 'appServer/ready');
    } else await h.up();
    await fn(h, written);
  } finally { await h.close(); }
}
async function lease(h) {
  const c = await leaseConnect(h.sock, h.mux.issueLease(A, 'qa'));
  await c.waitFor((m) => m.ok === true);
  await c.request('init', 'initialize', { clientInfo: { name: 'lease', version: '0' } });
  return c;
}
/** A notification the backend emits for a thread, sent through a lease's fake control call. */
const emit = (c, id, method, threadId) => c.request(id, 'fake/notify', { method, params: { threadId }, threadId });
const got = (inbox, method) => inbox.filter((m) => m.method === method);

test('A11 1: a thread a lease started and the app then resumed: its notifications reach both; its server requests go to the app', async () => {
  await withHarness(async (h) => {
    const c = await lease(h);
    const t = (await c.request(1, 'thread/start', {})).result.thread.id;
    await h.app.request(2, 'thread/resume', { threadId: t });
    await emit(c, 3, 'thread/event', t);
    await h.app.waitFor((m) => m.method === 'thread/event', 5000);
    await c.waitFor((m) => m.method === 'thread/event', 5000);
    // One answerer: the app, where the user can answer the card.
    c.send({ id: 4, method: 'fake/serverRequest', params: { method: 'item/approve', params: { threadId: t } } });
    const ask = await h.app.waitFor((m) => m.method === 'item/approve', 5000);
    h.app.send({ id: ask.id, result: { ok: true } });
    assert.deepEqual((await c.reply(4)).result.answer.result, { ok: true });
    assert.equal(got(c.inbox, 'item/approve').length, 0, 'the lease is not asked');
  });
});

test('A11 2: a thread only a lease is subscribed to: the app and other leases get none of its notifications', async () => {
  await withHarness(async (h) => {
    const c1 = await lease(h), c2 = await lease(h);
    const t = (await c1.request(1, 'thread/start', {})).result.thread.id;
    await emit(c1, 2, 'thread/event', t);
    await c1.waitFor((m) => m.method === 'thread/event', 5000);
    await sleep(100);
    assert.equal(got(h.app.inbox, 'thread/event').length, 0);
    assert.equal(got(c2.inbox, 'thread/event').length, 0);
  });
});

test('A11 3: when the only subscriber disconnects, the thread\'s notifications fall back to the app session', async () => {
  await withHarness(async (h) => {
    const c = await lease(h);
    const t = (await c.request(1, 'thread/start', {})).result.thread.id;
    const ctl = await lease(h);
    c.destroy(); await c.closedP;
    await sleep(50);
    await emit(ctl, 2, 'thread/event', t);
    await h.app.waitFor((m) => m.method === 'thread/event', 5000);
  });
});

test('A11 4: an in-process client\'s subscription keeps the thread with its owner: the app that started it still gets everything', async () => {
  await withHarness(async (h) => {
    const mod = h.mux.client(A);
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    await mod.request('thread/resume', { threadId: t });
    const seen = [];
    mod.observe({ kinds: ['serverNotification'], methods: ['thread/event'] }, (m) => seen.push(m));
    await mod.request('fake/notify', { method: 'thread/event', params: { threadId: t }, threadId: t });
    await h.app.waitFor((m) => m.method === 'thread/event', 5000);
    await until(() => seen.length === 1, 5000, 'observer');
  });
});

test('A4b 1: while another client stays subscribed, the app\'s thread/unsubscribe is answered by the mux and never reaches the backend', async () => {
  await withHarness(async (h, written) => {
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const c = await lease(h);
    await c.request(2, 'thread/resume', { threadId: t });
    const r = await h.app.request(3, 'thread/unsubscribe', { threadId: t });
    assert.deepEqual(r.result, { status: 'unsubscribed' });
    assert.equal(written.filter((m) => m.method === 'thread/unsubscribe').length, 0, 'the backend keeps the subscription');
    await emit(c, 4, 'thread/event', t);
    await c.waitFor((m) => m.method === 'thread/event', 5000);
    await sleep(100);
    assert.equal(got(h.app.inbox, 'thread/event').length, 0, 'the app left the thread');
    // The last subscriber's unsubscribe is forwarded.
    const last = await c.request(5, 'thread/unsubscribe', { threadId: t });
    assert.equal(written.filter((m) => m.method === 'thread/unsubscribe').length, 1);
    assert.ok(['unsubscribed', 'notSubscribed', 'notLoaded'].includes(last.result.status));
  });
});

test('A4b 2: an unsubscribe from a client that was never subscribed, while another is, is answered notSubscribed', async () => {
  await withHarness(async (h, written) => {
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const c = await lease(h);
    const r = await c.request(2, 'thread/unsubscribe', { threadId: t });
    assert.deepEqual(r.result, { status: 'notSubscribed' });
    assert.equal(written.filter((m) => m.method === 'thread/unsubscribe').length, 0);
  });
});

const OPT_OUTS = ['turn/diff/updated', 'codex/event/agent_message', 'thread/compacted'];
test('A4a: the app\'s opt-outs the runtime needs are sent upstream opted in, dropped on delivery to the app, and seen by observers and other clients', async () => {
  await withHarness(async (h, written) => {
    const init = written.find((m) => m.method === 'initialize');
    assert.deepEqual(init.params.capabilities.optOutNotificationMethods, ['codex/event/agent_message'], 'only the legacy stream stays opted out upstream');
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const c = await lease(h);
    await c.request(2, 'thread/resume', { threadId: t });
    const seen = [];
    h.mux.client(A).observe({ kinds: ['serverNotification'], methods: ['turn/diff/updated'] }, (m) => seen.push(m));
    await emit(c, 3, 'turn/diff/updated', t);
    await c.waitFor((m) => m.method === 'turn/diff/updated', 5000);
    await until(() => seen.length === 1, 5000, 'observer');
    await emit(c, 4, 'thread/event', t);
    await h.app.waitFor((m) => m.method === 'thread/event', 5000);
    assert.equal(got(h.app.inbox, 'turn/diff/updated').length, 0, 'the app opted out of it');
  }, { handshake: { clientInfo: { name: 'test-app', version: '0' }, capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUTS } } });
});

import { createSubscriptions } from '../subscriptions.mjs';
test('the subscription table reports a key opening (first subscriber) and closing (last one gone), whatever removes it', () => {
  const seen = [];
  const s = createSubscriptions({ onChange: (key, open) => seen.push([key, open]) });
  s.add('b\nt1', 'c1'); s.add('b\nt1', 'c2'); s.add('b\nt2', 'c1');
  assert.deepEqual(seen, [['b\nt1', true], ['b\nt2', true]], 'opened once each');
  s.remove('b\nt1', 'c2');
  assert.equal(seen.length, 2, 'c1 still holds t1');
  s.removeClient('c1');
  assert.deepEqual(seen.slice(2).sort(), [['b\nt1', false], ['b\nt2', false]], 'a disconnection closes what it held alone');
  s.add('x\nt3', 'c3');
  s.dropKeys((k) => k.startsWith('x\n'));
  assert.deepEqual(seen.slice(-2), [['x\nt3', true], ['x\nt3', false]], 'a backend restart closes its keys');
  assert.equal(s.remove('b\nt9', 'c9'), false);
});
