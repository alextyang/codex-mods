import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, fakeLaunch, until, sleep } from './helpers.mjs';

const A = 'mod:a', B = 'mod:b';

test('R2 backends: the session primary starts on its first frame through launchFor("primary")', async () => {
  const calls = [];
  const h = await harness({ launchFor: (id, def) => { calls.push(id); return fakeLaunch(h.dir)(id, def); } });
  try {
    await sleep(80);
    assert.deepEqual(calls, [], 'nothing starts before the app connects');
    h.attach();
    await sleep(80);
    assert.deepEqual(calls, [], 'an idle connection costs no process');
    await h.app.handshake();
    await until(() => h.bus.count('appServer/ready') === 1);
    assert.deepEqual(calls, ['primary']);
    assert.equal(h.bus.count('appServer/starting'), 1);
    assert.equal(h.bus.count('appServer/ready'), 1);
  } finally { await h.close(); }
});

test('R2 backends: the primary starts only after beforePrimaryStart resolves false', async () => {
  const calls = []; let release;
  const gate = new Promise((r) => { release = r; });
  const h = await harness({ beforePrimaryStart: () => gate, launchFor: (id, def) => { calls.push(id); return fakeLaunch(h.dir)(id, def); } });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await sleep(100);
    assert.deepEqual(calls, [], 'still gated');
    release(false);
    await h.app.handshake();
    assert.deepEqual(calls, ['primary']);
  } finally { await h.close(); }
});

test('R2 backends: beforePrimaryStart resolving true closes the app connection and logs the reason', async () => {
  const calls = [];
  const h = await harness({ beforePrimaryStart: async () => true, launchFor: (id, def) => { calls.push(id); return fakeLaunch(h.dir)(id, def); } });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => h.app.stream.destroyed, 12000, 'app connection closed');
    assert.deepEqual(calls, []);
    assert.ok(h.logged('error', /app connection refused: beforePrimaryStart reported a conflict/));
  } finally { await h.close(); }
});

test('R2 backends: named backends are lazy, use local keys for the owner and qualified keys for others, and get CODEX_HOME', async () => {
  const { spawn, procs } = scriptedSpawn();
  const calls = [];
  const h = await harness({ spawn, launchFor: (id, def) => { calls.push({ id, def }); return { command: 'fake', args: ['app-server'], env: { E: '1' }, codexHome: def?.codexHome ?? '/primary-home' }; } });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    procs[0].written.length = 0;
    await h.define(A, 'work', { codexHome: '/homes/work' });
    assert.deepEqual(h.mux.listBackends(A), [{ key: 'work', owner: A, state: 'stopped' }]);
    assert.deepEqual(h.mux.listBackends(B), []);
    assert.ok(h.mux.metrics().backends.some((b) => b.key === 'mod:a/work' && b.owner === A), 'metrics are qualified');
    assert.deepEqual(calls.map((c) => c.id), ['primary'], 'lazy: nothing launched for the named backend yet');

    // The app handshakes, then a mod uses the backend.
    procs[0].written.length = 0;
    h.app.send({ id: 'init', method: 'initialize', params: { p: 1 } });
    await procs[0].waitWritten((m) => m.method === 'initialize');
    const mod = h.mux.client(A);
    const p = mod.request('thread/list', {}, { backend: 'work' });
    await until(() => procs.length === 2, 12000, 'second process');
    assert.equal(calls[1].id, 'mod:a/work');
    assert.equal(calls[1].def.codexHome, '/homes/work');
    assert.equal(procs[1].env.CODEX_HOME, '/homes/work');
    assert.equal(procs[1].env.E, '1');
    const init = await procs[1].waitWritten((m) => m.method === 'initialize');
    procs[1].out({ id: init.id, result: {} });
    const list = await procs[1].waitWritten((m) => m.method === 'thread/list');
    procs[1].out({ id: list.id, result: { data: [] } });
    assert.deepEqual(await p, { data: [] });
    assert.equal(h.mux.listBackends(A)[0].state, 'ready');

    const modB = h.mux.client(B);
    await assert.rejects(modB.request('thread/list', {}, { backend: 'work' }), { code: 'Unavailable' }, "B has no backend named 'work'");
    await assert.rejects(modB.request('thread/list', {}, { backend: 'mod:a/work' }), { code: 'Denied' });
    assert.ok(h.bus.topics().includes('backend/mod:a/work/starting'));
    assert.ok(h.bus.topics().includes('backend/mod:a/work/ready'));
  } finally { await h.close(); }
});

test('R2 backends: a named backend is replayed the app handshake (initialize params, then initialized)', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    await mod.request('thread/list', {}, { backend: 'x' });
    const lines = h.serverLog().filter((l) => l.startsWith('x ')).map((l) => JSON.parse(l.slice(2)));
    assert.equal(lines[0].method, 'initialize');
    assert.deepEqual(lines[0].params, { clientInfo: { name: 'test-app', version: '0' } });
    assert.match(lines[0].id, /^m:\d+$/);
    assert.deepEqual(lines[1], { method: 'initialized' });
    assert.equal(lines[2].method, 'thread/list');
  } finally { await h.close(); }
});

test('R2 backends: named backend idle-stops after idleStopMs and restarts lazily', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x', { idleStopMs: 200 });
    const mod = h.mux.client(A);
    assert.equal((await mod.request('thread/start', {}, { backend: 'x' })).thread.id, 'thr-x-1');
    await until(() => h.mux.listBackends(A)[0].state === 'stopped', 12000, 'idle stop');
    assert.equal(h.bus.count('backend/mod:a/x/exited'), 1);
    assert.equal((await mod.request('thread/start', {}, { backend: 'x' })).thread.id, 'thr-x-1', 'a fresh process counts from 1 again');
  } finally { await h.close(); }
});

test('R2 backends: requests before the handshake wait, then fail Unavailable after the limit', async () => {
  const h = await harness({ tuning: { handshakeWaitMs: 250 } });
  try {
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const t0 = Date.now();
    await assert.rejects(mod.request('thread/list', {}, { backend: 'x' }), { code: 'Unavailable' });
    assert.ok(Date.now() - t0 >= 200, 'it waited');
    await assert.rejects(mod.request('thread/list', {}), { code: 'Unavailable' }, 'primary with no app');
    assert.equal(mod.hasTransmitted, false);
  } finally { await h.close(); }
});

test('R2 backends: requests issued before the handshake are served once it completes', async () => {
  const h = await harness();
  try {
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    const early = mod.request('thread/start', {}, { backend: 'x' });
    const earlyPrimary = mod.request('thread/start', {});
    await sleep(100);
    h.attach(); await h.app.handshake();
    assert.equal((await early).thread.id, 'thr-x-1');
    assert.equal((await earlyPrimary).thread.id, 'thr-primary-1');
  } finally { await h.close(); }
});

test('R2 backends: primary exit publishes appServer/exited, restarts, replays the handshake and publishes ready', async () => {
  const h = await harness({ tuning: { restartIntervalMs: 50 } });
  try {
    await h.up();
    assert.equal((await h.app.request(1, 'thread/start', {})).result.thread.id, 'thr-primary-1');
    h.app.send({ id: 2, method: 'fake/exit', params: { code: 3 } });
    await until(() => h.bus.count('appServer/exited') === 1, 12000, 'exited');
    assert.equal(h.bus.events.find((e) => e.topic === 'appServer/exited').data.code, 3);
    // A request issued while the primary is down waits for the restart.
    const r = await h.app.request(3, 'thread/start', {});
    assert.equal(r.result.thread.id, 'thr-primary-1', 'fresh process');
    assert.equal(h.bus.count('appServer/ready'), 2);
    assert.equal(h.bus.count('appServer/starting'), 2);
    const inits = h.serverLog().filter((l) => l.startsWith('primary ') && l.includes('"method":"initialize"'));
    assert.equal(inits.length, 2, 'handshake replayed to the restarted primary');
    assert.deepEqual(JSON.parse(inits[1].slice(8)).params, { clientInfo: { name: 'test-app', version: '0' } });
    assert.ok(h.serverLog().filter((l) => l.includes('"method":"initialized"')).length >= 2);
  } finally { await h.close(); }
});

test('R2 backends: the primary restarts at most once per interval', async () => {
  const starts = [];
  const h = await harness({ tuning: { restartIntervalMs: 500 }, launchFor: (id, def) => { starts.push(Date.now()); return fakeLaunch(h.dir)(id, def); } });
  try {
    await h.up();
    h.app.send({ id: 2, method: 'fake/exit', params: { code: 1 } });
    await until(() => starts.length === 2, 12000, 'first restart');
    assert.ok(starts[1] - starts[0] >= 450, `first restart waited for the interval (${starts[1] - starts[0]} ms)`);
    await until(() => h.bus.count('appServer/ready') === 2, 3000);
    h.app.send({ id: 3, method: 'fake/exit', params: { code: 1 } });
    await until(() => starts.length === 3, 12000, 'second restart');
    assert.ok(starts[2] - starts[1] >= 450, `second restart waited for the interval (${starts[2] - starts[1]} ms)`);
  } finally { await h.close(); }
});

test('R2 backends: a named backend exit publishes backend/<key>/exited', async () => {
  const h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    const mod = h.mux.client(A);
    await mod.request('thread/start', {}, { backend: 'x' });
    await mod.request('fake/exit', { code: 0 }, { backend: 'x' });
    await until(() => h.bus.count('backend/mod:a/x/exited') === 1, 12000, 'exited');
    assert.equal(h.mux.listBackends(A)[0].state, 'exited');
    assert.equal(h.bus.count('appServer/exited'), 0);
    // Used again, it starts again (no automatic restart for named backends).
    assert.equal((await mod.request('thread/start', {}, { backend: 'x' })).thread.id, 'thr-x-1');
  } finally { await h.close(); }
});

test('R2 backends: defineBackend validates, is idempotent for equal definitions and conflicts otherwise', async () => {
  const h = await harness();
  try {
    await h.define(A, 'x');
    await h.define(A, 'x');
    await assert.rejects(h.define(A, 'x', { idleStopMs: 5 }), { code: 'Conflict' });
    await assert.rejects(h.define(A, 'primary'), { code: 'Invalid' });
    await assert.rejects(h.mux.defineBackend('client:z', 'k', { codexHome: '/h' }), { code: 'Invalid' });
    await h.mux.removeBackend(A, 'x');
    assert.deepEqual(h.mux.listBackends(A), []);
  } finally { await h.close(); }
});
