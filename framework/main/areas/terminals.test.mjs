// The shared manager and window services, without Electron, a pty, or a real shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./terminals.cjs');
const session = (id, extra = {}) => ({ id, conversationId: 'chat', cwd: '/repo', shell: '/bin/zsh', ownerId: 22, hostId: 'local', ...extra });

class Manager {
  sessions = new Map();
  listeners = new Map();
  subscriptions = [];
  removals = [];
  subscribe(origin, fn) {
    this.subscriptions.push(origin);
    const set = this.listeners.get(origin.id) ?? new Set();
    this.listeners.set(origin.id, set);
    set.add(fn);
    return () => { this.removals.push(origin); set.delete(fn); };
  }
  emit(ownerId, e) { for (const fn of this.listeners.get(ownerId) ?? []) fn(e); }
}

function setup({ windows, manager = new Manager() } = {}) {
  const calls = [], reports = [], warnings = [], listeners = new Set();
  let run;
  const window = (id) => ({ id, host: { services: {
    terminal: {
      origin: { id: id * 11 }, terminalManager: manager,
      subscribe() { throw new Error('must never replace the renderer listener'); },
      write(...args) { calls.push([id, 'write', ...args]); },
      close(...args) { calls.push([id, 'close', ...args]); },
    },
    appActions: { async runInPrimaryWindow({ action }) { calls.push([id, 'action', action]); return { status: 'opened' }; } },
  } } });
  const state = { windows: windows ?? [window(1), window(2)] };
  const hooks = {
    appHost: {
      first: () => state.windows[0] ?? null, windows: () => state.windows,
      subscribe(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    },
    log: { warn(...args) { warnings.push(args); } },
    onAreaOp(area, fn) { assert.equal(area, 'terminals'); run = fn; },
    areaReport(area, report) { assert.equal(area, 'terminals'); reports.push(report); },
  };
  register(hooks);
  return {
    hooks, manager, calls, reports, warnings, state, window, run,
    change(e) { for (const fn of listeners) fn(e); },
    add(w) { state.windows.push(w); this.change({ type: 'added', id: w.id }); },
    remove(id) { state.windows = state.windows.filter((w) => w.id !== id); this.change({ type: 'removed', id }); },
  };
}

test('subscribe through the manager once per held window, preserve existing listeners, and remove the subscription with the window', () => {
  const manager = new Manager();
  const app = [];
  manager.subscribe({ id: 11 }, (e) => app.push(e));
  const s = setup({ manager });
  assert.deepEqual(manager.subscriptions.map((o) => o.id), [11, 11, 22]);
  s.change({ type: 'updated', id: 1 });
  s.change({ type: 'added', id: 2 });
  assert.equal(manager.subscriptions.length, 3);
  const e = { type: 'attached', sessionId: 'one', cwd: '/repo', shell: 'zsh' };
  manager.emit(11, e);
  assert.deepEqual(app, [e]);
  assert.equal(s.reports.length, 1);
  s.remove(1);
  manager.emit(11, { type: 'exit', sessionId: 'one', code: 0, signal: null });
  assert.equal(app.length, 2, 'the renderer listener survives removal of our subscription');
  assert.equal(s.reports.length, 1);
  assert.deepEqual(manager.removals.map((o) => o.id), [11]);
  s.add(s.window(1));
  assert.equal(manager.subscriptions.length, 4, 'a replacement window is observed');
  s.remove(2);
  assert.deepEqual(manager.removals.map((o) => o.id), [11, 22]);
  const late = setup({ windows: [] });
  late.add({ id: 5, host: { services: {} } });
  late.add(late.window(6));
  assert.deepEqual(late.manager.subscriptions.map((o) => o.id), [66]);
});

test('reports attached, exit and error, and output at most once per 250 ms per session without terminal text', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const s = setup();
  const emit = (type, sessionId, data = {}) => s.manager.emit(22, { type, sessionId, ...data });
  emit('attached', 'one', { cwd: '/repo', shell: '/bin/zsh' });
  emit('init-log', 'one', { log: 'private replay' });
  emit('input-status', 'one', { error: 'not reported' });
  emit('data', 'one', { data: 'private output' });
  emit('data', 'one', { data: 'still private' });
  emit('data', 'two', { data: 'another session' });
  t.mock.timers.tick(249);
  emit('data', 'one');
  t.mock.timers.tick(1);
  emit('data', 'one');
  emit('exit', 'one', { code: 3, signal: null, error: 'not part of the report' });
  emit('error', 'two', { message: 'Session missing' });
  emit('exit', 'two');
  s.manager.emit(22, null);
  assert.deepEqual(s.reports, [
    { event: 'attached', sessionId: 'one', cwd: '/repo', shell: 'zsh' },
    { event: 'output', sessionId: 'one' }, { event: 'output', sessionId: 'two' }, { event: 'output', sessionId: 'one' },
    { event: 'exit', sessionId: 'one', code: 3, signal: null },
    { event: 'error', sessionId: 'two', message: 'Session missing' }, { event: 'exit', sessionId: 'two', code: null, signal: null },
  ]);
});

test('observation, reporting, removal and logging errors never reach the app and log once', () => {
  const s = setup();
  s.hooks.areaReport = () => { throw new Error('report failed'); };
  assert.doesNotThrow(() => s.manager.emit(11, { type: 'attached', sessionId: 'one' }));
  assert.doesNotThrow(() => s.manager.emit(22, { type: 'exit', sessionId: 'two' }));
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0][1].message, /report failed/);
  const bad = setup({ windows: [] });
  bad.hooks.log.warn = () => { throw new Error('logger failed'); };
  const w = bad.window(1);
  w.host.services.terminal.terminalManager = { subscribe() { throw new Error('subscribe failed'); } };
  assert.doesNotThrow(() => bad.add(w));
  assert.doesNotThrow(() => bad.add(bad.window(2)));
  assert.equal(bad.manager.subscriptions.length, 1, 'another window still binds');
  const removal = setup({ windows: [] });
  const gone = removal.window(1);
  gone.host.services.terminal.terminalManager = { subscribe() { return () => { throw new Error('removal failed'); }; } };
  removal.add(gone);
  assert.doesNotThrow(() => removal.remove(1));
  assert.equal(removal.warnings.length, 1);
  removal.hooks.appHost.windows = () => { throw new Error('windows failed'); };
  assert.doesNotThrow(() => removal.change({ type: 'added', id: 3 }));
  assert.equal(removal.warnings.length, 1);
});

test('list returns only local sessions and normalizes the five public fields', async () => {
  const s = setup();
  for (const item of [session('one'), session('remote', { hostId: 'ssh:remote' }), session('absent', { hostId: undefined, ownerId: '11', shell: '/usr/local/bin/fish' }), session('empty', { conversationId: undefined, cwd: null, shell: null, ownerId: null })]) s.manager.sessions.set(item.id, item);
  assert.deepEqual(await s.run('list'), { sessions: [
    { id: 'one', conversationId: 'chat', threadId: 'chat', cwd: '/repo', shell: 'zsh', ownerId: '22' },
    { id: 'absent', conversationId: 'chat', threadId: 'chat', cwd: '/repo', shell: 'fish', ownerId: '11' },
    { id: 'empty', conversationId: null, threadId: null, cwd: null, shell: null, ownerId: null },
  ] });
  assert.deepEqual(s.calls, []);
  const missing = setup({ windows: [{ id: 1, host: { services: {} } }] });
  await assert.rejects(missing.run('list'), { refused: true, message: "the app's terminals cannot be reached" });
  await assert.rejects(setup({ windows: [] }).run('list'), { refused: true, message: "the app's terminals cannot be reached" });
});

test('write and close use the owner window, falling back to the first window for a missing owner', async () => {
  const s = setup();
  s.manager.sessions.set('one', session('one'));
  s.manager.sessions.set('orphan', session('orphan', { ownerId: 99 }));
  assert.deepEqual(await s.run('write', { sessionId: 'one', data: 'printf hi\r' }), {});
  assert.deepEqual(await s.run('close', { sessionId: 'one' }), {});
  assert.deepEqual(await s.run('write', { sessionId: 'orphan', data: '' }), {});
  assert.deepEqual(await s.run('close', { sessionId: 'orphan' }), {});
  assert.deepEqual(s.calls, [[2, 'write', 'one', 'printf hi\r'], [2, 'close', 'one'], [1, 'write', 'orphan', ''], [1, 'close', 'orphan']]);
  s.state.windows[1].host.services.terminal.write = () => { throw new Error('app write failed'); };
  await assert.rejects(s.run('write', { sessionId: 'one', data: 'x' }), { message: 'app write failed' });
  delete s.state.windows[1].host.services.terminal.close;
  await assert.rejects(s.run('close', { sessionId: 'one' }), { refused: true });
});

test('focus shows the chat then opens its terminal, stopping on the first app error', async () => {
  const s = setup();
  s.manager.sessions.set('one', session('one'));
  assert.deepEqual(await s.run('focus', { sessionId: 'one', threadId: 'chat' }), {});
  assert.deepEqual(s.calls, [
    [1, 'action', { type: 'windows.show_thread', windowId: 'current', threadId: 'chat' }],
    [1, 'action', { type: 'windows.tabs.open', windowId: 'current', threadId: 'chat', target: { type: 'terminal', sessionId: 'one' } }],
  ]);
  s.state.windows[0].host.services.appActions.runInPrimaryWindow = async () => { throw new Error('cannot show chat'); };
  await assert.rejects(s.run('focus', { sessionId: 'one', threadId: 'chat' }), /cannot show chat/);
  assert.equal(s.calls.length, 2);
});

test('guards and unknown operations refuse before an app action, accepting the exact length limits', async () => {
  const s = setup();
  s.manager.sessions.set('one', session('one'));
  s.manager.sessions.set('remote', session('remote', { hostId: 'ssh:remote' }));
  for (const op of ['write', 'close', 'focus']) for (const sessionId of [undefined, null, 4, '', ' ', 'x'.repeat(201), 'gone', 'remote']) {
    await assert.rejects(s.run(op, { sessionId, data: 'x', threadId: 'chat' }), { refused: true });
  }
  for (const data of [undefined, null, 4, {}, 'x'.repeat(100_001)]) await assert.rejects(s.run('write', { sessionId: 'one', data }), { refused: true });
  for (const threadId of [undefined, null, 4, '', ' ', 'x'.repeat(201), 'client-new-thread:home']) await assert.rejects(s.run('focus', { sessionId: 'one', threadId }), { refused: true });
  for (const op of ['run', 'constructor', '__proto__', undefined]) await assert.rejects(s.run(op, null), { refused: true, message: `unknown operation ${op}` });
  await assert.rejects(s.run('close', null), { refused: true });
  assert.deepEqual(s.calls, []);
  const longId = 'x'.repeat(200);
  s.manager.sessions.set(longId, session(longId));
  await s.run('write', { sessionId: longId, data: 'x'.repeat(100_000) });
  await s.run('focus', { sessionId: longId, threadId: 't'.repeat(200) });
  assert.equal(s.calls.length, 3);
});

test('write and close use the kit deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.manager.sessions.set('one', session('one'));
  for (const op of ['write', 'close']) {
    s.state.windows[1].host.services.terminal[op] = () => new Promise(() => {});
    const running = s.run(op, { sessionId: 'one', data: 'x' });
    const checked = assert.rejects(running, /the app did not answer in 15000 ms/);
    t.mock.timers.tick(15_000);
    await checked;
  }
});

test('tail: a terminal\'s recent output kept in main, as plain text (escapes and returns gone), its last lines; gone with its exit', async () => {
  const s = setup();
  s.manager.sessions.set('t1', session('t1'));
  s.manager.emit(22, { type: 'data', sessionId: 't1', data: '\x1b[32m$ make\x1b[0m\r\nbuilding 10%\rbuilding 100%\r\n' });
  s.manager.emit(22, { type: 'data', sessionId: 't1', data: 'done\r\n\x1b]0;title\x07$ ' });
  assert.deepEqual(await s.run('tail', { sessionId: 't1', lines: 2 }), { text: 'done\n$ ' });
  assert.deepEqual(await s.run('tail', { sessionId: 't1', lines: 10 }), { text: '$ make\nbuilding 100%\ndone\n$ ' });
  assert.ok(s.reports.every((r) => !JSON.stringify(r).includes('building')), 'no output in the reports');
  for (const lines of [0, 1001, 2.5, undefined]) await assert.rejects(s.run('tail', { sessionId: 't1', lines }), (e) => e.refused === true);
  s.manager.emit(22, { type: 'exit', sessionId: 't1', code: 0 });
  assert.deepEqual(await s.run('tail', { sessionId: 't1', lines: 10 }), { text: '' });
  await assert.rejects(s.run('tail', { sessionId: 'gone', lines: 5 }), /no longer available/);
});
