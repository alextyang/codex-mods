// framework-main's approval prompts (approvals.cjs; runtime-core.md R17): the Host's request becomes the native dialog, the user's choice
// goes back, a prompt the Host closes gets no answer, and without the dialog every request is answered no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApprovalPrompts, register } = require('./approvals.cjs');

function dialog() {
  const shown = [];
  return { shown, askUser: (opts) => new Promise((resolve) => { shown.push({ opts, resolve }); opts.signal?.addEventListener('abort', () => resolve({ allowed: false, checked: false })); }) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a request is shown with its text and the user\'s choice goes back', async () => {
  const d = dialog(), sent = [];
  const p = createApprovalPrompts({ askUser: d.askUser, send: (m) => sent.push(m) });
  p.ask({ type: 'approval-ask', requestId: 'r1', message: 'M'.repeat(500), detail: 'D', checkbox: 'C' });
  p.ask({ type: 'approval-ask', requestId: 'r1', message: 'again' });
  await tick();
  assert.equal(d.shown.length, 1, 'one dialog per request id');
  assert.deepEqual([d.shown[0].opts.message.length, d.shown[0].opts.detail, d.shown[0].opts.checkboxLabel], [400, 'D', 'C']);
  d.shown[0].resolve({ allowed: true, checked: false });
  await tick();
  assert.deepEqual(sent, [{ type: 'approval-answer', requestId: 'r1', approved: true, stopAsking: false }]);
  assert.equal(p.open(), 0);
});

test('a prompt the Host closes is closed unanswered; a broken dialog or none answers no', async () => {
  const d = dialog(), sent = [];
  const p = createApprovalPrompts({ askUser: d.askUser, send: (m) => sent.push(m) });
  p.ask({ requestId: 'r2', message: 'm' });
  await tick();
  p.close({ requestId: 'r2' });
  await tick();
  assert.deepEqual(sent, [], 'no answer for a prompt the Host closed');
  const broken = createApprovalPrompts({ askUser: async () => { throw new Error('no window'); }, send: (m) => sent.push(m), log: { info() {} } });
  await broken.ask({ requestId: 'r3', message: 'm' });
  const none = createApprovalPrompts({ send: (m) => sent.push(m) });
  await none.ask({ requestId: 'r4', message: 'm' });
  await none.ask({ requestId: 'r5', message: '' });
  await none.ask({ message: 'no id' });
  assert.deepEqual(sent.map((m) => [m.requestId, m.approved]), [['r3', false], ['r4', false], ['r5', false]]);
});

test('register wires the Host messages to the adapter\'s dialog', async () => {
  const handlers = new Map(), sent = [], d = dialog();
  register({ electron: { askUser: d.askUser }, sendToHost: (m) => sent.push(m), log: { info() {}, error() {} }, onHostMessage: (t, fn) => handlers.set(t, fn) });
  assert.deepEqual([...handlers.keys()].sort(), ['approval-ask', 'approval-close']);
  handlers.get('approval-ask')({ requestId: 'r', message: 'm' });
  await tick();
  d.shown[0].resolve({ allowed: false, checked: true });
  await tick();
  assert.deepEqual(sent, [{ type: 'approval-answer', requestId: 'r', approved: false, stopAsking: true }]);
});
