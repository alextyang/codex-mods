// The mods' settings as graph Settings, served by the framework's provider (docs/design/systems.md S13, S14, "E3 in detail"):
// - a SettingsSection per mod with settings (`mod:<id>`, its title the mod's name), child of the Mods section (`codexmods`), and one per
//   group (`mod:<id>:<group>`), with what the group says of itself;
// - a Setting per declaration at the app scope, and at a project's or a thread's where a value is stored there or where anyone reads
//   that project's or chat's `settings` (contributed, graph-integrity G3.4: `contributes` Setting through `thread` and `project`, put
//   when asked): its effective value there, whether it is overridden there, the scopes it may be set at, its choices (each `id` the value
//   as JSON), how it is drawn, `active` (whether what it requires holds at that scope), its `key`, and what defined it (`definedBy`: its
//   Mod). Its id is this provider's own: no one finds an instance by it (a chat's own is the one of its `settings` with that definer and key);
// - `set(value)` and `reset()` are one scoped patch through management, answered when its operation ends, and a section's `resetAll()` is
//   one patch of every value stored at the app scope in it, hidden rows included;
// - a mod's settings are read again (`mods.settings`) when management says so (`settings {modId}`); the threads and projects of the
//   scoped instances are followed, so a thread moved to another project shows that project's value, and a thread or project that goes
//   takes its instances with it (its stored values stay).
// Node built-ins only (none needed).
import { activeOf, effectiveOf, instanceId, parseInstanceId, parseScopeKey } from '../../../packages/settings.mjs';

const ref = (provider, type, id) => Object.freeze({ type, provider, id });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TERMINAL = new Set(['succeeded', 'failed', 'reverted', 'needs-attention']);
const OP_WAIT_MS = 30_000;
const TARGETS_MAX = 500;   // the chats and projects whose mods' settings are kept put after a read
/** An image as the graph has it: its package path stays in the Host. */
const mediaOf = (m) => ({ id: m.id, ...(m.caption ? { caption: m.caption } : {}), ...(m.aspect ? { aspect: m.aspect } : {}) });

/**
 * @param {{ graph: object, provider: string, put: (data: object) => unknown, remove: (ref: object) => void, emit: (ref: object, name: string) => void,
 *   call: (method: string, params: object) => Promise<any>, onOp: (fn: (op: object) => void) => { dispose(): void }, modRef: (id: string) => object,
 *   log?: object }} o
 */
export function createModSettings(o) {
  const log = o.log ?? { warn() {} };
  const P = o.provider;
  const refs = {
    root: () => ref(P, 'SettingsSection', 'codexmods'),
    section: (modId, group) => ref(P, 'SettingsSection', group ? `mod:${modId}:${group}` : `mod:${modId}`),
    setting: (modId, key, scopeKey) => ref(P, 'Setting', instanceId(modId, key, scopeKey)),
  };
  const known = new Map();      // mod id -> { name, settings (mods.settings' answer) }
  const put = new Map();        // setting id -> its last JSON
  const targets = new Set();    // the scope keys of the chats and projects whose settings were read (most recent last; bounded)
  const sections = new Map();   // section id -> its last JSON
  let rootPut = false;

  /** A project's or a thread's ref as the graph has it (its own type when resident), from a scope key. */
  function scopeRef(scopeKey) {
    const s = parseScopeKey(scopeKey);
    if (!s) return null;
    const concept = s.kind === 'project' ? 'Project' : 'Thread';
    const snap = o.graph.resolve(ref(s.provider, concept, s.id));
    return { kind: s.kind, ref: snap && !snap.gone ? snap.ref : ref(s.provider, concept, s.id), resident: !!snap && !snap.gone, snap };
  }
  const projectKeyOf = (snap) => {
    const p = snap?.links?.project;
    return p && typeof p.provider === 'string' ? `project:${encodeURIComponent(p.provider)}:${encodeURIComponent(p.id)}` : null;
  };

  function putSection(id, data) {
    const json = JSON.stringify(data);
    if (sections.get(id) === json) return;
    sections.set(id, json);
    o.put(data);
  }
  function settingData(modId, d, s, scopeKey) {
    const where = scopeKey ? scopeRef(scopeKey) : null;
    if (scopeKey && !where) return null;
    const at = {
      at: where?.kind ?? 'app',
      ...(where?.kind === 'thread' ? { threadKey: scopeKey, projectKey: projectKeyOf(where.snap) } : {}),
      ...(where?.kind === 'project' ? { projectKey: scopeKey } : {}),
    };
    const e = effectiveOf(d, s.app, s.scopes, at);
    return {
      ref: refs.setting(modId, d.key, scopeKey),
      state: {
        title: d.title, key: d.key, value: e.value, default: d.default, scope: where?.kind ?? 'app', kind: d.kind,
        ...(d.description ? { description: d.description } : {}),
        ...(d.choices ? { choices: d.choices.map((c) => ({ id: JSON.stringify(c.value), label: c.label, value: c.value, ...(c.description ? { description: c.description } : {}), ...(c.media ? { media: mediaOf(c.media) } : {}) })) } : {}),
        ...Object.fromEntries(['control', 'icon', 'min', 'max', 'step', 'unit', 'placeholder', 'group', 'requires', 'needs'].filter((k) => d[k] !== undefined).map((k) => [k, d[k]])),
        ...(d.kind === 'list' && d.schema && d.schema.type !== 'string' ? { structured: true } : {}),
        active: activeOf(d, s.declarations, s.app, s.scopes, at),
        overridden: e.overridden, scopes: [...d.scopes],
      },
      links: {
        section: refs.section(modId, d.group),
        definedBy: o.modRef(modId),
        ...(where?.kind === 'project' ? { project: where.ref } : {}),
        ...(where?.kind === 'thread' ? { thread: where.ref } : {}),
      },
    };
  }
  function putSetting(data) {
    const id = data.ref.id;
    const json = JSON.stringify(data);
    const before = put.get(id);
    if (before === json) return;
    put.set(id, json);
    try {
      o.put(data);
      if (before !== undefined && JSON.stringify(JSON.parse(before).state.value) !== JSON.stringify(data.state.value)) o.emit(data.ref, 'changed');
    } catch (e) { put.delete(id); log.warn('framework: a setting not put', { id, message: String(e?.message ?? e) }); }
  }
  function dropSetting(id) {
    if (!put.delete(id)) return;
    try { o.remove(ref(P, 'Setting', id)); } catch { /* gone */ }
  }

  /** Put every instance of a mod: its sections, its app-scope settings, its stored overrides and the observed refs. */
  function apply(modId) {
    const k = known.get(modId);
    const want = new Set();
    if (k && k.settings.declarations.length) {
      if (!rootPut) { rootPut = true; putSection('codexmods', { ref: refs.root(), state: { title: 'Mods' }, links: { parent: null } }); }
      putSection(`mod:${modId}`, { ref: refs.section(modId), state: { title: k.name }, links: { parent: refs.root() } });
      for (const g of k.settings.groups ?? []) {
        putSection(`mod:${modId}:${g.id}`, { ref: refs.section(modId, g.id), state: { title: g.title, ...(g.description ? { description: g.description } : {}), ...(g.icon ? { icon: g.icon } : {}), ...(g.media ? { media: mediaOf(g.media) } : {}) },
          links: { parent: refs.section(modId) } });
      }
      const s = k.settings;
      const scopeKeys = new Set(Object.keys(isObj(s.scopes) ? s.scopes : {}));
      for (const sk of targets) scopeKeys.add(sk);
      for (const d of s.declarations) {
        const data = settingData(modId, d, s, null);
        want.add(data.ref.id);
        putSetting(data);
        for (const sk of scopeKeys) {
          const kind = parseScopeKey(sk)?.kind;
          if (!kind || !d.scopes.includes(kind)) continue;
          const id = instanceId(modId, d.key, sk);
          if (!targets.has(sk) && !Object.hasOwn(s.scopes?.[sk] ?? {}, d.key)) continue;   // neither stored there nor read there
          const where = scopeRef(sk);
          if (!where?.resident) continue;   // its thread or project is not in the graph (now): no instance, the stored value stays
          const sd = settingData(modId, d, s, sk);
          if (!sd) continue;
          want.add(id);
          putSetting(sd);
        }
      }
    }
    for (const id of [...put.keys()]) if (parseInstanceId(id)?.modId === modId && !want.has(id)) dropSetting(id);
  }

  /** Read a mod's settings again (mods.settings) and put them; `name` from its Mod. */
  async function read(modId, name) {
    const before = known.get(modId)?.settings?.scopes;
    let settings;
    try { settings = await o.call('mods.settings', { modId }); } catch (e) {
      if (e?.code !== 'Unavailable') log.warn('framework: a mod\'s settings could not be read', { modId, message: String(e?.message ?? e) });
      known.delete(modId);
      apply(modId);
      declaredChanged(modId, before, undefined);
      return;
    }
    known.set(modId, { name: name ?? known.get(modId)?.name ?? modId, settings });
    apply(modId);
    declaredChanged(modId, before, settings.scopes);
  }
  function forget(modId) { const before = known.get(modId)?.settings?.scopes; known.delete(modId); apply(modId); declaredChanged(modId, before, undefined); }

  // ---------------------------------------------------------------- a mod's values on a chat or a project, as its attached data (G3.5)
  /** The scope key of a chat or a project (by its concept), or null for anything else. */
  const scopeKeyOfRef = (r) => {
    const concept = o.graph.type?.(r?.type)?.concept;
    const kind = concept === 'Thread' ? 'thread' : concept === 'Project' ? 'project' : null;
    return kind && typeof r.provider === 'string' && typeof r.id === 'string' ? { kind, sk: `${kind}:${encodeURIComponent(r.provider)}:${encodeURIComponent(r.id)}` } : null;
  };
  /** The mods' values set on this chat or project: `{[modId]: {[key]: value}}` of the settings it may be set at. */
  function valuesAt(r) {
    const at = scopeKeyOfRef(r);
    if (!at) return undefined;
    let out;
    for (const [modId, k] of known) {
      const stored = k.settings?.scopes?.[at.sk];
      if (!isObj(stored)) continue;
      for (const d of k.settings.declarations ?? []) {
        if (!Object.hasOwn(stored, d.key) || !d.scopes?.includes(at.kind)) continue;
        ((out ??= {})[modId] ??= {})[d.key] = stored[d.key];
      }
    }
    return out;
  }
  /** The keys a mod declares at a narrower scope than the app: its declared values' names. */
  const names = (modId) => new Set((known.get(modId)?.settings?.declarations ?? []).filter((d) => d.scopes?.some((x) => x !== 'app')).map((d) => d.key));
  o.graph.attachments?.declare?.({ valuesAt, names });
  /** What a read changed of a mod's stored values, each scope's chat or project told (its readers see its attached values change). */
  function declaredChanged(modId, before, after) {
    const a = isObj(before) ? before : {}, b = isObj(after) ? after : {};
    for (const sk of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[sk] ?? null) === JSON.stringify(b[sk] ?? null)) continue;
      const s = parseScopeKey(sk);
      if (s) o.graph.attachments?.declaredChanged?.(ref(s.provider, s.kind === 'thread' ? 'Thread' : 'Project', s.id), modId);
    }
  }

  // The threads and projects of the scoped instances: a change (a thread's project) or a removal is applied to their instances.
  const graphEvents = o.graph.onEvent?.((e) => {
    if (!e?.ref || e.ref.provider === P || (e.kind !== 'added' && e.kind !== 'changed' && e.kind !== 'removed')) return;
    const concept = o.graph.type(e.ref.type)?.concept;
    if (concept !== 'Thread' && concept !== 'Project') return;
    // only what decides these instances: one coming or going, and a chat's project (whose values it then has); a chat's turns change it often
    if (e.kind === 'changed' && !(concept === 'Thread' && e.fields?.includes('project'))) return;
    const sk = `${concept === 'Thread' ? 'thread' : 'project'}:${encodeURIComponent(e.ref.provider)}:${encodeURIComponent(e.ref.id)}`;
    const mods = new Set();
    for (const id of put.keys()) { const p = parseInstanceId(id); if (p?.scopeKey === sk || (concept === 'Project' && p?.scopeKey?.startsWith('thread:'))) mods.add(p.modId); }
    if (targets.has(sk)) for (const m of known.keys()) mods.add(m);
    if (e.kind === 'removed') targets.delete(sk);
    for (const m of mods) apply(m);
  });

  /** One scoped patch through management, answered when its operation ends. */
  async function patch(r, unset, value) {
    const p = parseInstanceId(r.id);
    if (!p) return { status: 'refused', reason: 'invalid', message: 'not a mod\'s setting' };
    const scope = p.scopeKey ?? 'app';
    return configure(p.modId, [unset ? { key: p.key, scope, unset: true } : { key: p.key, scope, value }]);
  }
  /** Every value stored at the app scope in a section (F7), hidden rows included; a project's and a chat's stay. */
  async function resetAll(r) {
    const m = /^mod:([^:]+)(?::(.+))?$/.exec(r.id);
    const k = m ? known.get(m[1]) : null;
    if (!k) return { status: 'refused', reason: 'invalid', message: 'not a mod\'s section' };
    const patches = k.settings.declarations.filter((d) => (d.group ?? null) === (m[2] ?? null) && isObj(k.settings.app) && Object.hasOwn(k.settings.app, d.key)).map((d) => ({ key: d.key, scope: 'app', unset: true }));
    return patches.length ? configure(m[1], patches) : { status: 'done', value: null };
  }
  async function configure(modId, patches) {
    const res = await o.call('mods.configure', { modId, patches });
    if (!res?.opId) return { status: 'done', value: null };
    const op = await new Promise((resolve) => {
      let sub = null;
      const timer = setTimeout(() => { sub?.dispose(); resolve(null); }, OP_WAIT_MS);
      timer.unref?.();
      sub = o.onOp((x) => { if (x?.id === res.opId && TERMINAL.has(x.outcome)) { clearTimeout(timer); sub.dispose(); resolve(x); } });
    });
    if (!op) return { status: 'uncertain', operation: 'Setting.set' };
    if (op.outcome === 'succeeded') { await read(modId); return { status: 'done', value: null }; }
    return { status: 'failed', error: { message: op.error?.message ?? op.note ?? `the setting was not changed (${op.outcome})`, ...(op.error?.code ? { code: op.error.code } : {}) } };
  }

  return {
    read, forget,
    /** The provider's types for these instances. */
    types: {
      Setting: { operations: {
        set: { effect: 'local', handler: ({ ref: r, args }) => patch(r, false, args[0]) },
        reset: { effect: 'local', handler: ({ ref: r }) => patch(r, true) },
      } },
      SettingsSection: { operations: { resetAll: { effect: 'local', handler: ({ ref: r }) => resetAll(r) } } },
    },
    /**
     * Someone reads a chat's or a project's `settings` (graph-integrity G3.4: `{target, relation}`): every mod's settings at that scope are
     * put for it, and kept up to date from then on (the most recent TARGETS_MAX of them; the others' instances go, their values stay).
     */
    contribute(query) {
      const r = query?.target;
      const kind = query?.relation === 'thread' ? 'thread' : query?.relation === 'project' ? 'project' : null;
      if (!kind || !r || typeof r.provider !== 'string' || typeof r.id !== 'string') return;
      if (o.graph.type(r.type)?.concept !== (kind === 'thread' ? 'Thread' : 'Project')) return;
      const sk = `${kind}:${encodeURIComponent(r.provider)}:${encodeURIComponent(r.id)}`;
      const had = targets.delete(sk);
      targets.add(sk);
      const dropped = targets.size > TARGETS_MAX ? targets.values().next().value : null;
      if (dropped) targets.delete(dropped);
      if (had && !dropped) return;
      for (const m of known.keys()) apply(m);
    },
    /** The provider's contributions: Settings of chats and of projects. */
    contributes: Object.freeze([{ type: 'Setting', via: 'thread' }, { type: 'Setting', via: 'project' }]),
    sectionOf: (modId) => refs.section(modId),
    refs,
    dispose() { graphEvents?.dispose?.(); o.graph.attachments?.declare?.(null); },
  };
}

