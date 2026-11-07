// WorktreeEnvironment in the native provider (breadth step D3; docs/graph/02-types.md WorktreeEnvironment): a thread that runs in a Codex
// worktree. A thread moved into a worktree carries it as a protocol attachment (`thread/attachment/list`: attachmentType `worktree`,
// identityKey the worktree's git root, payload `{root, workspaceRoot}`; `thread/attachment/updated` names a change). A thread started in a
// new worktree carries none (21477): its working directory is in the worktree. Either way framework-main checks that the folder is a
// worktree of the thread's project's repository, not its checkout, and reads its branch and base the app's way
// (framework/main/projects.cjs `worktree`).
// - Asked for a thread in a project whose working directory is outside the project's folder (a local thread runs in the project's folder:
//   projects.mjs), when it is put, linked again, or its attachments change.
// - One WorktreeEnvironment per worktree (its git root), ready while the folder is there; a worktree that is gone has no instance (its
//   branch is not known) and its threads link none. Its name is its branch's, or "Worktree" while it is detached (the app's Worktrees
//   settings name it so; a new worktree starts detached at its base's commit, and then has no branch); `path` its workspace root; `setup`
//   the setup script of the environment it was made with, if any.
// remove() deletes one of the app's own worktrees as its Worktrees settings do: refused while a chat in it is pinned (the app's rule), its
// chats archived, then the app's `managedWorktrees.delete` (framework-main's `remove-worktree`), which force-removes the folder; a mod's
// call asks the user first (R17: the folder and its uncommitted changes go).
import { refs } from './map.mjs';

/** A worktree (framework-main's `worktree` answer and the attachment's paths) -> the WorktreeEnvironment instance, or null when its base is
 *  not known. */
export function worktreeData(projectId, key, w, workspaceRoot) {
  const base = w.base ?? w.branch;
  if (!base) return null;
  return {
    ref: refs.worktreeEnvironment(key),
    state: { name: w.branch ?? 'Worktree', status: 'ready', path: workspaceRoot ?? w.root ?? key, ...(w.setup ? { setup: { parts: [{ kind: 'text', text: w.setup }] } } : {}) },
    links: { project: refs.project(projectId), branch: w.branch ? refs.branch(projectId, w.branch) : null, base: refs.branch(projectId, base) },
  };
}

/** The operation handlers, for the provider's registration. */
export function worktreeTypes(feed) {
  return {
    WorktreeEnvironment: {
      operations: {
        remove: { effect: 'external', approval: ({ ref, instance }) => feed.prompt(ref, instance), handler: ({ ref, instance }) => feed.remove(ref, instance) },
      },
    },
  };
}

/**
 * @param {{ handle: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>, rpc(method: string, params: object): Promise<any>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, cwdOf(threadId: string): string | null,
 *   threads?(): Iterable<string>, relink(threadId: string): void, archive(threadId: string): Promise<null | object>,
 *   log: { warn(m: string, d?: unknown): void } }} o
 */
export function createWorktreeFeed(o) {
  const { handle, appProjects, safe } = o;
  const envOf = new Map();     // thread id -> worktree environment ref (or null: asked, none)
  const asking = new Map();    // thread id -> promise
  let disposed = false;
  const inFolder = (cwd, root) => typeof cwd === 'string' && (cwd === root || cwd.startsWith(root === '/' ? '/' : `${root}/`));

  /** Ask once (again when `force`) for a thread's worktree; relinks the thread when the answer changes. */
  function check(threadId, { force = false } = {}) {
    if (disposed) return Promise.resolve();
    const projectId = appProjects.projectOf(threadId, o.cwdOf(threadId));
    const p = projectId ? appProjects.get(projectId) : null;
    const root = p?.roots?.[0] ? (p.roots[0].length > 1 ? p.roots[0].replace(/\/+$/, '') : p.roots[0]) : null;
    if (!root || inFolder(o.cwdOf(threadId), root)) { if (envOf.has(threadId)) { envOf.delete(threadId); o.relink(threadId); } return Promise.resolve(); }
    if (!force && envOf.has(threadId)) return Promise.resolve();
    if (asking.has(threadId)) return asking.get(threadId);
    const run = (async () => {
      let env = null;
      try {
        const r = await o.rpc('thread/attachment/list', { threadId, limit: 100 });
        const a = (Array.isArray(r?.data) ? r.data : []).find((x) => x?.attachmentType === 'worktree' && typeof x.identityKey === 'string' && x.identityKey);
        // The attachment's folder, or else the thread's own (a thread started in a new worktree).
        const dir = a ? (typeof a.payload?.workspaceRoot === 'string' && a.payload.workspaceRoot) || (typeof a.payload?.root === 'string' && a.payload.root) || a.identityKey : o.cwdOf(threadId);
        const w = await appProjects.op('worktree', projectId, { path: dir });
        const key = a ? a.identityKey : w.ok && w.result?.exists ? w.result.root : null;
        const d = w.ok && w.result?.exists && key ? worktreeData(projectId, key, w.result, a && typeof a.payload?.workspaceRoot === 'string' ? a.payload.workspaceRoot : null) : null;
        if (d) {
          safe('worktree environment', () => handle.put(d.ref, { state: d.state, links: d.links }));
          env = d.ref;
        } else if (a && o.resident(refs.worktreeEnvironment(a.identityKey))) safe('worktree environment', () => handle.update(refs.worktreeEnvironment(a.identityKey), { state: { status: 'unavailable' } }));
      } catch (e) { o.log.warn('worktrees: a thread\'s worktree could not be read', { message: String(e?.message ?? e) }); return; }
      const before = envOf.get(threadId)?.id ?? null;
      envOf.set(threadId, env);
      if (before !== (env?.id ?? null)) o.relink(threadId);
    })().finally(() => asking.delete(threadId));
    asking.set(threadId, run);
    return run;
  }

  const inside = (p, root) => typeof p === 'string' && (p === root || p.startsWith(`${root}/`));
  /** The threads that run in a worktree: linked to it, or in its folder. */
  function threadsIn(ref) {
    const out = new Set();
    for (const [t, env] of envOf) if (env?.id === ref.id) out.add(t);
    for (const t of o.threads?.() ?? []) if (inside(o.cwdOf(t), ref.id)) out.add(t);
    return [...out];
  }
  const refused = (reason, message) => ({ status: 'refused', reason, message });

  return {
    check,
    /** What the user is asked before a mod removes a worktree (R17). */
    prompt(ref, instance) {
      const n = threadsIn(ref).length;
      return {
        action: `delete the worktree “${instance.state.name}” at ${instance.state.path}`,
        detail: `Its folder and any changes not committed there are removed${n ? `, and its ${n === 1 ? 'chat is' : `${n} chats are`} archived` : ''}. This is what Delete does in the app's Worktrees settings.`,
      };
    },
    async remove(ref, instance) {
      const projectId = instance.links?.project?.id;
      if (!projectId) return refused('unavailable', 'the worktree is in no project the app has');
      const threads = threadsIn(ref);
      const pins = await appProjects.op('pinned-threads', null);
      if (!pins.ok) return refused('unavailable', pins.error);
      if ((pins.result?.threadIds ?? []).some((id) => threads.includes(id))) return refused('unavailable', 'Unpin the chats in this worktree before deleting it');
      // Each chat is archived the app's way (the threads area's archive: its worktree bookkeeping, then the unpin).
      for (const threadId of threads) {
        const r = await o.archive(threadId);
        if (r) return r;
      }
      const r = await appProjects.op('remove-worktree', projectId, { path: ref.id });
      if (!r.ok) { if (r.refused) return refused('unavailable', r.error); throw new Error(r.error); }
      safe('worktree environment removal', () => handle.remove(ref));
      for (const [t, env] of [...envOf]) if (env?.id === ref.id) { envOf.set(t, null); o.relink(t); }
      return null;
    },
    /** The worktree environment a thread runs in, as far as known now (ask with `check`). */
    environmentOf: (threadId) => envOf.get(threadId) ?? null,
    /** `thread/attachment/updated`: a thread's worktree changed. */
    attachmentUpdated(p) { if (p?.attachmentType === 'worktree' && typeof p.threadId === 'string') check(p.threadId, { force: true }); },
    dispose() { disposed = true; },
  };
}
