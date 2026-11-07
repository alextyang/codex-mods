// Host crash history across simulated app relaunches: real loader.cjs, real framework-main (fake electron, fake Host processes)
// and real startHost (fake factories). framework-main records each crash, the loader must carry the history across every
// relaunch, and only startHost's quarantine step clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '../../contracts/layout.mjs';
import { startHost } from '../../framework/host/main.mjs';
import { createFakeFactories } from './fixtures/fake-factories.mjs';
import { REPO, FIXTURES } from './harness.mjs';

const require = createRequire(import.meta.url);

test('hostCrashCount survives relaunches; the second crash within ten minutes quarantines the breadcrumbed mods at the next Host start, which clears the history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cr-'));
  const L = layout(root, 'default');
  const saved = { ...process.env };
  try {
    const contents = join(root, 'Fake.app', 'Contents');
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
    mkdirSync(join(L.adapters, '1.0-1'), { recursive: true });
    copyFileSync(join(FIXTURES, 'adapter.json'), join(L.adapters, '1.0-1', 'adapter.json'));
    mkdirSync(join(L.framework, 'fw1', 'framework', 'main'), { recursive: true });
    writeFileSync(join(L.framework, 'fw1', 'framework', 'main', 'index.cjs'),
      `exports.start = (a) => require(${JSON.stringify(join(REPO, 'framework', 'main', 'index.cjs'))}).start(a, globalThis.__spineDeps);`);
    writeFileSync(L.frameworkCurrent, 'fw1\n');
    mkdirSync(L.profileDir, { recursive: true });
    writeFileSync(L.profileConfig, JSON.stringify({ codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath: '' }));
    mkdirSync(L.flags, { recursive: true });
    writeFileSync(join(L.flags, 'graph-off'), '');   // the fake factories build no graph (it is on by default, E6)

    const boot = () => JSON.parse(readFileSync(join(L.flags, 'boot.json'), 'utf8'));
    const electronFor = () => ({
      app: { on() {}, getAppPath: () => join(contents, 'Resources', 'app.asar'), quit() {}, relaunch() {}, exit() {}, setPath() {} },
      registerScheme() {}, handleProtocol() {}, onWindowCreated() {},
    });
    /** One app launch: loader -> framework-main; returns the (fake) Host process of that launch. */
    function launch() {
      const host = { posted: [], exits: [], msgs: [] };
      globalThis.__spineDeps = {
        electron: electronFor(), loadModule: () => { const e = new Error('absent'); e.code = 'MODULE_NOT_FOUND'; throw e; },
        spawnHost: () => ({ postMessage: (m) => host.posted.push(m), onMessage: (fn) => host.msgs.push(fn), onExit: (fn) => host.exits.push(fn), kill() {} }),
      };
      const fakeProc = { env: { ...process.env, CODEX_MODS_ROOT: root }, pid: process.pid, resourcesPath: join(contents, 'Resources') };
      const electron = { app: { setPath() {}, relaunch() {}, exit() {} } };
      const src = readFileSync(join(REPO, 'loader', 'loader.cjs'), 'utf8').replace('__CODEXMODS_ROOT__', root);
      new Function('require', 'process', src)((id) => (id === 'electron' ? electron : require(id)), fakeProc);
      return host;
    }
    const crash = (host, mods) => { host.msgs.forEach((f) => f({ type: 'breadcrumbs', mods })); host.exits.forEach((f) => f(139)); };

    // launch 1: crash with a.b and c.d active
    crash(launch(), ['a.b', 'c.d']);
    assert.equal(boot().hostCrashCount, 1);
    // relaunch 2 (the loader rewrites the marker): history must still be there, then another crash
    const h2 = launch();
    assert.equal(boot().hostCrashCount, 1, 'loader carried the count over');
    assert.deepEqual(boot().breadcrumbs, ['a.b', 'c.d']);
    assert.ok(boot().lastHostCrashAt);
    crash(h2, ['c.d']);
    assert.equal(boot().hostCrashCount, 2);
    // relaunch 3: still there after another loader pass
    launch();
    assert.equal(boot().hostCrashCount, 2); assert.deepEqual(boot().breadcrumbs, ['c.d']);

    // the Host that starts after relaunch 3 reaches the quarantine threshold and is the only one to clear the history
    const rec = [];
    const layoutObj = JSON.parse(JSON.stringify(L));
    const host = await startHost({
      layout: layoutObj, profile: JSON.parse(readFileSync(L.profileConfig, 'utf8')), adapterDir: join(L.adapters, '1.0-1'),
      realCodexPath: '/nonexistent', frameworkVersion: 't', appBuild: '1.0-1', safeMode: false,
      factories: createFakeFactories(rec), ps: async () => '',
    });
    assert.deepEqual(rec.filter((x) => x.startsWith('operations.quarantine')), ['operations.quarantine:c.d:host-crash']);
    assert.equal(boot().hostCrashCount, 0); assert.equal(boot().breadcrumbs, undefined);
    await host.close();
    launch();
    assert.equal(boot().hostCrashCount, 0, 'cleared history stays cleared');
    assert.ok(existsSync(L.flags));
  } finally {
    delete globalThis.__spineDeps;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
