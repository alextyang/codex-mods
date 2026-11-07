// The fake app-server's MCP servers (D10):
//   mcpServerStatus/list {cursor?, limit?, detail?, threadId?, serverName?} -> {data, nextCursor}: user-config entries and status-only
//     overrides, sorted by name and paged by offset; disabled config wins over the override's runtime status. All protocol fields have
//     fake values; disabled servers have no tools, and disabled_tools or enabled_tools filters the tool catalog, as in the app-server.
//     This does not start MCP processes or contact a server.
//   config/mcpServer/reload -> {} (counts reloads); mcpServer/oauth/login {name} -> {authorizationUrl, loginId} (a fake HTTPS page).
//   Test controls: fake/mcpStatus {name, runtimeStatus?, authStatus?, tools?, toolsError?, pluginId?} sets an override;
//     fake/mcpLoginCompleted {name, loginId?, success} sends mcpServer/oauthLogin/completed;
//     fake/mcpStartup {name, status} sends mcpServer/startupStatus/updated; fake/mcpReloads -> {count}.
import { configStore } from './lib/config-store.mjs';

export default function toolServers(f) {
  const overrides = new Map();
  let reloads = 0, logins = 0;
  return {
    'mcpServerStatus/list': (m, p) => {
      const entries = new Map(Object.entries(configStore.get('mcp_servers') ?? {}));
      const names = [...new Set([...entries.keys(), ...overrides.keys()])].sort().filter((name) => p.serverName == null || name === p.serverName);
      const offset = p.cursor == null ? 0 : Number(p.cursor);
      if (!Number.isInteger(offset) || offset < 0 || (p.cursor != null && !/^\d+$/.test(p.cursor))) return f.fail(m.id, -32600, 'invalid MCP status cursor');
      if (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 0)) return f.fail(m.id, -32602, 'invalid MCP status limit');
      const limit = Math.max(1, p.limit ?? 100);
      const data = names.slice(offset, offset + limit).map((name) => {
        const entry = entries.get(name), override = overrides.get(name) ?? {};
        const tools = Object.fromEntries(Object.entries(override.tools ?? {}).filter(([tool]) => entry?.enabled !== false &&
          (Array.isArray(entry?.enabled_tools) ? entry.enabled_tools.includes(tool) : !Array.isArray(entry?.disabled_tools) || !entry.disabled_tools.includes(tool))));
        let httpOrigin = null;
        if (entry?.url) { try { httpOrigin = new URL(entry.url).origin; } catch { /* A malformed URL has no HTTP origin. */ } }
        return {
          name, runtimeStatus: entry?.enabled === false ? 'disabled' : override.runtimeStatus ?? 'connected',
          authStatus: override.authStatus ?? 'unsupported', tools, toolsError: override.toolsError ?? null,
          pluginId: override.pluginId ?? null, httpOrigin, resources: [], resourceTemplates: [], serverInfo: null, serverCapabilities: null,
        };
      });
      f.reply(m.id, { data, nextCursor: offset + limit < names.length ? String(offset + limit) : null });
    },
    'config/mcpServer/reload': (m) => { reloads += 1; f.reply(m.id, {}); },
    'mcpServer/oauth/login': (m, p) => { f.reply(m.id, { authorizationUrl: `https://auth.example.com/authorize?server=${encodeURIComponent(p.name)}`, loginId: `login-${++logins}` }); },
    'fake/mcpStatus': (m, p) => { const { name, ...status } = p; overrides.set(name, status); f.reply(m.id, {}); },
    'fake/mcpLoginCompleted': (m, p) => {
      f.notify('mcpServer/oauthLogin/completed', { name: p.name, ...(p.loginId === undefined ? {} : { loginId: p.loginId }), success: p.success, error: null, threadId: null });
      f.reply(m.id, {});
    },
    'fake/mcpStartup': (m, p) => { f.notify('mcpServer/startupStatus/updated', { name: p.name, status: p.status, error: null, failureReason: null, threadId: null }); f.reply(m.id, {}); },
    'fake/mcpReloads': (m) => { f.reply(m.id, { count: reloads }); },
  };
}
