// Reviews through the real source, graph, mux and fake app-server. Main's review operations are answered on the real area channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userContent, turnData, itemData } from '../map.mjs';
import * as reviewArea from '../areas/review.mjs';
import { parseFindings, commentKey, severityOf, reviewTarget } from '../areas/review.mjs';
import { produced } from './areas/review.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.review' }, user = { kind: 'user', id: 'user' };
const content = (text) => userContent([{ type: 'text', text }]);
const prompt = (target = 'Review the current code changes (staged, unstaged and untracked).') => `## Code review guidelines:\nRead the patch.\n${target}`;
const directive = (title = 'Keep the guard', extra = '') => `::code-comment{title="${title}" body="An unchecked value reaches the caller." file="src/a.js" ${extra}}`;

async function setup({ projects = null, main = true, start = true } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-review-'));
  const prompts = [], events = [], requests = [], ops = [], puts = [], warnings = [];
  const dismissed = new Set(), answers = new Map();
  let sequence = 1000, feed, context, approved = true;
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const control = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const appProjects = projects ? createAppProjects({ log }) : null;
  appProjects?.apply({ type: 'projects', available: true, reset: true, projects });
  let mainOps = null;
  if (main) mainOps = createMainOps({ log, send(m) {
    assert.equal(m.area, 'review');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          const result = typeof answer === 'function' ? await answer(m.args) : answer;
          mainOps.settle({ requestId: m.requestId, ...result });
          return;
        }
        let result = {};
        if (m.op === 'dismissed') result = { dismissed: m.args.keys.filter((key) => dismissed.has(key)) };
        else if (m.op === 'dismiss') dismissed.add(m.args.key);
        else assert.equal(m.op, 'open');
        mainOps.settle({ requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ requestId: m.requestId, ok: false, error: e.message, refused: false }); }
    });
  } });
  const area = { ...reviewArea, createFeed(ctx) {
    context = ctx;
    feed = reviewArea.createFeed({ ...ctx,
      handle: { ...ctx.handle, put(ref, data) { puts.push([ref, data]); return ctx.handle.put(ref, data); } },
      request(method, params, intent) { requests.push({ method, params, intent }); return ctx.request(method, params, intent); },
    });
    return feed;
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, appProjects, mainOps, areas: { review: area } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Review') events.push({ id: e.ref.id, name: e.name, present: !!graph.resolve(e.ref) && !graph.resolve(e.ref).gone }); });
  if (start) await source.start();
  const notify = (method, params) => control('fake/notify', { method, params });
  async function turn({ text = prompt(), cwd = '/r', threadId, load = true } = {}) {
    if (!threadId) threadId = (await control('thread/start', { cwd })).thread.id;
    await control('fake/hold', { threadId });
    const turnId = (await control('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })).turn.id;
    await until(() => graph.resolve(refs.turn(turnId)), 3000, 'the turn');
    if (load) await source.loadThread(threadId);
    return { threadId, turnId, ref: refs.review(turnId) };
  }
  async function message(t, { text = '', id = 'answer', phase = 'final_answer', done = true, at = 2000 } = {}) {
    await notify(done ? 'item/completed' : 'item/started', { threadId: t.threadId, turnId: t.turnId, startedAtMs: at, item: { type: 'agentMessage', id, text, phase } });
    await until(() => graph.resolve(refs.item('AgentMessage', t.threadId, id))?.state.streaming === !done, 3000, 'the message');
  }
  return {
    h, graph, source, feed, context, ops, requests, prompts, events, puts, warnings, answers, dismissed, control, notify, turn, message,
    approve(value) { approved = value; },
    review: (t) => graph.resolve(t.ref), finding: (t, i = 0) => graph.resolve(refs.finding(t.turnId, i)),
    invoke: (ref, operation, caller = mod) => graph.invoke({ ref, operation, args: [], caller }),
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); appProjects?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('parseFindings follows the directive grammar, trims required fields, unescapes only quotes and decodes entities', () => {
  const text = String.raw` :code-comment{title="  A \"quoted\" title  " body=' It\'s &lt;x&gt; &amp; &quot;y&quot; &#39;z&#x27; &#x1f642; \n ' file=src/a.js priority=1 start=4 end=7 ignored=value}
\t::code-comment{title='[P2] Already titled' body="Keep \'single\' and \"double\" quotes" file="/r/src/../b.js" priority=0 start=9 end=2}
  :::code-comment{title="<sub> [p3] Wrapped</sub>" body=Details file=/outside/../other.js priority=3 start=-4 end=0}
::code-comment{title=Missing file=a}
::code-comment{title=Blank body="  " file=a}
::code-comment{title=Bad body=x file=" "}
::::code-comment{title=TooMany body=x file=a}
prefix ::code-comment{title=Embedded body=x file=a}
::code-comment{title="Multiline
title" body=x file=a}`.replace('\\t::', '\t::');
  const findings = parseFindings(text, '/r');
  assert.deepEqual(findings, [
    { title: 'A "quoted" title', shown: '[P1] A "quoted" title', body: 'It\'s <x> & "y" \'z\' 🙂 \\n', priority: 1, path: 'src/a.js', startLine: 4, line: 7, root: '/r' },
    { title: '[P2] Already titled', shown: '[P2] Already titled', body: 'Keep \'single\' and "double" quotes', priority: 0, path: 'b.js', startLine: 9, line: 9, root: '/r' },
    { title: '<sub> [p3] Wrapped</sub>', shown: '<sub> [p3] Wrapped</sub>', body: 'Details', priority: 3, path: '/other.js', startLine: 1, line: 1, root: '/r' },
  ]);
  assert.deepEqual(parseFindings('::code-comment{title=One body=Two file=./src/../a priority=no start=2.5 end=6}\r\n::code-comment{title=Three body=Four file=../out priority=2 start=5}', '/r'), [
    { title: 'One', shown: 'One', body: 'Two', priority: undefined, path: './src/../a', startLine: 1, line: 6, root: '/r' },
    { title: 'Three', shown: '[P2] Three', body: 'Four', priority: 2, path: '../out', startLine: 5, line: 5, root: '/r' },
  ]);
  assert.equal(parseFindings('::code-comment{title=T body=B file=/root/repo-other/a}', '/root/repo')[0].path, '/root/repo-other/a');
  assert.equal(parseFindings('::code-comment{title=T body=B file=/a/../b}')[0].path, '/b');
  assert.equal(parseFindings('::code-comment{title="Braces } in title" body="object { key: value }" file=a} trailing }')[0].body, 'object { key: value }');
});

test('comment keys, severities, review targets and declaration samples have the settled shapes', () => {
  const f = parseFindings(directive('Guard', 'priority=1 start=2 end=4'), '/r')[0];
  assert.equal(commentKey(f), '/r|src/a.js|right|2-4|[P1] Guard\n\nAn unchecked value reaches the caller.', 'with the workspace root (the app\'s key)');
  assert.equal(commentKey({ ...f, startLine: 4 }), '/r|src/a.js|right|4|[P1] Guard\n\nAn unchecked value reaches the caller.');
  assert.equal(commentKey({ ...f, root: null }), 'src/a.js|right|2-4|[P1] Guard\n\nAn unchecked value reaches the caller.', 'none without one');
  assert.deepEqual([undefined, null, -1, 0, 1, 2, 3, 9].map(severityOf), ['medium', 'medium', 'medium', 'high', 'high', 'medium', 'low', 'low']);
  assert.deepEqual(reviewTarget(prompt()), { kind: 'uncommitted' });
  assert.deepEqual(reviewTarget(prompt("Review the code changes against the base branch 'feature/topic'.")), { kind: 'branch', name: 'feature/topic' });
  assert.equal(reviewTarget('Please review this commit'), null);
  assert.deepEqual(produced().slice(0, 4).map((x) => x.state.target), [refs.changeSet('thread', 't'), refs.branch('p', 'main'), 'main', null]);
});

test('a review syncs first, then starts, learns streamed findings in message and line order, and completes with an overview', async () => {
  const s = await setup();
  try {
    const t = await s.turn();
    await until(() => s.review(t), 3000, 'review learned after the history put');
    assert.deepEqual(s.review(t).state, { status: 'running', target: refs.changeSet('thread', t.threadId), reviewer: refs.agent() });
    assert.deepEqual(s.review(t).links, { thread: refs.thread(t.threadId), turn: refs.turn(t.turnId) });
    assert.deepEqual(s.events, [], 'the first learning is a sync');
    await s.message(t, { id: 'commentary', phase: 'commentary', text: directive('Not a finding'), at: 1000 });
    await until(() => s.events.length === 1, 3000, 'started');
    assert.equal(s.events[0].name, 'started');
    assert.equal(s.graph.list('Finding').length, 0, 'commentary directives are not findings');
    await s.message(t, { id: 'update', phase: null, text: directive('First update', 'priority=0 start=2 end=3'), at: 1100 });
    await s.message(t, { done: false, text: '', at: 1200 });
    const answer = [
      'The patch needs these fixes.',
      ':code-comment{title="Second" body="Second detail" file="/r/src/b.js" priority=1 start=4}',
      '\t::code-comment{title="Third" body="Third detail" file="src/c.js" priority=2 start=6 end=8}',
      '  :::code-comment{title="[P3] Fourth" body="Fourth detail" file="../outside.js" priority=3}',
      '::code-comment{title="Not a finding" file=a}',
      'The rest looks sound.',
    ].join('\n');
    for (const delta of [answer.slice(0, 30), answer.slice(30)]) await s.notify('item/agentMessage/delta', { threadId: t.threadId, turnId: t.turnId, itemId: 'answer', delta });
    await until(() => s.graph.resolve(refs.item('AgentMessage', t.threadId, 'answer'))?.state.content.parts[0].text === answer, 3000, 'the streamed answer');
    await s.message(t, { text: answer, at: 1200 });
    await until(() => s.graph.related(t.ref, 'findings').length === 4, 3000, 'four findings');
    assert.deepEqual(s.graph.related(t.ref, 'findings').map((x) => [x.ref, x.state.title, x.state.severity, x.links.review]), [
      [refs.finding(t.turnId, 0), '[P0] First update', 'high', t.ref],
      [refs.finding(t.turnId, 1), '[P1] Second', 'high', t.ref],
      [refs.finding(t.turnId, 2), '[P2] Third', 'medium', t.ref],
      [refs.finding(t.turnId, 3), '[P3] Fourth', 'low', t.ref],
    ]);
    assert.deepEqual(s.finding(t, 2).state, { title: '[P2] Third', detail: content('Third detail'), severity: 'medium', state: 'open', location: { path: 'src/c.js', line: 8 } });
    assert.deepEqual(s.review(t).state.overview, content('The patch needs these fixes.\nThe rest looks sound.'));
    await s.control('fake/finishTurn', { threadId: t.threadId });
    await until(() => s.review(t).state.status === 'done', 3000, 'review done');
    assert.deepEqual(s.review(t).state.overview, content('The patch needs these fixes.\nThe rest looks sound.'));
    assert.deepEqual(s.events.map((e) => e.name), ['started', 'findingAdded', 'findingAdded', 'findingAdded', 'findingAdded', 'done']);
    assert.ok(s.events.every((e) => e.present));
    const writes = s.puts.length;
    await s.message(t, { text: answer, at: 1200 });
    await sleep(30);
    assert.equal(s.puts.length, writes, 'unchanged reviews and findings are not put again');
    await s.message(t, { text: 'Now clear.', at: 1200 });
    await until(() => s.graph.related(t.ref, 'findings').length === 1, 3000, 'findings absent from the text are removed');
    assert.equal(s.finding(t, 1).gone, true);
    assert.deepEqual(s.review(t).state.overview, content('Now clear.'));
    assert.deepEqual(s.warnings, []);
  } finally { await s.close(); }
});

test('targets are the thread changes or project branch, falling back to the branch name or null; other turns are ignored', async () => {
  const s = await setup({ projects: [{ id: 'p', name: 'Repo', roots: ['/r'] }] });
  try {
    const t = await s.turn({ text: prompt("Review the code changes against the base branch 'main'.") });
    await until(() => s.review(t), 3000, 'branch review');
    assert.deepEqual(s.review(t).state.target, refs.branch('p', 'main'));
    await s.message(t, { text: directive() });
    await until(() => s.finding(t), 3000, 'branch finding');
    assert.equal((await s.invoke(refs.finding(t.turnId, 0), 'open')).status, 'done');
    assert.deepEqual(s.ops.find(([op]) => op === 'open'), ['open', { threadId: t.threadId, path: '/r/src/a.js', view: 'branch' }]);
    const outside = await s.turn({ cwd: '/elsewhere', text: prompt("Review against the base branch 'release'.") });
    await until(() => s.review(outside), 3000, 'unassociated branch review');
    assert.equal(s.review(outside).state.target, 'release');
    const unknown = await s.turn({ text: prompt('Review a different target.') });
    await until(() => s.review(unknown), 3000, 'review with no known target');
    assert.equal(s.review(unknown).state.target, null);
    const ordinary = await s.turn({ text: 'Please review this change.' });
    await s.message(ordinary, { text: directive('Ordinary answer') });
    await sleep(30);
    assert.equal(s.review(ordinary), null);
    assert.equal(s.finding(ordinary), null);
    // A later steering message cannot turn an ordinary turn into a review.
    const later = s.graph.related(refs.turn(ordinary.turnId), 'input')[0].state.createdAt + 1;
    await s.notify('item/completed', { threadId: ordinary.threadId, turnId: ordinary.turnId, startedAtMs: later, item: { type: 'userMessage', id: 'steer', content: [{ type: 'text', text: prompt() }] } });
    await sleep(30);
    assert.equal(s.review(ordinary), null);
  } finally { await s.close(); }
});

test('main dismissal state is read once per debounce; open and dismiss have app arguments, R17 prompts only for a mod, and repeat dismissal does nothing', async () => {
  const s = await setup();
  try {
    const t = await s.turn();
    const lines = [directive('Already hidden', 'priority=1'), directive('Mod finding', 'priority=2'), directive('User finding', 'priority=3')].join('\n');
    const keys = parseFindings(lines, '/r').map(commentKey);
    s.dismissed.add(keys[0]);
    await s.message(t, { text: lines });
    await s.message(t, { text: lines });
    await until(() => s.finding(t)?.state.state === 'dismissed', 3000, 'dismissal state from the app');
    assert.deepEqual(s.ops.filter(([op]) => op === 'dismissed'), [['dismissed', { threadId: t.threadId, keys }]]);
    const f = refs.finding(t.turnId, 1);
    assert.equal((await s.invoke(f, 'open')).status, 'done');
    assert.deepEqual(s.ops.find(([op]) => op === 'open'), ['open', { threadId: t.threadId, path: '/r/src/a.js', view: 'unstaged' }]);
    assert.deepEqual(s.prompts, [], 'open asks nothing');
    assert.equal((await s.invoke(refs.finding(t.turnId, 0), 'dismiss')).status, 'done');
    assert.equal((await s.invoke(f, 'dismiss')).status, 'done');
    assert.deepEqual(s.prompts, [{ action: 'dismiss the finding “[P2] Mod finding”', detail: 'The app stops showing it in the diff of this chat.' }]);
    assert.equal(s.finding(t, 1).state.state, 'dismissed');
    assert.deepEqual(s.ops.filter(([op]) => op === 'dismiss'), [['dismiss', { threadId: t.threadId, key: keys[1] }]]);
    assert.equal((await s.invoke(f, 'dismiss')).status, 'done');
    assert.equal(s.prompts.length, 1);
    await until(() => s.ops.filter(([op]) => op === 'dismissed').length === 2, 3000, 'a fresh dismissal read after dismiss');
    assert.equal((await s.invoke(refs.finding(t.turnId, 2), 'dismiss', user)).status, 'done');
    assert.equal(s.prompts.length, 1, 'a user call asks nothing');
    assert.equal(s.finding(t, 2).state.state, 'dismissed');
    await until(() => s.ops.filter(([op]) => op === 'dismissed').length === 3, 3000, 'each dismiss reads the app state again');
    assert.deepEqual(s.ops.filter(([op]) => op === 'dismiss').at(-1), ['dismiss', { threadId: t.threadId, key: keys[2] }]);
    assert.deepEqual(s.ops.filter(([op]) => op === 'dismissed').at(-1), ['dismissed', { threadId: t.threadId, keys }]);
  } finally { await s.close(); }
});

test('stop interrupts the running review with its intent, then refuses; failed and stopped turns are failed reviews', async () => {
  const s = await setup();
  try {
    const t = await s.turn();
    await until(() => s.review(t), 3000, 'running review');
    const result = await s.invoke(t.ref, 'stop');
    assert.equal(result.status, 'done');
    assert.deepEqual(s.requests, [{ method: 'turn/interrupt', params: { threadId: t.threadId, turnId: t.turnId }, intent: result.intent }]);
    await until(() => s.review(t).state.status === 'failed', 3000, 'stopped review');
    const no = await s.invoke(t.ref, 'stop');
    assert.equal(no.status, 'refused');
    assert.equal(no.reason, 'unavailable');
    assert.equal(s.requests.length, 1);
    assert.deepEqual(s.prompts, [], 'stop asks nothing');
    const failed = await s.turn();
    await until(() => s.review(failed), 3000, 'second review');
    await s.notify('turn/completed', { threadId: failed.threadId, turn: { id: failed.turnId, status: 'failed', items: [], startedAt: 1, completedAt: 2, error: { message: 'review failed' } } });
    await until(() => s.review(failed).state.status === 'failed', 3000, 'failed review');
    assert.equal((await s.invoke(failed.ref, 'stop', user)).status, 'refused');
    assert.deepEqual(s.events.filter((e) => e.name === 'done').map((e) => e.id), [t.turnId, failed.turnId]);
  } finally { await s.close(); }
});

test('framework-main refusals remain unavailable, failures throw, and rejected approval leaves the finding alone', async () => {
  const s = await setup();
  try {
    const t = await s.turn();
    await s.message(t, { text: directive() });
    await until(() => s.finding(t), 3000, 'finding');
    const f = refs.finding(t.turnId, 0);
    s.approve(false);
    assert.equal((await s.invoke(f, 'dismiss')).status, 'refused');
    assert.equal(s.ops.some(([op]) => op === 'dismiss'), false);
    s.approve(true);
    for (const op of ['open', 'dismiss']) {
      s.answers.set(op, { ok: false, refused: true, error: 'the app has no window' });
      const result = await s.invoke(f, op, user);
      assert.equal(result.status, 'refused');
      assert.equal(result.reason, 'unavailable');
      assert.equal(result.message, 'the app has no window');
      s.answers.set(op, { ok: false, refused: false, error: 'app operation failed' });
      await assert.rejects(s.feed[op](f), /app operation failed/);
      assert.equal(s.finding(t).state.state, 'open');
    }
  } finally { await s.close(); }
  const headless = await setup({ main: false });
  try {
    const t = await headless.turn();
    await headless.message(t, { text: directive() });
    await until(() => headless.finding(t), 3000, 'headless finding');
    const result = await headless.invoke(refs.finding(t.turnId, 0), 'open', user);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'unavailable');
    assert.match(result.message, /framework-main/);
  } finally { await headless.close(); }
});

test('observe loads an unseen review or finding from the turn thread, and thread removal takes reviews and findings', async () => {
  const s = await setup();
  try {
    const t = await s.turn({ load: false });
    assert.equal(s.review(t), null, 'the user input is not resident yet');
    const view = s.graph.subscribe({ ref: refs.finding(t.turnId, 0) }, () => {});
    await view.loaded;
    await until(() => s.review(t), 3000, 'observing the finding loaded its review turn');
    view.dispose();
    assert.equal(s.feed.observe(refs.thread(t.threadId), 'Thread'), undefined);
    await s.message(t, { text: directive() });
    await until(() => s.finding(t), 3000, 'finding');
    const reviewView = s.graph.subscribe({ ref: t.ref }, () => {});
    await reviewView.loaded;
    reviewView.dispose();
    await s.notify('thread/deleted', { threadId: t.threadId });
    await until(() => s.review(t)?.gone && s.finding(t)?.gone, 3000, 'thread parts removed');
    const reads = s.ops.length;
    await sleep(250);
    assert.equal(s.ops.length, reads, 'removed reviews have no pending dismissal reads');
  } finally { await s.close(); }
});

test('history present before the source starts is learned without events, including a detached review', async () => {
  const s = await setup({ start: false });
  try {
    const t = await s.turn({ load: false });
    await s.control('fake/finishTurn', { threadId: t.threadId });
    await until(() => s.graph.resolve(refs.turn(t.turnId)).state.status === 'completed', 3000, 'history complete');
    const raw = (await s.control('thread/read', { threadId: t.threadId })).thread;
    await s.notify('thread/started', { thread: { ...raw, threadSource: 'code_review' } });
    await s.source.loadThread(t.threadId);
    await until(() => s.review(t), 3000, 'review from recorded user input');
    assert.equal(s.review(t).state.status, 'done');
    assert.deepEqual(s.events, [], 'completed history is a sync');
  } finally { await s.close(); }
});

test('history response hooks run after the core puts, exclude commentary on previously unseen turns, and preserve tied message order', async () => {
  const s = await setup();
  try {
    const threadId = (await s.control('thread/start', { cwd: '/r' })).thread.id;
    await until(() => s.graph.resolve(refs.thread(threadId)), 3000, 'the history thread');
    for (const [i, method] of ['thread/turns/list', 'thread/read', 'thread/resume'].entries()) {
      const turnId = `history-${i}`;
      const turn = { id: turnId, status: 'completed', startedAt: 1, completedAt: 2, items: [
        { type: 'userMessage', id: `${turnId}-input`, content: [{ type: 'text', text: prompt() }] },
        { type: 'agentMessage', id: `${turnId}-commentary`, phase: 'commentary', text: directive('Hidden commentary') },
        { type: 'agentMessage', id: `${turnId}-update`, phase: null, text: directive('First') },
        { type: 'agentMessage', id: `${turnId}-answer`, phase: 'final_answer', text: directive('Second') },
      ] };
      // The response observer runs before the core's loadThread continuation. Supply those core puts in this same turn of the loop.
      s.feed.responded(method, method === 'thread/turns/list' ? { data: [turn] } : { thread: { id: threadId, turns: [turn] } });
      const data = [turnData(threadId, turn), ...turn.items.flatMap((item) => itemData(threadId, turnId, item, { startedAt: 1000, done: true }))];
      for (const d of data) s.context.handle.put(d.ref, { state: d.state, links: d.links });
      s.context.handle.update(refs.turn(turnId), { links: { answer: refs.item('AgentMessage', threadId, `${turnId}-answer`) } });
      await Promise.resolve();
      assert.deepEqual(s.graph.related(refs.review(turnId), 'findings').map((x) => x.state.title), ['First', 'Second']);
      assert.deepEqual(s.events, [], 'each historical review is a sync');
      const t = { threadId, turnId, ref: refs.review(turnId) };
      await s.message(t, { id: `${turnId}-update`, phase: null, text: directive('First'), at: 1000 });
      await sleep(30);
      assert.deepEqual(s.graph.related(t.ref, 'findings').map((x) => x.state.title), ['First', 'Second']);
    }
  } finally { await s.close(); }
});
