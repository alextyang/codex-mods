// A connection becomes a session only when its first line arrives (the relay's liveness probe connects and closes at once).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeApp, until, sleep } from './helpers.mjs';

test('R18 probe: connections that close without any line are discarded silently and do not consume session numbers', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 5; i++) {
      const probe = makeApp();
      h.mux.attachApp(probe.stream);
      probe.end();
      probe.destroy();
    }
    const partial = makeApp();
    h.mux.attachApp(partial.stream);
    partial.raw('{"id":1,"meth');       // bytes but no complete line, then EOF
    partial.end();
    await sleep(100);
    assert.equal(h.entries.filter((e) => /app session|app stream/.test(e.msg)).length, 0, 'nothing logged');
    assert.deepEqual(h.bus.topics(), [], 'no lifecycle events');
    assert.equal(h.mux.metrics().frames.clientRequest, 0);
    assert.deepEqual(h.mux.metrics().backends, [{ key: 'primary', owner: 'app', state: 'stopped' }]);
    // The next real connection is session 1: its backend keeps the first numbering.
    await h.up();
    assert.deepEqual(h.entries.filter((e) => e.msg === 'app session attached').map((e) => e.data.session), [1]);
    const second = makeApp();
    h.mux.attachApp(second.stream);
    await second.handshake();
    assert.deepEqual(h.mux.metrics().backends.map((b) => b.key), ['primary', 'primary:2']);
    second.destroy();
  } finally { await h.close(); }
});

test('R18 probe: a probe next to a live session does not disturb it or the oldest-session default', async () => {
  const h = await harness();
  try {
    await h.up();
    const probe = makeApp();
    h.mux.attachApp(probe.stream);
    probe.end();
    await sleep(60);
    assert.equal((await h.mux.client('mod:a').request('thread/start', {})).thread.id, 'thr-primary-1');
    assert.equal(h.bus.count('appServer/exited'), 0);
    assert.equal((await h.app.request(1, 'echo/x')).result.echo.method, 'echo/x');
  } finally { await h.close(); }
});

test('R18 probe: a relay header alone opens the session (numbered) but spawns nothing', async () => {
  const h = await harness();
  try {
    const a = makeApp();
    h.mux.attachApp(a.stream);
    a.raw(JSON.stringify({ codexmodsRelay: 1, argv: ['app-server'] }) + '\n');
    await until(() => h.entries.some((e) => e.msg === 'app session attached'));
    assert.deepEqual(h.bus.topics(), []);
    a.destroy();
  } finally { await h.close(); }
});
