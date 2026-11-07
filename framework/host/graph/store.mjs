// The instance store of the graph runtime (docs/design/runtime-core.md R3–R5; integration.md §3.1 contract rules Identity, Completeness,
// Freshness). Each resident instance: its ref, its provider (the only writer), validated state, links (one and maybe relations as refs;
// many relations without an inverse as lists of refs), capabilities, liveness and a version. A relation declared as the inverse of a one
// relation is derived from an index, so a provider writes each link once: a many one lists every instance that links to it, a one or maybe
// one names the earliest (Thread.draft: the Draft whose thread it is), in the snapshot's links, and its change is a change of the instance. Every change is an event with the old and the new values,
// when the store observed it (`observedAt`), the source's own time when the provider gives one (`sourceAt`), and a global observation
// sequence, emitted after the change is committed. Node built-ins only.
import { CodexModsError } from '../../../sdk/errors.mjs';
import { compileWhere } from '../../shared/where.mjs';

const GONE_MAX = 10_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (m, details) => new CodexModsError('Invalid', m, details);

/** Identity: provider, root concept and id. Refining the subtype keeps it (R3). */
export function refKey(registry, ref) {
  const concept = registry.get(ref.type)?.concept ?? ref.type;
  return `${ref.provider}\u001f${concept}\u001f${ref.id}`;
}

/** Plain text of a content value, for summaries. */
export function contentText(c) {
  if (!isObject(c) || !Array.isArray(c.parts)) return '';
  return c.parts.map((p) => (typeof p.text === 'string' ? p.text : p.kind === 'mention' ? '@' : '')).join('').trim();
}

/**
 * `derivedFrom(target, referrer)` (records: {ref, provider, type}): may this referrer give the target a derived one relation? (The graph's:
 * its own provider, or a native one: H5x review 1, a mod's Draft linking another provider's chat is not that chat's draft.) All may without it.
 */
export function createStore({ registry, now = Date.now, derivedFrom }) {
  const instances = new Map();   // key -> record
  const gone = new Map();        // key -> {ref, at}: recently removed, so resolve() can say "gone" (bounded)
  const inverse = new Map();     // `${targetKey}\n${relation}` -> Set<source key>: who points at a target through a one/maybe relation
  const complete = new Map();    // `${provider}\n${concept}` -> boolean
  const providers = new Map();   // concept -> Set<provider id>
  const listeners = new Set();
  let seq = 0, births = 0;

  const key = (ref) => refKey(registry, ref);
  function typeOrThrow(id) { const t = registry.get(id); if (!t) throw invalid(`unknown type ${id}`); return t; }

  function emit(e) {
    const event = Object.freeze({ seq: ++seq, observedAt: now(), ...e });
    for (const fn of [...listeners]) { try { fn(event); } catch { /* a listener's fault is its own */ } }
    return event;
  }

  // ---------------------------------------------------------------- validation
  function checkState(t, state, { whole }) {
    const issues = [];
    for (const [name, value] of Object.entries(state)) {
      const m = t.members.state.get(name);
      if (!m) { issues.push({ path: name, message: `is not a state field of ${t.id}` }); continue; }
      if (value === undefined) { if (m.tier !== 'optional') issues.push({ path: name, message: 'is a core field and cannot be removed' }); continue; }
      registry.valueIssues(m.schema, value, name, issues);
    }
    if (whole) for (const [name, m] of t.members.state) if (m.tier !== 'optional' && state[name] === undefined) issues.push({ path: name, message: 'is a core field of ' + t.id + ' and is required' });
    if (issues.length) throw invalid(`invalid state for ${t.id}: ${issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues });
  }
  function checkLinks(t, links, { whole }) {
    const issues = [];
    for (const [name, v] of Object.entries(links)) {
      const m = t.members.relations.get(name);
      if (!m) { issues.push({ path: name, message: `is not a relation of ${t.id}` }); continue; }
      if (m.inverseOf) { issues.push({ path: name, message: `is derived from ${m.target}.${m.inverseOf} and is not written` }); continue; }
      const one = (x, p) => registry.valueIssues({ t: 'ref', to: m.target }, x, p, issues);
      if (m.cardinality === 'many') { if (!Array.isArray(v)) issues.push({ path: name, message: 'is a many relation: a list of refs' }); else v.forEach((x, i) => one(x, `${name}[${i}]`)); }
      else if (v === null || v === undefined) { if (m.cardinality === 'one' && m.tier !== 'optional') issues.push({ path: name, message: 'is a core one relation and is required' }); }
      else one(v, name);
    }
    if (whole) for (const [name, m] of t.members.relations) if (m.cardinality === 'one' && m.tier !== 'optional' && !m.inverseOf && !links[name]) issues.push({ path: name, message: `is a core relation of ${t.id} and is required` });
    if (issues.length) throw invalid(`invalid links for ${t.id}: ${issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues });
  }

  // ---------------------------------------------------------------- the inverse index
  function indexLinks(rec, add) {
    for (const [name, v] of Object.entries(rec.links)) {
      if (!v || Array.isArray(v)) continue;
      const k = `${key(v)}\n${name}`;
      let s = inverse.get(k);
      if (add) { if (!s) inverse.set(k, (s = new Set())); s.add(rec.key); }
      else if (s) { s.delete(rec.key); if (!s.size) inverse.delete(k); }
    }
  }

  // ---------------------------------------------------------------- snapshots
  function summaryOf(t, state) {
    const sm = t.summary;
    if (!sm) return { title: '' };
    const text = (f) => { const v = state[f]; return v === undefined ? undefined : isObject(v) ? contentText(v) : String(v); };
    const out = { title: text(sm.title) ?? '' };
    for (const f of ['subtitle', 'icon', 'status']) if (sm[f] && state[sm[f]] !== undefined) out[f] = text(sm[f]);
    if (sm.time && typeof state[sm.time] === 'number') out.time = state[sm.time];
    return out;
  }
  function snapshot(rec) {
    const t = registry.get(rec.type);
    const derived = derivedLinks(rec);
    return Object.freeze({
      ref: rec.ref, liveness: rec.liveness, version: rec.version, observedAt: rec.observedAt, ...(rec.sourceAt !== undefined ? { sourceAt: rec.sourceAt } : {}),
      state: rec.state, links: Object.keys(derived).length ? Object.freeze({ ...rec.links, ...derived }) : rec.links,
      caps: rec.caps ? [...rec.caps] : null, summary: Object.freeze(t ? summaryOf(t, rec.state) : { title: '' }),
    });
  }

  // ---------------------------------------------------------------- derived one relations
  /** A type's one and maybe relations derived from an inverse: [[name, relation]]. */
  function derivedOf(typeId) {
    const out = [];
    for (const [name, m] of registry.get(typeId)?.members.relations ?? []) if (m.cardinality !== 'many' && m.inverseOf) out.push([name, m]);
    return out;
  }
  /** The earliest put resident instance of its target type that links to it and may give it (`derivedFrom`), for each such relation that
   *  has one: {name: ref}. */
  function derivedLinks(rec) {
    const out = {};
    for (const [name, m] of derivedOf(rec.type)) {
      let first = null;
      for (const k of inverse.get(`${rec.key}\n${m.inverseOf}`) ?? []) {
        const r = instances.get(k);
        if (r && registry.isA(r.type, m.target) && (!first || r.born < first.born) && (!derivedFrom || derivedFrom(rec, r))) first = r;
      }
      if (first) out[name] = first.ref;
    }
    return out;
  }
  /** The instances these records' links point at whose derived one relations read those links, with those relations' values now. */
  function derivedTargets(recs) {
    const out = new Map();
    for (const r of recs) {
      for (const [name, v] of Object.entries(r?.links ?? {})) {
        if (!v || Array.isArray(v)) continue;
        const tk = key(v), t = instances.get(tk);
        if (!t || tk === r.key || out.has(tk) || !derivedOf(t.type).some(([, m]) => m.inverseOf === name)) continue;
        out.set(tk, derivedLinks(t));
      }
    }
    return out;
  }
  /** Each of those whose derived relations changed: a `changed` event of it, after the change that made them. */
  function touchDerived(before) {
    for (const [tk, was] of before) {
      const t = instances.get(tk);
      if (!t) continue;
      const now1 = derivedLinks(t);
      const fields = [...new Set([...Object.keys(was), ...Object.keys(now1)])].filter((f) => JSON.stringify(was[f] ?? null) !== JSON.stringify(now1[f] ?? null));
      if (!fields.length) continue;
      t.version++;
      emit({ kind: 'changed', ref: t.ref, observedAt: now(), fields, old: Object.fromEntries(fields.map((f) => [f, was[f] ?? null])),
        new: Object.fromEntries(fields.map((f) => [f, now1[f] ?? null])), instance: snapshot(t) });
    }
  }

  // ---------------------------------------------------------------- writes (the provider's handle calls these)
  function ownedOrNew(provider, ref) {
    if (!isObject(ref) || ref.provider !== provider) throw invalid(`a provider writes only its own instances (ref provider ${ref?.provider}, writer ${provider})`);
    const k = key(ref);
    const rec = instances.get(k);
    return { k, rec };
  }
  const diff = (oldObj, newObj) => {
    const fields = [], oldV = {}, newV = {};
    for (const f of new Set([...Object.keys(oldObj), ...Object.keys(newObj)])) {
      if (JSON.stringify(oldObj[f]) === JSON.stringify(newObj[f])) continue;
      fields.push(f); oldV[f] = oldObj[f]; newV[f] = newObj[f];
    }
    return { fields, oldV, newV };
  };

  /** Put a whole instance (first report, or a full re-read). */
  /**
   * `sourceAt`: the source's own time for what it reports (graph-integrity G1.3), kept beside the store's `observedAt` on the instance and
   * on the event the write makes.
   */
  function put(provider, ref, { state = {}, links = {}, caps = null, sourceAt } = {}) {
    const t = typeOrThrow(ref.type);
    const { k, rec: prev } = ownedOrNew(provider, ref);
    if (prev && !registry.isA(ref.type, registry.get(prev.type).concept)) throw invalid(`${ref.type} is not a ${prev.type}'s concept`);
    checkState(t, state, { whole: true });
    checkLinks(t, links, { whole: true });
    const rec = {
      key: k, ref: Object.freeze({ type: ref.type, provider, id: ref.id }), type: ref.type, provider,
      state: Object.freeze(stripUndefined(state)), links: Object.freeze(normalizeLinks(t, links)),
      caps: caps ? new Set(caps) : null, liveness: 'live', version: (prev?.version ?? 0) + 1, observedAt: now(), ...(Number.isFinite(sourceAt) ? { sourceAt } : {}),
      born: prev?.born ?? ++births,   // when it was first put: a derived one relation names the earliest
    };
    const before = derivedTargets([prev, rec]);
    if (prev) indexLinks(prev, false);
    instances.set(k, rec); gone.delete(k);
    indexLinks(rec, true);
    const e = putEvent(prev, rec);
    touchDerived(before);
    return e;
  }
  function putEvent(prev, rec) {
    const at = { observedAt: rec.observedAt, ...(rec.sourceAt !== undefined ? { sourceAt: rec.sourceAt } : {}) };
    if (!prev) return emit({ kind: 'added', ref: rec.ref, ...at, instance: snapshot(rec) });
    const s = diff(prev.state, rec.state), l = diff(prev.links, rec.links);
    const typeChanged = prev.type !== rec.type, liveChanged = prev.liveness !== 'live';
    if (!s.fields.length && !l.fields.length && !typeChanged && !liveChanged && sameCaps(prev.caps, rec.caps)) { rec.version = prev.version; return null; }
    return emit({
      kind: 'changed', ref: rec.ref, ...at, fields: [...s.fields, ...l.fields, ...(typeChanged ? ['type'] : []), ...(liveChanged ? ['liveness'] : [])],
      old: { ...s.oldV, ...l.oldV, ...(typeChanged ? { type: prev.type } : {}), ...(liveChanged ? { liveness: prev.liveness } : {}) },
      new: { ...s.newV, ...l.newV, ...(typeChanged ? { type: rec.type } : {}), ...(liveChanged ? { liveness: 'live' } : {}) },
      instance: snapshot(rec),
    });
  }

  /** Change some fields of an instance the provider already put. `undefined` removes an optional field. */
  function update(provider, ref, { state = {}, links = {}, caps, type, sourceAt } = {}) {
    const { rec: prev } = ownedOrNew(provider, ref);
    if (!prev) throw new CodexModsError('Unavailable', `no resident instance ${ref.type}:${ref.id} to update`);
    const newType = type ?? prev.type;
    const t = typeOrThrow(newType);
    if (newType !== prev.type && !registry.isA(newType, registry.get(prev.type).concept)) throw invalid(`${newType} is not of ${prev.type}'s concept`);
    checkState(t, state, { whole: false });
    checkLinks(t, links, { whole: false });
    const mergedState = stripUndefined({ ...prev.state, ...state });
    if (newType !== prev.type) checkState(t, mergedState, { whole: true });
    return put(provider, { ...prev.ref, type: newType }, {
      state: mergedState, links: { ...linksAsRefs(prev.links), ...links }, caps: caps === undefined ? prev.caps : caps, sourceAt,
    });
  }

  /** The instance no longer exists. */
  function remove(provider, ref, { sourceAt } = {}) {
    const { k, rec } = ownedOrNew(provider, ref);
    if (!rec) return null;
    const before = derivedTargets([rec]);
    indexLinks(rec, false);
    instances.delete(k);
    gone.set(k, { ref: rec.ref, at: now() });
    while (gone.size > GONE_MAX) gone.delete(gone.keys().next().value);
    const e = emit({ kind: 'removed', ref: rec.ref, observedAt: now(), ...(Number.isFinite(sourceAt) ? { sourceAt } : {}) });
    touchDerived(before);
    return e;
  }

  /**
   * A named event of one of the provider's instances (docs/graph/04 §3), resident or gone a moment ago (a deleted thread's `deleted`). The
   * name and payload are checked by the caller against the type (graph/index.mjs).
   */
  function event(provider, ref, name, payload, { sourceAt } = {}) {
    const k = key(ref);
    const rec = instances.get(k);
    const known = rec ? rec.ref : gone.get(k)?.ref;
    if (!known || known.provider !== provider || (rec && rec.provider !== provider)) throw invalid(`${provider} has no instance ${ref.type} ${ref.id} to emit ${name} for`);
    return emit({ kind: 'event', ref: known, name, payload: payload ?? null, observedAt: now(), ...(Number.isFinite(sourceAt) ? { sourceAt } : {}), ...(rec ? { instance: snapshot(rec) } : {}) });
  }

  /** Mark a provider's instances stale (its feed stopped) or live again. `match(record)` narrows it. */
  function setLiveness(provider, liveness, match = () => true) {
    const events = [];
    for (const rec of instances.values()) {
      if (rec.provider !== provider || rec.liveness === liveness || !match(snapshot(rec))) continue;
      const old = rec.liveness;
      rec.liveness = liveness; rec.version++;
      events.push(emit({ kind: 'changed', ref: rec.ref, observedAt: now(), fields: ['liveness'], old: { liveness: old }, new: { liveness }, instance: snapshot(rec) }));
    }
    return events;
  }

  function declareProvider(provider, concepts) {
    for (const c of concepts) { let s = providers.get(c); if (!s) providers.set(c, (s = new Set())); s.add(provider); }
  }
  function undeclareProvider(provider) {
    for (const s of providers.values()) s.delete(provider);
    for (const k of [...complete.keys()]) if (k.startsWith(`${provider}\n`)) complete.delete(k);
    for (const rec of [...instances.values()]) if (rec.provider === provider) remove(provider, rec.ref);
  }
  /** A provider keeps only some of its types (the others went with another owner): its instances of the others go, and it stays a
   *  provider of `concepts` only. */
  function narrowProvider(provider, concepts, keep) {
    for (const rec of [...instances.values()]) if (rec.provider === provider && !keep(rec.ref.type)) remove(provider, rec.ref);
    const want = new Set(concepts);
    for (const [c, s] of providers) if (!want.has(c) && s.delete(provider)) complete.delete(`${provider}\n${c}`);
  }
  /** A provider says whether its part of a concept's collection is complete (contract rule Completeness). */
  function setComplete(provider, concept, isComplete) {
    const was = isCompleteConcept(concept);
    complete.set(`${provider}\n${concept}`, !!isComplete);
    if (was !== isCompleteConcept(concept)) emit({ kind: 'completeness', concept, complete: isCompleteConcept(concept), observedAt: now() });
  }
  function isCompleteConcept(concept) {
    const ps = providers.get(concept);
    if (!ps || !ps.size) return false;
    for (const p of ps) if (complete.get(`${p}\n${concept}`) !== true) return false;
    return true;
  }

  // ---------------------------------------------------------------- reads
  const get = (ref) => { const rec = instances.get(key(ref)); return rec ? snapshot(rec) : null; };
  /** docs/graph/04 §1: the instance, or that it is gone, or null when it was never resident. */
  function resolve(ref) {
    const rec = instances.get(key(ref));
    if (rec) return snapshot(rec);
    const g = gone.get(key(ref));
    return g ? Object.freeze({ ref: g.ref, liveness: 'gone', gone: true }) : null;
  }
  /**
   * Resident instances of a type and its subtypes that a `where` keeps (docs/design/public-hooks.md §3.1). `attached(inst, modId)`
   * is the reader's view of attached data (none without it); `readable(snapshot)` says which relation targets the reader may read (a
   * path through one it may not is unknown, so a where never tells a reader about what it cannot read).
   */
  function list(typeId, where, attached, readable) {
    const w = compiled(where);
    const env = w ? whereEnv(attached, readable) : null;
    const out = [];
    for (const rec of instances.values()) {
      if (!registry.isA(rec.type, typeId)) continue;
      const snap = snapshot(rec);
      if (!w || w.test(snap, env)) out.push(snap);
    }
    return out;
  }
  /** A where, compiled (null for none); a malformed one is Invalid. */
  function compiled(where) {
    if (where === undefined || where === null) return null;
    try { return compileWhere(where); } catch (e) { throw invalid(`where: ${e?.message ?? e}`); }
  }
  /** What a where reads besides the instance: its relations (a target that is not resident is not known now) and attached data. */
  function whereEnv(attached, readable) {
    const may = (snap) => (typeof readable === 'function' ? readable(snap) : true);
    return {
      relation: (typeId, name) => !!(registry.get(typeId)?.members.relations.get(name)),
      related(inst, name) {
        const rec = instances.get(key(inst.ref));
        if (!rec) return undefined;
        const m = registry.get(rec.type)?.members.relations.get(name);
        if (!m) return undefined;
        if (m.cardinality !== 'many') { const v = m.inverseOf ? derivedLinks(rec)[name] : rec.links[name]; if (!v) return null; const got = get(v); return got && may(got) ? got : undefined; }
        const all = related(inst.ref, name) ?? [];
        return all.every(may) ? all : undefined;
      },
      attached: typeof attached === 'function' ? attached : undefined,
    };
  }
  /** A relation's value: a snapshot (one, maybe: stored, or derived from the inverse index) or a list (many: derived, or the stored list). */
  function related(ref, name) {
    const rec = instances.get(key(ref));
    if (!rec) return null;
    const m = registry.get(rec.type)?.members.relations.get(name) ?? registry.generic(name);
    if (!m) throw invalid(`${rec.type} has no relation ${name}`);
    if (m.cardinality !== 'many') { const v = m.inverseOf ? derivedLinks(rec)[name] : rec.links[name]; return v ? get(v) : null; }
    if (m.inverseOf) {
      const keys = inverse.get(`${rec.key}\n${m.inverseOf}`) ?? new Set();
      return [...keys].map((k) => instances.get(k)).filter((r) => r && registry.isA(r.type, m.target)).map(snapshot);
    }
    return (rec.links[name] ?? []).map((r) => get(r)).filter(Boolean);
  }

  /**
   * A mod's attached value on an instance changed (attachments.mjs): its views see a `changed` event on `attached`, with who changed
   * it and whether it is (or was) shared, so each reader's layer can tell whether the change is one it may see. Nothing for an instance
   * that is not resident.
   */
  function attachedChanged(ref, change) {
    const rec = instances.get(key(ref));
    if (!rec) return null;
    return emit({ kind: 'changed', ref: rec.ref, observedAt: now(), fields: ['attached'], old: {}, new: {}, instance: snapshot(rec), attached: Object.freeze({ ...change }) });
  }

  /** Every resident instance that links to `ref` through its one/maybe relation `relation` (for example every Message and Step whose
   *  `turn` is a turn), from the inverse index. */
  function referrers(ref, relation) {
    const keys = inverse.get(`${key(ref)}\n${relation}`);
    return keys ? [...keys].map((k) => instances.get(k)).filter(Boolean).map(snapshot) : [];
  }

  return {
    put, update, remove, event, setLiveness, declareProvider, undeclareProvider, narrowProvider, setComplete, referrers, attachedChanged,
    isComplete: (typeId) => isCompleteConcept(registry.get(typeId)?.concept ?? typeId),
    get, resolve, list, related, key, compiled, whereEnv, snapshotByKey: (k) => { const r = instances.get(k); return r ? snapshot(r) : null; },
    onEvent(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    get seq() { return seq; },
    get size() { return instances.size; },
  };

  function normalizeLinks(t, links) {
    const out = {};
    for (const [name, v] of Object.entries(links)) {
      const m = t.members.relations.get(name);
      if (m.cardinality === 'many') out[name] = Object.freeze(v.map((r) => Object.freeze({ type: r.type, provider: r.provider, id: r.id })));
      else out[name] = v ? Object.freeze({ type: v.type, provider: v.provider, id: v.id }) : null;
    }
    return out;
  }
}

const linksAsRefs = (links) => ({ ...links });
const sameCaps = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.size === b.size && [...a].every((x) => b.has(x)));
function stripUndefined(o) { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v; return out; }
