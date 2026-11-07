import test from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../bus.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';

const tick = () => new Promise((r) => setImmediate(r));

test('exact subscription receives only its topic', async () => {
  const bus = createBus({ log: createTestLog() });
  const got = [];
  bus.subscribe('a/b', (d, t) => got.push([t, d]));
  bus.publish('a/b', 1); bus.publish('a/c', 2); bus.publish('a/b/c', 3);
  await tick();
  assert.deepEqual(got, [['a/b', 1]]);
});

test('prefix (*) subscription matches by prefix, including the bare *', async () => {
  const bus = createBus({ log: createTestLog() });
  const a = [], all = [];
  bus.subscribe('mod/x/*', (d, t) => a.push(t));
  bus.subscribe('*', (d, t) => all.push(t));
  bus.publish('mod/x/one', 1); bus.publish('mod/x/', 2); bus.publish('mod/y/one', 3); bus.publish('mod/x', 4);
  await tick();
  assert.deepEqual(a, ['mod/x/one', 'mod/x/']);
  assert.deepEqual(all, ['mod/x/one', 'mod/x/', 'mod/y/one', 'mod/x']);
});

test('a * anywhere but the end is Invalid', () => {
  const bus = createBus({ log: createTestLog() });
  assert.throws(() => bus.subscribe('a/*/b', () => {}), { code: 'Invalid' });
});

test('state topics: state() and replay:state (exact and prefix)', async () => {
  const bus = createBus({ log: createTestLog() });
  bus.publish('framework/compat', { n: 1 }, { state: true });
  bus.publish('framework/compat', { n: 2 }, { state: true });
  bus.publish('framework/other', { z: 1 }, { state: true });
  bus.publish('framework/event', 'not state');
  assert.deepEqual(bus.state('framework/compat'), { n: 2 });
  assert.equal(bus.state('framework/event'), undefined);
  const exact = [], prefix = [], none = [];
  bus.subscribe('framework/compat', (d) => exact.push(d), { replay: 'state' });
  bus.subscribe('framework/*', (d, t) => prefix.push(t), { replay: 'state' });
  bus.subscribe('framework/compat', (d) => none.push(d));
  await tick();
  assert.deepEqual(exact, [{ n: 2 }]);
  assert.deepEqual(prefix.sort(), ['framework/compat', 'framework/other']);
  assert.deepEqual(none, []);
  bus.publish('framework/compat', { n: 3 }, { state: true });
  await tick();
  assert.deepEqual(exact, [{ n: 2 }, { n: 3 }]);
});

test('state values are isolated from later mutation by the publisher', () => {
  const bus = createBus({ log: createTestLog() });
  const v = { a: { b: 1 } };
  bus.publish('s', v, { state: true });
  v.a.b = 2;
  assert.equal(bus.state('s').a.b, 1);
});

test('bounded per-subscriber queue: overflow yields one Gap; other subscribers are unaffected', async () => {
  const bus = createBus({ log: createTestLog() });
  const slow = [], fast = [];
  bus.subscribe('t', (d) => slow.push(d), { queue: 3 });
  bus.subscribe('t', (d) => fast.push(d));
  for (let i = 1; i <= 10; i++) bus.publish('t', i); // synchronous burst: nothing drains until we yield
  await tick();
  assert.deepEqual(slow, [1, 2, 3, { gap: { from: 4, to: 10, reason: 'overflow' } }]);
  assert.equal(fast.length, 10);
  bus.publish('t', 11); await tick();
  assert.equal(slow.at(-1), 11);
});

test('default queue is 1000', async () => {
  const bus = createBus({ log: createTestLog() });
  const got = [];
  bus.subscribe('t', (d) => got.push(d));
  for (let i = 1; i <= 1005; i++) bus.publish('t', i);
  await tick();
  assert.equal(got.length, 1001);
  assert.deepEqual(got.at(-1), { gap: { from: 1001, to: 1005, reason: 'overflow' } });
});

test('dispose stops delivery; a throwing subscriber does not break others', async () => {
  const log = createTestLog();
  const bus = createBus({ log });
  const got = [];
  const d = bus.subscribe('t', (x) => got.push(x));
  bus.subscribe('t', () => { throw new Error('boom'); });
  bus.publish('t', 1); await tick();
  d.dispose(); d.dispose();
  bus.publish('t', 2); await tick();
  assert.deepEqual(got, [1]);
  assert.ok(log.entries.some((e) => e.level === 'warn'));
});

test('dispatch does not touch non-matching subscribers (cost follows matches, not subscriber count)', async () => {
  const bus = createBus({ log: createTestLog() });
  let touched = 0;
  for (let i = 0; i < 20000; i++) bus.subscribe(`other/${i}`, () => { touched++; });
  for (let i = 0; i < 2000; i++) bus.subscribe(`pre${i}/*`, () => { touched++; });
  let hit = 0;
  bus.subscribe('hot/topic', () => { hit++; }, { queue: 100000 });
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) bus.publish('hot/topic', i);
  await tick();
  const ms = performance.now() - t0;
  assert.equal(touched, 0);
  assert.equal(hit, 20000);
  // Cost must not scale with the 22000 unrelated subscribers: compare with a bus that has none (same machine, same load).
  const bare = createBus({ log: createTestLog() });
  bare.subscribe('hot/topic', () => {}, { queue: 100000 });
  const b0 = performance.now();
  for (let i = 0; i < 20000; i++) bare.publish('hot/topic', i);
  await tick();
  const baseline = Math.max(performance.now() - b0, 5);
  assert.ok(ms < baseline * 20 + 2000, `with 22000 unrelated subscribers: ${ms}ms, without: ${baseline}ms`);
});
