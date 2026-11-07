// framework-main's windows area: the app's own messages to one window by its id, focusing it, and refusals before anything is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./windows.cjs');

function setup({ views = true, pageRoute = true } = {}) {
  const posted = [];
  const focused = [];
  const closed = [];
  const actions = [];
  let handler;
  // Each held window's AppView runs the app's actions in that window (its own services).
  const view = (id) => ({ services: { appActions: { run: (envelope) => { actions.push([id, envelope.action]); return Promise.resolve({}); } } } });
  const hooks = {
    onAreaOp(area, fn) { assert.equal(area, 'windows'); handler = fn; },
    electron: {
      focusedWindow: () => 9, hasWindow: (id) => id === 7 || id === 9, focusWindow: (id) => { focused.push(id); return id === 7; }, closeWindow: (id) => { closed.push(id); return true; },
      postToWindow: (id, channel, m) => posted.push([id, channel, m]),
    },
    appHost: { windows: () => [{ id: 7, host: {}, view: views ? view(7) : null }, { id: 9, host: {}, view: views ? view(9) : null }] },
    adapter: { seams: { hooks: pageRoute ? { pageRoute: 'seam-page-route' } : {} } },
  };
  register(hooks);
  return { handler, posted, focused, closed, actions };
}

test('each operation is the message the app\'s main sends its page, to that window; open is a thread or a settings section', async () => {
  const s = setup();
  assert.deepEqual(await s.handler('open', { windowId: 7, threadId: 'th-1' }), {});
  await s.handler('open', { windowId: 7, settings: 'git' });
  for (const op of ['back', 'forward', 'toggleSidebar', 'togglePanel', 'focusComposer', 'renameThread', 'newChat']) await s.handler(op, { windowId: 7 });
  await s.handler('palette', { windowId: 7, query: 'settings' });
  await assert.rejects(s.handler('palette', { windowId: 7, query: '' }), (e) => e.refused === true);
  assert.deepEqual(s.posted.map(([id, ch, m]) => [id, ch, m.type, m.path ?? null]), [
    [7, 'codex_desktop:message-for-view', 'navigate-to-route', '/local/th-1'], [7, 'codex_desktop:message-for-view', 'navigate-to-route', '/settings/git'],
    [7, 'codex_desktop:message-for-view', 'navigate-back', null], [7, 'codex_desktop:message-for-view', 'navigate-forward', null],
    [7, 'codex_desktop:message-for-view', 'toggle-sidebar', null], [7, 'codex_desktop:message-for-view', 'toggle-diff-panel', null],
    [7, 'codex_desktop:message-for-view', 'focus-composer', null], [7, 'codex_desktop:message-for-view', 'rename-thread', null],
    [7, 'codex_desktop:message-for-view', 'new-chat', null], [7, 'codex_desktop:message-for-view', 'command-menu', null],
  ]);
  assert.equal(s.posted.at(-1)[2].query, 'settings', 'the palette on its query');
  await s.handler('palette', { windowId: 7 });
  assert.deepEqual(s.posted.at(-1)[2], { type: 'command-menu' }, 'the palette without a query (graph-layers L3: Window.openPalette)');
  assert.deepEqual(s.posted[0][2].threadSelection, { kind: 'local', conversationId: 'th-1', hostId: 'local' }, 'as a sidebar row opens it');
  assert.deepEqual(await s.handler('focus', { windowId: 7 }), {});
  assert.deepEqual(s.focused, [7]);
  assert.deepEqual(await s.handler('close', { windowId: 7 }), {});
  assert.deepEqual(s.closed, [7]);
});

test('E7.1: the app\'s sidebar actions run in the window asked for, through its own AppView; anything else is refused', async () => {
  const s = setup();
  const project = { projectId: 'p-1' };
  await s.handler('appAction', { windowId: 9, action: { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project, collapsed: true } });
  await s.handler('appAction', { windowId: 7, action: { type: 'windows.sidebar.project_set_show_all', windowId: 'current', project, showAll: true, extra: 1 } });
  assert.deepEqual(s.actions, [
    [9, { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project, collapsed: true }],
    [7, { type: 'windows.sidebar.project_set_show_all', windowId: 'current', project, showAll: true }],
  ], 'in that window, with only what the action takes');
  for (const action of [
    { type: 'toys.confetti', windowId: 'current' }, { type: 'windows.sidebar.project_set_collapsed', windowId: 'other', project, collapsed: true },
    { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project: { label: 'x' }, collapsed: true },
    { type: 'windows.sidebar.project_set_show_all', windowId: 'current', project, showAll: 'yes' },
  ]) await assert.rejects(s.handler('appAction', { windowId: 7, action }), (e) => e.refused === true);
  assert.equal(s.actions.length, 2);
  // the panel's tab for a file or the review (E7.4), and the panel closed
  await s.handler('appAction', { windowId: 7, action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/r/a.txt', extra: 1 } } });
  assert.deepEqual(s.actions.at(-1), [7, { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/r/a.txt' } }]);
  await assert.rejects(s.handler('appAction', { windowId: 7, action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'page', url: 'x' } } }), (e) => e.refused === true);
  await s.handler('setPanel', { windowId: 7, open: false });
  await s.handler('setPanel', { windowId: 7, open: true });
  assert.deepEqual(s.posted.slice(-2).map(([, , m]) => m), [{ type: 'toggle-diff-panel', open: false, codexmods: true }, { type: 'toggle-diff-panel', open: true, codexmods: true }]);
  await assert.rejects(s.handler('setPanel', { windowId: 7 }), (e) => e.refused === true);
  // a page in the window's in-app browser: the app's own message, http or https only
  const opened = await s.handler('openBrowser', { windowId: 7, url: 'https://example.com/a' });
  assert.match(opened.browserTabId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(s.posted.at(-1)[2], { type: 'open-browser-tab', source: 'manual', initialUrl: 'https://example.com/a', active: true, browserTabId: opened.browserTabId });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 7]) await assert.rejects(s.handler('openBrowser', { windowId: 7, url }), (e) => e.refused === true);
  await assert.rejects(setup({ views: false }).handler('appAction', { windowId: 7, action: { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project, collapsed: true } }), /cannot be reached/);
});

test('newWindow: the page of the window named (else the one the user is in) asks the app for one, on a chat or the app\'s home', async () => {
  const s = setup();
  await s.handler('newWindow', { path: '/local/th-1' });
  await s.handler('newWindow', { path: '/', windowId: 7 });
  assert.deepEqual(s.posted, [[9, 'codexmods:new-window', { path: '/local/th-1' }], [7, 'codexmods:new-window', { path: '/' }]]);
  for (const args of [{ path: '/settings/general' }, { path: '/local/a b' }, {}, { path: '/', windowId: 3 }]) await assert.rejects(s.handler('newWindow', args), (e) => e.refused === true);
  assert.equal(s.posted.length, 2);
});

test('E7.6c: the window the user is in, by the adapter (no window id needed)', async () => {
  const s = setup();
  assert.deepEqual(await s.handler('focused', {}), { windowId: 9 });
  assert.deepEqual(s.posted, []);
});

test('refused before anything is sent: no window id, a window that is not open, an unknown operation or target', async () => {
  const s = setup();
  for (const [op, args, re] of [
    ['back', {}, /window id/], ['back', { windowId: 8 }, /not open/], ['closeAll', { windowId: 7 }, /unknown operation/],
    ['open', { windowId: 7, threadId: '../x y' }, /a thread id, a settings section or a mod's page/], ['open', { windowId: 7, settings: 'Bad Section' }, /a thread id/],
    ['open', { windowId: 7, page: '../x/y' }, /a thread id/], ['open', { windowId: 7, page: 'noslash' }, /a thread id/],
  ]) await assert.rejects(s.handler(op, args), (e) => e.refused === true && re.test(e.message));
  assert.deepEqual(s.posted, []);
});

test('layouts WL5a: a mod\'s page opens by its route, only where the app\'s route tree has it: a path with no route blanks the window', async () => {
  const s = setup();
  await s.handler('open', { windowId: 7, page: 'qa.mod/notes' });
  assert.deepEqual(s.posted.map(([id, channel, m]) => [id, channel, m.type, m.path]), [[7, 'codex_desktop:message-for-view', 'navigate-to-route', '/codexmods/page/qa.mod/notes']]);
  const none = setup({ pageRoute: false });
  await assert.rejects(none.handler('open', { windowId: 7, page: 'qa.mod/notes' }), (e) => e.refused === true && /no route for a mod's page/.test(e.message));
  assert.deepEqual(none.posted, []);
});
