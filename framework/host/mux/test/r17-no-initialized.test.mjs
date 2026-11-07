// The stock app does not always send `initialized`: a session's primary is ready once the initialize response is delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, until, sleep } from './helpers.mjs';

const A = 'mod:a';
const namedLines = (h, name) => h.serverLog().filter((l) => l.startsWith(name + ' ')).map((l) => JSON.parse(l.slice(name.length + 1)));

test('R17 handshake: a session that never sends initialized is served immediately after the initialize response', async () => {
  const h = await harness({ tuning: { handshakeWaitMs: 1500 } });
  try {
    h.attach();
    const t0 = Date.now();
    await h.app.request('__codex_initialize__', 'initialize', { clientInfo: { name: 'stock' } });
    const r = await h.app.request(1, 'thread/start', {});
    assert.equal(r.result.thread.id, 'thr-primary-1');
    assert.ok(Date.now() - t0 < 1400, 'no handshake wait');
    await until(() => h.bus.count('appServer/ready') === 1);
    // A mod request is served too.
    assert.equal((await h.mux.client(A).request('thread/start', {})).thread.id, 'thr-primary-2');
    assert.ok(!h.serverLog().some((l) => l.includes('"initialized"')));
  } finally { await h.close(); }
});

test('R17 handshake: requests that arrive before the initialize response still wait', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach();
    h.app.send({ id: 'init', method: 'initialize', params: {} });
    await until(() => procs.length === 1);
    const mod = h.mux.client(A);
    let done = false;
    const p = mod.request('thread/list', {}).then((v) => { done = true; return v; });
    await sleep(100);
    assert.equal(done, false);
    assert.equal(procs[0].written.filter((m) => m.method === 'thread/list').length, 0, 'not transmitted yet');
    const init = await procs[0].waitWritten((m) => m.method === 'initialize');
    procs[0].out({ id: init.id, result: { ok: 1 } });
    const list = await procs[0].waitWritten((m) => m.method === 'thread/list');
    procs[0].out({ id: list.id, result: { data: [] } });
    assert.deepEqual(await p, { data: [] });
  } finally { await h.close(); }
});

test('R17 handshake: a session that does send initialized still works and forwards it', async () => {
  const h = await harness();
  try {
    await h.up();
    assert.ok(h.serverLog().some((l) => l.startsWith('primary ') && l.includes('"method":"initialized"')));
    assert.equal((await h.app.request(1, 'thread/start', {})).result.thread.id, 'thr-primary-1');
  } finally { await h.close(); }
});

test('R17 handshake: named-backend replay sends initialized only if the session\'s app sent one', async () => {
  // Without initialized.
  let h = await harness();
  try {
    h.attach();
    await h.app.request('init', 'initialize', { c: 1 });
    await h.define(A, 'x');
    await h.mux.client(A).request('thread/start', {}, { backend: 'x' });
    const x = namedLines(h, 'x');
    assert.equal(x[0].method, 'initialize');
    assert.deepEqual(x[0].params, { c: 1 });
    assert.ok(!x.some((m) => m.method === 'initialized'));
    assert.equal(x[1].method, 'thread/start');
  } finally { await h.close(); }
  // With initialized.
  h = await harness();
  try {
    await h.up();
    await h.define(A, 'x');
    await h.mux.client(A).request('thread/start', {}, { backend: 'x' });
    const x = namedLines(h, 'x');
    assert.deepEqual(x.map((m) => m.method), ['initialize', 'initialized', 'thread/start']);
  } finally { await h.close(); }
});

test('R17 handshake: a restarted primary replays initialized only if the app sent one', async () => {
  const h = await harness({ tuning: { restartIntervalMs: 50 } });
  try {
    h.attach();
    await h.app.request('init', 'initialize', {});
    h.app.send({ id: 2, method: 'fake/exit', params: {} });
    await until(() => h.bus.count('appServer/ready') === 2, 12000, 'restart ready');
    assert.equal((await h.app.request(3, 'thread/start', {})).result.thread.id, 'thr-primary-1');
    assert.ok(!h.serverLog().some((l) => l.includes('"initialized"')));
  } finally { await h.close(); }
});
