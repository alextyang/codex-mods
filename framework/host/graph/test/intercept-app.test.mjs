// Operations the user starts in the app, decided by the graph's interceptors (docs/design/interception.md I3, I5-I8): the same path as
// invoke up to the interceptors, with the app's own request as the terminal; faults and deadlines release; one queue per object, Stop in
// a lane of its own; cancellation. Headless, with the native type library; `forward` stands in for the app's request going on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, createAbort, done, refused } from '../index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';

const P = 'codex';
const USER = { kind: 'user', id: 'user', owner: 'app' };
const threadRef = (id) => ({ type: 'CodexThread', provider: P, id });
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const g = createGraph();
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const p = g.registerProvider('native', P, { types: { Thread: {}, CodexThread: {} } });   // no handlers: the app performs the operations
  for (const id of ['t1', 't2']) {
    p.put(threadRef(id), {
      state: { title: id, status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 },
      links: { agent: { type: 'CodexAgent', provider: P, id: 'codex' } },
    });
  }
  const forwarded = [];
  const forward = (tag) => async (args) => { forwarded.push([tag, args]); return done({ ok: tag }); };
  return { g, p, forwarded, forward };
}
const app = (g, id, operation, args, forward, signal) => g.interceptApp({ ref: threadRef(id), operation, args, caller: USER, origin: 'app', signal }, forward);

test('I3, I4: without an interceptor the operation is released unheld; intercepted() says which operations would be held', async () => {
  const { g, forward, forwarded } = setup();
  assert.equal(g.intercepted('CodexThread', 'send'), false);
  assert.deepEqual(await app(g, 't1', 'send', [text('hi')], forward('a')), { decision: 'release', code: 'no-interceptor', reason: 'no interceptor' });
  g.intercept('mod:x', 'Thread', 'send', (c, next) => next());
  assert.equal(g.intercepted('CodexThread', 'send'), true, 'an interceptor on the concept sees the subtype');
  assert.equal(g.intercepted('CodexThread', 'archive'), false);
  const d = await app(g, 't1', 'send', [text('hi')], forward('b'));
  assert.equal(d.decision, 'forwarded');
  assert.deepEqual(d.outcome, done({ ok: 'b' }), 'next() resolves with the app\'s own result');
  assert.deepEqual(forwarded, [['b', [text('hi')]]]);
});

test('I5: a refusal answers the app; changed arguments go on validated; a replacing interceptor handles it; no provider handler is needed', async () => {
  const { g, forward, forwarded } = setup();
  const off = g.intercept('mod:x', 'Thread', 'send', () => refused('notAllowed', 'not today'));
  const r = await app(g, 't1', 'send', [text('hi')], forward('a'));
  assert.equal(r.decision, 'refuse');
  assert.equal(r.outcome.message, 'not today');
  assert.equal(forwarded.length, 0);
  off.dispose();
  const off2 = g.intercept('mod:x', 'Thread', 'rename', (c, next) => next({ args: [`${c.args[0]} (checked)`] }));
  assert.equal((await app(g, 't1', 'rename', ['New'], forward('r'))).decision, 'forwarded');
  assert.deepEqual(forwarded.at(-1), ['r', ['New (checked)']]);
  off2.dispose();
  g.intercept('mod:x', 'Thread', 'rename', (c, next) => next({ args: [42] }));
  const bad = await app(g, 't1', 'rename', ['New'], forward('bad'));
  assert.equal(bad.decision, 'refuse', 'changed arguments are validated');
  assert.equal(bad.outcome.reason, 'invalid');
  const h = setup();
  h.g.intercept('mod:y', 'Thread', 'archive', () => done('kept'), { replaces: true });
  assert.equal((await app(h.g, 't1', 'archive', [], h.forward('x'))).decision, 'handled');
});

test('a replacing interceptor that starts and then fails, turns uncertain or misses its deadline is answered as failed: the app\'s own request never goes on as well (boundary review R)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ia-')), 'intents.jsonl');
  const g = createGraph({ journalFile: file });
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const p = g.registerProvider('native', P, { types: { Thread: {}, CodexThread: {} } });
  p.put(threadRef('t1'), { state: { title: 't1', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 },
    links: { agent: { type: 'CodexAgent', provider: P, id: 'codex' } } });
  const forwarded = [];
  const forward = async (args) => { forwarded.push(args); return done({ ok: true }); };
  const off = g.intercept('mod:r', 'Thread', 'archive', () => { throw new Error('half done'); }, { replaces: true });
  const r = await app(g, 't1', 'archive', [], forward);
  assert.equal(r.decision, 'failed', 'not release: the replacement may have had its effect');
  off.dispose();
  const off2 = g.intercept('mod:r', 'Thread', 'archive', () => ({ status: 'uncertain', operation: 'archive' }), { replaces: true });
  assert.equal((await app(g, 't1', 'archive', [], forward)).decision, 'failed');
  off2.dispose();
  g.intercept('mod:r', 'Thread', 'archive', () => new Promise(() => {}), { replaces: true, deadlineMs: 30 });
  assert.equal((await app(g, 't1', 'archive', [], forward)).decision, 'failed');
  assert.deepEqual(forwarded, [], 'the app\'s request never went on');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const started = lines.filter((l) => l.phase === 'started');
  assert.equal(started.length, 3, 'each replacement was claimed before it ran');
  assert.ok(started.every((l) => l.source === 'app-replace' && l.operation.endsWith('.archive')));
  // one past its deadline may have had its effect: uncertain in the journal (built review H7pa round 2), as one that said so
  assert.deepEqual(lines.filter((l) => l.phase !== 'started').map((l) => l.phase), ['failed', 'uncertain', 'uncertain']);
  g.close();
});

test('I6, G6.6: an interceptor that throws, misses its deadline or answers wrongly is passed over (its onFailure allow, the default): the operation goes on; one that declared refuse refuses it', async () => {
  const { g, forward, forwarded } = setup();
  const a = g.intercept('mod:x', 'Thread', 'send', () => { throw new Error('boom'); });
  assert.equal((await app(g, 't1', 'send', [text('hi')], forward('a'))).decision, 'forwarded');
  a.dispose();
  const b = g.intercept('mod:x', 'Thread', 'send', () => new Promise(() => {}), { deadlineMs: 50 });
  const t0 = Date.now();
  const d = await app(g, 't1', 'send', [text('hi')], forward('b'));
  assert.equal(d.decision, 'forwarded');
  assert.ok(Date.now() - t0 < 2000);
  b.dispose();
  // A next() called after the deadline runs nothing more: the operation went on past it once.
  let late;
  const c2 = g.intercept('mod:x', 'Thread', 'send', async (c, next) => { await sleep(80); late = await next(); return late; }, { deadlineMs: 30 });
  const before = forwarded.length;
  assert.equal((await app(g, 't1', 'send', [text('slow')], forward('late'))).decision, 'forwarded');
  await sleep(100);
  assert.equal(late?.error?.code, 'interceptorDeadline');
  assert.equal(forwarded.length, before + 1, 'the late next() forwarded nothing more');
  c2.dispose();
  // one that declared its failure a refusal
  const r = g.intercept('mod:x', 'Thread', 'send', () => { throw new Error('boom'); }, { onFailure: 'refuse' });
  const no = await app(g, 't1', 'send', [text('hi')], forward('r'));
  assert.deepEqual([no.decision, no.outcome.reason], ['refuse', 'unavailable']);
  assert.match(no.outcome.message, /interceptor x failed: boom/);
  r.dispose();
  // The deadline counts the interceptor's own time: waiting inside next() does not use it up.
  g.intercept('mod:x', 'Thread', 'send', async (c, next) => { await sleep(30); return next(); }, { deadlineMs: 60 });
  const slowForward = async () => { await sleep(150); return done('late but fine'); };
  assert.equal((await app(g, 't1', 'send', [text('hi')], slowForward)).decision, 'forwarded');
});

test('I6 with §3.7: a fault never lets the operation past a policy: past the interceptor that failed, the rest decide', async () => {
  const { g, forward, forwarded } = setup();
  g.intercept('mod:x', 'Thread', 'send', () => { throw new Error('has no operation'); });
  const pol = g.policy('mod:y', { id: 'no', title: 'No sends', on: { type: 'Thread', operation: 'send' }, then: { refuse: 'Not now' } });
  const d = await app(g, 't1', 'send', [text('hi')], forward('a'));
  assert.equal(d.decision, 'refuse');
  assert.match(d.outcome.message, /Not now/);
  assert.equal(forwarded.length, 0);
  pol.dispose();
  const d2 = await app(g, 't1', 'send', [text('hi')], forward('b'));
  assert.equal(d2.decision, 'forwarded');
  assert.equal(forwarded.length, 1);
  assert.equal((await g.interceptApp({ ref: threadRef('nope'), operation: 'send', args: [text('x')], caller: USER }, forward('c'))).code, 'unknown-instance');
});

test('G6.2: an interceptor stops the app\'s action: decided stopped, nothing forwarded, the mod named, an operationStopped event on the subject', async () => {
  const { g, forward, forwarded } = setup();
  const seen = [];
  g.subscribe({ ref: threadRef('t1') }, (m) => { if (m.type === 'delta' && m.event?.kind === 'event') seen.push([m.event.name, m.event.payload]); return true; });
  g.intercept('mod:usage', 'Thread', 'send', async () => ({ status: 'stopped', message: 'sent at the reset' }));
  const d = await app(g, 't1', 'send', [text('hi')], forward('s'));
  assert.deepEqual([d.decision, d.outcome.by, d.outcome.message, forwarded.length], ['stopped', { kind: 'mod', id: 'usage' }, 'sent at the reset', 0]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [['operationStopped', { operation: 'send', by: { kind: 'mod', id: 'usage' }, message: 'sent at the reset' }]]);
});

test('I7: held operations on one object are decided in arrival order; Stop has its own lane; other objects are not held back', async () => {
  const { g, forward, forwarded } = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  g.intercept('mod:x', 'Thread', 'send', async (c, next) => { if (c.args[0].parts[0].text === 'first') await gate; return next(); });
  g.intercept('mod:x', 'Thread', 'stop', (c, next) => next());
  const first = app(g, 't1', 'send', [text('first')], forward('first'));
  const second = app(g, 't1', 'send', [text('second')], forward('second'));
  const stop = app(g, 't1', 'stop', [], forward('stop'));
  const other = app(g, 't2', 'send', [text('other')], forward('other'));
  await Promise.all([stop, other]);
  assert.deepEqual(forwarded.map((x) => x[0]), ['stop', 'other'], 'Stop and the other thread are not behind the held send');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(forwarded.map((x) => x[0]), ['stop', 'other', 'first', 'second']);
});

test('I8: a cancelled hold ends its interceptors and next() answers cancelled; a hold waiting in the queue is dropped', async () => {
  const { g, forward, forwarded } = setup();
  let sawNext;
  g.intercept('mod:x', 'Thread', 'send', async (c, next) => { await sleep(40); sawNext = await next(); return sawNext; });
  const a = createAbort();
  const d = app(g, 't1', 'send', [text('hi')], forward('a'), a.signal);
  const b = createAbort();
  const queued = app(g, 't1', 'send', [text('queued')], forward('b'), b.signal);
  b.abort('appGone');
  await sleep(10);   // the first interceptor is running now
  a.abort('appGone');
  assert.equal((await d).decision, 'cancelled');
  assert.equal((await queued).decision, 'cancelled');
  await sleep(60);
  assert.deepEqual(sawNext, refused('unavailable', 'cancelled'), 'the interceptor learns it from next()');
  assert.equal(forwarded.length, 0, 'nothing went on');
});

test('I3: the caller\'s own interceptors are skipped; an unknown instance or a mapping that fails validation is released', async () => {
  const { g, forward } = setup();
  g.intercept('app', 'Thread', 'send', () => refused('notAllowed'));
  assert.equal((await app(g, 't1', 'send', [text('hi')], forward('a'))).decision, 'release', 'only the app\'s own interceptor: none applies');
  g.intercept('mod:x', 'Thread', 'send', (c, next) => next());
  assert.equal((await g.interceptApp({ ref: threadRef('nope'), operation: 'send', args: [text('x')], caller: USER }, forward('b'))).decision, 'release');
  assert.equal((await app(g, 't1', 'send', ['not content'], forward('c'))).reason, 'invalid arguments');
});

test('I11: reflection says which operations pass interceptors from any origin, by the bindings of the app\'s path', async () => {
  const { g } = setup();
  assert.equal(g.interceptable(threadRef('t1'), 'send'), 'graph only');
  const b = g.bindAppOrigin((s) => s.ref.provider === P, ['send', 'archive']);
  assert.equal(g.interceptable(threadRef('t1'), 'send'), 'any origin');
  assert.equal(g.interceptable(threadRef('t1'), 'rename'), 'graph only');
  assert.equal(g.interceptable(threadRef('t1'), 'nope'), null);
  b.dispose();
  assert.equal(g.interceptable(threadRef('t1'), 'archive'), 'graph only');
});
