import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, portPair } from './harness.mjs';

const mod = (renderer) => ({ default: { renderer } });

test('modules message → module loaded with a RendererContext carrying realm namespaces plus ui; unloading disposes everything', async () => {
  const t = await setup();
  let disposed = 0; let ctxSeen;
  t.modulesByUrl.set('codexmod://m1/1/r.mjs', mod((ctx) => {
    ctxSeen = ctx;
    return () => { disposed++; };
  }));
  await t.send(t.modulesMsg([{ modId: 'm1', url: 'codexmod://m1/1/r.mjs' }]));
  assert.equal(ctxSeen.marker, 'ctx:m1');
  assert.deepEqual(ctxSeen.mod, { id: 'm1', version: '1.0.0', dataDir: '/data' });
  assert.equal(typeof ctxSeen.ui.commands.add, 'function');
  for (const v1 of ['mount', 'contribute', 'hooks', 'action', 'views', 'dialog']) assert.equal(v1 in ctxSeen.ui, false, `ui.${v1} is retired`);
  assert.equal('register' in ctxSeen.ui.commands, false, 'ui.commands.register is retired');
  await t.send({ t: 'modules', modules: [] });
  assert.equal(disposed, 1);
  assert.throws(() => ctxSeen.ui.status({ id: 's', place: 'titleBar', text: 'x' }), { code: 'Disposed' });
});

test('the realm client gets every channel message except `modules` and the runtime\'s own replies', async () => {
  const t = await setup();
  const seen = [];
  t.realmPorts[0].onMessage((m) => seen.push(m.t));
  await t.send({ t: 'modules', modules: [] });
  await t.send({ t: 'result', id: 3, value: 1 });
  await t.send({ t: 'settings', modId: 'x', value: {} });
  await t.send({ t: 'result', id: 1_000_000_099, value: 'ignored: no such pending request' });
  assert.deepEqual(seen, ['result', 'settings']);
});

test('a module that throws on activation is reported as a fault with its modId, cleaned up, and not retried; others still load', async () => {
  const t = await setup();
  let badCtx;
  t.modulesByUrl.set('codexmod://bad/1/r.mjs', mod((ctx) => { badCtx = ctx; throw new Error('activation boom'); }));
  t.modulesByUrl.set('codexmod://ok/1/r.mjs', mod(() => {}));
  const list = [{ modId: 'bad', url: 'codexmod://bad/1/r.mjs' }, { modId: 'ok', url: 'codexmod://ok/1/r.mjs' }];
  await t.send(t.modulesMsg(list));
  const faults = t.fromRuntime('fault');
  assert.equal(faults.length, 1);
  assert.equal(faults[0].modId, 'bad');
  assert.match(faults[0].message, /activation boom/);
  assert.throws(() => badCtx.ui.status({ id: 's', place: 'titleBar', text: 'x' }), { code: 'Disposed' }, 'its scope went with it');
  assert.deepEqual(t.core.parts.loader.loadedIds(), ['ok']);
  await t.send(t.modulesMsg(list));
  assert.equal(t.fromRuntime('fault').length, 1, 'same url is not retried');
  t.modulesByUrl.set('codexmod://bad/2/r.mjs', mod(() => { throw new Error('second boom'); }));
  await t.send(t.modulesMsg([{ modId: 'bad', url: 'codexmod://bad/2/r.mjs' }, list[1]]));
  assert.equal(t.fromRuntime('fault').length, 2, 'a new rev is retried');
});

test('missing renderer entry and failing import are faults, not crashes', async () => {
  const t = await setup();
  t.modulesByUrl.set('codexmod://noentry/1/r.mjs', { default: { host() {} } });
  const p = t.send(t.modulesMsg([{ modId: 'noentry', url: 'codexmod://noentry/1/r.mjs' }, { modId: 'gone', url: 'codexmod://gone/1/r.mjs' }]));
  for (const ms of [0, 250, 500, 1000, 100]) { t.win.clock.tick(ms); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }
  await p; await t.settle();
  assert.deepEqual(t.fromRuntime('fault').map((f) => f.modId).sort(), ['gone', 'noentry']);
});

test('a changed url (new rev) reloads the module; the old instance is disposed first', async () => {
  const t = await setup();
  const log = [];
  t.modulesByUrl.set('codexmod://m/1/r.mjs', mod(() => { log.push('load1'); return () => log.push('dispose1'); }));
  t.modulesByUrl.set('codexmod://m/2/r.mjs', mod(() => { log.push('load2'); }));
  await t.send(t.modulesMsg([{ modId: 'm', url: 'codexmod://m/1/r.mjs' }]));
  await t.send(t.modulesMsg([{ modId: 'm', url: 'codexmod://m/2/r.mjs' }]));
  assert.deepEqual(log, ['load1', 'dispose1', 'load2']);
});

test('the probe reports react, anchors seen so far and real components; and re-posts when an anchor appears later', async () => {
  const t = await setup();
  await t.settle();
  const first = t.fromRuntime('probe').at(-1).report;
  assert.equal(first.appBuild, '26.1007.21159-20052');
  assert.equal(first.items.react, true);
  assert.equal(first.items['anchor:workspace'], true);
  assert.equal(first.items['anchor:sidebar'], true);
  assert.equal(first.items['anchor:settings.section'], false);
  assert.equal(first.items['component:Button'], false, 'no real exports in this window');
  assert.equal(first.items['component:Select'], true, 'the kit\'s, in every window');
  const n = t.fromRuntime('probe').length;
  await t.settle(); await t.settle();
  assert.equal(t.fromRuntime('probe').length, n, 'unchanged → not re-posted');
  const aside = t.win.document.createElement('aside');
  aside.setAttribute('data-settings-panel-slug', 'general');
  t.win.document.body.insertBefore(aside, t.win.document.body.firstChild);
  await t.settle(); t.win.clock.tick(2500); await t.settle();
  const last = t.fromRuntime('probe').at(-1).report;
  assert.equal(last.items['anchor:settings.section'], true);
  t.win.document.body.removeChild(aside);
  t.win.clock.tick(2500); await t.settle();
  assert.equal(t.fromRuntime('probe').at(-1).report.items['anchor:settings.section'], true, 'sticky once seen');
});

test('the probe notices real components appearing after startup', async () => {
  const t = await setup();
  await t.settle();
  assert.equal(t.fromRuntime('probe').at(-1).report.items['component:Button'], false);
  t.exportsObj.Button = function Button() {};
  t.win.clock.tick(2500); await t.settle();
  assert.equal(t.fromRuntime('probe').at(-1).report.items['component:Button'], true);
});

test('without the app React the runtime still starts: notify is Unavailable, probe says react:false', async () => {
  const t = await setup({ withReact: false });
  await t.settle();
  assert.equal(t.fromRuntime('probe').length, 1, 'only the immediate startup report; the periodic probe waits for readiness');
  assert.equal(t.fromRuntime('probe')[0].report.items.react, false);
  const scope = t.core.parts.uiFactory.forMod('m');
  assert.throws(() => scope.ui.notify({ title: 'x' }), { code: 'Unavailable' }, 'without the Host\'s rules: the declaration refuses');
  assert.equal(scope.ui.react, undefined);
});

test('the renderer realm\'s ui has every member of the shared rule API; without a rules channel each refuses', async () => {
  const t = await setup();
  const sent = [];
  const channel = { register: async (desc) => { sent.push(desc); return { order: sent.length }; }, dispose: async () => true };
  const { ui } = t.core.parts.uiFactory.forMod('m', channel);
  for (const name of ['status', 'choices', 'banner', 'decorate', 'hide', 'panel', 'ask', 'filter']) assert.equal(typeof ui[name], 'function', name);
  for (const [ns, fns] of [['sidebar', ['order', 'section']], ['settings', ['page', 'open', 'section']], ['commands', ['add']], ['content', ['code', 'link']]]) {
    for (const f of fns) assert.equal(typeof ui[ns][f], 'function', `${ns}.${f}`);
  }
  const h = ui.status({ id: 's1', place: 'titleBar', text: 'Synced' });
  await t.settle();
  assert.equal(sent.at(-1).kind, 'add');
  h.dispose();
  const bare = t.core.parts.uiFactory.forMod('m2').ui;
  assert.throws(() => bare.status({ id: 's', place: 'titleBar', text: 'x' }), { code: 'Unavailable' });
  assert.throws(() => bare.sidebar.section({ id: 's' }), { code: 'Unavailable' });
  assert.throws(() => bare.settings.section({ id: 's' }), { code: 'Unavailable' });
});

test('ui.theme is reactive through the mod scope and its subscription dies with the scope', async () => {
  const t = await setup();
  t.win.setVar('--color-text', '#111');
  const scope = t.core.parts.uiFactory.forMod('m');
  const seen = [];
  scope.ui.theme.onChange((tokens) => seen.push(tokens.text));
  await t.settle();
  t.win.setVar('--color-text', '#222');
  await t.settle();
  assert.deepEqual(seen, ['#222']);
  assert.equal(scope.ui.theme.tokens().text, '#222');
  scope.dispose();
  t.win.setVar('--color-text', '#333');
  await t.settle();
  assert.deepEqual(seen, ['#222']);
  assert.throws(() => scope.ui.status({ id: 's', place: 'titleBar', text: 'x' }), { code: 'Disposed' });
});

test('close() unloads modules and tears everything down', async () => {
  const t = await setup();
  let disposed = 0;
  t.modulesByUrl.set('codexmod://m/1/r.mjs', mod(() => () => disposed++));
  await t.send(t.modulesMsg([{ modId: 'm', url: 'codexmod://m/1/r.mjs' }]));
  t.core.parts.mounts.mount('framework:band', 'workspace', () => null);
  await t.core.close();
  assert.equal(disposed, 1);
  assert.equal(t.win.document.querySelector('[data-codexmods-mount]'), null);
  assert.equal(t.win.document._observers.size, 0);
});

test('a second renderer port is ignored (one channel per window)', async () => {
  const t = await setup();
  const { runtime } = portPair();
  t.core.attachRenderer(runtime);
  assert.equal(t.realmPorts.length, 1);
});

test('the periodic re-check also reconciles mounts (safety net for attribute-driven anchor changes)', async () => {
  const t = await setup({ html: '<div id="w" data-app-shell-workspace-layout="x"></div>' });
  await t.settle();
  const h = t.core.parts.mounts.mount('framework:band', 'workspace', () => null);
  assert.equal(h.degraded, false);
  await t.settle();        // let the reconcile caused by our own insertion run first
  t.win.document.querySelector('#w').removeAttribute('data-app-shell-workspace-layout');   // attribute-only: the tree observer does not see it
  await t.settle();
  assert.equal(h.degraded, false);
  t.win.clock.tick(2500); await t.settle();
  assert.equal(h.degraded, true);
});

test('the runtime always speaks first: a probe is posted at attach, before the app has loaded', async () => {
  const t = await setup({ withReact: false });
  assert.equal(t.runtime.sent[0].t, 'probe');
  assert.equal(t.runtime.sent[0].report.items.react, false);
});

test('probe.complete: the bootstrap report is incomplete; the refined report is complete once React and the shell anchor are there', async () => {
  const t = await setup();
  const probes = () => t.fromRuntime('probe');
  assert.equal(probes()[0].report.complete, false, 'bootstrap probe sent at attach');
  await t.settle();
  assert.equal(probes().at(-1).report.complete, true);
  assert.equal(probes().at(-1).report.items['anchor:sidebar'], true);
  // sticky: losing the sidebar later does not make the report non-authoritative again
  t.win.document.querySelector('nav').remove();
  t.win.clock.tick(2500); await t.settle();
  assert.equal(probes().at(-1).report.complete, true);
});

test('probe.complete: settings content alone counts as the shell; a page that never reaches a shell (sign-in) stays incomplete forever', async () => {
  const settings = await setup({ html: '<aside data-settings-panel-slug="g"></aside><main data-app-shell-main-surface="x"></main>' });
  await settings.settle();
  assert.equal(settings.fromRuntime('probe').at(-1).report.complete, true);

  const t = await setup({ html: '<div id="signin"></div>' });
  await t.settle(); t.win.clock.tick(2500); await t.settle();
  t.win.clock.tick(120_000); await t.settle();
  assert.ok(t.fromRuntime('probe').length >= 1);
  assert.equal(t.fromRuntime('probe').every((p) => p.report.complete === false), true, 'no timer ever makes it complete');
  // ... and it completes the moment the shell does appear
  const nav = t.win.document.createElement('nav');
  nav.setAttribute('role', 'navigation'); nav.setAttribute('class', '_Navigation_x');
  t.win.document.body.appendChild(nav);
  t.win.clock.tick(2500); await t.settle();
  assert.equal(t.fromRuntime('probe').at(-1).report.complete, true);
  assert.equal(t.fromRuntime('probe').at(-1).report.items['anchor:sidebar'], true);
});

test('probe.complete: without the app React it stays incomplete however long it waits', async () => {
  const t = await setup({ withReact: false });
  await t.settle();
  t.win.clock.tick(120_000); await t.settle();
  assert.equal(t.fromRuntime('probe').every((p) => p.report.complete === false), true);
  assert.equal(t.fromRuntime('probe').at(-1).report.items.react, false);
});
