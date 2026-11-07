// Installing a mod from GitHub, and its updates (docs/design/framework-ui.md F10). Install looks up the repository's latest release, downloads its one `.codexmod` and installs it as a
// file is installed, recording where it came from. A mod from GitHub is checked again with the release check and from Check for updates: a newer signed package is downloaded, checked
// as a package (its signature among the rest) and offered with what it adds; applying it is the update operation, which asks consent for added permissions, another publisher or
// another repository, and refuses one that cannot run on this build. The packages it holds are in `updates/mods/` and go once installed or no longer offered. Node built-ins only.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CodexModsError } from '../../sdk/errors.mjs';
import { parseVersion, compareVersions } from './packages/semver.mjs';
import { permissionCovered } from './packages/manifest.mjs';
import { requiredOf } from './permissions.mjs';

const newer = (a, b) => { const x = parseVersion(String(a)), y = parseVersion(String(b)); return Boolean(x && y && compareVersions(x, y) > 0); };
/** How often a mod from GitHub is checked again on its own. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{ github: ReturnType<import('./github.mjs').createGitHub>, operations: object, packages: object, compatibility: (manifest: object) => { status: string },
 *   dir: string, log?: object }} o  `dir`: where downloaded packages wait
 */
export function createModUpdates(o) {
  const offers = new Map();   // mod id -> its offer
  const problems = new Map(); // mod id -> why its last check could not complete
  const inUse = new Set();    // packages an update reads now: never removed under it
  let checking = null;
  const drop = (file) => { if (!inUse.has(file)) void rm(file, { force: true }).catch(() => {}); };
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* the listener's own */ } } };
  const fileFor = (name) => join(o.dir, `${Date.now()}-${randomBytes(6).toString('hex')}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`);

  /** Download the latest release's package of a repository (with `mod`, the one named for it): what it is, where it is, and how GitHub names it. */
  async function fetchLatest(repo, mod) {
    const rel = await o.github.latest(repo, mod ? { mod } : {});
    await mkdir(o.dir, { recursive: true, mode: 0o700 });
    const file = fileFor(rel.asset.name);
    const { digest } = await o.github.download(rel.asset.url, file);
    return { rel, file, digest };
  }

  /** One mod from GitHub checked: an offer when its release is newer than what runs. */
  async function checkOne(r) {
    const src = r.source;
    let fetched;
    try { fetched = await fetchLatest(src.repo, src.mod); } catch (e) { problems.set(r.id, String(e?.message ?? e)); return; }
    problems.delete(r.id);
    const { rel, file, digest } = fetched;
    const dropFetched = async () => { await rm(file, { force: true }); };
    if (rel.tag === src.tag && digest === src.digest) { await dropFetched(); forget(r.id); return; }
    let pkg;
    try { pkg = await o.packages.verify(file, { digest }); } catch (e) { await dropFetched(); problems.set(r.id, `its latest release could not be checked: ${e?.message ?? e}`); return; }
    try {
      const m = pkg.manifest;
      if (m.id !== r.id) { problems.set(r.id, `its latest release is ${m.id}, not ${r.id}`); await dropFetched(); return; }
      if (!newer(m.version, r.version)) { await dropFetched(); forget(r.id); return; }
      const before = offers.get(r.id);
      if (before?.file && before.file !== file) drop(before.file);
      offers.set(r.id, {
        version: m.version, notes: rel.notes, file, github: { repo: rel.repo, repoId: rel.repoId, tag: rel.tag, digest, ...(src.mod ? { mod: src.mod } : {}) },
        addedPermissions: (m.permissions ?? []).filter((p) => !permissionCovered(p, requiredOf(r))),
        verdict: o.compatibility(m).status, publisherChange: (pkg.publisher ?? null) !== (r.publisher ?? null),
        ...(rel.repoId !== src.repoId || rel.repo.toLowerCase() !== src.repo.toLowerCase() ? { repoChange: { from: src.repo, to: rel.repo } } : {}),
      });
    } finally { await rm(pkg.dir, { recursive: true, force: true }).catch(() => {}); }
  }

  function forget(modId) {
    const was = offers.get(modId);
    if (!was) return;
    offers.delete(modId);
    drop(was.file);
  }

  return {
    /** Install a mod from `owner/repository` (with `mod`, that mod's package in a release that carries several): its operation's id. Nothing runs
     *  before consent; the package is checked as a file is, and one that is not the mod asked for is refused. */
    async install(repo, mod) {
      const { rel, file, digest } = await fetchLatest(repo, mod);
      let opId;
      try { opId = await o.operations.start({ type: 'install', source: file, github: { repo: rel.repo, repoId: rel.repoId, tag: rel.tag, digest, ...(mod ? { mod } : {}) } }); } catch (e) { await rm(file, { force: true }); throw e; }
      const sub = o.operations.subscribe((op) => { if (op.id === opId && op.outcome !== 'running') { sub.dispose(); void rm(file, { force: true }).catch(() => {}); } });
      return opId;
    },
    /** Check every mod from GitHub (one check at a time); `modIds` only those. */
    check(modIds = null) {
      checking ??= (async () => {
        try {
          for (const r of Object.values(o.operations.state().mods)) {
            if (r.source?.kind !== 'github' || r.status === 'pending-consent' || (modIds && !modIds.includes(r.id))) continue;
            await checkOne(r);
          }
          for (const id of [...offers.keys()]) if (o.operations.state().mods[id]?.source?.kind !== 'github') forget(id);
        } catch (e) { o.log?.warn?.('mod updates: the check failed', { message: String(e?.message ?? e) }); } finally { checking = null; changed(); }
      })();
      return checking;
    },
    /** What is offered for a mod, as the pages show it; null when nothing is, or when what it runs is as new (a file installed since). */
    offerOf(modId) {
      const x = offers.get(modId);
      const runs = o.operations.state().mods[modId]?.version;
      return x && runs !== undefined && newer(x.version, runs) ? { version: x.version, notes: x.notes, addedPermissions: x.addedPermissions, verdict: x.verdict, publisherChange: x.publisherChange, ...(x.repoChange ? { repoChange: x.repoChange } : {}), tag: x.github.tag } : null;
    },
    problemOf: (modId) => problems.get(modId) ?? null,
    /** What is offered, as staging takes it for a copy update (F11): each mod's package and its release. */
    held: () => [...offers].map(([id, x]) => ({ id, version: x.version, file: x.file, github: x.github })),
    /** What is offered changed. */
    onChange(fn) { listeners.add(fn); return { dispose: () => { listeners.delete(fn); } }; },
    /** Apply what is offered: the update operation, from the package checked and kept. */
    async apply(modId) {
      const x = offers.get(modId);
      if (!x) throw new CodexModsError('Invalid', `no update of ${modId} is offered: check for updates first`);
      const runs = o.operations.state().mods[modId]?.version;
      if (runs === undefined || !newer(x.version, runs)) { forget(modId); changed(); throw new CodexModsError('Invalid', `${modId} ${x.version} is not newer than what it runs; check for updates again`); }
      if (x.verdict === 'blocked') throw new CodexModsError('Incompatible', `${modId} ${x.version} cannot run on this build of Codex`);
      inUse.add(x.file);
      let opId;
      try { opId = await o.operations.start({ type: 'update', modId, source: x.file, github: x.github }); } catch (e) { inUse.delete(x.file); throw e; }
      const sub = o.operations.subscribe((op) => {
        if (op.id !== opId || op.outcome === 'running') return;
        sub.dispose();
        inUse.delete(x.file);
        // installed, or waiting for consent with the package stored: this offer, and only it, goes (a newer one found meanwhile stays)
        if (op.outcome === 'succeeded' && offers.get(modId) === x) { forget(modId); changed(); } else if (offers.get(modId) !== x) drop(x.file);
      });
      return opId;
    },
    /** Packages left from an earlier run go. */
    async sweep() {
      let names;
      try { names = await readdir(o.dir); } catch { return; }
      const held = new Set([...offers.values()].map((x) => x.file).concat([...inUse]));
      for (const n of names) if (!held.has(join(o.dir, n))) await rm(join(o.dir, n), { force: true, recursive: true }).catch(() => {});
    },
  };
}
