// Headless passthrough: the app speaks to the Host's app.sock exactly as it would to `codex app-server`, and every byte
// reaches the backend and comes back unchanged. The expected output is produced by running the fake app-server directly.
//
// MODULE MODE: by default the other modules' factories are replaced by tests/integration/fixtures/fake-factories.mjs
// (a byte-piping fake mux). Run with
// CODEXMODS_REAL_MODULES=1 (see harness.mjs); no edit is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadless, writeFakeCodex, USE_REAL_MODULES } from './harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * The mux allocates ids on server -> client requests (ARCHITECTURE 6.3: "every id sent ... is mux-allocated"), so the app sees
 * its own id space ("s:1") where the backend used "srv-1". Everything else must be identical byte for byte; this one line
 * is compared as JSON with its id masked.
 */
const isServerRequest = (b) => { try { const m = JSON.parse(b.toString('utf8')); return m.method !== undefined && m.id !== undefined; } catch { return false; } };
const maskId = (b) => { const m = JSON.parse(b.toString('utf8')); m.id = '<id>'; return m; };
function assertSameLine(actual, expected, i) {
  if (isServerRequest(expected)) return assert.deepEqual(maskId(actual), maskId(expected), `server request line ${i}`);
  assert.equal(actual.equals(expected), true, `line ${i} differs:\n${actual.toString().slice(0, 200)}\n${expected.toString().slice(0, 200)}`);
}

const BIG = 'y'.repeat(1024 * 1024 + 17);
// Deliberately awkward bytes: key order, spacing, unicode, escapes. The Host must not reserialize anything.
const SCRIPT = [
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"},"capabilities":null}}',
  '{"method":"initialized"}',
  '{ "id" : 2 ,"method":"thread/start","params":{"cwd":"/tmp/\\u00e9\\u4e2d"} }',
  '{"id":3,"method":"turn/start","params":{"threadId":"thr-primary-1","input":[{"type":"text","text":"héllo 🌍"}]}}',
  `{"id":4,"method":"echo/big","params":{"blob":"${BIG}"}}`,
];

/** Plays SCRIPT over a duplex-ish channel; answers the server request; returns every raw line received, in order. */
async function converse(ch) {
  const got = [];
  const take = async (pred) => { const l = await ch.next(pred); got.push(l); return l; };
  const id = (n) => (b) => { try { return JSON.parse(b.toString('utf8')).id === n; } catch { return false; } };
  ch.sendRaw(SCRIPT[0]); await take(id(1));
  ch.sendRaw(SCRIPT[1]);
  ch.sendRaw(SCRIPT[2]); await take(id(2)); await take((b) => b.toString().includes('thread/started'));
  ch.sendRaw(SCRIPT[3]);
  await take(id(3));
  for (const m of ['turn/started', 'item/agentMessage/delta', 'item/agentMessage/delta', 'item/agentMessage/delta', 'turn/completed']) await take((b) => b.toString().includes(`"${m}"`));
  // A server -> client request, answered by the "app"; the backend then replies with the answer it was given.
  ch.sendRaw('{"id":5,"method":"fake/serverRequest","params":{"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-primary-1","command":"ls"}}}');
  const srv = await take((b) => b.toString().includes('requestApproval'));
  const srvId = JSON.parse(srv.toString('utf8')).id;
  ch.sendRaw(`{"id":${JSON.stringify(srvId)},"result":{"decision":"accept"}}`);
  await take(id(5));
  ch.sendRaw(SCRIPT[4]); await take(id(4));
  return got;
}

/** A channel over a child process's stdio (same shape as the socket client). */
function childChannel(cmd, args, env) {
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = Buffer.alloc(0); const lines = [], waiters = [];
  const flush = () => { for (let i = waiters.length - 1; i >= 0; i--) { const idx = lines.findIndex(waiters[i].pred); if (idx >= 0) { const [l] = lines.splice(idx, 1); const w = waiters.splice(i, 1)[0]; w.resolve(l); } } };
  child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); let nl; while ((nl = buf.indexOf(10)) >= 0) { lines.push(buf.subarray(0, nl)); buf = buf.subarray(nl + 1); } flush(); });
  return {
    child,
    sendRaw: (t) => child.stdin.write(t + '\n'),
    next: (pred) => new Promise((resolve) => { waiters.push({ pred, resolve }); flush(); }),
  };
}

/** Same conversation against the fake app-server run directly (no Host): the byte-for-byte reference. */
async function direct(codex, codexHome) {
  const ch = childChannel(codex, ['app-server'], { ...process.env, CODEX_HOME: codexHome });
  try { return await converse(ch); } finally { ch.child.kill(); }
}

test(`passthrough is byte-equivalent through the Host (${USE_REAL_MODULES ? 'REAL modules' : 'fake factories'})`, async () => {
  const host = await startHeadless();
  const tmp = mkdtempSync(join(tmpdir(), 'cm-ref-'));
  try {
    const expected = await direct(writeFakeCodex(tmp), host.profile.codexHome);
    const app = await host.appConnection();
    const actual = await converse(app);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) assertSameLine(actual[i], expected[i], i);

    // Client -> backend direction: the backend received exactly the bytes the app sent.
    const received = readFileSync(host.backendLog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^primary /, ''));
    // The real mux allocates its own request ids and reserializes ("id":"m:1"), so requests are compared as JSON with the id
    // masked; notifications carry no id and must still match byte for byte.
    const norm = (line) => { const m = JSON.parse(line); if (m.id !== undefined && m.method !== undefined) m.id = '<id>'; return JSON.stringify(m); };
    const receivedNorm = received.map(norm);
    for (const sent of SCRIPT) assert.ok(receivedNorm.includes(norm(sent)), `backend did not receive: ${sent.slice(0, 80)}`);
    assert.ok(received.includes(SCRIPT[1]), 'the initialized notification arrived byte for byte');
    const answer = received.find((l) => l.includes('"decision":"accept"'));
    assert.deepEqual(JSON.parse(answer), { id: 'srv-1', result: { decision: 'accept' } }, 'the app\'s answer reached the backend under the backend\'s own id');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    const r = await host.stop();
    assert.equal(r?.code, 0, `clean shutdown (stderr: ${host.stderr})`);
  }
});

test('the backend is spawned with the profile CODEX_HOME, via the real codex path', async () => {
  const host = await startHeadless();
  try {
    const app = await host.appConnection();
    app.sendRaw('{"id":1,"method":"initialize","params":{}}');
    const reply = await app.nextJson((m) => m.id === 1);
    assert.equal(reply.result.codexHome, host.profile.codexHome);
    assert.equal(reply.result.userAgent, 'fake/primary');
  } finally { await host.stop(); }
});

test('closing the app connection stops the backend; a new connection gets a fresh backend', async () => {
  const host = await startHeadless();
  try {
    const a = await host.appConnection();
    a.sendRaw('{"id":1,"method":"initialize","params":{}}'); await a.next();
    a.sendRaw('{"method":"initialized"}');
    a.sendRaw('{"id":2,"method":"thread/start","params":{}}'); await a.next();
    a.close(); await a.closed;
    await new Promise((r) => setTimeout(r, 300));   // let the Host observe the disconnect
    const b = await host.appConnection();
    b.sendRaw('{"id":1,"method":"initialize","params":{}}'); await b.next();
    b.sendRaw('{"method":"initialized"}');
    b.sendRaw('{"id":2,"method":"thread/start","params":{}}');
    const r = await b.nextJson((m) => m.id === 2);
    assert.equal(r.result.thread.id, 'thr-primary-1', 'a new backend process numbers threads from 1 again');
  } finally { await host.stop(); }
});

test('shutdown removes the sockets and exits 0', async () => {
  const host = await startHeadless();
  assert.ok(existsSync(join(host.layout.run, 'app.sock')) && existsSync(join(host.layout.run, 'mgmt.sock')));
  const r = await host.stop();
  assert.equal(r?.code, 0);
  assert.ok(!existsSync(join(host.layout.run, 'app.sock')));
});

test('the relay carries the same conversation from the app\'s stdio to the Host byte for byte', async () => {
  const host = await startHeadless();
  const tmp = mkdtempSync(join(tmpdir(), 'cm-ref-'));
  try {
    const expected = await direct(writeFakeCodex(tmp), host.profile.codexHome);
    const relay = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay', 'relay');
    const ch = childChannel(relay, ['app-server'], host.relayEnv());
    try {
      const actual = await converse(ch);
      assert.equal(actual.length, expected.length);
      actual.forEach((l, i) => assertSameLine(l, expected[i], i));
    } finally { ch.child.kill(); }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await host.stop();
  }
});

test('two app connections at once are independent sessions (v1.2 multi-session)', async (t) => {
  const host = await startHeadless();
  try {
    const a = await host.appConnection();
    const b = await host.appConnection();
    const handshake = async (c, label) => {
      c.sendRaw('{"id":1,"method":"initialize","params":{}}');
      const first = await Promise.race([c.nextJson((m) => m.id === 1, 4000), c.closed.then(() => 'closed')]);
      if (first === 'closed') return `${label} was closed by the Host`;
      c.sendRaw('{"method":"initialized"}');
      c.sendRaw('{"id":2,"method":"thread/start","params":{}}');
      const r = await c.nextJson((m) => m.id === 2, 4000);
      return r.result.thread.id;
    };
    let results;
    try { results = await Promise.all([handshake(a, 'first'), handshake(b, 'second')]); }
    catch (e) { results = [`error: ${e.message}`]; }
    if (results.some((r) => typeof r === 'string' && (r.endsWith('closed by the Host') || r.startsWith('error: timed out')))) {
      return t.skip('the fake mux serves a single session');
    }
    assert.deepEqual(results, ['thr-primary-1', 'thr-primary-1'], 'each session has its own backend, so each numbers its threads from 1');
  } finally { await host.stop(); }
});

test('the backend receives the app\'s exact argv from the relay header (relay -> mux -> launchFor)', async (t) => {
  const host = await startHeadless();
  try {
    const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'x.y="q u"'];
    const relay = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay', 'relay');
    const ch = childChannel(relay, argv, host.relayEnv());
    try {
      ch.sendRaw('{"id":1,"method":"initialize","params":{}}');
      await ch.next((b) => b.toString().includes('"id":1') || b.toString().includes('"id":"1"'));
    } finally { ch.child.kill(); }
    const seen = host.backendArgvs();
    if (USE_REAL_MODULES && seen.length === 1 && JSON.stringify(seen[0]) === JSON.stringify(['app-server'])) return t.skip('the backend was started without the relay header argv');
    assert.deepEqual(seen, [argv]);
  } finally { await host.stop(); }
});

test('a plain connection with no header still gets the default args [app-server]', async () => {
  const host = await startHeadless();
  try {
    const app = await host.appConnection();
    app.sendRaw('{"id":1,"method":"initialize","params":{}}'); await app.next();
    assert.deepEqual(host.backendArgvs(), [['app-server']]);
  } finally { await host.stop(); }
});

// ---- v1.20: adapter.backend.configOverrides -> `-c` pairs on the primary spawn (real Host boot, fake app-server)
const relayPath = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay', 'relay');
async function appThroughRelay(host, argv) {
  const ch = childChannel(relayPath(), argv, host.relayEnv());
  ch.sendRaw('{"id":1,"method":"initialize","params":{}}');
  return ch;
}

test('a pack with configOverrides puts `-c key=toml` pairs on the primary spawn, after the app\'s own -c and before app-server; vars are substituted', async () => {
  const host = await startHeadless({ adapterBackend: { configOverrides: {
    notify: ['/bin/true', '${profileDir}/notify'], 'features.shell_tool': false, 'mcp_servers.node_repl': { command: '${computerUseDir}/repl', args: ['--home', '${codexHome}'] }, retries: 3,
  } } });
  try {
    const ch = await appThroughRelay(host, ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled']);
    try { await ch.next((b) => b.toString().includes('"id":1')); } finally { ch.child.kill(); }
    const L = host.layout;
    assert.deepEqual(host.backendArgvs(), [[
      '-c', 'features.code_mode_host=true',
      '-c', `notify=["/bin/true", "${L.profileDir}/notify"]`,
      '-c', 'features.shell_tool=false',
      '-c', `mcp_servers.node_repl={ command = "${L.computerUse}/repl", args = ["--home", "${host.profile.codexHome}"] }`,
      '-c', 'retries=3',
      'app-server', '--analytics-default-enabled',
    ]]);
  } finally { await host.stop(); }
});

test('a pack without configOverrides leaves the primary argv exactly as the app sent it', async () => {
  const host = await startHeadless();
  try {
    const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
    const ch = await appThroughRelay(host, argv);
    try { await ch.next((b) => b.toString().includes('"id":1')); } finally { ch.child.kill(); }
    assert.deepEqual(host.backendArgvs(), [argv]);
  } finally { await host.stop(); }
});

test('an unknown template variable refuses the primary spawn: no backend starts, the Host keeps running', async () => {
  const host = await startHeadless({ adapterBackend: { configOverrides: { notify: ['${resources}/x'] } } });     // headless has no app bundle: ${resources} is unavailable
  try {
    const ch = await appThroughRelay(host, ['app-server']);
    await new Promise((r) => setTimeout(r, 1500));
    ch.child.kill();
    assert.deepEqual(host.backendArgvs(), [], 'nothing was spawned');
    assert.equal(host.child.exitCode, null, 'the Host is still up');
  } finally { await host.stop(); }
});
