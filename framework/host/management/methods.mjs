// Management method table: parameter schemas, permission text and view builders (ARCHITECTURE §9.5, §13, §14).
// Pure helpers live here; index.mjs wires them to the Host modules and the transports.
import { isAbsolute } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';

// ------------------------------------------------------------------ parameter validation
const MOD_ID = /^[a-z0-9.-]{3,128}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const OP_ID = /^op-[0-9a-f]{16}$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isJson(v, depth = 0) {
  if (depth > 64) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isPlain(v)) return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}

const TYPES = {
  modId: (v) => (typeof v === 'string' && MOD_ID.test(v) ? null : 'must be a mod id (3-128 characters: lowercase letters, digits, "." and "-")'),
  activityCursor: (v) => (typeof v === 'string' && /^[0-9TZ:.-]{1,40}#\d{1,9}$/.test(v) ? null : 'must be a cursor from mods.activity'),
  githubRepo: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? null : 'must be a GitHub repository as owner/repository'),
  grants: (v) => (Array.isArray(v) && v.length <= 64 && v.every((g) => typeof g === 'string' && g.length > 0 && g.length <= 512) ? null : 'must be a list of permissions'),
  grant: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 512 ? null : 'must be a permission'),
  decision: (v) => (['allow', 'ask', 'deny'].includes(v) ? null : 'must be allow, ask or deny'),
  mediaId: (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? null : 'must be a media id'),
  opId: (v) => (typeof v === 'string' && OP_ID.test(v) ? null : 'must be an operation id ("op-" followed by 16 hex digits)'),
  version: (v) => (typeof v === 'string' && VERSION.test(v) ? null : 'must be a version string without path separators'),
  path: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0') && isAbsolute(v) ? null : 'must be an absolute path'),
  generation: (v) => (typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z:._+-]{0,63}$/.test(v) && !v.includes('..') ? null : 'must be a preserved-data generation id (its ISO timestamp)'),
  boolean: (v) => (typeof v === 'boolean' ? null : 'must be a boolean'),
  automaticId: (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) ? null : 'must be an automatic action id'),
  json: (v) => (v !== undefined && isJson(v) ? null : 'must be a JSON value'),
  // Scoped settings patches (docs/design/systems.md E3): [{key, scope, value} | {key, scope, unset: true}], `scope` "app" or {project | thread: ref}.
  patches: (v) => (Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every((p) => isPlain(p) && typeof p.key === 'string' && p.key.length > 0
    && (p.scope === undefined || p.scope === 'app' || isPlain(p.scope) || (typeof p.scope === 'string' && /^(project|thread):[^:]+:[^:]+$/.test(p.scope)))
    && (p.unset === true || p.clear === true ? p.value === undefined : isJson(p.value)) && isJson(p))
    ? null : 'must be 1 to 64 patches: {key, scope, value}, {key, scope, unset: true} or {key, scope, clear: true}'),
  string: (v) => (typeof v === 'string' && v.length > 0 ? null : 'must be a non-empty string'),
  planHash: (v) => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? null : 'must be a plan\'s hash (32 hex digits)'),
  modIds: (v) => (Array.isArray(v) && v.length <= 256 && v.every((x) => typeof x === 'string' && MOD_ID.test(x)) ? null : 'must be a list of mod ids'),
  policy: (v) => (v === 'offer' || v === 'auto' ? null : 'must be "offer" or "auto"'),
  consentRequest: (v) => (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v) ? null : 'must be a consent request id (16 hex digits, mods.inspect consentRequest.id)'),
};

/**
 * schema: { name: 'type' | 'type?' }. Unknown parameters are refused so a typo never silently becomes a default.
 * Returns the (shallow) params object.
 */
export function validateParams(method, params, schema) {
  if (params === undefined || params === null) params = {};
  if (!isPlain(params)) throw new CodexModsError('Invalid', `${method}: params must be an object`);
  for (const key of Object.keys(params)) {
    if (!(key in schema)) throw new CodexModsError('Invalid', `${method}: unknown parameter '${key}'`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const value = params[key];
    if (value === undefined) {
      if (optional) continue;
      throw new CodexModsError('Invalid', `${method}: params.${key} is required`);
    }
    const problem = TYPES[type](value);
    if (problem) throw new CodexModsError('Invalid', `${method}: params.${key} ${problem}`);
  }
  return params;
}

/** Mutation methods: schema and the OpInput they map to (1:1 with contracts/state.d.ts OpInput). */
export const MUTATIONS = {
  'mods.install': { schema: { source: 'path', enable: 'boolean?', dev: 'boolean?' },
    op: (p) => ({ type: 'install', source: p.source, ...(p.enable === undefined ? {} : { enable: p.enable }), ...(p.dev === undefined ? {} : { dev: p.dev }) }) },
  'mods.consent': { schema: { modId: 'modId', approve: 'boolean', enable: 'boolean?', request: 'consentRequest?', allow: 'grants?' },
    op: (p) => ({ type: 'consent', modId: p.modId, approve: p.approve, ...(p.enable === undefined ? {} : { enable: p.enable }), ...(p.request === undefined ? {} : { request: p.request }), ...(p.allow === undefined ? {} : { allow: p.allow }) }) },
  'mods.enable': { schema: { modId: 'modId' }, op: (p) => ({ type: 'enable', modId: p.modId }) },
  'mods.disable': { schema: { modId: 'modId' }, op: (p) => ({ type: 'disable', modId: p.modId }) },
  'mods.clearQuarantine': { schema: { modId: 'modId' }, op: (p) => ({ type: 'clear-quarantine', modId: p.modId }) },
  'mods.reload': { schema: { modId: 'modId' }, op: (p) => ({ type: 'reload', modId: p.modId }) },
  'mods.setAutomatic': { schema: { modId: 'modId', action: 'automaticId', on: 'boolean' }, op: (p) => ({ type: 'set-automatic', modId: p.modId, action: p.action, on: p.on }) },
  'mods.installFromGitHub': { schema: { repo: 'githubRepo', mod: 'modId?' } },
  'mods.applyUpdate': { schema: { modId: 'modId' } },
  'mods.setPermission': { schema: { modId: 'modId', grant: 'grant', decision: 'decision' }, op: (p) => ({ type: 'set-permission', modId: p.modId, grant: p.grant, decision: p.decision }) },
  'mods.setPolicy': { schema: { modId: 'modId', policy: 'automaticId', on: 'boolean' }, op: (p) => ({ type: 'set-policy', modId: p.modId, policy: p.policy, on: p.on }) },
  'mods.configure': { schema: { modId: 'modId', patches: 'patches' }, op: (p) => ({ type: 'configure', modId: p.modId, patches: p.patches }) },
  'mods.update': { schema: { modId: 'modId', source: 'path' }, op: (p) => ({ type: 'update', modId: p.modId, source: p.source }) },
  'mods.rollback': { schema: { modId: 'modId', toVersion: 'version', restoreData: 'boolean' },
    op: (p) => ({ type: 'rollback', modId: p.modId, toVersion: p.toVersion, restoreData: p.restoreData }) },
  'mods.remove': { schema: { modId: 'modId', deleteData: 'boolean' }, op: (p) => ({ type: 'remove', modId: p.modId, deleteData: p.deleteData }) },
  'mods.reattach': { schema: { modId: 'modId', generation: 'generation?' },
    op: (p) => ({ type: 'reattach', modId: p.modId, ...(p.generation === undefined ? {} : { generation: p.generation }) }) },
  'updates.framework': { schema: { version: 'version', sourceDir: 'path' }, op: (p) => ({ type: 'framework-update', version: p.version, sourceDir: p.sourceDir }) },
  'updates.app.prepare': { schema: {}, op: () => ({ type: 'app-prepare' }) },
  // E5: no path applies a build unchecked: the old apply is the update's gate for the latest plan that has this candidate.
  'updates.app.apply': { schema: { candidate: 'path' }, op: (p) => ({ type: 'copy-update', plan: p.plan }) },
  'updates.apply': { schema: { plan: 'planHash', anyway: 'boolean?', consent: 'modIds?' },
    op: (p) => ({ type: 'copy-update', plan: p.plan, ...(p.anyway ? { anyway: true } : {}), ...(p.consent ? { consent: p.consent } : {}) }) },
  'recovery.safeMode': { schema: { enter: 'boolean' }, op: (p) => ({ type: 'safe-mode', enter: p.enter }) },
  'recovery.lkg': { schema: {}, op: () => ({ type: 'lkg-restore' }) },
};

export const READS = {
  'mods.list': {},
  'mods.inspect': { modId: 'modId' },
  'mods.media': { modId: 'modId', media: 'mediaId' },
  'mods.activity': { modId: 'modId', after: 'activityCursor?' },
  'mods.settings': { modId: 'modId' },
  'ops.get': { opId: 'opId' },
  'ops.list': { modId: 'modId?', running: 'boolean?' },
  'compat.report': {},
  'features.list': {},
  'updates.status': {},
  // E5: the update's own calls (no operation): check now, stage now, keep the offer without asking again, the policy.
  'updates.check': {},
  'updates.stage': {},
  'updates.later': {},   // F11: Cancel while it prepares is Later too: the staging stops
  'updates.openOriginal': {},   // F11: the original Codex opened, when the framework does not support the offered build yet
  'updates.policy': { policy: 'policy' },
  // E6: acknowledge an operation that needs attention (it keeps its outcome; its banner goes)
  'ops.acknowledge': { opId: 'opId' },
  // E6: the user's mod order, every installed mod once
  'mods.order': { mods: 'modIds' },
  // framework-ui.md F12: developer mode, a stored flag
  'framework.developerMode': { on: 'boolean' },
  'diagnostics': {},
  'events.subscribe': {},
};

export const METHOD_NAMES = Object.freeze([...Object.keys(READS), ...Object.keys(MUTATIONS)]);

// ------------------------------------------------------------------ permission text (ARCHITECTURE §13)
const RISK_ORDER = { high: 0, medium: 1, low: 2 };

/** The agent's inputs (graph-integrity G3.5) in the user's words, where a grant names them; any other entry is named as it is. */
const ENTRY_WORDS = { 'CodexAgent._startThread': 'what new chats start with (the agent\'s instructions and tools)', 'CodexThread._resume': 'what chats resume with',
  'CodexThread.fork': 'chats\' forks', 'CodexThread.send': 'your messages', 'Thread.send': 'your messages', 'CodexAgent._setSkillRoots': 'the agent\'s skill folders' };
/** Concepts in the user's words, for consent ("your chats"); a type the list does not know is named as it is. */
const USER_WORDS = { Thread: 'your chats', Project: 'your projects', Skill: 'your skills', Agent: 'your agents', Setting: 'your settings', Plugin: 'your plugins',
  ToolServer: 'your tool servers', Turn: 'your chats\' turns', Message: 'your chats\' messages', Draft: 'your drafts', Automation: 'your automations', Mod: 'its own page' };
const userWords = (types) => { const words = [...new Set(types.map((x) => USER_WORDS[x] ?? x))]; return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]; };

function scopeOf(permission, base) {
  // 'appServer.intercept' -> null (everything); 'appServer.intercept:a,b' -> ['a','b']; ':*' -> null
  if (permission === base) return null;
  const list = permission.slice(base.length + 1).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes('*') ? null : list;
}

/** One manifest permission → {risk, text}[]; plain English. */
export function describePermission(permission) {
  const out = [];
  if (permission === 'appServer.intercept' || permission.startsWith('appServer.intercept:')) {
    const scope = scopeOf(permission, 'appServer.intercept');
    if (scope === null) out.push({ risk: 'high', text: 'Can read and change every Codex request and reply (all methods)' });
    else out.push({ risk: 'medium', text: `Can read and change Codex requests: ${scope.join(', ')}` });
    return out;
  }
  if (permission === 'appServer.request' || permission.startsWith('appServer.request:')) {
    const scope = scopeOf(permission, 'appServer.request');
    out.push({ risk: 'medium', text: scope === null ? 'Can send any request to Codex on your behalf' : `Can send requests to Codex on your behalf: ${scope.join(', ')}` });
    return out;
  }
  if (permission === 'appServer.observe' || permission.startsWith('appServer.observe:')) {
    const scope = scopeOf(permission, 'appServer.observe');
    out.push({ risk: 'low', text: scope === null ? 'Can see all Codex messages' : `Can see Codex messages: ${scope.join(', ')}` });
    return out;
  }
  // Adding to others' instances (graph-integrity G3.2): said in the user's terms, what it adds to ("adds to your chats").
  if (permission === 'graph.contribute' || permission.startsWith('graph.contribute:')) {
    const scope = scopeOf(permission, 'graph.contribute');
    return [{ risk: 'medium', text: scope === null ? 'Can add its own items to anything in Codex: your chats, projects, skills and settings' : `Can add its own items to ${userWords(scope)}` }];
  }
  if (permission === 'graph.attach' || permission.startsWith('graph.attach:')) {
    const scope = scopeOf(permission, 'graph.attach');
    return [{ risk: 'medium', text: scope === null ? 'Can keep its own notes on anything in Codex' : `Can keep its own notes on ${userWords(scope)}` }];
  }
  // Other providers' graph instances (breadth.md D0.2): bare is every type, a list names types (with their subtypes) or Type.operation.
  for (const [base, all, some] of [
    ['graph.read', 'Can read everything in Codex: your threads, messages, projects and settings', 'Can read in Codex'],
    ['graph.act', 'Can do anything in Codex on your behalf', 'Can do in Codex on your behalf'],
    ['graph.intercept', 'Can change or block anything you or other mods do in Codex', 'Can change or block in Codex'],
    ['graph.present', 'Can add to, change, hide or replace anything on screen in Codex', 'Can add to, change, hide or replace on screen'],
  ]) {
    if (permission !== base && !permission.startsWith(`${base}:`)) continue;
    const scope = scopeOf(permission, base);
    const scoped = base === 'graph.read' || base === 'graph.present' ? 'medium' : 'high';
    return [scope === null ? { risk: base === 'graph.present' ? 'medium' : 'high', text: all } : { risk: scoped, text: `${some}: ${[...new Set(scope.map((x) => ENTRY_WORDS[x] ?? x))].join(', ')}` }];
  }
  // the programs on the Mac a mod's session processes run (graph-integrity G8.2, D4): each named, so consent shows it and a new one asks again
  if (permission.startsWith('processes.exec:')) {
    const names = permission.slice('processes.exec:'.length).split(',').filter(Boolean);
    return [{ risk: 'high', text: `Runs ${names.join(', ')} on your Mac (${names.length === 1 ? 'a program' : 'programs'} installed there, with your access)` }];
  }
  switch (permission) {
    case 'appServer.backends': return [{ risk: 'high', text: 'Can start its own separate Codex backends, with their own data' }];
    case 'appServer.clients': return [{ risk: 'medium', text: 'Can give other programs on this Mac access to Codex through connection leases' }];
    case 'secrets': return [{ risk: 'high', text: 'Can store and read its own secrets in your Keychain' }];
    case 'processes': return [{ risk: 'high', text: 'Can run its own programs on your Mac' }];
    case 'framework.updates': return [{ risk: 'high', text: 'Can ask the framework to update itself' }];
    case 'network': return [{ risk: 'medium', text: 'May use the network (advisory: this is not enforced)' }];
    case 'graph': return [{ risk: 'medium', text: 'Can add its own agents, threads and other items to Codex and show them in the app' }];
    case 'ui': return [{ risk: 'low', text: 'Can add controls to the Codex interface' }];
    default: return [{ risk: 'high', text: `Unknown permission "${permission}"` }];
  }
}

/** permissions → deduplicated lines, ordered high, medium, low (stable within a risk). */
export function permissionText(permissions) {
  const lines = [];
  const seen = new Set();
  const add = (line) => { const k = `${line.risk}|${line.text}`; if (!seen.has(k)) { seen.add(k); lines.push(line); } };
  let intercepts = false;
  for (const p of permissions ?? []) {
    for (const line of describePermission(p)) add(line);
    if (p === 'appServer.intercept' || p.startsWith('appServer.intercept:')) intercepts = true;
  }
  if (intercepts) {
    // A manifest cannot declare onError before runtime; any interceptor may be set to reject (high risk by §13).
    add({ risk: 'high', text: 'Intercepting can block requests: if an interceptor fails or times out it may be set to reject the request instead of letting it through' });
  }
  return lines.map((l, i) => ({ l, i })).sort((a, b) => RISK_ORDER[a.l.risk] - RISK_ORDER[b.l.risk] || a.i - b.i).map((x) => x.l);
}

export const isPlainObject = isPlain;
