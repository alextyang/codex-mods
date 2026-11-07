// Headless Host harness (tests/integration). startHeadless() starts framework/host/entry-node.mjs as a child
// process under a fresh temp root, with the fake app-server standing in for the real codex binary.
//
// REAL MODULES: by default the Host's other module factories are replaced by
// tests/integration/fixtures/fake-factories.mjs through the test-only CODEXMODS_TEST_FACTORIES hook. Set
// CODEXMODS_REAL_MODULES=1 (or pass { realModules: true }) and the harness omits the override, so the real
// createBus/createMux/createRuntime/createPackages/createOperations/createRecovery/createManagement are used.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout as makeLayout, SOCKETS } from '../../contracts/layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..');
export const FIXTURES = join(here, 'fixtures');
export const FAKE_APP_SERVER = join(REPO, 'tests', 'fixtures', 'fake-app-server.mjs');
/** The version a real boot reports (framework-main reads <frameworkDir>/package.json); mods' `framework` ranges are checked against it. */
export const FRAMEWORK_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
export const USE_REAL_MODULES = process.env.CODEXMODS_REAL_MODULES === '1';

/** Executable stand-in for the real codex binary: runs the fake app-server under the same node. */
export function writeFakeCodex(dir) {
  const file = join(dir, 'fake-codex');
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${join(FIXTURES, 'record-argv.mjs')}' "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A JSONL client on a Unix socket. Lines are kept as raw Buffers so tests can assert byte equivalence. */
export function jsonlClient(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let pending = Buffer.alloc(0);
    const lines = [], waiters = [];
    const flush = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const idx = lines.findIndex((l) => w.pred(l));
        if (idx >= 0) { const [l] = lines.splice(idx, 1); waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(l); }
      }
    };
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      let nl;
      while ((nl = pending.indexOf(0x0a)) >= 0) { lines.push(pending.subarray(0, nl)); pending = pending.subarray(nl + 1); }
      flush();
    });
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.off('error', reject); sock.on('error', () => {});
      const client = {
        socket: sock, lines,
        sendRaw: (text) => sock.write(typeof text === 'string' ? text + '\n' : Buffer.concat([text, Buffer.from('\n')])),
        send: (obj) => client.sendRaw(JSON.stringify(obj)),
        /** Next unread line (Buffer) satisfying pred, within timeoutMs. */
        next: (pred = () => true, timeoutMs = 10_000) => new Promise((res, rej) => {
          const w = { pred, resolve: res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out waiting for a line')); }, timeoutMs) };
          waiters.push(w); flush();
        }),
        nextJson: async (pred = () => true, timeoutMs) => JSON.parse((await client.next((b) => pred(JSON.parse(b.toString('utf8'))), timeoutMs)).toString('utf8')),
        closed: new Promise((r) => sock.once('close', r)),
        close: () => { sock.destroy(); },
      };
      resolve(client);
    });
  });
}

/**
 * @param {{ root?: string, adapterBackend?: object, realModules?: boolean, factories?: string, env?: Record<string,string>, safeMode?: boolean }} [opts]
 *   The graph is on by default (E6); the fake factories build none, so with them the Host runs with flags/graph-off.
 */
export async function startHeadless(opts = {}) {
  const ownsRoot = !opts.root;
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'cm-hl-'));   // short: Unix socket paths are limited to 103 bytes
  const L = makeLayout(root, 'default');
  for (const d of [L.profileDir, L.flags, L.run, L.logs, L.framework]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const adapterDir = join(L.adapters, '1.0-1');
  mkdirSync(adapterDir, { recursive: true });
  if (opts.adapterBackend) {       // a pack variant: merge extra fields into backend (e.g. configOverrides)
    const pack = JSON.parse(readFileSync(join(FIXTURES, 'adapter.json'), 'utf8'));
    pack.backend = { ...pack.backend, ...opts.adapterBackend };
    writeFileSync(join(adapterDir, 'adapter.json'), JSON.stringify(pack, null, 2));
  } else copyFileSync(join(FIXTURES, 'adapter.json'), join(adapterDir, 'adapter.json'));
  writeFileSync(L.frameworkCurrent, 'headless\n');
  const profile = { codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '' };
  writeFileSync(L.profileConfig, JSON.stringify(profile, null, 2));
  const realCodexPath = writeFakeCodex(root);
  const backendLog = join(root, 'backend-received.log');
  const argvLog = join(root, 'backend-argv.log');

  const options = { layout: L, profile, adapterDir, realCodexPath, frameworkVersion: FRAMEWORK_VERSION, appBuild: '1.0-1', safeMode: !!opts.safeMode };
  const env = { ...process.env, CODEX_MODS_ROOT: root, CODEX_MODS_PROFILE: 'default', FAKE_APP_SERVER_LOG: backendLog, CODEXMODS_ARGV_LOG: argvLog, CODEXMODS_EXIT_ON_STDIN_EOF: '1', ...(opts.env ?? {}) };
  const real = opts.realModules ?? USE_REAL_MODULES;
  if (!real) { env.CODEXMODS_TEST_FACTORIES = opts.factories ?? join(FIXTURES, 'fake-factories.mjs'); writeFileSync(join(L.flags, 'graph-off'), ''); }
  else delete env.CODEXMODS_TEST_FACTORIES;

  const child = spawn(process.execPath, [join(REPO, 'framework', 'host', 'entry-node.mjs'), JSON.stringify(options)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host did not become ready in 60 s\nstderr: ${stderr}`)), 60_000);
      child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('"ready"')) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Host exited early (${code})\nstderr: ${stderr}`)); });
    });
  } catch (e) {
    // the caller never gets a handle to stop it: a Host left running holds this file's pipes and keeps the test process alive for good
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
    throw e;
  }

  const clients = new Set();
  const handle = {
    root, layout: L, profile, options, backendLog, argvLog, child,
    get stderr() { return stderr; },
    /** A JSONL client on app.sock that plays the app. */
    async appConnection() { const c = await jsonlClient(join(L.run, SOCKETS.app)); clients.add(c); return c; },
    /** The environment the app gives the relay (framework-main's variables, contracts/ipc.d.ts section 5). The relay forwards it
     *  and the mux spawns the primary backend from it (mux addition 9), so it also carries the fake backend's fixture variables. */
    relayEnv(extra = {}) {
      return {
        PATH: process.env.PATH, CODEX_MODS_RUN_DIR: L.run, CODEX_MODS_FLAGS_DIR: L.flags, CODEX_MODS_REAL_CODEX: '/nonexistent/never-run',
        FAKE_APP_SERVER_LOG: backendLog, CODEXMODS_ARGV_LOG: argvLog, CODEXMODS_EXIT_ON_STDIN_EOF: '1', ...(opts.env ?? {}), ...extra,
      };
    },
    /** argv of every backend process the Host started (one array per line of the log). */
    backendArgvs() { return existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; },
    /** Runs cli/codexmods.mjs against this root. */
    cli(args, extra = {}, timeoutMs = 30_000) {
      const r = spawnSync(process.execPath, [join(REPO, 'cli', 'codexmods.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: timeoutMs });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    exited,
    /** SIGKILL: the Host dies with no cleanup (crash tests). Resolves once the process is gone. */
    async killHard() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return exited; },
    async stop() {
      for (const c of clients) c.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let t;
      const r = await Promise.race([exited, new Promise((res) => { t = setTimeout(() => res(null), 8000); })]);
      clearTimeout(t);          // a pending 8 s timer would keep the test process alive after every test
      if (r === null) { child.kill('SIGKILL'); await exited; }
      if (ownsRoot) rmSync(root, { recursive: true, force: true });
      return r;
    },
  };
  return handle;
}

export const cliExists = () => existsSync(join(REPO, 'cli', 'codexmods.mjs'));
