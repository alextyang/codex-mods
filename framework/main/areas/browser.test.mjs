// Per-window browser services and the shared manager, without Electron or a running app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./browser.cjs');
const ids = { conversationId: 'chat', browserTabId: 'tab' };
const page = (browserTabId, fields = {}) => ({ ...ids, browserTabId, snapshot: {
  url: 'https://example.com/', title: 'Example', isLoading: true, canGoBack: true, canGoForward: false,
}, isBrowserUsePage: false, pendingTeardown: false, ...fields });
const manager = (...pages) => ({ windows: new Map([[1, { threads: new Map(pages.map((p, i) => [i, p])) }]]) });

function services(browserHostManager = manager()) {
  const calls = [], callbacks = [];
  const state = { answer: 'accepted', removals: 0 };
  return { calls, callbacks, state,
    browserHost: { browserHostManager, async runPageCommand(args) { calls.push(args); return state.answer; } },
    browserTabs: { subscribeInvalidations(cb) { callbacks.push(cb); return () => { state.removals++; }; } },
  };
}
const window = (id, service = services()) => ({ id, host: { services: service } });

function setup(windows = [window(1)]) {
  const reports = [], warnings = [], posts = [], external = [], listeners = new Set();
  const state = { windows };
  let run;
  const hooks = {
    appHost: { windows: () => state.windows, first: () => state.windows[0] ?? null, subscribe(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } },
    onAreaOp(area, fn) { assert.equal(area, 'browser'); run = fn; },
    areaReport(area, report) { assert.equal(area, 'browser'); reports.push(report); },
    electron: { postToWindow(...args) { posts.push(args); }, async openExternal(url) { external.push(url); } },
    log: { warn(...args) { warnings.push(args); } },
  };
  register(hooks);
  return { run, hooks, state, reports, warnings, posts, external,
    add(w) { state.windows.push(w); for (const fn of listeners) fn({ type: 'added', id: w.id }); },
    remove(id) { state.windows = state.windows.filter((w) => w.id !== id); for (const fn of listeners) fn({ type: 'removed', id }); },
  };
}

test('tabs reads every window of the first manager, normalizes fields and skips torn-down or incomplete pages', async () => {
  const m = manager(page('one'), page('closing', { pendingTeardown: true }), page('', {}), page('no-chat', { conversationId: '' }),
    page('non-string', { browserTabId: 4 }), page('no-snapshot', { snapshot: null }), null);
  m.windows.set(2, { threads: new Map([['second', page('two', { conversationId: 'other', isBrowserUsePage: true,
    snapshot: { title: 5, url: null, isLoading: 1, canGoBack: 'true', canGoForward: true, faviconUrl: 'private' } })]]) });
  for (const value of [null, {}, { threads: [] }]) m.windows.set(Symbol(), value);
  const first = services(m), second = services(manager(page('not-the-first-manager')));
  const s = setup([window(1, first), window(2, second)]);
  assert.deepEqual(await s.run('tabs', {}), { tabs: [
    { ...ids, threadId: 'chat', browserTabId: 'one', url: 'https://example.com/', title: 'Example', loading: true, canGoBack: true, canGoForward: false, agent: false },
    { conversationId: 'other', threadId: 'other', browserTabId: 'two', url: '', title: '', loading: false, canGoBack: false, canGoForward: true, agent: true },
  ] });
  assert.deepEqual(first.calls, []);
  assert.deepEqual(s.warnings, []);
});

test('a missing manager or its windows means no tabs and logs once', async () => {
  const s = setup([]);
  assert.deepEqual(await s.run('tabs'), { tabs: [] });
  const w = window(1);
  s.add(w);
  for (const value of [null, {}, { windows: [] }]) {
    w.host.services.browserHost.browserHostManager = value;
    assert.deepEqual(await s.run('tabs'), { tabs: [] });
  }
  delete w.host.services.browserHost;
  assert.deepEqual(await s.run('tabs'), { tabs: [] });
  assert.equal(s.warnings.length, 1);
});

test('commands try the held windows in order until one answers other than wrong-window, and add only the app navigation fields', async () => {
  const first = services(), second = services(), last = services();
  first.state.answer = 'wrong-window';
  const s = setup([window(1, first), { id: 2 }, window(3, second), window(4, last)]);
  for (const command of [{ type: 'navigate', url: 'http://example.com/path', hostId: 'remote', source: 'agent', extra: true },
    { type: 'reload', ignoreCache: true }, { type: 'go-back' }, { type: 'go-forward' }]) {
    assert.deepEqual(await s.run('command', { ...ids, command }), {});
  }
  const expected = [
    { ...ids, command: { type: 'navigate', url: 'http://example.com/path', hostId: 'local', source: 'manual', initiator: 'toggle_browser_command' } },
    ...['reload', 'go-back', 'go-forward'].map((type) => ({ ...ids, command: { type } })),
  ];
  assert.deepEqual(first.calls, expected);
  assert.deepEqual(second.calls, expected);
  assert.deepEqual(last.calls, []);
  for (const answer of ['page-unavailable', 'navigation-unavailable']) {
    second.state.answer = answer;
    await assert.rejects(s.run('command', { ...ids, command: { type: 'reload' } }), (e) => e.refused === true && e.message === answer);
  }
  last.state.answer = second.state.answer = 'wrong-window';
  await assert.rejects(s.run('command', { ...ids, command: { type: 'reload' } }), (e) => e.refused === true && e.message === 'wrong-window');
  assert.equal(last.calls.length, 1);
  const absent = setup([]);
  await assert.rejects(absent.run('command', { ...ids, command: { type: 'reload' } }), (e) => e.refused === true && /unavailable/.test(e.message));
});

test('close posts the app host message to every window; open-external uses the adapter with its unchanged URL', async () => {
  const s = setup([window(1), window(2)]);
  assert.deepEqual(await s.run('close', ids), {});
  assert.deepEqual(s.posts, [1, 2].map((id) => [id, 'codex_desktop:message-for-view', { type: 'close-browser-tab', ...ids }]));
  assert.deepEqual(await s.run('open-external', { url: 'https://example.com/path?q=1' }), {});
  assert.deepEqual(await s.run('open-external', { url: 'http://localhost:3000/' }), {});
  assert.deepEqual(s.external, ['https://example.com/path?q=1', 'http://localhost:3000/']);
  s.hooks.electron.openExternal = (url) => { assert.equal(url, 'file:///private'); throw new Error('adapter refused this URL'); };
  await assert.rejects(s.run('open-external', { url: 'file:///private' }), /adapter refused this URL/);
});

test('observation subscribes once per distinct service, throttles all callbacks, and removes a subscription when its last window goes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const first = services(), next = services();
  const s = setup([window(1, first), window(2, first), window(3, next)]);
  assert.equal(first.callbacks.length, 1);
  assert.equal(next.callbacks.length, 1);
  const cb = first.callbacks[0];
  assert.equal(cb.dup(), cb);
  assert.doesNotThrow(() => cb.onRpcBroken());
  assert.doesNotThrow(() => cb[Symbol.dispose]());
  cb(); cb(); next.callbacks[0]();
  assert.deepEqual(s.reports, [{ event: 'invalidated' }]);
  t.mock.timers.tick(499); cb();
  assert.equal(s.reports.length, 1);
  t.mock.timers.tick(1); next.callbacks[0](); cb();
  assert.equal(s.reports.length, 2);
  s.add(window(4, first));
  assert.equal(first.callbacks.length, 1);
  s.remove(1); s.remove(2);
  assert.equal(first.state.removals, 0, 'another held window still uses this service');
  s.remove(4); s.remove(4);
  assert.equal(first.state.removals, 1);
  t.mock.timers.tick(500); cb();
  assert.equal(s.reports.length, 2, 'a removed listener cannot report');
  s.remove(3);
  assert.equal(next.state.removals, 1);
  const replacement = services();
  s.add(window(3, replacement));
  assert.equal(replacement.callbacks.length, 1);
});

test('binding, report, removal and logging errors stay out of the app path and log once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const first = services();
  const s = setup([window(1, first)]);
  s.hooks.areaReport = () => { throw new Error('report failed'); };
  assert.doesNotThrow(() => first.callbacks[0]());
  t.mock.timers.tick(500);
  assert.doesNotThrow(() => first.callbacks[0]());
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0][1].message, /report failed/);
  const broken = services();
  broken.browserTabs.subscribeInvalidations = () => { throw new Error('cannot subscribe'); };
  assert.doesNotThrow(() => s.add(window(2, broken)));
  const badWindow = { id: 3, get host() { throw new Error('window is gone'); } };
  assert.doesNotThrow(() => s.add(badWindow));
  assert.equal(s.warnings.length, 1);

  const removal = services();
  removal.browserTabs.subscribeInvalidations = () => () => { throw new Error('cannot remove'); };
  const r = setup([window(1, removal)]);
  let logged = 0;
  r.hooks.log.warn = () => { logged++; throw new Error('logger failed'); };
  assert.doesNotThrow(() => r.remove(1));
  assert.doesNotThrow(() => r.add(badWindow));
  assert.equal(logged, 1);
});

test('ids, command types and URLs are guarded before any action; unknown operations refuse', async () => {
  const service = services(), s = setup([window(1, service)]);
  for (const op of ['command', 'close']) {
    for (const key of ['conversationId', 'browserTabId']) for (const id of [undefined, null, '', ' ', 4, {}, 'x'.repeat(201)]) {
      await assert.rejects(s.run(op, { ...ids, [key]: id, command: { type: 'reload' } }), (e) => e.refused === true && e.message.includes(key));
    }
    await assert.rejects(s.run(op, null), (e) => e.refused === true);
  }
  for (const command of [null, {}, { type: 'stop' }, { type: '__proto__' }, { type: 4 }]) {
    await assert.rejects(s.run('command', { ...ids, command }), (e) => e.refused === true);
  }
  for (const url of [undefined, null, '', 4, {}, 'example.com', 'file:///tmp/page', 'javascript:alert(1)', 'ftp://example.com', `https://example.com/${'x'.repeat(8_000)}`]) {
    await assert.rejects(s.run('command', { ...ids, command: { type: 'navigate', url } }), (e) => e.refused === true && /URL/.test(e.message));
  }
  for (const op of ['other', '__proto__']) await assert.rejects(s.run(op), (e) => e.refused === true && e.message === `unknown operation ${op}`);
  assert.deepEqual([service.calls, s.posts, s.external], [[], [], []]);
  const prefix = 'https://example.com/';
  assert.deepEqual(await s.run('command', { conversationId: 'c'.repeat(200), browserTabId: 'b'.repeat(200), command: { type: 'navigate', url: prefix + 'x'.repeat(8_000 - prefix.length) } }), {});
});

test('attempted command failures propagate without trying another window and missing adapter methods refuse', async () => {
  const first = services(), second = services(), s = setup([window(1, first), window(2, second)]);
  first.browserHost.runPageCommand = () => { throw new Error('command failed'); };
  await assert.rejects(s.run('command', { ...ids, command: { type: 'reload' } }), (e) => !e.refused && e.message === 'command failed');
  assert.deepEqual(second.calls, []);
  delete s.hooks.electron.openExternal;
  await assert.rejects(s.run('open-external', { url: 'https://example.com/' }), (e) => e.refused === true);
  delete s.hooks.electron.postToWindow;
  await assert.rejects(s.run('close', ids), (e) => e.refused === true);
});

test('browser service and external operations have the kit deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = services(), s = setup([window(1, service)]);
  service.browserHost.runPageCommand = () => new Promise(() => {});
  const command = assert.rejects(s.run('command', { ...ids, command: { type: 'reload' } }), /the app did not answer in 15000 ms/);
  t.mock.timers.tick(15_000); await command;
  s.hooks.electron.openExternal = () => new Promise(() => {});
  const external = assert.rejects(s.run('open-external', { url: 'https://example.com/' }), /the app did not answer in 15000 ms/);
  t.mock.timers.tick(15_000); await external;
});
