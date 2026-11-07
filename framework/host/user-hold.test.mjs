// framework-main's held actions decided by the Host (user-hold.mjs, public-hooks.md §3.5, §3.7 "Faults"): through the graph with the user as
// the caller; let go unchanged only when nothing holds it (by the graph's release codes); an instance it lacks is read first and decided
// again, and refused if still unknown; an interceptor's failure means what it declared (passed over, or a refusal); a mod's own doing
// answers with what it made; a mod's stop is answered quietly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from './graph/index.mjs';
import { createHeldActions } from './graph/held-actions.mjs';
import { NATIVE_TYPES } from '../../sdk/graph/native/index.mjs';
import { toDescriptor } from '../../sdk/graph/define.mjs';
import { decideUserHold, menuEntryHold } from './user-hold.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const AUTO = (id) => ({ type: 'Automation', provider: 'codex', id });
const automation = (name) => ({ state: { name, prompt: { parts: [{ kind: 'text', text: 'p' }] }, schedule: { rrule: 'R' }, enabled: true }, links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
function setup() {
  const g = createGraph({ log: quiet });
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  let handle = null;
  // the provider has the automation only once asked for it (a view loads it): made a moment ago, not read yet
  handle = g.registerProvider('native', 'codex', {
    types: { Automation: { operations: { runNow: { effect: 'external', handler: () => null }, delete: { effect: 'external', handler: () => null } } } },
    onObserve: (q) => { if (q?.ref?.id === 'new') handle.put(AUTO('new'), automation('New')); },
  });
  handle.put(AUTO('a1'), automation('A'));
  const heldMain = createHeldActions({ graph: () => g });
  const posted = [];
  const ask = (ref, operation, args = []) => decideUserHold({ type: 'user-hold', requestId: `r${posted.length}`, ref, operation, args, changes: false },
    { graph: g, heldMain, heldAborts: new Map(), post: (m) => posted.push(m), log: quiet }).then(() => posted.at(-1));
  return { g, heldMain, posted, ask, close() { heldMain.dispose(); g.close(); } };
}

test('an automation the graph has not read yet is read first and decided again: the policy refusing it binds it', async () => {
  const s = setup();
  try {
    s.g.policy('mod:p', { id: 'no-runs', title: 'No runs', on: { type: 'Automation', operation: 'runNow' }, then: { refuse: 'no runs now' } });
    const a = await s.ask(AUTO('new'), 'runNow');
    assert.deepEqual([a.go, a.message], [false, 'no runs now (“No runs”, a policy of p)']);
    // one the provider still does not have once read: never let through undecided
    const gone = await s.ask(AUTO('gone'), 'runNow');
    assert.equal(gone.go, false);
    assert.match(gone.message, /could not be decided \(unknown instance\)/);
  } finally { s.close(); }
});

test('an interceptor that fails before deciding refuses the held action (never let through past another mod\'s policy); nothing holding it: go', async () => {
  const s = setup();
  try {
    assert.equal((await s.ask(AUTO('a1'), 'runNow')).go, true, 'nothing holds it');
    s.g.intercept('mod:x', 'Automation', 'runNow', async () => { throw new Error('boom'); });
    s.g.policy('mod:p', { id: 'no-runs', title: 'No runs', on: { type: 'Automation', operation: 'runNow' }, then: { refuse: 'no runs now' } });
    const a = await s.ask(AUTO('a1'), 'runNow');
    assert.deepEqual([a.go, a.message], [false, 'no runs now (“No runs”, a policy of p)'], 'the policy decides it as it came');
  } finally { s.close(); }
});

test('graph-integrity G6.6: an interceptor\'s failure means what it declared: passed over (the default: the action goes on), or a refusal', async () => {
  const s = setup();
  try {
    const x = s.g.intercept('mod:x', 'Automation', 'runNow', async () => { throw new Error('has no operation'); });
    assert.equal((await s.ask(AUTO('a1'), 'runNow')).go, true, 'passed over');
    x.dispose();
    s.g.intercept('mod:x', 'Automation', 'runNow', async () => { throw new Error('has no operation'); }, { onFailure: 'refuse' });
    const a = await s.ask(AUTO('a1'), 'runNow');
    assert.deepEqual([a.go, a.message], [false, 'interceptor x failed: has no operation']);
  } finally { s.close(); }
});

test('a mod that does it in the app\'s place: the answer says handled and what it made', async () => {
  const s = setup();
  try {
    s.g.intercept('mod:r', 'Automation', 'delete', async () => ({ status: 'done', value: AUTO('a1') }), { replaces: true });
    assert.deepEqual(await s.ask(AUTO('a1'), 'delete'), { type: 'user-hold-answer', requestId: 'r0', go: false, handled: true, value: AUTO('a1') });
  } finally { s.close(); }
});

test('H6m2a review: the instance is read again before it is decided on (`fresh`), and a refusal the page does not show is told (`refused`)', async () => {
  const s = setup();
  try {
    const order = [], told = [];
    s.g.policy('mod:p', { id: 'no-runs', title: 'No runs', on: { type: 'Automation', operation: 'runNow' }, where: { name: 'Fresh' }, then: { refuse: 'not this one' } });
    const opts = { graph: s.g, heldMain: s.heldMain, heldAborts: new Map(), post: (m) => s.posted.push(m), log: quiet,
      // the provider's state as it is now: the automation renamed meanwhile, which the policy holds
      fresh: async (ref) => { order.push(['fresh', ref.id]); s.g.resolve(ref) && order.push(['renamed']); },
      refused: (m, message) => told.push([m.operation, message]) };
    // what fresh reads is the state the decision sees: rename it as a provider's read would
    const handle = s.g.registerProvider('native', 'unit.fresh', { types: { Automation: { operations: { runNow: { effect: 'external', handler: () => null } } } } });
    const ref = { type: 'Automation', provider: 'unit.fresh', id: 'f1' };
    handle.put(ref, automation('Stale'));
    opts.fresh = async (r) => { order.push(['fresh', r.id]); handle.put(ref, automation('Fresh')); };
    await decideUserHold({ type: 'user-hold', requestId: 'fr1', ref, operation: 'runNow', args: [], changes: false }, opts);
    const a = s.posted.at(-1);
    assert.deepEqual([a.go, a.message], [false, 'not this one (“No runs”, a policy of p)'], 'decided on the state read just now');
    assert.deepEqual(order, [['fresh', 'f1']]);
    assert.deepEqual(told, [['runNow', 'not this one (“No runs”, a policy of p)']]);
    // round 2: never decided on what was read before: a read that fails is refused, the policy not asked (it would let it go)
    handle.put(ref, automation('Other'));
    opts.fresh = async () => false;
    await decideUserHold({ type: 'user-hold', requestId: 'fr2', ref, operation: 'runNow', args: [], changes: false }, opts);
    assert.deepEqual([s.posted.at(-1).go, s.posted.at(-1).message], [false, 'it could not be decided (it could not be read as it is now)']);
    opts.fresh = async () => { throw new Error('the git worker is gone'); };
    await decideUserHold({ type: 'user-hold', requestId: 'fr3', ref, operation: 'runNow', args: [], changes: false }, opts);
    assert.equal(s.posted.at(-1).go, false);
    // one that need not be read (null) is decided as it is
    opts.fresh = async () => null;
    await decideUserHold({ type: 'user-hold', requestId: 'fr4', ref, operation: 'runNow', args: [], changes: false }, opts);
    assert.equal(s.posted.at(-1).go, true);
  } finally { s.close(); }
});

test('H6m3b: a held menu bar click names the Command its entry names (by its path), marked as the menu\'s; one that names none goes on; others as they are', () => {
  const windows = { menuEntryCommand: (path) => (path.join('/') === 'View/Toggle Sidebar' ? { type: 'Command', provider: 'codex', id: 'toggleSidebar' } : null) };
  const msg = { type: 'user-hold', requestId: 'r1', ref: { type: 'MenuEntry', provider: 'framework', path: ['View', 'Toggle Sidebar'] }, operation: 'choose', args: [] };
  assert.deepEqual(menuEntryHold(msg, windows), { ...msg, ref: { type: 'Command', provider: 'codex', id: 'toggleSidebar' }, operation: 'run', menu: true });
  assert.equal(menuEntryHold({ ...msg, ref: { ...msg.ref, path: ['File', 'Other'] } }, windows).ref, null);
  assert.equal(menuEntryHold(msg, null).ref, null, 'no windows: goes on');
  const other = { type: 'user-hold', ref: { type: 'Project', provider: 'codex', id: 'p' }, operation: 'rename' };
  assert.equal(menuEntryHold(other, windows), other);
});

test('graph-integrity G6.2: a mod that stops the user\'s action: answered stopped (its mod named), no refusal told, nothing done', async () => {
  const s = setup();
  try {
    const told = [];
    s.g.intercept('mod:later', 'Automation', 'runNow', async () => ({ status: 'stopped', message: 'it runs at night' }));
    await decideUserHold({ type: 'user-hold', requestId: 'r-stop', ref: AUTO('a1'), operation: 'runNow', args: [], changes: false },
      { graph: s.g, heldMain: s.heldMain, heldAborts: new Map(), post: (m) => s.posted.push(m), log: quiet, refused: (msg, why) => told.push(why) });
    const a = s.posted.at(-1);
    assert.deepEqual([a.go, a.stopped, a.by, a.message], [false, true, 'later', 'it runs at night']);
    assert.deepEqual(told, [], 'a stop is not a refusal: nothing is told');
  } finally { s.close(); }
});
