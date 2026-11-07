// The fake app-server's follow-up queue: per-thread order, pagination, mutations, a queued turn, failures without changes, and the
// experimental protocol shapes of every request, response and notification (each build since 20770).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

const input = (text) => [{ type: 'text', text, text_elements: [] }];

test('queue: add, list all pages, update, reorder, delete and start; every payload fits the experimental schemas', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    issues.push(...shapeIssues('params', method, params));
    const r = await f.request(method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    issues.push(...shapeIssues('result', method, r.result));
    return r.result;
  };
  try {
    const threadId = (await ask('thread/start', { cwd: '/tmp' })).thread.id;
    const other = (await ask('thread/start', { cwd: '/tmp/other' })).thread.id;
    assert.deepEqual(await ask('thread/queue/list', { threadId }), { data: [], nextCursor: null });
    const submissions = [];
    for (let i = 0; i < 53; i++) {
      const s = (await ask('thread/queue/add', { threadId, input: input(`message ${i}`), clientUserMessageId: `client-${i}` })).queuedSubmission;
      assert.deepEqual(s, { id: `q-${i + 1}`, input: input(`message ${i}`), clientUserMessageId: `client-${i}` });
      submissions.push(s);
    }
    assert.deepEqual(await ask('thread/queue/list', { threadId: other }), { data: [], nextCursor: null }, 'queues belong to their thread');
    const first = await ask('thread/queue/list', { threadId, cursor: null });
    assert.deepEqual(first, { data: submissions.slice(0, 50), nextCursor: '50' });
    assert.deepEqual(await ask('thread/queue/list', { threadId, cursor: first.nextCursor }), { data: submissions.slice(50), nextCursor: null });
    const edited = (await ask('thread/queue/update', { threadId, queuedSubmissionId: submissions[0].id, input: input('edited') })).queuedSubmission;
    assert.deepEqual(edited, { ...submissions[0], input: input('edited') }, 'id and client id stay');
    submissions[0] = edited;
    const order = submissions.map((s) => s.id).reverse();
    assert.deepEqual(await ask('thread/queue/reorder', { threadId, queuedSubmissionIds: order }), {});
    assert.deepEqual((await ask('thread/queue/list', { threadId })).data.map((s) => s.id), order.slice(0, 50));
    assert.deepEqual(await ask('thread/queue/delete', { threadId, queuedSubmissionId: submissions[1].id }), { deleted: true });
    const started = await ask('thread/queue/start', { threadId, queuedSubmissionId: submissions[0].id });
    assert.equal(started.turn.id, 'turn-q-1');
    assert.equal(started.turn.status, 'inProgress');
    assert.deepEqual(started.turn.items[0].content, input('edited'));
    const second = await ask('thread/queue/start', { threadId });
    assert.equal(second.turn.id, 'turn-q-2');
    assert.deepEqual(second.turn.items[0].content, submissions.at(-1).input, 'omitted id starts the first queued submission');
    const remaining = await ask('thread/queue/list', { threadId });
    assert.deepEqual(remaining.data.map((s) => s.id), order.filter((id) => ![submissions[0].id, submissions[1].id, submissions.at(-1).id].includes(id)));
    const history = await ask('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc' });
    assert.deepEqual(history.data.map((t) => t.id), ['turn-q-1', 'turn-q-2'], 'queued turns are in the thread history');
    await f.until(() => f.inbox.filter((n) => n.method === 'thread/queue/changed').length === 58);
    for (const n of f.inbox) issues.push(...shapeIssues('notification', n.method, n.params));
    const notifications = f.inbox.filter((n) => n.method === 'turn/started' || n.method === 'thread/queue/changed');
    assert.deepEqual(notifications.slice(-4).map((n) => n.method), ['turn/started', 'thread/queue/changed', 'turn/started', 'thread/queue/changed']);
    assert.deepEqual(notifications.find((n) => n.method === 'turn/started').params, { threadId, turn: started.turn });
    assert.deepEqual(issues, []);
    assert.equal(f.stderr(), '');
  } finally { await f.close(); }
});

test('queue: unknown threads or submissions and invalid permutations are -32600 and leave the queue alone', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    issues.push(...shapeIssues('params', method, params));
    const r = await f.request(method, params);
    if (r.result !== undefined) issues.push(...shapeIssues('result', method, r.result));
    return r;
  };
  try {
    const threadId = (await ask('thread/start', { cwd: '/tmp' })).result.thread.id;
    const first = (await ask('thread/queue/add', { threadId, input: input('one'), clientUserMessageId: 'one' })).result.queuedSubmission;
    const second = (await ask('thread/queue/add', { threadId, input: input('two'), clientUserMessageId: 'two' })).result.queuedSubmission;
    const methods = [
      ['thread/queue/add', { input: input('bad'), clientUserMessageId: 'bad' }],
      ['thread/queue/list', {}],
      ['thread/queue/update', { queuedSubmissionId: first.id, input: input('bad') }],
      ['thread/queue/delete', { queuedSubmissionId: first.id }],
      ['thread/queue/reorder', { queuedSubmissionIds: [first.id, second.id] }],
      ['thread/queue/start', { queuedSubmissionId: first.id }],
    ];
    for (const [method, params] of methods) assert.equal((await ask(method, { ...params, threadId: 'missing' })).error.code, -32600, method);
    for (const [method, params] of methods.filter(([m]) => ['thread/queue/update', 'thread/queue/delete', 'thread/queue/start'].includes(m))) {
      assert.equal((await ask(method, { ...params, threadId, queuedSubmissionId: 'missing' })).error.code, -32600, method);
    }
    for (const ids of [[first.id], [first.id, first.id], [first.id, 'missing'], [first.id, second.id, 'extra'], ['__proto__', second.id]]) {
      assert.equal((await ask('thread/queue/reorder', { threadId, queuedSubmissionIds: ids })).error.code, -32600);
    }
    for (const cursor of ['nope', '-1', '0.5', '9007199254740992']) assert.equal((await ask('thread/queue/list', { threadId, cursor })).error.code, -32600);
    const other = (await ask('thread/start', { cwd: '/tmp/other' })).result.thread.id;
    assert.equal((await ask('thread/queue/start', { threadId: other, queuedSubmissionId: first.id })).error.code, -32600, 'a submission of another thread is unknown');
    assert.deepEqual((await ask('thread/queue/list', { threadId })).result, { data: [first, second], nextCursor: null });
    assert.deepEqual((await ask('thread/queue/reorder', { threadId: other, queuedSubmissionIds: [] })).result, {});
    await f.until(() => f.inbox.filter((n) => n.method === 'thread/queue/changed').length === 3);
    for (const n of f.inbox) issues.push(...shapeIssues('notification', n.method, n.params));
    assert.deepEqual(issues, []);
  } finally { await f.close(); }
});
