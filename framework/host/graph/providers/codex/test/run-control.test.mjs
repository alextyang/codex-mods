// Run control through the real graph, Codex source and mux. Threads, turns and items come from the fake app-server; main ops are answered
// here. The fake's unmodelled background-terminal methods are supplied by a test-only fake area at the mux, without changing shared fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userInput } from '../map.mjs';
import * as area from '../areas/run-control.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = { kind: 'mod', id: 'mod.run-control' };
const content = (text) => ({ parts: [{ kind: 'text', text }] });
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const refused = (r, reason, message) => {
  assert.equal(r.status, 'refused', JSON.stringify(r));
  assert.equal(r.reason, reason);
  if (message !== undefined) assert.equal(r.message, message);
};

/** The fake-area shape: method handlers use the supplied reply/fail senders. Registered only in this test's mux. */
function terminalArea(f, state) {
  return {
    'thread/backgroundTerminals/list': (m, p) => {
      state.calls.push({ method: m.method, params: p });
      if (state.error === m.method) return f.fail(m.id, -32000, 'terminal list failed');
      return f.reply(m.id, state.pages.get(p.cursor) ?? { data: [], nextCursor: null });
    },
    'thread/backgroundTerminals/terminate': (m, p) => {
      state.calls.push({ method: m.method, params: p });
      if (state.error === m.method) return f.fail(m.id, -32000, 'terminal terminate failed');
      return f.reply(m.id, { terminated: state.terminated });
    },
  };
}

async function setup({ main = true } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-run-control-'));
  const ops = [], requests = [], prompts = [], answers = new Map();
  const approval = { approved: true, reason: 'declined' };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return approval; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let seq = 0;
  const app = async (method, params) => {
    const r = await h.app.request(++seq, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    return r.result;
  };
  const note = (method, params) => app('fake/notify', { method, params });
  const terminals = { pages: new Map(), terminated: true, calls: [], error: null };
  const methods = terminalArea({ reply: (_id, result) => ({ respond: { result } }), fail: (_id, code, message) => ({ respond: { error: { code, message } } }) }, terminals);
  const fake = h.mux.client('test:run-control-terminals');
  fake.intercept('clientRequest', Object.keys(methods), (m) => methods[m.method](m, m.params));
  let mainOps = null;
  if (main) mainOps = createMainOps({ log: quiet, send: (m) => {
    ops.push({ area: m.area, op: m.op, args: m.args });
    queueMicrotask(async () => {
      try {
        let answer = answers.get(m.op);
        if (typeof answer === 'function') answer = await answer(m.args);
        if (!answer) {
          if (m.op === 'edit-last-turn') {
            const { threadId, turnId, message } = m.args;
            await app('thread/revert', { threadId, beforeTurnId: turnId });
            const { turn } = await app('turn/start', { threadId, input: userInput(content(message)) });
            await note('item/completed', { threadId, turnId: turn.id, item: { type: 'userMessage', id: `${turn.id}-user`, content: userInput(content(message)) } });
          }
          answer = { ok: true, result: {} };
        }
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, error: e.message }); }
    });
  } });
  let feed;
  const module = { ...area, createFeed(ctx) {
    feed = area.createFeed({ ...ctx, request(method, params, intent) {
      requests.push({ method, params: structuredClone(params), intent });
      return ctx.request(method, params, intent);
    } });
    return feed;
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, mainOps, areas: { 'run-control': module } });
  await source.start();
  const thread = async (title = 'Chat') => {
    const ref = refs.thread((await app('thread/start', { cwd: '/repo' })).thread.id);
    await app('thread/name/set', { threadId: ref.id, name: title });
    await until(() => graph.resolve(ref)?.state.title === title, 3000, 'the chat');
    return ref;
  };
  const ref = await thread();
  const item = async (turn, type, value, { running = false, at = 1000, id = value.id, threadId = ref.id } = {}) => {
    await note(running ? 'item/started' : 'item/completed', { threadId, turnId: turn.id, startedAtMs: at, item: value });
    const target = refs.item(type, threadId, id);
    await until(() => graph.resolve(target), 3000, `the ${type}`);
    return target;
  };
  const turn = async (text = 'Original', { running = false } = {}) => {
    if (running) await app('fake/hold', { threadId: ref.id });
    const target = refs.turn((await app('turn/start', { threadId: ref.id, input: userInput(content(text)) })).turn.id);
    await until(() => graph.resolve(target)?.state.status === (running ? 'running' : 'completed'), 3000, 'the turn');
    await item(target, 'UserMessage', { type: 'userMessage', id: `${target.id}-user`, content: userInput(content(text)) });
    return target;
  };
  return {
    h, graph, source, feed, ops, requests, prompts, answers, approval, terminals, app, note, thread, ref, item, turn,
    invoke: (ref, operation, args = [], caller = user) => graph.invoke({ ref, operation, args, caller }),
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); fake.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('copyText reads rich Content as text; requestOf takes the last request heading or the leading page context', () => {
  assert.equal(area.copyText({ parts: [
    { kind: 'text', text: '  Read ' }, { kind: 'code', language: 'js', text: 'go()' },
    { kind: 'link', text: 'docs', url: 'https://example.invalid' }, { kind: 'text', text: ' ' },
    { kind: 'fileLink', path: '/repo/a', line: 3 }, { kind: 'text', text: ' ' },
    { kind: 'mention', target: refs.file('/repo/b'), label: 'b' }, { kind: 'image', source: '/image.png' },
  ] }), 'Read \n```js\ngo()\n```\n[docs](https://example.invalid) /repo/a:3 @b');
  for (const value of [undefined, null, { parts: [] }, content('  '), { parts: [{ kind: 'image', source: '/image.png' }] }]) assert.equal(area.copyText(value), '');
  assert.equal(area.requestOf('context\n## My request:\n old\n## My request for Codex:\n latest '), 'latest');
  assert.equal(area.requestOf('## My request for Codex: old\n## My request: last'), 'last');
  assert.equal(area.requestOf('## My request: old\n## My request: last'), 'last');
  assert.equal(area.requestOf('<page-comment-context>\nquoted context\n</page-comment-context>\n  do this  '), 'do this');
  for (const text of [' plain text ', 'prefix <page-comment-context>\nx\n</page-comment-context>\nrequest', '<page-comment-context>\nunclosed']) assert.equal(area.requestOf(text), text);
});

test('every copy uses its held text: turn answer, both messages, every step kind, command and output; copies need no prompt', async () => {
  const s = await setup();
  try {
    const turn = await s.turn('What I asked');
    const answer = await s.item(turn, 'AgentMessage', { type: 'agentMessage', id: 'answer', text: 'Answer\n\n**yes**', phase: 'final_answer' });
    const cases = [[turn, 'copy', 'Answer\n\n**yes**'], [refs.item('UserMessage', s.ref.id, `${turn.id}-user`), 'copy', 'What I asked'], [answer, 'copy', 'Answer\n\n**yes**']];
    const command = await s.item(turn, 'CommandRun', { type: 'commandExecution', id: 'cmd', command: 'printf hi', cwd: '/repo', aggregatedOutput: 'hi\n', status: 'completed' });
    cases.push([command, 'copy', 'printf hi'], [command, 'copyCommand', 'printf hi'], [command, 'copyOutput', 'hi\n']);
    const reasoning = await s.item(turn, 'Reasoning', { type: 'reasoning', id: 'thinking', summary: ['First', 'Then'] });
    cases.push([reasoning, 'copy', 'First\nThen']);
    await s.note('turn/plan/updated', { threadId: s.ref.id, turnId: turn.id, explanation: 'Plan', plan: [
      { step: 'Done', status: 'completed' }, { step: 'Doing', status: 'inProgress' }, { step: 'Next', status: 'pending' },
    ] });
    const plan = await until(() => s.graph.list('Plan')[0], 3000, 'the plan');
    cases.push([plan.ref, 'copy', '- [x] Done\n- [ ] Doing\n- [ ] Next']);
    const file = await s.item(turn, 'FileEdit', { type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: '/repo/change.mjs' }] }, { id: 'edit:0' });
    cases.push([file, 'copy', '/repo/change.mjs']);
    const search = await s.item(turn, 'Search', { type: 'webSearch', id: 'search', query: 'a query', action: { type: 'search', query: 'a query' } });
    const web = await s.item(turn, 'WebLookup', { type: 'webSearch', id: 'web', action: { type: 'openPage', url: 'https://example.invalid/page' } });
    cases.push([search, 'copy', 'a query'], [web, 'copy', 'https://example.invalid/page']);
    const tool = await s.item(turn, 'ToolCall', { type: 'mcpToolCall', id: 'tool', server: 'echo', tool: 'echo', arguments: { text: 'input' }, result: 'output', status: 'completed' });
    const input = await s.item(turn, 'ToolCall', { type: 'mcpToolCall', id: 'input', server: 'echo', tool: 'echo', arguments: { text: 'input' }, status: 'completed' });
    cases.push([tool, 'copy', 'output'], [input, 'copy', '{"text":"input"}']);
    const computer = await s.item(turn, 'ComputerAction', { type: 'mcpToolCall', id: 'computer', server: 'computer-use', tool: 'click', arguments: { app: 'com.example.fake' }, status: 'completed' });
    const child = await s.thread('Child');
    const delegation = await s.item(turn, 'Delegation', { type: 'collabAgentToolCall', id: 'delegate', tool: 'spawn', prompt: 'Research this', receiverThreadIds: [child.id], status: 'completed' });
    const step = await s.item(turn, 'Step', { type: 'contextCompaction', id: 'other' });
    cases.push([computer, 'copy', 'click'], [delegation, 'copy', 'Research this'], [step, 'copy', 'Compacted the context']);
    for (const [ref, operation, text] of cases) {
      const result = await s.invoke(ref, operation, [], mod);
      done(result);
      assert.equal(result.intent, undefined, 'copy is a local effect');
      assert.deepEqual(s.ops.at(-1), { area: 'run-control', op: 'copy', args: { text } });
      if (operation === 'copy' && s.graph.type(ref.type).concept === 'Step') assert.equal(area.stepText(s.graph.resolve(ref), s.graph), text);
    }
    assert.equal(s.ops.length, cases.length);
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('copy refuses an unanswered turn, empty message, empty command output and empty step output without a main op', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    refused(await s.invoke(turn, 'copy', [], mod), 'unavailable', 'the turn has no answer yet');
    const message = await s.item(turn, 'UserMessage', { type: 'userMessage', id: 'empty', content: [] });
    refused(await s.invoke(message, 'copy', [], mod), 'unavailable', 'there is nothing to copy');
    const command = await s.item(turn, 'CommandRun', { type: 'commandExecution', id: 'empty-output', command: '', aggregatedOutput: '', cwd: '/repo', status: 'completed' });
    refused(await s.invoke(command, 'copyOutput', [], mod), 'unavailable', 'the command has no output yet');
    refused(await s.invoke(command, 'copyCommand', [], mod), 'unavailable', 'there is nothing to copy');
    const tool = await s.item(turn, 'ToolCall', { type: 'mcpToolCall', id: 'empty-tool', server: 'echo', tool: 'echo', arguments: { useful: true }, result: '', status: 'completed' });
    refused(await s.invoke(tool, 'copy', [], mod), 'unavailable', 'there is nothing to copy');
    assert.deepEqual(s.ops, []);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('retry and rewind use the app edit, unwrap requests, return its new Turn and let the core remove reverted history', async () => {
  const s = await setup();
  try {
    for (const [text, operation, args, expected] of [
      ['Context\n## My request:\nPlease retry', 'retry', [], 'Please retry'],
      ['<page-comment-context>\nContext\n</page-comment-context>\nPlease rewind', 'rewind', [], 'Please rewind'],
      ['Original', 'rewind', [content('Edited message')], 'Edited message'],
      ['Context\n## My request for Codex:\nPlease retry too', 'retry', [], 'Please retry too'],
    ]) {
      const turn = await s.turn(text);
      const output = done(await s.invoke(turn, operation, args));
      assert.deepEqual(s.ops.at(-1), { area: 'run-control', op: 'edit-last-turn', args: { threadId: s.ref.id, turnId: turn.id, message: expected } });
      assert.equal(output.type, 'CodexTurn');
      assert.equal(output.provider, 'codex');
      assert.notEqual(output.id, turn.id);
      await until(() => s.graph.resolve(output)?.state.status === 'completed', 3000, 'the new turn');
      assert.equal(s.graph.resolve(turn).gone, true);
      assert.equal(s.graph.resolve(refs.item('UserMessage', s.ref.id, `${turn.id}-user`)).gone, true);
    }
    assert.deepEqual(s.requests, [], 'the area does no history read or direct turn start');
    assert.deepEqual(s.prompts, [], 'a user caller asks nothing');
  } finally { await s.close(); }
});

test('retry chooses the earliest input message by createdAt, including when it arrived after steering', async () => {
  const s = await setup();
  try {
    const turn = await s.turn('Later message');
    await s.item(turn, 'UserMessage', { type: 'userMessage', id: 'steer', content: userInput(content('Steering')) }, { at: 3000 });
    await s.item(turn, 'UserMessage', { type: 'userMessage', id: 'first', content: userInput(content('## My request: First message')) }, { at: 100 });
    done(await s.invoke(turn, 'retry'));
    assert.equal(s.ops.at(-1).args.message, 'First message');
  } finally { await s.close(); }
});

test('running turns, empty rewind content and absent input refuse before main ops and R17 prompts', async () => {
  const s = await setup();
  try {
    const running = await s.turn('Working', { running: true });
    for (const [operation, args] of [['retry', []], ['rewind', []], ['rewind', [content('changed')]]]) {
      refused(await s.invoke(running, operation, args, mod), 'unavailable', 'the turn is still running');
    }
    const completed = await s.turn();
    for (const value of [content(''), content('  '), { parts: [] }, { parts: [{ kind: 'image', source: '/image.png' }] }]) {
      refused(await s.invoke(completed, 'rewind', [value], mod), 'invalid', "rewind takes the message's new text");
    }
    const empty = refs.turn('no-input');
    await s.note('turn/completed', { threadId: s.ref.id, turn: { id: empty.id, status: 'completed', items: [], error: null } });
    await until(() => s.graph.resolve(empty), 3000, 'turn without input');
    refused(await s.invoke(empty, 'retry', [], mod), 'unavailable');
    refused(await s.invoke(empty, 'rewind', [], mod), 'unavailable');
    assert.deepEqual(s.ops, []);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('R17 describes retry and rewind for a mod caller; denial makes no main call', async () => {
  const s = await setup();
  try {
    const detail = 'Codex removes that turn and any after it from the chat, then runs the message again, which counts toward your usage. Files it changed stay as they are.';
    const turn = await s.turn();
    const retried = done(await s.invoke(turn, 'retry', [], mod));
    // The retried turn runs to its end before it can be rewound ("the turn is still running" otherwise: the fake answers asynchronously).
    await until(() => s.graph.resolve(retried)?.state.status === 'completed', 3000, 'the retried turn');
    done(await s.invoke(retried, 'rewind', [content('New message')], mod));
    assert.deepEqual(s.prompts, [
      { action: 'run the last message of “Chat” again', detail },
      { action: 'edit the last message of “Chat” and run it again', detail },
    ]);
    s.approval.approved = false;
    const denied = await s.turn();
    const count = s.ops.length;
    refused(await s.invoke(denied, 'retry', [], mod), 'notAllowed');
    assert.equal(s.ops.length, count);
  } finally { await s.close(); }
});

test('main refusals pass through as unavailable, failures stay failures, and missing framework-main refuses', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    for (const error of ['Only the most recent message can be edited.', 'Cannot edit a message while a turn is in progress.', 'Turn not found for edit.', 'Editing messages is not available for threads using paginated history.']) {
      s.answers.set('edit-last-turn', { ok: false, refused: true, error });
      refused(await s.invoke(turn, 'retry'), 'unavailable', error);
    }
    s.answers.set('edit-last-turn', { ok: false, error: 'edit failed' });
    const failure = await s.invoke(turn, 'rewind', [content('New')]);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error.message, 'edit failed');
    const message = refs.item('UserMessage', s.ref.id, `${turn.id}-user`);
    s.answers.set('copy', { ok: false, refused: true, error: 'no clipboard' });
    refused(await s.invoke(message, 'copy'), 'unavailable', 'no clipboard');
    s.answers.set('copy', { ok: false, error: 'clipboard failed' });
    assert.equal((await s.invoke(message, 'copy')).error.message, 'clipboard failed');
  } finally { await s.close(); }
  const missing = await setup({ main: false });
  try {
    const turn = await missing.turn();
    refused(await missing.invoke(turn, 'retry'), 'unavailable', 'framework-main is not running');
  } finally { await missing.close(); }
});

test('the edit wait ignores earlier starts and other threads, and returns a later start after the main reply', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    const other = await s.thread('Other');
    s.answers.set('edit-last-turn', { ok: true, result: {} });
    let settled = false;
    const waiting = s.invoke(turn, 'retry').then((r) => { settled = true; return r; });
    await until(() => s.ops.length === 1, 3000, 'the edit call');
    await s.app('turn/start', { threadId: other.id, input: [] });
    await new Promise(setImmediate);
    assert.equal(settled, false);
    const started = await s.app('turn/start', { threadId: s.ref.id, input: [] });
    assert.deepEqual(done(await waiting), refs.turn(started.turn.id));
  } finally { await s.close(); }
});

test('an edit with no new start returns null at 20 seconds; disposing ends all pending waits with null', async (t) => {
  const s = await setup();
  try {
    const turn = await s.turn();
    s.answers.set('edit-last-turn', { ok: true, result: {} });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const waiting = s.invoke(turn, 'retry').then((r) => { settled = true; return r; });
    await new Promise(setImmediate);
    t.mock.timers.tick(19_999);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(done(await waiting), null);
    t.mock.timers.reset();
    const first = s.invoke(turn, 'retry'), second = s.invoke(turn, 'rewind', [content('New')]);
    await until(() => s.ops.length === 3, 3000, 'both edit calls');
    await s.source.dispose();
    assert.equal(done(await first), null);
    assert.equal(done(await second), null);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test('stop pages to the background terminal, terminates its process with the intent, and leaves completion to the item notification', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    const item = { type: 'commandExecution', id: 'cmd:part', command: 'sleep 60', cwd: '/repo', aggregatedOutput: '', status: 'inProgress' };
    const command = await s.item(turn, 'CommandRun', item, { running: true });
    const terminal = { itemId: item.id, processId: 'process-7', command: item.command, cwd: item.cwd };
    s.terminals.pages.set(null, { data: [{ ...terminal, itemId: 'other', processId: 'other-process' }], nextCursor: 'page-2' });
    s.terminals.pages.set('page-2', { data: [terminal], nextCursor: null });
    const result = await s.invoke(command, 'stop', [], mod);
    done(result);
    assert.ok(result.intent);
    const expected = [
      { method: 'thread/backgroundTerminals/list', params: { threadId: s.ref.id, cursor: null } },
      { method: 'thread/backgroundTerminals/list', params: { threadId: s.ref.id, cursor: 'page-2' } },
      { method: 'thread/backgroundTerminals/terminate', params: { threadId: s.ref.id, processId: 'process-7' } },
    ];
    assert.deepEqual(s.terminals.calls, expected);
    assert.deepEqual(s.requests, expected.map((r) => ({ ...r, intent: result.intent })));
    assert.equal(s.graph.resolve(command).state.status, 'running');
    await s.note('item/completed', { threadId: s.ref.id, turnId: turn.id, item: { ...item, status: 'completed', exitCode: 0 } });
    await until(() => s.graph.resolve(command)?.state.status === 'done', 3000, 'the command completion');
    assert.deepEqual(s.ops, []);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('stop refuses non-background, already ended and non-running commands, and protocol failures remain failures', async () => {
  const s = await setup();
  try {
    const turn = await s.turn();
    const command = await s.item(turn, 'CommandRun', { type: 'commandExecution', id: 'cmd', command: 'sleep 60', cwd: '/repo', status: 'inProgress' }, { running: true });
    s.terminals.pages.set(null, { data: [], nextCursor: 'last' });
    s.terminals.pages.set('last', { data: [], nextCursor: null });
    refused(await s.invoke(command, 'stop', [], mod), 'unsupported', 'it is not running in the background: stop the turn to stop it');
    assert.deepEqual(s.terminals.calls.map((r) => r.params.cursor), [null, 'last']);
    s.terminals.pages.set(null, { data: [{ itemId: 'cmd', processId: 'process', cwd: '/repo', command: 'sleep 60' }], nextCursor: null });
    s.terminals.terminated = false;
    refused(await s.invoke(command, 'stop', [], mod), 'unavailable', 'the command has already ended');
    for (const method of ['thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate']) {
      s.terminals.error = method;
      const failure = await s.invoke(command, 'stop');
      assert.equal(failure.status, 'failed');
      assert.match(failure.error.message, /terminal (list|terminate) failed/);
    }
    await s.note('item/completed', { threadId: s.ref.id, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd', command: 'sleep 60', cwd: '/repo', status: 'completed' } });
    await until(() => s.graph.resolve(command)?.state.status === 'done', 3000, 'ended command');
    const before = s.requests.length;
    refused(await s.invoke(command, 'stop', [], mod), 'unavailable', 'the command is not running');
    assert.equal(s.requests.length, before);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('handlers refuse missing resident instances without trying main or protocol operations', async () => {
  const s = await setup();
  try {
    const turn = refs.turn('missing'), command = refs.item('CommandRun', s.ref.id, 'missing');
    for (const [ref, kind] of [[turn, 'turn'], [command, 'step'], [command, 'command'], [command, 'output'], [refs.item('UserMessage', s.ref.id, 'missing'), 'message']]) {
      refused(await s.feed.copy(ref, kind), 'unavailable');
    }
    refused(await s.feed.edit(turn), 'unavailable');
    refused(await s.feed.stop(command, 'intent'), 'unavailable');
    assert.deepEqual(s.ops, []);
    assert.deepEqual(s.requests, []);
  } finally { await s.close(); }
});
