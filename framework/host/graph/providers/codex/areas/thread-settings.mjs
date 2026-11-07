// A chat's composer settings (breadth D5), from the app-server's thread settings and session answers. Writes use the same protocol as
// the composer; access stays with the app's permissions menu, which asks before granting full access.
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Setting', 'SettingsSection'],
  operations: { Model: ['_select'] },
  links: { Setting: ['section', 'definedBy', 'thread'] },
};

const KEYS = ['model', 'effort', 'mode', 'access'];
const refused = (reason, message) => ({ status: 'refused', reason, message });

/** A thread's known settings and the provider's resident Models -> four Settings and their Composer section. */
export function threadSettingsData(threadId, known, models) {
  const ownModels = models.filter((m) => m.ref.provider === refs.agent().provider && !m.gone);
  const model = ownModels.find((m) => m.ref.id === known.model);
  const sandbox = known.sandbox?.type ?? known.sandbox;
  const access = ['read-only', 'readOnly'].includes(sandbox) ? 'read-only'
    : ['workspace-write', 'workspaceWrite'].includes(sandbox) ? 'workspace'
      : ['danger-full-access', 'dangerFullAccess'].includes(sandbox) ? 'full' : null;
  const fields = [
    ['model', 'Model', ownModels.filter((m) => m.state.available).map((m) => ({ id: m.ref.id, label: m.state.name })), known.model ?? null],
    ['effort', 'Reasoning effort', model?.state.efforts ?? [], known.effort ?? null],
    ['mode', 'Mode', [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }], known.collaborationMode?.mode ?? 'default'],
    ['access', 'Access', [{ id: 'read-only', label: 'Read only' }, { id: 'workspace', label: 'Workspace' }, { id: 'full', label: 'Full access' }], access],
  ];
  return [
    ...fields.map(([key, title, choices, value]) => ({
      ref: refs.threadSetting(threadId, key),
      state: { title, key, value, default: null, scope: 'thread', kind: 'choice', choices },
      links: { section: refs.settingsSection('composer'), definedBy: refs.agent(), thread: refs.thread(threadId) },
    })),
    { ref: refs.settingsSection('composer'), state: { title: 'Composer' }, links: {} },
  ];
}

export function types(feed) {
  return { Model: { operations: { _select: {
    effect: 'external', handler: ({ ref, args: [target], intent }) => feed().select(ref, target, intent),
  } } } };
}

export function createFeed(ctx) {
  const known = new Map();       // threadId -> the latest model, effort, sandbox and collaboration mode
  const settings = new Map();    // Setting id -> the thread and key this area put
  let sectionPut = false, timer = null, disposed = false;

  function put(threadId, patch) {
    if (disposed || !threadId) return;
    const previous = known.get(threadId);
    const next = { ...previous, ...patch };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    known.set(threadId, next);
    for (const d of threadSettingsData(threadId, next, ctx.graph.list('Model'))) {
      if (d.ref.type === 'SettingsSection' && sectionPut) continue;
      const cur = ctx.resident(d.ref);
      ctx.safe('thread setting', () => ctx.handle.put(d.ref, { state: d.state, links: d.links }));
      if (d.ref.type === 'SettingsSection') { sectionPut = true; continue; }
      settings.set(d.ref.id, { threadId, key: d.ref.id.slice(d.ref.id.lastIndexOf(':') + 1) });
      if (previous && cur && cur.state.value !== d.state.value) ctx.emitEvent(d.ref, 'changed');
    }
  }
  function apply(threadId, value) {
    if (!value) return;
    put(threadId, { model: value.model, effort: value.effort ?? null, sandbox: value.sandboxPolicy?.type, collaborationMode: value.collaborationMode });
  }
  function sweep() {
    if (disposed) return;
    for (const threadId of known.keys()) {
      if (ctx.resident(refs.thread(threadId))) continue;
      known.delete(threadId);
      for (const key of KEYS) {
        const ref = refs.threadSetting(threadId, key);
        settings.delete(ref.id);
        if (ctx.resident(ref)) ctx.safe('thread setting removal', () => ctx.handle.remove(ref));
      }
    }
  }
  async function update(threadId, change, intent) {
    const r = await ctx.withLoadedThread(threadId, () => ctx.request('thread/settings/update', { threadId, ...change }, intent), intent);
    if (!disposed && r?.threadSettings) apply(threadId, r.threadSettings);
    return null;
  }
  const owns = (ref) => ref.type === 'Setting' && ref.provider === ctx.handle.id && ref.id.startsWith('thread:') && settings.has(ref.id);

  return {
    start() { if (!disposed && !timer) { timer = setInterval(sweep, 60_000); timer.unref?.(); } },
    notified(method, p) { if (method === 'thread/settings/updated') apply(p?.threadId, p?.threadSettings); },
    responded(method, r) {
      if (!['thread/start', 'thread/resume', 'thread/fork'].includes(method) || !r?.thread?.id) return;
      const patch = {};
      if (Object.hasOwn(r, 'model')) patch.model = r.model;
      if (Object.hasOwn(r, 'reasoningEffort')) patch.effort = r.reasoningEffort;
      if (Object.hasOwn(r, 'sandbox')) patch.sandbox = r.sandbox?.type ?? r.sandbox;
      if (Object.hasOwn(r, 'collaborationMode')) patch.collaborationMode = r.collaborationMode;
      put(r.thread.id, patch);
    },
    serverDown: sweep,
    settings: {
      owns,
      prompt() { return null; },
      async write(ref, value) {
        if (!ctx.serverUp()) return ctx.DOWN;
        if (!owns(ref) || !ctx.resident(ref)) return refused('unavailable', 'the chat setting is not known');
        const instance = ctx.resident(ref);
        if (!instance.state.choices.some((c) => c.id === value)) return refused('invalid', 'choose one of the setting\'s choices');
        if (instance.state.value === value) return null;
        const { threadId, key } = settings.get(ref.id);
        if (key === 'access') return refused('unsupported', "the app changes a chat's access from its permissions menu, which asks first");
        if (key === 'mode') {
          const modeSettings = known.get(threadId)?.collaborationMode?.settings;
          if (!modeSettings) return refused('unavailable', 'the chat\'s collaboration mode settings are not known');
          return update(threadId, { collaborationMode: { mode: value, settings: modeSettings } });
        }
        return update(threadId, { [key]: value });
      },
      reset() { return refused('unsupported', "a chat's setting has no default to go back to: choose a value"); },
    },
    async select(ref, target, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const thread = target && target.provider === ctx.handle.id && typeof target.id === 'string' && target.id.length > 0
        && (target.type === 'CodexThread' || target.type === 'Thread' || (target.type === 'Draft' && ctx.resident(refs.thread(target.id))));
      if (!thread) return refused('unsupported', "a model is chosen here for a chat; a new chat's or a project's comes with the composer and the Configuration page");
      return update(target.id, { model: ref.id }, intent);
    },
    dispose() { disposed = true; clearInterval(timer); },
  };
}
