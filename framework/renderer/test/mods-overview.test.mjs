// The Mods list (docs/design/framework-ui.md F2, F4, F5; design-spec §2.1): your mods in sections, each row opening its page with its switch and menu, a search, Install mod…, read and
// acted on through the graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from './fake-react.mjs';
import { pagesFixture, FW, modRef, opRef, at, flush, textOf } from './pages-fixture.mjs';
import { createModsOverview, SECTIONS, matches, countLine } from '../present/mods-overview.mjs';
import { modSectionOf, modWord, canReload } from '../present/mods-text.mjs';
import { refusalOf } from '../present/acting.mjs';

function setup(o = {}) {
  const f = pagesFixture(o);
  const overview = createModsOverview({ ...f.base, pathOf: (id, tab) => `/settings/codexmods/${id}${tab ? `/${tab}` : ''}`, review: o.review, ...(o.LayoutsSection ? { LayoutsSection: o.LayoutsSection } : {}) });
  const t = f.mount(() => f.e(overview.Overview));
  const modRow = (id) => t.all((n) => n.props?.['data-codexmods-mod'] === id)[0];
  const sections = () => t.all((n) => n.type === 'section').map((s) => textOf(findAll(s, (n) => n.type === 'h2')[0]));
  const inRow = (id, type) => findAll(modRow(id), (n) => n.type === type)[0];
  const item = (id, label) => t.menuItem(modRow(id), label);
  return { ...f, ...t, modRow, sections, inRow, item };
}

test('F5: a mod\'s section and word follow the Host\'s state; a newer release found moves only a mod that is on; one reloading stays as its switch says', () => {
  assert.equal(modSectionOf({ state: 'on', status: 'enabled', release: { version: '2' } }), 'updates');
  assert.equal(modSectionOf({ state: 'off', status: 'disabled', release: { version: '2' } }), 'off');
  assert.equal(modSectionOf({ state: 'stopped', status: 'quarantined', release: { version: '2' } }), 'issues');
  assert.equal(modSectionOf({ state: 'reloading', status: 'enabled' }), 'on');
  assert.equal(modSectionOf({ state: 'reloading', status: 'quarantined' }), 'on');
  assert.deepEqual(modWord({ state: 'on' }, true), { word: 'Off in safe mode', tone: 'neutral' });
  assert.deepEqual(modWord({ state: 'off' }, true), { word: 'Off', tone: 'neutral' });
  assert.deepEqual(modWord({ state: 'reloading' }, false), { word: 'Reloading', tone: 'neutral' });
  assert.equal(modWord({ state: 'stopped' }, false).word, 'Stopped');
  assert.match(modWord({ state: 'stopped', quarantine: { at: at('2026-10-28T10:02:00') } }, false).word, /^Stopped at 10:02$/);
  assert.equal(canReload({ state: 'on' }, false), true);
  assert.equal(canReload({ state: 'stopped' }, false), true);
  assert.equal(canReload({ state: 'on' }, true), false, 'safe mode');
  assert.deepEqual(['off', 'consent', 'missing', 'incompatible', 'reloading'].filter((state) => canReload({ state }, false)), []);
});

test('the sections, in their order, each with its count, hidden when empty; your order within each; the count at the end', () => {
  const t = setup({
    order: ['b.one', 'a.two', 'c.three', 'd.four', 'e.five', 'f.six', 'g.seven'],
    mods: {
      'b.one': { name: 'One', description: 'Does one thing' },
      'a.two': { name: 'Two', status: 'disabled' },
      'c.three': { name: 'Three', status: 'quarantined', quarantine: { reason: 'unresponsive', at: at('2026-10-28T00:00:00Z') } },
      'd.four': { name: 'Four', status: 'pendingConsent' },
      'e.five': { name: 'Five', status: 'disabled', problem: 'Its package cannot be read.' },
      'f.six': { name: 'Six', release: { version: '2.0.0', notes: '', addedPermissions: [], verdict: 'compatible' } },
      'g.seven': { name: 'Seven', status: 'quarantined', compatibility: 'blocked', reasons: ['Built for an older Codex.'] },
    },
  });
  assert.deepEqual(SECTIONS.map(([k]) => k), ['updates', 'on', 'issues', 'off']);
  assert.deepEqual(t.sections(), ['Updates1', 'On1', 'Issues4', 'Off1']);
  const issues = t.all((n) => n.props?.['aria-label'] === 'Issues mods')[0];
  assert.deepEqual(findAll(issues, (n) => n.props?.['data-codexmods-mod']).map((n) => n.props['data-codexmods-mod']), ['c.three', 'd.four', 'e.five', 'g.seven'], 'your order');
  assert.match(textOf(t.modRow('b.one')), /^OneDoes one thing/);
  assert.match(textOf(t.modRow('c.three')), /^ThreeStoppedunresponsive/);
  assert.match(textOf(t.modRow('e.five')), /^FiveCan’t be readIts package cannot be read\./);
  assert.match(textOf(t.modRow('g.seven')), /^SevenNot loadedBuilt for an older Codex\./);
  assert.match(textOf(t.modRow('d.four')), /^FourWaiting for you/);
  assert.match(t.text(), /7 mods · 3 on/, 'a stopped mod counts as on, and one that cannot load here does not');
  assert.equal(countLine([{ status: 'enabled' }], true), '1 mod · 1 on · safe mode');
});

test('a row opens its page; its switch and Review… act and do not leave the list; a stopped mod\'s switch stays on and turns it off; the switch waits in safe mode and for what cannot run', async () => {
  const reviewed = [];
  const t = setup({
    review: (id) => reviewed.push(id),
    mods: {
      'a.one': { name: 'One' }, 'b.two': { name: 'Two', status: 'disabled' },
      'c.three': { name: 'Three', status: 'quarantined', quarantine: { reason: 'x', at: 1 } }, 'd.four': { name: 'Four', status: 'pendingConsent' },
      'e.five': { name: 'Five', status: 'disabled', problem: 'unreadable' }, 'f.six': { name: 'Six', status: 'enabled', problem: 'unreadable' },
      'g.seven': { name: 'Seven', status: 'enabled', compatibility: 'blocked' },
    },
  });
  const main = findAll(t.modRow('a.one'), (n) => n.props?.className === 'cmk-row-main')[0];
  assert.equal(main.props['aria-label'], 'One settings');
  main.props.onClick();
  assert.deepEqual(t.navigated, ['/settings/codexmods/a.one']);
  assert.equal(t.inRow('a.one', 'switch').props['aria-label'], 'Turn off One');
  assert.equal(t.inRow('b.two', 'switch').props['aria-label'], 'Turn on Two');
  await t.inRow('a.one', 'switch').props.onChange(false);
  await t.inRow('b.two', 'switch').props.onChange(true);
  assert.equal(t.inRow('c.three', 'switch').props.checked, true);
  await t.inRow('c.three', 'switch').props.onChange(false);
  t.buttonIn(t.modRow('d.four'), 'Review…').props.onClick();
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'disable', []], ['Mod', 'b.two', 'enable', []], ['Mod', 'c.three', 'disable', []]]);
  assert.deepEqual(reviewed, ['d.four'], 'consent is on the mod\'s page');
  assert.equal(t.inRow('e.five', 'switch').props.disabled, true, 'a mod whose package cannot be read is not switched on');
  assert.equal(t.inRow('f.six', 'switch').props.disabled, false, 'but one that is on can always be turned off (E6 review)');
  assert.equal(t.inRow('g.seven', 'switch').props.disabled, true);
  assert.equal(t.inRow('g.seven', 'switch').props.checked, false, 'blocked: it is not running, whatever its record says');
  const safe = setup({ mods: { 'a.one': { name: 'One' } }, fw: { safeMode: true } });
  assert.equal(safe.inRow('a.one', 'switch').props.disabled, true);
  assert.match(safe.text(), /Mods are offCodex is running without mods\./);
  assert.match(safe.text(), /1 mod · 1 on · safe mode/);
});

test('Reload: from the menu of a mod that runs or stopped, as one operation; not while it is off, reloading, in safe mode or unable to run; the badges say so', async () => {
  const t = setup({ mods: { 'a.on': { name: 'On' }, 'b.off': { name: 'Off', status: 'disabled' }, 'c.stopped': { name: 'Stopped', status: 'quarantined', quarantine: { reason: 'x', at: 1 } },
    'd.blocked': { name: 'Blocked', status: 'quarantined', compatibility: 'blocked' }, 'e.again': { name: 'Again', reloading: true }, 'f.new': { name: 'Fresh', new: true } } });
  assert.deepEqual(['a.on', 'b.off', 'c.stopped', 'd.blocked', 'e.again'].map((id) => t.item(id, 'Reload').props.disabled), [false, true, false, true, true]);
  t.item('c.stopped', 'Reload').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['Mod', 'c.stopped', 'reload', []]]);
  assert.match(textOf(t.modRow('e.again')), /^AgainReloading/);
  assert.equal(t.inRow('e.again', 'switch').props.disabled, true, 'a toggle waits for it');
  assert.match(textOf(t.modRow('f.new')), /^FreshNew/);
  const safe = setup({ mods: { 'a.on': { name: 'On' } }, fw: { safeMode: true } });
  assert.equal(safe.item('a.on', 'Reload').props.disabled, true);
});

test('its menu: Settings when it has any, Permissions, Activity, update from a file or a folder, check for updates, uninstall', async () => {
  let next = '/Users/x/demo.codexmod';
  const t = setup({ pickFile: async () => next, mods: { 'a.one': { name: 'One', $links: { settings: { type: 'SettingsSection', id: 'mod:a.one' } } }, 'b.dev': { name: 'Dev', development: true } } });
  assert.equal(t.item('b.dev', 'Settings'), undefined);
  t.item('a.one', 'Settings').props.onClick();
  t.item('a.one', 'Permissions').props.onClick();
  t.item('a.one', 'Activity').props.onClick();
  assert.deepEqual(t.navigated, ['/settings/codexmods/a.one', '/settings/codexmods/a.one/permissions', '/settings/codexmods/a.one/activity']);
  t.item('a.one', 'Update from a file…').props.onClick();
  await flush();
  next = '/Users/x/dev';
  t.item('b.dev', 'Update from a folder…').props.onClick();
  await flush();
  t.item('a.one', 'Check for updates').props.onClick();
  await flush();
  assert.deepEqual(t.picks, [{ extensions: ['codexmod'] }, { directory: true }]);
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'update', ['/Users/x/demo.codexmod']], ['Mod', 'b.dev', 'update', ['/Users/x/dev']], ['CodexMods', 'codexmods', 'checkForUpdates', []]]);
  assert.match(textOf(t.modRow('b.dev')), /Local/);
});

test('E6.6a: each mod moves up or down in your order (every mod once, through the graph); the ends of its section cannot', async () => {
  const t = setup({ mods: { 'a.one': { name: 'One' }, 'b.two': { name: 'Two' }, 'c.three': { name: 'Three' } } });
  assert.equal(t.item('a.one', 'Move up').props.disabled, true);
  assert.equal(t.item('c.three', 'Move down').props.disabled, true);
  t.item('b.two', 'Move up').props.onClick();
  await flush();
  t.item('b.two', 'Move down').props.onClick();
  await flush();
  assert.deepEqual(t.calls.map((c) => [c[0], c[2], c[3][0].map((r) => r.id)]), [
    ['CodexMods', 'setModOrder', ['b.two', 'a.one', 'c.three']], ['CodexMods', 'setModOrder', ['a.one', 'c.three', 'b.two']]]);
  const one = setup({ mods: { 'a.one': {} } });
  assert.equal(one.item('a.one', 'Move up'), undefined, 'one mod: nothing to move');
});

test('a move passes the next mod in its section, whichever others are between them, so it always shows', async () => {
  const t = setup({ mods: { 'a.one': { name: 'One', status: 'disabled' }, 'b.two': { name: 'Two' }, 'c.three': { name: 'Three', status: 'disabled' }, 'd.four': { name: 'Four' } } });
  t.item('c.three', 'Move up').props.onClick();
  await flush();
  assert.deepEqual(t.calls[0][3][0].map((r) => r.id), ['c.three', 'a.one', 'b.two', 'd.four']);
  t.item('b.two', 'Move down').props.onClick();
  await flush();
  assert.deepEqual(t.calls[1][3][0].map((r) => r.id), ['a.one', 'c.three', 'd.four', 'b.two']);
  assert.equal(t.item('b.two', 'Move up').props.disabled, true, 'first in its section, though not in your order');
});

test('Uninstall asks first, keeping its data unless you say; deleting names the operations needing attention; the list stays', async () => {
  const t = setup({ mods: { 'a.one': { name: 'One' } }, ops: [{ id: 'op-5', mod: 'a.one', state: { kind: 'update', outcome: 'needsAttention', message: 'sent requests before reverting' } }] });
  t.item('a.one', 'Uninstall…').props.onClick();
  assert.match(t.dialogText(), /^Uninstall One\?Keep its dataIts data is kept aside/);
  assert.doesNotMatch(t.dialogText(), /need attention/);
  const keep = findAll(t.dialog(), (n) => n.props?.role === 'checkbox')[0];
  assert.equal(keep.props['aria-checked'], true, 'nothing brings deleted data back');
  keep.props.onClick();
  assert.match(t.dialogText(), /This cannot be undone\..*These operations need attention.*Update: sent requests before reverting/);
  await t.inDialog('Uninstall').props.onClick();
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'remove', [false]]]);
  assert.equal(t.dialog(), undefined);
  assert.deepEqual(t.navigated, []);
  t.item('a.one', 'Uninstall…').props.onClick();
  await t.inDialog('Uninstall').props.onClick();
  assert.deepEqual(t.calls[1], ['Mod', 'a.one', 'remove', [true]]);
});

test('a mod with an operation running waits; a refusal is said on its row', async () => {
  const t = setup({
    mods: { 'a.busy': { name: 'Busy' }, 'b.no': { name: 'No' } },
    ops: [{ id: 'op-1', mod: 'a.busy', state: { kind: 'update', outcome: 'running', phase: 'stage' } }],
    invoke: () => ({ status: 'refused', reason: 'notAllowed', message: 'another operation runs' }),
  });
  assert.equal(t.inRow('a.busy', 'switch').props.disabled, true);
  assert.equal(t.item('a.busy', 'Uninstall…').props.disabled, true);
  await t.inRow('b.no', 'switch').props.onChange(false);
  await flush();
  assert.match(textOf(t.modRow('b.no')), /another operation runs/);
  assert.equal(refusalOf({ status: 'failed', error: { message: 'Conflict: look again' } }), 'Conflict: look again');
  assert.equal(refusalOf({ status: 'uncertain' }), 'It is not known whether it happened.');
  assert.equal(refusalOf({ status: 'done' }), null);
});

test('install: Install mod… opens its Dialog on GitHub: owner/repository through CodexMods.installFromGitHub, Enter too; it closes once it happened; a refusal stays in it', async () => {
  const t = setup();
  const open = () => t.buttonIn(t.root.tree, 'Install mod…').props.onClick();
  const repo = () => t.all((n) => n.type === 'input' && n.props['aria-label'] === 'GitHub repository')[0];
  assert.match(t.text(), /No mods installedMods add sidebar sections, status items and panes to Codex\./);
  open();
  assert.match(t.dialogText(), /^Install modMods run inside Codex with the permissions you give them\. Install only mods you trust\.GitHubThis computer/);
  assert.match(t.dialogText(), /Its latest release’s signed \.codexmod package is installed\./);
  assert.equal(t.inDialog('Continue').props.disabled, true, 'nothing entered');
  repo().props.onChange({ target: { value: '  acme/focus ' } });
  assert.equal(t.inDialog('Continue').props.disabled, false);
  await t.inDialog('Continue').props.onClick();
  await flush();
  assert.equal(t.dialog(), undefined, 'it happened: closed');
  open();
  repo().props.onChange({ target: { value: 'acme/timer' } });
  let prevented = false;
  repo().props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'installFromGitHub', ['acme/focus']], ['CodexMods', 'codexmods', 'installFromGitHub', ['acme/timer']]]);
  const refused = setup({ invoke: () => ({ status: 'refused', message: 'acme/none has no release. A mod is installed from a release with a signed .codexmod package.' }) });
  refused.buttonIn(refused.root.tree, 'Install mod…').props.onClick();
  refused.all((n) => n.type === 'input' && n.props['aria-label'] === 'GitHub repository')[0].props.onChange({ target: { value: 'acme/none' } });
  await refused.inDialog('Continue').props.onClick();
  await flush();
  assert.match(refused.dialogText(), /acme\/none has no release/, 'a refusal stays in the Dialog');
  assert.equal(refused.all((n) => n.type === 'input' && n.props['aria-label'] === 'GitHub repository')[0].props['aria-invalid'], 'true');
  refused.inDialog('This computer').props.onClick();
  assert.doesNotMatch(refused.dialogText(), /no release/, 'what GitHub said stays with GitHub');
  refused.inDialog('GitHub').props.onClick();
  assert.match(refused.dialogText(), /acme\/none has no release/);
  refused.inDialog('Cancel').props.onClick();
  refused.buttonIn(refused.root.tree, 'Install mod…').props.onClick();
  assert.doesNotMatch(refused.dialogText(), /no release/, 'opened again: nothing said yet');
});

test('install: This computer: a file through the app\'s chooser and CodexMods.install; a folder only in Developer mode, which it says; a cancelled choice does nothing', async () => {
  let next = '/Users/x/demo.codexmod';
  const t = setup({ pickFile: async () => next });
  const open = () => { t.buttonIn(t.root.tree, 'Install mod…').props.onClick(); t.inDialog('This computer').props.onClick(); };
  open();
  assert.equal(t.inDialog('Continue'), undefined, 'the chooser installs');
  assert.match(textOf(t.row('A folder')), /Turn on Developer mode to load a mod from a folder\./);
  assert.equal(t.buttonIn(t.row('A folder'), 'Choose a folder…').props.disabled, true);
  await t.buttonIn(t.row('A file'), 'Choose a file…').props.onClick();
  await flush();
  assert.equal(t.dialog(), undefined);
  next = null;
  open();
  await t.buttonIn(t.row('A file'), 'Choose a file…').props.onClick();
  await flush();
  assert.ok(t.dialog(), 'cancelled: still open');
  assert.deepEqual(t.picks, [{ extensions: ['codexmod'] }, { extensions: ['codexmod'] }]);
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'install', ['/Users/x/demo.codexmod']]]);
  const dev = setup({ fw: { developerMode: true }, pickFile: async () => '/Users/x/dev-mod' });
  dev.buttonIn(dev.root.tree, 'Install mod…').props.onClick();
  dev.inDialog('This computer').props.onClick();
  assert.match(textOf(dev.row('A folder')), /A development package: loaded from its folder as it is, never updated automatically\./);
  await dev.buttonIn(dev.row('A folder'), 'Choose a folder…').props.onClick();
  await flush();
  assert.deepEqual(dev.picks, [{ directory: true }]);
  assert.deepEqual(dev.calls, [['CodexMods', 'codexmods', 'install', ['/Users/x/dev-mod']]]);
  const none = setup({ pickFile: null });
  none.buttonIn(none.root.tree, 'Install mod…').props.onClick();
  none.inDialog('This computer').props.onClick();
  assert.equal(none.buttonIn(none.row('A file'), 'Choose a file…').props.disabled, true, 'without the app\'s chooser');
});

test('a mod with a newer release, on: in Updates, with Update on its row (CodexMods\' Mod.applyUpdate); not when it cannot run here', async () => {
  const t = setup({ mods: { 'a.one': { name: 'One', release: { version: '2.0.0', notes: '', addedPermissions: [], verdict: 'compatible' } }, 'b.two': { name: 'Two', release: { version: '3.0.0', notes: '', addedPermissions: [], verdict: 'blocked' } } } });
  assert.deepEqual(t.sections(), ['Updates2']);
  const update = (id) => findAll(t.modRow(id), (n) => n.type === 'button' && n.props['aria-label'] === `Update ${id === 'a.one' ? 'One' : 'Two'}`)[0];
  assert.equal(update('b.two').props.disabled, true);
  await update('a.one').props.onClick({ stopPropagation() {} });
  await flush();
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'applyUpdate', []]]);
});

test('the search: name, author and description, without regard to case; none found says so and clears', () => {
  assert.equal(matches({ description: 'Keeps time', author: 'Acme' }, 'Timer', 'acme'), true);
  assert.equal(matches({ description: 'Keeps TIME' }, 'Timer', 'time'), true);
  assert.equal(matches({ description: 'x' }, 'Timer', 'zzz'), false);
  const t = setup({ mods: { 'a.one': { name: 'One', description: 'Alpha' }, 'b.two': { name: 'Two', description: 'Beta' } } });
  const field = () => t.all((n) => n.type === 'input')[0];
  field().props.onChange({ target: { value: 'BETA' } });
  assert.equal(t.modRow('a.one'), undefined);
  assert.ok(t.modRow('b.two'));
  assert.match(t.text(), /2 mods · 2 on/, 'the count is of your mods, not of what is shown');
  field().props.onChange({ target: { value: 'zzz' } });
  assert.match(t.text(), /No mods match “zzz”Try another name or author\./);
  t.buttonIn(t.root.tree, 'Clear search').props.onClick();
  assert.ok(t.modRow('a.one'));
});

test('the Layouts section follows the list', () => {
  const t = setup({ mods: { 'a.one': { name: 'One' } }, LayoutsSection: () => 'the layouts' });
  assert.match(t.text(), /1 mod · 1 onthe layouts/);
});

test('E6.5: its rows and Dialogs are reported as the framework\'s presentations', () => {
  const t = setup({ mods: { 'a.one': { name: 'One' } } });
  assert.deepEqual(t.reported(), [['SettingsRow', 'Mod', 'a.one', 'codexMods', 'mods']]);
  t.item('a.one', 'Uninstall…').props.onClick();
  assert.ok(t.reported().some((r) => r[0] === 'Dialog' && r[1] === 'Mod' && r[3] === 'Window' && r[4] === 'remove'));
  t.inDialog('Cancel').props.onClick();
  assert.ok(!t.reported().some((r) => r[0] === 'Dialog'), 'gone with the Dialog');
  assert.equal(FW.type, 'CodexMods');
  assert.equal(modRef('a').id, 'a');
});

test('before the framework\'s instance is read, only the frame', () => {
  const t = setup({ noFramework: true });
  assert.equal(t.text(), 'ModsInstall mod…');
});

test('F16: a switch turned says so on the page with Undo (Settings has no toast viewport), which turns it back through the graph; refused while an operation on that mod runs', async () => {
  const ops = [];
  const t = setup({ mods: { 'a.one': { name: 'One' } }, ops });
  const notice = () => t.all((n) => n.props?.className === 'cmk-banner')[0];
  await findAll(t.modRow('a.one'), (n) => n.type === 'switch')[0].props.onChange(false);
  await flush();
  t.show();
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'disable', []]]);
  assert.match(textOf(notice()), /^One is offUndo/);
  assert.deepEqual(t.toasts, [], 'not a toast: it would wait for a chat to be shown');
  // an operation on it runs when Undo is pressed: refused, and said
  ops.push({ id: 'op-9', mod: 'a.one', state: { kind: 'disable', outcome: 'running' } });
  t.put(opRef('op-9'), { state: { kind: 'disable', outcome: 'running', startedAt: at('2026-11-03T10:00:00Z') }, links: { mod: modRef('a.one') } });
  t.putFw();
  await t.buttonIn(notice(), 'Undo').props.onClick();
  await flush();
  t.show();
  assert.equal(t.calls.length, 1, 'not turned back');
  assert.match(textOf(notice()), /One has an operation running; try again when it ends\./);
  // it ended: Undo turns it back, and the notice goes
  t.put(opRef('op-9'), { state: { kind: 'disable', outcome: 'succeeded', startedAt: at('2026-11-03T10:00:00Z') }, links: { mod: modRef('a.one') } });
  await t.buttonIn(notice(), 'Undo').props.onClick();
  await flush();
  t.show();
  assert.deepEqual(t.calls[1], ['Mod', 'a.one', 'enable', []], 'turned back');
  assert.equal(notice(), undefined);
});
