// The fake app-server's plugin catalog and connections (D10):
//   plugin/list {cwds?, marketplaceKinds?} -> marketplaces with summaries: absent/null kinds include the remote catalog; an array
//     includes only marketplaces with a path when it contains 'local', otherwise none. plugin/installed {cwds?} lists all installed plugins.
//     An installed plugin's enabled value comes from the shared config, default true: read at the first of `cwds` when given (as the real
//     catalog may say a project's own), else the user's. Two local plugins (alpha installed, beta not) and remote gamma.
//   plugin/read {pluginName, marketplacePath | remoteMarketplaceName} -> {plugin: PluginDetail}, including its apps.
//   plugin/install {pluginName, marketplacePath | remoteMarketplaceName, installAttemptId?} -> {authPolicy, appsNeedingAuth: []};
//     plugin/uninstall {pluginId} -> {}. They change installed; an unknown plugin is error -32600.
//   app/installed {} -> {apps: [{id, enabled, callable}]} from the connection state.
//   Test controls: fake/plugins {marketplaces} replaces the catalog and clears connection state; fake/pluginApps {pluginId, apps:
//     [{id, callable}]} sets a plugin's apps and their installed/callable state, then sends app/list/updated {data: AppInfo[]}.
import { configStore } from './lib/config-store.mjs';

export default function plugins(f) {
  let marketplaces = [
    { name: 'fake-local', path: '/tmp/fake-marketplace', plugins: [{ name: 'alpha', installed: true }, { name: 'beta', installed: false }] },
    { name: 'fake-remote', plugins: [{ name: 'gamma', installed: false }] },
  ];
  const pluginApps = new Map();
  let installedApps = new Map();
  const idOf = (p, market) => p.id ?? `${p.name}@${market.name}`;
  const summary = (p, market, cwd = null) => ({
    id: idOf(p, market), name: p.name, installed: false,
    authPolicy: 'ON_USE', installPolicy: 'AVAILABLE', availability: 'AVAILABLE',
    source: market.path ? { type: 'local', path: `${market.path}/${p.name}` } : { type: 'remote' },
    interface: null, version: '1',
    ...structuredClone(p),
    enabled: p.installed === true && (configStore.read(cwd).config.plugins?.[idOf(p, market)]?.enabled ?? true),
  });
  function listed(onlyInstalled, marketplaceKinds, cwds) {
    const cwd = Array.isArray(cwds) && typeof cwds[0] === 'string' ? cwds[0] : null;
    return marketplaces.filter((market) => marketplaceKinds == null || (marketplaceKinds.includes('local') && market.path))
      .map((market) => ({ ...structuredClone(market), plugins: market.plugins.filter((p) => !onlyInstalled || p.installed).map((p) => summary(p, market, cwd)) }));
  }
  function findTarget(p) {
    const market = marketplaces.find((m) => p.marketplacePath != null ? m.path === p.marketplacePath : !m.path && m.name === p.remoteMarketplaceName);
    const plugin = market?.plugins.find((v) => v.name === p.pluginName);
    return plugin ? { market, plugin } : null;
  }
  function findId(id) {
    for (const market of marketplaces) {
      const plugin = market.plugins.find((p) => idOf(p, market) === id);
      if (plugin) return { market, plugin };
    }
    return null;
  }
  return {
    'plugin/list': (m, p) => f.reply(m.id, { marketplaces: listed(false, p.marketplaceKinds, p.cwds), marketplaceLoadErrors: [], featuredPluginIds: [] }),
    'plugin/installed': (m, p) => f.reply(m.id, { marketplaces: listed(true, null, p?.cwds), marketplaceLoadErrors: [] }),
    'plugin/read': (m, p) => {
      const found = findTarget(p);
      if (!found) return f.fail(m.id, -32600, `plugin not found: ${p.pluginName}`);
      const { market, plugin } = found;
      return f.reply(m.id, { plugin: {
        summary: summary(plugin, market), marketplaceName: market.name, marketplacePath: market.path ?? null,
        apps: (pluginApps.get(idOf(plugin, market)) ?? []).map((a) => ({ id: a.id, name: a.id, category: null, installUrl: null })),
        skills: [], mcpServers: [], hooks: [], appTemplates: [], scheduledTasks: null, shareUrl: null,
      } });
    },
    'plugin/install': (m, p) => {
      const found = findTarget(p);
      if (!found) return f.fail(m.id, -32600, `plugin not found: ${p.pluginName}`);
      found.plugin.installed = true;
      return f.reply(m.id, { authPolicy: found.plugin.authPolicy ?? 'ON_USE', appsNeedingAuth: [] });
    },
    'plugin/uninstall': (m, p) => {
      const found = findId(p.pluginId);
      if (!found) return f.fail(m.id, -32600, `plugin not found: ${p.pluginId}`);
      found.plugin.installed = false;
      return f.reply(m.id, {});
    },
    'app/installed': (m) => f.reply(m.id, { apps: [...installedApps.values()] }),
    'fake/plugins': (m, p) => {
      marketplaces = structuredClone(p.marketplaces);
      pluginApps.clear();
      installedApps.clear();
      return f.reply(m.id, {});
    },
    'fake/pluginApps': (m, p) => {
      if (!findId(p.pluginId)) return f.fail(m.id, -32600, `plugin not found: ${p.pluginId}`);
      pluginApps.set(p.pluginId, structuredClone(p.apps));
      installedApps = new Map([...pluginApps.values()].flat().map((a) => [a.id, { id: a.id, enabled: true, callable: a.callable }]));
      f.reply(m.id, {});
      return f.notify('app/list/updated', { data: [...installedApps.values()].map((a) => ({ id: a.id, name: a.id, isEnabled: a.enabled, isAccessible: a.callable, pluginDisplayNames: [] })) });
    },
  };
}
