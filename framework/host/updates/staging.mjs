// Staging an update in quarantine (docs/design/systems.md S19, "E5 in detail"): a background job, not an Operation. From an offer (a stock
// build, a framework release, the mods' packages in it) it makes a plan: a snapshot of the stock app; the release's tree, verified, under
// the root's updates/framework/; the pack (the new tree's, the root's, or a refresh by the new tree's own tool); the evidence and its
// evaluation with the new framework's log; the candidate built from the snapshot by the new framework's builder with this copy's build
// flags; each enabled mod's compatibility at its current and its incoming version; the plan, written last. A framework operation preempts
// it (`cancel`: the builder's process group is killed; the job stops between steps); a restart finds only what was finished. Built-ins only.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { readJson } from '../fsutil.mjs';
import { layout as layoutOf } from '../../../contracts/layout.mjs';
import { buildCandidate, buildFlagsOf, readLinkAbs, readText, refreshInChild, runBuilderProcess } from '../recovery/support.mjs';
import { evidenceFor } from '../features/evidence.mjs';
import { evaluate, affected } from '../features/status.mjs';
import { computeCompatibility, featureTitle } from '../ops/compat.mjs';
import { permissionCovered } from '../packages/manifest.mjs';
import { requiredOf } from '../permissions.mjs';
import { snapshotStock, sha256File } from './stock.mjs';
import { verifyReleaseTree, versionNameOf } from './release.mjs';
import { parseVersion, compareVersions } from '../packages/semver.mjs';
import { planDir, planHashOf } from './plan.mjs';

const exists = (p) => stat(p).then(() => true, () => false);
const count = (o) => Object.values(o ?? {}).reduce((a, x) => { a[x.status] = (a[x.status] ?? 0) + 1; return a; }, {});

/**
 * @param {{ layout: object, log: object, frameworkVersion: string, adapter: object, recovery: object, packages: object,
 *   operations: () => object, features?: object, source?: object, clone?: Function, onStep?: (step: string) => void,
 *   modOffers?: () => { id: string, version: string, file: string, github: object }[] }} o
 *   `onStep`: each step as it begins (the Update page follows them); `modOffers`: the mods' updates found on GitHub (mod-updates.mjs), candidates too
 */
/**
 * What older plans held, once a newer plan is complete (docs/design/systems.md "E5 in detail"): this profile's other plans, then the stock
 * snapshots, staged framework trees and the older plans' candidates that nothing still names. The root's snapshots, trees and candidates
 * are every profile's, so what any profile's plan, boot record (generation), stable path or last-known-good names stays, and so does a
 * candidate the copy uses (`inUse`: the running copy). A staging's temporary directories are `cleanup`'s. Staging and an apply never run
 * at once in one profile (an update preempts staging); another profile's apply works from its own plan, which stays named; while another
 * profile stages (its lease), the shared files are left for the next complete plan.
 */
const LEASE_MS = 6 * 60 * 60_000;   // a staging's lease older than this is a crash's leftover
const leaseDir = (L) => join(L.updates, 'leases');
/** While a profile stages, its lease says so (its pid and when): another profile's retention then leaves the root's shared files alone. */
async function takeLease(L) {
  await mkdir(leaseDir(L), { recursive: true, mode: 0o700 });
  await writeFile(join(leaseDir(L), `${L.profile}.json`), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 });
}
const dropLease = (L) => rm(join(leaseDir(L), `${L.profile}.json`), { force: true }).catch(() => {});
/** Does another profile stage now (a fresh lease whose process lives)? */
async function othersStaging(L) {
  let names;
  try { names = await readdir(leaseDir(L)); } catch { return false; }
  for (const n of names) {
    if (!n.endsWith('.json') || n === `${L.profile}.json`) continue;
    const x = await readJson(join(leaseDir(L), n), null);
    if (!Number.isSafeInteger(x?.pid) || !(Date.now() - x.at < LEASE_MS)) continue;
    try { process.kill(x.pid, 0); return true; } catch (e) { if (e?.code === 'EPERM') return true; }
  }
  return false;
}

export async function pruneOlder(L, plan, inUse) {
  const apps = resolve(L.apps);
  const list = async (dir) => { try { return await readdir(dir); } catch { return []; } };
  const appDir = (p) => (typeof p === 'string' && p ? dirname(p) : null);
  // the mods' packages kept with a plan (a GitHub release's, F11) that the new plan does not name
  const keep = new Set((plan.enabled ?? []).map((m) => m.incoming?.package).filter(Boolean).map((p) => resolve(p)));
  for (const n of await list(join(L.profileUpdates, 'packages'))) if (!keep.has(resolve(join(L.profileUpdates, 'packages', n)))) await rm(join(L.profileUpdates, 'packages', n), { force: true });
  // this profile's older plans go first; their candidates are looked at below
  const gone = [];
  for (const n of await list(L.profileUpdates)) {
    if (!/^[0-9a-f]{32}$/.test(n) || n === plan.hash) continue;
    const old = await readJson(join(L.profileUpdates, n, 'plan.json'), null);
    if (old) gone.push(old);
    await rm(join(L.profileUpdates, n), { recursive: true, force: true });
  }
  // what every profile still names
  const named = new Set();
  const name = (p) => { if (typeof p === 'string' && p) named.add(resolve(p)); };
  for (const profile of await list(join(L.root, 'profiles'))) {
    const P = layoutOf(L.root, profile);
    for (const n of await list(P.profileUpdates)) {
      if (!/^[0-9a-f]{32}$/.test(n)) continue;
      const x = await readJson(join(P.profileUpdates, n, 'plan.json'), null);
      name(x?.stock?.snapshot && dirname(x.stock.snapshot)); name(x?.framework?.dir); name(appDir(x?.candidate?.path));
    }
    for (const n of await list(P.generations)) if (n.endsWith('.json')) name(appDir((await readJson(join(P.generations, n), null))?.appCandidate));
    const profileJson = await readJson(P.profileConfig, null);
    if (typeof profileJson?.appPath === 'string') { try { name(dirname(readLinkAbs(profileJson.appPath))); } catch { /* no stable path yet */ } }
    name(appDir(await readText(P.lkgApp).then((t) => t?.trim() || null, () => null)));
  }
  // another profile stages now: its snapshot and tree are not named by a plan yet, so the shared files wait for the next complete plan
  if (await othersStaging(L)) return;
  for (const old of gone) {
    const app = appDir(old?.candidate?.path);
    if (app && resolve(app).startsWith(apps + '/') && !named.has(resolve(app)) && !(inUse && await inUse(app))) await rm(app, { recursive: true, force: true });
  }
  for (const base of [join(L.updates, 'stock'), join(L.updates, 'framework')]) {
    for (const n of await list(base)) if (!n.includes('.tmp-') && !named.has(resolve(join(base, n)))) await rm(join(base, n), { recursive: true, force: true });
  }
}

export function createStaging(o) {
  const log = o.log ?? { info() {}, warn() {} };
  let job = null;

  class Cancelled extends Error {}
  const check = () => { if (job?.cancelled) throw new Cancelled('staging was preempted'); };
  const step = (name) => { check(); job.step = name; log.info('staging', { offer: job.offer.id, step: name }); try { o.onStep?.(name); } catch { /* the listener's own */ } };

  async function stage(offer) {
    if (job) throw new CodexModsError('Conflict', 'staging already runs');
    job = { offer, step: 'start', startedAt: Date.now(), cancelled: false, children: new Set() };
    try { await takeLease(o.layout); return await run(offer); } catch (e) {
      // cancelled: whatever the step it stopped says (a builder killed fails as it dies), it is a cancel, not a problem (F11: Cancel means later)
      if (e instanceof Cancelled || job.cancelled) return { cancelled: true };
      const problem = String(e?.message ?? e);
      log.warn('staging failed', { offer: offer.id, step: job.step, problem });
      return { problem, unknown: !!e?.details?.unknown, step: job.step, ...(e?.code ? { code: e.code } : {}) };
    } finally { job = null; await dropLease(o.layout); }
  }

  async function run(offer) {
    const L = o.layout;
    const tools = o.recovery.update.tools();
    const profile = (await readJson(L.profileConfig, null)) ?? {};
    // 1. a snapshot of the stock app
    step('snapshot');
    const snap = await snapshotStock(L, offer.stock?.app ?? tools.stockApp, ...(o.clone ? [{ clone: o.clone }] : []));
    // 2. the release's tree, verified and staged
    let fw = null, frameworkDir = tools.frameworkDir, release = null;
    if (offer.release) {
      step('framework');
      const fetched = await o.source.fetch(offer.release);
      release = fetched.release;
      const name = versionNameOf(release);
      const staged = join(L.updates, 'framework', name);
      if (!(await exists(staged))) {
        const tmp = `${staged}.tmp-${process.pid}`;
        await rm(tmp, { recursive: true, force: true });
        await mkdir(join(L.updates, 'framework'), { recursive: true, mode: 0o700 });
        await new Promise((res, rej) => { const c = spawn('/bin/cp', ['-c', '-R', fetched.dir, tmp]); c.once('close', (code) => (code === 0 ? res() : rej(new Error(`cp exited ${code}`)))); c.once('error', rej); });
        await verifyReleaseTree(tmp);
        await rename(tmp, staged);
      }
      await verifyReleaseTree(staged);
      fw = { from: o.frameworkVersion, to: name, treeHash: release.treeHash, dir: staged, ...(Array.isArray(release.supports) ? { supports: release.supports } : {}) };
      frameworkDir = staged;
    }
    // 3. the pack: the new tree's, the root's, or a refresh by the new tree's tool (a missing mandatory edit: not buildable)
    step('pack');
    const build = snap.build;
    let adapterPath = null, provenance = null;
    for (const [dir, from] of [[join(frameworkDir, 'adapters', build), 'shipped'], [join(L.adapters, build), 'root']]) {
      if (await exists(join(dir, 'adapter.json'))) { adapterPath = join(dir, 'adapter.json'); provenance = from; break; }
    }
    if (!adapterPath) {
      // the new tree's own refresh tool, as its own process (its census must never block the Host)
      const refresh = fw ? (x) => refreshInChild({ frameworkDir, previous: x.previous, stockApp: x.stockApp, outDir: x.outDir }) : tools.refreshAdapter;
      try { await refresh({ previous: o.adapter, stockApp: snap.path, outDir: join(L.adapters, build), log }); } catch (e) {
        throw new CodexModsError(e?.code === 'Incompatible' ? 'Incompatible' : 'Unavailable', `this build cannot be made: ${e?.message ?? e}`);
      }
      adapterPath = join(L.adapters, build, 'adapter.json'); provenance = 'refreshed';
    }
    check();
    const pack = JSON.parse(await readFile(adapterPath, 'utf8'));
    // 4. the evidence and its evaluation, with the log of the framework the copy will run
    step('evidence');
    const featureLog = await readJson(join(frameworkDir, 'framework', 'host', 'features', 'log.json'), null);
    const addresses = await readJson(join(frameworkDir, 'framework', 'renderer', 'present', 'addresses.json'), null);
    const ev = await evidenceFor({ pack, dirs: [join(frameworkDir, 'adapters'), L.adapters], addresses });
    const evaluation = featureLog ? evaluate(featureLog, ev) : evaluate(null, ev);
    const running = o.features?.current?.() ?? null;
    // 5. the candidate, from the snapshot, by the new framework's builder, with this copy's build flags
    step('candidate');
    // The signing identity's own keychain (QA's, empty password), unlocked in this session without a prompt: the builder signs with it.
    if (typeof profile.signingKeychain === 'string' && profile.signingKeychain) {
      await new Promise((res) => { const c = spawn('/usr/bin/security', ['unlock-keychain', '-p', '', profile.signingKeychain], { stdio: 'ignore' }); c.once('close', res); c.once('error', res); });
    }
    const runningReport = tools.runningCopy ? await readJson(join(tools.runningCopy, '..', 'build-report.json'), null) : null;
    const flags = [...buildFlagsOf(runningReport), ...(profile.guardStockApp && profile.signingIdentity && profile.signingIdentity !== '-' ? ['--require-identity'] : [])];
    const runBuilder = (args) => runBuilderProcess(args, { spawnFn: (cmd, a, opts) => { const c = spawn(cmd, a, { ...opts, detached: true }); job.children.add(c); c.once('close', () => job?.children.delete(c)); return c; } });
    const built = await buildCandidate({
      layout: L, profile, stockApp: snap.path, build, adapterPath, frameworkDir, frameworkVersion: fw?.to ?? o.frameworkVersion,
      runBuilder: o.runBuilder ?? runBuilder, inUse: tools.inUse, extraArgs: flags,
      extraInputs: { asarSha256: snap.hashes.asar, qaNoRestore: flags.includes('--qa-no-restore'), qaSocketDirs: flags.includes('--qa-socket-dirs') },
    });
    check();
    // 6. every installed mod as the Update page shows it (F11): on the build it runs and on the candidate, what it uses and what of that changed, a newer
    // version that fixes it (the release's or its GitHub release's, verified); the enabled ones are the plan's, at their current and incoming versions
    step('mods');
    const state = o.operations().state();
    const changedIds = new Set(running ? affected(running, evaluation).map((x) => x.id) : []);
    const compatOf = (m) => { const c = computeCompatibility(m, { log: featureLog, evaluation }); return { status: c.status, reasons: c.reasons ?? [], features: c.features ?? [] }; };
    const offers = new Map((o.modOffers?.() ?? []).map((x) => [x.id, x]));
    const newer = (a, b) => { const x = parseVersion(String(a)), y = parseVersion(String(b)); return Boolean(x && y && compareVersions(x, y) > 0); };
    /** A newer version of a mod, verified: the release's bundled package, else its GitHub release's (kept with the plan, by its digest). */
    async function candidateOf(r) {
      if (r.dev || !r.publisher) return null;
      const tries = [];
      const bundled = (release?.mods ?? []).find((m) => m.id === r.id);
      if (bundled) tries.push({ pkg: join(frameworkDir, bundled.package), sha: bundled.sha256 });
      const gh = offers.get(r.id);
      // only from the repository it came from: one renamed, moved or replaced asks consent in the mod's own update (F10), which a copy update does not
      const sameRepo = gh?.github && r.source?.kind === 'github' && gh.github.repoId === r.source.repoId && String(gh.github.repo).toLowerCase() === String(r.source.repo).toLowerCase();
      if (gh?.github?.digest && sameRepo) tries.push({ pkg: gh.file, sha: String(gh.github.digest).replace(/^sha256:/, ''), github: gh.github });
      for (const t of tries) {
        let pkg = t.pkg;
        try {
          if (t.github) {   // copied first, then checked by its digest: the offer's own file may go
            const dir = join(o.layout.profileUpdates, 'packages');
            await mkdir(dir, { recursive: true, mode: 0o700 });
            pkg = join(dir, `${t.sha}.codexmod`);
            if (!(await exists(pkg))) { await copyFile(t.pkg, `${pkg}.tmp-${process.pid}`); await rename(`${pkg}.tmp-${process.pid}`, pkg); }
          }
          const sha = await sha256File(pkg).catch(() => null);
          if (sha !== t.sha) { log.warn('staging: a mod package does not match its record', { modId: r.id }); continue; }
          const v = await o.packages.verify(pkg, { dev: false, frameworkVersion: fw?.to ?? o.frameworkVersion, digest: `sha256:${sha}` });
          try {
            if (v.manifest.id !== r.id || (v.publisher ?? null) !== (r.publisher ?? null)) continue;
            if (t.github ? !newer(v.manifest.version, r.version) : v.manifest.version === r.version) continue;
            const c = compatOf(v.manifest);
            return { version: v.manifest.version, package: pkg, sha256: sha, ...(t.github ? { github: t.github } : {}),
              // F8: against what it requires now, so an optional permission become required asks too, whatever its decision
              addedPermissions: (v.manifest.permissions ?? []).filter((p) => !permissionCovered(p, requiredOf(r))), status: c.status, reasons: c.reasons };
          } finally { await rm(v.dir, { recursive: true, force: true }).catch(() => {}); }
        } catch (e) { log.warn('staging: a mod package does not verify', { modId: r.id, message: String(e?.message ?? e) }); }
      }
      return null;
    }
    const enabled = [], display = [];
    for (const r of Object.values(state.mods).filter((m) => m.status !== 'pending-consent').sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const manifest = o.operations().installed(r.id)?.manifest;
      const there = manifest ? compatOf(manifest) : { status: 'blocked', reasons: [], features: [] };
      const incoming = await candidateOf(r);
      check();
      display.push({
        id: r.id, version: r.version, on: r.status === 'enabled', now: manifest ? o.operations().compatibility(manifest).status : 'blocked', verdict: there.status,
        unknown: there.reasons.some((x) => x.required && x.status === 'unknown'), tested: (manifest?.testedWith ?? []).includes(build),
        uses: there.features.map((id) => ({ id, title: String(featureTitle(featureLog, id)) })), changed: there.features.filter((id) => changedIds.has(id)),
        missing: there.reasons.filter((x) => x.status === 'missing').map((x) => x.id),
        unchecked: there.reasons.filter((x) => x.status === 'unknown').map((x) => x.id),
        ...(incoming ? { candidate: { version: incoming.version, verdict: incoming.status, addedPermissions: incoming.addedPermissions, from: incoming.github ? 'github' : 'release' } } : {}),
      });
      if (r.status === 'enabled') enabled.push({ id: r.id, version: r.version, current: { status: there.status, reasons: there.reasons }, ...(incoming ? { incoming } : {}) });
    }
    // 7. the plan, written last
    step('plan');
    const plan = {
      plan: 1, createdAt: new Date().toISOString(),
      offer: { id: offer.id, build, framework: fw?.to ?? null, mods: Object.fromEntries(enabled.filter((m) => m.incoming).map((m) => [m.id, m.incoming.version])) },
      stock: { build, snapshot: snap.path, ...snap.hashes },
      pack: { build, from: provenance, adapter: await sha256File(adapterPath), facts: ev.facts ? await sha256File(join(ev.from, 'build-facts.json')).catch(() => null) : null },
      candidate: { path: built.candidate, inputsHash: built.inputsHash }, framework: fw,
      features: { log: featureLog ? true : false, counts: count(evaluation.features), ...(running ? { affected: affected(running, evaluation).length } : {}) },
      enabled, display,
    };
    plan.hash = planHashOf(plan);
    const dir = planDir(L, plan.hash);
    if (!(await exists(join(dir, 'plan.json')))) {
      const tmp = `${dir}.tmp-${process.pid}`;
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true, mode: 0o700 });
      await writeFile(join(tmp, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`, { mode: 0o600 });
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
    } else {
      // the same inputs: the same plan, but what the page shows of the mods is read again (a mod installed or turned off since, a better evaluation)
      const was = await readJson(join(dir, 'plan.json'), null);
      if (JSON.stringify(was?.display ?? null) !== JSON.stringify(display)) {
        const tmpFile = join(dir, `plan.json.tmp-${process.pid}`);
        await writeFile(tmpFile, `${JSON.stringify({ ...was, display }, null, 1)}\n`, { mode: 0o600 });
        await rename(tmpFile, join(dir, 'plan.json'));
      }
    }
    await pruneOlder(L, plan, tools.inUse).catch((e) => log.warn('staging: what older plans held could not all be removed', { message: String(e?.message ?? e) }));
    return { plan };
  }

  return {
    stage,
    /** Preempted by a framework operation: the builder's process group is killed and the job stops between steps; resolves when it has. */
    async cancel() {
      if (!job) return;
      job.cancelled = true;
      for (const c of job.children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
      while (job) await new Promise((r) => setTimeout(r, 50));
    },
    status: () => (job ? { offer: job.offer.id, step: job.step, startedAt: job.startedAt } : null),
    /** Leftovers of a staging the Host did not finish (temporary directories). */
    async cleanup() {
      for (const base of [join(o.layout.updates, 'stock'), join(o.layout.updates, 'framework'), o.layout.profileUpdates]) {
        let names;
        try { names = await (await import('node:fs/promises')).readdir(base); } catch { continue; }
        for (const n of names) if (/\.tmp-\d+|^\.tmp-/.test(n)) await rm(join(base, n), { recursive: true, force: true });
      }
    },
  };
}
