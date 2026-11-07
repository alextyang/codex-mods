import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCopy } from '../build.mjs';
import { AsarArchive } from '../asar.mjs';
import { applyQaSocketDirs, qaSocketDir, qaSocketDirExpression, QA_SOCKET_DIRS, QA_SOCKET_SCAN } from '../qa-socket-dirs.mjs';
import { makeStockApp, makeBuildInputs, tmpdir, readPlist } from './helpers.mjs';

// The shapes 26.1013.40934-20770 ships: the app-tools directory inline at the listen call, the browser-use one from a helper.
const MAIN_CHUNK = '.vite/build/main-x.js';
const CHUNK = 'module.exports={appTools:()=>process.platform===`win32`?`\\\\\\\\.\\\\pipe\\\\codex-app-tools`:`/tmp/codex-app-tools`,'
  + 'browserUse:(e=process.platform)=>e===`win32`?`\\\\\\\\.\\\\pipe\\\\codex-browser-use`:`/tmp/codex-browser-use`};\n';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const files = (o) => new Map(Object.entries(o).map(([p, s]) => [p, Buffer.from(s)]));

function buildOpts(t, asarFiles = { [MAIN_CHUNK]: CHUNK }) {
  const dir = tmpdir(t);
  const stock = makeStockApp(dir, { asarFiles });
  const inputs = makeBuildInputs(dir);
  return { dir, opts: { stock: stock.app, adapter: inputs.adapterPath, loader: inputs.loader, relay: inputs.relay, root: '/Users/qa/cmq', identity: '-', allowNoBaseline: true,
    sign: async () => ({ signed: 1, verified: true, targets: [] }), dumpSignedEntitlements: async () => [], readTeamIdentifier: async () => null, findCertificateSubject: () => null } };
}

/** Load an edited chunk as main would (CommonJS, real require) with the given profile. */
async function loadChunk(dir, src, profile) {
  const file = path.join(dir, `chunk-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(file, src);
  const m = await import(file);
  const saved = process.env.CODEX_MODS_PROFILE;
  if (profile == null) delete process.env.CODEX_MODS_PROFILE; else process.env.CODEX_MODS_PROFILE = profile;
  try { return { appTools: m.default.appTools(), browserUse: m.default.browserUse() }; } finally {
    if (saved == null) delete process.env.CODEX_MODS_PROFILE; else process.env.CODEX_MODS_PROFILE = saved;
  }
}

test('N8: a QA build moves both /tmp socket directories under the profile run directory; an ordinary build keeps them', async (t) => {
  const { dir, opts } = buildOpts(t);
  const qa = await buildCopy({ ...opts, out: path.join(dir, 'qa'), qaSocketDirs: true });
  const edited = AsarArchive.open(path.join(qa.appPath, 'Contents/Resources/app.asar')).read(MAIN_CHUNK).toString('utf8');
  for (const d of QA_SOCKET_DIRS) assert.ok(!edited.includes(d.literal), `${d.literal} is gone`);
  assert.ok(edited.includes('codex-app-tools`:(('), 'the win32 branch is kept');
  assert.equal(qa.report.qaSocketDirs.applied, true);
  assert.deepEqual(qa.report.qaSocketDirs.sites.map((s) => [s.id, s.file]), [['app-tools', MAIN_CHUNK], ['browser-use', MAIN_CHUNK]]);
  const at = await loadChunk(dir, edited, 'p1');
  assert.deepEqual(at, { appTools: '/Users/qa/cmq/profiles/p1/run/app-tools', browserUse: '/Users/qa/cmq/profiles/p1/run/browser-use' });
  assert.equal((await loadChunk(dir, edited, null)).appTools, '/Users/qa/cmq/profiles/default/run/app-tools');
  process.env.CODEX_MODS_ROOT = '/Users/qa/other';
  try { assert.equal((await loadChunk(dir, edited, 'p2')).browserUse, '/Users/qa/other/profiles/p2/run/browser-use', 'CODEX_MODS_ROOT wins, as in the loader'); } finally { delete process.env.CODEX_MODS_ROOT; }

  const ordinary = await buildCopy({ ...opts, out: path.join(dir, 'ordinary') });
  assert.equal(AsarArchive.open(path.join(ordinary.appPath, 'Contents/Resources/app.asar')).read(MAIN_CHUNK).toString('utf8'), CHUNK);
  assert.deepEqual(ordinary.report.qaSocketDirs, { applied: false });
});

test('N8: a QA build refuses a stock bundle whose anchors are missing', async (t) => {
  const { dir, opts } = buildOpts(t, { [MAIN_CHUNK]: CHUNK.replace('`/tmp/codex-browser-use`', '`/tmp/codex-browser-`+`use`') });
  await assert.rejects(buildCopy({ ...opts, out: path.join(dir, 'qa'), qaSocketDirs: true }), (e) => e.code === 'QA_SOCKET_ANCHOR' && /codex-browser-use/.test(e.message));
  assert.equal((await buildCopy({ ...opts, out: path.join(dir, 'ordinary') })).report.qaSocketDirs.applied, false, 'ordinary builds never look');
});

test('N8: each literal must occur exactly once, as a whole string literal (template or quoted), across all scanned files', () => {
  const good = 'a=`/tmp/codex-app-tools`;b=`/tmp/codex-browser-use`;';
  assert.equal(applyQaSocketDirs(files({ 'x.js': good }), '/r').report.sites.length, 2);
  // 22943's minifier writes quoted strings: the same literal, replaced the same way
  const quoted = applyQaSocketDirs(files({ 'x.js': 'a="/tmp/codex-app-tools";b=`/tmp/codex-browser-use`;' }), '/r');
  assert.equal(quoted.report.sites.length, 2);
  assert.ok(!quoted.edits.get('x.js').toString().includes('/tmp/codex-app-tools'), 'the quoted literal is replaced whole');
  const refused = {
    missing: { 'x.js': 'a=`/tmp/codex-app-tools`;' },
    repeated: { 'x.js': good + 'c=`/tmp/codex-app-tools`;' },
    'repeated in another file': { 'x.js': good, 'y.js': 'd=`/tmp/codex-browser-use`;' },
    'another quoting': { 'x.js': good, 'y.js': "d='/tmp/codex-app-tools/x';" },
  };
  for (const [name, f] of Object.entries(refused)) assert.throws(() => applyQaSocketDirs(files(f), '/r'), (e) => e.code === 'QA_SOCKET_ANCHOR', name);
  assert.ok(QA_SOCKET_SCAN.test('.vite/build/main-CLu1A25j.js') && QA_SOCKET_SCAN.test('.vite/build/worker.js'));
  assert.ok(!QA_SOCKET_SCAN.test('webview/assets/index.js'));
});

test('N8: socket paths stay within sun_path; a long profile uses a short directory in $TMPDIR', () => {
  const at = (root, tmp) => qaSocketDir({ root, profile: 'default', name: 'browser-use', short: 'b', tmpdir: tmp, path, hash });
  const macTmp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T'; // the usual length of a macOS $TMPDIR
  assert.equal(at('/Users/qauser/cmq', macTmp), '/Users/qauser/cmq/profiles/default/run/browser-use');
  const longRoot = `/Users/qauser/${'x'.repeat(40)}`;
  const fallback = at(longRoot, macTmp);
  assert.equal(fallback, `${macTmp}/cm${hash(path.join(longRoot, 'profiles', 'default')).slice(0, 6)}/b`);
  assert.ok(Buffer.byteLength(`${fallback}/${'0'.repeat(36)}.sock`) <= 103);
  assert.throws(() => at(longRoot, `/var/${'t'.repeat(60)}`), /no browser-use socket directory fits sun_path/);
  // the boundary: a primary directory that leaves exactly 103 bytes for the socket path is kept
  const edge = `/${'r'.repeat(103 - 42 - '/profiles/default/run/browser-use'.length - 1)}`;
  assert.equal(Buffer.byteLength(`${at(edge, macTmp)}/${'0'.repeat(36)}.sock`), 103);
  assert.ok(at(edge, macTmp).startsWith(edge));
  assert.ok(at(`${edge}r`, macTmp).startsWith(macTmp));
  assert.match(qaSocketDirExpression('/r', QA_SOCKET_DIRS[0]), /^\(\(.*\)\)$/s);
});

// Read-only check against the installed stock app when it is a build this edit was made for (the main-process scripts that hold the app-tools and
// the browser-use socket directories, by build: one bundle up to 21477; 22943's chunks hold one each).
const STOCK = '/Applications/ChatGPT.app';
const MAIN_OF = { 20770: ['main-CLu1A25j.js', 'main-CLu1A25j.js'], 21477: ['main-JI9qDiXp.js', 'main-JI9qDiXp.js'],
  22943: ['early-bootstrap-916-2f6483d5bfd826f1.js', 'early-bootstrap-339-aea964a206c655e4.js'] };
const stockBuild = () => { try { return readPlist(path.join(STOCK, 'Contents/Info.plist')).CFBundleVersion; } catch { return null; } };
test(`N8: the anchors match the installed ${stockBuild()} stock bundle exactly once (read-only)`, { skip: !(stockBuild() in MAIN_OF) && 'the installed stock app is not 20770, 21477 or 22943' }, () => {
  const asar = AsarArchive.open(path.join(STOCK, 'Contents/Resources/app.asar'));
  const scan = new Map(asar.list().filter((p) => QA_SOCKET_SCAN.test(p)).map((p) => [p, asar.read(p)]));
  const r = applyQaSocketDirs(scan, os.homedir());
  const [tools, browser] = MAIN_OF[stockBuild()].map((f) => `.vite/build/${f}`);
  assert.deepEqual(r.report.sites.map((s) => [s.id, s.file]), [['app-tools', tools], ['browser-use', browser]]);
});
