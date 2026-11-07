// MCP servers and tools through the native source, real mux and fake app-server (D10). framework-main's area channel and R17's approval
// service are answered here; protocol writes still go through the mux to the shared fake config store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { refs } from '../map.mjs';
import * as area from '../areas/tool-servers.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';
import { createAppOps } from '../../../app-ops.mjs';
import { refused } from '../../../index.mjs';

const mod = { kind: 'mod', id: 'mod.a' }, user = { kind: 'user', id: 'user' };
const tool = (name, extra = {}) => ({ name, inputSchema: { type: 'object' }, ...extra });
const config = { mcp_servers: { local: { command: 'node', disabled_tools: ['blocked'] }, allow: { url: 'https://tools.example.com', enabled_tools: ['read'] } } };
const statuses = [
  { name: 'local', tools: { read: tool('read', { description: 'Read.' }), blocked: tool('blocked', { title: 'Blocked' }) } },
  { name: 'allow', tools: { read: tool('read'), write: tool('write') } },
];
const writes = new Set(['config/batchWrite', 'config/value/write', 'config/mcpServer/reload']);
const keys = [['config'], ['user-saved-config'], ['mcp', 'servers', 'status']];
const detail = "It changes Codex's config.toml: new threads and the command line use it.";

async function setup(o = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-tool-servers-'));
  const warnings = [], prompts = [], sent = [], calls = [], events = [], timeline = [];
  const log = { debug() {}, info() {}, error() {}, warn(...args) { warnings.push(args); } };
  const journal = path.join(dir, 'intents.jsonl');
  const graph = createGraph({ journalFile: journal, log, approvals: { async ask(q) { prompts.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let seq = 1000, now = 100_000;
  const ask = async (method, params) => { const r = await h.app.request(++seq, method, params); assert.equal(r.error, undefined); return r.result; };
  await ask('fake/config', { config: o.config ?? config });
  for (const p of o.projectConfigs ?? []) await ask('fake/projectConfig', p);
  for (const s of o.statuses ?? statuses) await ask('fake/mcpStatus', s);
  const projects = o.projects ? createAppProjects({ log }) : null;
  projects?.apply({ type: 'projects', available: true, reset: true, projects: o.projects });
  const controls = { before: null, configRead: o.configRead ?? ((r) => r), mainReply: () => ({ ok: true }), repeatPages: false };
  let feed, ctx, mainOps;
  mainOps = createMainOps({ log, send(m) {
    sent.push(m); timeline.push(['main', m.op]);
    queueMicrotask(() => mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...controls.mainReply(m) }));
  } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, mainOps, appProjects: projects, now: () => now,
    areas: { 'tool-servers': { ...area, createFeed(context) {
      ctx = context;
      feed = area.createFeed({ ...context, async request(method, params, intent) {
        calls.push({ method, params, intent }); timeline.push(['request', method]);
        await controls.before?.(method, params);
        const r = await context.request(method, params, intent);
        if (method === 'config/read') return controls.configRead(r);
        if (method === 'mcpServerStatus/list' && controls.repeatPages) return { ...r, nextCursor: '0' };
        return r;
      } });
      return feed;
    } } },
  });
  graph.onEvent((e) => { if (e.ref && ['ToolServer', 'Tool'].includes(e.ref.type)) events.push(e); });
  await source.start();
  await feed.observe(refs.toolServer('local'), 'ToolServer');
  return {
    h, graph, source, feed, ctx, controls, projects, calls, warnings, prompts, sent, events, timeline, journal, ask,
    advance(ms) { now += ms; },
    invoke(ref, operation, args = [], caller = mod) { return graph.invoke({ ref, operation, args, caller }); },
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); projects?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('status, authentication, enabled and data mapping cover runtime and fallback states without exposing config', () => {
  const { serverStatus, serverAuth, toolEnabled, toolServerData, toolData } = area;
  for (const [runtimeStatus, expected] of [['notStarted', 'starting'], ['starting', 'starting'], ['connected', 'connected'], ['authenticationRequired', 'error'], ['failed', 'error'], ['cancelled', 'error'], ['disabled', 'disabled']]) {
    assert.equal(serverStatus(null, { runtimeStatus, toolsError: 'error' }), expected);
    assert.equal(serverStatus({ enabled: false }, { runtimeStatus }), 'disabled');
  }
  assert.equal(serverStatus(null, { toolsError: 'error', tools: { read: {} } }), 'error');
  assert.equal(serverStatus(null, { tools: { read: {} } }), 'connected');
  assert.equal(serverStatus(null, { tools: {} }), 'starting');
  assert.equal(serverStatus(null, null), 'starting');
  for (const [authStatus, expected] of [['oAuth', 'signedIn'], ['bearerToken', 'signedIn'], ['notLoggedIn', 'needsSignIn'], ['unsupported', 'none'], ['unknown', 'none'], [undefined, 'none']]) assert.equal(serverAuth({ authStatus }), expected);
  assert.equal(serverAuth(null), 'none');
  for (const [entry, expected] of [[null, true], [{ enabled: false, enabled_tools: ['read'] }, false], [{ enabled_tools: ['read'], disabled_tools: ['read'] }, true], [{ enabled_tools: [] }, false], [{ disabled_tools: ['read'] }, false], [{ disabled_tools: [] }, true]]) assert.equal(toolEnabled(entry, 'read'), expected);
  const local = toolServerData('s', { command: 'node', env: { SECRET: 'private' } }, null);
  assert.deepEqual(local, { ref: refs.toolServer('s'), state: { name: 's', transport: 'local', status: 'starting', auth: 'none' }, links: { agents: [refs.agent()], enabledIn: [], disabledIn: [] } });
  assert.equal(toolServerData('s', { url: 'https://example.com' }, null).state.transport, 'remote');
  assert.equal(toolServerData('s', null, { httpOrigin: 'https://example.com' }).state.transport, 'remote');
  assert.equal(toolServerData('s', null, { toolsError: '' }).state.error, undefined);
  assert.equal(toolServerData('s', null, { toolsError: 'failed' }).state.error, 'failed');
  assert.deepEqual(toolData('s', 'read', { title: 'Title' }, { enabled: false, pluginId: 'p' }), { ref: refs.tool('s', 'read'), state: { name: 'read', description: 'Title', enabled: false, source: 'plugin' }, links: { server: refs.toolServer('s'), plugin: refs.plugin('p') } });
  assert.equal(toolData('s', 'read', { description: '', title: 'Title' }, { enabled: true }).state.description, '');
  assert.equal(toolData('s', 'read', {}, { enabled: true }).state.description, '');
  for (const type of Object.values(area.types(() => null))) for (const op of Object.values(type.operations)) assert.equal(op.effect, 'external');
});

test('the source joins user, project and status-only servers, tools, plugin and account links; the first read is a sync', async () => {
  const s = await setup({ config: { mcp_servers: { ...config.mcp_servers, 'bad.key': { command: 'skip' } }, projects: { '/workspace': { trust_level: 'trusted' } } },
    projects: [{ id: 'p', name: 'Project', roots: ['/workspace/one', '/workspace/two'] }],
    projectConfigs: [
      { root: '/workspace/one', config: { mcp_servers: { local: { command: 'shadow' }, project: { command: 'project' } } } },
      { root: '/workspace/two', config: { mcp_servers: { project: { url: 'https://other.example.com' }, second: { url: 'https://second.example.com' } } } },
    ], statuses: [...statuses,
      { name: 'project', tools: { run: tool('run') } },
      { name: 'plugin', pluginId: 'tools@market', tools: { run: tool('run') } },
      { name: 'codex_apps', authStatus: 'oAuth' },
    ] });
  try {
    assert.deepEqual(s.graph.list('ToolServer').map((x) => x.ref.id).sort(), ['allow', 'codex_apps', 'local', 'plugin', 'project', 'second']);
    assert.equal(s.graph.resolve(refs.toolServer('project')).state.transport, 'local', 'the first project root wins');
    assert.deepEqual(s.graph.resolve(refs.toolServer('plugin')).links.plugin, refs.plugin('tools@market'));
    assert.deepEqual(s.graph.resolve(refs.toolServer('codex_apps')).links.account, s.graph.resolve(refs.agent()).links.account);
    assert.deepEqual(s.graph.resolve(refs.toolServer('local')).links.agents, [refs.agent()]);
    assert.deepEqual(s.graph.resolve(refs.tool('plugin', 'run')).links, { server: refs.toolServer('plugin'), plugin: refs.plugin('tools@market') });
    assert.equal(s.graph.resolve(refs.tool('plugin', 'run')).state.source, 'plugin');
    assert.deepEqual(s.graph.resolve(refs.tool('local', 'read')).state, { name: 'read', description: 'Read.', enabled: true, source: 'toolServer' });
    assert.equal(s.graph.resolve(refs.tool('local', 'blocked')).state.enabled, false);
    assert.equal(s.graph.resolve(refs.tool('local', 'blocked')).state.description, '', 'a tool omitted before the first read has no remembered description');
    assert.equal(s.graph.resolve(refs.tool('allow', 'write')), null, 'an excluded allowlist name not seen before is unknown');
    assert.deepEqual(s.events.filter((e) => e.kind === 'event'), []);
    assert.deepEqual(s.calls.filter((c) => c.method === 'config/read').map((c) => c.params), [null, '/workspace/one', '/workspace/two'].map((cwd) => ({ cwd, includeLayers: true })));
    assert.deepEqual(s.calls.find((c) => c.method === 'mcpServerStatus/list').params, { detail: 'toolsAndAuthOnly', limit: 100, cursor: null });
    assert.equal((await s.invoke(refs.toolServer('local'), 'disable')).status, 'done', 'the user entry wins over a project shadow');
    for (const [ref, operation, args] of [[refs.toolServer('project'), 'edit', [{ command: 'x' }]], [refs.toolServer('project'), 'remove', []], [refs.toolServer('project'), 'enable', []], [refs.toolServer('second'), 'disable', []], [refs.tool('project', 'run'), 'disable', []]]) {
      const r = await s.invoke(ref, operation, args);
      assert.equal(r.reason, 'unsupported'); assert.match(r.message, /project's own/);
    }
    assert.equal(s.prompts.length, 1, 'refusals never prompt');
  } finally { await s.close(); }
});

for (const field of ['disabled_tools', 'enabled_tools']) test(`Tool.disable and Tool.enable retain the tool omitted by ${field}, its last description and the tool-name set`, async () => {
  const allow = field === 'enabled_tools';
  const s = await setup({ config: { mcp_servers: { local: { command: 'node', [field]: allow ? ['read', 'other'] : ['blocked'] } } },
    statuses: [{ name: 'local', tools: { read: tool('read', { description: 'Read.' }), other: tool('other') } }] });
  const ref = refs.tool('local', 'read');
  const listed = async () => Object.keys((await s.ask('mcpServerStatus/list', { serverName: 'local' })).data[0].tools).sort();
  try {
    await s.ask('fake/mcpStatus', { name: 'local', tools: { read: tool('read', { description: 'Updated.' }), other: tool('other') } });
    await s.feed.read();
    assert.deepEqual(await listed(), ['other', 'read']);
    assert.equal((await s.invoke(ref, 'disable')).status, 'done');
    assert.deepEqual(s.calls.findLast((c) => c.method === 'config/value/write').params, {
      keyPath: `mcp_servers.local.${field}`, value: allow ? ['other'] : ['blocked', 'read'], mergeStrategy: 'replace', filePath: null, expectedVersion: null,
    });
    assert.deepEqual(await listed(), ['other']);
    assert.deepEqual(s.graph.resolve(ref).state, { name: 'read', description: 'Updated.', enabled: false, source: 'toolServer' });
    await s.feed.read();
    assert.equal(s.graph.resolve(ref).state.enabled, false, 'the next read still retains the tool');
    assert.equal(s.graph.resolve(ref).state.description, 'Updated.');
    assert.equal((await s.invoke(ref, 'enable')).status, 'done');
    assert.deepEqual(s.calls.findLast((c) => c.method === 'config/value/write').params, {
      keyPath: `mcp_servers.local.${field}`, value: allow ? ['other', 'read'] : ['blocked'], mergeStrategy: 'replace', filePath: null, expectedVersion: null,
    });
    assert.deepEqual(await listed(), ['other', 'read']);
    assert.deepEqual(s.graph.resolve(ref).state, { name: 'read', description: 'Updated.', enabled: true, source: 'toolServer' });
    assert.deepEqual(s.events.filter((e) => e.kind === 'event'), [], 'a tool toggle changes neither server status nor its tool-name set');
  } finally { await s.close(); }
});

test('a disabled_tools name never listed by the server is a disabled Tool with an empty description', async () => {
  const s = await setup({ config: { mcp_servers: { local: { command: 'node', disabled_tools: ['unseen'] } } }, statuses: [] });
  try {
    assert.deepEqual((await s.ask('mcpServerStatus/list', { serverName: 'local' })).data[0].tools, {});
    assert.deepEqual(s.graph.resolve(refs.tool('local', 'unseen')).state, { name: 'unseen', description: '', enabled: false, source: 'toolServer' });
  } finally { await s.close(); }
});

test('disabled servers have no Tools and remember their catalog while present, including as status-only servers', async () => {
  const s = await setup({ config: { mcp_servers: { local: { command: 'node' }, off: { command: 'node', enabled: false, disabled_tools: ['unseen'], enabled_tools: [] } } },
    statuses: [{ name: 'local', tools: { read: tool('read', { title: 'Read' }) } }, { name: 'off', tools: { run: tool('run') } }] });
  const ref = refs.tool('local', 'read');
  try {
    assert.deepEqual(s.graph.list('Tool').map((t) => t.state.name), ['read']);
    assert.equal((await s.invoke(refs.toolServer('local'), 'edit', [{ command: 'node', enabled: false, enabled_tools: [], disabled_tools: ['unseen'] }])).status, 'done');
    assert.deepEqual(s.graph.list('Tool'), []);
    assert.equal(s.graph.resolve(ref).gone, true);
    assert.equal((await s.invoke(refs.toolServer('local'), 'enable')).status, 'done');
    assert.deepEqual(s.graph.resolve(ref).state, { name: 'read', description: 'Read', enabled: false, source: 'toolServer' });
    await s.ask('fake/mcpStatus', { name: 'local', tools: {} });
    await s.ask('fake/config', { config: {} }); await s.feed.read();
    assert.equal(s.graph.resolve(ref).gone, true, 'a missing tool that is no longer disabled is removed');
    await s.ask('fake/config', { config: { mcp_servers: { local: { command: 'node', enabled_tools: [] } } } }); await s.feed.read();
    assert.equal(s.graph.resolve(ref).state.description, 'Read', 'a status-only server still retains its catalog');
  } finally { await s.close(); }
});

test('later reads emit only changed status/auth/error or tool-name sets; new servers are silent and missing instances are removed', async () => {
  const s = await setup();
  const named = () => s.events.filter((e) => e.kind === 'event').map((e) => [e.ref.id, e.name]);
  try {
    await s.ask('fake/mcpStatus', { name: 'local', runtimeStatus: 'failed', authStatus: 'notLoggedIn', toolsError: 'discovery failed', tools: { fresh: tool('fresh') } });
    await s.ask('fake/mcpStatus', { name: 'new', tools: { new: tool('new') } });
    await s.feed.read();
    assert.deepEqual(named(), [['local', 'statusChanged'], ['local', 'toolsChanged']]);
    assert.deepEqual(s.graph.resolve(refs.toolServer('local')).state, { name: 'local', transport: 'local', status: 'error', auth: 'needsSignIn', error: 'discovery failed', source: 'user' });
    assert.equal(s.graph.resolve(refs.tool('local', 'read')).gone, true);
    await s.feed.read();
    assert.equal(named().length, 2, 'an unchanged read emits nothing');
    await s.ask('fake/mcpStatus', { name: 'local', runtimeStatus: 'failed', authStatus: 'oAuth', toolsError: 'discovery failed', tools: { fresh: tool('fresh') } });
    await s.feed.read();
    assert.deepEqual(named().at(-1), ['local', 'statusChanged'], 'auth alone');
    await s.ask('fake/mcpStatus', { name: 'local', runtimeStatus: 'failed', authStatus: 'oAuth', tools: { fresh: tool('fresh', { description: 'Updated.' }) } });
    await s.feed.read();
    assert.deepEqual(named().at(-1), ['local', 'statusChanged'], 'error disappears; description is not a tool-set change');
    assert.equal(s.graph.resolve(refs.toolServer('local')).state.error, undefined);
    assert.equal(named().length, 4);
    await s.ask('fake/config', { config: {} });
    await s.feed.read();
    assert.ok(!s.graph.resolve(refs.toolServer('local')).gone, 'the status-only server stays');
    // A configured server without an override disappears with its config entry.
    await s.ask('fake/config', { config: { mcp_servers: { transient: { command: 'node' } } } }); await s.feed.read();
    await s.ask('fake/config', { config: {} }); await s.feed.read();
    assert.equal(s.graph.resolve(refs.toolServer('transient')).gone, true);
  } finally { await s.close(); }
});

test('each config operation uses the app protocol, carries its intent, refreshes the app and rereads; mods get the R17 descriptions', async () => {
  const s = await setup({ config: { mcp_servers: { ...config.mcp_servers, allow: { ...config.mcp_servers.allow, enabled_tools: ['read', 'write'] } } } });
  const local = refs.toolServer('local'), blocked = refs.tool('local', 'blocked'), read = refs.tool('allow', 'read'), write = refs.tool('allow', 'write');
  const check = async (ref, operation, args, method, params, caller = mod) => {
    const start = s.calls.length, main = s.sent.length, at = s.timeline.length;
    const r = await s.invoke(ref, operation, args, caller);
    assert.equal(r.status, 'done');
    const mutation = s.calls.slice(start).filter((c) => writes.has(c.method));
    assert.deepEqual(mutation.map((c) => [c.method, c.params]), [[method, params]]);
    assert.equal(mutation[0].intent, r.intent);
    assert.equal(typeof r.intent, 'string', 'every operation is external');
    assert.deepEqual(s.sent.slice(main).map((m) => [m.area, m.op, m.args]), [['tool-servers', 'refresh', { keys }]]);
    assert.deepEqual(s.timeline.slice(at).slice(0, 3), [['request', method], ['main', 'refresh'], ['request', 'config/read']]);
  };
  const value = (keyPath, value, mergeStrategy = 'replace') => ({ keyPath, value, mergeStrategy, filePath: null, expectedVersion: null });
  try {
    await check(blocked, 'enable', [], 'config/value/write', value('mcp_servers.local.disabled_tools', null));
    await check(blocked, 'disable', [], 'config/value/write', value('mcp_servers.local.disabled_tools', ['blocked']));
    await check(write, 'disable', [], 'config/value/write', value('mcp_servers.allow.enabled_tools', ['read']));
    await check(read, 'disable', [], 'config/value/write', value('mcp_servers.allow.enabled_tools', []));
    await check(write, 'enable', [], 'config/value/write', value('mcp_servers.allow.enabled_tools', ['write']));
    await check(local, 'disable', [], 'config/value/write', value('mcp_servers.local.enabled', false, 'upsert'));
    assert.equal(s.graph.resolve(refs.tool('local', 'read')).gone, true);
    await check(local, 'enable', [], 'config/value/write', value('mcp_servers.local.enabled', true, 'upsert'));
    const edited = { url: 'https://private.example.com', http_headers: { Authorization: 'test-private-value' }, args: [], env_vars: [], cwd: '/tmp', bearer_token_env_var: 'TOKEN', env_http_headers: {}, auth: {}, oauth: {}, scopes: [], oauth_resource: 'r', enabled: true, startup_timeout_sec: 1, startup_timeout_ms: 1000, tool_timeout_sec: 2, enabled_tools: ['read'], disabled_tools: [] };
    const file = (await s.ask('config/read', { includeLayers: true })).layers.find((l) => l.name.type === 'user').name.file;
    await check(local, 'edit', [edited], 'config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: edited, mergeStrategy: 'replace' }], filePath: file, expectedVersion: null });
    assert.equal(s.graph.resolve(local).state.transport, 'remote');
    assert.equal(s.graph.resolve(refs.tool('local', 'blocked')).state.enabled, false);
    await check(local, 'restart', [], 'config/mcpServer/reload', undefined);
    await check(local, 'remove', [], 'config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: null, mergeStrategy: 'replace' }], filePath: file, expectedVersion: null });
    assert.deepEqual(s.prompts.map((q) => q.action), [
      'turn on the tool “blocked” of “local”', 'turn off the tool “blocked” of “local”', 'turn off the tool “write” of “allow”',
      'turn off the tool “read” of “allow”', 'turn on the tool “write” of “allow”', 'turn off the tool server “local”',
      'turn on the tool server “local”', 'change the tool server “local”', 'remove the tool server “local”',
    ]);
    assert.ok(s.prompts.every((q) => q.detail === detail && q.modId === mod.id));
    await check(refs.toolServer('allow'), 'disable', [], 'config/value/write', value('mcp_servers.allow.enabled', false, 'upsert'), user);
    assert.equal(s.prompts.length, 9, 'the user caller needs no prompt');
    const publicData = JSON.stringify([s.events, s.warnings, s.prompts.map(({ signal: _signal, ...q }) => q)]) + fs.readFileSync(s.journal, 'utf8');
    assert.ok(!publicData.includes('test-private-value') && !publicData.includes('private.example.com'), 'config values never enter graph events, prompts, warnings or the intent journal');
  } finally { await s.close(); }
});

test('CodexAgent.addToolServer writes a new server to the user\'s config, asked first, and answers its ToolServer; a name in use or a bad config is refused unasked', async () => {
  const s = await setup();
  try {
    const agent = refs.agent();
    const layer = (await s.ask('config/read', { includeLayers: true })).layers.find((l) => l.name.type === 'user');
    const added = { command: 'node', args: ['server.js'] };
    const r = await s.invoke(agent, 'addToolServer', ['added', added]);
    assert.deepEqual([r.status, r.value], ['done', refs.toolServer('added')]);
    assert.equal(typeof r.intent, 'string');
    assert.deepEqual(s.calls.filter((c) => c.method === 'config/batchWrite').map((c) => c.params),
      [{ edits: [{ keyPath: 'mcp_servers.added', value: added, mergeStrategy: 'replace' }], filePath: layer.name.file, expectedVersion: layer.version }], 'against the user\'s layer as read just before');
    assert.equal(s.graph.resolve(refs.toolServer('added')).state.transport, 'local');
    assert.deepEqual(s.prompts.map((q) => q.action), ['add the tool server “added”']);
    for (const args of [['local', { command: 'x' }], ['bad name', { command: 'x' }], ['ok', { command: 'x', url: 'https://x' }], ['ok', { foo: 1 }]]) {
      assert.equal((await s.invoke(agent, 'addToolServer', args)).reason, 'invalid', JSON.stringify(args));
    }
    assert.equal(s.prompts.length, 1, 'refused before anyone is asked');
    assert.equal(s.calls.filter((c) => c.method === 'config/batchWrite').length, 1);
    // added elsewhere since the area last read the config: the fresh read just before the write refuses it, unwritten
    await s.ask('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.late', value: { command: 'mine' }, mergeStrategy: 'replace' }], filePath: layer.name.file, expectedVersion: null });
    assert.equal((await s.invoke(agent, 'addToolServer', ['late', { command: 'theirs' }], user)).reason, 'invalid');
    assert.equal(s.calls.filter((c) => c.method === 'config/batchWrite').length, 1, 'nothing written over it');
  } finally { await s.close(); }
});

test('invalid configs, project and app/plugin servers, missing user layers and already-enabled tools do not write or prompt', async () => {
  const s = await setup({ statuses: [...statuses, { name: 'plugin', pluginId: 'p', tools: { run: tool('run') } }] });
  try {
    const before = s.calls.filter((c) => writes.has(c.method)).length;
    for (const bad of [null, [], {}, { command: '' }, { url: ' ' }, { command: 'node', url: 'https://example.com' }, { command: 'node', url: '' }, { command: 1 }, { command: 'node', surprise: true }, JSON.parse('{"command":"node","__proto__":{}}')]) {
      assert.equal((await s.invoke(refs.toolServer('local'), 'edit', [bad])).reason, 'invalid');
    }
    for (const operation of ['edit', 'remove', 'enable', 'disable']) {
      const r = await s.invoke(refs.toolServer('plugin'), operation, operation === 'edit' ? [{ command: 'node' }] : []);
      assert.equal(r.reason, 'unsupported'); assert.match(r.message, /app or a plugin/);
    }
    assert.equal((await s.invoke(refs.tool('plugin', 'run'), 'disable')).reason, 'unsupported');
    assert.equal((await s.invoke(refs.tool('local', 'read'), 'enable')).status, 'done');
    assert.equal((await s.invoke(refs.tool('local', 'blocked'), 'disable')).status, 'done');
    assert.equal((await s.invoke(refs.toolServer('local'), 'signIn')).status, 'done', 'auth none: nothing');
    assert.equal(s.calls.filter((c) => writes.has(c.method)).length, before);
    assert.deepEqual(s.prompts, []);
    s.controls.configRead = (r) => ({ ...r, layers: [] }); await s.feed.read();
    for (const operation of ['edit', 'remove', 'enable', 'disable']) assert.equal((await s.invoke(refs.toolServer('local'), operation, operation === 'edit' ? [{ command: 'node' }] : [])).reason, 'unavailable');
    assert.equal((await s.invoke(refs.tool('local', 'blocked'), 'enable')).reason, 'unavailable');
    assert.equal(s.calls.filter((c) => writes.has(c.method)).length, before);
    assert.deepEqual(s.sent, []); assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('down means every operation is refused before any work or prompt; ready reads the catalog again', async () => {
  const s = await setup({ statuses: [...statuses, { name: 'login', authStatus: 'notLoggedIn' }] });
  try {
    const before = s.calls.length;
    s.h.bus.publish('appServer/exited', { reason: 'test' });
    for (const operation of area.realizes.operations.ToolServer) {
      const r = await s.invoke(refs.toolServer('login'), operation, operation === 'edit' ? [{ command: 'node' }] : operation === 'inherit' ? [{ project: refs.project('p') }] : []);
      assert.equal(r.reason, 'unavailable'); assert.equal(r.message, s.ctx.DOWN.message);
    }
    for (const operation of ['enable', 'disable']) assert.equal((await s.invoke(refs.tool('local', 'read'), operation)).message, s.ctx.DOWN.message);
    assert.equal(s.calls.length, before); assert.deepEqual(s.prompts, []); assert.deepEqual(s.sent, []);
    s.h.bus.publish('appServer/ready', {});
    await s.feed.observe(refs.toolServer('local'), 'ToolServer');
    assert.ok(s.calls.length > before);
  } finally { await s.close(); }
});

test('signIn opens the app-server URL, matches only pending logins and reloads and rereads on successful completion', async () => {
  const s = await setup({ statuses: [{ name: 'local', authStatus: 'notLoggedIn' }] });
  const count = async () => (await s.ask('fake/mcpReloads')).count;
  try {
    assert.equal((await s.invoke(refs.toolServer('local'), 'signIn')).status, 'done');
    assert.deepEqual(s.sent.map((m) => [m.op, m.args]), [['open-url', { url: 'https://auth.example.com/authorize?server=local' }]]);
    assert.deepEqual(s.calls.find((c) => c.method === 'mcpServer/oauth/login').params, { name: 'local' });
    await s.ask('fake/mcpLoginCompleted', { name: 'local', loginId: 'unknown', success: true });
    assert.equal(await count(), 0);
    await s.ask('fake/mcpStatus', { name: 'local', authStatus: 'oAuth' });
    await s.ask('fake/mcpLoginCompleted', { name: 'different-name', loginId: 'login-1', success: true });
    await until(async () => await count() === 1, 3000, 'reload after login id');
    await s.feed.observe(refs.toolServer('local'), 'ToolServer');
    assert.equal(s.graph.resolve(refs.toolServer('local')).state.auth, 'signedIn');
    const logins = s.calls.filter((c) => c.method === 'mcpServer/oauth/login').length;
    await s.invoke(refs.toolServer('local'), 'signIn');
    assert.equal(s.calls.filter((c) => c.method === 'mcpServer/oauth/login').length, logins, 'signed in: nothing');
    await s.ask('fake/mcpStatus', { name: 'local', authStatus: 'notLoggedIn' }); await s.feed.read();
    await s.invoke(refs.toolServer('local'), 'signIn');
    await s.ask('fake/mcpLoginCompleted', { name: 'local', success: true });
    await until(async () => await count() === 2, 3000, 'older completion without login id');
    await s.ask('fake/mcpLoginCompleted', { name: 'local', success: true });
    assert.equal(await count(), 2, 'a duplicate completion has no pending login');
    await s.invoke(refs.toolServer('local'), 'signIn');
    await s.ask('fake/mcpLoginCompleted', { name: 'local', loginId: 'login-3', success: false });
    assert.equal(await count(), 2, 'failed login does not reload');
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('browser refusals and failures are unavailable, refresh failures are logged and reread, and protocol failures propagate', async () => {
  const s = await setup({ statuses: [{ name: 'local', authStatus: 'notLoggedIn' }] });
  try {
    for (const refused of [true, false]) {
      s.controls.mainReply = () => ({ ok: false, error: 'browser unavailable', refused });
      const r = await s.invoke(refs.toolServer('local'), 'signIn');
      assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'browser unavailable']);
      const before = s.calls.length;
      assert.equal((await s.invoke(refs.toolServer('local'), 'disable')).status, 'done');
      assert.ok(s.calls.slice(before).some((c) => c.method === 'config/read'));
    }
    assert.equal(s.warnings.filter(([m]) => m.includes('could not be refreshed')).length, 2);
    s.controls.configRead = (r) => ({ ...r, layers: r.layers.map((l) => ({ ...l, name: { ...l.name, file: '/not-a-fake-layer/config.toml' } })) });
    await s.feed.read();
    const refreshed = s.sent.filter((m) => m.op === 'refresh').length;
    assert.equal((await s.invoke(refs.toolServer('local'), 'edit', [{ command: 'node' }])).status, 'failed', 'the protocol rejects the unknown target file');
    assert.equal(s.sent.filter((m) => m.op === 'refresh').length, refreshed, 'a failed write does not refresh');
  } finally { await s.close(); }
});

test('app writes and notifications debounce rereads; project changes and old observations read; other concepts do not', async () => {
  // the projects' folders trusted (Codex reads a project's own config only then)
  const s = await setup({ projects: [], config: { ...config, projects: { '/workspace': { trust_level: 'trusted' } } } });
  try {
    const ref = refs.toolServer('local');
    const before = s.calls.length;
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    await s.feed.observe(ref, 'ToolServer'); await s.feed.observe(refs.tool('local', 'read'), 'Tool');
    assert.equal(s.calls.length, before, 'recent observations share fresh data');
    s.advance(30_001); await s.feed.observe(ref, 'ToolServer');
    assert.ok(s.calls.length > before, 'an old observation rereads');
    const rounds = () => s.calls.filter((c) => c.method === 'mcpServerStatus/list').length;
    for (const method of ['config/value/write', 'config/batchWrite', 'config/mcpServer/reload']) {
      const start = rounds();
      if (method === 'config/value/write') await s.ask(method, { keyPath: 'mcp_servers.local.enabled', value: false, mergeStrategy: 'upsert' });
      else if (method === 'config/batchWrite') await s.ask(method, { edits: [{ keyPath: 'mcp_servers.local.enabled', value: true, mergeStrategy: 'replace' }] });
      else await s.ask(method);
      await until(() => rounds() > start, 3000, `app ${method} reread`); await s.feed.observe(ref, 'ToolServer');
    }
    const start = rounds();
    await s.ask('fake/mcpStatus', { name: 'local', runtimeStatus: 'failed', toolsError: 'changed' });
    await s.ask('fake/mcpStartup', { name: 'local', status: 'failed' });
    await s.ask('fake/notify', { method: 'app/list/updated', params: {} });
    await s.ask('fake/account', { account: { planType: 'plus' } });
    await until(() => rounds() > start, 3000, 'notification reread'); await s.feed.observe(ref, 'ToolServer');
    assert.equal(rounds(), start + 1, 'three notifications coalesce');
    assert.equal(s.graph.resolve(ref).state.error, 'changed');
    await s.ask('fake/projectConfig', { root: '/workspace/new', config: { mcp_servers: { project: { command: 'p' } } } });
    s.projects.apply({ type: 'projects', available: true, projects: [{ id: 'p', name: 'New', roots: ['/workspace/new'] }] });
    await s.feed.observe(ref, 'ToolServer');
    assert.ok(s.graph.resolve(refs.toolServer('project')));
    const at = rounds();
    s.feed.responded('unrelated'); s.feed.notified('unrelated', {}); await sleep(550);
    assert.equal(rounds(), at);
  } finally { await s.close(); }
});

test('one read at a time, one queued follow-up, atomic failed reads, bounded paging, and disposal', async () => {
  const many = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`server-${String(i).padStart(3, '0')}`, { command: 'node' }]));
  const s = await setup({ config: { mcp_servers: many }, statuses: [] });
  try {
    assert.equal(s.graph.list('ToolServer').length, 205);
    assert.deepEqual(s.calls.filter((c) => c.method === 'mcpServerStatus/list').map((c) => c.params.cursor), [null, '100', '200']);
    const start = s.calls.length;
    let release;
    const gate = new Promise((r) => { release = r; });
    let blocked = true;
    s.controls.before = async (method) => { if (blocked && method === 'config/read') { blocked = false; await gate; } };
    const first = s.feed.read();
    assert.equal(s.feed.read(), first); assert.equal(s.feed.read(), first);
    assert.equal(s.feed.observe(refs.toolServer('server-000'), 'ToolServer'), first);
    assert.equal(s.calls.length, start + 1, 'no second request while the first read waits');
    release(); await first;
    assert.equal(s.calls.slice(start).filter((c) => c.method === 'config/read').length, 2);
    const snapshot = s.graph.list('ToolServer').map((x) => [x.ref.id, x.state]);
    const events = s.events.length;
    await s.ask('fake/config', { config: { mcp_servers: { new: { command: 'private-config-value' } } } });
    s.controls.before = (method) => { if (method === 'mcpServerStatus/list') throw new Error('private-config-value'); };
    await s.feed.read();
    assert.deepEqual(s.graph.list('ToolServer').map((x) => [x.ref.id, x.state]), snapshot);
    assert.equal(s.events.length, events);
    assert.ok(s.warnings.some(([m]) => m.includes('could not be read')));
    assert.ok(!JSON.stringify(s.warnings).includes('private-config-value'));
    s.controls.before = null; s.controls.repeatPages = true;
    const pageStart = s.calls.length;
    await s.feed.read();
    assert.equal(s.calls.slice(pageStart).filter((c) => c.method === 'mcpServerStatus/list').length, 20, 'at most twenty pages');
    assert.equal(s.graph.resolve(refs.toolServer('server-000')).gone, true);
    s.feed.responded('config/batchWrite');
    await s.source.dispose();
    const stopped = s.calls.length;
    await s.feed.read(); s.feed.notified('account/updated'); await sleep(550);
    assert.equal(s.calls.length, stopped, 'dispose cancels the pending timer and prevents further reads');
  } finally { await s.close(); }
});

test('H6m: the user\'s writes of a tool server in the app pass its interceptors first: an edit a mod changes goes on changed; a removal, a new one (the agent\'s addToolServer), a toggle and a sign-in refused never reach Codex', async () => {
  const s = await setup();
  const ops = createAppOps({ graph: s.graph, mux: s.h.mux, log: s.h.log, appOperation: (m, p) => s.source.appOperation(m, p) });
  let n = 7000;
  const raw = (method, params) => s.h.app.request(`page-${++n}`, method, params);
  const received = (method) => s.h.serverLog().map((l) => { try { return JSON.parse(l.slice(l.indexOf(' ') + 1)); } catch { return null; } }).filter((m) => m && m.method === method);
  const seen = [];
  const no = (type, op, why) => s.graph.intercept('mod:qa', type, op, (c) => { seen.push([op, c.ref.id, ...c.args.slice(0, 1)]); return refused('notAllowed', why); });
  try {
    s.graph.intercept('mod:qa', 'ToolServer', 'edit', (c, next) => { seen.push(['edit', c.ref.id]); return next({ args: [{ ...c.args[0], env: { QA: '1' } }] }); });
    no('ToolServer', 'remove', 'keep it'); no('CodexAgent', 'addToolServer', 'no new servers'); no('ToolServer', 'disable', 'stay on'); no('ToolServer', 'signIn', 'not now');
    const before = received('config/batchWrite').length;
    const edit = await raw('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: { command: 'node2' }, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null });
    assert.equal(edit.error, undefined);
    assert.deepEqual(received('config/batchWrite').slice(before).map((m) => m.params.edits[0].value), [{ command: 'node2', env: { QA: '1' } }], 'Codex got the changed config');
    for (const [method, params, why] of [
      ['config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: null, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null }, /keep it/],
      ['config/batchWrite', { edits: [{ keyPath: 'mcp_servers.fresh', value: { command: 'x' }, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null }, /no new servers/],
      ['config/value/write', { keyPath: 'mcp_servers.allow.enabled', value: false, mergeStrategy: 'upsert', filePath: null, expectedVersion: null }, /stay on/],
      ['mcpServer/oauth/login', { name: 'allow' }, /not now/],
    ]) assert.match((await raw(method, params)).error?.message ?? '', why, method);
    assert.equal(received('config/batchWrite').length, before + 1, 'nothing refused reached Codex');
    assert.equal(received('mcpServer/oauth/login').length, 0);
    assert.deepEqual(seen, [['edit', 'local'], ['remove', 'local'], ['addToolServer', 'codex', 'fresh'], ['disable', 'allow'], ['signIn', 'allow']]);
    // the app's main side's own write (its node_repl server: an id <method>:<uuid>) passes
    assert.equal((await s.h.app.request('config/batchWrite:own', 'config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: null, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null })).error, undefined);
  } finally { await ops.dispose(); await s.close(); }
});

test('H6m review: a rewrite of a server\'s change is a config the app takes, never a removal nor another server\'s write; several changes at once are refused while held', async () => {
  const s = await setup();
  const ops = createAppOps({ graph: s.graph, mux: s.h.mux, log: s.h.log, appOperation: (m, p) => s.source.appOperation(m, p) });
  let n = 7100;
  const raw = (method, params) => s.h.app.request(`page-${++n}`, method, params);
  const received = (method) => s.h.serverLog().map((l) => { try { return JSON.parse(l.slice(l.indexOf(' ') + 1)); } catch { return null; } }).filter((m) => m && m.method === method);
  try {
    s.graph.intercept('mod:qa', 'ToolServer', 'edit', (c, next) => next({ args: [null] }));
    s.graph.intercept('mod:qa', 'CodexAgent', 'addToolServer', (c, next) => next({ args: ['local', c.args[1]] }));
    const before = received('config/batchWrite').length;
    const write = (key, value) => raw('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${key}`, value, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null });
    assert.match((await write('local', { command: 'node2' })).error?.message ?? '', /cannot carry that change/, 'an edit rewritten to null is not a removal');
    assert.match((await write('fresh', { command: 'x' })).error?.message ?? '', /cannot carry that change/, 'a new one renamed onto an existing server');
    assert.match((await raw('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.local', value: { command: 'y' }, mergeStrategy: 'replace' }, { keyPath: 'model', value: 'm', mergeStrategy: 'upsert' }], filePath: null, expectedVersion: null })).error?.message ?? '', /one at a time/);
    assert.equal(received('config/batchWrite').length, before, 'none of them reached Codex');
  } finally { await ops.dispose(); await s.close(); }
});

test('scoped enable (F9): a project\'s own settings turn a server on or off for its threads (enabledIn, disabledIn); enable, disable and inherit with {project} write its .codex/config.toml through framework-main; a project not trusted, not the user\'s server, not one of the app\'s projects: refused', async () => {
  const s = await setup({
    config: { ...config, projects: { '/workspace': { trust_level: 'trusted' }, '/workspace/two': { trust_level: 'untrusted' } } },
    projects: [{ id: 'p1', name: 'One', roots: ['/workspace/one'] }, { id: 'p2', name: 'Two', roots: ['/workspace/two'] }, { id: 'p3', name: 'Three', roots: ['/elsewhere/three'] }],
    projectConfigs: [{ root: '/workspace/one', config: { mcp_servers: { local: { enabled: false }, allow: { enabled: true } } } }, { root: '/workspace/two', config: { mcp_servers: { local: { enabled: false } } } }],
    statuses: [...statuses, { name: 'plugin', pluginId: 'tools@market', tools: {} }],
  });
  try {
    const local = s.graph.resolve(refs.toolServer('local'));
    assert.deepEqual([local.links.disabledIn, local.links.enabledIn], [[refs.project('p1')], []], 'an untrusted project\'s own settings do not apply');
    assert.deepEqual(s.graph.resolve(refs.toolServer('allow')).links.enabledIn, [refs.project('p1')]);
    assert.equal(local.state.source, 'user', 'a project\'s own on or off is its scope, not where the server is configured');
    assert.equal(local.state.status !== 'disabled', true, 'the user\'s own: on');
    const one = { project: refs.project('p1') };
    // already so: nothing written; otherwise the write goes to framework-main with the project's root
    assert.equal((await s.invoke(refs.toolServer('local'), 'disable', [one])).status, 'done');
    assert.deepEqual(s.sent.filter((m) => m.op === 'project-enabled'), []);
    assert.equal((await s.invoke(refs.toolServer('local'), 'enable', [one])).status, 'done');
    assert.deepEqual(s.sent.filter((m) => m.op === 'project-enabled').map((m) => m.args), [{ root: '/workspace/one', name: 'local', value: true }]);
    assert.match(s.prompts.at(-1).action, /turn on the tool server “local” in the project “One”/);
    assert.match(s.prompts.at(-1).detail, /\.codex\/config\.toml/);
    assert.equal((await s.invoke(refs.toolServer('local'), 'inherit', [one])).status, 'done');
    assert.deepEqual(s.sent.filter((m) => m.op === 'project-enabled').at(-1).args, { root: '/workspace/one', name: 'local', value: null });
    // the project's file changed (as framework-main writes it): read again, its scope follows
    await s.ask('fake/projectConfig', { root: '/workspace/one', config: { mcp_servers: { allow: { enabled: true } } } });
    await s.feed.read();
    assert.deepEqual(s.graph.resolve(refs.toolServer('local')).links.disabledIn, []);
    const refusal = async (ref, op, args) => { const r = await s.invoke(ref, op, args); return [r.status, r.reason]; };
    assert.deepEqual(await refusal(refs.toolServer('local'), 'disable', [{ project: refs.project('p2') }]), ['refused', 'unavailable'], 'not trusted');
    assert.deepEqual(await refusal(refs.toolServer('local'), 'disable', [{ project: refs.project('p3') }]), ['refused', 'unavailable'], 'trust not known');
    assert.deepEqual(await refusal(refs.toolServer('local'), 'disable', [{ project: refs.project('nope') }]), ['refused', 'invalid']);
    assert.deepEqual(await refusal(refs.toolServer('plugin'), 'disable', [one]), ['refused', 'unsupported'], 'not the user\'s server');
    // the user's own, as before: the user's config
    assert.equal((await s.invoke(refs.toolServer('local'), 'disable')).status, 'done');
    assert.deepEqual(s.calls.filter((c) => c.method === 'config/value/write').at(-1).params, { keyPath: 'mcp_servers.local.enabled', value: false, mergeStrategy: 'upsert', filePath: null, expectedVersion: null });
  } finally { await s.close(); }
});

test('scoped enable (F9, built review round 1): a project\'s own setting is its own layer\'s (not a folder around it); every project of a folder has it; a project of several folders is not scoped (refused); trust compares real paths', async () => {
  const s = await setup({
    config: { ...config, projects: { '/workspace': { trust_level: 'trusted' } } },
    projects: [{ id: 'p1', name: 'One', roots: ['/workspace/one'] }, { id: 'p1b', name: 'One again', roots: ['/workspace/one'] },
      { id: 'pkg', name: 'Pkg', roots: ['/workspace/one/pkg'] }, { id: 'pm', name: 'Many', roots: ['/workspace/one', '/workspace/three'] }],
    projectConfigs: [{ root: '/workspace/one', config: { mcp_servers: { local: { enabled: false } } } }],
  });
  try {
    // p1's own off: p1 and p1b (one folder, two projects); not pkg (inside it: the setting is a folder around it, not its own); not pm
    assert.deepEqual(s.graph.resolve(refs.toolServer('local')).links.disabledIn, [refs.project('p1'), refs.project('p1b')]);
    const pkg = { project: refs.project('pkg') };
    // pkg follows the folder around it already: inherit has nothing to take away; pinning it off is its own write
    assert.equal((await s.invoke(refs.toolServer('local'), 'inherit', [pkg])).status, 'done');
    assert.deepEqual(s.sent.filter((m) => m.op === 'project-enabled'), []);
    assert.equal((await s.invoke(refs.toolServer('local'), 'disable', [pkg])).status, 'done');
    assert.deepEqual(s.sent.filter((m) => m.op === 'project-enabled').map((m) => m.args), [{ root: '/workspace/one/pkg', name: 'local', value: false }]);
    // p1b, sharing p1's folder, is scoped as p1 (trust known, its setting read)
    assert.equal((await s.invoke(refs.toolServer('local'), 'disable', [{ project: refs.project('p1b') }])).status, 'done');
    assert.equal(s.sent.filter((m) => m.op === 'project-enabled').length, 1, 'already off in its folder: nothing written');
    const r = await s.invoke(refs.toolServer('local'), 'disable', [{ project: refs.project('pm') }]);
    assert.deepEqual([r.status, r.reason], ['refused', 'unsupported'], 'a project of several folders');
  } finally { await s.close(); }
  // a project opened through a symbolic link: its trust entry and its own layer name the real folder
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-trust-')));
  try {
    fs.mkdirSync(path.join(dir, 'real', '.codex'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    const alias = path.join(dir, 'alias'), real = path.join(dir, 'real');
    assert.equal(area.projectTrust(alias, [], { [real]: { trust_level: 'trusted' } }), true);
    assert.equal(area.projectTrust(alias, [], { [dir]: { trust_level: 'untrusted' } }), false, 'a folder around it');
    assert.equal(area.projectTrust(alias, [{ name: { type: 'project', dotCodexFolder: `${real}/.codex` }, disabledReason: 'not trusted' }], { [real]: { trust_level: 'trusted' } }), false, 'its own layer says');
    assert.ok(area.ownLayer({ type: 'project', dotCodexFolder: `${real}/.codex/` }, alias));
    assert.ok(!area.ownLayer({ type: 'project', dotCodexFolder: `${dir}/.codex` }, alias), 'a folder around it is not its own');
    // its .codex folder itself a link elsewhere (round 2): the layer names where it points, the destination is the same folder
    fs.mkdirSync(path.join(dir, 'shared', 'config'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'linked'));
    fs.symlinkSync(path.join(dir, 'shared', 'config'), path.join(dir, 'linked', '.codex'));
    assert.ok(area.ownLayer({ type: 'project', dotCodexFolder: path.join(dir, 'shared', 'config') }, path.join(dir, 'linked')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
