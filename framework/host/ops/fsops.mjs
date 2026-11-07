// Filesystem helpers for lifecycle operations: APFS clone with copy fallback, existence checks, directory replacement.
import { execFile } from 'node:child_process';
import { mkdir, rm, rename, stat, cp } from 'node:fs/promises';
import { dirname } from 'node:path';

export const exists = (p) => stat(p).then(() => true, () => false);
export const rmrf = (p) => rm(p, { recursive: true, force: true });
export const ensureDir = (p) => mkdir(p, { recursive: true, mode: 0o700 });

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10 * 60_000 }, (err, _out, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve()));
});

/**
 * Copies src → dst (dst must not exist). Tries `cp -c -R` (APFS clonefile, copy-on-write) and falls back to a recursive copy.
 * `cpPath` is injectable so tests can force the fallback.
 * @returns {Promise<'clone'|'copy'>} how the copy was made
 */
export async function cloneDir(src, dst, { cpPath = '/bin/cp' } = {}) {
  await ensureDir(dirname(dst));
  try {
    await run(cpPath, ['-c', '-R', src, dst]);
    return 'clone';
  } catch {
    await rmrf(dst); // drop any partial result of the failed clone
    await cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    return 'copy';
  }
}

/** Replaces `live` with `staged` (a sibling prepared elsewhere on the same volume). Not atomic: callers keep a backup. */
export async function replaceDir(live, staged) {
  await rmrf(live);
  await rename(staged, live);
}
