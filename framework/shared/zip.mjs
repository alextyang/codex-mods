// Minimal ZIP reader/writer for .codexmod archives (ARCHITECTURE §7.1, §13). Node built-ins only.
//
// readZip(buffer, limits)  → entries [{path, directory, mode, data}] (stored and deflate; limits enforced; hostile input rejected)
// writeZip(entries)        → Buffer (stored-only, CRC32, deterministic timestamps)
//
// Both sides reject absolute paths, '..' segments, backslashes, symlinks, special files and duplicate names
// (also names that collide after Unicode/case folding, because APFS is case-insensitive).
// Derived from the earlier codexmod archive reader (reader limits and checks), adapted to CodexModsError.
import { inflateRawSync, crc32 } from 'node:zlib';
import { CodexModsError } from '../../sdk/errors.mjs';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
// 2000-01-01 00:00:00 in DOS format, fixed so identical inputs give identical archives.
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
});

const bad = (message, details) => new CodexModsError('Invalid', message, details);

/** Validates an archive entry name. Returns {path, directory} with a trailing slash removed. */
export function normalizeEntryPath(raw) {
  if (typeof raw !== 'string' || raw === '') throw bad('unsafe ZIP entry path: <empty>');
  if (raw.includes('\\') || raw.includes('\u0000')) throw bad(`unsafe ZIP entry path: ${JSON.stringify(raw)}`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw bad(`absolute ZIP entry path is forbidden: ${raw}`);
  const directory = raw.endsWith('/');
  const bare = (directory ? raw.slice(0, -1) : raw).normalize('NFC');
  if (!bare) throw bad('ZIP root directory entries are not allowed');
  for (const part of bare.split('/')) {
    if (part === '' || part === '.' || part === '..') throw bad(`ZIP entry path escapes the package: ${raw}`);
  }
  return { path: bare, directory };
}

const foldName = (p) => p.normalize('NFKC').toLocaleLowerCase('en-US');

// ------------------------------------------------------------------ reader
function ensureRange(buffer, offset, length, label) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw bad(`invalid ZIP ${label} range`, { offset, length, archiveBytes: buffer.length });
  }
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) !== EOCD) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw bad('ZIP end-of-central-directory record was not found');
}

function decodeName(bytes, utf8) {
  const value = bytes.toString(utf8 ? 'utf8' : 'latin1');
  if (value.includes('\u0000') || value.includes('�')) throw bad('ZIP entry name is not valid text');
  return value;
}

function unixMode(versionMadeBy, externalAttributes, directory) {
  const host = versionMadeBy >>> 8;
  if (host !== 3) return directory ? 0o755 : 0o644;
  const raw = (externalAttributes >>> 16) & 0xffff;
  const type = raw & S_IFMT;
  if (type === S_IFLNK) throw bad('symbolic links are forbidden in .codexmod archives');
  if (type && type !== S_IFREG && type !== S_IFDIR) throw bad('special files are forbidden in .codexmod archives', { mode: raw });
  if (directory && type === S_IFREG) throw bad('ZIP directory has a regular-file mode');
  if (!directory && type === S_IFDIR) throw bad('ZIP file has a directory mode');
  return (raw & 0o777) || (directory ? 0o755 : 0o644);
}

function parseCentral(buffer, limits) {
  const eocd = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const onDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count) throw bad('multi-disk ZIP archives are not supported');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw bad('ZIP64 archives are not supported');
  if (count > limits.maxEntries) throw bad('ZIP entry limit exceeded', { entryCount: count, limit: limits.maxEntries });
  ensureRange(buffer, centralOffset, centralSize, 'central directory');
  if (centralOffset + centralSize > eocd) throw bad('ZIP central directory overlaps the EOCD');

  const entries = [];
  const exact = new Set();
  const folded = new Set();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    ensureRange(buffer, offset, 46, 'central header');
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw bad('invalid ZIP central-directory signature', { index });
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x1) throw bad('encrypted ZIP entries are not supported');
    if (method !== 0 && method !== 8) throw bad(`unsupported ZIP compression method: ${method}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw bad('ZIP64 entries are not supported');
    const variable = nameLength + extraLength + commentLength;
    ensureRange(buffer, offset + 46, variable, 'central entry');
    const rawName = decodeName(buffer.subarray(offset + 46, offset + 46 + nameLength), Boolean(flags & 0x800));
    const { path, directory } = normalizeEntryPath(rawName);
    const fold = foldName(path);
    if (exact.has(path) || folded.has(fold)) throw bad(`duplicate or case-colliding ZIP entry: ${path}`);
    exact.add(path); folded.add(fold);
    const mode = unixMode(versionMadeBy, externalAttributes, directory);
    if (uncompressedSize > limits.maxFileBytes) throw bad(`ZIP entry exceeds the per-file limit: ${path}`, { uncompressedSize, limit: limits.maxFileBytes });
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) throw bad('ZIP expanded-size limit exceeded', { totalBytes: total, limit: limits.maxTotalBytes });
    if (!directory && compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw bad(`ZIP compression ratio is suspicious: ${path}`, { compressedSize, uncompressedSize, limit: limits.maxCompressionRatio });
    }
    entries.push({ rawName, path, directory, method, expectedCrc, compressedSize, uncompressedSize, localOffset, mode });
    offset += 46 + variable;
  }
  if (offset !== centralOffset + centralSize) throw bad('ZIP central-directory length does not match its entries');
  return entries;
}

function entryBytes(buffer, entry) {
  ensureRange(buffer, entry.localOffset, 30, 'local header');
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL) throw bad(`invalid ZIP local header: ${entry.path}`);
  const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
  const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  if ((localFlags & 0x1) || localMethod !== entry.method) throw bad(`ZIP local header disagrees with central directory: ${entry.path}`);
  ensureRange(buffer, entry.localOffset + 30, nameLength + extraLength, 'local entry metadata');
  const localName = decodeName(buffer.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength), Boolean(localFlags & 0x800));
  if (localName !== entry.rawName) throw bad(`ZIP local entry name mismatch: ${entry.path}`);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  ensureRange(buffer, dataOffset, entry.compressedSize, 'compressed entry');
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  let out;
  try {
    out = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch (cause) {
    throw bad(`cannot decompress ZIP entry: ${entry.path}`, { cause: String(cause?.message ?? cause) });
  }
  if (out.length !== entry.uncompressedSize) throw bad(`ZIP entry size mismatch: ${entry.path}`, { expected: entry.uncompressedSize, actual: out.length });
  if (crc32(out) !== entry.expectedCrc) throw bad(`ZIP entry CRC mismatch: ${entry.path}`);
  return out;
}

/**
 * @param {Buffer} buffer
 * @param {Partial<typeof DEFAULT_ZIP_LIMITS>} [limits]
 * @returns {{path: string, directory: boolean, mode: number, data: Buffer}[]}
 */
export function readZip(buffer, limits = {}) {
  const policy = { ...DEFAULT_ZIP_LIMITS, ...limits };
  if (!Buffer.isBuffer(buffer)) throw bad('ZIP input must be a Buffer');
  if (buffer.length > policy.maxArchiveBytes) throw bad('.codexmod archive size limit exceeded', { size: buffer.length, limit: policy.maxArchiveBytes });
  if (buffer.length < 22) throw bad('ZIP end-of-central-directory record was not found');
  return parseCentral(buffer, policy).map((e) => ({
    path: e.path, directory: e.directory, mode: e.mode, data: e.directory ? Buffer.alloc(0) : entryBytes(buffer, e),
  }));
}

// ------------------------------------------------------------------ writer
/**
 * @param {{path: string, data?: Buffer|string, mode?: number, directory?: boolean, symlink?: boolean}[]} entries
 * @returns {Buffer} a stored-only (method 0) ZIP
 */
export function writeZip(entries) {
  if (!Array.isArray(entries)) throw bad('writeZip needs an entries array');
  if (entries.length >= 0xffff) throw bad('too many ZIP entries');
  const exact = new Set();
  const folded = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.symlink || ((entry.mode ?? 0) & S_IFMT) === S_IFLNK) throw bad(`symbolic links are forbidden in .codexmod archives: ${entry.path}`);
    const { path, directory } = normalizeEntryPath(entry.directory && !String(entry.path).endsWith('/') ? `${entry.path}/` : entry.path);
    const fold = foldName(path);
    if (exact.has(path) || folded.has(fold)) throw bad(`duplicate or case-colliding ZIP entry: ${path}`);
    exact.add(path); folded.add(fold);
    const data = directory ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    if (data.length >= 0xffffffff) throw bad(`ZIP entry too large: ${path}`);
    const perms = (entry.mode ?? (directory ? 0o755 : 0o644)) & 0o777;
    const external = (((directory ? S_IFDIR : S_IFREG) | perms) << 16) >>> 0;
    const name = Buffer.from(directory ? `${path}/` : path, 'utf8');
    const crc = directory ? 0 : crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(external, 38); central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
    if (offset >= 0xffffffff) throw bad('ZIP archive too large');
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
