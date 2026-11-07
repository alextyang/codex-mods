// Test helpers shared by the packages and ops tests (not a test file): fixture mods, real signed packages, temp roots.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { keygen, packMod } from './pack.mjs';

export async function tempRoot(prefix = 'codexmods-ops-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  // A file written as the remove walks the tree (a journal write at an operation's end) makes rmdir fail with ENOTEMPTY: try again.
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** Writes a mod source directory and returns its path. `files` overrides/extends the default files. */
export async function writeModDir(base, manifest, files = {}) {
  const dir = join(base, `src-${manifest.id}-${manifest.version}-${Math.random().toString(36).slice(2, 8)}`);
  const all = { 'mod.json': JSON.stringify(manifest, null, 2), 'host.js': 'export default {};\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, rel.startsWith('bin/') ? { mode: 0o755 } : undefined);
  }
  return dir;
}

export const baseManifest = (over = {}) => ({
  id: 'test.alpha', version: '1.0.0', name: 'Alpha', framework: '>=1 <2', entry: { host: 'host.js' }, ...over,
});

/** Builds a signed .codexmod from a manifest; returns {archive, publisher, manifest}. */
export async function buildSigned(base, manifest, key, files = {}) {
  const dir = await writeModDir(base, manifest, files);
  const archive = join(base, `${manifest.id}-${manifest.version}-${Math.random().toString(36).slice(2, 8)}.codexmod`);
  const r = await packMod(dir, key.privateKeyPem, archive);
  return { archive, dir, publisher: r.publisher, contentHash: r.contentHash };
}

export { keygen };
