// A project's repository in the native provider (breadth step D3; git.mjs): GitRepository and its branches from the app's reads, the
// project's link, branchChanged and statusChanged, and switching and creating branches the app's way. The graph runtime and the feed; the
// test plays framework-main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createGitFeed, gitTypes, repositoryData } from '../git.mjs';
import { createProjectFeed, projectTypes } from '../projects.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user' };

test('repositoryData: the repository\'s state, the current branch\'s ahead and upstream, every branch once', () => {
  const { repo, branches } = repositoryData('p1', { git: true, root: '/r', origin: '/remote.git', branch: 'qa-f3', status: { staged: 0, unstaged: 1, untracked: 2 }, upstream: 'origin/qa-f3', ahead: 1, branches: ['qa-f3', 'main'], defaultBranch: 'main', staged: [] });
  assert.deepEqual(repo.state, { kind: 'git', dirty: true, remotes: [{ name: 'origin', url: '/remote.git' }], staged: [] });
  assert.deepEqual(repo.links.currentBranch, refs.branch('p1', 'qa-f3'));
  assert.deepEqual(branches.map((b) => b.state), [{ name: 'qa-f3', current: true, ahead: 1, upstream: 'origin/qa-f3' }, { name: 'main', current: false }]);
  assert.equal(repositoryData('p1', { git: true, origin: null, branch: null, status: null, branches: [], staged: ['/r/a'] }).repo.state.dirty, true, 'staged files make it dirty when the counts are unknown');
});

async function setup() {
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  let feed = null;
  const handle = graph.registerProvider('native', 'codex', { types: { ...projectTypes(async () => null), ...gitTypes({ run: (...a) => feed.run(...a), create: (...a) => feed.create(...a), branchName: (...a) => feed.branchName(...a), workingChanges: (...a) => feed.workingChanges(...a) }) } });
  const repo = { git: true, root: '/r', origin: '/remote.git', branch: 'main', status: { staged: 0, unstaged: 0, untracked: 0 }, upstream: null, ahead: 0, branches: ['main', 'dev'], defaultBranch: 'main', staged: [] };
  const calls = [];
  let store = null;
  store = createAppProjects({ log: quiet, send: (m) => queueMicrotask(() => {
    calls.push([m.op, m.projectId, m.branch ?? m.scope]);
    const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
    if (m.op === 'working-changes') return done({ ok: true, result: { diff: `diff of ${m.scope}` } });
    if (m.op === 'repository') return done({ ok: true, result: structuredClone(repo) });
    if (m.op === 'switch-branch') { if (m.branch === 'nope') return done({ ok: false, error: 'pathspec did not match', refused: false }); repo.branch = m.branch; return done({ ok: true }); }
    if (m.op === 'create-branch') { repo.branches.push(m.branch); return done({ ok: true }); }
    // framework-main's push: a branch named must be the checkout's as read now
    if (m.op === 'push' && m.branch && m.branch !== repo.branch) return done({ ok: false, refused: true, error: `the checkout is on ${repo.branch}, not ${m.branch}` });
    return done({ ok: true });
  }) });
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  const events = [];
  const emitEvent = (r, name) => { events.push(name); handle.emit(r, name); };
  const projects = createProjectFeed({ handle, appProjects: store, resident, safe: (w, fn) => fn(), emitEvent, relink() {}, threads: () => [], cwdOf: () => null });
  feed = createGitFeed({ handle, graph, appProjects: store, resident, safe: (w, fn) => fn(), emitEvent, log: quiet });
  store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }], selected: null, threads: {}, reset: true });
  await until(() => graph.resolve(refs.repository('p1')), 2000, 'the repository');
  return { graph, repo, calls, events, feed, close() { feed.dispose(); projects.dispose(); store.dispose(); graph.close(); } };
}

test('a project\'s repository and branches; the project links it; switch and create run the app\'s git and are read back', async () => {
  const s = await setup();
  try {
    const r = s.graph.resolve(refs.repository('p1'));
    assert.deepEqual([r.ref.type, r.state.dirty, r.links.currentBranch, r.links.project], ['GitRepository', false, refs.branch('p1', 'main'), refs.project('p1')]);
    assert.deepEqual(s.graph.resolve(refs.project('p1')).links.repository, refs.repository('p1'));
    assert.deepEqual(s.graph.related(refs.repository('p1'), 'branches').map((b) => [b.state.name, b.state.current]).sort(), [['dev', false], ['main', true]]);
    const out = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'switchBranch', args: [refs.branch('p1', 'dev')], caller: user });
    assert.equal(out.status, 'done');
    assert.deepEqual(s.calls.filter(([op]) => op === 'switch-branch'), [['switch-branch', 'p1', 'dev']]);
    assert.deepEqual([s.graph.resolve(refs.repository('p1')).links.currentBranch, s.events], [refs.branch('p1', 'dev'), ['branchChanged']]);
    assert.equal((await s.graph.invoke({ ref: refs.branch('p1', 'main'), operation: 'switch', args: [], caller: user })).status, 'done');
    assert.equal(s.graph.resolve(refs.branch('p1', 'main')).state.current, true);
    const made = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'createBranch', args: ['feature'], caller: user });
    assert.deepEqual([made.status, made.value], ['done', refs.branch('p1', 'feature')]);
    assert.ok(s.graph.resolve(refs.branch('p1', 'feature')));
    const bad = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'switchBranch', args: [refs.branch('p2', 'x')], caller: user });
    assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid'], 'a branch of another repository');
    s.repo.status = { staged: 1, unstaged: 0, untracked: 0 }; s.repo.staged = ['/r/a.txt'];
    await s.graph.invoke({ ref: refs.repository('p1'), operation: 'push', args: [], caller: user });
    assert.deepEqual([s.graph.resolve(refs.repository('p1')).state.staged, s.events.slice(-2)], [['/r/a.txt'], ['statusChanged', 'pushed']], 'read back, then pushed');
    // push(branch): the branch it pushes, which must be the checkout's current one as framework-main reads it just before (built review
    // H6m2b round 2: never as the graph last read it)
    assert.equal((await s.graph.invoke({ ref: refs.repository('p1'), operation: 'push', args: [refs.branch('p1', 'main')], caller: user })).status, 'done');
    assert.deepEqual(s.calls.filter(([op]) => op === 'push').at(-1), ['push', 'p1', 'main'], 'the branch goes to framework-main');
    s.repo.branch = 'dev';   // switched outside the app: the graph has not read it yet
    const other = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'push', args: [refs.branch('p1', 'main')], caller: user });
    assert.deepEqual([other.status, other.message], ['refused', 'the checkout is on dev, not main']);
    s.repo.branch = 'main';
    const foreign = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'push', args: [refs.branch('p2', 'main')], caller: user });
    assert.deepEqual([foreign.status, foreign.reason], ['refused', 'invalid']);
    // its changes as text, the app's review's own patch (unstaged unless named)
    for (const [args, scope] of [[[], 'unstaged'], [['branch'], 'branch']]) {
      const diff = await s.graph.invoke({ ref: refs.repository('p1'), operation: 'workingChanges', args, caller: user });
      assert.deepEqual([diff.value, s.calls.at(-1)], [`diff of ${scope}`, ['working-changes', 'p1', scope]]);
    }
    assert.equal((await s.graph.invoke({ ref: refs.repository('p1'), operation: 'workingChanges', args: ['all'], caller: user })).reason, 'invalid');
  } finally { s.close(); }
});

test('a thread started in a worktree, or that the app attached to one, runs in a WorktreeEnvironment of the project\'s repository; remove', async () => {
  const { harness } = await import('../../../../mux/test/helpers.mjs');
  const { createCodexSource } = await import('../index.mjs');
  const h = await harness();
  const prompts = [];
  const graph = createGraph({ log: quiet, approvals: { ask: async (q) => { prompts.push(q.action); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const asked = [];
  const worktrees = { '/h/worktrees/1/repo': null, '/h/worktrees/2/repo': 'codex/moved' };   // a new worktree starts detached
  let pinned = [];
  const removed = [];
  let store = null;
  store = createAppProjects({ log: quiet, send: (m) => queueMicrotask(() => {
    const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
    if (m.op === 'worktree') { asked.push(m.path); return done({ ok: true, result: m.path in worktrees ? { exists: true, root: m.path, branch: worktrees[m.path], base: 'main' } : { exists: false } }); }
    if (m.op === 'repository') return done({ ok: true, result: { git: false } });
    if (m.op === 'pinned-threads') return done({ ok: true, result: { threadIds: pinned } });
    if (m.op === 'remove-worktree') { removed.push([m.projectId, m.path]); return done({ ok: true }); }
    return done({ ok: true, result: m.op === 'apps' ? { targets: [], approvals: null } : { signedIn: false, environments: [] } });
  }) });
  // framework-main's area operations: the threads area archives a worktree's chats with the app's bookkeeping.
  const areaOps = [];
  let mainOps = null;
  mainOps = createMainOps({ log: quiet, send: (m) => { areaOps.push([m.area, m.op, m.args]); queueMicrotask(() => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result: m.op === 'pinned' ? { threadIds: [] } : {} })); } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, appProjects: store, mainOps });
  try {
    const start = async (cwd) => { const id = (await h.app.request(Math.floor(Math.random() * 1e9), 'thread/start', { cwd })).result.thread.id; await until(() => graph.resolve(refs.thread(id)), 5000, 'the thread'); return id; };
    const wt = await start('/h/worktrees/1/repo'), moved = await start('/h/elsewhere'), local = await start('/r/src');
    store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }], selected: null, threads: { [wt]: { project: 'p1' }, [moved]: { project: 'p1' } }, reset: true });
    const envOf = (id) => graph.resolve(refs.thread(id)).links.environment?.id ?? null;
    await until(() => envOf(local) === 'local:p1', 2000, 'the local thread\'s environment');
    // Started in a new worktree: no attachment, its working directory is the worktree; detached, so no branch and named as the app does.
    await until(() => envOf(wt) === '/h/worktrees/1/repo', 3000, 'the started thread\'s worktree');
    const env = graph.resolve(refs.worktreeEnvironment('/h/worktrees/1/repo'));
    assert.deepEqual([env.state, env.links.project, env.links.branch, env.links.base], [{ name: 'Worktree', status: 'ready', path: '/h/worktrees/1/repo' }, refs.project('p1'), null, refs.branch('p1', 'main')]);
    // Elsewhere and not a worktree: none, until the app attaches the thread to one (a thread moved into a worktree).
    await until(() => asked.includes('/h/elsewhere'), 2000, 'the moved thread asked');
    assert.equal(envOf(moved), null);
    await h.app.request(77, 'fake/attach', { threadId: moved, attachmentType: 'worktree', identityKey: '/h/worktrees/2/repo', payload: { root: '/h/worktrees/2/repo', workspaceRoot: '/h/worktrees/2/repo' } });
    await until(() => envOf(moved) === '/h/worktrees/2/repo', 3000, 'the attached worktree');
    const moved2 = graph.resolve(refs.worktreeEnvironment('/h/worktrees/2/repo'));
    assert.deepEqual([moved2.state.name, moved2.links.branch], ['codex/moved', refs.branch('p1', 'codex/moved')]);
    assert.deepEqual([...asked].sort(), ['/h/elsewhere', '/h/worktrees/1/repo', '/h/worktrees/2/repo']);
    // remove: refused while a chat in it is pinned; else, after the user's yes, its chats archived and the app's delete.
    const wtRef = refs.worktreeEnvironment('/h/worktrees/1/repo');
    pinned = [wt];
    const no = await graph.invoke({ ref: wtRef, operation: 'remove', args: [], caller: { kind: 'mod', id: 'mod.a' } });
    assert.deepEqual([no.status, no.message], ['refused', 'Unpin the chats in this worktree before deleting it']);
    assert.deepEqual(prompts, ['delete the worktree “Worktree” at /h/worktrees/1/repo'], 'asked first');
    pinned = [];
    assert.equal((await graph.invoke({ ref: wtRef, operation: 'remove', args: [], caller: { kind: 'mod', id: 'mod.a' } })).status, 'done');
    assert.deepEqual(removed, [['p1', '/h/worktrees/1/repo']]);
    assert.equal(graph.resolve(wtRef).gone, true);
    await until(() => graph.resolve(refs.thread(wt)).state.archived === true, 3000, 'its chat archived');
    assert.ok(areaOps.some(([area, op, args]) => area === 'threads' && op === 'archive-prepare' && args.threadId === wt && args.cwd === '/h/worktrees/1/repo'), 'archived as Thread.archive does');
    assert.equal(envOf(wt), null);
  } finally { await source.dispose(); graph.close(); store.dispose(); mainOps.dispose(); await h.close(); }
});
