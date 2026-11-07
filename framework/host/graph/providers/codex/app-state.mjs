// App, Theme, Setting and SettingsSection in the native provider (breadth step D4; docs/graph/02-types.md; scout
// docs/design/realization/scouting/D4-21477.md), from the Host's copy of the app's own state (graph/app-state.mjs, read by
// framework/main/app-state.cjs) and the theme a window reports (`framework/theme` on the bus: its token values and appearance).
// - Setting: one per setting of the app's registry that is not hidden, named by its key. Its title and section are the app's settings page
//   that shows it (settings-catalog.mjs: the registry has neither); its kind and choices come from the setting's JSON Schema; `value` is
//   the effective value (else the configured one, else the default); scope `app` (the registry is local to this Mac); definedBy the App.
//   Thread-scope settings (model, effort, access) are the composer's (breadth step D5).
// - SettingsSection: one per settings page that shows a setting, and `other` for a setting no page shows.
// - Theme (one): mode is the `appearanceTheme` setting; appearance the system's resolved one; accent, fonts and tokens are the values the
//   first shown window's theme shows (the adapter's token map: `accent` the user's accent, `fontFamily`, `codeFontFamily`; a hidden window,
//   such as the hotkey window, has its own look), the font size the `sansFontSize` setting. The app has no density: it is not realized.
// - App (one): version from the app, onboarded by the app's own rule; linked to its Theme, its settings, the Codex agent and its account,
//   the projects and the apps on this Mac. windowOpened and windowClosed follow the framework's window events (a window opens when it is
//   first shown: the app creates some hidden); launched says the app started (once, when the App is first put within LAUNCH_MS of the
//   app's start: a Host that starts later did not see the launch, and the first window opens with it); quitting, when the app starts to
//   quit (it may still cancel, from its own dialog).
// Operations: Setting.set and reset write the app's way (framework-main's `write-setting`: the UI's own path, so an open Settings page
// shows it); the app lets its own agent write only some settings (`agentAccess`), so a mod's write of a setting the agent may only read
// asks the user first (runtime-core.md R17). reset takes the user's value away (the default holds then: a mod's, the app's, or the app's
// built-in look for one with none).
// Theme.set('mode' | 'size', value) writes the setting behind it. App.openHelp opens the first item of the app's Help menu
// (Documentation); App.quit quits as Cmd+Q does, after the user approves a mod's call (R17); App.sendFeedback sends the text to OpenAI as
// the app's feedback (the protocol's `feedback/upload`, no logs), after the user approves (R17: it leaves this Mac).
import { refs } from './map.mjs';
import { SECTIONS, SETTINGS } from './settings-catalog.mjs';
import { NEW_DRAFT as NEW_CHAT_DRAFT } from './areas/composer.mjs';

const LAUNCH_MS = 5 * 60_000;
/** Settings whose value the app reads past its settings store's effective value (21477: the link opening's and the close guard's own
 *  reads of what the user set; the side and bottom panels' kept sizes, read only when a panel is made, where a window's own value cannot
 *  stand in: layouts.md D4): a mod's default would not be what the app does, so none is taken. The sidebar's width takes one: each window
 *  where the user kept none starts with it (the windows provider). */
const UNREACHED = new Set(['open-link-in-target-preference', 'confirm-before-close', 'layout.panelShare', 'layout.bottomHeight']);

const humanize = (key) => {
  const words = String(key).replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
};
const variantsOf = (schema) => (Array.isArray(schema?.anyOf) ? schema.anyOf : Array.isArray(schema?.oneOf) ? schema.oneOf : schema ? [schema] : [])
  .filter((v) => v && v.type !== 'null');
const typeOf = (v) => (Array.isArray(v.type) ? v.type.find((t) => t !== 'null') : v.type);

/** A setting's kind, from the JSON Schema of its value. */
export function kindOf(schema) {
  const variants = variantsOf(schema);
  if (variants.some((v) => Array.isArray(v.enum) || v.const !== undefined)) return 'choice';
  switch (variants.length ? typeOf(variants[0]) : undefined) {
    case 'boolean': return 'toggle';
    case 'number': case 'integer': return 'number';
    case 'string': return 'text';
    case 'array': return 'list';
    default: return 'record';
  }
}
/** A choice setting's choices, from its schema's enums and consts. */
export function choicesOf(schema) {
  const ids = [];
  for (const v of variantsOf(schema)) {
    for (const x of Array.isArray(v.enum) ? v.enum : v.const !== undefined ? [v.const] : []) if ((typeof x === 'string' || typeof x === 'number') && !ids.includes(String(x))) ids.push(String(x));
  }
  return ids.map((id) => ({ id, label: humanize(id) }));
}
const sectionOf = (key) => (SETTINGS[key]?.[0] ?? 'other');
const textOf = (c) => (Array.isArray(c?.parts) ? c.parts.filter((p) => p?.kind === 'text').map((p) => String(p.text ?? '')).join('') : '');

/**
 * Whether a value fits a setting's JSON Schema (the app's zod type as JSON Schema), so a mod's default (public-hooks.md §3.8) is one the app
 * would take: every keyword it checks is checked (an object's properties, required and additional ones, a string's length, pattern and
 * format, a number's bounds, a list's items, exactly one branch of a oneOf, `$ref` within the schema); annotations are not; a schema with a
 * keyword it cannot check, or a value that is not JSON, takes nothing.
 */
export function fits(schema, value) {
  return isJson(value, 0) && check(schema, value, schema, 0);
}
const ANNOTATIONS = ['$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'];
const KEYWORDS = new Set([...ANNOTATIONS, '$ref', 'type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'properties', 'required', 'additionalProperties',
  'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength',
  'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const FORMATS = {
  email: (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x),
  uri: (x) => { try { return /^[a-z][a-z0-9+.-]*:/i.test(x) && Boolean(new URL(x)); } catch { return false; } },
  url: (x) => FORMATS.uri(x),
  uuid: (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x),
  'date-time': (x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(x) && !Number.isNaN(Date.parse(x)),
  date: (x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)),
};
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isJson = (v, depth) => depth < 32 && (v === null || typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v)
  || (Array.isArray(v) && v.every((x) => isJson(x, depth + 1))) || (isPlain(v) && Object.values(v).every((x) => isJson(x, depth + 1))));
const sameJson = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isPlain(a) || isPlain(b)) return isPlain(a) && isPlain(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  return a === b;
};
const isType = (t, v) => (t === 'null' ? v === null : t === 'boolean' ? typeof v === 'boolean' : t === 'string' ? typeof v === 'string'
  : t === 'number' ? Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? isPlain(v) : false);
/** A `$ref` within the schema (`#`, `#/$defs/x`, `#/definitions/x`, any JSON pointer into it); another document's: undefined. */
function refOf(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let at = root;
  for (const part of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}
function check(s, v, root, depth) {
  if (s === true) return true;
  if (!s || typeof s !== 'object' || Array.isArray(s) || depth > 64) return false;
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) return false;
  const sub = (x, w) => check(x, w, root, depth + 1);
  const list = (x) => Array.isArray(x) && x.length > 0;
  if (s.$ref !== undefined) { const target = refOf(root, s.$ref); if (target === undefined || !sub(target, v)) return false; }
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => isType(t, v))) return false;
  if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.some((x) => sameJson(x, v)))) return false;
  if ('const' in s && !sameJson(s.const, v)) return false;
  if (s.allOf !== undefined && !(list(s.allOf) && s.allOf.every((x) => sub(x, v)))) return false;
  if (s.anyOf !== undefined && !(list(s.anyOf) && s.anyOf.some((x) => sub(x, v)))) return false;
  if (s.oneOf !== undefined && !(list(s.oneOf) && s.oneOf.filter((x) => sub(x, v)).length === 1)) return false;
  if (s.not !== undefined && sub(s.not, v)) return false;
  const num = (k) => (s[k] === undefined ? null : Number.isFinite(s[k]) ? s[k] : NaN);
  if (typeof v === 'string') {
    const n = [...v].length;
    for (const [k, ok] of [['minLength', (m) => n >= m], ['maxLength', (m) => n <= m]]) { const m = num(k); if (m !== null && !(Number.isInteger(m) && ok(m))) return false; }
    if (s.pattern !== undefined) { let re; try { re = new RegExp(s.pattern, 'u'); } catch { return false; } if (!re.test(v)) return false; }
    if (s.format !== undefined && !(Object.hasOwn(FORMATS, s.format) && FORMATS[s.format](v))) return false;
  }
  if (typeof v === 'number') {
    const ex = (k, base) => (typeof s[k] === 'boolean' ? (s[k] ? num(base) : null) : num(k));   // draft 4's boolean form bounds by minimum/maximum
    const [min, max, xmin, xmax, mult] = [num('minimum'), num('maximum'), ex('exclusiveMinimum', 'minimum'), ex('exclusiveMaximum', 'maximum'), num('multipleOf')];
    if ([min, max, xmin, xmax, mult].some(Number.isNaN)) return false;
    if ((min !== null && v < min) || (max !== null && v > max) || (xmin !== null && v <= xmin) || (xmax !== null && v >= xmax)) return false;
    if (mult !== null && (mult <= 0 || Math.abs(v / mult - Math.round(v / mult)) > 1e-9)) return false;
  }
  if (Array.isArray(v)) {
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;   // a list of items: draft 4's tuple
    if (s.prefixItems !== undefined && !Array.isArray(s.prefixItems)) return false;
    if (prefix && !prefix.every((x, i) => i >= v.length || sub(x, v[i]))) return false;
    const rest = Array.isArray(s.items) ? undefined : s.items;
    if (rest !== undefined && !v.slice(prefix ? prefix.length : 0).every((x) => sub(rest, x))) return false;
    const [lo, hi] = [num('minItems'), num('maxItems')];
    if ((lo !== null && !(v.length >= lo)) || (hi !== null && !(v.length <= hi))) return false;
    if (s.uniqueItems === true && v.some((x, i) => v.findIndex((y) => sameJson(x, y)) !== i)) return false;
  }
  if (isPlain(v)) {
    const keys = Object.keys(v);
    if (s.properties !== undefined && !isPlain(s.properties)) return false;
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k) => typeof k === 'string' && Object.hasOwn(v, k)))) return false;
    const [lo, hi] = [num('minProperties'), num('maxProperties')];
    if ((lo !== null && !(keys.length >= lo)) || (hi !== null && !(keys.length <= hi))) return false;
    const patterns = [];
    if (s.patternProperties !== undefined) {
      if (!isPlain(s.patternProperties)) return false;
      for (const [p, x] of Object.entries(s.patternProperties)) { try { patterns.push([new RegExp(p, 'u'), x]); } catch { return false; } }
    }
    for (const k of keys) {
      if (s.propertyNames !== undefined && !sub(s.propertyNames, k)) return false;
      let named = false;
      if (s.properties && Object.hasOwn(s.properties, k)) { named = true; if (!sub(s.properties[k], v[k])) return false; }
      for (const [re, x] of patterns) if (re.test(k)) { named = true; if (!sub(x, v[k])) return false; }
      if (!named && s.additionalProperties !== undefined && !sub(s.additionalProperties, v[k])) return false;
    }
  }
  return true;
}

/** A setting's definition and values -> its Setting instance; `modDefault`: a mod's default of it, shown as its default (§3.8). */
export function settingData(def, v, modDefault) {
  const kind = kindOf(def.schema);
  const fallback = modDefault !== undefined ? modDefault : def.default;
  const value = v?.effective !== undefined ? v.effective : v?.configured !== undefined ? v.configured : fallback !== undefined ? fallback : null;
  return {
    ref: refs.setting(def.key),
    state: {
      title: SETTINGS[def.key]?.[1] ?? humanize(def.key), key: def.key, value, default: fallback !== undefined ? fallback : null, scope: 'app', kind,
      // the user set it (a value of their own, not the default), and what they set where the app uses another for now (its policy): what
      // a temporary change keeps aside (H7y)
      overridden: v?.configured !== undefined,
      ...(v?.configured !== undefined && v?.effective !== undefined && JSON.stringify(v.configured) !== JSON.stringify(v.effective) ? { configured: v.configured } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(kind === 'choice' ? { choices: choicesOf(def.schema) } : {}),
    },
    links: { section: refs.settingsSection(sectionOf(def.key)), definedBy: refs.app() },
  };
}
/** A settings page -> the SettingsSection instance. */
export function sectionData(slug) {
  return { ref: refs.settingsSection(slug), state: { title: SECTIONS[slug] ?? humanize(slug) }, links: {} };
}
/** The theme: the settings behind it, the system's appearance and a window's theme report. */
export function themeData(valueOf, appearance, report, settingRefs = []) {
  const eff = (k) => { const v = valueOf(k); return v?.effective !== undefined ? v.effective : v?.configured; };
  const tokens = report?.tokens && typeof report.tokens === 'object' ? report.tokens : {};
  const str = (x) => (typeof x === 'string' ? x : '');
  const mode = ['light', 'dark', 'system'].includes(eff('appearanceTheme')) ? eff('appearanceTheme') : 'system';
  const size = Number.isFinite(eff('sansFontSize')) ? eff('sansFontSize') : 14;
  return {
    ref: refs.theme(),
    state: {
      mode, appearance: appearance === 'dark' || appearance === 'light' ? appearance : report?.appearance === 'dark' ? 'dark' : 'light',
      accent: str(tokens.accent), fonts: { ui: str(tokens.fontFamily), code: str(tokens.codeFontFamily), size }, tokens: { ...tokens },
    },
    links: { app: refs.app(), settings: settingRefs },
  };
}
/** The app -> the App instance. */
export function appData(facts, links) {
  return {
    ref: refs.app(),
    state: { version: facts?.version ?? 'unknown', ...(typeof facts?.onboarded === 'boolean' ? { onboarded: facts.onboarded } : {}) },
    links: { theme: refs.theme(), ...links },
  };
}

/** The operation handlers, for the provider's registration. */
export function appStateTypes(feed) {
  return {
    Setting: {
      operations: {
        // The app lets its own agent change only some settings: a mod's change of another asks the user first (R17).
        set: { effect: 'external', approval: ({ instance, args }) => feed.prompt(instance, { op: 'set', value: args[0] }), handler: ({ ref, args }) => feed.write(ref.id, args[0]) },
        reset: { effect: 'external', approval: ({ instance }) => feed.prompt(instance, { op: 'reset' }), handler: ({ ref }) => feed.reset(ref.id) },
      },
    },
    Theme: { operations: { set: { effect: 'external', handler: ({ args }) => feed.setTheme(args[0], args[1]) } } },
    App: {
      operations: {
        openHelp: { effect: 'none', handler: () => feed.openHelp() },
        // Quitting ends every running chat's work and sending feedback leaves this Mac: a mod's call asks the user first (R17).
        quit: { effect: 'external', approval: () => ({ action: 'quit Codex', detail: 'Codex quits as it does from its menu; it may still ask you about chats that are running.' }), handler: () => feed.quit() },
        sendFeedback: { effect: 'external', approval: ({ args }) => feed.feedbackPrompt(args[0]), handler: ({ args }) => feed.sendFeedback(args[0]) },
        // a folder added as a project, as the app's "Add new project" does (the app asks the user to trust a new folder itself)
        ...(typeof feed.addProject === 'function' ? { addProject: { effect: 'external', handler: ({ args }) => feed.addProject(args[0]) } } : {}),
        // the Window the user is in (the windows provider's choice: the focused window with a page, else the only one), or null
        ...(typeof feed.frontWindow === 'function' ? { frontWindow: { effect: 'none', handler: async () => { const id = await feed.frontWindow(); return Number.isSafeInteger(id) ? { type: 'Window', provider: 'codexmods.windows', id: String(id) } : null; } } } : {}),
        // a new window, the app's own way, showing the ref (the windows provider's: a chat opens in it, anything else after it comes)
        ...(typeof feed.openWindow === 'function' ? { openWindow: { effect: 'local', handler: ({ args, caller, origin }) => feed.openWindow(args[0], { caller, origin }) } } : {}),
      },
    },
  };
}

/**
 * @param {{ handle: object, graph: object, appState: ReturnType<typeof import('../../app-state.mjs').createAppState>,
 *   appProjects?: ReturnType<typeof import('../../app-projects.mjs').createAppProjects> | null, bus?: { subscribe(topic: string, fn: Function): Function | { dispose(): void } } | null,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   rpc?: (method: string, params?: object) => Promise<any>, account?: () => object | null, log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createAppStateFeed(o) {
  const { handle, graph, appState, safe } = o;
  let themeReport = null;        // the theme the user sees: the report of the first window shown that has one, {tokens, appearance}
  const reports = new Map();     // windowId -> that window's last theme report
  const shown = new Set();       // the windows the user sees, in the order they were shown (the app creates some hidden)
  let disposed = false;
  const putKeys = new Set();     // setting keys with an instance

  const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // A mod's default of a setting (public-hooks.md §3.8, H6i): the first in the mods' order whose value fits the setting's schema is its
  // default, which framework-main makes the setting's value wherever the user set none (the user's value wins); shown as its default.
  let given = { out: {}, by: {} };
  let toldDefaults = null;   // what framework-main was told last (JSON), null: tell it again
  function modDefaults() {
    const out = {}, by = {};
    if (typeof graph.defaultsFor !== 'function') return { out, by };
    for (const def of appState.definitions()) {
      if (UNREACHED.has(def.key)) continue;
      const inst = o.resident(refs.setting(def.key));
      if (!inst) continue;
      for (const d of graph.defaultsFor('Setting', inst)) if (d.key === def.key && fits(def.schema, d.value)) { out[def.key] = d.value; by[def.key] = d.mod; break; }
    }
    return { out, by };
  }
  async function tellDefaults() {
    const said = JSON.stringify(given.out);
    if (said === toldDefaults || disposed) return;
    toldDefaults = said;
    const r = await appState.op('setting-defaults', { defaults: given.out });
    if (!r.ok) { if (toldDefaults === said) toldDefaults = null; o.log.warn('settings: the mods\' defaults were not given to the app', { message: r.error }); }
  }
  /** The mods' defaults again (they changed, or the settings were read anew): the instances say them, framework-main makes them so. */
  function applyDefaults() {
    given = modDefaults();
    putSettings(false, null);
    void tellDefaults();
  }
  function putSettings(sync, keys) {
    const defs = appState.definitions();
    const slugs = new Set(defs.map((d) => sectionOf(d.key)));
    for (const slug of slugs) if (!o.resident(refs.settingsSection(slug))) { const d = sectionData(slug); safe('settings section', () => handle.put(d.ref, { state: d.state, links: d.links })); }
    const wanted = new Set(defs.map((d) => d.key));
    for (const d of defs) {
      if (keys && !keys.has(d.key) && putKeys.has(d.key)) continue;
      const data = settingData(d, appState.value(d.key), given.out[d.key]);
      const cur = o.resident(data.ref);
      safe('setting', () => handle.put(data.ref, { state: data.state, links: data.links }));
      putKeys.add(d.key);
      if (!sync && cur && !sameState(cur.state.value, data.state.value)) o.emitEvent(data.ref, 'changed');
    }
    for (const k of [...putKeys]) if (!wanted.has(k)) { putKeys.delete(k); if (o.resident(refs.setting(k))) safe('setting removal', () => handle.remove(refs.setting(k))); }
    for (const x of graph.list('SettingsSection') ?? []) if (x.ref.provider === handle.id && !slugs.has(x.ref.id)) safe('settings section removal', () => handle.remove(x.ref));
  }
  function putTheme(sync) {
    if (!appState.definitions().length && !themeReport) return;
    const appearanceRefs = appState.definitions().filter((d) => sectionOf(d.key) === 'appearance').map((d) => refs.setting(d.key));
    const data = themeData((k) => appState.value(k), appState.appearance, themeReport, appearanceRefs);
    const cur = o.resident(data.ref);
    safe('theme', () => handle.put(data.ref, { state: data.state, links: data.links }));
    if (!sync && cur && !sameState(cur.state, data.state)) o.emitEvent(data.ref, 'changed');
  }
  function putApp() {
    if (!appState.app || !o.resident(refs.theme())) return;
    const links = {
      agents: [refs.agent()],
      accounts: o.account?.() ? [o.account()] : [],
      settings: [...putKeys].map((k) => refs.setting(k)),
      projects: (o.appProjects?.list() ?? []).map((p) => refs.project(p.id)),
      externalApps: (graph.list('ExternalApp') ?? []).filter((x) => x.ref.provider === handle.id && !x.gone).map((x) => x.ref),
      // the new chat's Draft (graph-layers.md §3.2: one text for every project and none on this build)
      newChatDraft: refs.draft(NEW_CHAT_DRAFT),
    };
    const data = appData(appState.app, links);
    const first = !o.resident(data.ref);
    // Links another area writes (App.automations, D9) stay: this put names only the App's own.
    safe('app', () => handle.put(data.ref, { state: data.state, links: { ...(o.resident(data.ref)?.links ?? {}), ...data.links } }));
    const at = appState.app.launchedAt;
    if (first && Number.isFinite(at) && (o.now ?? Date.now)() - at < LAUNCH_MS) o.emitEvent(data.ref, 'launched');
  }
  const sub = appState.onChange((c) => {
    if (disposed) return;
    if (c.definitions || c.settings) putSettings(c.sync, c.definitions ? null : new Set(c.settings ?? []));
    // the settings read anew (framework-main may have started again, with no defaults, or come back to a window): the mods' are told again
    if (c.definitions || c.reset) { toldDefaults = null; applyDefaults(); }
    if (c.definitions || c.settings || c.appearance) putTheme(c.sync);
    putApp();
    if (c.quitting && o.resident(refs.app())) o.emitEvent(refs.app(), 'quitting');
  });
  const projSub = o.appProjects?.onChange(() => { if (!disposed) putApp(); });
  // The theme is what the user sees: the first shown window's (a hidden window, such as the hotkey window, has its own look); before any
  // window was shown, the first window's that reported.
  function chooseTheme() {
    const id = [...shown].find((w) => reports.has(w)) ?? [...reports.keys()].sort((a, b) => a - b)[0];
    const next = id === undefined ? null : reports.get(id);
    if (sameState(next, themeReport)) return;
    const first = !themeReport;
    themeReport = next;
    if (!next) return;
    putTheme(first);
    putApp();
  }
  const busOff = o.bus?.subscribe?.('framework/theme', (m) => {
    if (disposed || !m || typeof m.tokens !== 'object' || !Number.isInteger(m.windowId)) return;
    reports.set(m.windowId, { tokens: m.tokens, appearance: m.appearance });
    chooseTheme();
  });
  // A window opens when it is first shown: the app creates some hidden (the hotkey window, the dictation and avatar overlays) and shows them
  // later, if ever. One subscription, so a window's shown and closed come in their order.
  const windowOff = o.bus?.subscribe?.('window/*', (m, topic) => {
    if (disposed || (topic !== 'window/shown' && topic !== 'window/closed')) return;
    const id = m?.windowId;
    if (topic === 'window/closed') reports.delete(id);
    const was = shown.has(id);
    if (topic === 'window/shown') shown.add(id); else shown.delete(id);
    chooseTheme();
    if (was === (topic === 'window/shown')) return;
    if (o.resident(refs.app())) o.emitEvent(refs.app(), topic === 'window/shown' ? 'windowOpened' : 'windowClosed');
  });
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  async function write(key, value) {
    if (value === undefined) return refused('invalid', 'a value is needed');
    const r = await appState.op('write-setting', { key, value });
    if (r.ok) return null;
    if (r.refused) return refused('invalid', r.error);
    throw new Error(r.error);
  }

  const defaultsSub = graph.onDefaults?.(() => { if (!disposed) applyDefaults(); }) ?? null;
  // A sync of what is already known (the source starts after the first reports may have arrived).
  if (appState.definitions().length) { putSettings(true, null); putTheme(true); putApp(); applyDefaults(); }

  return {
    /** What the user is asked before a mod writes a setting the app's own agent may only read (R17), or null. */
    prompt(instance) {
      const def = appState.definition(instance.ref.id);
      if (!def || def.agentAccess !== 'read-only') return null;
      return { action: `change the setting “${instance.state.title}”`, detail: 'Codex does not let its own agent change this setting. The change is saved in your Codex settings on this Mac.' };
    },
    write,
    /** The App's links again (the account changed). */
    relink() { if (!disposed) putApp(); },
    /**
     * No value of the user's (H7y): the setting is then its default, a mod's where one is given (§3.8), else the app's, else the app's
     * built-in look (a chrome theme). The app's own write cannot say "no value" (framework-main's `unset-setting` goes below it), and
     * writing the default would make it the user's value, kept when a mod's default goes.
     */
    async reset(key) {
      if (!appState.definition(key)) return refused('unavailable', 'the app has no such setting');
      const r = await appState.op('unset-setting', { key });
      if (r.ok) return null;
      if (r.refused) return refused('unsupported', `the app keeps a value for it: ${r.error ?? 'its settings store cannot be reached'}`);
      throw new Error(r.error);
    },
    async openHelp() {
      const r = await appState.op('open-help');
      if (r.ok) return null;
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    async quit() {
      const r = await appState.op('quit');
      if (r.ok) return null;
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    feedbackPrompt(content) {
      const text = textOf(content);
      return { action: 'send feedback about Codex to OpenAI', detail: `It sends this text, without logs: “${text.length > 300 ? `${text.slice(0, 300)}…` : text}”` };
    },
    async sendFeedback(content) {
      const text = textOf(content);
      if (!text.trim()) return refused('invalid', 'the feedback is empty');
      if (typeof o.rpc !== 'function') return refused('unavailable', 'the app-server cannot be reached');
      await o.rpc('feedback/upload', { classification: 'other', reason: text, includeLogs: false, tags: { source: 'codexmods' } });
      return null;
    },
    async setTheme(field, value) {
      if (field === 'mode') return ['light', 'dark', 'system'].includes(value) ? write('appearanceTheme', value) : refused('invalid', 'the mode is light, dark or system');
      if (field === 'size' || field === 'fonts.size') return Number.isFinite(value) ? write('sansFontSize', value) : refused('invalid', 'the size is a number');
      return refused('unsupported', `the theme's ${String(field)} is not set this way here`);
    },
    dispose() {
      disposed = true;
      sub.dispose();
      projSub?.dispose();
      defaultsSub?.dispose();
      for (const off of [busOff, windowOff]) { if (typeof off === 'function') off(); else off?.dispose?.(); }
    },
  };
}
