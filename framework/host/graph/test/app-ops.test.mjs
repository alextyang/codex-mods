// The app's own operations held for the graph's interceptors (docs/design/interception.md; integration.md §6, §12 races). The real mux
// with the strict fake app-server as Codex, the graph runtime with a native thread for each thread the app starts, and the bridge
// (app-ops.mjs). Covers: a held send refused, changed or released; concurrent traffic during a hold; Stop during a held send; a held
// steer cancelled by Stop; deadline expiry; an interceptor that goes away while it holds; the app disconnecting while held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeApp, until, sleep } from '../../mux/test/helpers.mjs';
import { createGraph, refused } from '../index.mjs';
import { createAppOps } from '../app-ops.mjs';
import { refs } from '../providers/codex/map.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const input = (t) => [{ type: 'text', text: t, text_elements: [] }];
const textOf = (c) => c.parts.map((p) => p.text ?? '').join('');

async function setup(opts = {}) {
  const h = await harness();
  await h.up();
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const codex = graph.registerProvider('native', 'codex', { types: { Thread: {}, CodexThread: {}, Turn: {} } });
  const ops = createAppOps({ graph, mux: h.mux, log: quiet, ...opts });
  let n = 1000;
  const t = {
    h, graph, ops, codex,
    /** A thread the app started, resident in the graph as Codex's. */
    async thread() {
      const id = (await h.app.request(n++, 'thread/start', {})).result.thread.id;
      codex.put(refs.thread(id), {
        state: { title: 't', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 },
        links: { agent: refs.agent() },
      });
      return id;
    },
    send: (id, method, params) => { const rid = n++; h.app.send({ id: rid, method, params }); return rid; },
    reply: (rid, ms = 5000) => h.app.reply(rid, ms),
    /** What Codex received (the fake logs `<name> <line>`). */
    seen: (method, pred = () => true) => h.serverLog().map((l) => { try { return JSON.parse(l.slice(l.indexOf(' ') + 1)); } catch { return null; } })
      .filter((m) => m && m.method === method && pred(m.params ?? {})),
    async close() { await ops.dispose(); await h.close(); },
  };
  return t;
}
/** A gate an interceptor waits on. */
function gate() { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; }

test('a send the graph refuses is answered with the refusal; Codex never sees it; without an interceptor nothing is held', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const free = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('free') }));
    assert.ok(free.result?.turn, 'no interceptor: the send passes');
    t.graph.intercept('mod:qa', 'Thread', 'send', (c, next) => (textOf(c.args[0]).includes('nope') ? refused('notAllowed', 'not this one') : next()));
    const r = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('nope') }));
    assert.equal(r.error?.code, -32001);
    assert.match(r.error.message, /not this one/);
    assert.equal(t.seen('turn/start', (p) => p.input?.[0]?.text === 'nope').length, 0, 'Codex never saw it');
    const ok = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('fine') }));
    assert.ok(ok.result?.turn, 'an allowed send goes on and the app gets Codex\'s answer');
  } finally { await t.close(); }
});

test('changed arguments go on in the request\'s params; next() resolves with what the app\'s own request made, as the graph says it (its Turn)', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    let outcome;
    t.graph.intercept('mod:qa', 'Thread', 'send', async (c, next) => { outcome = await next({ args: [{ parts: [{ kind: 'text', text: 'changed' }] }] }); return outcome; });
    const r = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('original'), clientUserMessageId: 'c-1' }));
    assert.ok(r.result?.turn);
    const sent = t.seen('turn/start').at(-1).params;
    assert.equal(sent.input[0].text, 'changed');
    assert.equal(sent.clientUserMessageId, 'c-1', 'the rest of the params is kept');
    await until(() => outcome !== undefined, 5000, 'next() resolved');   // it resolves once the mux has settled the app's response
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.value, refs.turn(r.result.turn.id));
  } finally { await t.close(); }
});

test('public hooks H5: a held send carries its settings as options; changing only them keeps the app\'s own input (mentions and all)', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    let given;
    t.graph.intercept('mod:qa', 'Thread', 'send', async (c, next) => { given = c.args[1]; return next({ args: [c.args[0], { settings: { ...c.args[1].settings, effort: 'low' } }] }); });
    const own = [...input('look at '), { type: 'mention', name: 'a.js', path: '/r/a.js' }];
    await t.reply(t.send(id, 'turn/start', { threadId: id, input: own, model: 'gpt-x', effort: 'high', clientUserMessageId: 'c-2' }));
    assert.deepEqual(given, { settings: { model: 'gpt-x', effort: 'high' } }, 'what the app sends with, as the send\'s options');
    const sent = t.seen('turn/start').at(-1).params;
    assert.deepEqual(sent.input, own, 'the app\'s own input: never rebuilt from the graph\'s content');
    assert.deepEqual([sent.effort, sent.model], ['low', 'gpt-x']);
  } finally { await t.close(); }
});

test('races: other traffic flows during a hold, Stop is not held behind a held send, and a second send waits its turn', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const other = await t.thread();
    const g = gate();
    const order = [];
    t.graph.intercept('mod:qa', 'Thread', 'send', async (c, next) => { const s = textOf(c.args[0]); if (s === 'held') await g.wait(); order.push(s); return next(); });
    const held = t.send(id, 'turn/start', { threadId: id, input: input('held') });
    await until(() => t.ops.held.length === 1, 5000, 'the send is held');
    const second = t.send(id, 'turn/start', { threadId: id, input: input('second') });
    assert.ok((await t.reply(t.send(id, 'thread/read', { threadId: id }))).result, 'a read of the same thread is answered');
    assert.ok((await t.reply(t.send(other, 'turn/start', { threadId: other, input: input('elsewhere') }))).result, 'another thread\'s send goes on');
    assert.ok('result' in (await t.reply(t.send(id, 'turn/interrupt', { threadId: id, turnId: 'x' }))), 'Stop is answered while the send is held');
    assert.deepEqual(order, ['elsewhere'], 'the second send on the held thread waits');
    g.open();
    await t.reply(held);
    await t.reply(second);
    assert.deepEqual(order, ['elsewhere', 'held', 'second'], 'decided in arrival order');
  } finally { await t.close(); }
});

test('races: a held steer is cancelled when a Stop on its thread goes on', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const turn = (await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('running') }))).result.turn.id;
    t.graph.intercept('mod:qa', 'Thread', 'steer', () => new Promise(() => {}));
    const steer = t.send(id, 'turn/steer', { threadId: id, input: input('more'), expectedTurnId: turn });
    await until(() => t.ops.held.length === 1, 5000, 'the steer is held');
    await t.reply(t.send(id, 'turn/interrupt', { threadId: id, turnId: turn }));
    const r = await t.reply(steer);
    assert.match(r.error?.message ?? '', /cancelled: the turn was stopped/);
    assert.equal(t.seen('turn/steer').length, 0);
  } finally { await t.close(); }
});

test('races: a deadline that passes, or an interceptor that goes away while it holds, releases the send unchanged', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const off = t.graph.intercept('mod:qa', 'Thread', 'send', () => new Promise(() => {}), { deadlineMs: 80 });
    const r = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('late') }));
    assert.ok(r.result?.turn, 'released after the deadline: Codex answered');
    off.dispose();
    // A mod's interceptor runs in its worker: when the mod is disabled, the call it was making fails, which releases the hold.
    let fail;
    t.graph.intercept('mod:qa', 'Thread', 'send', () => new Promise((_, reject) => { fail = reject; }));
    const held = t.send(id, 'turn/start', { threadId: id, input: input('while disabled') });
    await until(() => typeof fail === 'function', 5000, 'held');
    fail(Object.assign(new Error('the realm went away'), { code: 'OutcomeUnknown' }));
    t.graph.disposeOwner('mod:qa');
    assert.ok((await t.reply(held)).result?.turn, 'released as if never held');
    assert.equal(t.seen('turn/start', (p) => p.input?.[0]?.text === 'while disabled').length, 1);
  } finally { await t.close(); }
});

test('races: the app disconnecting while a send is held cancels it; Codex never sees it and next() answers cancelled', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    // A second app session sends on the thread and goes away while its send is held; the first keeps the backend alive.
    const app2 = makeApp();
    t.h.mux.attachApp(app2.stream);
    await app2.handshake({ clientInfo: { name: 'test-app', version: '0' } });
    const g = gate();
    let after;
    t.graph.intercept('mod:qa', 'Thread', 'send', async (c, next) => { await g.wait(); after = await next(); return after; });
    app2.send({ id: 2, method: 'turn/start', params: { threadId: id, input: input('gone') } });
    await until(() => t.ops.held.length === 1, 5000, 'held');
    app2.destroy();
    await sleep(100);
    g.open();
    await until(() => after !== undefined, 5000, 'the interceptor went on');
    assert.deepEqual(after, refused('unavailable', 'cancelled'));
    await sleep(100);
    assert.equal(t.seen('turn/start', (q) => q.input?.[0]?.text === 'gone').length, 0, 'Codex never saw it');
    assert.equal(t.ops.held.length, 0);
  } finally { await t.close(); }
});

test('races: the user\'s Stop while the send is still held (the app\'s backgroundTerminals/clean) cancels the held send', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    t.graph.intercept('mod:qa', 'Thread', 'send', () => new Promise(() => {}));
    const held = t.send(id, 'turn/start', { threadId: id, input: input('stop me') });
    await until(() => t.ops.held.length === 1, 5000, 'held');
    t.send(id, 'thread/backgroundTerminals/clean', { threadId: id });   // what the app's Stop sends with no turn yet
    const r = await t.reply(held);
    assert.match(r.error?.message ?? '', /cancelled: the turn was stopped/);
    assert.equal(t.seen('turn/start', (p) => p.input?.[0]?.text === 'stop me').length, 0, 'Codex never saw it');
    assert.equal(t.ops.held.length, 0);
  } finally { await t.close(); }
});

test('public hooks §3.4: an app send nothing holds, while a mod\'s after observes Thread.send, is recorded once its response came, never held', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const ops = [];
    t.graph.onOperation((e) => ops.push(e));
    await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('unwatched') }));
    assert.equal(ops.length, 0, 'nothing observes it: no record');
    const w = t.graph.observe('Thread', 'send');
    const r = await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('watched') }));
    assert.ok(r.result?.turn, 'it went on as the app\'s own');
    await until(() => ops.length === 1, 2000, 'the record');
    assert.deepEqual([ops[0].operation, ops[0].caller.kind, ops[0].outcome.status, textOf(ops[0].args[0])], ['send', 'user', 'done', 'watched']);
    assert.deepEqual(ops[0].outcome.value, refs.turn(r.result.turn.id), 'what it made: its Turn');
    w.dispose();
    await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('after') }));
    assert.equal(ops.length, 1);
  } finally { await t.close(); }
});

test('H6m: a fork from a turn is the Thread\'s fork of that turn (an interceptor may move it); an earlier message edited goes back as that Turn\'s rewind; both held before Codex', async () => {
  const t = await setup();
  try {
    const id = await t.thread();
    const turnId = (await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('one') }))).result.turn.id;
    t.codex.put(refs.turn(turnId), { state: { status: 'completed', startedAt: 1, startedBy: { kind: 'user' } }, links: { thread: refs.thread(id) } });
    const forks = [], rewinds = [];
    t.graph.intercept('mod:qa', 'Thread', 'fork', (c, next) => { forks.push(c.args.map((a) => a?.id ?? null)); return next({ args: [] }); });
    t.graph.intercept('mod:qa', 'Turn', 'rewind', (c) => { rewinds.push([c.ref.id, c.args.length]); return refused('notAllowed', 'keep the history'); });
    const before = t.seen('thread/fork').length;
    await t.reply(t.send(id, 'thread/fork', { threadId: id, lastTurnId: turnId }));
    assert.deepEqual(forks, [[turnId, null]], 'the fork of that turn, with its options (the source\'s fork parameters: none here, G3.5)');
    const sent = t.seen('thread/fork').slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.lastTurnId, undefined, 'the interceptor made it a fork of the whole chat');
    const r = await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turnId }));
    assert.match(r.error?.message ?? '', /keep the history/);
    assert.deepEqual(rewinds, [[turnId, 0]]);
    assert.equal(t.seen('thread/revert').length, 0, 'Codex never went back');
  } finally { await t.close(); }
});

test('H6m review: a change the request cannot carry is answered at once; an undecided hold is refused under the mux\'s bound; a turn not read or another chat\'s is refused; a fork up to before a turn is the fork of the one before; the graph\'s own edit passes', async () => {
  const own = new Set();
  const t = await setup({ holdLimitMs: 150, appOwn: (method, p) => own.has(`${method}:${p.threadId}`) });
  try {
    const id = await t.thread(), other = await t.thread();
    const turns = [];
    for (const text of ['one', 'two']) turns.push((await t.reply(t.send(id, 'turn/start', { threadId: id, input: input(text) }))).result.turn.id);
    turns.forEach((tid, i) => t.codex.put(refs.turn(tid), { state: { status: 'completed', startedAt: i + 1, startedBy: { kind: 'user' } }, links: { thread: refs.thread(id) } }));
    // a rewind changed to carry new text: the app is answered at once (never left to the mux's bound)
    const rw = t.graph.intercept('mod:qa', 'Turn', 'rewind', (c, next) => next({ args: [{ parts: [{ kind: 'text', text: 'new' }] }] }));
    const r1 = await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turns[1] }), 2000);
    assert.match(r1.error?.message ?? '', /cannot carry that change/);
    rw.dispose?.(); t.graph.disposeOwner('mod:qa');
    // undecided past the bound: refused, never let go
    t.graph.intercept('mod:slow', 'Turn', 'rewind', () => new Promise(() => {}));
    const r2 = await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turns[1] }), 3000);
    assert.match(r2.error?.message ?? '', /not decided in time|cancelled/);
    // a turn the graph cannot read, and another chat's: refused while something holds rewinds
    const r3 = await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: 'nope' }), 5000);
    assert.match(r3.error?.message ?? '', /could not be read/);
    const r4 = await t.reply(t.send(other, 'thread/revert', { threadId: other, beforeTurnId: turns[0] }), 2000);
    assert.match(r4.error?.message ?? '', /not that chat/);
    assert.equal(t.seen('thread/revert').length, 0);
    t.graph.disposeOwner('mod:slow');
    // a fork up to before a turn: the fork of the turn before it; before the first, refused while forks are held
    const forks = [];
    t.graph.intercept('mod:qa', 'Thread', 'fork', (c, next) => { forks.push(c.args.map((a) => a?.id ?? null)); return next(); });
    await t.reply(t.send(id, 'thread/fork', { threadId: id, beforeTurnId: turns[1] }));
    assert.deepEqual(forks, [[turns[0]]]);
    assert.match((await t.reply(t.send(id, 'thread/fork', { threadId: id, beforeTurnId: turns[0] }))).error?.message ?? '', /cannot be said/);
    // the graph's own edit, carried out by the page: not held again
    t.graph.intercept('mod:no', 'Turn', 'rewind', () => refused('notAllowed', 'no rewinds'));
    own.add(`thread/revert:${id}`);
    const before = t.seen('thread/revert').length;
    await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turns[1] }));
    assert.equal(t.seen('thread/revert').length, before + 1, 'it went to Codex unheld');
  } finally { await t.close(); }
});

test('H6m1 review round 2: one request several areas read is refused while anything holds any of it; the graph\'s own call is taken once; a hold still reading is settled at the bound', async () => {
  const { combineAppOperations } = await import('../providers/codex/index.mjs');
  const plugin = { ref: { type: 'Plugin', provider: 'codex', id: 'p' }, operation: 'disable', args: [] };
  const serverRefusal = { refuse: 'several changes at once', type: 'ToolServer', operation: 'edit', held: [['ToolServer', 'edit'], ['ToolServer', 'remove']] };
  assert.deepEqual(combineAppOperations([plugin]), plugin);
  assert.deepEqual(combineAppOperations([serverRefusal, plugin]).held, [['ToolServer', 'edit'], ['ToolServer', 'remove'], ['Plugin', 'disable']]);
  assert.deepEqual(combineAppOperations([plugin, { ...plugin, operation: 'enable' }]).held, [['Plugin', 'disable'], ['Plugin', 'enable']]);
  assert.equal(combineAppOperations([]), null);
  // the graph's own call: taken once (a like request after it is held)
  const expected = new Set(['thread/revert']);
  const t = await setup({ holdLimitMs: 100, appOwn: (method, p, take) => { const has = expected.has(method); if (has && take) expected.delete(method); return has; },
    appOperation: (method) => (method === 'plugin/install' ? { pending: { type: 'Plugin', operation: 'install' }, resolve: () => new Promise(() => {}), failed: 'x' } : null) });
  try {
    const id = await t.thread();
    const turn = (await t.reply(t.send(id, 'turn/start', { threadId: id, input: input('one') }))).result.turn.id;
    t.codex.put(refs.turn(turn), { state: { status: 'completed', startedAt: 1, startedBy: { kind: 'user' } }, links: { thread: refs.thread(id) } });
    t.graph.intercept('mod:no', 'Turn', 'rewind', () => refused('notAllowed', 'no rewinds'));
    await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turn }));
    assert.equal(t.seen('thread/revert').length, 1, 'the graph\'s own went unheld');
    const again = await t.reply(t.send(id, 'thread/revert', { threadId: id, beforeTurnId: turn }));
    assert.match(again.error?.message ?? '', /no rewinds/, 'a like request after it is held');
    // a catalog read that never ends: refused at the bound all the same
    t.graph.intercept('mod:no', 'Plugin', 'install', () => refused('notAllowed', 'no'));
    const r = await t.reply(t.send(id, 'plugin/install', { pluginName: 'x', marketplacePath: '/m' }), 3000);
    assert.match(r.error?.message ?? '', /not decided in time/);
  } finally { await t.close(); }
});
