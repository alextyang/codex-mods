// The store lock (contracts/host.d.ts Operations.gcStore). store/ is shared by every profile under one root, so publication
// (install/update: verify → record) and garbage collection must exclude each other across Hosts as well as inside one process.
//  - in-process: a mutex per store directory, shared by every createOperations in this process;
//  - cross-process: the file <store>/.lock, created exclusively (O_EXCL) and holding {pid, token}. A lock whose pid is dead
//    (or is our own pid while we do not hold the in-process turn, i.e. left behind by a previous incarnation) is removed, but only
//    under an atomic reaper mutex (mkdir store/.lock.reap) after re-reading and re-judging the lock.
import { open, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';

const tails = new Map(); // store dir → promise chain (the in-process mutex)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function getStoreLock(storeDir, log, { timeoutMs = 120_000, pollMs = 25, malformedGraceMs = 5_000, reapStaleMs = 30_000 } = {}) {
  const key = resolve(storeDir);
  const lockPath = join(key, '.lock');
  const reapPath = join(key, '.lock.reap');

  /** Stale = the owner process is gone, it is our own pid (a previous incarnation: this process holds the in-process turn), or the file is old garbage. */
  async function isStale(owner) {
    if (owner && Number.isInteger(owner.pid)) return owner.pid === process.pid || !alive(owner.pid);
    const st = await stat(lockPath).catch(() => null);
    return Boolean(st) && Date.now() - st.mtimeMs > malformedGraceMs;      // half-written or garbage
  }

  /**
   * Removes a stale lock. Only ever done while holding the reaper mutex (`mkdir store/.lock.reap`, atomic): the lock is re-read and
   * re-judged under the mutex, so a lock that was acquired in the meantime is never removed. A reap dir older than 30 s (a reaper that
   * died) is reclaimed. If another reaper is active we simply return and the caller loops.
   */
  async function reap() {
    try { await mkdir(reapPath, { mode: 0o700 }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await stat(reapPath).catch(() => null);
      if (st && Date.now() - st.mtimeMs > reapStaleMs) await rm(reapPath, { recursive: true, force: true });
      else await sleep(pollMs);
      return;
    }
    try {
      let raw;
      try { raw = await readFile(lockPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      let owner = null;
      try { owner = JSON.parse(raw); } catch { /* garbage */ }
      if (await isStale(owner)) {
        await rm(lockPath, { force: true });
        log?.warn?.('removed a stale store lock', { pid: owner?.pid ?? null });
      }
    } finally { await rm(reapPath, { recursive: true, force: true }); }
  }

  async function takeFileLock() {
    const deadline = Date.now() + timeoutMs;
    const token = randomBytes(8).toString('hex');
    await mkdir(key, { recursive: true, mode: 0o700 });
    for (;;) {
      if (Date.now() > deadline) throw new CodexModsError('Busy', 'the package store is locked by another Host');
      try {
        const fh = await open(lockPath, 'wx', 0o600);
        try { await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })); await fh.sync(); } finally { await fh.close(); }
        return token;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let owner = null;
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') continue; }
      if (await isStale(owner)) { await reap(); continue; }
      if (Date.now() > deadline) throw new CodexModsError('Busy', 'the package store is locked by another Host');
      await sleep(pollMs);
    }
  }

  return {
    /** Resolves with {release} once this caller owns the store. release() is idempotent. */
    async acquire() {
      const prev = tails.get(key) ?? Promise.resolve();
      let free;
      const mine = new Promise((r) => { free = r; });
      tails.set(key, prev.then(() => mine));
      await prev;
      let token;
      try { token = await takeFileLock(); } catch (e) { free(); throw e; }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(await readFile(lockPath, 'utf8').catch(() => 'null'));
            if (owner?.token === token) await rm(lockPath, { force: true });
          } finally { free(); }
        },
      };
    },
  };
}
