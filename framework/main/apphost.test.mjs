// The AppHost hold (apphost.cjs): the hook the adapter's `app-host` seam calls once per window, with fake hosts and senders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installAppHost } = require('./apphost.cjs');

const quiet = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]), error: (m, d) => lines.push(['error', m, d]) }; };
/** A webContents-like sender: an id, `once('destroyed')` and `isDestroyed`. */
function sender(id) {
  const s = { id, destroyed: false, handlers: [], once(ev, fn) { if (ev === 'destroyed') s.handlers.push(fn); }, isDestroyed: () => s.destroyed,
    destroy() { s.destroyed = true; for (const fn of s.handlers.splice(0)) fn(); } };
  return s;
}
const host = (name) => ({ name, services: { threadReadState: {} } });

test('install: the hook extends globalThis.__codexmods, never replaces it, and creates it when absent', () => {
  const g = { __codexmods: { jsx: () => 1, faults: { jsx: 3 } } };
  const jsx = g.__codexmods.jsx;
  const ns = g.__codexmods;
  installAppHost({ log: quiet(), global: g });
  assert.equal(g.__codexmods, ns, 'the same object');
  assert.equal(g.__codexmods.jsx, jsx);
  assert.deepEqual(g.__codexmods.faults, { jsx: 3 });
  assert.equal(typeof g.__codexmods.appHost, 'function');
  const fresh = {};
  installAppHost({ log: quiet(), global: fresh });
  assert.equal(typeof fresh.__codexmods.appHost, 'function');
});

test('a window is held by sender id with its host and view, in the order held; the hook never throws', () => {
  const g = {};
  const hold = installAppHost({ log: quiet(), global: g });
  const a = host('a'), b = host('b'), view = { services: {} };
  const events = [];
  hold.subscribe((e) => events.push([e.type, e.id, e.view]));
  assert.deepEqual(hold.windows(), []);
  assert.equal(hold.first(), null);
  assert.equal(g.__codexmods.appHost(a, sender(7), view), undefined);
  g.__codexmods.appHost(b, sender(9));                              // a pack sealed before the seam passed the view
  assert.deepEqual(hold.windows(), [{ id: 7, host: a, view }, { id: 9, host: b, view: null }]);
  assert.deepEqual(hold.first(), { id: 7, host: a, view });
  assert.deepEqual([hold.senderOf(9).id, hold.senderOf(8)], [9, null], 'a held window\'s web contents');
  assert.deepEqual(events, [['added', 7, view], ['added', 9, null]]);
  const stub = () => {};                                             // a Cap'n Web stub is a callable proxy
  g.__codexmods.appHost(host('c'), sender(11), stub);
  assert.equal(hold.windows().at(-1).view, stub);
});

test('a destroyed sender drops its window; a window that was reloaded (same sender id, new host) is replaced, and the old sender\'s late destroy does not drop the new one', () => {
  const g = {};
  const hold = installAppHost({ log: quiet(), global: g });
  const events = [];
  hold.subscribe((e) => events.push([e.type, e.id, e.host.name]));
  const s1 = sender(7), s2 = sender(7), other = sender(9);
  g.__codexmods.appHost(host('first'), s1);
  g.__codexmods.appHost(host('other'), other);
  g.__codexmods.appHost(host('reloaded'), s2);
  assert.deepEqual(hold.windows().map((w) => [w.id, w.host.name]), [[9, 'other'], [7, 'reloaded']]);
  s1.destroy();                                                    // the old page's sender goes away late
  assert.deepEqual(hold.windows().map((w) => w.id), [9, 7], 'the new host is kept');
  s2.destroy();
  assert.deepEqual(hold.windows().map((w) => w.id), [9]);
  other.destroy(); other.destroy();
  assert.deepEqual(hold.windows(), []);
  assert.deepEqual(events, [
    ['added', 7, 'first'], ['added', 9, 'other'], ['removed', 7, 'first'], ['added', 7, 'reloaded'], ['removed', 7, 'reloaded'], ['removed', 9, 'other'],
  ]);
});

test('a window without a host, without a usable sender, or already destroyed is not held; the missing host is logged once', () => {
  const g = {};
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  g.__codexmods.appHost(undefined, sender(1));
  g.__codexmods.appHost(null, sender(2));
  g.__codexmods.appHost(host('x'), undefined);
  g.__codexmods.appHost(host('x'), {});
  const dead = sender(3); dead.destroyed = true;
  g.__codexmods.appHost(host('x'), dead);
  assert.deepEqual(hold.windows(), []);
  assert.equal(log.lines.filter((l) => /without an AppHost/.test(l[1])).length, 1);
});

test('a listener that throws does not stop the others or the hold; unsubscribe stops one', () => {
  const g = {};
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  const seen = [];
  hold.subscribe(() => { throw new Error('listener blew up'); });
  const sub = hold.subscribe((e) => seen.push(e.type));
  g.__codexmods.appHost(host('a'), sender(1));
  sub.dispose();
  g.__codexmods.appHost(host('b'), sender(2));
  assert.deepEqual(seen, ['added']);
  assert.equal(hold.windows().length, 2);
  assert.ok(log.lines.some((l) => /listener failed/.test(l[1])));
});

test('a hook installed before is still called (first), and its failure is logged without stopping the hold', () => {
  const calls = [];
  const g = { __codexmods: { appHost: (h, s, v) => { calls.push([h.name, s.id, v]); throw new Error('earlier hook'); } } };
  const log = quiet();
  const hold = installAppHost({ log, global: g });
  g.__codexmods.appHost(host('a'), sender(5), 'view');
  assert.deepEqual(calls, [['a', 5, 'view']]);
  assert.deepEqual(hold.windows().map((w) => w.id), [5]);
  assert.ok(log.lines.some((l) => /earlier appHost hook failed/.test(l[1])));
});

test('dispose restores the earlier hook (or removes ours) and forgets the windows; later calls hold nothing', () => {
  const earlier = () => {};
  const g = { __codexmods: { appHost: earlier } };
  const hold = installAppHost({ log: quiet(), global: g });
  const ours = g.__codexmods.appHost;
  g.__codexmods.appHost(host('a'), sender(1));
  hold.dispose();
  assert.equal(g.__codexmods.appHost, earlier);
  assert.deepEqual(hold.windows(), []);
  ours(host('b'), sender(2));
  assert.deepEqual(hold.windows(), []);
  const g2 = {};
  installAppHost({ log: quiet(), global: g2 }).dispose();
  assert.equal('appHost' in g2.__codexmods, false);
});

test('a namespace that cannot be extended is logged, not thrown', () => {
  const log = quiet();
  const g = { __codexmods: Object.freeze({}) };
  const hold = installAppHost({ log, global: g });
  assert.deepEqual(hold.windows(), []);
  assert.ok(log.lines.some((l) => /could not be installed/.test(l[1])));
  const sealed = {};
  Object.defineProperty(sealed, '__codexmods', { get() { return undefined; }, set() { throw new Error('read-only'); } });
  assert.doesNotThrow(() => installAppHost({ log, global: sealed }));
});
