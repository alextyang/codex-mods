// framework-main's dock area: the Dock's badge held by mods, the latest holder's first, given back to the app's own count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./dock.cjs');

function setup({ text = true } = {}) {
  const shown = [];
  let handler;
  const badge = { text, hold: (v) => { shown.push(v); return true; } };
  const bounced = [];
  const hooks = { onAreaOp(area, fn) { assert.equal(area, 'dock'); handler = fn; }, electron: { badge: () => badge, attention: (k) => { bounced.push(k); return true; } } };
  register(hooks);
  return { op: (args) => handler('badge', args), shown, handler, bounced };
}

test('E7.6b: the latest holder\'s value shows; letting go gives it to the previous holder, then to the app\'s own count', async () => {
  const s = setup();
  assert.deepEqual(await s.op({ holder: 'unit.a', value: 3 }), { showing: 'held' });
  await s.op({ holder: 'unit.b', value: 'NEW' });
  await s.op({ holder: 'unit.a', value: 5 });   // set again: the latest now
  await s.op({ holder: 'unit.a', value: null });
  assert.deepEqual(await s.op({ holder: 'unit.b', value: null }), { showing: 'app' });
  assert.deepEqual(s.shown, [3, 'NEW', 5, 'NEW', null]);
  await s.op({ holder: 'unit.c', value: { add: 2 } });
  assert.deepEqual(s.shown.at(-1), { add: 2 }, 'a count added to the app\'s own');
  await assert.rejects(s.op({ holder: 'unit.c', value: { add: -1 } }));
  assert.deepEqual(await s.handler('attention', { kind: 'critical' }), {});
  await assert.rejects(s.handler('attention', { kind: 'loud' }), /informational or critical/);
  assert.deepEqual(s.bounced, ['critical']);
});

test('E7.6b: refused before anything shows: no holder, a value that is no badge, text where only a count shows, another operation', async () => {
  const s = setup({ text: false });
  for (const args of [{ value: 1 }, { holder: 'bad holder!', value: 1 }, { holder: 'unit.a', value: -1 }, { holder: 'unit.a', value: 'x'.repeat(17) }, { holder: 'unit.a', value: 'TEXT' }]) {
    await assert.rejects(s.op(args));
  }
  await assert.rejects(s.handler('other', {}), /unknown operation/);
  assert.deepEqual(s.shown, []);
});
