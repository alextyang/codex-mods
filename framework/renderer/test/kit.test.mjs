// The kit (docs/design/framework-ui.md F3): stable props on every build, drawn through the app's pieces where it has them. Its stylesheet uses the theme's variables and nothing else for colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createKit, KIT_NAMES } from '../present/kit/index.mjs';
import { KIT_CSS, KIT_STYLE_ID } from '../present/kit/styles.mjs';
import { GLYPH_NAMES, DEFAULT_GLYPH } from '../present/kit/glyphs.mjs';

function setup(parts = {}) {
  const { React, ReactDOM } = createFakeReact();
  const added = [];
  const document = { getElementById: (id) => added.find((x) => x.id === id) ?? null, createElement: () => ({ setAttribute() {} }), head: { appendChild: (el) => added.push(el) } };
  const kit = createKit({ react: () => React, parts: () => parts, document: () => document });
  const draw = (type, props) => { const root = ReactDOM.createRoot({}); root.render(React.createElement(type, props)); return root; };
  return { React, kit, draw, added };
}
const by = (root, role) => findAll(root.tree, (n) => n.props?.role === role);

test('FU0: every name in the public list is there, and the stylesheet goes in once', () => {
  const t = setup();
  for (const name of KIT_NAMES) assert.equal(typeof t.kit[name], 'function', name);
  t.draw(t.kit.Badge, { label: 'a' });
  t.draw(t.kit.Badge, { label: 'b' });
  assert.equal(t.added.length, 1);
  assert.equal(t.added[0].id, KIT_STYLE_ID);
});

test('FU0: the stylesheet takes no colour or font of its own: the theme owns them', () => {
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(KIT_CSS), false, 'no hex');
  assert.equal(/\brgba?\(|\bhsla?\(/.test(KIT_CSS), false, 'no colour function');
  assert.equal(/font-family:(?!var\()/.test(KIT_CSS), false, 'no font');
  assert.equal(/font-size:(?!var\()/.test(KIT_CSS), false, 'font sizes are the theme\'s');
  for (const decl of KIT_CSS.match(/(?:^|[;{])(?:color|background|border-color):[^;}]+/g) ?? []) assert.match(decl, /var\(--|transparent|inherit/, decl);
});

test('FU0: a glyph is a name: an unknown one draws the default, and the mock\'s swapped names are gone', () => {
  const t = setup();
  const svg = (name) => findAll(t.draw(t.kit.Glyph, { name }).tree, (n) => n.type === 'svg')[0];
  assert.equal(svg('download').props['data-glyph'], 'download');
  assert.equal(svg('no-such-glyph').props['data-glyph'], DEFAULT_GLYPH);
  assert.ok(GLYPH_NAMES.includes('gear'));
  assert.equal(GLYPH_NAMES.includes('settings'), false);
  assert.equal(GLYPH_NAMES.includes('sliders'), false);
});

test('FU0: a badge and a tile say their tone, a spinning badge has a spinner', () => {
  const t = setup();
  assert.equal(findAll(t.draw(t.kit.Badge, { label: 'Stopped', tone: 'danger' }).tree, (n) => n.props?.className === 'cmk-badge')[0].props['data-tone'], 'danger');
  assert.equal(findAll(t.draw(t.kit.Badge, { label: 'Reloading', spinning: true }).tree, (n) => n.props?.['data-glyph'] === 'spinner').length, 1);
  assert.equal(findAll(t.draw(t.kit.IconTile, { glyph: 'plugin', size: 'sm', tone: 'warning' }).tree, (n) => n.props?.className === 'cmk-tile')[0].props['data-tone'], 'warning');
});

test('FU0: a banner: its role follows its tone, the first action is the main one, through the app\'s button where it has one', () => {
  const seen = [];
  const t = setup({ Button: (p) => { seen.push(p.color); return null; } });
  const root = t.draw(t.kit.Banner, { tone: 'danger', title: 'Stopped after an error', message: 'why', actions: [{ label: 'Reload' }, { label: 'View activity' }] });
  assert.equal(by(root, 'alert').length, 1);
  assert.match(rootText(root), /Stopped after an error/);
  assert.deepEqual(seen, ['primary', 'secondary']);
  assert.equal(by(setup().draw(setup().kit.Banner, { tone: 'info', title: 'x' }), 'status').length, 1);
});

test('FU0: a search field: Escape clears what is typed and only then lets the key go; the clear button is named', () => {
  const t = setup();
  const got = [];
  let stopped = 0;
  const root = t.draw(t.kit.SearchField, { value: 'abc', onChange: (v) => got.push(v), placeholder: 'Search mods' });
  const input = findAll(root.tree, (n) => n.type === 'input')[0];
  input.props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped++; } });
  assert.deepEqual([got, stopped], [[''], 1]);
  assert.equal(findAll(root.tree, (n) => n.props?.['aria-label'] === 'Clear search mods').length, 1);
  const empty = t.draw(t.kit.SearchField, { value: '', onChange: (v) => got.push(v) });
  findAll(empty.tree, (n) => n.type === 'input')[0].props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped++; } });
  assert.deepEqual([got.length, stopped], [1, 1], 'nothing to clear: Escape is the page\'s');
});

test('FU0: tabs: selected is the only tab stop, arrows move and wrap, a count and a dot show', () => {
  const t = setup();
  const got = [];
  const items = [{ value: 'a', label: 'Settings', icon: 'gear' }, { value: 'b', label: 'Permissions', count: 1 }, { value: 'c', label: 'Activity', dot: true }];
  const root = t.draw(t.kit.Tabs, { items, value: 'a', onChange: (v) => got.push(v), ariaLabel: 'Sections' });
  const tabs = by(root, 'tab');
  assert.deepEqual(tabs.map((x) => x.props.tabIndex), [0, -1, -1]);
  assert.deepEqual(tabs.map((x) => x.props['aria-selected']), [true, false, false]);
  tabs[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  tabs[0].props.onKeyDown({ key: 'Home', preventDefault() {} });
  assert.deepEqual(got, ['c', 'b'], 'wraps; other keys pass');
  assert.equal(findAll(root.tree, (n) => n.props?.className === 'cmk-tab-count').length, 1);
  assert.equal(findAll(root.tree, (n) => n.props?.['aria-label'] === 'Needs attention').length, 1);
});

test('FU0: a segmented control and a checkbox say their state and answer with the new value', () => {
  const t = setup();
  const got = [];
  const seg = t.draw(t.kit.SegmentedControl, { options: ['GitHub', { value: 'folder', label: 'Folder' }], value: 'GitHub', onChange: (v) => got.push(v), ariaLabel: 'Install from' });
  const buttons = findAll(seg.tree, (n) => n.type === 'button');
  assert.deepEqual(buttons.map((b) => b.props['aria-pressed']), [true, false]);
  buttons[1].props.onClick();
  const box = t.draw(t.kit.Checkbox, { checked: false, onChange: (v) => got.push(v), ariaLabel: 'Allow now' });
  by(box, 'checkbox')[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(got, ['folder', true]);
});

test('FU0: a select and a menu button with no app menu of their own open a plain list; a choice closes it and answers once', () => {
  const t = setup();
  const got = [];
  const root = t.draw(t.kit.Select, { value: 'allow', options: [{ value: 'allow', label: 'Allow' }, { value: 'deny', label: "Don't allow" }], onChange: (v) => got.push(v), ariaLabel: 'Send notifications' });
  assert.match(rootText(root), /Allow/);
  findAll(root.tree, (n) => n.props?.['aria-label'] === 'Send notifications')[0].props.onClick({ stopPropagation() {} });
  const items = by(root, 'menuitem');
  assert.equal(items.length, 2);
  items[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(got, [], 'the current one changes nothing');
  findAll(root.tree, (n) => n.props?.['aria-label'] === 'Send notifications')[0].props.onClick({ stopPropagation() {} });
  by(root, 'menuitem')[1].props.onClick({ stopPropagation() {} });
  assert.deepEqual(got, ['deny']);
  assert.equal(by(root, 'menuitem').length, 0, 'closed');
});

test('FU0: a menu button draws through the app\'s menu where it has one: its items, a separator, and danger marked', () => {
  const calls = [];
  let shown = null;
  const { React, ReactDOM } = createFakeReact();
  const Menu = (p) => { shown = p; return React.createElement('div', null, p.children); };
  const MenuItem = (p) => React.createElement('button', { 'data-item': true, disabled: p.disabled, onClick: p.onClick }, p.children);
  const Separator = () => React.createElement('hr');
  const kit = createKit({ react: () => React, parts: () => ({ Menu, MenuItem, Separator }), document: () => null });
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(kit.MenuButton, { ariaLabel: 'Focus timer actions', items: [{ label: 'Reload', icon: 'refresh', onSelect: () => calls.push('reload') }, { separator: true }, { label: 'Uninstall…', danger: true, disabled: true }] }));
  assert.equal(shown.triggerButton.props['aria-label'], 'Focus timer actions');
  assert.equal(findAll(root.tree, (n) => n.type === 'hr').length, 1);
  const items = findAll(root.tree, (n) => n.props?.['data-item']);
  assert.deepEqual(items.map((x) => x.props.disabled), [false, true]);
  assert.equal(findAll(root.tree, (n) => n.props?.['data-danger'] !== undefined).length, 1);
  items[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(calls, ['reload']);
});
