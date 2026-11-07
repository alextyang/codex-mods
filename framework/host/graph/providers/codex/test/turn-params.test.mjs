// One send's settings and why a turn started (docs/design/public-hooks.md H5): the turn/start overrides, what is put back after, the
// app's triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendParams, restoreParams, triggerOf } from '../turn-params.mjs';

const models = [{ id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-6-sol', efforts: ['medium', 'xhigh'] }];
const current = { model: 'gpt-6-luna', effort: 'medium', mode: 'default', access: 'workspace' };

test('a send\'s settings as turn/start overrides; what goes back after; what is refused', () => {
  assert.deepEqual(sendParams(undefined, { current, models }), { params: {}, changed: [] });
  assert.deepEqual(sendParams({ effort: 'low' }, { current, models }), { params: { effort: 'low' }, changed: ['effort'] });
  assert.deepEqual(sendParams({ model: 'gpt-6-sol', effort: 'xhigh', mode: 'plan' }, { current, models }).params,
    { model: 'gpt-6-sol', effort: 'xhigh', collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-sol', reasoning_effort: 'xhigh', developer_instructions: null } } });
  assert.deepEqual(sendParams({ access: 'read-only' }, { current, models }).params, { sandboxPolicy: { type: 'readOnly' } });
  for (const [settings, reason, re, cur = current] of [
    [{ effort: 'max' }, 'invalid', /takes the efforts/], [{ model: 'nope' }, 'invalid', /no model/], [{ mode: 'fast' }, 'invalid', /mode is/],
    [{ access: 'full' }, 'notAllowed', /only narrow/], [{ access: 'read-only' }, 'unsupported', /permissions profile/, { ...current, access: null }],
    [{ color: 'red' }, 'invalid', /takes the settings/],
  ]) { const r = sendParams(settings, { current: cur, models }).refused; assert.equal(r?.reason, reason, JSON.stringify(settings)); assert.match(r.message, re); }
  assert.deepEqual(restoreParams('t1', ['effort'], current), { threadId: 't1', effort: 'medium' });
  assert.deepEqual(restoreParams('t1', ['model', 'mode', 'access'], current), { threadId: 't1', model: 'gpt-6-luna', effort: 'medium',
    collaborationMode: { mode: 'default', settings: { model: 'gpt-6-luna', reasoning_effort: 'medium', developer_instructions: null } }, sandboxPolicy: { type: 'workspaceWrite' } });
  assert.equal(restoreParams('t1', [], current), null);
});

test('why a turn started: the app\'s own trigger, a mod\'s send, otherwise not known', () => {
  assert.deepEqual(triggerOf(null, 'app'), { trigger: 'composer' });
  assert.deepEqual(triggerOf('composer', 'app'), { trigger: 'composer' });
  assert.deepEqual(triggerOf('composer_queue_run_now', 'app'), { trigger: 'queue', triggerDetail: 'composer_queue_run_now' });
  assert.deepEqual(triggerOf('capacity_retry_automatic', 'app'), { trigger: 'retry', triggerDetail: 'capacity_retry_automatic' });
  assert.deepEqual(triggerOf('edit_user_message', 'app').trigger, 'edit');
  assert.deepEqual(triggerOf('automation_cron_run_now', 'app').trigger, 'automation');
  assert.deepEqual(triggerOf('thread_handoff', 'app').trigger, 'handoff');
  assert.deepEqual(triggerOf('image_edit', 'app'), { trigger: 'app', triggerDetail: 'image_edit' });
  assert.deepEqual(triggerOf(null, 'framework:codex', { kind: 'mod', id: 'unit.m' }), { trigger: 'mod', triggerBy: 'unit.m' });
  assert.deepEqual(triggerOf(null, 'mod:unit.lease'), { trigger: 'mod', triggerBy: 'unit.lease' });
  assert.deepEqual(triggerOf('automation_heartbeat_scheduled', 'mod:unit.lease'), { trigger: 'mod', triggerBy: 'unit.lease' }, 'a mod\'s client cannot pass its turn off as the app\'s');
  assert.deepEqual(triggerOf(null, 'client:lease-1'), { trigger: 'unknown' });
  assert.deepEqual(triggerOf('automation_heartbeat_scheduled', 'client:lease-1'), { trigger: 'unknown' }, 'nor a leased client\'s');
});
