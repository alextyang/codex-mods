// The user's PATH (graph-integrity G8.2, D4): a program a mod's session process names (`executable: 'claude'`) is found on it at each
// start, as the user's own shell would find it. A Mac app does not inherit the user's shell setup, so the PATH is read from the user's login
// shell, interactively, as the app reads its shell environment (`$SHELL -ilc`, ten seconds at most), once a minute at most; the Host's own
// PATH stands in when no shell answers.
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { EXECUTABLE_NAME } from '../packages/manifest.mjs';

const MARK = '__CODEXMODS_USER_PATH__';

/** What `shell -ilc` prints for the PATH, between marks (an interactive shell may print a greeting first). */
function fromShell(shell, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawn(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env }); }
    catch { end(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } end(null); }, timeoutMs);
    child.on('error', () => end(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.on('close', () => {
      const i = out.indexOf(MARK), j = i < 0 ? -1 : out.indexOf(MARK, i + MARK.length);
      end(j > i ? out.slice(i + MARK.length, j) : null);
    });
  });
}

/**
 * @param {{ shell?: string, timeoutMs?: number, ttlMs?: number, now?: () => number, read?: (shell: string, timeoutMs: number) => Promise<string | null>, fallback?: () => string }} [o]
 */
export function createUserPath(o = {}) {
  const timeoutMs = o.timeoutMs ?? 10000, ttlMs = o.ttlMs ?? 60000, now = o.now ?? Date.now;
  const read = o.read ?? fromShell;
  const fallback = o.fallback ?? (() => process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin');
  let cached = null;   // {path, at}
  let reading = null;
  /** The user's PATH now (read at most once a minute). */
  async function path() {
    if (cached && now() - cached.at < ttlMs) return cached.path;
    reading ??= (async () => {
      const shells = [...new Set([o.shell ?? process.env.SHELL, '/bin/zsh', '/bin/bash'].filter((s) => typeof s === 'string' && isAbsolute(s)))];
      for (const sh of shells) {
        const p = await read(sh, timeoutMs).catch(() => null);
        if (typeof p === 'string' && p.trim()) return p.trim();
      }
      return fallback();
    })().then((p) => { cached = { path: p, at: now() }; return p; }).finally(() => { reading = null; });
    return reading;
  }
  /** Where `name` is on the user's PATH (the first executable file of that name), or null. */
  async function which(name) {
    if (typeof name !== 'string' || !EXECUTABLE_NAME.test(name)) return null;
    for (const dir of (await path()).split(':')) {
      if (!dir || !isAbsolute(dir)) continue;
      const f = join(dir, name);
      try { await access(f, constants.X_OK); if ((await stat(f)).isFile()) return f; } catch { /* not here */ }
    }
    return null;
  }
  return { path, which };
}
