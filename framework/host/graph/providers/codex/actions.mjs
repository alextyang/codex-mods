// ProjectAction in the native provider (breadth step D3; docs/graph/02-types.md Command, ProjectAction): a project's own actions, the
// `[[actions]]` of the environment config the app selected for the project's folder (framework/main/projects.cjs `actions`: the app's
// `localEnvironments`; with no selection, its default config; "no environment" selected, none).
// - One instance per action, named by its project, its config and its place there; `title` its name, `category` the config's name,
//   `command` what it runs, `icon` the app's symbol for it (tool, run, debug, test), `enabled` while it is for this platform.
// - Read at the source's start, when the app's projects change, every READ_MS, when a realm observes one read longer ago than FRESH_MS,
//   and when its config file changes (`fs/watch` on the file; `fs/changed` names the watch). What is no longer listed goes.
// run(args?) runs it the app's way, in a terminal of a thread (the one the window shows, or `args.thread`): a terminal session with its
// tab in that thread's panel, in the named thread's own folder (the project's, or a worktree of it) or else the project's, then the
// action's command, which framework-main reads from the config again (a mod cannot change what runs). Without a thread shown it is
// refused and nothing runs. `ran` follows a run.
import { refs } from './map.mjs';

export const READ_MS = 2 * 60_000;
const FRESH_MS = 15_000;
const RELOAD_MS = 150;

/**
 * A project's actions (framework-main's `actions` answer: `{selected, configs: [{configPath, name, actions: [{name, icon, command,
 * platform}]}]}`) -> the ProjectAction instances, with where each is in its config.
 * @param {string} projectId
 * @param {{ selected: string | null, configs: { configPath: string, name: string, actions: { name: string, icon: string | null, command: string, platform: string | null }[] }[] }} r
 * @param {string} [platform]
 */
export function actionsData(projectId, r, platform = process.platform) {
  const cfg = (r.configs ?? []).find((c) => c.configPath === r.selected);
  if (!cfg) return [];
  return cfg.actions.map((a, index) => ({
    ref: refs.projectAction(projectId, cfg.configPath, index),
    state: { title: a.name, category: cfg.name, enabled: !a.platform || a.platform === platform, command: a.command, ...(a.icon ? { icon: a.icon } : {}) },
    links: { project: refs.project(projectId) },
    configPath: cfg.configPath,
    index,
  }));
}

/** The operation handlers, for the provider's registration: ProjectAction's own run (the app's commands have Command.run, D6). */
export function actionTypes(feed) {
  return { ProjectAction: { operations: { run: { effect: 'external', handler: ({ ref, args }) => feed.run(ref, args[0]) } } } };
}

/**
 * @param {{ handle: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>, resident(ref: object): object | null,
 *   safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void, rpc(method: string, params: object): Promise<unknown>,
 *   cwdOf?(threadId: string): string | null, log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createActionFeed(o) {
  const { handle, appProjects, safe } = o;
  const now = o.now ?? Date.now;
  const byProject = new Map();   // project id -> {readAt, where: Map<ref id, {ref, configPath, index}>}
  const reading = new Map();     // project id -> promise
  const watches = new Map();     // config path -> watch id
  const byWatch = new Map();     // watch id -> project id
  const reloads = new Map();     // project id -> timer
  let seq = 0;
  let disposed = false;

  function apply(projectId, r) {
    const next = actionsData(projectId, r);
    const had = byProject.get(projectId);
    const where = new Map(next.map((d) => [d.ref.id, { ref: d.ref, configPath: d.configPath, index: d.index }]));
    for (const d of next) safe('project action', () => handle.put(d.ref, { state: d.state, links: d.links }));
    for (const [id, x] of had?.where ?? []) if (!where.has(id) && o.resident(x.ref)) safe('project action removal', () => handle.remove(x.ref));
    // Every config of the folder is watched: an edit, or a newly selected one, reads the actions again.
    const configs = new Set((r.configs ?? []).map((c) => c.configPath));
    for (const [p] of [...watches]) if (byWatch.get(watches.get(p)) === projectId && !configs.has(p)) unwatch(p);
    for (const p of configs) watch(p, projectId);
    byProject.set(projectId, { readAt: now(), where });
  }
  function forget(projectId) {
    const had = byProject.get(projectId);
    if (!had) return;
    byProject.delete(projectId);
    for (const x of had.where.values()) if (o.resident(x.ref)) safe('project action removal', () => handle.remove(x.ref));
    for (const [p, w] of [...watches]) if (byWatch.get(w) === projectId) unwatch(p);
  }
  /** Read one project's actions (one read at a time per project). */
  function read(projectId) {
    if (disposed || !appProjects.available || !appProjects.get(projectId)) return Promise.resolve();
    if (reading.has(projectId)) return reading.get(projectId);
    const run = (async () => {
      const r = await appProjects.op('actions', projectId);
      if (!r.ok) { if (r.refused) forget(projectId); else o.log.warn('actions: a project\'s actions could not be read', { message: r.error }); return; }
      apply(projectId, r.result ?? { selected: null, configs: [] });
    })().finally(() => reading.delete(projectId));
    reading.set(projectId, run);
    return run;
  }
  const readAll = () => Promise.all(appProjects.list().map((p) => read(p.id)));

  function watch(p, projectId) {
    if (disposed || watches.has(p)) return;
    const watchId = `codexmods-graph-actions-${++seq}`;
    watches.set(p, watchId);
    byWatch.set(watchId, projectId);
    o.rpc('fs/watch', { watchId, path: p }).catch((e) => {
      if (watches.get(p) === watchId) { watches.delete(p); byWatch.delete(watchId); }
      o.log.warn('actions: a config could not be watched', { message: String(e?.message ?? e) });
    });
  }
  function unwatch(p) {
    const watchId = watches.get(p);
    if (!watchId) return;
    watches.delete(p);
    byWatch.delete(watchId);
    o.rpc('fs/unwatch', { watchId }).catch(() => {});
  }

  const sub = appProjects.onChange((c) => {
    if (disposed) return;
    if (c.available === true) { readAll(); return; }
    if (c.projects) {
      for (const id of [...c.projects.added, ...c.projects.changed]) read(id);
      for (const id of c.projects.removed) forget(id);
    }
  });
  const timer = setInterval(() => { readAll(); }, READ_MS);
  timer.unref?.();
  const refused = (reason, message) => ({ status: 'refused', reason, message });

  return {
    readAll,
    /** The source's onObserve for a ProjectAction ref: its project's actions are read again when the last read is old. */
    observe(ref) {
      for (const [projectId, x] of byProject) if (x.where.has(ref.id)) return now() - x.readAt > FRESH_MS ? read(projectId) : undefined;
      return undefined;
    },
    /** A `fs/changed` the source observed: a watched config's project is read again. */
    changed(params) {
      const projectId = byWatch.get(params?.watchId);
      if (!projectId || reloads.has(projectId) || disposed) return;
      const t = setTimeout(() => { reloads.delete(projectId); read(projectId); }, RELOAD_MS);
      t.unref?.();
      reloads.set(projectId, t);
    },
    /** The backend went away: its watches are gone with it; the app-server's return reads every project again (and watches again). */
    serverDown() { watches.clear(); byWatch.clear(); },
    serverUp() { readAll(); },
    async run(ref, args) {
      let projectId = null, at = null;
      for (const [pid, x] of byProject) if (x.where.has(ref.id)) { projectId = pid; at = x.where.get(ref.id); }
      if (!at) return refused('unavailable', 'the action is no longer in its project');
      if (args !== undefined && args !== null && (typeof args !== 'object' || (args.thread !== undefined && (typeof args.thread?.id !== 'string' || args.thread.type !== 'CodexThread' || args.thread.provider !== handle.id)))) {
        return refused('invalid', 'run takes nothing, or { thread } with a Codex thread to show its terminal beside');
      }
      const cwd = args?.thread ? o.cwdOf?.(args.thread.id) ?? null : null;
      const r = await appProjects.op('run-action', projectId, { path: at.configPath, index: at.index, ...(args?.thread ? { threadId: args.thread.id } : {}), ...(cwd ? { cwd } : {}) });
      if (!r.ok) { if (r.refused) return refused('unavailable', r.error); throw new Error(r.error); }
      o.emitEvent(ref, 'ran');
      return null;
    },
    dispose() {
      disposed = true;
      sub.dispose();
      clearInterval(timer);
      for (const t of reloads.values()) clearTimeout(t);
      reloads.clear();
      for (const p of [...watches.keys()]) unwatch(p);
    },
  };
}
