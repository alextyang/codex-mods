// The framework's provider (docs/design/systems.md S3; docs/graph/07-framework.md): CodexMods, its Mods and their Operations, served over the
// management dispatcher. Reads follow the management events (`mods`, `op`, `compat`, `health`); every operation is a management mutation:
// the method table validates it, Operations journals it, and the graph operation answers with the Operation's ref as soon as the mutation
// is accepted. Acceptance is not the outcome: the Operation's own state follows, through the `op` events. There is no second lifecycle
// path and no second journal. Who may act on these instances is the policy's (S4: the user and the framework only).
// Node built-ins only.
import { stat } from 'node:fs/promises';
import { CodexModsError } from '../../../../../sdk/errors.mjs';
import { describePermission } from '../../../management/methods.mjs';
import { choicesOf, defaultOf, enforced } from '../../../permissions.mjs';
import { createModSettings } from './settings.mjs';

/** The provider id in refs: the id the framework already reserves (packages/manifest.mjs), so no mod can claim these refs. */
export const PROVIDER = 'codexmods.framework';
const ref = (type, id) => Object.freeze({ type, provider: PROVIDER, id });
export const refs = Object.freeze({
  codexMods: () => ref('CodexMods', 'codexmods'),
  mod: (id) => ref('Mod', id),
  operation: (id) => ref('Operation', id),
  feature: (id) => ref('Feature', id),
  copyUpdate: () => ref('CopyUpdate', 'copy'),
  app: () => Object.freeze({ type: 'App', provider: 'codex', id: 'codex' }),
});

/** What the provider declares (for coverage, as the native provider's realizes.mjs). */
export const realizes = {
  types: ['CodexMods', 'Mod', 'Operation', 'Feature', 'CopyUpdate', 'Setting', 'SettingsSection'],
  operations: {
    CodexMods: ['install', 'installFromGitHub', 'setDeveloperMode', 'enterSafeMode', 'leaveSafeMode', 'restoreLastKnownGood', 'checkForUpdates', 'setUpdatePolicy', 'setModOrder'],
    Update: ['download', 'install', 'later'], CopyUpdate: ['installAnyway', 'apply', 'openOriginal'], Operation: ['acknowledge'],
    Mod: ['consent', 'enable', 'disable', 'clearQuarantine', 'reload', 'setPermission', 'applyUpdate', 'image', 'markSeen', 'activity', 'update', 'rollback', 'remove', 'reattach', 'clearOverrides', 'setAutomatic', 'setPolicy'],
    Setting: ['set', 'reset'],
    SettingsSection: ['resetAll'],
  },
  supports: { CopyUpdate: ['build', 'framework', 'plan', 'problem', 'notes', 'step', 'support', 'automatic', 'lastApply', 'verdicts'], CodexMods: ['lastKnownGood', 'previousVersion', 'lastChecked', 'checkProblem'], Mod: ['publisher', 'description', 'author', 'glyph', 'installedAt', 'stopSeen', 'intelligence', 'source', 'release', 'checkProblem', 'availableVersion', 'quarantine', 'lastFault', 'problem', 'consentRequest'], Operation: ['phase', 'endedAt', 'message', 'waitingFor', 'acknowledgedAt'],
    Setting: ['key', 'description', 'choices', 'overridden', 'scopes', 'control', 'icon', 'min', 'max', 'step', 'unit', 'placeholder', 'group', 'requires', 'needs', 'structured', 'active'], SettingsSection: ['icon', 'media'] },
  events: { CodexMods: ['changed'], Mod: ['changed', 'activity'], Operation: ['progressed', 'finished'] },
  links: { CopyUpdate: ['app', 'codexMods'], CodexMods: ['mods', 'operations', 'features', 'update', 'app'], Mod: ['codexMods', 'settings', 'features'], Feature: ['needs'], Operation: ['mod', 'codexMods'], Setting: ['section', 'definedBy', 'project', 'thread'], SettingsSection: ['parent'] },
};

const STATUS = { 'pending-consent': 'pendingConsent', enabled: 'enabled', disabled: 'disabled', quarantined: 'quarantined' };
const OUTCOME = { running: 'running', succeeded: 'succeeded', failed: 'failed', reverted: 'reverted', 'needs-attention': 'needsAttention' };
/** An operation record's type -> the Operation's kind. */
export const KIND = {
  install: 'install', consent: 'consent', enable: 'enable', disable: 'disable', configure: 'configure', update: 'update', rollback: 'rollback',
  remove: 'remove', reattach: 'reattach', 'clear-quarantine': 'clearQuarantine', reload: 'reload', 'set-permission': 'setPermission', 'set-automatic': 'setAutomatic', 'set-policy': 'setPolicy', 'framework-update': 'frameworkUpdate',
  'app-prepare': 'appPrepare', 'app-switch': 'appSwitch', 'copy-update': 'copyUpdate', 'safe-mode': 'safeMode', 'lkg-restore': 'lastKnownGood',
};
/** Operations kept in the graph: every one running or needing attention, and the latest others. */
const RECENT_OPS = 50;

const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : undefined; };
/** A mod's rules as Mod.places: kind, presentation and slot, each once, in a stable order. */
export const placesOf = (rules) => [...new Map((rules ?? []).filter((r) => typeof r?.kind === 'string').map((r) => {
  const x = { kind: String(r.kind), ...(r.presentation ? { presentation: String(r.presentation) } : {}), ...(r.slot ? { slot: String(r.slot) } : {}) };
  return [`${x.presentation ?? ''}|${x.slot ?? ''}|${x.kind}`, x];
})).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, x]) => x);
/** Where a mod came from, as Mod.source says it (F10): a GitHub release's repository, tag and digest, or a folder's path. */
const sourceOf = (src) => (src?.kind === 'github' ? { kind: 'github', repo: String(src.repo), tag: String(src.tag), digest: String(src.digest), ...(src.mod ? { mod: String(src.mod) } : {}) }
  : src?.kind === 'folder' ? { kind: 'folder', path: String(src.path) } : { kind: 'file' });

/** One sentence per thing a mod lacks on this build (Mod.reasons): compatibility's own (docs/design/systems.md "E4 in detail"). */
/** The catalog's mods as CodexMods.recommended (F10): each well-formed entry with the repository it comes from; anything else is left out. */
export function recommendedOf(catalog) {
  const repo = typeof catalog?.repo === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(catalog.repo) ? catalog.repo : null;
  if (!repo || !Array.isArray(catalog.mods)) return [];
  const ok = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  return catalog.mods.filter((m) => m && /^[a-z0-9.-]{3,128}$/.test(m.id) && ok(m.name, 80) && ok(m.description, 400) && (m.glyph === undefined || ok(m.glyph, 40)))
    .slice(0, 50).map((m) => ({ id: m.id, name: m.name, description: m.description, ...(m.glyph ? { glyph: m.glyph } : {}), repo }));
}

export function reasonsOf(compat) {
  if (!compat || typeof compat !== 'object') return [];
  const out = [];
  if (Array.isArray(compat.reasons)) for (const r of compat.reasons) out.push(r.sentence);
  else {
    for (const m of compat.missingRequired ?? []) out.push(`It needs ${m}, which this build of the app lacks.`);
    for (const m of compat.missingOptional ?? []) out.push(`It works without ${m}, which this build of the app lacks.`);
  }
  if (compat.leftBehind) out.push(`The update of ${compat.leftBehind.at.slice(0, 10)} left it disabled: ${compat.leftBehind.why.join(' ') || 'it was at risk on the new build'} Turn it on again when you want it.`);
  if (Array.isArray(compat.missingTypes) && compat.missingTypes.length) {
    out.push(`Its types ${compat.missingTypes.join(', ')} build on ${compat.missingBecause ?? 'another mod'}, which is not running.`);
  }
  return out;
}

/**
 * What a mod is now (docs/design/framework-ui.md F5), the first that holds. A quarantine alone is not a stop: a package that cannot be read and a blocked mod are quarantined too. A
 * pending update shows beside any of them, and in a window's list moves only a mod that is on.
 */
export function modStateOf({ status, compatibility, problem, consentRequest, reloading }) {
  if (reloading) return 'reloading';
  if (status === 'pendingConsent' || consentRequest) return 'consent';
  if (problem) return 'missing';
  if (compatibility === 'blocked') return 'incompatible';
  if (status === 'quarantined') return 'stopped';
  return status === 'enabled' ? 'on' : 'off';
}

/** The other kinds of tool a mod's model use may ask for, as consent says them. */
const TOOL_WORDS = { web: 'web search', network: 'the network', files: 'your files', toolServers: 'tool servers', plugins: 'plugins', computerUse: 'computer use' };
/**
 * A Permission value per declared permission (and per permission a waiting update adds): the framework's words and risk, which are never the mod's to say, with the mod's own label
 * and detail beside them (`permissionNotes`); an optional one with its decision and what it may be (framework-ui.md F8).
 */
export function permissionsOf(manifest, grants, added = [], decisions = {}) {
  const notes = manifest?.permissionNotes ?? {};
  const one = (id, granted, optional) => {
    const lines = describePermission(id);
    const risk = lines.some((l) => l.risk === 'high') ? 'high' : lines.some((l) => l.risk === 'medium') ? 'medium' : 'low';
    const note = notes[id];
    return { id, text: lines.map((l) => l.text).join('. '), risk, granted, optional, enforced: enforced(id),
      ...(note?.label ? { label: note.label } : {}), ...(note?.detail ? { detail: note.detail } : {}),
      ...(optional ? { decision: decisions?.[id] ?? defaultOf(id), choices: choicesOf(id) } : {}) };
  };
  const out = (manifest?.permissions ?? []).map((p) => one(p, grants.includes(p), false));
  for (const p of manifest?.optionalPermissions ?? []) out.push(one(p, decisions?.[p] === 'allow', true));
  // its model use (GOAL.md goal 16): never granted here, off until the user turns it on on its page (mod intelligence keeps the switch)
  if (manifest?.intelligence) {
    const tools = manifest.intelligence.tools ?? [];
    out.push({ id: 'intelligence', text: `Use models through your Codex account, off until you turn it on on its page${tools.length ? `, and ask for ${tools.map((t) => TOOL_WORDS[t] ?? t).join(', ')} there` : ''}`,
      risk: 'medium', granted: false, optional: true, enforced: true, label: 'Model use', detail: manifest.intelligence.why });
  }
  for (const p of added) if (!out.some((x) => x.id === p)) out.push(one(p, false, false));
  return out;
}

/** A scope key's Project or Thread ref (its provider and id; not known to be in the graph). */
export function defaultScopeOf(scopeKey) {
  const m = /^(project|thread):([^:]+):([^:]+)$/.exec(String(scopeKey));
  return m ? { kind: m[1], ref: { type: m[1] === 'project' ? 'Project' : 'Thread', provider: decodeURIComponent(m[2]), id: decodeURIComponent(m[3]) }, seen: false } : null;
}

/** A kept generation's time: its id is an ISO time, with `-<n>` when two fell on the same millisecond. */
const atOf = (generation) => ms(String(generation).replace(/-\d+$/, '')) ?? 0;

/**
 * The Mod instance of a management detail (`mods.inspect`), its compatibility (`compat.report`'s entry) and its runtime (`diagnostics`'
 * entry: whether it runs, its faults). A mod whose detail cannot be read is its record alone (`mods.list`'s view) with its `problem`.
 * `scopeOf`: a stored override's scope key as the graph has it (`{ ref, seen }`), for Mod.storedOverrides.
 */
export function modData(detail, compat, run = null, problem = null, scopeOf = defaultScopeOf, policies = [], agent = null, { reloading = false, fresh = false, places = [], seenStop = null } = {}) {
  const status = compat?.status && compat.status !== 'compatible' ? compat.status : detail.compatibility ?? 'compatible';
  const pending = detail.pendingUpdate;
  const cr = detail.consentRequest;
  const lifecycle = STATUS[detail.status] ?? 'disabled';
  const manifest = detail.manifest ?? {};
  return {
    ref: refs.mod(detail.id),
    state: {
      name: detail.name, version: detail.version, status: lifecycle, compatibility: status,
      state: modStateOf({ status: lifecycle, compatibility: status, problem, consentRequest: cr, reloading }), new: fresh,
      // F13: where its rules say it presents, each once (declared, not where it drew); F15: whether its stop was looked at
      places: placesOf(places),
      ...(detail.quarantine ? { stopSeen: seenStop !== null && seenStop === (ms(detail.quarantine.at) ?? 0) } : {}),
      ...(manifest.intelligence ? { intelligence: { why: manifest.intelligence.why, tools: [...(manifest.intelligence.tools ?? [])] } } : {}),
      ...(typeof manifest.author === 'string' ? { author: manifest.author } : {}),
      ...(typeof manifest.glyph === 'string' ? { glyph: manifest.glyph } : {}),
      about: Array.isArray(manifest.about) ? manifest.about : [],
      media: (Array.isArray(manifest.media) ? manifest.media : []).map((x) => ({ id: x.id, ...(x.caption ? { caption: x.caption } : {}), ...(x.aspect ? { aspect: x.aspect } : {}) })),
      testedWith: Array.isArray(manifest.testedWith) ? manifest.testedWith : [],
      ...(ms(detail.installedAt) !== undefined ? { installedAt: ms(detail.installedAt) } : {}),
      reasons: reasonsOf({ ...(compat ?? {}), ...(detail.leftBehind && detail.status === 'disabled' ? { leftBehind: detail.leftBehind } : {}) }), development: Boolean(detail.dev),
      permissions: permissionsOf(detail.manifest, detail.grants ?? [], pending?.addedPermissions ?? [], detail.decisions ?? {}),
      ...(detail.publisherFingerprint ? { publisher: detail.publisherFingerprint } : {}),
      ...(typeof detail.manifest?.description === 'string' ? { description: detail.manifest.description } : {}),
      ...(pending?.version ? { availableVersion: pending.version } : {}),
      ...(detail.quarantine ? { quarantine: { reason: detail.quarantine.reason, at: ms(detail.quarantine.at) ?? 0 } } : {}),
      ...(detail.source ? { source: sourceOf(detail.source) } : {}),
      ...(detail.release ? { release: { version: String(detail.release.version), notes: String(detail.release.notes ?? ''), addedPermissions: (detail.release.addedPermissions ?? []).map(String), verdict: detail.release.verdict,
        ...(detail.release.publisherChange ? { publisherChange: true } : {}), ...(detail.release.repoChange ? { repoChange: { from: String(detail.release.repoChange.from), to: String(detail.release.repoChange.to) } } : {}) } } : {}),
      ...(detail.checkProblem ? { checkProblem: String(detail.checkProblem) } : {}),
      ...(detail.lastFault ? { lastFault: { at: ms(detail.lastFault.at) ?? 0, message: String(detail.lastFault.message), where: String(detail.lastFault.where), ...(detail.lastFault.stack ? { stack: String(detail.lastFault.stack) } : {}) } } : {}),
      running: run?.runtime === 'active', faults: Number(run?.faults ?? 0) || 0,
      ...(problem ? { problem } : {}),
      versions: (detail.versions ?? []).filter((v) => v.version !== detail.version && (v.rollback?.codeOnly || v.rollback?.codeAndData))
        .map((v) => ({ version: v.version, codeOnly: Boolean(v.rollback.codeOnly), withData: Boolean(v.rollback.codeAndData) })),
      keptData: (detail.orphanedGenerations ?? []).map((g) => ({ generation: g.at, at: atOf(g.at), ...(g.version ? { version: g.version } : {}), bytes: Number(g.bytes ?? 0) || 0 })),
      dataBytes: Number(detail.dataBytes ?? 0) || 0,
      storedOverrides: (Array.isArray(detail.storedOverrides) ? detail.storedOverrides : []).map((x) => ({ x, s: scopeOf(x.scope) })).filter(({ s }) => s)
        .map(({ x, s }) => ({ key: x.key, kind: s.kind, scope: s.ref, value: x.value ?? null, seen: s.seen, valid: x.valid === true })),
      // H6 (public-hooks.md §3.9): what it may do without asking, each with the user's switch
      automatic: (Array.isArray(detail.automatic) ? detail.automatic : []).map((a) => ({ id: a.id, operation: a.operation, why: a.why, perHour: a.perHour,
        ...(a.where !== undefined ? { where: a.where } : {}), ...(a.args !== undefined ? { args: a.args } : {}), on: a.on === true })),
      // H6 (public-hooks.md §3.7): its policies as it registered them, each with the user's switch
      policies: (Array.isArray(policies) ? policies : []).map((p) => ({ id: p.id, title: p.title, spec: p.spec, on: p.on === true })),
      // H9 (public-hooks.md §3.16): what it gives the agent now
      agent: { tools: (agent?.tools ?? []).map((t) => ({ name: String(t.name), description: String(t.description ?? '') })), skills: (agent?.skills ?? []).map(String),
        instructions: (agent?.instructions ?? []).filter((k) => k === 'text' || k === 'perTurn') },
      ...(cr ? { consentRequest: { id: cr.id, kind: cr.kind, version: cr.version, ...(cr.publisher ? { publisher: cr.publisher } : {}), permissions: cr.permissions,
        addedPermissions: cr.addedPermissions, ...(cr.publisherChange ? { publisherChange: { from: cr.publisherChange.from ?? 'none', to: cr.publisherChange.to ?? 'none' } } : {}),
        ...(cr.repoChange ? { repoChange: { from: String(cr.repoChange.from), to: String(cr.repoChange.to), another: cr.repoChange.another === true } } : {}),
        ...(cr.source ? { source: { repo: String(cr.source.repo), tag: String(cr.source.tag), digest: String(cr.source.digest) } } : {}) } } : {}),
    },
    // A mod with settings has its section (systems.md E3), which the framework's settings put.
    links: {
      codexMods: refs.codexMods(), ...(detail.manifest?.settings ? { settings: { type: 'SettingsSection', provider: PROVIDER, id: `mod:${detail.id}` } } : {}),
      features: (compat?.features ?? []).map(refs.feature),
    },
  };
}

/** The Feature instances of `features.list` (docs/design/systems.md "E4 in detail"), with one per id a mod names that the log lacks. */
export function featureData(list, named = []) {
  const out = [];
  const known = new Set();
  const needsOf = (needs) => [...new Set((needs ?? []).flatMap((n) => (typeof n === 'string' ? [n] : n?.anyOf ?? [])))].map(refs.feature);
  for (const f of list?.features ?? []) {
    known.add(f.id);
    out.push({ ref: refs.feature(f.id), state: { kind: 'feature', title: f.title, version: String(f.version ?? 1), status: f.status }, links: { needs: needsOf([...(f.needs ?? []), ...(f.realizedBy ?? [])]) } });
  }
  for (const m of list?.mechanics ?? []) {
    known.add(m.id);
    out.push({ ref: refs.feature(m.id), state: { kind: 'mechanic', title: m.title, version: '1', status: m.status }, links: { needs: [] } });
  }
  for (const id of named) {
    if (known.has(id)) continue;
    known.add(id);
    const mechanic = !/^(graph|presentation|slot|sdk):/.test(id);
    out.push({ ref: refs.feature(id), state: { kind: mechanic ? 'mechanic' : 'feature', title: id, version: '1', status: 'unknown' }, links: { needs: [] } });
  }
  return out;
}

/** The CopyUpdate of management's `updates.status` (docs/design/systems.md "E5 in detail"): one when there is an offer, else null. */
export function copyUpdateData(u) {
  if (!u?.offer) return null;
  const plan = u.plan;
  const build = u.offer.build && u.offer.build !== u.offer.copyBuild ? { from: u.offer.copyBuild, to: u.offer.build } : null;
  const fw = plan?.framework ?? u.offer.framework ?? null;
  const state = u.installing ? 'installing' : u.staging ? 'downloading' : plan ? 'ready' : 'available';
  return {
    ref: refs.copyUpdate(),
    state: {
      version: `${u.offer.build ?? u.offer.copyBuild}${fw ? ` with framework ${fw.to}` : ''}`, state,
      ...(build ? { build } : {}), ...(fw ? { framework: { from: fw.from, to: fw.to } } : {}),
      mods: (plan?.mods ?? []).map((m) => ({ mod: refs.mod(m.id), from: m.from, to: m.to, addedPermissions: (plan?.consentNeeded ?? []).find((c) => c.id === m.id)?.addedPermissions ?? [] })),
      ...(plan ? { plan: plan.hash } : {}), held: Boolean(plan?.held),
      risks: (plan?.risks ?? []).flatMap((r) => (r.sentences.length ? r.sentences : [`${r.mod} is ${r.status} on the new build.`]).map((sentence, i) => ({
        mod: refs.mod(r.mod), ...(r.features?.[i] ? { feature: refs.feature(r.features[i]) } : {}), sentence }))),
      checked: plan?.checked ?? 'static',
      ...(u.problem ? { problem: u.problem.problem } : {}),
      dismissed: Boolean(u.offer.dismissed),
      ...(u.staging?.step ? { step: String(u.staging.step) } : {}),
      ...(u.support ? { support: { status: u.support.status, ...(typeof u.support.listed === 'boolean' ? { listed: u.support.listed } : {}), ...(u.support.problem ? { problem: String(u.support.problem) } : {}) } } : {}),
      ...(u.auto ? { automatic: { will: u.auto.will === true, ...(u.auto.why ? { why: u.auto.why } : {}) } } : {}),
      ...(u.lastApply ? { lastApply: { outcome: OUTCOME[u.lastApply.outcome] ?? 'failed', at: ms(u.lastApply.at) ?? 0, ...(u.lastApply.note ? { note: String(u.lastApply.note) } : {}) } } : {}),
      ...(plan?.display ? { verdicts: plan.display.map((d) => ({ mod: refs.mod(d.id), version: String(d.version), on: d.on === true, now: d.now, after: d.verdict, unknown: d.unknown === true, tested: d.tested === true,
        uses: (d.uses ?? []).map((x) => String(x.title ?? x.id)), changed: (d.uses ?? []).filter((x) => (d.changed ?? []).includes(x.id)).map((x) => String(x.title ?? x.id)),
        missing: (d.uses ?? []).filter((x) => (d.missing ?? []).includes(x.id)).map((x) => String(x.title ?? x.id)),
        unchecked: (d.uses ?? []).filter((x) => (d.unchecked ?? []).includes(x.id)).map((x) => String(x.title ?? x.id)),
        ...(d.candidate ? { candidate: { version: String(d.candidate.version), after: d.candidate.verdict, addedPermissions: (d.candidate.addedPermissions ?? []).map(String), from: d.candidate.from === 'github' ? 'github' : 'release' } } : {}) })) } : {}),
    },
    links: { app: refs.app(), codexMods: refs.codexMods() },
  };
}

/** The Operation instance of an operation record. */
export function operationData(op) {
  const last = op.phases?.[op.phases.length - 1]?.name;
  const message = op.error?.message ?? op.note;
  return {
    ref: refs.operation(op.id),
    state: {
      kind: KIND[op.input?.type] ?? 'install', outcome: OUTCOME[op.outcome] ?? 'running', startedAt: ms(op.startedAt) ?? 0,
      ...(last ? { phase: last } : {}),
      ...(ms(op.endedAt) !== undefined ? { endedAt: ms(op.endedAt) } : {}),
      ...(typeof message === 'string' && message ? { message } : {}),
      ...(op.awaiting === 'consent' ? { waitingFor: 'consent' } : {}),
      ...(ms(op.acknowledgedAt) !== undefined ? { acknowledgedAt: ms(op.acknowledgedAt) } : {}),
    },
    links: { mod: typeof op.input?.modId === 'string' ? refs.mod(op.input.modId) : null, codexMods: refs.codexMods() },
  };
}

/** The ops the graph keeps: running and needing attention (not yet acknowledged) first, then the latest others, acknowledged ones among
 * them, at most RECENT_OPS in all but the first (E6 review: acknowledged ones are bounded like any finished one). */
export function keptOps(ops) {
  const sorted = [...ops].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const isOpen = (o) => o.outcome === 'running' || (o.outcome === 'needs-attention' && !o.acknowledgedAt);
  const open = sorted.filter(isOpen);
  const rest = sorted.filter((o) => !isOpen(o)).slice(0, RECENT_OPS);
  return [...open, ...rest];
}

/**
 * @param {{ graph: object, management: { handle(req: object): Promise<object>, subscribe(fn: Function): { dispose(): void } },
 *   frameworkVersion: string, log?: object, catalog?: object }} o  `catalog`: framework/catalog.json, the mods the Mods page recommends
 */
export function createFrameworkSource(o) {
  const { graph, management } = o;
  const log = o.log ?? { info() {}, warn() {}, error() {}, debug() {} };
  let n = 0, disposed = false;

  /** A management call, as its transports make them; an error answer is thrown as the CodexModsError it names. */
  async function call(method, params) {
    const res = await management.handle({ id: `graph-${++n}`, method, params });
    if (res?.ok) return res.result;
    throw new CodexModsError(res?.error?.code ?? 'Unavailable', res?.error?.message ?? `${method} failed`);
  }

  /** A mutation: its Operation is put at once (so the ref resolves), and the ref answers the graph operation. */
  async function mutate(method, params) {
    const { opId } = await call(method, params);
    try { put(operationData(await call('ops.get', { opId }))); } catch (e) { log.warn('framework: a new operation could not be read', { opId, message: String(e?.message ?? e) }); }
    return refs.operation(opId);
  }
  const modOp = (method, extra = () => ({})) => ({ effect: 'local', handler: ({ ref: r, args }) => mutate(method, { modId: r.id, ...extra(args) }) });

  // The mods' settings as graph Settings (systems.md E3), put by their own module through this provider.
  const opListeners = new Set();
  let handle = null;
  const settings = createModSettings({
    graph, provider: PROVIDER, call, log, modRef: refs.mod,
    put: (data) => handle.put(data.ref, { state: data.state, links: data.links }),
    remove: (r) => handle.remove(r),
    emit: (r, name) => handle.emit(r, name, null),
    onOp: (fn) => { opListeners.add(fn); return { dispose() { opListeners.delete(fn); } }; },
  });

  handle = graph.registerProvider('framework', PROVIDER, {
    // a mod's settings of a chat or a project are put when anyone reads its `settings` (graph-integrity G3.4)
    onObserve: (query) => settings.contribute(query),
    contributes: settings.contributes,
    types: {
      Setting: { ...settings.types.Setting, supports: realizes.supports.Setting },
      SettingsSection: settings.types.SettingsSection,
      CodexMods: { operations: {
        // a folder is a development package, installed in developer mode only (F12); a file is a signed package
        install: { effect: 'local', handler: async ({ args }) => {
          const dir = await stat(args[0]).then((st) => st.isDirectory(), () => false);
          if (dir && (await call('diagnostics', {}))?.host?.developerMode !== true) return { status: 'refused', reason: 'notAllowed', message: 'Turn on Developer mode to load a mod from a folder.' };
          return mutate('mods.install', { source: args[0], ...(dir ? { dev: true } : {}) });
        } },
        // F10: the latest release of a GitHub repository, its signed package
        installFromGitHub: { effect: 'local', handler: ({ args }) => mutate('mods.installFromGitHub', { repo: args[0], ...(args[1] ? { mod: args[1] } : {}) }) },
        setDeveloperMode: { effect: 'local', handler: async ({ args }) => { await call('framework.developerMode', { on: args[0] === true }); await refresh(false); return null; } },
        enterSafeMode: { effect: 'local', handler: () => mutate('recovery.safeMode', { enter: true }) },
        leaveSafeMode: { effect: 'local', handler: () => mutate('recovery.safeMode', { enter: false }) },
        restoreLastKnownGood: { effect: 'local', handler: () => mutate('recovery.lkg', {}) },
        checkForUpdates: { effect: 'local', handler: async () => { await call('updates.check', {}); await refresh(false); return null; } },
        setUpdatePolicy: { effect: 'local', handler: async ({ args }) => { await call('updates.policy', { policy: args[0] }); await refresh(false); return null; } },
        // E6: the user's order, every installed mod once (Conflict when they changed since the user looked)
        setModOrder: { effect: 'local', handler: async ({ args }) => { await call('mods.order', { mods: (Array.isArray(args[0]) ? args[0] : []).map((r) => r?.id) }); await refresh(false); return null; } },
      }, supports: realizes.supports.CodexMods },
      // The copy's update (E5): download stages it now; install applies a ready plan (refused when held); installAnyway the held plan
      // the user saw; later keeps it offered without asking again.
      CopyUpdate: { operations: {
        download: { effect: 'local', handler: async () => { await call('updates.stage', {}); await refresh(false); return null; } },
        install: { effect: 'local', handler: async () => {
          const u = await call('updates.status', {});
          if (!u?.plan) return { status: 'refused', reason: 'unavailable', message: 'the update is not prepared yet' };
          if (u.plan.held) return { status: 'refused', reason: 'notAllowed', message: `the update is held: ${u.plan.risks.map((r) => `${r.mod}: ${r.sentences.join(' ') || r.status}`).join(' ')}` };
          return mutate('updates.apply', { plan: u.plan.hash });
        } },
        installAnyway: { effect: 'local', handler: async ({ args }) => {
          const u = await call('updates.status', {});
          if (!u?.plan || u.plan.hash !== args[0]) return { status: 'refused', reason: 'invalid', message: 'that plan is not the current one: look at the update again' };
          return mutate('updates.apply', { plan: u.plan.hash, anyway: true });
        } },
        later: { effect: 'local', handler: async () => { await call('updates.later', {}); await refresh(false); return null; } },
        // F11: the original Codex, for when the framework does not support the offered build yet
        openOriginal: { effect: 'local', handler: async () => { await call('updates.openOriginal', {}); return null; } },
        // E6: the plan the user saw, applied although held when `anyway`, with the mods whose update asks more consented to
        apply: { effect: 'local', handler: async ({ args }) => {
          const [plan, anyway, consent] = args;
          const u = await call('updates.status', {});
          if (!u?.plan || u.plan.hash !== plan) return { status: 'refused', reason: 'invalid', message: 'that plan is not the current one: look at the update again' };
          if (u.plan.held && !anyway) return { status: 'refused', reason: 'notAllowed', message: `the update is held: ${u.plan.risks.map((r) => `${r.mod}: ${r.sentences.join(' ') || r.status}`).join(' ')}` };
          return mutate('updates.apply', { plan, ...(anyway ? { anyway: true } : {}), ...(consent?.length ? { consent: consent.map((x) => x.id) } : {}) });
        } },
      }, supports: realizes.supports.CopyUpdate },
      Mod: { operations: {
        consent: modOp('mods.consent', (a) => ({ request: a[0], approve: a[1], ...(a[2] === undefined || a[2] === null ? {} : { enable: a[2] }), ...(Array.isArray(a[3]) ? { allow: a[3] } : {}) })),
        enable: modOp('mods.enable'),
        disable: modOp('mods.disable'),
        clearQuarantine: modOp('mods.clearQuarantine'),
        reload: modOp('mods.reload'),
        // F8: the user's decision on one of its optional permissions; a mod running is restarted, unless it only gains
        setPermission: modOp('mods.setPermission', (a) => ({ grant: a[0], decision: a[1] })),
        // F10: the update a check found for it, applied (consent asked where it adds or changes what it is)
        applyUpdate: modOp('mods.applyUpdate'),
        image: { effect: 'none', handler: ({ ref: r, args }) => call('mods.media', { modId: r.id, media: args[0] }) },
        activity: { effect: 'none', handler: ({ ref: r, args }) => call('mods.activity', { modId: r.id, ...(args[0]?.after ? { after: args[0].after } : {}) }) },
        // its page was opened: no longer new, and a stop it had then has been looked at (F15: the band leaves it out)
        markSeen: { effect: 'local', handler: async ({ ref: r }) => {
          const q = JSON.parse(mods.get(r.id) ?? 'null')?.state?.quarantine;
          const stop = q && seenStops.get(r.id) !== q.at;
          if (stop) seenStops.set(r.id, q.at);
          if (fresh.delete(r.id) || stop) await refresh(true);
          return null;
        } },
        update: modOp('mods.update', (a) => ({ source: a[0] })),
        rollback: modOp('mods.rollback', (a) => ({ toVersion: a[0], restoreData: a[1] })),
        remove: modOp('mods.remove', (a) => ({ deleteData: !a[0] })),
        reattach: modOp('mods.reattach', (a) => (a[0] === undefined ? {} : { generation: a[0] })),
        // H6: one automatic action turned on or off (the user's: the framework scope's caller)
        setAutomatic: modOp('mods.setAutomatic', (a) => ({ action: a[0], on: a[1] })),
        // H6: one of its policies turned on or off (the user's)
        setPolicy: modOp('mods.setPolicy', (a) => ({ policy: a[0], on: a[1] })),
        // E6: some stored overrides, or all: clear patches, never judged against the declarations
        clearOverrides: { effect: 'local', handler: async ({ ref: r, args }) => {
          const all = JSON.parse(mods.get(r.id) ?? 'null')?.state?.storedOverrides ?? [];
          const keyOf = (scope) => { const t = graph.type(scope?.type)?.chain ?? [scope?.type]; const kind = t.includes('Project') ? 'project' : t.includes('Thread') ? 'thread' : null;
            return kind && typeof scope.provider === 'string' && typeof scope.id === 'string' ? `${kind}:${encodeURIComponent(scope.provider)}:${encodeURIComponent(scope.id)}` : null; };
          const entries = Array.isArray(args[0]) ? args[0] : all;
          const patches = entries.map((x) => ({ key: String(x?.key ?? ''), scope: keyOf(x?.scope) })).filter((p) => p.key && p.scope).map((p) => ({ ...p, clear: true }));
          if (!patches.length) return { status: 'refused', reason: 'invalid', message: 'nothing stored to clear' };
          return mutate('mods.configure', { modId: r.id, patches });
        } },
      }, supports: realizes.supports.Mod },
      Operation: { operations: {
        acknowledge: { effect: 'local', handler: async ({ ref: r }) => { const op = await call('ops.acknowledge', { opId: r.id }); putOp(op, true); return null; } },
      }, supports: realizes.supports.Operation },
      Feature: { supports: [] },
    },
  });

  const safe = (what, fn) => { try { return fn(); } catch (e) { log.warn(`framework: ${what} not put`, { message: String(e?.message ?? e) }); return null; } };
  const recommended = recommendedOf(o.catalog);
  function put(d) { return safe(d.ref.type, () => handle.put(d.ref, { state: d.state, links: d.links })); }

  // ---------------------------------------------------------------- reads
  const mods = new Map();   // id -> the JSON of its last put (to tell a change)
  const features = new Map();   // Feature id -> the JSON of its last put
  const ops = new Map();    // id -> its last outcome
  let codexJson = null, copyJson = null;

  async function readCodexMods(modIds) {
    const [diag, updates] = await Promise.all([call('diagnostics', {}), call('updates.status', {})]);
    const lkg = updates?.lkg;
    const data = {
      ref: refs.codexMods(),
      state: {
        version: updates?.framework?.current ?? o.frameworkVersion, safeMode: diag?.host?.safeMode === true, developerMode: diag?.host?.developerMode === true, updatePolicy: updates?.policy === 'auto' ? 'auto' : 'offer',
        ...(updates?.framework?.previous ? { previousVersion: String(updates.framework.previous) } : {}),
        ...(ms(updates?.lastCheck?.at) !== undefined ? { lastChecked: ms(updates.lastCheck.at) } : {}),
        ...(updates?.unknown?.length ? { checkProblem: updates.unknown.map(String).join(' ') } : {}),
        ...(lkg ? { lastKnownGood: { app: String(lkg.appBuild), framework: String(lkg.frameworkVersion), at: ms(lkg.healthyAt ?? lkg.createdAt) ?? 0 } } : {}),
        ...(recommended.length ? { recommended } : {}),
      },
      links: { mods: modIds.map(refs.mod), operations: [...ops.keys()].map(refs.operation), features: [...features.keys()].map(refs.feature), app: refs.app(),
        update: updates?.offer ? refs.copyUpdate() : null },
    };
    // The copy's update (E5): one instance while there is an offer
    const cu = copyUpdateData(updates);
    const cuJson = cu ? JSON.stringify(cu) : null;
    if (cuJson !== copyJson) {
      const before = copyJson;
      copyJson = cuJson;
      if (cu) { put(cu); if (before && JSON.parse(before).state.state !== cu.state.state) safe('Update.stateChanged', () => handle.emit(cu.ref, 'stateChanged', null)); }
      else safe('a CopyUpdate no longer offered', () => handle.remove(refs.copyUpdate()));
    }
    handle.setComplete('CopyUpdate', true);
    const json = JSON.stringify(data);
    if (json === codexJson) return;
    const first = codexJson === null;
    codexJson = json;
    put(data);
    if (!first) safe('CodexMods.changed', () => handle.emit(data.ref, 'changed', null));
  }

  /** The feature log on this build (E4): a Feature per entry and per id a mod names that the log lacks. */
  async function readFeatures(compat) {
    let list;
    try { list = await call('features.list', {}); } catch (e) { log.warn('framework: the feature log could not be read', { message: String(e?.message ?? e) }); return; }
    const named = Object.values(compat?.mods ?? {}).flatMap((c) => c?.features ?? []);
    const seen = new Set();
    for (const d of featureData(list, named)) {
      seen.add(d.ref.id);
      const json = JSON.stringify(d);
      if (features.get(d.ref.id) === json) continue;
      features.set(d.ref.id, json);
      put(d);
    }
    for (const id of [...features.keys()]) if (!seen.has(id)) { features.delete(id); safe('a Feature no longer named', () => handle.remove(refs.feature(id))); }
    handle.setComplete('Feature', true);
  }

  // What is new (F5): installed since this Host started and past its consent, until its page is opened.
  const fresh = new Set();
  const seenStops = new Map();   // mod id -> the quarantine time its page was looked at since (F15)
  const waiting = new Set();   // those waiting for consent to install, which are new once they are not
  let readBefore = false;
  /** The mods with a `reload` running (F5). */
  const reloadingNow = (list) => new Set(list.filter((x) => x.input?.type === 'reload' && x.outcome === 'running').map((x) => x.input.modId));

  async function readMods() {
    const [{ mods: list }, compat, diag, running] = await Promise.all([call('mods.list', {}), call('compat.report', {}), call('diagnostics', {}).catch(() => null), call('ops.list', { running: true }).catch(() => ({ ops: [] }))]);
    await readFeatures(compat);
    const reloading = reloadingNow(running?.ops ?? []);
    const seen = new Set();
    for (const view of list ?? []) {
      seen.add(view.id);
      if (view.status === 'pending-consent') waiting.add(view.id);
      else if (waiting.delete(view.id) || (readBefore && !mods.has(view.id))) fresh.add(view.id);
      if (view.hasSettings && !settingsRead.has(view.id)) { settingsRead.add(view.id); settings.read(view.id, view.name); }
      // a mod whose detail cannot be read (its package is missing or broken) stays a Mod, from its record: remove and recovery reach it
      let detail, problem = null;
      try { detail = await call('mods.inspect', { modId: view.id }); } catch (e) {
        problem = `Its package could not be read: ${String(e?.message ?? e)}`;
        log.warn('framework: a mod could not be read', { modId: view.id, message: problem });
        detail = { ...view, manifest: null, grants: [] };
      }
      // a stored override's scope as the graph has it: its own type when it is resident
      const scopeOf = (sk) => { const d = defaultScopeOf(sk); if (!d) return null; const snap = graph.resolve(d.ref); return snap && !snap.gone ? { ...d, ref: snap.ref, seen: true } : d; };
      const data = modData(detail, compat?.mods?.[view.id], diag?.mods?.[view.id], problem, scopeOf, graph.policiesOf?.(`mod:${view.id}`) ?? [], o.agent?.of(view.id),
        { reloading: reloading.has(view.id), fresh: fresh.has(view.id), places: o.rules?.of(view.id) ?? [], seenStop: seenStops.get(view.id) ?? null });
      const json = JSON.stringify(data);
      if (mods.get(view.id) === json) continue;
      const known = mods.has(view.id);
      mods.set(view.id, json);
      put(data);
      if (known) safe('Mod.changed', () => handle.emit(data.ref, 'changed', null));
    }
    for (const id of [...mods.keys()]) {
      if (seen.has(id)) continue;
      mods.delete(id);
      fresh.delete(id);
      waiting.delete(id);
      settingsRead.delete(id);
      settings.forget(id);
      safe('a removed Mod', () => handle.remove(refs.mod(id)));
    }
    handle.setComplete('Mod', true);
    readBefore = true;
    return (list ?? []).map((v) => v.id);   // in the user's order (installation order until E2's order)
  }

  function putOp(op, announce) {
    const data = operationData(op);
    const before = ops.get(op.id);
    ops.set(op.id, op.outcome);
    put(data);
    if (!announce) return;
    if (before !== undefined && before !== op.outcome && op.outcome !== 'running') safe('Operation.finished', () => handle.emit(data.ref, 'finished', null));
    else safe('Operation.progressed', () => handle.emit(data.ref, 'progressed', null));
  }

  async function readOps() {
    const { ops: list } = await call('ops.list', {});
    const kept = keptOps(list ?? []);
    const keep = new Set(kept.map((x) => x.id));
    for (const op of kept) if (ops.get(op.id) !== op.outcome || !ops.has(op.id)) putOp(op, false);
    for (const id of [...ops.keys()]) if (!keep.has(id)) { ops.delete(id); safe('an old Operation', () => handle.remove(refs.operation(id))); }
    handle.setComplete('Operation', true);
  }

  let reading = null, pending = null, modIds = [];
  /**
   * Read again, one read at a time: `all` reads the mods too (a `mods`, `compat` or `health` event), otherwise only the operations and
   * CodexMods (an `op` event: a phase of an operation; reading every mod's details on each would walk their data for nothing). A change
   * during a read is read once more after it.
   */
  function refresh(all = true) {
    if (disposed) return Promise.resolve();
    pending = pending === null ? all : pending || all;
    if (reading) return reading;
    reading = (async () => {
      try {
        while (pending !== null && !disposed) {
          const withMods = pending;
          pending = null;
          await readOps();
          if (withMods) modIds = await readMods();
          await readCodexMods(modIds);
        }
      } catch (e) { log.warn('framework: read failed', { message: String(e?.message ?? e) }); } finally { reading = null; }
    })();
    return reading;
  }

  const settingsRead = new Set();   // mods whose settings were read once (later reads follow the settings event)
  const sub = management.subscribe((event) => {
    if (disposed || !event) return;
    if (event.event === 'op' && event.data?.id) {
      putOp(event.data, true);
      for (const fn of [...opListeners]) { try { fn(event.data); } catch { /* the listener's own */ } }
      refresh(event.data.input?.type === 'reload');   // Mod.state follows a reload from its start
      return;
    }
    if (event.event === 'activity') {
      if (event.data?.modId && mods.has(event.data.modId)) safe('Mod.activity', () => handle.emit(refs.mod(event.data.modId), 'activity', null));
      return;
    }
    if (event.event === 'settings') {
      const ids = event.data?.modId ? [event.data.modId] : [...settingsRead];
      for (const id of ids) settings.read(id, JSON.parse(mods.get(id) ?? 'null')?.state?.name);
      return;
    }
    refresh(true);
  });

  // a mod's policies came or went (public-hooks.md §3.7): its Mod lists them
  const policySub = graph.onPolicies?.(() => refresh(true)) ?? null;
  // what a mod gives the agent came or went (public-hooks.md §3.16): its Mod says so
  const agentSub = o.agent?.onChange?.(() => refresh(true)) ?? null;
  // where its rules place it (F13): read again shortly after they change (each window registers its own)
  let rulesTimer = null;
  const rulesSub = o.rules?.onChange?.(() => { clearTimeout(rulesTimer); rulesTimer = setTimeout(() => { void refresh(true); }, 250); rulesTimer.unref?.(); }) ?? null;
  const ready = refresh(true);
  return {
    ready,
    refresh,
    dispose() { if (disposed) return; disposed = true; try { sub.dispose(); } catch { /* gone */ } policySub?.dispose(); agentSub?.dispose(); rulesSub?.dispose(); clearTimeout(rulesTimer); settings.dispose(); handle.dispose(); },
  };
}
