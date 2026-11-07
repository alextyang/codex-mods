// The fake app-server's layered config (config.mjs): reads merge the user layer and the project layers that hold the cwd, with origins
// and layers; writes go to the layer their file names and bump its version; payloads match the protocol's schema of each build since 20770.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

test('config: user and project layers, origins, writes by file with versions, removal, and the schema of every build', async () => {
  const f = await startInitialized({ env: { CODEX_HOME: '/tmp/fake-home' } });
  const issues = [];
  const ask = async (method, params) => {
    const r = await f.request(method, params);
    if (r.result !== undefined) issues.push(...shapeIssues('params', method, params), ...shapeIssues('result', method, r.result));
    return r;
  };
  try {
    await f.request('fake/projectConfig', { root: '/r', config: { sandbox_mode: 'read-only', mcp_servers: { proj: { command: 'p' } } } });
    const w = (await ask('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.qa', value: { command: 'node', args: ['s.js'] }, mergeStrategy: 'replace' }], filePath: '/tmp/fake-home/config.toml', expectedVersion: null })).result;
    assert.deepEqual([w.status, w.filePath], ['ok', '/tmp/fake-home/config.toml']);
    await ask('config/value/write', { keyPath: 'mcp_servers.qa.enabled', value: false, mergeStrategy: 'upsert', filePath: null, expectedVersion: null });
    const home = (await ask('config/read', { includeLayers: true })).result;
    assert.deepEqual(home.config.mcp_servers, { qa: { command: 'node', args: ['s.js'], enabled: false } });
    assert.equal(home.layers.length, 1);
    assert.deepEqual(home.origins['mcp_servers.qa.enabled'].name, { type: 'user', file: '/tmp/fake-home/config.toml' });
    // a project not trusted (no entry says so: Codex's rule): its layer is listed with why, and none of it applies
    const unknown = (await ask('config/read', { includeLayers: true, cwd: '/r/src' })).result;
    assert.deepEqual([Object.keys(unknown.config.mcp_servers), typeof unknown.layers[1].disabledReason], [['qa'], 'string']);
    await ask('config/value/write', { keyPath: 'projects', value: { '/r': { trust_level: 'trusted' } }, mergeStrategy: 'upsert', filePath: null, expectedVersion: null });
    const inRepo = (await ask('config/read', { includeLayers: true, cwd: '/r/src' })).result;
    assert.deepEqual(Object.keys(inRepo.config.mcp_servers).sort(), ['proj', 'qa']);
    assert.deepEqual(inRepo.layers.map((l) => l.name.type), ['user', 'project']);
    assert.equal(inRepo.origins['mcp_servers.proj.command'].name.dotCodexFolder, '/r/.codex');
    assert.equal((await ask('config/read', {})).result.layers, null, 'layers only when asked');
    const stale = await f.request('config/value/write', { keyPath: 'x', value: 1, mergeStrategy: 'replace', expectedVersion: 'v1' });
    assert.equal(stale.error.code, -32600);
    await ask('config/batchWrite', { edits: [{ keyPath: 'mcp_servers.qa', value: null, mergeStrategy: 'replace' }] });
    assert.equal((await ask('config/read', {})).result.config.mcp_servers.qa, undefined, 'removed');
    assert.deepEqual(issues, []);
  } finally { await f.close(); }
});
