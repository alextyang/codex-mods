// Observation: bounded per-subscriber queues with explicit gaps, and the primary-session boot ring (requirement 8).
import { deepFreeze } from './util.mjs';

export const DEFAULT_QUEUE = 1000;
export const BOOT_RING_BYTES = 4 * 1024 * 1024;

import { METHOD_CLASSES } from './method-classes.mjs';

/**
 * Methods whose frames can carry credentials (API keys, auth tokens, attestations), in any direction (protocol.md H4, H15). The boot ring
 * keeps their place in the stream but never their content, so a late observer replaying the ring cannot read a secret.
 */
export const SECRET_METHODS = Object.freeze(new Set([
  // server requests and retired methods the client-request table does not classify
  'account/chatgptAuthTokens/refresh', 'attestation/generate', 'getAuthStatus',
  // every client request the method classes mark secret (one classification, so a new secret method is redacted here too)
  ...Object.entries(METHOD_CLASSES).filter(([, c]) => c.secret).map(([m]) => m),
]));

/** The ring's form of a secret-bearing frame: its id and method, nothing else. */
export function redactedLine(msg, method) {
  const out = { redacted: true, method };
  if (msg && msg.id !== undefined) out.id = msg.id;
  return JSON.stringify(out);
}

/** Last N bytes of serialized frames of the current primary session. */
export function createRing(maxBytes = BOOT_RING_BYTES) {
  let entries = [], head = 0, bytes = 0;
  return {
    add(meta, line) {
      const n = Buffer.byteLength(line);
      if (n > maxBytes) return;
      entries.push({ meta, line, n });
      bytes += n;
      while (bytes > maxBytes) { bytes -= entries[head].n; entries[head++] = undefined; }
      if (head > 1024 && head * 2 > entries.length) { entries = entries.slice(head); head = 0; }
    },
    clear() { entries = []; head = 0; bytes = 0; },
    get bytes() { return bytes; },
    snapshot() { return entries.slice(head); },
  };
}

function matcherFor(methods) {
  if (methods === undefined || methods === '*') return { all: true, exact: new Set(), prefixes: [] };
  const exact = new Set(), prefixes = [];
  for (const m of methods) { if (m.endsWith('/')) prefixes.push(m); else exact.add(m); }
  return { all: false, exact, prefixes };
}

export function createObserverHub({ log, displayBackend, sessionOf = () => undefined }) {
  let subs = []; // immutable array swapped on change

  const matches = (sub, kind, method) => {
    if (sub.kinds && !sub.kinds.has(kind)) return false;
    const m = sub.match;
    if (m.all || m.exact.has(method)) return true;
    for (const p of m.prefixes) if (method.startsWith(p)) return true;
    return false;
  };

  function makeInfo(sub, base) {
    const info = { kind: base.kind, method: base.method, origin: base.origin, backend: displayBackend(base.backendId, sub.client.id) };
    if (base.affinityKey !== undefined) info.affinityKey = base.affinityKey;
    const session = sessionOf(base.backendId);
    if (session) info.session = session;
    return Object.freeze(info);
  }

  function schedule(sub) {
    if (sub.scheduled) return;
    sub.scheduled = true;
    setImmediate(() => drain(sub));
  }
  function call(sub, m, info) {
    try { sub.listener(m, info); } catch (e) { log.warn('observer listener threw', { client: sub.client.id, message: String(e?.message ?? e) }); }
  }
  function drain(sub) {
    sub.scheduled = false;
    while (sub.queue.length && !sub.disposed) {
      const item = sub.queue.shift();
      call(sub, item.m, item.info);
    }
    if (!sub.disposed && sub.gap) { const g = sub.gap; sub.gap = null; call(sub, Object.freeze({ gap: Object.freeze(g) }), null); }
  }
  function enqueue(sub, m, info) {
    sub.seq++;
    if (sub.queue.length >= sub.cap) {
      if (sub.gap) sub.gap.to = sub.seq; else sub.gap = { from: sub.seq, to: sub.seq, reason: 'overflow' };
      schedule(sub); // make sure the gap gets delivered even if nothing else arrives
      return;
    }
    if (sub.gap) { const g = sub.gap; sub.gap = null; sub.queue.push({ m: Object.freeze({ gap: Object.freeze(g) }), info: null }); }
    sub.queue.push({ m, info });
    schedule(sub);
  }

  return {
    add(client, filter, listener, { queue, replay } = {}, ring) {
      const sub = {
        client, listener, cap: Math.max(1, queue ?? DEFAULT_QUEUE),
        kinds: filter?.kinds ? new Set(filter.kinds) : null, match: matcherFor(filter?.methods),
        queue: [], seq: 0, gap: null, scheduled: false, disposed: false,
      };
      if (replay === 'boot' && ring) {
        for (const e of ring.snapshot()) {
          if (!matches(sub, e.meta.kind, e.meta.method)) continue;
          let m; try { m = deepFreeze(JSON.parse(e.line)); } catch { continue; }
          enqueue(sub, m, makeInfo(sub, e.meta));
        }
      }
      subs = [...subs, sub];
      return { dispose() { sub.disposed = true; sub.queue.length = 0; subs = subs.filter((s) => s !== sub); } };
    },
    removeClient(clientId) { for (const s of subs) if (s.client.id === clientId) s.disposed = true; subs = subs.filter((s) => s.client.id !== clientId); },
    /** base: {kind, method, origin, backendId, affinityKey?, privateTo?, frameworkOnly?}. msg is frozen once and shared. A frame `privateTo`
     *  a client (an internal mod's hidden thread, its own traffic) is observed by that client only; one `frameworkOnly` (a framework
     *  backend's account traffic) by the framework's own clients only, never a mod's. */
    emit(base, msg) {
      if (subs.length === 0) return;
      let frozen = null;
      for (const sub of subs) {
        if (base.privateTo !== undefined && sub.client.id !== base.privateTo) continue;
        if (base.frameworkOnly && sub.client.id.startsWith('mod:')) continue;
        if (!matches(sub, base.kind, base.method)) continue;
        frozen ??= deepFreeze(msg);
        enqueue(sub, frozen, makeInfo(sub, base));
      }
    },
  };
}
