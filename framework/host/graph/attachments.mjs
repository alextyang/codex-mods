// Attached data (docs/graph/04 §7, docs/design/public-hooks.md §3.3; graph-integrity G3.5): a mod's own named values on anyone's instance,
// kept by the framework.
// - A mod keeps values by name on an instance (`set(modId, ref, name, value, {shared})`), each private unless `shared`: a private one is read
//   by its mod only, a shared one by every reader of the instance. Readers get `{[modId]: {[name]: value}}`, their own and the shared ones;
//   the framework gets every value and which are private (`<modId>/<name>`).
// - A mod's declared values (`declare(source)`, the framework's settings): its settings of project or thread scope. The value set on a chat
//   or a project is the mod's shared value of that key there, with the schema the mod declares. They are set through the setting (its
//   journal, rollback and migrations keep their storage), never here: a mod's own value of a declared name is refused.
// - Kept apart from the instances, keyed by the ref (provider, id and type), so a provider going away, an instance going stale or a
//   restart keeps it; `deleted(ref)` drops it when the instance is deleted, `set(..., null)` when its mod detaches it.
// - Each mod's values live in its data directory (`graph-attached.json`), loaded when the mod starts and written when it changes (soon
//   after, in one write) and when it stops, so a removal that keeps or deletes the mod's data (04 §9) does the same to them.
// - Bounds: a value's JSON at most 4 KB, at most 50,000 values per mod.
// Node built-ins only.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';

export const ATTACHED_FILE = 'graph-attached.json';
export const LIMITS = Object.freeze({ valueBytes: 4096, perMod: 50_000 });
const SAVE_DELAY_MS = 250;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (r) => isObject(r) && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string' && r.type && r.provider && r.id;
const idKey = (ref) => `${ref.provider}\u001f${ref.id}`;
/** A value's name: what a where reads as `@<modId>/<name>` (so no `.`, which goes to its fields). */
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * @param {{ sameConcept?: (a: string, b: string) => boolean, onChange?: (ref: object, change: {by: string, shared: boolean, wasShared: boolean}) => void,
 *   log?: object, limits?: {valueBytes: number, perMod: number}, delayMs?: number }} [o]
 *   `sameConcept(typeA, typeB)`: do two type ids name the same concept (the registry's); without it, the same id.
 */
export function createAttachments(o = {}) {
  const sameConcept = o.sameConcept ?? ((a, b) => a === b);
  const limits = o.limits ?? LIMITS;
  const log = o.log ?? { warn() {} };
  const mods = new Map();   // modId -> { file, byId: Map<idKey, Array<{ref, name, value, shared}>>, count, timer }
  let declared = null;      // {valuesAt(ref) -> {[modId]: {[name]: value}} | undefined, names(modId) -> Set<name>}

  const find = (m, ref, name) => (m.byId.get(idKey(ref)) ?? []).find((e) => e.name === name && sameConcept(e.ref.type, ref.type)) ?? null;
  const onInstance = (m, ref) => (m.byId.get(idKey(ref)) ?? []).filter((e) => sameConcept(e.ref.type, ref.type));
  const drop = (m, e) => {
    const list = m.byId.get(idKey(e.ref)).filter((x) => x !== e);
    if (list.length) m.byId.set(idKey(e.ref), list); else m.byId.delete(idKey(e.ref));
    m.count--;
  };

  function save(modId) {
    const m = mods.get(modId);
    if (!m) return;
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    if (!m.dirty) return;
    const entries = [];
    for (const list of m.byId.values()) for (const e of list) entries.push({ ref: e.ref, name: e.name, value: e.value, ...(e.shared ? { shared: true } : {}) });
    try {
      mkdirSync(dirname(m.file), { recursive: true, mode: 0o700 });
      const tmp = `${m.file}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 2, entries }) + '\n', { mode: 0o600 });
      renameSync(tmp, m.file);
      m.dirty = false;
    } catch (e) { log.warn('attached data could not be saved', { mod: modId, message: String(e?.message ?? e) }); }
  }
  const later = (modId) => {
    const m = mods.get(modId);
    m.dirty = true;
    if (!m.timer) { m.timer = setTimeout(() => save(modId), o.delayMs ?? SAVE_DELAY_MS); m.timer.unref?.(); }
  };

  return {
    /** A mod started: its values come back from its data directory (a file that cannot be read is left as it is and logged). */
    load(modId, dataDir) {
      if (mods.has(modId)) return;
      const m = { file: join(dataDir, ATTACHED_FILE), byId: new Map(), count: 0, timer: null, dirty: false };
      mods.set(modId, m);
      let raw = null;
      try { raw = JSON.parse(readFileSync(m.file, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') log.warn('attached data could not be read', { mod: modId, message: String(e?.message ?? e) }); }
      for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
        if (!isRef(e?.ref) || typeof e.name !== 'string' || !NAME.test(e.name) || m.count >= limits.perMod) continue;
        const text = JSON.stringify(e.value ?? null);
        if (e.value === null || e.value === undefined || text.length > limits.valueBytes) continue;
        const ref = { type: e.ref.type, provider: e.ref.provider, id: e.ref.id };
        if (find(m, ref, e.name)) continue;
        const list = m.byId.get(idKey(ref)) ?? [];
        list.push({ ref, name: e.name, value: JSON.parse(text), shared: e.shared === true });
        m.byId.set(idKey(ref), list);
        m.count++;
      }
    },
    /** A mod stopped: its values are written and leave memory (they stay in its data directory). */
    unload(modId) { save(modId); const m = mods.get(modId); if (m?.timer) clearTimeout(m.timer); mods.delete(modId); },
    loaded: (modId) => mods.has(modId),
    /**
     * Set this mod's value of a name on an instance (null removes it). Refused Invalid beyond the bounds, for a malformed ref or name, and
     * for a name the mod declares as a setting (set through the setting).
     */
    set(modId, ref, name, value, { shared = false } = {}) {
      const m = mods.get(modId);
      if (!m) throw new CodexModsError('Unavailable', `${modId} is not running`);
      if (!isRef(ref)) throw new CodexModsError('Invalid', 'attach needs a ref {type, provider, id}');
      if (typeof name !== 'string' || !NAME.test(name)) throw new CodexModsError('Invalid', 'an attached value\'s name is 1-64 letters, digits, _ or -, starting with a letter');
      if (declared?.names(modId)?.has(name)) throw new CodexModsError('Invalid', `${name} is a setting of this mod: it is set as a setting (ctx.settings.set), not attached`);
      const at = find(m, ref, name);
      const wasShared = at?.shared === true;
      if (value === null || value === undefined) {
        if (!at) return { changed: false };
        drop(m, at);
        later(modId);
        o.onChange?.(at.ref, { by: modId, name, shared: false, wasShared });
        return { changed: true };
      }
      let text;
      try { text = JSON.stringify(value); } catch { text = undefined; }
      if (typeof text !== 'string') throw new CodexModsError('Invalid', 'an attached value is JSON');
      if (text.length > limits.valueBytes) throw new CodexModsError('Invalid', `an attached value is at most ${limits.valueBytes} bytes of JSON (this one is ${text.length})`);
      const clean = JSON.parse(text);
      if (at) { at.value = clean; at.shared = shared === true; }
      else {
        if (m.count >= limits.perMod) throw new CodexModsError('Invalid', `a mod attaches at most ${limits.perMod} values`);
        const entry = { ref: { type: ref.type, provider: ref.provider, id: ref.id }, name, value: clean, shared: shared === true };
        const list = m.byId.get(idKey(ref)) ?? [];
        list.push(entry);
        m.byId.set(idKey(ref), list);
        m.count++;
      }
      later(modId);
      o.onChange?.(ref, { by: modId, name, shared: shared === true, wasShared });
      return { changed: true };
    },
    /** The mods' declared values (the framework's settings of project and thread scope): `{valuesAt(ref), names(modId)}`. */
    declare(source) { declared = source && typeof source.valuesAt === 'function' && typeof source.names === 'function' ? source : null; },
    /** A mod's declared values on an instance changed (a setting set or reset there): readers see a change of its shared values. */
    declaredChanged(ref, modId) { if (isRef(ref)) o.onChange?.(ref, { by: modId, shared: true, wasShared: true }); },
    /**
     * What `reader` sees on an instance: `{[modId]: {[name]: value}}`, its own and the shared ones (a mod's declared values are shared),
     * or undefined when there is none. The framework (reader null) sees every value, and `private` lists those that are (`<modId>/<name>`).
     */
    viewFor(reader, ref) {
      if (!isRef(ref)) return undefined;
      let out, priv;
      const put = (modId, name, value) => { ((out ??= {})[modId] ??= {})[name] = value; };
      for (const [modId, m] of mods) {
        for (const e of onInstance(m, ref)) {
          if (reader !== null && modId !== reader && !e.shared) continue;
          put(modId, e.name, e.value);
          if (reader === null && !e.shared) (priv ??= []).push(`${modId}/${e.name}`);
        }
      }
      let values;
      try { values = declared?.valuesAt(ref); } catch (e) { log.warn('declared values could not be read', { message: String(e?.message ?? e) }); }
      for (const [modId, vals] of Object.entries(isObject(values) ? values : {})) for (const [name, value] of Object.entries(isObject(vals) ? vals : {})) put(modId, name, value);
      if (!out) return undefined;
      return reader === null ? { attached: out, private: priv ?? [] } : out;
    },
    /** The instance was deleted: every mod's value on it goes. */
    deleted(ref) {
      if (!isRef(ref)) return;
      for (const [modId, m] of mods) {
        for (const e of onInstance(m, ref)) {
          drop(m, e);
          later(modId);
          o.onChange?.(e.ref, { by: modId, name: e.name, shared: false, wasShared: e.shared === true });
        }
      }
    },
    /** Write everything now (the Host is closing). */
    flush() { for (const id of mods.keys()) save(id); },
  };
}
