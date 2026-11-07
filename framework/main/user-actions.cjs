'use strict';
// The user's own pins and automations held before they happen (docs/design/public-hooks.md §3.5, H6h; a scout of 21477). Every place the app offers them (a row's hover, its menus, the keyboard, the palette, the Automations
// page, a chat's automation card) ends in one method of a service the app's main process shares across its windows: `pinnedThreads.set`
// and `localAutomations.create`, `update`, `delete` and `runNow`. Their class's own methods are replaced on its prototype, as app-state.cjs
// holds a setting's write: while the Host says something holds the operation (an interceptor or a policy), a call passes the mods first;
// one it refuses is not done: an unpin answers as done without unpinning and every window is told the pins changed (the app's own
// `pinned-threads-updated`: its pages read them again, so the row goes back), an automation's throws (the Automations page says "Could
// not …" with the message); a call that passes runs as the app's own, and the mods' `after` records say what it did. Nothing held: the
// app's own call, at once, as before. A pin is never held, only observed: the app shows it pinned before it asks, and undoing that
// (whether the call throws or the pages read the pins again) breaks its page on 21477 ("Missing scope instance"), while a pin held a
// moment and let go is fine; so the mods' `after` records see the user's pins, and their interceptors see only the graph's.
// Not the user's, so never held as theirs: a pin without `useAppServerPins` (the app's archive and unarchive), the agent's own automation
// tool (`executeUpdateTool`, marked while it runs), and framework-main's own calls (`own`, the methods as they were: the graph's call
// passed the mods already). What the app shows before the call (a pin's row moved at once) is not held; the call's effect is.
const { AsyncLocalStorage } = require('node:async_hooks');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { userHoldsOf, outcomeOf } = require('./user-holds.cjs');
const kit = require('./area-kit.cjs');
const { providedOf } = require('./provided-automations.cjs');

const ORIGINALS = Symbol.for('codexmods.userActions.originals');
const agentCall = new AsyncLocalStorage();
const frameworkCall = new AsyncLocalStorage();
/** A call that is not the user's: the agent's own tool, or framework-main's own (marked while it runs). */
const notTheUser = () => agentCall.getStore() === true || frameworkCall.getStore() === true;
const CODEX = 'codex';
const thread = (id) => ({ type: 'CodexThread', provider: CODEX, id });
const automation = (id) => ({ type: 'Automation', provider: CODEX, id });
// H6m2 (public-hooks.md §3.5's M row; scouts H6m-git-holds, H6m-chat-holds, H6m-ext-holds): the Codex refs of what they act on
const project = (id) => ({ type: 'LocalProject', provider: CODEX, id });
const command = (id) => ({ type: 'Command', provider: CODEX, id });
const repository = (projectId) => ({ type: 'GitRepository', provider: CODEX, id: projectId });
const branch = (projectId, name) => ({ type: 'Branch', provider: CODEX, id: `${projectId}:${name}` });
const skill = (id) => ({ type: 'Skill', provider: CODEX, id });
const instructions = (p) => ({ type: 'Instructions', provider: CODEX, id: p });
const commit = (projectId, sha) => ({ type: 'Commit', provider: CODEX, id: `${projectId}:${sha}` });
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'AGENTS.override.md']);
const pullRequest = (url) => ({ type: 'GitHubPullRequest', provider: CODEX, id: url });
/** A pull request as the app's pages name it (`{hostname, owner, repository, number}`: no url; built review H6m2b) as its url, or null. */
function pullRequestUrl(pr) {
  if (!pr || typeof pr !== 'object') return null;
  const seg = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]+$/.test(v) && v !== '.' && v !== '..';
  const host = typeof pr.hostname === 'string' ? pr.hostname.trim().toLowerCase().replace(/\.+$/, '') : '';
  if (!/^[a-z0-9.-]+$/.test(host) || !seg(pr.owner) || !seg(pr.repository) || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
  return `https://${host}/${pr.owner}/${pr.repository}/pull/${pr.number}`;
}
const GIT_REPLY_MS = 10 * 60_000;   // how long a commit let go is listened for (its answer, its cancel or its page going end it first)
// the app's git worker, as its pages talk to it (21477: `{type: 'worker-request', workerId: 'git', request: {id, method, params}}` in,
// `{type: 'worker-response', workerId, response: {id, method, result: {type: 'ok', value} | {type: 'error', error: {message}}}}` out)
const GIT_FROM_VIEW = 'codex_desktop:worker:git:from-view';
const GIT_FOR_VIEW = 'codex_desktop:worker:git:for-view';
const workerAnswer = (id, method, result) => ({ type: 'worker-response', workerId: 'git', response: { id, method, result } });
/** What the git worker's answer says the call did (`made(value)`: what a done one made, a ref, or null). */
const workerOutcome = (result, made = () => null) => {
  if (!(result && result.type === 'ok' && result.value && result.value.status !== 'error')) return { status: 'failed', error: { message: String((result && (result.error?.message || result.value?.error)) || 'the git worker said no') } };
  const value = made(result.value);
  return { status: 'done', ...(value ? { value } : {}) };
};
const textContent = (t) => ({ parts: [{ kind: 'text', text: String(t ?? '') }] });
/** The Codex home the app uses on this Mac (projects.cjs's rule), where the global AGENTS.md is. */
const codexHome = () => path.resolve(typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex'));
/** Only this Mac's: a call for another host (an SSH host, the cloud) names none of this Mac's instances (built review H6m2a); a git
 * worker's request names its host by its config (round 2). */
const local = (req) => !req || req.hostId === undefined || req.hostId === null || req.hostId === 'local';
const localHost = (hostConfig) => !hostConfig || typeof hostConfig !== 'object' || hostConfig.id === undefined || hostConfig.id === null || hostConfig.id === 'local';
/** The branch a checkout is on (git's HEAD there), or null (detached, or not read). */
const headBranch = (cwd) => new Promise((resolve) => {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) { resolve(null); return; }
  execFile('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 2000, maxBuffer: 64 * 1024 }, (err, out) => resolve(err ? null : String(out).trim() || null));
});
/**
 * The app's project a folder is of: the innermost project whose folder holds it, else (a Codex worktree, a linked worktree elsewhere) the
 * project whose folder is that worktree's repository (git's common directory; built review H6m2a). Its id, or null.
 */
async function projectOf(projectsSvc, cwd) {
  const direct = projectAt(projectsSvc, cwd);
  if (direct || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return direct;
  const common = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 2000, maxBuffer: 64 * 1024 }, (err, out) => resolve(err ? null : String(out).trim()));
  });
  return common && path.isAbsolute(common) ? projectAt(projectsSvc, path.dirname(common)) : null;
}
/** The app's project whose folder a working directory is (or is in): its id, or null. */
function projectAt(projectsSvc, cwd) {
  if (typeof cwd !== 'string' || !cwd || !projectsSvc || typeof projectsSvc.getLocalProjects !== 'function') return null;
  let all;
  try { all = projectsSvc.getLocalProjects(); } catch { return null; }
  const at = path.resolve(cwd);
  let best = null, bestLen = -1;
  for (const [id, p] of Object.entries(all || {})) {
    for (const r of Array.isArray(p && p.rootPaths) ? p.rootPaths : []) {
      if (typeof r !== 'string' || !r) continue;
      const root = path.resolve(r);
      if ((at === root || at.startsWith(root + path.sep)) && root.length > bestLen) { best = id; bestLen = root.length; }
    }
  }
  return best;
}

/**
 * `fn()` while no other write of automation `id` runs: every writer's (the user's, the agent's tool, framework-main's own) takes it, for the
 * whole native call (its own checks before it writes, such as a heartbeat's chat read, included), so what was checked is what is written
 * over. Re-entrant: a write inside it (framework-main's read-then-write calling the held method) runs at once.
 */
const writing = new Map();   // automation id -> the end of its writers' queue
const holding = new AsyncLocalStorage();   // the automation ids the running call holds
function exclusive(id, fn) {
  const mine = holding.getStore();
  if (mine && mine.has(id)) return fn();
  const run = (writing.get(id) ?? Promise.resolve()).then(() => holding.run(new Set([...(mine ?? []), id]), fn));
  const tail = run.then(() => {}, () => {});
  writing.set(id, tail);
  void tail.then(() => { if (writing.get(id) === tail) writing.delete(id); });
  return run;
}

/**
 * `obj[name](...args)` as framework-main's own call: never held as the user's (the graph's call passed the mods already). The call is the
 * service's own (the object framework-main is handed may stand in for the class's instance, whose private fields only its own calls reach),
 * marked while it runs.
 */
function own(obj, name, ...args) {
  return frameworkCall.run(true, () => obj[name](...args));
}

/** An automation the app's service lists as the graph's AutomationSpec says one (the provider's `itemFor` the other way round). */
function specOf(item) {
  const settings = {};
  if (typeof item.model === 'string' && item.model) settings.model = item.model;
  if (typeof item.reasoningEffort === 'string' && item.reasoningEffort) settings.effort = item.reasoningEffort;
  return {
    ...(typeof item.name === 'string' ? { name: item.name } : {}), prompt: typeof item.prompt === 'string' ? item.prompt : '',
    schedule: { rrule: typeof item.rrule === 'string' ? item.rrule : '' }, enabled: item.status !== 'PAUSED',
    ...(item.kind === 'heartbeat' && typeof item.targetThreadId === 'string' ? { watches: thread(item.targetThreadId) } : {}),
    ...(typeof item.projectId === 'string' && item.projectId ? { project: { type: 'LocalProject', provider: CODEX, id: item.projectId } } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(item.kind !== 'heartbeat' ? { where: item.executionEnvironment === 'worktree' ? 'worktree' : 'local', archiveRuns: item.autoArchive === true } : {}),
    notifications: item.notificationPolicy === 'failed_runs_only' ? 'failures' : 'all',
  };
}
/** An automation item's fields an edit may change -> the AutomationSpec field each is part of (one it does not name keeps its own name). */
const SPEC_FIELD = Object.freeze({ name: 'name', prompt: 'prompt', rrule: 'schedule', model: 'settings', reasoningEffort: 'settings', notificationPolicy: 'notifications',
  executionEnvironment: 'where', localEnvironmentConfigPath: 'where', autoArchive: 'archiveRuns', projectId: 'project', targetThreadId: 'watches', kind: 'watches' });
/** An item's fields no update of the user's changes (the app's own bookkeeping): never compared. */
const BOOKKEEPING = new Set(['id', 'status', 'createdAt', 'updatedAt', 'nextRunAt', 'lastRunAt', 'nextRunNominalAt', 'cwds', 'target', 'pluginTemplateId']);
/** An automation as the app lists it, with its project as the update names it. */
const comparable = (x) => (x ? { ...x, projectId: x.target && x.target.type === 'project' ? x.target.projectId ?? null : x.projectId ?? null } : null);
/** What a write could change of an automation (its fields and status, not the app's run bookkeeping), to tell whether it changed meanwhile. */
const writable = (x) => JSON.stringify(x ? Object.keys(x).sort().filter((k) => k === 'status' || !BOOKKEEPING.has(k)).map((k) => [k, x[k] ?? null]) : null);

/**
 * @param {{ holds: ReturnType<typeof import('./user-holds.cjs').createUserHolds>, log?: object, toWindows?: (message: object) => void }} o
 *   `toWindows(message)`: the app's own message to every window's page
 * @returns {{ hold(services: object): void }}  `hold(services)`: a window's AppHost services; each shared class is held once
 */
function createUserActions({ holds, log = null, toWindows = () => {}, provided = null }) {
  const say = (level, msg, data) => { try { log?.[level]?.(msg, data); } catch { /* logging only */ } };
  /**
   * The user's act on a mod's Automation (H7pa; provided-automations.cjs): its provider's operation, asked of the Host as the user's, never
   * the app's own call; answered as the app's service answers (`update`: the item; `delete`: done; `runNow`: success). Not
   * the user's (the agent's tool, framework-main's own): refused, as none of them knows it.
   */
  async function actProvided(operation, req) {
    if (notTheUser()) throw new Error('that is a mod\'s automation: only the user acts on it here');
    const a = await holds.act({ operation, id: req.id, ...(operation === 'update' ? { item: req } : {}) });
    // a mod stopped it (graph-integrity G6.2): the automation stays as it is, and nothing failed
    if (a && a.stopped) return operation === 'runNow' ? { success: false } : { item: provided.item(req.id), ...(operation === 'delete' ? { success: false } : {}) };
    if (!a || a.handled !== true) {
      // one that may have been done (built review H7pa round 2) says so, and the pages read what is now
      if (a && a.uncertain) { try { toWindows({ type: 'automation-runs-updated' }); } catch { /* the pages read them later */ } }
      throw new Error(`${a && a.message ? a.message : 'it was not done'}${a && a.uncertain ? '; it may have been done all the same' : ''}`);
    }
    try { toWindows({ type: 'automation-runs-updated' }); } catch { /* the pages read them later */ }
    // the item as its provider made it (built review H7pa round 1: never what was asked, as if saved)
    if (operation === 'update') return { item: a.value && typeof a.value === 'object' ? a.value : provided.item(req.id) };
    if (operation === 'delete') return { item: provided.item(req.id), success: true, status: 'deleted' };
    return { success: true };
  }
  const isProvided = (id) => !!provided && provided.isProvided(id);
  /**
   * One call of the user's held as `ref.operation(args)`: the mods decide first (`changes: false`: what the user did cannot be shown
   * changed where they did it), then the app's own `run()` goes, or it throws with their reason. `key` is `Type.operation` as the Host
   * names what it holds.
   */
  /**
   * `how`: `verb` (a refusal's words), `refused(why)` (instead of throwing), `handled(value)` (a mod did it in the app's place: what the
   * app is answered, from what the mod made), `resultOf(result)` (what the app's own call made, as a ref for the mods: an automation's),
   * `check()` (asked once the mods let it go, just before the app's call: a reason not to go now, the decision being stale), `lock(fn)`
   * (the check and the app's call run inside it: `exclusive` for an automation's writes; the mods decide outside it, so one replacing the
   * call can write the same automation).
   */
  function held(key, ref, operation, args, run, how = {}) {
    // `how.outcomeOf(result)`: what the app's own call did, read from what it answered (a git failure, a skill not installed, a save in
    // conflict are answers, not throws: built review H6m2a)
    const outcome = (r) => (how.resultOf || how.outcomeOf
      ? Promise.resolve(r).then((res) => {
        const o = how.outcomeOf ? how.outcomeOf(res) : null;
        if (o && o.status !== 'done') return o;
        const value = how.resultOf ? how.resultOf(res) : null;
        return { status: 'done', ...(value ? { value } : {}) };
      }, (e) => ({ status: 'failed', error: { message: String((e && e.message) || e) } }))
      : outcomeOf(r));
    const locked = how.lock ?? ((fn) => fn());
    if (!holds.held(key)) {
      const r = locked(run);
      if (holds.observed(key)) void outcome(r).then((o) => holds.did({ ref, operation, args, outcome: o }));
      return r;
    }
    return holds.ask({ prefix: 'ua', ref, operation, args, changes: false, signal: how.signal ?? null }).then((a) => {
      // the app's own call given up meanwhile (a git handle disposed): nothing more of it is done, a mod's in its place included
      if (how.signal && how.signal.aborted) return how.refused ? how.refused('cancelled') : Promise.reject(new Error(`${how.verb ?? 'Not done'}: cancelled`));
      if (a.handled) return how.handled ? how.handled(a.value) : undefined;
      // a mod stopped it (graph-integrity G6.2): nothing is done and nothing failed; the place's own quiet end, else no answer at all
      if (a.stopped) return how.stopped ? how.stopped(a) : undefined;
      if (a.go === false) {
        if (how.refused) return how.refused(a.message);
        throw new Error(`${how.verb ?? 'Not done'}: ${a.message ?? 'not allowed'}`);
      }
      return locked(async () => {
        const stale = how.check ? await how.check() : null;
        if (stale) { holds.done(a.requestId, { status: 'failed', error: { message: stale } }); throw new Error(`${how.verb ?? 'Not done'}: ${stale}`); }
        const r = run();
        void outcome(r).then((o) => holds.done(a.requestId, o));
        return r;
      });
    });
  }
  function replace(proto, name, make) {
    const originals = proto[ORIGINALS] || (proto[ORIGINALS] = {});
    if (originals[name] || typeof proto[name] !== 'function') return;
    originals[name] = proto[name];
    proto[name] = make(originals[name]);
  }

  function holdPins(svc) {
    const proto = svc && Object.getPrototypeOf(svc);
    if (!proto || proto === Object.prototype || typeof proto.set !== 'function') return;
    replace(proto, 'set', (orig) => function set(req, ...rest) {
      // the user's own pin of a chat of this Mac (the app's archive and unarchive call it without useAppServerPins)
      if (!req || req.useAppServerPins !== true || typeof req.threadId !== 'string' || notTheUser()) return orig.call(this, req, ...rest);
      const op = req.pinned === true ? 'pin' : 'unpin';
      if (op === 'pin') {   // observed only (above)
        const r = orig.call(this, req, ...rest);
        if (holds.held('Thread.pin') || holds.observed('Thread.pin')) void outcomeOf(r).then((outcome) => holds.did({ ref: thread(req.threadId), operation: 'pin', args: [], outcome }));
        return r;
      }
      // refused: not done, and the pages read the pins again (the row goes back where it was)
      const refused = (why) => { say('info', `user actions: an ${op} was kept`, { why: String(why ?? '') }); try { toWindows({ type: 'pinned-threads-updated' }); } catch { /* the pages read them later */ } return undefined; };
      return held(`Thread.${op}`, thread(req.threadId), op, [], () => orig.call(this, req, ...rest), { refused, handled: undefined });
    });
  }

  function holdAutomations(svc) {
    const proto = svc && Object.getPrototypeOf(svc);
    if (!proto || proto === Object.prototype || typeof proto.create !== 'function') return;
    // the agent's own tool goes through the same methods: marked while it runs, so none of its calls is held as the user's
    replace(proto, 'executeUpdateTool', (orig) => function executeUpdateTool(...args) { return agentCall.run(true, () => orig.apply(this, args)); });
    const mine = notTheUser;
    // a mod's Automations in what the app's pages read (H7pa), never in framework-main's own reads or the agent's
    if (provided) replace(proto, 'list', (orig) => async function list(...args) { const r = await orig.apply(this, args); return mine() ? r : provided.addToList(r); });
    replace(proto, 'create', (orig) => function create(item, ...rest) {
      if (mine() || !item || typeof item !== 'object') return orig.call(this, item, ...rest);
      const spec = specOf(item);
      const [ref, key, op] = item.kind === 'heartbeat' && typeof item.targetThreadId === 'string' ? [thread(item.targetThreadId), 'Thread.automate', 'automate']
        : typeof item.projectId === 'string' && item.projectId ? [{ type: 'LocalProject', provider: CODEX, id: item.projectId }, 'Project.newAutomation', 'newAutomation']
          : [{ type: 'CodexAgent', provider: CODEX, id: CODEX }, 'Agent.newAutomation', 'newAutomation'];
      const self = this;
      return held(key, ref, op, [spec], () => orig.call(self, item, ...rest), {
        verb: 'Not created',
        resultOf: (res) => (res && res.item && typeof res.item.id === 'string' ? automation(res.item.id) : null),
        // a mod made it in the app's place: the app's answer is that automation, when it is one of the app's
        handled: (value) => Promise.resolve(own(self, 'list')).then((list) => {
          // only the app's own kind (its provider's): another provider's of the same id is not what was made
          const made = value && value.type === 'Automation' && value.provider === CODEX && typeof value.id === 'string' ? (list && Array.isArray(list.items) ? list.items : []).find((x) => x && x.id === value.id) : null;
          if (made) return { item: made };
          throw new Error('Not created here: a mod made it its own way');
        }),
      });
    });
    // The user's updates of an automation are decided one at a time (the app writes the whole item: one decided against a state another
    // changed meanwhile would write that state back), each on what it changes against the automation as the app lists it; every writer's
    // update (the agent's tool and framework-main's too) runs inside the automation's write lock, the user's checked again in it first.
    const updates = new Map();   // automation id -> the end of the user's queue
    replace(proto, 'update', (orig) => function update(item, ...rest) {
      if (!item || typeof item.id !== 'string') return orig.call(this, item, ...rest);
      if (isProvided(item.id)) return actProvided('update', item);
      const self = this;
      const go = () => orig.call(self, item, ...rest);
      const lock = (fn) => exclusive(item.id, fn);
      if (mine()) return lock(go);
      const current = () => Promise.resolve(own(self, 'list')).then((list) => comparable((list && Array.isArray(list.items) ? list.items : []).find((x) => x && x.id === item.id)));
      const next = (updates.get(item.id) ?? Promise.resolve()).catch(() => {}).then(() => current().then((before) => {
        // what changed: every field the update writes but the app's bookkeeping; its status alone is enable or disable, anything else an edit
        const changed = Object.keys(item).filter((k) => !BOOKKEEPING.has(k) && item[k] !== undefined && JSON.stringify(item[k] ?? null) !== JSON.stringify((before ?? {})[k] ?? null));
        const statusChanged = item.status !== undefined && (!before || item.status !== before.status);
        const baseline = writable(before);
        const check = () => current().then((now) => (writable(now) === baseline ? null : 'it changed while you were asked; nothing was written'));
        if (!changed.length && statusChanged && (item.status === 'ACTIVE' || item.status === 'PAUSED')) {
          const op = item.status === 'ACTIVE' ? 'enable' : 'disable';
          return held(`Automation.${op}`, automation(item.id), op, [], go, { verb: op === 'enable' ? 'Not turned on' : 'Not turned off', check, lock });
        }
        if (!changed.length && !statusChanged) return lock(go);
        // an edit: the spec's fields that changed, a field cleared as null (a status changed with them is its `enabled`)
        const merged = { ...(before ?? {}), ...item };
        const spec = specOf(merged);
        const changes = {};
        for (const k of changed) {
          const field = SPEC_FIELD[k] ?? k;
          if (field === 'settings') changes.settings = { model: merged.model ?? null, effort: merged.reasoningEffort ?? null };
          else if (field === 'watches') changes.watches = merged.kind === 'heartbeat' && typeof merged.targetThreadId === 'string' ? thread(merged.targetThreadId) : null;
          else changes[field] = spec[field] !== undefined ? spec[field] : SPEC_FIELD[k] ? null : item[k] ?? null;
        }
        if (statusChanged) changes.enabled = item.status !== 'PAUSED';
        return held('Automation.edit', automation(item.id), 'edit', [changes], go, { verb: 'Not changed', check, lock });
      }));
      updates.set(item.id, next);
      void next.then(() => {}, () => {}).then(() => { if (updates.get(item.id) === next) updates.delete(item.id); });
      return next;
    });
    replace(proto, 'delete', (orig) => function del(req, ...rest) {
      if (!req || typeof req.id !== 'string') return orig.call(this, req, ...rest);
      if (isProvided(req.id)) return actProvided('delete', req);
      const lock = (fn) => exclusive(req.id, fn);
      if (mine()) return lock(() => orig.call(this, req, ...rest));
      return held('Automation.delete', automation(req.id), 'delete', [], () => orig.call(this, req, ...rest), { verb: 'Not deleted', lock });
    });
    replace(proto, 'runNow', (orig) => function runNow(req, ...rest) {
      if (req && isProvided(req.id)) return actProvided('runNow', req);
      if (mine() || !req || typeof req.id !== 'string') return orig.call(this, req, ...rest);
      return held('Automation.runNow', automation(req.id), 'runNow', [], () => orig.call(this, req, ...rest), { verb: 'Not started' });
    });
  }

  // ---------------------------------------------------------------- H6m2: the user's projects, git, skills and instructions
  /**
   * A project renamed or removed from the app's sidebar (its menu, undo and redo): `projects.renameLocal` and `removeLocal`. The app's own
   * naming of a project it has just made (its new-project flow names it as soon as `createOrSelectLocalProjects` answers, in the same turn)
   * is not the user's rename: a project that call made is marked until the turn ends, and its first rename then is the app's (built review
   * H6m2a round 2: never by its age, which a rename of the user's can share and a slow creation outlast).
   */
  function holdProjects(svc) {
    const proto = svc && Object.getPrototypeOf(svc);
    if (!proto || proto === Object.prototype || typeof proto.renameLocal !== 'function') return;
    const naming = new Set();   // projects the app has just made, until the turn they were made in ends
    if (typeof proto.createOrSelectLocalProjects === 'function') {
      replace(proto, 'createOrSelectLocalProjects', (orig) => function createOrSelectLocalProjects(...args) {
        let before = null;
        try { before = new Set(Object.keys(this.getLocalProjects() || {})); } catch { /* not marked */ }
        const r = orig.apply(this, args);
        if (!before || !r || typeof r.then !== 'function') return r;
        return r.then((made) => {
          const ids = (Array.isArray(made) ? made : []).map((x) => x && x.id).filter((id) => typeof id === 'string' && !before.has(id));
          for (const id of ids) naming.add(id);
          if (ids.length) setImmediate(() => { for (const id of ids) naming.delete(id); });
          return made;
        });
      });
    }
    replace(proto, 'renameLocal', (orig) => function renameLocal(req, ...rest) {
      if (!req || typeof req.projectId !== 'string' || typeof req.name !== 'string' || notTheUser() || naming.delete(req.projectId)) return orig.call(this, req, ...rest);
      return held('Project.rename', project(req.projectId), 'rename', [req.name], () => orig.call(this, req, ...rest), { verb: 'Not renamed' });
    });
    replace(proto, 'removeLocal', (orig) => function removeLocal(id, ...rest) {
      if (typeof id !== 'string' || notTheUser()) return orig.call(this, id, ...rest);
      return held('Project.remove', project(id), 'remove', [], () => orig.call(this, id, ...rest), { verb: 'Not removed' });
    });
  }
  /**
   * A push, a new branch and a switch of branch (the git menus, the branch switcher, the commit and pull request flows): the handlers the
   * app's `gitRepository` service (one for every window) runs, each on the project whose folder the call names. Refused: answered as the
   * git worker answers a failure (the page says it, with the reason). A folder of no project of the app's is not held (no instance).
   */
  function holdGitRepository(svc, projectsSvc) {
    const handlers = svc && svc.handlers;
    if (!handlers || typeof handlers !== 'object' || typeof handlers.push !== 'function' || handlers[ORIGINALS]) return;
    handlers[ORIGINALS] = {};
    const wrap = (name, operation, argsOf, verb) => {   // argsOf(projectId, req): its arguments (or a promise of them), null: not held
      const orig = handlers[name];
      if (typeof orig !== 'function') return;
      handlers[ORIGINALS][name] = orig;
      handlers[name] = function heldGit(req, ...rest) {
        if (notTheUser() || !req || !local(req) || !holds.held(`Repository.${operation}`) && !holds.observed(`Repository.${operation}`)) return orig.call(this, req, ...rest);
        const self = this;
        // the handle's signal (its dispose aborts it): a hold it gives up ends too
        const signal = rest.find((x) => x && typeof x === 'object' && typeof x.aborted === 'boolean') ?? null;
        return projectOf(projectsSvc, req.cwd).then(async (projectId) => {
          const args = projectId ? await argsOf(projectId, req) : null;
          if (!args) return orig.call(self, req, ...rest);
          const refused = (why) => ({ status: 'error', error: `${verb}: ${why ?? 'not allowed'}`, execOutput: `${verb}: ${why ?? 'not allowed'}` });
          // done by a mod in the app's place: answered as the worker answers one done; what the worker answered is what it did
          return held(`Repository.${operation}`, repository(projectId), operation, args, () => orig.call(self, req, ...rest), { refused, handled: () => ({ status: 'success' }), signal,
            outcomeOf: (r) => (r && r.status === 'success' ? { status: 'done' } : { status: 'failed', error: { message: String((r && (r.error || r.execOutput)) || 'the git worker said no') } }),
            resultOf: () => (operation === 'createBranch' ? branch(projectId, req.branch) : null) });
        });
      };
    };
    // a push names the branch it pushes (built review H6m2a round 2): the checkout's (a worktree's is its own, not its project's current
    // one), as the page names it for a first push (`HEAD:refs/heads/<name>`), else as git says
    wrap('push', 'push', async (id, req) => {
      const named = typeof req.refspec === 'string' && /^HEAD:refs\/heads\/(.+)$/.exec(req.refspec);
      const name = named ? named[1] : await headBranch(req.cwd);
      return name ? [branch(id, name)] : [];
    }, 'Not pushed');
    wrap('createBranch', 'createBranch', (_id, req) => (typeof req.branch === 'string' && req.branch ? [req.branch] : null), 'No branch created');
    wrap('checkoutBranch', 'switchBranch', (id, req) => (typeof req.branch === 'string' && req.branch ? [branch(id, req.branch)] : null), 'Not switched');
  }
  /**
   * A library skill installed and a skill removed (the Skills page): `recommendedSkills.install` and `remove`. Refused: answered as the
   * service answers a failure (`{success: false, error}`: it never throws).
   */
  function holdSkills(svc) {
    const proto = svc && Object.getPrototypeOf(svc);
    if (!proto || proto === Object.prototype || typeof proto.install !== 'function' || typeof proto.remove !== 'function') return;
    replace(proto, 'install', (orig) => function install(req, ...rest) {
      if (!req || typeof req.skillId !== 'string' || !local(req) || notTheUser()) return orig.call(this, req, ...rest);
      const refused = (why) => ({ success: false, destination: null, error: `Not installed: ${why ?? 'not allowed'}` });
      return held('Skill.install', skill(`library:${req.skillId}`), 'install', [], () => orig.call(this, req, ...rest), { refused, handled: () => ({ success: true, destination: null, error: null }),
        outcomeOf: (r) => (r && r.success === true ? { status: 'done' } : { status: 'failed', error: { message: String((r && r.error) || 'not installed') } }) });
    });
    replace(proto, 'remove', (orig) => function remove(req, ...rest) {
      if (!req || typeof req.skillPath !== 'string' || !local(req) || notTheUser()) return orig.call(this, req, ...rest);
      const refused = (why) => ({ success: false, deletedPath: null, error: `Not removed: ${why ?? 'not allowed'}` });
      return held('Skill.delete', skill(req.skillPath), 'delete', [], () => orig.call(this, req, ...rest), { refused, handled: () => ({ success: true, deletedPath: req.skillPath, error: null }),
        outcomeOf: (r) => (r && r.success === true ? { status: 'done' } : { status: 'failed', error: { message: String((r && r.error) || 'not removed') } }) });
    });
  }
  /**
   * Instructions saved: the global AGENTS.md from Settings › Personalization (`agentInstructions.write`), and an AGENTS.md or
   * AGENTS.override.md saved in the app's file editor (`workspaceFiles.saveText`, which also autosaves). Refused: it throws (the page says
   * it could not save, and keeps the text).
   */
  function holdInstructions(ai, files) {
    const aiProto = ai && Object.getPrototypeOf(ai);
    if (aiProto && aiProto !== Object.prototype && typeof aiProto.write === 'function') {
      replace(aiProto, 'write', (orig) => function write(req, ...rest) {
        if (!req || typeof req.contents !== 'string' || (req.hostId !== undefined && req.hostId !== 'local') || notTheUser()) return orig.call(this, req, ...rest);
        const at = path.join(codexHome(), 'AGENTS.md');
        // a mod that saved it in the app's place: answered as the app's own save answers (the page reads its path)
        return held('Instructions.edit', instructions(at), 'edit', [textContent(req.contents)], () => orig.call(this, req, ...rest), { verb: 'Not saved', handled: () => ({ path: at }) });
      });
    }
    const filesProto = files && Object.getPrototypeOf(files);
    if (filesProto && filesProto !== Object.prototype && typeof filesProto.saveText === 'function') {
      replace(filesProto, 'saveText', (orig) => function saveText(req, ...rest) {
        const p = req && typeof req.path === 'string' && path.isAbsolute(req.path) ? path.resolve(req.path) : null;
        if (!p || !INSTRUCTION_FILES.has(path.basename(p)) || typeof req.content !== 'string' || (req.hostId !== undefined && req.hostId !== 'local') || notTheUser()) return orig.call(this, req, ...rest);
        // a mod that saved it in the app's place: answered as a save of the app's (with the file's time now, which the editor's next save
        // is checked against); a save the file changed under is a conflict, not done
        return held('Instructions.edit', instructions(p), 'edit', [textContent(req.content)], () => orig.call(this, req, ...rest), { verb: 'Not saved',
          // saved only with the file's time (the editor's baseline; round 2): one that cannot be read now is not answered as saved
          handled: async () => {
            const st = await fsp.stat(p).catch(() => null);
            if (!st || !Number.isFinite(st.mtimeMs)) throw new Error('Not saved: the file a mod saved could not be read');
            return { outcome: 'saved', mtimeMs: st.mtimeMs };
          },
          outcomeOf: (r) => (r && r.outcome === 'saved' ? { status: 'done' } : { status: 'failed', error: { message: `not saved (${(r && r.outcome) || 'no answer'})` } }) });
      });
    }
  }

  /**
   * A command run from the floating palette (its window's AppHost `spotlight.runCommand(id)`, which shows the app's window and sends it the
   * command): the user's Command.run (built review H6m3a: the page that receives it cannot tell it from main's own `run-command`). Refused:
   * the palette is answered false (not run); the Host says why in the window in front.
   */
  function holdSpotlight(svc) {
    const proto = svc && Object.getPrototypeOf(svc);
    if (!proto || proto === Object.prototype || typeof proto.runCommand !== 'function') return;
    replace(proto, 'runCommand', (orig) => function runCommand(id, ...rest) {
      if (typeof id !== 'string' || !id || notTheUser()) return orig.call(this, id, ...rest);
      return held('Command.run', command(id), 'run', [], () => orig.call(this, id, ...rest), { refused: () => false, handled: () => true });
    });
  }

  /**
   * A pull request merged from its panel (the merge menu, `git.mergePullRequest`): the window's `github` service's request `gh-pr-merge`
   * (its handler, per window) as the PullRequest's `merge`, the pull request named by its identity (`{hostname, owner, repository,
   * number}`; the Host takes the listed one: built review H6m2b). Refused: answered as the service answers a failure (the page says its
   * reason). Another host's account's is not held.
   */
  function holdGithub(svc) {
    if (!svc || typeof svc.handleRequest !== 'function' || svc.handleRequest[ORIGINALS]) return;
    const orig = svc.handleRequest;
    const wrapped = function handleRequest(method, params, ...rest) {
      const url = method === 'gh-pr-merge' && params && local(params.account) ? pullRequestUrl(params.pullRequest) : null;
      if (!url || notTheUser()) return orig.call(this, method, params, ...rest);
      return held('PullRequest.merge', pullRequest(url), 'merge', [], () => orig.call(this, method, params, ...rest),
        { refused: (why) => ({ status: 'error', error: `Not merged: ${why ?? 'not allowed'}` }), handled: () => ({ status: 'success' }) });
    };
    wrapped[ORIGINALS] = orig;
    svc.handleRequest = wrapped;
  }
  /**
   * A commit (the commit dialog and button, the commit-and-push and pull request flows): the git worker's `commit` request from a page,
   * held before the worker has it (its `git add -A` of the unstaged files is inside it) as the Repository's `commit(message)` on the project
   * whose folder it names (a worktree's: its repository's project; another host's is not held). Refused: the page is answered as the
   * worker answers a failure (`{status: 'error', error}`: the page shows the reason). Let go: the request goes on, and what the worker
   * answered is what the mods' records say it did (a Commit). The page cancelling it or going (closed, loaded again) gives the hold up (a
   * mod's replacement not done) and, once let go, stops listening for its answer.
   * @param {(windowId: number) => object | null} servicesOf  a window's AppHost services
   */
  const gitHolds = new Map();   // a commit's request id -> its hold here: {cancel(), forwarded}
  // commits answered here (refused, done by a mod, given up before the worker had them): the worker never saw them, so their cancels are
  // not its (21477's worker keeps a cancel of an id it does not know until that request comes, which it never would: built review H6m2b)
  const answeredHere = new Set();
  const keepHere = (id) => { answeredHere.add(id); if (answeredHere.size > 200) answeredHere.delete(answeredHere.values().next().value); };
  function gitRequest(windowId, msg, page, servicesOf) {
    const req = msg && msg.workerId === 'git' && msg.request && typeof msg.request === 'object' ? msg.request : null;
    if (!req || req.method !== 'commit' || !req.params || notTheUser() || !localHost(req.params.hostConfig)) return msg;
    if (!holds.held('Repository.commit') && !holds.observed('Repository.commit')) return msg;
    if (req.id === undefined || gitHolds.has(req.id)) return msg;
    // its hold here: given up on a cancel or the page going; once let go, what it listens for ends with its answer, a cancel, the page
    // going or GIT_REPLY_MS
    const abort = new AbortController();
    const offs = [];
    let released = null;   // the Host's request id once it was let go (its record waits for what it did)
    const end = (outcome) => {
      if (gitHolds.get(req.id) !== entry) return;
      gitHolds.delete(req.id);
      for (const off of offs.splice(0)) { try { off(); } catch { /* gone already */ } }
      if (released && outcome) holds.done(released, outcome);
    };
    const entry = { forwarded: false, cancel: () => { abort.abort(); end({ status: 'uncertain' }); } };
    const forward = () => { entry.forwarded = true; return msg; };
    gitHolds.set(req.id, entry);
    if (page && typeof page.gone === 'function') offs.push(page.gone(() => entry.cancel()));
    const t = setTimeout(() => end({ status: 'uncertain' }), GIT_REPLY_MS);
    if (t.unref) t.unref();
    offs.push(() => clearTimeout(t));
    const hear = (fn) => {
      if (!page || typeof page.replies !== 'function') { end(); return; }
      offs.push(page.replies(GIT_FOR_VIEW, (m) => {
        if (!m || m.type !== 'worker-response' || !m.response || m.response.id !== req.id) return false;
        fn(m.response.result);
        return true;
      }));
    };
    return projectOf(servicesOf(windowId)?.projects, req.params.cwd).then((projectId) => {
      if (abort.signal.aborted) { end(); keepHere(req.id); return null; }
      if (!projectId) { end(); return msg; }
      const ref = repository(projectId), args = typeof req.params.message === 'string' && req.params.message ? [req.params.message] : [];
      const outcome = (result) => workerOutcome(result, (v) => (typeof v.commitSha === 'string' && v.commitSha ? commit(projectId, v.commitSha) : null));
      if (!holds.held('Repository.commit')) {
        hear((result) => { holds.did({ ref, operation: 'commit', args, outcome: outcome(result) }); end(); });
        return forward();
      }
      return holds.ask({ prefix: 'ua', ref, operation: 'commit', args, changes: false, signal: abort.signal }).then((a) => {
        // the page gave it up meanwhile: nothing more is done of it (one the Host let go is told so; a mod's in its place is the mod's)
        if (abort.signal.aborted) {
          if (a.go === true) holds.done(a.requestId, { status: 'failed', error: { message: 'cancelled' } });
          end();
          keepHere(req.id);
          return null;
        }
        if (a.handled) {
          end();
          keepHere(req.id);
          const sha = a.value && a.value.type === 'Commit' && typeof a.value.id === 'string' && a.value.id.startsWith(`${projectId}:`) ? a.value.id.slice(projectId.length + 1) : null;
          return { reply: [GIT_FOR_VIEW, workerAnswer(req.id, 'commit', { type: 'ok', value: { status: 'success', ...(sha ? { commitSha: sha } : {}) } })] };
        }
        if (a.go === false) {
          end();
          keepHere(req.id);
          const why = `Not committed: ${a.message ?? 'not allowed'}`;
          return { reply: [GIT_FOR_VIEW, workerAnswer(req.id, 'commit', { type: 'ok', value: { status: 'error', error: why, execOutput: why } })] };
        }
        released = a.requestId;
        hear((result) => end(outcome(result)));
        return forward();
      });
    }, () => { end(); return msg; });
  }
  /**
   * The page cancelled a git request: one still held never goes on, and its cancel is not the worker's (it never had the request); one let
   * go is no longer listened for, and its cancel goes on to the worker.
   */
  function gitCancel(msg) {
    const id = msg && msg.workerId === 'git' ? (msg.id ?? msg.requestId ?? msg.request?.id) : undefined;
    if (id === undefined) return msg;
    const e = gitHolds.get(id);
    if (e) { const forwarded = e.forwarded; e.cancel(); return forwarded ? msg : null; }
    return answeredHere.delete(id) ? null : msg;
  }

  return {
    gitRequest, gitCancel,
    hold(services) {
      const each = (what, fn) => { try { fn(); } catch (e) { say('warn', `user actions: ${what} could not be held`, { message: String(e && e.message || e) }); } };
      each('the pins', () => holdPins(services && services.pinnedThreads));
      each('the automations', () => holdAutomations(services && services.localAutomations));
      each('the projects', () => holdProjects(services && services.projects));
      each('the git operations', () => holdGitRepository(services && services.gitRepository, services && services.projects));
      each('the skills', () => holdSkills(services && services.recommendedSkills));
      each('the instructions', () => holdInstructions(services && services.agentInstructions, services && services.workspaceFiles));
      each('the pull requests', () => holdGithub(services && services.github));
      each('the floating palette', () => holdSpotlight(services && services.spotlight));
    },
  };
}

/** framework-main module entry (contracts/main-hooks.d.ts): must not throw. */
function register(hooks) {
  try {
    if (!hooks.appHost) return;
    const toWindows = (message) => { for (const w of hooks.appHost.windows()) { try { kit.postToView(hooks, w.id, message); } catch { /* that window's page is gone */ } } };
    const ua = createUserActions({ holds: userHoldsOf(hooks), log: hooks.log, toWindows, provided: providedOf(hooks) });
    const each = (w) => { try { ua.hold(w && w.host && w.host.services); } catch { /* that window has none */ } };
    for (const w of hooks.appHost.windows()) each(w);
    hooks.appHost.subscribe((e) => { if (e.type === 'added') each(e); });
    // the git worker's requests from the pages (a commit), held before the worker has them
    if (hooks.electron && typeof hooks.electron.holdAppMessage === 'function') {
      const servicesOf = (id) => { for (const w of hooks.appHost.windows()) if (w && w.id === id) return w.host && w.host.services; return null; };
      hooks.electron.holdAppMessage('worker-request', (windowId, msg, page) => ua.gitRequest(windowId, msg, page, servicesOf), GIT_FROM_VIEW);
      hooks.electron.holdAppMessage('worker-request-cancel', (_windowId, msg) => ua.gitCancel(msg), GIT_FROM_VIEW);
    }
  } catch (e) {
    try { hooks.log.error('user actions register failed', { message: String((e && e.message) || e) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, createUserActions, own, exclusive, specOf };
