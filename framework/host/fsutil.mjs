// Shared filesystem helpers. Every persistent JSON write in the Host goes through writeJsonAtomic.
import { open, rename, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** temp file → fsync → rename → fsync dir. Creates parent dirs (mode 0700). */
export async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'w', mode);
  try { await fh.writeFile(JSON.stringify(value, null, 2) + '\n'); await fh.sync(); } finally { await fh.close(); }
  try { await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }); throw e; }
  const dh = await open(dir, 'r');
  try { await dh.sync(); } finally { await dh.close(); }
}

/** Returns fallback when the file does not exist; throws on malformed JSON. */
export async function readJson(path, fallback = undefined) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}-${randomBytes(8).toString('hex')}`;
