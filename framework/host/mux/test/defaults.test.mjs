// Default timings (10 s handshake wait, 10 s restart interval, 10 min idle stop, 3 s kill grace) verified with mocked timers.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn } from './helpers.mjs';

// Timers are mocked in this file, so polling uses setImmediate only.
async function until(fn, _ms = 2000, what = 'condition') {
  for (let i = 0; i < 20_000; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${what}`);
}
const written = (p, pred) => until(() => p.written.find(pred));
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('defaults: handshake wait is 10 s, then Unavailable', async () => {
  const { spawn } = scriptedSpawn();
  const h = await harness({ spawn });
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const mod = h.mux.client('mod:a');
    const p = mod.request('x/y', {}).then(() => null, (e) => e);
    await flush();
    mock.timers.tick(9_999); await flush();
    let settled = false; p.then(() => { settled = true; });
    await flush(); assert.equal(settled, false);
    mock.timers.tick(1); 
    assert.equal((await p).code, 'Unavailable');
  } finally { mock.timers.reset(); await h.close(); }
});

test('defaults: restart interval 10000 ms, idle stop 600000 ms, kill grace 3000 ms', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    h.app.send({ id: 'i', method: 'initialize', params: {} });
    const init = await written(procs[0], (m) => m.method === 'initialize');
    procs[0].out({ id: init.id, result: { ok: 1 } });
    await h.app.reply('i');
    h.app.send({ method: 'initialized' });
    await until(() => h.bus.count('appServer/ready') === 1);

    // Primary crash right after it started: the restart waits for the 10 s interval.
    procs[0].exit(1);
    await flush();
    mock.timers.tick(9_999); await flush();
    assert.equal(procs.length, 1, 'not restarted yet');
    mock.timers.tick(1); await flush();
    await until(() => procs.length === 2, 2000, 'restart');
    const replay = await written(procs[1], (m) => m.method === 'initialize');
    procs[1].out({ id: replay.id, result: { ok: 2 } });
    await until(() => h.bus.count('appServer/ready') === 2);

    // Idle stop of a named backend after 600 000 ms.
    await h.define('mod:a', 'x');
    const mod = h.mux.client('mod:a');
    const req = mod.request('thread/list', {}, { backend: 'x' });
    await until(() => procs.length === 3);
    const i2 = await written(procs[2], (m) => m.method === 'initialize'); procs[2].out({ id: i2.id, result: {} });
    const l = await written(procs[2], (m) => m.method === 'thread/list'); procs[2].out({ id: l.id, result: { data: [] } });
    await req;
    mock.timers.tick(599_999); await flush();
    assert.deepEqual(procs[2].signals, []);
    mock.timers.tick(1); await flush();
    assert.deepEqual(procs[2].signals, ['SIGTERM']);

    // Kill grace: a stubborn primary gets SIGKILL 3000 ms after SIGTERM.
    procs[1].autoExitOn = [];
    const stopping = h.mux.close();
    await flush();
    mock.timers.tick(2_999); await flush();
    assert.deepEqual(procs[1].signals, ['SIGTERM']);
    mock.timers.tick(1); await flush();
    assert.deepEqual(procs[1].signals, ['SIGTERM', 'SIGKILL']);
    procs[1].exit(null, 'SIGKILL');
    await stopping;
  } finally { mock.timers.reset(); await h.close(); }
});
