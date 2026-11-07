// The mods' panel views as the app's own tabs (docs/design/mod-surfaces.md §3.1): the kind named early, then made real; restored from its
// durable route; never closed for its mod; opened and closed by the panels' controllers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModPanels, KIND, tabKeyOf, paramsOk, presenceKeyOf } from '../present/mod-panels.mjs';
import { createFakeReact, textOf } from './fake-react.mjs';

function setup({ storage = null } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const registry = new Map();
  const opened = [], closed = [];
  const tabs = new Map();   // id -> target
  const controller = (panelId) => ({ panelId, tabById$: { panelId }, closeTab: (scope, id) => { closed.push([panelId, id]); tabs.delete(id); } });
  const pc = { right: controller('right'), bottom: controller('bottom'),
    openTab: (scope, type, opts) => { opened.push({ type, opts }); tabs.set(opts.id, opts.target === 'bottom' ? 'bottom' : 'right'); } };
  const scope = { get: (atom, id) => (tabs.get(id) === atom.panelId ? { id } : null) };
  const exportsTable = { tabRegistry: null, panelControllers: pc };
  const timers = [];
  const panels = createModPanels({ getExport: (k) => exportsTable[k], schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, storage });
  const run = () => { const t = timers.splice(0); for (const x of t) x.fn(); };
  const realRegistry = { registry, register: (kind, Component, options) => { const r = { ...options, Component, kind }; registry.set(kind, r); return r; } };
  const host = { react: () => React, node: (rule, type, props) => React.createElement(type, props), useRoute: () => ({ routeKind: 'local-thread', conversationId: 'c1' }),
    threadOf: (route) => (route?.conversationId ? { type: 'CodexThread', provider: 'codex', id: route.conversationId } : null),
    draftOf: (route) => (route?.conversationId ? { type: 'Draft', provider: 'codex', id: route.conversationId } : null), openMod: () => {},
    windowOf: () => ({ type: 'Window', provider: 'codexmods.windows', id: '1' }), projectOf: (thread) => (thread ? { type: 'LocalProject', provider: 'codex', id: 'p1' } : null) };
  // what a view is about, as the runtime's host computes it (here every ref readable)
  host.useViewContext = (rule, at) => { const r = at === undefined ? host.useRoute() : at; const thread = host.threadOf(r), draft = host.draftOf(r); return { thread, draft, window: host.windowOf(), project: host.projectOf(thread, draft) }; };
  return { React, ReactDOM, registry, opened, closed, tabs, scope, exportsTable, panels, run, timers, realRegistry, host };
}

const RULE = (over = {}) => ({ mod: 'unit.m', id: 'notes', kind: 'host', presentation: 'SidePanel', slot: 'tabs', data: { view: { title: 'Notes' } }, fns: { render: (c) => `notes of ${c.thread?.id}${c.draft ? ` (draft ${c.draft.id})` : ''}${c.project ? ` in ${c.project.id}` : ''}${c.window ? ` window ${c.window.id}` : ''}` }, ...over });

test('E8.2: the kind is named from the first moments (a stub whose load waits for the runtime), then made real', async () => {
  const s = setup();
  s.panels.arm();
  assert.equal(s.registry.size, 0, 'no registry yet: the stub waits for it');
  s.exportsTable.tabRegistry = s.realRegistry;
  s.run();
  const stub = s.registry.get(KIND);
  assert.ok(stub && typeof stub.load === 'function' && stub.durableRoute.version === 1 && stub.isAvailable() === true);
  let loaded = false;
  stub.load().then(() => { loaded = true; });
  await Promise.resolve();
  assert.equal(loaded, false, 'the restore waits');
  assert.equal(s.panels.attach(s.host), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(loaded, true, 'the real kind released it');
  const kind = s.registry.get(KIND);
  assert.notEqual(kind, stub);
  assert.equal(typeof kind.Component, 'function');
  assert.deepEqual(kind.dropDestinations, ['right', 'bottom']);
});

test('E8.2: the durable route carries the view, is restored with the stored id, and a view that persists nothing is left out', async () => {
  const s = setup();
  s.exportsTable.tabRegistry = s.realRegistry;
  s.panels.attach(s.host);
  s.panels.setViews([RULE(), RULE({ id: 'scratch', data: { view: { title: 'Scratch', persist: false } } })]);
  const kind = s.registry.get(KIND);
  const props = s.panels.propsOf('unit.m', 'notes');
  assert.deepEqual(props, { mod: 'unit.m', view: 'notes', title: 'Notes' });
  const route = kind.durableRoute.serialize(null, props);
  assert.deepEqual(route, { kind: KIND, payloadVersion: 1, params: { v: 1, mod: 'unit.m', view: 'notes', title: 'Notes' } });
  const scratch = s.panels.propsOf('unit.m', 'scratch');
  assert.equal(scratch.persist, false, 'persist: false travels with the tab');
  assert.equal(kind.durableRoute.serialize(null, scratch), undefined);
  s.panels.setViews([RULE()]);
  assert.equal(kind.durableRoute.serialize(null, scratch), undefined, 'still left out while its view is gone (its mod off)');
  assert.equal(kind.durableRoute.shouldPersist(null, route), true);
  assert.equal(kind.durableRoute.shouldPersist(null, { params: { v: 1, mod: 'x' } }), false);
  const ok = await kind.durableRoute.restore({ scope: s.scope, descriptor: { tabId: 'stored-id', params: route.params }, target: 'bottom', insertPosition: 2, isDisconnected: () => false });
  assert.equal(ok, true);
  assert.deepEqual(s.opened[0].opts, { id: 'stored-id', title: 'Notes', props: { mod: 'unit.m', view: 'notes', instance: undefined, title: 'Notes', icon: undefined, target: 'bottom' }, target: 'bottom', insertPosition: 2, revealAndFocus: false });
  assert.equal(await kind.durableRoute.restore({ scope: s.scope, descriptor: { tabId: 'x', params: { v: 2 } }, isDisconnected: () => false }), false);
  assert.equal(paramsOk({ v: 1, mod: 'unit.m', view: 'notes', title: 'x'.repeat(81) }), false);
});

test('E8.2: the shell: a quiet placeholder while mods load, the view in its panel slots, "not available" with Close when its mod is off', () => {
  const s = setup();
  s.exportsTable.tabRegistry = s.realRegistry;
  s.panels.attach(s.host);
  const { Component } = s.registry.get(KIND);
  let closes = 0;
  const root = s.ReactDOM.createRoot({});
  const tabProps = { mod: 'unit.m', view: 'notes', title: 'Notes', tabId: tabKeyOf('unit.m', 'notes'), onClose: () => { closes++; }, renderSlots: ({ content }) => s.React.createElement('section', null, content) };
  root.render(s.React.createElement(Component, tabProps));
  assert.equal(textOf(root.tree), 'Notes', 'pending: the title alone');
  s.panels.setViews([RULE()]);
  assert.equal(textOf(root.tree), 'notes of c1 (draft c1) in p1 window 1', 'live: the view, told its chat and the Draft of its composer');
  s.panels.setViews([]);
  s.panels.settle();
  assert.match(textOf(root.tree), /Notes is not available\./);
  assert.equal(closes, 0, 'never closed for the mod');
  s.panels.setViews([RULE()]);
  assert.equal(textOf(root.tree), 'notes of c1 (draft c1) in p1 window 1', 'back live in place when the mod is on again');
});

test('E8.2: open focuses one tab per view in the panel asked (or the view\'s first), close finds it in either panel', () => {
  const s = setup();
  s.exportsTable.tabRegistry = s.realRegistry;
  s.panels.attach(s.host);
  s.panels.setViews([RULE({ data: { view: { title: 'Notes', targets: ['bottom'] } } })]);
  assert.equal(s.panels.allows(s.panels.view('unit.m', 'notes'), 'right'), false);
  assert.equal(s.panels.openIn(s.scope, s.panels.propsOf('unit.m', 'notes'), { target: 'bottom' }), true);
  assert.equal(s.opened[0].opts.id, 'codexmods:unit.m/notes');
  assert.equal(s.opened[0].opts.target, 'bottom');
  assert.equal(s.panels.closeIn(s.scope, 'codexmods:unit.m/notes'), true);
  assert.deepEqual(s.closed, [['bottom', 'codexmods:unit.m/notes']]);
  assert.equal(s.panels.closeIn(s.scope, 'codexmods:unit.m/notes'), false);
  assert.equal(s.panels.openIn(null, s.panels.propsOf('unit.m', 'notes')), false, 'no route scope: nothing opens');
});

test('E8.2: the presence record: on a page the app keeps no tabs for, an open mod tab is remembered, reopened after a restart, and forgotten when closed there', () => {
  assert.equal(presenceKeyOf({ routeKind: 'home' }), 'home');
  assert.equal(presenceKeyOf({ routeKind: 'local-thread', conversationId: 'c1' }), null, 'a chat\'s tabs are the app\'s');
  assert.equal(presenceKeyOf({ routeKind: 'remote-thread', taskId: 't9' }), 'remote-thread:t9');
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = setup({ storage });
  s.exportsTable.tabRegistry = s.realRegistry;
  let route = { routeKind: 'home' };
  const host = { ...s.host, useRoute: () => route, routeScope: () => ({ ...s.scope, value: route }) };
  s.panels.attach(host);
  s.panels.setViews([RULE()]);
  const { Component } = s.registry.get(KIND);
  const id = tabKeyOf('unit.m', 'notes');
  s.tabs.set(id, 'right');
  const root = s.ReactDOM.createRoot({});
  root.render(s.React.createElement(Component, { mod: 'unit.m', view: 'notes', title: 'Notes', target: 'right', tabId: id, renderSlots: ({ content }) => content }));
  assert.deepEqual(JSON.parse(mem.get('codexmods.panels.presence.v1')), { home: [{ mod: 'unit.m', view: 'notes', target: 'right', title: 'Notes' }] }, 'remembered on the new chat\'s page (with its title, for a placeholder)');
  // navigating away keeps it
  route = { routeKind: 'local-thread', conversationId: 'c1' };
  root.unmount();
  assert.ok(JSON.parse(mem.get('codexmods.panels.presence.v1')).home, 'kept: the page changed, nothing was closed');
  // a restart: the new chat's page shows its panel without the tab: it reopens there, once, unfocused
  const t = setup({ storage });
  t.exportsTable.tabRegistry = t.realRegistry;
  t.panels.attach({ ...t.host, useRoute: () => ({ routeKind: 'home' }), routeScope: () => ({ ...t.scope, value: { routeKind: 'home' } }) });
  t.panels.setViews([RULE()]);
  const homeScope = Object.assign(Object.create(t.scope), { value: { routeKind: 'home' } });
  t.panels.restore({ routeKind: 'home' }, 'right', Object.assign(Object.create(t.scope), { value: { routeKind: 'local-thread', conversationId: 'c1' } }));
  assert.equal(t.opened.length, 0, 'E8 review 3: never into another route\'s scope');
  t.panels.restore({ routeKind: 'home' }, 'right', homeScope);
  t.panels.restore({ routeKind: 'home' }, 'right', homeScope);
  assert.deepEqual(t.opened.map((x) => [x.opts.id, x.opts.target, x.opts.revealAndFocus]), [[id, 'right', false]]);
  t.panels.restore({ routeKind: 'home' }, 'bottom', homeScope);
  assert.equal(t.opened.length, 1, 'not in the other panel');
  // E8 review 3: once the mods have loaded, a remembered view no mod offers (its mod off) reopens as a placeholder, with its title
  const u = setup({ storage });
  u.exportsTable.tabRegistry = u.realRegistry;
  u.panels.attach({ ...u.host, useRoute: () => ({ routeKind: 'home' }), routeScope: () => ({ ...u.scope, value: { routeKind: 'home' } }) });
  const uScope = Object.assign(Object.create(u.scope), { value: { routeKind: 'home' } });
  u.panels.restore({ routeKind: 'home' }, 'right', uScope);
  assert.equal(u.opened.length, 0, 'the mods not loaded yet: asked again later');
  u.panels.settle();
  u.panels.restore({ routeKind: 'home' }, 'right', uScope);
  assert.deepEqual(u.opened.map((x) => [x.opts.id, x.opts.title]), [[id, 'Notes']], 'its placeholder');
  // closed by the user on that page: forgotten
  const { Component: C2 } = t.registry.get(KIND);
  const root2 = t.ReactDOM.createRoot({});
  root2.render(t.React.createElement(C2, { mod: 'unit.m', view: 'notes', title: 'Notes', target: 'right', tabId: id, renderSlots: ({ content }) => content }));
  t.tabs.delete(id);
  root2.unmount();
  assert.equal(JSON.parse(mem.get('codexmods.panels.presence.v1')).home, undefined, 'closed there: forgotten');
});

test('public hooks (review H7j-l): a view\'s context names only what its mod may read, in a tab and in a modal; a modal follows the route', () => {
  const s = setup();
  s.exportsTable.tabRegistry = s.realRegistry;
  let route = { routeKind: 'local-thread', conversationId: 'c1' };
  // the mod reads chats and Drafts, not projects or windows (the host computes what a view is about, as the runtime's does)
  const readable = (ref) => (ref && ['CodexThread', 'Draft'].includes(ref.type) ? ref : null);
  const useViewContext = (rule, at) => {
    const r = at === undefined ? route : at;
    const thread = s.host.threadOf(r), draft = s.host.draftOf(r);
    return { thread: readable(thread), draft: readable(draft), window: readable(s.host.windowOf()), project: readable(s.host.projectOf(readable(thread), readable(draft))) };
  };
  s.panels.attach({ ...s.host, useViewContext });
  s.panels.setViews([RULE()]);
  const { Component } = s.registry.get(KIND);
  const root = s.ReactDOM.createRoot({});
  root.render(s.React.createElement(Component, { mod: 'unit.m', view: 'notes', title: 'Notes', tabId: tabKeyOf('unit.m', 'notes'), renderSlots: ({ content }) => s.React.createElement('section', null, content) }));
  assert.equal(textOf(root.tree), 'notes of c1 (draft c1)', 'no project, no window: not this mod\'s to read');
  const modal = s.ReactDOM.createRoot({});
  modal.render(s.React.createElement(s.panels.ModalView, { mod: 'unit.m', view: 'notes', onClose: () => {} }));
  assert.equal(textOf(modal.tree), 'notes of c1 (draft c1)');
  route = { routeKind: 'local-thread', conversationId: 'c2' };
  modal.render(s.React.createElement(s.panels.ModalView, { mod: 'unit.m', view: 'notes', onClose: () => {} }));
  assert.equal(textOf(modal.tree), 'notes of c2 (draft c2)', 'the route now, not the one it opened on');
});

test('layouts WL7 review: a tab\'s title follows what it shows, in the panel that holds it', () => {
  const s = setup();
  const done = [];
  for (const [name, ctl] of [['right', s.exportsTable.panelControllers.right], ['bottom', s.exportsTable.panelControllers.bottom]]) ctl.updateTab = (scope, id, patch) => done.push([name, id, patch]);
  const tab = { mod: 'codexmods.framework', view: 'chat', instance: 'c9' };
  const id = tabKeyOf(tab.mod, tab.view, tab.instance);
  s.panels.retitle(s.scope, tab, 'Gone');
  assert.deepEqual(done, [], 'a tab closed: nothing');
  s.tabs.set(id, 'bottom');
  s.panels.retitle(s.scope, tab, 'x'.repeat(100));
  assert.deepEqual(done, [['bottom', id, { title: 'x'.repeat(80), props: { ...tab, title: 'x'.repeat(80) } }]], 'moved to the other panel, within a tab\'s limit, and in the props the app saves it from');
});
