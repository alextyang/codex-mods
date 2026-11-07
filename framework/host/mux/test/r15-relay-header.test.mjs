// v1.3: the relay's first line {"codexmodsRelay":1,"argv":[...]} is stripped and its argv drives the session's launch.
// Mux addition 9: header v2 {"codexmodsRelay":2,"argv":[...],"envHex":"..."} also carries the app's environment, and the session's
// primary is spawned from it (integration.md I11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, makeApp, fakeLaunch, until } from './helpers.mjs';

const RELAY = join(dirname(fileURLToPath(import.meta.url)), '../../../../relay/relay');

const A = 'mod:a';
const ARGV = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
const header = (argv) => JSON.stringify({ codexmodsRelay: 1, argv }) + '\n';
const envHex = (env) => Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''), 'utf8').toString('hex');
const header2 = (argv, env) => JSON.stringify({ codexmodsRelay: 2, argv, envHex: envHex(env) }) + '\n';
const APP_ENV = {
  PATH: '/copy/Contents/Resources/git/bin:/usr/bin:/bin',
  CODEX_CLI_PATH: '/copy/Contents/Resources/codexmods-relay',
  CODEX_MCP_NODE_PATH: '/copy/Contents/Resources/cua_node/bin/node',
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_desktop', LOG_FORMAT: 'json', RUST_LOG: 'warn',
  CODEX_HOME: '/app/thinks/this/home',
  SECRETISH: 'line one\nline "two"\\ = ü',
};
/** A spawn that records each launch's env, then really spawns. */
function spawnSpy() {
  const envs = [];
  return { envs, spawn: (cmd, args, o) => { envs.push(o.env); return nodeSpawn(cmd, args, o); } };
}
/** Sets a variable only the Host has for the duration of fn. */
async function withHostVar(fn) {
  process.env.CODEXMODS_TEST_HOST_ONLY = 'host';
  try { return await fn(); } finally { delete process.env.CODEXMODS_TEST_HOST_ONLY; }
}

function launchSpy(getH) {
  const calls = [];
  return { calls, launchFor: (id, def, session) => { calls.push({ id, def, session }); return fakeLaunch(getH().dir)(id, def); } };
}

test('R15 relay header: stripped, never forwarded, and its argv is passed verbatim to launchFor', async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    h.attach();
    h.app.raw(header(ARGV));
    h.app.send({ id: 'init', method: 'initialize', params: { a: 1 } });
    await h.app.reply('init');
    assert.deepEqual(spy.calls.map((c) => [c.id, c.def, c.session]), [['primary', undefined, { argv: ARGV }]]);
    assert.ok(!h.serverLog().some((l) => l.includes('codexmodsRelay')), 'never reached the backend');
    assert.equal(h.entries.some((e) => e.level === 'warn' && /unparseable|malformed/.test(e.msg)), false);
  } finally { await h.close(); }
});

test('R15 relay header: the header may arrive split across chunks, and alone it does not start the primary', async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    h.attach();
    const line = header(ARGV);
    h.app.raw(line.slice(0, 10));
    h.app.raw(line.slice(10));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(spy.calls.length, 0, 'header only: no first frame yet');
    h.app.send({ id: 'init', method: 'initialize', params: {} });
    await h.app.reply('init');
    assert.deepEqual(spy.calls[0].session, { argv: ARGV });
  } finally { await h.close(); }
});

test("R15 relay header: a missing header means argv ['app-server'] and the first line is a normal frame", async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    await h.up();
    assert.deepEqual(spy.calls[0].session, { argv: ['app-server'] });
  } finally { await h.close(); }
});

test('R15 relay header: a malformed header line is treated as a normal (unparseable) app line and dropped', async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    h.attach();
    h.app.raw('{"codexmodsRelay":1,"argv":["app-server"\n');   // not JSON
    h.app.send({ id: 'init', method: 'initialize', params: {} });
    await h.app.reply('init');
    assert.deepEqual(spy.calls[0].session, { argv: ['app-server'] });
    assert.ok(h.logged('warn', /unparseable frame from the app/));
    // A well-formed JSON object that is not a valid header is also not stripped.
    const h2app = makeApp();
    h.mux.attachApp(h2app.stream);
    h2app.raw(JSON.stringify({ codexmodsRelay: 1, argv: [1, 2] }) + '\n');
    h2app.send({ id: 'init', method: 'initialize', params: {} });
    await h2app.reply('init');
    assert.deepEqual(spy.calls[1].session, { argv: ['app-server'] });
    assert.ok(h.logged('warn', /malformed frame dropped/));
  } finally { await h.close(); }
});

test("R15 relay header: a named backend gets the oldest live session's argv (default ['app-server'])", async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    await h.define(A, 'early');
    const mod = h.mux.client(A);
    const second = makeApp();
    h.attach();
    h.app.raw(header(ARGV));
    await h.app.handshake();
    h.mux.attachApp(second.stream);
    second.raw(header(['app-server', '--other']));
    await second.handshake();
    await mod.request('thread/start', {}, { backend: 'early' });
    const named = spy.calls.find((c) => c.id === 'mod:a/early');
    assert.deepEqual(named.session, { argv: ARGV });
    assert.equal(named.def.codexHome.endsWith('home-early'), true);
    // After the oldest closes, the next session's argv is used.
    await h.define(A, 'late');
    h.app.end();
    await until(() => h.bus.count('appServer/exited') === 1, 12000);
    await mod.request('thread/start', {}, { backend: 'late' });
    assert.deepEqual(spy.calls.find((c) => c.id === 'mod:a/late').session, { argv: ['app-server', '--other'] });
    second.destroy();
  } finally { await h.close(); }
});

test('R15 relay header: a restarted primary reuses its session argv', async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor, tuning: { restartIntervalMs: 50 } });
  try {
    h.attach();
    h.app.raw(header(ARGV));
    await h.app.handshake();
    h.app.send({ id: 2, method: 'fake/exit', params: {} });
    await until(() => spy.calls.length === 2, 12000, 'restart');
    await until(() => h.bus.count('appServer/ready') === 2, 12000);
    assert.deepEqual(spy.calls.map((c) => [c.id, c.session]), [['primary', { argv: ARGV }], ['primary', { argv: ARGV }]]);
  } finally { await h.close(); }
});

test('R15 header v2: the primary is spawned with the app\'s environment (not the Host\'s), CODEX_HOME from the launch, and the header is never forwarded, observed or logged', () => withHostVar(async () => {
  let h; const spy = launchSpy(() => h); const sp = spawnSpy();
  h = await harness({ launchFor: spy.launchFor, spawn: sp.spawn });
  try {
    const seen = [];
    h.mux.client(A).observe({}, (m) => seen.push(JSON.stringify(m)));
    h.attach();
    h.app.raw(header2(ARGV, APP_ENV));
    await h.app.handshake();
    assert.deepEqual(spy.calls[0].session, { argv: ARGV, env: APP_ENV });
    const env = sp.envs[0];
    for (const [k, v] of Object.entries(APP_ENV)) if (k !== 'CODEX_HOME') assert.equal(env[k], v, k);
    assert.equal(env.CODEX_HOME, join(h.dir, 'home-primary'), 'CODEX_HOME is the profile\'s');
    assert.ok(env.FAKE_APP_SERVER_LOG, 'launch.env is overlaid');
    assert.equal(env.CODEXMODS_TEST_HOST_ONLY, undefined, 'the Host\'s own environment is not the base');
    const everything = [...h.serverLog(), ...h.entries.map((e) => JSON.stringify(e)), ...seen].join('\n');
    assert.ok(!everything.includes('codexmodsRelay') && !everything.includes('envHex'), 'header stripped');
    assert.ok(!everything.includes('CODEX_MCP_NODE_PATH') && !everything.includes('line one'), 'environment never logged or observed');
  } finally { await h.close(); }
}));

test('R15 header v1 is still accepted: the primary gets the Host\'s environment', () => withHostVar(async () => {
  let h; const spy = launchSpy(() => h); const sp = spawnSpy();
  h = await harness({ launchFor: spy.launchFor, spawn: sp.spawn });
  try {
    h.attach();
    h.app.raw(header(ARGV));
    await h.app.handshake();
    assert.deepEqual(spy.calls[0].session, { argv: ARGV });
    assert.equal(sp.envs[0].CODEXMODS_TEST_HOST_ONLY, 'host');
  } finally { await h.close(); }
}));

test('R15 header v2 without valid envHex is not a header: it is treated as an app line and dropped', async () => {
  let h; const spy = launchSpy(() => h);
  h = await harness({ launchFor: spy.launchFor });
  try {
    for (const bad of [{ codexmodsRelay: 2, argv: ['app-server'] }, { codexmodsRelay: 2, argv: ['app-server'], envHex: 'zz' }, { codexmodsRelay: 2, argv: ['app-server'], envHex: 'abc' }, { codexmodsRelay: 3, argv: ['app-server'], envHex: '' }]) {
      const app = makeApp();
      h.mux.attachApp(app.stream);
      app.raw(JSON.stringify(bad) + '\n');
      await app.handshake();
      assert.deepEqual(spy.calls.at(-1).session, { argv: ['app-server'] }, JSON.stringify(bad));
      app.destroy();
    }
  } finally { await h.close(); }
});

test('R15 header v2: named backends keep the Host\'s environment, and a restarted primary reuses the app\'s', () => withHostVar(async () => {
  let h; const spy = launchSpy(() => h); const sp = spawnSpy();
  h = await harness({ launchFor: spy.launchFor, spawn: sp.spawn, tuning: { restartIntervalMs: 50 } });
  try {
    h.attach();
    h.app.raw(header2(ARGV, APP_ENV));
    await h.app.handshake();
    await h.define(A, 'named');
    await h.mux.client(A).request('thread/start', {}, { backend: 'named' });
    const named = spy.calls.findIndex((c) => c.id === 'mod:a/named');
    assert.deepEqual(spy.calls[named].session, { argv: ARGV }, 'named backends get the argv only');
    assert.equal(sp.envs[named].CODEXMODS_TEST_HOST_ONLY, 'host');
    assert.equal(sp.envs[named].CODEX_MCP_NODE_PATH, process.env.CODEX_MCP_NODE_PATH);
    h.app.send({ id: 2, method: 'fake/exit', params: {} });
    await until(() => spy.calls.filter((c) => c.id === 'primary').length === 2, 12000, 'restart');
    const again = spy.calls.findLastIndex((c) => c.id === 'primary');
    assert.deepEqual(spy.calls[again].session, { argv: ARGV, env: APP_ENV });
    assert.equal(sp.envs[again].CODEX_MCP_NODE_PATH, APP_ENV.CODEX_MCP_NODE_PATH);
  } finally { await h.close(); }
}));

test('R15 end to end: the real relay hands the app\'s environment (with a multi-line value) to the mux\'s primary spawn', async () => {
  let h; const sp = spawnSpy();
  h = await harness({ spawn: sp.spawn });
  const sock = join(h.dir, 'app.sock');
  const srv = net.createServer((c) => h.mux.attachApp(c));
  await new Promise((r) => srv.listen(sock, r));
  try {
    const appEnv = { PATH: process.env.PATH, CODEX_MODS_RUN_DIR: h.dir, CODEX_MODS_REAL_CODEX: '/nonexistent', CODEX_MCP_NODE_PATH: '/copy/node', MULTI: 'a\nb\n', QUOTE: 'x"y\\z' };
    const relay = nodeSpawn(RELAY, ['-c', 'k=v', 'app-server'], { env: appEnv, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; relay.stdout.setEncoding('utf8'); relay.stdout.on('data', (d) => { out += d; });
    relay.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'relay-test', version: '0' } } }) + '\n');
    await until(() => out.includes('"id":1'), 12000, 'initialize answered through the relay');
    relay.stdin.end();
    await new Promise((r) => relay.on('close', r));
    const env = sp.envs[0];
    for (const k of ['CODEX_MCP_NODE_PATH', 'MULTI', 'QUOTE']) assert.equal(env[k], appEnv[k], k);
  } finally { srv.close(); await h.close(); }
});
