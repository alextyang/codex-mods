// A mod's feed (docs/design/framework-ui.md F9): what ctx.log writes and the framework's own lines, as one feed since the Host started, with a cursor, saying when lines were dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModActivity, activityLineOf, ACTIVITY_LINES } from './mod-activity.mjs';

async function setup(o = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cm-activity-'));
  const activity = createModActivity({ dir, startedAt: Date.parse('2026-11-03T10:00:00.000Z'), ...o });
  const modLog = (lines, file = 'm.log') => writeFile(join(dir, file), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return { dir, activity, modLog, done: async () => { activity.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
const line = (ts, msg, level = 'info', extra = {}) => ({ ts: `2026-11-03T${ts}.000Z`, level, realm: 'host', msg, ...extra });

test('one feed, oldest first, of what the mod logged and what the framework did, since the Host started', async () => {
  const t = await setup();
  try {
    await t.modLog([line('09:59:59', 'before this session'), line('10:00:05', 'logged', 'warn'), line('10:00:06', 'with data', 'info', { data: { a: 1 } })]);
    await t.activity.note('m', 'info', 'Turned on');
    const r = await t.activity.read('m');
    assert.equal(r.since, Date.parse('2026-11-03T10:00:00.000Z'));
    assert.deepEqual(r.lines.map((l) => [l.level, l.message]).slice(0, 2), [['warn', 'logged'], ['info', 'with data {"a":1}']]);
    assert.deepEqual(r.lines.at(-1).message, 'Turned on');
    assert.equal(r.lines.at(-1).realm, 'framework');
    assert.equal(r.dropped, false);
    assert.equal(r.lines.some((l) => l.message === 'before this session'), false, 'the session is the boundary');
    assert.deepEqual(await t.activity.read('other'), { lines: [], cursor: null, dropped: false, since: r.since });
  } finally { await t.done(); }
});

test('a cursor reads only what came after, lines of one millisecond included', async () => {
  const t = await setup();
  try {
    await t.modLog([line('10:00:05', 'a'), line('10:00:05', 'b')]);
    const first = await t.activity.read('m');
    assert.deepEqual(first.lines.map((l) => l.message), ['a', 'b']);
    assert.deepEqual((await t.activity.read('m', { after: first.cursor })).lines, [], 'nothing new');
    await t.modLog([line('10:00:05', 'a'), line('10:00:05', 'b'), line('10:00:05', 'c'), line('10:00:06', 'd')]);
    const next = await t.activity.read('m', { after: first.cursor });
    assert.deepEqual(next.lines.map((l) => l.message), ['c', 'd']);
    assert.equal(next.cursor, '2026-11-03T10:00:06.000Z#0');
    assert.deepEqual((await t.activity.read('m', { after: next.cursor })).lines, []);
    assert.equal((await t.activity.read('m', { after: next.cursor })).cursor, next.cursor, 'nothing new keeps it');
  } finally { await t.done(); }
});

test('a flood of the mod\'s own lines cannot push the framework\'s out; when its own log rotated away lines of this session, the feed says so', async () => {
  const t = await setup();
  try {
    await t.activity.note('m', 'error', 'Stopped: faults');
    const flood = Array.from({ length: ACTIVITY_LINES + 5 }, (_, i) => line(`10:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}`, `spam ${i}`));
    await t.modLog(flood);
    const r = await t.activity.read('m');
    assert.equal(r.lines.length, ACTIVITY_LINES);
    assert.equal(r.dropped, true, 'past the limit of a read');
    assert.equal(r.lines.at(-1).message, 'Stopped: faults', 'the framework\'s line is still there');
    // the rotated file holds only later lines: what came before it in this session is gone
    await t.modLog([line('10:30:00', 'old rotated')], 'm.log.1');
    await t.modLog([line('10:31:00', 'newest')]);
    const s = await t.activity.read('m');
    assert.equal(s.dropped, true);
    assert.deepEqual(s.lines.map((l) => l.message).filter((m) => m !== 'Stopped: faults'), ['old rotated', 'newest']);
    const rotated = await setup();
    try {
      await rotated.modLog([line('09:00:00', 'rotated before the session'), line('10:00:05', 'kept')], 'm.log.1');
      assert.equal((await rotated.activity.read('m')).dropped, false, 'nothing of this session was lost');
    } finally { await rotated.done(); }
  } finally { await t.done(); }
});

test('the framework\'s own file stays small: it rotates, keeping one earlier file', async () => {
  const t = await setup({ maxBytes: 300 });
  try {
    for (let i = 0; i < 12; i++) await t.activity.note('m', 'info', `line ${i} ${'x'.repeat(40)}`);
    const r = await t.activity.read('m');
    assert.ok(r.lines.length < 12 && r.lines.length > 0);
    assert.match(r.lines.at(-1).message, /^line 11 /);
  } finally { await t.done(); }
});

test('the event: at most twice a second per mod, and a write of the mod\'s own counts', async () => {
  const t = await setup();
  try {
    const heard = [];
    t.activity.onChange((id) => heard.push(id));
    t.activity.touch('m'); t.activity.touch('m'); t.activity.touch('n');
    assert.deepEqual(heard, []);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(heard.sort(), ['m', 'n']);
  } finally { await t.done(); }
});

test('an operation as a line of its mod\'s feed', () => {
  const op = (input, more = {}) => ({ input, outcome: 'succeeded', ...more });
  assert.deepEqual(activityLineOf(op({ type: 'enable', modId: 'm' })), ['info', 'Turned on']);
  assert.deepEqual(activityLineOf(op({ type: 'reload', modId: 'm' })), ['info', 'Reloaded']);
  assert.deepEqual(activityLineOf(op({ type: 'update', modId: 'm' }, { result: { version: '2.0.0' } })), ['info', 'Updated to 2.0.0']);
  assert.deepEqual(activityLineOf(op({ type: 'rollback', modId: 'm', toVersion: '1.0.0' })), ['info', 'Rolled back to 1.0.0']);
  assert.deepEqual(activityLineOf(op({ type: 'set-policy', modId: 'm', policy: 'p', on: false })), ['info', 'Policy p turned off']);
  assert.deepEqual(activityLineOf(op({ type: 'enable', modId: 'm' }, { outcome: 'failed', error: { message: 'no' } })), ['error', 'Turned on: failed: no']);
  assert.deepEqual(activityLineOf(op({ type: 'update', modId: 'm' }, { outcome: 'reverted', note: 'it faulted' })), ['warn', 'Updated: reverted: it faulted']);
  assert.equal(activityLineOf(op({ type: 'enable', modId: 'm' }, { outcome: 'running' })), null);
  assert.equal(activityLineOf(op({ type: 'disable', modId: 'm' }, { note: 'Quarantined: faults' })), null, 'a stop has a line of its own');
  assert.equal(activityLineOf(op({ type: 'configure', modId: 'm' })), null);
  assert.equal(activityLineOf(op({ type: 'copy-update' })), null);
});
