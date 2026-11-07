// The graph runtime (framework/host/graph; docs/design/runtime-core.md; integration.md §3; docs/graph/04). Host-internal: mods reach it
// through their realm (C3 onwards) with the SDK v2 types of sdk/graph/index.d.ts, never through this shape directly.
import type { Disposable } from '../sdk/index.js';

export interface Ref { readonly type: string; readonly provider: string; readonly id: string }
export type Liveness = 'live' | 'stale' | 'gone';
export type RefusalReason = 'notAllowed' | 'unsupported' | 'unavailable' | 'invalid' | 'gone';
/** docs/graph/04 §4. `id` names the invocation; `intent` the journal entry when the operation had an external effect. */
export type Outcome =
  | { readonly status: 'done'; readonly value: unknown; readonly id: string; readonly intent?: string }
  | { readonly status: 'refused'; readonly reason: RefusalReason; readonly message?: string; readonly id: string; readonly intent?: string }
  | { readonly status: 'failed'; readonly error: { readonly message: string; readonly code?: string }; readonly id: string; readonly intent?: string }
  | { readonly status: 'uncertain'; readonly operation: string; readonly id: string; readonly intent?: string };

/** A resident instance as realms see it. `links` holds one/maybe relations as refs and stored many relations as lists. */
export interface InstanceSnapshot {
  readonly ref: Ref;
  readonly liveness: Liveness;
  readonly version: number;
  readonly time: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly links: Readonly<Record<string, Ref | readonly Ref[] | null>>;
  /** The instance's own capability declaration, or null when its provider's per-type declaration applies. */
  readonly caps: readonly string[] | null;
  readonly summary: { readonly title: string; readonly subtitle?: string; readonly status?: string; readonly time?: number };
}
export interface GoneSnapshot { readonly ref: Ref; readonly liveness: 'gone'; readonly gone: true }

/** A change (docs/graph/04 §3, §10): old and new values, the provider's time, the observation sequence. */
export interface GraphEvent {
  readonly seq: number;
  readonly observedAt: number;
  readonly time: number;
  /** 'event': a named event the instance's type declares (`name`, `payload`), emitted by its provider. */
  readonly kind: 'added' | 'changed' | 'removed' | 'completeness' | 'event';
  readonly name?: string;
  readonly payload?: unknown;
  readonly ref?: Ref;
  readonly fields?: readonly string[];
  readonly old?: Readonly<Record<string, unknown>>;
  readonly new?: Readonly<Record<string, unknown>>;
  readonly instance?: InstanceSnapshot;
  readonly concept?: string;
  readonly complete?: boolean;
}

/** What a realm view's sink receives (contract rule Reconciliation). Returning false from the sink holds deltas until `resume()`. */
export type ViewMessage =
  | { readonly type: 'snapshot'; readonly seq: number; readonly items: readonly (InstanceSnapshot | GoneSnapshot)[]; readonly complete?: boolean }
  | { readonly type: 'delta'; readonly seq: number; readonly event: GraphEvent; readonly items?: readonly InstanceSnapshot[] }
  | { readonly type: 'complete'; readonly seq: number; readonly complete: boolean }
  | { readonly type: 'stale'; readonly seq: number };
/**
 * What a view follows: one instance, a type's collection, or a relation of an instance. `depth` (presentations.md V6) says how much the
 * observing realm wants of the instances behind the ref: 'full' (the default) lets the provider's `onObserve` load what the instance
 * needs (a thread's turns, messages and steps); 'core' is the instance itself: a resident one asks nothing and the view's `loaded` settles
 * at once; one not resident yet is asked of its provider's `onObserve` with `depth: 'core'`, which loads what the instance itself needs and
 * nothing heavy (docs/design/systems.md E2). Presenting a thread observes it 'core'.
 */
export type ViewQuery = ({ ref: Ref } | { type: string; filter?: Record<string, unknown> } | { ref: Ref; relation: string }) & { readonly depth?: 'core' | 'full' };
export interface View extends Disposable {
  resume(): void; resync(): void; readonly queued: number;
  /** Settles once the provider's `onObserve` has loaded what was not resident (at once when it has none, or a 'core' view's instance is resident). */
  readonly loaded: Promise<void>;
}

/** A cancellation signal (the runtime's `createAbort`): aborted at most once, with a reason; `onAbort` runs at once when it already is. */
export interface CancelSignal { readonly aborted: boolean; readonly reason: string | null; onAbort(fn: () => void): Disposable }
/** The caller of an operation, from its authenticated ingress (never from `origin`). */
export interface Caller { readonly kind: 'native' | 'framework' | 'mod' | 'user'; readonly id: string; readonly owner?: string }
export interface OperationCall {
  readonly id: string; readonly ref: Ref; readonly operation: string; readonly args: readonly unknown[];
  readonly caller: Caller; readonly origin: unknown; readonly instance: InstanceSnapshot;
  /** Aborts when the call is cancelled while interceptors decide (the user's Stop during a held send): `next` then answers
   *  refused('unavailable'), and a mod's interceptor in its worker sees its own call's signal abort (boundary review 6a, 3b). */
  readonly signal: CancelSignal;
}
/** Interceptor middleware (T6). Return next()'s outcome, a refusal, or (registered with replaces: true) an outcome of its own. */
export type Interceptor = (call: OperationCall, next: (change?: { args?: readonly unknown[] }) => Promise<Outcome>) => Promise<Outcome | { status: string }>;

export interface ProviderSpec {
  types: Record<string, {
    /** effect 'external': claimed in the intent journal before the handler runs (R8). A handler returns a value or an outcome. */
    /** `approval(call)` (runtime-core.md R17, in-process providers): the call of a mod needs the user's approval when it returns
     *  `{action, detail?}` ("“Mod” wants to <action>."), none when it returns null; the user and the framework are never asked. */
    operations?: Record<string, { effect: 'none' | 'local' | 'external'; handler(call: { ref: Ref; instance: InstanceSnapshot; args: readonly unknown[]; caller: Caller; origin: unknown; intent: string | null }): unknown;
      approval?(call: { ref: Ref; instance: InstanceSnapshot; args: readonly unknown[]; caller: Caller; origin: unknown }): { action: string; detail?: string } | null }>;
    /** The standard optional members it serves (implementing an optional operation declares it). */
    supports?: readonly string[];
  }>;
  /** A realm started observing one of its instances or their relations: load what is not resident yet. A promise it returns is the
   *  view's `loaded`. */
  onObserve?(query: ViewQuery): void | Promise<void>;
}
export interface ProviderHandle extends Disposable {
  readonly id: string;
  put(ref: Ref, data: { state: Record<string, unknown>; links?: Record<string, Ref | Ref[] | null>; caps?: readonly string[] | null; time?: number }): GraphEvent | null;
  update(ref: Ref, data: { state?: Record<string, unknown>; links?: Record<string, Ref | Ref[] | null>; caps?: readonly string[] | null; type?: string; time?: number }): GraphEvent | null;
  remove(ref: Ref, data?: { time?: number }): GraphEvent | null;
  /** A named event its type declares, for one of its instances (resident, or gone a moment ago); `payload` follows the event's schema. */
  emit(ref: Ref, name: string, payload?: unknown, data?: { time?: number }): GraphEvent;
  setComplete(typeId: string, complete: boolean): void;
  markStale(match?: (s: InstanceSnapshot) => boolean): GraphEvent[];
  markLive(match?: (s: InstanceSnapshot) => boolean): GraphEvent[];
  get(ref: Ref): InstanceSnapshot | null;
  /** True once disposed: by its owner, or because every type it provided went with another owner. */
  readonly disposed: boolean;
}

export interface Graph {
  /** Load descriptors (sdk/graph/define.mjs toDescriptor) for an owner ('native' or a mod id). All or nothing. */
  registerTypes(descriptors: readonly object[], owner: string): string[];
  registerProvider(owner: string, id: string, spec: ProviderSpec): ProviderHandle;
  /** `deadlineMs`: how long the interceptor may take on its own time (not inside `next`); past it, an interceptor fault. Default 60 s,
   *  at most 10 min. */
  intercept(owner: string, typeId: string, operation: string, fn: Interceptor, opts?: { priority?: number; replaces?: boolean; deadlineMs?: number }): Disposable;
  /** The one invocation path (integration.md §3). `signal` cancels it while its interceptors decide. */
  invoke(call: { ref: Ref; operation: string; args?: readonly unknown[]; caller: Caller; origin?: unknown; signal?: CancelSignal }): Promise<Outcome>;
  can(ref: Ref, operation: string): boolean;
  capabilities(ref: Ref): readonly string[] | null;
  /** Everything the owner registered goes, and what other owners built on its types (their subtypes, interceptors and instances of
   *  them); those owners are `degraded` until they register again. Returns the removed type ids. */
  disposeOwner(owner: string): string[];
  degraded(): readonly { owner: string; types: readonly string[]; because: string; at: number }[];
  types(): readonly object[];
  type(id: string): object | null;
  resolve(ref: Ref): InstanceSnapshot | GoneSnapshot | null;
  list(typeId: string, filter?: Record<string, unknown>): InstanceSnapshot[];
  related(ref: Ref, relation: string): InstanceSnapshot | InstanceSnapshot[] | null;
  /** Every instance linking to `ref` through its one/maybe relation `relation` (all of a turn's messages and steps: `referrers(turn, 'turn')`). */
  referrers(ref: Ref, relation: string): InstanceSnapshot[];
  isComplete(typeId: string): boolean;
  subscribe(query: ViewQuery, sink: (msg: ViewMessage) => boolean | void, opts?: { maxQueue?: number }): View;
  onEvent(fn: (e: GraphEvent) => void): Disposable;
  onOperation(fn: (e: { id: string; ref: Ref; operation: string; status: string; caller: Caller | null; origin: unknown; t: number }) => void): Disposable;
  /** Intents a crash left uncertain, not yet acknowledged (docs/graph/04 §10): reported, never replayed. */
  uncertain(): readonly { id: string; operation: string; ref: Ref | null; caller: string | null; origin: unknown; source: string; t: number }[];
  acknowledge(intentId: string): boolean;
  close(): void;
}
export declare function createGraph(opts?: {
  log?: object;
  /** The intent journal file, in the profile's framework data (never ~/.codex). */
  journalFile?: string;
  now?: () => number;
  /** Grants by type and kind of use (docs/graph/04 §6). Default: everything allowed (headless tests). */
  authorize?: (caller: Caller, request: { type: string; use: 'read' | 'act' | 'present' | 'extend'; operation?: string; ref?: Ref }) => boolean;
}): Graph;

/** The native provider's protocol source (framework/host/graph/providers/codex). */
export declare function createCodexSource(opts: {
  graph: Graph; mux: import('./host.js').Mux; bus?: import('./host.js').Bus; log?: object; now?: () => number; pageSize?: number; clientId?: string;
}): { start(): Promise<void>; loadThread(threadId: string): Promise<void>; resync(why: string): Promise<void>; readonly provider: ProviderHandle; dispose(): Promise<void> };
