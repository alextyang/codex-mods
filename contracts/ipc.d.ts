// Cross-process and cross-thread message protocols.
// All channels carry plain JSON objects (MessagePort / worker postMessage / JSONL sockets). No functions, no classes.
import type { Json, ErrorCode } from '../sdk/index.js';
import type { HostStartOptions } from './host.js';
import type { ProbeReport } from './adapter.js';

// ======================================================================== 1. framework-main ↔ Host
// v1.2: the Host is a child process running the app's bundled Node (Resources/cua_node/bin/node, ARCHITECTURE change log v1.2)
// with a Node IPC channel (stdio 'ipc', JSON serialization). MessagePorts cannot cross it, so renderer and management channels
// are BRIDGED by framework-main: each window channel's messages travel as {type:'realm'} envelopes. Headless: absent. framework-main owns both ends.
export type MainToHost =
  | { type: 'init'; options: Omit<HostStartOptions, 'parent'> }
  | { type: 'window'; event: 'created' | 'shown' | 'focused' | 'blurred' | 'closed'; windowId: number }
  | { type: 'window'; event: 'bounds'; windowId: number; bounds: { x: number; y: number; width: number; height: number } }   // once it stops moving (G5.5)
  | { type: 'window'; event: 'title'; windowId: number; title: string }
  /** A window channel opened (first message) or carries a message. channel 'renderer' → runtime.handleRealm('renderer', port, {windowId});
   *  'management' → management.attach(port). The Host builds one RealmPort per (windowId, channel). */
  | { type: 'realm'; windowId: number; channel: 'renderer' | 'management'; data: Json }
  | { type: 'realm-close'; windowId: number; channel: 'renderer' | 'management' }
  | { type: 'health'; signal: 'window-rendered' }
  /** From the safe-mode dialog: the Host starts the op durably. */
  | { type: 'recovery'; action: 'lkg-restore' }
  /** The app's read state (docs/design/presentations.md V12; framework/main/read-state.cjs): the unread thread ids of the app's local host, as its
   *  `threadReadState` session last said, sent when they change (debounced), when the account's session opens, and again when the Host says
   *  `ready`. Only the Host's graph runtime listens (on unless flags/graph-off). `available` is false while framework-main has no session (no window, no service,
   *  not signed in yet): `unread` is then empty and means nothing, and the Host keeps what it knew. `reset` is true on the first report for an
   *  account (and after the Host restarted): what changed since the Host last heard is a sync, not the user's doing. `epoch` (while available)
   *  names the account's session: opaque, new for each account framework-main opens a session for (boundary review R3). `ack` is the id of the
   *  last `read-state-set` framework-main applied, in order; `dropped` the ids of the ones it gave up on since its last report (another
   *  account's, refused, failed or past its queue). The Host keeps its own writes on top of what it hears until they are acked or dropped. */
  | { type: 'read-state'; available: boolean; unread: string[]; reset?: boolean; epoch?: string; ack?: string; dropped?: string[] }
  /** The app's projects (breadth step D3; framework/main/projects.cjs), read from the app's global state: sent when they change (debounced),
   *  when framework-main holds a window's store, and again when the Host says `ready`. Only the Host's graph runtime listens (on unless flags/graph-off).
   *  `available` is false while framework-main holds no store (no window with the `projects` service): the rest is absent and the Host keeps
   *  what it knew. `projects` (the local projects in the sidebar's order, roots first-is-folder) and `selected` (the project the app opened)
   *  are present when they changed. `threads` is what the app records about a thread's project, for the threads whose record changed (null:
   *  none now), and for every thread on `reset` (the first report, the first from another window's store, the first after the Host
   *  restarted): `project` (assigned to that local project), `other` (assigned to a remote one), `projectless`, `root` (a workspace-root
   *  hint). The Host decides the thread's project from them and its working directory, by the app's rule (graph/app-projects.mjs). */
  | { type: 'projects'; available: boolean; projects?: { id: string; name: string; roots: string[]; createdAt?: number; updatedAt?: number }[];
      selected?: string | null; threads?: Record<string, { project?: string; other?: true; projectless?: true; root?: string } | null>; reset?: boolean }
  /** The user's answer to an `approval-ask` (runtime-core.md R17): `stopAsking` is the dialog's "don't ask again" checkbox. A prompt the
   *  Host closed gets no answer. */
  | { type: 'approval-answer'; requestId: string; approved: boolean; stopAsking: boolean }
  /** The user's own action held in framework-main before its effect (public-hooks.md §3.5: a setting the user changes), or the app's own
   *  (`origin: 'app'`: a notification): the Host runs the mods' interceptors and policies on it and answers with `user-hold-answer`.
   *  `changes: false`: the place cannot show who changed it, so the Host refuses a change of its arguments. */
  | { type: 'user-hold'; requestId: string; ref: { type: string; provider: string; id: string }; operation: string; args: Json[]; origin?: 'app'; changes?: false }
  /** framework-main gave up waiting on a `user-hold` (and refused the action): the Host does nothing more of it, a replacement included. */
  | { type: 'user-hold-cancel'; requestId: string }
  /** What a held action did once it went (its `user-hold` requestId): the mods' `after` records say what happened. */
  | { type: 'user-hold-done'; requestId: string; outcome: { status: 'done' } | { status: 'failed'; error: { message: string } } }
  /** An action nothing held went while a mod observes it (public-hooks.md §3.4): what it did, as its record. */
  | { type: 'user-did'; ref: { type: string; provider: string; id: string }; operation: string; args: Json[]; origin?: 'app'; outcome: { status: 'done' } | { status: 'failed'; error: { message: string } } }
  /** framework-main's answer to a `app-op`, sent after the report of what the operation changed. `refused`: it was not tried.
   *  `result`: a `list`'s `{entries: {name, path, type: 'file' | 'directory', isSymlink}[], truncated}`, an `inspect`'s
   *  `{isFile, size, modifiedAt, kind}` (numbers or null; kind the app's content kind: text, image, pdf, audio, video, archive, binary) or
   *  `{missing: true}`, a `worktree`'s `{exists, root?, branch?, base?}`, an `instructions`' `{home?, files: {path, exists, text?, modifiedAt?,
   *  tooLarge?}[]}`, and the other ops' shapes in framework/main/projects.cjs. */
  | { type: 'app-op-done'; requestId: string; ok: boolean; error?: string; refused?: boolean; result?: Json }
  /** The app's own state (breadth step D4; framework/main/app-state.cjs): its settings (the definitions of every setting that is not
   *  hidden, on a reset; their configured and effective values, all on a reset, else the ones that changed), its facts and the system
   *  appearance when they changed. */
  | { type: 'app-state'; available: boolean; reset?: boolean;
      definitions?: { key: string; agentAccess: 'read-write' | 'read-only'; default?: Json; description: string | null; schema: Json | null }[];
      values?: Record<string, { configured?: Json; effective?: Json }>;
      app?: { version: string | null; buildNumber: string | null; appName: string | null; onboarded: boolean | null; launchedAt: number };
      appearance?: 'light' | 'dark' | null; quitting?: true }
  /** framework-main's answer to an `app-state-op`, sent after the report of what it changed. `refused`: it was not tried. */
  | { type: 'app-state-op-done'; requestId: string; ok: boolean; error?: string; refused?: boolean; result?: Json }
  /** A feature area's operation done (framework/main modules registered with `onAreaOp`; breadth.md D5, D10), and what an area read from
   *  the app (`areaReport`). */
  | { type: 'area-op-done'; requestId: string; ok: boolean; error?: string; refused?: boolean; result?: Json }
  | { type: 'area-report'; area: string; report: Json }
  | { type: 'shutdown' };
export type HostToMain =
  | { type: 'ready' }
  /** Full current module map. framework-main serves codexmod://<modId>/<rev>/<path> from packageDir (path-escape safe). */
  | { type: 'renderer-modules'; modules: { modId: string; packageDir: string; entry: string; rev: string }[] }
  /** The single exit path. relaunch:false is used by app-switch (the swap helper reopens). */
  | { type: 'exit'; relaunch: boolean; reason: string }
  /** Active mods, sent on every activation change; framework-main writes them into boot.json breadcrumbs if the Host dies. */
  | { type: 'breadcrumbs'; mods: string[] }
  /** Host side of a bridged window channel (see MainToHost 'realm'). */
  | { type: 'realm'; windowId: number; channel: 'renderer' | 'management'; data: Json }
  /** Mark a thread read or unread in the app (docs/design/presentations.md V12): framework-main applies it, in order, with its read-state session
   *  (`session.set({hostId: 'local', threadId, hasUnreadTurn: unread})`), queueing it while it has none. `threadId` is the protocol thread id the
   *  app knows (a presented thread's minted id). `id` is opaque and unique per Host start; it comes back as the `ack` (or among the `dropped`)
   *  of a `read-state`. `epoch` is the account's the Host last heard (null before it heard any): a write is applied in that account's session
   *  only, and dropped in another's; one without an epoch goes to the session that opens. */
  | { type: 'read-state-set'; id: string; threadId: string; unread: boolean; epoch: string | null }
  /** An operation run the app's way (breadth step D3; ARCHITECTURE.md §4.1). On a project: `rename` through the app's
   *  `projects.renameLocal`, `remove` through `projects.removeLocal` (from the app; its files untouched), `reveal` in Finder (the project's
   *  first root from the app's record, or `path` inside the project), its files through the app's `workspaceFiles` (`list` a folder as the
   *  app's file tree lists it, `inspect` a file) and `open` (a file tab beside the thread shown), `open-in` (`path` in the app's open-in
   *  `target`), its repository (`repository`; `switch-branch` and `create-branch` with `branch`; `push`), `worktree` (whether `path` is
   *  a worktree of its repository; the one op whose path may be outside the project), a folder's instructions files (`instructions`,
   *  `path` the folder; `edit-instructions`, `path` the file and `text`), and its actions (`actions`; `run-action`, `path` the
   *  environment config, `index` the action's place in it, `threadId` and `cwd` the thread whose terminal runs it and its folder),
   *  `select` (the app's selection of it) and `remove-worktree` (`path`: one of the app's worktrees of its repository). On the app (no
   *  `projectId`): `apps`, `remove-app-approval` (`bundleId`), `cloud-environments`, `pinned-threads`, `navigate` (`path`: one of a few of
   *  the app's pages), and the global instructions in the Codex home (`instructions`; `edit-instructions` and
   *  `open-instructions` with the file's `path`). A `path` must be absolute and, but for `worktree`, inside one of the project's roots,
   *  else the op is refused. `requestId` is opaque and unique per Host start; the answer is a `app-op-done`. */
  | { type: 'app-op'; requestId: string; op: 'rename' | 'remove' | 'reveal' | 'list' | 'inspect' | 'open' | 'open-in' | 'repository' | 'switch-branch' | 'create-branch' | 'push' | 'worktree' | 'remove-worktree' | 'select' | 'instructions' | 'edit-instructions' | 'actions' | 'run-action';
      projectId: string; name?: string; path?: string; target?: string; branch?: string; text?: string; index?: number; threadId?: string; cwd?: string }
  | { type: 'app-op'; requestId: string; op: 'apps' | 'remove-app-approval' | 'cloud-environments' | 'pinned-threads' | 'navigate' | 'instructions' | 'edit-instructions' | 'open-instructions'; bundleId?: string; path?: string; text?: string }
  /** An operation on the app's own state, run the app's way (framework/main/app-state.cjs): `write-setting` (`key`, `value`) through the
   *  app's settings store; `account` (the account's ids, plan and workspace, never a token); `navigate` (`path`: one of a few pages);
   *  `open-help` (the Help menu's first item); `quit` (as Cmd+Q); `open-login` (`path`: a ChatGPT sign-in page, opened in the browser).
   *  `requestId` is opaque and unique per Host start; the answer is an `app-state-op-done`. */
  | { type: 'app-state-op'; requestId: string; op: 'write-setting' | 'account' | 'navigate' | 'open-help' | 'quit' | 'open-login'; key?: string; value?: Json; path?: string }
  /** A feature area's operation, run by the framework-main module that registered the area (`onAreaOp`); answered with `area-op-done`. */
  | { type: 'area-op'; area: string; requestId: string; op: string; args?: { [k: string]: Json } }
  /** Ask the user to approve a mod's one-time action (runtime-core.md R17): framework-main shows the app's native dialog (Don't Allow first,
   *  and `checkbox` as its "don't ask again"). One at a time; `approval-close` closes one nobody answered. */
  | { type: 'approval-ask'; requestId: string; message: string; detail: string; checkbox: string }
  | { type: 'approval-close'; requestId: string }
  /** The answer to a `user-hold`: go (the app's own effect goes on, with `args` as they ended; `changedBy` who changed them), not (and why,
   *  said where it happened), or `handled` (a mod did it in the app's place: not done again, no error). */
  | { type: 'user-hold-answer'; requestId: string; go: boolean; message?: string; args?: Json[]; changedBy?: { mod: string; policy?: string }[]; handled?: true }
  /** What holds the app's own actions now (`held`: an interceptor or a policy would see it) and what only observes them (`observed`: a
   *  mod's `after`), as `Type.operation` (the concept's and each of its types'): framework-main waits on the Host only for a held one and
   *  reports an observed one after it went. Sent when it changes and after `ready`. */
  | { type: 'user-holds'; held: string[]; observed: string[] };

// ======================================================================== 2. Realm RPC (Runtime ↔ every realm)
// One protocol for: the mod's worker thread, each window's renderer runtime (all mods multiplexed), and mod processes.
// The realm calls context methods on the Host; the Host calls handlers registered in the realm.
export type RealmToHost =
  /** Call a context method. ns/method mirror sdk/index.d.ts, e.g. ns 'storage', method 'get'; ns 'storage.retained' for retained;
   *  ns 'appServer.backends' / 'appServer.clients' for those sub-namespaces. */
  | { t: 'call'; id: number; modId: string; ns: string; method: string; args: Json[] }
  /** Subscription-style methods: settings.onChange, storage.watch, storage.retained.watch, events.on, appServer.observe, graph.subscribe.
   *  `credit`: the realm acknowledges the events it has handled (`ack`), and the Host may pause the subscription's source while too many
   *  are unacknowledged (a graph view then queues, and past its bound drops its queue for `stale` and a fresh snapshot). */
  | { t: 'sub'; sub: number; modId: string; ns: string; method: string; args: Json[]; credit?: true }
  | { t: 'unsub'; sub: number }
  /** `n` more events of a crediting subscription were handed to the realm's callback. */
  | { t: 'ack'; sub: number; n: number }
  /** Register a handler living in the realm: appServer.intercept (args: [kind, methods, opts]), services.provide (args: [name, methodNames]). */
  | { t: 'handler'; handler: number; modId: string; ns: string; method: string; args: Json[] }
  | { t: 'unhandler'; handler: number }
  /** Answer to an 'invoke'. */
  | { t: 'return'; id: number; value?: Json; error?: { code: ErrorCode; message: string } }
  /** Worker threads only. */
  | { t: 'heartbeat' } | { t: 'activated' } | { t: 'activate-failed'; error: { code: ErrorCode; message: string } }
  /** Worker threads and renderers (renderer messages carry modId). */
  | { t: 'fault'; modId?: string; message: string; stack?: string };
export type HostToRealm =
  | { t: 'result'; id: number; value?: Json; error?: { code: ErrorCode; message: string; details?: Json } }
  | { t: 'event'; sub: number; data: Json }
  /** Call a registered handler. For intercept: args [message, info]; reply value is the InterceptResult (or null for pass).
   *  For services: args [method, args]. */
  | { t: 'invoke'; id: number; handler: number; args: Json[]; deadlineMs: number }
  /** Worker threads only. */
  | { t: 'activate'; modId: string; entry: string; info: { id: string; version: string; dataDir: string } }
  | { t: 'deactivate' };
// Rules: ids, subs and handlers are positive integers unique per channel and per sender.
// The Host validates permissions on every call (Denied); unknown ns/method → Invalid.
// Interceptor nesting is bounded by deadlines and origin skip (ARCHITECTURE change log v1.1); there is no depth counter.

// ======================================================================== 3. Renderer runtime channel (per window, all mods multiplexed)
// Carries Realm RPC (section 2) for every enabled renderer module of the window, plus:
export type HostToRenderer =
  | { t: 'modules'; modules: { modId: string; url: string; version: string; dataDir: string }[] } // url = codexmod://<modId>/<rev>/<entry>; load/unload to match
  | { t: 'settings'; modId: string; value: Json };
export type RendererToHost =
  | { t: 'probe'; report: ProbeReport };   // once per window load, and again after any adapter-relevant change

// ======================================================================== 4. Sockets (contracts/layout.mjs SOCKETS)
// app.sock:     first line from the relay, one of:
//                 v2 (mux addition 9): {"codexmodsRelay":2,"argv":[...],"envHex":"<hex>"}
//                 v1 (v1.3, still accepted): {"codexmodsRelay":1,"argv":[...]}
//               argv is the exact argv the app passed (e.g. ["-c","features.code_mode_host=true","app-server",
//               "--analytics-default-enabled",...]). envHex is the app's environment as the relay received it: the bytes of
//               `env -0` (NUL-separated NAME=value entries; the first '=' ends the name) in lowercase hex, so values with
//               newlines, quotes or any byte survive (the Host decodes them as UTF-8). The relay sends v1 when `env -0` is
//               unavailable. The mux strips the line (it is never forwarded, observed or logged) and launches that session's
//               primary with these args and, for v2, from the app's environment with only CODEX_HOME (the profile's), the Host's
//               markers (section 5) and BackendLaunch.env set on top (integration.md I11). Named backends keep the Host's
//               environment. A connection whose first line is not a valid header is treated as plain JSONL with default args
//               ['app-server'] and the Host's environment (tests, old relays). After it: raw app-server JSONL, both directions.
// clients.sock: first line {"lease": "<id>", "token": "<token>"}; reply {"ok":true} or close. Then app-server JSONL, except that
//               requests whose method is "codexmods/services.call" with params {name, method, args} are answered by the Host
//               (mux → setLeaseServiceHandler; only the lease owner's services) and never forwarded to a backend.
// proc.sock:    first line {"process": "<name>", "mod": "<modId>", "token": "<token>"}; then Realm RPC objects as JSONL.
// mgmt.sock:    contracts/management.d.ts objects as JSONL.

// ======================================================================== 5. Process environment
// The LOADER sets, before anything else, for every boot including passthrough (ARCHITECTURE §5 profile isolation):
//   process.env.CODEX_HOME = ProfileConfig.codexHome  (userData is fixed by the builder via owl-app.ini, or --user-data-dir for QA;
//   Owl ignores app.setPath('userData'), ARCHITECTURE v1.2)
// and, only when the framework is NOT disabled: process.env.CODEX_CLI_PATH = <Contents>/Resources/codexmods-relay  (the app's
// backend override, adapter backend.configKey).
// framework-main additionally sets (inherited by the app's backend spawn → relay):
//   CODEX_MODS_RUN_DIR       absolute layout.run
//   CODEX_MODS_REAL_CODEX    the real binary (HostStartOptions.realCodexPath)
//   CODEX_MODS_FLAGS_DIR     absolute layout.flags
// Mod processes receive: CODEX_MODS_PROC_SOCKET, CODEX_MODS_PROC_TOKEN, CODEX_MODS_MOD_ID, CODEX_MODS_PROCESS.
// Every process the Host spawns carries CODEX_MODS_GENERATION=<n> and CODEX_MODS_BOOT=<random per Host start> (v1.5: leftovers are
// processes with this profile's CODEX_MODS_RUN_DIR and a CODEX_MODS_BOOT different from the current one, ARCHITECTURE §12.5).
export type EnvContract = Json;
