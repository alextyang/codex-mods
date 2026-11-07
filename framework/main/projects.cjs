'use strict';
// The app's projects in framework-main (breadth step D3; docs/graph/02-types.md Project, LocalProject; ARCHITECTURE.md 4.1, 6.8). The app
// keeps its projects in its global state and serves them to its windows through the AppHost service `projects` (its projects manager, one
// for the app): `getLocalProjects()` is the map id -> {id, name, rootPaths, createdAt, updatedAt}, and the store it reads is the manager's
// `globalState` (`get(key)`; `onDidChange(key, fn)` returns the unsubscribe; one store for the app, and every write calls the key's
// listeners). The keys read here:
// - `local-projects`: the projects; `project-order`: the sidebar's order (ids);
// - `selected-project`: `{type: 'local', projectId}`, the project the app opened (new threads go to it);
// - which project's section shows a thread, decided by the app's renderer (its project filter) from three keys: `thread-project-assignments`
//   (thread id -> `{projectKind: 'local' | 'remote', projectId}`: the thread is in that project and in no other), `projectless-thread-ids`
//   (in none, unless assigned) and `thread-workspace-root-hints` (thread id -> a root: in the projects with that root); any other thread
//   is in the projects whose roots hold its working directory. The Host applies that rule (graph/app-projects.mjs), knowing the thread's
//   working directory from the protocol; this module reports the three facts per thread.
// The manager's own `renameLocal({projectId, name})` and `removeLocal(projectId)` change them the app's way (they mirror to the app-server
// and tell every window), so the graph's Project.rename and Project.remove go through them, and Project.open through
// `createOrSelectLocalProjects([root])` (what opening a project's folder again does: it selects the project); LocalProject.reveal is Finder's.
// Thread.moveTo is the window's AppHost service `threadProjectAssignments` (`setMembership`: what the app's "Move to project" writes). A project's
// files are read the app's way too: the window's AppHost service `workspaceFiles` lists a folder as the app's file tree does
// (`listDirectory`: paths relative to a workspace root, dotfiles left out) and inspects a file (`inspect`: size, times and a content kind
// from a sample), only ever inside a root of the project the Host names. File.open is the app's own action `windows.tabs.open` (a file
// tab beside the thread the window shows), run through the window's AppHost `appActions.runInPrimaryWindow`; the app refuses it while
// no thread is shown.
// The apps on this Mac (ExternalApp): the window's `openIn` lists the app's "open in" targets (`getTargets`: id, label, icon, kind, and
// whether it is installed), its open-in worker names the executable a target runs (`get-target-command`), whose `.app` bundle gives the
// app's bundle id (its Info.plist, read with plutil); Finder and Terminal run through `/usr/bin/open`, and are macOS's own apps. `open`
// opens a project's path in a target. `computerUseSettings` gives the apps Codex may use without asking (`getAppApprovals`) and takes one
// back (`removeAppApproval`): the only change the app itself can make.
// A project's repository (Repository, GitRepository, Branch): the app's `repositoryOrigins.read` names its root and origin, and its git
// worker (reached through the window's open-in service: `requestGitWorker`) gives the current branch, the status, the upstream, the
// commits ahead, the recent branches, the default branch and the staged files; `gitRepository` switches, creates and pushes branches the
// app's way (each an operation handle: `wait()`; disposing it before it settles aborts it).
// The signed-in account's cloud environments (CloudEnvironment, the app's newer system): `environmentConfigs.list` for the account and user
// that `accountInfo.readAccountInfo` names (only those two ids are used: nothing else of the account's is read or sent).
// A project's actions (ProjectAction): the `[[actions]]` of its environment config, the one the app selected for the project's folder
// (the persisted atom `local-env-selections-by-workspace` in the global state key `electron-persisted-atom-state`, by `local:<root>`; a
// null there is "no environment") or else the first the app's `localEnvironments.list` gives (its default, `environment.toml`, sorts
// first). The app runs one in a terminal of the thread: the window's `terminal` service makes a session in the project's folder and runs
// the action's command in it (`create`, `runAction`), and the app's action `windows.tabs.open` shows its tab in the thread's panel.
// A few of the app's pages (`navigate`: Settings, Codex Cloud, ...) open the way the app's main opens them: a `navigate-to-route` message to
// the window on the app's channel to its pages.
// Instructions: the files Codex reads, `AGENTS.md` and `AGENTS.override.md` (an override that is not empty is followed in its place), in the
// Codex home (global: the app's rule for this Mac, `CODEX_HOME` else `~/.codex`) and in a project's folders. The global ones are read here
// with node's fs: the app's own read (`agentInstructions.read`) creates an empty `AGENTS.md` when there is none. Editing the global
// `AGENTS.md` is the app's `agentInstructions.write`; a project's files are read and saved through `workspaceFiles` (`read` as text,
// `saveText`, which refuses a file that changed since its modification time was read), as is the global override.
//
// This module holds the store of the first live window's service and reports what it holds to the Host (`projects`, debounced), and runs
// the Host's operations (`app-op`, answered with `app-op-done` after a report of what the operation changed; `refused` when it
// was not tried). A report has the projects in the sidebar's order and the selected one in full (they are few) and the threads' facts as
// what changed since the last report: all of them when `reset` (the first report, the first from another window's store, the first after
// the Host restarted).
// Without a window, the service or its store, nothing happens: the reason is logged once, reports say `available: false`, nothing throws.

const KEYS = ['local-projects', 'project-order', 'selected-project', 'thread-project-assignments', 'projectless-thread-ids', 'thread-workspace-root-hints'];
const OP_TIMEOUT_MS = 15_000;
const MAX_ID = 200;
const MAX_NAME = 500;

const SAMPLE_BYTES = 4096;               // what the app samples to tell a file's kind (its own values, 21477)
const SAMPLE_MAX_FILE = 268_435_456;
const LIST_MAX = 5000;

const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
// framework-main's own calls of the app's services: never held as the user's (the graph's call passed the mods already: user-actions.cjs)
const { own } = require('./user-actions.cjs');

/** The open-in targets that are macOS's own apps (they run through /usr/bin/open, so their bundle is not on the executable's path). */
const SYSTEM_TARGETS = Object.freeze({ fileManager: 'com.apple.finder', terminal: 'com.apple.Terminal' });
const APP_OPS = new Set(['apps', 'remove-app-approval', 'cloud-environments', 'pinned-threads', 'navigate']);   // ops on the app, not on a project
const ADD_TIMEOUT_MS = 5 * 60 * 1000;   // adding a project waits for the user's answer to the app's "Trust this folder?" dialog
/** The app's channel to its pages (`message-for-view`; the census of every supported build checks it) and the routes `navigate` may open. */
const VIEW_CHANNEL = 'codex_desktop:message-for-view';
const ROUTES = new Set(['/settings/codex-cloud', '/settings/personalization', '/settings/worktrees']);
const GLOBAL_OPS = new Set(['instructions', 'edit-instructions', 'open-instructions']);   // on the global instructions when no project is named
const INSTRUCTION_FILES = Object.freeze(['AGENTS.md', 'AGENTS.override.md']);
const INSTRUCTIONS_MAX = 1_048_576;   // bytes of an instructions file read or written (and of a skill's SKILL.md)
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;   // the app's skill-creator's rule
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** `{root, abs}`: the project's root that holds the absolute path `p` (the deepest), or null (outside every root, or not absolute). */
function rootHolding(project, p) {
  if (!str(p, 4096) || !path.isAbsolute(p)) return null;
  const abs = path.resolve(p);
  let best = null;
  for (const r of Array.isArray(project.rootPaths) ? project.rootPaths : []) {
    if (!str(r, 4096) || !path.isAbsolute(r)) continue;
    const root = path.resolve(r);
    if ((abs === root || abs.startsWith(root === path.sep ? root : root + path.sep)) && (!best || root.length > best.length)) best = root;
  }
  return best ? { root: best, abs } : null;
}

/** The projects in the sidebar's order (`project-order` first, then the rest as the app lists them); malformed entries are left out. */
function projectsOf(svc, store) {
  const map = svc.getLocalProjects();
  if (!map || typeof map !== 'object' || typeof map.then === 'function') return [];
  const order = Array.isArray(store.get('project-order')) ? store.get('project-order') : [];
  const ids = new Set([...order.filter((id) => typeof id === 'string' && Object.hasOwn(map, id)), ...Object.keys(map)]);
  const out = [];
  for (const id of ids) {
    const p = map[id];
    if (!str(id, MAX_ID) || !p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const roots = Array.isArray(p.rootPaths) ? p.rootPaths.filter((x) => typeof x === 'string' && x.length > 0) : [];
    out.push({
      id, name: p.name.slice(0, MAX_NAME), roots,
      ...(Number.isFinite(p.createdAt) ? { createdAt: p.createdAt } : {}), ...(Number.isFinite(p.updatedAt) ? { updatedAt: p.updatedAt } : {}),
    });
  }
  return out;
}
function selectedOf(store) {
  const s = store.get('selected-project');
  return s && s.type === 'local' && str(s.projectId, MAX_ID) ? s.projectId : null;
}
/**
 * thread id -> its facts, as a JSON string (compared between reports): `{project}` (assigned to a local project), `{other: true}` (assigned
 * to a remote one: in no local project), `{projectless: true}`, `{root}` (a workspace-root hint), or several of them.
 */
function threadFactsOf(store) {
  const facts = new Map();
  const at = (id) => { let f = facts.get(id); if (!f) facts.set(id, (f = {})); return f; };
  const assignments = store.get('thread-project-assignments');
  if (assignments && typeof assignments === 'object') {
    for (const [id, a] of Object.entries(assignments)) {
      if (!str(id, MAX_ID) || !a || typeof a !== 'object') continue;
      if (a.projectKind === 'local' && str(a.projectId, MAX_ID)) at(id).project = a.projectId;
      else at(id).other = true;
    }
  }
  const projectless = store.get('projectless-thread-ids');
  if (Array.isArray(projectless)) for (const id of projectless) if (str(id, MAX_ID)) at(id).projectless = true;
  const hints = store.get('thread-workspace-root-hints');
  if (hints && typeof hints === 'object') for (const [id, root] of Object.entries(hints)) if (str(id, MAX_ID) && str(root, 4096)) at(id).root = root;
  return new Map([...facts].map(([id, f]) => [id, JSON.stringify(f)]));
}

/**
 * @param {{ appHost: ReturnType<typeof import('./apphost.cjs').installAppHost>, send(msg: object): void, revealPath?: ((path: string) => void) | null,
 *   toView?: ((windowId: number, msg: object) => void) | null,
 *   log?: { info(m: string, d?: unknown): void, error(m: string, d?: unknown): void, warn?(m: string, d?: unknown): void },
 *   debounceMs?: number, opTimeoutMs?: number }} o
 * @returns {{ run(msg: object): Promise<void>, resend(): void, state(): { bound: boolean, window: number | null, projects: number, threads: number }, dispose(): void }}
 */
function createProjects(o) {
  const { appHost, send } = o;
  const debounceMs = o.debounceMs ?? 100;
  const opTimeoutMs = o.opTimeoutMs ?? OP_TIMEOUT_MS;
  const say = (level, m, d) => { try { (o.log?.[level] ?? o.log?.info)?.call(o.log, m, d); } catch { /* logging never breaks this module */ } };
  const message = (e) => String((e && e.message) || e).slice(0, 500);

  let bound = null;              // {winId, svc, store, offs}: the store reports come from
  let noted = false;             // why there is none was logged
  let resetNext = true;
  let sent = null;               // what the last report said: {available, projects (JSON), selected, threads (id -> facts JSON)}
  let timer = null;
  let disposed = false;

  function post(msg) {
    try { send(msg); return true; } catch (e) { say('error', 'projects: the report to the Host failed', { message: message(e) }); return false; }
  }
  function storeOf(host) {
    const svc = host && host.services && host.services.projects;
    const store = svc && svc.globalState;
    if (!svc || typeof svc.getLocalProjects !== 'function' || !store || typeof store.get !== 'function' || typeof store.onDidChange !== 'function') return null;
    return { svc, store };
  }
  function bind() {
    if (bound || disposed) return;
    const windows = appHost.windows();
    for (const w of windows) {
      const s = storeOf(w.host);
      if (!s) continue;
      const offs = [];
      try {
        for (const key of KEYS) { const off = s.store.onDidChange(key, schedule); if (typeof off === 'function') offs.push(off); }
      } catch (e) {
        for (const off of offs) { try { off(); } catch { /* already gone */ } }
        say('warn', 'projects: the app\'s project store refused a listener', { window: w.id, message: message(e) });
        continue;
      }
      bound = { winId: w.id, ...s, services: w.host.services, offs };
      resetNext = true;
      say('info', 'projects: holding the app\'s project store', { window: w.id });
      schedule();
      return;
    }
    if (windows.length && !noted) { noted = true; say('info', 'projects: no window has the projects service with its store; the app\'s projects are not reported'); }
  }
  function unbind() {
    if (!bound) return;
    for (const off of bound.offs) { try { off(); } catch { /* already gone */ } }
    bound = null;
  }
  const sub = appHost.subscribe((e) => {
    if (disposed) return;
    if (e.type === 'removed' && bound && bound.winId === e.id) { unbind(); bind(); if (!bound) schedule(); }
    else if (e.type === 'added' && !bound) bind();
  });

  function schedule() {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    if (timer.unref) timer.unref();
  }
  /** Report what changed (everything when `reset`). `force`: report even when nothing did (the Host asked). */
  function flush(force = false) {
    if (disposed) return;
    clearTimeout(timer); timer = null;
    if (!bound) {
      if (force || !sent || sent.available) { if (post({ type: 'projects', available: false })) sent = { available: false, projects: null, selected: null, threads: new Map() }; }
      return;
    }
    let projects, selected, threads;
    try { projects = projectsOf(bound.svc, bound.store); selected = selectedOf(bound.store); threads = threadFactsOf(bound.store); } catch (e) {
      say('warn', 'projects: reading the app\'s projects failed', { message: message(e) });
      return;
    }
    const reset = resetNext || !sent;
    const projectsKey = JSON.stringify(projects);
    const msg = { type: 'projects', available: true };
    if (reset || projectsKey !== sent.projects) msg.projects = projects;
    if (reset || selected !== sent.selected) msg.selected = selected;
    let changes = null;
    if (reset) changes = Object.fromEntries([...threads].map(([t, f]) => [t, JSON.parse(f)]));
    else {
      const d = {};
      let n = 0;
      for (const [t, f] of threads) if (sent.threads.get(t) !== f) { d[t] = JSON.parse(f); n += 1; }
      for (const t of sent.threads.keys()) if (!threads.has(t)) { d[t] = null; n += 1; }
      if (n) changes = d;
    }
    if (changes) msg.threads = changes;
    if (reset) msg.reset = true;
    if (!reset && !force && sent.available && !msg.projects && msg.selected === undefined && !changes) return;
    if (!post(msg)) return;   // not sent: the next report starts from the same baseline
    resetNext = false;
    sent = { available: true, projects: projectsKey, selected, threads };
  }

  function withTimeout(p, ms = opTimeoutMs) {
    let t = null;
    return Promise.race([
      Promise.resolve(p).finally(() => clearTimeout(t)),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`the app did not answer in ${ms} ms`)), ms); if (t.unref) t.unref(); }),
    ]);
  }
  /** A Host operation (`app-op`) on a project the app has, by its id; the answer follows the report of what it changed. */
  async function run(msg) {
    const requestId = msg && msg.requestId;
    if (!str(requestId, MAX_ID)) return;
    // `refused`: it was not tried (nothing changed); otherwise the app's own call failed.
    const answer = (fields) => post({ type: 'app-op-done', requestId, ...fields });
    const refuse = (error) => answer({ ok: false, error, refused: true });
    const { op, projectId } = msg;
    const changes = op === 'rename' || op === 'remove' || op === 'select' || op === 'move-thread';
    try {
      if (!bound) return void refuse('the app\'s projects are not available');
      if (op === 'navigate') {
        // One of a few app pages, opened the way the app's main opens them: `navigate-to-route` to the window.
        if (!ROUTES.has(msg.path)) return void refuse('the app cannot be sent to that page');
        if (typeof o.toView !== 'function') return void refuse('the app\'s pages cannot be reached');
        o.toView(bound.winId, { type: 'navigate-to-route', path: msg.path });
        return void answer({ ok: true });
      }
      if (op === 'add' && projectId == null) {
        // a folder added as a project, the app's own way ("Add new project"): its projects service, which asks the user to trust a new
        // folder in its own dialog (the call waits for the answer); the project then comes in the next report
        const svc = bound.services && bound.services.projects;
        if (!svc || typeof svc.createLocal !== 'function') return void refuse('the app cannot add a project here');
        const folder = str(msg.path, 4096) && path.isAbsolute(msg.path) ? path.resolve(msg.path) : null;
        if (!folder) return void refuse('an absolute folder path is needed');
        const name = str(msg.name, 200) && msg.name.trim() ? msg.name.trim() : path.basename(folder) || folder;
        const made = await withTimeout(svc.createLocal({ appearance: null, initializeDefaultWorkspaceGitRepository: false, name, sources: [folder], setActive: false }), ADD_TIMEOUT_MS);
        return void answer({ ok: true, result: { folder, id: typeof made?.id === 'string' ? made.id : typeof made?.projectId === 'string' ? made.projectId : null } });
      }
      if (op === 'move-thread') {
        // a chat into a project (`projectId`) or out of every project (none): the app's own membership write, as its "Move to project" and
        // its sidebar's drag do (the store tells every window and the app-server); the report of the moved chat goes before the answer
        const svc = bound.services && bound.services.threadProjectAssignments;
        if (!svc || typeof svc.setMembership !== 'function') return void refuse('the app cannot move a chat here');
        if (!str(msg.threadId, MAX_ID)) return void refuse('a thread id is needed');
        if (projectId != null) {
          const all = bound.svc.getLocalProjects();
          if (!str(projectId, MAX_ID) || !all || !Object.hasOwn(all, projectId)) return void refuse('the app has no such project');
        }
        await withTimeout(svc.setMembership({ threadId: msg.threadId, hostId: 'local', assignment: projectId == null ? null : { projectKind: 'local', projectId }, projectless: projectId == null }));
        flush();
        return void answer({ ok: true });
      }
      if (APP_OPS.has(op)) return void answer({ ok: true, result: op === 'apps' ? await readApps() : op === 'cloud-environments' ? await readCloudEnvironments() : op === 'pinned-threads' ? await readPinned() : await removeApproval(msg.bundleId) });
      // Agent.addSkill (public-hooks.md §3.16, H9b): a skill of the user's own in the Codex home's skills folder (no project named)
      if (op === 'add-skill' && projectId == null) return void answer({ ok: true, result: await createSkill(codexHome(), ['skills'], msg) });
      if (GLOBAL_OPS.has(op) && projectId == null) {
        const home = codexHome();
        if (op === 'instructions') return void answer({ ok: true, result: { home, files: await Promise.all(INSTRUCTION_FILES.map((n) => readLocalInstructions(path.join(home, n)))) } });
        const p = str(msg.path, 4096) && path.isAbsolute(msg.path) ? path.resolve(msg.path) : null;
        if (!p || path.dirname(p) !== home || !INSTRUCTION_FILES.includes(path.basename(p))) return void refuse('the path is not one of the global instructions files');
        if (op === 'open-instructions') return void answer({ ok: true, result: await openTab(p) });
        if (typeof msg.text !== 'string' || Buffer.byteLength(msg.text) > INSTRUCTIONS_MAX) return void refuse(`a text of at most ${INSTRUCTIONS_MAX} bytes is needed`);
        if (path.basename(p) === 'AGENTS.md') {
          const ai = bound.services && bound.services.agentInstructions;
          if (!ai || typeof ai.write !== 'function') return void refuse('the app\'s instructions service is not available');
          await withTimeout(own(ai, 'write', { hostId: 'local', contents: msg.text }));
        } else await saveInstructions(p, msg.text);
        return void answer({ ok: true });
      }
      if (!str(projectId, MAX_ID)) return void refuse('a project id is needed');
      const all = bound.svc.getLocalProjects();
      const project = all && Object.hasOwn(all, projectId) ? all[projectId] : null;
      if (!project) return void refuse('the app has no such project');
      let result;
      if (op === 'rename') {
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (!name || name.length > MAX_NAME) return void refuse(`a name of 1 to ${MAX_NAME} characters is needed`);
        await withTimeout(own(bound.svc, 'renameLocal', { projectId, name }));
      } else if (op === 'remove') {
        await withTimeout(own(bound.svc, 'removeLocal', projectId));
      } else if (op === 'select') {
        // The app's own selection (what opening the project's folder again does): `selected-project`, told to every window.
        const root = Array.isArray(project.rootPaths) ? project.rootPaths[0] : null;
        if (!str(root, 4096)) return void refuse('the project has no folder');
        if (typeof bound.svc.createOrSelectLocalProjects !== 'function') return void refuse('the app cannot select a project here');
        await withTimeout(bound.svc.createOrSelectLocalProjects([root]));
      } else if (op === 'reveal') {
        // The project's folder, or a path inside it.
        const at = msg.path === undefined ? rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null) : rootHolding(project, msg.path);
        if (!at) return void refuse(msg.path === undefined ? 'the project has no folder' : 'the path is not in the project');
        if (typeof o.revealPath !== 'function') return void refuse('revealing in Finder is not available');
        o.revealPath(at.abs);
      } else if (op === 'open') {
        const at = rootHolding(project, msg.path);
        if (!at) return void refuse('the path is not in the project');
        result = await openTab(at.abs);
      } else if (op === 'open-in') {
        const at = rootHolding(project, msg.path);
        if (!at) return void refuse('the path is not in the project');
        const openIn = bound.services && bound.services.openIn;
        if (!openIn || typeof openIn.open !== 'function') return void refuse('the app\'s "open in" is not available');
        if (!str(msg.target, 100)) return void refuse('a target is needed');
        const r = await withTimeout(openIn.open({ path: at.abs, cwd: at.root, target: msg.target, hostId: 'local' }));
        if (!r || r.success !== true) throw new Error(`the app could not open it in ${msg.target}`);
      } else if (op === 'worktree') {
        // A worktree of the project's repository (the same git common directory), wherever it is: its branch and its base.
        if (!str(msg.path, 4096) || !path.isAbsolute(msg.path)) return void refuse('an absolute path is needed');
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        result = await readWorktree(root.root, path.resolve(msg.path));
        if (result.foreign) return void refuse('the path is not a worktree of the project\'s repository');
      } else if (op === 'remove-worktree') {
        // One of the app's own worktrees of the project's repository, deleted as its Worktrees settings do (the Host archived its chats).
        if (!str(msg.path, 4096) || !path.isAbsolute(msg.path)) return void refuse('an absolute path is needed');
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        const dir = path.resolve(msg.path);
        const managed = worktreesRoot();
        if (!dir.startsWith(`${managed}${path.sep}`)) return void refuse('the folder is not one of the app\'s worktrees');
        const w = await readWorktree(root.root, dir);
        if (w.foreign) return void refuse('the path is not a worktree of the project\'s repository');
        if (!w.exists || w.root !== dir) return void refuse('there is no worktree there');
        const mw = bound.services && bound.services.managedWorktrees;
        if (!mw || typeof mw.delete !== 'function') return void refuse('the app\'s worktrees are not available');
        await withTimeout(mw.delete({ hostId: 'local', worktree: dir, reason: 'settings-delete-targeted' }));
      } else if (op === 'repository' || op === 'switch-branch' || op === 'create-branch' || op === 'push') {
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        if (op === 'repository') result = await readRepository(root.root);
        else {
          const repo = bound.services && bound.services.gitRepository;
          const fn = { 'switch-branch': 'checkoutBranch', 'create-branch': 'createBranch', push: 'push' }[op];
          if (!repo || typeof repo[fn] !== 'function') return void refuse('the app\'s git operations are not available');
          if (op !== 'push' && !str(msg.branch, 250)) return void refuse('a branch name is needed');
          const req = op === 'push' ? { cwd: root.root, hostId: 'local' } : op === 'create-branch' ? { cwd: root.root, branch: msg.branch, hostId: 'local', mode: 'worktree', failIfExists: true } : { cwd: root.root, branch: msg.branch, hostId: 'local' };
          if (op === 'push') {
            // A branch with no upstream is published as the app's push publishes it: HEAD to the branch of its name, set as upstream.
            const repo0 = await readRepository(root.root).catch(() => null);
            // a push that names its branch: the checkout's, read just now (only the current branch is pushed)
            if (msg.branch !== undefined && msg.branch !== null && (!repo0 || !repo0.git || repo0.branch !== msg.branch)) {
              return void refuse(`the checkout is on ${repo0 && repo0.branch ? repo0.branch : 'no branch'}, not ${String(msg.branch).slice(0, 250)}`);
            }
            if (repo0 && repo0.git && repo0.branch && !repo0.upstream) Object.assign(req, { refspec: `HEAD:refs/heads/${repo0.branch}`, setUpstream: true });
          }
          const source = { 'switch-branch': 'use_checkout_git_branch', 'create-branch': 'use_create_git_branch', push: 'use_git_push_mutation' }[op];
          const handle = own(repo, fn, req, source);
          try {
            const r = await withTimeout(handle.wait());
            if (!r || r.status !== 'success') throw new Error(r && (r.error || r.errorType) ? String(r.error || r.errorType) : 'git failed');
            result = { status: 'success' };
          } finally { try { handle[Symbol.dispose] && handle[Symbol.dispose](); } catch { /* settled */ } }
        }
      } else if (op === 'actions' || op === 'run-action') {
        // The project's actions, or one of them run (named by its config and index: the command is the config's, read again here).
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        const envs = bound.services && bound.services.localEnvironments;
        if (!envs || typeof envs.list !== 'function') return void refuse('the app\'s environments are not available');
        const actions = await readActions(envs, root.root);
        if (op === 'actions') result = actions;
        else {
          const cfg = actions.configs.find((c) => c.configPath === msg.path);
          const action = cfg && Number.isInteger(msg.index) ? cfg.actions[msg.index] : null;
          if (!action) return void refuse('the project has no such action');
          if (action.platform && action.platform !== process.platform) return void refuse(`the action runs on ${action.platform}, not on this Mac`);
          // In the thread's own folder when one is named (the project's, or a worktree of its repository), else in the project's.
          let cwd = root.root;
          if (msg.cwd !== undefined) {
            const at = rootHolding(project, msg.cwd);
            if (at) cwd = at.abs;
            else if (str(msg.cwd, 4096) && path.isAbsolute(msg.cwd) && (await readWorktree(root.root, path.resolve(msg.cwd))).exists) cwd = path.resolve(msg.cwd);
            else return void refuse('the folder is not in the project or one of its worktrees');
          }
          result = await runAction(cwd, action, str(msg.threadId, MAX_ID) ? msg.threadId : null);
        }
      } else if (op === 'working-changes') {
        // The repository's changes as the app's review shows them: its git worker's own patch (untracked files included), as text.
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        if (!['unstaged', 'staged', 'branch'].includes(msg.scope)) return void refuse('the changes are unstaged, staged or branch');
        const openIn = bound.services && bound.services.openIn;
        if (!openIn || typeof openIn.requestGitWorker !== 'function') return void refuse('the app\'s git worker is not available');
        const r = await withTimeout(openIn.requestGitWorker({ method: 'review-patch', params: { cwd: root.root, source: msg.scope, operationSource: 'git_direct_call' } }));
        const d = r && r.diff;
        if (!d || d.type !== 'success' || typeof d.unifiedDiff !== 'string') return void refuse(d && d.error && d.error.type === 'diff-too-large' ? 'the changes are too large to read' : 'the repository\'s changes could not be read');
        result = { diff: d.unifiedDiff };
      } else if (op === 'new-terminal') {
        // A terminal in the project's folder (or a folder in it), its tab beside a chat (Project.newTerminal).
        const at = rootHolding(project, msg.path === undefined ? (Array.isArray(project.rootPaths) ? project.rootPaths[0] : null) : msg.path);
        if (!at) return void refuse(msg.path === undefined ? 'the project has no folder' : 'the path is not in the project');
        const { sessionId } = await openTerminal(at.abs, project.name, str(msg.threadId, MAX_ID) ? msg.threadId : null, 'terminal');
        result = { sessionId };
      } else if (op === 'create-instructions') {
        // Project.addInstructions (H9b): its AGENTS.md made with this text only where nothing is at that path (created exclusively: a file
        // there, read or not, too large to read, or made a moment ago, is never written over)
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        if (typeof msg.text !== 'string' || !msg.text.trim() || Buffer.byteLength(msg.text) > INSTRUCTIONS_MAX) return void refuse(`a text of 1 to ${INSTRUCTIONS_MAX} bytes is needed`);
        const file = path.join(root.root, 'AGENTS.md');
        try { await fsp.writeFile(file, msg.text, { flag: 'wx' }); } catch (e) {
          if (e && e.code === 'EEXIST') return void refuse('the project has its instructions already: edit them');
          throw e;
        }
        result = { path: file };
      } else if (op === 'add-skill') {
        // Agent.addSkill in a project: its .codex/skills (where the app installs and deletes a project's skills)
        const root = rootHolding(project, Array.isArray(project.rootPaths) ? project.rootPaths[0] : null);
        if (!root) return void refuse('the project has no folder');
        result = await createSkill(root.root, ['.codex', 'skills'], msg);
      } else if (op === 'instructions' || op === 'edit-instructions') {
        // A folder's instructions files, or one of them edited; inside the project only.
        const at = rootHolding(project, msg.path);
        if (!at) return void refuse('the path is not in the project');
        const files = bound.services && bound.services.workspaceFiles;
        if (!files || typeof files.inspect !== 'function' || typeof files.read !== 'function') return void refuse('the app\'s file service is not available');
        if (op === 'instructions') result = { files: await Promise.all(INSTRUCTION_FILES.map((n) => readProjectInstructions(files, path.join(at.abs, n)))) };
        else {
          if (!INSTRUCTION_FILES.includes(path.basename(at.abs))) return void refuse('the path is not an instructions file');
          if (typeof msg.text !== 'string' || Buffer.byteLength(msg.text) > INSTRUCTIONS_MAX) return void refuse(`a text of at most ${INSTRUCTIONS_MAX} bytes is needed`);
          await saveInstructions(at.abs, msg.text);
        }
      } else if (op === 'list' || op === 'inspect') {
        const at = rootHolding(project, msg.path);
        if (!at) return void refuse('the path is not in the project');
        const files = bound.services && bound.services.workspaceFiles;
        if (!files || typeof files[op === 'list' ? 'listDirectory' : 'inspect'] !== 'function') return void refuse('the app\'s file service is not available');
        result = op === 'list' ? await listIn(files, at) : await inspect(files, at.abs);
      } else return void refuse(`unknown operation ${String(op).slice(0, 50)}`);
      if (changes) flush();
      answer({ ok: true, ...(result === undefined ? {} : { result }) });
    } catch (e) {
      if (changes) flush();
      answer({ ok: false, error: message(e), refused: e && e.refused === true });
    }
  }
  /** The app's "open in" targets that are installed (with each one's bundle id when it can be read) and the apps approved for computer use. */
  async function readApps() {
    const openIn = bound.services && bound.services.openIn;
    const settings = bound.services && bound.services.computerUseSettings;
    const targets = [];
    let preferred = null;
    if (openIn && typeof openIn.getTargets === 'function') {
      const r = await withTimeout(openIn.getTargets({ cwd: os.homedir(), hostId: 'local' }));
      preferred = r && str(r.preferredTarget, 100) ? r.preferredTarget : null;
      for (const x of Array.isArray(r && r.targets) ? r.targets : []) {
        if (!x || x.available !== true || x.hidden === true || !str(x.id, 100)) continue;
        targets.push({ id: x.id, label: str(x.label, 200) ? x.label : x.id, icon: str(x.icon, 500) ? x.icon : null, kind: str(x.kind, 50) ? x.kind : null, bundleId: await bundleOfTarget(openIn, x.id) });
      }
    }
    let approvals = null;
    if (settings && typeof settings.getAppApprovals === 'function') {
      const r = await withTimeout(settings.getAppApprovals());
      if (r && typeof r === 'object') {
        // 21477: {bundleIdentifier, displayName, iconDataURL, ...} per approved app (seen natively).
        const apps = (Array.isArray(r.approvedApps) ? r.approvedApps : []).map((a) => ({ ...a, id: a && (a.bundleIdentifier ?? a.bundleId) })).filter((a) => str(a.id, 300))
          .map((a) => ({ bundleId: a.id, name: str(a.displayName, 200) ? a.displayName : a.id, icon: str(a.iconDataURL, 65536) && a.iconDataURL.startsWith('data:image/') ? a.iconDataURL : null }));
        const listed = new Set(apps.map((a) => a.bundleId));
        for (const id of Array.isArray(r.approvedBundleIdentifiers) ? r.approvedBundleIdentifiers : []) if (str(id, 300) && !listed.has(id)) apps.push({ bundleId: id, name: id, icon: null });
        approvals = { apps };
      }
    }
    return { targets, preferred, approvals };
  }
  const bundles = new Map();   // target id -> bundle id or null (an installed target's executable rarely moves)
  async function bundleOfTarget(openIn, target) {
    if (Object.hasOwn(SYSTEM_TARGETS, target)) return SYSTEM_TARGETS[target];
    if (bundles.has(target)) return bundles.get(target);
    let id = null;
    try {
      const r = typeof openIn.requestOpenInWorker === 'function' ? await withTimeout(openIn.requestOpenInWorker({ method: 'get-target-command', params: { target } })) : null;
      const command = r && typeof r.command === 'string' ? r.command : '';
      const i = command.indexOf('.app/');
      if (i > 0) id = await plistBundleId(path.join(command.slice(0, i + 4), 'Contents', 'Info.plist'));
    } catch (e) { say('info', 'projects: an app\'s bundle could not be read', { target, message: message(e) }); }
    bundles.set(target, id);
    return id;
  }
  function plistBundleId(file) {
    return new Promise((resolve) => {
      execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', file], { timeout: 5000 }, (err, stdout) => {
        const v = String(stdout || '').trim();
        resolve(!err && /^[A-Za-z0-9.-]{1,200}$/.test(v) ? v : null);
      });
    });
  }
  /** The branch a new worktree was made from, as the app records it in the worktree's git directory (`codex-synced-branch.json`), or null. */
  async function syncedBranchOf(root) {
    try {
      const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(path.join(root, '.git'), 'utf8'));
      if (!m) return null;
      const rec = JSON.parse(await fsp.readFile(path.join(path.resolve(root, m[1].trim()), 'codex-synced-branch.json'), 'utf8'));
      const name = rec && typeof rec.branch === 'string' && rec.branch.startsWith('refs/heads/') ? rec.branch.slice('refs/heads/'.length) : null;
      return name && str(name, 250) ? name : null;
    } catch { return null; }
  }
  /** A worktree at `dir` of the repository the project folder `root` is in: `{exists: false}` when nothing is there, `{foreign: true}` when it is
   *  another repository's. */
  async function readWorktree(root, dir) {
    const openIn = bound.services && bound.services.openIn;
    if (!openIn || typeof openIn.requestGitWorker !== 'function') throw Object.assign(new Error('the app\'s git worker is not available'), { refused: true });
    const git = async (method, params) => { try { const r = await withTimeout(openIn.requestGitWorker({ method, params })); return r && typeof r === 'object' && !r.error ? r : null; } catch { return null; } };
    const [mine, theirs] = await Promise.all([git('stable-metadata', { cwd: root, operationSource: 'git_direct_call' }), git('stable-metadata', { cwd: dir, operationSource: 'git_direct_call' })]);
    if (!theirs || !str(theirs.root, 4096)) return { exists: false };
    if (!mine || mine.commonDir !== theirs.commonDir) return { foreign: true };
    if (theirs.root === mine.root) return { exists: false };   // the project's own checkout, not a worktree
    const [cur, meta, def, cfg, synced] = await Promise.all([git('current-branch', { root: theirs.root }), git('branch-metadata', { cwd: theirs.root }), git('default-branch', { root: mine.root }),
      git('config-value', { root: theirs.root, key: 'codex.localEnvironmentConfigPath', scope: 'worktree' }), syncedBranchOf(theirs.root)]);
    return {
      exists: true, root: theirs.root, branch: cur && str(cur.branch, 250) ? cur.branch : null,
      // its base: the branch the app made the worktree from (its record, E8.3g), else its branch's base, else the default branch
      base: synced ?? (meta && str(meta.baseBranch, 250) ? meta.baseBranch : def && str(def.branch, 250) ? def.branch : null),
      setup: await setupOf(cfg && str(cfg.value, 4096) && path.isAbsolute(cfg.value) ? cfg.value : null),
    };
  }
  /** The setup script of the environment config a worktree was made with (the app records its path in the worktree's git config,
   *  `codex.localEnvironmentConfigPath`, `__none__` for none), this Mac's own when the config has one; null when there is none. */
  async function setupOf(configPath) {
    const envs = bound.services && bound.services.localEnvironments;
    if (!configPath || !envs || typeof envs.read !== 'function') return null;
    try {
      const r = await withTimeout(envs.read({ configPath, hostId: 'local' }));
      const setup = r && r.environment && r.environment.type === 'success' && r.environment.environment ? r.environment.environment.setup : null;
      const script = setup && setup.darwin && typeof setup.darwin.script === 'string' ? setup.darwin.script : setup && typeof setup.script === 'string' ? setup.script : '';
      return script.trim() ? script : null;
    } catch { return null; }
  }
  /** A project folder's repository, as the app reads it: `{git: false}` when it is not in one. */
  async function readRepository(root) {
    const openIn = bound.services && bound.services.openIn;
    const origins = bound.services && bound.services.repositoryOrigins;
    if (!openIn || typeof openIn.requestGitWorker !== 'function') throw Object.assign(new Error('the app\'s git worker is not available'), { refused: true });
    const git = async (method, params) => { try { const r = await withTimeout(openIn.requestGitWorker({ method, params })); return r && typeof r === 'object' && !r.error ? r : null; } catch { return null; } };
    let origin = null;
    if (origins && typeof origins.read === 'function') {
      const o = await withTimeout(origins.read({ dirs: [root], hostId: 'local' }, 'git_direct_call'));
      origin = (Array.isArray(o && o.origins) ? o.origins : []).find((x) => x && str(x.root, 4096)) ?? null;
    }
    const meta = origin ? null : await git('stable-metadata', { cwd: root, operationSource: 'git_direct_call' });
    const repoRoot = origin ? origin.root : meta && str(meta.root, 4096) ? meta.root : null;
    if (!repoRoot) return { git: false };
    const [cur, status, upstream, ahead, recent, def, staged] = await Promise.all([
      git('current-branch', { root: repoRoot }), git('status-summary', { cwd: repoRoot }), git('upstream-branch', { root: repoRoot }),
      git('branch-ahead-count', { root: repoRoot }), git('recent-branches', { root: repoRoot, limit: 100 }), git('default-branch', { root: repoRoot }),
      git('review-summary', { cwd: repoRoot, source: 'staged', operationSource: 'git_direct_call' }),
    ]);
    const counts = status && status.type === 'success' ? { staged: status.stagedCount ?? 0, unstaged: status.unstagedCount ?? 0, untracked: status.untrackedCount ?? 0 } : null;
    return {
      git: true, root: repoRoot, origin: origin && str(origin.originUrl, 4096) ? origin.originUrl : null,
      branch: cur && str(cur.branch, 250) ? cur.branch : null, detached: cur ? cur.isDetached === true : false, status: counts,
      upstream: upstream && upstream.upstream && str(upstream.upstream.branch, 250) ? upstream.upstream.branch : null,
      ahead: ahead && Number.isFinite(ahead.commitsAhead) ? ahead.commitsAhead : null,
      branches: (Array.isArray(recent && recent.branches) ? recent.branches : []).filter((b) => str(b, 250)).slice(0, 100),
      defaultBranch: def && str(def.branch, 250) ? def.branch : null,
      staged: staged && staged.type === 'success' && Array.isArray(staged.files) ? staged.files.filter((f) => f && str(f.path, 4096)).map((f) => path.join(repoRoot, f.path)) : [],
    };
  }
  /** The signed-in account's cloud environments (the account's own and its workspace's), as the app lists them. */
  async function readCloudEnvironments() {
    const accounts = bound.services && bound.services.accountInfo;
    const configs = bound.services && bound.services.environmentConfigs;
    if (!accounts || typeof accounts.readAccountInfo !== 'function' || !configs || typeof configs.list !== 'function') throw Object.assign(new Error('the app\'s cloud environments are not available'), { refused: true });
    const info = await withTimeout(accounts.readAccountInfo());
    const d = info && info.status === 'ready' && info.data && typeof info.data === 'object' ? info.data : null;
    if (!d || !str(d.accountId, 200) || !str(d.userId, 200)) return { signedIn: false, environments: [] };
    const out = new Map();
    for (const scope of ['user', 'workspace']) {
      let cursor = null, pages = 0;
      do {
        const r = await withTimeout(configs.list({ accountId: d.accountId, userId: d.userId, scope, limit: 100, ...(cursor ? { cursor } : {}) }));
        if (!r || r.ok !== true || !r.page) break;
        for (const c of Array.isArray(r.page.data) ? r.page.data : []) {
          if (!c || !str(c.id, 500) || out.has(c.id)) continue;
          out.set(c.id, {
            id: c.id, name: str(c.name, 200) ? c.name : c.id, status: str(c.status, 50) ? c.status : null,
            repositories: (Array.isArray(c.repositories) ? c.repositories : []).map((x) => x && x.repositoryId).filter((x) => str(x, 200)),
            setupThreadId: str(c.threadId, 200) ? c.threadId : null, shared: str(c.shareSettings, 50) ? c.shareSettings : null,
          });
        }
        cursor = str(r.page.nextCursor, 1000) ? r.page.nextCursor : null;
      } while (cursor && ++pages < 10);
    }
    return { signedIn: true, environments: [...out.values()] };
  }
  /** Take back an app's computer-use approval (always -> ask), the app's own way. */
  async function removeApproval(bundleId) {
    const settings = bound.services && bound.services.computerUseSettings;
    if (!str(bundleId, 300)) throw Object.assign(new Error('a bundle id is needed'), { refused: true });
    if (!settings || typeof settings.removeAppApproval !== 'function') throw Object.assign(new Error('the app\'s computer-use settings are not available'), { refused: true });
    const r = await withTimeout(settings.removeAppApproval(bundleId));
    return { approved: Array.isArray(r && r.approvedBundleIdentifiers) ? r.approvedBundleIdentifiers.includes(bundleId) : null };
  }
  /** A folder's entries, as the app's file tree lists them, by absolute path. */
  async function listIn(files, at) {
    const directoryPath = path.relative(at.root, at.abs).split(path.sep).join('/');
    const r = await withTimeout(files.listDirectory({ hostId: 'local', workspaceRoot: at.root, directoryPath, directoriesOnly: false, includeHidden: false }));
    const entries = [];
    for (const e of Array.isArray(r && r.entries) ? r.entries : []) {
      if (!e || !str(e.name, 1000) || typeof e.path !== 'string' || (e.type !== 'file' && e.type !== 'directory')) continue;
      entries.push({ name: e.name, path: path.join(at.root, ...e.path.split('/')), type: e.type, isSymlink: e.isSymlink === true });
      if (entries.length >= LIST_MAX) break;
    }
    return { entries, truncated: Array.isArray(r && r.entries) && r.entries.length > entries.length };
  }
  /** A file's size, modification time and content kind, as the app reads them; `{missing: true}` when there is nothing there. */
  const refusal = (m) => Object.assign(new Error(m), { refused: true });
  /** A file tab beside the thread the window shows: the app's own action `windows.tabs.open` (it refuses while no thread is shown). */
  async function openTab(abs) {
    const actions = bound.services && bound.services.appActions;
    if (!actions || typeof actions.runInPrimaryWindow !== 'function') throw refusal('the app\'s actions are not available');
    try {
      const r = await withTimeout(actions.runInPrimaryWindow({ action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: abs } } }));
      return { status: r && typeof r.status === 'string' ? r.status : null, viewer: r && typeof r.viewer === 'string' ? r.viewer : null };
    } catch (e) {
      if (/requires a visible thread/.test(String(e && e.message))) throw refusal('the app shows a file beside a thread, and no thread is open');
      throw e;
    }
  }
  /** Where the app makes its worktrees: the Worktrees setting (`git-worktree-root`), else `<Codex home>/worktrees`. */
  function worktreesRoot() {
    let set = null;
    try { set = bound.store.get('git-worktree-root'); } catch { /* the default */ }
    return path.resolve(str(set, 4096) && path.isAbsolute(set) ? set : path.join(codexHome(), 'worktrees'));
  }
  /** The threads the user pinned (the app's `pinnedThreads.list`), as the app's own pinned query asks: its server pins, and without
   *  changing the service's pin source, which its worktree cleanup and auto-archive read (breadth.md D5: a list without
   *  `preservePinSource` switches them to the legacy list until the app's next query). */
  async function readPinned() {
    const pins = bound.services && bound.services.pinnedThreads;
    if (!pins || typeof pins.list !== 'function') throw refusal('the app\'s pinned chats are not available');
    const r = await withTimeout(pins.list({ hostId: 'local', useAppServerPins: true, preservePinSource: true }));
    return { threadIds: (Array.isArray(r && r.threadIds) ? r.threadIds : []).filter((x) => str(x, MAX_ID)) };
  }
  /** The Codex home the app uses on this Mac (its rule for the local host). */
  function codexHome() {
    const h = typeof o.codexHome === 'function' ? o.codexHome() : process.env.CODEX_HOME;
    return path.resolve(str(h, 4096) ? h : path.join(os.homedir(), '.codex'));
  }
  /** A global instructions file, read without the app (whose read creates one): `{path, exists, text?, modifiedAt?, tooLarge?}`. */
  async function readLocalInstructions(p) {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) return { path: p, exists: false };
      if (st.size > INSTRUCTIONS_MAX) return { path: p, exists: true, tooLarge: true, modifiedAt: Math.round(st.mtimeMs) };
      return { path: p, exists: true, text: await fsp.readFile(p, 'utf8'), modifiedAt: Math.round(st.mtimeMs) };
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { path: p, exists: false };
      throw e;
    }
  }
  /** A project's instructions file, through the app's `workspaceFiles`. */
  async function readProjectInstructions(files, p) {
    const meta = await inspect(files, p);
    if (meta.missing || !meta.isFile) return { path: p, exists: false };
    if (meta.size !== null && meta.size > INSTRUCTIONS_MAX) return { path: p, exists: true, tooLarge: true, modifiedAt: meta.modifiedAt };
    const r = await withTimeout(files.read({ hostId: 'local', path: p, representation: 'text', maxBytes: INSTRUCTIONS_MAX }));
    return { path: p, exists: true, text: r && typeof r.text === 'string' ? r.text : '', modifiedAt: meta.modifiedAt };
  }
  /** Save an instructions file through the app's `workspaceFiles.saveText`, against the modification time it has now. */
  /**
   * A new skill's folder and SKILL.md under `anchor` (the Codex home, or a project's root) + `parts` (its skills folder), each made
   * exclusively: the skills folder and the ones on its way may be made, but none of them may be a link (the skill would land elsewhere),
   * the skill's own folder must not be there (a second add of one name fails, never writes over), and SKILL.md is created, never replaced.
   */
  async function createSkill(anchor, parts, msg) {
    if (!str(msg.name, 64) || !SKILL_NAME.test(msg.name)) throw refusal('a skill\'s name is lowercase letters, digits and single hyphens (at most 64)');
    if (typeof msg.text !== 'string' || !msg.text.trim() || Buffer.byteLength(msg.text) > INSTRUCTIONS_MAX) throw refusal(`a SKILL.md of 1 to ${INSTRUCTIONS_MAX} bytes is needed`);
    if (!str(anchor, 4096) || !path.isAbsolute(anchor)) throw refusal('the folder is not known');
    let dir = path.resolve(anchor);
    for (const part of parts) {
      dir = path.join(dir, part);
      try { await fsp.mkdir(dir); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      const st = await fsp.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw refusal(`${dir} is not a folder of its own (a link or a file)`);
    }
    const skillDir = path.join(dir, msg.name);
    try { await fsp.mkdir(skillDir); } catch (e) {
      if (e && e.code === 'EEXIST') throw refusal(`a skill named ${msg.name} is there already`);
      throw e;
    }
    const file = path.join(skillDir, 'SKILL.md');
    await fsp.writeFile(file, msg.text, { flag: 'wx' });
    return { path: file };
  }
  async function saveInstructions(p, text) {
    const files = bound.services && bound.services.workspaceFiles;
    if (!files || typeof files.saveText !== 'function' || typeof files.inspect !== 'function') throw refusal('the app\'s file service is not available');
    let mtime = null;
    try {
      const r = await withTimeout(files.inspect({ hostId: 'local', path: p }));
      if (r && r.isFile === false) throw refusal('the path is a folder');
      mtime = r && Number.isFinite(r.mtimeMs) ? r.mtimeMs : null;
    } catch (e) {
      if (e && e.refused) throw e;
      if (!(e && (e.code === 'ENOENT' || /^ENOENT\b/.test(String(e.message))))) throw e;
    }
    const r = await withTimeout(own(files, 'saveText', { content: text, expectedMtimeMs: mtime, hostId: 'local', path: p }));
    if (!r || r.outcome !== 'saved') throw new Error('the file changed while it was saved; nothing was written');
  }
  /** A project folder's environment configs with their actions, and the one the app selected for it (`selected`: a config path, or null). */
  async function readActions(envs, root) {
    const r = await withTimeout(envs.list({ hostId: 'local', workspaceRoot: root }));
    const configs = [];
    for (const e of Array.isArray(r && r.environments) ? r.environments : []) {
      if (!e || e.type !== 'success' || !e.environment || !str(e.configPath, 4096)) continue;
      const env = e.environment;
      const actions = (Array.isArray(env.actions) ? env.actions : []).filter((a) => a && str(a.name, 200) && str(a.command, 10_000))
        .map((a) => ({ name: a.name.trim(), icon: str(a.icon, 50) ? a.icon : null, command: a.command, platform: str(a.platform, 20) ? a.platform : null }));
      configs.push({ configPath: e.configPath, name: str(env.name, 200) ? env.name : path.basename(e.configPath, '.toml'), actions });
    }
    let selected = configs.length ? configs[0].configPath : null;
    try {
      const atoms = bound.store.get('electron-persisted-atom-state');
      const sel = atoms && typeof atoms === 'object' ? atoms['local-env-selections-by-workspace'] : null;
      const key = sel && typeof sel === 'object' ? Object.keys(sel).find((k) => k.startsWith('local:') && path.resolve(k.slice(6)) === path.resolve(root)) : undefined;
      if (key !== undefined) selected = str(sel[key], 4096) && configs.some((c) => c.configPath === sel[key]) ? sel[key] : null;
    } catch { /* no selection read: the default */ }
    return { selected, configs };
  }
  let actionSeq = 0;
  /** Run an action the app's way: a terminal session in `cwd` (the window's `terminal`), its tab shown in the thread's panel
   *  (`windows.tabs.open`: the thread shown, or `threadId`), then its command run in it. Without a thread to show it, nothing runs. */
  /** A terminal session in `cwd`, its tab in the panel of the chat named (else the one the window shows), the app's own way. */
  async function openTerminal(cwd, title, threadId, kind) {
    const terminal = bound.services && bound.services.terminal;
    const actions = bound.services && bound.services.appActions;
    if (!terminal || typeof terminal.create !== 'function' || (kind === 'action' && typeof terminal.runAction !== 'function')) throw refusal('the app\'s terminals are not available');
    if (!actions || typeof actions.runInPrimaryWindow !== 'function') throw refusal('the app\'s actions are not available');
    const sessionId = `codexmods-${kind}-${process.pid}-${++actionSeq}-${Date.now().toString(36)}`;
    await withTimeout(terminal.create({ sessionId, cwd, hostId: 'local', conversationTitle: title, ...(threadId ? { conversationId: threadId } : {}) }));
    try {
      await withTimeout(actions.runInPrimaryWindow({ action: { type: 'windows.tabs.open', windowId: 'current', ...(threadId ? { threadId } : {}), target: { type: 'terminal', sessionId }, placement: 'bottom' } }));
    } catch (e) {
      try { terminal.close(sessionId); } catch { /* gone already */ }
      if (/requires a visible thread/.test(String(e && e.message))) throw refusal('the app opens a terminal in a thread\'s panel, and no thread is open');
      throw e;
    }
    return { terminal, sessionId };
  }
  async function runAction(cwd, action, threadId) {
    const { terminal, sessionId } = await openTerminal(cwd, action.name, threadId, 'action');
    terminal.runAction(sessionId, cwd, action.command);
    return { sessionId };
  }
  async function inspect(files, abs) {
    let r;
    try { r = await withTimeout(files.inspect({ hostId: 'local', path: abs, contentSampleByteLimit: SAMPLE_BYTES, contentSampleMaxFileBytes: SAMPLE_MAX_FILE })); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || /^ENOENT\b/.test(String(e.message)))) return { missing: true };
      throw e;
    }
    const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    return { isFile: r && r.isFile === true, size: num(r && r.sizeBytes), modifiedAt: num(r && r.mtimeMs), kind: r && typeof r.contentKind === 'string' ? r.contentKind : null };
  }

  bind();
  return {
    run,
    /** The Host (re)started: it knows nothing yet. */
    resend() { resetNext = true; flush(true); },
    state: () => ({ bound: bound !== null, window: bound ? bound.winId : null, projects: sent && sent.projects ? JSON.parse(sent.projects).length : 0, threads: sent ? sent.threads.size : 0 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      sub.dispose();
      clearTimeout(timer);
      unbind();
    },
  };
}

/** framework-main module entry (contracts/main-hooks.d.ts): must not throw. */
function register(hooks) {
  try {
    if (!hooks.appHost) { hooks.log.info('projects: no AppHost hold; the app\'s projects are not reported'); return; }
    const electron = hooks.electron;
    const pr = createProjects({
      appHost: hooks.appHost, send: hooks.sendToHost, log: hooks.log,
      revealPath: electron && typeof electron.revealPath === 'function' ? (p) => electron.revealPath(p) : null,
      toView: electron && typeof electron.postToWindow === 'function' ? (id, msg) => electron.postToWindow(id, VIEW_CHANNEL, msg) : null,
    });
    hooks.onHostMessage('app-op', (msg) => { pr.run(msg); });
    hooks.onHostMessage('ready', () => pr.resend());
  } catch (e) {
    try { hooks.log.error('projects register failed', { message: String((e && e.message) || e) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, createProjects, KEYS };
