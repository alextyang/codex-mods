// ctx.graph → the graph runtime (runtime-core.md; docs/graph/04). It needs the v1 permission `graph` until SDK v2's
// permissions (T8) replace it. A mod is one provider, whose id is the mod's id (refs it writes carry it); its operation handlers,
// `onObserve` and interceptors run in the mod's worker, reached through a handler registration. What a mod registers (types, its
// provider, its interceptors) goes with the mod (graph.disposeOwner at teardown).
//
// Realms (docs/design/presentations.md V6): the host realm has every member. The renderer realm has the reads (`resolve`, `list`,
// `related`, `types`, `can`, `subscribe`) and `invoke`, which is made as the mod; registering types, providing, writing and
// intercepting stay in the host realm, and a renderer that asks for them is Denied. The process realm has none. The page's own
// runtime (not a mod) reaches the same reads and `invoke` through the framework scope that the runtime maps the reserved id
// FRAMEWORK_MOD_ID to on the renderer channel (runtime/index.mjs scopeFor): `scope.state.framework`, caller {kind: 'framework'}.
//
// Interception (docs/design/interception.md I10): `intercept` is a handler registration. The graph's middleware (call, next) keeps
// the pending `next` under a fresh call token for as long as the mod's function runs, and invokes the mod with
// ['intercept', token, plainCall]; the mod's `next` crosses back as `calls.next(token, change)`. The token ends when the middleware
// returns or its deadline passes, so a late `next` fails Invalid. A mod that does not answer within its deadline (or goes away) makes
// the middleware throw, which the graph turns into an interceptor fault.
import { randomUUID } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { requireGrant } from './grants.mjs';
import { createPolicy } from '../graph/policy.mjs';
import { hostDeadline } from '../deadline.mjs';
import { compileWhere } from '../../shared/where.mjs';

const OP_DEADLINE_MS = 30000;
const OBSERVE_DEADLINE_MS = 10000;
const INTERCEPT_DEADLINE_MS = 60000;
const INTERCEPT_MAX_DEADLINE_MS = 600000;
/** The most the Host waits for the mod's reply on the wire: the interceptor's own deadline (below) is what bounds it, and it stops while next runs. */
const INTERCEPT_BACKSTOP_MS = 24 * 3600 * 1000;
/** Telling a worker that a call it intercepts was cancelled: a short wait, since nothing waits on the answer. */
const CANCEL_DEADLINE_MS = 5000;
const AFTER_QUEUE_MAX = 256;       // records waiting for one `after` listener; past it a {gap: n} says how many were dropped
const AFTER_DEADLINE_MS = 30000;   // how long the mod's function may take on one record
/** Who an operation came from (public-hooks.md §3.4): the user (`through` the mod whose surface they acted in: graph-integrity G7.3), a mod
 *  (by id), the app's own (the native provider's, the framework's). */
const originOf = (caller) => (caller?.kind === 'user' ? { kind: 'user', ...(typeof caller.through === 'string' ? { through: caller.through } : {}) } : caller?.kind === 'mod' ? { kind: 'mod', id: String(caller.id).replace(/^mod:/, '') }
  : caller?.kind === 'agent' ? { kind: 'agent' } : caller ? { kind: 'app' } : { kind: 'unknown' });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * An interceptor's answer to a request it was asked about (`Request.ask`, public-hooks.md §3.6): `{approve: 'once' | 'thread', automatic?}`
 * or `{deny: true}` names the approval's own option of that kind, `{option: id, automatic?}` one of its options by id, and `{answers:
 * {<prompt id>: {choices?, text?}}, automatic?}` a question's answers (graph-integrity G1.5, G1.6): each is the mod's own answer, with the
 * same grants, prompts and automatic actions as any call of it; anything else (an outcome, `next()`'s) is the interceptor's result. An
 * "always" option is never taken this way: it makes a standing rule, which stays the user's.
 */
async function askAnswer(who, origin, g, call, out) {
  if (!isObject(out) || typeof out.status === 'string') return out;
  const automatic = typeof out.automatic === 'string' ? out.automatic : null;
  // an answer given in the ask is for the request while it is held: once shown, it is the user's (§3.6)
  const as = (args) => g.invoke({ ref: call.ref, operation: 'answer', args, caller: who, origin, automatic, whileHeld: true });
  const invalid = (message) => Object.freeze({ status: 'refused', reason: 'invalid', message });
  const options = Array.isArray(call.instance?.state?.options) ? call.instance.state.options : [];
  if (out.approve !== undefined || out.deny !== undefined || out.option !== undefined) {
    if (out.approve !== undefined && out.approve !== 'once' && out.approve !== 'thread') return invalid('an answer approves once or for the chat ("always" stays the user\'s)');
    const option = out.option !== undefined ? options.find((x) => x?.id === out.option)
      : out.approve !== undefined ? options.find((x) => x?.kind === 'approve' && (x.scope ?? 'once') === out.approve) : options.find((x) => x?.kind === 'deny');
    if (!option) return invalid('the request offers no such option');
    if (option.scope === 'always') return invalid('"always" stays the user\'s');
    return as([option.id]);
  }
  if (isObject(out.answers)) return as([out.answers]);
  return out;
}

/** What the renderer realm may use (presentations.md V6): the reads, a view, and `invoke`. Everything else is the host realm's. */
const RENDERER_MEMBERS = new Set(['resolve', 'list', 'query', 'search', 'related', 'types', 'can', 'assess', 'subscribe', 'invoke', 'attached']);
/** The authenticated caller of the page runtime's own invocations (the framework scope; never from `origin`). */
const FRAMEWORK_CALLER = Object.freeze({ kind: 'framework', id: 'framework' });
/** A ref in a read is an object (the graph answers null for one it does not know; a malformed one is the caller's mistake, not an internal error). */
const refArg = (ref) => {
  if (!isObject(ref)) throw new CodexModsError('Invalid', 'a ref is {type, provider, id}');
  return ref;
};

/** @param {{ graph: () => object | null }} o */
export function createGraphNs({ graph: graphOf, interceptions = null, attestations = null }) {
  /** The runtime, for `member` of ctx.graph called from this scope: the realm may use the member, and the scope holds the grant. */
  const graph = (scope, member) => {
    // the page's and a mod's process's (graph-integrity G8.2): the reads, a view and `invoke`, as the mod under its grants
    if (scope.realm === 'renderer' || scope.realm === 'process') {
      if (!RENDERER_MEMBERS.has(member)) {
        throw new CodexModsError('Denied', `ctx.graph.${member} is available in the host realm only (the ${scope.realm} realm has resolve, list, query, search, related, types, can, assess, subscribe and invoke)`);
      }
    } else if (scope.realm !== 'host') throw new CodexModsError('Denied', 'ctx.graph is available in the host realm');
    requireGrant(scope.state.grants, 'graph');
    const g = graphOf();
    if (!g) throw new CodexModsError('Unavailable', 'the graph runtime is not running (the Host\'s graph is off: flags/graph-off)');
    return g;
  };
  const caller = (scope) => (scope.state.framework === true ? FRAMEWORK_CALLER : Object.freeze({ kind: 'mod', id: scope.state.id, owner: scope.state.owner }));
  // Authority (breadth.md D0.2): a mod reads, acts on and intercepts what its own instances and its `graph.*` grants cover. The runtime's
  // `authorize` applies the same rule to acting; reads and interceptors are checked here, at the ingress.
  const policyOf = (scope, g) => createPolicy({ grantsOf: () => scope.state.grants, typeOf: (typeId) => g.type(typeId), canonicalOf: (ref) => g.resolve(ref)?.ref?.type ?? null });
  const readable = (scope, g) => { const pol = policyOf(scope, g); const who = caller(scope); return (snap) => pol.canRead(who, snap); };
  const provider = (scope) => {
    const p = scope.state.graphProvider;
    if (!p) throw new CodexModsError('Unavailable', 'this mod is not a provider: call ctx.graph.provide first');
    return p;
  };
  // Attached data (public-hooks.md §3.3) leaves the Host as each reader may see it: a mod gets `attached: {[modId]: {[name]: value}}` (its
  // own and the shared ones), the page's runtime (the framework) every value and `attachedPrivate` (`<modId>/<name>` of the private ones),
  // to apply per rule owner.
  const readerOf = (scope) => (scope.state.framework === true ? null : scope.state.id);
  const withAttached = (scope, g, snap) => {
    if (!snap || snap.gone || !snap.ref) return snap;
    // the page's own surfaces offer what an instance supports (graph-integrity G2.1: `can`, never its provider): its optional members,
    // and not what its provider declares unverified (G9.3)
    const page = readerOf(scope) === null;
    const supports = page && typeof g.capabilities === 'function' ? g.capabilities(snap.ref) : null;
    const unverified = page && typeof g.unverifiedOf === 'function' ? g.unverifiedOf(snap.ref) : null;
    const s = Array.isArray(supports) || Array.isArray(unverified) ? { ...snap, ...(Array.isArray(supports) ? { supports } : {}), ...(Array.isArray(unverified) ? { unverified } : {}) } : snap;
    const view = g.attachments?.viewFor(readerOf(scope), snap.ref);
    if (!view) return s;
    return readerOf(scope) === null ? { ...s, attached: view.attached, attachedPrivate: view.private } : { ...s, attached: view };
  };
  /** The reader's view of attached data, for a `where` that reads it: (instance, modId) -> that mod's value as the reader sees it. */
  const attachedFn = (scope, g) => (inst, mod) => {
    const view = g.attachments?.viewFor(readerOf(scope), inst.ref);
    const all = readerOf(scope) === null ? view?.attached : view;
    return all ? all[mod] : undefined;
  };
  /** A relation's value as this reader may read it (its instances with their attached data); none from an instance it may not read. */
  const relatedNow = (scope, g, ref, name) => {
    const ok = readable(scope, g);
    const from = g.resolve(refArg(ref));
    if (from && !ok(from)) return Array.isArray(g.related(refArg(ref), name)) ? [] : null;
    const r = g.related(refArg(ref), name);
    return Array.isArray(r) ? r.filter(ok).map((s) => withAttached(scope, g, s)) : (r && ok(r) ? withAttached(scope, g, r) : null);
  };
  /** May this reader see an attached change (a `changed` event on `attached` only)? Its own, a shared one, or one that was shared. */
  const seesAttachedChange = (scope, e) => !e?.attached || readerOf(scope) === null || e.attached.by === readerOf(scope) || e.attached.shared || e.attached.wasShared;

  /** A mod writes its own instances: the provider in a ref is always the mod. */
  const own = (scope, ref) => {
    if (!isObject(ref) || typeof ref.type !== 'string' || typeof ref.id !== 'string') throw new CodexModsError('Invalid', 'a ref is {type, id}');
    if (ref.provider !== undefined && ref.provider !== scope.state.id) throw new CodexModsError('Denied', 'a mod writes only its own instances');
    return { type: ref.type, provider: scope.state.id, id: ref.id };
  };
  /** What the mod's interceptor is given: the call without the runtime's own members (the worker makes its own signal, told by `cancel`). */
  const plainCall = (c) => ({ id: c.id, ref: c.ref, operation: c.operation, args: c.args, caller: c.caller, origin: c.origin, instance: c.instance });
  /** call token -> {state, next}: the calls whose interceptor is running in a mod's worker. */
  const pendingNext = new Map();
  const plainEvent = (e) => (e === null || e === undefined ? null : { kind: e.kind, seq: e.seq, ref: e.ref, ...(e.fields ? { fields: e.fields } : {}), ...(e.kind === 'event' ? { name: e.name } : {}) });

  return {
    calls: {
      registerTypes(scope, descriptors) {
        const g = graph(scope, 'registerTypes');
        if (!Array.isArray(descriptors)) throw new CodexModsError('Invalid', 'registerTypes takes a list of descriptors');
        return g.registerTypes(descriptors, scope.state.owner);
      },
      put(scope, ref, data) { graph(scope, 'put'); return plainEvent(provider(scope).put(own(scope, ref), isObject(data) ? data : {})); },
      update(scope, ref, data) { graph(scope, 'update'); return plainEvent(provider(scope).update(own(scope, ref), isObject(data) ? data : {})); },
      remove(scope, ref) { graph(scope, 'remove'); return plainEvent(provider(scope).remove(own(scope, ref))); },
      /** A named event of one of the mod's own instances (its type declares the event and its payload). */
      emit(scope, ref, name, payload) {
        graph(scope, 'emit');
        if (typeof name !== 'string' || !name) throw new CodexModsError('Invalid', 'emit needs an event name');
        return plainEvent(provider(scope).emit(own(scope, ref), name, payload ?? null));
      },
      setComplete(scope, typeId, complete) { graph(scope, 'setComplete'); provider(scope).setComplete(typeId, complete !== false); },
      /** ids: the instance ids to mark (all of the mod's instances when omitted). */
      markStale(scope, ids) { graph(scope, 'markStale'); const set = Array.isArray(ids) ? new Set(ids) : null; return provider(scope).markStale((s) => !set || set.has(s.ref.id)).length; },
      markLive(scope, ids) { graph(scope, 'markLive'); const set = Array.isArray(ids) ? new Set(ids) : null; return provider(scope).markLive((s) => !set || set.has(s.ref.id)).length; },
      // `opts.automatic`: the call is that automatic action of the mod's (public-hooks.md §3.9): no prompt while the user has it on
      invoke(scope, ref, operation, args, opts) {
        const g = graph(scope, 'invoke');
        const snap = isObject(ref) ? g.resolve(ref) : null;
        // a call carrying the user's intent is the mod relaying it (G7.3): its own grant for the act decides, another mod's setting too (D1)
        const relaying = isObject(opts) && opts.asUser !== undefined && opts.asUser !== null;
        if (snap && !snap.gone && !(relaying ? policyOf(scope, g).allowsAsUser(caller(scope), snap.ref.type, snap.ref, operation) : policyOf(scope, g).allows(caller(scope), 'act', snap.ref.type, snap.ref, operation))) {
          // The framework's own instances (docs/design/systems.md S4) are the user's: no grant lets a mod act on them alone; another mod's
          // setting (the framework's provider's) changes only on the user's own input in a control the framework draws (D1)
          const frameworkType = g.type(snap.ref.type)?.chain?.some((id) => g.type(id)?.owner === 'framework');
          const why = frameworkType || (relaying && snap.ref.provider === 'codexmods.framework') ? 'the framework\'s instances are the user\'s'
            : snap.ref.provider === 'codexmods.framework' ? 'on its own: another mod\'s setting is the user\'s, changed only by the user\'s own input in a control the framework draws'
              : 'without a graph.act grant';
          return Object.freeze({ status: 'refused', reason: 'notAllowed', message: `${scope.state.id} may not act on ${snap.ref.type} ${why}` });
        }
        const automatic = isObject(opts) && typeof opts.automatic === 'string' ? opts.automatic : null;
        // the mod's own key for the call (graph-integrity G6.3): what it looks the call up by later (`made`)
        const key = isObject(opts) && opts.key !== undefined ? opts.key : null;
        // the user's intent, attested by this page for this mod (G7.2): taken once, then the call is the user's through the mod (the mod
        // still needs the grant for the act, checked above; a mod act's approval, the automatic switch and its cap are not asked). A
        // host-realm call never carries one.
        if (isObject(opts) && opts.asUser !== undefined && opts.asUser !== null) {
          if (scope.realm !== 'renderer') return Object.freeze({ status: 'refused', reason: 'notAllowed', message: 'only a call from the page carries the user\'s intent' });
          if (key !== null) return Object.freeze({ status: 'refused', reason: 'invalid', message: 'a call as the user takes no key (the key is a mod\'s own call\'s)' });
          const why = attestations ? attestations.take(scope.channel ?? null, opts.asUser, scope.state.id) : 'this Host takes none';
          if (why) return Object.freeze({ status: 'refused', reason: 'notAllowed', message: `not the user's intent: ${why}` });
          return g.invoke({ ref, operation, args: Array.isArray(args) ? args : [], caller: Object.freeze({ kind: 'user', id: 'user', through: scope.state.id }), origin: scope.state.id });
        }
        return g.invoke({ ref, operation, args: Array.isArray(args) ? args : [], caller: caller(scope), origin: scope.state.id, automatic, key });
      },
      /** This mod's call by its own key (G6.3): `{status, made?, at}` of the newest with it, or null. */
      made(scope, key) {
        const g = graph(scope, 'made');
        if (typeof key !== 'string' || !key) throw new CodexModsError('Invalid', 'made takes the key a call was made with');
        return typeof g.made === 'function' ? g.made(scope.state.owner, key) : null;
      },
      /**
       * Several changes, one approval (public-hooks.md §3.14): `[{ref, operation, args?}]` (at most 20), each one this mod may make; what they
       * ask the user is asked once, then they run in order and stop at the first not done. `{status, ..., outcomes}`.
       */
      invokeAll(scope, calls, opts) {
        const g = graph(scope, 'invokeAll');
        const list = Array.isArray(calls) ? calls : [];
        for (const [i, x] of list.entries()) {
          const snap = isObject(x) && isObject(x.ref) ? g.resolve(refArg(x.ref)) : null;
          if (snap && !snap.gone && !policyOf(scope, g).allows(caller(scope), 'act', snap.ref.type, snap.ref, x.operation)) {
            const no = Object.freeze({ status: 'refused', reason: 'notAllowed', message: `${scope.state.id} may not make change ${i + 1} (${snap.ref.type}.${x.operation}) without a graph.act grant` });
            return Object.freeze({ ...no, outcomes: Object.freeze(list.map((_, j) => (j === i ? no : Object.freeze({ status: 'refused', reason: 'unavailable', message: `not run: change ${i + 1} cannot be made` })))) });
          }
        }
        return g.invokeAll({ calls: list.map((x) => (isObject(x) ? { ref: refArg(x.ref), operation: x.operation, args: Array.isArray(x.args) ? x.args : [] } : x)), caller: caller(scope),
          reason: isObject(opts) && typeof opts.reason === 'string' ? opts.reason : '' });
      },
      /** `can` for a mod: the operation would be attempted and the mod may act on the instance. */
      /**
       * What a call of this mod's would meet (public-hooks.md §3.7): allowed, refused (by whom), asks, needsConsent, unsupported, unknown.
       * Nothing runs. `opts.automatic` names the automatic action the call would be.
       */
      assess(scope, ref, operation, args, opts) {
        const g = graph(scope, 'assess');
        const snap = isObject(ref) ? g.resolve(refArg(ref)) : null;
        if (snap && !snap.gone && !readable(scope, g)(snap)) return Object.freeze({ status: 'unknown', reason: 'the instance is not known here' });
        return g.assess({ ref: refArg(ref), operation, args: Array.isArray(args) ? args : [], caller: caller(scope), automatic: isObject(opts) && typeof opts.automatic === 'string' ? opts.automatic : null });
      },
      /** A policy of this mod's (public-hooks.md §3.7): run by the Host on every call of the operation, the mod's own included. */
      policy(scope, spec) { graph(scope, 'policy').policy(scope.state.owner, spec); return true; },
      unpolicy(scope, id) { return graph(scope, 'unpolicy').unpolicy(scope.state.owner, String(id)); },
      /** This mod's policies, each with whether the user has it on. */
      policies(scope) { return graph(scope, 'policies').policiesOf(scope.state.owner); },
      /** What a new thing starts with until the user chooses (public-hooks.md §3.8): a new chat's target and text. */
      defaults(scope, spec) { graph(scope, 'defaults').defaults(scope.state.owner, spec); return true; },
      /**
       * A temporary change of Settings (public-hooks.md §3.14): `{id, set: [{ref, value}], until?}`, each a Setting this mod may set; the
       * user is asked once for all of it. The user's values come back on unoverride, at `until`, when the mod stops, or after a crash.
       */
      async override(scope, spec) {
        const g = graph(scope, 'override');
        const items = isObject(spec) && Array.isArray(spec.set) ? spec.set : [];
        for (const x of items) {
          const snap = isObject(x) && isObject(x.ref) ? g.resolve(refArg(x.ref)) : null;
          if (snap && !snap.gone && !policyOf(scope, g).allows(caller(scope), 'act', snap.ref.type, snap.ref, 'set')) {
            return Object.freeze({ status: 'refused', reason: 'notAllowed', message: `${scope.state.id} may not set ${snap.ref.id} without a graph.act grant for Setting.set` });
          }
        }
        return g.override(scope.state.owner, spec, { modId: scope.state.id });
      },
      unoverride(scope, id) { return graph(scope, 'unoverride').unoverride(scope.state.owner, String(id)); },
      overrides(scope) { return graph(scope, 'overrides').overridesOf(scope.state.owner); },
      undefaults(scope, id) { return graph(scope, 'undefaults').undefaults(scope.state.owner, String(id)); },
      can(scope, ref, operation) {
        const g = graph(scope, 'can');
        if (!g.can(refArg(ref), operation)) return false;
        const snap = g.resolve(refArg(ref));
        return !!snap && policyOf(scope, g).allows(caller(scope), 'act', snap.ref.type, snap.ref, operation);
      },
      resolve(scope, ref) { const g = graph(scope, 'resolve'); const s = g.resolve(refArg(ref)); return s && readable(scope, g)(s) ? withAttached(scope, g, s) : null; },
      /** Instances of a type a `where` keeps (public-hooks.md §3.1), as this mod may read them. */
      list(scope, typeId, where) {
        const g = graph(scope, 'list');
        if (where !== undefined && where !== null && !isObject(where)) throw new CodexModsError('Invalid', 'list takes a type id and a where');
        const read = () => { const ok = readable(scope, g); return (g.list(typeId, where ?? undefined, attachedFn(scope, g), ok) ?? []).filter(ok).map((s) => withAttached(scope, g, s)); };
        const wait = g.materializeWhere?.(typeId, where);   // what others contribute to the instance its where pins (graph-integrity G3.4)
        return wait ? wait.then(read) : read();
      },
      /** A page of a type's instances this mod may read (public-hooks.md §3.2): `{items, next?}`; `next` is the cursor of the next page. */
      query(scope, q) {
        const g = graph(scope, 'query');
        const read = () => {
          const ok = readable(scope, g);
          const page = g.query(isObject(q) ? q : {}, attachedFn(scope, g), ok);
          return { items: page.items.map((s) => withAttached(scope, g, s)), ...(page.next ? { next: page.next } : {}) };
        };
        const wait = isObject(q) && typeof q.type === 'string' ? g.materializeWhere?.(q.type, q.where) : null;
        return wait ? wait.then(read) : read();
      },
      /**
       * What matches a text among the searchable types, as this mod may read them (§3.2): `[{ref, title, field, snippet?}]`. A match in
       * what was said (a chat's messages) only for a mod that may read that content.
       */
      search(scope, text, opts) {
        const g = graph(scope, 'search');
        const pol = policyOf(scope, g), who = caller(scope);
        return g.search(text, isObject(opts) ? opts : {}, { readable: readable(scope, g), readsContent: (typeId) => pol.allows(who, 'read', typeId, null) });
      },
      related(scope, ref, name) {
        const g = graph(scope, 'related');
        const wait = g.materialize?.(refArg(ref), name);   // what others contribute to it is put first (graph-integrity G3.4)
        return wait ? wait.then(() => relatedNow(scope, g, ref, name)) : relatedNow(scope, g, ref, name);
      },
      /**
       * Attach this mod's value of a name to an instance (public-hooks.md §3.3, graph-integrity G3.5; null removes it): its own instances
       * and those of types it declared, or others' with `graph.attach` covering the type; never the framework's. `opts.shared`: readable
       * by every reader of the instance. A name the mod declares as a setting is set as that setting, not here.
       */
      attach(scope, ref, name, value, opts) {
        const g = graph(scope, 'attach');
        if (!isObject(ref) || typeof ref.type !== 'string' || typeof ref.provider !== 'string' || typeof ref.id !== 'string') throw new CodexModsError('Invalid', 'attach needs a ref {type, provider, id}');
        if (!g.type(ref.type)) throw new CodexModsError('Invalid', `unknown type ${ref.type}`);
        if (!policyOf(scope, g).allows(caller(scope), 'attach', ref.type, ref)) {
          return Object.freeze({ status: 'refused', reason: 'notAllowed', message: `${scope.state.id} may not attach data to ${ref.type} without a graph.attach grant for it` });
        }
        const o = isObject(opts) ? opts : {};
        const r = g.attachments.set(scope.state.id, { type: ref.type, provider: ref.provider, id: ref.id }, name, value === undefined ? null : value, { shared: o.shared === true });
        return Object.freeze({ status: 'done', value: { changed: r.changed } });
      },
      /** The attached values on an instance this mod may see (its own and the shared ones), `{}` for none. */
      attached(scope, ref) {
        const g = graph(scope, 'attached');
        refArg(ref);
        const snap = g.resolve(ref);
        if (snap && !snap.gone && !readable(scope, g)(snap)) return {};
        return g.attachments?.viewFor(scope.state.id, ref) ?? {};
      },
      types(scope) { return graph(scope, 'types').types(); },
      /**
       * `next` of an interceptor call that is running in this mod's worker: runs the rest of the chain (with `change` = {args}, or
       * null) and returns its outcome. The token belongs to the mod and ends when the interceptor returns; the graph allows one next
       * per call (a second one comes back as a failed outcome).
       */
      next(scope, token, change) {
        graph(scope, 'next');
        const entry = typeof token === 'string' ? pendingNext.get(token) : undefined;
        if (!entry || entry.state !== scope.state) throw new CodexModsError('Invalid', 'unknown or finished interceptor call');
        if (change !== null && change !== undefined && !isObject(change)) throw new CodexModsError('Invalid', 'next takes {args, automatic?} or nothing');
        // a change may name the mod's automatic action it is made as (public-hooks.md §3.9): authorized as that action at the gate
        return entry.next(change === null || change === undefined ? undefined : { args: change.args, ...(typeof change.automatic === 'string' ? { automatic: change.automatic } : {}) });
      },
    },
    subs: {
      /**
       * A realm view (R6): a snapshot, then deltas. The view hands its snapshot to the sink inside `g.subscribe`, before this returns and
       * before the channel has recorded the subscription, and the channel drops what `emit` is given until it has: so messages are held
       * (in order) until the next microtask, when the registration exists, and go out then.
       */
      subscribe(scope, [query, opts], emit) {
        const g = graph(scope, 'subscribe');
        const o = isObject(opts) ? opts : {};
        let held = [];
        const ok = readable(scope, g);
        const dress = (s) => withAttached(scope, g, s);
        // What the mod may not read never leaves the Host: snapshots and relation items are filtered, deltas about it dropped; attached
        // data goes as this reader may see it, and an attached change it may not see is dropped.
        const visible = (msg) => {
          if (msg.type === 'snapshot') return { ...msg, items: (msg.items ?? []).filter(ok).map(dress) };
          if (msg.type === 'delta') {
            const inst = msg.event?.instance ?? (msg.event?.ref ? { ref: msg.event.ref } : null);
            if (inst && !ok(inst)) return null;
            if (!seesAttachedChange(scope, msg.event)) return null;
            const { attached: _a, ...event } = msg.event ?? {};
            const out = { ...msg, event: event.instance ? { ...event, instance: dress(event.instance) } : event };
            return msg.items ? { ...out, items: msg.items.filter(ok).map(dress) } : out;
          }
          return msg;
        };
        // The channel's answer is the view's backpressure (breadth.md D0.3): false pauses the view until the realm catches up and the channel
        // calls `resume`; past its bound the view drops its queue for `stale` and a fresh snapshot.
        const view = g.subscribe(query, (raw) => { const msg = visible(raw); if (!msg) return true; if (held) { held.push(msg); return true; } return emit(msg) !== false; }, { maxQueue: o.maxQueue, attached: attachedFn(scope, g), readable: ok });
        queueMicrotask(() => { const out = held; held = null; for (const msg of out) { try { emit(msg); } catch { /* the channel's fault is its own, as for a view's sink */ } } });
        return { dispose: () => view.dispose(), resume: () => view.resume() };
      },
    },
    handlers: {
      /**
       * Become the provider of some types. spec: {types: {typeId: {operations?: {name: {effect}}, supports?}}, observe?: boolean,
       * contributes?: [{type, via}]}; the mod's handler is called with ['op', typeId, name, call] or ['observe', query], where a query
       * `{target, relation}` asks for its contributions to that instance (graph-integrity G3.4: a provider that contributes observes).
       */
      provide(scope, [spec], invoke) {
        const g = graph(scope, 'provide');
        // A provider that went with the types it built on (another mod stopped) may be provided again.
        if (scope.state.graphProvider && !scope.state.graphProvider.disposed) throw new CodexModsError('Conflict', 'this mod is already a provider');
        if (!isObject(spec) || !isObject(spec.types)) throw new CodexModsError('Invalid', 'provide needs {types}');
        const types = {};
        for (const [typeId, impl] of Object.entries(spec.types)) {
          const operations = {};
          for (const [name, d] of Object.entries(isObject(impl?.operations) ? impl.operations : {})) {
            operations[name] = {
              effect: d?.effect,
              handler: ({ ref, instance, args, caller: c, origin, intent }) =>
                invoke(['op', typeId, name, { ref, instance, args, caller: c, origin, intent }], OP_DEADLINE_MS),
            };
          }
          types[typeId] = { operations, supports: Array.isArray(impl?.supports) ? impl.supports : [] };
        }
        const contributes = Array.isArray(spec.contributes) ? spec.contributes.map((c) => ({ type: c?.type, via: c?.via })) : [];
        const handle = g.registerProvider(scope.state.owner, scope.state.id, {
          types,
          ...(spec.observe === true || contributes.length ? { onObserve: (query) => invoke(['observe', query], OBSERVE_DEADLINE_MS) } : {}),
          ...(contributes.length ? { contributes } : {}),
          // what it realizes that its own checks have not shown yet (graph-integrity G9.3): its own declaration, checked by the runtime
          ...(isObject(spec.unverified) ? { unverified: spec.unverified } : {}),
        });
        scope.state.graphProvider = handle;
        return {
          dispose() {
            if (scope.state.graphProvider === handle) scope.state.graphProvider = null;
            handle.dispose();
          },
        };
      },
      /**
       * Intercept an operation on a type and its subtypes. opts: {priority?, replaces?, deadlineMs?}. The mod's function is called with
       * ['intercept', token, plainCall] and answers with an outcome (docs/design/interception.md I10). deadlineMs (default 60 s, at most
       * 10 min) bounds the time the function takes itself, not the time it waits inside `next` (the graph's clock stops there too), so
       * the Host keeps its own clock the same way instead of giving the wire invoke that deadline: it would run on while `next` does.
       */
      /**
       * After an operation (public-hooks.md §3.4): `fn(record)` once each call of it on an instance of the type (or a subtype) this mod may
       * read has completed, whatever its outcome and whoever made it; `record = {id, ref, operation, origin, args, effectiveArgs,
       * changedBy?, outcome}`. It never holds or changes the call. In order, one at a time; past AFTER_QUEUE_MAX waiting, one `{gap: n}`.
       * What the call carried (its arguments, what it made) is in a record only for a mod that could see the call itself: one that may
       * intercept that operation on the instance, or that made the call; any other gets `args: []`, `effectiveArgs: []` and the outcome's
       * status and reason (reading a thread is not reading what is sent to it).
       */
      after(scope, [typeId, operation, opts], invoke) {
        const g = graph(scope, 'after');
        if (typeof typeId !== 'string' || typeof operation !== 'string' || !g.type(typeId)) throw new CodexModsError('Invalid', 'after needs a type of the graph and an operation name');
        const o = isObject(opts) ? opts : {};
        let where = null;
        if (o.where !== undefined) { try { where = compileWhere(o.where); } catch (e) { throw new CodexModsError('Invalid', `after: where: ${e?.message ?? e}`); } }
        const queue = [];
        let busy = false, disposed = false;
        const pump = async () => {
          if (busy) return;
          busy = true;
          try {
            while (queue.length && !disposed) {
              const rec = queue.shift();
              try { await invoke([rec], AFTER_DEADLINE_MS); } catch { /* the mod's function failed on this one: the next goes on */ }
            }
          } finally { busy = false; }
        };
        const sub = g.onOperation((e) => {
          if (disposed || e.operation !== operation || !e.ref) return;
          const snap = g.resolve(e.ref);
          if (!snap || !g.type(snap.ref.type)?.chain?.includes(typeId) || !readable(scope, g)(snap)) return;
          try { if (where && !where.test(snap, g.whereEnv(attachedFn(scope, g), readable(scope, g)))) return; } catch { return; }
          if (queue.length >= AFTER_QUEUE_MAX) {
            const last = queue[queue.length - 1];
            if (last && typeof last.gap === 'number') last.gap++; else queue.push({ gap: 1 });
            return;
          }
          const sees = (e.caller?.kind === 'mod' && (e.caller.owner === scope.state.owner || e.caller.id === scope.state.id))
            || policyOf(scope, g).allows(caller(scope), 'intercept', snap.ref.type, snap.ref, e.operation);
          const out = e.outcome ?? { status: e.status };
          queue.push({ id: e.id, ref: snap.ref, operation: e.operation, origin: originOf(e.caller), args: sees ? e.args ?? [] : [],
            effectiveArgs: sees ? e.effectiveArgs ?? e.args ?? [] : [], ...(e.changedBy ? { changedBy: String(e.changedBy).replace(/^mod:/, '') } : {}),
            outcome: sees ? out : Object.freeze({ status: out.status, ...(out.reason ? { reason: out.reason } : {}), ...(out.message ? { message: out.message } : {}) }) });
          void pump();
        });
        // the app's own calls of it are reported after they went, held or not, while this lasts
        const watch = g.observe?.(typeId, operation) ?? null;
        return { dispose() { disposed = true; queue.length = 0; sub.dispose(); watch?.dispose(); } };
      },
      intercept(scope, [typeId, operation, opts], invoke) {
        const g = graph(scope, 'intercept');
        if (typeof typeId === 'string' && g.type(typeId) && !policyOf(scope, g).allows(caller(scope), 'intercept', typeId, null, operation, isObject(opts) && opts.replaces === true)) {
          throw new CodexModsError('Denied', `intercepting ${typeId}.${operation} needs a graph.intercept grant for it`);
        }
        if (typeof typeId !== 'string' || typeof operation !== 'string') throw new CodexModsError('Invalid', 'intercept needs a type id and an operation name');
        const o = isObject(opts) ? opts : {};
        if (o.priority !== undefined && !Number.isFinite(o.priority)) throw new CodexModsError('Invalid', 'priority is a number');
        if (o.onFailure !== undefined && o.onFailure !== 'allow' && o.onFailure !== 'refuse') throw new CodexModsError('Invalid', "onFailure is 'allow' or 'refuse'");
        const deadlineMs = Math.min(Math.max(Number.isFinite(o.deadlineMs) ? Math.trunc(o.deadlineMs) : INTERCEPT_DEADLINE_MS, 1), INTERCEPT_MAX_DEADLINE_MS);
        const middleware = async (call, next) => {
          const token = `ic-${randomUUID()}`;
          let reject;
          const expired = new Promise((_, rej) => { reject = rej; });
          // The code is the one the graph reports for its own deadline; whichever clock runs out first, the outcome is the same.
          // The time the interceptor takes itself, on the Host's own time: it stops while the mod waits on `next`, as the graph's does.
          const clock = hostDeadline(deadlineMs, () => reject(Object.assign(new Error(`did not decide within ${deadlineMs} ms`), { code: 'interceptorDeadline' })));
          let inNext = 0;
          interceptions?.begin(token, scope.state);
          pendingNext.set(token, {
            state: scope.state,
            async next(change) {
              inNext++; clock.pause();
              try { return await next(change); } finally { if (--inNext === 0) clock.resume(); }
            },
          });
          // A cancelled call (the user's Stop while it is held) is told to the worker, where the interceptor's call.signal aborts (D0.4).
          const offCancel = call.signal?.onAbort?.(() => { invoke(['cancel', token], CANCEL_DEADLINE_MS).catch(() => {}); }) ?? null;
          let out;
          try { out = await Promise.race([invoke(['intercept', token, { ...plainCall(call), instance: withAttached(scope, g, call.instance) }], INTERCEPT_BACKSTOP_MS), expired]); }
          finally { offCancel?.dispose(); clock.stop(); pendingNext.delete(token); interceptions?.end(token); }
          // Request.ask (public-hooks.md §3.6): an answer in the request's place is the mod's own approve, deny or answer
          return operation === 'ask' ? askAnswer(caller(scope), scope.state.id, g, call, out) : out;
        };
        return g.intercept(scope.state.owner, typeId, operation, middleware, { priority: o.priority, replaces: o.replaces === true, deadlineMs, ...(o.onFailure ? { onFailure: o.onFailure } : {}) });
      },
    },
  };
}
