// Unit tests of the SDK v2 definition builders: shapes, immutability, validation and descriptors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as define from './define.mjs';
import * as entry from './index.mjs';
import { defineAttachment, defineConcept, defineSubtype, ev, op, r, s, toDescriptor } from './define.mjs';

/** A builder object without its methods. */
const data = (builder) => Object.fromEntries(Object.entries(builder).filter(([, v]) => typeof v !== 'function'));

function assertDeepFrozen(value, path = 'value') {
  if (typeof value !== 'object' || value === null) return;
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [k, v] of Object.entries(value)) assertDeepFrozen(v, `${path}.${k}`);
}
function assertNoFunctions(value, path = 'value') {
  assert.notEqual(typeof value, 'function', `${path} is a function`);
  if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) assertNoFunctions(v, `${path}.${k}`);
}

test('s: value schemas', () => {
  for (const t of ['string', 'number', 'boolean', 'time', 'url', 'content', 'json']) {
    assert.deepEqual(data(s[t]()), { member: 'state', schema: { t }, tier: 'core' }, t);
  }
  assert.deepEqual(s.enum('a', 'b').schema, { t: 'enum', values: ['a', 'b'] });
  assert.deepEqual(s.list(s.number()).schema, { t: 'list', of: { t: 'number' } });
  assert.deepEqual(s.ref('Thread').schema, { t: 'ref', to: 'Thread' });
  assert.deepEqual(s.object({ id: s.string(), note: s.string().optional() }).schema, {
    t: 'object',
    fields: { id: { schema: { t: 'string' }, optional: false }, note: { schema: { t: 'string' }, optional: true } },
  });
});

test('s: builders return frozen values, each call a new one', () => {
  assertDeepFrozen(s.string());
  assertDeepFrozen(s.enum('a'));
  assertDeepFrozen(s.object({ a: s.list(s.ref('X')) }));
  assert.notEqual(s.string(), s.string());
  assert.ok(Object.isFrozen(s) && Object.isFrozen(r));
});

test('s: invalid input is a TypeError', () => {
  assert.throws(() => s.enum(), TypeError);
  assert.throws(() => s.enum('a', ''), TypeError);
  assert.throws(() => s.list('string'), TypeError);
  assert.throws(() => s.ref(''), TypeError);
  assert.throws(() => s.object({ a: 'string' }), TypeError);
});

test('optional() returns a copy and leaves the original alone', () => {
  const f = s.string();
  const o = f.optional();
  assert.equal(f.tier, 'core');
  assert.equal(o.tier, 'optional');
  assert.deepEqual(o.schema, f.schema);
  assert.equal(o.optional().tier, 'optional');
  assert.equal(typeof o.optional, 'function');
});

test('r: relations', () => {
  assert.deepEqual(data(r.one('Turn')), { member: 'relation', target: 'Turn', cardinality: 'one', tier: 'core', owned: false });
  assert.deepEqual(data(r.maybe('Turn')), { member: 'relation', target: 'Turn', cardinality: 'maybe', tier: 'core', owned: false });
  assert.deepEqual(data(r.many('Turn')), { member: 'relation', target: 'Turn', cardinality: 'many', tier: 'core', owned: false });
  assert.ok(!('inverseOf' in r.many('Turn')), 'no inverseOf key until one is set');
  assert.throws(() => r.one(''), TypeError);
  assert.throws(() => r.many(undefined), TypeError);
});

test('r: optional(), parts() and inverse() do not mutate and combine in any order', () => {
  const base = r.many('Turn');
  const parts = base.parts();
  const inverse = base.inverse('thread');
  const optional = base.optional();
  assert.equal(base.owned, false);
  assert.equal(base.tier, 'core');
  assert.ok(!('inverseOf' in base));
  assert.equal(parts.owned, true);
  assert.equal(inverse.inverseOf, 'thread');
  assert.equal(optional.tier, 'optional');
  const a = base.parts().inverse('thread').optional();
  const b = base.optional().inverse('thread').parts();
  assert.deepEqual(data(a), data(b));
  assert.deepEqual(data(a), { member: 'relation', target: 'Turn', cardinality: 'many', tier: 'optional', owned: true, inverseOf: 'thread' });
  assert.throws(() => base.inverse(''), TypeError);
  assertDeepFrozen(a);
});

test('op: arguments, result, tier', () => {
  assert.deepEqual(data(op()), { member: 'operation', args: [], minArgs: 0, returns: null, tier: 'core' });
  assert.deepEqual(data(op({ args: [s.string(), s.number()], returns: s.boolean() })), {
    member: 'operation', args: [{ t: 'string' }, { t: 'number' }], minArgs: 2, returns: { t: 'boolean' }, tier: 'core',
  });
  assert.deepEqual(op({ returns: r.one('Thread') }).returns, { t: 'ref', to: 'Thread' });
  // content (04 §6): kept through optional() and into the descriptor
  assert.equal(op({ returns: s.string(), content: true }).optional().content, true);
  assert.equal(data(op({ content: true })).content, true);
  assert.equal('content' in op(), false);
});

test('op: returns accepts a field or a one relation only', () => {
  assert.throws(() => op({ returns: r.many('Thread') }), TypeError);
  assert.throws(() => op({ returns: r.maybe('Thread') }), TypeError);
  assert.throws(() => op({ returns: 'string' }), TypeError);
  assert.throws(() => op({ args: ['string'] }), TypeError);
});

test('op: optional arguments are counted and must trail', () => {
  assert.equal(op({ args: [s.string().optional()] }).minArgs, 0);
  assert.equal(op({ args: [s.string(), s.number().optional()] }).minArgs, 1);
  assert.equal(op({ args: [s.list(s.string()).optional(), s.string().optional()] }).minArgs, 0);
  assert.deepEqual(op({ args: [s.string().optional()] }).args, [{ t: 'string' }]);
  assert.throws(() => op({ args: [s.string().optional(), s.number()] }), TypeError);
});

test('op: optional() returns a copy and keeps the arguments', () => {
  const base = op({ args: [s.string()], returns: r.one('Turn') });
  const opt = base.optional();
  assert.equal(base.tier, 'core');
  assert.equal(opt.tier, 'optional');
  assert.deepEqual(opt.args, base.args);
  assert.equal(opt.minArgs, 1);
  assert.deepEqual(opt.returns, base.returns);
  assertDeepFrozen(opt);
});

test('ev: payloads', () => {
  assert.deepEqual(data(ev()), { member: 'event', payload: null });
  assert.deepEqual(ev(r.one('Turn')).payload, { t: 'ref', to: 'Turn' });
  assert.deepEqual(ev(s.string()).payload, { t: 'string' });
  assert.throws(() => ev(r.many('Turn')), TypeError);
  assertDeepFrozen(ev(s.string()));
});

test('defineConcept: shape, frozen, spec copied', () => {
  const state = { name: s.string(), done: s.boolean().optional() };
  const def = defineConcept('Task', {
    state,
    relations: { owner: r.one('Person') },
    operations: { finish: op() },
    events: { finished: ev() },
    summary: { title: 'name' },
    searchable: true,
  });
  assert.equal(def.id, 'Task');
  assert.equal(def.kind, 'concept');
  assert.equal(def.parent, null);
  assert.deepEqual(Object.keys(def.spec).sort(), ['events', 'operations', 'relations', 'searchable', 'state', 'summary']);
  assert.equal(def.spec.searchable, true);
  assert.equal(def.spec.mentionable, undefined);
  assertDeepFrozen(def);
  state.extra = s.string();
  assert.ok(!('extra' in def.spec.state), 'a later change to the author literal does not reach the definition');
});

test('defineConcept: an empty spec is allowed', () => {
  assert.deepEqual(data(defineConcept('Empty', {})).spec, {});
});

test('defineConcept: validation', () => {
  assert.throws(() => defineConcept('', {}), TypeError);
  assert.throws(() => defineConcept('X', null), TypeError);
  assert.throws(() => defineConcept('X', { states: {} }), /unknown spec key/);
  assert.throws(() => defineConcept('X', { state: { a: r.one('Y') } }), /must be built for state/);
  assert.throws(() => defineConcept('X', { relations: { a: s.string() } }), /must be built for relations/);
  assert.throws(() => defineConcept('X', { operations: { a: ev() } }), /must be built for operations/);
  assert.throws(() => defineConcept('X', { events: { a: op() } }), /must be built for events/);
  assert.throws(() => defineConcept('X', { state: { 'a b': s.string() } }), /valid member name/);
  assert.throws(() => defineConcept('X', { searchable: 'yes' }), TypeError);
});

test('defineConcept: names that clash are refused', () => {
  for (const name of ['ref', 'liveness', 'summary', 'is', 'can', 'attached', 'watch', 'on']) {
    assert.throws(() => defineConcept('X', { state: { [name]: s.string() } }), /reserved/, name);
  }
  assert.throws(() => defineConcept('X', { relations: { queue: r.many('Y') }, operations: { queue: op() } }), /used twice/);
  assert.throws(() => defineConcept('X', { state: { a: s.string() }, relations: { a: r.one('Y') } }), /used twice/);
  // an event is subscribed to by name and shares no namespace with the members
  assert.doesNotThrow(() => defineConcept('X', { operations: { archive: op() }, state: { archived: s.boolean() }, events: { archived: ev() } }));
});

test('defineConcept: the summary names state fields', () => {
  assert.throws(() => defineConcept('X', { state: { a: s.string() }, summary: { title: 'b' } }), /not a state field/);
  assert.throws(() => defineConcept('X', { state: { a: s.string() }, summary: { title: 'a', time: 'zzz' } }), /not a state field/);
  assert.throws(() => defineConcept('X', { state: { a: s.string() }, summary: { subtitle: 'a' } }), /needs a title/);
  assert.throws(() => defineConcept('X', { state: { a: s.string() }, summary: { title: 'a', badges: 'a' } }), /unknown slot/);   // badges come from decorations, not a state field
  assert.throws(() => defineConcept('X', { relations: { a: r.one('Y') }, summary: { title: 'a' } }), /not a state field/);
});

test('defineSubtype: shape, chains, validation', () => {
  const base = defineConcept('Base', { state: { a: s.string() } });
  const mid = defineSubtype(base, 'Mid', { state: { b: s.number() } });
  const leaf = defineSubtype(mid, 'Leaf', { operations: { go: op() } });
  assert.deepEqual([mid.kind, mid.parent, leaf.kind, leaf.parent], ['subtype', 'Base', 'subtype', 'Mid']);
  assert.deepEqual(Object.keys(leaf.spec), ['operations']);
  assertDeepFrozen(leaf);
  assert.throws(() => defineSubtype({}, 'X', {}), TypeError);
  assert.throws(() => defineSubtype('Base', 'X', {}), TypeError);
  assert.throws(() => defineSubtype(base, '', {}), TypeError);
  assert.throws(() => defineSubtype(base, 'X', { state: { summary: s.string() } }), /reserved/);
});

test('defineAttachment', () => {
  const Thread = defineConcept('Thread', {});
  const key = defineAttachment('acme.ticket', Thread, s.object({ key: s.string(), url: s.url() }));
  assert.deepEqual(key, {
    name: 'acme.ticket', on: 'Thread',
    schema: { t: 'object', fields: { key: { schema: { t: 'string' }, optional: false }, url: { schema: { t: 'url' }, optional: false } } },
  });
  assertDeepFrozen(key);
  assert.throws(() => defineAttachment('', Thread, s.string()), TypeError);
  assert.throws(() => defineAttachment('x', 'Thread', s.string()), TypeError);
  assert.throws(() => defineAttachment('x', Thread, r.one('Thread')), TypeError);
});

const sample = () => defineConcept('Sample', {
  state: { title: s.string(), tags: s.list(s.string()).optional(), kind: s.enum('a', 'b'), blob: s.json() },
  relations: { items: r.many('Item').parts().inverse('sample'), owner: r.maybe('Person').optional() },
  operations: {
    run: op({ args: [s.string(), s.content().optional()], returns: r.one('Item') }),
    stop: op().optional(),
  },
  events: { ran: ev(r.one('Item')), stopped: ev() },
  summary: { title: 'title', status: 'kind' },
  mentionable: true,
});

test('toDescriptor: JSON-serializable, no methods, frozen', () => {
  const descriptor = toDescriptor(sample());
  assertNoFunctions(descriptor);
  assertDeepFrozen(descriptor);
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(descriptor))), JSON.stringify(descriptor));
});

test('toDescriptor: carries every member as data', () => {
  const { spec } = toDescriptor(sample());
  assert.deepEqual(spec.state.tags, { member: 'state', schema: { t: 'list', of: { t: 'string' } }, tier: 'optional' });
  assert.deepEqual(spec.state.blob.schema, { t: 'json' });
  assert.deepEqual(spec.relations.items, { member: 'relation', target: 'Item', cardinality: 'many', tier: 'core', owned: true, inverseOf: 'sample' });
  assert.deepEqual(spec.relations.owner, { member: 'relation', target: 'Person', cardinality: 'maybe', tier: 'optional', owned: false });
  assert.deepEqual(spec.operations.run, {
    member: 'operation', args: [{ t: 'string' }, { t: 'content' }], minArgs: 1, returns: { t: 'ref', to: 'Item' }, tier: 'core',
  });
  assert.equal(spec.operations.stop.tier, 'optional');
  assert.deepEqual(spec.events.ran, { member: 'event', payload: { t: 'ref', to: 'Item' } });
  assert.deepEqual(spec.events.stopped, { member: 'event', payload: null });
  assert.deepEqual(spec.summary, { title: 'title', status: 'kind' });
  assert.equal(spec.mentionable, true);
  assert.ok(!('searchable' in spec));
});

test('toDescriptor: a subtype, an attachment, and a copy that is not the builder', () => {
  const def = sample();
  const sub = defineSubtype(def, 'SubSample', { state: { extra: s.number() } });
  assert.deepEqual(toDescriptor(sub), { id: 'SubSample', kind: 'subtype', parent: 'Sample', spec: { state: { extra: { member: 'state', schema: { t: 'number' }, tier: 'core' } } } });
  const key = defineAttachment('acme.n', def, s.number());
  assert.deepEqual(toDescriptor(key), { name: 'acme.n', on: 'Sample', schema: { t: 'number' } });
  assert.notEqual(toDescriptor(def).spec.state.title, def.spec.state.title);
  assert.equal(typeof def.spec.state.title.optional, 'function', 'the builder keeps its methods');
});

test('toDescriptor: refuses what is not a definition', () => {
  for (const bad of [null, undefined, 'Thread', {}, { id: 'X' }, s.string(), r.one('X'), op()]) assert.throws(() => toDescriptor(bad), TypeError);
});

test('index.d.ts declares every runtime export, and index.mjs re-exports them', () => {
  const declared = [...readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8').matchAll(/^export declare (?:const|function) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(declared)].sort(), Object.keys(define).sort());
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(define).sort());
});
