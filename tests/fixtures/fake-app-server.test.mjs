// The strict fake app-server (release-2.md §4, integration.md §12): it refuses what it does not model, naming it, and never echoes; its
// modelled payloads match the schema of every build since 20770 (the newest, 21477, is its own protocol); it replays a build-tagged capture exactly, in order, and refuses anything off-script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEnv, newestBuild, buildsSince } from './captures.mjs';
import { frameIssues } from './schema-check.mjs';
import { startFake } from './fake-client.mjs';

const start = startFake;

test('modelled: anything it does not model is refused with an error that names it, never echoed', async () => {
  const f = start();
  try {
    assert.equal((await f.request('thread/start', {})).error.code, -32002, 'nothing before initialize');
    assert.equal((await f.request('initialize', { clientInfo: { name: 't' } })).result.userAgent, 'fake/primary');
    f.notify('initialized');
    // a real protocol method it does not model, and a made-up one
    for (const method of ['externalAgentConfig/detect', 'review/start', 'nope/never']) {
      const r = await f.request(method, { a: 1 });
      assert.equal(r.result, undefined, `${method}: no result, no echo`);
      assert.equal(r.error.code, -32601);
      assert.match(r.error.message, new RegExp(`request '${method.replace('/', '\\/')}' refused: not modelled`));
    }
    // a client notification it does not model is refused (it cannot be answered: stderr and fake/refusals)
    f.notify('thread/unheard', {});
    await f.until(() => /refused notification 'thread\/unheard'/.test(f.stderr()));
    // fake/notify and fake/serverRequest send only the build's protocol, or a synthetic name
    assert.match((await f.request('fake/notify', { method: 'made/up', params: {} })).error.message, /server notification 'made\/up' refused: not a server notification of build \d+\.\d+\.\d+-\d+/);
    assert.match((await f.request('fake/serverRequest', { method: 'made/up', params: {} })).error.message, /server request 'made\/up' refused: not a server request of build/);
    assert.deepEqual((await f.request('fake/notify', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'idle' } } })).result, {});
    await f.until(() => f.inbox.some((m) => m.method === 'thread/status/changed'));
    // an answer to a server request it never sent
    f.answer('srv-404', {});
    await f.until(() => /refused response 'srv-404'/.test(f.stderr()));
    const { refusals } = (await f.request('fake/refusals')).result;
    assert.deepEqual(refusals.map((r) => [r.kind, r.method]), [
      ['request', 'externalAgentConfig/detect'], ['request', 'review/start'], ['request', 'nope/never'], ['notification', 'thread/unheard'],
      ['server notification', 'made/up'], ['server request', 'made/up'], ['response', 'srv-404'],
    ]);
  } finally { await f.close(); }
});

test('modelled: the synthetic methods the tests use are modelled exactly; holds, steering and interruption follow the protocol', async () => {
  const f = start();
  try {
    await f.request('initialize', {});
    assert.deepEqual((await f.request('echo/anything', { n: 1 })).result, { echo: { method: 'echo/anything', params: { n: 1 } } });
    assert.deepEqual((await f.request('account/login/start', { type: 'apiKey', apiKey: '<redacted>' })).result, { type: 'apiKey' });
    const t = (await f.request('thread/start', { cwd: '/tmp/x' })).result.thread.id;
    // a held turn stays in progress until it is interrupted
    assert.deepEqual((await f.request('fake/hold', { threadId: t })).result, {});
    const turn = (await f.request('turn/start', { threadId: t, input: [] })).result.turn;
    assert.equal(turn.status, 'inProgress');
    assert.deepEqual((await f.request('turn/steer', { threadId: t, expectedTurnId: turn.id, input: [] })).result, { turnId: turn.id });
    await f.request('turn/interrupt', { threadId: t, turnId: turn.id });
    await f.until(() => f.inbox.some((m) => m.method === 'turn/completed'));
    assert.equal(f.inbox.find((m) => m.method === 'turn/completed').params.turn.status, 'interrupted');
    assert.equal(f.inbox.filter((m) => m.method === 'item/agentMessage/delta').length, 0, 'a held turn streams nothing');
    // a synthetic server request round trip
    const pending = f.request('fake/serverRequest', { method: 'item/ask', params: { q: 1 } });
    await f.until(() => f.inbox.some((m) => m.method === 'item/ask'));
    const ask = f.inbox.find((m) => m.method === 'item/ask');
    f.answer(ask.id, { ok: true });
    assert.deepEqual((await pending).result.answer.result, { ok: true });
    f.notify('note/x');   // a synthetic client notification: accepted
    assert.deepEqual((await f.request('fake/refusals')).result.refusals, []);
  } finally { await f.close(); }
});

// The modelled payloads are held to the schema of every build since 20770 (the newest one is the fake's own protocol: newestBuild()).
const BUILDS = buildsSince('26.1013.40934-20770');
const shapeIssues = (part, method, v) => BUILDS.flatMap((b) => frameIssues(b, part, method, v).map((i) => `${b} ${part} ${method}: ${i.path} ${i.message}`));

test('modelled: every reply and notification it sends matches the schema of each build since 20770 (only the values are fake)', async () => {
  assert.ok(BUILDS.includes(newestBuild()) && BUILDS[0] === '26.1013.40934-20770');
  const f = start();
  const sent = [];   // [part, method, payload]
  const ask = async (method, params) => { const r = await f.request(method, params); sent.push(['result', method, r.result]); return r.result; };
  try {
    await ask('initialize', { clientInfo: { name: 't', title: null, version: '1' } });
    f.notify('initialized');
    const t = (await ask('thread/start', { cwd: '/tmp/x' })).thread.id;
    await ask('thread/resume', { threadId: t });
    await ask('thread/fork', { threadId: t });
    await ask('thread/read', { threadId: t });
    await ask('thread/list', {});
    await ask('thread/list', { limit: 1 });
    await ask('turn/start', { threadId: t, input: [] });
    await ask('thread/compact/start', { threadId: t });
    await f.until(() => f.inbox.some((m) => m.method === 'thread/compacted'));
    await ask('turn/steer', { threadId: t, expectedTurnId: 'turn-1', input: [] });
    await ask('turn/interrupt', { threadId: t, turnId: 'turn-1' });
    // the C2 methods: names, goals, history, subscriptions
    await ask('thread/name/set', { threadId: t, name: 'Renamed' });
    await ask('thread/goal/get', { threadId: t });
    await ask('thread/goal/set', { threadId: t, objective: 'ship it', tokenBudget: 1000 });
    await ask('thread/goal/set', { threadId: t, status: 'paused' });
    await ask('thread/goal/get', { threadId: t });
    await ask('thread/goal/clear', { threadId: t });
    await ask('thread/goal/clear', { threadId: t });
    await ask('turn/start', { threadId: t, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
    for (const itemsView of [undefined, 'notLoaded', 'summary', 'full']) await ask('thread/turns/list', { threadId: t, itemsView });
    await ask('thread/turns/list', { threadId: t, limit: 1, sortDirection: 'asc' });
    await ask('thread/items/list', { threadId: t });
    await ask('thread/items/list', { threadId: t, turnId: 'turn-2', limit: 1, sortDirection: 'desc' });
    await ask('thread/items/list', { threadId: t, turnId: 'turn-2', cursor: { type: 'item', itemId: 'turn-2-user' } });
    await ask('thread/unsubscribe', { threadId: t });
    await ask('thread/unsubscribe', { threadId: t });
    await ask('thread/unsubscribe', { threadId: 'thr-unknown' });
    for (const m of f.inbox) if (m.id === undefined) sent.push(['notification', m.method, m.params]);
    assert.ok(sent.filter(([p]) => p === 'notification').length >= 6);
    const names = new Set(f.inbox.map((m) => m.method));
    for (const n of ['thread/name/updated', 'thread/goal/updated', 'thread/goal/cleared']) assert.ok(names.has(n), `${n} was sent`);
    assert.deepEqual(sent.filter(([p, m]) => p === 'result' && m === 'thread/unsubscribe').map(([, , v]) => v.status), ['unsubscribed', 'notSubscribed', 'notLoaded']);
    const issues = sent.flatMap(([part, method, v]) => shapeIssues(part, method, v));
    assert.deepEqual(issues, []);
  } finally { await f.close(); }
});

/** A started fake with a thread, and `ask`: a request whose params and result must match the schema of every modelled build (a reply with an error is returned whole, unchecked); `bad` sends anything. */
async function withThread(o) {
  const f = start(o);
  const problems = [];
  const ask = async (method, params) => {
    problems.push(...shapeIssues('params', method, params));
    const r = await f.request(method, params);
    if (!r.error) problems.push(...shapeIssues('result', method, r.result));
    return r.error ? r : r.result;
  };
  /** Everything the fake sent unasked must match the schema too. */
  const issues = () => [...problems, ...f.inbox.filter((m) => m.id === undefined).flatMap((m) => shapeIssues('notification', m.method, m.params))];
  await ask('initialize', { clientInfo: { name: 't', title: null, version: '1' } });
  f.notify('initialized');
  const thread = (await ask('thread/start', { cwd: '/tmp/x' })).thread.id;
  /** A request with params the schema does not allow, to see it refused: the whole reply. */
  const bad = (method, params) => f.request(method, params);
  return { f, ask, bad, issues, thread, notifications: (method) => f.inbox.filter((m) => m.method === method).map((m) => m.params) };
}
const text = (t) => ({ type: 'text', text: t, text_elements: [] });

test('modelled: thread/name/set stores the name on the thread, shows it in thread/read and thread/list, and announces it', async () => {
  const { f, ask, issues, thread, notifications } = await withThread();
  try {
    assert.deepEqual(await ask('thread/name/set', { threadId: thread, name: '  My thread  ' }), {});
    await f.until(() => notifications('thread/name/updated').length === 1);
    assert.deepEqual(notifications('thread/name/updated'), [{ threadId: thread, threadName: 'My thread' }]);
    assert.equal((await ask('thread/read', { threadId: thread })).thread.name, 'My thread');
    assert.equal((await ask('thread/list', {})).data.find((t) => t.id === thread).name, 'My thread');
    assert.equal((await ask('thread/list', { limit: 5 })).data.find((t) => t.id === thread).name, 'My thread', 'a paged list shows it too');
    assert.equal((await ask('thread/name/set', { threadId: 'thr-nope', name: 'x' })).error.code, -32600);
    assert.match((await ask('thread/name/set', { threadId: thread, name: '   ' })).error.message, /must not be empty/);
    assert.equal((await ask('thread/read', { threadId: thread })).thread.name, 'My thread', 'a refused rename changes nothing');
    assert.equal(notifications('thread/name/updated').length, 1);
    assert.deepEqual(issues(), []);
  } finally { await f.close(); }
});

test('modelled: thread/list sorts like Codex (created_at desc by default, sortKey, sortDirection) and pages by offset over the sorted list', async () => {
  const { f, ask, bad, issues, thread } = await withThread();
  try {
    const ids = [thread];
    for (let i = 0; i < 4; i++) ids.push((await ask('thread/start', { cwd: '/tmp/y' })).thread.id);
    const times = (r) => r.data.map((t) => t.createdAt);
    const first = await ask('thread/list', {});
    assert.deepEqual(first.data.map((t) => t.id), [...ids].reverse(), 'newest first by default');
    assert.equal(new Set(times(first)).size, 5, 'created threads have distinct, increasing times');
    assert.deepEqual(times(first), [...times(first)].sort((a, b) => b - a));
    assert.deepEqual(first.data.map((t) => t.updatedAt), times(first), 'updatedAt starts equal to createdAt');
    for (const sortKey of ['created_at', 'updated_at', 'recency_at']) {
      assert.deepEqual((await ask('thread/list', { sortKey })).data.map((t) => t.id), [...ids].reverse(), `${sortKey} desc`);
      assert.deepEqual((await ask('thread/list', { sortKey, sortDirection: 'asc' })).data.map((t) => t.id), ids, `${sortKey} asc`);
    }
    assert.deepEqual((await ask('thread/list', { sortKey: 'section_position' })).data.map((t) => t.id), ids, 'section_position: no sections, creation order');
    assert.deepEqual((await ask('thread/list', { sortKey: null, sortDirection: null })).data.map((t) => t.id), [...ids].reverse(), 'null means the default');
    // Paging by offset over the sorted order.
    const walked = [];
    let page = await ask('thread/list', { limit: 2, sortDirection: 'asc' });
    for (;;) {
      walked.push(page.data.map((t) => t.id));
      if (!page.nextCursor) break;
      page = await ask('thread/list', { limit: 2, sortDirection: 'asc', cursor: page.nextCursor });
    }
    assert.deepEqual(walked, [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    // What it refuses: a bad sort, and a cursor that is not one of its offsets (another party's cursor must never leak to Codex).
    assert.match((await bad('thread/list', { sortKey: 'size' })).error.message, /sortKey 'size'/);
    assert.match((await bad('thread/list', { sortDirection: 'up' })).error.message, /sortDirection 'up'/);
    assert.equal((await bad('thread/list', { cursor: 'codexmods1:abc' })).error.code, -32600);
    assert.equal((await bad('thread/list', { cursor: '-1' })).error.code, -32600);
    // A thread loaded by resuming an unknown id is the oldest.
    await ask('thread/resume', { threadId: 'thr-from-disk' });
    assert.equal((await ask('thread/list', {})).data.at(-1).id, 'thr-from-disk');
    assert.deepEqual(issues(), []);
  } finally { await f.close(); }
});

test('modelled: thread goals are kept per thread; set creates or updates, get reads, clear removes, each announced', async () => {
  const { f, ask, issues, thread, notifications } = await withThread();
  try {
    const other = (await ask('thread/start', { cwd: '/tmp/y' })).thread.id;
    assert.deepEqual(await ask('thread/goal/get', { threadId: thread }), { goal: null });
    assert.match((await ask('thread/goal/set', { threadId: thread, status: 'paused' })).error.message, /without an objective/);
    assert.equal((await ask('thread/goal/set', { threadId: thread, objective: '  ' })).error.code, -32600);
    const { goal } = await ask('thread/goal/set', { threadId: thread, objective: ' ship it ', tokenBudget: 500, origin: 'user' });
    assert.deepEqual({ ...goal, createdAt: 0, updatedAt: 0 }, { threadId: thread, objective: 'ship it', status: 'active', tokenBudget: 500, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 });
    // without an objective the existing goal is updated in place
    const paused = (await ask('thread/goal/set', { threadId: thread, status: 'paused' })).goal;
    assert.deepEqual([paused.objective, paused.status, paused.tokenBudget, paused.createdAt], ['ship it', 'paused', 500, goal.createdAt]);
    assert.ok(paused.updatedAt > goal.updatedAt, 'an update moves updatedAt');
    assert.equal((await ask('thread/goal/set', { threadId: thread, tokenBudget: null })).goal.tokenBudget, null);
    assert.deepEqual((await ask('thread/goal/get', { threadId: thread })).goal.status, 'paused');
    assert.deepEqual(await ask('thread/goal/get', { threadId: other }), { goal: null }, 'goals are per thread');
    // a new objective is a fresh goal
    const fresh = (await ask('thread/goal/set', { threadId: thread, objective: 'something else' })).goal;
    assert.deepEqual([fresh.objective, fresh.status, fresh.tokenBudget], ['something else', 'active', null]);
    await f.until(() => notifications('thread/goal/updated').length === 4);
    assert.deepEqual(notifications('thread/goal/updated').map((n) => [n.threadId, n.turnId, n.goal.objective, n.goal.status]), [
      [thread, null, 'ship it', 'active'], [thread, null, 'ship it', 'paused'], [thread, null, 'ship it', 'paused'], [thread, null, 'something else', 'active'],
    ]);
    assert.deepEqual(await ask('thread/goal/clear', { threadId: thread, origin: 'user' }), { cleared: true });
    assert.deepEqual(await ask('thread/goal/clear', { threadId: thread }), { cleared: false });
    assert.deepEqual(await ask('thread/goal/get', { threadId: thread }), { goal: null });
    await f.until(() => notifications('thread/goal/cleared').length === 1);
    await ask('thread/goal/get', { threadId: thread });   // a round trip after the second clear: it announced nothing
    assert.deepEqual(notifications('thread/goal/cleared'), [{ threadId: thread }]);
    for (const m of ['get', 'set', 'clear']) assert.equal((await f.request(`thread/goal/${m}`, { threadId: 'thr-nope', objective: 'x' })).error.code, -32600);
    // a goal set during a held turn names that turn
    await f.request('fake/hold', { threadId: thread });
    const turn = (await ask('turn/start', { threadId: thread, input: [] })).turn.id;
    await ask('thread/goal/set', { threadId: thread, objective: 'during a turn' });
    await f.until(() => notifications('thread/goal/updated').length === 5);
    assert.equal(notifications('thread/goal/updated')[4].turnId, turn);
    assert.deepEqual(issues(), []);
  } finally { await f.close(); }
});

test('modelled: turn/start records its items on the thread; thread/turns/list and thread/items/list return them with paging and itemsView', async () => {
  const { f, ask, bad, issues, thread } = await withThread();
  try {
    assert.deepEqual(await ask('thread/turns/list', { threadId: thread }), { data: [], nextCursor: null, backwardsCursor: null });
    assert.deepEqual(await ask('thread/items/list', { threadId: thread }), { data: [], nextCursor: null, backwardsCursor: null });
    // turn 1 completes on its own, turn 2 is held and steered, turn 3 completes
    const input1 = [text('first'), { type: 'mention', name: 'f', path: '/tmp/f' }];
    const t1 = (await ask('turn/start', { threadId: thread, input: input1 })).turn.id;
    await f.until(() => f.inbox.filter((m) => m.method === 'turn/completed').length === 1);
    await f.request('fake/hold', { threadId: thread });
    const t2 = (await ask('turn/start', { threadId: thread, input: [text('second')] })).turn.id;
    assert.equal((await ask('thread/turns/list', { threadId: thread, limit: 1 })).data[0].status, 'inProgress', 'a held turn is in progress');
    await ask('turn/steer', { threadId: thread, expectedTurnId: t2, input: [text('steer')] });
    await f.request('fake/finishTurn', { threadId: thread });
    await f.until(() => f.inbox.filter((m) => m.method === 'turn/completed').length === 2);
    const t3 = (await ask('turn/start', { threadId: thread, input: [text('third')] })).turn.id;
    await f.until(() => f.inbox.filter((m) => m.method === 'turn/completed').length === 3);
    // the notifications keep their shape: items are not repeated there
    assert.ok(f.inbox.filter((m) => m.method === 'turn/completed').every((m) => m.params.turn.items.length === 0));

    // thread/turns/list: newest first by default, oldest first on request; the default view is the summary
    const desc = await ask('thread/turns/list', { threadId: thread });
    assert.deepEqual(desc.data.map((t) => t.id), [t3, t2, t1]);
    assert.deepEqual(desc.data.map((t) => t.status), ['completed', 'completed', 'completed']);
    assert.equal(desc.nextCursor, null);
    assert.deepEqual((await ask('thread/turns/list', { threadId: thread, sortDirection: 'asc' })).data.map((t) => t.id), [t1, t2, t3]);
    assert.deepEqual(desc.data.map((t) => t.itemsView), ['summary', 'summary', 'summary']);
    const [full3, full2, full1] = (await ask('thread/turns/list', { threadId: thread, itemsView: 'full' })).data;
    assert.deepEqual(full1.items, [{ type: 'userMessage', id: `${t1}-user`, content: input1 }, { type: 'agentMessage', id: `${t1}-msg`, text: 'abc' }]);
    assert.equal(full1.itemsView, 'full');
    assert.deepEqual(full3.items.map((i) => i.type), ['userMessage', 'agentMessage']);
    assert.deepEqual(full2.items.map((i) => [i.type, i.id]), [['userMessage', `${t2}-user`], ['userMessage', `${t2}-steer-1`]], 'a held turn streamed nothing; the steer input is its second user message');
    assert.deepEqual(full2.items[1].content, [text('steer')]);
    // summary: the first user message and the last agent message; notLoaded: no items
    assert.deepEqual((await ask('thread/turns/list', { threadId: thread, itemsView: 'summary' })).data[1].items.map((i) => i.id), [`${t2}-user`]);
    const bare = (await ask('thread/turns/list', { threadId: thread, itemsView: 'notLoaded' })).data;
    assert.deepEqual([bare.map((t) => t.items.length), bare.map((t) => t.itemsView)], [[0, 0, 0], ['notLoaded', 'notLoaded', 'notLoaded']]);
    // paging walks the turns with next cursors; the backwards cursor re-reads the page's first turn the other way
    const p1 = await ask('thread/turns/list', { threadId: thread, limit: 2 });
    assert.deepEqual(p1.data.map((t) => t.id), [t3, t2]);
    assert.ok(p1.nextCursor && p1.backwardsCursor);
    const p2 = await ask('thread/turns/list', { threadId: thread, limit: 2, cursor: p1.nextCursor });
    assert.deepEqual([p2.data.map((t) => t.id), p2.nextCursor], [[t1], null]);
    assert.deepEqual((await ask('thread/turns/list', { threadId: thread, limit: 5, cursor: p1.backwardsCursor, sortDirection: 'asc' })).data.map((t) => t.id), [t3], 'newest turn onward, oldest first: just the anchor');
    assert.deepEqual((await ask('thread/turns/list', { threadId: thread, limit: 5, cursor: p2.backwardsCursor, sortDirection: 'asc' })).data.map((t) => t.id), [t1, t2, t3]);
    assert.equal((await ask('thread/turns/list', { threadId: thread, cursor: 'bogus' })).error.code, -32600);
    assert.equal((await bad('thread/turns/list', { threadId: thread, itemsView: 'everything' })).error.code, -32602);
    assert.equal((await ask('thread/turns/list', { threadId: 'thr-nope' })).error.code, -32600);
    assert.equal((await bad('thread/turns/list', {})).error.code, -32602);

    // thread/items/list: every item, oldest first, each with its turn
    const all = await ask('thread/items/list', { threadId: thread });
    assert.deepEqual(all.data.map((e) => [e.turnId, e.item.id]), [
      [t1, `${t1}-user`], [t1, `${t1}-msg`], [t2, `${t2}-user`], [t2, `${t2}-steer-1`], [t3, `${t3}-user`], [t3, `${t3}-msg`],
    ]);
    assert.equal(all.nextCursor, null);
    assert.deepEqual((await ask('thread/items/list', { threadId: thread, sortDirection: 'desc' })).data.map((e) => e.item.id), all.data.map((e) => e.item.id).reverse());
    assert.deepEqual((await ask('thread/items/list', { threadId: thread, turnId: t3 })).data.map((e) => e.item.id), [`${t3}-user`, `${t3}-msg`]);
    assert.equal((await ask('thread/items/list', { threadId: thread, turnId: t3 })).data[1].item.text, 'abc');
    // paging with the returned cursor, and an item anchor inside one turn
    const seen = [];
    for (let page = await ask('thread/items/list', { threadId: thread, limit: 4 }); ; page = await ask('thread/items/list', { threadId: thread, limit: 4, cursor: page.nextCursor })) {
      seen.push(page.data.length);
      if (!page.nextCursor) break;
    }
    assert.deepEqual(seen, [4, 2]);
    assert.deepEqual((await ask('thread/items/list', { threadId: thread, turnId: t1, cursor: { type: 'item', itemId: `${t1}-user` } })).data.map((e) => e.item.id), [`${t1}-msg`]);
    assert.deepEqual((await ask('thread/items/list', { threadId: thread, turnId: t1, cursor: { type: 'item', itemId: `${t1}-msg` }, sortDirection: 'desc' })).data.map((e) => e.item.id), [`${t1}-user`], 'descending returns the items before the anchor');
    assert.equal((await ask('thread/items/list', { threadId: thread, cursor: { type: 'item', itemId: `${t1}-user` } })).error.code, -32600, 'an item anchor needs a turn');
    assert.equal((await ask('thread/items/list', { threadId: thread, turnId: 'turn-404' })).error.code, -32600);
    assert.equal((await ask('thread/items/list', { threadId: 'thr-nope' })).error.code, -32600);
    // another thread has its own turns; an interrupted held turn is recorded as interrupted
    const other = (await ask('thread/start', { cwd: '/tmp/y' })).thread.id;
    assert.deepEqual((await ask('thread/turns/list', { threadId: other })).data, []);
    await f.request('fake/hold', { threadId: other });
    const held = (await ask('turn/start', { threadId: other, input: [text('hold')] })).turn.id;
    await ask('turn/interrupt', { threadId: other, turnId: held });
    await f.until(() => f.inbox.filter((m) => m.method === 'turn/completed').length === 4);
    assert.deepEqual((await ask('thread/turns/list', { threadId: other })).data.map((t) => [t.id, t.status]), [[held, 'interrupted']]);
    assert.deepEqual(issues(), []);
  } finally { await f.close(); }
});

test('modelled: fs/readDirectory, fs/getMetadata and fs/watch read the disk; fake/fsChanged notifies the watches of a path or its folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-fs-'));
  const { f, ask, issues, notifications } = await withThread();
  try {
    await writeFile(join(dir, 'a.txt'), 'hello');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'sub')));
    const { entries } = await ask('fs/readDirectory', { path: dir });
    assert.deepEqual(entries.sort((a, b) => a.fileName.localeCompare(b.fileName)), [{ fileName: 'a.txt', isDirectory: false, isFile: true }, { fileName: 'sub', isDirectory: true, isFile: false }]);
    const meta = await ask('fs/getMetadata', { path: join(dir, 'a.txt') });
    assert.deepEqual([meta.isFile, meta.isDirectory, meta.isSymlink, meta.modifiedAtMs > 0, 'size' in meta], [true, false, false, true, false]);
    assert.match((await ask('fs/getMetadata', { path: join(dir, 'nope') })).error.message, /ENOENT/);
    assert.equal((await ask('fs/readDirectory', { path: 'relative' })).error.code, -32602);
    assert.ok((await ask('fs/watch', { watchId: 'w1', path: dir })).path.endsWith(dir.split('/').pop()));
    assert.equal((await ask('fs/watch', { watchId: 'w1', path: dir })).error.code, -32600, 'a watchId in use');
    await ask('fake/fsChanged', { path: join(dir, 'a.txt') });
    await f.until(() => notifications('fs/changed').length === 1);
    assert.deepEqual(notifications('fs/changed'), [{ watchId: 'w1', changedPaths: [join(dir, 'a.txt')] }]);
    await ask('fs/unwatch', { watchId: 'w1' });
    await ask('fake/fsChanged', { path: join(dir, 'a.txt') });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notifications('fs/changed').length, 1);
    assert.deepEqual(issues().filter((i) => !/fake\/fsChanged/.test(i)), []);
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('modelled: thread/unsubscribe answers per connection: unsubscribed once for a started, resumed or forked thread, then notSubscribed; notLoaded when unknown', async () => {
  const { f, ask, bad, issues, thread } = await withThread();
  try {
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: thread }), { status: 'unsubscribed' });
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: thread }), { status: 'notSubscribed' });
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: 'thr-nope' }), { status: 'notLoaded' });
    await ask('thread/resume', { threadId: thread });
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: thread }), { status: 'unsubscribed' }, 'resuming subscribes again');
    const forked = (await ask('thread/fork', { threadId: thread })).thread.id;
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: forked }), { status: 'unsubscribed' });
    await ask('thread/resume', { threadId: 'thr-elsewhere' });   // resuming an id this process never made loads it
    assert.deepEqual(await ask('thread/unsubscribe', { threadId: 'thr-elsewhere' }), { status: 'unsubscribed' });
    assert.equal((await bad('thread/unsubscribe', {})).error.code, -32602);
    assert.deepEqual(issues(), []);
  } finally { await f.close(); }
});

test('replay: a captured server request is sent when its turn comes, and the client\'s answer must contain the captured one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-replay-'));
  const file = join(dir, 'approval.json');
  await writeFile(file, JSON.stringify({
    format: 'codexmods.capture/1', build: '26.1013.40934-20770', recorded: '2026-10-16', source: 'a test', doc: 'an approval round trip', sanitized: ['S1', 'S2', 'S3', 'S4'],
    sessions: { '*': [
      { client: 'initialize', result: { userAgent: 'u', codexHome: '/Users/user/.codex', platformFamily: 'unix', platformOs: 'macos' } },
      { client: 'turn/start', params: { threadId: 't1' }, result: { turn: { id: 'u1' } } },
      { notify: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } },
      { serverRequest: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1' }, answer: { decision: 'accept' } },
      { notify: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1' } } },
    ] },
  }));
  const f = start({ env: replayEnv(file), name: 'anything' });
  try {
    await f.request('initialize', {});
    await f.request('turn/start', { threadId: 't1', input: [] });
    await f.until(() => f.inbox.length === 3);
    assert.deepEqual(f.inbox.map((m) => m.method), ['turn/started', 'item/commandExecution/requestApproval', 'turn/completed']);
    let s = (await f.request('fake/replay/status')).result;
    assert.deepEqual([s.done, s.pendingAnswers], [false, 1], 'waiting for the answer');
    f.answer(f.inbox[1].id, { decision: 'decline' });
    s = (await f.request('fake/replay/status')).result;
    assert.deepEqual([s.done, s.refusals[0]?.kind], [true, 'response'], 'a different answer is refused');
    assert.match(s.refusals[0].reason, /differs from the captured one/);
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('replay: a capture that breaks its format, its build\'s protocol or the sanitization rules does not load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-replay-'));
  const file = join(dir, 'bad.json');
  await writeFile(file, JSON.stringify({ format: 'codexmods.capture/1', build: '26.1013.40934-20770', recorded: '2026-10-16', source: 's', doc: 'd', sanitized: ['S1', 'S2', 'S3', 'S4'], sessions: { '*': [{ client: 'made/up', result: {} }] } }));
  const f = start({ env: replayEnv(file) });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.match(f.stderr(), /'made\/up' is not a client request of build 26\.1013\.40934-20770/);
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});
