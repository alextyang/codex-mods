// Internal module boundaries inside the Framework Host (ARCHITECTURE.md §4, §6–§12).
// Each module implements exactly the factory it owns and consumes the others only through these interfaces.
// Every factory is a named export of the listed file. All modules are ESM (.mjs), Node built-ins only.
import type { Json, MessageKind, RpcMessage, MessageInfo, InterceptResult, InterceptOptions, ObserveFilter,
  BackendDefinition, BackendInfo, LeaseDescriptor, Gap, Disposable, ErrorCode,
  DeferredRequest, ResolveReason, RespondResult, ReleaseOptions, ReleaseResult } from '../sdk/index.js';
import type { InstalledMod, OpInput, OpRecord, OpOutcome, ProfileState, Generation, ProfileConfig } from './state.js';
import type { ModManifest } from './manifest.js';
import type { AdapterPack, ProtocolCatalog, ProbeReport } from './adapter.js';
import type { ManagementRequest, ManagementResponse, ManagementEvent } from './management.js';

export type Layout = ReturnType<typeof import('./layout.mjs').layout>;

export interface Log {
  debug(msg: string, data?: Json): void; info(msg: string, data?: Json): void;
  warn(msg: string, data?: Json): void;  error(msg: string, data?: Json): void;
  child(scope: string): Log;
}

// ------------------------------------------------------------------ Bus (framework/host/runtime/bus.mjs → createBus)
// Framework-internal topics (in addition to ARCHITECTURE §8.4), all published with these exact names:
//   framework/op          OpRecord, on every change
//   framework/fault       {modId, realm: 'host'|'renderer'|'process'|'mux', kind, message}   (mux faults are forwarded by the Runtime)
//   framework/quarantine  {modId, reason}                                  (when it calls onQuarantine)
//   framework/probe       ProbeReport, state topic: union of per-window reports (item true if true in any open window); removed windows drop out
//   framework/health      {healthy: boolean, stockAppConflict?: boolean}   (recovery; framework-main adds stockAppConflict)
//   appServer/starting|ready|exited, backend/<qualifiedKey>/<state>
//   window/created|shown|focused|blurred|closed {windowId}                (framework-main, from MainToHost window events; shown: the first time)
//   window/bounds {windowId, bounds?: {x, y, width, height}} · window/title {windowId, title?}   (the window itself, graph-integrity G5.5)
export interface Bus {
  /** state=true stores the value as the topic's current state. */
  publish(topic: string, data: Json, opts?: { state?: boolean }): void;
  subscribe(pattern: string, fn: (data: Json | Gap, topic: string) => void, opts?: { replay?: 'state'; queue?: number }): Disposable;
  state(topic: string): Json | undefined;
}
export declare function createBus(opts: { log: Log }): Bus;

// ------------------------------------------------------------------ Mux (framework/host/mux/index.mjs → createMux)
// Backend identifiers: 'primary', or qualified '<owner>/<key>' where owner is 'mod:<modId>'.
// Mod-facing APIs (opts.backend, {route}, BackendInfo.key) use the mod's LOCAL key or 'primary';
// MuxClient qualifies local keys with its own owner. MessageInfo.backend is local for the client's own backends,
// 'primary' for the primary, and qualified otherwise.
export interface BackendLaunch {
  /** Absolute path of the REAL codex binary (never the relay): HostStartOptions.realCodexPath. */
  command: string;
  /** The app's argv for this session (contains 'app-server', possibly after global -c flags), or ['app-server'] when unknown. */
  args: string[];
  /** Overlaid by the mux on the base environment: the app's own (relay header v2, contracts/ipc.d.ts §4) for a session primary
   *  whose relay sent it, else the Host's. CODEX_HOME is then set to `codexHome`. */
  env: Record<string, string>;
  codexHome: string;
}
export interface MuxClient {
  readonly id: string; // 'mod:<id>' | 'client:<leaseId>'
  /** `intent`: the id of the graph intent this request carries out, so the mux does not claim it again (mux addition 8). */
  request(method: string, params?: Json, opts?: { backend?: string; timeoutMs?: number; intent?: string }): Promise<Json>;
  notify(method: string, params?: Json, opts?: { backend?: string }): void;
  observe(filter: ObserveFilter, listener: (m: RpcMessage | Gap, info: MessageInfo | null) => void,
          opts?: { queue?: number; replay?: 'boot' }): Disposable;
  /** handler may be async; the Runtime passes a proxy that calls into the mod's worker thread. */
  intercept(kind: MessageKind, methods: string[] | '*',
            handler: (m: RpcMessage, info: MessageInfo) => InterceptResult | Promise<InterceptResult>,
            opts?: InterceptOptions): Disposable;
  /** Deferred requests (gate G-defer; client requests: mux addition 5, docs/design/interception.md I1). An interceptor returning
   *  `{defer: true}` on a serverRequest or a clientRequest needs allowedMethods.defer (the framework's own unrestricted clients may always
   *  defer; the Runtime never sets it for a mod's client, graph-integrity G6.4). The request leaves the stream (a server request) or its interceptor chain (a client request)
   *  at once and `onDeferred` receives {token, message, info}, `info.kind` being 'serverRequest' or 'clientRequest'. A defer with no
   *  listener registered is ignored (the request goes on as if it had not been deferred). */
  onDeferred(listener: (d: DeferredRequest) => void): Disposable;
  /** Fires once per token that ends without this client settling it. Client requests: 'appGone' (their client disconnected or was
   *  disposed), 'cancelled' (a mod requester's timeout), 'muxClosed', 'expired' (not settled within tune.maxClientHoldMs, default
   *  600000; the request was released unchanged). Disposing a client releases its held client requests unchanged and tells nobody. */
  onResolved(listener: (token: string, reason: ResolveReason) => void): Disposable;
  /** First answer wins; `delivered` = written and flushed to the backend (a client request: handed to its client), `notDelivered` =
   *  nothing queued, `uncertain` = write error. A client request is answered directly, without the backend. */
  respond(token: string, answer: { result: Json } | { error: { code: number; message: string; data?: Json } }): Promise<RespondResult>;
  /** Behaviour by the token's kind. A server request goes to the app's native UI: `{released}`. A client request goes on through the rest
   *  of the pipeline exactly as if its chain had passed it (routing by key, the intent claim for non-app clients, transmission, response
   *  interceptors), with `opts.params` instead of its own when given (validated as a `replace`'s; `Invalid` on a server request, and the
   *  token stays open). It resolves when the client's response is settled: `{released: true, response: {result} | {error}}` as delivered
   *  to the client; `{released: false, reason}` when the token was already closed or the client is gone (`sent: true` if the request had
   *  reached the backend first). */
  release(token: string, opts?: ReleaseOptions): Promise<ReleaseResult>;
  /** True once this client has transmitted anything to a backend (for activation-failure truthfulness). */
  readonly hasTransmitted: boolean;
  /** Removes all registrations; in-flight requests settle per ARCHITECTURE §6.5. */
  dispose(): Promise<void>;
}
export interface MuxMetrics {
  frames: Record<MessageKind, number>;
  interceptorCalls: Record<string, number>;   // by client id
  interceptorFaults: Record<string, number>;
  latencyMs: { p50: number; p95: number };     // added mediation latency on clientRequest
  backends: BackendInfo[];                     // keys qualified
  deferredPending?: number;                    // open deferred requests (server and client)
}
export interface Mux {
  /** Accept an app connection (from the relay). The app opens several concurrently (v1.2): each is its own app session with its own
   *  primary backend process and handshake; origin is 'app' for all. 'primary' (mod-facing) means the oldest live session's backend. */
  attachApp(stream: import('node:stream').Duplex): void;
  /**
   * rank: interceptor tie-break after priority (ARCHITECTURE §6.4 "install order"); lower runs first.
   * The Runtime passes the mod's position in installedAt order.
   */
  client(id: string, opts?: { rank?: number; maxInFlight?: number;
    allowedMethods?: { observe?: string[] | '*'; request?: string[] | '*'; intercept?: string[] | '*'; defer?: boolean };
    /** An absolute folder: the client's traffic and the threads it starts are private to it (observed, intercepted and delivered to it
     *  only, never to the app or another client); a thread that starts with a cwd under the folder is private from its first notification,
     *  before its start is answered. The Host gives one to internal mods only (mod intelligence's managed threads). */
    hiddenRoot?: string }): MuxClient;
  /** owner = 'mod:<id>' (key is the mod-local key), or 'framework' for a framework backend (an added account's, RM10): no mod names it,
   *  it starts from the app's environment with the primary's config overrides and its own `config` (`-c` pairs), and what it sends that no
   *  key ties to a thread reaches framework clients only. `idleStopMs: null` runs it until it is removed. */
  defineBackend(owner: string, key: string, def: BackendDefinition & { codexHome: string; config?: Record<string, Json>; idleStopMs?: number | null }): Promise<void>;
  removeBackend(owner: string, key: string): Promise<void>;
  listBackends(owner?: string): BackendInfo[];
  issueLease(owner: string, name: string): LeaseDescriptor;
  revokeLease(leaseId: string): void;
  /** Revoke every lease and stop/remove every backend owned by `owner`. Does not delete backend data. */
  disposeOwner(owner: string): Promise<void>;
  /** Late-bound by the composition root after the Runtime exists: answers `codexmods/services.call` lines on lease connections. */
  setLeaseServiceHandler(fn: (leaseOwner: string, call: { name: string; method: string; args: Json }) => Promise<Json>): void;
  onFault(fn: (e: { clientId: string; kind: 'throw' | 'timeout' | 'invalid'; message: string }) => void): Disposable;
  /** Mux addition 1 (docs/design/runtime-core.md R14): what the mux knows of a key, or null. `owner` is the key's thread's owner. */
  keyInfo(family: 'thread' | 'turn' | 'item' | 'process' | 'watch', key: string): { family: string; key: string; thread: string | null; backend: string; owner: string | null } | null;
  // ---- framework placement (RM10): what moving a thread between backends needs, by key; the framework (the native provider) moves it
  /** Other clients' requests keyed by `key` wait until released, then go where the key is then. One holder at a time (else Busy). */
  hold(key: string, holderId: string): { release(): void };
  /** Client requests keyed by `key` sent and not answered yet, other than `exceptClientId`'s. */
  inFlight(key: string, exceptClientId?: string): number;
  /** Where a key is: 'primary' (an app session's backend) or a framework backend's id. */
  homeOf(key: string): string;
  /** Re-home a key (its thread resumed there): its requests go there, its subscribers follow, other backends' frames for it are dropped. */
  rehome(key: string, to: string): void;
  /** Place a key without moving it (a placement restored after a restart); false for a backend that is not a framework one. */
  place(key: string, to: string): boolean;
  /** Told whenever a key is re-homed or a framework backend creates (or resumes) a thread. */
  onPlaced(fn: (change: { key: string; backend: string }) => void): Disposable;
  /** Where keyless creator requests (a new thread) go: a framework backend's id, or null for the app's own. */
  setStartBackend(id: string | null): void;
  readonly startBackend: string;
  metrics(): MuxMetrics;
  close(): Promise<void>;
}
export declare function createMux(opts: {
  catalog: ProtocolCatalog;
  /** Launch for 'primary' or a qualified named backend. For a session primary, `session.argv` is the app's argv from the relay header
   *  (contracts/ipc.d.ts §4); BackendLaunch.args must equal it verbatim. With header v2, `session.env` is the app's environment and
   *  the mux spawns from it, so BackendLaunch.env holds only what the Host sets on top (CODEX_HOME, its markers). Never log it.
   *  Named backends use the oldest session's argv and the Host's environment. */
  launchFor(backendId: string, def?: BackendDefinition & { codexHome: string }, session?: { argv: string[]; env?: Record<string, string> }): BackendLaunch;
  bus: Bus; log: Log;
  /** The Mux listens here itself (contracts/ipc.d.ts §4) and authenticates lease tokens. */
  clientsSocketPath: string;
  /** Called before the primary backend starts; if it resolves true, the app connection is refused (stock-app guard). */
  beforePrimaryStart?: () => Promise<boolean>;
  /** v1.20: AdapterPack.backend.configOverrides applied to every SESSION primary spawn as `-c key=toml` pairs inserted before the
   *  `app-server` token (after the app's own -c pairs, so ours win). `vars` from mux/config-overrides.mjs configOverrideVars(). An unknown
   *  template variable refuses that primary spawn. Named backends are untouched. */
  primaryConfig?: { overrides: Readonly<Record<string, import('./adapter.js').ConfigOverrideValue>>; vars: Readonly<Record<string, string>> };
  spawn?: typeof import('node:child_process').spawn;   // injectable for tests
  /** Overrides of the mux's limits and timers (the `tune` object in mux/index.mjs), for tests and tuning. `maxClientHoldMs` (default
   *  600000, mux addition 5): a deferred client request not settled within it is released unchanged and its holder is told 'expired'. */
  tuning?: Readonly<Record<string, number | undefined>>;
  /** Mux addition 4a: notifications an app session's opt-outs do not keep from the backend (the mux drops them on delivery to the clients
   *  that opted out, so observers see them). Default DEFAULT_UPSTREAM_OPT_INS in mux/index.mjs. */
  upstreamOptIns?: readonly string[];
  /** Mux addition 8: the graph runtime's intent journal (framework/host/graph/journal.mjs). Requests from clients other than the app that
   *  change Codex state or reach outside it are claimed in it before they are sent. Without it, nothing is claimed. */
  journal?: { start(e: { source: string; operation: string; caller: string; origin: string; args: unknown }): string; finish(id: string, phase: 'done' | 'refused' | 'failed', detail?: string): boolean; uncertainNow(id: string): boolean };
}): Mux;

// ------------------------------------------------------------------ Runtime (framework/host/runtime/index.mjs → createRuntime)
export interface ActivationError { code: ErrorCode; message: string; /** true if the mod transmitted to a backend, started a process, or issued a lease before failing. */ effectsAttempted: boolean }
export interface Runtime {
  /** Start the mod's host worker (if entry.host) and announce its renderer module. Resolves when activate settles (≤10 s).
   *  Rejects with a CodexModsError whose details are ActivationError. */
  activate(mod: InstalledMod): Promise<void>;
  /** Dispose, drain ≤5 s, terminate. Idempotent. */
  deactivate(modId: string, reason: string): Promise<void>;
  status(modId: string): 'inactive' | 'activating' | 'active' | 'stopping';
  onFault(fn: (e: { modId: string; realm: string; kind: string; message: string }) => void): Disposable;
  /** Push a new settings value to every realm of the mod. */
  settingsChanged(modId: string, value: Json): void;
  /**
   * Serve Realm RPC (contracts/ipc.d.ts §2–3) on a channel.
   * renderer: one channel per window, multiplexing every mod; modId comes from each message (the page realm is trusted,
   *           ARCHITECTURE §13); the Runtime also sends `modules`/`settings` and receives `probe`/`fault`/`mounted`.
   * process:  one channel per mod process; modId is bound by the authenticated socket handshake and messages naming
   *           another modId are refused (Denied).
   */
  handleRealm(realm: 'renderer', port: RealmPort, identity: { windowId: number }): Disposable;
  handleRealm(realm: 'process', port: RealmPort, identity: { modId: string; process: string }): Disposable;
  /** Run data/migrate (ARCHITECTURE §8.5, §11.4) in a separate worker exposing only MigrationInput. Rejects Timeout. */
  runMigration(opts: { mod: InstalledMod; script: string; stagedDataDir: string; from: number; to: number; timeoutMs: number }): Promise<void>;
  /** Delete every Keychain secret of the mod (remove with deleteData). */
  deleteSecrets(modId: string, publisherFingerprint: string): Promise<void>;
  /** Mods active right now (for boot breadcrumbs). */
  active(): string[];
  /** Framework services (modId 'framework') reachable through ctx.services.call; `caller` is 'mod:<id>'. */
  provideFrameworkService(name: string, handlers: Record<string, (args: Json, caller: string) => Json | Promise<Json>>): Disposable;
  /** For Mux.setLeaseServiceHandler: a lease may call only its owner mod's services. */
  callServiceForLease(leaseOwner: string, call: { name: string; method: string; args: Json }): Promise<Json>;
  close(): Promise<void>;
}
/** A message channel to one realm instance (window renderer, process socket). JSON messages only. */
export interface RealmPort {
  post(message: Json): void;
  onMessage(fn: (message: Json) => void): Disposable;
  onClose(fn: () => void): Disposable;
}
export declare function createRuntime(opts: {
  mux: Mux; bus: Bus; log: Log; layout: Layout;
  /** ModRecord.installSeq, for interceptor rank. */
  rankOf(modId: string): number;
  /** Called when the Runtime decides a mod must be quarantined; Operations persists it. */
  onQuarantine(modId: string, reason: string): void;
  /** Tell framework-main how to serve codexmod://<modId>/<rev>/<path> (dev or store dir); null removes it. */
  announceRenderer(modId: string, module: { packageDir: string; entry: string; rev: string } | null): void;
  /** The graph runtime when the Host's graph runs (by default; not with flags/graph-off) (ctx.graph, docs/graph/04); null or absent otherwise. */
  graph?: import('./graph.js').Graph | null;
}): Runtime;

// ------------------------------------------------------------------ Packages + Operations
// framework/host/packages/index.mjs → createPackages ; framework/host/ops/index.mjs → createOperations
export interface VerifiedPackage { manifest: ModManifest; dir: string; contentHash: string; publisher: string | null }
export interface Packages {
  /** Verify a .codexmod archive (or a dev directory) and extract into a staging dir. Throws Invalid/Denied. */
  verify(source: string, opts?: { dev?: boolean }): Promise<VerifiedPackage>;
  /** Move a verified package into store/<id>/<version> (idempotent by contentHash). Dev packages are not stored. */
  store(pkg: VerifiedPackage): Promise<string>;
  validateManifest(manifest: unknown): ModManifest;   // throws Invalid with a path-precise message
  validateSettings(manifest: ModManifest, value: Json): Json; // returns value with defaults applied; throws Invalid
  gc(keepVersions: (modId: string) => string[]): Promise<void>;
}
/** One requirement a mod has that the build does not meet (docs/design/systems.md "E4 in detail"): the feature or mechanic, its status on
 *  the build, whether the mod requires it, and one sentence naming it and what changed. */
export interface CompatibilityReason { id: string; title: string; status: 'missing' | 'changed' | 'unknown'; required: boolean; sentence: string }
export interface Compatibility {
  /** blocked: a required feature missing; atRisk: a required feature changed or unknown; degraded: an optional one not present. */
  status: 'compatible' | 'degraded' | 'atRisk' | 'blocked';
  /** The required and optional feature or mechanic ids that are missing (`protocol:<m>`, `sdk:component.<Name>`). */
  missingRequired: string[]; missingOptional: string[];
  reasons?: CompatibilityReason[];
  /** Every feature or mechanic the mod needs, required then optional (its `requires`, `optional` and its typed grants' hints). */
  features?: string[];
  /** Graph types the mod built on another mod's, gone with that mod (`missingBecause`); degraded until it registers again (boundary review 6b). */
  missingTypes?: string[]; missingBecause?: string;
}
export interface Operations {
  /** Validate, journal durably, then start asynchronously; resolves with the op id once journaled. Conflict if the mod has one running. */
  start(input: OpInput): Promise<string>;
  get(opId: string): OpRecord | undefined;
  list(filter?: { modId?: string; running?: boolean }): OpRecord[];
  subscribe(fn: (op: OpRecord) => void): Disposable;
  /** Recover unfinished ops at Host start (before activating mods); framework ops are reconciled via recovery.reconcileOp. */
  recover(): Promise<void>;
  /** Activate every enabled mod (skipped in safe mode). */
  activateAll(): Promise<void>;
  state(): ProfileState;
  installed(modId: string): InstalledMod | undefined;
  /** methods: from the adapter protocol. anchors/components/actions: from bus state 'framework/probe' (the union over open windows).
   *  With no report yet, UI items count as present and the result carries missingOptional ['ui:unverified']. */
  compatibility(manifest: ModManifest): Compatibility;
  /** Called by Runtime.onQuarantine. */
  quarantine(modId: string, reason: string): void;
  /** v1.9: re-run recovery.reconcileOp for running framework-level ops now (called by framework-main when framework/health {healthy:true}
   *  is published, so a healthy framework update is finalized on the same boot). */
  reconcileFramework(): Promise<void>;
  /** Persist ProfileState.safeMode (used by Recovery's safe-mode op). */
  setSafeMode(enter: boolean): Promise<void>;
  /** v1.5: the only package GC. Holds the store lock (also held by install/update from verify through record), collects references from
   *  EVERY profile under <root>/profiles (state.json, pendingUpdate, generations, running ops), then deletes unreferenced store versions. */
  gcStore(): Promise<{ removed: string[] }>;
  /** Replace mod records and settings from an LKG generation (used by Recovery's lkg-restore op). */
  restoreFromGeneration(g: Generation): Promise<{ restored: string[]; leftDisabled: { modId: string; reason: string }[] }>;
}
export declare function createPackages(opts: { layout: Layout; log: Log; frameworkVersion: string }): Packages;
export declare function createOperations(opts: {
  layout: Layout; log: Log; packages: Packages; runtime: Runtime; bus: Bus; mux: Pick<Mux, 'disposeOwner'>;
  adapter: AdapterPack;
  safeMode: boolean;
  /** Framework-level ops (framework-update, app-prepare, app-switch, safe-mode, lkg-restore) are delegated to Recovery. */
  recovery: Pick<Recovery, 'runOp' | 'reconcileOp'>;
}): Operations;

// ------------------------------------------------------------------ Recovery (framework/host/recovery/index.mjs → createRecovery)
export interface Recovery {
  /** Record the generation for this boot (creates a new one if the tuple changed). Writes generation into boot.json. */
  beginBoot(): Promise<Generation>;
  /** Health gate inputs. Also subscribes itself to appServer/ready (handshake) and framework/quarantine (fatal). */
  report(signal: 'window-rendered' | 'host-ready' | 'handshake-complete' | 'fatal'): void;
  lkg(): Generation | undefined;
  /** Executes framework-update, app-prepare, app-switch, safe-mode and lkg-restore ops. journal(phase) persists a phase before its effects. */
  runOp(op: OpRecord, journal: (phase: string) => Promise<void>): Promise<{ outcome: OpOutcome; note?: string; result?: Json }>;
  /** For an op still 'running' at Host start (e.g. app-switch awaiting the swap receipt): final outcome, or null to leave it running. */
  reconcileOp(op: OpRecord): Promise<{ outcome: OpOutcome; note?: string; result?: Json } | null>;
  /** Stock-app build vs the running copy's source build; null when equal. */
  appUpdateAvailable(): { stockBuild: string; copyBuild: string } | null;
}
/** True when profile.guardStockApp and the stock app is running with ... (ARCHITECTURE §5). Passed to createMux.beforePrimaryStart. */
export declare function stockAppConflict(profile: ProfileConfig): Promise<{ conflict: boolean | 'unknown'; processes: { pid: number; command: string }[]; error?: string }>;
export declare function createRecovery(opts: { layout: Layout; log: Log; bus: Bus; operationsState: () => ProfileState;
  /** Bound after Operations exists (Recovery is created first). */
  operations: () => Pick<Operations, 'setSafeMode' | 'restoreFromGeneration'>;
  /** Ask framework-main to quit (and optionally relaunch). The app-switch swap helper is the only reopen owner. */
  requestExit(opts: { relaunch: boolean; reason: string }): void;
  appBuild: string; frameworkVersion: string; adapterVersion: string; adapter: AdapterPack }): Recovery;

// ------------------------------------------------------------------ Management (framework/host/management/index.mjs → createManagement)
export interface Management {
  /** One method table for every transport. */
  handle(req: ManagementRequest): Promise<ManagementResponse>;
  subscribe(fn: (e: ManagementEvent) => void): Disposable;
  /** Serve the CLI socket (token file written 0600 next to it). */
  listen(socketPath: string, tokenPath: string): Promise<Disposable>;
  /** Serve a MessagePort-style channel (Adjustments, via framework-main). No token: the channel is private. */
  attach(port: RealmPort): Disposable;
}
export declare function createManagement(opts: { operations: Operations; packages: Packages; runtime: Runtime;
  recovery: Recovery; mux: Mux; bus: Bus; log: Log; layout: Layout }): Management;

// ------------------------------------------------------------------ Host composition (framework/host/main.mjs)
/** Entry for the Host child process (bundled Node, IPC channel to framework-main) and plain Node (headless tests). */
export interface HostStartOptions {
  layout: Layout;
  profile: ProfileConfig;
  adapterDir: string;             // adapters/<build>
  /** The REAL codex binary: replace mode → <Contents>/<codexPath>.real ; override mode → <Contents>/<codexPath>. Tests: fake. */
  realCodexPath: string;
  frameworkVersion: string;
  appBuild: string;
  safeMode: boolean;
  /** v1.13: canonical path of the .app bundle actually running (derived from process.execPath in main); Recovery certifies THIS as
   *  Generation.appCandidate, never the symlink target. Absent in headless tests. */
  runningAppPath?: string;
  /** Channel to framework-main (process.send / 'message' IPC); absent in headless tests. */
  parent?: RealmPort;
}
export interface HostHandle { mux: Mux; runtime: Runtime; operations: Operations; management: Management; recovery: Recovery; bus: Bus; close(): Promise<void> }
export declare function startHost(opts: HostStartOptions): Promise<HostHandle>;
