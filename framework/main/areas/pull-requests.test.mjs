// Framework-main pull requests with fake AppHost handles: no gh process, repository, browser or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./pull-requests.cjs');
const cwd = '/repo/subfolder', root = '/repo', url = 'https://GitHub.COM./Owner/Repo/pull/12';
const pullRequest = { hostname: 'github.com', owner: 'owner', repository: 'repo', number: 12 };
const account = { hostId: 'local', hostname: 'github.com', login: 'alex' };
const summary = { status: 'success', title: 'Work', url, state: 'open', isDraft: false, ciStatus: 'passing', headBranch: 'work', baseBranch: 'main', headRevision: 'head-sha' };
const reviews = { status: 'success', reviewStatus: 'approved', reviewers: { approved: ['sam'], changesRequested: [], commented: [], requested: [] } };
const item = { title: 'Work', number: 12, url, state: 'ready', ciStatus: 'passing', canMerge: true, mergeBlocker: null,
  headBranch: 'work', baseBranch: 'main', additions: 3, deletions: 1, createdAt: '2026-10-24', updatedAt: '2026-10-25', isAuthor: true, cwd: root, hostId: 'local' };

function setup({ origins = [{ root }], value, services: supplied } = {}) {
  const calls = [], answers = new Map(), handles = [], opened = [];
  const services = supplied === undefined ? {
    repositoryOrigins: origins === null ? undefined : { async read(...args) { calls.push(['origins', ...args]); return { origins }; } },
    openIn: { async requestGitWorker({ method, params }) {
      calls.push([method, params]);
      const r = answers.get(method) ?? { root };
      return typeof r === 'function' ? r(params) : r;
    } },
    projects: { globalState: { get(key) { calls.push(['get', key]); return value; } } },
    github: { request(method, params, source) {
      calls.push([method, params, source]);
      const defaults = { 'gh-cli-status': { isInstalled: true, isAuthenticated: true },
        'gh-current-user': { status: 'success', account: { ...account, hostname: params.hostname }, login: 'alex', avatarUrl: 'avatar' },
        'gh-pr-board': { status: 'success', items: [{ ...item, privateExtra: 'omit' }] }, 'gh-pr-summary': summary, 'gh-pr-reviews': reviews,
        'gh-pr-update': { status: 'success' }, 'gh-pr-merge': { status: 'success' }, 'gh-pr-create': { status: 'success', url, number: 12 } };
      const handle = { method, waits: 0, disposals: 0,
        async wait() { this.waits++; const r = answers.has(method) ? answers.get(method) : defaults[method]; return typeof r === 'function' ? r(params) : r; },
        [Symbol.dispose]() { this.disposals++; } };
      handles.push(handle);
      return handle;
    } },
  } : supplied;
  let run;
  register({ appHost: { first: () => services === null ? null : { id: 7, host: { services } } },
    electron: { async openExternal(value) { opened.push(value); } },
    onAreaOp(area, fn) { assert.equal(area, 'pull-requests'); run = fn; } });
  return { run, calls, answers, handles, opened, services };
}
const originsCall = ['origins', { dirs: [cwd], hostId: 'local' }, 'git_direct_call'];
const currentUser = (hostname = 'github.com') => ['gh-current-user', { hostId: 'local', hostname }, 'pull_requests_page'];
const prCall = (method, extra = {}) => [method, { account, pullRequest, ...extra }, 'pull_requests_page'];
const refusal = (pattern) => (e) => e.refused === true && pattern.test(e.message);
const disposed = (s) => { for (const h of s.handles) { assert.equal(h.waits, 1); assert.equal(h.disposals, 1, h.method); } };

test('status is the installed/authenticated conjunction, and rejections or a missing service are unavailable', async () => {
  const s = setup();
  for (const [isInstalled, isAuthenticated] of [[true, true], [false, true], [true, false], [false, false]]) {
    s.answers.set('gh-cli-status', { isInstalled, isAuthenticated });
    const why = !isInstalled ? 'the gh CLI is not installed' : !isAuthenticated ? 'the gh CLI is not signed in' : null;
    assert.deepEqual(await s.run('status'), why ? { available: false, reason: why } : { available: true });
  }
  s.answers.set('gh-cli-status', () => { throw new Error('gh unavailable'); });
  assert.deepEqual(await s.run('status'), { available: false, reason: 'gh unavailable' });
  assert.deepEqual(s.calls, Array(5).fill(['gh-cli-status', { hostId: 'local' }, 'git_direct_call']));
  disposed(s);
  for (const services of [null, {}, { github: {} }]) await assert.rejects(setup({ services }).run('status'), (e) => e.refused === true, 'no window or service: refused, so the Host asks again');
});

test('board finds the repository root, calls the board source, and returns only its specified fields', async () => {
  const s = setup();
  assert.deepEqual(await s.run('board', { cwd }), { items: [item] });
  assert.deepEqual(s.calls, [originsCall, ['gh-pr-board', { cwd: root, hostId: 'local' }, 'pull_request_board']]);
  disposed(s);
  for (const origins of [null, [], [{}], [{ root: 'relative' }]]) {
    const fallback = setup({ origins });
    assert.deepEqual(await fallback.run('board', { cwd }), { items: [item] });
    assert.deepEqual(fallback.calls.slice(-2), [['stable-metadata', { cwd, operationSource: 'git_direct_call' }], ['gh-pr-board', { cwd: root, hostId: 'local' }, 'pull_request_board']]);
    disposed(fallback);
  }
});

test('details use a normalized PR identity, wait and dispose in order, and retain only successful reviews', async () => {
  const s = setup();
  assert.deepEqual(await s.run('details', { url }), { summary, reviews });
  assert.deepEqual(s.calls, [currentUser(), prCall('gh-pr-summary'), prCall('gh-pr-reviews')]);
  for (const status of ['unavailable', 'not-found', 'error']) {
    s.answers.set('gh-pr-reviews', { status });
    assert.deepEqual(await s.run('details', { url }), { summary, reviews: null });
  }
  disposed(s);
});

test('the account is cached 60 seconds per normalized hostname, and account errors are refused and not cached', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const s = setup();
  await s.run('details', { url });
  t.mock.timers.tick(59_999);
  await s.run('details', { url: 'https://github.com/owner/repo/pull/13' });
  assert.equal(s.calls.filter(([m]) => m === 'gh-current-user').length, 1);
  await s.run('details', { url: 'https://Git.Example.COM../O/R/pull/1' });
  assert.deepEqual(s.calls.filter(([m]) => m === 'gh-current-user').at(-1), currentUser('git.example.com'));
  t.mock.timers.tick(1);
  await s.run('details', { url });
  assert.equal(s.calls.filter(([m]) => m === 'gh-current-user').length, 3);
  s.answers.set('gh-current-user', { status: 'error', error: 'not signed in' });
  for (let i = 0; i < 2; i++) await assert.rejects(s.run('details', { url: 'https://other.example/o/r/pull/1' }), refusal(/^not signed in$/));
  assert.equal(s.calls.filter(([m]) => m === 'gh-current-user').length, 5);
  disposed(s);
});

test('mark-ready updates the PR; merge reads the current head and follows the global merge method, defaulting to merge', async () => {
  const ready = setup();
  assert.deepEqual(await ready.run('mark-ready', { url }), {});
  assert.deepEqual(ready.calls, [currentUser(), prCall('gh-pr-update', { action: 'mark-ready' })]);
  disposed(ready);
  for (const value of [undefined, null, 'merge', 'squash']) {
    const s = setup({ value });
    assert.deepEqual(await s.run('merge', { url }), {});
    assert.deepEqual(s.calls, [currentUser(), prCall('gh-pr-summary'), ['get', 'git-pull-request-merge-method'],
      prCall('gh-pr-merge', { mergeMethod: value ?? 'merge', expectedHeadRevision: 'head-sha' })]);
    disposed(s);
  }
});

test('create does not push or generate text, uses the root, and forwards non-empty overrides', async () => {
  const s = setup();
  for (const overrides of [{}, { title: '', body: '' }, { title: 'Title', body: 'Body\n\nText' }]) {
    s.calls.length = 0;
    assert.deepEqual(await s.run('create', { cwd, headBranch: 'work', ...overrides }), { url });
    assert.deepEqual(s.calls, [originsCall, ['gh-pr-create', { cwd: root, hostId: 'local', headBranch: 'work',
      ...(overrides.title ? { titleOverride: overrides.title } : {}), ...(overrides.body ? { bodyOverride: overrides.body } : {}) }, 'local_conversation_git_actions']]);
  }
  disposed(s);
});

test('open validates the URL and opens it on the web without needing a window or github account', async () => {
  const s = setup({ services: null });
  assert.deepEqual(await s.run('open', { url }), {});
  assert.deepEqual(s.opened, [url]);
  assert.deepEqual(s.calls, []);
});

test('bad URLs, guards and unknown operations refuse before reaching any service', async () => {
  const s = setup();
  for (const bad of [undefined, null, 2, '', 'garbage', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/-1', 'https://github.com/o/r/pull/1.5', 'https://github.com/o/r/pull/9007199254740992',
    'https://github.com/o/r/pull/1/more', 'https://user:pass@github.com/o/r/pull/1', 'https://github.com:8443/o/r/pull/1', 'https://github.com/o/r/pull/1?x=1']) {
    for (const op of ['open', 'details', 'merge', 'mark-ready']) await assert.rejects(s.run(op, { url: bad }), refusal(/pull request url/));
  }
  for (const bad of [undefined, 2, '', 'relative', '/bad\0path']) for (const op of ['board', 'create']) {
    await assert.rejects(s.run(op, { cwd: bad, headBranch: 'work' }), refusal(/absolute project folder/));
  }
  for (const headBranch of [undefined, 2, '', ' \n ', 'w'.repeat(251), 'bad\0branch']) await assert.rejects(s.run('create', { cwd, headBranch }), refusal(/branch name/));
  for (const title of [null, 2, 't'.repeat(301)]) await assert.rejects(s.run('create', { cwd, headBranch: 'work', title }), refusal(/title/));
  for (const body of [null, 2, 'b'.repeat(60_001)]) await assert.rejects(s.run('create', { cwd, headBranch: 'work', body }), refusal(/body/));
  for (const op of ['other', 'constructor', '__proto__']) await assert.rejects(s.run(op), refusal(new RegExp(`^unknown operation ${op}$`)));
  assert.deepEqual(s.calls, []); assert.deepEqual(s.opened, []);
  await s.run('create', { cwd, headBranch: 'w'.repeat(250), title: 't'.repeat(300), body: 'b'.repeat(60_000) });
  disposed(s);
});

test('board/account/summary refusals leave mutations untried; closed and merged PRs cannot merge', async () => {
  const s = setup();
  s.answers.set('gh-pr-board', { status: 'error', error: 'board unavailable' });
  await assert.rejects(s.run('board', { cwd }), refusal(/^board unavailable$/));
  for (const status of ['not-found', 'unavailable']) {
    s.answers.set('gh-pr-summary', { status });
    for (const op of ['details', 'merge']) await assert.rejects(s.run(op, { url }), refusal(new RegExp(`^the pull request is not available: ${status}$`)));
  }
  for (const state of ['closed', 'merged']) {
    s.answers.set('gh-pr-summary', { ...summary, state });
    await assert.rejects(s.run('merge', { url }), refusal(/^the pull request is not open$/));
  }
  assert.equal(s.calls.some(([m]) => ['gh-pr-merge', 'gh-pr-update', 'gh-pr-reviews'].includes(m)), false);
  disposed(s);
});

test('mutation error statuses and thrown handle failures throw, and every handle is disposed', async () => {
  for (const [op, method, args] of [['mark-ready', 'gh-pr-update', { url }], ['merge', 'gh-pr-merge', { url }], ['create', 'gh-pr-create', { cwd, headBranch: 'work' }]]) {
    for (const error of ['operation failed', new Error('operation failed')]) {
      const s = setup();
      s.answers.set(method, { status: 'error', error });
      await assert.rejects(s.run(op, args), (e) => !e.refused && e.message === 'operation failed');
      disposed(s);
    }
  }
  for (const method of ['gh-current-user', 'gh-pr-summary', 'gh-pr-reviews']) {
    const s = setup();
    s.answers.set(method, () => { throw new Error('worker failed'); });
    await assert.rejects(s.run('details', { url }), (e) => e.message === 'worker failed' && (method !== 'gh-current-user' || e.refused === true));
    disposed(s);
  }
});

test('missing services and repository roots refuse; origins failures propagate', async () => {
  for (const services of [null, {}, { github: {} }]) await assert.rejects(setup({ services }).run('details', { url }), (e) => e.refused === true);
  for (const answer of [{ root: null }, { root: 'relative' }, { root, error: 'not git' }, () => { throw new Error('not git'); }]) {
    const s = setup({ origins: [] }); s.answers.set('stable-metadata', answer);
    await assert.rejects(s.run('create', { cwd, headBranch: 'work' }), refusal(/not in a git repository/));
    assert.equal(s.handles.length, 0);
  }
  const s = setup();
  s.services.repositoryOrigins.read = async () => { throw new Error('origins failed'); };
  await assert.rejects(s.run('board', { cwd }), /origins failed/);
  assert.equal(s.handles.length, 0);
});

test('GitHub handle waits, origins and metadata are bounded by withTimeout, with handles disposed on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise(() => {});
  for (const [op, method, args] of [['status', 'gh-cli-status', {}], ['details', 'gh-current-user', { url }], ['details', 'gh-pr-summary', { url }],
    ['details', 'gh-pr-reviews', { url }], ['board', 'gh-pr-board', { cwd }], ['mark-ready', 'gh-pr-update', { url }], ['merge', 'gh-pr-merge', { url }], ['create', 'gh-pr-create', { cwd, headBranch: 'work' }]]) {
    const s = setup(); s.answers.set(method, never);
    const done = op === 'status' ? s.run(op, args).then((r) => assert.deepEqual(r, { available: false, reason: 'the app did not answer in 15000 ms' }))
      : assert.rejects(s.run(op, args), /did not answer in 15000 ms/);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(s.handles.at(-1).method, method);
    t.mock.timers.tick(15_000);
    await done; disposed(s);
  }
  const s = setup(); s.services.repositoryOrigins.read = never;
  let done = assert.rejects(s.run('board', { cwd }), /did not answer in 15000 ms/);
  t.mock.timers.tick(15_000); await done;
  delete s.services.repositoryOrigins; s.answers.set('stable-metadata', never);
  done = assert.rejects(s.run('board', { cwd }), refusal(/not in a git repository/));
  t.mock.timers.tick(15_000); await done;
});
