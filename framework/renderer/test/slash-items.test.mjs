// The mods' slash commands (docs/design/mod-surfaces.md §3.6): registered as a composer's own slash items through the app's hook; chosen,
// a command runs with the composer's Draft and thread, a prompt is inserted into the Draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlashItems, slashOf, argsOf } from '../present/slash-items.mjs';
import { createFakeReact } from './fake-react.mjs';

test('E8.6: a command is checked from its rule; the registrar registers the commands as the app\'s items on every render, ids with the app\'s collapsed prefix', () => {
  assert.equal(slashOf({ mod: 'm', id: 'x', fns: { slash: { name: 'Bad', run() {} } } }), null);
  assert.equal(slashOf({ mod: 'm', id: 'x', fns: { slash: { name: 'ok' } } }), null, 'neither run nor prompt');
  const { React, ReactDOM } = createFakeReact();
  const registered = [], ran = [], inserted = [];
  const hooks = { useComposerItems: (items, deps) => { registered.push({ items, deps }); } };
  const si = createSlashItems({ react: () => React, exports: () => ({ slashHooks: hooks }), guard: (r, fn) => fn, env: (draft, thread) => ({ draft, thread, via: 'slash' }), insert: (d, t) => inserted.push([d.id, t]) });
  si.setCommands([
    { mod: 'unit.s', id: 'sum', fns: { slash: { name: 'summarize', title: 'Summarize', description: 'The chat in short', run: (env) => ran.push(env) } } },
    { mod: 'unit.s', id: 'tpl', data: { slash: { name: 'tpl', prompt: 'Review this:' } } },
  ]);
  const draft = { type: 'Draft', provider: 'codex', id: 't1' }, thread = { type: 'Thread', provider: 'codex', id: 't1' };
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(si.Registrar, { draft, thread }));
  const { items } = registered.at(-1);
  assert.deepEqual(items.map((i) => [i.id, i.title, i.description ?? null, i.searchAliases]), [
    ['custom-prompt:codexmods/unit.s/sum', 'Summarize', 'The chat in short', ['summarize']],
    ['custom-prompt:codexmods/unit.s/tpl', 'tpl', null, ['tpl']],
  ]);
  items[0].onSelect();
  items[1].onSelect();
  assert.deepEqual(ran, [{ draft, thread, via: 'slash', args: '' }]);
  assert.deepEqual(inserted, [['t1', 'Review this:']]);
  // arguments: the app asks each item for its search key with the typed query; the name alone keeps the row matched
  assert.equal(items[0].getSearchQuery('summarize the last two turns'), 'summarize');
  items[0].onSelect();
  assert.deepEqual(ran.at(-1).args, 'the last two turns');
  assert.equal(items[1].getSearchQuery('tpl  src/a.js '), 'tpl');
  items[1].onSelect();
  assert.deepEqual(inserted.at(-1), ['t1', 'Review this:\nsrc/a.js']);
  items[0].getSearchQuery('summ');
  items[0].onSelect();
  assert.equal(ran.at(-1).args, '', 'a query that is not the command\'s name: no arguments');
  const n = registered.length;
  si.setCommands([]);
  assert.ok(registered.length > n && registered.at(-1).items.length === 0, 'a mod off: its commands leave the menu');
});

test('public hooks §3.14: a command\'s aliases find it and take its arguments; its group is its heading; `when: empty` keeps it to an empty composer; a where on the Draft offers it', () => {
  const { React, ReactDOM } = createFakeReact();
  const registered = [], ran = [];
  const hooks = { useComposerItems: (items) => { registered.push(items); } };
  const si = createSlashItems({ react: () => React, exports: () => ({ slashHooks: hooks }), guard: (r, fn) => fn, env: () => ({}), insert: () => {},
    offered: (rule, draft) => draft.id === 'mine' || keeps });
  let keeps = false;
  si.setCommands([
    { mod: 'u', id: 'a', fns: { slash: { name: 'summarize', aliases: ['sum', 'Bad!'], group: 'Notes', whenEmpty: true, run: (env) => ran.push(env.args) } } },
    { mod: 'u', id: 'b', where: { state: 1 }, fns: { slash: { name: 'only', run: () => {} } } },
  ]);
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(si.Registrar, { draft: { type: 'Draft', provider: 'codex', id: 'other' }, thread: null }));
  assert.deepEqual(registered.at(-1).map((i) => [i.title, i.searchAliases, i.group ?? null, i.requiresEmptyComposer]), [['summarize', ['summarize', 'sum'], 'Notes', true]],
    'a where that does not hold on this Draft: not offered here');
  registered.at(-1)[0].getSearchQuery('sum this chat');
  registered.at(-1)[0].onSelect();
  assert.deepEqual(ran, ['this chat'], 'typed by its alias, it takes its arguments');
  root.render(React.createElement(si.Registrar, { draft: { type: 'Draft', provider: 'codex', id: 'mine' }, thread: null }));
  assert.deepEqual(registered.at(-1).map((i) => i.title), ['summarize', 'only']);
  // the same Draft changing: asked again on the next render
  const other = { type: 'Draft', provider: 'codex', id: 'other' };
  root.render(React.createElement(si.Registrar, { draft: other, thread: null }));
  keeps = true;
  root.render(React.createElement(si.Registrar, { draft: other, thread: null }));
  assert.deepEqual(registered.at(-1).map((i) => i.title), ['summarize', 'only'], 'it holds now: offered');
});

test('argsOf: what follows the command\'s name in the matched query, trimmed', () => {
  assert.equal(argsOf('sum x', 'summarize', ['sum']), 'x', 'or one of its aliases');
  assert.equal(argsOf('qa-env  hello world ', 'qa-env'), 'hello world');
  assert.equal(argsOf('QA-ENV x', 'qa-env'), 'x');
  assert.equal(argsOf('qa-envx', 'qa-env'), '');
  assert.equal(argsOf('', 'qa-env'), '');
});

test('E8 review 2: the query kept for arguments is this Draft\'s: a registrar given another Draft starts with none', async () => {
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React, ReactDOM } = createFakeReact();
  const registered = [], ran = [];
  const hooks = { useComposerItems: (items) => { registered.push(items); } };
  const si = createSlashItems({ react: () => React, exports: () => ({ slashHooks: hooks }), guard: (r, fn) => fn, env: (draft) => ({ draft }), insert: () => {} });
  si.setCommands([{ mod: 'u', id: 's', fns: { slash: { name: 'go', run: (env) => ran.push(env) } } }]);
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(si.Registrar, { draft: { type: 'Draft', provider: 'codex', id: 'a' }, thread: null }));
  registered.at(-1)[0].getSearchQuery('go fast');
  root.render(React.createElement(si.Registrar, { draft: { type: 'Draft', provider: 'codex', id: 'b' }, thread: null }));
  registered.at(-1)[0].onSelect();
  assert.deepEqual([ran.at(-1).draft.id, ran.at(-1).args], ['b', '']);
});

test('layouts D8: a command run from a pane\'s composer says that pane, wherever the focus went since', () => {
  const { React, ReactDOM } = createFakeReact();
  const Pane = React.createContext(null);
  const registered = [], ran = [];
  const si = createSlashItems({ react: () => React, exports: () => ({ slashHooks: { useComposerItems: (items) => registered.push(items) } }), guard: (r, fn) => fn, paneContext: () => Pane, env: (draft, thread, pane) => ({ pane }), insert: () => {} });
  si.setCommands([{ mod: 'unit.s', id: 'sum', fns: { slash: { name: 'summarize', run: (env) => ran.push(env.pane) } } }]);
  const draft = { type: 'Draft', provider: 'codex', id: 't1' };
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(Pane.Provider, { value: 'pane-x-1' }, React.createElement(si.Registrar, { draft, thread: null })));
  registered.at(-1)[0].onSelect();
  assert.deepEqual(ran, ['pane-x-1']);
});
