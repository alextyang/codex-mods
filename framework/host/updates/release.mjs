// The framework's release source (docs/design/systems.md S20, "E5 in detail"; the owner's default: git tags of the published remote):
// `dir`, a directory of release trees (development, QA), and `git`, the tags of a remote (the newest semver tag pinned to its commit, that
// commit fetched depth one into a bare cache and its tree extracted by `git archive`; non-interactive and bounded). A release tree has
// `release.json` at its root: `{version, treeHash, mods?: [{id, version, package, sha256}], supports?: [build]}` (`supports`: the Codex builds it
// says it supports, each a build or a version prefix; framework-ui.md F11). It is accepted only when it has no symlink,
// hashes to its treeHash (the installed tree's filter, recovery/support.mjs), names its version in package.json and has the loader, relay,
// builder and Host. This verifies integrity, not authenticity. Any failure to reach the source is unknown, never an update. Built-ins only.
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { frameworkTreeHash } from '../recovery/support.mjs';
import { parseVersion, compareVersions as cmpParsed } from '../packages/semver.mjs';

const compareVersions = (a, b) => cmpParsed(parseVersion(a), parseVersion(b));

const REQUIRED = ['framework/main/index.cjs', 'framework/host/main.mjs', 'loader/loader.cjs', 'relay/relay', 'builder/build.mjs', 'package.json'];
const unknown = (message) => new CodexModsError('Unavailable', message, { unknown: true });
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=20', GIT_ASKPASS: '/usr/bin/false' };

/** The installed name of a release's tree: `<version>+<8 hex of its tree hash>`, as frameworkVersionOf names a tree. */
export const versionNameOf = (release) => `${String(release.version).replace(/\+.*$/, '')}+${String(release.treeHash).slice(0, 8)}`;

/** Does a release's `supports` name this build (a build, or a version prefix of it: `26.1027` names `26.1027.30824-22943`)? Null when it says nothing. */
export function supportsBuild(supports, build) {
  if (!Array.isArray(supports)) return null;
  const b = String(build ?? '');
  return supports.some((s) => b === s || b.startsWith(`${s}.`) || b.startsWith(`${s}-`));
}

/** Newer than the running framework (semver; a `-dev` framework is offered releases only when the user checks). */
export function isNewer(release, running, { userAsked = false } = {}) {
  const r = parseVersion(String(release?.version ?? '')), cur = parseVersion(String(running ?? '').replace(/\+.*$/, ''));
  if (!r) return false;
  if (!cur) return userAsked;
  if (cur.pre && !userAsked) return false;
  return compareVersions(String(release.version), String(running).replace(/\+.*$/, '')) > 0;
}

/** A release tree accepted (see the header), with its release record. */
export async function verifyReleaseTree(dir) {
  let release;
  try { release = JSON.parse(await readFile(join(dir, 'release.json'), 'utf8')); } catch { throw new CodexModsError('Invalid', 'the release has no readable release.json'); }
  if (!parseVersion(String(release?.version ?? '')) || typeof release?.treeHash !== 'string' || !/^[0-9a-f]{64}$/.test(release.treeHash)) {
    throw new CodexModsError('Invalid', 'release.json needs a semver version and a treeHash');
  }
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new CodexModsError('Invalid', `the release has a symlink (${p.slice(dir.length + 1)}); releases are plain files`);
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') await walk(p);
    }
  };
  await walk(dir);
  for (const f of REQUIRED) if (!(await lstat(join(dir, f)).then((s) => s.isFile(), () => false))) throw new CodexModsError('Invalid', `the release lacks ${f}`);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); } catch { throw new CodexModsError('Invalid', 'the release\'s package.json cannot be read'); }
  if (String(pkg.version).replace(/\+.*$/, '') !== String(release.version)) throw new CodexModsError('Invalid', `the release says ${release.version}, its package.json ${pkg.version}`);
  const hash = await frameworkTreeHash(dir);
  if (hash !== release.treeHash) throw new CodexModsError('Invalid', `the release tree does not match its release.json (tree ${hash.slice(0, 12)}, it says ${release.treeHash.slice(0, 12)})`);
  for (const m of release.mods ?? []) {
    if (typeof m?.id !== 'string' || typeof m?.package !== 'string' || m.package.includes('..') || typeof m?.sha256 !== 'string') throw new CodexModsError('Invalid', 'release.json lists a malformed mod package');
  }
  if (release.supports !== undefined && !(Array.isArray(release.supports) && release.supports.length <= 256 && release.supports.every((b) => typeof b === 'string' && b.length > 0 && b.length <= 64))) {
    throw new CodexModsError('Invalid', 'release.json: supports must be a list of Codex builds');
  }
  return release;
}

const run = (cmd, args, { cwd, timeout = 60_000, env } = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } }, (e, stdout, stderr) => (e ? rej(Object.assign(e, { stderr: String(stderr) })) : res(String(stdout))));
});

/**
 * @param {{ kind: 'dir', path: string } | { kind: 'git', remote: string }} spec
 * @param {{ updates: string }} layout
 * @returns {{ kind: string, latest(): Promise<{ version: string, ref: string, commit?: string } | null>, fetch(r: object): Promise<{ dir: string, release: object }> }}
 */
export function createReleaseSource(spec, layout, { timeoutMs = 60_000 } = {}) {
  if (spec?.kind === 'dir') {
    return {
      kind: 'dir',
      async latest() {
        let names;
        try { names = await readdir(spec.path); } catch { throw unknown(`the release directory ${spec.path} cannot be read`); }
        const found = [];
        for (const n of names) {
          try { const r = JSON.parse(await readFile(join(spec.path, n, 'release.json'), 'utf8')); if (parseVersion(String(r.version))) found.push({ version: String(r.version), ref: join(spec.path, n) }); } catch { /* not a release */ }
        }
        found.sort((a, b) => compareVersions(b.version, a.version));
        return found[0] ?? null;
      },
      async fetch(r) { return { dir: r.ref, release: await verifyReleaseTree(r.ref) }; },
    };
  }
  if (spec?.kind === 'git') {
    const cache = join(layout.updates, 'git');
    const git = (args, o = {}) => run('git', args, { timeout: timeoutMs, env: GIT_ENV, ...o });
    return {
      kind: 'git',
      async latest() {
        let out;
        try { out = await git(['ls-remote', '--tags', spec.remote]); } catch (e) { throw unknown(`the release source cannot be reached (${String(e.stderr || e.message).trim().split('\n').at(-1)})`); }
        const tags = new Map();
        for (const line of out.split('\n')) {
          const m = /^([0-9a-f]{40})\s+refs\/tags\/(v?)(\d+\.\d+\.\d+[^\s^]*)(\^\{\})?$/.exec(line.trim());
          if (!m) continue;
          const cur = tags.get(m[3]);
          if (!cur || m[4]) tags.set(m[3], { version: m[3], ref: `refs/tags/${m[2]}${m[3]}`, commit: m[1] });   // a peeled annotated tag names its commit
        }
        const list = [...tags.values()].filter((t) => parseVersion(t.version)).sort((a, b) => compareVersions(b.version, a.version));
        return list[0] ?? null;
      },
      async fetch(r) {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        try {
          await git(['init', '--bare', '-q', cache]).catch(() => {});
          await git(['--git-dir', cache, 'fetch', '-q', '--depth', '1', spec.remote, r.commit]);
        } catch (e) { throw unknown(`the release ${r.version} cannot be fetched (${String(e.stderr || e.message).trim().split('\n').at(-1)})`); }
        const dest = join(layout.updates, 'fetched', r.commit);
        const tmp = `${dest}.tmp-${process.pid}`;
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true, mode: 0o700 });
        await new Promise((res, rej) => {
          const archive = spawn('git', ['--git-dir', cache, 'archive', '--format=tar', r.commit], { env: { ...process.env, ...GIT_ENV } });
          const tar = spawn('/usr/bin/tar', ['-x', '-C', tmp]);
          archive.stdout.pipe(tar.stdin);
          let failed = null;
          archive.once('close', (code) => { if (code !== 0) failed = new Error(`git archive exited ${code}`); });
          tar.once('close', (code) => (failed || code !== 0 ? rej(failed ?? new Error(`tar exited ${code}`)) : res()));
          archive.once('error', rej); tar.once('error', rej);
        }).catch(async (e) => { await rm(tmp, { recursive: true, force: true }); throw unknown(`the release ${r.version} cannot be extracted (${e.message})`); });
        await rm(dest, { recursive: true, force: true });
        await rename(tmp, dest);
        return { dir: dest, release: await verifyReleaseTree(dest) };
      },
    };
  }
  return { kind: 'none', async latest() { return null; }, async fetch() { throw unknown('no release source'); } };
}
