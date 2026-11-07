// framework-main's read-state module (read-state.cjs) against a fake AppHost whose `threadReadState` service behaves like the app's (20770:
// open(callback, options) -> {status, identity, executionHostKeysByHostId, unreadThreadIdsByHostId, session}; session.set; a `changed` event
// with origin 'self' for the session that wrote and 'external' for the others; `retired` when the app ends the sessions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installAppHost } = require('./apphost.cjs');
const { createReadState, register, identityKeyOf } = require('./read-state.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3);
  }
}
const quiet = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]), error: (m, d) => lines.push(['error', m, d]) }; };

/** The app's read-state owner: the unread set of host `local`, the open sessions, and the services each window's AppHost exports. */
function fakeApp({ unread = [], identity = { kind: 'chatgpt', accountId: 'acct-1', userId: 'user-1', authToken: 'SECRET-TOKEN' }, ready = true, hostKeys = { local: 'key-local' } } = {}) {
  const app = {
    unread: new Set(unread), identity, ready, hostKeys, sessions: new Set(), opens: 0, sets: [], stubErrors: [],
    /** What the app itself does (the window's own session, or a broadcast): changes the state, tells every session 'external'. */
    userSets(threadId, hasUnreadTurn) { app.apply(threadId, hasUnreadTurn, null); },
    apply(threadId, hasUnreadTurn, from) {
      if (hasUnreadTurn) app.unread.add(threadId); else app.unread.delete(threadId);
      for (const s of [...app.sessions]) s.cb({ type: 'changed', origin: s === from ? 'self' : 'external', hostId: 'local', threadId, hasUnreadTurn });
    },
    retire(reason) { const all = [...app.sessions]; app.sessions.clear(); for (const s of all) s.cb({ type: 'retired', reason }); },
    /** The AppHost service of one window (UQe.open: the callback is an RPC stub, `dup()`ed). */
    service: () => ({
      async open(cb, options) {
        app.opens++;
        for (const k of ['dup', 'onRpcBroken']) if (typeof cb[k] !== 'function') app.stubErrors.push(`callback.${k}`);
        if (typeof cb[Symbol.dispose] !== 'function') app.stubErrors.push('callback[Symbol.dispose]');
        const dup = cb.dup();
        if (!app.ready) { dup[Symbol.dispose](); return { status: 'unavailable' }; }
        const entry = { cb: (ev) => dup(ev), closed: false };
        app.sessions.add(entry);
        const session = {
          async set(req) {
            app.sets.push(req);
            if (!app.sessions.has(entry)) return { status: 'retired' };
            if (app.hostKeys[req.hostId] == null) return { status: 'unavailable' };
            if (app.setHook) await app.setHook(req, entry);
            if (app.unread.has(req.threadId) !== req.hasUnreadTurn) app.apply(req.threadId, req.hasUnreadTurn, entry);
            return { status: 'ok' };
          },
          unsubscribe() { app.sessions.delete(entry); entry.closed = true; },
        };
        return { status: 'ready', identity: app.identity, executionHostKeysByHostId: app.hostKeys, unreadThreadIdsByHostId: { local: [...app.unread] }, session, options };
      },
    }),
  };
  return app;
}
function sender(id) {
  const s = { id, handlers: [], destroyed: false, once(ev, fn) { if (ev === 'destroyed') s.handlers.push(fn); }, isDestroyed: () => s.destroyed,
    destroy() { s.destroyed = true; for (const fn of s.handlers.splice(0)) fn(); } };
  return s;
}

/** The module under test, the real AppHost hold over a private global, and the messages it sends the Host. */
function setup(appOrOpts = {}, opts = {}) {
  const app = appOrOpts.sessions ? appOrOpts : fakeApp(appOrOpts);
  const g = {};
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  const sent = [];
  let epochs = 0;
  const rs = createReadState({ appHost: hold, send: (m) => sent.push(structuredClone(m)), log, debounceMs: 8, retryMs: 15, retryMaxMs: 60, newEpoch: () => `ep${++epochs}`, ...opts });
  const windows = new Map();
  const t = {
    app, hold, rs, sent, log, g, windows,
    /** A window appears: its AppHost has the service (or the services given). */
    open(id, services) {
      const s = sender(id);
      windows.set(id, s);
      g.__codexmods.appHost({ services: services ?? { threadReadState: app.service() } }, s);
      return s;
    },
    close(id) { windows.get(id).destroy(); },
    reports: () => sent.filter((m) => m.type === 'read-state'),
    last: () => t.reports().at(-1),
    dispose() { rs.dispose(); hold.dispose(); },
  };
  return t;
}

test('identityKeyOf names the account and nothing secret', () => {
  assert.equal(identityKeyOf({ kind: 'chatgpt', accountId: 'a', userId: 'u', authToken: 'SECRET' }), JSON.stringify(['chatgpt', 'a', 'u']));
  assert.equal(identityKeyOf({ kind: 'apikey', authMode: 'apikey', token: 'SECRET' }), JSON.stringify(['apikey', 'apikey']));
  assert.equal(identityKeyOf(null), null);
});

test('a window\'s session opens, and the unread set of host local goes to the Host once, as available with reset', async () => {
  const t = setup({ unread: ['t2', 't1'] });
  try {
    t.open(1);
    await until(() => t.reports().length >= 1, 2000, 'the first report');
    assert.deepEqual(t.reports(), [{ type: 'read-state', available: true, unread: ['t1', 't2'], reset: true, epoch: 'ep1' }]);
    assert.deepEqual(t.app.stubErrors, [], 'the callback is shaped like an RPC stub');
    assert.equal(t.app.sessions.size, 1);
    await sleep(40);
    assert.equal(t.reports().length, 1, 'nothing more while nothing changes');
  } finally { t.dispose(); }
});

test('the app\'s changes reach the Host, debounced into one report; a change back to what was sent sends nothing', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.app.userSets('t2', true); t.app.userSets('t3', true); t.app.userSets('t1', false);
    await until(() => t.reports().length === 2, 2000, 'second report');
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: ['t2', 't3'], epoch: 'ep1' }, 'one report for three changes, no reset');
    t.app.userSets('t4', true); t.app.userSets('t4', false);
    await sleep(60);
    assert.equal(t.reports().length, 2, 'a change undone inside the debounce window is no change');
    t.app.userSets('t9', true);
    await until(() => t.reports().length === 3, 2000, 'third report');
    assert.deepEqual(t.last().unread, ['t2', 't3', 't9']);
  } finally { t.dispose(); }
});

test('events of other hosts and malformed events are ignored', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    const [s] = [...t.app.sessions];
    s.cb({ type: 'changed', origin: 'external', hostId: 'ssh:other', threadId: 'x', hasUnreadTurn: true });
    s.cb({ type: 'changed', origin: 'external', hostId: 'local', threadId: 5, hasUnreadTurn: true });
    s.cb({ type: 'nonsense' }); s.cb(null);
    await sleep(40);
    assert.equal(t.reports().length, 1);
  } finally { t.dispose(); }
});

test('a request from the Host is applied with session.set on host local; its echo is not reported as the app\'s change; one report carries the ack', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.rs.set({ type: 'read-state-set', id: 'h-1', threadId: 't1', unread: false });
    await until(() => t.reports().length === 2, 2000, 'the report after the write');
    assert.deepEqual(t.app.sets, [{ hostId: 'local', threadId: 't1', hasUnreadTurn: false }]);
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: [], epoch: 'ep1', ack: 'h-1' });
    await sleep(40);
    assert.equal(t.reports().length, 2, 'the echo (origin self) did not report again');
    assert.deepEqual(t.rs.state().unread, []);
  } finally { t.dispose(); }
});

test('the echo is also recognised by its tag when the app delivers it as external while the write is in flight', async () => {
  const t = setup({ unread: [] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    let release;
    const gate = new Promise((r) => { release = r; });
    t.app.setHook = async (req) => { t.app.userSets(req.threadId, req.hasUnreadTurn); await gate; };   // an 'external' event, then a slow answer
    t.rs.set({ type: 'read-state-set', id: 'h-1', threadId: 'p1', unread: true });
    await until(() => t.rs.state().unread.includes('p1'), 2000, 'the external twin');
    await sleep(40);                                 // several debounce periods
    assert.equal(t.reports().length, 1, 'nothing reported while the write is in flight (the external twin is tagged, not news)');
    release();
    await until(() => t.reports().length === 2, 2000, 'the report after the write');
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: ['p1'], epoch: 'ep1', ack: 'h-1' });
    t.app.setHook = null;
    t.app.userSets('p1', false);   // the user's own change after the write IS news
    await until(() => t.reports().length === 3, 2000, 'a real change');
    assert.deepEqual(t.last().unread, []);
  } finally { t.dispose(); }
});

test('requests are applied in order; one that changes nothing is acked without a write; an id the app refuses is acked and dropped', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.rs.set({ id: 'a', threadId: 't2', unread: true });
    t.rs.set({ id: 'b', threadId: 't2', unread: false });
    t.rs.set({ id: 'c', threadId: 't1', unread: true });   // already unread: nothing to write
    await until(() => t.last().ack === 'c', 2000, 'the last ack');
    assert.deepEqual(t.app.sets, [
      { hostId: 'local', threadId: 't2', hasUnreadTurn: true },
      { hostId: 'local', threadId: 't2', hasUnreadTurn: false },
    ]);
    assert.deepEqual(t.last().unread, ['t1']);
    assert.equal(t.rs.state().queued, 0);
  } finally { t.dispose(); }
});

test('malformed requests are ignored (logged once); a throwing session.set is logged and its request acked, and the next one still runs', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.rs.set(null); t.rs.set({ id: '', threadId: 'x', unread: true }); t.rs.set({ id: 'z', threadId: 'x', unread: 'yes' });
    assert.equal(t.rs.state().queued, 0);
    assert.equal(t.log.lines.filter((l) => /malformed request/.test(l[1])).length, 1);
    t.app.setHook = async (req) => { if (req.threadId === 'boom') throw new Error('service blew up'); };
    t.rs.set({ id: 'a', threadId: 'boom', unread: true });
    t.rs.set({ id: 'b', threadId: 'fine', unread: true });
    await until(() => t.last().ack === 'b', 2000, 'ack b');
    assert.deepEqual(t.last().unread, ['fine']);
    assert.ok(t.log.lines.some((l) => /a write failed/.test(l[1])));
  } finally { t.dispose(); }
});

test('window handover: when the window holding the session closes, the session closes and reopens on another window, with no gap reported and no reset', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    t.open(2);
    await until(() => t.reports().length === 1, 2000, 'first report');
    assert.equal(t.rs.state().window, 1, 'the first live window holds it');
    assert.equal(t.app.opens, 1);
    t.app.userSets('t5', true);          // the app changes something just before the window closes...
    t.close(1);                          // ...which the Host has not heard yet
    await until(() => t.rs.state().window === 2, 2000, 'reopened on window 2');
    assert.equal(t.app.opens, 2);
    assert.equal([...t.app.sessions].length, 1, 'the old session was closed');
    await until(() => t.reports().length === 2, 2000, 'report after the handover');
    assert.deepEqual(t.reports().map((m) => [m.available, m.unread, m.reset ?? false]), [[true, ['t1'], true], [true, ['t1', 't5'], false]]);
  } finally { t.dispose(); }
});

test('a page reload (the same window gets a new AppHost) reopens the session on the new host at once, without a gap reported', async () => {
  const t = setup({ unread: ['t1'] }, { retryMs: 2000, retryMaxMs: 2000 });
  try {
    const first = t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    const reloaded = sender(1);
    t.g.__codexmods.appHost({ services: { threadReadState: t.app.service() } }, reloaded);   // same sender id, a new host
    await until(() => t.app.opens === 2 && t.rs.state().open, 1000, 'reopened without waiting for a retry');
    assert.equal(t.app.sessions.size, 1, 'one session: the old one was closed');
    first.destroy();                                                  // the old page's late destroy changes nothing
    await sleep(40);
    assert.equal(t.rs.state().open, true);
    assert.equal(t.reports().length, 1, 'nothing reported: the app was never unreachable');
  } finally { t.dispose(); }
});

test('with no window left the Host is told unavailable; the next window opens a session again', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.close(1);
    await until(() => t.reports().length === 2, 2000, 'unavailable report');
    assert.deepEqual(t.last(), { type: 'read-state', available: false, unread: [] });
    assert.equal(t.app.sessions.size, 0);
    t.open(3);
    await until(() => t.reports().length === 3, 2000, 'available again');
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: ['t1'], epoch: 'ep1' }, 'same account: no reset, the same epoch');
  } finally { t.dispose(); }
});

test('a window whose AppHost has no threadReadState service is skipped for the next one; logged once, never thrown', async () => {
  const t = setup();
  try {
    t.open(1, { settings: {} });
    t.open(2);
    await until(() => t.rs.state().window === 2, 2000, 'window 2');
    assert.equal(t.log.lines.filter((l) => /no threadReadState service/.test(l[1])).length, 1);
    const alone = setup();
    try {
      alone.open(1, {});
      await sleep(30);
      assert.equal(alone.rs.state().open, false);
      assert.ok(alone.log.lines.some((l) => /no threadReadState service/.test(l[1])));
    } finally { alone.dispose(); }
  } finally { t.dispose(); }
});

test('a write for another account is dropped and reported, never acked; one for this account, or made before any, is applied and acked (R3)', async () => {
  const t = setup({ unread: [] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    assert.equal(t.last().epoch, 'ep1');
    t.rs.set({ id: 'x', threadId: 't1', unread: true, epoch: 'another' });
    await until(() => t.last()?.dropped, 2000, 'the drop reported');
    assert.deepEqual([t.last().dropped, t.last().ack], [['x'], undefined]);
    assert.deepEqual(t.app.sets, [], 'never applied');
    t.rs.set({ id: 'y', threadId: 't2', unread: true, epoch: 'ep1' });
    t.rs.set({ id: 'z', threadId: 't3', unread: true, epoch: null });
    await until(() => t.last()?.ack === 'z', 2000, 'applied');
    assert.deepEqual(t.app.sets.map((s) => s.threadId), ['t2', 't3']);
    assert.equal(t.last().dropped, undefined, 'a drop is reported once');
  } finally { t.dispose(); }
});

test('the app not ready yet (not signed in, no connection): retried with backoff, logged once; requests wait in the queue and are applied in order on open', async () => {
  const t = setup({ ready: false, unread: ['t1'] });
  try {
    t.open(1);
    t.rs.set({ id: 'a', threadId: 't2', unread: true });
    t.rs.set({ id: 'b', threadId: 't1', unread: false });
    await until(() => t.app.opens >= 3, 2000, 'retries');
    assert.equal(t.rs.state().open, false);
    assert.equal(t.rs.state().queued, 2);
    assert.equal(t.log.lines.filter((l) => /no read-state session yet/.test(l[1])).length, 1, 'logged once');
    assert.deepEqual(t.app.sets, []);
    assert.deepEqual(t.reports(), [], 'an app that was never reachable is not news');
    t.app.ready = true;
    await until(() => t.rs.state().open && t.last()?.ack === 'b', 2000, 'opened and drained');
    assert.deepEqual(t.app.sets, [{ hostId: 'local', threadId: 't2', hasUnreadTurn: true }, { hostId: 'local', threadId: 't1', hasUnreadTurn: false }]);
    // Nothing was reported while the app was unreachable (that is the Host's default); the first report says what the app has now, with the writes acked.
    assert.deepEqual(t.reports(), [{ type: 'read-state', available: true, unread: ['t2'], reset: true, epoch: 'ep1', ack: 'b' }]);
  } finally { t.dispose(); }
});

test('the app retires the session: a new one opens; for another account the next report carries reset', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.app.retire('hosts');
    await until(() => t.app.opens === 2 && t.rs.state().open, 2000, 'reopened');
    await sleep(40);
    assert.equal(t.reports().length, 1, 'same account, same set: nothing to report');
    t.app.identity = { kind: 'chatgpt', accountId: 'acct-2', userId: 'user-2' };
    t.app.unread = new Set(['u9']);
    t.app.retire('identity');
    await until(() => t.reports().length === 2, 2000, 'report for the new account');
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: ['u9'], reset: true, epoch: 'ep2' });
  } finally { t.dispose(); }
});

test('a write that comes back retired reopens the session and is applied again, once, in order', async () => {
  const t = setup({ unread: [] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    // The app ends the session while the Host's request is on its way.
    t.app.sessions.clear();
    t.rs.set({ id: 'a', threadId: 't1', unread: true });
    t.rs.set({ id: 'b', threadId: 't2', unread: true });
    await until(() => t.last()?.ack === 'b', 2000, 'both applied');
    assert.equal(t.app.opens, 2);
    assert.deepEqual(t.app.sets.map((s) => s.threadId), ['t1', 't1', 't2'], 'the retired attempt, then the retry, then the next');
    assert.deepEqual(t.last().unread, ['t1', 't2']);
  } finally { t.dispose(); }
});

test('the Host (re)starting: ready sends the whole state again with reset', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.rs.resend();
    assert.equal(t.reports().length, 2, 'at once');
    assert.deepEqual(t.last(), { type: 'read-state', available: true, unread: ['t1'], reset: true, epoch: 'ep1' });
  } finally { t.dispose(); }
});

test('a session that opens after the open timed out is closed, not kept', async () => {
  const app = fakeApp({ unread: ['t1'] });
  const real = app.service();
  const slow = { open: async (cb) => { await sleep(60); return real.open(cb); } };
  const t = setup(app, { openTimeoutMs: 20, retryMs: 500 });
  try {
    t.open(1, { threadReadState: slow });
    await until(() => t.log.lines.some((l) => /opening the session failed/.test(l[1])), 2000, 'the timeout');
    await until(() => app.opens === 1 && app.sessions.size === 0, 2000, 'the late session closed');
    assert.equal(t.rs.state().open, false);
  } finally { t.dispose(); }
});

test('the identity (it may hold a token) is never logged or sent', async () => {
  const t = setup({ unread: ['t1'] });
  try {
    t.open(1);
    await until(() => t.reports().length === 1, 2000, 'first report');
    t.app.retire('identity');
    await until(() => t.rs.state().open && t.app.opens === 2, 2000, 'reopened');
    t.rs.set({ id: 'a', threadId: 't2', unread: true });
    await until(() => t.last()?.ack === 'a', 2000, 'ack');
    const everything = JSON.stringify([t.sent, t.log.lines]);
    assert.ok(!everything.includes('SECRET-TOKEN') && !everything.includes('acct-1'), everything);
  } finally { t.dispose(); }
});

test('dispose closes the session and stops reporting; later calls do nothing', async () => {
  const t = setup({ unread: ['t1'] });
  t.open(1);
  await until(() => t.reports().length === 1, 2000, 'first report');
  t.rs.dispose();
  assert.equal(t.app.sessions.size, 0);
  t.app.userSets('t2', true);
  t.rs.set({ id: 'a', threadId: 't3', unread: true });
  t.open(2);
  await sleep(40);
  assert.equal(t.reports().length, 1);
  assert.deepEqual(t.app.sets, []);
  t.hold.dispose();
});

test('register: wires the Host\'s messages; without an AppHost it says so and does nothing', async () => {
  // with the hold
  const g = {};
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  const app = fakeApp({ unread: ['t1'] });
  const sent = [], handlers = new Map();
  const hooks = { appHost: hold, sendToHost: (m) => sent.push(m), onHostMessage: (type, fn) => handlers.set(type, fn), log };
  register(hooks);
  assert.deepEqual([...handlers.keys()].sort(), ['read-state-set', 'ready', 'user-hold-answer', 'user-holds']);
  g.__codexmods.appHost({ services: { threadReadState: app.service() } }, sender(1));
  await until(() => sent.length >= 1, 2000, 'report');
  handlers.get('read-state-set')({ type: 'read-state-set', id: 'a', threadId: 't1', unread: false });
  await until(() => sent.at(-1)?.ack === 'a', 2000, 'ack');
  assert.deepEqual(sent.at(-1).unread, []);
  const before = sent.length;
  handlers.get('ready')({ type: 'ready' });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).reset, true);
  hold.dispose();
  // without
  const log2 = quiet();
  assert.doesNotThrow(() => register({ sendToHost() {}, onHostMessage() { throw new Error('must not be reached'); }, log: log2 }));
  assert.ok(log2.lines.some((l) => /no AppHost hold/.test(l[1])));
  // a throwing hook registration is caught
  const log3 = quiet();
  assert.doesNotThrow(() => register({ appHost: hold, sendToHost() {}, onHostMessage() { throw new Error('nope'); }, log: log3 }));
  assert.ok(log3.lines.some((l) => /register failed/.test(l[1])));
});

test('H6h: a window\'s mark read is held on the sessions\' class while something holds Thread.markRead; a refused one answers not ok; the Host\'s writes and marks unread are not held', async () => {
  const { createUserHolds } = require('./user-holds.cjs');
  const app = fakeApp({ unread: ['t1', 't2'] });
  // the app's sessions are instances of one class (21477: the window's session wrapper); the window's own is another instance of it
  let Session = null;
  const service = app.service();
  const open = service.open;
  service.open = async (...a) => {
    const r = await open(...a);
    const inner = r.session;
    Session ??= class { constructor(s) { this.s = s; } set(req) { return this.s.set(req); } unsubscribe() { return this.s.unsubscribe(); } };
    return { ...r, session: new Session(inner) };
  };
  const asked = [];
  let holds;
  holds = createUserHolds({ send: (msg) => { if (msg.type === 'user-hold') { asked.push(msg); queueMicrotask(() => holds.answer({ requestId: msg.requestId, go: false, message: 'keep it unread' })); } } });
  holds.set({ held: ['Thread.markRead'], observed: [] });
  const t = setup(app, { holds });
  try {
    t.open(1, { threadReadState: service });
    await until(() => t.reports().length === 1);
    const windowSession = new Session(await open(() => {}).then((r) => r.session).catch(() => null) ?? { set: async (req) => app.sets.push(req) });
    const before = app.sets.length;
    assert.deepEqual(await windowSession.set({ hostId: 'local', threadId: 't1', hasUnreadTurn: false }), { status: 'refused' });
    assert.deepEqual(asked.map((m) => [m.ref, m.operation, m.changes]), [[{ type: 'CodexThread', provider: 'codex', id: 't1' }, 'markRead', false]]);
    assert.equal(app.sets.length, before, 'the app\'s own write did not run');
    // a mark unread (the user's or the app's own, not told apart) and the Host's own write: not held
    await windowSession.set({ hostId: 'local', threadId: 't3', hasUnreadTurn: true });
    t.rs.set({ type: 'read-state-set', id: 'h-1', threadId: 't2', unread: false });
    await until(() => !app.unread.has('t2'));
    assert.equal(asked.length, 1);
  } finally { t.dispose(); }
});

test('review round 1: a held mark read the session did not take (retired) is reported failed, not done', async () => {
  const { createUserHolds } = require('./user-holds.cjs');
  const app = fakeApp({ unread: ['t1'] });
  let Session = null;
  const service = app.service();
  const open = service.open;
  service.open = async (...a) => {
    const r = await open(...a);
    Session ??= class { constructor(s) { this.s = s; } set(req) { return this.s.set(req); } unsubscribe() { return this.s.unsubscribe(); } };
    return { ...r, session: new Session(r.session) };
  };
  const done = [];
  let holds;
  holds = createUserHolds({ send: (msg) => {
    if (msg.type === 'user-hold') queueMicrotask(() => holds.answer({ requestId: msg.requestId, go: true }));
    if (msg.type === 'user-hold-done') done.push(msg.outcome);
  } });
  holds.set({ held: ['Thread.markRead'], observed: [] });
  const t = setup(app, { holds });
  try {
    t.open(1, { threadReadState: service });
    await until(() => t.reports().length === 1);
    const retired = new Session({ set: async () => ({ status: 'retired' }) });
    assert.deepEqual(await retired.set({ hostId: 'local', threadId: 't1', hasUnreadTurn: false }), { status: 'retired' });
    await until(() => done.length === 1);
    assert.equal(done[0].status, 'failed');
    assert.match(done[0].error.message, /did not write it \(retired\)/);
  } finally { t.dispose(); }
});
