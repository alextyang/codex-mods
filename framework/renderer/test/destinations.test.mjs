// The mods' destinations (docs/design/layouts.md D7, WL5b, WL5c): the app's item shape after the app's own, selected by their own flag while
// their page is shown; a page's sidebar view; the rail's mode told again when a view comes while its page is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { createDestinations } from '../present/destinations.mjs';
import { destinationWhy, sidebarViewWhy } from '../../shared/ui-rules-client.mjs';
import { sidebar, sidebarArea } from '../present/bindings/frame.mjs';

const dest = (id, destination, mod = 'qa.mod') => ({ mod, id, kind: 'add', presentation: 'Window', slot: 'destinations', data: { destination }, fns: {} });
const view = (id, render = () => 'the view', mod = 'qa.mod') => ({ mod, id, kind: 'add', presentation: 'Sidebar', slot: 'views', data: { sidebarView: { title: 'V' } }, fns: { sidebarView: { title: 'V', render } } });

function setup({ destinations = [], views = [] } = {}) {
  const { React } = createFakeReact();
  const lists = { destinations, views };
  const invoked = [], navigated = [];
  let changes = 0;
  const ctx = {
    react: () => React, local: { read() {}, touch() {} }, modNode: (rule, type, props) => React.createElement(type, props),
    declared: (p, s) => (p === 'Window' && s === 'destinations' ? lists.destinations : p === 'Sidebar' && s === 'views' ? lists.views : []),
    invoke: (ref, op, args) => { invoked.push([ref, op, args]); return Promise.resolve({ status: 'done' }); },
  };
  const d = createDestinations({ ctx, windowRef: () => ({ type: 'Window', provider: 'codexmods.windows', id: '1' }), changed: () => { changes++; } });
  const at = (pathname) => ({ location: { pathname, search: '', state: { was: pathname } }, navigate: (p, opts) => navigated.push([p, opts]) });
  return { d, lists, invoked, navigated, at, changes: () => changes };
}

test('WL5b: a mod\'s items come after the app\'s own, in the app\'s shape, the list as it was with none', () => {
  const app = [{ id: 'builtin:home' }];
  const none = setup();
  assert.equal(none.d.compose(app, none.at('/')), app, 'the app\'s own list');
  const t = setup({ destinations: [dest('a', { title: 'A', icon: 'Q', open: { page: 'p' } })] });
  const out = t.d.compose(app, t.at('/'));
  assert.deepEqual(out.map((x) => x.id), ['builtin:home', 'codexmods:qa.mod/a']);
  const [, item] = out;
  assert.equal(item.label, 'A');
  assert.equal(item.visibleByDefault, true);
  assert.equal(item.hasUnreadActivity, false);
  assert.equal(item.isCurrentDestination, false);
  assert.equal(typeof item.icon, 'function');
  assert.equal(item.largeIcon, item.icon);
});

test('WL5b: an item is the current one only on its page; its icon keeps one type across renders, so nothing remounts', () => {
  const t = setup({ destinations: [dest('a', { title: 'A', open: { page: 'p' } })] });
  const first = t.d.compose([], t.at('/codexmods/page/qa.mod/p'))[0];
  assert.equal(first.isCurrentDestination, true);
  const second = t.d.compose([], t.at('/codexmods/page/qa.mod/other'))[0];
  assert.equal(second.isCurrentDestination, false);
  assert.equal(second.icon, first.icon);
});

test('WL5b: a destination opens its page with the app\'s navigate and the state the rail gives; a command and a ref through the graph', async () => {
  const thread = { type: 'Thread', provider: 'codex', id: 't1' };
  const t = setup({ destinations: [dest('a', { title: 'A', open: { page: 'p' } }), dest('b', { title: 'B', open: { command: 'c' } }), dest('c', { title: 'C', open: thread })] });
  const [a, b, c] = t.d.compose([], t.at('/'));
  a.onSelect({ from: 'rail' });
  assert.deepEqual(t.navigated, [['/codexmods/page/qa.mod/p', { state: { from: 'rail' } }]]);
  b.onSelect();
  c.onSelect();
  assert.deepEqual(t.invoked[0], [{ type: 'Command', provider: 'codexmods.commands', id: 'qa.mod/c' }, 'run', []]);
  assert.deepEqual(t.invoked[1], [{ type: 'Window', provider: 'codexmods.windows', id: '1' }, 'open', [thread]]);
});

test('WL5c: a page\'s view shows while the page its destination opens is shown, never for another mod\'s or another page', () => {
  const t = setup({ destinations: [dest('a', { title: 'A', open: { page: 'p' }, sidebar: 'v' }), dest('b', { title: 'B', open: { page: 'q' } })], views: [view('v')] });
  t.d.compose([], t.at('/codexmods/page/qa.mod/p'));
  assert.equal(t.d.railMode({ pathname: '/codexmods/page/qa.mod/p' }), true);
  const node = t.d.viewNode();
  assert.equal(node.props['data-codexmods-sidebar-view'], 'qa.mod/v');
  const [back, content] = node.props.children;
  assert.equal(back, null, 'no way back: the page brings it');
  assert.deepEqual(content.props.page, { mod: 'qa.mod', id: 'p' });
  assert.deepEqual(content.props.view, { id: 'v', title: 'V' });
  t.d.compose([], t.at('/codexmods/page/qa.mod/q'));
  assert.equal(t.d.railMode({ pathname: '/codexmods/page/qa.mod/q' }), false, 'that page has no view');
  assert.equal(t.d.viewNode(), null);
  t.d.compose([], t.at('/codexmods/page/other.mod/p'));
  assert.equal(t.d.railMode({ pathname: '/codexmods/page/other.mod/p' }), false);
  t.d.compose([], t.at('/local/1'));
  assert.equal(t.d.railMode({ pathname: '/local/1' }), false);
  assert.equal(t.d.viewNode(), null);
});

test('WL5c: a view that comes while its page is shown (a reload, before the mod started) tells the rail\'s mode by replacing the location; then nothing repeats', () => {
  const t = setup();
  t.d.compose([], t.at('/codexmods/page/qa.mod/p'));
  assert.equal(t.d.railMode({ pathname: '/codexmods/page/qa.mod/p' }), false);
  t.lists.destinations = [dest('a', { title: 'A', open: { page: 'p' }, sidebar: 'v' })];
  t.lists.views = [view('v')];
  const before = t.changes();
  t.d.rulesChanged();
  assert.equal(t.changes(), before + 1, 'the provider composes again');
  assert.deepEqual(t.navigated, [['/codexmods/page/qa.mod/p', { replace: true, state: { was: '/codexmods/page/qa.mod/p' } }]]);
  t.d.rulesChanged();
  assert.equal(t.navigated.length, 1, 'once');
  t.d.compose([], t.at('/local/1'));
  t.lists.views = [];
  t.d.rulesChanged();
  assert.equal(t.navigated.length, 1, 'never for another route');
});

test('WL5b review: whose a destination is comes from its rule, never from what it declares', () => {
  const t = setup({ destinations: [dest('a', { title: 'A', open: { page: 'p' }, mod: 'victim', key: 'victim/x', id: 'x' })] });
  const [item] = t.d.compose([], t.at('/'));
  assert.equal(item.id, 'codexmods:qa.mod/a');
  item.onSelect();
  assert.deepEqual(t.navigated[0][0], '/codexmods/page/qa.mod/p');
});

test('WL5b review: no route for a page (a build without the seam): its destination is not offered, its view not drawn, the rail\'s mode not asked for', () => {
  const { React } = createFakeReact();
  const ctx = { react: () => React, local: { read() {}, touch() {} }, modNode: () => null, declared: (p) => (p === 'Window' ? [dest('a', { title: 'A', open: { page: 'p' }, sidebar: 'v' }), dest('b', { title: 'B', open: { command: 'c' } })] : [view('v')]), invoke: () => Promise.resolve({}) };
  const d = createDestinations({ ctx, windowRef: () => null, changed() {}, routed: () => false });
  const at = { location: { pathname: '/codexmods/page/qa.mod/p' }, navigate() {} };
  assert.deepEqual(d.compose([], at).map((x) => x.id), ['codexmods:qa.mod/b'], 'a command still opens');
  assert.equal(d.railMode(at.location), false);
  assert.equal(d.viewNode(), null);
});

test('WL5b review: a mod\'s icon component draws in its rule\'s boundary; a ref opens only what its mod may read', () => {
  const { React } = createFakeReact();
  const drawn = [];
  const rule = { mod: 'qa.mod', id: 'a', kind: 'add', presentation: 'Window', slot: 'destinations', data: { destination: { title: 'A', open: { type: 'Thread', provider: 'codex', id: 't' } } }, fns: { destination: { iconNode: () => 'icon' } } };
  const invoked = [], logs = [];
  const ctx = { react: () => React, local: { read() {}, touch() {} }, modNode: (r, type, props) => { drawn.push(r); return React.createElement(type, props); }, declared: (p) => (p === 'Window' ? [rule] : []), invoke: (...a) => { invoked.push(a); return Promise.resolve({}); } };
  const d = createDestinations({ ctx, windowRef: () => ({ type: 'Window', provider: 'w', id: '1' }), changed() {}, log: (m, x) => logs.push(x), may: () => false });
  const [item] = d.compose([], { location: { pathname: '/' }, navigate() {} });
  item.icon({ className: 'c' });
  assert.deepEqual(drawn, [rule], 'through the boundary');
  item.onSelect();
  assert.deepEqual(invoked, []);
  assert.match(logs[0].message, /may not read/);
});

test('WL5b, WL5c: what a destination and a sidebar view declare', () => {
  assert.equal(destinationWhy({ title: 'A', open: { page: 'p' } }), null);
  assert.equal(destinationWhy({ title: 'A', open: { command: 'c' } }), null);
  assert.equal(destinationWhy({ title: 'A', open: { type: 'Thread', provider: 'codex', id: 't' } }), null);
  assert.equal(destinationWhy({ title: 'A', icon: '🧪', open: { page: 'p' }, sidebar: 'v' }), null);
  assert.match(destinationWhy({ open: { page: 'p' } }), /title/);
  assert.match(destinationWhy({ title: 'x'.repeat(41), open: { page: 'p' } }), /40/);
  assert.match(destinationWhy({ title: 'A' }), /opens/);
  assert.match(destinationWhy({ title: 'A', open: { page: 'x/y', command: 'c' } }), /exactly one/, 'never both');
  assert.match(destinationWhy({ title: 'A', open: { type: 'Thread', provider: 'codex', id: 't', page: 'p' } }), /exactly one/, 'a ref carrying a page');
  assert.match(destinationWhy({ title: 'A', open: { page: 'p' }, mod: 'victim' }), /no mod/, 'nothing it could claim another mod\'s with');
  assert.match(destinationWhy({ title: 'A', open: { page: 'a/b' } }), /opens/);
  assert.match(destinationWhy({ title: 'A', open: { command: 'c' }, sidebar: 'v' }), /goes with a page/);
  assert.match(destinationWhy({ title: 'A', icon: 'too long for an icon', open: { page: 'p' } }), /icon/);
  assert.equal(sidebarViewWhy({ title: 'V' }), null);
  assert.match(sidebarViewWhy({}), /title/);
});

test('WL5c: the bindings draw the view: as the area ladder\'s children where the rail shows, in the conversations\' place otherwise; on any other route the app\'s own', () => {
  const { React } = createFakeReact();
  const factory = (type, props) => ({ type, props });
  let view = 'the view';
  let ladder = [];
  const ctx = { react: () => React, local: { read() {}, touch() {} }, declared: () => [], pageSidebar: () => view, mountsOf: (id) => (id === 'sidebar.area' ? ladder : []) };
  const body = sidebar.render('List', { sidebarSectionNodes: ['pinned', 'chats'], topContent: 'links' }, factory, ctx).props;
  assert.equal(body.sidebarSectionNodes.length, 1);
  assert.equal(body.sidebarSectionNodes[0].props.children, 'the view');
  assert.equal(body.topContent, 'links', 'the app\'s header links stay');
  assert.equal(sidebarArea.render('Ladder', { area: null, children: 'the conversations' }, factory, ctx).props.children, 'the view');
  assert.equal(sidebarArea.render('Ladder', { area: null, isPreview: true, children: 'the conversations' }, factory, ctx), undefined, 'hovering another destination: the app\'s preview');
  ladder = [{}];
  assert.equal(sidebar.render('List', { sidebarSectionNodes: ['pinned'] }, factory, ctx), undefined, 'where the ladder is, the conversations under a preview stay');
  ladder = [];
  assert.equal(sidebar.render('List', { sidebarSectionNodes: ['pinned'] }, factory, ctx).props.sidebarSectionNodes.length, 1, 'the ladder gone (the rail turned off): the view is drawn here again');
  view = null;
  assert.equal(sidebarArea.render('Ladder', { area: null, children: 'the conversations' }, factory, ctx), undefined);
  assert.equal(sidebar.render('List', { sidebarSectionNodes: ['pinned', 'chats'] }, factory, ctx), undefined);
});

test('WL6: a sidebar view by its where is the body while the declaration holds, with the user\'s way back; never asks for the rail\'s column on a route the app gives it', () => {
  const t = setup({ views: [{ ...view('v'), where: { window: { mode: 'split' } } }] });
  t.d.compose([], t.at('/local/1'));
  assert.equal(t.d.railMode({ pathname: '/local/1' }), false);
  const node = t.d.viewNode();
  assert.equal(node.props['data-codexmods-sidebar-view'], 'qa.mod/v');
  const [back, content] = node.props.children;
  assert.equal(back.props['data-codexmods-sidebar-back'], 'qa.mod/v');
  assert.equal(content.props.page, null);
  back.props.onClick();
  assert.equal(t.d.viewNode(), null, 'the user went back to the conversations');
  t.lists.views = [];
  assert.equal(t.d.viewNode(), null);
  t.lists.views = [{ ...view('v'), where: { window: { mode: 'split' } } }];
  assert.ok(t.d.viewNode(), 'it holds again: shown again');
});
