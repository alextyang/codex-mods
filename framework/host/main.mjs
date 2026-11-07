// Framework Host composition root (contracts/host.d.ts startHost; ARCHITECTURE.md 4, 12.4-12.6).
// Runs in a child process on the app's bundled Node (IPC to framework-main) or plain Node (headless tests), both via entry-node.mjs.
import { createPolicy } from './graph/policy.mjs';
import { internalMods } from './internal-mods.mjs';
import { createModActivity, activityLineOf } from './mod-activity.mjs';
import { createPermissionGate, asksOf } from './permissions.mjs';
import { createGitHub } from './github.mjs';
import { createModUpdates, CHECK_EVERY_MS } from './mod-updates.mjs';
import { createAbort } from './graph/abort.mjs';
import { createHeldActions, outcomeOf as heldOutcome } from './graph/held-actions.mjs';
import { decideUserHold, menuEntryHold } from './user-hold.mjs';
import { join, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SOCKETS, FLAGS } from '../../contracts/layout.mjs';
import { CodexModsError } from '../../sdk/errors.mjs';
import { readJson, writeJsonAtomic } from './fsutil.mjs';
import { fileURLToPath } from 'node:url';
import { createFeatureState, loadLog } from './features/evidence.mjs';
import { createReleaseSource } from './updates/release.mjs';
import { createStaging } from './updates/staging.mjs';
import { createDetector, createUpdateState } from './updates/detector.mjs';
import { liveOfProbe } from './features/status.mjs';
import { createLog } from './log.mjs';
import { listenUnix } from './sockets.mjs';
import { createProvidedAutomations } from './provided-automations.mjs';
import { createAgentGiven } from './agent/given.mjs';
import { createAddedAccounts } from './added-accounts.mjs';

/** `ps` with environments: one line per process of this user, "<pid> <command and arguments> <ENV=...>". */
// The app's own actions the framework can hold before their first effect (docs/design/public-hooks.md §3.5): framework-main's (the app's
// notifications, the user's setting changes) and the page's (a new chat's send, a card's answers), as `[concept, operation]`.
const APP_HELD = Object.freeze([['App', 'notify'], ['Setting', 'set'], ['Draft', 'send'], ['Approval', 'answer'], ['Question', 'answer'],
  // H6h (framework/main/user-actions.cjs, read-state.cjs): the user's own pins, marks read and automations
  ['Thread', 'pin'], ['Thread', 'unpin'], ['Thread', 'markRead'], ['Thread', 'automate'], ['Project', 'newAutomation'], ['Agent', 'newAutomation'],
  ['Automation', 'edit'], ['Automation', 'enable'], ['Automation', 'disable'], ['Automation', 'runNow'], ['Automation', 'delete'],
  // H6m2 (framework/main/user-actions.cjs): the user's projects renamed and removed, pushes and branches, skills installed and removed,
  // instructions saved
  ['Project', 'rename'], ['Project', 'remove'], ['Repository', 'push'], ['Repository', 'createBranch'], ['Repository', 'switchBranch'],
  ['Skill', 'install'], ['Skill', 'delete'], ['Instructions', 'edit'],
  // H6m2b: the user's commits (the git worker's requests) and pull requests merged
  ['Repository', 'commit'], ['PullRequest', 'merge'],
  // H6m3b (framework/main/areas/menus.cjs): the user's click on one of the app's menu bar entries, the command it names
  ['Command', 'run']]);
/** H6h's holds in framework-main (and H6m's in the page, H6m3-H6m4), by concept: reflection (I11) says these pass interceptors from any origin on
 *  Codex's own instances (the user's pin is observed, not held: framework/main/user-actions.cjs). */
const MAIN_HELD = Object.freeze({ Thread: ['unpin', 'markRead', 'automate'], Project: ['newAutomation', 'rename', 'remove'], Agent: ['newAutomation'],
  Automation: ['edit', 'enable', 'disable', 'runNow', 'delete'], Repository: ['push', 'createBranch', 'switchBranch', 'commit', 'stage', 'unstage', 'discard'], Skill: ['install', 'delete'],
  Instructions: ['edit'], PullRequest: ['merge'], Command: ['run'], Branch: ['openPullRequest'] });

const defaultPs = (uid) => new Promise((resolve, reject) => {
  execFile('/bin/ps', ['eww', '-o', 'pid=,command=', '-U', String(uid)], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Pulls the markers out of a `ps eww` line; null unless BOTH CODEX_MODS_RUN_DIR and CODEX_MODS_BOOT are present. The run dir may contain spaces. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s(.*)$/.exec(line);
  if (!m) return null;
  const boot = /(?:^|\s)CODEX_MODS_BOOT=([0-9a-f]+)(?=\s|$)/.exec(m[2]);
  const run = /(?:^|\s)CODEX_MODS_RUN_DIR=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/.exec(m[2]);
  if (!boot || !run) return null;
  return { pid: Number(m[1]), boot: boot[1], runDir: run[1], line: line.trim() };
}

/**
 * ARCHITECTURE 12.5 leftovers (contracts/ipc.d.ts section 5): processes of this user carrying this profile's CODEX_MODS_RUN_DIR and a
 * CODEX_MODS_BOOT different from the current Host start's. Each is re-checked (same pid, same line, markers still match) before
 * SIGTERM. Never touches a process without both markers, this process, or its parent. Never throws.
 * @returns {Promise<{ found: {pid:number}[], signalled: number[] }>}
 */
/** relay-<pid>.fifo files left in the run dir by relays that were killed (SIGKILL skips their cleanup): removed when the pid is gone. */
export function sweepRelayFifos(runDir, alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }) {
  const removed = [];
  try {
    for (const name of readdirSync(runDir)) {
      const m = /^relay-(\d+)\.fifo$/.exec(name);
      if (!m || alive(Number(m[1]))) continue;
      try { unlinkSync(join(runDir, name)); removed.push(name); } catch { /* raced */ }
    }
  } catch { /* no run dir yet */ }
  return removed;
}

export async function cleanupLeftovers({ currentBoot, runDir, uid = process.getuid?.(), ps = defaultPs, kill = process.kill.bind(process), log }) {
  const out = { found: [], signalled: [] };
  try {
    const mine = (parsed) => parsed && parsed.runDir === runDir && parsed.boot !== currentBoot && parsed.pid !== process.pid && parsed.pid !== process.ppid;
    const scan = async () => new Map((await ps(uid)).split('\n').map(parsePsLine).filter(mine).map((p) => [p.pid, p]));
    const first = await scan();
    out.found = [...first.values()].map((p) => ({ pid: p.pid }));
    if (!first.size) return out;
    const second = await scan();                       // identity check: still the same process with the same environment
    for (const [pid, p] of first) {
      const again = second.get(pid);
      if (!again || again.line !== p.line) { log?.info('leftover changed identity; not signalled', { pid }); continue; }
      try { kill(pid, 'SIGTERM'); out.signalled.push(pid); } catch (e) { log?.warn('could not signal leftover', { pid, message: String(e?.message ?? e) }); }
    }
  } catch (e) { log?.warn('leftover scan failed', { message: String(e?.message ?? e) }); }
  return out;
}


/**
 * The other modules' factories live at their contract paths and are imported lazily, so a test that overrides all of them
 * (`opts.factories`, test-only and undocumented to mods) never touches a module that is not merged yet.
 */
async function resolveFactories(overrides = {}) {
  const pick = async (name, loader) => overrides[name] ?? (await loader())[name];
  return {
    createBus: await pick('createBus', () => import('./runtime/bus.mjs')),
    createMux: await pick('createMux', () => import('./mux/index.mjs')),
    createRuntime: await pick('createRuntime', () => import('./runtime/index.mjs')),
    createPackages: await pick('createPackages', () => import('./packages/index.mjs')),
    createOperations: await pick('createOperations', () => import('./ops/index.mjs')),
    createRecovery: await pick('createRecovery', () => import('./recovery/index.mjs')),
    stockAppConflict: await pick('stockAppConflict', () => import('./recovery/index.mjs')),
    createManagement: await pick('createManagement', () => import('./management/index.mjs')),
    // The graph runtime (C2), started only with the `graph` flag; imported only then.
    openJournal: overrides.openJournal ?? (async (...a) => (await import('./graph/journal.mjs')).openJournal(...a)),
    createGraph: overrides.createGraph ?? (async (...a) => (await import('./graph/index.mjs')).createGraph(...a)),
    createCodexSource: overrides.createCodexSource ?? (async (...a) => (await import('./graph/providers/codex/index.mjs')).createCodexSource(...a)),
    createAppOps: overrides.createAppOps ?? (async (...a) => (await import('./graph/app-ops.mjs')).createAppOps(...a)),
    createReadState: overrides.createReadState ?? (async (...a) => (await import('./graph/read-state.mjs')).createReadState(...a)),
    createAppProjects: overrides.createAppProjects ?? (async (...a) => (await import('./graph/app-projects.mjs')).createAppProjects(...a)),
    createAppState: overrides.createAppState ?? (async (...a) => (await import('./graph/app-state.mjs')).createAppState(...a)),
    createMainOps: overrides.createMainOps ?? (async (...a) => (await import('./graph/main-ops.mjs')).createMainOps(...a)),
    createApprovals: overrides.createApprovals ?? (async (...a) => (await import('./graph/approvals.mjs')).createApprovals(...a)),
    nativeTypes: overrides.nativeTypes ?? (async () => {
      const [{ NATIVE_TYPES }, { toDescriptor }] = await Promise.all([import('../../sdk/graph/native/index.mjs'), import('../../sdk/graph/define.mjs')]);
      return NATIVE_TYPES.map(toDescriptor);
    }),
    frameworkTypes: overrides.frameworkTypes ?? (async () => {
      const [{ FRAMEWORK_TYPES }, { toDescriptor }] = await Promise.all([import('../../sdk/graph/framework.mjs'), import('../../sdk/graph/define.mjs')]);
      return FRAMEWORK_TYPES.map(toDescriptor);
    }),
    createAddedAccounts: overrides.createAddedAccounts ?? createAddedAccounts,
    createFrameworkSource: overrides.createFrameworkSource ?? (async (...a) => (await import('./graph/providers/framework/index.mjs')).createFrameworkSource(...a)),
    presentationTypes: overrides.presentationTypes ?? (async () => {
      const [{ PRESENTATION_TYPES }, { toDescriptor }] = await Promise.all([import('../../sdk/graph/presentations.mjs'), import('../../sdk/graph/define.mjs')]);
      return PRESENTATION_TYPES.map(toDescriptor);
    }),
    createWindowsSource: overrides.createWindowsSource ?? (async (...a) => (await import('./graph/providers/windows/index.mjs')).createWindowsSource(...a)),
  };
}

/** @param {import('../../contracts/host.d.ts').HostStartOptions & { factories?: object }} opts */
export async function startHost(opts) {
  const { layout, profile, adapterDir, realCodexPath, frameworkVersion, appBuild, safeMode, parent, runningAppPath } = opts;
  /** Closers run in reverse order of registration: close() reverses startup. */
  const closers = [];
  const addCloser = (name, fn) => closers.push({ name, fn });
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      while (closers.length) {
        const { name, fn } = closers.pop();
        try { await fn(); } catch (e) { log?.error('close step failed', { step: name, message: String(e?.message ?? e) }); }
      }
    })();
    return closing;
  };
  let log;

  try {
    // ---- 1. log
    for (const dir of [layout.logs, layout.run, layout.flags]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepRelayFifos(layout.run);
    const fileLog = createLog({ file: join(layout.logs, 'host.log'), level: process.env.CODEX_MODS_LOG_LEVEL || 'info' });
    log = fileLog;
    addCloser('log', () => fileLog.close());
    // One random id per Host start, inherited by every child the Host spawns (mux backends, mod processes): leftovers are the
    // processes of this profile that carry a different one.
    const bootId = randomBytes(8).toString('hex');
    process.env.CODEX_MODS_BOOT = bootId;
    log.info('host starting', { frameworkVersion, appBuild, safeMode, headless: !parent });

    const f = await resolveFactories(opts.factories);

    // ---- 2. bus
    const bus = f.createBus({ log: log.child('bus') });
    // What each mod did, for its Activity tab (docs/design/framework-ui.md F9): the framework's own lines beside what ctx.log writes
    const activity = createModActivity({ dir: layout.logs, log: log.child('activity') });
    bus.subscribe('framework/op', (op) => { const line = activityLineOf(op); const id = op?.input?.modId ?? op?.result?.modId; if (line && id) void activity.note(id, ...line); });
    bus.subscribe('framework/fault', (e) => { if (e?.modId) void activity.note(e.modId, 'error', `${e.message} (${e.where ?? `${e.realm}, ${e.kind}`})`); });
    // the runtime says so when it stops one, and the operations when they record it: one line
    const stopSaid = new Map();
    bus.subscribe('framework/quarantine', (e) => {
      if (!e?.modId) return;
      const was = stopSaid.get(e.modId);
      if (was && was.reason === e.reason && Date.now() - was.at < 5000) return;
      stopSaid.set(e.modId, { reason: e.reason, at: Date.now() });
      void activity.note(e.modId, 'error', `Stopped: ${e.reason}`);
    });

    // ---- 3. adapter
    // adapterDir is the directory of the file framework-main used: Contents/Resources (codexmods-adapter.json, embedded by the
    // builder) or the root's adapters/<build>/ (adapter.json).
    const adapter = (await readJson(join(adapterDir, 'codexmods-adapter.json'))) ?? (await readJson(join(adapterDir, 'adapter.json')));
    if (!adapter) throw new CodexModsError('Unavailable', `Adapter pack not found: ${adapterDir}`);

    // ---- 3b. the feature log and this build's evidence (docs/design/systems.md "E4 in detail"), followed as the windows report what they
    // saw (subscribed before management, which answers compatibility from it on the same report)
    const tree = fileURLToPath(new URL('../../', import.meta.url));
    const features = await createFeatureState({ log: await loadLog(), pack: adapter, dirs: [join(tree, 'adapters'), layout.adapters].filter(Boolean),
      addresses: await readJson(join(tree, 'framework', 'renderer', 'present', 'addresses.json')) });
    if (!features.log) log.warn('the feature log is missing: compatibility reads the pack alone');
    bus.subscribe('framework/probe', (p) => features.setLive(liveOfProbe(p)));


    /** Window.open's ask of a window's page (S11), once the runtime is there. */
    let showDetailIn = () => false;
    const post = (msg) => { try { parent?.post(msg); } catch (e) { log.warn('post to framework-main failed', { type: msg.type, message: String(e?.message ?? e) }); } };
    // What the sources ask framework-main through: none when headless, so they refuse at once instead of waiting for an answer that never comes.
    const toMain = parent ? post : undefined;
    let generation = 0;
    /** @type {import('../../contracts/host.d.ts').Operations | undefined} */
    let operations;

    // ---- 4. mux
    const launchEnv = (extra) => {
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      return { ...env, ...(extra ?? {}), CODEX_MODS_GENERATION: String(generation) };
    };
    // The Host's markers (leftover detection, contracts/ipc.d.ts section 5) go on every backend, including one launched with the app's environment.
    const markerEnv = () => {
      const env = { CODEX_MODS_GENERATION: String(generation) };
      for (const k of ['CODEX_MODS_RUN_DIR', 'CODEX_MODS_BOOT']) if (typeof process.env[k] === 'string') env[k] = process.env[k];
      return env;
    };
    const launchFor = (backendId, def, session) => {
      // The app's own argv (relay header, contracts/ipc.d.ts section 4) is used verbatim for a session primary.
      const baseArgs = session?.argv ? [...session.argv] : ['app-server'];
      if (backendId === 'primary') {
        // Mux addition 9 (integration.md I11): with the app's environment (relay header v2) the mux starts from it, and only
        // CODEX_HOME (the profile's) and the markers are set here. Without it (header v1) the Host's environment is used.
        const env = session?.env ? { ...markerEnv(), CODEX_HOME: profile.codexHome } : launchEnv({ CODEX_HOME: profile.codexHome });
        return { command: realCodexPath, args: baseArgs, env, codexHome: profile.codexHome };
      }
      const slash = backendId.indexOf('/');
      const owner = backendId.slice(0, slash), key = backendId.slice(slash + 1);
      const modDir = join(layout.backends, owner.startsWith('mod:') ? owner.slice(4) : owner);
      const codexHome = def?.codexHome ? (isAbsolute(def.codexHome) ? def.codexHome : join(modDir, def.codexHome)) : join(modDir, key);
      // A framework backend (an added account's, RM10) starts from the app's environment when the mux has it, as the primary does.
      const env = owner === 'framework' && session?.env ? { ...markerEnv(), ...(def?.env ?? {}), CODEX_HOME: codexHome } : launchEnv({ ...(def?.env ?? {}), CODEX_HOME: codexHome });
      return { command: realCodexPath, args: [...baseArgs, ...(def?.args ?? [])], env, codexHome };
    };
    // v1.20: the pack's per-process config for the copy's primary backend (`-c key=toml`), never written to the shared config.toml.
    const overrides = adapter.backend?.configOverrides;
    const primaryConfig = overrides && Object.keys(overrides).length
      ? { overrides, vars: (await import('./mux/config-overrides.mjs')).configOverrideVars({ runningAppPath, realCodexPath, layout, profile }) }
      : undefined;
    // The graph runtime (docs/design/runtime-core.md R1, C2), behind the `graph` flag until C3: its intent journal is opened first, because
    // the mux claims other clients' mutating requests in it (addition 8) and closes after the mux and the graph.
    // E6: the graph is on by default; flags/graph-off turns it off. A failure while it starts is contained (systems.md "E6 in detail",
    // decision 1): what it created closes and the Host goes on as with graph-off, saying why (diagnostics.graph.failed); management,
    // the CLI and the recovery entry never depend on it.
    const graphOn = !existsSync(join(layout.flags, FLAGS.graphOff));
    let graphFailed = null, journal = null;
    const graphFailure = (e, at) => { graphFailed = `${at}: ${String(e?.message ?? e)}`; log.error('the graph did not start; the Host goes on without it', { at, message: String(e?.message ?? e) }); };
    if (graphOn) { try { journal = await f.openJournal(join(layout.graph, 'intents.jsonl')); } catch (e) { graphFailure(e, 'journal'); } }
    if (journal) addCloser('journal', () => journal.close());
    const mux = f.createMux({
      catalog: adapter.protocol, launchFor, bus, log: log.child('mux'),
      ...(primaryConfig ? { primaryConfig } : {}),
      ...(journal ? { journal } : {}),
      clientsSocketPath: join(layout.run, SOCKETS.clients),
      beforePrimaryStart: async () => {
        // Informational only (owner decision, v1.13): the loader already asked the user; the Host never refuses the app connection.
        // `conflict` is true, false or 'unknown'; the flag is published (keeping whatever health Recovery has reported) for true/'unknown'.
        let result = { conflict: false, processes: [] };
        try { result = (await f.stockAppConflict(profile)) ?? result; } catch (e) { result = { conflict: 'unknown', processes: [], error: String(e?.message ?? e) }; }
        if (result.conflict === true || result.conflict === 'unknown') {
          const prev = bus.state('framework/health');
          bus.publish('framework/health', { ...(prev ?? {}), healthy: prev?.healthy ?? false, stockAppConflict: result.conflict }, { state: true });
          log.warn('stock app or another Codex instance may be running on this Codex home; continuing', { conflict: result.conflict, processes: (result.processes ?? []).map((p) => p.pid), error: result.error });
        }
        return false;
      },
    });
    addCloser('mux', () => mux.close());
    // The accounts the user added beside the app's (RM10, added-accounts.mjs): their backends defined and their chats placed before the
    // app connects, so its first request for a chat goes where the chat runs.
    const addedAccounts = f.createAddedAccounts({ mux, dir: join(layout.backends, 'framework'), appHome: profile.codexHome, log: log.child('accounts') });
    try { await addedAccounts.start(); } catch (e) { log.warn('the added accounts were not restored', { message: String(e?.message ?? e) }); }
    addCloser('accounts', () => addedAccounts.dispose());
    let tellHolds = () => {};
    // framework-main's held actions, until it says what each did (their records complete with that)
    const heldMain = createHeldActions({ graph: () => graph });
    const heldAborts = new Map();   // requestId -> abort, while the Host decides a framework-main hold (it may give up: user-hold-cancel)
    let graph = null, appOps = null, readState = null, appProjects = null, appState = null, mainOps = null, approvals = null, codex = null, windows = null;
    let providedAutos = null;   // a mod's Automations in the app's Scheduled page (provided-automations.mjs)
    let nameOfMod = (id) => id;   // the runtime's, once it exists
    // The user's decisions on mods' optional permissions (docs/design/framework-ui.md F8): the gate that holds a call under `ask` for their answer.
    let runtimeRef = null, policyRef = null;
    // the framework's internal mods (internal-mods.mjs), granted what their manifests ask; none in safe mode
    const internal = new Map(safeMode ? [] : internalMods({ layout, log }).map((v) => [v.record.id, v]));
    const TERMINAL = new Set(['succeeded', 'failed', 'reverted', 'needs-attention']);
    const permissions = createPermissionGate({
      record: (id) => operations?.state().mods[id], status: (id) => runtimeRef?.status(id) ?? 'inactive',
      safeMode: () => Boolean(safeMode || operations?.state().safeMode), windows: () => windows, nameOf: (id) => nameOfMod(id), log: log.child('permissions'),
      // the user's decision written as an operation, answered when it ends
      decide: async (modId, grant, decision) => {
        const id = await operations.start({ type: 'set-permission', modId, grant, decision });
        await new Promise((resolve) => {
          const sub = operations.subscribe((op) => { if (op.id === id && TERMINAL.has(op.outcome)) { sub.dispose(); resolve(); } });
          if (TERMINAL.has(operations.get?.(id)?.outcome)) { sub.dispose(); resolve(); }
        });
      },
    });
    bus.subscribe('framework/permission', (e) => { if (e?.modId) permissions.changed(e.modId, e.grant, e.decision); });
    // the graph's side of it: the grant decided `ask` that would let a mod's act through, by the same policy with that one grant added
    const graphPermissions = {
      askFor(caller, request) {
        const modId = String(caller?.id ?? '').replace(/^mod:/, '');
        const r = operations?.state().mods[modId];
        if (!r || !policyRef) return null;
        return asksOf(r).filter((g) => g.startsWith('graph.act')).find((g) => createPolicy({ ...policyRef, grantsOf: (id) => (id === modId ? [...(r.grants ?? []), g] : policyRef.grantsOf(id)) }).authorize(caller, request)) ?? null;
      },
      hold(caller, grant, call) { return permissions.hold(String(caller.id).replace(/^mod:/, ''), grant, { what: `${call.operation} on a ${call.type}` }); },
    };
    /** The page's request cards name the request by the id the app saw: the mux says where it came from, and that source which instance it is. */
    const requests = {
      /** A page's held action's ref as the graph lists it: a repository named by the folder the page acts in (the review panel's git action,
       *  H6m4) is its project's (null: none); any other ref as it is. */
      async pageRef(ref) {
        if ((ref?.type === 'Repository' || ref?.type === 'Branch') && typeof ref.cwd === 'string') {
          const refuse = (message) => Object.assign(new Error(message), { refuse: true });
          let at;
          try { at = (await codex?.repositoryOfPath?.(ref.cwd)) ?? null; } catch { throw refuse('it could not be decided (its repository could not be read)'); }
          if (!at) return null;
          // another worktree of the project's repository: the repository's state is its own checkout's, not this one's
          if (at.checkout === 'worktree') throw refuse('it could not be decided (a worktree of the project: its repository describes another checkout)');
          if (ref.type === 'Repository') return at.ref;
          return typeof ref.name === 'string' && ref.name ? { type: 'Branch', provider: at.ref.provider, id: `${at.ref.id}:${ref.name}` } : null;
        }
        return ref;
      },
      /** A page hold's instance read again first (a repository's branch: built review H6m4): true once read, false when it could not be, null when it need not be. */
      fresh(ref) {
        if (ref?.provider !== 'codex') return null;
        if (ref.type === 'GitRepository') return codex?.readRepository?.(ref.id) ?? false;
        if (ref.type === 'Branch') return codex?.readRepository?.(ref.id.slice(0, ref.id.lastIndexOf(':'))) ?? false;
        return null;
      },
      refOf(sid) {
        const at = mux.serverRequestOf?.(sid);
        if (!at) return null;
        return at.backend === 'primary' ? codex?.requestRefOf?.(sid) ?? null : null;
      },
    };
    if (graphOn && !graphFailed) {
      const mark = closers.length;
      try {
        // Authority (breadth.md D0.2): what a mod's approved grants cover, read late from the installed-mod records.
        policyRef = { grantsOf: (modId) => internal.get(modId)?.record.grants ?? operations?.state().mods[modId]?.grants, typeOf: (typeId) => graph?.type(typeId),
          subjectOf: (ref) => graph?.resolve(ref)?.links?.subject ?? null, canonicalOf: (ref) => graph?.resolve(ref)?.ref?.type ?? null };
        const policy = createPolicy(policyRef);
        // The user's approval of a mod's one-time action (runtime-core.md R17): framework-main shows the prompt as a native dialog.
        approvals = await f.createApprovals({ send: toMain, nameOf: (id) => nameOfMod(id), log: log.child('graph/approvals') });
        const ap0 = approvals;
        addCloser('approvals', () => ap0.dispose());
        graph = await f.createGraph({ log: log.child('graph'), journal, authorize: policy.authorize, approvals, permissions: graphPermissions, overridesFile: join(layout.graph, 'overrides.json'),
          // a mod's automatic action the user has on, as declared then (public-hooks.md §3.9): only while the mod is on
          automaticOf: (modId, id) => { const r = operations?.state().mods[modId]; return r?.status === 'enabled' ? r.automatic?.[id] ?? null : null; },
          // a policy the user turned off on its mod's page (public-hooks.md §3.7): by its owner (`mod:<id>`) and its id
          policyOff: (owner, id) => (operations?.state().mods[String(owner).replace(/^mod:/, '')]?.policiesOff ?? []).includes(id),
          // the user's order of the mods (E6): their interceptors and rewriting policies run in it, their defaults apply in it
          rankOf: (id) => operations?.rankOf?.(id) ?? Number.MAX_SAFE_INTEGER });
        graph.registerTypes(await f.nativeTypes(), 'native');
        // The framework's own types (docs/graph/07, systems.md S1): its provider starts once management exists (below).
        graph.registerTypes(await f.frameworkTypes(), 'framework');
        // The presentation types (docs/graph/03, systems.md S10): the base graph's, as 02's are.
        graph.registerTypes(await f.presentationTypes(), 'native');
        // a mod's stop (graph-integrity G6.2) is in its Activity, with what it stopped: one line each
        graph.onOperation?.((e) => {
          if (e?.status !== 'stopped' || e.outcome?.by?.kind !== 'mod' || typeof e.outcome.by.id !== 'string') return;
          const what = `${e.ref?.type ?? 'something'}.${e.operation}`;
          const who = e.caller?.kind === 'user' ? 'the user\'s ' : e.caller?.kind === 'mod' ? `${e.caller.id}'s ` : '';
          void activity.note(e.outcome.by.id, 'info', `Stopped ${who}${what}${e.outcome.message ? `: ${e.outcome.message}` : ''}`);
        });
        // what holds the app's own actions (public-hooks.md §3.5) and what only observes them (§3.4): framework-main and the page wait on the
        // Host for one only while something holds it, and report one after it went while a mod observes it
        let toldHolds = null;
        tellHolds = (force = false) => {
          let now;
          try { now = graph.appHolds(APP_HELD); } catch { now = { held: [], observed: [] }; }
          const said = JSON.stringify(now);
          if (said === toldHolds && !force) return;
          toldHolds = said;
          post({ type: 'user-holds', ...now });
        };
        const holdsSub = graph.onHolds?.(tellHolds);
        const mainBindings = Object.entries(MAIN_HELD).map(([concept, ops]) => graph.bindAppOrigin?.((s) => s.ref.provider === 'codex' && graph.type(s.ref.type)?.concept === concept, ops));
        addCloser('user-holds', () => { holdsSub?.dispose(); for (const b of mainBindings) b?.dispose?.(); heldMain.dispose(); });
        // The app's read state (presentations.md V12): framework-main holds the app's `threadReadState` session and reports the unread thread
        // ids (`read-state`); this store is the Host's copy, and its writes go back as `read-state-set`. Thread.unread and Thread.markRead
        // follow it (the app's own chats; a mod's are its own, graph-integrity G2.1).
        readState = await f.createReadState({ send: toMain, log: log.child('graph/read-state') });
        const rs = readState;
        addCloser('read-state', () => rs.dispose());
        // The app's projects (breadth.md D3): framework-main reads them, the one the app opened and which project each thread is in from the
        // app's global state (`projects`), and runs the project operations the app's way (`app-op`, answered with `app-op-done`).
        appProjects = await f.createAppProjects({ send: toMain, log: log.child('graph/app-projects') });
        const ap = appProjects;
        addCloser('app-projects', () => ap.dispose());
        // The app's own state (breadth.md D4): framework-main reads its settings, its version, its onboarding and the appearance
        // (`app-state`), and writes a setting the app's way (`app-state-op`, answered with `app-state-op-done`).
        appState = await f.createAppState({ send: toMain, log: log.child('graph/app-state') });
        const as = appState;
        addCloser('app-state', () => as.dispose());
        // framework-main's feature areas (breadth.md D5, D10): one channel for them all (`area-op`, answered with `area-op-done`; `area-report`).
        mainOps = await f.createMainOps({ send: toMain, log: log.child('graph/main-ops') });
        const mo = mainOps;
        addCloser('main-ops', () => mo.dispose());
        // What is on screen (systems.md S10): each window's page reports its presentations through the `ui` namespace; they act through
        // framework-main's `windows` area.
        windows = await f.createWindowsSource({ graph, mainOps, bus, log: log.child('graph/windows'),
          showDetail: (windowId, ref) => showDetailIn(windowId, ref) });
        const wi = windows;
        addCloser('windows', () => wi.dispose());
        // The native protocol source lists threads whenever the app-server reports ready (appServer/ready), and follows the mux after.
        codex = await f.createCodexSource({ graph, mux: noteRequests(mux, features, log), bus, log: log.child('graph/codex'), readState, appProjects, appState, mainOps, addedAccounts,
          filesDir: join(layout.graph, 'draft-files'),
          // a page operation on a shown presentation of a subject (E8.3b: a Draft's live composer), through the windows provider
          pageAct: (type, subject, op, args, windowId) => (windows?.actOn ? windows.actOn(type, subject, op, args, windowId) : Promise.resolve(null)),
          withPane: (pane, fn) => (windows?.withPane ? windows.withPane(pane, fn) : fn()),
          capturePane: (windowId, token) => windows?.capturePane?.(windowId, token),
          heldPane: () => windows?.heldPane?.(),
          panesOf: (windowId, type, subject) => (windows?.panesOf ? windows.panesOf(windowId, type, subject) : []),
          chooseWindow: (type, subject) => (windows?.chooseWindow ? windows.chooseWindow(type, subject) : Promise.resolve(null)),
          frontWindow: () => (windows?.frontWindow ? windows.frontWindow() : Promise.resolve(null)),
          openWindow: (target, call) => (windows?.openWindow ? windows.openWindow(target, call) : Promise.resolve({ status: 'refused', reason: 'unavailable', message: 'no window reports' })),
          showsIn: (windowId, type, subject) => (windows?.showsIn ? windows.showsIn(windowId, type, subject) : false) });
        const g = graph;
        addCloser('graph', async () => { await codex.dispose(); g.close(); });
        // The app's own operations, held for the graph's interceptors at the mux (docs/design/interception.md, C4).
        // and the app's requests on the instances its areas feed (a plugin's install, a tool server's config, ...: public-hooks.md §3.5, H6m)
        const cx = codex;
        appOps = await f.createAppOps({ graph, mux, log: log.child('graph/app-ops'), appOperation: (method, params) => cx?.appOperation?.(method, params) ?? null,
          appOwn: (method, params, take) => cx?.appOwn?.(method, params, take) === true });
        // A mod's Automations in the app's Scheduled page (public-hooks.md §3.15, H7pa): framework-main lists them as the app's own items
        // and sends the user's acts on one here; their runs are the mod's chats, not the app's history (optional: one that cannot start
        // leaves them out, never the graph)
        const mo2 = mainOps;
        try {
          if (typeof graph.subscribe === 'function' && typeof mo2?.op === 'function') {
            providedAutos = createProvidedAutomations({ graph, send: (p) => mo2.op('automations', 'provided', p), log: log.child('graph/provided-automations') });
            const pa = providedAutos;
            addCloser('provided-automations', () => pa.dispose());
          }
        } catch (e) { providedAutos = null; log.warn('a mod\'s automations are not listed in the app', { message: String(e?.message ?? e) }); }
        log.info('graph runtime started', { journal: join(layout.graph, 'intents.jsonl') });
      } catch (e) {
        graphFailure(e, 'start');
        // the app operations' closer comes later (after the runtime's): it first, then the rest in reverse
        for (const x of [appOps]) { try { await x?.dispose?.(); } catch (e2) { log.error('close step failed', { message: String(e2?.message ?? e2) }); } }
        const closed = closers.slice(mark).some((x) => x.name === 'graph');
        while (closers.length > mark) {
          const { name, fn } = closers.pop();
          try { await fn(); } catch (e2) { log.error('close step failed', { step: name, message: String(e2?.message ?? e2) }); }
        }
        if (!closed) { try { graph?.close?.(); } catch { /* it did not start */ } }
        graph = appOps = readState = appProjects = appState = mainOps = approvals = codex = windows = providedAutos = null;
      }
    }

    // ---- 5. runtime
    const rendererModules = new Map();
    const runtime = f.createRuntime({
      activity, permissions,
      mux, bus, log: log.child('runtime'), layout,
      seamHooks: adapter.seams?.hooks ?? {},   // what this build delivers: the parts a rule may name (layouts WL2-4a review)
      rankOf: (id) => operations?.rankOf?.(id) ?? Number.MAX_SAFE_INTEGER,   // the user's order (E6)
      onQuarantine: (modId, reason) => operations?.quarantine(modId, reason),
      announceRenderer: (modId, module) => {
        if (module) rendererModules.set(modId, { modId, ...module }); else rendererModules.delete(modId);
        post({ type: 'renderer-modules', modules: [...rendererModules.values()] });
      },
      graph,
      requests,
      windows,
      mainOps,
    });
    showDetailIn = (windowId, ref) => runtime.showDetail?.(windowId, ref) ?? false;
    nameOfMod = (id) => runtime.nameOf?.(id) ?? id;
    runtimeRef = runtime;
    addCloser('runtime', () => runtime.close());
    if (appOps) { const ao = appOps; addCloser('app-ops', () => ao.dispose()); }   // releases what it holds before the mods stop
    mux.setLeaseServiceHandler((owner, call) => runtime.callServiceForLease(owner, call));

    // ---- 6. packages
    const packages = f.createPackages({ layout, log: log.child('packages'), frameworkVersion });

    // ---- 7. recovery
    const recovery = f.createRecovery({
      layout, log: log.child('recovery'), bus, operationsState: () => operations.state(),
      operations: () => operations,
      requestExit: (o) => { log.info('exit requested', o); post({ type: 'exit', relaunch: o.relaunch, reason: o.reason }); },
      appBuild, frameworkVersion, adapterVersion: adapter.adapterVersion, adapter,
      ...(runningAppPath ? { runningAppPath } : {}),
      activeMods: () => runtime.active(),
      gcPackages: () => operations.gcStore(),
      features,
      ...(typeof profile?.stockApp === 'string' && profile.stockApp ? { deps: { stockApp: profile.stockApp } } : {}),
    });

    // ---- 9. operations
    // ---- 9b. updates (docs/design/systems.md E5): the release source, staging in quarantine, the detector (started once healthy)
    const updateState = createUpdateState(layout);
    const treePkg = (await readJson(join(tree, 'package.json'))) ?? {};
    const releaseSpec = profile?.updates?.source ?? (treePkg.repository?.url ? { kind: 'git', remote: treePkg.repository.url } : null);
    const releaseSource = createReleaseSource(releaseSpec, layout);
    let staging = null, detector = null, emitUpdates = () => {}, modUpdatesRef = null;
    const stockApp = profile?.stockApp || '/Applications/ChatGPT.app';
    operations = f.createOperations({ layout, log: log.child('ops'), packages, runtime, bus, mux, adapter, safeMode, recovery, features,
      beforeFrameworkOp: async () => { await staging?.cancel(); }, afterFrameworkOp: () => { detector?.resume(); } });
    staging = createStaging({ layout, log: log.child('updates/staging'), frameworkVersion, adapter, recovery, packages, operations: () => operations, features, source: releaseSource,
      // F11: each step as it begins (the Update page follows it); the mods' GitHub releases are candidates too
      onStep: () => emitUpdates(), modOffers: () => modUpdatesRef?.held() ?? [] });
    await staging.cleanup().catch(() => {});
    detector = createDetector({ layout, log: log.child('updates'), copyBuild: `${adapter.build.version}-${adapter.build.bundleVersion}`, frameworkVersion,
      stockApp, source: releaseSource, staging, state: updateState,
      busy: () => operations.list({ running: true }).some((o) => ['framework-update', 'app-prepare', 'app-switch', 'safe-mode', 'lkg-restore', 'copy-update'].includes(o.input.type)),
      safe: () => Boolean(safeMode || operations.state().safeMode), onChange: () => emitUpdates(),
      enabledNow: () => Object.values(operations.state().mods).filter((m) => m.status === 'enabled').map((m) => `${m.id}@${m.version}`).sort(),
      installedNow: () => Object.values(operations.state().mods).filter((m) => m.status !== 'pending-consent').map((m) => `${m.id}@${m.version}`).sort() });
    // a change of the enabled mods restages the offer (its plan would be stale): when a mod operation ends
    // a policy the user switched on or off (its mod's page) holds the app's own actions, or no longer does
    bus.subscribe('framework/op', (op) => { if (op && op.outcome !== 'running' && op.input?.type === 'set-policy' && typeof op.input.modId === 'string') graph?.policiesSwitched?.(`mod:${op.input.modId}`); });
    bus.subscribe('framework/op', (op) => { if (op && op.outcome !== 'running' && ['enable', 'disable', 'update', 'rollback', 'remove', 'install', 'consent', 'clear-quarantine', 'reload'].includes(op.input?.type)) detector?.resume(); });

    // ---- 10. management
    // Mods from GitHub (docs/design/framework-ui.md F10): installed from a release's signed package, and checked again with the copy and every few hours
    const modUpdates = createModUpdates({ github: opts.github ?? createGitHub({ userAgent: `codexmods/${frameworkVersion}` }), operations, packages,
      compatibility: (m) => operations.compatibility(m), dir: join(layout.updates, 'mods'), log: log.child('mod-updates') });
    modUpdatesRef = modUpdates;
    void modUpdates.sweep();
    const modCheck = setInterval(() => { void modUpdates.check(); }, CHECK_EVERY_MS);
    modCheck.unref?.();
    addCloser('mod updates', () => clearInterval(modCheck));
    const management = f.createManagement({ activity, modUpdates, operations, packages, runtime, recovery, bus, mux, log: log.child('management'), layout, appBuild, adapterVersion: adapter.adapterVersion, features,
      updates: { detector, state: updateState, onEvent: (fn) => { emitUpdates = fn; }, cancel: () => staging?.cancel(),
        // F11: Use original Codex: the stock app, opened as the person would (it updates itself; mods stay here)
        openOriginal: () => new Promise((resolve, reject) => { execFile('/usr/bin/open', [stockApp], (e) => (e ? reject(e) : resolve())); }) },
      ...(graph ? { graphStatus: () => ({ degraded: graph.degraded?.() ?? [], windows: windows?.stats?.() ?? null, ...(graphFailed ? { failed: graphFailed } : {}) }) }
        : graphFailed ? { graphStatus: () => ({ failed: graphFailed }) } : {}) });
    // ctx.settings.set and reset (E3): the mod's own scoped patches, through management, resolved when the operation ends.
    runtime.setSettingsWriter?.(async (modId, patches) => {
      const r = await management.configurePatches(modId, patches, { fromMod: true });
      if (!r.opId) return { outcome: 'succeeded', unchanged: true };
      return operations.whenSettled(r.opId);
    });

    // The framework's own instances (systems.md S3): CodexMods, its Mods and their Operations, over the management dispatcher.
    // A failure here is contained as the graph's own (the Mods pages then do not run, and each window shows the recovery entry).
    if (graph) {
      try {
        // what each mod gave the agent, from the graph's records of the agent's inputs (graph-integrity G3.5)
        const given = createAgentGiven({ graph, modIds: () => graph.list('Mod').map((m) => m.ref.id), log: log.child('agent/given') });
        addCloser('agent/given', () => given.dispose());
        // the mods the Mods page recommends (F10): the framework's catalog, as installed with it; none when it cannot be read
        const catalog = await readFile(new URL('../catalog.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
        const fw = await f.createFrameworkSource({ graph, management, frameworkVersion, catalog, log: log.child('graph/framework'),
          agent: { of: (id) => given.of(id), onChange: (fn) => given.onChange(fn) },
          rules: { of: (id) => runtime.rulesOf?.(id) ?? [], onChange: (fn) => runtime.onRulesChange?.(fn) } });
        addCloser('graph/framework', () => fw.dispose());
      } catch (e) { graphFailure(e, 'framework provider'); }
    }

    // v1.9: the first healthy report finalizes running framework-level operations on this same boot (once).
    {
      let reconciled = false;
      const sub = bus.subscribe('framework/health', (data) => {
        if (reconciled || !data || data.healthy !== true) return;
        reconciled = true;
        Promise.resolve().then(() => operations.reconcileFramework()).catch((e) => log.error('reconcileFramework failed', { message: String(e?.message ?? e) }));
        Promise.resolve().then(() => detector?.start()).catch((e) => log.warn('updates: the detector did not start', { message: String(e?.message ?? e) }));
      }, { replay: 'state' });
      addCloser('health-reconcile', () => sub.dispose());
    }

    // ---- framework-main <-> Host (messages sent before this point are buffered by the transport)
    // One RealmPort per bridged (windowId, channel); the first message for a pair opens it (contracts/ipc.d.ts section 1).
    const realms = new Map();
    const realmKey = (windowId, channel) => `${windowId}:${channel}`;
    function realmMessage({ windowId, channel, data }) {
      if (channel !== 'renderer' && channel !== 'management') { log.warn('realm message on an unknown channel', { channel }); return; }
      const key = realmKey(windowId, channel);
      let r = realms.get(key);
      if (!r) {
        const msgFns = new Set(), closeFns = new Set();
        const port = {
          post: (m) => post({ type: 'realm', windowId, channel, data: m }),
          onMessage: (fn) => { msgFns.add(fn); return { dispose: () => msgFns.delete(fn) }; },
          onClose: (fn) => { closeFns.add(fn); return { dispose: () => closeFns.delete(fn) }; },
        };
        r = { msgFns, closeFns, attached: null };
        realms.set(key, r);
        r.attached = channel === 'renderer' ? runtime.handleRealm('renderer', port, { windowId }) : management.attach(port);
      }
      for (const fn of [...r.msgFns]) {
        try { fn(data); } catch (e) { log.error('realm handler failed', { channel, message: String(e?.message ?? e) }); }
      }
    }
    function closeRealm(key) {
      const r = realms.get(key);
      if (!r) return;
      realms.delete(key);
      for (const fn of [...r.closeFns]) { try { fn(); } catch { /* ignore */ } }
      try { r.attached?.dispose(); } catch { /* ignore */ }
    }
    addCloser('realms', () => { for (const key of [...realms.keys()]) closeRealm(key); });
    if (parent) {
      const sub = parent.onMessage((msg) => {
        try { onMainMessage(msg); } catch (e) { log.error('framework-main message failed', { type: msg?.type, message: String(e?.message ?? e) }); }
      });
      addCloser('parent-messages', () => sub.dispose());
    }
    /** A message from framework-main whose pull request the app names by its identity, naming the one listed (built review H6m2b). */
    const listedRef = (msg) => {
      if (msg.ref?.type === 'GitHubPullRequest' && msg.ref.provider === 'codex' && typeof codex?.pullRequestRef === 'function') return { ...msg, ref: codex.pullRequestRef(msg.ref) };
      return menuEntryHold(msg, windows);
    };
    function onMainMessage(msg) {
      switch (msg?.type) {
        case 'realm': realmMessage(msg); return;
        case 'realm-close': closeRealm(realmKey(msg.windowId, msg.channel)); return;
        case 'window':
          // focus, blur, its bounds and its title too (graph-integrity G5.5)
          bus.publish(`window/${msg.event}`, { windowId: msg.windowId, ...(typeof msg.value === 'boolean' ? { value: msg.value } : {}),
            ...(msg.bounds && typeof msg.bounds === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(msg.bounds[k]))
              ? { bounds: { x: msg.bounds.x, y: msg.bounds.y, width: msg.bounds.width, height: msg.bounds.height } } : {}),
            ...(typeof msg.title === 'string' ? { title: msg.title.slice(0, 500) } : {}) });
          if (msg.event === 'closed') for (const key of [...realms.keys()]) if (key.startsWith(`${msg.windowId}:`)) closeRealm(key);
          return;
        case 'health':
          if (msg.signal === 'window-rendered') recovery.report('window-rendered');
          return;
        case 'read-state':
          readState?.apply(msg);   // the app's unread set (V12); only with the graph on
          return;
        case 'projects':
          appProjects?.apply(msg);   // the app's projects (D3); only with the graph on
          return;
        case 'app-op-done':
          appProjects?.settle(msg);
          return;
        case 'app-state':
          appState?.apply(msg);   // the app's settings, version and appearance (D4); only with the graph on
          return;
        case 'app-state-op-done':
          appState?.settle(msg);
          return;
        case 'area-op-done':
          mainOps?.settle(msg);   // an area operation framework-main ran (D5, D10); only with the graph on
          return;
        case 'area-report':
          mainOps?.report(msg);
          return;
        case 'approval-answer':
          approvals?.settle(msg);
          return;
        case 'user-hold':
          // an action framework-main held before it happens (public-hooks.md §3.5; user-hold.mjs)
          decideUserHold(listedRef(msg), { graph, heldMain, heldAborts, post, log, nameOf: nameOfMod,
            fresh: (ref) => (ref?.type === 'GitRepository' && ref.provider === 'codex' ? codex?.readRepository?.(ref.id) ?? false : null),
            // the Skills page shows nothing when its install is refused: the window in front says why (built review H6m2a)
            refused: (m, message) => {
              // a command not run from the menu bar or the floating palette: the window in front says why (the menu, the palette has closed)
              if (m.menu || m.ref?.type === 'Command') { void Promise.resolve(windows?.notify?.({ id: 'codexmods.framework', name: 'Codex Mods' }, { title: 'Not run', body: String(message).slice(0, 400), kind: 'info', surface: 'toast', dedupe: 'codexmods-menu' })).catch(() => {}); return; }
              if (m.operation !== 'install' || m.ref?.type !== 'Skill') return;
              void Promise.resolve(windows?.notify?.({ id: 'codexmods.framework', name: 'Codex Mods' }, { title: 'Skill not installed', body: String(message).slice(0, 400), kind: 'info', surface: 'toast', dedupe: 'codexmods-skill' })).catch(() => {});
            } });
          return;
        case 'provided-act': {
          // the user's act on a mod's Automation in the app's Scheduled page (H7pa): its provider's operation, as the user; answered as a
          // hold a mod handled (never the app's own call); framework-main giving up on it aborts it (`provided-act-cancel`)
          const answer = (fields) => post({ type: 'user-hold-answer', requestId: msg.requestId, go: false, ...fields });
          if (!providedAutos || typeof msg.requestId !== 'string') { answer({ message: 'the framework\'s graph is off' }); return; }
          const abort = createAbort();
          heldAborts.set(msg.requestId, abort);
          providedAutos.act(msg, abort.signal).then((out) => answer(out?.status === 'done' ? { handled: true, value: out.value ?? null }
            : { message: out?.message ?? out?.error?.message ?? 'not done', ...(out?.status === 'uncertain' || out?.status === 'failed' ? { uncertain: true } : {}) }),
          (e) => answer({ message: String(e?.message ?? e) })).finally(() => heldAborts.delete(msg.requestId));
          return;
        }
        case 'provided-act-cancel':
          heldAborts.get(msg.requestId)?.abort('framework-main gave up waiting');
          return;
        case 'notice-action':
        case 'notice-gone':
          // a mod's desktop notification (public-hooks.md §3.14): a click on it or one of its buttons, or it went
          if (typeof msg.id === 'string') void windows?.noticeDesktop?.(msg.id, typeof msg.action === 'string' ? msg.action : null, msg.type === 'notice-gone');
          return;
        case 'user-hold-cancel':
          // framework-main gave up on a hold (it refused the action): nothing more of it is done, a replacement included
          heldAborts.get(msg.requestId)?.abort('framework-main gave up waiting');
          return;
        case 'user-hold-done':
          if (typeof msg.requestId === 'string') heldMain.done(msg.requestId, msg.outcome);
          return;
        case 'user-did': {
          // an action nothing held went while a mod observes it (§3.4): what it did, as its record
          const listed = msg.ref && typeof msg.ref === 'object' ? listedRef(msg) : null;
          const ref = listed?.ref ?? null;
          if (graph && ref && typeof listed.operation === 'string') {
            const caller = msg.origin === 'app' ? { kind: 'app', id: 'app', owner: 'app' } : { kind: 'user', id: 'user', owner: 'app' };
            graph.recordApp({ ref, operation: listed.operation, args: Array.isArray(msg.args) ? msg.args : [], caller, origin: 'app', outcome: heldOutcome(msg.outcome) });
          }
          return;
        }
        case 'recovery':
          if (msg.action === 'lkg-restore') {
            // Durable before anything else happens: start() resolves once the op is journaled.
            operations.start({ type: 'lkg-restore' }).catch((e) => log.error('lkg-restore failed to start', { message: String(e?.message ?? e) }));
          }
          return;
        case 'shutdown':
          log.info('shutdown requested by framework-main');
          close().catch(() => {});
          return;
        default: return;
      }
    }
    // Breadcrumbs: the active mods, whenever an operation or a quarantine may have changed them.
    let lastCrumbs = '';
    const crumbs = () => {
      const mods = runtime.active();
      const key = JSON.stringify(mods);
      if (key !== lastCrumbs) { lastCrumbs = key; post({ type: 'breadcrumbs', mods }); }
    };
    const crumbSubs = [bus.subscribe('framework/op', crumbs), bus.subscribe('framework/quarantine', crumbs)];
    addCloser('breadcrumbs', () => { for (const s of crumbSubs) s.dispose(); });

    // ---- startup sequence
    // Host-crash history left by framework-main (read before Recovery rewrites the boot marker). Two crashes within ten minutes
    // of each other (hostCrashCount >= 2, contracts/state.d.ts BootMarker) quarantine the mods named in the breadcrumbs.
    const bootFile = join(layout.flags, FLAGS.bootMarker);
    const crashMarker = await readJson(bootFile, undefined).catch(() => undefined);
    // The copy's update is settled first (undone, reverted or left waiting for its verdict), so this boot's generation is recorded from
    // settled state (docs/design/systems.md E5).
    await operations.recoverEarly?.();
    generation = (await recovery.beginBoot()).n;
    await operations.recover();
    {
      const leftovers = await cleanupLeftovers({ currentBoot: bootId, runDir: layout.run, ps: opts.ps, kill: opts.killProcess, log: log.child('leftovers') });
      if (leftovers.found.length) bus.publish('framework/leftovers', leftovers);
    }
    if ((crashMarker?.hostCrashCount ?? 0) >= 2) {
      const crashed = Array.isArray(crashMarker.breadcrumbs) ? crashMarker.breadcrumbs : [];
      for (const modId of crashed) {
        try { operations.quarantine(modId, 'host-crash'); } catch (e) { log.warn('could not quarantine after host crash', { modId, message: String(e?.message ?? e) }); }
      }
      try {
        const marker = await readJson(bootFile, undefined);
        if (marker) { const { breadcrumbs, lastHostCrashAt, ...rest } = marker; await writeJsonAtomic(bootFile, { ...rest, hostCrashCount: 0 }); }
      } catch (e) { log.warn('could not reset the host crash count', { message: String(e?.message ?? e) }); }
      log.warn('repeated Host crashes: quarantined the mods named by the breadcrumbs', { mods: crashed, count: crashMarker.hostCrashCount });
    }
    const appSocket = await listenUnix(join(layout.run, SOCKETS.app), (stream) => {
      try { mux.attachApp(stream); } catch (e) { log.error('attachApp failed', { message: String(e?.message ?? e) }); stream.destroy(); }
    });
    addCloser('app.sock', () => appSocket.close());
    const mgmtListener = await management.listen(join(layout.run, SOCKETS.management), join(layout.run, 'mgmt.token'));
    addCloser('mgmt.sock', () => mgmtListener.dispose());
    // The auto policy (E5): a ready plan applied at launch, before any mod activates; recorded by its offer before any effect, so an
    // offer reverted or dismissed is never applied on its own again.
    let autoApplying = false;
    if (!safeMode) {
      try {
        const st = await updateState.load();
        const latest = st.latestPlan;
        if (st.policy === 'auto' && latest?.hash && !st.auto[latest.offer] && !st.dismissed.includes(latest.offer)
          && !operations.list({ running: true }).some((o) => o.input.type === 'copy-update')) {
          const { readPlan, choose, verdictOf } = await import('./updates/plan.mjs');
          const plan = await readPlan(layout, latest.hash);
          if (!verdictOf(choose(plan)).held) {
            await updateState.update((s) => { s.auto[latest.offer] = { at: new Date().toISOString(), plan: latest.hash }; });
            await operations.start({ type: 'copy-update', plan: latest.hash });
            autoApplying = true;
            log.info('updates: applying a ready plan at launch (auto)', { plan: latest.hash });
          }
        }
      } catch (e) { log.warn('updates: the auto policy could not apply the plan', { message: String(e?.message ?? e) }); }
    }
    if (!safeMode && !autoApplying) {
      // the framework's internal mods first (internal-mods.mjs): the user's mods may use them from their start
      for (const view of internal.values()) {
        try { await runtime.activate(view); } catch (e) { log.warn('an internal mod did not start', { modId: view.record.id, message: String(e?.message ?? e) }); }
      }
      await operations.activateAll();
    }
    crumbs();
    post({ type: 'ready' });
    if (graph) tellHolds(true);
    recovery.report('host-ready');
    log.info('host ready', { generation });

    return { mux, runtime, operations, management, recovery, bus, close };
  } catch (e) {
    log?.error('host start failed', { message: String(e?.message ?? e) });
    await close();
    throw e;
  }
}

/** The mux as the native provider sees it, every method its clients request noted by the feature state (docs/design/systems.md "E4 in
 *  detail": the scan's blind spots show at run time). */
function noteRequests(mux, features, log) {
  const wrap = (client) => new Proxy(client, { get(t, k) {
    if (k === 'request') return (method, ...rest) => { if (features?.noteRequested?.(method)) log.warn('the framework requested a method its feature log lacks', { method }); return t.request(method, ...rest); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  return new Proxy(mux, { get(t, k) {
    if (k === 'client') return (...a) => wrap(t.client(...a));
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
}
