// Content hash of a package (contracts/manifest.d.ts PackageSignature): sha256 hex over the sorted
// "path\0sha256hex\n" lines of every file except the root signature.json. Paths compare bytewise (UTF-8).
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';

export const SIGNATURE_FILE = 'signature.json';
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** @param {{path: string, data: Buffer}[]} files */
export function contentHashOf(files) {
  const lines = files
    .filter((f) => f.path !== SIGNATURE_FILE)
    .map((f) => ({ key: Buffer.from(f.path, 'utf8'), line: `${f.path}\0${sha256Hex(f.data)}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  return createHash('sha256').update(lines.map((l) => l.line).join('')).digest('hex');
}

const SKIP_DIRS = new Set(['.git']);
const SKIP_FILES = new Set(['.DS_Store']);

/**
 * Reads a package directory into [{path, data, mode}], rejecting symlinks and special files.
 * Used by packMod and by dev-mode verification.
 */
export async function readPackageDir(root, { maxFiles = 10_000, maxBytes = 1024 * 1024 * 1024, skipDirs = SKIP_DIRS } = {}) {
  const files = [];
  let total = 0;
  async function walk(dir, prefix) {
    for (const ent of (await readdir(dir)).sort()) {
      const full = join(dir, ent);
      const rel = prefix ? `${prefix}/${ent}` : ent;
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new CodexModsError('Invalid', `${rel}: symbolic links are not allowed in a package`);
      if (st.isDirectory()) { if (!skipDirs.has(ent)) await walk(full, rel); continue; }
      if (!st.isFile()) throw new CodexModsError('Invalid', `${rel}: not a regular file`);
      if (SKIP_FILES.has(ent)) continue;
      if (files.length >= maxFiles) throw new CodexModsError('Invalid', 'package has too many files', { limit: maxFiles });
      total += st.size;
      if (total > maxBytes) throw new CodexModsError('Invalid', 'package is too large', { limit: maxBytes });
      files.push({ path: rel, data: await readFile(full), mode: st.mode & 0o777 });
    }
  }
  await walk(root, '');
  return files;
}
