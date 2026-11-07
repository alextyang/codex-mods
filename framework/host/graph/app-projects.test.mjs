// The Host's copy of the app's projects (app-projects.mjs): reports applied with what changed, a reset as a sync, the threads' facts as deltas,
// operations sent to framework-main and settled by its answers (or a timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppProjects } from './app-projects.mjs';

const REPO = { id: 'p1', name: 'repo', roots: ['/r'], createdAt: 1, updatedAt: 2 };
const SITE = { id: 'p2', name: 'site', roots: ['/s', '/t'] };

function setup(o = {}) {
  const sent = [];
  const store = createAppProjects({ send: (m) => sent.push(m), ...o });
  const changes = [];
  store.onChange((c) => changes.push(c));
  return { store, sent, changes, report: (extra) => store.apply({ type: 'projects', available: true, ...extra }) };
}

test('the first report is a sync; later ones say what changed', () => {
  const { store, changes, report } = setup();
  assert.equal(store.available, false);
  report({ projects: [SITE, REPO, { id: 'bad' }, { ...REPO, name: 'dup' }], selected: 'p1', threads: { t1: { project: 'p1' }, t2: { project: 'p2' }, t3: { project: 7 }, t4: 'x' }, reset: true });
  assert.equal(store.available, true);
  assert.deepEqual(store.list().map((p) => [p.id, p.name]), [['p2', 'site'], ['p1', 'repo']], 'in order; malformed and repeated ids left out');
  assert.deepEqual([store.selected, store.projectOf('t1'), store.projectOf('t2'), store.projectOf('t3'), store.factsOf('t4')], ['p1', 'p1', 'p2', null, null]);
  assert.deepEqual(changes, [{ sync: true, available: true, projects: { added: ['p2', 'p1'], removed: [], renamed: [], changed: [] }, selected: { from: null, to: 'p1' }, threads: ['t1', 't2'] }]);
  report({ projects: [SITE, { ...REPO, name: 'Repo' }] });
  report({ projects: [{ ...SITE, roots: ['/t'] }, { ...REPO, name: 'Repo' }] });
  report({ projects: [{ ...REPO, name: 'Repo' }, { ...SITE, roots: ['/t'] }] });
  report({ selected: null, threads: { t1: { project: 'p2' }, t2: null, t9: { projectless: true } } });
  report({ projects: [{ ...REPO, name: 'Repo' }] });
  assert.deepEqual(changes.slice(1), [
    { sync: false, projects: { added: [], removed: [], renamed: ['p1'], changed: ['p1'] } },
    { sync: false, projects: { added: [], removed: [], renamed: [], changed: ['p2'] } },
    { sync: false, projects: { added: [], removed: [], renamed: [], changed: [] } },   // reordered only
    { sync: false, selected: { from: 'p1', to: null }, threads: ['t1', 't2', 't9'] },
    { sync: false, projects: { added: [], removed: ['p2'], renamed: [], changed: [] } },
  ]);
  // A report that changes nothing is not announced.
  report({ projects: [{ ...REPO, name: 'Repo' }], selected: null, threads: { t1: { project: 'p2' } } });
  assert.equal(changes.length, 6);
});

test('projectOf follows the app\'s rule: assigned, else not projectless, then a root hint, then the deepest root holding the working directory', () => {
  const { store, report } = setup();
  const OUTER = { id: 'o', name: 'outer', roots: ['/w/'] }, INNER = { id: 'i', name: 'inner', roots: ['/w/app', '/x'] };
  report({ projects: [OUTER, INNER, REPO], selected: null, reset: true, threads: {
    a: { project: 'p1' }, b: { project: 'gone' }, c: { other: true }, d: { projectless: true }, e: { project: 'o', projectless: true },
    f: { root: '/x/' }, g: { root: '/nowhere' },
  } });
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((t) => store.projectOf(t, '/w/app/src')), ['p1', null, null, null, 'o'], 'what the app records wins over the working directory');
  assert.deepEqual([store.projectOf('f', '/w/app'), store.projectOf('g', '/w/app/src')], ['i', 'i'], 'a hint, else the working directory');
  assert.deepEqual([store.projectOf('h', '/w/app/src'), store.projectOf('h', '/w/apple'), store.projectOf('h', '/w'), store.projectOf('h', '/r/x'), store.projectOf('h', '/elsewhere'), store.projectOf('h', 'w/app'), store.projectOf('h', null)],
    ['i', 'o', 'o', 'p1', null, null, null], 'the deepest root that holds it, by whole path segments');
});

test('a reset replaces the threads\' facts and is a sync; unavailable keeps what was known', () => {
  const { store, changes, report } = setup();
  report({ projects: [REPO], selected: null, threads: { t1: { project: 'p1' }, t2: { project: 'p1' } }, reset: true });
  store.apply({ type: 'projects', available: false });
  assert.equal(store.available, false);
  assert.deepEqual([store.list().length, store.projectOf('t1')], [1, 'p1']);
  assert.deepEqual(changes.at(-1), { sync: true, available: false });
  store.apply({ type: 'projects', available: false });
  assert.equal(changes.length, 2, 'said once');
  report({ projects: [REPO], selected: null, threads: { t2: { project: 'p1' }, t3: { project: 'p1' } }, reset: true });
  assert.deepEqual(changes.at(-1), { sync: true, available: true, threads: ['t1', 't3'] });
  assert.deepEqual([store.projectOf('t1'), store.projectOf('t3')], [null, 'p1']);
});

test('operations go to framework-main and settle with its answer; refused without a store; a missing answer fails', async () => {
  const { store, sent, report } = setup({ timeoutMs: 30 });
  assert.deepEqual(await store.op('rename', 'p1', { name: 'x' }), { ok: false, error: 'the app\'s projects are not available', refused: true });
  assert.equal(sent.length, 0);
  report({ projects: [REPO], reset: true });
  const a = store.op('rename', 'p1', { name: 'x' });
  const b = store.op('remove', 'p1');
  assert.deepEqual(sent.map((m) => [m.type, m.op, m.projectId, m.name]), [['app-op', 'rename', 'p1', 'x'], ['app-op', 'remove', 'p1', undefined]]);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  store.settle({ type: 'app-op-done', requestId: sent[1].requestId, ok: false, error: 'no', refused: false });
  store.settle({ type: 'app-op-done', requestId: sent[0].requestId, ok: true, result: { entries: [] } });
  store.settle({ type: 'app-op-done', requestId: 'unknown', ok: true });
  assert.deepEqual(await a, { ok: true, result: { entries: [] } });
  store.op('list', 'p1', { path: '/r/src' });
  assert.deepEqual(sent.at(-1), { type: 'app-op', requestId: sent.at(-1).requestId, op: 'list', projectId: 'p1', path: '/r/src' });
  assert.deepEqual(await b, { ok: false, error: 'no', refused: false });
  assert.deepEqual(await store.op('reveal', 'p1'), { ok: false, error: 'framework-main did not answer in 30 ms', refused: false });
  const c = store.op('reveal', 'p1');
  store.dispose();
  assert.deepEqual(await c, { ok: false, error: 'the Host is shutting down', refused: false });
  assert.equal((await store.op('reveal', 'p1')).refused, true);
});

test('a listener that throws does not stop the others', () => {
  const warned = [];
  const store = createAppProjects({ log: { warn: (m) => warned.push(m) } });
  const seen = [];
  store.onChange(() => { throw new Error('boom'); });
  const sub = store.onChange((c) => seen.push(c.sync));
  store.apply({ type: 'projects', available: true, projects: [REPO], reset: true });
  sub.dispose();
  store.apply({ type: 'projects', available: true, projects: [] });
  assert.deepEqual(seen, [true]);
  assert.equal(warned.length, 2);
});
