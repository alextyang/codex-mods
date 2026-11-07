// Package verification, the content-addressed store and manifest/settings validation (ARCHITECTURE §7.1, §10, §11, §13).
// createPackages({layout, log, frameworkVersion}) implements contracts/host.d.ts `Packages`.
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, sep } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { newId } from '../fsutil.mjs';
import { readZip } from '../../shared/zip.mjs';
import { validateManifest, referencedFiles, mediaOf, MEDIA_MAX_BYTES, MEDIA_TOTAL_BYTES } from './manifest.mjs';
import { satisfies } from './semver.mjs';
import { contentHashOf, readPackageDir, SIGNATURE_FILE } from './hash.mjs';
import { verifyContentHash } from './pack.mjs';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const STAGING = '.staging';
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

const invalid = (msg, details) => new CodexModsError('Invalid', msg, details);

/**
 * Names the real cause of a filesystem failure. A missing path is the caller's mistake (Invalid); anything else (EACCES/EPERM on a
 * removable volume or an app-sandboxed Host, EIO, ...) is the environment's (Unavailable) and must never read as "file not found".
 */
function fsFailure(e, path) {
  if (e instanceof CodexModsError) return e;
  const at = e?.path ?? path;
  if (e?.code === 'ENOENT') return invalid(`${at}: no such file or directory`, { path: at });
  if (e?.code === 'ENOTDIR') return invalid(`${at}: not a directory`, { path: at });
  return new CodexModsError('Unavailable', `cannot read ${at}: ${e?.code ?? e?.message ?? e}`, { path: at, errno: e?.code ?? null });
}

export function createPackages({ layout, log, frameworkVersion }) {
  const stagingRoot = join(layout.store, STAGING);

  function parseManifestBytes(bytes) {
    if (bytes.length > MAX_MANIFEST_BYTES) throw invalid('mod.json: larger than 1 MiB');
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch (e) { throw invalid(`mod.json: not valid JSON (${e.message})`); }
    return validateManifest(parsed);
  }

  /** `target`: the framework the mod will run on (an update's, docs/design/systems.md E5), by default this one. */
  function checkFramework(manifest, target = frameworkVersion) {
    if (!satisfies(target, manifest.framework)) {
      throw new CodexModsError('Incompatible', `framework: requires ${manifest.framework}, ${target === frameworkVersion ? 'this is' : 'it would run on'} ${target}`, { required: manifest.framework, actual: target });
    }
  }

  function checkReferenced(manifest, isFile) {
    for (const [at, rel] of referencedFiles(manifest)) if (!isFile(rel)) throw invalid(`${at}: file not found in package`);
  }

  /** A mod's media is bounded each and together (framework-ui.md F6). */
  function checkMedia(manifest, sizeOf) {
    let total = 0;
    mediaOf(manifest).forEach((x, i) => {
      const n = sizeOf(x.src);
      if (n > MEDIA_MAX_BYTES) throw invalid(`media[${i}].src: larger than 1 MiB`);
      total += n;
    });
    if (total > MEDIA_TOTAL_BYTES) throw invalid('media: larger than 8 MiB together');
  }

  async function verifyDir(source, target) {
    const dir = resolve(source);
    let st;
    try { st = await stat(dir); } catch (e) {            // stat follows a symlinked directory
      throw e?.code === 'ENOENT' ? invalid(`source: ${source} does not exist`) : fsFailure(e, dir);
    }
    if (!st.isDirectory()) throw invalid(`source: ${source} is not a directory (developer mode loads a directory)`);
    let bytes;
    try { bytes = await readFile(join(dir, 'mod.json')); } catch (e) {
      throw e?.code === 'ENOENT' ? invalid(`mod.json missing in ${dir}`) : fsFailure(e, join(dir, 'mod.json'));
    }
    const manifest = parseManifestBytes(bytes);
    let files;
    try { files = await readPackageDir(dir, { skipDirs: new Set(['.git', 'node_modules']) }); } catch (e) { throw fsFailure(e, dir); }
    const present = new Set(files.map((f) => f.path));
    checkReferenced(manifest, (rel) => present.has(rel));
    checkMedia(manifest, (rel) => files.find((f) => f.path === rel)?.data.length ?? 0);
    checkFramework(manifest, target);
    return { manifest, dir, contentHash: contentHashOf(files), publisher: null };
  }

  async function verifyArchive(source, target, digest) {
    const file = resolve(source);
    let st;
    try { st = await stat(file); } catch (e) { throw e?.code === 'ENOENT' ? invalid(`source: ${source} does not exist`) : fsFailure(e, file); }
    if (st.isDirectory()) throw invalid('source: a directory can only be loaded in developer mode');
    if (!st.isFile()) throw invalid('source: .codexmod archive must be a regular file');
    if (st.size > MAX_ARCHIVE_BYTES) throw invalid('source: archive size limit exceeded', { size: st.size, limit: MAX_ARCHIVE_BYTES });
    let bytes;
    try { bytes = await readFile(file); } catch (e) { throw fsFailure(e, file); }
    // F10: the package found (a GitHub release's, by its sha256) is the one these checks read, not one put in its place since
    if (digest !== undefined && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new CodexModsError('Denied', 'the package is not the one that was found: its digest changed');
    const entries = readZip(bytes).filter((e) => !e.directory);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const modJson = byPath.get('mod.json');
    if (!modJson) throw invalid('mod.json: file not found in package');
    const manifest = parseManifestBytes(modJson.data);
    if (!manifest.publisher) throw new CodexModsError('Denied', 'publisher: package is not signed (no publisher key in mod.json)');
    const sigEntry = byPath.get(SIGNATURE_FILE);
    if (!sigEntry) throw new CodexModsError('Denied', 'signature.json: package is not signed');
    let sig;
    try { sig = JSON.parse(sigEntry.data.toString('utf8')); } catch { throw new CodexModsError('Denied', 'signature.json: not valid JSON'); }
    if (typeof sig?.contentHash !== 'string' || typeof sig?.signature !== 'string') throw new CodexModsError('Denied', 'signature.json: malformed');
    const contentHash = contentHashOf(entries);
    if (contentHash !== sig.contentHash) throw new CodexModsError('Denied', 'content hash does not match the package files (the package was modified)');
    if (!verifyContentHash(contentHash, sig.signature, manifest.publisher)) {
      throw new CodexModsError('Denied', 'signature does not verify against the publisher key');
    }
    checkReferenced(manifest, (rel) => byPath.has(rel));
    checkMedia(manifest, (rel) => byPath.get(rel)?.data.length ?? 0);
    checkFramework(manifest, target);

    const dir = join(stagingRoot, newId('pkg'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      for (const e of entries) {
        const target = join(dir, ...e.path.split('/'));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, e.data, { mode: e.mode & 0o111 ? 0o700 : 0o600, flag: 'wx' });
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { manifest, dir, contentHash, publisher: manifest.publisher };
  }

  async function storedHash(dir) {
    return contentHashOf(await readPackageDir(dir));
  }

  return {
    async verify(source, opts = {}) {
      if (typeof source !== 'string' || !source) throw invalid('source: must be a path');
      if (opts.dev && opts.digest !== undefined) throw invalid('a folder has no digest: a package found on GitHub is a file');
      return opts.dev ? verifyDir(source, opts.frameworkVersion) : verifyArchive(source, opts.frameworkVersion, opts.digest);
    },

    validateManifest,

    async store(pkg) {
      if (pkg.publisher === null) return pkg.dir; // developer packages are loaded in place, never stored
      const staged = resolve(pkg.dir);
      if (!staged.startsWith(stagingRoot + sep)) throw invalid('package: not a staged package');
      const dest = join(layout.store, pkg.manifest.id, pkg.manifest.version);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const sameAsStored = async () => (await storedHash(dest)) === pkg.contentHash;
      const existing = await stat(dest).then(() => true, () => false);
      if (existing) {
        if (!(await sameAsStored())) throw new CodexModsError('Conflict', `${pkg.manifest.id}@${pkg.manifest.version} is already stored with different content; publishing changed content under an existing version is not allowed, bump the version`);
        await rm(staged, { recursive: true, force: true });
        return dest;
      }
      try { await rename(staged, dest); } catch (e) {
        if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
          if (!(await sameAsStored())) throw new CodexModsError('Conflict', `${pkg.manifest.id}@${pkg.manifest.version} is already stored with different content; publishing changed content under an existing version is not allowed, bump the version`);
          await rm(staged, { recursive: true, force: true });
          return dest;
        }
        throw e;
      }
      return dest;
    },

    async gc(keepVersions) {
      let ids;
      try { ids = await readdir(layout.store); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const id of ids) {
        if (id === STAGING) {
          for (const name of await readdir(stagingRoot).catch(() => [])) {
            const p = join(stagingRoot, name);
            const st = await stat(p).catch(() => null);
            if (st && Date.now() - st.mtimeMs > STAGING_MAX_AGE_MS) await rm(p, { recursive: true, force: true });
          }
          continue;
        }
        if (id.startsWith('.')) continue;
        const keep = new Set(keepVersions(id));
        const dir = join(layout.store, id);
        const versions = await readdir(dir).catch(() => []);
        for (const v of versions) if (!keep.has(v)) { await rm(join(dir, v), { recursive: true, force: true }); log.info('store gc', { modId: id, version: v }); }
        if (!(await readdir(dir).catch(() => ['x'])).length) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
