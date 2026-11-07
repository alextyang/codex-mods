// The Mods pages in the app's Settings (docs/design/framework-ui.md F2; systems.md S15, E0): routes under the settings route kept in step with the mods, the Mods group after the app's
// first navigation group, the navigation's highlight on the pages, and the pages drawn with the app's components.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { startSettingsPages, findSettingsRoute, syncRoutes, isFirstGroup, groupOf, settingsPages, setSettingsPagesStarter, ownPageOf, FRAMEWORK_REF, modRef, ACTIVE_SECTION, pathOf, pagePathOf, OVERVIEW_PATH, UPDATE_PATH, DEVELOPER_PATH } from '../present/settings-pages.mjs';
import { settingsNav, settingsNavGroup } from '../present/bindings/settings-nav.mjs';
import { createPagesStatus } from '../pages-status.mjs';

/** The app's route tree, in the shape the router reads: the settings route is nested, with its catch-all last. */
const routeTree = () => [{ path: undefined, children: [{ path: '/', children: [{ path: '/settings', element: 'layout', children: [{ index: true }, { path: 'git-settings' }, { path: '*' }] }] }] }];

function setup({ mods = ['unit.a', 'unit.b'], exposures = {}, status, quarantined = [], update = null } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const routes = routeTree();
  const h = (tag) => ({ children, ...p }) => React.createElement(tag, p, children);
  const Section = Object.assign(h('section'), { Header: ({ title }) => React.createElement('h2', null, title), Content: h('div') });
  const exports = {
    routes, SettingsPageFrame: ({ title, subtitle, children }) => React.createElement('main', null, React.createElement('h1', null, title), subtitle ?? null, children),
    SettingsSection: Section, SettingsCard: h('ul'),
    SettingsRow: ({ label, description, control }) => React.createElement('li', null, label, ...(description ? [' (', description, ')'] : []), ': ', control),
    NavGroup: ({ title, children }) => React.createElement('nav', null, title, children),
    NavItem: ({ label, isActive, onClick, unread, trailing }) => React.createElement('button', { onClick, 'aria-pressed': isActive, 'data-unread': unread }, label, isActive ? '*' : '', trailing ?? null),
    ...exposures,
  };
  const subjects = new Map();
  const put = (ref, snap) => subjects.set(`${ref.type}:${ref.id}`, { ref, ...snap });
  const COPY = { type: 'CopyUpdate', provider: FRAMEWORK_REF.provider, id: 'copy' };
  const putFw = (ids) => put(FRAMEWORK_REF, { state: {}, links: { mods: ids.map(modRef), ...(update ? { update: COPY } : {}) } });
  putFw(mods);
  if (update) put(COPY, { state: update });
  for (const id of mods) put(modRef(id), { state: { name: id === 'unit.a' ? 'Unit A' : 'Unit B', version: '1.2.0', status: quarantined.includes(id) ? 'quarantined' : 'enabled', state: quarantined.includes(id) ? 'stopped' : 'on', running: true, compatibility: 'compatible', reasons: [], development: false, permissions: [{ id: 'ui', text: 'Can add controls', risk: 'low', granted: true }] } });
  const touched = [];
  const ctx = {
    react: () => React,
    use: (fn) => fn(),
    subject: (ref) => subjects.get(`${ref.type}:${ref.id}`),
    local: { read() {}, touch: (k) => touched.push(k) },
  };
  const watchers = new Set();
  const pages = startSettingsPages({
    exports: () => exports, ctx, node: (rule, type, props) => React.createElement(type, props),
    observe: () => ({ dispose() {} }), get: (ref) => subjects.get(`${ref.type}:${ref.id}`),
    watch: (ref, fn) => { watchers.add(fn); return { dispose() { watchers.delete(fn); } }; },
    ...(status ? { pages: status } : {}),
  });
  const changeMods = (ids) => { putFw(ids); for (const fn of watchers) fn(); };
  return { React, ReactDOM, routes, pages, changeMods, touched, ctx, exports };
}

test('the settings route is found in the tree, and a route per mod goes under it before its catch-all, replaced on each change', () => {
  const routes = routeTree();
  const settings = findSettingsRoute(routes);
  assert.equal(settings.element, 'layout');
  const routesOf = (ids) => ids.map((id) => ({ id: `codexmods-${id}`, path: `codexmods/${id}`, element: `page ${id}` }));
  assert.equal(syncRoutes(settings, routesOf(['a', 'b'])), 2);
  assert.deepEqual(settings.children.map((c) => c.path ?? 'index'), ['index', 'git-settings', 'codexmods/a', 'codexmods/b', '*']);
  syncRoutes(settings, routesOf(['b']));
  assert.deepEqual(settings.children.map((c) => c.path ?? 'index'), ['index', 'git-settings', 'codexmods/b', '*']);
  syncRoutes(settings, []);
  assert.deepEqual(settings.children.map((c) => c.path ?? 'index'), ['index', 'git-settings', '*']);
  assert.equal(findSettingsRoute([{ path: '/' }]), null);
  assert.equal(syncRoutes(null, routesOf(['a'])), 0);
});

test('the pages follow the framework\'s mods: a route per installed mod and tab, gone when it is removed and on disposal; what is not installed has a page of its own', () => {
  const { routes, pages, changeMods } = setup();
  const children = () => findSettingsRoute(routes).children.map((c) => c.path).filter((p) => p?.startsWith('codexmods'));
  const fixed = ['codexmods', 'codexmods/~update', 'codexmods/~developer', 'codexmods/~detail'];
  const of = (id) => [`codexmods/${id}`, `codexmods/${id}/permissions`, `codexmods/${id}/activity`];
  assert.deepEqual(children(), [...fixed, ...of('unit.a'), ...of('unit.b'), 'codexmods/*']);
  changeMods(['unit.b']);
  assert.deepEqual(children(), [...fixed, ...of('unit.b'), 'codexmods/*']);
  changeMods([]);
  assert.deepEqual(children(), [...fixed, 'codexmods/*'], 'the list stays with no mods');
  assert.equal(findSettingsRoute(routes).children.at(-1).path, '*', 'before the catch-all');
  changeMods(['unit.b']);
  assert.equal(settingsPages(), pages);
  pages.dispose();
  assert.deepEqual(children(), []);
  assert.equal(settingsPages(), null);
});

test('an instance\'s own page: a Mod\'s, the list for CodexMods, Update for the CopyUpdate, an Operation\'s mod\'s Activity, or Developer when no installed mod holds it', () => {
  const P = FRAMEWORK_REF.provider;
  const subjects = new Map([['a', { links: { mod: modRef('unit.a') } }], ['b', { links: { mod: modRef('gone.mod') } }], ['c', { links: {} }], ['unit.a', { state: {} }]]);
  const read = (ref) => subjects.get(ref.id);
  assert.equal(ownPageOf(modRef('unit.a')), pathOf('unit.a'));
  assert.equal(ownPageOf(FRAMEWORK_REF), OVERVIEW_PATH);
  assert.equal(ownPageOf({ type: 'CopyUpdate', provider: P, id: 'copy' }), UPDATE_PATH);
  assert.equal(ownPageOf({ type: 'Operation', provider: P, id: 'a' }, read), '/settings/codexmods/unit.a/activity');
  assert.equal(ownPageOf({ type: 'Operation', provider: P, id: 'b' }, read), DEVELOPER_PATH);
  assert.equal(ownPageOf({ type: 'Operation', provider: P, id: 'c' }, read), DEVELOPER_PATH);
  assert.equal(ownPageOf({ type: 'Feature', provider: P, id: 'x' }), null);
  assert.equal(ownPageOf({ type: 'Mod', provider: 'other', id: 'x' }), null);
});

test('without the app\'s settings parts (an exposure missing on the build) there are no mod pages', () => {
  const { pages } = setup({ exposures: { NavGroup: undefined } });
  assert.equal(pages, null);
  assert.equal(settingsPages(), null);
});

test('a mod page shows the mod with the app\'s frame, sections and rows, on its tab; while it is shown the Mods entry is active and the app\'s are not', () => {
  const { ReactDOM, routes, pages, touched } = setup();
  const route = findSettingsRoute(routes).children.find((c) => c.path === 'codexmods/unit.a/permissions');
  const root = ReactDOM.createRoot({});
  root.render(route.element);
  const text = rootText(root);
  assert.match(text, /Unit A/);
  assert.match(text, /On· v1\.2\.0/);
  assert.equal(root.tree.props['data-codexmods-framework'], '', 'the page is a framework root (E6.4b)');
  assert.match(text, /Version: 1\.2\.0/);
  assert.match(text, /Can add controls: Required/);
  assert.equal(pages.state.active, 'unit.a');
  assert.ok(touched.length >= 1, 'the navigation is told');
  // The navigation: no app entry active, onSelect kept for the Mods entries.
  const navProps = { settingsSections: [], groupSettingsSections: true, activeSection: 'general-settings', onSelect: () => {}, searchableSections: [] };
  const factory = (type, props) => ({ type, props });
  const out = settingsNav.render('Nav', navProps, factory);
  assert.equal(out.props.activeSection, ACTIVE_SECTION);
  assert.equal(pages.state.onSelect, navProps.onSelect);
  root.unmount();
  assert.equal(pages.state.active, null, 'leaving the page clears it');
  assert.equal(settingsNav.render('Nav', navProps, factory), undefined, 'elsewhere the navigation is the app\'s own');
  pages.dispose();
});

test('the Mods group comes after the app\'s first navigation group only, and its entries navigate through the navigation\'s own onSelect', () => {
  const { React, ReactDOM, pages, ctx } = setup();
  const factory = (type, props) => React.createElement(type, props);
  const coding = { title: React.createElement('FormattedMessage', { id: 'settings.nav.heading.coding' }), children: [] };
  const personal = { title: React.createElement('FormattedMessage', { id: 'settings.nav.heading.personal' }), children: [] };
  assert.equal(isFirstGroup(personal), true);
  assert.equal(isFirstGroup(coding), false);
  assert.equal(isFirstGroup({ title: null }), false);
  assert.equal(settingsNavGroup.render('Group', coding, factory, ctx), undefined);
  const out = settingsNavGroup.render('Group', personal, factory, ctx);
  assert.equal(out.type, React.Fragment);
  const selected = [];
  pages.setOnSelect((...a) => selected.push(a));
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(pages.ModsGroup));
  assert.equal(rootText(root), 'ModsMods2Developer', 'no row per mod; no Update while none is offered; the Mods row says how many');
  const [mods, developer] = findAll(root.tree, (c) => c.type === 'button');
  assert.equal(root.tree.props['data-codexmods-framework'], '', 'a framework root: no mod\'s style rule reaches inside (E6.4b)');
  mods.props.onClick();
  developer.props.onClick();
  assert.deepEqual(selected, [[ACTIVE_SECTION, undefined, OVERVIEW_PATH], [ACTIVE_SECTION, undefined, DEVELOPER_PATH]]);
  pages.dispose();
  assert.equal(settingsNavGroup.render('Group', personal, factory, ctx), undefined, 'without the pages the group is the app\'s own');
});

test('the Update entry shows while one is offered, with what it is at; the entries are active on their pages', () => {
  for (const [state, says] of [[{ state: 'available', build: { to: '26.1017.9' } }, '26.1017'], [{ state: 'downloading', build: { to: '26.1017.9' } }, 'Preparing'], [{ state: 'ready', build: { to: '26.1017.9' } }, 'Ready'], [{ state: 'available', framework: { to: '1.0.1' } }, '1.0.1']]) {
    const { React, ReactDOM, pages } = setup({ update: state });
    const root = ReactDOM.createRoot({});
    root.render(React.createElement(pages.ModsGroup));
    assert.equal(rootText(root), `ModsUpdate${says}Mods2Developer`);
    pages.dispose();
  }
  const { React, ReactDOM, routes, pages } = setup({ update: { state: 'ready', version: '26.1017' } });
  const nav = ReactDOM.createRoot({});
  const tree = findSettingsRoute(routes);
  const go = (path) => { const r = ReactDOM.createRoot({}); r.render(tree.children.find((c) => c.path === path).element); nav.render(React.createElement(pages.ModsGroup)); const out = rootText(nav); r.unmount(); return out; };
  assert.equal(go('codexmods/~update'), 'ModsUpdate*ReadyMods2Developer');
  assert.equal(go('codexmods/~developer'), 'ModsUpdateReadyMods2Developer*');
  assert.equal(go('codexmods'), 'ModsUpdateReadyMods*2Developer');
  assert.equal(go('codexmods/unit.a/activity'), 'ModsUpdateReadyMods*2Developer');
  assert.equal(go('codexmods/*'), 'ModsUpdateReadyMods*2Developer', 'what is not installed is under Mods too');
  const gone = ReactDOM.createRoot({});
  gone.render(tree.children.find((c) => c.path === 'codexmods/*').element);
  assert.match(rootText(gone), /This mod isn’t installed/);
  pages.dispose();
});

test('the runtime can arrive before the app\'s exposures: a settings binding\'s render starts the pages once they are there', () => {
  let tries = 0;
  let ready = false;
  const made = { dispose() {} };
  setSettingsPagesStarter(() => { tries++; return ready ? made : null; });
  assert.equal(settingsPages(), null, 'not yet');
  ready = true;
  assert.equal(settingsPages(), made);
  assert.equal(tries, 2);
  setSettingsPagesStarter(null);
  assert.equal(settingsPages(), null);
});

test('E6.1: the Mods pages run once the route tree is reached, the framework\'s instance read and their navigation group rendered', () => {
  const status = createPagesStatus({ schedule: () => {} });
  const { React, ReactDOM, pages } = setup({ status });
  assert.equal(status.get(), 'starting', 'the routes and the read are there; the navigation group has not rendered yet');
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(pages.ModsGroup));
  assert.equal(status.get(), 'running');
  root.unmount();
  pages.dispose();
  // With no mods the group is there with its entries.
  const s2 = createPagesStatus({ schedule: () => {} });
  const t2 = setup({ status: s2, mods: [] });
  const root2 = t2.ReactDOM.createRoot({});
  root2.render(t2.React.createElement(t2.pages.ModsGroup));
  assert.equal(rootText(root2), 'ModsMods0Developer');
  assert.equal(s2.get(), 'running');
  t2.pages.dispose();
});

test('E6.1: a fault in a mod page or in the navigation group is caught there, leaves the rest of Settings, and makes the pages failed', () => {
  const status = createPagesStatus({ schedule: () => {} });
  const { React, ReactDOM, routes, pages } = setup({ status, exposures: { SettingsCard: () => { throw new Error('a broken card'); } } });
  const group = ReactDOM.createRoot({});
  group.render(React.createElement(pages.ModsGroup));
  assert.equal(status.get(), 'running');
  const route = findSettingsRoute(routes).children.find((c) => c.path === 'codexmods/unit.a');
  const root = ReactDOM.createRoot({});
  root.render(React.createElement('div', null, 'the app\'s settings', route.element));
  assert.equal(rootText(root), 'the app\'s settings', 'the page is out; what is around it stays');
  assert.equal(status.get(), 'failed');
  assert.match(status.why(), /a broken card/);
  pages.dispose();

  const s2 = createPagesStatus({ schedule: () => {} });
  const t2 = setup({ status: s2, exposures: { NavItem: () => { throw new Error('a broken entry'); } } });
  const root2 = t2.ReactDOM.createRoot({});
  root2.render(t2.React.createElement('div', null, 'nav', t2.React.createElement(t2.pages.ModsGroup)));
  assert.equal(rootText(root2), 'nav');
  assert.equal(s2.get(), 'failed');
  t2.pages.dispose();
});

test('F2: the Mods entry says how many issues there are, in place of how many mods', () => {
  const { React, ReactDOM, pages } = setup({ quarantined: ['unit.b'] });
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(pages.ModsGroup));
  assert.equal(rootText(root), 'ModsMods1 issueDeveloper');
  pages.dispose();
  const two = setup({ quarantined: ['unit.a', 'unit.b'] });
  const r2 = two.ReactDOM.createRoot({});
  r2.render(two.React.createElement(two.pages.ModsGroup));
  assert.equal(rootText(r2), 'ModsMods2 issuesDeveloper');
  two.pages.dispose();
});

test('E8.9a, F2: a mod\'s own page in the Mods group is a tab of its page; in one of the app\'s groups, a route drawn in the app\'s frame with its entry there', () => {
  const { React, ReactDOM, routes, pages, ctx } = setup();
  const factory = (type, props) => React.createElement(type, props);
  const Page = ({ mod, page }) => React.createElement('p', null, `${mod} ${page} body`);
  pages.setOwnPages([
    { key: 'unit.a/notes', mod: 'unit.a', id: 'notes', title: 'Notes', group: 'mods', render: Page, rule: {} },
    { key: 'unit.b/sync', mod: 'unit.b', id: 'sync', title: 'Sync', group: 'integrations', render: Page, rule: {} },
    { key: 'gone.mod/x', mod: 'gone.mod', id: 'x', title: 'X', group: 'mods', render: Page, rule: {} },
    { key: 'codexmods.intelligence/overview', mod: 'codexmods.intelligence', id: 'overview', title: 'Mod intelligence', group: 'personal', render: Page, rule: {} },
  ]);
  const tree = findSettingsRoute(routes);
  const paths = () => tree.children.map((c) => c.path);
  assert.ok(paths().includes('codexmods/unit.a/~notes') && paths().includes('codexmods/unit.b/~sync'), 'a route per page of an installed mod');
  assert.ok(!paths().includes('codexmods/gone.mod/~x'), 'a page of a mod that is not installed: none');
  assert.ok(paths().includes('codexmods/codexmods.intelligence/~overview'), 'an internal mod\'s page while it is registered (it is never in the user\'s list)');
  assert.equal(paths().at(-1), '*', 'before the catch-all');
  // in the Mods group: a tab
  const tab = ReactDOM.createRoot({});
  tab.render(tree.children.find((c) => c.path === 'codexmods/unit.a/~notes').element);
  assert.match(rootText(tab), /NotesPermissions.*Activity.*unit\.a notes body/);
  const other = ReactDOM.createRoot({});
  other.render(tree.children.find((c) => c.path === 'codexmods/unit.a').element);
  assert.match(rootText(other), /Notes/, 'its tab is on its mod\'s page');
  // the app's group: the app's frame with its title, the mod's component
  const root = ReactDOM.createRoot({});
  root.render(tree.children.find((c) => c.path === 'codexmods/unit.b/~sync').element);
  assert.match(rootText(root), /Syncunit\.b sync body/);
  // the navigation has no row for either in the Mods group
  const nav = ReactDOM.createRoot({});
  nav.render(React.createElement(pages.ModsGroup));
  assert.equal(rootText(nav), 'ModsMods2Developer', 'the app\'s own group\'s page was shown last');
  // the app's Integrations group gets the Sync entry after its own; the others none
  const integrations = { title: React.createElement('FormattedMessage', { id: 'settings.nav.heading.integrations' }), children: ['own'] };
  assert.equal(groupOf(integrations), 'integrations');
  const out = settingsNavGroup.render('Group', integrations, factory, ctx);
  assert.deepEqual(out.props.children.slice(0, 1), ['own']);
  assert.equal(out.props.children[1].props.label, 'Sync');
  const selected = [];
  pages.setOnSelect((...a) => selected.push(a));
  out.props.children[1].props.onClick();
  assert.deepEqual(selected, [[ACTIVE_SECTION, undefined, pagePathOf('unit.b', 'sync')]]);
  assert.equal(pages.hasPage('unit.a', 'notes'), true);
  root.unmount();
  // a page comes and goes as its mod runs: its route stays while the mod is installed, and says so
  pages.setOwnPages([]);
  assert.equal(pages.hasPage('unit.a', 'notes'), false);
  assert.ok(paths().includes('codexmods/unit.b/~sync'), 'its route stays');
  const away = ReactDOM.createRoot({});
  away.render(tree.children.find((c) => c.path === 'codexmods/unit.b/~sync').element);
  assert.match(rootText(away), /SyncThis page isn’t availableThe mod it belongs to isn’t running\./);
  tab.render(tree.children.find((c) => c.path === 'codexmods/unit.a/~notes').element);
  assert.doesNotMatch(rootText(tab), /Notes/, 'its tab goes, and the page shows its first');
  pages.dispose();
});

test('E8 review 2: two pages of a mod whose ids differ only in case: the first keeps its route; go() uses the navigation only while it is shown', () => {
  const { React, ReactDOM, routes, pages } = setup();
  const Page = () => null;
  pages.setOwnPages([
    { key: 'unit.a/Notes', mod: 'unit.a', id: 'Notes', title: 'Notes', group: 'mods', render: Page, rule: {} },
    { key: 'unit.a/notes', mod: 'unit.a', id: 'notes', title: 'notes', group: 'mods', render: Page, rule: {} },
  ]);
  const paths = findSettingsRoute(routes).children.map((c) => c.path).filter((p) => String(p).startsWith('codexmods/unit.a/~'));
  assert.deepEqual(paths, ['codexmods/unit.a/~Notes']);
  const selected = [];
  pages.setOnSelect((...a) => selected.push(a));
  assert.equal(pages.go('/x'), false, 'the navigation is not shown: the caller navigates the app');
  const nav = ReactDOM.createRoot({});
  nav.render(React.createElement(pages.ModsGroup));
  assert.equal(pages.go('/x'), true);
  assert.deepEqual(selected.at(-1), [ACTIVE_SECTION, undefined, '/x']);
  nav.unmount();
  assert.equal(pages.go('/y'), false, 'Settings closed again');
  pages.dispose();
});
