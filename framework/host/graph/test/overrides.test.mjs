// Temporary changes of Settings (public-hooks.md §3.14, H7y): asked once, the user's values kept aside on this Mac and put back when the
// override ends, the mod stops, or at the next start after a crash; a change made meanwhile leaves the override.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../index.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const setting = (id) => ({ type: 'Setting', provider: 'codex', id });
const until = (fn, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (fn()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 10); }; tick(); });

/** A graph with the app's Settings (their values in `values`; undefined: none set, the built-in look) and an asker that records. */
function setup({ file, values = { appearanceTheme: 'light', appearanceLightChromeTheme: undefined, sansFontSize: 13 }, approve = true } = {}) {
  const asked = [];
  const graph = createGraph({ overridesFile: file, overridesRetryMs: 20, approvals: { ask: async (q) => { asked.push(q); return approve ? { approved: true } : { approved: false, reason: 'no' }; } } });
  graph.registerTypes(NATIVE, 'native');
  const state = { ...values };
  let p;
  const put = (key) => p.put(setting(key), { state: { title: key, value: state[key] ?? null, default: null, scope: 'app', kind: 'record' },
    links: { section: { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, definedBy: { type: 'App', provider: 'codex', id: 'codex' } } });
  p = graph.registerProvider('native', 'codex', { types: { Setting: { operations: {
    set: { effect: 'external', approval: () => ({ action: 'set it', detail: '' }), handler: ({ ref, args }) => { state[ref.id] = args[0]; put(ref.id); return null; } },
    reset: { effect: 'external', handler: ({ ref }) => { state[ref.id] = undefined; put(ref.id); return null; } },
  } } } });
  for (const k of Object.keys(values)) put(k);
  return { graph, state, asked, put, userSets: (key, v) => { state[key] = v; put(key); } };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-')), 'overrides.json');

test('H7y: an override asks once for all its changes, sets them, and its restore puts the user\'s values back (none: the app\'s own again)', async () => {
  const s = setup({ file: tmp() });
  const out = await s.graph.override('mod:a', { id: 'night', set: [{ ref: setting('appearanceTheme'), value: 'dark' }, { ref: setting('appearanceLightChromeTheme'), value: { accent: '#ff0000' } }] }, { modId: 'a' });
  assert.equal(out.status, 'done', JSON.stringify(out));
  assert.equal(s.asked.length, 1, 'one prompt for all of it');
  assert.match(s.asked[0].action, /2 settings/);
  assert.deepEqual([s.state.appearanceTheme, s.state.appearanceLightChromeTheme], ['dark', { accent: '#ff0000' }]);
  assert.deepEqual(s.graph.overridesOf('mod:a').map((x) => x.id), ['night']);
  assert.deepEqual(s.graph.overrideHolderOf(setting('appearanceTheme')), { owner: 'mod:a', id: 'night' });
  assert.deepEqual(await s.graph.unoverride('mod:a', 'night'), { restored: 2, kept: 0 });
  assert.deepEqual([s.state.appearanceTheme, s.state.appearanceLightChromeTheme], ['light', undefined]);
  assert.deepEqual(s.graph.overridesOf('mod:a'), []);
  // refused when the user says no: nothing changed
  const n = setup({ file: tmp(), approve: false });
  assert.equal((await n.graph.override('mod:a', { id: 'x', set: [{ ref: setting('appearanceTheme'), value: 'dark' }] }, { modId: 'a' })).status, 'refused');
  assert.equal(n.state.appearanceTheme, 'light');
});

test('H7y: the owner stopping ends its overrides; one holder per Setting', async () => {
  const s = setup({ file: tmp() });
  await s.graph.override('mod:a', { id: 'night', set: [{ ref: setting('appearanceTheme'), value: 'dark' }, { ref: setting('sansFontSize'), value: 16 }] }, { modId: 'a' });
  await new Promise((r) => setTimeout(r, 0));
  // another override of the same Setting waits for this one to end
  const other = await s.graph.override('mod:b', { id: 'big', set: [{ ref: setting('sansFontSize'), value: 18 }] }, { modId: 'b' });
  assert.equal(other.status, 'refused');
  assert.match(other.message, /held by another override/);
  // a change right after its write is not taken for the write's (the write's own change came already): it leaves, and stays
  s.userSets('sansFontSize', 14);
  assert.equal(s.graph.overrideHolderOf(setting('sansFontSize')), null);
  s.graph.disposeOwner('mod:a');
  await until(() => !s.graph.overridesOf('mod:a').length);
  assert.deepEqual([s.state.appearanceTheme, s.state.sansFontSize], ['light', 14]);
});

test('H7y: a change made meanwhile leaves the override and is never written over', async () => {
  let clock = 1_000_000;
  const file = tmp();
  const asked = [];
  const graph = createGraph({ overridesFile: file, now: () => clock, approvals: { ask: async (q) => { asked.push(q); return { approved: true }; } } });
  graph.registerTypes(NATIVE, 'native');
  const state = { appearanceTheme: 'light' };
  let p;
  const put = (key) => p.put(setting(key), { state: { title: key, value: state[key] ?? null, default: null, scope: 'app', kind: 'choice' }, links: { section: { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, definedBy: { type: 'App', provider: 'codex', id: 'codex' } } });
  p = graph.registerProvider('native', 'codex', { types: { Setting: { operations: { set: { effect: 'external', handler: ({ ref, args }) => { state[ref.id] = args[0]; put(ref.id); return null; } }, reset: { effect: 'external', handler: () => null } } } } });
  put('appearanceTheme');
  await graph.override('mod:a', { id: 'night', set: [{ ref: setting('appearanceTheme'), value: 'dark' }] }, { modId: 'a' });
  clock += 10_000;
  state.appearanceTheme = 'system';
  put('appearanceTheme');
  assert.equal(graph.overrideHolderOf(setting('appearanceTheme')), null, 'the user\'s change: out of the override');
  assert.deepEqual(await graph.unoverride('mod:a', 'night'), { restored: 0, kept: 0 });
  assert.equal(state.appearanceTheme, 'system', 'never written over');
});

test('H7y: after a crash the user\'s values come back at the next start, once the Settings can be written; the same id again keeps the user\'s first values', async () => {
  const file = tmp();
  const a = setup({ file });
  await a.graph.override('mod:a', { id: 'night', set: [{ ref: setting('appearanceTheme'), value: 'dark' }] }, { modId: 'a' });
  // replaced: the value kept aside is still the user's own (light), not the first override's
  await a.graph.override('mod:a', { id: 'night', set: [{ ref: setting('appearanceTheme'), value: 'system' }] }, { modId: 'a' });
  assert.equal(a.state.appearanceTheme, 'system');
  assert.equal(a.asked.length, 2);
  // the Host crashes (nothing restored); the next one finds what was kept
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.records[0].keys[0].was, 'light');
  const b = setup({ file, values: { appearanceTheme: 'system' } });
  await until(() => b.state.appearanceTheme === 'light');
  await until(() => !JSON.parse(fs.readFileSync(file, 'utf8')).records.length);
});

test('H7y: an override ends by itself at `until`; a malformed one is refused', async () => {
  const s = setup({ file: tmp() });
  // `until` far enough ahead that a loaded machine still applies it first (60 ms failed once under the full suite)
  const out = await s.graph.override('mod:a', { id: 'short', set: [{ ref: setting('appearanceTheme'), value: 'dark' }], until: Date.now() + 1000 }, { modId: 'a' });
  assert.equal(out.status, 'done');
  await until(() => s.state.appearanceTheme === 'light');
  for (const bad of [{ set: [] }, { id: 'x' }, { id: 'x', set: [{ ref: setting('nope'), value: 1 }] }, { id: 'x', set: [{ ref: setting('appearanceTheme') }] }, { id: 'x', set: [{ ref: setting('appearanceTheme'), value: 1 }], until: 1 }]) {
    assert.equal((await s.graph.override('mod:a', bad, { modId: 'a' })).status, 'refused', JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- built review H7y round 1
/** The app's Settings with `overridden` (the user set it), writes that can be refused, fail or wait, and an asker that waits to be told. */
function app({ file = tmp(), values = { appearanceTheme: 'light', sansFontSize: 13 }, unset = [], retryMs = 20, now, configured = {} } = {}) {
  const asks = [];
  const graph = createGraph({ overridesFile: file, overridesRetryMs: retryMs, ...(now ? { now } : {}), approvals: { ask: (q) => new Promise((resolve) => asks.push({ q, resolve })) } });
  graph.registerTypes(NATIVE, 'native');
  const state = { ...values };
  const userSet = new Set(Object.keys(values).filter((k) => !unset.includes(k)));
  // key -> 'refuse' | 'fail' | 'apply-then-fail' (in memory, not saved) | Promise (wait for it) | fn(apply) for its next writes
  const how = {};
  const writes = [];
  let p;
  const put = (key) => p.put(setting(key), { state: { title: key, value: state[key] ?? null, default: null, overridden: userSet.has(key), scope: 'app', kind: 'record',
    ...(configured[key] !== undefined ? { configured: configured[key] } : {}) }, links: { section: { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, definedBy: { type: 'App', provider: 'codex', id: 'codex' } } });
  const handle = async (key, fn) => {
    writes.push(key);
    const h = how[key];
    if (h === 'refuse') return { status: 'refused', reason: 'invalid', message: 'no' };
    if (h === 'fail') throw new Error('the app did not answer');
    const apply = () => { fn(); put(key); };
    if (h === 'apply-then-fail') { apply(); throw new Error('the app has it but could not save it yet'); }
    if (typeof h === 'function') { await h(apply); return null; }
    if (h && typeof h.then === 'function') await h;
    apply();
    return null;
  };
  p = graph.registerProvider('native', 'codex', { types: { Setting: { operations: {
    set: { effect: 'external', handler: ({ ref, args }) => handle(ref.id, () => { state[ref.id] = args[0]; userSet.add(ref.id); delete configured[ref.id]; }) },
    reset: { effect: 'external', handler: ({ ref }) => handle(ref.id, () => { state[ref.id] = values[ref.id] ?? undefined; userSet.delete(ref.id); delete configured[ref.id]; }) },
  } } } });
  for (const k of Object.keys(values)) put(k);
  return { graph, state, userSet, how, asks, put, file, writes, gone: (key) => p.remove(setting(key)), userSets: (key, v) => { state[key] = v; userSet.add(key); put(key); } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const T = setting('appearanceTheme'), F = setting('sansFontSize');

test('H7y review: who holds a Setting and its user value are decided after the user answers (two at once, a change while asked)', async () => {
  const s = app();
  const a = s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { modId: 'a' });
  const b = s.graph.override('mod:b', { id: 'y', set: [{ ref: T, value: 'system' }] }, { modId: 'b' });
  await tick();
  assert.equal(s.asks.length, 2, 'both asked: neither held it then');
  s.userSets('appearanceTheme', 'system');   // the user changes it while asked
  s.asks[0].resolve({ approved: true });
  assert.equal((await a).status, 'done');
  s.asks[1].resolve({ approved: true });
  const second = await b;
  assert.deepEqual([second.status, /held by another/.test(second.message)], ['refused', true], 'the second does not take it over');
  assert.deepEqual(s.graph.overrideHolderOf(T), { owner: 'mod:a', id: 'x' });
  await s.graph.unoverride('mod:a', 'x');
  assert.equal(s.state.appearanceTheme, 'system', 'the user\'s value when it was written, not when they were asked');
});

test('H7y review: an override waiting for the user\'s answer is withdrawn when its mod stops; nothing is written after', async () => {
  const s = app();
  const a = s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { modId: 'a' });
  await tick();
  assert.equal(s.asks[0].q.signal.aborted, false);
  s.graph.disposeOwner('mod:a');
  assert.equal(s.asks[0].q.signal.aborted, true, 'the question is withdrawn');
  s.asks[0].resolve({ approved: true });
  const out = await a;
  assert.deepEqual([out.status, s.state.appearanceTheme, s.graph.overrideHolderOf(T)], ['refused', 'light', null]);
});

test('H7y review: an override\'s ending and its replacement happen one at a time; a Setting the user never set goes back to none through every replacement', async () => {
  const s = app({ unset: ['sansFontSize'] });
  await s.graph.override('mod:a', { id: 'x', set: [{ ref: F, value: 16 }] }, { approved: true });
  await s.graph.override('mod:a', { id: 'x', set: [{ ref: F, value: 18 }] }, { approved: true });
  let go;
  s.how.sansFontSize = new Promise((r) => { go = r; });
  const ending = s.graph.unoverride('mod:a', 'x');
  const again = s.graph.override('mod:a', { id: 'x', set: [{ ref: F, value: 20 }] }, { approved: true });
  await tick();
  delete s.how.sansFontSize;
  go();
  assert.deepEqual(await ending, { restored: 1, kept: 0 });
  assert.equal((await again).status, 'done', 'after the ending, not torn by it');
  assert.deepEqual([s.state.sansFontSize, s.graph.overrideHolderOf(F)], [20, { owner: 'mod:a', id: 'x' }]);
  await s.graph.unoverride('mod:a', 'x');
  assert.deepEqual([s.userSet.has('sansFontSize'), s.state.sansFontSize], [false, 13], 'none again: its default (a reset), not the first value written');
});

test('H7y review: a replacement whose write is refused keeps what the previous one set (and the user\'s value); one that may have been written is kept', async () => {
  const s = app();
  await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }, { ref: F, value: 16 }] }, { approved: true });
  s.how.appearanceTheme = 'refuse';
  s.how.sansFontSize = 'fail';
  const out = await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'system' }, { ref: F, value: 18 }] }, { approved: true });
  assert.equal(out.status, 'refused', 'nothing set: it ends');
  delete s.how.appearanceTheme;
  delete s.how.sansFontSize;
  await until(() => !s.graph.overrideHolderOf(T) && !s.graph.overrideHolderOf(F));
  assert.deepEqual([s.state.appearanceTheme, s.state.sansFontSize], ['light', 13], 'the user\'s values back: none was lost');
});

test('H7y review: the Settings a replacement no longer sets are given back, tried again until they can be; and again when one comes after the tries ran out', async () => {
  const s = app({ retryMs: 5 });
  await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }, { ref: F, value: 16 }] }, { approved: true });
  s.how.sansFontSize = 'fail';
  assert.equal((await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'system' }] }, { approved: true })).status, 'done');
  assert.equal(s.state.sansFontSize, 16);
  delete s.how.sansFontSize;
  await until(() => s.state.sansFontSize === 13);
  assert.deepEqual(s.graph.overridesOf('mod:a').map((x) => x.settings.map((r) => r.id)), [['appearanceTheme']]);
  // its tries run out while the Setting is not here; it comes back: given back then
  s.how.appearanceTheme = 'fail';
  await s.graph.unoverride('mod:a', 'x');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.state.appearanceTheme, 'system');
  delete s.how.appearanceTheme;
  s.gone('appearanceTheme');
  s.put('appearanceTheme');
  await until(() => s.state.appearanceTheme === 'light');
});

test('H7y review: after a crash a Setting the user changed while the Host was away stays theirs; the user\'s values not kept on disk: nothing is written', async () => {
  const file = tmp();
  const a = app({ file });
  await a.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }, { ref: F, value: 16 }] }, { approved: true });
  // the Host crashes; meanwhile the user changes the theme; the next Host gives back only the font size
  const b = app({ file, values: { appearanceTheme: 'system', sansFontSize: 16 } });
  await until(() => b.state.sansFontSize === 13);
  await until(() => !JSON.parse(fs.readFileSync(file, 'utf8')).records.length);
  assert.equal(b.state.appearanceTheme, 'system', 'not written over');
  const blocked = path.join(path.dirname(file), 'blocked');
  fs.writeFileSync(blocked, '');
  const c = app({ file: path.join(blocked, 'overrides.json') });
  const out = await c.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { approved: true });
  assert.deepEqual([out.status, c.state.appearanceTheme, c.graph.overrideHolderOf(T)], ['refused', 'light', null]);
});

test('H7y review: an `until` beyond what a timer can wait does not end it at once', async () => {
  const s = app();
  assert.equal((await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }], until: Date.now() + 29 * 24 * 3600_000 }, { approved: true })).status, 'done');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([s.state.appearanceTheme, s.graph.overrideHolderOf(T)?.id], ['dark', 'x']);
  await s.graph.unoverride('mod:a', 'x');
});

// ---------------------------------------------------------------- built review H7y round 2
test('H7y review 2: a change of another\'s while our write runs, after its own change, is theirs: it leaves the override and is never written over', async () => {
  const s = app();
  s.how.appearanceTheme = async (apply) => { apply(); s.userSets('appearanceTheme', 'system'); };   // the user chooses before the write is answered
  assert.equal((await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { approved: true })).status, 'done');
  delete s.how.appearanceTheme;
  assert.equal(s.graph.overrideHolderOf(T), null);
  await s.graph.unoverride('mod:a', 'x');
  assert.equal(s.state.appearanceTheme, 'system');
  // the user's change before ours lands: ours is the newest, held
  s.how.sansFontSize = async (apply) => { s.userSets('sansFontSize', 15); apply(); };
  await s.graph.override('mod:a', { id: 'y', set: [{ ref: F, value: 16 }] }, { approved: true });
  delete s.how.sansFontSize;
  assert.equal(s.graph.overrideHolderOf(F)?.id, 'y');
  await s.graph.unoverride('mod:a', 'y');
});

test('H7y review 2: a mod stopped after the user\'s answer, before its override is written: nothing is written', async () => {
  // the stop comes at each step between the answer and the override's turn (its question gone, nothing held yet)
  for (let depth = 0; depth < 8; depth++) {
    const s = app();
    const a = s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { modId: 'a' });
    await tick();
    s.asks[0].resolve({ approved: true });
    for (let i = 0; i < depth; i++) await Promise.resolve();
    s.graph.disposeOwner('mod:a');
    await a;   // refused, or written before the stop and ended by it
    await until(() => s.state.appearanceTheme === 'light' && !s.graph.overrideHolderOf(T)).catch(() => {});
    assert.deepEqual([s.state.appearanceTheme, s.graph.overrideHolderOf(T)], ['light', null], `stopped ${depth} steps after: nothing stays`);
  }
});

test('H7y review 2: a write that may still happen is not given up while it may; a put back the app did not save is written again', async () => {
  let clock = Date.now();
  const s = app({ now: () => clock, retryMs: 5 });
  let land;
  s.how.appearanceTheme = () => new Promise((resolve, reject) => { land = () => { s.state.appearanceTheme = 'dark'; s.userSet.add('appearanceTheme'); s.put('appearanceTheme'); resolve(); }; setTimeout(() => reject(new Error('timed out')), 5); });
  const out = await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'dark' }] }, { approved: true });
  assert.equal(out.status, 'refused', 'not known to be set: it ends');
  delete s.how.appearanceTheme;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.graph.overrideHolderOf(T)?.id, 'x', 'kept while the write may still happen');
  land();   // it happens after all: given back
  await until(() => s.state.appearanceTheme === 'light' && !s.graph.overrideHolderOf(T));
  // not saved: written again although the app holds the user's value in memory
  await s.graph.override('mod:a', { id: 'y', set: [{ ref: F, value: 16 }] }, { approved: true });
  s.how.sansFontSize = 'apply-then-fail';
  await s.graph.unoverride('mod:a', 'y');
  assert.deepEqual([s.state.sansFontSize, s.graph.overrideHolderOf(F)?.id], [13, 'y'], 'in memory, not saved: still held');
  delete s.how.sansFontSize;
  const before = s.writes.length;
  await until(() => !s.graph.overrideHolderOf(F));
  assert.ok(s.writes.slice(before).includes('sansFontSize'), 'written again to be saved');
  clock += 120_000;
});

test('H7y review 2: where the app uses another value for now (its policy), the one the user set is kept and put back', async () => {
  const s = app({ values: { appearanceTheme: 'light', sansFontSize: 13 }, configured: { appearanceTheme: 'dark' } });
  await s.graph.override('mod:a', { id: 'x', set: [{ ref: T, value: 'system' }] }, { approved: true });
  await s.graph.unoverride('mod:a', 'x');
  assert.equal(s.state.appearanceTheme, 'dark', 'the value the user set, not the one in effect then');
});
