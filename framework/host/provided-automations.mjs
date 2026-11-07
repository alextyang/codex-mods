// A mod's Automations in the app's Scheduled page (public-hooks.md §3.15, H7pa; scout of 2026-10-31). The page lists what the app's
// main-process automations service (`localAutomations`) gives, over the app's own bridge, never the app-server: framework-main adds a mod's
// Automations to that service's list, as the app's own items, and routes the user's acts on one (pause, resume, edit, delete, run now) here, where each is the provider's own operation, invoked as the
// user; never the app's (its files and its scheduler know nothing of them; the provider runs them). A provided Automation is one of a
// provider other than Codex's; its app id names it (`codexmods-` and its ref as JSON in base64url: safe in the app's paths, both ways; one
// too long for that is not listed). Its runs are its provider's chats (`Thread.automation`), listed and opened as that agent's chats are
// (graph-integrity G2.1, G2.2), never as rows of the page's history: the app holds no chat of a mod's. One Automation's acts happen one at a time, each against what it is when its
// turn comes (built review H7pa round 1). Node built-ins only.
import { scheduleOf, rruleOf } from './graph/providers/codex/areas/automations.mjs';

export const PREFIX = 'codexmods-';
export const MAX_APP_ID = 500;   // the longest app id listed (the app keeps it in its paths and pages)
const USER = Object.freeze({ kind: 'user', id: 'user', owner: 'app' });
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';
const keyOf = (r) => `${r.provider}\n${r.type}\n${r.id}`;

/** The app id of a provided Automation. */
export const appIdOf = (ref) => PREFIX + Buffer.from(JSON.stringify([ref.provider, ref.type, ref.id])).toString('base64url');
/** The Automation an app id names, or null (not one of ours). */
export function refOfAppId(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX) || id.length > MAX_APP_ID) return null;
  try {
    const [provider, type, rid] = JSON.parse(Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8'));
    return [provider, type, rid].every((x) => typeof x === 'string' && x) ? { type, provider, id: rid } : null;
  } catch { return null; }
}
const textOf = (c) => (Array.isArray(c?.parts) ? c.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : typeof c === 'string' ? c : '');
/** Its schedule as the app's RRULE: the one it states (kept as it is: the user's own, a monthly one), else the one its fields say. */
const rruleOfSchedule = (schedule) => (typeof schedule?.rrule === 'string' && schedule.rrule.trim() ? schedule.rrule.trim() : rruleOf(schedule));

/**
 * A provided Automation as the app's own item (a `cron`: each run a new chat, the project it names when it is one of the app's, else
 * none), or null when it cannot be one (its schedule says no RRULE, it has no name, its app id is too long).
 */
export function itemOf(inst) {
  if (!inst || inst.gone || !isRef(inst.ref)) return null;
  const s = inst.state ?? {};
  const rrule = rruleOfSchedule(s.schedule);
  const id = appIdOf(inst.ref);
  if (!rrule || typeof s.name !== 'string' || !s.name.trim() || id.length > MAX_APP_ID) return null;
  const project = inst.links?.project;
  const projectId = isRef(project) && project.provider === 'codex' ? project.id : null;
  return {
    id, kind: 'cron', name: s.name.slice(0, 250), prompt: textOf(s.prompt).slice(0, 100000) || s.name, status: s.enabled === false ? 'PAUSED' : 'ACTIVE',
    rrule, nextRunAt: typeof s.nextRunAt === 'number' ? s.nextRunAt : null, lastRunAt: typeof s.lastRunAt === 'number' ? s.lastRunAt : null,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
    target: projectId ? { type: 'project', projectId } : { type: 'projectless' }, cwds: [], projectId,
    model: null, reasoningEffort: null, executionEnvironment: s.where === 'worktree' ? 'worktree' : 'local', localEnvironmentConfigPath: null,
    autoArchive: s.archiveRuns === true, ...(s.notifications === 'failures' ? { notificationPolicy: 'failed_runs_only' } : {}),
  };
}

// what of the app's item an edit can say, as the Automation's own fields (the rest it has none of: a change of one is refused, never
// answered as saved). Its model and effort are not among them, nor refused: the app's editor sends one with every save (its own default
// when the item names none), and a mod's automation runs with its provider's settings; the answer, the provider's item, names none.
const NOTIFY = { failed_runs_only: 'failures' };
const UNSAID = ['kind', 'targetThreadId', 'localEnvironmentConfigPath'];
/**
 * What the app's automations item says changed, as the provider's operation: its status alone is enable or disable; anything else an
 * edit of its fields (name, prompt, schedule, project, where it runs, notifications, archiving runs; enabled with them). `{refused}` for
 * a change it cannot say; null when nothing changed.
 */
export function actOfUpdate(before, item) {
  if (!item || typeof item !== 'object') return null;
  const differs = (k) => item[k] !== undefined && JSON.stringify(item[k] ?? null) !== JSON.stringify(before[k] ?? null);
  const unsaid = UNSAID.filter(differs);
  if (unsaid.length) return { refused: `a mod's automation has no ${unsaid.join(', ')} the app can set` };
  const changes = {};
  if (typeof item.name === 'string' && differs('name')) changes.name = item.name;
  if (typeof item.prompt === 'string' && differs('prompt')) changes.prompt = { parts: [{ kind: 'text', text: item.prompt }] };
  if (typeof item.rrule === 'string' && item.rrule.trim() !== before.rrule) changes.schedule = scheduleOf(item.rrule.trim());
  if (differs('projectId')) changes.project = typeof item.projectId === 'string' && item.projectId ? { type: 'LocalProject', provider: 'codex', id: item.projectId } : null;
  if (differs('executionEnvironment')) changes.where = item.executionEnvironment === 'worktree' ? 'worktree' : 'local';
  if (item.notificationPolicy !== undefined && (NOTIFY[item.notificationPolicy] ?? 'all') !== (NOTIFY[before.notificationPolicy] ?? 'all')) changes.notifications = NOTIFY[item.notificationPolicy] ?? 'all';
  if (differs('autoArchive')) changes.archiveRuns = item.autoArchive === true;
  const statusChanged = item.status !== undefined && item.status !== before.status;
  if (!Object.keys(changes).length) return statusChanged ? { operation: item.status === 'PAUSED' ? 'disable' : 'enable', args: [] } : null;
  if (statusChanged) changes.enabled = item.status !== 'PAUSED';
  return { operation: 'edit', args: [changes] };
}

/** @param {{ graph: object, send: (provided: {items: object[]}) => Promise<unknown> | void, log?: object, debounceMs?: number }} o */
export function createProvidedAutomations(o) {
  const log = o.log ?? { info() {}, warn() {} };
  const autos = new Map();   // key -> instance
  const queues = new Map();  // automation key -> the end of its acts (one at a time)
  let timer = null, last = '', disposed = false;
  const provided = (x) => isRef(x?.ref) && x.ref.provider !== 'codex' && !x.gone;
  const push = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      const items = [...autos.values()].map(itemOf).filter(Boolean);
      const json = JSON.stringify(items);
      if (json === last) return;
      last = json;
      Promise.resolve(o.send({ items })).catch((e) => log.warn('provided automations: framework-main was not told', { message: String(e?.message ?? e) }));
    }, o.debounceMs ?? 100);
    timer.unref?.();
  };
  const view = o.graph.subscribe({ type: 'Automation' }, (m) => {
    if (!m) return true;
    if (m.type === 'snapshot') {
      const now = new Map((m.items ?? []).filter(provided).map((x) => [keyOf(x.ref), x]));
      for (const k of [...autos.keys()]) if (!now.has(k)) autos.delete(k);
      for (const [k, x] of now) autos.set(k, x);
    } else if (m.type === 'delta' && isRef(m.event?.ref) && m.event.ref.provider !== 'codex' && m.event.kind !== 'event') {
      const k = keyOf(m.event.ref);
      if (m.event.kind === 'removed' || !provided(m.event.instance)) autos.delete(k); else autos.set(k, m.event.instance);
    } else return true;
    push();
    return true;
  });
  /** One Automation's acts, one at a time (each decided against what it is when its turn comes). */
  const inTurn = (k, fn) => {
    const run = (queues.get(k) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    queues.set(k, tail);
    void tail.then(() => { if (queues.get(k) === tail) queues.delete(k); });
    return run;
  };
  /** It now, as the graph has it (after its provider's own write). */
  const now = (ref) => { const x = typeof o.graph.resolve === 'function' ? o.graph.resolve(ref) : null; return x && !x.gone ? x : autos.get(keyOf(ref)) ?? null; };

  return {
    /**
     * The user's act on a provided Automation in the app (framework-main's `provided-act`: `update` with the app's item, `delete`, `runNow`),
     * as its provider's operation: the graph's outcome, an update's value the item as it is after it; refused when the id names none of them, or the change is none it can say.
     */
    async act({ id, operation, item }, signal) {
      const ref = refOfAppId(id);
      if (!ref || !autos.has(keyOf(ref))) return { status: 'refused', reason: 'unavailable', message: 'no such automation of a mod' };
      if (!['update', 'delete', 'runNow'].includes(operation)) return { status: 'refused', reason: 'unsupported', message: `a mod's automation does not ${operation}` };
      return inTurn(keyOf(ref), async () => {
        const inst = autos.get(keyOf(ref));
        if (!inst) return { status: 'refused', reason: 'unavailable', message: 'no such automation of a mod' };
        let call;
        if (operation === 'update') {
          call = actOfUpdate(itemOf(now(inst.ref)) ?? {}, item);
          if (!call) return { status: 'done', value: itemOf(now(inst.ref)) };
          if (call.refused) return { status: 'refused', reason: 'unsupported', message: call.refused };
        } else call = { operation, args: [] };
        const out = await o.graph.invoke({ ref: inst.ref, operation: call.operation, args: call.args, caller: USER, origin: 'app', ...(signal ? { signal } : {}) });
        return operation === 'update' && out?.status === 'done' ? { ...out, value: itemOf(now(inst.ref)) } : out;
      });
    },
    /** What framework-main lists now (tests). */
    current() { return { items: [...autos.values()].map(itemOf).filter(Boolean) }; },
    dispose() { disposed = true; clearTimeout(timer); try { view?.dispose(); } catch { /* gone */ } },
  };
}
