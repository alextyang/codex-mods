// The intent journal (docs/design/runtime-core.md R8, R9, R16; docs/graph/04 §10; AGENTS.md "Uncertain outcomes"). An effect outside the
// runtime is claimed as `started` before it happens: the line is fsynced first. Its outcome (done, refused, failed) is appended when
// known. An intent still open when the journal is opened again (a crash in between) becomes `uncertain`: it is reported once (then
// `surfaced`) and never replayed. Lines carry the operation, the ref, the caller, the origin and a digest of the arguments, never their
// content; a mod's call may carry its own key (graph-integrity G6.3), and a call's outcome what it made (a ref), so the mod can look its
// call up by its key (after an `uncertain` delivery, before acting again). The file lives in the framework's profile data, never in
// ~/.codex. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const OUTCOMES = new Set(['done', 'refused', 'failed', 'stopped']);
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';

/** A stable digest of operation arguments (sensitive content stays out of the journal). */
export function argsDigest(args) {
  return createHash('sha256').update(stableJson(args ?? null)).digest('hex').slice(0, 32);
}
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

/**
 * @param {string} file
 * @param {{ now?: () => number, fsync?: boolean, keepTail?: number, log?: object }} [o]
 */
export function openJournal(file, o = {}) {
  const now = o.now ?? Date.now;
  const doSync = o.fsync !== false;
  const keepTail = o.keepTail ?? 500;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  // Read what is there: intents by id, in first-seen order.
  const byId = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }   // a torn last line from a crash is skipped
      if (!e || typeof e.id !== 'string') continue;
      const it = byId.get(e.id) ?? { id: e.id, started: null, outcome: null, uncertain: false, surfaced: false };
      if (e.phase === 'started') it.started = e;
      else if (OUTCOMES.has(e.phase)) it.outcome = e;
      else if (e.phase === 'uncertain') it.uncertain = true;
      else if (e.phase === 'surfaced') it.surfaced = true;
      byId.set(e.id, it);
    }
  }
  // Open intents became uncertain with the crash.
  for (const it of byId.values()) if (it.started && !it.outcome && !it.uncertain) it.uncertain = true;
  // Compact: keep every uncertain-not-surfaced intent and the last `keepTail` finished ones, rewritten atomically.
  const kept = [];
  const finished = [...byId.values()].filter((it) => it.started && (it.outcome || it.surfaced));
  const tail = new Set(finished.slice(-keepTail).map((it) => it.id));
  for (const it of byId.values()) {
    if (!it.started) continue;
    if (it.uncertain && !it.surfaced) kept.push(it);
    else if (tail.has(it.id)) kept.push(it);
  }
  const lines = [];
  for (const it of kept) {
    lines.push(JSON.stringify(it.started));
    if (it.outcome) lines.push(JSON.stringify(it.outcome));
    if (it.uncertain) lines.push(JSON.stringify({ id: it.id, phase: 'uncertain', t: now() }));
    if (it.surfaced) lines.push(JSON.stringify({ id: it.id, phase: 'surfaced', t: now() }));
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
  fs.renameSync(tmp, file);
  const fd = fs.openSync(file, 'a', 0o600);
  const open = new Map(kept.filter((it) => it.uncertain && !it.surfaced).map((it) => [it.id, it]));   // uncertain, to report once
  // the calls by their callers' keys (G6.3): the newest of each, from what is kept, then as they start
  const keyed = new Map();     // `${caller}\n${key}` -> {id, started, outcome, uncertain}
  const keysOf = new Map();    // intent id -> its key's index entries
  const keyOf = (caller, key) => `${caller}\n${key}`;
  function remember(it) {
    const key = it.started?.key;
    if (typeof key !== 'string' || typeof it.started.caller !== 'string') return;
    const k = keyOf(it.started.caller, key);
    keyed.set(k, it);
    keysOf.set(it.id, [k]);
    if (keyed.size > 5000) { const first = keyed.keys().next().value; keysOf.delete(keyed.get(first)?.id); keyed.delete(first); }
  }
  for (const it of kept) remember({ id: it.id, started: it.started, outcome: it.outcome, uncertain: it.uncertain });
  const live = new Map();   // started in this run, no outcome yet
  let closed = false;

  function append(entry, sync) {
    if (closed) throw new Error('the intent journal is closed');
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    if (sync && doSync) fs.fsyncSync(fd);
  }

  return {
    /** Claim an effect before it happens. Returns the intent id. The line is on disk when this returns. */
    start({ operation, ref = null, caller = null, origin = null, args, source = 'graph', id = randomUUID(), approvedBy, key }) {
      const e = { id, phase: 'started', t: now(), source, operation, ref, caller, origin, args: argsDigest(args), ...(approvedBy ? { approvedBy } : {}),
        ...(typeof key === 'string' && key ? { key } : {}) };
      append(e, true);
      live.set(id, e);
      remember({ id, started: e, outcome: null, uncertain: false });
      return id;
    },
    /** Record the outcome of a claimed effect; `made`: what it made (a ref), when it says. */
    finish(id, phase, detail, made = null) {
      if (!OUTCOMES.has(phase)) throw new Error(`unknown outcome ${phase}`);
      if (!live.has(id)) return false;
      const e = { id, phase, t: now(), ...(detail ? { detail: String(detail).slice(0, 500) } : {}), ...(isRef(made) ? { made: { type: made.type, provider: made.provider, id: made.id } } : {}) };
      append(e, false);
      live.delete(id);
      for (const k of keysOf.get(id) ?? []) { const x = keyed.get(k); if (x && x.id === id) x.outcome = e; }
      return true;
    },
    /**
     * A caller's call by its own key (G6.3): `{status: 'started' | 'done' | 'refused' | 'failed' | 'stopped' | 'uncertain', made?, at}` of
     * the newest with that key, or null (none, or no longer kept: the journal keeps the last finished ones).
     */
    byKey(caller, key) {
      const it = typeof caller === 'string' && typeof key === 'string' ? keyed.get(keyOf(caller, key)) : null;
      if (!it) return null;
      const status = it.outcome ? it.outcome.phase : it.uncertain || !live.has(it.id) ? 'uncertain' : 'started';
      return Object.freeze({ status, ...(it.outcome?.made ? { made: it.outcome.made } : {}), at: it.started.t });
    },
    /** The outcome cannot be known in this run (the backend went away before replying): uncertain now, reported like a crash's. */
    uncertainNow(id) {
      const e = live.get(id);
      if (!e) return false;
      append({ id, phase: 'uncertain', t: now() }, false);
      live.delete(id);
      open.set(id, { id, started: e, outcome: null, uncertain: true, surfaced: false });
      for (const k of keysOf.get(id) ?? []) { const x = keyed.get(k); if (x && x.id === id) x.uncertain = true; }
      return true;
    },
    /** Intents a crash left uncertain that were not reported yet: [{id, operation, ref, caller, origin, t}]. */
    uncertain() { return [...open.values()].map((it) => ({ id: it.id, operation: it.started.operation, ref: it.started.ref, caller: it.started.caller, origin: it.started.origin, source: it.started.source, t: it.started.t })); },
    /** An uncertain intent has been reported to the user: it is never reported again. */
    markSurfaced(id) { if (!open.delete(id)) return false; append({ id, phase: 'surfaced', t: now() }, false); return true; },
    isOpen: (id) => live.has(id),
    close() { if (closed) return; closed = true; try { fs.closeSync(fd); } catch { /* closed */ } },
  };
}
