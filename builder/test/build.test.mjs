import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildCopy, parseKind, checkPatchedParse, nodeCheck, ISOLATION_BASELINE_IDS, isolationBaselineMissing, checkMandatoryEdits, updaterSuppression, verifyHelperIdentity, applyTransform, composeLoader, buildInputsHash, assertSafeOut, applyBinaryPatch, applyBinaryPatches, BuildError } from '../build.mjs';
import { AsarArchive, headerHash } from '../asar.mjs';
import { isolationScan, rewriteBareTeamBuffer, stockTeamLeftovers, signatureRanges } from '../isolation-scan.mjs';
import { EntitlementReadError } from '../sign.mjs';
import { dictionaryDigest, findIntegritySlot } from '../integrity.mjs';
import { makeStockApp, makeBuildInputs, tmpdir, sha, readPlist, writePlist, PKG_MAIN, MAIN_JS } from './helpers.mjs';

const ROOT = '/tmp/some root/with "quotes"';
const okSign = async () => ({ signed: 1, verified: true, targets: [{ path: '.', removed: ['keychain-access-groups'], added: ['com.apple.security.cs.disable-library-validation'] }] });
const T = (id, find, text, op = 'replace-once', before = MAIN_JS) => {
  const after = (() => { const i = before.indexOf(find); return op === 'replace-once' ? before.slice(0, i) + text + before.slice(i + find.length) : op === 'insert-before-once' ? before.slice(0, i) + text + before.slice(i) : before.slice(0, i + find.length) + text + before.slice(i + find.length); })();
  return { id, seam: 'other', file: PKG_MAIN, sha256Before: sha(before), sha256After: sha(after), op, find, text, _after: after };
};
const clean = ({ _after, ...t }) => t;

async function setup(t, { framework, transforms = [], backend, stockOpts, sparkle, extraAdapter } = {}) {
  const dir = tmpdir(t);
  const stock = makeStockApp(dir, { framework, ...stockOpts });
  const inputs = makeBuildInputs(dir, { transforms: transforms.map(clean), backend, sparkle, extraAdapter });
  const out = path.join(dir, 'out');
  const opts = { stock: stock.app, adapter: inputs.adapterPath, loader: inputs.loader, relay: inputs.relay, root: ROOT, identity: '-', out, sign: okSign, allowNoBaseline: true,
    dumpSignedEntitlements: async () => [], readTeamIdentifier: async () => null, findCertificateSubject: () => null };
  return { dir, stock, inputs, out, opts };
}

test('the exact adapter.json bytes are embedded at Resources/codexmods-adapter.json and their sha256 recorded', async (t) => {
  const s = await setup(t, { transforms: [T('one', 'const seam = 1;', 'const seam = 2;')] });
  // odd formatting on purpose: the bytes, not a re-serialization, must be embedded
  fs.writeFileSync(s.inputs.adapterPath, `${JSON.stringify(JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8')), null, '\t')}\n\n`);
  const { appPath, report } = await buildCopy(s.opts);
  const embedded = path.join(appPath, 'Contents/Resources/codexmods-adapter.json');
  assert.ok(fs.readFileSync(embedded).equals(fs.readFileSync(s.inputs.adapterPath)));
  assert.equal(report.embeddedAdapter.path, 'Contents/Resources/codexmods-adapter.json');
  assert.equal(report.embeddedAdapter.sha256, sha(fs.readFileSync(s.inputs.adapterPath)));
  assert.equal(report.embeddedAdapter.sha256, report.inputs.adapter.sha256);
  assert.equal(JSON.parse(fs.readFileSync(embedded, 'utf8')).transforms[0].id, 'one');
  // sealed: the file is written before signing, so the (real) signature covers it
  let sawAtSign = null;
  const s2 = await setup(t);
  await buildCopy({ ...s2.opts, sign: async (app) => { sawAtSign = fs.existsSync(path.join(app, 'Contents/Resources/codexmods-adapter.json')); return okSign(); } });
  assert.equal(sawAtSign, true, 'embedded before signing');
});

test('end to end real codesign: the embedded adapter is sealed (tampering breaks verification)', async (t) => {
  const s = await setup(t, { stockOpts: { realExe: true } });
  const { appPath } = await buildCopy({ ...s.opts, sign: undefined, dumpSignedEntitlements: undefined, readTeamIdentifier: undefined });
  const verify = () => spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]).status;
  assert.equal(verify(), 0);
  fs.appendFileSync(path.join(appPath, 'Contents/Resources/codexmods-adapter.json'), ' ');
  assert.notEqual(verify(), 0, 'modifying the embedded adapter invalidates the signature');
});

test('applyTransform: three ops, hash and uniqueness checks', () => {
  const buf = Buffer.from(MAIN_JS);
  for (const op of ['replace-once', 'insert-before-once', 'insert-after-once']) {
    const t = T(op, 'const seam = 1;', ' /*X*/', op);
    assert.equal(applyTransform(buf, clean(t)).toString(), t._after);
  }
  const good = T('g', 'seam', 'SEAM');
  assert.throws(() => applyTransform(buf, { ...clean(good), sha256Before: sha('other') }), (e) => e.code === 'TRANSFORM_HASH_BEFORE');
  assert.throws(() => applyTransform(buf, { ...clean(good), sha256After: sha('other') }), (e) => e.code === 'TRANSFORM_HASH_AFTER');
  assert.throws(() => applyTransform(buf, { ...clean(good), find: 'nonexistent' }), (e) => e.code === 'TRANSFORM_FIND_COUNT' && /0 times/.test(e.message));
  assert.throws(() => applyTransform(buf, { ...clean(good), find: 'co' }), (e) => e.code === 'TRANSFORM_FIND_COUNT' && /2 times/.test(e.message));
  assert.throws(() => applyTransform(buf, { ...clean(good), op: 'append' }), (e) => e.code === 'TRANSFORM_OP');
  assert.throws(() => applyTransform(Buffer.from([0xff, 0xfe, 0x41]), { ...clean(good), sha256Before: sha(Buffer.from([0xff, 0xfe, 0x41])) }), (e) => e.code === 'TRANSFORM_ENCODING');
});

test('composeLoader substitutes the JSON-encoded root and requires the original main', () => {
  const s = composeLoader("const R = '__CODEXMODS_ROOT__'; const Q = '__CODEXMODS_ROOT__';", ROOT, '.vite/build/main.js');
  assert.ok(s.startsWith(`const R = ${JSON.stringify(ROOT)}; const Q = ${JSON.stringify(ROOT)};`));
  assert.ok(s.trimEnd().endsWith('require("./.vite/build/main.js");'));
  assert.ok(composeLoader('x', '/r', './a/b.js').includes('require("./a/b.js")'));
});

test('buildCopy: identity, loader, transforms, asar+plist integrity, backend replace, report', async (t) => {
  const tr = [T('one', 'const seam = 1;', 'const seam = 2; /*seam*/', 'replace-once')];
  const s = await setup(t, { transforms: tr });
  const { appPath, reportPath, report } = await buildCopy(s.opts);
  assert.equal(appPath, path.join(fs.realpathSync(s.out), 'ChatGPT Mods.app'));
  const info = readPlist(path.join(appPath, 'Contents/Info.plist'));
  assert.equal(info.CFBundleIdentifier, 'dev.codexmods.app');
  assert.equal(info.CFBundleName, 'ChatGPT Mods');
  assert.equal('CFBundleURLTypes' in info, false);
  assert.equal('SUFeedURL' in info, false);
  assert.equal(info.SUEnableAutomaticChecks, false);
  assert.equal(fs.readFileSync(path.join(appPath, 'Contents/Resources/owl-app.ini'), 'utf8'), '[Owl]\r\nUserDataDirectoryName=ChatGPT Mods\r\nAppVersion=1.2.3\r\n');
  assert.deepEqual(report.owl.userDataDirectoryName, { from: 'Codex', to: 'ChatGPT Mods' });
  // asar
  const asarPath = path.join(appPath, 'Contents/Resources/app.asar');
  const a = AsarArchive.open(asarPath);
  const pkg = JSON.parse(a.read('package.json'));
  assert.equal(pkg.main, 'codexmods-loader.cjs');
  assert.equal(pkg.name, 'fixture');
  const loader = a.read('codexmods-loader.cjs').toString();
  assert.ok(loader.startsWith(`const ROOT = ${JSON.stringify(ROOT)};`));
  assert.ok(loader.includes(`require(${JSON.stringify('./' + PKG_MAIN)})`));
  assert.equal(a.read(PKG_MAIN).toString(), tr[0]._after);
  assert.equal(a.read('other/x.js').toString(), 'x');
  assert.deepEqual(a.stat('native/n.node'), AsarArchive.fromBuffer(s.stock.asarBuffer).stat('native/n.node'));
  // integrity: plist matches new header hash; stock unchanged
  assert.equal(info.ElectronAsarIntegrity['Resources/app.asar'].hash, a.headerSha256);
  assert.equal(info.ElectronAsarIntegrity['Resources/app.asar'].hash, headerHash(a.headerString));
  assert.notEqual(a.headerSha256, s.stock.integrity['Resources/app.asar'].hash);
  assert.equal(sha(fs.readFileSync(path.join(s.stock.contents, 'Resources/app.asar'))), sha(s.stock.asarBuffer), 'stock asar untouched');
  assert.equal(readPlist(path.join(s.stock.contents, 'Info.plist')).CFBundleIdentifier, 'com.example.stock', 'stock plist untouched');
  // backend replace
  const codex = path.join(appPath, 'Contents/Resources/codex-cli/bin/codex');
  assert.equal(fs.readFileSync(codex, 'utf8'), '#!/bin/sh\nexec "$0.real" "$@"\n');
  assert.ok(fs.statSync(codex).mode & 0o111);
  assert.match(fs.readFileSync(`${codex}.real`, 'utf8'), /real-codex/);
  // stale stock artefacts
  assert.equal(fs.existsSync(path.join(appPath, 'Contents/CodeResources')), false);
  assert.equal(fs.existsSync(path.join(appPath, 'Contents/embedded.provisionprofile')), false);
  // report
  const onDisk = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(onDisk.complete, true);
  assert.equal(onDisk.transforms[0].id, 'one');
  assert.equal(onDisk.backend.method, 'replace');
  assert.equal(onDisk.signing.identity, '-');
  assert.deepEqual(onDisk.signing.strippedEntitlements, ['keychain-access-groups']);
  assert.equal(onDisk.stock.version, '1.2.3');
  assert.equal(typeof onDisk.durationMs, 'number');
  assert.equal(report.integrity.asarHeaderSha256, a.headerSha256);
  assert.deepEqual(fs.readdirSync(s.out).sort(), ['ChatGPT Mods.app', 'build-report.json']);
  a.close();
});

test('buildCopy: Electron framework digest is patched to the new dictionary', async (t) => {
  const s = await setup(t, { framework: {} });
  const { appPath, report } = await buildCopy(s.opts);
  const info = readPlist(path.join(appPath, 'Contents/Info.plist'));
  const fw = fs.readFileSync(path.join(appPath, 'Contents/Frameworks/Fake.framework/Fake'));
  assert.equal(findIntegritySlot(fw).digest, dictionaryDigest(info.ElectronAsarIntegrity));
  assert.equal(report.integrity.framework[0].present, true);
  const stockFw = fs.readFileSync(s.stock.fwPath);
  assert.equal(findIntegritySlot(stockFw).digest, dictionaryDigest(s.stock.integrity), 'stock framework untouched');
});

test('transform failure aborts before signing and leaves no complete output', async (t) => {
  for (const [label, mutate] of [
    ['sha256Before mismatch', (x) => ({ ...x, sha256Before: sha('nope') })],
    ['find occurs twice', (x) => ({ ...x, find: 'co' })],
    ['find occurs zero times', (x) => ({ ...x, find: 'does-not-occur' })],
    ['sha256After mismatch', (x) => ({ ...x, sha256After: sha('nope') })],
    ['file missing', (x) => ({ ...x, file: 'missing.js' })],
  ]) {
    const s = await setup(t, { transforms: [T('bad', 'const seam = 1;', 'X')] });
    const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
    adapter.transforms = adapter.transforms.map(mutate);
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify(adapter));
    let signed = 0;
    await assert.rejects(buildCopy({ ...s.opts, sign: async () => { signed += 1; return okSign(); } }), BuildError, label);
    assert.equal(signed, 0, `${label}: nothing signed`);
    assert.equal(fs.existsSync(path.join(s.out, 'build-report.json')), false, label);
    assert.equal(fs.existsSync(path.join(s.out, 'ChatGPT Mods.app')), false, label);
    assert.deepEqual(fs.readdirSync(s.out), [], `${label}: no partial output`);
  }
});

test('parseKind: renderer chunks and .mjs are modules, every other script of the asar is a CommonJS script, other files are not checked', () => {
  assert.equal(parseKind('webview/assets/app-initial-90eb42395b7d.js'), 'module');
  assert.equal(parseKind('x/y.mjs'), 'module');
  assert.equal(parseKind('.vite/build/main-CLu1A25j.js'), 'script');
  assert.equal(parseKind('.vite/build/worker.js'), 'script');
  assert.equal(parseKind('x/y.cjs'), 'script');
  for (const f of ['package.json', 'webview/assets/app.css', 'webview/index.html', 'x/y.node']) assert.equal(parseKind(f), null, f);
});

test('checkPatchedParse: every patched script must parse as what it is (a module or a script); the first that does not fails with TRANSFORM_PARSE', () => {
  const ok = new Map([['webview/assets/a.js', Buffer.from('import{a as b}from"./x.js";export const c=b;await 1;')], ['.vite/build/main.js', Buffer.from('const x=require("y");return x')], ['package.json', Buffer.from('{ not js')]]);
  assert.deepEqual(checkPatchedParse(ok), [{ file: 'webview/assets/a.js', kind: 'module' }, { file: '.vite/build/main.js', kind: 'script' }], 'package.json is not JavaScript');
  // the same text means different things: `return` at the top level is a script's, `import` a module's
  assert.throws(() => checkPatchedParse(new Map([['webview/assets/a.js', Buffer.from('return 1')]])), (e) => e.code === 'TRANSFORM_PARSE' && /webview\/assets\/a\.js/.test(e.message));
  assert.throws(() => checkPatchedParse(new Map([['.vite/build/main.js', Buffer.from('import a from "x"')]])), (e) => e.code === 'TRANSFORM_PARSE');
  assert.throws(() => checkPatchedParse(new Map([['webview/assets/a.js', Buffer.from('export const c=1;)')]])), (e) => e.code === 'TRANSFORM_PARSE' && e.details.file === 'webview/assets/a.js' && e.details.kind === 'module' && /Unexpected token/.test(e.message));
  // the checker is injectable and is called with the kind and the bytes
  const seen = [];
  checkPatchedParse(new Map([['webview/assets/a.js', Buffer.from('1')]]), (kind, buf) => seen.push([kind, String(buf)]));
  assert.deepEqual(seen, [['module', '1']]);
  assert.doesNotThrow(() => nodeCheck('script', Buffer.from('var a=1')));
});

test('a transform that leaves a script unparsable fails the build before anything is signed or written; one that keeps it valid is recorded as checked', async (t) => {
  // the stock main.js is `console.log("main");\nconst seam = 1;\n`
  const s = await setup(t, { transforms: [T('breaks', 'const seam = 1;', 'const seam = ;')] });
  let signed = 0;
  await assert.rejects(buildCopy({ ...s.opts, sign: async () => { signed += 1; return okSign(); } }), (e) => e instanceof BuildError && e.code === 'TRANSFORM_PARSE' && e.details.file === PKG_MAIN && /does not parse as a script/.test(e.message));
  assert.equal(signed, 0);
  assert.deepEqual(fs.readdirSync(s.out), [], 'no partial output');
  const g = await setup(t, { transforms: [T('fine', 'const seam = 1;', 'const seam = 2;')] });
  const { report } = await buildCopy(g.opts);
  assert.deepEqual(report.parseChecked, [{ file: PKG_MAIN, kind: 'script' }]);
  // and the check can be replaced (a test seam), e.g. to see what it is asked
  const asked = [];
  const h = await setup(t, { transforms: [T('fine', 'const seam = 1;', 'const seam = 2;')] });
  await buildCopy({ ...h.opts, parseCheck: (kind, buf) => asked.push([kind, buf.length]) });
  assert.equal(asked.length, 1); assert.equal(asked[0][0], 'script');
});

test('a later transform sees the output of an earlier one (array order)', async (t) => {
  const first = T('first', 'const seam = 1;', 'const seam = 2;');
  const second = { id: 'second', seam: 'other', file: PKG_MAIN, sha256Before: first.sha256After, sha256After: sha(first._after + '//end\n'), op: 'insert-after-once', find: 'const seam = 2;\n', text: '//end\n' };
  const s = await setup(t, { transforms: [first, second] });
  const { appPath } = await buildCopy(s.opts);
  assert.equal(AsarArchive.open(path.join(appPath, 'Contents/Resources/app.asar')).read(PKG_MAIN).toString(), first._after + '//end\n');
});

test('signing failure leaves no complete output', async (t) => {
  const s = await setup(t);
  await assert.rejects(buildCopy({ ...s.opts, sign: async () => { throw new Error('codesign exploded'); } }), /exploded/);
  assert.deepEqual(fs.readdirSync(s.out), []);
});

test('--out must be empty unless force; force replaces', async (t) => {
  const s = await setup(t);
  fs.mkdirSync(s.out);
  fs.writeFileSync(path.join(s.out, 'leftover'), 'x');
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'OUT_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(s.out, 'leftover'), 'utf8'), 'x');
  await buildCopy({ ...s.opts, force: true });
  assert.equal(fs.existsSync(path.join(s.out, 'leftover')), false);
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'OUT_NOT_EMPTY');
  await buildCopy({ ...s.opts, force: true }); // idempotent
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.out, 'build-report.json'), 'utf8')).complete, true);
});

test('backend override leaves the binary and records what to configure', async (t) => {
  const s = await setup(t, { backend: { codexPath: 'Resources/codex-cli/bin/codex', method: 'override', configKey: 'CODEX_CLI_PATH' } });
  const { appPath, report } = await buildCopy(s.opts);
  assert.match(fs.readFileSync(path.join(appPath, 'Contents/Resources/codex-cli/bin/codex'), 'utf8'), /real-codex/);
  assert.equal(fs.existsSync(path.join(appPath, 'Contents/Resources/codex-cli/bin/codex.real')), false);
  assert.ok(fs.statSync(path.join(appPath, 'Contents/Resources/codexmods-relay')).mode & 0o111);
  assert.equal(report.backend.method, 'override');
  assert.equal(report.backend.configKey, 'CODEX_CLI_PATH');
  assert.equal(report.backend.relayPath, 'Contents/Resources/codexmods-relay');
  assert.equal(fs.statSync(path.join(appPath, 'Contents/Resources/codexmods-relay')).mode & 0o777, 0o755);
  assert.match(report.backend.mustConfigure, /CODEX_CLI_PATH/);
  // `$0.real` beside the relay is a relative symlink to the real binary, for processes that only inherit CODEX_CLI_PATH.
  const link = path.join(appPath, 'Contents/Resources/codexmods-relay.real');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), 'codex-cli/bin/codex');
  assert.match(fs.readFileSync(link, 'utf8'), /real-codex/);
  assert.equal(report.backend.realLink, 'Contents/Resources/codexmods-relay.real');
});

test('preflight refusals: adapter for another build, missing backend binary, bad loader, unsafe out', async (t) => {
  let s = await setup(t, { extraAdapter: undefined });
  const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, build: { ...adapter.build, version: '9.9.9' } }));
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'ADAPTER_BUILD');
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, build: { ...adapter.build, asarSha256: sha('wrong') } }));
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'ADAPTER_BUILD');
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, backend: { codexPath: 'Resources/missing', method: 'replace' } }));
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'BACKEND');
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify(adapter));
  fs.writeFileSync(s.inputs.loader, 'no token here');
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'LOADER');
  await assert.rejects(buildCopy({ ...s.opts, out: s.stock.app }), (e) => e.code === 'OUT_UNSAFE');
  await assert.rejects(buildCopy({ ...s.opts, out: path.join(s.stock.app, 'Contents', 'x') }), (e) => e.code === 'OUT_UNSAFE');
});

test('build.asarSha256 is the sha256 of the whole stock app.asar file; the header hash is not accepted', async (t) => {
  const s = await setup(t);
  const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, build: { ...adapter.build, asarSha256: s.stock.integrity['Resources/app.asar'].hash } }));
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'ADAPTER_BUILD');
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, build: { ...adapter.build, asarSha256: sha(s.stock.asarBuffer) } }));
  await buildCopy({ ...s.opts, force: true });
});

test('owl-app.ini: adapter.owl names the directory (and file); absent adapter.owl defaults to "ChatGPT Mods"', async (t) => {
  let s = await setup(t);
  const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, owl: { iniPath: 'Resources/owl-app.ini', userDataDirectoryName: 'Custom Name' } }));
  let { appPath, report } = await buildCopy(s.opts);
  assert.match(fs.readFileSync(path.join(appPath, 'Contents/Resources/owl-app.ini'), 'utf8'), /UserDataDirectoryName=Custom Name\r\n/);
  assert.equal(report.owl.userDataDirectoryName.to, 'Custom Name');
  s = await setup(t, { stockOpts: { noOwl: true } });
  ({ report } = await buildCopy(s.opts));
  assert.equal(report.owl, null, 'no ini in the stock app: nothing to write');
});

test('end to end with real codesign on a signable fixture: verify --deep --strict passes', async (t) => {
  const s = await setup(t, { stockOpts: { realExe: true } });
  const { appPath, report } = await buildCopy({ ...s.opts, sign: undefined, dumpSignedEntitlements: undefined, readTeamIdentifier: undefined });
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]).status, 0);
  assert.equal(report.signing.adhoc, true);
  assert.equal(report.cloneMethod, 'clonefile');
});

const REAL_LOADER = fileURLToPath(new URL('../../loader/loader.cjs', import.meta.url));

test('the real loader/loader.cjs, composed by composeLoader, bakes exactly the input root (spaces, quotes, unicode)', (t) => {
  const template = fs.readFileSync(REAL_LOADER, 'utf8');
  for (const name of ['plain', 'with space', `it's "quoted"`, 'unicod\u00e9 \u2603 \u65e5\u672c', 'back\\slash']) {
    const root = path.join(tmpdir(t), name);
    fs.mkdirSync(root, { recursive: true });
    const src = composeLoader(template, root, '.vite/build/main.js');
    assert.ok(!src.includes('__CODEXMODS_ROOT__'), 'token fully replaced');
    new vm.Script(src); // still valid JS
    // Evaluate the loader up to its first use of the root: path.join(root, ...) is the first call that sees BAKED_ROOT.
    const seen = [];
    const realPath = path;
    const fakeRequire = (m) => {
      if (m === 'path') return new Proxy(realPath, { get: (o, k) => (k === 'join' ? (...a) => { seen.push(a[0]); return o.join(...a); } : o[k]) });
      if (m === 'fs' || m === 'node:fs') return fs;
      if (m === 'electron') throw new Error('stop-at-electron');
      throw new Error(`unexpected require ${m}`);
    };
    const sandbox = { require: fakeRequire, process: { env: {}, pid: 1, platform: 'darwin', versions: {}, execPath: '/x/ChatGPT', argv: [] }, module: { exports: {} }, console: { log() {}, error() {}, warn() {} }, __dirname: '/x', __filename: '/x/loader.cjs' };
    try { vm.runInNewContext(src, sandbox); } catch { /* loader may fail after electron; only the root matters */ }
    assert.ok(seen.length > 0, 'loader used its root');
    assert.equal(seen[0], root, `baked root for ${name}`);
  }
});

test('a template with the old unquoted placeholder is rejected', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.inputs.loader, 'const ROOT = __CODEXMODS_ROOT__;');
  await assert.rejects(buildCopy(s.opts), (e) => e.code === 'LOADER');
});

test('--out: symlink aliases into stock, /Applications and home are refused (before anything is deleted)', async (t) => {
  const s = await setup(t);
  const victim = path.join(s.stock.app, 'Contents', 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'x');
  const alias = path.join(s.dir, 'alias-into-stock');
  fs.symlinkSync(victim, alias);
  const aliasParent = path.join(s.dir, 'alias-parent');
  fs.symlinkSync(s.stock.app, aliasParent);
  const aliasOfStock = path.join(s.dir, 'alias-of-stock');
  fs.symlinkSync(s.stock.app, aliasOfStock);
  const aliasToApplications = path.join(s.dir, 'alias-apps');
  fs.symlinkSync('/Applications', aliasToApplications);
  const aliasHome = path.join(s.dir, 'alias-home');
  fs.symlinkSync(process.env.HOME, aliasHome);
  for (const out of [alias, path.join(aliasParent, 'Contents', 'new'), aliasOfStock, aliasToApplications, path.join(aliasToApplications, 'Sub'), aliasHome, '/', '/Applications', path.join(s.dir, 'alias-into-stock', 'deeper')]) {
    await assert.rejects(buildCopy({ ...s.opts, out, force: true }), (e) => e.code === 'OUT_UNSAFE', out);
  }
  assert.equal(fs.readFileSync(path.join(victim, 'keep'), 'utf8'), 'x', 'nothing was deleted');
  // an out that CONTAINS the stock app (parent dir) is refused too, also via alias
  const parentAlias = path.join(s.dir, 'alias-parent-dir');
  fs.symlinkSync(s.dir, parentAlias);
  await assert.rejects(buildCopy({ ...s.opts, out: parentAlias, force: true }), (e) => e.code === 'OUT_UNSAFE');
  assert.ok(fs.existsSync(s.stock.app));
});

test('--out: a normal out reached through a symlinked ancestor is canonicalized and works', async (t) => {
  const s = await setup(t);
  const real = path.join(s.dir, 'real-out-parent');
  fs.mkdirSync(real);
  const link = path.join(s.dir, 'link-out-parent');
  fs.symlinkSync(real, link);
  const { appPath } = await buildCopy({ ...s.opts, out: path.join(link, 'out') });
  assert.equal(appPath, path.join(fs.realpathSync(real), 'out', 'ChatGPT Mods.app'));
  assert.equal(assertSafeOut(path.join(link, 'nope', 'x'), s.stock.app), path.join(fs.realpathSync(real), 'nope', 'x'));
});

test('buildInputsHash: 16 hex, sensitive to every input, stable; recorded in the report', async (t) => {
  const base = { adapterBytes: Buffer.from('a'), loaderBytes: Buffer.from('l'), relayBytes: Buffer.from('r'), identity: '-', frameworkVersion: '1.0.0' };
  const h = buildInputsHash(base);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(buildInputsHash({ ...base }), h);
  for (const [k, v] of [['adapterBytes', Buffer.from('b')], ['loaderBytes', Buffer.from('m')], ['relayBytes', Buffer.from('s')], ['identity', 'Apple Development: x'], ['frameworkVersion', '1.0.1']]) {
    assert.notEqual(buildInputsHash({ ...base, [k]: v }), h, k);
  }
  assert.notEqual(buildInputsHash({ ...base, adapterBytes: Buffer.from('al'), loaderBytes: Buffer.from('') }), buildInputsHash({ ...base, adapterBytes: Buffer.from('a'), loaderBytes: Buffer.from('l') }), 'length-prefixed: no concatenation ambiguity');
  const s = await setup(t);
  const { report } = await buildCopy({ ...s.opts, frameworkVersion: '9.9.9' });
  assert.equal(report.inputsHash, buildInputsHash({ adapterBytes: fs.readFileSync(s.inputs.adapterPath), loaderBytes: fs.readFileSync(s.inputs.loader), relayBytes: fs.readFileSync(s.inputs.relay), identity: '-', frameworkVersion: '9.9.9' }));
  assert.equal(report.frameworkVersion, '9.9.9');
});

// ---- adapter.binaryPatches (contracts v1.10)
const FW_REL = 'Frameworks/Fake.framework/Fake';
function patchFor(stockBytes, { id = 'p1', offset, after = 'c0dec0de', file = FW_REL, justification = 'test' } = {}) {
  const off = offset ?? stockBytes.length - 32;
  const len = after.length / 2;
  const before = stockBytes.subarray(off, off + len).toString('hex');
  const patched = Buffer.from(stockBytes); Buffer.from(after, 'hex').copy(patched, off);
  return { id, file, sha256Before: sha(stockBytes), offset: off, before, after, sha256After: sha(patched), justification, _patched: patched };
}
const strip = ({ _patched, ...p }) => p;

test('applyBinaryPatch: exact bytes at an offset, both hashes verified, input untouched', () => {
  const buf = Buffer.concat([Buffer.alloc(64, 7), Buffer.from('78787878', 'hex'), Buffer.alloc(64, 9)]);
  const p = patchFor(buf, { offset: 64, after: '79797979' });
  const out = applyBinaryPatch(buf, strip(p));
  assert.ok(out.equals(p._patched));
  assert.equal(buf.readUInt8(64), 0x78, 'input untouched');
  const code = (patch) => { try { applyBinaryPatch(buf, patch); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code({ ...strip(p), sha256Before: sha('x') }), 'BINARY_PATCH_HASH_BEFORE');
  assert.equal(code({ ...strip(p), before: '78787879' }), 'BINARY_PATCH_BYTES');
  assert.equal(code({ ...strip(p), sha256After: sha('x') }), 'BINARY_PATCH_HASH_AFTER');
  assert.equal(code({ ...strip(p), offset: buf.length - 1 }), 'BINARY_PATCH_RANGE');
});

test('buildCopy applies binaryPatches before signing and before the framework digest patch; report records them', async (t) => {
  const s = await setup(t, { framework: {} });
  const stockFw = fs.readFileSync(s.stock.fwPath);
  const p1 = patchFor(stockFw, { id: 'service-name', offset: stockFw.length - 32, after: '4b657963' });
  const p2 = patchFor(p1._patched, { id: 'second', offset: stockFw.length - 16, after: 'aabbccdd' }); // sees the result of the first
  const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, binaryPatches: [strip(p1), strip(p2)] }));
  let atSign = null;
  const { appPath, report } = await buildCopy({ ...s.opts, sign: async (app) => { atSign = fs.readFileSync(path.join(app, 'Contents', FW_REL)); return okSign(); } });
  const out = fs.readFileSync(path.join(appPath, 'Contents', FW_REL));
  assert.equal(out.subarray(stockFw.length - 32, stockFw.length - 28).toString('hex'), '4b657963');
  assert.equal(out.subarray(stockFw.length - 16, stockFw.length - 12).toString('hex'), 'aabbccdd');
  assert.ok(atSign.equals(out), 'patched before signing');
  const info = readPlist(path.join(appPath, 'Contents/Info.plist'));
  assert.equal(findIntegritySlot(out).digest, dictionaryDigest(info.ElectronAsarIntegrity), 'the asar digest patch still applies to the patched file');
  assert.deepEqual(report.binaryPatches.map((x) => [x.id, x.file, x.offset, x.length]), [['service-name', FW_REL, stockFw.length - 32, 4], ['second', FW_REL, stockFw.length - 16, 4]]);
  assert.equal(report.binaryPatches[0].sha256Before, sha(stockFw));
  assert.ok(fs.readFileSync(s.stock.fwPath).equals(stockFw), 'stock file untouched');
});

test('any binary patch problem aborts the whole build: nothing signed, nothing complete, stock untouched', async (t) => {
  const s0 = await setup(t, { framework: {} });
  const stockFw = fs.readFileSync(s0.stock.fwPath);
  const good = patchFor(stockFw, { id: 'g' });
  const cases = [
    ['sha256Before mismatch', { ...strip(good), sha256Before: sha('nope') }],
    ['before bytes mismatch', { ...strip(good), before: 'deadbeef' }],
    ['sha256After mismatch', { ...strip(good), sha256After: sha('nope') }],
    ['offset past the end', { ...strip(good), offset: stockFw.length }],
    ['path traversal', { ...strip(good), file: '../Info.plist' }],
    ['absolute path', { ...strip(good), file: '/etc/hosts' }],
    ['missing file', { ...strip(good), file: 'Frameworks/Nope.framework/Nope' }],
    ['before/after length differ', { ...strip(good), after: 'c0dec0' }],
    ['before equals after', { ...strip(good), after: good.before }],
    ['bad hash shape', { ...strip(good), sha256After: 'abc' }],
    ['not hex', { ...strip(good), before: 'zz' }],
    ['negative offset', { ...strip(good), offset: -1 }],
  ];
  for (const [label, patch] of cases) {
    const s = await setup(t, { framework: {} });
    const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, binaryPatches: [patch] }));
    let signed = 0;
    await assert.rejects(buildCopy({ ...s.opts, sign: async () => { signed += 1; return okSign(); } }), BuildError, label);
    assert.equal(signed, 0, label);
    assert.deepEqual(fs.existsSync(s.out) ? fs.readdirSync(s.out) : [], [], `${label}: no output`);
    assert.ok(fs.readFileSync(s.stock.fwPath).equals(stockFw), `${label}: stock untouched`);
  }
  // duplicate ids and a non-array
  const s = await setup(t, { framework: {} });
  const adapter = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  for (const bp of [[strip(good), strip(good)], 'nope']) {
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...adapter, binaryPatches: bp }));
    await assert.rejects(buildCopy(s.opts), (e) => e.code === 'BINARY_PATCH');
  }
});

test('a symlink target is refused, and a failing later patch leaves earlier patches unwritten', (t) => {
  const dir = tmpdir(t);
  const contents = path.join(dir, 'Contents');
  fs.mkdirSync(path.join(contents, 'F'), { recursive: true });
  const a = Buffer.alloc(32, 1);
  fs.writeFileSync(path.join(contents, 'F', 'a'), a);
  fs.symlinkSync(path.join(contents, 'F', 'a'), path.join(contents, 'F', 'link'));
  const pa = strip(patchFor(a, { id: 'a', file: 'F/a', offset: 4, after: '01020304' }));
  assert.throws(() => applyBinaryPatches(contents, [{ ...pa, id: 'l', file: 'F/link' }]), (e) => e.code === 'BINARY_PATCH');
  const bad = { ...pa, id: 'b', sha256Before: sha('zzz') }; // second patch of the same file is wrong
  assert.throws(() => applyBinaryPatches(contents, [pa, bad]), (e) => e.code === 'BINARY_PATCH_HASH_BEFORE');
  assert.ok(fs.readFileSync(path.join(contents, 'F', 'a')).equals(a), 'nothing written when any patch fails');
});

// ---- v1.13: mandatory edits, helper identity, updater evidence, --require-identity
const setAdapter = (s, patch) => { const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8')); fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, ...patch })); };
const noOutput = (s) => (fs.existsSync(s.out) ? fs.readdirSync(s.out) : []);

test('mandatoryEdits: a pack missing any listed transform/binaryPatch id is refused before anything is written; present ids are verified and reported', async (t) => {
  const tr = T('cua-container', 'const seam = 1;', 'const seam = 2;');
  const s = await setup(t, { transforms: [tr], framework: {}, stockOpts: { helper: true } });
  const stockFw = fs.readFileSync(s.stock.fwPath);
  const bp = strip(patchFor(stockFw, { id: 'keychain-service-name' }));
  setAdapter(s, { binaryPatches: [bp, helperRenamePatch(s)], mandatoryEdits: ['cua-container', 'keychain-service-name', 'cua-container:never'] });
  let signed = 0;
  await assert.rejects(buildCopy({ ...s.opts, sign: async () => { signed += 1; return okSign(); } }), (e) => e.code === 'MANDATORY_EDITS_MISSING' && e.details.missing.join() === 'cua-container:never');
  assert.equal(signed, 0); assert.deepEqual(noOutput(s), []);
  setAdapter(s, { mandatoryEdits: ['cua-container', 'keychain-service-name'] });
  const { report } = await buildCopy(s.opts);
  assert.deepEqual(report.mandatoryEdits, { required: ['cua-container', 'keychain-service-name'], applied: ['cua-container', 'keychain-service-name'] });
  setAdapter(s, { mandatoryEdits: 'cua-container' });
  await assert.rejects(buildCopy({ ...s.opts, force: true }), (e) => e.code === 'MANDATORY_EDITS');
  assert.deepEqual(checkMandatoryEdits({ transforms: [], binaryPatches: [] }), [], 'no list: nothing is mandatory');
  assert.throws(() => checkMandatoryEdits({ mandatoryEdits: ['x'], transforms: [{ id: 'y' }] }), (e) => e.code === 'MANDATORY_EDITS_MISSING');
});

const HELPER_PLIST_REL = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist';
const helperRenamePatch = (s) => {
  const bytes = fs.readFileSync(path.join(s.stock.contents, HELPER_PLIST_REL));
  const at = bytes.indexOf('com.openai.sky.CUAService</string>');
  assert.ok(at > 0);
  return strip(patchFor(bytes, { id: 'cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist:1', file: HELPER_PLIST_REL, offset: at + 'com.openai.sky.CUAServic'.length, after: Buffer.from('f').toString('hex') }));
};

test('helper identity: binaryPatches own the plist edit; the builder only verifies it (recorded), the patched plist is what gets signed', async (t) => {
  const tr = T('cua-container', 'const seam = 1;', 'const seam = 2;');
  const s = await setup(t, { transforms: [tr], stockOpts: { helper: true } });
  setAdapter(s, { binaryPatches: [helperRenamePatch(s)] });
  let atSign = null;
  const hp = (app) => path.join(app, 'Contents', HELPER_PLIST_REL);
  const { appPath, report } = await buildCopy({ ...s.opts, sign: async (app) => { atSign = readPlist(hp(app)).CFBundleIdentifier; return okSign(); } });
  assert.equal(readPlist(hp(appPath)).CFBundleIdentifier, 'com.openai.sky.CUAServicf');
  assert.equal(atSign, 'com.openai.sky.CUAServicf', 'patched before signing');
  const id = report.computerUseHelperIdentity;
  assert.deepEqual([id.from, id.to, id.plists, id.renamed.length], ['com.openai.sky.CUAService', 'com.openai.sky.CUAServicf', 2, 1]);
  assert.deepEqual(id.stockPrefixed.map((x) => x.value), ['com.openai.sky.CUAService.Client'], 'reported, not a failure');
  assert.equal(readPlist(hp(s.stock.app)).CFBundleIdentifier, 'com.openai.sky.CUAService', 'stock untouched');
  assert.equal(report.binaryPatches.length, 1);
});

test('helper identity: a pack whose binaryPatches leave the stock id in a helper plist fails the build before signing', async (t) => {
  const tr = T('cua-container', 'const seam = 1;', 'const seam = 2;');
  const s = await setup(t, { transforms: [tr], stockOpts: { helper: true } }); // rename "active" (transform) but nothing patches the plist
  let signed = 0;
  await assert.rejects(buildCopy({ ...s.opts, sign: async () => { signed += 1; return okSign(); } }), (e) => e.code === 'HELPER_IDENTITY_STOCK' && /Codex Computer Use\.app\/Contents\/Info\.plist/.test(e.message));
  assert.equal(signed, 0); assert.deepEqual(noOutput(s), []);
});

test('helper identity: rename in the pack but no helper to find fails closed; no rename in the pack leaves a helper alone', async (t) => {
  const tr = T('cua-container', 'const seam = 1;', 'const seam = 2;');
  const s1 = await setup(t, { transforms: [tr] }); // no helper in the app
  await assert.rejects(buildCopy(s1.opts), (e) => e.code === 'HELPER_IDENTITY');
  assert.deepEqual(noOutput(s1), []);
  const s2 = await setup(t, { stockOpts: { helper: true } }); // helper, but no cua-container edit in the pack
  const { appPath, report } = await buildCopy(s2.opts);
  assert.equal(readPlist(path.join(appPath, 'Contents', HELPER_PLIST_REL)).CFBundleIdentifier, 'com.openai.sky.CUAService');
  assert.equal(report.computerUseHelperIdentity, null);
});

test('verifyHelperIdentity: only a WHOLE stock value counts (any key, nested), suffixed ids are informational', (t) => {
  const dir = tmpdir(t);
  const put = (rel, obj) => writePlist(path.join(dir, 'Resources/cua_node', rel, 'Contents/Info.plist'), obj);
  put('a.app', { CFBundleIdentifier: 'com.openai.sky.CUAServicf', Nested: { Arr: ['com.openai.sky.CUAService.guardian'] } });
  const ok = verifyHelperIdentity(dir);
  assert.deepEqual([ok.plists, ok.renamed.length, ok.stockPrefixed.length], [1, 1, 1]);
  put('b.app', { Other: [{ Group: 'com.openai.sky.CUAService' }] });
  assert.throws(() => verifyHelperIdentity(dir), (e) => e.code === 'HELPER_IDENTITY_STOCK' && /b\.app/.test(e.message));
  assert.equal(verifyHelperIdentity(path.join(dir, 'nowhere')).plists, 0);
});

test('updater suppression is REQUIRED by default (recorded evidence; --allow-updater is the diagnostics escape)', async (t) => {
  const a = await setup(t, { sparkle: true });
  const r = (await buildCopy(a.opts)).report;
  assert.deepEqual(r.updater, { feedURLRemoved: true, automaticChecksOff: true, loaderDisablesSparkle: true, ok: true });
  let signed = 0;
  const c = await setup(t, { sparkle: false });
  await assert.rejects(buildCopy({ ...c.opts, sign: async () => { signed += 1; return okSign(); } }), (e) => e.code === 'UPDATER_NOT_SUPPRESSED' && e.details.loaderDisablesSparkle === false);
  assert.equal(signed, 0); assert.deepEqual(noOutput(c), []);
  const rb = (await buildCopy({ ...c.opts, allowUpdater: true })).report;
  assert.deepEqual([rb.updater.loaderDisablesSparkle, rb.updater.ok], [false, false], 'allowed for diagnostics, still recorded as not suppressed');
  // the pure check: assignment forms and look-alikes
  const plist = path.join(a.stock.contents, 'Info.plist');
  for (const [loader, want] of [["process.env.CODEX_SPARKLE_ENABLED = 'false'", true], ['env["CODEX_SPARKLE_ENABLED"]="false"', true], ["process.env.CODEX_SPARKLE_ENABLED = 'true'", false], ["// CODEX_SPARKLE_ENABLED false", false], ['', false]]) {
    const dir = tmpdir(t); const f = path.join(dir, 'Info.plist'); fs.copyFileSync(plist, f);
    assert.equal(updaterSuppression({ plist: f, composedLoader: loader }).loaderDisablesSparkle, want, loader);
  }
});

test('--require-identity refuses the ad-hoc identity before anything is created; a real identity name is accepted', async (t) => {
  const s = await setup(t);
  let signed = 0;
  await assert.rejects(buildCopy({ ...s.opts, requireIdentity: true, identity: '-', sign: async () => { signed += 1; return okSign(); } }), (e) => e.code === 'IDENTITY_REQUIRED');
  assert.equal(signed, 0); assert.equal(fs.existsSync(s.out), false);
  const ok = await buildCopy({ ...s.opts, requireIdentity: true, identity: 'Apple Development: Test (ABCDE12345)' });
  assert.equal(ok.report.signing.identity, 'Apple Development: Test (ABCDE12345)');
  assert.equal(ok.report.signing.adhoc, false);
  await buildCopy({ ...s.opts, identity: '-', force: true }); // without the flag, ad-hoc still works (QA)
});

// ---- isolation baseline (ARCHITECTURE v1.14)
const BASELINE_FW = ISOLATION_BASELINE_IDS.filter((id) => id !== 'cua-container');
assert.ok(ISOLATION_BASELINE_IDS.includes('cua-disable-locked-use'));

test('isolation baseline: the helper\'s private CODEX_HOME is a baseline edit (m3 session 2, D3); the shipped pack declares and carries it, the superseded 20052 pack does not', () => {
  assert.ok(ISOLATION_BASELINE_IDS.includes('cua-helper-private-home'));
  const pack = (b) => JSON.parse(fs.readFileSync(new URL(`../../adapters/${b}/adapter.json`, import.meta.url), 'utf8'));
  assert.deepEqual(isolationBaselineMissing(pack('26.1007.30912-20156')), []);
  assert.ok(isolationBaselineMissing(pack('26.1007.21159-20052')).includes('cua-helper-private-home'), 'a production build of the old pack is refused: its helper would inherit the app\'s CODEX_HOME');
});
/** A complete synthetic pack: 8 exact baseline ids + cua-bundle-id:* as chained fw patches, cua-container as a transform, cua-container:* as the helper plist patch. */
const NP_FILES = ['Resources/cua_node/lib/node_modules/@oai/cua/dist/native-pipe.js', 'Resources/cua_node/lib/node_modules/@oai/sky/dist/native-pipe.js'];
const NP_SRC = 'const G="2DC432GLL2.com.openai.sky.CUAService";const B="com.openai.sky.CUAService";const E="SKY_CUA_SERVICE_PATM";\n';
/** Two chained rename patches (group id, then bare id) for one file: the declarations of one "native-pipe patch set". */
function renameSet(bytes, file, tag) {
  const out = []; let cur = bytes;
  for (let n = 1; n <= 2; n++) {
    const idx = cur.indexOf('com.openai.sky.CUAService');
    const p = patchFor(cur, { id: `cua-container:${tag}:${n}`, file, offset: idx + 24, after: Buffer.from('f').toString('hex') });
    out.push(strip(p)); cur = p._patched;
  }
  return out;
}
/** A complete synthetic pack: the baseline ids as chained fw patches, cua-container as a transform, helper plist + two native-pipe sets as cua-container:* patches. */
async function baselineSetup(t, { stockExtra = {}, extraFiles = {} } = {}) {
  const tr = T('cua-container', 'const seam = 1;', 'const seam = 2;');
  const s = await setup(t, { transforms: [tr], framework: {}, stockOpts: { helper: true, helperNested: 'com.openai.sky.CUAServicf.Client', extraFiles: { [NP_FILES[0]]: NP_SRC, [NP_FILES[1]]: NP_SRC, ...extraFiles }, ...stockExtra } });
  let cur = fs.readFileSync(s.stock.fwPath);
  const patches = [];
  [...BASELINE_FW, 'cua-bundle-id:main.js:1'].forEach((id, i) => {
    const p = patchFor(cur, { id, offset: cur.length - 60 + 3 * i, after: `0${(i % 9) + 1}0${(i % 9) + 1}0101` });
    patches.push(strip(p)); cur = p._patched;
  });
  patches.push(helperRenamePatch(s));
  const npSets = NP_FILES.map((f, i) => renameSet(fs.readFileSync(path.join(s.stock.contents, f)), f, `np${i + 1}`));
  patches.push(...npSets.flat());
  const mandatory = ['cua-container', ...BASELINE_FW, 'cua-bundle-id:main.js:1', helperRenamePatch(s).id, ...npSets.flat().map((p) => p.id)];
  setAdapter(s, { binaryPatches: patches, mandatoryEdits: mandatory });
  return { s, patches, mandatory, npIds: npSets.flat().map((p) => p.id) };
}
const strict = (s, o = {}) => ({ ...s.opts, allowNoBaseline: false, ...o });

test('isolation baseline: a complete pack builds and the report lists required/applied/missing', async (t) => {
  const { s } = await baselineSetup(t);
  assert.deepEqual(isolationBaselineMissing(JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'))), []);
  const { report } = await buildCopy(strict(s));
  const b = report.isolationBaseline;
  assert.deepEqual(b.missing, []);
  assert.deepEqual([...b.required].sort(), [...ISOLATION_BASELINE_IDS, 'cua-bundle-id:*', 'cua-container:*'].sort());
  assert.deepEqual([...b.applied].sort(), [...b.required].sort());
});

test('isolation baseline: absent or empty mandatoryEdits is refused (everything missing), before signing', async (t) => {
  for (const edits of [undefined, []]) {
    const { s } = await baselineSetup(t);
    const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
    if (edits === undefined) delete a.mandatoryEdits; else a.mandatoryEdits = edits;
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify(a));
    let signed = 0;
    await assert.rejects(buildCopy(strict(s, { sign: async () => { signed += 1; return okSign(); } })), (e) => e.code === 'ISOLATION_BASELINE' && ISOLATION_BASELINE_IDS.every((id) => e.details.missing.includes(id)) && e.details.missing.includes('cua-bundle-id:*') && e.details.missing.includes('cua-container:*'));
    assert.equal(signed, 0); assert.deepEqual(noOutput(s), []);
  }
});

test('isolation baseline: each missing id (not declared, or declared+absent) is named and refuses the build', async (t) => {
  const required = [...ISOLATION_BASELINE_IDS];
  for (const id of required) {
    const { s, patches, mandatory } = await baselineSetup(t);
    const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
    // not declared mandatory (the edit itself is still in the pack)
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, mandatoryEdits: mandatory.filter((x) => x !== id) }));
    await assert.rejects(buildCopy(strict(s)), (e) => e.code === 'ISOLATION_BASELINE' && e.details.missing.join() === id, `undeclared ${id}`);
    // declared but the edit is absent from the pack: the mandatory check names it first
    const patchless = id === 'cua-container' ? { transforms: [] } : { binaryPatches: patches.filter((p) => p.id !== id) };
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, ...patchless }));
    await assert.rejects(buildCopy(strict(s)), (e) => ['MANDATORY_EDITS_MISSING', 'ISOLATION_BASELINE'].includes(e.code) && JSON.stringify(e.details.missing).includes(id), `absent ${id}`);
    assert.deepEqual(noOutput(s), []);
  }
  for (const prefix of ['cua-bundle-id:', 'cua-container:']) {
    const { s, mandatory } = await baselineSetup(t);
    const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
    fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, mandatoryEdits: mandatory.filter((x) => !x.startsWith(prefix) || x === 'cua-container') }));
    await assert.rejects(buildCopy(strict(s)), (e) => e.code === 'ISOLATION_BASELINE' && e.details.missing.join() === `${prefix}*`, prefix);
  }
});

test('isolation baseline: --allow-no-isolation-baseline (qa control, fixtures) skips it and says so in the report', async (t) => {
  const s = await setup(t);
  const { report } = await buildCopy({ ...s.opts, allowNoBaseline: true });
  assert.deepEqual(report.isolationBaseline, { skipped: true, required: [], applied: [], missing: [] });
  await assert.rejects(buildCopy({ ...s.opts, allowNoBaseline: false, force: true }), (e) => e.code === 'ISOLATION_BASELINE');
});

// ---- content scan (ARCHITECTURE v1.15)
const dropNativePipe = (s, patches, mandatory, npIds) => {
  const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, binaryPatches: patches.filter((p) => !npIds.includes(p.id)), mandatoryEdits: mandatory.filter((id) => !npIds.includes(id)) }));
};

test('isolation scan: a complete pack builds with 0 hits and records files/hits/allowlisted', async (t) => {
  const { s } = await baselineSetup(t);
  const { report, appPath } = await buildCopy(strict(s));
  assert.equal(report.isolationScan.hits, 0);
  assert.ok(report.isolationScan.files >= 4, 'native-pipe files, the helper plist and the main bundle were scanned');
  assert.deepEqual(report.isolationScan.allowlisted, []);
  const np = fs.readFileSync(path.join(appPath, 'Contents', NP_FILES[0]), 'utf8');
  assert.match(np, /2DC432GLL2\.com\.openai\.sky\.CUAServicf/); assert.doesNotMatch(np, /CUAService[^f]/);
});

test('isolation scan: dropping BOTH native-pipe patch sets AND their declarations still fails a production build (the baseline prefix groups alone would pass)', async (t) => {
  const { s, patches, mandatory, npIds } = await baselineSetup(t);
  dropNativePipe(s, patches, mandatory, npIds);
  assert.deepEqual(isolationBaselineMissing(JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'))), [], 'declaration-based baseline is satisfied by the other cua-container:* member');
  let signed = 0;
  await assert.rejects(buildCopy(strict(s, { sign: async () => { signed += 1; return okSign(); } })), (e) => e.code === 'ISOLATION_SCAN'
    && NP_FILES.every((f) => e.details.hits.some((h) => h.file === f)) && e.details.hits.every((h) => typeof h.offset === 'number') && /native-pipe\.js@/.test(e.message));
  assert.equal(signed, 0); assert.deepEqual(noOutput(s), []);
  // one set kept, one dropped: still fails, naming only the dropped file
  const { s: s2, patches: p2, mandatory: m2 } = await baselineSetup(t);
  const second = p2.filter((p) => p.id.startsWith('cua-container:np2:')).map((p) => p.id);
  dropNativePipe(s2, p2, m2, second);
  await assert.rejects(buildCopy(strict(s2)), (e) => e.code === 'ISOLATION_SCAN' && e.details.hits.every((h) => h.file === NP_FILES[1]));
  // the scan is part of the diagnostics opt-out, and says so
  const { report } = await buildCopy({ ...strict(s2), allowNoBaseline: true });
  assert.equal(report.isolationScan.skipped, true);
});

test('isolation scan: UTF-16LE occurrences in a Computer Use file are found', async (t) => {
  const blob = Buffer.concat([Buffer.from('MZ'), Buffer.from('com.openai.sky.CUAService', 'utf16le'), Buffer.from([0, 0])]);
  const { s } = await baselineSetup(t, { extraFiles: { 'Resources/cua_node/lib/native/blob.bin': blob } });
  await assert.rejects(buildCopy(strict(s)), (e) => e.code === 'ISOLATION_SCAN' && e.details.hits.length === 1 && e.details.hits[0].encoding === 'utf16le' && e.details.hits[0].file.endsWith('blob.bin') && e.details.hits[0].offset === 2);
});

test('isolation scan: suffix boundary - renamed .guardian/.cli forms pass, a stock suffixed form fails', async (t) => {
  const ok = await baselineSetup(t, { extraFiles: { 'Resources/cua_node/x/ids.txt': 'com.openai.sky.CUAServicf.guardian com.openai.sky.CUAServicf.cli com.openai.sky.CUAServicf.AuthorizationPluginInstaller com.openai.sky.CUAServicf.AuthorizationPlugin' } });
  assert.equal((await buildCopy(strict(ok.s))).report.isolationScan.hits, 0);
  const bad = await baselineSetup(t, { extraFiles: { 'Resources/cua_node/x/ids.txt': 'com.openai.sky.CUAServicf.guardian com.openai.sky.CUAService.cli' } });
  await assert.rejects(buildCopy(strict(bad.s)), (e) => e.code === 'ISOLATION_SCAN' && e.details.hits.length === 1 && e.details.hits[0].offset === 'com.openai.sky.CUAServicf.guardian '.length);
});

test('isolation scan: the asar main/src/worker bundles are scanned after the transforms', async (t) => {
  const stockToken = 'const leaked = "2DC432GLL2.com.openai.sky.CUAService";';
  const tr = { ...T('cua-container', 'const seam = 1;', `const seam = 1;${stockToken}`, 'insert-after-once'), find: 'const seam = 1;' };
  const { s } = await baselineSetup(t);
  const a = JSON.parse(fs.readFileSync(s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(s.inputs.adapterPath, JSON.stringify({ ...a, transforms: [clean({ ...tr, op: 'insert-after-once', text: stockToken, sha256After: sha(MAIN_JS.replace('const seam = 1;', `const seam = 1;${stockToken}`)) })] }));
  await assert.rejects(buildCopy(strict(s)), (e) => e.code === 'ISOLATION_SCAN' && e.details.hits.some((h) => h.file === 'app.asar:.vite/build/main.js' && h.kind === 'group-id'));
});

test('helper provisioning profiles are removed before the scan and recorded', async (t) => {
  const { s } = await baselineSetup(t, { extraFiles: { 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/embedded.provisionprofile': 'group.com.openai.sky.CUAService 2DC432GLL2.com.openai.sky.CUAService' } });
  const { report, appPath } = await buildCopy(strict(s));
  assert.equal(report.isolationScan.hits, 0);
  assert.deepEqual(report.removedProvisionProfiles, ['Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/embedded.provisionprofile']);
  assert.equal(fs.existsSync(path.join(appPath, 'Contents', report.removedProvisionProfiles[0])), false);
});

// ---- v1.16: locked-use payload removal, team-matched container, post-sign entitlement scan
const SKY_APP = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents';
const INSTALLER_FILES = {
  [`${SKY_APP}/SharedSupport/Codex Computer Use Installer.app/Contents/Info.plist`]: 'installer plist',
  [`${SKY_APP}/SharedSupport/Codex Computer Use Installer.app/Contents/MacOS/Installer`]: 'x',
  [`${SKY_APP}/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin`]: 'plugin',
  [`${SKY_APP}/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPluginInstallerTool`]: 'tool',
  'Resources/stray/CodexComputerUseAuthorizationPluginInstallerTool': 'another copy anywhere in the bundle',
};
const OLD = '2DC432GLL2.com.openai.sky.CUAServicf';
const TEAMID = 'ABCDE12345';
const IDENT = `Apple Development: Test (${TEAMID})`;
const NEW = `${TEAMID}.com.openai.sky.CUAServicf`;

test('locked-use payload: the nested installer app, plugin bundle and installer tool (and other copies) are removed and recorded; the rest of the helper stays', async (t) => {
  const { s } = await baselineSetup(t, { extraFiles: { ...INSTALLER_FILES, [`${SKY_APP}/MacOS/SkyComputerUseService`]: 'service' } });
  const { report, appPath } = await buildCopy(strict(s));
  assert.deepEqual(report.removedLockedUsePayload, [
    `${SKY_APP}/SharedSupport/Codex Computer Use Installer.app`,
    'Resources/stray/CodexComputerUseAuthorizationPluginInstallerTool',
  ].sort());
  for (const rel of report.removedLockedUsePayload) assert.equal(fs.existsSync(path.join(appPath, 'Contents', rel)), false, rel);
  assert.ok(fs.existsSync(path.join(appPath, 'Contents', SKY_APP, 'MacOS/SkyComputerUseService')));
  assert.ok(fs.existsSync(path.join(appPath, 'Contents', SKY_APP, 'Info.plist')));
});

test('locked-use payload: anything named like it that remains under the Computer Use tree fails the build (LOCKED_USE_PAYLOAD) before signing', async (t) => {
  for (const name of ['SomethingInstaller.js', 'x/AuthorizationPluginHelper', 'Installer']) {
    const { s } = await baselineSetup(t, { extraFiles: { [`Resources/cua_node/lib/${name}`]: 'x' } });
    let signed = 0;
    await assert.rejects(buildCopy(strict(s, { sign: async () => { signed += 1; return okSign(); } })), (e) => e.code === 'LOCKED_USE_PAYLOAD' && e.details.leftovers.length >= 1, name);
    assert.equal(signed, 0); assert.deepEqual(noOutput(s), []);
  }
});

/** A team build: extra stock-prefixed container ids in UTF-8, UTF-16LE and the asar main bundle (via transform), on top of the native-pipe renames. */
async function teamSetup(t, extra = {}) {
  const utf16 = Buffer.concat([Buffer.from('xx'), Buffer.from(OLD, 'utf16le'), Buffer.from([0, 0])]);
  const base = await baselineSetup(t, { extraFiles: { 'Resources/cua_node/lib/native/blob.bin': utf16, 'Resources/cua_node/lib/native/ids.txt': `a ${OLD} b ${OLD}`, [NATIVE_PEER_REL]: nativePeerAddon(), ...extra } });
  const tr = T('cua-container', 'const seam = 1;', `const seam = 1;const g="${OLD}";`, 'insert-after-once');
  const a = JSON.parse(fs.readFileSync(base.s.inputs.adapterPath, 'utf8'));
  fs.writeFileSync(base.s.inputs.adapterPath, JSON.stringify({ ...a, transforms: [{ ...clean(tr), op: 'insert-after-once', find: 'const seam = 1;', text: `const g="${OLD}";`, sha256After: sha(MAIN_JS.replace('const seam = 1;', `const seam = 1;const g="${OLD}";`)) }] }));
  return base;
}
const teamSign = (calls = []) => async (app, o) => { calls.push(o); return { signed: 3, verified: true, required: ['.', 'Contents/Resources/cua_node/helper'], targets: [{ path: '.', type: 'bundle', entitled: true }, { path: 'Contents/Resources/cua_node/helper', type: 'file', entitled: true }, { path: 'Contents/Resources/cua_node/lib/other', type: 'file', entitled: false }] }; };
const teamOpts = (s, o = {}) => strict(s, { identity: IDENT, readTeamIdentifier: async () => TEAMID,
  dumpSignedEntitlements: async () => [{ path: '.', ents: { 'com.apple.security.application-groups': [NEW] } }, { path: 'Contents/Resources/cua_node/helper', ents: { 'com.apple.security.application-groups': [NEW] } }], ...o });

test('team build: the container id is rewritten in place at every site (UTF-8, UTF-16LE, asar main bundle), the signer gets the team group, and it is reported', async (t) => {
  const { s } = await teamSetup(t);
  const calls = [];
  const { appPath, report } = await buildCopy(teamOpts(s, { sign: teamSign(calls) }));
  assert.equal(calls[0].appGroup, NEW, 'signing is asked for the team-matched group');
  const read = (rel) => fs.readFileSync(path.join(appPath, 'Contents', rel));
  assert.equal(read('Resources/cua_node/lib/native/ids.txt').toString(), `a ${NEW} b ${NEW}`);
  const blob = read('Resources/cua_node/lib/native/blob.bin');
  assert.ok(blob.includes(Buffer.from(NEW, 'utf16le')) && !blob.includes(Buffer.from(OLD, 'utf16le')));
  assert.equal(blob.length, 2 + OLD.length * 2 + 2, 'same length');
  assert.match(read(NP_FILES[0]).toString(), new RegExp(NEW.replace(/\./g, '\\.')));
  const main = AsarArchive.open(path.join(appPath, 'Contents/Resources/app.asar')).read('.vite/build/main.js').toString();
  assert.ok(main.includes(NEW) && !main.includes(OLD));
  const c = report.computerUseContainer;
  assert.deepEqual([c.id, c.teamId], [NEW, TEAMID]);
  assert.equal(c.sites, c.siteList.reduce((n, x) => n + x.count, 0));
  assert.ok(c.siteList.some((x) => x.file === 'app.asar:.vite/build/main.js') && c.sites === 6);
  assert.deepEqual(c.entitled, ['.', 'Contents/Resources/cua_node/helper']);
  assert.deepEqual(c.required, ['.', 'Contents/Resources/cua_node/helper'], 'the required grant set is recorded');
  assert.deepEqual([report.postSignEntitlements.signerTeam, report.postSignEntitlements.objects, report.postSignEntitlements.hits], [TEAMID, 2, 0]);
  assert.equal(report.isolationScan.hits, 0);
});

test('team build: a leftover OpenAI-team container id fails the scan; no site to rewrite, an underivable team and a wrong signer team fail closed', async (t) => {
  // the scanner itself flags an unrewritten id in a team build
  const dir = tmpdir(t); fs.mkdirSync(path.join(dir, 'Resources/cua_node'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Resources/cua_node/x.txt'), `ok ${NEW} bad ${OLD}`);
  const r = isolationScan(dir, [], { forbidOldGroup: true });
  assert.deepEqual(r.hits.map((h) => [h.kind, h.offset]), [['unrewritten-group', `ok ${NEW} bad `.length]]);
  assert.deepEqual(isolationScan(dir, [], { forbidOldGroup: false }).hits, [], 'ad-hoc builds keep the OpenAI-prefixed container');
  // underivable team
  const a = await baselineSetup(t);
  await assert.rejects(buildCopy(strict(a.s, { identity: 'Some Identity Without Team' })), (e) => e.code === 'TEAM_ID');
  assert.deepEqual(noOutput(a.s), []);
  // the signature says another team than the one the container was rewritten for
  const b = await teamSetup(t);
  await assert.rejects(buildCopy(teamOpts(b.s, { sign: teamSign(), readTeamIdentifier: async () => 'ZZZZZZZZZZ' })), (e) => e.code === 'TEAM_ID_MISMATCH');
  assert.deepEqual(noOutput(b.s), []);
  // an explicit --team-id wins over the name; an invalid one is refused
  const c = await teamSetup(t);
  await assert.rejects(buildCopy(teamOpts(c.s, { sign: teamSign(), identity: 'Name (ABCDE12345)', teamId: 'abc' })), (e) => e.code === 'TEAM_ID');
});

test('ad-hoc build: no rewrite, no group entitlement requested, container stays under the OpenAI prefix', async (t) => {
  const { s } = await teamSetup(t);
  const calls = [];
  const { appPath, report } = await buildCopy(strict(s, { sign: teamSign(calls) }));
  assert.equal(calls[0].appGroup, null);
  assert.equal(fs.readFileSync(path.join(appPath, 'Contents/Resources/cua_node/lib/native/ids.txt'), 'utf8'), `a ${OLD} b ${OLD}`);
  assert.deepEqual([report.computerUseContainer.id, report.computerUseContainer.teamId, report.computerUseContainer.sites], [OLD, null, 0]);
  assert.equal(report.postSignEntitlements.signerTeam, null);
  assert.equal(report.nativePeerAuthRewrite, null, 'ad-hoc: the native peer-auth addon is not rewritten (N9 is team builds only)');
  assert.ok(fs.readFileSync(path.join(appPath, 'Contents', NATIVE_PEER_REL)).includes(Buffer.from(STOCKTEAM)), 'ad-hoc: the stock team id stays (an ad-hoc copy cannot pass a team check anyway)');
});

test('post-sign entitlement scan: a wrong-team group, any group on an ad-hoc signature, and stock tokens in signed entitlements fail the build', async (t) => {
  const group = (g) => ({ 'com.apple.security.application-groups': [g] });
  // wrong team group (team build)
  const a = await teamSetup(t);
  await assert.rejects(buildCopy(teamOpts(a.s, { sign: teamSign(), dumpSignedEntitlements: async () => [{ path: '.', ents: group(`ZZZZZZZZZZ.com.openai.sky.CUAServicf`) }] })),
    (e) => e.code === 'ENTITLEMENT_TEAM' && e.details.mismatches[0].why.includes('ZZZZZZZZZZ'));
  assert.deepEqual(noOutput(a.s), []);
  // not team-prefixed
  await assert.rejects(buildCopy(teamOpts(a.s, { sign: teamSign(), dumpSignedEntitlements: async () => [{ path: '.', ents: group('group.com.openai.sky.CUAServicf') }] })), (e) => e.code === 'ENTITLEMENT_TEAM');
  // ad-hoc signature carrying an app group
  const b = await baselineSetup(t);
  await assert.rejects(buildCopy(strict(b.s, { sign: okSign, dumpSignedEntitlements: async () => [{ path: '.', ents: group(NEW) }] })), (e) => e.code === 'ENTITLEMENT_TEAM' && /ad-hoc/.test(e.message));
  // stock tokens in retained entitlement values (the signer copies them after the pre-sign scan)
  for (const ents of [{ 'com.apple.security.temporary-exception.mach-lookup.global-name': '2DC432GLL2.com.openai.sky.CUAService' }, { x: ['com.openai.sky.CUAService.guardian'] }, { env: 'SKY_CUA_SERVICE_PATH' }]) {
    await assert.rejects(buildCopy(strict(b.s, { sign: okSign, dumpSignedEntitlements: async () => [{ path: 'Contents/Resources/cua_node/helper', ents }] })), (e) => e.code === 'ISOLATION_SCAN' && e.details.postSign === true && /entitlements:Contents\/Resources\/cua_node\/helper/.test(e.message), JSON.stringify(ents));
  }
  // team build: the OpenAI-prefixed container id retained in an entitlement is a hit too
  const c = await teamSetup(t);
  await assert.rejects(buildCopy(teamOpts(c.s, { sign: teamSign(), dumpSignedEntitlements: async () => [{ path: '.', ents: { k: OLD } }] })), (e) => e.code === 'ISOLATION_SCAN' && e.details.postSign);
  // clean ad-hoc passes and records the dump
  const ok = await buildCopy(strict(b.s, { sign: okSign, dumpSignedEntitlements: async () => [{ path: '.', ents: { 'com.apple.security.cs.allow-jit': true } }] }));
  assert.deepEqual(ok.report.postSignEntitlements, { objects: 1, hits: 0, signerTeam: null, groups: {} });
});

test('required grants: after signing, the ACTUAL embedded entitlements of each required executable must be exactly [<TEAM>.com.openai.sky.CUAServicf] (ENTITLEMENT_MISSING)', async (t) => {
  const g = (list) => ({ 'com.apple.security.application-groups': list });
  const dump = (helper) => async () => [{ path: '.', ents: g([NEW]) }, { path: 'Contents/Resources/cua_node/helper', ents: helper }];
  const cases = [
    ['no grant embedded', {}],
    ['extra group', g([NEW, 'ABCDE12345.extra'])],
    ['another group only', g(['ABCDE12345.other'])],
    ['empty list', g([])],
  ];
  for (const [label, helper] of cases) {
    const { s } = await teamSetup(t);
    // the signing plan CLAIMS it entitled the helper (teamSign says entitled:true): only the embedded truth counts
    await assert.rejects(buildCopy(teamOpts(s, { sign: teamSign(), dumpSignedEntitlements: dump(helper) })),
      (e) => ['ENTITLEMENT_MISSING', 'ENTITLEMENT_TEAM'].includes(e.code) && (e.code === 'ENTITLEMENT_MISSING' ? e.details.missing.join() === 'Contents/Resources/cua_node/helper' : true), label);
    assert.deepEqual(noOutput(s), [], label);
  }
  // a required executable that is not among the dumped objects at all
  const { s: s2 } = await teamSetup(t);
  await assert.rejects(buildCopy(teamOpts(s2, { sign: teamSign(), dumpSignedEntitlements: async () => [{ path: '.', ents: g([NEW]) }] })), (e) => e.code === 'ENTITLEMENT_MISSING');
  // exactly right passes
  const { s: s3 } = await teamSetup(t);
  const ok = await buildCopy(teamOpts(s3, { sign: teamSign(), dumpSignedEntitlements: dump(g([NEW])) }));
  assert.deepEqual(ok.report.computerUseContainer.required, ['.', 'Contents/Resources/cua_node/helper']);
  // ad-hoc builds do not require grants (and get none)
  const { s: s4 } = await teamSetup(t);
  const adhoc = await buildCopy(strict(s4, { sign: teamSign() }));
  assert.equal(adhoc.report.postSignEntitlements.groups['.'], undefined);
});

test('an unreadable embedded entitlement blob fails the build (ENTITLEMENT_READ) instead of counting as "none"', async (t) => {
  const { s } = await baselineSetup(t);
  await assert.rejects(buildCopy(strict(s, { sign: okSign, dumpSignedEntitlements: async () => { throw new EntitlementReadError('Contents/Resources/cua_node/x', 'codesign reports an invalid entitlements blob'); } })), (e) => e.code === 'ENTITLEMENT_READ');
  assert.deepEqual(noOutput(s), []);
});

// ---- the helper pins its clients by OpenAI's bare Team ID
const STOCKTEAM = '2DC432GLL2';
const CODEREQ = (team) => `<?xml version="1.0"?><plist version="1.0"><dict><key>team-identifier</key><string>${team}</string></dict></plist>`;
const CU_SERVICE = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService';
const CU_REQ = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Resources/SkyComputerUseClient_Parent.coderequirement';
function machoFixture() { // a real signed Mach-O with the bare ids appended outside the signature and one planted inside it
  const buf = fs.readFileSync('/usr/bin/true');
  const [[a]] = signatureRanges(buf);
  const inSig = Buffer.from(buf); Buffer.from(STOCKTEAM).copy(inSig, a + 64);
  return { plain: Buffer.concat([buf, Buffer.from(`\0client node ${STOCKTEAM}\0other MQ55VZLNZQ HX7739G8FX\0`), Buffer.from(`${STOCKTEAM}\0`, 'utf16le')]), inSig };
}
const teamFiles = () => ({ [CU_SERVICE]: machoFixture().plain, [CU_REQ]: CODEREQ(STOCKTEAM), 'Resources/cua_node/lib/plain.js': `const t = "${STOCKTEAM}"; const o = "MQ55VZLNZQ";` });

// adapter NOTES N9: the native peer-auth addon under Resources/native (NOT cua_node). A real signed Mach-O with EXACTLY ONE rewritable stock
// team id outside the signature (what the builder re-pins), plus one planted inside the signature blob that must be left alone, and another
// team id that must stay. Every team build fixture carries it, because the N9 guard refuses a team build that lacks the file.
const NATIVE_PEER_REL = 'Resources/native/browser-use-peer-authorization.node';
function nativePeerAddon(n = 1) { // n rewritable stock team ids outside the signature (default one); the drift tests use 0 and 2
  const buf = fs.readFileSync('/usr/bin/true');
  const [[a]] = signatureRanges(buf);
  const b = Buffer.from(buf); Buffer.from(STOCKTEAM).copy(b, a + 64);
  return Buffer.concat([b, Buffer.from(`\0${`peer-auth team ${STOCKTEAM} `.repeat(n)}keep MQ55VZLNZQ\0`)]);
}

test('team build: the bare stock team id is rewritten (Mach-O UTF-8 + UTF-16LE, .coderequirement plist, js) under cua_node only, other team ids stay, and it is reported', async (t) => {
  const { s } = await teamSetup(t, teamFiles());
  // outside cua_node: the main app is untouched (a stray reference there stays byte-identical)
  const out = await buildCopy(teamOpts(s, { sign: teamSign() }));
  const read = (rel) => fs.readFileSync(path.join(out.appPath, 'Contents', rel));
  const svc = read(CU_SERVICE);
  assert.equal(svc.includes(Buffer.from(STOCKTEAM)), false); assert.equal(svc.includes(Buffer.from(STOCKTEAM, 'utf16le')), false);
  assert.ok(svc.includes(Buffer.from(`client node ${TEAMID}\0other MQ55VZLNZQ HX7739G8FX`)), 'rewritten in place, other team ids kept');
  assert.ok(svc.includes(Buffer.from(`${TEAMID}\0`, 'utf16le')));
  assert.equal(svc.length, machoFixture().plain.length, 'same length');
  assert.equal(read(CU_REQ).toString(), CODEREQ(TEAMID));
  assert.equal(read('Resources/cua_node/lib/plain.js').toString(), `const t = "${TEAMID}"; const o = "MQ55VZLNZQ";`);
  const r = out.report.computerUseTeamRewrite;
  assert.deepEqual([r.team, r.from], [TEAMID, STOCKTEAM]);
  assert.deepEqual(r.sites.map((x) => x.file).sort(), [CU_REQ, 'Resources/cua_node/lib/plain.js', CU_SERVICE].sort());
  assert.equal(r.sites.find((x) => x.file === CU_SERVICE).count, 2);
  assert.equal(fs.statSync(path.join(out.appPath, 'Contents', CU_SERVICE)).mode & 0o777, fs.statSync(path.join(s.stock.app, 'Contents', CU_SERVICE)).mode & 0o777);
});

test('rewriteBareTeamBuffer skips bytes inside a Mach-O signature blob and never touches other team ids; ad-hoc builds leave the id alone', async (t) => {
  const { inSig } = machoFixture();
  const r = rewriteBareTeamBuffer(inSig, TEAMID);
  assert.equal(r.count, 0); assert.equal(r.buf, inSig, 'untouched');
  assert.throws(() => rewriteBareTeamBuffer(Buffer.from(STOCKTEAM), 'short'), /invalid team/);
  const o = rewriteBareTeamBuffer(Buffer.from('MQ55VZLNZQ HX7739G8FX'), TEAMID); assert.equal(o.count, 0);
  const { s } = await baselineSetup(t, { extraFiles: teamFiles() });
  const out = await buildCopy(strict(s, { sign: okSign }));
  assert.equal(fs.readFileSync(path.join(out.appPath, 'Contents', CU_REQ)).toString(), CODEREQ(STOCKTEAM), 'ad-hoc: unchanged');
  assert.deepEqual(out.report.computerUseTeamRewrite, { team: null, sites: [] });
});

test('the main app outside cua_node keeps the bare id; a leftover under cua_node after signing fails the build (ISOLATION_SCAN, postSign)', async (t) => {
  const { s } = await teamSetup(t, { ...teamFiles(), 'Frameworks/keep.txt': `main app reference ${STOCKTEAM}` });
  const ok = await buildCopy(teamOpts(s, { sign: teamSign() }));
  assert.equal(fs.readFileSync(path.join(ok.appPath, 'Contents/Frameworks/keep.txt')).toString(), `main app reference ${STOCKTEAM}`);
  // the signing step (a stub) leaves/introduces the stock id under cua_node
  const b = await teamSetup(t, teamFiles());
  const leaky = async (app, o) => { fs.writeFileSync(path.join(app, 'Contents/Resources/cua_node/lib/leak.txt'), `pin ${STOCKTEAM}`); return teamSign()(app, o); };
  await assert.rejects(buildCopy(teamOpts(b.s, { sign: leaky })), (e) => e.code === 'ISOLATION_SCAN' && e.details.postSign === true && /after signing/.test(e.message) && e.details.hits[0].file.endsWith('leak.txt'));
  assert.deepEqual(noOutput(b.s), []);
});

test('stockTeamLeftovers finds UTF-8 and UTF-16LE ids and honours the signature skip and the allowlist', (t) => {
  const dir = tmpdir(t); const cn = path.join(dir, 'Resources/cua_node'); fs.mkdirSync(cn, { recursive: true });
  fs.writeFileSync(path.join(cn, 'a.txt'), `x ${STOCKTEAM}`); fs.writeFileSync(path.join(cn, 'b.bin'), Buffer.from(STOCKTEAM, 'utf16le')); fs.writeFileSync(path.join(cn, 'c.bin'), machoFixture().inSig);
  fs.mkdirSync(path.join(dir, 'Frameworks')); fs.writeFileSync(path.join(dir, 'Frameworks/outside.txt'), STOCKTEAM);
  assert.deepEqual(stockTeamLeftovers(dir).map((h) => h.file).sort(), ['Resources/cua_node/a.txt', 'Resources/cua_node/b.bin']);
  assert.deepEqual(stockTeamLeftovers(dir, { allowlist: [{ file: 'Resources/cua_node/a.txt' }] }).map((h) => h.file), ['Resources/cua_node/b.bin']);
});

// ---- N9 (adapter NOTES): the native peer-auth addon under Resources/native, outside cua_node, is re-pinned to our team too
test('team build (N9): browser-use-peer-authorization.node is re-pinned to our team in place (same length, outside the signature) and reported; the signature blob is left for the re-sign', async (t) => {
  const { s } = await teamSetup(t);
  const out = await buildCopy(teamOpts(s, { sign: teamSign() }));
  const native = fs.readFileSync(path.join(out.appPath, 'Contents', NATIVE_PEER_REL));
  assert.equal(native.length, nativePeerAddon().length, 'same length');
  assert.ok(native.includes(Buffer.from(`peer-auth team ${TEAMID}`)), 'the socket-peer pin is now ours');
  assert.ok(native.includes(Buffer.from('MQ55VZLNZQ')), 'another team id is untouched');
  assert.deepEqual(out.report.nativePeerAuthRewrite, { file: NATIVE_PEER_REL, count: 1 });
  assert.equal(fs.statSync(path.join(out.appPath, 'Contents', NATIVE_PEER_REL)).mode & 0o777, fs.statSync(path.join(s.stock.contents, NATIVE_PEER_REL)).mode & 0o777, 'mode preserved');
  // the stock id survives ONLY inside the (stub-unsigned) signature blob the real re-sign replaces
  const [[a, bEnd]] = signatureRanges(native);
  const hits = []; for (let i = native.indexOf(Buffer.from(STOCKTEAM)); i >= 0; i = native.indexOf(Buffer.from(STOCKTEAM), i + 1)) hits.push(i);
  assert.ok(hits.length === 1 && hits[0] >= a && hits[0] < bEnd, 'the only stock id left is inside the signature');
});

test('team build (N9): a missing or drifted native peer-auth addon fails closed before signing (NATIVE_PEER_AUTH_*), so a stock drift cannot silently no-op', async (t) => {
  // missing (deleted from the stock bundle the copy is cloned from)
  const miss = await teamSetup(t);
  fs.rmSync(path.join(miss.s.stock.contents, NATIVE_PEER_REL));
  let signed = 0;
  await assert.rejects(buildCopy(teamOpts(miss.s, { sign: async (app, o) => { signed += 1; return teamSign()(app, o); } })),
    (e) => e.code === 'NATIVE_PEER_AUTH_MISSING' && e.details.file === NATIVE_PEER_REL);
  assert.equal(signed, 0, 'refused before signing'); assert.deepEqual(noOutput(miss.s), []);
  // drift: zero rewritable occurrences (a stock change that would otherwise be a silent no-op)
  const zero = await teamSetup(t, { [NATIVE_PEER_REL]: nativePeerAddon(0) });
  await assert.rejects(buildCopy(teamOpts(zero.s, { sign: teamSign() })), (e) => e.code === 'NATIVE_PEER_AUTH_DRIFT' && e.details.count === 0);
  assert.deepEqual(noOutput(zero.s), []);
  // drift: more than one rewritable occurrence
  const two = await teamSetup(t, { [NATIVE_PEER_REL]: nativePeerAddon(2) });
  await assert.rejects(buildCopy(teamOpts(two.s, { sign: teamSign() })), (e) => e.code === 'NATIVE_PEER_AUTH_DRIFT' && e.details.count === 2);
  assert.deepEqual(noOutput(two.s), []);
});

test('post-sign (N9): the leftovers scan now covers Resources/native too — a stock team id introduced there by signing fails the build (ISOLATION_SCAN, postSign)', async (t) => {
  const { s } = await teamSetup(t);
  const leaky = async (app, o) => { fs.writeFileSync(path.join(app, 'Contents/Resources/native/leak.bin'), `pin ${STOCKTEAM}`); return teamSign()(app, o); };
  await assert.rejects(buildCopy(teamOpts(s, { sign: leaky })),
    (e) => e.code === 'ISOLATION_SCAN' && e.details.postSign === true && /Resources\/native/.test(e.message) && e.details.hits.some((h) => h.file === 'Resources/native/leak.bin'));
  assert.deepEqual(noOutput(s), []);
});
