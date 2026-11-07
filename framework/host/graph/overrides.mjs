// Temporary changes (public-hooks.md §3.14, `ctx.graph.override({ id, set: [{ ref, value }], until? }) -> { restore() }`; H7y): a mod sets
// some of the app's Settings for a while, the user's values kept aside on this Mac. They come back on restore(), when `until` passes, when
// the mod stops (disabled, removed, quit with the app) and, after a crash of the Host, as soon as the Settings are here again. A change
// made to one of them meanwhile by anyone else is the user's: that Setting leaves the override (nothing is written back over it). A
// Setting is held by one override at a time. A mod's override asks the user once for all its changes (R17); one the user made (a theme
// turned on in the app's settings) asks nothing. Writes and restores are Setting.set (or reset, for a Setting the user had not set) as the
// framework, so every policy and interceptor sees them.
// How it stays right (built review H7y round 1): one override's changes happen one at a time (its lock), and who holds what is decided
// again after the user's answer; the change a write of ours makes is the next change of that Setting (never a time window); an ending looks
// at each Setting first (the user's again, or another's change: nothing written); the user's values are kept on disk before anything is
// written, and an ending that cannot write now is tried again, and again whenever one of its Settings comes or changes. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SETTINGS = 32;
export const MAX_UNTIL_MS = 30 * 24 * 3600_000;
const TIMER_MAX_MS = 24 * 3600_000;   // a timer runs at most this long (Node's own limit is under 25 days): a later `until` is looked at again
const RETRY_MS = 2000;      // an ending that could not write tries again this often (the app not ready after a crash)
const RETRIES = 30;         // then only when one of its Settings comes or changes
const PENDING_MS = 60_000;  // a write of ours that may or may not have happened: how long its Setting showing the user's value is not taken as final
const FRAMEWORK = Object.freeze({ kind: 'framework', id: 'codexmods.framework' });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A value in one form whatever the order of its keys (the app may give back what it was written in another order). */
const canon = (v) => JSON.stringify(v ?? null, (k, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);
const keyOf = (ref) => `${ref.provider}\u001f${ref.id}`;
const refused = (reason, message) => Object.freeze({ status: 'refused', reason, message });

/**
 * @param {{ resolve: (ref: object) => object | null, conceptOf: (typeId: string) => string, invoke: (call: object) => Promise<object>,
 *   onEvent: (fn: (e: object) => void) => { dispose(): void }, ask?: (q: object) => Promise<{ approved: boolean, reason?: string }>,
 *   file?: string, log?: object, now?: () => number, retryMs?: number }} o  `retryMs`: how often an ending that could not write tries again.
 */
export function createOverrides(o) {
  const log = o.log ?? { info() {}, warn() {}, error() {} };
  const now = o.now ?? Date.now;
  // `${owner}\n${id}` -> {owner, id, until, keys: Map(settingKey -> {ref, was, value, also?, ending}), timer, why, queued}; `was` null: the
  // user had not set it (put back by reset); `also`: the value it held before a write that may or may not have happened (a replacement's:
  // the Setting is ours with either); `ending`: to be put back
  const records = new Map();
  const holder = new Map();    // setting key -> record key
  const writing = new Map();   // setting key -> {seen: [values]}: the changes of that Setting while a write of ours to it runs
  const gens = new Map();      // owner -> how many times it stopped (an override decided before a stop is not written after it)
  const locks = new Map();     // record key -> the end of its queue of changes
  const waiting = new Map();   // owner -> its overrides waiting for the user's answer (aborted when it stops)
  const retries = new Map();   // record key -> {timer, left}
  const ended = new Set();     // fn({owner, id, why}) when an override no longer holds anything
  let disposed = false;
  const rkOf = (owner, id) => `${owner}\n${id}`;
  const tellEnd = (rec, why) => { for (const fn of [...ended]) { try { fn(Object.freeze({ owner: rec.owner, id: rec.id, why })); } catch { /* the listener's own */ } } };
  /** One override's changes, one at a time. */
  const lock = (rk, fn) => {
    const run = (locks.get(rk) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    locks.set(rk, tail);
    void tail.then(() => { if (locks.get(rk) === tail) locks.delete(rk); });
    return run;
  };

  // ---------------------------------------------------------------- persistence (the user's values outlive a crash)
  /** The records on disk; false when they could not be (nothing is written over the user's values then). */
  function save() {
    if (!o.file) return true;
    const out = { version: 1, records: [...records.values()].map((r) => ({ owner: r.owner, id: r.id, ...(r.until ? { until: r.until } : {}),
      keys: [...r.keys.values()].map((k) => ({ ref: k.ref, was: k.was, value: k.value, ...(k.also !== undefined ? { also: k.also } : {}), ...(k.ending ? { ending: true } : {}),
        ...(k.unsaved ? { unsaved: true } : {}), ...(k.pendingUntil ? { pendingUntil: k.pendingUntil } : {}) })) })) };
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
      const tmp = `${o.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, o.file);
      return true;
    } catch (e) { log.warn('overrides: the user\'s values could not be saved', { message: String(e?.message ?? e) }); return false; }
  }
  /** What the last run left: every override of it ends (its mods' runs ended with it), put back as soon as its Settings are here. */
  function load() {
    if (!o.file || !fs.existsSync(o.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(o.file, 'utf8'));
      for (const r of Array.isArray(saved?.records) ? saved.records : []) {
        if (typeof r?.owner !== 'string' || typeof r.id !== 'string' || !Array.isArray(r.keys)) continue;
        const keys = new Map(r.keys.filter((k) => isObject(k?.ref) && typeof k.ref.id === 'string' && typeof k.ref.provider === 'string')
          .map((k) => [keyOf(k.ref), { ref: k.ref, was: k.was ?? null, value: k.value ?? null, ...(k.also !== undefined ? { also: k.also } : {}), ending: true,
            ...(k.unsaved === true ? { unsaved: true } : {}), ...(Number.isFinite(k.pendingUntil) ? { pendingUntil: k.pendingUntil } : {}) }]));
        if (!keys.size) continue;
        const rk = rkOf(r.owner, r.id);
        records.set(rk, { owner: r.owner, id: r.id, until: Number.isFinite(r.until) ? r.until : null, keys, timer: null, why: 'retry', queued: false });
        for (const k of keys.keys()) holder.set(k, rk);
      }
    } catch (e) { log.warn('overrides: the saved values could not be read', { file: o.file, message: String(e?.message ?? e) }); }
  }

  // ---------------------------------------------------------------- writes
  /** A write of ours, with the changes of its Setting seen while it ran (`{out, seen}`): which of them was its own is told by value. */
  async function writeAs(key, ref, operation, args) {
    const w = { seen: [] };
    writing.set(key, w);
    try { return { out: await o.invoke({ ref, operation, args, caller: FRAMEWORK, origin: 'framework' }), seen: w.seen }; }
    catch (e) { return { out: Object.freeze({ status: 'failed', error: { message: String(e?.message ?? e) } }), seen: w.seen }; }
    finally { if (writing.get(key) === w) writing.delete(key); }
  }
  /**
   * What a write of `value` left as ours, from the changes seen while it ran (built review H7y round 2): its own is the one with its value
   * (else the first: the app gave it back in its own form); a change after its own is someone else's, and that Setting is theirs.
   * `{value, theirs}`.
   */
  function ownChange(value, seen) {
    if (!seen.length) return { value, theirs: false };
    const i = seen.findIndex((v) => same(v, value));
    const at = i >= 0 ? i : 0;
    return { value: seen[at], theirs: seen.length > at + 1 };
  }
  /** What the user has of a Setting: the value they set where the app uses another for now (its policy), else its value. */
  const valueOf = (state) => (state?.configured !== undefined ? state.configured : state?.value ?? null);
  /** A Setting as the graph has it now (`overridden`: the user set it), or null while it is not here. */
  const current = (ref) => { const s = o.resolve(ref); return s && !s.gone && s.state ? { value: valueOf(s.state), overridden: s.state.overridden } : null; };
  /** Whether a Setting holds what an override set (either value of a write that may or may not have happened). */
  const ours = (v, k) => same(v, k.value) || (k.also !== undefined && same(v, k.also));
  /** The user's own value of a Setting: null when they set none (its default holds: put back by reset). */
  const userValueOf = (snap) => (snap.state?.overridden === false ? null : valueOf(snap.state));
  /**
   * One Setting at its override's end: 'restored' (the user's value put back), 'theirs' (the user's already, or changed by someone else
   * meanwhile: nothing written over it), or false (not now: not here, or not written; kept and tried again). A put back the app did not
   * confirm saved (`unsaved`) is written again even when the app already holds the user's value; one whose own write may still happen
   * (`pendingUntil`) is not taken as the user's while it may (built review H7y round 2).
   */
  async function putBack(key, k) {
    const c = current(k.ref);
    if (!c) return false;
    const users = k.was === null ? c.overridden === false : same(c.value, k.was);
    if (users && !k.unsaved) return (k.pendingUntil ?? 0) > now() ? false : 'theirs';
    if (!users && !ours(c.value, k)) { log.info('overrides: a setting changed meanwhile stays as it is', { setting: k.ref.id }); return 'theirs'; }
    const { out } = k.was === null ? await writeAs(key, k.ref, 'reset', []) : await writeAs(key, k.ref, 'set', [k.was]);
    if (out.status === 'done') return 'restored';
    k.unsaved = true;
    log.warn('overrides: a value could not be put back now', { setting: k.ref.id, status: out.status, message: out.message ?? out.error?.message ?? null });
    return false;
  }

  // ---------------------------------------------------------------- endings
  function stopRetry(rk) { const r = retries.get(rk); if (r) { clearTimeout(r.timer); retries.delete(rk); } }
  function finish(rk, rec, why) { clearTimeout(rec.timer); records.delete(rk); stopRetry(rk); tellEnd(rec, why); }
  /** The Settings an override is giving back, put back where they can be (in its lock). */
  async function settle(rk) {
    const rec = records.get(rk);
    if (!rec) return { restored: 0, kept: 0 };
    let restored = 0;
    for (const [key, k] of [...rec.keys]) {
      if (!k.ending) continue;
      if (holder.get(key) !== rk) { rec.keys.delete(key); continue; }
      const out = await putBack(key, k);
      if (!out) continue;
      rec.keys.delete(key);
      holder.delete(key);
      if (out === 'restored') restored++;
    }
    const kept = [...rec.keys.values()].filter((k) => k.ending).length;
    if (!rec.keys.size) finish(rk, rec, rec.why ?? 'restore');
    else if (kept) retryLater(rk);
    else stopRetry(rk);
    save();
    if (restored || kept) log.info('overrides: put back', { owner: rec.owner, id: rec.id, why: rec.why, restored, kept });
    return { restored, kept };
  }
  /** A settle soon, once (a Setting of an ending override came or changed). */
  function queueSettle(rk) {
    const rec = records.get(rk);
    if (!rec || rec.queued || disposed) return;
    rec.queued = true;
    void lock(rk, () => { const r = records.get(rk); if (r) r.queued = false; return settle(rk); });
  }
  function retryLater(rk) {
    if (disposed) return;
    const r = retries.get(rk) ?? { timer: null, left: RETRIES };
    retries.set(rk, r);
    if (r.timer) return;
    if (r.left <= 0) { log.warn('overrides: put back once its Settings come or change', { record: rk }); return; }
    r.left--;
    r.timer = setTimeout(() => { r.timer = null; queueSettle(rk); }, o.retryMs ?? RETRY_MS);
    r.timer.unref?.();
  }
  /** An override ends: every Setting it holds is put back (`why`: restore, until, stopped). */
  function end(rk, why) {
    return lock(rk, async () => {
      const rec = records.get(rk);
      if (!rec) return { restored: 0, kept: 0 };
      clearTimeout(rec.timer);
      rec.why = why;
      for (const k of rec.keys.values()) k.ending = true;
      save();
      return settle(rk);
    });
  }
  /** Its `until`, in steps no longer than a timer can wait. */
  function timeUntil(rk, rec) {
    clearTimeout(rec.timer);
    if (!rec.until) return;
    rec.timer = setTimeout(() => {
      if (records.get(rk) !== rec) return;
      if (rec.until - now() > 0) timeUntil(rk, rec); else void end(rk, 'until');
    }, Math.min(Math.max(0, rec.until - now()), TIMER_MAX_MS));
    rec.timer.unref?.();
  }

  // ---------------------------------------------------------------- the user's own changes
  /** A Setting another changed (its value is not what the override set): it leaves the override, and stays as it is. */
  function leave(rk, key) {
    const rec = records.get(rk);
    const k = rec?.keys.get(key);
    if (!k || k.ending || holder.get(key) !== rk) return;
    const c = current(k.ref);
    if (!c || ours(c.value, k)) return;
    rec.keys.delete(key);
    holder.delete(key);
    log.info('overrides: a setting changed meanwhile left the override', { owner: rec.owner, id: rec.id, setting: k.ref.id });
    if (!rec.keys.size) finish(rk, rec, 'left');
    save();
  }
  const sub = o.onEvent((e) => {
    if (disposed || !e?.ref || (e.kind !== 'changed' && e.kind !== 'added') || o.conceptOf(e.ref.type) !== 'Setting') return;
    const key = keyOf(e.ref);
    const rk = holder.get(key);
    const k = rk ? records.get(rk)?.keys.get(key) : null;
    if (!k) return;
    const w = writing.get(key);
    if (w) { if (e.kind === 'added' || e.fields?.includes('value')) w.seen.push(valueOf(e.instance?.state)); return; }   // told apart after the write
    if (k.ending) { queueSettle(rk); return; }   // one being given back came or changed: look again now
    if (e.kind !== 'changed' || !e.fields?.includes('value') || ours(valueOf(e.instance?.state), k)) return;
    if (locks.has(rk)) void lock(rk, () => leave(rk, key)); else leave(rk, key);   // after a change of the override in progress
  });

  load();
  for (const rk of records.keys()) queueSettle(rk);

  /** What a spec sets: `[{ref, value, key, snap}]`, or the refusal; `held`: what holds each Setting now. */
  function parse(owner, spec) {
    if (!isObject(spec) || typeof spec.id !== 'string' || !ID.test(spec.id)) return { refusal: refused('invalid', 'an override has an id (letters, digits, dot, dash, underscore; at most 64)') };
    if (!Array.isArray(spec.set) || !spec.set.length || spec.set.length > MAX_SETTINGS) return { refusal: refused('invalid', `an override sets 1 to ${MAX_SETTINGS} Settings: set: [{ref, value}]`) };
    if (spec.until !== undefined && (!Number.isFinite(spec.until) || spec.until <= now() || spec.until > now() + MAX_UNTIL_MS)) return { refusal: refused('invalid', 'until is a time (ms) in the next 30 days') };
    const items = [];
    for (const x of spec.set) {
      if (!isObject(x) || !isObject(x.ref) || x.value === undefined) return { refusal: refused('invalid', 'each change is {ref, value}') };
      const snap = o.resolve(x.ref);
      if (!snap || snap.gone || o.conceptOf(snap.ref.type) !== 'Setting') return { refusal: refused('invalid', 'an override sets Settings the graph has') };
      const key = keyOf(snap.ref);
      if (items.some((i) => i.key === key)) return { refusal: refused('invalid', `${snap.ref.id} is set twice`) };
      const held = holder.get(key);
      if (held && held !== rkOf(owner, spec.id)) return { refusal: refused('unavailable', `${snap.state?.title ?? snap.ref.id} is held by another override until it ends`) };
      items.push({ ref: snap.ref, value: x.value, key, snap });
    }
    return { items };
  }

  /** The user's answer, withdrawn when the owner stops or `signal` aborts: `{approved}` or `{cancelled: true}`. */
  async function asked(owner, q, signal) {
    const stop = new AbortController();
    const mine = waiting.get(owner) ?? new Set();
    waiting.set(owner, mine);
    mine.add(stop);
    const onAbort = () => stop.abort();
    if (signal?.aborted) stop.abort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const answer = await o.ask({ ...q, signal: stop.signal });
      return stop.signal.aborted ? { cancelled: true } : answer;
    } finally {
      mine.delete(stop);
      if (!mine.size && waiting.get(owner) === mine) waiting.delete(owner);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return {
    /**
     * An override of `owner`'s: asked (one prompt for all its changes) unless `approved` (the user's own act), then each Setting's user value
     * kept aside (on disk first: not kept, nothing written) and the new value written. The same id again replaces it (the values kept aside
     * stay the user's first ones; the Settings it no longer sets get theirs back). One that sets nothing ends. `{status: 'done', value: {id,
     * set: n}}`, or a refusal.
     */
    async override(owner, spec, { modId = null, approved = false, signal } = {}) {
      if (disposed) return refused('unavailable', 'the Host is stopping');
      const first = parse(owner, spec);
      if (first.refusal) return first.refusal;
      const rk = rkOf(owner, spec.id);
      const gen = gens.get(owner) ?? 0;
      if (!approved) {
        if (!o.ask) return refused('unavailable', 'this needs your confirmation, and you cannot be asked here');
        const list = first.items.map((i) => `${i.snap.state?.title ?? i.ref.id}`).join(', ');
        const answer = await asked(owner, { modId, operation: 'Setting.override', action: `change ${first.items.length === 1 ? 'a setting' : `${first.items.length} settings`} for a while: ${list}`,
          detail: `Your own values come back when it ends${spec.until ? ` (at ${new Date(spec.until).toLocaleString()})` : ''}, when the mod stops, or if you change one of them yourself.` }, signal);
        if (answer?.cancelled) return refused('unavailable', 'its mod stopped before you answered');
        if (!answer?.approved) return refused('notAllowed', `the user's approval is needed: ${answer?.reason ?? 'not approved'}`);
      }
      return lock(rk, async () => {
        if (disposed) return refused('unavailable', 'the Host is stopping');
        if ((gens.get(owner) ?? 0) !== gen) return refused('unavailable', 'its mod stopped');
        // decided again now: another override may hold a Setting since, the user may have changed one while they were asked
        const { items, refusal } = parse(owner, spec);
        if (refusal) return refusal;
        stopRetry(rk);
        const prev = records.get(rk);
        if (prev) clearTimeout(prev.timer);
        const rec = { owner, id: spec.id, until: spec.until ?? null, keys: new Map(), timer: null, why: null, queued: false };
        for (const i of items) {
          const before = prev?.keys.get(i.key);
          // a write may or may not happen: until it is known, what the previous one set is ours too
          rec.keys.set(i.key, { ref: i.ref, was: before ? before.was : userValueOf(i.snap), value: i.value, ...(before ? { also: before.value } : {}), ending: false });
        }
        // the Settings the previous one held and this one does not: theirs back
        if (prev) for (const [key, k] of prev.keys) if (!rec.keys.has(key) && holder.get(key) === rk) rec.keys.set(key, { ...k, ending: true });
        records.set(rk, rec);
        for (const key of rec.keys.keys()) holder.set(key, rk);
        if (!save()) {
          // the user's values are not kept: nothing is written
          if (prev) records.set(rk, prev); else records.delete(rk);
          for (const key of rec.keys.keys()) if (!prev?.keys.has(key)) holder.delete(key);
          if (prev) timeUntil(rk, prev);
          return refused('unavailable', 'your own values could not be kept on this Mac, so nothing was changed');
        }
        let set = 0;
        const changed = [];
        for (const i of items) {
          const { out, seen } = await writeAs(i.key, i.ref, 'set', [i.value]);
          const k = rec.keys.get(i.key);
          if (out.status === 'done') {
            set++;
            if (!k) continue;
            // as the app holds it; a change of another's after it: that Setting is theirs
            const own = ownChange(i.value, seen);
            k.value = own.value;
            delete k.also;
            if (own.theirs) changed.push(i.key);
            continue;
          }
          log.warn('overrides: a setting was not set', { owner, id: spec.id, setting: i.ref.id, status: out.status, message: out.message ?? out.error?.message ?? null });
          // it may have been written, or may still be: kept, and its Setting showing the user's value is not final for a while
          if (out.status !== 'refused') { if (k) k.pendingUntil = now() + PENDING_MS; continue; }
          // certainly not written: the previous one's value still holds where it set one (kept as it was), else nothing to give back
          const before = prev?.keys.get(i.key);
          if (before) rec.keys.set(i.key, { ...before });
          else { rec.keys.delete(i.key); if (holder.get(i.key) === rk) holder.delete(i.key); }
        }
        for (const key of changed) leave(rk, key);
        if (!set) for (const k of rec.keys.values()) k.ending = true;
        rec.why = 'restore';
        save();
        if ([...rec.keys.values()].some((k) => k.ending)) await settle(rk);
        else if (!rec.keys.size && records.get(rk) === rec) finish(rk, rec, 'restore');
        if (!set) return refused('unavailable', 'no setting could be set');
        timeUntil(rk, rec);
        return Object.freeze({ status: 'done', value: Object.freeze({ id: spec.id, set }) });
      });
    },
    /** The override ends (its mod's restore()): the user's values back. `{restored, kept}` (kept: tried again later). */
    restore(owner, id) { return end(rkOf(owner, id), 'restore'); },
    /** Every override of an owner ends (the mod stopped), and those still waiting for the user's answer are withdrawn. */
    disposeOwner(owner) {
      gens.set(owner, (gens.get(owner) ?? 0) + 1);
      for (const stop of [...(waiting.get(owner) ?? [])]) stop.abort();
      for (const [rk, rec] of [...records]) if (rec.owner === owner) void end(rk, 'stopped');
    },
    /** An owner's overrides that hold Settings: [{id, until, settings: [ref]}]. */
    list(owner) {
      return [...records.values()].filter((r) => r.owner === owner && [...r.keys.values()].some((k) => !k.ending))
        .map((r) => Object.freeze({ id: r.id, until: r.until, settings: [...r.keys.values()].filter((k) => !k.ending).map((k) => k.ref) }));
    },
    /** fn({owner, id, why}) each time an override no longer holds anything (`why`: restore, until, stopped, retry, left). */
    onEnd(fn) { ended.add(fn); return { dispose() { ended.delete(fn); } }; },
    /** Which override holds a Setting now: {owner, id}, or null. */
    holderOf(ref) { const rk = holder.get(keyOf(ref)); const r = rk ? records.get(rk) : null; return r ? { owner: r.owner, id: r.id } : null; },
    dispose() {
      disposed = true;
      sub?.dispose?.();
      for (const r of records.values()) clearTimeout(r.timer);
      for (const rk of [...retries.keys()]) stopRetry(rk);
      for (const set of waiting.values()) for (const stop of set) stop.abort();
    },
  };
}
