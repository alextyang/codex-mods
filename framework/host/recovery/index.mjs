// Recovery: generations, the health gate and last-known-good, framework and app updates, safe mode, LKG restore.
// ARCHITECTURE §12, §15. Contract: contracts/host.d.ts (Recovery, createRecovery, stockAppConflict).
//
// Durable facts live in files that the LOADER also reads, so the loader's auto-revert never depends on this module:
//   framework/current|previous|lkg   text files holding a version        lkg-app    (profile) text file holding the LKG copy's path
//   flags/boot.json                  BootMarker (loader owns state/unhealthyCount until the gate passes)
//   flags/safe|disabled              presence flags                      flags/swap-<opId>.json   swap-helper receipts
//   generations/<n>.json, lkg        Generation records, LKG pointer
/** @typedef {import('../../../contracts/state.js').Generation} Generation */
/** @typedef {import('../../../contracts/state.js').OpRecord} OpRecord */
import { readFileSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { FLAGS } from '../../../contracts/layout.mjs';
import { writeJsonAtomic, readJson, now } from '../fsutil.mjs';
import { computeCompatibility } from '../ops/compat.mjs';
import { evaluate as evaluateFeatures, affected, diffFacts } from '../features/status.mjs';
import { evidenceFor, loadLog, logHash } from '../features/evidence.mjs';
import {
  STOCK_APP, STOCK_EXECUTABLE, writeTextAtomic, readText, readTextSync, readLinkAbs, samePath, exists, mkdirs,
  readAppBuildSync, installFrameworkTree, cleanFrameworkTemps, setFrameworkCurrent, assertVersionName, assertFrameworkTree,
  buildCandidate, runBuilderProcess, resolveInputsHash, candidateDirName, startupDialogOpenSync, resetBootMarker, frameworkTreeHash, refreshInChild,
} from './support.mjs';

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HEALTH_WINDOW_MS = 60_000;
const KEEP_GENERATIONS = 3;

/**
 * Informational stock-app check (ARCHITECTURE §5; v1.13 warn-but-allow). Resolves {conflict, processes}:
 *   conflict false     the profile does not share a home with the stock app (guardStockApp off) or no stock process was found
 *   conflict true      guardStockApp is set and `processes` lists the running stock-executable processes [{pid, command}]
 *   conflict 'unknown' process inspection failed (never reported as "no conflict"); `error` says why
 * It no longer decides anything by itself: the caller warns and lets the person confirm.
 * `deps.ps` is injectable for tests and must resolve with the text of `ps -axo pid,comm`.
 */
export async function stockAppConflict(profile, deps = {}) {
  if (!profile?.guardStockApp) return { conflict: false, processes: [] };
  const ps = deps.ps ?? (() => new Promise((res, rej) =>
    execFile('/bin/ps', ['-axo', 'pid,comm'], { maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(out)))));
  try {
    const exe = deps.stockExecutable ?? STOCK_EXECUTABLE;
    const processes = [];
    for (const line of String(await ps()).split('\n')) {
      const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
      if (m && m[2] === exe) processes.push({ pid: Number(m[1]), command: m[2] });
    }
    return { conflict: processes.length > 0, processes };
  } catch (e) {
    return { conflict: 'unknown', processes: [], error: String(e?.message ?? e) };
  }
}

/**
 * @param {Parameters<typeof import('../../../contracts/host.js').createRecovery>[0] & { deps?: object }} opts
 * Optional opts beyond the contract (v1.4, wired by the Host): `activeMods() → string[]` (Runtime.active(): the mods that really
 * activated), `gcPackages()` (Operations.gcStore: owns cross-profile references and locking), `safeMode` (this boot is a safe-mode boot),
 * `runningAppPath` (HostStartOptions.runningAppPath: the bundle actually running; certified as Generation.appCandidate).
 * `deps` (test seams): stockApp, spawn, appPid, runBuilder, refreshAdapter, healthWindowMs, exitDelayMs, exitGraceMs, swapHelper,
 * runningCopy.
 */
export function createRecovery(opts) {
  const { layout, log, bus, operationsState, operations, requestExit, appBuild, frameworkVersion, adapterVersion, adapter } = opts;
  const deps = {
    stockApp: STOCK_APP, spawn: nodeSpawn, appPid: () => process.ppid, healthWindowMs: HEALTH_WINDOW_MS, healthTickMs: 500, exitDelayMs: 250, exitGraceMs: 30_000,
    // the refresh runs as its own process: its census must never block the Host (E5, found natively)
    swapHelper: join(TREE, 'builder', 'swap-helper.sh'), refreshAdapter: (o) => refreshInChild({ frameworkDir: TREE, previous: o.previous, stockApp: o.stockApp, outDir: o.outDir }),
    runBuilder: (args) => runBuilderProcess(args),
    frameworkDir: () => join(layout.framework, frameworkVersion),
    ...(opts.deps ?? {}),
  };
  const flagPath = (name) => join(layout.flags, name);
  const genPath = (n) => join(layout.generations, `${n}.json`);
  const lkgPointer = join(layout.generations, 'lkg');
  const copyBuild = `${adapter.build.version}-${adapter.build.bundleVersion}`;

  // ---------------------------------------------------------------- health gate
  const got = new Set();
  let current;            // Generation of this boot
  let booted = false, healthy = false, fatal = false, timedOut = false, gaveUp = false;
  let safeBoot = !!opts.safeMode, bootStartedAt = 0;
  let timer;
  let pending = Promise.resolve();

  function publishHealth(h) {
    const prev = bus.state('framework/health');
    bus.publish('framework/health', { ...(prev?.stockAppConflict ? { stockAppConflict: true } : {}), healthy: h }, { state: true });
  }
  let warnedFallback = false;
  /** The .app actually running (HostStartOptions.runningAppPath). Headless fallback: the stable symlink's target, with a logged note. */
  function runningCopy() {
    if (deps.runningCopy) return deps.runningCopy();
    if (opts.runningAppPath) return opts.runningAppPath;
    try {
      const profile = JSON.parse(readFileSync(layout.profileConfig, 'utf8'));
      const t = profile.appPath ? (readLinkAbs(profile.appPath) ?? undefined) : undefined;
      if (t && !warnedFallback) { warnedFallback = true; log.info('recovery: runningAppPath not provided; using the stable symlink target as the running copy (headless)', { target: t }); }
      return t;
    } catch { return undefined; }
  }
  async function updateMarker(patch) {
    const marker = (await readJson(flagPath(FLAGS.bootMarker), undefined)) ?? { startedAt: now(), state: 'booting', unhealthyCount: 0 };
    await writeJsonAtomic(flagPath(FLAGS.bootMarker), { ...marker, ...patch });
  }
  /** The configuration that really ran: enabled records that also activated. Without activeMods() every enabled record counts. */
  async function effectiveConfig() {
    const state = operationsState();
    const active = opts.activeMods ? new Set(opts.activeMods()) : null;
    const snapshot = structuredClone(state);
    for (const rec of Object.values(snapshot.mods)) {
      if (rec.status === 'enabled' && active && !active.has(rec.id)) rec.status = 'disabled'; // never ran: not certified
    }
    return computeTuple(snapshot);
  }
  async function markHealthy() {
    try {
      let g = current;
      if (!safeBoot) {
        const eff = await effectiveConfig();
        if (tupleOf(eff.tuple) !== tupleOf(current)) {
          g = await recordGeneration(eff);       // a generation for the effective configuration (a reused one if equal)
        }
        g = { ...g, healthyAt: now() };
        await writeJsonAtomic(genPath(g.n), g);
        await writeTextAtomic(lkgPointer, String(g.n));
        await writeTextAtomic(layout.frameworkLkg, frameworkVersion);
        if (g.appCandidate) await writeTextAtomic(layout.lkgApp, g.appCandidate);   // this profile's LKG copy (the loader reads it)
        else log.warn('recovery: running copy path unknown; lkg-app not written');
      }
      // Safe-mode boots reset the loader's counter but never become last-known-good.
      await updateMarker({ generation: g.n, state: 'healthy', unhealthyCount: 0 });
      current = g;
      publishHealth(true);
      log.info('recovery: boot healthy', { generation: g.n, lkg: !safeBoot });
      if (!safeBoot) await retain().catch((e) => log.warn('recovery: retention failed', { message: e.message }));
    } catch (e) {
      healthy = false; gaveUp = true;
      log.error('recovery: could not record the healthy generation', { message: e.message });
      publishHealth(false);
    }
  }
  /** Last 3 generations plus LKG plus those referenced by running ops. Package GC is Operations' job (one lock, all profiles). */
  async function retain() {
    const names = await readdir(layout.generations).catch(() => []);
    const ns = names.map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
    const keep = new Set(ns.slice(0, KEEP_GENERATIONS));
    const lkgN = readTextSync(lkgPointer); if (lkgN) keep.add(Number(lkgN));
    keep.add(current.n);
    for (const f of await readdir(layout.ops).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      const op = await readJson(join(layout.ops, f), undefined).catch(() => undefined);
      if (op?.outcome === 'running' && Number.isInteger(op.result?.generation)) keep.add(op.result.generation);
    }
    for (const n of ns) if (!keep.has(n)) await rm(genPath(n), { force: true });
    await opts.gcPackages?.();
  }
  /** A quarantine at any point before health is fatal, however it was reported (bus event, op note or the record itself). */
  function quarantinedSinceBoot() {
    return Object.values(operationsState().mods).some((m) => m.status === 'quarantined' && m.quarantine?.at && Date.parse(m.quarantine.at) >= bootStartedAt);
  }
  function evaluate() {
    if (!booted || healthy || fatal || timedOut || gaveUp) return;
    if (quarantinedSinceBoot()) { report('fatal'); return; }
    if (got.has('window-rendered') && got.has('host-ready') && got.has('handshake-complete')) {
      healthy = true;
      clearInterval(timer);
      pending = pending.then(markHealthy);
    }
  }
  function report(signal) {
    if (signal === 'fatal') {
      if (!fatal && !healthy) { fatal = true; clearInterval(timer); publishHealth(false); }
      return;
    }
    if (signal !== 'window-rendered' && signal !== 'host-ready' && signal !== 'handshake-complete') return;
    got.add(signal);
    evaluate();
  }
  bus.subscribe('appServer/ready', () => report('handshake-complete'), { replay: 'state' });
  bus.subscribe('framework/quarantine', () => report('fatal'));
  bus.subscribe('framework/op', (op) => {
    if (op && typeof op.note === 'string' && /quarantin/i.test(op.note)) report('fatal');
  });

  // ---------------------------------------------------------------- generations
  async function latestGeneration() {
    let names = [];
    try { names = await readdir(layout.generations); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const ns = names.map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
    for (const n of ns) {
      try { const g = await readJson(genPath(n)); if (g && g.n === n) return g; } catch { /* corrupt: fall back to an older one */ }
    }
    return undefined;
  }
  async function readSettingsBytes(modId, file = 'settings.json') {
    try { return await readFile(join(layout.data, modId, file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function computeTuple(stateOverride) {
    const state = stateOverride ?? operationsState();
    const mods = Object.values(state.mods).filter((m) => m.status === 'enabled')
      .map((m) => ({ id: m.id, version: m.version, dataSchemaVersion: m.dataSchemaVersion })).sort((a, b) => (a.id < b.id ? -1 : 1));
    const h = createHash('sha256');
    // A mod's settings are its app map and its overrides at narrower scopes (docs/design/systems.md E3): both are in the hash and the snapshot.
    for (const m of mods) {
      h.update(m.id + '\0').update((await readSettingsBytes(m.id)) ?? '').update('\0');
      const scoped = await readSettingsBytes(m.id, 'settings.scopes.json');
      if (scoped) h.update('scopes\0').update(scoped).update('\0');
    }
    const settings = {}, settingsScopes = {};
    for (const id of Object.keys(state.mods).sort()) {
      const bytes = await readSettingsBytes(id);
      if (bytes) { try { settings[id] = JSON.parse(bytes.toString('utf8')); } catch { /* unreadable settings are not restorable */ } }
      const scoped = await readSettingsBytes(id, 'settings.scopes.json');
      if (scoped) { try { settingsScopes[id] = JSON.parse(scoped.toString('utf8')); } catch { /* not restorable */ } }
    }
    return { tuple: { appBuild, appCandidate: runningCopy() ?? '', frameworkVersion, adapterVersion, mods, settingsHash: h.digest('hex') }, state, settings, settingsScopes };
  }
  async function recordGeneration({ tuple, state, settings, settingsScopes = {} }) {
    const latest = await latestGeneration();
    if (latest && tupleOf(latest) === tupleOf(tuple)) return latest;
    const g = { n: (latest?.n ?? 0) + 1, ...tuple, state: structuredClone(state), settings, settingsScopes, createdAt: now() };
    await writeJsonAtomic(genPath(g.n), g);
    return g;
  }
  const tupleOf = (g) => JSON.stringify({ appBuild: g.appBuild, appCandidate: g.appCandidate ?? '', frameworkVersion: g.frameworkVersion, adapterVersion: g.adapterVersion, mods: g.mods, settingsHash: g.settingsHash });

  async function beginBoot() {
    current = await recordGeneration(await computeTuple());
    await updateMarker({ generation: current.n });
    if (await exists(flagPath(FLAGS.safe)) || operationsState().safeMode) safeBoot = true;
    bootStartedAt = Date.now();
    booted = true; timedOut = false;
    clearInterval(timer);
    if (!healthy) {
      // The window counts only time with no blocking startup dialog open (flags/startup-dialog.json held by a live process):
      // waiting for a person must never count as a failed start. It starts/resumes when the dialog closes.
      let elapsed = 0;
      timer = setInterval(() => {
        if (healthy || fatal || timedOut || gaveUp) { clearInterval(timer); return; }
        if (!startupDialogOpenSync(layout.flags)) elapsed += deps.healthTickMs;
        if (elapsed >= deps.healthWindowMs) {
          clearInterval(timer);
          timedOut = true;
          if (!healthy && !fatal) { publishHealth(false); log.warn('recovery: health gate not reached within the window', { generation: current.n }); }
        }
      }, deps.healthTickMs);
      timer.unref?.();
      evaluate();
    }
    return current;
  }
  function lkg() {
    try {
      const n = readTextSync(lkgPointer);
      if (!n) return undefined;
      return JSON.parse(readFileSync(genPath(n), 'utf8'));
    } catch { return undefined; }
  }

  // ---------------------------------------------------------------- app update helpers
  function stockBuild() { return readAppBuildSync(deps.stockApp); }
  function appUpdateAvailable() {
    try {
      const stock = stockBuild();
      return stock.build === copyBuild ? null : { stockBuild: stock.build, copyBuild };
    } catch { return null; }
  }
  async function readProfile() { return readJson(layout.profileConfig, undefined); }
  async function inUse(dir) {
    const profile = await readProfile();
    const targets = [profile?.appPath ? readLinkAbs(profile.appPath) : undefined, await readText(layout.lkgApp), runningCopy()].filter(Boolean);
    for (const t of targets) { if (t === dir || resolve(t).startsWith(resolve(dir) + '/')) return true; }
    return false;
  }

  /**
   * Each installed mod's compatibility with a candidate build (docs/design/systems.md "E4 in detail"): the same evaluator as the running
   * copy's, on the candidate's evidence (its pack, and its census and refresh report beside it), with the feature log of the framework
   * it will run; and what differs from the running build (its features' and mechanics' statuses, and the census diff).
   */
  async function compatibilityAgainst(pack, frameworkDir) {
    const log = (frameworkDir ? await readJson(join(frameworkDir, 'framework', 'host', 'features', 'log.json'), null) : null) ?? deps.features?.log ?? await loadLog();
    const addresses = frameworkDir ? await readJson(join(frameworkDir, 'framework', 'renderer', 'present', 'addresses.json'), null) : null;
    const ev = await evidenceFor({ pack, dirs: [...(frameworkDir ? [join(frameworkDir, 'adapters')] : []), layout.adapters, deps.adaptersDir].filter(Boolean),
      addresses: addresses ?? deps.addresses ?? null });
    const evaluation = log ? evaluateFeatures(log, ev) : null;
    const mods = {}; const summary = { compatible: 0, degraded: 0, atRisk: 0, blocked: 0, unknown: 0 };
    for (const rec of Object.values(operationsState().mods)) {
      let manifest;
      try { manifest = JSON.parse(await readFile(join(rec.dev ? rec.dev.sourceDir : join(layout.store, rec.id, rec.version), 'mod.json'), 'utf8')); }
      catch { mods[rec.id] = { status: 'unknown', missingRequired: [], missingOptional: [] }; summary.unknown++; continue; }
      const c = computeCompatibility(manifest, { log, evaluation: evaluation ?? evaluateFeatures(null, ev) });
      mods[rec.id] = c; summary[c.status]++;
    }
    const running = deps.features?.current?.() ?? null;
    const runningFacts = deps.features?.evidence?.()?.facts ?? null;
    const features = evaluation ? {
      build: ev.build, hash: log ? logHash(log) : null, evidence: { census: !!ev.facts, report: !!ev.report, stale: ev.stale },
      counts: countBy(evaluation.features), mechanics: countBy(evaluation.mechanics),
      ...(running ? { affected: affected(running, evaluation) } : {}),
      ...(runningFacts && ev.facts ? { diff: diffFacts(runningFacts, ev.facts) } : {}),
    } : null;
    return { summary, mods, ...(features ? { features } : {}) };
  }
  const countBy = (o) => Object.values(o ?? {}).reduce((acc, x) => { acc[x.status] = (acc[x.status] ?? 0) + 1; return acc; }, {});

  // ---------------------------------------------------------------- exit and busy guard
  let busy = false, exiting = false;
  function exit(relaunch, reason) {
    if (deps.exitGraceMs > 0) {
      // If the process is still alive after the grace period (e.g. a headless Host with no parent), stop refusing ops.
      exiting = true;
      setTimeout(() => { exiting = false; }, deps.exitGraceMs).unref?.();
    }
    // Give Operations a moment to persist this op's outcome before the process goes away.
    if (deps.exitDelayMs > 0) setTimeout(() => requestExit({ relaunch, reason }), deps.exitDelayMs);
    else requestExit({ relaunch, reason });
  }

  // ---------------------------------------------------------------- ops
  async function frameworkUpdate(op, journal) {
    const { version, sourceDir } = op.input;
    assertVersionName(version);
    await assertFrameworkTree(sourceDir);
    const cur = await readText(layout.frameworkCurrent);
    if (cur === version) return { outcome: 'succeeded', note: `framework ${version} is already current` };
    await journal('copy');
    await installFrameworkTree(layout, sourceDir, version);
    await journal('previous');
    if (cur) await writeTextAtomic(layout.frameworkPrevious, cur);
    await journal('current');
    await writeTextAtomic(layout.frameworkCurrent, version);
    exit(true, 'framework-update');
    // The pointer flip is only half the story: the loader reverts `current` after two unhealthy boots of the new framework
    // (ARCHITECTURE §12.2). So the op stays running and reconcileOp gives the verdict at a later boot, from the pointers and the LKG.
    return { outcome: 'running', note: 'waiting for the relaunch; a later boot reports whether the new framework held',
      result: { version, previous: cur ?? null } };
  }

  async function appPrepare(op, journal) {
    await journal('inspect');
    const stock = stockBuild();
    const build = stock.build;
    const adapterDir = join(layout.adapters, build);
    let refreshed = null;
    if (!(await exists(join(adapterDir, 'adapter.json')))) {
      await journal('refresh-adapter');
      refreshed = await deps.refreshAdapter({ previous: adapter, stockApp: deps.stockApp, outDir: adapterDir, log });
    }
    const adapterPath = join(adapterDir, 'adapter.json');
    const pack = await readJson(adapterPath);
    const profile = (await readProfile()) ?? {};
    const frameworkDir = deps.frameworkDir();
    const hash = await resolveInputsHash({ adapterPath, frameworkDir, identity: profile.signingIdentity || '-', frameworkVersion });
    await journal(`build:${candidateDirName(build, hash)}`);   // names the directory reconcileOp must clean up
    await journal('build-copy');
    const built = await buildCandidate({ layout, profile, stockApp: deps.stockApp, build, adapterPath,
      frameworkDir, frameworkVersion, runBuilder: deps.runBuilder, inUse });
    const report = refreshed?.report ?? (await readJson(join(adapterDir, 'refresh-report.json'), null));
    const missedAnchors = Object.entries(report?.anchors ?? {}).filter(([, v]) => v.missed).map(([k]) => k);
    const compatibility = {
      ...(await compatibilityAgainst(pack, frameworkDir)),
      adapter: refreshed || report ? 'refreshed' : 'pack',
      misses: report ? { transforms: Object.entries(report.transforms ?? {}).filter(([, v]) => v.missed).map(([k]) => k), anchors: missedAnchors,
        protocol: report.protocol?.regenerated === false ? report.protocol.reason : null } : null,
    };
    return { outcome: 'succeeded', note: built.reused ? 'candidate already built' : undefined,
      result: { candidate: built.candidate, appBuild: build, inputsHash: built.inputsHash, compatibility } };
  }

  /** Steps 1–4 of app-switch; shared with lkg-restore. Leaves the op running: reconcileOp finishes it at the next boot. */
  async function swapApp(op, journal, candidate) {
    const profile = await readProfile();
    const stable = profile?.appPath;
    if (!stable) throw new CodexModsError('Unavailable', 'profile.json has no appPath; run `codexmods setup`');
    if (!readLinkAbs(stable)) throw new CodexModsError('Conflict', `${stable} is not a symlink; run \`codexmods setup\``);
    if (!(await exists(candidate))) throw new CodexModsError('Invalid', `candidate ${candidate} does not exist`);
    await mkdirs(layout.flags);
    const receiptPath = join(layout.flags, FLAGS.swapReceipt(op.id));
    const launchArgs = Array.isArray(profile.launchArgs) ? profile.launchArgs.map(String) : [];
    await journal('swapping');
    await spawnSwap(stable, candidate, receiptPath, launchArgs);
    exit(false, 'app-switch');
    return { outcome: 'running', note: 'waiting for the swap helper; the next boot completes this operation', result: { candidate, receipt: receiptPath } };
  }
  /** The detached swap helper: it waits for this app to quit, repoints the stable symlink and reopens it (builder/swap-helper.sh). */
  async function spawnSwap(stable, candidate, receiptPath, launchArgs) {
    // launchArgs ride along as trailing args: the helper reopens with `open -n <stable> --args <launchArgs>` every time.
    const child = deps.spawn('/bin/sh', [deps.swapHelper, String(deps.appPid()), stable, candidate, receiptPath, ...launchArgs], { detached: true, stdio: 'ignore' });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref?.();
  }

  // ---------------------------------------------------------------- what the update operation (copy-update, ops/lifecycle.mjs) asks of Recovery
  const update = {
    /** The staged framework tree installed into framework/<version>, verified against the plan's tree hash; whether this call made it. */
    async installFramework({ version, dir, treeHash }) {
      assertVersionName(version);
      await assertFrameworkTree(dir);
      const h = await frameworkTreeHash(dir);
      if (h !== treeHash) throw new CodexModsError('Invalid', `the staged framework ${version} is not its release (tree ${h.slice(0, 12)}, the release says ${String(treeHash).slice(0, 12)})`);
      const existed = await exists(join(layout.framework, version));
      await installFrameworkTree(layout, dir, version);
      return { created: !existed };
    },
    /** framework/<version> removed when no pointer names it (an update's undo of a tree it installed). */
    async removeFramework(version) {
      const named = [await readText(layout.frameworkCurrent), await readText(layout.frameworkPrevious), await readText(layout.frameworkLkg), frameworkVersion];
      if (named.includes(version)) return false;
      await rm(join(layout.framework, version), { recursive: true, force: true });
      return true;
    },
    async pointers() {
      return { current: await readText(layout.frameworkCurrent), previous: await readText(layout.frameworkPrevious), lkg: await readText(layout.frameworkLkg),
        lkgApp: await readText(layout.lkgApp), running: frameworkVersion };
    },
    /** One framework pointer written (null: removed); each its own atomic file. */
    async setPointer(name, value) {
      const file = name === 'current' ? layout.frameworkCurrent : name === 'previous' ? layout.frameworkPrevious : null;
      if (!file) throw new CodexModsError('Invalid', `no framework pointer ${name}`);
      if (value === null || value === undefined) await rm(file, { force: true }); else await writeTextAtomic(file, value);
    },
    /** The switch: the swap helper started for the op's receipt, then the app quits (no relaunch: the helper reopens it). */
    async swap(op, candidate) {
      const profile = await readProfile();
      const stable = profile?.appPath;
      if (!stable) throw new CodexModsError('Unavailable', 'profile.json has no appPath; run `codexmods setup`');
      if (!readLinkAbs(stable)) throw new CodexModsError('Conflict', `${stable} is not a symlink; run \`codexmods setup\``);
      if (!(await exists(candidate))) throw new CodexModsError('Invalid', `candidate ${candidate} does not exist`);
      await mkdirs(layout.flags);
      await spawnSwap(stable, candidate, join(layout.flags, FLAGS.swapReceipt(op.id)), Array.isArray(profile.launchArgs) ? profile.launchArgs.map(String) : []);
      exit(false, 'copy-update');
    },
    /** After the switch: the helper's receipt and the symlink (as app-switch reads them), the pointers, and what this boot runs. */
    async facts(op, candidate) {
      const s = await switchState(op, candidate);
      const profile = await readProfile();
      const target = profile?.appPath ? readLinkAbs(profile.appPath) : undefined;
      return { ...s, target, running: runningCopy(), pointers: await update.pointers() };
    },
    /** This boot's healthy generation (null before health): what a verdict certifies. */
    healthy: () => (healthy && current?.healthyAt ? structuredClone(current) : null),
    /** What staging builds with (updates/staging.mjs): the stock app, the builder, the refresh tool, the copy in use, this framework. */
    tools: () => ({ stockApp: deps.stockApp, runBuilder: deps.runBuilder, refreshAdapter: deps.refreshAdapter, inUse, runningCopy: runningCopy(),
      frameworkDir: deps.frameworkDir(), copyBuild }),
  };
  async function appSwitch(op, journal) {
    const candidate = resolve(op.input.candidate);
    const apps = resolve(layout.apps);
    if (!candidate.startsWith(apps + '/') || !candidate.endsWith('.app')) {
      throw new CodexModsError('Invalid', `candidate must be an .app inside ${apps}`);
    }
    const profile = await readProfile();
    if (profile?.appPath && await samePath(readLinkAbs(profile.appPath), candidate)) {
      return { outcome: 'succeeded', note: 'the stable path already points at the candidate' };
    }
    return swapApp(op, journal, candidate);
  }

  async function safeMode(op, journal) {
    const { enter } = op.input;
    await journal('set-state');
    await operations().setSafeMode(enter);
    await journal('set-flag');
    if (enter) await writeJsonAtomic(flagPath(FLAGS.safe), { reason: 'safe-mode-op' });
    else {
      await rm(flagPath(FLAGS.safe), { force: true });
      await resetBootMarker(layout.flags, 'safe-off');   // "try normally": the unhealthy streak ends
    }
    exit(true, 'safe-mode');
    return { outcome: 'succeeded', result: { safeMode: enter } };
  }

  async function lkgRestore(op, journal) {
    const g = lkg();
    if (!g) throw new CodexModsError('Unavailable', 'no last-known-good generation has been recorded yet');
    if (!(await exists(join(layout.framework, g.frameworkVersion)))) {
      throw new CodexModsError('Unavailable', `framework ${g.frameworkVersion} of the last-known-good generation is no longer installed`);
    }
    // The exact candidate this generation ran from, and only that (never another profile's, never "some copy of the same build").
    if (g.appCandidate && !(await exists(g.appCandidate))) {
      throw new CodexModsError('Unavailable', `the app copy of the last-known-good generation is gone: ${g.appCandidate}`);
    }
    await journal('restore-records');
    const { restored, leftDisabled } = await operations().restoreFromGeneration(g);
    await journal('leave-safe-mode');
    await operations().setSafeMode(false);
    await rm(flagPath(FLAGS.safe), { force: true });
    await journal('framework-current');
    await setFrameworkCurrent(layout, g.frameworkVersion);
    const result = { generation: g.n, restored, leftDisabled, frameworkVersion: g.frameworkVersion };
    // Candidates are identified by path (apps/<build>-<inputsHash>/<App>.app), not by upstream build: two candidates of the same
    // stock build differ in adapter, loader, relay or identity, so a different path means a switch.
    const lkgApp = g.appCandidate || undefined;
    const profile = await readProfile();
    const nowTarget = profile?.appPath ? readLinkAbs(profile.appPath) : undefined;
    const differs = lkgApp && (nowTarget ? !(await samePath(nowTarget, lkgApp)) : g.appBuild !== appBuild);
    if (differs) {
      const sw = await swapApp(op, journal, lkgApp);
      return { ...sw, result: { ...result, ...sw.result } };
    }
    await journal('relaunch');
    exit(true, 'lkg-restore');
    return { outcome: 'succeeded', result };
  }

  async function runOp(op, journal) {
    if (busy || exiting) throw new CodexModsError('Busy', exiting ? 'a restart is already in progress' : 'another framework operation is running');
    busy = true;
    try {
      switch (op.input.type) {
        case 'framework-update': return await frameworkUpdate(op, journal);
        case 'app-prepare': return await appPrepare(op, journal);
        case 'app-switch': return await appSwitch(op, journal);
        case 'safe-mode': return await safeMode(op, journal);
        case 'lkg-restore': return await lkgRestore(op, journal);
        default: throw new CodexModsError('Invalid', `recovery does not run ${op.input.type} operations`);
      }
    } finally { busy = false; }
  }

  // ---------------------------------------------------------------- reconciliation (truthful: durable phases + actual target state)
  const phaseNames = (op) => op.phases.map((p) => p.name);
  const hasPhase = (op, ...names) => phaseNames(op).some((n) => names.includes(n));

  /**
   * The app-switch rule. The symlink's actual target is ALWAYS inspected, whatever the receipt says:
   * a candidate that is selected despite an ok:false receipt (e.g. rollbackFailed) is needs-attention, never failed.
   */
  async function switchState(op, candidate) {
    let receipt;
    try { receipt = await readJson(join(layout.flags, FLAGS.swapReceipt(op.id)), undefined); } catch { receipt = undefined; }
    const profile = await readProfile();
    const target = profile?.appPath ? readLinkAbs(profile.appPath) : undefined;
    const onCandidate = !!target && await samePath(target, candidate);
    const onPrevious = !!target && !!receipt?.previous && await samePath(target, receipt.previous);
    if (receipt?.ok === true) {
      return { done: true, note: onCandidate || !target ? 'swap helper receipt: ok'
        : `swap helper receipt: ok; the symlink now points at ${target} (changed after the swap)`, receipt };
    }
    if (receipt?.ok === false) {
      if (onCandidate) return { done: false, attention: true, note: `swap receipt says failed (${receipt.error ?? 'unknown error'}${receipt.rollbackFailed ? '; rollback failed' : ''}) but the symlink still points at the candidate`, receipt };
      if (!target) return { done: false, attention: true, note: `swap failed (${receipt.error ?? 'unknown error'}) and the stable symlink cannot be read`, receipt };
      if (receipt.rollbackFailed && !onPrevious) return { done: false, attention: true, note: `swap failed and rollback failed; the symlink points at ${target}`, receipt };
      return { done: false, failed: true, note: `swap failed: ${receipt.error ?? 'unknown error'}`, receipt };
    }
    if (!target) return { done: false, attention: true, note: `cannot read the stable symlink ${profile?.appPath ?? '(no appPath)'}`, receipt };
    if (onCandidate) return { done: true, note: 'verified from symlink; receipt incomplete', receipt };
    if (receipt?.previous && !onPrevious) {
      return { done: false, attention: true, note: `the symlink points at ${target}, neither the candidate nor the previous copy`, receipt };
    }
    return { done: false, failed: true, note: 'swap did not complete', receipt };
  }
  async function reconcileSwitch(op) {
    const s = await switchState(op, resolve(op.input.candidate));
    if (s.done) return { outcome: 'succeeded', note: s.note };
    if (s.attention) return { outcome: 'needs-attention', note: s.note };
    return { outcome: 'failed', note: s.note };
  }

  /**
   * framework-update verdict, from the pointers and what is actually running:
   *  - current == version, running it, and it has been healthy (framework/lkg == version) -> succeeded
   *  - current == version, running it, not yet proven healthy -> null (stay running; the loader may still revert it)
   *  - current moved back to the LKG and that is what runs -> reverted by the loader after unhealthy boots
   *  - anything else after a pointer change -> needs-attention with what was found; no pointer change -> failed
   */
  async function reconcileFrameworkUpdate(op) {
    const want = op.input.version;
    const cur = await readText(layout.frameworkCurrent);
    const prev = await readText(layout.frameworkPrevious);
    const lkgV = await readText(layout.frameworkLkg);
    if (!hasPhase(op, 'previous', 'current')) {
      await cleanFrameworkTemps(layout);
      return { outcome: 'failed', note: 'interrupted before any framework pointer changed' };
    }
    if (cur === want) {
      if (frameworkVersion !== want) {
        return { outcome: 'needs-attention', note: `framework current is ${want}, but this boot runs ${frameworkVersion}` };
      }
      if (lkgV === want) return { outcome: 'succeeded', note: `framework ${want} is running and passed the health gate` };
      log.info('recovery: framework update not yet proven healthy; leaving the operation running', { version: want });
      return null;
    }
    const marker = await readJson(flagPath(FLAGS.bootMarker), {}).catch(() => ({}));
    if (cur && cur === lkgV && cur === frameworkVersion) {
      return { outcome: 'reverted', note: `reverted by loader after unhealthy boots: framework current is ${cur} (last-known-good), expected ${want}`
        + `${prev ? `; previous is ${prev}` : ''}${marker.unhealthyCount ? `; unhealthyCount ${marker.unhealthyCount}` : ''}`,
      result: { version: want, current: cur, reason: 'loader-revert' } };
    }
    return { outcome: 'needs-attention', note: `framework current is ${cur ?? '(unset)'}, previous is ${prev ?? '(unset)'}, this boot runs ${frameworkVersion}; expected current ${want}` };
  }

  async function recordsRestored(g) {
    const state = operationsState();
    for (const rec of Object.values(state.mods)) {
      const want = g.state.mods[rec.id];
      if (!want) { if (rec.status === 'enabled') return `${rec.id} is enabled but is not in generation ${g.n}`; continue; }
      if (rec.status === 'disabled' && want.status !== 'disabled') continue; // left disabled (schema mismatch) is a valid restore outcome
      if (rec.version !== want.version || rec.status !== want.status) return `${rec.id} is ${rec.version}/${rec.status}, generation ${g.n} has ${want.version}/${want.status}`;
    }
    for (const id of Object.keys(g.state.mods)) if (!state.mods[id]) return `${id} from generation ${g.n} is missing`;
    return null;
  }
  async function reconcileLkgRestore(op) {
    const g = lkg();
    if (!g) return hasPhase(op, 'restore-records') ? { outcome: 'needs-attention', note: 'the last-known-good generation record is unreadable' }
      : { outcome: 'failed', note: 'interrupted before any step ran' };
    const found = [];
    const recProblem = await recordsRestored(g); if (recProblem) found.push(`records not restored: ${recProblem}`);
    if (operationsState().safeMode || await exists(flagPath(FLAGS.safe))) found.push('safe mode is still on');
    const cur = await readText(layout.frameworkCurrent);
    if (cur !== g.frameworkVersion) found.push(`framework current is ${cur ?? '(unset)'}, expected ${g.frameworkVersion}`);
    let swap = null;
    if (hasPhase(op, 'swapping')) {
      swap = await switchState(op, g.appCandidate || join(layout.apps, g.appBuild));
      if (!swap.done) found.push(`app switch: ${swap.note}`);
    }
    if (found.length === 0) return { outcome: 'succeeded', note: swap?.done ? swap.note : 'all restore steps verified' };
    if (hasPhase(op, 'restore-records', 'leave-safe-mode', 'framework-current', 'swapping')) return { outcome: 'needs-attention', note: found.join('; ') };
    return { outcome: 'failed', note: `interrupted before any step ran (${found.join('; ')})` };
  }

  async function reconcileSafeMode(op) {
    const want = op.input.enter;
    const flagged = await exists(flagPath(FLAGS.safe));
    const st = operationsState().safeMode;
    if (flagged === want && st === want) return { outcome: 'succeeded', note: `safe mode is ${want ? 'on' : 'off'}` };
    if (hasPhase(op, 'set-state', 'set-flag')) return { outcome: 'needs-attention', note: `state.safeMode is ${st}, flag is ${flagged ? 'present' : 'absent'}; expected ${want}` };
    return { outcome: 'failed', note: 'interrupted before any step ran' };
  }

  async function reconcileAppPrepare(op) {
    const b = phaseNames(op).map((n) => /^build:(.+)$/.exec(n)).find(Boolean)?.[1];   // the candidate directory name
    if (b && !b.includes('/') && !b.startsWith('.')) {
      const dir = join(layout.apps, b);
      if (!(await inUse(dir))) await rm(dir, { recursive: true, force: true });
      try { for (const n of await readdir(layout.adapters)) if (n.startsWith('.refresh-')) await rm(join(layout.adapters, n), { recursive: true, force: true }); } catch { /* none */ }
    }
    return { outcome: 'failed', note: 'app preparation was interrupted; nothing was selected' };
  }

  async function reconcileOp(op) {
    if (op.outcome !== 'running') return null;
    switch (op.input.type) {
      case 'app-switch': return reconcileSwitch(op);
      case 'framework-update': return reconcileFrameworkUpdate(op);
      case 'lkg-restore': return reconcileLkgRestore(op);
      case 'safe-mode': return reconcileSafeMode(op);
      case 'app-prepare': return reconcileAppPrepare(op);
      default: return null;
    }
  }

  return {
    beginBoot, report, lkg, runOp, reconcileOp, appUpdateAvailable, update,
    /** Test/diagnostic seam: resolves when pending health-gate writes have finished. */
    idle: () => pending,
  };
}
