// The page's replica of the graph (docs/design/presentations.md V6): the instances the page's bindings read, kept from realm views.
//
// NO NODE API HERE. This file runs in the page (the app's renderer main world) beside the presentation runtime, so it uses only
// ECMAScript built-ins; time comes in through `schedule`. It does not import ctx.graph either: `subscribe` is whatever the caller
// feeds it, normally `(query, onMessage) => ctx.graph.subscribe(query, onMessage)` of the framework's own context
// (realm-client `context('codexmods.framework', 'renderer', info)`), which is a view over the window's channel.
//
//   const replica = createReplica({ subscribe, conceptOf: (typeId) => conceptByType.get(typeId) });
//   const view = replica.observe(ref);            // follow the instance (core only) until disposed (plus a short linger)
//   replica.get(ref);                             // synchronous: the latest snapshot, a gone marker, or undefined (not known yet)
//   replica.settled(ref);                         // its view has answered: undefined from get is then "the graph has none"
//   const w = replica.watch(ref, (snapshot) => rerender());   // any change to what get(ref) says; for useSyncExternalStore
//
// Identity is the graph's (provider, concept, id), so a ref names the same entry whatever subtype it carries; `conceptOf(typeId)`
// gives a type's concept (the caller fills it from `ctx.graph.types()`), and a type it does not know is its own concept, as in the
// graph's store. Reads never wait: an instance a view has not delivered yet is `undefined`, and a binding renders the app's own
// until it arrives.
//
// Views. `observe(ref, {depth})` opens one view per (instance, depth), counted: the first observer subscribes, the last one's dispose
// starts a linger (default 2 s) after which the view is unsubscribed and what only it held is dropped. A re-observe inside the linger
// reuses the view, so a wrapper that unmounts and mounts again (a list re-rendering, a route change) costs no round trip and no flicker.
// The depth is 'core' unless asked otherwise: presenting a thread must not make the Host load its turns (V6).
//
// Messages follow contracts/graph.d.ts ViewMessage for an instance view: `snapshot` replaces what the view held (an instance not in it
// is no longer held, a gone one is kept as a gone marker); `delta` added/changed puts the event's instance, removed makes it a gone
// marker; `stale` says the view lost deltas (its queue overflowed), so it ignores deltas until the snapshot that the Host sends right
// behind it, which resynchronises it. An instance stays in the replica while any view holds it.

const SEP = '\u001f';
const isObject = (v) => v !== null && typeof v === 'object';
const DEFAULT_LINGER_MS = 2000;

/**
 * @param {object} o
 * @param {(query: object, onMessage: (msg: object) => void) => { dispose(): void }} o.subscribe  opens a realm view; messages arrive in order
 * @param {(typeId: string) => string | undefined} [o.conceptOf]  the concept of a type id (undefined: the type is its own concept)
 * @param {number} [o.lingerMs]  how long an unobserved view stays subscribed (default 2000; 0 unsubscribes at once)
 * @param {(fn: () => void, ms: number) => (() => void)} [o.schedule]  a timer that returns its cancel (default: globalThis.setTimeout)
 * @param {(err: unknown) => void} [o.onError]  a watcher or a subscribe that threw (default: ignored)
 */
export function createReplica({ subscribe, conceptOf = () => undefined, lingerMs = DEFAULT_LINGER_MS, schedule, onError = () => {} } = {}) {
  if (typeof subscribe !== 'function') throw new TypeError('createReplica needs subscribe(query, onMessage)');
  const later = schedule ?? ((fn, ms) => { const t = globalThis.setTimeout(fn, ms); return () => globalThis.clearTimeout(t); });
  const entries = new Map();    // identity key -> { snap, holders: Set<view> }
  const watchers = new Map();   // identity key -> Set<fn>
  const views = new Map();      // `${identity key}|${depth}` -> view
  let closed = false;

  const keyOf = (ref) => `${ref.provider}${SEP}${conceptOf(ref.type) ?? ref.type}${SEP}${ref.id}`;
  const isRef = (ref) => isObject(ref) && typeof ref.type === 'string' && typeof ref.provider === 'string' && typeof ref.id === 'string';
  const gone = (ref) => Object.freeze({ ref, liveness: 'gone', gone: true });

  function notify(key) {
    const set = watchers.get(key);
    if (!set) return;
    const value = entries.get(key)?.snap;
    for (const fn of [...set]) { try { fn(value); } catch (e) { onError(e); } }
  }
  /** `view` holds this instance, and the entry says `snap`. */
  function hold(view, key, snap) {
    let entry = entries.get(key);
    if (!entry) entries.set(key, (entry = { snap, holders: new Set() }));
    entry.snap = snap;
    entry.holders.add(view);
    view.members.add(key);
    notify(key);
  }
  /** `view` no longer holds this instance: the entry goes with its last holder. */
  function release(view, key) {
    view.members.delete(key);
    const entry = entries.get(key);
    if (!entry) return;
    entry.holders.delete(view);
    if (entry.holders.size === 0) { entries.delete(key); notify(key); }
  }

  function onMessage(view, msg) {
    if (closed || view.disposed || !isObject(msg)) return;
    switch (msg.type) {
      case 'snapshot': {
        view.stale = false;
        view.seq = Number.isFinite(msg.seq) ? msg.seq : -1;
        const keep = new Set();
        for (const item of Array.isArray(msg.items) ? msg.items : []) {
          if (!isRef(item?.ref)) continue;
          const key = keyOf(item.ref);
          keep.add(key);
          hold(view, key, item);
        }
        for (const key of [...view.members]) if (!keep.has(key)) release(view, key);
        // its first answer: the instance is known now, or known absent (settled); a watcher of it hears that even when nothing came
        if (!view.delivered) { view.delivered = true; const own = keyOf(view.query.ref); if (!keep.has(own)) notify(own); }
        return;
      }
      case 'delta': {
        // A stale view waits for its snapshot; a delta at or before the sequence already applied is a repeat.
        if (view.stale || !(msg.seq > view.seq)) return;
        const e = msg.event;
        if (!isObject(e)) return;
        view.seq = msg.seq;
        if ((e.kind === 'added' || e.kind === 'changed') && isRef(e.instance?.ref)) hold(view, keyOf(e.instance.ref), e.instance);
        else if (e.kind === 'removed' && isRef(e.ref)) hold(view, keyOf(e.ref), gone(e.ref));
        return;
      }
      case 'stale': view.stale = true; return;
      default: return;   // `complete` belongs to collection views, which the replica does not open
    }
  }

  /** Subscribe the view. A subscribe that throws leaves it dead (its observers hold nothing), and the next observe opens a new one. */
  function open(view) {
    try { view.sub = subscribe(view.query, (msg) => onMessage(view, msg)); } catch (e) { onError(e); shut(view); }
  }
  /** Unsubscribe the view and drop what only it held. */
  function shut(view) {
    view.disposed = true;
    view.cancelLinger?.(); view.cancelLinger = null;
    views.delete(view.id);
    try { view.sub?.dispose(); } catch (e) { onError(e); }
    view.sub = null;
    for (const key of [...view.members]) release(view, key);
  }

  return {
    /**
     * Follow an instance: its snapshot arrives through the view, then its changes. Dispose when the reader goes away; the view lingers
     * `lingerMs` first. `depth` is 'core' unless a reader needs the instance's heavy parts too ('full' asks the provider to load them).
     * @returns {{ dispose(): void }}
     */
    observe(ref, { depth = 'core' } = {}) {
      if (closed) return { dispose() {} };
      if (!isRef(ref)) throw new TypeError('observe takes a ref {type, provider, id}');
      if (depth !== 'core' && depth !== 'full') throw new TypeError("a view's depth is 'core' or 'full'");
      const id = `${keyOf(ref)}|${depth}`;
      let view = views.get(id);
      if (!view) {
        view = { id, query: { ref: { type: ref.type, provider: ref.provider, id: ref.id }, depth }, count: 0, sub: null, members: new Set(), stale: false, seq: -1, disposed: false, cancelLinger: null, delivered: false };
        views.set(id, view);
        open(view);
      }
      view.cancelLinger?.(); view.cancelLinger = null;
      view.count++;
      let done = false;
      return {
        dispose() {
          if (done) return;
          done = true;
          if (view.disposed || --view.count > 0) return;
          if (!(lingerMs > 0)) { shut(view); return; }
          view.cancelLinger = later(() => { view.cancelLinger = null; if (view.count === 0) shut(view); }, lingerMs);
        },
      };
    },

    /** The latest snapshot of the instance, `{ref, liveness: 'gone', gone: true}` once it was removed, or undefined when no view holds it. */
    get(ref) { return isRef(ref) ? entries.get(keyOf(ref))?.snap : undefined; },
    /** Has a view of this instance had its first answer (so `get` saying undefined means the graph has no such instance, not "not yet")? */
    settled(ref) {
      if (!isRef(ref)) return false;
      const key = keyOf(ref);
      return ['core', 'full'].some((d) => views.get(`${key}|${d}`)?.delivered === true);
    },

    /**
     * `fn(value)` runs after every change to what `get(ref)` says (a new snapshot, the instance removed, its last view closed).
     * Watching does not follow the instance: pair it with `observe`. `get(ref)` returns the object `fn` was given (or undefined with it).
     * @returns {{ dispose(): void }}
     */
    watch(ref, fn) {
      if (!isRef(ref)) throw new TypeError('watch takes a ref {type, provider, id}');
      if (typeof fn !== 'function') throw new TypeError('watch takes a function');
      const key = keyOf(ref);
      let set = watchers.get(key);
      if (!set) watchers.set(key, (set = new Set()));
      set.add(fn);
      return {
        dispose() {
          if (!set.delete(fn)) return;
          if (set.size === 0 && watchers.get(key) === set) watchers.delete(key);
        },
      };
    },

    /** The views open now and the instances held (for diagnostics and tests). */
    stats() { return { views: views.size, instances: entries.size, watchers: [...watchers.values()].reduce((n, s) => n + s.size, 0) }; },

    /** Unsubscribe every view at once and forget everything (the window is going away); watchers are told their instances are gone from the replica. */
    close() {
      if (closed) return;
      closed = true;
      for (const view of [...views.values()]) shut(view);
      watchers.clear();
    },
  };
}
