// ctx.graph through a mod's worker (runtime-core.md; docs/graph/04): the test agent mod (tests/fixtures/mods/test-agent) registers its type,
// provides its threads and answers operations in its worker; a mod's own calls are checked against its grant and its provider id;
// everything a mod registered goes with it; ctx.graph.intercept runs a mod's interceptor in its worker (docs/design/interception.md I10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeHarness, installMod, waitFor, EVAL_HOST, inWorker } from './helpers.mjs';
import { createGraph, createAbort } from '../../graph/index.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';
import { createGraphNs } from '../../ctx/graph.mjs';

const AGENT_HOST = await readFile(new URL('../../../../tests/fixtures/mods/test-agent/host.mjs', import.meta.url), 'utf8');
const USER = { kind: 'user', id: 'user', owner: 'app' };
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });

async function setup() {
  const graph = createGraph();
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const h = await makeHarness({ graph, internals: { timing: { heartbeatTimeoutMs: 600000 } } });
  const agent = await installMod(h.layout, { id: 'qa.test-agent', host: AGENT_HOST, grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] });
  await h.runtime.activate(agent);
  const thread = await waitFor(() => graph.list('TestAgentThread')[0], { what: 'the agent\'s thread' });
  return { h, graph, agent, thread };
}

test('the test agent serves its thread from its worker; send runs a turn; an approval is answered through the graph', async () => {
  const { h, graph, thread } = await setup();
  try {
    assert.equal(thread.ref.provider, 'qa.test-agent');
    assert.equal(graph.isComplete('Thread'), true, 'the only provider of threads here says its list is complete');
    // Its agent and models (V14) are put from the worker before its threads, and the threads link to them.
    const [agent] = graph.list('Agent');
    assert.deepEqual([agent.ref.type, agent.ref.provider, agent.state.name, agent.state.available], ['TestAgent', 'qa.test-agent', 'Test agent', true]);
    assert.equal(typeof agent.state.icon, 'string');
    assert.doesNotMatch(agent.state.icon, /#|rgb|hsl/i, 'an icon is a symbol name, never a color');
    assert.deepEqual(graph.related(agent.ref, 'models').map((m) => m.state.name).sort(), ['Test fast', 'Test thorough']);
    assert.deepEqual(graph.related(thread.ref, 'model').links.agent, agent.ref);
    assert.equal(graph.related(thread.ref, 'agent').ref.id, agent.ref.id);
    assert.deepEqual(graph.related(agent.ref, 'threads').map((x) => x.ref.id), [thread.ref.id]);
    assert.equal(graph.isComplete('Agent') && graph.isComplete('Model'), true);
    const out = await graph.invoke({ ref: thread.ref, operation: 'send', args: [text('please approve')], caller: USER, origin: 'app' });
    assert.equal(out.status, 'done');
    assert.equal(out.value.type, 'Turn');
    const req = await waitFor(() => graph.list('CommandApproval', { status: 'pending' })[0], { what: 'the approval' });
    const ans = await graph.invoke({ ref: req.ref, operation: 'answer', args: ['once'], caller: USER, origin: 'app' });
    assert.equal(ans.status, 'done');
    await waitFor(() => graph.resolve(out.value)?.state.status === 'completed', { what: 'the turn completed' });
    const reply = graph.referrers(out.value, 'turn').find((s) => s.ref.type === 'AgentMessage');
    assert.match(reply.state.content.parts[0].text, /approved the command/);
    await waitFor(() => graph.resolve(thread.ref).state.status === 'idle', { what: 'the thread idle again (written after the turn)' });
  } finally { await h.close(); }
});

test('what a mod registered goes with it: its instances are removed and its types unregistered', async () => {
  const { h, graph, thread } = await setup();
  try {
    await h.runtime.deactivate('qa.test-agent', 'test');
    assert.ok(graph.resolve({ ...thread.ref, type: 'Thread' })?.gone, 'gone (by its concept: its own type went with the mod)');
    assert.equal(graph.list('Thread').length, 0);
    assert.equal(graph.type('TestAgentThread'), null);
    assert.deepEqual([graph.list('Agent').length, graph.list('Model').length, graph.type('TestAgent')], [0, 0, null], 'its agent and models go with it');
  } finally { await h.close(); }
});

test('ctx.graph needs the graph grant; a mod writes only its own instances; a mod\'s invoke is made as the mod', async () => {
  const { h, graph, thread } = await setup();
  try {
    const plain = await installMod(h.layout, { id: 'test.plain', host: EVAL_HOST });
    const granted = await installMod(h.layout, { id: 'test.granted', host: EVAL_HOST, grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] });
    await h.runtime.activate(plain); await h.runtime.activate(granted);
    await assert.rejects(inWorker(h.runtime, 'test.plain', `return ctx.graph.list('Thread');`), (e) => e.code === 'Denied');
    const seen = [];
    graph.onOperation((e) => seen.push(e));
    const out = await inWorker(h.runtime, 'test.granted', `return ctx.graph.invoke(args.ref, 'rename', ['From a mod']);`, { ref: thread.ref });
    assert.equal(out.status, 'done');
    assert.equal(graph.resolve(thread.ref).state.title, 'From a mod');
    assert.deepEqual(seen.at(-1).caller, { kind: 'mod', id: 'test.granted', owner: 'mod:test.granted' });
    const listed = await inWorker(h.runtime, 'test.granted', `return (await ctx.graph.list('TestAgentThread')).map((s) => s.ref.id);`);
    assert.deepEqual(listed, [thread.ref.id]);
    await assert.rejects(inWorker(h.runtime, 'test.granted', `
      const p = ctx.graph.provide({ types: {} });
      return p.put({ type: 'Thread', provider: 'qa.test-agent', id: 'x' }, { state: {} });`), (e) => e.code === 'Denied');
  } finally { await h.close(); }
});

test('a mod emits a named event of its own instance from its worker; views of the instance get it', async () => {
  const { h, graph } = await setup();
  try {
    await installEval(h, 'test.emitter');
    await inWorker(h.runtime, 'test.emitter', `
      await ctx.graph.registerTypes([{ id: 'Memo', kind: 'concept', parent: null,
        spec: { state: { text: { member: 'state', schema: { t: 'string' }, tier: 'core' } }, events: { noted: { member: 'event', payload: { t: 'string' } } } } }]);
      globalThis.p = ctx.graph.provide({ types: { Memo: {} } });
      await globalThis.p.put({ type: 'Memo', id: 'm1' }, { state: { text: 'hi' } });`);
    const got = [];
    graph.subscribe({ ref: { type: 'Memo', provider: 'test.emitter', id: 'm1' } }, (m) => { if (m.type === 'delta') got.push(m.event); });
    const out = await inWorker(h.runtime, 'test.emitter', `return globalThis.p.emit({ type: 'Memo', id: 'm1' }, 'noted', 'saved');`);
    assert.deepEqual([out.kind, out.name], ['event', 'noted']);
    assert.deepEqual(got.map((e) => [e.name, e.payload]), [['noted', 'saved']]);
    await assert.rejects(inWorker(h.runtime, 'test.emitter', `return globalThis.p.emit({ type: 'Memo', id: 'm1' }, 'noted', 7);`), (e) => e.code === 'Invalid');
  } finally { await h.close(); }
});

test('a provider whose worker crashes mid-turn goes with it: its instances are removed and the mod is quarantined', async () => {
  const { h, graph, thread } = await setup();
  try {
    const out = await graph.invoke({ ref: thread.ref, operation: 'send', args: [text('crash now')], caller: USER, origin: 'app' });
    assert.equal(out.status, 'done');
    await waitFor(() => graph.list('Thread').length === 0, { what: 'the crashed provider\'s threads removed' });
    assert.ok(graph.resolve({ ...out.value, type: 'Turn' })?.gone, 'its running turn is gone with it');
    assert.deepEqual(h.quarantines.map((q) => q.modId), ['qa.test-agent']);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- ctx.graph.intercept (docs/design/interception.md I10)
const USER_RENAME = (thread, title) => ({ ref: thread.ref, operation: 'rename', args: [title], caller: USER, origin: 'app' });
const titleOf = (graph, thread) => graph.resolve(thread.ref).state.title;
async function installEval(h, id, grants = ['graph', 'graph.read', 'graph.act', 'graph.intercept']) {
  const mod = await installMod(h.layout, { id, host: EVAL_HOST, grants });
  await h.runtime.activate(mod);
  return mod;
}

test('intercept: a mod refuses rename in its worker; the outcome carries its reason, the title is unchanged, and disposing lifts it', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.guard');
    const before = titleOf(graph, thread);
    await inWorker(h.runtime, 'test.guard', `globalThis.d = ctx.graph.intercept('Thread', 'rename', () => ({ status: 'refused', reason: 'notAllowed', message: 'renaming is off' }));`);
    const out = await graph.invoke(USER_RENAME(thread, 'Nope'));
    assert.equal(out.status, 'refused');
    assert.equal(out.reason, 'notAllowed');
    assert.equal(out.message, 'renaming is off');
    assert.equal(titleOf(graph, thread), before);
    await inWorker(h.runtime, 'test.guard', `await globalThis.d.dispose();`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'Allowed'))).status, 'done');
    assert.equal(titleOf(graph, thread), 'Allowed');
  } finally { await h.close(); }
});

test('intercept: a cancelled call reaches the worker: the interceptor\'s call.signal aborts there, and the invoke is refused as cancelled (D0.4)', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.waiter');
    await inWorker(h.runtime, 'test.waiter', `
      globalThis.seen = [];
      ctx.graph.intercept('Thread', 'rename', (call) => new Promise((resolve) => {
        globalThis.seen.push(call.signal.aborted);
        call.signal.onAbort(() => { globalThis.seen.push(call.signal.reason); resolve({ status: 'refused', reason: 'unavailable', message: 'stopped' }); });
      }));`);
    const ab = createAbort();
    const pending = graph.invoke({ ...USER_RENAME(thread, 'Held'), signal: ab.signal });
    const seen = () => inWorker(h.runtime, 'test.waiter', 'return globalThis.seen;');
    await waitFor(async () => (await seen()).length === 1, { what: 'the interceptor waiting' });
    ab.abort('the user stopped');
    const out = await pending;
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    await waitFor(async () => (await seen()).length === 2, { what: 'the worker told' });
    assert.deepEqual(await seen(), [false, 'cancelled']);
    assert.notEqual(titleOf(graph, thread), 'Held');
  } finally { await h.close(); }
});

test('intercept: the interceptor is given the plain call; next({args}) changes the call, and a change that fails validation comes back refused', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.edit');
    await inWorker(h.runtime, 'test.edit', `
      globalThis.seen = [];
      ctx.graph.intercept('Thread', 'rename', (call, next) => {
        globalThis.seen.push(call);
        if (call.args[0] === 'bad') return next({ args: [42] });
        return next({ args: [call.args[0] + ' (edited)'] });
      });`);
    const before = titleOf(graph, thread);
    const out = await graph.invoke(USER_RENAME(thread, 'Plan'));
    assert.equal(out.status, 'done');
    assert.equal(titleOf(graph, thread), 'Plan (edited)');
    const [call] = await inWorker(h.runtime, 'test.edit', `return globalThis.seen;`);
    assert.deepEqual(Object.keys(call).sort(), ['args', 'caller', 'id', 'instance', 'operation', 'origin', 'ref']);
    assert.equal(call.id, out.id);
    assert.equal(call.operation, 'rename');
    assert.deepEqual(call.args, ['Plan']);
    assert.deepEqual(call.ref, thread.ref);
    assert.deepEqual(call.caller, USER);
    assert.equal(call.origin, 'app');
    assert.deepEqual(call.instance.ref, thread.ref);
    assert.equal(call.instance.state.title, before, 'the instance is the one the call found');
    const bad = await graph.invoke(USER_RENAME(thread, 'bad'));
    assert.equal(bad.status, 'refused');
    assert.equal(bad.reason, 'invalid');
    assert.equal(titleOf(graph, thread), 'Plan (edited)');
  } finally { await h.close(); }
});

test('intercept: a mod sees next()\'s outcome and returns it; a return value that is no outcome stands for it once next was called', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.watch');
    await inWorker(h.runtime, 'test.watch', `
      globalThis.outcomes = [];
      ctx.graph.intercept('Thread', 'rename', async (call, next) => {
        const mode = call.args[0];
        if (mode === 'unawaited') { next(); return null; }
        const out = await next();
        globalThis.outcomes.push(out);
        if (mode === 'twice') globalThis.outcomes.push(await next());
        if (mode === 'quiet') return undefined;
        return out;
      });`);
    const out = await graph.invoke(USER_RENAME(thread, 'Seen'));
    assert.equal(out.status, 'done');
    assert.equal(titleOf(graph, thread), 'Seen');
    const [seen] = await inWorker(h.runtime, 'test.watch', `return globalThis.outcomes;`);
    assert.deepEqual(seen, { status: 'done', value: out.value });
    const quiet = await graph.invoke(USER_RENAME(thread, 'quiet'));
    assert.equal(quiet.status, 'done', 'an undefined return after next() is next()\'s outcome');
    assert.equal(titleOf(graph, thread), 'quiet');
    const unawaited = await graph.invoke(USER_RENAME(thread, 'unawaited'));
    assert.equal(unawaited.status, 'done', 'a next() the function did not await is still awaited for it');
    assert.equal(titleOf(graph, thread), 'unawaited');
    assert.equal((await graph.invoke(USER_RENAME(thread, 'twice'))).status, 'done');
    const second = (await inWorker(h.runtime, 'test.watch', `return globalThis.outcomes;`)).at(-1);
    assert.equal(second.status, 'failed', 'next is single-use: the second comes back failed');
    assert.equal(second.error.code, 'interceptorFault');
  } finally { await h.close(); }
});

test('intercept: without next a mod may refuse or stop but not answer (its failure: passed over, or refused as it declared); with replaces it answers in the handler\'s place', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.answer');
    await inWorker(h.runtime, 'test.answer', `globalThis.d = ctx.graph.intercept('Thread', 'rename', () => ({ status: 'done', value: 'mine' }));`);
    const passed = await graph.invoke(USER_RENAME(thread, 'Passed'));
    assert.deepEqual([passed.status, titleOf(graph, thread)], ['done', 'Passed'], 'its failure passed over (onFailure allow, the default): the handler ran');
    const before = titleOf(graph, thread);
    await inWorker(h.runtime, 'test.answer', `await globalThis.d.dispose(); globalThis.d = ctx.graph.intercept('Thread', 'rename', () => ({ status: 'done', value: 'mine' }), { onFailure: 'refuse' });`);
    const plain = await graph.invoke(USER_RENAME(thread, 'No'));
    assert.deepEqual([plain.status, plain.reason], ['refused', 'unavailable']);
    assert.match(plain.message, /answered without calling next/);
    await inWorker(h.runtime, 'test.answer', `await globalThis.d.dispose(); globalThis.d = ctx.graph.intercept('Thread', 'rename', () => 'just a value', { onFailure: 'refuse' });`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'No'))).status, 'refused', 'a bare value is not next()\'s outcome when next was not called');
    await inWorker(h.runtime, 'test.answer', `await globalThis.d.dispose(); globalThis.d = ctx.graph.intercept('Thread', 'rename', () => ({ status: 'stopped', message: 'kept for later' }));`);
    const stopped = await graph.invoke(USER_RENAME(thread, 'Stopped'));
    assert.deepEqual([stopped.status, stopped.by, stopped.message, titleOf(graph, thread)], ['stopped', { kind: 'mod', id: 'test.answer' }, 'kept for later', before], 'a stop: nothing ran, nothing failed');
    await inWorker(h.runtime, 'test.answer', `await globalThis.d.dispose(); globalThis.d = ctx.graph.intercept('Thread', 'rename', () => ({ status: 'done', value: 'mine' }), { replaces: true });`);
    const out = await graph.invoke(USER_RENAME(thread, 'Replaced'));
    assert.equal(out.status, 'done');
    assert.equal(out.value, 'mine');
    assert.equal(titleOf(graph, thread), before, 'the provider\'s handler did not run');
  } finally { await h.close(); }
});

test('intercept: two mods run in priority order, and the later one sees the earlier one\'s changed args', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.low'); await installEval(h, 'test.high');
    const add = (suffix, priority) => `
      globalThis.seen = [];
      ctx.graph.intercept('Thread', 'rename', (call, next) => { globalThis.seen.push(call.args[0]); return next({ args: [call.args[0] + '${suffix}'] }); }, { priority: ${priority} });`;
    await inWorker(h.runtime, 'test.low', add('+low', 1));       // registered first, but the lower priority
    await inWorker(h.runtime, 'test.high', add('+high', 5));
    assert.equal((await graph.invoke(USER_RENAME(thread, 'X'))).status, 'done');
    assert.equal(titleOf(graph, thread), 'X+high+low');
    assert.deepEqual(await inWorker(h.runtime, 'test.high', `return globalThis.seen;`), ['X']);
    assert.deepEqual(await inWorker(h.runtime, 'test.low', `return globalThis.seen;`), ['X+high']);
  } finally { await h.close(); }
});

test('intercept: a mod\'s own invoke skips its own interceptor but other mods\' interceptors see it', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.self'); await installEval(h, 'test.other');
    await inWorker(h.runtime, 'test.self', `ctx.graph.intercept('Thread', 'rename', () => ({ status: 'refused', reason: 'notAllowed', message: 'self guard' }));`);
    await inWorker(h.runtime, 'test.other', `globalThis.callers = []; ctx.graph.intercept('Thread', 'rename', (call, next) => { globalThis.callers.push(call.caller); return next(); }, { priority: 1 });`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'User'))).status, 'refused', 'the user is held by the guard');
    const own = await inWorker(h.runtime, 'test.self', `return ctx.graph.invoke(args.ref, 'rename', ['By the guard']);`, { ref: thread.ref });
    assert.equal(own.status, 'done', 'the guard does not see its own mod\'s operations');
    assert.equal(titleOf(graph, thread), 'By the guard');
    assert.deepEqual(await inWorker(h.runtime, 'test.other', `return globalThis.callers;`), [USER, { kind: 'mod', id: 'test.self', owner: 'mod:test.self' }],
      'the other mod saw the user\'s call and the guard mod\'s own call');
  } finally { await h.close(); }
});

test('intercept: deactivating the mod removes its interceptor', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.gone');
    await inWorker(h.runtime, 'test.gone', `ctx.graph.intercept('Thread', 'rename', () => ({ status: 'refused', reason: 'notAllowed' }));`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'Held'))).status, 'refused');
    await h.runtime.deactivate('test.gone', 'test');
    const out = await graph.invoke(USER_RENAME(thread, 'Free'));
    assert.equal(out.status, 'done');
    assert.equal(titleOf(graph, thread), 'Free');
  } finally { await h.close(); }
});

test('intercept: a mod that does not answer within its deadlineMs is its failure: refused as it declared, and nothing ran', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.silent');
    const before = titleOf(graph, thread);
    await inWorker(h.runtime, 'test.silent', `ctx.graph.intercept('Thread', 'rename', () => new Promise(() => {}), { deadlineMs: 150, onFailure: 'refuse' });`);
    const t0 = Date.now();
    const out = await graph.invoke(USER_RENAME(thread, 'Never'));
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    assert.match(out.message, /did not decide within 150 ms/);
    assert.ok(Date.now() - t0 < 10000, 'the deadline released the call');
    assert.equal(titleOf(graph, thread), before);
  } finally { await h.close(); }
});

test('intercept: the deadline counts the time the mod takes itself, not the time inside next; a next after the deadline fails Invalid and runs nothing', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.up'); await installEval(h, 'test.down'); await installEval(h, 'test.slow');
    // up (deadline 200 ms) waits in next for the slower interceptor below it (about 500 ms): that is not up's time.
    await inWorker(h.runtime, 'test.up', `globalThis.d = ctx.graph.intercept('Thread', 'rename', (call, next) => next(), { priority: 9, deadlineMs: 200 });`);
    await inWorker(h.runtime, 'test.down', `globalThis.d = ctx.graph.intercept('Thread', 'rename', async (call, next) => { await new Promise((r) => setTimeout(r, 500)); return next(); }, { priority: 1 });`);
    const out = await graph.invoke(USER_RENAME(thread, 'Waited'));
    assert.equal(out.status, 'done', 'waiting inside next did not run the deadline out');
    assert.equal(titleOf(graph, thread), 'Waited');
    await inWorker(h.runtime, 'test.up', `await globalThis.d.dispose();`);
    await inWorker(h.runtime, 'test.down', `await globalThis.d.dispose();`);
    // slow takes 500 ms itself before calling next, with a 150 ms deadline: the call is failed, and the late next must not run the handler.
    await inWorker(h.runtime, 'test.slow', `
      ctx.graph.intercept('Thread', 'rename', async (call, next) => {
        await new Promise((r) => setTimeout(r, 500));
        try { globalThis.late = await next(); } catch (e) { globalThis.late = { code: e.code }; }
        return globalThis.late;
      }, { priority: 5, deadlineMs: 150, onFailure: 'refuse' });`);
    const late = await graph.invoke(USER_RENAME(thread, 'Too late'));
    assert.deepEqual([late.status, late.reason], ['refused', 'unavailable']);
    assert.deepEqual(await waitFor(() => inWorker(h.runtime, 'test.slow', `return globalThis.late ?? null;`), { what: 'the late next' }), { code: 'Invalid' });
    assert.equal(titleOf(graph, thread), 'Waited', 'the handler did not run after the call was failed');
  } finally { await h.close(); }
});

test('intercept: a mod whose interceptor throws: its failure, refused as it declared', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.throws');
    const before = titleOf(graph, thread);
    await inWorker(h.runtime, 'test.throws', `ctx.graph.intercept('Thread', 'rename', () => { throw new Error('boom'); }, { onFailure: 'refuse' });`);
    const out = await graph.invoke(USER_RENAME(thread, 'Boom'));
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    assert.match(out.message, /boom/);
    assert.equal(titleOf(graph, thread), before);
  } finally { await h.close(); }
});

test('intercept: needs the graph grant, and only the host realm has it', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.nograph', []);
    await inWorker(h.runtime, 'test.nograph', `ctx.graph?.intercept?.('Thread', 'rename', () => ({ status: 'refused', reason: 'notAllowed' })); return typeof ctx.graph;`);
    await waitFor(() => h.topic('framework/fault').some((f) => /not been granted/.test(f.message)), { what: 'the refusal of the registration' });
    assert.equal((await graph.invoke(USER_RENAME(thread, 'Free'))).status, 'done', 'nothing was registered');
    await installEval(h, 'test.badargs');
    await assert.rejects(inWorker(h.runtime, 'test.badargs', `return ctx.graph.intercept('Thread', 7, () => {});`), (e) => e.code === 'Invalid');
    await assert.rejects(inWorker(h.runtime, 'test.badargs', `return ctx.graph.intercept('Thread', 'rename', 'not a function');`), (e) => e.code === 'Invalid');
  } finally { await h.close(); }
});

test('intercept: calling next after the call has finished fails Invalid', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.late');
    await inWorker(h.runtime, 'test.late', `ctx.graph.intercept('Thread', 'rename', (call, next) => { globalThis.savedNext = next; return next(); });`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'Once'))).status, 'done');
    await assert.rejects(inWorker(h.runtime, 'test.late', `return globalThis.savedNext();`), (e) => e.code === 'Invalid');
    await assert.rejects(inWorker(h.runtime, 'test.late', `return globalThis.savedNext({ args: ['Late'] });`), (e) => e.code === 'Invalid');
    assert.equal(titleOf(graph, thread), 'Once');
  } finally { await h.close(); }
});

test('intercept (host side): deadlineMs defaults to 60 s and is capped at 10 min; a token belongs to its mod and ends with the call', async () => {
  const { h, graph, thread } = await setup();
  try {
    const registered = [];
    const spy = { ...graph, intercept: (...a) => { registered.push({ owner: a[0], type: a[1], operation: a[2], opts: a[4] }); return graph.intercept(...a); } };
    const ns = createGraphNs({ graph: () => spy });
    const state = { id: 'unit.a', owner: 'mod:unit.a', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] };
    const scope = { realm: 'host', state };
    const other = { realm: 'host', state: { id: 'unit.b', owner: 'mod:unit.b', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] } };
    let live = null;
    const invoke = async (args) => {
      const [kind, token, call] = args;
      assert.equal(kind, 'intercept');
      assert.deepEqual(Object.keys(call).sort(), ['args', 'caller', 'id', 'instance', 'operation', 'origin', 'ref']);
      live = token;
      assert.throws(() => ns.calls.next(other, token, null), (e) => e.code === 'Invalid', 'another mod\'s token');
      assert.throws(() => ns.calls.next(scope, 'not-a-token', null), (e) => e.code === 'Invalid');
      assert.throws(() => ns.calls.next(scope, token, 7), (e) => e.code === 'Invalid', 'a change is {args}');
      return ns.calls.next(scope, token, null);
    };
    const run = async (opts) => {
      const d = ns.handlers.intercept(scope, ['Thread', 'rename', opts], invoke);
      try { return await graph.invoke(USER_RENAME(thread, 'Unit')); } finally { d.dispose(); }
    };
    assert.equal((await run({ priority: 3, replaces: false })).status, 'done');
    assert.equal((await run({ deadlineMs: 5_000_000 })).status, 'done');
    assert.equal((await run({ deadlineMs: 250 })).status, 'done');
    assert.equal((await run(undefined)).status, 'done');
    assert.deepEqual(registered.map((r) => r.opts.deadlineMs), [60000, 600000, 250, 60000]);
    assert.deepEqual(registered[0], { owner: 'mod:unit.a', type: 'Thread', operation: 'rename', opts: { priority: 3, replaces: false, deadlineMs: 60000 } });
    assert.throws(() => ns.calls.next(scope, live, null), (e) => e.code === 'Invalid', 'finished token');
    assert.throws(() => ns.handlers.intercept({ ...scope, realm: 'renderer' }, ['Thread', 'rename', {}], invoke), (e) => e.code === 'Denied');
    assert.throws(() => ns.handlers.intercept({ realm: 'host', state: { ...state, grants: [] } }, ['Thread', 'rename', {}], invoke), (e) => e.code === 'Denied');
    assert.throws(() => ns.handlers.intercept(scope, ['Thread', 7, {}], invoke), (e) => e.code === 'Invalid');
    assert.throws(() => ns.handlers.intercept(scope, ['NoSuchType', 'rename', {}], invoke), (e) => e.code === 'Invalid');
  } finally { await h.close(); }
});

test('Request.ask (public-hooks.md §3.6): an interceptor\'s {approve}, {deny}, {option} or {answers} is the mod\'s own answer (its automatic action named); an outcome or next() is its result; "always" stays the user\'s', async () => {
  const { h, graph } = await setup();
  try {
    const calls = [];
    const NATIVE = { kind: 'native', id: 'unit' };
    const record = (op) => ({ effect: 'external', handler: ({ args, caller }) => { calls.push([op, args, caller.id]); return null; } });
    const p = graph.registerProvider('native', 'unit', { types: {
      Request: { operations: { ask: { effect: 'local', handler: () => { calls.push(['shown']); return null; } } } },
      Approval: { operations: { answer: record('answer') } },
      Question: { operations: { answer: record('answer') } },
    } });
    const links = { thread: { type: 'CodexThread', provider: 'unit', id: 't' }, turn: { type: 'Turn', provider: 'unit', id: 'u' } };
    const base = { status: 'pending', from: 'agent', askedAt: 1 };
    const cmd = { type: 'CommandApproval', provider: 'unit', id: 'c1' }, q = { type: 'Question', provider: 'unit', id: 'q1' };
    // the provider's own options (graph-integrity G1.6) and a question's prompts (G1.5)
    const options = [{ id: 'o1', label: 'Once', kind: 'approve', scope: 'once' }, { id: 'o2', label: 'For the chat', kind: 'approve', scope: 'thread' },
      { id: 'o3', label: 'Always', kind: 'approve', scope: 'always' }, { id: 'no', label: 'No', kind: 'deny' }];
    p.put(cmd, { state: { ...base, options, command: 'ls', directory: '/r' }, links });
    p.put(q, { state: { ...base, blocking: true, prompts: [{ id: 'which', prompt: text('Which?'), choices: [{ id: 'a', label: 'A' }], other: true, secret: false }] }, links });
    await installEval(h, 'test.asker', ['graph', 'graph.read', 'graph.act', 'graph.intercept']);
    const ask = (ref) => graph.invoke({ ref, operation: 'ask', args: [], caller: NATIVE });
    const answerWith = (value) => inWorker(h.runtime, 'test.asker', `globalThis.d?.dispose?.(); globalThis.d = ctx.graph.intercept('Request', 'ask', (call, next) => (${JSON.stringify(value)} === 'next' ? next() : ${JSON.stringify(value)}), { replaces: true });`);
    for (const [value, ref, expect] of [
      [{ approve: 'once', automatic: 'reads' }, cmd, ['answer', ['o1'], 'test.asker']],
      [{ approve: 'thread' }, cmd, ['answer', ['o2'], 'test.asker']],
      [{ deny: true }, cmd, ['answer', ['no'], 'test.asker']],
      [{ option: 'o2' }, cmd, ['answer', ['o2'], 'test.asker']],
      [{ answers: { which: { choices: ['a'], text: 'more' } } }, q, ['answer', [{ which: { choices: ['a'], text: 'more' } }], 'test.asker']],
      ['next', cmd, ['shown']],
    ]) {
      await answerWith(value);
      calls.length = 0;
      assert.equal((await ask(ref)).status, 'done', JSON.stringify(value));
      assert.deepEqual(calls, [expect], JSON.stringify(value));
    }
    for (const value of [{ approve: 'always' }, { option: 'o3' }]) {
      await answerWith(value);
      calls.length = 0;
      const always = await ask(cmd);
      assert.deepEqual([always.status, always.reason, calls], ['refused', 'invalid', []], '"always" is never answered this way');
    }
    await answerWith({ status: 'refused', reason: 'notAllowed', message: 'mine' });
    assert.equal((await ask(cmd)).message, 'mine', 'an outcome is the interceptor\'s own result');
  } finally { await h.close(); }
});

test('ctx.graph.policy (public-hooks.md §3.7): a mod\'s policy binds the user and the mod itself, never the framework; listed with its switch; a bad one is refused; dispose', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.policy');
    await inWorker(h.runtime, 'test.policy', `globalThis.p = ctx.graph.policy({ id: 'keep', title: 'Keep the title', on: { type: 'Thread', operation: 'rename' }, then: { refuse: 'This title stays' } }); await globalThis.p.accepted;`);
    const user = await graph.invoke(USER_RENAME(thread, 'Nope'));
    assert.deepEqual([user.status, user.message, user.by], ['refused', 'This title stays (“Keep the title”, a policy of test.policy)', { mod: 'test.policy', policy: 'keep' }]);
    const own = await inWorker(h.runtime, 'test.policy', `return ctx.graph.invoke(args.ref, 'rename', ['Mine']);`, { ref: thread.ref });
    assert.equal(own.status, 'refused', 'its own call too');
    assert.equal((await graph.invoke({ ...USER_RENAME(thread, 'Framework'), caller: { kind: 'framework', id: 'framework' } })).status, 'done');
    assert.deepEqual(await inWorker(h.runtime, 'test.policy', `return (await ctx.graph.policies()).map((x) => [x.id, x.on]);`), [['keep', true]]);
    assert.deepEqual(await inWorker(h.runtime, 'test.policy', `return ctx.graph.assess(args.ref, 'rename', ['x']);`, { ref: thread.ref }), { status: 'refused', reason: 'This title stays', by: { mod: 'test.policy', policy: 'keep' } });
    await assert.rejects(inWorker(h.runtime, 'test.policy', `await ctx.graph.policy({ id: 'bad', title: 'x', on: { type: 'Thread', operation: 'fly' }, then: { refuse: 'r' } }).accepted;`), /no operation "fly"/);
    await inWorker(h.runtime, 'test.policy', `await globalThis.p.dispose();`);
    assert.equal((await graph.invoke(USER_RENAME(thread, 'Allowed'))).status, 'done');
  } finally { await h.close(); }
});

test('ctx.graph.after (public-hooks.md §3.4): a record once each call has completed, whatever its outcome and origin, with the arguments it ran with and who changed them; a where; dispose', async () => {
  const { h, graph, thread } = await setup();
  try {
    await installEval(h, 'test.after');
    await inWorker(h.runtime, 'test.after', `globalThis.seen = []; globalThis.a = ctx.graph.after('Thread', 'rename', (r) => { globalThis.seen.push(r); });
      globalThis.b = ctx.graph.after('Thread', 'rename', (r) => { globalThis.seen.push({ filtered: r.id }); }, { where: { title: 'Never' } });`);
    // a mod that may read threads but not intercept their renames: the records, without what the calls carried
    await installEval(h, 'test.reader', ['graph', 'graph.read']);
    await inWorker(h.runtime, 'test.reader', `globalThis.seen = []; globalThis.a = ctx.graph.after('Thread', 'rename', (r) => { globalThis.seen.push(r); });`);
    assert.equal(graph.appHolds([['Thread', 'rename']]).observed.includes('Thread.rename'), true, 'observed while an after lasts');
    graph.intercept('mod:test.changer', 'Thread', 'rename', (call, next) => (call.args[0] === 'short' ? next({ args: ['Short title'] }) : next()));
    assert.equal((await graph.invoke(USER_RENAME(thread, 'short'))).status, 'done');
    const refusedOne = graph.policy('mod:test.guard', { id: 'no', title: 'No', on: { type: 'Thread', operation: 'rename' }, where: { title: 'Short title' }, then: { refuse: 'Kept' } });
    assert.equal((await graph.invoke({ ...USER_RENAME(thread, 'Again'), caller: { kind: 'mod', id: 'other.mod', owner: 'mod:other.mod' } })).status, 'refused');
    refusedOne.dispose();
    const seen = await waitFor(async () => { const s = await inWorker(h.runtime, 'test.after', 'return globalThis.seen;'); return s.length >= 2 ? s : null; }, { what: 'two records' });
    assert.deepEqual(seen.map((r) => [r.operation, r.origin, r.args, r.effectiveArgs, r.changedBy ?? null, r.outcome.status]), [
      ['rename', { kind: 'user' }, ['short'], ['Short title'], 'test.changer', 'done'],
      ['rename', { kind: 'mod', id: 'other.mod' }, ['Again'], ['Again'], null, 'refused'],
    ]);
    assert.ok(seen.every((r) => !r.filtered), 'outside its where: nothing');
    const read = await waitFor(async () => { const s = await inWorker(h.runtime, 'test.reader', 'return globalThis.seen;'); return s.length >= 2 ? s : null; }, { what: 'the reader\'s records' });
    assert.deepEqual(read.map((r) => [r.args, r.effectiveArgs, r.outcome.status, 'value' in r.outcome]), [[[], [], 'done', false], [[], [], 'refused', false]], 'reading a thread is not reading what is sent to it');
    await inWorker(h.runtime, 'test.reader', 'await globalThis.a.dispose();');
    await inWorker(h.runtime, 'test.after', `await globalThis.a.dispose(); await globalThis.b.dispose(); globalThis.seen.length = 0;`);
    await graph.invoke(USER_RENAME(thread, 'Later'));
    assert.deepEqual(await inWorker(h.runtime, 'test.after', 'return globalThis.seen;'), []);
  } finally { await h.close(); }
});
