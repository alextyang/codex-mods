import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, until } from './helpers.mjs';
import { createFramer, MAX_FRAME_BYTES, MAX_BACKEND_FRAME_BYTES } from '../framing.mjs';

test('R1 framing: JSONL both directions; unparseable app lines are logged (without payload) and dropped', async () => {
  const h = await harness();
  try {
    await h.up();
    h.app.raw('this is not json SECRET-PAYLOAD\n');
    h.app.raw('[1,2,3]\n');
    const r = await h.app.request(5, 'echo/hello', { a: 1 });
    assert.deepEqual(r.result, { echo: { method: 'echo/hello', params: { a: 1 } } });
    assert.ok(h.logged('warn', /unparseable frame from the app/));
    assert.ok(h.logged('warn', /non-object frame from the app/));
    assert.ok(!JSON.stringify(h.entries).includes('SECRET-PAYLOAD'), 'logs hold metadata only');
  } finally { await h.close(); }
});

test('R1 framing: unparseable backend lines are logged and dropped, later frames still flow', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    procs[0].out('garbage {{{');
    procs[0].out({ method: 'tick', params: { n: 1 } });
    const m = await h.app.waitFor((x) => x.method === 'tick');
    assert.equal(m.params.n, 1);
    assert.ok(h.logged('warn', /unparseable frame from backend/));
  } finally { await h.close(); }
});

test('R1 framing: each frame is parsed once by the mux', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  const real = JSON.parse;
  let hits = 0;
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    const mod = h.mux.client('mod:p');
    mod.intercept('serverNotification', ['mark/'], () => undefined);
    mod.observe({}, () => {});
    JSON.parse = function (text, ...rest) {
      if (typeof text === 'string' && text.includes('PARSE-ONCE-MARKER') && new Error().stack.includes('/mux/index.mjs')) hits++;
      return real.call(this, text, ...rest);
    };
    procs[0].out({ method: 'mark/x', params: { v: 'PARSE-ONCE-MARKER' } });
    await h.app.waitFor((x) => x.method === 'mark/x');
    assert.equal(hits, 1);
  } finally { JSON.parse = real; await h.close(); }
});

test('R1 framing: frames of exactly 16 MiB are handled', async () => {
  const h = await harness();
  try {
    await h.up();
    const head = JSON.stringify({ id: 'big', method: 'fake/slow', params: { ms: 0, pad: '' } });
    const pad = 'x'.repeat(MAX_FRAME_BYTES - Buffer.byteLength(head));
    const line = JSON.stringify({ id: 'big', method: 'fake/slow', params: { ms: 0, pad } });
    assert.equal(Buffer.byteLength(line), MAX_FRAME_BYTES);
    h.app.raw(line + '\n');
    const r = await h.app.reply('big', 10000);
    assert.deepEqual(r.result, { slept: 0 });
  } finally { await h.close(); }
});

test('R1 framing: an app frame over 16 MiB closes the app connection with a logged error', async () => {
  const h = await harness();
  try {
    await h.up();
    h.app.raw(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78));
    await until(() => h.app.stream.destroyed, 12000, 'connection closed');
    assert.ok(h.logged('error', /app frame exceeds the size limit/));
  } finally { await h.close(); }
});

test('R1 framing: a backend answer over 16 MiB reaches the app (the app-server is trusted; its plugin catalog can be 21 MB)', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn });
  try {
    h.attach(); h.app.send({ method: 'wake/up' }); await until(() => procs.length === 1);
    h.app.send({ id: 'i', method: 'initialize', params: {} });
    const init = await procs[0].waitWritten((m) => m.method === 'initialize');
    procs[0].out({ id: init.id, result: { ok: 1 } });
    await h.app.reply('i');
    h.app.send({ method: 'initialized' });
    h.app.send({ id: 'big', method: 'plugin/list', params: {} });
    const asked = await procs[0].waitWritten((m) => m.method === 'plugin/list');
    const pad = 'x'.repeat(MAX_FRAME_BYTES + 1024);
    procs[0].out({ id: asked.id, result: { pad } });
    const r = await h.app.reply('big', 20000);
    assert.equal(r.result.pad.length, pad.length);
    assert.equal(procs[0].signals.length, 0, 'the backend keeps running');
  } finally { await h.close(); }
});

test('R1 framing: a backend frame over its cap stops that backend with a logged error', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn, tuning: { maxBackendFrameBytes: 1024 } });
  try {
    assert.equal(MAX_BACKEND_FRAME_BYTES, 256 * 1024 * 1024);
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    procs[0].stdout.write(Buffer.alloc(1025, 0x78));
    await until(() => procs[0].signals.includes('SIGTERM'), 12000, 'backend stopped');
    assert.ok(h.logged('error', /backend frame exceeds the size limit/));
  } finally { await h.close(); }
});

test('R1 framing: the framer reassembles split chunks and enforces its cap', () => {
  const got = []; let over = 0;
  const f = createFramer({ maxBytes: 10, onFrame: (l) => got.push(l), onOverflow: () => over++ });
  f.push('{"a":'); f.push('1}\n{"b"'); f.push(':2}\n\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  f.push('12345678901'); // 11 bytes, no newline
  assert.equal(over, 1);
  f.push('more\n'); assert.equal(got.length, 2, 'dead after overflow');
});
