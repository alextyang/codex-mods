import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanBuffer, isolationScan, signatureRanges, ISOLATION_SCAN_ALLOWLIST, rewriteNativePeerAuthTeam, NativePeerAuthError, NATIVE_PEER_AUTH_FILE, STOCK_TEAM, ASAR_SCAN_PATTERN } from '../isolation-scan.mjs';
import { tmpdir } from './helpers.mjs';

const U16 = (s) => Buffer.from(s, 'utf16le');
const kinds = (b) => scanBuffer(b).hits.map((h) => `${h.kind}/${h.encoding}`);

test('stock tokens are hits in UTF-8 and UTF-16LE; the renamed forms are not', () => {
  assert.deepEqual(kinds(Buffer.from('x 2DC432GLL2.com.openai.sky.CUAService y')), ['group-id/utf8']);
  assert.deepEqual(kinds(Buffer.from('bundle com.openai.sky.CUAService y')), ['bundle-id/utf8']);
  assert.deepEqual(kinds(Buffer.from('env SKY_CUA_SERVICE_PATH z')), ['env-name/utf8']);
  assert.deepEqual(kinds(Buffer.concat([Buffer.from('pad'), U16('2DC432GLL2.com.openai.sky.CUAService'), Buffer.from([0, 0])])), ['group-id/utf16le']);
  assert.deepEqual(kinds(U16('com.openai.sky.CUAService')), ['bundle-id/utf16le']);
  assert.deepEqual(kinds(U16('SKY_CUA_SERVICE_PATH')), ['env-name/utf16le']);
  for (const ok of ['2DC432GLL2.com.openai.sky.CUAServicf', 'com.openai.sky.CUAServicf', 'SKY_CUA_SERVICE_PATM', 'com.openai.sky.CUAServicf.cli']) {
    assert.deepEqual(kinds(Buffer.from(ok)), [], ok); assert.deepEqual(kinds(U16(ok)), [], `${ok} (utf16)`);
  }
});

test('suffix boundary: the .guardian/.cli/.AuthorizationPlugin… suffixes must carry the f', () => {
  for (const suffix of ['.guardian', '.cli', '.AuthorizationPluginInstaller', '.AuthorizationPlugin']) {
    assert.deepEqual(kinds(Buffer.from(`com.openai.sky.CUAServicf${suffix}`)), [], `renamed ${suffix}`);
    assert.deepEqual(kinds(Buffer.from(`com.openai.sky.CUAService${suffix}`)), ['bundle-id/utf8'], `stock ${suffix}`);
    assert.deepEqual(kinds(U16(`com.openai.sky.CUAService${suffix}`)), ['bundle-id/utf16le'], `stock ${suffix} utf16`);
  }
  // "followed by f" is the only exemption; any other continuation is a hit
  assert.deepEqual(kinds(Buffer.from('com.openai.sky.CUAServiceX')), ['bundle-id/utf8']);
  assert.deepEqual(kinds(Buffer.from('com.openai.sky.CUAService')), ['bundle-id/utf8'], 'token at end of file');
  assert.deepEqual(kinds(Buffer.from('2DC432GLL2.com.openai.sky.CUAService.guardian')), ['group-id/utf8']);
});

test('hits carry file, offset (of the whole group id when prefixed) and context', () => {
  const b = Buffer.from('....2DC432GLL2.com.openai.sky.CUAService....');
  const [h] = scanBuffer(b, { file: 'a/b.js' }).hits;
  assert.deepEqual([h.file, h.offset, h.kind], ['a/b.js', 4, 'group-id']);
  assert.match(h.context, /2DC432GLL2\.com\.openai\.sky\.CUAService/);
});

/** Minimal thin arm64 Mach-O with an LC_CODE_SIGNATURE covering [sigOff, sigOff+sigSize). */
function macho(body, sigAt) {
  const header = Buffer.alloc(32 + 16);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(1, 16); header.writeUInt32LE(16, 20);
  header.writeUInt32LE(0x1d, 32); header.writeUInt32LE(16, 36); header.writeUInt32LE(sigAt, 40); header.writeUInt32LE(body.length - (sigAt - 48), 44);
  return Buffer.concat([header, body]);
}

test('Mach-O code-signature blobs are skipped (the re-signing replaces them); the same bytes elsewhere are hits', () => {
  const sig = Buffer.from('SIGNATURE entitlement 2DC432GLL2.com.openai.sky.CUAService group');
  const body = Buffer.concat([Buffer.from('code ... '), sig]);
  const sigAt = 48 + 'code ... '.length;
  const bin = macho(body, sigAt);
  assert.deepEqual(signatureRanges(bin), [[sigAt, sigAt + sig.length]]);
  const r = scanBuffer(bin);
  assert.deepEqual([r.hits.length, r.signatureSkipped], [0, 1]);
  const outside = macho(Buffer.concat([Buffer.from('code com.openai.sky.CUAService code '), sig]), 48 + 'code com.openai.sky.CUAService code '.length);
  assert.deepEqual(scanBuffer(outside).hits.map((h) => h.kind), ['bundle-id']);
  assert.deepEqual(signatureRanges(Buffer.from('not a macho file at all')), []);
});

test('isolationScan walks the Computer Use tree and the given asar bundles; allowlist entries are exact (file and kind) and carry a reason', (t) => {
  const dir = tmpdir(t);
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  put('Resources/cua_node/a/ok.js', 'com.openai.sky.CUAServicf');
  put('Resources/cua_node/a/bad.js', 'SKY_CUA_SERVICE_PATH');
  put('Resources/cua_node/b/inert.txt', '2DC432GLL2.com.openai.sky.CUAService');
  put('Resources/other/ignored.js', 'com.openai.sky.CUAService');
  fs.symlinkSync(path.join(dir, 'Resources/other'), path.join(dir, 'Resources/cua_node/link'));
  const asarFiles = [{ path: '.vite/build/main.js', buf: Buffer.from('ok') }, { path: '.vite/build/src-1.js', buf: U16('com.openai.sky.CUAService') }];
  const r = isolationScan(dir, asarFiles, { allowlist: [{ file: 'Resources/cua_node/b/inert.txt', kind: 'group-id', reason: 'test: inert' }] });
  assert.equal(r.files, 5);
  assert.deepEqual(r.hits.map((h) => `${h.file}|${h.kind}|${h.encoding}`).sort(), ['Resources/cua_node/a/bad.js|env-name|utf8', 'app.asar:.vite/build/src-1.js|bundle-id|utf16le']);
  assert.deepEqual(r.allowlisted.map((h) => [h.file, h.reason]), [['Resources/cua_node/b/inert.txt', 'test: inert']]);
  // a different kind in the same file is not covered
  const r2 = isolationScan(dir, [], { allowlist: [{ file: 'Resources/cua_node/b/inert.txt', kind: 'env-name', reason: 'wrong kind' }] });
  assert.ok(r2.hits.some((h) => h.file === 'Resources/cua_node/b/inert.txt'));
  assert.equal(isolationScan(path.join(dir, 'nowhere')).files, 0);
});

test('the shipped allowlist is exact, justified and small (reviewed against the 20156 bundle)', () => {
  assert.ok(ISOLATION_SCAN_ALLOWLIST.length <= 3);
  for (const e of ISOLATION_SCAN_ALLOWLIST) {
    assert.ok(e.file && !/[*?]/.test(e.file), 'exact paths only');
    assert.ok(e.reason.length > 60, 'a reason is mandatory');
  }
});

const TEAM = 'ABCDE12345';
/** A real signed Mach-O (/usr/bin/true) with `n` rewritable stock team ids appended outside the signature, plus one planted inside the signature blob (left alone). */
function nativeAddon(n = 1) {
  const buf = fs.readFileSync('/usr/bin/true');
  const [[a]] = signatureRanges(buf);
  const b = Buffer.from(buf); Buffer.from(STOCK_TEAM).copy(b, a + 64);
  return Buffer.concat([b, Buffer.from(`\0${`peer ${STOCK_TEAM} `.repeat(n)}keep MQ55VZLNZQ\0`)]);
}
const writeAddon = (dir, data) => { const abs = path.join(dir, NATIVE_PEER_AUTH_FILE); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data, { mode: 0o755 }); return abs; };

test('rewriteNativePeerAuthTeam (N9): the one stock team id outside the signature is rewritten in place at same length; the signature blob and other team ids are left alone; the mode is kept', (t) => {
  const dir = tmpdir(t);
  const abs = writeAddon(dir, nativeAddon(1));
  const before = fs.readFileSync(abs);
  const r = rewriteNativePeerAuthTeam(dir, TEAM);
  assert.deepEqual(r, { file: NATIVE_PEER_AUTH_FILE, count: 1 });
  const out = fs.readFileSync(abs);
  assert.equal(out.length, before.length, 'same length');
  assert.ok(out.includes(Buffer.from(`peer ${TEAM} `)), 'the outside-signature pin is now ours');
  assert.ok(out.includes(Buffer.from('MQ55VZLNZQ')), 'another team id is untouched');
  assert.equal(fs.statSync(abs).mode & 0o777, 0o755, 'mode preserved');
  // the stock id survives ONLY where it was planted inside the signature blob (the re-signing replaces that)
  const [[a, bEnd]] = signatureRanges(out);
  const hits = []; for (let i = out.indexOf(Buffer.from(STOCK_TEAM)); i >= 0; i = out.indexOf(Buffer.from(STOCK_TEAM), i + 1)) hits.push(i);
  assert.ok(hits.length === 1 && hits[0] >= a && hits[0] < bEnd, 'the only remaining stock id is inside the signature');
});

test('rewriteNativePeerAuthTeam (N9): fails closed on a missing file, on drift (zero or more than one occurrence outside the signature) without modifying the file, and on an invalid team', (t) => {
  const dir = tmpdir(t);
  // missing file
  assert.throws(() => rewriteNativePeerAuthTeam(dir, TEAM), (e) => e instanceof NativePeerAuthError && e.code === 'NATIVE_PEER_AUTH_MISSING' && e.details.file === NATIVE_PEER_AUTH_FILE);
  // zero occurrences outside the signature (a stock drift that would silently no-op)
  const abs = writeAddon(dir, nativeAddon(0));
  assert.throws(() => rewriteNativePeerAuthTeam(dir, TEAM), (e) => e instanceof NativePeerAuthError && e.code === 'NATIVE_PEER_AUTH_DRIFT' && e.details.count === 0);
  // more than one occurrence outside the signature
  const two = nativeAddon(2); fs.writeFileSync(abs, two);
  assert.throws(() => rewriteNativePeerAuthTeam(dir, TEAM), (e) => e instanceof NativePeerAuthError && e.code === 'NATIVE_PEER_AUTH_DRIFT' && e.details.count === 2);
  assert.ok(fs.readFileSync(abs).equals(two), 'a refusal leaves the file byte-for-byte unchanged');
  // invalid team id
  fs.writeFileSync(abs, nativeAddon(1));
  assert.throws(() => rewriteNativePeerAuthTeam(dir, 'short'), /invalid team/);
});

test('the asar scan covers every main-process bundle: 21477\'s main and src, 22943\'s early-bootstrap chunks, and the workers; not preloads or other bundles', () => {
  for (const p of ['.vite/build/main-JI9qDiXp.js', '.vite/build/src-CsH31EEu.js', '.vite/build/worker.js', '.vite/build/worker-307-1e7fa1b2fda3b094.js',
    '.vite/build/early-bootstrap.js', '.vite/build/early-bootstrap-916-2f6483d5bfd826f1.js']) assert.ok(ASAR_SCAN_PATTERN.test(p), p);
  for (const p of ['.vite/build/preload.js', '.vite/build/browser-page-preload.js', '.vite/build/mcp-annotation-runtime.js', 'webview/assets/app-initial-dddef47d6ef6.js'])
    assert.ok(!ASAR_SCAN_PATTERN.test(p), p);
});
