import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeHooks } from './fake-electron.mjs';
import { pack } from '../../../renderer/test/harness.mjs';
const pack21477 = JSON.parse((await import('node:fs')).readFileSync(new URL('../../../../adapters/26.1016.62342-21477/adapter.json', import.meta.url), 'utf8'));
const OWN_ADDRESSES = JSON.parse((await import('node:fs')).readFileSync(new URL('../../../renderer/present/addresses.json', import.meta.url), 'utf8')).bindings.map((b) => b.id);

const require = createRequire(import.meta.url);
const views = require('../index.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

/** A renderer tree copy with a stub realm-client and a recovery entry stub (other modules' code, faked here). */
function rendererTree({ recovery = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-views-'));
  mkdirSync(join(dir, 'framework', 'renderer'), { recursive: true });
  for (const f of readdirSync(join(repo, 'framework', 'renderer'))) if (f.endsWith('.mjs')) cpSync(join(repo, 'framework', 'renderer', f), join(dir, 'framework', 'renderer', f));
  cpSync(join(repo, 'framework', 'renderer', 'present'), join(dir, 'framework', 'renderer', 'present'), { recursive: true });   // the presentation runtime (presentations.md)
  mkdirSync(join(dir, 'framework', 'shared'), { recursive: true });
  cpSync(join(repo, 'framework', 'shared', 'graph-replica.mjs'), join(dir, 'framework', 'shared', 'graph-replica.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'ui-rules-client.mjs'), join(dir, 'framework', 'shared', 'ui-rules-client.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'bounded-pattern.mjs'), join(dir, 'framework', 'shared', 'bounded-pattern.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'draft-text.mjs'), join(dir, 'framework', 'shared', 'draft-text.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'where.mjs'), join(dir, 'framework', 'shared', 'where.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'parts.mjs'), join(dir, 'framework', 'shared', 'parts.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'internal-mods.mjs'), join(dir, 'framework', 'shared', 'internal-mods.mjs'));
  mkdirSync(join(dir, 'sdk'), { recursive: true });
  cpSync(join(repo, 'sdk', 'errors.mjs'), join(dir, 'sdk', 'errors.mjs'));
  mkdirSync(join(dir, 'framework', 'shared'), { recursive: true });
  writeFileSync(join(dir, 'framework', 'shared', 'realm-client.mjs'), 'export function createRealmClient() { return { context: () => ({}) }; }\n');
  if (recovery) { mkdirSync(join(dir, 'framework', 'renderer', 'recovery'), { recursive: true }); writeFileSync(join(dir, 'framework', 'renderer', 'recovery', 'index.mjs'), "import { CodexModsError } from '../../../sdk/errors.mjs';\nexport default function activate(ctx) { return CodexModsError.name; }\n"); }
  return dir;
}
function reg(opts = {}) {
  const dir = rendererTree(opts);
  const f = createFakeHooks({ adapter: pack });
  views.register(f.hooks, { rendererDir: join(dir, 'framework', 'renderer'), preloadPath: '/fw/preload.cjs' });
  return { ...f, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('register: preload registered for the app session with the given file; hello, framework-module and pick-file handlers', () => {
  const t = reg();
  try {
    assert.deepEqual(t.electron.calls[0], ['registerPreloadScript', { type: 'frame', filePath: '/fw/preload.cjs' }]);
    assert.deepEqual([...t.electron.handlers.keys()].sort(), ['codexmods:framework-module', 'codexmods:hello', 'codexmods:log', 'codexmods:navigate', 'codexmods:pick-file']);
  } finally { t.done(); }
});

test('hello for a normal window: two channels, framework-main bridges the main-side ends, the window gets the others, the page gets runtime + UI boot (no transforms)', () => {
  const t = reg();
  try {
    const res = t.electron.handlers.get('codexmods:hello')(7, { search: '' });
    assert.equal(typeof res.runtime, 'string');
    assert.ok(res.runtime.includes('startRuntime'));
    assert.equal(res.boot.appBuild, '26.1007.21159-20052');
    assert.deepEqual(Object.keys(res.boot.adapter).sort(), ['anchors', 'build', 'components', 'react', 'theme']);
    assert.ok(!JSON.stringify(res.boot).includes('sha256'), 'transforms and protocol never reach the page');
    assert.deepEqual(t.toHost, [], 'nothing is sent to the Host with a transfer list: framework-main bridges the ports');
    assert.deepEqual(t.bridged, [
      { windowId: 7, channel: 'renderer', port: t.electron.ports[0].port1 },
      { windowId: 7, channel: 'management', port: t.electron.ports[1].port1 },
    ]);
    assert.deepEqual(t.electron.posted, [
      { windowId: 7, channel: 'codexmods:port', message: { kind: 'renderer' }, transfer: [t.electron.ports[0].port2] },
      { windowId: 7, channel: 'codexmods:port', message: { kind: 'management' }, transfer: [t.electron.ports[1].port2] },
    ]);
  } finally { t.done(); }
});

test('hello again (page reload) creates fresh channels; the runtime bundle is built once', () => {
  const t = reg();
  try {
    const hello = t.electron.handlers.get('codexmods:hello');
    const a = hello(7, { search: '' }); const b = hello(7, { search: '' });
    assert.equal(a.runtime, b.runtime);
    assert.equal(t.electron.ports.length, 4);
  } finally { t.done(); }
});

test('hello with no info object is a normal window', () => {
  const t = reg();
  try {
    assert.equal(t.electron.handlers.get('codexmods:hello')(11, undefined) !== null, true);
  } finally { t.done(); }
});

test('hello never throws: a bundling failure is logged and the page runs unmodded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-views-empty-'));
  const f = createFakeHooks({ adapter: pack });
  try {
    views.register(f.hooks, { rendererDir: join(dir, 'framework', 'renderer'), preloadPath: '/p' });
    assert.equal(f.electron.handlers.get('codexmods:hello')(1, { search: '' }), null);
    assert.equal(f.bridged.length, 0, 'no ports are handed out when there is no runtime');
    assert.ok(f.logs.error.some(([m]) => m === 'hello failed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('framework-module: allow-listed names only; missing file is null; the bundle is a runnable expression', () => {
  const t = reg();
  try {
    const h = t.electron.handlers.get('codexmods:framework-module');
    assert.equal(h(1, '../../etc/passwd'), null);
    assert.equal(h(1, 'recovery/other.mjs'), null);
    assert.equal(h(1, 'adjustments/index.mjs'), null, 'Adjustments went (E6.6d)');
    assert.equal(h(1, 42), null);
    const expr = h(1, 'recovery/index.mjs');
    assert.equal(typeof expr, 'string');
    assert.equal(h(1, 'recovery/index.mjs'), expr, 'cached');
    assert.equal(new Function(`return ${expr}`)().default(), 'CodexModsError');
  } finally { t.done(); }
  const none = reg({ recovery: false });
  try { assert.equal(none.electron.handlers.get('codexmods:framework-module')(1, 'recovery/index.mjs'), null); } finally { none.done(); }
});

test('pick-file: a native open dialog filtered by sanitized extensions; returns the first path or null', async () => {
  const t = reg();
  try {
    const pick = t.electron.handlers.get('codexmods:pick-file');
    t.electron.dialogResult = ['/Users/x/a.codexmod'];
    assert.equal(await pick(3, { extensions: ['codexmod', '../x', 'a b', 5, 'toolongextension12345'] }), '/Users/x/a.codexmod');
    assert.deepEqual(t.electron.calls.at(-1), ['showOpenDialog', 3, { filters: [{ name: 'Mod package', extensions: ['codexmod'] }], properties: ['openFile'] }]);
    t.electron.dialogResult = null;
    assert.equal(await pick(3, {}), null);
    assert.deepEqual(t.electron.calls.at(-1)[2], { properties: ['openFile'] });
    t.electron.dialogResult = [];
    assert.equal(await pick(3, { extensions: ['codexmod'] }), null);
    // a folder (a development package, E6.2): no filters
    t.electron.dialogResult = ['/Users/x/dev-mod'];
    assert.equal(await pick(3, { directory: true, extensions: ['codexmod'] }), '/Users/x/dev-mod');
    assert.deepEqual(t.electron.calls.at(-1)[2], { properties: ['openDirectory'] });
  } finally { t.done(); }
});

test('navigate: the framework\'s own navigation opens only its pages or Settings › General, in the window that asked (E6.4)', async () => {
  const t = reg();
  try {
    const go = t.electron.handlers.get('codexmods:navigate');
    for (const path of ['/settings/codexmods', '/settings/codexmods/acme.demo', '/settings/general-settings', '/settings/codexmods/~detail', '/settings/codexmods/~update', '/settings/codexmods/~developer', '/settings/codexmods/acme.demo/activity', '/settings/codexmods/acme.demo/~notes']) assert.equal(await go(4, { path }), true, path);
    for (const path of ['/settings/account', '/local/abc', '/settings/codexmods/../x', '/settings/codexmods/a b', 'settings/codexmods', '/settings/codexmods/~other', '/settings/codexmods/acme.demo/other', null]) assert.equal(await go(4, { path }), false, String(path));
    assert.deepEqual(t.electron.posted.filter((p) => p.channel === 'codex_desktop:message-for-view').map((p) => [p.windowId, p.message]), [
      [4, { type: 'navigate-to-route', path: '/settings/codexmods' }], [4, { type: 'navigate-to-route', path: '/settings/codexmods/acme.demo' }],
      [4, { type: 'navigate-to-route', path: '/settings/general-settings' }], [4, { type: 'navigate-to-route', path: '/settings/codexmods/~detail' }],
      [4, { type: 'navigate-to-route', path: '/settings/codexmods/~update' }], [4, { type: 'navigate-to-route', path: '/settings/codexmods/~developer' }],
      [4, { type: 'navigate-to-route', path: '/settings/codexmods/acme.demo/activity' }], [4, { type: 'navigate-to-route', path: '/settings/codexmods/acme.demo/~notes' }]]);
  } finally { t.done(); }
});

test('register never throws, even when the adapter electron API fails', () => {
  const f = createFakeHooks({ adapter: pack });
  f.electron.session.registerPreloadScript = () => { throw new Error('no session'); };
  assert.doesNotThrow(() => views.register(f.hooks));
  assert.ok(f.logs.error.some(([m]) => m === 'views register failed'));
  assert.doesNotThrow(() => views.register({}));
});

test('safe mode still registers the UI plane (Adjustments is the recovery UI)', () => {
  const dir = rendererTree();
  const f = createFakeHooks({ adapter: pack, safe: true });
  try { views.register(f.hooks, { rendererDir: join(dir, 'framework', 'renderer'), preloadPath: '/p' }); assert.ok(f.electron.handlers.has('codexmods:hello')); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codexmods:log: renderer/preload startup failures reach hooks.log.error, sanitized and bounded', async () => {
  const t = reg();
  try {
    const h = t.electron.handlers.get('codexmods:log');
    await h(5, { phase: 'inject', message: 'Script failed to execute', stack: 's'.repeat(5000), documentState: { readyState: 'loading', hasRoot: false }, evil: { x: 1 } });
    const [msg, data] = t.logs.error.at(-1);
    assert.equal(msg, 'renderer startup failure');
    assert.deepEqual({ windowId: data.windowId, phase: data.phase, message: data.message, documentState: data.documentState }, { windowId: 5, phase: 'inject', message: 'Script failed to execute', documentState: { readyState: 'loading', hasRoot: false } });
    assert.equal(data.stack.length, 2000);
    assert.equal('evil' in data, false);
    await h(5, 'garbage');                                        // malformed records never throw
    await h(5, null);
    for (let i = 0; i < 100; i++) await h(6, { phase: 'x', message: 'm' });
    assert.equal(t.logs.error.filter(([, d]) => d.windowId === 6).length, 50, 'a noisy window cannot flood the log');
  } finally { t.done(); }
});

test('kernel boot: a binding is armed only when the pack delivers the seams and exposures it needs; what is missing is logged (4a)', () => {
  const dir = rendererTree();
  mkdirSync(join(dir, 'framework', 'renderer', 'present'), { recursive: true });
  writeFileSync(join(dir, 'framework', 'renderer', 'present', 'addresses.json'), JSON.stringify({ abi: 1, bindings: [
    { id: 'plain', keys: ['a'], needs: { seams: ['jsx'], exposures: ['react'] }, canary: { a: 'string', bad: 7 } },
    { id: 'routed', keys: ['b'], needs: { seams: ['jsx'], exposures: ['react', 'NoSuchScope'] } },
    { id: 'menus', keys: ['c'], needs: { seams: ['jsx', 'noSuchSeam'] } },
    // by identity: the exposure it names is a need of its own (systems.md E0)
    { id: 'group', exposure: 'react', needs: { seams: ['jsx'] } },
    { id: 'lost', exposure: 'NoSuchPart', needs: { seams: ['jsx'] } },
    // a scope it reads needs the app's scope hook and that scope (systems.md E2)
    { id: 'scoped', keys: ['d'], scope: 'react', needs: { seams: ['jsx'] } },
    // a generic component's, matched per element (E8.3f); an exposure's never is
    { id: 'item', keys: ['e'], element: true, needs: { seams: ['jsx'] } },
    { id: 'shell', exposure: 'react', element: true, needs: { seams: ['jsx'] } },
    // a dotted exposure needs the exposure it reaches into
    { id: 'banner', exposure: 'react.PageBanner', needs: { seams: ['jsx'] } },
    { id: 'nobanner', exposure: 'appShell.PageBanner', needs: { seams: ['jsx'] } },
  ] }));
  const f = createFakeHooks({ adapter: { ...pack, seams: { hooks: { jsx: 'seam-jsx', exposures: { react: 'seam-expose:app-shared' } } } } });
  try {
    views.register(f.hooks, { rendererDir: join(dir, 'framework', 'renderer'), preloadPath: '/p' });
    assert.deepEqual(f.electron.syncHandlers.get('codexmods:kernel')(1, { search: '' }).bindings, [{ id: 'plain', keys: ['a'], canary: { a: 'string' } }, { id: 'group', exposure: 'react' }, { id: 'item', keys: ['e'], element: true }, { id: 'shell', exposure: 'react' }, { id: 'banner', exposure: 'react.PageBanner' }]);
    const notArmed = f.logs.info.filter(([m]) => /not armed/.test(m)).map((l) => JSON.stringify(l));
    assert.equal(notArmed.length, 5);
    assert.ok(notArmed.some((l) => l.includes('scoped') && l.includes('exposure useScope')), 'no scope hook: not armed');
    assert.ok(notArmed.some((l) => l.includes('exposure NoSuchPart')));
    assert.ok(notArmed.some((l) => l.includes('exposure NoSuchScope')) && notArmed.some((l) => l.includes('seam noSuchSeam')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kernel boot (presentations.md V3): the armed bindings from present/addresses.json and the taps, synchronously; unreadable addresses arm none', async () => {
  const dir = rendererTree();
  mkdirSync(join(dir, 'framework', 'renderer', 'present'), { recursive: true });
  writeFileSync(join(dir, 'framework', 'renderer', 'present', 'addresses.json'), JSON.stringify({ abi: 1, bindings: [{ id: 'sidebar.item', keys: ['conversationId', 'extraIconBadges'] }, { id: 'bad' }] }));
  const f = createFakeHooks({ adapter: pack });
  try {
    views.register(f.hooks, { rendererDir: join(dir, 'framework', 'renderer'), preloadPath: '/p' });
    const kernel = f.electron.syncHandlers.get('codexmods:kernel');
    assert.deepEqual(kernel(1, { search: '' }), { abi: 1, bindings: [{ id: 'sidebar.item', keys: ['conversationId', 'extraIconBadges'] }], taps: { commands: [], handlers: [], messages: {} }, pageRoute: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const t = reg();
  try {
    // The framework's own addresses need the build-time seams (jsx, exposures): the test pack (20052) has none, so none is armed.
    assert.deepEqual(t.electron.syncHandlers.get('codexmods:kernel')(1, { search: '' }).bindings, [], 'a pack without seams arms none');
    const seamed = createFakeHooks({ adapter: pack21477 });
    views.register(seamed.hooks, { rendererDir: join(t.dir, 'framework', 'renderer'), preloadPath: '/p' });
    const armed = seamed.electron.syncHandlers.get('codexmods:kernel')(1, { search: '' }).bindings;
    assert.equal(seamed.electron.syncHandlers.get('codexmods:kernel')(1, { search: '' }).pageRoute, true, 'the pack has the framework\'s route for a mod\'s page');
    // a mod's page, and an instance's registered view (graph-integrity G2.2: its provider, then its ref in base64url), on the framework's route
    const go = seamed.electron.handlers.get('codexmods:navigate');
    for (const path of ['/codexmods/page/qa.surfaces/page', '/codexmods/page/qa.test-agent/view~WyJxYS50ZXN0LWFnZW50IiwiVGVzdEFnZW50VGhyZWFkIiwidGhyLTEiXQ']) assert.equal(await go(2, { path }), true, path);
    for (const path of ['/codexmods/page/qa.test-agent/view~%7B%22a%22%7D', '/codexmods/page/qa.test-agent/view~', `/codexmods/page/qa.test-agent/view~${'A'.repeat(1400)}`, '/codexmods/page/../view~AAAA']) assert.equal(await go(2, { path }), false, path);
    // every address of the framework's (present/addresses.json, in its order): the 21477 pack delivers all their needs
    const own = OWN_ADDRESSES;
    assert.deepEqual(armed.map((b) => b.id), own, 'the framework\'s own addresses, on a pack that delivers their needs');
    assert.ok(own.includes('sidebar.item') && own.includes('settings.navgroup'));
    assert.deepEqual(armed.find((b) => b.id === 'settings.navgroup'), { id: 'settings.navgroup', exposure: 'NavGroup' }, 'by identity');
    assert.equal(armed[0].canary.conversationId, 'string', 'with their canaries');
    assert.deepEqual([armed.find((b) => b.id === 'status.item').exact, armed[0].exact], [true, undefined], 'exact when the address says so');
    // an exact address's optional keys go with it (22943's drift: one address across builds)
    assert.deepEqual(armed.find((b) => b.id === 'request.surface')?.optional, ['embedded']);
    assert.equal(armed.find((b) => b.id === 'thread.header').scope, 'RouteScope', 'with the scope it reads');
    writeFileSync(join(t.dir, 'framework', 'renderer', 'present', 'addresses.json'), '{not json');
    const f2 = createFakeHooks({ adapter: pack });
    views.register(f2.hooks, { rendererDir: join(t.dir, 'framework', 'renderer'), preloadPath: '/p' });
    assert.deepEqual(f2.electron.syncHandlers.get('codexmods:kernel')(1, { search: '' }).bindings, [], 'unreadable: none armed');
  } finally { t.done(); }
});
