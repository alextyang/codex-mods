// ui.sidebar.section (docs/design/public-hooks.md §3.14): a mod's section drawn with the app's own group and list: its chats from a live
// view of its where (or the ones it names), as its mod may read them, sorted; the app's map of chats with an entry for each; before or
// after the app's groups. The client and the Host: framework/host/test/ui-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll } from './fake-react.mjs';
import { sidebar } from '../present/bindings/frame.mjs';
import { noteShared } from '../present/bindings/sidebar-sections.mjs';

const chat = (id, state) => ({ ref: { type: 'CodexThread', provider: 'codex', id }, state, links: {} });
function setup(rules, { reads = '*' } = {}) {
  const { React: R, ReactDOM } = createFakeReact();
  const e = R.createElement;
  const lists = [];
  const exports = {
    SidebarGroup: ({ heading, collapsed, titleActions, children }) => e('section', { 'data-heading': heading, 'data-collapsed': String(collapsed) }, titleActions ?? null, collapsed ? null : children),
    SidebarList: (props) => { lists.push(props); return e('ul', null, ...props.keys.slice(0, props.maxItems).map((k) => e('li', { key: k }, k))); },
    Button: ({ children, onClick }) => e('button', { onClick }, children),
  };
  const chats = new Map([['a', chat('a', { title: 'Alpha', status: 'working' })], ['b', chat('b', { title: 'Beta', status: 'idle' })], ['c', chat('c', { title: 'Gamma', status: 'working' })]]);
  const touched = [];
  const ctx = {
    react: () => R, exports: () => exports, use: (fn) => fn(), local: { read() {}, touch: (k) => touched.push(k) }, guard: (r, fn) => fn, log() {},
    declared: (p, s) => (p === 'Sidebar' && s === 'section' ? rules : []),
    subject: (ref) => chats.get(ref.id), thread: (key) => ({ type: 'CodexThread', provider: 'codex', id: String(key).replace(/^local:/, '') }),
    whereEnv: () => ({ may: (x) => reads === '*' || reads.includes(x.ref.type), attached: () => undefined, related: () => undefined, relation: () => false }),
    view: (q, fn) => { fn({ type: 'snapshot', items: [...chats.values()] }); return { dispose() {} }; },
  };
  return { R, ReactDOM, e, ctx, lists, touched };
}
const rule = (id, section, extra = {}) => ({ mod: 'unit.s', id, data: { section }, ...extra });

test('a section after the app\'s groups (or before them): the app\'s group and list, its chats as its mod may read them, sorted', () => {
  const ran = [];
  const { R, ReactDOM, ctx, lists, touched } = setup([
    rule('busy', { title: 'Busy', where: { status: 'working' }, sort: '-title' }, { data: { section: { title: 'Busy', where: { status: 'working' }, sort: '-title' }, items: [{ id: 'x', title: 'Refresh', run: () => ran.push(1) }] } }),
    rule('pins', { title: 'Mine', of: [{ type: 'CodexThread', provider: 'codex', id: 'b' }], position: 'top', collapsed: true }),
  ]);
  const factory = (type, props) => R.createElement('div', null, ...props.sidebarSectionNodes);
  assert.deepEqual([].concat(sidebar.render('Scroll', { sidebarSectionNodes: ['app'] }, factory, ctx).props.children), ['app'], 'nothing drawn before one of the app\'s lists has shown');
  noteShared(ctx, { keys: [], conversationByKey: new Map([['codex:thread:local:a', { source: 'codex', threadKey: 'local:a' }]]), mode: 'chats', chatGptSource: { s: 1 } });
  assert.deepEqual(touched.filter((k) => k !== 'local:sidebar.agents'), ['local:sidebar.sections.shared'], 'the sidebar draws them once it has it (the agents the app does not hold are followed apart, G2.1)');
  const out = sidebar.render('Scroll', { sidebarSectionNodes: ['app'] }, factory, ctx);
  const root = ReactDOM.createRoot({});
  root.render(out);
  const sections = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'section'));
  assert.deepEqual(sections.map((s) => [s.props['data-heading'], s.props['data-collapsed']]), [['Mine', 'true'], ['Busy', 'false']], 'top before the app\'s, end after');
  const busy = lists.filter((l) => l.threadContainerId === 'codexmods:unit.s/busy').at(-1);
  assert.deepEqual(busy.keys, ['codex:thread:local:c', 'codex:thread:local:a'], 'its where, its sort');
  assert.equal(busy.mode, 'chats', 'what the app\'s lists are given');
  assert.deepEqual([...busy.conversationByKey.keys()].sort(), ['codex:thread:local:a', 'codex:thread:local:c'], 'an entry for each of its chats');
  const button = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'button'))[0];
  button.props.onClick();
  assert.deepEqual(ran, [1], 'its action');
});

test('a chat its mod may not read is not listed', () => {
  const { R, ReactDOM, ctx, lists } = setup([rule('busy', { title: 'Busy', where: { status: 'working' } })], { reads: ['Project'] });
  noteShared(ctx, { keys: [], conversationByKey: new Map() });
  const root = ReactDOM.createRoot({});
  root.render(sidebar.render('Scroll', { sidebarSectionNodes: [] }, (type, props) => R.createElement('div', null, ...props.sidebarSectionNodes), ctx));
  assert.deepEqual(lists.at(-1).keys, []);
});

test('graph-integrity G2.1: chats the app does not hold are the framework\'s rows, in a section and in their agent\'s group; opening one is its view; its menu the user\'s acts it supports, Delete asked first', async () => {
  const { R, ReactDOM, e } = setup([]);
  const ex = {
    SidebarGroup: ({ heading, children }) => e('section', { 'data-heading': heading }, children),
    SidebarList: (props) => e('ul', null, ...props.keys.map((k) => e('li', { key: k }, k))),
    Menu: ({ triggerButton, children }) => e('div', { 'data-menu': true }, triggerButton, children),
    MenuParts: { Item: ({ children, onClick }) => e('button', { 'data-item': true, onClick }, children) },
    Button: ({ children, onClick, color }) => e('button', { 'data-button': color, onClick }, children),
  };
  const agent = { ref: { type: 'TestAgent', provider: 'qa.test-agent', id: 'agent' }, state: { name: 'Test agent' }, summary: { title: 'Test agent' } };
  const mine = (id, state) => ({ ref: { type: 'TestAgentThread', provider: 'qa.test-agent', id }, state: { status: 'idle', archived: false, unread: false, updatedAt: 1, ...state }, links: { agent: agent.ref }, supports: ['delete'] });
  const chats = [mine('t1', { title: 'Older', updatedAt: 1 }), mine('t2', { title: 'Newer', updatedAt: 5, unread: true }), chat('a', { title: 'Alpha', status: 'working' })];
  const opened = [], acted = [];
  const ctx = {
    react: () => R, exports: () => ex, use: (fn) => fn(), local: { read() {}, touch() {} }, guard: (r, fn) => fn, log() {},
    declared: (p, s) => (p === 'Sidebar' && s === 'section' ? [{ mod: 'm', id: 'all', order: 0, data: { section: { title: 'All', where: { status: { $exists: true } } } } }] : []),
    windowRef: () => ({ type: 'Window', provider: 'codexmods.windows', id: '7' }),
    subject: (ref) => (ref.type === 'Window' ? { ref, state: { shows: [{ type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' }] } } : null), holds: (ref) => ref.provider === 'codex', open: (ref) => opened.push(ref.id), userAct: async (ref, op) => { acted.push([ref.id, op]); return { status: 'done' }; },
    whereEnv: () => ({ may: () => true, attached: () => undefined, related: () => undefined, relation: () => false }),
    view: (q, fn) => { fn({ type: 'snapshot', items: q.type === 'Agent' ? [agent] : chats }); return { dispose() {} }; },
  };
  noteShared(ctx, { keys: [], conversationByKey: new Map(), mode: 'chats' });
  const out = sidebar.render('Scroll', { sidebarSectionNodes: ['app'] }, (type, props) => R.createElement('div', null, ...props.sidebarSectionNodes), ctx);
  const root = ReactDOM.createRoot({});
  root.render(out);
  const sections = root.trees().flatMap((t) => findAll(t, (n) => n.type === 'section'));
  assert.deepEqual(sections.map((s) => s.props['data-heading']), ['Test agent', 'All'], 'the agent\'s group after the app\'s own, then the mod\'s section');
  const rowsOf = (s) => findAll(s, (n) => n.props?.className === 'cml-row-title').map((n) => n.children[0]);
  assert.deepEqual(rowsOf(sections[0]), ['Newer', 'Older'], 'its chats by recency');
  assert.deepEqual(findAll(sections[0], (n) => n.props?.className === 'cml-row').map((n) => n.props['data-selected'] !== undefined), [false, true], 'selected: the one its window shows (Window.shows)');
  assert.deepEqual(findAll(sections[1], (n) => n.type === 'li').map((n) => n.children[0]), ['codex:thread:local:a'], 'the app\'s own chat as its row');
  assert.deepEqual(rowsOf(sections[1]).sort(), ['Newer', 'Older'], 'and the others as the framework\'s');
  findAll(sections[0], (n) => n.props?.className === 'cml-row-open')[0].props.onClick();
  assert.deepEqual(opened, ['t2'], 'opened to its view');
  // the newer chat's menu (unread; it supports delete): archive, mark as read, delete; each the user's own act
  const menu = findAll(sections[0], (n) => n.props?.['data-item']).slice(0, 3);
  assert.ok(menu.length >= 3, 'its menu');
  menu.find((n) => /Mark as read/.test(JSON.stringify(n.children)))?.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(acted, [['t2', 'markRead']]);
  menu.find((n) => /Delete/.test(JSON.stringify(n.children)))?.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(acted, [['t2', 'markRead']], 'not deleted yet: asked first');
  const danger = root.trees().flatMap((t) => findAll(t, (n) => n.props?.['data-button'] === 'danger'));
  assert.equal(danger.length, 1, 'the Dialog\'s Delete');
  danger[0].props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(acted, [['t2', 'markRead'], ['t2', 'delete']]);
});

test('graph-integrity G9.3: a shared row does not offer what its chat\'s provider declares unverified', () => {
  const { R, ReactDOM, e } = setup([]);
  const ex = {
    SidebarGroup: ({ heading, children }) => e('section', { 'data-heading': heading }, children),
    SidebarList: (props) => e('ul', null, ...props.keys.map((k) => e('li', { key: k }, k))),
    Menu: ({ triggerButton, children }) => e('div', { 'data-menu': true }, triggerButton, children),
    MenuParts: { Item: ({ children, onClick }) => e('button', { 'data-item': true, onClick }, children) },
    Button: ({ children, onClick, color }) => e('button', { 'data-button': color, onClick }, children),
  };
  const agent = { ref: { type: 'TestAgent', provider: 'qa.test-agent', id: 'agent' }, state: { name: 'Test agent' }, summary: { title: 'Test agent' } };
  const chats = [{ ref: { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' }, state: { title: 'Kept', status: 'idle', archived: false, unread: true, updatedAt: 1 },
    links: { agent: agent.ref }, supports: ['delete', 'markUnread'], unverified: ['delete', 'markRead'] }];
  const ctx = {
    react: () => R, exports: () => ex, use: (fn) => fn(), local: { read() {}, touch() {} }, guard: (r, fn) => fn, log() {},
    declared: () => [], windowRef: () => null, subject: () => null, holds: (ref) => ref.provider === 'codex', open() {}, userAct: async () => ({ status: 'done' }),
    whereEnv: () => ({ may: () => true, attached: () => undefined, related: () => undefined, relation: () => false }),
    view: (q, fn) => { fn({ type: 'snapshot', items: q.type === 'Agent' ? [agent] : chats }); return { dispose() {} }; },
  };
  noteShared(ctx, { keys: [], conversationByKey: new Map(), mode: 'chats' });
  const out = sidebar.render('Scroll', { sidebarSectionNodes: ['app'] }, (type, props) => R.createElement('div', null, ...props.sidebarSectionNodes), ctx);
  const root = ReactDOM.createRoot({});
  root.render(out);
  const items = root.trees().flatMap((t) => findAll(t, (n) => n.props?.['data-item'])).map((n) => JSON.stringify(n.children));
  assert.ok(items.some((x) => /Archive/.test(x)), 'what is verified is offered');
  assert.ok(!items.some((x) => /Delete|Mark as read/.test(x)), 'what is unverified is not');
});

test('graph-integrity G2.2: a framework row shows its chat\'s marks: the badges its sidebar row\'s rules give it, as the app\'s rows do', () => {
  const { R, ReactDOM, e } = setup([]);
  const ex = {
    SidebarGroup: ({ heading, children }) => e('section', { 'data-heading': heading }, children),
    SidebarList: (props) => e('ul', null, ...props.keys.map((k) => e('li', { key: k }, k))),
    Menu: ({ triggerButton, children }) => e('div', { 'data-menu': true }, triggerButton, children),
    MenuParts: { Item: ({ children, onClick }) => e('button', { 'data-item': true, onClick }, children) },
  };
  const agent = { ref: { type: 'TestAgent', provider: 'qa.test-agent', id: 'agent' }, state: { name: 'Test agent' }, summary: { title: 'Test agent' } };
  const chats = [{ ref: { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' }, state: { title: 'Marked', status: 'idle', archived: false, unread: false, updatedAt: 1 }, links: { agent: agent.ref }, supports: [] }];
  const asked = [];
  const ctx = {
    react: () => R, exports: () => ex, use: (fn) => fn(), local: { read() {}, touch() {} }, guard: (r, fn) => fn, log() {},
    declared: () => [], windowRef: () => null, subject: () => null, holds: (ref) => ref.provider === 'codex', open() {}, userAct: async () => ({ status: 'done' }),
    threadBadges: (ref) => { asked.push(ref.id); return [{ key: 'codexmods:m/mark/conf', item: { id: 'conf', text: 'Conformance', tooltip: 'Its kind' } }]; },
    whereEnv: () => ({ may: () => true, attached: () => undefined, related: () => undefined, relation: () => false }),
    view: (q, fn) => { fn({ type: 'snapshot', items: q.type === 'Agent' ? [agent] : chats }); return { dispose() {} }; },
  };
  noteShared(ctx, { keys: [], conversationByKey: new Map(), mode: 'chats' });
  const out = sidebar.render('Scroll', { sidebarSectionNodes: ['app'] }, (type, props) => R.createElement('div', null, ...props.sidebarSectionNodes), ctx);
  const root = ReactDOM.createRoot({});
  root.render(out);
  const badges = root.trees().flatMap((t) => findAll(t, (n) => n.props?.['data-codexmods-badge']));
  assert.deepEqual([asked, badges.map((b) => b.props['data-codexmods-badge']), badges.map((b) => b.props.title)], [['t1'], ['codexmods:m/mark/conf'], ['Its kind']]);
});
