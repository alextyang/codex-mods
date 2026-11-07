import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeHarness, installMod, attachWindow, waitFor, sleep } from './helpers.mjs';

const REPORT = (items, at = '2026-10-11T10:00:00.000Z', complete = true) => ({ t: 'probe', report: { appBuild: '26.1007.21159-20052', at, items, complete } });

test('renderer channel: modules are sent on attach and after every activate/deactivate (url = codexmod://<id>/<rev>/<entry>)', async () => {
  const h = await makeHarness();
  try {
    const w1 = attachWindow(h.runtime, 1);
    await waitFor(() => w1.lastModules());
    assert.deepEqual(w1.lastModules(), []);
    const ui = await installMod(h.layout, { id: 'test.ui1', version: '2.3.4', renderer: 'export default {};', host: 'export default { host() {} };' });
    const hostOnly = await installMod(h.layout, { id: 'test.hostonly', host: 'export default { host() {} };' });
    await h.runtime.activate(hostOnly);
    await h.runtime.activate(ui);
    await waitFor(() => w1.lastModules().length === 1);
    const [m] = w1.lastModules();
    const rev1 = h.announces.find((a) => a.modId === 'test.ui1' && a.module).module.rev;
    assert.deepEqual(m, { modId: 'test.ui1', url: `codexmod://test.ui1/${rev1}/renderer.mjs`, version: '2.3.4', dataDir: ui.dataDir });
    const w2 = attachWindow(h.runtime, 2);                       // a window opened later gets the full list
    await waitFor(() => w2.lastModules());
    assert.deepEqual(w2.lastModules(), [m]);
    await h.runtime.deactivate('test.ui1', 'off');
    await waitFor(() => w1.lastModules().length === 0 && w2.lastModules().length === 0);
    await h.runtime.activate(ui);
    await waitFor(() => w1.lastModules().length === 1);
    assert.notEqual(w1.lastModules()[0].url, m.url, 'a new activation has a new rev');
    w1.disposable.dispose(); w2.disposable.dispose();
  } finally { await h.close(); }
});

test('renderer realm: no intercept, no processes (Denied at the Host too); inactive and host-only mods are refused', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.rr', renderer: 'export default {};', grants: ['appServer.intercept', 'processes', 'appServer.request'],
      processes: { p: { command: 'p.mjs', start: 'on-demand' } } });
    const hostOnly = await installMod(h.layout, { id: 'test.ho', host: 'export default {};' });
    await h.runtime.activate(mod); await h.runtime.activate(hostOnly);
    const w = attachWindow(h.runtime);
    const c = w.ctx('test.rr');
    assert.equal(c.appServer.intercept, undefined);
    assert.equal(c.processes, undefined);
    assert.equal(typeof c.appServer.request, 'function');
    const replies = []; w.realmPort.onMessage((m) => replies.push(m));
    w.post({ t: 'call', id: 1, modId: 'test.rr', ns: 'processes', method: 'start', args: ['p'] });
    w.post({ t: 'handler', handler: 90, modId: 'test.rr', ns: 'appServer', method: 'intercept', args: ['clientRequest', '*', {}] });
    w.post({ t: 'call', id: 2, modId: 'test.ho', ns: 'storage', method: 'get', args: ['k'] });
    w.post({ t: 'call', id: 3, modId: 'not.active', ns: 'storage', method: 'get', args: ['k'] });
    await waitFor(() => [1, 2, 3].every((i) => replies.some((r) => r.id === i)) && replies.some((r) => r.sub === 90));
    assert.equal(replies.find((r) => r.id === 1).error.code, 'Denied');
    assert.equal(replies.find((r) => r.t === 'event' && r.sub === 90).error.code, 'Denied');
    assert.equal(replies.find((r) => r.id === 2).error.code, 'Denied');
    assert.equal(replies.find((r) => r.id === 3).error.code, 'Unavailable');
    assert.equal(h.mux.clients.get('mod:test.rr').interceptors.length, 0);
    // the renderer's appServer works for a mod that holds the grant
    assert.deepEqual(await c.appServer.request('thread/list', { a: 1 }), { echo: { method: 'thread/list', params: { a: 1 } } });
  } finally { await h.close(); }
});

test('probe: bus state framework/probe is the union across open windows and is recomputed when a window closes', async () => {
  const h = await makeHarness();
  try {
    const a = attachWindow(h.runtime, 1); const b = attachWindow(h.runtime, 2);
    a.post(REPORT({ 'anchor:composer': true, 'anchor:statusbar': false, 'component:Button': true }, '2026-10-11T10:00:00.000Z'));
    b.post(REPORT({ 'anchor:composer': false, 'anchor:statusbar': true, 'component:Menu': false }, '2026-10-11T11:00:00.000Z'));
    await waitFor(() => h.bus.state('framework/probe')?.items['component:Menu'] === false);
    assert.deepEqual(h.bus.state('framework/probe'), {
      appBuild: '26.1007.21159-20052', at: '2026-10-11T11:00:00.000Z', complete: true, bindings: {},
      items: { 'anchor:composer': true, 'anchor:statusbar': true, 'component:Button': true, 'component:Menu': false },
    });
    b.disposable.dispose();               // window 2 goes away: its items drop out
    await waitFor(() => h.bus.state('framework/probe')?.items['anchor:statusbar'] === false);
    assert.deepEqual(h.bus.state('framework/probe').items, { 'anchor:composer': true, 'anchor:statusbar': false, 'component:Button': true });
    a.post(REPORT({ 'anchor:composer': false }, '2026-10-11T12:00:00.000Z'));   // re-probe after an adapter-relevant change
    await waitFor(() => h.bus.state('framework/probe').items['anchor:composer'] === false);
    a.disposable.dispose();               // the last window closes: the last union stays (a state topic cannot be unset)
    await sleep(20);
    assert.equal(h.bus.state('framework/probe').items['anchor:composer'], false);
  } finally { await h.close(); }
});

test('renderer faults are published and count toward quarantine', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.rf', renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const w = attachWindow(h.runtime, 5);
    for (let i = 0; i < 3; i++) w.post({ t: 'fault', modId: 'test.rf', message: `render crash ${i}`, stack: 'x' });
    w.post({ t: 'fault', message: 'no modId: ignored' });
    await waitFor(() => h.quarantines.length === 1);
    assert.deepEqual(h.quarantines, [{ modId: 'test.rf', reason: 'faults' }]);
    await sleep(20);
    const faults = h.topic('framework/fault');
    assert.equal(faults.length, 3);
    assert.ok(faults.every((f) => f.realm === 'renderer' && f.modId === 'test.rf'));
  } finally { await h.close(); }
});

test('deactivating a mod closes its renderer subscriptions and handlers', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.rs2', renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const w = attachWindow(h.runtime);
    const c = w.ctx('test.rs2');
    const got = [];
    c.events.on('mod/test.rs2/*', (d) => got.push(d));
    c.services.provide('svc', { m: () => 1 });
    await sleep(30);
    c.events.emit('mod/test.rs2/a', 1);
    await waitFor(() => got.length === 1);
    assert.equal(await h.runtime.callServiceForLease('mod:test.rs2', { name: 'svc', method: 'm', args: null }), 1);
    await h.runtime.deactivate('test.rs2', 'off');
    h.bus.publish('mod/test.rs2/b', 2);
    await sleep(30);
    assert.equal(got.length, 1);
    await assert.rejects(h.runtime.callServiceForLease('mod:test.rs2', { name: 'svc', method: 'm', args: null }), { code: 'Unavailable' });
    await assert.rejects(c.storage.get('k'), { code: 'Unavailable' });
  } finally { await h.close(); }
});

test('a window attached twice replaces the first channel; closing the port detaches the window', async () => {
  const h = await makeHarness();
  try {
    const first = attachWindow(h.runtime, 7);
    first.realmPort.onClose(() => {});
    const second = attachWindow(h.runtime, 7);
    await waitFor(() => second.lastModules());
    first.disposable.dispose();   // already replaced: must not disturb the second
    const mod = await installMod(h.layout, { id: 'test.rw', renderer: 'export default {};' });
    await h.runtime.activate(mod);
    await waitFor(() => second.lastModules().length === 1);
    second.hostPort.close();
    await sleep(20);
    await h.runtime.deactivate('test.rw', 'x');
  } finally { await h.close(); }
});

test('realm-client uses no Node API: it runs in a bare vm context with ECMAScript built-ins only', async () => {
  // The client and the presentation rules' module it imports (docs/design/systems.md E2), both Node-free.
  const rulesSrc = await readFile(new URL('../../../shared/ui-rules-client.mjs', import.meta.url), 'utf8');
  const src = `${await readFile(new URL('../../../shared/realm-client.mjs', import.meta.url), 'utf8')}\n${rulesSrc}`;
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/ctx\.process\b/g, '').replace(/'process'/g, '').replace(/\bprocess:/g, '');
  assert.ok(!/\bnode:/.test(code), 'no node: specifier');
  const hit = /\b(process|Buffer|require|setTimeout|setInterval|setImmediate|queueMicrotask|console|__dirname|global)\b/.exec(code);
  assert.equal(hit, null, `Node global referenced: ${hit?.[0]}`);
  const body = src.replace(/^import .*$/gm, '').replace(/^export (function|const)/gm, '$1');
  const stub = `class CodexModsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    static fromJSON(v) { return new CodexModsError(v.code, v.message, v.details); } }`;
  const sandbox = vm.createContext({});             // only ECMAScript intrinsics: no process, Buffer, require, timers, console
  const createRealmClient = vm.runInContext(`${stub}\n${body}\ncreateRealmClient;`, sandbox);
  const sent = []; let deliver;
  const client = createRealmClient({ post: (m) => sent.push(m), onMessage: (fn) => { deliver = fn; return { dispose() {} }; } });
  const ctx = client.context('m.x', 'host', { id: 'm.x', version: '1', dataDir: '/d' });
  const p = ctx.storage.get('k');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { t: 'call', id: 1, modId: 'm.x', ns: 'storage', method: 'get', args: ['k'] });
  deliver({ t: 'result', id: 1, value: { v: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(await p)), { v: 1 });
  // no ctx.agent: what the agent gets is the graph's acts, with the SDK's helpers (graph-integrity G3.5)
  assert.deepEqual(Object.keys(ctx).sort(), ['appServer', 'events', 'graph', 'intelligence', 'log', 'mod', 'permissions', 'processes', 'secrets', 'services', 'settings', 'storage', 'ui']);
  // ctx.graph: the host realm has every member; the renderer realm the reads and invoke (presentations.md V6), kept in step with
  // the Host's RENDERER_MEMBERS (ctx/graph.mjs) and sdk/index.d.ts RendererGraph; the process realm none.
  const GRAPH_READS = ['assess', 'attached', 'can', 'invoke', 'list', 'query', 'related', 'resolve', 'search', 'subscribe', 'types'];
  assert.deepEqual(Object.keys(ctx.graph).sort(), [...GRAPH_READS, 'after', 'attach', 'defaults', 'intercept', 'invokeAll', 'made', 'override', 'policies', 'policy', 'provide', 'registerTypes'].sort());
  const rctx = client.context('m.x', 'renderer', { id: 'm.x', version: '1', dataDir: '/d' });
  assert.deepEqual(Object.keys(rctx).sort(), ['appServer', 'events', 'graph', 'intelligence', 'log', 'mod', 'permissions', 'secrets', 'services', 'settings', 'storage']);
  assert.ok(!('processes' in rctx) && !('intercept' in rctx.appServer));
  assert.deepEqual(Object.keys(rctx.graph).sort(), GRAPH_READS);
  sent.length = 0;
  const query = { ref: { type: 'T', provider: 'p', id: '1' }, depth: 'core' };
  const view = rctx.graph.subscribe(query, () => {});
  rctx.graph.invoke({ type: 'T', provider: 'p', id: '1' }, 'rename', ['x']);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { t: 'sub', sub: 1, modId: 'm.x', ns: 'graph', method: 'subscribe', args: [query, {}], credit: true },
    { t: 'call', id: 2, modId: 'm.x', ns: 'graph', method: 'invoke', args: [{ type: 'T', provider: 'p', id: '1' }, 'rename', ['x']] }]);
  view.dispose();
  const pctx = client.context('m.x', 'process', { id: 'm.x', version: '1', dataDir: '/d' });
  assert.ok(!('processes' in pctx) && 'intercept' in pctx.appServer);
  // a mod's process: the graph's reads, a view and invoke (graph-integrity G8.2), none of the host realm's providing or intercepting
  assert.deepEqual(Object.keys(pctx.graph).sort(), Object.keys(rctx.graph).sort());
});

test('probe: incomplete reports are kept per window but never published; nothing is published until a complete one exists', async () => {
  const h = await makeHarness();
  try {
    const a = attachWindow(h.runtime, 1); const b = attachWindow(h.runtime, 2);
    a.post(REPORT({ 'anchor:composer': true }, '2026-10-11T10:00:00.000Z', false));
    b.post({ t: 'probe', report: { appBuild: 'x', at: '2026-10-11T10:00:01.000Z', items: { 'anchor:sidebar': true } } }); // complete missing = incomplete
    await sleep(50);
    assert.equal(h.bus.state('framework/probe'), undefined);
    assert.equal(h.topic('framework/probe').length, 0);
    b.post(REPORT({ 'anchor:statusbar': true, 'anchor:composer': false }, '2026-10-11T10:00:02.000Z', true));
    await waitFor(() => h.bus.state('framework/probe'));
    assert.deepEqual(h.bus.state('framework/probe').items, { 'anchor:statusbar': true, 'anchor:composer': false },
      'window 1\'s incomplete report does not contribute');
    a.post(REPORT({ 'anchor:composer': true }, '2026-10-11T10:00:03.000Z', true));
    await waitFor(() => h.bus.state('framework/probe').items['anchor:composer'] === true);
    a.post(REPORT({ 'anchor:composer': false, 'anchor:x': true }, '2026-10-11T10:00:04.000Z', false)); // a reload's bootstrap probe
    await sleep(50);
    assert.deepEqual(h.bus.state('framework/probe').items, { 'anchor:statusbar': true, 'anchor:composer': false });
    assert.equal(h.bus.state('framework/probe').complete, true, 'the published union itself carries complete:true');
  } finally { await h.close(); }
});
