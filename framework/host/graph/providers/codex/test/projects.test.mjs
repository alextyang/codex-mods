// The app's projects in the native provider (breadth step D3; projects.mjs): LocalProject instances, the threads' project links by the
// app's rule (what it records, then the working directory; never the protocol's projectId), the named events, and Project.rename,
// Project.remove and LocalProject.reveal run by the app. The real mux with the strict fake app-server, the graph runtime and the codex source; the test plays framework-main (its
// `projects` reports and its answers to `app-op`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const user = { kind: 'user', id: 'user' };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const REPO = { id: 'p1', name: 'repo', roots: ['/Users/q/repo'], createdAt: 10, updatedAt: 11 };
const SITE = { id: 'p2', name: 'site', roots: ['/Users/q/site', '/Users/q/assets'] };

/** `answer(msg)` plays framework-main's side of an operation: it may report first, then answers (default: ok). */
async function setup({ answer } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-pr-'));
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet });
  graph.registerTypes(NATIVE, 'native');
  await h.up();
  const ops = [];
  let appProjects = null;
  appProjects = createAppProjects({
    log: quiet, timeoutMs: 500,
    send: (m) => { ops.push(m); queueMicrotask(() => (answer ?? ((x) => appProjects.settle({ type: 'app-op-done', requestId: x.requestId, ok: true })))(m, appProjects)); },
  });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, appProjects });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'LocalProject') events.push([e.name, e.ref.id]); });
  return {
    h, graph, source, appProjects, ops, events, dir,
    report: (extra) => appProjects.apply({ type: 'projects', available: true, ...extra }),
    async thread(cwd = '/elsewhere') { const id = (await h.app.request(Math.floor(Math.random() * 1e9), 'thread/start', { cwd })).result.thread.id; await until(() => graph.resolve(refs.thread(id)), 5000, 'the thread'); return id; },
    async close() { await source.dispose(); graph.close(); appProjects.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const projectOf = (s, threadId) => s.graph.resolve(refs.thread(threadId)).links.project?.id ?? null;

test('the app\'s projects are LocalProject instances: name, location and folder from the first root; the first report makes no events', async () => {
  const s = await setup();
  try {
    s.report({ projects: [SITE, REPO, { id: 'p3', name: 'empty', roots: [] }], selected: 'p1', threads: {}, reset: true });
    const site = s.graph.resolve(refs.project('p2'));
    assert.deepEqual([site.ref.type, site.state.name, site.state.location, site.links.folder, site.links.root], ['LocalProject', 'site', '/Users/q/site', refs.folder('/Users/q/site'), refs.folder('/Users/q/site')]);
    assert.equal(s.graph.resolve(refs.project('p3')), null, 'a project without a folder is not put');
    // Each project has its own environment: "This computer", its folder.
    const env = s.graph.resolve(refs.localEnvironment('p2'));
    assert.deepEqual([env.ref.type, env.state.name, env.state.status, env.links.project, env.links.folder], ['LocalEnvironment', 'This computer', 'ready', refs.project('p2'), refs.folder('/Users/q/site')]);
    assert.deepEqual(s.graph.related(refs.project('p2'), 'environments').map((x) => x.ref.id), ['local:p2']);
    assert.equal(s.graph.type('LocalProject').concept, 'Project');
    assert.deepEqual(s.events, []);
    assert.equal(s.graph.can(refs.project('p1'), 'rename'), true);
    assert.equal(s.graph.can(refs.project('p1'), 'reveal'), true);
  } finally { await s.close(); }
});

test('a thread\'s project is the one the app shows it in: put with it, linked again when the app\'s record changes, and Project.threads lists it', async () => {
  const s = await setup();
  try {
    const t1 = await s.thread(), t2 = await s.thread(), t3 = await s.thread('/Users/q/repo/src');
    assert.deepEqual([projectOf(s, t1), projectOf(s, t3)], [null, null], 'nothing before the app\'s projects are known');
    s.report({ projects: [REPO, SITE], selected: null, threads: { [t1]: { project: 'p1' }, 'not-resident': { project: 'p1' } }, reset: true });
    assert.deepEqual([projectOf(s, t1), projectOf(s, t2), projectOf(s, t3)], ['p1', null, 'p1'], 'assigned, none, by its working directory');
    const envOf = (id) => s.graph.resolve(refs.thread(id)).links.environment?.id ?? null;
    assert.deepEqual([envOf(t1), envOf(t3)], [null, 'local:p1'], 'it runs in its project\'s folder only when its working directory is there');
    assert.deepEqual(s.graph.related(refs.localEnvironment('p1'), 'threads').map((x) => x.ref.id), [t3]);
    assert.deepEqual(s.graph.related(refs.project('p1'), 'threads').map((x) => x.ref.id).sort(), [t1, t3].sort());
    s.report({ threads: { [t1]: { project: 'p2' }, [t2]: { root: '/Users/q/assets' }, [t3]: { projectless: true } } });
    assert.deepEqual([projectOf(s, t1), projectOf(s, t2), projectOf(s, t3)], ['p2', 'p2', null]);
    s.report({ threads: { [t2]: null, [t3]: null } });
    assert.deepEqual([projectOf(s, t2), projectOf(s, t3)], [null, 'p1']);
    // Read again from Codex, a thread keeps the app's project (the protocol has none for it).
    await s.source.start();
    assert.deepEqual([projectOf(s, t1), projectOf(s, t2), projectOf(s, t3)], ['p2', null, 'p1']);
    // An assignment to a project the app does not list makes no link until the project comes; a project that goes takes its threads.
    s.report({ threads: { [t2]: { project: 'p9' } } });
    assert.equal(projectOf(s, t2), null);
    s.report({ projects: [REPO, SITE, { id: 'p9', name: 'later', roots: ['/Users/q/later'] }] });
    assert.equal(projectOf(s, t2), 'p9');
    s.report({ projects: [SITE] });
    assert.deepEqual([projectOf(s, t2), projectOf(s, t3)], [null, null], 'their projects went');
    assert.deepEqual([s.graph.resolve(refs.localEnvironment('p1')).gone, envOf(t3)], [true, null], 'and the project\'s environment with it');
    s.report({ projects: [SITE, { ...REPO, roots: ['/Users/q/repo/src'] }] });
    assert.equal(projectOf(s, t3), 'p1', 'a project that came links the threads its root holds');
  } finally { await s.close(); }
});

test('events: added, renamed, opened and removed when the app changes them, none for a reset', async () => {
  const s = await setup();
  try {
    s.report({ projects: [REPO], selected: null, threads: {}, reset: true });
    s.report({ projects: [REPO, SITE] });
    s.report({ projects: [{ ...REPO, name: 'Repo' }, SITE] });
    s.report({ selected: 'p2' });
    s.report({ projects: [{ ...REPO, name: 'Repo' }] });
    assert.deepEqual(s.events, [['added', 'p2'], ['renamed', 'p1'], ['opened', 'p2'], ['removed', 'p2']]);
    assert.equal(s.graph.resolve(refs.project('p2')).gone, true);
    assert.equal(s.graph.resolve(refs.project('p1')).state.name, 'Repo');
    s.report({ projects: [REPO, SITE], selected: 'p1', reset: true });
    assert.equal(s.events.length, 4, 'a reset is a sync');
    assert.equal(s.graph.resolve(refs.project('p2')).state.name, 'site');
  } finally { await s.close(); }
});

test('open, rename, remove and reveal go to the app; the result is in the graph when the operation is done', async () => {
  const s = await setup({
    answer(m, store) {   // framework-main reports what the app changed, then answers
      if (m.op === 'select') store.apply({ type: 'projects', available: true, selected: m.projectId });
      if (m.op === 'rename') store.apply({ type: 'projects', available: true, projects: store.list().map((p) => (p.id === m.projectId ? { ...p, name: m.name } : p)) });
      if (m.op === 'remove') store.apply({ type: 'projects', available: true, projects: store.list().filter((p) => p.id !== m.projectId) });
      store.settle({ type: 'app-op-done', requestId: m.requestId, ok: true });
    },
  });
  try {
    s.report({ projects: [REPO, SITE], selected: null, threads: {}, reset: true });
    const renamed = await s.graph.invoke({ ref: refs.project('p1'), operation: 'rename', args: ['Repo 2'], caller: user, origin: 'test' });
    assert.equal(renamed.status, 'done');
    assert.equal(typeof renamed.intent, 'string', 'an external effect is claimed in the journal');
    assert.equal(s.graph.resolve(refs.project('p1')).state.name, 'Repo 2');
    assert.equal((await s.graph.invoke({ ref: refs.project('p1'), operation: 'open', args: [], caller: user })).status, 'done');
    const revealed = await s.graph.invoke({ ref: refs.project('p2'), operation: 'reveal', args: [], caller: user });
    assert.deepEqual([revealed.status, revealed.intent], ['done', undefined]);
    const removed = await s.graph.invoke({ ref: refs.project('p2'), operation: 'remove', args: [], caller: user });
    assert.equal(removed.status, 'done');
    assert.equal(s.graph.resolve(refs.project('p2')).gone, true);
    assert.deepEqual(s.ops.filter((m) => !['apps', 'cloud-environments', 'repository', 'instructions', 'actions'].includes(m.op)).map((m) => [m.type, m.op, m.projectId, m.name]), [
      ['app-op', 'rename', 'p1', 'Repo 2'], ['app-op', 'select', 'p1', undefined], ['app-op', 'reveal', 'p2', undefined], ['app-op', 'remove', 'p2', undefined],
    ]);
    assert.deepEqual(s.events, [['renamed', 'p1'], ['opened', 'p1'], ['removed', 'p2']]);
  } finally { await s.close(); }
});

test('Thread.moveTo: into a project or out of every project the app\'s way; the thread\'s project has followed when it is done', async () => {
  const s = await setup({
    answer(m, store) {   // framework-main's move: the moved chat's facts reported, then the answer
      if (m.op === 'move-thread') store.apply({ type: 'projects', available: true, threads: { [m.threadId]: m.projectId ? { project: m.projectId } : { projectless: true } } });
      store.settle({ type: 'app-op-done', requestId: m.requestId, ok: true });
    },
  });
  try {
    s.report({ projects: [REPO, SITE], selected: null, threads: {}, reset: true });
    const t = await s.thread('/Users/q/repo');
    assert.equal(projectOf(s, t), 'p1', 'by its working directory');
    assert.equal(s.graph.can(refs.thread(t), 'moveTo'), true);
    const moved = await s.graph.invoke({ ref: refs.thread(t), operation: 'moveTo', args: [refs.project('p2')], caller: user });
    assert.equal(moved.status, 'done');
    assert.equal(projectOf(s, t), 'p2');
    assert.equal((await s.graph.invoke({ ref: refs.thread(t), operation: 'moveTo', args: [], caller: user })).status, 'done');
    assert.equal(projectOf(s, t), null, 'out of every project, though its folder is p1\'s');
    // already where it is asked to be: nothing is sent
    const sent = s.ops.length;
    assert.equal((await s.graph.invoke({ ref: refs.thread(t), operation: 'moveTo', args: [], caller: user })).status, 'done');
    assert.equal(s.ops.length, sent);
    // not one of the app's projects: refused before anything is sent
    const other = await s.graph.invoke({ ref: refs.thread(t), operation: 'moveTo', args: [{ type: 'LocalProject', provider: 'mod.x', id: 'p1' }], caller: user });
    assert.deepEqual([other.status, other.reason], ['refused', 'invalid']);
    assert.deepEqual(s.ops.filter((m) => m.op === 'move-thread').map((m) => [m.projectId, m.threadId]), [['p2', t], [undefined, t]]);
    assert.equal(s.graph.interceptable(refs.thread(t), 'moveTo'), 'graph only', 'the app\'s own move is not held');
  } finally { await s.close(); }
});

test('the provider wires Repository.workingChanges and Project.newTerminal through to framework-main (the real source, not an area alone)', async () => {
  const repo = { git: true, root: '/Users/q/repo', origin: null, branch: 'main', detached: false, status: { staged: 0, unstaged: 1, untracked: 0 }, upstream: null, ahead: 0, branches: ['main'], defaultBranch: 'main', staged: [] };
  const s = await setup({
    answer(m, store) {
      const result = m.op === 'repository' ? repo : m.op === 'working-changes' ? { diff: `D ${m.scope}` } : undefined;
      store.settle({ type: 'app-op-done', requestId: m.requestId, ...(m.op === 'new-terminal' ? { ok: false, refused: true, error: 'no thread is open' } : { ok: true, ...(result ? { result } : {}) }) });
    },
  });
  try {
    s.report({ projects: [REPO], selected: null, threads: {}, reset: true });
    await until(() => s.graph.resolve(refs.repository('p1')), 3000, 'the repository');
    assert.equal((await s.graph.invoke({ ref: refs.repository('p1'), operation: 'workingChanges', args: ['staged'], caller: user })).value, 'D staged');
    const t = await s.graph.invoke({ ref: refs.project('p1'), operation: 'newTerminal', args: [], caller: user });
    assert.deepEqual([t.status, t.message], ['refused', 'no thread is open']);
  } finally { await s.close(); }
});

test('Project.findFiles: the app-server\'s fuzzy search over the project\'s folders, best first, as File and Folder refs', async () => {
  const s = await setup();
  const asked = [];
  const fake = s.h.mux.client('test:files');
  fake.intercept('clientRequest', ['fuzzyFileSearch'], (m) => {
    asked.push(m.params);
    return { respond: { result: { files: [
      { root: '/Users/q/site', path: 'src/app.js', match_type: 'file', file_name: 'app.js', score: 10, indices: null },
      { root: '/Users/q/assets', path: 'app', match_type: 'directory', file_name: 'app', score: 30, indices: null },
      { root: '/Users/q/site', path: 'apple.txt', match_type: 'file', file_name: 'apple.txt', score: 20, indices: null },
      { root: '/Users/q/site', path: '.git/hooks/apply.sample', match_type: 'file', file_name: 'apply.sample', score: 40, indices: null },
    ] } } };
  });
  try {
    s.report({ projects: [SITE], selected: null, threads: {}, reset: true });
    const r = await s.graph.invoke({ ref: refs.project('p2'), operation: 'findFiles', args: ['app'], caller: user });
    assert.deepEqual(r.value, [refs.folder('/Users/q/assets/app'), refs.file('/Users/q/site/apple.txt'), refs.file('/Users/q/site/src/app.js')]);
    assert.deepEqual(asked, [{ query: 'app', roots: ['/Users/q/site', '/Users/q/assets'], cancellationToken: null }], 'every root of the project');
    assert.equal((await s.graph.invoke({ ref: refs.project('p2'), operation: 'findFiles', args: ['app', { limit: 1 }], caller: user })).value.length, 1);
    for (const args of [[''], ['x'.repeat(201)], ['app', { limit: 0 }]]) assert.equal((await s.graph.invoke({ ref: refs.project('p2'), operation: 'findFiles', args, caller: user })).reason, 'invalid');
  } finally { fake.dispose?.(); await s.close(); }
});

test('refusals and failures: no store, the app refusing, the app failing, no answer at all', async () => {
  let mode = 'refuse';
  const s = await setup({
    answer(m, store) {
      if (mode === 'silent') return;
      store.settle({ type: 'app-op-done', requestId: m.requestId, ok: false, error: mode === 'refuse' ? 'the app has no such project' : 'disk full', refused: mode === 'refuse' });
    },
  });
  try {
    s.report({ projects: [REPO], selected: null, threads: {}, reset: true });
    const refused = await s.graph.invoke({ ref: refs.project('p1'), operation: 'rename', args: ['x'], caller: user });
    assert.deepEqual([refused.status, refused.reason, refused.message], ['refused', 'unavailable', 'the app has no such project']);
    mode = 'fail';
    const failed = await s.graph.invoke({ ref: refs.project('p1'), operation: 'remove', args: [], caller: user });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /disk full/);
    mode = 'silent';
    const silent = await s.graph.invoke({ ref: refs.project('p1'), operation: 'reveal', args: [], caller: user });
    assert.equal(silent.status, 'failed');
    assert.match(silent.error.message, /did not answer in 500 ms/);
    // Without a store nothing is sent, and the projects the Host knew stay.
    s.appProjects.apply({ type: 'projects', available: false });
    const n = s.ops.length;
    const off = await s.graph.invoke({ ref: refs.project('p1'), operation: 'rename', args: ['y'], caller: user });
    assert.deepEqual([off.status, off.reason], ['refused', 'unavailable']);
    assert.equal(s.ops.length, n);
    assert.equal(s.graph.resolve(refs.project('p1')).state.name, 'repo');
    await sleep(10);
  } finally { await s.close(); }
});

test('E8.9: App.addProject adds a folder the app\'s own way; its result is the Project the app then reports; a folder already a project, or a relative path, is refused', async () => {
  const s = await setup({ answer: (m, ap) => {
    if (m.op === 'add') ap.apply({ type: 'projects', available: true, projects: [REPO, { id: 'p9', name: 'new', roots: [m.path] }], selected: 'p1', threads: {}, reset: true });
    ap.settle({ type: 'app-op-done', requestId: m.requestId, ok: true, result: { folder: m.path, id: null } });
  } });
  try {
    s.report({ projects: [REPO], selected: 'p1', threads: {}, reset: true });
    await until(() => s.graph.resolve(refs.project('p1')), 2000, 'the project');
    const app = { type: 'App', provider: 'codex', id: 'codex' };
    s.source.provider.put(app, { state: { version: '1' }, links: { theme: { type: 'Theme', provider: 'codex', id: 'codex' } } });
    const out = await s.graph.invoke({ ref: app, operation: 'addProject', args: [{ path: '/Users/q/new/', name: 'new' }], caller: user });
    assert.equal(out.status, 'done', JSON.stringify(out));
    assert.deepEqual(out.value, refs.project('p9'));
    assert.deepEqual(s.ops.filter((m) => m.op === 'add').map((m) => [m.path, m.name]), [['/Users/q/new', 'new']]);
    assert.equal((await s.graph.invoke({ ref: app, operation: 'addProject', args: [{ path: '/Users/q/repo' }], caller: user })).reason, 'invalid', 'already a project');
    assert.equal((await s.graph.invoke({ ref: app, operation: 'addProject', args: [{ path: 'relative' }], caller: user })).reason, 'invalid');
    // E8 review 3: a path the app stores normalized is found by its normal form (`/x/./b/.` is `/x/b`), and is already a project when it is
    assert.equal((await s.graph.invoke({ ref: app, operation: 'addProject', args: [{ path: '/Users/q/./repo/.' }], caller: user })).reason, 'invalid', 'already a project (normalized)');
    const other = await s.graph.invoke({ ref: app, operation: 'addProject', args: [{ path: '/Users/q/x/../other/.' }], caller: user });
    assert.equal(other.status, 'done', JSON.stringify(other));
    assert.equal(s.ops.filter((m) => m.op === 'add').at(-1).path, '/Users/q/other');
  } finally { await s.close(); }
});
