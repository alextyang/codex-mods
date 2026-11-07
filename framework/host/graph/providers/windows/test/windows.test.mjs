// The windows provider (docs/design/systems.md S10, "E2c in detail"): a window's presentations as graph instances under its page's
// generation, their parents from the places their bindings state, the Window's current view and history, the events, and acting through
// the owning window (a stale ref refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { createPolicy } from '../../../policy.mjs';
import { defineConcept, r, s, toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { PRESENTATION_TYPES } from '../../../../../../sdk/graph/presentations.mjs';
import { createWindowsSource, refs, PROVIDER } from '../index.mjs';
import { askFieldsOf } from '../../../../packages/settings.mjs';

const USER = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });
const UThread = defineConcept('UThread', { state: { title: s.string() } });
const UTurn = defineConcept('UTurn', { relations: { thread: r.one('UThread') } });
// A message's turn may change (as a thread's project does), and may not be resident when the message is.
const UMsg = defineConcept('UMsg', { relations: { turn: r.one('UTurn') } });
const ref = (type, id) => ({ type, provider: 'unit', id });
const T1 = ref('UThread', 't1'), U1 = ref('UTurn', 'u1'), U2 = ref('UTurn', 'u2'), M1 = ref('UMsg', 'm1'), M2 = ref('UMsg', 'm2');

function setup({ grants = {}, showDetail, routes, timers, extra, observe, focused = null, menu = null, results = {} } = {}) {
  const policy = createPolicy({ grantsOf: (id) => grants[id] ?? [], typeOf: (t) => graph.type(t) });
  const graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  graph.registerTypes(PRESENTATION_TYPES.map(toDescriptor), 'native');
  graph.registerTypes([UThread, UTurn, UMsg].map(toDescriptor), 'mod:unit');
  const unit = graph.registerProvider('mod:unit', 'unit', { types: { UThread: {}, UTurn: {}, UMsg: {} } });
  unit.put(T1, { state: { title: 'One' } });
  unit.put(U1, { links: { thread: T1 } });
  unit.put(M1, { links: { turn: U1 } });
  const codex = graph.registerProvider('native', 'codex', { types: { App: {}, ...(extra ?? {}) }, ...(observe ? { onObserve: (q) => observe(q, codex) } : {}) });
  codex.put(refs.app(), { state: { version: '1' }, links: { theme: { type: 'Theme', provider: 'codex', id: 'codex' } } });
  const ops = [];
  const reportTo = new Map();
  const mainOps = {
    op: async (area, op, args) => {
      if (op === 'focused') return { ok: true, result: { windowId: focused } };
      if (area === 'menus' && op === 'entries') return { ok: true, result: { entries: menu?.entries ?? [] } };   // the app's menu bar entries (E8.4b)
      ops.push([area, op, args]);
      return menu?.answer && area === 'menus' ? menu.answer(op, args) : { ok: true, ...(results[op] ? { result: results[op] } : {}) };
    },
    onReport: (area, fn) => { reportTo.set(area, fn); return { dispose() { reportTo.delete(area); } }; },
  };
  const topics = new Map();
  const published = [];
  const bus = { subscribe: (t, fn) => { topics.set(t, fn); return { dispose() { topics.delete(t); } }; }, publish: (t, d) => published.push([t, d]) };
  const w = createWindowsSource({ graph, mainOps, bus, ...(showDetail ? { showDetail } : {}), ...(routes ? { routes } : {}), ...(timers ?? {}) });
  const events = [];
  graph.subscribe({ type: 'Presentation' }, (m) => { if (m.type === 'delta' && m.event.kind === 'event') events.push(`${m.event.ref.type}.${m.event.name}`); return true; });
  return { graph, unit, codex, w, ops, events, bus: (t, d) => topics.get(t)?.(d), report: (area, r) => reportTo.get(area)?.(r), published };
}
const P = (n, type, subject, place, extra = {}) => ({ n, type, subject, place, slot: extra.slot ?? '', hidden: false, decorations: [], ...extra });
/** A page's first report: its window's facts (the Window is put then), and its first presentations. */
const opened = (w, id, puts = []) => { const gen = w.open(id); w.report(id, gen, { puts, window: { sidebar: { open: true } } }); return gen; };
const parentOf = (g, id) => g.resolve({ type: 'Presentation', provider: PROVIDER, id })?.links.parent?.id ?? null;

test('a window\'s presentations: the Window first, then each presentation under its parent, found from the place its binding states', () => {
  const { graph, w, events } = setup();
  const gen = w.open(7);
  assert.equal(graph.resolve(refs.window(7)), null, 'not before its page says whether its sidebar is open');
  w.report(7, gen, { puts: [], window: { sidebar: { open: true } } });
  const win = graph.resolve(refs.window(7));
  assert.equal(win.links.subject.type, 'App');
  assert.deepEqual([win.state.current, win.state.history, win.state.sidebar.open, win.state.side.open], [null, [], true, false], 'no SidePanel presented: closed');
  // A message before its turn: no parent yet (never a guess), found once the turn is presented.
  w.report(7, gen, { puts: [P(4, 'MessageBlock', M1, { in: 'TurnView', via: 'turn' }, { slot: 'messages' })] });
  assert.equal(parentOf(graph, `7.${gen}.4`), null);
  w.report(7, gen, { puts: [
    P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }),
    P(2, 'ThreadHeader', T1, { in: 'ThreadView' }, { slot: 'header' }),
    P(3, 'TurnView', U1, { in: 'ThreadView', via: 'thread' }, { slot: 'transcript' }),
  ] });
  assert.equal(parentOf(graph, `7.${gen}.1`), '7');
  assert.equal(parentOf(graph, `7.${gen}.2`), `7.${gen}.1`, 'the same subject');
  assert.equal(parentOf(graph, `7.${gen}.3`), `7.${gen}.1`, 'the turn\'s thread');
  assert.equal(parentOf(graph, `7.${gen}.4`), `7.${gen}.3`, 'the message\'s turn, now presented');
  // Every instance's presentations, and the tree from the Window.
  // (the window's main region presents what it shows, its frame's regions are its children too: layouts.md D1)
  assert.deepEqual(graph.related(T1, 'presentations').map((x) => x.ref.type).sort(), ['MainRegion', 'ThreadHeader', 'ThreadView']);
  assert.deepEqual(graph.related(refs.window(7), 'children').map((x) => x.ref.type).sort(), ['BottomPanel', 'MainRegion', 'ThreadView', 'TitleBar']);
  assert.deepEqual(graph.related(refs.app(), 'windows').map((x) => x.ref.id), ['7'], 'App.windows: the Windows that present it');
  // The main view's subject is the window's current view.
  const now = graph.resolve(refs.window(7)).state;
  assert.deepEqual(now.current, T1);
  assert.deepEqual(now.history, [T1]);
  assert.ok(events.includes('Window.opened') && events.includes('Window.navigated'));
  // A parent that goes: its children have none (or another presentation of the same subject).
  w.report(7, gen, { removes: [3] });
  assert.equal(parentOf(graph, `7.${gen}.4`), null);
  assert.equal(w.stats().presentations, 3);
});

test('parents follow the graph: a subject not resident yet, a parent subject that is not resident, a link that changes, a missing relation', () => {
  const { graph, unit, w } = setup();
  const gen = opened(w, 7, [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }), P(2, 'TurnView', U1, { in: 'ThreadView', via: 'thread' }), P(5, 'MessageBlock', M2, { in: 'TurnView', via: 'turn' })]);
  assert.equal(parentOf(graph, `7.${gen}.5`), null, 'its subject is not resident yet');
  assert.equal(w.stats().orphans, 1);
  unit.put(M2, { links: { turn: U1 } });
  assert.equal(parentOf(graph, `7.${gen}.5`), `7.${gen}.2`, 'found when the subject arrives, without another report');
  // The parent's subject need not be resident: the subject's link names it.
  const U3 = ref('UTurn', 'u3'), M3 = ref('UMsg', 'm3');
  unit.put(M3, { links: { turn: U3 } });
  w.report(7, gen, { puts: [P(6, 'TurnView', U3, { in: 'ThreadView', via: 'thread' }), P(7, 'MessageBlock', M3, { in: 'TurnView', via: 'turn' })] });
  assert.equal(parentOf(graph, `7.${gen}.7`), `7.${gen}.6`, 'U3 is not resident, its TurnView is');
  // A link that changes moves the presentation.
  unit.put(U2, { links: { thread: T1 } });
  w.report(7, gen, { puts: [P(3, 'TurnView', U2, { in: 'ThreadView', via: 'thread' })] });
  unit.put(M2, { links: { turn: U2 } });
  assert.equal(parentOf(graph, `7.${gen}.5`), `7.${gen}.3`);
  w.report(7, gen, { puts: [P(8, 'Composer', T1, { in: 'ThreadView', via: 'nope' })] });
  assert.equal(parentOf(graph, `7.${gen}.8`), null, 'the subject\'s type has no such relation');
  assert.equal(w.stats().orphans, 2, 'that one, and U3\'s TurnView (its turn is not resident: its thread is not known)');
});

test('a ref names one subject in one place: a put that changes them removes the presentation; the page numbers a new one', () => {
  const { graph, w } = setup();
  const gen = opened(w, 7, [P(1, 'SidebarItem', T1, { in: null })]);
  const old = { type: 'SidebarItem', provider: PROVIDER, id: `7.${gen}.1` };
  w.report(7, gen, { puts: [P(1, 'SidebarItem', { type: 'UThread', provider: 'unit', id: 'other' }, { in: null })] });
  assert.equal(graph.resolve(old)?.gone ?? true, true, 'the ref of the first subject never names the second');
  assert.equal(w.stats().presentations, 0);
});

test('events: hidden and shown as a rule hides it, selected when it becomes selected, acted for a user action, in order', () => {
  const { w, events } = setup();
  const gen = opened(w, 7, [P(1, 'SidebarItem', T1, { in: null }, { selected: false })]);
  w.report(7, gen, { puts: [P(1, 'SidebarItem', T1, { in: null }, { hidden: true, selected: true, decorations: [{ by: 'unit.a', kind: 'badge', rule: 'b' }, { by: 'x', kind: 'nope', rule: 'y' }] })] });
  w.report(7, gen, { puts: [P(1, 'SidebarItem', T1, { in: null }, { selected: true })] });
  assert.equal(w.acted(7, gen, [{ n: 1, operation: 'action', action: 'unit.a/b/0' }, { n: 99, operation: 'action' }]), 1);
  assert.deepEqual(events.filter((e) => e.startsWith('SidebarItem')), ['SidebarItem.hidden', 'SidebarItem.selected', 'SidebarItem.shown', 'SidebarItem.acted']);
});

test('a reload is a new generation: the old one\'s presentations are gone, its reports ignored and its refs refused; a window that closes goes', async () => {
  const { graph, w, events, bus } = setup();
  const channel = {};
  const g1 = w.open(7, channel);
  w.report(7, g1, { puts: [P(1, 'SidebarItem', T1, { in: null })], window: { sidebar: { open: true } } });
  const old = { type: 'SidebarItem', provider: PROVIDER, id: `7.${g1}.1` };
  const g2 = w.open(7, {});
  assert.notEqual(g1, g2);
  assert.equal(w.report(7, g1, { puts: [P(2, 'SidebarItem', T1, { in: null })] }), false, 'a stale generation');
  assert.equal(w.stats().presentations, 0);
  const out = await graph.invoke({ ref: old, operation: '_select', caller: USER });
  assert.equal(out.status, 'refused');
  assert.match(out.message, /gone/);
  w.closeChannel(channel);   // the old page's channel closing late does not touch the new generation
  w.report(7, g2, { puts: [P(1, 'SidebarItem', T1, { in: null })] });
  assert.equal(w.stats().presentations, 1);
  bus('window/fullScreen', { windowId: 7, value: true });
  assert.equal(graph.resolve(refs.window(7)).state.fullScreen, true);
  w.report(7, g2, { puts: [], window: { sidebar: { open: false } } });
  assert.equal(graph.resolve(refs.window(7)).state.sidebar.open, false);
  bus('window/fullScreen', { windowId: 8, value: true });   // before its page reports
  opened(w, 8);
  assert.equal(graph.resolve(refs.window(8)).state.fullScreen, true);
  bus('window/closed', { windowId: 7 });
  assert.equal(graph.resolve(refs.window(7))?.gone ?? true, true);
  assert.equal(w.stats().windows, 1, 'window 8 stays');
  assert.ok(events.includes('Window.closed'));
});

test('H8d: a window\'s composers\' attachments are told on the bus when they change, and let go when its page goes', () => {
  const { w, published } = setup();
  const gen = opened(w, 7);
  const drafts = { t1: [{ id: 'image:a', kind: 'image', name: 'a.png' }] };
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, attachments: drafts } });
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, attachments: drafts } });
  w.close(7, gen);
  assert.deepEqual(published.filter(([t]) => t === 'window/attachments'), [['window/attachments', { windowId: 7, drafts }], ['window/attachments', { windowId: 7, drafts: {} }]], 'once per change');
  w.dispose();
});

test('Window.openBrowser: the app opens the page in a new tab of its browser; that BrowserTab (once listed) is the answer', async () => {
  const { graph, w, ops, codex } = setup({ extra: { BrowserTab: {} }, results: { openBrowser: { browserTabId: 'b-2' } } });
  opened(w, 7);
  const tab = (id, url) => [{ type: 'BrowserTab', provider: 'codex', id }, { state: { url, title: id, loading: false, canGoBack: false, canGoForward: false, controlledBy: 'you' } }];
  codex.put(...tab('chat:b-1', 'https://old.example/'));
  setTimeout(() => { codex.put(...tab('chat:b-3', 'https://other.example/')); codex.put(...tab('chat:b-2', 'https://example.com/')); }, 50);
  const r = await graph.invoke({ ref: refs.window(7), operation: 'openBrowser', args: ['https://example.com/'], caller: USER });
  assert.deepEqual(r.value, { type: 'BrowserTab', provider: 'codex', id: 'chat:b-2' }, 'the tab framework-main named, not another new one');
  assert.deepEqual(ops.at(-1), ['windows', 'openBrowser', { windowId: 7, url: 'https://example.com/' }]);
  w.dispose();
});

test('App.openWindow: a new window asked of the app, on a chat or its home; anything else opens in it once its page reports', async () => {
  const { graph, w, ops, bus, codex } = setup({ extra: { CodexThread: {} } });
  const th1 = { type: 'CodexThread', provider: 'codex', id: 'th-1' }, home = { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' };
  codex.put(th1, { state: { title: 'One', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 },
    links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
  opened(w, 7);
  // a new window: created, then its page reports what its main view shows
  const arrive = (id, shows = th1) => setTimeout(() => { bus('window/created', { windowId: id }); setTimeout(() => opened(w, id, [P(1, shows.type === 'Draft' ? 'NewThreadView' : 'ThreadView', shows, { in: 'Window' }, { slot: 'main' })]), 30); }, 30);
  arrive(9);
  const chat = await w.openWindow({ type: 'CodexThread', provider: 'codex', id: 'th-1' }, { caller: USER });
  assert.deepEqual(chat, { status: 'done', value: refs.window(9) });
  assert.deepEqual(ops, [['windows', 'newWindow', { path: '/local/th-1' }]]);
  arrive(10, th1);   // the user's own new window on the same chat, before the asked one: the asked one shows the home
  arrive(11, home);
  const settings = await w.openWindow({ type: 'SettingsSection', provider: 'codex', id: 'git' }, { caller: USER });
  assert.deepEqual(settings.value, refs.window(11));
  assert.deepEqual(ops.slice(1), [['windows', 'newWindow', { path: '/' }], ['windows', 'open', { windowId: 11, settings: 'git' }]], 'the home, then the section in it');
  assert.equal((await w.openWindow({ type: 'CodexThread', provider: 'qa.test-agent', id: 'hidden' })).reason, 'unavailable');
  assert.equal((await w.openWindow({ type: 'CodexThread', provider: 'codex', id: 'th-unknown' })).reason, 'unavailable', 'a chat the graph does not know');
  assert.equal((await w.openWindow('nope')).reason, 'invalid');
  // a ref to the concept names the chat too (its resident CodexThread)
  arrive(12, th1);
  assert.deepEqual((await w.openWindow({ type: 'Thread', provider: 'codex', id: 'th-1' }, { caller: USER })).value, refs.window(12));
  assert.equal(ops.length, 4);
  assert.ok(graph.resolve(refs.window(11)));
  // Window.open(ref, {placement: 'window'}): the same new window, asked through the window the call names
  arrive(13, th1);
  const placed = await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'CodexThread', provider: 'codex', id: 'th-1' }, { placement: 'window' }], caller: USER });
  assert.deepEqual([placed.value, ops.at(-1)], [refs.window(13), ['windows', 'newWindow', { path: '/local/th-1' }]]);
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'CodexThread', provider: 'codex', id: 'th-1' }, { placement: 'split' }], caller: USER })).reason, 'invalid');
});

test('acting: through the window that owns the presentation, the app\'s way; what a window cannot open is refused; a mod needs graph.act', async () => {
  const { graph, w, ops } = setup({ grants: { 'unit.a': ['graph.act:SidebarItem._select'] } });
  const codexThread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const gen = opened(w, 7, [P(1, 'SidebarItem', codexThread, { in: null }), P(2, 'Composer', { type: 'Draft', provider: 'codex', id: 'th-1' }, { in: null })]);
  const item = { type: 'SidebarItem', provider: PROVIDER, id: `7.${gen}.1` };
  assert.equal((await graph.invoke({ ref: item, operation: '_select', caller: mod('unit.a') })).status, 'done');
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'focus', caller: USER })).status, 'done');
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'toggleSidebar', caller: USER })).status, 'done');
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'SettingsSection', provider: 'codex', id: 'git' }], caller: USER })).status, 'done');
  assert.equal((await graph.invoke({ ref: { type: 'Composer', provider: PROVIDER, id: `7.${gen}.2` }, operation: '_focus', caller: USER })).status, 'done');
  assert.deepEqual(ops, [
    ['windows', 'open', { windowId: 7, threadId: 'th-1' }], ['windows', 'focus', { windowId: 7 }], ['windows', 'toggleSidebar', { windowId: 7 }],
    ['windows', 'open', { windowId: 7, settings: 'git' }], ['windows', 'focusComposer', { windowId: 7 }],
  ]);
  // setSidebar toggles only when the sidebar is not as asked (its page said open); setPanel tells the app's toggle which
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'setSidebar', args: [true], caller: USER })).status, 'done');
  assert.equal(ops.length, 5, 'already open: nothing');
  // two calls before the page reports: the second waits for the first, which is done once the page says the sidebar closed
  setTimeout(() => w.report(7, gen, { puts: [], window: { sidebar: { open: false } } }), 120);
  const twice = await Promise.all([0, 1].map(() => graph.invoke({ ref: refs.window(7), operation: 'setSidebar', args: [false], caller: USER })));
  assert.deepEqual(twice.map((r) => r.status), ['done', 'done']);
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'setPanel', args: [true], caller: USER })).status, 'done');
  assert.deepEqual(ops.splice(5), [['windows', 'toggleSidebar', { windowId: 7 }], ['windows', 'setPanel', { windowId: 7, open: true }]], 'toggled once');
  // A mod's thread is never opened as one of the app's (its own view is the page's to show: below); with no page to show it, and for
  // anything else the window has no page for, refused.
  const before = ops.length;
  const theirs = await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'TestAgentThread', provider: 'qa.test-agent', id: 'thr-1' }], caller: USER });
  assert.deepEqual([theirs.status, ops.length], ['refused', before], 'no app chat id asked for');
  const odd = await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'Skill', provider: 'codex', id: 'x' }], caller: USER });
  assert.equal(odd.status, 'refused');
  assert.equal(odd.reason, 'unsupported');
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'focus', caller: mod('unit.a') })).reason, 'notAllowed');
  // close (E7.1): framework-main asks the window to close; the app may hide its last window or ask first.
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'close', caller: USER })).status, 'done');
  assert.deepEqual(ops.at(-1), ['windows', 'close', { windowId: 7 }]);
  // A mod named like the provider owns none of its refs (the policy reserves the id).
  assert.equal((await graph.invoke({ ref: item, operation: '_select', caller: mod(PROVIDER) })).reason, 'notAllowed');
});

test('a report is checked: unknown types, Window itself and items without a subject are refused; at most 32 decorations', () => {
  const { w } = setup();
  const gen = opened(w, 7);
  w.report(7, gen, { puts: [
    P(1, 'Nope', T1, { in: null }), P(2, 'Window', T1, { in: null }), { n: 3, type: 'Chip' }, { n: 0, type: 'Chip', subject: T1 },
    P(4, 'Chip', T1, { in: null }, { decorations: Array.from({ length: 40 }, (_, i) => ({ by: 'm', kind: 'badge', rule: `r${i}` })) }),
  ] });
  assert.equal(w.stats().presentations, 1);
  assert.throws(() => w.open('7'), /a number/);
  assert.equal(w.report(8, 1, { puts: [] }), false, 'a window that never opened');
});

test('every instance\'s presentations: a relation the graph serves for any type, observed like any other (04 §8)', () => {
  const { graph, w } = setup();
  const seen = [];
  graph.subscribe({ ref: T1, relation: 'presentations' }, (m) => { seen.push(m.type === 'snapshot' ? `snapshot ${m.items.length}` : m.event.kind); return true; });
  const gen = opened(w, 7);
  w.report(7, gen, { puts: [P(1, 'SidebarItem', T1, { in: null })] });
  w.report(7, gen, { puts: [P(1, 'SidebarItem', T1, { in: null }, { selected: true })] });
  w.report(7, gen, { removes: [1] });
  assert.deepEqual(seen.filter((x) => x !== 'event'), ['snapshot 0', 'added', 'changed', 'removed']);
  assert.throws(() => graph.related(T1, 'nope'), /no relation nope/);
  assert.equal(graph.types().find((t) => t.id === 'Presentation').members.relations.subject.resolved, true, 'a relation to any type is resolved');
});

test('E6.5: the framework\'s own presentations are put read-only under the parent their place names outright (`on`), never as features', async () => {
  const { graph, w } = setup();
  const { FRAMEWORK_TYPES, realizes } = await import('../index.mjs');
  assert.deepEqual(FRAMEWORK_TYPES, ['SettingsRow', 'Dialog', 'NotificationBanner', 'ComposerPicker', 'DetailView', 'Page', 'Region']);
  // Not the app's build: the feature log does not advertise them, except ComposerPicker, which the app's own pickers are too (E7.2).
  assert.ok(FRAMEWORK_TYPES.filter((t) => t !== 'ComposerPicker').every((t) => !realizes.types.includes(t)));
  assert.ok(realizes.types.includes('ComposerPicker'));
  const S1 = ref('UThread', 's1');   // stands for a Setting: no link to the page's subject
  const gen = opened(w, 7, [
    P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }),
    P(2, 'SettingsRow', S1, { in: 'ThreadView', on: T1 }, { slot: 'settings' }),
    P(3, 'Dialog', T1, { in: 'Window' }, { slot: 'consent' }),
    P(4, 'NotificationBanner', U1, { in: 'Window' }, { slot: 'banner' }),
    P(5, 'ComposerPicker', S1, { in: 'ThreadView', on: { type: 'UThread', provider: 'unit', id: 'nowhere' } }, { slot: 'pickers' }),
  ]);
  assert.equal(parentOf(graph, `7.${gen}.2`), `7.${gen}.1`, 'the subject named by `on`');
  assert.equal(parentOf(graph, `7.${gen}.3`), '7');
  assert.equal(parentOf(graph, `7.${gen}.4`), '7');
  assert.equal(parentOf(graph, `7.${gen}.5`), null, 'no presentation of that subject: an orphan, never a guess');
  assert.equal(graph.resolve({ type: 'Presentation', provider: PROVIDER, id: `7.${gen}.3` }).ref.type, 'Dialog');
  const before = w.stats().presentations;
  w.report(7, gen, { puts: [P(6, 'NoSuchType', T1, { in: 'Window' })] });
  assert.equal(w.stats().presentations, before, 'a type neither the app\'s nor the framework\'s is refused');
});

test('E6.6c: Window.open of an instance the app has no page for asks the window\'s page (its own page, a mod\'s chat\'s registered view, or the DetailView); refused when it cannot', async () => {
  const asked = [];
  let can = true;
  const { graph, w } = setup({ showDetail: (windowId, ref) => { asked.push([windowId, ref]); return can; } });
  opened(w, 7);
  const skill = { type: 'Skill', provider: 'codex', id: 'x' };
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [skill], caller: USER })).status, 'done');
  // a mod's chat: its subtype's own view (graph-integrity G2.2), which the page draws
  const chat = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 'thr-1' };
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [chat], caller: USER })).status, 'done');
  assert.deepEqual(asked, [[7, skill], [7, chat]]);
  can = false;
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [skill], caller: USER })).reason, 'unsupported', 'a window whose page cannot');
});

test('E7: an operation only the page can do goes to the page of the presentation\'s generation, which answers it; nothing else answers it', async () => {
  const timers = [];
  const fake = { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
  const { graph, w } = setup({ grants: { 'unit.a': ['graph.act:TurnView'] }, timers: fake });
  const posted = [];
  const page = { post: (m) => posted.push(m) };
  const gen = w.open(7, page);
  w.report(7, gen, { puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }), P(3, 'TurnView', U1, { in: 'ThreadView', via: 'thread' }, { slot: 'transcript' })], window: { sidebar: { open: true } } });
  const turn = { type: 'TurnView', provider: PROVIDER, id: `7.${gen}.3` };
  // Sent to the page as an act; the page's answer is the outcome.
  const done = graph.invoke({ ref: turn, operation: '_collapse', caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map(({ t, gen: g, n, operation, args }) => ({ t, g, n, operation, args })), [{ t: 'act', g: gen, n: 3, operation: 'collapse', args: [] }]);
  assert.ok(posted[0].expires > Date.now() + 4000 && posted[0].expires <= Date.now() + 5000, 'when the page must no longer do it');
  assert.equal(timers[0].ms, 5000);
  assert.equal(w.answer(8, gen, posted[0].id, { ok: true }), false, 'another window\'s page cannot answer it');
  assert.equal(w.answer(7, gen + 1, posted[0].id, { ok: true }), false, 'nor another generation');
  assert.equal(w.answer(7, gen, posted[0].id, { ok: true }), true);
  assert.equal((await done).status, 'done');
  assert.equal(timers.length, 0, 'its wait is over');
  assert.equal(w.answer(7, gen, posted[0].id, { ok: true }), false, 'answered once');
  // Refused or failed as the page says.
  const refused = graph.invoke({ ref: turn, operation: '_expand', caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted[1].id, { refused: 'unavailable', message: 'this TurnView cannot expand here' });
  assert.deepEqual(await refused.then((o) => [o.status, o.reason, o.message]), ['refused', 'unavailable', 'this TurnView cannot expand here']);
  const failed = graph.invoke({ ref: turn, operation: '_collapse', caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted[2].id, { failed: 'it threw' });
  assert.deepEqual(await failed.then((o) => [o.status, o.error?.message]), ['failed', 'it threw']);
  // A page that does not answer: failed after its wait.
  const silent = graph.invoke({ ref: turn, operation: '_collapse', caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  timers[0].fn();
  assert.deepEqual(await silent.then((o) => [o.status, o.error?.message]), ['failed', 'the window did not answer in time: whether it was done is not known']);
  // The page goes (a reload) before it answers: whether it did what it was sent is not known (a failure, never a refusal a caller would
  // take as "nothing happened"), and its refs are gone.
  const pending = graph.invoke({ ref: turn, operation: '_collapse', caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  const gen2 = w.open(7, page);
  assert.deepEqual(await pending.then((o) => [o.status, o.error?.message]), ['failed', 'the window\'s page went before it answered: whether it was done is not known']);
  assert.equal((await graph.invoke({ ref: turn, operation: '_collapse', caller: mod('unit.a') })).status, 'refused', 'an older generation\'s ref');
  assert.equal(posted.length, 5, 'nothing sent for it');
  // A mod needs the grant; an operation no page does is not offered.
  w.report(7, gen2, { puts: [P(3, 'TurnView', U1, { in: 'ThreadView', via: 'thread' }, { slot: 'transcript' })] });
  const turn2 = { type: 'TurnView', provider: PROVIDER, id: `7.${gen2}.3` };
  assert.equal((await graph.invoke({ ref: turn2, operation: '_collapse', caller: mod('unit.b') })).reason, 'notAllowed');
  assert.equal((await graph.invoke({ ref: { type: 'ThreadView', provider: PROVIDER, id: `7.${gen}.1` }, operation: '_jumpToLatest', caller: USER })).status, 'refused');
  w.dispose();
});

test('E7.1: each operation by its route: the subject\'s own as the caller, framework-main\'s app actions and messages, the page\'s', async () => {
  const calls = [];
  const record = (name) => ({ effect: 'external', handler: ({ ref, args, caller }) => { calls.push([name, ref.id, args, caller.id]); return { status: 'done', value: null }; } });
  const extra = { Draft: { operations: { insert: record('Draft.insert') } }, Command: { operations: { run: record('Command.run') } }, File: { operations: { open: record('File.open') } } };
  const grants = { 'unit.a': ['graph.act:Composer._insert,Draft.insert,PaletteResult._choose,Command.run,Chip._open,File.open,SidebarSection,SidebarItem._rename,ThreadHeader._rename,StatusItem._open'], 'unit.b': ['graph.act:Composer._insert,Chip._open'] };
  const { graph, codex, w, ops } = setup({ grants, extra });
  const draft = { type: 'Draft', provider: 'codex', id: 'th-1' }, cmd = { type: 'Command', provider: 'codex', id: 'newTask' }, file = { type: 'File', provider: 'codex', id: '/x/a.txt' };
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' }, project = { type: 'LocalProject', provider: 'codex', id: 'p-1' };
  codex.put(draft, { state: { content: { parts: [] }, dictating: false } });
  codex.put(cmd, { state: { title: 'New chat', category: 'app', enabled: true } });
  codex.put(file, { state: { path: '/x/a.txt', name: 'a.txt', size: 1, modifiedAt: 1, kind: 'text' }, links: { project: { type: 'LocalProject', provider: 'codex', id: 'p-1' }, folder: { type: 'Folder', provider: 'codex', id: '/x' } } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [
    P(1, 'ThreadView', thread, { in: 'Window' }, { slot: 'main' }), P(2, 'Composer', draft, { in: null }), P(3, 'PaletteResult', cmd, { in: null }),
    P(4, 'Chip', file, { in: null }), P(5, 'SidebarSection', project, { in: 'Window' }, { slot: 'sidebar' }), P(6, 'SidebarItem', thread, { in: null }),
    P(7, 'SidebarItem', { ...thread, id: 'th-2' }, { in: null }), P(8, 'ThreadHeader', thread, { in: 'ThreadView' }), P(9, 'StatusItem', { ...thread, id: 'th-2' }, { in: null }),
  ] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  const act = (n, type, operation, args = [], caller = mod('unit.a')) => graph.invoke({ ref: at(n, type), operation, args, caller });
  // The subject's own, as the caller: Composer.insert is Draft.insert; Chip.open is the File's open; a caller without the subject's grant is refused.
  const ins = await act(2, 'Composer', '_insert', ['hello']); assert.equal(ins.status, 'done', JSON.stringify(ins));
  assert.equal((await act(4, 'Chip', '_open')).status, 'done');
  assert.deepEqual(calls, [['Draft.insert', 'th-1', [{ parts: [{ kind: 'text', text: 'hello' }] }, { window: refs.window(7), pane: 'route' }], 'unit.a'], ['File.open', '/x/a.txt', [], 'unit.a']], 'in the composer\'s own window');
  assert.equal((await act(2, 'Composer', '_insert', ['x'], mod('unit.b'))).reason, 'notAllowed', 'unit.b may act on the composer, not on the draft');
  // PaletteResult.choose runs the command, then the page closes the palette.
  const chosen = act(3, 'PaletteResult', '_choose');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((m) => [m.n, m.operation]), [[3, 'close']]);
  w.answer(7, gen, posted[0].id, { ok: true });
  assert.equal((await chosen).status, 'done');
  assert.deepEqual(calls.at(-1), ['Command.run', 'newTask', [], 'unit.a']);
  // framework-main: a project's group by the app's own sidebar actions in this window; the rename dialog of the chat the window shows.
  assert.equal((await act(5, 'SidebarSection', '_collapse')).status, 'done');
  assert.deepEqual(ops.at(-1), ['windows', 'appAction', { windowId: 7, action: { type: 'windows.sidebar.project_set_collapsed', windowId: 'current', project: { projectId: 'p-1' }, collapsed: true } }]);
  // its "Show more" is the page's (E8.9: the app's own expander state)
  const more = act(5, 'SidebarSection', '_showMore');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.at(-1) && [posted.at(-1).n, posted.at(-1).operation], [5, 'showMore']);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await more).status, 'done');
  assert.equal((await act(6, 'SidebarItem', '_rename')).status, 'done', 'the chat the window shows');
  assert.equal((await act(7, 'SidebarItem', '_rename')).reason, 'unavailable', 'another chat\'s row');
  assert.equal((await act(8, 'ThreadHeader', '_rename')).status, 'done');
  assert.deepEqual(ops.slice(-2), [['windows', 'renameThread', { windowId: 7 }], ['windows', 'renameThread', { windowId: 7 }]]);
  // A status item goes to its subject in its window.
  assert.equal((await act(9, 'StatusItem', '_open')).status, 'done');
  assert.deepEqual(ops.at(-1), ['windows', 'open', { windowId: 7, threadId: 'th-2' }]);
  w.dispose();
});

test('E7.1: a subject the page shows that is not resident is observed (loaded) for its operation, then let go', async () => {
  const calls = [];
  const file = { type: 'File', provider: 'codex', id: '/x/b.txt' };
  const observed = [];
  const observe = (q, codex) => {
    observed.push([q.ref.id, q.depth]);
    codex.put(file, { state: { path: '/x/b.txt', name: 'b.txt', size: 1, modifiedAt: 1, kind: 'text' }, links: { project: { type: 'LocalProject', provider: 'codex', id: 'p-1' }, folder: { type: 'Folder', provider: 'codex', id: '/x' } } });
  };
  const extra = { File: { operations: { open: { effect: 'external', handler: ({ ref }) => { calls.push(ref.id); return { status: 'done', value: null }; } } } } };
  const { graph, w } = setup({ grants: { 'unit.a': ['graph.act:Chip._open,File.open'] }, extra, observe });
  const gen = opened(w, 7, [P(1, 'Chip', file, { in: null })]);
  assert.equal(graph.resolve(file), null, 'the page shows it; the graph has not read it');
  const out = await graph.invoke({ ref: { type: 'Chip', provider: PROVIDER, id: `7.${gen}.1` }, operation: '_open', caller: mod('unit.a') });
  assert.equal(out.status, 'done', JSON.stringify(out));
  assert.deepEqual([observed, calls], [[['/x/b.txt', undefined]], ['/x/b.txt']]);
  w.dispose();
});

test('E7.2: QueueItem and ComposerPicker by their routes (the message\'s and the setting\'s own, the page\'s); no act on what the framework renders', async () => {
  const calls = [];
  const record = (name) => ({ effect: 'external', handler: ({ ref, args, caller }) => { calls.push([name, ref.id, args, caller.id]); return { status: 'done', value: null }; } });
  const extra = { QueuedMessage: { operations: { sendNow: record('QueuedMessage.sendNow'), move: record('QueuedMessage.move') } }, Setting: { operations: { set: record('Setting.set') } } };
  const grants = { 'unit.a': ['graph.act:QueueItem,QueuedMessage.sendNow,QueuedMessage.move,ComposerPicker,Setting.set'] };
  const { graph, codex, w } = setup({ grants, extra });
  const queued = { type: 'QueuedMessage', provider: 'codex', id: 'th-1:q-1' }, model = { type: 'Setting', provider: 'codex', id: 'thread:th-1:model' };
  codex.put(queued, { state: { content: { parts: [] } }, links: { thread: { type: 'CodexThread', provider: 'codex', id: 'th-1' }, attachments: [] } });
  codex.put(model, { state: { title: 'Model', value: 'a', default: null, scope: 'thread', kind: 'choice', choices: [] }, links: { section: { type: 'SettingsSection', provider: 'codex', id: 'composer' }, definedBy: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [
    P(1, 'QueueItem', queued, { in: null }), P(2, 'ComposerPicker', model, { in: null }), P(3, 'ComposerPicker', model, { in: null }, { slot: 'mine', framework: true }),
  ] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  const act = (n, type, operation, args = []) => graph.invoke({ ref: at(n, type), operation, args, caller: mod('unit.a') });
  assert.equal((await act(1, 'QueueItem', '_sendNow')).status, 'done');
  assert.equal((await act(1, 'QueueItem', '_move', [0])).status, 'done');
  assert.equal((await act(2, 'ComposerPicker', '_choose', ['b'])).status, 'done');
  assert.deepEqual(calls, [['QueuedMessage.sendNow', 'th-1:q-1', [], 'unit.a'], ['QueuedMessage.move', 'th-1:q-1', [0], 'unit.a'], ['Setting.set', 'thread:th-1:model', ['b'], 'unit.a']]);
  const edit = act(1, 'QueueItem', '_edit');
  const open = act(2, 'ComposerPicker', '_open');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((m) => [m.n, m.operation]), [[1, 'edit'], [2, 'open']]);
  for (const m of posted) w.answer(7, gen, m.id, { ok: true });
  assert.deepEqual([(await edit).status, (await open).status], ['done', 'done']);
  // The framework's own picker: refused by every route, nothing sent to its page or done on its subject.
  for (const op of [['_open'], ['_choose', ['b']]]) assert.equal((await act(3, 'ComposerPicker', ...op)).reason, 'notAllowed');
  assert.equal(posted.length, 2);
  assert.equal(calls.length, 3);
  w.dispose();
});

test('E7.3: the Sidebar starts a new chat and the open Palette searches, through framework-main; the Palette closes in the page', async () => {
  const { graph, w, ops } = setup({ grants: { 'unit.a': ['graph.act:Sidebar._newThread,Palette'] } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'Sidebar', refs.app(), { in: 'Window' }, { slot: 'sidebar' }), P(2, 'Palette', refs.app(), { in: 'Window' }, { slot: 'overlay' })] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  const act = (n, type, operation, args = []) => graph.invoke({ ref: at(n, type), operation, args, caller: mod('unit.a') });
  assert.equal((await act(1, 'Sidebar', '_newThread')).status, 'done');
  assert.equal((await act(2, 'Palette', '_open', ['settings'])).status, 'done');
  assert.equal((await act(2, 'Palette', '_open')).status, 'done', 'open already: nothing to send');
  assert.deepEqual(ops, [['windows', 'newChat', { windowId: 7 }], ['windows', 'palette', { windowId: 7, query: 'settings' }]]);
  const close = act(2, 'Palette', '_close');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((m) => [m.n, m.operation]), [[2, 'close']]);
  w.answer(7, gen, posted[0].id, { ok: true });
  assert.equal((await close).status, 'done');
  w.dispose();
});

test('E7.4: the SidePanel opens a file\'s or the review\'s tab and closes, through framework-main; tabs act in the page', async () => {
  const { graph, w, ops } = setup({ grants: { 'unit.a': ['graph.act:SidePanel,PanelTab'] } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'SidePanel', thread, { in: 'Window' }, { slot: 'panel' }), P(2, 'PanelTab', { type: 'File', provider: 'codex', id: '/r/a.txt' }, { in: null })] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  const act = (n, type, operation, args = []) => graph.invoke({ ref: at(n, type), operation, args, caller: mod('unit.a') });
  assert.equal((await act(1, 'SidePanel', '_open', [{ type: 'File', provider: 'codex', id: '/r/b.txt' }])).status, 'done');
  assert.equal((await act(1, 'SidePanel', '_open', [{ type: 'Terminal', provider: 'codex', id: 's' }])).reason, 'unsupported');
  assert.equal((await act(1, 'SidePanel', '_close')).status, 'done');
  assert.deepEqual(ops, [['windows', 'appAction', { windowId: 7, action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/r/b.txt' } } }], ['windows', 'setPanel', { windowId: 7, open: false }]]);
  const sel = act(2, 'PanelTab', '_select');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((m) => [m.n, m.operation]), [[2, 'select']]);
  w.answer(7, gen, posted[0].id, { ok: true });
  assert.equal((await sel).status, 'done');
  w.dispose();
});

test('E7.2b: a ThreadView scrolls to a turn of its chat and to its latest in the page, by the app\'s turn id (turns load if need be); a terminal\'s are the page\'s', async () => {
  const th1 = { type: 'CodexThread', provider: 'codex', id: 'th-1' }, th2 = { type: 'CodexThread', provider: 'codex', id: 'th-2' };
  const turn = (id, thread, startedAt) => [{ type: 'Turn', provider: 'codex', id }, { state: { status: 'completed', startedAt, startedBy: { kind: 'user' } }, links: { thread } }];
  const observed = [];
  const observe = (q, codex) => { observed.push(q.ref.id); if (q.ref.id === 'th-2') codex.put(...turn('turn-c', th2, 5)); };
  const { graph, codex, w } = setup({ grants: { 'unit.a': ['graph.act:ThreadView,TerminalView'] }, extra: { CodexThread: {}, Turn: {} }, observe });
  codex.put(...turn('turn-b', th1, 2));
  codex.put(...turn('turn-a', th1, 1));
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'ThreadView', th1, { in: 'Window' }, { slot: 'main' }), P(2, 'ThreadView', th2, { in: null }),
    P(3, 'TerminalView', { type: 'Terminal', provider: 'codex', id: 's-1' }, { in: null })] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  const act = (n, type, operation, args = []) => graph.invoke({ ref: at(n, type), operation, args, caller: mod('unit.a') });
  /** The act the page was sent, answered done: [outcome, presentation, operation, args]. */
  const inPage = async (p) => {
    const before = posted.length;
    for (let i = 0; i < 20 && posted.length === before; i++) await new Promise((r) => setImmediate(r));
    const m = posted.at(-1);
    w.answer(7, gen, m.id, { ok: true });
    return [(await p).status, m.n, m.operation, m.args];
  };
  assert.deepEqual(await inPage(act(1, 'ThreadView', '_scrollTo', [{ type: 'Turn', provider: 'codex', id: 'turn-a' }])), ['done', 1, 'scrollTo', ['turn-a']]);
  assert.deepEqual(await inPage(act(1, 'ThreadView', '_jumpToLatest')), ['done', 1, 'jumpToLatest', ['turn-b']]);
  assert.deepEqual(observed, [], 'its turns are resident: nothing observed');
  assert.deepEqual(await inPage(act(2, 'ThreadView', '_jumpToLatest')), ['done', 2, 'jumpToLatest', ['turn-c']]);
  assert.deepEqual(observed, ['th-2'], 'a chat with no turn resident is observed: its turns load');
  // refused before the page: another chat's turn, an unknown turn
  const sent = posted.length;
  assert.equal((await act(1, 'ThreadView', '_scrollTo', [{ type: 'Turn', provider: 'codex', id: 'turn-c' }])).reason, 'invalid');
  assert.equal((await act(1, 'ThreadView', '_scrollTo', [{ type: 'Turn', provider: 'codex', id: 'nope' }])).reason, 'unavailable');
  for (const bad of [[''], ['   '], ['x'.repeat(501)], [3]]) assert.equal((await act(1, 'ThreadView', '_find', bad)).reason, 'invalid', 'find takes 1 to 500 characters');
  assert.equal(posted.length, sent);
  assert.deepEqual(await inPage(act(1, 'ThreadView', '_find', ['needle'])), ['done', 1, 'find', ['needle']], 'E8.9: find goes to the page as it is');
  assert.deepEqual(await inPage(act(3, 'TerminalView', '_copySelection')), ['done', 3, 'copySelection', []]);
  assert.deepEqual(await inPage(act(3, 'TerminalView', '_focus')), ['done', 3, 'focus', []]);
  w.dispose();
});

test('E7.6c: a mod asks in the window the user is in; settled once: by the user, by the mod that asked (no other), by time, by its subject or page going, or the mod stopping', async () => {
  const { graph, unit, w } = setup({ grants: { 'unit.a': ['graph.act:Dialog'], 'unit.b': ['graph.act:Dialog'] }, focused: 7 });
  const posted = [];
  let gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [] });
  const spec = { requester: { id: 'unit.a', name: 'Unit A' }, subject: T1, purpose: 'confirm', title: 'Delete it?', message: 'It cannot be undone.', actions: [{ id: 'yes', title: 'Delete' }, { id: 'no', title: 'Keep' }] };
  const tick = () => new Promise((r) => setImmediate(r));
  /** Ask, and the page shows it as a Dialog numbered `n`: [the promise, the page's message]. */
  const asked = async (n, extra = {}) => {
    const p = w.ask({ ...spec, ...extra });
    await tick();
    const m = posted.at(-1);
    w.report(7, gen, { puts: [P(n, 'Dialog', m.subject, { in: 'Window' }, { slot: m.purpose, ask: m.id })] });
    return [p, m];
  };
  const [p1, m1] = await asked(1);
  assert.deepEqual({ t: m1.t, gen: m1.gen, requester: m1.requester, purpose: m1.purpose, actions: m1.actions.map((a) => a.id) }, { t: 'ask', gen, requester: { id: 'unit.a', name: 'Unit A' }, purpose: 'confirm', actions: ['yes', 'no'] });
  assert.equal(w.askAnswer(7, gen, m1.id, { choice: 'no' }), true);
  assert.deepEqual(await p1, { choice: 'no', by: 'user' });
  assert.equal(w.askAnswer(7, gen, m1.id, { choice: 'yes' }), false, 'settled once');
  // the requester's confirm (its first action); another mod is refused
  const [p2, m2] = await asked(2);
  const dialog = { type: 'Dialog', provider: PROVIDER, id: `7.${gen}.2` };
  assert.equal((await graph.invoke({ ref: dialog, operation: '_cancel', caller: mod('unit.b') })).reason, 'notAllowed');
  assert.equal((await graph.invoke({ ref: dialog, operation: '_confirm', caller: mod('unit.a') })).status, 'done');
  assert.deepEqual(await p2, { choice: 'yes', by: 'requester' });
  assert.deepEqual(posted.at(-1), { t: 'askEnd', id: m2.id }, 'the page closes it');
  assert.equal((await graph.invoke({ ref: dialog, operation: '_confirm', caller: mod('unit.a') })).reason, 'unavailable', 'answered');
  // its time passes; the user cancels; its subject goes; the mod stops; the page goes
  const [p3] = await asked(3, { until: Date.now() + 20 });
  assert.deepEqual(await p3, { cancelled: true, by: 'framework', reason: 'its time passed' });
  const [p4, m4] = await asked(4);
  w.askAnswer(7, gen, m4.id, { cancelled: true, by: 'user', reason: 'dismissed' });
  assert.deepEqual(await p4, { cancelled: true, by: 'user', reason: 'dismissed' });
  const [p5] = await asked(5, { subject: M1 });
  unit.remove(M1);
  assert.deepEqual(await p5, { cancelled: true, by: 'framework', reason: 'the subject went' });
  const [p6] = await asked(6);
  w.cancelAsks('unit.a');
  assert.equal((await p6).reason, 'the mod that asked stopped');
  const [p7] = await asked(7);
  gen = w.open(7, { post: (m) => posted.push(m) });
  assert.equal((await p7).reason, 'the window\'s page went');
  w.dispose();
  // no window the user is in: refused
  const none = setup({ focused: null });
  await assert.rejects(none.w.ask(spec), /no window is open/);
  none.w.dispose();
});

test('E7.5b: ChangesView and DiffView: selection, scope, comments and opening a file in the page; the diff\'s layout kept', async () => {
  const { graph, codex, w } = setup({ grants: { 'unit.a': ['graph.act:ChangesView,DiffView'] } });
  const set = { type: 'ChangeSet', provider: 'codex', id: 'thread:t1' }, fc = { type: 'FileChange', provider: 'codex', id: 'thread:t1:/r/a.js' };
  codex.put(fc, { state: { path: '/r/a.js', kind: 'modified', added: 1, removed: 0, state: 'applied' }, links: { changeSet: set } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'ChangesView', set, { in: 'PanelTab', on: set }, { slot: 'view' }), P(2, 'DiffView', fc, { in: 'ChangesView', on: set }, { slot: 'files', layout: 'split' }),
    P(3, 'DiffView', { ...fc, id: 'thread:t1:/r/b.js' }, { in: 'ChangesView', on: set }, { slot: 'files', layout: 'sideways' })] });
  const at = (n, type) => ({ type, provider: PROVIDER, id: `7.${gen}.${n}` });
  assert.equal(graph.resolve(at(2, 'DiffView')).state.layout, 'split');
  assert.equal(graph.resolve(at(3, 'DiffView')).state.layout, undefined, 'only unified or split');
  const act = (n, type, operation, args = []) => graph.invoke({ ref: at(n, type), operation, args, caller: mod('unit.a') });
  for (const [n, type, op, args] of [[1, 'ChangesView', '_selectFile', [fc]], [1, 'ChangesView', '_setScope', ['turn']], [2, 'DiffView', '_commentOn', [{ start: 2 }]], [2, 'DiffView', '_openFile', []]]) {
    const p = act(n, type, op, args);
    await new Promise((r) => setImmediate(r));
    const m = posted.at(-1);
    assert.deepEqual([m.n, m.operation], [n, op.slice(1)], 'the page\'s binding keeps the plain name');
    w.answer(7, gen, m.id, { ok: true });
    assert.equal((await p).status, 'done', op);
  }
  assert.equal((await act(2, 'DiffView', '_setLayout', ['unified'])).reason, 'unavailable', 'a global setting of the app, not this view\'s');
  w.dispose();
});

test('E7.6b: outside a window: a banner per unread desktop notification (its Notification\'s open and dismiss), and the Dock\'s badge held through framework-main', async () => {
  const calls = [];
  const record = (name) => ({ effect: 'local', handler: ({ ref, caller }) => { calls.push([name, ref.id, caller.id]); return { status: 'done', value: null }; } });
  const extra = { Notification: { operations: { open: record('open'), dismiss: record('dismiss') } } };
  const { graph, codex, w, ops } = setup({ grants: { 'unit.a': ['graph.act:NotificationBanner,DockBadge,Notification'] }, extra });
  const note = (id, read) => codex.put({ type: 'Notification', provider: 'codex', id }, { state: { title: 'Done', body: 'b', kind: 'finished', createdAt: 1, read }, links: {} });
  const desktop = () => graph.list('Presentation').filter((p) => !p.links.window).map((p) => [p.ref.type, p.links.subject.id, p.state.slot]).sort();
  note('n1', false); note('n2', true);
  assert.deepEqual(desktop(), [['DockBadge', 'codex', 'dock'], ['NotificationBanner', 'n1', 'desktop']]);
  const banner = graph.list('NotificationBanner')[0].ref;
  assert.equal((await graph.invoke({ ref: banner, operation: '_open', caller: mod('unit.a') })).status, 'done');
  assert.deepEqual(calls, [['open', 'n1', 'unit.a']], 'the Notification\'s own, as the caller');
  note('n1', true);
  assert.deepEqual(desktop(), [['DockBadge', 'codex', 'dock']], 'read: its banner goes');
  note('n3', false);
  codex.remove({ type: 'Notification', provider: 'codex', id: 'n3' });
  assert.equal(graph.list('NotificationBanner').length, 0, 'gone: its banner too');
  // the badge: the caller's value through framework-main, let go when the caller stops
  const badge = graph.list('DockBadge')[0].ref;
  assert.equal((await graph.invoke({ ref: badge, operation: '_set', args: [7], caller: mod('unit.a') })).status, 'done');
  assert.equal((await graph.invoke({ ref: badge, operation: '_set', args: [{ x: 1 }], caller: mod('unit.a') })).reason, 'invalid');
  assert.equal((await graph.invoke({ ref: badge, operation: '_set', args: [{ add: 2 }], caller: mod('unit.a') })).status, 'done', 'a count added to the app\'s own');
  assert.equal((await graph.invoke({ ref: badge, operation: '_attention', args: ['critical'], caller: mod('unit.a') })).status, 'done');
  w.releaseBadge('unit.a');
  w.releaseBadge('unit.a');   // once
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ops.filter(([area]) => area === 'dock'), [['dock', 'badge', { holder: 'unit.a', value: 7 }], ['dock', 'badge', { holder: 'unit.a', value: { add: 2 } }],
    ['dock', 'attention', { kind: 'critical' }], ['dock', 'badge', { holder: 'unit.a', value: null }]]);
  assert.deepEqual([w.stats().presentations, w.stats().desktop], [0, 1]);
  w.dispose();
});

test('E7 review: a question is not asked for a mod that stopped meanwhile, ends with the call it was asked about, and settles when it cannot be delivered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { w } = setup({ focused: 7 });
  const posted = [];
  const gen = w.open(7, { post: (m) => { posted.push(m); return m.t === 'ask' && m.title === 'Lost' ? false : true; } });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [] });
  const spec = { requester: { id: 'unit.a', name: 'Unit A' }, subject: T1, purpose: 'confirm', title: 'Q', message: 'm', actions: [{ id: 'ok', title: 'OK' }] };
  // stopped while its window was found
  const slow = setup({ focused: 7 });
  const sg = slow.w.open(7, { post: () => true });
  slow.w.report(7, sg, { window: { sidebar: { open: true } }, puts: [] });
  const asking = slow.w.ask(spec);
  slow.w.cancelAsks('unit.a');
  assert.deepEqual(await asking, { cancelled: true, by: 'framework', reason: 'the mod that asked stopped' });
  slow.w.dispose();
  void gate; void release;
  // bound to an intercepted call: ends with it
  let end;
  const p = w.ask({ ...spec, during: (fn) => { end = fn; return () => {}; } });
  await new Promise((r) => setImmediate(r));
  end();
  assert.deepEqual(await p, { cancelled: true, by: 'framework', reason: 'the call it asked about went on' });
  assert.deepEqual(await w.ask({ ...spec, during: () => null }), { cancelled: true, by: 'framework', reason: 'the call it asked about went on' }, 'the call already went on');
  // the page took no message
  assert.equal((await w.ask({ ...spec, title: 'Lost' })).reason, 'the window\'s page went');
  w.dispose();
});

test('E7 review: a stale ThreadHeader cannot rename the chat the window shows now; a stop while the badge is set still lets it go', async () => {
  const { graph, w, ops, codex } = setup({ grants: { 'unit.a': ['graph.act:ThreadHeader,DockBadge'] }, extra: { CodexThread: {} } });
  const a = { type: 'CodexThread', provider: 'codex', id: 'a' }, b = { type: 'CodexThread', provider: 'codex', id: 'b' };
  const gen = w.open(7, { post: () => true });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'ThreadView', b, { in: 'Window' }, { slot: 'main' }), P(2, 'ThreadHeader', a, { in: null })] });
  const header = { type: 'ThreadHeader', provider: PROVIDER, id: `7.${gen}.2` };
  assert.equal((await graph.invoke({ ref: header, operation: '_rename', caller: mod('unit.a') })).reason, 'unavailable', 'a\'s header while the window shows b');
  assert.equal(ops.filter(([, op]) => op === 'renameThread').length, 0);
  // the badge: held before main answers, so a stop meanwhile lets it go
  const badge = graph.list('DockBadge')[0].ref;
  const setting = graph.invoke({ ref: badge, operation: '_set', args: [3], caller: mod('unit.a') });
  await w.releaseBadge('unit.a');
  await setting;
  assert.deepEqual(ops.filter(([area]) => area === 'dock').map(([, , x]) => x.value), [3, null]);
  void codex;
  w.dispose();
});

test('WL1: the window\'s frame regions: a TitleBar and a MainRegion always, the Rail where the app shows it, the BottomPanel open or closed; gone with the window', () => {
  const { graph, w } = setup();
  const gen = w.open(7);
  w.report(7, gen, { puts: [], window: { navigation: 'rail-and-sidebar', sidebar: { open: true, width: 288 }, side: { open: false }, bottom: { open: true, height: 280 } } });
  const at = (type, slot) => graph.resolve(refs.region(type, 7, slot));
  assert.deepEqual([at('TitleBar', 'titleBar').state.slot, at('Rail', 'rail').state.slot, at('MainRegion', 'main').links.subject], ['titleBar', 'rail', refs.app()]);
  assert.deepEqual([at('BottomPanel', 'bottom').state.open, at('BottomPanel', 'bottom').state.size], [true, { height: 280 }], 'its height its size (G5.1)');
  assert.equal(parentOf(graph, '7.titleBar'), '7', 'a child of its Window');
  w.report(7, gen, { puts: [], window: { navigation: 'sidebar', sidebar: { open: true }, side: { open: false }, bottom: { open: false } } });
  const gone = (x) => !x || x.gone === true;
  assert.ok(gone(at('Rail', 'rail')), 'no rail shown: no Rail');
  assert.deepEqual([at('BottomPanel', 'bottom').state.open, at('BottomPanel', 'bottom').state.size], [false, undefined]);
  w.windowClosed(7);
  assert.ok([at('TitleBar', 'titleBar'), at('MainRegion', 'main'), at('BottomPanel', 'bottom')].every(gone), 'gone with the window');
});

test('the Window\'s side panel is what its page reads from the app\'s shell (a SidePanel stays presented while closed); a presentation\'s expanded where its binding says', () => {
  const { graph, w } = setup();
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const gen = opened(w, 7, [P(1, 'TurnView', U1, { in: null }, { expanded: false })]);
  assert.equal(graph.resolve(refs.window(7)).state.side.open, false);
  assert.equal(graph.resolve({ type: 'TurnView', provider: PROVIDER, id: `7.${gen}.1` }).state.expanded, false);
  w.report(7, gen, { puts: [P(2, 'SidePanel', thread, { in: 'Window' }, { slot: 'panel' })] });
  assert.equal(graph.resolve(refs.window(7)).state.side.open, false, 'presented, but the page has not said it is open');
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: true } } });
  assert.equal(graph.resolve(refs.window(7)).state.side.open, true);
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false } } });
  assert.equal(graph.resolve(refs.window(7)).state.side.open, false, 'closed, its SidePanel still presented');
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: true } } });
  w.close(7, gen);
  assert.equal(graph.resolve(refs.window(7)).state.side.open, false, 'its page went: not known to be open');
  w.dispose();
});

test('E8.3b: actOn runs a page operation on the presentation of a type that shows a subject now (the newest mount); none shown: null', async () => {
  const { w } = setup();
  const draft = { type: 'Draft', provider: 'codex', id: 'th-1' };
  assert.equal(await w.actOn('Composer', draft, 'setText', ['x']), null, 'no window: nothing shown');
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'Composer', draft, { in: null }), P(2, 'Composer', { type: 'Draft', provider: 'codex', id: 'th-2' }, { in: null }), P(3, 'Composer', draft, { in: null })] });
  const p = w.actOn('Composer', draft, 'setText', ['hello']);
  for (let i = 0; i < 20 && !posted.length; i++) await new Promise((r) => setImmediate(r));
  const m = posted.at(-1);
  assert.deepEqual([m.t, m.n, m.operation, m.args], ['act', 3, 'setText', ['hello']], 'the newest mount of that Draft\'s composer');
  w.answer(7, gen, m.id, { ok: true });
  assert.equal((await p).status, 'done');
  const q = w.actOn('Composer', draft, 'clear', []);
  for (let i = 0; i < 20 && posted.length < 2; i++) await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'no controller' });
  assert.equal((await q).status, 'refused', 'the page cannot: the caller falls back');
  assert.equal(await w.actOn('Composer', { type: 'Draft', provider: 'codex', id: 'th-9' }, 'clear', []), null);
  w.dispose();
});

test('E8 review 3: ComposerPicker.choose on the new chat\'s menu (a draft-scope Setting the graph does not serve) is the menu\'s own, in its page', async () => {
  const grants = { 'unit.a': ['graph.act:ComposerPicker._choose'] };
  const { graph, w } = setup({ grants });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'ComposerPicker', { type: 'Setting', provider: 'codex', id: 'new:app:new-conversation:model' }, { in: null }, { slot: 'pickers' })] });
  const pending = graph.invoke({ ref: { type: 'ComposerPicker', provider: PROVIDER, id: `7.${gen}.1` }, operation: '_choose', args: [{ type: 'Model', provider: 'codex', id: 'gpt-x' }], caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).n, posted.at(-1).operation, posted.at(-1).args], [1, 'choose', ['gpt-x', undefined]], 'the Model\'s id, to the menu');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await pending).status, 'done');
  w.dispose();
});

test('E8.9: SidePanel.resize goes to the page with its width (320 to 10000 px)', async () => {
  const grants = { 'unit.a': ['graph.act:SidePanel._resize'] };
  const { graph, w } = setup({ grants });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'SidePanel', { type: 'CodexThread', provider: 'codex', id: 'th-1' }, { in: 'Window' }, { slot: 'panel' })] });
  const ref = { type: 'SidePanel', provider: PROVIDER, id: `7.${gen}.1` };
  for (const bad of [[100], [12000], ['wide'], [500.5]]) assert.equal((await graph.invoke({ ref, operation: '_resize', args: bad, caller: mod('unit.a') })).reason, 'invalid');
  assert.equal(posted.length, 0, 'nothing sent for those');
  const p = graph.invoke({ ref, operation: '_resize', args: [480], caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['resize', [480]]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await p).status, 'done');
  w.dispose();
});

test('E8 review 4: Composer.insert is its Draft\'s insert, written in the window of the composer chosen (two windows show the Draft)', async () => {
  let w;
  const extra = { Draft: { operations: { insert: { effect: 'local', handler: ({ args }) => w.actOn('Composer', { type: 'Draft', provider: 'codex', id: 'th-1' }, 'insert', [args[0].parts[0].text], Number(args[1]?.window?.id)) } } } };
  const grants = { 'unit.a': ['graph.act:Composer._insert,Draft.insert'] };
  const s = setup({ grants, extra });
  w = s.w;
  const draft = { type: 'Draft', provider: 'codex', id: 'th-1' };
  s.codex.put(draft, { state: { content: { parts: [] }, dictating: false } });
  const posted = { 7: [], 8: [] };
  const g7 = w.open(7, { post: (m) => posted[7].push(m) }), g8 = w.open(8, { post: (m) => posted[8].push(m) });
  w.report(7, g7, { window: { sidebar: { open: true } }, puts: [P(1, 'Composer', draft, { in: null })] });
  w.report(8, g8, { window: { sidebar: { open: true } }, puts: [P(1, 'Composer', draft, { in: null })] });
  const p = s.graph.invoke({ ref: { type: 'Composer', provider: PROVIDER, id: `8.${g8}.1` }, operation: '_insert', args: ['hello'], caller: mod('unit.a') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted[7].length, posted[8].at(-1)?.operation, posted[8].at(-1)?.args], [0, 'insert', ['hello']]);
  w.answer(8, g8, posted[8].at(-1).id, { ok: true });
  assert.equal((await p).status, 'done');
  w.dispose();
});

test('E8.3h: a window\'s new chat target goes on the bus when it changes (for the Draft\'s provider)', async () => {
  const { w, published } = setup();
  const gen = w.open(7, { post() {} });
  w.report(7, gen, { window: { sidebar: { open: true }, newChat: { environment: 'local' } }, puts: [] });
  w.report(7, gen, { window: { sidebar: { open: true }, newChat: { environment: 'local' } }, puts: [] });
  w.report(7, gen, { window: { sidebar: { open: true }, newChat: null }, puts: [] });
  assert.deepEqual(published.filter(([t]) => t === 'window/newChat'), [['window/newChat', { windowId: 7, target: { environment: 'local' } }], ['window/newChat', { windowId: 7, target: null }]]);
  // a page that goes (a reload, the window closing) takes its target with it (graph-layers.md §5)
  const g2 = w.open(7, { post() {} });
  w.report(7, g2, { window: { sidebar: { open: true }, newChat: { environment: 'cloud' } }, puts: [] });
  w.open(7, { post() {} });   // a reload
  const g8 = w.open(8, { post() {} });
  w.report(8, g8, { window: { sidebar: { open: true }, newChat: { environment: 'worktree' } }, puts: [] });
  w.close(8, g8);   // the window closing
  assert.deepEqual(published.filter(([t]) => t === 'window/newChat').slice(2).map(([, d]) => [d.windowId, d.target?.environment ?? null]), [[7, 'cloud'], [7, null], [8, 'worktree'], [8, null]]);
  w.dispose();
});

test('E8.9j: Sidebar.filter goes to the page with its query (text, a chat\'s state fields, or null) and the mod that asks', async () => {
  const grants = { 'unit.a': ['graph.act:Sidebar._filter'] };
  const { graph, w } = setup({ grants });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'Sidebar', { type: 'App', provider: 'codex', id: 'codex' }, { in: 'Window' }, { slot: 'sidebar' })] });
  const ref = { type: 'Sidebar', provider: PROVIDER, id: `7.${gen}.1` };
  for (const bad of [[''], ['x'.repeat(201)], [{}], [{ status: { a: 1 } }], [{ 'bad key': 1 }], [42]]) assert.equal((await graph.invoke({ ref, operation: '_filter', args: bad, caller: mod('unit.a') })).reason, 'invalid', JSON.stringify(bad));
  assert.equal(posted.length, 0, 'nothing sent for those');
  for (const [q, sent] of [[' release ', 'release'], [{ status: ['idle', 'error'], unread: true }, { status: ['idle', 'error'], unread: true }], [null, null]]) {
    const p = graph.invoke({ ref, operation: '_filter', args: [q], caller: mod('unit.a') });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['filter', [sent, 'unit.a']]);
    w.answer(7, gen, posted.at(-1).id, { ok: true });
    assert.equal((await p).status, 'done');
  }
  w.dispose();
});

test('E8.4b: the app\'s own menu bar entries are MenuEntry presentations outside any window, their Command\'s or the App\'s; choose clicks one in framework-main', async () => {
  const grants = { 'unit.a': ['graph.act:MenuEntry._choose'] };
  const menu = { entries: [{ path: ['File', 'New Chat'], title: 'New Chat', menu: 'File', shortcut: 'CmdOrCtrl+N', enabled: true }, { path: ['View', 'Show Sidebar'], title: 'Show Sidebar', menu: 'View', enabled: true, checked: true }],
    answer: (op, args) => (op === 'choose' && args.path[1] === 'Off' ? { ok: false, refused: true, error: 'the app has that entry turned off now' } : { ok: true }) };
  const { graph, w, ops, codex, report } = setup({ grants, menu, extra: { Command: {} } });
  codex.put({ type: 'Command', provider: 'codex', id: 'newChat' }, { state: { title: 'New chat', category: 'other', enabled: true } });
  await new Promise((r) => setImmediate(r));
  const list = () => graph.list('MenuEntry').map((e) => [e.state.menu, e.state.title, e.links.subject.type, e.links.window, e.state.checked ?? null]);
  report('menus', { event: 'entries', entries: menu.entries });
  assert.deepEqual(list(), [['File', 'New Chat', 'Command', null, null], ['View', 'Show Sidebar', 'App', null, true]]);
  const entry = graph.list('MenuEntry')[0];
  assert.equal((await graph.invoke({ ref: entry.ref, operation: '_choose', args: [], caller: mod('unit.a') })).status, 'done');
  assert.deepEqual(ops.at(-1), ['menus', 'choose', { path: ['File', 'New Chat'] }]);
  // a Command that comes later: the entry its title names becomes that Command's
  codex.put({ type: 'Command', provider: 'codex', id: 'toggleSidebar' }, { state: { title: 'Show sidebar…', category: 'other', enabled: true } });
  assert.deepEqual(list().map((x) => x.slice(1, 3)), [['New Chat', 'Command'], ['Show Sidebar', 'Command']]);
  // the Command an entry names, by its path (the user's click held in framework-main, H6m3b); none for one not known
  assert.deepEqual(w.menuEntryCommand(['View', 'Show Sidebar']), { type: 'Command', provider: 'codex', id: 'toggleSidebar' });
  assert.equal(w.menuEntryCommand(['View', 'Nothing']), null);
  assert.equal(w.menuEntryCommand('View/Show Sidebar'), null);
  // they change and go as the app's menu does
  report('menus', { event: 'entries', entries: [{ ...menu.entries[1], checked: false }, { path: ['File', 'Off'], title: 'Off', menu: 'File', enabled: false }] });
  assert.deepEqual(list(), [['View', 'Show Sidebar', 'Command', null, false], ['File', 'Off', 'App', null, null]]);
  // an entry whose title names a protected command (the user's settings, signing out) is never one (review 4)
  codex.put({ type: 'Command', provider: 'codex', id: 'logOut' }, { state: { title: 'Abmelden', category: 'app', enabled: true } });
  report('menus', { event: 'entries', entries: [{ ...menu.entries[1], checked: false }, { path: ['File', 'Off'], title: 'Off', menu: 'File', enabled: false }, { path: ['Konto', 'Abmelden'], title: 'Abmelden', menu: 'Konto', enabled: true }] });
  assert.equal(graph.list('MenuEntry').some((e) => e.state.title === 'Abmelden'), false);
  const off = graph.list('MenuEntry').find((e) => e.state.title === 'Off');
  assert.equal((await graph.invoke({ ref: off.ref, operation: '_choose', args: [], caller: mod('unit.a') })).reason, 'unavailable');
  assert.equal(w.menuEntryCommand(['File', 'Off']), null, 'an entry that names no command');
  report('menus', { event: 'entries', entries: [{ path: ['View', 'Show Sidebar'], title: 'Show Sidebar', menu: 'View', enabled: true }] });
  assert.deepEqual(graph.list('MenuEntry').map((e) => [e.state.title, e.state.checked]), [['Show Sidebar', undefined]], 'a check it lost is gone');
  w.dispose();
});

test('E8 review 2: actOn with the Draft in two windows: the one in front, or none when neither is (mounts of two pages are not compared)', async () => {
  let focused = null;
  const { w } = setup({ get focused() { return focused; } });
  const draft = { type: 'Draft', provider: 'codex', id: 'th-1' };
  const posted = { 7: [], 8: [] };
  const g7 = w.open(7, { post: (m) => posted[7].push(m) });
  const g8 = w.open(8, { post: (m) => posted[8].push(m) });
  w.report(7, g7, { window: { sidebar: { open: true } }, puts: [P(9, 'Composer', draft, { in: null })] });
  w.report(8, g8, { window: { sidebar: { open: true } }, puts: [P(1, 'Composer', draft, { in: null })] });
  assert.equal((await w.actOn('Composer', draft, 'clear', [])).reason, 'unavailable', 'two windows, none in front: refused');
  // E8 review 3: an operation that already used a window stays in it
  const pinned = w.actOn('Composer', draft, 'clear', [], 8);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted[7].length, posted[8].at(-1)?.operation], [0, 'clear'], 'sent to window 8 only');
  w.answer(8, g8, posted[8].at(-1).id, { ok: true });
  assert.equal((await pinned).status, 'done');
  assert.equal(await w.actOn('Composer', draft, 'clear', [], 9), null, 'a window that does not show it: none shown there');
  w.dispose();
});

test('review 4, round 2: a rule run in a window is answered by its page: done when it ran, refused when it did not, not known when the page went first', async () => {
  const { w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const ran = w.runRule(7, { key: 'unit.a/c', reg: 'r1', path: 'command.run', env: { via: 'graph' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted[0].t, posted[0].key, posted[0].reg, posted[0].path, posted[0].gen], ['rule-run', 'unit.a/c', 'r1', 'command.run', gen]);
  assert.equal(w.answer(8, gen, posted[0].id, { ok: true }), false, 'another window cannot answer it');
  w.answer(7, gen, posted[0].id, { ok: true });
  assert.equal((await ran).status, 'done');
  const stale = w.runRule(7, { key: 'unit.a/c', reg: 'r0', path: 'command.run' });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted[1].id, { refused: 'stale', message: 'the mod registered it again, or it went' });
  assert.deepEqual(await stale.then((o) => [o.status, o.reason]), ['refused', 'unavailable']);
  const pending = w.runRule(7, { key: 'unit.a/c', reg: 'r1', path: 'command.run' });
  await new Promise((r) => setImmediate(r));
  w.open(7, { post: (m) => posted.push(m) });   // a reload before it answered
  assert.deepEqual(await pending.then((o) => [o.status, /not known/.test(o.error?.message)]), ['failed', true]);
  assert.equal((await w.runRule(9, { key: 'unit.a/c', reg: 'r1', path: 'command.run' })).status, 'refused', 'no page in that window');
  w.dispose();
});

test('graph-layers L2: an operation of several steps chooses its window once: the one showing the subject, the one in front among several, else refused; none shows it: the window in front', async () => {
  const draft = { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' };
  const live = (w, id, puts) => { const gen = w.open(id, { post() {} }); w.report(id, gen, { puts, window: { sidebar: { open: true } } }); };
  const one = setup({ focused: 8 });
  live(one.w, 7, [P(1, 'Composer', draft, { in: null })]);
  live(one.w, 8, []);
  assert.deepEqual(await one.w.chooseWindow('Composer', draft), { windowId: 7, shows: true }, 'the only window that shows it, though 8 is in front');
  assert.deepEqual(await one.w.chooseWindow('Composer', { ...draft, id: 'th-9' }), { windowId: 8, shows: false }, 'shown nowhere: the window in front');
  const two = setup({ focused: 9 });
  live(two.w, 7, [P(1, 'Composer', draft, { in: null })]);
  live(two.w, 8, [P(1, 'Composer', draft, { in: null })]);
  live(two.w, 9, []);
  assert.equal((await two.w.chooseWindow('Composer', draft)).refused?.reason, 'unavailable', 'two show it, neither in front');
  const front = setup({ focused: 8 });
  live(front.w, 7, [P(1, 'Composer', draft, { in: null })]);
  live(front.w, 8, [P(1, 'Composer', draft, { in: null })]);
  assert.deepEqual(await front.w.chooseWindow('Composer', draft), { windowId: 8, shows: true });
  for (const s of [one, two, front]) s.w.dispose();
});

test('graph-layers L3: Window.openPalette opens the app\'s palette there (searching a query when given); Window.find is its chat\'s find bar', async () => {
  const { graph, w, ops } = setup({ grants: { 'unit.a': ['graph.act:Window.openPalette,Window.find'] } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' })] });
  const act = (operation, args = []) => graph.invoke({ ref: refs.window(7), operation, args, caller: mod('unit.a') });
  assert.equal((await act('openPalette')).status, 'done');
  assert.equal((await act('openPalette', ['settings'])).status, 'done');
  assert.deepEqual(ops.slice(-2), [['windows', 'palette', { windowId: 7 }], ['windows', 'palette', { windowId: 7, query: 'settings' }]]);
  assert.equal((await act('openPalette', ['x'.repeat(501)])).reason, 'invalid');
  const found = act('find', ['needle']);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).n, posted.at(-1).operation, posted.at(-1).args], [1, 'find', ['needle']]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await found).status, 'done');
  assert.equal((await act('find', [''])).reason, 'invalid');
  w.report(7, gen, { removes: [1] });
  assert.equal((await act('find', ['needle'])).reason, 'unavailable', 'no chat shown');
  w.dispose();
});

test('graph-layers L3: a mod\'s declaration acted on in a window: posted to its page, answered by it', async () => {
  const { w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const p = w.declarationAct(7, 'unit.f/tickets', 'filter.on', {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted[0].t, posted[0].key, posted[0].op, posted[0].gen], ['decl-act', 'unit.f/tickets', 'filter.on', gen]);
  w.answer(7, gen, posted[0].id, { ok: true });
  assert.equal((await p).status, 'done');
  assert.equal((await w.declarationAct(9, 'unit.f/tickets', 'filter.on', {})).status, 'refused', 'no page there');
  w.dispose();
});

test('graph-layers L3: Window.open of a turn, message or step shows its chat and that turn; a draft its composer; a project its new chat; a file the app\'s preview', async () => {
  const opened = [];
  const { graph, w, ops, codex } = setup({ extra: { CodexThread: {}, Turn: {}, AgentMessage: {}, Draft: {}, Automation: { operations: { open: { effect: 'local', handler: ({ args }) => { opened.push(args[0]); return null; } } } } } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [] });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const turn = { type: 'Turn', provider: 'codex', id: 'turn-a' }, message = { type: 'AgentMessage', provider: 'codex', id: 'm-1' };
  codex.put(thread, { state: { title: 'T', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 0, updatedAt: 0 },
    links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
  codex.put(turn, { state: { status: 'completed', startedAt: 0, startedBy: { kind: 'user' } }, links: { thread } });
  codex.put(message, { state: { content: { parts: [] }, createdAt: 0, phase: 'final', streaming: false }, links: { turn } });
  const opening = graph.invoke({ ref: refs.window(7), operation: 'open', args: [message], caller: USER });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ops.at(-1), ['windows', 'open', { windowId: 7, threadId: 'th-1' }], 'its chat first');
  w.report(7, gen, { puts: [P(1, 'ThreadView', thread, { in: 'Window' }, { slot: 'main' })] });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual([posted.at(-1)?.operation, posted.at(-1)?.args], ['scrollTo', ['turn-a']], 'then that turn, in its view');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await opening).status, 'done');
  // a draft: its chat's composer, focused; the new chat's
  const draft = { type: 'Draft', provider: 'codex', id: 'th-1' };
  codex.put(draft, { state: { content: { parts: [] }, dictating: false }, links: { thread } });
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [draft], caller: USER })).status, 'done');
  assert.deepEqual(ops.slice(-2), [['windows', 'open', { windowId: 7, threadId: 'th-1' }], ['windows', 'focusComposer', { windowId: 7 }]]);
  const fresh = { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' };
  codex.put(fresh, { state: { content: { parts: [] }, dictating: false }, links: { thread: null } });
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [fresh], caller: USER })).status, 'done');
  assert.deepEqual(ops.slice(-2), [['windows', 'newChat', { windowId: 7 }], ['windows', 'focusComposer', { windowId: 7 }]]);
  // a project's new chat; a file in the app's own preview
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'LocalProject', provider: 'codex', id: 'p1' }], caller: USER })).status, 'done');
  assert.deepEqual(ops.at(-1), ['composer', 'new-chat', { projectId: 'p1', windowId: 7 }]);
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ type: 'File', provider: 'codex', id: '/r/a.txt' }], caller: USER })).status, 'done');
  assert.deepEqual(ops.at(-1), ['windows', 'appAction', { windowId: 7, action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: '/r/a.txt' } } }]);
  // an automation in this window (its own open, told the window); the panel's new chat is no window's main view
  const auto = { type: 'Automation', provider: 'codex', id: 'a1' };
  codex.put(auto, { state: { name: 'Nightly', prompt: { parts: [] }, schedule: { kind: 'interval' }, enabled: true }, links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [auto], caller: USER })).status, 'done');
  assert.deepEqual(opened, [{ window: refs.window(7) }]);
  const panel = { type: 'Draft', provider: 'codex', id: 'new:app:panel-new-conversation' };
  codex.put(panel, { state: { content: { parts: [] }, dictating: false }, links: { thread: null } });
  assert.equal((await graph.invoke({ ref: refs.window(7), operation: 'open', args: [panel], caller: USER })).reason, 'unsupported');
  w.dispose();
});

test('H7lr review: the framework\'s notice about one window is a toast in that window, never the focused one; none when that window has no page', async () => {
  const { w } = setup({ focused: 7 });
  const in7 = [], in9 = [];
  w.report(7, w.open(7, { post: (m) => in7.push(m) }), { window: {}, puts: [] });
  w.report(9, w.open(9, { post: (m) => in9.push(m) }), { window: {}, puts: [] });
  await w.notify({ id: 'unit.a', name: 'Unit A' }, { title: 'Link not opened', surface: 'toast', dedupe: 'codexmods-link-9' }, { windowId: 9 });
  assert.deepEqual([in7.length, in9.map((m) => m.t)], [0, ['notice']]);
  await assert.rejects(w.notify({ id: 'unit.a', name: 'Unit A' }, { title: 'x', surface: 'toast' }, { windowId: 12 }), /no window/);
  // the page the link was opened in, not the one that replaced it after a reload (round 2)
  const gen9 = w.genOf(9);
  await w.notify({ id: 'unit.a', name: 'Unit A' }, { title: 'Same page', surface: 'toast', dedupe: 'codexmods-link-9' }, { windowId: 9, gen: gen9 });
  assert.equal(in9.at(-1).title, 'Same page');
  await assert.rejects(w.notify({ id: 'unit.a', name: 'Unit A' }, { title: 'Old page', surface: 'toast' }, { windowId: 9, gen: gen9 - 1 }), /no window/);
  await assert.rejects(w.notify({ id: 'unit.a', name: 'Unit A' }, { title: 'x', surface: 'desktop' }, { windowId: 9 }), /toast/);
  w.dispose();
});

test('public hooks §3.14: a mod\'s notification, a toast in the window the user is in or on the desktop, named as the mod; what the user did goes to that mod; dedupe replaces; it ends with the mod', async () => {
  const { w, ops } = setup({ focused: 7 });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [] });
  const heard = [], other = [];
  w.onNotices('unit.a', (e) => heard.push(e));
  w.onNotices('unit.b', (e) => other.push(e));
  const A = { id: 'unit.a', name: 'Unit A' };
  const { id } = await w.notify(A, { title: 'Synced', body: '3 files', actions: [{ id: 'open', title: 'Open' }, { id: 'undo', title: 'Undo' }, { id: 'more', title: 'More' }], dedupe: 'sync' });
  const m = posted.at(-1);
  assert.deepEqual([m.t, m.id, m.requester, m.title, m.actions.map((a) => a.id)], ['notice', id, A, 'Synced', ['open', 'undo']], 'a toast: two buttons at most');
  assert.equal(m.from, 'unit.a (Unit A)', 'who sent it, in the framework\'s words: its id first, then its name');
  assert.equal(w.noticeAnswer(7, gen, id, { action: 'undo' }), false, 'without its showing\'s token: not its answer');
  assert.equal(w.noticeAnswer(7, gen, id, { action: 'undo', token: m.token }), true);
  assert.equal(w.noticeAnswer(8, gen, id, { action: 'undo', token: m.token }), false, 'another window\'s page: not its toast');
  assert.deepEqual(heard, [{ id, action: 'undo', window: { type: 'Window', provider: PROVIDER, id: '7' } }]);
  assert.deepEqual(other, [], 'only the mod that sent it hears');
  const { id: again } = await w.notify(A, { title: 'Synced again', dedupe: 'sync' });
  assert.deepEqual([again, posted.at(-2).t, posted.at(-2).id], [id, 'noticeEnd', id], 'the same dedupe: the earlier one ends, the new one shows');
  assert.equal(w.noticeAnswer(7, gen, id, { action: 'undo', token: m.token }), false, 'a late click on the earlier showing is not the new one\'s');
  w.noticeAnswer(7, gen, id, { gone: true, token: posted.at(-1).token });
  assert.deepEqual(heard.at(-1), { id, gone: true });
  // on the desktop: the app's own notification through framework-main, the mod named under its body; a click opens its subject
  const { id: d } = await w.notify(A, { title: 'Done', body: 'All good', surface: 'desktop', subject: T1, actions: [{ id: 'ok', title: 'OK' }] });
  const shown = ops.find(([area, op]) => area === 'notifications' && op === 'show')[2];
  assert.deepEqual([shown.id.startsWith(`codexmods:${d}#`), shown.title, shown.body, shown.actions], [true, 'Done', 'unit.a (Unit A)\nAll good', [{ id: 'ok', title: 'OK' }]], 'who sent it first');
  assert.equal(await w.noticeDesktop(`codexmods:${d}#0`, 'ok'), false, 'another showing\'s');
  assert.equal(await w.noticeDesktop(shown.id, 'ok'), true);
  assert.equal(heard.at(-1).action, 'ok');
  assert.equal(await w.noticeDesktop(shown.id, null), true, 'its body: its subject opens');
  assert.equal(w.notifyEnd('unit.b', d), false, 'only its mod ends it');
  assert.equal(w.notifyEnd('unit.a', d, 'not-its-token'), false, 'only that showing');
  assert.equal(w.notifyEnd('unit.a', d), true);
  assert.deepEqual(ops.filter(([area, op]) => area === 'notifications' && op === 'dismiss').at(-1), ['notifications', 'dismiss', { id: shown.id }]);
  // the mod stops: its notifications go
  const { id: t } = await w.notify(A, { title: 'Later' });
  w.cancelAsks('unit.a');
  assert.deepEqual([posted.at(-1).t, posted.at(-1).id], ['noticeEnd', t]);
  await assert.rejects(w.notify(A, { title: '' }), /title/);
  await assert.rejects(w.notify(A, { title: 'x', actions: [{ id: 'a b', title: 'x' }] }), /actions/);
  const { id: late } = await w.notify(A, { title: 'Page goes' });
  w.close(7, gen);
  assert.deepEqual(heard.at(-1), { id: late, gone: true }, 'its page went: so did its toast');
  w.dispose();
});

test('public hooks §3.14, graph-integrity G4.2: a question\'s fields (settings\' declarations) go to the page; the answer\'s values are each of its field\'s kind, by key (else its default); the mod withdraws it by its token', async () => {
  const { w } = setup({ focused: 7 });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { window: { sidebar: { open: true } }, puts: [] });
  const fields = askFieldsOf([{ key: 'name', kind: 'text', title: 'Name', default: 'x' }, { key: 'key', kind: 'text', control: 'secret', title: 'Key' },
    { key: 'on', kind: 'toggle', title: 'On', default: true }, { key: 'size', kind: 'choice', title: 'Size', default: 's', options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }] },
    { key: 'count', kind: 'number', title: 'Count', default: 2, min: 1, max: 5 }]);
  const spec = { requester: { id: 'unit.a', name: 'Unit A' }, subject: T1, purpose: 'confirm', title: 'Set up?', message: 'Fill in', actions: [{ id: 'ok', title: 'OK' }], fields };
  const p = w.ask(spec);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.at(-1).fields, fields);
  w.askAnswer(7, gen, posted.at(-1).id, { choice: 'ok', values: { name: 'Ann', key: 's3cr3t', on: 'yes', size: 'xl', count: 9, extra: 1 } });
  assert.deepEqual(await p, { choice: 'ok', by: 'user', values: { name: 'Ann', key: 's3cr3t', on: true, size: 's', count: 2 } }, 'a value its field does not take: its default; others dropped');
  const q = w.ask({ ...spec, fields: undefined, withdraw: 'tok-12345678' });
  await new Promise((r) => setImmediate(r));
  w.askWithdraw('unit.b', 'tok-12345678');
  assert.equal(posted.at(-1).t, 'ask', 'another mod\'s token: this question goes on');
  assert.equal(w.askWithdraw('unit.a', 'tok-12345678'), true);
  assert.deepEqual(await q, { cancelled: true, by: 'requester', reason: 'withdrawn' });
  assert.equal(posted.at(-1).t, 'askEnd');
  w.dispose();
});

test('a Window\'s thread and project: the chat it shows, and the project of what it shows (that chat\'s, a new chat\'s target, a project\'s page), followed as they change', () => {
  const { graph, codex, w } = setup({ extra: { Thread: {}, Project: {}, Draft: {} } });
  const P1 = { type: 'Project', provider: 'codex', id: 'p1' }, P2 = { type: 'Project', provider: 'codex', id: 'p2' };
  const T9 = { type: 'Thread', provider: 'codex', id: 't9' }, D1 = { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' };
  codex.put(P1, { state: { name: 'Prod', location: '/p/prod' } });
  codex.put(P2, { state: { name: 'Play', location: '/p/play' } });
  const AG = { type: 'Agent', provider: 'codex', id: 'codex' };
  const chat = { title: 'Deploy', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 };
  const gen = opened(w, 3);
  const links = () => { const l = graph.resolve(refs.window(3)).links; return [l.thread?.id ?? null, l.project?.id ?? null]; };
  assert.deepEqual(links(), [null, null]);
  // a chat not resident yet: its project is known once it arrives
  w.report(3, gen, { puts: [P(1, 'ThreadView', T9, { in: 'Window' }, { slot: 'main' })] });
  assert.deepEqual(links(), ['t9', null]);
  codex.put(T9, { state: chat, links: { project: P1, agent: AG } });
  assert.deepEqual(links(), ['t9', 'p1']);
  assert.equal(graph.list('Window', { 'project.name': 'Prod' }).length, 1, 'a where reads it');
  // the chat moves to another project
  codex.put(T9, { state: chat, links: { project: P2, agent: AG } });
  assert.deepEqual(links(), ['t9', 'p2']);
  // the new chat page: the project it starts in
  w.report(3, gen, { removes: [1], puts: [P(2, 'NewThreadView', D1, { in: 'Window' }, { slot: 'main' })] });
  codex.put(D1, { state: { content: { parts: [] }, dictating: false, target: { project: P1, settings: {} } } });
  assert.deepEqual(links(), [null, 'p1']);
  // a project's own page (its settings)
  w.report(3, gen, { removes: [2], puts: [P(3, 'SettingsPage', P2, { in: 'Window' }, { slot: 'main' })] });
  assert.deepEqual(links(), [null, 'p2']);
});

test('H7w review: a chat shown as a Thread and known since as its subtype (CodexThread) keeps its Window\'s project current', () => {
  const { graph, codex, w } = setup({ extra: { Thread: {}, CodexThread: {}, Project: {} } });
  const P1 = { type: 'Project', provider: 'codex', id: 'p1' }, P2 = { type: 'Project', provider: 'codex', id: 'p2' };
  for (const [p, name] of [[P1, 'Prod'], [P2, 'Play']]) codex.put(p, { state: { name, location: `/p/${name}` } });
  const AG = { type: 'Agent', provider: 'codex', id: 'codex' };
  const chat = { title: 'Deploy', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 };
  const gen = opened(w, 5);
  w.report(5, gen, { puts: [P(1, 'ThreadView', { type: 'Thread', provider: 'codex', id: 't5' }, { in: 'Window' }, { slot: 'main' })] });
  const C5 = { type: 'CodexThread', provider: 'codex', id: 't5' };
  codex.put(C5, { state: chat, links: { project: P1, agent: AG } });
  const links = () => { const l = graph.resolve(refs.window(5)).links; return [l.thread?.type ?? null, l.project?.id ?? null]; };
  assert.deepEqual(links(), ['CodexThread', 'p1']);
  codex.put(C5, { state: chat, links: { project: P2, agent: AG } });
  assert.deepEqual(links(), ['CodexThread', 'p2']);
});

test('H7pl review: a window that is then changed is taken only when it alone came since the ask, a while with no other; one opened by the user at the same moment: refused', async () => {
  const { w, bus } = setup({ extra: { CodexThread: {} } });
  const home = { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' };
  opened(w, 7);
  const arrive = (id, ms = 30) => setTimeout(() => { bus('window/created', { windowId: id }); setTimeout(() => opened(w, id, [P(1, 'NewThreadView', home, { in: 'Window' }, { slot: 'main' })]), 30); }, ms);
  arrive(20);
  const t0 = Date.now();
  const one = await w.openWindow(null, null, { exact: true });
  assert.deepEqual([one.status, one.value], ['done', refs.window(20)]);
  assert.ok(Date.now() - t0 >= 1400, 'after a while with no other');
  // the user's own new home window comes too: neither is taken
  arrive(21);
  arrive(22, 200);
  const two = await w.openWindow(null, null, { exact: true });
  assert.deepEqual([two.status, /another window opened/.test(two.message)], ['refused', true]);
  // no longer wanted before it is made: nothing asked of the app
  const none = await w.openWindow(null, null, { exact: true, beforeCreate: () => false });
  assert.equal(none.status, 'refused');
});

test('layouts D4, WL3: Window.setRegion sets a region in this window now: opened first, then sized in its page, done once the window shows it', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const shows = (window) => w.report(7, gen, { puts: [], window: { layout: { mode: 'chat' }, ...window } });
  w.report(7, gen, { puts: [P(1, 'Sidebar', refs.app(), { in: 'Window' }, { slot: 'sidebar' }), P(2, 'SidePanel', thread, { in: 'Window' }, { slot: 'panel' })],
    window: { sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: false }, layout: { mode: 'chat' } } });
  const set = (region, want) => graph.invoke({ ref: refs.window(7), operation: 'setRegion', args: [region, want], caller: USER });
  const tick = () => new Promise((r) => setImmediate(r));
  for (const [args, why] of [[['sidebar', {}], /open, size or both/], [['side', { open: false, size: 400 }], /closed region has no size/], [['sidebar', { size: -1 }], /number of px/]]) {
    const r = await set(...args);
    assert.deepEqual([r.status, r.reason, why.test(r.message)], ['refused', 'invalid', true]);
  }
  // the sidebar's width: the Sidebar's page operation, done once the window shows that width
  const wide = set('sidebar', { size: 400 });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args, posted.at(-1).n], ['width', [400], 1]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 400 }, side: { open: false }, bottom: { open: false } }), 60);
  assert.equal((await wide).status, 'done');
  // the page refuses (out of the app's bounds): refused, as the page says
  const narrow = set('sidebar', { size: 100 });
  await tick();
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'a width from 240 to 520 px' });
  assert.deepEqual([(await narrow).status, (await narrow).message], ['refused', 'a width from 240 to 520 px']);
  // the side panel's width in its page; the window shows another width: failed, said
  const side = set('side', { size: 500 });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args, posted.at(-1).n], ['resize', [500], 2], 'the SidePanel\'s page operation');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 400 }, side: { open: true, size: 380 }, bottom: { open: false } }), 60);
  const r = await side;
  assert.deepEqual([r.status, /no room for a side panel of 500 px/.test(r.error?.message)], ['failed', true]);
  // the side panel opened by the app's toggle: done only once the page shows it open; a reload meanwhile leaves it uncertain
  shows({ sidebar: { open: true, width: 400 }, side: { open: false }, bottom: { open: false } });
  const opening = set('side', { open: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 400 }, side: { open: true, size: 500 }, bottom: { open: false } }), 60);
  assert.equal((await opening).status, 'done');
  const lost = set('side', { open: false });
  setTimeout(() => w.open(7, { post: (m) => posted.push(m) }), 60);
  assert.equal((await lost).status, 'uncertain', 'the page that would show it went');
  // the new page's first report of its other facts (before its shell is drawn) does not make the old page's arrangement count
  const gen3 = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen3, { puts: [], window: { attachments: {}, newChat: null } });
  const early = await set('sidebar', { size: 400 });
  assert.deepEqual([early.status, early.reason], ['refused', 'unavailable'], 'no sidebar known open on this page yet');
  w.dispose();
});

test('layouts WL4c: Window.setRegion moves the sidebar to the right in its page (the window\'s own act), done once the page says it there; the Window says its edge', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const shows = (window) => w.report(7, gen, { puts: [], window: { layout: { mode: 'chat' }, side: { open: false }, bottom: { open: false }, ...window } });
  w.report(7, gen, { puts: [P(1, 'Sidebar', refs.app(), { in: 'Window' }, { slot: 'sidebar' })], window: { sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: false }, layout: { mode: 'chat' } } });
  const set = (region, want) => graph.invoke({ ref: refs.window(7), operation: 'setRegion', args: [region, want], caller: USER });
  const tick = () => new Promise((r) => setImmediate(r));
  assert.match((await set('side', { edge: 'right' })).message, /only the sidebar takes edge/);
  const right = set('sidebar', { edge: 'right' });
  await tick();
  assert.deepEqual([posted.at(-1).t, posted.at(-1).key, posted.at(-1).op, posted.at(-1).args], ['decl-act', 'codexmods:window', 'sidebar.edge', { edge: 'right' }], 'the window\'s own act: no presentation needed (a closed sidebar is not drawn)');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 340 }, sidebarEdge: 'right' }), 60);
  assert.equal((await right).status, 'done');
  assert.deepEqual(graph.resolve(refs.window(7)).state.sidebar, { open: true, width: 340, edge: 'right' });
  const left = set('sidebar', { edge: 'left' });
  await tick();
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 340 }, sidebarEdge: 'left' }), 60);
  assert.equal((await left).status, 'done');
  assert.deepEqual(graph.resolve(refs.window(7)).state.sidebar, { open: true, width: 340 });
  // what the framework holds for space (layouts WL4d): said, then gone; nonsense left out
  shows({ sidebar: { open: true, width: 340 }, suspended: ['unit.r/notes', 'side', 'nonsense'] });
  assert.deepEqual(graph.resolve(refs.window(7)).state.suspended, ['unit.r/notes', 'side']);
  shows({ sidebar: { open: true, width: 340 }, suspended: [] });
  assert.equal('suspended' in graph.resolve(refs.window(7)).state, false);
  w.dispose();
});

test('layouts WL4a: the Window says its mods\' regions; Window.setRegion sets one in its page (the declaration\'s act), done once the page says it so', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const shell = { navigation: 'sidebar', sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: false } };
  w.report(7, gen, { puts: [], window: { ...shell, regions: { 'unit.r/notes': { open: true, size: 280, edge: 'right' }, 'bad key': { open: true, edge: 'right' } } } });
  assert.deepEqual(graph.resolve(refs.window(7)).state.regions, { 'unit.r/notes': { open: true, size: 280, edge: 'right' } });
  const set = (region, want) => graph.invoke({ ref: refs.window(7), operation: 'setRegion', args: [region, want], caller: USER });
  const wide = set('unit.r/notes', { size: 360 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).t, posted.at(-1).key, posted.at(-1).op, posted.at(-1).args], ['decl-act', 'unit.r/notes', 'region.set', { size: 360 }]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => w.report(7, gen, { puts: [], window: { ...shell, regions: { 'unit.r/notes': { open: true, size: 360, edge: 'right' } } } }), 60);
  assert.equal((await wide).status, 'done');
  const gone = set('unit.r/none', { open: false });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'that declaration is not in this window' });
  assert.equal((await gone).status, 'refused');
  assert.equal((await set('nope', { open: true })).reason, 'invalid');
  w.dispose();
});

test('layouts WL1-3 review, WL4b: Window.setRegion\'s bottom panel in its chat\'s page, opened, then sized by its frame, done once shown', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const shows = (window) => w.report(7, gen, { puts: [], window: { layout: { mode: 'chat' }, ...window } });
  w.report(7, gen, { puts: [P(2, 'SidePanel', thread, { in: 'Window' }, { slot: 'panel' })], window: { sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: false }, layout: { mode: 'chat' } } });
  const set = (region, want) => graph.invoke({ ref: refs.window(7), operation: 'setRegion', args: [region, want], caller: USER });
  const tick = () => new Promise((r) => setImmediate(r));
  // the bottom panel opened in its chat's page, done once shown
  const bottom = set('bottom', { open: true });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['bottom', [true]]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: true, height: 280 } }), 60);
  assert.equal((await bottom).status, 'done');
  // its height (layouts WL4b): the chat's SidePanel's page operation (the bottom panel's frame is a part of it), done once the window shows it
  const tall = set('bottom', { size: 360 });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args, posted.at(-1).n], ['bottomHeight', [360], 2]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: true, height: 361 } }), 60);
  assert.equal((await tall).status, 'done');
  // a window in the background draws no frame: what it was asked to show is not shown yet, so uncertain, not failed
  shows({ sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: true, height: 361 }, hidden: true });
  const behind = set('bottom', { size: 300 });
  await tick();
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await behind).status, 'uncertain');
  shows({ sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: true, height: 361 } });
  // out of the app's bounds: refused, as the page says; closed: refused before the page is asked
  const huge = set('bottom', { size: 2000 });
  await tick();
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'the bottom panel takes 160 to 400 px here' });
  assert.deepEqual([(await huge).status, (await huge).message], ['refused', 'the bottom panel takes 160 to 400 px here']);
  shows({ sidebar: { open: true, width: 340 }, side: { open: false }, bottom: { open: false } });
  const n = posted.length;
  assert.match((await set('bottom', { size: 300 })).message, /bottom panel is closed/);
  assert.equal(posted.length, n, 'the page is not asked');
  // beside the chat (layouts WL4b): placed in its page first, done once the page says it there; then its size is its width
  const base = { sidebar: { open: true, width: 340 }, side: { open: false } };
  shows({ ...base, bottom: { open: true, height: 280 } });
  const right = set('bottom', { at: 'right' });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['bottomAt', ['right']]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ ...base, bottom: { open: true, width: 420 }, bottomAt: 'right' }), 60);
  assert.equal((await right).status, 'done');
  assert.deepEqual(graph.resolve(refs.window(7)).state.bottom, { open: true, width: 420, at: 'right' });
  const wide = set('bottom', { size: 500 });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['bottomWidth', [500]], 'beside: its width');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ ...base, bottom: { open: true, width: 500 }, bottomAt: 'right' }), 60);
  assert.equal((await wide).status, 'done');
  // asked again: sent all the same (what is drawn may be a hold for space), done once the window shows it there
  const again = set('bottom', { at: 'right' });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['bottomAt', ['right']]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await again).status, 'done');
  assert.match((await set('side', { at: 'left' })).message, /only the bottom panel takes at/);
  // held for space it draws below: asking `below` is still sent, or the right-hand placement would come back when the window widens
  shows({ ...base, bottom: { open: true, height: 280 }, bottomAt: 'below', suspended: ['bottom'] });
  const cancel = set('bottom', { at: 'below' });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['bottomAt', ['below']]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  assert.equal((await cancel).status, 'done');
  shows({ ...base, bottom: { open: true, width: 500 }, bottomAt: 'right', suspended: [] });
  // back below: the app's own again
  const below = set('bottom', { at: 'below' });
  await tick();
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => shows({ ...base, bottom: { open: true, height: 280 }, bottomAt: 'below' }), 60);
  assert.equal((await below).status, 'done');
  assert.deepEqual(graph.resolve(refs.window(7)).state.bottom, { open: true, height: 280 });
  w.dispose();
});

test('layouts D4, WL3: a mod\'s default of the sidebar\'s width shows in each window where the user kept none, once per page and when it changes; the user\'s kept width wins', async () => {
  const { w, codex } = setup({ extra: { Setting: {}, SettingsSection: {} } });
  const SW = { type: 'Setting', provider: 'codex', id: 'layout.sidebarWidth' };
  const core = { title: 'Sidebar width', scope: 'app', kind: 'number' };
  const put = (state) => codex.put(SW, { state: { ...core, ...state }, links: { section: { type: 'SettingsSection', provider: 'codex', id: 'other' }, definedBy: refs.app() } });
  const posted = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const page = (g) => w.report(7, g, { puts: [P(1, 'Sidebar', refs.app(), { in: 'Window' }, { slot: 'sidebar' })], window: { sidebar: { open: true, width: 340 } } });
  put({ value: 340, default: 340, overridden: false });
  page(gen);
  await tick();
  assert.equal(posted.length, 0, 'the app\'s own width: nothing to do');
  put({ value: 420, default: 420, overridden: false });
  await tick();
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args], ['width', [420, true]], 'the default, as Window.setRegion sets it (the app\'s width, the rail\'s with it)');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  page(gen);
  await tick();
  assert.equal(posted.length, 1, 'once for that value in this page');
  // a reload: the page starts with the app's width again, and is given the default once more
  const gen2 = w.open(7, { post: (m) => posted.push(m) });
  page(gen2);
  await tick();
  assert.deepEqual([posted.length, posted.at(-1).args], [2, [420, true]]);
  // the user drags (their width kept): nothing more; the default goes while they kept none: back to the app's
  put({ value: 380, default: 420, overridden: true });
  await tick();
  assert.equal(posted.length, 2, 'the user\'s kept width wins');
  put({ value: 340, default: 340, overridden: false });
  await tick();
  assert.deepEqual([posted.length, posted.at(-1).args], [3, [340, true]], 'the default gone: the app\'s own width');
  w.dispose();
});

test('H7pl review 2, WL3: Window.setLayout is set in the page through its SidePanel (the app\'s guarded setters), done once the page shows that layout; refused there or with no chat shown', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false }, layout: { mode: 'chat' } } });
  const none = await graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['split'], caller: USER });
  assert.deepEqual([none.status, none.message], ['refused', 'the window shows no workspace with a side panel']);
  w.report(7, gen, { puts: [P(1, 'SidePanel', { type: 'CodexThread', provider: 'codex', id: 'th-1' }, { in: 'Window' }, { slot: 'panel' })], window: { sidebar: { open: true }, side: { open: false }, layout: { mode: 'chat' } } });
  const full = graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['full'], caller: USER });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).args, posted.at(-1).n], ['layout', ['full'], 1], 'the SidePanel\'s page operation');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  setTimeout(() => w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: true, size: 1200, full: true }, layout: { mode: 'full' } } }), 60);
  assert.equal((await full).status, 'done');
  assert.deepEqual(graph.resolve(refs.window(7)).state.layout, { mode: 'full' }, 'the Window says how its workspace is laid out');
  // the page refuses (the tab shown does not fill the workspace): refused, nothing waited for
  const refused = graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['full'], caller: USER });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'the tab it shows does not fill the workspace' });
  assert.deepEqual([(await refused).status, (await refused).message], ['refused', 'the tab it shows does not fill the workspace']);
  // done in the page, but the app shows another layout (nothing beside the chat to split with): failed
  const split = graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['split'], caller: USER });
  await new Promise((r) => setImmediate(r));
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  const r = await split;
  assert.deepEqual([r.status, /shows full, not split/.test(r.error?.message)], ['failed', true]);
  assert.equal(w.threadOf(7), null, 'the chat a window shows: none here');
  // a home page has tabs but no chat (a view opened in its own window): its panel tab sets the layout (layouts WL1-3 review)
  const gen2 = w.open(8, { post: (m) => posted.push(m) });
  w.report(8, gen2, { puts: [P(1, 'PanelTab', { type: 'Mod', provider: 'codexmods.framework', id: 'unit.v' }, { in: null }, { slot: 'tabs' })], window: { sidebar: { open: true }, side: { open: true, size: 600 }, layout: { mode: 'split' } } });
  const home = graph.invoke({ ref: refs.window(8), operation: 'setLayout', args: ['full'], caller: USER });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([posted.at(-1).operation, posted.at(-1).n], ['layout', 1], 'the panel tab\'s page operation');
  w.answer(8, gen2, posted.at(-1).id, { ok: true });
  setTimeout(() => w.report(8, gen2, { puts: [], window: { sidebar: { open: true }, side: { open: true, size: 1200, full: true }, layout: { mode: 'full' } } }), 60);
  assert.equal((await home).status, 'done');
  w.dispose();
});

test('layouts WL5a: Window.open of a mod\'s page: named <mod>/<id>, done once the window says it shows it, never on main\'s word alone; the Window says the page', async () => {
  const { graph, w } = setup();
  const gen = w.open(7, { post: () => {} });
  const report = (window) => w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, ...window } });
  report({});
  const open = (page) => graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ page }], caller: USER });
  const bad = await open('../x');
  assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid']);
  let settled = null;
  const going = open('qa.mod/notes').then((r) => { settled = r; return r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, null, 'main has been asked, the window has not said it');
  report({ page: 'qa.mod/notes' });
  assert.equal((await going).status, 'done');
  assert.equal(graph.resolve(refs.window(7)).state.page, 'qa.mod/notes');
  report({ page: null });
  assert.equal(graph.resolve(refs.window(7)).state.page, undefined, 'gone with the page');
});

test('layouts WL6: a mod\'s named layout: asked of its page, done once it has reached what the window shows, with what is not as asked; the app\'s own ends it; another mod\'s call on what it holds is refused; a reload asks it again', async () => {
  const { graph, w } = setup({ grants: { 'other.mod': ['graph.act'] } });
  const posted = [];
  let gen = w.open(7, { post: (m) => posted.push(m) });
  const facts = { sidebar: { open: true }, side: { open: true }, bottom: { open: false }, layout: { mode: 'split' } };
  const report = (more) => w.report(7, gen, { puts: [], window: { ...facts, ...more } });
  report({ claim: null });
  const set = (id, caller = USER) => graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: [id], caller });
  const tick = () => new Promise((r) => setImmediate(r));
  assert.equal((await set('bad id')).status, 'refused');
  const going = set('qa.mod/focus');
  await tick();
  const asked = posted.at(-1);
  assert.deepEqual([asked.t, asked.key, asked.op, asked.args], ['decl-act', 'codexmods:window', 'layout.set', { id: 'qa.mod/focus' }]);
  w.answer(7, gen, asked.id, { ok: true });
  report({ claim: { picked: 'qa.mod/focus', settled: false, holds: ['side'] } });
  await tick();
  report({ claim: { picked: 'qa.mod/focus', settled: true, holds: ['side', 'sidebar'], partial: [{ region: 'side', why: 'no tab' }] } });
  const done = await going;
  assert.deepEqual([done.status, done.value], ['done', { layout: 'qa.mod/focus', partial: [{ region: 'side', why: 'no tab' }] }]);
  const st = graph.resolve(refs.window(7)).state.layout;
  assert.deepEqual([st.picked, st.mode, st.partial], ['qa.mod/focus', 'split', [{ region: 'side', why: 'no tab' }]]);
  // a region it holds is its while it holds it: another mod's call is refused, the user's is not
  const region = (caller) => graph.invoke({ ref: refs.window(7), operation: 'setRegion', args: ['side', { open: false }], caller });
  const other = await region({ kind: 'mod', id: 'other.mod' });
  assert.deepEqual([other.status, other.reason, /holds that region/.test(other.message)], ['refused', 'notAllowed', true]);
  const panelCall = (caller) => graph.invoke({ ref: refs.window(7), operation: 'setPanel', args: [false], caller });
  assert.deepEqual([(await panelCall({ kind: 'mod', id: 'other.mod' })).reason], ['notAllowed'], 'the same region by the panel\'s own operation');
  const sidebarCall = await graph.invoke({ ref: refs.window(7), operation: 'toggleSidebar', args: [], caller: { kind: 'mod', id: 'other.mod' } });
  assert.deepEqual([sidebarCall.reason], ['notAllowed']);
  // a mod's pick says who asks: the mods' order decides
  const byMod = graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['qa.mod/focus'], caller: { kind: 'mod', id: 'other.mod' } });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(posted.at(-1).args, { id: 'qa.mod/focus', by: 'other.mod' });
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'the layout mod.ahead/a holds this window' });
  assert.equal((await byMod).status, 'refused');
  // a reload: the new page takes it up itself (its journal is the page's); the Host asks nothing
  report({ claim: { picked: 'qa.mod/focus', settled: true, holds: ['sidebar'], released: ['side'] } });
  gen = w.open(7, { post: (m) => posted.push(m) });
  const n = posted.length;
  report({ claim: { picked: 'qa.mod/focus', settled: false, released: ['side'] } });
  await tick();
  assert.equal(posted.slice(n).some((m) => m.op === 'layout.set'), false);
  // the app's own mode, a layout held: in its page at once, which ends it, each thing it wrote going back, and sets the mode
  const app = set('chat');
  await tick();
  const asked2 = posted.at(-1);
  assert.deepEqual([asked2.op, asked2.args], ['layout.app', { mode: 'chat' }]);
  w.answer(7, gen, asked2.id, { ok: true });
  report({ claim: null, layout: { mode: 'chat' } });
  assert.equal((await app).status, 'done');
  // what the app refuses there leaves the layout: the page answers so
  report({ claim: { picked: 'qa.mod/focus', settled: true } });
  const refusedFull = set('full');
  await tick();
  const full = posted.at(-1);
  assert.deepEqual([full.op, full.args], ['layout.app', { mode: 'full' }]);
  w.answer(7, gen, full.id, { refused: 'unavailable', message: 'the tab it shows does not fill the workspace' });
  assert.equal((await refusedFull).status, 'refused');
  // a mod's call says who asks: the mods' order decides here too
  const modChat = graph.invoke({ ref: refs.window(7), operation: 'setLayout', args: ['chat'], caller: { kind: 'mod', id: 'other.mod' } });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(posted.at(-1).args, { mode: 'chat', by: 'other.mod' });
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'the layout qa.mod/focus holds this window' });
  assert.equal((await modChat).status, 'refused');
  // with no layout, where the window shows no workspace: refused
  report({ claim: null });
  assert.equal((await set('split')).status, 'refused');
  // ended: not asked again after a reload
  const m = posted.length;
  gen = w.open(7, { post: (x) => posted.push(x) });
  report({ claim: null });
  await tick();
  assert.equal(posted.slice(m).some((x) => x.op === 'layout.set'), false, 'ended: not asked again after a reload');
});

test('layouts WL5: Window.open({page}) with no page running says so: delivery is not being there', async () => {
  const { graph, w } = setup();
  const gen = w.open(7, { post() {} });
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false } } });
  w.close(7, gen);
  const out = await graph.invoke({ ref: refs.window(7), operation: 'open', args: [{ page: 'qa.mod/notes' }], caller: USER });
  assert.notEqual(out.status, 'done');
});

test('layouts WL7: Window.open(thread, {placement: side}) asks the page for a pane beside, done once the page says it is there; only a chat on this computer', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false } } });
  const open = (ref, placement = 'side') => graph.invoke({ ref: refs.window(7), operation: 'open', args: [ref, { placement }], caller: USER });
  const chat = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const tick = () => new Promise((r) => setImmediate(r));
  assert.equal((await open({ type: 'File', provider: 'codex', id: '/x' })).reason, 'invalid');
  assert.match((await open(chat, 'nowhere')).message, /main \| window \| side/);
  const going = open(chat);
  for (let i = 0; i < 3; i++) await tick();
  const asked = posted.at(-1);
  assert.deepEqual([asked.t, asked.key, asked.op, asked.args], ['decl-act', 'codexmods:window', 'chat.side', { ref: chat }]);
  w.answer(7, gen, asked.id, { ok: true });
  await tick();
  w.report(7, gen, { puts: [], window: { panes: { list: [{ token: 'pane-1', thread: chat }], active: null } } });
  assert.equal((await going).status, 'done');
  // a pane the user is not in: the Window goes on saying what it shows
  const st = () => graph.resolve(refs.window(7)).state;
  assert.deepEqual(st().panes.map((p) => p.token), ['pane-1']);
  assert.equal('activePane' in st(), false);
  w.report(7, gen, { puts: [], window: { side: { open: true, size: 400 }, panes: { list: [{ token: 'pane-1', thread: chat }], active: 'pane-1' } } });
  assert.deepEqual([st().side.size, st().activePane], [400, 'pane-1']);
  w.report(7, gen, { puts: [], window: { side: { open: true, size: 500 }, panes: { list: [{ token: 'pane-1', thread: chat }], active: null } } });
  assert.equal(st().side.size, 500, 'it is not left stale when the user leaves the pane');
});

test('graph-integrity G4.3: a Window says what it shows, its main region\'s subject then each pane\'s chat (once each), and which one the user is in', () => {
  const { graph, w } = setup();
  const gen = w.open(7);
  const pane = { type: 'CodexThread', provider: 'codex', id: 'th-2' };
  const st = () => graph.resolve(refs.window(7)).state;
  w.report(7, gen, { puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' })], window: { sidebar: { open: true }, panes: { list: [{ token: 'pane-1', thread: pane }, { token: 'pane-2', thread: T1 }], active: null } } });
  assert.deepEqual([st().shows, st().focusedSubject], [[T1, pane], T1], 'the main region\'s, then the panes\'; the main region\'s focused');
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, panes: { list: [{ token: 'pane-1', thread: pane }], active: 'pane-1' } } });
  assert.deepEqual([st().shows, st().focusedSubject], [[T1, pane], pane], 'the pane the user is in');
  w.report(7, gen, { removes: [1], window: { sidebar: { open: true }, panes: { list: [], active: null } } });
  assert.deepEqual([st().shows, 'focusedSubject' in st()], [[], false], 'nothing shown');
});

test('layouts WL6: Window.setSidebar goes through the app\'s core setter in its page, never its "by hand" toggle, done once the page says so; a page without it, the toggle', async () => {
  const { graph, w, ops } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false } } });
  const set = (open) => graph.invoke({ ref: refs.window(7), operation: 'setSidebar', args: [open], caller: USER });
  const tick = () => new Promise((r) => setImmediate(r));
  const closing = set(false);
  await tick();
  assert.deepEqual([posted.at(-1).op, posted.at(-1).args], ['sidebar.open', { open: false }]);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  w.report(7, gen, { puts: [], window: { sidebar: { open: false } } });
  assert.equal((await closing).status, 'done');
  assert.equal(ops.some((o) => o[1] === 'toggleSidebar'), false);
  const opening = set(true);
  await tick();
  w.answer(7, gen, posted.at(-1).id, { refused: 'unavailable', message: 'no setter' });
  await tick();
  assert.deepEqual(ops.at(-1), ['windows', 'toggleSidebar', { windowId: 7 }]);
  w.report(7, gen, { puts: [], window: { sidebar: { open: true } } });
  assert.equal((await opening).status, 'done');
});

test('layouts WL7: a chat in two panes of a window is two presentations: named, an operation acts on that pane\'s, gone when it has closed; unnamed, on the one the user is in; panes are said', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const P2 = (n, pane) => ({ ...P(n, 'ThreadView', thread, { in: 'Window' }, { slot: 'main' }), ...(pane ? { pane } : {}) });
  w.report(7, gen, { puts: [P2(1, null), P2(2, 'pane-1'), P2(3, 'pane-2')], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, panes: { list: [{ token: 'pane-1', thread }, { token: 'pane-2', thread }], active: 'pane-1' } } });
  const st = graph.resolve(refs.window(7)).state;
  assert.deepEqual([st.panes.map((x) => x.token), st.activePane], [['pane-1', 'pane-2'], 'pane-1']);
  const find = (...args) => graph.invoke({ ref: refs.window(7), operation: 'find', args, caller: USER });
  const tick = () => new Promise((r) => setImmediate(r));
  const at = async (going) => { await tick(); const m = posted.at(-1); w.answer(7, gen, m.id, { ok: true }); await going; return m.n; };
  assert.equal(await at(find('x')), 2, 'none named: the pane the user is in');
  assert.equal(await at(find('x', { pane: 'pane-2' })), 3, 'named');
  assert.equal(await at(find('x', { pane: 'route' })), 1, 'the window\'s own page, by name');
  const gone = await find('x', { pane: 'pane-9' });
  assert.deepEqual([gone.status, gone.reason], ['refused', 'gone']);
  assert.deepEqual(w.panesOf(7, 'ThreadView', thread).sort(), ['pane-1', 'pane-2', 'route']);
  const acted = w.withPane('pane-2', () => w.actOn('ThreadView', thread, 'scrollTo', []));
  await tick();
  assert.equal(posted.at(-1).n, 3);
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  await acted;
  const closed = await w.withPane('pane-9', () => w.actOn('ThreadView', thread, 'scrollTo', []));
  assert.deepEqual([closed.status, closed.reason], ['refused', 'gone']);
});

test('layouts WL7 review: an operation keeps to the pane it settled on: the focus moving or a pane opening meanwhile changes nothing, and that pane gone, or its page reloaded, is gone', async () => {
  const { w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const P2 = (n, pane) => ({ ...P(n, 'Composer', thread, { in: 'Window' }, { slot: 'main' }), ...(pane ? { pane } : {}) });
  const panes = (active, ...list) => ({ panes: { list: list.map((token) => ({ token, thread })), active } });
  w.report(7, gen, { puts: [P2(1, 'pane-a')], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, ...panes('pane-a', 'pane-a') } });
  const tick = () => new Promise((r) => setImmediate(r));
  const step = async () => { const going = w.actOn('Composer', thread, 'setText', ['x']); await tick(); const m = posted.at(-1); w.answer(7, gen, m.id, { ok: true }); await going; return m.n; };
  await w.withPane(null, async () => {
    assert.equal(w.heldPane(), undefined);
    w.capturePane(7, 'pane-a');
    assert.equal(w.heldPane(), 'pane-a');
    assert.equal(await step(), 1, 'its first step');
    // a duplicate opens, and the user goes to it
    w.report(7, gen, { puts: [P2(2, 'pane-b')], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, ...panes('pane-b', 'pane-a', 'pane-b') } });
    assert.equal(await step(), 1, 'its next step stays');
    // the page reloads: the same name on a new page is not this pane
    const gen2 = w.open(7, { post: (m) => posted.push(m) });
    w.report(7, gen2, { puts: [P2(1, 'pane-a')], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, ...panes('pane-a', 'pane-a') } });
    const out = await w.actOn('Composer', thread, 'setText', ['x']);
    assert.deepEqual([out.status, out.reason], ['refused', 'gone']);
  });
  // another operation settles for itself
  await w.withPane(null, async () => { assert.equal(w.heldPane(), undefined); });
});

test('layouts WL7 review round 2: with the user in a hosted pane that has no transcript, an unnamed find does not reach another pane\'s', async () => {
  const { graph, w } = setup();
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const thread = { type: 'CodexThread', provider: 'codex', id: 'th-1' };
  const view = { ...P(1, 'ThreadView', thread, { in: 'Window' }, { slot: 'main' }) };
  w.report(7, gen, { puts: [view], window: { sidebar: { open: true }, side: { open: false }, bottom: { open: false }, panes: { list: [{ token: 'tab-pane', thread }], active: 'tab-pane' } } });
  const find = (...args) => graph.invoke({ ref: refs.window(7), operation: 'find', args, caller: USER });
  const out = await find('x');
  assert.deepEqual([out.status, /no find bar/.test(out.message)], ['refused', true]);
  assert.equal(posted.filter((m) => m.operation === 'find').length, 0, 'the route\'s bar stays closed');
  const named = find('x', { pane: 'route' });
  await new Promise((r) => setImmediate(r));
  assert.equal(posted.at(-1).n, 1, 'named, it is the caller\'s to ask');
  w.answer(7, gen, posted.at(-1).id, { ok: true });
  await named;
});

test('graph-integrity G5.1: Window.focusPane: next and previous in the panes\' order on the page (its main region first), main, or a token; asked of its page, done once the page says the user is there', async () => {
  const { graph, w } = setup({ grants: { 'unit.a': ['graph.act:Window.focusPane'] } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const pane = { type: 'CodexThread', provider: 'codex', id: 'th-2' };
  const facts = (active) => ({ sidebar: { open: true }, panes: { list: [{ token: 'pane-1', thread: pane }, { token: 'pane-2', thread: T1 }], active } });
  w.report(7, gen, { puts: [], window: facts(null) });
  const win = refs.window(7);
  const asked = async (target, after) => {
    const out = graph.invoke({ ref: win, operation: 'focusPane', args: [target], caller: mod('unit.a') });
    await new Promise((r) => setImmediate(r));
    const m = posted.at(-1);
    w.answer(7, gen, m.id, { ok: true });
    w.report(7, gen, { puts: [], window: facts(after) });
    return [m.key, m.op, m.args, (await out).status];
  };
  assert.deepEqual(await asked('next', 'pane-1'), ['codexmods:window', 'pane.focus', { pane: 'pane-1' }, 'done'], 'from the main region, the first pane');
  assert.deepEqual(await asked('next', 'pane-2'), ['codexmods:window', 'pane.focus', { pane: 'pane-2' }, 'done']);
  assert.deepEqual(await asked('next', null), ['codexmods:window', 'pane.focus', { pane: null }, 'done'], 'after the last, the main region');
  assert.deepEqual(await asked('previous', 'pane-2'), ['codexmods:window', 'pane.focus', { pane: 'pane-2' }, 'done'], 'before the main region, the last');
  assert.deepEqual(await asked('pane-1', 'pane-1'), ['codexmods:window', 'pane.focus', { pane: 'pane-1' }, 'done']);
  assert.deepEqual(await asked('main', null), ['codexmods:window', 'pane.focus', { pane: null }, 'done']);
  const closed = await graph.invoke({ ref: win, operation: 'focusPane', args: ['pane-9'], caller: mod('unit.a') });
  assert.deepEqual([closed.status, closed.reason], ['refused', 'gone'], 'a pane that is not there');
  const bad = await graph.invoke({ ref: win, operation: 'focusPane', args: ['two words'], caller: mod('unit.a') });
  assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid']);
});

test('graph-integrity G5.5: a Window says what framework-main says of it: the user is in it (one window at a time), its title, its place and outer size', () => {
  const { graph, w, bus } = setup();
  bus('window/bounds', { windowId: 7, bounds: { x: 10, y: 20, width: 1200, height: 800 } });   // before its page reports: kept for it
  opened(w, 7);
  opened(w, 8);
  const st = (id) => graph.resolve(refs.window(id)).state;
  assert.deepEqual([st(7).position, st(7).size, 'title' in st(7)], [{ x: 10, y: 20 }, { width: 1200, height: 800 }, false]);
  bus('window/title', { windowId: 7, title: 'Codex' });
  bus('window/focused', { windowId: 7 });
  assert.deepEqual([st(7).title, st(7).focused, 'focused' in st(8)], ['Codex', true, false]);
  bus('window/focused', { windowId: 8 });
  assert.deepEqual([st(7).focused, st(8).focused], [false, true], 'the user is in one window at a time');
  bus('window/blurred', { windowId: 8 });
  assert.equal(st(8).focused, false);
  bus('window/bounds', { windowId: 8, bounds: { x: 0, y: 0, width: 'wide', height: 1 } });
  assert.equal('size' in st(8), false, 'bounds that are not numbers are not taken');
});

test('graph-integrity G5.1: a SidePanel says whether it is open and its width, as its window\'s arrangement does', () => {
  const { graph, w } = setup();
  const gen = w.open(7);
  w.report(7, gen, { puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }), P(2, 'SidePanel', T1, { in: 'Window' }, { slot: 'panel' })], window: { sidebar: { open: true }, side: { open: true, size: 480 } } });
  const sp = () => graph.resolve({ type: 'SidePanel', provider: PROVIDER, id: `7.${gen}.2` }).state;
  assert.deepEqual([sp().open, sp().size], [true, { width: 480 }]);
  w.report(7, gen, { puts: [], window: { sidebar: { open: true }, side: { open: false } } });
  assert.deepEqual([sp().open, 'size' in sp()], [false, false]);
});

test('graph-integrity G5.2: a presentation\'s default: run once as it appears, as its mod, where its state differs; a remount takes it again; never over the user\'s choice in that window', async () => {
  const { graph, unit, w } = setup({ grants: { 'unit.d': ['graph.act:TurnView'] } });
  graph.defaults('mod:unit.d', { id: 'steps-open', of: 'TurnView', for: 'UTurn', state: { expanded: true } });
  const posted = [];
  const gen = w.open(7, { post: (m) => posted.push(m) });
  const turn = (n, subject, expanded) => P(n, 'TurnView', subject, { in: 'ThreadView', via: 'thread' }, { slot: 'transcript', ...(expanded === undefined ? {} : { expanded }) });
  const tick = () => new Promise((r) => setImmediate(r));
  w.report(7, gen, { puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }), turn(3, U1, false)], window: { sidebar: { open: true } } });
  await tick();
  assert.deepEqual(posted.map((m) => [m.t, m.n, m.operation]), [['act', 3, 'expand']], 'as it appears: expanded, the default\'s');
  w.answer(7, gen, posted[0].id, { ok: true });
  w.report(7, gen, { puts: [turn(3, U1, true)] });
  // it goes and comes back with the app's own state (folded again): a new presentation, never chosen, takes the default again
  w.report(7, gen, { removes: [3], puts: [turn(4, U1, false)] });
  await tick();
  assert.deepEqual(posted.map((m) => m.n), [3, 4]);
  w.answer(7, gen, posted[1].id, { ok: true });
  w.report(7, gen, { puts: [turn(4, U1, true)] });
  // the user folds it: their choice; when it comes back it is left as it is
  w.report(7, gen, { puts: [turn(4, U1, false)] });
  w.report(7, gen, { removes: [4], puts: [turn(5, U1, false)] });
  await tick();
  assert.deepEqual(posted.map((m) => m.n), [3, 4], 'not over the user\'s choice');
  // another turn: its own; one already as the default: nothing
  unit.put(U2, { links: { thread: T1 } });
  w.report(7, gen, { puts: [turn(6, U2, true)] });
  await tick();
  assert.deepEqual(posted.map((m) => m.n), [3, 4], 'already expanded');
  // one whose state the app decides by itself (not said): set as the default's, once
  const U3 = ref('UTurn', 'u3');
  unit.put(U3, { links: { thread: T1 } });
  w.report(7, gen, { puts: [turn(7, U3)] });
  await tick();
  assert.deepEqual(posted.map((m) => [m.n, m.operation]).slice(2), [[7, 'expand']], 'its state not known: set');
  w.answer(7, gen, posted[2].id, { ok: true });
  w.report(7, gen, { puts: [turn(7, U3, true)] });
  await tick();
  assert.equal(posted.length, 3, 'once');
  // another window: the user's choice there is not this one's
  const posted8 = [];
  const gen8 = w.open(8, { post: (m) => posted8.push(m) });
  w.report(8, gen8, { puts: [P(1, 'ThreadView', T1, { in: 'Window' }, { slot: 'main' }), turn(2, U1, false)], window: { sidebar: { open: true } } });
  await tick();
  assert.deepEqual(posted8.map((m) => [m.n, m.operation]), [[2, 'expand']]);
});
