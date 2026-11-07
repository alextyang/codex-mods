// The native probe's G-apphost part (scripts/qa/probe/native.cjs), headless: its load-time edit holds the window's AppHost at a listener of the app's
// shape, and its commands describe, call, run app actions, and wrap a window's service entry without touching the shared service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'probe', 'native.cjs');
// The listener as it appears in 26.1013.40934 (20770), with its minified names changed to show they are not assumed.
const LISTENER = 'Q.ipcMain.on(K.Zz,ev=>{if(!T(ev))return;let[p]=ev.ports,m=w(ev.sender),h=m?.createAppHost(ev.sender),s=S1(p,h);m?.registerAppView(ev.sender,s).catch(()=>{})});';

function load(root) {
  const compiled = [];
  const Module = { prototype: { _compile(content, filename) { compiled.push({ content, filename }); } } };
  const ctx = { require: (n) => (n === 'module' ? Module : require(n)), globalThis: null, setInterval, clearInterval, console, process, Error, Proxy, Reflect, JSON, Map, Set, WeakSet, Promise, Object, Number, String };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(PROBE, 'utf8').split("'__CODEXMODS_ROOT__'").join(JSON.stringify(root)), ctx);
  return { ctx, Module, compiled };
}

async function send(root, cmd) {
  const id = `t${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(path.join(root, 'qa', 'probe', 'in', `${id}.json`), JSON.stringify(cmd));
  const out = path.join(root, 'qa', 'probe', 'out', `${id}.json`);
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('G-apphost probe: holds the AppHost at the listener and answers commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-probe-'));
  try {
    const { ctx, Module, compiled } = load(root);
    Module.prototype._compile.call({}, `x();${LISTENER}`, '/A.app/Contents/Resources/app.asar/.vite/build/main-AbC.js');
    Module.prototype._compile.call({}, LISTENER, '/A.app/Contents/Resources/app.asar/.vite/build/other.js');
    assert.match(compiled[0].content, /globalThis\.__codexmodsQaAppHost\?\.\(\{sender:ev\.sender,host:h,view:s,manager:m\}\);m\?\.registerAppView\(ev\.sender,s\)/);
    assert.equal(compiled[1].content, LISTENER, 'only the main chunk is edited');

    // Run the edited listener with fakes of the app's objects.
    class Settings { #v = { theme: 'light' }; read(k) { return this.#v[k]; } async write(k, v) { this.#v[k] = v; return true; } }
    const shared = new Settings();
    const services = { settings: shared, appInfo: { get: async () => ({ version: '26.1013.40934' }) } };
    const host = { services };
    const actions = [];
    const sender = { id: 7, getURL: () => 'app://-/index.html', isDestroyed: () => false, once() {} };
    const fake = { ipcMain: { on: (_c, fn) => fn({ ports: ['port'], sender }) }, T: () => true, w: () => ({ createAppHost: () => host, registerAppView: async () => {} }),
      S1: () => ({ services: Promise.resolve({ appActions: { run: async (a) => { actions.push(a); return { ran: a.action.type }; } } }) }) };
    vm.runInNewContext(compiled[0].content.replace('x();', '').replace('Q.ipcMain', 'fake.ipcMain').replace('K.Zz', '"c"'), { ...fake, fake, globalThis: ctx });

    assert.deepEqual((await send(root, { op: 'views' })).result, [{ wc: 7, url: 'app://-/index.html', services: ['appInfo', 'settings'], wrapped: [] }]);
    assert.deepEqual((await send(root, { op: 'describe', path: ['settings'] })).result, { ctor: 'Settings', own: [], methods: ['read', 'write'] });
    assert.deepEqual((await send(root, { op: 'call', path: ['appInfo', 'get'] })).result, { version: '26.1013.40934' });
    const act = await send(root, { op: 'action', args: { action: { type: 'app.get_summary', windowId: 'current' } } });
    assert.deepEqual([act.result, actions.length], [{ ran: 'app.get_summary' }, 1]);

    // The hold interposes on this window's entries at once (the window keeps the stubs it first reads); members pass through to the real
    // instance (private fields work) until a mode is turned on.
    assert.notEqual(services.settings, shared);
    assert.equal(services.settings.read('theme'), 'light');
    assert.equal((await send(root, { op: 'wrap', path: ['settings', 'write'], mode: 'refuse' })).ok, true);
    await assert.rejects(services.settings.write('theme', 'dark'), /refused by the G-apphost probe: settings\.write/);
    await send(root, { op: 'wrap', path: ['settings', 'write'], mode: 'log' });
    assert.equal(await services.settings.write('theme', 'dark'), true);
    assert.equal(shared.read('theme'), 'dark');
    await send(root, { op: 'wrap', path: ['appInfo'], mode: 'log' });
    assert.deepEqual((await send(root, { op: 'views' })).result[0].wrapped, ['settings.write:log', 'appInfo.*:log']);
    assert.equal((await send(root, { op: 'unwrap', path: ['settings'] })).result.unwrapped, true);
    assert.equal(await services.settings.write('theme', 'light'), true);
    assert.equal(shared.read('theme'), 'light');

    assert.match((await send(root, { op: 'bogus' })).error, /unknown op bogus/);
    const logText = fs.readFileSync(path.join(root, 'qa', 'probe', 'probe.log'), 'utf8');
    assert.match(logText, /"ev":"edit","file":"main-AbC.js","matches":1/);
    assert.match(logText, /"ev":"call","wc":7,"method":"settings.write","mode":"refuse"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
