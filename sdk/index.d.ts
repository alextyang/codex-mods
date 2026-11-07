// @codexmods/sdk v1 — the complete mod-facing contract (ARCHITECTURE.md §8; the guide is docs/AUTHORING.md).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Disposable { dispose(): void | Promise<void> }

// ---------------------------------------------------------------- errors (§8.2)
export type ErrorCode =
  | 'Denied'          // not permitted (permission, consent, ownership)
  | 'Unavailable'     // not performed: target missing, not transmitted, mod disabled
  | 'OutcomeUnknown'  // may have happened (transmitted, no reply)
  | 'Busy'            // limit reached (in-flight cap, queue)
  | 'Timeout'         // a local deadline passed before anything was sent or applied
  | 'Invalid'         // input failed validation
  | 'Conflict'        // concurrent change, duplicate registration, operation already running
  | 'Incompatible'    // the app build lacks something required
  | 'Disposed';       // the scope or registration has ended
export declare class CodexModsError extends Error {
  constructor(code: ErrorCode, message: string, details?: Json);
  readonly code: ErrorCode;
  readonly details?: Json;
}

// ---------------------------------------------------------------- entry points (§7.2)
export interface ModDefinition {
  /** Runs in the mod's worker thread inside the Host. */
  host?(ctx: HostContext): void | Disposable | (() => void | Promise<void>) | Promise<void | Disposable | (() => void | Promise<void>)>;
  /** Runs in every app window, in the page main world. */
  renderer?(ctx: RendererContext): void | Disposable | (() => void | Promise<void>) | Promise<void | Disposable | (() => void | Promise<void>)>;
}
export declare function defineMod(definition: ModDefinition): ModDefinition;

// ---------------------------------------------------------------- shared namespaces
export interface ModInfo { readonly id: string; readonly version: string; readonly dataDir: string }

export interface Log {
  debug(message: string, data?: Json): void;
  info(message: string, data?: Json): void;
  warn(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}

/** Where a setting is set (docs/design/systems.md S14): the app, a project or a thread. */
export type SettingsScope = 'app' | { project: { provider: string; id: string } } | { thread: { provider: string; id: string } };
/** What changed: the key, the scope where it changed and the new effective value there (narrower scopes that do not override it follow). */
export interface SettingsChange { key: string; scope: SettingsScope; value: Json }

export interface Settings<T extends Json = Json> {
  /** One flat document: every declared key's value at the app scope, its default where none is set. */
  get(): Promise<T>;
  /** A key's effective value at the app, a project or a thread (a thread brings its own project; give one of them). */
  get(key: string, where?: { project?: { provider: string; id: string }; thread?: { provider: string; id: string } }): Promise<Json>;
  /** Set a key at a scope (the app by default); resolves when the change is stored (`unchanged` when it was already). */
  set(key: string, value: Json, opts?: { scope?: SettingsScope }): Promise<{ opId: string | null; unchanged?: true }>;
  /** Remove the value stored at a scope (it inherits again; at the app scope, its default). */
  reset(key: string, opts?: { scope?: SettingsScope }): Promise<{ opId: string | null; unchanged?: true }>;
  /** The app document after every change, and what changed when a key changed at a scope. */
  onChange(fn: (value: T, change?: SettingsChange) => void): Disposable;
}

/** A mod's setting, for mod.json's `settings` list (contracts/manifest.d.ts SettingDeclaration). */
export declare function setting<D extends Omit<import('../contracts/manifest').SettingDeclaration, 'key'>>(key: string, spec: D): D & { key: string };

export interface StorageTransaction {
  get(key: string): Json | undefined;
  set(key: string, value: Json): void;
  delete(key: string): void;
  list(prefix?: string): string[];
}
export interface Storage {
  get(key: string): Promise<Json | undefined>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  /** fn runs synchronously against a snapshot; writes commit atomically. Throws Conflict if a concurrent commit won. */
  transaction<R>(fn: (tx: StorageTransaction) => R): Promise<R>;
  /** Fires after commits that touch keys with this prefix, in any realm. */
  watch(prefix: string, fn: (keys: string[]) => void): Disposable;
}
export interface ModStorage extends Storage {
  /** Same API; excluded from data snapshot/restore and migration. Its format must never change in place. */
  readonly retained: Storage;
}

/** A mod's permissions as the user decides them (docs/design/framework-ui.md F8). A required one is `allow`; an optional one is the user's decision. */
export interface Permissions {
  /** What it holds of one of its declared permissions; a grant it does not declare is refused. */
  state(grant: string): Promise<'allow' | 'ask' | 'deny'>;
  /** Ask the user for one of its optional permissions, in the window in front (Allow, Don't allow); their Allow is kept as the decision. */
  request(grant: string, text?: { title?: string; subtitle?: string; body?: string }): Promise<{ granted: boolean }>;
  /** A decision that only gains while it runs; one that takes something away restarts the mod instead. */
  onChange(fn: (grant: string, decision: 'allow' | 'ask' | 'deny') => void): Disposable;
}

export interface Secrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type Gap = { gap: { from: number; to: number; reason: 'overflow' | 'restart' | 'late-subscribe' } };
export interface Events {
  /** topic may end in `*` (prefix match). replay 'state' delivers the current value of a state topic first. */
  on(topic: string, fn: (data: Json | Gap, topic: string) => void, opts?: { replay?: 'state' }): Disposable;
  /** Only `mod/<ownId>/...` topics may be emitted. */
  emit(topic: string, data: Json): void;
  /** Current value of a state topic (§8.4), or undefined. */
  state(topic: string): Promise<Json | undefined>;
}

/** Who called a service: a mod, a client holding a mod's lease (an app of yours outside Codex), or the app (the framework, the user's own surfaces). */
export type ServiceCaller = { readonly kind: 'mod'; readonly id: string } | { readonly kind: 'client'; readonly mod: string } | { readonly kind: 'app' };
export interface Services {
  /** Handlers receive and return JSON, and are told who called (`meta.caller`). name is unique per mod. */
  provide(name: string, handlers: Record<string, (args: Json, meta: { readonly caller: ServiceCaller }) => Json | Promise<Json>>): Disposable;
  /** Throws Unavailable if the providing mod is disabled or the service is not provided. modId 'framework' addresses framework services. */
  call(modId: string, name: string, method: string, args?: Json): Promise<Json>;
}

// ---------------------------------------------------------------- app-server plane (§6)
export type MessageKind =
  | 'clientRequest'       // client → server request
  | 'clientNotification'  // client → server notification
  | 'serverResponse'      // server → client response
  | 'serverNotification'  // server → client notification
  | 'serverRequest'       // server → client request (e.g. approvals)
  | 'clientResponse';     // client → server response to a serverRequest

export interface RpcMessage {
  readonly id?: string | number;
  readonly method?: string;         // absent on responses
  readonly params?: Json;
  readonly result?: Json;
  readonly error?: { code: number; message: string; data?: Json };
}
export interface MessageInfo {
  readonly kind: MessageKind;
  /** The request method, also for responses. */
  readonly method: string;
  readonly origin: 'app' | `mod:${string}` | `client:${string}`;
  readonly backend: string;          // 'primary' or a named backend key
  readonly affinityKey?: string;     // e.g. the thread id
  /** The app session the frame belongs to, for frames of an app session's primary backend: its number in connection order and the
   *  app's `clientInfo.name` from that session's initialize (once known). Absent for named backends. */
  readonly session?: { readonly id: number; readonly client?: string };
}
export type InterceptResult =
  | undefined
  | { replace: RpcMessage }
  | { drop: true }                                                  // notifications only
  | { respond: { result: Json } | { error: { code: number; message: string; data?: Json } } } // clientRequest, serverRequest
  | { route: string };                                              // clientRequest only: backend key, re-pins affinity
export interface InterceptOptions {
  priority?: number;            // default 0; higher runs first
  timeoutMs?: number;           // default 1000, max 30000
  onError?: 'pass' | 'reject';  // default 'pass'
}
export interface ObserveFilter {
  kinds?: MessageKind[];        // default: all
  methods?: string[] | '*';     // names or prefixes ending in '/'; default '*'
}
export interface BackendDefinition {
  /** Relative to the mod's backends dir; created on first start. Default: the key. */
  codexHome?: string;
  env?: Record<string, string>;
  args?: string[];
  idleStopMs?: number;          // default 600000
}
export interface BackendInfo { key: string; owner: string; state: 'stopped' | 'starting' | 'ready' | 'exited' }
export interface LeaseDescriptor { id: string; socketPath: string; token: string }

export interface AppServer {
  /** Unavailable if not transmitted; OutcomeUnknown if transmitted without reply. Never retried. */
  request(method: string, params?: Json, opts?: { backend?: string; timeoutMs?: number }): Promise<Json>;
  notify(method: string, params?: Json, opts?: { backend?: string }): void;
  observe(filter: ObserveFilter, listener: (message: RpcMessage | Gap, info: MessageInfo | null) => void,
          opts?: { queue?: number; replay?: 'boot' }): Disposable;
  readonly backends: {
    define(key: string, definition?: BackendDefinition): Promise<void>;
    remove(key: string, opts?: { deleteData?: boolean }): Promise<void>;
    list(): Promise<BackendInfo[]>;
  };
  readonly clients: {
    issue(opts: { name: string }): Promise<LeaseDescriptor>;
    revoke(leaseId: string): Promise<void>;
  };
}
export interface HostAppServer extends AppServer {
  intercept(kind: MessageKind, methods: string[] | '*',
            handler: (message: RpcMessage, info: MessageInfo) => InterceptResult | Promise<InterceptResult>,
            opts?: InterceptOptions): Disposable;
  // No request is held for a mod (graph-integrity G6.4): it stops an app action through the graph's interceptors (`stopped`), and answers
  // a request whenever it decides through its instance (Approval.answer, Question.answer), the request waiting at its source meanwhile.
}

// ---------------------------------------------------------------- processes (§7.3)
export interface Processes {
  /**
   * Start a declared process. A session (graph-integrity G8.2) may be given more arguments, after its manifest's, and the folder it runs
   * in (an absolute path; a program on the Mac starts in the user's home otherwise, the mod's own code in its package); a restart after a
   * failure starts it with the same. A running process is not started again (with other options: Invalid, stop it first). A session
   * declared with `instances` runs as up to that many at once, each addressed as `name#key` here and in `stop`, `write` and `on` (a key
   * of letters, digits, `_` and `-`): one more is `Busy`.
   */
  start(name: string, opts?: { args?: readonly string[]; cwd?: string }): Promise<void>;
  stop(name: string): Promise<void>;
  /** JSON-RPC call into the process over its Host connection (a worker, or a session that is the mod's own code). */
  call(name: string, method: string, params?: Json): Promise<Json>;
  /** A session's input (G8.2): written in order, waiting while the process has not taken what came before; at most 1 MiB a call, and
   *  `Busy` while more than 4 MiB written is not taken yet (wait for the earlier writes). */
  write(name: string, data: string): Promise<void>;
  /**
   * `started` {pid, executable? (where a program on the Mac was found)}, `exited` {code, signal}, `message` (what the mod's own process
   * emits), `output` (a session's, line by line: {stream: 'stdout' | 'stderr', line, truncated?}, a line cut at 1 MiB; held back, the
   * program waiting, while a listener's realm has not caught up).
   */
  on(name: string, event: 'started' | 'exited' | 'message' | 'output', fn: (data: Json) => void): Disposable;
}

// ---------------------------------------------------------------- UI plane (§9)
/**
 * The app's own components (real where the adapter exposes them, themed fallbacks otherwise), plus the kit and the lent parts. A page of a
 * mod's is the app's settings layout: `SettingsSection` (its `Header` {title, subtitle?, actions?} and `Content`) holding a `SettingsCard`
 * of `SettingsRow`s ({label, description?, control?}: label left, control right), with the app's `Button` ({color: 'primary' | 'secondary'
 * | 'danger', onClick}) and `Switch` ({checked, onChange}) as controls.
 */
export type ComponentName =
  | 'Button' | 'Switch' | 'TextField' | 'Menu' | 'Dialog'
  | 'SettingsSection' | 'SettingsCard' | 'SettingsRow' | 'Tooltip' | 'Icon'
  | keyof KitComponents;
/** The framework's own components: stable props on every build, drawn from the theme's variables and through the app's own pieces where it has them. */
export interface KitComponents {
  /** A named glyph of the framework's set; an unknown name draws the default. */
  Glyph: { name: string; size?: number; spinning?: boolean; className?: string };
  IconTile: { glyph?: string; size?: 'md' | 'sm'; tone?: 'danger' | 'warning' | 'success' | 'info' };
  Badge: { label: unknown; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; glyph?: string; spinning?: boolean };
  /** One message with up to a few actions; the first action is the main one. */
  Banner: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; title?: unknown; message?: unknown; glyph?: string; actions?: readonly { label: string; onClick?: () => void; disabled?: boolean; danger?: boolean; glyph?: string }[]; onClose?: () => void };
  EmptyState: { glyph?: string; tone?: string; title: unknown; description?: unknown; actions?: readonly { label: string; onClick?: () => void; primary?: boolean; glyph?: string }[] };
  SearchField: { value?: string; onChange?: (value: string) => void; placeholder?: string; ariaLabel?: string };
  SegmentedControl: { options: readonly (string | { value: string; label?: string; disabled?: boolean })[]; value?: string; onChange?: (value: string) => void; ariaLabel: string; disabled?: boolean };
  Select: { options: readonly (string | { value: unknown; label?: string; disabled?: boolean })[]; value?: unknown; onChange?: (value: unknown) => void; ariaLabel: string; disabled?: boolean };
  MenuButton: { items: readonly ({ label: string; icon?: string; danger?: boolean; disabled?: boolean; onSelect?: () => void } | { separator: true })[]; ariaLabel?: string; label?: string; icon?: string; disabled?: boolean };
  Tabs: { items: readonly (string | { value: string; label?: string; icon?: string; count?: number | string; dot?: boolean | string })[]; value?: string; onChange?: (value: string) => void; ariaLabel: string };
  Checkbox: { checked?: boolean; onChange?: (checked: boolean) => void; ariaLabel: string; disabled?: boolean };
  /**
   * A Setting drawn as the framework's settings pages draw it, with their controls, reset, notes and errors (graph-integrity G3.6), read
   * and set as this mod: a Setting (a snapshot, or its ref), or one of this mod's own settings by its key at the app, a project or a chat.
   * A chat's or a project's is the one of its `settings` this mod defined with that key. Another mod's setting is set only as the user.
   */
  SettingRow: { setting: GraphSnapshot | GraphRef | { key: string; project?: GraphRef; thread?: GraphRef } };
  // The kit's and the lent parts' callbacks (graph-integrity G7.1) each get a last argument `{asUser?}`: the user's intent when their own
  // input called it, for the mod whose content the part is drawn in (`ctx.graph.invoke(..., {asUser})` from the renderer realm).
  // The parts the framework lends (graph-integrity G2.3): the app's conversation pieces with stable props, fed by the mod's own data (an
  // agent mod's view of its chats). Drawn through the app's own pieces where the adapter exposes them, themed otherwise; actions call back.
  /** The transcript's scroller, keeping to its end while it is there. */
  Transcript: { children?: unknown; ariaLabel?: string };
  /** A turn: what was said and done in it; `running` shows that it is working. */
  Turn: { status?: 'running' | 'completed' | 'failed' | 'stopped'; children?: unknown };
  /** A message: the user's as a sent one, the agent's as markdown. */
  Message: { role?: 'user' | 'agent'; content?: Json; text?: string; streaming?: boolean };
  /** A step: its kind's glyph, title and status; expanded, its detail, a command's output or an edit's diff. */
  StepRow: { kind?: 'command' | 'edit' | 'tool' | 'search' | 'web' | 'reasoning' | 'other'; title?: string; status?: 'running' | 'completed' | 'failed';
    detail?: Json; output?: string; diff?: string; expanded?: boolean; onToggle?: (expanded: boolean) => void };
  /** A unified diff, or `files: [{path, diff}]`. */
  DiffView: { diff?: string; files?: readonly { path?: string; diff: string }[] };
  /** A file by its name; `onOpen(path)` when chosen. */
  FileChip: { path: string; onOpen?: (path: string) => void };
  /** An approval's card: its options (Approval.options), each answered by `onAnswer(optionId)`. */
  ApprovalCard: { title: string; detail?: Json; options: readonly { id: string; label: string; kind?: 'approve' | 'deny' | 'cancel' }[]; onAnswer?: (optionId: string) => void; busy?: boolean };
  /** A question's card: its prompts (Question.prompts), answered together by `onAnswer({[promptId]: {choices?, text?}})`. */
  QuestionCard: { prompts: readonly { id: string; header?: string; prompt: Json; choices?: readonly { id: string; label: string }[]; other?: boolean; secret?: boolean }[];
    onAnswer?: (answers: Record<string, { choices?: string[]; text?: string }>) => void; onSkip?: () => void; busy?: boolean };
  /** A chat's header: its title, what it says under it, its actions. */
  ThreadHeader: { title: string; subtitle?: string; actions?: readonly { label: string; icon?: string; onClick?: () => void }[] };
  /** The composer: Enter sends `onSubmit(text)`; Stop while `busy` with `onStop`; its pickers. */
  Composer: { placeholder?: string; value?: string; onChange?: (text: string) => void; onSubmit?: (text: string) => void; onStop?: () => void; busy?: boolean; disabled?: boolean; pickers?: readonly unknown[];
    /** The mod's attachments, as chips; `onAttach()` adds one, `onRemoveAttachment(id)` takes one away. */
    attachments?: readonly { id: string; name?: string }[]; onAttach?: () => void; onRemoveAttachment?: (id: string) => void };
  ModelPicker: { models: readonly (string | { id: string; label?: string })[]; value?: string; onChange?: (id: string) => void; label?: string };
  EffortPicker: { efforts: readonly (string | { id: string; label?: string })[]; value?: string; onChange?: (effort: string) => void; label?: string };
  /**
   * A chat's row, as the sidebar draws one: title, working or waiting for you, unread, its time; `onOpen` when chosen; its menu. `drag`:
   * its chat's ref, which the user can then drag to a place that takes chats (graph-integrity G5.3). `badges`: elements after the title
   * (the framework's own rows put a chat's marks there, its rules' badges: G2.2).
   */
  ChatRow: { title: string; status?: 'idle' | 'working' | 'waitingForYou'; unread?: boolean; time?: number; selected?: boolean; onOpen?: () => void;
    menu?: readonly { label: string; onSelect: () => void; danger?: boolean }[]; drag?: GraphRef; badges?: readonly unknown[] };
  /**
   * A place of this mod's that takes what the user drops on it (G5.3): `accepts`, the concepts it takes (`['Thread']`); `onDrop({ref})`
   * with the instance dropped, one of them: a chat from the sidebar (the app's own rows or the framework's) or from a ChatRow with `drag`.
   * While one would be taken there it says so, as the theme draws it.
   */
  DropTarget: { accepts: readonly string[]; onDrop: (dropped: { ref: GraphRef }) => void; children?: unknown; className?: string; style?: Record<string, unknown> };
}
export interface Theme {
  /** Token name → current CSS value. */
  tokens(): Record<string, string>;
  onChange(fn: (tokens: Record<string, string>) => void): Disposable;
  readonly appearance: 'light' | 'dark';
}
// ---------------------------------------------------------------- presentation rules (docs/design/systems.md S5 to S9, "E2 in detail")
/** A presentation type of docs/graph/03 the framework realizes on this build (`SidebarItem`, `ThreadHeader`, `MessageBlock`, ...). */
export type PresentationType = string;
/** What every rule takes: its id (stable in the mod), the subject type it is for (with its subtypes), the subjects it keeps (a `where`,
 *  docs/design/public-hooks.md §3.1) or names (`of`), its slot, its priority. */
export interface RuleBase {
  id: string; for?: string; where?: Where; of?: GraphRef | readonly GraphRef[]; slot?: string; priority?: number;
  /** The app's own parts the rule is about (docs/design/public-hooks.md §3.10; `ui.parts` lists them): `hide` takes them out, `decorate`
   *  relabels them (`label`, `icon`, `tooltip`), `replace` draws them (renderer realm). Protected parts are refused. */
  part?: string | readonly string[];
}
/** One of the app's own parts of a component (docs/design/public-hooks.md §3.10). */
export interface AppPart {
  readonly slot: string; readonly part: string; readonly title: string; readonly for?: readonly string[]; readonly operation?: string;
  /** Never hidden, relabelled or replaced. */ readonly protected?: boolean;
  /** May be hidden, never relabelled or replaced. */ readonly optional?: boolean;
  /** This build draws it. */ readonly supported: boolean;
  /** What this build does to it: hide, decorate (relabel), reorder, replace. */ readonly kinds?: readonly string[];
}
/**
 * Text that follows its subject (docs/design/public-hooks.md §3.13), drawn by the page with no call per row (the host realm's way to be
 * live): a string with `{{path}}` or `{{path|number|percent|duration|relative}}`, or `{bind: path, format?}`. Paths are the `where`
 * grammar's; a value not loaded, or one the mod may not read, is empty. A list's entry may carry `when` (a where on the subject).
 */
export type LiveText = string | { readonly bind: string; readonly format?: 'number' | 'percent' | 'duration' | 'relative' };
/**
 * What a callback is given when the user runs it (docs/design/mod-surfaces.md P2): the subject the presentation shows, its window, the
 * thread or draft it is about, and how it was run. JSON only: a host-realm callback gets it through the Host. Pass `window` on to an
 * operation that should stay in the window it came from (docs/design/graph-layers.md §2). `_presentation`: the instance it was run on
 * (the mechanism layer: there, not promised).
 */
export interface ActionEnv {
  readonly subject: Required<GraphRef> | null;
  readonly _presentation: Required<GraphRef> | null;
  readonly window: Required<GraphRef> | null;
  readonly thread: Required<GraphRef> | null;
  readonly draft: Required<GraphRef> | null;
  /** The pane the control is in, captured as the callback starts: a hosted chat's token, `'route'` for the window's own page; each goes back as `{pane}` as it is. null: no control of a page's (the palette, a menu, a key chord). */
  readonly pane: string | null;
  readonly via: 'click' | 'keys' | 'menu' | 'palette' | 'context-menu' | 'slash' | 'mention';
  /** A slash command's arguments: what the user typed after its name (letters, digits, spaces and `. : _ \ -`; '' when nothing). */
  readonly args?: string;
  /**
   * The user's intent (graph-integrity G7.1): present when the user's own input ran a renderer-realm callback (not from a native menu, the
   * app's context menus, whose choice has no input in the page: an act from there is the mod's, and asks). Pass it with a call the
   * user means (`ctx.graph.invoke(ref, op, args, {asUser: env.asUser})`), within a few seconds, once: the call is the user's through this
   * mod (it still needs its grant for the act; a mod act's approval is not asked). A host-realm call never carries one.
   */
  readonly asUser?: string;
}
/** A callback the user runs. In the host realm it runs in the mod's worker (the page calls it through the Host, at most 30 s); what it
 *  returns is JSON of at most 64 KiB. */
export type ActionCallback = (env: ActionEnv) => void | Json | Promise<void | Json>;
export interface Badge { id: string; text?: LiveText; tooltip?: LiveText; icon?: unknown; run?: ActionCallback; when?: Where }
export interface RuleAction { id: string; title: LiveText; icon?: unknown; run: ActionCallback; when?: Where }
/** A field given as data, or (renderer realm) as a function of the subject the presentation shows. */
export type OfSubject<T> = T | ((subject: { ref: { type: string; provider: string; id: string }; state: { [k: string]: Json }; links: { [k: string]: Json }; attached?: { [modId: string]: Json } }) => T);
/** `summary` (public-hooks.md §3.13): how a subject reads where it is listed or headed, without renaming it: `{title?, subtitle?, icon?}`
 *  or the title alone (title at most 120 characters, subtitle 160; icon an emoji), live text in the host realm
 *  (`'[{{@mod/ticket}}] {{title}}'`); each field the first rule's in order that gives it. A chat's: its sidebar row (title, its second line
 *  the subtitle, the icon its emoji) and hover card, its header (title), the command palette's rows (title, icon) and the "@" list's
 *  (title, subtitle, icon; the chip it inserts says the title). */
export interface DecorateSpec extends RuleBase { badges?: OfSubject<Badge[]>; label?: OfSubject<LiveText | { text: LiveText } | Array<LiveText | { text: LiveText }>>; tooltip?: OfSubject<LiveText>; actions?: OfSubject<RuleAction[]>;
  summary?: OfSubject<LiveText | { title?: LiveText; subtitle?: LiveText; icon?: LiveText }> }
export interface ComponentSpec extends RuleBase { render: unknown }
export interface AddSpec extends RuleBase { slot: string; items: OfSubject<Json[] | RuleAction[]> }
/** `order`: the names of the app's parts (and the mod's entries' ids) first, in that order, the others after as they were; or (renderer
 *  realm) a function of the slot's entries (the app's as `{native, index}`, this mod's as they are, another mod's only as `{mod, rule}`;
 *  a summary is never reordered). The palette's `groups` (its group names, `ui.parts('Palette')`) and `commands` (Command ids, first in
 *  their group) take a list only. */
export interface ReorderSpec extends RuleBase { slot: string; order: readonly string[] | ((items: unknown[]) => unknown[]) }
/** The app's own CSS variables, each set to a theme token or another of them (never a raw value), or one for each appearance
 *  (`{light, dark}`: the one the theme shows now). `where`, read on each window's Window (its `thread`, its `project`, what is attached
 *  to them; as this mod may read them), styles only the windows where it holds, following what each shows. */
export interface StyleSpec { id: string; variables: { [cssVariable: string]: string | { light: string; dark: string } }; where?: Where }
/** A status (`ui.status`). `tone` colors it with the theme's own color; `meter` is a ring (`max` 1 by default); `icon` an element (renderer realm). */
export interface StatusSpec {
  id: string;
  place: 'titleBar' | 'sidebarFooter' | 'composer';
  text?: LiveText;
  tooltip?: LiveText;
  icon?: unknown;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  meter?: { value: number | { bind: string }; max?: number | { bind: string } };
  run?: ActionCallback;
  subject?: GraphRef;
  when?: Where;
  for?: string;
  where?: Where;
  priority?: number;
}
/** A choice (`ui.choices`): `in` the places ('composer', 'newChat', 'slashMenu', 'menus', 'settings'; every place by default); `hide` ids, a
 *  where on the offered subject or (renderer realm) a test; `order` ids first, in that order; `label` an id's text or {title, description}. */
export interface ChoicesSpec {
  id: string;
  in?: readonly ('composer' | 'newChat' | 'slashMenu' | 'menus' | 'settings')[];
  hide?: readonly string[] | Where | ((subject: GraphSnapshot) => boolean);
  order?: readonly string[];
  label?: { readonly [id: string]: string | { title?: string; description?: string } };
  add?: readonly { id: string; title: string; description?: string; run: ActionCallback }[];
  priority?: number;
}
/** A registered rule: `accepted` settles once the Host has checked it (false: refused, the reason in the mod's log). `update(patch)`
 *  changes what it declares in place (its id stays): the newer registration replaces the older in each window once accepted. */
export interface RuleHandle extends Disposable {
  readonly accepted: Promise<boolean>; update(patch: Record<string, unknown>): Promise<boolean>;
  /** The parts it names that this build does not draw, once accepted. */
  readonly unsupported?: readonly string[];
}
/** A subject whose decorations draw wherever it is shown (docs/design/graph-layers.md §3.4). */
export type DecoratedSubject = 'Thread' | 'Message' | 'UserMessage' | 'Turn' | 'Step' | 'Request' | 'Setting' | 'Project' | 'Automation' | 'App'
  | 'AgentMessage' | 'File' | 'BrowserTab' | 'ChangeSet' | 'FileChange';
/** `ui.decorate(<subject>)`: one rule in each place that presents the subject; `places` where it draws, `unsupported` the kinds given
 *  that no place draws (said, never dropped quietly). */
export interface SubjectDecorationHandle extends RuleHandle { readonly places: readonly string[]; readonly unsupported: readonly string[] }
/** A question's field (graph-integrity G4.2): a setting's declaration, its schema and kinds, drawn by the settings' own controls; no
 *  scope, `requires` or `needs`. A text's `control: 'secret'` is masked and never kept, with no default. */
export type AskField = Omit<import('../contracts/manifest').SettingDeclaration, 'scope' | 'requires' | 'needs' | 'control' | 'default'>
  & { control?: import('../contracts/manifest').SettingDeclaration['control'] | 'secret'; default?: Json };
/** A question to the user (`ui.ask`, docs/design/systems.md "E7 in detail" decision 7): about `subject`, for `purpose` (confirm,
 *  approve, ...), with 1 to 3 actions (the first is what the requester's `confirm` chooses); `until` (ms since the epoch) ends it
 *  unanswered, such as an interceptor's deadline. The Dialog names the mod that asks; the framework sets that name. `fields`
 *  (at most 12) the user fills in, each a setting's declaration (`AskField`); `signal` withdraws it. */
export interface AskSpec {
  subject: GraphRef; purpose: string; title: string; message: string; actions: ReadonlyArray<{ id: string; title: string }>; until?: number;
  fields?: ReadonlyArray<AskField>;
  signal?: AbortSignal;
}
/** How a question was settled, once: an action chosen (with its fields' `values` by key, each of its field's kind), or cancelled (by the user,
 *  the requester: it withdrew it, or the framework: its time passed, its subject or window went, the requester stopped). */
export type AskResult = { readonly choice: string; readonly by: 'user' | 'requester'; readonly values?: Readonly<Record<string, Json>>;
  /** The user's intent with their answer, to a renderer-realm asker only (graph-integrity G7.1): as `ActionEnv.asUser`. */
  readonly asUser?: string }
  | { readonly cancelled: true; readonly by: 'user' | 'requester' | 'framework'; readonly reason: string };
/** Which presentations `ui._read` returns: of a type (with its subtypes), in a window (its Window's ref or id), of a subject. */
export interface PresentationQuery { type?: PresentationType; window?: GraphRef | string | number; subject?: GraphRef }
/** The data rules, in both realms (needs `graph.present`, bare or `graph.present:<PresentationType>`), and what is on screen (03's
 *  generic `_read` and `_act`, with the graph's grants: `graph.read`, `graph.act` on the presentation type and operation). In the host
 *  realm a rule's fields are data, except its entries' `run` callbacks, which stay in the worker (mod-surfaces.md P1); a field computed
 *  from its subject (`OfSubject` as a function) is the renderer realm's. */
export interface DataRules {
  /** What is shown: the Presentation instances matching the query, each with its subject, window and parent in its links. The
   *  mechanism layer (docs/design/graph-layers.md §2): there, not promised; act on data and declare instead. */
  _read(query?: PresentationQuery): Promise<GraphSnapshot[]>;
  /** Do what the user can do on a presentation instance (one of its type's `_` operations), as this mod; an operation that changes its
   *  subject is that subject's own, with its grants and approvals (docs/design/systems.md "E7 in detail", decision 3). Mechanism. */
  _act(ref: GraphRef, operation: string, args?: Json | readonly Json[]): Promise<GraphOutcome & { readonly id: string }>;
  /** The app's own parts of a component (docs/design/public-hooks.md §3.10), with whether this build draws each. */
  parts(presentation: PresentationType, opts?: { slot?: string }): Promise<AppPart[]>;
  /** Message content (public-hooks.md §3.14): a redaction is data, so either realm's; the renderer realm's `content` also draws parts. */
  readonly content: { redact(spec: RedactSpec): RuleHandle };
  /** Ask the user in a Dialog in the window they are in, one at a time per window, after the framework's own; reported as a Dialog
   *  of its subject (its purpose its slot) that only this mod can `_confirm` or `_cancel` (`ui._act`). */
  ask(spec: AskSpec): Promise<AskResult>;
  /**
   * A notification (public-hooks.md §3.14), named as this mod by the framework: the app's own toast in the window the user is in (its
   * first two actions as its buttons), or the app's own desktop notification (four buttons; a click on it opens its subject); `auto` (the
   * default) is a toast while an app window is focused. `dedupe` replaces this mod's earlier one of that id; `sticky` keeps a toast until it
   * is closed. Its handle's `update` shows it again changed (it replaces itself); `dismiss` ends it. An action's run gets
   * `{notification, action, subject, window}`.
   */
  notify(spec: NotifySpec): { readonly id: string | null; readonly shown: Promise<string>; update(patch: Partial<NotifySpec>): Promise<boolean>; dismiss(): Promise<boolean> };
  /** Open in (public-hooks.md §3.14): an entry of the app's "Open in" menus (a chat's, a project's, a file's); its run's `env.subject` is
   *  what it opens. A `ui.choices('ExternalApp', {add})`. */
  readonly openIn: { add(spec: { id: string; title: string; icon?: unknown; description?: string; run: ActionCallback; priority?: number }): RuleHandle };
  /** Starting points (public-hooks.md §3.14): a new chat from `spec` (`Project.newThread`'s spec: prompt, attachments, environment, branch,
   *  model, effort, mode, access, send, open; or a function of the env giving one) in the new chat page's starters above its composer, the
   *  palette's "New chat" group and a project's context menu (`in` some of them; `where` on the Project). It starts in the project it was
   *  chosen for (the menu's project; else the new chat's; none: a chat of no project) and opens unless `open: false`; one that sends asks
   *  the user first. */
  readonly newThread: { starter(spec: { id: string; title: string; description?: string; icon?: unknown; spec: { [field: string]: Json } | ((env: ActionEnv) => { [field: string]: Json } | Promise<{ [field: string]: Json }>);
    in?: readonly ('newThread' | 'palette' | 'project')[]; where?: Where; priority?: number }): RuleHandle & { readonly places: readonly string[] } };
  /** On a subject wherever it is shown (`ui.decorate('Thread', {badges, actions})`: its sidebar row and its chat's header; `in` narrows to
   *  some of its places, `for` to a subtype), or on one presentation type with its slots. */
  decorate(subject: DecoratedSubject, spec: DecorateSpec & { in?: string | readonly string[] }): SubjectDecorationHandle;
  decorate(presentation: PresentationType, spec: DecorateSpec): RuleHandle;
  /** Composer controls (mod-surfaces.md §3.6) on every composer (a chat's, a side chat's, the new chat's); `for`/`where` narrow them. */
  readonly composer: {
    /** A button after the composer's own (`env.draft` is its Draft), or (renderer realm) a component in one of its places.
     * A button: `tooltip`, `disabled` (off: it does not run), `pressed` (a toggle that is on) and a short `badge` beside its title; change
     *  them in place with its handle's `update`. */
    control(spec: { id: string; title: string; icon?: unknown; run: ActionCallback; place?: 'toolbar'; tooltip?: string; disabled?: boolean; pressed?: boolean; badge?: string | number;
      for?: string; where?: { [field: string]: Json }; priority?: number }
      | { id: string; place?: 'toolbar' | 'pickers' | 'aboveInput' | 'belowInput'; render: unknown; for?: string; where?: { [field: string]: Json }; priority?: number }): RuleHandle;
    /** A slash command, a row of the app's own slash menu on every composer: `run(env)` (env.draft, env.thread) or a `prompt` inserted into the Draft.
     * `aliases`: more names it is found by (and takes arguments after); `group`: a heading of its own; `when: 'empty'`: only while the
     *  composer holds nothing else; `where`: only on the composers whose Draft it keeps. */
    slash(spec: { id: string; name: string; title?: string; description?: string; arguments?: string; aliases?: string[]; group?: string; when?: 'empty' | 'any'; where?: Where; priority?: number }
      & ({ run: ActionCallback } | { prompt: string })): RuleHandle;
    /** A mention source: a section of the app's own "@" list on every composer, its rows from `search` (env.draft, env.thread). */
    mention(spec: MentionSourceSpec): RuleHandle;
    /** An inline suggestion (reference-mods.md RM8): when the user pauses at the end of a line in any composer, `provide(env)` (env.before
     *  and env.after the text around the caret, env.draft, env.thread) gives the text drawn as ghost text after the caret; Tab takes it,
     *  Escape leaves it, anything else typed clears it. Asked after `debounceMs` (500 by default) once there are `minChars` (4); an older
     *  answer never replaces a newer one. The first source in the user's order is asked. */
    suggest(spec: { id: string; provide: (env: ActionEnv & { readonly before: string; readonly after: string }) => string | null | Promise<string | null>;
      debounceMs?: number; minChars?: number; priority?: number }): RuleHandle;
    /** An attachment source (public-hooks.md §3.14): a row of the "Add" section of every composer's "+" and "@" list; choosing it runs
     *  `pick(env)` (`env.draft`: that composer's Draft) and attaches what it gives (one or at most 20: `{text, name}`, `{url, title}`, a
     *  Skill's ref, a file's path) as this mod's own `Draft.attach` calls: the Host takes it only with `graph.act` for `Draft.attach`. */
    attachSource(spec: { id: string; title: string; description?: string; icon?: unknown; pick: (env: ActionEnv) => Json | readonly Json[] | Promise<Json | readonly Json[]>; priority?: number }): RuleHandle;
  };
  /** Context menu entries (mod-surfaces.md §3.5): in every menu the app shows for a subject of `for` (a chat's row and header menus, a
   *  file's or folder's in the Files and Changes trees), in a section of the mod's own; `env.subject` is what the menu was opened on. */
  readonly contextMenu: { add(spec: { id: string; for: string; where?: { [field: string]: Json }; title: string; run: ActionCallback; priority?: number }): RuleHandle };
  /** A status (public-hooks.md §3.14): a short live reading in the window's title bar (`titleBar`: with `for`, a chat's, on its page;
   *  without, the window's, on every page), the sidebar's footer or a composer's footer, drawn the app's way (a button when it has `run`).
   *  It reads its place's subject (a composer's Draft, the title bar's chat or App, the sidebar's App) or the `subject` it names, as this
   *  mod may read it: text, tooltip and meter may be live, `when` shows it only while its subject holds. At most three show in a place. */
  status(spec: StatusSpec): RuleHandle;
  /**
   * The Dock (public-hooks.md §3.14). `badge`: a count of the instances `count.where` keeps (as this mod may read them, kept current; none
   * gives the badge back), or a `value` (a count or text of at most 16 characters); `combine: 'add'` adds a count to the app's own. The
   * latest mod's badge shows; disposing (or the mod stopping) gives it back. `attention`: the Dock icon bounces once (`informational`, the
   * default) or until the app comes forward (`critical`). Both need `graph.act:DockBadge`.
   */
  readonly dock: {
    badge(spec: { id: string; count: { type: string; where?: Where }; combine?: 'replace' | 'add' } | { id: string; value: number | string | null; combine?: 'replace' | 'add' }):
      { readonly id: string; update(patch: { count?: { type: string; where?: Where }; value?: number | string | null; combine?: 'replace' | 'add' }): Promise<boolean>; dispose(): Promise<boolean> };
    attention(kind?: 'informational' | 'critical'): Promise<true>;
  };
  /** A section on one of the app's settings pages (the renderer realm's `settings` also has its own pages). */
  readonly settings: SettingsSections;
  /** Themes (public-hooks.md §3.14): one listed on the app's Appearance page. The user turns it on there: it is written as the app's own
   *  appearance settings (each variant's chrome theme and code theme; a theme of one variant sets the appearance too), and the user's own
   *  values come back when they turn it off or this mod stops; a setting the user changes meanwhile stays theirs. The chosen theme is
   *  applied again whenever its mod runs. */
  readonly theme: { add(spec: { id: string } & ThemeSpec): RuleHandle };
  /** Where a link the user opens from the app's pages goes (public-hooks.md §3.14). `where` is on the link; the mods' routes are tried in
   *  the user's order of their mods, the first that takes it decides: `open: 'app'` (the app's own browser, where it has one) or
   *  `'browser'` (the default browser) only when the user did not choose where (a plain click); `'none'` does not open it however it was
   *  asked for, and the window says this mod stopped it; `run(env)` is this mod opening it itself (a plain click on a link from a chat
   *  this mod may read; one whose chat the app does not say only when it may read every chat; one that did not run leaves it to the app). Links the app routes itself (codex:,
   *  chatgpt.com) are only ever stopped. Not the link menu's "New tab" and "New window" on a chat's link, links inside the app's browser's
   *  own pages, a file's path, or a link from outside the app. */
  readonly links: { route(spec: { id: string; where?: Where; priority?: number } & ({ open: 'app' | 'browser' | 'none' } | { run(env: LinkEnv): unknown })): RuleHandle };
  /** What the pickers offer of a subject (public-hooks.md §3.11), keyed by the subject, not the picker: models and efforts (the composer's
   *  model menu, the slash menu's /model and /reasoning), access modes (the composer's access menu), slash commands (the slash menu).
   *  The selected entry always stays; an added entry's choice runs `run` here, never the app's choice; `unsupported` says what this
   *  framework does not do yet for the subject. */
  choices(of: 'Model' | 'SlashCommand' | 'ExternalApp' | 'Environment' | { setting: 'effort' | 'access' }, spec: ChoicesSpec): RuleHandle;
  /** A banner above every page: the app's own page banner, after its own content (renderer realm). */
  banner(spec: { id: string; render: unknown; where?: { [field: string]: Json }; priority?: number }): RuleHandle;
  /** A filter over one of the app's lists (public-hooks.md §3.12), off until this mod turns it on in a window (`on({window?})`: the window
   *  named, else the host realm's window in front or the renderer realm's own; a disposed handle acts on nothing). `list`: 'sidebar'
   *  (the chats: `where` may be text, a chat's title or preview; `threads` the chats to list), 'transcript' (a chat's records: its steps
   *  and messages, or the type `for` names; one under way is never left out), 'files' (the file tree: each File's `path` and `name`),
   *  'changes' (the Changes list and its diffs: each changed file's `path` and `kind`). With several on, an item is listed when every one
   *  keeps it; the list's notice names each and the user's "Show all" turns them all off there. `keep` is the renderer realm's own test.
   *  A filter stays on through `update`. */
  filter<L extends 'sidebar' | 'transcript' | 'files' | 'changes'>(list: L, spec: { id: string; title: string; where?: L extends 'sidebar' ? string | Where : Where;
    threads?: L extends 'sidebar' ? readonly GraphRef[] : never; for?: L extends 'transcript' ? string : never; keep?: (item: GraphSnapshot) => boolean; priority?: number }):
    RuleHandle & { on(opts?: { window?: GraphRef }): Promise<unknown>; off(opts?: { window?: GraphRef }): Promise<unknown> };
  /** The sidebar: its orders and this mod's sections (its filters are `filter('sidebar', ...)`). */
  /** Named layouts the user picks like the app's own, kept as they move between chats until they pick another; what they change themselves is theirs, and each region
   *  it set goes back when it ends. `Window.setLayout('<mod>/<id>')` picks one: done with `{layout, partial: [{region, why}]}`. `mode` sets parameters for the app's own modes. */
  readonly layouts: {
    add(spec: LayoutSpec & { id: string; keys?: string | string[]; where?: Where; priority?: number }): RuleHandle;
    mode(mode: 'chat' | 'split' | 'full', params: Pick<LayoutSpec, 'sidebar' | 'side' | 'bottom'>): RuleHandle;
  };
  /** A destination in the rail (where the app shows it) and the sidebar's navigation: the user pins and orders it as the app's own. `open`: this
   *  mod's page or command, or a ref; `sidebar`: a `ui.sidebar.view` of this mod's, shown with the page; `icon`: an element or a component
   *  (renderer realm), or text (an emoji). */
  readonly destinations: { add(spec: { id: string; title: string; icon?: unknown; open: { page: string } | { command: string } | GraphRef; sidebar?: string; where?: Where; priority?: number }): RuleHandle };
  readonly sidebar: {
    /** An order of its lists: `in` 'pinned', 'chats', 'projects' (the project groups), 'project' (every project's chats) or a Project's
     *  ref (its chats), omitted every list of chats; `by` a path on the listed instances (`-path` descending, as this mod may read them)
     *  or, in the renderer realm, a comparator. The first order naming a list wins; the unknown sort last; the user's order returns
     *  when it goes. */
    order(spec: { id: string; in?: 'pinned' | 'chats' | 'projects' | 'project' | GraphRef; by: string | ((a: GraphSnapshot, b: GraphSnapshot) => number); priority?: number }): RuleHandle;
    /** A view of this mod's for the sidebar (renderer realm): its body while a page whose destination names it is shown; `render` gets `{view: {id, title}, page: {mod, id}}`. */
    view(spec: { id: string; title: string; render: unknown; where?: Where; priority?: number }): RuleHandle;
    /** A section of this mod's, drawn with the app's own group and rows: the chats its `where` selects (live) or its `of` names, as this
     *  mod may read them, in its `sort` (a path, `-path` descending); `limit` rows before the app's "Show more" (10); before the app's
     *  groups (`position: 'top'`) or after them; its actions on the title's hover. A view: its chats stay in the app's own lists. */
    section(spec: { id: string; title: string; where?: Where; of?: readonly GraphRef[]; sort?: string; collapsed?: boolean; limit?: number;
      position?: 'top' | 'end'; actions?: readonly { id?: string; title: string; run: ActionCallback }[]; priority?: number }): RuleHandle };
  /** This mod's panel views (declared with `ui.panel` in its renderer realm), opened or closed in a window from either realm: the window
   *  named, else the one in front. `placement` (public-hooks.md §3.14): 'panel' (a tab, the default), 'modal' (the framework's dialog
   *  above the route, its title the view's; the view's `placement` says so and its `close` closes it), 'side' (a tab of the right panel,
   *  the chat beside it) or 'window' (a new window of the app's, the view's tab filling it; the outcome's value is that Window). */
  readonly panels: {
    open(id: string, opts?: { window?: GraphRef; target?: 'right' | 'bottom'; instance?: string; focus?: boolean; placement?: 'panel' | 'modal' | 'side' | 'window' }): Promise<GraphOutcome>;
    close(id: string, opts?: { window?: GraphRef; instance?: string }): Promise<GraphOutcome>;
  };
  /** Palette sources (mod-surfaces.md §3.2): rows in the app's palette (Cmd+K and the floating search window). */
  readonly palette: { source(spec: PaletteSourceSpec): RuleHandle };
  /** Menu bar entries (mod-surfaces.md §3.4), macOS's menu bar: in a section of the mod's own at the end of an app menu, or a menu of its own. */
  readonly menus: { add(spec: MenuEntrySpec): MenuEntryHandle };
  /** Mod commands (mod-surfaces.md P5, public-hooks.md §3.14, both realms): a row of the app's palette in its "Mod commands" group (or its
   *  own `group`), each of its `keys` a hidden menu bar entry holding the chord in every window; one that `appliesTo` a subject type is offered
   *  only while the window shows one (`where` on it) and is in that subject's context menus, its run's `env.subject` that subject. */
  readonly commands: { add(spec: CommandSpec): RuleHandle };
  hide(presentation: PresentationType, spec: RuleBase): RuleHandle;
  /** The agent's records hidden in place (public-hooks.md §3.12): a one-line "Hidden by <mod>" stub with Show; never one still under way
   *  or waiting on the user. `in`: some of its places (StepBlock, MessageBlock, TurnView, DiffView). */
  hide(subject: 'Step' | 'Message' | 'Turn' | 'FileChange', spec: { id: string; where?: Where; of?: GraphRef | readonly GraphRef[]; in?: readonly string[]; priority?: number }): RuleHandle;
  /** Chats or projects taken out of the sidebar's listings (its groups, lists and the mods' sections, public-hooks.md §3.12), in every window,
   *  with the window's notice ("2 hidden by <mod>", "Show": shown again in that window); never the chat a window shows, nor one working,
   *  waiting for the user or failed, nor a project's group that holds the chat shown. For a mod's own helper chats; the user's work is
   *  filtered visibly (`filter('sidebar', ...)`). */
  hide(subject: 'Thread' | 'Project', spec: { id: string; where?: Where; of?: GraphRef | readonly GraphRef[]; priority?: number }): RuleHandle & { readonly places: readonly ['Sidebar'] };
  /** The app's commands taken out of the palette (public-hooks.md §3.12), in every window, with the palette's own "Hidden" section ("Show
   *  N hidden by <mod>", offered wherever one of them would have matched; shown again in that window). A command the graph does not hold is
   *  read as its row gives it (its id and title). */
  hide(subject: 'Command', spec: { id: string; where?: Where; of?: GraphRef | readonly GraphRef[]; priority?: number }): RuleHandle & { readonly places: readonly ['Palette'] };
  /** Reorder a slot: an order of names (data, either realm), or (renderer realm) a function of its entries. */
  reorder(presentation: PresentationType, spec: ReorderSpec): RuleHandle;
  add(presentation: PresentationType, spec: AddSpec): RuleHandle;
  style(spec: StyleSpec): RuleHandle;
}
/** What a panel view's component is given (docs/design/mod-surfaces.md §3.1): its tab, the chat it is beside, the tab's own state. */
export interface PanelContext {
  /** `tabId` null and `placement` 'modal' when it is shown in a modal (its state its own while open). */
  readonly mod: string; readonly view: string; readonly instance: string | null; readonly tabId: string | null; readonly placement?: 'modal';
  readonly isActive: boolean; readonly isVisible: boolean;
  /** The chat the panel is beside (a local chat's route), or null on the new chat and other pages. */
  readonly thread: Required<GraphRef> | null;
  /** The Draft of the composer beside it: its chat's, or the new chat's on the home page; null elsewhere. */
  readonly draft: Required<GraphRef> | null;
  /** The window it is in. */
  readonly window: Required<GraphRef> | null;
  /** The project it is about: its chat's, or the one the new chat targets; null without one. */
  readonly project: Required<GraphRef> | null;
  /** The tab's own state: kept while the tab is hidden and the chat is switched away and back; mod storage keeps what must outlive it. */
  readonly state: Json | null; setState(next: Json): void;
  close(): void;
}
/**
 * A panel view: a tab of the app's side and bottom panels, offered in every chat, the new chat and remote tasks, restored after a restart
 * where the app restores its own tabs (a chat's, in the main window), and never closed for the mod: while its mod loads or is turned off
 * the tab says so. `targets` (default both) narrows the panels; `retain: false` unmounts it while hidden; `persist: false` keeps it out of
 * the saved layout.
 */
export interface PanelSpec { id: string; title: string; icon?: string; render: unknown; headerRows?: unknown; targets?: Array<'right' | 'bottom'>; retain?: boolean; persist?: boolean; priority?: number }
/** What a named layout arranges (layouts.md D6): each region as it should be. A tab is a kind of the app's, or a mod's view `<mod>/<id>`. */
export interface LayoutSpec {
  title: string; icon?: string; keep?: 'while-active' | 'once';
  sidebar?: { open?: boolean; edge?: 'left' | 'right' };
  side?: { open?: boolean; size?: number; tab?: string };
  bottom?: { open?: boolean; height?: number; tab?: string; at?: 'below' | 'left' | 'right' };
  regions?: { [id: string]: { open?: boolean; size?: number } };
  main?: 'chat' | 'tab' | { page: string };
}
/** A page of a mod's own in the window's main region (layouts.md D7). `id` is part of its path; `render` gets `{page: {id, title}}`; `header.actions` is a component in the page's header. */
export interface MainPageSpec { id: string; title: string; render: unknown; header?: { title?: string; actions?: unknown }; priority?: number }
/** A region of a mod's own at the workspace's edge (layouts.md WL4a): its render gets `{region: {key, edge, size}}`; its width 160 to 960 px. */
export interface RegionSpec { id: string; title: string; icon?: string; edge: 'left' | 'right'; width?: { default?: number; min?: number; max?: number }; render: unknown; where?: Where; priority?: number }
export interface PanelHandle extends RuleHandle {
  /** Open the view in this window's panel (or focus its tab): false when the window shows no page with panels. */
  open(opts?: { target?: 'right' | 'bottom'; instance?: string; focus?: boolean }): boolean;
  close(opts?: { instance?: string }): boolean;
}
/** What a mention row inserts: the app's own file chip (an absolute path; the model is given the path), a markdown link, text, or an
 *  instance's own chip (`ref`, public-hooks.md §3.14: a codex File's or Folder's file chip, an installed Skill's skill chip, each named as
 *  the app names it; another instance's row title as text).
 *
 * What a picked row inserts, and `context`: text (or text content) the agent gets with the next message from that composer that still has
 * the mention (as data, naming the mod; public-hooks.md §3.14; at most 4096 characters).
 */
export type MentionInsert = ({ file: string; directory?: boolean } | { link: { href: string; text?: string } } | { text: string } | { ref: GraphRef } | {})
  & { context?: string | { parts: { kind: 'text'; text: string }[] } };
export interface MentionRow { id: string; title: string; description?: string; keywords?: string[]; disabled?: boolean; insert?: MentionInsert }
export interface MentionSourceSpec {
  id: string; title: string;
  /** The rows for the text typed after "@" (debounced; an older answer never replaces a newer; at most 3 s in the host realm). */
  search(query: string, env: ActionEnv): MentionRow[] | Promise<MentionRow[]>;
  /** After the app's leading "Add" section (first, the default) or after all of its sections. */
  position?: 'first' | 'last';
  /** Ask only from this many characters (default 0: also with nothing typed, then at most 4 rows); `limit` rows (default 5, at most 10). */
  minQuery?: number; limit?: number; debounceMs?: number; priority?: number;
}
/** A palette row. A static row (`items`) runs its `run`, or its `choose`; a searched row is data: its `choose` is `{open}`, `{command}` or
 *  `{run: true}` (the source's own `choose(row, env)`). `ref` names the instance it stands for (the env's subject when chosen). */
export interface PaletteRow {
  id: string; title: string; description?: string; keywords?: string[]; disabled?: boolean; ref?: GraphRef;
  run?: ActionCallback; choose?: { open: GraphRef } | { command: string } | { run: true };
}
export type PaletteGroupKey = 'suggested' | 'thread' | 'navigation' | 'panels' | 'workspace' | 'skills' | 'configure' | 'app';
export interface PaletteSourceSpec {
  id: string;
  /** A group of the source's own (`title`, above or below the app's groups), or one of the app's groups it joins (`group`). */
  title?: string; group?: PaletteGroupKey; position?: 'above' | 'below';
  /** Rows the palette filters and ranks itself, as it does its own commands. */
  items?: PaletteRow[];
  /** Rows for the text typed (debounced; an older answer never replaces a newer; at most 3 s in the host realm). */
  search?(query: string, env: ActionEnv): PaletteRow[] | Promise<PaletteRow[]>;
  /** A searched row chosen (`choose: {run: true}`, or no `choose`). */
  choose?(row: { id: string; title: string; ref?: GraphRef }, env: ActionEnv): void | Promise<void>;
  /** Answer only when the text starts with this word; the rest is the query ("note buy milk"). */
  trigger?: string; minQuery?: number; limit?: number; debounceMs?: number; priority?: number;
}
/** A menu bar entry: `keys` (an Electron accelerator) is held when no one holds it (the app's menu first, then earlier mods); `run` gets
 *  the env (`via` 'menu' or 'keys', `checked` after the click for a checkbox, `window` the one in front). */
export interface NotifySpec {
  title: string; body?: string; kind?: 'info' | 'success' | 'warning' | 'error'; subject?: GraphRef;
  actions?: { id: string; title: string; run: (env: { notification: string; action: string; subject: GraphRef | null; window: GraphRef | null }) => void | Promise<void> }[];
  surface?: 'auto' | 'desktop' | 'toast'; dedupe?: string; sticky?: boolean;
}
export interface CommandSpec {
  id: string; title: string; run: ActionCallback; keys?: string | string[]; keywords?: string[]; description?: string; group?: string; icon?: string;
  /** A where on the Window it is offered in (`{'current.type': 'CodexThread'}`). */
  when?: Where;
  /** A subject type it applies to; `where` on that subject. */
  appliesTo?: string; where?: Where;
  priority?: number;
}
export interface MenuEntrySpec {
  id: string; title: string; in: 'file' | 'edit' | 'view' | 'window' | 'help' | { menu: string; before?: 'window' | 'help' };
  keys?: string; type?: 'item' | 'checkbox' | 'radio'; checked?: boolean; enabled?: boolean; visible?: boolean; priority?: number;
  run: ActionCallback;
}
export interface MenuEntryHandle extends Disposable {
  readonly accepted: Promise<boolean>;
  /** Change the entry in place: its title, keys, checked, enabled or visible. */
  update(patch: Partial<Pick<MenuEntrySpec, 'title' | 'keys' | 'checked' | 'enabled' | 'visible'>>): Promise<boolean>;
}
/** A markdown site: the two message sites are told now; the others are reserved for the sites a binding tells later ('other' until then). */
export type ContentSite = 'agent-message' | 'user-message' | 'reasoning' | 'plan' | 'file-preview' | 'review-comment' | 'other';
/** What every part renderer takes besides its claim: the sites it draws at (default: all), its subject's type and state (with `for`, only
 *  where a site names its subject), and whether it draws a part still arriving ('native': the app's own until it is complete). */
export interface ContentRuleBase { id: string; sites?: ContentSite[]; for?: string; where?: { [field: string]: Json }; whileStreaming?: 'render' | 'native'; priority?: number }
/** What a part renderer's component is given. `Native` with `nativeProps` is the app's own rendering of the part: render it to keep the
 *  app's look, wrap it, or not at all. Its content is the model's or the user's text: never set it as HTML. */
export interface PartProps<P> { part: P; site: ContentSite; subject: GraphRef | null; streaming: boolean; Native: unknown; nativeProps: Json; children?: unknown }
/** A fenced block: its language (lower case), the fence's info, its text, and `open` while its fence is not closed yet (it streams). */
export interface CodePart { language: string; info: string; text: string; raw: string; open: boolean }
export interface InlineCodePart { text: string }
/** A link as the app's sanitiser left it (https, http, codex, or no scheme), with its own text. */
export interface LinkPart { href: string; text: string; title?: string; scheme: string | null; host: string | null }
/** `::name{attrs}` (leaf), `:::name ... :::` (container): a part the model must be taught to write. */
export interface DirectivePart { name: string; attributes: { [k: string]: string | number | boolean }; groupedAttributes?: Array<{ [k: string]: string | number | boolean }>; rawText?: string; isBlock: boolean; isLastBlock: boolean }
/**
 * Message content (mod-surfaces.md §3.3): parts of every markdown the app shows (the agent's answers, your messages, plans, previews),
 * drawn by a component of the mod. The first rule in order claims a part; a part drawn by a rule that throws shows the app's own.
 */
export interface ContentApi {
  /** A fenced block in these languages (case-insensitive). */
  code(spec: ContentRuleBase & { language: string | string[]; render: (props: PartProps<CodePart>) => unknown }): RuleHandle;
  /** Inline code whose text matches, such as `#123` or `PROJ-45`. */
  inlineCode(spec: ContentRuleBase & { match: string | RegExp; render: (props: PartProps<InlineCodePart>) => unknown }): RuleHandle;
  /** A link by scheme, host (and its subdomains) and/or a pattern on its href. A scheme of the mod's own never arrives: the app drops it. */
  link(spec: ContentRuleBase & { scheme?: 'https' | 'http' | 'codex' | Array<'https' | 'http' | 'codex'>; host?: string | string[]; match?: string | RegExp; render: (props: PartProps<LinkPart>) => unknown }): RuleHandle;
  /** A directive by name (not one of the app's own); `groupConsecutive` draws adjacent blocks of it as one (their attributes in `groupedAttributes`). */
  directive(spec: ContentRuleBase & { name: string; groupConsecutive?: boolean; render: (props: PartProps<DirectivePart>) => unknown }): RuleHandle;
  /** Text that matches, in a message's prose (paragraphs, headings, list items, table cells, emphasis, a link's text), drawn by `render`
   *  (public-hooks.md §3.14). Never over what a redaction masks; `for`/`where` read the chat. */
  text(spec: ContentRuleBase & { match: string | RegExp; render: (props: PartProps<InlineCodePart>) => unknown }): RuleHandle;
  /** Text masked where it is shown (either realm): each match of `match` shows as `as` (at most 40 characters, default "•••"), in prose
   *  and code; copying shows the mask too. Only where the mod may read the chat. */
  redact(spec: RedactSpec): RuleHandle;
}
/** A redaction (`ui.content.redact`): what it matches, what it shows instead, and where. */
export interface RedactSpec { id: string; match: string | RegExp; as?: string; sites?: ContentSite[] | ContentSite; for?: string; where?: { [field: string]: Json } }
/** A mod's own page in the app's Settings: drawn in the app's frame with its title; its entry in the Mods group (under the mod, the
 *  default) or one of the app's own groups. Its component gets `{mod, page}`. */
export interface SettingsPageSpec { id: string; title: string; group?: 'mods' | 'personal' | 'integrations' | 'coding'; render: unknown; priority?: number }
/** A section of a mod's on one of the app's settings pages (`ui.settings.section`): `page` is its slug (`/settings/<slug>`); `render` a
 *  component (renderer realm) or `settings` the Settings whose rows it shows (either realm; as the mod may read them, at most 50). */
export type SettingsSectionSpec = { id: string; page: string; title?: string; priority?: number } & ({ render: unknown } | { settings: readonly GraphRef[] });
/** A theme's variant: the app's chrome theme of that appearance. Colours are #rrggbb; `contrast` 0 to 100 (50 by default); `added`,
 *  `removed`, `skill` the diff and skill colours (the appearance's defaults otherwise); `translucent: false` opaque windows; `fonts` the
 *  UI and code font families; `code` one of the app's code themes (its id). */
export interface ThemeVariant { surface: string; ink: string; accent: string; contrast?: number; added?: string; removed?: string; skill?: string;
  translucent?: boolean; fonts?: { ui?: string; code?: string }; code?: string }
/** A theme (`ui.theme.add`): a title, a light variant, a dark one, or both. */
export interface ThemeSpec { title: string; description?: string; light?: ThemeVariant; dark?: ThemeVariant }
/** Settings in either realm: a section on one of the app's pages, after its own, in the app's own section with its title. */
export interface SettingsSections {
  section(spec: SettingsSectionSpec): RuleHandle;
}
export interface SettingsApi extends SettingsSections {
  page(spec: SettingsPageSpec): RuleHandle & { open(): boolean };
  /** This mod's page in Settings, or one of its own pages: false when it cannot be opened here. */
  open(page?: string): boolean;
}
/** The rules with components and functions, in the renderer realm only. `replace`'s component gets `{subject, native, decorations}`. */
export interface ComponentRules {
  panel(spec: PanelSpec): PanelHandle;
  /** A region beside the app's main view in every window: `Window.setRegion('<mod>/<id>', {open, size})` sets it in one window. */
  readonly regions: { add(spec: RegionSpec): RuleHandle };
  /** Something at one of the rail's ends, where the app shows the rail. */
  readonly rail: { add(spec: { id: string; slot: 'header' | 'footer'; render: unknown; priority?: number }): RuleHandle };
  /** A page in the main region, in the app's history. `open()` opens it here: false when it cannot. `Window.open({page: '<mod>/<id>'})` opens any mod's. */
  readonly pages: { add(spec: MainPageSpec): RuleHandle & { open(): boolean } };
  readonly content: ContentApi;
  readonly settings: SettingsApi;
  replace(presentation: PresentationType, spec: ComponentSpec): RuleHandle;
  /** A region of a presentation; and `host.thread(ref, {composer?})`: one of the app's chats, live, in a place of this mod's (a page, a panel tab, a region, a modal): an element to render, one pane with its own transcript and composer (layouts.md D8). */
  readonly host: ((presentation: PresentationType, spec: ComponentSpec & { slot: string }) => RuleHandle) & { /** What this build can host: a chat with its composer, a chat alone (`transcript`), and which panel kinds. */ supported(): { readonly thread: boolean; readonly transcript: boolean; readonly tabs: readonly string[] }; thread(ref: GraphRef, opts?: { composer?: boolean; key?: string }): unknown; /** One of the app's panel kinds for a chat: 'review' (its changes), 'subagents'; any other says so in its place. */ tab(kind: string, thread: GraphRef): unknown };
  render(presentation: PresentationType, spec: ComponentSpec & { for: string }): RuleHandle;
}

export interface Ui extends DataRules, ComponentRules {
  /** The app's own React (the same instance the app renders with). */
  readonly react: unknown;
  /** Real app components where the adapter exposes them, themed fallbacks otherwise. */
  readonly components: Record<ComponentName, unknown>;
  readonly theme: Theme;
  readonly commands: {
    /** A command: see the rule API's `commands.add`. */
    add(spec: CommandSpec): RuleHandle;
  };
}

// ---------------------------------------------------------------- scheduler and thread holds (preview, gate G-sched)
export type JobDelivery = 'normal' | 'overdue' | 'uncertain';
export type JobState = 'pending' | 'started' | 'done' | 'uncertain' | 'failed' | 'cancelled';
export interface JobContext {
  readonly id: string;
  readonly generation: number;
  /** The wall-clock deadline, ms since the epoch. */
  readonly at: number;
  readonly data: Json;
  /** 'overdue': it fell due while the Host was down (or later than the grace after its deadline, e.g. after Mac sleep).
   *  'uncertain': an earlier delivery recorded `started` and no outcome. Do NOT repeat the effect: reconcile, then done(). */
  readonly delivery: JobDelivery;
  readonly overdue: boolean;
  readonly uncertain: boolean;
  readonly lateMs: number;
  readonly startedAt?: number;
  readonly previousOutcome?: Json;
  /** Record the outcome. The first one wins; later calls answer { recorded: false }. In an uncertain delivery only done() may follow. */
  done(result?: Json): Promise<{ recorded: boolean; state: JobState }>;
  /** The effect may or may not have happened. Recorded, reported, never retried. */
  uncertain(note?: string): Promise<{ recorded: boolean; state: JobState }>;
  /** Nothing happened (rejected before send). Terminal; the framework still does not retry. */
  failed(note?: string): Promise<{ recorded: boolean; state: JobState }>;
}
export interface JobRecord {
  id: string; generation: number; at: number; data: Json; state: JobState; createdAt: number;
  startedAt?: number; endedAt?: number; delivery?: JobDelivery; lateMs?: number; outcome?: Json; notified?: boolean;
  /** Earlier generations that were replaced, newest first (at most 3), each with its own state and outcome. */
  superseded?: JobRecord[];
}
/** Jobs and their intent and outcome records live in `storage.retained` (keys `sched/job/<id>`), so a data restore never resurrects a finished job. */
export interface Scheduler {
  /**
   * Idempotent per (id, generation): an existing record of that generation wins whatever its state, so activation code may call this
   * every time. A higher generation replaces the old job (a pending one is cancelled); a lower one rejects Conflict.
   */
  schedule(spec: { id: string; at: number | Date; data?: Json; generation?: number }): Promise<{ status: 'scheduled' | 'replaced' | 'exists'; job: JobRecord }>;
  /** Cancels a pending job. A job that already started is not affected. */
  cancel(id: string): Promise<{ cancelled: boolean; state: JobState | 'unknown' }>;
  /**
   * One handler per id. The framework records `started` before calling it. Returning without an outcome records `done`; throwing
   * records `uncertain`. After a crash between `started` and an outcome the job is delivered ONCE with delivery 'uncertain'.
   */
  on(id: string, handler: (job: JobContext) => void | Promise<void>): Disposable;
  get(id: string): Promise<JobRecord | undefined>;
  list(opts?: { state?: JobState }): Promise<JobRecord[]>;
}
// ---------------------------------------------------------------- what the agent gets (graph-integrity G3.5: sdk/agent.mjs's helpers)
/** Where a part applies: everywhere, or in one project's chats. */
/** Which threads a helper adds to: those in a project; and (a function's per-turn text) those a where on the thread keeps, which may
 *  read attached data (`{'@my.mod/role': 'orchestrator'}`, reference-mods.md RM9). */
export interface AgentScope { readonly project?: GraphRef; readonly where?: Where }
/** What a tool answers: text, `{text}`, `{image}` (a data: or https: URL), or a list of them. */
export type AgentContent = string | { text: string } | { image: string } | ReadonlyArray<string | { text: string } | { image: string }>;
export interface AgentTool {
  /** 1-64 letters, digits, `_` or `-`; the app shows a call as a step with this name. */
  name: string;
  /** What the agent reads to decide when to call it. */
  description: string;
  /** Its arguments: an object schema (`s.object({...})` of the graph SDK, or a JSON Schema object). None: no arguments. */
  input?: object;
  scope?: AgentScope;
  /** Runs when the agent calls it; throws to fail. Up to 10 minutes. */
  run(args: Json, env: { readonly thread: Required<GraphRef>; readonly turn: Required<GraphRef>; readonly call: string }): AgentContent | void | Promise<AgentContent | void>;
}

// ---------------------------------------------------------------- the graph (docs/graph/04)
/** A graph ref. The provider is the mod's id for the instances it serves (filled in when a mod writes its own). */
export interface GraphRef { readonly type: string; readonly provider?: string; readonly id: string }
export interface GraphSnapshot {
  readonly ref: Required<GraphRef>; readonly liveness: 'live' | 'stale' | 'gone'; readonly version: number; readonly time: number;
  readonly state: Readonly<Record<string, Json>>; readonly links: Readonly<Record<string, Required<GraphRef> | Required<GraphRef>[] | null>>;
  readonly caps: readonly string[] | null; readonly summary: { readonly title: string; readonly subtitle?: string; readonly status?: string; readonly time?: number };
  /** Mods' attached data this reader may see (docs/design/public-hooks.md §3.3): its own and the shared ones, by mod id then name. */
  readonly attached?: Readonly<Record<string, Readonly<Record<string, Json>>>>;
}
/**
 * Which instances (docs/design/public-hooks.md §3.1): paths (a state field, `context.used`; a relation then its target's path, at most
 * three hops, `project.title`; a mod's attached data, `@<modId>/<key>`) to literals (equality) or operators (an object whose keys start
 * with `$`), all of which must hold, with `$or` and `$not`. A path that cannot be resolved now matches nothing but `{$exists: false}`.
 */
/** A link the user opens, as a link route's `where` reads it: `from` is where it was opened (a chat's message, the terminal, a pull
 *  request's link, elsewhere in the app); `local` is a link to this Mac (localhost, a file). */
export interface Link { readonly url: string; readonly scheme: string; readonly host: string; readonly path: string; readonly local: boolean;
  readonly from: 'message' | 'terminal' | 'pullRequest' | 'app' }
/** What a link route's run gets: the link, the window it was opened in, and the chat it was opened from (when one). */
export interface LinkEnv { readonly link: Link; readonly window: GraphRef | null; readonly thread: GraphRef | null }
export type Where = { readonly $or?: readonly Where[]; readonly $not?: Where } & { readonly [path: string]: Json | WhereOp | readonly Where[] | Where | undefined };
export interface WhereOp {
  $eq?: Json; $ne?: Json; $in?: readonly Json[]; $nin?: readonly Json[]; $gt?: number | string; $gte?: number | string; $lt?: number | string;
  $lte?: number | string; $exists?: boolean; $contains?: Json; $prefix?: string; $glob?: string;
  $matches?: string | { pattern: string; flags?: string };   // a bounded pattern: no lookaround or back-references
  $any?: Where; $all?: Where;                                 // over a many relation's targets
}
export type GraphOutcome =
  | { readonly status: 'done'; readonly value: Json }
  | { readonly status: 'refused'; readonly reason: 'notAllowed' | 'unsupported' | 'unavailable' | 'invalid'; readonly message?: string }
  | { readonly status: 'failed'; readonly error: { readonly message: string; readonly code?: string } }
  | { readonly status: 'uncertain'; readonly operation: string }
  /** An interceptor stopped it (graph-integrity G6.2): it did not happen, and nothing failed; what happens next comes as events. */
  | { readonly status: 'stopped'; readonly by: { readonly kind: 'mod'; readonly id: string }; readonly message?: string };
/** What an operation handler is given. */
export interface GraphCall {
  readonly ref: Required<GraphRef>; readonly instance: GraphSnapshot; readonly args: readonly Json[];
  /** `through`: a `user` caller's, the mod whose surface the user acted in (graph-integrity G7.3: its call carried their attested intent). */
  readonly caller: { readonly kind: 'native' | 'framework' | 'mod' | 'user'; readonly id: string; readonly through?: string }; readonly origin: Json; readonly intent: string | null;
}
export interface GraphProviderSpec {
  types: Record<string, {
    /** effect 'external': the runtime records the intent durably before the handler runs. A handler returns a value or an outcome. */
    operations?: Record<string, { effect: 'none' | 'local' | 'external'; handler(call: GraphCall): Json | GraphOutcome | Promise<Json | GraphOutcome> }>;
    supports?: readonly string[];
  }>;
  /**
   * A realm started observing one of the mod's instances or a relation of one: load what is not resident yet. For a provider that
   * `contributes`, `{target, relation}`: someone reads that relation's inverse on `target` (a chat's `settings`), so put this mod's
   * instances for it now, within the read's deadline (graph-integrity G3.4).
   */
  onObserve?(query: Json): void | Promise<void>;
  /**
   * The mod's instances linked to others' (graph-integrity G3.4): `{type, via}`, a type it provides and its one or maybe relation to what
   * it adds to (`{type: 'Note', via: 'thread'}`), found where the target's relations are. Linking to another provider's instance needs
   * `graph.read` for its type and `graph.contribute` for its concept (G3.2).
   */
  contributes?: readonly { readonly type: string; readonly via: string }[];
  /**
   * What it realizes that its own checks have not shown yet (graph-integrity G9.3): by type, member names (an operation, an optional
   * member, an event, a relation). The framework's own surfaces do not offer them until they are verified; an assessment says
   * `unverified: true`; a mod may still call them.
   */
  unverified?: Readonly<Record<string, readonly string[]>>;
}
export interface GraphWriteData {
  state?: Record<string, Json | undefined>; links?: Record<string, GraphRef | GraphRef[] | null>; caps?: readonly string[] | null; time?: number;
}
export interface GraphProvider extends Disposable {
  put(ref: GraphRef, data: GraphWriteData): Promise<Json>;
  update(ref: GraphRef, data: GraphWriteData & { type?: string }): Promise<Json>;
  remove(ref: GraphRef): Promise<Json>;
  setComplete(typeId: string, complete?: boolean): Promise<void>;
  markStale(ids?: readonly string[]): Promise<number>;
  markLive(ids?: readonly string[]): Promise<number>;
  /** A named event of one of the mod's instances, declared by its type (`ev(payload)`); views of the instance get it as a delta whose
   *  event has `kind: 'event'`, `name` and `payload`. */
  emit(ref: GraphRef, name: string, payload?: Json): Promise<Json>;
}
/**
 * The call an interceptor is given (docs/design/interception.md I10): the operation about to run, on an instance of the type it
 * intercepts or a subtype. The caller's own interceptors are skipped, so a mod never sees its own operations.
 */
export interface GraphInterceptedCall {
  readonly id: string; readonly ref: Required<GraphRef>; readonly operation: string; readonly args: readonly Json[];
  /** `through`: a `user` caller's, the mod whose surface the user acted in (graph-integrity G7.3). */
  readonly caller: { readonly kind: 'native' | 'framework' | 'mod' | 'user'; readonly id: string; readonly owner?: string; readonly through?: string };
  /** Information only (where the call came from); the caller is what is authenticated. */
  readonly origin: Json; readonly instance: GraphSnapshot;
  /** Aborts when the call is cancelled while interceptors decide (the user's Stop during a held send): stop waiting and return. */
  readonly signal: GraphCancelSignal;
  /** Ask the user about this call (`ui.ask`'s spec, in the window they are in): the question ends with the call (decided, its
   *  deadline passed, cancelled), so it never outlives what it asks about. */
  ask(spec: AskSpec): Promise<AskResult>;
}
/** A call's cancellation: aborted at most once, with a reason; `onAbort` runs at once when it already is. */
export interface GraphCancelSignal { readonly aborted: boolean; readonly reason: string | null; onAbort(fn: () => void): Disposable }
/**
 * Runs the rest of the chain (the next interceptors, then the provider's handler) and resolves with its outcome. One call per interception;
 * `{args}` replaces the call's arguments: a change is this mod's (docs/design/public-hooks.md §3.5), so this mod must be allowed to make
 * the call, it is asked about as this mod's call (R17) unless `automatic` names one of its automatic actions that covers it, and a change
 * that does more than the call did (more access, another target, a wider approval) is refused.
 */
export type GraphNext = (change?: { readonly args?: readonly Json[]; readonly automatic?: string }) => Promise<GraphOutcome>;
/**
 * What an interceptor returns: `next()`'s outcome, a refusal, a stop, or (only with `replaces`) an outcome of its own. A return value that
 * is not an outcome (such as undefined) stands for `next()`'s outcome when the function called next; anything else is its failure.
 * A stop, `{status: 'stopped', message?}` (graph-integrity G6.2): the operation does not happen and the caller is not told it failed (a
 * graph caller gets `stopped` naming this mod; an app place ends without an error and keeps its input: a composer its draft). Write what
 * you need to act later (storage, a scheduled job) and await it before you answer. Each stop is in the activity record and an
 * `operationStopped` event on the subject. A policy refuses instead: the user sees why.
 */
export type GraphInterceptor = (call: GraphInterceptedCall, next: GraphNext) => GraphOutcome | Json | undefined | Promise<GraphOutcome | Json | undefined>;
export interface GraphInterceptOptions {
  /** Among this mod's own, higher runs first (default 0); the mods themselves run in the user's order. */
  priority?: number;
  /** The interceptor may answer without calling next (the provider's handler then does not run). */
  replaces?: boolean;
  /** How long the function may take itself, not counting the time inside `next` (default 60000, at most 600000). Past it, its failure. */
  deadlineMs?: number;
  /**
   * What its failure means (graph-integrity G6.6: it throws, passes its deadline, or answers what it may not): `'allow'` (the default) the
   * call goes on as if it had not been there; `'refuse'` it is refused. A failure never stops a call quietly.
   */
  onFailure?: 'allow' | 'refuse';
}
/** ctx.graph: the object graph (preview; needs the `graph` permission; host realm). */
export interface HostGraph {
  /** Definitions from defineConcept/defineSubtype (sdk/graph), or their descriptors. */
  registerTypes(defs: object | readonly object[]): Promise<Json>;
  provide(spec: GraphProviderSpec): GraphProvider;
  /** `opts.automatic`: the call is that automatic action of the mod's (mod.json `automatic`, public-hooks.md §3.9): it does not ask the
   *  user while they have it on and the call is within its bounds and rate; otherwise it asks as any call does. */
  invoke(ref: GraphRef, operation: string, args?: readonly Json[], opts?: { automatic?: string; key?: string }): Promise<GraphOutcome & { readonly id: string }>;
  /**
   * This mod's call by the `key` it was made with (graph-integrity G6.3: `invoke(..., {key})`, 1-200 letters, digits and `. _ : -`): the
   * newest such call's status as the intent journal has it, and what it made (a Turn's ref for a send), or null (none, or no longer kept).
   * After an `uncertain` delivery of a scheduled job, look the key up before acting again: a send made once is not made twice. The turn
   * a keyed send starts says it (`startedBy: {kind: 'mod', id, key}`).
   */
  made(key: string): Promise<{ readonly status: 'started' | 'done' | 'refused' | 'failed' | 'stopped' | 'uncertain'; readonly made?: Required<GraphRef>; readonly at: number } | null>;
  /** Several changes, one approval (public-hooks.md §3.14). Every call is checked first; one that cannot be made refuses them all before any
   *  runs. What they ask the user (their prompts and the policies that ask) is asked once, every entry shown whole (too much to show is
   *  refused); once approved they run in order, each its own call, and stop at the first not done (the rest are not run: one approval, not
   *  one transaction). The approval holds for a call only as it was approved (its arguments, its instance as it was): otherwise that call
   *  is asked about on its own. The outcome is the first not done's (or done), with every call's in `outcomes`, always. At most 20 calls. */
  invokeAll(calls: readonly { ref: GraphRef; operation: string; args?: readonly Json[] }[], opts?: { reason?: string }): Promise<GraphOutcome & { readonly outcomes: readonly GraphOutcome[] }>;
  can(ref: GraphRef, operation: string): Promise<boolean>;
  resolve(ref: GraphRef): Promise<GraphSnapshot | { readonly ref: Required<GraphRef>; readonly liveness: 'gone'; readonly gone: true } | null>;
  /** The instances of a type (with its subtypes) a `where` keeps. */
  list(typeId: string, where?: Where): Promise<GraphSnapshot[]>;
  /**
   * A page of a type's instances (docs/design/public-hooks.md §3.2): those `where` keeps, with every word of `text` in their title or
   * subtitle, in `sort`'s order (absent values last), `limit` (50, at most 500) of them; `next` is the cursor of the page after (a row
   * that comes or goes between pages never repeats or skips another).
   */
  query(q: { type: string; where?: Where; text?: string; sort?: readonly { by: string; dir?: 'asc' | 'desc' }[]; limit?: number; cursor?: string }): Promise<{ readonly items: GraphSnapshot[]; readonly next?: string }>;
  /**
   * What matches a text among the searchable types (`types`, each searchable; all by default), at most `limit` (20, at most 100): titles
   * first, then subtitles, then what a provider's own search finds in content (the chats' messages), which needs the read grant for that
   * content (`graph.read:Message`) and brings a `snippet`.
   */
  search(text: string, opts?: { types?: readonly string[]; limit?: number }): Promise<readonly { readonly ref: Required<GraphRef>; readonly title: string; readonly field: 'title' | 'subtitle' | 'content'; readonly snippet?: string }[]>;
  /**
   * The attached values on an instance this mod may see: its own and the shared ones, by mod id then name (`{}` for none). A mod's
   * settings of project or thread scope are its shared values there, under their keys (graph-integrity G3.5).
   */
  attached(ref: GraphRef): Promise<Record<string, Record<string, Json>>>;
  /**
   * Keep this mod's value of a name on an instance (docs/design/public-hooks.md §3.3): private unless `shared`; null removes it. A where
   * reads it as `@<modId>/<name>`. Its own instances and those of types it declared, or others' with `graph.attach` covering the type;
   * never the framework's. A name is 1-64 letters, digits, `_` or `-`; one of the mod's own settings is set as that setting, not here.
   * At most 4 KB of JSON per value and 50,000 values per mod. Kept apart from the instance (a restart or its provider going away keeps
   * it), removed when the instance is deleted, and kept or deleted with the mod's data when the mod is removed.
   */
  attach(ref: GraphRef, name: string, value: Json | null, opts?: { shared?: boolean }): Promise<GraphOutcome>;
  related(ref: GraphRef, name: string): Promise<GraphSnapshot | GraphSnapshot[] | null>;
  types(): Promise<Json[]>;
  /**
   * A view: a snapshot, then deltas ({type: 'snapshot' | 'delta' | 'stale', seq, ...}). A collection query is `{type, where?}`. With
   * `event` (`'entered' | 'left' | 'changed'` or a named event of the type, or a list of them) only those changes come, each delta with
   * `on` saying which, and no snapshot (`stale`: some were dropped).
   */
  subscribe(query: Json, listener: (message: Json) => void, opts?: { maxQueue?: number }): Disposable;
  /**
   * Intercept an operation on a type and its subtypes (docs/design/interception.md I10). `fn(call, next)` runs in the mod's worker for
   * each call, in priority order with the other interceptors, before the provider's handler. Disposing ends it; it also ends with the mod.
   */
  intercept(typeId: string, operation: string, fn: GraphInterceptor, opts?: GraphInterceptOptions): Disposable;
  /**
   * A policy (public-hooks.md §3.7): the Host runs it on every call of the operation, without this worker, everyone's included (this mod's
   * too; never the framework's): refuse with a reason, or ask the user first. Its mod's page lists it with a switch; one the user turned
   * off stays off when registered again. Needs the graph.intercept grant for the operation. Registering the same id replaces it.
   */
  policy(spec: GraphPolicy): { readonly id: string; readonly accepted: Promise<true>; dispose(): Promise<boolean> };
  /** This mod's policies, each with whether the user has it on. */
  policies(): Promise<readonly { readonly id: string; readonly title: string; readonly spec: Json; readonly on: boolean }[]>;
  /**
   * What a new thing starts with until the user chooses (public-hooks.md §3.8); the first mod in order that gives a field gives it.
   * - `of: 'Draft'`: a new chat, applied where a window shows it, when it begins (created, sent, cleared) and when a window starts showing
   *   it, to the fields the user has not chosen since; the text only into an empty draft. `where` is on the Draft (`{'target.project.id': '...'}`).
   * - `of: 'Setting'`: that setting's value wherever the user set none, everywhere the app reads it, and its shown default; one that does
   *   not fit the setting's schema is not used. Needs `graph.act` for `Setting.set`. The app's own reset writes its built-in default.
   * - `of: 'Automation'`: what a new automation's spec leaves out (not its prompt, schedule or chat); `where` is on the automation to be.
   *   Needs `graph.act` for `Automation.edit`.
   * - `of: <a presentation type>` with `state` (graph-integrity G5.2): whether a new one is expanded (a step, a turn's steps, a sidebar
   *   section), until the user chooses; `for` names its subject's type and `where` reads its subject, as a ui rule's do. Applied once as
   *   it appears (this mod running `_expand` or `_collapse`, which it needs `graph.act` for), never over what the user chose for it in
   *   that window. Its sizes and open panels are the app's to keep.
   */
  defaults(spec: { id: string; of: 'Draft'; where?: Where; target?: { project?: GraphRef; environment?: GraphRef | 'worktree'; branch?: GraphRef; model?: GraphRef; settings?: { effort?: string; mode?: 'plan' | 'default' } }; content?: Json }
    | { id: string; of: 'Setting'; key: string; value: Json }
    | { id: string; of: 'Automation'; where?: Where; values: { name?: string; enabled?: boolean; project?: GraphRef; settings?: { model?: string; effort?: string }; where?: 'local' | 'worktree'; notifications?: 'all' | 'failures'; archiveRuns?: boolean } }
    | { id: string; of: 'StepBlock' | 'TurnView' | 'SidebarSection'; for?: string | string[]; where?: Where; state: { expanded: boolean } }):
    { readonly id: string; readonly accepted: Promise<true>; dispose(): Promise<boolean> };
  /**
   * A temporary change of Settings (public-hooks.md §3.14; host realm): each a Setting this mod may set (`graph.act` for `Setting.set`),
   * at most 32; the user is asked once for all of it. The user's own values are kept aside on this Mac and come back on `restore()`, at
   * `until` (a time, at most 30 days on), when the mod stops, or at the next start after a crash; a Setting changed meanwhile by anyone
   * else leaves the override (that change stays). A Setting is held by one override at a time; the same id again replaces it.
   */
  override(spec: { id: string; set: ReadonlyArray<{ ref: GraphRef; value: Json }>; until?: number }):
    { readonly id: string; readonly applied: Promise<GraphOutcome>; restore(): Promise<{ restored: number; kept: number }> };
  /**
   * After an operation (public-hooks.md §3.4): `fn` once each call of it on an instance of the type (or a subtype) this mod may read has
   * completed, whatever its outcome and whoever made it, in order; `{gap: n}` when n were dropped (too many waiting). It never holds or
   * changes the call: for audit, undo stacks and chaining.
   */
  after(typeId: string, operation: string, fn: (record: GraphAfterRecord | { readonly gap: number }) => void | Promise<void>, opts?: { where?: Where }): Disposable;
  /** What a call would meet (nothing runs): its status, why, and the policy that decides it. It can change: every call is checked again. */
  assess(ref: GraphRef, operation: string, args?: readonly Json[], opts?: { automatic?: string }): Promise<GraphAssessment>;
}
/**
 * A policy: the operation it is about, which calls (`where` on the instance, `args` by index, `origin`, `schedule`), and what it does; or a
 * request policy (`on: {request}`), which answers a request the agent opened before anyone sees it, only when its where is known to hold.
 * Each binds only the instances this mod may intercept, and its wheres read only what this mod may read.
 */
export type GraphPolicy = GraphCallPolicy | GraphRequestPolicy;
export interface GraphCallPolicy {
  readonly id: string;
  readonly title: string;
  readonly on: { readonly type: string; readonly operation: string };
  readonly where?: Where;
  readonly args?: Readonly<Record<string, Where>>;
  /** Whose calls: the user's own actions, mods', the agent's, the app's own (a notification it shows), or any (the framework's never). */
  readonly origin?: 'user' | 'mod' | 'agent' | 'app' | 'any';
  /** Local hours (`["22:00", "06:00"]` spans midnight) and, optionally, the days ("mon" ... "sun"). */
  readonly schedule?: { readonly between: readonly [string, string]; readonly days?: readonly string[] };
  /** A where that cannot be decided now (a relation not loaded): refuse (the default) or allow. */
  readonly unknown?: 'refuse' | 'allow';
  /**
   * Refuse, ask the user, or rewrite: a rewrite runs in this mod's place in the user's order with the interceptors, is this mod's change
   * (as `GraphNext`'s), and `automatic` names the automatic action it is made as.
   */
  readonly then: { readonly refuse: string } | { readonly ask: { readonly title: string; readonly message?: string } }
    | { readonly rewrite: { readonly args?: Readonly<Record<string, Json>>; readonly prepend?: Json; readonly append?: Json } };
  readonly automatic?: string;
}
export interface GraphRequestPolicy {
  readonly id: string;
  readonly title: string;
  /** A request type: Request or a subtype (CommandApproval, Question, ...). */
  readonly on: { readonly request: string };
  readonly where?: Where;
  readonly schedule?: { readonly between: readonly [string, string]; readonly days?: readonly string[] };
  /** The approval's own option that approves once or for the chat (always stays the user's), or its decline, or a question's answers per
   *  prompt id; approving and answering are the automatic action `automatic` names, else the user is asked. */
  readonly then: { readonly answer: { readonly approve: 'once' | 'thread' } | { readonly deny: true } | { readonly answers: { readonly [promptId: string]: { readonly choices?: readonly string[]; readonly text?: string } } } };
  readonly automatic?: string;
}
export interface GraphAfterRecord {
  readonly id: string;
  readonly ref: GraphRef;
  readonly operation: string;
  /** Who made the call: the user's own action (`through` the mod whose surface they acted in: graph-integrity G7.3), a mod's (by id), the agent's, the app's own. */
  readonly origin: { readonly kind: 'user' | 'mod' | 'agent' | 'automation' | 'app' | 'unknown'; readonly id?: string; readonly through?: string };
  /** What the call carried, for a mod that could see the call itself (it may intercept the operation, or made the call); `[]` otherwise. */
  readonly args: readonly Json[];
  /** The arguments it ran with, after the interceptors (`[]` as `args`); `changedBy` the mod that changed them last. */
  readonly effectiveArgs: readonly Json[];
  readonly changedBy?: string;
  readonly outcome: GraphOutcome;
}
export interface GraphAssessment {
  readonly status: 'allowed' | 'refused' | 'unsupported' | 'asks' | 'needsConsent' | 'unknown';
  readonly reason?: string;
  readonly by?: { readonly mod: string; readonly policy: string };
  /** Allowed, and its provider declares it unverified: no native check has shown it yet (graph-integrity G9.3). */
  readonly unverified?: true;
}

// ---------------------------------------------------------------- mod intelligence (GOAL.md goal 16)
/** A tool the mod gives a call: what it does, its input's JSON Schema, and `run`, which answers in the mod's own realm (text, or a value). */
export interface IntelligenceTool { description: string; input?: Json; run(args: Json): Json | string | Promise<Json | string> }
export interface IntelligenceAsk {
  prompt: string;
  /** The call's own instructions, after the framework's. */
  instructions?: string;
  /** One of the models the user gave this mod (its chosen one by default; Luna unless they chose another). */
  model?: string;
  effort?: string;
  /** Its actions, as tools the model may call, answered in this realm. */
  tools?: Record<string, IntelligenceTool>;
  /** The mod's own storage and settings as tools (`storage_get`, `storage_set`, `storage_keys`; `settings_get`, `settings_set`). */
  storage?: boolean;
  settings?: boolean;
  /** The text as it streams. */
  onText?: (delta: string) => void;
  /** At most 300 000; 60 000 by default. */
  timeoutMs?: number;
}
/**
 * Model use (GOAL.md goal 16), through the framework's internal mod: off until the user turns it on on the mod's page, with the model and
 * the allowances they give it. A call runs in a thread the framework manages, which the user never sees in the app's lists, with no tool
 * but those the mod gives it (and the kinds the user allowed); its tokens count against the mod's allowance. Declare it in mod.json
 * (`intelligence: {why, tools?}`).
 */
export interface Intelligence {
  /** Throws when the call is refused (model use off, an allowance used, a limit, the account near its limit) or fails, saying why. */
  ask(spec: IntelligenceAsk): Promise<{ text: string; usage: { tokens: number } }>;
  status(): Promise<{ enabled: boolean; declared?: false; model?: string; models?: string[]; perHour?: number; perDay?: number; usedHour?: number; usedDay?: number; usedTotal?: number; running?: number }>;
}

// ---------------------------------------------------------------- contexts
export interface HostContext {
  readonly mod: ModInfo;
  readonly log: Log;
  readonly settings: Settings;
  readonly storage: ModStorage;
  readonly secrets: Secrets;
  readonly permissions: Permissions;
  readonly events: Events;
  readonly services: Services;
  readonly intelligence: Intelligence;
  readonly appServer: HostAppServer;
  readonly processes: Processes;
  readonly scheduler: Scheduler;
  readonly graph: HostGraph;
  /** The presentation rules from the host realm: data, with the entries' `run` callbacks kept in the worker (mod-surfaces.md P1). */
  readonly ui: DataRules;
}
/**
 * ctx.graph in the renderer realm (preview; needs the `graph` permission): the reads and `invoke` of HostGraph. Registering types,
 * providing, writing and intercepting are the host realm's (a renderer cannot ask for them: the Host answers Denied). `invoke` is made
 * as the mod, like the host realm's. A view's query may set `depth: 'core'` to follow the instance itself without asking its provider
 * to load what it needs (a thread's turns); the default, `'full'`, loads it.
 */
export type RendererGraph = Pick<HostGraph, 'can' | 'assess' | 'resolve' | 'list' | 'query' | 'search' | 'related' | 'types' | 'subscribe' | 'attached'> & {
  /**
   * As the host realm's, and `opts.asUser`: the user's intent the page attested for this mod (an `ActionEnv`'s, a kit or lent part's
   * callback's last argument `{asUser}`, an answer's), so the call is the user's through this mod (graph-integrity G7.2, G7.3): taken once,
   * within a few seconds, from this window; the mod still needs its grant for the act (another mod's setting: `graph.act` for
   * Setting.set); a mod act's approval, the automatic switch and its cap are not asked; the record names the user and the mod.
   */
  invoke(ref: GraphRef, operation: string, args?: readonly Json[], opts?: { automatic?: string; key?: string; asUser?: string }): Promise<GraphOutcome & { readonly id: string }>;
};
/** Every namespace is proxied asynchronously to the Host, except ui. No intercept, no processes. */
export interface RendererContext {
  readonly mod: ModInfo;
  readonly log: Log;
  readonly settings: Settings;
  readonly storage: ModStorage;
  readonly secrets: Secrets;
  readonly permissions: Permissions;
  readonly events: Events;
  readonly services: Services;
  readonly intelligence: Intelligence;
  readonly appServer: AppServer;
  readonly graph: RendererGraph;
  readonly ui: Ui;
}
/** Context for mod processes (over the process socket): HostContext minus processes. */
/** A mod's own process: the host realm's namespaces but processes and the scheduler; the graph's reads, views and `invoke`, as the mod under its grants (graph-integrity G8.2). */
export type ProcessContext = Omit<HostContext, 'processes' | 'scheduler' | 'graph'> & {
  readonly graph: Pick<HostGraph, 'can' | 'assess' | 'resolve' | 'list' | 'query' | 'search' | 'related' | 'types' | 'subscribe' | 'attached' | 'invoke'>;
};

// ---------------------------------------------------------------- migration (§8.5)
export interface MigrationInput {
  from: number;
  to: number;
  storage: Storage;              // the staged copy of the mod's store
  settings: { get(): Json; set(value: Json): void };
  files: string;                 // staged files directory
}
export type Migrate = (input: MigrationInput) => Promise<void>;
