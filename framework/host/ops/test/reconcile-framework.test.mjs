// Operations.reconcileFramework (contracts v1.9): re-run Recovery.reconcileOp for running framework ops, applying verdicts like recover().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withH = (fn) => async () => { const H = await harness(); try { await fn(H); } finally { await H.cleanup(); } };

/** An app-switch left 'running' by a previous process. */
async function leftRunning(H, type = 'app-switch') {
  H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'awaiting swap receipt' });
  const id = await H.ops.start(type === 'app-switch' ? { type, candidate: '/x/y.app' } : { type });
  await H.recorded(H.ops, id, 'awaiting swap receipt');
  return id;
}

test('reconcileFramework applies a non-null verdict (persisted, published, lock released); null leaves the op running', withH(async (H) => {
  const id = await leftRunning(H);
  const ops2 = H.create();                                           // the next process
  const seen = [];
  ops2.subscribe((o) => seen.push(o));
  H.recovery.reconcileImpl = async () => null;
  await ops2.reconcileFramework();
  assert.equal(ops2.get(id).outcome, 'running');
  assert.equal(seen.length, 0, 'nothing to announce for a null verdict');
  H.recovery.reconcileImpl = async () => ({ outcome: 'succeeded', note: 'swap receipt ok', result: { build: 'b2' } });
  await ops2.reconcileFramework();
  const op = ops2.get(id);
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.note, 'swap receipt ok');
  assert.deepEqual(op.result, { build: 'b2' });
  assert.ok(op.endedAt);
  assert.deepEqual(JSON.parse(await readFile(join(H.L.ops, `${id}.json`), 'utf8')), op);        // journaled
  assert.equal(seen.at(-1).outcome, 'succeeded');                                                  // published to subscribers
  assert.equal(H.bus.published.filter((p) => p.topic === 'framework/op' && p.data.id === id && p.data.outcome === 'succeeded').length, 1);
  H.recovery.runOpImpl = async () => ({ outcome: 'succeeded' });
  assert.equal((await H.run({ type: 'app-prepare' }, ops2)).outcome, 'succeeded', 'the framework lock was released');
}));

test('reconcileFramework is idempotent: a settled op is not asked about again', withH(async (H) => {
  const id = await leftRunning(H);
  const ops2 = H.create();
  H.recovery.reconcileImpl = async () => ({ outcome: 'failed', note: 'swap refused' });
  await ops2.reconcileFramework();
  await ops2.reconcileFramework();
  await ops2.recover();
  assert.equal(H.recovery.reconciled.filter((o) => o.id === id).length, 1);
  assert.equal(ops2.get(id).outcome, 'failed');
}));

test('reconcileFramework leaves an op alone while a handler in this process is still executing it', withH(async (H) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  H.recovery.runOpImpl = async () => { await gate; return { outcome: 'succeeded', note: 'done by the handler' }; };
  const id = await H.ops.start({ type: 'app-prepare' });
  while (H.recovery.ran.length === 0) await sleep(5);
  await H.ops.reconcileFramework();
  assert.deepEqual(H.recovery.reconciled, []);
  release();
  assert.equal((await H.ops.whenSettled(id)).note, 'done by the handler');
}));

test('reconcileFramework never overlaps itself', withH(async (H) => {
  await leftRunning(H);
  const ops2 = H.create();
  let active = 0, peak = 0, calls = 0;
  H.recovery.reconcileImpl = async () => { calls++; active++; peak = Math.max(peak, active); await sleep(40); active--; return null; };
  await Promise.all([ops2.reconcileFramework(), ops2.reconcileFramework(), ops2.reconcileFramework()]);
  assert.equal(peak, 1);
  assert.equal(calls, 3, 'serialized, each call really reconciles');
}));

test('reconcileFramework waits for an executing exclusive framework op, but resolves a leftover one from a previous process', withH(async (H) => {
  // executing: lkg-restore blocked in Recovery.runOp
  let release;
  const gate = new Promise((r) => { release = r; });
  H.recovery.runOpImpl = async () => { await gate; return { outcome: 'succeeded' }; };
  const id = await H.ops.start({ type: 'lkg-restore' });
  while (H.recovery.ran.length === 0) await sleep(5);
  let done = false;
  const rec = H.ops.reconcileFramework().then(() => { done = true; });
  await sleep(80);
  assert.equal(done, false, 'must wait for the executing exclusive op');
  release();
  await rec;
  await H.ops.whenSettled(id);
  assert.deepEqual(H.recovery.reconciled, []);
  // leftover: an exclusive op still 'running' from a dead process is exactly what reconciliation resolves
  H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'restoring' });
  const left = await H.ops.start({ type: 'safe-mode', enter: true });
  await H.recorded(H.ops, left, 'restoring');
  const ops2 = H.create();
  H.recovery.reconcileImpl = async () => ({ outcome: 'succeeded' });
  await ops2.reconcileFramework();
  assert.equal(ops2.get(left).outcome, 'succeeded');
  assert.equal((await H.run({ type: 'disable', modId: 'test.nope' }, ops2).catch((e) => e.code)), 'Invalid', 'mod ops are admitted again (reaches validation)');
}));

test('reconcileFramework survives a throwing reconcileOp and keeps the op running', withH(async (H) => {
  const id = await leftRunning(H);
  const ops2 = H.create();
  H.recovery.reconcileImpl = async () => { throw new Error('receipt unreadable'); };
  await ops2.reconcileFramework();
  assert.equal(ops2.get(id).outcome, 'running');
}));
