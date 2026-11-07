// Framework-main history with fake AppHost services. The only git calls are recorded worker requests; no repository or app is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./history.cjs');
const cwd = '/repo/subfolder', root = '/repo';
const entry = (path, extra = {}) => ({ path, previousPath: null, changeKind: 'modified', revision: `revision:${path}`, additions: 1, deletions: 2, baseObjectId: 'base', ...extra });
const commits = Array.from({ length: 7 }, (_, i) => ({ sha: `sha${i}`, committedAt: `2026-10-${25 - i}T12:00:00Z`, message: `Message ${i}\n\nBody\n`, subject: `Message ${i}` }));

function setup({ origins = [{ root, originUrl: 'remote' }], value, services: supplied, worker } = {}) {
  const calls = [], answers = new Map();
  const services = supplied === undefined ? {
    repositoryOrigins: origins === null ? undefined : { async read(...args) { calls.push(['origins', ...args]); return { origins }; } },
    projects: { globalState: { get(key) { calls.push(['get', key]); if (value instanceof Error) throw value; return value; } } },
    openIn: { async requestGitWorker({ method, params }) {
      calls.push([method, params]);
      if (answers.has(method)) { const a = answers.get(method); return typeof a === 'function' ? a(params) : a; }
      if (worker) return worker(method, params);
      if (method === 'stable-metadata') return { root };
      if (method === 'branch-commits') return { commits };
      if (method === 'review-summary') return { type: 'success', files: [entry('a'), entry('new', { previousPath: 'old', changeKind: 'renamed' }), entry('elsewhere')] };
      if (method === 'cat-file') return params.requests.map(({ oid }) => ({ type: 'success', lines: ['tree abc', `author Author ${oid} <person@example.com> 1700000000 +0000`, 'committer Other <other@example.com> 1700000000 +0000', '', 'Message'] }));
      if (method === 'apply-review-section-changes') return { status: 'success', appliedPaths: params.files.map((f) => f.path), skippedPaths: [], conflictedPaths: [] };
      if (method === 'commit') return { status: 'success', commitSha: 'created' };
      throw new Error(`unexpected ${method}`);
    } },
  } : supplied;
  let run;
  register({ appHost: { first: () => services === null ? null : { id: 7, host: { services } } },
    onAreaOp(area, fn) { assert.equal(area, 'history'); run = fn; } });
  return { run, calls, answers, services };
}
const originsCall = ['origins', { dirs: [cwd], hostId: 'local' }, 'git_direct_call'];
const summary = (source, operationSource = 'review_patch') => ['review-summary', { cwd: root, source, operationSource }];
const commit = (includeUnstaged, message = 'Message') => ['commit', { cwd: root, message, includeUnstaged, commitAttribution: null, operationSource: 'git_direct_call' }];
const refusal = (pattern) => (e) => e.refused === true && pattern.test(e.message);

test('commits use origins, preserve worker order and full messages, skip known facts, and read authors in batches of four', async () => {
  const s = setup();
  const r = await s.run('commits', { cwd, known: ['sha2'] });
  assert.deepEqual(r, { root, commits: commits.map(({ sha, message, committedAt }) => ({ sha, message, committedAt, ...(sha === 'sha2' ? {} : { files: 3, author: `Author ${sha}` }) })) });
  assert.deepEqual(s.calls, [originsCall, ['branch-commits', { root }],
    ...commits.filter((c) => c.sha !== 'sha2').map((c) => ['review-summary', { cwd: root, source: 'commit', commitSha: c.sha, operationSource: 'git_direct_call' }]),
    ['cat-file', { cwd: root, requests: ['sha0', 'sha1', 'sha3', 'sha4'].map((oid) => ({ oid })) }],
    ['cat-file', { cwd: root, requests: ['sha5', 'sha6'].map((oid) => ({ oid })) }],
  ]);
  s.calls.length = 0;
  await s.run('commits', { cwd, known: commits.map((c) => c.sha) });
  assert.deepEqual(s.calls, [originsCall, ['branch-commits', { root }]]);
});

test('the root falls back to stable metadata; no merge base gives an empty list; unreadable facts are null', async () => {
  for (const origins of [null, [], [{}]]) {
    const s = setup({ origins });
    s.answers.set('branch-commits', { commits: [] });
    assert.deepEqual(await s.run('commits', { cwd, known: [] }), { root, commits: [] });
    assert.deepEqual(s.calls.slice(-2), [['stable-metadata', { cwd, operationSource: 'git_direct_call' }], ['branch-commits', { root }]]);
  }
  const s = setup();
  for (const result of [{ type: 'expected' }, { type: 'error', error: 'bad commit' }, () => { throw new Error('worker unavailable'); }]) {
    s.answers.set('review-summary', result);
    s.answers.set('cat-file', [{ type: 'success', lines: ['committer Nobody <a@b> 1 +0000'] }, { type: 'error' }, { type: 'success', lines: ['author malformed'] }]);
    const r = await s.run('commits', { cwd, known: [] });
    assert.ok(r.commits.every((c) => c.files === null && c.author === null));
  }
  s.answers.set('cat-file', () => { throw new Error('cat-file failed'); });
  assert.ok((await s.run('commits', { cwd, known: [] })).commits.every((c) => c.author === null));
});

test('stage and unstage choose fresh entries by path and previousPath once, retaining every revision and field', async () => {
  for (const action of ['stage', 'unstage']) {
    const s = setup();
    assert.deepEqual(await s.run(action, { cwd, paths: ['a', 'old', 'new'] }), {});
    assert.deepEqual(s.calls, [originsCall, summary(action === 'stage' ? 'unstaged' : 'staged'),
      ['apply-review-section-changes', { action, cwd: root, files: [entry('a'), entry('new', { previousPath: 'old', changeKind: 'renamed' })], operationSource: 'review_patch', source: action === 'stage' ? 'unstaged' : 'staged' }],
    ]);
  }
});

test('missing paths refuse without staging; partial successes and errors throw with skipped and conflicted paths', async () => {
  for (const action of ['stage', 'unstage']) {
    const s = setup();
    await assert.rejects(s.run(action, { cwd, paths: ['a', 'missing', 'other'] }), refusal(new RegExp(`${action === 'stage' ? 'nothing to stage' : 'nothing staged'} for: missing, other`)));
    assert.equal(s.calls.some(([m]) => m === 'apply-review-section-changes'), false);
    for (const status of ['partial-success', 'error']) {
      s.answers.set('apply-review-section-changes', { status, appliedPaths: ['a'], skippedPaths: ['skip'], conflictedPaths: ['conflict'], errorCode: 'stale-revision' });
      await assert.rejects(s.run(action, { cwd, paths: ['a'] }), (e) => !e.refused && e.message.includes(status) && /skipped: skip; conflicted: conflict; stale-revision/.test(e.message));
    }
  }
});

test('commit without paths follows global include-unstaged, defaults true when unset or unreadable, and never adds attribution', async () => {
  for (const value of [false, true, undefined, null, new Error('store closed')]) {
    const s = setup({ value });
    assert.deepEqual(await s.run('commit', { cwd, message: ' \n Message \n ' }), { commitSha: 'created' });
    assert.deepEqual(s.calls, [originsCall, ['get', 'git-action-include-unstaged-changes'], commit(value === false ? false : true)]);
  }
  const s = setup();
  delete s.services.projects;
  assert.deepEqual(await s.run('commit', { cwd, message: 'Message' }), { commitSha: 'created' });
  assert.deepEqual(s.calls, [originsCall, commit(true)]);
});

test('commit with paths stages them first, forces includeUnstaged false, and does not commit when staging fails', async () => {
  const s = setup();
  assert.deepEqual(await s.run('commit', { cwd, message: 'Message', paths: ['old'] }), { commitSha: 'created' });
  assert.deepEqual(s.calls, [originsCall, summary('unstaged'), ['apply-review-section-changes', { action: 'stage', cwd: root,
    files: [entry('new', { previousPath: 'old', changeKind: 'renamed' })], operationSource: 'review_patch', source: 'unstaged' }], commit(false)]);
  s.calls.length = 0;
  s.answers.set('apply-review-section-changes', { status: 'partial-success', skippedPaths: ['new'], conflictedPaths: [] });
  await assert.rejects(s.run('commit', { cwd, message: 'Message', paths: ['old'] }), /partial-success/);
  assert.equal(s.calls.some(([op]) => op === 'commit'), false);
});

test('nothing-to-commit is refused; other commit errors and thrown worker errors fail', async () => {
  const s = setup();
  s.answers.set('commit', { status: 'error', errorType: 'nothing-to-commit', error: 'empty' });
  await assert.rejects(s.run('commit', { cwd, message: 'Message' }), refusal(/^there is nothing to commit$/));
  const failure = new Error('hook failed');
  for (const answer of [{ status: 'error', error: 'hook failed' }, { status: 'error', error: failure }, () => { throw failure; }]) {
    s.answers.set('commit', answer);
    await assert.rejects(s.run('commit', { cwd, message: 'Message' }), (e) => !e.refused && e.message === 'hook failed');
  }
});

test('staged-elsewhere returns staged paths outside the selection without mutating', async () => {
  const s = setup();
  assert.deepEqual(await s.run('staged-elsewhere', { cwd, paths: ['a', 'new'] }), ['elsewhere']);
  assert.deepEqual(s.calls, [originsCall, summary('staged', 'git_direct_call')]);
  assert.deepEqual(await s.run('staged-elsewhere', { cwd, paths: [] }), ['a', 'new', 'elsewhere']);
});

test('guards reject bad cwd, paths, messages and known shas before calling services; unknown operations refuse', async () => {
  const s = setup();
  for (const folder of [undefined, '', 'relative', 2, '/bad\0path']) await assert.rejects(s.run('commits', { cwd: folder, known: [] }), refusal(/absolute project folder/));
  for (const paths of [undefined, null, 'a', [], [''], [1], ['/repo/a'], ['../a'], ['sub/../../a'], ['a\0b'], Array(501).fill('a')]) {
    for (const action of ['stage', 'unstage']) await assert.rejects(s.run(action, { cwd, paths }), refusal(/repository-relative/));
    if (paths !== undefined) await assert.rejects(s.run('commit', { cwd, paths, message: 'Message' }), refusal(/repository-relative/));
  }
  for (const message of [undefined, null, 2, '', ' \n ', 'a'.repeat(20_001)]) await assert.rejects(s.run('commit', { cwd, message }), refusal(/commit message/));
  for (const known of [undefined, 'sha', [1], ['']]) await assert.rejects(s.run('commits', { cwd, known }), refusal(/known commit shas/));
  await assert.rejects(s.run('other', {}), refusal(/^unknown operation other$/));
  assert.deepEqual(s.calls, []);
  await s.run('commit', { cwd, message: ` ${'a'.repeat(20_000)} ` });
  await s.run('stage', { cwd, paths: Array(500).fill('a') });
});

test('missing window, worker or root refuses; read failures propagate, leaving mutations untried', async () => {
  for (const services of [null, {}, { openIn: {} }]) await assert.rejects(setup({ services }).run('commits', { cwd, known: [] }), (e) => e.refused === true);
  for (const result of [{ root: null }, { root: 'relative' }, { root, error: 'not a repository' }, () => { throw new Error('not a repo'); }]) {
    const s = setup({ origins: [] });
    s.answers.set('stable-metadata', result);
    await assert.rejects(s.run('commit', { cwd, message: 'Message' }), refusal(/^the folder is not in a git repository$/));
    assert.equal(s.calls.some(([m]) => m === 'commit'), false);
  }
  const s = setup();
  s.answers.set('branch-commits', { error: 'read failed' });
  await assert.rejects(s.run('commits', { cwd, known: [] }), /read failed/);
  s.answers.set('review-summary', { type: 'expected', message: 'no revision' });
  await assert.rejects(s.run('stage', { cwd, paths: ['a'] }), (e) => !e.refused && /no revision/.test(e.message));
  s.services.repositoryOrigins.read = async () => { throw new Error('origins failed'); };
  await assert.rejects(s.run('commit', { cwd, message: 'Message' }), /origins failed/);
});

test('origins and every worker operation are bounded by kit.withTimeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise(() => {});
  const s = setup();
  s.services.repositoryOrigins.read = never;
  let done = assert.rejects(s.run('commits', { cwd, known: [] }), /did not answer in 15000 ms/);
  t.mock.timers.tick(15_000);
  await done;
  delete s.services.repositoryOrigins;
  s.answers.set('stable-metadata', never);
  done = assert.rejects(s.run('commits', { cwd, known: [] }), refusal(/not in a git repository/));
  t.mock.timers.tick(15_000);
  await done;
  s.answers.set('stable-metadata', { root });
  for (const [op, method, args] of [['commits', 'branch-commits', { known: [] }], ['stage', 'review-summary', { paths: ['a'] }], ['stage', 'apply-review-section-changes', { paths: ['a'] }], ['commit', 'commit', { message: 'Message' }]]) {
    s.answers.set(method, never);
    done = assert.rejects(s.run(op, { cwd, ...args }), /did not answer in 15000 ms/);
    // Root resolution and earlier worker calls settle before the selected worker method starts.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(15_000);
    await done;
    s.answers.delete(method);
  }
});
