// The kit's SettingRow (graph-integrity G3.6): a Setting drawn with the framework's controls, reset and errors in a mod's own surface,
// read and set as that mod; one of the mod's own settings by key at a chat (the one of the chat's `settings` it defined), at the app, or a
// Setting given whole; another mod's refused change shows on the row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { createSettingRow } from '../present/setting-row.mjs';
import { createKit } from '../present/kit/index.mjs';

const P = 'codexmods.framework';
const CHAT = { type: 'CodexThread', provider: 'codex', id: 't1' };
const setting = (id, modId, state, links = {}) => ({ ref: { type: 'Setting', provider: P, id }, links: { definedBy: { type: 'Mod', provider: P, id: modId }, ...links },
  state: { title: 'Mode', kind: 'choice', scope: 'app', scopes: ['app', 'project', 'thread'], value: 'a', default: 'a', overridden: false, choices: [{ id: '"a"', label: 'Fast' }, { id: '"b"', label: 'Careful' }], ...state } });

function setup({ refuse = null, extra = [] } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const views = [], calls = [];
  const data = {
    chat: [setting('acme.x/mode@thread:codex:t1', 'acme.x', { key: 'mode', scope: 'thread', value: 'b', overridden: true }, { thread: CHAT }),
      setting('other.y/mode@thread:codex:t1', 'other.y', { key: 'mode', scope: 'thread', value: 'a' }, { thread: CHAT })],
    app: [setting('acme.x/mode', 'acme.x', { key: 'mode' }), setting('other.y/mode', 'other.y', { key: 'mode' }), ...extra],
  };
  const graph = {
    subscribe(q, fn) { views.push(q); fn({ type: 'snapshot', items: q.relation === 'settings' ? data.chat : q.type === 'Setting' ? data.app : data.app.filter((x) => x.ref.id === q.ref.id) }); return { dispose() {} }; },
    async invoke(ref, op, args) { calls.push([ref.id, op, args]); return refuse && ref.id.startsWith('other.') ? { status: 'refused', reason: 'notAllowed', message: refuse } : { status: 'done' }; },
  };
  const kit = createKit({ react: () => React, parts: () => ({}), document: () => null });
  const exports = { Switch: ({ checked, onChange, 'aria-label': l }) => React.createElement('input', { type: 'checkbox', checked, onChange, 'aria-label': l }) };
  const SettingRow = createSettingRow({ R: () => React, kit, exports: () => exports, modId: 'acme.x', graph: () => graph });
  const draw = (props) => { const root = ReactDOM.createRoot({}); root.render(React.createElement(SettingRow, props)); return root; };
  return { draw, views, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const buttons = (root, pred) => root.trees().flatMap((t) => findAll(t, (n) => n.type === 'button' && pred(n)));

test('one of the mod\'s own settings by key at a chat: the one of the chat\'s settings it defined, with its value there and its reset', async () => {
  const s = setup();
  const root = s.draw({ setting: { key: 'mode', thread: CHAT } });
  assert.deepEqual(s.views, [{ ref: CHAT, relation: 'settings' }], 'it reads the chat\'s settings (contributed when read)');
  assert.match(rootText(root), /Mode/);
  const reset = buttons(root, (n) => n.props['aria-label'] === 'Reset mode');
  assert.equal(reset.length, 1, 'set on that chat: it has its own reset');
  reset[0].props.onClick();
  await tick();
  assert.deepEqual(s.calls, [['acme.x/mode@thread:codex:t1', 'reset', []]], 'its own instance, never another mod\'s of the same key');
});

test('at the app by key, or a Setting given whole; another mod\'s change refused shows on the row', async () => {
  const other = setting('other.y/on', 'other.y', { key: 'on', title: 'On', kind: 'toggle', value: false, default: false, choices: undefined });
  const s = setup({ refuse: 'acme.x may not set other.y\'s settings', extra: [other] });
  s.draw({ setting: { key: 'mode' } });
  assert.deepEqual(s.views.at(-1), { type: 'Setting', where: { scope: 'app', key: 'mode' } });
  const root = s.draw({ setting: other });
  const toggle = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'input'))[0];
  toggle.props.onChange(true);
  await tick(); await tick();
  assert.deepEqual(s.calls.at(-1), ['other.y/on', 'set', [true]]);
  assert.match(rootText(root), /may not set other\.y's settings/, 'the refusal is the row\'s error');
  assert.equal(rootText(setup().draw({ setting: { key: 'mode', thread: 'nope' } })), '', 'a scope that is not a ref draws nothing');
});
