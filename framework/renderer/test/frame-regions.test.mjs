// The mods' regions at the workspace's edges (docs/design/layouts.md D10, §5.1 WL4a): their declarations, their state in a window and the
// width the user keeps, the frame's binding, and the frame host's narrowed shell context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredRegions, regionState, setRegion, regionFacts, boundsOf, FrameHost, bottomPlacement, setBottomPlacement, BESIDE, sidebarEdge, setSidebarEdge, claimBeside, releaseBeside, holdForSpace } from '../present/bindings/frame-regions.mjs';
import { frame, sidebarDivider } from '../present/bindings/frame.mjs';
import { regionWhy } from '../../shared/ui-rules-client.mjs';
import { createFakeReact } from './fake-react.mjs';

const rule = (mod, id, region, render = () => null) => ({ mod, id, kind: 'add', presentation: 'Window', slot: 'regions', data: { region }, fns: { region: { ...region, render } } });
const ctxOf = (rules) => {
  const touched = [];
  return { touched, declared: (p, s) => (p === 'Window' && s === 'regions' ? rules : []), local: { read() {}, touch: (k) => touched.push(k) }, modNode: (r, type, props) => ({ type: 'Mod', rule: r, props }) };
};
/** A motion value as the app's: get, set, on('change'). */
class MV {
  constructor(v) { this.v = v; this.fns = new Set(); }
  get() { return this.v; }
  set(v) { this.v = v; for (const f of this.fns) f(v); }
  on(ev, f) { this.fns.add(f); return () => this.fns.delete(f); }
}

test('WL4a: a region\'s declaration: title, edge, width bounds 160 to 960 px with min <= default <= max', () => {
  assert.equal(regionWhy({ title: 'Notes', edge: 'right' }), null);
  assert.equal(regionWhy({ title: 'Notes', edge: 'left', width: { default: 300, min: 200, max: 400 } }), null);
  for (const [x, why] of [[{ title: 'N', edge: 'top' }, /left or right/], [{ edge: 'left' }, /title/], [{ title: 'N', edge: 'left', width: { default: 100 } }, /160 to 960/],
    [{ title: 'N', edge: 'left', width: { min: 400, max: 300 } }, /min <= default <= max/], [{ title: 'N', edge: 'left', width: { wide: 1 } }, /default\?, min\?, max\?/]]) {
    assert.match(regionWhy(x), why);
  }
  assert.deepEqual(boundsOf({ width: { min: 400 } }), { min: 400, max: 960, default: 400 }, 'the default within the bounds');
});

test('WL4a: a region\'s state in a window: open at its default, set live (within its bounds), kept at the width the user drags to', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    const ctx = ctxOf([rule('unit.r', 'notes', { title: 'Notes', edge: 'right', width: { default: 280, min: 200, max: 480 } }), rule('unit.r', 'bad', { title: 'B', edge: 'up' })]);
    const [r] = declaredRegions(ctx);
    assert.equal(declaredRegions(ctx).length, 1, 'one that is not a region is left out');
    assert.deepEqual(regionState(ctx, r), { open: true, size: 280 });
    assert.equal(setRegion(ctx, 'unit.r/notes', { size: 900 }), true);
    assert.deepEqual(regionState(ctx, r), { open: true, size: 480 }, 'within its bounds');
    setRegion(ctx, 'unit.r/notes', { open: false });
    assert.deepEqual(regionFacts(ctx, () => null), { 'unit.r/notes': { open: false, edge: 'right' } }, 'closed: not drawn');
    setRegion(ctx, 'unit.r/notes', { open: true });
    assert.deepEqual(regionFacts(ctx, (k) => (k === 'unit.r/notes' ? 477.6 : null)), { 'unit.r/notes': { open: true, size: 478, edge: 'right' } }, 'what the window draws, measured');
    assert.deepEqual(regionFacts(ctx, () => null), { 'unit.r/notes': { open: false, edge: 'right', unsupported: 'frame' } }, 'open here but the frame\'s host is not drawn');
    assert.deepEqual(regionFacts(ctxOf([])), {}, 'none declared: an empty set (the last that goes leaves the Window\'s state too)');
    assert.equal(setRegion(ctx, 'unit.r/none', { open: true }), false, 'not declared here');
    assert.ok(ctx.touched.length >= 2, 'its renders follow');
    // another window (another ctx) starts with the width the user kept; a window that drew it before keeps its own
    const other = ctxOf(ctx.declared('Window', 'regions'));
    assert.deepEqual(regionState(other, r), { open: true, size: 280 });
    store.set('codexmods:region-width:unit.r/notes', '333');
    assert.deepEqual(regionState(ctxOf(ctx.declared('Window', 'regions')), r), { open: true, size: 333 });
    assert.deepEqual(regionState(other, r), { open: true, size: 280 }, 'not moved by a width kept since');
  } finally { delete globalThis.localStorage; }
});

test('WL4a: the frame binding always wraps the app\'s column in the host (no remount when a region comes or goes); the host narrows the shell\'s widths for the column', () => {
  const { React } = createFakeReact();
  const factory = (type, props) => ({ type, props });
  const nav = { Provider: 'NavProvider' };
  const none = { ...ctxOf([]), react: () => React, exports: () => ({ navigationShell: nav }) };
  const bare = frame.render('Frame', { children: 'column', footer: null, leftPanelSlot: {} }, factory, none);
  assert.deepEqual([bare.props.children.type, bare.props.children.props.regions], [FrameHost, []], 'no region: the host all the same');
  const ctx = { ...ctxOf([rule('unit.r', 'right', { title: 'R', edge: 'right', width: { default: 300 } }), rule('unit.r', 'left', { title: 'L', edge: 'left', width: { default: 200 } })]),
    react: () => React, exports: () => ({ navigationShell: nav }) };
  const out = frame.render('Frame', { children: 'column', footer: null, leftPanelSlot: {} }, factory, ctx);
  assert.equal(out.props.children.type, FrameHost);
  assert.deepEqual(out.props.children.props.regions.map((r) => [r.key, r.edge, r.size]), [['unit.r/right', 'right', 300], ['unit.r/left', 'left', 200]]);
  assert.equal(frame.render('Frame', { children: 'column' }, factory, { ...ctx, exports: () => ({}) }), undefined, 'a build without the shell\'s context: as it is');
  // the host: the shell's widths less the regions', the left panel's more by the left ones; regions beside the column
  const shell = { mainContentWidth: new MV(1400), workspaceTargetWidth: new MV(1400), leftPanelViewportWidth: new MV(360), sidebarMotion: { closedWidth: 52, visibleWidth: new MV(360) }, shellWidth: new MV(1800) };
  const hooks = { useContext: () => shell, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useEffect() {}, useCallback: (f) => f };
  const R = { ...React, ...hooks };
  const tree = FrameHost({ R, nav, ctx, regions: out.props.children.props.regions, original: 'column' });
  const kids = tree.props.children;
  const provider = kids.find((k) => k.type === 'NavProvider');
  const v = provider.props.value;
  assert.deepEqual([v.mainContentWidth.get(), v.workspaceTargetWidth.get(), v.leftPanelViewportWidth.get(), v.sidebarMotion.closedWidth, v.sidebarMotion.visibleWidth.get(), v.shellWidth],
    [900, 900, 560, 252, 560, shell.shellWidth]);
  shell.mainContentWidth.set(1500);
  assert.equal(v.mainContentWidth.get(), 1000, 'it follows the app\'s value');
  const empty = FrameHost({ R, nav, ctx, regions: [], original: 'column' });
  assert.equal([].concat(empty.props.children).find((k) => k.type === 'NavProvider').props.value, shell, 'no region: the shell\'s context as it is');
  // the region's divider is the app's own (exposure ResizeDivider), on its inner edge; none where it is not exposed
  const Div = function AppDivider() { return null; };
  const withDiv = FrameHost({ R, nav, ctx: { ...ctx, exports: () => ({ navigationShell: nav, ResizeDivider: Div }) }, regions: out.props.children.props.regions, original: 'column' });
  const right = withDiv.props.children.find((k) => k.props?.['data-codexmods-region'] === 'unit.r/right');
  const d = right.props.children.find((k) => k?.type === Div);
  assert.deepEqual([d.props.edge, d.props.minimumSize, d.props.maximumSize, d.props.currentSize], ['left', 160, 960, 300]);
  assert.equal(kids.find((k) => k.props?.['data-codexmods-region'] === 'unit.r/right').props.children.filter((k) => k && k.props?.type !== 'Region').length, 1, 'no divider without the exposure');
  assert.deepEqual(kids.map((k) => (k.type === 'NavProvider' ? 'app' : k.props['data-codexmods-region'])), ['unit.r/left', 'app', 'unit.r/right'], 'left, the app\'s column, right');
  // a shell's context of another shape (no main view width to narrow): no region drawn, the app's arrangement whole (review round 2)
  const odd = FrameHost({ R: { ...R, useContext: () => ({ shellWidth: new MV(1800) }) }, nav, ctx, regions: out.props.children.props.regions, original: 'column' });
  assert.deepEqual([].concat(odd.props.children).map((k) => (k.type === 'NavProvider' ? 'app' : 'region')), ['app']);
});

test('WL4b: the bottom panel beside the chat: this window\'s place and width, a column next to the app\'s while the app has it open, narrowing the shell', () => {
  const { React } = createFakeReact();
  const nav = { Provider: 'NavProvider' };
  const ctx = { ...ctxOf([]), react: () => React, exports: () => ({ navigationShell: nav }) };
  assert.deepEqual(bottomPlacement(ctx), { at: 'below', size: BESIDE.default, open: false, node: null });
  setBottomPlacement(ctx, { at: 'up', size: 99999 });
  assert.deepEqual([bottomPlacement(ctx).at, bottomPlacement(ctx).size], ['below', BESIDE.max], 'a place it does not know: unchanged; a width within its bounds');
  setBottomPlacement(ctx, { at: 'right', size: 500 });
  const shell = { mainContentWidth: new MV(1400), workspaceTargetWidth: new MV(1400) };
  const R = { ...React, useContext: () => shell, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useEffect() {}, useCallback: (f) => f };
  const closed = FrameHost({ R, nav, ctx, regions: [], original: 'column' });
  assert.deepEqual([].concat(closed.props.children).map((k) => k.type), ['NavProvider'], 'closed: no column');
  setBottomPlacement(ctx, { open: true });
  assert.deepEqual([].concat(FrameHost({ R, nav, ctx, regions: [], original: 'column' }).props.children).map((k) => k.type), ['NavProvider'], 'no frame of the panel to own it: no column');
  const owner = {};
  claimBeside(ctx, owner, { key: 'c1', scope: null, shown: () => true });
  const tree = FrameHost({ R, nav, ctx, regions: [], original: 'column' });
  const kids = [].concat(tree.props.children);
  assert.deepEqual(kids.map((k) => (k.type === 'NavProvider' ? 'app' : k.props['data-codexmods-bottom-beside'])), ['app', 'right'], 'beside the app\'s column, on its right');
  assert.equal(kids[0].props.value.mainContentWidth.get(), 900, 'the shell narrowed by its width');
  const inner = [].concat(kids[1].props.children).find((k) => k?.props?.['data-app-shell-focus-area'] === 'bottom-panel');
  assert.equal(inner.props['data-codexmods-bottom-at'], 'right');
  inner.props.ref('NODE');
  assert.equal(bottomPlacement(ctx).node, 'NODE', 'the column the panel\'s content moves into');
  assert.ok(ctx.touched.length > 0);
  releaseBeside(ctx, owner);
  assert.equal(bottomPlacement(ctx).open, false, 'the last frame of the panel gone: nothing open beside');
});

test('WL4c: the sidebar at the right: this window\'s edge; the title bar told the left panel holds only the left regions; its divider on its left edge', () => {
  const { React } = createFakeReact();
  const nav = { Provider: 'NavProvider' };
  const ctx = { ...ctxOf([rule('unit.r', 'left', { title: 'L', edge: 'left', width: { default: 200 } })]), react: () => React, exports: () => ({ navigationShell: nav }) };
  assert.equal(sidebarEdge(ctx), 'left');
  assert.equal(setSidebarEdge(ctx, 'top'), false);
  assert.equal(setSidebarEdge(ctx, 'right'), true);
  assert.equal(sidebarEdge(ctx), 'right');
  const shell = { mainContentWidth: new MV(1400), leftPanelViewportWidth: new MV(360), sidebarMotion: { closedWidth: 54, visibleWidth: new MV(360) } };
  const R = { ...React, useContext: () => shell, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useEffect() {}, useCallback: (f) => f };
  const regions = declaredRegions(ctx).map((r) => ({ ...r, ...regionState(ctx, r) }));
  const v = [].concat(FrameHost({ R, nav, ctx, regions, original: 'column' }).props.children).find((k) => k.type === 'NavProvider').props.value;
  assert.deepEqual([v.leftPanelViewportWidth.get(), v.sidebarMotion.closedWidth, v.sidebarMotion.visibleWidth.get(), v.mainContentWidth.get()], [200, 200, 200, 1200],
    'the left panel is the left regions alone; the main view less the regions (the sidebar\'s width is the app\'s own subtraction)');
  shell.leftPanelViewportWidth.set(306);
  assert.equal(v.leftPanelViewportWidth.get(), 200, 'the sidebar\'s width no longer counts at the left');
  // the divider: on its left edge while the sidebar is at the right, the app's own otherwise
  const factory = (type, props) => ({ type, props });
  assert.equal(sidebarDivider.render('Divider', { setSize() {} }, factory, ctx).props.edge, 'left');
  setSidebarEdge(ctx, 'left');
  assert.equal(sidebarDivider.render('Divider', { setSize() {} }, factory, ctx), undefined);
});


test('WL4 review round 2: the frame host follows what is asked of the window, though what it draws has not changed (a region closed while held for space)', () => {
  const { React } = createFakeReact();
  const nav = { Provider: 'NavProvider' };
  const reg = rule('unit.r', 'r', { title: 'R', edge: 'right', width: { default: 300 } });
  const ctx = { ...ctxOf([reg]), react: () => React, exports: () => ({ navigationShell: nav }) };
  const shell = { mainContentWidth: new MV(1400) };
  const deps = [];
  const R = { ...React, useContext: () => shell, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useCallback: (f) => f, useEffect: (f, d) => { if (d?.length === 3 && d[2] === ctx) deps.push(d); } };
  holdForSpace(ctx, 'regions', true);
  FrameHost({ R, nav, ctx, regions: [], original: 'column' });
  setRegion(ctx, 'unit.r/r', { open: false });
  FrameHost({ R, nav, ctx, regions: [], original: 'column' });
  assert.equal(deps[0][0], deps[1][0], 'what it draws: nothing, both times');
  assert.notEqual(deps[0][1], deps[1][1], 'what is asked moved: its effect (the allocator\'s refresh) runs');
});

test('WL4 review: once beside, the bottom panel\'s content keeps one mount as it moves below, beside and below (never remounted); only the shown chat\'s frame owns the column', async () => {
  const { BottomHost } = await import('../present/bindings/panel.mjs');
  const { React, ReactDOM } = createFakeReact();
  const had = globalThis.document;
  const nodes = [];
  globalThis.document = { createElement: () => { const n = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null }; nodes.push(n); return n; } };
  try {
    let mounts = 0, unmounts = 0;
    const Tab = () => { React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []); return React.createElement('div', null, 'terminal'); };
    const ctx = { ...ctxOf([]), react: () => React, exports: () => ({ reactDom: ReactDOM }) };
    const root = ReactDOM.createRoot({});
    const factory = (type, props) => React.createElement(type, props);
    const Panel = (props) => React.createElement('section', { 'data-app-panel': true }, props.children);
    const draw = () => root.render(React.createElement(BottomHost, { R: React, D: ReactDOM, ctx, Original: Panel, props: { isVisible: true, children: React.createElement(Tab) }, factory }));
    draw(); root.rerender();
    assert.equal(mounts, 1);
    setBottomPlacement(ctx, { at: 'right' });
    setBottomPlacement(ctx, { node: { appendChild() {} } });
    root.rerender();
    const tops = () => (Array.isArray(root.tree) ? root.tree : [root.tree]).filter(Boolean).map((n) => n.type).filter((t) => t !== 'span');   // the column's marker stays
    assert.deepEqual(tops(), [], 'beside: the app\'s panel below is not drawn');
    setBottomPlacement(ctx, { at: 'below' });
    root.rerender();
    assert.deepEqual(tops(), ['section'], 'below again: the app\'s panel');
    assert.deepEqual([mounts, unmounts], [1, 0], 'the content mounted once through every move');
    assert.equal(root.portals.size, 1, 'one container');
    assert.equal([...root.portals.keys()][0], nodes[0]);
  } finally { globalThis.document = had; }
});
