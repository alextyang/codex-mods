// View depth (docs/design/presentations.md V6; contracts/graph.d.ts ViewQuery.depth): a 'full' view (the default) tells the provider's
// onObserve so it can load what the instance needs; a 'core' view of a resident instance follows it as it is and asks nothing (its `loaded`
// settles at once), and one of an instance not resident yet asks the provider for it with the depth (docs/design/systems.md E2). Headless, with a small type of its own so the test does not depend on the native library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../index.mjs';
import { toDescriptor, defineConcept, s, r } from '../../../../sdk/graph/define.mjs';

const Folder = defineConcept('Folder', { state: { name: s.string() }, relations: { docs: r.many('Doc').inverse('folder') } });
const Doc = defineConcept('Doc', { state: { title: s.string() }, relations: { folder: r.one('Folder') } });
const folderRef = (id) => ({ type: 'Folder', provider: 'docs', id });
const docRef = (id) => ({ type: 'Doc', provider: 'docs', id });

/** A graph whose provider `docs` counts what it is asked to observe; `observe` is its onObserve. */
function setup(observe) {
  const g = createGraph();
  g.registerTypes([toDescriptor(Folder), toDescriptor(Doc)], 'mod:docs');
  const asked = [];
  const p = g.registerProvider('mod:docs', 'docs', { types: { Folder: {}, Doc: {} }, onObserve(query) { asked.push(query); return observe?.(query); } });
  p.put(folderRef('f1'), { state: { name: 'Inbox' } });
  p.put(docRef('d1'), { state: { title: 'One' }, links: { folder: folderRef('f1') } });
  return { g, p, asked };
}
const settled = (promise) => Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), 30))]);

test('depth: a full view (the default, or asked for) tells the provider; its loaded waits for what the provider loads', async () => {
  const releases = [];
  const { g, asked } = setup(() => new Promise((resolve) => { releases.push(resolve); }));
  const byDefault = g.subscribe({ ref: folderRef('f1') }, () => {});
  const explicit = g.subscribe({ ref: docRef('d1'), depth: 'full' }, () => {});
  assert.deepEqual(asked.map((q) => q.ref.id), ['f1', 'd1']);
  assert.equal(asked[1].depth, 'full', 'the provider gets the query as it was asked');
  assert.equal(await settled(byDefault.loaded), false, 'loaded waits for onObserve');
  releases.forEach((resolve) => resolve());
  assert.equal(await settled(byDefault.loaded), true);
  assert.equal(await settled(explicit.loaded), true);
});

test('depth: a core view does not call onObserve and its loaded settles at once, even if the provider would never finish loading', async () => {
  const { g, asked } = setup(() => new Promise(() => {}));
  const got = [];
  const view = g.subscribe({ ref: docRef('d1'), depth: 'core' }, (m) => { got.push(m); });
  assert.deepEqual(asked, [], 'nothing asked of the provider');
  assert.equal(await settled(view.loaded), true);
  assert.equal(got[0].type, 'snapshot');
  assert.deepEqual(got[0].items.map((i) => i.state.title), ['One'], 'the resident instance is there');
  const never = g.subscribe({ ref: docRef('d1') }, () => {});
  assert.equal(await settled(never.loaded), false, 'whereas a full view of the same instance is waiting for the provider');
  assert.equal(asked.length, 1);
});

test('depth: a core view of an instance not resident yet asks its provider for it, with the depth, so it loads what the instance itself needs', async () => {
  const { g, p, asked } = setup((query) => { if (query.ref.id === 'd2') p.put(docRef('d2'), { state: { title: 'Two' }, links: { folder: folderRef('f1') } }); });
  const got = [];
  const view = g.subscribe({ ref: docRef('d2'), depth: 'core' }, (m) => got.push(m));
  assert.deepEqual(asked.map((q) => [q.ref.id, q.depth]), [['d2', 'core']]);
  assert.equal(await settled(view.loaded), true);
  assert.equal(g.resolve(docRef('d2')).state.title, 'Two');
  view.dispose();
});

test('depth: a core view is a view like any other: deltas, disposal, and relation views follow the same rule', async () => {
  const { g, p, asked } = setup();
  const one = [], rel1 = [];
  const v = g.subscribe({ ref: docRef('d1'), depth: 'core' }, (m) => { one.push(m); });
  const r = g.subscribe({ ref: folderRef('f1'), relation: 'docs', depth: 'core' }, (m) => { rel1.push(m); });
  p.update(docRef('d1'), { state: { title: 'Two' } });
  assert.deepEqual(one.filter((m) => m.type === 'delta').map((m) => m.event.new), [{ title: 'Two' }]);
  assert.equal(rel1[0].type, 'snapshot');
  assert.deepEqual(rel1[0].items.map((i) => i.ref.id), ['d1']);
  assert.deepEqual(asked, []);
  v.dispose(); r.dispose();
  p.update(docRef('d1'), { state: { title: 'Three' } });
  assert.equal(one.filter((m) => m.type === 'delta').length, 1, 'nothing after dispose');
  g.subscribe({ ref: folderRef('f1'), relation: 'docs' }, () => {});
  assert.equal(asked.length, 1, 'a full relation view does ask');
});

test('depth: a collection view never asks the provider, whatever its depth; a depth other than core or full is Invalid and asks nothing', () => {
  const { g, asked } = setup();
  g.subscribe({ type: 'Doc' }, () => {});
  g.subscribe({ type: 'Doc', depth: 'core' }, () => {});
  assert.deepEqual(asked, []);
  for (const depth of ['deep', '', null, 1, {}]) {
    assert.throws(() => g.subscribe({ ref: docRef('d1'), depth }, () => {}), (e) => e.code === 'Invalid' && /depth/.test(e.message), JSON.stringify(depth));
  }
  assert.deepEqual(asked, [], 'a refused query never reached the provider');
});
