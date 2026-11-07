// The fake Thread area: unarchive, general settings updates and terminal cleanup, in the protocol shapes of every supported build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

test('Thread area methods: unarchive, settings defaults and merged updates per thread, terminals clean, and schema-valid payloads', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    const r = await f.request(method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    issues.push(...shapeIssues('params', method, params), ...shapeIssues('result', method, r.result));
    return r.result;
  };
  try {
    const thread = (await ask('thread/start', { cwd: '/repo' })).thread;
    const other = (await ask('thread/start', { cwd: '/other' })).thread;
    const initial = (await f.request('fake/threadSettings', { threadId: thread.id })).result;
    assert.equal(initial.params, null);
    assert.equal(initial.threadSettings.model, 'fake');
    assert.equal(initial.threadSettings.approvalPolicy, 'on-request');
    assert.equal(initial.threadSettings.sandboxPolicy.type, 'workspaceWrite');
    assert.deepEqual(initial.threadSettings.collaborationMode, { mode: 'default', settings: { model: 'fake', reasoning_effort: null, developer_instructions: null } });
    // An empty update publishes the defaults too, so those are checked against the notification schema.
    await ask('thread/settings/update', { threadId: thread.id });
    const update = {
      threadId: thread.id, model: 'fake-mini', effort: 'high', serviceTier: 'fast', cwd: '/repo/sub',
      approvalPolicy: 'never', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      collaborationMode: { mode: 'plan', settings: { model: 'fake-mini', reasoning_effort: 'high', developer_instructions: 'Plan this.' } },
      disabledPluginIds: ['p@market'], summary: 'detailed', personality: 'none', multiAgentMode: 'explicitRequestOnly',
    };
    assert.deepEqual(await ask('thread/settings/update', update), {});
    const current = (await f.request('fake/threadSettings', { threadId: thread.id })).result;
    assert.deepEqual(current.params, update);
    const { threadId: _threadId, ...fields } = update;
    assert.deepEqual(current.threadSettings, { ...initial.threadSettings, ...fields });
    await ask('thread/settings/update', { threadId: thread.id, serviceTier: null, disabledPluginIds: [], permissions: ':workspace', model: null, collaborationMode: null });
    const cleared = (await f.request('fake/threadSettings', { threadId: thread.id })).result;
    assert.equal(cleared.threadSettings.serviceTier, null);
    assert.deepEqual(cleared.threadSettings.disabledPluginIds, []);
    assert.deepEqual(cleared.threadSettings.activePermissionProfile, { id: ':workspace', extends: null });
    assert.equal(cleared.threadSettings.model, 'fake-mini', 'null overrides leave required settings intact');
    assert.deepEqual(cleared.threadSettings.collaborationMode, update.collaborationMode);
    assert.deepEqual((await f.request('fake/threadSettings', { threadId: other.id })).result.threadSettings, { ...initial.threadSettings, cwd: '/other' });
    await ask('thread/archive', { threadId: thread.id });
    const restored = await ask('thread/unarchive', { threadId: thread.id });
    assert.equal(restored.thread.id, thread.id);
    assert.equal(restored.thread.archived, false);
    assert.deepEqual(await ask('thread/backgroundTerminals/clean', { threadId: thread.id }), {});
    await f.until(() => f.inbox.some((m) => m.method === 'thread/unarchived') && f.inbox.filter((m) => m.method === 'thread/settings/updated').length === 3);
    assert.deepEqual(f.inbox.find((m) => m.method === 'thread/unarchived').params, { threadId: thread.id });
    assert.deepEqual(f.inbox.filter((m) => m.method === 'thread/settings/updated').at(-1).params, { threadId: thread.id, threadSettings: cleared.threadSettings });
    for (const m of f.inbox) issues.push(...shapeIssues('notification', m.method, m.params));
    assert.deepEqual(issues, []);
    assert.equal(f.stderr(), '');
  } finally { await f.close(); }
});

test('Thread area methods reject missing, invalid and unknown thread ids', async () => {
  const f = await startInitialized();
  try {
    for (const method of ['thread/unarchive', 'thread/settings/update', 'thread/backgroundTerminals/clean', 'fake/threadSettings']) {
      for (const threadId of [undefined, '', 3, 'missing']) {
        const r = await f.request(method, { threadId });
        assert.equal(r.error.code, threadId === 'missing' ? -32600 : -32602);
        assert.equal(r.result, undefined);
      }
    }
    assert.deepEqual(f.inbox, []);
  } finally { await f.close(); }
});
