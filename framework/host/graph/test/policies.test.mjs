// The mods' policies (docs/design/public-hooks.md §3.7): checked and compiled; their schedule, origin and wheres; the graph's gate on
// every call (a mod's, the user's own action held from the app), the user's switch, the declaring mod bound too, assess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, inSchedule, originMatches, rewriteArgs } from '../policies.mjs';
import { createGraph } from '../index.mjs';
import { createPresentNs } from '../../ctx/present.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const P = 'codex';
const threadRef = (id) => ({ type: 'CodexThread', provider: P, id });
const threadState = (over = {}) => ({ title: 'T', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1, ...over });
const threadLinks = () => ({ agent: { type: 'CodexAgent', provider: P, id: 'codex' } });
const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });
const throwsInvalid = (fn, re) => assert.throws(fn, (e) => { assert.equal(e.code, 'Invalid'); assert.match(e.message, re); return true; });

function setup(o = {}) {
  const g = createGraph(o);
  g.registerTypes(NATIVE, 'native');
  const calls = [];
  const p = g.registerProvider('native', P, { types: { Thread: { operations: {
    rename: { effect: 'external', approval: ({ args }) => (args[0] === 'loud' ? { action: `rename to ${args[0]}` } : null), handler: async ({ args, caller }) => { calls.push([args[0], caller.id]); return null; } },
  } }, Turn: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  return { g, p, calls };
}

test('compilePolicy: what a policy is, path by path', () => {
  const typeOf = (id) => (id === 'Thread' ? { members: { operations: new Map([['rename', {}]]) } } : null);
  const ok = { id: 'no-rename', title: 'No renames at night', on: { type: 'Thread', operation: 'rename' }, then: { refuse: 'Not now' } };
  assert.equal(compilePolicy(ok, typeOf).id, 'no-rename');
  for (const [over, re] of [
    [{ id: 'Bad' }, /^id/], [{ title: '' }, /^title/], [{ on: { type: 'Nope', operation: 'rename' } }, /not a type/], [{ on: { type: 'Thread', operation: 'fly' } }, /no operation/],
    [{ on: { request: 'CommandApproval' } }, /not a request type/], [{ then: { answer: { approve: 'once' } } }, /request policy/], [{ where: { title: { $nope: 1 } } }, /^where/], [{ args: { first: {} } }, /argument index/],
    [{ origin: 'robot' }, /^origin/], [{ schedule: { between: ['9:00', '17:00'] } }, /schedule\.between/], [{ schedule: { between: ['09:00', '17:00'], days: ['someday'] } }, /someday/],
    [{ unknown: 'maybe' }, /^unknown/], [{ then: { refuse: '' } }, /then\.refuse/], [{ then: { ask: { title: '' } } }, /then\.ask\.title/],
    [{ then: { rewrite: {} } }, /rewrite is \{args/], [{ then: { refuse: 'x', ask: { title: 'y' } } }, /^then is one of/], [{ extra: 1 }, /extra is not a field/],
  ]) throwsInvalid(() => compilePolicy({ ...ok, ...over }, typeOf), re);
});

test('a schedule\'s hours and days (past midnight it belongs to the day it started); origins; the framework is never bound', () => {
  const at = (day, hh, mm = 0) => new Date(2026, 9, 25 + day, hh, mm);   // 2026-10-25 is a Sunday
  const nine = compilePolicy({ id: 'a', title: 'a', on: { type: 'Thread', operation: 'rename' }, schedule: { between: ['09:00', '17:00'], days: ['mon', 'tue'] }, then: { refuse: 'x' } },
    () => ({ members: { operations: new Map([['rename', {}]]) } })).schedule;
  assert.deepEqual([inSchedule(nine, at(1, 9)), inSchedule(nine, at(1, 16, 59)), inSchedule(nine, at(1, 17)), inSchedule(nine, at(0, 12))], [true, true, false, false]);
  const night = { from: 22 * 60, to: 6 * 60, days: new Set([5]) };   // Friday night
  assert.deepEqual([inSchedule(night, at(5, 23)), inSchedule(night, at(6, 5)), inSchedule(night, at(6, 23)), inSchedule(night, at(5, 7))], [true, true, false, false]);
  assert.deepEqual(['user', 'mod', 'any'].map((o) => originMatches(o, user)), [true, false, true]);
  assert.deepEqual(['any', 'mod'].map((o) => originMatches(o, { kind: 'framework', id: 'framework' })), [false, false]);
});

test('the graph\'s gate: a refusing policy binds the user, other mods and its own mod, never the framework; it says the policy; the user\'s switch; dispose', async () => {
  const off = new Set();
  const { g, p, calls } = setup({ policyOff: (owner, id) => off.has(`${owner}/${id}`) });
  const h = g.policy('mod:p.guard', { id: 'keep-t', title: 'Keep the title T', on: { type: 'Thread', operation: 'rename' }, where: { title: 'T' }, then: { refuse: 'This chat keeps its name' } });
  assert.equal(g.intercepted('CodexThread', 'rename'), true, 'a policy holds the app\'s own action too');
  const rename = (caller, name = 'x') => g.invoke({ ref: threadRef('t1'), operation: 'rename', args: [name], caller });
  for (const caller of [user, mod('other'), mod('p.guard')]) {
    const out = await rename(caller);
    assert.deepEqual([out.status, out.reason, out.message, out.by], ['refused', 'notAllowed', 'This chat keeps its name (“Keep the title T”, a policy of p.guard)', { mod: 'p.guard', policy: 'keep-t' }], caller.id);
  }
  assert.equal((await rename({ kind: 'framework', id: 'framework' })).status, 'done', 'the framework is never bound');
  assert.deepEqual(g.policiesOf('mod:p.guard').map((x) => [x.id, x.on]), [['keep-t', true]]);
  off.add('mod:p.guard/keep-t');
  assert.equal((await rename(user, 'T')).status, 'done', 'turned off by the user');
  assert.deepEqual(g.policiesOf('mod:p.guard').map((x) => x.on), [false]);
  off.clear();
  p.update(threadRef('t1'), { state: { title: 'Other' } });
  assert.equal((await rename(user)).status, 'done', 'the title is no longer T: outside its where');
  h.dispose();
  assert.equal(g.intercepted('CodexThread', 'rename'), false);
  assert.deepEqual(calls.map(([n, c]) => [n, c]), [['x', 'framework'], ['T', 'user'], ['x', 'user']]);
  // a mod's own outcome cannot claim to be a policy
  g.intercept('mod:faker', 'Thread', 'rename', async () => ({ status: 'refused', reason: 'notAllowed', message: 'm', by: { mod: 'p.guard', policy: 'keep-t' } }));
  assert.equal((await rename(user)).by, undefined);
});

test('an asking policy asks the user in its own words (no "don\'t ask again"); origin, args, unknown and a policy that faults; disposeOwner', async () => {
  const asked = [];
  let yes = true;
  const { g, p, calls } = setup({ approvals: { ask: async (q) => { asked.push(q); return yes ? { approved: true } : { approved: false, reason: 'the user did not allow it' }; } } });
  g.policy('mod:p.ask', { id: 'confirm', title: 'Confirm renames', on: { type: 'Thread', operation: 'rename' }, origin: 'user', args: { 0: { length: { $exists: false } } },
    then: { ask: { title: 'Rename this chat?', message: 'A team rule asks first.' } } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['a'], caller: user })).status, 'done');
  assert.deepEqual(asked.map((q) => [q.modId, q.operation, q.policy]), [['p.ask', 'policy:confirm', { title: 'Rename this chat?', message: 'A team rule asks first.', name: 'Confirm renames' }]]);
  yes = false;
  const no = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['b'], caller: user });
  assert.deepEqual([no.status, no.message], ['refused', 'not confirmed: the user did not allow it (“Confirm renames”, a policy of p.ask)']);
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['c'], caller: mod('m') })).status, 'done', 'origin user: a mod\'s call is not asked');
  assert.equal(asked.length, 2);
  // a where on a relation not loaded: unknown refuses by default, `allow` lets it through
  g.policy('mod:p.rel', { id: 'by-project', title: 'Only in project X', on: { type: 'Thread', operation: 'rename' }, where: { 'project.name': 'X' }, then: { refuse: 'Not here' } });
  p.update(threadRef('t1'), { links: { project: { type: 'LocalProject', provider: P, id: 'gone' } } });
  assert.match((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['d'], caller: mod('m') })).message, /Not here/);
  g.policy('mod:p.rel', { id: 'by-project', title: 'Only in project X', on: { type: 'Thread', operation: 'rename' }, where: { 'project.name': 'X' }, unknown: 'allow', then: { refuse: 'Not here' } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['e'], caller: mod('m') })).status, 'done', 'registered again: replaced');
  g.disposeOwner('mod:p.rel');
  g.disposeOwner('mod:p.ask');
  assert.equal(g.intercepted('CodexThread', 'rename'), false);
  assert.deepEqual(calls.map(([n]) => n), ['a', 'c', 'e']);
});

test('the user\'s own action held from the app passes the policies: refused before it goes on, or forwarded', async () => {
  const { g } = setup();
  g.policy('mod:p.app', { id: 'no-x', title: 'Never x', on: { type: 'Thread', operation: 'rename' }, where: { title: 'Something else' }, then: { refuse: 'No' } });
  const forwarded = [];
  const out = await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user }, async (args) => { forwarded.push(args); return null; });
  assert.equal(out.decision, 'forwarded', 'outside its where: the action goes on');
  g.policy('mod:p.app', { id: 'no-x', title: 'Never x', on: { type: 'Thread', operation: 'rename' }, where: { title: 'T' }, then: { refuse: 'No' } });
  const held = await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user }, async (args) => { forwarded.push(args); return null; });
  assert.deepEqual([held.decision, held.outcome.message, held.outcome.by], ['refuse', 'No (“Never x”, a policy of p.app)', { mod: 'p.app', policy: 'no-x' }]);
  assert.deepEqual(forwarded, [['x']]);
});

test('assess: what a call would meet, without running anything: allowed, refused by a policy, asks, needs consent (or an automatic action), unsupported, unknown', async () => {
  const { g, calls } = setup({ approvals: { ask: async () => ({ approved: true }) }, automaticOf: (m, id) => (id === 'loud-ok' ? { id, operation: 'Thread.rename', why: 'w', perHour: 1 } : null) });
  const a = (args, caller = mod('m'), automatic = null) => g.assess({ ref: threadRef('t1'), operation: 'rename', args, caller, automatic });
  assert.deepEqual(a(['x']), { status: 'allowed' });
  assert.deepEqual(a(['loud']), { status: 'needsConsent', reason: 'rename to loud' });
  assert.deepEqual([a(['loud'], mod('m'), 'loud-ok').status, a(['loud'], mod('m'), 'loud-ok').status], ['allowed', 'allowed'], 'assessing never uses its rate');
  assert.deepEqual(a(['loud'], user), { status: 'allowed' });
  const h = g.policy('mod:p.a', { id: 'ask', title: 'Ask', on: { type: 'Thread', operation: 'rename' }, then: { ask: { title: 'Sure?' } } });
  assert.deepEqual(a(['x']), { status: 'asks', reason: 'Sure?', by: { mod: 'p.a', policy: 'ask' } });
  h.dispose();
  g.policy('mod:p.a', { id: 'no', title: 'No', on: { type: 'Thread', operation: 'rename' }, then: { refuse: 'Never' } });
  assert.deepEqual(a(['x']), { status: 'refused', reason: 'Never', by: { mod: 'p.a', policy: 'no' } });
  assert.equal(g.assess({ ref: threadRef('t1'), operation: 'fork', args: [], caller: user }).status, 'unsupported');
  assert.equal(g.assess({ ref: threadRef('zz'), operation: 'rename', args: ['x'], caller: user }).status, 'unknown');
  assert.equal(a([42]).status, 'refused');
  assert.deepEqual(calls, [], 'nothing ran');
});

test('request policies (on: {request}): checked; they answer first, as their mod (its automatic action, else asked; a decline needs none), with the request\'s own option; then the ask interceptors; a guess never approves', async () => {
  const asked = [];
  const g = createGraph({ approvals: { ask: async (q) => { asked.push(q.action ?? q.policy?.title); return { approved: true }; } },
    automaticOf: (modId, id) => (modId === 'p.req' && id === 'reads' ? { id, operation: 'Approval.answer', why: 'w', perHour: 5 } : null) });
  g.registerTypes(NATIVE, 'native');
  const calls = [];
  // the provider's options (graph-integrity G1.6): a decline asks no one, an approval asks for the mod's call
  const OPTIONS = [{ id: 'yes', label: 'Allow once', kind: 'approve', scope: 'once' }, { id: 'chat', label: 'Allow for the chat', kind: 'approve', scope: 'thread' }, { id: 'no', label: 'Deny', kind: 'deny' }];
  const p = g.registerProvider('native', P, { types: {
    Request: { operations: { ask: { effect: 'local', handler: () => { calls.push(['shown']); return null; } } } },
    Approval: { operations: { answer: { effect: 'external',
      approval: ({ caller, args: [id] }) => (OPTIONS.find((o) => o.id === id)?.kind === 'approve' ? { action: `approve ${id} as ${caller.id}` } : null),
      handler: ({ args, caller }) => { calls.push(['answer', args, caller.id]); return null; } } } },
  } });
  const links = { thread: threadRef('t1'), turn: { type: 'Turn', provider: P, id: 'u' } };
  const cmd = (id, command, over = {}) => { const r = { type: 'CommandApproval', provider: P, id }; p.put(r, { state: { status: 'pending', from: 'agent', askedAt: 1, options: OPTIONS, command, directory: '/r', ...over }, links }); return r; };
  const ask = (ref) => g.invoke({ ref, operation: 'ask', args: [], caller: { kind: 'native', id: P } });
  throwsInvalid(() => g.policy('mod:p.req', { id: 'x', title: 'x', on: { request: 'Thread' }, then: { answer: { approve: 'once' } } }), /not a request type/);
  throwsInvalid(() => g.policy('mod:p.req', { id: 'x', title: 'x', on: { request: 'CommandApproval' }, then: { answer: { approve: 'always' } } }), /always/);
  throwsInvalid(() => g.policy('mod:p.req', { id: 'x', title: 'x', on: { request: 'CommandApproval' }, then: { answer: { deny: 'a reason' } } }), /deny is true/);
  throwsInvalid(() => g.policy('mod:p.req', { id: 'x', title: 'x', on: { request: 'CommandApproval' }, then: { refuse: 'no' } }), /then is \{answer/);
  g.policy('mod:p.req', { id: 'reads', title: 'Approve reads', on: { request: 'CommandApproval' }, where: { display: 'ls -la' }, then: { answer: { approve: 'once' } }, automatic: 'reads' });
  g.policy('mod:p.req', { id: 'no-rm', title: 'Never rm', on: { request: 'CommandApproval' }, where: { command: { $prefix: 'rm ' } }, then: { answer: { deny: true } } });
  g.policy('mod:p.req', { id: 'touch', title: 'Approve touch', on: { request: 'CommandApproval' }, where: { command: { $prefix: 'touch ' } }, then: { answer: { approve: 'thread' } } });
  g.policy('mod:p.req', { id: 'guess', title: 'By project', on: { request: 'CommandApproval' }, where: { 'thread.project.name': 'X' }, then: { answer: { approve: 'once' } } });
  assert.equal(g.intercepted('CommandApproval', 'ask'), true, 'held because a policy would answer it');
  const seen = [];
  g.intercept('mod:p.ic', 'Approval', 'ask', async (call, next) => { seen.push(call.instance.state.command); return next(); });
  assert.equal((await ask(cmd('c1', 'ls -la', { display: 'ls -la' }))).status, 'done');
  assert.equal((await ask(cmd('c2', 'rm -rf x'))).status, 'done');
  assert.equal((await ask(cmd('c3', 'touch y'))).status, 'done');
  assert.equal((await ask(cmd('c4', 'echo hi'))).status, 'done');
  assert.deepEqual(calls, [['answer', ['yes'], 'p.req'], ['answer', ['no'], 'p.req'], ['answer', ['chat'], 'p.req'], ['shown']]);
  assert.deepEqual(asked, ['approve chat as p.req'], 'the automatic action went without asking, the decline needs none, the touch approval asked');
  assert.deepEqual(seen, ['echo hi'], 'answered requests never reach the ask interceptors');
  g.close();
});

test('the page\'s hold of the user\'s own action (a card\'s answer): go with the arguments it ended with and who changed them, or not with the reason, or handled; the record says what it did; the framework\'s alone', async () => {
  const { g } = setup();
  const ns = createPresentNs({ graph: () => g });
  const fw = { state: { framework: true } };
  const ops = [];
  g.onOperation((e) => ops.push(e));
  const plain = ({ token, ...rest }) => { assert.equal(typeof token, 'string'); return rest; };
  const h0 = await ns.calls.hold(fw, threadRef('t1'), 'rename', ['x']);
  assert.deepEqual(plain(h0), { go: true, args: ['x'] }, 'nothing holds it: go');
  assert.equal(ns.calls.done(fw, h0.token, { status: 'done' }), true);
  assert.equal(ops.length, 1, 'let through unheld: recorded as observed once it went');
  g.policy('mod:p.page', { id: 'no', title: 'No renames here', on: { type: 'Thread', operation: 'rename' }, origin: 'user', then: { refuse: 'Not from the card' } });
  assert.deepEqual(await ns.calls.hold(fw, threadRef('t1'), 'rename', ['x']), { go: false, message: 'Not from the card (“No renames here”, a policy of p.page)' });
  g.intercept('mod:p.change', 'Thread', 'rename', (call, next) => next({ args: ['changed'] }));
  g.disposeOwner('mod:p.page');
  assert.deepEqual(await ns.calls.hold(fw, threadRef('t1'), 'rename', ['x'], { changes: false }), { go: false, message: 'p.change would change it, and a change cannot be carried out here' });
  const h = await ns.calls.hold(fw, threadRef('t1'), 'rename', ['x']);
  assert.deepEqual(plain(h), { go: true, args: ['changed'], changedBy: [{ mod: 'p.change' }] });
  const before = ops.length;
  ns.calls.done(fw, h.token, { status: 'failed', error: { message: 'the card went' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([ops.length - before, ops.at(-1).outcome.status, ops.at(-1).effectiveArgs], [1, 'failed', ['changed']], 'the record says what the app\'s own action did');
  g.disposeOwner('mod:p.change');
  g.intercept('mod:p.do', 'Thread', 'rename', async () => ({ status: 'done', value: null }), { replaces: true });
  assert.deepEqual(await ns.calls.hold(fw, threadRef('t1'), 'rename', ['x']), { go: false, handled: true }, 'a mod did it in the app\'s place');
  await assert.rejects(() => ns.calls.hold({ state: { id: 'some.mod' } }, threadRef('t1'), 'rename', ['x']), /framework's own/);
  assert.deepEqual(plain(await ns.calls.hold(fw, threadRef('zz'), 'rename', ['x'])), { go: true, args: ['x'] }, 'an instance not known: go');
});

test('H6m4: a page hold names a repository by the folder it acts in (`{type: \'Repository\', cwd}`): the Host lists it (requests.pageRef); one it cannot list goes on', async () => {
  const { g } = setup();
  const listed = (ref) => (ref?.type === 'Repository' ? (ref.cwd === '/repo' ? threadRef('t1') : null) : ref);
  const ns = createPresentNs({ graph: () => g, requests: () => ({ pageRef: listed }) });
  const fw = { state: { framework: true } };
  g.policy('mod:p.page', { id: 'no', title: 'No renames here', on: { type: 'Thread', operation: 'rename' }, origin: 'user', then: { refuse: 'Not from the panel' } });
  assert.deepEqual(await ns.calls.hold(fw, { type: 'Repository', cwd: '/repo' }, 'rename', ['x']), { go: false, message: 'Not from the panel (“No renames here”, a policy of p.page)' }, 'listed: decided on its instance');
  const plain = ({ token, ...rest }) => rest;
  assert.deepEqual(plain(await ns.calls.hold(fw, { type: 'Repository', cwd: '/elsewhere' }, 'rename', ['x'])), { go: true, args: ['x'] }, 'not listed: goes on');
  const bare = createPresentNs({ graph: () => g });
  assert.deepEqual(plain(await bare.calls.hold(fw, { type: 'Repository', cwd: '/repo' }, 'rename', ['x'])), { go: true, args: ['x'] }, 'no resolver: a folder names nothing');
  g.close();
});

test('H7pc review: the user\'s click on a mod\'s Account control the framework draws is the user\'s act (interceptors and policies see the user); only those controls, never Codex\'s', async () => {
  const { g } = setup();
  const ns = createPresentNs({ graph: () => g });
  const fw = { state: { framework: true } };
  const did = [];
  const acc = g.registerProvider('mod:unit.acc', 'unit.acc', { types: { Account: { operations: {
    signIn: { effect: 'external', handler: async ({ caller }) => { did.push(['signIn', caller.kind]); return null; } },
    signOut: { effect: 'external', handler: async ({ caller }) => { did.push(['signOut', caller.kind]); return null; } },
  } } } });
  const A = { type: 'Account', provider: 'unit.acc', id: 'a1' };
  await acc.put(A, { state: { service: 'Unit', name: 'Unit account', signedIn: true }, links: {} });
  const seen = [];
  g.intercept('mod:p.watch', 'Account', 'signOut', (call, next) => { seen.push(call.caller.kind); return next(); });
  assert.equal((await ns.calls.userAct(fw, A, 'signOut')).status, 'done');
  assert.deepEqual([did, seen], [[['signOut', 'user']], ['user']], 'as the user, through the interceptors');
  g.policy('mod:p.guard', { id: 'stay', title: 'Stay signed in', on: { type: 'Account', operation: 'signOut' }, origin: 'user', then: { refuse: 'Not now' } });
  const no = await ns.calls.userAct(fw, A, 'signOut');
  assert.deepEqual([no.status, did.length], ['refused', 1], 'a policy on the user\'s acts holds it');
  for (const [ref, op] of [[A, 'manage'], [A, 'delete'], [threadRef('t1'), 'rename'], [{ type: 'Account', provider: 'unit.acc', id: 'gone' }, 'signIn']]) {
    assert.equal((await ns.calls.userAct(fw, ref, op)).status, 'refused', `${ref.type}.${op}`);
  }
  await assert.rejects(() => ns.calls.userAct({ state: { id: 'some.mod' } }, A, 'signIn'), /framework's own/);
  assert.equal(did.length, 1);
  g.close();
});

test('GI2b: the user\'s act on a chat the app does not hold, from the row or the view the framework draws for it, is the user\'s; Codex\'s own chats are the app\'s to act on', async () => {
  const { g } = setup();
  const ns = createPresentNs({ graph: () => g });
  const fw = { state: { framework: true } };
  const did = [];
  const op = (name) => ({ effect: 'local', handler: async ({ caller }) => { did.push([name, caller.kind]); return null; } });
  const p = g.registerProvider('mod:unit.agent', 'unit.agent', { types: { Agent: {}, Thread: { operations: Object.fromEntries(['archive', 'restore', 'markRead', 'rename', 'send'].map((n) => [n, op(n)])) } } });
  const agent = { type: 'Agent', provider: 'unit.agent', id: 'a' };
  await p.put(agent, { state: { name: 'Unit agent', icon: 'sparkle', available: true }, links: {} });
  const T = { type: 'Thread', provider: 'unit.agent', id: 'c1' };
  await p.put(T, { state: threadState({ title: 'Theirs', unread: true }), links: { agent } });
  assert.equal((await ns.calls.userAct(fw, T, 'markRead')).status, 'done');
  assert.equal((await ns.calls.userAct(fw, T, 'archive')).status, 'done');
  assert.deepEqual(did, [['markRead', 'user'], ['archive', 'user']]);
  for (const name of ['rename', 'send']) assert.equal((await ns.calls.userAct(fw, T, name)).status, 'refused', `${name}: no control the framework draws`);
  assert.equal((await ns.calls.userAct(fw, threadRef('t1'), 'archive')).status, 'refused', 'the app\'s own chat: the app acts on it');
  g.close();
});

test('rewriting policies (then.rewrite): checked; paths set and content added; in the user\'s order with the interceptors; the changed call is its mod\'s (its grant, R17 or its automatic action); a refusal still sees the call it came as', async () => {
  const typeOf = () => ({ members: { operations: new Map([['send', {}]]) } });
  const base = { id: 'r', title: 'R', on: { type: 'Thread', operation: 'send' } };
  for (const [then, re] of [[{ rewrite: {} }, /rewrite is/], [{ rewrite: { args: { x: 1 } } }, /not a path/], [{ rewrite: { prepend: 'hi' } }, /prepend is content/], [{ rewrite: { args: { '1.a': 1 }, nope: 1 } }, /rewrite is/]]) throwsInvalid(() => compilePolicy({ ...base, then }, typeOf), re);
  const rw = compilePolicy({ ...base, then: { rewrite: { args: { '1.settings.effort': 'low' }, prepend: { parts: [{ kind: 'text', text: 'Note: ' }] }, append: { parts: [{ kind: 'text', text: ' (sent by QA)' }] } } } }, typeOf).then.rewrite;
  assert.deepEqual(rewriteArgs(rw, [{ parts: [{ kind: 'text', text: 'hi' }] }]), [{ parts: [{ kind: 'text', text: 'Note: ' }, { kind: 'text', text: 'hi' }, { kind: 'text', text: ' (sent by QA)' }] }, { settings: { effort: 'low' } }]);
  assert.equal(rewriteArgs(compilePolicy({ ...base, then: { rewrite: { append: { parts: [{ kind: 'text', text: 'x' }] } } } }, typeOf).then.rewrite, ['no content']), null, 'no content to add to: nothing applies');
  // through the graph: the user's rename rewritten to a name that needs the mod's consent; refusals see both calls
  const asked = [];
  const grants = new Set(['mod:p.rw']);
  const order = { 'p.rw': 1, 'p.ic': 2, 'p.late': 3 };   // the user's order of the mods (E6)
  const { g, calls } = setup({ authorize: (c, req) => c.kind !== 'mod' || req.use !== 'act' || grants.has(c.owner ?? `mod:${c.id}`), approvals: { ask: async (q) => { asked.push([q.modId, q.action]); return { approved: true }; } },
    rankOf: (id) => order[id] });
  const seen = [], late = [];
  g.intercept('mod:p.ic', 'Thread', 'rename', (call, next) => { seen.push(call.args[0]); return next(); });
  g.intercept('mod:p.late', 'Thread', 'rename', (call, next) => { late.push(call.args[0]); return next(); }, { priority: 50 });
  g.policy('mod:p.rw', { id: 'loud', title: 'Make it loud', on: { type: 'Thread', operation: 'rename' }, origin: 'user', then: { rewrite: { args: { 0: 'loud' } } } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['quiet'], caller: user })).status, 'done');
  assert.deepEqual([seen, late, calls.at(-1), asked], [['loud'], ['loud'], ['loud', 'user'], [['p.rw', 'rename to loud']]], 'the interceptors after it in the user\'s order see the rewritten call (a priority orders within a mod); the mod is asked about it; the call stays the user\'s');
  order['p.rw'] = 4;
  seen.length = 0;
  await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['quiet'], caller: user });
  assert.deepEqual([seen, calls.at(-1)], [['quiet'], ['loud', 'user']], 'moved after them by the user: they see the call as it came');
  const ops = [];
  g.onOperation((e) => ops.push(e));
  g.policy('mod:p.no', { id: 'no-quiet', title: 'Never quiet', on: { type: 'Thread', operation: 'rename' }, args: { 0: { $eq: 'quiet' } }, then: { refuse: 'Not quiet' } });
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['quiet'], caller: user });
  assert.match(r.message ?? '', /Not quiet/, 'a rewrite cannot slip past a refusal of the call it came as');
  g.disposeOwner('mod:p.no');
  grants.clear();
  const no = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['quiet'], caller: user });
  assert.deepEqual([no.status, no.reason], ['refused', 'notAllowed'], 'its mod may not make the call: refused');
  grants.add('mod:p.rw');
  await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['quiet'], caller: user });
  assert.deepEqual([ops.at(-1).args, ops.at(-1).effectiveArgs, ops.at(-1).changedBy], [['quiet'], ['loud'], 'mod:p.rw']);
});

test('review 2026-11-05 #3: a rewriting policy\'s change is refereed by the provider as an interceptor\'s is: what is not its mod\'s to change is refused', async () => {
  const g = createGraph();
  g.registerTypes(NATIVE, 'native');
  const calls = [];
  // the provider's referee: a chat's name may not be made an admin's by anyone but the user
  const change = ({ after, by }) => (String(after[0]).startsWith('admin') && by.kind === 'mod' ? `only the user names a chat ${after[0]}` : null);
  const p = g.registerProvider('native', P, { types: { Thread: { operations: {
    rename: { effect: 'local', change, handler: async ({ args }) => { calls.push(args[0]); return null; } },
  } }, Turn: {} } });
  p.put(threadRef('t1'), { state: threadState(), links: threadLinks('t1') });
  g.policy('mod:p.rw', { id: 'admin', title: 'Make it admin', on: { type: 'Thread', operation: 'rename' }, then: { rewrite: { args: { 0: 'admin-x' } } } });
  const out = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['notes'], caller: user });
  assert.deepEqual([out.status, out.reason], ['refused', 'notAllowed']);
  assert.match(out.message, /Make it admin.*only the user names a chat admin-x/);
  assert.deepEqual(calls, [], 'nothing ran');
  // an interceptor's same change, as before
  g.disposeOwner('mod:p.rw');
  g.intercept('mod:p.ic', 'Thread', 'rename', (call, next) => next({ args: ['admin-y'] }));
  const viaIc = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['notes'], caller: user });
  assert.match(viaIc.message ?? '', /only the user names a chat admin-y/);
});
