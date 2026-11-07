// preload.cjs against a fake `electron` module and a fake window (the real file is loaded; only its environment is faked).
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, '..', '..', '..', 'preload', 'preload.cjs');

function loadPreload({ href = 'app://-/index.html', isTop = true, hello = { runtime: '({ startRuntime(){} })', boot: { adapter: {}, appBuild: 'b' } }, invokeImpl, failInject = false, documentState = { readyState: 'complete', documentElement: {} }, kernelBoot = { abi: 1, bindings: [], taps: {} }, noBridge = false } = {}) {
  globalThis.document = documentState;
  delete globalThis.__codexmods;   // each load is a new page
  const u = new URL(href);
  const ipcHandlers = new Map(); const invokes = []; const executed = []; const listeners = new Map(); const posted = [];
  const syncs = []; const mainWorld = [];
  const contextBridge = noBridge ? undefined : { executeInMainWorld: (o) => { mainWorld.push(o); return o.func(...(o.args ?? [])); } };
  const ipcRenderer = { sendSync: (ch, ...args) => { syncs.push([ch, ...args]); return ch === 'codexmods:kernel' ? kernelBoot : null; }, on: (ch, f) => ipcHandlers.set(ch, f), invoke: async (ch, ...args) => { invokes.push([ch, ...args]); if (invokeImpl) { const r = await invokeImpl(ch, ...args); if (r !== undefined) return r; } if (ch === 'codexmods:hello') return hello; return null; } };
  const webFrame = { executeJavaScript: async (code) => { executed.push(code); if (failInject) throw new Error('Script failed to execute'); } };
  const win = {
    location: { protocol: u.protocol, hostname: u.hostname, search: u.search },
    addEventListener: (t, f) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); },
    postMessage: (data, origin, transfer) => posted.push({ data, origin, transfer }),
  };
  win.top = isTop ? win : {};
  globalThis.window = win; globalThis.location = win.location;
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? { ipcRenderer, webFrame, contextBridge } : origLoad.call(this, request, ...rest); };
  delete require.cache[PRELOAD];
  try { require(PRELOAD); } finally { Module._load = origLoad; }   // window/location stay installed: the preload uses them from its event handlers
  const flush = () => new Promise((r) => setImmediate(r));
  const fromRuntime = (data) => { for (const f of listeners.get('message') ?? []) f({ data, source: win }); };
  const noncefrom = () => executed[0] && JSON.parse(/\(function \(boot\) \{.*\}\)\((\{.*\})\);$/s.exec(executed[0])[1]).nonce;
  return { win, ipcHandlers, invokes, executed, posted, flush, fromRuntime, noncefrom, syncs, mainWorld,
    port: (kind, port) => ipcHandlers.get('codexmods:port')({ ports: [port] }, { kind }) };
}

test('injects the bundled runtime with the boot data and a per-load nonce, via webFrame.executeJavaScript', async () => {
  const p = loadPreload();
  await p.flush();
  assert.deepEqual(p.invokes[0], ['codexmods:hello', { search: '' }]);
  assert.equal(p.executed.length, 1);
  assert.match(p.executed[0], /const E = \(\{ startRuntime\(\)\{\} \}\);/);
  const nonce = p.noncefrom();
  assert.match(nonce, /^[0-9a-f]{32}$/);
});

test('ports from framework-main are queued until the runtime says it is ready, then forwarded with transfer', async () => {
  const p = loadPreload();
  await p.flush();
  const nonce = p.noncefrom();
  const rPort = { id: 'r' }; const mPort = { id: 'm' };
  p.port('renderer', rPort); p.port('management', mPort);
  assert.equal(p.posted.length, 0);
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'runtime-ready' });
  assert.equal(p.posted.length, 2);
  assert.deepEqual(p.posted[0], { data: { __codexmods: nonce, dir: 'to-runtime', kind: 'port', port: 'renderer' }, origin: '*', transfer: [rPort] });
  assert.deepEqual(p.posted[1].transfer, [mPort]);
  const late = { id: 'late' };
  p.port('renderer', late);
  assert.deepEqual(p.posted[2].transfer, [late], 'after ready, ports are forwarded immediately');
});

test('messages without the nonce, from another source, or for the wrong direction are ignored; bad port kinds are dropped', async () => {
  const p = loadPreload();
  await p.flush();
  const nonce = p.noncefrom();
  p.fromRuntime({ __codexmods: 'wrong', dir: 'to-preload', op: 'runtime-ready' });
  p.fromRuntime({ __codexmods: nonce, dir: 'to-runtime', op: 'runtime-ready' });
  p.port('renderer', { id: 1 });
  assert.equal(p.posted.length, 0, 'still queued: runtime never became ready');
  p.port('evil', { id: 2 }); p.port('renderer', undefined);
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'runtime-ready' });
  assert.equal(p.posted.length, 1);
});

test('framework-module request: main supplies the bundle, the preload registers it in the main world and replies with the key', async () => {
  const p = loadPreload({ invokeImpl: async (ch, name) => (ch === 'codexmods:framework-module' ? (name === 'adjustments/index.mjs' ? '({ default(){} })' : null) : undefined) });
  await p.flush();
  const nonce = p.noncefrom();
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'framework-module', reqId: 4, spec: 'adjustments/index.mjs' });
  await p.flush(); await p.flush();
  assert.deepEqual(p.invokes.at(-1), ['codexmods:framework-module', 'adjustments/index.mjs']);
  assert.match(p.executed.at(-1), /\(globalThis\.__codexmods_fwm \?\?= \{\}\)\["4:[0-9a-f]+"\] = \(\{ default\(\)\{\} \}\);/);
  const reply = p.posted.at(-1).data;
  assert.equal(reply.reply, 4); assert.equal(reply.ok, true); assert.match(reply.key, /^4:/);
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'framework-module', reqId: 5, spec: 'nope' });
  await p.flush(); await p.flush();
  assert.deepEqual({ ok: p.posted.at(-1).data.ok, reply: p.posted.at(-1).data.reply }, { ok: false, reply: 5 });
});

test('pick-file request: forwarded to main with sanitized extensions; result relayed', async () => {
  const p = loadPreload({ invokeImpl: async (ch) => (ch === 'codexmods:pick-file' ? '/tmp/a.codexmod' : undefined) });
  await p.flush();
  const nonce = p.noncefrom();
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'pick-file', reqId: 2, extensions: ['codexmod', 7, null] });
  await p.flush(); await p.flush();
  assert.deepEqual(p.invokes.at(-1), ['codexmods:pick-file', { extensions: ['codexmod'], directory: false }]);
  assert.deepEqual({ reply: p.posted.at(-1).data.reply, ok: p.posted.at(-1).data.ok, path: p.posted.at(-1).data.path }, { reply: 2, ok: true, path: '/tmp/a.codexmod' });
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'pick-file', reqId: 3, directory: true });
  await p.flush(); await p.flush();
  assert.deepEqual(p.invokes.at(-1), ['codexmods:pick-file', { extensions: [], directory: true }], 'a folder (E6.2)');
});

test('navigate request (E6.4): forwarded to main as a string path; whether it navigated is relayed', async () => {
  const p = loadPreload({ invokeImpl: async (ch, req) => (ch === 'codexmods:navigate' ? req.path === '/settings/codexmods' : undefined) });
  await p.flush();
  const nonce = p.noncefrom();
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'navigate', reqId: 5, path: '/settings/codexmods' });
  await p.flush(); await p.flush();
  assert.deepEqual(p.invokes.at(-1), ['codexmods:navigate', { path: '/settings/codexmods' }]);
  assert.deepEqual({ reply: p.posted.at(-1).data.reply, ok: p.posted.at(-1).data.ok, done: p.posted.at(-1).data.done }, { reply: 5, ok: true, done: true });
  p.fromRuntime({ __codexmods: nonce, dir: 'to-preload', op: 'navigate', reqId: 6, path: { evil: 1 } });
  await p.flush(); await p.flush();
  assert.deepEqual(p.invokes.at(-1), ['codexmods:navigate', { path: '' }]);
  assert.equal(p.posted.at(-1).data.done, false);
});

test('new-window (App.openWindow): framework-main\'s ask becomes the app\'s own request on its channel, only for the home or a chat', async () => {
  const p = loadPreload();
  await p.flush();
  const ask = (msg) => p.ipcHandlers.get('codexmods:new-window')({}, msg);
  ask({ path: '/local/th-1' });
  ask({ path: '/' });
  for (const bad of [{ path: '/settings/general' }, { path: '/local/a b' }, { path: 7 }, null]) ask(bad);
  await p.flush();
  assert.deepEqual(p.invokes.filter(([ch]) => ch === 'codex_desktop:message-from-view'), [
    ['codex_desktop:message-from-view', { type: 'open-in-new-window', path: '/local/th-1' }], ['codex_desktop:message-from-view', { type: 'open-in-new-window', path: '/' }],
  ]);
});

test('does nothing outside the app main frame: other origins and subframes', async () => {
  for (const opts of [{ href: 'https://example.com/' }, { href: 'codex-sandbox://x.web-sandbox.oaiusercontent.com/' }, { isTop: false }]) {
    const p = loadPreload(opts);
    await p.flush();
    assert.equal(p.invokes.length, 0, JSON.stringify(opts));
    assert.equal(p.ipcHandlers.size, 0);
  }
});

test('when main returns null (no runtime), nothing is injected and nothing throws', async () => {
  const p = loadPreload({ hello: null });
  await p.flush();
  assert.equal(p.executed.length, 0);
});

test('the preload exposes nothing to the page', async () => {
  const p = loadPreload();
  await p.flush();
  assert.deepEqual(Object.keys(p.win).sort(), ['addEventListener', 'location', 'postMessage', 'top']);
});

test('an injection failure (the native "Script failed to execute") is reported via codexmods:log with the document state', async () => {
  const r = loadPreload({ failInject: true, documentState: { readyState: 'loading', documentElement: null } });
  await r.flush(); await r.flush();
  const rec = r.invokes.find((i) => i[0] === 'codexmods:log');
  assert.ok(rec, 'inject failure is reported');
  assert.equal(rec[1].phase, 'inject');
  assert.match(rec[1].message, /Script failed to execute/);
  assert.deepEqual(rec[1].documentState, { readyState: 'loading', hasRoot: false });
});

test('errors the runtime reports (op log) are forwarded to codexmods:log, prefixed runtime:', async () => {
  const ok = loadPreload();
  await ok.flush();
  ok.fromRuntime({ __codexmods: ok.noncefrom(), dir: 'to-preload', op: 'log', phase: 'construct', message: 'boom', stack: 'at x' });
  await ok.flush();
  const rec = ok.invokes.find((i) => i[0] === 'codexmods:log')[1];
  assert.deepEqual({ phase: rec.phase, message: rec.message, stack: rec.stack }, { phase: 'runtime:construct', message: 'boom', stack: 'at x' });
});

test('reports are bounded (20 per page load) and a failing ipc never throws', async () => {
  const ok = loadPreload({ invokeImpl: async (ch) => { if (ch === 'codexmods:log') throw new Error('ipc down'); return undefined; } });
  await ok.flush();
  const n = ok.noncefrom();
  for (let i = 0; i < 40; i++) ok.fromRuntime({ __codexmods: n, dir: 'to-preload', op: 'log', phase: 'x', message: 'm' });
  await ok.flush();
  assert.equal(ok.invokes.filter((i) => i[0] === 'codexmods:log').length, 20);
});

// ------------------------------------------------------------------ the presentation kernel (docs/design/presentations.md V3)
import vm from 'node:vm';
/** The kernel function as the preload defines it (loaded with the fake electron; it exports it for tests). */
const codexmodsKernel = (() => { loadPreload({ kernelBoot: null }); return require.cache[PRELOAD].exports.codexmodsKernel; })();
/** The kernel run in a fresh context, as executeInMainWorld runs it in the page: only what it was given. */
function kernelIn(boot, { react = null, globals = {} } = {}) {
  const ctx = vm.createContext({ performance: { now: () => 1 }, ...globals });
  if (react) vm.runInContext('globalThis.__codexmods = { exports: {} }', ctx), (ctx.__codexmods.exports.react = react);
  const fn = vm.runInContext(`(${codexmodsKernel.toString()})`, ctx);
  fn(boot);
  return ctx.__codexmods;
}
const factory = (type, props, key) => ({ type, props, key });

test('the kernel is installed first, synchronously, in the main world, with the boot framework-main answers', async () => {
  const p = loadPreload({ kernelBoot: { abi: 1, bindings: [{ id: 'b1', keys: ['conversationId'] }], taps: {} } });
  assert.deepEqual(p.syncs[0], ['codexmods:kernel', { search: '' }]);
  assert.equal(p.mainWorld.length, 1);
  assert.equal(p.mainWorld[0].func.name, 'codexmodsKernel');
  assert.deepEqual(globalThis.__codexmods.kernel.bindings, ['b1']);
  delete globalThis.__codexmods;
  await p.flush();
  assert.deepEqual(p.invokes[0][0], 'codexmods:hello', 'then the runtime as before');
});

test('without a kernel boot or without the bridge, the page is left as the app made it; a failure is reported', async () => {
  const a = loadPreload({ kernelBoot: null });
  assert.equal(a.mainWorld.length, 0);
  const b = loadPreload({ noBridge: true });
  assert.equal(b.mainWorld.length, 0);
  await b.flush();
  assert.ok(!b.invokes.some((x) => x[0] === 'codexmods:log'), 'an old Electron without the bridge is not an error');
});

test('kernel: without armed bindings every element is the app\'s own; with one, a matching type gets one stable wrapper', () => {
  const none = kernelIn({ abi: 1, bindings: [] });
  const T = function Row() {};
  assert.deepEqual(none.jsx(factory, T, { conversationId: 'x' }, 'k'), { type: T, props: { conversationId: 'x' }, key: 'k' });
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId', 'extraIconBadges'] }] });
  const el1 = K.jsx(factory, T, { conversationId: 'a', extraIconBadges: [] }, 'a');
  const el2 = K.jsx(factory, T, { conversationId: 'b', extraIconBadges: [] }, 'b');
  assert.notEqual(el1.type, T);
  assert.equal(el1.type, el2.type, 'one wrapper type per original type');
  assert.equal(el1.key, 'a');
  assert.equal(el1.type.displayName, 'Codexmods(Row)');
  const div = K.jsx(factory, 'div', { conversationId: 'a', extraIconBadges: [] });
  assert.equal(div.type, 'div', 'host elements are never wrapped');
  const Other = function Other() {};
  assert.equal(K.jsx(factory, Other, { conversationId: 'a' }).type, Other, 'all keys must be present');
  // `exact`: the props carry those keys and no others (a one-key address such as a settings page's {section})
  const X = kernelIn({ abi: 1, bindings: [{ id: 'page', keys: ['section'], exact: true }] });
  const Page = function Page() {};
  const Part = function Part() {};
  assert.equal(X.jsx(factory, Part, { section: 'visual', variant: 'x' }).type, Part, 'more keys: not this binding');
  assert.notEqual(X.jsx(factory, Page, { section: 'appearance' }).type, Page);
  // `optional` (with `exact`): keys a build's call may also carry; any other key is still another component's
  const O = kernelIn({ abi: 1, bindings: [{ id: 'card', keys: ['className', 'children'], exact: true, optional: ['embedded'] }] });
  const Card = function Card() {}; const Card2 = function Card2() {}; const Card3 = function Card3() {};
  assert.notEqual(O.jsx(factory, Card, { className: 'c', children: [] }).type, Card, 'without the optional key');
  assert.notEqual(O.jsx(factory, Card2, { className: 'c', embedded: true, children: [] }).type, Card2, 'with it');
  assert.equal(O.jsx(factory, Card3, { className: 'c', embedded: true, onKeyDown() {}, children: [] }).type, Card3, 'another key: not this binding');
});

test('kernel: an element binding (a generic component\'s) is matched per element, never decided per type; an element failing its canary is the app\'s own (E8.3f, review 4)', () => {
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['subTextAllowWrap', 'onClick'], element: true, canary: { onClick: 'function' } }] });
  const Item = function Item() {};
  for (let i = 0; i < 40; i++) assert.equal(K.jsx(factory, Item, { onClick() {}, children: i }).type, Item, 'the item\'s other uses stay the app\'s own');
  const a = K.jsx(factory, Item, { subTextAllowWrap: true, onClick() {} }, 'a');
  const b = K.jsx(factory, Item, { subTextAllowWrap: false, onClick() {} }, 'b');
  assert.notEqual(a.type, Item, 'still matched after many misses of its type');
  assert.equal(a.type, b.type, 'one wrapper per type');
  assert.equal(a.type.displayName, 'Codexmods(Item)');
  assert.equal(K.jsx(factory, Item, { onClick() {} }).type, Item);
  assert.deepEqual([...K.kernel.bindings], ['row'], 'armed for the runtime too: it renders only the bindings the kernel names (layouts WL4c)');
  // review 4: an element that fails the canary is another use of the item: not wrapped, nothing turned off
  const seen = [];
  const C = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['subTextAllowWrap'], element: true, canary: { onClick: 'function' } }] });
  C.store.onFault = (id, e) => seen.push([id, e.message]);
  assert.equal(C.jsx(factory, Item, { subTextAllowWrap: true, onClick: 'x' }).type, Item);
  assert.notEqual(C.jsx(factory, Item, { subTextAllowWrap: true, onClick() {} }).type, Item, 'still on for the page');
  assert.deepEqual(seen, []);
});

test('kernel (H7x review 1): a rematched binding is still tried on a type the kernel stopped matching, and wraps that type once it matches', () => {
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['title', 'actions'], exact: true, rematch: true }, { id: 'other', keys: ['zzz'] }] });
  const Row = function Row() {};
  for (let i = 0; i < 40; i++) assert.equal(K.jsx(factory, Row, { title: 'goal', onClick() {} }).type, Row, 'its other uses first');
  const a = K.jsx(factory, Row, { title: 'follow-up', actions: 'x' });
  assert.notEqual(a.type, Row, 'still matched after many misses');
  assert.equal(K.jsx(factory, Row, { title: 'goal', onClick() {} }).type, a.type, 'the type is wrapped from then on (its other uses pass through)');
  const N = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['title', 'actions'], exact: true }] });
  for (let i = 0; i < 40; i++) N.jsx(factory, Row, { title: 'goal', onClick() {} });
  assert.equal(N.jsx(factory, Row, { title: 'follow-up', actions: 'x' }).type, Row, 'without it, given up on');
});

test('kernel: a binding addressed by an exposure matches that component by identity, whatever its props (systems.md E0)', () => {
  const Group = function NavGroup() {};
  const Other = function Other() {};
  const K = kernelIn({ abi: 1, bindings: [{ id: 'group', exposure: 'NavGroup' }] });
  assert.equal(K.jsx(factory, Group, { title: 'x', children: [] }).type, Group, 'not exposed yet: the app\'s own');
  K.exports = { NavGroup: Group };
  const el = K.jsx(factory, Group, { title: 'x', children: [] });
  assert.notEqual(el.type, Group);
  assert.equal(el.type.displayName, 'Codexmods(NavGroup)');
  assert.equal(K.jsx(factory, Other, { title: 'x', children: [] }).type, Other, 'another component with the same props is not it');
  // an exposure whose getter throws is never this binding's
  const T = kernelIn({ abi: 1, bindings: [{ id: 'g', exposure: 'Broken' }] });
  T.exports = Object.defineProperty({}, 'Broken', { get() { throw new Error('not ready'); } });
  assert.equal(T.jsx(factory, Group, {}).type, Group);
  // a dotted name reaches into an exposure (a namespace's component); a namespace not there yet is never it
  const D = kernelIn({ abi: 1, bindings: [{ id: 'banner', exposure: 'appShell.PageBanner' }] });
  const Banner = function PageBanner() {};
  assert.equal(D.jsx(factory, Banner, { children: 'x' }).type, Banner, 'no namespace yet');
  D.exports = { appShell: { PageBanner: Banner } };
  assert.equal(D.jsx(factory, Banner, { children: 'x' }).type.displayName, 'Codexmods(PageBanner)');
});

test('kernel: a wrapper renders the app\'s component until the runtime registers a renderer; a throwing renderer falls back and counts', () => {
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId'] }] });
  const T = function Row() {};
  const W = K.jsx(factory, T, { conversationId: 'a' }).type;
  assert.deepEqual(W({ conversationId: 'a' }), { type: T, props: { conversationId: 'a' }, key: undefined });
  K.store.renderers.set('row', (Orig, props, f) => f(Orig, { ...props, decorated: true }));
  assert.equal(W({ conversationId: 'a' }).props.decorated, true);
  K.store.renderers.set('row', () => undefined);
  assert.equal(W({ conversationId: 'a' }).type, T, 'undefined: the app\'s own');
  const seen = [];
  K.store.onFault = (id, e) => seen.push([id, e.message]);
  K.store.renderers.set('row', () => { throw new Error('boom'); });
  assert.equal(W({ conversationId: 'a' }).type, T);
  assert.equal(K.faults.count, 1);
  assert.deepEqual(seen, [['row', 'boom']]);
});

test('kernel: a wrapper subscribes to the store through the app\'s React when it is exposed, every render the same way', () => {
  const calls = [];
  const react = { useSyncExternalStore: (sub, get) => { calls.push(get()); return get(); } };
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId'] }] }, { react });
  const W = K.jsx(factory, function Row() {}, { conversationId: 'a' }).type;
  W({ conversationId: 'a' });
  K.store.bump();
  W({ conversationId: 'a' });
  assert.deepEqual(calls, [0, 1]);
  let heard = 0;
  const off = K.store.subscribe(() => heard++);
  K.store.bump(); off(); K.store.bump();
  assert.equal(heard, 1);
});

test('kernel: a binding\'s canary is checked at a type\'s first match; a type that fails is never wrapped and the binding goes off for the page (4a)', () => {
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId'], canary: { conversationId: 'string', canPin: 'boolean?' } }] });
  const seen = [];
  K.store.onFault = (id, e) => seen.push([id, e.message]);
  const Good = function Good() {};
  const W = K.jsx(factory, Good, { conversationId: 'a', canPin: undefined }).type;
  assert.notEqual(W, Good, 'optional props may be absent');
  K.store.renderers.set('row', (Orig, props, f) => f(Orig, { ...props, decorated: true }));
  assert.equal(W({ conversationId: 'a' }).props.decorated, true);
  const Changed = function Changed() {};
  const el = K.jsx(factory, Changed, { conversationId: 42 });
  assert.equal(el.type, Changed, 'never wrapped');
  assert.deepEqual(seen, [['row', 'its canary failed: conversationId is number, not string']]);
  assert.equal(JSON.stringify([...K.kernel.disarmed]), JSON.stringify([['row', 'conversationId is number, not string']]), 'kept for a runtime that comes later');
  assert.equal(W({ conversationId: 'a' }).type, Good, 'a wrapper made before renders the app\'s own from now on');
  const Later = function Later() {};
  assert.equal(K.jsx(factory, Later, { conversationId: 'b' }).type, Later, 'nothing more is matched');
});

test('kernel: a wrapper re-renders when the store is bumped or a subject its binding read is touched, not for other subjects (4b)', () => {
  // A small React: each instance keeps its ref and its last snapshot getter.
  let current = null;
  const react = {
    useRef(init) { current.ref ??= { current: init }; return current.ref; },
    useSyncExternalStore(sub, get) { current.get = get; return get(); },
  };
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId'] }] }, { react });
  K.store.renderers.set('row', (Orig, props, f) => { K.store.read(`thread:${props.conversationId}`); return f(Orig, props); });
  const W = K.jsx(factory, function Row() {}, { conversationId: 'a' }).type;
  const render = (inst, props) => { current = inst; W(props); current = null; return inst.get(); };
  const a = {}, b = {};
  render(a, { conversationId: 'a' }); render(b, { conversationId: 'b' });   // first render: no reads known yet
  const sa = render(a, { conversationId: 'a' }), sb = render(b, { conversationId: 'b' });
  K.store.touch(['thread:a']);
  assert.notEqual(a.get(), sa, 'the wrapper that read thread:a has a new snapshot');
  assert.equal(b.get(), sb, 'the other is unchanged: React skips it');
  K.store.bump();
  assert.notEqual(b.get(), sb, 'a bump reaches every wrapper');
});

test('kernel: the lazy hook passes modules through until the runtime sets one; a throwing hook keeps the module; it installs once', () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  const mod = { Page: 1 };
  assert.equal(K.lazy(() => {}, mod), mod);
  K.lazyHook = (imp, m) => ({ ...m, wrapped: true });
  assert.equal(K.lazy(() => {}, mod).wrapped, true);
  K.lazyHook = () => { throw new Error('no'); };
  assert.equal(K.lazy(() => {}, mod), mod);
  assert.equal(K.faults.last.where, 'lazy');
  const first = K.kernel;
  const fn = vm.runInContext(`(${codexmodsKernel.toString()})`, vm.createContext({ __codexmods: K }));
  fn({ abi: 1, bindings: [{ id: 'x', keys: ['y'] }] });
  assert.equal(K.kernel, first, 'a second install changes nothing');
});

test('kernel: a thread menu\'s items are the app\'s until the runtime sets a rule; a rule that throws or answers anything but a list keeps them', () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  const items = [{ id: 'rename-thread' }, { id: 'fork' }];
  const args = { target: { conversationId: 'c1' }, surface: 'sidebar' };
  assert.equal(K.menuItems(args, items), items);
  K.store.menus = (a, list) => list.filter((x) => x.id !== 'fork' || a.target.conversationId !== 'c1');
  assert.deepEqual(K.menuItems(args, items).map((x) => x.id), ['rename-thread']);
  K.store.menus = () => 'no';
  assert.equal(K.menuItems(args, items), items);
  K.store.menus = () => { throw new Error('bad rule'); };
  assert.equal(K.menuItems(args, items), items);
  assert.equal(K.faults.last.where, 'menuItems');
});

test('kernel: a wrapper\'s committed mount is a record the runtime follows, kept from the first render on; its renderer gets the record (S10)', async () => {
  const { createFakeReact } = await import('../../../renderer/test/fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const K = kernelIn({ abi: 1, bindings: [{ id: 'row', keys: ['conversationId'] }] }, { react: React });
  const f = (type, props, key) => React.createElement(type, { ...props, ...(key != null ? { key } : {}) });
  const Row = function Row(p) { return React.createElement('div', null, p.conversationId); };
  const App = ({ ids }) => React.createElement('main', null, ids.map((id) => K.jsx(f, Row, { conversationId: id }, id)));
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(App, { ids: ['a', 'b'] }));
  // Before the runtime: nothing listens, the records are kept.
  const mounted = () => Array.from(K.store.mounted(), (r) => `${r.binding} ${r.props.conversationId}`);   // the kernel's realm is a vm context
  assert.deepEqual(mounted(), ['row a', 'row b']);
  const seen = [];
  K.store.onMount = (kind, rec) => seen.push(`${kind} ${rec.props.conversationId}`);
  const got = [];
  K.store.renderers.set('row', (O, props, fac, rec) => { got.push(rec.n); return undefined; });
  root.render(React.createElement(App, { ids: ['a'] }));
  assert.deepEqual(seen, ['unmount b', 'update a']);
  assert.deepEqual(mounted(), ['row a']);
  assert.equal(got.length, 1);
  assert.equal(got[0], K.store.mounted()[0].n, 'the renderer gets the mount\'s record');
  root.render(React.createElement(App, { ids: ['a', 'c'] }));
  assert.deepEqual(seen.slice(2).sort(), ['mount c', 'update a'], 'a later mount is told, and every commit of a mounted one');
  K.store.onMount = () => { throw new Error('runtime bug'); };
  root.render(React.createElement(App, { ids: [] }));
  assert.equal(K.store.mounted().length, 0);
  assert.equal(K.faults.last.where, 'mounts', 'a throwing listener is a fault, not a broken page');
});

test('kernel: a binding whose address names a scope reads it through the app\'s scope hook, every render; its renderer and record get the value', async () => {
  const { createFakeReact } = await import('../../../renderer/test/fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const RouteScope = { name: 'RouteScope' };
  let route = { routeKind: 'local-thread', conversationId: 't1' };
  const useScope = (scope) => (scope === RouteScope ? { value: route } : null);
  const K = kernelIn({ abi: 1, bindings: [{ id: 'title', keys: ['title'], scope: 'RouteScope' }, { id: 'plain', keys: ['plain'] }] }, { react: React });
  K.exports.useScope = useScope;
  K.exports.RouteScope = RouteScope;
  const seen = [];
  K.store.renderers.set('title', (O, props, f, rec, scope) => { seen.push(scope?.conversationId); return undefined; });
  K.store.renderers.set('plain', (O, props, f, rec, scope) => { seen.push(scope === undefined ? 'none' : 'some'); return undefined; });
  const f = (type, props, key) => React.createElement(type, { ...props, ...(key != null ? { key } : {}) });
  const Title = function Title() { return null; };
  const Plain = function Plain() { return null; };
  const App = () => React.createElement('main', null, [K.jsx(f, Title, { title: 'x' }, 'a'), K.jsx(f, Plain, { plain: 1 }, 'b')]);
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(App));
  route = { routeKind: 'local-thread', conversationId: 't2' };
  root.render(React.createElement(App));
  assert.deepEqual(seen, ['t1', 'none', 't2', 'none']);
  assert.deepEqual(Array.from(K.store.mounted(), (r) => r.scope?.conversationId ?? null), ['t2', null], 'the record keeps the committed value');
});

test('kernel: the markdown hooks wrap the app\'s link and code once per component; the parts store decides; a site binding provides its site from the first render (E8.8)', async () => {
  const { createFakeReact, rootText } = await import('../../../renderer/test/fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const K = kernelIn({ abi: 1, bindings: [{ id: 'message.agent', keys: ['item'], site: 'agent-message' }] }, { react: React });
  const Link = (p) => React.createElement('a', null, p.children);
  const Code = React.memo((p) => React.createElement('code', null, p.children));
  const c1 = K.markdownComponents({}, { a: Link, code: Code, img: 'img' });
  const c2 = K.markdownComponents({ cwd: '/x' }, { a: Link, code: Code });
  assert.equal(c1.a, c2.a, 'one wrapper per app component');
  assert.notEqual(c1.code, Code);
  assert.equal(c1.img, 'img', 'the rest of the map as it was');
  assert.equal(K.markdownDirectives({}, { x: 1 }).x, 1, 'no runtime: the app\'s directives');
  const f = (type, props, key) => React.createElement(type, { ...props, ...(key != null ? { key } : {}) });
  const Message = (p) => React.createElement('div', null, React.createElement(c1.code, { children: p.item.text }));
  const root = ReactDOM.createRoot({});
  const App = () => K.jsx(f, Message, { item: { text: 'hi' } });
  root.render(React.createElement(App));
  assert.equal(rootText(root), 'hi', 'before the runtime: the app\'s own');
  const asked = [];
  K.store.parts = (kind, Native, props, at) => { asked.push([kind, at?.site, at?.binding, at?.props?.item?.text]); return `[${props.children}]`; };
  K.store.partsRev++;
  K.store.bump();
  assert.equal(rootText(root), '[hi]');
  assert.deepEqual(asked.at(-1), ['code', 'agent-message', 'message.agent', 'hi']);
  K.store.parts = () => { throw new Error('x'); };
  K.store.partsRev++;
  K.store.bump();
  assert.equal(rootText(root), 'hi', 'a throwing store: the app\'s own');
  assert.equal(K.faults.last.where, 'markdown');
  // a part follows the subject its answer read (the site's, resolved later), as a binding's wrapper does
  let subject = null;
  K.store.parts = () => { K.store.read('pid:m1'); return `[${subject ?? 'none'}]`; };
  K.store.partsRev++;
  K.store.bump();
  assert.equal(rootText(root), '[none]');
  subject = 'm1';
  K.store.touch(['pid:m1']);
  assert.equal(rootText(root), '[m1]');
  K.store.directives = (o, d) => ({ ...d, mine: 2 });
  assert.deepEqual({ ...K.markdownDirectives({}, { x: 1 }) }, { x: 1, mine: 2 });
});

test('kernel: what the app copies passes the runtime\'s copy first (seam copy, F3), with the place it was asked at (its event\'s target, else the last pointer press within 2 s; in a floating layer, where it was opened from, a right click\'s selection with it) and a thread action\'s origin; so do the page\'s own writeText and a selection\'s setData (its ranges); none, null or a throw: as it was', () => {
  const written = [], set = [];
  const listeners = {};
  const clipboard = { writeText(t) { written.push([this === clipboard, t]); return 'written'; } };
  class DataTransfer { setData(type, data) { set.push([type, data]); } }
  let anchor = null;
  const range = { collapsed: false, cloneRange() { return 'range'; } };
  const document = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const K = kernelIn({ abi: 1, bindings: [] }, { globals: { navigator: { clipboard }, DataTransfer, document, getSelection: () => ({ anchorNode: anchor, rangeCount: anchor ? 1 : 0, getRangeAt: () => range }) } });
  assert.equal(K.copy('sk-1', null), 'sk-1', 'no runtime: as it was');
  assert.equal(clipboard.writeText('sk-1'), 'written');
  const places = [];
  K.store.copy = (c, place, origin) => { places.push(origin ? [place, origin] : place); return typeof c === 'string' ? c.replace('sk-1', '•••') : null; };
  assert.equal(K.copy('key sk-1', { target: 'button' }), 'key •••');
  listeners.pointerdown({ target: 'row' });
  assert.equal(clipboard.writeText('key sk-1'), 'written');
  const rich = { 'text/plain': 'x' };
  assert.equal(K.copy(rich, null), rich, 'null: as it was');
  assert.equal(K.copy('md', null, { chat: 't1' }), 'md');
  const plain = (x) => JSON.parse(JSON.stringify(x));   // the kernel's realm's objects
  assert.deepEqual(plain(places), [{ target: 'button', ranges: [] }, { target: 'row', ranges: [] }, { target: 'row', ranges: [] }, [{ target: 'row', ranges: [] }, { chat: 't1' }]],
    'the event\'s target, else the last press; a thread action\'s origin');
  // a floating layer's copy: the place it was opened from (a right click outside one, with its selection); none known, a layer's
  const el = (inLayer) => ({ nodeType: 1, closest: (sel) => (sel.includes('[role="menu"]') && inLayer ? {} : null) });
  const message = el(false), item = el(true);
  places.length = 0;
  K.copy('a', { target: item });
  anchor = 'text-node';
  listeners.contextmenu({ target: message });
  listeners.pointerdown({ target: item });
  K.copy('b', { target: item });
  assert.deepEqual(plain(places[0]), { target: 'row', ranges: [] }, 'where the user last acted outside a layer');
  assert.ok(places[1].target === message && plain(places[1].ranges)[0] === 'range' && places[1].ranges.length === 1, 'the right click\'s place and selection');
  assert.deepEqual(written, [[true, 'sk-1'], [true, 'key •••']], 'the page\'s own writeText, called on the clipboard');
  // a selection's copy: each format at the selection's place (its anchor and ranges); false leaves it out
  K.store.copyPart = (type, data, place) => (type === 'text/html' ? false : `${data}@${place.target}:${place.ranges.length}`);
  const dt = new DataTransfer();
  dt.setData('text/plain', 'sel');
  dt.setData('text/html', '<b>sel</b>');
  dt.setData('application/x-other', 'kept');
  assert.deepEqual(set, [['text/plain', 'sel@text-node:1'], ['application/x-other', 'kept']]);
  K.store.copy = () => { throw new Error('x'); };
  assert.equal(K.copy('sk-1', null), 'sk-1');
  assert.equal(K.faults.last.where, 'copy');
  // installed once: a second kernel does not wrap them again; with no gesture yet, a layer's copy is from a layer opened from nowhere known
  const again = kernelIn({ abi: 1, bindings: [] }, { globals: { navigator: { clipboard }, DataTransfer, document } });
  assert.equal(typeof again.copy, 'function');
  const fresh = [];
  again.store.copy = (c, place) => { fresh.push(place); return null; };
  again.copy('c', { target: item });
  assert.deepEqual(plain(fresh), [{ target: null, ranges: [], layer: true }]);
});

test('kernel: the page\'s command dispatcher asks the runtime first (seam command, H6m3): a boolean answered is its answer; none, anything else or a throw: the app\'s own', () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  assert.equal(K.command('x', null, 'command_menu', undefined, () => true), undefined, 'no runtime: the app\'s own');
  const asked = [];
  K.store.command = (id, ev, source, origin, run) => { asked.push([id, source]); return source === 'held' ? true : run(); };
  assert.equal(K.command('x', null, 'held', undefined, () => false), true);
  assert.equal(K.command('y', null, 'keyboard_shortcut', undefined, () => false), false);
  K.store.command = () => 'yes';
  assert.equal(K.command('z', null, 's', undefined, () => true), undefined, 'not a boolean: the app\'s own');
  K.store.command = () => { throw new Error('x'); };
  assert.equal(K.command('z', null, 's', undefined, () => true), undefined);
  assert.equal(K.faults.last.where, 'command');
  assert.deepEqual(asked, [['x', 'held'], ['y', 'keyboard_shortcut']]);
  // the run at most once; a throw once it ran is the dispatcher's (built review H6m3a)
  let runs = 0;
  K.store.command = (id, ev, s, o, run) => { run(); run(); return true; };
  K.command('a', null, 's', undefined, () => { runs++; return true; });
  assert.equal(runs, 1);
  K.store.command = (id, ev, s, o, run) => { run(); return 'x'; };
  assert.throws(() => { K.store.command = (id, ev, s, o, run) => { run(); throw new Error('after'); }; K.command('b', null, 's', undefined, () => true); }, /after/);
});

test('kernel: a composer\'s attach methods pass the runtime first (seam attach, H6m3b), with where the user last acted (a press, a drop, a paste); an object answered is used; none, anything else or a throw: the app\'s own', () => {
  const listeners = {};
  const document = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const K = kernelIn({ abi: 1, bindings: [] }, { globals: { document } });
  const methods = { addFiles: () => 'own' };
  assert.equal(K.attach(methods, {}), methods, 'no runtime: the app\'s own');
  const seen = [];
  K.store.attach = (m, args, place) => { seen.push([args.scope, place && place.target]); return { ...m, addFiles: () => 'held' }; };
  listeners.drop({ target: 'composer' });
  assert.equal(K.attach(methods, { scope: 'S' }).addFiles(), 'held');
  listeners.paste({ target: 'editor' });
  K.attach(methods, { scope: 'T' });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [['S', 'composer'], ['T', 'editor']]);
  K.store.attach = () => 'no';
  assert.equal(K.attach(methods, {}), methods, 'not an object: the app\'s own');
  K.store.attach = () => { throw new Error('x'); };
  assert.equal(K.attach(methods, {}), methods);
  assert.equal(K.faults.last.where, 'attach');
});

test('kernel: the review panel\'s git action asks the runtime first (seam review-action, H6m4): its answer is the action\'s; none or a throw before it ran: the app\'s own; its run at most once, a throw once it ran the app\'s own', () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  assert.equal(K.reviewAction({}, () => 'own'), undefined, 'no runtime: the app\'s own');
  let runs = 0;
  K.store.reviewAction = (arg, run) => { run(); run(); return 'held'; };
  assert.equal(K.reviewAction({ cwd: '/r' }, () => { runs++; return 'ran'; }), 'held');
  assert.equal(runs, 1);
  K.store.reviewAction = () => { throw new Error('x'); };
  assert.equal(K.reviewAction({}, () => 'own'), undefined);
  assert.equal(K.faults.last.where, 'reviewAction');
  K.store.reviewAction = (arg, run) => { run(); throw new Error('after'); };
  assert.throws(() => K.reviewAction({}, () => 'own'), /after/);
});

test('kernel: every markdown renderer follows the content revision at the top of its render (one hook, the same on every render), so it draws again in place when the redactions change', () => {
  const calls = [];
  const react = { useSyncExternalStore: (sub, get) => { calls.push(get()); return get(); } };
  const K = kernelIn({ abi: 1, bindings: [] }, { react });
  const rt = () => 'own';
  assert.equal(K.markdownText({}, rt), rt, 'no runtime: the site\'s own, still following');
  K.store.contentRev = 4;
  K.store.text = () => () => 'masked';
  assert.equal(typeof K.markdownText({}, rt), 'function');
  K.store.text = () => { throw new Error('x'); };
  assert.equal(K.markdownText({}, rt), rt);
  assert.deepEqual(calls, [0, 4, 4], 'the same hook on every call, whatever the runtime answers');
});

test('kernel: a pull request the user creates asks the runtime first (seam pr-create, H6m4): a promise of its answer; none, or a fault, the app\'s own', async () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  assert.equal(K.pullRequestCreate({ cwd: '/r' }), undefined, 'no runtime: the app\'s own');
  K.store.pullRequestCreate = (arg) => ({ refused: `no ${arg.headBranch}` });
  assert.deepEqual(JSON.parse(JSON.stringify(await K.pullRequestCreate({ headBranch: 'feat' }))), { refused: 'no feat' });
  K.store.pullRequestCreate = () => Promise.reject(new Error('x'));
  assert.equal(await K.pullRequestCreate({}), undefined);
  assert.equal(K.faults.last.where, 'pullRequestCreate');
});

test('kernel: a binding that reads the nearest site gets it in its renderer, from its first render; a non-markdown site is not re-keyed (E8.7b)', async () => {
  const { createFakeReact, rootText } = await import('../../../renderer/test/fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const K = kernelIn({ abi: 1, bindings: [{ id: 'section', keys: ['group'], site: 'sidebar-project' }, { id: 'menu', keys: ['getContextMenuItems'], readsSite: true }] }, { react: React });
  const f = (type, props, key) => React.createElement(type, { ...props, ...(key != null ? { key } : {}) });
  const Menu = (p) => React.createElement('span', null, p.getContextMenuItems().join(','));
  const Section = () => React.createElement('div', null, K.jsx(f, Menu, { getContextMenuItems: () => ['app'] }));
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(() => K.jsx(f, Section, { group: { projectId: 'p1' } })));
  assert.equal(rootText(root), 'app');
  const seen = [];
  K.store.renderers.set('menu', (O, props, fac, rec, scope, near) => { seen.push([near?.binding, near?.site, near?.props?.group?.projectId]); return fac(O, { ...props, getContextMenuItems: () => [...props.getContextMenuItems(), 'mod'] }); });
  K.store.bump();
  assert.equal(rootText(root), 'app,mod');
  assert.deepEqual(seen.at(-1), ['section', 'sidebar-project', 'p1']);
  const before = K.store.directivesRev;
  K.store.directivesRev++;
  K.store.bump();
  assert.equal(rootText(root), 'app,mod', 'still drawn; only markdown sites are re-keyed by the directive revision');
  K.store.directivesRev = before;
});

test('kernel: a binding whose component sits in an app context (an exposure) keeps its value on the mount\'s record, read every render (E8.3b)', async () => {
  const { createFakeReact } = await import('../../../renderer/test/fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const K = kernelIn({ abi: 1, bindings: [{ id: 'composer', keys: ['viewProps'], context: 'Ctl' }, { id: 'plain', keys: ['plain'], context: 'Missing' }] }, { react: React });
  const Ctl = React.createContext(null);
  K.exports.Ctl = Ctl;
  const f = (type, props, key) => React.createElement(type, { ...props, ...(key != null ? { key } : {}) });
  const Footer = () => null;
  const Plain = () => null;
  const controller = { setText() {} };
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(Ctl.Provider, { value: controller }, K.jsx(f, Footer, { viewProps: {} }, 'a'), K.jsx(f, Plain, { plain: 1 }, 'b')));
  const recs = Array.from(K.store.mounted());
  assert.equal(recs.find((r) => r.binding === 'composer').context, controller);
  assert.equal('context' in recs.find((r) => r.binding === 'plain'), false, 'an exposure this build lacks: no context read');
});

test('kernel: the narrow-window handler asks the runtime\'s allocator; true only when it answers true; a throw counted, the app\'s own then (layouts WL4d)', () => {
  const K = kernelIn({ abi: 1, bindings: [] });
  assert.equal(K.responsive({ width: 900, scope: {} }), undefined, 'no allocator: the app\'s');
  K.store.responsive = (arg) => arg.width < 1000;
  assert.equal(K.responsive({ width: 900, scope: {} }), true);
  assert.equal(K.responsive({ width: 1200, scope: {} }), undefined);
  K.store.responsive = () => { throw new Error('boom'); };
  assert.equal(K.responsive({ width: 900, scope: {} }), undefined);
  assert.equal(K.faults.last.where, 'responsive');
});
