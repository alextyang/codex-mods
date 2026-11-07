// Mux addition 1, key families (docs/design/runtime-core.md R14): every frame's keys are recorded with their thread and backend; a key's
// owner is its thread's owner; the presented flag is settable for C3. Headless: the real mux and the strict fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until } from './helpers.mjs';
import { keysOf } from '../keys.mjs';

test('A1 1: keysOf reads thread, turn, item, process and watch keys from a frame', () => {
  assert.deepEqual(keysOf({ params: { threadId: 't', turnId: 'u', itemId: 'i', processId: 7 } }).map((k) => [k.family, k.key, k.thread]),
    [['thread', 't', 't'], ['turn', 'u', 't'], ['item', 't:i', 't'], ['process', '7', 't']]);
  assert.deepEqual(keysOf({ result: { thread: { id: 't2' } } }).map((k) => k.family), ['thread']);
  assert.deepEqual(keysOf({ params: { turn: { id: 'u2' }, threadId: 't' } }).map((k) => [k.family, k.key]), [['thread', 't'], ['turn', 'u2']]);
  assert.deepEqual(keysOf({ params: { watchId: 'w' } }).map((k) => [k.family, k.thread]), [['watch', undefined]]);
});

test('A1 2: the mux records a thread\'s turn and item keys with their thread, backend and owner', async () => {
  const h = await harness();
  try {
    await h.up();
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const turn = (await h.app.request(2, 'turn/start', { threadId: t, input: [] })).result.turn.id;
    await h.app.request(3, 'fake/notify', { method: 'item/started', params: { threadId: t, turnId: turn, item: { type: 'agentMessage', id: 'm1', text: '' } } });
    await until(() => h.mux.keyInfo('item', `${t}:m1`), 5000, 'item key');
    const k = h.mux.keyInfo('turn', turn);
    assert.deepEqual([k.thread, k.backend, k.owner], [t, 'primary', 'app:1']);
    assert.equal(h.mux.keyInfo('item', `${t}:m1`).thread, t);
    assert.equal(h.mux.keyInfo('thread', t).owner, 'app:1');
    assert.throws(() => h.mux.keyInfo('nope', 'x'), /unknown key family/);
  } finally { await h.close(); }
});
