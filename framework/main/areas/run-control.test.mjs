// Framework-main's clipboard and Edit of the last message, using supplied services and a stub of the app's follower request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kit = require('../area-kit.cjs');
const { register } = require('./run-control.cjs');

function setup(services = {}) {
  let run;
  const hooks = {
    appHost: { first: () => services === null ? null : { id: 7, host: { services } } },
    onAreaOp(area, fn) { assert.equal(area, 'run-control'); run = fn; },
  };
  register(hooks);
  return { run, hooks };
}

test('copy writes the exact text through the clipboard service, including empty text and the size bound', async () => {
  const calls = [];
  const clipboard = { async writeText(text) { assert.equal(this, clipboard); calls.push(text); } };
  const { run } = setup({ clipboard });
  for (const text of ['a\n**b**\n', '', 'x'.repeat(10_000_000)]) assert.deepEqual(await run('copy', { text }), {});
  assert.deepEqual(calls, ['a\n**b**\n', '', 'x'.repeat(10_000_000)]);
});

test('copy guards its text before reaching the clipboard; missing windows and services refuse', async () => {
  let calls = 0;
  const { run } = setup({ clipboard: { writeText() { calls++; } } });
  for (const text of [undefined, null, 1, {}, [], 'x'.repeat(10_000_001)]) {
    await assert.rejects(run('copy', { text }), (e) => e.refused === true && /text/.test(e.message));
  }
  for (const args of [undefined, null]) await assert.rejects(run('copy', args), (e) => e.refused === true);
  assert.equal(calls, 0);
  for (const services of [null, {}, { clipboard: {} }, { clipboard: { writeText: true } }]) {
    await assert.rejects(setup(services).run('copy', { text: 'x' }), (e) => e.refused === true);
  }
});

test('copy failures stay failures and a clipboard call that never answers has the kit deadline', async (t) => {
  const error = new Error('clipboard failed');
  await assert.rejects(setup({ clipboard: { writeText() { throw error; } } }).run('copy', { text: 'x' }), (e) => e === error && !e.refused);
  await assert.rejects(setup({ clipboard: { async writeText() { throw error; } } }).run('copy', { text: 'x' }), (e) => e === error && !e.refused);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { run } = setup({ clipboard: { writeText: () => new Promise(() => {}) } });
  const done = assert.rejects(run('copy', { text: 'x' }), (e) => !e.refused && /the app did not answer in 15000 ms/.test(e.message));
  t.mock.timers.tick(15_000);
  await done;
});

test('edit-last-turn calls the owning window with only the app edit parameters', async (t) => {
  const calls = [];
  t.mock.method(kit, 'followerRequest', async (...args) => { calls.push(args); return { private: true }; });
  const { run, hooks } = setup();
  const args = { threadId: 't', turnId: 'u', message: 'new\nmessage', mode: 'ignored', serviceTier: 'ignored', permissions: 'ignored' };
  assert.deepEqual(await run('edit-last-turn', args), {});
  assert.deepEqual(calls, [[hooks, 't', 'thread-follower-edit-last-user-turn', { conversationId: 't', turnId: 'u', message: 'new\nmessage', allowEarlierMessages: false }]]);
  assert.deepEqual(await run('edit-last-turn', { threadId: 't'.repeat(200), turnId: 'u'.repeat(200), message: 'm'.repeat(1_000_000) }), {});
});

test('edit-last-turn guards every input and unknown operations refuse before dispatch', async (t) => {
  const call = t.mock.method(kit, 'followerRequest', async () => {});
  const { run } = setup();
  const valid = { threadId: 't', turnId: 'u', message: 'message' };
  for (const name of ['threadId', 'turnId', 'message']) {
    const max = name === 'message' ? 1_000_000 : 200;
    for (const value of [undefined, null, '', '   ', 1, {}, [], 'x'.repeat(max + 1)]) {
      await assert.rejects(run('edit-last-turn', { ...valid, [name]: value }), (e) => e.refused === true && e.message.includes(name));
    }
  }
  for (const args of [undefined, null]) await assert.rejects(run('edit-last-turn', args), (e) => e.refused === true);
  for (const op of ['unknown', '__proto__', 'constructor']) await assert.rejects(run(op, valid), (e) => e.refused === true && e.message === `unknown operation ${op}`);
  assert.equal(call.mock.callCount(), 0);
});

test('each app edit refusal is preserved as a refusal; another error stays a failure', async (t) => {
  let error;
  t.mock.method(kit, 'followerRequest', async () => { throw error; });
  const { run } = setup();
  const args = { threadId: 't', turnId: 'u', message: 'message' };
  for (const message of [
    'Only the most recent message can be edited.',
    'Cannot edit a message while a turn is in progress.',
    'Turn not found for edit.',
    'Editing messages is not available for threads using paginated history without threadRevert.',
  ]) {
    error = new Error(message);
    await assert.rejects(run('edit-last-turn', args), (e) => e.refused === true && e.message === message);
  }
  error = new Error('the app lost its connection');
  await assert.rejects(run('edit-last-turn', args), (e) => e === error && !e.refused);
  error = kit.refusal('no window of the app holds the chat');
  await assert.rejects(run('edit-last-turn', args), (e) => e === error && e.refused === true);
});
