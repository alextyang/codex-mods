// ui.settings.section (docs/design/public-hooks.md §3.14): a mod's section after an app settings page's own, in the app's section with its
// title: its component (in its rule's boundary) or rows for the Settings it names, as its mod may read them. The client and the Host:
// framework/host/test/ui-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { settingsFrame } from '../present/bindings/settings-attention.mjs';

test('a section is drawn after the page\'s own: the app\'s section and header, rows of the Settings its mod may read, or its component', () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const Section = ({ children }) => e('section', null, children);
  Section.Header = ({ title }) => e('h2', null, title);
  Section.Content = ({ children }) => e('div', null, children);
  const exports = { SettingsSection: Section, SettingsCard: ({ children }) => e('ul', null, children), SettingsRow: ({ label, control }) => e('li', null, label, ': ', control),
    Switch: ({ checked }) => e('input', { type: 'checkbox', checked }) };
  const setting = (id, title, kind = 'toggle', value = true) => ({ ref: { type: 'Setting', provider: 'codex', id }, state: { title, kind, value, scope: 'app', scopes: ['app'] } });
  const subjects = new Map([['git-branch-prefix', setting('git-branch-prefix', 'Branch prefix', 'text', 'codex/')], ['secret', setting('secret', 'Secret')]]);
  const ctx = { react: () => R, exports: () => exports, use: (fn) => fn(), log() {}, subject: (ref) => subjects.get(ref.id),
    view: () => ({ dispose() {} }), invoke: async () => ({ status: 'done' }),
    whereEnv: (rule) => ({ may: (x) => rule.mod === 'unit.s' && x.ref.id !== 'secret' }) };
  const page = { type: 'SettingsSection', provider: 'codex', id: 'git-settings' };
  const rule = { mod: 'unit.s', id: 'rows' };
  const slot = settingsFrame.twins[0].slots.section;
  const boundaries = [];
  const node = (r, type, props) => { boundaries.push([r.id, props]); return e(type, props); };
  const env = { R, ctx, inst: { ref: page }, node };
  const out = slot.apply({ children: e('p', null, 'app section') }, [
    { rule, item: { id: 'rows', title: 'QA section', settings: [{ type: 'Setting', provider: 'codex', id: 'git-branch-prefix' }, { type: 'Setting', provider: 'codex', id: 'secret' }] } },
    { rule: { mod: 'unit.s', id: 'own' }, item: { id: 'own', title: 'Mine', render: ({ page: p }) => e('em', null, `drawn on ${p}`) } },
  ], env);
  const root = ReactDOM.createRoot({});
  root.render(e(R.Fragment, null, ...[].concat(out.children)));
  const text = rootText(root);
  assert.ok(text.startsWith('app section'), 'the page\'s own first');
  assert.match(text, /QA sectionBranch prefix/, 'its title, then a row for the Setting it names');
  assert.doesNotMatch(text, /Secret/, 'a Setting its mod may not read is left out');
  assert.match(text, /Minedrawn on git-settings/, 'its component, told its page');
  assert.deepEqual(boundaries, [['own', { mod: 'unit.s', page: 'git-settings' }]], 'in its rule\'s boundary');
  assert.equal(root.trees().flatMap((t) => findAll(t, (n) => n.type === 'section')).length, 2);
  assert.equal(slot.apply({ children: 'x' }, [], env).children, 'x', 'no section: the page as it was');
});

test('H7y: the mods\' themes are a section of the framework\'s after the Appearance page\'s own: a row per theme, Use, or Stop using the one on', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const Section = ({ children }) => e('section', null, children);
  Section.Header = ({ title }) => e('h2', null, title);
  Section.Content = ({ children }) => e('div', null, children);
  const exports = { SettingsSection: Section, SettingsCard: ({ children }) => e('ul', null, children), SettingsRow: ({ label, description, control }) => e('li', null, label, ' (', description, ') ', control),
    Button: ({ children, onClick, ...rest }) => e('button', { onClick, ...rest }, children) };
  const calls = [];
  let active = { mod: 'unit.t', id: 'dusk', applied: true };
  const ctx = { react: () => R, exports: () => exports, use: (fn) => fn(), log() {}, themes: () => ({ active }), useTheme: async (mod, id) => { calls.push([mod, id]); return { status: 'done' }; },
    modName: (id) => (id === 'unit.t' ? 'Unit themes' : id) };
  const slot = settingsFrame.twins[0].slots.theme;
  const dark = { surface: '#101418', ink: '#e6e6e6', accent: '#ff8800' };
  const entries = [
    { rule: { mod: 'unit.t', id: 'dusk' }, item: { id: 'dusk', title: 'Dusk', description: 'Warm', dark } },
    { rule: { mod: 'unit.u', id: 'paper' }, item: { id: 'paper', title: 'Paper', light: { surface: '#fffdf5', ink: '#222222', accent: '#0066cc' }, dark } },
  ];
  const env = { R, ctx, inst: { ref: { type: 'SettingsSection', provider: 'codex', id: 'appearance' } } };
  const draw = () => {
    const out = slot.apply({ children: e('p', null, 'appearance') }, entries, env);
    const root = ReactDOM.createRoot({});
    root.render(e(R.Fragment, null, ...[].concat(out.children)));
    return root;
  };
  let root = draw();
  assert.equal(rootText(root), 'appearanceThemes from modsDusk (Unit themes · Warm) Stop usingPaper (unit.u) Use');
  const buttons = () => root.trees().flatMap((t) => findAll(t, (n) => n.type === 'button'));
  assert.deepEqual(buttons().map((b) => b.props['data-codexmods-theme']), ['unit.t/dusk', 'unit.u/paper']);
  const swatches = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'span' && n.props?.style?.background));
  assert.deepEqual(swatches.map((s) => s.props.style.background), ['#101418', '#fffdf5', '#101418'], 'each variant\'s own colours');
  buttons()[0].props.onClick();
  buttons()[1].props.onClick();
  assert.deepEqual(calls, [[null, null], ['unit.u', 'paper']], 'stop the one on; use another');
  // chosen but not holding now (its declaration came back, not yet applied): offered again
  active = { mod: 'unit.t', id: 'dusk', applied: false };
  root = draw();
  assert.match(rootText(root), /Dusk \(Unit themes · Warm\) Use/);
  assert.equal(slot.apply({ children: 'x' }, [], env).children, 'x', 'no theme: the page as it was');
});

test('H7pc: the mods\' Accounts are a section of the framework\'s after the Account page\'s own: a row per Account not Codex\'s, with what it says of itself and its own Sign in or Sign out', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const Section = ({ children }) => e('section', null, children);
  Section.Header = ({ title }) => e('h2', null, title);
  Section.Content = ({ children }) => e('div', null, children);
  const exports = { SettingsSection: Section, SettingsCard: ({ children }) => e('ul', null, children), SettingsRow: ({ label, description, control }) => e('li', null, label, ' (', description, ') ', control),
    Button: ({ children, onClick, ...rest }) => e('button', { onClick, ...rest }, children) };
  const USAGE = { type: 'Usage', provider: 'unit.agent', id: 'u1' };
  const accounts = [
    { ref: { type: 'Account', provider: 'unit.agent', id: 'a1' }, state: { service: 'Unit service', name: 'Unit account', signedIn: true, email: 'unit@example.invalid' }, links: { usage: USAGE } },
    { ref: { type: 'Account', provider: 'unit.other', id: 'a2' }, state: { service: 'Other', name: 'Other account', signedIn: false, plan: 'Free' }, links: {} },
    { ref: { type: 'ChatGPTAccount', provider: 'codex', id: 'me' }, state: { service: 'ChatGPT', name: 'Me', signedIn: true }, links: {} },
  ];
  const calls = [];
  // an account's usage is its provider's own to show (graph-boundary.md B3): the row says only what the Account says of itself
  const ctx = { react: () => R, exports: () => exports, use: (fn) => fn(), log() {}, subject: () => undefined,
    view: (q, fn) => { fn({ type: 'snapshot', items: accounts }); return { dispose() {} }; },
    userAct: async (ref, op) => { calls.push([ref.provider, ref.id, op]); return { status: 'done' }; } };
  const frame = (slug) => settingsFrame.render('Frame', { title: { props: { slug } }, children: e('p', null, 'the page') }, (T, p) => e('div', null, p.children), ctx);
  assert.equal(frame('general'), undefined, 'another page: as it was');
  const root = ReactDOM.createRoot({});
  root.render(frame('account'));
  assert.equal(rootText(root), 'the pageAccounts from modsUnit account (Unit service · unit@example.invalid · Signed in) Sign outOther account (Other · Free · Signed out) Sign in',
    'the page\'s own first; Codex\'s own account is the page\'s, not here');
  const buttons = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'button'));
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['unit.agent', 'a1', 'signOut'], ['unit.other', 'a2', 'signIn']], 'its provider\'s own, as the user\'s act');
});

test('H7pc review: a row shows only its Account\'s own Usage, follows an Account by instance (a subtype\'s change replaces it), and says why a Sign in or Sign out did not go', async () => {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const Section = ({ children }) => e('section', null, children);
  Section.Header = ({ title }) => e('h2', null, title);
  Section.Content = ({ children }) => e('div', null, children);
  const exports = { SettingsSection: Section, SettingsCard: ({ children }) => e('ul', null, children), SettingsRow: ({ label, description, control }) => e('li', null, label, ' (', description, ') ', control),
    Button: ({ children, onClick, ...rest }) => e('button', { onClick, ...rest }, children) };
  const limits = [{ name: 'Messages', used: 12, limit: 100, unit: 'messages' }];
  const subjects = new Map([
    ['unit.b/ub', { ref: { type: 'Usage', provider: 'unit.b', id: 'ub' }, state: { limits }, links: { account: { type: 'Account', provider: 'unit.b', id: 'b' } } }],
    ['unit.a/claims', { ref: { type: 'Usage', provider: 'unit.a', id: 'claims' }, state: { limits }, links: { account: { type: 'Account', provider: 'unit.a', id: 'other' } } }],
  ]);
  const a = (id, usage, extra = {}) => ({ ref: { type: 'Account', provider: 'unit.a', id }, state: { name: `A ${id}`, signedIn: true }, links: usage ? { usage } : {}, ...extra });
  let emit = null;
  const answers = [];
  const ctx = { react: () => R, exports: () => exports, use: (fn) => fn(), log() {}, subject: (ref) => subjects.get(`${ref.provider}/${ref.id}`),
    view: (q, fn) => { emit = fn; fn({ type: 'snapshot', items: [a('x', { type: 'Usage', provider: 'unit.b', id: 'ub' }), a('y', { type: 'Usage', provider: 'unit.a', id: 'claims' })] }); return { dispose() {} }; },
    userAct: async () => answers.shift() };
  const frame = () => settingsFrame.render('Frame', { title: { props: { slug: 'account' } }, children: null }, (T, p) => e('div', null, p.children), ctx);
  const root = ReactDOM.createRoot({});
  root.render(frame());
  assert.equal(rootText(root), 'Accounts from modsA x (Signed in) Sign outA y (Signed in) Sign out', 'another provider\'s Usage, and one that names another Account, are not shown');
  emit({ type: 'delta', event: { kind: 'changed', ref: { type: 'Account', provider: 'unit.a', id: 'x' }, instance: { ...a('x'), ref: { type: 'SubAccount', provider: 'unit.a', id: 'x' }, state: { name: 'A x2', signedIn: true } } } });
  assert.equal(rootText(root), 'Accounts from modsA x2 (Signed in) Sign outA y (Signed in) Sign out', 'its subtype replaces its row');
  emit({ type: 'delta', event: { kind: 'removed', ref: { type: 'SubAccount', provider: 'unit.a', id: 'x' } } });
  assert.equal(rootText(root), 'Accounts from modsA y (Signed in) Sign out', 'and goes with it');
  const press = async () => { root.trees().flatMap((t) => findAll(t, (n) => n.type === 'button'))[0].props.onClick(); await new Promise((r) => setTimeout(r, 0)); };
  answers.push({ status: 'refused', reason: 'notAllowed', message: 'held by unit.policy' });
  await press();
  assert.equal(rootText(root), 'Accounts from modsA y (Signed in — Sign out did not go: held by unit.policy) Sign out');
  answers.push({ status: 'uncertain', message: 'the service did not answer' });
  await press();
  assert.equal(rootText(root), 'Accounts from modsA y (Signed in — Sign out may not have finished: the service did not answer) Sign out');
  answers.push({ status: 'done' });
  await press();
  assert.equal(rootText(root), 'Accounts from modsA y (Signed in) Sign out', 'done: nothing to say (its state says the rest)');
});
