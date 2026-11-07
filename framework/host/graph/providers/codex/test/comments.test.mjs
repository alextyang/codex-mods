// Comments through the real graph, source, mux and fake app-server; main reports and operations use the real area channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userContent, turnData, itemData } from '../map.mjs';
import * as changes from '../areas/changes.mjs';
import * as review from '../areas/review.mjs';
import * as comments from '../areas/comments.mjs';
import { produced } from './areas/comments.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user' }, mod = { kind: 'mod', id: 'mod.comments' };
const content = (text) => userContent([{ type: 'text', text }]);
const comment = (text = 'Keep the guard.', extra = {}) => ({ type: 'comment', content: [{ content_type: 'text', text }],
  position: { side: 'right', path: 'src/a.js', line: 4 }, ...extra });
const turn = (id, items = []) => ({ id, status: 'completed', startedAt: 1, completedAt: 2, error: null, items });
const userMessage = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] });
const messageText = (...entries) => '\n# Diff comments:\n' + entries.map((c, i) => comments.commentBlock(c, i + 1)).join('') + '\n## My request:\nPlease check.\n';
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const refused = (r, reason, message) => {
  assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason);
  if (message) assert.equal(r.message, message);
};

async function setup({ main = true, learnSend = false } = {}) {
  const h = await harness(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-comments-'));
  const events = [], prompts = [], ops = [], requests = [], warnings = [], puts = [], notes = [], reads = [];
  const stored = new Map(), answers = new Map(), history = new Map();
  let sequence = 8000, feed, context, approved = true, mainOps, requestError = null;
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const ask = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.result;
  };
  const replay = h.mux.client('test:comments-reads');
  replay.intercept('serverResponse', ['thread/read', 'thread/resume', 'thread/turns/list'], (m, info) => {
    reads.push({ method: info.method, threadId: info.affinityKey });
    const rows = history.get(info.affinityKey);
    if (!rows) return;
    const result = info.method === 'thread/turns/list' ? { data: [...rows].reverse(), nextCursor: null }
      : { ...m.result, thread: { ...m.result.thread, turns: rows } };
    return { replace: { ...m, result } };
  });
  if (main) mainOps = createMainOps({ log, send(m) {
    ops.push([m.area, m.op, m.args]);
    queueMicrotask(async () => {
      try {
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          mainOps.settle({ requestId: m.requestId, ...(typeof answer === 'function' ? await answer(m.args) : answer) }); return;
        }
        if (m.area === 'review') {
          assert.equal(m.op, 'dismissed');
          mainOps.settle({ requestId: m.requestId, ok: true, result: { dismissed: [] } }); return;
        }
        assert.equal(m.area, 'comments');
        let list = stored.get(m.args.threadId) ?? [];
        if (m.op === 'edit') {
          list = [...list];
          for (const removed of m.args.removed) {
            const index = list.findIndex((c) => isDeepStrictEqual(c, removed));
            if (index < 0 && m.args.added.length) throw new Error('the test edit did not match its removal');
            if (index >= 0) list.splice(index, 1);
          }
          for (const { comment, index } of m.args.added) list.splice(index, 0, comment);
          stored.set(m.args.threadId, list);
          mainOps.report({ area: 'comments', report: { conversationId: m.args.threadId, comments: list } });
        } else assert.equal(m.op, 'read');
        mainOps.settle({ requestId: m.requestId, ok: true, result: { comments: list } });
      } catch (e) { mainOps.settle({ requestId: m.requestId, ok: false, refused: false, error: e.message }); }
    });
  } });
  const area = { ...comments, createFeed(ctx) {
    context = ctx;
    feed = comments.createFeed({ ...ctx,
      handle: { ...ctx.handle, put(ref, data) { puts.push([ref, data]); return ctx.handle.put(ref, data); } },
      async request(method, params, intent) {
        requests.push({ method, params, intent });
        if (requestError) { const error = requestError; requestError = null; throw error; }
        const result = await ctx.request(method, params, intent);
        if (learnSend && method === 'turn/start') await ask('fake/notify', { method: 'item/completed', params: {
          threadId: params.threadId, turnId: result.turn.id, item: { type: 'userMessage', id: `${result.turn.id}-user`, content: params.input },
        } });
        return result;
      },
    });
    return { ...feed, notified(method, params) { feed.notified(method, params); notes.push(method); } };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, mainOps, areas: { changes, review, comments: area } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Comment') events.push([e.ref, e.name]); });
  await source.start();
  const threadId = (await ask('thread/start', { cwd: '/repo' })).thread.id;
  await ask('thread/name/set', { threadId, name: 'Chat' });
  await until(() => graph.resolve(refs.thread(threadId))?.state.title === 'Chat');
  const notify = async (method, params) => {
    const n = notes.length;
    await ask('fake/notify', { method, params });
    await until(() => notes.slice(n).includes(method), 3000, method);
    assert.deepEqual(warnings, []);
  };
  const startTurn = (id = 'u') => notify('turn/started', { threadId, turn: { ...turn(id), status: 'inProgress' } });
  const state = (ref) => graph.resolve(ref)?.state;
  return {
    h, graph, source, feed, context, threadId, events, prompts, ops, requests, warnings, puts, stored, answers, history, reads, ask, notify, startTurn, state,
    invoke: (ref, operation, args = [], caller = user) => graph.invoke({ ref, operation, args, caller }),
    approve(value) { approved = value; }, failRequest(error) { requestError = error; },
    report(list, id = threadId) { stored.set(id, list); mainOps.report({ area: 'comments', report: { conversationId: id, comments: list } }); },
    ref: (c) => refs.comment(threadId, comments.keyOf(c)),
    message: (text, id = 'message', turnId = 'u') => notify('item/completed', { threadId, turnId, item: userMessage(id, text) }),
    async change(p = '/repo/src/a.js', diff = '@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n') {
      await startTurn();
      await notify('item/completed', { threadId, turnId: 'u', item: { type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: p, kind: { type: 'update', move_path: null }, diff }] } });
      return refs.hunk(refs.fileChange('turn:u', p).id, 0);
    },
    async finding() {
      await startTurn('review');
      await notify('item/completed', { threadId, turnId: 'review', item: userMessage('review-input', '## Code review guidelines:\nReview the current code changes (staged, unstaged and untracked).') });
      await notify('item/completed', { threadId, turnId: 'review', item: { type: 'agentMessage', id: 'review-answer', phase: 'final_answer',
        text: '::code-comment{title="Keep the guard" body="An unchecked value." file="src/a.js" start=2 end=4}' } });
      await until(() => state(refs.finding('review', 0)), 3000, 'the finding');
      return refs.finding('review', 0);
    },
    async close() { await source.dispose(); mainOps?.dispose(); await replay.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('keys hash the app identity, blocks match its exact text, and sent parsing preserves ranges, workspaces, hunks and both sides', () => {
  const one = comment('First\nsecond', { localWorkspaceRoot: '/repo', localDiffHunk: '@@ -2 +2 @@\n-old\n+new', position: { path: 'src/a.js', side: 'right', start_line: 2, line: 4 } });
  const block = '\n## User Comment 1\nFile: src/a.js\nWorkspace: /repo\nSide: R\nLines: 2-4\nDiff hunk:\n```diff\n@@ -2 +2 @@\n-old\n+new\n```\nComment:\nFirst\nsecond\n';
  assert.equal(comments.commentBlock(one, 1), block);
  assert.equal(comments.keyOf(one), createHash('sha1').update('src/a.js|right|2-4|First\nsecond').digest('hex').slice(0, 16));
  assert.equal(comments.keyOf({ ...one, localWorkspaceRoot: '/elsewhere', isResolved: true }), comments.keyOf(one));
  assert.deepEqual(comments.parseSent('\n# Diff comments:\n' + block + '\n## My request:\nRequest\n'), [
    { n: 1, path: 'src/a.js', workspace: '/repo', side: 'R', lines: '2-4', text: 'First\nsecond' },
  ]);
  const two = comment('Left\n\n', { position: { path: 'other.js', side: 'left', line: 9 }, localDiffHunk: '  \n' });
  assert.equal(comments.commentBlock(two, 2), '\n## User Comment 2\nFile: other.js\nSide: L\nLines: 9\nComment:\nLeft\n\n\n');
  assert.deepEqual(comments.parseSent(messageText(one, two)), [
    { n: 1, path: 'src/a.js', workspace: '/repo', side: 'R', lines: '2-4', text: 'First\nsecond' },
    { n: 2, path: 'other.js', workspace: undefined, side: 'L', lines: '9', text: 'Left\n\n' },
  ]);
  for (const [start_side, side, label] of [['left', 'right', 'L-R'], ['right', 'left', 'R-L']]) {
    const cross = comment('Across', { position: { path: 'a', start_side, side, start_line: 3, line: 7 } });
    const lines = `${label[0]}3-${label.at(-1)}7`;
    assert.match(comments.commentBlock(cross, 1), new RegExp(`Side: ${label}\\nLines: ${lines}`));
    assert.equal(comments.parseSent(messageText(cross))[0].lines, lines);
    assert.equal(comments.keyOf(cross), createHash('sha1').update(`a|${side}|${lines}|Across`).digest('hex').slice(0, 16));
  }
  assert.deepEqual(comments.parseSent('Nothing here'), []);
  assert.deepEqual(comments.parseSent('## My request:\n' + block), [], 'comment-shaped request text is not context');
  assert.deepEqual(comments.parseSent('\n## My request:\n' + block), []);
  assert.equal(comments.commentBlock(comment('', { position: { path: 'a', side: 'right', start_line: 4, line: 4 } }), 1).includes('Lines: 4\n'), true);
});

test('data and declaration samples include all links, draft, sent and resolved states, authors and anchors', () => {
  const [draft, sent, reviewer] = produced();
  assert.deepEqual(draft.state, { content: content('Keep the guard.'), author: 'you', anchor: { path: 'a.js', line: 2, endLine: 4 }, state: 'draft' });
  assert.deepEqual(draft.links, { thread: refs.thread('t'), fileChange: refs.fileChange('thread:t', '/repo/a.js'), finding: refs.finding('review', 0) });
  assert.deepEqual(sent.ref, refs.comment('t', 'sent-t:message-1'));
  assert.equal(sent.state.state, 'sent');
  assert.deepEqual([reviewer.state.author, reviewer.state.state], ['reviewer', 'resolved']);
  assert.deepEqual(comments.commentData('t', comment()).state.anchor, { path: 'src/a.js', line: 4 });
});

test('main reports replace drafts, link resident thread files and workspace paths, and resolve review threads after the initial sync', async () => {
  const s = await setup();
  try {
    const a = comment(), b = comment('Review', { reviewThreadId: 'review-thread', isResolved: false });
    s.report([a, b]);
    assert.deepEqual(s.graph.resolve(s.ref(a)).links, { thread: refs.thread(s.threadId), fileChange: null, finding: null });
    assert.deepEqual([s.state(s.ref(b)).state, s.state(s.ref(b)).author], ['sent', 'reviewer']);
    await s.change();
    const file = refs.fileChange(refs.changeSet('thread', s.threadId).id, '/repo/src/a.js');
    assert.deepEqual(s.graph.resolve(s.ref(a)).links.fileChange, file);
    assert.equal(s.graph.related(file, 'comments').length, 2);
    assert.deepEqual(s.events, []);
    s.report([a, { ...b, isResolved: true }]);
    assert.deepEqual(s.events, [[s.ref(b), 'resolved']]);
    const puts = s.puts.length;
    s.report([a, { ...b, isResolved: true }]);
    assert.equal(s.puts.length, puts);
    assert.equal(s.events.length, 1);
    s.report([b]);
    assert.equal(s.graph.resolve(s.ref(a)).gone, true);
    const other = comment('Other workspace', { localWorkspaceRoot: '/other' });
    s.report([other]);
    assert.equal(s.graph.resolve(s.ref(other)).links.fileChange, null);
    s.report([comment('Pending')], 'client-new-thread:uuid');
    s.report([comment('Invalid')], '');
    assert.equal(s.graph.list('Comment').filter((c) => !c.gone).length, 1);
    s.report([]); assert.equal(s.graph.resolve(s.ref(other)).gone, true);
  } finally { await s.close(); }
});

test('observing a Comment reads the app drafts and loads messages, while other concepts are left alone', async () => {
  const s = await setup();
  try {
    const a = comment('From read'); s.stored.set(s.threadId, [a]);
    const view = s.graph.subscribe({ ref: s.ref(a) }, () => {});
    await view.loaded; view.dispose();
    assert.deepEqual(s.state(s.ref(a)), comments.commentData(s.threadId, a).state);
    assert.deepEqual(s.ops.filter(([area]) => area === 'comments'), [['comments', 'read', { threadId: s.threadId }]]);
    assert.ok(s.reads.some((r) => r.method === 'thread/turns/list'));
    assert.equal(s.feed.observe(refs.thread(s.threadId), 'Thread'), undefined);
    assert.deepEqual(s.events, []);
    s.stored.set(s.threadId, []); await s.feed.observe(s.ref(a), 'Comment');
    assert.equal(s.graph.resolve(s.ref(a)).gone, true);
  } finally { await s.close(); }
});

test('sent user-message blocks sync first, then new comments emit sent once and link to resident files', async () => {
  const s = await setup();
  try {
    await s.change();
    const one = comment('First', { localWorkspaceRoot: '/repo', localDiffHunk: '@@ -1 +1 @@\n-a\n+b', position: { path: 'src/a.js', side: 'right', start_line: 2, line: 4 } });
    await s.message(messageText(one));
    const first = refs.comment(s.threadId, `sent-${s.threadId}:message-1`);
    assert.deepEqual(s.state(first), { content: content('First'), author: 'you', state: 'sent', anchor: { path: 'src/a.js', line: 2, endLine: 4 } });
    assert.deepEqual(s.events, []);
    const two = comment('Second', { position: { path: 'src/a.js', side: 'left', start_side: 'right', start_line: 3, line: 6 } });
    await s.message(messageText(one, two), 'next');
    const next = refs.comment(s.threadId, `sent-${s.threadId}:next-1`), last = refs.comment(s.threadId, `sent-${s.threadId}:next-2`);
    assert.deepEqual(s.events, [[next, 'sent'], [last, 'sent']]);
    assert.deepEqual(s.state(last).anchor, { path: 'src/a.js', line: 3, endLine: 6 });
    assert.deepEqual(s.graph.resolve(last).links.fileChange, refs.fileChange(`thread:${s.threadId}`, '/repo/src/a.js'));
    const puts = s.puts.length;
    await s.message(messageText(one, two), 'next');
    assert.equal(s.puts.length, puts); assert.equal(s.events.length, 2);
  } finally { await s.close(); }
});

test('history reads and resumed history learn sent blocks after core puts, including unseen turns from turns/list', async () => {
  for (const method of ['thread/read', 'thread/resume', 'thread/turns/list']) {
    const s = await setup();
    try {
      const c = comment('Historical'), t = turn('history', [userMessage('past', messageText(c))]);
      s.history.set(s.threadId, [t]);
      if (method === 'thread/turns/list') await s.source.loadThread(s.threadId);
      else await s.ask(method, { threadId: s.threadId, includeTurns: true });
      const ref = refs.comment(s.threadId, `sent-${s.threadId}:past-1`);
      await until(() => s.state(ref), 3000, method);
      assert.equal(s.state(ref).state, 'sent'); assert.deepEqual(s.events, []);
      await s.ask(method, { threadId: s.threadId, includeTurns: true, itemsView: 'full' });
      assert.deepEqual(s.events, []);
      assert.deepEqual(s.warnings, []);
    } finally { await s.close(); }
  }
});

test('response learning waits a microtask for turns/list core history puts', async () => {
  const s = await setup();
  try {
    const t = turn('after-response', [userMessage('after-input', messageText(comment()))]);
    s.feed.responded('thread/turns/list', { data: [t] });
    for (const d of [turnData(s.threadId, t), ...t.items.flatMap((i) => itemData(s.threadId, t.id, i))]) s.context.handle.put(d.ref, { state: d.state, links: d.links });
    await Promise.resolve();
    assert.equal(s.state(refs.comment(s.threadId, `sent-${s.threadId}:after-input-1`)).state, 'sent');
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('Hunk.comment uses the after range and cwd, appends at the draft count, and preserves paths outside the cwd', async () => {
  const s = await setup();
  try {
    const hunk = await s.change(), first = comment('Existing'); s.report([first]);
    const ref = done(await s.invoke(hunk, 'comment', [content(' A new note ')], mod));
    const c = comment('A new note', { localWorkspaceRoot: '/repo', position: { side: 'right', path: 'src/a.js', line: 4, start_line: 2 } });
    assert.deepEqual(ref, s.ref(c));
    assert.deepEqual(s.ops.filter(([a]) => a === 'comments'), [['comments', 'edit', { threadId: s.threadId, removed: [], added: [{ comment: c, index: 1 }] }]]);
    assert.equal(s.state(ref).state, 'draft'); assert.deepEqual(s.prompts, []);
    const outside = await s.change('/repository/a.js', '@@ -5 +5,0 @@\n-removed\n');
    const out = done(await s.invoke(outside, 'comment', [content('Deletion')]));
    assert.deepEqual(s.state(out).anchor, { path: '/repository/a.js', line: 5 });
    assert.deepEqual(s.ops.at(-1)[2].added[0].comment.position, { side: 'right', path: '/repository/a.js', line: 5 });
  } finally { await s.close(); }
});

test('Finding.comment links its review thread, remembers the finding through edits, and draft edits and deletions send exact removals and positions', async () => {
  const s = await setup();
  try {
    await s.change(); const f = await s.finding();
    s.report([comment('Existing')]);
    const ref = done(await s.invoke(f, 'comment', [content('Please explain')], mod));
    const c = comment('Please explain', { localWorkspaceRoot: '/repo' });
    assert.deepEqual(s.ops.filter(([a]) => a === 'comments').at(-1), ['comments', 'edit', { threadId: s.threadId, removed: [], added: [{ comment: c, index: 1 }] }]);
    assert.deepEqual(s.graph.resolve(ref).links.finding, f);
    assert.deepEqual(s.graph.related(f, 'comments').map((i) => i.ref), [ref]);
    done(await s.invoke(ref, 'edit', [content('More detail')], mod));
    const edited = { ...c, content: [{ content_type: 'text', text: 'More detail' }] }, newRef = s.ref(edited);
    assert.deepEqual(s.ops.at(-1), ['comments', 'edit', { threadId: s.threadId, removed: [c], added: [{ comment: edited, index: 1 }] }]);
    assert.equal(s.graph.resolve(ref).gone, true); assert.deepEqual(s.graph.resolve(newRef).links.finding, f);
    done(await s.invoke(newRef, 'delete', [], mod));
    assert.deepEqual(s.ops.at(-1), ['comments', 'edit', { threadId: s.threadId, removed: [edited], added: [] }]);
    assert.equal(s.graph.resolve(newRef).gone, true); assert.equal(s.graph.related(f, 'comments').length, 0);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('send uses the exact composer block with its intent, removes only that draft, and emits sent on the learned message; R17 asks only a mod', async () => {
  const s = await setup({ learnSend: true });
  try {
    const a = comment('Send me', { localWorkspaceRoot: '/repo', localDiffHunk: '@@ -1 +1 @@\n-old\n+new' }), b = comment('Keep me'); s.report([a, b]);
    const ref = s.ref(a); s.approve(false);
    assert.equal((await s.invoke(ref, 'send', [], mod)).status, 'refused');
    assert.deepEqual(s.requests, []); assert.equal(s.stored.get(s.threadId).length, 2);
    s.approve(true); s.prompts.length = 0;
    const result = await s.invoke(ref, 'send', [], mod); done(result);
    const text = '\n# Diff comments:\n\n## User Comment 1\nFile: src/a.js\nWorkspace: /repo\nSide: R\nLines: 4\nDiff hunk:\n```diff\n@@ -1 +1 @@\n-old\n+new\n```\nComment:\nSend me\n\n## My request:\n\n';
    assert.deepEqual(s.requests, [{ method: 'turn/start', params: { threadId: s.threadId, input: [{ type: 'text', text, text_elements: [] }] }, intent: result.intent }]);
    assert.deepEqual(s.prompts, [{ action: 'send a comment to Codex in “Chat”', detail: 'Codex reads it as your message: it may change files and counts toward your usage.' }]);
    assert.deepEqual(s.ops.at(-1), ['comments', 'edit', { threadId: s.threadId, removed: [a], added: [] }]);
    assert.deepEqual(s.stored.get(s.threadId), [b]); assert.equal(s.graph.resolve(ref).gone, true);
    await until(() => s.events.length === 1, 3000, 'the sent comment');
    assert.equal(s.events[0][1], 'sent');
    assert.match(s.events[0][0].id, /:sent-.*:turn-\d+-user-1$/);
    assert.equal(s.state(s.events[0][0]).state, 'sent');
    done(await s.invoke(s.ref(b), 'send', [], user));
    await until(() => s.events.length === 2, 3000, 'the second sent comment');
    assert.equal(s.prompts.length, 1); assert.equal(s.events.length, 2);
    assert.deepEqual(s.stored.get(s.threadId), []);
  } finally { await s.close(); }
});

test('send falls back to its draft ref after ten seconds, and late learning does not emit sent again', async (t) => {
  const s = await setup();
  try {
    const c = comment(); s.report([c]);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(await s.feed.send(s.ref(c), 'intent'), null);
    t.mock.timers.tick(9999); assert.deepEqual(s.events, []);
    t.mock.timers.tick(1); assert.deepEqual(s.events, [[s.ref(c), 'sent']]);
    t.mock.timers.reset();
    await s.message(s.requests[0].params.input[0].text, 'late', 'turn-1');
    assert.equal(s.events.length, 1);
    assert.equal(s.state(refs.comment(s.threadId, `sent-${s.threadId}:late-1`)).state, 'sent');
  } finally { t.mock.timers.reset(); await s.close(); }
});

test('blank content, sent mutations, resolve, missing location and missing parents refuse without operations or prompts', async () => {
  const s = await setup();
  try {
    const h = await s.change(), f = await s.finding(), a = comment(), sent = comment('Review', { reviewThreadId: 'pr-thread' });
    s.report([a, sent]);
    for (const at of [h, f]) {
      refused(await s.invoke(at, 'comment', [content(' \n ')], mod), 'invalid');
      refused(await s.invoke(at, 'comment', [{ parts: [{ kind: 'image', source: '/tmp/image' }] }], mod), 'invalid');
    }
    refused(await s.invoke(s.ref(a), 'edit', [content('')], mod), 'invalid');
    for (const op of ['edit', 'delete', 'send']) refused(await s.invoke(s.ref(sent), op, op === 'edit' ? [content('Change')] : [], mod), 'unsupported', 'a sent comment cannot be changed');
    refused(await s.invoke(s.ref(a), 'resolve', [], mod), 'unsupported', "a draft is deleted, not resolved; a pull request's review threads are resolved on GitHub");
    const finding = s.graph.resolve(f), { location: _location, ...state } = finding.state;
    s.context.handle.put(f, { state, links: finding.links });
    refused(await s.invoke(f, 'comment', [content('No location')], mod), 'unavailable');
    const orphan = refs.hunk('missing', 0);
    s.context.handle.put(orphan, { state: { before: { start: 1, lines: 1 }, after: { start: 1, lines: 1 }, state: 'applied' }, links: { fileChange: refs.fileChange('turn:missing', '/repo/a') } });
    refused(await s.invoke(orphan, 'comment', [content('No thread')], mod), 'unavailable');
    s.report([a], 'missing-thread');
    refused(await s.invoke(refs.comment('missing-thread', comments.keyOf(a)), 'send', [], mod), 'unavailable');
    s.h.bus.publish('appServer/exited', { backend: 'primary', code: 1 });
    refused(await s.invoke(s.ref(a), 'send', [], mod), 'unavailable');
    assert.deepEqual(s.prompts, []); assert.deepEqual(s.requests, []);
    assert.deepEqual(s.ops.filter(([area]) => area === 'comments'), []);
  } finally { await s.close(); }
});

test('main refusals become unavailable, failures throw, and failed sends retain the original draft without replaying mutations', async () => {
  const s = await setup();
  try {
    const h = await s.change(), a = comment(); s.report([a]);
    s.answers.set('edit', { ok: false, refused: true, error: 'the app has no window' });
    refused(await s.invoke(h, 'comment', [content('No service')], mod), 'unavailable', 'the app has no window');
    refused(await s.invoke(s.ref(a), 'edit', [content('No edit')]), 'unavailable', 'the app has no window');
    refused(await s.invoke(s.ref(a), 'delete'), 'unavailable', 'the app has no window');
    assert.ok(!s.graph.resolve(s.ref(a)).gone);
    s.answers.set('edit', { ok: false, refused: false, error: 'app failed' });
    await assert.rejects(s.feed.comment(h, content('Failure')), /app failed/);
    await assert.rejects(s.feed.edit(s.ref(a), content('Failure')), /app failed/);
    await assert.rejects(s.feed.delete(s.ref(a)), /app failed/);
    s.failRequest(new Error('quota exceeded'));
    await assert.rejects(s.feed.send(s.ref(a), 'intent'), /quota exceeded/);
    assert.equal(s.requests.length, 1); assert.ok(!s.graph.resolve(s.ref(a)).gone);
    s.answers.set('read', { ok: false, refused: false, error: 'read failed' });
    await assert.rejects(s.feed.observe(s.ref(a), 'Comment'), /read failed/);
    s.answers.set('edit', { ok: false, refused: true, error: 'the window closed' });
    await assert.rejects(s.feed.send(s.ref(a), 'intent'), /sent but its draft could not be removed: the window closed/);
    assert.equal(s.requests.length, 2); assert.ok(!s.graph.resolve(s.ref(a)).gone);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
  const headless = await setup({ main: false });
  try {
    const h = await headless.change();
    const result = await headless.invoke(h, 'comment', [content('Headless')]);
    refused(result, 'unavailable'); assert.match(result.message, /framework-main/);
  } finally { await headless.close(); }
});

test('thread deletion removes comments and disposal detaches reports and timers', async (t) => {
  const s = await setup();
  try {
    const a = comment(); s.report([a]);
    await s.startTurn(); await s.message(messageText(a));
    const sent = refs.comment(s.threadId, `sent-${s.threadId}:message-1`);
    await s.notify('thread/deleted', { threadId: s.threadId });
    assert.equal(s.graph.resolve(s.ref(a)).gone, true); assert.equal(s.graph.resolve(sent).gone, true);
    await s.source.dispose();
    const puts = s.puts.length; s.report([a]);
    assert.equal(s.puts.length, puts);
    assert.equal(await s.feed.observe(s.ref(a), 'Comment'), undefined);
    t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.timers.tick(10_000);
    assert.equal(s.puts.length, puts);
  } finally { t.mock.timers.reset(); await s.close(); }
});
