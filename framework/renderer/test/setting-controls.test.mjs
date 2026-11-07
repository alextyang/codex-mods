// A setting's controls (docs/design/framework-ui.md F7; design-spec §3.1): each writes a value of its kind, what cannot be read goes back or says why, and a shortcut is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { createSettingControls, shortcutOf, shortcutShown, timeFrom, colorFrom, clampNumber, listAsRows } from '../present/setting-controls.mjs';
import { createKit } from '../present/kit/index.mjs';

function setup(s) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const exports = { Switch: ({ checked, onChange, disabled }) => e('switch', { checked, onChange, disabled }) };
  const kit = createKit({ react: () => React, parts: () => ({}) });
  const { control, stacked } = createSettingControls({ R: React, kit, exports: () => exports, useImage: () => null });
  const wrote = [], errors = [];
  const root = ReactDOM.createRoot({});
  const Page = () => control({ s, label: 'Sound level', disabled: false, write: (v) => wrote.push(v), onError: (m) => errors.push(m) });
  root.render(e(Page));
  const all = (pred) => root.trees().flatMap((t) => findAll(t, pred));
  const by = (label) => all((n) => n.props?.['aria-label'] === label)[0];
  return { root, all, by, wrote, errors, stacked, text: () => rootText(root) };
}
const type = (n, value) => n.props.onChange({ target: { value } });

test('what a control reads: a shortcut, a time, a color, a number within its bounds and step', () => {
  assert.equal(shortcutOf({ key: 'p', altKey: true, metaKey: true }), 'Alt+Cmd+P');
  assert.equal(shortcutOf({ key: 'F5' }), 'F5', 'a function key alone');
  assert.equal(shortcutOf({ key: 'p' }), null, 'a key alone is not a shortcut');
  assert.equal(shortcutOf({ key: 'Shift', shiftKey: true }), null, 'a modifier alone');
  assert.equal(shortcutOf({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Up');
  assert.equal(shortcutShown('Alt+Cmd+P'), '⌥⌘P');
  assert.equal(shortcutShown('Ctrl+Shift+Up'), '⌃⇧↑');
  assert.equal(shortcutShown(''), 'None');
  assert.equal(timeFrom('9:30'), '09:30');
  assert.equal(timeFrom('0930'), '09:30');
  assert.equal(timeFrom('24:00'), null);
  assert.equal(colorFrom('3a83f7'), '#3A83F7');
  assert.equal(colorFrom('#fff'), null);
  assert.equal(clampNumber(7, { min: 0, max: 5 }), 5);
  assert.equal(clampNumber(-1, { min: 0, max: 5 }), 0);
  assert.equal(clampNumber(7, { step: 5 }), 5);
  assert.equal(clampNumber(0.3, { step: 0.1 }), 0.3, 'no drift');
  assert.equal(listAsRows({ value: ['a'] }), true);
  assert.equal(listAsRows({ value: [] , structured: true }), false, 'its declaration says its items are more than text');
  assert.equal(listAsRows({ value: [1] }), false);
});

test('a stepper nudges within its bounds and on its step; typed, it keeps them; its buttons wait at the ends; it says its unit', () => {
  const t = setup({ kind: 'number', value: 5, min: 0, max: 10, step: 5, unit: 'min' });
  t.by('Increase sound level').props.onClick();
  t.by('Decrease sound level').props.onClick();
  assert.deepEqual(t.wrote, [10, 0]);
  assert.match(t.text(), /min/);
  const f = t.by('Sound level');
  type(f, '12');
  t.by('Sound level').props.onKeyDown({ key: 'Enter' });
  assert.deepEqual(t.wrote.at(-1), 10);
  assert.equal(setup({ kind: 'number', value: 10, max: 10 }).by('Increase sound level').props.disabled, true);
  assert.equal(setup({ kind: 'number', value: 0, min: 0 }).by('Decrease sound level').props.disabled, true);
});

test('a slider writes when it is let go, not per step of the drag', () => {
  const t = setup({ kind: 'number', control: 'slider', value: 60, min: 0, max: 100, step: 5, unit: '%' });
  assert.match(t.text(), /60%/);
  type(t.by('Sound level'), '70');
  assert.deepEqual(t.wrote, []);
  assert.match(t.text(), /70%/);
  t.by('Sound level').props.onPointerUp();
  assert.deepEqual(t.wrote, [70]);
});

test('a choice is a select, segments or thumbnails, each writing the value, not its id', () => {
  // a mod's (the framework's provider: each choice states its value) and a source's whose ids are its values (Codex's)
  const choices = [{ id: '1', label: 'One', value: 1 }, { id: '2', label: 'Two', value: 2 }];
  const seg = setup({ kind: 'choice', control: 'segmented', value: 1, choices });
  seg.all((n) => n.props?.className === 'cmk-segment')[1].props.onClick();
  assert.deepEqual(seg.wrote, [2]);
  const sel = setup({ kind: 'choice', value: 1, choices });
  assert.match(sel.text(), /One/);
  const codex = setup({ kind: 'choice', control: 'segmented', value: 'gpt-6-luna', choices: [{ id: 'gpt-6-sol', label: 'Sol' }, { id: 'gpt-6-luna', label: 'Luna' }] });
  assert.deepEqual(codex.all((n) => n.props?.className === 'cmk-segment').map((n) => n.props?.['aria-pressed']), [false, true], 'the current value is matched by value');
  codex.all((n) => n.props?.className === 'cmk-segment')[0].props.onClick();
  assert.deepEqual(codex.wrote, ['gpt-6-sol'], 'an id that is its value is written as it is');
});

test('a shortcut records: a press with a modifier writes it, Escape and a modifier alone do not', () => {
  const t = setup({ kind: 'shortcut', value: 'Alt+Cmd+P' });
  assert.match(t.text(), /⌥⌘P/);
  t.by('Change sound level').props.onClick();
  assert.match(t.text(), /Press keys/);
  const b = () => t.by('Cancel changing sound level');
  const press = (o) => b().props.onKeyDown({ preventDefault() {}, stopPropagation() {}, ...o });
  press({ key: 'Shift', shiftKey: true });
  press({ key: 'k' });
  assert.deepEqual(t.wrote, []);
  press({ key: 'k', metaKey: true });
  assert.deepEqual(t.wrote, ['Cmd+K']);
  t.by('Change sound level').props.onClick();
  b().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(t.wrote, ['Cmd+K']);
  assert.ok(t.by('Change sound level'), 'Escape stopped recording');
});

test('a color and a time normalize what is typed, and what cannot be read goes back', () => {
  const c = setup({ kind: 'color', value: '#3A83F7' });
  type(c.by('Sound level'), 'ff0000');
  c.by('Sound level').props.onBlur();
  assert.deepEqual(c.wrote, ['#FF0000']);
  type(c.by('Sound level'), 'nope');
  c.by('Sound level').props.onBlur();
  assert.equal(c.wrote.length, 1);
  assert.equal(c.by('Sound level').props.value, '#3A83F7');
  c.by('Sound level: pick').props.onChange({ target: { value: '#00ff00' } });
  assert.deepEqual(c.wrote.at(-1), '#00FF00');
  const t = setup({ kind: 'time', value: '09:00' });
  type(t.by('Sound level'), '930');
  t.by('Sound level').props.onBlur();
  assert.deepEqual(t.wrote, ['09:30']);
  type(t.by('Sound level'), '25:00');
  t.by('Sound level').props.onBlur();
  assert.equal(t.wrote.length, 1);
});

test('a time range writes both ends', () => {
  const t = setup({ kind: 'timerange', value: { from: '22:00', to: '07:00' } });
  type(t.by('Sound level end'), '8:00');
  t.by('Sound level end').props.onBlur();
  assert.deepEqual(t.wrote, [{ from: '22:00', to: '08:00' }]);
  type(t.by('Sound level start'), '21:30');
  t.by('Sound level start').props.onBlur();
  assert.deepEqual(t.wrote[1], { from: '21:30', to: '07:00' });
});

test('a list of strings: edit a row, remove one, add one, move one by its handle, dragged or with the arrow keys', () => {
  const t = setup({ kind: 'list', value: ['a', 'b', 'c'], placeholder: 'Add a label' });
  type(t.by('Sound level 2'), 'bee');
  t.by('Sound level 2').props.onBlur();
  assert.deepEqual(t.wrote.at(-1), ['a', 'bee', 'c']);
  t.by('Remove “a”').props.onClick();
  assert.deepEqual(t.wrote.at(-1), ['b', 'c']);
  const add = () => t.by('Add to Sound level');
  add().props.onChange({ target: { value: ' d ' } });
  add().props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(t.wrote.at(-1), ['a', 'b', 'c', 'd']);
  assert.equal(add().props.value, '');
  const pointer = (id) => ({ pointerId: id, currentTarget: null, clientY: 0 });
  const h = (i) => t.by(`Move “${['a', 'b', 'c'][i]}”`);
  h(2).props.onPointerDown(pointer(1));
  assert.ok(t.all((n) => n.props?.['data-dragging'] !== undefined).length, 'picked up');
  h(2).props.onPointerUp();
  assert.deepEqual(t.wrote.at(-1), ['a', 'b', 'c', 'd'], 'put back where it was: nothing written');
  h(2).props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
  assert.deepEqual(t.wrote.at(-1), ['a', 'c', 'b']);
  h(0).props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
  assert.deepEqual(t.wrote.at(-1), ['a', 'c', 'b'], 'the first stays first');
  h(0).props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual(t.wrote.at(-1), ['b', 'a', 'c']);
  // dragged: where the pointer is among the rows says where it lands
  const rows = [{ getBoundingClientRect: () => ({ bottom: 10 }) }, { getBoundingClientRect: () => ({ bottom: 20 }) }, { getBoundingClientRect: () => ({ bottom: 30 }) }];
  const over = (y) => ({ clientY: y, currentTarget: { closest: () => ({ querySelectorAll: () => rows }) } });
  h(0).props.onPointerDown(pointer(2));
  h(0).props.onPointerMove(over(25));
  assert.equal(t.all((n) => n.props?.['data-drop'] === 'after').length, 1, 'it shows where');
  h(0).props.onPointerUp();
  assert.deepEqual(t.wrote.at(-1), ['b', 'c', 'a']);
  h(2).props.onPointerDown(pointer(3));
  h(2).props.onPointerMove(over(5));
  h(2).props.onPointerCancel();
  assert.deepEqual(t.wrote.at(-1), ['b', 'c', 'a'], 'cancelled: nothing');
  assert.equal(t.all((n) => n.props?.['data-dragging'] !== undefined).length, 0);
});

test('a structured list and a record are JSON, which says when it cannot be read; they and an area go under their label', () => {
  const t = setup({ kind: 'record', value: { a: 1 } });
  assert.equal(t.stacked({ kind: 'record' }), true);
  assert.equal(t.stacked({ kind: 'list' }), true);
  assert.equal(t.stacked({ kind: 'text', control: 'area' }), true);
  assert.equal(t.stacked({ kind: 'choice', control: 'thumbnails' }), true);
  assert.equal(t.stacked({ kind: 'text' }), false);
  type(t.by('Sound level'), '{ broken');
  t.by('Sound level').props.onBlur();
  assert.deepEqual(t.wrote, []);
  assert.deepEqual(t.errors, ['Enter valid JSON']);
  type(t.by('Sound level'), '{"a":2}');
  t.by('Sound level').props.onBlur();
  assert.deepEqual(t.wrote, [{ a: 2 }]);
  assert.equal(t.errors.at(-1), null, 'read: nothing to say');
  const s = setup({ kind: 'list', value: [], structured: true });
  assert.equal(s.by('Sound level').props.className, 'cmk-area');
});

test('an area writes on blur, keeping its Enter for a new line; a toggle at once', () => {
  const t = setup({ kind: 'text', control: 'area', value: 'x' });
  type(t.by('Sound level'), 'x\ny');
  t.by('Sound level').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(t.wrote, []);
  t.by('Sound level').props.onBlur();
  assert.deepEqual(t.wrote, ['x\ny']);
  const s = setup({ kind: 'toggle', value: false });
  s.all((n) => n.type === 'switch')[0].props.onChange(true);
  assert.deepEqual(s.wrote, [true]);
});
