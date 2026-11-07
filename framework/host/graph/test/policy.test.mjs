// The graph's authority policy (docs/design/breadth.md D0.2; boundary review finding 5a): the rule itself, and the mod ingress
// (ctx/graph.mjs) applying it to reads, relations, views, `can`, `invoke` and interceptors, with the runtime's `authorize` behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, graphGrants, modIdOf } from '../policy.mjs';
import { createGraph } from '../index.mjs';
import { createGraphNs } from '../../ctx/graph.mjs';
import { toDescriptor, defineConcept, defineSubtype, s, r, op } from '../../../../sdk/graph/define.mjs';

const Folder = defineConcept('Folder', { state: { name: s.string() } });
const Doc = defineConcept('Doc', { state: { title: s.string() }, relations: { folder: r.maybe('Folder') }, operations: { touch: op({ args: [s.string()] }) } });
const MemoDoc = defineSubtype(Doc, 'MemoDoc', {});
const ref = (type, provider, id) => ({ type, provider, id });
const USER = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });

/** Folder and Doc are native; MemoDoc is declared by the mod unit.memo; `docs` (native) provides a folder, a doc and a memo. */
function setup() {
  const policyGrants = new Map();
  let graph = null;
  const policy = createPolicy({ grantsOf: (id) => policyGrants.get(id), typeOf: (id) => graph.type(id), canonicalOf: (r) => graph.resolve(r)?.ref?.type ?? null });
  graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes([toDescriptor(Folder), toDescriptor(Doc)], 'native');
  graph.registerTypes([toDescriptor(MemoDoc)], 'mod:unit.memo');
  const touched = [];
  const touch = { effect: 'none', handler: ({ args, caller }) => { touched.push({ arg: args[0], caller: caller.id }); return null; } };
  const docs = graph.registerProvider('native', 'docs', { types: { Folder: {}, Doc: { operations: { touch } }, MemoDoc: {} } });
  docs.put(ref('Folder', 'docs', 'f1'), { state: { name: 'Home' } });
  docs.put(ref('Doc', 'docs', 'd1'), { state: { title: 'Native' }, links: { folder: ref('Folder', 'docs', 'f1') } });
  docs.put(ref('MemoDoc', 'docs', 'm1'), { state: { title: 'A memo' } });
  const ns = createGraphNs({ graph: () => graph });
  /** A host-realm scope for a mod with these grants (the runtime's `authorize` reads the same grants). */
  const as = (id, grants) => { policyGrants.set(id, grants); return { realm: 'host', state: { id, owner: `mod:${id}`, grants } }; };
  return { graph, docs, ns, as, touched, policy };
}

test('graphGrants and modIdOf: bare grants cover everything, scoped ones list entries; only mods have a mod id', () => {
  const none = { read: [], act: [], intercept: [], attach: [], contribute: [] };
  assert.deepEqual(graphGrants(['graph']), { ...none, listed: none });
  assert.deepEqual(graphGrants(['graph.read', 'graph.act:Doc.touch, Folder', 'graph.intercept:Doc', 'graph.contribute:Thread']),
    { read: '*', act: ['Doc.touch', 'Folder'], intercept: ['Doc'], attach: [], contribute: ['Thread'], listed: { read: [], act: ['Doc.touch', 'Folder'], intercept: ['Doc'], attach: [], contribute: ['Thread'] } });
  assert.deepEqual(graphGrants(['graph.read:Doc', 'graph.read']).read, '*', 'a bare grant wins over a scoped one');
  assert.deepEqual(graphGrants(['graph.read:Doc', 'graph.read']).listed.read, ['Doc'], 'and the scoped one is still listed');
  assert.equal(modIdOf(mod('unit.a')), 'unit.a');
  assert.equal(modIdOf({ kind: 'mod', id: 'unit.a' }), 'unit.a');
  assert.equal(modIdOf(USER), null);
  assert.equal(modIdOf({ kind: 'framework', id: 'framework' }), null);
});

test('the rule: own instances, declared types, then scoped grants; a concept covers its subtypes; Type.operation narrows act and intercept', () => {
  const { policy } = setup();
  // what each instance is (the store's): d1 a Doc, m1 a MemoDoc
  const stored = { 'docs:d1': 'Doc', 'docs:m1': 'MemoDoc' };
  const p = (grants) => createPolicy({ grantsOf: () => grants, typeOf: (id) => ({ Doc: { chain: ['Doc'], owner: 'native' }, MemoDoc: { chain: ['Doc', 'MemoDoc'], owner: 'mod:unit.memo' } })[id],
    canonicalOf: (r) => stored[`${r.provider}:${r.id}`] ?? null });
  const d1 = ref('Doc', 'docs', 'd1'), m1 = ref('MemoDoc', 'docs', 'm1'), mine = ref('Doc', 'unit.a', 'x');
  // Not a mod: the ingress authenticated it.
  assert.equal(p([]).allows(USER, 'act', 'Doc', d1, 'touch'), true);
  // Its own instances: read and act, never intercept (an interceptor sees every provider's calls).
  assert.equal(p(['graph']).allows(mod('unit.a'), 'read', 'Doc', mine), true);
  assert.equal(p(['graph']).allows(mod('unit.a'), 'act', 'Doc', mine, 'touch'), true);
  assert.equal(p(['graph']).allows(mod('unit.a'), 'intercept', 'Doc', null, 'touch'), false);
  // Another provider's: nothing without a grant.
  for (const use of ['read', 'act', 'intercept']) assert.equal(p(['graph']).allows(mod('unit.a'), use, 'Doc', d1, 'touch'), false, use);
  // A type it declared: read and intercept every instance of it (another provider's too), but act only with a grant.
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'read', 'MemoDoc', m1), true);
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'intercept', 'MemoDoc', null, 'touch'), true);
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'act', 'MemoDoc', m1, 'touch'), false);
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'read', 'Doc', d1), false, 'its subtype gives it nothing of the concept');
  // review 2026-11-05 #2: a ref naming its subtype for another provider's instance of the concept is that instance, as it is
  const forged = ref('MemoDoc', 'docs', 'd1');
  for (const use of ['read', 'attach', 'contribute', 'intercept']) assert.equal(p(['graph']).allows(mod('unit.memo'), use, 'MemoDoc', forged, 'touch'), false, `forged ${use}`);
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'attach', 'MemoDoc', ref('MemoDoc', 'docs', 'nowhere')), false, 'one not known here is no instance of its type');
  assert.equal(p(['graph']).allows(mod('unit.memo'), 'attach', 'MemoDoc', m1), true, 'a real instance of its type');
  // Scoped grants: a concept covers its subtypes; Type.operation narrows.
  assert.equal(p(['graph.read:Doc']).allows(mod('unit.a'), 'read', 'MemoDoc', m1), true);
  assert.equal(p(['graph.read:MemoDoc']).allows(mod('unit.a'), 'read', 'Doc', d1), false, 'a subtype does not cover its concept');
  assert.equal(p(['graph.act:Doc.touch']).allows(mod('unit.a'), 'act', 'Doc', d1, 'touch'), true);
  assert.equal(p(['graph.act:Doc.touch']).allows(mod('unit.a'), 'act', 'Doc', d1, 'rename'), false);
  assert.equal(p(['graph.act:Doc.*']).allows(mod('unit.a'), 'act', 'Doc', d1, 'rename'), true);
  assert.equal(p(['graph.act:Doc']).allows(mod('unit.a'), 'act', 'MemoDoc', m1, 'touch'), true);
  assert.equal(p(['graph.intercept:Doc.touch']).allows(mod('unit.a'), 'intercept', 'MemoDoc', null, 'touch'), true);
  assert.equal(p(['graph.act', 'graph.read']).allows(mod('unit.a'), 'intercept', 'Doc', null, 'touch'), false, 'each use has its own grant');
  // The Host's policy: authorize and canRead use the registry's chain and owners.
  assert.equal(policy.authorize(mod('unit.a'), { type: 'Doc', use: 'act', operation: 'touch', ref: d1 }), false);
  assert.equal(policy.canRead(mod('unit.memo'), { ref: m1 }), true);
  assert.equal(policy.canRead(mod('unit.memo'), null), false);
});

test('content (04 §6): an operation whose answer is sensitive content is acted on only with a grant that names it', () => {
  const ops = new Map([['tail', { content: true }], ['run', {}]]);
  const p = (grants) => createPolicy({ grantsOf: () => grants, typeOf: (id) => ({ Term: { chain: ['Term'], owner: 'native', members: { operations: ops } },
    MyTerm: { chain: ['Term', 'MyTerm'], owner: 'native', members: { operations: ops } } })[id] });
  const t1 = ref('Term', 'codex', 't1'), mine = ref('Term', 'unit.a', 'x');
  for (const grants of [['graph.act'], ['graph.act:Term'], ['graph.act:Term.*'], ['graph.act:Term.run']]) {
    assert.equal(p(grants).allows(mod('unit.a'), 'act', 'Term', t1, 'tail'), false, grants.join());
    assert.equal(p(grants).allows(mod('unit.a'), 'act', 'Term', t1, 'run'), true, 'its other operations as before');
  }
  assert.equal(p(['graph.act:Term.tail']).allows(mod('unit.a'), 'act', 'Term', t1, 'tail'), true);
  assert.equal(p(['graph.act', 'graph.act:Term.tail']).allows(mod('unit.a'), 'act', 'Term', t1, 'tail'), true, 'a bare grant does not hide one naming it');
  // intercepting it (an interceptor, an `after`, sees its answer) needs the grant naming it too
  assert.equal(p(['graph.intercept:Term']).allows(mod('unit.a'), 'intercept', 'Term', null, 'tail'), false);
  assert.equal(p(['graph.intercept:Term', 'graph.act:Term.tail']).allows(mod('unit.a'), 'intercept', 'Term', null, 'tail'), true);
  assert.equal(p(['graph.intercept:Term']).allows(mod('unit.a'), 'intercept', 'Term', null, 'run'), true, 'its other operations as before');
  assert.equal(p(['graph.act:Term.tail']).allows(mod('unit.a'), 'act', 'MyTerm', ref('MyTerm', 'codex', 'm'), 'tail'), true, 'named on the concept, for its subtypes');
  assert.equal(p(['graph']).allows(mod('unit.a'), 'act', 'Term', mine, 'tail'), true, 'its own instance\'s');
  assert.equal(p([]).allows(USER, 'act', 'Term', t1, 'tail'), true, 'the user\'s');
});

test('ingress: with `graph` alone a mod does not see or reach another provider\'s instances; queries filter by the read rule', async () => {
  const { graph, docs, ns, as, touched } = setup();
  const a = as('unit.a', ['graph']);
  assert.equal(ns.calls.resolve(a, ref('Doc', 'docs', 'd1')), null);
  assert.deepEqual(ns.calls.list(a, 'Doc'), []);
  assert.equal(ns.calls.related(a, ref('Doc', 'docs', 'd1'), 'folder'), null, 'not through an instance it cannot read');
  assert.equal(ns.calls.can(a, ref('Doc', 'docs', 'd1'), 'touch'), false);
  const out = await ns.calls.invoke(a, ref('Doc', 'docs', 'd1'), 'touch', ['x']);
  assert.deepEqual([out.status, out.reason], ['refused', 'notAllowed']);
  assert.deepEqual(touched, []);
  // The runtime's own authorize refuses the same call when it does not come through the ingress.
  const direct = await graph.invoke({ ref: ref('Doc', 'docs', 'd1'), operation: 'touch', args: ['y'], caller: mod('unit.a'), origin: 'unit.a' });
  assert.deepEqual([direct.status, direct.reason], ['refused', 'notAllowed']);
  assert.deepEqual(touched, []);
  // A view: the snapshot leaves out what it may not read, and deltas about it never arrive (unit.memo, which reads the memo, sees its own).
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const got = [], memoGot = [];
  const view = ns.subs.subscribe(a, [{ type: 'Doc' }, {}], (m) => got.push(m));
  const memoView = ns.subs.subscribe(as('unit.memo', ['graph']), [{ type: 'Doc' }, {}], (m) => memoGot.push(m));
  await tick();
  assert.deepEqual(got.find((m) => m.type === 'snapshot').items, []);
  assert.deepEqual(memoGot.find((m) => m.type === 'snapshot').items.map((x) => x.ref.id), ['m1']);
  docs.update(ref('Doc', 'docs', 'd1'), { state: { title: 'Changed' } });
  docs.update(ref('MemoDoc', 'docs', 'm1'), { state: { title: 'Changed memo' } });
  await tick();
  assert.equal(got.filter((m) => m.type === 'delta').length, 0);
  assert.deepEqual(memoGot.filter((m) => m.type === 'delta').map((m) => m.event.ref.id), ['m1']);
  view.dispose(); memoView.dispose();
});

test('ingress: a declared type is readable and interceptable; graph.read, graph.act and graph.intercept open the rest', async () => {
  const { graph, docs, ns, as, touched } = setup();
  // unit.memo declared MemoDoc: it reads the memo `docs` provides, but not the plain doc, and may intercept MemoDoc.touch.
  const memo = as('unit.memo', ['graph']);
  assert.deepEqual(ns.calls.list(memo, 'Doc').map((x) => x.ref.id), ['m1']);
  assert.equal(ns.calls.resolve(memo, ref('MemoDoc', 'docs', 'm1')).state.title, 'A memo');
  assert.equal(ns.calls.can(memo, ref('MemoDoc', 'docs', 'm1'), 'touch'), false, 'reading is not acting');
  const ic = ns.handlers.intercept(memo, ['MemoDoc', 'touch', {}], async () => ({ status: 'refused', reason: 'notAllowed' }));
  assert.equal(graph.intercepted('MemoDoc', 'touch'), true);
  ic.dispose();
  assert.throws(() => ns.handlers.intercept(memo, ['Doc', 'touch', {}], async () => null), (e) => e.code === 'Denied' && /graph\.intercept/.test(e.message));
  // Scoped grants.
  const reader = as('unit.reader', ['graph', 'graph.read:Doc']);
  assert.deepEqual(ns.calls.list(reader, 'Doc').map((x) => x.ref.id).sort(), ['d1', 'm1']);
  assert.equal(ns.calls.related(reader, ref('Doc', 'docs', 'd1'), 'folder'), null, 'Folder is not granted');
  const reader2 = as('unit.reader2', ['graph', 'graph.read:Doc,Folder']);
  assert.equal(ns.calls.related(reader2, ref('Doc', 'docs', 'd1'), 'folder').state.name, 'Home');
  const actor = as('unit.actor', ['graph', 'graph.read:Doc', 'graph.act:Doc.touch']);
  assert.equal(ns.calls.can(actor, ref('Doc', 'docs', 'd1'), 'touch'), true);
  const out = await ns.calls.invoke(actor, ref('Doc', 'docs', 'd1'), 'touch', ['ok']);
  assert.equal(out.status, 'done');
  assert.deepEqual(touched, [{ arg: 'ok', caller: 'unit.actor' }]);
  const icer = as('unit.icer', ['graph', 'graph.intercept:Doc.touch']);
  ns.handlers.intercept(icer, ['Doc', 'touch', {}], async () => null).dispose();
  assert.throws(() => ns.handlers.intercept(icer, ['Folder', 'rename', {}], async () => null), (e) => e.code === 'Denied');
  docs.put(ref('Doc', 'docs', 'd2'), { state: { title: 'Two' } });
  assert.equal(ns.calls.list(reader, 'Doc').length, 3, 'a new instance is filtered like the rest');
});

test('E6: a presentation of what the framework serves is read, never acted on or intercepted; the framework\'s own calls are intercepted only where 07 lets them', () => {
  const types = { Presentation: { chain: ['Presentation'], owner: 'native' }, Dialog: { chain: ['Presentation', 'Dialog'], owner: 'native' },
    Window: { chain: ['Window'], owner: 'native' }, Update: { chain: ['Update'], owner: 'native' }, CopyUpdate: { chain: ['Update', 'CopyUpdate'], owner: 'framework' } };
  const subjects = { fw: { type: 'Mod', provider: 'codexmods.framework', id: 'unit.a' }, app: { type: 'Thread', provider: 'codex', id: 't1' } };
  const p = (grants) => createPolicy({ grantsOf: () => grants, typeOf: (id) => types[id], subjectOf: (r) => subjects[r.id] });
  const all = ['graph.read', 'graph.act', 'graph.intercept'];
  const onFw = ref('Dialog', 'codexmods.windows', 'fw'), onApp = ref('Dialog', 'codexmods.windows', 'app');
  assert.equal(p(all).allows(mod('unit.a'), 'read', 'Dialog', onFw), true, 'read with graph.read');
  assert.equal(p([]).allows(mod('unit.a'), 'read', 'Dialog', onFw), false);
  assert.equal(p(all).allows(mod('unit.a'), 'act', 'Dialog', onFw, 'dismiss'), false, 'never acted on, whatever the grant');
  assert.equal(p(all).allows(mod('unit.a'), 'intercept', 'Dialog', onFw, 'dismiss'), false);
  assert.equal(p(all).allows(mod('unit.a'), 'act', 'Dialog', onApp, 'dismiss'), true, 'a presentation of the app\'s keeps the grants');
  assert.equal(p(all).allows(USER, 'act', 'Dialog', onFw, 'dismiss'), true, 'the user may');
  // the framework's own calls pass no mod: its navigation, and the copy's update (graph-boundary.md B5)
  const win = ref('Window', 'codexmods.windows', 'w1');
  const pol = p(all);
  assert.equal(pol.authorize(mod('unit.a'), { type: 'Window', use: 'intercept', operation: 'open', ref: win, by: { kind: 'framework', id: 'framework' } }), false);
  assert.equal(pol.authorize(mod('unit.a'), { type: 'Window', use: 'intercept', operation: 'open', ref: win, by: USER }), true, 'the user\'s own calls keep the grants');
  const cu = ref('CopyUpdate', 'codexmods.framework', 'copy');
  for (const by of [{ kind: 'framework', id: 'framework' }, USER]) {
    assert.equal(pol.authorize(mod('unit.a'), { type: 'CopyUpdate', use: 'intercept', operation: 'apply', ref: cu, by }), false, `the copy's update is the user's (${by.kind})`);
  }
});

test('graph-integrity G7.3, D1: a mod relays the user\'s intent under its own grant: another mod\'s setting with graph.act for Setting.set, never without it; the framework\'s own instances stay the user\'s', () => {
  const Setting = defineConcept('Setting', { state: { value: s.json() }, operations: { set: op({ args: [s.json()] }), reset: op() } });
  const Mod = defineConcept('Mod', { state: { name: s.string() }, operations: { disable: op() } });
  const g = createGraph();
  g.registerTypes([toDescriptor(Setting)], 'native');
  g.registerTypes([toDescriptor(Mod)], 'framework');
  const grants = { 'unit.mgr': ['graph', 'graph.act:Setting.set'], 'unit.plain': ['graph'], 'unit.mods': ['graph', 'graph.act:Mod.disable'] };
  const p = createPolicy({ grantsOf: (id) => grants[id] ?? [], typeOf: (t) => g.type(t) });
  const theirs = ref('Setting', 'codexmods.framework', 'unit.other/mode');
  const own = ref('Setting', 'codexmods.framework', 'unit.plain/mode');
  assert.equal(p.allows(mod('unit.mgr'), 'act', 'Setting', theirs, 'set'), false, 'alone, a mod never sets another mod\'s setting');
  assert.equal(p.allowsAsUser(mod('unit.mgr'), 'Setting', theirs, 'set'), true, 'as the user, under its grant for it');
  assert.equal(p.allowsAsUser(mod('unit.plain'), 'Setting', theirs, 'set'), false, 'without that grant, not even as the user');
  assert.equal(p.allowsAsUser(mod('unit.plain'), 'Setting', own, 'set'), true, 'its own, as always');
  assert.equal(p.allowsAsUser(mod('unit.mgr'), 'Setting', theirs, 'delete'), false, 'set and reset only');
  assert.equal(p.allowsAsUser(mod('unit.mods'), 'Mod', ref('Mod', 'codexmods.framework', 'unit.other'), 'disable'), false, 'the framework\'s own instances are the user\'s alone');
  assert.equal(p.allowsAsUser(USER, 'Setting', theirs, 'set'), false, 'only a mod relays');
});
