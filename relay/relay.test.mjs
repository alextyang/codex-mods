// Relay tests: exec rules, EOF in both directions, a 1 MB line, absent socket, the header (argv and environment).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = join(here, 'relay');
const FAKE = join(here, '..', 'tests', 'fixtures', 'fake-app-server.mjs');
let tmp, runDir, flagsDir, realBin;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-relay-'));
  runDir = join(tmp, 'run'); flagsDir = join(tmp, 'flags');
  mkdirSync(runDir); mkdirSync(flagsDir);
  realBin = join(tmp, 'real-codex');
  writeFileSync(realBin, '#!/bin/sh\necho "REAL:$*"\n'); chmodSync(realBin, 0o755);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const baseEnv = () => ({ PATH: process.env.PATH, CODEX_MODS_RUN_DIR: runDir, CODEX_MODS_FLAGS_DIR: flagsDir, CODEX_MODS_REAL_CODEX: realBin });
const run = (args, env) => spawnSync(RELAY, args, { env, encoding: 'utf8' });
const listen = (path, onConn) => new Promise((resolve) => { const s = createServer(onConn); s.listen(path, () => resolve(s)); });
const closeServer = (s) => new Promise((r) => s.close(() => r()));
const sockPath = () => join(runDir, 'app.sock');
/** Splits a recorded stream into its first line (the parsed header) and the rest. */
const splitHeader = (s) => { const nl = s.indexOf('\n'); return { header: JSON.parse(s.slice(0, nl)), rest: s.slice(nl + 1) }; };
/** The header's envHex as an object (NUL-separated NAME=value entries, the first '=' ends the name). */
const decodeEnv = (hex) => Object.fromEntries(Buffer.from(hex, 'hex').toString('utf8').split('\0').filter(Boolean)
  .map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));


test('disabled flag execs the real binary', () => {
  writeFileSync(join(flagsDir, 'disabled'), '');
  try {
    const r = run(['app-server', '--x'], baseEnv());
    assert.equal(r.stdout, 'REAL:app-server --x\n');
    assert.equal(r.status, 0);
  } finally { rmSync(join(flagsDir, 'disabled')); }
});

test('RUN_DIR unset execs the real binary', () => {
  const env = baseEnv(); delete env.CODEX_MODS_RUN_DIR;
  assert.equal(run(['app-server'], env).stdout, 'REAL:app-server\n');
});

test('subcommands other than app-server exec the real binary', () => {
  const r = run(['login', 'status'], baseEnv());
  assert.equal(r.stdout, 'REAL:login status\n');
  assert.equal(run([], baseEnv()).stdout, 'REAL:\n');
});

test('falls back to "$0.real" when CODEX_MODS_REAL_CODEX is unset', () => {
  const dir = mkdtempSync(join(tmp, 'sib-'));
  copyFileSync(RELAY, join(dir, 'codex')); chmodSync(join(dir, 'codex'), 0o755);
  writeFileSync(join(dir, 'codex.real'), '#!/bin/sh\necho "SIBLING:$*"\n'); chmodSync(join(dir, 'codex.real'), 0o755);
  const env = baseEnv(); delete env.CODEX_MODS_REAL_CODEX;
  const r = spawnSync(join(dir, 'codex'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(r.stdout, 'SIBLING:--version\n');
});

test('the exact argv the app uses (-c options before app-server) is recognized as app-server', async () => {
  const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'features.x=true'];
  const srv = await listen(sockPath(), (c) => { c.resume(); c.end('{"via":"host"}\n'); });
  const p = spawn(RELAY, argv, { env: baseEnv() });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  assert.equal(out, '{"via":"host"}\n');
  await closeServer(srv);
});

test('argv without an app-server token (even with similar words) execs the real binary unchanged', () => {
  const argv = ['-c', 'features.code_mode_host=true', 'exec', 'app-server-ish', '--flag=app-server'];
  const r = run(argv, baseEnv());
  assert.equal(r.stdout, `REAL:${argv.join(' ')}\n`);
});

test('a one-shot startup policy read (app-server --print-startup-config) execs the real binary unchanged', () => {
  const argv = ['app-server', '--analytics-default-enabled', '--print-startup-config', '--startup-client-info', '{"name":"codex_desktop"}', '--startup-sign-out'];
  assert.equal(run(argv, baseEnv()).stdout, `REAL:${argv.join(' ')}\n`);
});

test('the disabled flag wins over an app-server argv', () => {
  writeFileSync(join(flagsDir, 'disabled'), '');
  try {
    const r = run(['-c', 'a=b', 'app-server', '--x'], baseEnv());
    assert.equal(r.stdout, 'REAL:-c a=b app-server --x\n');
  } finally { rmSync(join(flagsDir, 'disabled')); }
});

test('absent socket exits non-zero, but only after the wait', () => {
  const t0 = Date.now();
  const r = run(['app-server'], { ...baseEnv(), CODEX_MODS_RELAY_WAIT_MS: '700' });
  assert.ok(Date.now() - t0 >= 600, 'waited for the socket first');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not available/);
});

test('stale socket file (nobody listening) exits non-zero', async () => {
  const s = await listen(sockPath(), () => {});
  await closeServer(s);
  writeFileSync(sockPath(), '');   // a leftover non-socket file
  const r = run(['app-server'], { ...baseEnv(), CODEX_MODS_RELAY_WAIT_MS: '300' });
  assert.notEqual(r.status, 0);
  rmSync(sockPath(), { force: true });
});

test('client EOF reaches the server, and server close ends the relay (half-close)', async () => {
  let received = '';
  const gotEnd = new Promise((resolve) => {
    listen(sockPath(), (c) => {
      c.on('data', (d) => { received += d; });
      c.on('end', () => { c.end('bye\n'); resolve(); });
    }).then((s) => { srv = s; });
  });
  let srv;
  await new Promise((r) => setTimeout(r, 100));
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.stdin.end('{"id":1}\n');
  const code = await new Promise((r) => p.on('close', r));
  await gotEnd;
  const { header, rest } = splitHeader(received);
  assert.equal(header.codexmodsRelay, 2);
  assert.deepEqual(header.argv, ['app-server']);
  assert.equal(rest, '{"id":1}\n');
  assert.equal(out, 'bye\n');
  assert.equal(code, 0);
  await closeServer(srv);
});

test('server EOF ends the relay even while the client stdin stays open', async () => {
  const srv = await listen(sockPath(), (c) => { c.resume(); c.end('{"hello":true}\n'); });
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  const code = await Promise.race([
    new Promise((r) => p.on('close', r)),
    new Promise((r) => setTimeout(() => r('timeout'), 5000)),
  ]);
  if (code === 'timeout') p.kill('SIGKILL');
  assert.notEqual(code, 'timeout', 'relay must exit on server EOF');
  assert.equal(out, '{"hello":true}\n');
  await closeServer(srv);
});

test('a 1 MB single-line frame survives in both directions', async () => {
  const big = JSON.stringify({ id: 1, params: { blob: 'x'.repeat(1024 * 1024 + 123) } }) + '\n';
  let fromClient = '';
  const srv = await listen(sockPath(), (c) => {
    c.on('data', (d) => { fromClient += d; const nl = fromClient.indexOf('\n'); if (nl >= 0 && fromClient.length >= nl + 1 + big.length) c.end(big); });
  });
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  let out = ''; p.stdout.setEncoding('utf8'); p.stdout.on('data', (d) => { out += d; });
  p.stdin.write(big);                       // keep stdin open until the reply is complete
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(splitHeader(fromClient).rest.length, big.length);
  assert.equal(splitHeader(fromClient).rest, big);
  assert.equal(out.length, big.length);
  assert.equal(out, big);
  assert.equal(code, 0);
  await closeServer(srv);
});

test('round trip with the fake app-server behind a socket', async () => {
  const srv = await listen(sockPath(), (c) => {
    const child = spawn(process.execPath, [FAKE, 'app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let first = Buffer.alloc(0), headerSeen = false;
    c.on('data', (d) => {
      if (headerSeen) return void child.stdin.write(d);
      first = Buffer.concat([first, d]);
      const nl = first.indexOf(10);
      if (nl < 0) return;
      headerSeen = true;
      child.stdin.write(first.subarray(nl + 1));
    });
    c.on('end', () => child.stdin.end());
    child.stdout.pipe(c);
    c.on('close', () => child.kill());
  });
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  let out = '';
  const want = (n) => new Promise((resolve) => { const t = setInterval(() => { if (out.split('\n').length > n) { clearInterval(t); resolve(); } }, 20); });
  p.stdout.setEncoding('utf8'); p.stdout.on('data', (d) => { out += d; });
  p.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n');
  await want(1);
  p.stdin.write(JSON.stringify({ id: 2, method: 'thread/start', params: {} }) + '\n');
  await want(3);
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].id, 2);
  assert.equal(lines[2].method, 'thread/started');
  await closeServer(srv);
});

/** Runs the relay against a server that records its first line (the header); resolves with that line. */
async function headerFrom(argv, env = baseEnv()) {
  let first = '';
  const got = new Promise((resolve) => {
    listen(sockPath(), (c) => {
      let buf = '';
      c.on('data', (d) => { buf += d; if (!first && buf.includes('\n')) { first = buf.split('\n')[0]; resolve(first); c.end(); } });
    }).then((s) => { srv = s; });
  });
  let srv;
  await new Promise((r) => setTimeout(r, 100));
  const p = spawn(RELAY, argv, { env });
  p.stdin.end();
  const line = await got;
  await new Promise((r) => p.on('close', r));
  await closeServer(srv);
  return line;
}

test('header is exactly one JSON line with the app\'s full argv', async () => {
  const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'x.y=z'];
  const line = await headerFrom(argv);
  const h = JSON.parse(line);
  assert.deepEqual(Object.keys(h), ['codexmodsRelay', 'argv', 'envHex']);
  assert.equal(h.codexmodsRelay, 2);
  assert.deepEqual(h.argv, argv);
  assert.match(h.envHex, /^(?:[0-9a-f]{2})+$/);
});

test('header escapes spaces, quotes, backslashes, control characters and keeps unicode and empty args', async () => {
  const argv = ['app-server', 'has space', 'q"uote', 'back\\slash', 'both \\" mix \\\\', 'tab\there', 'new\nline', 'cr\rx', 'bell\x07', 'esc\x1b[0m', 'ü中🌍', '', '{"json":"inside"}', '--k=v w', 'trailing\\'];
  const line = await headerFrom(argv);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line).argv, argv);
});

test('header: an argument ending in a newline survives', async () => {
  const argv = ['app-server', 'ends-with-newline\n', '\n'];
  assert.deepEqual(JSON.parse(await headerFrom(argv)).argv, argv);
});

test('header v2 carries the app\'s whole environment: newlines, quotes, "=", backslashes, unicode and empty values survive', async () => {
  const app = {
    ...baseEnv(),
    CODEX_MCP_NODE_PATH: '/Applications/Codex Copy.app/Contents/Resources/cua_node/bin/node',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_desktop',
    LOG_FORMAT: 'json', RUST_LOG: 'warn,codex_core=info',
    MULTI: 'line one\nline two\n', TRAILING_NL: '\n\n', QUOTES: 'a "b" \'c\' \\d', EQUALS: 'k=v=w', EMPTY: '',
    UNICODE: 'ü中🌍', CTRL: 'tab\tcr\resc\x1b', JSONISH: '{"envHex":"00"}\n{"id":1}',
  };
  const env = decodeEnv(JSON.parse(await headerFrom(['app-server'], app)).envHex);
  for (const [k, v] of Object.entries(app)) assert.equal(env[k], v, k);
  // Only the shell's own bookkeeping is added; none of the relay's variables leak.
  const extra = Object.keys(env).filter((k) => !(k in app)).sort();
  assert.ok(extra.every((k) => ['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)), extra.join(','));
});

test('header falls back to v1 (argv only) when `env -0` is unavailable', async () => {
  // A relay copy whose env path points at a binary that rejects -0.
  const dir = mkdtempSync(join(tmp, 'noenv0-'));
  writeFileSync(join(dir, 'env'), '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, 'env'), 0o755);
  const src = readFileSync(RELAY, 'utf8');
  assert.ok(src.includes('/usr/bin/env -0'));
  writeFileSync(join(dir, 'relay'), src.replaceAll('/usr/bin/env -0', join(dir, 'env') + ' -0')); chmodSync(join(dir, 'relay'), 0o755);
  let first = '';
  const srv = await listen(sockPath(), (c) => { let buf = ''; c.on('data', (d) => { buf += d; if (!first && buf.includes('\n')) { first = buf.split('\n')[0]; c.end(); } }); });
  const p = spawn(join(dir, 'relay'), ['app-server', 'x'], { env: baseEnv() });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  await closeServer(srv);
  assert.deepEqual(JSON.parse(first), { codexmodsRelay: 1, argv: ['app-server', 'x'] });
});

test('no stdin pump or fifo is left behind after the relay exits', async () => {
  const srv = await listen(sockPath(), (c) => { c.resume(); c.end('{"x":1}\n'); });
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  p.stdout.resume();
  await new Promise((r) => p.on('close', r));
  await closeServer(srv);
  const left = readdirSync(runDir).filter((n) => n.startsWith('relay-'));
  assert.deepEqual(left, []);
});

test('the relay waits for a socket that appears after 1 s (slow Host recovery) and then connects', async () => {
  const p = spawn(RELAY, ['-c', 'k=v', 'app-server'], { env: baseEnv() });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  let exited = false; p.on('exit', () => { exited = true; });
  p.stdin.end();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(exited, false, 'still waiting, not failed');
  const srv = await listen(sockPath(), (c) => { c.resume(); c.end('{"late":true}\n'); });
  await new Promise((r) => p.on('close', r));
  assert.equal(out, '{"late":true}\n');
  await closeServer(srv);
});

test('a STALE socket file (dead Host) is waited out: the relay connects once a real server replaces it after 1 s', async () => {
  // a child binds the socket and is SIGKILLed, leaving the file behind
  spawnSync(process.execPath, ['-e', `const n=require('net');n.createServer().listen(${JSON.stringify(sockPath())},()=>process.kill(process.pid,'SIGKILL'))`]);
  assert.ok(existsSync(sockPath()), 'stale socket file present');
  const p = spawn(RELAY, ['app-server'], { env: baseEnv() });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  let exited = false; p.on('exit', () => { exited = true; });
  p.stdin.end();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(exited, false, 'still waiting on the stale socket, not failed');
  rmSync(sockPath());                          // what the Host's listenUnix does with a stale file
  const srv = await listen(sockPath(), (c) => { c.resume(); c.end('{"up":true}\n'); });
  await new Promise((r) => p.on('close', r));
  assert.equal(out, '{"up":true}\n');
  await closeServer(srv);
});

test('a stale socket file that never gets a server fails only after the wait', () => {
  spawnSync(process.execPath, ['-e', `const n=require('net');n.createServer().listen(${JSON.stringify(sockPath())},()=>process.kill(process.pid,'SIGKILL'))`]);
  const t0 = Date.now();
  const r = run(['app-server'], { ...baseEnv(), CODEX_MODS_RELAY_WAIT_MS: '600' });
  assert.notEqual(r.status, 0); assert.ok(Date.now() - t0 >= 500);
  rmSync(sockPath(), { force: true });
});
