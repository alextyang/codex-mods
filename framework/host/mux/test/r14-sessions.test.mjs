// v1.2: the app opens several concurrent connections; each is its own app session (own primary, handshake, boot ring, id space).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeApp, fakeLaunch, leaseConnect, until, sleep } from './helpers.mjs';

const A = 'mod:a';
const received = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

/** Two sessions; backends are named s1, s2 in launch order so their thread ids differ. */
async function twoSessions(o = {}) {
  let n = 0;
  const starts = [];
  const h = await harness({
    ...o,
    launchFor: (id, def) => {
      if (id !== 'primary') return fakeLaunch(h.dir)(id, def);
      const l = fakeLaunch(h.dir)('x/s' + (++n), def);
      starts.push(n);
      return l;
    },
  });
  const app1 = h.app, app2 = makeApp();
  h.mux.attachApp(app1.stream);
  await app1.handshake({ client: 'one' });
  await until(() => h.bus.count('appServer/ready') === 1);
  h.mux.attachApp(app2.stream);
  await app2.handshake({ client: 'two' });
  await until(() => h.bus.count('appServer/ready') === 2);
  return { h, app1, app2, starts };
}

test('R14 sessions: two concurrent connections each initialize and start threads independently with the same app ids', async () => {
  const { h, app1, app2, starts } = await twoSessions();
  try {
    assert.deepEqual(starts, [1, 2], 'launchFor("primary") once per session');
    const [t1, t2] = await Promise.all([app1.request(7, 'thread/start', {}), app2.request(7, 'thread/start', {})]);
    assert.equal(t1.result.thread.id, 'thr-s1-1');
    assert.equal(t2.result.thread.id, 'thr-s2-1');
    assert.ok(received(h, 's1').some((m) => m.method === 'thread/start'));
    const hs1 = received(h, 's1').find((m) => m.method === 'initialize'), hs2 = received(h, 's2').find((m) => m.method === 'initialize');
    assert.deepEqual([hs1.params, hs2.params], [{ client: 'one' }, { client: 'two' }], 'each session keeps its own handshake');
    assert.equal(received(h, 's1').filter((m) => m.method === 'thread/start').length, 1);
    assert.equal(received(h, 's2').filter((m) => m.method === 'thread/start').length, 1);
  } finally { await h.close(); }
});

test('R14 sessions: notifications and server requests for a session\'s thread reach only that session', async () => {
  const { h, app1, app2 } = await twoSessions();
  try {
    const t1 = (await app1.request(1, 'thread/start', {})).result.thread.id;
    const t2 = (await app2.request(1, 'thread/start', {})).result.thread.id;
    await app1.request(2, 'turn/start', { threadId: t1 });
    await app2.request(2, 'turn/start', { threadId: t2 });
    await until(() => app1.inbox.some((m) => m.method === 'turn/completed') && app2.inbox.some((m) => m.method === 'turn/completed'));
    assert.ok(app1.inbox.filter((m) => m.params?.threadId).every((m) => m.params.threadId === t1));
    assert.ok(app2.inbox.filter((m) => m.params?.threadId).every((m) => m.params.threadId === t2));
    // Server requests (rewritten ids) go to the owning session and the answer returns to the right backend.
    app2.send({ id: 3, method: 'fake/serverRequest', params: { method: 'item/approve', params: { threadId: t2 }, threadId: t2 } });
    const ask = await app2.waitFor((m) => m.method === 'item/approve');
    assert.match(ask.id, /^s:\d+$/);
    assert.ok(!app1.inbox.some((m) => m.method === 'item/approve'));
    app2.send({ id: ask.id, result: { ok: 2 } });
    assert.deepEqual((await app2.reply(3)).result.answer.result, { ok: 2 });
    // Unkeyed notifications from a session's backend go to that session only.
    await app1.request(4, 'fake/notify', { method: 'global/tick', params: {} });
    await app1.waitFor((m) => m.method === 'global/tick');
    await sleep(60);
    assert.ok(!app2.inbox.some((m) => m.method === 'global/tick'));
  } finally { await h.close(); }
});

test('R14 sessions: a mod request defaults to the oldest session; closing the oldest moves the default to the next', async () => {
  const { h, app1, app2 } = await twoSessions();
  try {
    const mod = h.mux.client(A);
    assert.equal((await mod.request('thread/start', {})).thread.id, 'thr-s1-1');
    assert.equal((await mod.request('thread/start', {}, { backend: 'primary' })).thread.id, 'thr-s1-2');
    assert.deepEqual(h.mux.metrics().backends.map((b) => b.key), ['primary', 'primary:2']);
    app1.end();
    await until(() => h.bus.count('appServer/exited') === 1, 12000, 'session 1 stopped');
    assert.equal((await mod.request('thread/start', {})).thread.id, 'thr-s2-1', 'the default is now the next session');
    assert.deepEqual(h.mux.metrics().backends.map((b) => b.key), ['primary']);
    // Session 2 was not reset.
    assert.equal((await app2.request(9, 'thread/start', {})).result.thread.id, 'thr-s2-2');
  } finally { await h.close(); }
});

test('R14 sessions: lease initialize is answered from the oldest session\'s cached handshake', async () => {
  const { h } = await twoSessions();
  try {
    const lease = h.mux.issueLease(A, 'svc');
    let c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    assert.equal((await c.request('i', 'initialize', {})).result.userAgent, 'fake/s1');
    const t = (await c.request(2, 'thread/start', {})).result.thread.id;
    assert.equal(t, 'thr-s1-1', 'a lease default is the oldest session');
    c.destroy();
    h.app.end();
    await until(() => h.bus.count('appServer/exited') === 1, 12000);
    c = await leaseConnect(h.sock, lease);
    await c.waitFor((m) => m.ok);
    assert.equal((await c.request('i', 'initialize', {})).result.userAgent, 'fake/s2');
    c.destroy();
  } finally { await h.close(); }
});

test('R14 sessions: closing a session releases its keys to the oldest live session and resets nothing else', async () => {
  const { h, app1, app2 } = await twoSessions();
  try {
    const t2 = (await app2.request(1, 'thread/start', {})).result.thread.id;
    app2.end();
    await until(() => h.bus.count('appServer/exited') === 1, 12000, 'session 2 stopped');
    // The key is unowned and its backend is gone: requests for it follow the oldest live session.
    await app1.request(5, 'turn/start', { threadId: t2 });
    assert.ok(received(h, 's1').some((m) => m.method === 'turn/start' && m.params.threadId === t2));
    assert.equal(h.bus.count('appServer/exited'), 1, 'session 1 was untouched');
    assert.equal((await app1.request(6, 'thread/start', {})).result.thread.id, 'thr-s1-1');
  } finally { await h.close(); }
});

test('R14 sessions: beforePrimaryStart is evaluated per session; interceptors and observers see every session as origin "app" on backend "primary"', async () => {
  let checks = 0;
  const { h, app1, app2 } = await twoSessions({ beforePrimaryStart: async () => { checks++; return false; } });
  try {
    assert.equal(checks, 2);
    const mod = h.mux.client(A);
    const seen = [], obs = [];
    mod.intercept('clientRequest', ['thread/start'], (m, info) => { seen.push([info.origin, info.backend]); });
    mod.observe({ kinds: ['clientRequest'], methods: ['thread/start'] }, (m, info) => obs.push([info.origin, info.backend]));
    await app1.request(1, 'thread/start', {});
    await app2.request(1, 'thread/start', {});
    await until(() => obs.length === 2);
    assert.deepEqual(seen, [['app', 'primary'], ['app', 'primary']]);
    assert.deepEqual(obs, [['app', 'primary'], ['app', 'primary']]);
  } finally { await h.close(); }
});

test('R14 sessions: interceptors and observers see which session a frame belongs to, with its clientInfo name (mux addition 6)', async () => {
  let n = 0;
  const h = await harness({ launchFor: (id, def) => fakeLaunch(h.dir)(id === 'primary' ? 'x/s' + (++n) : id, def) });
  const app1 = h.app, app2 = makeApp();
  try {
    h.mux.attachApp(app1.stream);
    await app1.handshake({ clientInfo: { name: 'codex_desktop' } });
    await until(() => h.bus.count('appServer/ready') === 1);
    h.mux.attachApp(app2.stream);
    await app2.handshake({ clientInfo: { name: 'latex_preview' } });
    await until(() => h.bus.count('appServer/ready') === 2);
    const mod = h.mux.client(A);
    const seen = [], obs = [];
    mod.intercept('clientRequest', ['thread/start'], (m, info) => { seen.push(info.session); });
    mod.observe({ kinds: ['clientRequest', 'serverResponse'], methods: ['thread/start'] }, (m, info) => obs.push([info.kind, info.session]));
    await app1.request(1, 'thread/start', {});
    await app2.request(1, 'thread/start', {});
    await until(() => obs.length === 4);
    assert.deepEqual(seen, [{ id: 1, client: 'codex_desktop' }, { id: 2, client: 'latex_preview' }]);
    assert.deepEqual(obs.filter(([k]) => k === 'serverResponse').map(([, s]) => s), [{ id: 1, client: 'codex_desktop' }, { id: 2, client: 'latex_preview' }]);
    assert.ok(Object.isFrozen(seen[0]));
  } finally { await h.close(); }
});

test('R14 sessions: a refused session (stock-app guard) does not affect the others', async () => {
  let calls = 0;
  const h = await harness({ beforePrimaryStart: async () => ++calls === 2 });
  try {
    await h.up();
    const second = makeApp();
    h.mux.attachApp(second.stream);
    second.send({ id: 1, method: 'initialize', params: {} });
    await until(() => second.stream.destroyed, 12000, 'second session refused');
    assert.equal((await h.app.request(1, 'echo/x')).result.echo.method, 'echo/x');
  } finally { await h.close(); }
});

test('R14 sessions: each session has its own boot ring (replay boot delivers each session\'s handshake)', async () => {
  const { h } = await twoSessions();
  try {
    const mod = h.mux.client(A);
    const got = [];
    mod.observe({ kinds: ['clientRequest'], methods: ['initialize'] }, (m) => got.push(m.params.client), { replay: 'boot' });
    await until(() => got.length === 2);
    assert.deepEqual(got, ['one', 'two']);
  } finally { await h.close(); }
});

test('R14 sessions: a mod request waits for the first session when none is connected yet', async () => {
  const h = await harness();
  try {
    const mod = h.mux.client(A);
    const early = mod.request('thread/start', {});
    await sleep(80);
    h.attach(); await h.app.handshake();
    assert.equal((await early).thread.id, 'thr-primary-1');
  } finally { await h.close(); }
});
