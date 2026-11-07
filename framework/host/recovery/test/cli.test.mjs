import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink, readlink, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run as setup } from '../../../../cli/commands/setup.mjs';
import { run as app } from '../../../../cli/commands/app.mjs';
import { run as framework } from '../../../../cli/commands/framework.mjs';
import { run as recovery } from '../../../../cli/commands/recovery.mjs';
import { layout as makeLayout } from '../../../../contracts/layout.mjs';
import { readJson, writeJsonAtomic } from '../../fsutil.mjs';
import { readText, writeTextAtomic, frameworkVersionOf } from '../support.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, makeApp, fakeBuildReport, makeFrameworkTree, baseAdapter } from './helpers.mjs';

const exists = (p) => lstat(p).then(() => true, () => false);
function io(t, deps = {}) {
  const out = []; const err = [];
  return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {}, deps: { home: join(t.dir, 'home'), ...deps } };
}
const rootFlags = (t) => ['--root', join(t.dir, 'root')];
const L = (t) => makeLayout(join(t.dir, 'root'), 'default');
function fakeHost(handlers) {
  const calls = [];
  return { calls, connectManagement: async () => ({
    request: async (method, params) => { calls.push([method, params]); return handlers[method](params); },
    close() {},
  }) };
}

// ------------------------------------------------------------------ recovery flags (offline)
test('recovery safe on/off, disable/enable work offline and keep state.json consistent', async () => {
  const t = await tempRoot();
  try {
    const l = L(t);
    await writeJsonAtomic(l.state, { schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 });
    const i = io(t, { connectManagement: async () => null });
    assert.equal(await recovery([...rootFlags(t), 'safe', 'on'], i), 0);
    assert.equal((await readJson(join(l.flags, 'safe'))).reason, 'cli');
    assert.equal((await readJson(l.state)).safeMode, true);
    assert.equal(await recovery([...rootFlags(t), 'safe', 'off'], i), 0);
    assert.equal(await exists(join(l.flags, 'safe')), false);
    assert.equal((await readJson(l.state)).safeMode, false);
    assert.equal(await recovery([...rootFlags(t), 'disable'], i), 0);
    assert.ok((await readJson(join(l.flags, 'disabled'))).at);
    assert.equal(await recovery([...rootFlags(t), 'enable'], i), 0);
    assert.equal(await exists(join(l.flags, 'disabled')), false);
    assert.equal(await recovery([...rootFlags(t), 'enable'], i), 0, 'enable is idempotent');
    // usage errors
    assert.equal(await recovery([...rootFlags(t), 'safe'], io(t)), 64);
    assert.equal(await recovery([...rootFlags(t), 'bogus'], io(t)), 64);
    assert.equal(await recovery([...rootFlags(t), '--nope'], io(t)), 64);
  } finally { await t.cleanup(); }
});

test('recovery safe goes through the safe-mode operation when a Host is running', async () => {
  const t = await tempRoot();
  try {
    const host = fakeHost({ 'recovery.safeMode': () => ({ opId: 'op-1' }), 'recovery.lkg': () => ({ opId: 'op-2' }) });
    const i = io(t, host);
    assert.equal(await recovery([...rootFlags(t), 'safe', 'on'], i), 0);
    assert.equal(await recovery([...rootFlags(t), 'lkg'], i), 0);
    assert.deepEqual(host.calls, [['recovery.safeMode', { enter: true }], ['recovery.lkg', {}]]);
    assert.equal(await exists(join(L(t).flags, 'safe')), false, 'no flag file edits while the Host owns the state');
  } finally { await t.cleanup(); }
});

test('recovery lkg offline restores the file-level parts and says records were not restored', async () => {
  const t = await tempRoot();
  try {
    const l = L(t);
    for (const v of ['1.0.0', '2.0.0']) { await mkdir(join(l.framework, v, 'framework', 'main'), { recursive: true }); await writeFile(join(l.framework, v, 'framework', 'main', 'index.cjs'), ''); }
    await writeTextAtomic(l.frameworkCurrent, '2.0.0');
    const oldApp = join(l.apps, 'b1', 'App.app'), newApp = join(l.apps, 'b2', 'App.app');
    await writeJsonAtomic(join(l.generations, '4.json'), { n: 4, frameworkVersion: '1.0.0', appBuild: 'b1', appCandidate: oldApp });
    await writeTextAtomic(join(l.generations, 'lkg'), '4');
    await mkdir(oldApp, { recursive: true }); await mkdir(newApp, { recursive: true });
    await writeTextAtomic(l.lkgApp, oldApp);
    const stable = join(t.dir, 'Applications', 'ChatGPT Mods.app');
    await mkdir(join(t.dir, 'Applications'));
    await symlink(newApp, stable);
    await writeJsonAtomic(l.profileConfig, { codexHome: l.codexHome, guardStockApp: false, signingIdentity: '-', appPath: stable });
    await writeJsonAtomic(join(l.flags, 'safe'), { reason: 'x' });
    const i = io(t, { connectManagement: async () => null });
    assert.equal(await recovery([...rootFlags(t), 'lkg'], i), 0);
    assert.equal(await readText(l.frameworkCurrent), '1.0.0');
    assert.equal(await readText(l.frameworkPrevious), '2.0.0');
    assert.equal(await readlink(stable), oldApp);
    assert.equal((await readJson(join(l.flags, 'safe'))).reason, 'offline-lkg', 'safe mode stays on for the next launch');
    assert.match(i.out.join(''), /Mod records and mod settings are NOT restored: only the online operation/);
    assert.match(i.out.join(''), /next launch starts in SAFE MODE/);
    // the LKG candidate vanished: refuse with the reason, change nothing
    await rm(stable); await symlink(newApp, stable);
    await writeTextAtomic(l.frameworkCurrent, '2.0.0');
    await rm(oldApp, { recursive: true });
    const gone = io(t, { connectManagement: async () => null });
    assert.equal(await recovery([...rootFlags(t), 'lkg'], gone), 1);
    assert.match(gone.err.join(''), /app copy of the last-known-good generation is gone/);
    assert.equal(await readText(l.frameworkCurrent), '2.0.0');
    assert.equal(await readlink(stable), newApp);
    // no LKG at all
    await rm(join(l.generations, 'lkg'));
    assert.equal(await recovery([...rootFlags(t), 'lkg'], io(t, { connectManagement: async () => null })), 1);
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------ framework
test('framework install offline sets previous/current; rollback swaps them; both refuse bad input', async () => {
  const t = await tempRoot();
  try {
    const l = L(t);
    const i = io(t, { connectManagement: async () => null });
    const v1 = join(t.dir, 'v1'), v2 = join(t.dir, 'v2');
    await makeFrameworkTree(v1, { version: '1.0.0' }); await makeFrameworkTree(v2, { version: '2.0.0', marker: 'b' });
    const n1 = await frameworkVersionOf(v1), n2 = await frameworkVersionOf(v2);
    assert.match(n1, /^1\.0\.0\+[0-9a-f]{8}$/);
    assert.equal(await framework([...rootFlags(t), 'install', v1], i), 0);
    assert.equal(await framework([...rootFlags(t), 'install', v2], i), 0);
    assert.equal(await readText(l.frameworkCurrent), n2);
    assert.equal(await readText(l.frameworkPrevious), n1);
    assert.match(await readFile(join(l.framework, n2, 'framework', 'main', 'index.cjs'), 'utf8'), /"b"/);
    assert.equal(await framework([...rootFlags(t), 'rollback'], i), 0);
    assert.equal(await readText(l.frameworkCurrent), n1);
    assert.equal(await readText(l.frameworkPrevious), n2);
    assert.equal(await framework([...rootFlags(t), 'install', t.dir], i), 64, 'not a framework tree');
    assert.equal(await framework([...rootFlags(t), 'install', v1, '--version', '../x'], i), 64);
    await rm(join(l.framework, n2), { recursive: true });
    assert.equal(await framework([...rootFlags(t), 'rollback'], io(t)), 1, 'the previous version is gone');
  } finally { await t.cleanup(); }
});

test('framework install goes through updates.framework when the Host runs', async () => {
  const t = await tempRoot();
  try {
    const v = join(t.dir, 'v'); await makeFrameworkTree(v, { version: '3.0.0' });
    const host = fakeHost({ 'updates.framework': () => ({ opId: 'op-9' }), 'ops.get': () => ({ id: 'op-9', outcome: 'succeeded' }) });
    const i = io(t, host);
    assert.equal(await framework([...rootFlags(t), 'install', v], i), 0);
    const name = await frameworkVersionOf(v);
    assert.deepEqual(host.calls[0], ['updates.framework', { version: name, sourceDir: v }]);
    assert.equal(await exists(join(L(t).framework, name)), false, 'the Host does the copy');
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------ app
test('app prepare and apply need the Host (exit 2) and use the management methods when it runs', async () => {
  const t = await tempRoot();
  try {
    const none = io(t, { connectManagement: async () => null });
    assert.equal(await app([...rootFlags(t), 'prepare'], none), 2);
    assert.match(none.err.join(''), /Host not running/);
    const host = fakeHost({ 'updates.app.prepare': () => ({ opId: 'op-p' }), 'updates.app.apply': () => ({ opId: 'op-a' }),
      'ops.get': ({ opId }) => ({ id: opId, outcome: 'succeeded', result: { candidate: '/c/App.app' } }) });
    const i = io(t, host);
    assert.equal(await app([...rootFlags(t), 'prepare'], i), 0);
    assert.match(i.out.join(''), /candidate: \/c\/App\.app/);
    assert.equal(await app([...rootFlags(t), 'apply', '--candidate', '/c/App.app'], i), 0);
    assert.deepEqual(host.calls.filter(([m]) => m === 'updates.app.apply'), [['updates.app.apply', { candidate: '/c/App.app' }]]);
    assert.equal(await app([...rootFlags(t), 'apply'], io(t, host)), 64, 'no prepared candidate and no --candidate');
  } finally { await t.cleanup(); }
});

test('app status reads the stock build, the running copy and the candidates offline', async () => {
  const t = await tempRoot();
  try {
    const l = L(t);
    const stock = join(t.dir, 'Stock.app'); await makeApp(stock, '27.0', '2');
    const copy = join(l.apps, '26.0-1', 'ChatGPT Mods.app'); await makeApp(copy, '26.0', '1');
    const stable = join(t.dir, 'Applications', 'ChatGPT Mods.app'); await mkdir(join(t.dir, 'Applications')); await symlink(copy, stable);
    await writeJsonAtomic(l.profileConfig, { codexHome: l.codexHome, guardStockApp: false, signingIdentity: '-', appPath: stable });
    await writeTextAtomic(l.frameworkCurrent, '1.0.0');
    const i = io(t, { stockApp: stock });
    assert.equal(await app([...rootFlags(t), 'status', '--json'], i), 0);
    const s = JSON.parse(i.out.join(''));
    assert.equal(s.stockBuild, '27.0-2'); assert.equal(s.copyBuild, '26.0-1'); assert.equal(s.updateAvailable, true);
    assert.equal(s.framework.current, '1.0.0'); assert.equal(s.candidates[0].build, '26.0-1');
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------ setup
async function setupWorld(t) {
  const src = join(t.dir, 'checkout');
  await makeFrameworkTree(src, { version: '1.2.3' });
  await mkdir(join(src, 'adapters', '27.0-5'), { recursive: true });
  await writeJsonAtomic(join(src, 'adapters', '27.0-5', 'adapter.json'), baseAdapter());
  await mkdir(join(src, 'adapters', 'tools'), { recursive: true });
  const stock = join(t.dir, 'Stock.app'); await makeApp(stock, '27.0', '5');
  const builds = [];
  const runBuilder = async (args) => {
    builds.push(args);
    const out = args[args.indexOf('--out') + 1];
    await mkdir(join(out, 'ChatGPT Mods.app', 'Contents'), { recursive: true });
    await writeFile(join(out, 'build-report.json'), JSON.stringify(await fakeBuildReport(args)));
  };
  await mkdir(join(t.dir, 'home'), { recursive: true });
  return { src, stock, builds, deps: { home: join(t.dir, 'home'), stockApp: stock, frameworkSource: src, runBuilder, detectIdentity: async () => '-' } };
}

test('setup installs the framework, the profile, the adapter packs, the first copy and the stable symlink; a second run changes nothing', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    const i1 = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--identity', 'Dev ID'], i1), 0, i1.err.join(''));
    const appPath = join(t.dir, 'home', 'Applications', 'ChatGPT Mods.app');
    const copy = join(l.apps, `27.0-5-${(await readdir(l.apps)).find((n) => n.startsWith('27.0-5-')).slice(7)}`, 'ChatGPT Mods.app');
    assert.deepEqual(await readJson(l.profileConfig), { codexHome: l.codexHome, guardStockApp: false, signingIdentity: 'Dev ID', appPath, launchArgs: [`--user-data-dir=${l.userData}`] });
    const fw = await frameworkVersionOf(w.src);
    assert.match(fw, /^1\.2\.3\+[0-9a-f]{8}$/);
    assert.equal(await readText(l.frameworkCurrent), fw);
    assert.equal(await readText(l.frameworkLkg), fw);
    assert.ok(await exists(join(l.framework, fw, 'framework', 'main', 'index.cjs')));
    assert.ok(await exists(join(l.adapters, '27.0-5', 'adapter.json')));
    assert.equal(await exists(join(l.adapters, 'tools')), false);
    assert.equal(w.builds.length, 1);
    const args = w.builds[0];
    assert.equal(args[args.indexOf('--identity') + 1], 'Dev ID');
    assert.equal(args[args.indexOf('--stock') + 1], w.stock);
    assert.equal(args[args.indexOf('--adapter') + 1], join(l.adapters, '27.0-5', 'adapter.json'));
    assert.equal(args[0], join(l.framework, fw, 'builder', 'build.mjs'));
    assert.equal(args[args.indexOf('--framework-version') + 1], fw);
    assert.ok((await lstat(appPath)).isSymbolicLink());
    assert.equal(await readlink(appPath), copy);
    assert.equal(await readText(l.lkgApp), copy);
    for (const d of [l.framework, l.apps, l.flags, l.run, l.generations]) assert.equal((await lstat(d)).mode & 0o777, 0o700);

    // second run: byte-identical state, nothing rebuilt or rewritten
    const snapshot = async () => JSON.stringify([await readFile(l.profileConfig, 'utf8'), await readText(l.frameworkCurrent), await readText(l.frameworkPrevious),
      await readText(l.frameworkLkg), await readText(l.lkgApp), await readlink(appPath), (await readdir(l.framework)).sort(), (await readdir(l.apps)).sort(), (await readdir(l.adapters)).sort()]);
    const before = await snapshot();
    const i2 = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t)], i2), 0, i2.err.join(''));
    assert.equal(await snapshot(), before);
    assert.equal(w.builds.length, 1, 'the complete copy is reused');
  } finally { await t.cleanup(); }
});

test('setup --daily points codexHome at ~/.codex with the stock-app guard; --app-path is recorded; later runs preserve both', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    const custom = join(t.dir, 'Elsewhere', 'My Mods.app');
    assert.equal(await setup([...rootFlags(t), '--daily', '--app-path', custom, '--identity', 'Apple Development: Test (ABC)'], io(t, w.deps)), 0);
    const p = await readJson(l.profileConfig);
    assert.equal(p.codexHome, join(t.dir, 'home', '.codex')); assert.equal(p.guardStockApp, true); assert.equal(p.appPath, custom);
    assert.deepEqual(p.launchArgs, [], 'daily profile launches with no extra args');
    assert.equal(await exists(join(t.dir, 'home', '.codex')), false, 'setup never creates or touches ~/.codex');
    assert.equal(await setup([...rootFlags(t)], io(t, w.deps)), 0);
    assert.deepEqual(await readJson(l.profileConfig), p);
  } finally { await t.cleanup(); }
});

test('setup refuses to replace a real bundle at the stable path and reports a missing adapter pack', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const real = join(t.dir, 'home', 'Applications', 'ChatGPT Mods.app');
    await mkdir(join(real, 'Contents'), { recursive: true });
    const i = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--identity', '-'], i), 1);
    assert.match(i.err.join(''), /not a symlink/);
    assert.ok((await lstat(join(real, 'Contents'))).isDirectory());
    assert.equal(w.builds.length, 0);
    // no pack for the installed build
    await rm(real, { recursive: true });
    await makeApp(w.stock, '99.0', '9');
    const i2 = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--identity', '-'], i2), 1);
    assert.match(i2.err.join(''), /no adapter pack for the installed ChatGPT build 99\.0-9/);
    assert.equal(await readText(L(t).frameworkCurrent), await frameworkVersionOf(w.src), 'the framework part is installed even so');
  } finally { await t.cleanup(); }
});

test('setup: same content reuses the framework dir; a changed checkout with the SAME package.json version gets a new dir, current moves, previous keeps the prior current, lkg stays', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    assert.equal(await setup([...rootFlags(t), '--identity', '-'], io(t, w.deps)), 0);
    const v1 = await readText(l.frameworkCurrent);
    const mainFile = join(l.framework, v1, 'framework', 'main', 'index.cjs');
    const before = await readFile(mainFile, 'utf8');
    const dirs1 = (await readdir(l.framework)).sort();
    // unchanged checkout: the same immutable dir, nothing new
    assert.equal(await setup([...rootFlags(t)], io(t, w.deps)), 0);
    assert.equal(await readText(l.frameworkCurrent), v1);
    assert.deepEqual((await readdir(l.framework)).sort(), dirs1);
    // the checkout changes, package.json still says 1.2.3
    await writeFile(join(w.src, 'framework', 'main', 'index.cjs'), 'module.exports = { start() {}, marker: "changed" };\n');
    const i = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t)], i), 0, i.err.join(''));
    const v2 = await readText(l.frameworkCurrent);
    assert.notEqual(v2, v1);
    assert.match(v2, /^1\.2\.3\+[0-9a-f]{8}$/);
    assert.equal(await readText(l.frameworkPrevious), v1, 'previous keeps the prior current');
    assert.equal(await readText(l.frameworkLkg), v1, 'lkg is untouched until the new framework proves healthy');
    assert.equal(await readFile(mainFile, 'utf8'), before, 'the old framework dir was never modified in place');
    assert.match(await readFile(join(l.framework, v2, 'framework', 'main', 'index.cjs'), 'utf8'), /changed/);
    // going back to the old content selects the old dir again, and previous becomes the changed one
    await writeFile(join(w.src, 'framework', 'main', 'index.cjs'), before);
    assert.equal(await setup([...rootFlags(t)], io(t, w.deps)), 0);
    assert.equal(await readText(l.frameworkCurrent), v1);
    assert.equal(await readText(l.frameworkPrevious), v2);
  } finally { await t.cleanup(); }
});

test('installFrameworkTree never modifies an existing framework dir: identical reuses, different is a Conflict', async () => {
  const t = await tempRoot();
  try {
    const l = L(t);
    const a = join(t.dir, 'a'), b = join(t.dir, 'b');
    await makeFrameworkTree(a, { version: '1.0.0' }); await makeFrameworkTree(b, { version: '1.0.0', marker: 'other' });
    const { installFrameworkTree } = await import('../support.mjs');
    await installFrameworkTree(l, a, 'fixed-name');
    await installFrameworkTree(l, a, 'fixed-name');                                     // identical: reused
    await assert.rejects(installFrameworkTree(l, b, 'fixed-name'), { code: 'Conflict' });
    assert.match(await readFile(join(l.framework, 'fixed-name', 'framework', 'main', 'index.cjs'), 'utf8'), /"a"/);
  } finally { await t.cleanup(); }
});

test('setup --daily refuses an ad-hoc identity (explicit or auto-detected) and writes nothing', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    const i = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', '-'], i), 64);
    assert.match(i.err.join(''), /daily profile.*needs a real signing identity.*--identity "<name>"/);
    const j = io(t, w.deps);                                               // detectIdentity() falls back to '-'
    assert.equal(await setup([...rootFlags(t), '--daily'], j), 64);
    assert.match(j.err.join(''), /No Apple Development identity was found/);
    assert.equal(await exists(l.profileConfig), false);
    assert.equal(w.builds.length, 0);
  } finally { await t.cleanup(); }
});

test('setup --try makes a profile to try it whatever it was: its own Codex home and user data, an ad-hoc identity allowed; --daily with --try is refused', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', 'Apple Development: Test (ABC)'], io(t, w.deps)), 0);
    assert.equal(JSON.parse(await readFile(l.profileConfig, 'utf8')).codexHome.endsWith('.codex'), true);
    assert.equal(await setup([...rootFlags(t), '--identity', '-'], io(t, w.deps)), 64, 'without --try the profile stays daily, which needs a certificate');
    assert.equal(await setup([...rootFlags(t), '--try', '--identity', '-'], io(t, w.deps)), 0);
    const p = JSON.parse(await readFile(l.profileConfig, 'utf8'));
    assert.deepEqual([p.codexHome, p.guardStockApp, p.launchArgs], [l.codexHome, false, []], 'the copy\'s own user data, however it is opened');
    const both = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--daily', '--try'], both), 64);
    assert.match(both.err.join(''), /pass one/);
  } finally { await t.cleanup(); }
});

test('setup --daily passes --require-identity (only) to the builder; a QA setup does not', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', 'Apple Development: Test (ABC)'], io(t, w.deps)), 0);
    assert.ok(w.builds[0].includes('--require-identity'));
    assert.equal(w.builds[0].some((a) => a.includes('updater')), false, 'the builder suppresses the updater by default');
    const t2 = await tempRoot();
    try {
      const w2 = await setupWorld(t2);
      assert.equal(await setup([...rootFlags(t2), '--identity', '-'], io(t2, w2.deps)), 0);
      assert.equal(w2.builds[0].includes('--require-identity'), false);
    } finally { await t2.cleanup(); }
  } finally { await t.cleanup(); }
});

test('setup --daily repoints a stable symlink that points at an older candidate (atomically) and prints old -> new; QA setup keeps it and says so', async () => {
  for (const daily of [true, false]) {
    const t = await tempRoot();
    try {
      const w = await setupWorld(t);
      const l = L(t);
      const flags = [...rootFlags(t), '--identity', 'Apple Development: Test (ABC)', ...(daily ? ['--daily'] : [])];
      assert.equal(await setup(flags, io(t, w.deps)), 0);
      const appPath = join(t.dir, 'home', 'Applications', 'ChatGPT Mods.app');
      const first = await readlink(appPath);
      // the checkout changes -> new framework version -> new input hash -> a new candidate
      await writeFile(join(w.src, 'framework', 'main', 'index.cjs'), 'module.exports = { start() {}, changed: true };\n');
      const i = io(t, w.deps);
      assert.equal(await setup(flags, i), 0, i.err.join(''));
      assert.equal(w.builds.length, 2);
      const second = (await readdir(l.apps)).map((n) => join(l.apps, n, 'ChatGPT Mods.app')).find((p) => p !== first);
      assert.ok(second);
      if (daily) {
        assert.equal(await readlink(appPath), second);
        assert.match(i.out.join(''), new RegExp(`launch path repointed: ${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -> `));
        assert.deepEqual((await readdir(join(t.dir, 'home', 'Applications'))), ['ChatGPT Mods.app'], 'no temp link left');
        assert.equal(await readText(l.lkgApp), first, 'lkg-app is only moved by a healthy boot');
      } else {
        assert.equal(await readlink(appPath), first);
        assert.match(i.out.join(''), /still points at the older copy/);
      }
    } finally { await t.cleanup(); }
  }
});

// Contract test against the REAL builder parser: every argv that setup / buildCandidate can produce must be accepted by builder/build.mjs.
// The stock path is nonexistent, so a valid command line fails later (stock missing) and an unknown option fails with ERR_PARSE_ARGS_UNKNOWN_OPTION.
const REAL_BUILDER = fileURLToPath(new URL('../../../../builder/build.mjs', import.meta.url));
function realParserVerdict(args, t) {
  const argv = [REAL_BUILDER, ...args.slice(1)];
  argv[argv.indexOf('--stock') + 1] = join(t.dir, 'no-such-stock.app');
  argv[argv.indexOf('--out') + 1] = join(t.dir, 'contract-out');
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60_000 });
  return { parsed: !/ERR_PARSE_ARGS|Unknown option|unknown option/i.test(r.stderr), stderr: r.stderr };
}
test('contract: every builder argv setup can produce (daily and QA) is accepted by the real builder/build.mjs option parser', async () => {
  for (const daily of [true, false]) {
    const t = await tempRoot();
    try {
      const w = await setupWorld(t);
      const flags = [...rootFlags(t), '--identity', 'Apple Development: Test (ABC)', ...(daily ? ['--daily'] : [])];
      assert.equal(await setup(flags, io(t, w.deps)), 0);
      assert.equal(w.builds.length, 1);
      for (const args of w.builds) {
        const v = realParserVerdict(args, t);
        assert.ok(v.parsed, `builder rejected the options (${daily ? 'daily' : 'QA'}): ${v.stderr.split('\n')[0]}`);
      }
    } finally { await t.cleanup(); }
  }
  // and the harness itself detects a stale option
  const t = await tempRoot();
  try {
    const bad = realParserVerdict(['x', '--stock', 's', '--out', 'o', '--require-updater-suppression'], t);
    assert.equal(bad.parsed, false);
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------ recovery guard list|untrust (framework-main/guard-trust.cjs belongs to framework-main; faked here)
function fakeGuardTrust(initial) {
  const state = { list: [...initial], files: [] };
  return { state, listTrusted: (f) => { state.files.push(f); return [...state.list]; },
    trust: (f, fps) => { state.list.push(...fps); },
    untrust: (f, n) => { state.files.push(f); if (!Number.isInteger(n) || n < 1 || n > state.list.length) throw new RangeError('bad n'); return state.list.splice(n - 1, 1)[0]; } };
}
test('recovery guard list: empty, two entries (numbered), --json; works offline on profile.json', async () => {
  const t = await tempRoot();
  try {
    const g = fakeGuardTrust([]);
    let i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'list'], i), 0);
    assert.match(i.out.join(''), /No trusted servers\./);
    assert.equal(g.state.files[0], L(t).profileConfig, 'reads layout.profileConfig');
    g.state.list.push('/usr/local/bin/codex app-server', '/opt/x/codex --serve');
    i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'list'], i), 0);
    assert.equal(i.out.join(''), '1. /usr/local/bin/codex app-server\n2. /opt/x/codex --serve\n');
    i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'list', '--json'], i), 0);
    assert.deepEqual(JSON.parse(i.out.join('')), { trusted: ['/usr/local/bin/codex app-server', '/opt/x/codex --serve'] });
  } finally { await t.cleanup(); }
});

test('recovery guard untrust <n> removes one and prints it; a bad n is a usage error and changes nothing', async () => {
  const t = await tempRoot();
  try {
    const g = fakeGuardTrust(['fp-a', 'fp-b']);
    let i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'untrust', '1'], i), 0);
    assert.match(i.out.join(''), /Removed trusted server 1: fp-a/);
    assert.deepEqual(g.state.list, ['fp-b']);
    for (const bad of ['0', '2', '-1', 'x', '1.5']) {
      i = io(t, { guardTrust: g });
      assert.equal(await recovery([...rootFlags(t), 'guard', 'untrust', bad], i), 64, bad);
      assert.match(i.err.join(''), /Invalid:/, bad);
    }
    assert.deepEqual(g.state.list, ['fp-b']);
    i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'untrust'], i), 64);
    assert.match(i.err.join(''), /usage: codexmods recovery guard list \| guard untrust <n>/);
    i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t), 'guard', 'bogus'], i), 64);
    i = io(t, { guardTrust: g });
    assert.equal(await recovery([...rootFlags(t)], i), 64);
    assert.match(i.err.join(''), /guard list \| guard untrust <n>/);
  } finally { await t.cleanup(); }
});

test('setup preserves guardTrusted and unknown profile.json keys across re-runs while its own fields still update', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    assert.equal(await setup([...rootFlags(t), '--identity', 'Apple Development: One (ABCDE12345)'], io(t, w.deps)), 0);
    const base = await readJson(l.profileConfig);
    const extra = { guardTrusted: ['/usr/local/bin/codex app-server --listen', '/opt/other/codex serve'], futureKey: { nested: [1, 2, 3] }, another: 'x' };
    await writeJsonAtomic(l.profileConfig, { ...base, ...extra });
    // run twice, once changing one of setup's own fields
    assert.equal(await setup([...rootFlags(t), '--identity', 'Apple Development: Two (ABCDE12345)'], io(t, w.deps)), 0);
    let p = await readJson(l.profileConfig);
    assert.equal(p.signingIdentity, 'Apple Development: Two (ABCDE12345)', 'setup\'s own field updated');
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(p[k], v, k);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', 'Apple Development: Two (ABCDE12345)'], io(t, w.deps)), 0);
    p = await readJson(l.profileConfig);
    assert.equal(p.guardStockApp, true); assert.equal(p.codexHome, join(t.dir, 'home', '.codex'));
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(p[k], v, `${k} after --daily`);
    // an unchanged re-run does not even rewrite the file
    const before = await readFile(l.profileConfig, 'utf8');
    assert.equal(await setup([...rootFlags(t)], io(t, w.deps)), 0);
    assert.equal(await readFile(l.profileConfig, 'utf8'), before);
  } finally { await t.cleanup(); }
});

test('an adapter-only change builds a new candidate and reports the trigger; no change is a no-op', async () => {
  for (const daily of [true, false]) {
    const t = await tempRoot();
    try {
      const w = await setupWorld(t);
      const l = L(t);
      const flags = [...rootFlags(t), '--identity', 'Apple Development: Test (ABCDE12345)', ...(daily ? ['--daily'] : [])];
      const appPath = join(t.dir, 'home', 'Applications', 'ChatGPT Mods.app');
      let i = io(t, w.deps);
      assert.equal(await setup(flags, i), 0);
      const first = await readlink(appPath);
      // no change: nothing builds, nothing moves
      i = io(t, w.deps);
      assert.equal(await setup(flags, i), 0);
      assert.equal(w.builds.length, 1);
      assert.match(i.out.join(''), /already built/);
      // only the adapter pack changes (a new transform); the framework content is identical
      const packPath = join(w.src, 'adapters', '27.0-5', 'adapter.json');
      const pack = JSON.parse(await readFile(packPath, 'utf8'));
      await writeJsonAtomic(packPath, { ...pack, transforms: [{ id: 'cua-helper-private-home', seam: 'other', file: 'x.js', sha256Before: 'a', sha256After: 'b', op: 'replace-once', find: 'a', text: 'b' }] });
      i = io(t, w.deps);
      assert.equal(await setup(flags, i), 0, i.err.join(''));
      assert.equal(w.builds.length, 2, 'a new candidate was built');
      assert.match(i.out.join(''), /rebuilt because: adapter\.json changed/);
      const second = (await readdir(l.apps)).map((n) => join(l.apps, n, 'ChatGPT Mods.app')).find((p) => p !== first);
      assert.ok(second);
      assert.equal(await readlink(appPath), daily ? second : first);
      // and the root adapter that the build used is the new one
      assert.equal(JSON.parse(await readFile(join(l.adapters, '27.0-5', 'adapter.json'), 'utf8')).transforms[0].id, 'cua-helper-private-home');
    } finally { await t.cleanup(); }
  }
});

test('each build input is a trigger on its own: framework version, loader, relay, identity, stock build', async () => {
  const cases = [
    ['framework version', async (w) => writeFile(join(w.src, 'framework', 'main', 'index.cjs'), 'module.exports = { start() {}, v: 2 };\n'), []],
    ['loader', async (w) => writeFile(join(w.src, 'loader', 'loader.cjs'), '// loader v2\n'), []],
    ['relay', async (w) => writeFile(join(w.src, 'relay', 'relay'), '#!/bin/sh\n# v2\n'), []],
    ['signing identity', async () => {}, ['--identity', 'Apple Development: Other (ZZZZZ99999)']],
  ];
  for (const [name, change, extra] of cases) {
    const t = await tempRoot();
    try {
      const w = await setupWorld(t);
      const base = [...rootFlags(t), '--identity', 'Apple Development: Test (ABCDE12345)'];
      assert.equal(await setup(base, io(t, w.deps)), 0);
      await change(w);
      const i = io(t, w.deps);
      assert.equal(await setup(extra.length ? [...rootFlags(t), ...extra] : base, i), 0, i.err.join(''));
      assert.equal(w.builds.length, 2, name);
      const out = i.out.join('');
      assert.ok(out.includes(`rebuilt because: ${name} changed`) || (name !== 'framework version' && out.includes(`${name} changed`)), `${name}: ${out}`);
    } finally { await t.cleanup(); }
  }
});

test('a candidate directory whose build-report records different inputs than its name claims is rebuilt, not reused', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    const l = L(t);
    const flags = [...rootFlags(t), '--identity', 'Apple Development: Test (ABCDE12345)'];
    assert.equal(await setup(flags, io(t, w.deps)), 0);
    const dir = (await readdir(l.apps))[0];
    const rp = join(l.apps, dir, 'build-report.json');
    const r = JSON.parse(await readFile(rp, 'utf8'));
    await writeFile(rp, JSON.stringify({ ...r, inputs: { ...r.inputs, adapter: { sha256: 'stale' } } }));
    const i = io(t, w.deps);
    assert.equal(await setup(flags, i), 0, i.err.join(''));
    assert.equal(w.builds.length, 2, 'rebuilt over the stale directory');
    assert.match(i.out.join(''), /rebuilt because: adapter\.json changed/);
  } finally { await t.cleanup(); }
});

test('D22: setup --qa-no-restore reaches only an isolated builder and is refused for a daily profile', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    assert.equal(await setup([...rootFlags(t), '--identity', '-', '--qa-no-restore'], io(t, w.deps)), 0);
    assert.ok(w.builds[0].includes('--qa-no-restore'));
    const previous = await readFile(L(t).profileConfig, 'utf8');
    const i = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', 'Apple Development: Test (ABC)', '--qa-no-restore'], i), 64);
    assert.match(i.err.join(''), /restricted to isolated QA profiles/);
    assert.equal(await readFile(L(t).profileConfig, 'utf8'), previous);
    assert.equal(w.builds.length, 1);
  } finally { await t.cleanup(); }
});

test('N8: setup --qa-socket-dirs reaches only an isolated builder and is refused for a daily profile', async () => {
  const t = await tempRoot();
  try {
    const w = await setupWorld(t);
    assert.equal(await setup([...rootFlags(t), '--identity', '-', '--qa-no-restore', '--qa-socket-dirs'], io(t, w.deps)), 0);
    assert.ok(w.builds[0].includes('--qa-socket-dirs') && w.builds[0].includes('--qa-no-restore'));
    const previous = await readFile(L(t).profileConfig, 'utf8');
    const i = io(t, w.deps);
    assert.equal(await setup([...rootFlags(t), '--daily', '--identity', 'Apple Development: Test (ABC)', '--qa-socket-dirs'], i), 64);
    assert.match(i.err.join(''), /--qa-socket-dirs is restricted to isolated QA profiles/);
    assert.equal(await readFile(L(t).profileConfig, 'utf8'), previous);
    assert.equal(w.builds.length, 1);
  } finally { await t.cleanup(); }
});
