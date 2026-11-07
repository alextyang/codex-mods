// Exact-byte patches to signed Mach-O files outside app.asar (contracts/adapter.d.ts AdapterPack.binaryPatches, v1.10) and the static
// locator that derives them. Static only: this reads the file, it never executes it.
//
// Keychain service name (builder/KEYCHAIN.md): Owl's OSCrypt key is stored as service "<name> Storage Key", account "<name>", with <name> a
// hard-coded "Codex" assembled from instruction immediates (so no data string, plist or ini value can change it). The service string is built
// next to the only code reference to the string " Storage Key", the account string a little earlier in the same function, each as
//     movz w8,#0x6f43 ; movk w8,#0x6564,lsl 16 ; str w8,[xN,#a] ; movz w8,#0x78 ('x') ; strh w8,[xN,#b]
// Changing the 'x' immediate of both gives "Codey Storage Key" / "Codey". The locator walks that xref chain and fails closed unless the
// signature occurs exactly twice in the function neighbourhood.
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ---- arm64 encodings (A64), little-endian words
export const movzW = (rd, imm16) => (0x52800000 | (imm16 << 5) | rd) >>> 0;
export const movkWlsl16 = (rd, imm16) => (0x72a00000 | (imm16 << 5) | rd) >>> 0;
const STR_W = 0xb9000008, STRH_W = 0x79000008, MASK_STORE = 0xffc0001f;             // str/strh w8,[xN,#imm] (any base register: sp for the service, a pointer for the account)

// ---- Mach-O
const MH_MAGIC_64 = 0xfeedfacf, FAT_MAGIC = 0xcafebabe, CPU_ARM64 = 0x0100000c, LC_SEGMENT_64 = 0x19;

/** → { base: slice file offset, sections: [{seg, name, addr, size, offset}] } for the arm64 slice of a thin or fat Mach-O. */
export function parseMachO(buf) {
  let base = 0;
  if (buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    base = -1;
    for (let i = 0; i < n; i++) if (buf.readUInt32BE(8 + i * 20) === CPU_ARM64) base = buf.readUInt32BE(8 + i * 20 + 8);
    if (base < 0) throw new Error('fat Mach-O has no arm64 slice');
  }
  if (buf.readUInt32LE(base) !== MH_MAGIC_64 || buf.readUInt32LE(base + 4) !== CPU_ARM64) throw new Error('not an arm64 64-bit Mach-O');
  const ncmds = buf.readUInt32LE(base + 16);
  const sections = [];
  let p = base + 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (cmd === LC_SEGMENT_64) {
      const seg = buf.toString('latin1', p + 8, p + 24).replace(/\0.*$/, '');
      const nsects = buf.readUInt32LE(p + 64);
      for (let s = 0; s < nsects; s++) {
        const q = p + 72 + s * 80;
        sections.push({ seg, name: buf.toString('latin1', q, q + 16).replace(/\0.*$/, ''), addr: Number(buf.readBigUInt64LE(q + 32)), size: Number(buf.readBigUInt64LE(q + 40)), offset: buf.readUInt32LE(q + 48) + base });
      }
    }
    p += size;
  }
  return { base, sections };
}

const word = (buf, off) => buf.readUInt32LE(off);

/** Offsets (file) of every ADRP+ADD pair in the section that materialises `target` (a vmaddr). */
export function findAddressRefs(buf, sec, target) {
  const hits = [];
  const wanted = Math.floor(target / 4096);
  const lo = target & 0xfff;
  const aligned = (buf.byteOffset + sec.offset) % 4 === 0;
  const words = aligned ? new Uint32Array(buf.buffer, buf.byteOffset + sec.offset, Math.floor(sec.size / 4)) : null;
  const n = Math.floor(sec.size / 4);
  const w = (i) => (words ? words[i] : word(buf, sec.offset + i * 4));
  for (let i = 0; i < n; i++) {
    const a = w(i);
    if (((a & 0x9f000000) >>> 0) !== 0x90000000) continue;                      // ADRP
    const immlo = (a >>> 29) & 3, immhi = (a >>> 5) & 0x7ffff;
    let imm = (immhi << 2) | immlo;
    if (imm & (1 << 20)) imm -= 1 << 21;
    const pc = sec.addr + i * 4;
    if (Math.floor(pc / 4096) + imm !== wanted) continue;
    const rd = a & 31;
    for (let j = 1; j <= 8 && i + j < n; j++) {
      const b = w(i + j);
      if (((b & 0xff800000) >>> 0) === 0x91000000 && ((b >>> 5) & 31) === rd && ((b >>> 10) & 0xfff) === lo && ((b >>> 22) & 1) === 0) { hits.push(sec.offset + (i + j) * 4); break; }
    }
  }
  return hits;
}

/**
 * Derive the keychain-name patches from the framework binary. Fails closed (throws) unless
 * " Storage Key\0" occurs once in __TEXT data, is referenced from exactly one place, and the 'Code'+'x' signature occurs exactly twice
 * in the neighbourhood of that reference (account earlier, service just before the reference).
 * @returns {{ word: number, offset: number, base: string, newChar: string }[]}  file offsets of the two `movz w8,#'x'` words, service first
 */
export function locateKeychainName(buf, { suffix = ' Storage Key', window = 0x1000 } = {}) {
  const { sections } = parseMachO(buf);
  const text = sections.find((s) => s.seg === '__TEXT' && s.name === '__text');
  if (!text) throw new Error('framework has no __TEXT,__text');
  const needle = Buffer.from(`${suffix}\0`, 'latin1');
  const found = [];                 // the linker pools this string into __const here, not __cstring: search every read-only data section
  for (const sec of sections.filter((s) => s.seg === '__TEXT' && ['__cstring', '__const', '__literals'].includes(s.name))) {
    for (let i = buf.indexOf(needle, sec.offset); i >= 0 && i + needle.length <= sec.offset + sec.size; i = buf.indexOf(needle, i + 1)) found.push({ sec, off: i });
  }
  if (found.length !== 1) throw new Error(`"${suffix}" C string occurs ${found.length} times in __TEXT data sections, expected exactly 1`);
  const strAddr = found[0].sec.addr + (found[0].off - found[0].sec.offset);
  const refs = findAddressRefs(buf, text, strAddr);
  if (refs.length !== 1) throw new Error(`"${suffix}" is referenced from ${refs.length} places in __text, expected exactly 1`);
  const ref = refs[0];

  const from = Math.max(text.offset, ref - window), to = Math.min(text.offset + text.size - 20, ref + 0x80);
  const matches = [];
  const c1 = movzW(8, 0x6f43), c2 = movkWlsl16(8, 0x6564);                       // 'C','o' / 'd','e'
  for (let off = from; off <= to; off += 4) {
    if (word(buf, off) !== c1 || word(buf, off + 4) !== c2) continue;
    if (((word(buf, off + 8) & MASK_STORE) >>> 0) !== STR_W) continue;
    const m = word(buf, off + 12);
    if (((m & 0xffe0001f) >>> 0) !== ((0x52800000 | 8) >>> 0)) continue;                          // movz w8,#imm16
    if (((word(buf, off + 16) & MASK_STORE) >>> 0) !== STRH_W) continue;
    const ch = (m >>> 5) & 0xffff;
    if (ch !== 0x78) continue;                                                    // the trailing 'x' of "Codex"
    matches.push({ word: m, offset: off + 12, base: String.fromCharCode(ch), newChar: String.fromCharCode(ch + 1) });
  }
  if (matches.length !== 2) throw new Error(`"Code"+'x' name signature occurs ${matches.length} times near the "${suffix}" reference, expected exactly 2`);
  matches.sort((a, b) => b.offset - a.offset);                                     // service (nearest the reference) first
  Object.defineProperty(matches, 'ref', { value: ref });                           // file offset of the ADD that references the suffix string
  if (!(matches[0].offset < ref && ref - matches[0].offset < 0x80)) throw new Error('service-name word is not just before the suffix reference');
  return matches;
}

/**
 * The Aura fallback: when the copy's own item is missing, OSCrypt looks up the item "Aura Safe Storage" / account "Aura" (another OpenAI app's key)
 * and would use it. Both names are built next to the Codey reference:
 *   service  17 chars: the first 16 are copied from the data string (ADRP+ADD, ldr q0/str q0), the last char is an immediate:  movz wN,#'e' ; strh wN,[..]
 *   account  4 chars:  movz w8,#('A'|'u'<<8) ; movk w8,#('r'|'a'<<8),lsl 16 ; str w8,[..]
 * The data strings are shared with the browser-profile importer and are left alone; only the immediates change ('e'→'f', 'a'→'b'):
 * "Aura Safe Storagf" / "Aurb". Fails closed unless each string and its reference occurs exactly once and the instruction pattern exactly once.
 */
export function locateAuraFallback(buf, codeyRef, { service = 'Aura Safe Storage', account = 'Aura', window = 0x800 } = {}) {
  const { sections } = parseMachO(buf);
  const text = sections.find((s) => s.seg === '__TEXT' && s.name === '__text');
  const data = sections.filter((s) => s.seg === '__TEXT' && ['__cstring', '__const', '__literals'].includes(s.name));
  const addrOf = (needle, what, lead = 0) => {
    const nb = Buffer.from(needle, 'latin1'); const hits = [];
    for (const sec of data) for (let i = buf.indexOf(nb, sec.offset); i >= 0 && i + nb.length <= sec.offset + sec.size; i = buf.indexOf(nb, i + 1)) hits.push(sec.addr + (i + lead - sec.offset));
    if (hits.length !== 1) throw new Error(`${what} string occurs ${hits.length} times in __TEXT data, expected exactly 1`);
    return hits[0];
  };
  const refOf = (addr, what) => {
    const refs = findAddressRefs(buf, text, addr);
    if (refs.length !== 1) throw new Error(`${what} string is referenced from ${refs.length} places, expected exactly 1`);
    if (Math.abs(refs[0] - codeyRef) > window) throw new Error(`${what} reference is not near the Codey name code`);
    return refs[0];
  };
  const sRef = refOf(addrOf(`${service} `, 'Aura service'), 'Aura service');
  const aRef = refOf(addrOf(` ${account} `, 'Aura account', 1), 'Aura account');
  const last = service.charCodeAt(service.length - 1);
  const svc = [];
  for (let off = sRef; off < sRef + 0x40; off += 4) {
    const w = word(buf, off), nx = word(buf, off + 4);
    if (((w & 0xffe0001f) >>> 0) === ((0x52800000 | (w & 31)) >>> 0) && ((w >>> 5) & 0xffff) === last && (((nx & 0xffc0001f) >>> 0) === ((0x79000000 | (w & 31)) >>> 0))) svc.push({ offset: off, word: w, newWord: movzW(w & 31, last + 1), what: 'service' });
  }
  if (svc.length !== 1) throw new Error(`Aura service last-character immediate occurs ${svc.length} times after its reference, expected exactly 1`);
  const lo = account.charCodeAt(0) | (account.charCodeAt(1) << 8), hi = account.charCodeAt(2) | (account.charCodeAt(3) << 8);
  const acc = [];
  for (let off = aRef; off < aRef + 0x80; off += 4) {
    const w = word(buf, off), nx = word(buf, off + 4);
    if (w === movzW(8, lo) && nx === movkWlsl16(8, hi)) acc.push({ offset: off + 4, word: nx, newWord: movkWlsl16(8, (hi & 0xff) | (((hi >> 8) + 1) << 8)), what: 'account' });
  }
  if (acc.length !== 1) throw new Error(`Aura account immediates occur ${acc.length} times after their reference, expected exactly 1`);
  return [svc[0], acc[0]];
}

const hex = (w) => { const b = Buffer.alloc(4); b.writeUInt32LE(w >>> 0); return b.toString('hex'); };

/**
 * binaryPatches entries for a framework file: two chained patches over the same whole-file hash chain
 * (the second patch's sha256Before is the first's sha256After; apply in array order).
 * @param {Buffer} buf  @param {string} file path relative to Contents/
 */
export function deriveKeychainPatches(buf, file, { aura = false } = {}) {
  const [service, account] = locateKeychainName(buf);
  const steps = [['keychain-service-name', service.offset, service.word, movzW(8, service.newChar.charCodeAt(0)), `Owl OSCrypt names its Keychain service from a hard-coded "Codex" built from instruction immediates (builder/KEYCHAIN.md); the trailing 'x' (movz w8,#0x78) becomes '${service.newChar}', so the copy uses "Code${service.newChar} Storage Key" and never the stock app's item`],
    ['keychain-service-name-account', account.offset, account.word, movzW(8, account.newChar.charCodeAt(0)), `same for the Keychain account: "Code${account.newChar}" (item "Code${account.newChar} Storage Key")`]];
  if (aura) {
    const [as, aa] = locateAuraFallback(buf, locateKeychainName(buf).ref);
    steps.push(['aura-fallback-service', as.offset, as.word, as.newWord, 'R2-6: when the copy\'s own item is missing OSCrypt falls back to another OpenAI app\'s "Aura Safe Storage" item; the last character immediate becomes \'f\' ("Aura Safe Storagf"), so the fallback can never read it'],
      ['aura-fallback-account', aa.offset, aa.word, aa.newWord, 'R2-6: the fallback account "Aura" becomes "Aurb" (high byte of the second halfword immediate)']);
  }
  const out = [];
  let cur = buf; let curHash = sha256(buf);
  for (const [id, offset, w, after, justification] of steps) {
    const patch = { id, file, sha256Before: curHash, offset, before: hex(w), after: hex(after), sha256After: '', justification };
    cur = applyBinaryPatch(cur, patch, { checkAfter: false });
    patch.sha256After = sha256(cur);
    curHash = patch.sha256After;
    out.push(patch);
  }
  return out;
}

/** Apply one patch to a whole-file buffer (returns a new buffer). Fails closed on any mismatch. */
export function applyBinaryPatch(buf, p, { checkAfter = true } = {}) {
  if (sha256(buf) !== p.sha256Before) throw new Error(`binary patch ${p.id}: sha256Before mismatch for ${p.file}`);
  const before = Buffer.from(p.before, 'hex'), after = Buffer.from(p.after, 'hex');
  if (before.length !== after.length || before.length === 0) throw new Error(`binary patch ${p.id}: before/after length mismatch`);
  if (!buf.subarray(p.offset, p.offset + before.length).equals(before)) throw new Error(`binary patch ${p.id}: bytes at 0x${p.offset.toString(16)} are not the expected ${p.before}`);
  const out = Buffer.from(buf);
  after.copy(out, p.offset);
  if (checkAfter && sha256(out) !== p.sha256After) throw new Error(`binary patch ${p.id}: sha256After mismatch`);
  return out;
}

/** Apply a list of patches (same file chained) → Buffer. */
export function applyBinaryPatches(buf, patches) {
  let cur = buf;
  for (const p of patches) cur = applyBinaryPatch(cur, p);
  return cur;
}
