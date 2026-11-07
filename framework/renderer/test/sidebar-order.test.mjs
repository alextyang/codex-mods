// ui.sidebar.order (docs/design/public-hooks.md §3.14): the sidebar's lists in a mod's declared order: which list an order names, a path
// (as its mod may read) or a comparator, the unknown last, the app's order for ties; a project's chats marked precomputed. The client and
// the Host: framework/host/test/ui-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarOrder, sortKeys, listOf } from '../present/bindings/sidebar-order.mjs';
import { sidebarList, orderedGroup } from '../present/bindings/sidebar-section.mjs';
import { sectionList } from '../present/bindings/frame.mjs';

const chat = (id, state) => ({ ref: { type: 'CodexThread', provider: 'codex', id }, state });
const subjects = new Map([['a', chat('a', { title: 'Beta', unread: 2 })], ['b', chat('b', { title: 'alpha', unread: 5 })], ['c', chat('c', { title: 'Gamma' })],
  ['p1', { ref: { type: 'LocalProject', provider: 'codex', id: 'p1' }, state: { title: 'Zed' } }], ['p2', { ref: { type: 'LocalProject', provider: 'codex', id: 'p2' }, state: { title: 'Ant' } }]]);
// the app's state that tells whether the user arranged a list (exposure sidebarOrderState): by default, as a profile the user never
// arranged (both sorts by last update, the pinned list's too, no project group dragged)
const UNARRANGED = { prefs: { chatSortMode: 'updated_at', projectSortMode: 'updated_at' }, pinnedSortMode: 'updated_at', projectOrder: [] };
const ATOMS = { prefs: 'PREFS', pinnedSortMode: 'PINNED', projectOrder: 'PROJECTS' };
const stateCtx = (state) => ({ exports: () => ({ sidebarOrderState: ATOMS }), anyScopeNode: () => ({ get: (a) => state[Object.keys(ATOMS).find((k) => ATOMS[k] === a)] }) });
const ctxWith = (rules, reads = '*', state = UNARRANGED) => ({
  ...stateCtx(state),
  declared: (p, s) => (p === 'Sidebar' && s === 'order' ? rules : []),
  guard: (r, fn) => fn,
  whereEnv: () => ({ may: (x) => reads === '*' || reads.includes(x.ref.type) }),
  thread: (key) => ({ type: 'CodexThread', provider: 'codex', id: String(key).replace(/^local:/, '') }),
  subject: (ref) => subjects.get(ref.id),
});
const rule = (sort, extra = {}) => ({ mod: 'unit.o', id: 'o', data: { sort }, ...extra });
const ids = (list) => list.map((x) => x.ref.id);
const sorted = (cmp, list = ['a', 'b', 'c']) => ids(list.map((k) => subjects.get(k)).sort(cmp));

test('which list an order names, and how it compares: a path either way, a comparator, the unknown last, as its mod may read', () => {
  assert.equal(sidebarOrder(ctxWith([rule({ in: 'projects', by: 'title' })]), { name: 'chats' }), null, 'another list');
  assert.ok(sidebarOrder(ctxWith([rule({ by: 'title' })]), { name: 'pinned' }), 'in omitted: every list of chats');
  assert.equal(sidebarOrder(ctxWith([rule({ by: 'title' })]), { name: 'projects' }), null, '...not the project groups themselves');
  assert.ok(sidebarOrder(ctxWith([rule({ in: { type: 'Project', provider: 'codex', id: 'p1' }, by: 'title' })]), { name: 'project', project: { provider: 'codex', id: 'p1' } }));
  assert.equal(sidebarOrder(ctxWith([rule({ in: { type: 'Project', provider: 'codex', id: 'p1' }, by: 'title' })]), { name: 'project', project: { provider: 'codex', id: 'p2' } }), null);
  assert.deepEqual(sorted(sidebarOrder(ctxWith([rule({ by: 'unread' })]), { name: 'chats' })), ['a', 'b', 'c'], 'numbers; c has none: last');
  assert.deepEqual(sorted(sidebarOrder(ctxWith([rule({ by: '-unread' })]), { name: 'chats' })), ['b', 'a', 'c'], 'descending; the unknown still last');
  assert.deepEqual(sorted(sidebarOrder(ctxWith([rule({ by: 'title' })]), { name: 'chats' })), ['b', 'a', 'c'], 'text, as people read it');
  const fn = sidebarOrder(ctxWith([rule({}, { fns: { sort: { by: (x, y) => y.ref.id.localeCompare(x.ref.id) } } })]), { name: 'chats' });
  assert.deepEqual(sorted(fn), ['c', 'b', 'a'], 'the renderer realm\'s comparator');
  assert.deepEqual(sorted(sidebarOrder(ctxWith([rule({ by: 'unread' })], ['Project']), { name: 'chats' })), ['a', 'b', 'c'], 'chats its mod may not read: all unknown, the app\'s order');
  const first = sidebarOrder(ctxWith([rule({ by: '-unread' }), { ...rule({ by: 'unread' }), id: 'later' }]), { name: 'chats' });
  assert.deepEqual(sorted(first), ['b', 'a', 'c'], 'the first order naming a list wins');
  assert.deepEqual(sortKeys(['x', 'a', 'y', 'b'], (k) => subjects.get(k) ?? null, sidebarOrder(ctxWith([rule({ by: '-unread' })]), { name: 'chats' })), ['b', 'a', 'x', 'y'], 'keys with no instance after, in the app\'s order');
  assert.deepEqual([listOf({ threadContainerId: 'pinned' }), listOf({ threadContainerId: 'projects' }), listOf({ threadContainerId: 'custom:9' }), listOf({})].map((l) => l.name), ['pinned', 'projects', 'custom', 'chats']);
});

test('the lists by key and a project\'s chats take the order; with none, the app\'s own', () => {
  const factory = (type, props) => ({ type, props });
  const conversationByKey = new Map(['a', 'b', 'c'].map((id) => [`codex:thread:local:${id}`, { source: 'codex', threadKey: `local:${id}` }]));
  const ctx = { ...ctxWith([rule({ by: '-unread' }), { ...rule({ in: 'projects', by: 'title' }), id: 'p' }]), local: { read() {} } };
  const out = sidebarList.render('List', { keys: ['codex:thread:local:a', 'chatgpt:x', 'codex:thread:local:b'], conversationByKey, threadContainerId: 'chats' }, factory, ctx);
  assert.deepEqual(out.props.keys, ['codex:thread:local:b', 'codex:thread:local:a', 'chatgpt:x']);
  const projectByKey = new Map([['codex:project:p1', { source: 'codex', group: { projectKind: 'local', projectId: 'p1' } }], ['codex:project:p2', { source: 'codex', group: { projectKind: 'local', projectId: 'p2' } }]]);
  const projects = sidebarList.render('List', { keys: ['codex:project:p1', 'codex:project:p2'], conversationByKey, projectByKey, threadContainerId: 'projects' }, factory, ctx);
  assert.deepEqual(projects.props.keys, ['codex:project:p2', 'codex:project:p1'], 'the project groups by their title');
  assert.equal(sidebarList.render('List', { keys: ['codex:thread:local:a'], conversationByKey }, factory, { ...ctxWith([]), local: { read() {} } }), undefined, 'no order, no filter: the app\'s');
  const group = { group: { projectKind: 'local', projectId: 'p1' }, threadKeys: ['local:a', 'local:b', 'local:c'], threadOrderIsPrecomputed: false };
  assert.deepEqual(orderedGroup(group, ctx), { ...group, threadKeys: ['local:b', 'local:a', 'local:c'], threadOrderIsPrecomputed: true }, 'the user\'s saved order does not replace it');
  const el = sectionList.render('List', group, factory, { ...ctx, react: () => null });
  assert.deepEqual([el.props.threadKeys, el.props.threadOrderIsPrecomputed], [['local:b', 'local:a', 'local:c'], true]);
  assert.equal(orderedGroup(group, ctxWith([rule({ in: 'pinned', by: 'title' })])), null);
});

test('layouts D9: the user\'s arrangement wins: an order applies only to a list the user has not arranged by hand, as the app\'s state says', () => {
  const r = [rule({ by: 'title' }), { ...rule({ in: 'projects', by: 'title' }), id: 'p' }];
  const order = (list, state, keys) => sidebarOrder(ctxWith(r, '*', state), list, keys);
  const project = { name: 'project', project: { provider: 'codex', id: 'p1' } };
  // the chats: the sort preference (the unread view drops the drag callback even in "Manual order"); a build without it: the props
  const manualChats = { ...UNARRANGED, prefs: { chatSortMode: 'manual', projectSortMode: 'updated_at' } };
  assert.ok(order(listOf({}), UNARRANGED), 'sorted by last update: the order applies');
  assert.equal(order(listOf({}), manualChats), null, 'manual, in the unread view (no callback): the user\'s');
  assert.equal(order(listOf({ onOrderChange() {} }), manualChats), null);
  const noState = (props) => sidebarOrder({ ...ctxWith(r), exports: () => ({}) }, listOf(props));
  assert.ok(noState({}), 'no state: no callback, the order applies');
  assert.equal(noState({ onOrderChange() {} }), null, 'no state: the callback says manual');
  // a project's chats: the projects' sort preference
  assert.ok(order(project, UNARRANGED));
  assert.equal(order(project, { ...UNARRANGED, prefs: { chatSortMode: 'updated_at', projectSortMode: 'manual' } }), null);
  // the pinned chats: their own mode, manual by the app's default
  assert.ok(order({ name: 'pinned' }, UNARRANGED));
  assert.equal(order({ name: 'pinned' }, { ...UNARRANGED, pinnedSortMode: 'manual' }), null);
  // the project groups: until the user drags one of those listed
  const groups = ['codex:project:p1', 'codex:project:p2'];
  assert.ok(order({ name: 'projects' }, UNARRANGED, groups));
  assert.ok(order({ name: 'projects' }, { ...UNARRANGED, projectOrder: ['codex:project:gone'] }, groups), 'an order of others: not these');
  assert.equal(order({ name: 'projects' }, { ...UNARRANGED, projectOrder: ['codex:project:p2', 'codex:project:p1'] }, groups), null, 'dragged: the user\'s');
  // a custom section always (its order is where the user put each chat); what cannot be told: the app's order
  assert.equal(order({ name: 'custom' }, UNARRANGED), null);
  assert.equal(sidebarOrder({ ...ctxWith(r), exports: () => ({}) }, { name: 'pinned' }), null, 'a build without the state');
  assert.equal(sidebarOrder({ ...ctxWith(r), anyScopeNode: () => ({ get() { throw new Error('no scope'); } }) }, project), null, 'unreadable');
  // through the bindings: a manual Recents list and a dragged project order stay as the user has them; a project group's chats too
  const factory = (type, props) => ({ type, props });
  const conversationByKey = new Map(['a', 'b'].map((id) => [`codex:thread:local:${id}`, { source: 'codex', threadKey: `local:${id}` }]));
  const manual = { ...ctxWith(r, '*', manualChats), local: { read() {} } };
  assert.equal(sidebarList.render('List', { keys: ['codex:thread:local:a', 'codex:thread:local:b'], conversationByKey, onOrderChange() {} }, factory, manual), undefined);
  const group = { group: { projectKind: 'local', projectId: 'p1' }, threadKeys: ['local:a', 'local:b'], threadOrderIsPrecomputed: true };
  assert.equal(orderedGroup(group, ctxWith(r, '*', { ...UNARRANGED, prefs: { chatSortMode: 'updated_at', projectSortMode: 'manual' } })), null);
  // the user picks a sort or drags a group while the lists' props stay the same: they render again (the app's state is watched, once per scope)
  const state = { ...UNARRANGED }, read = [], touched = [], watches = [];
  const node = { get: (a) => state[Object.keys(ATOMS).find((k) => ATOMS[k] === a)], watch: (fn) => { watches.push(fn); fn({ get: node.get }); return () => {}; } };
  const watching = { ...ctxWith(r), anyScopeNode: () => node, local: { read: (k) => read.push(k), touch: (k) => touched.push(k) } };
  assert.ok(sidebarOrder(watching, project));
  assert.ok(sidebarOrder(watching, { name: 'pinned' }));
  assert.deepEqual([watches.length, read.length > 0, touched], [1, true, []], 'one watch; nothing touched when it starts');
  state.prefs = { chatSortMode: 'updated_at', projectSortMode: 'manual' };
  watches[0]({ get: node.get });
  assert.deepEqual(touched, ['local:sidebar.order.state']);
  assert.equal(sidebarOrder(watching, project), null, 'the user\'s now');
});
