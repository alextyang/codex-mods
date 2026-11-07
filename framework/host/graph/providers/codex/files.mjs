// Folder and File in the native provider (breadth step D3; docs/graph/02-types.md Folder, File). A project's folders and files are read the
// app's way: framework-main asks the app's `workspaceFiles` (framework/main/projects.cjs), through the Host's copy of the app's projects
// (graph/app-projects.mjs `op('list' | 'inspect')`), so the graph lists a folder as the app's file tree does (dotfiles left out).
// - Each project's folder (its first root) is put with the project, and goes with it, with everything read inside it.
// - A folder's contents are read when a realm observes the folder or its `files` or `folders` (or reads it again, below): the listing, then
//   each file's size, modification time and content kind. What is no longer listed goes; a file that goes says `deleted`.
// - A file is read when a realm observes it (a FileEdit's or an Attachment's file); one that is not there goes.
// - A folder that was read is watched through the protocol (`fs/watch` on the source's own client; `fs/changed` names its watch): it is read
//   again, and a file whose size or time changed says `changed`. At most WATCH_MAX folders are watched (the least recently read are let go);
//   a backend restart ends the watches, and they are made again when the app-server is ready.
// A path outside every project has no instance (a File and a Folder are in a project). Identity is the absolute path (refs.folder, refs.file);
// a path in nested projects belongs to the deepest root.
import { refs } from './map.mjs';

export const WATCH_MAX = 64;
const INSPECT_CONCURRENCY = 8;
const RELOAD_MS = 150;

const basename = (p) => p.split('/').filter(Boolean).pop() ?? p;
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const trimmed = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** A folder's instance data. `parent` is null for a project's root. */
export function folderData(path, projectId, parent) {
  return { ref: refs.folder(path), state: { path, name: basename(path) }, links: { project: refs.project(projectId), parent: parent ? refs.folder(parent) : null } };
}
/** A file's instance data from the app's inspection (`{size, modifiedAt, kind}`; unknowns as 0 and 'unknown'). */
export function fileData(path, projectId, meta) {
  return {
    ref: refs.file(path),
    state: { path, name: basename(path), size: meta.size ?? 0, modifiedAt: meta.modifiedAt ?? 0, kind: meta.kind ?? 'unknown' },
    links: { project: refs.project(projectId), folder: refs.folder(parentOf(path)) },
  };
}

/** The operation handlers, for the provider's registration: `run(op, ref)` asks the app (File.open shows a file tab beside the thread the
 *  window shows: it changes the app's own state; reveal shows it in Finder). */
export function fileTypes(run, openIn) {
  return {
    Folder: {
      operations: {
        reveal: { effect: 'none', handler: ({ ref }) => run('reveal', ref) },
        openIn: { effect: 'none', handler: ({ ref, args }) => openIn(args[0], ref) },
      },
    },
    File: {
      operations: {
        open: { effect: 'local', handler: ({ ref }) => run('open', ref) },
        reveal: { effect: 'none', handler: ({ ref }) => run('reveal', ref) },
        openIn: { effect: 'none', handler: ({ ref, args }) => openIn(args[0], ref) },
      },
    },
  };
}

/**
 * @param {{ handle: object, graph: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   rpc(method: string, params: object): Promise<unknown>, resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown,
 *   emitEvent(ref: object, name: string): void, log: { warn(m: string, d?: unknown): void },
 *   listed?(projectId: string, folder: string, entries: { path: string, type: string }[]): void }} o
 */
export function createFileFeed(o) {
  const { handle, graph, appProjects, safe } = o;
  const watches = new Map();     // folder path -> watchId, least recently read first
  const byWatch = new Map();     // watchId -> folder path
  const reloads = new Map();     // folder path -> timer
  const loading = new Map();     // folder path -> promise
  let seq = 0, disposed = false;
  let lost = [];                 // the folders watched when the backend went away

  /** `{id, root}`: the project whose root holds the path (the deepest), or null. */
  function projectOfPath(path) {
    let best = null;
    for (const p of appProjects.list()) {
      for (const r of p.roots) {
        const root = trimmed(r);
        if ((path === root || path.startsWith(root === '/' ? '/' : `${root}/`)) && (!best || root.length > best.root.length)) best = { id: p.id, root };
      }
    }
    return best;
  }
  const isFolder = (t) => graph.type(t)?.concept === 'Folder';
  const isFile = (t) => graph.type(t)?.concept === 'File';

  /** Every Folder and File of the provider in the subtree at `path`, deepest first. */
  function subtree(path) {
    const out = [];
    const walk = (folderPath) => {
      const ref = refs.folder(folderPath);
      for (const x of graph.referrers(ref, 'parent')) if (x.ref.provider === handle.id && isFolder(x.ref.type)) walk(x.ref.id);
      for (const x of graph.referrers(ref, 'folder')) if (x.ref.provider === handle.id && isFile(x.ref.type)) out.push(x.ref);
      out.push(ref);
    };
    walk(path);
    return out;
  }
  function removeSubtree(path, { events = true } = {}) {
    for (const ref of subtree(path)) {
      const was = o.resident(ref);
      if (!was) continue;
      safe('file removal', () => handle.remove(ref));
      if (ref.type === 'File' && events) o.emitEvent(ref, 'deleted');
      if (ref.type === 'Folder') unwatch(ref.id);
    }
  }

  // ---------------------------------------------------------------- projects' folders
  function syncRoots() {
    const roots = new Map();   // root path -> project id
    for (const p of appProjects.list()) if (p.roots[0]) roots.set(trimmed(p.roots[0]), p.id);
    for (const [path, projectId] of roots) {
      const d = folderData(path, projectId, null);
      const cur = o.resident(d.ref);
      if (!cur || cur.links?.project?.id !== projectId || cur.links?.parent) safe('folder', () => handle.put(d.ref, { state: d.state, links: d.links }));
    }
    // A folder of a project the app no longer lists goes, with what was read inside it.
    for (const x of graph.list('Folder') ?? []) {
      if (x.ref.provider !== handle.id || x.links?.parent) continue;
      if (!roots.has(x.ref.id)) removeSubtree(x.ref.id, { events: false });
    }
    // A folder that is no longer in a project, or now in another one (a project's roots changed), goes too.
    for (const x of [...(graph.list('Folder') ?? []), ...(graph.list('File') ?? [])]) {
      if (x.ref.provider !== handle.id || !o.resident(x.ref)) continue;
      const at = projectOfPath(x.ref.id);
      if (!at || at.id !== x.links?.project?.id) {
        if (isFolder(x.ref.type)) removeSubtree(x.ref.id, { events: false }); else safe('file removal', () => handle.remove(x.ref));
      }
    }
  }
  const projectSub = appProjects.onChange((c) => { if (!disposed && c.projects) syncRoots(); });

  // ---------------------------------------------------------------- reading
  async function inspect(projectId, path) {
    const r = await appProjects.op('inspect', projectId, { path });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }
  function putFile(projectId, path, meta, { quiet = false } = {}) {
    const d = fileData(path, projectId, meta);
    const cur = o.resident(d.ref);
    safe('file', () => handle.put(d.ref, { state: d.state, links: d.links }));
    if (cur && !quiet && (cur.state.size !== d.state.size || cur.state.modifiedAt !== d.state.modifiedAt)) o.emitEvent(d.ref, 'changed');
  }
  /** Read a folder: its listing, its files' facts; what went is removed. */
  function loadFolder(path) {
    const at = projectOfPath(path);
    if (!at || disposed) return Promise.resolve();
    if (loading.has(path)) return loading.get(path);
    const run = (async () => {
      const r = await appProjects.op('list', at.id, { path });
      if (!r.ok) {
        if (!r.refused) { removeSubtree(path); return; }   // the app could not list it: it is gone
        throw new Error(r.error);
      }
      const ref = refs.folder(path);
      if (!o.resident(ref)) {
        const d = folderData(path, at.id, path === at.root ? null : parentOf(path));
        safe('folder', () => handle.put(d.ref, { state: d.state, links: d.links }));
      }
      const entries = r.result?.entries ?? [];
      const listed = new Set(entries.map((e) => e.path));
      for (const x of graph.referrers(ref, 'parent')) if (x.ref.provider === handle.id && isFolder(x.ref.type) && !listed.has(x.ref.id)) removeSubtree(x.ref.id);
      for (const x of graph.referrers(ref, 'folder')) {
        if (x.ref.provider !== handle.id || !isFile(x.ref.type) || listed.has(x.ref.id)) continue;
        safe('file removal', () => handle.remove(x.ref));
        o.emitEvent(x.ref, 'deleted');
      }
      for (const e of entries) {
        if (e.type !== 'directory') continue;
        const d = folderData(e.path, at.id, path);
        safe('folder', () => handle.put(d.ref, { state: d.state, links: d.links }));
      }
      const files = entries.filter((e) => e.type === 'file');
      let next = 0;
      const worker = async () => {
        while (next < files.length && !disposed) {
          const e = files[next++];
          try {
            const meta = await inspect(at.id, e.path);
            if (meta?.missing) { if (o.resident(refs.file(e.path))) { safe('file removal', () => handle.remove(refs.file(e.path))); o.emitEvent(refs.file(e.path), 'deleted'); } } else putFile(at.id, e.path, meta);
          } catch (err) { o.log.warn('files: a file could not be read', { message: String(err?.message ?? err) }); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, files.length) }, worker));
      watch(path);
      o.listed?.(at.id, path, entries);   // the instructions files it holds (instructions.mjs)
    })();
    loading.set(path, run);
    return run.finally(() => loading.delete(path));
  }
  async function loadFile(path) {
    const at = projectOfPath(path);
    if (!at || disposed) return;
    const meta = await inspect(at.id, path);
    if (meta?.missing) { if (o.resident(refs.file(path))) { safe('file removal', () => handle.remove(refs.file(path))); o.emitEvent(refs.file(path), 'deleted'); } return; }
    if (meta?.isFile === false) return;   // a folder: it is read as one when observed as one
    putFile(at.id, path, meta, { quiet: true });
  }

  // ---------------------------------------------------------------- watching (fs/watch, fs/changed)
  function watch(path) {
    if (disposed) return;
    if (watches.has(path)) { const id = watches.get(path); watches.delete(path); watches.set(path, id); return; }
    const watchId = `codexmods-graph-folder-${++seq}`;
    watches.set(path, watchId);
    byWatch.set(watchId, path);
    o.rpc('fs/watch', { watchId, path }).catch((e) => {
      if (byWatch.get(watchId) === path) { byWatch.delete(watchId); watches.delete(path); }
      o.log.warn('files: a folder could not be watched', { message: String(e?.message ?? e) });
    });
    while (watches.size > WATCH_MAX) unwatch(watches.keys().next().value);
  }
  function unwatch(path) {
    const watchId = watches.get(path);
    if (!watchId) return;
    watches.delete(path);
    byWatch.delete(watchId);
    o.rpc('fs/unwatch', { watchId }).catch(() => {});
  }
  function scheduleReload(path) {
    if (reloads.has(path) || disposed) return;
    const t = setTimeout(() => { reloads.delete(path); loadFolder(path).catch((e) => o.log.warn('files: a folder could not be read again', { message: String(e?.message ?? e) })); }, RELOAD_MS);
    t.unref?.();
    reloads.set(path, t);
  }

  return {
    /** The source's onObserve, for a Folder or File ref (the instance itself, or a folder's files or folders). */
    observe(query) {
      const ref = query.ref;
      if (isFolder(ref.type) && (query.relation === undefined || query.relation === 'files' || query.relation === 'folders')) return loadFolder(trimmed(ref.id));
      if (isFile(ref.type) && query.relation === undefined) return loadFile(ref.id);
      return undefined;
    },
    /** A `fs/changed` the source observed: one of ours is read again. */
    changed(params) {
      const path = byWatch.get(params?.watchId);
      if (path) scheduleReload(path);
    },
    /** The backend went away: its watches are gone with it. */
    serverDown() { lost = [...new Set([...lost, ...watches.keys()])]; byWatch.clear(); watches.clear(); },
    /** The app-server is ready again: the folders that were watched are read (and watched) again. */
    serverUp() { const again = lost; lost = []; for (const p of again) scheduleReload(p); },
    sync: syncRoots,
    projectOfPath,
    dispose() {
      disposed = true;
      projectSub.dispose();
      for (const t of reloads.values()) clearTimeout(t);
      reloads.clear();
      for (const p of [...watches.keys()]) unwatch(p);
    },
  };
}
