// Management: one method table served over the CLI socket and over a MessagePort (contracts/management.d.ts, ARCHITECTURE §14).
// Reads answer immediately. Mutations map 1:1 to operations.start(OpInput) and return {opId} without waiting (D13).
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { readJson } from '../fsutil.mjs';
import { publisherFingerprint } from '../../../contracts/layout.mjs';
import { MUTATIONS, READS, validateParams, permissionText, describePermission } from './methods.mjs';
import { declarationsOf, applyPatches, documentOf, invalidStored, storedOverrides } from '../packages/settings.mjs';
import { atLeast } from '../ops/compat.mjs';
import { consentRequestOf } from '../ops/consent.mjs';
import { MEDIA_MAX_BYTES, mediaTypeOf, mediaOf } from '../packages/manifest.mjs';
import { automaticOf } from '../ops/automatic.mjs';

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const RECENT_OPS = 10;

const errorJson = (e) => {
  if (e instanceof CodexModsError) return e.toJSON();
  return null;
};

/**
 * @param {{ operations: import('../../../contracts/host.js').Operations, packages: import('../../../contracts/host.js').Packages,
 *   runtime: import('../../../contracts/host.js').Runtime, recovery: import('../../../contracts/host.js').Recovery,
 *   mux: import('../../../contracts/host.js').Mux, bus: import('../../../contracts/host.js').Bus,
 *   log: import('../../../contracts/host.js').Log, layout: import('../../../contracts/host.js').Layout,
 *   appBuild?: string, adapterVersion?: string, graphStatus?: () => object }} opts
 *   appBuild and adapterVersion are optional extras for compat.report; without them the probe report and the LKG are consulted.
 *   graphStatus: the graph runtime's part of `diagnostics` (degraded parts, windows), when the graph runs (it does unless flags/graph-off).
 * @returns {import('../../../contracts/host.js').Management}
 */
/** Operations after which a mod's settings are read again: they change them, or restore or replace its data. */
const SETTINGS_OPS = new Set(['configure', 'update', 'rollback', 'reattach', 'remove', 'lkg-restore', 'install']);

export function createManagement(opts) {
  const { operations, runtime, recovery, mux, bus, layout } = opts;
  const log = opts.log.child ? opts.log.child('management') : opts.log;
  const startedAt = Date.now();

  // ---------------------------------------------------------------- fault counters (bus framework/fault)
  const faults = new Map(); // modId -> {count, lastError}
  bus.subscribe('framework/fault', (data) => {
    if (!data || typeof data !== 'object' || 'gap' in data) return;
    const id = typeof data.modId === 'string' ? data.modId : '(host)';
    const cur = faults.get(id) ?? { count: 0, lastError: undefined };
    cur.count += 1;
    cur.lastError = { realm: data.realm ?? 'unknown', kind: data.kind ?? 'unknown', message: String(data.message ?? '') };
    faults.set(id, cur);
  });

  // ---------------------------------------------------------------- events
  const listeners = new Set();
  let sources = [];
  let lastModsJson = null;
  const emit = (event) => {
    for (const fn of [...listeners]) {
      try { fn(event); } catch (e) { log.warn('management event listener threw', { message: String(e?.message ?? e) }); }
    }
  };
  // In the user's order (E6), else the install order
  const modsRecords = () => { const st = operations.state(); const by = operations.byRank ?? ((a, b) => st.mods[a].installSeq - st.mods[b].installSeq); return Object.keys(st.mods).sort(by).map((id) => st.mods[id]); };
  const emitModsIfChanged = () => {
    const mods = modsRecords();
    const json = JSON.stringify(mods);
    if (json === lastModsJson) return;
    lastModsJson = json;
    emit({ event: 'mods', data: { mods } });
  };
  function startSources() {
    lastModsJson = JSON.stringify(modsRecords());
    sources = [
      operations.subscribe((op) => {
        emit({ event: 'op', data: op });
        emitModsIfChanged();
        // A mod's settings changed, or its data was restored or replaced: its settings are to be read again (systems.md E3).
        if (op.outcome !== 'running' && SETTINGS_OPS.has(op.input?.type)) emit({ event: 'settings', data: { modId: op.input.modId ?? op.result?.modId ?? null } });
      }),
      bus.subscribe('framework/quarantine', () => emitModsIfChanged()),
      ...(opts.activity ? [opts.activity.onChange((modId) => emit({ event: 'activity', data: { modId } }))] : []),
      ...(opts.modUpdates?.onChange ? [opts.modUpdates.onChange(() => emit({ event: 'modUpdates', data: {} }))] : []),
      bus.subscribe('framework/probe', () => emit({ event: 'compat', data: compatReport() })),
      bus.subscribe('framework/health', (data) => { if (!(data && typeof data === 'object' && 'gap' in data)) emit({ event: 'health', data }); }),
    ];
  }
  function stopSources() {
    for (const s of sources) { try { s.dispose(); } catch { /* already gone */ } }
    sources = [];
  }
  function subscribe(fn) {
    if (listeners.size === 0) startSources();
    listeners.add(fn);
    let done = false;
    return { dispose() { if (done) return; done = true; listeners.delete(fn); if (listeners.size === 0) stopSources(); } };
  }

  // ---------------------------------------------------------------- views
  const fingerprintOf = (key) => (key ? publisherFingerprint(key) : null);

  function compatibilityOf(installed) {
    if (!installed) return { status: 'blocked', missingRequired: [], missingOptional: [] };
    let c;
    try { c = operations.compatibility(installed.manifest); } catch (e) {
      log.warn('compatibility check failed', { modId: installed.record.id, message: String(e?.message ?? e) });
      return { status: 'blocked', missingRequired: [], missingOptional: [] };
    }
    // A mod whose graph types built on another mod's, which went: degraded until it registers again (boundary review 6b).
    const lost = graphLost(installed.record.id);
    return lost ? { ...c, status: atLeast(c.status, 'degraded'), missingTypes: lost.types, missingBecause: lost.because.replace(/^mod:/, '') } : c;
  }
  function graphLost(modId) {
    try { return opts.graphStatus?.()?.degraded?.find((d) => d.owner === `mod:${modId}`) ?? null; } catch { return null; }
  }

  function modView(record) {
    const installed = operations.installed(record.id);
    return {
      id: record.id,
      name: installed?.manifest?.name ?? record.id,
      version: record.version,
      status: record.status,
      dev: Boolean(record.dev),
      publisherFingerprint: fingerprintOf(record.publisher),
      compatibility: compatibilityOf(installed).status,
      installedAt: record.installedAt,
      hasSettings: Boolean(installed?.manifest?.settings),
      pendingUpdate: record.pendingUpdate ?? null,
      quarantine: record.quarantine ?? null,
      ...(record.source ? { source: record.source } : {}),
      ...(opts.modUpdates?.offerOf(record.id) ? { release: opts.modUpdates.offerOf(record.id) } : {}),
      ...(opts.modUpdates?.problemOf(record.id) ? { checkProblem: opts.modUpdates.problemOf(record.id) } : {}),
      ...(record.lastFault ? { lastFault: record.lastFault } : {}),
      // E5: disabled by an update applied anyway, and why
      ...(record.leftBehind ? { leftBehind: record.leftBehind } : {}),
    };
  }

  async function dirBytes(dir) {
    let total = 0;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += await dirBytes(p);
      else if (e.isFile()) { try { total += (await stat(p)).size; } catch { /* raced */ } }
    }
    return total;
  }
  const dirNames = async (dir) => {
    try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); }
    catch { return []; }
  };

  /** A mod's stored settings: the app map and the overrides at narrower scopes. */
  async function storedSettings(modId) {
    const read = (f, d) => readJson(join(layout.data, modId, f), d).catch((e) => { log.warn(`${f} unreadable`, { modId, message: String(e?.message ?? e) }); return d; });
    return { app: await read('settings.json', {}), scopes: await read('settings.scopes.json', {}) };
  }
  /** mods.settings: what the framework's provider reads (systems.md E3): the declarations, the stored values, the ones not used. */
  async function modSettings(modId) {
    const installed = operations.installed(modId);
    if (!installed) throw new CodexModsError('Unavailable', `mods.settings: no installed mod "${modId}"`);
    const { list, groups } = declarationsOf(installed.manifest);
    const { app, scopes } = await storedSettings(modId);
    return { modId, declarations: list, groups, app, scopes, document: documentOf(list, app), invalid: invalidStored(list, app, scopes) };
  }
  /**
   * Scoped patches through the operations: a patch that changes nothing is no operation (`unchanged`). `fromMod`: the mod itself asks,
   * and never waits behind an operation of its own.
   */
  async function configurePatches(modId, patches, o = {}) {
    const installed = operations.installed(modId);
    if (installed?.manifest?.settings) {
      const { list } = declarationsOf(installed.manifest);
      const { app, scopes } = await storedSettings(modId);
      if (!applyPatches(list, app, scopes, patches).changed.length) return { opId: null, unchanged: true };
    }
    return { opId: await operations.start({ type: 'configure', modId, patches }, o) };
  }

  async function currentSettings(installed) {
    if (!installed.manifest.settings) return null;
    let stored = null;
    try { stored = await readJson(join(layout.data, installed.record.id, 'settings.json'), null); }
    catch (e) { log.warn('settings.json unreadable', { modId: installed.record.id, message: String(e?.message ?? e) }); }
    return documentOf(declarationsOf(installed.manifest).list, stored ?? {});
  }

  /** One of a mod's images as a data URL (framework-ui.md F6), read on request rather than kept in its state; from inside its package only. */
  async function modMedia(modId, id) {
    const installed = operations.installed(modId);
    const item = installed ? mediaOf(installed.manifest).find((x) => x.id === id) : null;
    if (!item) throw new CodexModsError('Invalid', `mods.media: ${modId} has no image "${id}"`);
    const type = mediaTypeOf(item.src);
    const root = await realpath(installed.packageDir);
    const file = await realpath(join(root, ...item.src.split('/')));
    if (!type || !file.startsWith(root + sep)) throw new CodexModsError('Denied', `mods.media: "${id}" is not an image inside its package`);
    if ((await stat(file)).size > MEDIA_MAX_BYTES) throw new CodexModsError('Invalid', `mods.media: "${id}" is larger than 1 MiB`);
    return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
  }

  async function inspect(modId) {
    const record = operations.state().mods[modId];
    const installed = operations.installed(modId);
    if (!record || !installed) throw new CodexModsError('Unavailable', `mods.inspect: no installed mod "${modId}"`);
    const view = modView(record);
    const [versions, snapshotNames, dataBytes, settings] = await Promise.all([
      dirNames(join(layout.store, modId)),
      dirNames(join(layout.snapshots, modId)),
      dirBytes(join(layout.data, modId)),
      currentSettings(installed),
    ]);
    const snapshots = [];
    for (const fromVersion of snapshotNames) {
      let at;
      try { at = (await stat(join(layout.snapshots, modId, fromVersion))).mtime.toISOString(); } catch { continue; }
      snapshots.push({ fromVersion, at });
    }
    snapshots.sort((a, b) => b.at.localeCompare(a.at));
    // v1.9 F6: per stored version, the facts that gate rollback (the Host's own rule in ops rollback).
    const rollbackable = !record.dev && record.status !== 'pending-consent';
    const versionFacts = await Promise.all(versions.sort().map(async (version) => {
      const stored = await readJson(join(layout.store, modId, version, 'mod.json'), null).catch(() => null);
      const known = stored && typeof stored === 'object';
      const dataSchemaVersion = known ? (stored.data?.schemaVersion ?? 0) : 0;
      const hasSnapshot = snapshotNames.includes(version);
      const other = rollbackable && version !== record.version;
      return { version, dataSchemaVersion, hasSnapshot,
        rollback: { codeOnly: Boolean(other && known && dataSchemaVersion === record.dataSchemaVersion), codeAndData: Boolean(other && hasSnapshot) } };
    }));
    // v1.13: preserved data generations, newest first (Operations owns the layout; older Operations fakes have none).
    let orphanedGenerations = [];
    try { orphanedGenerations = (await operations.orphanedGenerations?.(modId)) ?? []; } catch (e) { log.warn('orphanedGenerations failed', { modId, message: String(e?.message ?? e) }); }
    // Extra (not in the contract): the size of each preserved copy, so the chooser can say how much data it holds.
    orphanedGenerations = await Promise.all(orphanedGenerations.map(async (g) => ({ ...g, bytes: await dirBytes(join(layout.orphaned, modId, g.at)) })));
    const orphaned = orphanedGenerations.length > 0 || (await dirNames(layout.orphaned)).includes(modId);
    const recentOps = operations.list({ modId }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, RECENT_OPS);
    const pending = record.pendingUpdate;
    const publisherChange = pending?.newPublisher && pending.newPublisher !== record.publisher
      ? { oldFingerprint: publisherFingerprint(record.publisher), newFingerprint: publisherFingerprint(pending.newPublisher) }
      : null;
    return {
      ...view,
      manifest: installed.manifest,
      grants: [...record.grants],
      decisions: { ...(record.decisions ?? {}) },
      permissionText: permissionText(installed.manifest.permissions),
      // Extra (not in ModDetail): the permissions an update adds, so the consent screen can show the diff.
      pendingPermissionText: pending ? permissionText(pending.addedPermissions) : [],
      settings,
      // Extra (not in ModDetail), E3: the overrides at narrower scopes.
      scopedSettings: installed.manifest.settings ? (await storedSettings(modId)).scopes : null,
      // Extra, E6: every override stored at a project or a thread, as stored, also once the mod no longer declares it
      storedOverrides: await (async () => { const st = await storedSettings(modId); return storedOverrides(declarationsOf(installed.manifest).list, st.app, st.scopes); })(),
      // Extra, H6: its automatic actions as declared, each with the user's switch (public-hooks.md §3.9)
      automatic: automaticOf(record, installed.manifest),
      versionsInStore: versions,
      versions: versionFacts,
      // Extra (not in ModDetail), F12: data kept by a keep-data remove exists for this mod, so it can be reattached.
      orphaned,
      orphanedGenerations,
      snapshots,
      dataBytes,
      recentOps,
      publisherChange,
      // Extra (not in ModDetail), E6: what waits for consent, named by its id (mods.consent's `request`)
      consentRequest: consentRequestOf(record, installed.manifest),
    };
  }

  async function readText(path) {
    try { return (await readFile(path, 'utf8')).trim() || null; } catch { return null; }
  }

  function probeReport() {
    const p = bus.state('framework/probe');
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  }
  function compatReport() {
    const probe = probeReport();
    const mods = {};
    for (const record of modsRecords()) mods[record.id] = compatibilityOf(operations.installed(record.id));
    return {
      appBuild: opts.appBuild ?? probe?.appBuild ?? 'unknown',
      adapterVersion: opts.adapterVersion ?? recovery.lkg()?.adapterVersion ?? 'unknown',
      probes: probe?.items ?? {},
      // F14: false until the page has finished loading (bootstrap and mod-view probes are partial).
      complete: probe?.complete === true,
      mods,
      ...(opts.features?.log ? { features: featureSummary() } : {}),
    };
  }

  /** The feature log with this build's status (docs/design/systems.md "E4 in detail"): every feature and mechanic, and the evidence. */
  function featuresList() {
    const f = opts.features;
    const ev = f?.current?.() ?? null;
    const evidence = f?.evidence?.() ?? null;
    if (!f?.log || !ev) return { build: evidence?.build ?? null, log: null, evidence: evidenceView(evidence), features: [], mechanics: [] };
    return {
      build: evidence?.build ?? null, log: { hash: f.hash, reference: f.log.reference?.builds ?? [] }, evidence: evidenceView(evidence),
      features: Object.entries(f.log.features).map(([id, x]) => ({ id, kind: 'feature', title: x.title, version: x.version ?? 1, status: ev.features[id]?.status ?? 'unknown',
        because: ev.features[id]?.because ?? [], needs: (x.needs ?? []).map((n) => (typeof n === 'string' ? n : { anyOf: n.anyOf })), ...(x.realizedBy ? { realizedBy: x.realizedBy } : {}) })),
      mechanics: Object.entries(f.log.mechanics).map(([id, x]) => ({ id, kind: 'mechanic', title: x.title, status: ev.mechanics[id]?.status ?? 'unknown', why: ev.mechanics[id]?.why ?? '', units: x.units ?? [] })),
    };
  }
  const evidenceView = (e) => (e ? { build: e.build, from: e.from, census: !!e.facts, report: !!e.report, stale: e.stale ?? [], live: { bindings: Object.keys(e.live?.bindings ?? {}).length, anchors: e.live?.anchors?.length ?? 0 },
    unlogged: opts.features?.unlogged?.() ?? [] } : null);
  function featureSummary() {
    const ev = opts.features.current();
    const count = (o) => Object.values(o ?? {}).reduce((acc, x) => { acc[x.status] = (acc[x.status] ?? 0) + 1; return acc; }, {});
    return { build: opts.features.evidence()?.build ?? null, hash: opts.features.hash, features: count(ev?.features), mechanics: count(ev?.mechanics) };
  }

  function diagnostics() {
    const mods = {};
    for (const record of modsRecords()) {
      const f = faults.get(record.id);
      mods[record.id] = {
        status: record.status,
        runtime: runtime.status(record.id),
        faults: f?.count ?? 0,
        ...(f?.lastError ? { lastError: f.lastError } : {}),
      };
    }
    const hostFaults = faults.get('(host)');
    return {
      host: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        developerMode: operations.state().developerMode === true,
        safeMode: operations.state().safeMode,
        activeMods: runtime.active(),
        health: bus.state('framework/health') ?? null,
        probe: probeReport() ? { complete: probeReport().complete === true, at: probeReport().at ?? null } : null,
        faults: [...faults.values()].reduce((n, f) => n + f.count, 0),
        ...(hostFaults?.lastError ? { lastError: hostFaults.lastError } : {}),
      },
      mux: mux.metrics(),
      mods,
      // The mods' presentation rules the Host holds (docs/design/systems.md E2).
      ...(typeof runtime.presentationRules === 'function' ? { presentationRules: runtime.presentationRules() } : {}),
      ...(opts.graphStatus ? { graph: opts.graphStatus() } : {}),
    };
  }

  async function updatesStatus() {
    const [current, previous] = await Promise.all([readText(layout.frameworkCurrent), readText(layout.frameworkPrevious)]);
    const base = { framework: { current, previous }, app: recovery.appUpdateAvailable() ?? null, lkg: recovery.lkg() ?? null };
    // E5: the offer, the staging, the plan with its verdict, the policy (docs/design/systems.md "E5 in detail")
    const u = opts.updates?.detector ? await opts.updates.detector.status() : null;
    const installing = operations.list({ running: true }).some((o) => o.input?.type === 'copy-update');
    // F11: how the last try of this offer ended, when it did not succeed (the update page says it; the automatic policy will not try it again)
    const tried = u?.offer ? operations.list({}).filter((o) => o.input?.type === 'copy-update' && o.result?.offer === u.offer.id && o.outcome !== 'running')
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).at(-1) : null;
    const lastApply = tried && tried.outcome !== 'succeeded' ? { outcome: tried.outcome, op: tried.id, at: tried.endedAt ?? tried.startedAt, ...(tried.note || tried.error?.message ? { note: String(tried.error?.message ?? tried.note) } : {}) } : null;
    return u ? { ...base, ...u, installing, lastApply } : base;
  }
  opts.updates?.onEvent?.(() => { void updatesStatus().then((data) => emit({ event: 'updates', data })).catch(() => {}); });

  // ---------------------------------------------------------------- the method table
  async function dispatch(method, rawParams) {
    if (Object.hasOwn(MUTATIONS, method)) {
      const spec = MUTATIONS[method];
      const params = validateParams(method, rawParams, spec.schema);
      if (method === 'updates.app.apply') {
        const u = opts.updates?.detector ? await opts.updates.detector.status() : null;
        if (!u?.plan || u.plan.candidate !== params.candidate) {
          throw new CodexModsError('Conflict', 'this candidate has no staged plan: stage the update (updates.stage) and apply its plan (updates.apply)');
        }
        return { opId: await operations.start({ type: 'copy-update', plan: u.plan.hash }) };
      }
      if (method === 'mods.configure') {
        return configurePatches(params.modId, params.patches);
      }
      // F10: a mod from GitHub: its latest release found and downloaded first, then installed as a file is; an offered update applied
      if (method === 'mods.installFromGitHub') {
        if (!opts.modUpdates) throw new CodexModsError('Unavailable', 'installing from GitHub is not available here');
        return { opId: await opts.modUpdates.install(params.repo, params.mod) };
      }
      if (method === 'mods.applyUpdate') {
        if (!opts.modUpdates) throw new CodexModsError('Unavailable', 'mod updates are not available here');
        return { opId: await opts.modUpdates.apply(params.modId) };
      }
      const opId = await operations.start(spec.op(params));
      return { opId };
    }
    if (!Object.hasOwn(READS, method)) throw new CodexModsError('Invalid', `Unknown method "${method}"`);
    const p = validateParams(method, rawParams, READS[method]);
    switch (method) {
      case 'mods.list': return { mods: modsRecords().map(modView) };
      case 'mods.inspect': return inspect(p.modId);
      case 'mods.media': return modMedia(p.modId, p.media);
      case 'mods.activity': return opts.activity ? opts.activity.read(p.modId, { after: p.after }) : { lines: [], cursor: null, dropped: false, since: startedAt };
      case 'mods.settings': return modSettings(p.modId);
      case 'ops.get': {
        const op = operations.get(p.opId);
        if (!op) throw new CodexModsError('Unavailable', `ops.get: no operation "${p.opId}"`);
        return op;
      }
      case 'ops.list': return {
        ops: operations.list({ ...(p.modId === undefined ? {} : { modId: p.modId }), ...(p.running === undefined ? {} : { running: p.running }) }),
      };
      case 'compat.report': return compatReport();
      case 'features.list': return featuresList();
      case 'updates.status': return updatesStatus();
      case 'updates.check': {
        // the mods from GitHub are checked with the copy (F10)
        const mods = opts.modUpdates?.check() ?? Promise.resolve();
        const out = opts.updates?.detector ? await opts.updates.detector.check().then(() => updatesStatus()) : await updatesStatus();
        await mods;
        return out;
      }
      case 'updates.stage': { const r = opts.updates?.detector ? await opts.updates.detector.stageNow() : null; return { ...(await updatesStatus()), staged: r?.plan ? r.plan.hash : null, problem: r?.problem ?? null }; }
      case 'updates.later': {
        const off = opts.updates?.detector?.offer();
        if (off) await opts.updates.state.update((st) => { if (!st.dismissed.includes(off.id)) st.dismissed.push(off.id); });
        await opts.updates?.cancel?.();   // F11: Cancel while it prepares means later, not a retry
        return updatesStatus();
      }
      case 'updates.openOriginal': {
        if (!opts.updates?.openOriginal) throw new CodexModsError('Unavailable', 'the original Codex cannot be opened from here');
        await opts.updates.openOriginal();
        return { opened: true };
      }
      case 'updates.policy': { await opts.updates?.state.update((st) => { st.policy = p.policy; }); return updatesStatus(); }
      case 'ops.acknowledge': return operations.acknowledge(p.opId);
      case 'framework.developerMode': { const r = await operations.setDeveloperMode(p.on); emit({ event: 'mods', data: { mods: modsRecords().map(modView) } }); return r; }
      case 'mods.order': { const r = await operations.setOrder(p.mods); try { runtime?.reranked?.(); } catch (e) { log.warn('the rules could not be ranked again', { message: String(e?.message ?? e) }); } emitModsIfChanged(); return r; }
      case 'diagnostics': return diagnostics();
      case 'events.subscribe': return { subscribed: true };
      default: throw new CodexModsError('Invalid', `Unknown method "${method}"`);
    }
  }

  async function handle(req) {
    const id = req && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
    try {
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw new CodexModsError('Invalid', 'Request must be a JSON object');
      if (id === null) throw new CodexModsError('Invalid', 'Request needs a string or number "id"');
      if (typeof req.method !== 'string') throw new CodexModsError('Invalid', 'Request needs a string "method"');
      const result = await dispatch(req.method, req.params);
      return { id, ok: true, result };
    } catch (e) {
      const json = errorJson(e);
      if (json) return { id, ok: false, error: json };
      log.error('management method failed', { method: req?.method, message: String(e?.message ?? e) });
      return { id, ok: false, error: { code: 'Unavailable', message: `Internal error in ${req?.method}: ${String(e?.message ?? e)}` } };
    }
  }

  // ---------------------------------------------------------------- shared connection logic
  /**
   * One connection or port. `send(obj)` writes a message; `needsToken` enforces the socket handshake.
   * Returns {message(obj), close()}.
   */
  function session(send, { token = null, onDeny = () => {} } = {}) {
    let authed = token === null;
    let sub = null;
    let closed = false;
    const safeSend = (obj) => { if (!closed) send(obj); };
    return {
      async message(req) {
        if (closed) return;
        if (!authed) {
          const supplied = req && typeof req === 'object' ? req.token : undefined;
          if (!tokenMatches(supplied, token)) {
            safeSend({ id: req && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null, ok: false,
              error: { code: 'Denied', message: 'Missing or invalid management token' } });
            closed = true; // nothing else is answered on a connection that failed authentication
            onDeny();
            return;
          }
          authed = true;
        }
        const res = await handle(req);
        if (closed) return;
        safeSend(res);
        if (res.ok && req.method === 'events.subscribe' && !sub) {
          sub = subscribe((event) => safeSend(event));
        }
      },
      malformed(message) {
        safeSend({ id: null, ok: false, error: { code: 'Invalid', message } });
      },
      close() { closed = true; if (sub) { sub.dispose(); sub = null; } },
      get authed() { return authed; },
    };
  }

  function tokenMatches(supplied, token) {
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---------------------------------------------------------------- CLI socket
  async function listen(socketPath, tokenPath) {
    const dir = dirname(socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    if (Buffer.byteLength(socketPath) > 100) throw new CodexModsError('Invalid', `Socket path is too long for a Unix socket: ${socketPath}`);
    await removeStaleSocket(socketPath);

    const token = randomBytes(32).toString('hex');
    const tmp = `${tokenPath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${token}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, tokenPath);

    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      let overflow = false;
      const ses = session((obj) => {
        if (socket.destroyed) return;
        if (socket.writableLength > MAX_QUEUED_BYTES) { log.warn('management client too slow; closing'); socket.destroy(); return; }
        socket.write(`${JSON.stringify(obj)}\n`);
      }, { token, onDeny: () => socket.end() });
      socket.on('data', (chunk) => {
        if (overflow) return;
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) processLine(line);
          if (socket.destroyed) return;
        }
        if (buffer.length > MAX_LINE_BYTES) {
          overflow = true;
          ses.malformed('Request line is too long');
          socket.end();
        }
      });
      function processLine(line) {
        let req;
        try { req = JSON.parse(line); } catch {
          if (!ses.authed) {
            // A first line that is not JSON cannot carry the token.
            ses.message(null);
          } else ses.malformed('Malformed JSON line');
          return;
        }
        ses.message(req).catch((e) => log.error('management session failed', { message: String(e?.message ?? e) }));
      }
      socket.on('close', () => { sockets.delete(socket); ses.close(); });
      socket.on('error', () => { /* peer went away */ });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
      });
      await chmod(socketPath, 0o600);
    } catch (e) {
      await rm(tokenPath, { force: true });
      throw e;
    }
    log.info('management socket listening');
    let disposed = false;
    return {
      async dispose() {
        if (disposed) return;
        disposed = true;
        for (const s of sockets) s.destroy();
        await new Promise((resolve) => server.close(() => resolve()));
        await rm(socketPath, { force: true });
        await rm(tokenPath, { force: true });
      },
    };
  }

  async function removeStaleSocket(socketPath) {
    let exists = true;
    try { await stat(socketPath); } catch { exists = false; }
    if (!exists) return;
    const alive = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (alive) throw new CodexModsError('Conflict', `Another Host is already serving ${socketPath}`);
    await rm(socketPath, { force: true });
  }

  // ---------------------------------------------------------------- MessagePort (Adjustments)
  function attach(port) {
    const ses = session((obj) => port.post(obj));
    const msg = port.onMessage((m) => {
      if (m === null || typeof m !== 'object' || Array.isArray(m)) { ses.malformed('Message must be a JSON object'); return; }
      ses.message(m).catch((e) => log.error('management port session failed', { message: String(e?.message ?? e) }));
    });
    let closeSub;
    let done = false;
    const dispose = () => { if (done) return; done = true; ses.close(); msg.dispose(); closeSub?.dispose(); };
    closeSub = port.onClose(dispose);
    return { dispose };
  }

  return { handle, subscribe, listen, attach, configurePatches };
}

export { describePermission, permissionText };
