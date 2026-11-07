// SDK v2 definition builders (docs/design/sdk-typescript.md T1-T5, docs/design/runtime-core.md R2).
// A runtime port of the accepted prototype, docs/design/sdk-typescript/sdk/core.ts; the types are in ./index.d.ts.
//
// A definition is plain data: `s.*` builds value schemas and state fields, `r.*` relations, `op` operations, `ev` events, and
// `defineConcept`, `defineSubtype` and `defineAttachment` assemble them. The native types and a mod's types are defined with these
// same functions (README rule 3). The builders return frozen objects whose `optional()`, `parts()` and `inverse()` return changed
// copies. `toDescriptor` strips the methods, leaving the JSON the runtime loads and sends to other realms.
//
// Node built-ins only (sdk/ ships inside the copy): this file imports nothing.

/** @typedef {import('./index.d.ts').Schema} Schema */
/** @typedef {import('./index.d.ts').Tier} Tier */
/** @typedef {import('./index.d.ts').Cardinality} Cardinality */

const freeze = Object.freeze;

/** What every instance already has (docs/graph/04 §1, §3, §4): a type cannot use these names for members of its own. */
const RESERVED_NAMES = freeze(['ref', 'liveness', 'summary', 'is', 'can', 'attached', 'watch', 'on', 'presentations']);
const SPEC_KEYS = freeze(['state', 'relations', 'operations', 'events', 'summary', 'searchable', 'mentionable']);
const SUMMARY_KEYS = freeze(['title', 'subtitle', 'icon', 'status', 'time']);   // docs/graph/04 §8 (badges come from decorations)
/** Spec section name -> the `member` kind its entries must have. */
const SECTIONS = freeze({ state: 'state', relations: 'relation', operations: 'operation', events: 'event' });
const MEMBER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const fail = (message) => { throw new TypeError(message); };
const isObject = (value) => typeof value === 'object' && value !== null;
const nonEmptyString = (value, what) => { if (typeof value !== 'string' || value.length === 0) fail(`${what} must be a non-empty string`); return value; };

/* ================================================================== value schemas and state fields */

/**
 * A state field: a value schema plus its tier. `optional()` returns a copy marked as a standard optional member
 * (docs/graph/README.md, rule 2).
 * @param {Schema} schema
 * @param {Tier} [tier]
 */
function field(schema, tier = 'core') {
  return freeze({
    member: /** @type {const} */ ('state'), schema, tier,
    optional: () => field(schema, 'optional'),
  });
}

const stateOf = (value, what) => { if (!isObject(value) || value.member !== 'state') fail(`${what} must be a field built with s.*`); return value; };
const simple = (t) => () => field(freeze({ t }));

/** Value schemas: state fields, operation arguments, event payloads. */
export const s = freeze({
  string: simple('string'),
  number: simple('number'),
  boolean: simple('boolean'),
  time: simple('time'),
  url: simple('url'),
  content: simple('content'),
  /** Any JSON value, for data that has no schema of its own yet. */
  json: simple('json'),
  enum: (/** @type {string[]} */ ...values) => {
    if (values.length === 0) fail('s.enum needs at least one value');
    for (const v of values) nonEmptyString(v, 's.enum value');
    return field(freeze({ t: 'enum', values: freeze([...values]) }));
  },
  list: (of) => field(freeze({ t: 'list', of: stateOf(of, 's.list element').schema })),
  /** A map from string keys the source names (a question's prompt ids, a limit's id) to values of one schema. */
  record: (of) => field(freeze({ t: 'record', of: stateOf(of, 's.record value').schema })),
  object: (fields) => {
    if (!isObject(fields)) fail('s.object needs a record of fields');
    const entries = Object.entries(fields).map(([k, f]) => [k, freeze({ schema: stateOf(f, `s.object field ${k}`).schema, optional: f.tier === 'optional' })]);
    return field(freeze({ t: 'object', fields: freeze(Object.fromEntries(entries)) }));
  },
  ref: (to) => field(freeze({ t: 'ref', to: nonEmptyString(to, 's.ref target') })),
});

/* ================================================================== relations */

/**
 * @param {string} target
 * @param {Cardinality} cardinality
 * @param {Tier} [tier]
 * @param {boolean} [owned]
 * @param {string} [inverseOf]
 */
function rel(target, cardinality, tier = 'core', owned = false, inverseOf) {
  return freeze({
    member: /** @type {const} */ ('relation'), target, cardinality, tier, owned, ...(inverseOf === undefined ? {} : { inverseOf }),
    optional: () => rel(target, cardinality, 'optional', owned, inverseOf),
    parts: () => rel(target, cardinality, tier, true, inverseOf),
    inverse: (of) => rel(target, cardinality, tier, owned, nonEmptyString(of, 'inverse relation name')),
  });
}

/** The target of a relation to an instance of any type (a Ref: a presentation's subject, docs/graph/03). */
export const ANY_TYPE = '*';

/**
 * A relation's target: a type id, any type (`ANY_TYPE`), or a list of concepts, any of whose instances it may name (graph-integrity G3.3:
 * `r.one(['App', 'Agent', 'Plugin', 'Mod', 'Skill'])`, what defined a setting). Queries filter on it and `referrers` answers it as any.
 */
function targetOf(target) {
  if (!Array.isArray(target)) return nonEmptyString(target, 'relation target');
  const list = target.map((x) => nonEmptyString(x, 'relation target'));
  if (list.length < 2) fail('a relation to a list of types names at least two (a relation to one names that type)');
  if (list.includes(ANY_TYPE)) fail(`a list of relation targets names types, not ${ANY_TYPE}`);
  if (new Set(list).size !== list.length) fail('a list of relation targets names each type once');
  return freeze(list);
}

/** Relations name their target by id; the registry resolves it, so definitions can refer to each other in any order. */
export const r = freeze({
  one: (target) => rel(targetOf(target), 'one'),
  maybe: (target) => rel(targetOf(target), 'maybe'),
  many: (target) => rel(targetOf(target), 'many'),
});

/* ================================================================== operations and events */

/** The schema of an operation's result or an event's payload: a field's own, or a reference for a `one` relation. */
function schemaOfValue(value, what) {
  if (isObject(value) && value.member === 'state') return value.schema;
  if (isObject(value) && value.member === 'relation' && value.cardinality === 'one') return freeze({ t: 'ref', to: value.target });
  return fail(`${what} must be a field built with s.* or a r.one(...) relation`);
}

/**
 * An operation. `args` lists the argument schemas in order; an optional argument (`s.string().optional()`) must come after every
 * required one, and `minArgs` counts the required ones, which the runtime needs to validate a call. `content`: what it answers is
 * sensitive content (terminal output, file contents, a diff: docs/graph/04 §6), so a mod's grant must name the operation itself.
 * @param {{ args?: readonly object[], returns?: object, content?: boolean }} [spec]
 */
export function op(spec = {}) {
  const fields = (spec.args ?? []).map((a, i) => stateOf(a, `operation argument ${i}`));
  let minArgs = 0;
  fields.forEach((a, i) => {
    if (a.tier === 'optional') return;
    if (fields.slice(0, i).some((p) => p.tier === 'optional')) fail(`operation argument ${i} is required but follows an optional one`);
    minArgs = i + 1;
  });
  return operation(fields.map((a) => a.schema), minArgs, spec.returns === undefined ? null : schemaOfValue(spec.returns, 'operation returns'), 'core', spec.content === true);
}

function operation(args, minArgs, returns, tier, content = false) {
  return freeze({
    member: /** @type {const} */ ('operation'), args: freeze(args), minArgs, returns, tier, ...(content ? { content: true } : {}),
    optional: () => operation(args, minArgs, returns, 'optional', content),
  });
}

/**
 * An event, with an optional payload: a field, or a `r.one(...)` relation for an instance.
 * @param {object} [payload]
 */
export function ev(payload) {
  return freeze({ member: /** @type {const} */ ('event'), payload: payload === undefined ? null : schemaOfValue(payload, 'event payload') });
}

/* ================================================================== definitions */

/** Copy a spec, check its shape and freeze it. Checks that need the whole graph (targets, inheritance) are the registry's. */
function freezeSpec(id, spec) {
  if (!isObject(spec)) fail(`${id}: the spec must be an object`);
  for (const key of Object.keys(spec)) if (!SPEC_KEYS.includes(key)) fail(`${id}: unknown spec key "${key}"`);
  const out = {};
  const seen = new Set();
  for (const [section, member] of Object.entries(SECTIONS)) {
    if (spec[section] === undefined) continue;
    if (!isObject(spec[section])) fail(`${id}.${section} must be a record`);
    const entries = Object.entries(spec[section]);
    for (const [name, m] of entries) {
      if (!MEMBER_NAME.test(name)) fail(`${id}.${section}: "${name}" is not a valid member name`);
      if (!isObject(m) || m.member !== member) fail(`${id}.${section}.${name} must be built for ${section}`);
      if (section === 'events') continue; // events are subscribed to by name, so they share no namespace with the members
      if (RESERVED_NAMES.includes(name)) fail(`${id}.${section}.${name}: the name is reserved for every instance`);
      if (seen.has(name)) fail(`${id}.${section}.${name}: the name is used twice`);
      seen.add(name);
    }
    out[section] = freeze(Object.fromEntries(entries));
  }
  if (spec.summary !== undefined) {
    if (!isObject(spec.summary)) fail(`${id}.summary must be an object`);
    for (const [slot, name] of Object.entries(spec.summary)) {
      if (!SUMMARY_KEYS.includes(slot)) fail(`${id}.summary: unknown slot "${slot}"`);
      nonEmptyString(name, `${id}.summary.${slot}`);
    }
    if (spec.summary.title === undefined) fail(`${id}.summary needs a title`);
    out.summary = freeze({ ...spec.summary });
  }
  for (const flag of /** @type {const} */ (['searchable', 'mentionable'])) {
    if (spec[flag] === undefined) continue;
    if (typeof spec[flag] !== 'boolean') fail(`${id}.${flag} must be a boolean`);
    out[flag] = spec[flag];
  }
  return freeze(out);
}

/** Define a new concept: a type with a small core (docs/graph/04 §7, define). A concept's summary names its own state fields. */
export function defineConcept(id, spec) {
  nonEmptyString(id, 'type id');
  const frozen = freezeSpec(id, spec);
  if (frozen.summary) {
    for (const [slot, name] of Object.entries(frozen.summary)) {
      if (!Object.hasOwn(frozen.state ?? {}, name)) fail(`${id}.summary.${slot}: "${name}" is not a state field`);
    }
  }
  return freeze({ id, kind: /** @type {const} */ ('concept'), parent: null, spec: frozen });
}

/** Define a subtype of a concept or of another subtype. It lists only what it adds. */
export function defineSubtype(parent, id, spec) {
  if (!isObject(parent) || typeof parent.id !== 'string' || (parent.kind !== 'concept' && parent.kind !== 'subtype')) fail(`${id}: the parent must be a definition`);
  nonEmptyString(id, 'type id');
  return freeze({ id, kind: /** @type {const} */ ('subtype'), parent: parent.id, spec: freezeSpec(id, spec) });
}

/** A typed key for data attached to any instance of a type (docs/graph/04 §7, attach). */
export function defineAttachment(name, on, value) {
  nonEmptyString(name, 'attachment name');
  if (!isObject(on) || typeof on.id !== 'string') fail(`${name}: "on" must be a definition`);
  return freeze({ name, on: on.id, schema: stateOf(value, `${name} value`).schema });
}

/* ================================================================== descriptors */

const DROP = Symbol('drop');

/** A deep, frozen, JSON-shaped copy: functions and undefined values are dropped. */
function plain(value, path) {
  switch (typeof value) {
    case 'function': case 'undefined': return DROP;
    case 'string': case 'boolean': return value;
    case 'number': return Number.isFinite(value) ? value : fail(`${path} is not a finite number`);
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) return freeze(value.map((item, i) => { const p = plain(item, `${path}[${i}]`); return p === DROP ? null : p; }));
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const p = plain(v, `${path}.${k}`);
        if (p !== DROP) out[k] = p;
      }
      return freeze(out);
    }
    default: return fail(`${path} cannot be part of a descriptor`);
  }
}

/**
 * The descriptor of a definition (or of an attachment key): what the runtime loads and what crosses between realms. A JSON-serializable,
 * deeply frozen copy without the builders' methods.
 * @param {object} def a value from defineConcept, defineSubtype or defineAttachment
 */
export function toDescriptor(def) {
  const isType = isObject(def) && typeof def.id === 'string' && (def.kind === 'concept' || def.kind === 'subtype');
  const isAttachment = isObject(def) && typeof def.name === 'string' && typeof def.on === 'string' && isObject(def.schema);
  if (!isType && !isAttachment) fail('toDescriptor needs a definition built with defineConcept, defineSubtype or defineAttachment');
  return plain(def, isType ? def.id : def.name);
}
