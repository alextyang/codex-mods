// Framework backends (RM10): a backend the framework owns (an added account's) that no mod can name, whose keyless traffic (its account's)
// reaches framework clients only; a key held (its requests wait), re-homed on another backend (its subscribers follow, its old home's
// frames for it are dropped, a request of them refused) and placed; keyless creator requests sent to the start backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { harness, until, sleep } from './helpers.mjs';

const FW = 'framework/acct-1';
async function setup(t) {
  const h = await harness();
  t.after(() => h.close());
  await h.up();
  await h.mux.defineBackend('framework', 'acct-1', { codexHome: join(h.dir, 'home-acct-1'), idleStopMs: null });
  return h;
}

test('a framework backend: no mod names it; its keyless traffic reaches framework clients only, never the app or a mod', async (t) => {
  const h = await setup(t);
  const mod = h.mux.client('mod:x');
  await assert.rejects(mod.request('account/read', { refreshToken: false }, { backend: FW }), (e) => e.code === 'Denied');
  assert.throws(() => mod.notify('initialized', undefined, { backend: FW }), (e) => e.code === 'Denied');
  const fw = h.mux.client('graph:test');
  const seenByMod = [], seenByFw = [];
  mod.observe({}, (m, info) => { if (info?.backend === FW) seenByMod.push(info.method); });
  fw.observe({}, (m, info) => { if (info?.backend === FW) seenByFw.push(`${info.kind}:${info.method}`); });
  const r = await fw.request('account/read', { refreshToken: false }, { backend: FW });
  assert.equal(r.account.type, 'chatgpt');
  await fw.request('fake/rateLimits', { primary: 40 }, { backend: FW });
  await until(() => seenByFw.includes('serverNotification:account/rateLimits/updated'), 5000, 'the framework client hears its usage');
  await sleep(100);
  assert.deepEqual(seenByMod, [], 'a mod observes none of it');
  assert.equal(h.app.inbox.some((m) => m.method === 'account/rateLimits/updated'), false, 'nor does the app');
  // a mod's interceptor of it is not run either
  let intercepted = 0;
  mod.intercept('serverNotification', ['account/rateLimits/updated'], () => { intercepted++; return undefined; });
  await fw.request('fake/rateLimits', { primary: 41 }, { backend: FW });
  await until(() => seenByFw.filter((x) => x === 'serverNotification:account/rateLimits/updated').length === 2, 5000, 'the second report');
  assert.equal(intercepted, 0);
  assert.deepEqual(h.mux.listBackends('framework').map((b) => b.key), ['acct-1']);
});

test('a key held, re-homed on a framework backend and back: its requests wait, then go there; its subscribers follow; its old home is dropped', async (t) => {
  const h = await setup(t);
  const fw = h.mux.client('graph:test');
  const placedSeen = [];
  h.mux.onPlaced((c) => placedSeen.push(c));
  const started = await h.app.request('s1', 'thread/start', { cwd: '/tmp' });
  const T = started.result.thread.id;
  assert.equal(h.mux.homeOf(T), 'primary');
  const hold = h.mux.hold(T, fw.id);
  assert.throws(() => h.mux.hold(T, 'other'), (e) => e.code === 'Busy');
  h.app.send({ id: 'n1', method: 'thread/name/set', params: { threadId: T, name: 'Held' } });
  await sleep(150);
  assert.equal(h.app.inbox.some((m) => m.id === 'n1'), false, 'it waits while held');
  assert.equal(h.mux.inFlight(T, fw.id), 0);
  await fw.request('thread/resume', { threadId: T, excludeTurns: true }, { backend: FW });
  h.mux.rehome(T, FW);
  hold.release();
  await h.app.reply('n1');
  assert.equal(h.mux.homeOf(T), FW);
  assert.deepEqual(placedSeen.at(-1), { key: T, backend: FW });
  // the app is subscribed there now: the new home's notifications reach it; the old home's are dropped
  await fw.request('fake/notify', { method: 'thread/name/updated', params: { threadId: T, threadName: 'from the account' } }, { backend: FW });
  await h.app.waitFor((m) => m.method === 'thread/name/updated' && m.params.threadName === 'from the account', 5000);
  await fw.request('fake/notify', { method: 'thread/name/updated', params: { threadId: T, threadName: 'from the old home' } }, { backend: 'primary' });
  await sleep(150);
  assert.equal(h.app.inbox.some((m) => m.method === 'thread/name/updated' && m.params.threadName === 'from the old home'), false);
  // a stray threadId on an account's method never takes it to the account's backend (its sign-in is the framework's alone)
  await h.app.request('acct1', 'account/read', { refreshToken: false, threadId: T });
  const handled = (method) => h.serverLog().filter((l) => l.includes(`"method":"${method}"`)).map((l) => l.slice(0, l.indexOf(' ')));
  assert.deepEqual([...new Set(handled('account/read'))], ['primary'], 'answered by the app\'s backend');
  const modSeen = [];
  h.mux.client('mod:watcher').observe({}, (m, info) => { if (info?.backend === FW) modSeen.push(info.method); });
  await fw.request('account/read', { refreshToken: false, threadId: T }, { backend: FW });
  await sleep(100);
  assert.deepEqual(modSeen, [], 'a mod sees none of the account\'s traffic, keyed or not');
  // a turn goes to its new home
  const turn = await h.app.request('t1', 'turn/start', { threadId: T, input: [{ type: 'text', text: 'hi' }] });
  assert.ok(turn.result.turn.id);
  await h.app.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === T, 5000);
  // and back to the app's own backend
  await fw.request('thread/resume', { threadId: T, excludeTurns: true }, { backend: 'primary' });
  h.mux.rehome(T, 'primary');
  assert.equal(h.mux.homeOf(T), 'primary');
  assert.deepEqual(placedSeen.at(-1), { key: T, backend: 'primary' });
  await fw.request('fake/notify', { method: 'thread/name/updated', params: { threadId: T, threadName: 'stale' } }, { backend: FW });
  await sleep(150);
  assert.equal(h.app.inbox.some((m) => m.params?.threadName === 'stale'), false, 'the account\'s frames for it are dropped now');
});

test('new threads start on the start backend, are placed there, and the app hears of them', async (t) => {
  const h = await setup(t);
  const placedSeen = [];
  h.mux.onPlaced((c) => placedSeen.push(c));
  assert.throws(() => h.mux.setStartBackend('mod:x/nope'), (e) => e.code === 'Unavailable');
  h.mux.setStartBackend(FW);
  assert.equal(h.mux.startBackend, FW);
  const started = await h.app.request('s1', 'thread/start', { cwd: '/tmp' });
  const T = started.result.thread.id;
  assert.match(T, /^thr-acct-1-/, 'started by the account\'s app-server');
  await h.app.waitFor((m) => m.method === 'thread/started' && m.params.thread.id === T, 5000);
  await until(() => placedSeen.some((c) => c.key === T && c.backend === FW), 5000, 'placed');
  assert.equal(h.mux.homeOf(T), FW);
  // an ephemeral thread (mod intelligence's) starts there too, routed but never kept
  const eph = await h.app.request('s3', 'thread/start', { cwd: '/tmp', ephemeral: true });
  assert.match(eph.result.thread.id, /^thr-acct-1-/);
  assert.equal(h.mux.homeOf(eph.result.thread.id), FW);
  await sleep(100);
  assert.equal(placedSeen.some((c) => c.key === eph.result.thread.id), false);
  // placing restores where a thread runs without moving it (after a restart)
  assert.equal(h.mux.place('thr-elsewhere', FW), true);
  assert.equal(h.mux.homeOf('thr-elsewhere'), FW);
  assert.equal(h.mux.place('thr-x', 'mod:x/nope'), false);
  h.mux.setStartBackend(null);
  const plain = await h.app.request('s2', 'thread/start', { cwd: '/tmp' });
  assert.match(plain.result.thread.id, /^thr-primary-/);
  // a removed backend's placements go with it
  await h.mux.removeBackend('framework', 'acct-1');
  assert.equal(h.mux.homeOf('thr-elsewhere'), 'primary');
});
