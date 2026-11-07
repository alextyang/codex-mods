// The app's projects in the native provider (breadth step D3; docs/graph/02-types.md Project, LocalProject): LocalProject instances from the
// Host's copy of the app's projects (graph/app-projects.mjs), the threads' `project` links by the app's own rule (the store's `projectOf`,
// from what the app records and the thread's working directory), the named events, and the operations the app runs its own way
// (framework/main/projects.cjs). The protocol's `Thread.projectId` is the app-server's id for a project, which is not the app's (the app
// maps one to the other and mirrors only when a flag is on), so it is never used. A project's folder is its first root (a project can have
// several); one without a root is not put. Each project has its LocalEnvironment (the app's "This computer": its folder), put and removed
// with it; a thread whose working directory is inside the project's folder runs there (`Thread.environment`; a worktree thread's is its
// WorktreeEnvironment, a hosted thread's a CloudEnvironment).
import { refs } from './map.mjs';
import { NEW_DRAFT } from './areas/composer.mjs';

/** An app project -> the LocalProject instance, or null when it has no folder. */
export function projectData(p) {
  const first = p?.roots?.[0];
  if (typeof first !== 'string' || !first) return null;
  const root = first.length > 1 ? first.replace(/\/+$/, '') : first;
  // its new chat's Draft: on this build one Draft for every project and none (an alias: graph-layers.md §3.2)
  return { ref: refs.project(p.id), state: { name: p.name, location: root }, links: { folder: refs.folder(root), root: refs.folder(root), draft: refs.draft(NEW_DRAFT) } };
}

/** A project's own environment: its folder, ready. */
export function localEnvironmentData(p) {
  const d = projectData(p);
  if (!d) return null;
  return { ref: refs.localEnvironment(p.id), state: { name: 'This computer', status: 'ready' }, links: { project: d.ref, folder: d.links.folder } };
}
const under = (path, root) => typeof path === 'string' && (path === root || path.startsWith(root === '/' ? '/' : `${root}/`));

/** The operation handlers, for the provider's registration: `run(op, ref, args)` asks the app; `newTerminal(ref, spec)` its terminal;
 *  `findFiles(ref, query, opts)` its files by name. */
export function projectTypes(run, openIn, newTerminal, findFiles, addInstructions) {
  return {
    Project: {
      operations: {
        // The app's own selection of a project (as opening its folder again does): its new chats go to it, and `opened` follows.
        open: { effect: 'local', handler: ({ ref }) => run('select', ref) },
        rename: { effect: 'external', handler: ({ ref, args }) => run('rename', ref, { name: args[0] }) },
        remove: { effect: 'external', handler: ({ ref }) => run('remove', ref) },
        openIn: { effect: 'none', handler: ({ ref, args }) => openIn(args[0], ref) },
        // a terminal in its folder (or a folder in it), its tab beside a chat, as the app's panel opens one
        newTerminal: { effect: 'external', handler: ({ ref, args }) => newTerminal(ref, args[0]) },
        // its files and folders whose names match, best first, as the composer's @ finds them (names, not contents)
        findFiles: { effect: 'none', handler: ({ ref, args }) => findFiles(ref, args[0], args[1]) },
      },
    },
    LocalProject: {
      operations: {
        reveal: { effect: 'none', handler: ({ ref }) => run('reveal', ref) },
        // its AGENTS.md written where it has none, as the app writes instructions; its CodexInstructions instance
        addInstructions: { effect: 'external', handler: ({ ref, args }) => addInstructions(ref, args[0]) },
      },
    },
  };
}

/**
 * @param {{ handle: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   relink(threadId: string): void, threads(): Iterable<string>, cwdOf(threadId: string): string | null }} o
 *   `relink(threadId)` gives a resident thread the link `linkOf` says; `threads()` are the threads the source knows, `cwdOf` their working
 *   directories (from the protocol).
 */
export function createProjectFeed(o) {
  const { handle, appProjects, safe } = o;
  function put(p) {
    const d = projectData(p);
    if (!d) { safe(`project ${p.id}`, () => { handle.remove(refs.localEnvironment(p.id)); handle.remove(refs.project(p.id)); }); return; }
    safe(`project ${p.id}`, () => handle.put(d.ref, { state: d.state, links: d.links }));
    const e = localEnvironmentData(p);
    safe(`environment ${p.id}`, () => handle.put(e.ref, { state: e.state, links: e.links }));
  }
  /** The project a thread is in, as a ref, or null (none, or one that is not put). */
  function linkOf(threadId) {
    const id = appProjects.projectOf(threadId, o.cwdOf(threadId));
    return id && projectData(appProjects.get(id)) ? refs.project(id) : null;
  }
  /** The environment a thread runs in, of the ones this feed knows: its project's own, when its working directory is in the project's folder. */
  function environmentOf(threadId) {
    const id = appProjects.projectOf(threadId, o.cwdOf(threadId));
    const d = id ? projectData(appProjects.get(id)) : null;
    return d && under(o.cwdOf(threadId), d.state.location) ? refs.localEnvironment(id) : null;
  }
  const sub = appProjects.onChange((c) => {
    const threads = new Set(c.threads ?? []);
    if (c.projects) {
      const { added, removed, renamed, changed } = c.projects;
      const wasPut = removed.filter((id) => o.resident(refs.project(id)));
      for (const id of [...added, ...changed]) { const p = appProjects.get(id); if (p) put(p); }
      for (const id of wasPut) safe(`project ${id}`, () => { handle.remove(refs.localEnvironment(id)); handle.remove(refs.project(id)); });
      // A project that came, went or changed its roots can move any thread (by its working directory): every thread links again.
      if (added.length || removed.length || changed.length) for (const t of o.threads()) threads.add(t);
      if (!c.sync) {
        for (const id of added) if (o.resident(refs.project(id))) o.emitEvent(refs.project(id), 'added');
        for (const id of renamed) if (o.resident(refs.project(id))) o.emitEvent(refs.project(id), 'renamed');
        for (const id of wasPut) o.emitEvent(refs.project(id), 'removed');
      }
    }
    if (c.selected?.to && !c.sync && o.resident(refs.project(c.selected.to))) o.emitEvent(refs.project(c.selected.to), 'opened');
    for (const t of threads) o.relink(t);
  });
  return {
    /** Put every project the store has (the source's start). */
    sync() { for (const p of appProjects.list()) put(p); },
    linkOf,
    environmentOf,
    dispose: () => sub.dispose(),
  };
}
