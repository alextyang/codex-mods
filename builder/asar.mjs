// Minimal ASAR reader/writer (ARCHITECTURE.md §5 step 3). Node built-ins only.
//
// Format (Chromium Pickle framing): u32 4 | u32 headerPickleSize | u32 payloadSize | u32 jsonLength | json (padded to 4)
// then the file bodies. A file node is {size, offset: "<decimal string>", integrity, executable?, unpacked?}; `unpacked`
// nodes have no body in the archive and live in `<archive>.unpacked/<path>`. Offsets in real archives are NOT monotonic
// in header order (the stock build shares offsets for empty files), so the writer never relocates an unchanged file:
// it copies the original body region verbatim and appends replaced/added files after it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const BLOCK_SIZE = 4 * 1024 * 1024;
const align4 = (n) => (n + 3) & ~3;
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Electron's integrity hash for an archive: sha256 of the exact header JSON string. */
export function headerHash(headerString) {
  return createHash('sha256').update(headerString, 'utf8').digest('hex');
}

/** Integrity record for file contents, in the shape the stock archive uses. */
export function computeIntegrity(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK_SIZE) blocks.push(sha256Hex(buf.subarray(off, off + BLOCK_SIZE)));
  if (buf.length === 0) blocks.push(sha256Hex(buf));
  return { algorithm: 'SHA256', hash: sha256Hex(buf), blockSize: BLOCK_SIZE, blocks };
}

const split = (p) => String(p).replace(/^\/+/, '').split('/').filter(Boolean);
export const normalizePath = (p) => split(p).join('/');

/** Frame a header JSON string as the archive prefix. */
export function frameHeader(headerString) {
  const len = Buffer.byteLength(headerString, 'utf8');
  const padded = align4(len);
  const out = Buffer.alloc(16 + padded);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(8 + padded, 4);
  out.writeUInt32LE(4 + padded, 8);
  out.writeUInt32LE(len, 12);
  out.write(headerString, 16, 'utf8');
  return out;
}

export class AsarArchive {
  /** @param {{read:(buf:Buffer,pos:number)=>number, size:number, close:()=>void}} src */
  constructor(src, path) {
    this._src = src;
    this.path = path ?? null;
    const prefix = Buffer.alloc(16);
    if (src.read(prefix, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('Not an ASAR archive (bad prefix)');
    const pickleSize = prefix.readUInt32LE(4);
    const jsonLen = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(8) !== pickleSize - 4 || align4(jsonLen) + 8 !== pickleSize) throw new Error('Not an ASAR archive (bad header framing)');
    const json = Buffer.alloc(jsonLen);
    if (src.read(json, 16) !== jsonLen) throw new Error('Truncated ASAR header');
    this.headerString = json.toString('utf8');
    this.header = JSON.parse(this.headerString);
    this.contentOffset = 8 + pickleSize;
    this.size = src.size;
  }

  static open(path) {
    const fd = fs.openSync(path, 'r');
    const size = fs.fstatSync(fd).size;
    return new AsarArchive({
      size,
      read: (buf, pos) => fs.readSync(fd, buf, 0, buf.length, pos),
      close: () => { try { fs.closeSync(fd); } catch { /* already closed */ } },
    }, path);
  }

  static fromBuffer(buffer) {
    return new AsarArchive({
      size: buffer.length,
      read: (buf, pos) => buffer.copy(buf, 0, pos, Math.min(buffer.length, pos + buf.length)),
      close() {},
    });
  }

  close() { this._src.close(); }

  get headerSha256() { return headerHash(this.headerString); }

  /** Node for a path ('' is the root dir), or null. */
  node(p) {
    let cur = this.header;
    for (const part of split(p)) {
      if (!cur.files || !Object.hasOwn(cur.files, part)) return null;
      cur = cur.files[part];
    }
    return cur;
  }

  stat(p) {
    const n = this.node(p);
    if (!n) return null;
    if (n.files) return { type: 'directory', unpacked: n.unpacked === true };
    return { type: n.link ? 'link' : 'file', size: n.size, offset: n.offset === undefined ? null : Number(n.offset),
      unpacked: n.unpacked === true, executable: n.executable === true, integrity: n.integrity ?? null, link: n.link };
  }

  /** All file paths (posix, no leading slash), in header order. */
  list() {
    const out = [];
    (function walk(dir, prefix) {
      for (const [k, v] of Object.entries(dir.files)) {
        if (v.files) walk(v, `${prefix}${k}/`); else out.push(`${prefix}${k}`);
      }
    })(this.header, '');
    return out;
  }

  /** File contents. Unpacked files are read from `<archive>.unpacked`. */
  read(p) {
    const n = this.node(p);
    if (!n || n.files) throw new Error(`ASAR: no such file: ${p}`);
    if (n.link) throw new Error(`ASAR: links are not supported: ${p}`);
    if (n.unpacked) {
      if (!this.path) throw new Error(`ASAR: unpacked file needs an on-disk archive: ${p}`);
      return fs.readFileSync(`${this.path}.unpacked/${normalizePath(p)}`);
    }
    const buf = Buffer.alloc(n.size);
    if (n.size && this._src.read(buf, this.contentOffset + Number(n.offset)) !== n.size) throw new Error(`ASAR: truncated body: ${p}`);
    return buf;
  }

  /** Verify per-file integrity of a packed file against its header record. */
  verifyFile(p) {
    const n = this.node(p);
    const data = this.read(p);
    return !n.integrity || computeIntegrity(data).hash === n.integrity.hash;
  }

  _bodyEnd() {
    let end = 0;
    for (const p of this.list()) {
      const n = this.node(p);
      if (n.unpacked || n.link) continue;
      end = Math.max(end, Number(n.offset) + n.size);
    }
    return end;
  }
}

/**
 * Write a new archive: the original body verbatim, then replaced and added files appended.
 * `replace`/`add`: Map<path, Buffer | {data: Buffer, executable?: boolean}>. Unpacked entries cannot be replaced
 * (their bytes live outside the archive; upstream leaves `.unpacked` untouched and so do we).
 * Returns {headerString, headerSha256, size, changed}.
 */
export function writeAsar(archive, destPath, { replace = new Map(), add = new Map() } = {}) {
  const header = JSON.parse(archive.headerString);
  const at = (p) => { let c = header; for (const part of split(p)) c = c?.files?.[part]; return c; };
  const bodyEnd = Math.max(archive._bodyEnd(), archive.size - archive.contentOffset);
  const blobs = []; // {buf}
  let cursor = bodyEnd;
  const place = (data) => { const rec = { offset: String(cursor), size: data.length, integrity: computeIntegrity(data) }; blobs.push(data); cursor += data.length; return rec; };

  for (const [p, v] of [...replace.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const node = at(p);
    if (!node || node.files) throw new Error(`ASAR replace: no such file: ${p}`);
    if (node.unpacked) throw new Error(`ASAR replace: unpacked files are not supported: ${p}`);
    if (node.link) throw new Error(`ASAR replace: links are not supported: ${p}`);
    const data = Buffer.isBuffer(v) ? v : v.data;
    const rec = place(data);
    node.offset = rec.offset; node.size = rec.size; node.integrity = rec.integrity;
    if (!Buffer.isBuffer(v) && v.executable !== undefined) { if (v.executable) node.executable = true; else delete node.executable; }
  }
  for (const [p, v] of [...add.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parts = split(p);
    if (!parts.length) throw new Error('ASAR add: empty path');
    let dir = header;
    for (const part of parts.slice(0, -1)) {
      if (!dir.files[part]) dir.files[part] = { files: {} };
      dir = dir.files[part];
      if (!dir.files) throw new Error(`ASAR add: parent is a file: ${p}`);
    }
    const name = parts.at(-1);
    if (Object.hasOwn(dir.files, name)) throw new Error(`ASAR add: already exists: ${p}`);
    const data = Buffer.isBuffer(v) ? v : v.data;
    const node = { ...place(data) };
    if (!Buffer.isBuffer(v) && v.executable) node.executable = true;
    dir.files[name] = node;
  }

  const changed = blobs.length > 0;
  const headerString = changed ? JSON.stringify(header) : archive.headerString;
  const prefix = frameHeader(headerString);
  const tmp = `${destPath}.tmp-${process.pid}`;
  const out = fs.openSync(tmp, 'w', 0o644);
  try {
    let wrote = fs.writeSync(out, prefix);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let pos = 0; pos < bodyEnd;) {
      const want = Math.min(chunk.length, bodyEnd - pos);
      const got = archive._src.read(chunk.subarray(0, want), archive.contentOffset + pos);
      if (got !== want) throw new Error('ASAR write: short read from source body');
      let o = 0; while (o < got) o += fs.writeSync(out, chunk, o, got - o);
      pos += got; wrote += got;
    }
    for (const b of blobs) { let o = 0; while (o < b.length) o += fs.writeSync(out, b, o, b.length - o); wrote += b.length; }
    fs.fsyncSync(out);
    fs.closeSync(out);
    fs.renameSync(tmp, destPath);
    return { headerString, headerSha256: headerHash(headerString), size: wrote, changed };
  } catch (e) {
    try { fs.closeSync(out); } catch { /* */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
