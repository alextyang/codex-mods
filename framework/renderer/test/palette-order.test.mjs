// Palette group order and rank (docs/design/public-hooks.md §3.10): the palette's own list and groups (cmdk's List and Group, by identity)
// draw the app's command groups and a group's command rows in the mods' order (`ui.reorder('Palette', {slot: 'groups' | 'commands'})`),
// among their own places, without changing the app's lists; anything else they draw passes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteList, paletteGroup } from '../present/bindings/frame.mjs';

const el = (key, props = {}) => ({ $$typeof: Symbol.for('react.element'), type: 'x', key, props });
const factory = (type, props) => ({ type, props });
const ctxWith = (rules, search = '') => ({
  subject: () => ({ ref: { type: 'App', provider: 'codex', id: 'codex' }, state: {} }),
  ruled: (presentation) => (presentation === 'Palette' && rules.length ? { parts: rules } : null),
  paletteSources: () => ({ useSearch: () => search }),
});
// what the binding draws: its own component's element, rendered as the page would (its hook read from the context)
const drawn = (out) => (out && typeof out.type === 'function' ? out.type(out.props) : out);
const reorder = (id, slot, order) => ({ mod: 'unit.m', id, kind: 'reorder', presentation: 'Palette', slot, data: { order } });

test('the list: the app\'s groups (keyed group-<name>) change places among themselves; its other sections stay where they are', () => {
  const groups = ['thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app'].map((g) => el(`group-${g}`));
  const before = [el('recent'), el('group-suggested'), el('settings'), ...groups, el('codexmods:unit.m/notes')];
  const children = [before, el('ve'), null];
  const out = drawn(paletteList.render('List', { children }, factory, ctxWith([reorder('g', 'groups', ['configure', 'app'])])));
  const keys = out.props.children[0].map((x) => x.key);
  assert.deepEqual(keys, ['recent', 'group-suggested', 'settings', 'group-configure', 'group-app', 'group-thread', 'group-navigation', 'group-panels', 'group-workspace', 'group-skills', 'codexmods:unit.m/notes'], 'Quick actions keeps its place (QA: it was moved)');
  assert.equal(out.props.children[1], children[1]);
  assert.deepEqual(before.map((x) => x.key).slice(3, 5), ['group-thread', 'group-navigation'], 'the app\'s own array is not changed');
  // no rule, or nothing to move: the app's own element
  assert.equal(paletteList.render('List', { children }, factory, ctxWith([])), undefined);
  assert.equal(paletteList.render('List', { children }, factory, ctxWith([reorder('g', 'groups', ['thread'])])), undefined, 'already first');
  assert.equal(paletteList.render('List', { children: [el('a'), el('b')] }, factory, ctxWith([reorder('g', 'groups', ['app'])])), undefined, 'another cmdk list');
  assert.equal(drawn(paletteList.render('List', { children }, factory, ctxWith([reorder('g', 'groups', ['configure'])], 'tog'))).props.children, children, 'text typed: the palette ranks by match (review round 2)');
});

test('a group: its command rows (each names its command) in the rules\' order, the named first among the rows\' places; the mods\' joined rows stay first', () => {
  const row = (id) => el(id, { command: { id } });
  const mods = [el('codexmods:unit.m/qa')];
  const rows = ['reopenClosedTab', 'toggleSidebar', 'toggleBottomPanel', 'stepWorkspaceLayout'].map(row);
  const out = drawn(paletteGroup.render('Group', { heading: 'Panels', children: [mods, rows] }, factory, ctxWith([reorder('c', 'commands', ['stepWorkspaceLayout', 'toggleBottomPanel'])])));
  assert.equal(out.props.children[0], mods);
  assert.deepEqual(out.props.children[1].map((x) => x.key), ['stepWorkspaceLayout', 'toggleBottomPanel', 'reopenClosedTab', 'toggleSidebar']);
  assert.equal(out.props.heading, 'Panels');
  // two rules: each in turn puts its names first, so the last in order has the first places
  const two = drawn(paletteGroup.render('Group', { children: [mods, rows] }, factory, ctxWith([reorder('a', 'commands', ['toggleSidebar']), reorder('b', 'commands', ['toggleBottomPanel'])])));
  assert.deepEqual(two.props.children[1].map((x) => x.key), ['toggleBottomPanel', 'toggleSidebar', 'reopenClosedTab', 'stepWorkspaceLayout']);
  // a group rule leaves the rows alone; rows of another group the rule does not name: the app's own
  assert.equal(paletteGroup.render('Group', { children: [mods, rows] }, factory, ctxWith([reorder('g', 'groups', ['app'])])), undefined);
  assert.equal(paletteGroup.render('Group', { children: [mods, rows] }, factory, ctxWith([reorder('c', 'commands', ['newTask'])])), undefined);
  assert.deepEqual(drawn(paletteGroup.render('Group', { children: [mods, rows] }, factory, ctxWith([reorder('c', 'commands', ['stepWorkspaceLayout'])], ' t '))).props.children, [mods, rows], 'text typed');
});
