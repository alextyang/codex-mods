// The queue area through the Codex source, graph and real mux with the fake app-server: live QueuedMessages, the inverse Thread.queue,
// queue operations and their intents, sync and change events, serialized reads, failures, and a mod's R17 prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userInput, userContent } from '../map.mjs';
import * as queue from '../areas/queue.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = { kind: 'mod', id: 'mod.queue' };
const content = (text) => ({ parts: [{ kind: 'text', text }] });
const input = (text) => userInput(content(text));

async function setup({ sync = true, now = Date.now } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-queue-'));
  const prompts = [], warnings = [], requests = [], events = [];
  const log = { debug() {}, info() {}, warn: (message, data) => warnings.push({ message, data }), error() {} };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, approvals: { ask: async (q) => { prompts.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  // Capture the area's feed and wire for read races and failures; its requests still go through the real source and mux.
  const wire = { request: null };
  let feed, ctx;
  const module = { ...queue, createFeed(context) {
    ctx = context;
    feed = queue.createFeed({ ...context, request(method, params, intent) {
      requests.push({ method, params: structuredClone(params), intent });
      const next = () => context.request(method, params, intent);
      return wire.request ? wire.request(method, params, intent, next) : next();
    } });
    return feed;
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now, areas: { queue: module } });
  graph.onEvent((e) => {
    if (e.kind === 'event' && e.ref.type === 'QueuedMessage') events.push({ ref: e.ref, name: e.name, present: !!ctx.resident(e.ref) });
  });
  let seq = 0;
  const app = async (method, params) => {
    const r = await h.app.request(++seq, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    return r.result;
  };
  const act = async (ref, operation, args = [], caller = user) => {
    const r = await graph.invoke({ ref, operation, args, caller });
    assert.equal(r.status, 'done', JSON.stringify(r));
    return r;
  };
  const thread = async (title = 'Queue chat') => {
    const ref = refs.thread((await app('thread/start', { cwd: '/tmp' })).thread.id);
    await app('thread/name/set', { threadId: ref.id, name: title });
    await until(() => graph.resolve(ref)?.state.title === title, 3000, 'the thread and its title');
    return ref;
  };
  await source.start();
  const ref = await thread();
  if (sync) await feed.list(ref.id);
  return {
    h, graph, source, ctx, feed, wire, requests, events, warnings, prompts, ref, app, act, thread,
    enqueue: async (text, caller = user) => (await act(ref, 'enqueue', [content(text)], caller)).value,
    queued: async (threadId = ref.id) => (await app('thread/queue/list', { threadId })).data,
    async close() { await source.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('queuedData: content, thread and attachments, including a thread id containing colons', () => {
  const submission = { id: 'q-1', clientUserMessageId: 'client', input: [...input('next'), { type: 'localImage', path: '/tmp/image.png' }, { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }] };
  assert.deepEqual(queue.queuedData('scope:thread', submission), {
    ref: refs.queuedMessage('scope:thread', 'q-1'),
    state: { content: { parts: [{ kind: 'text', text: 'next' }, { kind: 'image', source: '/tmp/image.png' }, { kind: 'text', text: '@review' }] } },
    links: { thread: refs.thread('scope:thread'), attachments: [] },
  });
});

test('enqueue and edit put the content, inverse Thread.queue and thread link; move reorders, clamps and does nothing in place; remove emits before removal', async () => {
  const s = await setup();
  try {
    const rich = { parts: [...content('Next: ').parts, { kind: 'code', language: 'js', text: 'go()' }, { kind: 'mention', target: refs.file('/tmp/a.js'), label: 'a.js' }] };
    const from = s.requests.length;
    const added = await s.act(s.ref, 'enqueue', [rich]);
    const ref = added.value;
    const inst = s.graph.resolve(ref);
    assert.equal(inst.liveness, 'live');
    assert.deepEqual(inst.state.content, userContent(userInput(rich)));
    assert.deepEqual(inst.links, { thread: s.ref, attachments: [] });
    assert.deepEqual(s.graph.related(s.ref, 'queue').map((q) => q.ref), [ref]);
    assert.deepEqual(s.events.map((e) => e.name), ['queued']);
    assert.deepEqual(s.requests.slice(from).map((r) => r.method), ['thread/queue/add', 'thread/queue/list']);
    assert.ok(s.requests.slice(from).every((r) => r.intent === added.intent), 'the mutation and refresh carry the graph intent');
    assert.deepEqual(s.requests[from].params.input, userInput(rich));
    assert.match(s.requests[from].params.clientUserMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const clientId = (await s.queued())[0].clientUserMessageId;
    const editAt = s.requests.length;
    const edited = await s.act(ref, 'edit', [content('Edited')]);
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Edited'));
    assert.equal((await s.queued())[0].clientUserMessageId, clientId);
    assert.ok(s.requests.slice(editAt).every((r) => r.intent === edited.intent));
    assert.deepEqual(s.events.map((e) => e.name), ['queued'], 'editing is a state change, with no new queued event');
    const b = await s.enqueue('B'), c = await s.enqueue('C');
    const ids = async () => (await s.queued()).map((q) => q.id);
    const id = (ref) => ref.id.slice(ref.id.lastIndexOf(':') + 1);
    await s.act(c, 'move', [1]);
    assert.deepEqual(await ids(), [id(ref), id(c), id(b)]);
    const moveAt = s.requests.length;
    const moved = await s.act(b, 'move', [-100]);
    assert.deepEqual(await ids(), [id(b), id(ref), id(c)]);
    assert.ok(s.requests.slice(moveAt).every((r) => r.intent === moved.intent));
    await s.act(b, 'move', [100]);
    assert.deepEqual(await ids(), [id(ref), id(c), id(b)]);
    const noOpAt = s.requests.length;
    await s.act(b, 'move', [100]);
    assert.equal(s.requests.length, noOpAt, 'already last: no request');
    const removeAt = s.requests.length;
    const removed = await s.act(ref, 'remove');
    assert.deepEqual(s.requests.slice(removeAt).map((r) => r.method), ['thread/queue/delete', 'thread/queue/list']);
    assert.ok(s.requests.slice(removeAt).every((r) => r.intent === removed.intent));
    assert.deepEqual(s.events.at(-1), { ref, name: 'removed', present: true });
    assert.equal(s.graph.resolve(ref).gone, true);
    assert.deepEqual(s.graph.related(s.ref, 'queue').map((q) => q.ref.id).sort(), [b.id, c.id].sort());
    assert.deepEqual(s.prompts, [], 'user operations do not prompt');
  } finally { await s.close(); }
});

test('sendNow on an idle thread starts the queued submission and emits sent before removing it', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Send now');
    const from = s.requests.length;
    const sent = await s.act(ref, 'sendNow');
    assert.deepEqual(s.requests.slice(from).map((r) => r.method), ['thread/queue/start', 'thread/queue/list']);
    assert.ok(s.requests.slice(from).every((r) => r.intent === sent.intent));
    assert.deepEqual(s.events.at(-1), { ref, name: 'sent', present: true });
    assert.equal(s.graph.resolve(ref).gone, true);
    assert.deepEqual(await s.queued(), []);
    assert.deepEqual(s.graph.related(s.ref, 'turns').map((t) => [t.ref.id, t.state.status]), [['turn-q-1', 'running']]);
  } finally { await s.close(); }
});

test('sendNow resumes an unloaded thread before starting its queued submission', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Send after loading');
    await s.app('fake/forget', { threadId: s.ref.id });
    let attempts = 0;
    s.wire.request = (method, _params, _intent, next) => {
      if (method === 'thread/queue/start' && ++attempts === 1) throw new Error('resume the thread before starting a queued message');
      return next();
    };
    const from = s.h.serverLog().length;
    const sent = await s.act(ref, 'sendNow');
    const calls = s.h.serverLog().slice(from).map((line) => JSON.parse(line.slice(line.indexOf('{'))))
      .filter((r) => ['thread/queue/start', 'thread/resume'].includes(r.method));
    assert.deepEqual(calls.map((r) => [r.method, r.params]), [
      ['thread/resume', { threadId: s.ref.id, excludeTurns: true }],
      ['thread/queue/start', { threadId: s.ref.id, queuedSubmissionId: 'q-1' }],
    ]);
    assert.equal(attempts, 2);
    assert.ok(s.requests.filter((r) => r.method === 'thread/queue/start').every((r) => r.intent === sent.intent));
    assert.deepEqual(await s.queued(), []);
    assert.deepEqual(s.events.at(-1), { ref, name: 'sent', present: true });
    assert.equal(s.graph.resolve(ref).gone, true);
  } finally { await s.close(); }
});

test('sendNow is done when resuming the thread started the queued message itself', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Started by the resume');
    const clientId = (await s.queued())[0].clientUserMessageId;
    let attempts = 0;
    s.wire.request = async (method, _params, _intent, next) => {
      if (method !== 'thread/queue/start') return next();
      attempts += 1;
      if (attempts === 1) throw new Error('resume the thread before starting a queued message');
      await next();   // the app-server started it while loading the thread: its user message carries the submission's client id
      s.feed.notified('item/started', { threadId: s.ref.id, turnId: 'turn-q-1', item: { type: 'userMessage', id: 'u-q', clientId, content: [] } });
      throw new Error('queued submission not found: q-1');
    };
    const sent = await s.act(ref, 'sendNow');
    assert.equal(sent.status, 'done', JSON.stringify(sent));
    assert.deepEqual(await s.queued(), []);
    assert.deepEqual(s.events.at(-1), { ref, name: 'sent', present: true });
  } finally { await s.close(); }
});

test('sendNow on a running thread steers its latest running turn with the stored input and client id, then deletes', async () => {
  const s = await setup();
  try {
    const submission = (await s.app('thread/queue/add', { threadId: s.ref.id, clientUserMessageId: 'original-client', input: [...input('Follow up'), { type: 'localImage', path: '/tmp/follow.png' }, { type: 'mention', name: 'file', path: '/tmp/a' }] })).queuedSubmission;
    await s.feed.list(s.ref.id);
    await s.app('fake/hold', { threadId: s.ref.id });
    const held = (await s.app('turn/start', { threadId: s.ref.id, input: input('Working') })).turn;
    const note = async (threadId, id, startedAt, status = 'inProgress') => s.app('fake/notify', { method: 'turn/started', params: { threadId, turn: { id, status, items: [], error: null, startedAt } } });
    await note(s.ref.id, held.id, 20);
    await note(s.ref.id, 'older-running', 10);
    await note(s.ref.id, 'completed', 30, 'completed');
    const other = await s.thread('Other chat');
    await note(other.id, 'other-running', 40);
    await until(() => s.graph.resolve(refs.turn('other-running')), 3000, 'the turn notifications');
    const ref = refs.queuedMessage(s.ref.id, submission.id), from = s.requests.length;
    const sent = await s.act(ref, 'sendNow');
    // the operation's own requests (a re-list of the queue the source makes meanwhile, under load, is not the operation's)
    const own = s.requests.slice(from).filter((r) => r.intent === sent.intent);
    assert.deepEqual(own.map((r) => r.method), ['turn/steer', 'thread/queue/delete', 'thread/queue/list']);
    assert.deepEqual(own[0].params, { threadId: s.ref.id, expectedTurnId: held.id, input: submission.input, clientUserMessageId: 'original-client' });
    assert.ok(s.requests.slice(from).every((r) => r.intent === sent.intent || r.method === 'thread/queue/list'), 'nothing else ran');
    const history = await s.app('thread/turns/list', { threadId: s.ref.id, itemsView: 'full' });
    assert.deepEqual(history.data.find((t) => t.id === held.id).items.at(-1).content, submission.input, 'the real fake turn received the steering message');
    assert.deepEqual(await s.queued(), []);
    assert.deepEqual(s.events.at(-1), { ref, name: 'sent', present: true });
  } finally { await s.close(); }
});

test('observation lists every page as a sync without events; a Thread observation also leaves the core to load its turns', async () => {
  const s = await setup({ sync: false });
  try {
    // Resume gives this thread an id with colons, proving observation splits at the last colon.
    const threadId = 'scope:thread';
    await s.app('thread/resume', { threadId, cwd: '/tmp' });
    const submissions = [];
    for (let i = 0; i < 52; i++) submissions.push((await s.app('thread/queue/add', { threadId, input: input(`message ${i}`), clientUserMessageId: `client-${i}` })).queuedSubmission);
    const view = s.graph.subscribe({ ref: refs.queuedMessage(threadId, submissions[0].id) }, () => {});
    try { await view.loaded; } finally { view.dispose(); }
    assert.equal(s.graph.related(refs.thread(threadId), 'queue').length, 52);
    assert.deepEqual(s.events, [], 'the first list is a sync');
    assert.deepEqual(s.requests.filter((r) => r.params.threadId === threadId).map((r) => r.params.cursor), [null, '50']);
    const coreView = s.graph.subscribe({ ref: refs.thread(threadId) }, () => {});
    try { await coreView.loaded; } finally { coreView.dispose(); }
    await s.feed.list(threadId);
    assert.ok(s.h.serverLog().some((l) => l.includes('"method":"thread/turns/list"') && l.includes(threadId)), 'the core still loads the thread');
    assert.equal(s.feed.observe(refs.thread(threadId), 'Thread'), undefined);
    await s.feed.list(threadId);
    const before = s.requests.length;
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    assert.equal(s.requests.length, before);
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('a queued message is sent only on the source\'s own signal, its client id on the user message the server started, whichever comes first; without it a removal claims nothing', async () => {
  const s = await setup();
  try {
    // the server started it: its user message (carrying the submission's client id) came first, then the queue changed
    const a = await s.enqueue('First');
    const aId = (await s.queued())[0].clientUserMessageId;
    s.feed.notified('item/started', { threadId: s.ref.id, turnId: 'x1', item: { type: 'userMessage', id: 'm1', clientId: aId, content: [] } });
    await s.app('thread/queue/delete', { threadId: s.ref.id, queuedSubmissionId: (await s.queued())[0].id });
    await s.feed.list(s.ref.id);
    assert.deepEqual(s.events.at(-1), { ref: a, name: 'sent', present: true });
    // the queue changed first: a removal claims nothing; the user message that comes after says it was sent
    const b = await s.enqueue('Second');
    const bId = (await s.queued())[0].clientUserMessageId;
    await s.app('thread/queue/delete', { threadId: s.ref.id, queuedSubmissionId: (await s.queued())[0].id });
    await s.feed.list(s.ref.id);
    assert.deepEqual(s.events.at(-1), { ref: b, name: 'removed', present: true });
    s.feed.notified('item/started', { threadId: s.ref.id, turnId: 'x2', item: { type: 'userMessage', id: 'm2', clientId: bId, content: [] } });
    assert.deepEqual(s.events.at(-1), { ref: b, name: 'sent', present: false });
  } finally { await s.close(); }
});

test('archived threads are not listed by observation, refresh, notifications or serverUp; restored threads can be listed again', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Queued before archive');
    s.ctx.updateThread(s.ref.id, { archived: true });
    const from = s.requests.length;
    assert.equal(s.feed.observe(s.ref, 'Thread'), undefined);
    await s.feed.observe(ref, 'QueuedMessage');
    s.feed.notified('thread/queue/changed', { threadId: s.ref.id });
    s.feed.serverUp();
    await s.feed.list(s.ref.id);
    await sleep(250);
    assert.equal(s.requests.length, from);
    assert.deepEqual(s.warnings, []);
    s.ctx.updateThread(s.ref.id, { archived: false });
    await s.feed.list(s.ref.id);
    assert.deepEqual(s.requests.slice(from).map((r) => r.method), ['thread/queue/list']);
  } finally { await s.close(); }
});

test('an ephemeral queue refusal is remembered through repeated observation, notifications and serverUp', async () => {
  const s = await setup();
  let release;
  try {
    const ref = await s.enqueue('Known queue');
    const gate = new Promise((resolve) => { release = resolve; });
    let reading = false;
    s.wire.request = async (method, _params, _intent, next) => {
      if (method !== 'thread/queue/list') return next();
      reading = true;
      await gate;
      throw new Error('Ephemeral thread does not support queued submissions');
    };
    const from = s.requests.length;
    assert.equal(s.feed.observe(s.ref, 'Thread'), undefined);
    await until(() => reading, 3000, 'the ephemeral queue read');
    const pending = s.feed.list(s.ref.id);
    release();
    await pending;
    assert.equal(s.requests.length, from + 1, 'an already requested relist also skips the ephemeral thread');
    assert.equal(s.feed.observe(s.ref, 'Thread'), undefined);
    await s.feed.observe(ref, 'QueuedMessage');
    s.feed.serverUp();
    s.feed.notified('thread/queue/changed', { threadId: s.ref.id });
    await s.feed.list(s.ref.id);
    await sleep(250);
    assert.equal(s.requests.length, from + 1);
    assert.deepEqual(s.warnings, []);
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Known queue'));
  } finally { release?.(); await s.close(); }
});

test('changed notifications debounce per thread and say queued and removed; a turn start is sent only for the next three seconds', async () => {
  let at = 10_000;
  const s = await setup({ now: () => at });
  try {
    const other = await s.thread('Other queue');
    await s.feed.list(other.id);
    const from = s.requests.length;
    const a = (await s.app('thread/queue/add', { threadId: s.ref.id, input: input('A'), clientUserMessageId: 'a' })).queuedSubmission;
    await s.app('thread/queue/add', { threadId: s.ref.id, input: input('B'), clientUserMessageId: 'b' });
    const c = (await s.app('thread/queue/add', { threadId: other.id, input: input('C'), clientUserMessageId: 'c' })).queuedSubmission;
    await until(() => s.events.filter((e) => e.name === 'queued').length === 3, 3000, 'debounced queue changes');
    assert.deepEqual(s.requests.slice(from).map((r) => r.params.threadId).sort(), [s.ref.id, other.id].sort(), 'one refresh for each thread');
    await s.app('thread/queue/delete', { threadId: s.ref.id, queuedSubmissionId: a.id });
    await until(() => s.events.some((e) => e.name === 'removed'), 3000, 'an external removal');
    assert.equal(s.events.at(-1).present, true);
    await s.app('fake/notify', { method: 'turn/started', params: { threadId: s.ref.id, turn: { id: 'elsewhere', items: [], status: 'inProgress', error: null } } });
    await until(() => s.graph.resolve(refs.turn('elsewhere')), 3000, 'the turn start');
    await s.app('thread/queue/delete', { threadId: other.id, queuedSubmissionId: c.id });
    await s.feed.list(other.id);
    assert.equal(s.events.at(-1).name, 'removed', 'a start in another thread does not imply sent');
    at += 3_001;
    const b = (await s.queued())[0];
    await s.app('thread/queue/delete', { threadId: s.ref.id, queuedSubmissionId: b.id });
    await s.feed.list(s.ref.id);
    assert.equal(s.events.at(-1).name, 'removed', 'the correlation expires after three seconds');
  } finally { await s.close(); }
});

test('list calls for one thread share a promise and run again after it, while another thread reads independently', async () => {
  const s = await setup();
  let release;
  try {
    const other = await s.thread('Other queue');
    const gate = new Promise((r) => { release = r; });
    let held = false;
    s.wire.request = async (method, params, _intent, next) => {
      const r = await next();
      if (method === 'thread/queue/list' && params.threadId === s.ref.id && !held) { held = true; await gate; }
      return r;
    };
    const from = s.requests.length;
    const first = s.feed.list(s.ref.id);
    await until(() => held, 3000, 'the held read');
    assert.equal(s.feed.list(s.ref.id), first);
    assert.equal(s.feed.list(s.ref.id), first);
    await s.feed.list(other.id);
    const added = (await s.app('thread/queue/add', { threadId: s.ref.id, input: input('During the read'), clientUserMessageId: 'during' })).queuedSubmission;
    release();
    await first;
    assert.equal(s.requests.slice(from).filter((r) => r.params.threadId === s.ref.id).length, 2);
    assert.equal(s.requests.slice(from).filter((r) => r.params.threadId === other.id).length, 1);
    assert.deepEqual(s.graph.resolve(refs.queuedMessage(s.ref.id, added.id)).state.content, content('During the read'));
    assert.deepEqual(s.events.map((e) => e.name), ['queued']);
  } finally { release?.(); await s.close(); }
});

test('a failed list leaves every instance and order intact; the twenty-page bound never applies a partial list', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Original');
    // the changes below notify, and the feed lists 200 ms after the last one: under load that list would run mid-loop, so every list is
    // held (it fails) until the debounce has passed, and only then is the failure under test set up
    s.wire.request = async (method, _params, _intent, next) => { if (method === 'thread/queue/list') throw new Error('held'); return next(); };
    for (let i = 0; i < 50; i++) await s.app('thread/queue/add', { threadId: s.ref.id, input: input(`extra ${i}`), clientUserMessageId: `extra-${i}` });
    await s.app('thread/queue/update', { threadId: s.ref.id, queuedSubmissionId: 'q-1', input: input('Changed elsewhere') });
    await new Promise((resolve) => setTimeout(resolve, 350));
    s.wire.request = async (method, params, _intent, next) => {
      if (method === 'thread/queue/list' && params.cursor === '50') throw new Error('second page failed');
      return next();
    };
    await s.feed.list(s.ref.id);
    assert.deepEqual(s.graph.related(s.ref, 'queue').map((q) => q.ref), [ref]);
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Original'));
    assert.equal(s.warnings.at(-1).data.message, 'second page failed');
    assert.deepEqual(s.events.map((e) => e.name), ['queued']);
    let pages = 0;
    s.wire.request = async (method, _params, _intent, next) => {
      const r = await next();
      return method === 'thread/queue/list' ? { ...r, nextCursor: String(++pages * 50) } : r;
    };
    await s.feed.list(s.ref.id);
    assert.equal(pages, 20);
    assert.equal(s.warnings.at(-1).data.message, 'the queue list exceeds 20 pages');
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Original'));
    s.wire.request = null;
    await s.app('fake/forget', { threadId: s.ref.id });
    await s.feed.list(s.ref.id);
    assert.match(s.warnings.at(-1).data.message, /thread not found/);
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Original'));
  } finally { await s.close(); }
});

test('refused calls send nothing and do not prompt: empty input, noninteger positions, unknown or gone messages, and server down', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Keep');
    const from = s.requests.length;
    for (const [target, operation, args] of [[s.ref, 'enqueue', [content('  ')]], [ref, 'edit', [{ parts: [] }]], [ref, 'move', [1.5]]]) {
      const r = await s.graph.invoke({ ref: target, operation, args, caller: mod });
      assert.deepEqual([r.status, r.reason], ['refused', 'invalid']);
    }
    const unknown = refs.queuedMessage(s.ref.id, 'not-listed');
    const d = queue.queuedData(s.ref.id, { id: 'not-listed', input: input('Unlisted') });
    s.ctx.handle.put(d.ref, { state: d.state, links: d.links });
    for (const [operation, args] of [['edit', [content('x')]], ['sendNow', []], ['remove', []], ['move', [0]]]) {
      const r = await s.graph.invoke({ ref: unknown, operation, args, caller: mod });
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'the message is no longer queued']);
    }
    assert.equal(s.requests.length, from);
    assert.deepEqual(s.prompts, []);
    await s.act(ref, 'remove', [], mod);
    for (const [operation, args] of [['edit', [content('x')]], ['sendNow', []], ['remove', []], ['move', [0]]]) {
      assert.equal((await s.graph.invoke({ ref, operation, args, caller: mod })).reason, 'unavailable');
    }
    assert.equal((await s.feed.sendNow(ref)).message, 'the message is no longer queued');
    const live = await s.enqueue('Still queued');
    s.h.bus.publish('appServer/exited', { reason: 'crashed' });
    const downAt = s.requests.length;
    for (const [target, operation, args] of [[s.ref, 'enqueue', [content('x')]], [live, 'edit', [content('x')]], [live, 'sendNow', []], [live, 'remove', []], [live, 'move', [0]]]) {
      const r = await s.graph.invoke({ ref: target, operation, args, caller: mod });
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'the Codex app-server is not running']);
    }
    await s.feed.list(s.ref.id);
    assert.equal(s.requests.length, downAt);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('R17: each mod enqueue, edit and sendNow asks with the thread title and usage detail; remove, move and user calls do not', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('For the mod', mod);
    await s.act(ref, 'edit', [content('Edited by the mod')], mod);
    await s.act(ref, 'move', [0], mod);
    const discard = await s.enqueue('Discard');
    await s.act(discard, 'remove', [], mod);
    await s.act(ref, 'sendNow', [], mod);
    assert.deepEqual(s.prompts.map((p) => [p.operation, p.action, p.detail]), [
      ['Thread.enqueue', 'queue a message in “Queue chat”', 'Codex sends it with this chat\'s permissions, and it counts toward your usage.'],
      ['QueuedMessage.edit', 'change a queued message in “Queue chat”', 'Codex sends it with this chat\'s permissions, and it counts toward your usage.'],
      ['QueuedMessage.sendNow', 'send a queued message now in “Queue chat”', 'Codex sends it with this chat\'s permissions, and it counts toward your usage.'],
    ]);
    const forUser = await s.enqueue('For the user');
    await s.act(forUser, 'edit', [content('User edit')]);
    await s.act(forUser, 'sendNow');
    assert.equal(s.prompts.length, 3);
  } finally { await s.close(); }
});

test('a failed protocol mutation throws through the operation path and is never retried or followed by deletion', async () => {
  const s = await setup();
  try {
    const ref = await s.enqueue('Keep on failure');
    await s.app('fake/hold', { threadId: s.ref.id });
    const held = (await s.app('turn/start', { threadId: s.ref.id, input: input('Running') })).turn;
    await until(() => s.graph.resolve(refs.turn(held.id)), 3000, 'the held turn');
    s.wire.request = (method, _params, intent, next) => (method === 'turn/steer' ? s.ctx.request('fake/error', { message: 'steer failed' }, intent) : next());
    const from = s.requests.length;
    const r = await s.graph.invoke({ ref, operation: 'sendNow', caller: user });
    assert.equal(r.status, 'failed');
    assert.match(r.error.message, /steer failed/);
    assert.deepEqual(s.requests.slice(from).map((r) => r.method), ['turn/steer']);
    assert.equal((await s.queued()).length, 1);
    assert.deepEqual(s.graph.resolve(ref).state.content, content('Keep on failure'));
    s.wire.request = null;
    await s.app('thread/queue/delete', { threadId: s.ref.id, queuedSubmissionId: 'q-1' });
    const failed = await s.graph.invoke({ ref, operation: 'edit', args: [content('Too late')], caller: user });
    assert.equal(failed.status, 'failed', 'a protocol error after dispatch is a failure, not a refusal');
    assert.match(failed.error.message, /queued submission not found/);
  } finally { await s.close(); }
});

test('serverUp relists threads with queued messages; dispose clears change timers and ignores late reads', async () => {
  const s = await setup();
  let release;
  try {
    const ref = await s.enqueue('Before restart');
    const empty = await s.thread('Empty queue');
    await s.feed.list(empty.id);
    await s.app('thread/queue/update', { threadId: s.ref.id, queuedSubmissionId: 'q-1', input: input('After restart') });
    const from = s.requests.length;
    s.feed.serverUp();
    await until(() => s.graph.resolve(ref).state.content.parts[0].text === 'After restart', 3000, 'the refreshed queue');
    assert.deepEqual(s.requests.slice(from).map((r) => r.params.threadId), [s.ref.id], 'empty queues are not relisted on serverUp');
    const gate = new Promise((r) => { release = r; });
    let held = false;
    s.wire.request = async (_method, _params, _intent, next) => { const r = await next(); held = true; await gate; return r; };
    await s.app('thread/queue/update', { threadId: s.ref.id, queuedSubmissionId: 'q-1', input: input('Too late') });
    const late = s.feed.list(s.ref.id);
    await until(() => held, 3000, 'the late read');
    s.feed.notified('thread/queue/changed', { threadId: empty.id });
    s.feed.dispose();
    const disposedAt = s.requests.length;
    release();
    await late;
    await sleep(250);
    assert.equal(s.requests.length, disposedAt, 'all pending notification timers were cleared');
    assert.deepEqual(s.graph.resolve(ref).state.content, content('After restart'), 'an in-flight read cannot put after disposal');
  } finally { release?.(); await s.close(); }
});
