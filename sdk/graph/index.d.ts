// SDK v2 object-graph types: the declarations of ./define.mjs. A faithful port of the accepted prototype,
// docs/design/sdk-typescript/sdk/core.ts (docs/design/sdk-typescript.md T1-T5).
// Definitions are plain runtime values (descriptors); instance types are inferred from them; relations name their target by id and
// resolve through the Registry, so a cyclic graph needs no annotations.
//
// Differences from the prototype, all additive: `Json` and `s.json()`, `Op.minArgs`, and `toDescriptor` with its descriptor types.

/* ================================================================== registry */

/** Every type of the graph by id, mapped to its instance interface. The SDK registers the native types; a mod registers its own. */
export interface Registry {}
export type TypeId = keyof Registry & string;
export type InstanceOf<Id extends TypeId> = Registry[Id];
/** A relation's target: a type, any type (`ANY_TYPE`), or a list of concepts, any of whose instances it may name (graph-integrity G3.3). */
export type Target = TypeId | typeof ANY_TYPE | readonly TypeId[];
type InstanceOfTarget<Id> = Id extends TypeId ? InstanceOf<Id> : Id extends readonly (infer T)[] ? (T extends TypeId ? InstanceOf<T> : unknown) : unknown;

/* ================================================================== value schemas (runtime data) */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Schema =
  | { readonly t: 'string' | 'number' | 'boolean' | 'time' | 'url' | 'content' | 'json' }
  | { readonly t: 'enum'; readonly values: readonly string[] }
  | { readonly t: 'list'; readonly of: Schema }
  | { readonly t: 'record'; readonly of: Schema }
  | { readonly t: 'object'; readonly fields: Readonly<Record<string, { readonly schema: Schema; readonly optional: boolean }>> }
  | { readonly t: 'ref'; readonly to: string };

export type Tier = 'core' | 'optional';

export interface Field<T, Ti extends Tier = 'core'> {
  readonly member: 'state';
  readonly schema: Schema;
  readonly tier: Ti;
  /** Phantom: the value type. Never present at runtime. */
  readonly __value?: T;
  /** A standard optional member: present when the provider supports it (docs/graph/README.md, rule 2). */
  optional(): Field<T, 'optional'>;
}

export type Cardinality = 'one' | 'maybe' | 'many';
export interface Rel<Id extends Target, C extends Cardinality, Ti extends Tier = 'core'> {
  readonly member: 'relation';
  readonly target: Id;
  readonly cardinality: C;
  readonly tier: Ti;
  /** Owned parts are served by the owner's provider (docs/graph/04 §7, containment). */
  readonly owned: boolean;
  /** Derived as the inverse of a one relation on the target, never provided: a many relation lists every instance that links here, a
   *  one or maybe relation names the earliest. */
  readonly inverseOf?: string;
  optional(): Rel<Id, C, 'optional'>;
  parts(): Rel<Id, C, Ti>;
  inverse(of: string): Rel<Id, C, Ti>;
}

export interface Op<A extends readonly unknown[], R, Ti extends Tier = 'core'> {
  readonly member: 'operation';
  readonly args: readonly Schema[];
  /** How many leading arguments are required; the rest are optional. */
  readonly minArgs: number;
  readonly returns: Schema | null;
  readonly tier: Ti;
  readonly __args?: A;
  readonly __result?: R;
  /** An optional operation: the provider declares support (docs/graph/04 §4). */
  optional(): Op<A, R, 'optional'>;
}

export interface Ev<P> {
  readonly member: 'event';
  readonly payload: Schema | null;
  readonly __payload?: P;
}

/* ================================================================== builders */

type FieldValue<F> = F extends Field<infer T, infer Ti> ? (Ti extends 'optional' ? T | undefined : T) : never;
type ObjectOf<S extends Record<string, Field<unknown, Tier>>> =
  { -readonly [K in keyof S as S[K] extends Field<unknown, 'core'> ? K : never]: FieldValue<S[K]> } &
  { -readonly [K in keyof S as S[K] extends Field<unknown, 'optional'> ? K : never]?: FieldValue<S[K]> };

/** Value schemas: state fields, operation arguments, event payloads. */
export declare const s: {
  string: () => Field<string>;
  number: () => Field<number>;
  boolean: () => Field<boolean>;
  time: () => Field<Time>;
  url: () => Field<string>;
  content: () => Field<Content>;
  /** Any JSON value, for data that has no schema of its own yet. */
  json: () => Field<Json>;
  enum: <const V extends readonly string[]>(...values: V) => Field<V[number]>;
  list: <T>(of: Field<T, Tier>) => Field<T[]>;
  /** A map from string keys the source names (a question's prompt ids, a limit's id) to values of one schema. */
  record: <T>(of: Field<T, Tier>) => Field<{ [key: string]: T }>;
  object: <const S extends Record<string, Field<unknown, Tier>>>(fields: S) => Field<ObjectOf<S>>;
  ref: <const Id extends TypeId>(to: Id) => Field<InstanceOf<Id>>;
};

/** The target of a relation to an instance of any type (a Ref: a presentation's subject, docs/graph/03). */
export declare const ANY_TYPE: '*';

/** Relations name their target by id; the Registry resolves it, so definitions can refer to each other in any order. */
export declare const r: {
  one: <const Id extends Target>(target: Id) => Rel<Id, 'one'>;
  maybe: <const Id extends Target>(target: Id) => Rel<Id, 'maybe'>;
  many: <const Id extends Target>(target: Id) => Rel<Id, 'many'>;
};

type ArgTypes<F extends readonly unknown[]> =
  F extends readonly [infer H, ...infer Rest]
    ? H extends Field<infer T, 'optional'> ? [T?, ...ArgTypes<Rest>] : H extends Field<infer T, 'core'> ? [T, ...ArgTypes<Rest>] : never
    : [];
type ResultType<R> = R extends Field<infer T, Tier> ? T : R extends Rel<infer Id, 'one', Tier> ? InstanceOfTarget<Id> : void;

/** `content`: what the operation answers is sensitive content (terminal output, a file's contents, a diff), so another mod's grant must
 *  name the operation itself (`graph.act:Type.operation`; a bare or type-wide act grant does not cover it). */
export declare function op<const F extends readonly Field<unknown, Tier>[] = [], const R extends Field<unknown, Tier> | Rel<TypeId, 'one'> | undefined = undefined>(
  spec?: { args?: F; returns?: R; content?: boolean },
): Op<ArgTypes<F>, ResultType<R>>;

export declare function ev(): Ev<void>;
export declare function ev<const Id extends TypeId>(payload: Rel<Id, 'one'>): Ev<InstanceOf<Id>>;
export declare function ev<T>(payload: Field<T, Tier>): Ev<T>;

/* ================================================================== definitions */

export interface Spec {
  readonly state?: Readonly<Record<string, Field<unknown, Tier>>>;
  readonly relations?: Readonly<Record<string, Rel<Target, Cardinality, Tier>>>;
  readonly operations?: Readonly<Record<string, Op<readonly unknown[], unknown, Tier>>>;
  readonly events?: Readonly<Record<string, Ev<unknown>>>;
  /** How generic presentations show an instance (docs/graph/04 §8): which state fields fill the summary. */
  readonly summary?: { readonly title: string; readonly subtitle?: string; readonly icon?: string; readonly status?: string; readonly time?: string };
  readonly searchable?: boolean;
  readonly mentionable?: boolean;
}

export interface TypeDef<Id extends string = string, S extends Spec = Spec, P extends string | null = string | null> {
  readonly id: Id;
  readonly kind: P extends null ? 'concept' : 'subtype';
  readonly parent: P;
  readonly spec: S;
}
export type AnyDef = TypeDef<string, Spec, string | null>;

type SummaryOf<S extends Spec> = { readonly title: StateKey<S>; readonly subtitle?: StateKey<S>; readonly icon?: StateKey<S>; readonly status?: StateKey<S>; readonly time?: StateKey<S> };
type StateKey<S extends Spec> = keyof NonNullable<S['state']> & string;

/** Define a new concept: a type with a small core (docs/graph/04 §7, define). The native concepts are defined the same way. */
export declare function defineConcept<const Id extends string, const S extends Spec & { summary?: SummaryOf<S> }>(id: Id, spec: S): TypeDef<Id, S, null>;

/** Define a subtype of a concept or of another subtype. It lists only what it adds. */
export declare function defineSubtype<const PId extends TypeId, const Id extends string, const S extends Spec>(
  parent: TypeDef<PId, Spec, string | null>, id: Id, spec: S,
): TypeDef<Id, S, PId>;

/* ================================================================== instances */

type Section<S extends Spec, K extends keyof Spec> = NonNullable<S[K]>;

type CoreKeys<M> = { [K in keyof M]: M[K] extends { readonly tier: 'core' } ? K : never }[keyof M];
type OptionalKeys<M> = { [K in keyof M]: M[K] extends { readonly tier: 'optional' } ? K : never }[keyof M];

type RelValue<R> = R extends Rel<infer Id, infer C, Tier>
  ? C extends 'one' ? InstanceOfTarget<Id> : C extends 'maybe' ? InstanceOfTarget<Id> | undefined : Collection<InstanceOfTarget<Id>>
  : never;
type OpMethod<O> = O extends Op<infer A, infer R, Tier> ? (...args: A) => Operation<R> : never;
type Payload<E> = E extends Ev<infer P> ? P : never;

type StateMembers<M> =
  { readonly [K in CoreKeys<M>]: M[K] extends Field<infer T, Tier> ? T : never } &
  { readonly [K in OptionalKeys<M>]?: M[K] extends Field<infer T, Tier> ? T : never };
type RelationMembers<M> = { readonly [K in CoreKeys<M>]: RelValue<M[K]> } & { readonly [K in OptionalKeys<M>]?: RelValue<M[K]> };
type OperationMembers<M> = { [K in CoreKeys<M>]: OpMethod<M[K]> } & { [K in OptionalKeys<M>]?: OpMethod<M[K]> };
/** Phantom key: an instance's event map, merged across a subtype chain. Never present at runtime. */
declare const eventMap: unique symbol;
type EventMembers<M> = { readonly [eventMap]?: { [K in keyof M]: Payload<M[K]> } };
export type EventsOf<I> = I extends { readonly [eventMap]?: infer E } ? NonNullable<E> : never;

type Own<S extends Spec> =
  StateMembers<Section<S, 'state'>> & RelationMembers<Section<S, 'relations'>> &
  OperationMembers<Section<S, 'operations'>> & EventMembers<Section<S, 'events'>>;

/** The instance type a definition describes. A subtype's instances are instances of its parent plus what it adds. */
export type Instance<D> = D extends TypeDef<string, infer S, infer P>
  ? (P extends TypeId ? InstanceOf<P> : InstanceBase) & Own<S>
  : never;

/** What every instance has, whatever its type and provider (docs/graph/04 §1, §3). */
export interface InstanceBase {
  readonly ref: Ref;
  readonly liveness: 'live' | 'stale' | 'gone';
  readonly summary: Summary;
  /** Narrow to a subtype: `if (thread.is(CodexThread)) thread.cloudTask`. */
  is<Id extends TypeId>(def: TypeDef<Id, Spec, string | null>): this is InstanceOf<Id>;
  /** Whether an optional operation is supported now (docs/graph/04 §4). */
  can(operation: OptionalMethodKeys<this>): boolean;
  attached<T>(key: Attachment<TypeId, T>): T | undefined;
  /** One field's changes, with the new and the old value (docs/graph/04 §3). Typed per field, so it stays sound for subtypes. */
  watch<K extends DataKeys<this>>(field: K, fn: (value: this[K], old: this[K]) => void): Disposable;
  /** Any change, by field name: a subtype's instances also report the fields it adds. */
  on(event: 'changed', fn: (change: { readonly fields: readonly string[] }) => void): Disposable;
  /** The type's own events, and those of every type it extends. */
  on<K extends keyof EventsOf<this> & string>(event: K, fn: (payload: EventsOf<this>[K]) => void): Disposable;
}

/** A type's own members: never the base members, so the helpers below can be used inside InstanceBase without a cycle. */
type OwnKeys<I> = Exclude<keyof I, keyof InstanceBase | typeof eventMap | symbol>;
export type DataKeys<I> = { [K in OwnKeys<I>]-?: I[K] extends (...args: never) => unknown ? never : K }[OwnKeys<I>];
export type MethodKeys<I> = { [K in OwnKeys<I>]-?: NonNullable<I[K]> extends (...args: never) => Operation<unknown> ? K : never }[OwnKeys<I>];
export type OptionalMethodKeys<I> = { [K in MethodKeys<I>]-?: undefined extends I[K] ? K : never }[MethodKeys<I>] & string;

/* ================================================================== values used everywhere */

export type Time = number;
export type Content = { readonly parts: readonly ContentPart[] };
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly language?: string; readonly text: string }
  | { readonly kind: 'mention'; readonly target: Ref };
export interface Ref<Id extends TypeId = TypeId> { readonly type: Id; readonly provider: string; readonly id: string }
export interface Summary { readonly title: string; readonly subtitle?: string; readonly icon?: string; readonly status?: string; readonly time?: Time }
export interface Disposable { dispose(): void; [Symbol.dispose](): void }

/* ================================================================== operations and outcomes (docs/graph/04 §4) */

export type RefusalReason = 'notAllowed' | 'unsupported' | 'unavailable' | 'invalid' | 'gone';   // gone: the pane it named has closed (layouts.md D8)
export type Outcome<T> =
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'refused'; readonly reason: RefusalReason; readonly message?: string }
  | { readonly status: 'failed'; readonly error: { readonly message: string; readonly code?: string } }
  | { readonly status: 'uncertain'; readonly operation: string };

/** What an operation returns: await it for the outcome, or call orThrow() for the value. */
export interface Operation<T> extends PromiseLike<Outcome<T>> {
  readonly id: string;
  /** Resolves with the value when done; rejects with OperationError otherwise. An uncertain outcome is never retried blindly. */
  orThrow(): Promise<T>;
}

/* ================================================================== collections (docs/graph/04 §2) */

type Scalar = string | number | boolean | undefined;
export type Filter<T> = { readonly [K in DataKeys<T> as T[K] extends Scalar ? K : never]?: T[K] | readonly T[K][] };

export interface Collection<T> extends Iterable<T> {
  readonly size: number;
  /** Resolves once the collection's current members are in the local view. */
  readonly ready: Promise<Collection<T>>;
  /** Its providers say it lists every member; false while a list is partial (still being read, or a provider that cannot tell). */
  readonly complete: boolean;
  /** Some member may be out of date: a provider's feed stopped (a backend restart, a gap) and it has not read them again. */
  readonly stale: boolean;
  find(id: string): T | undefined;
  /** A declarative filter, evaluated by the provider. */
  where(filter: Filter<T>): Collection<T>;
  /** A predicate, evaluated in this realm over the local view. */
  filter<U extends T>(fn: (item: T) => item is U): Collection<U>;
  filter(fn: (item: T) => boolean): Collection<T>;
  on(event: 'added' | 'removed', fn: (item: T) => void): Disposable;
}

/* ================================================================== attached data (docs/graph/04 §7, attach) */

export interface Attachment<Id extends TypeId, T> {
  readonly name: string;
  readonly on: Id;
  readonly schema: Schema;
  readonly __value?: T;
}
export declare function defineAttachment<const Id extends TypeId, T>(name: string, on: TypeDef<Id, Spec, string | null>, value: Field<T, Tier>): Attachment<Id, T>;

/* ================================================================== descriptors */

/** A state field as data: a builder without its methods. */
export interface FieldDescriptor { readonly member: 'state'; readonly schema: Schema; readonly tier: Tier }
export interface RelationDescriptor {
  readonly member: 'relation';
  readonly target: string | readonly string[];
  readonly cardinality: Cardinality;
  readonly tier: Tier;
  readonly owned: boolean;
  readonly inverseOf?: string;
}
export interface OperationDescriptor {
  readonly member: 'operation';
  readonly args: readonly Schema[];
  readonly minArgs: number;
  readonly returns: Schema | null;
  readonly tier: Tier;
}
export interface EventDescriptor { readonly member: 'event'; readonly payload: Schema | null }

export interface SpecDescriptor {
  readonly state?: Readonly<Record<string, FieldDescriptor>>;
  readonly relations?: Readonly<Record<string, RelationDescriptor>>;
  readonly operations?: Readonly<Record<string, OperationDescriptor>>;
  readonly events?: Readonly<Record<string, EventDescriptor>>;
  readonly summary?: { readonly title: string; readonly subtitle?: string; readonly icon?: string; readonly status?: string; readonly time?: string };
  readonly searchable?: boolean;
  readonly mentionable?: boolean;
}

/** A type definition as the runtime loads it: JSON-serializable and deeply frozen. */
export interface TypeDescriptor {
  readonly id: string;
  readonly kind: 'concept' | 'subtype';
  readonly parent: string | null;
  readonly spec: SpecDescriptor;
}

/** An attachment key as data. */
export interface AttachmentDescriptor { readonly name: string; readonly on: string; readonly schema: Schema }

/**
 * The descriptor of a definition or of an attachment key: a JSON-serializable, deeply frozen copy without the builders' methods.
 * The runtime loads descriptors, never builder objects.
 */
export declare function toDescriptor(def: AnyDef): TypeDescriptor;
export declare function toDescriptor(def: { readonly name: string; readonly on: string; readonly schema: Schema }): AttachmentDescriptor;

export {};
