// Query, search and event views (docs/design/public-hooks.md §3.2): a type's instances in pages, in an order, with words of their titles;
// what a text matches among the searchable types, a provider's content matches only for their readers; a view of chosen changes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../index.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const P = 'codex';
const threadRef = (id) => ({ type: 'CodexThread', provider: P, id });
const state = (title, over = {}) => ({ title, status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1, ...over });
const links = () => ({ agent: { type: 'CodexAgent', provider: P, id: 'codex' } });

function setup(search) {
  const g = createGraph();
  g.registerTypes(NATIVE, 'native');
  const p = g.registerProvider('native', P, { types: { Thread: {}, Turn: {} }, ...(search ? { search, searchContent: 'Message' } : {}) });
  const put = (id, title, over) => p.put(threadRef(id), { state: state(title, over), links: links(id) });
  put('a', 'Fix the login bug', { updatedAt: 30 });
  put('b', 'Plan the release', { updatedAt: 10 });
  put('c', 'login page copy', { updatedAt: 20, unread: true });
  put('d', 'Release notes', { updatedAt: 40 });
  put('e', 'Hidden one', { updatedAt: 50 });
  return { g, p, put };
}
const ids = (items) => items.map((s) => s.ref.id);

test('query: a where, words of the title, an order (absent last), pages that neither repeat nor skip when rows come and go', () => {
  const { g, put } = setup();
  const readable = (s) => s.ref.id !== 'e';
  const q = (o) => g.query(o, undefined, readable);
  assert.deepEqual(ids(q({ type: 'Thread', sort: [{ by: 'updatedAt', dir: 'desc' }] }).items), ['d', 'a', 'c', 'b'], 'what the reader may not read is not there');
  assert.deepEqual(ids(q({ type: 'Thread', text: 'LOGIN' }).items).sort(), ['a', 'c']);
  assert.deepEqual(ids(q({ type: 'Thread', where: { unread: true } }).items), ['c']);
  const p1 = q({ type: 'Thread', sort: [{ by: 'updatedAt' }], limit: 2 });
  assert.deepEqual([ids(p1.items), typeof p1.next], [['b', 'c'], 'string']);
  put('f', 'Early', { updatedAt: 5 });   // comes before the page: the next page does not show it again or lose a row
  const p2 = q({ type: 'Thread', sort: [{ by: 'updatedAt' }], limit: 2, cursor: p1.next });
  assert.deepEqual([ids(p2.items), typeof p2.next], [['a', 'd'], 'undefined']);
  assert.deepEqual(ids(q({ type: 'Thread', sort: [{ by: 'goal' }, { by: 'title' }] }).items), ['f', 'a', 'c', 'b', 'd'], 'absent everywhere: then by title');
  for (const [bad, re] of [[{}, /type/], [{ type: 'Nope' }, /unknown type/], [{ type: 'Thread', limit: 0 }, /limit/], [{ type: 'Thread', sort: [{ by: 'title', dir: 'up' }] }, /sort/],
    [{ type: 'Thread', cursor: 'xyz' }, /cursor/], [{ type: 'Thread', page: 2 }, /page is not a field/]]) assert.throws(() => q(bad), (e) => e.code === 'Invalid' && re.test(e.message));
});

test('search: titles (those that start with the text first), then subtitles, then a provider\'s content matches, only for a reader of that content', async () => {
  const asked = [];
  const { g } = setup(async (text, o) => { asked.push([text, o.limit]); return [{ ref: threadRef('b'), content: 'Message', snippet: '…ship the login fix…' }, { ref: threadRef('a'), content: 'Message', snippet: 'x' }, { ref: threadRef('zz'), content: 'Message' }]; });
  const all = await g.search('login', {}, { readable: () => true, readsContent: () => true });
  assert.deepEqual(all.map((r) => [r.ref.id, r.field, r.snippet ?? null]), [['c', 'title', null], ['a', 'title', null], ['b', 'content', '…ship the login fix…']],
    'a title that starts with it first; a chat found twice once; one not resident left out');
  assert.deepEqual(asked, [['login', 20]]);
  const titlesOnly = await g.search('login', {}, { readable: () => true, readsContent: () => false });
  assert.deepEqual(titlesOnly.map((r) => r.ref.id), ['c', 'a'], 'without the content grant no content match, not even that there was one');
  assert.equal(asked.length, 1, 'nor was the provider\'s content search asked (what it finds is put in the graph)');
  assert.deepEqual((await g.search('login', { limit: 1 }, {})).map((r) => r.ref.id), ['c']);
  await assert.rejects(g.search('login', { types: ['Turn'] }, {}), /not searchable/);
  await assert.rejects(g.search('', {}, {}), /text/);
});

test('subscribe with event: only those changes, each saying which, and no snapshot', () => {
  const { g, p, put } = setup();
  const got = [];
  const v = g.subscribe({ type: 'Thread', where: { unread: true }, event: ['entered', 'left'] }, (m) => { got.push([m.type, m.on ?? null, m.event?.ref?.id ?? null]); });
  assert.deepEqual(got, [], 'no snapshot');
  p.update(threadRef('a'), { state: { unread: true } });
  p.update(threadRef('a'), { state: { title: 'Fix it' } });
  p.update(threadRef('c'), { state: { unread: false } });
  put('g', 'New', { unread: true });
  assert.deepEqual(got, [['delta', 'entered', 'a'], ['delta', 'left', 'c'], ['delta', 'entered', 'g']], 'a change inside it is not asked for');
  v.dispose();
  assert.throws(() => g.subscribe({ type: 'Thread', event: [] }, () => {}), /event/);
  const named = [];
  const w = g.subscribe({ ref: threadRef('a'), event: 'changed' }, (m) => named.push(m.on));
  p.update(threadRef('a'), { state: { title: 'Again' } });
  assert.deepEqual(named, ['changed']);
  w.dispose();
});

test('a page\'s cursor is always one the query takes back, whatever its sort reads', () => {
  const { g, put } = setup();
  put('long', '\u0000'.repeat(5000));   // each escaped to six characters in the cursor's JSON
  const p1 = g.query({ type: 'Thread', sort: [{ by: 'title' }, { by: 'title' }, { by: 'title' }, { by: 'title' }], limit: 1 }, undefined, () => true);
  assert.equal(typeof p1.next, 'string');
  assert.doesNotThrow(() => g.query({ type: 'Thread', sort: [{ by: 'title' }, { by: 'title' }, { by: 'title' }, { by: 'title' }], limit: 1, cursor: p1.next }, undefined, () => true));
});
