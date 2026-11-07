// Plugins through the real source, graph, mux and fake app-server: catalog, connections, events, writes, R17 and the app's own changes.
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
import * as plugins from '../areas/plugins.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';
import { createAppOps } from '../../../app-ops.mjs';
import { refused } from '../../../index.mjs';

const mod = { kind: 'mod', id: 'mod.plugins' }, user = { kind: 'user', id: 'user' };
const alpha = 'alpha@fake-local', beta = 'beta@fake-local', gamma = 'gamma@fake-remote';
const keys = [['plugins'], ['apps'], ['mcp', 'servers', 'status'], ['skills'], ['config']];
const writes = (s) => s.calls.filter((c) => ['plugin/install', 'plugin/uninstall', 'config/batchWrite'].includes(c.method));

async function setup({ controls = [], projects = null, transform = null } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-plugins-'));
  const prompts = [], calls = [], mainCalls = [], trace = [], events = [];
  const control = { before: null, transform, approved: true, mainAnswer: () => ({ ok: true, result: {} }) };
  let time = 100_000, seq = 900;
  const ask = (method, params) => h.app.request(++seq, method, params);
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: h.log, approvals: { ask: async (q) => { prompts.push(q); return { approved: control.approved, reason: 'test answer' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  for (const [method, params] of controls) assert.equal((await ask(method, params)).error, undefined);
  let mainOps;
  mainOps = createMainOps({ log: h.log, send: (m) => {
    mainCalls.push(m);
    trace.push(m.op);
    queueMicrotask(() => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...control.mainAnswer(m) }));
  } });
  const appProjects = projects ? createAppProjects({ log: h.log }) : null;
  appProjects?.apply({ type: 'projects', available: true, reset: true, projects });
  let feed, ctx;
  const area = { ...plugins, createFeed(c) {
    ctx = c;
    feed = plugins.createFeed({ ...c, request: async (method, params, intent) => {
      calls.push({ method, params, intent });
      trace.push(method);
      await control.before?.(method, params);
      const result = await c.request(method, params, intent);
      return control.transform ? control.transform(method, result) : result;
    } });
    return feed;
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: h.log, mainOps, appProjects, areas: { plugins: area }, now: () => time });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Plugin') events.push([e.ref.id, e.name]); });
  await source.start();
  await feed.observe(refs.plugin(alpha), 'Plugin');
  return {
    h, graph, source, ctx, feed, control, prompts, calls, mainCalls, trace, events, appProjects, mainOps, ask,
    state: (id) => graph.resolve(refs.plugin(id))?.state,
    invoke: (id, operation, caller = mod) => graph.invoke({ ref: refs.plugin(id), operation, args: [], caller }),
    advance(ms) { time += ms; },
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); appProjects?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('pluginData keeps graph state separate from local and remote install targets', () => {
  const summary = { id: alpha, name: 'alpha', installed: true, enabled: true, interface: { displayName: 'Alpha', shortDescription: 'Tools' } };
  const market = { name: 'fake-local', path: '/tmp/fake-marketplace' };
  assert.deepEqual(plugins.pluginData(summary, market, { connected: false }), {
    ref: refs.plugin(alpha), state: { name: 'Alpha', description: 'Tools', installed: true, enabled: true, connected: false }, links: { agents: [refs.agent()], enabledIn: [], disabledIn: [] },
  });
  assert.deepEqual(plugins.installTarget(summary, market), { pluginName: 'alpha', marketplacePath: '/tmp/fake-marketplace' });
  assert.deepEqual(plugins.installTarget(summary, { name: 'remote', path: null }), { pluginName: 'alpha', remoteMarketplaceName: 'remote' });
  const absent = plugins.pluginData({ ...summary, installed: false, interface: { displayName: '', shortDescription: '' } }, market);
  assert.deepEqual(absent.state, { name: 'alpha', description: '', installed: false, enabled: false });
  assert.deepEqual(absent.links, { agents: [], enabledIn: [], disabledIn: [] });
});

test('the first read syncs local plugins, config enablement, callable apps and installed agent links', async () => {
  const s = await setup({ controls: [
    ['fake/config', { config: { plugins: { [alpha]: { enabled: false } } } }],
    ['fake/pluginApps', { pluginId: alpha, apps: [{ id: 'mail', callable: true }, { id: 'calendar', callable: false }] }],
  ], projects: [{ id: 'p', name: 'P', roots: ['/tmp/plugin-project-a', '/tmp/plugin-project-b'] }, { id: 'q', name: 'Q', roots: ['/tmp/plugin-project-c'] }] });
  try {
    assert.deepEqual(s.graph.list('Plugin').map((p) => p.ref.id).sort(), [alpha, beta].sort());
    assert.deepEqual(s.state(alpha), { name: 'alpha', description: '', installed: true, enabled: false, connected: false });
    assert.deepEqual(s.state(beta), { name: 'beta', description: '', installed: false, enabled: false });
    assert.equal(s.graph.resolve(refs.plugin(gamma)), null);
    assert.deepEqual(s.graph.resolve(refs.plugin(alpha)).links.agents, [refs.agent()]);
    assert.deepEqual(s.graph.resolve(refs.plugin(beta)).links.agents, []);
    assert.deepEqual(s.calls.slice(0, 7).map((c) => [c.method, c.params]), [
      ['plugin/list', { cwds: ['/tmp/plugin-project-a', '/tmp/plugin-project-b', '/tmp/plugin-project-c'], marketplaceKinds: ['local'] }],
      ['plugin/installed', { cwds: ['/tmp/plugin-project-a', '/tmp/plugin-project-b', '/tmp/plugin-project-c'] }],
      // the user's own on or off where their config does not say it: as no project sees it (scoped enable, F9, built review round 1)
      ['plugin/installed', {}],
      ['config/read', { includeLayers: true }],
      // each one-folder project's own settings, at its folder (scoped enable, F9; a project of two folders is not scoped)
      ['config/read', { includeLayers: true, cwd: '/tmp/plugin-project-c' }],
      ['app/installed', {}], ['plugin/read', { pluginName: 'alpha', marketplacePath: '/tmp/fake-marketplace' }],
    ]);
    assert.deepEqual(s.events, []);
    const previous = s.calls.filter((c) => c.method === 'plugin/list').length;
    s.appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'q', name: 'Q', roots: ['/tmp/plugin-project-new'] }] });
    await until(() => s.calls.filter((c) => c.method === 'plugin/list').length > previous);
    await s.feed.observe(refs.plugin(alpha), 'Plugin');
    assert.deepEqual(s.calls.filter((c) => c.method === 'plugin/list').at(-1).params, { cwds: ['/tmp/plugin-project-new'], marketplaceKinds: ['local'] });
    assert.deepEqual(s.calls.filter((c) => c.method === 'plugin/installed').slice(-2).map((c) => c.params), [{ cwds: ['/tmp/plugin-project-new'] }, {}]);
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read').length, 1, 'details cached by id and version');
  } finally { await s.close(); }
});

test('installed summaries and marketplaces win over catalog entries with the same id, with one detail read per version', async () => {
  const s = await setup({ transform: (method, r) => method === 'plugin/list' ? { ...r, marketplaces: r.marketplaces.map((m) => ({
    ...m, path: '/tmp/stale-marketplace', plugins: m.plugins.map((p) => p.id === alpha ? {
      ...p, name: 'stale-alpha', enabled: false, version: 'old', interface: { displayName: 'Stale Alpha', shortDescription: 'Old catalog' },
    } : p),
  })) } : r });
  try {
    assert.deepEqual(s.graph.list('Plugin').map((p) => p.ref.id).sort(), [alpha, beta].sort());
    assert.deepEqual(s.state(alpha), { name: 'alpha', description: '', installed: true, enabled: true });
    assert.deepEqual(s.state(beta), { name: 'beta', description: '', installed: false, enabled: false });
    assert.deepEqual(s.calls.filter((c) => c.method === 'plugin/read').map((c) => c.params), [{ pluginName: 'alpha', marketplacePath: '/tmp/fake-marketplace' }]);
    await s.feed.read();
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read').length, 1);
  } finally { await s.close(); }
});

test('remote plugins appear only when installed; their details and disable, enable and uninstall operations use the installed inventory', async () => {
  const s = await setup();
  try {
    assert.equal(s.graph.resolve(refs.plugin(gamma)), null);
    const absent = await s.invoke(gamma, 'install', user);
    assert.deepEqual([absent.status, absent.reason], ['refused', 'unavailable']);
    assert.equal(writes(s).length, 0);
    await s.ask('fake/plugins', { marketplaces: [
      { name: 'fake-local', path: '/tmp/fake-marketplace', plugins: [{ name: 'alpha', installed: true }, { name: 'beta', installed: false }] },
      { name: 'fake-remote', plugins: [{ name: 'gamma', installed: true }, { name: 'delta', installed: false }] },
    ] });
    await s.ask('fake/pluginApps', { pluginId: gamma, apps: [{ id: 'remote-app', callable: true }] });
    await s.feed.read();
    assert.deepEqual(s.graph.list('Plugin').map((p) => p.ref.id).sort(), [alpha, beta, gamma].sort());
    assert.deepEqual(s.state(gamma), { name: 'gamma', description: '', installed: true, enabled: true, connected: true });
    assert.deepEqual(s.graph.resolve(refs.plugin(gamma)).links.agents, [refs.agent()]);
    assert.equal(s.graph.resolve(refs.plugin('delta@fake-remote')), null);
    const detail = s.calls.find((c) => c.method === 'plugin/read' && c.params.pluginName === 'gamma');
    assert.deepEqual(detail.params, { pluginName: 'gamma', remoteMarketplaceName: 'fake-remote' });
    assert.deepEqual(s.events, [], 'a newly discovered instance is a sync');
    for (const operation of ['disable', 'enable', 'uninstall']) {
      assert.equal((await s.invoke(gamma, operation, user)).status, 'done');
      if (operation !== 'uninstall') assert.equal(s.state(gamma).enabled, operation === 'enable');
    }
    assert.deepEqual(writes(s).map((c) => [c.method, c.params]), [
      ['config/batchWrite', { edits: [{ keyPath: `plugins.${gamma}.enabled`, value: false, mergeStrategy: 'upsert' }], filePath: path.join(s.h.dir, 'home-primary/config.toml'), expectedVersion: 'v1', reloadUserConfig: true }],
      ['config/batchWrite', { edits: [{ keyPath: `plugins.${gamma}.enabled`, value: true, mergeStrategy: 'upsert' }], filePath: path.join(s.h.dir, 'home-primary/config.toml'), expectedVersion: 'v2', reloadUserConfig: true }],
      ['plugin/uninstall', { pluginId: gamma }],
    ]);
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read' && c.params.pluginName === 'gamma').length, 1);
    assert.equal(s.graph.resolve(refs.plugin(gamma)).gone, true);
    assert.deepEqual(s.graph.list('Plugin').map((p) => p.ref.id).sort(), [alpha, beta].sort());
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('writes use protocol targets and intents, then refresh, plugin sync and reread; mod calls ask R17, user calls do not', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.calls.slice(0, 2).map((c) => [c.method, c.params]), [
      ['plugin/list', { cwds: [], marketplaceKinds: ['local'] }], ['plugin/installed', { cwds: [] }],
    ]);
    for (const operation of ['install', 'disable', 'enable', 'uninstall']) {
      const start = s.trace.length;
      const r = await s.invoke(beta, operation);
      assert.equal(r.status, 'done', JSON.stringify(r));
      const write = writes(s).at(-1);
      assert.equal(typeof write.intent, 'string', 'the graph intent reaches the mux request');
      assert.deepEqual(s.trace.slice(start, start + 4), [write.method, 'refresh', 'plugin-sync', 'plugin/list']);
    }
    assert.deepEqual(s.prompts.map((q) => [q.action, q.detail]), [
      ['install the plugin “beta”', "It adds the plugin's tools, skills and connections to Codex."],
      ['turn off the plugin “beta”', "It changes Codex's config.toml: new threads and the command line use it."],
      ['turn on the plugin “beta”', "It changes Codex's config.toml: new threads and the command line use it."],
      ['uninstall the plugin “beta”', 'Codex loses its tools, skills and connections.'],
    ]);
    assert.ok(s.prompts.every((q) => q.modId === mod.id && q.operation.startsWith('Plugin.')));
    const [install, disable, enable, uninstall] = writes(s);
    assert.deepEqual({ ...install.params, installAttemptId: 'uuid' }, { pluginName: 'beta', marketplacePath: '/tmp/fake-marketplace', installAttemptId: 'uuid' });
    assert.match(install.params.installAttemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const [write, value, version] of [[disable, false, 'v1'], [enable, true, 'v2']]) {
      assert.deepEqual(write.params, { edits: [{ keyPath: `plugins.${beta}.enabled`, value, mergeStrategy: 'upsert' }], filePath: path.join(s.h.dir, 'home-primary/config.toml'), expectedVersion: version, reloadUserConfig: true });
    }
    assert.deepEqual(uninstall.params, { pluginId: beta });
    assert.deepEqual(s.events, [[beta, 'installed'], [beta, 'enabled'], [beta, 'disabled'], [beta, 'enabled'], [beta, 'uninstalled']]);
    assert.deepEqual(s.mainCalls.map((m) => [m.area, m.op, m.args]), Array.from({ length: 4 }, () => [['plugins', 'refresh', { keys }], ['plugins', 'plugin-sync', {}]]).flat());

    for (const operation of ['install', 'disable', 'enable', 'uninstall']) assert.equal((await s.invoke(beta, operation, user)).status, 'done');
    assert.equal(s.prompts.length, 4);
    const secondInstall = writes(s).filter((c) => c.method === 'plugin/install').at(-1);
    assert.notEqual(secondInstall.params.installAttemptId, install.params.installAttemptId);
  } finally { await s.close(); }
});

test('already done writes, uninstalled toggles, managed code-review, dotted ids and unknown user layers do not ask or write', async () => {
  const s = await setup({ controls: [['fake/plugins', { marketplaces: [
    { name: 'openai-bundled', plugins: [{ name: 'code-review', installed: true }] },
    { name: 'fake-local', path: '/tmp/fake-marketplace', plugins: [{ name: 'alpha', installed: true }, { name: 'beta', installed: false }, { name: 'with.dot', installed: true }] },
  ] }]] });
  try {
    for (const [id, operation] of [[alpha, 'install'], [alpha, 'enable'], [beta, 'uninstall']]) assert.equal((await s.invoke(id, operation)).status, 'done');
    for (const operation of ['enable', 'disable']) {
      const r = await s.invoke(beta, operation);
      assert.deepEqual([r.status, r.reason], ['refused', 'unsupported']);
    }
    const managed = await s.invoke('code-review@openai-bundled', 'uninstall');
    assert.deepEqual([managed.status, managed.reason, managed.message], ['refused', 'unsupported', 'Codex manages this plugin; it cannot be uninstalled']);
    assert.equal((await s.invoke('with.dot@fake-local', 'disable')).reason, 'unsupported');
    assert.deepEqual([writes(s).length, s.mainCalls.length, s.prompts.length], [0, 0, 0]);
    s.control.transform = (method, r) => method === 'config/read' ? { ...r, layers: [] } : r;
    await s.feed.read();
    assert.equal((await s.invoke(alpha, 'disable')).reason, 'unavailable');
    assert.equal(s.prompts.length, 0);
    assert.equal(writes(s).length, 0);
    s.control.transform = null;
    await s.feed.read();
    assert.equal((await s.invoke(alpha, 'disable')).status, 'done');
    const count = writes(s).length, prompts = s.prompts.length;
    assert.equal((await s.invoke(alpha, 'disable')).status, 'done');
    assert.deepEqual([writes(s).length, s.prompts.length], [count, prompts]);
  } finally { await s.close(); }
});

test('connection changes follow callable apps; connect and disconnect open the encoded page with no prompt or mutation', async () => {
  const s = await setup({ controls: [['fake/pluginApps', { pluginId: alpha, apps: [{ id: 'mail', callable: false }, { id: 'calendar', callable: true }] }]] });
  try {
    for (const operation of ['connect', 'disconnect']) assert.equal((await s.invoke(alpha, operation)).status, 'done');
    assert.deepEqual(s.mainCalls.map((m) => [m.op, m.args]), [['navigate', { path: '/plugins/alpha%40fake-local' }], ['navigate', { path: '/plugins/alpha%40fake-local' }]]);
    assert.deepEqual([s.prompts, writes(s), s.events], [[], [], []]);
    for (const callable of [true, false]) {
      await s.ask('fake/pluginApps', { pluginId: alpha, apps: [{ id: 'mail', callable }, { id: 'calendar', callable: true }] });
      await until(() => s.state(alpha).connected === callable, 3000, 'the connection event');
    }
    assert.deepEqual(s.events, [[alpha, 'connected'], [alpha, 'disconnected']]);
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read').length, 1, 'callability is fresh, detail is cached');
    for (const refused of [true, false]) {
      s.control.mainAnswer = () => ({ ok: false, refused, error: 'pages unavailable' });
      const r = await s.invoke(alpha, 'connect');
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'pages unavailable']);
    }
    s.mainOps.op = async () => { throw new Error('channel failed'); };
    assert.equal((await s.invoke(alpha, 'disconnect')).message, 'channel failed');
    assert.equal(s.prompts.length, 0);
  } finally { await s.close(); }
});

test('the app\'s install, uninstall and both config write methods cause debounced rereads', async () => {
  const s = await setup();
  try {
    await s.ask('plugin/install', { pluginName: 'beta', marketplacePath: '/tmp/fake-marketplace' });
    await until(() => s.state(beta).installed, 3000, 'app install observed');
    await s.ask('plugin/uninstall', { pluginId: beta });
    await until(() => !s.state(beta).installed, 3000, 'app uninstall observed');
    await s.ask('config/batchWrite', { edits: [{ keyPath: `plugins.${alpha}.enabled`, value: false, mergeStrategy: 'upsert' }] });
    await until(() => !s.state(alpha).enabled, 3000, 'app batch write observed');
    await s.ask('config/value/write', { keyPath: `plugins.${alpha}.enabled`, value: true, mergeStrategy: 'upsert' });
    await until(() => s.state(alpha).enabled, 3000, 'app value write observed');
    assert.deepEqual(s.events, [[beta, 'installed'], [beta, 'enabled'], [beta, 'uninstalled'], [alpha, 'disabled'], [alpha, 'enabled']]);
    assert.deepEqual(s.mainCalls, [], 'the app owns the refresh for its own writes');
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('reads share a promise, queue one more read, refresh on observation after 30 s and on server ready; disposal clears hints and subscriptions', async () => {
  const s = await setup({ projects: [] });
  let release;
  try {
    let first = true;
    s.control.before = async (method) => {
      if (method === 'plugin/list' && first) { first = false; await new Promise((r) => { release = r; }); }
    };
    const initial = s.calls.length;
    const running = s.feed.read();
    await until(() => release);
    assert.equal(s.feed.read(), running);
    assert.equal(s.feed.read(), running);
    assert.equal(s.feed.observe(refs.plugin(alpha), 'Plugin'), running);
    release();
    await running;
    assert.equal(s.calls.slice(initial).filter((c) => c.method === 'plugin/list').length, 2);
    s.control.before = null;
    const reads = () => s.calls.filter((c) => c.method === 'plugin/list').length;
    let count = reads();
    s.advance(30_000);
    await s.feed.observe(refs.plugin(alpha), 'Plugin');
    assert.equal(reads(), count);
    s.advance(1);
    const view = s.graph.subscribe({ ref: refs.plugin(alpha) }, () => {});
    await view.loaded;
    view.dispose();
    assert.equal(reads(), count + 1);
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    count = reads();
    s.h.bus.publish('appServer/ready', {});
    await s.feed.observe(refs.plugin(alpha), 'Plugin');
    assert.equal(reads(), count + 1);
    count = reads();
    await s.ask('fake/notify', { method: 'skills/changed', params: {} });
    await s.ask('fake/notify', { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
    await until(() => reads() > count, 3000, 'debounced hints');
    await s.feed.observe(refs.plugin(alpha), 'Plugin');
    assert.equal(reads(), count + 1, 'a burst is one read');
    s.feed.notified('skills/changed');
    s.feed.responded('config/batchWrite');
    s.feed.dispose();
    count = reads();
    s.appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'p', name: 'P', roots: ['/tmp/plugin-project-late'] }] });
    await sleep(550);
    assert.equal(reads(), count);
  } finally { release?.(); await s.close(); }
});

test('a plugin whose details fail is still read, without connected, and its details are not asked again', async () => {
  const s = await setup({
    controls: [['fake/pluginApps', { pluginId: 'alpha@fake-local', apps: [{ id: 'mail', callable: true }] }]],
    transform: (method, r) => (method === 'plugin/read' ? (() => { throw new Error('remote plugin catalog request failed with status 404'); })() : r),
  });
  try {
    assert.deepEqual(s.state(alpha), { name: 'alpha', description: '', installed: true, enabled: true }, 'no connected: unknown');
    assert.equal(s.state(beta).installed, false, 'the other plugins are read');
    assert.ok(s.h.logged('warn', /plugins: a plugin's details could not be read/));
    await s.feed.read();
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read').length, 1, 'not asked again for this version');
  } finally { await s.close(); }
});

test('failed reads preserve the graph; detail version changes reload apps and missing catalog entries are removed', async () => {
  const s = await setup();
  try {
    const before = s.graph.resolve(refs.plugin(alpha));
    s.control.transform = (method, r) => method === 'app/installed' ? (() => { throw new Error('apps unavailable'); })() : r;
    await s.ask('fake/config', { config: { plugins: { [alpha]: { enabled: false } } } });
    await s.feed.read();
    assert.deepEqual(s.graph.resolve(refs.plugin(alpha)), before);
    assert.ok(s.h.logged('warn', /plugins: the plugins could not be read/));
    s.control.transform = null;
    await s.feed.read();
    assert.equal(s.state(alpha).enabled, false);
    const marketplaces = [{ name: 'fake-local', path: '/tmp/fake-marketplace', plugins: [{ name: 'alpha', installed: true, version: '2' }] }];
    await s.ask('fake/plugins', { marketplaces });
    await s.ask('fake/pluginApps', { pluginId: alpha, apps: [{ id: 'new-app', callable: true }] });
    await s.feed.read();
    assert.equal(s.state(alpha).connected, true);
    assert.equal(s.graph.resolve(refs.plugin(beta)).gone, true);
    assert.equal(s.graph.resolve(refs.plugin(gamma)), null);
    assert.equal(s.calls.filter((c) => c.method === 'plugin/read').length, 2);
    assert.deepEqual(s.events, [[alpha, 'disabled']], 'undefined to connected is a sync, not a connection event');
    marketplaces[0].plugins[0].version = '3';
    await s.ask('fake/plugins', { marketplaces });
    await s.feed.read();
    assert.equal(Object.hasOwn(s.state(alpha), 'connected'), false, 'no apps removes the optional state');
    assert.deepEqual(s.events, [[alpha, 'disabled']]);
  } finally { await s.close(); }
});

test('approval denial and protocol failure stop before refresh; refresh and sync failures are logged and still reread', async () => {
  const s = await setup();
  try {
    s.control.approved = false;
    assert.equal((await s.invoke(beta, 'install')).reason, 'notAllowed');
    assert.equal(writes(s).length, 0);
    s.control.approved = true;
    s.control.mainAnswer = (m) => ({ ok: false, refused: m.op === 'refresh', error: `${m.op} failed` });
    assert.equal((await s.invoke(beta, 'install')).status, 'done');
    assert.equal(s.state(beta).installed, true);
    assert.ok(s.h.logged('warn', /plugins: refresh could not be run/));
    assert.ok(s.h.logged('warn', /plugins: plugin-sync could not be run/));
    const mainCount = s.mainCalls.length;
    await s.ask('fake/config', { config: {} });
    const failed = await s.invoke(beta, 'disable', user);
    assert.equal(failed.status, 'failed', 'a stale expectedVersion is a protocol failure');
    assert.equal(s.mainCalls.length, mainCount);
    assert.equal(s.state(beta).enabled, true);
    await s.ask('fake/plugins', { marketplaces: [] });
    assert.equal((await s.invoke(beta, 'uninstall', user)).status, 'failed', 'unknown plugin is a protocol failure');
    assert.equal(s.mainCalls.length, mainCount);
  } finally { await s.close(); }
});

test('while the server is down every operation returns DOWN, without a prompt or protocol call', async () => {
  const s = await setup();
  try {
    s.h.bus.publish('appServer/exited', { backend: 'primary', reason: 'crashed' });
    const count = s.calls.length;
    for (const operation of ['install', 'uninstall', 'enable', 'disable', 'connect', 'disconnect']) {
      const r = await s.invoke(alpha, operation);
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', s.ctx.DOWN.message]);
    }
    assert.equal(s.calls.length, count);
    assert.deepEqual([s.prompts, s.mainCalls], [[], []]);
  } finally { await s.close(); }
});

test('H6m: the user\'s install, uninstall, enable and disable in the app pass the Plugin interceptors first: refused, the app is answered and Codex never makes it; the app\'s main side\'s own pass; the agent\'s uninstall is the app\'s act', async () => {
  const s = await setup();
  const ops = createAppOps({ graph: s.graph, mux: s.h.mux, log: s.h.log, appOperation: (m, p) => s.source.appOperation(m, p) });
  const seen = [];
  const no = (op) => s.graph.intercept('mod:qa', 'Plugin', op, (c) => { seen.push([op, c.ref.id, c.caller.kind]); return refused('notAllowed', `no ${op}`); });
  try {
    no('install'); no('disable'); no('uninstall');
    const target = { pluginName: 'beta', marketplacePath: '/tmp/fake-marketplace' };
    assert.match((await s.ask('plugin/install', target)).error?.message ?? '', /no install/);
    await sleep(100);
    assert.equal(s.state(beta).installed, false, 'Codex never installed it');
    // the app's main side's own install (an id <method>:<uuid>) is not the user's: it passes
    assert.equal((await s.h.app.request('plugin/install:own-1', 'plugin/install', target)).error, undefined);
    await until(() => s.state(beta).installed, 3000, 'installed by the app\'s own');
    for (const [method, params] of [['config/batchWrite', { edits: [{ keyPath: `plugins.${alpha}.enabled`, value: false, mergeStrategy: 'upsert' }] }],
      ['config/value/write', { keyPath: `plugins.${alpha}.enabled`, value: false, mergeStrategy: 'upsert' }]]) {
      assert.match((await s.ask(method, params)).error?.message ?? '', /no disable/, method);
    }
    assert.equal(s.state(alpha).enabled, true);
    // the agent's uninstall_plugin tool, carried out by the page as a plugin/uninstall: the app's act, not the user's
    const call = s.ask('fake/serverRequest', { method: 'item/tool/call', params: { threadId: 't1', turnId: 'u1', callId: 'c1', tool: 'uninstall_plugin', arguments: { plugin: 'beta' } } });
    const req = await s.h.app.waitFor((m) => m.method === 'item/tool/call', 3000);
    await s.ask('plugin/uninstall', { pluginId: alpha });   // another plugin than the one the agent's call names: the user's
    await s.ask('plugin/uninstall', { pluginId: beta });
    s.h.app.send({ id: req.id, result: { contentItems: [], success: true } });
    await call;
    await s.ask('plugin/uninstall', { pluginId: beta });
    assert.deepEqual(seen, [['install', beta, 'user'], ['disable', alpha, 'user'], ['disable', alpha, 'user'], ['uninstall', alpha, 'user'], ['uninstall', beta, 'app'], ['uninstall', beta, 'user']]);
    // a plugin its catalog does not name (a marketplace not read yet): read again, then refused while something holds installs
    assert.match((await s.ask('plugin/install', { pluginName: 'ghost', marketplacePath: '/tmp/nowhere' })).error?.message ?? '', /not in the catalog/);
    // several changes at once with a plugin's: refused while something holds a plugin's enable or disable
    assert.match((await s.ask('config/batchWrite', { edits: [{ keyPath: `plugins.${alpha}.enabled`, value: false, mergeStrategy: 'upsert' }, { keyPath: 'model', value: 'x', mergeStrategy: 'upsert' }] })).error?.message ?? '', /one at a time/);
    assert.equal(s.state(alpha).enabled, true);
  } finally { await ops.dispose(); await s.close(); }
});

test('scoped enable (F9): a project\'s own settings turn a plugin on or off (enabledIn, disabledIn; its `enabled` stays the user\'s); enable, disable and inherit with {project} write its .codex/config.toml through framework-main; a project not trusted: refused', async () => {
  const s = await setup({
    projects: [{ id: 'p1', name: 'One', roots: ['/tmp/scope-one'] }, { id: 'p2', name: 'Two', roots: ['/tmp/scope-two'] }],
    controls: [['fake/config', { config: { plugins: { [alpha]: { enabled: true } }, projects: { '/tmp/scope-one': { trust_level: 'trusted' } } } }],
      ['fake/projectConfig', { root: '/tmp/scope-one', config: { plugins: { [alpha]: { enabled: false } } } }]],
  });
  try {
    const p = s.graph.resolve(refs.plugin(alpha));
    assert.deepEqual([p.state.enabled, p.links.disabledIn, p.links.enabledIn], [true, [refs.project('p1')], []]);
    const call = (operation, args) => s.graph.invoke({ ref: refs.plugin(alpha), operation, args, caller: mod });
    const one = { project: refs.project('p1') };
    assert.equal((await call('disable', [one])).status, 'done');
    assert.deepEqual(s.mainCalls.filter((m) => m.op === 'project-enabled'), [], 'so already: nothing written');
    assert.equal((await call('inherit', [one])).status, 'done');
    assert.deepEqual(s.mainCalls.filter((m) => m.op === 'project-enabled').map((m) => m.args), [{ root: '/tmp/scope-one', name: alpha, value: null }]);
    assert.match(s.prompts.at(-1).action, /let the project “One” follow your setting for the plugin/);
    const r = await call('enable', [{ project: refs.project('p2') }]);
    assert.deepEqual([r.status, r.reason], ['refused', 'unavailable'], 'trust not known: refused');
    assert.equal(writes(s).length, 0, 'never the user\'s config');
  } finally { await s.close(); }
});

test('scoped enable (F9, built review round 1): the user\'s own on or off, where their config does not say it, is as no project sees it (a project\'s own off is its scope, never the global state)', async () => {
  const s = await setup({
    projects: [{ id: 'p1', name: 'One', roots: ['/tmp/scope-one'] }],
    controls: [['fake/config', { config: { projects: { '/tmp/scope-one': { trust_level: 'trusted' } } } }],
      ['fake/projectConfig', { root: '/tmp/scope-one', config: { plugins: { [alpha]: { enabled: false } } } }]],
  });
  try {
    // the catalog read for the project's folder says off (its own); the user's own is on (their config says nothing; the default)
    const p = s.graph.resolve(refs.plugin(alpha));
    assert.deepEqual([p.state.enabled, p.links.disabledIn], [true, [refs.project('p1')]]);
    // the user's own disable is theirs to write (not "so already")
    assert.equal((await s.graph.invoke({ ref: refs.plugin(alpha), operation: 'disable', args: [], caller: mod })).status, 'done');
    assert.equal(writes(s).length, 1);
  } finally { await s.close(); }
});
