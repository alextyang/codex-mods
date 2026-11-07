// ExternalApp in the native provider (breadth step D3; docs/graph/02-types.md ExternalApp): the apps on this Mac that Codex opens things in
// (the app's "open in" targets that are installed) and the ones the agent may use without asking (its computer-use approvals), read the
// app's way through framework-main (framework/main/projects.cjs `apps`).
// - Identity is the app's bundle id where it is known: a computer-use approval's, an approval request's (ComputerUseApproval.app), an open-in
//   target whose executable is inside its `.app`, and Finder and Terminal (macOS's own). An open-in target whose bundle cannot be read (it
//   runs through `open`) is named by the app's own target id; if such an app is also approved for computer use, it is two instances.
// - `opens` follows the target's kind: an editor and Finder open a project, a file or a folder; a terminal a project or a folder; an app
//   only approved for computer use opens nothing here.
// - `computerUse`: `always` for an approved app, `ask` for any other, `unsupported` when the app has no computer-use settings; the app has
//   no "never".
// - Read at the source's start, when the app's projects become available, every READ_MS, after a change it makes, and when a realm observes
//   an app read longer ago than FRESH_MS (the app pushes no change). A change of an app's computer-use level or name says `changed`. An app
//   known by its bundle id stays when the app stops listing it (its approval was taken back): it is still on this Mac, now at `ask`.
// Operations: `open(target)` opens a Project, File or Folder in an open-in target the app's way; `setComputerUse('ask')` takes an
// approval back (the only change the app can make: "always" comes only from its own permission prompt), after the user approves a mod's
// call (runtime-core.md R17).
import { refs } from './map.mjs';

export const READ_MS = 10 * 60_000;
const FRESH_MS = 30_000;
const OPENS = { editor: ['project', 'file', 'folder'], fileManager: ['project', 'file', 'folder'], terminal: ['project', 'folder'] };

/**
 * The apps from the app's answer: id -> {state, target?, bundleId?}.
 * @param {{ targets: { id: string, label: string, icon: string | null, kind: string | null, bundleId: string | null }[], approvals: { apps: { bundleId: string, name: string }[] } | null }} r
 */
export function appsData(r) {
  const approved = r.approvals ? new Set(r.approvals.apps.map((a) => a.bundleId)) : null;
  const level = (bundleId) => (approved === null ? 'unsupported' : bundleId && approved.has(bundleId) ? 'always' : 'ask');
  const out = new Map();
  for (const t of r.targets ?? []) {
    const id = t.bundleId ?? t.id;
    if (out.has(id)) continue;
    out.set(id, { state: { name: t.label, icon: t.icon ?? 'app', opens: OPENS[t.kind] ?? [], computerUse: level(t.bundleId) }, target: t.id, bundleId: t.bundleId ?? null });
  }
  for (const a of r.approvals?.apps ?? []) {
    if (out.has(a.bundleId)) continue;
    out.set(a.bundleId, { state: { name: a.name, icon: a.icon ?? 'app', opens: [], computerUse: 'always' }, target: null, bundleId: a.bundleId });
  }
  return out;
}

/** The operation handlers, for the provider's registration. */
export function appTypes(feed) {
  return {
    ExternalApp: {
      operations: {
        open: { effect: 'none', handler: ({ ref, args }) => feed.open(ref, args[0]) },
        // A lasting permission: a mod's call asks the user first (R17), only when it would change something the app can change.
        setComputerUse: { effect: 'external', approval: ({ ref, instance, args }) => feed.prompt(ref, instance, args[0]), alwaysAsks: () => 'an app\'s computer-use level', handler: ({ ref, instance, args }) => feed.setComputerUse(ref, instance, args[0]) },
      },
    },
  };
}

/**
 * @param {{ handle: object, graph: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   projectOfPath(path: string): { id: string, root: string } | null, log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createAppFeed(o) {
  const { handle, graph, appProjects, safe } = o;
  const now = o.now ?? Date.now;
  const known = new Map();   // instance id -> {target, bundleId}
  let readAt = 0, reading = null, disposed = false;

  function apply(r) {
    const next = appsData(r);
    for (const [id, d] of next) {
      const ref = refs.externalApp(id);
      const cur = o.resident(ref);
      safe('app', () => handle.put(ref, { state: d.state, links: {} }));
      if (cur && (cur.state.computerUse !== d.state.computerUse || cur.state.name !== d.state.name)) o.emitEvent(ref, 'changed');
      known.set(id, { target: d.target, bundleId: d.bundleId });
    }
    for (const x of graph.list('ExternalApp') ?? []) {
      if (x.ref.provider !== handle.id || next.has(x.ref.id)) continue;
      const k = known.get(x.ref.id);
      if (k?.bundleId && r.approvals) {
        // No longer approved, and not an open-in target: the app is still here, Codex now asks before using it.
        if (x.state.computerUse !== 'ask') { safe('app', () => handle.update(x.ref, { state: { computerUse: 'ask' } })); o.emitEvent(x.ref, 'changed'); }
        continue;
      }
      safe('app removal', () => handle.remove(x.ref));
      known.delete(x.ref.id);
    }
  }
  /** Read the apps again (one read at a time). */
  function read() {
    if (disposed || !appProjects.available) return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      const r = await appProjects.op('apps', null);
      if (!r.ok) { o.log.warn('apps: the app\'s apps could not be read', { message: r.error }); return; }
      readAt = now();
      apply(r.result ?? { targets: [], approvals: null });
    })().finally(() => { reading = null; });
    return reading;
  }
  const sub = appProjects.onChange((c) => { if (c.available === true) read(); });
  const timer = setInterval(() => { read(); }, READ_MS);
  timer.unref?.();

  /** The absolute path a target names: a project's folder, a file's or a folder's path. */
  function pathOf(target) {
    if (!target || typeof target !== 'object' || typeof target.id !== 'string') return null;
    const concept = graph.type(target.type)?.concept;
    if (concept === 'Project') return appProjects.get(target.id)?.roots?.[0] ?? null;
    if (concept === 'File' || concept === 'Folder') return target.id;
    return null;
  }
  const refusedWith = (reason, message) => ({ status: 'refused', reason, message });

  return {
    read,
    /** The source's onObserve for an ExternalApp ref: read again when the last read is old. */
    observe() { return now() - readAt > FRESH_MS ? read() : undefined; },
    async open(ref, target) {
      const k = known.get(ref.id);
      if (!k?.target) return refusedWith('unsupported', 'Codex opens things only in its "open in" apps');
      if (typeof target === 'string') return refusedWith('unsupported', 'this app does not open urls here');
      const p = pathOf(target);
      if (!p) return refusedWith('invalid', 'the target is a Project, a File or a Folder');
      const at = o.projectOfPath(p);
      if (!at) return refusedWith('unavailable', 'the path is not in a project the app has');
      const r = await appProjects.op('open-in', at.id, { path: p, target: k.target });
      if (r.ok) return null;
      if (r.refused) return refusedWith('unavailable', r.error);
      throw new Error(r.error);
    },
    /** What the user is asked before a mod's call (R17), or null when the call changes nothing or cannot be made. */
    prompt(ref, instance, level) {
      if (level !== 'ask' || instance.state.computerUse !== 'always') return null;
      return { action: `stop letting Codex use “${instance.state.name}” without asking`, detail: 'Codex will ask you again before it uses this app. This changes your computer-use settings, which Codex keeps on this Mac.' };
    },
    async setComputerUse(ref, instance, level) {
      const cur = instance.state.computerUse;
      if (level === cur) return null;
      if (cur === 'unsupported') return refusedWith('unsupported', 'Codex has no computer-use settings here');
      if (level === 'always') return refusedWith('unsupported', 'Codex lets an app be used without asking only from its own permission prompt (approve a computer-use request "always")');
      if (level !== 'ask') return refusedWith('unsupported', `Codex has no "${level}" level for an app`);
      const bundleId = known.get(ref.id)?.bundleId;
      if (!bundleId) return refusedWith('unavailable', 'the app\'s bundle is not known');
      const r = await appProjects.op('remove-app-approval', null, { bundleId });
      if (!r.ok) { if (r.refused) return refusedWith('unavailable', r.error); throw new Error(r.error); }
      await read();
      return null;
    },
    dispose() { disposed = true; sub.dispose(); clearInterval(timer); },
  };
}
