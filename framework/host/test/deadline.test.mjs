import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { HOST_STALL_MS, hostDeadline } from '../deadline.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Block the Host's event loop for `ms`, as a long synchronous job inside it would, outside the timers phase (as the census did, in an I/O
 * callback): the loop's next turn runs the late timers before it reads what arrived meanwhile. `during` runs first, inside the stall.
 */
const stallHost = (ms, during = () => {}) => new Promise((resolve) => setImmediate(() => {
  during();
  const until = performance.now() + ms;
  while (performance.now() < until) { /* the Host is busy */ }
  resolve();
}));
/** A reply that arrives as I/O (a worker's message), read only when the loop polls; it stops the deadline, as its callers do. */
function replyChannel(deadline) {
  const { port1, port2 } = new MessageChannel();
  const got = { at: null };
  port2.on('message', () => { got.at = performance.now(); deadline().stop(); });
  return { send: () => port1.postMessage('reply'), got, close: () => { port1.close(); port2.close(); } };
}

test('a deadline expires after its time while the Host is free', async () => {
  const t0 = performance.now();
  let at = null;
  hostDeadline(80, () => { at = performance.now(); });
  await sleep(300);
  assert.ok(at !== null, 'expired');
  assert.ok(at - t0 >= 79 && at - t0 < 250, `expired after ${Math.round(at - t0)} ms`);
});

test('a reply queued while the Host stalled settles before the deadline it overran expires', async () => {
  let expired = false, d = null;
  const ch = replyChannel(() => d);
  try {
    d = hostDeadline(400, () => { expired = true; });
    // The reply arrives early in the stall; the timer is due at 400 ms and fires about 100 ms late (under the stall threshold of 200 ms),
    // before the loop reads the reply.
    await sleep(0);
    await stallHost(500, ch.send);
    await sleep(300);
    assert.ok(ch.got.at !== null, 'the reply was read');
    assert.equal(expired, false, 'the deadline did not expire');
  } finally { ch.close(); }
});

test('a deadline the Host stalled past starts again: the waited-for party gets its time after the stall, once', async () => {
  let at = null;
  const d = hostDeadline(300, () => { at = performance.now(); });
  await stallHost(1200);
  const end = performance.now();
  await sleep(600);
  assert.ok(at !== null, 'expired in the end');
  assert.ok(at - end >= 250, `expired ${Math.round(at - end)} ms after the stall ended (its time starts again)`);
  d.stop();

  // A second stall past the restarted deadline: it does not start again (a Host that stays slow still has its deadlines expire).
  let at2 = null;
  hostDeadline(300, () => { at2 = performance.now(); });
  await stallHost(1200);
  await sleep(50);
  await stallHost(1200);
  const end2 = performance.now();
  await sleep(200);
  assert.ok(at2 !== null && at2 - end2 < 150, `expired right after the second stall (${at2 === null ? 'not yet' : Math.round(at2 - end2)} ms)`);
});

test('pause stops the clock and resume restarts it with the time that was left', async () => {
  const t0 = performance.now();
  let at = null;
  const d = hostDeadline(200, () => { at = performance.now(); });
  await sleep(100);
  d.pause();
  await sleep(400);
  assert.equal(at, null, 'no expiry while paused');
  d.resume();
  await sleep(400);
  assert.ok(at !== null, 'expired after resuming');
  assert.ok(at - t0 >= 580, `expired ${Math.round(at - t0)} ms after the start: about 100 ms before the pause and 100 ms after it`);
  d.stop();
});

test('stop cancels it, also in the turn it waits before expiring', async () => {
  let expired = false;
  const d = hostDeadline(20, () => { expired = true; });
  await sleep(0);
  d.stop();
  await sleep(100);
  assert.equal(expired, false);
  assert.equal(HOST_STALL_MS, 1000);
});
