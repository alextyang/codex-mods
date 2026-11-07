import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWhere, validateWhere, namesInstance, validateOf } from './where.mjs';

const P = { type: 'Project', provider: 'codex', id: 'p1' };
const project = { ref: P, state: { title: 'Repo', path: '/r' }, links: {} };
const T = (id, state, links = { project: P }) => ({ ref: { type: 'CodexThread', provider: 'codex', id }, state, links });
const t1 = T('t1', { title: 'Fix the build', status: 'working', tags: ['a', 'b'], context: { used: 0.4 }, pinned: false });
const RELS = { CodexThread: new Set(['project', 'turns']), Project: new Set(['threads']) };
const env = {
  relation: (type, name) => RELS[type]?.has(name) ?? false,
  related: (inst, name) => (name === 'project' ? (inst.links.project ? project : null) : name === 'turns' ? [] : undefined),
  attached: (inst, mod) => (mod === 'tagger' && inst.ref.id === 't1' ? { tag: 'urgent', meta: { owner: 'al' } } : undefined),
};
const holds = (w, inst = t1, e = env) => compileWhere(w).test(inst, e);

test('equality on state fields, literal objects and lists compared whole', () => {
  assert.equal(holds({ status: 'working' }), true);
  assert.equal(holds({ status: 'done' }), false);
  assert.equal(holds({ context: { used: 0.4 } }), true, 'a literal object is equality, not an operator');
  assert.equal(holds({ tags: ['a', 'b'] }), true);
  assert.equal(holds({ 'context.used': 0.4 }), true, 'a dotted path into a state object');
  assert.equal(holds({ pinned: false }), true);
  assert.equal(holds({ missing: null }), false, 'absent is not null');
});

test('operators', () => {
  assert.equal(holds({ status: { $in: ['working', 'waitingForYou'] } }), true);
  assert.equal(holds({ status: { $nin: ['working'] } }), false);
  assert.equal(holds({ status: { $ne: 'done' } }), true);
  assert.equal(holds({ 'context.used': { $gt: 0.3, $lte: 0.4 } }), true);
  assert.equal(holds({ 'context.used': { $gt: 0.5 } }), false);
  assert.equal(holds({ title: { $contains: 'build' } }), true);
  assert.equal(holds({ tags: { $contains: 'b' } }), true);
  assert.equal(holds({ title: { $prefix: 'Fix' } }), true);
  assert.equal(holds({ title: { $glob: 'Fix*bu?ld' } }), true);
  assert.equal(holds({ title: { $glob: 'fix*' } }), false, 'globs are case-sensitive');
  assert.equal(holds({ title: { $matches: { pattern: '^fix\\b', flags: 'i' } } }), true);
  assert.equal(holds({ missing: { $exists: false } }), true);
  assert.equal(holds({ title: { $exists: true } }), true);
  assert.equal(holds({ 'context.used': { $gt: '0' } }), false, 'no comparison across types');
});

test('paths through relations, three hops at most; the target compared by ref', () => {
  assert.equal(holds({ project: P }), true);
  assert.equal(holds({ project: { type: 'Project', provider: 'codex', id: 'p2' } }), false);
  assert.equal(holds({ 'project.title': 'Repo' }), true);
  assert.equal(holds({ 'project.title': 'Other' }), false);
  const deep = { relation: () => true, related: (inst) => inst };   // every segment a hop
  assert.equal(compileWhere({ 'a.b.c.d': 1 }).evaluate(t1, deep), 'unknown', 'a fourth hop is unknown');
});

test('unknown: an unloaded target matches nothing but $exists false; evaluate says unknown', () => {
  const unloaded = { ...env, related: () => undefined };
  const w = compileWhere({ 'project.title': 'Repo' });
  assert.equal(w.test(t1, unloaded), false);
  assert.equal(w.evaluate(t1, unloaded), 'unknown');
  assert.equal(compileWhere({ 'project.title': { $exists: false } }).evaluate(t1, unloaded), true);
  assert.equal(compileWhere({ $or: [{ 'project.title': 'Repo' }, { status: 'working' }] }).evaluate(t1, unloaded), true, 'or: one known true is enough');
  assert.equal(compileWhere({ 'project.title': 'Repo', status: 'done' }).evaluate(t1, unloaded), false, 'and: one known false is enough');
  assert.equal(compileWhere({ $not: { 'project.title': 'Repo' } }).evaluate(t1, unloaded), 'unknown');
  assert.equal(compileWhere({ status: 'working' }).evaluate(null, env), 'unknown', 'no instance');
});

test('attached data: the reader view the environment gives', () => {
  assert.equal(holds({ '@tagger/tag': 'urgent' }), true);
  assert.equal(holds({ '@tagger/meta.owner': 'al' }), true);
  assert.equal(holds({ '@tagger/tag': { $exists: false } }, T('t2', {})), true, 'no value is absent, not unknown');
  assert.equal(holds({ '@other.mod/tag': 'urgent' }), false);
  assert.equal(holds({ '@tagger/tag': 'urgent' }, t1, { ...env, attached: undefined }), false, 'no attached data in this environment');
});

test('$or, $not, $any and $all', () => {
  assert.equal(holds({ $or: [{ status: 'done' }, { pinned: false }] }), true);
  assert.equal(holds({ $not: { status: 'done' } }), true);
  const turns = [{ ref: { type: 'Turn', provider: 'codex', id: 'u1' }, state: { status: 'done' } }, { ref: { type: 'Turn', provider: 'codex', id: 'u2' }, state: { status: 'failed' } }];
  const e2 = { ...env, related: (inst, name) => (name === 'turns' ? turns : env.related(inst, name)) };
  assert.equal(holds({ turns: { $any: { status: 'failed' } } }, t1, e2), true);
  assert.equal(holds({ turns: { $all: { status: 'done' } } }, t1, e2), false);
  assert.equal(holds({ turns: { $all: { status: { $in: ['done', 'failed'] } } } }, t1, e2), true);
  assert.equal(holds({ turns: { $any: { status: 'failed' } } }), false, 'no turns');
  // a list of objects in the state: each entry read as a record; a bare ref in a list is not one (its instance not read): unknown
  const usage = T('u', { limits: [{ percent: 40 }, { percent: 85 }], mods: [{ type: 'Mod', provider: 'framework', id: 'a' }] });
  assert.equal(holds({ limits: { $any: { percent: { $gte: 80 } } } }, usage), true);
  assert.equal(holds({ limits: { $all: { percent: { $gte: 80 } } } }, usage), false);
  assert.equal(compileWhere({ mods: { $any: { status: 'enabled' } } }).evaluate(usage, env), 'unknown', 'built review H6m2b');
  assert.equal(compileWhere({ mods: { $all: { status: { $exists: false } } } }).evaluate(usage, env), 'unknown');
});

test('malformed wheres are refused with the reason', () => {
  for (const [w, re] of [
    [{ status: { $nope: 1 } }, /unknown operator/],
    [{ $and: [] }, /unknown combinator/],
    [{ $or: [] }, /\$or/],
    [{ '': 1 }, /non-empty/],
    [{ 'a..b': 1 }, /empty or operator segment/],
    [{ '@mod': 1 }, /attached path/],
    [{ x: { $in: 3 } }, /takes a list/],
    [{ x: { $gt: {} } }, /number or a string/],
    [{ x: { $matches: '(?=x)' } }, /./],
    [{ x: { $exists: 'yes' } }, /true or false/],
    ['status', /an object/],
  ]) assert.throws(() => validateWhere(w), (e) => e.code === 'Invalid' && re.test(e.message), JSON.stringify(w));
  const big = {}; for (let i = 0; i < 300; i++) big[`f${i}`] = i;
  assert.throws(() => validateWhere(big), /at most 256 parts/);
  let nested = { status: 'x' }; for (let i = 0; i < 6; i++) nested = { $not: nested };
  assert.throws(() => validateWhere(nested), /too deep/);
});

test('of names instances by ref', () => {
  assert.equal(namesInstance(undefined, t1), true);
  assert.equal(namesInstance({ provider: 'codex', id: 't1' }, t1), true);
  assert.equal(namesInstance([{ provider: 'codex', id: 'x' }, { type: 'Thread', provider: 'codex', id: 't1' }], t1, (t) => [t, 'Thread']), true, 'a concept ref names a subtype instance');
  assert.equal(namesInstance({ type: 'Thread', provider: 'codex', id: 't1' }, t1), false, 'without the chain, the same type only');
  assert.equal(namesInstance({ provider: 'other', id: 't1' }, t1), false);
  assert.throws(() => validateOf([{ id: 'x' }]), /of is a ref/);
  assert.equal(validateOf([{ provider: 'p', id: 'x' }]), true);
});
