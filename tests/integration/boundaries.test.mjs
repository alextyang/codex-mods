// Static boundary checks: electron is required only by the loader and electron-adapter.cjs;
// nothing imports from legacy/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The renderer preload runs sandboxed in the page and may only use electron's renderer API; it is not main-process code.
const ALLOWED_ELECTRON = new Set(['loader/loader.cjs', 'framework/main/electron-adapter.cjs', 'framework/preload/preload.cjs']);
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'legacy', '.worktrees', '.tmp'].includes(name)) continue;
    const p = join(dir, name), st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (/\.(mjs|cjs|js)$/.test(name)) out.push(p);
  }
  return out;
};
const SKIP_PREFIXES = ['scripts/qa/diag/', 'scripts/qa/probe/'];   // QA diagnostics and probes are prepended to the app's loader
const ELECTRON = /require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]|import\(\s*['"]electron['"]/;
const LEGACY = /(?:from|require\(|import\()\s*['"][^'"]*legacy\//;

test('no file but the loader and electron-adapter.cjs requires electron', () => {
  const offenders = [];
  for (const f of walk(REPO)) {
    const rel = relative(REPO, f);
    if (rel.endsWith('.test.mjs') || SKIP_PREFIXES.some((x) => rel.startsWith(x))) continue;
    if (ELECTRON.test(readFileSync(f, 'utf8')) && !ALLOWED_ELECTRON.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('the allowed files really do (the check is not vacuous)', () => {
  for (const rel of ALLOWED_ELECTRON) assert.match(readFileSync(join(REPO, rel), 'utf8'), ELECTRON, rel);
});

test('nothing imports from legacy/', () => {
  const offenders = walk(REPO).filter((f) => !f.endsWith('boundaries.test.mjs') && LEGACY.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f));
  assert.deepEqual(offenders, []);
});
