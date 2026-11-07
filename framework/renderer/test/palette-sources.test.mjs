// The mods' palette sources (docs/design/mod-surfaces.md §3.2): sections of the app's own, rows drawn by the app's row component; static
// rows filtered by the palette, searched rows the app's async results (an older answer never replaces a newer); choosing runs the row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaletteSources, sourceOf, rowOf } from '../present/palette-sources.mjs';
import { createFakeReact, findAll } from './fake-react.mjs';

function setup() {
  const { React, ReactDOM } = createFakeReact();
  let typed = '';
  const timers = [];
  const Row = (p) => React.createElement('row', { value: p.value, title: p.title, onSelect: p.onSelect, keywords: p.keywords });
  const Group = (p) => React.createElement('group', { value: p.value }, p.heading, p.children);
  const exportsTable = {
    commandMenu: { Group }, commandMenuItem: Row, commandMenuState: (sel) => sel({ search: typed }),
    commandMenuAsyncValue: (v) => `command-menu-async-result:${v}`, commandMenuSections: { atom: 'sections' },
  };
  const ran = [];
  const ps = createPaletteSources({ react: () => React, exports: () => exportsTable, guard: (r, fn) => fn, env: (row) => ({ subject: row?.ref ?? null, via: 'palette' }),
    open: (ref) => ran.push(['open', ref.id]), runCommand: (id) => ran.push(['command', id]), schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {} });
  // the app's sections, as the AppScope atom holds them
  let sections = [{ id: 'theme', order: 0 }];
  const scopeNode = { set: (atom, fn) => { assert.equal(atom, exportsTable.commandMenuSections); sections = fn(sections); } };
  return { React, ReactDOM, ps, scopeNode, timers, ran, type: (t) => { typed = t; }, get sections() { return sections; } };
}
const rule = (id, source, items, extra = {}) => ({ mod: 'unit.m', id, kind: 'add', presentation: 'Palette', slot: 'resultSources', realm: 'renderer', data: {}, fns: { source, ...(items ? { items } : {}) }, ...extra });

test('E8.5: a source is checked from its rule: its group or title, its rows, its limits', () => {
  assert.equal(sourceOf(rule('x', { title: 'Notes' })).title, 'Notes');
  assert.equal(sourceOf(rule('x', { group: 'workspace' })).group, 'workspace');
  assert.equal(sourceOf(rule('x', {})), null, 'neither a title nor an app group');
  assert.equal(rowOf({ id: 'a' }), null);
  assert.deepEqual(rowOf({ id: 'a', title: ' A ', keywords: ['k', 3], extra: 1 }), { id: 'a', title: 'A', keywords: ['k'] });
});

test('E8.5: the registrar writes one section per source beside the app\'s (above ones first), removes them when the palette closes; rows are the app\'s', async () => {
  const s = setup();
  const runs = [];
  s.ps.setSources([
    rule('notes', { title: 'Notes', position: 'above', search: async (q) => [{ id: 'n1', title: `Note about ${q}`, choose: { open: { type: 'Thread', provider: 'codex', id: 't1' } } }] }),
    rule('tools', { group: 'workspace' }, [{ id: 'clean', title: 'Clean up', keywords: ['tidy'], run: (env) => runs.push(env) }]),
  ]);
  const root = s.ReactDOM.createRoot({});
  let closed = 0;
  root.render(s.React.createElement(s.ps.Registrar, { scopeNode: s.scopeNode, close: () => { closed++; } }));
  // sorted as the app sorts its sections: by order, then by id
  assert.deepEqual(s.sections.map((x) => [x.id, x.order, x.groupKey ?? null]), [['codexmods:unit.m/notes', -1, null], ['codexmods:unit.m/tools', 0, 'workspace'], ['theme', 0, null]]);
  // the app renders a section by calling its render: here, the workspace rows (filtered by the palette: title + id value, keywords)
  const tools = s.ReactDOM.createRoot({});
  tools.render(s.sections.find((x) => x.id.endsWith('/tools')).render(() => { closed++; }));
  const [row] = findAll(tools.tree, (n) => n.type === 'row');
  assert.equal(row.props.title, 'Clean up');
  assert.equal(row.props.value, 'Clean up​unit.m/tools/clean');
  assert.deepEqual(row.props.keywords, ['tidy']);
  row.props.onSelect();
  assert.deepEqual(runs, [{ subject: null, via: 'palette' }]);
  assert.equal(closed, 1, 'the palette closes after a choice');
  // a searching source: nothing until text is typed; its answer as async rows in its own group
  const notes = s.ReactDOM.createRoot({});
  const renderNotes = () => notes.render(s.sections.find((x) => x.id.endsWith('/notes')).render(() => { closed++; }));
  renderNotes();
  assert.equal(findAll(notes.tree, (n) => n.type === 'row').length, 0);
  s.type('milk');
  renderNotes();
  await s.timers.shift()();
  await new Promise((r) => setImmediate(r));
  const [found] = findAll(notes.tree, (n) => n.type === 'row');
  assert.equal(found.props.title, 'Note about milk');
  assert.equal(found.props.value, 'command-menu-async-result:codexmods:unit.m/notes/n1', 'the app\'s async-result value: always shown, ranked last');
  assert.equal(findAll(notes.tree, (n) => n.type === 'group')[0].props.value, 'codexmods:unit.m/notes');
  found.props.onSelect();
  assert.deepEqual(s.ran, [['open', 't1']]);
  root.unmount();
  assert.deepEqual(s.sections.map((x) => x.id), ['theme'], 'the palette closed: the app\'s own sections only');
});

test('P5: the framework\'s own source (the mods\' commands) comes first; its rows run through their registry, not a rule\'s guard', () => {
  const ran = [];
  const ps = createPaletteSources({ react: () => null, exports: () => ({}), guard: () => () => { throw new Error('not a rule'); }, live: () => false, env: () => ({ via: 'palette' }) });
  ps.setSources([{ mod: 'm', id: 's', data: { source: { title: 'Mine' }, items: [{ id: 'a', title: 'A' }] } }]);
  ps.setOwn([{ key: 'codexmods.framework/commands', title: 'Mod commands', items: [{ id: 'mod.a:x', title: 'Do X', description: 'mod.a', run: (env) => ran.push(env.via) }] }]);
  assert.deepEqual(ps.sources().map((x) => [x.key, x.framework === true]), [['codexmods.framework/commands', true], ['m/s', false]]);
  ps.choose(ps.sources()[0], ps.sources()[0].items[0], () => ran.push('closed'));
  assert.deepEqual(ran, ['palette', 'closed']);
  // E8 review 3: a framework source's items may be read as the palette draws them (the commands' `when` asked then)
  let shown = [{ id: 'a', title: 'A' }];
  ps.setOwn([{ key: 'codexmods.framework/commands', title: 'Mod commands', items: () => shown }]);
  const own = ps.sources()[0];
  assert.deepEqual(own.itemsOf().map((r) => r.id), ['a']);
  shown = [];
  assert.deepEqual(own.itemsOf(), [], 'read again: none now');
});

test('GI2b: the framework\'s own searching source (the chats the app does not hold) is asked as the text changes, never through a rule\'s guard; its rows run', async () => {
  const { React, ReactDOM } = createFakeReact();
  let typed = '';
  const timers = [];
  const Row = (p) => React.createElement('row', { value: p.value, title: p.title, description: p.description, onSelect: p.onSelect });
  const Group = (p) => React.createElement('group', { value: p.value }, p.heading, p.children);
  const exportsTable = { commandMenu: { Group }, commandMenuItem: Row, commandMenuState: (sel) => sel({ search: typed }), commandMenuSections: { atom: 'sections' } };
  const ps = createPaletteSources({ react: () => React, exports: () => exportsTable, guard: () => () => { throw new Error('not a rule'); }, live: () => false, env: () => ({ via: 'palette' }),
    schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {} });
  const asked = [], opened = [];
  ps.setOwn([{ key: 'codexmods.framework/chats', title: 'Agents\u2019 chats', items: [], search: async (q) => { asked.push(q); return [{ id: 'chat:unit.agent:c1', title: `Fix ${q}`, description: 'Unit agent', run: () => opened.push('c1') }]; } }]);
  let sections = [];
  const scopeNode = { set: (atom, fn) => { sections = fn(sections); } };
  ReactDOM.createRoot({}).render(React.createElement(ps.Registrar, { scopeNode, close: () => {} }));
  const list = ReactDOM.createRoot({});
  const draw = () => list.render(sections.find((x) => x.id === 'codexmods:codexmods.framework/chats').render(() => opened.push('closed')));
  draw();
  assert.equal(findAll(list.tree, (n) => n.type === 'row').length, 0, 'nothing typed: not asked');
  typed = 'login';
  draw();
  await timers.shift()();
  await new Promise((r) => setImmediate(r));
  const [row] = findAll(list.tree, (n) => n.type === 'row');
  assert.deepEqual([asked, row.props.title, row.props.description], [['login'], 'Fix login', 'Unit agent']);
  row.props.onSelect();
  assert.deepEqual(opened, ['c1', 'closed']);
});

test('E8.5b: a row\'s drill-in page is the app\'s own page: pushed on its stack (title, placeholder); while on top the source\'s section is that page, its search told env.page', async () => {
  const s = setup();
  const ex = { atom: 'pages' };
  let stack = [];
  // the page stack atom, beside the sections atom, in the same scope node
  let secs = [];
  const scopeNode = { set: (atom, v) => { if (atom === ex) stack = typeof v === 'function' ? v(stack) : v; else secs = typeof v === 'function' ? v(secs) : v; }, get: (atom) => (atom === ex ? stack : secs) };
  const asked = [];
  let typed = 'repo';
  const ps = createPaletteSources({ react: () => s.React, exports: () => ({ commandMenu: { Group: (p) => s.React.createElement('group', null, p.children) }, commandMenuItem: (p) => s.React.createElement('row', { title: p.title, onSelect: p.onSelect }),
    commandMenuState: (sel) => sel({ search: typed }), commandMenuSections: { atom: 'sections' }, commandMenuPages: ex }), guard: (r, fn) => fn, env: () => ({ via: 'palette' }),
    schedule: (fn) => { fn(); return 1; }, cancel: () => {} });
  ps.setSources([rule('repos', { title: 'Repos', search: async (q, env) => { asked.push([q, env.page ?? null]); return env.page ? [{ id: `${env.page.id}/main`, title: `${env.page.title}: main` }] : [{ id: 'r1', title: 'repo one', choose: { page: { title: 'Branches', placeholder: 'Search branches' } } }]; } }, [{ id: 'static', title: 'A static row', run() {} }])]);
  const reg = s.ReactDOM.createRoot({});
  let closed = 0, reset = 0;
  reg.render(s.React.createElement(ps.Registrar, { scopeNode, close: () => { closed++; } }));
  const section = () => secs.find((x) => x.id.endsWith('/repos'));
  assert.equal(section().exclusive, false);
  const view = s.ReactDOM.createRoot({});
  const draw = () => view.render(section().render(() => { closed++; }, () => { reset++; }));
  draw();
  await new Promise((r) => setTimeout(r, 0)); draw();
  const drill = findAll(view.tree, (n) => n.type === 'row').find((n) => n.props.title === 'repo one');
  drill.props.onSelect();
  assert.deepEqual([stack, closed, reset], [[{ id: 'codexmods:unit.m/repos/r1', searchPlaceholder: 'Search branches', title: 'Branches' }], 0, 1], 'pushed; the palette stays open');
  assert.equal(section().exclusive, true, 'its page is on top: the only section shown');
  typed = '';   // the app clears the text for the page (reset); a page lists rows with none typed
  draw();
  await new Promise((r) => setTimeout(r, 0)); draw();
  const titles = findAll(view.tree, (n) => n.type === 'row').map((n) => n.props.title);
  assert.deepEqual(titles, ['Branches: main'], 'the page\'s rows only, not the static row');
  assert.deepEqual(asked.at(-1), ['', { id: 'r1', title: 'Branches' }]);
  stack = [{ id: 'theme-page', title: 'Theme' }];
  draw();
  assert.deepEqual(findAll(view.tree, (n) => n.type === 'row'), [], 'another page on top: none of its rows');
});
