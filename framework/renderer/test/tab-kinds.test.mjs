// The panels' tab kinds (docs/design/layouts.md §4.1): each kind's isVisible decorated in place (those registered later too), a tab of a
// kind a rule hides in its panel hidden unless it needs the user, the epoch read so the panels recompute, and the launcher's list and order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabKinds } from '../present/tab-kinds.mjs';

function setup() {
  const registry = new Map([['terminal', { kind: 'terminal' }], ['browser', { kind: 'browser', isVisible: () => true }], ['workspace-new-tab', { kind: 'workspace-new-tab' }]]);
  const atoms = { external: (scope, read, subscribe) => { const a = { read, subscribe, set: null }; subscribe({ set: (v) => { a.value = v; } }); return a; } };
  let parts = { SidePanel: [], BottomPanel: [] };
  const subjects = new Map();
  const exports = { tabRegistry: { registry }, atoms, AppScope: {}, panelControllers: { bottom: { tabIds$: 'BOTTOM_IDS' } }, launcherOrder: { table: { review: 0, 'new-page': 1, terminal: 2, desktop: 3, browser: 4, 'open-file': 5 } } };
  const resolved = [];
  // the runtime's read tracking, as the page's: what a run read (subjects by type:id, a chat id's mapping by pid:<id>)
  let rec = null;
  const track = (fn) => { const outer = rec, keys = new Set(); rec = keys; try { return { value: fn(), keys }; } finally { rec = outer; if (outer) for (const x of keys) outer.add(x); } };
  const unmapped = new Set();
  const k = createTabKinds({ exports: () => exports, resolve: (p, inst) => { resolved.push([p, inst?.id ?? null]); return { parts: parts[p] ?? [] }; },
    thread: (id) => { rec?.add(`pid:${id}`); return unmapped.has(id) ? null : { type: 'Thread', provider: 'codex', id }; },
    subject: (ref) => { rec?.add(`${ref.type}:${ref.id}`); return subjects.get(`${ref.type}:${ref.id}`) ?? null; }, settled: () => true, track, later: (f) => f(), log() {} });
  k.arm();
  const reads = [];
  const scope = (chat, bottomIds = []) => ({ value: { conversationId: chat }, get: (x) => { reads.push(x); return x === 'BOTTOM_IDS' ? bottomIds : undefined; } });
  return { k, registry, exports, scope, reads, subjects, resolved, unmapped, setParts: (p) => { parts = p; k.changed(Object.entries(p).flatMap(([presentation, rs]) => rs.map((r) => ({ ...r, presentation })))); } };
}
const hide = (...part) => ({ kind: 'hide', part });

test('§4.1: a hidden kind\'s tabs leave the panel the rule names; the epoch is read first; the app\'s own answer kept; protected kinds untouched', () => {
  const { k, registry, scope, reads, setParts } = setup();
  const term = registry.get('terminal');
  const t1 = { tabId: 'terminal:s1', kind: 'terminal' };
  assert.equal(term.isVisible(scope('c1'), t1), true, 'no rule: shown');
  assert.ok(reads.length > 0, 'the epoch read (so the panels recompute when it moves)');
  setParts({ SidePanel: [hide('terminal')], BottomPanel: [] });
  assert.equal(term.isVisible(scope('c1'), t1), false, 'hidden in the side panel');
  assert.equal(term.isVisible(scope('c1', ['terminal:s1']), t1), true, 'a bottom panel\'s tab: the rule names the side panel only');
  setParts({ SidePanel: [], BottomPanel: [hide('terminal')] });
  assert.equal(term.isVisible(scope('c1', ['terminal:s1']), t1), false);
  assert.equal(registry.get('workspace-new-tab').isVisible, undefined, 'the New tab page is never a part');
  setParts({ SidePanel: [hide('browser')], BottomPanel: [] });
  const page = (url) => ({ tabId: 'b1', durableRoute: { kind: 'browser', params: { restoreUrl: url } } });
  assert.equal(registry.get('browser').isVisible(scope('c1'), page('')), true, 'a browser tab on its start page is the New tab page: kept');
  assert.equal(registry.get('browser').isVisible(scope('c1'), page('https://example.com/')), false);
  registry.get('browser').isVisible = () => false;
  assert.equal(registry.get('browser').isVisible(scope('c1'), { tabId: 'b' }), false, 'the app\'s own false kept (an assignment becomes its own)');
  // a kind registered later is decorated too
  registry.set('review', { kind: 'review' });
  setParts({ SidePanel: [hide('changes')], BottomPanel: [] });
  assert.equal(registry.get('review').isVisible(scope('c1'), { tabId: 'r' }), false);
  assert.ok(k.epoch >= 3, 'each change of what is hidden moves the epoch');
});

test('§4.1: a tab that needs the user stays (unsaved edits, a side chat needing them, the agent\'s running command)', () => {
  const { registry, scope, subjects, setParts } = setup();
  registry.set('local-side-chat', { kind: 'local-side-chat' });
  registry.set('workspace-file', { kind: 'workspace-file' });
  setParts({ SidePanel: [hide('terminal', 'sideChat', 'files')], BottomPanel: [] });
  subjects.set('Terminal:s2', { state: { running: true, startedBy: 'agent' } });
  subjects.set('Terminal:s4', { state: { running: true, startedBy: 'you' } });
  subjects.set('Thread:c9', { state: { status: 'waitingForYou' } });
  assert.equal(registry.get('terminal').isVisible(scope('c1'), { tabId: 'terminal:s2' }), true, 'running');
  assert.equal(registry.get('terminal').isVisible(scope('c1'), { tabId: 'terminal:s3' }), false, 'idle');
  assert.equal(registry.get('terminal').isVisible(scope('c1'), { tabId: 'terminal:s4' }), false, 'the user\'s shell: a live session, not held');
  assert.equal(registry.get('local-side-chat').isVisible(scope('c1'), { tabId: 'x', props: { content: { conversationId: 'c9' } } }), true, 'waiting for the user');
  assert.equal(registry.get('workspace-file').isVisible(scope('c1'), { tabId: 'f', hasUnsavedChanges: true }), true, 'unsaved');
  assert.equal(registry.get('workspace-file').isVisible(scope('c1'), { tabId: 'g' }), false);
});

test('§4.1: the launcher leaves a hidden kind out for that panel and orders the kinds as declared, the app\'s table written to agree (and given back)', () => {
  const { k, exports, setParts } = setup();
  const item = (id, kind) => ({ id, tabType: { kind } });
  const list = [item('open-file', 'workspace-file'), item('review', 'review'), item('terminal', 'terminal'), item('browser', 'browser')];
  const scope = () => ({ value: { conversationId: 'c1' } });
  setParts({ SidePanel: [hide('browser'), { kind: 'reorder', slot: 'kinds', data: { order: ['terminal', 'files'] } }], BottomPanel: [] });
  assert.deepEqual(k.launcher(list, { target: 'right' }, scope).map((x) => x.id), ['terminal', 'open-file', 'review']);
  assert.deepEqual([exports.launcherOrder.table.terminal, exports.launcherOrder.table['open-file'], exports.launcherOrder.table.review], [0, 1, 2]);
  assert.deepEqual(k.launcher(list, { target: 'bottom' }, scope).map((x) => x.id), list.map((x) => x.id), 'the bottom panel: no rule');
  setParts({ SidePanel: [], BottomPanel: [] });
  k.launcher(list, { target: 'right' }, scope);
  assert.deepEqual(exports.launcherOrder.table, { review: 0, 'new-page': 1, terminal: 2, desktop: 3, browser: 4, 'open-file': 5 }, 'no order: the app\'s own back');
});

test('§4.1: a hide alone keeps the order the app would draw for the others (its table names every id while a rule applies, then is given back)', () => {
  const { k, exports, setParts } = setup();
  const item = (id, kind) => ({ id, tabType: { kind } });
  const list = [item('terminal', 'terminal'), item('open-file', 'workspace-file'), item('side-chat', 'local-side-chat')];
  const scope = () => ({ value: { conversationId: 'c1' } });
  const appSort = (l) => [...l].sort((a, b) => (exports.launcherOrder.table[a.id] ?? l.length) - (exports.launcherOrder.table[b.id] ?? l.length)).map((x) => x.id);
  assert.deepEqual(appSort(list), ['terminal', 'side-chat', 'open-file'], 'the app\'s own order (an id it does not name: by the length)');
  setParts({ SidePanel: [hide('terminal')], BottomPanel: [] });
  assert.deepEqual(appSort(k.launcher(list, { target: 'right' }, scope)), ['side-chat', 'open-file'], 'not moved by the shorter list');
  setParts({ SidePanel: [], BottomPanel: [] });
  k.launcher(list, { target: 'right' }, scope);
  assert.deepEqual(exports.launcherOrder.table, { review: 0, 'new-page': 1, terminal: 2, desktop: 3, browser: 4, 'open-file': 5 }, 'the ids it added taken out');
});

test('§4.1: the registry polled with real delays until it is there, and asked again on use once the polling gave up', () => {
  const queued = [];
  let exports = {};
  const k = createTabKinds({ exports: () => exports, resolve: () => ({ parts: [] }), thread: () => null, subject: () => null, settled: () => true, later: (f, ms) => queued.push([f, ms]), log() {} });
  k.arm();
  k.arm();
  assert.equal(queued.length, 1, 'one polling round at a time');
  assert.ok(queued[0][1] > 0, 'a delay, not a microtask');
  while (queued.length) queued.shift()[0]();   // the round runs out with nothing there
  const registry = new Map([['terminal', { kind: 'terminal' }]]);
  exports = { tabRegistry: { registry }, atoms: { external: () => ({}) }, AppScope: {} };
  k.changed([]);
  assert.equal(typeof Object.getOwnPropertyDescriptor(registry.get('terminal'), 'isVisible').get, 'function', 'decorated on the next use');
});

test('layouts WL2-4a review: a hidden kind\'s tab shows again when its subject comes to need the user (the epoch moves on that subject\'s change, not another\'s)', () => {
  const { k, registry, scope, subjects, setParts } = setup();
  registry.set('local-side-chat', { kind: 'local-side-chat' });
  setParts({ SidePanel: [hide('sideChat')], BottomPanel: [] });
  subjects.set('Thread:c9', { state: { status: 'idle' } });
  const tab = { tabId: 'x', props: { content: { conversationId: 'c9' } } };
  assert.equal(registry.get('local-side-chat').isVisible(scope('c1'), tab), false);
  const e = k.epoch;
  k.touched(['Thread:other']);
  assert.equal(k.epoch, e, 'a subject its answers did not read');
  subjects.set('Thread:c9', { state: { status: 'waitingForYou' } });
  k.touched(['Thread:c9']);
  assert.equal(k.epoch, e + 1, 'the side chat\'s Thread changed: the panels recompute');
  assert.equal(registry.get('local-side-chat').isVisible(scope('c1'), tab), true);
  // a build without the seam tab-visible (no tab passed): nothing hidden
  assert.equal(registry.get('terminal').isVisible(scope('c1')), true);
});

test('layouts WL2-4a review: a subject read before the page could read any (undefined) moves the epoch at its next refresh', () => {
  let ready = false;
  const registry = new Map([['local-side-chat', { kind: 'local-side-chat' }]]);
  const exports = { tabRegistry: { registry }, atoms: { external: () => ({}) }, AppScope: {} };
  const k = createTabKinds({ exports: () => exports, resolve: () => ({ parts: [{ kind: 'hide', part: ['sideChat'] }] }), thread: (id) => ({ type: 'Thread', id }),
    subject: () => (ready ? null : undefined), settled: () => false, later: (f) => f(), log() {} });
  k.arm();
  registry.get('local-side-chat').isVisible({ value: { conversationId: 'c1' }, get() {} }, { tabId: 'x' });
  const e = k.epoch;
  ready = true;
  k.touched(null);
  assert.equal(k.epoch, e + 1);
  k.touched(null);
  assert.equal(k.epoch, e + 1, 'once');
});

test('layouts WL2-4a review: the launcher\'s order is resolved for the chat as its hide is; the table is the app\'s again as the last rule goes; dispose gives everything back', () => {
  const { k, registry, exports, resolved, subjects, setParts } = setup();
  subjects.set('Thread:c1', { id: 'c1', state: { status: 'idle' } });
  const item = (id, kind) => ({ id, tabType: { kind } });
  const list = [item('open-file', 'workspace-file'), item('terminal', 'terminal')];
  setParts({ SidePanel: [{ kind: 'reorder', slot: 'kinds', data: { order: ['terminal'] } }], BottomPanel: [] });
  resolved.length = 0;
  k.launcher(list, { target: 'right' }, () => ({ value: { conversationId: 'c1' } }));
  assert.deepEqual(resolved, [['SidePanel', 'c1']], 'one resolution, for the chat, both hide and order');
  assert.equal(exports.launcherOrder.table.terminal, 0);
  setParts({ SidePanel: [], BottomPanel: [] });
  assert.deepEqual(exports.launcherOrder.table, { review: 0, 'new-page': 1, terminal: 2, desktop: 3, browser: 4, 'open-file': 5 }, 'given back with no launcher drawn');
  // dispose: the kinds' isVisible as they were (none of its own; the app's own value; an assignment since), the registry's set, the table
  const appOwn = () => 'app';
  registry.get('browser').isVisible = appOwn;
  setParts({ SidePanel: [{ kind: 'reorder', slot: 'kinds', data: { order: ['terminal'] } }], BottomPanel: [] });
  k.launcher(list, { target: 'right' }, () => ({ value: { conversationId: 'c1' } }));
  k.dispose();
  assert.equal(Object.hasOwn(registry.get('terminal'), 'isVisible'), false, 'none of its own before: none');
  assert.equal(registry.get('browser').isVisible, appOwn, 'the app\'s own, as assigned since');
  assert.equal(Object.hasOwn(registry, 'set'), false, 'the registry\'s own set');
  registry.set('goal', { kind: 'goal' });
  assert.equal(registry.get('goal').isVisible, undefined, 'a kind registered after: not decorated');
  assert.equal(exports.launcherOrder.table.terminal, 2);
});

test('layouts WL2-4a review round 2: a side chat whose id is not mapped yet stays; its mapping\'s answer moves the epoch; dispose moves it once more', () => {
  const { k, registry, scope, subjects, unmapped, setParts } = setup();
  registry.set('local-side-chat', { kind: 'local-side-chat' });
  setParts({ SidePanel: [hide('sideChat')], BottomPanel: [] });
  unmapped.add('c9');
  const tab = { tabId: 'x', props: { content: { conversationId: 'c9' } } };
  assert.equal(registry.get('local-side-chat').isVisible(scope('c1'), tab), true, 'not answered for yet: held');
  const e = k.epoch;
  unmapped.delete('c9');
  subjects.set('Thread:c9', { state: { status: 'idle' } });
  k.touched(['pid:c9']);
  assert.equal(k.epoch, e + 1, 'the mapping\'s answer was read: the panels recompute');
  assert.equal(registry.get('local-side-chat').isVisible(scope('c1'), tab), false);
  k.dispose();
  assert.equal(k.epoch, e + 2, 'the app\'s own answers computed again');
});

