// Synthetic tests for the container locator (no stock app needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker, SHARE_ENV } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { bareIdSite, signatureRanges, findSites, findNativePipeSites, deriveCuaContainerPatches, deriveCuaContainerTransform, computerUsePaths, remainingComputerUsePaths, installerReachable, helperStartSites, GROUP, TMP_DIR, BARE, rename, NATIVE_PIPE_EDITS, COMPUTER_USE_DIR_ENV } from './cua-container.mjs';
import { applyAll, sealTransforms } from './transform.mjs';
import { applyBinaryPatches } from './binary-patch.mjs';

/** Thin arm64 Mach-O with LC_CODE_SIGNATURE (cmd 0x1d) covering [sigOff, sigOff+sigLen). */
function macho(size, sigOff, sigLen) {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(1, 16);
  b.writeUInt32LE(0x1d, 32); b.writeUInt32LE(16, 36); b.writeUInt32LE(sigOff, 40); b.writeUInt32LE(sigLen, 44);
  return b;
}
const fat = (slices) => {
  const head = Buffer.alloc(8 + slices.length * 20); head.writeUInt32BE(0xcafebabe, 0); head.writeUInt32BE(slices.length, 4);
  let off = 0x1000; const parts = [];
  slices.forEach((s, i) => { head.writeUInt32BE(0x0100000c, 8 + i * 20); head.writeUInt32BE(off, 8 + i * 20 + 8); head.writeUInt32BE(s.length, 8 + i * 20 + 12); parts.push([off, s]); off += 0x1000 * Math.ceil(s.length / 0x1000); });
  const out = Buffer.alloc(off); head.copy(out); for (const [o, s] of parts) s.copy(out, o); return out;
};
const put = (b, off, s) => Buffer.from(s).copy(b, off);

test('findSites ignores occurrences inside a code signature (thin and fat) and reports the rest', () => {
  const b = macho(0x400, 0x200, 0x100);
  put(b, 0x100, GROUP); put(b, 0x220, GROUP); put(b, 0x300, TMP_DIR);
  assert.deepEqual(signatureRanges(b), [[0x200, 0x300]]);
  assert.deepEqual(findSites(b).map((s) => [s.needle, s.offset]), [[GROUP, 0x100], [TMP_DIR, 0x300]]);
  const s1 = macho(0x300, 0x200, 0x80); put(s1, 0x40, GROUP); put(s1, 0x210, GROUP);
  const s2 = macho(0x300, 0x200, 0x80); put(s2, 0x210, GROUP);
  const f = fat([s1, s2]);
  assert.equal(signatureRanges(f).length, 2);
  assert.deepEqual(findSites(f).map((s) => s.offset), [0x1000 + 0x40], 'the x86 slice signature copy is not a behavioural site');
  assert.deepEqual(signatureRanges(Buffer.from('plain text')), []);
});

function fakeContents(drop = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-cua-'));
  const files = {
    'Resources/cua_node/bin/node_repl': () => { const b = macho(0x400, 0x300, 0x80); put(b, 0x100, `HOME/Library/Group Containers/${GROUP}/Library`); return b; },
    'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService': () => { const b = macho(0x800, 0x700, 0x80); put(b, 0x100, GROUP); put(b, 0x200, TMP_DIR); put(b, 0x300, BARE); put(b, 0x710, GROUP); return b; },
    'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient': () => { const b = macho(0x400, 0x300, 0x80); put(b, 0x100, GROUP); put(b, 0x180, `${BARE}.cli`); return b; },
    'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist': () => Buffer.from(`<key>CFBundleIdentifier</key><string>${BARE}</string>`),
    'Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js': () => Buffer.from(`join(i(),"Library","Group Containers","${GROUP}","IPC","computeruse.sock") a(null==e?void 0:e.SKY_CUA_SERVICE_PATH);s.join(n,"computer-use","Codex Computer Use.app") {bundleIdentifier:"${BARE}"}`),
    'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Resources/BUILD.bazel': () => Buffer.from(`group = "${GROUP}"`),
  };
  for (const [rel, mk] of Object.entries(files)) { if (drop.includes(rel.split('/').pop())) continue; mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), mk()); }
  return dir;
}

test('deriveCuaContainerPatches renames the container id, lock-screen dir AND bundle identifier (binaries, plist, native client), leaves inert files alone, chains per file', () => {
  const dir = fakeContents();
  try {
    const { patches, missing } = deriveCuaContainerPatches(dir);
    assert.deepEqual(missing, []);
    assert.equal(patches.length, 11, 'node_repl 1, service 3, client 2, plist 1, native-pipe 4 (container, env, CODEX_HOME fallback, bundle id), plus no BUILD.bazel');
    assert.ok(!patches.some((p) => p.file.endsWith('BUILD.bazel')));
    const svc = patches.filter((p) => p.file.endsWith('SkyComputerUseService'));
    assert.equal(svc.length, 3, 'container, /tmp dir, bare id');
    assert.equal(svc[1].sha256Before, svc[0].sha256After);
    const { readFileSync } = await_import_fs();
    const out = applyBinaryPatches(readFileSync(join(dir, svc[0].file)), svc);
    assert.ok(out.includes(Buffer.from(rename(GROUP))) && out.includes(Buffer.from(rename(TMP_DIR))));
    assert.deepEqual(findSites(out).map((s) => s.offset), [], 'signature copy at 0x710 is still ignored, nothing else left');
    assert.equal(out.subarray(0x300, 0x300 + BARE.length).toString(), rename(BARE), 'the bare bundle id is renamed too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import * as fs from 'node:fs';
function await_import_fs() { return fs; }

test('fails closed (reports missing, emits no patches) when an expected helper site is absent', () => {
  for (const drop of ['SkyComputerUseClient', 'node_repl', 'native-pipe.js']) {
    const dir = fakeContents([drop]);
    try {
      const { patches, missing } = deriveCuaContainerPatches(dir);
      assert.deepEqual(patches, [], drop);
      assert.ok(missing.some((m) => m.item.includes(drop) && m.mandatory === true), `${drop}: ${JSON.stringify(missing)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('native-pipe.js: the env-variable and CODEX_HOME-fallback edits are exact, once per file, and fail closed when a site is duplicated or missing', () => {
  const dir = fakeContents();
  try {
    const { patches } = deriveCuaContainerPatches(dir);
    const np = patches.filter((p) => p.file.endsWith('native-pipe.js'));
    const texts = np.map((p) => Buffer.from(p.before, 'hex').toString());
    for (const e of NATIVE_PIPE_EDITS) assert.ok(texts.includes(e.before), e.key);
    const out = applyBinaryPatches(readFileSync(join(dir, np[0].file)), np);
    const t = out.toString();
    assert.ok(!t.includes('SKY_CUA_SERVICE_PATH)') && t.includes('e.SKY_CUA_SERVICE_PATM)'));
    assert.ok(!t.includes('join(n,"computer-use"') && t.includes('join(n,"computer-usf","Codex Computer Use.app")'));
    assert.ok(findNativePipeSites(out).every((x) => x.offsets.length === 0), 'nothing of the original edits remains');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dup = fakeContents();
  try {
    const f = join(dup, 'Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js');
    writeFileSync(f, readFileSync(f).toString() + ' a(null==e?void 0:e.SKY_CUA_SERVICE_PATH);');
    const r = deriveCuaContainerPatches(dup);
    assert.deepEqual(r.patches, []);
    assert.ok(r.missing.some((m) => /occurs 2 times, expected exactly 1/.test(m.tried) && m.mandatory));
  } finally { rmSync(dup, { recursive: true, force: true }); }
});

// ---- asar side
function fakeSource(files) {
  return { list: (prefix) => Object.keys(files).filter((p) => p.startsWith(prefix)), read: (p) => files[p], size: (p) => files[p].length };
}
const require = createRequire(import.meta.url);
const MAIN = '.vite/build/main-CLu1A25j.js';
const goodMain = () => [
  'var Ta=`Codex Computer Use.app`,Ea=[1];function Da(e){return C.default.join(e,`computer-use`,Ta)}function Oa(e){return 1}var ka=`X`,Aa=`SKY_CUA_SERVICE_PATH`,ja=`Y`;',
  'kw=new Set([`com.openai.sky.CUAService`,`com.apple.dock`]);var lT=1,uT=`com.openai.sky.CUAService`,dT=`computerUseSoundMode`;',
  `var ohe=\`${GROUP}\`,she=1;`,
  'var QZe=`com.openai.sky.CUAService`;',
  // helper overlay config (kc -> Fc -> Ic), locked-use installer (Phe/Vhe/cT), win32 legacy approvals (Hw), bundled plugin skill file (not the helper)
  'var Sc=`computer-use`,Cc=`config.json`,Ec=new Map;async function kc(){await Fc({codexHome:c.ot(),config:1})}async function Fc({codexHome:e,config:t}){let n=(0,C.join)(e,Sc),r=(0,C.join)(n,Cc),i=(Ec.get(r)??Promise.resolve()).catch(()=>{}).then(()=>Ic({dir:n,configPath:r,config:t}));Ec.set(r,i);try{await i}finally{Ec.get(r)===i&&Ec.delete(r)}return r}',
  'async function Hw(e){let t=C.default.join(C.default.dirname(e),`computer-use`,`config.toml`);if(!(0,y.existsSync)(t))return}',
  'var Nhe=(0,O.promisify)(k.execFile),Phe=[`computer-use`,`Codex Computer Use.app`,`Contents`,`SharedSupport`,`Codex Computer Use Installer.app`,`Contents`,`MacOS`,`Codex Computer Use Installer`];async function Rhe(){if(process.platform!==`darwin`)return null;try{return await sT()}catch{return!1}}',
  'async function Bhe(e){return process.platform===`darwin`?(await cT(e?`install`:`uninstall`),sT()):null}async function sT(){return(await cT(`status`)).trim()===`OK: installed`}async function cT(e){let{stdout:t}=await Nhe(Vhe(),[e],{env:c.bt(process.env),timeout:12e4});return t}function Vhe(){return C.default.join(c.ot(),...Phe)}',
  // the managed Computer Use service: the class joins the executable, pd() is the one spawn site (native addon sky.node)
  'var kie=class{constructor(e,{spawnService:a=pd}={}){this.serviceExecutablePath=C.default.join(e,`Contents`,`MacOS`,`SkyComputerUseService`),this.spawnService=a}};async function pd(e,{addon:t,electronAppPath:n=_.app.getAppPath(),platform:r=process.platform,resourcesPath:i=process.resourcesPath}={}){return r!==`darwin`||e.trim()===``?null:(t??Xu({electronAppPath:n,resourcesPath:i})).spawnComputerUseService(e)}function md(e,t){return 1}',
  'var Ghe=class{async getLockedUseState(){let[e,t]=await Promise.all([Rhe(),zhe()]);return{enabled:e,...t}}setLockedUseEnabled(e){return Bhe(e)}};',
  'async function Tne(e){let t=(0,C.join)(e.pluginRoot,`skills`,`computer-use`,`SKILL.md`);return t}',
].join('\n');
const goodFiles = () => ({ [MAIN]: goodMain(), '.vite/build/worker.js': 'var mFe=`com.openai.sky.CUAService`,hFe=`x`;', '.vite/build/src-DsLVGakC.js': 'VZ=[`a`,`com.openai.sky.CUAService`,`b`]', 'webview/assets/app-x.js': 'x'.repeat(30000) });

test('asar transforms: relocation of the helper dir, config, installer and legacy approvals, distinct service-path variable, container id, and every bare bundle id; all applicable exactly once', async () => {
  const src = fakeSource(goodFiles());
  const { drafts, missing } = deriveCuaContainerTransform(src);
  assert.deepEqual(missing, []);
  assert.deepEqual(drafts.map((d) => d.id), ['cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-disable-locked-use', 'cua-helper-private-home', 'cua-relocate-approvals', 'cua-service-path-env', 'cua-container', 'cua-bundle-id:main:1', 'cua-bundle-id:main:2', 'cua-bundle-id:main:3', 'cua-bundle-id:src:1', 'cua-bundle-id:worker:1']);
  let main = goodMain();
  for (const d of drafts.filter((x) => x.file === MAIN)) main = main.replace(d.find, () => d.text);
  assert.ok(!main.includes(GROUP) && !main.includes(BARE + '`') && !main.includes('=`SKY_CUA_SERVICE_PATH`'));
  // the relocated function really relocates (and never falls back to the stock dir)
  const fnText = /function Da\(e\)\{[^}]*\}/.exec(main)[0];
  const make = (env) => new Function('process', 'C', 'Ta', `${fnText}; return Da;`)({ env }, { default: { join: (...p) => p.join('/') } }, 'Codex Computer Use.app');
  assert.equal(make({ [COMPUTER_USE_DIR_ENV]: '/profiles/p/computer-use' })('/home/.codex'), '/profiles/p/computer-use/Codex Computer Use.app');
  assert.equal(make({})('/home/.codex'), '/home/.codex/computer-use-codexmods/Codex Computer Use.app');
  assert.notEqual(make({})('/home/.codex'), '/home/.codex/computer-use/Codex Computer Use.app');
  assert.ok(main.includes('=`SKY_CUA_SERVICE_PATM`'));

  // the config writer, the installer resolver and the legacy approvals path follow the same directory (and the same never-stock fallback)
  const env = { [COMPUTER_USE_DIR_ENV]: '/profiles/p/computer-use' };
  const C = { default: { join: (...p) => p.join('/'), dirname: (p) => p.slice(0, p.lastIndexOf('/')) }, join: (...p) => p.join('/') };
  const extract = (re) => re.exec(main)[0];
  const cfg = async (e) => { let wrote; const Fc = new Function('process', 'C', 'Sc', 'Cc', 'Ic', 'Ec', `${extract(/async function Fc\(\{[^]*?return r\}/)}; return Fc;`)({ env: e }, C, 'computer-use', 'config.json', async (a) => { wrote = a; }, new Map()); await Fc({ codexHome: '/home/.codex', config: 1 }); return wrote; };
  assert.deepEqual(await cfg(env), { dir: '/profiles/p/computer-use', configPath: '/profiles/p/computer-use/config.json', config: 1 });
  assert.deepEqual(await cfg({}), { dir: '/home/.codex/computer-use-codexmods', configPath: '/home/.codex/computer-use-codexmods/config.json', config: 1 });
  const installer = (e) => new Function('process', 'C', 'c', 'Phe', `${extract(/function Vhe\(\)\{[^}]*\}/)}; return Vhe();`)({ env: e }, C, { ot: () => '/home/.codex' }, ['computer-use', 'Codex Computer Use.app', 'Contents', 'Installer']);
  assert.equal(installer(env), '/profiles/p/computer-use/Codex Computer Use.app/Contents/Installer');
  assert.equal(installer({}), '/home/.codex/computer-use-codexmods/Codex Computer Use.app/Contents/Installer');
  const approvals = async (e) => { const seen = []; await new Function('process', 'C', 'y', `${extract(/async function Hw\(e\)\{[^}]*\}/)}; return Hw;`)({ env: e }, C, { existsSync: (p) => { seen.push(p); return false; } })('/home/.codex/config.toml'); return seen; };
  assert.deepEqual(await approvals(env), ['/profiles/p/computer-use/config.toml']);
  assert.deepEqual(await approvals({}), ['/home/.codex/computer-use-codexmods/config.toml']);
  // locked use: nothing is spawned, the results are the app's own "unsupported" shape (null: row hidden, no toast)
  const spawned = [];
  const lock = new Function('process', 'C', 'c', 'Phe', 'Nhe', 'zhe', `${extract(/async function Rhe\(\)\{[^}]*\}[^}]*\}\}/)}; ${extract(/async function Bhe\(e\)[^]*?(?=function Vhe)/)}; ${extract(/function Vhe\(\)\{[^}]*\}/)}; ${extract(/var Ghe=class\{[^]*?\};/)}; return new Ghe();`);
  for (const platform of ['darwin', 'linux']) {
    const svc = lock({ platform, env: {} }, C, { ot: () => '/home/.codex', bt: (x) => x }, ['computer-use', 'x'], async (...a) => { spawned.push(a); return { stdout: 'OK: installed' }; }, async () => ({ computerIconDataURL: 'c', lockIconDataURL: 'l' }));
    assert.deepEqual(await svc.getLockedUseState(), { enabled: null, computerIconDataURL: 'c', lockIconDataURL: 'l' }, platform);
    assert.equal(await svc.setLockedUseEnabled(true), null);
    assert.equal(await svc.setLockedUseEnabled(false), null);
  }
  assert.deepEqual(spawned, [], 'no spawn/exec of the installer on any platform');
  await assert.rejects(new Function('Nhe', `${extract(/async function cT\(e\)\{throw[^}]*\}/)}; return cT('install');`)(() => spawned.push('x')), /unavailable in this copy/);
  assert.deepEqual(spawned, []);
  // The helper is spawned by a native Napi AsyncWorker: posix_spawn runs LATER on a worker thread and reads the live process environment then. The fake addon below does exactly that
  // (a real worker thread sharing process.env reads CODEX_HOME after a delay), so a swap that is restored when the call returns would be invisible to it.
  const startFake = (delayMs) => {
    const flags = new Int32Array(new SharedArrayBuffer(8)); const buf = new Uint8Array(new SharedArrayBuffer(512));
    const code = `const { workerData: w } = require('node:worker_threads'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, w.delay);
      const b = Buffer.from(process.env.CODEX_HOME ?? '<absent>'); w.buf.set(b); Atomics.store(w.flags, 1, b.length); Atomics.store(w.flags, 0, 1); Atomics.notify(w.flags, 0);`;
    const addon = { spawnComputerUseService: (path) => new Promise((resolve, reject) => { const wk = new Worker(code, { eval: true, env: SHARE_ENV, workerData: { flags, buf, delay: delayMs } }); wk.on('exit', () => resolve({ pid: 4242, path })); wk.on('error', reject); }) };
    return { addon, seenHome: () => Buffer.from(buf.slice(0, Atomics.load(flags, 1))).toString() || null, spawned: () => Atomics.load(flags, 0) === 1 };
  };
  const pdFor = (text, fake) => new Function('process', 'require', '_', 'Xu', `${text.match(/async function pd\(e,[^]*?return started\}/)?.[0] ?? text.match(/async function pd\(e,[^]*?spawnComputerUseService\(e\)\}/)[0]}; return pd;`)(process, (m) => (m === 'child_process' ? { execFileSync: () => (fake.spawned() ? '9001\n' : '') } : require(m)), { app: { getAppPath: () => '/app' } }, () => fake.addon);
  const keep = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/Users/me/.codex';
    // stock pd: the helper reads the app's own CODEX_HOME
    const stock = startFake(25);
    await pdFor(goodMain(), stock)('/x/SkyComputerUseService', { addon: stock.addon });
    assert.equal(stock.seenHome(), '/Users/me/.codex');
    // patched pd: the worker thread sees the profile dir although it reads the environment after the call returned; the app's own value is back afterwards
    process.env[COMPUTER_USE_DIR_ENV] = '/profiles/p/computer-use';
    const t = startFake(25);
    const t0 = Date.now();
    const r = await pdFor(main, t)('/profiles/p/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService', { addon: t.addon });
    assert.deepEqual(r, { pid: 4242, path: '/profiles/p/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService' });
    assert.equal(t.seenHome(), '/profiles/p', 'the helper (worker thread, asynchronous spawn) sees the profile dir as CODEX_HOME');
    assert.equal(process.env.CODEX_HOME, '/Users/me/.codex', 'the app keeps its shared CODEX_HOME');
    assert.ok(Date.now() - t0 < 450, 'returns as soon as the child exists, not after the 500 ms bound');
    // no other JS can observe the swapped value: a timer queued before the call fires only after the restore
    let seenByTimer; const tm = setTimeout(() => { seenByTimer = process.env.CODEX_HOME; }, 0);
    const t2 = startFake(15); await pdFor(main, t2)('/x/SkyComputerUseService', { addon: t2.addon }); await new Promise((res) => setTimeout(res, 5)); clearTimeout(tm);
    assert.equal(seenByTimer, '/Users/me/.codex', 'event-loop code never runs while the profile dir is in place');
    // an absent CODEX_HOME is absent again afterwards
    delete process.env.CODEX_HOME;
    const t3 = startFake(10); await pdFor(main, t3)('/x/SkyComputerUseService', { addon: t3.addon });
    assert.equal(t3.seenHome(), '/profiles/p'); assert.ok(!('CODEX_HOME' in process.env));
    // a spawn that throws synchronously restores the value and rejects
    process.env.CODEX_HOME = '/Users/me/.codex';
    await assert.rejects(pdFor(main, { spawned: () => false })('/x/SkyComputerUseService', { addon: { spawnComputerUseService: () => { throw new Error('spawn failed'); } } }), /spawn failed/);
    assert.equal(process.env.CODEX_HOME, '/Users/me/.codex');
    // a child that never shows up is waited for at most ~500 ms, then the value is restored
    const never = { addon: { spawnComputerUseService: async () => null }, spawned: () => false };
    const t4 = Date.now(); await pdFor(main, never)('/x/SkyComputerUseService', { addon: never.addon });
    assert.ok(Date.now() - t4 >= 450 && Date.now() - t4 < 1500); assert.equal(process.env.CODEX_HOME, '/Users/me/.codex');
    // variable unset: nothing is touched
    delete process.env[COMPUTER_USE_DIR_ENV];
    const t5 = startFake(10); await pdFor(main, t5)('/x/SkyComputerUseService', { addon: t5.addon });
    assert.equal(t5.seenHome(), '/Users/me/.codex', 'unchanged when the relocation variable is unset');
    // non-darwin / empty path: no spawn at all
    const none = startFake(1);
    assert.equal(await pdFor(main, none)('/x', { addon: none.addon, platform: 'linux' }), null);
    assert.equal(await pdFor(main, none)('  ', { addon: none.addon }), null);
    assert.equal(none.spawned(), false);
  } finally { if (keep == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = keep; delete process.env[COMPUTER_USE_DIR_ENV]; }
  // every start site of the helper is covered: the original has one unwrapped spawn, none remains
  assert.equal(helperStartSites(goodMain()).length, 1);
  assert.deepEqual(helperStartSites(main), []);
  // static guarantee: the original has four computer-use joins off codexHome (+ the plugin skill file), none is left once transformed
  assert.equal(computerUsePaths(goodMain()).length, 5);
  assert.equal(remainingComputerUsePaths(goodMain()).length, 4);
  assert.deepEqual(remainingComputerUsePaths(main), []);
});

test('asar transforms fail closed (mandatory missing, no drafts) when a site is absent, duplicated or in the renderer', () => {
  const cases = {
    'no helper-dir function': (f) => { f[MAIN] = f[MAIN].replace('function Da(e){return C.default.join(e,`computer-use`,Ta)}', ''); },
    'dir constant is not the helper app': (f) => { f[MAIN] = f[MAIN].replace('Ta=`Codex Computer Use.app`', 'Ta=`Other.app`'); },
    'no config writer': (f) => { f[MAIN] = f[MAIN].replace('async function Fc({codexHome:e,config:t}){let n=(0,C.join)(e,Sc)', 'async function Fc({codexHome:e,config:t}){let n=e'); },
    'config writer segment constant reused': (f) => { f[MAIN] += ';var z=(0,C.join)(h,Sc);'; },
    'config file is not config.json': (f) => { f[MAIN] = f[MAIN].replace('Cc=`config.json`', 'Cc=`other.json`'); },
    'no installer resolver': (f) => { f[MAIN] = f[MAIN].replace('function Vhe(){return C.default.join(c.ot(),...Phe)}', ''); },
    'installer array is not the helper app': (f) => { f[MAIN] = f[MAIN].replace('Phe=[`computer-use`,`Codex Computer Use.app`', 'Phe=[`computer-use`,`Other.app`'); },
    'installer array reused': (f) => { f[MAIN] += ';var q=[...Phe];'; },
    'no legacy approvals path': (f) => { f[MAIN] = f[MAIN].replace('`computer-use`,`config.toml`', '`x`,`config.toml`'); },
    'no locked-use group': (f) => { f[MAIN] = f[MAIN].replace('async function sT(){return(await cT(`status`)).trim()===`OK: installed`}', 'async function sT(){return 1}'); },
    'another caller of the installer executor': (f) => { f[MAIN] += ';async function z(){return cT(`status`)}'; },
    'status reader changed shape': (f) => { f[MAIN] = f[MAIN].replace('try{return await sT()}catch{return!1}', 'return await sT()'); },
    'a second resolver reaches the installer': (f) => { f[MAIN] += ';function Z9(){return C.default.join(c.ot(),...Phe)}async function zz(){return Nhe(Z9(),[`status`])}'; },
    'no helper start (the spawn call changed)': (f) => { f[MAIN] = f[MAIN].replace('.spawnComputerUseService(e)', '.other(e)'); },
    'a second spawn site': (f) => { f['.vite/build/worker.js'] += ';x.spawnComputerUseService(p)'; },
    'a second helper executable use': (f) => { f['.vite/build/worker.js'] += ';spawn(C.default.join(h,`Contents`,`MacOS`,`SkyComputerUseService`))'; },
    'an unrelocated computer-use join remains': (f) => { f[MAIN] += ';var w=C.default.join(c.ot(),`computer-use`,`state.json`);'; },
    'an unrelocated computer-use constant join remains': (f) => { f[MAIN] += ';var Qq=`computer-use`;function x(){return C.default.join(c.ot(),Qq)}'; },
    'no service path constant': (f) => { f[MAIN] = f[MAIN].replace('Aa=`SKY_CUA_SERVICE_PATH`', 'Aa=`other`'); },
    'service path constant twice': (f) => { f['.vite/build/worker.js'] += ';x=`SKY_CUA_SERVICE_PATH`'; },
    'no container id': (f) => { f[MAIN] = f[MAIN].replace(`var ohe=\`${GROUP}\`,she=1;`, ''); },
    'container id twice': (f) => { f['.vite/build/worker.js'] += `;y=\`${GROUP}\``; },
    'no bare id in main': (f) => { f[MAIN] = f[MAIN].replaceAll('`com.openai.sky.CUAService`', '`x`'); },
    'renderer chunk names the helper': (f) => { f['webview/assets/app-x.js'] += BARE; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const files = goodFiles(); mutate(files);
    const r = deriveCuaContainerTransform(fakeSource(files));
    assert.deepEqual(r.drafts, [], name);
    assert.ok(r.missing.length === 1 && r.missing[0].mandatory === true, name);
  }
});

test('a name inside a quoted media-type key of an embedded table is text, not a caller of the installer executor; a real extra call, or minified arithmetic using the name, still refuses', () => {
  const files = goodFiles(); files[MAIN] += ';var mt={"application/vnd.3gpp.pic-cT-large":{},"x-sT-y":1,"a-cT-b":2};';
  const ok = deriveCuaContainerTransform(fakeSource(files));
  assert.deepEqual(ok.missing, []); assert.equal(ok.drafts.length, 13);
  files[MAIN] += ';async function z(){return cT(`status`)}';
  const bad = deriveCuaContainerTransform(fakeSource(files));
  assert.deepEqual(bad.drafts, []); assert.match(bad.missing[0].tried, /other callers than the locked-use functions/);
  const arith = goodFiles(); arith[MAIN] += ';var q=e-cT-t;';   // unquoted: a use, even between hyphens
  const bad2 = deriveCuaContainerTransform(fakeSource(arith));
  assert.deepEqual(bad2.drafts, []); assert.match(bad2.missing[0].tried, /other callers than the locked-use functions/);
});

test('computerUsePaths follows literals, constants and arrays into join/resolve, and treats Phe.slice(1) and the plugin skill file as safe', () => {
  const t = (code) => computerUsePaths(code).map((p) => p.base);
  assert.deepEqual(t('a=C.default.join(h,`computer-use`,x)'), ['h']);
  assert.deepEqual(t('a=(0,C.join)(h,"computer-use")'), ['h']);
  assert.deepEqual(t("a=path.resolve(h,'computer-use')"), ['h']);
  assert.deepEqual(t('var S=`computer-use`;f(S);a=(0,C.join)(h,S)'), ['h']);
  assert.deepEqual(t('var P=[`computer-use`,`App`];a=C.join(h,...P)'), ['h']);
  assert.deepEqual(t('var P=[`computer-use`,`App`];a=C.join(h,...P.slice(1))'), []);
  assert.deepEqual(t('var P=[`x`,`computer-use`];a=C.join(h,...P.slice(1))'), ['h'], 'slice only drops a leading segment');
  assert.deepEqual(t('a=e.name===`computer-use`&&f(`computer-use`);b=new Map([[`computer-use`,1]]);c=`computer-use/${o}`'), []);
  assert.deepEqual(remainingComputerUsePaths('a=(0,C.join)(e.pluginRoot,`skills`,`computer-use`,`SKILL.md`)'), []);
  assert.equal(remainingComputerUsePaths('a=(0,C.join)(e.pluginRoot2,`skills`,`computer-use`)').length, 1);
  // a name declared without a value and assigned once (port review 1): followed like a constant
  assert.deepEqual(t('function f(e){let d;d="computer-use";return C.join(e,d,"config.json")}'), ['e']);
  assert.deepEqual(t('function f(e){let P;P=["computer-use","App"];return C.join(e,...P)}'), ['e']);
  // fail closed: the segment written where the search cannot follow it (a name that holds two values, a property) is a finding itself
  assert.deepEqual(t('function f(e){let d="x";d="computer-use";return C.join(e,d)}'), ['(the segment assigned to d)']);
  assert.deepEqual(t('o.seg="computer-use"'), ['(the segment assigned to o.seg)']);
  assert.deepEqual(t('let d;d="computer-use";d="other";C.join(e,d)'), ['(the segment assigned to d)'], 'two assignments: not followed, reported');
  // round 2: a reassigned name's declaration is reported too; a value that only may be the segment, held by a name, is; a join argument
  // that may be it is a path
  assert.deepEqual(t('let d="computer-use";fs.writeFileSync(C.join(codexHome,d,"config.json"),"{}");d="other"'), ['(the segment assigned to d)']);
  assert.deepEqual(t('let d;d=e.flag?"computer-use":"other";C.join(e,d,"config.json")'), ['(the segment assigned to d)']);
  assert.deepEqual(t('a=C.join(h,f?"computer-use":"x")'), ['h']);
  assert.deepEqual(t('a=C.join(h,f&&"computer-use")'), ['h']);
});

test('installerReachable: the installer name must sit in a path array whose only resolver nothing calls', () => {
  const N = 'Codex Computer Use Installer';
  assert.deepEqual(installerReachable(`var P=[\`a\`,\`${N}\`];function V(){return j(c(),...P)}`), [], 'dead resolver');
  assert.equal(installerReachable(`var P=[\`a\`,\`${N}\`];function V(){return j(c(),...P)}async function t(){return x(V(),[])}`).length, 1, 'called resolver');
  assert.equal(installerReachable(`var P=[\`${N}\`];x(...P)`).length, 1, 'use outside a function');
  assert.equal(installerReachable(`x(j(h,\`${N}\`))`).length, 1, 'name outside an array');
  assert.deepEqual(installerReachable('nothing here'), []);
});

test('the derived asar drafts seal and apply as a builder-style chain (hash-pinned) and leave unrelated text alone', () => {
  const files = goodFiles();
  const { drafts } = deriveCuaContainerTransform(fakeSource(files));
  const sealed = sealTransforms(drafts, (p) => files[p]);
  const out = applyAll(sealed, (p) => files[p]);
  assert.ok(out.get(MAIN).includes('computeruse') === false && out.get(MAIN).includes('kw=new Set([`com.openai.sky.CUAServicf`,`com.apple.dock`])'));
  assert.equal(out.get(MAIN).split(rename(BARE)).length - 1, 4, 'three bare ids + the container id');
  assert.throws(() => applyAll(sealed, (p) => files[p] + ' '), /sha256Before mismatch/);
});

// ---- roles, not names
test('edit ids and file lookups use roles: renamed (re-hashed) chunks derive the same ids, finds and texts', () => {
  const a = goodFiles();
  const renamed = { '.vite/build/main-QqQqQqQq.js': a[MAIN], '.vite/build/worker.js': a['.vite/build/worker.js'], '.vite/build/src-ZzZzZzZz.js': a['.vite/build/src-DsLVGakC.js'], 'webview/assets/app-x.js': a['webview/assets/app-x.js'] };
  const one = deriveCuaContainerTransform(fakeSource(a)); const two = deriveCuaContainerTransform(fakeSource(renamed));
  assert.deepEqual([one.missing, two.missing], [[], []]);
  const strip = (d) => ({ id: d.id, find: d.find, text: d.text });
  assert.deepEqual(two.drafts.map(strip), one.drafts.map(strip));
  assert.ok(two.drafts.every((d) => !/[A-Za-z0-9_-]{8}\.js/.test(d.id)), 'no ids with a content-hashed chunk name');
  assert.deepEqual(two.drafts.filter((d) => d.id.startsWith('cua-bundle-id:')).map((d) => d.file), ['.vite/build/main-QqQqQqQq.js', '.vite/build/main-QqQqQqQq.js', '.vite/build/main-QqQqQqQq.js', '.vite/build/src-ZzZzZzZz.js', '.vite/build/worker.js']);
});

test('the main bundle is the one .vite/build/main-*.js with the helper start and the container id: anything else is a mandatory miss', () => {
  const notMain = goodFiles(); notMain['.vite/build/other.js'] = notMain[MAIN]; delete notMain[MAIN];
  const r = deriveCuaContainerTransform(fakeSource(notMain));
  assert.deepEqual(r.drafts, []); assert.ok(r.missing.length === 1 && r.missing[0].mandatory === true && /main bundle/.test(r.missing[0].tried));
  const second = goodFiles(); second['.vite/build/main-Other123.js'] = 'x.spawnComputerUseService(p);';       // a second bundle that starts the helper
  assert.deepEqual(deriveCuaContainerTransform(fakeSource(second)).drafts, [], 'a second spawn site is refused');
});

test('bare bundle id finds start and end at string literals: the id plus its neighbouring literal, never a one-letter tail of a minified name', () => {
  const { drafts } = deriveCuaContainerTransform(fakeSource(goodFiles()));
  const finds = drafts.filter((d) => d.id.startsWith('cua-bundle-id:')).map((d) => d.find);
  assert.equal(finds.length, 5);
  for (const f of finds) {
    assert.match(f, /^[`"']/, f); assert.match(f, /[`"']$/, f);
    assert.equal(f.split(BARE).length, 2, 'the id once');
  }
  assert.ok(finds.includes('`com.openai.sky.CUAService`,`com.apple.dock`'));
  assert.ok(finds.includes('`com.openai.sky.CUAService`,dT=`computerUseSoundMode`'));
});

test('bareIdSite is fail-closed: a literal that is not whole, or whose neighbours do not make it unique, has no site', () => {
  const t = (s, notBefore = 0) => bareIdSite(s, s.indexOf(BARE), notBefore);
  assert.equal(t(`a=[\`x\`,\`${BARE}\`,\`y\`]`).find, `\`${BARE}\`,\`y\``, 'the next literal first');
  assert.equal(t(`a=[\`x\`,\`${BARE}\`]`).find, `\`x\`,\`${BARE}\``, 'else the previous one');
  assert.equal(typeof t(`a="${BARE}.cli"`), 'string', 'a longer string is not the bare id');
  assert.equal(typeof t(`a=[\`x\`,\`${BARE}\`,\`y\`];b=[\`x\`,\`${BARE}\`,\`y\`]`), 'string', 'identical sites are ambiguous');
  assert.equal(typeof t(`a=f(\`${BARE}\`)`), 'string', 'no neighbouring literal');
  assert.equal(typeof t(`a=[\`x\`,\`${BARE}\`,\`y\`]`, 100), 'string', 'would overlap an earlier edit');
});
