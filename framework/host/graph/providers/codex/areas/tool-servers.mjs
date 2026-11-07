// MCP servers and tools (breadth D10): the app's layered config joined to its live tool catalog. Writes use the same protocol calls as
// MCP settings, then ask framework-main to refresh the app's pages. Config values stay private to this feed and the protocol request.
import { realpathSync } from 'node:fs';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['ToolServer', 'Tool'],
  operations: { ToolServer: ['edit', 'enable', 'disable', 'inherit', 'restart', 'remove', 'signIn'], Tool: ['enable', 'disable'], CodexAgent: ['addToolServer'] },
  supports: { ToolServer: ['error', 'source', 'enabledIn', 'disabledIn'], CodexAgent: ['addToolServer'] },
  events: { ToolServer: ['statusChanged', 'toolsChanged'] },
  links: { ToolServer: ['agents', 'account', 'plugin', 'enabledIn', 'disabledIn'], Tool: ['server', 'plugin'] },
};

export function serverStatus(entry, status) {
  if (entry?.enabled === false) return 'disabled';
  switch (status?.runtimeStatus) {
    case 'notStarted': case 'starting': return 'starting';
    case 'connected': return 'connected';
    case 'authenticationRequired': case 'failed': case 'cancelled': return 'error';
    case 'disabled': return 'disabled';
    default: return status?.toolsError ? 'error' : Object.keys(status?.tools ?? {}).length ? 'connected' : 'starting';
  }
}

export function serverAuth(status) {
  switch (status?.authStatus) {
    case 'oAuth': case 'bearerToken': return 'signedIn';
    case 'notLoggedIn': return 'needsSignIn';
    default: return 'none';
  }
}

export function toolEnabled(entry, name) {
  if (entry?.enabled === false) return false;
  if (Array.isArray(entry?.enabled_tools)) return entry.enabled_tools.includes(name);
  return !Array.isArray(entry?.disabled_tools) || !entry.disabled_tools.includes(name);
}

export function toolServerData(key, entry, status, { readOnly: _readOnly, account, source = null, scopes = null } = {}) {
  // the projects whose own settings turn it on or off (scoped enable, F9)
  const inProjects = (on) => [...(scopes ?? new Map())].filter(([, v]) => v === on).map(([id]) => refs.project(id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ref: refs.toolServer(key),
    state: {
      name: key, transport: entry ? Object.hasOwn(entry, 'command') ? 'local' : 'remote' : status?.httpOrigin ? 'remote' : 'local',
      status: serverStatus(entry, status), auth: serverAuth(status),
      ...(typeof status?.toolsError === 'string' && status.toolsError ? { error: status.toolsError } : {}),
      ...(source ? { source } : {}),
    },
    links: { agents: [refs.agent()], ...(key === 'codex_apps' && account ? { account } : {}), ...(status?.pluginId ? { plugin: refs.plugin(status.pluginId) } : {}),
      enabledIn: inProjects(true), disabledIn: inProjects(false) },
  };
}

/**
 * A folder's path as Codex compares them (scoped enable, F9): its real path (a symbolic link followed, as Codex's loader canonicalizes a
 * project's folder), else as written; without a trailing slash.
 */
export function canonical(p) {
  if (typeof p !== 'string' || !p) return p;
  let out = p;
  try { out = realpathSync.native(p); } catch { /* not there (yet): as written */ }
  return out.length > 1 ? out.replace(/\/+$/, '') : out;
}
/** Is `layerName` (a config layer's or an origin's `name`) a project's own layer, its `.codex` folder the one in `root` (both real paths)? */
export const ownLayer = (layerName, root, canon = canonical) => layerName?.type === 'project' && typeof layerName.dotCodexFolder === 'string'
  && typeof root === 'string' && canon(layerName.dotCodexFolder) === canon(`${root.replace(/\/+$/, '')}/.codex`);
/**
 * Whether Codex reads a project's own settings (its folder trusted, scoped enable): true, false, or null when not known. Its own layer
 * says so when it has a file (`disabledReason`: not trusted); else the user's trust entries, for its folder or one around it. Paths are
 * compared as Codex does, real paths (`canon`).
 */
export function projectTrust(root, layers, trustEntries, canon = canonical) {
  const own = (layers ?? []).find((l) => ownLayer(l?.name, root, canon));
  if (own) return !own.disabledReason;
  const r = canon(root);
  let best = null, len = -1;
  for (const [folder, v] of Object.entries(trustEntries ?? {})) {
    const f = canon(folder);
    if (typeof f === 'string' && (r === f || r.startsWith(`${f}/`)) && f.length > len) { best = v?.trust_level ?? null; len = f.length; }
  }
  return best === 'trusted' ? true : best === 'untrusted' ? false : null;
}

export function toolData(server, name, tool, { enabled, pluginId } = {}) {
  return {
    ref: refs.tool(server, name),
    state: { name, description: tool.description ?? tool.title ?? '', enabled, source: pluginId ? 'plugin' : 'toolServer' },
    links: { server: refs.toolServer(server), ...(pluginId ? { plugin: refs.plugin(pluginId) } : {}) },
  };
}

const CONFIG_KEYS = new Set(['command', 'args', 'env', 'env_vars', 'cwd', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'auth', 'oauth', 'scopes', 'oauth_resource', 'enabled', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools']);
const DETAIL = "It changes Codex's config.toml: new threads and the command line use it.";
const PROJECT_DETAIL = "It changes the project's own .codex/config.toml: new threads in that project, and the command line there, use it.";
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REFRESH = { keys: [['config'], ['user-saved-config'], ['mcp', 'servers', 'status']] };
const refused = (reason, message) => ({ status: 'refused', reason, message });

function validConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((k) => !CONFIG_KEYS.has(k))) return false;
  const command = Object.hasOwn(config, 'command'), url = Object.hasOwn(config, 'url');
  const value = command ? config.command : config.url;
  return command !== url && typeof value === 'string' && value.trim().length > 0;
}

export function types(feed) {
  const operations = (names, prompts) => Object.fromEntries(names.map((name) => [name, {
    effect: 'external',
    ...(prompts.includes(name) ? { approval: (call) => feed().prompt(name, call) } : {}),
    handler: (call) => feed().perform(name, call),
  }]));
  return {
    ToolServer: { supports: ['error', 'enabledIn', 'disabledIn'], operations: operations(realizes.operations.ToolServer, ['edit', 'remove', 'enable', 'disable', 'inherit']) },
    Tool: { operations: operations(realizes.operations.Tool, ['enable', 'disable']) },
    // a new server in the user's config.toml, as the app's MCP settings add one (a mod's asks first): its ToolServer once it is read
    CodexAgent: { operations: operations(['addToolServer'], ['addToolServer']) },
  };
}

export function createFeed(ctx) {
  let servers = new Map(), tools = new Map();
  let trust = new Map();   // project id -> whether Codex reads its own settings (true, false, null: not known)
  let userFile = null, reading = null, again = false, heard = false, finishedAt = null, timer = null, disposed = false;
  const pending = new Map(); // server name -> login ids started here

  async function readOnce() {
    const entries = new Map(), statuses = new Map();
    const notUser = new Set();   // keys a layer other than the user's defines or overrides any field of, at any root (a project's)
    let file = null;
    const projects = ctx.appProjects?.list() ?? [];
    // a project's own settings are its folder's .codex/config.toml (where they are written): the projects a root's config reads them for
    // (every project of that one folder; a project of several folders has none here: it is not scoped)
    const ownersOf = new Map();
    for (const p of projects) if (p.roots.length === 1) ownersOf.set(p.roots[0], [...(ownersOf.get(p.roots[0]) ?? []), p.id]);
    const scopes = new Map();   // key -> Map(project id -> enabled) where a project's own layer decides it
    const nextTrust = new Map();
    let trustEntries = null;
    const roots = new Set([null, ...projects.flatMap((p) => p.roots)]);
    for (const cwd of roots) {
      const r = await ctx.request('config/read', { includeLayers: true, cwd });
      file ??= r.layers?.find((l) => l.name.type === 'user')?.name.file ?? null;
      if (cwd === null) trustEntries = r.config?.projects ?? {};
      const pids = cwd === null ? [] : ownersOf.get(cwd) ?? [];
      for (const pid of pids) if (!nextTrust.has(pid)) nextTrust.set(pid, projectTrust(cwd, r.layers, trustEntries));
      for (const [path, origin] of Object.entries(r.origins ?? {})) {
        // a project's own on or off is its scope, not where the server is configured
        const m = /^mcp_servers\.([^.]+)(?:\.(.+))?$/.exec(path);
        if (m && origin?.name?.type !== 'user' && m[2] !== 'enabled') notUser.add(m[1]);
      }
      if (pids.length) {
        // its own: said by the project's own layer (the file a scoped write edits), not one of a folder around it
        for (const [key, entry] of Object.entries(r.config?.mcp_servers ?? {})) {
          if (!ownLayer(r.origins?.[`mcp_servers.${key}.enabled`]?.name, cwd) || typeof entry?.enabled !== 'boolean') continue;
          const m = scopes.get(key) ?? new Map();
          for (const pid of pids) if (!m.has(pid)) m.set(pid, entry.enabled);
          scopes.set(key, m);
        }
      }
      for (const [key, entry] of Object.entries(r.config?.mcp_servers ?? {})) {
        if (key.includes('.') || entries.has(key)) continue;
        const origin = r.origins?.[`mcp_servers.${key}.command`] ?? r.origins?.[`mcp_servers.${key}.url`] ?? r.origins?.[`mcp_servers.${key}.enabled`];
        entries.set(key, { entry, readOnly: origin?.name.type === 'project' });
      }
    }
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const r = await ctx.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100, cursor });
      for (const status of r.data) statuses.set(status.name, status);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    if (disposed) return;
    const nextServers = new Map(), nextTools = new Map();
    for (const key of new Set([...entries.keys(), ...statuses.keys()])) {
      if (key.includes('.')) continue;
      const { entry = null, readOnly = true } = entries.get(key) ?? {};
      const status = statuses.get(key) ?? null;
      // where it is configured: only the user's config, a project's (any field), or a plugin alone (no config names it)
      const source = entry ? (notUser.has(key) ? 'project' : 'user') : status?.pluginId ? 'plugin' : null;
      const data = toolServerData(key, entry, status, { readOnly, account: ctx.account(), source, scopes: scopes.get(key) ?? null });
      const catalog = new Map(servers.get(key)?.catalog);
      for (const [name, tool] of Object.entries(status?.tools ?? {})) catalog.set(name, tool);
      // The app-server omits tools turned off by config. Keep them addressable, using their last reported description.
      const kept = new Set(Object.keys(status?.tools ?? {}));
      for (const name of Array.isArray(entry?.disabled_tools) ? entry.disabled_tools : []) kept.add(name);
      if (Array.isArray(entry?.enabled_tools)) for (const name of catalog.keys()) if (!entry.enabled_tools.includes(name)) kept.add(name);
      const names = entry?.enabled === false ? [] : [...kept].sort();
      nextServers.set(key, { entry, readOnly, data, names, catalog, scopes: scopes.get(key) ?? new Map() });
      ctx.safe('tool server', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
      for (const name of names) {
        const d = toolData(key, name, catalog.get(name) ?? {}, { enabled: toolEnabled(entry, name), pluginId: status?.pluginId });
        nextTools.set(d.ref.id, { server: key, name, ref: d.ref });
        ctx.safe('tool', () => ctx.handle.put(d.ref, { state: d.state, links: d.links }));
      }
    }
    for (const [id, t] of tools) if (!nextTools.has(id)) ctx.safe('tool removal', () => ctx.handle.remove(t.ref));
    for (const [key, s] of servers) if (!nextServers.has(key)) ctx.safe('tool server removal', () => ctx.handle.remove(s.data.ref));
    const before = servers;
    servers = nextServers;
    tools = nextTools;
    trust = nextTrust;
    userFile = file;
    if (heard) for (const [key, s] of servers) {
      const old = before.get(key);
      if (!old) continue;
      if (['status', 'auth', 'error'].some((k) => old.data.state[k] !== s.data.state[k])) ctx.emitEvent(s.data.ref, 'statusChanged');
      if (JSON.stringify(old.names) !== JSON.stringify(s.names)) ctx.emitEvent(s.data.ref, 'toolsChanged');
    }
    heard = true;
  }

  function read() {
    if (disposed) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        // A protocol error may contain a config value. Log the failure without its payload.
        try { await readOnce(); } catch { ctx.log.warn('tool-servers: the config and tool catalog could not be read'); }
      } while (again && !disposed);
    })().finally(() => { reading = null; finishedAt = ctx.now(); });
    return reading;
  }
  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; read(); }, 500);
    timer.unref?.();
  }
  const sub = ctx.appProjects?.onChange(() => { read(); });

  /** CodexAgent.addToolServer(name, config): the write, or a refusal (the same for its approval and its handler). */
  function addition([name, config] = []) {
    if (!ctx.serverUp()) return ctx.DOWN;
    if (typeof name !== 'string' || !SERVER_NAME.test(name)) return refused('invalid', 'a server name of letters, digits, - and _ (at most 64)');
    if (!validConfig(config)) return refused('invalid', 'a tool server config needs exactly one command or URL and only supported keys');
    if (servers.has(name)) return refused('invalid', `there is a tool server “${name}” already: edit it`);
    if (!userFile) return refused('unavailable', 'the user config layer file is not known');
    return { params: { edits: [{ keyPath: `mcp_servers.${name}`, value: config, mergeStrategy: 'replace' }], filePath: userFile, expectedVersion: null } };
  }

  // Prepare only protocol data here, so the approval and the handler have the same refusal and no-op rules.
  function change(operation, { ref, args = [] }) {
    if (!ctx.serverUp()) return ctx.DOWN;
    const tool = ref.type === 'Tool' ? tools.get(ref.id) : null;
    const key = tool?.server ?? ref.id;
    const s = servers.get(key);
    if (!s?.entry) return refused('unsupported', 'it comes with the app or a plugin: change that instead');
    if (s.readOnly) return refused('unsupported', "a project's own tool server: change its .codex/config.toml");
    if (!userFile) return refused('unavailable', 'the user config layer file is not known');
    if (tool) {
      const enabled = operation === 'enable';
      if (toolEnabled(s.entry, tool.name) === enabled) return null;
      const allow = Array.isArray(s.entry.enabled_tools);
      const field = allow ? 'enabled_tools' : 'disabled_tools';
      const list = Array.isArray(s.entry[field]) ? s.entry[field] : [];
      const add = allow === enabled;
      const names = add ? [...new Set([...list, tool.name])] : list.filter((n) => n !== tool.name);
      return { method: 'config/value/write', params: { keyPath: `mcp_servers.${key}.${field}`, value: !allow && !names.length ? null : names, mergeStrategy: 'replace', filePath: null, expectedVersion: null } };
    }
    if (operation === 'edit' && !validConfig(args[0])) return refused('invalid', 'a tool server config needs exactly one command or URL and only supported keys');
    if (operation === 'addToolServer') return null;   // add() checks its own arguments
    if (operation === 'edit' || operation === 'remove') return {
      method: 'config/batchWrite', params: { edits: [{ keyPath: `mcp_servers.${key}`, value: operation === 'remove' ? null : args[0], mergeStrategy: 'replace' }], filePath: userFile, expectedVersion: null },
    };
    return { method: 'config/value/write', params: { keyPath: `mcp_servers.${key}.enabled`, value: operation === 'enable', mergeStrategy: 'upsert', filePath: null, expectedVersion: null } };
  }

  /**
   * A server on or off in one project, or as the user's there (`inherit`): its own .codex/config.toml's `[mcp_servers.<name>] enabled`
   * (scoped enable, F9; the app-server writes only the user's config). `{root, name, value, project}`, null (it is so already) or a
   * refusal: a server the user's config does not define, a project's own, a project Codex does not read the settings of (not trusted).
   */
  function scoped(operation, { ref, args = [] }) {
    if (!ctx.serverUp()) return ctx.DOWN;
    const s = servers.get(ref.id);
    if (!s?.entry) return refused('unsupported', 'it comes with the app or a plugin: change that instead');
    if (s.readOnly) return refused('unsupported', "a project's own tool server: change its .codex/config.toml");
    const p = args[0]?.project;
    const project = p && p.type === 'LocalProject' && p.provider === ctx.handle.id && typeof p.id === 'string' ? ctx.appProjects?.get(p.id) : null;
    if (!project?.roots?.[0]) return refused('invalid', "one of the app's projects is needed");
    if (project.roots.length > 1) return refused('unsupported', 'a project of several folders: each folder has its own settings (change its .codex/config.toml)');
    if (trust.get(project.id) !== true) return refused('unavailable', `Codex does not read the project's own settings: its folder is not trusted (trust it when the app asks, or in the command line)`);
    const value = operation === 'inherit' ? null : operation === 'enable';
    const now = s.scopes.get(project.id);
    if (value === null ? now === undefined : now === value) return null;
    return { root: project.roots[0], name: ref.id, value, project };
  }
  const isScoped = (operation, call) => operation === 'inherit' || ((operation === 'enable' || operation === 'disable') && call.ref.type === 'ToolServer' && call.args?.[0] != null);

  async function refresh() {
    try {
      const r = await ctx.mainOp('refresh', REFRESH);
      if (!r.ok) ctx.log.warn('tool-servers: the app pages could not be refreshed');
    } catch { ctx.log.warn('tool-servers: the app pages could not be refreshed'); }
    await read();
  }
  async function loginCompleted(p) {
    const key = p?.loginId ? [...pending].find(([, ids]) => ids.has(p.loginId))?.[0] : pending.has(p?.name) ? p.name : null;
    if (key === null || key === undefined) return;
    if (p.loginId) { pending.get(key).delete(p.loginId); if (!pending.get(key).size) pending.delete(key); }
    else pending.delete(key);
    if (p.success !== true || disposed) return;
    try { await ctx.request('config/mcpServer/reload'); await read(); }
    catch { ctx.log.warn('tool-servers: the servers could not be reloaded after sign-in'); }
  }

  return {
    read, start: read, serverUp: read,
    /**
     * The app's own request as a ToolServer operation, for the graph to hold (public-hooks.md §3.5, H6m): a server's config written whole
     * (an edit, a removal, or a new one: the agent's addToolServer), its enabled turned on or off, its sign-in. Null: not one.
     */
    appOperation(method, p) {
      if (method === 'config/batchWrite') {
        const edits = Array.isArray(p.edits) ? p.edits : [];
        // several at once with a server's: refused while something holds a server's change (one approval cannot cover them: review H6m1)
        if (edits.length > 1 && edits.some((x) => typeof x?.keyPath === 'string' && /^mcp_servers\./.test(x.keyPath))) {
          return { refuse: 'several changes at once: make them one at a time', type: 'ToolServer', operation: 'edit',
            held: [['ToolServer', 'edit'], ['ToolServer', 'remove'], ['ToolServer', 'enable'], ['ToolServer', 'disable'], ['CodexAgent', 'addToolServer']] };
        }
        const e = edits.length === 1 ? edits[0] : null;
        const m = e && typeof e.keyPath === 'string' ? /^mcp_servers\.([^.]+)$/.exec(e.keyPath) : null;
        if (!m) return null;
        if (e.value === null) return servers.has(m[1]) ? { ref: refs.toolServer(m[1]), operation: 'remove', args: [] } : null;
        if (!e.value || typeof e.value !== 'object') return null;
        // a change of the config (or of a new server's name) is carried out as the app's own write of it: a config the app takes, never
        // another operation (a null is a removal) nor another server's write (built review H6m1)
        const write = (keyPath, value, version = p.expectedVersion) => (validConfig(value) ? { ...p, expectedVersion: version, edits: [{ ...e, keyPath, value }] } : null);
        if (servers.has(m[1])) return { ref: refs.toolServer(m[1]), operation: 'edit', args: [e.value], params: ([value]) => write(e.keyPath, value) };
        // a new one: the user's layer as it is now says whether it is (round 2: the cache may be older), and a rewritten one is written
        // against that version of it, under a name it does not have
        return { pending: { type: 'CodexAgent', operation: 'addToolServer' }, failed: 'the user config layer could not be read', resolve: async () => {
          const fresh = await ctx.request('config/read', { includeLayers: true, cwd: null });
          const layer = (fresh?.layers ?? []).find((l) => l.name?.type === 'user');
          if (!layer || typeof layer.version !== 'string') return null;
          const has = (name) => [fresh.config?.mcp_servers, layer.config?.mcp_servers].some((o) => !!o && typeof o === 'object' && Object.hasOwn(o, name));
          if (has(m[1])) return { ref: refs.toolServer(m[1]), operation: 'edit', args: [e.value], params: ([value]) => write(e.keyPath, value, layer.version) };
          return { ref: refs.agent(), operation: 'addToolServer', args: [m[1], e.value],
            params: ([name, value]) => (typeof name === 'string' && SERVER_NAME.test(name) && !has(name) ? write(`mcp_servers.${name}`, value, layer.version) : null) };
        } };
      }
      if (method === 'config/value/write') {
        const m = typeof p.keyPath === 'string' ? /^mcp_servers\.([^.]+)\.enabled$/.exec(p.keyPath) : null;
        return m && typeof p.value === 'boolean' ? { ref: refs.toolServer(m[1]), operation: p.value ? 'enable' : 'disable', args: [] } : null;
      }
      if (method === 'mcpServer/oauth/login') return typeof p.name === 'string' && p.name ? { ref: refs.toolServer(p.name), operation: 'signIn', args: [] } : null;
      return null;
    },
    observe(_ref, concept) {
      if (concept !== 'ToolServer' && concept !== 'Tool') return undefined;
      return reading ?? (finishedAt === null || ctx.now() - finishedAt > 30_000 ? read() : Promise.resolve());
    },
    notified(method, p) {
      if (method === 'mcpServer/oauthLogin/completed') return loginCompleted(p);
      if (['mcpServer/startupStatus/updated', 'account/updated', 'app/list/updated'].includes(method)) schedule();
    },
    responded(method) { if (['config/batchWrite', 'config/value/write', 'config/mcpServer/reload'].includes(method)) schedule(); },
    prompt(operation, call) {
      if (operation === 'addToolServer') { const c = addition(call.args); return c?.status === 'refused' ? null : { action: `add the tool server “${call.args[0]}”`, detail: DETAIL }; }
      if (isScoped(operation, call)) {
        const c = scoped(operation, call);
        if (!c || c.status === 'refused') return null;
        const what = `the tool server “${call.ref.id}”`;
        return { action: operation === 'inherit' ? `let the project “${c.project.name}” follow your setting for ${what}` : `turn ${operation === 'enable' ? 'on' : 'off'} ${what} in the project “${c.project.name}”`, detail: PROJECT_DETAIL };
      }
      const c = change(operation, call);
      if (!c || c.status === 'refused') return null;
      const t = call.ref.type === 'Tool' ? tools.get(call.ref.id) : null;
      const verb = operation === 'enable' ? 'turn on' : 'turn off';
      const action = t ? `${verb} the tool “${t.name}” of “${t.server}”` : `${operation === 'edit' ? 'change' : operation === 'remove' ? 'remove' : verb} the tool server “${call.ref.id}”`;
      return { action, detail: DETAIL };
    },
    async perform(operation, call) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const { ref, intent } = call;
      if (operation === 'addToolServer') {
        const c = addition(call.args);
        if (c.status === 'refused') return c;
        // an addition, not an edit: the user's layer as it is now must not have the name, and the write is against that version of it
        const fresh = await ctx.request('config/read', { includeLayers: true, cwd: null });
        const layer = (fresh?.layers ?? []).find((l) => l.name?.type === 'user');
        if (!layer || typeof layer.version !== 'string') return refused('unavailable', 'the user config layer is not known');
        const has = (o) => !!o && typeof o === 'object' && Object.hasOwn(o, call.args[0]);   // own keys only: a server may be named `constructor`
        if (has(fresh.config?.mcp_servers) || has(layer.config?.mcp_servers)) return refused('invalid', `there is a tool server “${call.args[0]}” already: edit it`);
        await ctx.request('config/batchWrite', { ...c.params, expectedVersion: layer.version }, intent);
        await refresh();
        return servers.has(call.args[0]) ? refs.toolServer(call.args[0]) : { status: 'uncertain', operation: 'addToolServer' };
      }
      if (operation === 'signIn') {
        if (servers.get(ref.id)?.data.state.auth !== 'needsSignIn') return null;
        const r = await ctx.request('mcpServer/oauth/login', { name: ref.id }, intent);
        const ids = pending.get(ref.id) ?? new Set();
        ids.add(r.loginId);
        pending.set(ref.id, ids);
        try {
          const opened = await ctx.mainOp('open-url', { url: r.authorizationUrl });
          if (!opened.ok) return refused('unavailable', opened.error);
        } catch (e) { return refused('unavailable', String(e?.message ?? e)); }
        return null;
      }
      if (isScoped(operation, call)) {
        const c = scoped(operation, call);
        if (!c || c.status === 'refused') return c;
        const r = await ctx.mainOp('project-enabled', { root: c.root, name: c.name, value: c.value });
        if (!r.ok) {
          if (r.refused) return refused('unavailable', r.error);
          throw new Error(r.error);
        }
        await refresh();
        return null;
      }
      if (operation === 'restart') {
        // The app has no per-server restart: this reloads every MCP server, without restarting the app-server.
        await ctx.request('config/mcpServer/reload', undefined, intent);
      } else {
        const c = change(operation, call);
        if (!c || c.status === 'refused') return c;
        await ctx.request(c.method, c.params, intent);
      }
      await refresh();
      return null;
    },
    dispose() { disposed = true; clearTimeout(timer); sub?.dispose(); pending.clear(); },
  };
}
