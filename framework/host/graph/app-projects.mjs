// The app's projects in the Host (breadth step D3; ARCHITECTURE.md 6.8): the projects the app's sidebar shows, the one it opened, and what
// the app records about each thread's project, as framework-main reads them from the app's global state (framework/main/projects.cjs). The
// native provider (providers/codex) puts them as LocalProject instances and links its threads to them. This store is the Host's copy:
// - `apply(report)` takes framework-main's `projects` message: the projects and the selected one when they changed, and the threads' facts
//   as what changed (all of them on `reset`). Each report that changed something is announced to the `onChange` listeners; a reset, or the
//   first report the store hears, is `sync: true`: it is only catching up, so nobody did it and no event is made of it.
// - `projectOf(threadId, cwd)` is the project whose section the app shows the thread in, by the app's own rule (its renderer's project
//   filter, 21477): a thread assigned to a project is in it (assigned to a remote project: in no local one); a projectless one is in none;
//   otherwise it is in the project its workspace-root hint names, or the one whose root holds its working directory (the deepest, where
//   roots nest; the app then lists it under each).
// - `op(op, projectId, args)` asks framework-main to run an operation the app's way (rename, remove, reveal) and settles with its
//   `app-op-done`: `{ok: true, result?}`, or `{ok: false, error, refused}` (refused: nothing was tried). framework-main sends the report of
//   what the operation changed first, so the store holds the result when the promise settles.
// While framework-main has no store (`available: false`) the store keeps what it knew, and operations are refused. Node built-ins only.
import { randomBytes } from 'node:crypto';

const MAX_ID = 200;

/** @typedef {{ id: string, name: string, roots: string[], createdAt?: number, updatedAt?: number }} AppProject */
/**
 * @typedef {{ sync: boolean, available?: boolean, projects?: { added: string[], removed: string[], renamed: string[], changed: string[] },
 *   selected?: { from: string | null, to: string | null }, threads?: string[] }} AppProjectsChange
 *   `projects.changed` lists every project whose record changed (renamed ones among them); `threads` the threads whose facts changed. A
 *   change of `projects` can move any thread (by its working directory), so a reader links them all again.
 */
/** @typedef {{ project?: string, other?: true, projectless?: true, root?: string }} ThreadFacts */

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
function projectOf(p) {
  if (!p || typeof p !== 'object' || !isId(p.id) || typeof p.name !== 'string') return null;
  const roots = Array.isArray(p.roots) ? p.roots.filter((r) => typeof r === 'string' && r.length > 0) : [];
  return Object.freeze({
    id: p.id, name: p.name, roots: Object.freeze(roots),
    ...(Number.isFinite(p.createdAt) ? { createdAt: p.createdAt } : {}), ...(Number.isFinite(p.updatedAt) ? { updatedAt: p.updatedAt } : {}),
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const trimmed = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
/** @returns {ThreadFacts | null} */
function factsOf(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  if (isId(f.project)) out.project = f.project;
  if (f.other === true) out.other = true;
  if (f.projectless === true) out.projectless = true;
  if (typeof f.root === 'string' && f.root.startsWith('/')) out.root = trimmed(f.root);
  return Object.keys(out).length ? Object.freeze(out) : null;
}

/**
 * @param {{ send?: (msg: { type: 'app-op', requestId: string, op: string, projectId: string, name?: string }) => void,
 *   log?: { warn(m: string, d?: unknown): void }, timeoutMs?: number }} [o]
 */
export function createAppProjects(o = {}) {
  const log = o.log ?? { warn() {} };
  const timeoutMs = o.timeoutMs ?? 20_000;
  const prefix = randomBytes(4).toString('hex');   // request ids are unique per Host start
  let available = false;
  let heard = false;
  /** @type {Map<string, AppProject>} in the sidebar's order */
  let projects = new Map();
  let selected = null;
  const facts = new Map();         // thread id -> ThreadFacts
  const pending = new Map();       // request id -> {resolve, timer}
  const fns = new Set();
  let seq = 0;
  let disposed = false;

  function fire(change) {
    for (const fn of [...fns]) { try { fn(change); } catch (e) { log.warn('app projects: a listener failed', { message: String(e?.message ?? e) }); } }
  }

  function apply(msg) {
    if (disposed || !msg || msg.type !== 'projects') return;
    const was = available;
    available = msg.available === true;
    if (!available) { if (was) fire({ sync: true, available: false }); return; }
    const reset = msg.reset === true;
    /** @type {AppProjectsChange} */
    const change = { sync: reset || !heard };
    heard = true;
    if (!was) change.available = true;
    if (Array.isArray(msg.projects)) {
      const next = new Map();
      for (const raw of msg.projects) { const p = projectOf(raw); if (p && !next.has(p.id)) next.set(p.id, p); }
      const added = [...next.keys()].filter((id) => !projects.has(id));
      const removed = [...projects.keys()].filter((id) => !next.has(id));
      const changed = [...next.keys()].filter((id) => projects.has(id) && !same(projects.get(id), next.get(id)));
      const renamed = changed.filter((id) => projects.get(id).name !== next.get(id).name);
      const reordered = !same([...projects.keys()], [...next.keys()]);
      projects = next;
      if (added.length || removed.length || changed.length || reordered) change.projects = { added, removed, renamed, changed };
    }
    if (msg.selected !== undefined) {
      const to = isId(msg.selected) ? msg.selected : null;
      if (to !== selected) { change.selected = { from: selected, to }; selected = to; }
    }
    if (msg.threads && typeof msg.threads === 'object') {
      const threads = [];
      const entries = Object.entries(msg.threads).filter(([t]) => isId(t)).map(([t, f]) => [t, factsOf(f)]);
      if (reset) {
        const fresh = new Map(entries.filter(([, f]) => f));
        for (const t of new Set([...facts.keys(), ...fresh.keys()])) if (!same(facts.get(t) ?? null, fresh.get(t) ?? null)) threads.push(t);
        facts.clear();
        for (const [t, f] of fresh) facts.set(t, f);
      } else {
        for (const [t, f] of entries) {
          if (same(facts.get(t) ?? null, f)) continue;
          if (f) facts.set(t, f); else facts.delete(t);
          threads.push(t);
        }
      }
      if (threads.length) change.threads = threads;
    }
    if (change.available || change.projects || change.selected || change.threads) fire(change);
  }

  /** framework-main's answer to an operation. */
  function settle(msg) {
    const p = msg && pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timer);
    p.resolve(msg.ok === true ? { ok: true, ...(msg.result !== undefined ? { result: msg.result } : {}) } : { ok: false, error: typeof msg.error === 'string' ? msg.error : 'the operation failed', refused: msg.refused !== false });
  }

  return {
    get available() { return available; },
    /** The projects, in the sidebar's order. */
    list: () => [...projects.values()],
    get: (id) => projects.get(id) ?? null,
    get selected() { return selected; },
    /** The project id the app shows a thread in (see above), or null; `cwd` is the thread's working directory. */
    projectOf(threadId, cwd) {
      const f = facts.get(threadId);
      if (f?.project) return projects.has(f.project) ? f.project : null;
      if (f?.other || f?.projectless) return null;
      const holding = (path, exact) => {
        let best = null, len = -1;
        for (const p of projects.values()) {
          for (const r of p.roots) {
            const root = trimmed(r);
            if ((path === root || (!exact && path.startsWith(root === '/' ? '/' : `${root}/`))) && root.length > len) { best = p.id; len = root.length; }
          }
        }
        return best;
      };
      if (f?.root) { const p = holding(f.root, true); if (p) return p; }
      return typeof cwd === 'string' && cwd.startsWith('/') ? holding(trimmed(cwd), false) : null;
    },
    /** What the app records about a thread's project, or null. */
    factsOf: (threadId) => facts.get(threadId) ?? null,
    apply,
    settle,
    /**
     * Run an operation in the app (framework/main/projects.cjs): on a project, 'rename' ({name}), 'remove', 'reveal' ({path?}: the project's
     * folder, or a path in it), 'list' ({path}: a folder's entries), 'inspect' ({path}: a file's size, time and kind), 'open' ({path}: a
     * file tab), 'open-in' ({path, target}), 'repository', 'switch-branch' and 'create-branch' ({branch}), 'push', 'worktree' ({path}),
     * 'instructions' ({path}: a folder's instructions files), 'edit-instructions' ({path, text}), 'create-instructions' ({text}: its
     * AGENTS.md, only where none is), 'add-skill' ({name, text}: a skill in its .codex/skills, created exclusively), 'actions' and
     * 'run-action' ({path: the config, index, threadId?, cwd?}); on the app (projectId null), 'add-skill' (in the Codex home), 'apps'
     * (its open-in targets and computer-use approvals), 'remove-app-approval' ({bundleId}), 'cloud-environments', and the global
     * instructions: 'instructions', 'edit-instructions' ({path, text}), 'open-instructions' ({path}).
     * @returns {Promise<{ ok: true, result?: unknown } | { ok: false, error: string, refused: boolean }>}
     */
    op(op, projectId, args = {}, { timeoutMs: opMs = timeoutMs } = {}) {
      if (disposed) return Promise.resolve({ ok: false, error: 'the Host is shutting down', refused: true });
      if (!available || typeof o.send !== 'function') return Promise.resolve({ ok: false, error: 'the app\'s projects are not available', refused: true });
      const requestId = `${prefix}-${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({ ok: false, error: `framework-main did not answer in ${opMs} ms`, refused: false });
        }, opMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        const extra = Object.fromEntries(['name', 'path', 'target', 'bundleId', 'branch', 'text', 'index', 'threadId', 'cwd', 'scope'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        try { o.send({ type: 'app-op', requestId, op, ...(projectId != null ? { projectId } : {}), ...extra }); } catch (e) {
          pending.delete(requestId);
          clearTimeout(timer);
          resolve({ ok: false, error: String(e?.message ?? e), refused: true });
        }
      });
    },
    /** @param {(change: AppProjectsChange) => void} fn */
    onChange(fn) { fns.add(fn); return { dispose: () => fns.delete(fn) }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the Host is shutting down', refused: false }); }
      pending.clear();
      fns.clear();
    },
  };
}
