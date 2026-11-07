// Realm views (docs/design/runtime-core.md R6; integration.md §3.1 contract rule Reconciliation; docs/graph/04 §3). A view follows a
// query: one instance (`{ref}`), a type's collection with an optional `where` (`{type, where}`, docs/design/public-hooks.md §3.1), or a relation of an instance
// (`{ref, relation}`). The sink gets a snapshot with the store's sequence number, then deltas carrying the sequence number of the event
// that caused them. Each view's queue is bounded: when the sink signals backpressure (returns false) the queue holds deltas until
// `resume()`; an overflow drops them, sends `stale` and a fresh snapshot. A named event reaches the views its instance is in, and the views
// it was in until it was removed a moment ago (a provider emits `deleted` or `removed` after the removal). The transport is the caller's.
// A query with `event` (docs/design/public-hooks.md §3.2) follows only those changes: `entered` (an instance came to be in it), `left` (it
// is no longer), `changed` (one in it changed), or a named event of its type; one name or a list. Its sink gets no snapshot: only the
// deltas asked for, each saying which (`on`), and `stale` when some were dropped. Node built-ins only.
import { CodexModsError } from '../../../sdk/errors.mjs';

const DEFAULT_MAX_QUEUE = 1000;
const LEFT_MAX = 32;   // members removed a moment ago, per view, whose named events still reach it
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A query's `event`: the set of changes asked for, or null for all (with a snapshot). */
function eventsOf(event) {
  if (event === undefined || event === null) return null;
  const list = Array.isArray(event) ? event : [event];
  if (!list.length || list.length > 16 || list.some((e) => typeof e !== 'string' || !EVENT_NAME.test(e))) {
    throw new CodexModsError('Invalid', 'a view\'s event is entered, left, changed or a named event of its type (or a list of them)');
  }
  return new Set(list);
}
// a delta's kind as a membership change of the view
const MEMBERSHIP = { added: 'entered', removed: 'left', changed: 'changed' };

export function createViews({ registry, store }) {
  const views = new Set();
  store.onEvent((e) => { for (const v of [...views]) v.onEvent(e); });

  /**
   * @param {{ ref?: object, type?: string, where?: object, relation?: string }} query
   * @param {(msg: object) => boolean | void} sink
   * @param {{ maxQueue?: number, attached?: (inst: object, modId: string) => any, readable?: (snap: object) => boolean }} [o]  `attached`:
   *   the reader's view of attached data, and `readable` what it may read, for a `where` that reads through them. A collection's members are decided again when one changes, or its attached data does.
   */
  function subscribe(query, sink, o = {}) {
    if (typeof sink !== 'function') throw new CodexModsError('Invalid', 'a view needs a sink function');
    const mode = query?.relation !== undefined ? 'relation' : query?.ref ? 'instance' : query?.type ? 'collection' : null;
    if (!mode) throw new CodexModsError('Invalid', 'a view query is {ref}, {type, where?} or {ref, relation}');
    if (mode === 'collection' && !registry.has(query.type)) throw new CodexModsError('Invalid', `unknown type ${query.type}`);
    const maxQueue = o.maxQueue ?? DEFAULT_MAX_QUEUE;
    const events = eventsOf(query.event);
    const v = { queue: [], members: new Set(), left: new Set(), paused: false, disposed: false };
    const qKey = mode !== 'collection' ? store.key(query.ref) : null;
    const relation = mode === 'relation' ? relationOf(query) : null;
    const where = mode === 'collection' ? store.compiled(query.where) : null;
    const whereEnv = where ? store.whereEnv(o.attached, o.readable) : null;
    // the one and maybe relations its where reads through, hop by hop from its type (`project.repository.name`: project, then repository):
    // a change of what they name decides members again
    const through = [];
    for (const segs of where?.paths ?? []) {
      const chain = [];
      let t = query.type;
      for (const seg of segs) {
        const m = registry.get(t)?.members.relations.get(seg);
        if (!m || m.cardinality === 'many') break;
        chain.push([seg, m]);
        t = m.target;
      }
      if (chain.length && !through.some((c) => c.length >= chain.length && chain.every(([n], i) => c[i][0] === n))) through.push(chain);
    }

    function current() {
      if (mode === 'instance') { const s = store.resolve(query.ref); return s ? [s] : []; }
      if (mode === 'collection') return store.list(query.type, query.where, o.attached, o.readable);
      const r = store.related(query.ref, query.relation);
      return r === null ? [] : Array.isArray(r) ? r : [r];
    }
    function snapshot() {
      const items = current();
      v.members = new Set(items.filter((s) => !s.gone).map((s) => store.key(s.ref)));
      v.refs = new Map(items.filter((s) => !s.gone).map((s) => [store.key(s.ref), s.ref]));
      if (events) return;   // only the changes asked for
      const msg = { type: 'snapshot', seq: store.seq, items };
      if (mode === 'collection') msg.complete = store.isComplete(query.type);
      deliver(msg, true);
    }
    function deliver(msg, isSnapshot = false) {
      if (v.disposed) return;
      if (events) {
        if (msg.type === 'complete') return;
        if (msg.type === 'delta') {
          const e = msg.event;
          const on = e?.kind === 'event' ? e.name : MEMBERSHIP[e?.kind];
          if (!on || !events.has(on)) return;
          msg = { ...msg, on };
        }
      }
      if (!isSnapshot && v.queue.length >= maxQueue) {
        v.queue = [];
        v.paused = false;
        send({ type: 'stale', seq: store.seq });
        return snapshot();
      }
      v.queue.push(msg);
      flush();
    }
    function send(msg) { try { return sink(Object.freeze(msg)); } catch { return true; } }
    function flush() {
      while (!v.paused && v.queue.length) {
        const m = v.queue.shift();
        if (send(m) === false) v.paused = true;
      }
    }
    const matches = (inst) => !where || where.test(inst, whereEnv);
    v.onEvent = (e) => {
      if (e.kind === 'completeness') {
        if (mode === 'collection' && registry.get(query.type)?.concept === e.concept) deliver({ type: 'complete', seq: e.seq, complete: store.isComplete(query.type) });
        return;
      }
      const k = store.key(e.ref);
      // A named event reaches the views of its instance: the instance's own, a collection or relation it is in (or was in, until removed).
      if (e.kind === 'event') { if (k === qKey || v.members.has(k) || v.left.has(k)) deliver({ type: 'delta', seq: e.seq, event: e }); return; }
      if (e.kind === 'removed' && v.members.has(k)) {
        v.left.delete(k); v.left.add(k);
        if (v.left.size > LEFT_MAX) v.left.delete(v.left.values().next().value);
      } else if (e.kind === 'added') v.left.delete(k);
      if (mode === 'instance') { if (k === qKey) deliver({ type: 'delta', seq: e.seq, event: e }); return; }
      if (mode === 'collection') {
        if (!registry.isA(e.ref.type, query.type) && !v.members.has(k)) { if (through.length) related(e); return; }
        const was = v.members.has(k);
        const now = e.kind !== 'removed' && registry.isA(e.ref.type, query.type) && matches(e.instance);
        if (now) v.members.add(k); else v.members.delete(k);
        if (was && now) deliver({ type: 'delta', seq: e.seq, event: e });
        else if (!was && now) deliver({ type: 'delta', seq: e.seq, event: { ...e, kind: 'added' } });
        else if (was && !now) deliver({ type: 'delta', seq: e.seq, event: { ...e, kind: 'removed' } });
        return;
      }
      // relation
      if (relation.cardinality === 'many' && relation.inverseOf) {
        const was = v.members.has(k);
        const link = e.kind !== 'removed' ? e.instance?.links?.[relation.inverseOf] : null;
        const now = !!link && store.key(link) === qKey && registry.isA(e.ref.type, relation.target);
        if (now) v.members.add(k); else v.members.delete(k);
        if (was || now) deliver({ type: 'delta', seq: e.seq, event: was && now ? e : { ...e, kind: now ? 'added' : 'removed' } });
        return;
      }
      // one, maybe and stored many: re-derive on any change to the subject or to a current member
      if (k === qKey || v.members.has(k)) {
        const before = v.members;
        const items = current();
        v.members = new Set(items.filter((s) => !s.gone).map((s) => store.key(s.ref)));
        if (!events) { deliver({ type: 'delta', seq: e.seq, event: e, items }); return; }
        // the changes asked for (H5x review 1): what came to be in it and what left it, then a member's own change
        for (const s of items) if (!s.gone && !before.has(store.key(s.ref))) deliver({ type: 'delta', seq: e.seq, event: { kind: 'added', ref: s.ref, observedAt: e.observedAt, ...(e.sourceAt !== undefined ? { sourceAt: e.sourceAt } : {}), instance: s }, items });
        for (const x of before) if (!v.members.has(x)) deliver({ type: 'delta', seq: e.seq, event: { kind: 'removed', ref: v.refs.get(x) ?? null, observedAt: e.observedAt }, items });
        if (k !== qKey && before.has(k) && v.members.has(k)) deliver({ type: 'delta', seq: e.seq, event: e, items });
        v.refs = new Map(items.filter((s) => !s.gone).map((s) => [store.key(s.ref), s.ref]));
      }
    };
    /** The instances that name these (refs) by one hop of a chain: through a derived relation the instance names its holder in its own link
     *  (before and after a change, for the event's own), through a stored one whatever links to it by that relation. */
    function holders(refsHere, [name, m], e) {
      const out = [];
      for (const r of refsHere) {
        if (m.inverseOf) {
          const own = e && store.key(e.ref) === store.key(r);
          out.push(...[own ? e.instance?.links?.[m.inverseOf] : store.resolve(r)?.links?.[m.inverseOf], own ? e.old?.[m.inverseOf] : null].filter(Boolean));
        } else out.push(...(store.referrers(r, name) ?? []).map((s) => s.ref));
      }
      return out;
    }
    /** Another type's instance changed: the members and candidates whose where reads it through its relations, at any hop, are decided again. */
    function related(e) {
      const seen = new Set();
      const refs = [];
      for (const chain of through) {
        for (let d = chain.length - 1; d >= 0; d--) {
          if (!registry.isA(e.ref.type, chain[d][1].target)) continue;
          let level = [e.ref];
          for (let i = d; i >= 0 && level.length; i--) level = holders(level, chain[i], i === d ? e : null);
          refs.push(...level);
        }
      }
      for (const r of refs) {
        const ck = store.key(r);
        if (seen.has(ck)) continue;
        seen.add(ck);
        const s = store.resolve(r);
        const was = v.members.has(ck);
        const now = !!s && !s.gone && registry.isA(s.ref.type, query.type) && matches(s);
        if (was === now) continue;
        if (now) v.members.add(ck); else v.members.delete(ck);
        deliver({ type: 'delta', seq: e.seq, event: now ? { kind: 'added', ref: s.ref, observedAt: e.observedAt, ...(e.sourceAt !== undefined ? { sourceAt: e.sourceAt } : {}), instance: s } : { kind: 'removed', ref: r, observedAt: e.observedAt } });
      }
    }
    views.add(v);
    snapshot();
    return {
      /** The sink is ready again after returning false. */
      resume() { v.paused = false; flush(); },
      /** Ask for a fresh snapshot (a realm that knows it missed something). */
      resync() { v.queue = []; v.paused = false; snapshot(); },
      dispose() { v.disposed = true; views.delete(v); v.queue = []; },
      get queued() { return v.queue.length; },
    };
  }

  function relationOf(query) {
    const inst = store.get(query.ref);
    const t = registry.get(inst?.ref.type ?? query.ref.type);
    const m = t?.members.relations.get(query.relation) ?? registry.generic(query.relation);
    if (!m) throw new CodexModsError('Invalid', `${t?.id ?? query.ref.type} has no relation ${query.relation}`);
    return m;
  }

  return { subscribe, get count() { return views.size; } };
}
