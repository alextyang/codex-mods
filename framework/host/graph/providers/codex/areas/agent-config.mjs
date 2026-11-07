// Codex defaults (breadth D10): the user and project config layers shown by Configuration. The app's own writes are followed by its
// query-cache refresh; project file edits stay in framework-main, through workspaceFiles.
import { join } from 'node:path';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Setting'],
  operations: { Model: ['makeDefault'] },
  links: { Setting: ['section', 'definedBy', 'project'], CodexAgent: ['settings', 'instructions', 'skills', 'toolServers', 'plugins'] },
};

const choices = (...ids) => ids.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1).replaceAll('-', ' ') }));
export const DEFAULTS = [
  { key: 'approval_policy', title: 'Approval policy', kind: 'choice', choices: choices('on-request', 'never') },
  { key: 'sandbox_mode', title: 'Sandbox mode', kind: 'choice', choices: choices('read-only', 'workspace-write', 'danger-full-access') },
  { key: 'sandbox_workspace_write.network_access', title: 'Network access', kind: 'toggle' },
  { key: 'web_search', title: 'Web search', kind: 'choice', choices: choices('disabled', 'cached', 'indexed', 'live') },
  { key: 'model_verbosity', title: 'Model verbosity', kind: 'choice', choices: choices('low', 'medium', 'high') },
  { key: 'model_reasoning_summary', title: 'Reasoning summary', kind: 'choice', choices: choices('auto', 'concise', 'detailed', 'none') },
  { key: 'model', title: 'Default model', kind: 'text' },
  { key: 'model_reasoning_effort', title: 'Default reasoning effort', kind: 'choice', choices: choices('minimal', 'low', 'medium', 'high', 'xhigh') },
];

/** One of the Configuration page's Codex defaults, from its own config layer rather than the merged effective config. */
export function configSettingData(key, value, { scope, projectId }) {
  const { title, kind, choices } = DEFAULTS.find((d) => d.key === key);
  return {
    ref: scope === 'app' ? refs.configSetting(key) : refs.projectSetting(projectId, key),
    state: { title, key, value: value ?? null, default: null, scope, kind, ...(kind === 'choice' ? { choices } : {}) },
    links: { section: refs.settingsSection('agent'), definedBy: refs.agent(), ...(scope === 'project' ? { project: refs.project(projectId) } : {}) },
  };
}

const DETAIL = "It changes Codex's config.toml: new threads and the command line use it.";
const refused = (reason, message) => ({ status: 'refused', reason, message });
function valueAt(config, key) {
  let value = config;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return null;
    value = value[part];
  }
  return value ?? null;
}
function validValue(key, value) {
  const def = DEFAULTS.find((d) => d.key === key);
  return !!def && (value === null || (def.kind === 'choice' ? def.choices.some((c) => c.id === value)
    : def.kind === 'toggle' ? typeof value === 'boolean' : typeof value === 'string' && value.trim().length > 0));
}

export function types(feed) {
  return { Model: { operations: { makeDefault: {
    effect: 'external', approval: ({ instance }) => feed().modelPrompt(instance),
    handler: ({ ref, intent }) => feed().makeDefault(ref, intent),
  } } } };
}

export function createFeed(ctx) {
  let settings = new Map(), userLayer = null;
  let reading = null, again = false, synced = false, finishedAt = null, disposed = false;
  let readTimer = null, linkTimer = null, readInterval = null, linkInterval = null;

  function relink() {
    if (disposed) return;
    const agent = ctx.resident(refs.agent());
    if (!agent) return;
    const all = (concept) => {
      try {
        return (ctx.graph.list(concept) ?? []).filter((x) => x.ref.provider === ctx.handle.id && !x.gone && (concept !== 'Plugin' || x.state.installed === true)).map((x) => x.ref);
      } catch { return []; } // An area may not have registered this concept yet.
    };
    const links = {
      settings: [...settings.values()].filter((s) => s.data.state.scope === 'app').map((s) => s.data.ref),
      instructions: all('Instructions'), skills: all('Skill'), toolServers: all('ToolServer'), plugins: all('Plugin'),
    };
    if (Object.keys(links).some((key) => JSON.stringify(agent.links[key]) !== JSON.stringify(links[key]))) ctx.safe('agent config links', () => ctx.handle.update(refs.agent(), { links }));
  }
  function scheduleLinks() {
    if (disposed) return;
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => { linkTimer = null; relink(); }, 1000);
    linkTimer.unref?.();
  }

  async function readOnce() {
    const next = new Map();
    const r = await ctx.request('config/read', { includeLayers: true, cwd: null });
    const user = r.layers?.find((l) => l.name.type === 'user');
    for (const { key } of DEFAULTS) {
      const data = configSettingData(key, valueAt(user?.config, key), { scope: 'app' });
      next.set(data.ref.id, { key, data });
    }
    for (const project of ctx.appProjects?.list() ?? []) {
      const root = project.roots[0];
      if (!root) continue;
      const response = await ctx.request('config/read', { includeLayers: true, cwd: root });
      const layer = response.layers?.find((l) => l.name.type === 'project' && l.name.dotCodexFolder === join(root, '.codex'));
      if (!layer) continue;
      for (const { key } of DEFAULTS.slice(0, 6)) {
        const data = configSettingData(key, valueAt(layer.config, key), { scope: 'project', projectId: project.id });
        next.set(data.ref.id, { key, root, projectId: project.id, data });
      }
    }
    if (disposed) return;
    for (const [id, s] of next) {
      const old = settings.get(id);
      ctx.safe('config setting', () => ctx.handle.put(s.data.ref, { state: s.data.state, links: s.data.links }));
      if (synced && old && JSON.stringify(old.data.state.value) !== JSON.stringify(s.data.state.value)) ctx.emitEvent(s.data.ref, 'changed');
    }
    for (const [id, s] of settings) if (!next.has(id)) ctx.safe('config setting removal', () => ctx.handle.remove(s.data.ref));
    settings = next;
    userLayer = user ? { filePath: user.name.file, version: user.version } : null;
    synced = true;
  }
  function read() {
    if (disposed) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        try { await readOnce(); } catch { ctx.log.warn('agent-config: the Codex config could not be read'); }
        scheduleLinks();
      } while (again && !disposed);
    })().finally(() => { reading = null; finishedAt = ctx.now(); });
    return reading;
  }
  function scheduleRead() {
    if (disposed) return;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => { readTimer = null; read(); }, 500);
    readTimer.unref?.();
  }

  function owns(ref) {
    return ref.type === 'Setting' && ref.provider === ctx.handle.id && (ref.id.startsWith('config:') || ref.id.startsWith('project:')) && settings.has(ref.id);
  }
  function change(ref, value) {
    if (!owns(ref)) return refused('unavailable', 'the config setting is not known');
    const s = settings.get(ref.id);
    if (!validValue(s.key, value)) return refused('invalid', 'the value does not fit this config setting');
    if (!ctx.serverUp()) return ctx.DOWN;
    if (s.data.state.scope === 'app' && !userLayer) return refused('unavailable', 'the user config layer is not known');
    if (s.projectId && ctx.appProjects?.get(s.projectId)?.roots[0] !== s.root) return refused('unavailable', 'the project config root is no longer available');
    return s.data.state.value === value ? null : s;
  }
  async function refresh() {
    try {
      const r = await ctx.mainOp('refresh', { keys: [['config'], ['user-saved-config']] });
      if (!r.ok) ctx.log.warn('agent-config: the app pages could not be refreshed');
    } catch { ctx.log.warn('agent-config: the app pages could not be refreshed'); }
    await read();
  }
  async function write(ref, value) {
    const s = change(ref, value);
    if (!s || s.status === 'refused') return s;
    if (s.projectId) {
      const r = await ctx.mainOp('project-config-write', { root: s.root, key: s.key, value });
      if (!r.ok) {
        if (r.refused) return refused('unavailable', r.error);
        throw new Error(r.error);
      }
    } else {
      await ctx.request('config/value/write', { keyPath: s.key, value, mergeStrategy: value === null ? 'replace' : 'upsert', filePath: userLayer.filePath, expectedVersion: userLayer.version });
    }
    await refresh();
    return null;
  }
  function modelChange(ref) {
    if (!ctx.serverUp()) return ctx.DOWN;
    return settings.get(refs.configSetting('model').id)?.data.state.value === ref.id ? null : true;
  }
  const sub = ctx.appProjects?.onChange(() => { read(); });

  return {
    read, relink,
    start() {
      if (!readInterval && !disposed) {
        readInterval = setInterval(read, 5 * 60_000); readInterval.unref?.();
        linkInterval = setInterval(scheduleLinks, 60_000); linkInterval.unref?.();
      }
      scheduleLinks();
      return read();
    },
    serverUp: read,
    observe(ref, concept) {
      if (concept !== 'Setting' || (!ref.id.startsWith('config:') && !ref.id.startsWith('project:'))) return undefined;
      return reading ?? (finishedAt === null || ctx.now() - finishedAt > 30_000 ? read() : Promise.resolve());
    },
    notified() { scheduleLinks(); },
    responded(method) { scheduleLinks(); if (method === 'config/batchWrite' || method === 'config/value/write') scheduleRead(); },
    settings: {
      owns, write, reset: (ref) => write(ref, null),
      prompt(instance, requested) {
        const s = change(instance.ref, requested?.op === 'reset' ? null : requested?.value);
        if (!s || s.status === 'refused') return null;
        const who = s.projectId ? `the project “${ctx.appProjects.get(s.projectId).name}”` : 'you';
        return { action: `change “${instance.state.title}” for ${who}`, detail: DETAIL };
      },
    },
    modelPrompt(instance) {
      const c = modelChange(instance.ref);
      return c && c.status !== 'refused' ? { action: `make “${instance.state.name}” Codex's default model`, detail: DETAIL } : null;
    },
    async makeDefault(ref, intent) {
      const c = modelChange(ref);
      if (!c || c.status === 'refused') return c;
      await ctx.request('config/batchWrite', { edits: [{ keyPath: 'model', value: ref.id, mergeStrategy: 'upsert' }], filePath: null, expectedVersion: null, reloadUserConfig: true }, intent);
      await refresh();
      return null;
    },
    dispose() {
      disposed = true;
      clearTimeout(readTimer); clearTimeout(linkTimer); clearInterval(readInterval); clearInterval(linkInterval);
      sub?.dispose();
    },
  };
}
