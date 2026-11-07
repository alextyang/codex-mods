// Instructions in the native provider (breadth step D3; docs/graph/02-types.md Instructions): the files Codex follows, `AGENTS.md` and
// `AGENTS.override.md`, read through framework-main (framework/main/projects.cjs `instructions`): the global ones in the Codex home, a
// project's in its folder, and a folder's once the files feed lists a folder that holds them.
// - One instance per file, named by its path (`location`). An override that is not empty is followed in place of the AGENTS.md beside it
//   (Codex's rule; the app's settings say so of the global one): that AGENTS.md is `enabled: false`, and so is an empty override.
// - The global AGENTS.md always has an instance (the app makes the file when its settings show it): an absent one is empty. Any other file
//   has one while it exists; a file too large to read has none.
// - `agents`: the Codex agent follows them all. `folder`: the folder that holds a project's or a folder's file.
// - Read at the source's start, when the app's projects change, every READ_MS, when a realm observes one read longer ago than FRESH_MS,
//   after an edit, and for a folder each time the files feed lists it. Each file that exists is watched through the protocol (`fs/watch`
//   on the file, as the app watches the files it shows; `fs/changed` names the watch): its folder is read again. A change of text or of
//   `enabled` says `changed`.
// Operations: Project.addInstructions(text) creates the project's AGENTS.md where nothing is at that path (framework-main, exclusively),
// then reads it. `edit(text)`
// replaces the file's text the app's way; a mod's edit of the global instructions asks the user first (they apply to
// every thread, here and in the command line: runtime-core.md R17). `open()` shows the file in the app beside the thread it shows. The app
// has no switch for a file: enable() and disable() are not realized.
import { refs } from './map.mjs';

export const READ_MS = 2 * 60_000;
const FRESH_MS = 15_000;
const RELOAD_MS = 150;
const AGENTS = 'AGENTS.md';
const OVERRIDE = 'AGENTS.override.md';

const basename = (p) => p.split('/').filter(Boolean).pop() ?? p;
const dirname = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const trimmed = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const textContent = (t) => ({ parts: [{ kind: 'text', text: String(t ?? '') }] });
const textOf = (c) => (c?.parts ?? []).map((p) => p.text ?? '').join('');

/**
 * A folder's instructions files (framework-main's answer: `{path, exists, text?, tooLarge?}` for AGENTS.md and AGENTS.override.md) -> the
 * instances, with which of them Codex follows.
 * @param {'global' | 'project' | 'folder'} scope
 * @param {{ path: string, exists: boolean, text?: string, tooLarge?: boolean }[]} files
 * @param {{ projectId?: string | null, folder?: string | null }} at
 */
export function instructionsData(scope, files, at = {}) {
  const override = files.find((f) => basename(f.path) === OVERRIDE && f.exists && typeof f.text === 'string');
  const overridden = !!override && override.text.trim() !== '';
  const out = [];
  for (const f of files) {
    const name = basename(f.path);
    if (f.tooLarge) continue;
    if (!f.exists && !(scope === 'global' && name === AGENTS)) continue;
    out.push({
      ref: refs.instructions(f.path),
      state: { scope, text: textContent(f.exists ? f.text : ''), enabled: name === OVERRIDE ? overridden : !overridden, location: f.path },
      links: { project: at.projectId ? refs.project(at.projectId) : null, folder: at.folder ? refs.folder(at.folder) : null, agents: [refs.agent()] },
    });
  }
  return out;
}

/** The operation handlers, for the provider's registration. */
export function instructionsTypes(feed) {
  return {
    Instructions: {
      operations: {
        // A mod's edit of the global instructions asks the user first (R17): every thread follows them, here and in the command line.
        edit: { effect: 'external', approval: ({ instance }) => feed.prompt(instance), alwaysAsks: ({ instance }) => (instance?.state?.scope === 'global' ? 'the global instructions' : null), handler: ({ ref, instance, args }) => feed.edit(ref, instance, args[0]) },
        open: { effect: 'none', handler: ({ ref, instance }) => feed.open(ref, instance) },
      },
    },
  };
}

/**
 * @param {{ handle: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   rpc(method: string, params: object): Promise<unknown>, log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createInstructionsFeed(o) {
  const { handle, appProjects, safe } = o;
  const now = o.now ?? Date.now;
  const GLOBAL = '(global)';
  const dirs = new Map();       // folder (or GLOBAL) -> {scope, projectId, files: Set<path>, readAt}
  const reading = new Map();    // folder -> promise
  const watches = new Map();    // file path -> watch id
  const byWatch = new Map();    // watch id -> file path
  const reloads = new Map();    // folder -> timer
  let home = null;              // the Codex home, once read
  let seq = 0;
  let lost = [];
  let disposed = false;

  const rootOf = (projectId) => { const r = appProjects.get(projectId)?.roots?.[0]; return r ? trimmed(r) : null; };
  const dirOfFile = (p) => (home && dirname(p) === home ? GLOBAL : dirname(p));

  function apply(dir, scope, projectId, files) {
    const folder = scope === 'global' ? null : dir;
    const next = instructionsData(scope, files, { projectId, folder });
    const had = dirs.get(dir)?.files ?? new Set();
    const keep = new Set(next.map((d) => d.ref.id));
    for (const d of next) {
      const cur = o.resident(d.ref);
      safe('instructions', () => handle.put(d.ref, { state: d.state, links: d.links }));
      if (cur && (textOf(cur.state.text) !== textOf(d.state.text) || cur.state.enabled !== d.state.enabled)) o.emitEvent(d.ref, 'changed');
    }
    for (const p of had) if (!keep.has(p)) { if (o.resident(refs.instructions(p))) safe('instructions removal', () => handle.remove(refs.instructions(p))); }
    for (const f of files) { if (f.exists && keep.has(f.path)) watch(f.path); else unwatch(f.path); }
    if (keep.size) dirs.set(dir, { scope, projectId, files: keep, readAt: now() });
    else forget(dir);
  }
  function forget(dir) {
    const d = dirs.get(dir);
    if (!d) return;
    dirs.delete(dir);
    for (const p of d.files) { unwatch(p); if (o.resident(refs.instructions(p))) safe('instructions removal', () => handle.remove(refs.instructions(p))); }
  }
  /** Read a folder's instructions files (GLOBAL: the Codex home's); one read at a time per folder. */
  function read(dir, projectId = null) {
    if (disposed || !appProjects.available) return Promise.resolve();
    if (reading.has(dir)) return reading.get(dir);
    const run = (async () => {
      if (dir === GLOBAL) {
        const r = await appProjects.op('instructions', null);
        if (!r.ok) { o.log.warn('instructions: the global instructions could not be read', { message: r.error }); return; }
        home = typeof r.result?.home === 'string' ? trimmed(r.result.home) : home;
        apply(GLOBAL, 'global', null, r.result?.files ?? []);
        return;
      }
      const pid = projectId ?? dirs.get(dir)?.projectId;
      if (!pid || !appProjects.get(pid)) { forget(dir); return; }
      const r = await appProjects.op('instructions', pid, { path: dir });
      if (!r.ok) { if (r.refused) forget(dir); else o.log.warn('instructions: a folder\'s instructions could not be read', { message: r.error }); return; }
      apply(dir, dir === rootOf(pid) ? 'project' : 'folder', pid, r.result?.files ?? []);
    })().finally(() => reading.delete(dir));
    reading.set(dir, run);
    return run;
  }
  function readAll() {
    const roots = appProjects.list().map((p) => [rootOf(p.id), p.id]).filter(([r]) => r);
    const known = [...dirs].filter(([d]) => d !== GLOBAL).map(([d, x]) => [d, x.projectId]);
    return Promise.all([read(GLOBAL), ...[...new Map([...known, ...roots])].map(([d, pid]) => read(d, pid))]);
  }

  // ---------------------------------------------------------------- watching (fs/watch on each file, fs/changed)
  function watch(p) {
    if (disposed || watches.has(p)) return;
    const watchId = `codexmods-graph-instructions-${++seq}`;
    watches.set(p, watchId);
    byWatch.set(watchId, p);
    o.rpc('fs/watch', { watchId, path: p }).catch((e) => {
      if (byWatch.get(watchId) === p) { byWatch.delete(watchId); watches.delete(p); }
      o.log.warn('instructions: a file could not be watched', { message: String(e?.message ?? e) });
    });
  }
  function unwatch(p) {
    const watchId = watches.get(p);
    if (!watchId) return;
    watches.delete(p);
    byWatch.delete(watchId);
    o.rpc('fs/unwatch', { watchId }).catch(() => {});
  }
  function scheduleReload(dir) {
    if (reloads.has(dir) || disposed) return;
    const t = setTimeout(() => { reloads.delete(dir); read(dir).catch((e) => o.log.warn('instructions: a folder could not be read again', { message: String(e?.message ?? e) })); }, RELOAD_MS);
    t.unref?.();
    reloads.set(dir, t);
  }

  const sub = appProjects.onChange((c) => {
    if (disposed) return;
    if (c.available === true) { readAll(); return; }
    if (c.projects) {
      for (const id of c.projects.removed) for (const [d, x] of [...dirs]) if (x.projectId === id) forget(d);
      for (const id of [...c.projects.added, ...c.projects.changed]) {
        const root = rootOf(id);
        for (const [d, x] of [...dirs]) if (x.projectId === id && (!root || (d !== root && !d.startsWith(`${root}/`)))) forget(d);
        if (root) read(root, id);
      }
    }
  });
  const timer = setInterval(() => { readAll(); }, READ_MS);
  timer.unref?.();
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  const answer = (r) => { if (r.ok) return null; if (r.refused) return refused('unavailable', r.error); throw new Error(r.error); };

  return {
    readAll,
    /** The source's onObserve for an Instructions ref: its folder is read again when the last read is old. */
    observe(ref) {
      const dir = dirOfFile(ref.id);
      const d = dirs.get(dir);
      if (d && now() - d.readAt <= FRESH_MS) return undefined;
      if (dir === GLOBAL || d) return read(dir);
      // a folder of a project's never read (an instructions file the user saved in a subfolder: built review H6m2a): read as the project
      // whose folder holds it most closely, any of its folders (a project nested in another's is its own: round 2)
      let pid = null, len = -1;
      for (const x of appProjects.list?.() ?? []) {
        for (const r0 of x.roots ?? []) {
          const r = trimmed(r0);
          if (r && (dir === r || dir.startsWith(`${r}/`)) && r.length > len) { pid = x.id; len = r.length; }
        }
      }
      return pid ? read(dir, pid) : undefined;
    },
    /** The files feed listed a folder of a project: its instructions files are read when it holds any (or held some). */
    listed(projectId, folder, entries) {
      const dir = trimmed(folder);
      const holds = entries.some((e) => e.type === 'file' && (basename(e.path) === AGENTS || basename(e.path) === OVERRIDE));
      if (holds || dirs.has(dir)) read(dir, projectId);
    },
    /** A `fs/changed` the source observed: a watched file's folder is read again. */
    changed(params) {
      const p = byWatch.get(params?.watchId);
      if (p) scheduleReload(dirOfFile(p));
    },
    serverDown() { lost = [...new Set([...lost, ...watches.keys()].map(dirOfFile))]; byWatch.clear(); watches.clear(); },
    serverUp() { const again = lost; lost = []; for (const d of again) scheduleReload(d); },
    /** What the user is asked before a mod's edit (R17), or null when no one need be asked. */
    prompt(instance) {
      if (instance.state.scope !== 'global') return null;
      return { action: 'change the instructions Codex follows in every thread', detail: `This replaces the text of ${instance.state.location}, which Codex reads for every thread on this Mac, in the app and in the command line.` };
    },
    async edit(ref, instance, content) {
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      if (parts.some((p) => p.kind !== 'text' || typeof p.text !== 'string')) return refused('invalid', 'instructions are text');
      const dir = dirOfFile(ref.id);
      const pid = instance.state.scope === 'global' ? null : instance.links.project?.id ?? null;
      if (instance.state.scope !== 'global' && !pid) return refused('unavailable', 'the instructions are in no project the app has');
      const r = await appProjects.op('edit-instructions', pid, { path: ref.id, text: parts.map((p) => p.text).join('') });
      await read(dir);
      return answer(r);
    },
    /** Project.addInstructions(text): the project's AGENTS.md written where it has none, then read; its Instructions instance. */
    async add(projectId, content) {
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      if (!parts.length || parts.some((p) => p.kind !== 'text' || typeof p.text !== 'string')) return refused('invalid', 'instructions are text');
      const text = parts.map((p) => p.text).join('');
      if (!text.trim()) return refused('invalid', 'instructions need a text');
      const root = rootOf(projectId);
      if (!root) return refused('unavailable', 'the project has no folder the app knows');
      const file = `${root === '/' ? '' : root}/${AGENTS}`;
      await read(root, projectId);
      if (o.resident(refs.instructions(file))) return refused('invalid', 'the project has its instructions already: edit them');
      // created exclusively by framework-main: a file there (read or not) is never written over
      const r = await appProjects.op('create-instructions', projectId, { text });
      if (!r.ok && r.refused) return refused(/already/.test(String(r.error)) ? 'invalid' : 'unavailable', r.error);
      await read(root, projectId);
      const made = o.resident(refs.instructions(file));
      if (r.ok) return refs.instructions(file);
      // framework-main did not say (its answer came too late): what is there now says, else the outcome is not known
      return made && textOf(made.state.text) === text ? refs.instructions(file) : { status: 'uncertain', operation: 'addInstructions' };
    },
    async open(ref, instance) {
      const pid = instance.state.scope === 'global' ? null : instance.links.project?.id ?? null;
      if (instance.state.scope !== 'global' && !pid) return refused('unavailable', 'the instructions are in no project the app has');
      return answer(await appProjects.op(pid ? 'open' : 'open-instructions', pid, { path: ref.id }));
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
