import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIpcParent } from './entry-node.mjs';
import { layout } from '../../contracts/layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', '..', 'tests', 'integration', 'fixtures');

function fakeProc() {
  const p = new EventEmitter(); p.sent = []; p.connected = true; p.send = (m) => p.sent.push(m); return p;
}

test('createIpcParent: init resolves, other messages are buffered in order until subscribed, post goes out over IPC', async () => {
  const proc = fakeProc();
  const { port, init } = createIpcParent(proc);
  proc.emit('message', { type: 'init', options: { a: 1 } });
  proc.emit('message', { type: 'window', event: 'created', windowId: 1 });
  proc.emit('message', { type: 'health', signal: 'window-rendered' });
  assert.deepEqual(await init, { a: 1 });
  const seen = [];
  port.onMessage((m) => seen.push(m.type));
  proc.emit('message', { type: 'view-closed', viewHandle: 'v' });
  assert.deepEqual(seen, ['window', 'health', 'view-closed']);
  port.post({ type: 'ready' });
  assert.deepEqual(proc.sent, [{ type: 'ready' }]);
  proc.connected = false; port.post({ type: 'x' });
  assert.equal(proc.sent.length, 1, 'no send after disconnect');
});

test('createIpcParent: shutdown triggers onShutdown even before anyone subscribes; onClose maps to disconnect', () => {
  const proc = fakeProc();
  let n = 0;
  const { port } = createIpcParent(proc, { onShutdown: () => n++ });
  proc.emit('message', { type: 'shutdown' });
  assert.equal(n, 1);
  let closed = 0; port.onClose(() => closed++);
  proc.emit('disconnect');
  assert.equal(closed, 1);
});

test('entry-node as a child with an IPC channel: init -> ready -> shutdown, and exit on disconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-en-'));
  const L = layout(root, 'default');
  const adapterDir = join(root, 'adapters', 'x');
  mkdirSync(adapterDir, { recursive: true });
  copyFileSync(join(FIX, 'adapter.json'), join(adapterDir, 'adapter.json'));
  mkdirSync(L.flags, { recursive: true });
  writeFileSync(join(L.flags, 'graph-off'), '');   // the fake factories build no graph (it is on by default, E6)
  const options = { layout: L, profile: { codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '' },
    adapterDir, realCodexPath: '/nonexistent', frameworkVersion: 't', appBuild: '1-1', safeMode: false };
  const spawnChild = () => fork(join(here, 'entry-node.mjs'), [], { serialization: 'json', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CODEXMODS_TEST_FACTORIES: join(FIX, 'fake-factories.mjs') } });
  const waitReady = (c) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ready')), 10_000);
    c.on('message', (m) => { if (m.type === 'ready') { clearTimeout(t); resolve(); } });
  });
  try {
    const a = spawnChild();
    a.send({ type: 'init', options });
    await waitReady(a);
    assert.ok(existsSync(join(L.run, 'app.sock')));
    const exited = new Promise((r) => a.once('exit', (code) => r(code)));
    a.send({ type: 'shutdown' });
    assert.equal(await exited, 0);
    assert.ok(!existsSync(join(L.run, 'app.sock')));

    const b = spawnChild();
    b.send({ type: 'init', options });
    await waitReady(b);
    const exitedB = new Promise((r) => b.once('exit', (code) => r(code)));
    b.disconnect();                         // framework-main went away
    assert.equal(await exitedB, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
