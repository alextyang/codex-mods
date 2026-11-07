// framework-main's shared pieces for feature-area modules (area-kit.cjs): the window's services or a refusal, the app's own page refresh
// (only known key roots), and opening a page on the app's channel to its pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kit = require('./area-kit.cjs');

function hooksWith(services, posted = []) {
  return {
    appHost: { first: () => (services ? { id: 7, host: { services } } : null) },
    electron: { postToWindow: (id, channel, msg) => posted.push([id, channel, msg]) },
  };
}

test('the window\'s services, a service with its methods, or a refusal that says nothing was tried', () => {
  assert.throws(() => kit.windowServices(hooksWith(null)), (e) => e.refused === true && /no window/.test(e.message));
  const svc = { list() {} };
  assert.deepEqual(kit.service(hooksWith({ skills: svc }), 'skills', ['list']), { winId: 7, svc });
  assert.throws(() => kit.service(hooksWith({}), 'skills'), (e) => e.refused && /no skills service/.test(e.message));
  assert.throws(() => kit.service(hooksWith({ skills: svc }), 'skills', ['remove']), (e) => e.refused && /has no remove/.test(e.message));
});

test('invalidate: the app\'s queryCache for each key whose root it knows; others are dropped', async () => {
  const calls = [];
  const hooks = hooksWith({ queryCache: { async invalidateQueryCache(a) { calls.push(a); } } });
  assert.equal(await kit.invalidate(hooks, [['config'], ['mcp', 'servers', 'status'], ['nope'], [], 'x']), 2);
  assert.deepEqual(calls, [{ queryKey: ['config'], reset: false }, { queryKey: ['mcp', 'servers', 'status'], reset: false }]);
  assert.equal(await kit.invalidate(hooks, []), 0);
  await assert.rejects(kit.invalidate(hooksWith({}), [['config']]), (e) => e.refused === true);
});

test('navigate: the app\'s navigate-to-route on its channel to its pages', () => {
  const posted = [];
  kit.navigate(hooksWith({}, posted), 7, '/plugins/browser@openai-bundled');
  kit.navigate(hooksWith({}, posted), 7, '/skills', { initialTab: 'skills' });
  assert.deepEqual(posted, [
    [7, 'codex_desktop:message-for-view', { type: 'navigate-to-route', path: '/plugins/browser@openai-bundled' }],
    [7, 'codex_desktop:message-for-view', { type: 'navigate-to-route', path: '/skills', state: { initialTab: 'skills' } }],
  ]);
  assert.throws(() => kit.navigate(hooksWith({}, posted), 7, 'plugins'), (e) => e.refused);
  kit.runCommand(hooksWith({}, posted), 7, 'archiveThread');
  kit.postToView(hooksWith({}, posted), 7, { type: 'focus-composer' });
  assert.deepEqual(posted.slice(-2).map((p) => p[2]), [{ type: 'run-command', id: 'archiveThread' }, { type: 'focus-composer' }]);
  assert.throws(() => kit.runCommand(hooksWith({}, posted), 7, ''), (e) => e.refused);
});

test('appAction in the primary window; the app\'s global state, or a refusal', async () => {
  const actions = [];
  const store = { get: (k) => (k === 'selected-project' ? { type: 'local', projectId: 'p' } : null), onDidChange() {} };
  const hooks = hooksWith({ appActions: { async runInPrimaryWindow(a) { actions.push(a); return { ok: true }; } }, projects: { globalState: store } });
  assert.deepEqual(await kit.appAction(hooks, { type: 'windows.show_home', windowId: 'current' }), { ok: true });
  assert.deepEqual(actions, [{ action: { type: 'windows.show_home', windowId: 'current' } }]);
  assert.equal(kit.globalState(hooks), store);
  assert.throws(() => kit.globalState(hooksWith({})), (e) => e.refused);
  await assert.rejects(kit.appAction(hooksWith({}), {}), (e) => e.refused);
});

test('followerRequest: the window that owns the chat runs the app\'s request; a chat no window holds is shown first', async () => {
  const log = [];
  let owned = new Set(['t-open']);
  const view = (id) => ({ services: { clientCoordination: {
    async getThreadRole({ hostId, conversationId }) { log.push(['role', id, hostId, conversationId]); return owned.has(`${id}:${conversationId}`) || (id === 2 && owned.has(conversationId)) ? 'owner' : 'follower'; },
    async requestThreadFollower(a) {
      log.push(['request', id, a]);
      if (a.request.params.fail) throw new Error('Only the most recent message can be edited.');
      return { method: a.request.method, result: { ok: true } };
    },
  } } });
  const actions = [];
  const hooks = {
    appHost: {
      windows: () => [{ id: 1, host: {}, view: view(1) }, { id: 2, host: {}, view: view(2) }],
      first: () => ({ id: 1, host: { services: { appActions: { async runInPrimaryWindow(a) { actions.push(a.action); owned = new Set([...owned, a.action.threadId]); } } } } }),
    },
  };
  assert.deepEqual(await kit.followerRequest(hooks, 't-open', 'thread-follower-edit-last-user-turn', { conversationId: 't-open', turnId: 'u' }), { ok: true });
  assert.deepEqual(log, [
    ['role', 1, 'local', 't-open'], ['role', 2, 'local', 't-open'],
    ['request', 2, { hostId: 'local', request: { method: 'thread-follower-edit-last-user-turn', params: { conversationId: 't-open', turnId: 'u' } } }],
  ]);
  assert.deepEqual(actions, []);

  log.length = 0;
  assert.deepEqual(await kit.followerRequest(hooks, 't-closed', 'm', {}), { ok: true });
  assert.deepEqual(actions, [{ type: 'windows.show_thread', windowId: 'current', threadId: 't-closed' }]);
  assert.deepEqual(log.at(-1), ['request', 2, { hostId: 'local', request: { method: 'm', params: {} } }]);

  await assert.rejects(kit.followerRequest(hooks, 't-open', 'm', { fail: true }), (e) => !e.refused && /most recent message/.test(e.message));
  await assert.rejects(kit.followerRequest({ appHost: { windows: () => [{ id: 1, host: {}, view: null }], first: () => null } }, 't', 'm', {}),
    (e) => e.refused && /adapter pack is older/.test(e.message));
  await assert.rejects(kit.followerRequest(hooks, '', 'm', {}), (e) => e.refused);
});

test('threadIdOf: a thread id as it is; a chat\'s client id through the app\'s persisted mapping; an unknown one is null', () => {
  const atoms = { 'thread-client-id-v1:local%3At-1': 'client-new-thread:abc', other: 'client-new-thread:zzz' };
  const hooks = hooksWith({ projects: { globalState: { get: (k) => (k === 'electron-persisted-atom-state' ? atoms : null), onDidChange() {} } } });
  assert.equal(kit.threadIdOf(hooks, 't-2'), 't-2');
  assert.equal(kit.threadIdOf(hooks, 'client-new-thread:abc'), 't-1');
  assert.equal(kit.threadIdOf(hooks, 'client-new-thread:zzz'), null);
  assert.equal(kit.threadIdOf(hooksWith({}), 'client-new-thread:abc'), null);
  assert.equal(kit.threadIdOf(hooks, ''), null);
});
