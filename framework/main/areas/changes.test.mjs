// The changes area's app calls, with fake window services. No application, repository, credentials or network are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./changes.cjs');
const diff = 'private patch content';
const args = { cwd: '/repo', diff, revert: true, atomic: true, threadId: 't', path: '/repo/a', appId: 'editor' };
const ops = ['apply-patch', 'view-diff', 'open-file', 'open-in'];

function setup() {
  const calls = [], replies = { requestGitWorker: { status: 'success' }, open: { success: true } };
  const method = (name) => async (p) => { calls.push([name, p]); return replies[name]; };
  const services = { openIn: { requestGitWorker: method('requestGitWorker'), open: method('open') }, appActions: { runInPrimaryWindow: method('runInPrimaryWindow') } };
  let run;
  const hooks = { appHost: { first: () => ({ id: 7, host: { services } }) }, onAreaOp(area, fn) { assert.equal(area, 'changes'); run = fn; } };
  register(hooks);
  return { calls, replies, services, hooks, run };
}

test('patches, diff and file tabs, and open-in use the exact app service arguments', async () => {
  const s = setup();
  for (const op of ops) assert.deepEqual(await s.run(op, args), {});
  assert.deepEqual(s.calls, [
    ['requestGitWorker', { method: 'apply-patch', params: { cwd: '/repo', diff, revert: true, atomic: true, operationSource: 'thread_diff' } }],
    ['runInPrimaryWindow', { action: { type: 'windows.show_thread', windowId: 'current', threadId: 't' } }],
    ['runInPrimaryWindow', { action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'review', view: 'last-turn', path: '/repo/a' }, threadId: 't' } }],
    ['runInPrimaryWindow', { action: { type: 'windows.show_thread', windowId: 'current', threadId: 't' } }],
    ['runInPrimaryWindow', { action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/repo/a' }, threadId: 't' } }],
    ['open', { path: '/repo/a', cwd: '/repo', target: 'editor', hostId: 'local' }],
  ]);
  await s.run('apply-patch', { cwd: '/repo', diff, revert: 1, atomic: 'true' });
  assert.deepEqual(s.calls.at(-1)[1].params, { cwd: '/repo', diff, revert: false, atomic: false, operationSource: 'thread_diff' });
});

test('worker failures report their status and paths, without the diff or worker output', async () => {
  const s = setup();
  for (const status of ['partial-success', 'error', undefined]) {
    s.replies.requestGitWorker = { status, conflictedPaths: ['a', 'b'], skippedPaths: ['c'], diff, execOutput: diff };
    await assert.rejects(s.run('apply-patch', args), (e) => !e.refused && e.message === `git apply: ${status ?? 'no status'}; conflictedPaths: a, b; skippedPaths: c` && !e.message.includes(diff));
  }
  s.replies.requestGitWorker = null;
  await assert.rejects(s.run('apply-patch', args), /no status/);
  s.replies.open = { success: false };
  await assert.rejects(s.run('open-in', args), (e) => !e.refused && /could not open it in editor/.test(e.message));
});

test('guards refuse before dispatch, including missing arguments and unknown operations', async () => {
  const s = setup();
  for (const op of ops) for (const a of [undefined, null, {}]) await assert.rejects(s.run(op, a), (e) => e.refused);
  for (const p of [undefined, null, 3, '', 'a', './a']) {
    for (const op of ['view-diff', 'open-file', 'open-in']) await assert.rejects(s.run(op, { ...args, path: p }), (e) => e.refused);
    await assert.rejects(s.run('apply-patch', { ...args, cwd: p }), (e) => e.refused);
  }
  for (const value of [undefined, null, 3, '', ' ', 'x'.repeat(201)]) {
    for (const op of ['view-diff', 'open-file']) await assert.rejects(s.run(op, { ...args, threadId: value }), (e) => e.refused);
    await assert.rejects(s.run('open-in', { ...args, appId: value }), (e) => e.refused);
  }
  for (const value of [undefined, null, 3, '', '  ']) await assert.rejects(s.run('apply-patch', { ...args, diff: value }), (e) => e.refused);
  for (const op of ['unknown', '__proto__']) await assert.rejects(s.run(op, args), (e) => e.refused && e.message === `unknown operation ${op}`);
  assert.deepEqual(s.calls, []);
  await s.run('view-diff', { ...args, threadId: 'x'.repeat(200) });
  await s.run('open-in', { ...args, appId: 'x'.repeat(200) });
});

test('tabs explain the visible-thread refusal; attempted service failures retain their meaning', async () => {
  const s = setup();
  s.services.appActions.runInPrimaryWindow = async () => { throw new Error('windows.tabs.open requires a visible thread'); };
  for (const op of ['view-diff', 'open-file']) await assert.rejects(s.run(op, args), (e) => e.refused && e.message === `the app shows a ${op === 'view-diff' ? 'diff' : 'file'} beside a chat, and no chat is open`);
  for (const [op, service, method] of [['apply-patch', 'openIn', 'requestGitWorker'], ['open-in', 'openIn', 'open'], ['view-diff', 'appActions', 'runInPrimaryWindow'], ['open-file', 'appActions', 'runInPrimaryWindow']]) {
    const s = setup(), error = new Error('service failed');
    s.hooks.appHost.first = () => null;
    await assert.rejects(s.run(op, args), (e) => e.refused && /window/.test(e.message));
    s.hooks.appHost.first = () => ({ host: { services: s.services } });
    const saved = s.services[service];
    delete s.services[service];
    await assert.rejects(s.run(op, args), (e) => e.refused && e.message.includes(service));
    s.services[service] = saved;
    delete saved[method];
    await assert.rejects(s.run(op, args), (e) => e.refused && e.message.includes(method));
    saved[method] = async () => { throw error; };
    await assert.rejects(s.run(op, args), (e) => e === error && !e.refused);
  }
});

test('every app service call has the kit deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(), never = () => new Promise(() => {});
  s.services.openIn = { requestGitWorker: never, open: never };
  s.services.appActions.runInPrimaryWindow = never;
  for (const op of ops) {
    const done = assert.rejects(s.run(op, args), (e) => !e.refused && /did not answer in 15000 ms/.test(e.message));
    t.mock.timers.tick(15_000);
    await done;
  }
});
