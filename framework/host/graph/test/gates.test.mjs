// The gates on a call (docs/design/public-hooks.md §3.5, §3.7 "Order", §3.9): one chain of rewriting policies and interceptors in the
// user's order, then every refusal before any ask, a change's limits, and the authorization of the caller and of every mod that changed the
// call; a replacement only after them. What a where may read; which instances a policy binds; what holds or observes the app's own actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, policyMatches, rewriteArgs } from '../policies.mjs';
import { createGraph } from '../index.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const P = 'codex';
const threadRef = (id) => ({ type: 'CodexThread', provider: P, id });
const threadState = () => ({ title: 'T', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 });
const threadLinks = () => ({ agent: { type: 'CodexAgent', provider: P, id: 'codex' } });
const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });
const RENAME = { type: 'Thread', operation: 'rename' };

/** A thread whose rename asks every mod (R17), says a much longer name widens it, and never goes automatic as "always". */
function setup(o = {}) {
  const g = createGraph(o);
  g.registerTypes(NATIVE, 'native');
  const calls = [];
  const p = g.registerProvider('native', P, { types: { Thread: { operations: {
    rename: { effect: 'external', approval: ({ args }) => ({ action: `rename to ${args[0]}` }),
      widens: ({ original, args }) => (args[0].length > original[0].length + 10 ? 'a much longer name' : null),
      alwaysAsks: ({ args }) => (args[0] === 'always' ? 'never on its own' : null),
      handler: async ({ args, caller, approvedBy }) => { calls.push([args[0], caller.id, approvedBy ?? null]); return null; } },
    send: { effect: 'external', approval: () => ({ action: 'send' }), handler: async ({ args }) => { calls.push(['send', args[1] ?? null]); return null; } },
  } }, Turn: {} } });
  for (const id of ['t1', 't2', 't3']) p.put(threadRef(id), { state: threadState(), links: threadLinks(id) });
  return { g, p, calls };
}

test('a rewrite never reaches a prototype: such a path is refused when declared, and never followed', () => {
  const typeOf = () => ({ members: { operations: new Map([['rename', {}]]) } });
  for (const path of ['0.__proto__.framework', '0.constructor.prototype.x', '0.a.prototype']) {
    assert.throws(() => compilePolicy({ id: 'x', title: 'x', on: RENAME, then: { rewrite: { args: { [path]: true } } } }, typeOf), /not a path/);
  }
  assert.equal(rewriteArgs({ sets: [[['0', '__proto__', 'framework'], true]], prepend: null, append: null }, [{}]), null);
  assert.equal(rewriteArgs({ sets: [[['0', 'constructor', 'prototype'], 1]], prepend: null, append: null }, [{}]), null);
  assert.equal(({}).framework, undefined, 'nothing reached Object.prototype');
});

test('every mod that changed a call is asked about it as its own call (with the automatic action it named); a change that widens is refused', async () => {
  const asked = [];
  const on = new Map([['p.a/auto', { operation: 'Thread.rename', perHour: 10 }], ['p.c/mine', { operation: 'Thread.rename', perHour: 10 }]]);
  const { g, calls } = setup({ approvals: { ask: async (q) => { asked.push(q.modId); return { approved: true }; } }, automaticOf: (m, id) => on.get(`${m}/${id}`) ?? null });
  // p.a's automatic rename, rewritten by p.b's policy: p.b is asked (its own consent); p.a's own action covers p.a
  const tag = g.policy('mod:p.b', { id: 'tag', title: 'Tag it', on: RENAME, origin: 'mod', then: { rewrite: { args: { 0: 'tagged' } } } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['plain'], caller: mod('p.a'), automatic: 'auto' })).status, 'done');
  assert.deepEqual([asked, calls.at(-1)], [['p.b'], ['tagged', 'p.a', 'automatic:auto']]);
  tag.dispose();
  // an interceptor's change of the user's rename: its mod's automatic action (named in next) covers it, nobody is asked
  asked.length = 0;
  const ic = g.intercept('mod:p.c', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]}!`], automatic: 'mine' }));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['hi'], caller: user })).status, 'done');
  assert.deepEqual([asked, calls.at(-1)], [[], ['hi!', 'user', 'automatic:mine']]);
  ic.dispose();
  // without one it is asked about as that mod's call
  g.intercept('mod:p.d', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]}?`] }));
  await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['hi'], caller: user });
  assert.deepEqual(asked, ['p.d']);
  g.disposeOwner('mod:p.d');
  // a change that does more than the call did is refused, whoever asks for it
  g.intercept('mod:p.e', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]} and a great deal more`] }));
  const wide = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['hi'], caller: user });
  assert.deepEqual([wide.status, wide.message], ['refused', 'changed by p.e: a much longer name']);
});

test('every refusing policy is checked before any asking one is asked; a replacement runs only after the gates', async () => {
  const asked = [];
  const { g, calls } = setup({ approvals: { ask: async (q) => { asked.push(q.operation); return { approved: true }; } } });
  g.policy('mod:p.q', { id: 'ask', title: 'Ask first', on: RENAME, then: { ask: { title: 'Rename it?' } } });
  g.policy('mod:p.r', { id: 'no', title: 'Never', on: RENAME, origin: 'user', then: { refuse: 'No renames' } });
  const r = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user });
  assert.deepEqual([r.status, r.by, asked], ['refused', { mod: 'p.r', policy: 'no' }, []], 'refused before anyone was asked');
  let replaced = 0;
  g.intercept('mod:p.rep', 'Thread', 'rename', async () => { replaced++; return { status: 'done', value: null }; }, { replaces: true, priority: 100 });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'refused');
  assert.equal(replaced, 0, 'the replacement never ran past a refusal');
  g.disposeOwner('mod:p.r');
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'done');
  assert.deepEqual([replaced, asked, calls.length], [1, ['policy:ask'], 0], 'asked, then replaced: the handler never ran');
});

test('automatic actions: an operation that always asks never goes on its own; argument bounds read the argument\'s own fields', async () => {
  const asked = [];
  const on = new Map([['p.a/auto', { operation: 'Thread.rename', perHour: 10 }], ['p.a/plain', { operation: 'Thread.send', perHour: 10, args: { 1: { sticky: { $exists: false } } } }],
    ['p.a/eq', { operation: 'Thread.send', perHour: 10, args: { 1: { sticky: false } } }]]);
  const { g } = setup({ approvals: { ask: async (q) => { asked.push(q.operation); return { approved: false, reason: 'no' }; } }, automaticOf: (m, id) => on.get(`${m}/${id}`) ?? null });
  const call = (operation, args, automatic) => g.invoke({ ref: threadRef('t1'), operation, args, caller: mod('p.a'), automatic });
  assert.equal((await call('rename', ['always'], 'auto')).status, 'refused');
  assert.equal(g.assess({ ref: threadRef('t1'), operation: 'rename', args: ['always'], caller: mod('p.a'), automatic: 'auto' }).status, 'needsConsent');
  assert.equal((await call('rename', ['fine'], 'auto')).status, 'done');
  assert.deepEqual(asked, ['Thread.rename'], 'only the one that always asks was asked');
  asked.length = 0;
  assert.equal((await call('send', [text('hi'), { sticky: true }], 'plain')).status, 'refused', 'sticky is there: outside its bounds');
  assert.equal((await call('send', [text('hi'), {}], 'plain')).status, 'done');
  assert.equal((await call('send', [text('hi'), { sticky: false }], 'eq')).status, 'done', 'equality on an argument\'s field holds');
  assert.equal((await call('send', [text('hi'), { sticky: true }], 'eq')).status, 'refused');
  assert.deepEqual(asked, ['Thread.send', 'Thread.send']);
});

test('a policy reads only what its mod may read (an argument\'s instance it may not read is unknown), and binds only instances its mod may intercept', async () => {
  const p = compilePolicy({ id: 'x', title: 'x', on: { type: 'Thread', operation: 'fork' }, args: { 0: { status: 'done' } }, then: { refuse: 'no' } },
    () => ({ members: { operations: new Map([['fork', {}]]) } }));
  const turn = { type: 'Turn', provider: P, id: 'u1' };
  const inst = { ref: turn, state: { status: 'done' } };
  const base = { inst: null, caller: user, date: new Date(), env: {} };
  assert.equal(policyMatches(p, { ...base, args: [turn], resolve: () => inst }), true);
  assert.equal(policyMatches(p, { ...base, args: [turn], resolve: () => null }), 'unknown', 'not readable: unknown, never its fields');
  const { g } = setup({ authorize: (c, req) => !(c.owner === 'mod:p.peek' && req.use === 'intercept' && req.ref?.id === 't3') });
  g.policy('mod:p.peek', { id: 'no', title: 'No', on: RENAME, then: { refuse: 'no' } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'refused');
  assert.equal((await g.invoke({ ref: threadRef('t3'), operation: 'rename', args: ['x'], caller: user })).status, 'done', 'an instance its mod may not intercept: not bound');
  assert.equal(g.assess({ ref: threadRef('t3'), operation: 'rename', args: ['x'], caller: user }).status, 'allowed');
});

test('the app\'s own action: an interceptor\'s outcome never says a policy refused it; a request policy answers only on a known match', async () => {
  const { g } = setup();
  g.intercept('mod:p.forge', 'Thread', 'rename', async () => ({ status: 'refused', reason: 'notAllowed', message: 'no', by: { mod: 'p.other', policy: 'fake' } }));
  const d = await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user }, async () => ({ status: 'done' }));
  assert.deepEqual([d.decision, d.outcome.by], ['refuse', undefined]);
  assert.throws(() => g.policy('mod:p.req', { id: 'r', title: 'R', on: { request: 'CommandApproval' }, unknown: 'allow', then: { answer: { approve: 'once' } } }), /known/);
});

test('what holds or observes the app\'s own actions: a policy or an interceptor holds, a mod\'s after observes; the user\'s switch tells; a record of one that went', async () => {
  const off = new Set();
  const { g } = setup({ policyOff: (owner, id) => off.has(`${owner}/${id}`) });
  let told = 0;
  g.onHolds(() => told++);
  const pair = [['Thread', 'rename']];
  assert.deepEqual(g.appHolds(pair), { held: [], observed: [] });
  const w = g.observe('Thread', 'rename');
  assert.deepEqual(g.appHolds(pair).observed.sort(), ['CodexThread.rename', 'Thread.rename'], 'by the concept and each of its types');
  g.policy('mod:p.s', { id: 'no', title: 'No', on: RENAME, then: { refuse: 'no' } });
  assert.deepEqual([g.appHolds(pair).held.sort(), g.appHolds(pair).observed], [['CodexThread.rename', 'Thread.rename'], []]);
  const before = told;
  off.add('mod:p.s/no');
  g.policiesSwitched('mod:p.s');
  assert.ok(told > before, 'a switch tells what holds');
  assert.deepEqual(g.appHolds(pair).held, [], 'switched off: it holds nothing');
  w.dispose();
  const ops = [];
  g.onOperation((e) => ops.push(e));
  assert.equal(g.recordApp({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user, outcome: { status: 'done' } }), true);
  assert.deepEqual([ops[0].operation, ops[0].caller.kind, ops[0].outcome.status, ops[0].args], ['rename', 'user', 'done', ['y']]);
});

test('round 2: an automatic part is checked again just before dispatch (turned off while another mod was asked: asked); arguments given again unchanged are no change', async () => {
  const asked = [];
  const on = new Map([['p.a/auto', { operation: 'Thread.rename', perHour: 10 }]]);
  const { g, calls } = setup({ automaticOf: (m, id) => on.get(`${m}/${id}`) ?? null,
    approvals: { ask: async (q) => { asked.push(q.modId); if (q.modId === 'p.b') on.delete('p.a/auto'); return { approved: true }; } } });
  g.intercept('mod:p.b', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]}!`] }));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['hi'], caller: mod('p.a'), automatic: 'auto' })).status, 'done');
  assert.deepEqual([asked, calls.at(-1)], [['p.b', 'p.a'], ['hi!', 'p.a', 'user']], 'p.a\'s action went off while p.b was asked: p.a is asked too');
  g.disposeOwner('mod:p.b');
  g.intercept('mod:p.same', 'Thread', 'rename', (c, next) => next({ args: [...c.args] }));
  let seen = null;
  await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user }, async (a, call) => { seen = call.changers ?? []; return { status: 'done' }; });
  assert.deepEqual(seen, [], 'the same arguments again: nobody changed the call');
});

test('round 2: a replacement runs after every change, a later one in the user\'s order included; an interceptor\'s failure is passed over (G6.6) and the action recorded once', async () => {
  const order = { 'p.rep': 1, 'p.rw': 2 };
  const { g } = setup({ rankOf: (id) => order[id], approvals: { ask: async () => ({ approved: true }) } });
  let got = null;
  g.intercept('mod:p.rep', 'Thread', 'rename', async (c) => { got = c.args[0]; return { status: 'done', value: null }; }, { replaces: true });
  g.policy('mod:p.rw', { id: 'tag', title: 'Tag', on: RENAME, origin: 'user', then: { rewrite: { args: { 0: 'tagged' } } } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'done');
  assert.equal(got, 'tagged', 'the replacement got the call the later rewrite made');
  g.disposeOwner('mod:p.rep'); g.disposeOwner('mod:p.rw');
  const ops = [];
  g.onOperation((e) => ops.push(e));
  g.intercept('mod:p.boom', 'Thread', 'rename', () => { throw new Error('boom'); });
  const d = await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user }, async () => ({ status: 'done' }));
  assert.deepEqual([d.decision, ops.length], ['forwarded', 1], 'past the interceptor that failed it went on, recorded once');
});

test('round 2: a held app action given up meanwhile never goes on, a replacement included', async () => {
  const { createAbort } = await import('../abort.mjs');
  const abort = createAbort();
  const { g } = setup({ approvals: { ask: async () => { abort.abort('given up'); return { approved: true }; } } });
  g.policy('mod:p.q', { id: 'ask', title: 'Ask', on: RENAME, then: { ask: { title: 'Rename?' } } });
  let forwarded = 0, replaced = 0;
  const d = await g.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, signal: abort.signal }, async () => { forwarded++; return { status: 'done' }; });
  assert.deepEqual([d.decision, forwarded], ['cancelled', 0]);
  const again = createAbort();
  const g2 = setup({ approvals: { ask: async () => { again.abort('given up'); return { approved: true }; } } }).g;
  g2.policy('mod:p.q', { id: 'ask', title: 'Ask', on: RENAME, then: { ask: { title: 'Rename?' } } });
  g2.intercept('mod:p.rep', 'Thread', 'rename', async () => { replaced++; return { status: 'done', value: null }; }, { replaces: true });
  const d2 = await g2.interceptApp({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user, signal: again.signal }, async () => ({ status: 'done' }));
  assert.deepEqual([d2.decision, replaced], ['cancelled', 0]);
});

test('built review H7pa round 2: a call cancelled once it went on past an interceptor (or a replacement was let through) is answered by what it did, never cancelled', async () => {
  const { createAbort } = await import('../abort.mjs');
  const g = createGraph({ journal: null });
  g.registerTypes(NATIVE, 'native');
  let release = null;
  const did = [];
  const p = g.registerProvider('mod:unit.slow', 'unit.slow', { types: { Automation: { operations: {
    enable: { effect: 'external', handler: async () => { await new Promise((r) => { release = r; }); did.push('enable'); return null; } },
    disable: { effect: 'external', handler: async () => { did.push('disable'); return null; } },
  } } } });
  const A = { type: 'Automation', provider: 'unit.slow', id: 'a1' };
  await p.put(A, { state: { name: 'A', prompt: text('go'), schedule: { kind: 'interval', every: 60 }, enabled: false }, links: { agent: { type: 'CodexAgent', provider: P, id: 'codex' } } });
  g.intercept('mod:p.pass', 'Automation', 'enable', (c, next) => next());
  const abort = createAbort();
  const out = g.invoke({ ref: A, operation: 'enable', args: [], caller: user, signal: abort.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(typeof release, 'function', 'the handler is running');
  abort.abort('given up');
  await new Promise((r) => setTimeout(r, 10));
  release();
  assert.equal((await out).status, 'done', 'what the handler did, not cancelled');
  assert.deepEqual(did, ['enable']);
  // a replacement let through: its own answer
  let finish = null;
  g.intercept('mod:p.rep', 'Automation', 'disable', async () => { await new Promise((r) => { finish = r; }); return { status: 'done', value: 'replaced' }; }, { replaces: true });
  const a2 = createAbort();
  const out2 = g.invoke({ ref: A, operation: 'disable', args: [], caller: user, signal: a2.signal });
  await new Promise((r) => setTimeout(r, 10));
  a2.abort('given up');
  finish();
  assert.deepEqual([(await out2).status, (await out2).value], ['done', 'replaced']);
  // still deciding (next not called): cancelled, nothing done
  g.disposeOwner('mod:p.pass');
  let goOn = null;
  g.intercept('mod:p.wait', 'Automation', 'enable', async (c, next) => { await new Promise((r) => { goOn = r; }); return next(); });
  release = null;
  const a3 = createAbort();
  const out3 = g.invoke({ ref: A, operation: 'enable', args: [], caller: user, signal: a3.signal });
  await new Promise((r) => setTimeout(r, 10));
  a3.abort('given up');
  assert.deepEqual([(await out3).status, (await out3).message], ['refused', 'cancelled']);
  goOn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(release, null, 'the handler never ran');
  g.close();
});

test('built review H7pa round 2 (security review 2026-11-01): a replacement lost after it was let through is uncertain; an interceptor that fails after its next() leaves the call\'s own outcome', async () => {
  const { g, calls } = setup();
  const lost = g.intercept('mod:p.rep', 'Thread', 'rename', async () => { throw Object.assign(new Error('the worker went'), { code: 'OutcomeUnknown' }); }, { replaces: true });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: user })).status, 'uncertain');
  lost.dispose?.(); g.disposeOwner('mod:p.rep');
  // round 2: one that passed it on, heard a refusal, then did it itself and was lost: uncertain, not the refusal it heard
  const heard = [];
  const alt = g.intercept('mod:p.alt', 'Thread', 'rename', async (call, next) => { heard.push((await next({ args: [123] })).status); throw Object.assign(new Error('lost'), { code: 'OutcomeUnknown' }); }, { replaces: true });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['z'], caller: user })).status, 'uncertain');
  assert.deepEqual(heard, ['refused']);
  alt.dispose?.(); g.disposeOwner('mod:p.alt');
  g.intercept('mod:p.late', 'Thread', 'rename', async (call, next) => { await next(); throw new Error('after the fact'); });
  const out = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: user });
  assert.deepEqual([out.status, calls.at(-1)[0]], ['done', 'y'], 'the rename happened: done, not an interceptor fault');
  g.close();
});

test('built review H7ia round 1: invokeAll shows every entry whole, checks every call first, asks the policies once with it, binds the approval to the call as approved, and always answers outcomes', async () => {
  const asked = [];
  let during = null;
  const { g, p, calls } = setup({ approvals: { ask: async (q) => { asked.push(q); await during?.(); return { approved: true }; } } });
  const A = { caller: mod('p.a') };
  // each entry on a line of its own, a mod's newline never another entry; too long to show is refused before anyone is asked
  await g.invokeAll({ ...A, reason: 'Tidy\n• fake entry', calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['One\n• also fake'] }] });
  assert.equal(asked[0].detail, 'Tidy • fake entry\n• rename to One • also fake');
  const long = await g.invokeAll({ ...A, calls: Array.from({ length: 12 }, (_, i) => ({ ref: threadRef('t1'), operation: 'rename', args: [`${'x'.repeat(80)}${i}`] })) });
  assert.deepEqual([long.status, long.reason, /too long to show/.test(long.message), long.outcomes.length, asked.length], ['refused', 'invalid', true, 12, 1]);
  // checked first as a call of its own is: its arguments, the policies that refuse it
  calls.length = 0;
  const badArg = await g.invokeAll({ ...A, calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['First'] }, { ref: threadRef('t2'), operation: 'rename', args: [123] }] });
  assert.deepEqual([badArg.status, badArg.reason, calls.length, asked.length], ['refused', 'invalid', 0, 1], 'nothing ran, nobody asked');
  assert.deepEqual(badArg.outcomes.map((x) => x.reason), ['unavailable', 'invalid']);
  const no = g.policy('mod:p.guard', { id: 'no-t2', title: 'Keep t2', on: RENAME, where: { title: 'T2' }, then: { refuse: 'not t2' } });
  p.put(threadRef('t2'), { state: { ...threadState(), title: 'T2' }, links: threadLinks() });
  const byPolicy = await g.invokeAll({ ...A, calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['First'] }, { ref: threadRef('t2'), operation: 'rename', args: ['Second'] }] });
  assert.deepEqual([byPolicy.status, /not t2/.test(byPolicy.message), calls.length, asked.length], ['refused', true, 0, 1]);
  no.dispose?.(); g.disposeOwner('mod:p.guard');
  // a policy that asks: in the one prompt, not asked again
  g.policy('mod:p.q', { id: 'ask', title: 'Ask about renames', on: RENAME, then: { ask: { title: 'Rename?', message: 'Sure?' } } });
  asked.length = 0;
  const withPolicy = await g.invokeAll({ ...A, calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['P'] }] });
  assert.equal(withPolicy.status, 'done');
  assert.deepEqual(asked.map((q) => q.detail), ['• rename to P\n• confirm “Rename?”: Sure? (“Ask about renames”, a policy of p.q)'], 'one prompt');
  g.disposeOwner('mod:p.q');
  // the instance changed while the prompt was open: that call is asked about on its own
  asked.length = 0; calls.length = 0;
  during = async () => { during = null; p.put(threadRef('t1'), { state: { ...threadState(), title: 'Changed meanwhile' }, links: threadLinks() }); };
  await g.invokeAll({ ...A, calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['Q'] }, { ref: threadRef('t2'), operation: 'rename', args: ['R'] }] });
  assert.deepEqual(asked.map((q) => q.operation), ['graph.invokeAll', 'Thread.rename'], 't1 asked again; t2 as approved');
  // any change of the instance since, the batch's own earlier call's too, is asked about (the graph cannot tell whose it was; round 2)
  asked.length = 0;
  const bump = g.intercept('mod:p.touch', 'Thread', 'rename', async (call, next) => { const out = await next(); p.put(call.ref, { state: { ...threadState(), title: call.args[0] }, links: threadLinks() }); return out; });
  const twice = await g.invokeAll({ ...A, calls: [{ ref: threadRef('t3'), operation: 'rename', args: ['First'] }, { ref: threadRef('t3'), operation: 'rename', args: ['Second'] }] });
  assert.deepEqual([twice.status, asked.map((q) => q.operation)], ['done', ['graph.invokeAll', 'Thread.rename']]);
  bump.dispose?.(); g.disposeOwner('mod:p.touch');
  // a policy registered again while the prompt was open (its question perhaps another) is asked
  g.policy('mod:p.q2', { id: 'guard', title: 'Guard', on: RENAME, then: { ask: { title: 'First question?' } } });
  asked.length = 0;
  during = async () => { during = null; g.policy('mod:p.q2', { id: 'guard', title: 'Guard', on: RENAME, then: { ask: { title: 'Another question?' } } }); };
  await g.invokeAll({ ...A, calls: [{ ref: threadRef('t2'), operation: 'rename', args: ['G'] }] });
  assert.deepEqual(asked.map((q) => q.policy?.title ?? q.operation), ['graph.invokeAll', 'Another question?']);
  g.disposeOwner('mod:p.q2');
  // outcomes on every answer: not approved
  const g2 = setup({ approvals: { ask: async () => ({ approved: false, reason: 'no' }) } }).g;
  const denied = await g2.invokeAll({ ...A, calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['X'] }, { ref: threadRef('t2'), operation: 'rename', args: ['Y'] }] });
  assert.deepEqual([denied.status, denied.outcomes.map((x) => x.status)], ['refused', ['refused', 'refused']]);
  const empty = await g2.invokeAll({ ...A, calls: [] });
  assert.deepEqual(empty.outcomes, []);
});

test('public hooks §3.14: invokeAll asks once for all its changes; approved, they run in order and stop at the first not done; one changed meanwhile is asked about on its own', async () => {
  const asked = [];
  let approve = true;
  const { g, calls } = setup({ approvals: { ask: async (q) => { asked.push(q); return approve ? { approved: true } : { approved: false, reason: 'no' }; } } });
  const all = await g.invokeAll({ caller: mod('p.a'), reason: 'Tidy the titles', calls: [
    { ref: threadRef('t1'), operation: 'rename', args: ['One'] }, { ref: threadRef('t2'), operation: 'rename', args: ['Two'] }] });
  assert.equal(all.status, 'done');
  assert.deepEqual(all.outcomes.map((x) => x.status), ['done', 'done']);
  assert.equal(asked.length, 1, 'one prompt for both');
  assert.deepEqual([asked[0].operation, asked[0].action, asked[0].detail], ['graph.invokeAll', 'make 2 changes', 'Tidy the titles\n• rename to One\n• rename to Two']);
  assert.deepEqual(calls, [['One', 'p.a', 'user'], ['Two', 'p.a', 'user']], 'each approved by the user');
  // not approved: nothing runs
  approve = false; calls.length = 0;
  const no = await g.invokeAll({ caller: mod('p.a'), calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['X'] }] });
  assert.deepEqual([no.status, calls.length], ['refused', 0]);
  approve = true;
  // one that cannot be made at all: refused before anything runs
  const bad = await g.invokeAll({ caller: mod('p.a'), calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['Y'] }, { ref: threadRef('nope'), operation: 'rename', args: ['Z'] }] });
  assert.deepEqual([bad.status, /change 2/.test(bad.message), calls.length], ['refused', true, 0]);
  // the first not done stops the rest (one approval, not one transaction)
  asked.length = 0;
  const h = g.intercept('mod:p.z', 'Thread', 'rename', (call, next) => (call.args[0] === 'Stop' ? { status: 'refused', reason: 'notAllowed', message: 'not this one' } : next()));
  const stop = await g.invokeAll({ caller: mod('p.a'), calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['A'] }, { ref: threadRef('t2'), operation: 'rename', args: ['Stop'] },
    { ref: threadRef('t3'), operation: 'rename', args: ['C'] }] });
  assert.deepEqual([stop.status, stop.outcomes.map((x) => x.status)], [stop.outcomes[1].status, ['done', stop.outcomes[1].status, 'refused']], 'the first not done\'s outcome');
  assert.notEqual(stop.outcomes[1].status, 'done');
  assert.match(stop.outcomes[2].message, /not run: change 2/);
  assert.deepEqual(calls.map((c) => c[0]), ['A'], 'the third never ran');
  h.dispose?.();
  // a call another mod's interceptor changes asks something else when it runs: asked about on its own
  asked.length = 0; calls.length = 0;
  const r = g.intercept('mod:p.b', 'Thread', 'rename', (call, next) => next({ args: ['Renamed by p.b'] }));
  await g.invokeAll({ caller: mod('p.a'), calls: [{ ref: threadRef('t1'), operation: 'rename', args: ['Mine'] }] });
  assert.deepEqual(asked.map((q) => q.operation), ['graph.invokeAll', 'Thread.rename', 'Thread.rename'], 'the batch, then the changed call as p.a\'s and as p.b\'s');
  r.dispose?.();
});

test('F8: a call that only a grant decided ask lets through is held for the user after the policies and before the approval, once for the call; their answer decides', async () => {
  const order = [];
  let answer = null;
  const held = [];
  const { g, calls } = setup({
    authorize: (caller, req) => caller.kind !== 'mod' || req.use !== 'act' || caller.id === 'p.ok' || caller.id === 'mod:p.ic',
    approvals: { ask: async (q) => { order.push(`approval ${q.modId}`); return { approved: true }; } },
    permissions: {
      askFor: (caller, req) => (caller.id === 'p.ask' && req.operation === 'rename' ? 'graph.act:Thread.rename' : null),
      hold: async (caller, grant, call) => { order.push(`hold ${grant}`); held.push([caller.id, call.type, call.operation]); return answer; },
    },
  });
  g.policy('mod:p.pol', { id: 'quiet', title: 'Quiet', on: RENAME, origin: 'mod', then: { refuse: 'not now' }, where: { title: 'Frozen' } });
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['x'], caller: mod('p.no') })).status, 'refused', 'no grant at all: refused as before');
  assert.deepEqual(held, []);
  const ok = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['y'], caller: mod('p.ask') });
  assert.equal(ok.status, 'done');
  assert.deepEqual(order, ['hold graph.act:Thread.rename', 'approval p.ask'], 'held first, then the approval');
  assert.deepEqual(held, [['p.ask', 'CodexThread', 'rename']]);
  assert.deepEqual(calls.at(-1), ['y', 'p.ask', 'user']);
  answer = { status: 'refused', reason: 'notAllowed', message: 'you did not allow it' };
  const no = await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['z'], caller: mod('p.ask') });
  assert.deepEqual([no.status, no.message], ['refused', 'you did not allow it']);
  assert.equal(calls.at(-1)[0], 'y', 'never dispatched');
  // an interceptor that changes the call does not ask the user twice for it
  answer = null;
  held.length = 0;
  const ic = g.intercept('mod:p.ic', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]}!`] }));
  assert.equal((await g.invoke({ ref: threadRef('t1'), operation: 'rename', args: ['w'], caller: mod('p.ask') })).status, 'done');
  assert.equal(held.length, 1);
  ic.dispose();
  // the policies come first: a refusal is never asked about
  const frozen = setup({ authorize: (c, r) => c.kind !== 'mod' || r.use !== 'act', permissions: { askFor: () => 'graph.act', hold: async () => { held.push('asked'); return null; } } });
  frozen.p.put(threadRef('t9'), { state: { ...threadState(), title: 'Frozen' }, links: threadLinks() });
  frozen.g.policy('user', { id: 'freeze', title: 'Freeze', on: RENAME, then: { refuse: 'frozen' } });
  held.length = 0;
  assert.equal((await frozen.g.invoke({ ref: threadRef('t9'), operation: 'rename', args: ['v'], caller: mod('p.ask') })).status, 'refused');
  assert.deepEqual(held, [], 'refused by a policy: the user is not asked');
});
