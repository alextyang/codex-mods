// The user's approval of a mod's one-time action (approvals.mjs; runtime-core.md R17): one prompt at a time, each call asks, Don't Allow
// with "don't ask again", a timeout and a cancel close it, and nothing can be asked without framework-main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovals } from './approvals.mjs';

function setup(o = {}) {
  const sent = [];
  const a = createApprovals({ send: (m) => sent.push(m), nameOf: (id) => ({ 'mod.a': 'Mod A', 'mod.b': 'Mod B' })[id], ...o });
  const asks = () => sent.filter((m) => m.type === 'approval-ask');
  return { a, sent, asks, answer: (approved, stopAsking) => a.settle({ type: 'approval-answer', requestId: asks().at(-1).requestId, approved, stopAsking }) };
}
const signal = () => { const fns = new Set(); const s = { aborted: false, onAbort(fn) { fns.add(fn); return { dispose: () => fns.delete(fn) }; }, abort() { s.aborted = true; for (const f of fns) f(); } }; return s; };

test('a request shows a prompt that names the mod and the action; the answer settles it; every call asks again', async () => {
  const { a, asks, answer } = setup();
  const p = a.ask({ modId: 'mod.a', operation: 'ExternalApp.setComputerUse', action: 'stop letting Codex use Finder without asking', detail: 'Codex will ask again.' });
  assert.deepEqual(asks().map(({ requestId, ...m }) => m), [{ type: 'approval-ask', message: '“Mod A” wants to stop letting Codex use Finder without asking.', detail: 'Codex will ask again.\n\nAsked by the mod mod.a. Codex Mods asks you each time.', checkbox: 'Don\'t ask again for “Mod A” until Codex restarts' }]);
  answer(true);
  assert.deepEqual(await p, { approved: true });
  const q = a.ask({ modId: 'mod.a', operation: 'ExternalApp.setComputerUse', action: 'x' });
  assert.equal(asks().length, 2, 'no standing approval: the next call asks again');
  answer(false);
  assert.deepEqual(await q, { approved: false, reason: 'the user did not allow it' });
});

test('one prompt at a time, in order; a mod with a request waiting is answered no at once', async () => {
  const { a, asks, sent, answer } = setup();
  const first = a.ask({ modId: 'mod.a', operation: 'X.op', action: 'one' });
  const second = a.ask({ modId: 'mod.b', operation: 'X.op', action: 'two' });
  assert.deepEqual(await a.ask({ modId: 'mod.a', operation: 'X.other', action: 'three' }), { approved: false, reason: 'another request from this mod is waiting for the user' });
  assert.equal(asks().length, 1, 'the second waits');
  assert.deepEqual(a.status(), { shown: { mod: 'mod.a', operation: 'X.op' }, waiting: 1, stopped: 0 });
  answer(false);
  assert.equal((await first).approved, false);
  assert.equal(asks().length, 2);
  assert.match(asks()[1].message, /“Mod B” wants to two/);
  answer(true);
  assert.deepEqual(await second, { approved: true });
  assert.equal(sent.filter((m) => m.type === 'approval-close').length, 0, 'a prompt the user answered is closed already');
});

test('"don\'t ask again" stops that mod\'s requests for that operation; an unknown answer is ignored', async () => {
  const { a, asks, answer } = setup();
  const p = a.ask({ modId: 'mod.a', operation: 'X.op', action: 'one' });
  a.settle({ type: 'approval-answer', requestId: 'nope', approved: true });
  answer(false, true);
  assert.equal((await p).approved, false);
  assert.deepEqual(await a.ask({ modId: 'mod.a', operation: 'X.op', action: 'again' }), { approved: false, reason: 'the user asked not to be asked again' });
  assert.equal(asks().length, 1);
  const other = a.ask({ modId: 'mod.a', operation: 'X.other', action: 'other' });
  assert.equal(asks().length, 2, 'another operation still asks');
  answer(true, true);
  assert.deepEqual(await other, { approved: true }, 'the checkbox counts only with a no');
});

test('a request nobody answers, or whose call is cancelled, closes as not allowed', async () => {
  const { a, sent } = setup({ timeoutMs: 20 });
  assert.deepEqual(await a.ask({ modId: 'mod.a', operation: 'X.op', action: 'one' }), { approved: false, reason: 'nobody answered' });
  const s = signal();
  const p = a.ask({ modId: 'mod.b', operation: 'X.op', action: 'two', signal: s });
  s.abort();
  assert.deepEqual(await p, { approved: false, reason: 'cancelled' });
  assert.equal(sent.filter((m) => m.type === 'approval-close').length, 2, 'each closed the dialog');
  const done = signal(); done.aborted = true;
  assert.equal((await a.ask({ modId: 'mod.a', operation: 'X.op', action: 'x', signal: done })).reason, 'cancelled');
});

test('without framework-main nobody can be asked; dispose answers what waits', async () => {
  assert.deepEqual(await createApprovals({}).ask({ modId: 'mod.a', operation: 'X.op', action: 'x' }), { approved: false, reason: 'the user cannot be asked here' });
  const { a } = setup();
  const p = a.ask({ modId: 'mod.a', operation: 'X.op', action: 'x' });
  const q = a.ask({ modId: 'mod.b', operation: 'X.op', action: 'y' });
  a.dispose();
  assert.deepEqual([await p, await q].map((x) => x.reason), ['the Host is shutting down', 'the Host is shutting down']);
  assert.equal((await a.ask({ modId: 'mod.a', operation: 'X.op', action: 'x' })).approved, false);
});
