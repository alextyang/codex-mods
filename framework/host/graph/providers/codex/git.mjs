// A project's repository in the native provider (breadth step D3; docs/graph/02-types.md Repository, GitRepository, Branch): read the app's
// way through framework-main (framework/main/projects.cjs `repository`: the app's `repositoryOrigins` and its git worker), and changed the
// app's way (`switch-branch`, `create-branch`, `push`: the app's `gitRepository`). Commits, changes and pull requests are step D7's.
// - One GitRepository per project whose folder is in a git repository, named by the project (its identity); its branches are the recent
//   ones the app lists (at most 100), the current one and the default one, each named by the project and its name. The current branch has
//   its upstream and how many commits it is ahead (the app gives no "behind").
// - `dirty`: anything staged, changed or untracked; `staged`: the staged files' paths.
// - Read at the source's start, when a project comes, when a realm observes a repository or a branch read longer ago than FRESH_MS, every
//   READ_MS, and after an operation (the app's git worker tells only its windows about changes). A new current branch says `branchChanged`,
//   a change of `dirty` or `staged` says `statusChanged`, a push done says `pushed`.
import { refs } from './map.mjs';

export const READ_MS = 2 * 60_000;
const FRESH_MS = 15_000;

/** A project's repository (framework-main's `repository` answer) -> the GitRepository instance and its branches. */
export function repositoryData(projectId, r) {
  const counts = r.status;
  const dirty = counts ? counts.staged + counts.unstaged + counts.untracked > 0 : r.staged.length > 0;
  const repo = {
    ref: refs.repository(projectId),
    state: { kind: 'git', dirty, remotes: r.origin ? [{ name: 'origin', url: r.origin }] : [], staged: r.staged },
    links: { project: refs.project(projectId), currentBranch: r.branch ? refs.branch(projectId, r.branch) : null },
  };
  const names = [...new Set([...(r.branch ? [r.branch] : []), ...r.branches, ...(r.defaultBranch ? [r.defaultBranch] : [])])];
  const branches = names.map((name) => {
    const current = name === r.branch;
    const state = { name, current };
    if (current && Number.isFinite(r.ahead)) state.ahead = r.ahead;
    if (current && r.upstream) state.upstream = r.upstream;
    return { ref: refs.branch(projectId, name), state, links: { repository: repo.ref } };
  });
  return { repo, branches };
}

/** The operation handlers, for the provider's registration. */
export function gitTypes(feed) {
  return {
    Repository: {
      supports: ['currentBranch', 'workingChanges'],
      operations: {
        // its changes as unified diff text, as the app's review shows them (content: a grant must name it)
        workingChanges: { effect: 'none', handler: ({ ref, args }) => feed.workingChanges(ref.id, args[0]) },
        switchBranch: { effect: 'external', handler: ({ ref, args }) => feed.run('switch-branch', ref.id, feed.branchName(args[0], ref.id)) },
        createBranch: { effect: 'external', handler: ({ ref, args }) => feed.create(ref.id, args[0]) },
        // only the current branch is pushed (the app's way): one named must be it, as framework-main reads the checkout just before
        push: { effect: 'external', handler: ({ ref, args }) => {
          const name = args[0] ? feed.branchName(args[0], ref.id) : null;
          return args[0] && !name ? { status: 'refused', reason: 'invalid', message: 'a branch of this repository is needed' } : feed.run('push', ref.id, name);
        } },
      },
    },
    Branch: {
      supports: ['ahead', 'upstream'],
      operations: { switch: { effect: 'external', handler: ({ instance }) => feed.run('switch-branch', instance.links.repository.id, instance.state.name) } },
    },
  };
}

/**
 * @param {{ handle: object, graph: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createGitFeed(o) {
  const { handle, graph, appProjects, safe } = o;
  const now = o.now ?? Date.now;
  const readAt = new Map();    // project id -> time of the last read
  const reading = new Map();   // project id -> promise
  const repos = new Set();     // project ids with a repository
  let disposed = false;

  function apply(projectId, r) {
    const ref = refs.repository(projectId);
    if (!r.git) { removeRepo(projectId); return; }
    const { repo, branches } = repositoryData(projectId, r);
    const cur = o.resident(ref);
    safe('repository', () => handle.put({ ...ref, type: 'GitRepository' }, { state: repo.state, links: repo.links }));
    repos.add(projectId);
    const listed = new Set(branches.map((b) => b.ref.id));
    for (const b of branches) safe('branch', () => handle.put(b.ref, { state: b.state, links: b.links }));
    for (const x of graph.referrers(ref, 'repository')) if (x.ref.provider === handle.id && x.ref.type === 'Branch' && !listed.has(x.ref.id)) safe('branch removal', () => handle.remove(x.ref));
    linkProject(projectId, ref);
    if (cur) {
      if ((cur.links?.currentBranch?.id ?? null) !== (repo.links.currentBranch?.id ?? null)) o.emitEvent(ref, 'branchChanged');
      if (cur.state.dirty !== repo.state.dirty || JSON.stringify(cur.state.staged) !== JSON.stringify(repo.state.staged)) o.emitEvent(ref, 'statusChanged');
    }
  }
  function linkProject(projectId, ref) {
    const p = o.resident(refs.project(projectId));
    if (p && p.links?.repository?.id !== ref?.id) safe('project repository', () => handle.update(refs.project(projectId), { links: { repository: ref } }));
  }
  function removeRepo(projectId) {
    const ref = refs.repository(projectId);
    for (const x of graph.referrers(ref, 'repository')) if (x.ref.provider === handle.id && x.ref.type === 'Branch') safe('branch removal', () => handle.remove(x.ref));
    if (o.resident(ref)) safe('repository removal', () => handle.remove(ref));
    repos.delete(projectId);
    linkProject(projectId, null);
  }
  /** Read one project's repository (one read at a time per project): true once it was read. */
  function read(projectId) {
    if (disposed || !appProjects.available || !appProjects.get(projectId)) return Promise.resolve(false);
    if (reading.has(projectId)) return reading.get(projectId);
    const run = (async () => {
      const r = await appProjects.op('repository', projectId);
      if (!r.ok) { o.log.warn('git: a repository could not be read', { message: r.error }); return false; }
      readAt.set(projectId, now());
      apply(projectId, r.result ?? { git: false });
      return true;
    })().finally(() => reading.delete(projectId));
    reading.set(projectId, run);
    return run;
  }
  const readAll = () => Promise.all(appProjects.list().map((p) => read(p.id)));
  const sub = appProjects.onChange((c) => {
    if (disposed) return;
    if (c.available === true) { readAll(); return; }
    if (c.projects) {
      for (const id of [...c.projects.added, ...c.projects.changed]) read(id);
      for (const id of c.projects.removed) removeRepo(id);
    }
  });
  const timer = setInterval(() => { readAll(); }, READ_MS);
  timer.unref?.();
  const refused = (reason, message) => ({ status: 'refused', reason, message });

  return {
    readAll,
    /** The source's onObserve for a Repository or Branch ref. */
    observe(ref) {
      const projectId = ref.type === 'Branch' ? ref.id.slice(0, ref.id.indexOf(':')) : ref.id;
      return now() - (readAt.get(projectId) ?? 0) > FRESH_MS ? read(projectId) : undefined;
    },
    /** A Branch ref's name in this repository, or null. */
    branchName(branch, projectId) {
      const prefix = `${projectId}:`;
      return branch && typeof branch.id === 'string' && branch.id.startsWith(prefix) ? branch.id.slice(prefix.length) : null;
    },
    async run(op, projectId, branch) {
      if (op !== 'push' && !branch) return refused('invalid', 'a branch of this repository is needed');
      const r = await appProjects.op(op, projectId, op === 'push' && !branch ? {} : { branch });
      await read(projectId);
      if (r.ok) { if (op === 'push') o.emitEvent(refs.repository(projectId), 'pushed'); return null; }
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    /** Repository.workingChanges(scope?): the app's git worker's patch of its unstaged (default), staged or branch changes. */
    async workingChanges(projectId, scope = 'unstaged') {
      if (!['unstaged', 'staged', 'branch'].includes(scope)) return refused('invalid', 'the changes are unstaged, staged or branch');
      const r = await appProjects.op('working-changes', projectId, { scope });
      if (r.ok) return typeof r.result?.diff === 'string' ? r.result.diff : '';
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    async create(projectId, name) {
      const out = await this.run('create-branch', projectId, name);
      if (out) return out;
      if (!o.resident(refs.branch(projectId, name))) safe('branch', () => handle.put(refs.branch(projectId, name), { state: { name, current: false }, links: { repository: refs.repository(projectId) } }));
      return refs.branch(projectId, name);
    },
    has: (projectId) => repos.has(projectId),
    /** Read one project's repository now (after a change made elsewhere, such as a commit). */
    read,
    /** Read it again after any read under way (one begun before the caller asked may not see what changed since): true once read. */
    fresh(projectId) {
      const under = reading.get(projectId);
      return (under ? under.then(() => {}, () => {}) : Promise.resolve()).then(() => read(projectId));
    },
    dispose() { disposed = true; sub.dispose(); clearInterval(timer); },
  };
}
