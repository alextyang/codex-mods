// ui.dock (docs/design/public-hooks.md §3.14): a badge that counts the instances a where keeps, kept current, or shows a value; added to
// the app's own count; given back when let go; the Dock's attention. The DockBadge's own operations: windows provider and dock.cjs tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';

const DOCK = { type: 'DockBadge', provider: 'codexmods.windows', id: 'desktop:1:1' };
const ref = (id) => ({ type: 'CodexThread', provider: 'codex', id });

function setup() {
  const calls = [], views = [];
  const graph = {
    list: async (type) => (type === 'DockBadge' ? [{ ref: DOCK }] : []),
    invoke: async (r, op, args) => { calls.push([op, args[0]]); return { status: 'done', value: null }; },
    subscribe: (query, fn) => { const v = { query, fn, disposed: false, dispose() { v.disposed = true; } }; views.push(v); return v; },
  };
  const { api, disposeAll } = createRuleApi({ modId: 'unit.dock', realm: 'host', channel: {}, graph: () => graph });
  return { api, disposeAll, calls, views, graph };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

test('ui.dock.badge: a count of what a where keeps, kept current (none gives it back); added to the app\'s own; a value; update; dispose', async () => {
  const t = setup();
  const h = t.api.dock.badge({ id: 'waiting', count: { type: 'Thread', where: { status: 'waiting' } } });
  assert.deepEqual(t.views[0].query, { type: 'Thread', where: { status: 'waiting' } });
  t.views[0].fn({ type: 'snapshot', items: [{ ref: ref('a') }, { ref: ref('b') }] });
  await settle();
  t.views[0].fn({ type: 'delta', event: { kind: 'added', ref: ref('c') } });
  t.views[0].fn({ type: 'delta', event: { kind: 'changed', ref: ref('a') } });
  await settle();
  t.views[0].fn({ type: 'delta', event: { kind: 'removed', ref: ref('a') } });
  t.views[0].fn({ type: 'delta', event: { kind: 'removed', ref: ref('b') } });
  t.views[0].fn({ type: 'delta', event: { kind: 'removed', ref: ref('c') } });
  await settle();
  assert.deepEqual(t.calls, [['_set', 2], ['_set', 3], ['_set', 2], ['_set', 1], ['_set', null]], 'each count once (a change inside it is none); none left: the badge is given back');
  await h.update({ combine: 'add' });
  t.views[1].fn({ type: 'snapshot', items: [{ ref: ref('a') }] });
  await settle();
  assert.deepEqual(t.calls.at(-1), ['_set', { add: 1 }]);
  assert.equal(t.views[0].disposed, true, 'the view it had went');
  await h.update({ value: 'NEW', combine: 'replace' });
  await settle();
  assert.deepEqual(t.calls.at(-1), ['_set', 'NEW']);
  assert.throws(() => t.api.dock.badge({ id: 'waiting', value: 1 }), { code: 'Conflict' });
  await h.dispose();
  assert.deepEqual(t.calls.at(-1), ['_set', null]);
  for (const bad of [{ id: 'x' }, { id: 'x', value: 1, count: { type: 'Thread' } }, { id: 'x', value: -1 }, { id: 'x', value: 'text', combine: 'add' }, { id: 'x', count: { where: {} } }, { id: 'x', value: 1, combine: 'max' }]) {
    assert.throws(() => t.api.dock.badge(bad), { code: 'Invalid' });
  }
});

test('ui.dock.attention bounces the Dock (informational by default); a badge goes with the mod', async () => {
  const t = setup();
  await t.api.dock.attention();
  await t.api.dock.attention('critical');
  t.api.dock.badge({ id: 'b', value: 4 });
  await settle();
  t.disposeAll();
  await settle();
  assert.deepEqual(t.calls, [['_attention', 'informational'], ['_attention', 'critical'], ['_set', 4], ['_set', null]]);
});

test('each of a mod\'s Dock badges is its own holder (by its id): letting one go never lets go another', async () => {
  const t = setup();
  const keys = [];
  const inv = t.graph.invoke;
  t.graph.invoke = async (r, op, args) => { keys.push([op, args[0], args[1]]); return inv(r, op, args); };
  const a = t.api.dock.badge({ id: 'a', value: 1 });
  const b = t.api.dock.badge({ id: 'b', value: 2 });
  await settle();
  await b.dispose();
  await a.dispose();
  await settle();
  assert.deepEqual(keys, [['_set', 1, 'a'], ['_set', 2, 'b'], ['_set', null, 'b'], ['_set', null, 'a']]);
});
