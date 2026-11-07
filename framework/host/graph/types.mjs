// The type registry of the graph runtime (docs/design/runtime-core.md R2; docs/graph/04 §2 reflection, §7 extension). It loads the SDK's
// descriptors (sdk/graph/define.mjs toDescriptor) for the native library and each mod's types, without running mod code, and answers:
// a type's chain and concept, its members merged along the chain, its subtypes, reflection, and whether a value fits a schema.
// Rules it enforces: ids are unique; a subtype's parent is registered first; a subtype only adds (no member name of an ancestor again);
// relation targets may be types not registered yet (they are reported as unresolved), or any type (`ANY_TYPE`). Node built-ins only.

import { CodexModsError } from '../../../sdk/errors.mjs';
import { ANY_TYPE } from '../../../sdk/graph/define.mjs';

const SECTIONS = ['state', 'relations', 'operations', 'events'];
const MEMBER_OF = { state: 'state', relations: 'relation', operations: 'operation', events: 'event' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (m) => { throw new CodexModsError('Invalid', m); };
const PRESENTATIONS = Object.freeze({ target: 'Presentation', cardinality: 'many', tier: 'core', owned: false, inverseOf: 'subject' });

/**
 * @typedef {{ id: string, kind: 'concept' | 'subtype', parent: string | null, spec: object }} Descriptor
 * @typedef {{ id: string, owner: string, descriptor: Descriptor, chain: string[], concept: string,
 *   members: { state: Map<string, object>, relations: Map<string, object>, operations: Map<string, object>, events: Map<string, object> },
 *   declaredIn: Map<string, string>, summary: object | null, searchable: boolean, mentionable: boolean }} TypeInfo
 */

export function createTypeRegistry() {
  /** @type {Map<string, TypeInfo>} */ const types = new Map();
  const children = new Map();   // id -> Set<child id>

  function checkDescriptor(d) {
    if (!isObject(d) || typeof d.id !== 'string' || !d.id) fail('a type descriptor needs an id');
    if (d.id === ANY_TYPE) fail(`${ANY_TYPE} names any type: it is not a type id`);
    if (d.kind !== 'concept' && d.kind !== 'subtype') fail(`${d.id}: kind must be concept or subtype`);
    if (d.kind === 'concept' && d.parent !== null) fail(`${d.id}: a concept has no parent`);
    if (d.kind === 'subtype' && (typeof d.parent !== 'string' || !d.parent)) fail(`${d.id}: a subtype names its parent`);
    if (!isObject(d.spec)) fail(`${d.id}: spec must be an object`);
    for (const s of SECTIONS) {
      const sec = d.spec[s];
      if (sec === undefined) continue;
      if (!isObject(sec)) fail(`${d.id}.${s} must be an object`);
      for (const [name, m] of Object.entries(sec)) {
        if (!isObject(m) || m.member !== MEMBER_OF[s]) fail(`${d.id}.${s}.${name} is not a ${MEMBER_OF[s]} member`);
        if (s === 'relations' && Array.isArray(m.target) && m.inverseOf) fail(`${d.id}.${name}: an inverse relation names the one type that links here`);
        if (s !== 'events' && name === 'presentations') fail(`${d.id}.${name}: every instance has its presentations (docs/graph/04 §8); the name is reserved`);
      }
    }
  }

  /**
   * Register descriptors (in order: a parent before its subtypes) for an owner ('native' or a mod id). All or nothing.
   * @param {Descriptor[]} descriptors
   * @param {string} owner
   */
  function register(descriptors, owner) {
    if (typeof owner !== 'string' || !owner) fail('register needs an owner');
    const added = [];
    try {
      for (const d of descriptors) {
        checkDescriptor(d);
        if (types.has(d.id)) fail(`type ${d.id} is already registered (by ${types.get(d.id).owner})`);
        const parent = d.parent === null ? null : types.get(d.parent);
        if (d.parent !== null && !parent) fail(`${d.id}: parent ${d.parent} is not registered`);
        const members = parent
          ? Object.fromEntries(SECTIONS.map((s) => [s, new Map(parent.members[s])]))
          : Object.fromEntries(SECTIONS.map((s) => [s, new Map()]));
        // State, relations and operations share one namespace (they are an instance's properties); events have their own (`on(name)`).
        const declaredIn = parent ? new Map(parent.declaredIn) : new Map();
        for (const s of SECTIONS) {
          for (const [name, m] of Object.entries(d.spec[s] ?? {})) {
            const slot = s === 'events' ? `event:${name}` : name;
            if (declaredIn.has(slot)) fail(`${d.id}.${name}: ${declaredIn.get(slot)} already has ${s === 'events' ? 'an event' : 'a member'} of this name (a subtype only adds)`);
            members[s].set(name, m);
            declaredIn.set(slot, d.id);
          }
        }
        const info = Object.freeze({
          id: d.id, owner, descriptor: d, chain: parent ? [...parent.chain, d.id] : [d.id], concept: parent ? parent.concept : d.id,
          members, declaredIn, summary: d.spec.summary ?? parent?.summary ?? null,
          searchable: d.spec.searchable ?? parent?.searchable ?? false, mentionable: d.spec.mentionable ?? parent?.mentionable ?? false,
        });
        types.set(d.id, info); added.push(d.id);
        if (parent) { let s = children.get(parent.id); if (!s) children.set(parent.id, (s = new Set())); s.add(d.id); }
      }
    } catch (e) {
      for (const id of added.reverse()) drop(id);
      throw e;
    }
    return added;
  }

  function drop(id) {
    const t = types.get(id);
    if (!t) return;
    types.delete(id);
    const p = t.descriptor.parent;
    if (p) children.get(p)?.delete(id);
    children.delete(id);
  }

  /** The ids unregisterOwner(owner) would remove: the owner's types and every type below them, whoever registered those. */
  function ownedSubtrees(owner) {
    const out = new Set();
    for (const t of types.values()) if (t.owner === owner) for (const id of subtreeOf(t.id)) out.add(id);
    return [...out];
  }
  /** Remove an owner's types and every type below them (lifecycle: what a mod registers goes with it). Returns the removed ids. */
  function unregisterOwner(owner) {
    const removed = [];
    const visit = (id) => { for (const c of [...(children.get(id) ?? [])]) visit(c); removed.push(id); drop(id); };
    for (const t of [...types.values()]) if (t.owner === owner && types.has(t.id)) visit(t.id);
    return removed;
  }

  const get = (id) => types.get(id);
  /** Is `id` the type `ancestor` or one of its subtypes? `ancestor` may be a list (a relation to any of several concepts, G3.3): any of them. */
  const isA = (id, ancestor) => (Array.isArray(ancestor) ? ancestor.some((a) => isA(id, a)) : types.get(id)?.chain.includes(ancestor) === true);
  /** A relation's target is registered: one type, or each type of a list (any type is always). */
  const resolvedTarget = (to) => to === ANY_TYPE || (Array.isArray(to) ? to.every((x) => types.has(x)) : types.has(to));
  /** May a ref of this type be a value of a relation to `to`? Any type; else (one of) its targets, or one not registered yet (any ref). */
  const refersTo = (to, type) => to === ANY_TYPE || (Array.isArray(to) ? to : [to]).some((x) => !types.has(x) || isA(type, x));
  /** The type and all its subtypes, the type first. */
  function subtreeOf(id) {
    const out = [];
    const visit = (x) => { if (!types.has(x)) return; out.push(x); for (const c of children.get(x) ?? []) visit(c); };
    visit(id);
    return out;
  }

  /** docs/graph/04 §2 reflection: every type with its kind, concept, parent, subtypes and members (with tier and the declaring type). */
  function reflect() {
    return [...types.values()].map((t) => ({
      id: t.id, kind: t.descriptor.kind, concept: t.concept, parent: t.descriptor.parent, owner: t.owner,
      subtypes: [...(children.get(t.id) ?? [])],
      members: Object.fromEntries(SECTIONS.map((s) => [s, Object.fromEntries([...t.members[s]].map(([name, m]) => [name, {
        tier: m.tier ?? 'core', declaredIn: t.declaredIn.get(s === 'events' ? `event:${name}` : name),
        // a `_` member is the mechanism layer's (docs/design/graph-layers.md §1): there, not promised
        ...(name.startsWith('_') ? { mechanism: true } : {}),
        ...(s === 'relations' ? { target: m.target, cardinality: m.cardinality, owned: !!m.owned, ...(m.inverseOf ? { inverseOf: m.inverseOf } : {}), resolved: resolvedTarget(m.target) } : {}),
        ...(s === 'state' ? { schema: m.schema } : {}),
        ...(s === 'operations' ? { args: m.args, minArgs: m.minArgs ?? m.args?.length ?? 0, returns: m.returns, ...(m.content === true ? { content: true } : {}) } : {}),
      }]))])),
      summary: t.summary, searchable: t.searchable, mentionable: t.mentionable,
    }));
  }

  /**
   * Every way `value` breaks `schema`: [{path, message}]. Refs must name a registered type that is (a subtype of) the target when the
   * target is registered; a target not registered yet accepts any ref.
   */
  function valueIssues(schema, value, path = '$', out = []) {
    const t = schema?.t;
    const bad = (m) => out.push({ path, message: m });
    switch (t) {
      case 'string': case 'url': if (typeof value !== 'string') bad(`is ${typeName(value)}, not a string`); break;
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) bad(`is ${typeName(value)}, not a number`); break;
      case 'time': if (typeof value !== 'number' || !Number.isFinite(value)) bad(`is ${typeName(value)}, not a time (ms since the epoch)`); break;
      case 'boolean': if (typeof value !== 'boolean') bad(`is ${typeName(value)}, not a boolean`); break;
      case 'json': if (!isJson(value)) bad('is not JSON-serializable'); break;
      case 'enum': if (!schema.values.includes(value)) bad(`is not one of ${schema.values.join(', ')}`); break;
      case 'content':
        if (!isObject(value) || !Array.isArray(value.parts)) bad('is not content ({parts: [...]})');
        else value.parts.forEach((p, i) => { if (!isObject(p) || typeof p.kind !== 'string') out.push({ path: `${path}.parts[${i}]`, message: 'is not a content part' }); });
        break;
      case 'list':
        if (!Array.isArray(value)) bad(`is ${typeName(value)}, not a list`);
        else value.forEach((v, i) => valueIssues(schema.of, v, `${path}[${i}]`, out));
        break;
      case 'record':
        if (!isObject(value)) bad(`is ${typeName(value)}, not a record (an object of keys to values)`);
        else for (const [k, v] of Object.entries(value)) valueIssues(schema.of, v, `${path}[${JSON.stringify(k)}]`, out);
        break;
      case 'object':
        if (!isObject(value)) { bad(`is ${typeName(value)}, not an object`); break; }
        for (const [k, f] of Object.entries(schema.fields)) {
          if (value[k] === undefined) { if (!f.optional) out.push({ path: `${path}.${k}`, message: 'is required' }); }
          else valueIssues(f.schema, value[k], `${path}.${k}`, out);
        }
        for (const k of Object.keys(value)) if (!(k in schema.fields)) out.push({ path: `${path}.${k}`, message: 'is not a field of this object' });
        break;
      case 'ref':
        if (!isRef(value)) bad('is not a ref ({type, provider, id})');
        else if (!refersTo(schema.to, value.type)) bad(`refers to a ${value.type}, not a ${Array.isArray(schema.to) ? schema.to.join(' or ') : schema.to}`);
        break;
      default: bad(`has an unknown schema kind ${t}`);
    }
    return out;
  }

  /**
   * A relation every instance has, whatever its type (docs/graph/04 §8): `presentations`, its live presentations in every window (the
   * inverse of Presentation.subject), once the Presentation concept is registered. Null for any other name.
   */
  function generic(name) {
    if (name !== 'presentations' || !types.has('Presentation')) return null;
    return PRESENTATIONS;
  }

  return { register, unregisterOwner, ownedSubtrees, get, has: (id) => types.has(id), isA, subtreeOf, reflect, valueIssues, generic, ids: () => [...types.keys()] };
}

export const isRef = (v) => isObject(v) && typeof v.type === 'string' && typeof v.provider === 'string' && typeof v.id === 'string' && !!v.id;
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v);
function isJson(v, depth = 0) {
  if (depth > 64) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isObject(v)) return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}
