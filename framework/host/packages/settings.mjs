// A mod's settings as declarations, stored values and effective values (docs/design/framework-ui.md F7; systems.md S13, S14, "E3 in detail"). A manifest's `settings` is a list of items
// and groups, and this module gives one list of declarations, `{key, kind, control?, title, description?, icon?, default, scope, scopes, choices?, group?, groupTitle?, order, min?, max?,
// step?, unit?, placeholder?, schema?, requires?, needs?}`, with the groups beside it, and works on the stored values: the app map (`settings.json`: the values set at the app scope) and
// the overrides at narrower scopes (`settings.scopes.json`: `{"<scope key>": {key: value}}`).
// - `kind` is what the value is, from the user's view, and `control` how it is drawn.
// - A stored value that no longer validates (a changed declaration) is ignored when the effective value is computed, and reported; it is never deleted here.
// - `requires` makes a row active or not for each instance at that instance's scope, and never changes a value.
// - A choice's value is the value itself; in the graph its id is the value as JSON, so a number or a boolean round-trips.
// Node built-ins only (none needed).
import { CodexModsError } from '../../../sdk/errors.mjs';
import { applySchema, checkSchema, deepEqual } from './schema.mjs';

export const SCOPES = Object.freeze(['app', 'project', 'thread']);
export const KINDS = Object.freeze(['toggle', 'choice', 'text', 'number', 'shortcut', 'list', 'record', 'color', 'time', 'timerange']);
/** How a kind may be drawn, the first being its default. A text's `secret` (masked, never kept) is a question's only (ui.ask). */
export const CONTROLS = Object.freeze({ choice: ['select', 'segmented', 'thumbnails'], number: ['stepper', 'slider'], text: ['line', 'area', 'secret'] });
/** What a question's field (ui.ask) cannot say: it has no scope, nothing it requires, no permission it needs. */
const NOT_ASKED = Object.freeze(['scope', 'requires', 'needs']);
export const MAX_ASK_FIELDS = 12;   // every kind in one question, the secret text too
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_TEXT = 10_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (path, msg) => new CodexModsError('Invalid', `${path}: ${msg}`, { path });
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------- ids, scope keys
/** A project's or a thread's scope key: `project:<provider>:<id>`, each part escaped. */
export function scopeKeyOf(kind, ref) {
  if ((kind !== 'project' && kind !== 'thread') || !isObj(ref) || typeof ref.provider !== 'string' || typeof ref.id !== 'string' || !ref.id) throw invalid('scope', 'is app, or a project\'s or a thread\'s ref');
  return `${kind}:${encodeURIComponent(ref.provider)}:${encodeURIComponent(ref.id)}`;
}
export function parseScopeKey(key) {
  const m = /^(project|thread):([^:]+):([^:]+)$/.exec(String(key));
  return m ? { kind: m[1], provider: decodeURIComponent(m[2]), id: decodeURIComponent(m[3]) } : null;
}
/** A Setting instance's id: `<mod>/<key>` at the app scope, `<mod>/<key>@<scope key>` at another (the key escaped: no key reads as a scope). */
export const instanceId = (modId, key, scopeKey = null) => `${modId}/${encodeURIComponent(key)}${scopeKey ? `@${scopeKey}` : ''}`;
export function parseInstanceId(id) {
  const m = /^([a-z0-9][a-z0-9.-]{1,127})\/([^@/]+)(?:@((?:project|thread):[^:@/]+:[^:@/]+))?$/.exec(String(id));
  if (!m) return null;
  let key;
  try { key = decodeURIComponent(m[2]); } catch { return null; }
  return { modId: m[1], key, scopeKey: m[3] ?? null };
}

// ---------------------------------------------------------------- declarations
const scopesUpTo = (scope) => SCOPES.slice(0, SCOPES.indexOf(scope) + 1);

const ITEM_FIELDS = new Set(['key', 'title', 'description', 'icon', 'kind', 'control', 'default', 'scope', 'options', 'schema', 'min', 'max', 'step', 'unit', 'placeholder', 'requires', 'needs']);
const GROUP_FIELDS = new Set(['group', 'icon', 'description', 'media', 'items']);
/** A group's id, from its title: what its section is called. */
const groupId = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
const optionOf = (x) => (typeof x === 'string' ? { value: x, label: x } : x);
const requiresOf = (r) => (typeof r === 'string' ? { key: r } : r);

/**
 * Checks a mod's settings (pack, install and configure run it); throws Invalid.
 * @param {unknown} list
 * @param {string} [path]
 * @param {{ checkMedia?: (item: unknown, at: string) => void, permissions?: string[], ask?: boolean }} [o]  `checkMedia`: the manifest's check of an image; `permissions`: what
 *   `needs` may name; `ask`: a question's fields (ui.ask, graph-integrity G4.2): items only, no scope, `requires` or `needs`; a text may be
 *   a `secret` (with no default but empty), which a setting may not (it would be kept)
 */
export function checkDeclarations(list, path = 'settings', o = {}) {
  if (!Array.isArray(list)) throw invalid(path, 'must be a list of settings and groups');
  const seen = new Set(), groups = new Set();
  const items = [];
  const item = (d, p) => {
    if (!isObj(d)) throw invalid(p, 'must be an object');
    for (const k of Object.keys(d)) if (!ITEM_FIELDS.has(k)) throw invalid(`${p}.${k}`, 'is not a field of a setting');
    if (typeof d.key !== 'string' || !KEY.test(d.key)) throw invalid(`${p}.key`, 'must be 1-64 letters, digits, "_" or "-", starting with a letter');
    if (seen.has(d.key)) throw invalid(`${p}.key`, `${d.key} is declared twice`);
    seen.add(d.key);
    if (!KINDS.includes(d.kind)) throw invalid(`${p}.kind`, `must be one of ${KINDS.join(', ')}`);
    if (d.control !== undefined && !CONTROLS[d.kind]?.includes(d.control)) throw invalid(`${p}.control`, CONTROLS[d.kind] ? `must be one of ${CONTROLS[d.kind].join(', ')}` : `a ${d.kind} has one control`);
    if (d.control === 'secret' && !o.ask) throw invalid(`${p}.control`, 'a secret is asked (ui.ask), never kept as a setting: keep one with ctx.secrets');
    if (o.ask) for (const k of NOT_ASKED) if (d[k] !== undefined) throw invalid(`${p}.${k}`, `a question's field has no ${k}`);
    if (typeof d.title !== 'string' || !d.title.trim()) throw invalid(`${p}.title`, 'is required (a setting says what it is)');
    for (const k of ['description', 'icon', 'unit', 'placeholder']) if (d[k] !== undefined && (typeof d[k] !== 'string' || !d[k].trim())) throw invalid(`${p}.${k}`, 'must be a non-empty string');
    const scope = d.scope ?? 'app';
    if (!SCOPES.includes(scope)) throw invalid(`${p}.scope`, `must be one of ${SCOPES.join(', ')}`);
    // any kind at any scope (graph-integrity G4.1): each presentation draws the kinds it can (the composer its choices and toggles, a mod's
    // own surface every kind through SettingRow)
    if (d.kind === 'choice') {
      if (!Array.isArray(d.options) || !d.options.length) throw invalid(`${p}.options`, 'a choice lists its options');
      d.options.map(optionOf).forEach((c, j) => {
        if (!isObj(c) || !['string', 'number', 'boolean'].includes(typeof c.value) || typeof c.label !== 'string' || !c.label) throw invalid(`${p}.options[${j}]`, 'is a string, or {value: a string, number or boolean, label, description?, media?}');
        if (c.media !== undefined) o.checkMedia?.(c.media, `${p}.options[${j}].media`);
      });
    } else if (d.options !== undefined) throw invalid(`${p}.options`, 'only a choice has options');
    for (const k of ['min', 'max', 'step']) if (d[k] !== undefined && (d.kind !== 'number' || !Number.isFinite(d[k]))) throw invalid(`${p}.${k}`, 'is a number bound of a number');
    if (d.step !== undefined && d.step <= 0) throw invalid(`${p}.step`, 'must be more than 0');
    if (d.unit !== undefined && d.kind !== 'number') throw invalid(`${p}.unit`, 'only a number has a unit');
    if (d.placeholder !== undefined && d.kind !== 'text' && d.kind !== 'list') throw invalid(`${p}.placeholder`, 'only a text or a list has a placeholder');
    if (d.schema !== undefined) {
      if (d.kind !== 'list' && d.kind !== 'record') throw invalid(`${p}.schema`, 'only a list (its items) or a record has a schema');
      checkSchema(d.schema, `${p}.schema`);
    }
    if (d.requires !== undefined && !(typeof d.requires === 'string' || (isObj(d.requires) && typeof d.requires.key === 'string' && Object.hasOwn(d.requires, 'not') && Object.keys(d.requires).length === 2))) {
      throw invalid(`${p}.requires`, 'is a setting\'s key, or {key, not}');
    }
    if (d.needs !== undefined) {
      if (typeof d.needs !== 'string') throw invalid(`${p}.needs`, 'names a permission');
      if (o.permissions && !o.permissions.includes(d.needs)) throw invalid(`${p}.needs`, `${d.needs} is not a permission this mod declares`);
    }
    if (d.control === 'secret' && d.default !== undefined && d.default !== '') throw invalid(`${p}.default`, 'a secret has no default');
    if (d.default === undefined && d.control !== 'secret') throw invalid(`${p}.default`, 'is required');
    if (d.default !== undefined) validateValue(normalize(d), d.default, `${p}.default`);
    items.push([d, p]);
  };
  list.forEach((x, i) => {
    const p = `${path}[${i}]`;
    if (o.ask && isObj(x) && Object.hasOwn(x, 'items')) throw invalid(p, 'a question\'s fields are settings, not groups');
    if (!isObj(x) || !Object.hasOwn(x, 'items')) { item(x, p); return; }
    for (const k of Object.keys(x)) if (!GROUP_FIELDS.has(k)) throw invalid(`${p}.${k}`, 'is not a field of a group');
    if (x.group !== undefined) {
      if (typeof x.group !== 'string' || !x.group.trim()) throw invalid(`${p}.group`, 'must be a non-empty string');
      if (groups.has(groupId(x.group))) throw invalid(`${p}.group`, `${x.group} is a group already`);
      groups.add(groupId(x.group));
    }
    for (const k of ['icon', 'description']) if (x[k] !== undefined && (typeof x[k] !== 'string' || !x[k].trim())) throw invalid(`${p}.${k}`, 'must be a non-empty string');
    if (x.media !== undefined) o.checkMedia?.(x.media, `${p}.media`);
    if (!Array.isArray(x.items)) throw invalid(`${p}.items`, 'must be a list of settings');
    x.items.forEach((d, j) => item(d, `${p}.items[${j}]`));
  });
  // `requires`: a key it declares, and no cycle
  const byKey = new Map(items.map(([d]) => [d.key, d]));
  for (const [d, p] of items) {
    if (d.requires === undefined) continue;
    const walked = new Set([d.key]);
    for (let r = requiresOf(d.requires); r; r = requiresOf(byKey.get(r.key)?.requires)) {
      if (!byKey.has(r.key)) throw invalid(`${p}.requires`, `${r.key} is not a setting of this mod`);
      if (walked.has(r.key)) throw invalid(`${p}.requires`, `${d.key} depends on itself`);
      walked.add(r.key);
    }
  }
}
function normalize(d, order = 0, group = null) {
  const scope = d.scope ?? 'app';
  const { options, requires, ...rest } = clone(d);
  return {
    ...rest, scope, scopes: scopesUpTo(scope), order,
    ...(options ? { choices: options.map(optionOf) } : {}),
    ...(requires !== undefined ? { requires: requiresOf(requires) } : {}),
    ...(group?.id ? { group: group.id, groupTitle: group.title } : {}),
  };
}

/**
 * A question's fields (ui.ask, graph-integrity G4.2: the settings' own schema and kinds), checked and in the declarations' shape (a choice's
 * `choices`, a secret's default empty); throws Invalid. At most MAX_ASK_FIELDS.
 */
export function askFieldsOf(fields, path = 'fields') {
  if (fields === undefined) return [];
  if (!Array.isArray(fields) || fields.length > MAX_ASK_FIELDS) throw invalid(path, `a question has at most ${MAX_ASK_FIELDS} fields`);
  checkDeclarations(fields, path, { ask: true });
  return fields.map((d, i) => {
    const { scope: _s, scopes: _ss, ...rest } = normalize(d, i);
    return { ...rest, ...(d.control === 'secret' ? { default: '' } : {}) };
  });
}
/** The value a question's field was given, as its kind takes it; its default when none, or one not of its kind, was given. */
export function askValueOf(field, given) {
  return given !== undefined && valid(field, given) ? given : clone(field.default);
}

/** The declarations of a manifest's settings: `list`, every item in its order, and `groups`, each titled or untitled group with what it says of itself (loose items are the first, untitled). */
export function declarationsOf(manifest) {
  const s = manifest?.settings;
  if (!Array.isArray(s)) return { list: [], groups: [] };
  const groups = [];
  const list = [];
  const add = (d, g) => list.push(normalize(d, list.length, g));
  for (const x of s) if (!(isObj(x) && Object.hasOwn(x, 'items'))) add(x, null);
  for (const x of s) {
    if (!(isObj(x) && Object.hasOwn(x, 'items'))) continue;
    const g = { id: x.group ? groupId(x.group) : null, ...(x.group ? { title: x.group } : {}), ...(x.icon ? { icon: x.icon } : {}), ...(x.description ? { description: x.description } : {}), ...(x.media ? { media: clone(x.media) } : {}) };
    if (g.id) groups.push(g);
    for (const d of x.items) add(d, g);
  }
  return { list, groups };
}

/** A value for a declaration; throws Invalid. */
export function validateValue(decl, value, path = decl.key) {
  switch (decl.kind) {
    case 'toggle': if (typeof value !== 'boolean') throw invalid(path, 'expected a toggle (true or false)'); break;
    case 'choice': if (!decl.choices.some((c) => deepEqual(c.value, value))) throw invalid(path, `must be one of ${decl.choices.map((c) => JSON.stringify(c.value)).join(', ')}`); break;
    case 'color': if (typeof value !== 'string' || !COLOR.test(value)) throw invalid(path, 'expected a color (#RRGGBB)'); break;
    case 'time': if (typeof value !== 'string' || !TIME.test(value)) throw invalid(path, 'expected a time (HH:MM)'); break;
    case 'timerange':
      if (!isObj(value) || Object.keys(value).length !== 2 || !TIME.test(value.from) || !TIME.test(value.to)) throw invalid(path, 'expected {from: "HH:MM", to: "HH:MM"}');
      break;
    case 'text': if (typeof value !== 'string' || value.length > MAX_TEXT) throw invalid(path, `expected text of at most ${MAX_TEXT} characters`); break;
    case 'shortcut': if (typeof value !== 'string' || value.length > 200) throw invalid(path, 'expected a shortcut (an accelerator, at most 200 characters)'); break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path, 'expected a number');
      if (decl.min !== undefined && value < decl.min) throw invalid(path, `must be >= ${decl.min}`);
      if (decl.max !== undefined && value > decl.max) throw invalid(path, `must be <= ${decl.max}`);
      break;
    case 'list':
      if (!Array.isArray(value)) throw invalid(path, 'expected a list');
      if (decl.schema) value.forEach((x, i) => applySchema(decl.schema, x, `${path}[${i}]`));
      break;
    case 'record':
      if (!isObj(value)) throw invalid(path, 'expected a record (an object)');
      if (decl.schema) applySchema(decl.schema, value, path);
      break;
    default: throw invalid(path, 'unknown kind');
  }
  return value;
}
const valid = (decl, value) => { try { validateValue(decl, value); return true; } catch { return false; } };

// ---------------------------------------------------------------- stored and effective values

/** What is stored for a declaration at a scope: {present, value}. */
export function storedAt(decl, app, scopes, scopeKey = null) {
  if (scopeKey) { const m = scopes?.[scopeKey]; return isObj(m) && Object.hasOwn(m, decl.key) ? { present: true, value: m[decl.key] } : { present: false }; }
  return isObj(app) && Object.hasOwn(app, decl.key) ? { present: true, value: app[decl.key] } : { present: false };
}

/**
 * The effective value of a declaration at a scope: the thread's stored value, then the project's, then the app's, then the default
 * (only the scopes it may be set at; an invalid stored value is passed over). `overridden`: a valid value is stored at the asked scope, which
 * can equal the default and still shadow a wider scope's value.
 * @param {{ projectKey?: string | null, threadKey?: string | null, at?: 'app' | 'project' | 'thread' }} where
 */
export function effectiveOf(decl, app, scopes, where = {}) {
  const asked = where.at ?? (where.threadKey ? 'thread' : where.projectKey ? 'project' : 'app');
  const layers = [];
  if (where.threadKey && decl.scopes.includes('thread')) layers.push(['thread', where.threadKey]);
  if (where.projectKey && decl.scopes.includes('project')) layers.push(['project', where.projectKey]);
  layers.push(['app', null]);
  for (const [scope, key] of layers) {
    const s = storedAt(decl, app, scopes, key);
    if (!s.present || !valid(decl, s.value)) continue;
    return { value: clone(s.value), source: scope, overridden: scope === asked };
  }
  return { value: clone(decl.default), source: 'default', overridden: false };
}

/** Is this declaration active where its instance is (F7): what it requires holds at the same scope, and is itself active. A declaration names only keys and no cycle (checkDeclarations). */
export function activeOf(decl, list, app, scopes, where = {}) {
  if (!decl.requires) return true;
  const parent = list.find((x) => x.key === decl.requires.key);
  if (!parent || !activeOf(parent, list, app, scopes, where)) return false;
  const { value } = effectiveOf(parent, app, scopes, where);
  return Object.hasOwn(decl.requires, 'not') ? !deepEqual(value, decl.requires.not) : Boolean(value);
}

/** The effective app document: every declared key's app value. */
export function documentOf(list, app) {
  return Object.fromEntries(list.map((d) => [d.key, effectiveOf(d, app, {}).value]));
}

/** Stored values that are not used: unknown keys, scopes a setting may not be set at, values that do not validate. */
export function invalidStored(list, app, scopes) {
  const out = [];
  const byKey = new Map(list.map((d) => [d.key, d]));
  for (const [k, v] of Object.entries(isObj(app) ? app : {})) {
    const d = byKey.get(k);
    if (!d) out.push({ key: k, scope: 'app', reason: 'not declared' }); else if (!valid(d, v)) out.push({ key: k, scope: 'app', reason: 'does not validate' });
  }
  for (const [sk, map] of Object.entries(isObj(scopes) ? scopes : {})) {
    const kind = parseScopeKey(sk)?.kind;
    for (const [k, v] of Object.entries(isObj(map) ? map : {})) {
      const d = byKey.get(k);
      if (!d) out.push({ key: k, scope: sk, reason: 'not declared' });
      else if (!kind || !d.scopes.includes(kind)) out.push({ key: k, scope: sk, reason: `not set at a ${kind ?? 'unknown'} scope` });
      else if (!valid(d, v)) out.push({ key: k, scope: sk, reason: 'does not validate' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- patches
/** A patch's scope: 'app', or {project | thread: ref} -> its scope key and kind. */
export function scopeOfPatch(scope) {
  if (scope === undefined || scope === 'app') return { kind: 'app', key: null };
  if (isObj(scope) && isObj(scope.project) && scope.thread === undefined) return { kind: 'project', key: scopeKeyOf('project', scope.project) };
  if (isObj(scope) && isObj(scope.thread) && scope.project === undefined) return { kind: 'thread', key: scopeKeyOf('thread', scope.thread) };
  if (typeof scope === 'string' && parseScopeKey(scope)) return { kind: parseScopeKey(scope).kind, key: scope };
  throw invalid('scope', 'is "app", {project: ref} or {thread: ref}');
}

/** Every value stored at a project's or a thread's scope, as stored (E6, decision 8): `valid` when its key is still declared, its scope
 * still allowed for it and its value still validates. Nothing is judged away: a scope can come back. */
export function storedOverrides(list, app, scopes) {
  const bad = new Set(invalidStored(list, app, scopes).filter((x) => x.scope !== 'app').map((x) => `${x.scope}\u0000${x.key}`));
  const out = [];
  for (const [sk, map] of Object.entries(isObj(scopes) ? scopes : {})) {
    if (!parseScopeKey(sk)) continue;
    for (const [key, value] of Object.entries(isObj(map) ? map : {})) out.push({ key, scope: sk, value: clone(value), valid: !bad.has(`${sk}\u0000${key}`) });
  }
  return out;
}

/**
 * Apply patches ([{key, scope, value} | {key, scope, unset: true} | {key, scope, clear: true}]) to the stored values; throws Invalid.
 * A clear patch (E6, decision 8) removes what is stored at a project's or a thread's scope without judging it against the declarations
 * (a key no longer declared, a scope no longer allowed). Returns the new values and the patches that changed something
 * ([{key, scope: 'app' | scope key}]).
 */
export function applyPatches(list, app, scopes, patches) {
  if (!Array.isArray(patches) || !patches.length || patches.length > 64) throw invalid('patches', 'is a list of 1 to 64 patches');
  const byKey = new Map(list.map((d) => [d.key, d]));
  const nextApp = isObj(app) ? clone(app) : {};
  const nextScopes = isObj(scopes) ? clone(scopes) : {};
  const changed = [];
  patches.forEach((p, i) => {
    const path = `patches[${i}]`;
    if (!isObj(p) || typeof p.key !== 'string') throw invalid(path, 'is {key, scope, value} or {key, scope, unset: true}');
    if (p.clear === true) {
      const where = scopeOfPatch(p.scope);
      if (!where.key) throw invalid(`${path}.scope`, 'a clear patch is for a project\'s or a thread\'s scope');
      const m = nextScopes[where.key];
      if (isObj(m) && Object.hasOwn(m, p.key)) {
        delete m[p.key];
        if (!Object.keys(m).length) delete nextScopes[where.key];
        changed.push({ key: p.key, scope: where.key });
      }
      return;
    }
    const d = byKey.get(p.key);
    if (!d) throw invalid(`${path}.key`, `${p.key} is not a setting of this mod`);
    const where = scopeOfPatch(p.scope);
    if (!d.scopes.includes(where.kind)) throw invalid(`${path}.scope`, `${p.key} is not set at a ${where.kind} scope`);
    const unset = p.unset === true;
    if (!unset && p.value === undefined) throw invalid(`${path}.value`, 'is required (or unset: true)');
    if (!unset) validateValue(d, p.value, `${path}.value`);
    const before = storedAt(d, nextApp, nextScopes, where.key);
    if (where.key) {
      const m = nextScopes[where.key] ?? {};
      if (unset) delete m[d.key]; else m[d.key] = clone(p.value);
      if (Object.keys(m).length) nextScopes[where.key] = m; else delete nextScopes[where.key];
    } else if (unset) delete nextApp[d.key]; else nextApp[d.key] = clone(p.value);
    const after = storedAt(d, nextApp, nextScopes, where.key);
    if (before.present !== after.present || !deepEqual(before.value, after.value)) changed.push({ key: d.key, scope: where.key ?? 'app' });
  });
  return { app: nextApp, scopes: nextScopes, changed };
}
