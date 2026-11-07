// Computer-use sessions through the real graph, native source, mux and fake app-server. Recorded replies supply history because
// fake/notify deliberately streams notifications without changing the fake's stored turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { itemData, refs } from '../map.mjs';
import * as computerUse from '../areas/computer-use.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.computer-use' };
const finder = refs.externalApp('com.apple.finder'), safari = refs.externalApp('com.apple.Safari');
const turn = (id, status = 'inProgress', items = [], startedAt = 1) => ({ id, status, items, startedAt, completedAt: status === 'completed' ? startedAt + 1 : null, error: null });
const legacy = (id, app = finder.id) => ({ id, type: 'mcpToolCall', server: 'computer-use', tool: 'click', arguments: { app }, status: 'inProgress', result: null, error: null });
const unified = (id, app) => ({ id, type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: 'await cua.getState()' }, status: 'inProgress', error: null,
  result: app ? { content: [], _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { kind: 'appId', appId: app } } } } : null });

async function setup() {
  const h = await harness(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-computer-use-'));
  const events = [], notes = [], requests = [], reads = [], warnings = [], prompts = [], history = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log,
    approvals: { ask: async (q) => { prompts.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let sequence = 5000, feed;
  const ask = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const replay = h.mux.client('test:computer-use-history');
  replay.intercept('serverResponse', ['thread/read', 'thread/resume', 'thread/turns/list'], (m, info) => {
    reads.push([info.method, info.affinityKey]);
    const rows = history.get(info.affinityKey);
    if (!rows) return;
    const result = info.method === 'thread/turns/list' ? { data: [...rows].reverse(), nextCursor: null }
      : { ...m.result, thread: { ...m.result.thread, turns: rows } };
    return { replace: { ...m, result } };
  });
  const area = { ...computerUse, createFeed(ctx) {
    feed = computerUse.createFeed({ ...ctx, request(method, params, intent) { requests.push({ method, params, intent }); return ctx.request(method, params, intent); } });
    return { ...feed, notified(method, params) { try { feed.notified(method, params); } finally { notes.push(method); } } };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, areas: { 'computer-use': area } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'ComputerUseSession') events.push(e); });
  await source.start();
  const threadId = (await ask('thread/start', {})).thread.id;
  await until(() => graph.resolve(refs.thread(threadId)), 3000, 'the thread');
  const ref = refs.computerUseSession(threadId);
  const notify = async (method, params) => {
    const n = notes.length;
    await ask('fake/notify', { method, params });
    await until(() => notes.slice(n).includes(method), 3000, method);
    assert.deepEqual(warnings, []);
  };
  return {
    h, graph, source, feed, dir, threadId, ref, events, requests, reads, warnings, prompts, history, ask, notify,
    session: () => graph.resolve(ref),
    names: () => events.map((e) => e.name),
    start: (id = 'u', startedAt = 1) => notify('turn/started', { threadId, turn: turn(id, 'inProgress', [], startedAt) }),
    send: (item, { turnId = 'u', method = 'item/started', startedAtMs } = {}) => notify(method, { threadId, turnId, item, ...(startedAtMs === undefined ? {} : { startedAtMs }) }),
    invoke: () => graph.invoke({ ref, operation: 'stop', args: [], caller: mod }),
    async close() { await source.dispose(); await replay.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a chat runs a session for legacy and unified actions, keeps the latest named app and stops with its turn', async () => {
  const s = await setup();
  try {
    await s.start();
    await s.send({ ...legacy('tool'), server: 'other' });
    await s.send({ ...unified('repl'), tool: 'help' });
    assert.equal(s.session(), null, 'ordinary tool calls do not start computer use');
    await s.send(legacy('first'), { startedAtMs: 1000 });
    assert.deepEqual(s.session().state, { status: 'running' });
    assert.deepEqual(s.session().links, { thread: refs.thread(s.threadId), app: finder });
    assert.deepEqual(s.names(), ['started', 'actionTaken']);
    assert.equal(s.events[1].payload, null);
    assert.equal(s.graph.can(s.ref, 'stop'), true);
    assert.equal(s.graph.can(s.ref, 'pause'), false);
    assert.equal(s.graph.can(s.ref, 'resume'), false);

    await s.send(unified('second'), { startedAtMs: 2000 });
    assert.deepEqual(s.session().links.app, finder, 'a call without an app keeps the last app');
    await s.send({ ...unified('second', safari.id), status: 'completed' }, { method: 'item/completed' });
    assert.deepEqual(s.session().links.app, safari, 'completion can supply the unified call\'s app');
    await s.send({ ...legacy('first'), status: 'completed' }, { method: 'item/completed' });
    assert.deepEqual(s.session().links.app, safari, 'an older call completing later does not replace the current app');
    await s.send({ ...unified('third'), status: 'completed' }, { method: 'item/completed', startedAtMs: 3000 });
    assert.deepEqual(s.session().links.app, safari, 'a result without toolSurface keeps the last app');
    assert.deepEqual(s.names(), ['started', 'actionTaken', 'actionTaken', 'actionTaken']);
    assert.equal(s.graph.related(s.ref, 'actions').length, 3, 'ComputerAction.session supplies the inverse');

    // The inverse belongs to ExternalApp, which the apps feed normally supplies.
    s.source.provider.put(safari, { state: { name: 'Safari', icon: '', opens: ['url'], computerUse: 'ask' } });
    assert.deepEqual(s.graph.related(safari, 'sessions').map((x) => x.ref), [s.ref]);
    await s.notify('turn/completed', { threadId: s.threadId, turn: turn('other-turn', 'completed') });
    assert.equal(s.session().state.status, 'running', 'another turn completing cannot stop this session');
    await s.notify('turn/completed', { threadId: s.threadId, turn: turn('u', 'completed') });
    assert.equal(s.session().state.status, 'stopped');
    assert.deepEqual(s.session().links.app, safari);
    assert.deepEqual(s.names(), ['started', 'actionTaken', 'actionTaken', 'actionTaken', 'stopped']);
    await s.notify('turn/completed', { threadId: s.threadId, turn: turn('u', 'completed') });
    assert.equal(s.names().filter((n) => n === 'stopped').length, 1);
    await s.start('next', 3);
    await s.send(unified('next-action'), { turnId: 'next', startedAtMs: 4000 });
    assert.deepEqual(s.names().slice(-2), ['started', 'actionTaken'], 'a later turn reuses the chat\'s session');
  } finally { await s.close(); }
});

for (const end of ['archived', 'closed', 'deleted']) test(`thread/${end} ends computer use; deletion removes the session`, async () => {
  const s = await setup();
  try {
    await s.start();
    await s.send(unified('action'));
    assert.deepEqual(s.session().links.app, null, 'a unified call needs no app or result to start');
    await s.notify(`thread/${end}`, { threadId: s.threadId });
    if (end === 'deleted') assert.equal(s.session().gone, true);
    else assert.equal(s.session().state.status, 'stopped');
    assert.deepEqual(s.names(), ['started', 'actionTaken', 'stopped']);
    await s.send({ ...unified('action', safari.id), status: 'completed' }, { method: 'item/completed' });
    if (end === 'deleted') assert.equal(s.session().gone, true, 'a late item cannot recreate the deleted session');
    else assert.equal(s.session().state.status, 'stopped', 'a late update of the same action does not restart the session');
    await s.notify(`thread/${end}`, { threadId: s.threadId });
    assert.deepEqual(s.names(), ['started', 'actionTaken', 'stopped']);
  } finally { await s.close(); }
});

test('observing a session loads completed actions as a silent sync, in history order; older history preserves a live session', async () => {
  const s = await setup();
  try {
    s.history.set(s.threadId, [
      turn('old', 'completed', [{ ...legacy('old-action'), status: 'completed' }]),
      turn('new', 'completed', [{ ...unified('new-action', safari.id), status: 'completed' }, { ...unified('no-app'), status: 'completed' }], 2),
    ]);
    assert.equal(s.session(), null);
    const view = s.graph.subscribe({ ref: s.ref }, () => {});
    try { await view.loaded; } finally { view.dispose(); }
    assert.deepEqual(s.session().state, { status: 'stopped' });
    assert.deepEqual(s.session().links, { thread: refs.thread(s.threadId), app: safari });
    assert.equal(s.graph.related(s.ref, 'actions').length, 3);
    assert.deepEqual(s.events, [], 'history does not emit started, actionTaken or stopped');
    assert.deepEqual(s.reads, [['thread/turns/list', s.threadId]]);
    await s.feed.observe(s.ref, 'ComputerUseSession');
    assert.equal(s.reads.length, 1, 'the core owns the history load');
    assert.equal(s.feed.observe(refs.thread(s.threadId), 'Thread'), undefined);

    await s.start('live', 4);
    await s.send(legacy('live-action'), { turnId: 'live', startedAtMs: 4000 });
    await s.ask('thread/read', { threadId: s.threadId, includeTurns: true });
    await until(() => s.reads.some(([method]) => method === 'thread/read'));
    assert.equal(s.session().state.status, 'running');
    assert.deepEqual(s.session().links.app, finder);
    assert.deepEqual(s.names(), ['started', 'actionTaken']);
    assert.deepEqual(s.warnings, []);
  } finally { await s.close(); }
});

test('a mod stops the running turn through turn/interrupt with its intent, without approval; a stopped session refuses without a request', async () => {
  const s = await setup();
  try {
    await s.ask('fake/hold', { threadId: s.threadId });
    const { turn: running } = await s.ask('turn/start', { threadId: s.threadId, input: [] });
    await until(() => s.graph.resolve(refs.turn(running.id))?.state.status === 'running');
    await s.send(legacy('held-action'), { turnId: running.id });
    const result = await s.invoke();
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.ok(result.intent);
    assert.deepEqual(s.requests, [{ method: 'turn/interrupt', params: { threadId: s.threadId, turnId: running.id }, intent: result.intent }]);
    assert.deepEqual(s.prompts, [], 'stopping writes no lasting permission');
    await until(() => s.session().state.status === 'stopped', 3000, 'interrupt completion stops computer use');
    assert.deepEqual(s.names(), ['started', 'actionTaken', 'stopped']);
    assert.match(fs.readFileSync(path.join(s.dir, 'intents.jsonl'), 'utf8'), new RegExp(`"id":"${result.intent}","phase":"done"`));
    const refused = await s.invoke();
    assert.equal(refused.status, 'refused');
    assert.equal(refused.reason, 'unavailable');
    assert.equal(refused.message, 'Codex is not using the computer in this chat');
    assert.equal(s.requests.length, 1, 'refusal tried nothing');
  } finally { await s.close(); }
});

test('the feed follows only its provider\'s actions and dispose ends its graph subscription', async () => {
  const s = await setup();
  try {
    await s.start();
    const other = s.graph.registerProvider('native', 'other', { types: { ComputerAction: {} } });
    const [d] = itemData(s.threadId, 'u', legacy('foreign'), { done: false, startedAt: 1000 });
    other.put({ ...d.ref, provider: 'other' }, { state: d.state, links: d.links });
    assert.equal(s.session(), null);
    await s.send(legacy('own'));
    assert.equal(s.session().state.status, 'running');
    s.feed.dispose();
    await s.send(unified('after-dispose', safari.id));
    assert.deepEqual(s.session().links.app, finder);
    await s.notify('turn/completed', { threadId: s.threadId, turn: turn('u', 'completed') });
    assert.equal(s.session().state.status, 'running', 'a disposed feed no longer follows notifications');
    assert.deepEqual(s.names(), ['started', 'actionTaken']);
    await s.feed.observe(s.ref, 'ComputerUseSession');
    assert.deepEqual(s.reads, []);
  } finally { await s.close(); }
});
