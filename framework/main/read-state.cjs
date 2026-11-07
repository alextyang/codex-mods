'use strict';
// The app's read state in framework-main (docs/design/presentations.md V12; ARCHITECTURE.md 4.1, 6.8). The app keeps which threads are unread in
// its global state (`electron-thread-read-state-v1`) and lets its windows read and write it through a session: the AppHost service
// `threadReadState.open(callback, options)` returns `{status: 'ready', identity, executionHostKeysByHostId, unreadThreadIdsByHostId, session}`,
// and `session.set({hostId, threadId, hasUnreadTurn})` changes it (docs/design/realization/proofs/model-batch-1.md C3). The callback gets
// `{type: 'changed', origin: 'self' | 'external', hostId, threadId, hasUnreadTurn}` for every change and `{type: 'retired', reason}` when the
// session ends (the account changed, the hosts changed). A framework session is an in-process callback shaped like an RPC stub.
//
// This module holds ONE session, opened from the first live window's AppHost (apphost.cjs) and reopened on another window when that window
// closes. It keeps the set of unread thread ids of host `local`, and tells the Host (`read-state`) when it changes, debounced. It applies the
// Host's requests (`read-state-set`) in order with `session.set`.
//
// The Host and this module never loop:
// - a write the Host asked for is TAGGED while it is in flight (and the session marks its own events `origin: 'self'`), so its echo updates
//   the set but is not reported as a change of the app's; the write's completion reports once, with the write's id as `ack`;
// - the Host sends nothing in answer to a report (its store applies a report and sends only what its own callers set).
// The `ack` is the id of the last request this module applied; a request it gives up on (another account's, refused or failed by the app,
// pushed out of a full queue) is reported in `dropped` instead (boundary review R3). The Host keeps its own writes on top of what it hears
// until they are acked or dropped, so a report that was sent before a write cannot undo it. A request that cannot be applied yet (no session)
// waits in a queue and is applied, in order, once a session is open.
// Each account's session has an `epoch` (opaque, random, new whenever a session opens for another account), carried by the reports; a request
// carries the epoch the Host last heard, and one from another epoch is dropped, so a write meant for one account never reaches another's.
// The first report after a session opens for another account (or the first ever, or after the Host restarted) carries `reset: true`: the Host
// takes what changed as a sync, not as the user's doing.
//
// Without a window, an AppHost or the service, nothing happens: the reason is logged once and nothing throws. `identity` may hold the account's
// token (the app asks `getAuthStatus` with it), so it is compared by account and never logged, stored or sent.

const { userHoldsOf } = require('./user-holds.cjs');

const LOCAL = 'local';          // the app's host id of this machine
// The user's own read marks held (public-hooks.md §3.5, H6h; scout H6h-holds): every window's session is one class's, whose `set` the
// window's marks reach (the menu's mark read, a chat opened and seen, Shift+Esc). A mark read is always the user's (they read it or said
// so); a mark unread is theirs or the app's own (a turn ended unseen), which the call does not tell apart, so only marks read are held.
// A refused one answers the app's way for a write it did not take (a status not `ok`): its page reads the state again.
const SESSION_ORIGINALS = Symbol.for('codexmods.readState.originals');
/** What a session's write did: only `status: 'ok'` wrote (a retired or unavailable session wrote nothing). */
const markOutcome = (r) => Promise.resolve(r).then((res) => (res && res.status === 'ok' ? { status: 'done' } : { status: 'failed', error: { message: `the app did not write it (${res && res.status})` } }),
  (e) => ({ status: 'failed', error: { message: String((e && e.message) || e) } }));
const MARK_READ = 'Thread.markRead';
const QUEUE_MAX = 2000;
const DROPPED_MAX = 200;        // dropped ids kept for the next report (more are only logged)
const WRITE_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 15_000;

/** The account of a session, without anything secret (the identity may hold a token). */
function identityKeyOf(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return identity.kind === 'chatgpt' ? JSON.stringify([identity.kind, identity.accountId, identity.userId]) : JSON.stringify([identity.kind, identity.authMode]);
}

/** A callback shaped like the RPC stub the service expects (`dup`, `onRpcBroken`, dispose), calling `fn`. */
function stubCallback(fn) {
  const cb = (ev) => fn(ev);
  cb.dup = () => cb;
  cb.onRpcBroken = () => {};
  cb[Symbol.dispose] = () => {};
  return cb;
}

const validRequest = (m) => !!m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200
  && typeof m.threadId === 'string' && m.threadId.length > 0 && m.threadId.length <= 200 && typeof m.unread === 'boolean'
  && (m.epoch === undefined || m.epoch === null || (typeof m.epoch === 'string' && m.epoch.length <= 100));
/** A new account epoch: opaque and unguessable across framework-main starts. */
const newEpoch = () => require('node:crypto').randomBytes(6).toString('hex');

/**
 * @param {{ appHost: ReturnType<typeof import('./apphost.cjs').installAppHost>, send(msg: object): void,
 *   log?: { info(m: string, d?: unknown): void, error(m: string, d?: unknown): void, warn?(m: string, d?: unknown): void },
 *   debounceMs?: number, retryMs?: number, retryMaxMs?: number, writeTimeoutMs?: number, openTimeoutMs?: number, newEpoch?: () => string }} o
 * @returns {{ set(msg: object): void, resend(): void, state(): { open: boolean, window: number | null, unread: string[], queued: number, epoch: string | null }, dispose(): void }}
 */
/** A session's own `set`, as it was before it was held: the Host's writes are not the user's (the graph's call passed the mods already). */
function ownSet(handle, req) {
  const proto = handle && Object.getPrototypeOf(handle);
  const fn = (proto && proto[SESSION_ORIGINALS]) || handle.set;
  return fn.call(handle, req);
}

function createReadState(o) {
  const holds = o.holds ?? null;
  /** Hold the user's marks read on the sessions' class (once): while something holds Thread.markRead, the mods decide first. */
  function holdMarks(handle) {
    const proto = holds && handle && Object.getPrototypeOf(handle);
    if (!proto || proto === Object.prototype || proto[SESSION_ORIGINALS] || typeof proto.set !== 'function' || Object.hasOwn(handle, 'set')) return;
    const orig = proto.set;
    proto[SESSION_ORIGINALS] = orig;
    proto.set = function set(req, ...rest) {
      if (!req || req.hasUnreadTurn !== false || req.hostId !== LOCAL || typeof req.threadId !== 'string' || (!holds.held(MARK_READ) && !holds.observed(MARK_READ))) return orig.call(this, req, ...rest);
      const ref = { type: 'CodexThread', provider: 'codex', id: req.threadId };
      if (!holds.held(MARK_READ)) {
        const r = orig.call(this, req, ...rest);
        void markOutcome(r).then((outcome) => holds.did({ ref, operation: 'markRead', args: [], outcome }));
        return r;
      }
      const self = this;
      return holds.ask({ prefix: 'ur', ref, operation: 'markRead', args: [], changes: false }).then((a) => {
        if (a.handled) return { status: 'ok' };
        if (a.stopped) return { status: 'refused' };   // a mod stopped it (graph-integrity G6.2): the chat stays as it is, no error
        if (a.go === false) { say('info', 'read state: a mark read was kept', { why: String(a.message ?? '') }); return { status: 'refused' }; }
        const r = orig.call(self, req, ...rest);
        void markOutcome(r).then((outcome) => holds.done(a.requestId, outcome));
        return r;
      });
    };
  }
  const { appHost, send } = o;
  const debounceMs = o.debounceMs ?? 100;
  const retryBaseMs = o.retryMs ?? 1000;
  const retryMaxMs = o.retryMaxMs ?? 30_000;
  const writeTimeoutMs = o.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  const openTimeoutMs = o.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const makeEpoch = o.newEpoch ?? newEpoch;
  const say = (level, m, d) => { try { (o.log?.[level] ?? o.log?.info)?.call(o.log, m, d); } catch { /* logging never breaks this module */ } };

  let session = null;            // {winId, handle, cb}: the open session
  let opening = null;            // the open in progress (a promise)
  let current = new Set();       // unread thread ids of host `local`, as the session last said
  let identityKey = null;        // of the last session
  let epoch = null;              // the account's epoch (new whenever a session opens for another account)
  let resetNext = true;          // the next report is the first for this account / this Host
  let ack = null;                // id of the last request applied
  let dropped = [];              // ids of the requests given up on since the last report
  let lastKey = null;            // what the last report said (it is sent again only when this changes)
  let told = false;              // whether the Host has been told the app is reachable (until then, "unavailable" is its default and not news)
  let sendTimer = null, retryTimer = null, retryDelay = retryBaseMs;
  let draining = false, disposed = false;
  let rescan = false;            // a window came while a session was being opened: look again at once if that open found nothing
  const queue = [];              // requests waiting for a session: {id, threadId, unread}
  const inflight = new Map();    // `${threadId}\0${unread}` -> count: our own writes, whose echo is not the app's doing
  const noted = new Set();

  const note = (key, level, m, d) => { if (noted.has(key)) return; noted.add(key); say(level, m, d); };
  const timer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; };
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = timer(() => reject(new Error('timed out')), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  // ---------------------------------------------------------------- reporting to the Host
  function snapshot() {
    const msg = { type: 'read-state', available: session !== null, unread: session ? [...current].sort() : [] };
    if (resetNext) msg.reset = true;
    if (session && epoch !== null) msg.epoch = epoch;
    if (ack !== null) msg.ack = ack;
    if (dropped.length) msg.dropped = [...dropped];
    return msg;
  }
  function flush(force = false) {
    clearTimeout(sendTimer); sendTimer = null;
    if (disposed) return;
    if (opening) { schedule(); return; }          // a session is being (re)opened: do not report a gap the app never had
    const msg = snapshot();
    if (!force && !msg.available && !told) return;
    const key = JSON.stringify([msg.available, msg.unread, msg.ack ?? null, msg.epoch ?? null]);
    if (!force && !(msg.reset && msg.available) && !msg.dropped && key === lastKey) return;
    lastKey = key;
    if (msg.available) told = true;
    if (msg.reset && msg.available) resetNext = false;
    dropped = [];
    try { send(msg); } catch (e) { say('error', 'read state: the report to the Host failed', { message: String(e && e.message || e) }); }
  }
  function schedule() {
    if (sendTimer || disposed) return;
    sendTimer = timer(() => flush(), debounceMs);
  }

  // ---------------------------------------------------------------- the session
  const live = (w) => appHost.windows().some((x) => x.id === w.id && x.host === w.host);
  function closeSession() {
    const s = session;
    session = null;
    if (!s) return;
    try { if (typeof s.handle.unsubscribe === 'function') s.handle.unsubscribe(); else s.handle[Symbol.dispose]?.(); } catch { /* already gone */ }
  }
  function onEvent(cb, ev) {
    try {
      if (!session || session.cb !== cb || !ev || typeof ev !== 'object') return;
      if (ev.type === 'retired') {
        say('info', 'read state: the app retired the session', { reason: typeof ev.reason === 'string' ? ev.reason.slice(0, 40) : undefined });
        session = null;
        ensure();
        return;
      }
      if (ev.type !== 'changed' || ev.hostId !== LOCAL || typeof ev.threadId !== 'string') return;
      const unread = ev.hasUnreadTurn === true;
      const echo = ev.origin === 'self' || (inflight.get(`${ev.threadId}\0${unread}`) ?? 0) > 0;
      const had = current.has(ev.threadId);
      if (unread) current.add(ev.threadId); else current.delete(ev.threadId);
      if (!echo && had !== unread) schedule();
    } catch (e) { say('error', 'read state: an event could not be handled', { message: String(e && e.message || e) }); }
  }
  async function openOn(w) {
    const svc = w.host && w.host.services && w.host.services.threadReadState;
    if (!svc || typeof svc.open !== 'function') { note(`no-service:${w.id}`, 'info', 'read state: the window has no threadReadState service', { window: w.id }); return false; }
    const cb = stubCallback((ev) => onEvent(cb, ev));
    const pending = Promise.resolve().then(() => svc.open(cb));
    let res;
    try { res = await withTimeout(pending, openTimeoutMs); } catch (e) {
      // A session that opens after we gave up is closed, never kept.
      pending.then((late) => { try { late && late.status === 'ready' && late.session && late.session.unsubscribe?.(); } catch { /* ignore */ } }, () => {});
      note('open-failed', 'error', 'read state: opening the session failed', { message: String(e && e.message || e) });
      return false;
    }
    const ready = !!res && res.status === 'ready' && !!res.session && typeof res.session.set === 'function';
    const closeStray = () => { try { res.session.unsubscribe?.(); } catch { /* ignore */ } };
    if (!ready) { note('not-ready', 'info', 'read state: the app has no read-state session yet', { status: res && typeof res.status === 'string' ? res.status : null }); return false; }
    if (res.executionHostKeysByHostId == null || res.executionHostKeysByHostId[LOCAL] == null) {
      closeStray();
      note('no-local-host', 'info', 'read state: the app has no local host key yet');
      return false;
    }
    if (disposed || !live(w)) { closeStray(); return false; }   // the window went while the session opened
    holdMarks(res.session);
    session = { winId: w.id, handle: res.session, cb };
    const key = identityKeyOf(res.identity);
    if (key !== identityKey || epoch === null) { resetNext = true; epoch = makeEpoch(); }
    identityKey = key;
    const ids = res.unreadThreadIdsByHostId && res.unreadThreadIdsByHostId[LOCAL];
    current = new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
    noted.clear();
    retryDelay = retryBaseMs;
    say('info', 'read state: session opened', { window: w.id, unread: current.size });
    return true;
  }
  async function tryOpen() {
    for (const w of appHost.windows()) {
      if (disposed || session) break;
      if (!live(w)) continue;
      if (await openOn(w)) break;
    }
    return session !== null;
  }
  /** Open a session if there is none (idempotent). */
  function ensure() {
    if (disposed || session) return Promise.resolve(session !== null);
    if (opening) return opening;
    clearTimeout(retryTimer); retryTimer = null;
    rescan = false;
    const run = tryOpen().catch((e) => { say('error', 'read state: opening failed', { message: String(e && e.message || e) }); return false; }).then((ok) => {
      if (opening === run) opening = null;
      if (disposed) return ok;
      if (ok) drain();
      else if (rescan && appHost.windows().length) ensure();   // a reloaded page: its old host went and the new one came while this looked
      else if (appHost.windows().length) retrySoon();
      schedule();
      return ok;
    });
    opening = run;
    return run;
  }
  function retrySoon() {
    if (disposed || retryTimer || session) return;
    retryTimer = timer(() => { retryTimer = null; ensure(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);
  }

  // ---------------------------------------------------------------- the Host's requests
  /** A request given up on: reported in the next `dropped`, never acked. */
  function drop(req) {
    if (dropped.length < DROPPED_MAX) dropped.push(req.id);
    else note('dropped-full', 'error', 'read state: too many dropped requests to report; the Host forgets them in time');
    schedule();
  }
  /** 'done' (applied, or nothing to apply), 'retry' (the session ended: keep it queued), 'drop' (cannot be applied: give up on it). */
  async function writeOne(req) {
    if (req.epoch != null && req.epoch !== epoch) { note('epoch', 'info', 'read state: a write for another account was dropped'); return 'drop'; }
    if (current.has(req.threadId) === req.unread) return 'done';
    const tag = `${req.threadId}\0${req.unread}`;
    inflight.set(tag, (inflight.get(tag) ?? 0) + 1);
    let r;
    try {
      r = await withTimeout(ownSet(session.handle, { hostId: LOCAL, threadId: req.threadId, hasUnreadTurn: req.unread }), writeTimeoutMs);
    } catch (e) {
      note('set-failed', 'error', 'read state: a write failed', { message: String(e && e.message || e) });
      return 'drop';
    } finally {
      const n = (inflight.get(tag) ?? 1) - 1;
      if (n > 0) inflight.set(tag, n); else inflight.delete(tag);
    }
    const status = r && r.status;
    if (status === 'ok') { if (req.unread) current.add(req.threadId); else current.delete(req.threadId); return 'done'; }
    if (status === 'retired') { closeSession(); ensure(); return 'retry'; }
    note(`set-${status}`, 'info', 'read state: the app did not take a write', { status: typeof status === 'string' ? status : null });
    return 'drop';
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !disposed && session) {
        const req = queue[0];
        let result;
        try { result = await writeOne(req); } catch (e) {
          say('error', 'read state: applying a request failed', { message: String(e && e.message || e) });
          result = 'drop';
        }
        if (result === 'retry') break;
        if (queue[0] === req) queue.shift();
        if (result === 'done') { ack = req.id; schedule(); } else drop(req);
      }
    } finally { draining = false; }
  }

  const sub = appHost.subscribe((e) => {
    if (disposed) return;
    if (e.type === 'removed' && session && session.winId === e.id) { closeSession(); schedule(); }
    if (opening) rescan = true;
    ensure();
  });
  ensure();

  return {
    /** A `read-state-set` from the Host. */
    set(msg) {
      if (disposed) return;
      if (!validRequest(msg)) { note('bad-request', 'error', 'read state: a malformed request from the Host was ignored'); return; }
      if (queue.length >= QUEUE_MAX) {
        drop(queue.shift());
        note('queue-full', 'error', 'read state: the queue of requests is full; the oldest was dropped');
      }
      queue.push({ id: msg.id, threadId: msg.threadId, unread: msg.unread, epoch: msg.epoch ?? null });
      if (session) drain(); else ensure();
    },
    /** The Host (re)started: it knows nothing yet. */
    resend() { resetNext = true; flush(true); },
    state: () => ({ open: session !== null, window: session ? session.winId : null, unread: [...current].sort(), queued: queue.length, epoch }),
    dispose() {
      if (disposed) return;
      disposed = true;
      sub.dispose();
      clearTimeout(sendTimer); clearTimeout(retryTimer);
      closeSession();
    },
  };
}

/** framework-main module entry (contracts/main-hooks.d.ts): must not throw. */
function register(hooks) {
  try {
    if (!hooks.appHost) { hooks.log.info('read state: no AppHost hold; the app\'s read state is not kept in step'); return; }
    const rs = createReadState({ appHost: hooks.appHost, send: hooks.sendToHost, log: hooks.log, holds: userHoldsOf(hooks) });
    hooks.onHostMessage('read-state-set', (msg) => rs.set(msg));
    hooks.onHostMessage('ready', () => rs.resend());
  } catch (e) {
    try { hooks.log.error('read state register failed', { message: String((e && e.message) || e) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, createReadState, identityKeyOf, LOCAL };
