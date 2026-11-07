// framework-main's links area (public-hooks.md §3.14, ui.links.route): the app's open-in-browser held while the Host says a route exists,
// asked of the Host and answered as it decides; the Host gone or late: the app's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./links.cjs');

function setup({ waitMs = 200, claimedMs = 300 } = {}) {
  let handler = null, hold = null, hostState = null;
  const reports = [];
  const hooks = {
    onAreaOp(area, fn) { assert.equal(area, 'links'); handler = fn; },
    areaReport: (area, r) => reports.push([area, r]),
    onHostState: (fn) => { hostState = fn; },
    electron: { holdAppMessage: (type, fn) => { assert.equal(type, 'open-in-browser'); hold = fn; } },
  };
  register(hooks, { waitMs, claimedMs });
  const answer = async (open) => handler('answer', { requestId: reports.at(-1)[1].requestId, open });
  return { op: (op, args) => handler(op, args), hold: (msg) => hold(7, msg), reports, answer, hostDown: () => hostState(false) };
}

test('H7lr: no route: the app\'s own at once; a route: the Host is asked, and its answer is what the app gets', async () => {
  const s = setup();
  const msg = { type: 'open-in-browser', url: 'https://x.test/', initiator: 'markdown_link_click', conversationId: 'c1' };
  assert.equal(s.hold(msg), msg, 'nothing to ask');
  assert.deepEqual(await s.op('routes', { active: true }), { holding: true });
  for (const [open, want] of [['app', { ...msg, openTarget: 'in-app-browser' }], ['browser', { ...msg, openTarget: 'external-browser' }], ['none', null], ['handled', null], [null, msg]]) {
    const p = s.hold(msg);
    const { expires, ...said } = s.reports.at(-1)[1];
    assert.deepEqual(said, { event: 'open', requestId: said.requestId, windowId: 7, url: 'https://x.test/', initiator: 'markdown_link_click', conversationId: 'c1', chosen: false });
    assert.ok(expires > Date.now(), 'when it stops waiting');
    await s.answer(open);
    assert.deepEqual(await p, want, String(open));
  }
  // a modifier, a menu's choice or a native protocol: the Host hears the user chose
  s.hold({ ...msg, clickModifiers: 'primary' });
  assert.equal(s.reports.at(-1)[1].chosen, true);
  await s.answer(null);
});

test('H7lr: no answer in time, or the Host gone: the app\'s own; a late answer finds nothing; routes gone: no hold', async () => {
  const s = setup({ waitMs: 20 });
  await s.op('routes', { active: true });
  const msg = { type: 'open-in-browser', url: 'https://late.test/' };
  assert.equal(await s.hold(msg), msg);
  assert.deepEqual(await s.answer('none'), { late: true });
  const p = s.hold(msg);
  s.hostDown();
  assert.equal(await p, msg);
  assert.equal(s.hold(msg), msg, 'the Host gone: nothing held until it says so again');
  await s.op('routes', { active: true });
  await s.op('routes', { active: false });
  assert.equal(s.hold(msg), msg);
  await assert.rejects(s.op('nope', {}), /unknown operation/);
});

test('H7lr review: a link the Host claimed (a mod\'s run is starting) is never the app\'s as well: not answered in time, or the Host gone, it is not opened; one claimed late is not claimed', async () => {
  const s = setup({ waitMs: 30, claimedMs: 60 });
  await s.op('routes', { active: true });
  const msg = { type: 'open-in-browser', url: 'https://run.test/' };
  const p1 = s.hold(msg);
  assert.deepEqual(await s.op('claim', { requestId: s.reports.at(-1)[1].requestId }), { claimed: true });
  await new Promise((r) => setTimeout(r, 40));   // past the first wait: still held
  assert.equal(await p1, null, 'not answered in time once claimed: not opened');
  const p2 = s.hold(msg);
  await s.op('claim', { requestId: s.reports.at(-1)[1].requestId });
  s.hostDown();
  assert.equal(await p2, null, 'the Host gone after it claimed it');
  await s.op('routes', { active: true });
  const p3 = s.hold(msg);
  const id = s.reports.at(-1)[1].requestId;
  assert.equal(await p3, msg, 'not claimed in time: the app\'s own');
  assert.deepEqual(await s.op('claim', { requestId: id }), { claimed: false });
  // claimed, then the Host says no route ran: the app's own after all
  const p4 = s.hold(msg);
  await s.op('claim', { requestId: s.reports.at(-1)[1].requestId });
  await s.answer(null);
  assert.equal(await p4, msg);
});
