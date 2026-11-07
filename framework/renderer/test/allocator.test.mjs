// The window's space (docs/design/layouts.md D12, §5.1 WL4d): the allocator owns the narrow-window handler's answer only while an arrangement
// of the framework's is active; it gives up the mods' regions, the bottom panel beside, the side panel and the sidebar in that order and
// gives them back in reverse with a margin; what the user changes is theirs; with no arrangement left it gives everything back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAllocator } from '../present/allocator.mjs';
import { setRegion, setBottomPlacement, setSidebarEdge, spaceHeld, suspendedFacts, claimBeside, releaseBeside, columnsChanged } from '../present/bindings/frame-regions.mjs';

const rule = (mod, id, region) => ({ mod, id, kind: 'add', presentation: 'Window', slot: 'regions', data: { region }, fns: { region: { ...region, render: () => null } } });

function setup({ regions = [], sidebar = { open: true, width: 360, rail: 54 }, side = true, sideWidth = 320, ratio = null, mode = 'split' } = {}) {
  const ctx = { declared: (p, s) => (p === 'Window' && s === 'regions' ? regions : []), local: { read() {}, touch() {} } };
  const atoms = { sideOpen: 'SIDE', remembered: 'MEM', sidebarWidth: 'SBW', sidebarOpen: 'SBO' };
  const state = { SIDE: side, MEM: null, SBW: sidebar.width, SBO: sidebar.open, MODE: mode };
  const calls = [];
  const responsive = {
    get sideOpen() { return atoms.sideOpen; }, get remembered() { return atoms.remembered; }, get sidebarOpen() { return atoms.sidebarOpen; },
    // the chat's own atoms (each scope its `st`, the first chat's `state`)
    closeSide: (sc) => { const st = sc.st ?? state; calls.push('closeSide'); st.MEM = st.SIDE ? 'tabs' : 'closed'; st.SIDE = false; },
    restoreSide: (sc) => { const st = sc.st ?? state; calls.push('restoreSide'); if (st.MEM === 'tabs') st.SIDE = true; st.MEM = null; },
    // the atom follows at once; the page's attribute (dom) only when the test says the render happened
    setSidebar: (scope, open) => { calls.push(`sidebar:${open}`); state.SBO = open; },
  };
  const exports = { responsive, panelMaths: { bounds: (m) => ({ maximum: Math.max(320, m - 352), minimum: Math.min(320, Math.max(320, m - 352)) }) }, windowRegions: { sidebarWidth: atoms.sidebarWidth }, workspaceState: { mode: 'MODE' } };
  // the page's widths: the sidebar's whole box (its rail in it), the side panel's (`sideWidth` when open)
  const dom = { sidebarOpen: () => sidebar.open, railWidth: () => sidebar.rail, sidebarWidth: () => (state.SBO ? sidebar.width : sidebar.rail), sideWidth: () => (state.SIDE ? sideWidth : 0), sideRatio: () => ratio };
  const scope = { value: { conversationId: 'c1' }, get: (a) => state[a] };
  const userSidebar = (open) => { state.SBO = open; sidebar.open = open; };
  const a = createAllocator({ ctx, exports: () => exports, dom });
  return { a, ctx, scope, state, calls, sidebar, userSidebar };
}

test('WL4d: no arrangement of the framework\'s: the app\'s handler runs (undefined), nothing held', () => {
  const { a, ctx, scope } = setup();
  assert.equal(a.handle(900, scope), undefined);
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false });
  assert.equal(a.handle(Number.NaN, scope), undefined, 'not a width: the app\'s');
});

test('WL4d: a mod\'s region open: the allocator answers; too narrow, it gives up the regions, then the side panel, then the sidebar; wider, back in reverse with a margin', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  // base: rail 54 + main 480; sidebar 306 beyond the rail; side panel 320 as drawn; region 300 -> 1460 for everything
  assert.equal(a.handle(1600, scope), true);
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false }, 'room for all');
  a.handle(1300, scope);
  assert.equal(spaceHeld(ctx).regions, true, 'the region first');
  assert.deepEqual(calls, []);
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).side, calls], [true, ['closeSide']], 'then the side panel (the app\'s own close for size)');
  assert.deepEqual(suspendedFacts(ctx), ['m/r', 'side']);
  a.handle(700, scope);
  assert.deepEqual([spaceHeld(ctx).sidebar, calls.at(-1), state.SBO], [true, 'sidebar:false', false], 'then the sidebar (its core setter)');
  a.handle(701, scope);
  assert.equal(spaceHeld(ctx).sidebar, true, 'the page\'s attribute still says open (a render behind): not taken for the user\'s');
  // back: within the margin nothing comes back; past it, in reverse
  a.handle(860, scope);
  assert.equal(spaceHeld(ctx).sidebar, true, 'the sidebar needs 840 + 40');
  a.handle(900, scope);
  assert.deepEqual([spaceHeld(ctx).sidebar, state.SBO, spaceHeld(ctx).side, spaceHeld(ctx).regions], [false, true, true, true], 'the sidebar alone: everything given back together must fit');
  a.handle(1200, scope);
  assert.deepEqual([spaceHeld(ctx).side, state.SIDE, calls.at(-1)], [false, true, 'restoreSide']);
  a.handle(1500, scope);
  assert.equal(spaceHeld(ctx).regions, false);
});

test('WL4d: what the user changes is theirs: a side panel they reopened by hand (the app\'s memory cleared) and a sidebar they opened are not touched again', () => {
  const { a, ctx, scope, state, calls, userSidebar } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  a.handle(700, scope);
  assert.deepEqual(calls, ['closeSide', 'sidebar:false']);
  state.MEM = null; state.SIDE = true;   // the user opened the panel: the app cleared its memory
  userSidebar(true);                      // and the sidebar
  const before = calls.length;
  a.handle(720, scope);
  assert.deepEqual([spaceHeld(ctx).sidebar, spaceHeld(ctx).side, calls.slice(before)], [false, false, []], 'theirs now: not given up again, though it does not fit');
  a.handle(1500, scope);
  assert.equal(calls.slice(before).includes('restoreSide'), false, 'never restored over what the user did');
});

test('WL4d: the bottom panel beside counts and goes before the side panel; with no arrangement left, everything held is given back', () => {
  const { a, ctx, scope, calls, state } = setup();
  claimBeside(ctx, {}, { key: 'c1', scope, shown: () => true });
  setBottomPlacement(ctx, { at: 'right', size: 420, open: true });
  a.handle(1200, scope);
  assert.deepEqual([spaceHeld(ctx).beside, spaceHeld(ctx).side], [true, false], '1200: the panel beside goes below first');
  a.handle(700, scope);
  assert.ok(spaceHeld(ctx).sidebar);
  setBottomPlacement(ctx, { at: 'below' });
  assert.equal(a.handle(700, scope), undefined, 'no arrangement: the app\'s again');
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false });
  assert.deepEqual([...calls.slice(-2)].sort(), ['restoreSide', 'sidebar:true'], 'given back');
  assert.equal(state.SBO, true);
});

test('WL4d: the sidebar at the right is an arrangement of the framework\'s; a region set while held is held too', () => {
  const { a, ctx, scope } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'left', width: { default: 300 } })] });
  setSidebarEdge(ctx, 'right');
  setRegion(ctx, 'm/r', { open: false });
  assert.equal(a.handle(1600, scope), true, 'the sidebar at the right alone');
  setRegion(ctx, 'm/r', { open: true });
  a.handle(1200, scope);
  assert.deepEqual(suspendedFacts(ctx), ['m/r'], '1200: the region alone');
});

test('WL4d: the side panel is each chat\'s: one closed for space in a chat stays held when the handler asks for another mounted page', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  const other = { value: { conversationId: 'c2' }, get: (x) => (x === 'SIDE' ? false : x === 'MEM' ? null : state[x]) };   // a page kept for later: its panel closed
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).side, calls], [true, ['closeSide']]);
  a.handle(1000, other);
  assert.equal(spaceHeld(ctx).side, true, 'still held: it was this chat\'s panel');
  a.handle(1300, scope);
  assert.deepEqual([spaceHeld(ctx).side, calls.at(-1), state.SIDE], [false, 'restoreSide', true]);
});

test('WL4 review: the side panel is budgeted at the width it is drawn (the app\'s ratio), not its floor', () => {
  const { a, ctx, scope } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })], sideWidth: 600 });
  // 54 + 480 + 306 + 600 = 1440 without the region: at 1200 the side panel goes too
  a.handle(1200, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side], [true, true]);
});

test('WL4 review: with no arrangement left every chat\'s side panel it closed is given back, and dispose does the same; nothing owned without the app\'s setters', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  const st2 = { SIDE: true, MEM: null, SBW: 360, SBO: true };
  const other = { st: st2, value: { conversationId: 'c2' }, get: (x) => (x === 'SBO' ? state.SBO : st2[x]) };
  a.handle(1000, scope);
  a.handle(1000, other);
  assert.equal(calls.filter((c) => c === 'closeSide').length, 2, 'each chat\'s panel closed for space');
  setRegion(ctx, 'm/r', { open: false });
  a.handle(1000, scope);
  assert.equal(calls.filter((c) => c === 'restoreSide').length, 2, 'both given back');
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false });
  setRegion(ctx, 'm/r', { open: true });
  a.handle(700, scope);
  a.dispose();
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false }, 'the page going: given back');
  assert.equal(state.SBO, true);
  const bare = createAllocator({ ctx, exports: () => ({}), dom: { sidebarOpen: () => true, railWidth: () => 0, sidebarWidth: () => 0, sideWidth: () => 0 } });
  assert.equal(bare.handle(700, scope), undefined, 'without the app\'s setters: the app\'s thresholds');
});

test('WL4 review, native: the handler\'s scope is a new object at each call: a chat is known by its route', () => {
  const { a, ctx, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  const fresh = () => ({ value: { conversationId: 'c1' }, get: (x) => state[x] });
  a.handle(1000, fresh());
  assert.deepEqual([spaceHeld(ctx).side, calls], [true, ['closeSide']]);
  a.handle(1800, fresh());
  assert.deepEqual([spaceHeld(ctx).side, calls.at(-1), state.SIDE], [false, 'restoreSide', true]);
});

test('WL4 review, native: the side panel counted as the app draws it, a share between its bounds: the least main view whose chat keeps 480 px', () => {
  // ratio 0.5, bounds {320, M - 352}: the panel 320 + (M - 672) / 2, the chat M / 2 + 16 >= 480 at M = 928: the panel needs 448 more
  const { a, ctx, scope } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })], sideWidth: 700, ratio: 0.5 });
  a.handle(1580, scope);
  assert.equal(spaceHeld(ctx).regions, true, '54 + 480 + 448 + 306 + 300 = 1588 > 1580');
  a.handle(1620, scope);
  assert.equal(spaceHeld(ctx).regions, true, 'within the margin');
  a.handle(1630, scope);
  assert.equal(spaceHeld(ctx).regions, false, 'the panel would narrow to its share: the region fits');
});

test('WL4 review round 2: a share that leaves the chat under 480 px at any width is the user\'s: the app\'s own chat minimum holds, never the panel\'s floor alone', () => {
  // ratio 1, bounds {320, M - 352}: the chat is 352 at every width from 672: the main view needs 672, so the panel counts 192 beyond the 480
  const { a, ctx, scope } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })], sideWidth: 700, ratio: 1 });
  a.handle(1100, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side], [true, false], '54 + 672 + 306 = 1032 fits without the region; 1332 does not');
  a.handle(1000, scope);
  assert.equal(spaceHeld(ctx).side, true, '1032 > 1000: the panel goes');
});

test('WL4 review round 2: a region closed while held for space is followed: the frame\'s asked arrangement moves, the allocator hands back with nothing left', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side], [true, true]);
  setRegion(ctx, 'm/r', { open: false });
  assert.equal(a.handle(a.last.width, a.last.scope), undefined, 'as onArrangement does: no arrangement left, the app\'s again');
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side, calls.at(-1), state.SIDE], [false, false, 'restoreSide', true]);
});

test('WL4 review, native: the app keeps other pages\' columns live out of sight: only the shown one shares the window out, each coming into sight re-shares it', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  // Home, kept out of sight, its panel closed; the chat shown, its panel open: as natively, Home's handler runs first at each width
  const home = { value: { pathname: '/' }, get: (x) => (x === 'SIDE' ? false : x === 'MEM' ? null : state[x]) };
  const shown = { home: false, chat: true };
  const hTok = {}, cTok = {};
  claimBeside(ctx, hTok, { key: '/', scope: home, shown: () => shown.home });
  claimBeside(ctx, cTok, { key: 'c1', scope, shown: () => shown.chat });
  assert.equal(a.handle(1000, home), true, 'out of sight: told the framework owns the window');
  assert.deepEqual([spaceHeld(ctx).regions, calls], [false, []], 'and nothing is shared out for it');
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side, calls], [true, true, ['closeSide']]);
  a.handle(1300, home);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side], [true, true], 'Home, with no panel, gives nothing back in the chat\'s place');
  a.handle(1300, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side, state.SIDE], [true, false, true], 'the chat: its panel back, the region not yet');
  // the user goes to Home: the window is shared out for what it shows now, with no width change
  shown.home = true; shown.chat = false;
  columnsChanged(ctx);
  assert.equal(spaceHeld(ctx).regions, false, 'Home has no panel: the region fits');
  shown.home = false; shown.chat = true;
  columnsChanged(ctx);
  assert.equal(spaceHeld(ctx).regions, true, 'back to the chat: held again');
  releaseBeside(ctx, hTok); releaseBeside(ctx, cTok);
});

test('WL4 review, native: a sidebar just reopened is budgeted at the app\'s width atom, not its box (a render behind): the side panel does not come back early', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })], ratio: 0.245 });
  a.handle(700, scope);
  assert.deepEqual([spaceHeld(ctx).side, spaceHeld(ctx).sidebar, state.SBO], [true, true, false]);
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).sidebar, state.SBO, spaceHeld(ctx).side, calls.at(-1)], [false, true, true, 'sidebar:true'], 'the sidebar back; its box is still the rail in a real page');
  state.SBW = 500;   // the user's wider sidebar while it is held counts too
  a.handle(1100, scope);
  assert.equal(spaceHeld(ctx).side, true, 'the panel needs what the atom says the sidebar takes');
});

test('WL4 review, native: a caller that is not the shown column never shares the window out, whether or not it has a column of its own', () => {
  const { a, ctx, scope, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  const unregistered = { value: { pathname: '/' }, get: () => false };
  const tok = {};
  claimBeside(ctx, tok, { key: 'c1', scope, shown: () => true });
  assert.equal(a.handle(1000, unregistered), true, 'told the framework owns the window');
  assert.deepEqual([spaceHeld(ctx).regions, calls], [false, []], 'nothing shared out for it');
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).regions, calls], [true, ['closeSide']]);
  releaseBeside(ctx, tok);
  assert.equal(a.handle(1000, unregistered), true, 'no column known as shown: the caller is taken as what the window shows');
  assert.equal(spaceHeld(ctx).regions, false, 'and shared out for: no panel or sidebar of its own, the region fits');
});

test('layouts, native: a tab filling the workspace is the main view: no width of its own, never closed for space; a region and the sidebar go only for the main view\'s floor', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 350 } })], sideWidth: 1435, mode: 'full' });
  // rail 54 + main 480 + sidebar 306 + region 350 = 1190
  assert.equal(a.handle(1800, scope), true);
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false }, 'room for all: it is not budgeted as a panel beside a chat');
  a.handle(1000, scope);
  assert.deepEqual([spaceHeld(ctx).regions, spaceHeld(ctx).side, calls], [true, false, []], 'the region goes; the tab stays');
  a.handle(700, scope);
  assert.deepEqual([spaceHeld(ctx).sidebar, spaceHeld(ctx).side, state.SIDE, calls], [true, false, true, ['sidebar:false']], 'then the sidebar; still the tab stays');
  a.handle(1800, scope);
  assert.deepEqual(spaceHeld(ctx), { regions: false, beside: false, side: false, sidebar: false }, 'all of it back');
});

test('layouts: a panel the allocator holds, taken by a layout that closes it: the app\'s memory is brought back first, in the bracket, or its own restore would reopen it later', () => {
  const { a, ctx, scope, state, calls } = setup({ regions: [rule('m', 'r', { title: 'R', edge: 'right', width: { default: 300 } })] });
  a.handle(1000, scope);
  assert.deepEqual([a.sideHeld(scope), state.MEM, state.SIDE], [true, 'tabs', false]);
  a.takeSide(scope);
  assert.deepEqual([a.sideHeld(scope), spaceHeld(ctx).side, state.MEM, calls], [false, false, null, ['closeSide', 'restoreSide']], 'no longer held, no memory left');
});
