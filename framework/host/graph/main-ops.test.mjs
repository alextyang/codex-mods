// The Host's channel to framework-main's feature areas (main-ops.mjs): an operation goes out as `area-op` and settles with its
// `area-op-done`; reports reach their area's listeners only; without framework-main, or once disposed, operations are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainOps } from './main-ops.mjs';

const quiet = { warn() {} };

test('an operation is sent with its area and settles with its answer; reports reach their area only', async () => {
  const sent = [];
  const ops = createMainOps({ send: (m) => sent.push(m), log: quiet });
  const p = ops.op('threads', 'pin', { threadId: 't1' });
  assert.deepEqual({ ...sent[0], requestId: 'x' }, { type: 'area-op', area: 'threads', requestId: 'x', op: 'pin', args: { threadId: 't1' } });
  ops.settle({ type: 'area-op-done', requestId: sent[0].requestId, ok: true, result: { pinned: true } });
  assert.deepEqual(await p, { ok: true, result: { pinned: true } });
  const q = ops.op('threads', 'pin', {});
  ops.settle({ type: 'area-op-done', requestId: sent[1].requestId, ok: false, refused: true, error: 'no thread' });
  assert.deepEqual(await q, { ok: false, error: 'no thread', refused: true });
  const seen = [];
  const sub = ops.onReport('skills', (r) => seen.push(r));
  ops.report({ type: 'area-report', area: 'skills', report: { n: 1 } });
  ops.report({ type: 'area-report', area: 'threads', report: { n: 2 } });
  sub.dispose();
  ops.report({ type: 'area-report', area: 'skills', report: { n: 3 } });
  assert.deepEqual(seen, [{ n: 1 }]);
  ops.dispose();
});

test('refused without framework-main, without an area or an operation, after a timeout (not refused: it may have run) and once disposed', async () => {
  assert.equal((await createMainOps({ log: quiet }).op('threads', 'pin')).refused, true);
  const ops = createMainOps({ send: () => {}, log: quiet, timeoutMs: 20 });
  assert.equal((await ops.op('', 'pin')).refused, true);
  assert.equal((await ops.op('threads', '')).refused, true);
  assert.deepEqual(await ops.op('threads', 'pin'), { ok: false, error: 'framework-main did not answer in 20 ms', refused: false });
  const pending = ops.op('threads', 'pin');
  ops.dispose();
  assert.equal((await pending).refused, true);
  assert.equal((await ops.op('threads', 'pin')).refused, true);
});
