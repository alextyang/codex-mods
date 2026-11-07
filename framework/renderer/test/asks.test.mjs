// A mod's questions in a window (docs/design/systems.md "E7 in detail" decision 7, E7.6c): one at a time, in order, none while a
// framework Dialog is open; the user's choice or cancel answered once; the Host's end closes one; one that cannot be drawn is cancelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createAsks, ASK_BINDING } from '../present/asks.mjs';
import { createKit } from '../present/kit/index.mjs';
import { createSettingControls } from '../present/setting-controls.mjs';

function setup() {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const answers = [];
  const reported = [];
  let frameworkOpen = 0;
  const ctx = { report: { put: (rec) => reported.push(['put', rec.props]), remove: (rec) => reported.push(['remove', rec.props.ask]) } };
  const Frame = ({ title, subtitle, footer, children, onClose }) => e('div', { role: 'dialog', onClose }, title, ' | ', subtitle, ' | ', children, ...footer);
  const asks = createAsks({ R, ctx, answer: (gen, id, outcome) => { answers.push([gen, id, outcome]); },
    dialogs: { Frame, open: () => frameworkOpen, button: (label, onClick) => e('button', { onClick }, label) } });
  const root = ReactDOM.createRoot({});
  root.render(e(asks.Asks));
  const press = (label) => findAll(root.tree, (n) => n.type === 'button' && n.children.join('') === label)[0].props.onClick();
  const dialog = () => findAll(root.tree, (n) => n.props?.role === 'dialog')[0] ?? null;
  return { asks, root, answers, reported, press, dialog, setOpen: (n) => { frameworkOpen = n; asks.refresh(); } };
}
const Q = (id, extra = {}) => ({ t: 'ask', id, gen: 4, requester: { id: 'unit.a', name: 'Unit A' }, subject: { type: 'Thread', provider: 'codex', id: 't1' }, purpose: 'confirm',
  title: `Delete ${id}?`, message: 'It cannot be undone.', actions: [{ id: 'yes', title: 'Delete' }, { id: 'no', title: 'Keep' }], ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test('E7.6c: one question at a time, named by the framework, reported as a Dialog with its id; the user\'s choice answered once, then the next', async () => {
  const s = setup();
  s.asks.receive(Q(1));
  s.asks.receive(Q(2));
  s.asks.receive(Q(1));   // the same again: ignored
  assert.match(rootText(s.root), /^Delete 1\? \| Unit A asks \| It cannot be undone\./);
  assert.deepEqual(s.reported, [['put', { subject: { type: 'Thread', provider: 'codex', id: 't1' }, place: { in: 'Window', slot: 'confirm' }, ask: 1 }]]);
  assert.equal(ASK_BINDING.ask(s.reported[0][1]), 1, 'the reporting binding carries the question\'s id');
  s.press('Keep');
  await flush();
  assert.deepEqual(s.answers, [[4, 1, { choice: 'no' }]]);
  assert.match(rootText(s.root), /^Delete 2\?/, 'the next one');
  const close = s.dialog().props.onClose;
  s.press('Cancel');
  close();   // already answered: nothing more
  await flush();
  assert.deepEqual(s.answers.slice(1), [[4, 2, { cancelled: true, by: 'user', reason: 'cancelled' }]]);
  assert.equal(s.dialog(), null);
  assert.deepEqual(s.asks.pending(), []);
});

test('E7.6c: none while a framework Dialog is open; the Host\'s end closes one unanswered; malformed questions are ignored', async () => {
  const s = setup();
  s.setOpen(1);
  s.asks.receive(Q(1));
  assert.equal(s.dialog(), null, 'consent and recovery come first');
  s.setOpen(0);
  assert.match(rootText(s.root), /Delete 1\?/);
  s.asks.receive({ t: 'askEnd', id: 1 });
  assert.equal(s.dialog(), null);
  for (const bad of [{ ...Q(3), actions: [] }, { ...Q(4), requester: null }, { ...Q(5), gen: 'x' }, { t: 'other', id: 6 }]) s.asks.receive(bad);
  assert.deepEqual(s.asks.pending(), []);
  await flush();
  assert.deepEqual(s.answers, []);
});

test('E7.6c: a question that cannot be drawn is cancelled as its own end, and the next one shows', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const answers = [];
  const Frame = ({ title, footer }) => { if (title === 'Bad?') throw new Error('boom'); return e('div', { role: 'dialog' }, title, ...footer); };
  const asks = createAsks({ R, ctx: {}, answer: (gen, id, outcome) => { answers.push([id, outcome]); }, dialogs: { Frame, open: () => 0, button: (label, onClick) => e('button', { onClick }, label) } });
  const root = ReactDOM.createRoot({});
  root.render(e(asks.Asks));
  asks.receive(Q(1, { title: 'Bad?' }));
  asks.receive(Q(2));
  await flush();
  assert.deepEqual(answers, [[1, { cancelled: true, reason: 'it could not be shown' }]]);
  assert.match(rootText(root), /Delete 2\?/);
});

test('E7.6c: on the app\'s modal stack when a scope node is held: opened under its own component, closed when answered; off while a framework Dialog is open; the app removing it cancels it', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const answers = [];
  let frameworkOpen = 0;
  const entries = [];   // the app's stack: [{C, opts}]
  const node = { set() {} };
  const modal = { open: (n, C, props, opts) => { assert.equal(n, node); entries.push({ C, opts }); }, close: (n, C) => { const i = entries.findIndex((x) => x.C === C); if (i >= 0) { const [x] = entries.splice(i, 1); x.opts.onDispose?.(); } } };
  const Frame = ({ title, footer, plain }) => e('div', { role: 'dialog', 'data-plain': String(Boolean(plain)) }, title, ...footer);
  const asks = createAsks({ R, ctx: {}, stack: () => ({ node, modal }), answer: (gen, id, outcome) => { answers.push([id, outcome]); },
    dialogs: { Frame, open: () => frameworkOpen, button: (label, onClick) => e('button', { onClick }, label) } });
  const own = ReactDOM.createRoot({});   // the framework's root: draws nothing while the stack takes them
  own.render(e(asks.Asks));
  const host = ReactDOM.createRoot({});   // the app's modal host
  const showHost = () => host.render(e(R.Fragment, null, ...entries.map((x, i) => e(x.C, { key: i }))));
  asks.receive(Q(1));
  asks.receive(Q(2));
  assert.equal(entries.length, 1);
  assert.equal(rootText(own), '');
  showHost();
  assert.match(rootText(host), /^Delete 1\?/);
  assert.equal(findAll(host.tree, (n) => n.props?.role === 'dialog')[0].props['data-plain'], 'false', 'the app\'s Dialog');
  findAll(host.tree, (n) => n.type === 'button' && n.children.join('') === 'Delete')[0].props.onClick();
  await flush();
  assert.deepEqual(answers, [[1, { choice: 'yes' }]]);
  assert.equal(entries.length, 1, 'the next one');
  showHost();
  assert.match(rootText(host), /^Delete 2\?/);
  frameworkOpen = 1; asks.refresh();
  assert.equal(entries.length, 0, 'off the stack while consent or recovery shows');
  frameworkOpen = 0; asks.refresh();
  assert.equal(entries.length, 1, 'back, under a new component');
  entries[0].opts.onDispose(); entries.splice(0, 1);   // the app closed every modal
  await flush();
  assert.deepEqual(answers.slice(1), [[2, { cancelled: true, reason: 'the app closed it' }]]);
});

test('E7.6c: without a scope node (or when the stack refuses) the framework\'s root draws the fallback Dialog', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  let held = null;
  const Frame = ({ title, plain }) => e('div', { role: 'dialog', 'data-plain': String(Boolean(plain)) }, title);
  const asks = createAsks({ R, ctx: {}, stack: () => held, answer: () => {}, dialogs: { Frame, open: () => 0, button: (label, onClick) => e('button', { onClick }, label) } });
  const own = ReactDOM.createRoot({});
  own.render(e(asks.Asks));
  asks.receive(Q(1));
  assert.match(rootText(own), /Delete 1\?/);
  assert.equal(findAll(own.tree, (n) => n.props?.role === 'dialog')[0].props['data-plain'], 'true');
  held = { node: { set() {} }, modal: { open() { throw new Error('no stack'); }, close() {} } };
  asks.refresh();
  assert.match(rootText(own), /Delete 1\?/, 'the stack refused: still drawn here');
});

test('public hooks §3.14, graph-integrity G4.2: a question\'s fields are settings\' declarations drawn by the settings\' own controls (a secret masked), from their defaults; the choice answers with their values by key', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const answers = [];
  const Switch = (p) => e('input', { ...p, kind: 'switch' });
  const Frame = ({ title, footer, children }) => e('div', { role: 'dialog' }, title, ...[].concat(children ?? []), ...footer);
  const kit = createKit({ react: () => R, parts: () => ({}), document: () => null });
  const controls = createSettingControls({ R, kit, exports: () => ({ Switch }), useImage: () => null });
  const asks = createAsks({ R, ctx: {}, controls, answer: (gen, id, outcome) => { answers.push([id, outcome]); },
    dialogs: { Frame, open: () => 0, button: (label, onClick) => e('button', { onClick }, label), exports: () => ({ Switch }) } });
  const root = ReactDOM.createRoot({});
  root.render(e(asks.Asks));
  asks.receive(Q(1, { fields: [{ key: 'name', kind: 'text', title: 'Name', default: 'x' }, { key: 'key', kind: 'text', control: 'secret', title: 'Key', default: '' },
    { key: 'on', kind: 'toggle', title: 'On', default: true }, { key: 'count', kind: 'number', title: 'Count', default: 2, min: 1, max: 5 }] }));
  await flush();
  const inputs = () => findAll(root.tree, (n) => n.type === 'input');
  const byLabel = (l) => inputs().find((n) => n.props['aria-label'] === l);
  assert.deepEqual(['Name', 'Key', 'On'].map((l) => [l, byLabel(l).props.type ?? null, byLabel(l).props.value ?? byLabel(l).props.checked]), [['Name', 'text', 'x'], ['Key', 'password', ''], ['On', null, true]]);
  assert.ok(findAll(root.tree, (n) => n.props?.['data-codexmods-field'] === 'count').length, 'a number drawn too');
  byLabel('Key').props.onChange({ target: { value: 's3cr3t' } });
  await flush();
  byLabel('Key').props.onBlur();   // a text commits as it loses focus, as the action is clicked
  byLabel('On').props.onChange(false);
  findAll(root.tree, (n) => n.type === 'button' && n.children.join('') === 'Delete')[0].props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [[1, { choice: 'yes', values: { name: 'x', key: 's3cr3t', on: false, count: 2 } }]]);
});
