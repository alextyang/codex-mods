// The shared desktop manager and window services, without Electron or a running app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./notifications.cjs');
const payload = (id, fields = {}) => ({ id, kind: 'permission', title: 'Approval', body: 'Review this', conversationId: 't', requestId: 'r', ...fields });
const window = (id, manager) => ({ id, host: { services: { notifications: { desktopNotificationManager: manager } } } });

class Manager {
  constructor() {
    this.notifications = new Map();
    this.calls = [];
    this.createNotification = function (...args) {
      this.calls.push(['create', ...args]);
      return new EventEmitter();
    };
  }
  showNotification(p, ...rest) {
    this.calls.push(['show', p, ...rest]);
    if (p.suppressed) return null;
    const notification = this.createNotification({ id: p.id }, ...rest);
    this.notifications.set(p.id, { notification });
    // The app adds its listeners after createNotification returns. Our close observer must still find the entry.
    notification.on('close', () => this.notifications.delete(p.id));
    return notification;
  }
}

function setup(windows) {
  const manager = new Manager(), calls = [], reports = [], warnings = [], listeners = new Set();
  let run;
  const services = {
    notifications: { desktopNotificationManager: manager, async hide(args) { calls.push(['hide', args]); } },
    appActions: { async runInPrimaryWindow(args) { calls.push(['action', args]); } },
  };
  const state = { windows: windows ?? [{ id: 7, host: { services } }] };
  const hostHandlers = new Map(), toHost = [], hostState = [];
  const hooks = {
    onHostMessage(type, fn) { const l = hostHandlers.get(type) ?? []; l.push(fn); hostHandlers.set(type, l); },
    onHostState(fn) { hostState.push(fn); },
    sendToHost(msg) { toHost.push(msg); },
    appHost: { first: () => state.windows[0] ?? null, windows: () => state.windows, senderOf: (id) => (state.windows.some((w) => w.id === id) ? { id } : null),
      subscribe(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } },
    log: { warn(...args) { warnings.push(args); } },
    onAreaOp(area, fn) { assert.equal(area, 'notifications'); run = fn; },
    areaReport(area, report) { assert.equal(area, 'notifications'); reports.push(report); },
  };
  register(hooks);
  return {
    hooks, manager, services, state, calls, reports, warnings, run, toHost, hostState,
    fromHost(msg) { for (const fn of hostHandlers.get(msg.type) ?? []) fn(msg); },
    add(w) { state.windows.push(w); for (const fn of listeners) fn({ type: 'added', id: w.id }); },
    remove(id) { state.windows = state.windows.filter((w) => w.id !== id); for (const fn of listeners) fn({ type: 'removed', id }); },
  };
}

test('wrappers preserve arguments, receiver and return value and report the remembered payload by the manager entry id', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 12345 });
  const s = setup();
  const p = payload('one', { navigationPath: '/private', actions: [{ title: 'Approve' }] });
  const rest = [{ webContents: true }, () => {}, () => {}, () => {}];
  const n = s.manager.showNotification(p, ...rest);
  assert.equal(s.manager.notifications.get('one').notification, n);
  assert.deepEqual(s.manager.calls, [['show', p, ...rest], ['create', { id: 'one' }, ...rest]]);
  assert.deepEqual(s.reports, [], 'showNotification alone is not a shown event');
  p.title = 'Later';
  n.emit('show');
  const remembered = { id: 'one', kind: 'permission', title: 'Approval', body: 'Review this', conversationId: 't', requestId: 'r', at: 12345 };
  assert.deepEqual(s.reports, [{ event: 'shown', notification: remembered }]);
  // Each listener finds its id in the live Map before the app removes the entry.
  s.manager.notifications.set('unrelated', { notification: new EventEmitter() });
  n.emit('close');
  assert.deepEqual(s.reports.at(-1), { event: 'dismissed', notification: remembered });
  assert.equal(s.manager.notifications.has('one'), false, 'the app\'s close listener still runs');
  n.emit('show');
  assert.equal(s.reports.length, 2, 'no manager entry means no report');
  assert.equal(s.manager.showNotification(payload('suppressed', { suppressed: true })), null);
  assert.equal(s.reports.length, 2, 'a suppressed notification never reports shown');
});

test('click and action report opened and suppress a later dismissed, while a plain close reports dismissed', () => {
  const s = setup();
  for (const event of ['click', 'action', 'close']) {
    const n = s.manager.showNotification(payload(event));
    n.emit('show');
    n.emit(event, {}, 0);
    if (event !== 'close') n.emit('close');
  }
  assert.deepEqual(s.reports.map((r) => [r.notification.id, r.event]), [['click', 'shown'], ['click', 'opened'], ['action', 'shown'], ['action', 'opened'], ['close', 'shown'], ['close', 'dismissed']]);
});

test('payload fields are strings or null and only the last 200 ids are remembered, with repeated ids refreshed', () => {
  const s = setup();
  const first = s.manager.showNotification(payload('0'));
  const second = s.manager.showNotification(payload('1'));
  for (let i = 2; i <= 200; i++) s.manager.showNotification(payload(String(i)));
  first.emit('show');
  assert.equal(s.reports.length, 0, 'the oldest payload was evicted');
  second.emit('show');
  assert.equal(s.reports.at(-1).notification.id, '1');
  const refreshed = s.manager.showNotification(payload('1', { title: 5, body: {}, kind: false, conversationId: undefined, requestId: [] }));
  s.manager.showNotification(payload('201'));
  s.manager.notifications.get('2').notification.emit('show');
  assert.equal(s.reports.length, 1, 'refreshing id 1 makes id 2 oldest');
  refreshed.emit('show');
  const { at, ...data } = s.reports.at(-1).notification;
  assert.equal(typeof at, 'number');
  assert.deepEqual(data, { id: '1', title: null, body: null, kind: null, conversationId: null, requestId: null });
  const unremembered = s.manager.createNotification({});
  s.manager.notifications.set('external', { notification: unremembered });
  unremembered.emit('show');
  assert.equal(s.reports.length, 2, 'an entry without a remembered payload is skipped');
});

test('bind the first window with a manager, later windows and replacements, and never wrap the shared manager twice', () => {
  const first = new Manager(), next = new Manager();
  const original = first.showNotification;
  const s = setup([]);
  s.add({ id: 1, host: { services: {} } });
  assert.equal(first.showNotification, original);
  s.add(window(2, first));
  const wrappedShow = first.showNotification, wrappedCreate = first.createNotification;
  assert.notEqual(wrappedShow, original);
  s.add(window(3, first));
  s.add(window(4, next));
  assert.equal(next.showNotification, original, 'keep the first held manager');
  s.remove(2);
  assert.equal(first.showNotification, wrappedShow);
  assert.equal(first.createNotification, wrappedCreate);
  register(s.hooks);
  assert.equal(first.showNotification, wrappedShow, 'a second registration does not stack wrappers');
  const n = first.showNotification(payload('one'));
  assert.equal(n.listenerCount('show'), 1);
  n.emit('show');
  assert.equal(s.reports.length, 1);
  s.remove(3);
  assert.notEqual(next.showNotification, original);
  next.showNotification(payload('two')).emit('show');
  assert.deepEqual(s.reports.map((r) => r.notification.id), ['one', 'two']);
});

test('payload, report, listener installation, lookup and binding errors stay out of the app path and log once', () => {
  const s = setup();
  const bad = payload('bad');
  Object.defineProperty(bad, 'title', { get() { throw new Error('cannot read title'); } });
  assert.doesNotThrow(() => s.manager.showNotification(bad));
  assert.doesNotThrow(() => s.manager.showNotification(bad));
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0][1].message, /cannot read title/);
  const n = s.manager.showNotification(payload('one'));
  s.hooks.areaReport = () => { throw new Error('report failed'); };
  let appHeard = 0;
  n.on('show', () => { appHeard++; });
  assert.doesNotThrow(() => n.emit('show'));
  const map = s.manager.notifications;
  s.manager.notifications = null;
  assert.doesNotThrow(() => n.emit('show'));
  s.manager.notifications = map;
  assert.equal(appHeard, 2);
  assert.equal(s.warnings.length, 1);

  const malformed = new Manager(), object = { on() { throw new Error('cannot listen'); } };
  malformed.createNotification = () => object;
  const listening = setup([window(1, malformed)]);
  assert.equal(malformed.createNotification({}), object);
  assert.equal(listening.warnings.length, 1);
  assert.equal(malformed.createNotification({}), object);
  const brokenLog = setup();
  let logged = 0;
  brokenLog.hooks.log.warn = () => { logged++; throw new Error('logger failed'); };
  assert.doesNotThrow(() => brokenLog.manager.showNotification(bad));
  assert.doesNotThrow(() => brokenLog.manager.showNotification(bad));
  assert.equal(logged, 1);
  const frozen = Object.freeze(new Manager());
  const binding = setup([window(1, frozen)]);
  assert.equal(binding.warnings.length, 1);
  assert.doesNotThrow(() => binding.add(window(2, frozen)));
  assert.equal(binding.warnings.length, 1);
});

test('an error from the original app methods still reaches their caller', () => {
  for (const method of ['showNotification', 'createNotification']) {
    const manager = new Manager(), error = new Error(`${method} failed`);
    manager[method] = () => { throw error; };
    const s = setup([window(1, manager)]);
    assert.throws(() => manager.showNotification(payload('one')), (e) => e === error);
    assert.deepEqual(s.warnings, []);
  }
});

test('open shows the source through appActions then hides by notification id; dismiss and a source-less open only hide', async () => {
  const s = setup();
  assert.deepEqual(await s.run('open', { id: 'one', conversationId: 'thread' }), {});
  assert.deepEqual(await s.run('dismiss', { id: 'two', conversationId: 'ignored' }), {});
  for (const conversationId of [undefined, null, 3]) assert.deepEqual(await s.run('open', { id: 'other', conversationId }), {});
  assert.deepEqual(s.calls, [
    ['action', { action: { type: 'windows.show_thread', windowId: 'current', threadId: 'thread' } }],
    ['hide', { notificationId: 'one' }], ['hide', { notificationId: 'two' }],
    ...Array.from({ length: 3 }, () => ['hide', { notificationId: 'other' }]),
  ]);
});

test('notification ids and unknown operations refuse before acting; a 400 character id is accepted', async () => {
  const s = setup();
  for (const op of ['open', 'dismiss']) {
    for (const id of [undefined, null, '', '  ', 3, {}, 'x'.repeat(401)]) {
      await assert.rejects(s.run(op, { id, conversationId: 't' }), (e) => e.refused === true && /notification id/.test(e.message));
    }
    await assert.rejects(s.run(op, null), (e) => e.refused === true);
  }
  for (const op of ['unknown', '__proto__']) await assert.rejects(s.run(op), (e) => e.refused === true && e.message === `unknown operation ${op}`);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(await s.run('dismiss', { id: 'x'.repeat(400) }), {});
});

test('missing windows or services refuse and attempted app failures propagate without further action', async () => {
  const s = setup([]);
  await assert.rejects(s.run('dismiss', { id: 'one' }), (e) => e.refused && /window/.test(e.message));
  s.add({ id: 1, host: { services: s.services } });
  delete s.services.notifications.hide;
  await assert.rejects(s.run('dismiss', { id: 'one' }), (e) => e.refused && /hide/.test(e.message));
  delete s.services.notifications;
  await assert.rejects(s.run('dismiss', { id: 'one' }), (e) => e.refused && /notifications/.test(e.message));
  s.services.notifications = { async hide() { throw new Error('hide failed'); } };
  await assert.rejects(s.run('dismiss', { id: 'one' }), (e) => !e.refused && e.message === 'hide failed');
  s.services.appActions.runInPrimaryWindow = async () => { throw new Error('show failed'); };
  await assert.rejects(s.run('open', { id: 'one', conversationId: 't' }), (e) => !e.refused && e.message === 'show failed');
  delete s.services.appActions;
  await assert.rejects(s.run('open', { id: 'one', conversationId: 't' }), (e) => e.refused && /appActions/.test(e.message));
  assert.deepEqual(s.calls, []);
});

test('hide has the kit deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.services.notifications.hide = () => new Promise(() => {});
  const failed = assert.rejects(s.run('dismiss', { id: 'one' }), /the app did not answer in 15000 ms/);
  t.mock.timers.tick(15_000);
  await failed;
});

test('public hooks H6 (§3.5): while the Host holds App.notify, a notification waits for its answer: kept from showing, or shown as changed; otherwise at once, as before', async () => {
  const t = setup();
  const before = t.manager.showNotification(payload('n1'));
  assert.ok(before instanceof EventEmitter, 'nothing holds it: shown at once, its return kept');
  assert.deepEqual(t.toHost, []);
  t.fromHost({ type: 'user-holds', held: ['App.notify'], observed: [] });
  const kept = t.manager.showNotification(payload('n2', { title: 'Done', conversationId: 'c9' }));
  assert.equal(typeof kept.then, 'function');
  const ask = t.toHost.at(-1);
  assert.deepEqual([ask.type, ask.ref, ask.operation, ask.origin, ask.args], ['user-hold', { type: 'App', provider: 'codex', id: 'codex' }, 'notify', 'app',
    [{ title: 'Done', body: 'Review this', kind: 'permission', thread: { type: 'CodexThread', provider: 'codex', id: 'c9' } }]]);
  t.fromHost({ type: 'user-hold-answer', requestId: ask.requestId, go: false, message: 'Quiet hours' });
  assert.equal(await kept, undefined);
  assert.equal(t.manager.calls.filter(([k, p]) => k === 'show' && p.id === 'n2').length, 0, 'kept from showing');
  const changed = t.manager.showNotification(payload('n3'));
  const n3 = t.toHost.at(-1).requestId;
  t.fromHost({ type: 'user-hold-answer', requestId: n3, go: true, args: [{ title: 'Approval (from QA)', body: 'Look at this' }], changedBy: [{ mod: 'qa.hooks', name: 'QA hooks', policy: 'Retitle' }] });
  await changed;
  const shown = t.manager.calls.find(([k, p]) => k === 'show' && p.id === 'n3')[1];
  assert.deepEqual([shown.title, shown.body, shown.kind], ['Approval (from QA)', 'Look at this\nChanged by QA hooks (Retitle)', 'permission'], 'who changed it, where it shows');
  assert.deepEqual(t.toHost.at(-1), { type: 'user-hold-done', requestId: n3, outcome: { status: 'done' } }, 'the Host is told it showed');
  t.fromHost({ type: 'user-holds', held: [], observed: ['App.notify'] });
  assert.ok(t.manager.showNotification(payload('n4')) instanceof EventEmitter, 'nothing holds it again: at once');
  assert.deepEqual([t.toHost.at(-1).type, t.toHost.at(-1).operation, t.toHost.at(-1).outcome], ['user-did', 'notify', { status: 'done' }], 'observed: reported after');
  // the Host went with something held: what waits on it goes on (its mods went with it), and nothing is held until it says again
  t.fromHost({ type: 'user-holds', held: ['App.notify'], observed: [] });
  const waits = t.manager.showNotification(payload('n5'));
  for (const fn of t.hostState) fn(false);
  await waits;
  assert.equal(t.manager.calls.filter(([k, p]) => k === 'show' && p.id === 'n5').length, 1);
  assert.ok(t.manager.showNotification(payload('n6')) instanceof EventEmitter);
});

test('public hooks §3.14: a mod\'s desktop notification is the app\'s own, shown by the manager\'s own show (never held as the app\'s); its buttons, a click and its going go to the Host', async () => {
  const t = setup();
  t.fromHost({ type: 'user-holds', held: ['App.notify'], observed: [] });
  assert.deepEqual(await t.run('show', { id: 'codexmods:unit.a:n1', title: 'Done', body: 'All good\nUnit A', actions: [{ id: 'ok', title: 'OK' }] }), {});
  const [, payload, target, onAction, onRemoved] = t.manager.calls.find(([k, p]) => k === 'show' && p.id === 'codexmods:unit.a:n1');
  assert.deepEqual([payload.kind, payload.title, payload.body, payload.actions, target], ['codexmods', 'Done', 'All good\nUnit A', [{ id: 'ok', title: 'OK', actionType: 'button' }], { id: 7 }], 'from its window');
  assert.equal(t.toHost.filter((m) => m.type === 'user-hold').length, 0, 'a mod\'s own notification is not the app\'s: not held');
  assert.equal(onAction({ notificationId: payload.id, actionId: 'ok', actionType: 'button' }), undefined);
  onAction({ notificationId: payload.id, actionType: 'open' });
  onRemoved();
  assert.deepEqual(t.toHost.slice(-3), [{ type: 'notice-action', id: payload.id, action: 'ok' }, { type: 'notice-action', id: payload.id, action: null }, { type: 'notice-gone', id: payload.id }]);
  await assert.rejects(t.run('show', { id: 'unit.a:n1', title: 'x' }), /id/);
  await assert.rejects(t.run('show', { id: 'codexmods:x', title: '' }), /title/);
});
