import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { spawnHostProcess } = createRequire(import.meta.url)('./host-process.cjs');

test('spawns on the given Node with an IPC channel; stdio goes to the log file; exit is reported once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-hp-'));
  try {
    const entry = join(dir, 'child.mjs');
    writeFileSync(entry, `process.on('message', (m) => { console.log('got ' + m.type); process.send({ type: 'echo', of: m.type }); if (m.type === 'shutdown') process.exit(3); });\nconsole.error('hello stderr');`);
    const logFile = join(dir, 'logs', 'host-stdio.log');
    const h = spawnHostProcess({ nodePath: process.execPath, entry, logFile, env: { ...process.env } });
    const got = [];
    h.onMessage((m) => got.push(m));
    const exited = new Promise((r) => { let n = 0; h.onExit((code) => { n++; r([code, n]); }); });
    h.postMessage({ type: 'init' });
    h.postMessage({ type: 'shutdown' });
    const [code] = await exited;
    assert.equal(code, 3);
    assert.deepEqual(got, [{ type: 'echo', of: 'init' }, { type: 'echo', of: 'shutdown' }]);
    const text = readFileSync(logFile, 'utf8');
    assert.match(text, /got init/); assert.match(text, /hello stderr/);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
    h.postMessage({ type: 'late' });          // after exit: ignored, no throw
    let late = 0; h.onExit(() => late++);
    assert.equal(late, 1, 'a late onExit listener is told immediately');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing Node binary is reported as an exit, not a throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-hp-'));
  try {
    const h = spawnHostProcess({ nodePath: join(dir, 'no-such-node'), entry: 'x.mjs', logFile: join(dir, 'l.log'), env: {} });
    const [code, signal] = await new Promise((r) => h.onExit((c, s) => r([c, s])));
    assert.equal(code, null); assert.equal(signal, 'spawn-error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
