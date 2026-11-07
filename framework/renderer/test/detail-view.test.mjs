// The DetailView (docs/design/systems.md S11, E6.6c): any graph instance's summary, state and relations; its argument-free operations as
// buttons, the others listed; a framework-owned instance links to its own page instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createDetailView, shown, RELATED } from '../present/detail-view.mjs';
import { createDialogs } from '../present/dialogs.mjs';

const AGENT = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
const TYPE = {
  id: 'TestAgentThread', summary: { title: 'title' },
  members: {
    state: { title: {}, status: {}, preview: {} },
    relations: { project: { cardinality: 'maybe' }, turns: { cardinality: 'many' } },
    operations: { archive: { minArgs: 0 }, rename: { minArgs: 1 } },
  },
};

function setup({ ref = AGENT, inst, invoke, ownPage = () => null } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const h = (tag) => ({ children, ...p }) => e(tag, p, children);
  const Section = Object.assign(h('section'), { Header: ({ title }) => e('h2', null, title), Content: h('div') });
  const exports = {
    SettingsPageFrame: ({ title, subtitle, children }) => e('main', null, e('h1', null, title), subtitle ?? null, children),
    SettingsSection: Section, SettingsCard: h('ul'),
    SettingsRow: ({ label, description, control }) => e('li', { 'data-row': label }, label, ' | ', description ?? '', ' | ', control ?? null),
    Button: ({ children, onClick, disabled, ...rest }) => e('button', { onClick, disabled, 'aria-label': rest['aria-label'] }, children),
    Dialog: h('dialog'), DialogParts: { Header: ({ title }) => e('header', null, title), Body: h('div'), Footer: h('footer') },
  };
  const subjects = new Map();
  if (inst !== null) subjects.set(`${ref.type}:${ref.id}`, inst ?? { ref, state: { title: 'Plan the trip', status: 'idle', preview: 'x'.repeat(400) },
    links: { project: { type: 'Project', provider: 'codex', id: 'p1' }, turns: Array.from({ length: 12 }, (_, i) => ({ type: 'Turn', provider: 'qa.test-agent', id: `u${i}` })) } });
  const ctx = { use: (fn) => fn(), subject: (r) => subjects.get(`${r.type}:${r.id}`), local: { read() {}, touch() {} } };
  const calls = [], shownRefs = [], owned = [], observed = [];
  let current = ref;
  const view = createDetailView({ R: React, ctx, exports: () => exports, typeOf: (t) => (t === 'TestAgentThread' ? TYPE : null),
    observe: (r) => { observed.push(r.id); return { dispose() { observed.push(`-${r.id}`); } }; },
    current: () => current, show: (r) => { shownRefs.push(r); current = r; }, ownPage, openOwn: (r) => owned.push(r), dialogs: createDialogs({ R: React, exports: () => exports, ctx }),
    invoke: async (r, op, args) => { calls.push([r.id, op, args]); return invoke ? invoke(r, op, args) : { status: 'done' }; } });
  const root = ReactDOM.createRoot({});
  const rerender = () => root.render(e(view.DetailPage));
  rerender();
  const all = (pred) => root.trees().flatMap((t) => findAll(t, pred));
  const textOf = (n) => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''));
  const row = (label, i = 0) => all((n) => n.type === 'li' && n.props['data-row'] === label)[i];
  const button = (label, text, i = 0) => findAll(row(label, i), (n) => n.type === 'button' && textOf(n) === text)[0];
  const inDialog = (text) => all((n) => n.type === 'dialog').flatMap((d) => findAll(d, (n) => n.type === 'button' && textOf(n) === text))[0];
  return { root, rerender, text: () => rootText(root), row, button, inDialog, calls, shownRefs, owned, observed };
}

test('an instance: its summary as the title, its state, its relations as links (at most ten of one), its argument-free operations', async () => {
  const t = setup({ invoke: () => ({ status: 'refused', message: 'not now' }) });
  const text = t.text();
  assert.match(text, /^Plan the tripTestAgentThread from qa\.test-agent/);
  assert.match(text, /title \| {2}\| Plan the trip/);
  assert.match(text, /preview \| {2}\| x{159}…/, 'a long value is cut');
  assert.match(text, /project \| Project · p1 \| Details/);
  assert.match(text, /turns \| and 2 more/);
  assert.equal(RELATED, 10);
  assert.match(text, /rename \| Takes arguments: not offered here/);
  t.button('archive', 'Run…').props.onClick();
  assert.equal(t.calls.length, 0, 'it asks first');
  assert.match(t.text(), /Run archive on Plan the trip\?TestAgentThread\.archive, as you, through the graph/);
  await t.inDialog('Run').props.onClick();
  assert.deepEqual(t.calls, [['t1', 'archive', []]]);
  assert.match(t.text(), /not now/, 'a refusal stays in the Dialog');
  t.inDialog('Cancel').props.onClick();
  t.button('project', 'Details').props.onClick();
  assert.deepEqual(t.shownRefs, [{ type: 'Project', provider: 'codex', id: 'p1' }]);
  assert.deepEqual(t.observed, ['t1'], 'observed while shown, so its provider puts it');
  assert.equal(shown({ a: 1 }), '{"a":1}');
});

test('a framework-owned instance links to its own page instead of offering operations; one not in the graph says so', () => {
  const MOD = { type: 'Mod', provider: 'codexmods.framework', id: 'acme.demo' };
  const t = setup({ ref: MOD, inst: { ref: MOD, state: { name: 'Demo' }, links: {} }, ownPage: () => '/settings/codexmods/acme.demo' });
  assert.match(t.text(), /Its pageThe framework's \| Its actions are on its own page/);
  t.button('The framework\'s', 'Open its page').props.onClick();
  assert.deepEqual(t.owned, [MOD]);
  const g = setup({ inst: null });
  assert.match(g.text(), /TestAgentThread from qa\.test-agent · not in the graph now/);
  assert.equal(g.button('archive', 'Run…').props.disabled, true);
});

test('E6 review: a confirmation is about the instance it was asked for; another instance shown takes it away, nothing runs on that one', async () => {
  const t = setup();
  t.button('archive', 'Run…').props.onClick();
  assert.ok(t.inDialog('Run'));
  t.button('project', 'Details').props.onClick();
  t.rerender();
  assert.equal(t.inDialog('Run'), undefined, 'the confirmation went with the instance it was about');
  assert.deepEqual(t.calls, []);
});
