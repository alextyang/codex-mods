// ProjectAction in the native provider (breadth step D3; actions.mjs): a project's actions from the environment config the app selected, the
// config watched, and run() the app's way (framework-main's run-action), with `ran`. The graph runtime with the feed; the test plays
// framework-main's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { actionsData, actionTypes, createActionFeed } from '../actions.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const CFG = '/r/.codex/environments/environment.toml';
const OTHER = '/r/.codex/environments/other.toml';

test('actionsData: the selected config\'s actions, named by project, config and place; enabled for this platform; none without a selection', () => {
  const r = { selected: CFG, configs: [{ configPath: CFG, name: 'qa-env', actions: [{ name: 'Run', icon: 'run', command: 'make run', platform: null }, { name: 'Apt', icon: null, command: 'apt', platform: 'linux' }] }] };
  const out = actionsData('p1', r, 'darwin');
  assert.deepEqual(out.map((d) => [d.ref, d.state, d.links]), [
    [refs.projectAction('p1', CFG, 0), { title: 'Run', category: 'qa-env', enabled: true, command: 'make run', icon: 'run' }, { project: refs.project('p1') }],
    [refs.projectAction('p1', CFG, 1), { title: 'Apt', category: 'qa-env', enabled: false, command: 'apt' }, { project: refs.project('p1') }],
  ]);
  assert.equal(out[0].ref.id, `p1:${CFG}#0`);
  assert.deepEqual(actionsData('p1', { ...r, selected: null }), [], '"no environment"');
});

function setup() {
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  let feed = null;
  const handle = graph.registerProvider('native', 'codex', { types: actionTypes({ run: (...a) => feed.run(...a) }) });
  const state = { selected: CFG, configs: [{ configPath: CFG, name: 'qa-env', actions: [{ name: 'Run', icon: 'run', command: 'make run', platform: null }, { name: 'Test', icon: 'test', command: 'make test', platform: null }] }, { configPath: OTHER, name: 'other', actions: [] }] };
  const calls = [];
  const rpcs = [];
  let shown = true;
  let store = null;
  store = createAppProjects({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => {
    calls.push([m.op, m.projectId, m.path, m.index, m.threadId, m.cwd]);
    const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
    if (m.op === 'actions') return done({ ok: true, result: structuredClone(state) });
    if (m.op === 'run-action') return shown ? done({ ok: true, result: { sessionId: 's1' } }) : done({ ok: false, refused: true, error: 'the app runs an action in a thread\'s terminal, and no thread is open' });
    return done({ ok: true });
  }) });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'ProjectAction') events.push([e.name, e.ref.id]); });
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  feed = createActionFeed({ handle, appProjects: store, resident, safe: (w, fn) => fn(), emitEvent: (r, name) => handle.emit(r, name), log: quiet, rpc: async (method, params) => { rpcs.push([method, params]); return {}; }, cwdOf: (id) => (id === 't1' ? '/h/worktrees/1/repo' : null) });
  store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }], selected: null, threads: {}, reset: true });
  return { graph, feed, store, state, calls, rpcs, events, setShown: (v) => { shown = v; }, close() { feed.dispose(); store.dispose(); graph.close(); } };
}
const mod = { kind: 'mod', id: 'mod.a' };

test('a project\'s actions come with the app\'s projects; its configs are watched; a change of selection reads them again', async () => {
  const s = setup();
  try {
    const run = refs.projectAction('p1', CFG, 0);
    await until(() => s.graph.resolve(run), 2000, 'the actions');
    assert.deepEqual(s.graph.referrers(refs.project('p1'), 'project').map((x) => x.ref.id).sort(), [`p1:${CFG}#0`, `p1:${CFG}#1`], 'Project.actions, its inverse');
    assert.deepEqual(s.rpcs.filter(([m]) => m === 'fs/watch').map(([, q]) => q.path).sort(), [CFG, OTHER]);
    s.state.selected = OTHER;
    const watchId = s.rpcs.find(([m, q]) => m === 'fs/watch' && q.path === CFG)[1].watchId;
    s.feed.changed({ watchId, changedPaths: [CFG] });
    await until(() => !s.graph.resolve(run) || s.graph.resolve(run).gone, 2000, 'the actions gone');
    assert.equal(s.graph.list('ProjectAction').filter((x) => !x.gone).length, 0, 'the other config has none');
  } finally { s.close(); }
});

test('run: framework-main runs the action named by its config and place, beside a named thread and in its folder; ran follows; refusals carry over', async () => {
  const s = setup();
  try {
    const run = refs.projectAction('p1', CFG, 1);
    await until(() => s.graph.resolve(run), 2000, 'the actions');
    assert.equal((await s.graph.invoke({ ref: run, operation: 'run', args: [], caller: mod })).status, 'done');
    assert.equal((await s.graph.invoke({ ref: run, operation: 'run', args: [{ thread: refs.thread('t1') }], caller: mod })).status, 'done');
    assert.deepEqual(s.calls.filter(([op]) => op === 'run-action'), [['run-action', 'p1', CFG, 1, undefined, undefined], ['run-action', 'p1', CFG, 1, 't1', '/h/worktrees/1/repo']], 'a named thread\'s own folder');
    assert.deepEqual(s.events, [['ran', run.id], ['ran', run.id]]);
    assert.equal((await s.graph.invoke({ ref: run, operation: 'run', args: [{ thread: refs.file('/x') }], caller: mod })).reason, 'invalid');
    s.setShown(false);
    const out = await s.graph.invoke({ ref: run, operation: 'run', args: [], caller: mod });
    assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    assert.equal(s.events.length, 2, 'no ran when nothing ran');
  } finally { s.close(); }
});
