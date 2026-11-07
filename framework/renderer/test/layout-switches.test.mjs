// A switch per layout, region and page, and the default layout (docs/design/layouts.md D9): kept in the page's storage, followed by every window of the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutSwitches } from '../present/layout-switches.mjs';
import { createLayoutsSection } from '../present/layouts-section.mjs';
import { createFakeReact, rootText, findAll, textOf } from './fake-react.mjs';

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

test('WL6: a switch and the default are kept, said to who follows, and read again when another window moves them', () => {
  const saved = { ls: globalThis.localStorage, add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  const listeners = new Map();
  Object.defineProperty(globalThis, 'localStorage', { value: storage(), configurable: true, writable: true });
  globalThis.addEventListener = (n, f) => { if (!listeners.has(n)) listeners.set(n, f); };
  globalThis.removeEventListener = (n) => listeners.delete(n);
  try {
    let told = 0;
    const s = createLayoutSwitches({ changed: () => { told++; } });
    assert.equal(s.isOff('layout', 'a/b'), false);
    s.set('layout', 'a/b', true);
    assert.equal(s.isOff('layout', 'a/b'), true);
    assert.equal(s.isOff('page', 'a/b'), false, 'each kind its own');
    assert.equal(told, 1);
    assert.equal(createLayoutSwitches().isOff('layout', 'a/b'), true, 'kept');
    s.setDefault('a/b');
    assert.equal(s.defaultLayout(), 'a/b');
    s.setDefault(null);
    assert.equal(s.defaultLayout(), null);
    // another window
    globalThis.localStorage.setItem('codexmods:layouts-off', JSON.stringify(['region:c/d']));
    listeners.get('storage')({ key: 'codexmods:layouts-off' });
    assert.deepEqual([s.isOff('region', 'c/d'), s.isOff('layout', 'a/b')], [true, false]);
    assert.equal(told, 4);
    s.dispose();
    assert.equal(listeners.has('storage'), false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: saved.ls, configurable: true, writable: true });
    globalThis.addEventListener = saved.add; globalThis.removeEventListener = saved.remove;
  }
});

test('WL6: the Layouts section lists each with its switch, says whose it is, and offers a layout as the one new windows start with; nothing declared, no section', () => {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const Section = Object.assign(({ children }) => e('section', null, children), { Header: ({ title }) => e('h2', null, title), Content: ({ children }) => e('div', null, children) });
  const ex = { SettingsSection: Section, SettingsCard: ({ children }) => e('div', null, children), SettingsRow: ({ label, description, control }) => e('div', { 'data-row': label }, label, ' ', description, control) };
  const off = new Set(); let def = null;
  const switches = { isOff: (k, key) => off.has(`${k}:${key}`), set: (k, key, v) => { if (v) off.add(`${k}:${key}`); else off.delete(`${k}:${key}`); }, defaultLayout: () => def, setDefault: (k) => { def = k; } };
  const ctx = { react: () => React, use: (f) => f(), local: { read() {} } };
  let items = [];
  const Sec = createLayoutsSection({ ctx, exports: () => ex, switches, modName: (m) => `the ${m}`, stateKey: 'k', items: () => items });
  const empty = ReactDOM.createRoot({}); empty.render(e(Sec));
  assert.equal(rootText(empty), '');
  items = [{ kind: 'layout', key: 'm/l', title: 'Focus', mod: 'm' }, { kind: 'region', key: 'm/r', title: 'Notes', mod: 'm' }, { kind: 'page', key: 'm/p', title: 'Board', mod: 'm' }];
  const root = ReactDOM.createRoot({}); root.render(e(Sec));
  const text = rootText(root);
  for (const said of ['Layouts', 'Focus', 'Layout of the m', 'Notes', 'Region of the m', 'Board', 'Page of the m', 'Start new windows with it']) assert.ok(text.includes(said), said);
  const buttons = findAll(root.tree, (n) => n.type === 'button');
  const start = buttons.find((b) => textOf(b) === 'Start new windows with it');
  start.props.onClick();
  assert.equal(def, 'm/l');
  const toggleOff = buttons.find((b) => textOf(b) === 'Turn off');
  toggleOff.props.onClick();
  assert.equal(off.has('layout:m/l'), true);
});
