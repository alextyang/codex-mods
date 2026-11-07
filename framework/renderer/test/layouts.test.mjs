// The window's named layouts (docs/design/layouts.md D5, D6, D11): one claim per window, applied to a chat once the app has restored it, every change told by its
// origin: the user's releases the region, the app's and the framework's do not; ended, each region it set goes back as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayouts } from '../present/layouts.mjs';
import { createLayoutPicker } from '../present/layouts-section.mjs';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { claimBeside, columnsChanged, setBottomPlacement, bottomPlacement, regionState, setRegion, declaredRegions } from '../present/bindings/frame-regions.mjs';
import { compileWhere } from '../../shared/where.mjs';
import { layoutWhy, layoutModeWhy } from '../../shared/ui-rules-client.mjs';

function chat(conversationId, state = {}) {
  const st = { SIDE: false, BAR: true, MODE: 'chat', REST: conversationId, READY: true, BOT: false, TABS: false, CNT: 0, SRC: undefined, TAB: { id: 't' }, ...state };
  const watchers = new Set();
  const node = {
    value: conversationId ? { conversationId } : { pathname: '/' },
    get: (a) => st[a],
    set(a, v) { st[a] = v; for (const w of [...watchers]) w({ get: (x) => st[x] }); },
    watch(fn) { watchers.add(fn); fn({ get: (x) => st[x] }); return () => watchers.delete(fn); },
  };
  return { node, st, set: node.set };
}
const exportsOf = (log = []) => ({
  responsive: { sideOpen: 'SIDE', sidebarOpen: 'BAR', setSidebar: (n, open) => { log.push(['sidebar', open]); n.set('BAR', open); } },
  // as the app's: opening goes by the full-width preference, setting it writes it, closing leaves it
  workspaceLayout: { activeTab: 'TAB', preference: 'PREF', setPanel: (n, open) => { log.push(['side', open]); n.set('SIDE', open); n.set('MODE', open ? (n.get('PREF') === 'full' ? 'full' : 'split') : 'chat'); }, setFull: (n, full) => { log.push(['full', full]); n.set('PREF', full ? 'full' : 'split'); if (full) { if (n.get('SIDE')) n.set('MODE', 'full'); } else if (n.get('MODE') === 'full') n.set('MODE', 'split'); } },
  workspaceState: { mode: 'MODE', restored: 'REST', ready: 'READY', bottomOpen: 'BOT', tabsOpen: 'TABS' },
  windowRegions: { setBottom: (n, open) => { log.push(['bottom', open]); n.set('BOT', open); } },
  layoutSource: { counter: 'CNT', source: 'SRC' },
});
const rule = (id, layout, mod = 'qa.mod') => ({ mod, id, kind: 'add', presentation: 'Window', slot: 'layouts', data: { layout: { title: id, ...layout } }, fns: {} });

function setup({ layouts = [], extra = {} } = {}) {
  const lists = { layouts, regions: [], layoutModes: [] };
  const ctx = { local: { read() {}, touch() {} }, declared: (p, s) => (p === 'Window' ? lists[s] ?? [] : []), windowChanged() {} };
  const log = [];
  let time = 1000;
  const l = createLayouts({ ctx, exports: () => exportsOf(log), now: () => time, ...extra });
  const show = (key, node, shown = () => true) => { const token = {}; claimBeside(ctx, token, { key, scope: node, shown }); return token; };
  return { l, ctx, log, lists, show, tick: (ms) => { time += ms; } };
}
const flush = () => new Promise((r) => { queueMicrotask(r); });
/** A panel's frame's operations over plain figures. */
const sizer = (s) => (binding, op, [v] = []) => {
  if (op === 'shareNow') return s.share;
  if (op === 'heightNow') return s.height;
  if (op === 'resize') { s.share = v / 1000; return true; }
  if (op === 'putShare') { s.share = v; return true; }
  if (op === 'bottomHeight') { s.height = v; return true; }
  return { unavailable: 'no' };
};

test('WL6: a chat whose restore is not done waits; the layout goes on once it is, and what it gives back is what the restore made', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false }, bottom: { open: false } })] });
  const c = chat('c1', { READY: false, REST: null });
  t.show('c1', c.node);
  assert.equal(t.l.pick('qa.mod/focus'), true);
  assert.deepEqual(t.log, [], 'not before the restore: it would write over it');
  assert.equal(t.l.facts().settled, false);
  // the app's restore: its own source, its own values
  c.set('SRC', 'restore'); c.set('SIDE', true); c.set('BOT', true); c.set('MODE', 'split'); c.set('SRC', undefined);
  c.set('REST', 'c1'); c.set('READY', true);
  await flush();
  assert.deepEqual(t.log, [['side', false], ['bottom', false]]);
  assert.equal(t.l.facts().released, undefined, 'its restore is not the user\'s');
  assert.equal(t.l.facts().settled, true);
  t.log.length = 0;
  t.l.end();
  assert.deepEqual(t.log, [['side', true], ['bottom', true]], 'as the restore left them');
});

test('WL6: the user\'s change releases the region: told by the app\'s counter, or an input just before; the layout stays picked and never fights it', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false }, bottom: { open: false } })] });
  const c = chat('c1', { SIDE: true, BOT: true, MODE: 'split' });
  t.show('c1', c.node);
  t.l.pick('qa.mod/focus');
  assert.deepEqual(c.st.SIDE, false);
  // the app's layout command: its counter moves and its source says so
  c.set('CNT', 1); c.set('SRC', 'layout_command'); c.set('SIDE', true); c.set('SRC', undefined);
  assert.deepEqual(t.l.facts().released, ['side']);
  assert.equal(t.l.facts().picked, 'qa.mod/focus');
  // a change with an input just before (the native menu's Cmd+J says nothing else)
  t.l.noteInput();
  c.set('BOT', true);
  assert.deepEqual(t.l.facts().released, ['side', 'bottom']);
  t.log.length = 0;
  t.l.rulesChanged();
  assert.deepEqual(t.log, [], 'not applied again');
  t.l.end();
  assert.deepEqual(t.log, [], 'and what the user took stays as they left it');
});

test('WL6: what is not the user\'s releases nothing: the app\'s own opening, its restore, its resize handler, the framework\'s own act', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false } })] });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/focus');
  c.set('SIDE', true);   // no input, no counter: a preview the app opens
  assert.equal(t.l.facts().released, undefined);
  c.set('SIDE', false);
  c.set('SRC', 'restore'); c.set('SIDE', true); c.set('SRC', undefined);
  assert.equal(t.l.facts().released, undefined);
  t.l.resizing(); c.set('SIDE', false);
  await flush();
  assert.equal(t.l.facts().released, undefined);
  t.l.noteInput();
  t.l.around(() => c.set('SIDE', true));
  assert.equal(t.l.facts().released, undefined, 'even with an input just before');
  t.tick(500);
  c.set('SIDE', false);
  assert.equal(t.l.facts().released, undefined, 'an input long ago says nothing');
});

test('WL6: kept across chats: the next chat shown gets the layout once ready; ending gives each its own back', async () => {
  const t = setup({ layouts: [rule('review', { side: { open: true }, bottom: { open: true } })] });
  const a = chat('a'), b = chat('b', { SIDE: true, MODE: 'split' });
  let showing = 'a';
  const { columnsChanged } = await import('../present/bindings/frame-regions.mjs');
  t.show('a', a.node, () => showing === 'a');
  t.show('b', b.node, () => showing === 'b');
  t.l.pick('qa.mod/review');
  assert.deepEqual([a.st.SIDE, a.st.BOT, b.st.BOT], [true, true, false], 'only what is shown');
  showing = 'b';
  columnsChanged(t.ctx);
  assert.deepEqual([b.st.SIDE, b.st.BOT], [true, true]);
  t.l.end();
  assert.deepEqual([a.st.SIDE, a.st.BOT, b.st.SIDE, b.st.BOT], [false, false, true, false], 'each as it was');
});

test('WL6: what could not be as asked is said, region by region; a tab only when absent; keep once releases everything at once', async () => {
  const opened = [];
  const t = setup({ layouts: [rule('tab', { side: { open: true, tab: 'nope' }, main: 'tab', bottom: { open: true } }), rule('once', { side: { open: true }, keep: 'once' })],
    extra: { openTab: (n, kind) => { opened.push(kind); return { unavailable: `no tab kind ${kind} here` }; } } });
  const c = chat('c1', { TAB: null });
  const orig = c.node.set;
  c.node.set = (a, v) => { if (a === 'BOT') return; orig(a, v); };   // this chat has no bottom panel
  t.show('c1', c.node);
  t.l.pick('qa.mod/tab');
  assert.deepEqual(t.l.facts().partial, [{ region: 'side', why: 'no tab kind nope here' }, { region: 'bottom', why: 'this chat has no bottom panel' }, { region: 'main', why: 'there is no tab to fill the workspace' }]);
  assert.deepEqual(opened, ['nope']);
  t.l.pick('qa.mod/once');
  assert.deepEqual(t.l.facts().released, ['side']);
  assert.equal(c.st.SIDE, true);
  t.log.length = 0;
  t.l.end();
  assert.deepEqual(t.log, [], 'nothing is restored');
});

test('WL6: a mod that goes ends its layout; one picked now that is not there is refused', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false } })] });
  const c = chat('c1', { SIDE: true, MODE: 'split' });
  t.show('c1', c.node);
  assert.match(t.l.pick('qa.mod/nope').unavailable, /no layout/);
  t.l.pick('qa.mod/focus');
  t.lists.layouts = [];
  t.l.rulesChanged();
  assert.equal(t.l.facts(), null);
  assert.equal(c.st.SIDE, true, 'given back');
});

test('WL6: the window\'s own regions: the sidebar by its core setter once, given back; the bottom panel\'s place; a mod\'s region; a mode\'s parameters only with no layout', async () => {
  const t = setup({ layouts: [rule('r', { sidebar: { open: false }, bottom: { at: 'right' }, regions: { side1: { open: false }, nope: { open: true } } })] });
  const region = { title: 'R', edge: 'right', width: { default: 300 } };
  t.lists.regions = [{ mod: 'qa.mod', id: 'side1', kind: 'add', presentation: 'Window', slot: 'regions', data: { region }, fns: { region: { ...region, render: () => null } } }];
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/r');
  assert.deepEqual([c.st.BAR, bottomPlacement(t.ctx).at, regionState(t.ctx, declaredRegions(t.ctx)[0]).open], [false, 'right', false]);
  assert.deepEqual(t.l.facts().partial, [{ region: 'qa.mod/nope', why: 'that region is not declared in this window' }]);
  assert.equal(t.l.heldBy('sidebar'), 'qa.mod');
  t.l.end();
  assert.deepEqual([c.st.BAR, bottomPlacement(t.ctx).at, regionState(t.ctx, declaredRegions(t.ctx)[0]).open], [true, 'below', true]);
  // its mod going: the declaration leaves first, and the state it had comes back with it
  const declaredNow = t.lists.regions;
  t.l.pick('qa.mod/r');
  t.lists.regions = []; t.lists.layouts = [];
  t.l.rulesChanged();
  t.lists.regions = declaredNow; t.lists.layouts = [rule('r', { sidebar: { open: false }, bottom: { at: 'right' }, regions: { side1: { open: false }, nope: { open: true } } })];
  assert.equal(regionState(t.ctx, declaredRegions(t.ctx)[0]).open, true);
  assert.equal(t.l.heldBy('sidebar'), null);
  setBottomPlacement(t.ctx, { at: 'below' });
  // a mode's parameters
  t.lists.layoutModes = [{ mod: 'qa.mod', id: 'mode-split', data: { layoutMode: { mode: 'split', bottom: { open: true } } } }];
  c.set('SIDE', true); c.set('MODE', 'split');
  await flush();
  assert.equal(c.st.BOT, true, 'as the mode becomes split');
  t.log.length = 0;
  t.l.noteInput();
  c.set('BOT', false);   // the user's, while in it
  c.set('MODE', 'chat'); await flush(); c.set('MODE', 'split'); await flush();
  assert.deepEqual(t.log, [], 'what the user changed in that mode stays theirs');
});

test('WL6: the where\'s window context: read from the window, refused where it could never hold, unknown without one', () => {
  const inst = { ref: { type: 'Window', provider: 'w', id: '1' }, state: { window: { mode: 'split' } } };
  const c = compileWhere({ window: { mode: 'split' } }, { window: true });
  assert.equal(c.usesWindow, true);
  assert.equal(c.test(inst, { window: () => ({ mode: 'split' }) }), true);
  assert.equal(c.test(inst, { window: () => ({ mode: 'chat' }) }), false);
  assert.equal(c.evaluate(inst, {}), 'unknown');
  assert.equal(compileWhere({ window: { mode: { $in: ['split', 'full'] }, layout: 'a/b' } }, { window: true }).test(inst, { window: () => ({ mode: 'full', layout: 'a/b' }) }), true);
  assert.equal(compileWhere({ window: { mode: { $exists: false } } }, { window: true }).test(inst, { window: () => ({}) }), true, 'no workspace: no mode');
  assert.throws(() => compileWhere({ window: { mode: 'split' } }), /for a presentation/);
  assert.throws(() => compileWhere({ window: { other: 1 } }, { window: true }), /mode\?, layout\?/);
  assert.throws(() => compileWhere({ $or: [{ window: { mode: 'split' } }] }, { window: true }), /at its top/);
  assert.equal(compileWhere({ window: { $exists: true } }).usesWindow, false, 'an operator on a field called window is the field');
});

test('WL6: what a layout and a mode\'s parameters declare', () => {
  assert.equal(layoutWhy({ title: 'A', side: { open: true, size: 400, tab: 'terminal' }, bottom: { at: 'right' }, regions: { r: { open: true } }, main: 'tab', sidebar: { open: false, edge: 'right' }, keep: 'once' }), null);
  assert.equal(layoutWhy({ title: 'A', main: { page: 'p' } }), null);
  assert.match(layoutWhy({ title: 'A' }), /arranges something/);
  assert.match(layoutWhy({ side: {} }), /title/);
  assert.match(layoutWhy({ title: 'A', side: { edge: 'left' } }), /side has no edge/);
  assert.match(layoutWhy({ title: 'A', main: 'grid' }), /main/);
  assert.match(layoutWhy({ title: 'A', main: { page: 'a/b' } }), /main/);
  assert.match(layoutWhy({ title: 'A', bottom: { at: 'top' } }), /below, left or right/);
  assert.match(layoutWhy({ title: 'A', mod: 'x', main: 'chat' }), /has no mod/);
  assert.equal(layoutModeWhy({ mode: 'split', side: { size: 400 } }), null);
  assert.match(layoutModeWhy({ mode: 'grid', side: {} }), /chat, split and full/);
  assert.match(layoutModeWhy({ mode: 'split' }), /parameters/);
});

test('WL6: the user\'s default layout starts a new page, once its mod is here', async () => {
  const lists = { layouts: [], regions: [], layoutModes: [] };
  const ctx = { local: { read() {}, touch() {} }, declared: (p, s) => (p === 'Window' ? lists[s] ?? [] : []), windowChanged() {} };
  const l = createLayouts({ ctx, exports: () => exportsOf([]), startsWith: () => 'qa.mod/focus' });
  const c = chat('c1', { SIDE: true, MODE: 'split' });
  claimBeside(ctx, {}, { key: 'c1', scope: c.node, shown: () => true });
  l.rulesChanged();
  assert.equal(l.facts(), null);
  lists.layouts = [rule('focus', { side: { open: false } })];
  l.rulesChanged();
  assert.equal(l.facts().picked, 'qa.mod/focus');
  assert.equal(c.st.SIDE, false);
  l.end();
  l.rulesChanged();
  assert.equal(l.facts(), null, 'once per page: ended, it stays ended');
  l.dispose();
});

// ------------------------------------------------------------------------------------------------ what was written goes back, and only that

test('WL6: give-back follows what was written: a layout of `main: tab` alone closes the panel it opened; a size and a tab go back too', async () => {
  const shares = { share: 0.4, height: 200 };
  const given = [];
  const opts = { extra: {
    panelOp: sizer(shares),
    openTab: () => ({ id: 'tab-x', opened: true, was: 'tab-a' }), giveTab: (node, tab) => given.push(tab),
  } };
  const t = setup({ ...opts, layouts: [rule('tab', { main: 'tab' }), rule('sized', { side: { open: true, size: 600, tab: 'qa.mod/view' }, bottom: { open: true, height: 300 } })] });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/tab');
  assert.deepEqual([c.st.SIDE, c.st.MODE], [true, 'full']);
  t.l.end();
  assert.deepEqual([c.st.SIDE, c.st.MODE], [false, 'chat'], 'the panel it opened is closed though it never named `side`');
  t.l.pick('qa.mod/sized');
  assert.deepEqual([shares.share, shares.height, c.st.SIDE, c.st.BOT], [0.6, 300, true, true]);
  t.l.end();
  assert.deepEqual([shares.share, shares.height, c.st.SIDE, c.st.BOT], [0.4, 200, false, false]);
  assert.deepEqual(given, [{ target: 'right', id: 'tab-x', opened: true, was: 'tab-a' }]);
});

test('WL6: a divider\'s drag writes no flag: a size that is not what the layout set when an input ends releases that region', async () => {
  const shares = { share: 0.4, height: 200 };
  const t = setup({ layouts: [rule('sized', { side: { open: true, size: 600 }, regions: { r1: { size: 400 } } })], extra: { panelOp: sizer(shares) } });
  const region = { title: 'R', edge: 'right', width: { default: 300, min: 100, max: 900 } };
  t.lists.regions = [{ mod: 'qa.mod', id: 'r1', kind: 'add', presentation: 'Window', slot: 'regions', data: { region }, fns: { region: { ...region, render: () => null } } }];
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/sized');
  t.l.inputEnded();
  assert.equal(t.l.facts().released, undefined, 'an input that moved nothing releases nothing');
  shares.share = 0.55;   // the user's drag of the panel's divider
  t.l.inputEnded();
  assert.deepEqual(t.l.facts().released, ['side']);
  setRegion(t.ctx, 'qa.mod/r1', { size: 500 });   // of the region's
  t.l.inputEnded();
  assert.deepEqual(t.l.facts().released, ['side', 'qa.mod/r1']);
  t.l.end();
  assert.equal(shares.share, 0.55, 'as the user left it');
  assert.equal(regionState(t.ctx, declaredRegions(t.ctx)[0]).size, 500);
});

test('WL6: the app\'s restoration on Back and Forward, and a new scope of a chat it let go of: the layout goes on again; what it gives back stays the first', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false } })] });
  const c = chat('c1', { SIDE: true, MODE: 'split' });
  t.show('c1', c.node);
  t.l.pick('qa.mod/focus');
  assert.equal(c.st.SIDE, false);
  // the app's history puts it back, its marks unchanged
  c.set('SRC', 'restore'); c.set('SIDE', true); c.set('MODE', 'split'); c.set('SRC', undefined);
  assert.equal(c.st.SIDE, true, 'not during the app\'s write');
  await flush();
  assert.equal(c.st.SIDE, false);
  assert.equal(t.l.facts().released, undefined);
  // the app let go of its scope, and made a new one
  const again = chat('c1', { SIDE: true, MODE: 'split' });
  t.show('c1', again.node);
  columnsChanged(t.ctx);
  assert.equal(again.st.SIDE, false, 'a new scope is not one it has seen');
  t.l.end();
  assert.equal(again.st.SIDE, true, 'given back on the scope of now, as it first was');
});

test('WL6: a size waiting for its panel\'s frame is dropped once the region is released or the claim has gone', async () => {
  let drawn = false;
  const sizes = [];
  const t = setup({ layouts: [rule('s', { side: { open: true, size: 600 } })], extra: { panelOp: (binding, op, [v]) => (op === 'resize' ? (drawn ? (sizes.push(v), true) : { unavailable: 'that panel is not drawn here' }) : { unavailable: 'that panel is not drawn here' }) } });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/s');
  t.l.noteInput();
  c.set('SIDE', false);   // the user closes it while its size waits
  assert.deepEqual(t.l.facts().released, ['side']);
  c.set('SIDE', true);
  drawn = true;
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(sizes, [], 'never over what the user has taken');
  assert.equal(t.l.facts().settled, true, 'nor does it wait for ever');
});

test('WL6: what could not be set stays said: a size refused at once; the chat alone closes a split', async () => {
  const t = setup({ layouts: [rule('b', { bottom: { open: true, height: 5 } }), rule('alone', { main: 'chat' })], extra: { panelOp: (binding, op) => (op === 'bottomHeight' ? { unavailable: 'a height from 160 px' } : { unavailable: 'no' }) } });
  const c = chat('c1', { SIDE: true, MODE: 'split' });
  t.show('c1', c.node);
  t.l.pick('qa.mod/b');
  assert.deepEqual(t.l.facts().partial, [{ region: 'bottom', why: 'a height from 160 px' }]);
  t.l.pick('qa.mod/alone');
  assert.deepEqual([c.st.SIDE, c.st.MODE], [false, 'chat']);
  assert.equal(t.l.facts().partial, undefined);
  t.l.end();
  assert.deepEqual([c.st.SIDE, c.st.MODE], [true, 'split']);
});

test('WL6: space (D12): a panel the allocator holds is not reopened, its memory not the user\'s; closed by the layout it is the layout\'s; given back by the allocator the layout goes on', async () => {
  const held = new Set();
  const space = { sideHeld: (n) => held.has(n), takeSide: (n) => held.delete(n), sidebarHeld: () => held.has('bar'), takeSidebar: () => held.delete('bar') };
  const t = setup({ extra: { space }, layouts: [rule('open', { side: { open: true }, sidebar: { open: true } }), rule('closed', { side: { open: false }, sidebar: { open: false } })] });
  const c = chat('c1', { BAR: false });
  t.show('c1', c.node);
  held.add(c.node); held.add('bar');
  t.l.pick('qa.mod/open');
  assert.deepEqual(t.log, [], 'nothing written: open waits for the space');
  assert.equal(t.l.holdsSizes(), false);
  held.delete(c.node);
  c.set('SIDE', true); c.set('SIDE', false);   // the allocator's restore comes in its bracket in the page; here only the space's word matters
  t.l.spaceReturned();
  assert.deepEqual(t.log, [['side', true]], 'the layout goes on as the space comes back');
  t.l.end();
  t.log.length = 0;
  held.add(c.node); held.add('bar');
  t.l.pick('qa.mod/closed');
  assert.equal(held.size, 0, 'closing them makes them the layout\'s');
  assert.deepEqual(t.log, [['sidebar', false], ['side', false]]);
  t.l.end();
  assert.deepEqual(t.log.slice(2), [['side', true], ['sidebar', true]], 'and they were open');
});

test('WL6: a layout\'s sizes say the framework owns the window\'s space (D12), while it holds them', () => {
  const t = setup({ layouts: [rule('s', { side: { open: true, size: 600 } }), rule('o', { side: { open: true } })], extra: { panelOp: () => true } });
  const c = chat('c1');
  t.show('c1', c.node);
  assert.equal(t.l.holdsSizes(), false);
  t.l.pick('qa.mod/o');
  assert.equal(t.l.holdsSizes(), false);
  t.l.pick('qa.mod/s');
  assert.equal(t.l.holdsSizes(), true);
  t.l.noteInput();
  c.set('SIDE', false);
  assert.equal(t.l.holdsSizes(), false, 'released: no longer the layout\'s');
});

// ------------------------------------------------------------------------------------------------ a reload

function storage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
test('WL6: a reload: the claim and its journal go on from the page\'s session storage; the default does not go first; what it gives back is what was there before the layout', async (x) => {
  const store = storage();
  globalThis.sessionStorage = store;
  x.after(() => { delete globalThis.sessionStorage; });
  const first = setup({ layouts: [rule('focus', { side: { open: false }, bottom: { open: false } })] });
  const c = chat('c1', { SIDE: true, BOT: true, MODE: 'split' });
  first.show('c1', c.node);
  first.l.pick('qa.mod/focus');
  first.l.noteInput();
  c.set('BOT', true);   // the user takes the bottom panel
  first.l.dispose();
  assert.ok(store.m.size === 1, 'a page going does not end it');

  // the new page: its mod comes later
  const lists = { layouts: [], regions: [], layoutModes: [] };
  const ctx = { local: { read() {}, touch() {} }, declared: (p, s) => (p === 'Window' ? lists[s] ?? [] : []), windowChanged() {} };
  const log = [];
  const l = createLayouts({ ctx, exports: () => exportsOf(log), startsWith: () => 'qa.mod/other' });
  assert.deepEqual(l.facts(), { picked: 'qa.mod/focus', settled: false, released: ['bottom'] }, 'said while it waits');
  const c2 = chat('c1', { SIDE: true, BOT: true, MODE: 'split' });   // restored from the checkpoint the layout left
  claimBeside(ctx, {}, { key: 'c1', scope: c2.node, shown: () => true });
  lists.layouts = [rule('focus', { side: { open: false }, bottom: { open: false } }), rule('other', { sidebar: { open: false } })];
  l.rulesChanged();
  assert.equal(l.facts().picked, 'qa.mod/focus', 'the default never came first');
  assert.deepEqual(l.facts().released, ['bottom']);
  assert.deepEqual([c2.st.SIDE, c2.st.BOT], [false, true], 'the region the user took stays theirs');
  l.end();
  assert.equal(c2.st.SIDE, true, 'as it was before the layout, though this page never saw that');
  assert.equal(store.m.size, 0, 'ended: nothing to go on from');
  l.dispose();
});

test('WL6: a reload whose mod does not come back: not for ever, and what it wrote on the window goes back', async (x) => {
  const store = storage();
  globalThis.sessionStorage = store;
  x.after(() => { delete globalThis.sessionStorage; });
  const first = setup({ layouts: [rule('r', { bottom: { at: 'right' } })] });
  first.show('c1', chat('c1').node);
  first.l.pick('qa.mod/r');
  first.l.dispose();
  const ctx = { local: { read() {}, touch() {} }, declared: () => [], windowChanged() {} };
  let time = 0;
  const l = createLayouts({ ctx, exports: () => exportsOf([]), now: () => time });
  setBottomPlacement(ctx, { at: 'right' });
  time = 20000;
  l.rulesChanged();
  assert.equal(l.facts(), null);
  assert.equal(bottomPlacement(ctx).at, 'below');
  assert.equal(store.m.size, 0);
  l.dispose();
});

// ------------------------------------------------------------------------------------------------ between mods

test('WL6: the mods\' order decides between mods acting at once; the user\'s own pick always takes it; a mod\'s layout touches only its own', async () => {
  const ahead = { ...rule('a', { side: { open: false } }, 'mod.ahead'), order: 1e6 };
  const behind = { ...rule('b', { side: { open: true } }, 'mod.behind'), order: 5e6 };
  const t = setup({ layouts: [ahead, behind, rule('other', { regions: { 'mod.ahead/r': { open: false } }, side: { tab: 'mod.ahead/view' } }, 'qa.mod')] });
  const c = chat('c1');
  t.show('c1', c.node);
  assert.equal(t.l.pick('mod.ahead/a', { by: 'mod.ahead' }), true);
  assert.match(t.l.pick('mod.behind/b', { by: 'mod.behind' }).unavailable, /comes first in the user's order/);
  assert.equal(t.l.facts().picked, 'mod.ahead/a');
  assert.equal(t.l.pick('mod.behind/b'), true, 'the user\'s pick');
  assert.equal(t.l.pick('mod.ahead/a', { by: 'mod.ahead' }), true, 'one ahead goes first');
  t.l.pick('qa.mod/other');
  assert.deepEqual(t.l.facts().partial.map((p) => p.region).sort(), ['mod.ahead/r', 'side']);
  assert.match(t.l.facts().partial.find((p) => p.region === 'side').why, /another mod's/);
  assert.match(t.l.facts().partial.find((p) => p.region === 'mod.ahead/r').why, /another mod's/);
});

// ------------------------------------------------------------------------------------------------ a mode's parameters

test('WL6: a mode\'s parameters: two that answer each other do not loop; its size waits for its panel; what they wrote goes back as the window leaves that mode', async () => {
  const shares = { share: 0.4 };
  const t = setup({ extra: { panelOp: sizer(shares) } });
  t.lists.layoutModes = [
    { mod: 'qa.mod', id: 'mode-chat', data: { layoutMode: { mode: 'chat', side: { open: true } } } },
    { mod: 'qa.mod', id: 'mode-split', data: { layoutMode: { mode: 'split', side: { open: false } } } },
  ];
  const c = chat('c1');
  t.show('c1', c.node);
  columnsChanged(t.ctx);
  c.set('MODE', 'split');
  for (let i = 0; i < 6; i++) await flush();
  assert.ok(t.log.length <= 2, `they write once, never in turn: ${JSON.stringify(t.log)}`);

  const u = setup({ extra: { panelOp: sizer(shares) } });
  u.lists.layoutModes = [{ mod: 'qa.mod', id: 'mode-split', data: { layoutMode: { mode: 'split', side: { size: 700 }, sidebar: { open: false }, bottom: { at: 'right' } } } }];
  const d = chat('c2', { SIDE: true });
  u.show('c2', d.node);
  columnsChanged(u.ctx);
  d.set('MODE', 'split');
  await flush();
  assert.deepEqual([shares.share, d.st.BAR, bottomPlacement(u.ctx).at], [0.7, false, 'right'], 'its size, its sidebar, its bottom panel\'s place');
  assert.equal(u.l.holdsSizes(), true);
  d.set('MODE', 'chat');
  await flush();
  assert.deepEqual([shares.share, d.st.BAR, bottomPlacement(u.ctx).at], [0.4, true, 'below'], 'all as they were');
});

test('WL6: a layout picked comes first: the parameters go back as it starts, and apply again as it ends', async () => {
  const t = setup({ layouts: [rule('focus', { side: { open: true } })] });
  t.lists.layoutModes = [{ mod: 'qa.mod', id: 'mode-chat', data: { layoutMode: { mode: 'chat', sidebar: { open: false } } } }];
  const c = chat('c1');
  t.show('c1', c.node);
  columnsChanged(t.ctx);
  c.set('MODE', 'split'); await flush(); c.set('MODE', 'chat'); await flush();
  assert.equal(c.st.BAR, false, 'in its mode');
  t.l.pick('qa.mod/focus');
  assert.equal(c.st.BAR, true);
  t.l.end();
  await flush();
  assert.equal(c.st.BAR, false);
});

test('WL6: the picker by the app\'s own controls (D6): the layouts, the one picked marked, and the way back to the app\'s own; nothing with none', () => {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const t = setup({ layouts: [rule('focus', { side: { open: false } }), rule('review', { side: { open: true } })] });
  const c = chat('c1');
  t.show('c1', c.node);
  const ctx = { react: () => React, use: (fn) => fn(), local: { read() {} } };
  const exports = { Button: ({ children, ...p }) => e('button', p, children), Menu: ({ triggerButton, children }) => e('nav', null, triggerButton, children), MenuParts: { Item: ({ children, ...p }) => e('button', p, children) } };
  let layouts = t.l;
  const element = createLayoutPicker({ ctx, exports: () => exports, layouts: () => layouts, contextKey: 'k' });
  const draw = () => { const root = ReactDOM.createRoot({}); root.render(element()); return root; };
  let root = draw();
  assert.match(rootText(root), /^Layoutfocusreview$/);
  findAll(root.tree, (n) => n.props?.['data-codexmods-layout'] === 'qa.mod/focus')[0].props.onClick();
  assert.equal(t.l.facts().picked, 'qa.mod/focus');
  root = draw();
  assert.match(rootText(root), /^focus\u2713 focusreviewThe app's own layout$/);
  findAll(root.tree, (n) => n.props?.['data-codexmods-layout'] === '')[0].props.onClick();
  assert.equal(t.l.facts(), null);
  layouts = { list: () => [] };
  assert.equal(element(), null);
});

// ------------------------------------------------------------------------------------------------ round 2

test('WL6: give-back keeps the full-width preference of a chat that was closed: `main: tab` from there leaves it as it was', () => {
  const t = setup({ layouts: [rule('tab', { main: 'tab' })] });
  const c = chat('c1', { PREF: 'full' });
  t.show('c1', c.node);
  t.l.pick('qa.mod/tab');
  assert.deepEqual([c.st.SIDE, c.st.MODE], [true, 'full']);
  t.l.end();
  assert.deepEqual([c.st.SIDE, c.st.MODE, c.st.PREF], [false, 'chat', 'full']);
  const d = chat('c2', { PREF: 'split' });
  const u = setup({ layouts: [rule('tab', { main: 'tab' })] });
  u.show('c2', d.node);
  u.l.pick('qa.mod/tab');
  u.l.end();
  assert.deepEqual([d.st.SIDE, d.st.MODE, d.st.PREF], [false, 'chat', 'split']);
});

test('WL6: the main region\'s tab holds the side panel too: another mod cannot close it', () => {
  const t = setup({ layouts: [rule('tab', { main: 'tab' }), rule('alone', { main: 'chat' }), rule('paged', { main: { page: 'p' } })], extra: { openPage: () => true } });
  t.show('c1', chat('c1').node);
  t.l.pick('qa.mod/tab');
  assert.deepEqual(t.l.facts().holds, ['side', 'main']);
  t.l.pick('qa.mod/alone');
  assert.deepEqual(t.l.facts().holds, ['side', 'main']);
  t.l.pick('qa.mod/paged');
  assert.deepEqual(t.l.facts().holds, ['main']);
});

test('WL6: Back that changes only which tab is at the front: the layout\'s tab comes back when the app\'s restore ends', async () => {
  const opens = [];
  const t = setup({ layouts: [rule('fronts', { side: { open: true, tab: 'qa.mod/view' } })], extra: { openTab: (n, kind) => { opens.push(kind); return { id: 'tab-x', opened: false, was: null }; } } });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/fronts');
  assert.equal(opens.length, 1);
  c.set('SRC', 'restore');   // its flags as they were
  c.set('SRC', undefined);
  await flush();
  assert.equal(opens.length, 2);
});

test('WL6: a reload after the layout stopped declaring a region: what it wrote there is still the user\'s to take, and not overwritten', async (x) => {
  const store = storage();
  globalThis.sessionStorage = store;
  x.after(() => { delete globalThis.sessionStorage; });
  const first = setup({ layouts: [rule('r', { side: { open: false } })] });
  const c = chat('c1', { SIDE: true, MODE: 'split' });
  first.show('c1', c.node);
  first.l.pick('qa.mod/r');
  first.l.dispose();
  const second = setup({ layouts: [rule('r', { bottom: { open: false } })] });
  const c2 = chat('c1', { SIDE: false });
  second.show('c1', c2.node);
  second.l.rulesChanged();
  assert.equal(second.l.facts().picked, 'qa.mod/r');
  second.l.noteInput();
  c2.set('SIDE', true);    // the user's
  assert.ok(second.l.facts().released.includes('side'));
  c2.set('SIDE', false); c2.set('SIDE', true);
  second.log.length = 0;
  second.l.end();
  assert.equal(second.log.some((e) => e[0] === 'side'), false, 'as the user left it');
  second.l.dispose();
});

/** The page's listeners, with a real target: what a pointer, a key or a message reaches. */
function pageEvents(x) {
  const on = {};
  const add = (t, fn) => { on[t] = fn; };
  globalThis.document = { addEventListener: add, removeEventListener() {} };
  globalThis.window = { addEventListener: add, removeEventListener() {} };
  x.after(() => { delete globalThis.document; delete globalThis.window; });
  return on;
}
const nextTask = () => new Promise((r) => setTimeout(r, 0));

test('WL6: a size told by an input on a divider only: a size that moves with the tab a panel shows is nobody\'s', async (x) => {
  const on = pageEvents(x);
  const shares = { share: 0.4 };
  const t = setup({ layouts: [rule('s', { side: { open: true, size: 600 } })], extra: { panelOp: sizer(shares) } });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/s');
  const composer = { closest: () => null }, divider = { closest: (s) => (s === '[role="separator"]' ? {} : null) };
  shares.share = 0.5;   // a tab of another width
  on.pointerdown({ isTrusted: true, target: composer }); on.pointerup({ type: 'pointerup', isTrusted: true, target: composer });
  on.keyup({ type: 'keyup', isTrusted: true, target: composer });
  await nextTask();
  assert.equal(t.l.facts().released, undefined);
  on.pointerdown({ isTrusted: true, target: divider }); on.pointerup({ type: 'pointerup', isTrusted: true, target: divider });
  await nextTask();
  assert.deepEqual(t.l.facts().released, ['side']);
});

test('WL6: a mod\'s panel message is marked for its own task only: the user\'s change just after it is the user\'s', async (x) => {
  const on = pageEvents(x);
  const t = setup({ layouts: [rule('focus', { side: { open: false } })] });
  const c = chat('c1');
  t.show('c1', c.node);
  t.l.pick('qa.mod/focus');
  on.message({ data: { type: 'toggle-diff-panel', open: true, codexmods: true } });
  c.set('CNT', 1); c.set('SIDE', true);   // the app, handling it, in that task
  assert.equal(t.l.facts().released, undefined);
  await nextTask();
  c.set('SRC', 'layout_command'); c.set('SIDE', false); c.set('SRC', undefined);  // the user's own, a moment later
  assert.deepEqual(t.l.facts().released, ['side']);
});

test('WL6: a tab the user works in is theirs: ending does not close it', async (x) => {
  const on = pageEvents(x);
  const given = [];
  const t = setup({ layouts: [rule('fronts', { side: { open: true, tab: 'qa.mod/view' } })], extra: {
    openTab: () => ({ id: 'tab-x', opened: true, was: 'tab-a', instance: 'i1' }), giveTab: (n, tab) => given.push(tab), frontTab: () => 'tab-x' } });
  t.show('c1', chat('c1').node);
  t.l.pick('qa.mod/fronts');
  const inPanel = { closest: (s) => (s.includes('right-panel') ? { getAttribute: () => 'right-panel' } : null) };
  on.pointerdown({ isTrusted: true, target: inPanel });
  t.l.end();
  assert.deepEqual(given, [{ target: 'right', id: 'tab-x', opened: false, was: null, instance: 'i1' }]);
});

test('WL6: give-back leaves to the allocator what it holds for space, and takes over what is to stay closed', () => {
  const held = new Set();
  const space = { sideHeld: (n) => held.has(n), takeSide: (n) => held.delete(n), sidebarHeld: () => held.has('bar'), takeSidebar: () => held.delete('bar') };
  const t = setup({ extra: { space }, layouts: [rule('open', { side: { open: true }, sidebar: { open: false } })] });
  const was = chat('c1', { SIDE: true, MODE: 'split' });
  t.show('c1', was.node);
  t.l.pick('qa.mod/open');
  held.add(was.node); held.add('bar');   // both go for space meanwhile
  was.st.SIDE = false;
  t.log.length = 0;
  t.l.end();
  assert.deepEqual(t.log, [], 'they were open: the allocator brings them back');
  assert.equal(held.size, 2);

  const u = setup({ extra: { space }, layouts: [rule('open', { side: { open: true } })] });
  held.clear();
  const closed = chat('c2');
  u.show('c2', closed.node);
  u.l.pick('qa.mod/open');
  held.add(closed.node);
  u.log.length = 0;
  u.l.end();
  assert.deepEqual(u.log, [['side', false]], 'it was closed: it stays so, the layout\'s to close');
  assert.equal(held.size, 0);
});

test('WL6: the app\'s own mode picked: the layout goes first; refused there, it is back as it was, what the user took included', () => {
  const t = setup({ layouts: [rule('focus', { side: { open: false }, bottom: { open: false } })] });
  const c = chat('c1', { SIDE: true, BOT: true, MODE: 'split' });
  t.show('c1', c.node);
  t.l.pick('qa.mod/focus');
  t.l.noteInput();
  c.set('BOT', true);
  const out = t.l.toAppMode(() => { assert.equal(t.l.facts(), null); return { unavailable: 'the tab it shows does not fill the workspace' }; });
  assert.match(out.unavailable, /does not fill/);
  assert.equal(t.l.facts().picked, 'qa.mod/focus');
  assert.deepEqual(t.l.facts().released, ['bottom']);
  assert.equal(c.st.SIDE, false, 'applied again');
  assert.equal(t.l.toAppMode(() => true), true);
  assert.equal(t.l.facts(), null);
  assert.equal(c.st.SIDE, true, 'from the first of what it had, not what it wrote');
  assert.equal(t.l.toAppMode(() => 'no layout: just the mode'), 'no layout: just the mode');
});

test('WL6: the mods\' order holds for the app\'s own mode too: a mod behind the holder\'s does not end its layout', () => {
  const ahead = { ...rule('a', { side: { open: false } }, 'mod.ahead'), order: 1e6 };
  const behindRule = { ...rule('b', { side: { open: true } }, 'mod.behind'), order: 5e6 };
  const t = setup({ layouts: [ahead, behindRule] });
  t.show('c1', chat('c1').node);
  t.l.pick('mod.ahead/a', { by: 'mod.ahead' });
  let ran = 0;
  assert.match(t.l.toAppMode(() => { ran++; return true; }, { by: 'mod.behind' }).unavailable, /comes first/);
  assert.equal(ran, 0);
  assert.equal(t.l.facts().picked, 'mod.ahead/a');
  assert.equal(t.l.toAppMode(() => true), true, 'the user\'s own has no say of it');
});

test('WL6: mode parameters: what the user closes goes to the mode that wrote it; a queued entry checks the chat and its scope; its divider\'s drag is the user\'s', async (x) => {
  const on = pageEvents(x);
  const shares = { share: 0.4 };
  const t = setup({ extra: { panelOp: sizer(shares) } });
  t.lists.layoutModes = [{ mod: 'qa.mod', id: 'mode-split', data: { layoutMode: { mode: 'split', side: { size: 700 } } } }];
  const c = chat('c1', { SIDE: true });
  t.show('c1', c.node);
  columnsChanged(t.ctx);
  c.set('MODE', 'split');
  await flush();
  assert.equal(shares.share, 0.7);
  // its divider: the user's size stays when the window leaves the mode
  const divider = { closest: (s) => (s === '[role="separator"]' ? {} : null) };
  shares.share = 0.55;
  on.pointerdown({ isTrusted: true, target: divider }); on.pointerup({ type: 'pointerup', isTrusted: true, target: divider });
  await nextTask();
  t.l.noteInput();
  c.set('CNT', 1); c.set('MODE', 'chat');
  await flush();
  assert.equal(shares.share, 0.55, 'the size the user dragged to');
  // another chat shown before the queued entry runs: the parameters do not land on it
  const log = t.log;
  log.length = 0;
  const u = chat('c2', { SIDE: true });
  c.set('MODE', 'split');   // queued for c1
  const other = {};
  claimBeside(t.ctx, other, { key: 'c2', scope: u.node, shown: () => true });
  await flush();
  assert.equal(u.st.BOT, false);
  assert.equal(shares.share, 0.55, 'nothing was written on the other chat');
});

test('WL6, native: the side panel\'s flag is how the user enters and leaves a mode: its parameters apply each time, go back each time, and only a drag makes the size theirs', async (x) => {
  const on = pageEvents(x);
  const shares = { share: 0.4 };
  const t = setup({ extra: { panelOp: sizer(shares) } });
  t.lists.layoutModes = [{ mod: 'qa.mod', id: 'mode-split', data: { layoutMode: { mode: 'split', side: { size: 700 } } } }];
  const c = chat('c1', {});
  t.show('c1', c.node);
  columnsChanged(t.ctx);
  await flush();
  // as the app writes them after the user's own control: the mode first, then the flag
  const open = async () => { t.l.noteInput(); c.set('MODE', 'split'); c.set('SIDE', true); await flush(); };
  const close = async () => { t.l.noteInput(); c.set('MODE', 'chat'); c.set('SIDE', false); await flush(); };
  await open();
  assert.equal(shares.share, 0.7, 'the user opens the panel: the parameter applies');
  await close();
  assert.equal(shares.share, 0.4, 'closes it: it goes back');
  await open();
  assert.equal(shares.share, 0.7, 'again: a close did not take the parameter away');
  const divider = { closest: (s) => (s === '[role="separator"]' ? {} : null) };
  shares.share = 0.55;
  on.pointerdown({ isTrusted: true, target: divider }); on.pointerup({ type: 'pointerup', isTrusted: true, target: divider });
  await nextTask();
  await close();
  assert.equal(shares.share, 0.55, 'the size the user dragged to stays');
  await open();
  assert.equal(shares.share, 0.55, 'and the parameter does not take it back');
});
