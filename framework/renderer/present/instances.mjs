// A window's presentations, as its page reports them (docs/design/systems.md S10, "E2c in detail"). The kernel keeps a record of every
// committed mount of a bound component (framework/preload/preload.cjs); for each one whose binding names a presentation type and whose
// subject is known, this module reports a presentation to the Host: its type, its subject, the place its binding states (`in`: the parent's
// presentation type; `via`: the subject's relation to the parent's subject; `slot`), whether a mod's rule hides it, the rules that
// decorate it, and `selected` where the binding can tell. The Host's windows provider resolves the parents and keeps the instances.
// - A generation per page load: the page asks for one first, then reports every mounted record (the snapshot), then only what changed.
//   A presentation is numbered when it is first reported; a mount whose subject or place changes is a new presentation (a new number),
//   so a ref never names another subject. Its identity is its type, subject, place and slot (03: window + parent + slot + subject): a
//   second mount with the same identity (a binding that matches two components of one page) is not another presentation; it is
//   reported if the first goes.
// - Deltas are batched: at most one report every BATCH_MS; in one, at most MAX_INSPECT records looked at, MAX_PUTS presentations and
//   MAX_BYTES of them (the rest follow). A report that fails is sent again; one the Host refuses as stale starts a new generation.
// - A user action on a presentation (a mod's badge, action or menu entry the user ran) is an event of its own, sent at once: its
//   presentation goes first, in the same flush, so the Host knows it; an action whose presentation cannot be described is dropped, and an
//   action is never sent twice.
// - The window's own facts the page can read (`windowFacts`: whether the sidebar is open) go with a report when they change.
// NO NODE API: bundled into the page.

export const BATCH_MS = 250;
export const MAX_PUTS = 200;
export const MAX_BYTES = 128 * 1024;
export const MAX_INSPECT = 400;
const MAX_REMOVES = 1000;
const MAX_EVENTS = 64;
const keyOf = (ref) => `${ref.type}\u001f${ref.provider}\u001f${ref.id}`;
const isRef = (r) => Boolean(r) && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';
const isBool = (v) => typeof v === 'boolean';
const isSize = (v) => Boolean(v) && typeof v === 'object' && (Number.isFinite(v.width) || Number.isFinite(v.height));
const sizeOnly = (v) => ({ ...(Number.isFinite(v.width) ? { width: Math.round(v.width) } : {}), ...(Number.isFinite(v.height) ? { height: Math.round(v.height) } : {}) });
/** A presentation's user-visible state its bindings may tell (graph-integrity G5.1), in the order it is reported. */
const STATE = Object.freeze([['selected', isBool], ['expanded', isBool], ['focused', isBool], ['open', isBool], ['size', isSize]]);

/**
 * @param {{ store: { mounted?: () => object[], onMount?: Function | null }, bindings: Map<string, object>, ctx: object,
 *   facts: (binding: object, ref: object) => { hidden: boolean, decorations: object[] },
 *   channel: { window(): Promise<number>, report(gen: number, batch: object): Promise<unknown>, acted(gen: number, events: object[]): Promise<unknown> },
 *   windowFacts?: () => { navigation?, sidebar?, side?, bottom?, layout? } | null (the arrangement: core.mjs shellFactsOf), onWindow?: (windowId: number) => void,
 *   schedule?: (fn: () => void, ms: number) => unknown, cancel?: (t: unknown) => void, now?: () => number, log?: (m: string, d?: object) => void }} o
 */
export function createInstances(o) {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => Date.now());
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((t) => clearTimeout(t));
  const records = new Map();   // kernel record -> { b, n: its number while reported | null, last: JSON last sent | null, key, identity }
  const dirty = new Set();     // kernel records to look at
  const removed = [];          // numbers of reported presentations that went
  const events = [];           // user actions to send: { rec, operation, action }
  let gen = null, state = 'idle', timer = null, last = 0, disposed = false, lastWindow = null, seq = 0, windowId = null;
  const counts = { reports: 0, puts: 0, removes: 0, events: 0, dropped: 0, bytes: 0, inspected: 0, maxFlushMs: 0, resnapshots: 0 };

  const tracked = (rec) => {
    const b = rec && o.bindings.get(rec.binding);
    return b && b.presentation ? b : null;
  };
  const owners = new Map();    // identity -> the kernel record whose presentation it is
  const twins = new Map();     // identity -> the other records with it
  const free = (r) => {
    if (r.identity === null) return;
    if (owners.get(r.identity) === r.rec) {
      owners.delete(r.identity);
      for (const t of twins.get(r.identity) ?? []) dirty.add(t);   // one of them is the presentation now
    }
    const set = twins.get(r.identity);
    if (set) { set.delete(r.rec); if (!set.size) twins.delete(r.identity); }   // no empty sets kept (E6 review)
  };
  const retire = (r) => { free(r); if (r.n !== null) removed.push(r.n); r.n = null; r.last = null; r.key = null; r.identity = null; };
  function onMount(kind, rec) {
    if (disposed) return;
    const b = tracked(rec);
    if (!b) return;
    if (kind === 'unmount') {
      const r = records.get(rec);
      if (!r) return;
      records.delete(rec);
      dirty.delete(rec);
      retire(r);
    } else {
      if (!records.has(rec)) records.set(rec, { rec, b, n: null, last: null, key: null, identity: null });
      dirty.add(rec);
    }
    later();
  }

  /**
   * What a record's binding can tell of its presentation's user-visible state (graph-integrity G5.1), from its committed props: each
   * member it has a function for; a chat's view is the one the user is in while its pane is (the window's own page: no pane).
   */
  function told(rec, b) {
    const out = {};
    for (const [name, ok] of STATE) {
      const v = typeof b[name] === 'function' ? b[name](rec.props, rec)
        : name === 'focused' && b.presentation === 'ThreadView' && !b.part && typeof o.activePane === 'function' ? (rec.pane ?? null) === o.activePane() : undefined;
      if (ok(v)) out[name] = name === 'size' ? sizeOnly(v) : v;
    }
    return out;
  }
  /** A presentation's identity (03: window + parent + slot + subject): its type, subject, place and slot. */
  const identityOf = (rep) => `${rep.type}\u001f${keyOf(rep.subject)}\u001f${rep.place.in}\u001f${rep.place.via ?? ''}\u001f${rep.place.on ? keyOf(rep.place.on) : ''}\u001f${rep.slot}\u001f${rep.pane ?? ''}`;
  /** What the Host is told about one record (without its number), or null while its subject is not known. */
  function reportOf(rec, r) {
    const b = r.b;
    // the Window is the windows provider's own instance (a binding of its title bar only takes its slots' rules)
    if (b.presentation === 'Window') return null;
    // `rec.near`: the nearest site, for a binding that reads one (a project's menu: its section's project, E8.7b)
    const ref = b.subject ? b.subject(rec.props, o.ctx, rec.scope, rec.near) : null;
    if (!ref || typeof ref.type !== 'string' || typeof ref.provider !== 'string' || typeof ref.id !== 'string') return null;
    const place = (typeof b.place === 'function' ? b.place(rec.props, rec.scope) : b.place) ?? {};
    const facts = o.facts(b, ref, rec.props);
    const layout = typeof b.layout === 'function' ? b.layout(rec.props) : undefined;   // a DiffView's (E7.5b)
    const rep = {
      type: b.presentation, subject: { type: ref.type, provider: ref.provider, id: ref.id },
      place: { in: place.in ?? null, ...(place.via ? { via: place.via } : {}), ...(isRef(place.on) ? { on: { type: place.on.type, provider: place.on.provider, id: place.on.id } } : {}) }, slot: place.slot ?? '',
      ...(typeof rec.pane === 'string' ? { pane: rec.pane } : {}),   // a hosted chat's: two panes of one chat are two presentations (layouts.md D8)
    };
    // its state where its binding can tell (E7, G5.1), then what its twins tell that its own does not: one presentation (the app's step row
    // inside its kind's, the side panel's frame inside its host)
    const state = told(rec, b);
    for (const t of twins.get(identityOf(rep)) ?? []) {
      const tr = t !== rec ? records.get(t) : null;
      if (tr) for (const [k, v] of Object.entries(told(t, tr.b))) if (!(k in state)) state[k] = v;
    }
    return {
      ...rep, hidden: facts.hidden === true, decorations: facts.decorations ?? [],
      ...Object.fromEntries(STATE.map(([k]) => k).filter((k) => k in state).map((k) => [k, state[k]])),
      ...(layout === 'unified' || layout === 'split' ? { layout } : {}),
      ...(b.framework ? { framework: true } : {}),   // the framework's own (E6.5): the Host lets no one act on it ("E7 in detail" decision 6)
      ...(typeof b.ask === 'function' && Number.isSafeInteger(b.ask(rec.props)) ? { ask: b.ask(rec.props) } : {}),   // a mod's question (E7.6c)
    };
  }
  /**
   * Describe one record into the batch: 'sent' (a put), 'same' (nothing changed), 'none' (no subject: removed if it was reported) or
   * 'full' (it does not fit: it stays dirty).
   */
  function describe(rec, r, batch) {
    let rep = null;
    try { rep = reportOf(rec, r); } catch (e) { log('a presentation could not be described', { binding: r.b.id, message: String(e?.message ?? e) }); }
    if (!rep) { retire(r); return 'none'; }
    const key = keyOf(rep.subject);
    const identity = identityOf(rep);
    if (r.identity !== null && identity !== r.identity) retire(r);   // another subject or place: another presentation
    const owner = owners.get(identity);
    if (owner && owner !== rec && records.has(owner)) {   // a twin of a reported presentation: not another one
      r.identity = identity;
      let set = twins.get(identity);
      if (!set) twins.set(identity, (set = new Set()));
      set.add(rec);
      // what it tells of the presentation's state goes in its owner's report (G5.1): that is looked at again
      if (STATE.some(([k]) => typeof r.b[k] === 'function')) dirty.add(owner);
      return 'same';
    }
    owners.set(identity, rec);
    const json = JSON.stringify(rep);
    if (r.n !== null && json === r.last) return 'same';
    // described again in this batch (a twin told it more): that put is this one
    const at = batch.index.get(rec);
    if (at !== undefined) { batch.puts[at] = { n: r.n, ...rep }; r.last = json; return 'sent'; }
    if (batch.puts.length >= MAX_PUTS || (batch.puts.length && batch.bytes + json.length > MAX_BYTES)) return 'full';
    if (r.n === null) r.n = ++seq;
    r.last = json;
    r.key = key;
    r.identity = identity;
    batch.index.set(rec, batch.puts.length);
    batch.puts.push({ n: r.n, ...rep });
    batch.recs.push(rec);
    batch.bytes += json.length + 12;
    return 'sent';
  }

  function later() {
    if (timer !== null || disposed || state !== 'open') { if (state === 'idle') start(); return; }
    timer = schedule(flush, Math.max(0, last + BATCH_MS - now()));
  }
  function start() {
    if (state !== 'idle' || disposed) return;
    state = 'opening';
    Promise.resolve().then(() => o.channel.window()).then((opened) => {
      if (disposed) return;
      // the generation, with the window's id (a Host before E8 gave the generation alone)
      const g = opened && typeof opened === 'object' ? opened.gen : opened;
      if (opened && typeof opened === 'object' && Number.isSafeInteger(opened.windowId)) {
        windowId = opened.windowId;
        try { o.onWindow?.(windowId); } catch (e) { log('the window\'s id could not be told', { message: String(e?.message ?? e) }); }
      }
      gen = g;
      state = 'open';
      // The snapshot: every record mounted so far (the kernel kept them from the first render on).
      for (const rec of typeof o.store.mounted === 'function' ? o.store.mounted() : []) {
        const b = tracked(rec);
        if (b && !records.has(rec)) records.set(rec, { rec, b, n: null, last: null, key: null, identity: null });
      }
      for (const rec of records.keys()) dirty.add(rec);
      flush();
    }, (e) => { state = 'off'; log('presentation instances are off', { message: String(e?.message ?? e) }); });
  }
  /** The Host no longer knows this generation: start a new one, with a snapshot. Waiting actions are not sent. */
  function resnapshot() {
    if (disposed || state !== 'open') return;
    counts.resnapshots++;
    counts.dropped += events.length;
    events.length = 0;
    removed.length = 0;
    for (const r of records.values()) { r.n = null; r.last = null; r.key = null; r.identity = null; }
    owners.clear();
    twins.clear();
    gen = null;
    state = 'idle';
    if (timer !== null) { cancel(timer); timer = null; }
    start();
  }

  /** Send what changed: the actions' presentations first, then a batch of puts and removes, then the actions. */
  function flush() {
    if (timer !== null) { cancel(timer); timer = null; }
    if (state !== 'open' || disposed) return;
    const t0 = now();
    const batch = { puts: [], recs: [], bytes: 0, index: new Map() };
    const acts = [];
    for (const e of events.splice(0, MAX_EVENTS)) {
      const r = records.get(e.rec);
      const out = r ? describe(e.rec, r, batch) : 'none';
      // A twin acts on the presentation it is a twin of.
      const on = r && r.n === null && r.identity !== null ? records.get(owners.get(r.identity)) ?? r : r;
      if (out === 'none' || out === 'full' || !on || on.n === null) { counts.dropped++; continue; }
      dirty.delete(e.rec);
      acts.push({ n: on.n, operation: e.operation, ...(e.action ? { action: e.action } : {}) });
    }
    let inspected = 0;
    for (const rec of dirty) {
      if (inspected >= MAX_INSPECT) break;
      const r = records.get(rec);
      if (!r) { dirty.delete(rec); continue; }
      inspected++;
      if (describe(rec, r, batch) === 'full') break;
      dirty.delete(rec);
    }
    const removes = removed.splice(0, MAX_REMOVES);
    let facts = null;
    try { facts = o.windowFacts?.() ?? null; } catch { /* the app's shell is not there */ }
    const factsJson = facts ? JSON.stringify(facts) : null;
    const window = factsJson && factsJson !== lastWindow ? facts : null;
    if (window) lastWindow = factsJson;
    last = now();
    if (batch.puts.length || removes.length || window) {
      counts.reports++; counts.puts += batch.puts.length; counts.removes += removes.length; counts.bytes += batch.bytes;
      const g = gen;
      // The page's own counters go along (the cost S10 asks to measure): what it looked at, its slowest flush, what it dropped.
      const page = { records: records.size, inspected: counts.inspected + inspected, maxFlushMs: counts.maxFlushMs, dropped: counts.dropped, resnapshots: counts.resnapshots };
      o.channel.report(g, { puts: batch.puts, removes, ...(window ? { window } : {}), page }).then((ok) => {
        if (ok === false && g === gen) resnapshot();
      }, (e) => {
        if (disposed || g !== gen) return;
        // Not delivered: what it carried is sent again (the actions that went with it are not).
        log('a presentation report failed; it is sent again', { message: String(e?.message ?? e) });
        for (const rec of batch.recs) { const r = records.get(rec); if (r) { r.last = null; dirty.add(rec); } }
        removed.unshift(...removes);
        if (window) lastWindow = null;
        later();
      });
    }
    if (acts.length) {
      counts.events += acts.length;
      o.channel.acted(gen, acts).catch((e) => log('a user action was not reported', { message: String(e?.message ?? e) }));
    }
    counts.inspected += inspected;
    counts.maxFlushMs = Math.max(counts.maxFlushMs, now() - t0);
    if (dirty.size || removed.length || events.length) later();
  }

  return {
    onMount,
    /** Every reported presentation of these types (or all) is looked at again: a rule came or went. */
    touch(presentation) {
      for (const [rec, r] of records) if (!presentation || r.b.presentation === presentation) dirty.add(rec);
      later();
    },
    /** The user ran something on the presentation of this kernel record (a mod's badge, action or menu entry): an event of its own, now. */
    acted(rec, operation, action) {
      if (disposed || !rec) return;
      if (!records.has(rec)) {   // mounted before the runtime followed the mounts: the kernel kept its record
        const b = tracked(rec);
        if (!b || typeof o.store.mounted !== 'function' || !o.store.mounted().includes(rec)) return;
        records.set(rec, { rec, b, n: null, last: null, key: null, identity: null });
      }
      events.push({ rec, operation, ...(action ? { action } : {}) });
      if (state === 'open') flush(); else later();
    },
    /** The ref of a reported presentation (its window, generation and number: the windows provider's), or null while it is not reported. */
    refOf(rec) {
      const r = rec ? records.get(rec) : null;
      return r && r.n !== null && gen !== null && windowId !== null ? Object.freeze({ type: r.b.presentation, provider: 'codexmods.windows', id: `${windowId}.${gen}.${r.n}` }) : null;
    },
    /** This window's ref, once the Host told its id. */
    windowRef: () => (windowId === null ? null : Object.freeze({ type: 'Window', provider: 'codexmods.windows', id: String(windowId) })),
    /** The record of a reported presentation of this type whose subject is `ref` (the first), for actions outside a wrapper. */
    find(presentation, ref) {
      if (!ref) return null;
      const k = keyOf(ref);
      for (const [rec, r] of records) if (r.b.presentation === presentation && r.n !== null && r.key === k) return rec;
      return null;
    },
    /**
     * The kernel record whose presentation has number `n` in generation `g`, for an act (E7): null in another generation, when it went,
     * or when its mount no longer presents what that number was reported as (its subject, place or slot changed and the report has not
     * caught up: it is looked at again).
     */
    byNumber(g, n) {
      if (g !== gen || gen === null || !Number.isSafeInteger(n)) return null;
      for (const [rec, r] of records) {
        if (r.n !== n) continue;
        let rep = null;
        try { rep = reportOf(rec, r); } catch { /* not describable now */ }
        if (!rep || identityOf(rep) !== r.identity) { dirty.add(rec); later(); return null; }
        return rec;
      }
      return null;
    },
    /** The other mounts of the same presentation (its twins: another component that presents it too), for an act its own binding lacks. */
    twinsOf(rec) {
      const r = records.get(rec);
      if (!r || r.identity === null) return [];
      // each twin as it is now: one whose mount shows something else (reused, its report not caught up) is not this presentation
      return [...(twins.get(r.identity) ?? [])].filter((t) => {
        if (t === rec || !records.has(t)) return false;
        let rep = null;
        try { rep = reportOf(t, records.get(t)); } catch { /* not describable now */ }
        if (rep && identityOf(rep) === r.identity) return true;
        dirty.add(t); later();
        return false;
      });
    },
    /** The window's facts may have changed: they go with the next report if they did. */
    windowChanged() { later(); },
    stats: () => ({ twins: twins.size, gen, state, records: records.size, dirty: dirty.size, ...counts }),
    dispose() { disposed = true; if (timer !== null) cancel(timer); timer = null; records.clear(); dirty.clear(); events.length = 0; owners.clear(); twins.clear(); },
  };
}
