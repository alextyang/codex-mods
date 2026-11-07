// The graph runtime core (docs/design/runtime-core.md R2–R9; integration.md §3, §3.1; docs/graph/04): types, the store, the one
// invocation path, the intent journal and realm views. Headless, with the native type library (sdk/graph/native).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../index.mjs';
import { openJournal } from '../journal.mjs';
import { toDescriptor, defineConcept, defineSubtype, s, op, ev } from '../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const P = 'codex';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
const threadRef = (id) => ({ type: 'CodexThread', provider: P, id });
const turnRef = (id) => ({ type: 'Turn', provider: P, id });
const threadState = (over = {}) => ({ title: 'T', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1, ...over });
const threadLinks = () => ({ agent: { type: 'CodexAgent', provider: P, id: 'codex' } });
const native = (o = {}) => { const g = createGraph(o); g.registerTypes(NATIVE, 'native'); return g; };
const user = { kind: 'user', id: 'user' };

// ------------------------------------------------------------------ types
test('types: the native library registers; members merge along the chain; reflection shows tiers and where members are declared', () => {
  const g = native();
  const t = g.types().find((x) => x.id === 'CodexThread');
  assert.equal(t.concept, 'Thread');
  assert.equal(t.members.state.title.tier, 'core');
  assert.equal(t.members.state.title.declaredIn, 'Thread');
  assert.equal(t.members.state.goal.tier, 'optional');
  assert.equal(t.members.operations.fork.tier, 'optional');
  assert.equal(t.members.relations.turns.inverseOf, 'thread');
  assert.equal(t.members.relations.agent.resolved, true, 'Agent is in the library');
  assert.equal(t.members.relations.project.resolved, true, 'Project is in the library (D3)');
  assert.equal(t.members.relations.environment.resolved, true, 'Environment is in the library (D3)');
  assert.equal(t.members.relations.queue.resolved, true, 'QueuedMessage is in the library (D5)');
  assert.equal(t.members.relations.changes.resolved, true, 'ChangeSet is in the library (D7)');
  assert.equal(g.types().find((x) => x.id === 'Approval').members.relations.rule.resolved, false, 'AccessRule is not in the library (excluded in D2)');
  assert.ok(g.types().find((x) => x.id === 'Thread').subtypes.includes('CodexThread'));
  // a `_` member is the mechanism layer's, its tier kept (docs/design/graph-layers.md §1)
  const step = g.types().find((x) => x.id === 'Step');
  assert.deepEqual([step.members.operations._expand.mechanism, step.members.operations.copy.mechanism, step.members.state._expanded.tier], [true, undefined, 'optional']);
});

test('types: a subtype only adds; a parent comes first; an owner\'s types go with it, with their subtypes', () => {
  const g = native();
  const Note = defineConcept('Note', { state: { text: s.string() } });
  const Bad = defineSubtype(Note, 'BadNote', { state: { text: s.string() } });
  assert.throws(() => g.registerTypes([toDescriptor(Note), toDescriptor(Bad)], 'mod:a'), /a subtype only adds/);
  assert.equal(g.type('Note'), null, 'all or nothing');
  assert.throws(() => g.registerTypes([{ id: 'Orphan', kind: 'subtype', parent: 'Nope', spec: {} }], 'mod:a'), /parent Nope/);
  const Good = defineSubtype(Note, 'GoodNote', { state: { color: s.string() } });
  g.registerTypes([toDescriptor(Note)], 'mod:a');
  g.registerTypes([toDescriptor(Good)], 'mod:b');
  assert.deepEqual(g.disposeOwner('mod:a').sort(), ['GoodNote', 'Note']);
  assert.equal(g.type('GoodNote'), null);
});

test('named events: a provider emits what its type declares; views of the instance, its collection and relations get them (04 §3)', () => {
  const g = native();
  const Note = defineConcept('Note', { state: { text: s.string() }, events: { edited: ev(), pinned: ev(s.boolean()) } });
  const LongNote = defineSubtype(Note, 'LongNote', { events: { split: ev() } });
  g.registerTypes([toDescriptor(Note), toDescriptor(LongNote)], 'mod:n');
  const p = g.registerProvider('mod:n', 'n', { types: { Note: {} } });
  const other = g.registerProvider('mod:o', 'o', { types: { Note: {} } });
  const ref = { type: 'LongNote', provider: 'n', id: 'a' };
  p.put(ref, { state: { text: 'x' } });
  other.put({ type: 'Note', provider: 'o', id: 'b' }, { state: { text: 'y' } });
  const one = [], all = [];
  g.subscribe({ ref }, (m) => { if (m.type === 'delta') one.push(m.event); });
  g.subscribe({ type: 'Note' }, (m) => { if (m.type === 'delta') all.push(m.event); });
  const e = p.emit(ref, 'pinned', true);
  assert.deepEqual([e.kind, e.name, e.payload, e.ref.id], ['event', 'pinned', true, 'a']);
  p.emit(ref, 'split');                                                // a subtype's own event, no payload
  assert.deepEqual(one.map((x) => x.name), ['pinned', 'split']);
  assert.deepEqual(all.map((x) => x.name), ['pinned', 'split'], 'the collection the instance is in');
  assert.throws(() => p.emit(ref, 'nope'), /has no event nope/);
  assert.throws(() => p.emit(ref, 'pinned', 'yes'), /pinned: payload is string, not a boolean/);
  assert.throws(() => p.emit(ref, 'edited', { x: 1 }), /has no payload/);
  assert.throws(() => p.emit({ type: 'Note', provider: 'o', id: 'b' }, 'edited'), /has no instance/, 'only its own instances');
  p.remove(ref);
  assert.equal(p.emit(ref, 'edited').name, 'edited', 'an instance gone a moment ago may still say why');
  assert.deepEqual(all.map((x) => x.kind === 'event' ? x.name : x.kind), ['pinned', 'split', 'removed', 'edited'], 'the collection it was in until a moment ago hears it (D3, found natively)');
  const fresh = [];
  g.subscribe({ type: 'Note' }, (m) => { if (m.type === 'delta') fresh.push(m.event); });
  p.emit(ref, 'edited');
  assert.deepEqual(fresh, [], 'a view it was never in does not');
  p.put(ref, { state: { text: 'back' } });
  p.remove(ref);
  p.emit(ref, 'edited');
  assert.deepEqual(fresh.map((x) => x.kind === 'event' ? x.name : x.kind), ['added', 'removed', 'edited']);
});

test('lifecycle: what other owners built on a departing owner\'s types goes with them, and those owners are degraded until they register again (6b)', async () => {
  const g = native();
  const Note = defineConcept('Note', { state: { text: s.string() }, operations: { touch: op({ args: [] }) } });
  const DepNote = defineSubtype(Note, 'DepNote', {});
  const Other = defineConcept('Other', { state: { text: s.string() } });
  g.registerTypes([toDescriptor(Note)], 'mod:base');
  g.registerTypes([toDescriptor(DepNote), toDescriptor(Other)], 'mod:dep');
  const dep = g.registerProvider('mod:dep', 'dep', { types: { DepNote: {}, Other: {} } });
  const only = g.registerProvider('mod:dep2', 'dep2', { types: { DepNote: {} } });
  dep.put({ type: 'DepNote', provider: 'dep', id: 'n1' }, { state: { text: 'a' } });
  dep.put({ type: 'Other', provider: 'dep', id: 'o1' }, { state: { text: 'b' } });
  only.put({ type: 'DepNote', provider: 'dep2', id: 'n2' }, { state: { text: 'c' } });
  dep.setComplete('Other', true);
  g.intercept('mod:watch', 'Note', 'touch', async (c, next) => next());
  assert.deepEqual(g.disposeOwner('mod:base').sort(), ['DepNote', 'Note']);
  // The instances of the departed types go; the dependent provider keeps the rest; one left with nothing is disposed.
  assert.equal(g.resolve({ type: 'Other', provider: 'dep', id: 'o1' }).state.text, 'b');
  assert.equal(g.list('Other').length, 1);
  assert.equal(g.isComplete('Other'), true, 'what it still provides is unchanged');
  assert.equal(dep.disposed, false);
  assert.equal(only.disposed, true);
  // Each owner that lost something is degraded, saying what and because of whom.
  const byOwner = Object.fromEntries(g.degraded().map((d) => [d.owner, d]));
  assert.deepEqual(Object.keys(byOwner).sort(), ['mod:dep', 'mod:dep2', 'mod:watch']);
  assert.deepEqual([byOwner['mod:dep'].types, byOwner['mod:dep'].because], [['DepNote'], 'mod:base']);
  assert.deepEqual(byOwner['mod:watch'].types, ['Note'], 'its interceptor went');
  // Registering again (the base is back, the dependent restarted) clears it; so does the dependent going.
  g.registerTypes([toDescriptor(Note)], 'mod:base');
  assert.equal(g.intercepted('Note', 'touch'), false, 'the interceptor on the departed type did not come back with it');
  g.registerTypes([toDescriptor(DepNote)], 'mod:dep');
  g.disposeOwner('mod:dep2');
  assert.deepEqual(g.degraded().map((d) => d.owner), ['mod:watch']);
});

// ------------------------------------------------------------------ store
test('store: a provider puts instances with their core fields; changes are events with old and new values; refs keep identity across subtypes', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Turn: {}, Message: {} } });
  assert.throws(() => p.put(threadRef('t1'), { state: { title: 'x' }, links: threadLinks('t1') }), /core field/);
  const events = [];
  g.onEvent((e) => events.push(e));
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  p.update(threadRef('t1'), { state: { title: 'Renamed', goal: { objective: 'ship', status: 'active', tokensUsed: 0, timeUsed: 0, createdAt: 1, updatedAt: 1 } } });
  const changed = events.at(-1);
  assert.equal(changed.kind, 'changed');
  assert.deepEqual(changed.fields.sort(), ['goal', 'title']);
  assert.equal(changed.old.title, 'T');
  assert.equal(changed.new.title, 'Renamed');
  assert.ok(changed.seq > events[0].seq);
  // A ref to the concept finds the subtype's instance (identity is provider, concept and id).
  assert.equal(g.resolve({ type: 'Thread', provider: P, id: 't1' }).state.title, 'Renamed');
  assert.equal(g.resolve(threadRef('t1')).summary.title, 'Renamed');
  // Another provider cannot write it.
  const q = g.registerProvider('mod:x', 'x', { types: { Thread: {} } });
  assert.throws(() => q.update(threadRef('t1'), { state: { title: 'no' } }), /only its own/);
});

test('store: many relations derive from the inverse one relation, including a subtype target through an inherited relation', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Turn: {}, Message: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  p.put(turnRef('u1'), { state: { status: 'completed', startedAt: 1, startedBy: { kind: 'user' } }, links: { thread: threadRef('t1') } });
  p.put(turnRef('u2'), { state: { status: 'running', startedAt: 2, startedBy: { kind: 'user' } }, links: { thread: threadRef('t1') } });
  p.put({ type: 'UserMessage', provider: P, id: 't1:m1' }, { state: { content: { parts: [{ kind: 'text', text: 'hi' }] }, createdAt: 1, steering: false }, links: { turn: turnRef('u1') } });
  assert.deepEqual(g.related(threadRef('t1'), 'turns').map((x) => x.ref.id).sort(), ['u1', 'u2']);
  assert.deepEqual(g.related(turnRef('u1'), 'input').map((x) => x.ref.id), ['t1:m1']);
  assert.equal(g.related(turnRef('u1'), 'thread').ref.id, 't1');
  p.remove(turnRef('u2'));
  assert.deepEqual(g.related(threadRef('t1'), 'turns').map((x) => x.ref.id), ['u1']);
  assert.equal(g.resolve(turnRef('u2')).gone, true, 'resolve says gone');
  assert.throws(() => p.update(turnRef('u1'), { links: { input: [] } }), /derived/);
});

test('store: a maybe relation derived from an inverse (Thread.draft) names the earliest Draft whose thread it is, any provider\'s thread; its change is the thread\'s; it is never written', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Draft: {} } });
  const q = g.registerProvider('mod:x', 'x', { types: { Thread: {} } });
  const theirs = { type: 'Thread', provider: 'x', id: 'x1' };
  const draft = (id) => ({ type: 'Draft', provider: P, id });
  const events = [];
  g.onEvent((e) => { if (e.ref?.id === 'x1') events.push([e.kind, e.fields ?? null, e.new?.draft?.id ?? null]); });
  q.put(theirs, { state: threadState(), links: threadLinks() });
  assert.equal(g.resolve(theirs).links.draft, undefined, 'no Draft names it yet');
  assert.equal(g.related(theirs, 'draft'), null);
  p.put(draft('pid-1'), { state: { content: { parts: [] }, dictating: false }, links: { thread: theirs, attachments: [], mentions: [] } });
  assert.equal(g.resolve(theirs).links.draft.id, 'pid-1', 'in the snapshot\'s links');
  assert.equal(g.related(theirs, 'draft').ref.id, 'pid-1');
  assert.deepEqual(events.at(-1), ['changed', ['draft'], 'pid-1'], 'a change of the thread, after the Draft\'s');
  const seen = events.length;
  p.put(draft('pid-2'), { state: { content: { parts: [] }, dictating: false }, links: { thread: theirs, attachments: [], mentions: [] } });
  assert.equal(g.related(theirs, 'draft').ref.id, 'pid-1', 'the earliest');
  assert.equal(events.length, seen, 'no change of the thread');
  p.update(draft('pid-1'), { state: { content: { parts: [{ kind: 'text', text: 'hi' }] } } });
  assert.equal(events.length, seen, 'its content is not the thread\'s');
  p.remove(draft('pid-1'));
  assert.equal(g.related(theirs, 'draft').ref.id, 'pid-2');
  assert.deepEqual(events.at(-1), ['changed', ['draft'], 'pid-2']);
  p.remove(draft('pid-2'));
  assert.equal(g.resolve(theirs).links.draft, undefined);
  assert.deepEqual(events.at(-1), ['changed', ['draft'], null]);
  // a where reads it as any relation
  p.put(draft('pid-3'), { state: { content: { parts: [{ kind: 'text', text: 'note' }] }, dictating: false }, links: { thread: theirs, attachments: [], mentions: [] } });
  assert.deepEqual(g.list('Thread', { 'draft.dictating': false }).map((t) => t.ref.id), ['x1']);
  assert.throws(() => q.update(theirs, { links: { draft: draft('pid-3') } }), /derived/, 'never written');
  // review 1: another mod's Draft linking that chat, put first, is never its draft (its own provider's or a native one only)
  p.remove(draft('pid-3'));
  const y = g.registerProvider('mod:y', 'y', { types: { Draft: {} } });
  y.put({ type: 'Draft', provider: 'y', id: 'forged' }, { state: { content: { parts: [] }, dictating: false }, links: { thread: theirs, attachments: [], mentions: [] } });
  p.put(draft('pid-4'), { state: { content: { parts: [] }, dictating: false }, links: { thread: theirs, attachments: [], mentions: [] } });
  assert.equal(g.related(theirs, 'draft').ref.id, 'pid-4');
});

test('views (H5x review 1): a relation view asked for its changes hears a derived relation\'s target enter and leave; a collection whose where reads through a relation follows what it names', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Draft: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks() });
  const draft = { type: 'Draft', provider: P, id: 't1' };
  const heard = [], members = [];
  g.subscribe({ ref: threadRef('t1'), relation: 'draft', event: ['entered', 'left'] }, (m) => { if (m.type === 'delta') heard.push([m.on, m.event.ref?.id]); });
  g.subscribe({ type: 'Thread', where: { 'draft.dictating': true }, event: ['entered', 'left'] }, (m) => { if (m.type === 'delta') members.push([m.on, m.event.ref?.id]); });
  p.put(draft, { state: { content: { parts: [] }, dictating: false }, links: { thread: threadRef('t1'), attachments: [], mentions: [] } });
  assert.deepEqual(heard, [['entered', 't1']]);
  assert.deepEqual(members, []);
  p.update(draft, { state: { dictating: true } });
  assert.deepEqual(members, [['entered', 't1']], 'its draft now dictates: the thread is in it');
  p.update(draft, { state: { dictating: false } });
  assert.deepEqual(members.at(-1), ['left', 't1']);
  p.remove(draft);
  assert.deepEqual(heard.at(-1), ['left', 't1']);
});

test('store: liveness (stale until re-read) and completeness (complete only when every provider of the concept says so)', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  p.markStale();
  assert.equal(g.resolve(threadRef('t1')).liveness, 'stale');
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  assert.equal(g.resolve(threadRef('t1')).liveness, 'live', 'a re-read makes it live');
  assert.equal(g.isComplete('Thread'), false);
  p.setComplete('Thread', true);
  assert.equal(g.isComplete('Thread'), true);
  const q = g.registerProvider('mod:cc', 'cc', { types: { Thread: {} } });
  assert.equal(g.isComplete('Thread'), false, 'a second provider has not said it is complete');
  q.setComplete('Thread', true);
  assert.equal(g.isComplete('CodexThread'), true);
});

// ------------------------------------------------------------------ invocation
function withThread(o = {}, ops = {}) {
  const g = native(o);
  const p = g.registerProvider('native', P, { types: { Thread: { operations: ops }, Turn: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  return { g, p };
}
const renameOp = (calls) => ({ rename: { effect: 'external', handler: async ({ args }) => { calls.push(args[0]); return null; } } });

test('invoke: the outcome of each refusal (no caller, unknown instance, not allowed, unsupported, unavailable, invalid)', async () => {
  const calls = [];
  const { g } = withThread({ authorize: (c) => c.id !== 'mod:nope' }, renameOp(calls));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'] })).reason, 'notAllowed');
  assert.equal((await g.invoke({ ref: threadRef('zz'), operation: 'rename', args: ['x'], caller: user })).reason, 'unavailable');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: { kind: 'mod', id: 'mod:nope' } })).reason, 'notAllowed');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'fork', args: [], caller: user })).reason, 'unsupported', 'an optional operation the provider does not declare');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'archive', args: [], caller: user })).reason, 'unavailable', 'a core operation without a handler yet');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: [42], caller: user })).reason, 'invalid');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'nope', args: [], caller: user })).reason, 'unsupported');
  assert.deepEqual(calls, []);
  const ok = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, origin: 'test' });
  assert.equal(ok.status, 'done');
  assert.deepEqual(calls, ['x']);
  assert.equal(g.can(threadRef('t1'), 'rename'), true);
  assert.equal(g.can(threadRef('t1'), 'fork'), false);
});

test('invoke: a handler that throws fails; implementing an optional operation declares the capability', async () => {
  const { g } = withThread({}, {
    rename: { effect: 'local', handler: () => { throw Object.assign(new Error('boom'), { code: 'E1' }); } },
    pin: { effect: 'local', handler: () => null },
  });
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user });
  assert.deepEqual([r.status, r.error.message, r.error.code], ['failed', 'boom', 'E1']);
  assert.ok(g.capabilities(threadRef('t1')).includes('pin'));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'pin', caller: user })).status, 'done');
});

test('invoke: interceptors run in priority order, skip the caller\'s own, can change arguments (validated and authorized again) or refuse', async () => {
  const calls = [], order = [];
  const { g } = withThread({ authorize: (c, r) => !(c.id === 'mod:weak' && r.use === 'act') }, renameOp(calls));
  g.intercept('mod:low', 'Thread', 'rename', async (c, next) => { order.push('low'); return next(); }, { priority: 1 });
  g.intercept('mod:high', 'Thread', 'rename', async (c, next) => { order.push('high'); return next({ args: [c.args[0].toUpperCase()] }); }, { priority: 5 });
  const own = g.intercept('mod:me', 'Thread', 'rename', async () => { order.push('own'); return { status: 'refused', reason: 'notAllowed' }; }, { priority: 9 });
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['abc'], caller: { kind: 'mod', id: 'mod:me', owner: 'mod:me' } });
  assert.equal(r.status, 'done');
  assert.deepEqual(order, ['high', 'low'], 'the caller\'s own interceptor is skipped');
  assert.deepEqual(calls, ['ABC']);
  own.dispose();
  g.intercept('mod:bad', 'Thread', 'rename', async (c, next) => next({ args: [7] }), { priority: 20 });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).reason, 'invalid', 'changed arguments are validated');
  // An interceptor whose grants do not cover the instance it would see is not run at all (the policy decides per call, for the
  // instance's own type: docs/design/systems.md S4): it neither changes nor refuses the call.
  const g2 = withThread({ authorize: (c) => c.id !== 'mod:weak' }, renameOp(calls)).g;
  let weakRan = false;
  g2.intercept('mod:weak', 'Thread', 'rename', async (c, next) => { weakRan = true; return next({ args: ['changed'] }); });
  assert.equal((await g2.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'done', 'the interceptor\'s own grants are checked');
  assert.equal(weakRan, false);
  assert.equal(calls.at(-1), 'x');
  const g3 = withThread({}, renameOp(calls)).g;
  g3.intercept('mod:guard', 'Thread', 'rename', async () => ({ status: 'refused', reason: 'notAllowed', message: 'policy' }));
  const refusedCall = await g3.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['secret'], caller: user });
  assert.deepEqual([refusedCall.status, refusedCall.message], ['refused', 'policy']);
});

test('invoke: an external effect is claimed in the journal before the handler runs; a replacing interceptor is claimed before it answers', async () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  let seenAtHandler = null;
  const { g } = withThread({ journalFile: file }, {
    rename: { effect: 'external', handler: async () => { seenAtHandler = fs.readFileSync(file, 'utf8'); return null; } },
    markRead: { effect: 'none', handler: async () => null },
  });
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, origin: 'test' });
  assert.ok(r.intent);
  assert.match(seenAtHandler, new RegExp(`"id":"${r.intent}","phase":"started"`), 'the started line is on disk when the handler runs');
  assert.doesNotMatch(seenAtHandler, /"x"/, 'arguments are digested, not stored');
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`"id":"${r.intent}","phase":"done"`));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'markRead', args: [], caller: user })).intent, undefined, 'no claim without an external effect');
  g.intercept('mod:r', 'Thread', 'rename', async () => ({ status: 'done', value: 'replaced' }), { replaces: true });
  const rr = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user });
  assert.deepEqual([rr.value, !!rr.intent], ['replaced', true]);
  // an answer it may not give is its failure (graph-integrity G6.6): passed over by default, the call goes on; declared `refuse`, refused
  const sneaky = g.intercept('mod:sneaky', 'Thread', 'rename', async () => ({ status: 'done', value: 'nope' }), { priority: 99 });
  const passed = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['z'], caller: user });
  assert.deepEqual([passed.status, passed.value], ['done', 'replaced']);
  sneaky.dispose();
  g.intercept('mod:strict', 'Thread', 'rename', async () => ({ status: 'done', value: 'nope' }), { priority: 99, onFailure: 'refuse' });
  const bad = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['z'], caller: user });
  assert.deepEqual([bad.status, bad.reason], ['refused', 'unavailable']);
  assert.match(bad.message, /interceptor strict answered without calling next/);
  assert.throws(() => g.intercept('mod:strict', 'Thread', 'rename', async () => undefined, { onFailure: 'maybe' }), /onFailure is 'allow' or 'refuse'/);
  g.close();
});

test('invoke R17: a mod\'s call that needs the user\'s approval asks after the interceptors and before the claim; a no refuses it', async () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  const asked = [];
  let answer = { approved: true };
  const approvals = { ask: async (q) => { asked.push(q); return answer; } };
  const calls = [];
  const { g } = withThread({ journalFile: file, approvals }, {
    rename: { effect: 'external', approval: ({ args }) => (args[0] === 'quiet' ? null : { action: `rename the thread to ${args[0]}`, detail: 'It lasts.' }), handler: async ({ args }) => { calls.push(args[0]); return null; } },
  });
  const mod = { kind: 'mod', id: 'mod.a' };
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['loud'], caller: mod });
  assert.equal(r.status, 'done');
  assert.deepEqual(asked.map(({ signal, ...q }) => q), [{ modId: 'mod.a', operation: 'Thread.rename', action: 'rename the thread to loud', detail: 'It lasts.' }]);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`"id":"${r.intent}","phase":"started".*"approvedBy":"user"`), 'the claim says who approved it');
  // The provider says this call needs none; the user and the framework are never asked.
  for (const caller of [mod, user, { kind: 'framework', id: 'framework' }]) assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: [caller === mod ? 'quiet' : 'by-user'], caller })).status, 'done');
  assert.equal(asked.length, 1);
  // A no: refused, nothing claimed, the handler not called.
  answer = { approved: false, reason: 'the user did not allow it' };
  const lines = fs.readFileSync(file, 'utf8').split('\n').length;
  const no = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['again'], caller: mod });
  assert.deepEqual([no.status, no.reason, no.message, no.intent], ['refused', 'notAllowed', 'the user\'s approval is needed: the user did not allow it', undefined]);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, lines);
  assert.deepEqual(calls, ['loud', 'quiet', 'by-user', 'by-user']);
  // An interceptor that refuses first: the user is not asked.
  g.intercept('mod:gate', 'Thread', 'rename', async () => ({ status: 'refused', reason: 'notAllowed', message: 'gate' }));
  answer = { approved: true };
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['gated'], caller: mod })).message, 'gate');
  assert.equal(asked.length, 2);
  g.close();
  // Without an approvals service nobody can be asked: refused, unavailable.
  const { g: g2 } = withThread({}, { rename: { effect: 'local', approval: () => ({ action: 'x' }), handler: async () => null } });
  assert.deepEqual(Object.values(await g2.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: mod })).slice(0, 2), ['refused', 'unavailable']);
  assert.throws(() => native().registerProvider('native', 'q', { types: { Thread: { operations: { rename: { effect: 'local', approval: 'yes', handler() {} } } } } }), /approval\(call\) is a function/);
});

test('public hooks H6 (§3.9): a mod\'s automatic action the user has on goes without asking, within its operation, bounds and rate; anything else asks', async () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  const asked = [];
  const approvals = { ask: async (q) => { asked.push(q.action); return { approved: true }; } };
  const base = { id: 'tidy', operation: 'Thread.rename', why: 'Keeps titles short', perHour: 2 };
  let decl = { ...base, where: { title: threadState().title } };
  const { g } = withThread({ journalFile: file, approvals, automaticOf: (modId, id) => (modId === 'mod.a' && id === 'tidy' ? decl : null) }, {
    rename: { effect: 'external', approval: ({ args }) => (args[0] === 'quiet' ? null : { action: `rename to ${args[0]}` }), handler: async () => null },
  });
  const mod = { kind: 'mod', id: 'mod.a' };
  const call = (name, automatic, caller = mod) => g.invoke({ ref: threadRef('t1'), operation: 'rename', args: [name], caller, automatic });
  const first = await call('a', 'tidy');
  assert.equal(first.status, 'done');
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`"id":"${first.intent}","phase":"started".*"approvedBy":"automatic:tidy"`), 'the claim names the action');
  assert.equal((await call('quiet', 'tidy')).status, 'done', 'a call that would not ask does not count');
  assert.equal((await call('b', 'tidy')).status, 'done');
  assert.deepEqual(asked, [], 'two within its rate, none asked');
  assert.equal((await call('c', 'tidy')).status, 'done');
  assert.deepEqual(asked, ['rename to c'], 'its rate used up: asked');
  // off, another mod's, another operation, outside its where or its arguments: asked
  assert.equal((await call('d', 'other')).status, 'done');
  assert.equal((await call('e', 'tidy', { kind: 'mod', id: 'mod.b' })).status, 'done');
  decl = { ...base, operation: 'Thread.archive' };
  assert.equal((await call('f', 'tidy')).status, 'done');
  decl = { ...base, where: { title: 'Something else' } };
  assert.equal((await call('g', 'tidy')).status, 'done');
  decl = { ...base, args: { 0: { length: 1 } } };
  assert.equal((await call('h', 'tidy')).status, 'done');
  assert.deepEqual(asked, ['rename to c', 'rename to d', 'rename to e', 'rename to f', 'rename to g', 'rename to h']);
  // a fresh hour, the same declaration on the instance's own type: no prompt; a mod's call naming none asks as before
  const { g: g2 } = withThread({ approvals, automaticOf: () => ({ ...base, operation: 'Thread.rename', perHour: 1 }) }, {
    rename: { effect: 'external', approval: () => ({ action: 'rename' }), handler: async () => null },
  });
  assert.equal((await g2.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: mod, automatic: 'tidy' })).status, 'done');
  assert.equal((await g2.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: mod })).status, 'done');
  assert.equal(asked.at(-1), 'rename');
  assert.equal(asked.length, 7);
  g.close(); g2.close();
});

test('invoke: a handler lost after dispatch (OutcomeUnknown) and an uncertain outcome stay uncertain, in the result and the journal (boundary review R)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  let mode = 'lost';
  const { g } = withThread({ journalFile: file }, {
    rename: { effect: 'external', handler: async () => {
      if (mode === 'lost') throw Object.assign(new Error('the realm went away after the call was dispatched'), { code: 'OutcomeUnknown' });
      return { status: 'uncertain', operation: 'rename' };
    } },
  });
  const lost = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, origin: 'test' });
  assert.equal(lost.status, 'uncertain', 'never failed: the handler may have had its effect');
  mode = 'said';
  const said = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user, origin: 'test' });
  assert.equal(said.status, 'uncertain');
  const lines = fs.readFileSync(file, 'utf8');
  for (const r of [lost, said]) {
    assert.match(lines, new RegExp(`"id":"${r.intent}","phase":"uncertain"`));
    assert.doesNotMatch(lines, new RegExp(`"id":"${r.intent}","phase":"failed"`));
  }
  assert.deepEqual(g.uncertain().map((u) => u.id).sort(), [lost.intent, said.intent].sort(), 'reported, as after a crash');
  g.close();
});

test('journal: an effect started and never finished is uncertain after a restart, reported until acknowledged, never replayed', () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  const j1 = openJournal(file);
  const a = j1.start({ operation: 'Thread.rename', ref: threadRef('t1'), caller: 'user', args: ['secret'] });
  const b = j1.start({ operation: 'Thread.rename', ref: threadRef('t2'), caller: 'user', args: [] });
  j1.finish(b, 'done');
  j1.close();
  fs.appendFileSync(file, '{"id":"torn","pha');   // a crash mid-line
  const g = createGraph({ journalFile: file });
  assert.deepEqual(g.uncertain().map((x) => x.id), [a]);
  assert.equal(g.uncertain()[0].operation, 'Thread.rename');
  assert.equal(g.acknowledge(a), true);
  g.close();
  const j3 = openJournal(file);
  assert.deepEqual(j3.uncertain(), [], 'reported once');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret/);
  j3.close();
});

// ------------------------------------------------------------------ views
test('views: a collection view gets a snapshot, then ordered deltas; a filter moves instances in and out; completeness is told', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  const got = [];
  g.subscribe({ type: 'Thread', where: { archived: false } }, (m) => { got.push(m); });
  assert.equal(got[0].type, 'snapshot');
  assert.deepEqual(got[0].items.map((x) => x.ref.id), ['t1']);
  p.put(threadRef('t2'), { state: threadState(), links: threadLinks('t2') });
  p.update(threadRef('t1'), { state: { archived: true } });
  p.setComplete('Thread', true);
  const deltas = got.filter((m) => m.type === 'delta');
  assert.deepEqual(deltas.map((d) => [d.event.ref.id, d.event.kind]), [['t2', 'added'], ['t1', 'removed']]);
  assert.ok(deltas[1].seq > deltas[0].seq && deltas[0].seq > got[0].seq);
  assert.deepEqual(got.at(-1), { type: 'complete', seq: got.at(-1).seq, complete: true });
});

test('views: a relation view follows the inverse index; an instance view follows one instance', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Turn: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  const turns = [], one = [];
  g.subscribe({ ref: threadRef('t1'), relation: 'turns' }, (m) => turns.push(m));
  g.subscribe({ ref: threadRef('t1') }, (m) => one.push(m));
  p.put(turnRef('u1'), { state: { status: 'running', startedAt: 1, startedBy: { kind: 'user' } }, links: { thread: threadRef('t1') } });
  p.update(turnRef('u1'), { state: { status: 'completed' } });
  p.update(threadRef('t1'), { state: { status: 'working' } });
  assert.deepEqual(turns.filter((m) => m.type === 'delta').map((d) => d.event.kind), ['added', 'changed']);
  assert.deepEqual(one.filter((m) => m.type === 'delta').map((d) => d.event.fields), [['status']]);
});

test('views: backpressure holds deltas until resume; an overflow sends stale and a fresh snapshot (contract rule Reconciliation)', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {} } });
  const got = [];
  let ready = true;
  const v = g.subscribe({ type: 'Thread' }, (m) => { got.push(m); return ready; }, { maxQueue: 3 });
  ready = false;
  p.put(threadRef('a'), { state: threadState(), links: threadLinks('a') });   // delivered, then the sink says "full"
  p.put(threadRef('b'), { state: threadState(), links: threadLinks('b') });   // queued
  assert.equal(v.queued, 1);
  ready = true; v.resume();
  assert.deepEqual(got.filter((m) => m.type === 'delta').map((d) => d.event.ref.id), ['a', 'b']);
  ready = false;
  for (const id of ['c', 'd', 'e', 'f', 'g']) p.put(threadRef(id), { state: threadState(), links: threadLinks(id) });
  const tail = got.slice(-2).map((m) => m.type);
  assert.deepEqual(tail, ['stale', 'snapshot']);
  assert.equal(got.at(-1).items.length, 7);
});

test('lifecycle: disposing an owner removes its providers (and their instances), its interceptors and its types', async () => {
  const g = native();
  const Deploy = defineConcept('Deploy', { state: { name: s.string() }, operations: { run: op() } });
  g.registerTypes([toDescriptor(Deploy)], 'mod:d');
  const p = g.registerProvider('mod:d', 'deploys', { types: { Deploy: { operations: { run: { effect: 'none', handler: () => 'ran' } } } } });
  p.put({ type: 'Deploy', provider: 'deploys', id: 'd1' }, { state: { name: 'one' } });
  assert.equal((await g.invoke({ ref: { type: 'Deploy', provider: 'deploys', id: 'd1' }, operation: 'run', args: [], caller: user })).value, 'ran');
  g.disposeOwner('mod:d');
  assert.equal(g.type('Deploy'), null);
  assert.throws(() => p.put({ type: 'Deploy', provider: 'deploys', id: 'd2' }, { state: { name: 'x' } }), /disposed|unknown type/);
});

test('views (H5x review 2): a collection follows a where through $any and through every hop of its relations', () => {
  const g = native();
  const p = g.registerProvider('native', P, { types: { Thread: {}, Draft: {}, Project: {} } });
  const project = { type: 'LocalProject', provider: P, id: 'p1' };
  p.put(project, { state: { name: 'Alpha', location: '/a' }, links: { folder: { type: 'Folder', provider: P, id: '/a' }, root: { type: 'Folder', provider: P, id: '/a' } } });
  p.put(threadRef('t1'), { state: threadState(), links: { ...threadLinks(), project } });
  const draft = { type: 'Draft', provider: P, id: 't1' };
  p.put(draft, { state: { content: { parts: [] }, dictating: false }, links: { thread: threadRef('t1'), attachments: [], mentions: [] } });
  const anyOf = [], twoHops = [];
  g.subscribe({ type: 'Thread', where: { draft: { $any: { dictating: true } } }, event: ['entered', 'left'] }, (m) => { if (m.type === 'delta') anyOf.push([m.on, m.event.ref?.id]); });
  g.subscribe({ type: 'Draft', where: { 'thread.project.name': 'Beta' }, event: ['entered', 'left'] }, (m) => { if (m.type === 'delta') twoHops.push([m.on, m.event.ref?.id]); });
  const listed = g.list('Thread', { draft: { $any: { dictating: true } } }).length;
  p.update(draft, { state: { dictating: true } });
  assert.deepEqual(anyOf, g.list('Thread', { draft: { $any: { dictating: true } } }).length > listed ? [['entered', 't1']] : [], 'as a fresh list says');
  p.update(project, { state: { name: 'Beta' } });
  assert.deepEqual(twoHops, [['entered', 't1']], 'its chat\'s project renamed: two hops away');
  p.update(project, { state: { name: 'Gamma' } });
  assert.deepEqual(twoHops.at(-1), ['left', 't1']);
});

test('public hooks F11: a usage window crossing a threshold is a view\'s entered, on the source\'s own percent; left when it resets', async () => {
  const g = createGraph();
  g.registerTypes(NATIVE, 'native');
  const p = g.registerProvider('native', 'unit.p', { types: { Account: {}, CodexUsage: {} } });
  const A = { type: 'Account', provider: 'unit.p', id: 'a' }, U = { type: 'CodexUsage', provider: 'unit.p', id: 'u' };
  // the server's snapshot as given (graph-integrity G1.2): a mod's view reads its window's usedPercent; the framework computes nothing
  const usage = (usedPercent) => ({ state: { snapshots: { codex: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300 } } } }, links: { account: A } });
  await p.put(A, { state: { service: 'Unit', name: 'Unit', signedIn: true }, links: { usage: U } });
  await p.put(U, usage(70));
  const heard = [];
  g.subscribe({ type: 'CodexUsage', where: { 'snapshots.codex.primary.usedPercent': { $gte: 80 } }, event: ['entered', 'left'] }, (m) => { if (m.type === 'delta') heard.push([m.on, m.event.ref?.id]); });
  await p.put(U, usage(82));
  await p.put(U, usage(90));
  await p.put(U, usage(2));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard, [['entered', 'u'], ['left', 'u']], 'crossed once (82%), then reset');
  g.close();
});

test('graph-integrity G6.2, G6.3: an interceptor stops a call (stopped, its mod named, recorded, an event); only an interceptor can; a mod\'s key is in the journal with what the call made', async () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  const madeRef = { type: 'Thread', provider: 'unit', id: 't9' };
  let keyAtHandler = null;
  const { g } = withThread({ journalFile: file }, {
    rename: { effect: 'external', handler: async ({ key }) => { keyAtHandler = key ?? null; return madeRef; } },
    markRead: { effect: 'none', handler: async () => ({ status: 'stopped' }) },
  });
  const mod = { kind: 'mod', id: 'later', owner: 'mod:later' };
  const ops = [];
  g.onOperation((e) => ops.push([e.operation, e.status]));
  const events = [];
  g.subscribe({ ref: threadRef('t1') }, (m) => { if (m.type === 'delta' && m.event?.kind === 'event') events.push(m.event.name); return true; });
  // a handler's stop is not one
  const h = await g.invoke({ ref: threadRef('t1'), operation: 'markRead', args: [], caller: user });
  assert.deepEqual([h.status, h.error.code], ['failed', 'notInterceptor']);
  // a key: given to the handler, in the journal, looked up with what the call made
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: mod, key: 'send-42' });
  assert.equal(r.status, 'done');
  assert.equal(keyAtHandler, 'send-42');
  assert.deepEqual(g.made('mod:later', 'send-42'), { status: 'done', made: madeRef, at: g.made('mod:later', 'send-42').at });
  assert.equal(g.made('mod:other', 'send-42'), null, 'a key is its caller\'s own');
  assert.match(fs.readFileSync(file, 'utf8'), /"key":"send-42"/);
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: mod, key: 'no spaces' })).reason, 'invalid');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, key: 'k' })).reason, 'invalid', 'a mod\'s call only');
  // an interceptor's stop: nothing happens, nothing failed, its mod named; the journal says stopped; the subject's event
  keyAtHandler = 'untouched';
  g.intercept('mod:usage', 'Thread', 'rename', async () => ({ status: 'stopped', message: 'later' }));
  const s1 = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: mod, key: 'send-43' });
  assert.deepEqual([s1.status, s1.by, s1.message, keyAtHandler], ['stopped', { kind: 'mod', id: 'usage' }, 'later', 'untouched']);
  assert.equal(g.made('mod:later', 'send-43'), null, 'nothing was claimed: it never got to the handler');
  await new Promise((res) => setImmediate(res));
  assert.ok(events.includes('operationStopped'));
  assert.deepEqual(ops.slice(-1), [['rename', 'stopped']]);
  // past its next() a stop is not one: what happened is the outcome
  const g2 = withThread({}, { rename: { effect: 'none', handler: async () => 'renamed' } }).g;
  g2.intercept('mod:liar', 'Thread', 'rename', async (c, next) => { await next(); return { status: 'stopped' }; });
  assert.deepEqual(await g2.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['z'], caller: user }).then((o) => [o.status, o.value]), ['done', 'renamed']);
  g.close(); g2.close();
});

test('the journal: a key\'s call by its caller across a restart; one left open by a crash is uncertain', () => {
  const dir = tmp();
  const file = path.join(dir, 'intents.jsonl');
  const j1 = openJournal(file, { fsync: false });
  const a = j1.start({ operation: 'Thread.send', caller: 'later', args: [], key: 'k1' });
  j1.finish(a, 'done', null, { type: 'Turn', provider: 'codex', id: 'u1' });
  j1.start({ operation: 'Thread.send', caller: 'later', args: [], key: 'k2' });   // the crash comes before its outcome
  assert.deepEqual(j1.byKey('later', 'k2').status, 'started');
  j1.close();
  const j2 = openJournal(file, { fsync: false });
  assert.deepEqual([j2.byKey('later', 'k1').status, j2.byKey('later', 'k1').made], ['done', { type: 'Turn', provider: 'codex', id: 'u1' }]);
  assert.equal(j2.byKey('later', 'k2').status, 'uncertain');
  assert.equal(j2.byKey('other', 'k1'), null);
  j2.close();
});

test('graph-integrity G9.3: a provider declares what it realizes that no check has shown (unverified, along the type chain): an assessment says so; an unknown member or type is refused', () => {
  const g = native();
  assert.throws(() => g.registerProvider('native', 'x1', { types: { CodexThread: {} }, unverified: { CodexThread: ['nosuch'] } }), /CodexThread has no member nosuch/);
  assert.throws(() => g.registerProvider('native', 'x2', { types: { CodexThread: {} }, unverified: { Nope: ['rename'] } }), /unknown type Nope/);
  assert.throws(() => g.registerProvider('native', 'x3', { types: { CodexThread: {} }, unverified: ['rename'] }), /unverified is \{type: \[member names\]\}/);
  const p = g.registerProvider('native', P, {
    types: { CodexThread: { operations: { rename: { effect: 'local', handler: () => null }, archive: { effect: 'local', handler: () => null } } }, CodexAgent: {} },
    unverified: { Thread: ['rename', 'titleChanged'] },
  });
  p.put({ type: 'CodexAgent', provider: P, id: 'codex' }, { state: { name: 'Codex', icon: 'codex', available: true } });
  p.put(threadRef('a'), { state: threadState(), links: threadLinks() });
  assert.deepEqual(g.unverifiedOf(threadRef('a')).sort(), ['rename', 'titleChanged'], 'declared on Thread, read on a CodexThread');
  assert.deepEqual(g.assess({ ref: threadRef('a'), operation: 'rename', args: ['x'], caller: user }), { status: 'allowed', unverified: true });
  assert.deepEqual(g.assess({ ref: threadRef('a'), operation: 'archive', args: [], caller: user }), { status: 'allowed' });
  assert.equal(g.can(threadRef('a'), 'rename'), true, 'a mod may still call it: only the framework\'s own surfaces hold back');
});
