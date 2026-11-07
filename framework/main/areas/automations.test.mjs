// Local automation service calls with fake window services. No app, Codex home, model traffic or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('./automations.cjs');
const cron = () => ({ id: 'daily', kind: 'cron', name: 'Daily', prompt: 'Check', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9',
  target: { type: 'project', projectId: 'p' }, executionEnvironment: 'worktree', localEnvironmentConfigPath: '/r/env.toml',
  model: 'fake', reasoningEffort: 'low', notificationPolicy: 'failed_runs_only', autoArchive: false,
  nextRunAt: 1_700_086_400_000, lastRunAt: 1_700_000_000_000, private: 'omit' });
const heartbeat = () => ({ id: 'watch', kind: 'heartbeat', name: 'Watch', prompt: 'Look', status: 'PAUSED', targetThreadId: 't',
  model: 'ignored', reasoningEffort: 'ignored', rrule: 'FREQ=MINUTELY;INTERVAL=5', private: 'omit' });

function setup(services) {
  let run;
  const posts = [];
  register({
    appHost: { first: () => services === null ? null : { id: 7, host: { services } }, windows: () => [{ id: 7 }, { id: 9 }] },
    electron: { postToWindow(...args) { posts.push(args); } },
    onAreaOp(area, fn) { assert.equal(area, 'automations'); run = fn; },
  });
  return { run, posts };
}
const refreshes = () => [7, 9].map((id) => [id, 'codex_desktop:message-for-view', { type: 'automation-runs-updated' }]);
const isRefused = (message) => (e) => e.refused === true && (!message || e.message === message);

test('list maps only the definition and run fields, fills absent fields with null and detects migration strictly', async () => {
  const calls = [];
  let migrated = true;
  const { run, posts } = setup({ localAutomations: {
    async list() { calls.push(['list']); return { items: [cron(), heartbeat(), { id: 'empty', target: { type: 'projectless', projectId: 'ignored' } }], habitatMigrationComplete: migrated }; },
    async readHistory(args) { calls.push(['readHistory', args]); return { items: [{ threadId: 'run', automationId: 'daily', status: 'IN_PROGRESS', createdAt: 123, prompt: 'omit' }, {}], unreadRunCounts: { daily: 1 } }; },
  } });
  const result = await run('list', {});
  assert.deepEqual(result, {
    automations: [
      { id: 'daily', kind: 'cron', name: 'Daily', prompt: 'Check', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9', nextRunAt: 1_700_086_400_000,
        lastRunAt: 1_700_000_000_000, model: 'fake', reasoningEffort: 'low', notificationPolicy: 'failed_runs_only', executionEnvironment: 'worktree',
        localEnvironmentConfigPath: '/r/env.toml', autoArchive: false, projectId: 'p', targetThreadId: null },
      { id: 'watch', kind: 'heartbeat', name: 'Watch', prompt: 'Look', status: 'PAUSED', rrule: 'FREQ=MINUTELY;INTERVAL=5', nextRunAt: null,
        lastRunAt: null, model: 'ignored', reasoningEffort: 'ignored', notificationPolicy: null, executionEnvironment: null,
        localEnvironmentConfigPath: null, autoArchive: null, projectId: null, targetThreadId: 't' },
      { id: 'empty', kind: null, name: null, prompt: null, status: null, rrule: null, nextRunAt: null, lastRunAt: null, model: null,
        reasoningEffort: null, notificationPolicy: null, executionEnvironment: null, localEnvironmentConfigPath: null, autoArchive: null,
        projectId: null, targetThreadId: null },
    ],
    runs: [{ threadId: 'run', automationId: 'daily', status: 'IN_PROGRESS', createdAt: 123 }, { threadId: null, automationId: null, status: null, createdAt: null }], migrated: true,
  });
  assert.deepEqual(calls, [['list'], ['readHistory', { limit: 200 }]]);
  assert.deepEqual(posts, []);
  for (migrated of [undefined, false, 'true']) assert.equal((await run('list', {})).migrated, false);
});

test('run-now and delete use id objects, return no service data, and notify every window after success', async () => {
  const calls = [];
  const { run, posts } = setup({ localAutomations: {
    async runNow(args) { assert.deepEqual(posts, []); calls.push(['runNow', args]); return { success: true, private: 1 }; },
    async delete(args) { calls.push(['delete', args]); return { success: true, item: cron(), status: 'deleted' }; },
  } });
  assert.deepEqual(await run('run-now', { id: 'daily' }), {});
  assert.deepEqual(posts, refreshes());
  assert.deepEqual(await run('delete', { id: 'daily' }), {});
  assert.deepEqual(posts, [...refreshes(), ...refreshes()]);
  assert.deepEqual(calls, [['runNow', { id: 'daily', collaborationMode: null, permissions: null }], ['delete', { id: 'daily' }]]);
});

test('updates rebuild the whole cron or heartbeat definition, omit undefined values and apply only the allowed changes', async () => {
  const updates = [];
  let items = [cron(), heartbeat()];
  const { run, posts } = setup({ localAutomations: {
    async list() { return { items }; },
    async update(args) { updates.push(args); return { item: args, private: 1 }; },
  } });
  assert.deepEqual(await run('update', { id: 'daily', changes: { name: 'Renamed', prompt: '', status: 'PAUSED', rrule: 'FREQ=HOURLY' } }), {});
  assert.deepEqual(updates[0], { id: 'daily', kind: 'cron', name: 'Renamed', prompt: '', status: 'PAUSED', projectId: 'p', executionEnvironment: 'worktree',
    localEnvironmentConfigPath: '/r/env.toml', model: 'fake', reasoningEffort: 'low', notificationPolicy: 'failed_runs_only', autoArchive: false, rrule: 'FREQ=HOURLY' });
  assert.deepEqual(await run('update', { id: 'watch', changes: { status: 'ACTIVE', prompt: 'Watch now' } }), {});
  assert.deepEqual(updates[1], { id: 'watch', kind: 'heartbeat', name: 'Watch', prompt: 'Watch now', status: 'ACTIVE', targetThreadId: 't', model: null, reasoningEffort: null, rrule: 'FREQ=MINUTELY;INTERVAL=5' });
  items = [{ id: 'daily', kind: 'cron', name: 'Sparse', status: 'PAUSED', target: { type: 'projectless' } }];
  await run('update', { id: 'daily', changes: { status: 'ACTIVE' } });
  assert.deepEqual(updates[2], { id: 'daily', kind: 'cron', name: 'Sparse', status: 'ACTIVE', projectId: null });
  assert.deepEqual(posts, [...refreshes(), ...refreshes(), ...refreshes()]);
  await assert.rejects(run('update', { id: 'gone', changes: {} }), isRefused('the automation is gone'));
  assert.equal(updates.length, 3);
});

test('ids and update changes are guarded before reaching the service, and unknown operations refuse', async () => {
  const { run } = setup(null);
  for (const id of [undefined, null, 1, '', '  ', 'x'.repeat(201)]) for (const op of ['run-now', 'update', 'delete']) {
    await assert.rejects(run(op, { id, changes: {} }), isRefused('an automation id of at most 200 characters is needed'));
  }
  for (const changes of [undefined, null, [], 'name', { name: 1 }, { prompt: null }, { rrule: {} }, { status: 'DELETED' }, { status: 'active' }, { model: 'x' }, { id: 'other' }]) {
    await assert.rejects(run('update', { id: 'daily', changes }), (e) => e.refused === true && /changes must be/.test(e.message));
  }
  await assert.rejects(run('unknown', {}), isRefused('unknown operation unknown'));
  const accepted = setup({ localAutomations: { async delete({ id }) { assert.equal(id.length, 200); return { success: true }; } } });
  await accepted.run('delete', { id: 'x'.repeat(200) });
});

test('missing services refuse, exceptions propagate and a failed delete throws its status without refreshing', async () => {
  const ops = [['list', {}], ['run-now', { id: 'daily' }], ['update', { id: 'daily', changes: {} }], ['delete', { id: 'daily' }]];
  for (const services of [null, {}, { localAutomations: {} }]) {
    const { run, posts } = setup(services);
    for (const [op, args] of ops) await assert.rejects(run(op, args), isRefused());
    assert.deepEqual(posts, []);
  }
  const error = new Error('service failed');
  const fail = async () => { throw error; };
  const { run, posts } = setup({ localAutomations: { list: fail, readHistory: fail, runNow: fail, update: fail, delete: fail } });
  for (const [op, args] of ops) await assert.rejects(run(op, args), (e) => e === error);
  assert.deepEqual(posts, []);
  const rejected = setup({ localAutomations: { async delete() { return { success: false, status: 'state_cleanup_failed' }; } } });
  await assert.rejects(rejected.run('delete', { id: 'daily' }), (e) => !e.refused && e.message === 'state_cleanup_failed');
  assert.deepEqual(rejected.posts, []);
});

test('every service call is bounded, including the history read and the whole-item write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise(() => {});
  for (const [op, args, service] of [
    ['list', {}, { list: never, readHistory: never }],
    ['list', {}, { list: async () => ({ items: [] }), readHistory: never }],
    ['run-now', { id: 'daily' }, { runNow: never }],
    ['update', { id: 'daily', changes: {} }, { list: never, update: never }],
    ['update', { id: 'daily', changes: {} }, { list: async () => ({ items: [cron()] }), update: never }],
    ['delete', { id: 'daily' }, { delete: never }],
  ]) {
    const { run, posts } = setup({ localAutomations: service });
    const done = assert.rejects(run(op, args), (e) => !e.refused && /did not answer/.test(e.message));
    await new Promise(setImmediate);
    t.mock.timers.tick(15_000);
    await done;
    assert.deepEqual(posts, []);
  }
});

test('E7 rework: create is the service\'s own, with the item the app builds (local runs, null model and effort when absent); open navigates where it is managed', async () => {
  const items = [];
  const { run, posts } = setup({ localAutomations: { async create(item) { items.push(item); return { item: { id: `a-${items.length}`, ...item } }; } } });
  assert.deepEqual(await run('create', { item: { kind: 'cron', name: 'Daily', prompt: 'Check', projectId: null, model: null, reasoningEffort: null, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', extra: 1 } }), { id: 'a-1' });
  assert.deepEqual(items[0], { kind: 'cron', name: 'Daily', prompt: 'Check', status: 'ACTIVE', projectId: null, executionEnvironment: 'local', localEnvironmentConfigPath: null,
    model: null, reasoningEffort: null, autoArchive: false, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
  assert.deepEqual(posts, refreshes());
  await run('create', { item: { kind: 'heartbeat', name: 'Watch', prompt: 'Keep watch', status: 'PAUSED', targetThreadId: 'th-1', notificationPolicy: 'failed_runs_only', rrule: 'FREQ=MINUTELY;INTERVAL=5' } });
  assert.deepEqual(items[1], { kind: 'heartbeat', name: 'Watch', prompt: 'Keep watch', status: 'PAUSED', targetThreadId: 'th-1', model: null, reasoningEffort: null, notificationPolicy: 'failed_runs_only', rrule: 'FREQ=MINUTELY;INTERVAL=5' });
  for (const item of [null, { kind: 'cron', name: '', prompt: 'x', projectId: null, model: null, reasoningEffort: null, rrule: 'FREQ=DAILY' },
    { kind: 'cron', name: 'n', prompt: 'x', projectId: null, model: null, reasoningEffort: 'loud', rrule: 'FREQ=DAILY' },
    { kind: 'cron', name: 'n', prompt: 'x', projectId: null, model: null, reasoningEffort: null, rrule: 'FREQ=DAILY; DROP TABLE' },
    { kind: 'heartbeat', name: 'n', prompt: 'x', rrule: 'FREQ=DAILY' }]) {
    await assert.rejects(run('create', { item }), isRefused());
  }
  assert.equal(items.length, 2);
  // open: the automation's page, or the chat a heartbeat watches, in the window given or the one the user is in
  const opened = [];
  register({
    appHost: { first: () => null, windows: () => [] },
    electron: { focusedWindow: () => 9, postToWindow(...args) { opened.push(args); } },
    onAreaOp(area, fn) { if (area === 'automations') { fn('open', { id: 'a-1' }).then(() => fn('open', { id: 'a-2', threadId: 'th-1', windowId: 7 })); } },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(opened.map(([id, , m]) => [id, m.path]), [[9, '/automations?automationId=a-1'], [7, '/local/th-1']]);
});

test('H7pa review: framework-main\'s own list reads only the app\'s automations and runs, a mod\'s never (the codex provider takes them for Codex\'s); the Host gone hides theirs', async () => {
  const { createUserActions } = require('../user-actions.cjs');
  const { createUserHolds } = require('../user-holds.cjs');
  const { providedOf } = require('../provided-automations.cjs');
  class Automations {
    async list() { return { items: [cron()] }; }
    async readHistory() { return { items: [{ threadId: 'run', automationId: 'daily', status: 'ACCEPTED', createdAt: 1 }], unreadRunCounts: { total: 0, automationIds: [], unreadRuns: [] } }; }
    async create() { return {}; } async update() { return {}; } async delete() { return {}; } async runNow() { return {}; }
  }
  const services = { localAutomations: new Automations() };
  let run, hostState = null;
  const posts = [];
  const hooks = {
    appHost: { first: () => ({ id: 7, host: { services } }), windows: () => [{ id: 7 }] },
    electron: { postToWindow(...args) { posts.push(args); } },
    onAreaOp(area, fn) { run = fn; },
    onHostState(fn) { hostState = fn; },
  };
  register(hooks);
  createUserActions({ holds: createUserHolds({ send() {} }), provided: providedOf(hooks) }).hold(services);
  await run('provided', { items: [{ id: 'codexmods-x', kind: 'cron', name: 'Mine', status: 'ACTIVE', rrule: 'FREQ=HOURLY' }] });
  assert.deepEqual((await services.localAutomations.list()).items.map((x) => x.id), ['daily', 'codexmods-x'], 'the app\'s pages see both');
  const own = await run('list', {});
  assert.deepEqual([own.automations.map((x) => x.id), own.runs.map((x) => x.threadId)], [['daily'], ['run']], 'framework-main\'s own read: the app\'s only');
  hostState(false);
  assert.deepEqual((await services.localAutomations.list()).items.map((x) => x.id), ['daily'], 'the Host gone: theirs not shown');
  assert.ok(posts.some(([, , m]) => m.type === 'automation-runs-updated'), 'the pages read them again');
});
