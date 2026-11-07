// The fake's plugin inventory, local and remote targets, config toggles and connections, checked against every supported schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

test('plugins: catalog, installed inventory, details, installs and uninstalls, config and app connections match every build', async () => {
  const f = await startInitialized({ env: { CODEX_HOME: '/tmp/fake-plugins-home' } });
  const issues = [];
  const ask = async (method, params) => {
    issues.push(...shapeIssues('params', method, params));
    const r = await f.request(method, params);
    assert.equal(r.error, undefined, `${method}: ${JSON.stringify(r.error)}`);
    issues.push(...shapeIssues('result', method, r.result));
    return r.result;
  };
  const all = (r) => r.marketplaces.flatMap((m) => m.plugins);
  const alpha = { pluginName: 'alpha', marketplacePath: '/tmp/fake-marketplace' };
  const beta = { pluginName: 'beta', marketplacePath: '/tmp/fake-marketplace' };
  const gamma = { pluginName: 'gamma', remoteMarketplaceName: 'fake-remote' };
  try {
    const list = await ask('plugin/list', { cwds: ['/tmp/project'] });
    assert.deepEqual(list.marketplaces.map((m) => [m.name, m.path]), [['fake-local', '/tmp/fake-marketplace'], ['fake-remote', undefined]]);
    assert.deepEqual(all(list).map((p) => [p.id, p.installed, p.enabled]), [['alpha@fake-local', true, true], ['beta@fake-local', false, false], ['gamma@fake-remote', false, false]]);
    assert.deepEqual([list.marketplaceLoadErrors, list.featuredPluginIds], [[], []]);
    assert.deepEqual(await ask('plugin/list', { cwds: ['/tmp/project'], marketplaceKinds: null }), list);
    for (const marketplaceKinds of [['local'], ['local', 'created-by-me-remote']]) {
      const local = await ask('plugin/list', { cwds: ['/tmp/project'], marketplaceKinds });
      assert.deepEqual(local.marketplaces.map((m) => [m.name, m.path]), [['fake-local', '/tmp/fake-marketplace']]);
      assert.deepEqual(all(local).map((p) => p.id), ['alpha@fake-local', 'beta@fake-local']);
      assert.deepEqual([local.marketplaceLoadErrors, local.featuredPluginIds], [[], []]);
    }
    for (const marketplaceKinds of [[], ['vertical'], ['created-by-me-remote']]) {
      assert.deepEqual(await ask('plugin/list', { marketplaceKinds }), { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] });
    }
    assert.deepEqual(all(await ask('plugin/installed', {})).map((p) => p.id), ['alpha@fake-local']);
    assert.deepEqual((await ask('plugin/read', alpha)).plugin.apps, []);
    assert.equal((await ask('plugin/read', gamma)).plugin.marketplacePath, null);
    assert.deepEqual(await ask('app/installed', {}), { apps: [] });

    await f.request('fake/pluginApps', { pluginId: 'alpha@fake-local', apps: [{ id: 'mail', callable: true }, { id: 'calendar', callable: false }] });
    await f.until(() => f.inbox.some((n) => n.method === 'app/list/updated'));
    const apps = (await ask('app/installed', {})).apps;
    assert.deepEqual(apps, [{ id: 'mail', enabled: true, callable: true }, { id: 'calendar', enabled: true, callable: false }]);
    assert.deepEqual((await ask('plugin/read', alpha)).plugin.apps.map((a) => [a.id, a.name]), [['mail', 'mail'], ['calendar', 'calendar']]);
    await f.request('fake/pluginApps', { pluginId: 'alpha@fake-local', apps: [{ id: 'mail', callable: false }] });
    await f.until(() => f.inbox.filter((n) => n.method === 'app/list/updated').length === 2);
    assert.deepEqual((await ask('app/installed', {})).apps, [{ id: 'mail', enabled: true, callable: false }]);

    assert.deepEqual(await ask('plugin/install', { ...beta, installAttemptId: 'fake-attempt' }), { authPolicy: 'ON_USE', appsNeedingAuth: [] });
    await ask('plugin/install', gamma);
    assert.deepEqual(all(await ask('plugin/installed', { cwds: [] })).map((p) => p.id), ['alpha@fake-local', 'beta@fake-local', 'gamma@fake-remote']);
    assert.deepEqual(all(await ask('plugin/list', { marketplaceKinds: ['local'] })).map((p) => p.id), ['alpha@fake-local', 'beta@fake-local']);
    assert.equal((await ask('plugin/read', gamma)).plugin.summary.installed, true);
    const config = await ask('config/read', { includeLayers: true });
    const user = config.layers.find((l) => l.name.type === 'user');
    await ask('config/batchWrite', { edits: [{ keyPath: 'plugins.alpha@fake-local.enabled', value: false, mergeStrategy: 'upsert' }], filePath: user.name.file, expectedVersion: user.version, reloadUserConfig: true });
    assert.equal(all(await ask('plugin/list', {}))[0].enabled, false);
    assert.equal(all(await ask('plugin/installed', {}))[0].enabled, false);
    assert.equal((await ask('plugin/read', alpha)).plugin.summary.enabled, false);
    await ask('config/value/write', { keyPath: 'plugins.alpha@fake-local.enabled', value: true, mergeStrategy: 'upsert' });
    assert.equal(all(await ask('plugin/list', {}))[0].enabled, true);
    assert.deepEqual(await ask('plugin/uninstall', { pluginId: 'beta@fake-local' }), {});
    assert.equal(all(await ask('plugin/list', {})).find((p) => p.name === 'beta').installed, false);

    for (const [method, params] of [
      ['plugin/read', { ...alpha, pluginName: 'missing' }], ['plugin/read', { ...alpha, marketplacePath: '/unknown' }],
      ['plugin/install', { pluginName: 'missing', remoteMarketplaceName: 'fake-remote' }],
      ['plugin/uninstall', { pluginId: 'missing' }],
    ]) {
      issues.push(...shapeIssues('params', method, params));
      assert.equal((await f.request(method, params)).error.code, -32600);
    }
    await f.request('fake/plugins', { marketplaces: [{ name: 'replacement', path: null, plugins: [{ name: 'delta', installed: true, authPolicy: 'ON_INSTALL' }] }] });
    assert.deepEqual(all(await ask('plugin/list', {})).map((p) => p.id), ['delta@replacement']);
    assert.deepEqual(all(await ask('plugin/list', { marketplaceKinds: ['local'] })), []);
    assert.deepEqual(all(await ask('plugin/installed', {})).map((p) => p.id), ['delta@replacement']);
    const delta = { pluginName: 'delta', remoteMarketplaceName: 'replacement' };
    await ask('plugin/read', delta);
    assert.equal((await ask('plugin/install', delta)).authPolicy, 'ON_INSTALL');
    assert.deepEqual(await ask('app/installed', {}), { apps: [] }, 'replacement clears app state');
    for (const n of f.inbox) if (n.method === 'app/list/updated') issues.push(...shapeIssues('notification', n.method, n.params));
    assert.deepEqual(issues, []);
    assert.deepEqual((await f.request('fake/refusals', {})).result.refusals, []);
  } finally { await f.close(); }
});
