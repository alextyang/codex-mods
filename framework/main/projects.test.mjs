// framework-main's projects module (projects.cjs) against a fake AppHost whose `projects` service behaves like the app's projects manager (21477:
// getLocalProjects() reads `local-projects` of its `globalState`; the store's `onDidChange(key, fn)` returns the unsubscribe and every write calls
// the key's listeners; renameLocal({projectId, name}) and removeLocal(projectId) write the store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { installAppHost } = require('./apphost.cjs');
const { createProjects, register, KEYS } = require('./projects.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3);
  }
}
const quiet = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]), error: (m, d) => lines.push(['error', m, d]) }; };

const P1 = { id: 'p1', name: 'repo', rootPaths: ['/Users/q/repo'], createdAt: 10, updatedAt: 11 };
const P2 = { id: 'p2', name: 'site', rootPaths: ['/Users/q/site', '/Users/q/site-assets'], createdAt: 20, updatedAt: 20 };

/** The app's global state store and its projects manager (one for the app; every window's AppHost exports the same manager). */
function fakeApp(initial = {}) {
  const state = new Map(Object.entries({
    'local-projects': { p1: P1, p2: P2 },
    'project-order': ['p2', 'p1'],
    'selected-project': { type: 'local', projectId: 'p1' },
    'thread-project-assignments': { t1: { projectKind: 'local', projectId: 'p1' }, t2: { projectKind: 'local', projectId: 'p2' }, t3: { projectKind: 'remote', projectId: 'r1', hostId: 'h' } },
    'projectless-thread-ids': ['t5', 't1'],
    'thread-workspace-root-hints': { t6: '/Users/q/repo' },
    ...initial,
  }));
  const listeners = new Map();
  const store = {
    get: (k) => state.get(k) ?? null,
    onDidChange(k, fn) { const set = listeners.get(k) ?? new Set(); set.add(fn); listeners.set(k, set); return () => set.delete(fn); },
    set(k, v) { state.set(k, v); for (const fn of listeners.get(k) ?? []) fn(); },
  };
  /** The app's file service (21477 `workspaceFiles`): a tiny tree under /Users/q/repo. */
  const tree = { '/Users/q/repo': ['src/', 'a.txt', '.hidden'], '/Users/q/repo/src': ['main.js'] };
  const sizes = { '/Users/q/repo/a.txt': 5, '/Users/q/repo/src/main.js': 12 };
  const files = {
    async listDirectory(req) {
      app.calls.push(['listDirectory', req]);
      const abs = req.directoryPath ? `${req.workspaceRoot}/${req.directoryPath}` : req.workspaceRoot;
      const names = tree[abs];
      if (!names) throw Object.assign(new Error(`ENOENT: no such directory ${abs}`), { code: 'ENOENT' });
      const entries = names.filter((n) => req.includeHidden || !n.startsWith('.')).map((n) => {
        const dir = n.endsWith('/'), name = dir ? n.slice(0, -1) : n;
        return { isSymlink: false, name, path: req.directoryPath ? `${req.directoryPath}/${name}` : name, type: dir ? 'directory' : 'file' };
      });
      return { workspaceRoot: req.workspaceRoot, directoryPath: req.directoryPath, parentPath: null, entries };
    },
    async inspect(req) {
      app.calls.push(['inspect', req]);
      if (!(req.path in sizes)) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${req.path}'`), { code: 'ENOENT' });
      return { contentKind: 'text', createdAtMs: 1.5, isFile: true, mtimeMs: 1000.4, sizeBytes: sizes[req.path] };
    },
  };
  const actions = {
    async runInPrimaryWindow(req) {
      app.calls.push(['runInPrimaryWindow', req]);
      if (!app.threadShown) throw new Error('windows.tabs.open requires a visible thread');
      return { threadId: 't1', type: 'file', placement: 'right', status: 'opened', viewer: 'textFileEditor' };
    },
  };
  const app = {
    state, store, listeners, calls: [], files, actions, threadShown: true,
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    manager: {
      globalState: store,
      getLocalProjects: () => store.get('local-projects') ?? {},
      async renameLocal(req) {
        app.calls.push(['renameLocal', req]);
        if (app.hang) await new Promise(() => {});
        const p = store.get('local-projects')[req.projectId];
        if (p) store.set('local-projects', { ...store.get('local-projects'), [req.projectId]: { ...p, name: req.name } });
      },
      /** Opening a folder that is already a project selects it (21477: `selected-project`). */
      async createOrSelectLocalProjects(roots) {
        app.calls.push(['createOrSelectLocalProjects', roots]);
        const p = Object.values(store.get('local-projects')).find((x) => x.rootPaths[0] === roots[0]);
        if (p) store.set('selected-project', { type: 'local', projectId: p.id });
        return p ? [p] : [];
      },
      /** "Add new project" (21477: the app asks to trust a new folder, then adds it). */
      async createLocal(req) {
        app.calls.push(['createLocal', req]);
        const id = `p-${req.name}`;
        store.set('local-projects', { ...store.get('local-projects'), [id]: { id, name: req.name, rootPaths: req.sources, createdAt: 30, updatedAt: 30 } });
        return { id };
      },
      async removeLocal(id) {
        app.calls.push(['removeLocal', id]);
        const { [id]: _gone, ...rest } = store.get('local-projects');
        store.set('local-projects', rest);
        store.set('project-order', store.get('project-order').filter((x) => x !== id));
        const a = { ...store.get('thread-project-assignments') };
        for (const [t, v] of Object.entries(a)) if (v.projectId === id) delete a[t];
        store.set('thread-project-assignments', a);
        return { previousMemberships: [] };
      },
    },
  };
  return app;
}
function sender(id) {
  const s = { id, handlers: [], destroyed: false, once(ev, fn) { if (ev === 'destroyed') s.handlers.push(fn); }, isDestroyed: () => s.destroyed,
    destroy() { s.destroyed = true; for (const fn of s.handlers.splice(0)) fn(); } };
  return s;
}
function setup(app = fakeApp(), opts = {}) {
  const g = {};
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  const sent = [];
  const revealed = [];
  const pr = createProjects({ appHost: hold, send: (m) => sent.push(structuredClone(m)), log, debounceMs: 8, revealPath: (p) => revealed.push(p), ...opts });
  const windows = new Map();
  const t = {
    app, hold, pr, sent, log, revealed,
    open(id, services) { const s = sender(id); windows.set(id, s); g.__codexmods.appHost({ services: services ?? { projects: app.manager, workspaceFiles: app.files, appActions: app.actions } }, s); return s; },
    close(id) { windows.get(id).destroy(); },
    reports: () => sent.filter((m) => m.type === 'projects'),
    last: () => t.reports().at(-1),
    answers: () => sent.filter((m) => m.type === 'app-op-done'),
    dispose() { pr.dispose(); hold.dispose(); },
  };
  return t;
}
const THREADS = { t1: { project: 'p1', projectless: true }, t2: { project: 'p2' }, t3: { other: true }, t5: { projectless: true }, t6: { root: '/Users/q/repo' } };
const PROJECTS = [
  { id: 'p2', name: 'site', roots: ['/Users/q/site', '/Users/q/site-assets'], createdAt: 20, updatedAt: 20 },
  { id: 'p1', name: 'repo', roots: ['/Users/q/repo'], createdAt: 10, updatedAt: 11 },
];

test('the first window\'s store is held: one report with everything, in the sidebar\'s order, and each thread\'s facts', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1, 2000, 'the first report');
    assert.deepEqual(t.reports(), [{ type: 'projects', available: true, projects: PROJECTS, selected: 'p1', threads: THREADS, reset: true }]);
    assert.equal(t.app.listening(), KEYS.length);
    await sleep(40);
    assert.equal(t.reports().length, 1, 'nothing more while nothing changes');
    t.open(2);
    await sleep(40);
    assert.equal(t.app.listening(), KEYS.length, 'a second window adds no listeners');
  } finally { t.dispose(); }
  assert.equal(t.app.listening(), 0, 'dispose lets go of the store');
});

test('changes are reported as what changed: projects and selection in full, the threads\' facts as a delta', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    t.app.store.set('thread-project-assignments', { t1: { projectKind: 'local', projectId: 'p2' }, t4: { projectKind: 'local', projectId: 'p1' } });
    await until(() => t.reports().length >= 2, 2000, 'the assignment report');
    assert.deepEqual(t.last(), { type: 'projects', available: true, threads: { t1: { project: 'p2', projectless: true }, t4: { project: 'p1' }, t2: null, t3: null } });
    t.app.store.set('thread-workspace-root-hints', { t6: '/Users/q/site' });
    await until(() => t.reports().length >= 3, 2000, 'the hint report');
    assert.deepEqual(t.last(), { type: 'projects', available: true, threads: { t6: { root: '/Users/q/site' } } });
    t.app.store.set('selected-project', null);
    await until(() => t.reports().length >= 4);
    assert.deepEqual(t.last(), { type: 'projects', available: true, selected: null });
    t.app.store.set('project-order', ['p1', 'p2']);
    await until(() => t.reports().length >= 5);
    assert.deepEqual(t.last().projects.map((p) => p.id), ['p1', 'p2']);
    // Two writes in a burst make one report; a write that changes nothing makes none.
    t.app.store.set('selected-project', { type: 'local', projectId: 'p2' });
    t.app.store.set('selected-project', { type: 'local', projectId: 'p1' });
    t.app.store.set('project-order', ['p1', 'p2']);
    await sleep(50);
    assert.equal(t.reports().length, 6);
    assert.deepEqual(t.last(), { type: 'projects', available: true, selected: 'p1' });
  } finally { t.dispose(); }
});

test('malformed entries are left out; a project in the order but gone is skipped, one missing from the order comes last', async () => {
  const app = fakeApp({
    'local-projects': { p1: P1, bad: { id: 'bad' }, p3: { id: 'p3', name: 'x', rootPaths: 'nope' } },
    'project-order': ['gone', 'p3', 7],
    'selected-project': { type: 'remote', projectId: 'r1' },
    'thread-project-assignments': { t1: { projectKind: 'local', projectId: 'p1' }, t2: { projectKind: 'local' }, t3: null },
    'projectless-thread-ids': 'nope',
    'thread-workspace-root-hints': { t7: 7, t8: '' },
  });
  const t = setup(app);
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    assert.deepEqual(t.last(), { type: 'projects', available: true, projects: [{ id: 'p3', name: 'x', roots: [] }, PROJECTS[1]], selected: null, threads: { t1: { project: 'p1' }, t2: { other: true } }, reset: true });
  } finally { t.dispose(); }
});

test('the held window closes: another window\'s store is held with a reset; none left: unavailable, then held again', async () => {
  const t = setup();
  try {
    t.open(1); t.open(2);
    await until(() => t.reports().length >= 1);
    t.close(1);
    await until(() => t.reports().length >= 2, 2000, 'the report from window 2');
    assert.equal(t.last().reset, true);
    assert.equal(t.pr.state().window, 2);
    assert.equal(t.app.listening(), KEYS.length, 'the first window\'s listeners went');
    t.close(2);
    await until(() => t.reports().length >= 3, 2000, 'unavailable');
    assert.deepEqual(t.last(), { type: 'projects', available: false });
    t.open(3);
    await until(() => t.reports().length >= 4, 2000, 'held again');
    assert.equal(t.last().reset, true);
    assert.deepEqual(t.last().threads, THREADS);
  } finally { t.dispose(); }
});

test('a window without the service (or its store) is not held; the reason is logged once', async () => {
  const t = setup();
  try {
    t.open(1, { projects: { getLocalProjects: () => ({}) } });
    t.open(2, {});
    await sleep(30);
    assert.equal(t.reports().length, 0);
    assert.equal(t.log.lines.filter(([, m]) => /no window has the projects service/.test(m)).length, 1);
    t.open(3);
    await until(() => t.reports().length >= 1);
    assert.equal(t.pr.state().window, 3);
  } finally { t.dispose(); }
});

test('resend (the Host restarted) reports everything again; with no store it says unavailable', async () => {
  const t = setup();
  try {
    t.pr.resend();
    assert.deepEqual(t.last(), { type: 'projects', available: false });
    t.open(1);
    await until(() => t.reports().length >= 2);
    t.pr.resend();
    assert.equal(t.reports().length, 3);
    assert.deepEqual(t.last(), { type: 'projects', available: true, projects: PROJECTS, selected: 'p1', threads: THREADS, reset: true });
  } finally { t.dispose(); }
});

test('operations run through the app\'s manager; the answer comes after the report of what they changed', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    await t.pr.run({ type: 'app-op', requestId: 'r1', op: 'rename', projectId: 'p1', name: '  Repo  ' });
    assert.deepEqual(t.app.calls, [['renameLocal', { projectId: 'p1', name: 'Repo' }]]);
    assert.deepEqual(t.sent.slice(-2).map((m) => m.type), ['projects', 'app-op-done']);
    assert.equal(t.sent.at(-2).projects.find((p) => p.id === 'p1').name, 'Repo');
    assert.deepEqual(t.sent.at(-1), { type: 'app-op-done', requestId: 'r1', ok: true });

    await t.pr.run({ type: 'app-op', requestId: 'r2', op: 'reveal', projectId: 'p2' });
    assert.deepEqual(t.revealed, ['/Users/q/site'], 'the first root, from the app\'s record (never a path the Host gives)');
    assert.deepEqual(t.sent.at(-1), { type: 'app-op-done', requestId: 'r2', ok: true });

    await t.pr.run({ type: 'app-op', requestId: 'r2b', op: 'select', projectId: 'p2' });
    assert.deepEqual(t.app.calls.at(-1), ['createOrSelectLocalProjects', ['/Users/q/site']], 'its first root, the app\'s way');
    assert.deepEqual([t.sent.at(-2).type, t.sent.at(-2).selected, t.sent.at(-1)], ['projects', 'p2', { type: 'app-op-done', requestId: 'r2b', ok: true }]);

    await t.pr.run({ type: 'app-op', requestId: 'r3', op: 'remove', projectId: 'p2' });
    assert.deepEqual(t.app.calls.at(-1), ['removeLocal', 'p2']);
    const report = t.sent.at(-2);
    assert.deepEqual([report.projects.map((p) => p.id), report.threads], [['p1'], { t2: null }]);
    assert.deepEqual(t.sent.at(-1), { type: 'app-op-done', requestId: 'r3', ok: true });
  } finally { t.dispose(); }
});

test('a chat moves the app\'s way (its membership store) into a project or out of every project; the report goes before the answer', async () => {
  const t = setup();
  try {
    // 21477: the window's AppHost service `threadProjectAssignments`, whose setMembership writes the two keys (and tells every window)
    const store = t.app.store;
    const assignments = {
      async setMembership(req) {
        t.app.calls.push(['setMembership', req]);
        const a = { ...store.get('thread-project-assignments') };
        if (req.assignment) a[req.threadId] = req.assignment; else delete a[req.threadId];
        store.set('thread-project-assignments', a);
        const less = (store.get('projectless-thread-ids') ?? []).filter((x) => x !== req.threadId);
        store.set('projectless-thread-ids', req.projectless ? [...less, req.threadId] : less);
      },
    };
    t.open(1, { projects: t.app.manager, threadProjectAssignments: assignments });
    await until(() => t.reports().length >= 1);
    await t.pr.run({ type: 'app-op', requestId: 'm1', op: 'move-thread', projectId: 'p2', threadId: 't5' });
    assert.deepEqual(t.app.calls.at(-1), ['setMembership', { threadId: 't5', hostId: 'local', assignment: { projectKind: 'local', projectId: 'p2' }, projectless: false }]);
    assert.deepEqual([t.sent.at(-2).threads, t.sent.at(-1)], [{ t5: { project: 'p2' } }, { type: 'app-op-done', requestId: 'm1', ok: true }]);
    await t.pr.run({ type: 'app-op', requestId: 'm2', op: 'move-thread', threadId: 't2' });
    assert.deepEqual(t.app.calls.at(-1), ['setMembership', { threadId: 't2', hostId: 'local', assignment: null, projectless: true }]);
    assert.deepEqual([t.sent.at(-2).threads, t.sent.at(-1)], [{ t2: { projectless: true } }, { type: 'app-op-done', requestId: 'm2', ok: true }]);
    // refused, nothing written: no such project, no thread id
    for (const [req, re] of [[{ projectId: 'nope', threadId: 't1' }, /no such project/], [{ projectId: 'p1' }, /a thread id is needed/]]) {
      await t.pr.run({ type: 'app-op', requestId: 'm3', op: 'move-thread', ...req });
      assert.deepEqual([t.answers().at(-1).refused, re.test(t.answers().at(-1).error)], [true, true]);
    }
    assert.equal(t.app.calls.length, 2);
  } finally { t.dispose(); }
  // a window without the service: refused
  const u = setup();
  try {
    u.open(1);
    await until(() => u.reports().length >= 1);
    await u.pr.run({ type: 'app-op', requestId: 'm4', op: 'move-thread', projectId: 'p1', threadId: 't5' });
    assert.match(u.answers().at(-1).error, /cannot move a chat here/);
  } finally { u.dispose(); }
});

test('operations refused: unknown project or op, bad name, no store, no reveal, a hung app; a bad request id gets no answer', async () => {
  const t = setup(fakeApp(), { opTimeoutMs: 30, revealPath: null });
  try {
    await t.pr.run({ requestId: 'a', op: 'rename', projectId: 'p1', name: 'x' });
    assert.match(t.answers().at(-1).error, /not available/);
    t.open(1);
    await until(() => t.reports().length >= 1);
    const cases = [
      [{ op: 'rename', projectId: 'nope', name: 'x' }, /no such project/],
      [{ op: 'rename', projectId: 'p1', name: '   ' }, /a name of 1 to 500/],
      [{ op: 'rename', projectId: 'p1', name: 'x'.repeat(501) }, /a name of 1 to 500/],
      [{ op: 'close', projectId: 'p1' }, /unknown operation close/],
      [{ op: 'reveal', projectId: 'p1' }, /not available/],
      [{ op: 'remove' }, /a project id is needed/],
    ];
    for (const [i, [req, re]] of cases.entries()) {
      await t.pr.run({ requestId: `c${i}`, ...req });
      const a = t.answers().at(-1);
      assert.deepEqual([a.requestId, a.ok, a.refused], [`c${i}`, false, true]);
      assert.match(a.error, re);
    }
    assert.deepEqual(t.app.calls, []);
    t.app.hang = true;
    await t.pr.run({ requestId: 'h', op: 'rename', projectId: 'p1', name: 'y' });
    assert.match(t.answers().at(-1).error, /did not answer in 30 ms/);
    assert.equal(t.answers().at(-1).refused, false, 'the app was asked: not a refusal');
    const n = t.sent.length;
    await t.pr.run({ op: 'remove', projectId: 'p1' });
    await t.pr.run({ requestId: 'x'.repeat(201), op: 'remove', projectId: 'p1' });
    assert.equal(t.sent.length, n);
  } finally { t.dispose(); }
});

test('a project\'s files the app\'s way: list and inspect inside its roots only, reveal a path inside it', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const ask = async (req) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, projectId: 'p1', ...req }); return t.answers().at(-1); };
    const root = await ask({ op: 'list', path: '/Users/q/repo/' });
    assert.deepEqual(root, { type: 'app-op-done', requestId: root.requestId, ok: true, result: { entries: [
      { name: 'src', path: '/Users/q/repo/src', type: 'directory', isSymlink: false }, { name: 'a.txt', path: '/Users/q/repo/a.txt', type: 'file', isSymlink: false },
    ], truncated: false } });
    assert.deepEqual(t.app.calls.at(-1), ['listDirectory', { hostId: 'local', workspaceRoot: '/Users/q/repo', directoryPath: '', directoriesOnly: false, includeHidden: false }]);
    assert.deepEqual((await ask({ op: 'list', path: '/Users/q/repo/src' })).result.entries.map((e) => e.path), ['/Users/q/repo/src/main.js']);
    assert.equal(t.app.calls.at(-1)[1].directoryPath, 'src');
    assert.deepEqual((await ask({ op: 'inspect', path: '/Users/q/repo/src/main.js' })).result, { isFile: true, size: 12, modifiedAt: 1000, kind: 'text' });
    assert.deepEqual(t.app.calls.at(-1), ['inspect', { hostId: 'local', path: '/Users/q/repo/src/main.js', contentSampleByteLimit: 4096, contentSampleMaxFileBytes: 268435456 }]);
    assert.deepEqual((await ask({ op: 'inspect', path: '/Users/q/repo/gone.txt' })).result, { missing: true });
    const missingDir = await ask({ op: 'list', path: '/Users/q/repo/nope' });
    assert.deepEqual([missingDir.ok, missingDir.refused], [false, false], 'the app was asked and failed');
    await ask({ op: 'reveal', path: '/Users/q/repo/src/main.js' });
    assert.deepEqual(t.revealed, ['/Users/q/repo/src/main.js']);
    // File.open: the app's own action; refused while the window shows no thread.
    assert.deepEqual((await ask({ op: 'open', path: '/Users/q/repo/a.txt' })).result, { status: 'opened', viewer: 'textFileEditor' });
    assert.deepEqual(t.app.calls.at(-1), ['runInPrimaryWindow', { action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/Users/q/repo/a.txt' } } }]);
    t.app.threadShown = false;
    const shut = await ask({ op: 'open', path: '/Users/q/repo/a.txt' });
    assert.deepEqual([shut.ok, shut.refused], [false, true]);
    assert.match(shut.error, /no thread is open/);
    // Outside the project, through `..`, or not absolute: refused, and the app is not asked.
    const n = t.app.calls.length;
    for (const p of ['/Users/q/site/x', '/Users/q/repo/../site', '/Users/q/repository', 'repo/a.txt', undefined]) {
      for (const op of ['list', 'inspect', 'reveal', 'open']) {
        if (op === 'reveal' && p === undefined) continue;
        const a = await ask({ op, path: p });
        assert.deepEqual([a.ok, a.refused, a.error], [false, true, 'the path is not in the project'], `${op} ${p}`);
      }
    }
    assert.equal(t.app.calls.length, n);
    assert.deepEqual(t.revealed, ['/Users/q/repo/src/main.js']);
    // The project's second root counts too; a window without the file service refuses.
    assert.deepEqual((await ask({ projectId: 'p2', op: 'inspect', path: '/Users/q/site-assets/x' })).result, { missing: true }, 'asked: it is in the second root');
    t.close(1);
    t.open(2, { projects: t.app.manager });
    await until(() => t.pr.state().window === 2);
    assert.match((await ask({ op: 'list', path: '/Users/q/repo' })).error, /file service is not available/);
  } finally { t.dispose(); }
});

test('the apps on this Mac: installed open-in targets with their bundle ids, computer-use approvals; open-in and taking an approval back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-apps-'));
  const app = join(dir, 'Visual Studio Code.app');
  mkdirSync(join(app, 'Contents', 'Resources', 'bin'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.microsoft.VSCode</string></dict></plist>\n');
  const calls = [];
  let approved = ['com.apple.finder', 'com.example.Tool'];
  const openIn = {
    async getTargets(req) {
      calls.push(['getTargets', req]);
      return { preferredTarget: 'vscode', mode: 'editor', targets: [
        { id: 'vscode', target: 'vscode', label: 'VS Code', icon: '/apps/vscode.png', kind: 'editor', available: true, default: true },
        { id: 'cursor', target: 'cursor', label: 'Cursor', icon: '/apps/cursor.png', kind: 'editor', available: false },
        { id: 'systemDefault', target: 'systemDefault', label: 'Default app', kind: 'systemDefault', hidden: true, available: true },
        { id: 'fileManager', target: 'fileManager', label: 'Finder', icon: '/apps/finder.png', kind: 'fileManager', available: true },
        { id: 'ghostty', target: 'ghostty', label: 'Ghostty', icon: '/apps/ghostty.png', kind: 'terminal', available: true },
      ] };
    },
    async requestOpenInWorker(req) { calls.push(['worker', req.params.target]); return { command: req.params.target === 'vscode' ? join(app, 'Contents', 'Resources', 'bin', 'code') : '/usr/bin/open' }; },
    async open(req) { calls.push(['open', req]); return { success: req.target !== 'broken' }; },
  };
  const computerUseSettings = {
    async getAppApprovals() { return { approvedApps: [{ bundleIdentifier: 'com.apple.finder', displayName: 'Finder', iconDataURL: 'data:image/png;base64,AAAA' }], approvedBundleIdentifiers: approved }; },
    async removeAppApproval(id) { calls.push(['removeAppApproval', id]); approved = approved.filter((x) => x !== id); return { approvedApps: [], approvedBundleIdentifiers: approved }; },
  };
  const t = setup();
  try {
    t.open(1, { projects: t.app.manager, openIn, computerUseSettings });
    await until(() => t.reports().length >= 1);
    const ask = async (req) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, ...req }); return t.answers().at(-1); };
    const apps = (await ask({ op: 'apps' })).result;
    assert.deepEqual(apps.targets.map((x) => [x.id, x.bundleId]), [['vscode', existsSync('/usr/bin/plutil') ? 'com.microsoft.VSCode' : null], ['fileManager', 'com.apple.finder'], ['ghostty', null]],
      'installed and not hidden only; the bundle from the executable\'s .app, Finder\'s fixed, Ghostty\'s unknown (it runs through open)');
    assert.deepEqual([apps.preferred, apps.targets[0].label, apps.targets[0].icon, apps.targets[0].kind], ['vscode', 'VS Code', '/apps/vscode.png', 'editor']);
    assert.deepEqual(apps.approvals, { apps: [{ bundleId: 'com.apple.finder', name: 'Finder', icon: 'data:image/png;base64,AAAA' }, { bundleId: 'com.example.Tool', name: 'com.example.Tool', icon: null }] }, 'the shape 21477 gives (bundleIdentifier, displayName, iconDataURL)');
    await ask({ op: 'apps' });
    assert.equal(calls.filter(([c]) => c === 'worker').length, 2, 'bundles are read once per target (Finder\'s is fixed)');
    // Open a project's path in a target, the app's way; outside the project: refused; the app failing: failed.
    assert.equal((await ask({ op: 'open-in', projectId: 'p1', path: '/Users/q/repo/a.txt', target: 'vscode' })).ok, true);
    assert.deepEqual(calls.at(-1), ['open', { path: '/Users/q/repo/a.txt', cwd: '/Users/q/repo', target: 'vscode', hostId: 'local' }]);
    assert.equal((await ask({ op: 'open-in', projectId: 'p1', path: '/etc/hosts', target: 'vscode' })).refused, true);
    assert.deepEqual(Object.values(await ask({ op: 'open-in', projectId: 'p1', path: '/Users/q/repo', target: 'broken' })).slice(2, 4), [false, 'the app could not open it in broken']);
    // Take an approval back.
    assert.deepEqual((await ask({ op: 'remove-app-approval', bundleId: 'com.example.Tool' })).result, { approved: false });
    assert.deepEqual(calls.at(-1), ['removeAppApproval', 'com.example.Tool']);
    assert.equal((await ask({ op: 'remove-app-approval' })).refused, true);
  } finally { t.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('cloud environments: the signed-in account\'s configs, its own and its workspace\'s, paged; only the account and user ids are used', async () => {
  const calls = [];
  let signedIn = true;
  const accountInfo = { async readAccountInfo() { return signedIn ? { status: 'ready', data: { accountId: 'acct', userId: 'user-1', email: 'x@example.com', plan: 'pro', hasChatGptToken: true } } : { status: 'ready', data: {} }; } };
  const environmentConfigs = {
    async list(req) {
      calls.push(req);
      if (req.scope === 'workspace') return { ok: false, error: 'no-workspace' };
      if (!req.cursor) return { ok: true, page: { data: [{ id: 'acct~asenvcfg_1', name: 'qa-cloud', status: 'ready', shareSettings: 'private', repositories: [{ repositoryId: 'github-1', ref: 'main' }], threadId: 't1', versionId: 'v' }], nextCursor: 'c2' } };
      return { ok: true, page: { data: [{ id: 'acct~asenvcfg_2', status: 'draft', repositories: [] }, { id: 'acct~asenvcfg_1', name: 'dup' }], nextCursor: null } };
    },
  };
  const t = setup();
  try {
    t.open(1, { projects: t.app.manager, accountInfo, environmentConfigs });
    await until(() => t.reports().length >= 1);
    const ask = async () => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, op: 'cloud-environments' }); return t.answers().at(-1); };
    assert.deepEqual((await ask()).result, { signedIn: true, environments: [
      { id: 'acct~asenvcfg_1', name: 'qa-cloud', status: 'ready', repositories: ['github-1'], setupThreadId: 't1', shared: 'private' },
      { id: 'acct~asenvcfg_2', name: 'acct~asenvcfg_2', status: 'draft', repositories: [], setupThreadId: null, shared: null },
    ] });
    assert.deepEqual(calls.map((c) => [c.accountId, c.userId, c.scope, c.cursor ?? null]), [['acct', 'user-1', 'user', null], ['acct', 'user-1', 'user', 'c2'], ['acct', 'user-1', 'workspace', null]]);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['accountId', 'limit', 'scope', 'userId'], 'nothing else of the account goes to the service');
    signedIn = false;
    assert.deepEqual((await ask()).result, { signedIn: false, environments: [] });
    t.close(1);
    t.open(2, { projects: t.app.manager });
    await until(() => t.pr.state().window === 2);
    assert.equal((await ask()).refused, true, 'a window without the services refuses');
  } finally { t.dispose(); }
});

test('a project\'s repository the app\'s way: origins and the git worker; switch, create and push through gitRepository handles', async () => {
  const calls = [];
  const worker = {
    'current-branch': { branch: 'qa-f3', isDetached: false }, 'status-summary': { type: 'success', stagedCount: 0, unstagedCount: 1, untrackedCount: 2 },
    'upstream-branch': { branch: 'qa-f3', upstream: { branch: 'origin/qa-f3' } }, 'branch-ahead-count': { commitsAhead: 1 },
    'recent-branches': { branches: ['qa-f3', 'main', 7] }, 'default-branch': { error: 'boom' },
    'review-summary': { type: 'success', files: [{ path: 'src/a.txt' }], source: 'staged' },
    'review-patch': { source: 'unstaged', diff: { type: 'success', unifiedDiff: 'diff --git a/x b/x\n', unifiedDiffBytes: 19 } },
  };
  const openIn = { async requestGitWorker(req) { calls.push(['worker', req.method, req.params]); return worker[req.method] ?? null; } };
  const repositoryOrigins = { async read(req, source) { calls.push(['origins', req, source]); return { origins: [{ dir: req.dirs[0], root: '/Users/q/repo', originUrl: '/remote.git', commonDir: '/Users/q/repo/.git' }] }; } };
  let waitResult = { status: 'success' };
  const disposed = [];
  const handle = (name, req, source) => ({ wait: async () => { calls.push(['git', name, req, source]); return waitResult; }, [Symbol.dispose]: () => disposed.push(name) });
  const gitRepository = { checkoutBranch: (r, s) => handle('checkout', r, s), createBranch: (r, s) => handle('create', r, s), push: (r, s) => handle('push', r, s) };
  const t = setup();
  try {
    t.open(1, { projects: t.app.manager, openIn, repositoryOrigins, gitRepository });
    await until(() => t.reports().length >= 1);
    const ask = async (req) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, projectId: 'p1', ...req }); return t.answers().at(-1); };
    assert.deepEqual((await ask({ op: 'repository' })).result, {
      git: true, root: '/Users/q/repo', origin: '/remote.git', branch: 'qa-f3', detached: false, status: { staged: 0, unstaged: 1, untracked: 2 },
      upstream: 'origin/qa-f3', ahead: 1, branches: ['qa-f3', 'main'], defaultBranch: null, staged: ['/Users/q/repo/src/a.txt'],
    });
    assert.deepEqual(calls[0], ['origins', { dirs: ['/Users/q/repo'], hostId: 'local' }, 'git_direct_call']);
    assert.ok((await ask({ op: 'switch-branch', branch: 'main' })).ok);
    assert.ok((await ask({ op: 'create-branch', branch: 'feature' })).ok);
    assert.ok((await ask({ op: 'push' })).ok);
    assert.deepEqual(calls.filter(([k]) => k === 'git'), [
      ['git', 'checkout', { cwd: '/Users/q/repo', branch: 'main', hostId: 'local' }, 'use_checkout_git_branch'],
      ['git', 'create', { cwd: '/Users/q/repo', branch: 'feature', hostId: 'local', mode: 'worktree', failIfExists: true }, 'use_create_git_branch'],
      ['git', 'push', { cwd: '/Users/q/repo', hostId: 'local' }, 'use_git_push_mutation'],
    ]);
    assert.deepEqual(disposed, ['checkout', 'create', 'push'], 'each handle let go');
    // A branch with no upstream is published as the app's push does it.
    worker['upstream-branch'] = { branch: 'qa-f3', upstream: null };
    assert.ok((await ask({ op: 'push' })).ok);
    assert.deepEqual(calls.filter(([k]) => k === 'git').at(-1), ['git', 'push', { cwd: '/Users/q/repo', hostId: 'local', refspec: 'HEAD:refs/heads/qa-f3', setUpstream: true }, 'use_git_push_mutation']);
    worker['upstream-branch'] = { branch: 'qa-f3', upstream: { branch: 'origin/qa-f3' } };
    // a push that names its branch: the checkout's as read just now, else refused and not pushed (built review H6m2b round 2)
    const pushed = calls.filter(([k, n]) => k === 'git' && n === 'push').length;
    assert.ok((await ask({ op: 'push', branch: 'qa-f3' })).ok);
    const wrong = await ask({ op: 'push', branch: 'main' });
    assert.deepEqual([wrong.ok, wrong.refused, wrong.error], [false, true, 'the checkout is on qa-f3, not main']);
    assert.equal(calls.filter(([k, n]) => k === 'git' && n === 'push').length, pushed + 1);
    waitResult = { status: 'error', error: 'pathspec did not match' };
    const failed = await ask({ op: 'switch-branch', branch: 'nope' });
    assert.deepEqual([failed.ok, failed.refused, failed.error], [false, false, 'pathspec did not match']);
    assert.equal((await ask({ op: 'switch-branch' })).refused, true, 'a branch name is needed');
    // its changes: the app's review's own patch, in the project's folder
    assert.deepEqual((await ask({ op: 'working-changes', scope: 'staged' })).result, { diff: 'diff --git a/x b/x\n' });
    assert.deepEqual(calls.filter(([k, m]) => k === 'worker' && m === 'review-patch').at(-1), ['worker', 'review-patch', { cwd: '/Users/q/repo', source: 'staged', operationSource: 'git_direct_call' }]);
    worker['review-patch'] = { source: 'unstaged', diff: { type: 'error', error: { type: 'diff-too-large' } } };
    assert.match((await ask({ op: 'working-changes', scope: 'unstaged' })).error, /too large/);
    assert.equal((await ask({ op: 'working-changes', scope: 'everything' })).refused, true);
  } finally { t.dispose(); }
});

test('a worktree of the project\'s repository: the same git common directory, its branch and base; another repository\'s is refused', async () => {
  const meta = { '/Users/q/repo': { root: '/Users/q/repo', commonDir: '/Users/q/repo/.git' }, '/h/wt/repo': { root: '/h/wt/repo', commonDir: '/Users/q/repo/.git' }, '/h/other': { root: '/h/other', commonDir: '/h/other/.git' } };
  // a new worktree the app made from a branch records it in its git directory (E8.3g)
  const made = mkdtempSync(join(tmpdir(), 'cm-worktree-'));
  mkdirSync(join(made, 'gitdir'));
  mkdirSync(join(made, 'repo'));
  writeFileSync(join(made, 'repo', '.git'), `gitdir: ${join(made, 'gitdir')}\n`);
  writeFileSync(join(made, 'gitdir', 'codex-synced-branch.json'), JSON.stringify({ branch: 'refs/heads/qa-f3', lastSyncedTreeRef: 'abc' }));
  meta[join(made, 'repo')] = { root: join(made, 'repo'), commonDir: '/Users/q/repo/.git' };
  const openIn = { async requestGitWorker({ method, params }) {
    if (method === 'stable-metadata') return meta[params.cwd] ?? null;
    if (method === 'current-branch') return { branch: params.root === '/h/wt/repo' ? 'codex/try' : 'main', isDetached: false };
    if (method === 'branch-metadata') return { gitRoot: params.cwd, branch: 'codex/try', baseBranch: params.cwd === join(made, 'repo') ? 'main' : null, baseBranchRemote: null };
    if (method === 'default-branch') return { branch: 'main' };
    if (method === 'config-value') return { value: params.root === '/h/wt2/repo' ? '/Users/q/repo/.codex/environments/environment.toml' : '__none__' };
    return null;
  } };
  meta['/h/wt2/repo'] = { root: '/h/wt2/repo', commonDir: '/Users/q/repo/.git' };
  const localEnvironments = { async read({ configPath }) { return { environment: { configPath, type: 'success', environment: { name: 'env', setup: { script: 'npm ci', darwin: { script: 'brew bundle && npm ci' } } } } }; } };
  const t = setup();
  try {
    t.open(1, { projects: t.app.manager, openIn, localEnvironments });
    await until(() => t.reports().length >= 1);
    const ask = async (p) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, projectId: 'p1', op: 'worktree', path: p }); return t.answers().at(-1); };
    assert.deepEqual((await ask('/h/wt/repo')).result, { exists: true, root: '/h/wt/repo', branch: 'codex/try', base: 'main', setup: null }, 'no base recorded: the default branch; made with no environment');
    assert.equal((await ask('/h/wt2/repo')).result.setup, 'brew bundle && npm ci', 'the environment it was made with: this Mac\'s setup');
    assert.equal((await ask(join(made, 'repo'))).result.base, 'qa-f3', 'the branch the app made it from, before the base the git worker answers');
    assert.deepEqual((await ask('/h/gone')).result, { exists: false });
    assert.deepEqual((await ask('/Users/q/repo')).result, { exists: false }, 'the project\'s own checkout is not a worktree');
    const other = await ask('/h/other');
    assert.deepEqual([other.refused, other.error], [true, 'the path is not a worktree of the project\'s repository']);
    assert.equal((await ask('relative')).refused, true);
  } finally { t.dispose(); rmSync(made, { recursive: true, force: true }); }
});

test('instructions: the global files read without the app (which would create one), a project folder\'s through workspaceFiles; edits the app\'s way', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-instructions-'));
  writeFileSync(join(home, 'AGENTS.md'), 'Be brief.');
  const disk = { '/Users/q/repo/AGENTS.md': { text: 'Use tabs.', mtimeMs: 2000.25 } };
  const written = [];
  const files = {
    async inspect(req) {
      const f = disk[req.path];
      if (!f) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${req.path}'`), { code: 'ENOENT' });
      return { contentKind: 'text', isFile: true, mtimeMs: f.mtimeMs, sizeBytes: f.text.length };
    },
    async read(req) { written.push(['read', req.path, req.representation]); return { etag: 'e', text: disk[req.path].text }; },
    async saveText(req) {
      written.push(['saveText', req.path, req.content, req.expectedMtimeMs]);
      const cur = disk[req.path]?.mtimeMs ?? null;
      if (req.expectedMtimeMs !== cur) return { outcome: 'conflict', mtimeMs: cur };
      disk[req.path] = { text: req.content, mtimeMs: (cur ?? 0) + 1 };
      return { outcome: 'saved', mtimeMs: disk[req.path].mtimeMs };
    },
  };
  const agentInstructions = { async read() { throw new Error('the app\'s read creates the file: not used'); }, async write(req) { written.push(['write', req.hostId, req.contents]); return { path: join(home, 'AGENTS.md') }; } };
  const t = setup(fakeApp(), { codexHome: () => home });
  try {
    t.open(1, { projects: t.app.manager, workspaceFiles: files, agentInstructions, appActions: t.app.actions });
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    const global = await ask({ op: 'instructions' });
    assert.deepEqual(global.result.home, home);
    assert.deepEqual(global.result.files.map(({ modifiedAt, ...f }) => f), [{ path: join(home, 'AGENTS.md'), exists: true, text: 'Be brief.' }, { path: join(home, 'AGENTS.override.md'), exists: false }]);
    assert.ok(Number.isFinite(global.result.files[0].modifiedAt));
    // The global AGENTS.md is the app's agentInstructions.write; the override is saved like any file; nothing else in the home.
    assert.equal((await ask({ op: 'edit-instructions', path: join(home, 'AGENTS.md'), text: 'Be briefer.' })).ok, true);
    assert.deepEqual(written.at(-1), ['write', 'local', 'Be briefer.']);
    assert.equal((await ask({ op: 'edit-instructions', path: join(home, 'AGENTS.override.md'), text: 'Override.' })).ok, true);
    assert.deepEqual(written.at(-1), ['saveText', join(home, 'AGENTS.override.md'), 'Override.', null], 'a new file: saved against no modification time');
    for (const bad of [join(home, 'config.toml'), join(home, 'sub', 'AGENTS.md'), 'AGENTS.md']) assert.equal((await ask({ op: 'edit-instructions', path: bad, text: 'x' })).refused, true, bad);
    assert.equal((await ask({ op: 'edit-instructions', path: join(home, 'AGENTS.md') })).refused, true, 'a text is needed');
    assert.equal((await ask({ op: 'open-instructions', path: join(home, 'AGENTS.md') })).result.status, 'opened');
    // A project's folder: its files through workspaceFiles, edits against the modification time it has now.
    const proj = await ask({ op: 'instructions', projectId: 'p1', path: '/Users/q/repo' });
    assert.deepEqual(proj.result.files, [{ path: '/Users/q/repo/AGENTS.md', exists: true, text: 'Use tabs.', modifiedAt: 2000 }, { path: '/Users/q/repo/AGENTS.override.md', exists: false }]);
    assert.equal((await ask({ op: 'edit-instructions', projectId: 'p1', path: '/Users/q/repo/AGENTS.md', text: 'Use spaces.' })).ok, true);
    assert.deepEqual([written.at(-1), disk['/Users/q/repo/AGENTS.md'].text], [['saveText', '/Users/q/repo/AGENTS.md', 'Use spaces.', 2000.25], 'Use spaces.']);
    assert.equal((await ask({ op: 'edit-instructions', projectId: 'p1', path: '/Users/q/repo/a.txt', text: 'x' })).refused, true, 'only an instructions file');
    assert.equal((await ask({ op: 'instructions', projectId: 'p1', path: '/elsewhere' })).refused, true, 'only inside the project');
  } finally { t.dispose(); rmSync(home, { recursive: true, force: true }); }
});

test('a project\'s actions: the selected environment config\'s, run in a terminal of the thread shown (the tab first, then the command)', async () => {
  const cfg = '/Users/q/repo/.codex/environments/environment.toml', other = '/Users/q/repo/.codex/environments/other.toml';
  const listed = [];
  const localEnvironments = { async list(req) {
    listed.push(req);
    return { environments: [
      { configPath: cfg, cwdRelativeToGitRoot: '', type: 'success', environment: { name: 'qa-env', version: 1, setup: { script: '' }, actions: [{ name: 'Run', icon: 'run', command: 'make run' }, { name: '', command: 'x' }, { name: 'Linux only', icon: null, command: 'apt', platform: 'linux' }] } },
      { configPath: other, cwdRelativeToGitRoot: '', type: 'success', environment: { name: 'other', version: 1, setup: { script: '' }, actions: [{ name: 'Test', icon: 'test', command: 'make test' }] } },
      { configPath: '/Users/q/repo/.codex/environments/bad.toml', type: 'error', error: { message: 'bad toml' } },
    ] };
  } };
  const calls = [];
  const terminal = { async create(req) { calls.push(['create', req]); }, runAction(id, cwd, command) { calls.push(['runAction', id, cwd, command]); }, close(id) { calls.push(['close', id]); } };
  const app = fakeApp();
  const t = setup(app);
  try {
    t.open(1, { projects: app.manager, localEnvironments, terminal, appActions: { async runInPrimaryWindow(req) { calls.push(['tabs', req.action]); if (!app.threadShown) throw new Error('windows.tabs.open requires a visible thread'); return { status: 'opened' }; } } });
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, projectId: 'p1', ...m }); return t.answers().at(-1); };
    const r = (await ask({ op: 'actions' })).result;
    assert.deepEqual(listed, [{ hostId: 'local', workspaceRoot: '/Users/q/repo' }]);
    assert.deepEqual(r, { selected: cfg, configs: [
      { configPath: cfg, name: 'qa-env', actions: [{ name: 'Run', icon: 'run', command: 'make run', platform: null }, { name: 'Linux only', icon: null, command: 'apt', platform: 'linux' }] },
      { configPath: other, name: 'other', actions: [{ name: 'Test', icon: 'test', command: 'make test', platform: null }] },
    ] }, 'the first config is the default; an unnamed action and a config that failed are left out');
    // The app's selection for the folder wins; null there is "no environment".
    app.store.set('electron-persisted-atom-state', { 'local-env-selections-by-workspace': { 'local:/Users/q/repo': other } });
    assert.equal((await ask({ op: 'actions' })).result.selected, other);
    app.store.set('electron-persisted-atom-state', { 'local-env-selections-by-workspace': { 'local:/Users/q/repo': null } });
    assert.equal((await ask({ op: 'actions' })).result.selected, null);
    // Run: the session, its tab in the thread's panel, then the config's own command.
    const done = await ask({ op: 'run-action', path: cfg, index: 0, threadId: 't1' });
    assert.equal(done.ok, true);
    const id = done.result.sessionId;
    assert.deepEqual(calls, [
      ['create', { sessionId: id, cwd: '/Users/q/repo', hostId: 'local', conversationTitle: 'Run', conversationId: 't1' }],
      ['tabs', { type: 'windows.tabs.open', windowId: 'current', threadId: 't1', target: { type: 'terminal', sessionId: id }, placement: 'bottom' }],
      ['runAction', id, '/Users/q/repo', 'make run'],
    ]);
    // A named thread's own folder: inside the project (or a worktree of its repository), else refused.
    calls.length = 0;
    assert.equal((await ask({ op: 'run-action', path: cfg, index: 0, threadId: 't1', cwd: '/Users/q/repo/src' })).ok, true);
    assert.deepEqual([calls[0][1].cwd, calls.at(-1)[2]], ['/Users/q/repo/src', '/Users/q/repo/src']);
    assert.equal((await ask({ op: 'run-action', path: cfg, index: 0, threadId: 't1', cwd: '/elsewhere' })).refused, true);
    calls.length = 0;
    app.threadShown = false;
    const none = await ask({ op: 'run-action', path: cfg, index: 0 });
    assert.deepEqual([none.refused, none.error], [true, 'the app opens a terminal in a thread\'s panel, and no thread is open']);
    assert.deepEqual(calls.map((c) => c[0]), ['create', 'tabs', 'close'], 'nothing runs without a thread to show it');
    // Project.newTerminal: the same session and tab, in the project's folder or a folder in it, and nothing run in it
    app.threadShown = true;
    calls.length = 0;
    const term = await ask({ op: 'new-terminal', threadId: 't1' });
    assert.match(term.result.sessionId, /^codexmods-terminal-/);
    assert.deepEqual(calls, [
      ['create', { sessionId: term.result.sessionId, cwd: '/Users/q/repo', hostId: 'local', conversationTitle: 'repo', conversationId: 't1' }],
      ['tabs', { type: 'windows.tabs.open', windowId: 'current', threadId: 't1', target: { type: 'terminal', sessionId: term.result.sessionId }, placement: 'bottom' }],
    ]);
    assert.equal((await ask({ op: 'new-terminal', path: '/Users/q/repo/src' })).ok, true);
    assert.equal(calls.at(-2)[1].cwd, '/Users/q/repo/src');
    assert.equal((await ask({ op: 'new-terminal', path: '/elsewhere' })).refused, true);
    assert.equal((await ask({ op: 'run-action', path: cfg, index: 5 })).refused, true);
    assert.equal((await ask({ op: 'run-action', path: '/elsewhere.toml', index: 0 })).refused, true);
    if (process.platform !== 'linux') assert.match((await ask({ op: 'run-action', path: cfg, index: 1 })).error, /runs on linux/);
  } finally { t.dispose(); }
});

test('remove-worktree: only one of the app\'s worktrees of the project\'s repository, deleted the app\'s way; the pinned chats', async () => {
  const meta = { '/Users/q/repo': { root: '/Users/q/repo', commonDir: '/Users/q/repo/.git' }, '/h/worktrees/1/repo': { root: '/h/worktrees/1/repo', commonDir: '/Users/q/repo/.git' },
    '/elsewhere/wt': { root: '/elsewhere/wt', commonDir: '/Users/q/repo/.git' }, '/h/worktrees/2/other': { root: '/h/worktrees/2/other', commonDir: '/h/other/.git' } };
  const openIn = { async requestGitWorker({ method, params }) {
    if (method === 'stable-metadata') return meta[params.cwd] ?? null;
    if (method === 'current-branch') return { branch: null, isDetached: true };
    if (method === 'default-branch') return { branch: 'main' };
    return null;
  } };
  const deleted = [];
  const managedWorktrees = { async delete(req) { deleted.push(req); } };
  const pinnedThreads = { async list(req) { return { threadIds: req.hostId === 'local' && req.useAppServerPins === true && req.preservePinSource === true ? ['t9', '', 7] : [] }; } };
  const app = fakeApp();
  const t = setup(app, { codexHome: () => '/h' });
  try {
    t.open(1, { projects: app.manager, openIn, managedWorktrees, pinnedThreads });
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    assert.deepEqual((await ask({ op: 'pinned-threads' })).result, { threadIds: ['t9'] });
    assert.equal((await ask({ op: 'remove-worktree', projectId: 'p1', path: '/h/worktrees/1/repo' })).ok, true);
    assert.deepEqual(deleted, [{ hostId: 'local', worktree: '/h/worktrees/1/repo', reason: 'settings-delete-targeted' }]);
    for (const [p, why] of [['/elsewhere/wt', 'not one of the app\'s'], ['/h/worktrees/2/other', 'not a worktree of the project'], ['/h/worktrees/3/gone', 'no worktree there'], ['/Users/q/repo', 'not one of the app\'s']]) {
      const r = await ask({ op: 'remove-worktree', projectId: 'p1', path: p });
      assert.equal(r.refused, true, p);
      assert.match(r.error, new RegExp(why), p);
    }
    // The Worktrees setting moves the app's worktrees elsewhere.
    app.store.set('git-worktree-root', '/elsewhere');
    assert.equal((await ask({ op: 'remove-worktree', projectId: 'p1', path: '/elsewhere/wt' })).ok, true);
    assert.equal(deleted.length, 2);
  } finally { t.dispose(); }
});

test('navigate: a few app pages, opened by a navigate-to-route to the held window; any other path is refused', async () => {
  const posted = [];
  const t = setup(fakeApp(), { toView: (id, msg) => posted.push([id, msg]) });
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    assert.equal((await ask({ op: 'navigate', path: '/settings/codex-cloud' })).ok, true);
    assert.deepEqual(posted, [[1, { type: 'navigate-to-route', path: '/settings/codex-cloud' }]]);
    for (const p of ['/settings/../x', '/local/abc', 'https://example.com', undefined]) assert.equal((await ask({ op: 'navigate', path: p })).refused, true, String(p));
    assert.equal(posted.length, 1);
  } finally { t.dispose(); }
});

test('register: wires the Host messages and never throws', async () => {
  const handlers = new Map();
  const sent = [];
  const app = fakeApp();
  const g = {};
  const hold = installAppHost({ log: quiet(), global: g });
  const revealed = [];
  register({ appHost: hold, sendToHost: (m) => sent.push(m), log: quiet(), electron: { revealPath: (p) => revealed.push(p) },
    onHostMessage: (type, fn) => handlers.set(type, fn) });
  assert.deepEqual([...handlers.keys()].sort(), ['app-op', 'ready']);
  g.__codexmods.appHost({ services: { projects: app.manager } }, sender(1));
  handlers.get('ready')();
  assert.equal(sent.at(-1).reset, true);
  handlers.get('app-op')({ requestId: 'r', op: 'reveal', projectId: 'p1' });
  await until(() => sent.some((m) => m.type === 'app-op-done'));
  assert.deepEqual(revealed, ['/Users/q/repo']);
  hold.dispose();
  const log = quiet();
  register({ log, onHostMessage() { throw new Error('boom'); }, appHost: hold, sendToHost() {} });
  assert.ok(log.lines.some(([level, m]) => level === 'error' && /projects register failed/.test(m)));
  register({ log, onHostMessage() {} });
  assert.ok(log.lines.some(([, m]) => /no AppHost hold/.test(m)));
});

test('E8.9: add makes a folder a project through the app\'s createLocal (its own trust dialog), named after the folder unless named', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    await t.pr.run({ type: 'app-op', requestId: 'a1', op: 'add', path: '/Users/q/new-thing/' });
    assert.deepEqual(t.app.calls.at(-1), ['createLocal', { appearance: null, initializeDefaultWorkspaceGitRepository: false, name: 'new-thing', sources: ['/Users/q/new-thing'], setActive: false }]);
    assert.deepEqual(t.answers().at(-1), { type: 'app-op-done', requestId: 'a1', ok: true, result: { folder: '/Users/q/new-thing', id: 'p-new-thing' } });
    await t.pr.run({ type: 'app-op', requestId: 'a2', op: 'add', path: 'relative/path' });
    assert.deepEqual(t.answers().at(-1), { type: 'app-op-done', requestId: 'a2', ok: false, error: 'an absolute folder path is needed', refused: true });
  } finally { t.dispose(); }
});

test('H9b: a project\'s AGENTS.md and a skill are created exclusively: never over a file that is there, never through a link', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-create-')));
  const home = join(tmp, 'home'), repo = join(tmp, 'repo'), elsewhere = join(tmp, 'elsewhere');
  for (const d of [home, repo, elsewhere]) mkdirSync(d);
  const app = fakeApp({ 'local-projects': { p1: { ...P1, rootPaths: [repo] } }, 'project-order': ['p1'] });
  const t = setup(app, { codexHome: () => home });
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.pr.run({ type: 'app-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    // AGENTS.md: made once; a second, or one that was there (any size), is refused and left as it was
    assert.deepEqual((await ask({ op: 'create-instructions', projectId: 'p1', text: 'Use tabs.' })).result, { path: join(repo, 'AGENTS.md') });
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'Use tabs.');
    const again = await ask({ op: 'create-instructions', projectId: 'p1', text: 'Replace.' });
    assert.deepEqual([again.ok, again.refused, again.error], [false, true, 'the project has its instructions already: edit them']);
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'Use tabs.');
    // a skill in the home and in the project: SKILL.md in a new folder; the same name again is refused, the first kept
    const text = '---\nname: tidy\ndescription: "d"\n---\n\nSort.\n';
    assert.deepEqual((await ask({ op: 'add-skill', name: 'tidy', text })).result, { path: join(home, 'skills', 'tidy', 'SKILL.md') });
    assert.deepEqual((await ask({ op: 'add-skill', projectId: 'p1', name: 'tidy', text })).result, { path: join(repo, '.codex', 'skills', 'tidy', 'SKILL.md') });
    const dup = await ask({ op: 'add-skill', name: 'tidy', text: 'other' });
    assert.deepEqual([dup.refused, dup.error], [true, 'a skill named tidy is there already']);
    assert.equal(readFileSync(join(home, 'skills', 'tidy', 'SKILL.md'), 'utf8'), text);
    // a skills folder that is a link: nothing is written through it
    rmSync(join(repo, '.codex', 'skills'), { recursive: true });
    symlinkSync(elsewhere, join(repo, '.codex', 'skills'));
    const linked = await ask({ op: 'add-skill', projectId: 'p1', name: 'escape', text });
    assert.equal(linked.refused, true);
    assert.match(linked.error, /not a folder of its own/);
    assert.equal(existsSync(join(elsewhere, 'escape')), false);
    for (const bad of [{ name: 'Bad Name', text }, { name: '../up', text }, { name: 'ok', text: ' ' }]) assert.equal((await ask({ op: 'add-skill', ...bad })).refused, true, JSON.stringify(bad));
  } finally { t.dispose(); rmSync(tmp, { recursive: true, force: true }); }
});
