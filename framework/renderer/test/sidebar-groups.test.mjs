// The app's sidebar groups (docs/design/layouts.md §4.1, D9): their order through the seam sidebar-groups while the user has placed none of
// them, and a hidden group left out of their sortable container unless it holds a chat that needs the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderGroups, groupsPlaced, hideGroups } from '../present/bindings/sidebar-groups.mjs';
import { createFakeReact } from './fake-react.mjs';

const stateCtx = (sectionOrder) => ({ exports: () => ({ sidebarGroupState: { sections: 'DER' } }), anyScopeNode: () => ({ get: (a) => (a === 'DER' ? { sectionOrder } : null) }) });
const reorder = (order) => ({ mod: 'unit.g', id: 'o', kind: 'reorder', slot: 'groups', data: { order } });

test('§4.1, D9: the groups in a mod\'s order (the named first, the others as they were) while the user has placed none of the app\'s groups', () => {
  const keys = ['pinned', 'threads', 'chats', 'custom:a'];
  assert.deepEqual(orderGroups(stateCtx([]), [reorder(['chats', 'projects'])], keys), ['chats', 'threads', 'pinned', 'custom:a']);
  assert.deepEqual(orderGroups(stateCtx(['custom:a']), [reorder(['chats'])], keys)[0], 'chats', 'a custom section of their own alone: not placed');
  assert.equal(orderGroups(stateCtx(['threads', 'chats']), [reorder(['chats'])], keys), keys, 'the user dragged a group: theirs');
  assert.equal(orderGroups({ exports: () => ({}) }, [reorder(['chats'])], keys), keys, 'cannot tell: the app\'s');
  assert.equal(orderGroups(stateCtx([]), [], keys), keys);
  assert.equal(groupsPlaced(stateCtx(null)), true);
});

test('§4.1, D9: a hidden group leaves the sortable container (and its drag id) unless it holds a chat that needs the user; other lists pass', () => {
  const { React } = createFakeReact();
  const h = React.createElement;
  const chats = { a: { ref: { type: 'CodexThread', provider: 'codex', id: 'a' }, state: { status: 'idle' } }, b: { ref: { type: 'CodexThread', provider: 'codex', id: 'b' }, state: { status: 'waitingForYou' } } };
  const list = (ids) => h('List', { keys: ids.map((i) => `codex:thread:local:${i}`), conversationByKey: new Map(ids.map((i) => [`codex:thread:local:${i}`, { threadKey: `local:${i}` }])) });
  const group = (key, ids) => ({ ...h('Group', { children: list(ids) }), key });
  const tallies = [];
  let hides = [{ mod: 'unit.g', id: 'h', kind: 'hide', part: ['chats', 'pinned'] }];
  const ctx = { react: () => React, ruled: () => ({ parts: hides }), thread: (k) => ({ type: 'CodexThread', provider: 'codex', id: k.replace('local:', '') }), subject: (ref) => chats[ref.id],
    local: { read() {}, touch: (k) => tallies.push(k) }, view: () => null };
  const props = { items: ['sidebar-section:pinned', 'sidebar-section:threads', 'sidebar-section:chats'], children: [group('pinned', ['b']), group('threads', ['a']), group('chats', ['a'])] };
  const out = hideGroups(props, ctx);
  assert.deepEqual([out.items, out.children.map((c) => c.key)], [['sidebar-section:pinned', 'sidebar-section:threads'], ['pinned', 'threads']], 'chats hidden; pinned holds a waiting chat: kept');
  assert.equal(hideGroups({ items: ['x'], children: [group('reviews', ['a'])] }, ctx), undefined, 'another sortable list (no chats group): as it is');
  // a chat the graph has not answered for yet keeps its group (its mapping, its subject); one it answered it has none of holds none (round 2)
  const unknown = { ...props, children: [group('pinned', ['b']), group('threads', ['a']), group('chats', ['zz'])] };
  assert.deepEqual(hideGroups(unknown, ctx), undefined, 'chats holds one not answered for yet: kept');
  assert.deepEqual(hideGroups(unknown, { ...ctx, settled: (ref) => ref.id === 'zz' }).items, ['sidebar-section:pinned', 'sidebar-section:threads'], 'answered: the graph has none: hidden');
  assert.deepEqual(hideGroups(unknown, { ...ctx, settled: () => true, thread: (k) => (k === 'local:zz' ? null : ctx.thread(k)) }), undefined, 'its id\'s mapping not answered yet: kept');
  hides = [{ mod: 'unit.g', id: 'h', kind: 'hide', part: ['agents'] }];
  const agents = { items: ['sidebar-section:agents', 'sidebar-section:chats'], children: [{ ...h('Agents', { children: h('Row', {}) }), key: 'agents' }, group('chats', ['a'])] };
  assert.deepEqual(hideGroups(agents, ctx).items, ['sidebar-section:chats']);
  hides = [];
  assert.equal(hideGroups(props, ctx), undefined, 'no hide: as it is');
});
