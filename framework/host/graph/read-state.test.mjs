// The Host's copy of the app's read state (read-state.mjs): what it holds, who changed it, and why an echo never loops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadState } from './read-state.mjs';

function make(o = {}) {
  const sent = [], changes = [], warns = [];
  const rs = createReadState({ send: (m) => sent.push(m), log: { warn: (m) => warns.push(m) }, epoch: 'e1', ...o });
  rs.onChange((c) => changes.push(c));
  return { rs, sent, changes, warns, report: (unread, extra = {}) => rs.apply({ type: 'read-state', available: true, unread, ...extra }) };
}

test('it starts empty and unavailable; a set while unavailable is still a write, on top of what the app will say', () => {
  const { rs, sent, changes } = make();
  assert.equal(rs.available, false);
  assert.deepEqual(rs.ids(), []);
  assert.equal(rs.set('t1', true), true);
  assert.deepEqual(sent, [{ type: 'read-state-set', id: 'e1-1', threadId: 't1', unread: true, epoch: null }]);
  assert.equal(rs.has('t1'), true);
  assert.deepEqual(changes, [{ threadId: 't1', unread: true, origin: 'framework' }]);
  assert.deepEqual(rs.pending, [{ id: 'e1-1', threadId: 't1', unread: true, epoch: null }]);
});

test('a write carries the account epoch the store last heard; a dropped one reverts as a sync; another account\'s report drops the old writes (R3)', () => {
  const { rs, sent, changes, report } = make();
  report(['a'], { reset: true, epoch: 'acct1' });
  rs.set('b', true);
  assert.equal(sent.at(-1).epoch, 'acct1');
  changes.length = 0;
  // framework-main gave up on it (refused, failed): it stops counting at once, and the view says what the app has.
  report(['a'], { epoch: 'acct1', dropped: [sent.at(-1).id] });
  assert.deepEqual(rs.pending, []);
  assert.deepEqual(changes, [{ threadId: 'b', unread: false, origin: 'sync' }]);
  // A write made for one account is never applied in another's: the first report of the new account drops it here too.
  rs.set('c', true);
  changes.length = 0;
  report(['x'], { reset: true, epoch: 'acct2' });
  assert.deepEqual(rs.pending, [], 'the old account\'s write went');
  assert.deepEqual(rs.ids(), ['x']);
  assert.ok(changes.every((c) => c.origin === 'sync'));
  rs.set('y', true);
  assert.equal(sent.at(-1).epoch, 'acct2');
  report(['x', 'y'], { epoch: 'acct2', ack: sent.at(-1).id });
  assert.deepEqual(rs.pending, [], 'an ack means applied');
});

test('the first report of a session is a sync; later differences are the app\'s', () => {
  const { rs, changes, report } = make();
  report(['b', 'a'], { reset: true });
  assert.equal(rs.available, true);
  assert.deepEqual(rs.ids(), ['a', 'b']);
  assert.deepEqual(changes, [{ threadId: 'a', unread: true, origin: 'sync' }, { threadId: 'b', unread: true, origin: 'sync' }]);
  changes.length = 0;
  report(['b', 'c']);
  assert.deepEqual(changes, [{ threadId: 'a', unread: false, origin: 'app' }, { threadId: 'c', unread: true, origin: 'app' }], 'in the order of the thread ids');
  changes.length = 0;
  report(['b', 'c']);
  assert.deepEqual(changes, [], 'no difference, no event');
});

test('a report that is not the first but comes after the app was unreachable is a sync too, and an unreachable report keeps what was known', () => {
  const { rs, changes, report } = make();
  const avail = [];
  rs.onAvailability((a) => avail.push(a));
  report(['a'], { reset: true });
  rs.apply({ type: 'read-state', available: false, unread: [] });
  assert.equal(rs.available, false);
  assert.deepEqual(rs.ids(), ['a'], 'kept');
  changes.length = 0;
  report([]);                                                   // reachable again, same account (no reset), and the app has cleared it meanwhile
  assert.deepEqual(changes, [{ threadId: 'a', unread: false, origin: 'sync' }], 'unknown who did it: a sync');
  assert.deepEqual(avail, [true, false, true]);
});

test('set: true when it changed what the store holds, false when it already held that; ids are unique and in order', () => {
  const { rs, sent, report } = make();
  report(['a'], { reset: true });
  assert.equal(rs.set('a', true), false);
  assert.equal(rs.set('b', false), false);
  assert.equal(rs.set('a', false), true);
  assert.equal(rs.set('b', true), true);
  assert.equal(rs.set('b', false), true);
  assert.deepEqual(sent.map((m) => [m.id, m.threadId, m.unread]), [['e1-1', 'a', false], ['e1-2', 'b', true], ['e1-3', 'b', false]]);
  assert.equal(rs.set('', true), false);
  assert.equal(rs.set(5, true), false);
  assert.equal(rs.set('c', 'yes'), false, 'only true is unread');
});

test('our writes stay on top of reports until they are acked: an older report cannot undo one, and is not the app\'s doing', () => {
  const { rs, sent, changes, report } = make();
  report([], { reset: true });
  rs.set('a', true);
  changes.length = 0;
  report([]);                                                   // sent by framework-main before it heard of the write
  assert.equal(rs.has('a'), true);
  assert.deepEqual(changes, []);
  report(['a'], { ack: sent[0].id });                           // the write applied and acked
  assert.equal(rs.has('a'), true);
  assert.deepEqual(rs.pending, []);
  assert.deepEqual(changes, [], 'what we wrote is not news');
  report([]);                                                   // now the user clears it: that IS the app's doing
  assert.deepEqual(changes, [{ threadId: 'a', unread: false, origin: 'app' }]);
});

test('an ack covers every write up to it and no later one; an unknown ack (another Host start) covers nothing', () => {
  const { rs, sent, report } = make();
  report([], { reset: true });
  rs.set('a', true); rs.set('b', true); rs.set('c', true);
  report(['a'], { ack: 'other-9' });
  assert.equal(rs.pending.length, 3);
  report(['a', 'b'], { ack: sent[1].id });
  assert.deepEqual(rs.pending.map((p) => p.threadId), ['c']);
  assert.deepEqual(rs.ids(), ['a', 'b', 'c'], 'c still on top');
});

test('an echo never loops: playing framework-main back changes nothing and sends nothing', () => {
  const { rs, sent, changes, report } = make();
  report(['x'], { reset: true });
  changes.length = 0;
  rs.set('a', true);
  rs.set('x', false);
  const before = sent.length;
  changes.length = 0;
  // framework-main applied both and reported the result, acked, and again (its session echoed our own writes)
  report(['a'], { ack: sent[1].id });
  report(['a'], { ack: sent[1].id });
  assert.deepEqual(changes, []);
  assert.equal(sent.length, before, 'the store sends only what its callers set');
});

test('a write nobody acks within the ttl is forgotten, and its effect reverts as a sync', () => {
  let t = 1000;
  const { rs, changes, report } = make({ now: () => t, pendingTtlMs: 500 });
  report([], { reset: true });
  rs.set('a', true);
  changes.length = 0;
  t = 1400;
  report([]);
  assert.equal(rs.has('a'), true, 'not yet');
  t = 1600;
  report([]);
  assert.equal(rs.has('a'), false);
  assert.deepEqual(changes, [{ threadId: 'a', unread: false, origin: 'sync' }]);
});

test('malformed reports are ignored; a listener that throws does not stop the others or the store', () => {
  const { rs, warns, changes, report } = make();
  rs.onChange(() => { throw new Error('listener blew up'); });
  rs.apply(null); rs.apply('x'); rs.apply({});
  assert.equal(rs.available, false);
  report([1, null, '', 'ok', {}], { reset: true });
  assert.deepEqual(rs.ids(), ['ok']);
  assert.equal(changes.length, 1);
  assert.ok(warns.length >= 1);
  assert.doesNotThrow(() => rs.set('z', true));
});

test('a send that throws is logged and does not undo the write; dispose silences everything', () => {
  const warns = [];
  const rs = createReadState({ send: () => { throw new Error('no Host'); }, log: { warn: (m) => warns.push(m) } });
  assert.equal(rs.set('a', true), true);
  assert.equal(rs.has('a'), true);
  assert.ok(warns.some((m) => /could not be sent/.test(m)));
  const seen = [];
  rs.onChange((c) => seen.push(c));
  rs.dispose();
  assert.equal(rs.set('b', true), false);
  rs.apply({ available: true, unread: ['q'] });
  assert.deepEqual(seen, []);
  assert.equal(rs.has('q'), false);
});

test('ids differ between Host starts (the default epoch is random)', () => {
  const sa = [], sb = [];
  createReadState({ send: (m) => sa.push(m.id) }).set('t', true);
  createReadState({ send: (m) => sb.push(m.id) }).set('t', true);
  assert.notEqual(sa[0], sb[0]);
});
