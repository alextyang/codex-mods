'use strict';
// Local automations through the app's shared service (breadth step D9). Updates are whole items, as on its Automations page. Creating
// one (E7 usefulness rework) is the service's own `create`, with the item its Scheduled page builds: a cron (each run a new chat, in a
// project or none) or a heartbeat (each run a turn in a chat). `open` shows one where the user manages it.
const kit = require('../area-kit.cjs');
// the service's own methods: an automation the graph made or changed passed the mods already (user-actions.cjs holds the user's); an
// update's read and write inside the automation's write lock (no other writer's lands between them)
const { own, exclusive } = require('../user-actions.cjs');
const { providedOf } = require('../provided-automations.cjs');

const RRULE = /^[A-Z0-9;=,:\-\r\n]{1,2000}$/i;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** The item the app's service creates, checked: the app's own defaults where a value is absent (local runs; null model and effort,
 *  which the app resolves when it runs). */
function itemOf(x) {
  if (!x || typeof x !== 'object') throw kit.refusal('an automation item is needed');
  const text = (v, max, what) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw kit.refusal(`${what} is text of at most ${max} characters`); return v; };
  const common = { name: text(x.name, 250, 'the name'), prompt: text(x.prompt, 100000, 'the prompt'), status: x.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE' };
  if (typeof x.rrule !== 'string' || !RRULE.test(x.rrule)) throw kit.refusal('the schedule is an RRULE');
  const policy = x.notificationPolicy === 'failed_runs_only' ? { notificationPolicy: 'failed_runs_only' } : {};
  if (x.kind === 'heartbeat') {
    if (typeof x.targetThreadId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(x.targetThreadId)) throw kit.refusal('a heartbeat watches a chat');
    return { kind: 'heartbeat', ...common, targetThreadId: x.targetThreadId, model: null, reasoningEffort: null, ...policy, rrule: x.rrule.trim() };
  }
  if (x.projectId !== null && (typeof x.projectId !== 'string' || !x.projectId || x.projectId.length > 200)) throw kit.refusal('a project id, or null for none');
  if (x.model !== null && (typeof x.model !== 'string' || !x.model || x.model.length > 200)) throw kit.refusal('a model id, or null for the app\'s');
  if (x.reasoningEffort !== null && !EFFORTS.includes(x.reasoningEffort)) throw kit.refusal(`an effort: ${EFFORTS.join(', ')}, or null`);
  return { kind: 'cron', ...common, projectId: x.projectId, executionEnvironment: x.executionEnvironment === 'worktree' ? 'worktree' : 'local',
    localEnvironmentConfigPath: null, model: x.model, reasoningEffort: x.reasoningEffort, autoArchive: x.autoArchive === true, ...policy, rrule: x.rrule.trim() };
}

function register(hooks) {
  function notify() {
    for (const w of hooks.appHost.windows()) kit.postToView(hooks, w.id, { type: 'automation-runs-updated' });
  }
  // the Host gone: a mod's automations are no longer shown (their ids stay ours: an act on one is refused, never the app's)
  hooks.onHostState?.((up) => { if (!up && providedOf(hooks).hostDown()) notify(); });
  hooks.onAreaOp('automations', async (op, args = {}) => {
    // a mod's Automations, as the Host says they are now (H7pa): the app's pages read them again when they changed
    if (op === 'provided') {
      if (providedOf(hooks).set(args)) notify();
      return {};
    }
    if (op === 'list') {
      const { svc } = kit.service(hooks, 'localAutomations', ['list', 'readHistory']);
      // framework-main's own reads: the app's own automations only, never a mod's (the codex provider takes these for Codex's)
      const list = await kit.withTimeout(own(svc, 'list'));
      const history = await kit.withTimeout(own(svc, 'readHistory', { limit: 200 }));
      return {
        automations: list.items.map((item) => Object.fromEntries([
          ...['id', 'kind', 'name', 'prompt', 'status', 'rrule', 'nextRunAt', 'lastRunAt', 'model', 'reasoningEffort', 'notificationPolicy',
            'executionEnvironment', 'localEnvironmentConfigPath', 'autoArchive', 'targetThreadId'].map((key) => [key, item[key] ?? null]),
          ['projectId', item.target?.type === 'project' ? item.target.projectId ?? null : null],
        ])),
        runs: history.items.map((item) => Object.fromEntries(['threadId', 'automationId', 'status', 'createdAt'].map((key) => [key, item[key] ?? null]))),
        migrated: list.habitatMigrationComplete === true,
      };
    }
    if (op === 'create') {
      const item = itemOf(args.item);
      const { svc } = kit.service(hooks, 'localAutomations', ['create']);
      const result = await kit.withTimeout(own(svc, 'create', item));
      if (!result || !result.item || typeof result.item.id !== 'string') throw new Error('the app created no automation');
      notify();
      return { id: result.item.id };
    }
    if (op === 'open') {   // where the user manages it: its page, or the chat a heartbeat watches
      const winId = Number.isSafeInteger(args.windowId) ? args.windowId : hooks.electron?.focusedWindow?.() ?? null;
      if (!Number.isSafeInteger(winId)) throw kit.refusal('no window is open');
      if (typeof args.id !== 'string' || !args.id) throw kit.refusal('an automation id is needed');
      const state = { sidebarArea: 'scheduled', sidebarAutomationId: args.id, sidebarAutomationSource: 'local' };
      const path = typeof args.threadId === 'string' && args.threadId ? `/local/${args.threadId}` : `/automations?automationId=${encodeURIComponent(args.id)}`;
      kit.navigate(hooks, winId, path, state);
      return {};
    }
    if (!['run-now', 'update', 'delete'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    const id = args.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw kit.refusal('an automation id of at most 200 characters is needed');
    if (op === 'run-now') {
      const { svc } = kit.service(hooks, 'localAutomations', ['runNow']);
      await kit.withTimeout(own(svc, 'runNow', { id, collaborationMode: null, permissions: null }));
    } else if (op === 'update') {
      const changes = args.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.entries(changes).some(([key, value]) =>
        !['name', 'prompt', 'status', 'rrule'].includes(key) || typeof value !== 'string' || (key === 'status' && !['ACTIVE', 'PAUSED'].includes(value)))) {
        throw kit.refusal('changes must be name, prompt, status (ACTIVE or PAUSED), or rrule strings');
      }
      const { svc } = kit.service(hooks, 'localAutomations', ['list', 'update']);
      await kit.withTimeout(exclusive(id, async () => {
        const list = await own(svc, 'list');
        const item = list.items.find((x) => x.id === id);
        if (!item) throw kit.refusal('the automation is gone');
        const whole = item.kind === 'heartbeat'
          ? { id, kind: 'heartbeat', name: item.name, prompt: item.prompt, status: item.status, targetThreadId: item.targetThreadId,
            model: null, reasoningEffort: null, notificationPolicy: item.notificationPolicy, rrule: item.rrule }
          : { id, kind: 'cron', name: item.name, prompt: item.prompt, status: item.status,
            projectId: item.target?.type === 'project' ? item.target.projectId ?? null : null,
            executionEnvironment: item.executionEnvironment, localEnvironmentConfigPath: item.localEnvironmentConfigPath,
            model: item.model, reasoningEffort: item.reasoningEffort, notificationPolicy: item.notificationPolicy, autoArchive: item.autoArchive, rrule: item.rrule };
        await own(svc, 'update', { ...Object.fromEntries(Object.entries(whole).filter(([, value]) => value !== undefined)), ...changes });
      }));
    } else {
      const { svc } = kit.service(hooks, 'localAutomations', ['delete']);
      const result = await kit.withTimeout(own(svc, 'delete', { id }));
      if (result.success === false) throw new Error(result.status);
    }
    notify();
    return {};
  });
}

module.exports = { register };
