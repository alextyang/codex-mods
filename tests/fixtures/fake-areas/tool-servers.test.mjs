// The fake MCP area: shared user config, independent status overrides, paging, OAuth and reload controls. Every protocol payload is
// checked against each captured build's schema; fake controls themselves are not protocol methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

test('MCP catalog joins config and overrides, sorts, pages, filters, and reflects config writes without touching a real server', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    const r = await f.request(method, params);
    assert.equal(r.error, undefined);
    issues.push(...shapeIssues('params', method, params), ...shapeIssues('result', method, r.result));
    return r.result;
  };
  try {
    assert.deepEqual(await ask('mcpServerStatus/list', {}), { data: [], nextCursor: null });
    await f.request('fake/config', { config: { mcp_servers: { zebra: { command: 'z', enabled: false }, alpha: { url: 'https://name:password@tools.example.com/path?secret=1' } } } });
    await f.request('fake/projectConfig', { root: '/project', config: { mcp_servers: { project: { command: 'p' } } } });
    await f.request('fake/mcpStatus', { name: 'alpha', authStatus: 'notLoggedIn', runtimeStatus: 'failed', toolsError: 'discovery failed', tools: { read: { name: 'read', inputSchema: { type: 'object' }, description: 'Read.' } } });
    await f.request('fake/mcpStatus', { name: 'plugin', pluginId: 'p@market', authStatus: 'oAuth', tools: { run: { name: 'run', inputSchema: {}, title: 'Run' } } });
    await f.request('fake/mcpStatus', { name: 'zebra', runtimeStatus: 'connected' });
    const first = await ask('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 2, cursor: null });
    assert.deepEqual(first.data.map((s) => s.name), ['alpha', 'plugin']);
    assert.equal(first.nextCursor, '2');
    assert.deepEqual([first.data[0].runtimeStatus, first.data[0].authStatus, first.data[0].toolsError, first.data[0].httpOrigin], ['failed', 'notLoggedIn', 'discovery failed', 'https://tools.example.com']);
    assert.equal(first.data[1].pluginId, 'p@market');
    const last = await ask('mcpServerStatus/list', { cursor: first.nextCursor, limit: 2, detail: 'full', threadId: 't' });
    assert.deepEqual(last.data.map((s) => [s.name, s.runtimeStatus, s.authStatus]), [['zebra', 'disabled', 'unsupported']]);
    assert.equal(last.nextCursor, null);
    assert.deepEqual(last.data[0].tools, {});
    const one = await ask('mcpServerStatus/list', { serverName: 'plugin', limit: 100 });
    assert.deepEqual(one.data.map((s) => s.name), ['plugin']);
    await ask('config/value/write', { keyPath: 'mcp_servers.zebra.enabled', value: true, mergeStrategy: 'upsert', filePath: null, expectedVersion: null });
    assert.equal((await ask('mcpServerStatus/list', { serverName: 'zebra' })).data[0].runtimeStatus, 'connected');
    await ask('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.zebra', value: null, mergeStrategy: 'replace' }] });
    assert.equal((await ask('mcpServerStatus/list', {})).data.length, 3, 'its status override remains as a status-only server');
    assert.deepEqual(await ask('mcpServerStatus/list', { serverName: 'absent' }), { data: [], nextCursor: null });
    assert.equal((await f.request('mcpServerStatus/list', { cursor: '-1' })).error.code, -32600);
    assert.equal((await f.request('mcpServerStatus/list', { limit: -1 })).error.code, -32602);
    assert.deepEqual(issues, []);
    assert.equal(f.stderr(), '');
  } finally { await f.close(); }
});

test('MCP tools omit disabled_tools, obey enabled_tools, and disappear while the server is disabled without changing their overrides', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    const r = await f.request(method, params);
    assert.equal(r.error, undefined);
    issues.push(...shapeIssues('params', method, params), ...shapeIssues('result', method, r.result));
    return r.result;
  };
  const tools = { read: { name: 'read', inputSchema: { type: 'object' }, description: 'Read.' }, write: { name: 'write', inputSchema: {}, title: 'Write' } };
  const listed = async (name) => (await ask('mcpServerStatus/list', { serverName: name })).data[0].tools;
  try {
    await f.request('fake/config', { config: { mcp_servers: {
      local: { command: 'node', disabled_tools: ['write', 'unseen'] },
      allow: { command: 'node', enabled_tools: ['read'], disabled_tools: ['read'] },
      off: { command: 'node', enabled: false, disabled_tools: ['unseen'] },
    } } });
    for (const name of ['local', 'allow', 'off', 'plugin']) await f.request('fake/mcpStatus', { name, tools });
    assert.deepEqual(await listed('local'), { read: tools.read });
    assert.deepEqual(await listed('allow'), { read: tools.read }, 'the allowlist takes precedence over the disabled list');
    assert.deepEqual(await listed('off'), {});
    assert.deepEqual(await listed('plugin'), tools, 'status-only tools are unchanged');
    await ask('config/value/write', { keyPath: 'mcp_servers.local.disabled_tools', value: null, mergeStrategy: 'replace' });
    assert.deepEqual(await listed('local'), tools);
    await ask('config/value/write', { keyPath: 'mcp_servers.allow.enabled_tools', value: [], mergeStrategy: 'replace' });
    assert.deepEqual(await listed('allow'), {});
    await ask('config/value/write', { keyPath: 'mcp_servers.allow.enabled_tools', value: ['write'], mergeStrategy: 'replace' });
    assert.deepEqual(await listed('allow'), { write: tools.write });
    await ask('config/value/write', { keyPath: 'mcp_servers.off.enabled', value: true, mergeStrategy: 'upsert' });
    assert.deepEqual(await listed('off'), tools, 'filtering did not remove the overridden tools');
    assert.deepEqual(issues, []);
    assert.equal(f.stderr(), '');
  } finally { await f.close(); }
});

test('MCP OAuth attempts get distinct ids, completion and startup notifications match the schemas, and reloads are counted', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    const r = await f.request(method, params);
    assert.equal(r.error, undefined);
    issues.push(...shapeIssues('params', method, params), ...shapeIssues('result', method, r.result));
    return r.result;
  };
  try {
    const login = await ask('mcpServer/oauth/login', { name: 'qa server' });
    assert.deepEqual(login, { authorizationUrl: 'https://auth.example.com/authorize?server=qa%20server', loginId: 'login-1' });
    assert.equal((await ask('mcpServer/oauth/login', { name: 'second', scopes: ['read'], threadId: null })).loginId, 'login-2');
    assert.deepEqual((await f.request('fake/mcpReloads')).result, { count: 0 });
    assert.deepEqual(await ask('config/mcpServer/reload', undefined), {});
    assert.deepEqual(await ask('config/mcpServer/reload', undefined), {});
    assert.deepEqual((await f.request('fake/mcpReloads')).result, { count: 2 });
    await f.request('fake/mcpLoginCompleted', { name: 'qa server', loginId: login.loginId, success: true });
    await f.request('fake/mcpLoginCompleted', { name: 'second', success: false });
    for (const status of ['starting', 'ready', 'failed', 'cancelled']) await f.request('fake/mcpStartup', { name: 'qa server', status });
    await f.until(() => f.inbox.filter((m) => m.method?.startsWith('mcpServer/')).length === 6);
    for (const m of f.inbox.filter((m) => m.method?.startsWith('mcpServer/'))) issues.push(...shapeIssues('notification', m.method, m.params));
    assert.equal(f.inbox.find((m) => m.method === 'mcpServer/oauthLogin/completed').params.loginId, login.loginId);
    assert.deepEqual(issues, []);
    assert.equal(f.stderr(), '');
  } finally { await f.close(); }
});
