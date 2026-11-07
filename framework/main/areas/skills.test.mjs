// framework-main's skills area: the app's recommendedSkills service, bounded calls, path guards, file tab and refresh. No real app,
// filesystem changes or network: the window's services are supplied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('./skills.cjs');

function setup(services) {
  let run;
  register({
    appHost: { first: () => services === null ? null : { id: 7, host: { services } } },
    onAreaOp(area, fn) { assert.equal(area, 'skills'); run = fn; },
  });
  return run;
}

test('library, install and remove use the local recommendedSkills service and return only their public fields', async () => {
  const calls = [];
  const entry = { id: 'alpha', name: 'Alpha', description: 'Long', shortDescription: 'Short', repoPath: 'skills/.curated/alpha' };
  const run = setup({ recommendedSkills: {
    async list(p) { calls.push(['list', p]); return { skills: [{ ...entry, iconSmall: '/secret/small.png', iconLarge: '/secret/large.png' }], repoRoot: '/secret/repo', source: 'bundled', fetchedAt: 1, error: null }; },
    async install(p) { calls.push(['install', p]); return { success: true, destination: '/fake/skills/alpha', error: null, private: 1 }; },
    async remove(p) { calls.push(['remove', p]); return { success: true, deletedPath: p.skillPath, error: null, private: 1 }; },
  } });
  assert.deepEqual(await run('library', {}), { skills: [entry], error: null });
  assert.deepEqual(await run('install', { skillId: entry.id, repoPath: entry.repoPath }), { success: true, destination: '/fake/skills/alpha', error: null });
  const skillPath = '/fake/skills/alpha/SKILL.md';
  assert.deepEqual(await run('remove', { skillPath }), { success: true, deletedPath: skillPath, error: null });
  assert.deepEqual(calls, [
    ['list', { hostId: 'local', refresh: false }],
    ['install', { hostId: 'local', skillId: entry.id, repoPath: entry.repoPath }],
    ['remove', { hostId: 'local', skillPath }],
  ]);
});

test('guards refuse paths before reaching a service; file opening requires a thread; unknown operations are refused', async () => {
  const actions = [];
  const run = setup({ appActions: { async runInPrimaryWindow(a) { actions.push(a); return { status: 'opened', viewer: 'text' }; } } });
  for (const skillPath of [undefined, 1, 'skills/a', '/fake/not-skills/a', '/fake/skills/../other']) {
    await assert.rejects(run('remove', { skillPath }), (e) => e.refused === true && /skills folder/.test(e.message));
  }
  for (const p of [undefined, 1, 'SKILL.md', 'skills/a/SKILL.md', '/fake/skills/a/OTHER.md', '/fake/skills/a/SKILL.md/']) {
    await assert.rejects(run('open', { path: p }), (e) => e.refused === true && /SKILL.md/.test(e.message));
  }
  const p = '/fake/skills/a/SKILL.md';
  assert.deepEqual(await run('open', { path: p }), {});
  assert.deepEqual(actions, [{ action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: p } } }]);
  const closed = setup({ appActions: { async runInPrimaryWindow() { throw new Error('windows.tabs.open requires a visible thread'); } } });
  await assert.rejects(closed('open', { path: p }), (e) => e.refused === true && e.message === 'the app shows a file beside a thread, and no thread is open');
  await assert.rejects(run('unknown', {}), (e) => e.refused === true && e.message === 'unknown operation unknown');
});

test('refresh invalidates the skills and library queries through the app cache', async () => {
  const calls = [];
  const run = setup({ queryCache: { async invalidateQueryCache(p) { calls.push(p); } } });
  assert.deepEqual(await run('refresh', { keys: [['skills'], ['recommendedSkills'], ['nope']] }), { refreshed: 2 });
  assert.deepEqual(calls, [{ queryKey: ['skills'], reset: false }, { queryKey: ['recommendedSkills'], reset: false }]);
});

test('missing windows and service methods refuse; service failures and unsuccessful results retain their meaning', async () => {
  const ops = [['library', {}], ['install', { skillId: 'a', repoPath: 'skills/a' }], ['remove', { skillPath: '/fake/skills/a' }], ['open', { path: '/fake/skills/a/SKILL.md' }], ['refresh', { keys: [['skills']] }]];
  for (const services of [null, {}, { recommendedSkills: {}, appActions: {}, queryCache: {} }]) {
    const run = setup(services);
    for (const [op, args] of ops) await assert.rejects(run(op, args), (e) => e.refused === true);
  }
  const error = new Error('service failed');
  const fail = async () => { throw error; };
  const run = setup({ recommendedSkills: { list: fail, install: fail, remove: fail }, appActions: { runInPrimaryWindow: fail }, queryCache: { invalidateQueryCache: fail } });
  for (const [op, args] of ops) await assert.rejects(run(op, args), (e) => e === error && !e.refused);
  const rejected = setup({ recommendedSkills: {
    async list() { return { skills: [], error: 'catalog failed' }; },
    async install() { return { success: false, error: 'install failed' }; },
    async remove() { return { success: false, error: 'remove failed' }; },
  } });
  assert.deepEqual(await rejected('library', {}), { skills: [], error: 'catalog failed' });
  assert.deepEqual(await rejected('install', {}), { success: false, destination: undefined, error: 'install failed' });
  assert.deepEqual(await rejected('remove', { skillPath: '/fake/skills/a' }), { success: false, deletedPath: undefined, error: 'remove failed' });
});

test('each service call has a finite timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise(() => {});
  const run = setup({ recommendedSkills: { list: never, install: never, remove: never }, appActions: { runInPrimaryWindow: never }, queryCache: { invalidateQueryCache: never } });
  for (const [op, args] of [['library', {}], ['install', {}], ['remove', { skillPath: '/fake/skills/a' }], ['open', { path: '/fake/skills/a/SKILL.md' }], ['refresh', { keys: [['skills']] }]]) {
    const done = assert.rejects(run(op, args), (e) => !e.refused && /did not answer/.test(e.message));
    t.mock.timers.tick(15_000);
    await done;
  }
});
