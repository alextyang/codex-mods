// public-hooks.md §3.9: the user's switch of a mod's automatic actions, as the lifecycle keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { automaticOf, keepAutomatic, sameAction } from '../automatic.mjs';

const withH = (fn, o) => async () => { const H = await harness(o); try { await fn(H); } finally { await H.cleanup(); } };
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });
const ID = 'test.alpha';
const CONTINUE = { id: 'continue', operation: 'Thread.send', why: 'Keeps a chat going', perHour: 30, where: { status: 'idle' } };
const COMPACT = { id: 'compact', operation: 'Thread.compact', why: 'Saves context', perHour: 5 };

test('public hooks H6 (§3.9): set-automatic turns one declared action on as declared, or off; enabling starts with all off; an update keeps one only while declared the same', withH(async (H) => {
  await H.installApprove({ automatic: [CONTINUE, COMPACT] }, { enable: true });
  const rec = () => H.ops.state().mods[ID];
  assert.equal(rec().automatic, undefined, 'every action starts off');
  for (const action of ['continue', 'compact']) assert.equal((await H.run({ type: 'set-automatic', modId: ID, action, on: true })).outcome, 'succeeded');
  assert.deepEqual(rec().automatic, { continue: CONTINUE, compact: COMPACT });
  assert.deepEqual((await H.readState()).mods[ID].automatic.continue, CONTINUE, 'kept on disk');
  assert.deepEqual(automaticOf(rec(), H.ops.installed(ID).manifest).map((a) => [a.id, a.on]), [['continue', true], ['compact', true]]);
  await rejectsCode(H.ops.start({ type: 'set-automatic', modId: ID, action: 'nope', on: true }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-automatic', modId: ID, action: 'Not An Id', on: true }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-automatic', modId: ID, action: 'compact', on: 'yes' }), 'Invalid');
  await H.run({ type: 'set-automatic', modId: ID, action: 'compact', on: false });
  assert.deepEqual(Object.keys(rec().automatic), ['continue']);
  await H.run({ type: 'set-automatic', modId: ID, action: 'compact', on: true });
  // an update that declares `continue` with another rate turns it off; `compact`, declared the same, stays on
  assert.equal((await H.run({ type: 'update', modId: ID, source: await H.pack({ id: ID, version: '1.1.0', automatic: [{ ...CONTINUE, perHour: 60 }, COMPACT] }) })).outcome, 'succeeded');
  assert.deepEqual(rec().automatic, { compact: COMPACT });
  // turned off and on again: all off; none can be turned on while it is off
  await H.run({ type: 'disable', modId: ID });
  assert.deepEqual(automaticOf(rec(), H.ops.installed(ID).manifest).map((a) => a.on), [false, false], 'off while the mod is off');
  await rejectsCode(H.ops.start({ type: 'set-automatic', modId: ID, action: 'compact', on: true }), 'Invalid');
  await H.run({ type: 'enable', modId: ID });
  assert.equal(rec().automatic, undefined);
}));

test('public hooks H6 (§3.9): two declarations are the same whatever their keys\' order; keepAutomatic drops what a version no longer declares', () => {
  assert.equal(sameAction({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  assert.equal(sameAction(CONTINUE, { ...CONTINUE, where: { status: 'running' } }), false);
  assert.equal(sameAction(CONTINUE, undefined), false);
  const r = { automatic: { continue: CONTINUE, compact: COMPACT } };
  keepAutomatic(r, { automatic: [CONTINUE] });
  assert.deepEqual(r.automatic, { continue: CONTINUE });
  keepAutomatic(r, {});
  assert.equal(r.automatic, undefined);
});

test('public hooks H6 (§3.7): set-policy keeps the policies the user turned off, by id, whether or not the mod has them now', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  const rec = () => H.ops.state().mods[ID];
  for (const [policy, on] of [['no-night', false], ['confirm', false], ['no-night', true]]) assert.equal((await H.run({ type: 'set-policy', modId: ID, policy, on })).outcome, 'succeeded');
  assert.deepEqual(rec().policiesOff, ['confirm']);
  assert.deepEqual((await H.readState()).mods[ID].policiesOff, ['confirm'], 'kept on disk');
  await H.run({ type: 'set-policy', modId: ID, policy: 'confirm', on: true });
  assert.equal(rec().policiesOff, undefined);
  await rejectsCode(H.ops.start({ type: 'set-policy', modId: ID, policy: 'Not An Id', on: false }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-policy', modId: 'test.none', policy: 'x', on: false }), 'Invalid');
}));
