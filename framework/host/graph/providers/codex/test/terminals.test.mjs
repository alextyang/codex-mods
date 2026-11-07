// Both kinds of Terminal through the graph, source, real mux and fake app-server. Main's session list and reports are played here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as terminals from '../areas/terminals.mjs';
import { produced } from './areas/terminals.samples.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user', owner: 'app' }, mod = { kind: 'mod', id: 'mod.terminals' };
// as framework-main lists them: a session in a chat names its chat (`threadId`), and is still the user's terminal, not an agent's command
const session = (id, conversationId, cwd, shell = 'zsh') => ({ id, conversationId, threadId: conversationId?.startsWith('client-new-thread:') ? null : conversationId, cwd, shell, ownerId: '11' });
const command = (id = 'long', extra = {}) => ({ type: 'commandExecution', id, command: 'sleep 300', cwd: '/repo', status: 'inProgress', processId: `process-${id}`, commandActions: [], ...extra });
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r; };
const refused = (r, reason, message) => {
  assert.equal(r.status, 'refused', JSON.stringify(r));
  assert.equal(r.reason, reason);
  if (message !== undefined) assert.equal(r.message, message);
};

async function setup({ main = true, initialAnswers = [] } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-terminals-'));
  const ops = [], requests = [], prompts = [], events = [], warnings = [], notes = [], responses = [];
  const answers = new Map(initialAnswers), protocol = new Map();
  const approval = { approved: true, reason: 'declined' };
  let clock = 100_000, seq = 0, feed, context;
  const log = { ...quiet, warn: (...args) => warnings.push(args) };
  const graph = createGraph({ log, now: () => clock, journalFile: path.join(dir, 'intents.jsonl'), approvals: {
    ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return approval; },
  } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const app = async (method, params) => {
    const r = await h.app.request(++seq, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    return r.result;
  };
  const first = (await app('thread/start', { cwd: '/repo' })).thread;
  const second = (await app('thread/start', { cwd: '/other' })).thread;
  let sessions = [session('one', first.id, '/repo/src'), session('two', first.id, '/else/src'), session('other', second.id, '/else/src'),
    session('home', 'client-new-thread:home', '/repo-sibling'), session('empty', second.id, null, null), session('home-project', 'client-new-thread:project', '/repo/src/tools')];
  // framework-main's projects module, for Project.newTerminal: the app makes the session and reports it attached, then the op is done
  const appProjects = createAppProjects({ log: quiet, send: (m) => queueMicrotask(() => {
    if (m.op !== 'new-terminal') return appProjects.settle({ type: 'app-op-done', requestId: m.requestId, ok: false, refused: true, error: 'not here' });
    const id = `made-${sessions.length}`;
    sessions.push(session(id, m.threadId ?? 'client-new-thread:home', m.path ?? '/repo'));
    mainOps.report({ type: 'area-report', area: 'terminals', report: { event: 'attached', sessionId: id, cwd: m.path ?? '/repo', shell: 'zsh' } });
    appProjects.settle({ type: 'app-op-done', requestId: m.requestId, ok: true, result: { sessionId: id } });
  }) });
  appProjects.apply({ type: 'projects', available: true, reset: true, selected: 'repo', projects: [
    { id: 'repo', name: 'Repo', roots: ['/repo'] }, { id: 'nested', name: 'Nested', roots: ['/repo/src'] }, { id: 'other', name: 'Other', roots: ['/other'] },
  ], threads: {} });
  const fake = h.mux.client('test:terminals');
  const termination = { terminated: true, error: null };
  fake.intercept('clientRequest', ['thread/backgroundTerminals/terminate', 'thread/read', 'thread/resume', 'thread/turns/list'], (m) => {
    if (m.method === 'thread/backgroundTerminals/terminate') return { respond: termination.error
      ? { error: { code: -32000, message: termination.error } } : { result: { terminated: termination.terminated } } };
    const result = protocol.get(m.method);
    return result ? { respond: { result: typeof result === 'function' ? result(m.params) : result } } : undefined;
  });
  let mainOps = null;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'terminals');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        let answer = answers.get(m.op);
        if (typeof answer === 'function') answer = await answer(m.args);
        answer ??= { ok: true, result: m.op === 'list' ? { sessions: structuredClone(sessions) } : {} };
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, error: e.message }); }
    });
  } });
  const module = { ...terminals, createFeed(ctx) {
    context = ctx;
    feed = terminals.createFeed({ ...ctx, request(method, params, intent) {
      requests.push({ method, params, intent });
      return ctx.request(method, params, intent);
    } });
    return { ...feed,
      notified(method, p) { feed.notified(method, p); notes.push([method, p]); },
      responded(method, r) { feed.responded(method, r); responses.push([method, r]); },
    };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, mainOps, appProjects, areas: { terminals: module }, now: () => clock, log });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Terminal') events.push([e.ref.id, e.name]); });
  await source.start();
  await feed.observe(refs.terminal('one'), 'Terminal');
  const note = async (method, p) => {
    const before = notes.length;
    await app('fake/notify', { method, params: p });
    await until(() => notes.slice(before).some(([m]) => m === method), 3000, method);
    await new Promise(setImmediate);
  };
  const turn = async (threadId = first.id, hold = true) => {
    if (hold) await app('fake/hold', { threadId });
    const t = (await app('turn/start', { threadId, input: [{ type: 'text', text: 'Work' }] })).turn;
    await until(() => graph.resolve(refs.turn(t.id))?.state.status === (hold ? 'running' : 'completed'), 3000, 'turn');
    return t;
  };
  const item = async (t, value, threadId = first.id) => {
    await note(value.status === 'inProgress' ? 'item/started' : 'item/completed', { threadId, turnId: t.id, item: value, startedAtMs: 1000, completedAtMs: 2000 });
    return refs.item('CodexCommandRun', threadId, value.id);
  };
  return {
    h, graph, source, feed, context, mainOps, appProjects, app, note, turn, item, first, second, protocol, termination,
    ops, requests, prompts, events, warnings, answers, approval, responses,
    get sessions() { return sessions; },
    setSessions(next) { sessions = structuredClone(next); },
    setClock(next) { clock = next; },
    async refresh() { clock += 10_001; await feed.observe(refs.terminal('one'), 'Terminal'); },
    report(event, sessionId, fields = {}) { mainOps.report({ type: 'area-report', area: 'terminals', report: { event, sessionId, ...fields } }); },
    invoke: (ref, operation, args = [], caller = user) => graph.invoke({ ref, operation, args, caller }),
    terminal: (id) => graph.resolve(refs.terminal(id)),
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); appProjects.dispose(); fake.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('pure data and fallback titles cover integrated, projectless and agent terminals', () => {
  const sessions = [session('a', 'chat', '/a/src/'), session('b', 'chat', '/b/src'), session('c', 'other-chat', '/a/src'), session('d', 'chat', ''), session('e', 'chat', '/')];
  assert.deepEqual(sessions.map((s) => terminals.titleOf(s, sessions)), ['src 1', 'src 2', 'src', 'Terminal 4', '/']);
  assert.equal(terminals.titleOf(sessions[0], [sessions[0]]), 'src');
  assert.deepEqual(terminals.terminalData({ id: 'none', cwd: null, shell: null }, { title: 'Terminal 1', project: null, thread: null }), {
    ref: refs.terminal('none'), state: { title: 'Terminal 1', directory: '', running: true, startedBy: 'you', shell: '' }, links: { project: null, thread: null },
  });
  const samples = produced();
  assert.ok(samples.some((d) => d.state?.startedBy === 'you') && samples.some((d) => d.state?.startedBy === 'agent'));
  assert.deepEqual(Object.keys(samples[0].links).sort(), ['project', 'thread']);
  assert.ok(samples.some((d) => d.ref.type === 'CodexCommandRun' && d.links.terminal));
});

test('the first list is a sync: state, conversation titles, deepest project and thread links, including home terminals', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.ops, [['list', {}]]);
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.terminal('one').state, { title: 'src 1', directory: '/repo/src', running: true, startedBy: 'you', shell: 'zsh' });
    assert.deepEqual(s.terminal('two').state, { title: 'src 2', directory: '/else/src', running: true, startedBy: 'you', shell: 'zsh' });
    assert.equal(s.terminal('other').state.title, 'src', 'another conversation does not number this folder');
    assert.deepEqual(s.terminal('one').links, { thread: refs.thread(s.first.id), project: refs.project('nested') });
    assert.deepEqual(s.terminal('two').links, { thread: refs.thread(s.first.id), project: refs.project('repo') }, 'outside the project roots, fall back to the chat\'s project');
    assert.deepEqual(s.terminal('home').links, { project: null, thread: null }, '/repo-sibling is not inside /repo');
    assert.deepEqual(s.terminal('home-project').links, { project: refs.project('nested'), thread: null });
    assert.deepEqual(s.terminal('empty').state, { title: 'Terminal 5', directory: '', running: true, startedBy: 'you', shell: '' });
    assert.deepEqual(s.terminal('empty').links, { project: refs.project('other'), thread: refs.thread(s.second.id) });
    assert.deepEqual(s.graph.related(refs.thread(s.first.id), 'terminals').map((t) => t.ref.id).sort(), ['one', 'two']);
    assert.deepEqual(s.graph.related(refs.project('nested'), 'terminals').map((t) => t.ref.id).sort(), ['home-project', 'one']);
    assert.deepEqual(s.graph.related(refs.terminal('one'), 'commandRuns'), []);
    assert.equal(s.terminal('one').state.directory, '/repo/src', 'directory records where the shell started');
  } finally { await s.close(); }
});

test('reports emit output, exited and closed, remove sessions, and log errors without exposing output text', async () => {
  const s = await setup();
  try {
    s.report('output', 'one');
    s.report('output', 'unknown');
    s.report('exit', 'one', { code: 0, signal: null });
    s.report('exit', 'one', { code: 0, signal: null });
    s.report('exit', 'two', { code: null, signal: 'SIGTERM' });
    s.report('exit', 'other', { code: null, signal: null });
    s.report('error', 'empty', { message: 'Session missing' });
    assert.deepEqual(s.events, [['one', 'output'], ['one', 'exited'], ['two', 'exited'], ['other', 'closed']]);
    for (const id of ['one', 'two', 'other']) assert.equal(s.terminal(id)?.gone, true);
    assert.ok(s.warnings.some(([m, d]) => m === 'terminals: terminal error' && d.message === 'Session missing'));
    assert.equal(s.graph.related(refs.thread(s.first.id), 'terminals').length, 0);
  } finally { await s.close(); }
});

test('a later list removes vanished sessions with exited or closed and refreshes fallback titles', async () => {
  const s = await setup();
  try {
    done(await s.invoke(refs.terminal('other'), 'close'));
    s.setSessions(s.sessions.filter((t) => !['two', 'other'].includes(t.id)));
    await s.refresh();
    assert.deepEqual(s.events, [['two', 'exited'], ['other', 'closed']]);
    assert.equal(s.terminal('two').gone, true);
    assert.equal(s.terminal('one').state.title, 'src');
    assert.equal(s.terminal('other').gone, true);
  } finally { await s.close(); }
});

test('every integrated operation sends the exact app operation and args with the decided effects', async () => {
  const s = await setup();
  try {
    const ref = refs.terminal('one');
    for (const [op, args, data] of [['run', ['echo hi'], 'echo hi\r'], ['write', ['text\n\x1b[A'], 'text\n\x1b[A'], ['clear', [], '\x0c'], ['stop', [], '\x03']]) {
      const r = done(await s.invoke(ref, op, args));
      assert.deepEqual(s.ops.at(-1), ['write', { sessionId: 'one', data }]);
      assert.equal(typeof r.intent, op === 'clear' ? 'undefined' : 'string', `${op}'s effect`);
    }
    const focus = done(await s.invoke(ref, 'focus'));
    assert.equal(focus.intent, undefined);
    assert.deepEqual(s.ops.at(-1), ['focus', { sessionId: 'one', threadId: s.first.id }]);
    s.answers.set('close', (args) => {
      s.report('exit', args.sessionId, { code: 7, signal: null });
      return { ok: true, result: {} };
    });
    assert.equal(typeof done(await s.invoke(ref, 'close')).intent, 'string');
    assert.deepEqual(s.ops.at(-1), ['close', { sessionId: 'one' }]);
    assert.deepEqual(s.events, [['one', 'closed']], 'remember close before the app\'s early exit report');
    assert.equal(s.terminal('one').gone, true);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('run and write ask R17 only for a mod, with truncated command and shell permissions; refusals ask nothing', async () => {
  const s = await setup();
  try {
    const ref = refs.terminal('one'), long = 'x'.repeat(90);
    done(await s.invoke(ref, 'run', [long], mod));
    done(await s.invoke(ref, 'write', ['text'], mod));
    assert.deepEqual(s.prompts, [
      { action: `run “${long.slice(0, 80)}” in the terminal “src 1”`, detail: 'It runs in your shell in /repo/src, with your permissions.' },
      { action: 'type into the terminal “src 1”', detail: 'It runs in your shell in /repo/src, with your permissions.' },
    ]);
    done(await s.invoke(ref, 'run', ['user command'], user));
    done(await s.invoke(ref, 'write', ['user text'], user));
    for (const op of ['clear', 'stop', 'close', 'focus']) done(await s.invoke(ref, op, [], mod));
    assert.equal(s.prompts.length, 2);
    const count = s.ops.length;
    s.approval.approved = false;
    refused(await s.invoke(ref, 'write', ['declined'], mod), 'notAllowed');
    assert.equal(s.ops.length, count);
    for (const op of ['run', 'write']) for (const text of ['', null, 4, 'x'.repeat(100_001)]) refused(await s.invoke(ref, op, [text], mod), 'invalid');
    assert.equal(s.prompts.length, 3, 'invalid writes and runs ask nothing');
    assert.equal(s.feed.prompt('run', refs.terminal('gone'), 'x'), null);
  } finally { await s.close(); }
});

test('gone, unknown, home focus, main refusals and main failures do not act again or mislabel a later exit as closed', async () => {
  const s = await setup();
  try {
    const count = s.ops.length;
    refused(await s.invoke(refs.terminal('home'), 'focus'), 'unavailable', 'the app shows a terminal beside a chat');
    refused(await s.invoke(refs.terminal('unknown'), 'write', ['x'], mod), 'unavailable');
    assert.equal(s.ops.length, count);
    s.answers.set('write', { ok: false, refused: true, error: 'window gone' });
    refused(await s.invoke(refs.terminal('one'), 'write', ['x']), 'unavailable', 'window gone');
    s.answers.set('write', { ok: false, error: 'app write failed' });
    assert.equal((await s.invoke(refs.terminal('one'), 'write', ['x'])).status, 'failed');
    for (const refusedMain of [true, false]) {
      s.answers.set('close', { ok: false, refused: refusedMain, error: 'close failed' });
      const r = await s.invoke(refs.terminal('one'), 'close');
      assert.equal(r.status, refusedMain ? 'refused' : 'failed');
    }
    assert.equal(s.ops.length, count + 4, 'each attempted operation is sent just once');
    s.report('exit', 'one', { code: 0, signal: null });
    assert.deepEqual(s.events, [['one', 'exited']]);
    for (const op of ['run', 'write', 'clear', 'stop', 'close', 'focus']) refused(await s.invoke(refs.terminal('one'), op, op === 'run' || op === 'write' ? ['x'] : []), 'unavailable');
    assert.equal(s.feed.prompt('write', refs.terminal('one'), 'x'), null);
  } finally { await s.close(); }
});

test('observe shares a running read, reads only after ten seconds, and failure preserves the resident sessions', async () => {
  const s = await setup();
  let release;
  try {
    const count = s.ops.length;
    s.setClock(110_000);
    await s.feed.observe(refs.terminal('one'), 'Terminal');
    assert.equal(s.ops.length, count);
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    s.setClock(110_001);
    let enter;
    const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
    s.answers.set('list', async () => { enter(); await gate; return { ok: true, result: { sessions: s.sessions } }; });
    const one = s.feed.observe(refs.terminal('one'), 'Terminal');
    assert.strictEqual(s.feed.observe(refs.terminal('two'), 'Terminal'), one);
    await entered;
    const view = s.graph.subscribe({ ref: refs.terminal('one') }, () => {});
    release(); await view.loaded; view.dispose(); await one;
    assert.equal(s.ops.length, count + 1);
    const before = s.graph.list('Terminal');
    s.answers.set('list', { ok: false, refused: true, error: 'manager unreachable' });
    await s.refresh();
    assert.deepEqual(s.graph.list('Terminal'), before);
    assert.deepEqual(s.events, []);
    assert.ok(s.warnings.some(([m, d]) => m === 'terminals: the terminals could not be read' && d.message === 'manager unreachable'));
  } finally { release?.(); await s.close(); }
});

test('attached reports debounce a new list by 300 ms; the periodic list runs every thirty seconds and disposal clears both timers', async (t) => {
  const s = await setup();
  try {
    // Only replace timers after the mux has started, so its own startup deadlines remain real.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    s.feed.dispose();
    const feed = terminals.createFeed(s.context);
    await feed.start();
    let count = s.ops.length;
    const next = session('new', s.first.id, '/repo/new');
    s.setSessions([...s.sessions, next]);
    s.report('attached', 'new', { cwd: next.cwd, shell: next.shell });
    s.report('attached', 'new', { cwd: next.cwd, shell: next.shell });
    t.mock.timers.tick(299);
    assert.equal(s.ops.length, count);
    t.mock.timers.tick(1);
    await feed.observe(refs.terminal('new'), 'Terminal');
    assert.equal(s.ops.length, ++count);
    assert.equal(s.terminal('new').state.title, 'new');
    assert.deepEqual(s.events, []);
    t.mock.timers.tick(29_700);
    await feed.observe(refs.terminal('new'), 'Terminal');
    assert.equal(s.ops.length, ++count);
    s.report('attached', 'later', { cwd: '/repo/later', shell: 'zsh' });
    feed.dispose();
    t.mock.timers.tick(90_000);
    await feed.start();
    assert.equal(s.ops.length, count);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test('a report during an in-flight list prevents that stale snapshot from restoring a terminal, and disposal prevents later puts', async () => {
  const s = await setup();
  let release;
  try {
    let enter;
    const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
    const snapshot = structuredClone(s.sessions);
    s.answers.set('list', async () => { enter(); await gate; return { ok: true, result: { sessions: snapshot } }; });
    s.setClock(120_000);
    const running = s.feed.observe(refs.terminal('one'), 'Terminal');
    await entered;
    s.report('exit', 'one', { code: 0, signal: null });
    release(); await running;
    assert.equal(s.terminal('one').gone, true);
    assert.deepEqual(s.events, [['one', 'exited']]);
    const before = s.graph.list('Terminal');
    let releaseNext;
    const next = new Promise((r) => { releaseNext = r; });
    s.answers.set('list', async () => { await next; return { ok: true, result: { sessions: snapshot } }; });
    s.setClock(140_000);
    const last = s.feed.observe(refs.terminal('one'), 'Terminal');
    s.feed.dispose(); releaseNext(); await last;
    assert.deepEqual(s.graph.list('Terminal'), before);
  } finally { release?.(); await s.close(); }
});

test('an attachment while a list is running queues a fresh list after the debounce, without overlapping reads', async (t) => {
  const s = await setup();
  let release;
  try {
    const snapshot = structuredClone(s.sessions), gate = new Promise((r) => { release = r; });
    let calls = 0, active = 0, peak = 0;
    s.answers.set('list', async () => {
      active++; peak = Math.max(peak, active);
      try {
        if (++calls === 1) { await gate; return { ok: true, result: { sessions: snapshot } }; }
        return { ok: true, result: { sessions: s.sessions } };
      } finally { active--; }
    });
    s.setClock(120_000);
    const running = s.feed.observe(refs.terminal('one'), 'Terminal');
    await until(() => calls === 1, 3000, 'the running list');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const next = session('attached-during-read', s.first.id, '/repo/new');
    s.setSessions([...snapshot, next]);
    s.report('attached', next.id, { cwd: next.cwd, shell: next.shell });
    t.mock.timers.tick(300);
    assert.equal(calls, 1);
    release(); await running;
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(s.terminal(next.id).state.title, 'new');
  } finally { release?.(); t.mock.timers.reset(); await s.close(); }
});

test('the agent terminal appears when the next turn starts, keeps its CommandRun link after core puts, and exits with the item', async () => {
  const s = await setup();
  try {
    const turn = await s.turn(), value = command(), run = await s.item(turn, value);
    const ref = refs.agentTerminal(s.first.id, value.id);
    assert.equal(s.graph.resolve(ref), null, 'a foreground command is not a background terminal');
    await s.turn();
    await until(() => s.graph.resolve(ref), 3000, 'background terminal');
    assert.deepEqual(s.graph.resolve(ref).state, { title: 'sleep 300', directory: '/repo', running: true, startedBy: 'agent', shell: '' });
    assert.deepEqual(s.graph.resolve(ref).links, { project: refs.project('repo'), thread: refs.thread(s.first.id) });
    assert.deepEqual(s.graph.resolve(run).links.terminal, ref);
    assert.deepEqual(s.graph.related(ref, 'commandRuns').map((x) => x.ref), [run]);
    await s.item(turn, { ...value, aggregatedOutput: 'still running' });
    assert.deepEqual(s.graph.resolve(run).links.terminal, ref, 'the core\'s replacement item put is followed by our link');
    const stop = done(await s.invoke(ref, 'stop', [], mod));
    assert.equal(typeof stop.intent, 'string');
    assert.deepEqual(s.requests.at(-1), { method: 'thread/backgroundTerminals/terminate', params: { threadId: s.first.id, processId: value.processId }, intent: stop.intent });
    const close = done(await s.invoke(ref, 'close', [], mod));
    assert.equal(typeof close.intent, 'string');
    assert.equal(s.requests.length, 2);
    assert.deepEqual(s.prompts, [], 'stopping and closing ask nothing');
    await s.item(turn, { ...value, status: 'completed', exitCode: 0 });
    assert.equal(s.graph.resolve(ref).gone, true);
    assert.equal(s.graph.resolve(run).links.terminal ?? null, null);
    assert.deepEqual(s.events, [[ref.id, 'exited']]);
    refused(await s.invoke(ref, 'stop'), 'unavailable');
  } finally { await s.close(); }
});

test('Project.newTerminal: the app makes it beside a chat; its Terminal (once listed) is the answer; a bad spec is refused before anything', async () => {
  const s = await setup();
  try {
    const project = refs.project('repo');
    const r = await s.invoke(project, 'newTerminal', [{ thread: refs.thread(s.first.id), path: '/repo/src' }], mod);
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.deepEqual(r.value, refs.terminal('made-6'));
    assert.deepEqual([s.terminal('made-6').state.directory, s.terminal('made-6').state.startedBy, s.terminal('made-6').links.thread], ['/repo/src', 'you', refs.thread(s.first.id)]);
    for (const spec of ['x', { path: 3 }, { thread: { type: 'Turn', provider: 'codex', id: 't' } }]) refused(await s.invoke(project, 'newTerminal', [spec]), 'invalid');
  } finally { await s.close(); }
});

test('Terminal.tail: the app\'s own terminal\'s last lines from framework-main, an agent\'s from its CommandRun\'s output; no intent, no prompt', async () => {
  const s = await setup();
  try {
    s.answers.set('tail', (args) => ({ ok: true, result: { text: `last ${args.lines}` } }));
    const one = done(await s.invoke(refs.terminal('one'), 'tail', [3], mod));
    assert.deepEqual([one.value, one.intent, s.ops.at(-1)], ['last 3', undefined, ['tail', { sessionId: 'one', lines: 3 }]]);
    assert.equal(done(await s.invoke(refs.terminal('one'), 'tail', [])).value, 'last 100', 'a hundred lines by default');
    refused(await s.invoke(refs.terminal('one'), 'tail', [0]), 'invalid');
    refused(await s.invoke(refs.terminal('one'), 'tail', [1001]), 'invalid');
    const turn = await s.turn(), value = command();
    await s.item(turn, value);
    await s.turn();
    const ref = refs.agentTerminal(s.first.id, value.id);
    await until(() => s.graph.resolve(ref), 3000, 'background terminal');
    await s.item(turn, { ...value, aggregatedOutput: 'one\r\ntwo\r\n\x1b[1mthree\x1b[0m\n' });
    const ops = s.ops.length;
    assert.equal(done(await s.invoke(ref, 'tail', [2], mod)).value, 'two\nthree');
    assert.equal(s.ops.length, ops, 'nothing asked of framework-main');
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('a completed turn can leave an agent terminal; processId and inProgress are required, and deleting its thread removes it', async () => {
  const s = await setup();
  try {
    const turn = await s.turn(), value = command();
    await s.item(turn, value);
    await s.item(turn, command('no-process', { processId: null }));
    await s.item(turn, command('ended', { status: 'completed' }));
    await s.note('turn/completed', { threadId: s.first.id, turn: { ...turn, status: 'completed', items: [] } });
    const ref = refs.agentTerminal(s.first.id, value.id);
    assert.ok(s.graph.resolve(ref));
    assert.equal(s.graph.list('Terminal').filter((x) => x.state.startedBy === 'agent').length, 1);
    await s.app('fake/forget', { threadId: s.first.id });
    await s.note('thread/deleted', { threadId: s.first.id });
    assert.equal(s.graph.resolve(ref).gone, true);
    assert.deepEqual(s.events, [[ref.id, 'exited']]);
    assert.equal(s.terminal('one').links.thread, null, 'the integrated session outlives its chat');
  } finally { await s.close(); }
});

test('the agent terminal refuses input, clear and focus, reports an ended command, and propagates a terminate failure', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    await s.item(turn, command());
    await s.turn();
    const ref = refs.agentTerminal(s.first.id, 'long'), count = s.ops.length;
    for (const [op, args] of [['run', ['echo hi']], ['write', ['text']], ['clear', []], ['focus', []]]) {
      refused(await s.invoke(ref, op, args, mod), 'unsupported', "the agent's terminal is read-only in the app");
    }
    assert.equal(s.feed.prompt('run', ref, 'echo hi'), null);
    assert.equal(s.feed.prompt('write', ref, 'text'), null);
    assert.equal(s.ops.length, count);
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.prompts, []);
    s.termination.terminated = false;
    for (const op of ['stop', 'close']) refused(await s.invoke(ref, op), 'unavailable', 'the command has already ended');
    s.termination.error = 'terminate failed';
    const failed = await s.invoke(ref, 'stop');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /terminate failed/);
    assert.equal(s.requests.length, 3);
  } finally { await s.close(); }
});

test('thread/read and thread/resume learn background items from their real response shape, using the held CommandRun title', async () => {
  const s = await setup();
  try {
    const old = await s.turn(), current = await s.turn();
    for (const [method, id] of [['thread/read', 'read'], ['thread/resume', 'resume']]) {
      const value = command(id, { command: '/bin/zsh -lc "echo hi"' });
      s.protocol.set(method, { thread: { ...s.first, turns: [{ ...old, items: [value] }, { ...current, items: [] }] } });
      const before = s.responses.length;
      await s.app(method, { threadId: s.first.id });
      await until(() => s.responses.slice(before).some(([m]) => m === method), 3000, method);
      const ref = refs.agentTerminal(s.first.id, id), run = refs.item('CommandRun', s.first.id, id);
      assert.ok(s.graph.resolve(ref));
      assert.equal(s.graph.resolve(ref).state.title, s.graph.resolve(run).state.command);
      assert.deepEqual(s.graph.resolve(run).links.terminal, ref);
    }
  } finally { await s.close(); }
});

test('thread/turns/list learns items after the core puts previously unseen turns and restores their links on a reread', async () => {
  const s = await setup();
  try {
    const older = { id: 'history-old', status: 'inProgress', startedAt: 10, completedAt: null, items: [command('history')] };
    const newest = { id: 'history-new', status: 'inProgress', startedAt: 10, completedAt: null, items: [command('foreground')] };
    s.protocol.set('thread/turns/list', { data: [newest, older], nextCursor: null });
    await s.source.loadThread(s.first.id);
    const ref = refs.agentTerminal(s.first.id, 'history'), foreground = refs.agentTerminal(s.first.id, 'foreground');
    await until(() => s.graph.resolve(ref), 3000, 'history terminal');
    assert.equal(s.graph.resolve(foreground), null, 'equal timestamps do not make the newest turn a background turn');
    assert.deepEqual(s.graph.resolve(refs.item('CommandRun', s.first.id, 'history')).links.terminal, ref);
    s.protocol.set('thread/turns/list', { data: [older], nextCursor: null });
    await s.app('thread/turns/list', { threadId: s.first.id, itemsView: 'full', cursor: 'older-page' });
    await new Promise(setImmediate);
    assert.ok(!s.graph.resolve(ref).gone, 'an older page with tied timestamps does not replace the known latest turn');
    s.protocol.set('thread/turns/list', { data: [newest, older], nextCursor: null });
    await s.app('thread/turns/list', { threadId: s.first.id, itemsView: 'full' });
    await new Promise(setImmediate);
    assert.deepEqual(s.graph.resolve(refs.item('CommandRun', s.first.id, 'history')).links.terminal, ref);
  } finally { await s.close(); }
});

test('without framework-main the list logs its refusal and leaves the collection empty', async () => {
  const s = await setup({ main: false });
  try {
    assert.deepEqual(s.graph.list('Terminal'), []);
    assert.ok(s.warnings.some(([m, d]) => m === 'terminals: the terminals could not be read' && d.message === 'framework-main is not running'));
    refused(await s.invoke(refs.terminal('one'), 'stop'), 'unavailable');
  } finally { await s.close(); }
});
