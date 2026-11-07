// A mod's Activity (docs/design/framework-ui.md F9): the feed with its cursor, what the `activity` event does, errors alone, Copy log, dropped lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from './fake-react.mjs';
import { pagesFixture, modRef, flush, textOf, at } from './pages-fixture.mjs';
import { createActivityFeed, logText } from '../present/mod-activity-feed.mjs';

const line = (t, level, message) => ({ at: at(`2026-11-03T${t}`), level, realm: 'host', message });

function setup(answers) {
  const queue = [...answers];
  const f = pagesFixture({ invoke: (ref, op) => (op === 'activity' ? { status: 'done', value: queue.shift() ?? { lines: [], cursor: null, dropped: false } } : { status: 'done' }) });
  let listener = null;
  const disposed = [];
  const feed = createActivityFeed({ R: f.React, kit: f.kit, exports: () => f.exports, invoke: f.base.invoke, subscribe: (q, fn) => { listener = fn; return { dispose: () => disposed.push(q) }; } });
  const t = f.mount(() => f.e(feed.ActivityFeed, { mod: modRef('a.one'), name: 'One' }));
  return { ...f, ...t, tell: (m) => listener(m), disposed };
}

test('it reads when shown, and again after its cursor when the event says there is more', async () => {
  const t = setup([{ lines: [line('10:00:00', 'info', 'Turned on')], cursor: 'c1', dropped: false, since: at('2026-11-03T09:59:00') }, { lines: [line('10:01:00', 'warn', 'Careful')], cursor: 'c2', dropped: false }]);
  await flush();
  assert.match(t.text(), /^Activity \/ Since Codex started at 09:59/, 'the session is what it shows');
  assert.match(t.text(), /10:00infoTurned on/);
  t.tell({ type: 'delta', event: { kind: 'changed' } });
  await flush();
  assert.equal(t.calls.length, 1, 'another change of the mod is not new lines');
  t.tell({ type: 'delta', event: { kind: 'event', name: 'activity' } });
  await flush();
  assert.deepEqual(t.calls.map((c) => c[3]), [[{}], [{ after: 'c1' }]]);
  assert.match(t.text(), /10:00infoTurned on10:01warnCareful/);
  t.root.unmount();
  assert.equal(t.disposed.length, 1);
});

test('none yet says so; lines a log lost are said; errors can be shown alone; Copy log waits for lines', async () => {
  const empty = setup([{ lines: [], cursor: null, dropped: false, since: at('2026-11-03T09:59:00') }]);
  await flush();
  assert.match(empty.text(), /No activity yet\./);
  assert.equal(empty.all((n) => n.props?.className === 'cmk-segmented').length, 0, 'no errors: nothing to choose');
  assert.equal(empty.buttonIn(empty.root.tree, 'Copy log').props.disabled, true);
  const t = setup([{ lines: [line('10:00:00', 'info', 'Turned on'), line('10:00:01', 'error', 'It threw')], cursor: 'c', dropped: true }]);
  await flush();
  assert.match(t.text(), /Some earlier lines were dropped\./);
  const errors = t.all((n) => n.props?.className === 'cmk-segment').find((n) => textOf(n) === 'Errors');
  errors.props.onClick();
  assert.doesNotMatch(t.text(), /Turned on/);
  assert.match(t.text(), /It threw/);
  assert.equal(findAll(t.root.tree, (n) => n.props?.['data-level'] === 'error').length, 1);
});

test('Copy log copies the lines shown as text', async () => {
  const had = globalThis.navigator;
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (s) => copied.push(s) } } });
  try {
    const t = setup([{ lines: [line('10:00:00', 'info', 'Turned on'), line('10:00:01', 'error', 'It threw')], cursor: 'c', dropped: false }]);
    await flush();
    await t.buttonIn(t.root.tree, 'Copy log').props.onClick();
    await flush();
    assert.deepEqual(copied, ['10:00  info  Turned on\n10:00  error  It threw']);
    assert.ok(t.buttonIn(t.root.tree, 'Copied'));
    assert.equal(logText([]), '');
  } finally { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: had }); }
});

test('a read that fails leaves what is shown', async () => {
  const f = pagesFixture({ invoke: () => { throw new Error('gone'); } });
  const feed = createActivityFeed({ R: f.React, kit: f.kit, exports: () => f.exports, invoke: f.base.invoke });
  const t = f.mount(() => f.e(feed.ActivityFeed, { mod: modRef('a.one'), name: 'One' }));
  await flush();
  assert.match(t.text(), /No activity yet\./);
});
