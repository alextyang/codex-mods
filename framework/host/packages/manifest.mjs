// mod.json validation (contracts/manifest.d.ts, ARCHITECTURE §7.1). Messages are path-precise: "entry.host: ...".
import { CodexModsError } from '../../../sdk/errors.mjs';
import { parseVersion, parseRange } from './semver.mjs';
import { checkDeclarations } from './settings.mjs';
import { overlaps } from '../permissions.mjs';
import { validateWhere } from '../../shared/where.mjs';
import { INTERNAL_MOD_IDS } from '../../shared/internal-mods.mjs';

const COMPONENTS = ['Button', 'Switch', 'TextField', 'Menu', 'Dialog', 'SettingsSection', 'SettingsCard', 'SettingsRow', 'Tooltip', 'Icon', 'Badge', 'Banner', 'Checkbox', 'EmptyState', 'Glyph', 'IconTile', 'MenuButton', 'SearchField', 'SegmentedControl', 'Select', 'Tabs', 'SettingRow',
  // the parts the framework lends (graph-integrity G2.3)
  'Transcript', 'Turn', 'Message', 'StepRow', 'DiffView', 'FileChip', 'ApprovalCard', 'QuestionCard', 'ThreadHeader', 'Composer', 'ModelPicker', 'EffortPicker'];
const PLAIN_PERMISSIONS = ['appServer.backends', 'appServer.clients', 'ui', 'secrets', 'processes', 'network', 'framework.updates', 'graph'];
/** The most instances of one session a mod may run at once. */
export const MAX_INSTANCES = 16;
const SCOPED_PERMISSIONS = ['appServer.observe', 'appServer.request', 'appServer.intercept', 'graph.read', 'graph.act', 'graph.intercept', 'graph.attach', 'graph.contribute', 'graph.present', 'processes.exec'];
/** Scoped permissions that are never bare: each names what it covers, so consent shows it and a new one asks again (D4: the programs a mod runs). */
const NAMED_ONLY = ['processes.exec'];
/** A program on the user's Mac, as a session process names it (graph-integrity G8.2, D4): its name alone, found on the user's PATH at each start. */
export const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const RESERVED_ID = 'codexmods.framework';
/** Provider ids that are not a mod's (graph/policy.mjs RESERVED_PROVIDERS): a mod's id is its provider id, so no mod may take one. */
const RESERVED_PROVIDER_IDS = ['codex', 'codexmods.windows', 'codexmods.commands'];   // the native provider's, the windows provider's (systems.md S10), the mods' commands' (E8.11)
/** The framework's internal mods (framework/host/internal-mods.mjs): shipped with it, never a package. */
const INTERNAL_IDS = INTERNAL_MOD_IDS;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (path, msg) => new CodexModsError('Invalid', `${path}: ${msg}`, { path });

/** Package-relative path check: no absolute paths, no '..', no backslashes, no empty segments. Throws Invalid. */
export function checkRelativePath(value, path) {
  if (typeof value !== 'string' || value === '') throw invalid(path, 'must be a non-empty string');
  if (value.includes('\\') || value.includes('\u0000')) throw invalid(path, 'must use "/" separators');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw invalid(path, 'must be package-relative, not absolute');
  for (const seg of value.split('/')) if (seg === '' || seg === '.' || seg === '..') throw invalid(path, 'must not contain empty, "." or ".." segments');
  return value;
}

export function isValidPermission(p) {
  if (typeof p !== 'string') return false;
  if (PLAIN_PERMISSIONS.includes(p)) return true;
  const i = p.indexOf(':');
  const base = i < 0 ? p : p.slice(0, i);
  if (!SCOPED_PERMISSIONS.includes(base)) return false;
  if (i < 0) return !NAMED_ONLY.includes(base);
  const list = p.slice(i + 1).split(',');
  if (base === 'processes.exec') return list.every((m) => EXECUTABLE_NAME.test(m));
  return list.length > 0 && list.every((m) => m.length > 0 && !/\s/.test(m));
}
/** The programs a manifest's `processes.exec` permissions name (required or optional): what its session processes may run. */
const executablesOf = (m) => new Set([...(m.permissions ?? []), ...(m.optionalPermissions ?? [])].filter((p) => typeof p === 'string' && p.startsWith('processes.exec:')).flatMap((p) => p.slice('processes.exec:'.length).split(',')));

/** True when `grants` already covers `permission` (a bare scoped permission covers every scope of the same base). */
export function permissionCovered(permission, grants) {
  if (grants.includes(permission)) return true;
  const i = permission.indexOf(':');
  if (i < 0) return false;
  const base = permission.slice(0, i);
  if (!SCOPED_PERMISSIONS.includes(base) || NAMED_ONLY.includes(base) || !grants.includes(base)) return false;
  return true;
}

function stringArray(value, path, allowed) {
  if (!Array.isArray(value)) throw invalid(path, 'must be an array');
  const seen = new Set();
  value.forEach((item, i) => {
    if (typeof item !== 'string' || !item) throw invalid(`${path}[${i}]`, 'must be a non-empty string');
    if (allowed && !allowed.includes(item)) throw invalid(`${path}[${i}]`, `unknown name "${item}"`);
    if (seen.has(item)) throw invalid(`${path}[${i}]`, `duplicate "${item}"`);
    seen.add(item);
  });
}

const CAPABILITY_LISTS = new Set(['methods', 'components', 'features']);
function capabilityLists(value, path) {
  if (!isObj(value)) throw invalid(path, 'must be an object');
  const unknown = Object.keys(value).find((k) => !CAPABILITY_LISTS.has(k));
  if (unknown !== undefined) throw invalid(`${path}.${unknown}`, 'is not something a mod can name here (methods, components, features)');
  if (value.methods !== undefined) stringArray(value.methods, `${path}.methods`);
  if (value.components !== undefined) stringArray(value.components, `${path}.components`, COMPONENTS);
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) throw invalid(`${path}.features`, 'must be an array');
    value.features.forEach((f, i) => {
      const id = typeof f === 'string' ? f : isObj(f) ? f.id : undefined;
      if (typeof id !== 'string' || !/^[a-z]+:\S+$/.test(id)) throw invalid(`${path}.features[${i}]`, 'must be a feature id ("graph:Thread") or {id, version}');
      if (isObj(f) && f.version !== undefined && !(Number.isInteger(f.version) && f.version >= 1)) throw invalid(`${path}.features[${i}].version`, 'must be an integer of at least 1');
      if (isObj(f) && Object.keys(f).some((k) => k !== 'id' && k !== 'version')) throw invalid(`${path}.features[${i}]`, 'has only id and version');
    });
  }
}

/**
 * A mod's automatic actions (docs/design/public-hooks.md §3.9): calls it may make without asking, each off until the user turns it on.
 * `{id, operation: 'Type.operation', why, perHour, where?, args?: {'<index>': where}}`. An app's computer-use level always asks.
 */
const AUTOMATIC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPERATION_NAME = /^[A-Z][A-Za-z0-9]{0,63}\.[a-z][A-Za-z0-9]{0,63}$/;
const NEVER_AUTOMATIC = new Set(['ExternalApp.setComputerUse']);
const AUTOMATIC_KEYS = new Set(['id', 'operation', 'why', 'perHour', 'where', 'args']);
export const AUTOMATIC_MAX = 32;
function checkWhere(where, at) {
  if (!isObj(where)) throw invalid(at, 'must be a where (an object)');
  try { validateWhere(where); } catch (e) { throw invalid(at, e?.message ?? String(e)); }
}
function checkAutomatic(list) {
  if (!Array.isArray(list)) throw invalid('automatic', 'must be an array');
  if (list.length > AUTOMATIC_MAX) throw invalid('automatic', `has at most ${AUTOMATIC_MAX} actions`);
  const seen = new Set();
  list.forEach((a, i) => {
    const at = `automatic[${i}]`;
    if (!isObj(a)) throw invalid(at, 'must be an object');
    const extra = Object.keys(a).find((k) => !AUTOMATIC_KEYS.has(k));
    if (extra) throw invalid(`${at}.${extra}`, 'is not a field of an automatic action');
    if (typeof a.id !== 'string' || !AUTOMATIC_ID.test(a.id)) throw invalid(`${at}.id`, 'must be 1-64 lowercase letters, digits and "-"');
    if (seen.has(a.id)) throw invalid(`${at}.id`, `duplicate action "${a.id}"`);
    seen.add(a.id);
    if (typeof a.operation !== 'string' || !OPERATION_NAME.test(a.operation)) throw invalid(`${at}.operation`, 'must name an operation as Type.operation ("Thread.send")');
    if (NEVER_AUTOMATIC.has(a.operation)) throw invalid(`${at}.operation`, `${a.operation} always asks the user`);
    if (typeof a.why !== 'string' || !a.why.trim() || a.why.length > 300) throw invalid(`${at}.why`, 'must say in at most 300 characters why the mod does it');
    if (!Number.isInteger(a.perHour) || a.perHour < 1 || a.perHour > 3600) throw invalid(`${at}.perHour`, 'must be an integer from 1 to 3600');
    if (a.where !== undefined) checkWhere(a.where, `${at}.where`);
    if (a.args !== undefined) {
      if (!isObj(a.args)) throw invalid(`${at}.args`, 'must map argument indexes ("0") to wheres');
      for (const [k, w] of Object.entries(a.args)) {
        if (!/^[0-9]$/.test(k)) throw invalid(`${at}.args`, `"${k}" is not an argument index`);
        checkWhere(w, `${at}.args.${k}`);
      }
    }
  });
}

/** A mod's media (docs/design/framework-ui.md F6): package images the framework's pages show, each and all bounded. */
export const MEDIA_MAX_BYTES = 1024 * 1024;
export const MEDIA_TOTAL_BYTES = 8 * 1024 * 1024;
const MEDIA_MAX = 12;
const MEDIA_ALL = 64;
export const MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });
export const mediaTypeOf = (src) => MEDIA_TYPES[String(src).split('.').pop().toLowerCase()] ?? null;

function checkMediaItem(x, at) {
  if (!isObj(x)) throw invalid(at, 'must be an object');
  if (Object.keys(x).some((k) => !['id', 'src', 'caption', 'aspect'].includes(k))) throw invalid(at, 'has only id, src, caption and aspect');
  if (typeof x.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x.id)) throw invalid(`${at}.id`, 'must be 1-64 letters, digits, ".", "_" or "-"');
  checkRelativePath(x.src, `${at}.src`);
  if (!mediaTypeOf(x.src)) throw invalid(`${at}.src`, `must be an image: ${Object.keys(MEDIA_TYPES).join(', ')}`);
  if (x.caption !== undefined && (typeof x.caption !== 'string' || !x.caption.trim() || x.caption.length > 200)) throw invalid(`${at}.caption`, 'must be a non-empty string of at most 200 characters');
  if (x.aspect !== undefined && !(typeof x.aspect === 'string' && /^\d+(\.\d+)? ?\/ ?\d+(\.\d+)?$/.test(x.aspect))) throw invalid(`${at}.aspect`, 'must be a ratio such as "16 / 9"');
}

/** Every image a manifest names: its own media, its settings groups' and its options'. */
export function mediaOf(manifest) {
  const out = Array.isArray(manifest?.media) ? [...manifest.media] : [];
  for (const x of Array.isArray(manifest?.settings) ? manifest.settings : []) {
    if (x?.media) out.push(x.media);
    for (const d of Array.isArray(x?.items) ? x.items : [x]) for (const o of Array.isArray(d?.options) ? d.options : []) if (o?.media) out.push(o.media);
  }
  return out;
}

/** What the pages read of a mod (F6): all optional. `author` is the mod's own claim; `glyph` is a name from the kit's set, and one it lacks draws the default. */
function checkPresentation(m) {
  const text = (v, at, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw invalid(at, `must be a non-empty string of at most ${max} characters`); };
  if (m.author !== undefined) text(m.author, 'author', 100);
  if (m.glyph !== undefined) text(m.glyph, 'glyph', 40);
  if (m.about !== undefined) {
    if (!Array.isArray(m.about) || m.about.length > 20) throw invalid('about', 'must be an array of at most 20 paragraphs');
    m.about.forEach((t, i) => text(t, `about[${i}]`, 2000));
  }
  if (m.testedWith !== undefined) {
    if (!Array.isArray(m.testedWith) || m.testedWith.length > 32) throw invalid('testedWith', 'must be an array of at most 32 exact Codex builds');
    m.testedWith.forEach((t, i) => text(t, `testedWith[${i}]`, 64));
  }
  if (m.media !== undefined) {
    if (!Array.isArray(m.media) || m.media.length > MEDIA_MAX) throw invalid('media', `must be an array of at most ${MEDIA_MAX} images`);
    m.media.forEach((x, i) => checkMediaItem(x, `media[${i}]`));
  }
}

/** The kinds of tool beyond its own storage, settings and actions a mod's model use may ask for (GOAL.md goal 16): each the user's to allow. */
export const INTELLIGENCE_TOOLS = Object.freeze(['web', 'network', 'files', 'toolServers', 'plugins', 'computerUse']);
/**
 * Model use (GOAL.md goal 16, reference-mods.md §2): why the mod wants models, in its words, and the other kinds of tool it would like its
 * model use to have. It grants nothing: model use is off until the user turns it on on the mod's page (the framework's internal mod keeps
 * that switch, the models and the allowance).
 */
function checkIntelligence(m) {
  if (m.intelligence === undefined) return;
  const x = m.intelligence;
  if (!isObj(x) || Object.keys(x).some((k) => k !== 'why' && k !== 'tools')) throw invalid('intelligence', 'must be {why, tools?}');
  if (typeof x.why !== 'string' || !x.why.trim() || x.why.length > 300) throw invalid('intelligence.why', 'must say in at most 300 characters what the mod uses models for');
  if (x.tools !== undefined && (!Array.isArray(x.tools) || x.tools.some((t) => !INTELLIGENCE_TOOLS.includes(t)) || new Set(x.tools).size !== x.tools.length)) {
    throw invalid('intelligence.tools', `must list some of ${INTELLIGENCE_TOOLS.join(', ')}, each once`);
  }
}

/**
 * The permissions a user decides (docs/design/framework-ui.md F8): each optional grant is known and covers nothing a required or another optional one does, so one resolver is
 * enough; `network` is never optional, since nothing enforces it; an optional `processes` has no process that starts with the mod, which could not wait for a decision.
 * `permissionNotes` say what a grant is for, in the mod's words; its risk is never the mod's to say.
 */
function checkOptionalPermissions(m) {
  const required = m.permissions ?? [];
  if (m.optionalPermissions !== undefined) {
    if (!Array.isArray(m.optionalPermissions)) throw invalid('optionalPermissions', 'must be an array');
    m.optionalPermissions.forEach((p, i) => {
      const at = `optionalPermissions[${i}]`;
      if (!isValidPermission(p)) throw invalid(at, `unknown permission ${JSON.stringify(p)}`);
      if (p === 'network') throw invalid(at, 'network is not enforced, so it cannot be optional: declare it in permissions');
      const r = required.find((x) => overlaps(x, p));
      if (r) throw invalid(at, `${p} covers some of what the required ${r} does`);
      const o = m.optionalPermissions.slice(0, i).find((x) => overlaps(x, p));
      if (o) throw invalid(at, `${p} covers some of what the optional ${o} does`);
      if (p === 'processes' && Object.values(m.processes ?? {}).some((x) => x?.start === 'with-mod')) throw invalid(at, 'a process that starts with the mod cannot wait for a decision: declare processes in permissions');
      if (p.startsWith('processes.exec:') && Object.values(m.processes ?? {}).some((x) => x?.start === 'with-mod' && p.slice('processes.exec:'.length).split(',').includes(x?.executable))) throw invalid(at, 'a process that starts with the mod cannot wait for a decision: declare the program it runs in permissions');
    });
  }
  if (m.permissionNotes !== undefined) {
    if (!isObj(m.permissionNotes)) throw invalid('permissionNotes', 'must be an object of notes by permission');
    const declared = new Set([...required, ...(m.optionalPermissions ?? [])]);
    for (const [g, n] of Object.entries(m.permissionNotes)) {
      const at = `permissionNotes.${g}`;
      if (!declared.has(g)) throw invalid(at, `${g} is not a permission this mod declares`);
      if (!isObj(n) || Object.keys(n).some((k) => k !== 'label' && k !== 'detail')) throw invalid(at, 'is {label?, detail}');
      if (typeof n.detail !== 'string' || !n.detail.trim() || n.detail.length > 300) throw invalid(`${at}.detail`, 'must be a non-empty string of at most 300 characters');
      if (n.label !== undefined && (typeof n.label !== 'string' || !n.label.trim() || n.label.length > 80)) throw invalid(`${at}.label`, 'must be a non-empty string of at most 80 characters');
    }
  }
}

/** Validates a parsed mod.json. Returns a deep copy. Throws CodexModsError('Invalid', '<path>: <problem>'). `internal`: one of the
 *  framework's internal mods, whose ids no package may take. */
export function validateManifest(manifest, { internal = false } = {}) {
  if (!isObj(manifest)) throw invalid('mod.json', 'must be a JSON object');
  const m = manifest;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    throw invalid('id', 'must be 3-128 characters of lowercase letters, digits, "." and "-", starting with a letter or digit');
  }
  // Reserved: the page's own presentation runtime speaks for itself under this id on the renderer channel (presentations.md V6).
  if (m.id === RESERVED_ID) throw invalid('id', `"${RESERVED_ID}" is reserved for the framework`);
  if (RESERVED_PROVIDER_IDS.includes(m.id)) throw invalid('id', `"${m.id}" is a provider id of the app's own instances`);
  if (INTERNAL_IDS.includes(m.id) !== internal) throw invalid('id', internal ? `"${m.id}" is not an internal mod's id` : `"${m.id}" is the framework's internal mod, shipped with it`);
  if (typeof m.version !== 'string' || !parseVersion(m.version)) throw invalid('version', 'must be a strict semver version (x.y.z with optional -prerelease and +build)');
  if (typeof m.name !== 'string' || !m.name.trim()) throw invalid('name', 'must be a non-empty string');
  if (m.description !== undefined && typeof m.description !== 'string') throw invalid('description', 'must be a string');
  if (m.publisher !== undefined) {
    const ok = typeof m.publisher === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(m.publisher) && Buffer.from(m.publisher, 'base64').length === 32;
    if (!ok) throw invalid('publisher', 'must be a base64 ed25519 public key (32 bytes)');
  }
  if (typeof m.framework !== 'string' || !parseRange(m.framework)) throw invalid('framework', 'must be a version range such as ">=1 <2" (operators >=, <, ^, ~ or exact)');

  if (!isObj(m.entry)) throw invalid('entry', 'must be an object with host and/or renderer');
  for (const k of ['host', 'renderer']) if (m.entry[k] !== undefined) checkRelativePath(m.entry[k], `entry.${k}`);
  if (m.entry.host === undefined && m.entry.renderer === undefined) throw invalid('entry', 'needs at least one of host or renderer');

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) throw invalid('permissions', 'must be an array');
    const seen = new Set();
    m.permissions.forEach((p, i) => {
      if (!isValidPermission(p)) throw invalid(`permissions[${i}]`, `unknown permission ${JSON.stringify(p)}`);
      if (seen.has(p)) throw invalid(`permissions[${i}]`, `duplicate permission "${p}"`);
      seen.add(p);
    });
  }
  checkOptionalPermissions(m);
  if (m.requires !== undefined) capabilityLists(m.requires, 'requires');
  if (m.optional !== undefined) capabilityLists(m.optional, 'optional');

  checkPresentation(m);
  checkIntelligence(m);

  if (m.settings !== undefined) checkDeclarations(m.settings, 'settings', { checkMedia: checkMediaItem, permissions: [...(m.permissions ?? []), ...(m.optionalPermissions ?? [])] });
  const media = mediaOf(m), ids = new Set();
  media.forEach((x) => { if (ids.has(x.id)) throw invalid('media', `the image id "${x.id}" is used twice`); ids.add(x.id); });
  if (media.length > MEDIA_ALL) throw invalid('media', `a mod has at most ${MEDIA_ALL} images`);
  if (m.data !== undefined) {
    if (!isObj(m.data)) throw invalid('data', 'must be an object');
    if (!Number.isInteger(m.data.schemaVersion) || m.data.schemaVersion < 0) throw invalid('data.schemaVersion', 'must be a non-negative integer');
    if (m.data.migrate !== undefined) checkRelativePath(m.data.migrate, 'data.migrate');
  }
  if (m.automatic !== undefined) checkAutomatic(m.automatic);
  if (m.processes !== undefined) {
    if (!isObj(m.processes)) throw invalid('processes', 'must be an object');
    const executables = executablesOf(m);
    for (const [name, p] of Object.entries(m.processes)) {
      const at = `processes.${name}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw invalid(at, 'process name must be letters, digits, ".", "_" or "-"');
      if (!isObj(p)) throw invalid(at, 'must be an object');
      // a worker answers the mod's calls (and stops when idle); a session is long-lived, fed through its input (graph-integrity G8.2)
      const kind = p.kind ?? 'worker';
      if (kind !== 'worker' && kind !== 'session') throw invalid(`${at}.kind`, 'must be "worker" or "session"');
      if ((p.command === undefined) === (p.executable === undefined)) throw invalid(at, 'names one of command (a file in the package) and executable (a program on the Mac, for a session)');
      if (p.command !== undefined) checkRelativePath(p.command, `${at}.command`);
      if (p.executable !== undefined) {
        if (kind !== 'session') throw invalid(`${at}.executable`, 'only a session process runs a program on the Mac');
        if (typeof p.executable !== 'string' || !EXECUTABLE_NAME.test(p.executable)) throw invalid(`${at}.executable`, 'must be a program\'s name (letters, digits, ".", "_", "+" or "-"), not a path');
        if (!executables.has(p.executable)) throw invalid(`${at}.executable`, `declare the program in permissions: "processes.exec:${p.executable}" (consent names each program a mod runs)`);
      }
      if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string'))) throw invalid(`${at}.args`, 'must be an array of strings');
      if (p.start !== 'on-demand' && p.start !== 'with-mod') throw invalid(`${at}.start`, 'must be "on-demand" or "with-mod"');
      if (p.idleStopMs !== undefined) {
        if (kind === 'session') throw invalid(`${at}.idleStopMs`, 'a session process is never stopped for being idle');
        if (!Number.isInteger(p.idleStopMs) || p.idleStopMs <= 0) throw invalid(`${at}.idleStopMs`, 'must be a positive integer');
      }
      if (p.restart !== undefined) {
        if (kind !== 'session') throw invalid(`${at}.restart`, 'only a session sets its restart (a worker that starts with the mod restarts after a failure)');
        if (p.restart !== 'never' && p.restart !== 'on-failure') throw invalid(`${at}.restart`, 'must be "never" or "on-failure"');
      }
      // a session that runs as several at once (one per chat of an agent's, say), each addressed as `name#key`
      if (p.instances !== undefined) {
        if (kind !== 'session') throw invalid(`${at}.instances`, 'only a session runs as several instances');
        if (!Number.isInteger(p.instances) || p.instances < 1 || p.instances > MAX_INSTANCES) throw invalid(`${at}.instances`, `must be an integer from 1 to ${MAX_INSTANCES}`);
        if (p.start === 'with-mod' && p.instances > 1) throw invalid(`${at}.instances`, 'a session that starts with the mod is one instance');
      }
    }
  }
  return structuredClone(m);
}

/** Paths a manifest references inside the package, as [manifestPath, packagePath]. */
export function referencedFiles(manifest) {
  const out = [];
  if (manifest.entry?.host) out.push(['entry.host', manifest.entry.host]);
  if (manifest.entry?.renderer) out.push(['entry.renderer', manifest.entry.renderer]);
  if (manifest.data?.migrate) out.push(['data.migrate', manifest.data.migrate]);
  for (const [name, p] of Object.entries(manifest.processes ?? {})) if (p.command !== undefined) out.push([`processes.${name}.command`, p.command]);
  mediaOf(manifest).forEach((x, i) => out.push([`media[${i}].src`, x.src]));
  return out;
}
