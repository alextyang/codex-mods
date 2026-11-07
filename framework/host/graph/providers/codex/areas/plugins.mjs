// Plugins in the native graph (breadth D10): the app-server's catalog and installed apps, with writes followed by the app's own page
// refresh and browser plugin sync. Account connection happens on the app's plugin page. No hosted client calls or direct config writes.
import { randomUUID } from 'node:crypto';
import { refs } from '../map.mjs';
import { projectTrust, ownLayer } from './tool-servers.mjs';

export const realizes = {
  types: ['Plugin'],
  operations: { Plugin: ['install', 'uninstall', 'enable', 'disable', 'inherit', 'connect', 'disconnect'] },
  supports: { Plugin: ['connected', 'enabledIn', 'disabledIn'] },
  events: { Plugin: ['installed', 'uninstalled', 'enabled', 'disabled', 'connected', 'disconnected'] },
  links: { Plugin: ['agents', 'enabledIn', 'disabledIn'] },
};

/**
 * The catalog's summary -> the Plugin instance. Install targets stay outside the graph's state. `enabled` is the user's (`userEnabled`,
 * their config's: the catalog, read for the projects' folders, may say a project's), `scopes` the projects whose own settings decide it.
 */
export function pluginData(summary, _marketplace, { connected, userEnabled, scopes = null } = {}) {
  const inProjects = (on) => [...(scopes ?? new Map())].filter(([, v]) => v === on).map(([id]) => refs.project(id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ref: refs.plugin(summary.id),
    state: {
      name: summary.interface?.displayName || summary.name,
      description: summary.interface?.shortDescription || '',
      installed: summary.installed,
      enabled: (typeof userEnabled === 'boolean' ? userEnabled : summary.enabled) && summary.installed,
      ...(connected === undefined ? {} : { connected }),
    },
    links: { agents: summary.installed ? [refs.agent()] : [], enabledIn: inProjects(true), disabledIn: inProjects(false) },
  };
}

export function installTarget(summary, marketplace) {
  return { pluginName: summary.name, ...(marketplace.path ? { marketplacePath: marketplace.path } : { remoteMarketplaceName: marketplace.name }) };
}

export function types(feed) {
  return {
    Plugin: {
      operations: {
        install: { effect: 'external', approval: ({ instance }) => feed().prompt('install', instance), handler: ({ ref, intent }) => feed().install(ref, intent) },
        uninstall: { effect: 'external', approval: ({ instance }) => feed().prompt('uninstall', instance), handler: ({ ref, intent }) => feed().uninstall(ref, intent) },
        enable: { effect: 'external', approval: ({ instance, args }) => feed().prompt('enable', instance, args), handler: ({ ref, args, intent }) => (args?.[0] != null ? feed().scoped('enable', ref, args, intent) : feed().enable(ref, intent)) },
        disable: { effect: 'external', approval: ({ instance, args }) => feed().prompt('disable', instance, args), handler: ({ ref, args, intent }) => (args?.[0] != null ? feed().scoped('disable', ref, args, intent) : feed().disable(ref, intent)) },
        // scoped enable (F9): enable and disable with {project}, and inherit, act on that project's own settings
        inherit: { effect: 'external', approval: ({ instance, args }) => feed().prompt('inherit', instance, args), handler: ({ ref, args, intent }) => feed().scoped('inherit', ref, args, intent) },
        connect: { effect: 'none', handler: ({ ref }) => feed().connect(ref) },
        disconnect: { effect: 'none', handler: ({ ref }) => feed().disconnect(ref) },
      },
    },
  };
}

const refused = (reason, message) => ({ status: 'refused', reason, message });
const FRESH_MS = 30_000;
const REFRESH_KEYS = [['plugins'], ['apps'], ['mcp', 'servers', 'status'], ['skills'], ['config']];

export function createFeed(ctx) {
  let disposed = false, heard = false, again = false;
  let reading = null, timer = null, finishedAt = null, userLayer = null;
  let targets = new Map();
  let instances = new Map();
  let scopes = new Map();   // plugin id -> Map(project id -> enabled): the projects whose own settings decide it
  let trust = new Map();    // project id -> whether Codex reads its own settings (true, false, null: not known)
  const appsByVersion = new Map();

  async function readOnce() {
    const cwds = (ctx.appProjects?.list() ?? []).flatMap((p) => p.roots);
    // The remote catalog is too large to read; the app's own local queries also request only local marketplaces.
    const catalog = await ctx.request('plugin/list', { cwds, marketplaceKinds: ['local'] });
    const installed = await ctx.request('plugin/installed', { cwds });
    // the user's own on or off where their config does not say it: the installed plugins as no project sees them (the catalog above is
    // read for the projects' folders, where a project's own settings may decide it)
    const home = cwds.length ? await ctx.request('plugin/installed', {}) : installed;
    const homeEnabled = new Map();
    for (const m of home.marketplaces ?? []) for (const s of m.plugins ?? []) if (typeof s?.enabled === 'boolean') homeEnabled.set(s.id, s.enabled);
    const config = await ctx.request('config/read', { includeLayers: true });
    const layer = config.layers?.find((l) => l.name.type === 'user');
    // each project's own settings (its one folder's .codex/config.toml: a project of several folders is not scoped): which plugins it
    // turns on or off, said by that layer itself, and whether Codex reads them at all (scoped enable, F9)
    const nextScopes = new Map(), nextTrust = new Map(), read = new Map();
    for (const p of ctx.appProjects?.list() ?? []) {
      if (p.roots.length !== 1) continue;
      const root = p.roots[0];
      if (!read.has(root)) read.set(root, await ctx.request('config/read', { includeLayers: true, cwd: root }));
      const r = read.get(root);
      nextTrust.set(p.id, projectTrust(root, r.layers, config.config?.projects));
      for (const [id, entry] of Object.entries(r.config?.plugins ?? {})) {
        if (!ownLayer(r.origins?.[`plugins.${id}.enabled`]?.name, root) || typeof entry?.enabled !== 'boolean') continue;
        const m = nextScopes.get(id) ?? new Map();
        m.set(p.id, entry.enabled);
        nextScopes.set(id, m);
      }
    }
    const installedApps = await ctx.request('app/installed', {});
    const callable = new Set(installedApps.apps.filter((a) => a.callable).map((a) => a.id));
    const summaries = new Map();
    for (const marketplace of [...catalog.marketplaces, ...installed.marketplaces]) {
      for (const summary of marketplace.plugins) summaries.set(summary.id, { summary, marketplace });
    }
    const next = new Map(), nextTargets = new Map();
    for (const { summary, marketplace } of summaries.values()) {
      const target = installTarget(summary, marketplace);
      let connected;
      if (summary.installed) {
        const key = `${summary.id}@${summary.version}`;
        let apps = appsByVersion.get(key);
        if (apps === undefined) {
          // One plugin's details can fail (natively: a remote plugin of the account's own that the catalog answers 404 for); only its
          // `connected` stays unknown, and it is not asked again for this version.
          try {
            apps = (await ctx.request('plugin/read', target)).plugin.apps.map((a) => a.id);
          } catch (e) {
            apps = null;
            ctx.log.warn('plugins: a plugin\'s details could not be read', { plugin: summary.id, message: String(e?.message ?? e) });
          }
          appsByVersion.set(key, apps);
        }
        if (apps?.length) connected = apps.every((id) => callable.has(id));
      }
      const own = config.config?.plugins?.[summary.id]?.enabled;
      const userEnabled = typeof own === 'boolean' ? own : homeEnabled.get(summary.id);
      next.set(summary.id, pluginData(summary, marketplace, { connected, userEnabled, scopes: nextScopes.get(summary.id) }));
      nextTargets.set(summary.id, target);
    }
    if (disposed) return;
    userLayer = layer ? { filePath: layer.name.file, version: layer.version } : null;
    targets = nextTargets;
    scopes = nextScopes;
    trust = nextTrust;
    for (const [id, d] of next) {
      const was = instances.get(id)?.state;
      ctx.safe('plugin', () => ctx.handle.put(d.ref, { state: d.state, links: d.links }));
      if (!heard || !was) continue;
      if (was.installed !== d.state.installed) ctx.emitEvent(d.ref, d.state.installed ? 'installed' : 'uninstalled');
      if (d.state.installed && was.enabled !== d.state.enabled) ctx.emitEvent(d.ref, d.state.enabled ? 'enabled' : 'disabled');
      if (was.connected !== undefined && d.state.connected !== undefined && was.connected !== d.state.connected) ctx.emitEvent(d.ref, d.state.connected ? 'connected' : 'disconnected');
    }
    for (const [id, d] of instances) if (!next.has(id)) ctx.safe('plugin removal', () => ctx.handle.remove(d.ref));
    instances = next;
    heard = true;
  }

  // Everyone shares this promise, including its queued reread; observe only joins it, without queuing another read.
  function read() {
    if (disposed || !ctx.serverUp()) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        try { await readOnce(); } catch (e) { ctx.log.warn('plugins: the plugins could not be read', { message: String(e?.message ?? e) }); }
      } while (again && !disposed && ctx.serverUp());
    })().finally(() => { reading = null; finishedAt = ctx.now(); });
    return reading;
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; read(); }, 500);
    timer.unref?.();
  }

  // true means a write is needed, null means already done, and a refusal means nothing can be tried.
  function check(op, ref, state) {
    if (!ctx.serverUp()) return ctx.DOWN;
    if (op === 'install') {
      if (state.installed) return null;
      return targets.has(ref.id) ? true : refused('unavailable', 'the plugin has no install target');
    }
    if (op === 'uninstall') {
      if (!state.installed) return null;
      return ref.id === 'code-review@openai-bundled' ? refused('unsupported', 'Codex manages this plugin; it cannot be uninstalled') : true;
    }
    if (!state.installed) return refused('unsupported', 'the plugin is not installed');
    if (state.enabled === (op === 'enable')) return null;
    if (ref.id.includes('.')) return refused('unsupported', 'a config key path cannot name this plugin');
    if (!userLayer) return refused('unavailable', 'the user config layer is not known');
    return true;
  }

  async function change(op, ref, intent) {
    const allowed = check(op, ref, ctx.resident(ref).state);
    if (allowed !== true) return allowed;
    if (op === 'install') await ctx.request('plugin/install', { ...targets.get(ref.id), installAttemptId: randomUUID() }, intent);
    else if (op === 'uninstall') await ctx.request('plugin/uninstall', { pluginId: ref.id }, intent);
    else await ctx.request('config/batchWrite', {
      edits: [{ keyPath: `plugins.${ref.id}.enabled`, value: op === 'enable', mergeStrategy: 'upsert' }],
      filePath: userLayer.filePath, expectedVersion: userLayer.version, reloadUserConfig: true,
    }, intent);
    for (const [mainOp, args] of [['refresh', { keys: REFRESH_KEYS }], ['plugin-sync', {}]]) {
      try {
        const r = await ctx.mainOp(mainOp, args);
        if (!r.ok) ctx.log.warn(`plugins: ${mainOp} could not be run`, { message: r.error });
      } catch (e) { ctx.log.warn(`plugins: ${mainOp} could not be run`, { message: String(e?.message ?? e) }); }
    }
    await read();
    return null;
  }

  /**
   * A plugin on or off in one project, or as the user's there (`inherit`): its own .codex/config.toml's `[plugins."<id>"] enabled` (the
   * app-server writes only the user's config). `{root, project, value}`, null (it is so already) or a refusal: not installed, not one of
   * the app's projects, a project Codex does not read the settings of (not trusted).
   */
  function scopedCheck(op, ref, args) {
    if (!ctx.serverUp()) return ctx.DOWN;
    const state = ctx.resident(ref)?.state;
    if (!state?.installed) return refused('unsupported', 'the plugin is not installed');
    const p = args?.[0]?.project;
    const project = p && p.type === 'LocalProject' && p.provider === ctx.handle.id && typeof p.id === 'string' ? ctx.appProjects?.get(p.id) : null;
    if (!project?.roots?.[0]) return refused('invalid', "one of the app's projects is needed");
    if (project.roots.length > 1) return refused('unsupported', 'a project of several folders: each folder has its own settings (change its .codex/config.toml)');
    if (trust.get(project.id) !== true) return refused('unavailable', `Codex does not read the project's own settings: its folder is not trusted (trust it when the app asks, or in the command line)`);
    const value = op === 'inherit' ? null : op === 'enable';
    const now = scopes.get(ref.id)?.get(project.id);
    if (value === null ? now === undefined : now === value) return null;
    return { root: project.roots[0], project, value };
  }
  async function scoped(op, ref, args) {
    const c = scopedCheck(op, ref, args);
    if (!c || c.status === 'refused') return c;
    const r = await ctx.mainOp('project-enabled', { root: c.root, name: ref.id, value: c.value });
    if (!r.ok) {
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    }
    try { await ctx.mainOp('refresh', { keys: REFRESH_KEYS }); } catch { /* the pages read it later */ }
    await read();
    return null;
  }

  async function navigate(ref) {
    if (!ctx.serverUp()) return ctx.DOWN;
    try {
      const r = await ctx.mainOp('navigate', { path: '/plugins/' + encodeURIComponent(ref.id) });
      return r.ok ? null : refused('unavailable', r.error);
    } catch (e) { return refused('unavailable', String(e?.message ?? e)); }
  }

  const sub = ctx.appProjects?.onChange(() => { read(); });
  return {
    read,
    start: read,
    serverUp: read,
    /**
     * The app's own request as a Plugin operation, for the graph to hold (public-hooks.md §3.5, H6m): an install by its target (the
     * catalog's), an uninstall, a plugin's enabled turned on or off. Null: not one (or a plugin the catalog does not know).
     */
    appOperation(method, p) {
      if (method === 'plugin/install') {
        const named = () => {
          for (const [id, t] of targets) {
            if (t.pluginName === p.pluginName && (t.marketplacePath ?? null) === (p.marketplacePath ?? null) && (t.remoteMarketplaceName ?? null) === (p.remoteMarketplaceName ?? null)) return { ref: refs.plugin(id), operation: 'install', args: [] };
          }
          return null;
        };
        // one its catalog does not name yet (a marketplace added since it was read): read again first (built review H6m1)
        return named() ?? { pending: { type: 'Plugin', operation: 'install' }, resolve: async () => { await read(); return named(); }, failed: 'the plugin is not in the catalog' };
      }
      if (method === 'plugin/uninstall') return typeof p.pluginId === 'string' && p.pluginId ? { ref: refs.plugin(p.pluginId), operation: 'uninstall', args: [] } : null;
      // a plugin's enabled, written alone (the page's batch write, or a value write); several at once with one of them: refused while
      // something holds a plugin's enable or disable (one approval cannot cover them: built review H6m1)
      const edits = method === 'config/batchWrite' && Array.isArray(p.edits) ? p.edits : [];
      if (edits.length > 1 && edits.some((x) => typeof x?.keyPath === 'string' && /^plugins\./.test(x.keyPath))) {
        return { refuse: 'several changes at once: make them one at a time', type: 'Plugin', operation: 'enable', held: [['Plugin', 'enable'], ['Plugin', 'disable']] };
      }
      const e = method === 'config/batchWrite' ? (edits.length === 1 ? edits[0] : null) : method === 'config/value/write' ? p : null;
      const m = e && typeof e.keyPath === 'string' ? /^plugins\.(.+)\.enabled$/.exec(e.keyPath) : null;
      if (m && typeof e.value === 'boolean') return { ref: refs.plugin(m[1]), operation: e.value ? 'enable' : 'disable', args: [] };
      return null;
    },
    observe(_ref, concept) {
      if (concept !== 'Plugin') return undefined;
      return reading ?? (finishedAt === null || ctx.now() - finishedAt > FRESH_MS ? read() : Promise.resolve());
    },
    notified(method) { if (['app/list/updated', 'skills/changed', 'account/updated'].includes(method)) schedule(); },
    responded(method) { if (['plugin/install', 'plugin/uninstall', 'config/batchWrite', 'config/value/write'].includes(method)) schedule(); },
    prompt(op, instance, args) {
      const name = `“${instance.state.name}”`;
      if (op === 'inherit' || ((op === 'enable' || op === 'disable') && args?.[0] != null)) {
        const c = scopedCheck(op, instance.ref, args);
        if (!c || c.status === 'refused') return null;
        return { action: op === 'inherit' ? `let the project “${c.project.name}” follow your setting for the plugin ${name}` : `turn ${op === 'enable' ? 'on' : 'off'} the plugin ${name} in the project “${c.project.name}”`,
          detail: "It changes the project's own .codex/config.toml: new threads in that project, and the command line there, use it." };
      }
      if (check(op, instance.ref, instance.state) !== true) return null;
      if (op === 'install') return { action: `install the plugin ${name}`, detail: "It adds the plugin's tools, skills and connections to Codex." };
      if (op === 'uninstall') return { action: `uninstall the plugin ${name}`, detail: 'Codex loses its tools, skills and connections.' };
      return { action: `turn ${op === 'enable' ? 'on' : 'off'} the plugin ${name}`, detail: "It changes Codex's config.toml: new threads and the command line use it." };
    },
    install: (ref, intent) => change('install', ref, intent),
    uninstall: (ref, intent) => change('uninstall', ref, intent),
    enable: (ref, intent) => change('enable', ref, intent),
    disable: (ref, intent) => change('disable', ref, intent),
    scoped,
    connect: navigate,
    disconnect: navigate,
    dispose() { disposed = true; clearTimeout(timer); sub?.dispose(); },
  };
}
