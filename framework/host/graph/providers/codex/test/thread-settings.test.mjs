// Thread settings through the Codex source, graph and real mux with the shared threads fake. The app's answers and notifications are
// authoritative; graph writes use the protocol, and model selection changes only an existing chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, modelData } from '../map.mjs';
import * as threadSettings from '../areas/thread-settings.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const user = { kind: 'user', id: 'user', owner: 'app' };
const mod = { kind: 'mod', id: 'mod.thread-settings' };
const keys = ['model', 'effort', 'mode', 'access'];

async function setup() {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-thread-settings-'));
  const requests = [], events = [], prompts = [], puts = [], warnings = [];
  const log = { debug() {}, info() {}, warn: (message, data) => warnings.push({ message, data }), error() {} };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, approvals: { ask: async (q) => { prompts.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const wire = { request: null, ignoreUpdates: false };
  let feed, ctx;
  const module = { ...threadSettings, createFeed(context) {
    ctx = context;
    feed = threadSettings.createFeed({ ...context,
      handle: { ...context.handle, put(ref, data) { puts.push(ref); return context.handle.put(ref, data); } },
      request(method, params, intent) {
        requests.push({ method, params: structuredClone(params), intent });
        const next = () => context.request(method, params, intent);
        return wire.request ? wire.request(method, params, intent, next) : next();
      },
    });
    return { ...feed, notified(method, params) { if (!(wire.ignoreUpdates && method === 'thread/settings/updated')) feed.notified(method, params); } };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, areas: { 'thread-settings': module } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Setting') events.push({ ref: e.ref, name: e.name, value: ctx.resident(e.ref)?.state.value }); });
  let seq = 0;
  const app = async (method, params) => {
    const r = await h.app.request(++seq, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r));
    return r.result;
  };
  const act = async (ref, operation, args = [], caller = user) => {
    const r = await graph.invoke({ ref, operation, args, caller });
    assert.equal(r.status, 'done', JSON.stringify(r));
    return r;
  };
  await source.start();
  const answer = await app('thread/start', { cwd: '/tmp' });
  const ref = refs.thread(answer.thread.id);
  const setting = (key, threadId = ref.id) => graph.resolve(refs.threadSetting(threadId, key));
  await until(() => setting('access'), 3000, 'the initial thread settings');
  return {
    h, graph, source, ctx, feed, wire, requests, events, prompts, puts, warnings, ref, answer, app, act, setting,
    async notify(patch, threadId = ref.id) {
      const current = (await app('fake/threadSettings', { threadId })).threadSettings;
      await app('fake/notify', { method: 'thread/settings/updated', params: { threadId, threadSettings: { ...current, ...patch } } });
      // An app request after the notification is a barrier for the source's observer.
      await app('fake/threadSettings', { threadId });
      await until(() => keys.every((key) => setting(key, threadId)), 3000, 'the notified settings');
    },
    async close() { await source.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('threadSettingsData: the four choices, available provider models, effort fallback and every sandbox spelling', () => {
  const model = modelData({ model: 'm', displayName: 'Model M', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] });
  const hidden = modelData({ model: 'hidden', hidden: true });
  const foreign = { ...model, ref: { ...model.ref, provider: 'other', id: 'foreign' } };
  const gone = { ...model, ref: refs.model('gone'), gone: true };
  const data = threadSettings.threadSettingsData('scope:chat', { model: 'm', effort: 'high', sandbox: 'workspace-write' }, [model, hidden, foreign, gone]);
  assert.deepEqual(data.map((d) => d.ref), [...keys.map((key) => refs.threadSetting('scope:chat', key)), refs.settingsSection('composer')]);
  assert.deepEqual(data.slice(0, 4).map((d) => [d.state.title, d.state.value, d.state.choices]), [
    ['Model', 'm', [{ id: 'm', label: 'Model M' }]],
    ['Reasoning effort', 'high', [{ id: 'high', label: 'High' }]],
    ['Mode', 'default', [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }]],
    ['Access', 'workspace', [{ id: 'read-only', label: 'Read only' }, { id: 'workspace', label: 'Workspace' }, { id: 'full', label: 'Full access' }]],
  ]);
  for (const d of data.slice(0, 4)) {
    assert.deepEqual({ default: d.state.default, scope: d.state.scope, kind: d.state.kind, definedBy: d.links.definedBy }, { default: null, scope: 'thread', kind: 'choice', definedBy: refs.agent() });
    assert.deepEqual(d.links, { section: refs.settingsSection('composer'), definedBy: refs.agent(), thread: refs.thread('scope:chat') });
  }
  assert.deepEqual(data[4], { ref: refs.settingsSection('composer'), state: { title: 'Composer' }, links: {} });
  const unknown = threadSettings.threadSettingsData('t', { model: 'unknown' }, [model]);
  assert.deepEqual([unknown[1].state.value, unknown[1].state.choices, unknown[3].state.value], [null, [], null]);
  for (const [sandbox, access] of [['read-only', 'read-only'], ['readOnly', 'read-only'], ['workspace-write', 'workspace'], ['workspaceWrite', 'workspace'], ['danger-full-access', 'full'], ['dangerFullAccess', 'full'], ['externalSandbox', null], [null, null]]) {
    assert.equal(threadSettings.threadSettingsData('t', { sandbox }, [])[3].state.value, access);
  }
});

test('thread/start puts four live Settings from its answer, Composer once, provider choices and the inverse Thread.settings', async () => {
  const s = await setup();
  try {
    assert.deepEqual(keys.map((key) => s.setting(key).state.value), [s.answer.model, s.answer.reasoningEffort, 'default', 'read-only']);
    assert.equal(s.answer.sandbox.type, 'readOnly');
    for (const key of keys) {
      const instance = s.setting(key);
      assert.equal(instance.liveness, 'live');
      assert.equal(s.feed.settings.owns(instance.ref), true);
      assert.deepEqual(instance.links, { section: refs.settingsSection('composer'), definedBy: refs.agent(), thread: s.ref });
    }
    assert.deepEqual(s.setting('model').state.choices, [{ id: 'fake', label: 'Fake' }, { id: 'fake-mini', label: 'Fake mini' }]);
    assert.deepEqual(s.setting('effort').state.choices, s.graph.resolve(refs.model(s.answer.model)).state.efforts);
    assert.deepEqual(s.graph.resolve(refs.settingsSection('composer')).state, { title: 'Composer' });
    assert.deepEqual(s.graph.related(s.ref, 'settings').map((x) => x.ref.id).sort(), keys.map((key) => refs.threadSetting(s.ref.id, key).id).sort());
    assert.deepEqual(s.events, [], 'the initial put is a sync');
    const resumed = await s.app('thread/resume', { threadId: 'scope:chat', cwd: '/tmp' });
    const forked = await s.app('thread/fork', { threadId: s.ref.id });
    await until(() => s.setting('model', forked.thread.id), 3000, 'fork settings');
    for (const r of [resumed, forked]) assert.deepEqual(keys.map((key) => s.setting(key, r.thread.id).state.value), [r.model, r.reasoningEffort, 'default', 'read-only']);
    assert.equal(s.puts.filter((r) => r.type === 'SettingsSection').length, 1);
    assert.equal(s.graph.related(refs.settingsSection('composer'), 'settings').length, 12);
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.warnings, []);
    for (const ref of [refs.setting('thread:unknown:model'), refs.setting('appearanceTheme'), { ...refs.threadSetting(s.ref.id, 'model'), provider: 'other' }, { ...refs.threadSetting(s.ref.id, 'model'), type: 'Model' }]) assert.equal(s.feed.settings.owns(ref), false);
  } finally { await s.close(); }
});

test('thread/settings/updated changes values and choices, emits only changed values, and missing resume fields keep the known mode', async () => {
  const s = await setup();
  try {
    const collaborationMode = { mode: 'plan', settings: { model: 'fake-mini', reasoning_effort: 'low', developer_instructions: 'Keep this instruction' } };
    await s.notify({ model: 'fake-mini', effort: 'low', sandboxPolicy: { type: 'dangerFullAccess' }, collaborationMode });
    await until(() => s.setting('mode').state.value === 'plan', 3000, 'the changed settings');
    assert.deepEqual(keys.map((key) => s.setting(key).state.value), ['fake-mini', 'low', 'plan', 'full']);
    assert.deepEqual(s.setting('effort').state.choices, [{ id: 'low', label: 'Light' }]);
    assert.deepEqual(s.events, keys.map((key, i) => ({ ref: refs.threadSetting(s.ref.id, key), name: 'changed', value: ['fake-mini', 'low', 'plan', 'full'][i] })));
    const before = s.puts.length;
    await s.notify({ model: 'fake-mini', effort: 'low', sandboxPolicy: { type: 'dangerFullAccess' }, collaborationMode });
    assert.equal(s.puts.length, before, 'an identical snapshot changes nothing');
    await s.app('thread/resume', { threadId: s.ref.id });
    await until(() => s.setting('model').state.value === 'fake', 3000, 'the resume answer');
    assert.deepEqual(keys.map((key) => s.setting(key).state.value), ['fake', null, 'plan', 'read-only']);
    assert.deepEqual(s.events.slice(4).map((e) => e.ref.id), ['model', 'effort', 'access'].map((key) => refs.threadSetting(s.ref.id, key).id));
    const count = s.events.length;
    await s.notify({ sandboxPolicy: { type: 'readOnly' }, effort: null, collaborationMode: { ...collaborationMode, settings: { ...collaborationMode.settings, developer_instructions: null } } });
    assert.equal(s.events.length, count, 'changing only mode settings emits no value change');
  } finally { await s.close(); }
});

test('Setting.set sends model, effort and mode through the shared fake without R17; unchanged values send nothing', async () => {
  const s = await setup();
  try {
    for (const [key, value] of [['model', 'fake-mini'], ['effort', 'low']]) {
      await s.act(refs.threadSetting(s.ref.id, key), 'set', [value], mod);
      assert.deepEqual((await s.app('fake/threadSettings', { threadId: s.ref.id })).params, { threadId: s.ref.id, [key]: value });
      await until(() => s.setting(key).state.value === value, 3000, `the ${key} update`);
    }
    const collaborationMode = { mode: 'default', settings: { model: 'fake-mini', reasoning_effort: 'low', developer_instructions: 'Keep me' } };
    await s.notify({ model: 'fake-mini', effort: 'low', collaborationMode });
    await s.act(refs.threadSetting(s.ref.id, 'mode'), 'set', ['plan'], mod);
    assert.deepEqual((await s.app('fake/threadSettings', { threadId: s.ref.id })).params, { threadId: s.ref.id, collaborationMode: { mode: 'plan', settings: collaborationMode.settings } });
    await until(() => s.setting('mode').state.value === 'plan', 3000, 'the mode update');
    const from = s.requests.length;
    for (const [key, value] of [['model', 'fake-mini'], ['effort', 'low'], ['mode', 'plan'], ['access', 'workspace']]) await s.act(refs.threadSetting(s.ref.id, key), 'set', [value], mod);
    assert.equal(s.requests.length, from);
    assert.equal(from, 3);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('Setting.set refuses invalid choices, access and unknown mode settings; reset has no default', async () => {
  const s = await setup();
  try {
    const from = s.requests.length;
    for (const [key, operation, args, reason, message] of [
      ['model', 'set', ['fake-old'], 'invalid'], ['effort', 'set', ['unlisted'], 'invalid'], ['mode', 'set', ['unknown'], 'invalid'], ['access', 'set', ['dangerFullAccess'], 'invalid'],
      ['access', 'set', ['full'], 'unsupported', "the app changes a chat's access from its permissions menu, which asks first"],
      ['mode', 'set', ['plan'], 'unavailable'],
      ...keys.map((key) => [key, 'reset', [], 'unsupported', "a chat's setting has no default to go back to: choose a value"]),
    ]) {
      const r = await s.graph.invoke({ ref: refs.threadSetting(s.ref.id, key), operation, args, caller: mod });
      assert.deepEqual([r.status, r.reason], ['refused', reason], JSON.stringify(r));
      if (message) assert.equal(r.message, message);
    }
    assert.equal(s.requests.length, from);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('Model._select applies to a thread and its draft, carries the intent, and refuses a project, new draft and other providers', async () => {
  const s = await setup();
  try {
    const model = refs.model('fake-mini');
    for (const target of [s.ref, refs.draft(s.ref.id)]) {
      const from = s.requests.length;
      const r = await s.act(model, '_select', [target], mod);
      assert.deepEqual(s.requests.slice(from), [{ method: 'thread/settings/update', params: { threadId: s.ref.id, model: 'fake-mini' }, intent: r.intent }]);
      assert.deepEqual((await s.app('fake/threadSettings', { threadId: s.ref.id })).params, { threadId: s.ref.id, model: 'fake-mini' });
    }
    await until(() => s.setting('model').state.value === 'fake-mini', 3000, 'the selected model');
    const from = s.requests.length;
    for (const target of [refs.project('p'), refs.draft('new'), { ...s.ref, provider: 'other' }, { ...refs.draft(s.ref.id), provider: 'other' }, refs.agent(), null, { ...s.ref, id: '' }]) {
      const r = await s.graph.invoke({ ref: model, operation: '_select', args: [target], caller: mod });
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unsupported', "a model is chosen here for a chat; a new chat's or a project's comes with the composer and the Configuration page"]);
    }
    assert.equal(s.requests.length, from);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('Setting.set and Model._select resume an unloaded thread before updating its settings', async () => {
  const s = await setup();
  try {
    for (const [ref, operation, args, model] of [
      [refs.threadSetting(s.ref.id, 'model'), 'set', ['fake-mini'], 'fake-mini'],
      [refs.model('fake'), '_select', [s.ref], 'fake'],
    ]) {
      await s.app('fake/forget', { threadId: s.ref.id });
      const from = s.h.serverLog().length;
      const requestAt = s.requests.length;
      const result = await s.act(ref, operation, args);
      const calls = s.h.serverLog().slice(from).map((line) => JSON.parse(line.slice(line.indexOf('{'))))
        .filter((r) => ['thread/settings/update', 'thread/resume'].includes(r.method));
      assert.deepEqual(calls.map((r) => [r.method, r.params]), [
        ['thread/settings/update', { threadId: s.ref.id, model }],
        ['thread/resume', { threadId: s.ref.id, excludeTurns: true }],
        ['thread/settings/update', { threadId: s.ref.id, model }],
      ]);
      assert.equal(s.requests.length, requestAt + 2);
      assert.ok(s.requests.slice(requestAt).every((r) => r.intent === (operation === '_select' ? result.intent : undefined)));
      await until(() => s.setting('model').state.value === model, 3000, 'the settings after loading');
      assert.equal((await s.app('fake/threadSettings', { threadId: s.ref.id })).threadSettings.model, model);
    }
  } finally { await s.close(); }
});

test('an update answer carrying threadSettings is applied immediately; an empty answer waits for the notification', async () => {
  const s = await setup();
  try {
    s.wire.ignoreUpdates = true;
    const value = refs.threadSetting(s.ref.id, 'model');
    await s.act(value, 'set', ['fake-mini']);
    await s.app('fake/threadSettings', { threadId: s.ref.id });
    assert.equal(s.setting('model').state.value, 'fake', 'an empty answer is not an optimistic write');
    s.wire.request = async (_method, params, _intent, next) => {
      await next();
      return { threadSettings: (await s.app('fake/threadSettings', { threadId: params.threadId })).threadSettings };
    };
    await s.act(value, 'set', ['fake-mini']);
    assert.equal(s.setting('model').state.value, 'fake-mini');
    assert.deepEqual(s.events.map((e) => [e.ref.id, e.name]), ['model', 'access'].map((key) => [refs.threadSetting(s.ref.id, key).id, 'changed']));
  } finally { await s.close(); }
});

test('serverDown sweeps settings of gone threads; writes and selection are unavailable while down', async () => {
  const s = await setup();
  try {
    const other = await s.app('thread/start', { cwd: '/tmp' });
    await until(() => s.setting('access', other.thread.id), 3000, 'the surviving thread settings');
    await s.app('fake/forget', { threadId: s.ref.id });
    await s.source.resync();
    assert.equal(s.graph.resolve(s.ref).gone, true);
    assert.equal(s.feed.settings.owns(refs.threadSetting(s.ref.id, 'model')), true, 'the core removed the linked instances; the area still needs to forget them');
    s.h.bus.publish('appServer/exited', { reason: 'crashed' });
    for (const key of keys) {
      const ref = refs.threadSetting(s.ref.id, key);
      assert.equal(s.setting(key).gone, true);
      assert.equal(s.feed.settings.owns(ref), false);
      assert.equal(s.setting(key, other.thread.id).gone, undefined);
    }
    const from = s.requests.length;
    for (const [ref, operation, args] of [[refs.threadSetting(other.thread.id, 'model'), 'set', ['fake-mini']], [refs.model('fake-mini'), '_select', [refs.thread(other.thread.id)]]]) {
      const r = await s.graph.invoke({ ref, operation, args, caller: mod });
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'the Codex app-server is not running']);
    }
    assert.equal(s.requests.length, from);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('the 60-second sweep removes a vanished thread\'s settings; disposal stops it and ignores late updates', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await setup();
  try {
    await s.app('fake/forget', { threadId: s.ref.id });
    s.ctx.handle.remove(s.ref);
    t.mock.timers.tick(59_999);
    assert.equal(s.setting('model').gone, undefined);
    t.mock.timers.tick(1);
    assert.ok(keys.every((key) => s.setting(key).gone));
    assert.equal(s.graph.resolve(refs.settingsSection('composer')).gone, undefined);
    const r = await s.app('thread/start', { cwd: '/tmp' });
    await until(() => s.setting('access', r.thread.id), 3000, 'the second thread settings');
    s.feed.dispose();
    const from = s.puts.length;
    s.feed.responded('thread/resume', { ...r, model: 'fake-mini' });
    s.feed.notified('thread/settings/updated', { threadId: r.thread.id, threadSettings: { model: 'fake-mini' } });
    await s.app('fake/forget', { threadId: r.thread.id });
    s.ctx.handle.remove(refs.thread(r.thread.id));
    t.mock.timers.tick(60_000);
    assert.equal(s.setting('model', r.thread.id).gone, undefined, 'the disposed sweep no longer runs');
    assert.equal(s.puts.length, from);
  } finally { await s.close(); }
});

test('a failed protocol write is reported once without applying an optimistic value', async () => {
  const s = await setup();
  try {
    s.wire.request = (_method, _params, intent) => s.ctx.request('fake/error', { message: 'settings update failed' }, intent);
    const r = await s.graph.invoke({ ref: refs.threadSetting(s.ref.id, 'model'), operation: 'set', args: ['fake-mini'], caller: user });
    assert.equal(r.status, 'failed');
    assert.match(r.error.message, /settings update failed/);
    assert.equal(s.requests.length, 1);
    assert.equal(s.setting('model').state.value, 'fake');
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});
