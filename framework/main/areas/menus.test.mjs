// framework-main's menus area: the mods' entries composed into each menu the app installs, the app's Menu never changed; chords held
// first come, conflicts told; a choice reported with the window in front.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register, normalize, takenBy } = createRequire(import.meta.url)('./menus.cjs');

// a fake Electron Menu: items with their options; buildFromTemplate makes items from plain objects
class MenuItem { constructor(o) { Object.assign(this, { type: 'normal', visible: true, enabled: true, ...o }); } }
class Menu {
  constructor() { this.items = []; }
  append(it) { this.items.push(it); }
  static buildFromTemplate(t) { const m = new Menu(); for (const o of t) m.append(new MenuItem({ ...o, ...(o.submenu ? { submenu: Menu.buildFromTemplate(o.submenu) } : {}) })); return m; }
}
const appMenu = () => Menu.buildFromTemplate([
  { label: 'Codex', role: 'appMenu' },
  { id: 'file-menu', label: 'File', submenu: [{ label: 'New Chat', accelerator: 'CmdOrCtrl+N' }, { label: 'Hidden', accelerator: 'Cmd+Shift+H', visible: false }] },
  { id: 'view-menu', label: 'View', submenu: [{ label: 'Toggle Sidebar', accelerator: 'Cmd+B' }] },
  { id: 'window-menu', label: 'Window', role: 'windowMenu', submenu: [{ label: 'Minimize', role: 'minimize', getDefaultRoleAccelerator: () => 'Cmd+M' }] },
  { id: 'help-menu', label: 'Help', submenu: [{ label: 'Docs' }] },
]);

function setup() {
  let compose = null, installs = 0;
  const reports = [];
  let handler;
  const hostStates = [];
  const menuBar = { Menu, MenuItem, setCompose(fn) { compose = fn; installs++; }, appMenu: () => null };
  register({ onAreaOp(area, fn) { assert.equal(area, 'menus'); handler = fn; }, areaReport: (area, r) => { assert.equal(area, 'menus'); reports.push(r); }, electron: { menuBar: () => menuBar, focusedWindow: () => 7 }, log: { warn() {} },
    onHostState: (fn) => { hostStates.push(fn); } });
  return { op: (op, args) => handler(op, args), reports, compose: (m) => compose(m), get installs() { return installs; }, get hasCompose() { return !!compose; }, host: (up) => { for (const fn of hostStates) fn(up); } };
}
const entry = (key, item, over = {}) => ({ key, reg: 'r1', mod: key.split('/')[0], path: 'items.0.run', item, ...over });

test('E8.4: accelerators are compared by their keys and modifiers; the app\'s, hidden and role defaults included', () => {
  assert.equal(normalize('CmdOrCtrl+Shift+K', true), 'cmd+shift+k');
  assert.equal(normalize('Shift+Command+k', true), 'cmd+shift+k');
  assert.equal(normalize('Option+Ctrl+P', true), 'ctrl+alt+p');
  assert.equal(normalize('Cmd+Hyper+P', true), null);
  const taken = takenBy(appMenu());
  assert.deepEqual([...taken.keys()].sort(), ['cmd+b', 'cmd+m', 'cmd+n', 'cmd+shift+h'].map((k) => normalize(k.replace('cmd', 'Cmd'), true)).sort());
});

test('E8.4: the mods\' entries join each app menu in a section of their own; a mod\'s own menu before Window; the app\'s Menu untouched', async () => {
  const s = setup();
  await s.op('set', { entries: [
    entry('a.mod/rec', { id: 'rec', title: 'Pause Recording', in: 'view', keys: 'CmdOrCtrl+Alt+P', type: 'checkbox', checked: true }),
    entry('a.mod/new', { id: 'new', title: 'New Note', in: { menu: 'Notes' }, keys: 'CmdOrCtrl+B' }),
    entry('b.mod/x', { id: 'x', title: 'Also Alt P', in: 'view', keys: 'Cmd+Alt+P' }),
    entry('b.mod/bad', { id: 'bad', title: 'Nowhere', in: 'tools' }),
  ] });
  assert.ok(s.hasCompose);
  const app = appMenu();
  const before = JSON.stringify(app.items.map((t) => [t.id, t.submenu?.items.length]));
  const out = s.compose(app);
  assert.equal(JSON.stringify(app.items.map((t) => [t.id, t.submenu?.items.length])), before, 'the app\'s Menu is not changed');
  assert.deepEqual(out.items.map((t) => t.id ?? t.label), ['Codex', 'file-menu', 'view-menu', 'codexmods:menu:Notes', 'window-menu', 'help-menu']);
  assert.equal(out.items[1], app.items[1], 'a menu with no mod entry is the app\'s own item');
  const view = out.items[2].submenu.items;
  assert.equal(view[0], app.items[2].submenu.items[0], 'the app\'s own items first, the same objects');
  assert.equal(view[1].type, 'separator');
  assert.deepEqual(view.slice(2).map((i) => [i.label, i.type, i.checked, i.accelerator ?? null]), [['Pause Recording', 'checkbox', true, 'CmdOrCtrl+Alt+P'], ['Also Alt P', 'normal', false, null]]);
  assert.deepEqual(out.items[3].submenu.items.map((i) => [i.label, i.accelerator ?? null]), [['New Note', null]], 'Cmd+B is the app\'s Toggle Sidebar');
  assert.deepEqual(s.reports.at(-1), { event: 'shortcuts', results: [
    { key: 'a.mod/rec', keys: 'CmdOrCtrl+Alt+P', held: true },
    { key: 'a.mod/new', keys: 'CmdOrCtrl+B', held: false, conflict: 'Toggle Sidebar' },
    { key: 'b.mod/x', keys: 'Cmd+Alt+P', held: false, conflict: 'Pause Recording' },
  ] }, 'decided in rule order');
  // choosing: the key, its registration, its path, the window, the state after the click, how
  view[2].checked = false;
  view[2].click(view[2], { id: 99, webContents: { id: 3 } }, { triggeredByAccelerator: true });   // the window by its page's webContents id (review 4)
  out.items[3].submenu.items[0].click(out.items[3].submenu.items[0], null, {});
  assert.deepEqual(s.reports.slice(-2), [
    { event: 'choose', key: 'a.mod/rec', reg: 'r1', path: 'items.0.run', windowId: 3, checked: false, via: 'keys' },
    { event: 'choose', key: 'a.mod/new', reg: 'r1', path: 'items.0.run', windowId: 7, checked: null, via: 'menu' },
  ]);
  // the Host down: entries disabled (framework-main tells the area when the Host exits and when it is ready); no entries: the app's own menu as it is
  const installed = s.installs;
  s.host(false);
  assert.equal(s.compose(appMenu()).items[2].submenu.items[2].enabled, false);
  assert.equal(s.installs, installed + 1, 'the menus are built again');
  s.host(true);
  assert.equal(s.compose(appMenu()).items[2].submenu.items[2].enabled, true, 'back: enabled again');
  await s.op('host', { up: false });
  assert.equal(s.compose(appMenu()).items[2].submenu.items[2].enabled, false);
  await s.op('set', { entries: [] });
  assert.equal(s.hasCompose, false);
  await assert.rejects(s.op('set', {}), /entries is a list/);
  await assert.rejects(s.op('other', {}), /unknown operation/);
});

test('E8.4b: the app\'s own entries by their path of labels (no role, separator, hidden or protected one), told when they change; choose clicks one', async () => {
  const { appEntries } = createRequire(import.meta.url)('./menus.cjs');
  const menu = Menu.buildFromTemplate([
    { label: 'Codex', submenu: [{ label: 'About Codex', role: 'about' }, { label: 'Einstellungen…', accelerator: 'Cmd+,' }, { label: 'Abmelden' }, { label: 'Check for Updates…' }, { type: 'separator' }, { label: 'Quit Codex', role: 'quit' }] },
    { id: 'file-menu', label: 'File', submenu: [{ label: 'New Chat', accelerator: 'CmdOrCtrl+N' }, { label: 'Hidden', visible: false }, { label: 'Open Recent', submenu: [{ label: 'repo' }] }, { id: 'codexmods:x/y', label: 'A mod\'s' }] },
    { id: 'view-menu', label: 'View', submenu: [{ label: 'Show Sidebar', type: 'checkbox', checked: true, enabled: false }, { label: 'Browser', enabled: false, submenu: [{ label: 'Reload' }] }] },
  ]);
  // on macOS the application menu is never listed, whatever its labels' language; an entry under a menu turned off is off
  assert.deepEqual(appEntries(menu, true), [
    { path: ['File', 'New Chat'], title: 'New Chat', menu: 'File', shortcut: 'CmdOrCtrl+N', enabled: true },
    { path: ['File', 'Open Recent', 'repo'], title: 'repo', menu: 'File › Open Recent', enabled: true },
    { path: ['View', 'Show Sidebar'], title: 'Show Sidebar', menu: 'View', enabled: false, checked: true },
    { path: ['View', 'Browser', 'Reload'], title: 'Reload', menu: 'View › Browser', enabled: false },
  ]);
  assert.deepEqual(appEntries(menu, false).slice(0, 3).map((e) => e.title), ['Einstellungen…', 'Abmelden', 'Check for Updates…'], 'elsewhere (no application menu) only English protected labels and roles are left out');
  // the hold tells each menu the app installs; the entries are reported when they change
  let told = null, chosen = [];
  const reports = [];
  let handler;
  const menuBar = { Menu, MenuItem, setCompose() {}, appMenu: () => menu, onAppMenu: (fn) => { told = fn; }, choose: (it) => chosen.push(it.label) };
  register({ onAreaOp(area, fn) { handler = fn; }, areaReport: (area, r) => reports.push(r), electron: { menuBar: () => menuBar }, log: { warn() {} } });
  assert.equal((await handler('entries', {})).entries.length, process.platform === 'darwin' ? 4 : 7);
  told(menu);
  assert.equal(reports.length, 0, 'the same entries are not told again');
  menu.items[1].submenu.items[0].enabled = false;
  told(menu);
  assert.deepEqual(reports.at(-1).event, 'entries');
  assert.equal(reports.at(-1).entries.find((e) => e.title === 'New Chat').enabled, false);
  await assert.rejects(handler('choose', { path: ['File', 'New Chat'] }), /turned off/);
  menu.items[1].submenu.items[0].enabled = true;
  await handler('choose', { path: ['File', 'New Chat'] });
  assert.deepEqual(chosen, ['New Chat']);
  await assert.rejects(handler('choose', { path: ['Codex', 'Quit Codex'] }), /no such entry/, 'a role is never chosen');
  await assert.rejects(handler('choose', { path: ['Codex', 'Einstellungen…'] }), /no such entry/, 'nor a protected one');
  await assert.rejects(handler('choose', { path: ['View', 'Browser', 'Reload'] }), /turned off/, 'its menu is off');
  await assert.rejects(handler('choose', { path: 'File/New Chat' }), /path of labels/);
});

test('H6m3b: the user\'s click on an app entry (or its chord) is their Command.run, held while something holds it (the app\'s click once let go, never when refused, nor when the window in front or the menu changed meanwhile); a mod\'s choose goes on at once; observed, reported after', async () => {
  const menu = Menu.buildFromTemplate([
    { label: 'Codex', role: 'appMenu' },
    { id: 'view-menu', label: 'View', submenu: [{ label: 'Toggle Sidebar', accelerator: 'Cmd+B' }, { label: 'Copy', role: 'copy' }, { label: 'Toggle Sidebar', accelerator: 'Cmd+Shift+S', visible: false }] },
  ]);
  const ran = [];
  const item = menu.items[1].submenu.items[0];
  item.click = (event, win) => { ran.push([event?.triggeredByAccelerator === true ? 'keys' : 'click', win]); return 'ran'; };
  const role = menu.items[1].submenu.items[1];
  const roleClick = () => 'role';
  role.click = roleClick;
  const sent = [], host = {};
  let handler, told;
  const menuBar = { Menu, MenuItem, setCompose() {}, appMenu: () => menu, onAppMenu: (fn) => { told = fn; }, choose: (it) => it.click({ triggeredByAccelerator: false }, 'front') };
  let front = 1;
  register({ onAreaOp(area, fn) { handler = fn; }, areaReport() {}, electron: { menuBar: () => menuBar, focusedWindow: () => front }, log: { warn() {}, info() {} },
    sendToHost: (m) => sent.push(m), onHostMessage: (type, fn) => { host[type] = fn; } });
  assert.equal(typeof told, 'function');
  assert.equal(role.click, roleClick, 'a role\'s item is the system\'s: left as it is');
  // nothing holds it: the app's click at once
  assert.equal(item.click({}, 'w1'), 'ran');
  assert.deepEqual([ran, sent], [[['click', 'w1']], []]);
  host['user-holds']({ held: ['Command.run'], observed: [] });
  // held: asked first (the entry by its path), the app's click once let go, its outcome told
  assert.equal(item.click({}, 'w2'), undefined);
  assert.deepEqual(sent.at(-1), { type: 'user-hold', requestId: sent.at(-1).requestId, ref: { type: 'MenuEntry', provider: 'framework', path: ['View', 'Toggle Sidebar'] }, operation: 'choose', args: [], changes: false });
  assert.equal(ran.length, 1);
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran.at(-1), ['click', 'w2']);
  assert.deepEqual(sent.at(-1), { type: 'user-hold-done', requestId: sent.at(-2).requestId, outcome: { status: 'done' } });
  // refused: never clicked
  item.click({}, 'w3');
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: false, message: 'no' });
  await new Promise((r) => setImmediate(r));
  assert.equal(ran.length, 2);
  // its chord is held too (a main-only command's handler never reaches the page); a mod's choose: at once, never asked
  const asked = sent.filter((m) => m.type === 'user-hold').length;
  assert.equal(item.click({ triggeredByAccelerator: true }, 'w4'), undefined);
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: true });
  await new Promise((r) => setImmediate(r));
  await handler('choose', { path: ['View', 'Toggle Sidebar'] });
  assert.deepEqual(ran.slice(-2), [['keys', 'w4'], ['click', 'front']]);
  assert.equal(sent.filter((m) => m.type === 'user-hold').length, asked + 1);
  // let go after another window came to the front, or after the menu was installed again: not run
  item.click({}, 'w5');
  front = 2;
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(ran.length, 4);
  assert.match(sent.at(-1).outcome.error.message, /window in front or the app's menu changed/);
  item.click({}, 'w6');
  told(menu);
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(ran.length, 4, 'the menu installed again: not run (and its items wrapped once)');
  // an item that names its command (the menu-command seam): its Command, whatever its label says
  item.codexmodsCommand = 'toggleSidebar';
  item.click({}, 'w7');
  assert.deepEqual([sent.at(-1).ref, sent.at(-1).operation], [{ type: 'Command', provider: 'codex', id: 'toggleSidebar' }, 'run']);
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: false, message: 'no' });
  delete item.codexmodsCommand;
  // a hidden item (a second chord's alias): its chord is the user's run too (built review round 2)
  const alias = menu.items[1].submenu.items[2];
  alias.click = () => { ran.push(['alias']); return 'alias'; };
  told(menu);
  host['user-holds']({ held: ['Command.run'], observed: [] });
  const before = sent.filter((m) => m.type === 'user-hold').length;
  assert.equal(alias.click({ triggeredByAccelerator: true }, 'w9'), undefined);
  assert.equal(sent.filter((m) => m.type === 'user-hold').length, before + 1);
  host['user-hold-answer']({ requestId: sent.at(-1).requestId, go: false, message: 'no' });
  await new Promise((r) => setImmediate(r));
  assert.equal(ran.some((x) => x[0] === 'alias'), false);
  // observed only: at once, reported after
  host['user-holds']({ held: [], observed: ['Command.run'] });
  assert.equal(item.click({}, 'w8'), 'ran');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.at(-1), { type: 'user-did', ref: { type: 'MenuEntry', provider: 'framework', path: ['View', 'Toggle Sidebar'] }, operation: 'choose', args: [], outcome: { status: 'done' } });
});
