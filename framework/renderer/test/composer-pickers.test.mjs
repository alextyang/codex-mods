// The mods' thread-scope settings in a chat's composer (docs/design/systems.md S15, "E3 in detail"): which settings, in what order,
// within the budget; the pickers slot keeps the app's node first; a picker writes the thread's instance and can go back to the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { pickersOf, createComposerPickers, BUDGET } from '../present/composer-pickers.mjs';
import { composer } from '../present/bindings/composer.mjs';

const P = 'codexmods.framework';
const mod = (id, status = 'enabled') => ({ ref: { type: 'Mod', provider: P, id }, state: { status } });
// a mod's setting as the framework's provider puts it: its key, its Mod (`definedBy`), and the chat of a chat's instance (G3.3)
const st = (id, modId, extra = {}, links = {}) => ({ ref: { type: 'Setting', provider: P, id }, state: { scope: 'app', scopes: ['app', 'project', 'thread'], kind: 'choice', title: id, key: id.split('/')[1].split('@')[0], value: 'a', choices: [{ id: '"a"', label: 'A', value: 'a' }, { id: '"b"', label: 'B', value: 'b' }], ...extra },
  links: { definedBy: { type: 'Mod', provider: P, id: modId }, ...links } });

test('the pickers: thread-scope choices and toggles of enabled mods, by the mods\' order then their own, three at most', () => {
  const settings = [
    st('unit.b/x', 'unit.b'), st('unit.a/y', 'unit.a'), st('unit.a/z', 'unit.a', { kind: 'toggle', value: false, choices: undefined }),
    st('unit.a/app', 'unit.a', { scopes: ['app'] }), st('unit.c/w', 'unit.c'), st('unit.a/y@thread:codex:t1', 'unit.a', { scope: 'thread' }),
    st('unit.d/v', 'unit.d'), { ref: { type: 'Setting', provider: 'codex', id: 'native' }, state: { scope: 'app' } },
  ];
  const mods = [mod('unit.a'), mod('unit.b'), mod('unit.c', 'disabled'), mod('unit.d')];
  const { shown, over } = pickersOf(settings, mods, ['unit.a', 'unit.b', 'unit.c', 'unit.d']);
  assert.equal(BUDGET, 3);
  assert.deepEqual(shown.map((x) => x.ref.id), ['unit.a/y', 'unit.a/z', 'unit.b/x']);
  assert.deepEqual(over.map((x) => x.ref.id), ['unit.d/v'], 'the lowest go; a disabled mod has none');
});

test('in the composer: the app\'s node first, then a picker per setting; choosing writes the thread\'s instance; Use the default resets it', async () => {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const exports = {
    Menu: ({ triggerButton, children }) => e('div', { 'data-menu': true }, triggerButton, children),
    MenuParts: { Item: ({ children, onClick }) => e('button', { 'data-item': true, onClick }, children) },
    Button: ({ children }) => e('span', { 'data-trigger': true }, children),
  };
  const calls = [];
  const thread = { type: 'CodexThread', provider: 'codex', id: 't1' };
  const subjects = new Map([
    [`CodexMods:codexmods`, { ref: { type: 'CodexMods', provider: P, id: 'codexmods' }, links: { mods: [{ id: 'unit.a' }] } }],
    [`Mod:unit.a`, mod('unit.a')],
  ]);
  // the chat's instance is the one of its `settings` with the setting's Mod and key (contributed when the relation is read)
  const scoped = st('unit.a/y@thread:codex:t1', 'unit.a', { scope: 'thread', value: 'b', overridden: true }, { thread });
  const ctx = {
    react: () => React, exports: () => exports, use: (fn) => fn(), log() {},
    subject: (ref) => subjects.get(`${ref.type}:${ref.id}`),
    thread: (id) => ({ ...thread, id }),
    view: (q, fn) => { fn({ type: 'snapshot', items: q.relation === 'settings' ? [scoped] : [st('unit.a/y', 'unit.a', { title: 'Mode' })] }); return { dispose() {} }; },
    invoke: async (ref, op, args) => { calls.push([ref.id, op, args]); return { status: 'done' }; },
  };
  const out = composer.render('Controls', { viewProps: {}, hotkeyWindowHomeFooterControls: 'app-node' }, (type, props) => e(type === 'Controls' ? 'footer' : type, props, props.hotkeyWindowHomeFooterControls), ctx, { kind: 'local', placement: 'main', conversationId: 't1' });
  const root = ReactDOM.createRoot({});
  root.render(out);
  const text = rootText(root);
  assert.ok(text.startsWith('app-node'), 'the app\'s own first');
  assert.match(text, /Mode: B/, 'the thread\'s effective value');
  const items = root.trees().flatMap((t) => findAll(t, (n) => n.props?.['data-item']));
  assert.deepEqual(items.map((n) => n.children[0]), ['A', '✓ B', 'Use the default']);
  items[0].props.onClick();
  items[2].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['unit.a/y@thread:codex:t1', 'set', ['a']], ['unit.a/y@thread:codex:t1', 'reset', []]]);
  assert.equal(composer.render('Controls', {}, () => null, ctx, { kind: 'local', placement: 'side', conversationId: 't1' }), undefined, 'a side chat\'s composer is the app\'s own');
  const pickers = createComposerPickers({ R: React, ctx, exports: () => exports });
  assert.equal(pickers.nodeFor(thread, null), pickers.nodeFor(thread, null), 'one element per thread: the composer\'s caches keep theirs');
});
