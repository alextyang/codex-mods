// A window's report of its Mods pages (docs/design/systems.md "The recovery entry", E6.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesStatus, PAGE_PARTS, PAGES_GRACE_MS } from '../pages-status.mjs';

const manual = () => { const due = []; return { schedule: (fn, ms) => due.push({ fn, ms }), fire: () => { for (const d of due.splice(0)) d.fn(); }, due }; };

test('starting until every part has happened, then running, which holds; a listener hears each change', () => {
  const clock = manual();
  const s = createPagesStatus({ schedule: clock.schedule });
  const heard = [];
  s.subscribe((st) => heard.push(st));
  assert.deepEqual(PAGE_PARTS, ['routes', 'nav', 'read']);
  assert.equal(clock.due[0].ms, PAGES_GRACE_MS);
  s.mounted('routes'); s.mounted('read'); s.mounted('unknown');
  assert.equal(s.get(), 'starting');
  assert.deepEqual([s.has('routes'), s.has('read'), s.has('nav'), s.has('unknown')], [true, true, false, false], 'what has happened (E6.4)');
  s.mounted('nav');
  assert.equal(s.get(), 'running');
  assert.equal(s.has('nav'), true);
  clock.fire();
  s.missing('later');
  assert.equal(s.get(), 'running', 'the grace and a later missing do not undo running');
  assert.deepEqual(heard, ['running']);
});

test('missing after the grace, or when told they cannot start; running from missing; failed holds until a reload', () => {
  const clock = manual();
  const s = createPagesStatus({ schedule: clock.schedule });
  clock.fire();
  assert.equal(s.get(), 'missing');
  for (const p of PAGE_PARTS) s.mounted(p);
  assert.equal(s.get(), 'running', 'pages that come late still run');
  s.failed(new Error('a fault'));
  assert.equal(s.get(), 'failed');
  assert.match(s.why(), /a fault/);
  for (const p of PAGE_PARTS) s.mounted(p);
  s.missing('x');
  assert.equal(s.get(), 'failed');

  const t = createPagesStatus({ schedule: () => {} });
  t.missing('this build lacks routes');
  assert.equal(t.get(), 'missing');
  assert.equal(t.why(), 'this build lacks routes');
  const sub = t.subscribe(() => { throw new Error('a listener\'s own fault'); });
  t.failed('the types could not be read');
  assert.equal(t.get(), 'failed', 'a throwing listener does not stop the report');
  sub.dispose();
});

test('E6 review: when the page runtime starts again (a Host restart), the pages start again: failed is undone, their parts reported anew', () => {
  const clock = manual();
  const s = createPagesStatus({ schedule: clock.schedule });
  for (const p of PAGE_PARTS) s.mounted(p);
  s.failed('the page runtime stopped: its Host channel closed');
  assert.equal(s.get(), 'failed');
  const heard = [];
  s.subscribe((st) => heard.push(st));
  s.reset();
  assert.equal(s.get(), 'starting');
  assert.equal(s.has('routes'), false, 'its parts are reported anew');
  for (const p of PAGE_PARTS) s.mounted(p);
  assert.equal(s.get(), 'running');
  assert.deepEqual(heard, ['starting', 'running']);
  const t = createPagesStatus({ schedule: clock.schedule });
  t.failed('x'); t.reset(); clock.fire();
  assert.equal(t.get(), 'missing', 'a new grace after a reset');
});
