// What a new thing starts with until the user chooses (docs/design/public-hooks.md §3.8): a mod's declared defaults.
// - A Draft's gives the new chat's target fields (`project`, `environment`, `branch`, `model`, `settings: {effort?, mode?}`) and its text;
//   `where` is on the Draft (`{'target.project': ref}`). The provider applies them when a new chat begins (its draft created, sent or
//   cleared) and when its project changes, to the fields the user has not chosen since, in the mods' order (the first mod that gives a
//   field gives it); the text only into an empty draft.
// - A Setting's (`{key, value}`) is that setting's default: its value wherever the user has set none (the user's value wins).
// - An Automation's (`values`: `name`, `enabled`, `project`, `settings`, `where`, `notifications`, `archiveRuns`) fills what a new
//   automation's spec leaves out; `where` is on the automation to be (its spec's fields; `project` its link). What it does (its prompt, its
//   schedule, the chat it watches) is its creator's alone.
// - A presentation's (graph-integrity G5.2: `{of: <a presentation type>, for?, where?, state: {expanded}}`) is the state a new one starts
//   with until the user chooses: `for` names its subject's type (or concept, or several) and `where` reads its subject, as a ui rule's do.
//   Only what the user sets by the presentation's own operations, and the app does not keep for them: whether it is expanded (a step, a
//   turn's steps, a sidebar section). Its sizes and whether a panel is open are the app's to keep (layouts.md D4).
// Node built-ins only.
import { compileWhere } from '../../shared/where.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TARGET_KEYS = new Set(['project', 'environment', 'branch', 'model', 'settings']);
export const DEFAULTS_MAX = 16;   // per mod
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (v) => isObj(v) && typeof v.type === 'string' && typeof v.provider === 'string' && typeof v.id === 'string';
const invalid = (message) => Object.assign(new Error(message), { code: 'Invalid' });

const AUTOMATION_VALUES = Object.freeze({
  name: (v) => typeof v === 'string' && v.trim() && v.length <= 250, enabled: (v) => typeof v === 'boolean', project: isRef,
  settings: (v) => isObj(v) && Object.keys(v).every((k) => (k === 'model' || k === 'effort') && typeof v[k] === 'string' && v[k]),
  where: (v) => v === 'local' || v === 'worktree', notifications: (v) => v === 'all' || v === 'failures', archiveRuns: (v) => typeof v === 'boolean',
});
const whereOf = (spec) => {
  if (spec.where === undefined) return null;
  if (!isObj(spec.where)) throw invalid('where is a where (an object)');
  try { return compileWhere(spec.where); } catch (e) { throw invalid(`where: ${e?.message ?? e}`); }
};
const fieldsOnly = (spec, fields) => { const extra = Object.keys(spec).find((k) => !fields.includes(k)); if (extra) throw invalid(`${extra} is not a field of defaults of ${spec.of}`); };
const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
/** The state a presentation's default gives (G5.2): only `expanded`. */
const PRESENTATION_STATE = Object.freeze({ expanded: (v) => typeof v === 'boolean' });

/**
 * A mod's defaults, checked: `{id, of: 'Draft', where, target, content}`, `{id, of: 'Setting', key, value}` or `{id, of: 'Automation', where,
 * values}`. Throws Invalid with the reason.
 */
export function compileDefaults(spec) {
  if (!isObj(spec)) throw invalid('defaults are an object');
  if (typeof spec.id !== 'string' || !ID.test(spec.id)) throw invalid('id is 1-64 lowercase letters, digits and "-"');
  if (spec.of === 'Setting') {
    fieldsOnly(spec, ['id', 'of', 'key', 'value']);
    if (typeof spec.key !== 'string' || !spec.key || spec.key.length > 200) throw invalid('key is a setting\'s key');
    let value;
    try { value = spec.value === undefined ? undefined : JSON.parse(JSON.stringify(spec.value)); } catch { value = undefined; }
    if (value === undefined || value === null) throw invalid('value is the setting\'s default (JSON, not null)');
    if (JSON.stringify(value).length > 16384) throw invalid('value is at most 16 KB of JSON');
    return Object.freeze({ id: spec.id, of: 'Setting', where: null, key: spec.key, value, spec: structuredClone(spec) });
  }
  if (spec.of === 'Automation') {
    fieldsOnly(spec, ['id', 'of', 'where', 'values']);
    const where = whereOf(spec);
    if (!isObj(spec.values) || !Object.keys(spec.values).length) throw invalid('values give some of name, enabled, project, settings, where, notifications, archiveRuns');
    for (const [k, v] of Object.entries(spec.values)) {
      if (!Object.hasOwn(AUTOMATION_VALUES, k)) throw invalid(`values.${k} is not a field an automation's default gives (its prompt, schedule and chat are its creator's)`);
      if (!AUTOMATION_VALUES[k](v)) throw invalid(`values.${k} is not a valid ${k}`);
    }
    return Object.freeze({ id: spec.id, of: 'Automation', where, values: Object.freeze(structuredClone(spec.values)), spec: structuredClone(spec) });
  }
  if (spec.of !== 'Draft' && spec.state !== undefined) {
    // a presentation's: whether `of` is one (with the operations its state is set by) the graph checks against its types
    fieldsOnly(spec, ['id', 'of', 'for', 'where', 'state']);
    if (typeof spec.of !== 'string' || !TYPE_NAME.test(spec.of)) throw invalid('of is a presentation type');
    const fors = spec.for === undefined ? null : Array.isArray(spec.for) ? spec.for : [spec.for];
    if (fors && (!fors.length || fors.length > 16 || fors.some((t) => typeof t !== 'string' || !TYPE_NAME.test(t)))) throw invalid('for is a type (or a list of at most 16): its subject\'s');
    const where = whereOf(spec);
    if (!isObj(spec.state) || !Object.keys(spec.state).length) throw invalid('state gives expanded');
    for (const [k, v] of Object.entries(spec.state)) {
      if (!Object.hasOwn(PRESENTATION_STATE, k)) throw invalid(`state.${k} has no default: only expanded (sizes and open panels are the app's to keep)`);
      if (!PRESENTATION_STATE[k](v)) throw invalid(`state.${k} is not a valid ${k}`);
    }
    return Object.freeze({ id: spec.id, of: spec.of, presentation: true, for: fors ? Object.freeze([...fors]) : null, where, state: Object.freeze({ ...spec.state }), spec: structuredClone(spec) });
  }
  if (spec.of !== 'Draft') throw invalid('of is "Draft" (a new chat\'s target and text), "Setting", "Automation", or a presentation type with its state');
  fieldsOnly(spec, ['id', 'of', 'where', 'target', 'content']);
  const where = whereOf(spec);
  const target = {};
  if (spec.target !== undefined) {
    if (!isObj(spec.target)) throw invalid('target is {project?, environment?, branch?, model?, settings?}');
    for (const [k, v] of Object.entries(spec.target)) {
      if (!TARGET_KEYS.has(k)) throw invalid(`target.${k} is not a field of a new chat's target`);
      if (k === 'settings') {
        // Codex's effort and mode, or a provided agent's own settings by id (public-hooks.md §3.15): a name, a number or a boolean each,
        // applied to a new chat on that agent's model only (what Codex takes is checked when applied: H7pn review 2)
        if (isObj(v) && v.access !== undefined) throw invalid('target.settings.access is the user\'s to choose, never a default');
        if (!isObj(v) || Object.entries(v).some(([s, x]) => !s || s.length > 200 || !['string', 'number', 'boolean'].includes(typeof x) || (typeof x === 'number' && !Number.isFinite(x)) || (typeof x === 'string' && x.length > 1000))) {
          throw invalid('target.settings is {id: value}: Codex\'s effort and mode, or a provided agent\'s settings (a name, a number or a boolean)');
        }
        target.settings = { ...v };
      } else if (k === 'environment') {
        if (v !== 'worktree' && !isRef(v)) throw invalid('target.environment is an Environment\'s ref or "worktree"');
        target.environment = v;
      } else if (!isRef(v)) throw invalid(`target.${k} is a ref`);
      else target[k] = v;
    }
  }
  let content = null;
  if (spec.content !== undefined) {
    if (!isObj(spec.content) || !Array.isArray(spec.content.parts) || !spec.content.parts.length || spec.content.parts.some((p) => !isObj(p))) throw invalid('content is {parts: [...]}');
    content = structuredClone(spec.content);
  }
  if (!Object.keys(target).length && !content) throw invalid('defaults give a target or content');
  return Object.freeze({ id: spec.id, of: 'Draft', where, target: Object.freeze(target), content, spec: structuredClone(spec) });
}

/** A chat run's fields: an automation that watches a chat (each run a turn in it) takes none of them, from its spec or a default. */
export const CHAT_RUN_FIELDS = Object.freeze(['project', 'settings', 'where', 'archiveRuns']);
/**
 * An automation's defaults (`defaultsFor('Automation', toBe)`, in the mods' order) as one set of values: each field from the first that
 * gives it, none in `given` (the spec's own), none of a chat run's for one that watches a chat (`watches`).
 */
export function automationValues(list, given = {}, watches = false) {
  const out = {};
  for (const d of list ?? []) {
    for (const [k, v] of Object.entries(d.values ?? {})) {
      if (out[k] !== undefined || given[k] !== undefined || (watches && CHAT_RUN_FIELDS.includes(k))) continue;
      out[k] = v;
    }
  }
  return out;
}

/** The fields of a target as one flat map (`settings.effort` apart): what a default gives and what the user may have chosen. */
export function flatTarget(t) {
  const out = {};
  for (const [k, v] of Object.entries(t ?? {})) {
    if (k === 'settings' && isObj(v)) { for (const [s, x] of Object.entries(v)) out[`settings.${s}`] = x; } else out[k] = v;
  }
  return out;
}
/** A flat map back to a target. */
export function nestTarget(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith('settings.')) out.settings = { ...(out.settings ?? {}), [k.slice(9)]: v }; else out[k] = v;
  }
  return out;
}
