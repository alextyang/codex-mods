// History through the real graph, codex source, mux and fake app-server. The test answers framework-main's area and repository channels;
// ChangeSet/FileChange rows come from the changes area's producer. No native app, real git repository or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as history from '../areas/history.mjs';
import { changeSetData } from '../areas/changes.mjs';
import { produced } from './areas/history.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user' }, mod = { kind: 'mod', id: 'mod.a' };
const projectId = 'p:one', cwd = '/repo/subfolder', root = '/repo';
const row = (sha, day, extra = {}) => ({ sha, message: ` ${sha} subject\n\nBody\n`, committedAt: `2026-10-${day}T12:00:00Z`, files: 3, author: `Author ${sha}`, ...extra });
const initial = () => [row('a', 24), row('b', 23)];
const success = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const no = (r, reason) => { assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason); };

async function setup({ main = true, git = true, initialRows = initial() } = {}) {
  const h = await harness(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-history-'));
  const prompts = [], events = [], ops = [], calls = [], warnings = [], answers = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  let clock = 100_000, feed, context, sequence = 7000, approved = true, rows = structuredClone(initialRows), counter = 0;
  const repo = { git, root, origin: '/remote.git', branch: 'work', status: { staged: 0, unstaged: 2, untracked: 1 }, staged: [], branches: ['work', 'main'], defaultBranch: 'main', ahead: 2, upstream: null };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, now: () => clock,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let appProjects;
  appProjects = createAppProjects({ log, send: (m) => {
    calls.push([m.op, m.projectId]);
    queueMicrotask(() => appProjects.settle({ type: 'app-op-done', requestId: m.requestId, ok: true,
      result: m.op === 'repository' ? structuredClone(m.projectId === projectId ? repo : { git: false }) : m.op === 'apps' ? { targets: [], approvals: null } : {} }));
  } });
  appProjects.apply({ type: 'projects', available: true, reset: true, projects: [{ id: projectId, name: 'Repo', roots: [cwd] }, { id: 'no-git', name: 'Other', roots: ['/plain'] }], threads: {}, selected: null });
  let mainOps;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'history');
    ops.push([m.op, m.args]); calls.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          const value = typeof answer === 'function' ? await answer(m.args) : answer;
          mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...value });
          return;
        }
        let result;
        if (m.op === 'commits') result = { root, commits: rows.map((c) => {
          const { author, files, ...rest } = c;
          return m.args.known.includes(c.sha) ? rest : { ...rest, author, files };
        }) };
        else if (m.op === 'staged-elsewhere') result = repo.staged.map((f) => path.relative(root, f)).filter((p) => !m.args.paths.includes(p));
        else if (m.op === 'stage' || m.op === 'unstage') {
          const selected = m.args.paths.map((p) => path.join(root, p));
          repo.staged = m.op === 'stage' ? [...new Set([...repo.staged, ...selected])] : repo.staged.filter((p) => !selected.includes(p));
          repo.status.staged = repo.staged.length;
          result = {};
        } else if (m.op === 'commit') {
          const commitSha = `made-${++counter}`;
          rows.unshift(row(commitSha, 25, { message: m.args.message }));
          repo.staged = []; repo.status.staged = 0;
          result = { commitSha };
        } else throw new Error(`unexpected ${m.op}`);
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...history, createFeed(ctx) { context = ctx; feed = history.createFeed(ctx); return feed; } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now: () => clock, appProjects, mainOps, areas: { history: area } });
  graph.onEvent((e) => { if (e.kind === 'event' && ['GitRepository', 'ChangeSet'].includes(e.ref.type)) events.push([e.ref, e.name]); });
  await source.start();
  if (git) await until(() => graph.resolve(refs.repository(projectId)), 3000, 'the repository');
  await feed.start();
  const ask = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const threadId = (await ask('thread/start', { cwd })).thread.id;
  await ask('thread/name/set', { threadId, name: 'Chat' });
  await until(() => graph.resolve(refs.thread(threadId))?.state.title === 'Chat', 3000, 'the thread');
  return {
    graph, source, feed, context, repo, h, appProjects, mainOps, prompts, events, ops, calls, warnings, answers, threadId,
    instance: (sha) => graph.resolve(refs.commit(projectId, sha)),
    invoke: (ref, operation, args = [], caller = user) => graph.invoke({ ref, operation, args, caller }),
    replace: (next) => { rows = structuredClone(next); },
    clock: (value) => { clock = value; },
    approve: (value) => { approved = value; },
    putSet(paths, scope = 'turn', id = 'u') {
      const data = changeSetData(scope, scope === 'thread' ? threadId : id, paths.map((p) => ({ threadId, turnId: id, cwd,
        change: { path: p, kind: { type: 'add' }, diff: 'new\n' } })));
      for (const d of [data.changeSet, ...data.files, ...data.hunks]) context.handle.put(d.ref, { state: d.state, links: d.links });
      return data.changeSet.ref;
    },
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); appProjects.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const reads = (s) => s.ops.filter(([op]) => op === 'commits');
const repository = refs.repository(projectId);

test('commitData and samples trim only the message, parse time, default unknown facts and include all links', () => {
  const [a, b] = produced();
  assert.deepEqual(a, { ref: refs.commit('p', 'a'), state: { id: 'a', message: 'First\n\nBody', author: 'Alex', time: Date.parse('2026-10-25T12:00:00Z'), files: 2 },
    links: { repository: refs.repository('p'), branch: refs.branch('p', 'work'), thread: refs.thread('t') } });
  assert.deepEqual(b.state, { id: 'b', message: 'Second', author: '', time: Date.parse('2026-10-24T12:00:00Z'), files: 0 });
  assert.deepEqual(b.links, { repository: refs.repository('p'), branch: null, thread: null });
  assert.equal(history.commitData('p', row('x', 25, { author: null, files: null }), { branch: null, thread: null }).state.author, '');
});

test('sync lists Commit instances and repository inverses; later top commits emit once, known facts persist, and absent commits go', async () => {
  const s = await setup();
  try {
    assert.deepEqual(reads(s)[0], ['commits', { cwd, known: [] }]);
    assert.deepEqual(s.instance('a').state, { id: 'a', message: 'a subject\n\nBody', author: 'Author a', files: 3, time: Date.parse(initial()[0].committedAt) });
    assert.deepEqual(s.instance('a').links, { repository, branch: refs.branch(projectId, 'work'), thread: null });
    assert.deepEqual(s.graph.related(repository, 'commits').map((c) => c.state.id), ['a', 'b']);
    assert.equal(s.graph.can(refs.commit(projectId, 'a'), 'open'), false);
    assert.deepEqual(s.events, []);
    s.replace([row('c', 25), row('a', 24, { author: 'must stay cached', files: 99 }), row('b', 23)]);
    await s.feed.read(projectId);
    assert.deepEqual(reads(s).at(-1), ['commits', { cwd, known: ['a', 'b'] }]);
    assert.deepEqual([s.instance('a').state.author, s.instance('a').state.files], ['Author a', 3]);
    assert.deepEqual(s.events, [[repository, 'committed']]);
    await s.feed.read(projectId);
    assert.deepEqual(s.events, [[repository, 'committed']]);
    s.repo.branch = 'main'; await s.context.readRepository(projectId);
    s.replace([row('older', 22), row('a', 24)]);
    await s.feed.read(projectId);
    assert.equal(s.instance('c').gone, true);
    assert.equal(s.instance('b').gone, true);
    assert.deepEqual(s.instance('a').links.branch, refs.branch(projectId, 'main'));
    assert.equal(s.events.filter(([, name]) => name === 'committed').length, 1, 'an older newly listed top is a sync');
    s.replace([]); await s.feed.read(projectId);
    assert.deepEqual(s.graph.related(repository, 'commits'), []);
    s.replace([row('fresh', 25)]); await s.feed.read(projectId);
    assert.deepEqual(s.events.at(-1), [repository, 'committed']);
    assert.deepEqual(s.warnings, []);
  } finally { await s.close(); }
});

test('Repository.commit with and without paths refreshes the repository then history and emits committed once', async () => {
  const s = await setup();
  try {
    for (const args of [[' \nMessage\n\nBody \n '], ['Selected', ['a', 'dir/b']]]) {
      s.calls.length = 0; s.events.length = 0;
      const ref = success(await s.invoke(repository, 'commit', args));
      assert.deepEqual(s.calls.map(([op]) => op), ['commit', 'repository', 'commits']);
      assert.deepEqual(s.calls[0], ['commit', { cwd, message: args[0].trim(), ...(args[1] ? { paths: args[1] } : {}) }]);
      assert.deepEqual(ref, refs.commit(projectId, ref.id.slice(ref.id.lastIndexOf(':') + 1)));
      assert.equal(s.graph.resolve(ref).state.message, args[0].trim());
      assert.deepEqual(s.graph.resolve(ref).links.thread, null);
      assert.deepEqual(s.events, [[repository, 'committed']]);
    }
    assert.deepEqual(s.prompts, [], 'a user caller never asks R17');
  } finally { await s.close(); }
});

test('stage and unstage pass repository-relative files, read repository status again and read history', async () => {
  const s = await setup();
  try {
    for (const op of ['stage', 'unstage']) {
      s.calls.length = 0;
      success(await s.invoke(repository, op, [['a', 'dir/b']]));
      assert.deepEqual(s.calls.map(([name]) => name), [op, 'repository', 'commits']);
      assert.deepEqual(s.calls[0], [op, { cwd, paths: ['a', 'dir/b'] }]);
      assert.deepEqual(s.graph.resolve(repository).state.staged, op === 'stage' ? ['/repo/a', '/repo/dir/b'] : []);
    }
    assert.deepEqual(s.events, [[repository, 'statusChanged'], [repository, 'statusChanged']]);
  } finally { await s.close(); }
});

test('ChangeSet.commit converts absolute files against the last root, checks other staging, refreshes and remembers its thread', async () => {
  const s = await setup();
  try {
    for (const scope of ['turn', 'thread']) {
      const set = s.putSet(['/repo/a', 'dir/b:c'], scope);
      s.calls.length = 0; s.events.length = 0;
      const ref = success(await s.invoke(set, 'commit', ['Changes']));
      assert.deepEqual(s.calls.map(([op]) => op), ['staged-elsewhere', 'commit', 'repository', 'commits']);
      assert.deepEqual(s.calls.slice(0, 2), [['staged-elsewhere', { cwd, paths: ['a', 'dir/b:c'] }], ['commit', { cwd, message: 'Changes', paths: ['a', 'dir/b:c'] }]]);
      assert.deepEqual(s.graph.resolve(ref).links, { repository, branch: refs.branch(projectId, 'work'), thread: refs.thread(s.threadId) });
      assert.deepEqual(s.events, [[repository, 'committed'], [set, 'committed']]);
      await s.feed.read(projectId);
      assert.deepEqual(s.graph.resolve(ref).links.thread, refs.thread(s.threadId));
    }
  } finally { await s.close(); }
});

test('R17 describes repository commits, staging and turn/thread commits; user callers do not ask; a denied mod makes no write', async () => {
  const s = await setup();
  try {
    const turn = s.putSet(['a']), thread = s.putSet(['a'], 'thread');
    for (const [ref, op, args] of [[repository, 'commit', ['Message\nBody']], [repository, 'commit', ['Selected', ['a', 'b']]],
      [repository, 'stage', [['a']]], [repository, 'unstage', [['a']]], [turn, 'commit', ['Turn']], [thread, 'commit', ['Thread']]]) {
      success(await s.invoke(ref, op, args, mod));
    }
    const detail = (message) => `It makes a git commit in ${root} with the message “${message}”.`;
    assert.deepEqual(s.prompts, [
      { action: 'commit the changes in “Repo”', detail: detail('Message') },
      { action: 'commit 2 files in “Repo”', detail: detail('Selected') },
      { action: 'stage 1 files in “Repo”', detail: `It changes what the next commit in ${root} takes.` },
      { action: 'unstage 1 files in “Repo”', detail: `It changes what the next commit in ${root} takes.` },
      { action: 'commit the changes of a turn in “Chat”', detail: detail('Turn') },
      { action: 'commit the changes of “Chat”', detail: detail('Thread') },
    ]);
    s.approve(false);
    const before = s.ops.length;
    no(await s.invoke(repository, 'commit', ['Declined'], mod), 'notAllowed');
    assert.equal(s.ops.length, before);
    success(await s.invoke(repository, 'commit', ['User']));
    assert.equal(s.prompts.length, 7);
  } finally { await s.close(); }
});

test('missing/blank messages and invalid file selections refuse before approval or main calls', async () => {
  const s = await setup();
  try {
    const set = s.putSet(['a']), before = s.ops.length;
    for (const ref of [repository, set]) for (const args of [[], [''], [' \n ']]) no(await s.invoke(ref, 'commit', args, mod), 'unsupported');
    for (const files of [null, 'a', [], [1], [''], ['/repo/a'], ['../a'], Array(501).fill('a')]) {
      for (const op of ['stage', 'unstage']) no(await s.invoke(repository, op, [files], mod), 'invalid');
      no(await s.invoke(repository, 'commit', ['Message', files], mod), 'invalid');
    }
    no(await s.invoke(repository, 'commit', ['x'.repeat(20_001)], mod), 'invalid');
    assert.equal(s.ops.length, before);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('ChangeSet.commit refuses other staged changes, files outside the root, a projectless thread and a missing repository', async () => {
  const s = await setup();
  try {
    const set = s.putSet(['a']);
    s.repo.staged = ['/repo/other']; await s.context.readRepository(projectId);
    const before = s.ops.length;
    const out = await s.invoke(set, 'commit', ['Changes'], mod);
    no(out, 'unavailable');
    assert.equal(out.message, 'other changes are staged: commit or unstage them first');
    assert.deepEqual(s.ops.slice(before), [], 'the resident staged selection already refuses the call');
    assert.deepEqual(s.prompts, []);
    s.repo.staged = []; await s.context.readRepository(projectId);
    s.answers.set('staged-elsewhere', { ok: true, result: ['other'] });
    no(await s.invoke(set, 'commit', ['Fresh index']), 'unavailable');
    assert.deepEqual(s.ops.at(-1), ['staged-elsewhere', { cwd, paths: ['a'] }]);
    s.answers.delete('staged-elsewhere');
    s.repo.staged = ['/repo/a']; await s.context.readRepository(projectId);
    success(await s.invoke(set, 'commit', ['Only this set']));
    const outside = s.putSet(['/repository/a'], 'turn', 'outside');
    const count = s.ops.length;
    no(await s.invoke(outside, 'commit', ['Outside'], mod), 'unavailable');
    assert.equal(s.ops.length, count);
    s.context.handle.update(refs.thread(s.threadId), { links: { project: null } });
    no(await s.invoke(set, 'commit', ['No project'], mod), 'unavailable');
    s.context.handle.update(refs.thread(s.threadId), { links: { project: refs.project(projectId) } });
    s.context.handle.remove(repository);
    no(await s.invoke(set, 'commit', ['No repository'], mod), 'unavailable');
    assert.equal(s.ops.length, count);
  } finally { await s.close(); }
});

test('a repository without a resident LocalProject refuses without approval or a call', async () => {
  const s = await setup();
  try {
    s.context.handle.remove(refs.project(projectId));
    const count = s.ops.length;
    for (const [op, args] of [['commit', ['Message']], ['stage', [['a']]], ['unstage', [['a']]]]) no(await s.invoke(repository, op, args, mod), 'unavailable');
    assert.equal(s.ops.length, count);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('main refusals become unavailable and failures throw; reads after operations preserve instances on read failure', async () => {
  const s = await setup();
  try {
    const set = s.putSet(['a']);
    for (const [ref, op, args, mainOp] of [[repository, 'stage', [['a']], 'stage'], [repository, 'unstage', [['a']], 'unstage'],
      [repository, 'commit', ['Message'], 'commit'], [set, 'commit', ['Changes'], 'staged-elsewhere']]) {
      for (const refused of [true, false]) {
        s.answers.set(mainOp, { ok: false, refused, error: 'worker said no' });
        const r = await s.invoke(ref, op, args);
        assert.equal(r.status, refused ? 'refused' : 'failed');
        assert.equal(refused ? r.message : r.error.message, 'worker said no');
        if (refused) assert.equal(r.reason, 'unavailable');
      }
      s.answers.delete(mainOp);
    }
    const before = s.graph.list('Commit');
    for (const refused of [true, false]) {
      s.answers.set('commits', { ok: false, refused, error: 'read failed' });
      await s.feed.read(projectId);
      assert.deepEqual(s.graph.list('Commit'), before);
    }
    assert.equal(s.warnings.length, 2);
    success(await s.invoke(repository, 'stage', [['a']]));
    assert.equal(s.graph.resolve(repository).state.staged[0], '/repo/a');
    assert.deepEqual(s.graph.list('Commit'), before, 'a read failure does not undo a successful mutation');
  } finally { await s.close(); }
});

test('ChangeSet.commit reads its root first when history has not yet been read; approval falls back to the folder', async () => {
  const s = await setup({ git: false });
  try {
    s.repo.git = true; await s.context.readRepository(projectId);
    const set = s.putSet(['/repo/a']);
    const count = s.ops.length;
    const ref = success(await s.invoke(set, 'commit', ['Changes'], mod));
    assert.deepEqual(s.ops.slice(count).map(([op]) => op), ['commits', 'staged-elsewhere', 'commit', 'commits']);
    assert.deepEqual(s.graph.resolve(ref).links.thread, refs.thread(s.threadId));
    assert.deepEqual(s.prompts, [{ action: 'commit the changes of a turn in “Chat”', detail: `It makes a git commit in ${cwd} with the message “Changes”.` }], 'an unknown root cannot bypass R17');
    const fresh = 'new-project';
    s.context.handle.put(refs.project(fresh), { state: { name: 'New', location: '/new' }, links: { folder: refs.folder('/new'), root: refs.folder('/new') } });
    s.context.handle.put(refs.repository(fresh), { state: { kind: 'git', dirty: false, remotes: [], staged: [] }, links: { project: refs.project(fresh), currentBranch: null } });
    const prompt = s.feed.prompt('commit', s.graph.resolve(refs.repository(fresh)), ['First']);
    assert.equal(prompt.detail, 'It makes a git commit in /new with the message “First”.');
  } finally { await s.close(); }
});

test('read coalesces per project; observe shares a running read and refreshes after 30 seconds, using the last colon of a Commit id', async () => {
  const s = await setup();
  let release;
  try {
    assert.equal(s.feed.observe(refs.agent(), 'CodexAgent'), undefined);
    let count = reads(s).length;
    await s.feed.observe(refs.commit(projectId, 'a'), 'Commit');
    s.clock(130_000); await s.feed.observe(refs.commit(projectId, 'a'), 'Commit');
    assert.equal(reads(s).length, count);
    s.clock(130_001); await s.feed.observe(refs.commit(projectId, 'a'), 'Commit');
    assert.equal(reads(s).length, ++count);
    let active = 0, peak = 0, held = false;
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('commits', async () => {
      active++; peak = Math.max(peak, active);
      if (!held) { held = true; await gate; }
      active--;
      return { ok: true, result: { root, commits: initial() } };
    });
    const running = s.feed.read(projectId);
    assert.equal(s.feed.observe(refs.commit(projectId, 'a'), 'Commit'), running);
    assert.equal(s.feed.read(projectId), running);
    assert.equal(s.feed.read(projectId), running);
    release(); await running;
    assert.equal(reads(s).length, count + 2);
    assert.equal(peak, 1);
    s.answers.delete('commits');
    count = reads(s).length;
    const view = s.graph.subscribe({ ref: refs.commit(projectId, 'a') }, () => {});
    await view.loaded;
    view.dispose();
    assert.equal(reads(s).length, count);
    await s.feed.read('no-git');
    assert.equal(reads(s).length, count);
  } finally { release?.(); await s.close(); }
});

test('start and serverUp read resident repositories; a 60-second unref timer refreshes and disposal clears it', async (t) => {
  const s = await setup();
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const extra = history.createFeed(s.context);
    let count = reads(s).length;
    await extra.start();
    assert.equal(reads(s).length, ++count);
    await extra.serverUp();
    assert.equal(reads(s).length, ++count);
    t.mock.timers.tick(59_999);
    assert.equal(reads(s).length, count);
    t.mock.timers.tick(1);
    await extra.observe(refs.commit(projectId, 'a'), 'Commit');
    assert.equal(reads(s).length, ++count);
    extra.dispose();
    t.mock.timers.tick(60_000);
    assert.equal(reads(s).length, count);
  } finally { await s.close(); }
});

test('server-down operations refuse without approval; ready reads again; disposed in-flight reads put nothing', async () => {
  const s = await setup();
  let release;
  try {
    const set = s.putSet(['a']), count = s.ops.length;
    s.h.bus.publish('appServer/exited', { reason: 'crash' });
    for (const [ref, op, args] of [[repository, 'commit', ['Message']], [repository, 'stage', [['a']]], [repository, 'unstage', [['a']]], [set, 'commit', ['Changes']]]) {
      no(await s.invoke(ref, op, args, mod), s.context.DOWN.reason);
    }
    await s.feed.read(projectId);
    assert.equal(s.ops.length, count); assert.deepEqual(s.prompts, []);
    s.h.bus.publish('appServer/ready', {});
    await until(() => s.ops.length > count, 3000, 'ready reads history');
    await s.feed.observe(refs.commit(projectId, 'a'), 'Commit');
    const before = s.graph.list('Commit');
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('commits', async () => { await gate; return { ok: true, result: { root, commits: [row('late', 25)] } }; });
    const running = s.feed.read(projectId);
    s.feed.dispose(); release(); await running;
    assert.deepEqual(s.graph.list('Commit'), before);
  } finally { release?.(); await s.close(); }
});

test('without framework-main reads log and leave history absent, and operations refuse unavailable', async () => {
  const s = await setup({ main: false });
  try {
    assert.deepEqual(s.graph.list('Commit'), []);
    assert.ok(s.warnings.length >= 1);
    no(await s.invoke(repository, 'commit', ['Message']), 'unavailable');
    no(await s.invoke(repository, 'stage', [['a']]), 'unavailable');
    const set = s.putSet(['/repo/a']);
    no(await s.invoke(set, 'commit', ['Changes']), 'unavailable');
  } finally { await s.close(); }
});
