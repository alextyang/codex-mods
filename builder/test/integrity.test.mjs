import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dictionaryDigest, findIntegritySlot, patchFrameworkDigestBytes, patchFrameworkDigest, rewritePlistIntegrity, countOccurrences } from '../integrity.mjs';
import { makeFrameworkMachO, tmpdir, writePlist, readPlist, sha } from './helpers.mjs';

// Real stock values (ChatGPT 26.1007.21159 / 20052): Info.plist dictionary -> digest compiled into the framework.
const STOCK_DICT = { 'Resources/app.asar': { algorithm: 'SHA256', hash: 'c497f508930f223a999ec4c436a7526252914d380339db9e229cb023d200b41f' } };
const STOCK_DIGEST = '827f0a558877ad30113906b8c75d430ef9e1e287bbea72955c56df3991731d76';
const NEW_DICT = { 'Resources/app.asar': { algorithm: 'SHA256', hash: sha('new header') } };

test('dictionaryDigest reproduces the digest embedded in the stock framework', () => {
  assert.equal(dictionaryDigest(STOCK_DICT), STOCK_DIGEST);
  assert.throws(() => dictionaryDigest({}), /Unsupported/);
  assert.throws(() => dictionaryDigest({ a: { algorithm: 'MD5', hash: 'x' } }), /Unsupported/);
});

test('slot is found and patched; only the 32 digest bytes change', () => {
  const { buffer, digestOffset } = makeFrameworkMachO({ digestHex: STOCK_DIGEST });
  const slot = findIntegritySlot(buffer);
  assert.deepEqual({ used: slot.used, version: slot.version, digest: slot.digest, digestOffset: slot.digestOffset }, { used: true, version: 1, digest: STOCK_DIGEST, digestOffset });
  const r = patchFrameworkDigestBytes(buffer, STOCK_DICT, NEW_DICT);
  assert.equal(r.present, true);
  assert.equal(r.bytes.subarray(digestOffset, digestOffset + 32).toString('hex'), dictionaryDigest(NEW_DICT));
  assert.ok(r.bytes.subarray(0, digestOffset).equals(buffer.subarray(0, digestOffset)));
  assert.ok(r.bytes.subarray(digestOffset + 32).equals(buffer.subarray(digestOffset + 32)));
  assert.notEqual(buffer.subarray(digestOffset, digestOffset + 32).toString('hex'), dictionaryDigest(NEW_DICT), 'input untouched');
});

test('refuses unless exactly one occurrence of the old digest', () => {
  const { buffer } = makeFrameworkMachO({ digestHex: STOCK_DIGEST, extraCopy: true });
  assert.equal(countOccurrences(buffer, Buffer.from(STOCK_DIGEST, 'hex')), 2);
  assert.throws(() => patchFrameworkDigestBytes(buffer, STOCK_DICT, NEW_DICT), /exactly one occurrence.*found 2/);
});

test('refuses when the framework digest does not match the original dictionary', () => {
  const { buffer } = makeFrameworkMachO({ digestHex: sha('something else') });
  assert.throws(() => patchFrameworkDigestBytes(buffer, STOCK_DICT, NEW_DICT), /does not match/);
});

test('unused slot or no section: nothing to patch; not Mach-O: refuse', () => {
  assert.equal(patchFrameworkDigestBytes(makeFrameworkMachO({ digestHex: STOCK_DIGEST, used: false }).buffer, STOCK_DICT, NEW_DICT).present, false);
  const noSection = makeFrameworkMachO({ digestHex: STOCK_DIGEST }).buffer;
  noSection.write('__other_section__', 32 + 72, 'ascii');
  assert.equal(findIntegritySlot(noSection), null);
  assert.equal(patchFrameworkDigestBytes(noSection, STOCK_DICT, NEW_DICT).present, false);
  assert.throws(() => findIntegritySlot(Buffer.from('not a macho file, definitely not')), /Mach-O/);
});

test('patchFrameworkDigest rewrites the file in a bundle through a new inode', (t) => {
  const dir = tmpdir(t);
  const fw = path.join(dir, 'X.app', 'Contents', 'Frameworks', 'Y.framework');
  fs.mkdirSync(fw, { recursive: true });
  const bin = path.join(fw, 'Y');
  fs.writeFileSync(bin, makeFrameworkMachO({ digestHex: STOCK_DIGEST }).buffer, { mode: 0o755 });
  const ino = fs.statSync(bin).ino;
  const [r] = patchFrameworkDigest(path.join(dir, 'X.app'), STOCK_DICT, NEW_DICT);
  assert.equal(r.present, true);
  assert.notEqual(fs.statSync(bin).ino, ino);
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
  assert.equal(findIntegritySlot(fs.readFileSync(bin)).digest, dictionaryDigest(NEW_DICT));
});

test('rewritePlistIntegrity: dotted key, preserves other keys, checks old hash', (t) => {
  const dir = tmpdir(t);
  const plist = path.join(dir, 'Info.plist');
  writePlist(plist, { CFBundleName: 'X', ElectronAsarIntegrity: { ...STOCK_DICT, 'Resources/other.asar': { algorithm: 'SHA256', hash: sha('o') } } });
  assert.throws(() => rewritePlistIntegrity(plist, 'Resources/app.asar', sha('wrong'), sha('n')), /expected/);
  assert.throws(() => rewritePlistIntegrity(plist, 'Resources/missing.asar', null, sha('n')), /no SHA256/);
  const r = rewritePlistIntegrity(plist, 'Resources/app.asar', STOCK_DICT['Resources/app.asar'].hash, sha('n'));
  const after = readPlist(plist);
  assert.equal(after.CFBundleName, 'X');
  assert.equal(after.ElectronAsarIntegrity['Resources/app.asar'].hash, sha('n'));
  assert.equal(after.ElectronAsarIntegrity['Resources/other.asar'].hash, sha('o'));
  assert.equal(r.old, STOCK_DICT['Resources/app.asar'].hash);
});

test('a binary without the sentinel (fat Mach-O, other framework) is skipped, not an error', () => {
  const fat = Buffer.alloc(256); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  assert.equal(patchFrameworkDigestBytes(fat, STOCK_DICT, NEW_DICT).present, false);
});
