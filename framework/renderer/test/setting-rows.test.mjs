// A mod's settings on its page (docs/design/framework-ui.md F7; systems.md S15, "E3 in detail"): a card per section and group, a control per kind, text committed on Enter (never per
// keystroke), refusals on the row, the changed dot and Reset, Reset all, rows that are not active, and a project-scope setting's menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { createSettingRows } from '../present/setting-rows.mjs';

const P = 'codexmods.framework';
const SECTION = { type: 'SettingsSection', provider: P, id: 'mod:unit.a' };
// a mod's setting as the framework's provider puts it: its key and its Mod (`definedBy`, G3.3)
const setting = (id, state, links = {}) => ({ ref: { type: 'Setting', provider: P, id }, state: { scope: 'app', scopes: ['app'], overridden: false, default: null, key: String(id.split('/')[1] ?? id).split('@')[0], ...state },
  links: { definedBy: { type: 'Mod', provider: P, id: id.split('/')[0] }, ...links } });

function setup({ refuse = null, others = [], busy = false, extra = [], group = [], needs = 'ask' } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const h = (tag) => ({ children, ...p }) => e(tag, p, children);
  const exports = {
    SettingsSection: Object.assign(h('section'), { Header: ({ title, subtitle, actions }) => e('h2', null, title, subtitle ? ` / ${subtitle}` : '', actions ?? null), Content: h('div') }),
    SettingsCard: h('ul'),
    Switch: ({ checked, onChange, disabled, 'aria-label': l }) => e('input', { type: 'checkbox', checked, disabled, 'aria-label': l, onChange }),
    Button: ({ children, onClick, 'aria-label': l }) => e('button', { onClick, 'aria-label': l }, children),
    Menu: ({ triggerButton, children }) => e('div', { 'data-menu': true }, triggerButton, children),
    MenuParts: { Item: ({ children, onClick }) => e('button', { 'data-item': true, onClick }, children), Separator: () => null },
  };
  const data = {
    [`${SECTION.id}/settings`]: [
      setting('unit.a/on', { title: 'On', kind: 'toggle', value: false }),
      setting('unit.a/model', { title: 'Model', description: 'Which model', kind: 'choice', value: 2, scopes: ['app', 'project', 'thread'], choices: [{ id: '1', label: 'One', value: 1 }, { id: '2', label: 'Two', value: 2 }], overridden: true }),
      setting('unit.a/notes', { title: 'Notes', kind: 'text', value: 'hi', scopes: ['app', 'project'] }),
      setting('unit.a/model@thread:codex:t1', { title: 'Model', kind: 'choice', scope: 'thread', value: 1 }),
      ...extra,
    ],
    [`${SECTION.id}/children`]: [{ ref: { type: 'SettingsSection', provider: P, id: 'mod:unit.a:more' }, state: { title: 'More', description: 'And the rest', icon: 'bell' }, links: {} }],
    'mod:unit.a:more/settings': [setting('unit.a/limit', { title: 'Limit', kind: 'number', value: 3 }), ...group],
    projects: [{ ref: { type: 'LocalProject', provider: 'codex', id: 'p1' }, state: { name: 'Proj' }, links: {} }],
  };
  // Every mod's settings, for the composer's choice: `others` are an earlier mod's thread-scope settings.
  const all = [...others, ...data[`${SECTION.id}/settings`]];
  // a project's own instances, the one of its `settings` the provider contributes when they are read (G3.4)
  data['p1/settings'] = [setting('unit.a/notes@project:codex:p1', { title: 'Notes', kind: 'text', value: 'proj', scope: 'project', overridden: true }, { project: { type: 'LocalProject', provider: 'codex', id: 'p1' } })];
  const subjectOf = {
    'CodexMods:codexmods': { ref: { type: 'CodexMods', provider: P, id: 'codexmods' }, state: {}, links: { mods: [{ id: 'unit.0' }, { id: 'unit.a' }] } },
    'Mod:unit.0': { ref: { type: 'Mod', provider: P, id: 'unit.0' }, state: { status: 'enabled' } },
    'Mod:unit.a': { ref: { type: 'Mod', provider: P, id: 'unit.a' }, state: { status: 'enabled', permissions: [{ id: 'secrets', text: 'Keep secrets', optional: true, decision: needs }, { id: 'ui', text: 'Add controls', optional: false }] } },
  };
  const calls = [];
  const subjects = [];
  const rows = createSettingRows({
    R: React, exports: () => exports,
    subscribe: (q, fn) => { if (q.relation) subjects.push(`${q.ref.id}/${q.relation}`); fn({ type: 'snapshot', items: q.type === 'Project' ? data.projects : q.type === 'Setting' ? all : data[`${q.ref.id}/${q.relation}`] ?? [] }); return { dispose() {} }; },
    invoke: async (ref, op, args) => { calls.push([ref.id, op, args]); return refuse ? { status: 'failed', error: { message: refuse } } : { status: 'done' }; },
    ctx: { use: (fn) => fn(), subject: (ref) => {
      if (subjectOf[`${ref.type}:${ref.id}`]) return subjectOf[`${ref.type}:${ref.id}`];
      subjects.push(ref.id); return setting(ref.id, { title: 'Notes', kind: 'text', value: 'proj', scope: 'project', overridden: true });
    } },
  });
  const root = ReactDOM.createRoot({});
  root.render(e(rows.ModSettings, { sectionRef: SECTION, busy }));
  const nodes = (pred) => root.trees().flatMap((t) => findAll(t, pred));
  const row = (key) => nodes((n) => n.props?.['data-setting'] === `unit.a/${key}`)[0];
  return { root, nodes, row, calls, subjects, text: () => rootText(root) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const text = (n) => rootText({ trees: () => [n] });

test('a card per section and group, app-scope settings only, a control for each kind; a group says what it says of itself', () => {
  const s = setup();
  const all = s.text();
  assert.match(all, /More \/ And the rest/, 'the group\'s card');
  assert.doesNotMatch(all, /@thread/, 'a thread\'s instance is not a row of the page');
  assert.equal(findAll(s.row('on'), (n) => n.type === 'input' && n.props.type === 'checkbox').length, 1);
  assert.match(text(s.row('model')), /Two/, 'a choice shows its current choice');
  assert.equal(findAll(s.row('notes'), (n) => n.props?.className === 'cmk-input').length, 1);
  assert.equal(findAll(s.row('limit'), (n) => n.props?.className === 'cmk-stepper').length, 1);
});

test('F7: the changed dot says its value differs from its default, and Reset that a value is stored at this scope: two signals, not one', () => {
  const s = setup({ extra: [
    setting('unit.a/equal', { title: 'Equal', kind: 'text', value: 'x', default: 'x', overridden: true }),
    setting('unit.a/differs', { title: 'Differs', kind: 'text', value: 'y', default: 'x', overridden: true }),
    setting('unit.a/inherited', { title: 'Inherited', kind: 'text', value: 'y', default: 'x', overridden: false }),
    setting('unit.a/plain', { title: 'Plain', kind: 'text', value: 'x', default: 'x', overridden: false }),
  ] });
  const dot = (k) => findAll(s.row(k), (n) => n.props?.className === 'cmk-changed').length;
  const reset = (k) => findAll(s.row(k), (n) => n.props?.['aria-label'] === `Reset ${k}`).length;
  assert.deepEqual(['equal', 'differs', 'inherited', 'plain'].map((k) => [k, dot(k), reset(k)]), [['equal', 0, 1], ['differs', 1, 1], ['inherited', 1, 0], ['plain', 0, 0]]);
});

test('writes: a toggle and a choice at once (its value, not its id); text on Enter, never per keystroke; a number that is not one goes back', async () => {
  const s = setup();
  findAll(s.row('on'), (n) => n.type === 'input')[0].props.onChange(true);
  findAll(s.row('model'), (n) => n.props?.['data-item'])[0].props.onClick();
  const field = () => findAll(s.row('notes'), (n) => n.props?.className === 'cmk-input')[0];
  field().props.onChange({ target: { value: 'hello' } });
  await tick();
  assert.deepEqual(s.calls.map((c) => c[0]), ['unit.a/on', 'unit.a/model'], 'typing writes nothing');
  field().props.onKeyDown({ key: 'Enter' });
  await tick();
  assert.deepEqual(s.calls, [['unit.a/on', 'set', [true]], ['unit.a/model', 'set', [1]], ['unit.a/notes', 'set', ['hello']]]);
  const limit = () => findAll(s.row('limit'), (n) => n.props?.className === 'cmk-stepper-input')[0];
  limit().props.onChange({ target: { value: 'seven' } });
  limit().props.onBlur();
  await tick();
  assert.equal(s.calls.length, 3, 'not a number: not written');
  assert.equal(limit().props.value, '3');
  field().props.onChange({ target: { value: 'again' } });
  field().props.onKeyDown({ key: 'Escape' });
  field().props.onBlur();
  await tick();
  assert.equal(s.calls.length, 3, 'Escape goes back');
});

test('a refusal shows under its row; a project-scope setting edits a chosen project\'s value, the one of its settings (contributed when read)', async () => {
  const s = setup({ refuse: 'must be at most 9' });
  findAll(s.row('on'), (n) => n.type === 'input')[0].props.onChange(true);
  await tick(); await tick();
  assert.match(text(s.row('on')), /must be at most 9/);
  const items = findAll(s.row('notes'), (n) => n.props?.['data-item']);
  assert.deepEqual(items.map((n) => text(n)), ['Every project', 'Proj']);
  items[1].props.onClick();
  await tick();
  assert.ok(s.subjects.includes('p1/settings'), 'the project\'s settings are read: its provider contributes its instance');
  assert.match(text(s.row('notes')), /For this project/);
  assert.equal(findAll(s.row('notes'), (n) => n.props?.['aria-label'] === 'Reset notes').length, 1, 'that project\'s value has its own Reset');
});

test('a thread-scope setting says the composer is where each chat chooses its own, or that the composer has no room for it', () => {
  assert.match(text(setup().row('model')), /Which model\. Each chat can choose its own in the composer\./, 'after its description, as a sentence');
  assert.doesNotMatch(text(setup().row('notes')), /composer/, 'not a thread-scope setting');
  const earlier = ['x', 'y', 'z'].map((k) => setting(`unit.0/${k}`, { title: k, kind: 'toggle', value: false, scopes: ['app', 'project', 'thread'] }));
  assert.match(text(setup({ others: earlier }).row('model')), /Not in the composer, which has room for 3: chats use this value/);
});

test('F7: a row not active is not shown, and its value stays; Reset all covers its section at the app scope, hidden rows included, while more than one is stored', async () => {
  const s = setup({ group: [
    setting('unit.a/hidden', { title: 'Hidden', kind: 'text', value: 'x', default: '', overridden: true, active: false }),
    setting('unit.a/shown', { title: 'Shown', kind: 'text', value: 'y', default: '', overridden: true, active: true }),
  ] });
  assert.equal(s.row('hidden'), undefined);
  assert.ok(s.row('shown'));
  const all = () => s.nodes((n) => n.type === 'button' && n.props?.['aria-label'] === 'Reset more settings')[0];
  await all().props.onClick();
  await tick();
  assert.deepEqual(s.calls, [['mod:unit.a:more', 'resetAll', []]]);
  assert.equal(setup({ group: [setting('unit.a/one', { title: 'One', kind: 'text', value: 'y', overridden: true })] }).nodes((n) => n.props?.['aria-label'] === 'Reset more settings').length, 0, 'one stored: its own Reset is enough');
  assert.equal(s.nodes((n) => n.props?.['aria-label'] === 'Reset all settings').length, 0, 'the mod\'s own section has nothing stored but its model');
});

test('F7: while an operation on the mod runs its controls wait; an image is asked for by its mod', async () => {
  const s = setup({ busy: true });
  assert.equal(findAll(s.row('on'), (n) => n.type === 'input')[0].props.disabled, true);
  assert.equal(findAll(s.row('notes'), (n) => n.props?.className === 'cmk-input')[0].props.disabled, true);
  const t = setup({ extra: [setting('unit.a/pic', { title: 'Pic', kind: 'choice', control: 'thumbnails', value: 'a', choices: [{ id: '"a"', label: 'A', value: 'a', media: { id: 'one' } }, { id: '"b"', label: 'B', value: 'b' }] })] });
  await tick();
  assert.deepEqual(t.calls.filter((c) => c[1] === 'image'), [['unit.a', 'image', ['one']]]);
  const radios = findAll(t.row('pic'), (n) => n.props?.role === 'radio');
  assert.deepEqual(radios.map((n) => n.props['aria-checked']), [true, false]);
  radios[1].props.onClick();
  await tick();
  assert.deepEqual(t.calls.at(-1), ['unit.a/pic', 'set', ['b']]);
});

test('F8: a setting that needs one of its mod\'s optional permissions says so while it is not allowed, with its Allow; never for a required one', async () => {
  const owner = { type: 'Mod', provider: P, id: 'unit.a' };
  const extra = [setting('unit.a/sync', { title: 'Sync', kind: 'toggle', value: false, needs: 'secrets' }, { definedBy: owner }), setting('unit.a/band', { title: 'Band', kind: 'toggle', value: false, needs: 'ui' }, { definedBy: owner })];
  const s = setup({ extra });
  assert.match(text(s.row('sync')), /Needs permission to keep secretsAllow/);
  assert.doesNotMatch(text(s.row('band')), /Needs permission/);
  await findAll(s.row('sync'), (n) => n.props?.className === 'cmk-setting-allow')[0].props.onClick();
  assert.deepEqual(s.calls.at(-1), ['unit.a', 'setPermission', ['secrets', 'allow']]);
  assert.doesNotMatch(text(setup({ extra, needs: 'allow' }).row('sync')), /Needs permission/);
  assert.match(text(setup({ extra, needs: 'deny' }).row('sync')), /Needs permission/);
  assert.doesNotMatch(text(setup({ extra, busy: true }).row('sync')), /Needs permission/, 'not while an operation on the mod runs');
});
