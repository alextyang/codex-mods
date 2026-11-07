// Locator tests on a synthetic arm64 Mach-O (no stock app needed): the xref chain, exact-twice rule and encodings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { locateKeychainName, locateAuraFallback, deriveKeychainPatches, applyBinaryPatch, applyBinaryPatches, movzW, movkWlsl16, parseMachO } from './binary-patch.mjs';

const ADRP = (rd, fromPc, target) => { const imm = Math.floor(target / 4096) - Math.floor(fromPc / 4096); return (0x90000000 | ((imm & 3) << 29) | (((imm >> 2) & 0x7ffff) << 5) | rd) >>> 0; };
const ADD = (rd, rn, imm12) => (0x91000000 | (imm12 << 10) | (rn << 5) | rd) >>> 0;
const STR = (rn) => (0xb9000008 | (rn << 5) | (1 << 10)) >>> 0;
const STRH = (rn) => (0x79000008 | (rn << 5) | (1 << 10)) >>> 0;
const NAME = (rn, ch = 0x78) => [movzW(8, 0x6f43), movkWlsl16(8, 0x6564), STR(rn), movzW(8, ch), STRH(rn)];

/** __TEXT{__text,__const} at vmaddr = fileoff. text words at 0x1000; the " Storage Key" string lives in __const (as in the real binary). */
function machO({ words, strings = ['xx Storage Key\0'] }) {
  const TEXT_OFF = 0x1000, CONST_OFF = 0x3000, SIZE = 0x4000;
  const buf = Buffer.alloc(SIZE);
  buf.writeUInt32LE(0xfeedfacf, 0); buf.writeUInt32LE(0x0100000c, 4); buf.writeUInt32LE(1, 16);          // magic, cpu arm64, ncmds
  const lc = 32; buf.writeUInt32LE(0x19, lc); buf.writeUInt32LE(72 + 2 * 80, lc + 4); buf.write('__TEXT', lc + 8, 'latin1'); buf.writeUInt32LE(2, lc + 64);
  const sect = (i, name, addr, size, off) => { const q = lc + 72 + i * 80; buf.write(name, q, 'latin1'); buf.write('__TEXT', q + 16, 'latin1'); buf.writeBigUInt64LE(BigInt(addr), q + 32); buf.writeBigUInt64LE(BigInt(size), q + 40); buf.writeUInt32LE(off, q + 48); };
  sect(0, '__text', TEXT_OFF, 0x1000, TEXT_OFF); sect(1, '__const', CONST_OFF, 0x1000, CONST_OFF);
  let p = CONST_OFF; const addrs = [];
  for (const s of strings) { addrs.push(p); buf.write(s, p, 'latin1'); p += s.length; }
  words(buf, TEXT_OFF, addrs[0] + 2, addrs);
  return buf;
}
const put = (buf, off, ws) => ws.forEach((w, i) => buf.writeUInt32LE(w >>> 0, off + i * 4));

const good = (buf, base, strAddr) => {
  put(buf, base + 0x100, NAME(26));                                       // account (base register x26), earlier
  put(buf, base + 0x400, [...NAME(31), ADRP(1, base + 0x414, strAddr), ADD(1, 1, strAddr & 0xfff)]);   // service (sp) + the xref
};

test('encodings: movz w8,#0x78 is 0x52800f08 and #0x79 is 0x52800f28', () => {
  assert.equal(movzW(8, 0x78), 0x52800f08);
  assert.equal(movzW(8, 0x79), 0x52800f28);
  assert.equal(movzW(8, 0x6f43), 0x528de868);
  assert.equal(movkWlsl16(8, 0x6564), 0x72acac88);
});

test('locator follows string → ADRP+ADD xref → the two name words (service nearest the reference, account earlier)', () => {
  const buf = machO({ words: good });
  const hits = locateKeychainName(buf);
  assert.deepEqual(hits.map((h) => h.offset), [0x1000 + 0x400 + 12, 0x1000 + 0x100 + 12]);
  assert.ok(hits.every((h) => h.base === 'x' && h.newChar === 'y'));
  const ps = deriveKeychainPatches(buf, 'Frameworks/X.framework/Versions/1/X');
  assert.deepEqual(ps.map((p) => [p.before, p.after]), [['080f8052', '280f8052'], ['080f8052', '280f8052']]);
  assert.equal(ps[1].sha256Before, ps[0].sha256After);
  const out = applyBinaryPatches(buf, ps);
  assert.equal(out.readUInt32LE(0x1000 + 0x400 + 12), 0x52800f28);
  assert.equal(out.readUInt32LE(0x1000 + 0x100 + 12), 0x52800f28);
  assert.equal(buf.readUInt32LE(0x1000 + 0x100 + 12), 0x52800f08, 'the input buffer is never modified');
});

test('fails closed unless the pattern is found exactly twice', () => {
  assert.throws(() => locateKeychainName(machO({ words: (b, base, a) => { put(b, base + 0x400, [...NAME(31), ADRP(1, base + 0x414, a), ADD(1, 1, a & 0xfff)]); } })), /occurs 1 times.*expected exactly 2/);
  assert.throws(() => locateKeychainName(machO({ words: (b, base, a) => { good(b, base, a); put(b, base + 0x200, NAME(27)); } })), /occurs 3 times/);
  assert.throws(() => locateKeychainName(machO({ words: (b, base, a) => { put(b, base + 0x100, NAME(26, 0x79)); put(b, base + 0x400, [...NAME(31, 0x79), ADRP(1, base + 0x414, a), ADD(1, 1, a & 0xfff)]); } })), /occurs 0 times/);
});

test('fails closed when the suffix string or its reference is not exactly one', () => {
  assert.throws(() => locateKeychainName(machO({ words: good, strings: ['xx Storage Key\0', 'yy Storage Key\0'] })), /occurs 2 times in __TEXT data/);
  assert.throws(() => locateKeychainName(machO({ words: good, strings: ['no suffix here\0'] })), /occurs 0 times/);
  assert.throws(() => locateKeychainName(machO({ words: (b, base) => { put(b, base + 0x100, NAME(26)); put(b, base + 0x400, NAME(31)); } })), /referenced from 0 places/);
  assert.throws(() => locateKeychainName(machO({ words: (b, base, a) => { good(b, base, a); put(b, base + 0x800, [ADRP(2, base + 0x800, a), ADD(2, 2, a & 0xfff)]); } })), /referenced from 2 places/);
});

test('an immediate that is not the expected "x" (a different build) is not patched', () => {
  const buf = machO({ words: (b, base, a) => { put(b, base + 0x100, NAME(26, 0x7a)); put(b, base + 0x400, [...NAME(31, 0x7a), ADRP(1, base + 0x414, a), ADD(1, 1, a & 0xfff)]); } });
  assert.throws(() => locateKeychainName(buf), /occurs 0 times/);
});

test('applyBinaryPatch fails closed on hash, bytes, and length mismatches; parseMachO rejects non-arm64', () => {
  const buf = machO({ words: good });
  const [p] = deriveKeychainPatches(buf, 'f');
  assert.throws(() => applyBinaryPatch(Buffer.concat([buf, Buffer.alloc(1)]), p), /sha256Before mismatch/);
  assert.throws(() => applyBinaryPatch(buf, { ...p, sha256After: '0'.repeat(64) }), /sha256After mismatch/);
  assert.throws(() => applyBinaryPatch(buf, { ...p, before: '00000000' }), /not the expected/);
  const x86 = Buffer.from(buf); x86.writeUInt32LE(0x01000007, 4);
  assert.throws(() => parseMachO(x86), /arm64/);
});

// ---- Aura fallback
const STRH_W = (rt, rn = 22) => (0x79000000 | (0x10 / 2 << 10) | (rn << 5) | rt) >>> 0;
const STR_W22 = (rt) => (0xb9000000 | (22 << 5) | rt) >>> 0;
/** Codey service/account code plus the Aura fallback: service tail 'e' as `movz w9,#'e'; strh w9,[x22,#16]`, account `movz w8,#'Au'; movk w8,#'ra',lsl 16`. */
const withAura = (extra = {}) => (b, base, a, addrs) => {
  good(b, base, a);
  const svcAddr = addrs[1], accAddr = addrs[2] + 1;                                  // strings: [codey suffix, "Aura Safe Storage\0", "\0Aura\0"]
  put(b, base + 0x500, [ADRP(8, base + 0x500, svcAddr), ADD(8, 8, svcAddr & 0xfff), movzW(9, 0x65), STRH_W(9)]);
  put(b, base + 0x600, [ADRP(8, base + 0x600, accAddr), ADD(8, 8, accAddr & 0xfff), movzW(8, 0x7541), movkWlsl16(8, 0x6172), STR_W22(8)]);
  extra.after?.(b, base);
};
const AURA_STRINGS = ['xx Storage Key\0', 'Aura Safe Storage\0', '\0Aura\0'];

test('Aura fallback: service tail and account immediates are located and patched (Aura Safe Storagf / Aurb), data strings untouched', () => {
  const buf = machO({ words: withAura(), strings: AURA_STRINGS });
  const [svc, acc] = locateAuraFallback(buf, locateKeychainName(buf).ref);
  assert.deepEqual([svc.offset, acc.offset], [0x1000 + 0x500 + 8, 0x1000 + 0x600 + 12]);
  assert.equal(svc.newWord, movzW(9, 0x66), "'e' → 'f'");
  assert.equal(acc.newWord, movkWlsl16(8, 0x6272), "'ra' → 'rb'");
  const ps = deriveKeychainPatches(buf, 'f', { aura: true });
  assert.deepEqual(ps.map((p) => p.id), ['keychain-service-name', 'keychain-service-name-account', 'aura-fallback-service', 'aura-fallback-account']);
  for (let i = 1; i < ps.length; i++) assert.equal(ps[i].sha256Before, ps[i - 1].sha256After, 'one chain over the whole file');
  const out = applyBinaryPatches(buf, ps);
  assert.equal(out.readUInt32LE(svc.offset), movzW(9, 0x66));
  assert.equal(out.readUInt32LE(acc.offset), movkWlsl16(8, 0x6272));
  assert.ok(out.includes(Buffer.from('Aura Safe Storage\0')) && out.includes(Buffer.from('\0Aura\0')), 'the shared data strings (also used by the profile importer) are not modified');
});

test('Aura fallback fails closed: missing/duplicated strings, references, patterns, or a reference far from the Codey code', () => {
  const ref = (b) => locateKeychainName(b).ref;
  assert.throws(() => deriveKeychainPatches(machO({ words: good }), 'f', { aura: true }), /Aura service string occurs 0 times/);
  const dup = machO({ words: withAura(), strings: [...AURA_STRINGS, 'Aura Safe Storage\0'] });
  assert.throws(() => locateAuraFallback(dup, ref(dup)), /Aura service string occurs 2 times/);
  const noTail = machO({ words: (b, base, a, addrs) => { withAura()(b, base, a, addrs); put(b, base + 0x50c, [movzW(9, 0x41)]); }, strings: AURA_STRINGS });
  assert.throws(() => locateAuraFallback(noTail, ref(noTail)), /service last-character immediate occurs 0 times/);
  const twoRefs = machO({ words: withAura({ after: (b, base) => { const a = 0x3000 + AURA_STRINGS[0].length; put(b, base + 0x700, [ADRP(8, base + 0x700, a), ADD(8, 8, a & 0xfff)]); } }), strings: AURA_STRINGS });
  assert.throws(() => locateAuraFallback(twoRefs, ref(twoRefs)), /referenced from 2 places/);
  const noAcc = machO({ words: (b, base, a, addrs) => { withAura()(b, base, a, addrs); put(b, base + 0x608, [movzW(8, 0x7542)]); }, strings: AURA_STRINGS });
  assert.throws(() => locateAuraFallback(noAcc, ref(noAcc)), /account immediates occur 0 times/);
  const far = machO({ words: (b, base, a, addrs) => { withAura()(b, base, a, addrs); }, strings: AURA_STRINGS });
  assert.throws(() => locateAuraFallback(far, ref(far) + 0x2000), /not near the Codey name code/);
});
