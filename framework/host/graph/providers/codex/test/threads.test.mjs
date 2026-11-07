// Thread's D5 area through the real source, graph and mux with the fake app-server. Framework-main's operations are answered here;
// hand-made feed contexts cover protocol/service failures the core fake deliberately cannot produce, and pin refresh deadlines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userInput } from '../map.mjs';
import * as threads from '../areas/threads.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = { kind: 'mod', id: 'mod.a' };
const content = (text) => ({ parts: [{ kind: 'text', text }] });
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const refused = (r, reason) => { assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason); };

async function setup({ pinned = false, approvals = true } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-threads-'));
  const prompts = [], ops = [], warnings = [], answers = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log,
    ...(approvals ? { approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved: true }; } } } : {}) });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let seq = 0;
  const ask = (method, params) => h.app.request(++seq, method, params);
  const first = (await ask('thread/start', { cwd: '/repo' })).result.thread;
  await ask('thread/name/set', { threadId: first.id, name: 'Chat' });
  const pins = new Set(pinned ? [first.id] : []);
  let mainOps;
  mainOps = createMainOps({ log, send: (m) => {
    ops.push({ op: m.op, args: m.args, area: m.area });
    queueMicrotask(() => {
      let answer = answers.get(m.op);
      if (!answer) {
        if (m.op === 'pin') { if (m.args.pinned) pins.add(m.args.threadId); else pins.delete(m.args.threadId); }
        const result = m.op === 'pinned' ? { threadIds: [...pins] } : m.op === 'delete' ? { deletedThreadIds: [m.args.threadId] } : {};
        answer = { ok: true, result };
      }
      mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer });
    });
  } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, mainOps, areas: { threads }, pageSize: 2 });
  await source.start();
  const ref = refs.thread(first.id);
  await until(() => graph.resolve(ref)?.state.pinned === pinned, 3000, 'pins at start');
  return {
    h, graph, source, ref, ask, ops, pins, prompts, warnings, answers,
    calls: (method) => h.serverLog().map((line) => JSON.parse(line.slice(line.indexOf('{')))).filter((m) => !method || m.method === method),
    invoke: (operation, args = [], caller = user, target = ref) => graph.invoke({ ref: target, operation, args, caller }),
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('send and steer use app input, fresh message ids and the running turn; stop pauses an active goal before interrupt and terminal cleanup', async () => {
  const s = await setup();
  try {
    refused(await s.invoke('steer', [content('idle')], mod), 'unavailable');
    refused(await s.invoke('send', [content('  ')], mod), 'invalid');
    done(await s.invoke('stop'));
    assert.equal(s.calls('turn/start').length, 0);
    assert.equal(s.calls('turn/interrupt').length, 0);
    assert.deepEqual(s.prompts, []);
    await s.ask('fake/hold', { threadId: s.ref.id });
    const message = { parts: [{ kind: 'text', text: 'Look at ' }, { kind: 'mention', target: refs.file('/repo/a.mjs'), label: 'a.mjs' }] };
    const turn = done(await s.invoke('send', [message]));
    assert.deepEqual(turn, refs.turn('turn-1'));
    await until(() => s.graph.resolve(turn)?.state.status === 'running', 3000, 'running turn');
    const sent = s.calls('turn/start')[0].params;
    assert.deepEqual({ threadId: sent.threadId, input: sent.input }, { threadId: s.ref.id, input: userInput(message) });
    assert.match(sent.clientUserMessageId, /^[0-9a-f-]{36}$/);
    refused(await s.invoke('send', [content('second')], mod), 'unavailable');
    refused(await s.invoke('compact', [], mod), 'unavailable');
    refused(await s.invoke('steer', [{ parts: [] }], mod), 'invalid');
    assert.deepEqual(s.prompts, []);
    done(await s.invoke('steer', [content('focus here')]));
    const steered = s.calls('turn/steer')[0].params;
    assert.deepEqual({ threadId: steered.threadId, expectedTurnId: steered.expectedTurnId, input: steered.input }, { threadId: s.ref.id, expectedTurnId: turn.id, input: userInput(content('focus here')) });
    assert.match(steered.clientUserMessageId, /^[0-9a-f-]{36}$/);
    assert.notEqual(steered.clientUserMessageId, sent.clientUserMessageId);
    done(await s.invoke('setGoal', ['Finish this']));
    await until(() => s.graph.resolve(s.ref).state.goal?.status === 'active', 3000, 'active goal');
    const before = s.calls().length;
    done(await s.invoke('stop'));
    await until(() => s.graph.resolve(turn)?.state.status === 'stopped', 3000, 'stopped turn');
    assert.deepEqual(s.calls().slice(before).map((m) => [m.method, m.params]), [
      ['thread/goal/set', { threadId: s.ref.id, status: 'paused' }],
      ['turn/interrupt', { threadId: s.ref.id, turnId: turn.id }],
      ['thread/backgroundTerminals/clean', { threadId: s.ref.id }],
    ]);
    assert.equal(s.graph.resolve(s.ref).state.goal.status, 'paused');
    assert.deepEqual(s.graph.resolve(turn).state.stoppedBy, { kind: 'user', via: 'operation' }, 'stopped by its caller');
    done(await s.invoke('stop'));
    assert.equal(s.calls('turn/interrupt').length, 1, 'idle stop does nothing');
    done(await s.invoke('compact'));
    assert.deepEqual(s.calls('thread/compact/start').map((m) => m.params), [{ threadId: s.ref.id }]);
  } finally { await s.close(); }
});

test('Turn.stoppedBy: the app\'s own interrupt is the user\'s; its `stopped` event carries it; a turn that completes has none', async () => {
  const s = await setup();
  const events = [];
  s.graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'CodexTurn') events.push([e.name, e.payload]); });
  try {
    await s.ask('fake/hold', { threadId: s.ref.id });
    const turn = done(await s.invoke('send', [content('work')]));
    await until(() => s.graph.resolve(turn)?.state.status === 'running', 3000, 'running');
    // another client's interrupt the server refuses (a chat it does not have) says nothing about who stops the turn later
    await assert.rejects(s.h.mux.client('mod:unit.evil').request('turn/interrupt', { threadId: 'not-this-chat', turnId: turn.id }));
    await s.ask('turn/interrupt', { threadId: s.ref.id, turnId: turn.id });   // the app's stop button
    await until(() => s.graph.resolve(turn)?.state.status === 'stopped', 3000, 'stopped');
    await until(() => events.some(([name]) => name === 'stopped'), 3000, 'its stopped event');
    assert.deepEqual(s.graph.resolve(turn).state.stoppedBy, { kind: 'user' });
    assert.deepEqual(events.find(([name]) => name === 'stopped'), ['stopped', { by: { kind: 'user' } }]);
    const next = done(await s.invoke('send', [content('again')]));
    await until(() => s.graph.resolve(next)?.state.status === 'completed', 3000, 'completed');
    assert.equal(s.graph.resolve(next).state.stoppedBy, undefined);
  } finally { await s.close(); }
});

test('archive prepares worktree cleanup, archives and unpins; restore prepares the app then unarchives; repeated calls do nothing', async () => {
  const s = await setup({ pinned: true });
  try {
    s.ops.length = 0;
    done(await s.invoke('archive', [], mod));
    await until(() => s.graph.resolve(s.ref).state.archived, 3000, 'archived');
    assert.equal(s.graph.resolve(s.ref).state.pinned, false);
    assert.deepEqual(s.ops, [
      { area: 'threads', op: 'archive-prepare', args: { threadId: s.ref.id, cwd: '/repo' } },
      { area: 'threads', op: 'pin', args: { threadId: s.ref.id, pinned: false } },
      { area: 'threads', op: 'pinned', args: {} },
    ]);
    assert.deepEqual(s.calls('thread/archive').map((m) => m.params), [{ threadId: s.ref.id }]);
    const count = s.ops.length;
    done(await s.invoke('archive'));
    assert.equal(s.ops.length, count);
    done(await s.invoke('restore', [], mod));
    await until(() => s.graph.resolve(s.ref).state.archived === false, 3000, 'restored');
    assert.deepEqual(s.ops.at(-1), { area: 'threads', op: 'restore-prepare', args: { threadId: s.ref.id } });
    assert.deepEqual(s.calls('thread/unarchive').map((m) => m.params), [{ threadId: s.ref.id }]);
    done(await s.invoke('restore'));
    assert.equal(s.calls('thread/unarchive').length, 1);
    assert.deepEqual(s.prompts, [], 'archive and restore ask nothing');
  } finally { await s.close(); }
});

test('open, fork with and without a turn, archived-only delete, and setModel through thread settings', async () => {
  const s = await setup();
  try {
    done(await s.invoke('open'));
    assert.deepEqual(s.ops.at(-1), { area: 'threads', op: 'open', args: { threadId: s.ref.id } });
    const fork = done(await s.invoke('fork'));
    assert.equal(fork.type, 'CodexThread');
    assert.notEqual(fork.id, s.ref.id);
    await until(() => s.graph.resolve(fork), 3000, 'fork put by the core');
    const turn = done(await s.invoke('send', [content('first')]));
    await until(() => s.graph.resolve(turn)?.state.status === 'completed', 3000, 'completed turn');
    const at = done(await s.invoke('fork', [turn]));
    assert.notEqual(at.id, fork.id);
    assert.deepEqual(s.calls('thread/fork').map((m) => m.params), [{ threadId: s.ref.id }, { threadId: s.ref.id, lastTurnId: turn.id }]);
    refused(await s.invoke('fork', [turn], user, fork), 'invalid');
    refused(await s.invoke('fork', [{ ...turn, provider: 'other' }]), 'invalid');
    refused(await s.invoke('fork', [refs.turn('missing')]), 'invalid');
    refused(await s.invoke('fork', [refs.model('fake')]), 'invalid');
    refused(await s.invoke('delete', [], mod), 'unsupported');
    assert.equal(s.ops.filter((m) => m.op === 'delete').length, 0);
    done(await s.invoke('setModel', [refs.model('fake-mini')]));
    const settings = (await s.ask('fake/threadSettings', { threadId: s.ref.id })).result;
    assert.deepEqual(settings.params, { threadId: s.ref.id, model: 'fake-mini' });
    assert.equal(settings.threadSettings.model, 'fake-mini');
    refused(await s.invoke('setModel', [{ ...refs.model('fake'), provider: 'other' }]), 'invalid');
    refused(await s.invoke('setModel', [s.ref]), 'invalid');
    done(await s.invoke('archive'));
    await until(() => s.graph.resolve(s.ref).state.archived, 3000, 'archived for deletion');
    done(await s.invoke('delete'));
    assert.deepEqual(s.ops.at(-1), { area: 'threads', op: 'delete', args: { threadId: s.ref.id } });
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('pins at start, pin/unpin and a new thread all follow the app pins', async () => {
  const s = await setup({ pinned: true });
  try {
    assert.equal(s.graph.resolve(s.ref).state.pinned, true);
    const before = s.ops.length;
    done(await s.invoke('pin'));
    assert.equal(s.ops.length, before, 'already pinned');
    done(await s.invoke('unpin'));
    assert.equal(s.graph.resolve(s.ref).state.pinned, false);
    done(await s.invoke('unpin'));
    done(await s.invoke('pin'));
    assert.equal(s.graph.resolve(s.ref).state.pinned, true);
    assert.deepEqual(s.ops.filter((m) => m.op === 'pin').map((m) => m.args.pinned), [false, true]);
    assert.equal(s.ops.filter((m) => m.op === 'pinned').length, 3, 'start, after unpin and after pin');
    s.pins.add('thr-primary-2');
    done(await s.invoke('unpin'));
    const reads = s.ops.filter((m) => m.op === 'pinned').length;
    const newThread = (await s.ask('thread/start', { cwd: '/another' })).result.thread;
    await until(() => s.graph.resolve(refs.thread(newThread.id))?.state.pinned !== undefined, 3000, 'new thread pin from the cached pins');
    assert.equal(s.graph.resolve(refs.thread(newThread.id)).state.pinned, true);
    assert.equal(s.ops.filter((m) => m.op === 'pinned').length, reads, 'thread/started uses the cached pins');
    s.pins.delete(newThread.id);
    done(await s.invoke('pin'));
    assert.equal(s.graph.resolve(refs.thread(newThread.id)).state.pinned, false, 'a pin refresh updates every resident chat');
  } finally { await s.close(); }
});

test('export loads turns and returns transcript markdown in turn order, with all input messages and final answers', async () => {
  const s = await setup();
  try {
    const first = done(await s.invoke('send', [content('First')]));
    // Its own turn: an empty list of turns would pass at once, before the first turn is even put.
    await until(() => s.graph.resolve(first)?.state.status === 'completed', 3000, 'first answer');
    await s.ask('fake/hold', { threadId: s.ref.id });
    const held = done(await s.invoke('send', [content('Second')]));
    await until(() => s.graph.resolve(held)?.state.status === 'running', 3000, 'second turn');
    done(await s.invoke('steer', [content('And this')]));
    await s.source.loadThread(s.ref.id);
    // The core fake's history has equal start times and no final-answer phase. Supply the production notifications for those facts.
    await s.ask('fake/notify', { method: 'turn/completed', params: { threadId: s.ref.id, turn: { id: first.id, status: 'completed', error: null, items: [], startedAt: 1 } } });
    await s.ask('fake/notify', { method: 'turn/started', params: { threadId: s.ref.id, turn: { id: held.id, status: 'inProgress', error: null, items: [], startedAt: 2 } } });
    await s.ask('fake/notify', { method: 'item/completed', params: { threadId: s.ref.id, turnId: first.id, item: { type: 'agentMessage', id: `${first.id}-msg`, text: 'abc', phase: 'final_answer' } } });
    await until(() => s.graph.resolve(first).links.answer, 3000, 'final answer');
    const exported = done(await s.invoke('export'));
    assert.deepEqual(exported, content('# Chat\n\n**You:** First\n\n**Codex:** abc\n\n**You:** Second\n\nAnd this'));
    assert.ok(s.calls('thread/turns/list').length > 0);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('R17 prompts describe send, steer, compact and delete for mods; user calls and refused/no-op operations ask nothing', async () => {
  const s = await setup();
  try {
    refused(await s.invoke('delete', [], mod), 'unsupported');
    refused(await s.invoke('steer', [content('idle')], mod), 'unavailable');
    refused(await s.invoke('send', [{ parts: [] }], mod), 'invalid');
    await s.ask('fake/hold', { threadId: s.ref.id });
    const turn = done(await s.invoke('send', [content('work')], mod));
    await until(() => s.graph.resolve(turn)?.state.status === 'running', 3000, 'running');
    refused(await s.invoke('send', [content('busy')], mod), 'unavailable');
    refused(await s.invoke('compact', [], mod), 'unavailable');
    done(await s.invoke('steer', [content('adjust')], mod));
    done(await s.invoke('stop', [], mod));
    await until(() => s.graph.resolve(turn)?.state.status === 'stopped', 3000, 'stopped');
    assert.deepEqual(s.graph.resolve(turn).state.stoppedBy, { kind: 'mod', id: mod.id, via: 'operation' });
    done(await s.invoke('compact', [], mod));
    done(await s.invoke('pin', [], mod));
    done(await s.invoke('open', [], mod));
    done(await s.invoke('fork', [], mod));
    done(await s.invoke('setModel', [refs.model('fake')], mod));
    done(await s.invoke('export', [], mod));
    done(await s.invoke('archive', [], mod));
    await until(() => s.graph.resolve(s.ref).state.archived, 3000, 'archived');
    done(await s.invoke('delete', [], mod));
    assert.deepEqual(s.prompts, [
      { action: 'send a message in “Chat”', detail: "Codex works on it with this chat's permissions, and it counts toward your usage." },
      { action: 'steer “Chat”', detail: "Codex works on it with this chat's permissions, and it counts toward your usage." },
      { action: 'compact the chat “Chat”', detail: 'Codex summarizes it to free context, which counts toward your usage.' },
      { action: 'delete the chat “Chat”', detail: 'It cannot be restored.' },
    ]);
    done(await s.invoke('restore'));
    await until(() => !s.graph.resolve(s.ref).state.archived, 3000, 'restored');
    done(await s.invoke('send', [content('user work')]));
    await until(() => s.graph.list('Turn').every((x) => x.state.status !== 'running'), 3000, 'user turn completed');
    done(await s.invoke('compact'));
    done(await s.invoke('archive'));
    await until(() => s.graph.resolve(s.ref).state.archived, 3000, 'archived again');
    done(await s.invoke('delete'));
    assert.equal(s.prompts.length, 4, 'user calls add no prompts');
  } finally { await s.close(); }
});

test('R17 cannot dispatch a mod send when the user cannot be asked; a user send still works', async () => {
  const s = await setup({ approvals: false });
  try {
    refused(await s.invoke('send', [content('mod')], mod), 'unavailable');
    assert.equal(s.calls('turn/start').length, 0);
    done(await s.invoke('send', [content('user')]));
    assert.equal(s.calls('turn/start').length, 1);
  } finally { await s.close(); }
});

function context({ pinned = false, archived = false, goal, turns = [] } = {}) {
  const ref = refs.thread('t');
  const thread = { ref, state: { title: 'Chat', pinned, archived, ...(goal ? { goal } : {}) }, links: {} };
  const instances = [thread, ...turns.map(([id, startedAt, status = 'running']) => ({ ref: refs.turn(id), state: { startedAt, status }, links: { thread: ref } }))];
  const calls = [], warnings = [], pins = new Set(pinned ? ['t'] : []);
  const s = { ref, thread, instances, calls, warnings, pins, up: true, main: null, request: null, loads: [] };
  const resident = (r) => instances.find((x) => x.ref.type === r.type && x.ref.provider === r.provider && x.ref.id === r.id) ?? null;
  s.ctx = {
    graph: { list: () => instances.filter((x) => x.ref.type === 'CodexThread'), type: (type) => ({ concept: type === 'SpecialModel' ? 'Model' : type === 'CodexTurn' ? 'Turn' : type }),
      referrers: (r, relation) => instances.filter((x) => x.links[relation]?.id === r.id && x.links[relation]?.provider === r.provider) },
    resident, log: { warn: (message, data) => warnings.push([message, data]) }, serverUp: () => s.up,
    DOWN: { status: 'refused', reason: 'unavailable', message: 'down' }, cwdOf: () => '/repo',
    updateThread: (id, patch) => { const x = resident(refs.thread(id)); if (x) x.state = { ...x.state, ...patch }; },
    loadThread: async (id) => { s.loads.push(id); },
    mainOp: async (op, args) => {
      calls.push([op, args]);
      if (s.main) return s.main(op, args);
      if (op === 'pin') { if (args.pinned) pins.add(args.threadId); else pins.delete(args.threadId); }
      return { ok: true, result: op === 'pinned' ? { threadIds: [...pins] } : op === 'delete' ? { deletedThreadIds: [args.threadId] } : {} };
    },
    request: async (method, params, intent) => {
      calls.push([method, params, intent]);
      if (s.request) return s.request(method, params, intent);
      return method === 'turn/start' ? { turn: { id: 'new-turn' } } : method === 'thread/fork' ? { thread: { id: 'fork' } } : {};
    },
    async withLoadedThread(threadId, fn, intent) {
      try { return await fn(); } catch (e) {
        if (!/thread not found|resume the thread/i.test(String(e?.message ?? e))) throw e;
        await s.ctx.request('thread/resume', { threadId, excludeTurns: true }, intent);
        return fn();
      }
    },
  };
  s.feed = threads.createFeed(s.ctx);
  return s;
}

test('send, compact and setModel resume an unloaded thread before retrying with the same intent and input', async () => {
  for (const [operation, method, args, result] of [
    ['send', 'turn/start', [content('Continue')], refs.turn('sent')],
    ['compact', 'thread/compact/start', [], null],
    ['setModel', 'thread/settings/update', [refs.model('fake-mini')], null],
  ]) {
    const s = context();
    let loaded = false;
    s.request = async (method) => {
      if (method === 'thread/resume') { loaded = true; return {}; }
      if (!loaded) throw new Error(`thread not found: ${s.ref.id}`);
      return method === 'turn/start' ? { turn: { id: 'sent' } } : {};
    };
    try {
      const intent = `${operation}-intent`;
      assert.deepEqual(await s.feed[operation](s.ref, ...args, intent), result);
      assert.deepEqual(s.calls.map(([m]) => m), [method, 'thread/resume', method]);
      assert.deepEqual(s.calls[1], ['thread/resume', { threadId: s.ref.id, excludeTurns: true }, intent]);
      assert.deepEqual(s.calls[2], s.calls[0], 'the retry keeps the request and intent');
      assert.equal(s.calls[0][2], intent);
      assert.equal(s.calls[0][1].threadId, s.ref.id);
    } finally { s.feed.dispose(); }
  }
});

test('archive inactive fallback follows preparation and only handles missing rollouts, with required and best-effort failures distinguished', async () => {
  const s = context({ pinned: true });
  s.request = async (method) => { if (method === 'thread/archive') throw new Error('no rollout found for thread id'); return {}; };
  try {
    assert.equal(await s.feed.archive(s.ref, 'archive-intent'), null);
    assert.deepEqual(s.calls, [
      ['archive-prepare', { threadId: 't', cwd: '/repo' }],
      ['thread/archive', { threadId: 't' }, 'archive-intent'],
      ['archive-inactive', { threadId: 't' }],
      ['pin', { threadId: 't', pinned: false }],
      ['pinned', {}],
    ]);
    assert.equal(s.thread.state.pinned, false);
    s.main = async (op) => op === 'archive-inactive' ? { ok: false, refused: true, error: 'no archive service' } : { ok: false, error: 'prepare failed' };
    await assert.rejects(s.feed.archive(s.ref), /no archive service/);
    assert.ok(s.warnings.some(([m]) => /archive preparation/.test(m)));
    s.main = async (op) => { if (op === 'archive-inactive') throw new Error('inactive failed'); throw new Error('prepare threw'); };
    await assert.rejects(s.feed.archive(s.ref), /inactive failed/);
    s.request = async () => { throw new Error('disk failed'); };
    const before = s.calls.length;
    await assert.rejects(s.feed.archive(s.ref), /disk failed/);
    assert.equal(s.calls.slice(before).some(([op]) => op === 'archive-inactive'), false);
  } finally { s.feed.dispose(); }
});

test('best-effort cleanup, archive preparation/unpin and restore preparation log failure; every protocol write carries its intent', async () => {
  const s = context({ pinned: true, goal: { status: 'active' }, turns: [['older', 1], ['latest', 2]] });
  s.request = async (method) => { if (method === 'thread/backgroundTerminals/clean') throw new Error('terminals failed'); return {}; };
  try {
    assert.equal(await s.feed.stop(s.ref, 'stop-intent'), null);
    assert.deepEqual(s.calls.slice(0, 3), [
      ['thread/goal/set', { threadId: 't', status: 'paused' }, 'stop-intent'],
      ['turn/interrupt', { threadId: 't', turnId: 'latest' }, 'stop-intent'],
      ['thread/backgroundTerminals/clean', { threadId: 't' }, 'stop-intent'],
    ]);
    assert.ok(s.warnings.some(([m]) => /terminals/.test(m)));
    s.main = async () => ({ ok: false, refused: false, error: 'service failed' });
    assert.equal(await s.feed.archive(s.ref, 'archive-intent'), null);
    assert.ok(s.warnings.some(([m]) => /archive unpin/.test(m)));
    s.thread.state.archived = true;
    assert.equal(await s.feed.restore(s.ref, 'restore-intent'), null);
    assert.ok(s.warnings.some(([m]) => /restore preparation/.test(m)));
    s.instances.splice(1);
    s.request = null;
    await s.feed.send(s.ref, content('x'), 'send-intent');
    await s.feed.compact(s.ref, 'compact-intent');
    await s.feed.setModel(s.ref, { ...refs.model('fake'), type: 'SpecialModel' }, 'model-intent');
    await s.feed.fork(s.ref, undefined, 'fork-intent');
    s.instances.push({ ref: refs.turn('live'), state: { status: 'running', startedAt: 3, startedBy: { kind: 'user' } }, links: { thread: s.ref } });
    await s.feed.steer(s.ref, content('y'), 'steer-intent');
    for (const method of ['turn/start', 'turn/steer', 'thread/compact/start', 'thread/settings/update', 'thread/fork', 'thread/unarchive', 'thread/archive']) {
      assert.ok(s.calls.some(([op, _params, intent]) => op === method && intent?.endsWith('-intent')), `${method} has the operation's intent`);
    }
  } finally { s.feed.dispose(); }
});

test('main refusals and failures keep their operation semantics; protocol failures throw and a down server dispatches nothing', async () => {
  const s = context({ archived: true });
  try {
    s.main = async () => ({ ok: false, refused: true, error: 'service absent' });
    refused(await s.feed.pin(s.ref, true), 'unavailable');
    refused(await s.feed.delete(s.ref), 'unavailable');
    refused(await s.feed.open(s.ref), 'unavailable');
    assert.equal(s.thread.state.pinned, false);
    s.main = async () => ({ ok: false, refused: false, error: 'service failed' });
    await assert.rejects(s.feed.pin(s.ref, true), /service failed/);
    await assert.rejects(s.feed.delete(s.ref), /service failed/);
    refused(await s.feed.open(s.ref), 'unavailable');
    s.main = async () => { throw new Error('transport failed'); };
    refused(await s.feed.open(s.ref), 'unavailable');
    await assert.rejects(s.feed.delete(s.ref), /transport failed/);
    s.main = async () => ({ ok: true, result: { deletedThreadIds: ['other'] } });
    await assert.rejects(s.feed.delete(s.ref), /did not delete/);
    s.request = async () => { throw new Error('protocol failed'); };
    await assert.rejects(s.feed.send(s.ref, content('x')), /protocol failed/);
    await assert.rejects(s.feed.compact(s.ref), /protocol failed/);
    await assert.rejects(s.feed.setModel(s.ref, refs.model('fake')), /protocol failed/);
    await assert.rejects(s.feed.fork(s.ref), /protocol failed/);
    await assert.rejects(s.feed.restore(s.ref), /protocol failed/);
    s.instances.push({ ref: refs.turn('live'), state: { status: 'running', startedAt: 1, startedBy: { kind: 'user' } }, links: { thread: s.ref } });
    await assert.rejects(s.feed.steer(s.ref, content('x')), /protocol failed/);
    await assert.rejects(s.feed.stop(s.ref), /protocol failed/);
    s.up = false;
    s.calls.length = 0;
    for (const [op, args] of [
      ['send', [content('x')]], ['steer', [content('x')]], ['stop', []], ['archive', []], ['restore', []], ['open', []],
      ['fork', []], ['delete', []], ['compact', []], ['setModel', [refs.model('fake')]], ['pin', [true]], ['export', []],
    ]) assert.deepEqual(await s.feed[op](s.ref, ...args), s.ctx.DOWN, op);
    for (const op of ['send', 'steer', 'compact', 'delete']) assert.equal(s.feed.prompt(op, s.thread, content('x')), null);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.loads, []);
  } finally { s.feed.dispose(); }
});

test('pins refresh at start, server up, every minute and a debounced section move; failures preserve pins and disposal clears timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const s = context({ pinned: true });
  const flush = () => new Promise(setImmediate);
  try {
    await s.feed.start();
    assert.equal(s.calls.length, 1);
    s.pins.clear();
    await s.feed.serverUp();
    assert.equal(s.thread.state.pinned, false);
    s.pins.add('next');
    await s.feed.serverUp();
    const next = { ref: refs.thread('next'), state: { pinned: false }, links: {} };
    s.instances.push(next, { ref: { ...refs.thread('foreign'), provider: 'foreign' }, state: { pinned: true }, links: {} });
    const before = s.calls.length;
    s.feed.notified('thread/started', { thread: { id: 'next' } });
    assert.equal(next.state.pinned, true);
    assert.equal(s.calls.length, before, 'thread/started uses the last pins');
    assert.equal(s.thread.state.pinned, false);
    s.pins.add('t');
    s.feed.responded('thread/section/move');
    t.mock.timers.tick(400);
    s.feed.responded('thread/section/move');
    t.mock.timers.tick(499);
    await flush();
    assert.equal(s.calls.length, before);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(s.calls.length, before + 1);
    assert.equal(s.thread.state.pinned, true);
    s.main = async () => ({ ok: false, refused: true, error: 'pins unavailable' });
    s.pins.clear();
    await s.feed.serverUp();
    assert.equal(s.thread.state.pinned, true);
    s.main = async () => { throw new Error('pins failed'); };
    await s.feed.serverUp();
    assert.equal(s.thread.state.pinned, true);
    s.main = null;
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(s.thread.state.pinned, false);
    assert.equal(s.instances.at(-1).state.pinned, true, 'another provider is untouched');
    s.feed.responded('thread/section/move');
    s.feed.dispose();
    const ended = s.calls.length;
    t.mock.timers.tick(120_000);
    await flush();
    await s.feed.serverUp();
    assert.equal(s.calls.length, ended);
  } finally { s.feed.dispose(); }
});

test('markdownOf is pure; export sorts turns, resolves explicit input/answer links and ignores turns and fallback messages of another provider', async () => {
  const inputs = [{ input: [content('First'), content('Steering')], answer: content('Answer') }, { input: [content('Next')], answer: null }];
  const saved = structuredClone(inputs);
  assert.equal(threads.markdownOf('Title', inputs), '# Title\n\n**You:** First\n\nSteering\n\n**Codex:** Answer\n\n**You:** Next');
  assert.deepEqual(inputs, saved);
  assert.equal(threads.markdownOf('Empty', []), '# Empty');
  const s = context({ turns: [['later', 2, 'completed'], ['earlier', 1, 'completed']] });
  const message = (type, id, text, turn) => ({ ref: refs.item(type, 't', id), state: { content: content(text) }, links: { turn: refs.turn(turn) } });
  const first = message('UserMessage', 'first', 'First', 'earlier');
  const answer = message('AgentMessage', 'answer', 'Answer', 'earlier');
  const later = message('UserMessage', 'later', 'Later', 'later');
  s.instances[2].links.input = [first.ref];
  s.instances[2].links.answer = answer.ref;
  s.instances.push(first, answer, later,
    { ...message('UserMessage', 'foreign', 'Foreign', 'later'), ref: { ...refs.item('UserMessage', 't', 'foreign'), provider: 'other' } },
    { ref: { ...refs.turn('foreign'), provider: 'other' }, state: { status: 'running', startedAt: 0, startedBy: { kind: 'user' } }, links: { thread: s.ref } });
  try {
    assert.deepEqual(await s.feed.export(s.ref), content('# Chat\n\n**You:** First\n\n**Codex:** Answer\n\n**You:** Later'));
    assert.deepEqual(s.loads, ['t']);
  } finally { s.feed.dispose(); }
});

test('a change of a send that does more than the send did (public-hooks.md §3.5): more access, out of plan mode, a setting it named left out, kept', () => {
  const send = (settings, extra = {}) => [{ parts: [{ kind: 'text', text: 'hi' }] }, { ...(settings ? { settings } : {}), ...extra }];
  const w = (original, args) => threads.sendWidens({ original, args });
  assert.equal(w(send({ access: 'workspace' }), send({ access: 'read-only' })), null, 'less access');
  assert.match(w(send({ access: 'read-only' }), send({ access: 'full' })), /full access/);
  assert.match(w(send(null), send({ access: 'workspace' })), /workspace access/, 'none named: only read-only is surely not more');
  assert.equal(w(send(null), send({ access: 'read-only' })), null);
  assert.match(w(send({ mode: 'plan', access: 'read-only' }), send(null)), /leaves out the read-only access/, 'the chat\'s own may be more');
  assert.match(w(send({ mode: 'plan' }), send({})), /leaves out the plan mode/);
  assert.match(w(send({ mode: 'plan' }), send({ mode: 'default' })), /default mode/);
  assert.equal(w(send({ mode: 'default' }), send({ mode: 'plan' })), null, 'into plan mode: less');
  assert.match(w(send(null), send(null, { sticky: true })), /keeps its settings/);
  assert.equal(w(send({ effort: 'low' }), send({ effort: 'high' })), null, 'a model\'s effort is not more of what the send does');
});
