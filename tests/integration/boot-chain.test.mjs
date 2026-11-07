// The whole boot path in one process tree: real loader.cjs -> real framework/main/index.cjs -> real electron-adapter.cjs
// (over a fake electron module) -> the Host spawned on a Node binary over IPC (real host-process.cjs, real entry-node.mjs)
// -> startHost (fake factories) -> app.sock, reached through the real relay. Only Electron itself is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '../../contracts/layout.mjs';
import { writeFakeCodex, REPO, FIXTURES } from './harness.mjs';

const require = createRequire(import.meta.url);

/** Host processes whose command line contains this test's root. */
let rootForPs = '';
const hostPids = () => execSync('ps -axo pid,command').toString().split('\n').filter((l) => rootForPs && l.includes(rootForPs) && l.includes('entry-node.mjs')).map((l) => Number(l.trim().split(/\s+/)[0]));

test('loader -> framework-main -> Host -> relay -> backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-bc-'));
  const L = layout(root, 'default');
  rootForPs = root;
  const saved = { ...process.env };
  const origLoad = Module._load;
  const handlers = {};
  let quitCalled = false;
  let setPathCalls = [];
  try {
    // ---- a fake app bundle and a framework version that is a symlink to this repo
    const contents = join(root, 'Fake.app', 'Contents');
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    mkdirSync(join(contents, 'Resources', 'cua_node', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(contents, 'Resources', 'cua_node', 'bin', 'node'));
    writeFileSync(join(contents, 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
    const fakeCodex = writeFakeCodex(root);
    copyFileSync(fakeCodex, join(contents, 'Resources', 'codex'));
    chmodSync(join(contents, 'Resources', 'codex'), 0o755);
    mkdirSync(join(L.adapters, '1.0-1'), { recursive: true });
    copyFileSync(join(FIXTURES, 'adapter.json'), join(L.adapters, '1.0-1', 'adapter.json'));
    mkdirSync(L.framework, { recursive: true });
    symlinkSync(REPO, join(L.framework, 'fw1'));
    writeFileSync(L.frameworkCurrent, 'fw1\n');
    mkdirSync(L.profileDir, { recursive: true });
    writeFileSync(L.profileConfig, JSON.stringify({ codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '' }));

    // ---- fake electron
    const fakeElectron = {
      app: {
        on: (ev, fn) => (handlers[ev] ??= []).push(fn), getAppPath: () => join(contents, 'Resources', 'app.asar'),
        quit() {}, relaunch() {}, exit() { quitCalled = true; }, isReady: () => false, whenReady: () => new Promise(() => {}), setPath: (k, v) => setPathCalls.push([k, v]),
      },
      BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      webContents: { fromId: () => null }, ipcMain: { handle() {} }, dialog: {}, session: {},
    };
    Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
    process.env.CODEX_MODS_ROOT = root;
    process.env.CODEXMODS_TEST_FACTORIES = join(FIXTURES, 'fake-factories.mjs');
    mkdirSync(L.flags, { recursive: true });
    writeFileSync(join(L.flags, 'graph-off'), '');   // the fake factories build no graph (it is on by default, E6)

    // ---- run the real loader
    const src = readFileSync(join(REPO, 'loader', 'loader.cjs'), 'utf8').replace('__CODEXMODS_ROOT__', root);
    new Function('require', 'process', src)(require, Object.assign(Object.create(process), { env: process.env, resourcesPath: join(contents, 'Resources') }));

    assert.deepEqual(setPathCalls, [['userData', L.userData]]);
    assert.equal(process.env.CODEX_HOME, L.codexHome);
    assert.equal(JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8')).state, 'booting');
    assert.equal(process.env.CODEX_MODS_RUN_DIR, L.run);
    assert.equal(process.env.CODEX_MODS_REAL_CODEX, join(contents, 'Resources', 'codex'));
    assert.equal(process.env.CODEX_CLI_PATH, join(contents, 'Resources', 'codexmods-relay'));
    assert.ok(!existsSync(join(L.flags, 'last-loader-error.json')), existsSync(join(L.flags, 'last-loader-error.json')) ? readFileSync(join(L.flags, 'last-loader-error.json'), 'utf8') : '');

    // ---- wait for the Host to listen, then talk through the real relay
    const sock = join(L.run, 'app.sock');
    for (let i = 0; i < 100 && !existsSync(join(L.run, 'mgmt.sock')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(sock), 'Host is listening: ' + (existsSync(join(L.logs, 'host-stdio.log')) ? readFileSync(join(L.logs, 'host-stdio.log'), 'utf8') : 'no stdio log') + (existsSync(join(L.logs, 'main.log')) ? readFileSync(join(L.logs, 'main.log'), 'utf8') : ''));
    const relay = spawn(join(REPO, 'relay', 'relay'), ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'], { env: { PATH: process.env.PATH, CODEX_MODS_RUN_DIR: process.env.CODEX_MODS_RUN_DIR, CODEX_MODS_FLAGS_DIR: process.env.CODEX_MODS_FLAGS_DIR, CODEX_MODS_REAL_CODEX: process.env.CODEX_MODS_REAL_CODEX } });
    let out = '';
    relay.stdout.on('data', (d) => { out += d; });
    relay.stdin.write('{"id":1,"method":"initialize","params":{}}\n');
    for (let i = 0; i < 100 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.parse(out.split('\n')[0]).result.codexHome, L.codexHome);
    relay.kill();

    // ---- quit: framework-main asks the Host to shut down, then lets the app quit
    let held = false;
    for (const h of handlers['will-quit'] ?? []) h({ preventDefault: () => { held = true; } });      // the quit is certain: the Host is stopped, then the app exits
    assert.equal(held, true);
    for (let i = 0; i < 100 && !quitCalled; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(quitCalled, true, 'the app exits once the Host has stopped');
    assert.ok(!existsSync(sock), 'the Host shut down and removed its socket');
    assert.deepEqual(hostPids(), [], 'no Host process left');
  } finally {
    Module._load = origLoad;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    for (const pid of hostPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
