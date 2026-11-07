import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createFakeHostContext, createFakeRendererContext, replay, rpcRequest, rpcResponse, rpcNotification, rpcError, CodexModsError,
} from '../index.mjs';

const manifest = (extra = {}) => ({
  id: 'test.fake', version: '1.0.0', name: 'Fake', framework: '>=1 <2', entry: { host: 'host.mjs' },
  permissions: ['appServer.request', 'appServer.observe', 'appServer.intercept:thread/,turn/start', 'appServer.backends', 'appServer.clients', 'ui', 'graph', 'graph.present'],
  settings: [{ key: 'n', kind: 'number', title: 'N', min: 1, max: 4, default: 2 }, { group: 'More', items: [{ key: 'mode', kind: 'choice', title: 'Mode', options: ['a', 'b'], default: 'a' }] }],
  ...extra,
});
const code = (c) => (e) => e instanceof CodexModsError && e.code === c;

test('grants are enforced with Denied, including method lists and prefixes', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest(), grants: ['appServer.request:thread/list', 'appServer.intercept:thread/'] });
  after(t, control);
  control.onRequest('thread/list', () => ({ data: [] }));
  assert.deepEqual(await ctx.appServer.request('thread/list', {}), { data: [] });
  await assert.rejects(ctx.appServer.request('thread/start', {}), code('Denied'));
  assert.throws(() => ctx.appServer.intercept('clientRequest', ['turn/start'], () => {}), code('Denied'));
  assert.throws(() => ctx.appServer.intercept('clientRequest', '*', () => {}), code('Denied'));
  assert.throws(() => ctx.appServer.observe({}, () => {}), code('Denied'));
  await assert.rejects(ctx.secrets.get('x'), code('Denied'));
  await assert.rejects(ctx.appServer.backends.define('a'), code('Denied'));
  await assert.rejects(ctx.appServer.clients.issue({ name: 'x' }), code('Denied'));
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => {});   // covered by prefix
});

test('unscripted requests are Unavailable; scripted ones run per backend; timeouts are OutcomeUnknown', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  await assert.rejects(ctx.appServer.request('x/y'), code('Unavailable'));
  control.onRequest('x/y', () => 'primary-reply', { backend: 'primary' });
  assert.equal(await ctx.appServer.request('x/y'), 'primary-reply');
  await assert.rejects(ctx.appServer.request('x/y', {}, { backend: 'nope' }), code('Unavailable'));
  await ctx.appServer.backends.define('acct-1');
  control.onRequest('x/y', (p, c) => `reply-${c.backend}`, { backend: 'acct-1' });
  assert.equal(await ctx.appServer.request('x/y', {}, { backend: 'acct-1' }), 'reply-acct-1');
  control.onRequest('slow', () => new Promise(() => {}));
  await assert.rejects(ctx.appServer.request('slow', {}, { timeoutMs: 20 }), code('OutcomeUnknown'));
  assert.equal(control.requests.at(-1).method, 'slow');
});

test('storage: JSON only, list/prefix, transaction commits atomically and throws Conflict on a concurrent commit', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  await ctx.storage.set('a/1', { x: 1 });
  await ctx.storage.set('a/2', 2);
  await ctx.storage.set('b', 'x');
  assert.deepEqual(await ctx.storage.list('a/'), ['a/1', 'a/2']);
  await assert.rejects(ctx.storage.set('bad', undefined), code('Invalid'));
  const out = await ctx.storage.transaction((tx) => { tx.set('a/3', tx.get('a/2') + 1); tx.delete('b'); return tx.list('a/'); });
  assert.deepEqual(out, ['a/1', 'a/2', 'a/3']);
  assert.equal(await ctx.storage.get('b'), undefined);
  // a rejected sync-only contract
  await assert.rejects(ctx.storage.transaction(async () => 1), code('Invalid'));
  // concurrent commit between snapshot and commit
  control.storage.beforeCommit(() => control.storage.raw.set('a/2', 99));
  await assert.rejects(ctx.storage.transaction((tx) => tx.set('a/2', tx.get('a/2') + 1)), code('Conflict'));
  assert.equal(await ctx.storage.get('a/2'), 99);
  // a transaction that did not touch the changed key still commits
  control.storage.beforeCommit(() => control.storage.raw.set('zzz', 1));
  await ctx.storage.transaction((tx) => tx.set('a/4', 4));
  control.storage.beforeCommit(null);
  // retained is a separate store
  await ctx.storage.retained.set('k', 1);
  assert.equal(await ctx.storage.get('k'), undefined);
  assert.deepEqual(control.storage.exportRetained(), { k: 1 });
});

test('storage.watch fires after commits with the prefix, in any path', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  const seen = [];
  const w = ctx.storage.watch('acct/', (keys) => seen.push(keys));
  await ctx.storage.set('acct/1', 1);
  await ctx.storage.set('other', 1);
  await ctx.storage.transaction((tx) => { tx.set('acct/2', 2); tx.set('acct/3', 3); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [['acct/1'], ['acct/2', 'acct/3']]);
  w.dispose();
  await ctx.storage.set('acct/9', 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 2);
});

test('settings: defaults from the declarations, validation, onChange', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest(), settings: { n: 3 } });
  after(t, control);
  assert.deepEqual(await ctx.settings.get(), { n: 3, mode: 'a' });
  const seen = [];
  ctx.settings.onChange((v) => seen.push(v));
  control.settings.patch({ mode: 'b' });
  assert.deepEqual(seen, [{ n: 3, mode: 'b' }]);
  assert.throws(() => control.settings.set({ n: 9 }), code('Invalid'));
  assert.throws(() => createFakeHostContext({ manifest: manifest(), settings: { mode: 'zzz' } }), code('Invalid'));
});

test('events: prefix topics, own-topic emit only, state replay', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  const seen = [];
  ctx.events.on('mod/test.fake/*', (d, t) => seen.push([t, d]));
  ctx.events.emit('mod/test.fake/a', 1);
  assert.throws(() => ctx.events.emit('mod/other/a', 1), code('Denied'));
  assert.throws(() => ctx.events.emit('framework/x', 1), code('Denied'));
  assert.deepEqual(seen, [['mod/test.fake/a', 1]]);
  control.publish('appServer/ready', { ok: true }, { state: true });
  assert.deepEqual(await ctx.events.state('appServer/ready'), { ok: true });
  const replayed = [];
  ctx.events.on('appServer/*', (d, t) => replayed.push(t), { replay: 'state' });
  assert.deepEqual(replayed, ['appServer/ready']);
});

test('services: own provide/call, Conflict on duplicates, Unavailable otherwise, lease calls need the token', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  ctx.services.provide('usage', { snapshot: (a) => ({ echo: a }) });
  assert.throws(() => ctx.services.provide('usage', {}), code('Conflict'));
  assert.deepEqual(await ctx.services.call('test.fake', 'usage', 'snapshot', { q: 1 }), { echo: { q: 1 } });
  await assert.rejects(ctx.services.call('test.fake', 'usage', 'nope'), code('Unavailable'));
  await assert.rejects(ctx.services.call('other.mod', 'x', 'y'), code('Unavailable'));
  control.provideService('framework', 'info', { version: () => '1' });
  assert.equal(await ctx.services.call('framework', 'info', 'version'), '1');
  const lease = await ctx.appServer.clients.issue({ name: 'menubar' });
  assert.deepEqual(await control.leases.call(lease.id, lease.token, { name: 'usage', method: 'snapshot', args: 5 }), { echo: 5 });
  await assert.rejects(control.leases.call(lease.id, 'wrong', { name: 'usage', method: 'snapshot' }), code('Denied'));
  await ctx.appServer.clients.revoke(lease.id);
  await assert.rejects(control.leases.call(lease.id, lease.token, { name: 'usage', method: 'snapshot' }), code('Denied'));
});

test('deliver: interceptors run by priority then registration order and see the previous output', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  const order = [];
  ctx.appServer.intercept('clientRequest', ['thread/start'], (m) => { order.push('low'); return { replace: { ...m, params: { ...m.params, low: m.params.hi === 1 } } }; }, { priority: 0 });
  ctx.appServer.intercept('clientRequest', ['thread/start'], (m) => { order.push('hi'); return { replace: { ...m, params: { ...m.params, hi: 1 } } }; }, { priority: 5 });
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => { order.push('low2'); }, { priority: 0 });
  ctx.appServer.intercept('clientRequest', ['turn/start'], () => { order.push('other'); });
  const r = await control.deliver('clientRequest', rpcRequest(1, 'thread/start', { cwd: null }));
  assert.equal(r.outcome, 'forward');
  assert.deepEqual(order, ['hi', 'low', 'low2']);
  assert.deepEqual(r.message.params, { cwd: null, hi: 1, low: true });
  assert.equal(r.info.backend, 'primary');
});

test('deliver: handlers get frozen copies; mutation is a throw fault and does not leak', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  ctx.appServer.intercept('clientRequest', ['thread/start'], (m) => { m.params.x = 1; });
  const r = await control.deliver('clientRequest', rpcRequest(1, 'thread/start', {}));
  assert.deepEqual(r.message.params, {});
  assert.equal(control.faults[0].kind, 'throw');
});

test('deliver: respond / drop / route results end or steer the chain; invalid combinations are faults', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  await ctx.appServer.backends.define('acct-1');
  ctx.appServer.intercept('clientRequest', ['thread/list'], () => ({ respond: { result: { data: [] } } }), { priority: 9 });
  ctx.appServer.intercept('clientRequest', ['thread/list'], () => { throw new Error('never reached'); });
  const r1 = await control.deliver('clientRequest', rpcRequest(7, 'thread/list', {}));
  assert.equal(r1.outcome, 'respond');
  assert.deepEqual(r1.response, { id: 7, result: { data: [] } });
  assert.equal(control.faults.length, 0);

  ctx.appServer.intercept('clientRequest', ['thread/start'], () => ({ route: 'acct-1' }));
  const r2 = await control.deliver('clientRequest', rpcRequest(8, 'thread/start', {}));
  assert.equal(r2.route, 'acct-1'); assert.equal(r2.info.backend, 'acct-1');
  ctx.appServer.intercept('clientRequest', ['thread/resume'], () => ({ route: 'ghost' }));
  const r3 = await control.deliver('clientRequest', rpcRequest(9, 'thread/resume', { threadId: 't' }));
  assert.equal(r3.route, undefined); assert.equal(control.faults.at(-1).kind, 'invalid');
  // drop is notification-only
  ctx.appServer.intercept('clientRequest', ['thread/fork'], () => ({ drop: true }));
  const r4 = await control.deliver('clientRequest', rpcRequest(10, 'thread/fork', { threadId: 't' }));
  assert.equal(r4.outcome, 'forward'); assert.equal(control.faults.at(-1).kind, 'invalid');
  ctx.appServer.intercept('serverNotification', ['thread/'], () => ({ drop: true }));
  const r5 = await control.deliver('serverNotification', rpcNotification('thread/started', {}));
  assert.equal(r5.outcome, 'drop');
});

test('deliver: replace may not change the id, nor the method outside client requests', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  ctx.appServer.intercept('clientRequest', ['thread/start'], (m) => ({ replace: { ...m, id: 99 } }));
  const r = await control.deliver('clientRequest', rpcRequest(1, 'thread/start', {}));
  assert.equal(r.message.id, 1); assert.equal(control.faults[0].kind, 'invalid');
  ctx.appServer.intercept('clientRequest', ['thread/resume'], (m) => ({ replace: { ...m, method: 'thread/read' } }));
  const ok = await control.deliver('clientRequest', rpcRequest(2, 'thread/resume', { threadId: 't' }));
  assert.equal(ok.message.method, 'thread/read');
  ctx.appServer.intercept('serverResponse', ['thread/start'], (m) => ({ replace: { ...m, method: 'x' } }));
  const bad = await control.deliver('serverResponse', rpcResponse(1, {}), { method: 'thread/start' });
  assert.deepEqual(bad.message, rpcResponse(1, {}));
});

test('deliver: onError pass continues unchanged, reject answers per kind; late results are discarded', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  ctx.appServer.intercept('clientRequest', ['thread/start'], async () => { await new Promise((r) => setTimeout(r, 60)); return { respond: { result: 1 } }; }, { timeoutMs: 20 });
  const pass = await control.deliver('clientRequest', rpcRequest(1, 'thread/start', {}));
  assert.equal(pass.outcome, 'forward'); assert.equal(control.faults.at(-1).kind, 'timeout');

  ctx.appServer.intercept('clientRequest', ['thread/resume'], () => { throw new Error('boom'); }, { onError: 'reject' });
  const rej = await control.deliver('clientRequest', rpcRequest(2, 'thread/resume', { threadId: 't' }));
  assert.equal(rej.outcome, 'reject'); assert.equal(rej.response.id, 2); assert.ok(rej.response.error);

  ctx.appServer.intercept('serverResponse', ['turn/start'], () => { throw new Error('boom'); }, { onError: 'reject' });
  const res = await control.deliver('serverResponse', rpcResponse(3, { turn: {} }), { method: 'turn/start' });
  assert.equal(res.outcome, 'forward'); assert.ok(res.message.error); assert.equal(res.message.id, 3);

  ctx.appServer.intercept('serverNotification', ['thread/started'], () => { throw new Error('boom'); }, { onError: 'reject' });
  assert.equal((await control.deliver('serverNotification', rpcNotification('thread/started', {}))).outcome, 'drop');
});

test('deliver skips the mod\'s own origin and feeds observers with the final message', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  let calls = 0;
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => { calls += 1; return { replace: rpcRequest(1, 'thread/start', { cwd: '/x' }) }; });
  const seen = [];
  ctx.appServer.observe({ kinds: ['clientRequest'], methods: ['thread/'] }, (m, info) => seen.push([m, info]));
  ctx.appServer.observe({ kinds: ['serverNotification'] }, () => assert.fail('wrong kind'));
  await control.deliver('clientRequest', rpcRequest(1, 'thread/start', {}), { origin: 'mod:test.fake' });
  assert.equal(calls, 0);
  await control.deliver('clientRequest', rpcRequest(1, 'thread/start', {}));
  assert.equal(calls, 1);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1][0].params, { cwd: '/x' });
  assert.ok(Object.isFrozen(seen[1][0]));
  control.gap({ from: 1, to: 2, reason: 'overflow' });
});

test('interceptor options are validated', (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  assert.throws(() => ctx.appServer.intercept('clientRequest', ['thread/start'], () => {}, { timeoutMs: 31000 }), code('Invalid'));
  assert.throws(() => ctx.appServer.intercept('clientRequest', ['thread/start'], () => {}, { onError: 'maybe' }), code('Invalid'));
  assert.throws(() => ctx.appServer.intercept('bogus', ['thread/start'], () => {}), code('Invalid'));
});

test('backends and leases: validation, retention on dispose; deactivate leaves nothing registered', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  await assert.rejects(ctx.appServer.backends.define('primary'), code('Invalid'));
  await assert.rejects(ctx.appServer.backends.define('Bad Key'), code('Invalid'));
  await assert.rejects(ctx.appServer.backends.define('ok', { codexHome: '../escape' }), code('Invalid'));
  await ctx.appServer.backends.define('acct-1', { codexHome: 'acct-1' });
  assert.deepEqual(await ctx.appServer.backends.list(), [{ key: 'acct-1', owner: 'mod:test.fake', state: 'stopped' }]);
  await assert.rejects(ctx.appServer.backends.remove('ghost'), code('Unavailable'));
  const lease = await ctx.appServer.clients.issue({ name: 'x' });
  ctx.appServer.intercept('clientRequest', ['thread/start'], () => {});
  ctx.appServer.observe({}, () => {});
  ctx.storage.watch('a', () => {});
  ctx.services.provide('s', {});
  assert.ok(control.registrations().total >= 6);
  let disposed = false;
  await control.activate({ host: () => () => { disposed = true; } });
  await control.deactivate();
  assert.equal(disposed, true);
  assert.deepEqual(control.registrations(), { total: 0 });
  assert.equal(control.leases.all()[0].revoked, true);
  assert.deepEqual(control.backends.keys(), []);
  assert.ok('acct-1' in control.backends.retained);
  assert.ok(lease.id);
  assert.throws(() => ctx.appServer.intercept('clientRequest', ['thread/start'], () => {}), code('Disposed'));
});

test('backends.remove with deleteData drops retained data', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  await ctx.appServer.backends.define('acct-1');
  await ctx.appServer.backends.remove('acct-1', { deleteData: true });
  assert.deepEqual(control.backends.removals, [{ key: 'acct-1', deleteData: true }]);
  assert.deepEqual(control.backends.retained, {});
});

test('renderer: commands, settings pages, notifications and what is invoked are recorded', async (t) => {
  const host = createFakeHostContext({ manifest: manifest() });
  const { ctx, control } = createFakeRendererContext({ manifest: manifest(), host: host.control });
  after(t, host.control);
  const C = () => ctx.ui.react.createElement('div', {}, 'hello');
  ctx.ui.settings.page({ id: 'p', title: 'P', render: C });
  assert.throws(() => ctx.ui.settings.page({ id: 'p', title: 'P', render: C }), code('Conflict'));
  assert.throws(() => ctx.ui.settings.page({ id: 'q' }), code('Invalid'));
  assert.match((await control.render('p')).text(), /hello/);
  let ran = null;
  assert.throws(() => ctx.ui.commands.add({ id: 'bad', title: 'x', keys: 'Cmd-\\', run() {} }), code('Invalid'));
  for (const ok of ['CmdOrCtrl+\\', 'Cmd+Shift+P', 'Alt+F4', 'P', 'Ctrl++']) ctx.ui.commands.add({ id: `k-${ok}`, title: 'x', keys: ok, run() {} }).dispose();
  ctx.ui.commands.add({ id: 'go', title: 'Go', keys: 'CmdOrCtrl+\\', run: (env) => { ran = env; } });
  assert.throws(() => ctx.ui.commands.add({ id: 'go', title: 'x', run() {} }), code('Conflict'));
  const REF = { type: 'Window', provider: 'codexmods.windows', id: '1' };
  await control.runCommand('go', { window: REF });
  assert.deepEqual(ran.window, REF);
  const n = ctx.ui.notify({ title: 'hi', kind: 'warning' });
  assert.equal(await n.shown, 'fake:n1');
  await n.dismiss();
  assert.deepEqual(control.notifications, [{ id: 'fake:n1', title: 'hi', kind: 'warning', surface: 'auto', dismissed: true }]);
  assert.equal('intercept' in ctx.appServer, false);
  await control.deactivate();
  assert.deepEqual(control.registrations(), { total: 0 });
});

test('renderer: a rule goes through the framework\'s own API: its handle is the real one, and without its grant it is refused as the app would, loudly at activation', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest: manifest() });
  after(t, control);
  const page = ctx.ui.settings.page({ id: 'p', title: 'P', render: () => null });
  assert.equal(await page.accepted, true);
  assert.equal(page.open(), true, 'a settings page\'s open');
  assert.equal(typeof page.ruleId, 'string');
  assert.deepEqual(control.refused, []);
  const narrow = createFakeRendererContext({ manifest: manifest({ permissions: ['graph.present:SettingsPage'] }) });
  after(t, narrow.control);
  narrow.ctx.ui.settings.page({ id: 'p', title: 'P', render: () => null });
  narrow.ctx.ui.commands.add({ id: 'go', title: 'Go', run() {} });
  await narrow.control.settled();
  assert.deepEqual(narrow.control.refused.map((r) => [r.id, r.code]), [['go', 'Denied']]);
  assert.deepEqual([[...narrow.control.commands.keys()], [...narrow.control.pages.keys()]], [[], ['p']]);
  const failing = createFakeRendererContext({ manifest: manifest({ permissions: ['ui'] }) });
  after(t, failing.control);
  await assert.rejects(failing.control.activate((c) => { c.ui.commands.add({ id: 'go', title: 'Go', run() {} }); }), code('Denied'));
  const badId = createFakeRendererContext({ manifest: manifest() });
  after(t, badId.control);
  await assert.rejects(badId.control.activate((c) => { c.ui.commands.add({ id: 'my command', title: 'Go', run() {} }); }), code('Invalid'), 'an id the Host refuses');
  await badId.control.activate(() => {});
  assert.deepEqual(badId.control.refused, [], 'activated again: what was refused before is not this one\'s');
  let env = null;
  const envs = createFakeRendererContext({ manifest: manifest() });
  after(t, envs.control);
  envs.ctx.ui.commands.add({ id: 'e', title: 'E', run: (x) => { env = x; } });
  await envs.control.runCommand('e');
  assert.equal(env.pane, null, 'as the palette says it');
  // the real handle is a proxy over its declaration: the fake's records follow what is done with it
  const live = createFakeRendererContext({ manifest: manifest() });
  after(t, live.control);
  const ran = [];
  const cmd = live.ctx.ui.commands.add({ id: 'c', title: 'C', run: () => ran.push('first') });
  await cmd.update({ run: () => ran.push('second') });
  await live.control.runCommand('c');
  assert.deepEqual(ran, ['second'], 'an update changes what it runs');
  cmd.dispose();
  await assert.rejects(live.control.runCommand('c'), /no command/, 'a disposed command does not run');
  const keys = createFakeRendererContext({ manifest: manifest({ permissions: ['graph.present:Palette'] }) });
  after(t, keys.control);
  await assert.rejects(keys.control.activate((c) => { c.ui.commands.add({ id: 'go', title: 'Go', keys: 'CmdOrCtrl+K', run() {} }); }), /Menu/, 'a key chord is a menu entry');
});

test('renderer denies ui and graph without their grants', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest: manifest({ permissions: ['ui'] }) });
  after(t, control);
  await assert.rejects(ctx.graph.invoke({ type: 'Window', provider: 'p', id: '1' }, 'open', []), code('Denied'));
  const none = createFakeRendererContext({ manifest: manifest({ permissions: [] }) });
  assert.throws(() => none.ctx.ui.notify('x'), code('Denied'));
});

test('fake react renders components with hooks, supports clicks and typing', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest: manifest() });
  after(t, control);
  const { createElement: h, useState, useEffect } = ctx.ui.react;
  let cleaned = 0;
  function Counter() {
    const [n, setN] = useState(0);
    const [text, setText] = useState('');
    useEffect(() => () => { cleaned += 1; }, []);
    return h('div', {}, h('span', {}, `n=${n}`), h('button', { onClick: () => setN(n + 1) }, 'inc'), h('input', { 'aria-label': 'name', value: text, onChange: (e) => setText(e.target.value) }), h('p', {}, `hi ${text}`));
  }
  ctx.ui.settings.page({ id: 'c', title: 'C', render: Counter });
  const root = await control.render('c');
  assert.match(root.text(), /n=0/);
  await root.click('inc'); await root.click('inc');
  assert.match(root.text(), /n=2/);
  await root.type('name', 'bob');
  assert.match(root.text(), /hi bob/);
  await control.deactivate();
  assert.equal(cleaned, 1);
});

test('replay feeds canonical, raw and fake-app-server log lines and tracks request methods for responses', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest: manifest() });
  after(t, control);
  const seen = [];
  ctx.appServer.observe({}, (m, info) => seen.push([info.kind, info.method, info.backend, m.id ?? null]));
  const file = path.join(control.dataDir, 'cap.jsonl');
  fs.writeFileSync(file, [
    '# comment',
    JSON.stringify({ kind: 'clientRequest', message: rpcRequest(1, 'thread/start', {}) }),
    JSON.stringify({ dir: 's2c', backend: 'primary', frame: rpcResponse(1, { thread: { id: 't' } }) }),
    `primary ${JSON.stringify(rpcRequest(2, 'turn/start', { threadId: 't' }))}`,
    JSON.stringify({ dir: 's2c', frame: rpcNotification('turn/started', { threadId: 't' }) }),
    JSON.stringify({ dir: 's2c', frame: rpcError(2, -32000, 'usage limit') }),
  ].join('\n'));
  const results = await replay(control, file);
  assert.equal(results.length, 5);
  assert.deepEqual(seen.map((s) => s.slice(0, 2)), [
    ['clientRequest', 'thread/start'], ['serverResponse', 'thread/start'], ['clientRequest', 'turn/start'],
    ['serverNotification', 'turn/started'], ['serverResponse', 'turn/start'],
  ]);
});

function after(t, control) { t.after(() => control.cleanup()); }

test('graph-integrity G6.4: a mod does not defer a request: {defer: true} is an invalid result (a fault) and the request goes on; nothing to answer it with', async (t) => {
  const Q = 'item/tool/requestUserInput';
  const { ctx, control } = createFakeHostContext({ manifest: manifest(), grants: [`appServer.intercept:${Q}`, 'appServer.intercept:turn/start'] });
  after(t, control);
  ctx.appServer.intercept('serverRequest', [Q], () => ({ defer: true }));
  const r = await control.deliver('serverRequest', rpcRequest('s:1', Q, {}));
  assert.equal(r.outcome, 'forward');
  assert.deepEqual([control.faults[0].kind, /does not defer/.test(control.faults[0].message)], ['invalid', true]);
  ctx.appServer.intercept('clientRequest', ['turn/start'], () => ({ defer: true }));
  assert.equal((await control.deliver('clientRequest', rpcRequest('c:1', 'turn/start', { threadId: 't1', input: [] }))).outcome, 'forward');
  for (const m of ['onDeferred', 'onResolved', 'respond', 'release']) assert.equal(ctx.appServer[m], undefined, m);
});

test('the scheduler in the fake host context: durable jobs in retained storage, an interrupted one delivered once as uncertain after a relaunch', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mk = (retained) => createFakeHostContext({ manifest: manifest(), grants: ['appServer.request'], retained });
  const first = mk();
  const effects = [];
  first.ctx.scheduler.on('j', async (job) => { effects.push(job.delivery); await new Promise(() => {}); });   // dies mid-effect
  await first.ctx.scheduler.schedule({ id: 'j', at: Date.now() + 20, generation: 1 });
  assert.equal(first.ctx.threads, undefined, 'no holds (graph-integrity G6.8): a mod keeps what it stopped in its own storage');
  await sleep(100);
  assert.deepEqual(effects, ['normal']);
  // simulated relaunch: the retained export is passed to a new context
  const retained = first.control.storage.exportRetained();
  const second = mk(retained);
  const seen = [];
  second.ctx.scheduler.on('j', (job) => { seen.push(job.delivery); });
  await sleep(100);
  assert.deepEqual(seen, ['uncertain']);
  await second.control.deactivate();
  first.control.cleanup(); second.control.cleanup();
});

test('settings (SDK v2): a key at a scope, set and reset, onChange with what changed', async () => {
  const settings = [{ key: 'model', kind: 'choice', title: 'Model', description: 'Which', default: 'a', scope: 'thread', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }];
  const { ctx } = createFakeHostContext({ manifest: { ...manifest(), settings } });
  const seen = [];
  ctx.settings.onChange((doc, change) => seen.push([doc.model, change]));
  const T = { provider: 'codex', id: 't1' };
  assert.equal(await ctx.settings.get('model', { thread: T }), 'a');
  await ctx.settings.set('model', 'b', { scope: { thread: T } });
  assert.equal(await ctx.settings.get('model', { thread: T }), 'b');
  assert.equal(await ctx.settings.get('model'), 'a', 'the app\'s is unchanged');
  await assert.rejects(ctx.settings.set('model', 'x'), /cannot be/);
  await ctx.settings.reset('model', { scope: { thread: T } });
  assert.deepEqual(seen, [['a', { key: 'model', scope: { thread: T }, value: 'b' }], ['a', { key: 'model', scope: { thread: T }, value: 'a' }]]);
  assert.deepEqual(await ctx.settings.get(), { model: 'a' });
});

test('F8: ctx.permissions in the kit: a required one is allow, an optional one its decision, a request answered as the test says, a change heard', async () => {
  const { ctx, control } = createFakeHostContext({ manifest: { ...manifest(), permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read'] } });
  assert.equal(await ctx.permissions.state('ui'), 'allow');
  assert.equal(await ctx.permissions.state('secrets'), 'ask');
  assert.equal(await ctx.permissions.state('graph.read'), 'deny');
  await assert.rejects(ctx.permissions.state('network'), code('Invalid'));
  assert.deepEqual(await ctx.permissions.request('graph.read'), { granted: false }, 'the user did not answer Allow');
  const heard = [];
  ctx.permissions.onChange((g, d) => heard.push([g, d]));
  control.permissions.answer(true);
  assert.deepEqual(await ctx.permissions.request('graph.read'), { granted: true });
  assert.equal(await ctx.permissions.state('graph.read'), 'allow');
  control.permissions.decide('secrets', 'deny');
  assert.deepEqual(heard, [['graph.read', 'allow'], ['secrets', 'deny']]);
});
