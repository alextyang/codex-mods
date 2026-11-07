// ASAR integrity rewrite (ARCHITECTURE.md §3, §5 step 3). Two places carry the hash of app.asar's header:
//   1. Contents/Info.plist  ElectronAsarIntegrity["Resources/app.asar"] = {algorithm: SHA256, hash: <sha256 of header JSON string>}
//   2. a 32-byte digest of that whole dictionary compiled into the Electron framework binary, in the
//      __DATA_CONST,__asar_integrity section (66 bytes: 32-byte sentinel, used flag, version, digest). Present on newer builds.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUTIL = '/usr/bin/plutil';
const SENTINEL = 'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A';
const HEX64 = /^[a-f0-9]{64}$/;

export function readPlistJson(plistPath) {
  return JSON.parse(execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Replace/insert a top-level string key. */
export function setPlistString(plistPath, key, value) {
  try { execFileSync(PLUTIL, ['-replace', key, '-string', value, plistPath], { stdio: 'pipe' }); }
  catch { execFileSync(PLUTIL, ['-insert', key, '-string', value, plistPath], { stdio: 'pipe' }); }
}

export function setPlistBool(plistPath, key, value) {
  try { execFileSync(PLUTIL, ['-replace', key, '-bool', String(value), plistPath], { stdio: 'pipe' }); }
  catch { execFileSync(PLUTIL, ['-insert', key, '-bool', String(value), plistPath], { stdio: 'pipe' }); }
}

/** Remove a top-level key; absent keys are not an error. Returns whether it existed. */
export function removePlistKey(plistPath, key) {
  if (!(key in readPlistJson(plistPath))) return false;
  execFileSync(PLUTIL, ['-remove', key, plistPath], { stdio: 'pipe' });
  return true;
}

/** Digest of the integrity dictionary as Electron computes it: sha256 over, for sorted keys, key + algorithm + hash. */
export function dictionaryDigest(integrity) {
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity) || Object.keys(integrity).length === 0) {
    throw new Error('Unsupported ElectronAsarIntegrity dictionary');
  }
  const h = createHash('sha256');
  for (const key of Object.keys(integrity).sort()) {
    const v = integrity[key];
    if (!/^[\x20-\x7e]+$/.test(key) || !v || v.algorithm !== 'SHA256' || !HEX64.test(v.hash ?? '')) throw new Error('Unsupported ElectronAsarIntegrity dictionary');
    h.update(key).update(v.algorithm).update(v.hash);
  }
  return h.digest('hex');
}

/**
 * Rewrite ElectronAsarIntegrity[key].hash in the plist. `oldHash` must match what is there (refuses otherwise).
 * Returns {old, new, integrity (updated dictionary), previousIntegrity}.
 */
export function rewritePlistIntegrity(plistPath, key, oldHash, newHash) {
  if (!HEX64.test(newHash)) throw new Error('rewritePlistIntegrity: bad new hash');
  const info = readPlistJson(plistPath);
  const dict = info.ElectronAsarIntegrity;
  const rec = dict?.[key];
  if (!rec || rec.algorithm !== 'SHA256') throw new Error(`Info.plist has no SHA256 ElectronAsarIntegrity entry for ${key}`);
  if (oldHash && rec.hash !== oldHash) throw new Error(`Info.plist integrity for ${key} is ${rec.hash}, expected ${oldHash}`);
  const next = { ...dict, [key]: { ...rec, hash: newHash } };
  // Replace the whole dictionary as JSON: keys contain dots, which plutil would read as key-path separators.
  execFileSync(PLUTIL, ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify(next), plistPath], { stdio: 'pipe' });
  const after = readPlistJson(plistPath).ElectronAsarIntegrity;
  if (JSON.stringify(after[key]) !== JSON.stringify(next[key])) throw new Error('Info.plist integrity update did not stick');
  return { old: rec.hash, new: newHash, integrity: next, previousIntegrity: dict };
}

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const cstr = (b, o) => b.subarray(o, o + 16).toString('ascii').replace(/\0.*$/, '');

/**
 * Locate the __asar_integrity slot in a thin 64-bit little-endian Mach-O.
 * Returns null when the section does not exist; {fileOffset, used, version, digest(hex), digestOffset} otherwise.
 */
export function findIntegritySlot(bytes) {
  const fail = (why) => { throw new Error(`Unsupported Electron framework layout: ${why}`); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64) fail('not a thin 64-bit Mach-O');
  const count = bytes.readUInt32LE(16), cmdBytes = bytes.readUInt32LE(20);
  if (count > 4096 || 32 + cmdBytes > bytes.length) fail('bad load commands');
  let pos = 32, slot = null;
  for (let i = 0; i < count; i += 1) {
    const cmd = bytes.readUInt32LE(pos), size = bytes.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > 32 + cmdBytes) fail('bad load command size');
    if (cmd === LC_SEGMENT_64) {
      const nsects = bytes.readUInt32LE(pos + 64);
      if (72 + nsects * 80 !== size) fail('bad segment size');
      for (let s = 0; s < nsects; s += 1) {
        const o = pos + 72 + s * 80;
        if (cstr(bytes, o) !== '__asar_integrity') continue;
        const length = Number(bytes.readBigUInt64LE(o + 40)), fileOffset = bytes.readUInt32LE(o + 48);
        if (slot) fail('duplicate __asar_integrity section');
        if (length !== 66 || fileOffset + 66 > bytes.length) fail('unexpected __asar_integrity size');
        const p = bytes.subarray(fileOffset, fileOffset + 66);
        if (p.subarray(0, 32).toString('ascii') !== SENTINEL || p[32] > 1) fail('unexpected __asar_integrity sentinel');
        slot = { fileOffset, used: p[32] === 1, version: p[33], digest: p.subarray(34).toString('hex'), digestOffset: fileOffset + 34 };
      }
    }
    pos += size;
  }
  return slot;
}

export function countOccurrences(haystack, needle) {
  let n = 0;
  for (let from = 0; ;) { const i = haystack.indexOf(needle, from); if (i < 0) return n; n += 1; from = i + 1; }
}

/**
 * Pure patch step on framework bytes. Returns {present:false} when the build has no enabled digest slot, otherwise
 * {present:true, bytes (new Buffer), offset}. Refuses unless exactly one occurrence of the old digest exists and it
 * is the slot's own digest.
 */
export function patchFrameworkDigestBytes(bytes, oldIntegrity, newIntegrity) {
  if (bytes.indexOf(SENTINEL) < 0) return { present: false }; // e.g. Sparkle: no digest slot, possibly a fat Mach-O
  const slot = findIntegritySlot(bytes);
  if (!slot || !slot.used) return { present: false };
  if (slot.version !== 1) throw new Error(`Unsupported __asar_integrity version ${slot.version}`);
  const oldDigest = dictionaryDigest(oldIntegrity), newDigest = dictionaryDigest(newIntegrity);
  if (slot.digest !== oldDigest) throw new Error('Electron framework digest does not match the original ElectronAsarIntegrity dictionary');
  const oldBuf = Buffer.from(oldDigest, 'hex');
  const n = countOccurrences(bytes, oldBuf);
  if (n !== 1) throw new Error(`Expected exactly one occurrence of the old integrity digest in the Electron framework, found ${n}`);
  if (bytes.indexOf(oldBuf) !== slot.digestOffset) throw new Error('Old integrity digest is not located in the __asar_integrity slot');
  const out = Buffer.from(bytes);
  Buffer.from(newDigest, 'hex').copy(out, slot.digestOffset);
  return { present: true, bytes: out, offset: slot.digestOffset, oldDigest, newDigest };
}

/** Find the framework executables under Contents/Frameworks that carry an __asar_integrity section. */
export function findElectronFrameworkBinaries(bundlePath) {
  const fwDir = path.join(bundlePath, 'Contents', 'Frameworks');
  const out = [];
  if (!fs.existsSync(fwDir)) return out;
  for (const e of fs.readdirSync(fwDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith('.framework')) continue;
    const bin = path.join(fwDir, e.name, e.name.replace(/\.framework$/, ''));
    try {
      if (fs.statSync(bin).isFile()) out.push(fs.realpathSync(bin));
    } catch { /* not this layout */ }
  }
  return out;
}

/**
 * Patch the digest in the framework binary of a bundle, in place. Returns {path, present, ...}; present:false when
 * no framework has an enabled slot. Writes only the 32 digest bytes.
 */
export function patchFrameworkDigest(bundlePath, oldIntegrity, newIntegrity) {
  const results = [];
  for (const bin of findElectronFrameworkBinaries(bundlePath)) {
    const bytes = fs.readFileSync(bin);
    const r = patchFrameworkDigestBytes(bytes, oldIntegrity, newIntegrity);
    if (!r.present) { results.push({ path: bin, present: false }); continue; }
    // clonefile'd copies share blocks; write via a new inode so the stock file is never touched.
    const tmp = `${bin}.tmp-${process.pid}`;
    const mode = fs.statSync(bin).mode & 0o7777;
    fs.writeFileSync(tmp, r.bytes, { mode });
    fs.renameSync(tmp, bin);
    results.push({ path: bin, present: true, offset: r.offset, oldDigest: r.oldDigest, newDigest: r.newDigest });
  }
  return results;
}
