import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createComponents, COMPONENT_NAMES } from '../components.mjs';
import { KIT_NAMES } from '../present/kit/index.mjs';
import { LENT_NAMES } from '../present/lent/index.mjs';
import { createFallbacks } from '../fallbacks.mjs';

const adapter = { components: { Button: 'Button', Menu: 'Menu', Dialog: 'Dialog', Switch: 'Switch' } };
const THEME = { text: '--color-text', accent: '--color-ring', border: '--color-border', onAccent: '--color-control-thumb-on-accent' };

function render(React, ReactDOM, el) {
  const root = ReactDOM.createRoot({});
  root.render(el);
  return root;
}

test('fallbacks: every name the app can have exists and renders themed output using the adapter custom properties', () => {
  const { React, ReactDOM } = createFakeReact();
  const f = createFallbacks(React, THEME);
  // the kit and the lent parts (graph-integrity G2.3) are the framework's own: no app fallback for them
  assert.deepEqual(Object.keys(f).sort(), COMPONENT_NAMES.filter((n) => !KIT_NAMES.includes(n) && !LENT_NAMES.includes(n)).sort());
  const root = render(React, ReactDOM, React.createElement(f.Button, { onClick() {} }, 'Go'));
  const btn = findAll(root.tree, (n) => n.type === 'button')[0];
  assert.equal(btn.props.style.background, 'var(--color-ring)');
  assert.equal(btn.props.style.color, 'var(--color-control-thumb-on-accent)', 'text on the accent is the theme\'s, never a literal (V9)');
  assert.ok(Object.values(btn.props.style).every((x) => typeof x !== 'string' || !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(x)), 'no literal colors');
  assert.equal(rootText(root), 'Go');
});

test('fallbacks: Switch toggles through onChange; Dialog renders only when open', () => {
  const { React, ReactDOM } = createFakeReact();
  const f = createFallbacks(React, THEME);
  let got;
  const sw = render(React, ReactDOM, React.createElement(f.Switch, { checked: false, onChange: (v) => { got = v; }, ariaLabel: 'x' }));
  findAll(sw.tree, (n) => n.props.role === 'switch')[0].props.onClick({});
  assert.equal(got, true);
  const closed = render(React, ReactDOM, React.createElement(f.Dialog, { open: false }, 'secret'));
  assert.equal(rootText(closed), '');
  const open = render(React, ReactDOM, React.createElement(f.Dialog, { open: true }, React.createElement(f.Dialog.Header, { title: 'T' }), 'body'));
  assert.equal(rootText(open), 'Tbody');
});

test('fallbacks: compound parts exist as static members (Menu.Item, SettingsSection.Header, Dialog.Footer)', () => {
  const { React } = createFakeReact();
  const f = createFallbacks(React, THEME);
  for (const k of ['Item', 'Separator']) assert.equal(typeof f.Menu[k], 'function');
  for (const k of ['Header', 'Content', 'Footer']) assert.equal(typeof f.SettingsSection[k], 'function');
  for (const k of ['Header', 'Body', 'Footer']) assert.equal(typeof f.Dialog[k], 'function');
});

test('fallback Menu opens on trigger click and closes after an item is selected', () => {
  const { React, ReactDOM } = createFakeReact();
  const f = createFallbacks(React, THEME);
  let selected = 0;
  const root = render(React, ReactDOM, React.createElement(f.Menu, { triggerButton: React.createElement('button', null, 'More') }, React.createElement(f.Menu.Item, { onSelect: () => selected++ }, 'Do it')));
  assert.equal(rootText(root), 'More');
  findAll(root.tree, (n) => n.type === 'span' && n.props.onClick)[0].props.onClick();
  assert.match(rootText(root), /Do it/);
  const item = findAll(root.tree, (n) => n.props.role === 'menuitem')[0];
  item.props.onClick(); findAll(root.tree, (n) => n.props.role === 'menu')[0]?.props.onClick();
  assert.equal(selected, 1);
});

test('components: real exports win over fallbacks and are looked up live (late chunk load)', () => {
  const { React } = createFakeReact();
  const exportsObj = {};
  const c = createComponents({ getExport: (k) => exportsObj[k], adapter, react: () => React, themeMap: THEME });
  const before = c.components.Button;
  assert.equal(before.name, 'Button');                       // fallback
  assert.equal(c.isReal('Button'), false);
  const RealButton = function RealButton() {};
  exportsObj.Button = RealButton;
  assert.equal(c.components.Button, RealButton);
  assert.equal(c.isReal('Button'), true);
});

test('components: a name the pack does not map is looked up by its own name (the exposure blocks\' key, V10); one nothing defines is the fallback, and the kit is the framework\'s own', () => {
  const { React } = createFakeReact();
  const AppSwitch = () => null;
  const c = createComponents({ getExport: (k) => (k === 'Switch' ? AppSwitch : undefined), adapter: { components: {} }, react: () => React, themeMap: THEME });
  assert.equal(c.isReal('Switch'), true);
  assert.equal(c.components.Switch, AppSwitch);
  assert.equal(c.isReal('Select'), true, 'the kit does not depend on the app having it');
  assert.equal(typeof c.components.Select, 'function');
  assert.deepEqual(Object.keys(c.components).sort(), [...COMPONENT_NAMES].sort());
});

test('components: a getter that throws (failed lazy init) counts as absent', () => {
  const { React } = createFakeReact();
  const c = createComponents({ getExport: () => { throw new Error('init failed'); }, adapter, react: () => React, themeMap: THEME });
  assert.equal(c.isReal('Button'), false);
  assert.equal(typeof c.components.Button, 'function');
});

test('components: MenuParts / DialogParts attach as static members of a wrapper, leaving the app function untouched', () => {
  const { React } = createFakeReact();
  const Item = () => null; const Footer = () => null;
  const AppMenu = function p7() { return null; }; const AppDialog = function qMi() { return null; };
  const ex = { Menu: AppMenu, MenuParts: { Item }, Dialog: AppDialog, DialogParts: { Footer } };
  const c = createComponents({ getExport: (k) => ex[k], adapter, react: () => React, themeMap: THEME });
  const Menu = c.components.Menu;
  assert.equal(Menu.Item, Item);
  assert.equal(c.components.Dialog.Footer, Footer);
  assert.equal(AppMenu.Item, undefined);
  assert.equal(c.components.Menu, Menu, 'stable identity while the inputs are unchanged');
});

test('components: without React the fallbacks are unavailable but nothing throws', () => {
  const c = createComponents({ getExport: () => undefined, adapter, react: () => undefined });
  assert.equal(c.components.Button, undefined);
  assert.equal(c.fallbacks(), null);
});
