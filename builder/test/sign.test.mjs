import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readEntitlements, filterEntitlements, isTeamScoped, listSigningTargets, signBundle, machoKind, DISABLE_LIBRARY_VALIDATION } from '../sign.mjs';
import { tmpdir, writePlist } from './helpers.mjs';

const STOCK_ENTS = {
  'com.apple.application-identifier': '2DC432GLL2.com.openai.codex',
  'com.apple.developer.team-identifier': '2DC432GLL2',
  'com.apple.developer.aps-environment': 'production',
  'com.apple.developer.associated-domains': ['x'],
  'com.apple.security.application-groups': ['2DC432GLL2.com.openai.codex'],
  'keychain-access-groups': ['2DC432GLL2.*'],
  'aps-environment': 'production',
  'application-identifier': 'X',
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.device.audio-input': true,
  'com.apple.security.cs.allow-unsigned-executable-memory': true,
};

test('team-scoped entitlements are stripped, everything else is kept', () => {
  const r = filterEntitlements(STOCK_ENTS, { identity: 'Apple Development: x (ABCDE12345)', executable: true });
  assert.deepEqual(Object.keys(r.entitlements).sort(), ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.device.audio-input']);
  assert.deepEqual(r.removed, ['application-identifier', 'aps-environment', 'com.apple.application-identifier', 'com.apple.developer.aps-environment', 'com.apple.developer.associated-domains', 'com.apple.developer.team-identifier', 'com.apple.security.application-groups', 'keychain-access-groups']);
  assert.deepEqual(r.added, []);
  for (const k of ['com.apple.security.cs.allow-jit', 'com.apple.security.app-sandbox', 'com.apple.security.cs.disable-library-validation']) assert.equal(isTeamScoped(k), false, k);
});

test('ad-hoc adds disable-library-validation to executables only', () => {
  const exe = filterEntitlements(STOCK_ENTS, { identity: '-', executable: true });
  assert.equal(exe.entitlements[DISABLE_LIBRARY_VALIDATION], true);
  assert.deepEqual(exe.added, [DISABLE_LIBRARY_VALIDATION]);
  const lib = filterEntitlements(STOCK_ENTS, { identity: '-', executable: false });
  assert.equal(DISABLE_LIBRARY_VALIDATION in lib.entitlements, false);
  const empty = filterEntitlements({}, { identity: '-', executable: true });
  assert.deepEqual(empty.entitlements, { [DISABLE_LIBRARY_VALIDATION]: true });
  const already = filterEntitlements({ [DISABLE_LIBRARY_VALIDATION]: true }, { identity: '-', executable: true });
  assert.deepEqual(already.added, []);
  assert.equal(filterEntitlements(undefined, { identity: 'id', executable: true }).removed.length, 0);
});

function fakeMachO(file, kind = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(kind, 12);
  fs.writeFileSync(file, b, { mode: 0o755 });
}
function makeTree(dir) {
  const app = path.join(dir, 'T.app');
  const c = path.join(app, 'Contents');
  fakeMachO(path.join(c, 'MacOS', 'T'));
  writePlist(path.join(c, 'Info.plist'), { CFBundleExecutable: 'T' });
  fakeMachO(path.join(c, 'Resources', 'tool'));
  fakeMachO(path.join(c, 'Resources', 'lib.dylib'), 6);
  fakeMachO(path.join(c, 'Resources', 'obj.o'), 1); // not signable
  fs.writeFileSync(path.join(c, 'Resources', 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const fw = path.join(c, 'Frameworks', 'F.framework');
  fakeMachO(path.join(fw, 'Versions', 'A', 'F'), 6);
  writePlist(path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), { CFBundleExecutable: 'F' });
  fs.symlinkSync('A', path.join(fw, 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/F', path.join(fw, 'F'));
  const helper = path.join(fw, 'Versions', 'A', 'Helpers', 'H.app');
  fakeMachO(path.join(helper, 'Contents', 'MacOS', 'H'));
  writePlist(path.join(helper, 'Contents', 'Info.plist'), { CFBundleExecutable: 'H' });
  fakeMachO(path.join(fw, 'Versions', 'A', 'Libraries', 'deep.dylib'), 6);
  return app;
}

test('listSigningTargets: inside-out order, bundle main executables are not signed twice, symlinks and non-code skipped', (t) => {
  const app = makeTree(tmpdir(t));
  const rel = listSigningTargets(app).map((x) => path.relative(app, x.path) || '.');
  const idx = (p) => rel.indexOf(p);
  assert.equal(rel.at(-1), '.', 'root last');
  assert.ok(idx('Contents/Frameworks/F.framework/Versions/A/Helpers/H.app') >= 0);
  assert.ok(idx('Contents/Frameworks/F.framework/Versions/A/Libraries/deep.dylib') < idx('Contents/Frameworks/F.framework'));
  assert.ok(idx('Contents/Frameworks/F.framework/Versions/A/Helpers/H.app') < idx('Contents/Frameworks/F.framework'));
  assert.ok(idx('Contents/Frameworks/F.framework') < idx('.'));
  assert.ok(rel.includes('Contents/Resources/tool') && rel.includes('Contents/Resources/lib.dylib'));
  assert.ok(!rel.includes('Contents/MacOS/T'), 'main exec belongs to the root bundle signature');
  assert.ok(!rel.includes('Contents/Frameworks/F.framework/Versions/A/F'), 'framework main belongs to the framework signature');
  assert.ok(!rel.includes('Contents/Frameworks/F.framework/Versions/A/Helpers/H.app/Contents/MacOS/H'));
  assert.ok(!rel.includes('Contents/Resources/obj.o') && !rel.includes('Contents/Resources/script.sh'));
  assert.ok(!rel.some((p) => p.includes('Versions/Current')));
  assert.equal(machoKind(path.join(app, 'Contents/Resources/obj.o')), 'other');
  assert.equal(machoKind(path.join(app, 'Contents/Resources/script.sh')), null);
});

test('signBundle (fake codesign): order, per-target entitlements, final verify; ad-hoc adds DLV to executables', async (t) => {
  const app = makeTree(tmpdir(t));
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([path.basename(cmd), args]);
    if (args[0] === '-d') {
      return { stdout: '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.application-identifier</key><string>T.x</string><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const work = tmpdir(t);
  const entPlists = [];
  const spy = async (cmd, args) => {
    const i = args.indexOf('--entitlements');
    if (args[0] !== '-d' && i >= 0) entPlists.push({ target: args.at(-1), ents: JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', args[i + 1]], { encoding: 'utf8' })) });
    return run(cmd, args);
  };
  const res = await signBundle(app, { identity: '-', run: spy, workDir: work, concurrency: 1 });
  const signs = calls.filter(([, a]) => a.includes('--sign'));
  assert.equal(signs.at(-1)[1].at(-1), app, 'root signed last');
  assert.ok(signs.every(([, a]) => a.includes('--options') && a[a.indexOf('--options') + 1] === 'runtime'));
  assert.deepEqual(calls.at(-1), ['codesign', ['--verify', '--deep', '--strict', app]]);
  assert.equal(res.verified, true);
  const root = entPlists.find((e) => e.target === app);
  assert.equal(root.ents[DISABLE_LIBRARY_VALIDATION], true);
  assert.equal(root.ents['com.apple.security.cs.allow-jit'], true);
  assert.equal('com.apple.application-identifier' in root.ents, false);
  const fwSign = signs.find(([, a]) => a.at(-1).endsWith('F.framework'));
  assert.equal(fwSign[1].includes('--entitlements'), false, 'non-executable bundle gets no entitlements');
  assert.ok(entPlists.some((e) => e.target.endsWith('tool')), 'loose executables get entitlements');
});

test('signBundle propagates a codesign failure and requires an identity', async (t) => {
  const app = makeTree(tmpdir(t));
  await assert.rejects(signBundle(app, { identity: '' }), /identity/);
  await assert.rejects(signBundle(app, { identity: '-', run: async (c, a) => { if (a.includes('--sign')) throw new Error('boom'); return { stdout: '', stderr: a.includes('-vvvv') ? 'hashes=10+2' : '' }; }, workDir: tmpdir(t) }), /boom/);
});

test('real ad-hoc signing of a fixture app passes codesign --verify --deep --strict', async (t) => {
  const dir = tmpdir(t);
  const app = path.join(dir, 'R.app');
  const c = path.join(app, 'Contents');
  fs.mkdirSync(path.join(c, 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(c, 'MacOS', 'R'));
  fs.mkdirSync(path.join(c, 'Resources'), { recursive: true });
  fs.copyFileSync('/usr/bin/false', path.join(c, 'Resources', 'helper-tool'));
  writePlist(path.join(c, 'Info.plist'), { CFBundleIdentifier: 'dev.codexmods.test', CFBundleExecutable: 'R', CFBundlePackageType: 'APPL' });
  const r = await signBundle(app, { identity: '-' });
  assert.equal(r.verified, true);
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).status, 0);
  const ents = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', path.join(c, 'MacOS', 'R')], { encoding: 'utf8' }).stdout;
  assert.match(ents, /disable-library-validation/);
  const flags = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
  assert.match(flags, /flags=0x\w+\(.*runtime/);
});

// ---- v1.16 team-matched container
import { evaluateSignedGroups, dumpSignedEntitlements, readTeamIdentifier, readEntitlementsStrict, decodeEntitlementDer, EntitlementReadError, specialSlotCount, APP_GROUPS } from '../sign.mjs';
const GROUP = 'ABCDE12345.com.openai.sky.CUAServicf';

test('filterEntitlements: the team group replaces the stripped stock groups on executables only when asked', () => {
  const src = { [APP_GROUPS]: ['2DC432GLL2.com.openai.codex.notifications', '2DC432GLL2.com.openai.sky.CUAService'], 'com.apple.security.cs.allow-jit': true };
  const r = filterEntitlements(src, { identity: 'Apple Development: T (ABCDE12345)', executable: true, appGroup: GROUP });
  assert.deepEqual(r.entitlements[APP_GROUPS], [GROUP]);
  assert.equal(r.entitled, true);
  assert.equal(r.entitlements['com.apple.security.cs.allow-jit'], true);
  assert.deepEqual(filterEntitlements(src, { identity: 'Apple Development: T (ABCDE12345)', executable: true }).entitlements[APP_GROUPS], undefined, 'not asked: stripped as before');
  assert.equal(filterEntitlements(src, { identity: 'Apple Development: T (ABCDE12345)', executable: false, appGroup: GROUP }).entitled, false, 'libraries get no entitlements');
  assert.equal(filterEntitlements(src, { identity: '-', executable: true }).entitled, false, 'ad-hoc: no group');
});

test('signBundle with a team group: the app main always gets it, a Computer Use helper executable only if its stock signature carried one', async (t) => {
  const dir = tmpdir(t);
  const app = path.join(dir, 'T.app'); const c = path.join(app, 'Contents');
  const mk = (rel) => { const f = path.join(c, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); const b = Buffer.alloc(64); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(2, 12); fs.writeFileSync(f, b, { mode: 0o755 }); return f; };
  mk('MacOS/T'); writePlist(path.join(c, 'Info.plist'), { CFBundleExecutable: 'T' });
  const withGroup = mk('Resources/cua_node/bin/withgroup'); const without = mk('Resources/cua_node/bin/nogroup'); const outside = mk('Resources/other/outside');
  const fakeEnts = { [app]: { [APP_GROUPS]: ['2DC432GLL2.com.openai.codex.notifications'] }, [withGroup]: { [APP_GROUPS]: ['2DC432GLL2.x'] }, [without]: { 'com.apple.security.cs.allow-jit': true }, [outside]: { [APP_GROUPS]: ['2DC432GLL2.y'] } };
  const toXml = (o) => { const f = path.join(dir, 'e.json'); fs.writeFileSync(f, JSON.stringify(o)); execFileSync('/usr/bin/plutil', ['-convert', 'xml1', f]); return fs.readFileSync(f, 'utf8'); };
  const given = {};
  const run = async (cmd, args) => {
    if (args[0] === '-d') return { stdout: toXml(fakeEnts[args.at(-1)] ?? {}), stderr: '' };
    const i = args.indexOf('--entitlements');
    if (i >= 0) given[args.at(-1)] = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', args[i + 1]], { encoding: 'utf8' }));
    return { stdout: '', stderr: '' };
  };
  const res = await signBundle(app, { identity: 'Apple Development: T (ABCDE12345)', run, workDir: tmpdir(t), concurrency: 1, appGroup: GROUP });
  assert.deepEqual(given[app][APP_GROUPS], [GROUP]);
  assert.deepEqual(given[withGroup][APP_GROUPS], [GROUP]);
  assert.equal(given[without][APP_GROUPS], undefined);
  assert.equal(given[outside][APP_GROUPS], undefined, 'outside the Computer Use tree: stripped');
  assert.deepEqual(res.targets.filter((x) => x.entitled).map((x) => x.path).sort(), ['.', 'Contents/Resources/cua_node/bin/withgroup'].sort());
  // no appGroup (ad-hoc builds): nobody gets one
  const g2 = {}; Object.keys(given).forEach((k) => delete given[k]);
  const res2 = await signBundle(app, { identity: '-', run, workDir: tmpdir(t), concurrency: 1 });
  assert.equal(res2.targets.some((x) => x.entitled), false);
  for (const k of Object.keys(given)) assert.equal(given[k][APP_GROUPS], undefined, k);
  void g2;
});

test('evaluateSignedGroups: team-matched groups pass; another team, an unprefixed group, or any group on an ad-hoc signature are mismatches', () => {
  const ents = (g) => [{ path: 'p', ents: { [APP_GROUPS]: g } }];
  assert.deepEqual(evaluateSignedGroups(ents([GROUP]), 'ABCDE12345').mismatches, []);
  assert.deepEqual(evaluateSignedGroups([{ path: 'q', ents: { x: 1 } }], 'ABCDE12345'), { groups: {}, mismatches: [] });
  assert.match(evaluateSignedGroups(ents(['2DC432GLL2.com.openai.sky.CUAServicf']), 'ABCDE12345').mismatches[0].why, /names team 2DC432GLL2/);
  assert.match(evaluateSignedGroups(ents(['group.foo']), 'ABCDE12345').mismatches[0].why, /not team-prefixed/);
  assert.match(evaluateSignedGroups(ents([GROUP]), null).mismatches[0].why, /ad-hoc/);
  assert.equal(evaluateSignedGroups(ents(GROUP), 'ABCDE12345').groups.p[0], GROUP, 'a single string value');
});

test('post-sign readers on a real ad-hoc fixture: entitlements dumped strictly, TeamIdentifier unset', async (t) => {
  const dir = tmpdir(t);
  const app = path.join(dir, 'R.app'); const c = path.join(app, 'Contents');
  fs.mkdirSync(path.join(c, 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(c, 'MacOS', 'R'));
  writePlist(path.join(c, 'Info.plist'), { CFBundleIdentifier: 'dev.codexmods.test2', CFBundleExecutable: 'R', CFBundlePackageType: 'APPL' });
  const r = await signBundle(app, { identity: '-' });
  const dump = await dumpSignedEntitlements(app, r.targets.map((x) => x.path));
  assert.ok(dump.length >= 1 && dump.every((d) => !(APP_GROUPS in d.ents)));
  assert.equal(await readTeamIdentifier(app), null);
  await assert.rejects(dumpSignedEntitlements(app, ['Contents/MacOS/does-not-exist']), 'a failing codesign inspection is an error, never "no entitlements"');
});

// ---- strict entitlement reader
const XML_OK = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.application-groups</key><array><string>2DC432GLL2.x</string></array></dict></plist>';
const WARN = 'warning: binary contains an invalid entitlements blob. The OS will ignore these entitlements.';
/** A codesign fake keyed by the distinguishing argument. */
const fakeCodesign = ({ xml, der, verbose }) => async (cmd, args) => {
  const mode = args.includes('--xml') ? 'xml' : args.includes('--der') ? 'der' : args.includes('-vvvv') ? 'verbose' : '?';
  const r = { xml, der, verbose }[mode];
  if (r instanceof Error) throw r;
  return r ?? { stdout: '', stderr: '' };
};
/** Apple's entitlements DER, encoded here from a plain object (UTF8String keys; BOOLEAN / INTEGER / UTF8String / SEQUENCE / nested dict values). */
function derEncode(dict) {
  const tlv = (tag, body) => { const n = body.length; const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]); return Buffer.concat([Buffer.from([tag]), len, body]); };
  const val = (v) => (typeof v === 'boolean' ? tlv(1, Buffer.from([v ? 0xff : 0])) : typeof v === 'number' ? tlv(2, Buffer.from([v])) : typeof v === 'string' ? tlv(0x0c, Buffer.from(v)) : Array.isArray(v) ? tlv(0x30, Buffer.concat(v.map(val))) : tlv(0xb0, members(v)));
  const members = (o) => Buffer.concat(Object.entries(o).map(([k, v]) => tlv(0x30, Buffer.concat([tlv(0x0c, Buffer.from(k)), val(v)]))));
  return tlv(0x70, Buffer.concat([tlv(2, Buffer.from([1])), tlv(0xb0, members(dict))]));
}

test('strict reader: the XML path', async () => {
  const r = await readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: XML_OK, stderr: 'Executable=/x\n' } }));
  assert.deepEqual(r, { ents: { 'com.apple.security.cs.allow-jit': true, [APP_GROUPS]: ['2DC432GLL2.x'] }, source: 'xml' });
});

test('strict reader: empty stdout plus an "invalid entitlements blob" warning is ENTITLEMENT_READ, never {}', async () => {
  for (const o of [{ xml: { stdout: '', stderr: `Executable=/x\n${WARN}\n` } }, { xml: { stdout: '', stderr: '' }, der: { stdout: Buffer.alloc(0), stderr: WARN } }]) {
    await assert.rejects(readEntitlementsStrict('/x', fakeCodesign(o)), (e) => e instanceof EntitlementReadError && e.code === 'ENTITLEMENT_READ' && /invalid entitlements blob/.test(e.message));
  }
  await assert.rejects(readEntitlements('/x', fakeCodesign({ xml: { stdout: '', stderr: WARN } })), (e) => e.code === 'ENTITLEMENT_READ', 'the plain reader is strict too');
});

test('strict reader: non-plist output and codesign failures are errors', async () => {
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: 'this is not a plist', stderr: '' } })), (e) => e.code === 'ENTITLEMENT_READ' && /not a property list/.test(e.message));
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ xml: new Error('codesign failed: bad things') })), (e) => e.code === 'ENTITLEMENT_READ');
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '<plist version="1.0"><array/></plist>', stderr: '' } })), (e) => e.code === 'ENTITLEMENT_READ' && /not a dictionary/.test(e.message));
});

test('strict reader: the DER fallback decodes in-process (empty XML, DER present)', async () => {
  const dict = { 'com.apple.security.app-sandbox': false, [APP_GROUPS]: ['2DC432GLL2.com.openai.codex.notifications', '2DC432GLL2.com.openai.sky.CUAService'], 'com.apple.security.cs.allow-jit': true, nested: { n: 5, s: 'x'.repeat(200) } };
  const r = await readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '', stderr: '' }, der: { stdout: derEncode(dict), stderr: '' } }));
  assert.deepEqual(r, { ents: dict, source: 'der' });
  assert.deepEqual(decodeEntitlementDer(derEncode({})), {});
  assert.throws(() => decodeEntitlementDer(Buffer.from('garbage')), /not an entitlements DER|truncated|DER/);
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '', stderr: '' }, der: { stdout: Buffer.from([0x70, 0x03, 0x02, 0x01, 0x05]), stderr: '' } })), (e) => e.code === 'ENTITLEMENT_READ' && /undecodable DER/.test(e.message));
});

test('strict reader: "no entitlements" is explicit - fewer than 5 special slots, or "not signed at all"; a signature that has the slot but yields nothing is an error', async () => {
  const none = await readEntitlementsStrict('/x', fakeCodesign({ verbose: { stdout: '', stderr: 'CodeDirectory v=20500 size=31327 flags=0x10000(runtime) hashes=973+2 location=embedded\n' } }));
  assert.deepEqual(none, { ents: {}, source: 'none' });
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ verbose: { stdout: '', stderr: 'CodeDirectory v=20500 size=190821 flags=0x10000(runtime) hashes=5952+7 location=embedded\n' } })), (e) => e.code === 'ENTITLEMENT_READ' && /7 special slots/.test(e.message));
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ verbose: { stdout: '', stderr: 'no hashes line' } })), (e) => e.code === 'ENTITLEMENT_READ' && /could not be inspected/.test(e.message));
  const unsigned = await readEntitlementsStrict('/x', fakeCodesign({ xml: new Error('/x: code object is not signed at all') }));
  assert.deepEqual(unsigned, { ents: {}, source: 'unsigned' });
  assert.equal(specialSlotCount('CodeDirectory hashes=10+5 location'), 5);
  assert.equal(specialSlotCount('x'), null);
});

test('strict reader: empty XML output (with the invalid-blob warning, or without) falls through to --der', async () => {
  const dict = { [APP_GROUPS]: ['2DC432GLL2.com.openai.sky.CUAServicf'], 'com.apple.security.cs.allow-jit': true };
  for (const stderr of [WARN, '', `Executable=/x\n${WARN}\n`]) {
    const r = await readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '', stderr }, der: { stdout: derEncode(dict), stderr: '' } }));
    assert.deepEqual(r, { ents: dict, source: 'der' });
  }
  // the warning on the DER call does not matter when the DER decodes
  assert.equal((await readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '', stderr: WARN }, der: { stdout: derEncode(dict), stderr: WARN } }))).source, 'der');
});

test('strict reader: XML-empty and DER-empty is ENTITLEMENT_READ (also with 5+ special slots and no warning), never none-by-accident', async () => {
  const verbose = { stdout: '', stderr: 'CodeDirectory hashes=5952+7 location=embedded\n' };
  for (const o of [{ xml: { stdout: '', stderr: WARN }, der: { stdout: Buffer.alloc(0), stderr: '' }, verbose: { stdout: '', stderr: 'hashes=10+2' } }, { xml: { stdout: '', stderr: '' }, der: { stdout: Buffer.alloc(0), stderr: '' }, verbose }]) {
    await assert.rejects(readEntitlementsStrict('/x', fakeCodesign(o)), (e) => e instanceof EntitlementReadError && e.code === 'ENTITLEMENT_READ');
  }
  // malformed DER (non-empty but undecodable) is an error too
  await assert.rejects(readEntitlementsStrict('/x', fakeCodesign({ xml: { stdout: '', stderr: WARN }, der: { stdout: Buffer.from('70068201', 'hex'), stderr: '' } })), (e) => e.code === 'ENTITLEMENT_READ' && /undecodable DER/.test(e.message));
});

test('strict DER decoder: truncated lengths, child overruns, trailing bytes, unconsumed content and unknown tags all throw', () => {
  const h = (x) => Buffer.from(x.replace(/\s/g, ''), 'hex');
  const good = derEncode({ a: true, b: ['x', 2], c: { d: 'y' } });
  assert.deepEqual(decodeEntitlementDer(good), { a: true, b: ['x', 2], c: { d: 'y' } });
  const bad = {
    'truncated long-form length': h('70 06 02 01 01 b0 82 ff'),
    'long-form length with no length bytes': h('70 04 02 01 01 b0 82'),
    'child overruns its parent': h('70 08 02 01 01 b0 04 30 05 0c 01 61'),
    'declared top length past the end': h('70 20 02 01 01 b0 00'),
    'trailing bytes after the blob': Buffer.concat([good, Buffer.from([0])]),
    'unknown tag in a dict value': h('70 0e 02 01 01 b0 09 30 07 0c 01 61 05 02 aa bb'),
    'unknown tag at top level of the dict members': h('70 08 02 01 01 b0 03 04 01 00'),
    'dict member with trailing bytes': h('70 0d 02 01 01 b0 08 30 06 0c 01 61 01 01 ff 00'),
    'sequence with a truncated element': h('70 0e 02 01 01 b0 09 30 07 0c 01 61 30 02 0c 05'),
    'not a dictionary': h('70 05 02 01 01 0c 00'),
    'oversized length': h('70 85 ff ff ff ff ff'),
    'version INTEGER with zero length': h('70 04 02 00 b0 00'),
    'version INTEGER too long': h('70 0e 02 09 01 00 00 00 00 00 00 00 00 b0 00'),
    'wrong version value': h('70 05 02 01 02 b0 00'),
    'version zero': h('70 05 02 01 00 b0 00'),
    'empty input': Buffer.alloc(0),
    'BOOLEAN with a bad length': h('70 0c 02 01 01 b0 07 30 05 0c 01 61 01 00'),
  };
  for (const [name, buf] of Object.entries(bad)) assert.throws(() => decodeEntitlementDer(buf), Error, name);
  assert.deepEqual(decodeEntitlementDer(h('70 05 02 01 01 b0 00')), {}, 'an empty dictionary is fine');
});

const defaultRunForTest = async (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'latin1', maxBuffer: 1 << 25 }); if (r.status !== 0) throw new Error(String(r.stderr)); return { stdout: Buffer.from(r.stdout, 'latin1'), stderr: r.stderr }; };
const STOCK = '/Applications/ChatGPT.app';
test('real stock binaries (read-only): the strict reader works on every Computer Use executable; DER and XML agree; list of app-group holders', { skip: !fs.existsSync(STOCK) && 'stock app not installed' }, async () => {
  const root = path.join(STOCK, 'Contents');
  const targets = listSigningTargets(STOCK).filter((x) => (x.type === 'bundle' ? !!x.main : x.kind === 'execute') && `${x.path}/`.includes('/Resources/cua_node/'));
  assert.ok(targets.length >= 4);
  const holders = []; const none = []; const sources = {};
  for (const x of targets) {
    const rel = path.relative(root, x.path);
    const { ents, source } = await readEntitlementsStrict(x.path);
    sources[rel] = source;
    // force the macOS-27 "empty XML + invalid-blob warning" behaviour on the REAL blobs: the reader must fall through to the real --der and agree
    if (source === 'xml') {
      const forced = await readEntitlementsStrict(x.path, async (cmd, args) => (args.includes('--xml') ? { stdout: '', stderr: WARN } : defaultRunForTest(cmd, args)));
      assert.equal(forced.source, 'der', rel); assert.deepEqual(forced.ents, ents, rel);
    }
    if (APP_GROUPS in ents) holders.push(rel); else none.push(`${rel} (${source})`);
    // whatever path the reader took (xml, or der when macOS 27 returns an empty XML blob), the DER blob decodes to the same dictionary
    const der = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--der', x.path], { maxBuffer: 1 << 24 });
    if (der.stdout.length) assert.deepEqual(decodeEntitlementDer(der.stdout), ents, rel);
  }
  if (process.env.QA_HOLDERS_OUT) fs.writeFileSync(process.env.QA_HOLDERS_OUT, JSON.stringify({ holders, none, sources }, null, 2));
  for (const needle of ['bin/node', 'bin/node_repl', 'Codex Computer Use.app', 'SkyComputerUseClient.app']) assert.ok(holders.some((h) => h.endsWith(needle)), `${needle} carries app groups in the stock signature`);
  assert.ok(!holders.some((h) => h.includes('CUALockScreenGuardian')), 'the lock-screen guardian carries none');
  const main = await readEntitlementsStrict(STOCK);
  assert.ok(APP_GROUPS in main.ents, 'the main app carries app groups');
});
