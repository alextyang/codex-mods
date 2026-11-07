// The app-server mux (ARCHITECTURE §6; contracts/host.d.ts `createMux`). The only owner of app <-> app-server traffic.
// No feature policy lives here: it knows paths, keys and methods from the protocol catalog, never threads or accounts.
// Framework backends (owner 'framework', reference-mods.md RM10): backends the framework runs for the user's own work (an added account's
// app-server). Mods cannot name them; what they send that no key ties to a thread (their account's traffic) reaches framework clients only,
// never the app or a mod. A key can be held (its requests wait), re-homed on another backend (its subscribers follow, its old home's
// frames for it are dropped) and placed (restored after a restart); keyless creator requests can be sent to a start backend.
import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { newId } from '../fsutil.mjs';
import { createFramer, MAX_FRAME_BYTES, MAX_BACKEND_FRAME_BYTES } from './framing.mjs';
import { buildConfigOverrideArgs, withConfigArgs } from './config-overrides.mjs';
import { createAffinity, AFFINITY_MAX } from './affinity.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { classOf } from './method-classes.mjs';
import { createKeyTable, FAMILIES } from './keys.mjs';
import { createRegistry, createChain, validateReplace, EMPTY } from './interceptors.mjs';
import { createObserverHub, createRing, SECRET_METHODS, redactedLine } from './observers.mjs';
import {
  KINDS, isObject, hasId, isResponseShape, compilePaths, getPath, extractKey, assertAllowed, deepFreeze,
  rpcError, rpcErrorFor, errorFromRpc,
} from './util.mjs';

export { MAX_FRAME_BYTES, MAX_BACKEND_FRAME_BYTES };

const MAX_RANK = Number.MAX_SAFE_INTEGER;
const LATENCY_RESERVOIR = 1024;
const SERVICES_METHOD = 'codexmods/services.call';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DEFAULT_ARGV = Object.freeze(['app-server']);
/** Mux addition 4a: notifications an app session may opt out of that the backend sends anyway, so observers (the graph runtime) see them;
 *  the mux drops them on delivery to the clients that opted out. The legacy `codex/event/*` stream and output deltas stay opted out. */
export const DEFAULT_UPSTREAM_OPT_INS = Object.freeze([
  'turn/diff/updated', 'thread/compacted', 'thread/closed', 'thread/reverted', 'thread/readState/changed', 'thread/project/updated',
  'project/changed', 'warning',
]);
const UNSUBSCRIBE = 'thread/unsubscribe';
const STARTED = 'thread/started';   // its thread is in params.thread.id, which the catalog may not key
const FRAMEWORK = 'framework';      // the owner of framework backends
const isModClientId = (id) => typeof id === 'string' && id.startsWith('mod:');
/** The client requests about a thread (the protocol's methods that take a threadId): only these reach a framework backend by their key, so a
 *  stray threadId on another method (an account's sign-in) never routes it to an added account's backend. */
const THREAD_SCOPED = /^(thread|turn|review|app|mcpServer|mcpServerStatus|hooks|experimentalFeature|feedback)\//;
const CLIENT_SIDE = new Set(['clientRequest', 'serverResponse', 'clientNotification']);
/** The opt-out list of an initialize's params, as a set. */
const optOutsOf = (params) => new Set(Array.isArray(params?.capabilities?.optOutNotificationMethods) ? params.capabilities.optOutNotificationMethods.filter((m) => typeof m === 'string') : []);

/** The relay's first line (contracts/ipc.d.ts §4): {"codexmodsRelay":1,"argv":[...]} or {"codexmodsRelay":2,"argv":[...],"envHex":"..."};
 *  returns {argv} or {argv, env}, or null when the line is not a valid header. `envHex` is the app's environment as hex of
 *  NUL-separated NAME=value entries (`env -0`), so values with newlines or any other bytes arrive intact. Never log the result. */
function parseRelayHeader(line) {
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (!isObject(m) || (m.codexmodsRelay !== 1 && m.codexmodsRelay !== 2)) return null;
  if (!Array.isArray(m.argv) || !m.argv.every((a) => typeof a === 'string')) return null;
  if (m.codexmodsRelay === 1) return { argv: m.argv };
  const env = parseEnvHex(m.envHex);
  return env ? { argv: m.argv, env } : null;
}
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
function parseEnvHex(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  const env = {};
  for (const entry of Buffer.from(hex, 'hex').toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);   // the first '=' ends the name; entries without a name are skipped
  }
  return env;
}

/** @type {typeof import('../../../contracts/host.d.ts').createMux} */
export function createMux(opts) {
  const { catalog, launchFor, bus, log, clientsSocketPath, beforePrimaryStart } = opts;
  const journal = opts.journal ?? null;   // mux addition 8: the graph runtime's intent journal (framework/host/graph/journal.mjs)
  const spawn = opts.spawn ?? nodeSpawn;
  const tune = {
    restartIntervalMs: 10_000, handshakeWaitMs: 10_000, killGraceMs: 3_000, requestTimeoutMs: 60_000, authTimeoutMs: 5_000,
    writeAckMs: 5_000, maxTombstones: 1024,
    maxClientHoldMs: 600_000,   // mux addition 5: a deferred client request not settled within this is released unchanged ('expired')
    affinityMax: AFFINITY_MAX, queueMaxItems: 10_000, queueMaxBytes: 64 * 1024 * 1024, maxFrameBytes: MAX_FRAME_BYTES, maxBackendFrameBytes: MAX_BACKEND_FRAME_BYTES, writeCapBytes: 64 * 1024 * 1024, bootRingBytes: undefined,
    ...(opts.tuning ?? {}),
  };

  const HS_REQ = catalog.handshake.request, HS_NOTE = catalog.handshake.notification;
  const keyPaths = compilePaths(catalog.affinityKeyPaths);
  const creators = new Map();
  for (const c of catalog.affinityCreators ?? []) creators.set(c.method, c.resultPath.split('.'));
  const upstreamOptIns = new Set(opts.upstreamOptIns ?? DEFAULT_UPSTREAM_OPT_INS);

  let closed = false;
  let midSeq = 0, sidSeq = 0, regSeq = 0;
  const clients = new Map();        // id -> Client (alive ones)
  const leases = new Map();         // leaseId -> Lease
  const backends = new Map();       // backend id -> Backend
  const pendingByMid = new Map();   // 'm:<n>' -> Req (transmitted client requests and internal handshake requests)
  const srvPending = new Map();     // 's:<n>' -> {backend, gen, origId, owner, method, key}
  const deferred = new Map();       // token -> Deferred: requests taken out of the stream (gate G-defer; client requests: mux addition 5)
  const tombstones = new Map();     // token -> {modId, reason}: closed tokens, bounded, so a late answer gets a truthful reason
  const resolvedSids = new Map();   // 's:<n>' -> owner client id: requests the backend resolved before their client answered (bounded)
  const answeredSids = new Map();   // 's:<n>' -> {backend, gen, origId}: answered by their client, until serverRequest/resolved (bounded)
  const bounded = (map) => { while (map.size > tune.maxTombstones) map.delete(map.keys().next().value); };
  const faultListeners = new Set();
  const frames = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const interceptorCalls = {}, interceptorFaults = {};
  const latency = { buf: new Float64Array(LATENCY_RESERVOIR), n: 0, seen: 0 };
  const aff = createAffinity({ max: tune.affinityMax });
  // Framework placement (RM10): a key the framework re-homed or placed -> its home ('primary' for any app session's backend, else a
  // framework backend id). Frames keyed by it from any other backend are its old home's, and dropped.
  const placed = new Map();
  const placedListeners = new Set();
  const holds = new Map();          // key -> {holder: client id, queue: [fn]}: its requests wait until the holder releases it
  let startBackend = null;          // a framework backend id: where keyless creator requests (a new thread) go
  const keyTable = createKeyTable({ max: tune.affinityMax });   // mux addition 1
  const subKey = (backendId, key) => `${backendId}\n${key}`;
  // keyed by backend and thread: a subscription is to a thread on one backend. In-process listeners (`onSubscription`: the native source,
  // which re-reads a thread it shows when the thread is open again, R1) are told when one gains its first subscriber or loses its last.
  const subListeners = new Set();
  const subs = createSubscriptions({
    onChange(sk, open) {
      const at = sk.indexOf('\n');
      const key = sk.slice(at + 1);
      if (subListeners.size) {
        const change = Object.freeze({ backend: displayBackend(sk.slice(0, at)), key, open });
        queueMicrotask(() => { for (const fn of [...subListeners]) { try { fn(change); } catch (e) { log.warn('a subscription listener failed', { message: String(e?.message ?? e) }); } } });
      }
    },
  });
  const registry = createRegistry();
  const sessions = new Map();       // n -> AppSession (live app connections, oldest first)
  let sessionSeq = 0;
  const bootRings = { snapshot: () => [...sessions.values()].flatMap((S) => S.ring.snapshot()) };
  const mkLatch = () => {
    let isSet = false, value, waiters = [];
    return {
      get isSet() { return isSet; }, get value() { return value; },
      set(v) { isSet = true; value = v; const w = waiters; waiters = []; for (const x of w) { clearTimeout(x.t); x.ok(v); } },
      reset() { isSet = false; value = undefined; },
      wait(ok, fail, ms) {
        if (isSet) return ok(value);
        const x = { ok, t: null };
        x.t = setTimeout(() => { waiters = waiters.filter((y) => y !== x); fail(); }, ms);
        x.t.unref?.();
        waiters.push(x);
      },
    };
  };
  const aliasWaiters = [];          // waiting for any app session (mod-facing 'primary' with no session yet)
  const hsWaiters = [];             // named backends waiting for any session's handshake params
  let leaseServiceHandler = null;

  // ------------------------------------------------------------------ small helpers
  const publish = (topic, data) => { try { bus.publish(topic, data); } catch (e) { log.warn('bus publish failed', { topic, message: String(e?.message ?? e) }); } };
  const internalError = (e) => log.error('mux internal error', { message: String(e?.stack ?? e) });
  const unavailable = (msg, details) => new CodexModsError('Unavailable', msg, details);
  const outcomeUnknown = (msg) => new CodexModsError('OutcomeUnknown', msg);

  function displayBackend(backendId, viewerId) {
    if (backendId === 'primary' || backendId.startsWith('primary:')) return 'primary';
    if (viewerId && backendId.startsWith(viewerId + '/')) return backendId.slice(viewerId.length + 1);
    return backendId;
  }
  const isFramework = (b) => b?.owner === FRAMEWORK;
  /** Whether a frame keyed by `key` from backend `b` comes from the key's home (every key not placed is at home anywhere). */
  function atHome(key, b) {
    const h = key === undefined ? undefined : placed.get(key);
    if (h === undefined) return true;
    return h === 'primary' ? !!b.session : h === b.id;
  }
  function notePlaced(key, home) {
    placed.delete(key); placed.set(key, home);
    // a key placed on a framework backend is kept for good (its record is the Host's); only old 'primary' marks give way
    if (placed.size > tune.affinityMax) for (const [k, h] of placed) { if (placed.size <= tune.affinityMax) break; if (h === 'primary') placed.delete(k); }
    const change = Object.freeze({ key, backend: home });
    for (const fn of [...placedListeners]) { try { fn(change); } catch (e) { log.warn('a placement listener failed', { message: String(e?.message ?? e) }); } }
  }
  /** A frame on a framework backend that is not about a thread (nor a thread's creation): its account's traffic, the framework's only. A
   *  client request (and its answer) is about a thread when its method is one and it is keyed; a server's frame when it is keyed. */
  function frameworkOnly(backendId, key, method, kind) {
    if (method === STARTED || creators.has(method) || !isFramework(backends.get(backendId))) return false;
    if (key === undefined) return true;
    return CLIENT_SIDE.has(kind) && !THREAD_SCOPED.test(method ?? '');
  }
  /** One of the framework's own in-process clients (not a mod's, not the app's or a lease's). */
  const frameworkClient = (c) => c?.kind === 'mod' && !isModClientId(c.id);
  const frameworkRegs = (regs) => (regs === EMPTY ? regs : regs.filter((r) => !isModClientId(r.client.id)));
  /** Which app session a frame belongs to (mux addition 6): the session number and the app's clientInfo.name from its initialize. */
  function sessionOf(backendId) {
    const S = backends.get(backendId)?.session;
    if (!S) return undefined;
    const name = S.hs.params.isSet ? S.hs.params.value?.params?.clientInfo?.name : undefined;
    return Object.freeze(typeof name === 'string' ? { id: S.n, client: name } : { id: S.n });
  }
  const hub = createObserverHub({ log, displayBackend, sessionOf });
  const withSession = (backendId) => { const session = sessionOf(backendId); return session ? { session } : {}; };
  const chain = createChain({
    onCall(reg) { interceptorCalls[reg.client.id] = (interceptorCalls[reg.client.id] ?? 0) + 1; },
    onFault(reg, kind, message) {
      interceptorFaults[reg.client.id] = (interceptorFaults[reg.client.id] ?? 0) + 1;
      log.warn('interceptor fault', { client: reg.client.id, kind, message });
      for (const fn of [...faultListeners]) { try { fn({ clientId: reg.client.id, kind, message }); } catch (e) { internalError(e); } }
    },
    resolveRoute(reg, key) { return resolveBackendName(reg.client, key); },
    onInternalError: internalError,
  });

  // ---- private threads (reference-mods.md §2, RM7): a client given a `hiddenRoot` (an internal mod's, by the Host) keeps its traffic and
  // its threads to itself: observed by it only, run through its own interceptors only, delivered to no other client and kept out of the
  // diagnostic ring; the app never hears of them. Its threads are its own by their key (the start's answer makes it their owner), and one
  // that starts in a folder under its root is already its own at its first notification (thread/started may come before that answer).
  // A thread stays private until it closes (thread/closed): never evicted while it may still be loaded.
  const hidden = new Map();   // thread id (affinity key) -> the id of the client whose private thread it is
  const underRoot = (p, root) => typeof p === 'string' && (p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`));
  /** The client a frame is private to: the client that sent it when it has a hidden root, else the owner of a hidden thread it is keyed by. */
  function privateOf(origin, key) {
    const c = typeof origin === 'string' ? clients.get(origin) : undefined;
    if (c?.hiddenRoot) return c.id;
    return key !== undefined ? hidden.get(key) : undefined;
  }
  /** A thread/started in a client's hidden root makes that thread its private one (before its start's answer names the thread): the
   *  client's id, or undefined. The catalog may not key thread/started (`params.thread.id`), so its owner is told here, not by its key. */
  function noteHiddenStart(msg) {
    if (msg?.method !== 'thread/started') return undefined;
    const t = msg.params?.thread;
    if (typeof t?.id !== 'string' || typeof t.cwd !== 'string') return undefined;
    if (hidden.has(t.id)) return hidden.get(t.id);
    for (const c of clients.values()) {
      if (!c.hiddenRoot || c.disposed || !underRoot(t.cwd, c.hiddenRoot)) continue;
      hidden.set(t.id, c.id);
      return c.id;
    }
    return undefined;
  }
  /** The thread lists the server answers (an ephemeral thread is listed while it is loaded): each entry's thread id. */
  const THREAD_LISTS = { 'thread/list': (x) => x?.id, 'thread/loaded/list': (x) => x, 'thread/search': (x) => x?.thread?.id };
  /** A list's answer without another client's private threads. */
  function withoutPrivate(method, result, viewer) {
    const idOf = THREAD_LISTS[method];
    if (!idOf || hidden.size === 0 || !Array.isArray(result?.data)) return result;
    const data = result.data.filter((x) => { const owner = hidden.get(idOf(x)); return owner === undefined || owner === viewer; });
    return data.length === result.data.length ? result : { ...result, data };
  }
  /** Only the interceptors of the client a frame is private to see it. */
  const regsFor = (regs, privateTo) => (privateTo === undefined || regs === EMPTY ? regs : regs.filter((r) => r.client.id === privateTo));

  function observe(base, msg) {
    try { keyTable.note(msg, base.backendId); } catch (e) { internalError(e); }
    if (frameworkOnly(base.backendId, base.affinityKey, base.method, base.kind)) { hub.emit({ ...base, frameworkOnly: true }, msg); return; }
    const privateTo = privateOf(base.origin, base.affinityKey);
    if (privateTo !== undefined) { hub.emit({ ...base, privateTo }, msg); return; }
    hub.emit(base, msg);
    const S = backends.get(base.backendId)?.session;
    if (S) {
      const line = SECRET_METHODS.has(base.method) ? redactedLine(msg, base.method) : JSON.stringify(msg);
      try { S.ring.add({ kind: base.kind, method: base.method, origin: base.origin, backendId: base.backendId, affinityKey: base.affinityKey }, line); }
      catch (e) { internalError(e); }
    }
  }

  /** Algorithm R reservoir sample: a fixed-size, unbiased sample of every clientRequest mediation time. */
  function recordLatency(ms) {
    latency.seen++;
    if (latency.n < LATENCY_RESERVOIR) latency.buf[latency.n++] = ms;
    else { const j = Math.floor(Math.random() * latency.seen); if (j < LATENCY_RESERVOIR) latency.buf[j] = ms; }
  }
  function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0; }

  // ------------------------------------------------------------------ clients
  function makeClient(id, kind, extra = {}) {
    return {
      id, kind, origin: id, rank: MAX_RANK, maxInFlight: 32, allowed: undefined, conn: null, alive: true,
      active: new Set(), notes: new Set(), nextId: 1, transmitted: false, regs: new Set(), subs: new Set(), disposed: false,
      deferListeners: new Set(), resolveListeners: new Set(), ...extra,
    };
  }
  /** Oldest live app session, preferring sessions that have started (their backend can answer). */
  function oldestSession() {
    let first;
    for (const S of sessions.values()) { if (S.gone) continue; if (S.started) return S; first ??= S; }
    return first;
  }
  const defaultPrimary = () => oldestSession()?.primary;

  function writeConn(client, obj) {
    const c = client.conn;
    if (!c || c.stream.destroyed || !c.stream.writable) return false;
    if (c.stream.writableLength > tune.writeCapBytes) {
      log.error('client output queue exceeded its limit; closing connection', { client: client.id });
      c.stream.destroy();
      return false;
    }
    try { c.stream.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { log.warn('client write failed', { client: client.id, message: String(e?.message ?? e) }); return false; }
  }

  /** Mod-facing backend name -> internal backend id. */
  function resolveBackendName(client, name) {
    if (name === undefined) return undefined;
    if (typeof name !== 'string' || !name) throw new CodexModsError('Invalid', 'backend must be a non-empty string');
    if (name === 'primary') return 'primary';   // alias: the oldest live session's backend, resolved at use
    if (name.startsWith(`${FRAMEWORK}/`)) {
      // a framework backend: the framework's own clients only (an in-process client that is not a mod's)
      if (client.kind !== 'mod' || isModClientId(client.id)) throw new CodexModsError('Denied', `backend '${name}' belongs to another owner`);
      if (!backends.has(name)) throw unavailable(`unknown backend '${name}'`);
      return name;
    }
    const id = name.startsWith('mod:') && name.includes('/') ? name : `${client.id}/${name}`;
    if (!id.startsWith(client.id + '/')) throw new CodexModsError('Denied', `backend '${name}' belongs to another owner`);
    if (!backends.has(id)) throw unavailable(`unknown backend '${name}'`);
    return id;
  }

  // ------------------------------------------------------------------ request settlement
  /** Ends a client request: its response (or failure) goes to its client. Returns whether it was handed over (false: already ended,
   *  or the client's connection could not take it). */
  function settle(req, outcome) {
    if (req.done) return false;
    req.done = true;
    if (req.hold) cancelHeld(req.hold, 'cancelled');   // the request ended (its timeout) while a mod held it: nothing is left to decide
    if (req.muxIntent) settleIntent(req, outcome);
    if (req.timer) clearTimeout(req.timer);
    const c = req.client;
    c.active.delete(req);
    if (req.mid) { pendingByMid.delete(req.mid); req.backend?.pending.delete(req); }
    let delivered = false;
    if (outcome.response) {
      const r = outcome.response;
      if (!outcome.silent) observe({ kind: 'serverResponse', method: req.method, origin: c.origin, backendId: req.destId ?? 'primary', affinityKey: req.key }, r);
      if (c.kind === 'mod') { if ('error' in r) req.reject(errorFromRpc(r.error)); else req.resolve(r.result ?? null); delivered = true; }
      else delivered = writeConn(c, r);
    } else {
      const err = outcome.fail;
      if (c.kind === 'mod') { req.reject(err); delivered = true; }
      else if (c.alive) delivered = writeConn(c, { id: req.id, error: rpcErrorFor(err) });
    }
    const end = req.onEnd;
    if (end) { req.onEnd = null; end(outcome, delivered); }
    return delivered;
  }
  /** The request's client went away (connection closed, or the mod client was disposed): nothing more is delivered to it. A hold on the
   *  request closes `appGone`; a release waiting for the response is told. */
  function requesterGone(req) {
    if (req.hold) cancelHeld(req.hold, 'appGone');
    const end = req.onEnd;
    if (end) { req.onEnd = null; end(null, false); }
  }
  const failStage = (req, why) => (req.stage === 'sent' ? outcomeUnknown(why) : unavailable(why));

  const rpcResponse = (id, r) => ('error' in r ? { id, error: r.error } : { id, result: r.result });

  // ------------------------------------------------------------------ client -> server pipeline
  function newReq(client, msg, explicit) {
    return { client, id: msg.id, msg, method: msg.method, explicit, done: false, stage: 'new', mid: null, backend: null, destId: undefined, key: undefined, timer: null, resolve: null, reject: null, internal: null };
  }

  /** Backend id (or the 'primary' alias = oldest live session) for a client's message: explicit > affinity > the start backend (a keyless
   *  creator: a new thread) > default. */
  function destFor(client, explicit, key, method) {
    if (explicit) return explicit;
    if (key !== undefined) {
      const e = aff.get(key);
      const h = placed.get(key);   // placed on a framework backend (its affinity maybe long evicted)
      const home = e?.backend ?? (h !== undefined && h !== 'primary' && backends.has(h) ? h : undefined);
      // a framework backend takes a keyed request only about its thread (or the framework's own)
      if (home !== undefined && (!isFramework(backends.get(home)) || THREAD_SCOPED.test(method ?? '') || frameworkClient(client))) return home;
    }
    if (startBackend && key === undefined && creators.has(method) && backends.has(startBackend)) return startBackend;
    return client.session ? client.session.primary.id : 'primary';
  }
  const concrete = (id) => (id === 'primary' ? defaultPrimary()?.id : id);

  /** Run `ok(backend)` once the destination is ready; resolves the 'primary' alias at that moment. */
  function withDest(destId, bypass, ok, fail) {
    if (destId !== 'primary') {
      const b = backends.get(destId);
      if (!b) return fail(unavailable('backend is not available'));
      return whenReady(b, bypass, () => ok(b), fail);
    }
    const b = defaultPrimary();
    if (b) return whenReady(b, bypass, () => ok(b), fail);
    const w = { go: () => withDest('primary', bypass, ok, fail), fail, t: null };
    w.t = setTimeout(() => { aliasWaiters.splice(aliasWaiters.indexOf(w), 1); fail(unavailable('no app session is connected')); }, tune.handshakeWaitMs);
    w.t.unref?.();
    aliasWaiters.push(w);
  }
  function flushAliasWaiters() {
    if (!aliasWaiters.length || !defaultPrimary()) return;
    for (const w of aliasWaiters.splice(0)) { clearTimeout(w.t); try { w.go(); } catch (e) { internalError(e); } }
  }

  function submitRequest(req) {
    const { client, msg } = req;
    const t0 = performance.now();
    const key0 = extractKey(msg, keyPaths);
    const dest0 = destFor(client, req.explicit, key0, msg.method);
    const all = registry.lookup('clientRequest', msg.method);
    const regs = frameworkOnly(dest0, key0, msg.method, 'clientRequest') ? frameworkRegs(all) : regsFor(all, client.hiddenRoot ? client.id : undefined);
    if (regs.length === 0) return afterRequest(req, { type: 'pass', msg }, t0);
    chain({
      regs, msg, kind: 'clientRequest', skipClient: client,
      infoFor: (reg) => Object.freeze({ kind: 'clientRequest', method: msg.method, origin: client.origin, backend: displayBackend(dest0, reg.client.id), ...(key0 === undefined ? {} : { affinityKey: key0 }), ...withSession(dest0) }),
      done: (res) => afterRequest(req, res, t0),
    });
  }

  /** The rest of a client request's pipeline after its interceptor chain (`t0` is when the chain started; absent for a held request
   *  that is being released, whose chain was already timed). */
  function afterRequest(req, res, t0) {
    if (t0 !== undefined) recordLatency(performance.now() - t0);
    if (req.done) return;
    const { client } = req;
    if (res.type === 'reject') return settle(req, { response: { id: req.id, error: rpcError(-32001, 'rejected by an interceptor', { interceptor: res.by }) }, silent: true });
    if (res.type === 'respond') {
      const key = extractKey(req.msg, keyPaths);
      req.destId = destFor(client, req.explicit, key, req.method); req.key = key;
      return settle(req, { response: rpcResponse(req.id, res.respond) });
    }
    if (res.type === 'defer') {
      // Out of the pipeline at once: nothing else waits on this request, and the client's later requests flow (mux addition 5).
      if (holdRequest(req, res)) return;
      res = { type: 'pass', msg: res.msg, route: res.route };   // could not hold (the mod is gone, or listens for nothing): continue normally
    }
    let final = res.msg;
    const key = extractKey(final, keyPaths);
    // a held key's requests wait for its holder (a move between backends), then go where the key is then
    const hold = key !== undefined ? holds.get(key) : undefined;
    if (hold && hold.holder !== client.id) { hold.queue.push(() => afterRequest(req, res)); return; }
    const destId = res.route ?? destFor(client, req.explicit, key, final.method);
    if (res.route && key !== undefined) { const c = concrete(res.route); if (c) aff.repin(key, c); }
    req.key = key;
    req.origMethod = req.method;
    req.method = final.method;   // the effective (post-replace) method drives creators, response interceptors and observation
    // Mux addition 4b: while another client stays subscribed, a client's unsubscribe is answered here and the backend keeps the thread.
    const unsubKey = final.method === UNSUBSCRIBE && key !== undefined && concrete(destId) ? subKey(concrete(destId), key) : undefined;
    if (unsubKey !== undefined && subs.size(unsubKey) - (subs.has(unsubKey, client.id) ? 1 : 0) > 0) {
      req.destId = destId;
      return settle(req, { response: { id: req.id, result: { status: subs.remove(unsubKey, client.id) ? 'unsubscribed' : 'notSubscribed' } } });
    }
    const S = client.session;
    const handshake = !!S && final.method === HS_REQ && destId === S.primary.id;
    if (handshake) {
      // Mux addition 4a: the backend sends what observers may need; this session is spared what it opted out of, on delivery.
      client.optOut = new Set([...optOutsOf(final.params)].filter((m) => upstreamOptIns.has(m)));
      if (client.optOut.size) final = { ...final, params: withoutOptIns(final.params) };
      setHandshakeParams(S, { params: final.params }); req.isHandshake = true;
    }
    transmitRequest(req, destId, final, key, handshake);
  }

  /** An initialize's params with the upstream opt-ins taken out of its opt-out list. */
  function withoutOptIns(params) {
    const caps = params.capabilities;
    return { ...params, capabilities: { ...caps, optOutNotificationMethods: caps.optOutNotificationMethods.filter((m) => !upstreamOptIns.has(m)) } };
  }

  /**
   * Mux addition 8 (docs/design/runtime-core.md R16): a request from a client other than the app whose method changes Codex state or
   * reaches outside it is claimed in the intent journal before it is written to the backend, unless the caller holds a graph intent
   * for it already. A method the table does not know is treated as an external effect. Returns false when the claim could not be
   * written: the request is then not sent.
   */
  function claimIntent(req, final) {
    if (!journal || req.client.kind === 'app' || req.isHandshake || req.intent) return true;
    if ((classOf(final.method)?.effect ?? 'external') === 'read') return true;
    try { req.muxIntent = journal.start({ source: 'mux', operation: final.method, caller: req.client.id, origin: req.client.origin, args: final.params ?? null }); return true; }
    catch (e) { log.error('intent journal write failed; the request is not sent', { method: final.method, message: String(e?.message ?? e) }); return false; }
  }
  function settleIntent(req, outcome) {
    try {
      if (outcome.response) journal.finish(req.muxIntent, 'error' in outcome.response ? 'failed' : 'done', outcome.response.error?.message);
      else if (req.stage === 'sent') journal.uncertainNow(req.muxIntent);   // written to the backend, no reply: it may or may not have happened
      else journal.finish(req.muxIntent, 'failed', outcome.fail?.message);
    } catch (e) { log.warn('intent journal outcome not written', { message: String(e?.message ?? e) }); }
  }

  function transmitRequest(req, destId, final, key, bypass) {
    withDest(destId, bypass, (b) => {
      if (req.done) return;
      req.destId = b.id;
      if (!canWrite(b)) return settle(req, { fail: unavailable('backend is not available') });
      if (b.proc && b.proc.stdin.writableLength > tune.writeCapBytes) return settle(req, { fail: new CodexModsError('Busy', 'backend input queue is full') });
      if (!claimIntent(req, final)) return settle(req, { fail: unavailable('the intent journal is not writable') });
      const mid = 'm:' + (++midSeq);
      req.mid = mid; req.stage = 'sent'; req.backend = b;
      pendingByMid.set(mid, req); b.pending.add(req);
      writeBackend(b, { ...final, id: mid });
      req.client.transmitted = true;
      observe({ kind: 'clientRequest', method: final.method, origin: req.client.origin, backendId: b.id, affinityKey: key }, final);
    }, (err) => settle(req, { fail: err }));
  }

  function submitNotification(client, msg, explicit) {
    const regs = regsFor(registry.lookup('clientNotification', msg.method), client.hiddenRoot ? client.id : undefined);
    const note = { cancelled: false };
    client.notes.add(note);
    const after = (res) => {
      if (note.cancelled) return;
      if (res.type !== 'pass') { client.notes.delete(note); return; } // drop / reject: the notification disappears
      const final = res.msg;
      const key = extractKey(final, keyPaths);
      const destId = destFor(client, explicit, key, final.method);
      const S = client.session;
      const bypass = !!S && final.method === HS_NOTE && destId === S.primary.id;
      withDest(destId, bypass, (b) => {
        client.notes.delete(note);
        if (note.cancelled || !client.alive) return;   // disposed or disconnected while queued: nothing is transmitted
        if (!canWrite(b)) return log.warn('notification dropped: backend is not available', { client: client.id });
        writeBackend(b, final);
        client.transmitted = true;
        observe({ kind: 'clientNotification', method: final.method, origin: client.origin, backendId: b.id, affinityKey: key }, final);
        if (bypass) S.hs.initializedMsg = final;
      }, (err) => { client.notes.delete(note); log.warn('notification dropped', { client: client.id, message: err.message }); });
    };
    if (regs === EMPTY) return after({ type: 'pass', msg });
    const key0 = extractKey(msg, keyPaths);
    const dest0 = destFor(client, explicit, key0, msg.method);
    chain({
      regs, msg, kind: 'clientNotification', skipClient: client,
      infoFor: (reg) => Object.freeze({ kind: 'clientNotification', method: msg.method, origin: client.origin, backend: displayBackend(dest0, reg.client.id), ...(key0 === undefined ? {} : { affinityKey: key0 }), ...withSession(dest0) }),
      done: after,
    });
  }

  function submitClientResponse(client, msg) {
    const entry = srvPending.get(msg.id);
    if (!entry && resolvedSids.get(msg.id) === client.id) { resolvedSids.delete(msg.id); return; }   // resolved elsewhere first: nothing to do
    if (!entry || entry.owner !== client.id) return log.warn('response to an unknown server request dropped', { client: client.id });
    const finish = (res) => {
      if (!srvPending.delete(msg.id)) return;
      answeredSids.set(msg.id, { backend: entry.backend, gen: entry.gen, origId: entry.origId }); bounded(answeredSids);
      const b = entry.backend;
      if (b.gen !== entry.gen || !canWrite(b)) return;
      if (res.type === 'reject') writeBackend(b, { id: entry.origId, error: rpcError(-32001, 'rejected by an interceptor', { interceptor: res.by }) });
      else {
        const m = res.msg;
        writeBackend(b, 'error' in m ? { id: entry.origId, error: m.error } : { id: entry.origId, result: m.result });
        client.transmitted = true;
        observe({ kind: 'clientResponse', method: entry.method, origin: client.origin, backendId: b.id, affinityKey: entry.key }, m);
      }
    };
    const regs = regsFor(registry.lookup('clientResponse', entry.method), privateOf(client.origin, entry.key));
    if (regs.length === 0) return finish({ type: 'pass', msg });
    chain({
      regs, msg, kind: 'clientResponse', skipClient: client,
      infoFor: (reg) => Object.freeze({ kind: 'clientResponse', method: entry.method, origin: client.origin, backend: displayBackend(entry.backend.id, reg.client.id), ...(entry.key === undefined ? {} : { affinityKey: entry.key }), ...withSession(entry.backend.id) }),
      done: finish,
    });
  }

  /** Frame from a connection-based client (the app or a lease). */
  function onClientFrame(client, msg) {
    if (typeof msg.method === 'string') {
      if (hasId(msg)) {
        frames.clientRequest++;
        if (client.kind === 'lease') {
          if (msg.method === SERVICES_METHOD) return handleServicesCall(client, msg);
          if (msg.method === HS_REQ) return answerLeaseInitialize(client, msg);
        }
        const req = newReq(client, msg, undefined);
        client.active.add(req);
        return submitRequest(req);
      }
      frames.clientNotification++;
      if (client.kind === 'lease' && msg.method === HS_NOTE) return; // the backend is already initialized
      return submitNotification(client, msg, undefined);
    }
    if (isResponseShape(msg)) { frames.clientResponse++; return submitClientResponse(client, msg); }
    log.warn('malformed frame dropped', { client: client.id });
  }

  function handleServicesCall(client, msg) {
    const lease = client.lease;
    const reply = (r) => writeConn(client, r);
    const p = msg.params;
    if (!leaseServiceHandler) return reply({ id: msg.id, error: rpcErrorFor(unavailable('no service handler is available')) });
    if (!isObject(p) || typeof p.name !== 'string' || typeof p.method !== 'string') return reply({ id: msg.id, error: rpcErrorFor(new CodexModsError('Invalid', 'services.call needs {name, method}')) });
    Promise.resolve().then(() => leaseServiceHandler(lease.owner, { name: p.name, method: p.method, args: p.args ?? null }))
      .then((result) => reply({ id: msg.id, result: result ?? null }), (e) => reply({ id: msg.id, error: rpcErrorFor(e instanceof CodexModsError ? e : unavailable(String(e?.message ?? e))) }));
  }

  function answerLeaseInitialize(client, msg) {
    client.optOut = optOutsOf(msg.params);   // answered from the session's handshake, so its opt-outs apply on delivery only
    const fail = () => writeConn(client, { id: msg.id, error: rpcErrorFor(unavailable('app-server handshake is not complete')) });
    const go = () => {
      const S = oldestSession();
      if (!S) return fail();
      S.hs.initResult.wait((result) => writeConn(client, { id: msg.id, result }), fail, tune.handshakeWaitMs);
    };
    if (oldestSession()) return go();
    const w = { go, fail, t: null };
    w.t = setTimeout(() => { aliasWaiters.splice(aliasWaiters.indexOf(w), 1); fail(); }, tune.handshakeWaitMs);
    w.t.unref?.();
    aliasWaiters.push(w);
  }

  // ------------------------------------------------------------------ backend -> client pipeline
  function onBackendMessage(b, gen, msg, size) {
    if (typeof msg.method === 'string') {
      const isReq = hasId(msg);
      frames[isReq ? 'serverRequest' : 'serverNotification']++;
      b.q.items.push({ msg, isReq, gen, size });
      b.q.bytes += size;
      // Bounded queue: stop reading the backend's stdout (pipe backpressure) until the queue drains below half.
      if (!b.q.paused && (b.q.items.length >= tune.queueMaxItems || b.q.bytes >= tune.queueMaxBytes)) {
        b.q.paused = true;
        b.proc?.stdout?.pause();
        log.warn('server queue is full; pausing the backend stream', { backend: b.id, items: b.q.items.length });
      }
      return pump(b);
    }
    if (isResponseShape(msg)) { frames.serverResponse++; return handleServerResponse(b, msg); }
    log.warn('malformed backend frame dropped', { backend: b.id });
  }

  function pump(b) {
    const q = b.q;
    if (q.busy) return;
    while (q.items.length) {
      const item = q.items.shift();
      q.bytes -= item.size;
      if (q.paused && q.items.length < tune.queueMaxItems / 2 && q.bytes < tune.queueMaxBytes / 2) { q.paused = false; b.proc?.stdout?.resume(); }
      let finished = false, sync = true;
      q.busy = true;
      try {
        processServerInitiated(b, item, () => { finished = true; q.busy = false; if (!sync) pump(b); });
      } catch (e) { internalError(e); finished = true; q.busy = false; }
      sync = false;
      if (!finished) return;
    }
  }

  /** The logical client for a server-initiated message: the key's live owner, else the backend's own app session, else the oldest. */
  function ownerFor(key, b) {
    const e = key === undefined ? undefined : aff.get(key);
    const c = e?.client ? clients.get(e.client) : undefined;
    if (c && c.alive) return c;
    if (b.session && !b.session.gone) return b.session.client;
    return oldestSession()?.client ?? NO_CLIENT;
  }
  /** Mux addition 11: who answers a thread's server requests. The app session when it is subscribed (the user can answer there), else the
   *  first subscriber with a connection, else the key's owner or the app session (ownerFor). */
  function answererFor(key, b) {
    const sk = key === undefined ? undefined : subKey(b.id, key);
    if (sk !== undefined && subs.size(sk)) {
      const app = b.session && !b.session.gone ? b.session.client : null;
      if (app && subs.has(sk, app.id)) return app;
      for (const id of subs.clientsOf(sk)) { const c = clients.get(id); if (c?.alive && c.conn) return c; }
    }
    return ownerFor(key, b);
  }
  /** A thread's notifications go to every subscribed client with a connection on that backend (in-process clients read through
   *  observe()). With none, they go to the answerer, as before addition 11: the key's owner, else the app session. */
  function recipientsFor(key, b, owner) {
    const sk = key === undefined ? undefined : subKey(b.id, key);
    const out = [];
    if (sk !== undefined) for (const id of subs.clientsOf(sk)) { const c = clients.get(id); if (c?.alive && c.conn) out.push(c); }
    return out.length ? out : [owner];
  }
  /** Stand-in when no app session is connected: it has no connection, so server requests are refused and notifications dropped. */
  const NO_CLIENT = makeClient('app:none', 'app', { origin: 'app', alive: false });

  function processServerInitiated(b, item, done) {
    const { msg, isReq, gen } = item;
    const kind = isReq ? 'serverRequest' : 'serverNotification';
    const key = extractKey(msg, keyPaths);
    if (!atHome(key, b)) {
      // the key moved to another backend (RM10): what its old home still says of it is nobody's (a request is refused)
      if (isReq && b.gen === gen && canWrite(b)) writeBackend(b, { id: msg.id, error: rpcError(-32000, 'the thread runs on another backend') });
      return done();
    }
    if (!isReq && msg.method === STARTED && isFramework(b)) {
      // a thread a framework backend started on its own (a sub-agent's): it lives there (an ephemeral one is routed, never kept)
      const id = msg.params?.thread?.id;
      if (typeof id === 'string' && id && !placed.has(id) && !aff.peek(id)) { aff.repin(id, b.id); if (msg.params.thread.ephemeral !== true) notePlaced(id, b.id); }
    }
    if (frameworkOnly(b.id, key, msg.method, kind)) {
      // a framework backend's own traffic (its account's): framework clients observe and intercept it; the app and mods never see it,
      // and a request of it is answered with an error, never by the app
      const fwRegs = frameworkRegs(registry.lookup(kind, msg.method));
      const end = (res) => {
        try {
          if (b.gen !== gen) return;
          if (res.type !== 'drop' && res.type !== 'reject' && res.type !== 'respond') observe({ kind, method: msg.method, origin: 'app:none', backendId: b.id }, res.msg ?? msg);
          if (isReq && canWrite(b)) writeBackend(b, res.type === 'respond' ? rpcResponse(msg.id, res.respond) : { id: msg.id, error: rpcError(-32000, 'no client answers this backend\'s requests') });
        } finally { done(); }
      };
      if (fwRegs.length === 0) return end({ type: 'pass', msg });
      return chain({
        regs: fwRegs, msg, kind, skipClient: null,
        infoFor: (reg) => Object.freeze({ kind, method: msg.method, origin: 'app:none', backend: displayBackend(b.id, reg.client.id) }),
        done: end,
      });
    }
    const startedBy = noteHiddenStart(msg);
    const privateTo = startedBy ?? (key !== undefined ? hidden.get(key) : undefined);
    const privateClient = privateTo !== undefined ? clients.get(privateTo) : undefined;
    const owner = privateTo !== undefined ? (privateClient?.alive ? privateClient : NO_CLIENT) : answererFor(key, b);
    let out = msg, sid = null;
    if (isReq) {
      sid = 's:' + (++sidSeq);
      out = { ...msg, id: sid };
      srvPending.set(sid, { backend: b, gen, origId: msg.id, owner: owner.id, method: msg.method, key });
    }
    const stale = () => b.gen !== gen;
    if (!isReq && msg.method === 'serverRequest/resolved') {
      // Mux addition 10: interceptors, observers and the client see the id the client was given, not the backend's. The pending
      // entry goes, so the client's late answer is dropped quietly. A deferred request's token is closed (on the backend id).
      const resolvedSid = sidForResolved(b, gen, msg.params);
      cancelResolved(b, gen, msg.params);
      if (resolvedSid) out = { ...msg, params: { ...msg.params, requestId: resolvedSid } };
    }
    const answer = (r) => {
      const entry = srvPending.get(sid);
      if (!entry) return;
      srvPending.delete(sid);
      if (stale() || !canWrite(b)) return;
      writeBackend(b, rpcResponse(entry.origId, r));
    };
    const refuse = (message) => answer({ error: rpcError(-32000, message) });
    const finish = (res) => {
      try {
        if (stale()) { if (sid) srvPending.delete(sid); return; }
        if (res.type === 'drop') return;
        if (res.type === 'reject') { if (isReq) answer({ error: rpcError(-32001, 'rejected by an interceptor', { interceptor: res.by }) }); return; }
        if (res.type === 'respond') { if (isReq) answer(res.respond); return; }
        if (res.type === 'defer') {
          // Out of the stream at once: `done()` runs in the finally below, so the next frame is processed immediately.
          if (deferRequest(b, gen, owner, sid, msg, res, key)) return;
          res = { type: 'pass', msg: res.msg };   // could not defer (the owner mod is gone, or listens for nothing): deliver normally
        }
        const m = res.msg;
        observe({ kind, method: msg.method, origin: owner.origin, backendId: b.id, affinityKey: key }, m);
        if (isReq) {
          if (owner.conn) { if (!writeConn(owner, m)) refuse('client connection is closed'); }
          else refuse('no client is available to answer');
        } else if (privateTo !== undefined) {
          if (owner.conn) writeConn(owner, m);   // a private thread's notifications reach its own client only
          if (msg.method === 'thread/closed' && key !== undefined) hidden.delete(key);   // closed: it is gone from its backend
        } else {
          for (const c of recipientsFor(key, b, owner)) if (!c.optOut?.has(msg.method)) writeConn(c, m);
        }
      } finally { done(); }
    };
    const regs = regsFor(registry.lookup(kind, msg.method), privateTo);
    if (regs.length === 0) return finish({ type: 'pass', msg: out });
    chain({
      regs, msg: out, kind, skipClient: null,
      infoFor: (reg) => Object.freeze({ kind, method: msg.method, origin: owner.origin, backend: displayBackend(b.id, reg.client.id), ...(key === undefined ? {} : { affinityKey: key }), ...withSession(b.id) }),
      done: finish,
    });
  }

  // ------------------------------------------------------------------ deferred requests (gate G-defer; client requests: mux addition 5)
  // An interceptor may return {defer: true} for a serverRequest. The request then leaves the stream (the pump moves on at once),
  // the mux holds it under an unguessable token bound to {owner mod, app session (owner client), backend + generation, request id},
  // and the mod settles it later: respond (first answer wins, truthful outcome), release (to the app's native UI) or by the
  // request ending (Stop / serverRequest/resolved / backend or app or mod going away). A token closes exactly once.
  // A clientRequest interceptor may return {defer: true} too (see "deferred client requests" below); its tokens live in the same maps.
  const TOMB_REASON = { answered: 'alreadyAnswered', released: 'released' };

  function deferRequest(b, gen, owner, sid, orig, res, key) {
    const client = res.reg.client;
    srvPending.delete(sid);   // while deferred the app has never seen this id: a response carrying it is unknown
    if (client.disposed || client.deferListeners.size === 0) {
      if (!client.disposed) log.warn('defer ignored: the mod has no onDeferred listener, so it could never learn the token', { client: client.id });
      srvPending.set(sid, { backend: b, gen, origId: orig.id, owner: owner.id, method: orig.method, key });
      return false;
    }
    const token = 'dfr_' + randomBytes(16).toString('hex');
    const info = Object.freeze({ kind: 'serverRequest', method: orig.method, origin: owner.origin, backend: displayBackend(b.id, client.id), ...(key === undefined ? {} : { affinityKey: key }), ...withSession(b.id) });
    const d = { kind: 'serverRequest', token, modId: client.id, client, owner, backend: b, gen, sid, origId: orig.id, method: orig.method, key, turnId: res.msg.params?.turnId, msg: res.msg, info, state: 'pending', closed: false };
    deferred.set(token, d); b.deferred.add(d);
    for (const fn of [...client.deferListeners]) { try { fn({ token, message: d.msg, info }); } catch (e) { internalError(e); } }
    return true;
  }

  /** Free a token exactly once. `notify` is the onResolved reason for the owner mod (or null when the owner itself caused it). */
  function closeDeferred(d, tomb, notify) {
    if (d.closed) return;
    d.closed = true;
    deferred.delete(d.token);
    if (d.kind === 'clientRequest') { clearTimeout(d.timer); if (d.req.hold === d) d.req.hold = null; }
    else d.backend.deferred.delete(d);
    tombstones.set(d.token, { modId: d.modId, reason: tomb });
    while (tombstones.size > tune.maxTombstones) tombstones.delete(tombstones.keys().next().value);
    if (notify) for (const fn of [...d.client.resolveListeners]) { try { fn(d.token, notify); } catch (e) { internalError(e); } }
    if (d.kind !== 'clientRequest' && d.backend.deferred.size === 0) armIdle(d.backend);   // the backend may idle out again
  }

  /** The request ended or its peer vanished. A write in flight (`answering`) decides its own outcome, so it is left alone. */
  function cancelDeferred(d, reason, errorToBackend, notify = reason) {
    if (d.closed || d.state !== 'pending') return;
    if (errorToBackend && d.backend.gen === d.gen && canWrite(d.backend)) writeBackend(d.backend, { id: d.origId, error: rpcError(-32000, errorToBackend) });
    closeDeferred(d, reason, notify);
  }

  const sameRequestId = (a, b) => a === b || (a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b));
  /** The client-facing id (`s:<n>`) of the request a `serverRequest/resolved` names, or null. Ends its pending entry. */
  function sidForResolved(b, gen, params) {
    if (!isObject(params) || !('requestId' in params)) return null;
    for (const [sid, e] of srvPending) {
      if (e.backend !== b || e.gen !== gen || !sameRequestId(e.origId, params.requestId)) continue;
      srvPending.delete(sid);
      resolvedSids.set(sid, e.owner); bounded(resolvedSids);
      return sid;
    }
    for (const [sid, e] of answeredSids) {
      if (e.backend === b && e.gen === gen && sameRequestId(e.origId, params.requestId)) { answeredSids.delete(sid); return sid; }
    }
    for (const d of b.deferred) if (d.gen === gen && sameRequestId(d.origId, params.requestId)) return d.sid;
    return null;
  }
  /** `serverRequest/resolved {threadId, requestId}`: the backend's own word that the request is over. */
  function cancelResolved(b, gen, params) {
    if (b.gen !== gen || b.deferred.size === 0 || !isObject(params)) return;
    for (const d of [...b.deferred]) if (d.gen === gen && sameRequestId(d.origId, params.requestId)) cancelDeferred(d, 'cancelled');
  }
  /** A successful `turn/interrupt` (Stop) ends every question of that turn. The backend also sends serverRequest/resolved; this is the eager path. */
  function cancelInterrupted(b, key, turnId) {
    if (key === undefined) return;
    for (const d of [...b.deferred]) if (d.key === key && (turnId === undefined || d.turnId === undefined || d.turnId === turnId)) cancelDeferred(d, 'cancelled');
  }

  /** Deliver a deferred request to the owner client's connection (the app's native UI). Closes the token. */
  function forwardDeferred(d, notify) {
    const b = d.backend, o = d.owner;
    if (b.gen !== d.gen || !canWrite(b)) { closeDeferred(d, 'backendGone', notify ?? 'backendGone'); return { released: false, reason: 'backendGone' }; }
    if (!o.alive || !o.conn) { cancelDeferred(d, 'appGone', 'client disconnected', notify ?? 'appGone'); return { released: false, reason: 'appGone' }; }
    srvPending.set(d.sid, { backend: b, gen: d.gen, origId: d.origId, owner: o.id, method: d.method, key: d.key });
    observe({ kind: 'serverRequest', method: d.method, origin: o.origin, backendId: b.id, affinityKey: d.key }, d.msg);
    if (!writeConn(o, d.msg)) {
      srvPending.delete(d.sid);
      cancelDeferred(d, 'appGone', 'client connection is closed', notify ?? 'appGone');
      return { released: false, reason: 'appGone' };
    }
    closeDeferred(d, 'released', notify ?? null);
    return { released: true };
  }

  function lookupDeferred(c, token) {
    if (typeof token !== 'string' || !token) throw new CodexModsError('Invalid', 'token must be a non-empty string');
    const d = deferred.get(token);
    if (d && d.modId === c.id) return { d };
    const t = tombstones.get(token);
    return { reason: t && t.modId === c.id ? (TOMB_REASON[t.reason] ?? t.reason) : 'unknownToken' };
  }

  function checkAnswer(a) {
    if (!isObject(a) || Object.keys(a).length !== 1) throw new CodexModsError('Invalid', 'an answer is {result} or {error}');
    if ('result' in a) { if (a.result === undefined) throw new CodexModsError('Invalid', 'result must be JSON'); }
    else if (!('error' in a) || !isObject(a.error) || typeof a.error.code !== 'number' || typeof a.error.message !== 'string') throw new CodexModsError('Invalid', 'an answer is {result} or {error: {code, message}}');
    try { JSON.stringify(a); } catch { throw new CodexModsError('Invalid', 'the answer is not JSON'); }
  }

  /** Write one line and wait for the stream's acknowledgement: 'delivered' (flushed to the pipe), 'notDelivered' (nothing was
   *  queued) or 'uncertain' (a write error or no acknowledgement: bytes may or may not have reached the backend). */
  function writeBackendAcked(b, obj) {
    return new Promise((resolve) => {
      if (!canWrite(b)) return resolve('notDelivered');
      let done = false, timer;
      const settle2 = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      timer = setTimeout(() => settle2('uncertain'), tune.writeAckMs);
      timer.unref?.();
      b.lastActivity = Date.now();
      try { b.proc.stdin.write(JSON.stringify(obj) + '\n', (err) => settle2(err ? 'uncertain' : 'delivered')); }
      catch (e) { log.warn('backend write failed', { backend: b.id, message: String(e?.message ?? e) }); settle2('notDelivered'); }
    });
  }

  async function respondDeferred(c, token, answer) {
    checkAnswer(answer);
    const { d, reason } = lookupDeferred(c, token);
    if (!d) return { outcome: 'notDelivered', reason };
    if (d.kind === 'clientRequest') return respondHeld(d, answer);
    if (d.state !== 'pending') return { outcome: 'notDelivered', reason: 'alreadyAnswered' };   // first answer wins, also while its write is in flight
    const b = d.backend;
    if (b.gen !== d.gen) { cancelDeferred(d, 'backendGone'); return { outcome: 'notDelivered', reason: 'backendGone' }; }
    d.state = 'answering';
    const outcome = await writeBackendAcked(b, rpcResponse(d.origId, answer));
    if (outcome === 'notDelivered') {
      d.state = 'pending';   // nothing was queued, so the question is still open (the backend exit, if any, closes it)
      return { outcome, reason: canWrite(b) ? 'writeFailed' : 'backendUnavailable' };
    }
    // Delivered or uncertain: the answer is consumed either way. An uncertain answer is never sent again (AGENTS.md).
    closeDeferred(d, 'answered', 'answered');
    if (outcome === 'delivered') {
      c.transmitted = true;
      observe({ kind: 'clientResponse', method: d.method, origin: c.origin, backendId: b.id, affinityKey: d.key }, { id: d.sid, ...answer });
      return { outcome };
    }
    return { outcome, reason: 'writeNotConfirmed' };
  }

  /** `opts.params` applies to a deferred client request only. Returns the held message's replacement params, or undefined. */
  function checkReleaseOpts(opts) {
    if (opts === undefined || opts === null) return undefined;
    if (!isObject(opts)) throw new CodexModsError('Invalid', 'release options are an object');
    return opts.params;
  }

  /** Settle a token by giving the request back: a server request goes to the app's native UI ({released}), a client request is sent on
   *  through the rest of its pipeline and the result is the response its client got (see releaseHeld). */
  async function releaseDeferred(c, token, opts) {
    const params = checkReleaseOpts(opts);
    const { d, reason } = lookupDeferred(c, token);
    if (!d) return { released: false, reason };
    if (d.kind === 'clientRequest') return releaseHeld(d, params);
    if (params !== undefined) throw new CodexModsError('Invalid', 'params can change a deferred client request only');
    if (d.state !== 'pending') return { released: false, reason: 'alreadyAnswered' };
    return forwardDeferred(d, null);
  }

  // ------------------------------------------------------------------ deferred client requests (mux addition 5)
  // A clientRequest interceptor may return {defer: true}. The request leaves its interceptor chain (nothing else waits on it, and its
  // client's other requests keep flowing) and is held under a token, like a deferred server request, until its holder settles it:
  //   release(token, {params?})  sends it on through the rest of the pipeline exactly as if the chain had passed it (route, intent claim,
  //                              transmission, response interceptors), optionally with other params; resolves with the response the client got;
  //   respond(token, answer)     answers the client without the backend;
  // or the hold ends: the client goes away ('appGone'), the mux closes ('muxClosed'), the request itself ends ('cancelled': a mod
  // requester's timeout) or tune.maxClientHoldMs passes ('expired', released unchanged). Disposing the holder releases its holds unchanged.
  // The mux orders nothing per object; the graph runtime orders its own holds.

  /** Hold a deferred client request. False when no hold can be made (the holder is disposed, or registered no onDeferred listener). */
  function holdRequest(req, res) {
    const holder = res.reg.client;
    if (holder.disposed || holder.deferListeners.size === 0) {
      if (!holder.disposed) log.warn('defer ignored: the mod has no onDeferred listener, so it could never learn the token', { client: holder.id });
      return false;
    }
    const token = 'dfr_' + randomBytes(16).toString('hex');
    const d = { kind: 'clientRequest', token, modId: holder.id, client: holder, req, msg: res.msg, route: res.route, info: res.info, state: 'pending', closed: false, timer: null };
    d.timer = setTimeout(() => expireHeld(d), tune.maxClientHoldMs);
    d.timer.unref?.();
    req.hold = d;
    deferred.set(token, d);
    for (const fn of [...holder.deferListeners]) { try { fn({ token, message: d.msg, info: d.info }); } catch (e) { internalError(e); } }
    return true;
  }

  /** The hold ended without its holder (the client or the mux went away, or the request ended): the token closes, `notify` tells the holder. */
  function cancelHeld(d, reason, notify = reason) {
    if (d.closed || d.state !== 'pending') return;
    closeDeferred(d, reason, notify);
  }

  /** Send a held request on through the rest of the pipeline as if the chain had passed it (its token is already closed). */
  function continueHeld(d, msg) {
    const req = d.req;
    try { afterRequest(req, { type: 'pass', msg, route: d.route }); }
    catch (e) { internalError(e); settle(req, { fail: unavailable('internal error') }); }
  }

  /** The safety bound passed: the request goes on unchanged and its holder is told. */
  function expireHeld(d) {
    if (d.closed || d.state !== 'pending') return;
    log.warn('a deferred client request was not settled in time; releasing it unchanged', { client: d.client.id, method: d.msg.method });
    closeDeferred(d, 'expired', 'expired');
    continueHeld(d, d.msg);
  }

  /** The holder was disposed: its held requests go on unchanged, as if never held. It is not told. */
  function releaseHeldUnchanged(d) {
    if (d.closed || d.state !== 'pending') return;
    closeDeferred(d, 'released', null);
    continueHeld(d, d.msg);
  }

  /** `params` (when given) replace the held request's params; invalid ones throw before the token is touched. */
  function releaseHeld(d, params) {
    if (d.state !== 'pending') return { released: false, reason: 'alreadyAnswered' };
    let msg = d.msg;
    if (params !== undefined) {
      let copy;
      try { copy = JSON.parse(JSON.stringify(params)); } catch { throw new CodexModsError('Invalid', 'params are not JSON'); }
      if (copy === undefined) throw new CodexModsError('Invalid', 'params are not JSON');
      const repl = { ...d.msg, params: copy };
      const bad = validateReplace('clientRequest', d.msg, repl);
      if (bad) throw new CodexModsError('Invalid', bad);
      msg = deepFreeze(repl);
    }
    const req = d.req;
    if (req.done) { cancelHeld(d, 'appGone'); return { released: false, reason: 'appGone' }; }   // defensive: a hold does not outlive its request
    return new Promise((resolve) => {
      req.onEnd = (outcome, delivered) => {
        if (!outcome || !delivered) return resolve({ released: false, reason: 'appGone', ...(req.stage === 'sent' ? { sent: true } : {}) });
        const r = outcome.response ?? { error: rpcErrorFor(outcome.fail) };
        resolve({ released: true, response: 'error' in r ? { error: r.error } : { result: r.result ?? null } });
      };
      closeDeferred(d, 'released', null);
      continueHeld(d, msg);
    });
  }

  /** Answer the client directly; the backend never sees the request. */
  function respondHeld(d, answer) {
    if (d.state !== 'pending') return { outcome: 'notDelivered', reason: 'alreadyAnswered' };
    const req = d.req;
    if (req.done) { cancelHeld(d, 'appGone'); return { outcome: 'notDelivered', reason: 'appGone' }; }   // defensive: a hold does not outlive its request
    const copy = JSON.parse(JSON.stringify(answer));   // observers freeze what they see: never the caller's own object
    d.state = 'answering'; req.hold = null;
    const key = extractKey(d.msg, keyPaths);
    req.destId = destFor(req.client, req.explicit, key, d.msg.method); req.key = key;
    const delivered = settle(req, { response: rpcResponse(req.id, copy) });
    if (delivered) {
      // An answered thread/start (or another creator) subscribes its client, as a backend's answer does, on the backend its key is pinned to.
      const parts = creators.get(req.method);
      const created = parts && copy && 'result' in copy ? getPath(copy.result, parts) : undefined;
      const pinned = typeof created === 'string' && created ? aff.peek(created)?.backend : undefined;
      if (pinned && req.client.alive) subs.add(subKey(pinned, created), req.client.id);
      closeDeferred(d, 'answered', null); return { outcome: 'delivered' };
    }
    closeDeferred(d, 'appGone', null);   // the client's connection could not take it
    return { outcome: 'notDelivered', reason: 'appGone' };
  }

  function registerCreator(req, msg, b) {
    const parts = creators.get(req.method);
    if (!parts || msg.error !== undefined || !('result' in msg)) return;
    const key = getPath(msg.result, parts);
    if (typeof key !== 'string' || !key) return;
    // a thread a client with a hidden root started (or resumed, or forked) is its private one
    if (req.client.hiddenRoot && !hidden.has(key)) hidden.set(key, req.client.id);
    const e = aff.peek(key);
    const ownerAlive = e?.client ? clients.get(e.client)?.alive === true : false;
    if (e && ownerAlive) aff.set(key, { client: e.client, backend: b.id });
    else aff.set(key, { client: req.client.alive ? req.client.id : null, backend: b.id });
    // a thread created (or resumed, forked) on a framework backend lives there; one created on an app session's backend is placed back
    // there only when it was placed elsewhere
    if (msg.result?.thread?.ephemeral === true) return;   // an ephemeral thread is routed by its affinity only, never kept
    if (isFramework(b)) { if (placed.get(key) !== b.id) notePlaced(key, b.id); }
    else if (b.session && placed.has(key) && placed.get(key) !== 'primary') notePlaced(key, 'primary');
  }

  /** Mux addition 11: a successful thread/start, resume, fork or turn/start subscribes its client; a forwarded unsubscribe ends it. */
  function noteSubscription(req, msg, b) {
    if (msg.error !== undefined || !('result' in msg)) return;
    if (req.method === UNSUBSCRIBE) { if (req.key !== undefined) subs.remove(subKey(b.id, req.key), req.client.id); return; }
    if (!req.client.alive) return;
    const parts = creators.get(req.method);
    const key = parts ? getPath(msg.result, parts) : req.method === 'turn/start' ? req.key : undefined;
    if (typeof key === 'string' && key) subs.add(subKey(b.id, key), req.client.id);
  }

  function handleServerResponse(b, msg) {
    const req = pendingByMid.get(msg.id);
    if (!req || req.backend !== b) return log.debug('unmatched response dropped', { backend: b.id });
    pendingByMid.delete(msg.id);
    b.pending.delete(req);
    if (req.internal) return req.internal(msg);
    registerCreator(req, msg, b);
    noteSubscription(req, msg, b);
    if (req.method === 'turn/interrupt' && msg.error === undefined && 'result' in msg && b.deferred.size) cancelInterrupted(b, req.key, req.msg.params?.turnId);
    if (req.done) return;
    if (req.isHandshake && msg.error === undefined && 'result' in msg) req.client.session.hs.initResult.set(msg.result);
    const out = 'error' in msg ? { id: req.id, error: msg.error } : { id: req.id, result: withoutPrivate(req.method, msg.result, req.client.id) };
    const allRegs = registry.lookup('serverResponse', req.method);
    const regs = frameworkOnly(b.id, req.key, req.method, 'serverResponse') ? frameworkRegs(allRegs) : regsFor(allRegs, privateOf(req.client.origin, req.key));
    const finish = (res) => {
      if (req.done) return;
      if (res.type === 'reject') return settle(req, { response: { id: req.id, error: rpcError(-32001, 'rejected by an interceptor', { interceptor: res.by }) }, silent: true });
      const m = res.msg;
      if (m !== out) registerCreator(req, m, b);
      settle(req, { response: m });
      // A session's primary is ready once the initialize response has been delivered back to the app
      // (the stock app does not always send `initialized`; when it does, it is forwarded normally).
      if (req.isHandshake && 'result' in m && b.state === 'starting') markReady(b);
    };
    if (regs === EMPTY) return finish({ type: 'pass', msg: out });
    chain({
      regs, msg: out, kind: 'serverResponse', skipClient: req.client,
      infoFor: (reg) => Object.freeze({ kind: 'serverResponse', method: req.method, origin: req.client.origin, backend: displayBackend(b.id, reg.client.id), ...(req.key === undefined ? {} : { affinityKey: req.key }), ...withSession(b.id) }),
      done: finish,
    });
  }

  // ------------------------------------------------------------------ backends
  function newBackend(id, owner, key, def) {
    return {
      id, owner, key, def, state: 'stopped', proc: null, gen: 0, startedAt: 0, lastActivity: 0, idleTimer: null,
      waiters: [], pending: new Set(), deferred: new Set(), q: { busy: false, items: [], bytes: 0, paused: false }, framer: null, session: null,
      stopP: null, stopReason: null, exitWaiters: [], killTimer: null, starting: false, removed: false,
    };
  }
  const canWrite = (b) => !!b.proc && !b.proc.stdin.destroyed && b.proc.stdin.writable;
  function writeBackend(b, obj) {
    b.lastActivity = Date.now();
    try { b.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch (e) { log.warn('backend write failed', { backend: b.id, message: String(e?.message ?? e) }); return false; }
  }
  const topic = (b, state) => (b.session ? `appServer/${state}` : `backend/${b.id}/${state}`);
  function setState(b, state, data = {}) {
    b.state = state;
    if (state === 'starting' || state === 'ready' || state === 'exited') publish(topic(b, state), { backend: b.id, ...data });
  }

  /** Run `ok` when the backend has finished its handshake (or, for handshake frames, once its process exists). */
  function whenReady(b, bypass, ok, fail) {
    if (closed) return fail(unavailable('the mux is closed'));
    if (b.state === 'ready' || (bypass && b.proc)) return ok();
    if (bypass) return fail(unavailable('backend is not running'));
    if (!b.session && !b.proc && !b.starting) startNamed(b);
    const w = { ok, fail, t: null };
    w.t = setTimeout(() => { b.waiters = b.waiters.filter((x) => x !== w); fail(unavailable('backend handshake did not complete in time')); }, tune.handshakeWaitMs);
    w.t.unref?.();
    b.waiters.push(w);
  }
  function flushWaiters(b) { const ws = b.waiters; b.waiters = []; for (const w of ws) { clearTimeout(w.t); try { w.ok(); } catch (e) { internalError(e); } } }
  function failWaiters(b, err) { const ws = b.waiters; b.waiters = []; for (const w of ws) { clearTimeout(w.t); try { w.fail(err); } catch (e) { internalError(e); } } }

  function armIdle(b) {
    if (b.session || b.idleTimer || !b.proc) return;
    if (b.def && b.def.idleStopMs === null) return;   // a backend that runs until it is removed (an added account's)
    const idle = b.def?.idleStopMs ?? 600_000;
    const arm = (ms) => {
      b.idleTimer = setTimeout(() => {
        b.idleTimer = null;
        if (!b.proc || closed) return;
        if (b.deferred.size > 0) return;   // an open deferred question keeps the backend alive; closeDeferred re-arms the timer
        const left = idle - (Date.now() - b.lastActivity);
        if (b.pending.size === 0 && left <= 0) { stopBackend(b, 'idle'); return; }
        arm(Math.max(left, 25));
      }, ms);
      b.idleTimer.unref?.();
    };
    arm(idle);
  }

  function markReady(b) {
    b.starting = false;
    if (b.state === 'ready') return;
    setState(b, 'ready');
    flushWaiters(b);
    armIdle(b);
  }

  function spawnProc(b) {
    // A framework backend runs the user's own work, as the app's primary does: from the app's environment (its oldest session's) and with
    // the primary's per-process config.
    const fw = isFramework(b);
    const appEnv = fw ? oldestSession()?.env : undefined;
    const launch = b.session
      ? launchFor('primary', undefined, b.session.env ? { argv: b.session.argv, env: b.session.env } : { argv: b.session.argv })
      : launchFor(b.id, b.def, { argv: oldestSession()?.argv ?? DEFAULT_ARGV, ...(appEnv ? { env: appEnv } : {}) });
    const gen = ++b.gen;
    b.startedAt = Date.now(); b.lastActivity = Date.now();
    // A session primary whose relay sent the app's environment (header v2, mux addition 9) starts from it, as the app would have
    // launched it; so does a framework backend; every other backend starts from the Host's. launch.env is overlaid on either.
    const env = { ...(b.session?.env ?? appEnv ?? process.env), ...(launch.env ?? {}), CODEX_HOME: launch.codexHome };
    // AdapterPack.backend.configOverrides apply to the app's primary backends and framework backends only (mods' backends are untouched).
    // An unknown ${variable} throws here and the spawn is refused.
    // A framework backend's own `config` (its definition's) comes after the primary's, so it wins.
    const cfg = [
      ...((b.session || fw) && opts.primaryConfig ? buildConfigOverrideArgs(opts.primaryConfig.overrides, opts.primaryConfig.vars ?? {}) : []),
      ...(fw && b.def?.config ? buildConfigOverrideArgs(b.def.config, {}) : []),
    ];
    const args = withConfigArgs(launch.args, cfg);
    const proc = spawn(launch.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    b.proc = proc;
    b.q = { busy: false, items: [], bytes: 0, paused: false };
    const framer = createFramer({
      maxBytes: tune.maxBackendFrameBytes,
      onFrame: (line) => {
        if (b.proc !== proc) return;
        b.lastActivity = Date.now();
        let msg;
        try { msg = JSON.parse(line); } catch { return log.warn('unparseable frame from backend dropped', { backend: b.id, bytes: line.length }); }
        if (!isObject(msg)) return log.warn('non-object frame from backend dropped', { backend: b.id });
        try { onBackendMessage(b, gen, msg, line.length); } catch (e) { internalError(e); }
      },
      onOverflow: () => { log.error('backend frame exceeds the size limit; stopping backend', { backend: b.id }); killProc(proc); },
    });
    b.framer = framer;
    proc.stdout?.on('data', (c) => framer.push(c));
    proc.stderr?.on('data', (c) => log.debug('backend stderr', { backend: b.id, bytes: c.length }));
    proc.stdin?.on('error', (e) => log.warn('backend stdin error', { backend: b.id, message: String(e?.message ?? e) }));
    let finalized = false, exitTimer = null;
    const fin = (code, signal, err) => {
      if (finalized) return; finalized = true; clearTimeout(exitTimer);
      onProcExit(b, proc, gen, code, signal, err);
    };
    proc.on('error', (err) => { log.error('backend process error', { backend: b.id, message: String(err?.message ?? err) }); if (proc.pid === undefined) fin(null, null, err); });
    proc.on('exit', (code, signal) => { exitTimer = setTimeout(() => fin(code, signal), 250); exitTimer.unref?.(); });
    proc.on('close', (code, signal) => fin(code, signal));
    return proc;
  }
  const killProc = (proc) => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };

  function onProcExit(b, proc, gen, code, signal, err) {
    if (b.proc !== proc) return;
    b.proc = null; b.framer = null;
    clearTimeout(b.idleTimer); b.idleTimer = null;
    clearTimeout(b.killTimer); b.killTimer = null;
    const deliberate = b.stopReason !== null;
    const reason = b.stopReason ?? 'crash';
    b.stopReason = null; b.stopP = null; b.starting = false;
    b.q = { busy: false, items: [], bytes: 0, paused: false };
    for (const [sid, e] of srvPending) if (e.backend === b) srvPending.delete(sid);
    for (const [sid, e] of answeredSids) if (e.backend === b) answeredSids.delete(sid);
    subs.dropKeys((sk) => sk.startsWith(`${b.id}\n`));   // a restarted backend holds no subscriptions
    keyTable.dropBackend(b.id);
    for (const d of [...b.deferred]) cancelDeferred(d, 'backendGone');   // the backend no longer waits for these answers
    for (const req of [...b.pending]) {
      b.pending.delete(req);
      if (req.mid) pendingByMid.delete(req.mid);
      if (req.internal) req.internal(null);
      else settle(req, { fail: outcomeUnknown('the app-server exited before replying') });
    }
    setState(b, deliberate ? 'stopped' : 'exited', { code, signal, reason });
    if (deliberate) publish(topic(b, 'exited'), { backend: b.id, code, signal, reason });
    if (!b.session || closed || b.session.gone) failWaiters(b, unavailable('the app-server exited'));
    const ws = b.exitWaiters; b.exitWaiters = []; for (const f of ws) f();
    log.info('backend exited', { backend: b.id, code, signal, reason, error: err ? String(err.message) : undefined });
    if (b.session && !deliberate && !closed && !b.session.gone) scheduleRestart(b.session);
  }

  function stopBackend(b, reason) {
    if (!b.proc) return Promise.resolve();
    if (b.stopP) return b.stopP;
    const proc = b.proc;
    b.stopReason = reason;
    b.stopP = new Promise((res) => b.exitWaiters.push(res));
    b.killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, tune.killGraceMs);
    b.killTimer.unref?.();
    killProc(proc);
    return b.stopP;
  }

  /** Replay the app's handshake to a freshly started backend. Resolves with the initialize result. */
  function replayHandshake(b, params, initializedMsg) {
    return new Promise((resolve, reject) => {
      const mid = 'm:' + (++midSeq);
      const t = setTimeout(() => { pendingByMid.delete(mid); b.pending.delete(entry); reject(new Error('handshake replay timed out')); }, tune.handshakeWaitMs);
      t.unref?.();
      const entry = {
        mid, backend: b, internal: (msg) => {
          clearTimeout(t);
          if (!msg) return reject(new Error('backend exited during handshake'));
          if ('error' in msg) return reject(new Error(msg.error?.message ?? 'handshake rejected'));
          if (!canWrite(b)) return reject(new Error('backend is not writable'));
          if (initializedMsg) writeBackend(b, initializedMsg);   // only if the app sent one
          resolve(msg.result);
        },
      };
      pendingByMid.set(mid, entry); b.pending.add(entry);
      if (!canWrite(b)) { clearTimeout(t); pendingByMid.delete(mid); b.pending.delete(entry); return reject(new Error('backend is not writable')); }
      writeBackend(b, params === undefined ? { id: mid, method: HS_REQ } : { id: mid, method: HS_REQ, params });
    });
  }

  function startNamed(b) {
    if (closed || b.proc || b.starting || b.removed) return;
    b.starting = true;
    setState(b, 'starting');
    let proc;
    try { proc = spawnProc(b); } catch (e) { return failStart(b, e); }
    const gen = b.gen;
    waitHandshake((hsp) => {
      if (b.gen !== gen || b.proc !== proc) return;
      replayHandshake(b, hsp.params, hsp.initializedMsg).then(() => { if (b.gen === gen && b.proc === proc) { b.starting = false; markReady(b); } }, (e) => { if (b.gen === gen && b.proc === proc) failStart(b, e); });
    }, () => { if (b.gen === gen && b.proc === proc) failStart(b, new Error('the app has not completed its handshake')); }, tune.handshakeWaitMs);
  }

  function failStart(b, e) {
    if (closed) return;
    log.error('backend failed to start', { backend: b.id, message: String(e?.message ?? e) });
    b.starting = false;
    if (b.proc) { stopBackend(b, 'failed'); failWaiters(b, unavailable(`backend failed to start: ${e?.message ?? e}`)); return; }
    setState(b, 'exited', { reason: 'launch-failed' });
    failWaiters(b, unavailable(`backend failed to start: ${e?.message ?? e}`));
  }

  // ---- app sessions: each app connection has its own primary backend, handshake cache, boot ring and id namespace
  function setHandshakeParams(S, params) {
    S.hs.params.set(params);
    for (const w of hsWaiters.splice(0)) { clearTimeout(w.t); w.ok(pickHandshake()); }
  }
  /** The oldest live session's recorded handshake (what named backends and restarts replay). */
  function pickHandshake() {
    for (const S of sessions.values()) if (!S.gone && S.hs.params.isSet) return { params: S.hs.params.value.params, initializedMsg: S.hs.initializedMsg };
    return undefined;
  }
  function waitHandshake(ok, fail, ms) {
    const hit = pickHandshake();
    if (hit) return ok(hit);
    const w = { ok: () => { const h2 = pickHandshake(); if (h2) ok(h2); else fail(); }, t: null };
    w.t = setTimeout(() => { hsWaiters.splice(hsWaiters.indexOf(w), 1); fail(); }, ms);
    w.t.unref?.();
    hsWaiters.push(w);
  }

  async function startPrimary(S, { restart }) {
    const b = S.primary;
    if (closed || S.gone || b.proc || b.starting) return false;
    b.starting = true;
    let conflict;
    try { conflict = beforePrimaryStart ? await beforePrimaryStart() : false; }
    catch (e) { log.error('beforePrimaryStart failed; refusing the app connection', { message: String(e?.message ?? e) }); conflict = true; }
    b.starting = false;
    if (closed || S.gone) return false;
    if (conflict) {
      log.error('app connection refused: beforePrimaryStart reported a conflict (stock app guard)', { restart, session: S.n });
      S.conn.stream.destroy();
      return false;
    }
    b.starting = true;
    setState(b, 'starting', { restart });
    const params = S.hs.params.isSet ? S.hs.params.value : null;
    try { spawnProc(b); } catch (e) {
      log.error('primary failed to start', { message: String(e?.message ?? e), session: S.n });
      b.starting = false; b.startedAt = Date.now();
      setState(b, 'exited', { reason: 'launch-failed' });
      if (restart) scheduleRestart(S); else S.conn.stream.destroy();
      return false;
    }
    flushAliasWaiters();
    if (restart && params) {
      const proc = b.proc, gen = b.gen;
      replayHandshake(b, params.params, S.hs.initializedMsg).then((result) => {
        if (b.proc !== proc || b.gen !== gen) return;
        S.hs.initResult.set(result); b.starting = false; markReady(b);
      }, (e) => { if (b.proc === proc) { log.error('primary handshake replay failed', { message: String(e?.message ?? e), session: S.n }); killProc(proc); } });
    }
    return true;
  }
  function scheduleRestart(S) {
    if (S.restartTimer || closed || S.gone) return;
    const wait = Math.max(0, tune.restartIntervalMs - (Date.now() - S.primary.startedAt));
    S.restartTimer = setTimeout(() => { S.restartTimer = null; startPrimary(S, { restart: true }).catch(internalError); }, wait);
    S.restartTimer.unref?.();
  }

  // ------------------------------------------------------------------ app attachment
  function refuse(stream) { stream.on('error', () => {}); stream.destroy(); }
  function attachApp(stream) {
    if (closed) { refuse(stream); return; }
    // A connection is not a session until its first line arrives: liveness probes (connect, immediate EOF) are discarded silently,
    // allocating no session number and publishing nothing.
    let buf = null;
    const quiet = () => {};
    const onPre = (chunk) => {
      buf = buf ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.indexOf(0x0a) === -1) {
        if (buf.length > tune.maxFrameBytes) { log.error('app frame exceeds the size limit; closing the connection'); stream.off('data', onPre); stream.destroy(); }
        return;
      }
      stream.off('data', onPre);
      stream.off('error', quiet);
      openSession(stream, buf);
    };
    stream.on('error', quiet);
    stream.on('data', onPre);
  }

  function openSession(stream, firstBytes) {
    if (closed) { refuse(stream); return; }
    const n = ++sessionSeq;
    const primary = newBackend(`primary:${n}`, 'app', 'primary', undefined);
    const client = makeClient(`app:${n}`, 'app', { origin: 'app' });
    const S = {
      n, client, primary, conn: { stream }, gone: false, started: false, restartTimer: null, argv: DEFAULT_ARGV, env: undefined, pre: null, argvDecided: false,
      hs: { params: mkLatch(), initResult: mkLatch(), initializedMsg: undefined }, ring: createRing(tune.bootRingBytes),
    };
    primary.session = S; client.session = S; client.conn = S.conn;
    sessions.set(n, S); backends.set(primary.id, primary); clients.set(client.id, client);
    const gone = () => onSessionGone(S);
    stream.on('close', gone); stream.on('end', gone);
    stream.on('error', (e) => { log.warn('app stream error', { session: n, message: String(e?.message ?? e) }); gone(); });
    log.info('app session attached', { session: n });
    flushAliasWaiters();
    // The primary is spawned on the session's first frame (after the optional relay header).
    const first = (chunk) => {
      S.pre = S.pre ? Buffer.concat([S.pre, chunk]) : chunk;
      if (!S.argvDecided) {
        // The relay's header line carries the app's argv (and, v2, its environment); it is stripped here, never forwarded, observed or logged.
        const nl = S.pre.indexOf(0x0a);
        if (nl === -1) {
          if (S.pre.length > tune.maxFrameBytes) { log.error('app frame exceeds the size limit; closing the connection', { session: n }); stream.destroy(); }
          return;
        }
        S.argvDecided = true;
        const header = parseRelayHeader(S.pre.subarray(0, nl).toString('utf8'));
        if (header) { S.argv = header.argv; S.env = header.env; S.pre = S.pre.subarray(nl + 1); }
      }
      if (S.pre.length === 0) return;   // header only: wait for the first real frame
      stream.off('data', first);
      stream.pause();
      S.started = true;
      const pre = S.pre; S.pre = null;
      startSession(S, pre).catch((e) => { internalError(e); stream.destroy(); });
    };
    stream.on('data', first);
    first(firstBytes);
  }

  async function startSession(S, firstChunk) {
    const started = await startPrimary(S, { restart: false });
    if (!started || S.gone) return;
    S.framer = createFramer({
      maxBytes: tune.maxFrameBytes,
      onFrame: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return log.warn('unparseable frame from the app dropped', { bytes: line.length }); }
        if (!isObject(msg)) return log.warn('non-object frame from the app dropped');
        try { onClientFrame(S.client, msg); } catch (e) { internalError(e); }
      },
      onOverflow: () => { log.error('app frame exceeds the size limit; closing the connection', { session: S.n }); S.conn.stream.destroy(); },
    });
    S.framer.push(firstChunk);
    S.conn.stream.on('data', (c) => S.framer.push(c));
    S.conn.stream.resume();
    flushAliasWaiters();
  }

  function connectionGone(client) {
    client.alive = false; client.conn = null;
    subs.removeClient(client.id);
    for (const n of client.notes) n.cancelled = true;
    client.notes.clear();
    for (const req of [...client.active]) { requesterGone(req); req.done = true; clearTimeout(req.timer); client.active.delete(req); }
    for (const [sid, e] of srvPending) {
      if (e.owner !== client.id) continue;
      srvPending.delete(sid);
      if (e.backend.gen === e.gen && canWrite(e.backend)) writeBackend(e.backend, { id: e.origId, error: rpcError(-32000, 'client disconnected') });
    }
    for (const d of [...deferred.values()]) if (d.kind === 'serverRequest' && d.owner === client) cancelDeferred(d, 'appGone', 'client disconnected');
  }

  function onSessionGone(S) {
    if (S.gone) return;
    S.gone = true;
    sessions.delete(S.n);
    connectionGone(S.client);
    clients.delete(S.client.id);
    clearTimeout(S.restartTimer); S.restartTimer = null;
    try { S.conn.stream.destroy(); } catch { /* closed */ }
    // Its keys become unowned (they route to the oldest live session); keys pinned to its backend move to the oldest one.
    aff.unownClient(S.client.id);
    aff.moveBackend(S.primary.id, defaultPrimary()?.id ?? null);
    stopBackend(S.primary, 'app-disconnected').then(() => { if (backends.get(S.primary.id) === S.primary) backends.delete(S.primary.id); });
    log.info('app session closed', { session: S.n });
  }

  // ------------------------------------------------------------------ leases
  function issueLease(owner, name) {
    if (typeof owner !== 'string' || !owner) throw new CodexModsError('Invalid', 'lease owner required');
    const id = newId('lease');
    const lease = { id, owner, name: String(name ?? ''), token: randomBytes(32).toString('hex'), conn: null, client: null };
    leases.set(id, lease);
    return { id, socketPath: clientsSocketPath, token: lease.token };
  }

  function revokeLease(leaseId) {
    const lease = leases.get(leaseId);
    if (!lease) return;
    leases.delete(leaseId);
    if (lease.conn) lease.conn.destroy();
    if (lease.client) leaseGone(lease, lease.client);
  }
  function leaseGone(lease, client) {
    if (lease.client !== client) return;
    lease.client = null; lease.conn = null;
    connectionGone(client);
    clients.delete(client.id);
    aff.unownClient(client.id);
  }

  function onLeaseSocket(sock) {
    if (closed) return sock.destroy();
    let lease = null, client = null;
    const authTimer = setTimeout(() => { log.warn('lease connection timed out before authenticating'); sock.destroy(); }, tune.authTimeoutMs);
    authTimer.unref?.();
    const framer = createFramer({
      maxBytes: 4096,
      onFrame: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { msg = null; }
        if (!client) {
          clearTimeout(authTimer);
          const l = isObject(msg) && typeof msg.lease === 'string' ? leases.get(msg.lease) : undefined;
          // The token must be exactly 64 lowercase hex chars; compare equal-length buffers in constant time.
          const ok = l && typeof msg.token === 'string' && TOKEN_RE.test(msg.token) && timingSafeEqual(Buffer.from(msg.token, 'hex'), Buffer.from(l.token, 'hex'));
          if (!ok) { log.warn('lease connection refused: bad lease or token'); return sock.destroy(); }
          if (l.conn) { log.error('lease connection refused: lease already connected', { lease: l.id }); return sock.destroy(); }
          lease = l;
          client = makeClient(`client:${l.id}`, 'lease', { lease: l, origin: `client:${l.id}` });
          client.conn = { stream: sock };
          l.conn = sock; l.client = client;
          clients.set(client.id, client);
          framer.maxBytes = tune.maxFrameBytes;
          sock.write('{"ok":true}\n');
          return;
        }
        if (!isObject(msg)) return log.warn('unparseable frame from a lease dropped', { client: client.id, bytes: line.length });
        try { onClientFrame(client, msg); } catch (e) { internalError(e); }
      },
      onOverflow: () => { log.error('lease frame exceeds the size limit; closing the connection', { client: client?.id }); sock.destroy(); },
    });
    // A malformed handshake must close only this connection, never escape into the Host.
    sock.on('data', (c) => { try { framer.push(c); } catch (e) { log.error('lease connection failed; closing it', { message: String(e?.message ?? e) }); sock.destroy(); } });
    sock.on('error', () => { /* 'close' follows */ });
    sock.on('close', () => { clearTimeout(authTimer); if (lease && client) leaseGone(lease, client); });
  }

  const server = net.createServer(onLeaseSocket);
  let listening = Promise.resolve();
  function listen() {
    try { fs.mkdirSync(path.dirname(clientsSocketPath), { recursive: true, mode: 0o700 }); } catch (e) { log.error('cannot create the clients socket directory', { message: String(e?.message ?? e) }); }
    return new Promise((resolve) => {
      const onError = (e) => {
        if (e.code !== 'EADDRINUSE') { log.error('clients socket failed', { message: String(e?.message ?? e) }); return resolve(); }
        const probe = net.connect(clientsSocketPath);
        probe.once('connect', () => { probe.destroy(); log.error('clients socket is in use by another process'); resolve(); });
        probe.once('error', () => {
          try { fs.unlinkSync(clientsSocketPath); } catch { /* raced */ }
          server.once('error', (e2) => { log.error('clients socket failed', { message: String(e2?.message ?? e2) }); resolve(); });
          server.listen(clientsSocketPath, () => { try { fs.chmodSync(clientsSocketPath, 0o600); } catch { /* best effort */ } resolve(); });
        });
      };
      server.once('error', onError);
      server.listen(clientsSocketPath, () => { server.off('error', onError); try { fs.chmodSync(clientsSocketPath, 0o600); } catch { /* best effort */ } resolve(); });
    });
  }
  listening = listen();

  // ------------------------------------------------------------------ mod clients (MuxClient)
  function makeModClient(id, o) {
    // `hiddenRoot`: the folder under which the threads this client starts are its private ones (the Host gives one to internal mods only)
    const hiddenRoot = typeof o.hiddenRoot === 'string' && path.isAbsolute(o.hiddenRoot) ? path.resolve(o.hiddenRoot) : null;
    const c = makeClient(id, 'mod', { rank: o.rank ?? MAX_RANK, maxInFlight: o.maxInFlight ?? 32, allowed: o.allowedMethods, hiddenRoot });
    const live = () => { if (c.disposed || closed) throw new CodexModsError('Disposed', `client ${id} is disposed`); };

    c.api = {
      get id() { return id; },
      get hasTransmitted() { return c.transmitted; },
      request(method, params, ropts) {
        return new Promise((resolve, reject) => {
          live();
          if (typeof method !== 'string' || !method) throw new CodexModsError('Invalid', 'method must be a non-empty string');
          assertAllowed(c.allowed?.request, [method], 'request');
          if (c.active.size >= c.maxInFlight) throw new CodexModsError('Busy', `more than ${c.maxInFlight} requests in flight`);
          const explicit = resolveBackendName(c, ropts?.backend);
          frames.clientRequest++;
          const msg = params === undefined ? { id: c.nextId++, method } : { id: c.nextId++, method, params };
          const req = newReq(c, msg, explicit);
          req.resolve = resolve; req.reject = reject;
          if (typeof ropts?.intent === 'string' && ropts.intent) req.intent = ropts.intent;   // the graph intent this request carries out
          req.isHandshake = false;
          const ms = ropts?.timeoutMs ?? tune.requestTimeoutMs;
          req.timer = setTimeout(() => settle(req, { fail: failStage(req, req.stage === 'sent' ? 'no reply before the timeout' : 'request was not transmitted before the timeout') }), ms);
          req.timer.unref?.();
          c.active.add(req);
          submitRequest(req);
        });
      },
      notify(method, params, ropts) {
        live();
        if (typeof method !== 'string' || !method) throw new CodexModsError('Invalid', 'method must be a non-empty string');
        assertAllowed(c.allowed?.request, [method], 'notify');
        const explicit = resolveBackendName(c, ropts?.backend);
        frames.clientNotification++;
        submitNotification(c, params === undefined ? { method } : { method, params }, explicit);
      },
      observe(filter, listener, oo) {
        live();
        if (typeof listener !== 'function') throw new CodexModsError('Invalid', 'listener must be a function');
        const methods = filter?.methods ?? '*';
        assertAllowed(c.allowed?.observe, methods, 'observe');
        const d = hub.add(c, { kinds: filter?.kinds, methods }, listener, { queue: oo?.queue, replay: oo?.replay }, bootRings);
        c.subs.add(d);
        return { dispose() { c.subs.delete(d); d.dispose(); } };
      },
      intercept(kind, methods, handler, io) {
        live();
        if (!KINDS.includes(kind)) throw new CodexModsError('Invalid', `unknown message kind '${kind}'`);
        if (methods !== '*' && (!Array.isArray(methods) || methods.length === 0 || methods.some((m) => typeof m !== 'string' || !m))) throw new CodexModsError('Invalid', 'methods must be "*" or a non-empty list of strings');
        if (typeof handler !== 'function') throw new CodexModsError('Invalid', 'handler must be a function');
        const timeoutMs = io?.timeoutMs ?? 1000;
        if (!(timeoutMs > 0 && timeoutMs <= 30_000)) throw new CodexModsError('Invalid', 'timeoutMs must be in (0, 30000]');
        const onError = io?.onError ?? 'pass';
        if (onError !== 'pass' && onError !== 'reject') throw new CodexModsError('Invalid', "onError must be 'pass' or 'reject'");
        assertAllowed(c.allowed?.intercept, methods, 'intercept');
        const reg = { client: c, kind, methods: methods === '*' ? '*' : [...methods], handler, priority: io?.priority ?? 0, timeoutMs, onError, seq: ++regSeq, disposed: false };
        registry.add(reg); c.regs.add(reg);
        return { dispose() { if (reg.disposed) return; reg.disposed = true; c.regs.delete(reg); registry.remove(reg); } };
      },
      onDeferred(fn) {
        live();
        if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'listener must be a function');
        c.deferListeners.add(fn);
        return { dispose() { c.deferListeners.delete(fn); } };
      },
      onResolved(fn) {
        live();
        if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'listener must be a function');
        c.resolveListeners.add(fn);
        return { dispose() { c.resolveListeners.delete(fn); } };
      },
      async respond(token, answer) { live(); return respondDeferred(c, token, answer); },
      async release(token, opts) { live(); return releaseDeferred(c, token, opts); },
      async dispose() { disposeClient(c); },
    };
    return c;
  }

  function disposeClient(c) {
    if (c.disposed) return;
    c.disposed = true; c.alive = false;
    // Its open deferred questions go back to the app's native UI, or are cancelled if the app is gone. The mod is told 'modDisabled'.
    // Its held client requests are sent on unchanged, as if never held (mux addition 5).
    for (const d of [...deferred.values()]) {
      if (d.client !== c || d.state !== 'pending') continue;
      if (d.kind === 'clientRequest') releaseHeldUnchanged(d); else forwardDeferred(d, 'modDisabled');
    }
    // Requests this client sent are over: a mod's hold on one closes, a release waiting for its response is told.
    for (const req of [...c.active]) requesterGone(req);
    c.deferListeners.clear(); c.resolveListeners.clear();
    for (const reg of [...c.regs]) { reg.disposed = true; registry.remove(reg); }
    c.regs.clear();
    hub.removeClient(c.id);
    subs.removeClient(c.id);
    for (const n of c.notes) n.cancelled = true;
    c.notes.clear();
    for (const req of [...c.active]) settle(req, { fail: failStage(req, 'the client was disposed') });
    aff.unownClient(c.id);
    if (clients.get(c.id) === c) clients.delete(c.id);
  }

  // ------------------------------------------------------------------ public API
  const mux = {
    attachApp,

    /** A pending server request by the id its client saw: {backendId, backend, origId, method}, or null. In-process only. */
    serverRequestOf(sid) {
      const e = srvPending.get(sid);
      return e ? Object.freeze({ backendId: e.backend.id, backend: displayBackend(e.backend.id), origId: e.origId, method: e.method }) : null;
    },
    /**
     * Answer a server request a client was given (by the id it saw), as that client would: in-process only (the native provider's approve,
     * deny and answer; breadth.md D2). Observers see it as the client's response; the client's own later answer is dropped, and the
     * backend's `serverRequest/resolved` reaches it. False when the request is not pending (answered, resolved, or its backend gone).
     */
    answerServerRequest(sid, response) {
      const entry = srvPending.get(sid);
      if (!entry || !response || typeof response !== 'object') return false;
      const b = entry.backend;
      if (b.gen !== entry.gen || !canWrite(b)) return false;
      srvPending.delete(sid);
      answeredSids.set(sid, { backend: b, gen: entry.gen, origId: entry.origId }); bounded(answeredSids);
      const m = 'error' in response ? { id: sid, error: response.error } : { id: sid, result: response.result };
      writeBackend(b, 'error' in m ? { id: entry.origId, error: m.error } : { id: entry.origId, result: m.result });
      observe({ kind: 'clientResponse', method: entry.method, origin: 'framework', backendId: b.id, affinityKey: entry.key }, m);
      return true;
    },
    /**
     * Told when a thread on a backend gains its first subscribed client or loses its last ({backend, key, open}; `backend` as observers
     * name it, 'primary' for the app's), whatever the cause: a request, an unsubscribe, a disconnection or a backend restart. In-process only.
     */
    onSubscription(fn) {
      if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'onSubscription needs a function');
      subListeners.add(fn);
      return { dispose() { subListeners.delete(fn); } };
    },
    /** Mux addition 1: what the mux knows of a key ({family, key, thread, backend, owner}), or null. */
    keyInfo(family, key) {
      if (!FAMILIES.includes(family)) throw new CodexModsError('Invalid', `unknown key family '${family}'`);
      const e = keyTable.get(family, key);
      if (!e) return null;
      const owner = e.thread ? aff.peek(e.thread)?.client ?? null : null;
      return Object.freeze({ family: e.family, key: e.key, thread: e.thread ?? null, backend: displayBackend(e.backend), owner });
    },

    client(id, o = {}) {
      if (closed) throw new CodexModsError('Disposed', 'the mux is closed');
      if (typeof id !== 'string' || !id || id === 'app' || id.startsWith('app:') || id.startsWith('client:')) throw new CodexModsError('Invalid', `invalid client id '${id}'`);
      const existing = clients.get(id);
      if (existing && existing.kind === 'mod' && !existing.disposed) {
        if (o.rank !== undefined && o.rank !== existing.rank) { existing.rank = o.rank; registry.invalidate(); }
        if (o.maxInFlight !== undefined) existing.maxInFlight = o.maxInFlight;
        if (o.allowedMethods !== undefined) existing.allowed = o.allowedMethods;
        return existing.api;
      }
      const c = makeModClient(id, o);
      clients.set(id, c);
      return c.api;
    },

    async defineBackend(owner, key, def) {
      if (closed) throw new CodexModsError('Disposed', 'the mux is closed');
      if (typeof owner !== 'string' || !(owner.startsWith('mod:') || owner === FRAMEWORK)) throw new CodexModsError('Invalid', "backend owner must be 'mod:<id>' or 'framework'");
      if (typeof key !== 'string' || !key || key === 'primary' || key.includes('\0')) throw new CodexModsError('Invalid', `invalid backend key '${key}'`);
      if (!def || typeof def.codexHome !== 'string') throw new CodexModsError('Invalid', 'backend definition needs codexHome');
      const id = `${owner}/${key}`;
      const existing = backends.get(id);
      if (existing) {
        if (JSON.stringify(existing.def) === JSON.stringify(def)) return;
        throw new CodexModsError('Conflict', `backend '${key}' is already defined differently`);
      }
      backends.set(id, newBackend(id, owner, key, { ...def }));
    },

    // ---- framework placement (RM10): what moving a thread between backends needs, by key; the framework does the move itself
    /** Hold a key: other clients' requests keyed by it wait (in order) until `release()`, then go where the key is then. One holder. */
    hold(key, holderId) {
      if (typeof key !== 'string' || !key) throw new CodexModsError('Invalid', 'key must be a non-empty string');
      if (holds.has(key)) throw new CodexModsError('Busy', `key '${key}' is held`);
      const h = { holder: holderId, queue: [] };
      holds.set(key, h);
      return {
        release() {
          if (holds.get(key) !== h) return;
          holds.delete(key);
          for (const go of h.queue.splice(0)) { try { go(); } catch (e) { internalError(e); } }
        },
      };
    },
    /** Client requests keyed by `key` sent to a backend and not answered yet (other than `exceptClientId`'s). */
    inFlight(key, exceptClientId) {
      let n = 0;
      for (const req of pendingByMid.values()) if (!req.internal && req.key === key && req.client?.id !== exceptClientId) n++;
      return n;
    },
    /** Where a key is: 'primary', a framework backend's id, or another backend's display name. */
    homeOf(key) {
      const e = aff.peek(key);
      if (!e) return placed.get(key) ?? 'primary';
      return backends.get(e.backend)?.session ? 'primary' : e.backend;
    },
    /**
     * Re-home a key on another backend (after the framework resumed its thread there, which already points the key there): its requests go
     * there, every client subscribed to it on another backend is subscribed there instead, and frames keyed by it from any other backend
     * are dropped from now on. `to` is 'primary' or a framework backend's id.
     */
    rehome(key, to) {
      const target = to === 'primary' ? defaultPrimary() : backends.get(to);
      if (!target || (to !== 'primary' && !isFramework(target))) throw unavailable(`unknown backend '${to}'`);
      aff.repin(key, target.id);
      for (const id of [...backends.keys()]) {
        if (id === target.id) continue;
        for (const c of subs.clientsOf(subKey(id, key))) { subs.add(subKey(target.id, key), c); subs.remove(subKey(id, key), c); }
      }
      notePlaced(key, to === 'primary' ? 'primary' : target.id);
    },
    /** Place a key without moving it (its thread is loaded nowhere: a placement restored after a restart). */
    place(key, to) {
      if (to !== 'primary' && !isFramework(backends.get(to))) return false;
      const b = to === 'primary' ? defaultPrimary() : backends.get(to);
      if (b) aff.repin(key, b.id);
      placed.delete(key); placed.set(key, to);
      return true;
    },
    /** Told {key, backend} whenever a key is re-homed or a framework backend creates (or resumes) a thread. */
    onPlaced(fn) { placedListeners.add(fn); return { dispose() { placedListeners.delete(fn); } }; },
    /** Where keyless creator requests (a new thread) go: a framework backend's id, or null for the app's own backend. */
    setStartBackend(id) {
      if (id !== null && id !== 'primary' && !isFramework(backends.get(id))) throw unavailable(`unknown backend '${id}'`);
      startBackend = id === 'primary' ? null : id;
    },
    get startBackend() { return startBackend ?? 'primary'; },

    async removeBackend(owner, key) {
      const id = `${owner}/${key}`;
      const b = backends.get(id);
      if (!b || b.session) return;
      b.removed = true;
      backends.delete(id);
      aff.dropBackend(id);
      for (const [k, h] of [...placed]) if (h === id) placed.delete(k);
      if (startBackend === id) startBackend = null;
      failWaiters(b, unavailable('the backend was removed'));
      await stopBackend(b, 'removed');
    },

    listBackends(owner) {
      const out = [];
      if (owner === undefined) {
        const live = [...sessions.values()];
        if (live.length === 0) out.push({ key: 'primary', owner: 'app', state: 'stopped' });
        const oldest = oldestSession();
        for (const S of live) out.push({ key: S === oldest ? 'primary' : S.primary.id, owner: 'app', state: S.primary.state });
      }
      for (const b of backends.values()) {
        if (b.session) continue;
        if (owner === undefined) out.push({ key: b.id, owner: b.owner, state: b.state });
        else if (b.owner === owner) out.push({ key: b.key, owner: b.owner, state: b.state });
      }
      return out;
    },

    issueLease,
    revokeLease,

    async disposeOwner(owner) {
      for (const l of [...leases.values()]) if (l.owner === owner) revokeLease(l.id);
      const stops = [];
      for (const b of [...backends.values()]) if (!b.session && b.owner === owner) stops.push(mux.removeBackend(owner, b.key));
      await Promise.all(stops);
    },

    setLeaseServiceHandler(fn) { leaseServiceHandler = fn; },

    onFault(fn) { faultListeners.add(fn); return { dispose() { faultListeners.delete(fn); } }; },

    metrics() {
      const sorted = Array.from(latency.buf.subarray(0, latency.n)).sort((a, b) => a - b);
      return {
        frames: { ...frames },
        interceptorCalls: { ...interceptorCalls },
        interceptorFaults: { ...interceptorFaults },
        latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) },
        backends: mux.listBackends(),
        deferredPending: deferred.size,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      // Held client requests go nowhere: their holders are told, and their clients get the mux's error below.
      for (const d of [...deferred.values()]) if (d.kind === 'clientRequest') cancelHeld(d, 'muxClosed');
      // Settle everything that is still waiting.
      for (const b of backends.values()) failWaiters(b, unavailable('the mux is closed'));
      for (const c of [...clients.values()]) {
        for (const req of [...c.active]) settle(req, { fail: failStage(req, 'the mux is closed') });
      }
      for (const req of [...pendingByMid.values()]) { if (req.internal) req.internal(null); }
      pendingByMid.clear(); srvPending.clear(); resolvedSids.clear(); answeredSids.clear(); subs.clear(); keyTable.clear();
      for (const d of [...deferred.values()]) if (d.kind === 'serverRequest') cancelDeferred(d, 'backendGone');
      const stops = [];
      for (const b of backends.values()) stops.push(stopBackend(b, 'close'));
      for (const l of leases.values()) l.conn?.destroy();
      leases.clear();
      for (const w of aliasWaiters.splice(0)) { clearTimeout(w.t); w.fail(unavailable('the mux is closed')); }
      for (const w of hsWaiters.splice(0)) { clearTimeout(w.t); }
      for (const S of [...sessions.values()]) { S.gone = true; clearTimeout(S.restartTimer); try { S.conn.stream.destroy(); } catch { /* closed */ } }
      sessions.clear();
      await listening;
      await new Promise((res) => { if (!server.listening) return res(); server.close(() => res()); });
      try { fs.unlinkSync(clientsSocketPath); } catch { /* already removed */ }
      await Promise.all(stops);
      for (const c of [...clients.values()]) if (c.kind === 'mod') disposeClient(c);
    },
  };
  return mux;
}
