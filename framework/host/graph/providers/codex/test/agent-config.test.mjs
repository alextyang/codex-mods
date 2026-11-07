// Codex defaults through the source, real mux and shared fake config. framework-main's project writes and page refresh are answered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as area from '../areas/agent-config.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const mod = { kind: 'mod', id: 'mod.a' }, user = { kind: 'user', id: 'user', owner: 'app' };
const config = {
  approval_policy: 'on-request', sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false },
  web_search: 'cached', model_verbosity: 'low', model_reasoning_summary: 'concise', model: 'fake', model_reasoning_effort: 'medium',
};
const projects = [
  { id: 'p', name: 'Project', roots: ['/workspace/one', '/workspace/unused'] },
  { id: 'q', name: 'No config', roots: ['/workspace/two'] },
  { id: 'empty', name: 'No roots', roots: [] },
];
const detail = "It changes Codex's config.toml: new threads and the command line use it.";
const keys = [['config'], ['user-saved-config']];
const writes = (s) => s.calls.filter((c) => c.method === 'config/value/write' || c.method === 'config/batchWrite');

async function setup(o = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-agent-config-'));
  const calls = [], sent = [], prompts = [], warnings = [], events = [], timeline = [];
  const log = { debug() {}, info() {}, error() {}, warn(...args) { warnings.push(args); } };
  const controls = { approved: true, before: null, configRead: (r) => r, mainReply: null, serverUp: true, absentConcept: null };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, approvals: { async ask(q) { prompts.push(q); return { approved: controls.approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let seq = 1000, now = 100_000;
  const ask = async (method, params) => {
    const r = await h.app.request(++seq, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  await ask('fake/config', { config: o.config ?? config });
  for (const p of o.projectConfigs ?? [{ root: '/workspace/one', config: { web_search: 'live', sandbox_workspace_write: { network_access: true }, model: 'project-model' } }]) await ask('fake/projectConfig', p);
  const appProjects = createAppProjects({ log });
  appProjects.apply({ type: 'projects', available: true, reset: true, projects: o.projects ?? projects });
  let mainOps, feed, ctx;
  mainOps = createMainOps({ log, send(m) {
    sent.push(m); timeline.push(['main', m.op]);
    Promise.resolve().then(async () => {
      if (controls.mainReply) return controls.mainReply(m);
      if (m.op === 'project-config-write') {
        // Stand in for workspaceFiles saving the file: update the same fake project's layer, without a Host protocol write.
        await ask('config/value/write', { keyPath: m.args.key, value: m.args.value, mergeStrategy: m.args.value === null ? 'replace' : 'upsert', filePath: `${m.args.root}/.codex/config.toml`, expectedVersion: null });
        return { ok: true, result: { written: true } };
      }
      return { ok: true, result: { refreshed: 2 } };
    }).then((r) => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...r }), (e) => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: false, error: e.message }));
  } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, mainOps: o.noMain ? null : mainOps, appProjects, now: () => now,
    areas: { 'agent-config': { ...area, createFeed(context) {
      ctx = context;
      feed = area.createFeed({ ...context, serverUp: () => controls.serverUp && context.serverUp(),
        graph: { list(concept) { if (concept === controls.absentConcept) throw new Error('unknown concept'); return graph.list(concept); } },
        async request(method, params, intent) {
          calls.push({ method, params, intent }); timeline.push(['request', method]);
          await controls.before?.(method, params);
          const r = await context.request(method, params, intent);
          return method === 'config/read' ? controls.configRead(r, params) : r;
        },
      });
      return feed;
    } } },
  });
  graph.onEvent((e) => events.push(e));
  await source.start();
  await feed.observe(refs.configSetting('web_search'), 'Setting');
  return {
    graph, feed, ctx, controls, appProjects, calls, sent, prompts, warnings, events, timeline, ask,
    advance(ms) { now += ms; },
    invoke(ref, operation, args = [], caller = mod) { return graph.invoke({ ref, operation, args, caller }); },
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); appProjects.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('Codex defaults have the Configuration titles, kinds, choices and layer values, with project settings only for its own layer', async () => {
  const s = await setup();
  try {
    const expected = [
      ['approval_policy', 'Approval policy', 'choice', 'on-request', ['on-request', 'never']],
      ['sandbox_mode', 'Sandbox mode', 'choice', 'workspace-write', ['read-only', 'workspace-write', 'danger-full-access']],
      ['sandbox_workspace_write.network_access', 'Network access', 'toggle', false],
      ['web_search', 'Web search', 'choice', 'cached', ['disabled', 'cached', 'indexed', 'live']],
      ['model_verbosity', 'Model verbosity', 'choice', 'low', ['low', 'medium', 'high']],
      ['model_reasoning_summary', 'Reasoning summary', 'choice', 'concise', ['auto', 'concise', 'detailed', 'none']],
      ['model', 'Default model', 'text', 'fake'],
      ['model_reasoning_effort', 'Default reasoning effort', 'choice', 'medium', ['minimal', 'low', 'medium', 'high', 'xhigh']],
    ];
    assert.deepEqual(area.DEFAULTS.map((d) => d.key), expected.map(([key]) => key));
    for (const [key, title, kind, value, ids] of expected) {
      const instance = s.graph.resolve(refs.configSetting(key));
      assert.deepEqual(instance.state, { title, key, value, default: null, scope: 'app', kind, ...(ids ? { choices: ids.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1).replaceAll('-', ' ') })) } : {}) });
      assert.deepEqual(instance.links, { section: refs.settingsSection('agent'), definedBy: refs.agent() });
    }
    const own = s.graph.list('Setting').filter((x) => x.state.scope === 'project');
    assert.equal(own.length, 6);
    assert.deepEqual(own.map((x) => x.ref), expected.slice(0, 6).map(([key]) => refs.projectSetting('p', key)));
    for (const x of own) assert.deepEqual(x.links, { section: refs.settingsSection('agent'), definedBy: refs.agent(), project: refs.project('p') });
    assert.equal(s.graph.resolve(refs.projectSetting('p', 'approval_policy')).state.value, null, 'absent in the project layer, despite the user default');
    assert.equal(s.graph.resolve(refs.projectSetting('p', 'web_search')).state.value, 'live');
    assert.equal(s.graph.resolve(refs.projectSetting('p', 'model')), null);
    assert.equal(s.graph.resolve(refs.projectSetting('q', 'web_search')), null);
    assert.deepEqual(s.calls.filter((c) => c.method === 'config/read').map((c) => c.params), [null, '/workspace/one', '/workspace/two'].map((cwd) => ({ includeLayers: true, cwd })));
    assert.deepEqual(s.events.filter((e) => e.kind === 'event' && e.ref.type === 'Setting'), [], 'the first read is a sync');
    await until(() => s.graph.resolve(refs.agent()).links.settings?.length === 8, 3000, 'agent settings');
    const links = s.graph.resolve(refs.agent()).links;
    assert.deepEqual(links.settings, expected.map(([key]) => refs.configSetting(key)));
    for (const key of ['instructions', 'skills', 'toolServers', 'plugins']) assert.deepEqual(links[key], []);
  } finally { await s.close(); }
});

test('later reads emit Setting.changed only for changed values, remove vanished project settings, and keep all instances on a failed read', async () => {
  const s = await setup();
  const changed = () => s.events.filter((e) => e.kind === 'event' && e.ref.type === 'Setting').map((e) => [e.ref.id, e.name]);
  try {
    await s.ask('fake/config', { config: { ...config, web_search: 'indexed' } });
    await s.feed.read();
    assert.deepEqual(changed(), [['config:web_search', 'changed']]);
    await s.feed.read();
    assert.equal(changed().length, 1);
    const before = s.graph.list('Setting').map((x) => ({ ref: x.ref, state: x.state }));
    await s.ask('fake/config', { config: {} });
    s.controls.before = (method, params) => { if (method === 'config/read' && params.cwd === '/workspace/two') throw new Error('read failed'); };
    await s.feed.read();
    assert.deepEqual(s.graph.list('Setting').map((x) => ({ ref: x.ref, state: x.state })), before, 'even the earlier successful layers are not applied');
    assert.ok(s.warnings.some(([m]) => m === 'agent-config: the Codex config could not be read'));
    s.controls.before = null;
    s.controls.configRead = (r) => ({ ...r, layers: r.layers.filter((l) => l.name.type !== 'project') });
    await s.feed.read();
    assert.equal(s.graph.resolve(refs.projectSetting('p', 'web_search')).gone, true);
    assert.equal(s.feed.settings.owns(refs.projectSetting('p', 'web_search')), false);
    assert.equal(s.graph.resolve(refs.configSetting('web_search')).state.value, null);
    assert.equal(s.graph.list('Setting').length, 8);
    s.appProjects.apply({ type: 'projects', available: true, projects: [] });
    await s.feed.observe(refs.configSetting('web_search'), 'Setting');
    s.feed.relink();
    assert.equal(s.graph.resolve(refs.agent()).links.settings.length, 8);
  } finally { await s.close(); }
});

test('Setting.set and reset reach the area for both scopes, write the app targets, refresh and reread; no-ops are silent', async () => {
  const s = await setup();
  // In this order from `from` on: the write, then the refresh, then a read (another read may come in between under load).
  const inOrder = (from, ...entries) => {
    let at = from - 1;
    for (const [kind, name] of entries) {
      at = s.timeline.findIndex((e, i) => i > at && e[0] === kind && e[1] === name);
      if (at < 0) return false;
    }
    return true;
  };
  try {
    const app = refs.configSetting('web_search'), project = refs.projectSetting('p', 'web_search');
    const userLayer = (await s.ask('config/read', { includeLayers: true })).layers[0];
    let start = s.timeline.length;
    assert.equal((await s.invoke(app, 'set', ['live'])).status, 'done');
    assert.deepEqual(writes(s).at(-1).params, { keyPath: 'web_search', value: 'live', mergeStrategy: 'upsert', filePath: userLayer.name.file, expectedVersion: userLayer.version });
    assert.ok(inOrder(start, ['request', 'config/value/write'], ['main', 'refresh'], ['request', 'config/read']), JSON.stringify(s.timeline.slice(start)));
    assert.equal(s.graph.resolve(app).state.value, 'live');
    assert.deepEqual(s.sent.at(-1).args, { keys });
    assert.equal(s.sent.at(-1).area, 'agent-config');
    assert.deepEqual(s.prompts.map((q) => [q.action, q.detail]), [['change “Web search” for you', detail]]);
    const version = (await s.ask('config/read', { includeLayers: true })).layers[0].version;
    assert.equal((await s.invoke(app, 'reset', [], user)).status, 'done');
    assert.deepEqual(writes(s).at(-1).params, { keyPath: 'web_search', value: null, mergeStrategy: 'replace', filePath: userLayer.name.file, expectedVersion: version });
    assert.equal(s.graph.resolve(app).state.value, null);
    assert.equal(s.prompts.length, 1, 'a user caller never asks R17');
    start = s.timeline.length;
    assert.equal((await s.invoke(project, 'set', ['disabled'])).status, 'done');
    assert.deepEqual(s.sent.at(-2).args, { root: '/workspace/one', key: 'web_search', value: 'disabled' });
    assert.ok(inOrder(start, ['main', 'project-config-write'], ['main', 'refresh'], ['request', 'config/read']), JSON.stringify(s.timeline.slice(start)));
    assert.equal(s.graph.resolve(project).state.value, 'disabled');
    assert.equal(s.prompts.at(-1).action, 'change “Web search” for the project “Project”');
    assert.equal((await s.invoke(project, 'reset')).status, 'done');
    assert.deepEqual(s.sent.at(-2).args, { root: '/workspace/one', key: 'web_search', value: null });
    assert.equal(s.graph.resolve(project).state.value, null, 'reset exposes absence in its layer, not the user value');
    const counts = [writes(s).length, s.sent.length, s.prompts.length];
    for (const ref of [app, project]) {
      assert.equal((await s.invoke(ref, 'reset')).status, 'done');
      assert.equal((await s.invoke(ref, 'set', [null])).status, 'done');
    }
    assert.deepEqual([writes(s).length, s.sent.length, s.prompts.length], counts);
    assert.equal((await s.invoke(refs.configSetting('sandbox_workspace_write.network_access'), 'set', [false])).status, 'done');
    assert.equal(s.prompts.length, counts[2], 'false is an unchanged value too');
    assert.equal((await s.invoke(refs.configSetting('model'), 'set', ['another-model'], user)).status, 'done');
    assert.equal(s.graph.resolve(refs.configSetting('model')).state.value, 'another-model');
  } finally { await s.close(); }
});

test('invalid settings and unavailable targets refuse without prompts or writes; refresh failures only log', async () => {
  const s = await setup();
  try {
    for (const def of area.DEFAULTS) {
      for (const value of [0, {}, [], 'invalid-choice', ...(def.kind === 'toggle' ? ['false'] : [false])]) {
        if (def.kind === 'text' && typeof value === 'string' && value.trim()) continue;
        const r = await s.invoke(refs.configSetting(def.key), 'set', [value]);
        assert.equal(r.reason, 'invalid', `${def.key}: ${JSON.stringify(value)}`);
      }
    }
    for (const value of ['', '   ']) assert.equal((await s.invoke(refs.configSetting('model'), 'set', [value])).reason, 'invalid');
    assert.equal((await s.invoke(refs.projectSetting('p', 'web_search'), 'set', ['unknown'])).reason, 'invalid');
    assert.equal(s.prompts.length, 0);
    assert.deepEqual(writes(s), []);
    s.controls.configRead = (r) => ({ ...r, layers: r.layers.filter((l) => l.name.type !== 'user') });
    await s.feed.read();
    assert.equal((await s.invoke(refs.configSetting('web_search'), 'set', ['live'])).reason, 'unavailable');
    assert.equal(s.prompts.length, 0);
    s.controls.mainReply = () => ({ ok: false, refused: true, error: 'the project is no longer available' });
    const r = await s.invoke(refs.projectSetting('p', 'web_search'), 'set', ['disabled'], user);
    assert.equal(r.reason, 'unavailable');
    assert.equal(r.message, 'the project is no longer available');
    assert.equal(s.sent.filter((m) => m.op === 'refresh').length, 0);
    s.controls.configRead = (r) => r;
    await s.feed.read();
    s.controls.mainReply = () => ({ ok: false, refused: false, error: 'refresh failed' });
    assert.equal((await s.invoke(refs.configSetting('web_search'), 'set', ['live'], user)).status, 'done');
    assert.equal(s.graph.resolve(refs.configSetting('web_search')).state.value, 'live');
    assert.ok(s.warnings.some(([m]) => m === 'agent-config: the app pages could not be refreshed'));
    s.controls.mainReply = () => ({ ok: false, refused: false, error: 'project write failed' });
    assert.equal((await s.invoke(refs.projectSetting('p', 'web_search'), 'set', ['disabled'], user)).status, 'failed');
    const prompts = s.prompts.length, count = writes(s).length;
    s.controls.serverUp = false;
    assert.equal((await s.invoke(refs.configSetting('web_search'), 'set', ['indexed'])).reason, 'unavailable');
    assert.equal((await s.invoke(refs.model('fake-mini'), 'makeDefault')).reason, 'unavailable');
    assert.equal(s.prompts.length, prompts);
    assert.equal(writes(s).length, count);
    assert.equal(s.feed.settings.owns(refs.setting('appearanceTheme')), false);
    assert.equal(s.feed.settings.owns({ ...refs.configSetting('web_search'), provider: 'other' }), false);
    assert.equal((await s.feed.settings.write(refs.configSetting('unknown'), 'x')).reason, 'unavailable');
  } finally { await s.close(); }
});

test('R17 can decline a setting or model change; makeDefault writes once and skips the already default model', async () => {
  const s = await setup();
  try {
    assert.equal((await s.invoke(refs.model('fake'), 'makeDefault')).status, 'done');
    assert.equal(s.prompts.length, 0);
    assert.deepEqual(writes(s), []);
    s.controls.approved = false;
    assert.equal((await s.invoke(refs.configSetting('web_search'), 'set', ['live'])).reason, 'notAllowed');
    assert.equal((await s.invoke(refs.model('fake-mini'), 'makeDefault')).reason, 'notAllowed');
    assert.deepEqual(writes(s), []);
    s.controls.approved = true;
    assert.equal((await s.invoke(refs.model('fake-mini'), 'makeDefault')).status, 'done');
    const call = writes(s).at(-1);
    assert.equal(call.method, 'config/batchWrite');
    assert.deepEqual(call.params, { edits: [{ keyPath: 'model', value: 'fake-mini', mergeStrategy: 'upsert' }], filePath: null, expectedVersion: null, reloadUserConfig: true });
    assert.ok(call.intent, 'the external model operation passes its graph intent to the mux');
    assert.deepEqual(s.sent.at(-1).args, { keys });
    assert.equal(s.graph.resolve(refs.configSetting('model')).state.value, 'fake-mini');
    assert.equal(s.prompts.at(-1).action, 'make “Fake mini” Codex\'s default model');
    assert.equal(s.prompts.at(-1).detail, detail);
    const counts = [writes(s).length, s.sent.length, s.prompts.length];
    assert.equal((await s.invoke(refs.model('fake-mini'), 'makeDefault')).status, 'done');
    assert.deepEqual([writes(s).length, s.sent.length, s.prompts.length], counts);
    assert.equal((await s.invoke(refs.model('fake'), 'makeDefault', [], user)).status, 'done');
    assert.equal(s.prompts.length, counts[2]);
  } finally { await s.close(); }
});

test('reads serialize and coalesce; observation keeps registry settings with the core and reloads stale Codex settings', async () => {
  const s = await setup({ projects: [] });
  try {
    const ref = refs.configSetting('web_search');
    const rounds = () => s.calls.filter((c) => c.method === 'config/read').length;
    const before = rounds();
    assert.equal(s.feed.observe(refs.setting('appearanceTheme'), 'Setting'), undefined);
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    await s.feed.observe(ref, 'Setting');
    assert.equal(rounds(), before);
    s.advance(30_001);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let active = 0, max = 0;
    s.controls.before = async (method) => { if (method === 'config/read') { active++; max = Math.max(max, active); await gate; active--; } };
    const first = s.feed.observe(ref, 'Setting');
    assert.equal(s.feed.observe(ref, 'Setting'), first);
    assert.equal(s.feed.read(), first);
    assert.equal(s.feed.read(), first);
    release();
    await first;
    assert.equal(rounds(), before + 2, 'any number of reads while running ask for one additional pass');
    assert.equal(max, 1);
    await s.feed.observe(ref, 'Setting');
    assert.equal(rounds(), before + 2);
    await s.feed.serverUp();
    assert.equal(rounds(), before + 3);
  } finally { await s.close(); }
});

test('app config writes debounce a reread, project changes reread, and disposal cancels pending work', async () => {
  const s = await setup({ projects: [] });
  const rounds = () => s.calls.filter((c) => c.method === 'config/read').length;
  try {
    for (const method of ['config/batchWrite', 'config/value/write']) {
      const before = rounds();
      for (let i = 0; i < 3; i++) await s.ask(method, method === 'config/batchWrite' ? { edits: [{ keyPath: 'web_search', value: 'live', mergeStrategy: 'upsert' }] } : { keyPath: 'web_search', value: 'cached', mergeStrategy: 'upsert' });
      await until(() => rounds() > before, 3000, `${method} refresh`);
      await s.feed.observe(refs.configSetting('web_search'), 'Setting');
      assert.equal(rounds(), before + 1);
    }
    const before = rounds();
    s.appProjects.apply({ type: 'projects', available: true, projects: [projects[0]] });
    await s.feed.observe(refs.configSetting('web_search'), 'Setting');
    assert.equal(rounds(), before + 2, 'the user and the new project first root');
    assert.equal(s.graph.list('Setting').length, 14);
    s.feed.responded('config/batchWrite');
    s.feed.notified('anything');
    s.feed.dispose();
    const stopped = rounds();
    await sleep(1100);
    await s.feed.read();
    assert.equal(rounds(), stopped);
  } finally { await s.close(); }
});

test('periodic refreshes reread config every five minutes and relink the agent every minute', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await setup({ projects: [] });
  try {
    const rounds = () => s.calls.filter((c) => c.method === 'config/read').length;
    const before = rounds();
    s.feed.relink();
    s.ctx.handle.update(refs.agent(), { links: { settings: [] } });
    t.mock.timers.tick(60_000);
    await until(() => s.graph.resolve(refs.agent()).links.settings.length === 8, 3000, 'periodic relink');
    assert.equal(rounds(), before);
    t.mock.timers.tick(4 * 60_000);
    await s.feed.observe(refs.configSetting('web_search'), 'Setting');
    assert.equal(rounds(), before + 1);
    s.feed.dispose();
    t.mock.timers.tick(5 * 60_000);
    assert.equal(rounds(), before + 1);
  } finally { await s.close(); }
});

test('a missing framework-main refuses project writes but only logs a failed refresh after a successful user-config write', async () => {
  const s = await setup({ noMain: true });
  try {
    const r = await s.invoke(refs.projectSetting('p', 'web_search'), 'set', ['disabled'], user);
    assert.equal(r.reason, 'unavailable');
    assert.equal(r.message, 'framework-main is not running');
    assert.equal((await s.invoke(refs.configSetting('web_search'), 'set', ['live'], user)).status, 'done');
    assert.equal(s.graph.resolve(refs.configSetting('web_search')).state.value, 'live');
    assert.ok(s.warnings.some(([m]) => m === 'agent-config: the app pages could not be refreshed'));
  } finally { await s.close(); }
});

test('agent links use resident concepts of this provider, installed plugins only, and update only when links change', async () => {
  const s = await setup({ projects: [] });
  try {
    const put = (ref, state) => s.ctx.handle.put(ref, { state, links: {} });
    const instruction = { type: 'CodexInstructions', provider: 'codex', id: 'global' };
    put(instruction, { scope: 'global', text: { parts: [{ kind: 'text', text: 'Do this.' }] }, enabled: true });
    put(refs.skill('s'), { name: 'Skill', description: '', scope: 'global', source: 'yours', installed: false, enabled: false });
    put(refs.toolServer('s'), { name: 'Tools', status: 'starting', transport: 'local', auth: 'none' });
    put(refs.plugin('installed'), { name: 'Installed', description: '', installed: true, enabled: false });
    put(refs.plugin('library'), { name: 'Library', description: '', installed: false, enabled: false });
    const other = s.graph.registerProvider('test', 'other', { types: { Plugin: {} } });
    other.put({ type: 'Plugin', provider: 'other', id: 'foreign' }, { state: { name: 'Foreign', description: '', installed: true, enabled: true } });
    s.feed.relink();
    let links = s.graph.resolve(refs.agent()).links;
    assert.deepEqual(links.instructions, [instruction]);
    assert.deepEqual(links.skills, [refs.skill('s')]);
    assert.deepEqual(links.toolServers, [refs.toolServer('s')]);
    assert.deepEqual(links.plugins, [refs.plugin('installed')]);
    const version = s.graph.resolve(refs.agent()).version;
    s.feed.relink();
    assert.equal(s.graph.resolve(refs.agent()).version, version);
    s.controls.absentConcept = 'Skill';
    s.feed.relink();
    assert.deepEqual(s.graph.resolve(refs.agent()).links.skills, []);
    s.controls.absentConcept = null;
    s.ctx.handle.remove(instruction);
    s.feed.notified('anything');
    await until(() => s.graph.resolve(refs.agent()).links.instructions.length === 0, 3000, 'notification relink');
    s.ctx.handle.remove(refs.plugin('installed'));
    await s.ask('thread/list', { limit: 1 });
    await until(() => s.graph.resolve(refs.agent()).links.plugins.length === 0, 3000, 'response relink');
    links = s.graph.resolve(refs.agent()).links;
    assert.deepEqual(links.skills, [refs.skill('s')]);
  } finally { await s.close(); }
});
