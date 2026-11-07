import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenUnix } from './sockets.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-sk-'));

test('listens with mode 0600, passes connections, removes the file on close', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'run', 'a.sock');
    const got = [];
    const l = await listenUnix(path, (s) => { s.on('data', (d) => got.push(String(d))); });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700);
    const c = connect(path); await new Promise((r) => c.once('connect', r)); c.write('hi'); await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, ['hi']);
    await l.close();
    assert.ok(!existsSync(path));
    c.destroy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replaces a stale socket file, refuses a live one and a non-socket', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 's.sock');
    // stale: a child binds the socket and is SIGKILLed, leaving the file behind
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['-e', `const n=require('net');const s=n.createServer();s.listen(${JSON.stringify(path)},()=>process.kill(process.pid,'SIGKILL'))`]);
    assert.ok(existsSync(path), 'child left a stale socket file');
    const l = await listenUnix(path, () => {});
    await assert.rejects(listenUnix(path, () => {}), (e) => e.code === 'Conflict');
    await l.close();
    writeFileSync(path, 'file');
    await assert.rejects(listenUnix(path, () => {}), (e) => e.code === 'Conflict');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an over-long path is Invalid with a clear message', async () => {
  await assert.rejects(listenUnix('/tmp/' + 'a'.repeat(120) + '.sock', () => {}), (e) => e.code === 'Invalid' && /too long/.test(e.message));
});
