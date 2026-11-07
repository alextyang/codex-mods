// Finds a stock Codex/ChatGPT bundle for the tests and tools that read the app's own code (read-only, never launched, never written).
//
// Order of candidates:
//   1. CODEXMODS_STOCK_ASAR: an app.asar file or an extracted directory (a directory holds `webview/`, `vite/build/` or `.vite/build/`, `package.json`).
//   2. <repo>/.tmp/asar-<bundle>/ for the bundle asked for (the extraction a session keeps for a build the installed app no longer is; `asar-20770`).
//   3. /Applications/ChatGPT.app/Contents/Resources/app.asar (the installed stock app).
// A caller that wants one build passes `{ bundleVersion, version }`: a candidate of another build is skipped, never used. Without them the first
// candidate that exists wins.
// A whole app of one build (`locateStockApp`, for the tests that read its binaries): the installed app, else the copy a session keeps in
// <repo>/.tmp/stock-<bundle>/ChatGPT.app (`stock-21477`, kept when the installed app updated).
//
// Both kinds give the same `source` the derivers read: `{ list(prefix) → paths, read(path) → string, size(path) → bytes }` with asar paths
// (`.vite/build/main-X.js`, `webview/assets/...`), so a deriver never knows which one it has. An extraction keeps the asar's `.vite` directory as `vite`;
// the source maps it back.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './asar.mjs';
import { sourceFromAsar } from './derive.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INSTALLED_APP = '/Applications/ChatGPT.app';
export const INSTALLED_ASAR = `${INSTALLED_APP}/Contents/Resources/app.asar`;

/** A source over an extracted app.asar directory. The asar's `.vite` directory may be kept as `.vite` or renamed `vite` (extractions made by tools that skip dot directories). */
export function sourceFromDir(dir) {
  const dotted = existsSync(join(dir, '.vite'));
  const real = (p) => join(dir, dotted ? p : p.replace(/^\.vite\//, 'vite/'));
  let all = null;
  const files = () => {
    if (all) return all;
    all = existsSync(join(dir, 'package.json')) ? ['package.json'] : [];
    for (const f of readdirSync(dir, { recursive: true })) {
      const rel = String(f);
      if (!/^(\.vite|vite|webview)\//.test(rel) || !statSync(join(dir, rel)).isFile()) continue;
      all.push(rel.replace(/^vite\//, '.vite/'));
    }
    return all;
  };
  return { list: (prefix) => files().filter((p) => p.startsWith(prefix)), read: (p) => readFileSync(real(p), 'utf8'), size: (p) => statSync(real(p)).size };
}

function openCandidate(path) {
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).isDirectory()) {
      const source = sourceFromDir(path);
      return { kind: 'dir', path, source, pkg: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')), close() {} };
    }
    const asar = openAsar(path);
    const source = sourceFromAsar(asar);
    return { kind: 'asar', path, source, asar, pkg: JSON.parse(asar.read('package.json').toString('utf8')), close: () => asar.close() };
  } catch { return null; }
}

/** Candidate paths in order. `bundleVersion` selects the `.tmp/asar-<bundle>` extraction. */
export function stockCandidates({ bundleVersion, env = process.env, repo = REPO, installed = INSTALLED_ASAR } = {}) {
  return [env.CODEXMODS_STOCK_ASAR, bundleVersion ? join(repo, '.tmp', `asar-${bundleVersion}`) : null, installed].filter(Boolean);
}

/**
 * The first candidate that is the build asked for, opened; null when there is none.
 * `{ path, kind: 'asar' | 'dir', source, pkg, asar?, close() }`. `asar` (the reader with header hash) exists only for a real app.asar.
 */
export function locateStock({ bundleVersion, version, ...rest } = {}) {
  for (const path of stockCandidates({ bundleVersion, ...rest })) {
    const c = openCandidate(path);
    if (!c) continue;
    const okBundle = bundleVersion === undefined || c.pkg.codexBuildNumber === undefined || String(c.pkg.codexBuildNumber) === String(bundleVersion);   // a package.json without a build number is judged by its version
    const okVersion = version === undefined || c.pkg.version === version;
    if (okBundle && okVersion) return c;
    c.close();
  }
  return null;
}

/** The path of a whole app of exactly `bundleVersion` (its Info.plist's CFBundleVersion): the installed one, else the kept copy; null when none is. */
export function locateStockApp({ bundleVersion, repo = REPO, installed = INSTALLED_APP } = {}) {
  for (const app of [installed, join(repo, '.tmp', `stock-${bundleVersion}`, 'ChatGPT.app')]) {
    const plist = join(app, 'Contents', 'Info.plist');
    if (!existsSync(plist)) continue;
    const v = spawnSync('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist], { encoding: 'utf8' });
    if (v.status === 0 && v.stdout.trim() === String(bundleVersion)) return app;
  }
  return null;
}
