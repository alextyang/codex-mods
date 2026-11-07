// The graph runtime (docs/design/integration.md §3; docs/design/runtime-core.md R1–R9; docs/graph/04). It holds the types, the resident
// instances and the realm views, and runs every operation through one path, `invoke`, whoever calls it:
//   authority -> capability -> argument validation -> interceptors (priority order, skipping the caller's own) -> the durable claim ->
//   the provider's handler (after checking it owns the instance) -> the outcome -> events.
// Providers register per type which operations they implement (with their effect: none, local or external) and which optional members
// they support. Mods' handlers will run in their own workers (C3); the native provider runs in the Host. Node built-ins only.
import { CodexModsError } from '../../../sdk/errors.mjs';
import { hostDeadline } from '../deadline.mjs';
import { createTypeRegistry } from './types.mjs';
import { createStore } from './store.mjs';
import { createViews } from './views.mjs';
import { openJournal } from './journal.mjs';
import { createAttachments } from './attachments.mjs';
import { compilePolicy, policyMatches, rewriteArgs, argRoot, isBareWhere, POLICIES_MAX } from './policies.mjs';
import { compileDefaults, DEFAULTS_MAX } from './defaults.mjs';
import { createQueries } from './query.mjs';
import { createOverrides } from './overrides.mjs';

const EFFECTS = new Set(['none', 'local', 'external']);
const IC_DEADLINE_MS = 60_000;
const IC_DEADLINE_MAX_MS = 600_000;
/** The signal of a call nothing can cancel. */
const NEVER_ABORTED = Object.freeze({ aborted: false, onAbort: () => ({ dispose() {} }) });
const MAX_INVOKE_ALL = 20;   // the most calls one approval covers (invokeAll)
/** How long a read waits for the providers that contribute to what it reads to put theirs (graph-integrity G3.4). */
const MATERIALIZE_MS = 2000;
const APPROVAL_DETAIL_MAX = 900;   // what the approval dialog shows of its detail (approvals.mjs)
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';
export { createAbort } from './abort.mjs';
const REASONS = new Set(['notAllowed', 'unsupported', 'unavailable', 'invalid', 'gone']);
/** A mod's own key for one of its calls (G6.3): what it looks the call up by later. */
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/** Outcomes (docs/graph/04 §4). */
export const done = (value) => Object.freeze({ status: 'done', value: value === undefined ? null : value });
export const refused = (reason, message) => Object.freeze({ status: 'refused', reason: REASONS.has(reason) ? reason : 'unavailable', ...(message ? { message } : {}) });
export const failed = (message, code) => Object.freeze({ status: 'failed', error: Object.freeze({ message: String(message), ...(code ? { code } : {}) }) });
const isOutcome = (v) => v !== null && typeof v === 'object' && ['done', 'refused', 'failed', 'uncertain', 'stopped'].includes(v.status);
/** A policy's refusal carries the policy that made it (`by`); only the graph's own policies can say so (a mod's outcome never can). */
const BY_POLICY = Symbol('by policy');
/** A stop is made by the chain for the interceptor that answered it (graph-integrity G6.2): no handler's or policy's outcome is one. */
const BY_CHAIN = Symbol('by chain');
/**
 * An interceptor's stop (graph-integrity G6.2): the operation did not happen, and nothing failed; `by` the mod that stopped it. Its caller
 * learns what happens next from events.
 */
const stoppedBy = (owner, message) => Object.freeze({ status: 'stopped', by: Object.freeze({ kind: 'mod', id: String(owner).replace(/^mod:/, '') }),
  ...(typeof message === 'string' && message ? { message: message.slice(0, 500) } : {}), [BY_CHAIN]: true });
function normalize(v) {
  if (!isOutcome(v)) return done(v);
  if (v.status === 'done') return done(v.value);
  if (v.status === 'refused') return v[BY_POLICY] ? Object.freeze({ ...refused(v.reason, v.message), by: v[BY_POLICY], [BY_POLICY]: v[BY_POLICY] }) : refused(v.reason, v.message);
  if (v.status === 'failed') return failed(v.error?.message ?? 'failed', v.error?.code);
  if (v.status === 'stopped') return v[BY_CHAIN] ? Object.freeze({ status: 'stopped', by: v.by, ...(v.message ? { message: v.message } : {}) }) : failed('only an interceptor stops a call', 'notInterceptor');
  return Object.freeze({ status: 'uncertain', operation: v.operation ?? '' });
}

/**
 * @param {{ log?: object, journalFile?: string, journal?: object, now?: () => number,
 *   authorize?: (caller: object, request: { type: string, use: string, operation?: string, ref?: object }) => boolean,
 *   approvals?: ReturnType<typeof import('./approvals.mjs').createApprovals>, automaticOf?: (modId: string, id: string) => object | null,
 *   overridesFile?: string }} [o]  `overridesFile` keeps the user's values an override set aside (a crash puts them back at the next start).
 *   `approvals` asks the user about the calls of mods to operations whose provider says they need it (R17); `automaticOf` gives a mod's
 *   automatic action the user has on, as it was declared then (public-hooks.md §3.9), or null; `policyOff(owner, id)` says the user turned
 *   that policy of a mod off (§3.7). `permissions` (framework-ui.md F8): `askFor(caller, request)` names the grant decided `ask` that would let
 *   a mod's call through when its held grants do not, and `hold(caller, grant, call)` waits for the user's answer (null to go on, else a refusal).
 */
export function createGraph(o = {}) {
  const now = o.now ?? Date.now;
  const log = o.log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const authorize = o.authorize ?? (() => true);
  const registry = createTypeRegistry();
  // a derived one relation (Thread.draft) is given by the instance's own provider or a native one, never another mod's (H5x review 1)
  const store = createStore({ registry, now, derivedFrom: (target, referrer) => referrer.provider === target.provider || providers.get(referrer.provider)?.owner === 'native' });
  const views = createViews({ registry, store });
  // Attached data (04 §7, public-hooks.md §3.3): kept apart from the instances; a change is a `changed` event on `attached`, and a
  // deleted instance takes its values with it.
  const conceptOf = (typeId) => registry.get(typeId)?.concept ?? typeId;
  const attachments = createAttachments({ sameConcept: (a, b) => conceptOf(a) === conceptOf(b), log, onChange: (ref, change) => store.attachedChanged(ref, change) });
  store.onEvent((e) => { if (e.kind === 'event' && e.name === 'deleted') attachments.deleted(e.ref); });
  const journal = o.journal ?? (o.journalFile ? openJournal(o.journalFile, { now }) : null);
  const providers = new Map();     // provider id -> {id, owner, types: Map<typeId, {operations: Map<name, {handler, effect}>, supports: Set}>}
  const queries = createQueries({ registry, store, providers, log });
  const interceptors = new Set();  // {owner, type, operation, fn, priority, replaces, seq}
  const opListeners = new Set();
  const appOrigins = new Set();     // {match, operations}: where the app's own path is held for interceptors (I2, I11)
  const queues = new Map();        // `${ref key}\n${lane}` -> the tail of the decisions waiting on that object (interception.md I7)
  const automaticRuns = new Map(); // `${modId}\n${action}` -> the times its calls went without asking, within the last hour (§3.9)
  const policies = new Map();      // `${owner}\n${id}` -> {owner, p, seq}: the mods' policies (public-hooks.md §3.7)
  const defaultsBy = new Map();    // `${owner}\n${id}` -> {owner, d, seq}: the mods' defaults (§3.8)
  const defaultsListeners = new Set();
  const defaultsChanged = () => { for (const fn of [...defaultsListeners]) { try { fn(); } catch { /* a listener's own fault */ } } };
  const policyListeners = new Set();
  let seq = 0, icSeq = 0, closed = false;

  // ---------------------------------------------------------------- types
  function registerTypes(descriptors, owner) { const ids = registry.register(descriptors, owner); degradedOwners.delete(owner); return ids; }

  // ---------------------------------------------------------------- providers
  /**
   * @param {string} owner 'native' or a mod id
   * @param {string} id the provider id written in refs (for example 'codex')
   * @param {{ types: Record<string, { operations?: Record<string, { handler: Function, effect: 'none' | 'local' | 'external', approval?: Function,
   *   widens?: Function, alwaysAsks?: Function, resolve?: Function }>, supports?: string[] }>, onObserve?: (query: object) => void }} spec  `onObserve` is told
   *   when a realm starts observing one of its instances or their relations, so it can load what is not resident yet (residency,
   *   integration.md §3: heavy fields load when observed). `search(text, {types, limit})` is the provider's own search (public-hooks.md
   *   §3.2): `[{ref, field?, content?, snippet?}]`, `content` the type whose content matched (its snippet reaches only its readers), the
   *   instances resident; `searchContent`: the type of the content it searches, so it is not asked at all for a reader who may not read
   *   that (what it finds may be put in the graph, which would tell). An operation's `approval(call)` is the prompt R17 shows for a mod's call (none:
   *   it is not asked about); `widens({instance, original, args})` says why a change of the user's or a mod's arguments does more than the
   *   call did (public-hooks.md §3.5: refused), or null; `alwaysAsks({instance, args})` says the call is one no automatic action covers (§3.9);
   *   `resolve({ref, instance, args, caller})` gives the arguments with what the call leaves out filled in (the mods' defaults, §3.8), once,
   *   before the interceptors, the policies and the approval: the call then has those. `change({instance, before, after, by})` referees
   *   each interceptor's change of the arguments as its own (graph-integrity G3.5: an input mods share, where each may add only its own
   *   part): a reason refuses the call, naming that mod; `{quiet: true}` lets it through as a change its grants already cover (only its
   *   own part of a shared input: a turn's context), so the user is not asked about that mod for it; `by` is `{kind, id}`, the mod's id.
   *   `contributes` (graph-integrity G3.4): `[{type, via}]`, the instances of a type it provides that it links to others' instances through
   *   the relation `via` (a mod's Settings of a chat, through `thread`). Before anyone reads that inverse relation of an instance (the chat's
   *   `settings`), or lists the type pinned to one (`{thread: ref}`), its `onObserve({target, relation})` is asked to put its contributions
   *   for that target, within the read's deadline: they are found where the target's relations are, never by a naming convention.
   *   A mod's provider that links to another provider's instance contributes to it (G3.2): the mod must be able to read that instance's
   *   type, and hold `graph.contribute` for its concept; a put without them is refused.
   */
  function registerProvider(owner, id, spec) {
    if (providers.has(id)) throw new CodexModsError('Conflict', `provider ${id} is already registered`);
    const types = new Map();
    for (const [typeId, impl] of Object.entries(spec.types ?? {})) {
      const t = registry.get(typeId);
      if (!t) throw new CodexModsError('Invalid', `provider ${id}: unknown type ${typeId}`);
      const operations = new Map();
      for (const [name, op] of Object.entries(impl.operations ?? {})) {
        if (!t.members.operations.has(name)) throw new CodexModsError('Invalid', `provider ${id}: ${typeId} has no operation ${name}`);
        if (typeof op?.handler !== 'function') throw new CodexModsError('Invalid', `provider ${id}: ${typeId}.${name} needs a handler`);
        if (!EFFECTS.has(op.effect)) throw new CodexModsError('Invalid', `provider ${id}: ${typeId}.${name} must declare its effect (none, local or external)`);
        for (const k of ['approval', 'widens', 'alwaysAsks', 'resolve', 'change']) if (op[k] !== undefined && typeof op[k] !== 'function') throw new CodexModsError('Invalid', `provider ${id}: ${typeId}.${name}: ${k}(call) is a function`);
        operations.set(name, { handler: op.handler, effect: op.effect, ...(op.approval ? { approval: op.approval } : {}), ...(op.widens ? { widens: op.widens } : {}),
          ...(op.alwaysAsks ? { alwaysAsks: op.alwaysAsks } : {}), ...(op.resolve ? { resolve: op.resolve } : {}), ...(op.change ? { change: op.change } : {}) });
      }
      const supports = new Set(impl.supports ?? []);
      for (const name of supports) {
        const tier = memberTier(t, name);
        if (tier === null) throw new CodexModsError('Invalid', `provider ${id}: ${typeId} has no member ${name}`);
        if (tier !== 'optional') throw new CodexModsError('Invalid', `provider ${id}: ${typeId}.${name} is a core member; only optional members are declared`);
      }
      // Implementing an optional operation declares it (T5).
      for (const name of operations.keys()) if (t.members.operations.get(name).tier === 'optional') supports.add(name);
      types.set(typeId, { operations, supports });
    }
    const contributes = [];
    for (const c of spec.contributes ?? []) {
      const t = registry.get(c?.type);
      const m = t?.members.relations.get(c?.via);
      if (!t || !m || m.inverseOf || m.cardinality === 'many') throw new CodexModsError('Invalid', `provider ${id}: contributes is a list of {type, via}: a type it provides and its one or maybe relation to what it adds to`);
      if (![...types.keys()].some((tid) => registry.isA(tid, c.type) || registry.isA(c.type, tid))) throw new CodexModsError('Invalid', `provider ${id}: it contributes ${c.type} instances, a type it does not provide`);
      if (typeof spec.onObserve !== 'function') throw new CodexModsError('Invalid', `provider ${id}: a provider that contributes is asked for its contributions (onObserve)`);
      contributes.push(Object.freeze({ type: c.type, via: c.via }));
    }
    // what it realizes that no native check has shown yet (graph-integrity G9.3): by type, member names; the framework's own surfaces do
    // not offer them, and an assessment says so
    const unverified = new Map();
    if (spec.unverified !== undefined) {
      if (spec.unverified === null || typeof spec.unverified !== 'object' || Array.isArray(spec.unverified)) throw new CodexModsError('Invalid', `provider ${id}: unverified is {type: [member names]}`);
      for (const [typeId, names] of Object.entries(spec.unverified)) {
        const t = registry.get(typeId);
        if (!t) throw new CodexModsError('Invalid', `provider ${id}: unverified names an unknown type ${typeId}`);
        if (!Array.isArray(names)) throw new CodexModsError('Invalid', `provider ${id}: unverified.${typeId} is a list of member names`);
        for (const name of names) if (memberTier(t, name) === null && !t.members.events?.has?.(name)) throw new CodexModsError('Invalid', `provider ${id}: ${typeId} has no member ${name}`);
        unverified.set(typeId, new Set(names));
      }
    }
    const p = { id, owner, types, unverified, disposed: false, onObserve: typeof spec.onObserve === 'function' ? spec.onObserve : null, contributes,
      search: typeof spec.search === 'function' ? spec.search : null, searchContent: typeof spec.searchContent === 'string' ? spec.searchContent : null };
    providers.set(id, p);
    store.declareProvider(id, [...new Set([...types.keys()].map((tid) => registry.get(tid).concept))]);
    const live = () => { if (p.disposed) throw new CodexModsError('Disposed', `provider ${id} is disposed`); };
    // G3.2: a mod's link to another provider's instance is a contribution to it; the native provider and the framework link where they must
    const asMod = typeof owner === 'string' && owner.startsWith('mod:') ? Object.freeze({ kind: 'mod', id: owner.slice(4), owner }) : null;
    const mayLink = (ref, links) => {
      if (!asMod || links === null || typeof links !== 'object') return;
      for (const [name, v] of Object.entries(links)) {
        for (const target of Array.isArray(v) ? v : v ? [v] : []) {
          if (!isRef(target) || target.provider === id) continue;
          const concept = registry.get(target.type)?.concept ?? target.type;
          if (!authorize(asMod, { type: target.type, use: 'read', ref: target })) throw new CodexModsError('Denied', `${ref?.type}.${name} links to another provider's ${target.type}: linking needs graph.read for it`);
          if (!authorize(asMod, { type: target.type, use: 'contribute', ref: target })) throw new CodexModsError('Denied', `${ref?.type}.${name} adds to another provider's ${concept}: that needs graph.contribute:${concept}`);
        }
      }
    };
    return {
      id,
      put(ref, data) { live(); mayLink(ref, data?.links); return store.put(id, ref, data); },
      update(ref, data) { live(); mayLink(ref, data?.links); return store.update(id, ref, data); },
      remove(ref, data) { live(); return store.remove(id, ref, data); },
      /** A named event its type declares (docs/graph/04 §3): `payload` follows the event's schema (none: null). */
      emit(ref, name, payload, data) {
        live();
        const t = registry.get(ref?.type);
        const ev = t?.members.events.get(name);
        if (!ev) throw new CodexModsError('Invalid', `${ref?.type} has no event ${name}`);
        // an object payload not given says nothing (its fields are still checked: a required one makes it refused)
        const given = ev.payload && ev.payload.t === 'object' && (payload === undefined || payload === null) ? {} : payload;
        const issues = ev.payload ? registry.valueIssues(ev.payload, given, 'payload') : (payload === undefined || payload === null ? [] : [{ path: 'payload', message: 'the event has no payload' }]);
        if (issues.length) throw new CodexModsError('Invalid', `${ref.type}.${name}: ${issues[0].path} ${issues[0].message}`);
        return store.event(id, ref, name, ev.payload ? given : null, data);
      },
      setComplete(typeId, isComplete) { live(); store.setComplete(id, registry.get(typeId)?.concept ?? typeId, isComplete); },
      markStale(match) { live(); return store.setLiveness(id, 'stale', match); },
      markLive(match) { live(); return store.setLiveness(id, 'live', match); },
      get(ref) { return store.get(ref); },
      dispose() { if (p.disposed) return; p.disposed = true; providers.delete(id); store.undeclareProvider(id); },
      /** True once disposed, by its owner or because every type it provided went with another owner. */
      get disposed() { return p.disposed; },
    };
  }
  // ---------------------------------------------------------------- contributions, materialized on reading (graph-integrity G3.4)
  /** The providers that contribute instances of `typeId` (or of a type it is or that is it) through `via`. */
  function contributorsOf(typeId, via) {
    const out = [];
    for (const p of providers.values()) {
      if (!p.disposed && p.onObserve && p.contributes.some((c) => c.via === via && (registry.isA(c.type, typeId) || registry.isA(typeId, c.type)))) out.push(p);
    }
    return out;
  }
  /** Each puts its contributions for `target` first, within the read's deadline: a slow one adds nothing to this read (what it puts later
   *  still reaches the views). Null when none is asked: the read goes on at once. */
  function askContributors(list0, target, via) {
    // only a contributor that may read the target and add to it is told which instance is read (review 2026-11-05 #6)
    const list = list0.filter((p) => {
      if (typeof p.owner !== 'string' || !p.owner.startsWith('mod:')) return true;   // the native provider's and the framework's own
      const who = Object.freeze({ kind: 'mod', id: p.owner.slice(4), owner: p.owner });
      return authorize(who, { type: target.type, use: 'read', ref: target }) && authorize(who, { type: target.type, use: 'contribute', ref: target });
    });
    if (!list.length) return null;
    return Promise.all(list.map((p) => {
      let timer;
      const limit = new Promise((resolve) => { timer = setTimeout(resolve, MATERIALIZE_MS); timer.unref?.(); });
      const asked = Promise.resolve().then(() => p.onObserve(Object.freeze({ target, relation: via })))
        .catch((e) => log.warn('a provider did not put its contributions', { provider: p.id, message: String(e?.message ?? e) }));
      return Promise.race([asked, limit]).finally(() => clearTimeout(timer));
    })).then(() => {});
  }
  /** Before a read of an instance's inverse relation (a chat's `settings`): what contributes to it is put for that instance (a promise;
   *  null when nothing contributes to it). */
  function materialize(ref, relation) {
    const snap = ref ? store.get(ref) : null;
    const m = snap ? registry.get(snap.ref.type)?.members.relations.get(relation) : null;
    if (!m?.inverseOf) return null;
    return askContributors(contributorsOf(m.target, m.inverseOf), snap.ref, m.inverseOf);
  }
  /** Before a list or a query of a type whose where pins one of its relations to an instance (`{thread: ref}`): the same, for that one. */
  function materializeWhere(typeId, where) {
    const t = registry.get(typeId);
    if (!t || where === null || typeof where !== 'object' || Array.isArray(where)) return null;
    const asks = [];
    for (const [name, v] of Object.entries(where)) {
      const m = t.members.relations.get(name);
      const target = v !== null && typeof v === 'object' && isRef(v.$eq) ? v.$eq : v;
      if (!m || m.inverseOf || m.cardinality === 'many' || !isRef(target)) continue;
      const snap = store.get(target);
      const asked = snap ? askContributors(contributorsOf(typeId, name), snap.ref, name) : null;
      if (asked) asks.push(asked);
    }
    return asks.length ? Promise.all(asks).then(() => {}) : null;
  }

  function memberTier(t, name) {
    for (const s of ['state', 'relations', 'operations']) { const m = t.members[s].get(name); if (m) return m.tier ?? 'core'; }
    return null;
  }
  /** docs/graph/04 §2, §4: the optional members an instance supports (the instance's own declaration, else its provider's). */
  function capabilities(ref) {
    const s = store.get(ref);
    if (!s) return null;
    if (s.caps) return s.caps;
    const p = providers.get(s.ref.provider);
    if (!p) return [];
    const out = new Set();
    for (const id of registry.get(s.ref.type)?.chain ?? []) for (const x of p.types.get(id)?.supports ?? []) out.add(x);
    return [...out];
  }

  /** What an instance's provider declares unverified (graph-integrity G9.3), along its type's chain: member names, or null for none. */
  function unverifiedOf(ref) {
    const s = store.get(ref);
    const p = s ? providers.get(s.ref.provider) : null;
    if (!p || !p.unverified?.size) return null;
    const out = new Set();
    for (const id of registry.get(s.ref.type)?.chain ?? []) for (const x of p.unverified.get(id) ?? []) out.add(x);
    return out.size ? [...out] : null;
  }

  // ---------------------------------------------------------------- interception
  /**
   * Intercept an operation on a type and its subtypes (T6). `replaces: true` lets the interceptor answer without calling next.
   * `deadlineMs` bounds the time the interceptor itself takes (not the time inside `next`): 60 s by default, at most 10 min for one that
   * asks the user (interception.md I6).
   */
  function intercept(owner, typeId, operation, fn, { priority = 0, replaces = false, deadlineMs, onFailure = 'allow' } = {}) {
    if (!registry.has(typeId)) throw new CodexModsError('Invalid', `unknown type ${typeId}`);
    if (!registry.get(typeId).members.operations.has(operation)) throw new CodexModsError('Invalid', `${typeId} has no operation ${operation}`);
    if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'an interceptor is a function (call, next) => outcome');
    if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs > 0)) throw new CodexModsError('Invalid', 'deadlineMs must be a positive number');
    // what its failure means (G6.6): the call goes on as if it had not been there (the default), or is refused; never a quiet stop
    if (onFailure !== 'allow' && onFailure !== 'refuse') throw new CodexModsError('Invalid', "onFailure is 'allow' or 'refuse'");
    const ic = { owner, type: typeId, operation, fn, priority, replaces: !!replaces, onFailure, seq: ++icSeq, deadlineMs: Math.min(deadlineMs ?? IC_DEADLINE_MS, IC_DEADLINE_MAX_MS) };
    interceptors.add(ic);
    holdsChanged();
    return { dispose() { if (interceptors.delete(ic)) holdsChanged(); } };
  }
  /**
   * Declare that the app's own path for some operations crosses a choke point that holds them for the interceptors (interception.md I2,
   * I11; docs/graph/04 §5): `match(snapshot)` picks the instances, for example the native provider's threads.
   */
  function bindAppOrigin(match, operations) {
    if (typeof match !== 'function' || !Array.isArray(operations)) throw new CodexModsError('Invalid', 'bindAppOrigin(match, operations)');
    const b = { match, operations: new Set(operations) };
    appOrigins.add(b);
    return { dispose() { appOrigins.delete(b); } };
  }
  /** Reflection (I11): whether this operation on this instance passes interceptors from any origin, or only through the graph. */
  function interceptable(ref, operation) {
    const snap = ref ? store.get(ref) : null;
    if (!snap || !registry.get(snap.ref.type)?.members.operations.has(operation)) return null;
    for (const b of appOrigins) { try { if (b.operations.has(operation) && b.match(snap)) return 'any origin'; } catch { /* a binding's fault is its own */ } }
    return 'graph only';
  }
  /** Whether any interceptor would see this operation on an instance of this type (interception.md I4). */
  function intercepted(typeId, operation) {
    if (!registry.has(typeId)) return false;
    for (const ic of interceptors) if (ic.operation === operation && registry.isA(typeId, ic.type)) return true;
    return policiesFor(typeId, operation).length > 0;   // a policy on it holds the app's own action too (§3.7)
  }

  // ---------------------------------------------------------------- policies (public-hooks.md §3.7)
  const isOff = (owner, id) => { try { return o.policyOff?.(owner, id) === true; } catch { return false; } };
  /**
   * A mod's policy (policies.mjs): registered again under the same id, it replaces the one before. The mod needs to be allowed to intercept
   * the operation (a policy binds others' calls as an interceptor does).
   */
  function policy(owner, spec) {
    let p;
    try { p = compilePolicy(spec, (id) => registry.get(id), (a, b) => registry.has(a) && registry.has(b) && registry.isA(a, b)); } catch (e) { throw new CodexModsError('Invalid', `policy: ${e?.message ?? e}`); }
    if (!authorize(ownerCaller(owner), { type: p.type, use: 'intercept', operation: p.operation })) throw new CodexModsError('Denied', `a policy on ${p.type}.${p.operation} needs a graph.intercept grant for it`);
    const key = `${owner}\n${p.id}`;
    if (!policies.has(key) && [...policies.values()].filter((x) => x.owner === owner).length >= POLICIES_MAX) throw new CodexModsError('Invalid', `a mod has at most ${POLICIES_MAX} policies`);
    const entry = { owner, p, seq: ++icSeq };   // the interceptors' counter: a rewriting policy takes its place in their chain
    policies.set(key, entry);
    policiesChanged(owner);
    return { dispose() { if (policies.get(key) === entry) { policies.delete(key); policiesChanged(owner); } } };
  }
  /**
   * A mod's defaults (public-hooks.md §3.8, defaults.mjs): registered again under the same id, they replace the ones before. A Setting's
   * default is that setting's value wherever the user set none, and an Automation's fills the fields of new automations: the mod needs to
   * be allowed to set the setting (`Setting.set`), to edit automations (`Automation.edit`).
   */
  function defaults(owner, spec) {
    let d;
    try { d = compileDefaults(spec); } catch (e) { throw new CodexModsError('Invalid', `defaults: ${e?.message ?? e}`); }
    if (d.presentation) {
      // a presentation's (G5.2): a type of the Presentation concept, set by its own operations (the user's), which the mod may run
      const t = registry.get(d.of);
      if (!t || !registry.isA(d.of, 'Presentation')) throw new CodexModsError('Invalid', `defaults: ${d.of} is not a presentation type`);
      for (const f of d.for ?? []) if (!registry.has(f)) throw new CodexModsError('Invalid', `defaults: for names ${f}, which is not a type`);
      for (const op of ['_expand', '_collapse']) if (!t.members.operations.has(op)) throw new CodexModsError('Invalid', `defaults: a ${d.of} is not expanded or collapsed by the user`);
      const op = d.state.expanded ? '_expand' : '_collapse';
      if (!authorize(ownerCaller(owner), { type: d.of, use: 'act', operation: op })) throw new CodexModsError('Denied', `defaults of ${d.of} need a graph.act grant for ${d.of}.${op}`);
    }
    const needs = d.of === 'Setting' ? ['Setting', 'set'] : d.of === 'Automation' ? ['Automation', 'edit'] : null;
    if (needs && !authorize(ownerCaller(owner), { type: needs[0], use: 'act', operation: needs[1] })) throw new CodexModsError('Denied', `defaults of ${d.of} need a graph.act grant for ${needs.join('.')}`);
    const key = `${owner}\n${d.id}`;
    if (!defaultsBy.has(key) && [...defaultsBy.values()].filter((x) => x.owner === owner).length >= DEFAULTS_MAX) throw new CodexModsError('Invalid', `a mod has at most ${DEFAULTS_MAX} defaults`);
    const entry = { owner, d, seq: ++seq };
    defaultsBy.set(key, entry);
    defaultsChanged();
    return { dispose() { if (defaultsBy.get(key) === entry) { defaultsBy.delete(key); defaultsChanged(); } } };
  }
  /**
   * The defaults that apply to an instance, in the mods' order: a new chat's Draft `[{mod, id, target, content}]`, a Setting `[{mod, id,
   * key, value}]`, an Automation to be (a snapshot of its spec, its relations in `links`) `[{mod, id, values}]`. Each where reads as its mod
   * reads; one that cannot be decided does not apply.
   */
  function defaultsFor(of, inst) {
    const out = [];
    for (const { owner, d } of [...defaultsBy.values()].sort((a, b) => rank(a.owner) - rank(b.owner) || a.seq - b.seq)) {
      if (d.of !== of || d.presentation) continue;
      if (d.where) {
        try { if (d.where.evaluate(inst, envOf(owner, inst)) !== true) continue; } catch { continue; }
      }
      const given = d.of === 'Setting' ? { key: d.key, value: d.value } : d.of === 'Automation' ? { values: d.values } : { target: d.target, content: d.content };
      out.push(Object.freeze({ mod: owner.replace(/^mod:/, ''), id: d.id, ...given }));
    }
    return out;
  }
  /**
   * The state a new presentation of `type` starts with, for its `subject` (G5.2): `[{mod, id, state}]` in the mods' order, each whose `for`
   * names the subject's type (or one of its concepts) and whose `where` holds on it as its mod reads it (a subject its mod may not read,
   * or a where that cannot be decided, gives none).
   */
  function presentationDefaults(type, subject) {
    const out = [];
    const list = [...defaultsBy.values()].filter((x) => x.d.presentation && registry.isA(type, x.d.of));
    if (!list.length || !subject?.ref) return out;
    const chain = registry.get(subject.ref.type)?.chain ?? [subject.ref.type];
    for (const { owner, d } of list.sort((a, b) => rank(a.owner) - rank(b.owner) || a.seq - b.seq)) {
      if (d.for && !d.for.some((f) => chain.includes(f))) continue;
      if (d.where) {
        if (!authorize(ownerCaller(owner), { type: subject.ref.type, use: 'read', ref: subject.ref })) continue;
        try { if (d.where.evaluate(subject, envOf(owner, subject)) !== true) continue; } catch { continue; }
      }
      out.push(Object.freeze({ mod: owner.replace(/^mod:/, ''), id: d.id, state: d.state }));
    }
    return out;
  }
  /** Interceptors or policies came or went: what holds the app's own actions may have changed (framework-main asks only when one would). */
  const holdListeners = new Set();
  function holdsChanged() { for (const fn of [...holdListeners]) { try { fn(); } catch { /* a listener's own fault */ } } }
  function policiesChanged(owner) {
    holdsChanged(); for (const fn of [...policyListeners]) { try { fn(owner); } catch { /* a listener's own fault */ } } }
  /**
   * The policies on this operation of this type (a supertype's included) the user has not turned off, in the order they came. With a ref,
   * those whose mod may intercept it on that instance (the framework's own instances and the mods' settings are nobody's to police, as
   * they are nobody's to intercept).
   */
  const policiesFor = (typeId, operation, ref = null) => [...policies.values()]
    .filter(({ owner, p }) => p.operation === operation && registry.has(p.type) && registry.isA(typeId, p.type) && !isOff(owner, p.id)
      && (!ref || authorize(ownerCaller(owner), { type: typeId, use: 'intercept', operation, ref })))
    .sort((a, b) => a.seq - b.seq);
  /** A mod's policies, each with whether the user has it on (its page lists them). */
  const policiesOf = (owner) => [...policies.values()].filter((x) => x.owner === owner).sort((a, b) => a.seq - b.seq)
    .map(({ p }) => Object.freeze({ id: p.id, title: p.title, spec: p.spec, on: !isOff(owner, p.id) }));
  /** The user's order of the mods (E6): an owner's place, the framework's and the app's after every mod. */
  const rank = (owner) => { const r = o.rankOf?.(String(owner).replace(/^mod:/, '')); return Number.isFinite(r) ? r : Number.MAX_SAFE_INTEGER; };
  /**
   * What a mod's wheres read, as that mod reads (a policy's, a default's, an automatic action's bounds): relations and attached data it may
   * see, and an argument's instance only when it may read it (null: unknown). A where never tells a mod about what it cannot read.
   */
  /**
   * The env a where reads `inst` with, as its mod reads; an instance not stored (one to be: an automation's spec) reads its own relations
   * from the links that come with it, each target as that mod may read it (not resident or not readable: unknown).
   */
  function envOf(owner, inst) {
    const { env, resolve } = readerEnv(owner);
    if (!inst?.ref || store.get(inst.ref)) return env;
    const own = store.key(inst.ref), links = inst.links ?? {};
    return { ...env, related(x, name) {
      if (!x?.ref || store.key(x.ref) !== own) return env.related(x, name);
      const m = registry.get(inst.ref.type)?.members.relations.get(name);
      if (!m) return undefined;
      const v = links[name];
      if (m.cardinality === 'many') {
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v)) return undefined;
        const all = v.map((r) => resolve(r));
        return all.every(Boolean) ? all : undefined;
      }
      return v ? resolve(v) ?? undefined : null;
    } };
  }
  function readerEnv(owner) {
    const reader = ownerCaller(owner);
    const may = (snap) => authorize(reader, { type: snap.ref.type, use: 'read', ref: snap.ref });
    return {
      env: store.whereEnv((x, mod) => attachments.viewFor(String(owner).replace(/^mod:/, ''), x.ref)?.[mod], may),
      resolve: (r) => { const snap = store.get(r); return snap && may(snap) ? snap : null; },
    };
  }
  /**
   * Every policy that refuses or asks about this call (its final arguments, and the arguments it came with: a change cannot slip past a
   * refusal), in order: `[{entry, then}]`. A policy that cannot be evaluated refuses; one whose where cannot be decided follows `unknown`.
   */
  function policyHits(typeId, operation, inst, args, original, caller) {
    const list = policiesFor(typeId, operation, inst.ref).filter(({ p }) => !p.request && !p.then.rewrite);
    if (!list.length) return [];
    const date = new Date(now());
    const hits = [];
    for (const entry of list) {
      const { owner, p } = entry;
      let m;
      try {
        const { env, resolve } = readerEnv(owner);
        const on = (a) => policyMatches(p, { inst, args: a, caller, date, env, resolve });
        const a = on(args), b = original && original !== args ? on(original) : false;
        m = a === true || b === true ? true : a === 'unknown' || b === 'unknown' ? 'unknown' : false;
      } catch (e) { log.warn('a policy could not be evaluated: it refuses', { owner, policy: p.id, message: String(e?.message ?? e) }); m = true; }
      if (m === false || (m === 'unknown' && p.unknown === 'allow')) continue;
      hits.push({ entry, then: p.then });
    }
    return hits;
  }
  /**
   * A request's policies (public-hooks.md §3.7, `on: {request}`): before its `ask` interceptors, those that apply, in order, answer it as
   * their mod's own answer (its grants, prompts and automatic action) until one does. Only a where known to hold answers:
   * an approval is never given on a guess. Done when one answered, else null.
   */
  async function answerByPolicy(t, inst) {
    const date = new Date(now());
    for (const entry of policiesFor(t.id, 'ask', inst.ref).filter(({ p }) => p.request)) {
      const { owner, p } = entry;
      let m;
      try {
        const { env, resolve } = readerEnv(owner);
        m = policyMatches(p, { inst: store.get(inst.ref) ?? inst, args: [], caller: null, date, env, resolve });
      } catch (e) { log.warn('a request policy could not be evaluated: it does not answer', { owner, policy: p.id, message: String(e?.message ?? e) }); continue; }
      if (m !== true) continue;
      const a = p.then.answer;
      const cur = store.get(inst.ref) ?? inst;
      // an approval's option of the kind the policy names (graph-integrity G1.6); a question's answers per prompt
      const options = Array.isArray(cur.state?.options) ? cur.state.options : [];
      const option = a.approve ? options.find((x) => x?.kind === 'approve' && (x.scope ?? 'once') === a.approve) : a.deny ? options.find((x) => x?.kind === 'deny') : null;
      if ((a.approve || a.deny) && !option) { log.info('a request policy did not answer: the request offers no such option', { owner, policy: p.id }); continue; }
      const operation = 'answer';
      const args = option ? [option.id] : [a.answers];
      const out = await invoke({ ref: inst.ref, operation, args, caller: modCaller(owner), origin: `policy:${p.id}`, automatic: p.automatic,
        policy: Object.freeze({ id: p.id, title: p.title }), whileHeld: true });
      if (out.status === 'done') return out;
      log.info('a request policy did not answer', { owner, policy: p.id, status: out.status, message: out.message ?? out.error?.message });
      if (store.get(inst.ref)?.state?.status !== 'pending') return null;   // answered or gone meanwhile
    }
    return null;
  }
  /**
   * The rewriting policies on a call (public-hooks.md §3.7 `then.rewrite`) as stages of its chain, each in its mod's place among the
   * interceptors (the user's order).
   */
  const rewriteStages = (typeId, operation, ref) => policiesFor(typeId, operation, ref).filter(({ p }) => !p.request && p.then.rewrite)
    .map((entry) => ({ rewrite: entry, owner: entry.owner, priority: 0, seq: entry.seq }));
  /**
   * A rewriting policy's change of the call it is given: the new arguments, null (it does not apply or cannot be applied: skipped), or
   * the refusal (the arguments it makes are invalid, or its mod may not make the call: a rewrite is its mod's change).
   */
  function rewriteBy(entry, t, operation, c, m) {
    const { owner, p } = entry;
    let next;
    try {
      const { env, resolve } = readerEnv(owner);
      if (policyMatches(p, { inst: store.get(c.ref) ?? c.instance, args: c.args, caller: c.caller, date: new Date(now()), env, resolve }) !== true) return null;
      next = rewriteArgs(p.then.rewrite, c.args);
    } catch (e) { log.warn('a rewriting policy could not be applied: skipped', { owner, policy: p.id, message: String(e?.message ?? e) }); return null; }
    if (!next) return null;
    const bad = argIssues(m, next);
    if (bad.length) return { refused: refused('invalid', `changed by ${owner.replace(/^mod:/, '')}'s policy “${p.title}”: ${bad[0].path} ${bad[0].message}`) };
    if (!authorize(modCaller(owner), { type: t.id, use: 'act', operation, ref: c.ref })) return { refused: refused('notAllowed', `${owner.replace(/^mod:/, '')}'s policy “${p.title}” changed the call, and that mod may not make it`) };
    return { args: next };
  }
  const modCaller = (owner) => Object.freeze({ kind: 'mod', id: owner.replace(/^mod:/, ''), owner });
  /** What a policy that refuses says: its reason, the policy and its mod (the user reads where it happened). */
  const policyRefusal = ({ entry }, reason) => Object.freeze({ status: 'refused', reason: 'notAllowed',
    message: `${reason} (“${entry.p.title}”, a policy of ${entry.owner.replace(/^mod:/, '')})`, [BY_POLICY]: Object.freeze({ mod: entry.owner.replace(/^mod:/, ''), policy: entry.p.id }) });
  /**
   * The policies' gate on a call about to run: null to go on, the refusal, or (policies that ask) a promise of either. Every refusal is
   * found before anyone is asked (one that asks never masks one that refuses); then each that asks must be confirmed. Without a policy
   * that applies it decides at once: the call goes on in the same turn, as before any policy existed.
   */
  function policyGate(t, operation, inst, args, original, caller, signal, pre = null) {
    const hits = policyHits(t.id, operation, inst, args, original, caller);
    if (!hits.length) return null;
    const refusal = hits.find((h) => h.then.refuse);
    if (refusal) return policyRefusal(refusal, refusal.then.refuse);
    // one the user confirmed with others (invokeAll), for the call as it is now, is not asked again: that registration of it (one registered
    // again meanwhile, its question perhaps another, is asked)
    const confirmed = (hit) => !!pre?.policies?.has(hit.entry.seq) && preHolds(pre, inst, args);
    const asks = hits.filter((h) => !confirmed(h));
    if (!asks.length) return null;
    return (async () => {
      for (const hit of asks) { const out = await askPolicy(hit, signal); if (out) return out; }
      return null;
    })();
  }
  async function askPolicy(hit, signal) {
    if (!o.approvals) return policyRefusal(hit, 'this needs your confirmation, and you cannot be asked here');
    const answer = await o.approvals.ask({ modId: hit.entry.owner.replace(/^mod:/, ''), operation: `policy:${hit.entry.p.id}`, policy: { title: hit.then.ask.title, message: hit.then.ask.message, name: hit.entry.p.title }, signal });
    return answer.approved ? null : policyRefusal(hit, `not confirmed: ${answer.reason}`);
  }
  /** An interceptor's owner as a caller of the policy. */
  const ownerCaller = (owner) => ({ kind: owner === 'native' ? 'native' : 'mod', id: owner, owner });
  /**
   * The chain of a call (public-hooks.md §3.7 "Order"): its interceptors and its rewriting policies, in the user's order of their mods
   * (E6), then priority, then the order they came. Interceptors are registered on a type and see its subtypes: the policy decides again for
   * the instance's own type (an interceptor of a concept does not reach the framework's subtypes of it, docs/design/systems.md S4).
   */
  const chainFor = (typeId, operation, caller, ref) => [
    ...[...interceptors]
      .filter((ic) => ic.operation === operation && registry.isA(typeId, ic.type) && ic.owner !== caller.owner && ic.owner !== caller.id)
      .filter((ic) => authorize(ownerCaller(ic.owner), { type: typeId, use: 'intercept', operation, ref, replaces: ic.replaces, by: caller })),
    ...rewriteStages(typeId, operation, ref),
  ].sort((a, b) => rank(a.owner) - rank(b.owner) || b.priority - a.priority || a.seq - b.seq);

  // ---------------------------------------------------------------- the invocation path
  function argIssues(m, args) {
    if (!Array.isArray(args)) return [{ path: 'args', message: 'is not a list' }];
    const issues = [];
    const min = m.minArgs ?? m.args.length;
    if (args.length < min) issues.push({ path: 'args', message: `needs at least ${min} argument(s)` });
    if (args.length > m.args.length) issues.push({ path: 'args', message: `takes at most ${m.args.length} argument(s)` });
    // an optional argument left out is undefined, or null once it crossed as JSON (a mod's change of `[turn?, options]`)
    args.forEach((a, i) => { if (i < m.args.length && !((a === undefined || a === null) && i >= min)) registry.valueIssues(m.args[i], a, `args[${i}]`, issues); });
    return issues;
  }
  /** A call as a change leaves it: its arguments, the last mod that changed them, and every change in order (§3.5: each the changer's). */
  // arguments given again as they were are no change: nobody is recorded as having changed the call
  const changedCall = (c, args, owner, automatic, policy = null, quiet = false) => (JSON.stringify(args) === JSON.stringify(c.args) ? c : Object.freeze({ ...c, args, changedBy: owner,
    changers: Object.freeze([...(c.changers ?? []), Object.freeze({ owner, automatic: typeof automatic === 'string' ? automatic : null, ...(policy ? { policy } : {}), ...(quiet ? { quiet: true } : {}) })]) }));

  /**
   * The gates on a call about to be carried out (public-hooks.md §3.7 "Order"), by the handler or by a replacing interceptor: the policies
   * that refuse or ask (on the final call and the original), then a change's limits, then the authorization (R17): the caller's, when it
   * is a mod, and each mod's that changed the call, each as that mod's own call with the automatic action it named (§3.5, §3.9).
   * `{out}` (the refusal) or `{approvedBy}`; a promise only when something has to be waited for.
   * @param {{ t: object, operation: string, handler: object | null, ref: object, instance: object, c: object, original: unknown[],
   *   caller: object, automatic: string | null, origin: string | null, signal: object }} x
   */
  function gateCall(x) {
    const held = policyGate(x.t, x.operation, store.get(x.ref) ?? x.instance, x.c.args, x.original, x.caller, x.signal, x.preapproved);
    const next = () => (x.asking ? askUser(x) : authorizeCall(x));
    if (held && typeof held.then === 'function') return held.then((out) => (out ? { out } : next()));
    if (held) return { out: held };
    return next();
  }
  /** A call under a grant decided `ask` (F8): after the policies let it through and before the approval and dispatch, the user answers once for the call. */
  function askUser(x) {
    x.held.out ??= Promise.resolve(o.permissions.hold(x.caller, x.asking, { type: x.t.id, operation: x.operation, ref: x.ref })).catch((e) => refused('notAllowed', String(e?.message ?? e)));
    return x.held.out.then((out) => {
      if (out) return { out };
      if (x.signal?.aborted) return { out: refused('unavailable', 'cancelled') };
      return authorizeCall(x);
    });
  }
  function authorizeCall(x) {
    const changers = x.c.changers ?? [];
    // a change that widens what the call does is refused, whoever asks for it (§3.5): the provider says what widens its operation
    if (changers.length && typeof x.handler?.widens === 'function') {
      let why;
      try { why = x.handler.widens(Object.freeze({ instance: store.get(x.ref) ?? x.instance, original: x.original, args: x.c.args })); }
      catch (e) { why = `the change could not be checked (${e?.message ?? e})`; }
      if (why) return { out: refused('notAllowed', `changed by ${[...new Set(changers.map((ch) => ch.owner.replace(/^mod:/, '')))].join(', ')}: ${why}`) };
    }
    if (!x.handler?.approval) return { approvedBy: null };
    // whom the call is asked about: the calling mod, then each mod that changed it (once each, with the first action it named)
    const asks = new Map();
    if (x.caller.kind === 'mod') asks.set(x.caller.id, [x.caller, x.automatic]);
    for (const ch of changers) {
      if (ownerCaller(ch.owner).kind !== 'mod' || ch.quiet) continue;   // a quiet change: its own part, which its grants cover (G3.5)
      const mc = modCaller(ch.owner);
      const had = asks.get(mc.id);
      if (!had) asks.set(mc.id, [mc, ch.automatic]); else if (had[1] === null && ch.automatic) had[1] = ch.automatic;
    }
    if (!asks.size) return { approvedBy: null };
    return (async () => {
      const inst = () => store.get(x.ref) ?? x.instance;
      const by = new Map();   // mod id -> how its part was consented: 'user' or `automatic:<id>`
      // first without spending an automatic action (another participant may still be asked meanwhile); the calling mod's part already
      // approved with others (invokeAll: one prompt for all of them) when it asks exactly what was approved then
      for (const [id, [asMod, auto]] of asks) {
        if (x.preapproved?.action != null && id === x.caller.id && preHolds(x.preapproved, inst(), x.c.args) && samePrompt(x.handler, inst(), x.c.args, asMod, x.origin, x.preapproved)) { by.set(id, 'user'); continue; }
        const consent = await consentOf(x.handler, x.t, x.operation, inst(), x.c.args, asMod, auto, x.origin, x.signal, true);
        if (consent?.status) return { out: consent };
        if (consent?.approvedBy) by.set(id, consent.approvedBy);
      }
      // then, just before dispatch (§3.9): each automatic part again (its switch, bounds, rate and the mod's grant), spent now; one that no
      // longer holds is asked as an ordinary call
      for (const [id, [asMod, auto]] of asks) {
        if (!String(by.get(id) ?? '').startsWith('automatic:')) continue;
        // a call the user let through under a grant decided `ask` is this call's (F8); an automatic action alone never stands in for that answer
        if (!authorize(asMod, { type: x.t.id, use: 'act', operation: x.operation, ref: x.ref }) && !(x.asking && asMod.id === x.caller.id)) return { out: refused('notAllowed', `${asMod.id} may no longer make this call`) };
        if (automaticAllows(asMod, auto, x.t, x.operation, inst(), x.c.args, false, x.handler) === true) continue;
        const consent = await consentOf(x.handler, x.t, x.operation, inst(), x.c.args, asMod, null, x.origin, x.signal);
        if (consent?.status) return { out: consent };
        by.set(id, consent?.approvedBy ?? null);
      }
      if (x.signal?.aborted) return { out: refused('unavailable', 'cancelled') };
      const first = asks.keys().next().value;
      return { approvedBy: by.get(first) ?? [...by.values()].find(Boolean) ?? null };
    })();
  }

  /**
   * The chain (T6 middleware), then `terminal`. A rewriting policy's stage changes the call as its mod's change; an interceptor's own time
   * is bounded by its deadline (the clock stops while its `next` runs). A replacing interceptor runs only once `gate` let the call it is
   * given through. A cancelled `signal` ends a waiting interceptor and makes `next` answer refused('unavailable', 'cancelled'); once the
   * call went on past one (its `next` called) or a replacing one was let through (its effect claimed), it is too late: the call's own
   * outcome is waited for, never answered cancelled while it may still take effect (built review H7pa round 2).
   */
  /** The provider's referee of a change of the call's arguments (G3.5), as its changer's own (an interceptor's or a policy's): a refusal's
   *  words, `{quiet: true}`, or null when it has none or lets it through. */
  function refereeOf(call, t, c, after, owner) {
    const p = providers.get(call.ref.provider);
    const referee = p ? findHandler(p, t.id, call.operation)?.change : null;
    if (typeof referee !== 'function') return null;
    const who = owner.replace(/^mod:/, '');
    try { return referee(Object.freeze({ instance: store.get(call.ref) ?? c.instance, before: c.args, after, by: Object.freeze({ kind: owner === 'native' ? 'native' : 'mod', id: who }) })); }
    catch (e) { return `the change could not be checked (${e?.message ?? e})`; }
  }
  function runChain({ chain, call, m, t, caller, terminal, claim, gate, signal, asking = null }) {
    const cancelled = () => refused('unavailable', 'cancelled');
    const run = async (c, i) => {
      if (signal.aborted) return cancelled();
      if (i === chain.length) return terminal(c);
      const ic = chain[i];
      if (ic.rewrite) {
        const r = rewriteBy(ic.rewrite, t, call.operation, c, m);
        if (!r) return run(c, i + 1);
        if (r.refused) return r.refused;
        const p = ic.rewrite.p;
        // the provider referees a policy's change as it does an interceptor's: its mod's own part of what the call carries, no more
        // (review 2026-11-05 #3)
        const why = refereeOf(call, t, c, r.args, ic.owner);
        if (typeof why === 'string' && why) return refused('notAllowed', `changed by ${ic.owner.replace(/^mod:/, '')}'s policy “${p.title}”: ${why}`);
        return run(changedCall(c, r.args, ic.owner, p.automatic, Object.freeze({ id: p.id, title: p.title }), why?.quiet === true), i + 1);
      }
      let calledNext = false, expired = false;
      let clock = null, went = null;
      const next = (change) => {
        if (calledNext) return Promise.resolve(failed('next() was called twice', 'interceptorFault'));
        if (expired) return Promise.resolve(failed(`interceptor ${ic.owner} is past its deadline`, 'interceptorDeadline'));   // the call was already decided
        calledNext = true;
        went = goOn(change);
        return went;
      };
      const goOn = async (change) => {
        clock?.pause();
        try {
          if (signal.aborted) return cancelled();
          if (change?.args === undefined) return await run(c, i + 1);
          const bad = argIssues(m, change.args);
          if (bad.length) return refused('invalid', `changed by ${ic.owner}: ${bad[0].path} ${bad[0].message}`);
          // the provider referees each change as its changer's own (G3.5): a mod adds only its own part of a shared input
          const why = refereeOf(call, t, c, change.args, ic.owner);
          if (typeof why === 'string' && why) return refused('notAllowed', `changed by ${ic.owner.replace(/^mod:/, '')}: ${why}`);
          const quiet = why?.quiet === true;
          // a change is its mod's (§3.5): that mod may intercept the call and may make it itself; the caller may still make it
          const by = ownerCaller(ic.owner);
          if (!authorize(by, { type: t.id, use: 'intercept', operation: call.operation, ref: call.ref }) || !authorize(by, { type: t.id, use: 'act', operation: call.operation, ref: call.ref })
            || (!authorize(caller, { type: t.id, use: 'act', operation: call.operation, ref: call.ref }) && !asking)) return refused('notAllowed', 'the changed call is not allowed');
          return await run(changedCall(c, change.args, ic.owner, change.automatic, null, quiet), i + 1);
        } finally { clock?.resume(); }
      };
      if (ic.replaces) {
        // it may answer in the handler's place: only after the gates (§3.7), and its effect is claimed first (R8)
        let stop = gate(c);
        if (stop && typeof stop.then === 'function') stop = await stop;
        if (stop) return stop;
        claim?.(c);
      }
      let out;
      try {
        out = await new Promise((resolve, reject) => {
          clock = hostDeadline(ic.deadlineMs, () => { expired = true; reject(Object.assign(new Error(`did not decide within ${ic.deadlineMs} ms`), { code: 'interceptorDeadline' })); });
          const off = signal.onAbort(() => { if (!calledNext && !ic.replaces) resolve(cancelled()); });
          Promise.resolve().then(() => ic.fn(c, next)).then(resolve, reject).finally(() => { clock.stop(); off.dispose(); });
        });
      } catch (e) {
        // a replacement let through (its effect claimed) that was lost or ran past its deadline may have had its effect, whatever its next
        // answered first (built review H7ia round 2)
        if (ic.replaces && (e?.code === 'OutcomeUnknown' || e?.code === 'interceptorDeadline')) return Object.freeze({ status: 'uncertain', operation: `${t.id}.${call.operation}` });
        // past its `next` the call went on: what it did is the outcome, whatever the interceptor did after (built review H7pa round 2)
        if (went) return went;
        return fault(`failed: ${e?.message ?? e}`, e?.code === 'interceptorDeadline' ? 'interceptorDeadline' : 'interceptorFault');
      }
      if (signal.aborted && !calledNext && !ic.replaces) return cancelled();
      // past its next() the call went on: a stop then is not one (what happened is the outcome)
      if (calledNext) return isOutcome(out) && out.status !== 'stopped' ? out : out?.status === 'stopped' ? went : failed(`interceptor ${ic.owner} did not return next()'s outcome`, 'interceptorFault');
      if (isOutcome(out) && out.status === 'refused') return out;
      // a stop (G6.2): the operation does not happen and nothing failed; any interceptor may (not a policy, not a handler)
      if (isOutcome(out) && out.status === 'stopped') return stoppedBy(ic.owner, out.message);
      if (ic.replaces && isOutcome(out)) return out;
      return fault('answered without calling next and is not registered to replace', 'interceptorFault');
      /** Its failure as it declared it (G6.6): the call goes on past it (allow, the default), or is refused; never stopped quietly. */
      function fault(what, code) {
        log.warn('graph: an interceptor failed', { owner: ic.owner, operation: `${t.id}.${call.operation}`, what: String(what).slice(0, 300), code });
        // a replacement claimed its effect before it ran: it may have had it, so it is failed (never passed over: no double effect)
        if (ic.replaces) return failed(`interceptor ${ic.owner} ${what}`, code);
        if (ic.onFailure === 'refuse') return refused('unavailable', `interceptor ${ic.owner.replace(/^mod:/, '')} ${what}`);
        return run(c, i + 1);
      }
    };
    return run(call, 0);
  }
  /** `gate` for one call's runChain: each call object is let through once (`settle(out)` is how a refusal leaves; `onPass(approvedBy)`). */
  function gateOnce(x, settle, onPass) {
    const gated = new WeakSet();
    return (c) => {
      if (gated.has(c)) return null;
      const done = (g) => { if (g.out) return settle(g.out); onPass(g.approvedBy); gated.add(c); return null; };
      const g = gateCall({ ...x, c });
      return typeof g.then === 'function' ? g.then(done) : done(g);
    };
  }

  /**
   * Invoke an operation (the one path). `caller` is the authenticated caller ({kind: 'native' | 'framework' | 'mod' | 'user', id}); it
   * comes from the ingress, never from `origin`, which is information only. `signal` (createAbort) cancels it while interceptors decide.
   * `policy` (the runtime's own: a request policy answering) is told to the handler, which records who answered by which rule; `whileHeld`
   * (an answer given in a request's ask) tells it the answer is only for the request while it is held.
   * @returns {Promise<{status: string, value?: any, reason?: string, message?: string, error?: object, intent?: string, id: string}>}
   */
  async function invoke({ ref, operation, args = [], caller, origin = null, signal = NEVER_ABORTED, automatic = null, policy = null, whileHeld = false, preapproved = null, key = null }) {
    const id = `op-${++seq}`;
    let intent = null;
    let ran = null;   // the call the handler (or a replacing interceptor) ran: its arguments and who changed them (§3.4 `after`)
    // the caller's own key for this call (G6.3): in the journal with its effect, given to the handler (what the call makes carries it)
    const callKey = typeof key === 'string' && KEY.test(key) && caller?.kind === 'mod' ? key : null;
    if (key !== null && key !== undefined && !callKey) return Object.freeze({ ...refused('invalid', 'a key is 1-200 letters, digits and . _ : - (a mod\'s call only)'), id });
    const finish = (out) => {
      const result = Object.freeze({ ...normalize(out), id, ...(intent ? { intent } : {}) });
      // An uncertain outcome stays uncertain in the journal (reported once, never replayed), never a failure it cannot vouch for.
      if (intent && journal) {
        if (result.status === 'uncertain') journal.uncertainNow(intent);
        else journal.finish(intent, result.status, result.message ?? result.error?.message, result.status === 'done' && isRef(result.value) ? result.value : null);
      }
      emitOperation({ id, ref, operation, status: result.status, caller: caller ?? null, origin, args, effectiveArgs: ran?.args ?? args,
        ...(ran?.changedBy ? { changedBy: ran.changedBy } : {}), outcome: result });
      if (result.status === 'stopped') stopEvent(store.get(ref ?? {})?.ref ?? null, operation, result);
      return result;
    };
    if (closed) return finish(refused('unavailable', 'the graph runtime is closed'));
    if (!caller || typeof caller.id !== 'string') return finish(refused('notAllowed', 'no authenticated caller'));
    const snap = ref ? store.get(ref) : null;
    if (!snap) return finish(refused('unavailable', store.resolve(ref ?? {})?.gone ? 'the instance is gone' : 'unknown instance'));
    const t = registry.get(snap.ref.type);
    const m = t.members.operations.get(operation);
    if (!m) return finish(refused('unsupported', `${t.id} has no operation ${operation}`));
    // 1. authority; a call that only a grant decided `ask` lets through is held for the user once it is otherwise let through (F8)
    let asking = null;
    if (!authorize(caller, { type: t.id, use: 'act', operation, ref: snap.ref })) {
      asking = caller.kind === 'mod' ? o.permissions?.askFor?.(caller, { type: t.id, use: 'act', operation, ref: snap.ref }) ?? null : null;
      if (!asking) return finish(refused('notAllowed', `${caller.id} may not act on ${t.id}`));
    }
    // 2. capability
    const p = providers.get(snap.ref.provider);
    const handler = p ? findHandler(p, t.id, operation) : null;
    if (m.tier === 'optional' && !capabilities(snap.ref)?.includes(operation)) return finish(refused('unsupported', `${t.id}.${operation} is not supported by this instance`));
    if (!handler) return finish(refused('unavailable', `${t.id}.${operation} is not available yet`));
    // 3. arguments, and what the call leaves out filled in once (a handler's `resolve`: the mods' defaults, public-hooks.md §3.8): the
    // interceptors, the policies (as the arguments it came with too), the approval and the handler all have these same arguments
    const issues = argIssues(m, args);
    if (issues.length) return finish(refused('invalid', issues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join('; ')));
    let given = args;
    if (typeof handler.resolve === 'function') {
      let filled;
      try { filled = handler.resolve(Object.freeze({ ref: snap.ref, instance: snap, args, caller })); } catch (e) { return finish(failed(`its arguments could not be completed (${e?.message ?? e})`)); }
      if (Array.isArray(filled) && filled !== args) {
        const more = argIssues(m, filled);
        if (more.length) return finish(refused('invalid', `with the mods' defaults: ${more.slice(0, 3).map((i) => `${i.path} ${i.message}`).join('; ')}`));
        given = Object.freeze([...filled]);
      }
    }
    // 4. the chain (rewriting policies and interceptors), the gates, then the claim and the handler
    const effectful = handler.effect === 'external';
    let approvedBy = null;
    const claim = (c) => {
      if (!effectful || intent || !journal) return;
      intent = journal.start({ operation: `${t.id}.${operation}`, ref: snap.ref, caller: caller.id, origin, args: c.args, ...(approvedBy ? { approvedBy } : {}), ...(callKey ? { key: callKey } : {}) });
    };
    // `signal` cancels the call while its interceptors decide (a Stop during a held send); once the handler runs, the provider's own
    // operations (stop) end it.
    const sig = signal && typeof signal.onAbort === 'function' ? signal : NEVER_ABORTED;
    const gate = gateOnce({ t, operation, handler, ref: snap.ref, instance: snap, original: given, caller, automatic, origin, signal: sig, preapproved, asking, held: { out: undefined } },
      (out) => out, (by) => { approvedBy = by; });
    // the operation's implementation: the provider's handler, once the gate let the call through
    const implement = async (c) => {
      ran = c;
      let stop = gate(c);
      if (stop && typeof stop.then === 'function') stop = await stop;
      if (stop) return stop;
      if (sig.aborted) return refused('unavailable', 'cancelled');
      claim(c);
      const cur = store.get(snap.ref);
      if (!cur) return refused('unavailable', 'the instance went away');
      if (cur.ref.provider !== p.id || providers.get(p.id) !== p) return failed('the provider does not own the instance', 'notOwner');
      try {
        return normalize(await handler.handler(Object.freeze({ ref: cur.ref, instance: cur, args: c.args, caller, origin, intent,
          ...(approvedBy ? { approvedBy } : {}), ...(policy ? { policy } : {}), ...(whileHeld ? { whileHeld: true } : {}), ...(callKey ? { key: callKey } : {}) })));
      } catch (e) {
        // A handler that was dispatched and then lost (its worker died, its reply deadline passed) may have had its effect: uncertain.
        if (e?.code === 'OutcomeUnknown') return Object.freeze({ status: 'uncertain', operation: `${t.id}.${operation}` });
        return failed(e?.message ?? String(e), e?.code);
      }
    };
    // a request's own policies answer it first (public-hooks.md §3.7), then its `ask` interceptors (§3.6)
    if (operation === 'ask' && registry.isA(t.id, 'Request')) {
      const answered = await answerByPolicy(t, snap);
      if (answered) return finish(answered);
    }
    const call = Object.freeze({ id, ref: snap.ref, operation, args: given, caller, origin, instance: snap, signal: sig });
    return finish(await runChain({ ...stages({ t, m, operation, caller, ref: snap.ref, gate, implement, claim, signal: sig, asking }), call, m, t, caller, claim, gate, signal: sig, asking }));
  }
  /**
   * A call's chain (§3.7 "Order"): the interceptors that pass the call on and the rewriting policies, in the user's order, make the final
   * call; at their end the gate, then the implementation: the replacing interceptors (in order, each only past the gate on the call it is
   * given), then `implement`. A replacement never runs before a later change has been made.
   */
  function stages({ t, m, operation, caller, ref, gate, implement, claim, signal, asking = null }) {
    const chain = chainFor(t.id, operation, caller, ref);
    const replacers = chain.filter((x) => x.replaces);
    return {
      chain: chain.filter((x) => !x.replaces),
      terminal: async (c) => {
        let stop = gate(c);
        if (stop && typeof stop.then === 'function') stop = await stop;
        if (stop) return stop;
        return replacers.length ? runChain({ chain: replacers, call: c, m, t, caller, terminal: implement, claim, gate, signal, asking }) : implement(c);
      },
    };
  }

  /** What the provider would ask the user about a mod's call (R17), or null: `{action, detail}`. */
  function promptOf(handler, inst, args, asMod, origin) {
    if (!handler?.approval || !asMod) return null;
    try { const p = handler.approval(Object.freeze({ ref: inst.ref, instance: inst, args, caller: asMod, origin })); return p ? { action: String(p.action ?? ''), detail: String(p.detail ?? '') } : null; } catch { return null; }
  }
  /** Whether a call asks now exactly what the user approved for it (an interceptor's change that asks something else: asked again). */
  const samePrompt = (handler, inst, args, asMod, origin, pre) => { const p = promptOf(handler, inst, args, asMod, origin); return !!p && p.action === pre.action && p.detail === pre.detail; };
  /** Whether an approval given with others (invokeAll) holds for the call as it is now: the arguments approved, on the instance as it was. */
  const preHolds = (pre, inst, args) => !!pre && !!inst && inst.version === pre.version && JSON.stringify(args) === pre.args;

  /**
   * Several changes, one approval (public-hooks.md §3.14, `ctx.graph.invokeAll`). Every call is checked first as a call of its own would
   * be (its instance, operation, the caller's grant, the instance's support, a handler, its arguments with the mods' defaults filled in, and
   * the policies that refuse it): one that cannot be made refuses the batch before anything runs. What the calls would ask the user (each
   * provider's prompt, and each policy that asks) is asked once, every entry shown whole on a line of its own; then the calls run in
   * order, each its own call (its interceptors, policies, outcome), and stop at the first that is not done (the rest are not run: one
   * approval, not one transaction). The approval holds for a call only as it was approved: the same arguments when it reaches its gates, on
   * the instance at the version it was approved on (any change since, an earlier call's of the batch too, is asked about on its own: the
   * graph cannot tell whose a change was; built review H7ia rounds 1 and 2). `{status, ..., outcomes}`: the first that was not done's status, or done; `outcomes` one per call, always.
   */
  async function invokeAll({ calls, caller, reason = '', signal = NEVER_ABORTED }) {
    const n = Array.isArray(calls) ? calls.length : 0;
    const batch = (first, outs) => Object.freeze({ ...first, outcomes: Object.freeze(outs) });
    const none = (r) => batch(r, Array.from({ length: n }, () => r));
    if (closed) return none(refused('unavailable', 'the graph runtime is closed'));
    if (!caller || typeof caller.id !== 'string') return none(refused('notAllowed', 'no authenticated caller'));
    if (!n || n > MAX_INVOKE_ALL) return none(refused('invalid', `invokeAll takes 1 to ${MAX_INVOKE_ALL} calls`));
    if (typeof reason !== 'string' || reason.length > 500) return none(refused('invalid', 'a reason is text of at most 500 characters'));
    // a call that cannot be made refuses them all, before anything runs
    const cannot = (i, r) => batch(Object.freeze({ ...r, message: `change ${i + 1}: ${r.message ?? r.reason}` }),
      calls.map((_, j) => (j === i ? r : refused('unavailable', `not run: change ${i + 1} cannot be made`))));
    const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    const approved = new Map();   // call index -> what was approved for it
    const lines = [];
    for (const [i, c] of calls.entries()) {
      if (!c || typeof c !== 'object' || !isRef(c.ref) || typeof c.operation !== 'string' || (c.args !== undefined && !Array.isArray(c.args))) return cannot(i, refused('invalid', 'a call is {ref, operation, args?}'));
      const snap = store.get(c.ref);
      if (!snap) return cannot(i, refused('unavailable', 'unknown instance'));
      const t = registry.get(snap.ref.type);
      const m = t.members.operations.get(c.operation);
      if (!m) return cannot(i, refused('unsupported', `${t.id} has no operation ${c.operation}`));
      if (!authorize(caller, { type: t.id, use: 'act', operation: c.operation, ref: snap.ref })) return cannot(i, refused('notAllowed', `${caller.id} may not act on ${t.id}`));
      const p = providers.get(snap.ref.provider);
      const handler = p ? findHandler(p, t.id, c.operation) : null;
      if (m.tier === 'optional' && !capabilities(snap.ref)?.includes(c.operation)) return cannot(i, refused('unsupported', `${t.id}.${c.operation} is not supported by this instance`));
      if (!handler) return cannot(i, refused('unavailable', `${t.id}.${c.operation} is not available yet`));
      const args = c.args ?? [];
      const issues = argIssues(m, args);
      if (issues.length) return cannot(i, refused('invalid', issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')));
      let given = args;
      if (typeof handler.resolve === 'function') {
        let filled;
        try { filled = handler.resolve(Object.freeze({ ref: snap.ref, instance: snap, args, caller })); } catch (e) { return cannot(i, failed(`its arguments could not be completed (${e?.message ?? e})`)); }
        if (Array.isArray(filled) && filled !== args) {
          const more = argIssues(m, filled);
          if (more.length) return cannot(i, refused('invalid', `with the mods' defaults: ${more.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`));
          given = filled;
        }
      }
      const hits = policyHits(t.id, c.operation, snap, given, given, caller);
      const refusal = hits.find((h) => h.then.refuse);
      if (refusal) return cannot(i, policyRefusal(refusal, refusal.then.refuse));
      const prompt = caller.kind === 'mod' ? promptOf(handler, snap, given, caller, null) : null;
      if (prompt) lines.push(`• ${oneLine(prompt.action)}${oneLine(prompt.detail) ? `: ${oneLine(prompt.detail)}` : ''}`);
      for (const h of hits) {
        const ask = h.then.ask;
        lines.push(`• confirm “${oneLine(ask.title)}”${oneLine(ask.message) ? `: ${oneLine(ask.message)}` : ''} (“${oneLine(h.entry.p.title)}”, a policy of ${h.entry.owner.replace(/^mod:/, '')})`);
      }
      if (prompt || hits.length) {
        approved.set(i, Object.freeze({ action: prompt?.action ?? null, detail: prompt?.detail ?? null, args: JSON.stringify(given), version: snap.version,
          policies: new Set(hits.map((h) => h.entry.seq)) }));
      }
    }
    if (approved.size) {
      if (!o.approvals) return none(refused('unavailable', 'this needs the user\'s approval, and the user cannot be asked here'));
      // every entry shown whole (the dialog shows at most 900 characters of detail): too many to show is refused, never cut
      const detail = [oneLine(reason), ...lines].filter(Boolean).join('\n');
      if (detail.length > APPROVAL_DETAIL_MAX) return none(refused('invalid', `what these changes ask is too long to show in one prompt (${detail.length} characters, at most ${APPROVAL_DETAIL_MAX}): make fewer at once`));
      const answer = await o.approvals.ask({ modId: caller.id, operation: 'graph.invokeAll', action: `make ${approved.size === 1 ? 'a change' : `${approved.size} changes`}`, detail, signal });
      if (!answer?.approved) return none(refused('notAllowed', `the user's approval is needed: ${answer?.reason ?? 'not approved'}`));
    }
    const outcomes = [];
    let stopped = null;
    for (const [i, c] of calls.entries()) {
      if (stopped || signal?.aborted) { outcomes.push(refused('unavailable', stopped ? `not run: change ${stopped} did not go` : 'cancelled')); continue; }
      const pre = approved.get(i);
      const out = await invoke({ ref: c.ref, operation: c.operation, args: c.args ?? [], caller, origin: null, signal, ...(pre ? { preapproved: pre } : {}) });
      outcomes.push(out);
      if (out.status !== 'done') stopped = i + 1;
    }
    const first = outcomes.find((x) => x.status !== 'done');
    return batch(first ? { ...first } : { status: 'done', value: null }, outcomes);
  }

  /**
   * R17 (runtime-core.md): a mod's call the provider says needs the user's approval is asked about, unless it is that mod's automatic
   * action within its bounds and rate (public-hooks.md §3.9). `asMod` is the mod the call is asked about as (its caller, or a mod that
   * changed it); null: nobody to ask about. Null to go on, `{approvedBy}`, or the refusal.
   */
  async function consentOf(handler, t, operation, inst, args, asMod, asAutomatic, origin, signal, dry = false) {
    if (!handler?.approval || !asMod) return null;
    let prompt;
    try { prompt = handler.approval(Object.freeze({ ref: inst.ref, instance: inst, args, caller: asMod, origin })); } catch (e) {
      return failed(`the provider could not describe the request: ${e?.message ?? e}`);
    }
    if (!prompt) return null;
    const auto = typeof asAutomatic === 'string' ? automaticAllows(asMod, asAutomatic, t, operation, inst, args, dry, handler) : null;
    if (auto === true) {
      log.info('graph automatic action', { mod: asMod.id, action: asAutomatic, operation: `${t.id}.${operation}`, ref: inst.ref });
      return { approvedBy: `automatic:${asAutomatic}` };
    }
    if (auto) log.info('graph automatic action asks', { mod: asMod.id, action: asAutomatic, operation: `${t.id}.${operation}`, why: auto });
    if (!o.approvals) return refused('unavailable', 'this needs the user\'s approval, and the user cannot be asked here');
    // The kind of action, for "don't ask again": the operation of the type that declares it (Thread.rename, not CodexThread.rename).
    const answer = await o.approvals.ask({ modId: asMod.id, operation: `${t.declaredIn.get(operation) ?? t.id}.${operation}`, action: prompt.action, detail: prompt.detail, signal });
    if (!answer.approved) return refused('notAllowed', `the user's approval is needed: ${answer.reason}`);
    return { approvedBy: 'user' };
  }

  /**
   * Whether a mod's call that names one of its automatic actions goes without asking (public-hooks.md §3.9): true, or why not (it then
   * asks as any call does). The user has the action on (as declared then); the operation is its operation (on the instance's type or one
   * it is a subtype of) and not one that always asks (the provider's `alwaysAsks`: global instructions, an app's computer-use level, an
   * "always" approval); the instance and the arguments are within its `where` and `args`, read as the mod reads; it ran fewer than
   * `perHour` times in the last hour. A call that goes without asking counts toward the rate.
   */
  function automaticAllows(caller, id, t, operation, inst, args, dry = false, handler = null) {
    let a;
    try { a = typeof o.automaticOf === 'function' ? o.automaticOf(caller.id, id) : null; } catch { a = null; }
    if (!a || typeof a.operation !== 'string') return `the automatic action "${id}" is off`;
    const [typeName, opName] = a.operation.split('.');
    if (opName !== operation || !registry.isA(t.id, typeName)) return `"${id}" is for ${a.operation}`;
    let always;
    try { always = typeof handler?.alwaysAsks === 'function' ? handler.alwaysAsks(Object.freeze({ instance: inst, args })) : null; } catch { always = 'it could not be checked'; }
    if (always) return `${t.id}.${operation} always asks${typeof always === 'string' ? ` (${always})` : ''}`;
    const { env, resolve } = readerEnv(caller.owner ?? caller.id);
    try {
      if (a.where && !store.compiled(a.where).test(inst, env)) return `the ${t.id} is outside "${id}"`;
      for (const [i, w] of Object.entries(a.args ?? {})) {
        // an argument's where reads its own fields (a ref: its instance; bare operators: its value), as the policies' do
        const bare = isBareWhere(w);
        const x = argRoot(args[Number(i)], bare, resolve);
        if (x === null || store.compiled(bare ? { value: w } : w).evaluate(x, env) !== true) return `argument ${i} is outside "${id}"`;
      }
    } catch (e) { return `"${id}" could not be checked: ${e?.message ?? e}`; }
    const key = `${caller.id}\n${id}`, at = now();
    const recent = (automaticRuns.get(key) ?? []).filter((x) => at - x < 3_600_000);
    if (recent.length >= a.perHour) { automaticRuns.set(key, recent); return `"${id}" ran ${a.perHour} times in the last hour`; }
    if (dry) return true;
    recent.push(at);
    automaticRuns.set(key, recent);
    return true;
  }

  /**
   * An operation the user started in the app, held at its choke point (interception.md I3). The same path as `invoke` up to the gates;
   * the terminal is `forward(args, call)`, the app's own request going on, and there is no durable claim: the app owns it. Decisions on one
   * object are made in arrival order, Stop in a lane of its own (I7).
   * @param {{ ref: object, operation: string, args?: unknown[], caller: object, origin?: string, signal?: object }} op
   * @param {(args: unknown[], call: object) => Promise<object>} forward  sends the app's request on (with these args) and resolves with its
   *   outcome; `call.changers` says who changed it
   * @returns {Promise<{ decision: 'forwarded' | 'refuse' | 'stopped' | 'handled' | 'failed' | 'release' | 'cancelled', outcome?: object, reason?: string }>}
   *   forwarded: the request went on (outcome: the chain's); refuse: answer the app with the refusal; stopped: an interceptor stopped it
   *   (G6.2: the place ends its action without an error and keeps its input; outcome.by the mod); handled: an interceptor answered in
   *   its place; failed: an interceptor that replaces the operation started and did not finish (failed, uncertain or past its deadline),
   *   so the app is answered with an error and its request never goes on; release: let the request go on unchanged (no interceptor,
   *   invalid mapping, a fault or a deadline before any replacement ran); cancelled: drop the hold. A release says why in `code`, the
   *   graph's own (never an error's text): closed, unknown-instance, no-operation, no-caller, invalid-arguments, no-interceptor, undecided.
   */
  async function interceptApp({ ref, operation, args = [], caller, origin = 'app', signal = NEVER_ABORTED }, forward) {
    if (closed) return { decision: 'release', code: 'closed', reason: 'the graph runtime is closed' };
    const snap = ref ? store.get(ref) : null;
    if (!snap) return { decision: 'release', code: 'unknown-instance', reason: 'unknown instance' };
    const t = registry.get(snap.ref.type);
    const m = t.members.operations.get(operation);
    if (!m) return { decision: 'release', code: 'no-operation', reason: `${t.id} has no operation ${operation}` };
    if (!caller || typeof caller.id !== 'string') return { decision: 'release', code: 'no-caller', reason: 'no caller' };
    if (!authorize(caller, { type: t.id, use: 'act', operation, ref: snap.ref })) return { decision: 'refuse', outcome: refused('notAllowed', `${caller.id} may not act on ${t.id}`) };
    const issues = argIssues(m, args);
    if (issues.length) { log.warn('an app operation did not map to valid arguments; it goes on unheld', { operation: `${t.id}.${operation}`, issue: `${issues[0].path} ${issues[0].message}` }); return { decision: 'release', code: 'invalid-arguments', reason: 'invalid arguments' }; }
    if (!chainFor(t.id, operation, caller, snap.ref).length && !policiesFor(t.id, operation, snap.ref).some(({ p }) => !p.request)) return { decision: 'release', code: 'no-interceptor', reason: 'no interceptor' };
    const lane = operation === 'stop' ? 'stop' : 'main';
    return inOrder(`${store.key(snap.ref)}\n${lane}`, async () => {
      if (signal.aborted) return { decision: 'cancelled' };
      const cur = store.get(snap.ref);
      if (!cur) return { decision: 'cancelled', reason: 'the instance went away' };
      const id = `op-${++seq}`;
      let forwarded = false;
      // A replacing interceptor acts in the app's place: its effect is claimed in the journal before it runs, as in invoke (R8), and once
      // it may have started the app's own request never goes on as well (boundary review R: no double effect).
      let replaced = false, intent = null, ranApp = null;
      const claim = (c) => {
        replaced = true;
        if (journal && !intent) intent = journal.start({ operation: `${t.id}.${operation}`, ref: cur.ref, caller: caller.id, origin, args: c.args, source: 'app-replace' });
      };
      const pr = providers.get(cur.ref.provider);
      // the user's own action passes the gates as a graph call does (§3.5, §3.7): a mod that changed it is asked about as its own call
      const gate = gateOnce({ t, operation, handler: pr ? findHandler(pr, t.id, operation) : null, ref: cur.ref, instance: cur, original: args, caller, automatic: null, origin, signal },
        (out) => normalize(out), () => {});
      // the app's own request going on, once the gate let it through (a hold given up meanwhile never goes on)
      const implement = async (c) => {
        ranApp = c;
        let stop = gate(c);
        if (stop && typeof stop.then === 'function') stop = await stop;
        if (stop) return stop;
        if (signal.aborted) return refused('unavailable', 'cancelled');
        forwarded = true;
        try { return normalize(await forward(c.args, c)); } catch (e) { return failed(e?.message ?? String(e), e?.code); }
      };
      const call = Object.freeze({ id, ref: cur.ref, operation, args, caller, origin, instance: cur, signal });
      // what an interceptor returns is normalized here as in invoke: only the graph's own policies say `by`
      let out = normalize(await runChain({ ...stages({ t, m, operation, caller, ref: cur.ref, gate, implement, claim, signal }), call, m, t, caller, claim, gate, signal }));
      // an interceptor's fault lets the request go on as if it had never been held (I6), never past a policy (§3.7): the policies decide
      // it as it came
      let undecided = null;
      if (!forwarded && !replaced && !signal.aborted && out.status !== 'done' && out.status !== 'refused' && out.status !== 'stopped') {
        undecided = out.error?.message ?? 'an interceptor did not decide';
        let held = policyGate(t, operation, store.get(cur.ref) ?? cur, args, args, caller, signal);
        if (held && typeof held.then === 'function') held = await held;
        if (held) out = normalize(held);
      }
      if (intent) {
        if (out.status === 'uncertain' || (out.status === 'refused' && signal.aborted)) journal.uncertainNow(intent);
        else journal.finish(intent, out.status === 'done' || out.status === 'refused' || out.status === 'stopped' ? out.status : 'failed', out.message ?? out.error?.message);
      }
      const decided = forwarded ? { decision: 'forwarded', outcome: out }
        : out.status === 'stopped' && !signal.aborted ? { decision: 'stopped', outcome: out }
        : replaced && out.status !== 'done' && out.status !== 'refused' ? { decision: 'failed', outcome: out, reason: out.error?.message ?? 'the replacement did not finish' }
          : signal.aborted ? { decision: 'cancelled' }
            : out.status === 'refused' ? { decision: 'refuse', outcome: out }
              : out.status === 'done' ? { decision: 'handled', outcome: out }
                : { decision: 'release', code: 'undecided', reason: undecided ?? out.error?.message ?? 'an interceptor did not decide' };
      // one record per action: one let go undecided is recorded by the place that holds it, once it knows what the action did
      if (decided.decision !== 'release') {
        emitOperation({ id, ref: cur.ref, operation, status: out.status, caller, origin, args, effectiveArgs: ranApp?.args ?? args,
          ...(ranApp?.changedBy ? { changedBy: ranApp.changedBy } : {}), outcome: out });
        if (decided.decision === 'stopped') stopEvent(cur.ref, operation, out);
      }
      return decided;
    });
  }
  /** Run `fn` after every earlier one with the same key has finished (one queue per object and lane). */
  function inOrder(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }
  /**
   * An operation's record, as every listener gets it. A question's answer to a prompt it marks secret never leaves the call (graph-integrity
   * G1.5, for every provider): the words are left out of the record, whoever provides the question.
   */
  /**
   * A stop's event on its subject (G6.2): `operationStopped` {operation, by, message?}, the framework's on every instance (a type's own
   * `stopped`, a turn's that was interrupted, is another thing). The activity record has the operation's own record with it.
   */
  function stopEvent(ref, operation, out) {
    if (!ref) return;
    try { store.event(ref.provider, ref, 'operationStopped', { operation, by: out.by, ...(out.message ? { message: out.message } : {}) }); }
    catch (e) { log.warn('graph: a stop\'s event not emitted', { message: String(e?.message ?? e) }); }
  }
  function emitOperation(e) {
    const snap = e.operation === 'answer' && e.ref ? store.get(e.ref) : null;
    if (snap && registry.has(snap.ref.type) && registry.isA(snap.ref.type, 'Question')) {
      const secret = new Set((Array.isArray(snap.state?.prompts) ? snap.state.prompts : []).filter((x) => x?.secret === true).map((x) => x.id));
      const clean = (args) => (Array.isArray(args) && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
        ? [Object.fromEntries(Object.entries(args[0]).map(([id, a]) => [id, secret.has(id) && a && typeof a === 'object' && a.text !== undefined ? { ...a, text: '[secret]' } : a])), ...args.slice(1)]
        : args);
      if (secret.size) e = { ...e, args: clean(e.args), effectiveArgs: clean(e.effectiveArgs) };
    }
    const event = Object.freeze({ ...e, t: now() });
    for (const fn of [...opListeners]) { try { fn(event); } catch { /* a listener's fault is its own */ } }
  }

  // ---------------------------------------------------------------- what holds or observes the app's own actions (§3.4, §3.5)
  const observers = new Map();   // `${typeId}\n${operation}` -> how many mods' `after` observe it
  /** A mod's `after` on an operation: while it lasts, the app's own calls of it that nothing holds are reported once they went. */
  function observe(typeId, operation) {
    const k = `${typeId}\n${operation}`;
    observers.set(k, (observers.get(k) ?? 0) + 1);
    holdsChanged();
    let gone = false;
    return { dispose() {
      if (gone) return;
      gone = true;
      const n = (observers.get(k) ?? 1) - 1;
      if (n > 0) observers.set(k, n); else observers.delete(k);
      holdsChanged();
    } };
  }
  /** Whether a mod's `after` observes this operation on an instance of this type (its type or one it is a subtype of). */
  const observed = (typeId, operation) => registry.has(typeId) && [...observers.keys()].some((k) => {
    const [type, op] = k.split('\n');
    return op === operation && registry.has(type) && registry.isA(typeId, type);
  });
  /**
   * Which of these operations of the app's own (`[concept, operation]`) something holds now (an interceptor or a policy would see it on
   * one of the concept's types) and which a mod's `after` only observes: `{held, observed}`, each as `Type.operation` for the concept and
   * every type of it, so a place that holds asks by its instance's own type. Neither: the app's own action runs as before.
   */
  function appHolds(pairs) {
    const held = new Set(), observed = new Set();
    const ids = registry.ids();
    for (const [concept, operation] of pairs) {
      if (!registry.has(concept)) continue;
      const kin = ids.filter((id) => registry.isA(id, concept));
      const keys = [concept, ...kin.filter((id) => id !== concept)].map((id) => `${id}.${operation}`);
      if (kin.some((id) => intercepted(id, operation))) { for (const k of keys) held.add(k); continue; }
      const seen = [...observers.keys()].some((k) => { const [type, op] = k.split('\n'); return op === operation && registry.has(type) && (registry.isA(type, concept) || registry.isA(concept, type)); });
      if (seen) for (const k of keys) observed.add(k);
    }
    return { held: [...held], observed: [...observed] };
  }
  /**
   * An action of the app's own that nothing held went (or one let through unheld): what it did, as an operation the mods' `after` sees
   * (§3.4: observed passively). Information only: nothing runs.
   */
  function recordApp({ ref, operation, args = [], caller, origin = 'app', outcome, instance = null }) {
    // `instance`: the subject as it was when the app asked (a rewind's Turn is gone once it is done: built review H6m1)
    const snap = (ref ? store.get(ref) : null) ?? (instance && instance.ref && ref && instance.ref.provider === ref.provider && instance.ref.id === ref.id ? instance : null);
    if (!snap || !caller || typeof caller.id !== 'string') return false;
    const t = registry.get(snap.ref.type);
    if (!t?.members.operations.has(operation)) return false;
    const out = normalize(outcome && typeof outcome === 'object' ? outcome : { status: 'uncertain' });
    emitOperation({ id: `op-${++seq}`, ref: snap.ref, operation, status: out.status, caller, origin, args: Array.isArray(args) ? args : [],
      effectiveArgs: Array.isArray(args) ? args : [], outcome: out });
    return true;
  }
  function findHandler(p, typeId, operation) {
    const t = registry.get(typeId);
    for (const tid of [...t.chain].reverse()) { const h = p.types.get(tid)?.operations.get(operation); if (h) return h; }
    return null;
  }
  /** docs/graph/04 §4 `can`: would the operation be attempted (it exists, is supported and has a handler)? Authority is not checked. */
  /**
   * What a call would meet, without running interceptors or effects (public-hooks.md §3.7): `{status: 'allowed' | 'refused' |
   * 'unsupported' | 'asks' | 'needsConsent' | 'unknown', reason?, by?}`: the caller's authority, the instance's capability, the
   * arguments, the policies (a refusal, or one that asks), R17 (a mod's call the user is asked about, unless it is an automatic action that
   * would go). The answer can change; every call is checked again when invoked.
   */
  function assess({ ref, operation, args = [], caller, automatic = null }) {
    const snap = ref ? store.get(ref) : null;
    if (!snap) return Object.freeze({ status: 'unknown', reason: 'the instance is not known here' });
    const t = registry.get(snap.ref.type);
    const m = t.members.operations.get(operation);
    if (!m) return Object.freeze({ status: 'unsupported', reason: `${t.id} has no operation ${operation}` });
    if (!caller || typeof caller.id !== 'string' || !authorize(caller, { type: t.id, use: 'act', operation, ref: snap.ref })) return Object.freeze({ status: 'refused', reason: 'not allowed' });
    const p = providers.get(snap.ref.provider);
    const handler = p ? findHandler(p, t.id, operation) : null;
    if (m.tier === 'optional' && !capabilities(snap.ref)?.includes(operation)) return Object.freeze({ status: 'unsupported', reason: `${t.id}.${operation} is not supported by this instance` });
    if (!handler) return Object.freeze({ status: 'unsupported', reason: `${t.id}.${operation} is not available yet` });
    const issues = argIssues(m, Array.isArray(args) ? args : []);
    if (issues.length) return Object.freeze({ status: 'refused', reason: `${issues[0].path} ${issues[0].message}` });
    // the arguments as the call would have them (the mods' defaults filled in)
    if (typeof handler.resolve === 'function') {
      try { const filled = handler.resolve(Object.freeze({ ref: snap.ref, instance: snap, args, caller })); if (Array.isArray(filled)) args = filled; } catch { return Object.freeze({ status: 'unknown', reason: 'its arguments could not be completed' }); }
    }
    // a refusal first, as the gate decides; then one that asks
    const hits = policyHits(t.id, operation, snap, args, null, caller);
    const hit = hits.find((h) => h.then.refuse) ?? hits[0];
    if (hit) {
      const by = Object.freeze({ mod: hit.entry.owner.replace(/^mod:/, ''), policy: hit.entry.p.id });
      return Object.freeze(hit.then.refuse ? { status: 'refused', reason: hit.then.refuse, by } : { status: 'asks', reason: hit.then.ask.title, by });
    }
    if (handler.approval && caller.kind === 'mod') {
      let prompt;
      try { prompt = handler.approval(Object.freeze({ ref: snap.ref, instance: snap, args, caller, origin: null })); } catch { prompt = null; }
      if (prompt && !(typeof automatic === 'string' && automaticAllows(caller, automatic, t, operation, snap, args, true, handler) === true)) return Object.freeze({ status: 'needsConsent', reason: String(prompt.action ?? '') });
    }
    // allowed, and said when no native check has shown it yet (G9.3)
    return Object.freeze(unverifiedOf(snap.ref)?.includes(operation) ? { status: 'allowed', unverified: true } : { status: 'allowed' });
  }

  function can(ref, operation) {
    const s = store.get(ref);
    if (!s) return false;
    const m = registry.get(s.ref.type).members.operations.get(operation);
    if (!m) return false;
    if (m.tier === 'optional' && !capabilities(s.ref)?.includes(operation)) return false;
    const p = providers.get(s.ref.provider);
    return !!(p && findHandler(p, s.ref.type, operation));
  }

  // ---------------------------------------------------------------- lifecycle
  /** Owners that lost types they built on, until they register again or go: owner -> {types, because, at}. */
  const degradedOwners = new Map();
  const dropProvider = (p) => { p.disposed = true; providers.delete(p.id); store.undeclareProvider(p.id); };
  /**
   * Everything an owner registered goes with it (contract rule Lifecycle), and so does what other owners built on its types (boundary
   * review 6b): their subtypes of them, their interceptors on them, and their providers' instances of them (a provider left with no type is
   * disposed). Those owners are degraded ("its base type is gone") until they register types again. Returns the removed type ids.
   */
  function disposeOwner(owner) {
    degradedOwners.delete(owner);
    // its temporary changes end: the user's values come back (public-hooks.md §3.14)
    overrides.disposeOwner(owner);
    const going = new Set(registry.ownedSubtrees(owner));
    let hadInterceptors = false;
    for (const ic of [...interceptors]) if (ic.owner === owner) { interceptors.delete(ic); hadInterceptors = true; }
    if (hadInterceptors) holdsChanged();
    // its defaults go, and those who apply them are told (a setting's default the app keeps would outlive the mod)
    let defaultsGone = false;
    for (const [k, x] of [...defaultsBy]) if (x.owner === owner) { defaultsBy.delete(k); defaultsGone = true; }
    if (defaultsGone) defaultsChanged();
    let hadPolicies = false;
    for (const [k, x] of [...policies]) if (x.owner === owner) { policies.delete(k); hadPolicies = true; }
    if (hadPolicies) policiesChanged(owner);
    for (const p of [...providers.values()]) if (p.owner === owner) dropProvider(p);
    const lost = new Map();   // another owner -> the type ids it loses
    const note = (o, id) => { let s = lost.get(o); if (!s) lost.set(o, (s = new Set())); s.add(id); };
    for (const id of going) { const o2 = registry.get(id)?.owner; if (o2 && o2 !== owner) note(o2, id); }
    for (const ic of [...interceptors]) if (going.has(ic.type)) { interceptors.delete(ic); note(ic.owner, ic.type); }
    for (const p of [...providers.values()]) {
      const gone = [...p.types.keys()].filter((id) => going.has(id));
      if (!gone.length) continue;
      for (const id of gone) { p.types.delete(id); note(p.owner, id); }
      if (!p.types.size) { dropProvider(p); continue; }
      store.narrowProvider(p.id, [...new Set([...p.types.keys()].map((tid) => registry.get(tid).concept))], (tid) => !going.has(tid));
    }
    const removed = registry.unregisterOwner(owner);
    for (const [o2, ids] of lost) {
      degradedOwners.set(o2, { types: [...ids].sort(), because: owner, at: now() });
      log.warn('an owner lost types it built on', { owner: o2, because: owner, types: [...ids].sort() });
    }
    return removed;
  }

  // Temporary changes of Settings (public-hooks.md §3.14, H7y): kept aside on this Mac, put back when they end
  const overrides = createOverrides({ resolve: (ref) => store.resolve(ref), conceptOf, invoke: (call) => invoke(call), onEvent: (fn) => store.onEvent(fn),
    ask: o.approvals ? (q) => o.approvals.ask(q) : undefined, file: o.overridesFile, log, now, retryMs: o.overridesRetryMs });

  return {
    /** An owner's override of Settings (`{id, set: [{ref, value}], until?}`): asked unless `approved` (the user's own act). */
    override: (owner, spec, opts) => overrides.override(owner, spec, opts),
    unoverride: (owner, id) => overrides.restore(owner, id),
    overridesOf: (owner) => overrides.list(owner),
    overrideHolderOf: (ref) => overrides.holderOf(ref),
    onOverrideEnd: (fn) => overrides.onEnd(fn),
    registerTypes, registerProvider, intercept, intercepted, invoke, invokeAll, interceptApp, bindAppOrigin, interceptable, can, assess, capabilities, unverifiedOf, disposeOwner,
    policy, policiesOf, onPolicies: (fn) => { policyListeners.add(fn); return { dispose() { policyListeners.delete(fn); } }; },
    /** A mod's call by its own key (G6.3): its outcome as the journal has it (`{status, made?, at}`), or null. */
    made(owner, key) { return journal && typeof journal.byKey === 'function' ? journal.byKey(String(owner).replace(/^mod:/, ''), String(key)) : null; },
    defaults, defaultsFor, presentationDefaults, undefaults(owner, id) { const gone = defaultsBy.delete(`${owner}\n${id}`); if (gone) defaultsChanged(); return gone; },
    onDefaults(fn) { defaultsListeners.add(fn); return { dispose() { defaultsListeners.delete(fn); } }; },
    onHolds(fn) { holdListeners.add(fn); return { dispose() { holdListeners.delete(fn); } }; },
    /** A mod's policy by its id goes (its handle's dispose, from the mod's realm). */
    unpolicy(owner, id) { const key = `${owner}\n${id}`; if (policies.delete(key)) { policiesChanged(owner); return true; } return false; },
    /** The user turned one of a mod's policies on or off (its page): what holds the app's own actions may have changed with it. */
    policiesSwitched: (owner) => policiesChanged(owner),
    types: () => registry.reflect(),
    /** The owners that lost types they built on when another owner went ({owner, types, because, at}), until they register again or go. */
    degraded: () => [...degradedOwners].map(([o2, d]) => ({ owner: o2, ...d })),
    type: (id) => registry.get(id) ?? null,
    resolve: (ref) => store.resolve(ref),
    /** Instances of a type a `where` keeps (public-hooks.md §3.1); `attached(inst, modId)` is the reader's view of attached data. */
    list: (typeId, where, attached, readable) => store.list(typeId, where, attached, readable),
    /** A page of a type's instances (public-hooks.md §3.2, query.mjs): `{items, next?}`, as a reader may read them. */
    query: (q, attached, readable) => queries.query(q, attached, readable),
    /** What matches a text among the searchable types (query.mjs): `[{ref, title, field, snippet?}]`, as a reader may read them. */
    search: (text, opts, reader) => queries.search(text, opts, reader),
    /** What a where reads besides the instance, as a reader may (its relations and attached data). */
    whereEnv: (attached, readable) => store.whereEnv(attached, readable),
    attachments,
    related: (ref, name) => store.related(ref, name),
    /** G3.4: before a read of an inverse relation, or of a type pinned to an instance, its contributors put theirs (a promise). */
    materialize, materializeWhere,
    /** Every instance linking to `ref` through its one/maybe relation `relation`. */
    referrers: (ref, relation) => store.referrers(ref, relation),
    isComplete: (typeId) => store.isComplete(typeId),
    /**
     * A realm view (R6). Its `loaded` settles once the provider's `onObserve` has loaded what was not resident (at once without one).
     * `query.depth` (presentations.md V6): 'full' (the default) asks the provider to load what the observed instance needs, such as a
     * thread's turns; 'core' is for a realm that wants the instance itself only: a resident instance asks nothing (`loaded` settles at
     * once), and one that is not resident yet asks its provider for it with the query's `depth: 'core'`, so the provider loads what the
     * instance itself needs and nothing heavy (a message the page shows is loaded with its thread's history; a thread's turns are not
     * loaded for its row; docs/design/systems.md E2).
     */
    subscribe(query, sink, so) {
      const depth = query?.depth;
      if (depth !== undefined && depth !== 'core' && depth !== 'full') throw new CodexModsError('Invalid', `a view's depth is 'core' or 'full', not ${String(depth)}`);
      const resident = () => { const x = query?.ref ? store.resolve(query.ref) : null; return !!x && !x.gone; };
      const p = query?.ref && (depth !== 'core' || !resident()) ? providers.get(query.ref.provider) : null;
      let loading;
      if (p?.onObserve) {
        try { loading = p.onObserve(query); } catch (e) { log.warn('provider onObserve failed', { provider: p.id, message: String(e?.message ?? e) }); }
      }
      // what other providers contribute to the relation it follows, or to the instance its where pins (G3.4)
      const contributed = query?.ref && typeof query.relation === 'string' ? materialize(query.ref, query.relation)
        : typeof query?.type === 'string' ? materializeWhere(query.type, query.where) : null;
      const loaded = Promise.all([Promise.resolve(loading).then(() => {}, (e) => { log.warn('provider onObserve failed', { provider: p?.id, message: String(e?.message ?? e) }); }), contributed]).then(() => {});
      return Object.assign(views.subscribe(query, sink, so), { loaded });
    },
    onEvent: (fn) => store.onEvent(fn),
    onOperation(fn) { opListeners.add(fn); return { dispose() { opListeners.delete(fn); } }; },
    observe, observed, appHolds, recordApp,
    /** Intents a crash left uncertain, not yet acknowledged (docs/graph/04 §10). */
    uncertain: () => journal?.uncertain() ?? [],
    /** The user has seen an uncertain intent: it is never reported again, and it is never replayed. */
    acknowledge: (intentId) => journal?.markSurfaced(intentId) ?? false,
    journal,
    log,
    close() { if (closed) return; closed = true; overrides.dispose(); attachments.flush(); journal?.close(); },
  };
}
