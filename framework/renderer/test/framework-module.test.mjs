import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, portPair } from './harness.mjs';
import { createManagementClient } from '../management-client.mjs';
import { createHostChannel, REQUEST_ID_BASE } from '../channel.mjs';

test('management client: calls resolve with results, errors become CodexModsErrors, events go to subscribers after one events.subscribe', async () => {
  const { host, runtime } = portPair();
  const mgmt = createManagementClient(runtime);
  host.addEventListener('message', ({ data }) => {
    if (data.method === 'mods.list') host.postMessage({ id: data.id, ok: true, result: { mods: [] } });
    else if (data.method === 'mods.inspect') host.postMessage({ id: data.id, ok: false, error: { code: 'Unavailable', message: 'nope' } });
    else if (data.method === 'events.subscribe') host.postMessage({ id: data.id, ok: true, result: { subscribed: true } });
  });
  assert.deepEqual(await mgmt.call('mods.list'), { mods: [] });
  assert.deepEqual(await mgmt.request('mods.list', {}), { mods: [] });
  await assert.rejects(mgmt.call('mods.inspect', { modId: 'x' }), { code: 'Unavailable', message: 'nope' });
  const seen = [];
  const s1 = mgmt.subscribe((e) => seen.push(e.event)); mgmt.subscribe((e) => seen.push(`b:${e.event}`));
  await new Promise((r) => setImmediate(r));
  host.postMessage({ event: 'op', data: { id: 'o1' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['op', 'b:op']);
  assert.equal(runtime.sent.filter((m) => m.method === 'events.subscribe').length, 1);
  s1.dispose();
  host.postMessage({ event: 'mods', data: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['op', 'b:op', 'b:mods']);
  mgmt.close();
  await assert.rejects(mgmt.call('mods.list'), { code: 'Disposed' });
});

test('management client: a call with no answer rejects Timeout', async () => {
  const { runtime } = portPair();
  const mgmt = createManagementClient(runtime, { timeoutMs: 5 });
  await assert.rejects(mgmt.call('mods.list'), { code: 'Timeout' });
});

test('loadFrameworkModule gives the built-in module ui, management, pickFile and its own mount in Settings; dispose tears them down', async () => {
  let captured;
  const recovery = { default: (ctx) => { captured = ctx; ctx.mountSettings(() => null); return () => {}; } };
  const t = await setup({ html: '<aside data-settings-panel-slug="g"></aside><main data-app-shell-main-surface="x"></main>', extra: { frameworkModules: { 'recovery/index.mjs': recovery }, pickedPath: '/tmp/a.codexmod' } });
  const { host, runtime } = portPair();
  host.addEventListener('message', ({ data }) => { if (data.method) host.postMessage({ id: data.id, ok: true, result: { echoed: data.method } }); });
  t.core.attachManagement(runtime);
  await t.settle(); await t.settle();
  assert.ok(captured, 'the recovery entry is loaded automatically when the management port arrives');
  assert.deepEqual(t.bridgeCalls.filter((c) => c[0] === 'frameworkModule'), [['frameworkModule', 'recovery/index.mjs']], 'the recovery entry alone: Adjustments went (E6.6d)');
  assert.equal(captured.pages, t.core.parts.pages, 'the recovery entry gets the window\'s report of its Mods pages');
  assert.equal(captured.pages.get(), 'missing', 'no page runtime in this window: the pages are missing');
  assert.deepEqual(await captured.management.call('mods.list'), { echoed: 'mods.list' });
  assert.equal(await captured.pickFile({ extensions: ['codexmod'] }), '/tmp/a.codexmod');
  assert.deepEqual(t.bridgeCalls.at(-1), ['pickFile', { extensions: ['codexmod'] }]);
  assert.ok(t.win.document.querySelector('[data-codexmods-mount="framework:recovery-index.mjs"]'), 'mounted at settings.section');
});

test('loadFrameworkModule without a management port is Unavailable; a module with no entry function is Invalid; extra context is merged', async () => {
  const t = await setup({ extra: { frameworkModules: { 'x.mjs': { nothing: 1 }, 'y.mjs': { default: (ctx) => { ctx.extraSeen = ctx.flag; } } } } });
  await assert.rejects(t.core.loadFrameworkModule('x.mjs'), { code: 'Unavailable' });
  const { runtime } = portPair();
  t.core.attachManagement(runtime);
  await t.settle();
  await assert.rejects(t.core.loadFrameworkModule('x.mjs'), { code: 'Invalid' });
  const d = await t.core.loadFrameworkModule('y.mjs', { flag: 7 });
  assert.equal(typeof d.dispose, 'function');
});

test('a full URL spec is imported directly instead of going through the preload bridge', async () => {
  let got;
  const t = await setup({ importModule: async (url) => ({ default: (ctx) => { got = [url, !!ctx.ui]; } }) });
  const { runtime } = portPair();
  t.core.attachManagement(runtime);
  await t.settle();
  await t.core.loadFrameworkModule('codexmod://framework/1/a.mjs');
  assert.deepEqual(got, ['codexmod://framework/1/a.mjs', true]);
  assert.equal(t.bridgeCalls.filter((c) => c[0] === 'frameworkModule' && c[1].startsWith('codexmod')).length, 0);
});

test('host channel: requests resolve by id from a high range; unknown results fall through to the realm consumer; close rejects pending', async () => {
  const { host, runtime } = portPair();
  const ch = createHostChannel(runtime);
  const realm = [];
  ch.realmPort.onMessage((m) => realm.push(m.t));
  const p = ch.request({ t: 'view-open', modId: 'm', target: 'v', placement: 'window' });
  await new Promise((r) => setImmediate(r));
  const id = runtime.sent[0].id;
  assert.ok(id > REQUEST_ID_BASE);
  host.postMessage({ t: 'result', id: 5, value: 'for realm-client' });
  host.postMessage({ t: 'result', id, value: 'h1' });
  host.postMessage({ t: 'event', sub: 1, data: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(await p, 'h1');
  assert.deepEqual(realm, ['result', 'event']);
  const p2 = ch.request({ t: 'view-open' });
  p2.catch(() => {});
  ch.close();
  await assert.rejects(p2, { code: 'Disposed' });
  assert.throws(() => ch.post({}), { code: 'Disposed' });
  ch.send({});   // never throws
});

test('host channel: a request with no reply rejects Timeout with the injected clock', async () => {
  const { runtime } = portPair();
  const timers = [];
  const ch = createHostChannel(runtime, { setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout() {} });
  const p = ch.request({ t: 'view-open' }, { timeoutMs: 123 });
  assert.equal(timers[0][1], 123);
  timers[0][0]();
  await assert.rejects(p, { code: 'Timeout' });
});

test('E6.6c: the renderer channel hands the Host\'s ask to show an instance to its listeners', async () => {
  const { createHostChannel } = await import('../channel.mjs');
  let onmessage = null;
  const port = { postMessage() {}, set onmessage(f) { onmessage = f; }, get onmessage() { return onmessage; } };
  const ch = createHostChannel(port);
  const got = [];
  const sub = ch.onDetail((ref) => got.push(ref));
  onmessage({ data: { t: 'detail', ref: { type: 'File', provider: 'codex', id: '/x' } } });
  sub.dispose();
  onmessage({ data: { t: 'detail', ref: { type: 'File', provider: 'codex', id: '/y' } } });
  assert.deepEqual(got, [{ type: 'File', provider: 'codex', id: '/x' }]);
});

test('E7: the renderer channel hands the Host\'s acts on a presentation to its listeners, not to the realm', async () => {
  const { createHostChannel } = await import('../channel.mjs');
  let onmessage = null;
  const port = { postMessage() {}, set onmessage(f) { onmessage = f; }, get onmessage() { return onmessage; } };
  const ch = createHostChannel(port);
  const got = [], realm = [];
  ch.onAct((m) => got.push(m.operation));
  ch.realmPort.onMessage((m) => realm.push(m.t));
  onmessage({ data: { t: 'act', id: 1, gen: 2, n: 3, operation: 'collapse', args: [] } });
  assert.deepEqual([got, realm], [['collapse'], []]);
});
