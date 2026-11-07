// Shared helpers for the slice*.test.mjs integration tests. Test-only; nothing here is product code.
// Everything runs the REAL Host (framework/host/entry-node.mjs under plain Node) with the real mux, runtime, packages, operations
// and management, the real CLI and the real relay. Only the codex backend is the fake app-server (via the harness' fake-codex).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, FRAMEWORK_VERSION, startHeadless } from '../harness.mjs';

export { REPO, FRAMEWORK_VERSION };
export const CLI = join(REPO, 'cli', 'codexmods.mjs');
export const RELAY = join(REPO, 'relay', 'relay');
/** The protocol-plane counter (tests/fixtures/mods/counter): the lifecycle test's mod, which counts new threads on the app-server plane. */
export const COUNTER = join(REPO, 'tests', 'fixtures', 'mods', 'counter');
/** Test fixture mods (test.*): minimal mods the integration tests install; not product mods. */
export const FIXTURE_MODS = join(fileURLToPath(new URL('.', import.meta.url)), 'mods');

/** A short temp root. Unix socket paths are limited to 104 bytes, and os.tmpdir() on macOS is long. */
export const shortRoot = (prefix = 'cms-') => mkdtempSync(join('/tmp', prefix));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() returns something truthy (or throws nothing and returns truthy); fail with `what` after timeoutMs. */
export async function waitFor(what, fn, timeoutMs = 10_000, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/** Runs the CLI without a Host (keygen, pack). Returns {status, stdout, stderr, json?}. */
export function cliOffline(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  let json; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Writes a mod directory: files is {relativePath: contents}; mod.json is built from `manifest`. */
export function writeModDir(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mod.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

/** A copy of the counter fixture with the id (and optionally version / permissions) substituted. */
export function counterCopy(dir, { id, version, permissions, extraManifest } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['host.mjs', 'renderer.mjs']) copyFileSync(join(COUNTER, f), join(dir, f));
  const m = JSON.parse(readFileSync(join(COUNTER, 'mod.json'), 'utf8'));
  m.id = id;
  if (version) m.version = version;
  if (permissions) m.permissions = permissions;
  Object.assign(m, extraManifest ?? {});
  writeFileSync(join(dir, 'mod.json'), JSON.stringify(m, null, 2));
  return dir;
}

/** keygen + pack through the real CLI. Returns the path of the .codexmod. */
export function makeKey(dir, name = 'key.pem') {
  const keyFile = join(dir, name);
  const r = cliOffline(['keygen', '--out', keyFile, '--json']);
  if (r.status !== 0) throw new Error(`keygen failed: ${r.stderr}`);
  return { keyFile, ...r.json };
}
export function packMod(modDir, keyFile, outFile) {
  const r = cliOffline(['pack', modDir, '--key', keyFile, '--out', outFile, '--json']);
  if (r.status !== 0) throw new Error(`pack failed (${r.status}): ${r.stderr}${r.stdout}`);
  return { file: outFile, ...r.json };
}

/**
 * The real-module Host of tests/integration/harness.mjs startHeadless (which reports the real framework version, so mods'
 * `framework` ranges are satisfied), under the caller's root. cli(args, timeoutMs) keeps this kit's historical signature.
 */
export async function startRealHost({ root, env: extraEnv = {} }) {
  const h = await startHeadless({ root, realModules: true, env: extraEnv });
  const cli = h.cli;
  h.cli = (args, timeout = 30_000) => cli(args, {}, timeout);
  return h;
}

/**
 * A running real-module Host under a short root, with CLI and app-session helpers.
 * opts.root: reuse a root (a restart). opts.env: extra Host environment.
 */
export async function startSlice(opts = {}) {
  const root = opts.root ?? shortRoot();
  const host = await startRealHost({ root, env: opts.env });
  const sessions = new Set();
  const slice = {
    root, host,
    layout: host.layout,
    /** Runs `codexmods <args> --json --root <root>`; returns {status, stdout, stderr, json}. */
    cli(args, { json = true, timeoutMs } = {}) {
      const r = host.cli(json ? [...args, '--json'] : args, timeoutMs);
      let parsed; try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { ...r, json: parsed };
    },
    /** A mutation: runs the command, follows the op to its end, and returns the final OpRecord (or the failure). */
    mutate(args, timeoutMs) {
      const r = slice.cli(args, { timeoutMs });
      return { ...r, op: r.json && r.json.id && r.json.outcome ? r.json : undefined };
    },
    inspect(modId) { const r = slice.cli(['mods', 'inspect', modId]); return r.status === 0 ? r.json : null; },
    list() { return slice.cli(['mods', 'list']).json?.mods ?? []; },
    /** The app, connected through the REAL relay exactly as the app's backend spawn would be (ipc.d.ts section 5). */
    app(argv = ['app-server']) {
      const s = relaySession(host, argv);
      sessions.add(s);
      return s;
    },
    /** Every line the fake backend received (any session), parsed. */
    backendReceived() {
      if (!existsSync(host.backendLog)) return [];
      return readFileSync(host.backendLog, 'utf8').split('\n').filter(Boolean).map((l) => {
        const sp = l.indexOf(' ');
        try { return { backend: l.slice(0, sp), msg: JSON.parse(l.slice(sp + 1)) }; } catch { return { backend: l.slice(0, sp), raw: l.slice(sp + 1) }; }
      });
    },
    threadStarts() { return slice.backendReceived().filter((x) => x.msg?.method === 'thread/start').map((x) => x.msg); },
    async stop({ keepRoot = false } = {}) {
      for (const s of sessions) s.kill();
      const r = await host.stop();
      if (!keepRoot) rmSync(root, { recursive: true, force: true });
      return r;
    },
  };
  return slice;
}

/** The app side of the relay: spawns relay/relay with the environment framework-main gives the app's backend spawn. */
export function relaySession(host, argv = ['app-server']) {
  const child = spawn(RELAY, argv, {
    env: host.relayEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', stderr = '';
  const lines = [], waiters = [];
  const flush = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const idx = lines.findIndex(w.pred);
      if (idx >= 0) { const [l] = lines.splice(idx, 1); waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(l); }
    }
  };
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, nl))); } catch { /* ignore */ } buf = buf.slice(nl + 1); }
    flush();
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  let nextId = 1;
  const s = {
    child, lines, exited,
    get stderr() { return stderr; },
    send: (obj) => child.stdin.write(JSON.stringify(obj) + '\n'),
    next: (pred = () => true, timeoutMs = 10_000) => new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for a line (relay stderr: ${stderr})`)); }, timeoutMs) };
      waiters.push(w); flush();
    }),
    /** Sends a request and resolves with the matching response (the whole JSON-RPC message). */
    async request(method, params, timeoutMs) {
      const id = nextId++;
      s.send({ id, method, params });
      return s.next((m) => m.id === id && m.method === undefined, timeoutMs);
    },
    notify: (method, params) => s.send(params === undefined ? { method } : { method, params }),
    /** initialize + initialized */
    async handshake() {
      const r = await s.request('initialize', { clientInfo: { name: 'slice-test', version: '1' }, capabilities: null });
      s.notify('initialized');
      return r;
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* gone */ } },
  };
  return s;
}

/** Remove leftover files of a failed test. */
export function rmrf(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
export const listDir = (p) => { try { return readdirSync(p); } catch { return []; } };

// ---------------------------------------------------------------- the test.migrator mod
export const MIGRATOR_ID = 'test.migrator';
const ID = MIGRATOR_ID;
const SETTINGS = [{ key: 'note', kind: 'text', title: 'Note', default: '' }];

/** Every version tags thread/start with its own version so a test can see which code is live. */
const hostSrc = (version, { activateDelayMs = 0, faultAfterActivate = false } = {}) => `
export default { async host(ctx) {
  ${activateDelayMs ? `await new Promise((r) => setTimeout(r, ${activateDelayMs}));` : ''}
  ${faultAfterActivate ? `setTimeout(() => { throw new Error('v' + '${version}' + ' faults after activation'); }, 300);` : ''}
  ctx.appServer.intercept('clientRequest', ['thread/start'], (m) => ({ replace: { ...m, params: { ...(m.params ?? {}), config: { ...(m.params?.config ?? {}), mod_version: '${version}' } } } }), { timeoutMs: 500, onError: 'pass' });
} };`;
const migrateSrc = (ms, throws) => `
export async function migrate({ settings }) {
  await new Promise((r) => setTimeout(r, ${ms}));
  ${throws ? "settings.set({ note: 'half-migrated' }); throw new Error('migration blew up');" : ''}
  settings.set({ ...(settings.get() ?? {}), note: 'migrated' });
}`;

/**
 * A signed package of the test mod "test.migrator": settings {note}, a thread/start interceptor that tags config.mod_version with
 * its own version, data schema `schema` (0 = none) with an optional migration of migrateMs, optional slow/faulty activation.
 * Returns the .codexmod path.
 */
export function buildMigrator(work, key, version, schema, { migrateMs, activateDelayMs, faultAfterActivate = false, migrateThrows = false } = {}) {
  const dir = writeModDir(join(work, `src-${version}`), {
    id: ID, version, name: 'Migrator', framework: '>=1 <2', entry: { host: 'host.mjs' },
    permissions: ['appServer.intercept:thread/start'], settings: SETTINGS,
    data: schema === 0 ? undefined : { schemaVersion: schema, ...(migrateMs !== undefined ? { migrate: 'migrate.mjs' } : {}) },
  }, { 'host.mjs': hostSrc(version, { activateDelayMs, faultAfterActivate }), ...(migrateMs !== undefined ? { 'migrate.mjs': migrateSrc(migrateMs, migrateThrows) } : {}) });
  return packMod(dir, key.keyFile, join(work, `${version}.codexmod`)).file;
}

