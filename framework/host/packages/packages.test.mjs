import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, stat, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { layout } from '../../../contracts/layout.mjs';
import { createTestLog } from '../../../tests/fixtures/log.mjs';
import { createPackages } from './index.mjs';
import { keygen, packMod } from './pack.mjs';
import { readZip, writeZip } from '../../shared/zip.mjs';
import { validateManifest } from './manifest.mjs';
import { tempRoot, baseManifest, buildSigned, writeModDir } from './testkit.mjs';
import { satisfies, parseRange, parseVersion, compareVersions } from './semver.mjs';
import { contentHashOf } from './hash.mjs';

async function setup(frameworkVersion = '1.0.0') {
  const t = await tempRoot();
  const L = layout(t.root);
  const packages = createPackages({ layout: L, log: createTestLog(), frameworkVersion });
  return { ...t, L, packages };
}
const rejects = (p, code, re) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });
const throwsCode = (fn, code, re) => { try { fn(); } catch (e) { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return; } assert.fail('did not throw'); };

test('keygen returns a base64 raw 32-byte key and a PEM', () => {
  const k = keygen();
  assert.equal(Buffer.from(k.publicKey, 'base64').length, 32);
  assert.match(k.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.notEqual(k.publicKey, keygen().publicKey);
});

test('packMod sets publisher from the key, computes contentHash, signs; verify accepts it', async () => {
  const ctx = await setup(); const key = keygen();
  try {
    const dir = await writeModDir(ctx.root, baseManifest(), { 'extra/data.txt': 'hi' });
    const out = join(ctx.root, 'a.codexmod');
    const r = await packMod(dir, key.privateKeyPem, out);
    assert.equal(r.publisher, key.publicKey);
    const entries = readZip(await readFile(out));
    const mod = JSON.parse(entries.find((e) => e.path === 'mod.json').data.toString());
    assert.equal(mod.publisher, key.publicKey);
    const sig = JSON.parse(entries.find((e) => e.path === 'signature.json').data.toString());
    assert.equal(sig.contentHash, contentHashOf(entries.filter((e) => !e.directory)));
    assert.equal(sig.contentHash, r.contentHash);
    const pkg = await ctx.packages.verify(out);
    assert.equal(pkg.publisher, key.publicKey);
    assert.equal(pkg.contentHash, r.contentHash);
    assert.equal(pkg.manifest.id, 'test.alpha');
    assert.ok(pkg.dir.startsWith(join(ctx.L.store, '.staging')));
    assert.equal(await readFile(join(pkg.dir, 'extra', 'data.txt'), 'utf8'), 'hi');
  } finally { await ctx.cleanup(); }
});

test('contentHash follows the spec: sorted "path\\0sha256\\n" lines, signature.json excluded', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const files = [{ path: 'b', data: Buffer.from('2') }, { path: 'a/z', data: Buffer.from('1') }, { path: 'signature.json', data: Buffer.from('ignored') }];
  const expected = createHash('sha256').update(`a/z\0${sha('1')}\nb\0${sha('2')}\n`).digest('hex');
  assert.equal(contentHashOf(files), expected);
});

test('packMod refuses a mismatching publisher, bad manifests and missing referenced files', async () => {
  const ctx = await setup(); const key = keygen(); const other = keygen();
  try {
    const out = join(ctx.root, 'x.codexmod');
    await assert.rejects(packMod(await writeModDir(ctx.root, baseManifest({ publisher: other.publicKey })), key.privateKeyPem, out), /publisher/);
    await rejects(packMod(await writeModDir(ctx.root, baseManifest({ version: 'one' })), key.privateKeyPem, out), 'Invalid', /^version:/);
    await rejects(packMod(await writeModDir(ctx.root, baseManifest(), { 'host.js': null }), key.privateKeyPem, out), 'Invalid', /^entry\.host: file not found in package/);
    // matching explicit publisher is fine and keeps mod.json bytes
    await packMod(await writeModDir(ctx.root, baseManifest({ publisher: key.publicKey })), key.privateKeyPem, out);
  } finally { await ctx.cleanup(); }
});

test('verify: tampered content, wrong signer, unsigned and stripped signature are Denied', async () => {
  const ctx = await setup(); const key = keygen(); const evil = keygen();
  try {
    const { archive } = await buildSigned(ctx.root, baseManifest(), key);
    const entries = readZip(await readFile(archive)).filter((e) => !e.directory);
    const rebuild = async (name, mutate) => {
      const copy = entries.map((e) => ({ ...e, data: Buffer.from(e.data) }));
      const out = join(ctx.root, name);
      await writeFile(out, writeZip(mutate(copy).map((e) => ({ path: e.path, data: e.data, mode: e.mode }))));
      return out;
    };
    // content changed
    const tampered = await rebuild('t.codexmod', (es) => { es.find((e) => e.path === 'host.js').data = Buffer.from('evil();'); return es; });
    await rejects(ctx.packages.verify(tampered), 'Denied', /content hash/);
    // file added
    const added = await rebuild('add.codexmod', (es) => [...es, { path: 'extra.js', data: Buffer.from('x'), mode: 0o644 }]);
    await rejects(ctx.packages.verify(added), 'Denied');
    // signed by another key but claims the publisher
    const sigBad = await rebuild('s.codexmod', (es) => {
      const mod = es.find((e) => e.path === 'mod.json');
      const m = JSON.parse(mod.data); m.publisher = evil.publicKey; mod.data = Buffer.from(JSON.stringify(m));
      return es;
    });
    await rejects(ctx.packages.verify(sigBad), 'Denied');
    // signature stripped
    const stripped = await rebuild('st.codexmod', (es) => es.filter((e) => e.path !== 'signature.json'));
    await rejects(ctx.packages.verify(stripped), 'Denied');
    // no publisher at all
    const unsigned = join(ctx.root, 'u.codexmod');
    await writeFile(unsigned, writeZip([{ path: 'mod.json', data: JSON.stringify(baseManifest()) }, { path: 'host.js', data: 'x' }]));
    await rejects(ctx.packages.verify(unsigned), 'Denied');
    // nothing left in staging after failures
    assert.deepEqual(await readdir(join(ctx.L.store, '.staging')).catch(() => []), []);
  } finally { await ctx.cleanup(); }
});

test('verify: referenced files, framework range and directory misuse', async () => {
  const ctx = await setup('2.3.0'); const key = keygen();
  try {
    const m = baseManifest({ framework: '>=2 <3', entry: { host: 'host.js', renderer: 'ui/r.js' }, data: { schemaVersion: 1, migrate: 'migrate.js' }, processes: { p: { command: 'bin/p', start: 'on-demand' } } });
    // build an archive by hand so the missing files are signed in
    const dir = await writeModDir(ctx.root, m, { 'ui/r.js': 'x', 'migrate.js': 'x', 'bin/p': 'x' });
    await rm(join(dir, 'ui', 'r.js'));
    const out = join(ctx.root, 'm.codexmod');
    await assert.rejects(packMod(dir, key.privateKeyPem, out), /entry\.renderer: file not found in package/);
    const ok = await buildSigned(ctx.root, m, key, { 'ui/r.js': 'x', 'migrate.js': 'x', 'bin/p': 'x' });
    const pkg = await ctx.packages.verify(ok.archive);
    assert.equal(((await stat(join(pkg.dir, 'bin', 'p'))).mode & 0o111) !== 0, true, 'executable bit kept');
    const old = await setup('1.0.0');
    try { await rejects(old.packages.verify(ok.archive), 'Incompatible', /framework: requires >=2 <3/); } finally { await old.cleanup(); }
    await rejects(ctx.packages.verify(ok.dir), 'Invalid');            // directory without dev
    await rejects(ctx.packages.verify(ok.archive, { dev: true }), 'Invalid'); // archive in dev mode
    await rejects(ctx.packages.verify(join(ctx.root, 'nope.codexmod')), 'Invalid');
  } finally { await ctx.cleanup(); }
});

test('verify dev: reads the directory in place with publisher null', async () => {
  const ctx = await setup();
  try {
    const dir = await writeModDir(ctx.root, baseManifest());
    const pkg = await ctx.packages.verify(dir, { dev: true });
    assert.equal(pkg.publisher, null);
    assert.equal(pkg.dir, dir);
    assert.match(pkg.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(await ctx.packages.store(pkg), dir);
    assert.deepEqual(await readdir(ctx.L.store).catch(() => []), []);
    await symlink('/etc/hosts', join(dir, 'link'));
    await rejects(ctx.packages.verify(dir, { dev: true }), 'Invalid', /symbolic link/);
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, baseManifest(), { 'host.js': null }), { dev: true }), 'Invalid', /^entry\.host: file not found in package/);
  } finally { await ctx.cleanup(); }
});

test('store is idempotent for the same content and Conflicts for different content', async () => {
  const ctx = await setup(); const key = keygen();
  try {
    const a = await buildSigned(ctx.root, baseManifest(), key);
    const p1 = await ctx.packages.verify(a.archive);
    const dest = await ctx.packages.store(p1);
    assert.equal(dest, join(ctx.L.store, 'test.alpha', '1.0.0'));
    assert.equal(await stat(p1.dir).then(() => true, () => false), false, 'staging moved');
    const p2 = await ctx.packages.verify(a.archive);
    assert.equal(await ctx.packages.store(p2), dest);
    assert.equal(await stat(p2.dir).then(() => true, () => false), false, 'duplicate staging removed');
    const b = await buildSigned(ctx.root, baseManifest(), key, { 'host.js': 'export default {changed:true};' });
    const p3 = await ctx.packages.verify(b.archive);
    await rejects(ctx.packages.store(p3), 'Conflict');
    await rejects(ctx.packages.store({ ...p3, dir: ctx.root }), 'Invalid');
  } finally { await ctx.cleanup(); }
});

test('gc removes versions not kept and empty mod dirs', async () => {
  const ctx = await setup(); const key = keygen();
  try {
    for (const [id, v] of [['test.alpha', '1.0.0'], ['test.alpha', '1.1.0'], ['test.beta', '2.0.0']]) {
      const b = await buildSigned(ctx.root, baseManifest({ id, version: v }), key);
      await ctx.packages.store(await ctx.packages.verify(b.archive));
    }
    await ctx.packages.gc((id) => (id === 'test.alpha' ? ['1.1.0'] : []));
    assert.deepEqual(await readdir(join(ctx.L.store, 'test.alpha')), ['1.1.0']);
    assert.equal(await stat(join(ctx.L.store, 'test.beta')).then(() => true, () => false), false);
  } finally { await ctx.cleanup(); }
});

// ------------------------------------------------------------------ validateManifest
test('validateManifest accepts a full manifest and returns a copy', async () => {
  const { packages } = await setup();
  const m = baseManifest({
    description: 'd', publisher: keygen().publicKey, permissions: ['appServer.observe', 'appServer.intercept:thread/compact/start,x/y', 'ui', 'secrets', 'graph', 'graph.read:Draft,Thread', 'graph.act:Thread.rename', 'graph.intercept'],
    requires: { methods: ['a/b'], components: ['Button'] }, optional: { components: ['Icon'] },
    settings: [{ key: 'p', kind: 'text', title: 'P', default: 'x' }], data: { schemaVersion: 2, migrate: 'm.js' },
    processes: { bridge: { command: 'bin/bridge', args: ['-v'], start: 'with-mod', idleStopMs: 5000 } },
    automatic: [{ id: 'continue', operation: 'Thread.send', why: 'Keeps going', perHour: 30, where: { status: 'idle' }, args: { 1: { sticky: { $exists: false } } } }],
  });
  const out = packages.validateManifest(m);
  assert.deepEqual(out, m);
  assert.notEqual(out, m);
});

test('validateManifest gives path-precise Invalid messages', async () => {
  const { packages } = await setup();
  const cases = [
    [{ id: 'ab' }, /^id:/], [{ id: 'Bad.Id' }, /^id:/], [{ id: 'x'.repeat(129) }, /^id:/], [{ id: '.hidden' }, /^id:/],
    [{ version: '1.0' }, /^version:/], [{ version: '01.0.0' }, /^version:/], [{ name: '' }, /^name:/], [{ description: 5 }, /^description:/],
    [{ publisher: 'abc' }, /^publisher:/], [{ framework: 'latest' }, /^framework:/], [{ framework: '>=1 ||' }, /^framework:/],
    [{ entry: {} }, /^entry:/], [{ entry: { host: '../x.js' } }, /^entry\.host:/], [{ entry: { host: '/abs.js' } }, /^entry\.host:/], [{ entry: { renderer: 'a\\b' } }, /^entry\.renderer:/],
    [{ permissions: ['root'] }, /^permissions\[0\]:/], [{ permissions: ['ui', 'ui'] }, /^permissions\[1\]:.*duplicate/], [{ permissions: ['appServer.observe:'] }, /^permissions\[0\]:/], [{ permissions: ['graph.read:Thread, Draft'] }, /^permissions\[0\]:/], [{ permissions: ['graph.write'] }, /^permissions\[0\]:/],
    [{ optional: { components: ['Nope'] } }, /^optional\.components\[0\]:/], [{ requires: { anchors: ['composer'] } }, /^requires\.anchors:/], [{ optional: { actions: ['x'] } }, /^optional\.actions:/], [{ requires: { methods: [1] } }, /^requires\.methods\[0\]:/],
    [{ settings: { type: 'object', properties: {} } }, /^settings: must be a list/], [{ settings: [{ key: 'a', kind: 'text', title: 'A', default: 3 }] }, /^settings\[0\]\.default:/],
    [{ settings: [{ key: 'a', kind: 'toggle', title: 'A', default: true, needs: 'network' }] }, /^settings\[0\]\.needs:/],
    [{ data: { schemaVersion: -1 } }, /^data\.schemaVersion:/], [{ data: { schemaVersion: 1, migrate: '../m.js' } }, /^data\.migrate:/],
    [{ processes: { p: { command: 'x', start: 'sometimes' } } }, /^processes\.p\.start:/], [{ processes: { p: { command: '/bin/sh', start: 'on-demand' } } }, /^processes\.p\.command:/],
    // public-hooks.md §3.9: automatic actions
    [{ automatic: {} }, /^automatic:/], [{ automatic: [{ id: 'Bad', operation: 'Thread.send', why: 'w', perHour: 1 }] }, /^automatic\[0\]\.id:/],
    [{ automatic: [{ id: 'a', operation: 'send', why: 'w', perHour: 1 }] }, /^automatic\[0\]\.operation:/],
    [{ automatic: [{ id: 'a', operation: 'ExternalApp.setComputerUse', why: 'w', perHour: 1 }] }, /^automatic\[0\]\.operation:.*always asks/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: '', perHour: 1 }] }, /^automatic\[0\]\.why:/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w' }] }, /^automatic\[0\]\.perHour:/], [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w', perHour: 3601 }] }, /^automatic\[0\]\.perHour:/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w', perHour: 1, where: { status: { $bogus: 1 } } }] }, /^automatic\[0\]\.where:/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w', perHour: 1, args: { first: {} } }] }, /^automatic\[0\]\.args:/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w', perHour: 1, always: true }] }, /^automatic\[0\]\.always:/],
    [{ automatic: [{ id: 'a', operation: 'Thread.send', why: 'w', perHour: 1 }, { id: 'a', operation: 'Thread.stop', why: 'w', perHour: 1 }] }, /^automatic\[1\]\.id:.*duplicate/],
  ];
  for (const [over, re] of cases) throwsCode(() => packages.validateManifest(baseManifest(over)), 'Invalid', re);
  throwsCode(() => packages.validateManifest(null), 'Invalid');
  throwsCode(() => packages.validateManifest(baseManifest({ entry: undefined })), 'Invalid', /^entry:/);
});

test('framework ranges: >=, <, ^, ~, exact, partial', () => {
  const ok = (v, r) => assert.equal(satisfies(v, r), true, `${v} ${r}`);
  const no = (v, r) => assert.equal(satisfies(v, r), false, `${v} ${r}`);
  ok('1.0.0', '>=1 <2'); ok('1.9.9', '>=1 <2'); no('2.0.0', '>=1 <2'); no('0.9.0', '>=1 <2');
  ok('1.4.0', '^1.2.3'); no('2.0.0', '^1.2.3'); no('1.2.2', '^1.2.3'); ok('0.2.5', '^0.2.3'); no('0.3.0', '^0.2.3');
  ok('1.2.9', '~1.2.3'); no('1.3.0', '~1.2.3'); ok('1.2.3', '1.2.3'); no('1.2.4', '1.2.3'); ok('1.5.0', '1');
  ok('1.0.0-rc.1', '>=1 <2'); ok('1.5.0', '<=1'); no('2.0.0', '<=1'); ok('2.0.0', '>1');
  assert.equal(parseRange('>=1 <'), null);
});

// ------------------------------------------------------------------ F9: precise filesystem errors
test('dev verify: paths with spaces and symlinked directories work', async () => {
  const ctx = await setup();
  try {
    const dir = await writeModDir(join(ctx.root, 'Portable Drive', 'My Mods'), baseManifest());
    const pkg = await ctx.packages.verify(dir, { dev: true });
    assert.equal(pkg.manifest.id, 'test.alpha');
    const link = join(ctx.root, 'link to mod');
    await symlink(dir, link);
    const viaLink = await ctx.packages.verify(link, { dev: true });
    assert.equal(viaLink.dir, link);
    assert.equal(viaLink.contentHash, pkg.contentHash);
    await symlink(join(ctx.root, 'nowhere'), join(ctx.root, 'dangling'));
    await rejects(ctx.packages.verify(join(ctx.root, 'dangling'), { dev: true }), 'Invalid', /does not exist/);
  } finally { await ctx.cleanup(); }
});

test('dev verify: a missing mod.json is Invalid naming the directory; an unreadable path is Unavailable naming path and errno', async () => {
  const ctx = await setup();
  const restore = [];
  try {
    const empty = join(ctx.root, 'empty dir');
    await mkdir(empty);
    await rejects(ctx.packages.verify(empty, { dev: true }), 'Invalid', new RegExp(`^mod\\.json missing in ${empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await rejects(ctx.packages.verify(join(ctx.root, 'absent'), { dev: true }), 'Invalid', /does not exist/);
    const file = join(ctx.root, 'plain.txt');
    await writeFile(file, 'x');
    await rejects(ctx.packages.verify(file, { dev: true }), 'Invalid', /is not a directory/);

    // the directory itself is unreadable (cannot even look inside): the Host-in-a-sandbox / removable-volume case
    const locked = await writeModDir(ctx.root, baseManifest());
    await chmod(locked, 0o000); restore.push(() => chmod(locked, 0o700));
    await assert.rejects(ctx.packages.verify(locked, { dev: true }), (e) => {
      assert.equal(e.code, 'Unavailable');
      assert.match(e.message, /^cannot read .*mod\.json: EACCES$/);
      assert.equal(e.details.errno, 'EACCES');
      assert.doesNotMatch(e.message, /not found/);
      return true;
    });
    await chmod(locked, 0o700);

    // mod.json readable, a subdirectory is not
    const sub = await writeModDir(ctx.root, baseManifest(), { 'assets/a.txt': 'a' });
    await chmod(join(sub, 'assets'), 0o000); restore.push(() => chmod(join(sub, 'assets'), 0o700));
    await assert.rejects(ctx.packages.verify(sub, { dev: true }), (e) => e.code === 'Unavailable' && /cannot read .*assets: EACCES/.test(e.message));

    // mod.json itself unreadable
    const noRead = await writeModDir(ctx.root, baseManifest());
    await chmod(join(noRead, 'mod.json'), 0o000); restore.push(() => chmod(join(noRead, 'mod.json'), 0o600));
    await assert.rejects(ctx.packages.verify(noRead, { dev: true }), (e) => e.code === 'Unavailable' && /cannot read .*mod\.json: EACCES/.test(e.message));

    // an unreadable archive
    const key = keygen();
    const { archive } = await buildSigned(ctx.root, baseManifest({ id: 'test.arch' }), key);
    await chmod(archive, 0o000); restore.push(() => chmod(archive, 0o600));
    await assert.rejects(ctx.packages.verify(archive), (e) => e.code === 'Unavailable' && /cannot read .*codexmod: EACCES/.test(e.message));
  } finally { for (const r of restore) await r(); await ctx.cleanup(); }
});

// ------------------------------------------------------------------ F15: SemVer 2.0 build metadata
test('semver accepts +build metadata and ignores it for precedence and range matching', () => {
  assert.deepEqual(parseVersion('1.0.0-dev+83b4d8bf'), { major: 1, minor: 0, patch: 0, pre: 'dev', build: '83b4d8bf' });
  assert.equal(parseVersion('1.2.3+build.5').build, 'build.5');
  assert.equal(parseVersion('1.2.3').build, null);
  for (const bad of ['1.0.0+', '1.0.0+a..b', '1.0.0+a b', '1.0+x', '1.0.0-+x', '01.0.0+x']) assert.equal(parseVersion(bad), null, bad);
  assert.equal(compareVersions(parseVersion('1.0.0+a'), parseVersion('1.0.0+b')), 0);
  assert.equal(compareVersions(parseVersion('1.0.0-dev+z'), parseVersion('1.0.0')), -1);
  for (const range of ['>=1 <2', '^1', '~1.0', '1.0.0', '>=1.0.0-dev <2']) assert.equal(satisfies('1.0.0-dev+83b4d8bf', range), true, range);
  assert.equal(satisfies('1.0.0+abc', '1.0.0+zzz'), true);       // build metadata in a range is accepted and ignored
  assert.equal(satisfies('2.0.0-dev+83b4d8bf', '>=1 <2'), false);
  assert.notEqual(parseRange('>=1.0.0+abc <2'), null);
});

test('a content-addressed framework version (1.0.0-dev+hash) satisfies ">=1 <2"; mod versions may carry +build', async () => {
  const ctx = await setup('1.0.0-dev+83b4d8bf'); const key = keygen();
  try {
    const built = await buildSigned(ctx.root, baseManifest({ version: '1.2.0+abc.1' }), key);
    const pkg = await ctx.packages.verify(built.archive);
    assert.equal(pkg.manifest.version, '1.2.0+abc.1');
    assert.equal(await ctx.packages.store(pkg), join(ctx.L.store, 'test.alpha', '1.2.0+abc.1'));
    const dev = await writeModDir(ctx.root, baseManifest({ id: 'dev.build', version: '2.0.0-rc.1+sha.5114f85' }));
    assert.equal((await ctx.packages.verify(dev, { dev: true })).manifest.version, '2.0.0-rc.1+sha.5114f85');
    assert.equal(ctx.packages.validateManifest(baseManifest({ version: '1.0.0+x' })).version, '1.0.0+x');
    throwsCode(() => ctx.packages.validateManifest(baseManifest({ version: '1.0.0+' })), 'Invalid', /^version:/);
    // an out-of-range framework is still refused
    const tooNew = await buildSigned(ctx.root, baseManifest({ id: 'test.new', framework: '>=2 <3' }), key);
    await rejects(ctx.packages.verify(tooNew.archive), 'Incompatible', /requires >=2 <3, this is 1\.0\.0-dev\+83b4d8bf/);
  } finally { await ctx.cleanup(); }
});

test('F17: re-publishing different content under an existing version says to bump the version', async () => {
  const ctx = await setup(); const key = keygen();
  try {
    await ctx.packages.store(await ctx.packages.verify((await buildSigned(ctx.root, baseManifest(), key)).archive));
    const changed = await ctx.packages.verify((await buildSigned(ctx.root, baseManifest(), key, { 'host.js': 'export default { v: 2 };' })).archive);
    await rejects(ctx.packages.store(changed), 'Conflict', /test\.alpha@1\.0\.0 is already stored with different content.*bump the version/);
  } finally { await ctx.cleanup(); }
});

test('F6: what the pages read of a mod is optional and validated; its images exist, are images and are bounded each and together', async () => {
  const ctx = await setup();
  try {
    const good = baseManifest({ author: 'Acme', glyph: 'bell', about: ['One.', 'Two.'], testedWith: ['26.1027.30824-22943'], media: [{ id: 'one', src: 'media/one.png', caption: 'The first', aspect: '16 / 9' }] });
    const ok = await ctx.packages.verify(await writeModDir(ctx.root, good, { 'media/one.png': 'x' }), { dev: true });
    assert.equal(ok.manifest.author, 'Acme');
    assert.deepEqual(ok.manifest.media[0], { id: 'one', src: 'media/one.png', caption: 'The first', aspect: '16 / 9' });
    assert.equal((await ctx.packages.verify(await writeModDir(ctx.root, baseManifest({ glyph: 'not-a-glyph' })), { dev: true })).manifest.glyph, 'not-a-glyph', 'one the kit lacks draws the default');
    for (const [over, match] of [
      [{ author: '' }, /^author:/], [{ author: 5 }, /^author:/], [{ glyph: 5 }, /^glyph:/], [{ about: 'x' }, /^about:/], [{ about: [''] }, /^about\[0\]:/], [{ testedWith: 'x' }, /^testedWith:/],
      [{ media: 'x' }, /^media:/], [{ media: [{ id: 'a b', src: 'a.png' }] }, /^media\[0\]\.id:/], [{ media: [{ id: 'a', src: 'a.svg' }] }, /^media\[0\]\.src:/], [{ media: [{ id: 'a', src: '../a.png' }] }, /^media\[0\]\.src:/],
      [{ media: [{ id: 'a', src: 'a.png' }, { id: 'a', src: 'b.png' }] }, /^media: the image id "a" is used twice/], [{ media: [{ id: 'a', src: 'a.png', aspect: 'wide' }] }, /^media\[0\]\.aspect:/], [{ media: [{ id: 'a', src: 'a.png', other: 1 }] }, /^media\[0\]:/],
    ]) await rejects(ctx.packages.verify(await writeModDir(ctx.root, baseManifest(over), { 'a.png': 'x', 'b.png': 'x' }), { dev: true }), 'Invalid', match);
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, baseManifest({ media: [{ id: 'a', src: 'gone.png' }] })), { dev: true }), 'Invalid', /^media\[0\]\.src: file not found/);
    const inSettings = baseManifest({ settings: [{ group: 'G', media: { id: 'g', src: 'g.png' }, items: [{ key: 'c', kind: 'choice', title: 'C', default: 'x', control: 'thumbnails', options: [{ value: 'x', label: 'X', media: { id: 'x', src: 'x.png' } }] }] }] });
    await ctx.packages.verify(await writeModDir(ctx.root, inSettings, { 'g.png': 'x', 'x.png': 'x' }), { dev: true });
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, inSettings, { 'g.png': 'x' }), { dev: true }), 'Invalid', /file not found/, 'a setting\'s image is a file of the package too');
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, { ...inSettings, media: [{ id: 'x', src: 'g.png' }] }, { 'g.png': 'x', 'x.png': 'x' }), { dev: true }), 'Invalid', /^media: the image id "x" is used twice/);
    const big = Buffer.alloc(1024 * 1024 + 1);
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, baseManifest({ media: [{ id: 'a', src: 'a.png' }] }), { 'a.png': big }), { dev: true }), 'Invalid', /^media\[0\]\.src: larger than 1 MiB/);
    const each = Buffer.alloc(1024 * 1024);
    const nine = Array.from({ length: 9 }, (_, i) => `m${i}.png`);
    await rejects(ctx.packages.verify(await writeModDir(ctx.root, baseManifest({ media: nine.map((src, i) => ({ id: `m${i}`, src })) }), Object.fromEntries(nine.map((n) => [n, each]))), { dev: true }), 'Invalid', /^media: larger than 8 MiB/);
  } finally { await ctx.done?.(); }
});

test('F8: optional permissions are known, cover nothing a required or another optional one does, are never network, and never a processes with a process that starts with the mod; notes are for what it declares', () => {
  const ok = validateManifest(baseManifest({ permissions: ['ui'], optionalPermissions: ['graph.act:Thread.archive', 'secrets', 'graph.read:Draft'], permissionNotes: { secrets: { label: 'Your token', detail: 'Keeps the token you give it' }, ui: { detail: 'Adds a band' } } }));
  assert.deepEqual(ok.optionalPermissions, ['graph.act:Thread.archive', 'secrets', 'graph.read:Draft']);
  for (const [over, re] of [
    [{ optionalPermissions: 'secrets' }, /optionalPermissions: must be an array/],
    [{ optionalPermissions: ['root'] }, /optionalPermissions\[0\]: unknown permission/],
    [{ optionalPermissions: ['network'] }, /optionalPermissions\[0\]: network is not enforced/],
    [{ permissions: ['graph.act'], optionalPermissions: ['graph.act:Thread'] }, /optionalPermissions\[0\]: graph\.act:Thread covers some of what the required graph\.act does/],
    [{ optionalPermissions: ['graph.act:Thread', 'graph.act:Thread.archive'] }, /optionalPermissions\[1\]: .* covers some of what the optional graph\.act:Thread does/],
    [{ optionalPermissions: ['secrets', 'secrets'] }, /optionalPermissions\[1\]:/],
    [{ optionalPermissions: ['processes'], processes: { p: { command: 'p.js', start: 'with-mod' } } }, /optionalPermissions\[0\]: a process that starts with the mod/],
    [{ permissionNotes: [] }, /permissionNotes: must be an object/],
    [{ permissionNotes: { secrets: { detail: 'x' } } }, /permissionNotes\.secrets: secrets is not a permission this mod declares/],
    [{ permissions: ['ui'], permissionNotes: { ui: { label: 'x' } } }, /permissionNotes\.ui\.detail:/],
    [{ permissions: ['ui'], permissionNotes: { ui: { detail: 'x', risk: 'low' } } }, /permissionNotes\.ui: is \{label\?, detail\}/],
  ]) assert.throws(() => validateManifest(baseManifest(over)), re, JSON.stringify(over));
  validateManifest(baseManifest({ optionalPermissions: ['processes'], processes: { p: { command: 'p.js', start: 'on-demand' } } }));
  validateManifest(baseManifest({ optionalPermissions: ['secrets'], settings: [{ key: 'k', kind: 'toggle', title: 'K', default: false, needs: 'secrets' }] }), 'a setting may need an optional permission');
});

test('graph-integrity G8.2, D4: a session process; a program on the Mac only by its name, each named in a processes.exec permission (never bare)', async () => {
  const { permissionCovered, isValidPermission } = await import('./manifest.mjs');
  const { describePermission, permissionText } = await import('../management/methods.mjs');
  const session = (p, perms = ['processes', 'processes.exec:claude']) => baseManifest({ permissions: perms, processes: { cc: { kind: 'session', start: 'on-demand', ...p } } });
  const ok = validateManifest(session({ executable: 'claude', args: ['--print'], restart: 'on-failure' }));
  assert.deepEqual(ok.processes.cc, { kind: 'session', start: 'on-demand', executable: 'claude', args: ['--print'], restart: 'on-failure' });
  validateManifest(session({ command: 'bin/adapter.mjs' }, ['processes']));
  assert.equal(validateManifest(session({ executable: 'claude', instances: 8 })).processes.cc.instances, 8);
  validateManifest(baseManifest({ permissions: ['processes'], optionalPermissions: ['processes.exec:claude'], processes: { cc: { kind: 'session', executable: 'claude', start: 'on-demand' } } }));
  for (const [m, re] of [
    [session({ executable: 'claude' }, ['processes']), /processes\.cc\.executable: declare the program in permissions: "processes\.exec:claude"/],
    [session({ executable: 'git' }), /processes\.cc\.executable: declare the program/],
    [session({ executable: '/usr/local/bin/claude' }, ['processes', 'processes.exec:claude']), /processes\.cc\.executable: must be a program's name/],
    [session({ executable: 'claude; rm' }), /processes\.cc\.executable: must be a program's name/],
    [session({ executable: 'claude', command: 'bin/x' }), /processes\.cc: names one of command/],
    [session({}), /processes\.cc: names one of command/],
    [baseManifest({ permissions: ['processes', 'processes.exec:claude'], processes: { cc: { executable: 'claude', start: 'on-demand' } } }), /processes\.cc\.executable: only a session process runs a program/],
    [session({ executable: 'claude', idleStopMs: 1000 }), /processes\.cc\.idleStopMs: a session process is never stopped for being idle/],
    [baseManifest({ permissions: ['processes'], processes: { w: { command: 'bin/w', start: 'on-demand', restart: 'on-failure' } } }), /processes\.w\.restart: only a session sets its restart/],
    [session({ executable: 'claude', restart: 'always' }), /processes\.cc\.restart: must be "never" or "on-failure"/],
    [session({ executable: 'claude', kind: 'daemon' }), /processes\.cc\.kind: must be "worker" or "session"/],
    // a session that runs as several at once, one per chat say (`cc#<key>`): from 1 to MAX_INSTANCES, never a worker's, never with the mod's start
    [session({ executable: 'claude', instances: 0 }), /processes\.cc\.instances: must be an integer from 1 to 16/],
    [session({ executable: 'claude', instances: 17 }), /processes\.cc\.instances: must be an integer from 1 to 16/],
    [session({ executable: 'claude', instances: 2.5 }), /processes\.cc\.instances: must be an integer/],
    [session({ executable: 'claude', instances: 4, start: 'with-mod' }), /processes\.cc\.instances: a session that starts with the mod is one instance/],
    [baseManifest({ permissions: ['processes'], processes: { w: { command: 'bin/w', start: 'on-demand', instances: 2 } } }), /processes\.w\.instances: only a session runs as several instances/],
    [session({ executable: 'claude' }, ['processes', 'processes.exec']), /permissions\[1\]: unknown permission/],
    [baseManifest({ permissions: ['processes'], optionalPermissions: ['processes.exec:claude'], processes: { cc: { kind: 'session', executable: 'claude', start: 'with-mod' } } }), /optionalPermissions\[0\]: a process that starts with the mod cannot wait for a decision: declare the program/],
  ]) assert.throws(() => validateManifest(m), re, JSON.stringify(m.processes));
  // never bare, and a name is a program's name; a new program is not covered by another's grant (consent asks again)
  assert.deepEqual([isValidPermission('processes.exec'), isValidPermission('processes.exec:claude,git'), isValidPermission('processes.exec:a/b'), isValidPermission('processes.exec:')], [false, true, false, false]);
  assert.deepEqual([permissionCovered('processes.exec:claude', ['processes.exec:claude']), permissionCovered('processes.exec:git', ['processes.exec:claude']), permissionCovered('processes.exec:git', ['processes.exec'])], [true, false, false]);
  // consent names each program
  assert.deepEqual(describePermission('processes.exec:claude'), [{ risk: 'high', text: 'Runs claude on your Mac (a program installed there, with your access)' }]);
  assert.ok(permissionText(['processes', 'processes.exec:claude,git']).some((l) => l.text === 'Runs claude, git on your Mac (programs installed there, with your access)'));
  // a session's program is no file of the package
  const { referencedFiles } = await import('./manifest.mjs');
  assert.deepEqual(referencedFiles(ok).filter(([k]) => k.startsWith('processes.')), []);
});

test('validateManifest: the framework\'s own id is reserved (presentations.md V6)', async () => {
  const { packages } = await setup();
  assert.throws(() => packages.validateManifest(baseManifest({ id: 'codexmods.framework' })), /reserved for the framework/);
  // A mod's id is its provider id, so the native provider's is not a mod id either (graph/policy.mjs RESERVED_PROVIDERS).
  assert.throws(() => packages.validateManifest(baseManifest({ id: 'codex' })), /a provider id of the app's own instances/);
  assert.throws(() => packages.validateManifest(baseManifest({ id: 'codexmods.windows' })), /a provider id of the app's own instances/);
});
