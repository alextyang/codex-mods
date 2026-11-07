// Pull requests through the graph, native source, real mux and fake app-server. AppHost replies are recorded here; the mux maps the
// attachment write to the fake's existing attachment helper. Notifications still traverse the backend and source normally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createAppState } from '../../../app-state.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as pullRequests from '../areas/pull-requests.mjs';
import { changeSetData } from '../areas/changes.mjs';
import { produced } from './areas/pull-requests.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user' }, mod = { kind: 'mod', id: 'mod.a' };
const projectId = 'p:one', cwd = '/repo/subfolder', root = '/repo', repository = refs.repository(projectId);
const url = (number) => `https://GitHub.COM./Owner/Repo/pull/${number}`;
const ref = (number) => ({ type: 'GitHubPullRequest', provider: 'codex', id: url(number) });
const row = (number, state, headBranch, ciStatus = 'passing', extra = {}) => ({ title: `PR ${number}`, number, url: url(number), state, ciStatus,
  headBranch, baseBranch: 'main', canMerge: true, mergeBlocker: null, cwd: root, hostId: 'local', additions: 4, deletions: 2,
  createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', isAuthor: true, ...extra });
const initial = () => [row(1, 'draft', 'work', 'pending'), row(2, 'ready', 'other'), row(3, 'merged', 'old')];
const reviews = { status: 'success', reviewStatus: 'approved', reviewers: { approved: ['sam'], changesRequested: [], commented: ['alex', 'sam'], requested: ['pat'] } };
const success = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const no = (r, reason = 'unavailable') => { assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason); };

async function setup({ main = true, git = true, available = true, items = initial(), mergeMethod = 'merge' } = {}) {
  const h = await harness(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-pull-requests-'));
  const prompts = [], events = [], ops = [], calls = [], requests = [], notes = [], warnings = [], answers = new Map(), appAnswers = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  let clock = 100_000, feed, context, started, sequence = 9000, approved = true, rows = structuredClone(items), counter = 3;
  const repo = { git, root, origin: '/remote.git', branch: 'work', status: { staged: 0, unstaged: 1, untracked: 0 }, staged: [], branches: ['work', 'other', 'old', 'main', 'master', 'trunk'], defaultBranch: 'main', ahead: 2, upstream: null };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, now: () => clock,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const appState = createAppState();
  appState.apply({ available: true, reset: true, definitions: [], values: { 'git-pull-request-merge-method': { effective: mergeMethod } } });
  await h.up();
  const ask = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const fake = h.mux.client('test:pull-request-attachments');
  let attachmentError = null;
  fake.intercept('clientRequest', ['thread/attachment/add'], (m) => attachmentError
    ? { respond: { error: { code: -32000, message: attachmentError } } } : { replace: { ...m, method: 'fake/attach' } });
  let appProjects;
  appProjects = createAppProjects({ log, send: (m) => {
    calls.push([m.op, m.projectId]);
    queueMicrotask(() => appProjects.settle({ type: 'app-op-done', requestId: m.requestId,
      ...(appAnswers.get(m.op) ?? { ok: true, result: m.op === 'repository' ? structuredClone(m.projectId === projectId ? repo : { git: false })
        : m.op === 'apps' ? { targets: [], approvals: null } : {} }) }));
  } });
  appProjects.apply({ type: 'projects', available: true, reset: true, projects: [{ id: projectId, name: 'Repo', roots: [cwd] }, { id: 'no-git', name: 'Plain', roots: ['/plain'] }], threads: {}, selected: null });
  let mainOps;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'pull-requests');
    ops.push([m.op, m.args]); calls.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        if (answers.has(m.op)) {
          const a = answers.get(m.op), value = typeof a === 'function' ? await a(m.args) : a;
          mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...value });
          return;
        }
        let result;
        const item = rows.find((r) => r.url === m.args.url);
        if (m.op === 'status') result = { available };
        else if (m.op === 'board') result = { items: structuredClone(rows) };
        else if (m.op === 'details') result = { summary: { status: 'success', title: item.title, url: item.url,
          state: item.state === 'merged' || item.state === 'closed' ? item.state : 'open', isDraft: item.state === 'draft', ciStatus: item.ciStatus,
          headBranch: item.headBranch, baseBranch: item.baseBranch, headRevision: `head-${item.number}` }, reviews: structuredClone(reviews) };
        else if (m.op === 'open') result = {};
        else if (m.op === 'mark-ready') { item.state = 'ready'; item.ciStatus = 'passing'; result = {}; }
        else if (m.op === 'merge') { item.state = 'merged'; result = {}; }
        else if (m.op === 'create') {
          const made = row(++counter, 'ready', m.args.headBranch, 'passing', { title: m.args.title || 'Created' });
          rows.unshift(made); result = { url: made.url };
        } else throw new Error(`unexpected ${m.op}`);
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...pullRequests, createFeed(ctx) {
    context = ctx;
    feed = pullRequests.createFeed({ ...ctx, request(method, params, intent) {
      requests.push([method, params, intent]); calls.push([method, params]);
      return ctx.request(method, params, intent);
    } });
    return { ...feed, start() { started = feed.start(); return started; },
      notified(method, params) { feed.notified(method, params); notes.push([method, params]); } };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now: () => clock, appProjects, appState, mainOps, areas: { 'pull-requests': area } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'GitHubPullRequest') events.push([e.ref, e.name]); });
  await source.start(); await started;
  if (git) {
    await until(() => graph.resolve(repository), 3000, 'the repository');
    if (main && available && !ops.some(([op]) => op === 'board')) await feed.read(projectId);
  }
  const threadId = (await ask('thread/start', { cwd })).thread.id;
  await ask('thread/name/set', { threadId, name: 'Chat' });
  await until(() => graph.resolve(refs.thread(threadId))?.state.title === 'Chat', 3000, 'the thread');
  return {
    graph, source, feed, context, repo, h, appProjects, appState, mainOps, prompts, events, ops, calls, requests, warnings, answers, appAnswers, threadId,
    instance: (number) => graph.resolve(ref(number)),
    invoke: (r, operation, args = [], caller = user) => graph.invoke({ ref: r, operation, args, caller }),
    replace: (next) => { rows = structuredClone(next); },
    clock: (value) => { clock = value; }, approve: (value) => { approved = value; },
    attachmentError: (value) => { attachmentError = value; },
    async notify(params) {
      const count = notes.length;
      await ask('fake/notify', { method: 'thread/attachment/updated', params });
      await until(() => notes.slice(count).some(([m]) => m === 'thread/attachment/updated'), 3000, 'attachment notification');
    },
    putSet() {
      const data = changeSetData('thread', threadId, [{ threadId, turnId: 'u', cwd, change: { path: 'a', kind: { type: 'add' }, diff: 'new\n' } }]).changeSet;
      context.handle.put(data.ref, { state: data.state, links: data.links });
      return data.ref;
    },
    async close() { await source.dispose(); graph.close(); fake.dispose(); mainOps?.dispose(); appProjects.dispose(); appState.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const boardReads = (s) => s.ops.filter(([op]) => op === 'board');

test('parseUrl and identityKey normalize enterprise hosts, owners and repos, and reject non-PR URLs or non-positive integers', () => {
  assert.deepEqual(pullRequests.parseUrl(url(12)), { hostname: 'github.com', owner: 'owner', repository: 'repo', number: 12 });
  assert.deepEqual(pullRequests.parseUrl('https://Git.Example.COM../Org/Repo/pull/001/'), { hostname: 'git.example.com', owner: 'org', repository: 'repo', number: 1 });
  assert.equal(pullRequests.identityKey({ hostname: ' Git.Example.COM... ', owner: 'Org', repository: 'Repo', number: 4 }), '["git.example.com","org","repo",4]');
  for (const value of [undefined, null, {}, 1, '', 'garbage', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/-1', 'https://github.com/o/r/pull/1.5', 'https://github.com/o/r/pull/9007199254740992',
    'https://github.com/o/r/pull/1/more', 'https://user@github.com/o/r/pull/1', 'https://github.com:8443/o/r/pull/1', 'https://github.com/o/r/pull/1#review']) assert.equal(pullRequests.parseUrl(value), null, String(value));
});

test('pullRequestData and samples map all states, checks and reviews without duplicate reviewers, and include every link', () => {
  const [draft, open, merged, branch] = produced();
  assert.equal(draft.state.state, 'draft'); assert.equal(draft.state.checks, 'pending'); assert.equal(draft.links.thread, null);
  assert.equal(merged.state.state, 'merged');
  assert.equal(open.state.title, 'Open'); assert.equal(open.state.reviewState, 'approved');
  assert.deepEqual(open.state.reviewers, ['alex', 'sam']); assert.deepEqual(open.links.thread, refs.thread('t'));
  assert.deepEqual(branch.links, { repository: refs.repository('p'), pullRequest: draft.ref });
  for (const state of ['failing', 'ready', 'in_progress']) for (const ciStatus of ['passing', 'failing', 'pending', 'none']) {
    const d = pullRequests.pullRequestData(projectId, row(1, state, 'work', ciStatus));
    assert.deepEqual(d, { ref: ref(1), state: { title: 'PR 1', state: 'open', url: url(1), number: 1, checks: ciStatus },
      links: { repository, branch: refs.branch(projectId, 'work'), thread: null } });
  }
  for (const [reviewStatus, reviewState] of [['approved', 'approved'], ['changes_requested', 'changesRequested'], ['review_required', 'pending'], ['none', undefined], ['constructor', undefined]]) {
    const data = pullRequests.pullRequestData(projectId, row(1, 'ready', 'work'), {
      summary: { title: 'Detail', state: 'open', isDraft: true, ciStatus: 'failing', headBranch: 'renamed' }, reviews: { ...reviews, reviewStatus },
    });
    assert.equal(data.state.reviewState, reviewState); assert.equal(Object.hasOwn(data.state, 'reviewState'), reviewState !== undefined);
    assert.equal(data.state.state, 'draft'); assert.equal(data.state.checks, 'failing');
    assert.deepEqual(data.links.branch, refs.branch(projectId, 'work'));
    assert.deepEqual(data.state.reviewers, ['sam', 'alex', 'pat']);
  }
  assert.equal(pullRequests.pullRequestData(projectId, row(1, 'ready', 'work'), { summary: { state: 'closed' }, reviews: null }).state.state, 'closed');
});

test('sync reads each resident repository and open details in turn, puts PRs and inverse links, and keeps Branch.pullRequest after core puts', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.ops, [['status', {}], ['board', { cwd }], ['details', { url: url(1) }], ['details', { url: url(2) }]]);
    assert.deepEqual(s.graph.list('PullRequest').map((p) => p.ref), [ref(1), ref(2), ref(3)]);
    assert.deepEqual(s.instance(1).links, { repository, branch: refs.branch(projectId, 'work'), thread: null });
    assert.deepEqual(s.graph.related(repository, 'pullRequests').map((p) => p.ref), [ref(1), ref(2), ref(3)]);
    assert.equal(s.graph.can(ref(1), 'markReady'), true); assert.equal(s.graph.can(ref(1), 'merge'), true);
    assert.deepEqual(s.graph.resolve(refs.branch(projectId, 'work')).links.pullRequest, ref(1));
    assert.equal(s.graph.resolve(refs.branch(projectId, 'other')).links.pullRequest, undefined);
    await s.context.readRepository(projectId);
    assert.deepEqual(s.graph.resolve(refs.branch(projectId, 'work')).links.pullRequest, ref(1));
    s.repo.branch = 'other'; await s.context.readRepository(projectId);
    assert.equal(s.graph.resolve(refs.branch(projectId, 'work')).links.pullRequest, undefined);
    assert.deepEqual(s.graph.resolve(refs.branch(projectId, 'other')).links.pullRequest, ref(2));
    assert.deepEqual(s.events, []); assert.deepEqual(s.warnings, []);
    let active = 0, peak = 0;
    s.answers.set('details', async ({ url: value }) => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return { ok: true, result: { summary: { state: 'open', title: value, isDraft: false }, reviews: null } };
    });
    await s.feed.read(projectId);
    assert.equal(peak, 1);
    // a pull request the app names by its identity (a held merge: built review H6m2b) is the listed one, whatever the case
    assert.deepEqual(s.feed.pullRequestRef({ type: 'GitHubPullRequest', provider: 'codex', id: 'https://github.com/owner/repo/pull/2' }), ref(2));
    const unknown = { type: 'GitHubPullRequest', provider: 'codex', id: 'https://github.com/owner/repo/pull/99' };
    assert.equal(s.feed.pullRequestRef(unknown), unknown);
  } finally { await s.close(); }
});

test('later reads emit stateChanged/checksChanged once; summaries override the board and missing PRs are removed', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.events, []);
    s.replace([row(1, 'ready', 'work'), row(2, 'merged', 'other'), row(3, 'merged', 'old')]);
    await s.feed.read(projectId);
    assert.deepEqual(s.events, [[ref(1), 'stateChanged'], [ref(1), 'checksChanged'], [ref(2), 'stateChanged']]);
    await s.feed.read(projectId);
    assert.equal(s.events.length, 3);
    s.answers.set('details', { ok: true, result: { summary: { state: 'closed', isDraft: false, title: 'Closed', ciStatus: 'none', headBranch: 'work' }, reviews: null } });
    await s.feed.read(projectId);
    assert.deepEqual(s.events.slice(3), [[ref(1), 'stateChanged'], [ref(1), 'checksChanged']]);
    assert.equal(s.instance(1).state.state, 'closed');
    assert.equal(s.graph.resolve(refs.branch(projectId, 'work')).links.pullRequest, null);
    s.replace([row(3, 'merged', 'old')]); await s.feed.read(projectId);
    assert.equal(s.instance(1).gone, true); assert.equal(s.instance(2).gone, true);
    assert.deepEqual(s.graph.related(repository, 'pullRequests').map((p) => p.ref), [ref(3)]);
  } finally { await s.close(); }
});

test('attachment notifications link, unlink and remember identities not yet on the board', async () => {
  const s = await setup();
  try {
    const note = (number, operation = 'created', extra = {}) => ({ threadId: s.threadId, attachmentType: 'pull_request', identityKey: pullRequests.identityKey(pullRequests.parseUrl(url(number))), attachmentId: 'a', operation, ...extra });
    await s.notify(note(1, 'created', { attachmentType: 'other' }));
    assert.equal(s.instance(1).links.thread, null);
    await s.notify(note(1));
    assert.deepEqual(s.instance(1).links.thread, refs.thread(s.threadId));
    await s.context.readRepository(projectId); await s.feed.read(projectId);
    assert.deepEqual(s.instance(1).links.thread, refs.thread(s.threadId));
    await s.notify(note(1, 'deleted'));
    assert.equal(s.instance(1).links.thread, null);
    await s.notify(note(4));
    s.replace([...initial(), row(4, 'ready', 'new')]); await s.feed.read(projectId);
    assert.deepEqual(s.instance(4).links.thread, refs.thread(s.threadId));
    await s.notify(note(4, 'deleted')); assert.equal(s.instance(4).links.thread, null);
    await s.notify(note(5)); await s.notify(note(5, 'deleted'));
    s.replace([row(5, 'ready', 'work')]); await s.feed.read(projectId);
    assert.equal(s.instance(5).links.thread, null); assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('unavailable gh does no board/detail reads, retries status after five minutes and resumes reads', async () => {
  const s = await setup({ available: false });
  try {
    assert.deepEqual(s.ops, [['status', {}]]); assert.deepEqual(s.graph.list('PullRequest'), []);
    await s.feed.read(projectId); await s.feed.start(); await s.feed.observe(ref(1), 'PullRequest');
    assert.equal(s.ops.length, 1);
    no(await s.invoke(s.putSet(), 'openPullRequest', [], mod)); assert.deepEqual(s.prompts, []);
    s.answers.set('status', { ok: true, result: { available: true } });
    s.clock(399_999); await s.feed.start(); assert.equal(s.ops.length, 1);
    s.clock(400_000); await s.feed.start();
    assert.equal(s.ops.filter(([op]) => op === 'status').length, 2);
    assert.deepEqual(s.graph.list('PullRequest').map((p) => p.ref), [ref(1), ref(2), ref(3)]);
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('open and refresh use local ops; markReady and merge mutate then refresh and read the board', async () => {
  const s = await setup();
  try {
    s.calls.length = 0;
    assert.equal(success(await s.invoke(ref(1), 'open')), null);
    assert.deepEqual(s.calls, [['open', { url: url(1) }], ['board', { cwd }], ['details', { url: url(1) }], ['details', { url: url(2) }]]);
    s.calls.length = 0;
    success(await s.invoke(ref(1), 'refresh'));
    assert.deepEqual(s.calls.map(([op]) => op), ['details', 'board', 'details', 'details']);
    s.calls.length = 0;
    success(await s.invoke(ref(1), 'markReady'));
    assert.deepEqual(s.calls, [['mark-ready', { url: url(1) }], ['details', { url: url(1) }], ['board', { cwd }], ['details', { url: url(1) }], ['details', { url: url(2) }]]);
    assert.equal(s.instance(1).state.state, 'open'); assert.equal(s.instance(1).state.checks, 'passing');
    assert.deepEqual(s.events, [[ref(1), 'stateChanged'], [ref(1), 'checksChanged']]);
    s.calls.length = 0;
    success(await s.invoke(ref(2), 'merge'));
    assert.deepEqual(s.calls, [['merge', { url: url(2) }], ['details', { url: url(2) }], ['board', { cwd }], ['details', { url: url(1) }]]);
    assert.equal(s.instance(2).state.state, 'merged'); assert.deepEqual(s.events.at(-1), [ref(2), 'stateChanged']);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('state and check refusals and unknown PRs make no call and ask no R17 prompt', async () => {
  const s = await setup();
  try {
    const count = s.ops.length;
    for (const [r, op] of [[ref(2), 'markReady'], [ref(3), 'markReady'], [ref(1), 'merge'], [ref(3), 'merge']]) no(await s.invoke(r, op, [], mod));
    for (const checks of ['failing', 'pending']) {
      s.replace([row(2, 'ready', 'other', checks)]); await s.feed.read(projectId);
      const before = s.ops.length, result = await s.invoke(ref(2), 'merge', [], mod);
      no(result); assert.equal(result.message, 'its checks have not passed'); assert.equal(s.ops.length, before);
    }
    const unknown = { ref: ref(99), links: {}, state: {} };
    assert.equal(s.feed.prompt('merge', unknown, []), null);
    no(await s.feed.run('open', unknown, []));
    assert.equal(s.ops.slice(count).every(([op]) => ['board', 'details'].includes(op)), true);
    assert.deepEqual(s.prompts, []);
    for (const checks of ['none', 'passing']) {
      s.replace([row(2, 'ready', 'other', checks)]); await s.feed.read(projectId);
      success(await s.invoke(ref(2), 'merge'));
    }
  } finally { await s.close(); }
});

test('openPullRequest uses the core push, creates with optional title/body, attaches with the graph intent and returns the ref', async () => {
  const s = await setup();
  try {
    const set = s.putSet();
    for (const args of [[], ['Title', 'Body\n\nText']]) {
      s.calls.length = 0;
      const result = await s.invoke(set, 'openPullRequest', args), pr = success(result);
      const number = pr.id.endsWith('/4') ? 4 : 5;
      assert.deepEqual(pr, ref(number));
      assert.deepEqual(s.calls.slice(0, 4), [['push', projectId], ['repository', projectId],
        ['create', { cwd, headBranch: 'work', title: args[0], body: args[1] }],
        ['thread/attachment/add', { threadId: s.threadId, attachmentType: 'pull_request', identityKey: '["github.com","owner","repo",' + number + ']', payload: { url: url(number), root: cwd, headBranch: 'work' } }]]);
      assert.deepEqual(s.calls[4], ['board', { cwd }]);
      assert.equal(s.requests.at(-1)[2], result.intent); assert.equal(typeof result.intent, 'string');
      assert.deepEqual(s.instance(number).links.thread, refs.thread(s.threadId));
      assert.deepEqual(s.instance(number).links.repository, repository);
    }
    assert.deepEqual(s.prompts, []); assert.deepEqual(s.warnings, []);
  } finally { await s.close(); }
});

test('R17 names the PR, the selected merge method and the chat branch; only mod callers ask and a denial makes no write', async () => {
  for (const mergeMethod of ['merge', 'squash']) {
    const s = await setup({ mergeMethod });
    try {
      success(await s.invoke(ref(1), 'markReady', [], mod));
      success(await s.invoke(ref(2), 'merge', [], mod));
      success(await s.invoke(s.putSet(), 'openPullRequest', [], mod));
      assert.deepEqual(s.prompts, [
        { action: 'mark the pull request “PR 1” ready for review', detail: 'GitHub shows it to its reviewers as ready.' },
        { action: 'merge the pull request “PR 2”', detail: `It merges on GitHub with your account (${mergeMethod}); this cannot be undone from the app.` },
        { action: 'open a pull request for the changes of “Chat”', detail: 'It pushes the branch work and opens a pull request on GitHub with your account.' },
      ]);
      success(await s.invoke(ref(1), 'open', [], mod)); success(await s.invoke(ref(1), 'refresh', [], mod));
      assert.equal(s.prompts.length, 3, 'local operations do not ask');
      s.approve(false); s.replace(initial()); await s.feed.read(projectId);
      const count = s.ops.length;
      no(await s.invoke(ref(1), 'markReady', [], mod), 'notAllowed');
      no(await s.invoke(ref(2), 'merge', [], mod), 'notAllowed');
      no(await s.invoke(s.putSet(), 'openPullRequest', [], mod), 'notAllowed');
      assert.equal(s.ops.length, count);
      success(await s.invoke(ref(1), 'markReady'));
      assert.equal(s.prompts.length, 6, 'a user call does not ask');
    } finally { await s.close(); }
  }
});

test('openPullRequest refuses default/base branches, missing links/repositories and invalid overrides before push or approval', async () => {
  const s = await setup();
  try {
    const set = s.putSet();
    s.replace([row(2, 'ready', 'other', 'passing', { baseBranch: 'trunk' })]); await s.feed.read(projectId);
    for (const branch of ['main', 'master', 'trunk', null]) {
      s.repo.branch = branch; await s.context.readRepository(projectId);
      const count = s.calls.length, r = await s.invoke(set, 'openPullRequest', [], mod);
      no(r); assert.equal(r.message, 'open a pull request from a branch of its own'); assert.equal(s.calls.length, count);
    }
    s.repo.branch = 'work'; await s.context.readRepository(projectId);
    let count = s.calls.length;
    for (const args of [['x'.repeat(301)], ['Title', 'x'.repeat(60_001)]]) no(await s.invoke(set, 'openPullRequest', args, mod), 'invalid');
    assert.equal(s.calls.length, count);
    s.context.handle.update(refs.thread(s.threadId), { links: { project: null } });
    no(await s.invoke(set, 'openPullRequest', [], mod));
    s.context.handle.update(refs.thread(s.threadId), { links: { project: refs.project(projectId) } });
    s.context.handle.update(set, { links: { thread: refs.thread('not-resident') } });
    no(await s.invoke(set, 'openPullRequest', [], mod));
    s.context.handle.update(set, { links: { thread: refs.thread(s.threadId) } });
    s.context.handle.remove(refs.branch(projectId, 'work'));
    no(await s.invoke(set, 'openPullRequest', [], mod));
    await s.context.readRepository(projectId); count = s.calls.length;
    s.context.handle.remove(refs.project(projectId));
    no(await s.invoke(set, 'openPullRequest', [], mod));
    assert.equal(s.calls.length, count); assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
  const noGit = await setup({ git: false });
  try { no(await noGit.invoke(noGit.putSet(), 'openPullRequest', [], mod)); assert.deepEqual(noGit.prompts, []); }
  finally { await noGit.close(); }
});

test('push refusals and failures stop before create; create/attachment failures are not retried', async () => {
  const s = await setup();
  try {
    const set = s.putSet();
    for (const refused of [true, false]) {
      const count = s.ops.filter(([op]) => op === 'create').length;
      s.appAnswers.set('push', { ok: false, refused, error: 'push failed' });
      let r = await s.invoke(set, 'openPullRequest');
      assert.equal(r.status, refused ? 'refused' : 'failed'); assert.equal(refused ? r.message : r.error.message, 'push failed');
      assert.equal(s.ops.filter(([op]) => op === 'create').length, count);
      s.appAnswers.delete('push');
      s.answers.set('create', { ok: false, refused, error: 'create failed' });
      r = await s.invoke(set, 'openPullRequest');
      assert.equal(r.status, refused ? 'refused' : 'failed'); assert.equal(refused ? r.message : r.error.message, 'create failed');
      assert.deepEqual(s.requests, []);
      s.answers.delete('create');
    }
    s.attachmentError('attach failed');
    const before = s.ops.filter(([op]) => op === 'create').length;
    const r = await s.invoke(set, 'openPullRequest');
    assert.equal(r.status, 'failed'); assert.match(r.error.message, /attach failed/);
    assert.equal(s.ops.filter(([op]) => op === 'create').length, before + 1);
    assert.equal(s.requests.length, 1);
  } finally { await s.close(); }
});

test('main refusals become unavailable, failures throw, and board failures preserve known PRs', async () => {
  const s = await setup();
  try {
    for (const [op, mainOp, pr] of [['open', 'open', ref(1)], ['refresh', 'details', ref(1)], ['markReady', 'mark-ready', ref(1)], ['merge', 'merge', ref(2)]]) {
      for (const refused of [true, false]) {
        s.answers.set(mainOp, { ok: false, refused, error: 'worker said no' });
        const r = await s.invoke(pr, op);
        assert.equal(r.status, refused ? 'refused' : 'failed'); assert.equal(refused ? r.message : r.error.message, 'worker said no');
        if (refused) assert.equal(r.reason, 'unavailable');
      }
      s.answers.delete(mainOp);
    }
    const before = s.graph.list('PullRequest');
    s.answers.set('board', { ok: false, refused: true, error: 'read failed' });
    await s.feed.read(projectId);
    assert.deepEqual(s.graph.list('PullRequest'), before);
    assert.ok(s.warnings.some(([, d]) => d.message === 'read failed'));
  } finally { await s.close(); }
  const s2 = await setup({ main: false });
  try { assert.deepEqual(s2.graph.list('PullRequest'), []); no(await s2.invoke(s2.putSet(), 'openPullRequest')); }
  finally { await s2.close(); }
});

test('observe shares an ongoing board read, uses its project, and refreshes only after thirty seconds', async () => {
  const s = await setup();
  let release;
  try {
    assert.equal(s.feed.observe(refs.agent(), 'CodexAgent'), undefined);
    let count = boardReads(s).length;
    await s.feed.observe(ref(1), 'PullRequest');
    s.clock(130_000); await s.feed.observe(ref(1), 'PullRequest');
    assert.equal(boardReads(s).length, count);
    s.clock(130_001);
    const view = s.graph.subscribe({ ref: ref(1) }, () => {});
    await view.loaded; view.dispose();
    assert.equal(boardReads(s).length, ++count);
    let active = 0, peak = 0, held = false;
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('board', async () => {
      active++; peak = Math.max(peak, active);
      if (!held) { held = true; await gate; }
      active--; return { ok: true, result: { items: initial() } };
    });
    const running = s.feed.read(projectId);
    assert.equal(s.feed.observe(ref(2), 'PullRequest'), running);
    assert.equal(s.feed.read(projectId), running);
    release(); await running;
    assert.equal(peak, 1); assert.equal(boardReads(s).length, count + 2);
    count = boardReads(s).length;
    await s.feed.read('no-git'); await s.feed.observe(ref(99), 'PullRequest');
    assert.equal(boardReads(s).length, count);
  } finally { release?.(); await s.close(); }
});

test('120-second board and five-minute status timers refresh, are unrefd and stop with disposal', async (t) => {
  const s = await setup();
  let extra;
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    extra = pullRequests.createFeed(s.context);
    await extra.start();
    let count = boardReads(s).length;
    t.mock.timers.tick(119_999); assert.equal(boardReads(s).length, count);
    t.mock.timers.tick(1); await extra.observe(ref(1), 'PullRequest');
    assert.equal(boardReads(s).length, ++count);
    s.clock(400_000); t.mock.timers.tick(180_000);
    await extra.start(); await extra.observe(ref(1), 'PullRequest');
    assert.equal(s.ops.filter(([op]) => op === 'status').length, 3);
    count = s.ops.length;
    extra.dispose(); t.mock.timers.tick(300_000);
    await extra.start(); assert.equal(s.ops.length, count);
  } finally { extra?.dispose(); await s.close(); }
});

test('server-down and disposed operations refuse without approval; ready reads again and disposed reads put nothing', async () => {
  const s = await setup();
  let release;
  try {
    const set = s.putSet(), count = s.ops.length;
    s.h.bus.publish('appServer/exited', { reason: 'crash' });
    for (const [r, op] of [[ref(1), 'markReady'], [ref(2), 'merge'], [ref(1), 'open'], [ref(1), 'refresh'], [set, 'openPullRequest']]) no(await s.invoke(r, op, [], mod), s.context.DOWN.reason);
    await s.feed.read(projectId); assert.equal(s.ops.length, count); assert.deepEqual(s.prompts, []);
    s.h.bus.publish('appServer/ready', {});
    await until(() => s.ops.length > count, 3000, 'ready reads the board');
    await s.feed.observe(ref(1), 'PullRequest');
    const before = s.graph.list('PullRequest');
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('board', async () => { await gate; return { ok: true, result: { items: [row(9, 'ready', 'work')] } }; });
    const running = s.feed.read(projectId);
    s.feed.dispose(); release(); await running;
    assert.deepEqual(s.graph.list('PullRequest'), before);
    no(await s.invoke(ref(1), 'markReady', [], mod)); assert.deepEqual(s.prompts, []);
    s.context.handle.put(refs.branch(projectId, 'work'), { state: { name: 'work', current: true }, links: { repository } });
    assert.equal(s.graph.resolve(refs.branch(projectId, 'work')).links.pullRequest, undefined, 'the event subscription was disposed');
  } finally { release?.(); await s.close(); }
});

test('H6m4: Branch.openPullRequest creates a pull request of that branch (the current one pushed first, as the branch checked out; another as it is on the code host), with its options, and returns the ref; its options checked first', async () => {
  const s = await setup();
  try {
    const work = refs.branch(projectId, 'work');
    s.calls.length = 0;
    const result = await s.invoke(work, 'openPullRequest', [{ base: 'main', title: 'T', draft: true }], mod);
    const pr = success(result);
    assert.equal(pr.type, 'GitHubPullRequest');
    // the repository read first (which branch is checked out), the branch pushed as the one checked out, then created
    assert.deepEqual(s.calls.filter((c) => ['repository', 'push', 'create'].includes(c[0])).slice(0, 4), [['repository', projectId], ['push', projectId], ['repository', projectId], ['create', { cwd, headBranch: 'work', title: 'T', body: undefined, base: 'main', draft: true }]]);
    assert.deepEqual(s.prompts.at(-1), { action: 'open a pull request of the branch work', detail: 'It pushes the branch and opens a pull request into main on GitHub with your account.' });
    // another branch: not pushed here (gh says so when the code host does not have it)
    s.calls.length = 0;
    success(await s.invoke(refs.branch(projectId, 'other'), 'openPullRequest', [], mod));
    assert.deepEqual(s.calls.filter((c) => c[0] === 'push' || c[0] === 'create').map((c) => c[0] === 'create' ? ['create', c[1].headBranch] : ['push']), [['create', 'other']]);
    for (const args of [[{ title: 'x'.repeat(301) }], [{ base: 'work' }], [{ draft: 'yes' }], ['str']]) no(await s.invoke(work, 'openPullRequest', args, mod), 'invalid');
  } finally { await s.close(); }
});

test('H6m4 review round 2: a folder names its checkout\'s own repository (the nearest project in that checkout), another worktree\'s as such, never a project around the checkout; a folder git does not know, none', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-repos-')));
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA', ...a], { stdio: 'ignore' });
  const main = path.join(dir, 'main'), wt = path.join(dir, 'wt'), nested = path.join(main, 'nested'), plain = path.join(dir, 'plain');
  for (const d of [main, path.join(main, 'pkg', 'x'), plain]) fs.mkdirSync(d, { recursive: true });
  git(main, 'init', '-q'); fs.writeFileSync(path.join(main, 'f.txt'), 'f'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'one');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  fs.mkdirSync(nested); git(nested, 'init', '-q');
  const s = await setup();
  try {
    s.appAnswers.set('repository', { ok: true, result: structuredClone(s.repo) });
    const projects = (list) => s.appProjects.apply({ type: 'projects', available: true, reset: true, projects: list, threads: {}, selected: null });
    const of = async (p) => { const r = await s.source.repositoryOfPath(p); return r ? [r.ref.id, r.checkout] : null; };
    projects([{ id: 'P1', name: 'Main', roots: [main] }]);
    await until(async () => (await of(path.join(main, 'pkg'))) !== null, 3000, 'P1 read');
    assert.deepEqual(await of(path.join(main, 'pkg', 'x')), ['P1', 'own']);
    assert.deepEqual(await of(wt), ['P1', 'worktree'], 'another worktree of P1\'s repository');
    assert.equal(await of(nested), null, 'a checkout inside P1\'s folder is not P1\'s (a submodule\'s superproject is never its project)');
    assert.equal(await of(plain), null, 'a folder git does not know');
    // a project at a subfolder of the checkout (the nearest), and a worktree registered as its own project
    projects([{ id: 'P1', name: 'Main', roots: [main] }, { id: 'P2', name: 'Pkg', roots: [path.join(main, 'pkg')] }, { id: 'P3', name: 'Side', roots: [wt] }]);
    await until(async () => (await of(wt))?.[0] === 'P3', 3000, 'P3 read');
    assert.deepEqual(await of(path.join(main, 'pkg', 'x')), ['P2', 'own']);
    assert.deepEqual(await of(wt), ['P3', 'own']);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
