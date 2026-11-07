// The page side of presentations (docs/design/presentations.md V4, V5, V8): armed bindings get their renderers in the kernel's store,
// read their subjects from the replica, re-render when a subject changes, and are off after one throw. A fake kernel store and a fake
// framework graph stand in for the preload's kernel and the renderer channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPresentation, defineBinding } from '../present/runtime.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
function fakeKernel(armed) {
  let bumps = 0;
  const store = { renderers: new Map(), onFault: null, bump() { bumps++; } };
  return { kernel: { abi: 1, bindings: armed }, store, exports: {}, get bumps() { return bumps; } };
}
function fakeGraph(instances = {}) {
  const sinks = new Map();   // ref id -> fn
  return {
    sinks,
    types: async () => [{ id: 'CodexThread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread' }],
    subscribe(query, fn) {
      const ref = query.ref;
      sinks.set(ref.id, fn);
      const inst = instances[ref.id];
      queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: inst ? [inst] : [] }));
      return { dispose() { sinks.delete(ref.id); } };
    },
  };
}
const thread = (id, title, provider = 'qa.test-agent') => ({ ref: { type: 'TestAgentThread', provider, id }, liveness: 'live', state: { title }, links: {} });
const factory = (type, props) => ({ type, props });

test('only armed bindings get a renderer; without a kernel nothing starts', () => {
  assert.equal(startPresentation({ kernel: null, graph: fakeGraph(), bindings: [] }), null);
  const k = fakeKernel(['a']);
  const a = defineBinding({ id: 'a', presents: ['Thread'], render: () => undefined });
  const b = defineBinding({ id: 'b', presents: ['Thread'], render: () => undefined });
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [a, b] });
  assert.deepEqual(p.armed, ['a']);
  assert.deepEqual([...k.store.renderers.keys()], ['a']);
  p.dispose();
  assert.equal(k.store.renderers.size, 0);
});

test('a binding reads its subject from the replica; a change to the subject bumps the store, so wrappers re-render', async () => {
  const k = fakeKernel(['row']);
  const g = fakeGraph({ t1: thread('t1', 'First') });
  const ref = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const row = defineBinding({
    id: 'row', presents: ['Thread'],
    render: (Orig, props, f, ctx) => { const s = ctx.subject(ref); return s && !s.gone ? f(Orig, { ...props, titlePrefix: s.state.title }) : undefined; },
  });
  startPresentation({ kernel: k, graph: g, bindings: [row] });
  const render = k.store.renderers.get('row');
  assert.equal(render('Row', { x: 1 }, factory), undefined, 'the types are not known yet: the app\'s own');
  await tick();
  assert.equal(render('Row', { x: 1 }, factory), undefined, 'observed now, the snapshot not in yet');
  await tick(); await tick();
  assert.equal(render('Row', { x: 1 }, factory).props.titlePrefix, 'First');
  const before = k.bumps;
  g.sinks.get('t1')({ type: 'delta', seq: 2, event: { kind: 'changed', ref, instance: thread('t1', 'Renamed') } });
  await tick();
  assert.ok(k.bumps > before, 'the change bumped the store');
  assert.equal(render('Row', { x: 1 }, factory).props.titlePrefix, 'Renamed');
});

test('with a scoping kernel a binding\'s reads are recorded and a change touches only that subject; a binding the kernel disarmed is reported (4a, 4b)', async () => {
  const k = fakeKernel(['row', 'gone']);
  const touched = [], reads = [];
  k.store.touch = (keys) => touched.push(...keys);
  k.store.read = (key) => reads.push(key);
  k.kernel.disarmed = new Map([['gone', 'conversationId is number, not string']]);
  const g = fakeGraph({ t1: thread('t1', 'First') });
  const ref = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const row = defineBinding({ id: 'row', presents: ['Thread'], render: (Orig, props, f, ctx) => { const s = ctx.subject(ref); return s ? f(Orig, props) : undefined; } });
  const faults = [];
  const p = startPresentation({ kernel: k, graph: g, bindings: [row], onFault: (id, e) => faults.push([id, e.message]) });
  assert.deepEqual(faults, [['gone', 'its canary failed: conversationId is number, not string']]);
  assert.ok(p.tripped().includes('gone'));
  assert.deepEqual(p.states().gone, { state: 'tripped', why: 'its canary failed: conversationId is number, not string' });
  await tick();
  const render = k.store.renderers.get('row');
  render('Row', {}, factory);
  assert.deepEqual(reads, ['qa.test-agent\u001fThread\u001ft1'], 'the subject (by its concept)');
  await tick(); await tick();
  touched.length = 0;
  const bumps = k.bumps;
  g.sinks.get('t1')({ type: 'delta', seq: 2, event: { kind: 'changed', ref, instance: thread('t1', 'Renamed') } });
  await tick();
  assert.deepEqual(touched, ['qa.test-agent\u001fThread\u001ft1'], 'only the subject that changed');
  assert.equal(k.bumps, bumps, 'no window-wide bump');
  p.dispose();
});

test('a binding that throws is off until reload: the kernel falls back, the runtime trips it once and reports it', () => {
  const k = fakeKernel(['bad']);
  const faults = [];
  const bad = defineBinding({ id: 'bad', presents: ['Thread'], render: () => { throw new Error('boom'); } });
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [bad], onFault: (id, e) => faults.push([id, e.message]) });
  const render = k.store.renderers.get('bad');
  assert.throws(() => render('X', {}, factory), /boom/);   // the kernel's wrapper catches this and renders the app's own
  k.store.onFault('bad', new Error('boom'));
  k.store.onFault('bad', new Error('boom'));
  assert.deepEqual(faults, [['bad', 'boom']]);
  assert.deepEqual(p.tripped(), ['bad']);
  assert.equal(render('X', {}, factory), undefined, 'off: the app\'s own');
  assert.deepEqual(p.states(), { bad: { state: 'tripped', why: 'boom' } }, 'the feature log\'s live evidence (E4)');
});

test('defineBinding checks its shape', () => {
  assert.throws(() => defineBinding({ presents: ['Thread'], render() {} }), /id/);
  assert.throws(() => defineBinding({ id: 'x', render() {} }), /presents/);
  assert.throws(() => defineBinding({ id: 'x', presents: ['Thread'] }), /render/);
});

// ------------------------------------------------------------------ subjects and the sidebar row
import { createThreadSubjects } from '../present/subjects.mjs';
import { sidebarItem } from '../present/bindings/sidebar-item.mjs';

test('thread subjects: every chat id the app shows is its own (Codex\'s), at once; local: prefixes are dropped; holds names the app\'s own', () => {
  let changes = 0;
  const s = createThreadSubjects({ present: null, schedule: (fn) => queueMicrotask(fn), onChange: () => changes++ });
  assert.deepEqual(s.thread('local:n1'), { type: 'CodexThread', provider: 'codex', id: 'n1' });
  assert.deepEqual(s.thread('n2'), { type: 'CodexThread', provider: 'codex', id: 'n2' });
  assert.equal(s.thread(''), null);
  assert.equal(changes, 0, 'nothing looked up');
  assert.equal(s.holds({ type: 'CodexThread', provider: 'codex', id: 'n1' }), true);
  assert.equal(s.holds({ type: 'TestAgentThread', provider: 'qa.test-agent', id: 'thr-1' }), false, 'a mod\'s chat: not the app\'s');
});

test('sidebar row: the app\'s own rows, its pin on hover a part a mod hides (the resting indicator stays)', () => {
  assert.equal(sidebarItem.render, undefined, 'drawn as the app draws it');
  const p = sidebarItem.appParts.pin({ conversationId: 'n1', canPin: true, showPinActionOnHover: true, indicatorRestNode: 'dot', indicatorHoverNode: 'pin' });
  assert.deepEqual([p.canPin, p.showPinActionOnHover, p.indicatorHoverNode], [false, false, 'dot']);
});

import { threadHeader } from '../present/bindings/thread-header.mjs';
test('thread header: the titlebar\'s title as the app draws it, the mods\' badges beside it, in the same shape always', () => {
  const React = { Fragment: 'F', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const ctx = { react: () => React };
  const el = threadHeader.render('Title', { title: 'Chat', titleActivator: undefined, variant: undefined }, factory, ctx);
  assert.equal(el.type, 'F');
  assert.deepEqual(el.props.children, [{ type: 'Title', props: { title: 'Chat', titleActivator: undefined, variant: undefined } }], 'the app\'s own title, as it was');
  assert.equal(threadHeader.render('Title', { title: 'x' }, factory, { react: () => undefined }), undefined);
});

import { threadMenus } from '../present/menus.mjs';
test('thread menus: the app\'s own chats keep the app\'s entries as it made them; the mods\' parts apply; their entries come after', () => {
  const items = [{ id: 'rename-thread' }, { id: 'pin-thread' }, { id: 'archive-thread' }];
  assert.equal(threadMenus()({ target: { conversationId: 'n1' } }, items), items, 'no rules: as the app made them');
  const withGroup = threadMenus(() => [[{ id: 'mine' }]])({ target: { conversationId: 'n1' } }, items);
  assert.deepEqual(withGroup.map((x) => x.id), ['rename-thread', 'pin-thread', 'archive-thread', 'codexmods:separator:0', 'mine']);
  const broken = threadMenus(() => { throw new Error('boom'); }, () => { throw new Error('boom'); });
  assert.equal(broken({}, items), items, 'a rule\'s fault is its own');
});

test('the runtime installs the menus rule in the kernel\'s store and takes it back on dispose', () => {
  const k = fakeKernel([]);
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [] });
  assert.equal(typeof k.store.menus, 'function');
  assert.deepEqual(k.store.menus({ target: { conversationId: 'x' } }, [{ id: 'a' }]), [{ id: 'a' }]);
  p.dispose();
  assert.equal(k.store.menus, null);
});

test('protocol and request subjects: an id the app shows is Codex\'s own as the binding builds it; request ids ask the Host, once, in a batch', async () => {
  const keys = [];
  const present = {
    requestsOf: async (ids) => Object.fromEntries(ids.filter((i) => i === 's:1').map((i) => [i, { type: 'CommandApproval', provider: 'codex', id: 't:e:s:1' }])),
  };
  const s = createThreadSubjects({ present, schedule: (fn) => queueMicrotask(fn), onChange: (k) => keys.push(...k) });
  const nativeTurn = (id) => ({ type: 'Turn', provider: 'codex', id });
  assert.deepEqual(s.of('ct', nativeTurn), nativeTurn('ct'), 'at once');
  assert.equal(s.of('', nativeTurn), null);
  assert.equal(s.request('s:1'), null, 'being looked up');
  await tick();
  assert.deepEqual(keys.sort(), ['req:s:1']);
  assert.equal(s.request('s:1').type, 'CommandApproval');
  assert.equal(s.request('s:2'), null);
  await tick();
  assert.equal(s.request('s:2'), null, 'not a pending request: null');
});

import { requestCard } from '../present/bindings/request-card.mjs';
import { turnView } from '../present/bindings/turn-view.mjs';
import { stepRow } from '../present/bindings/steps.mjs';
import { userMessage, agentMessage } from '../present/bindings/message-block.mjs';
import { threadView } from '../present/bindings/thread-view.mjs';
import { sidebarSection } from '../present/bindings/sidebar-section.mjs';
import { settingsPage } from '../present/bindings/settings-page.mjs';
import { composer } from '../present/bindings/composer.mjs';
import { fileChip } from '../present/bindings/chip.mjs';
import { statusItem } from '../present/bindings/status-item.mjs';
import { paletteCommand } from '../present/bindings/palette-result.mjs';
import { filesView } from '../present/bindings/files-view.mjs';
import { newThreadView, newThreadComposer } from '../present/bindings/new-thread-view.mjs';
import { threadMenu } from '../present/bindings/thread-menu.mjs';

test('the D2 bindings name their subjects from the props 21477 gives them, and pass through', () => {
  const seen = [];
  const ctx = {
    thread: (id) => (seen.push(['thread', id]), { type: 'CodexThread', provider: 'codex', id }),
    protocol: (id, native) => (seen.push(['protocol', id]), native(id)),
    request: (id) => (seen.push(['request', id]), { type: 'Request', provider: 'codex', id: `x:${id}` }),
  };
  assert.equal(requestCard.subject({ conversationId: 't', pendingRequest: { type: 'approval', item: { type: 'exec', approvalRequestId: 's:3' } } }, ctx).id, 'x:s:3');
  assert.equal(requestCard.subject({ conversationId: 't', pendingRequest: { type: 'approval', item: {} } }, ctx), null);
  assert.deepEqual(turnView.subject({ turnId: 'u1', conversationId: 't' }, ctx), { type: 'Turn', provider: 'codex', id: 'u1' });
  assert.deepEqual(agentMessage.subject({ conversationId: 't', turnId: 'u1', item: { type: 'assistant-message', searchItemId: 'msg_1' } }, ctx), { type: 'Message', provider: 'codex', id: 't:msg_1' });
  assert.deepEqual(userMessage.subject({ conversationId: 't', item: { type: 'user-message', searchItemId: 'um1', clientUserMessageId: 'c1' } }, ctx).id, 't:um1');
  assert.equal(userMessage.subject({ conversationId: 't', item: { type: 'assistant-message', searchItemId: 'm' } }, ctx), null, 'only its own kind');
  assert.equal(threadView.subject({ conversationId: 't' }, ctx).id, 't');
  for (const b of [turnView, userMessage, agentMessage]) assert.equal(b.render, undefined, `${b.id} passes through`);
  assert.equal(threadView.render('Page', { conversationId: 't' }, () => 'page', { react: () => null }), undefined, 'the page passes through without header actions (E7.3)');
  // D3: a local project's section names the native LocalProject; a remote one, or another kind of section, names nothing.
  const group = (g) => ({ mode: 'project', project: { source: 'codex', group: { label: 'repo', projectKind: 'local', projectId: 'p1', ...g } } });
  assert.deepEqual(sidebarSection.subject(group({}), ctx), { type: 'LocalProject', provider: 'codex', id: 'p1' });
  assert.deepEqual([sidebarSection.subject(group({ projectKind: 'remote' }), ctx), sidebarSection.subject(group({ projectId: '' }), ctx), sidebarSection.subject({ mode: 'chat' }, ctx)], [null, null, null]);
  // E8.9: Show more is the app's own expander state, set through any of the app's scope nodes
  const shown = [];
  const node = { set() {} };
  const sctx = { exports: () => ({ sidebarShowAll: { set: (n, key, v) => shown.push([n === node, key, v]) } }), anyScopeNode: () => node };
  assert.equal(sidebarSection.operations.showMore(group({}), [], sctx), true);
  assert.deepEqual(shown, [[true, 'project:p1', true]]);
  assert.ok(sidebarSection.operations.showMore(group({}), [], { exports: () => ({}), anyScopeNode: () => node }).unavailable, 'the build does not expose it');
  assert.equal(sidebarSection.render(null, group({}), () => assert.fail('no filter: the app\'s own'), { local: { read() {} } }), undefined, 'unfiltered: the app\'s own (E8.9j)');
  // D4: a settings page's title names the SettingsSection of its slug; a navigation item (more props) names nothing.
  assert.deepEqual(settingsPage.subject({ slug: 'appearance' }, ctx), { type: 'SettingsSection', provider: 'codex', id: 'appearance' });
  assert.deepEqual([settingsPage.subject({ slug: 'usage', showChatGptDataControlsLabel: true, showEnterpriseUsageLabel: false, codexMicroDeviceModel: null }, ctx), settingsPage.subject({ slug: '' }, ctx)], [null, null]);
  assert.equal(settingsPage.render, undefined);
  // E3: the chat composer's controls name its thread's Draft from ComposerScope, and only a chat's main composer of a created thread.
  const controls = { viewProps: {}, inputStatus: 'idle', addContextButton: null, showPermissionsModeDropdown: true, emptySubmitTooltipNonce: 0 };
  assert.deepEqual(composer.subject(controls, ctx, { kind: 'local', placement: 'main', conversationId: 't1' }), { type: 'Draft', provider: 'codex', id: 't1' });
  assert.deepEqual(composer.subject(controls, ctx, { kind: 'local', placement: 'side', conversationId: 't1' }), { type: 'Draft', provider: 'codex', id: 't1' }, 'a side chat: its thread\'s draft (E8.3)');
  assert.equal(composer.subject(controls, ctx, { kind: 'local', placement: 'main', conversationId: null }), null, 'a chat not created yet');
  // H5x: a provided chat's composer names its Draft by the app's key for it (the protocol id), whoever provides the thread
  const provided = { ...ctx, thread: (id) => (id === 'pid-1' ? { type: 'Thread', provider: 'mod.agent', id: 'x1' } : ctx.thread(id)) };
  assert.deepEqual(composer.subject(controls, provided, { kind: 'local', placement: 'main', conversationId: 'pid-1', clientThreadId: 'local:pid-1' }), { type: 'Draft', provider: 'codex', id: 'pid-1' });
  assert.deepEqual(composer.subject(controls, ctx, { kind: 'new', entrypoint: 'home' }), { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, 'the home page: the new chat\'s draft (E8.3)');
  assert.deepEqual(composer.subject(controls, ctx, { kind: 'new', entrypoint: 'panel' }), { type: 'Draft', provider: 'codex', id: 'new:app:panel-new-conversation' }, 'the panel\'s new thread page');
  assert.equal(composer.subject(controls, ctx, { kind: 'new', entrypoint: 'home', gptId: 'g-1' }), null, 'a custom GPT\'s (ChatGPT) composer');
  assert.deepEqual(composer.place(controls, { kind: 'new', entrypoint: 'home' }), { in: 'NewThreadView', slot: 'composer' });
  assert.deepEqual(composer.place(controls, { kind: 'local', placement: 'main', conversationId: 't1' }), { in: 'ThreadView', via: 'thread', slot: 'composer' });
  assert.equal(composer.presentation, 'Composer');
  // A file chip names its File, the /status panel its Thread; none without an id.
  // The thread header's title names the route's thread (RouteScope), and nothing on another route.
  assert.equal(threadHeader.subject({ title: 'T' }, ctx, { routeKind: 'local-thread', conversationId: 't3' }).id, 't3');
  assert.equal(threadHeader.subject({ title: 'T' }, ctx, { routeKind: 'other', pathname: '/settings' }), null);
  assert.deepEqual(fileChip.subject({ filename: 'b.txt', resourcePath: '/r/b.txt' }, ctx), { type: 'File', provider: 'codex', id: '/r/b.txt' });
  assert.equal(fileChip.subject({ filename: 'b.txt', resourcePath: 'b.txt' }, ctx), null);
  assert.equal(statusItem.subject({ sessionId: 't2', threadIds: [] }, ctx).id, 't2');
  assert.equal(statusItem.subject({ sessionId: null }, ctx), null);
  for (const b of [fileChip, statusItem]) assert.equal(b.render, undefined, `${b.id} passes through`);
  // D6: a palette command names its Command, the file tree its Folder (on this Mac), the home page's heading its project, a chat's menu its thread.
  assert.deepEqual(paletteCommand.subject({ command: { id: 'toggleSidebar' }, title: 'Toggle Sidebar' }, ctx), { type: 'Command', provider: 'codex', id: 'toggleSidebar' });
  assert.equal(paletteCommand.subject({ command: null }, ctx), null);
  assert.deepEqual(filesView.subject({ cwd: '/r', hostId: 'local' }, ctx), { type: 'Folder', provider: 'codex', id: '/r' });
  assert.deepEqual([filesView.subject({ cwd: '/r', hostId: 'remote-1' }, ctx), filesView.subject({ cwd: 'r' }, ctx)], [null, null]);
  const home = (activeProjectId, projectKind = 'local') => ({ activeProjectId, resolvedProjects: [{ projectId: 'p0', projectKind: 'local' }, { projectId: 'p1', projectKind }], projectContext: { kind: 'none' } });
  // E8.3: the new chat's Draft, whatever its project (its target names the project)
  for (const p of [home('p1'), home(null), home('p1', 'remote'), home('p9')]) assert.deepEqual(newThreadView.subject(p, ctx), { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });
  assert.deepEqual(threadMenu.subject({ conversationId: 't1' }, ctx), ctx.thread('t1'));
  for (const b of [newThreadView, threadMenu]) assert.equal(b.render, undefined, `${b.id} passes through`);
  assert.equal(paletteCommand.render('Row', { command: { id: 'c1' } }, factory, { declared: () => [] }), undefined, 'palette.command passes through while no mod hides a command');
  assert.equal(filesView.render('Files', { cwd: '/r', paths: ['a'] }, factory, { declared: () => [] }), undefined, 'files.view passes through while no filter of it is on');
  // E8.9: the home page's composer is a part of the new chat's view; its aboveComposer regions go after the app's content, once
  assert.deepEqual([newThreadComposer.subject({}, ctx, { routeKind: 'home' }), newThreadComposer.part], [{ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, true]);
  assert.deepEqual([newThreadComposer.subject({}, ctx, { routeKind: 'client-local-thread' }), newThreadComposer.subject({}, ctx, null)], [null, null], 'a chat that is starting is not the new chat');
  const R = { Fragment: 'F', createElement: (type, props, ...children) => ({ type, key: props?.key ?? null, props: { ...props, children: children.length > 1 ? children : children[0] } }) };
  const mine = R.createElement('div', { key: 'm/a' });
  const inst = { ref: newThreadComposer.subject({}, ctx, { routeKind: 'home' }) };
  const once = newThreadComposer.slots.aboveComposer.apply({ aboveComposerContent: 'app' }, [mine], { R, inst });
  assert.deepEqual(once.aboveComposerContent.props.children, ['app', mine]);
  assert.equal(newThreadComposer.slots.aboveComposer.apply(once, [mine], { R, inst }).aboveComposerContent, once.aboveComposerContent, 'the inner composer gets the same props: applied once');
  assert.equal(newThreadComposer.slots.aboveComposer.apply({ aboveComposerContent: undefined }, [mine], { R, inst }).aboveComposerContent, mine);
  const other = { aboveComposerContent: 'app' };
  assert.equal(newThreadComposer.slots.aboveComposer.apply(other, [mine], { R, inst: null }), other, 'not the new chat: the app\'s own');
});

test('a binding works once it matched and named an instance the graph has; one that only renders works once it matched', async () => {
  const k = fakeKernel(['named', 'missing', 'render-only']);
  const g = fakeGraph({ t1: thread('t1', 'First') });
  const there = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const named = defineBinding({ id: 'named', presents: ['Thread'], subject: () => there });
  const missing = defineBinding({ id: 'missing', presents: ['Thread'], subject: () => ({ ...there, id: 'nope' }) });
  const renderOnly = defineBinding({ id: 'render-only', presents: ['Thread'], render: () => undefined });
  const p = startPresentation({ kernel: k, graph: g, bindings: [named, missing, renderOnly] });
  assert.deepEqual(p.works(), { named: false, missing: false, 'render-only': false }, 'nothing matched yet');
  await tick();
  for (const id of ['named', 'missing', 'render-only']) k.store.renderers.get(id)('X', {}, factory);
  await tick(); await tick();
  for (const id of ['named', 'missing']) k.store.renderers.get(id)('X', {}, factory);
  assert.deepEqual(p.works(), { named: true, missing: false, 'render-only': true });
  assert.deepEqual(p.report(), { named: 'subject', missing: 'matched', 'render-only': 'matched' });
  assert.deepEqual(p.states(), { named: { state: 'works' }, missing: { state: 'unseen' }, 'render-only': { state: 'works' } }, 'for the feature log (E4)');
  p.dispose();
});

test('E6.4: the band\'s Open goes by the framework\'s navigation to its place, or to the recovery entry while the window\'s Mods pages cannot run', async () => {
  const { createPagesStatus } = await import('../pages-status.mjs');
  const pages = createPagesStatus({ schedule: () => {} });
  const went = [];
  const p = startPresentation({ kernel: fakeKernel([]), graph: fakeGraph(), bindings: [], pages, navigate: (path) => went.push(path) });
  assert.equal(typeof p.Band, 'function');
  p.openFramework({ overview: true });
  pages.mounted('routes'); pages.mounted('read');
  assert.equal(pages.has('nav'), false, 'Settings never shown: the navigation has not rendered, but the pages can be reached');
  p.openFramework({ mod: 'acme.demo' });
  p.openFramework({ mod: 'acme.demo', tab: 'activity' });
  p.openFramework({ developer: true });
  p.openFramework({ update: true });
  p.openFramework({ overview: true });
  pages.failed('a fault');
  p.openFramework({ mod: 'acme.demo' });
  assert.deepEqual(went, ['/settings/general-settings', '/settings/codexmods/acme.demo', '/settings/codexmods/acme.demo/activity', '/settings/codexmods/~developer', '/settings/codexmods/~update', '/settings/codexmods', '/settings/general-settings']);
  p.dispose();
});

test('E6.6c: showing an instance: a framework-owned one opens its own page; another needs this window\'s Settings pages for the DetailView', async () => {
  const went = [];
  const p = startPresentation({ kernel: fakeKernel([]), graph: fakeGraph(), bindings: [], navigate: (path) => went.push(path) });
  const F = 'codexmods.framework';
  assert.equal(p.showDetail({ type: 'Mod', provider: F, id: 'acme.demo' }), true);
  assert.equal(p.showDetail({ type: 'Operation', provider: F, id: 'op-1' }), true);
  assert.equal(p.showDetail({ type: 'Setting', provider: F, id: 'acme.demo/mode@thread:codex:t1' }), true);
  assert.equal(p.showDetail({ type: 'File', provider: 'codex', id: '/x' }), false, 'no Settings pages in this window');
  assert.deepEqual(went, ['/settings/codexmods/acme.demo', '/settings/codexmods/~developer', '/settings/codexmods/acme.demo'], 'an operation whose mod is not read here is on Developer');
  p.dispose();
});

test('E6.1: the window\'s Mods pages are failed when the graph\'s types cannot be read (a graph off or failed), missing when the build lacks what they need', async () => {
  const { createPagesStatus } = await import('../pages-status.mjs');
  const pages = createPagesStatus({ schedule: () => {} });
  const g = { ...fakeGraph(), types: async () => { throw Object.assign(new Error('the graph runtime is not running'), { code: 'Unavailable' }); } };
  const p = startPresentation({ kernel: fakeKernel([]), graph: g, bindings: [], pages });
  await tick(); await tick();
  assert.equal(pages.get(), 'failed');
  assert.match(pages.why(), /not running/);
  p.dispose();

  const missing = createPagesStatus({ schedule: () => {} });
  const k = fakeKernel([]);          // its exports have none of the settings parts
  const q = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [], pages: missing });
  await tick(); await tick();
  assert.equal(missing.get(), 'starting', 'not yet final: a settings binding may start them once the app\'s chunks ran');
  const { settingsPages } = await import('../present/settings-pages.mjs');
  assert.equal(settingsPages(), null);
  assert.equal(missing.get(), 'missing');
  q.dispose();
});

test('E7.1: the bindings\' page operations call the app\'s own callbacks from the committed props, or say why they cannot', () => {
  const calls = [];
  const fold = (v) => calls.push(['collapsed', v]);
  assert.equal(turnView.operations.collapse({ turnId: 'u1', onSetCollapsed: fold }, []), true);
  assert.equal(turnView.operations.expand({ turnId: 'u1', onSetCollapsed: fold }, []), true);
  assert.match(turnView.operations.collapse({ turnId: 'u1' }, []).unavailable, /cannot be folded/);
  assert.equal(fileChip.operations.remove({ resourcePath: '/r/b.txt', onRemove: () => calls.push(['removed']) }, []), true);
  assert.match(fileChip.operations.remove({ resourcePath: '/r/b.txt' }, []).unavailable, /cannot be removed/);
  assert.equal(paletteCommand.operations.close({ command: { id: 'x' }, close: () => calls.push(['closed']) }, []), true);
  const tree = { cwd: '/r/', onSelectionChange: (paths) => calls.push(['selected', paths]) };
  assert.equal(filesView.operations.select(tree, [{ type: 'File', provider: 'codex', id: '/r/src/a.js' }]), true);
  for (const target of [{ type: 'Folder', provider: 'codex', id: '/r/src' }, { type: 'File', provider: 'codex', id: '/elsewhere/a.js' }, { type: 'File', provider: 'codex', id: '/r/../etc/x' }, null]) {
    assert.ok(filesView.operations.select(tree, [target]).unavailable, JSON.stringify(target));
  }
  // A sectioned tree's path is under a section (the app names them), found among the tree's own paths.
  const entry = (displayPath, path, directory = false) => ({ displayPath, path, originalPath: path.slice(3), section: displayPath.startsWith('All') ? 'all' : 'changed', directory });
  const sectioned = { ...tree, paths: [entry('Changed files/', '/r', true), entry('Changed files/x/y.toml', '/r/x/y.toml'), entry('All files/src/', '/r/src/', true), entry('All files/src/a.js', '/r/src/a.js')] };
  assert.equal(filesView.operations.select(sectioned, [{ type: 'File', provider: 'codex', id: '/r/src/a.js' }]), true);
  assert.ok(filesView.operations.select(sectioned, [{ type: 'File', provider: 'codex', id: '/r/src/b.js' }]).unavailable, 'not in the tree');
  assert.deepEqual(calls, [['collapsed', true], ['collapsed', false], ['removed'], ['closed'], ['selected', ['src/a.js']], ['selected', ['All files/src/a.js']]]);
});

test('E7.2: the composer\'s slots (toolbar, pickers, the card\'s header, regions after it), the card always first and unkeyed', async () => {
  const { composer } = await import('../present/bindings/composer.mjs');
  const { SIBLINGS } = await import('../present/bindings/slots.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const env = { R, ctx: { token: () => null, exports: () => ({}) } };
  const entry = (id) => ({ rule: { mod: 'unit.a', id: 'r' }, item: { id, title: id, run() {} } });
  const s = composer.slots;
  assert.deepEqual(Object.keys(s).sort(), ['aboveInput', 'belowInput', 'pickers', 'status', 'toolbar']);
  const t = s.toolbar.apply({ addContextButton: 'plus' }, [entry('a')], env);
  assert.equal(t.addContextButton.type, R.Fragment, 'after the app\'s "+"');
  assert.equal(s.aboveInput.apply({ viewProps: { header: null, editor: 'ed' } }, ['region'], env).viewProps.editor, 'ed', 'the card\'s other parts kept');
  assert.equal(s.aboveInput.apply({ viewProps: { header: null } }, ['region'], env).viewProps.header, 'region');
  assert.deepEqual(s.belowInput.apply({}, ['r1'], env)[SIBLINGS], ['r1']);
  const ctx = { react: () => R, thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }), exports: () => ({}), use: (fn) => fn(), view: () => ({ dispose() {} }), subject: () => null, log() {} };
  const chat = { kind: 'local', placement: 'main', conversationId: 't1' };
  const out = composer.render('Card', { viewProps: {}, [SIBLINGS]: ['below'] }, (type, props, key) => ({ type, props, key }), ctx, chat);
  assert.equal(out.type, R.Fragment);
  const [card, ...after] = [].concat(out.props.children);
  assert.deepEqual([card.type, card.key, SIBLINGS in card.props, after], ['Card', undefined, false, ['below']], 'never passed to the app');
  const plain = composer.render('Card', { viewProps: {} }, (type, props, key) => ({ type, props, key }), ctx, chat);
  assert.equal([].concat(plain.props.children)[0].type, 'Card', 'the same shape without regions');
});

test('E7.2: the queue\'s rows, the model menu, the scroll layout and the user message\'s header name their subjects from the app\'s scopes', async () => {
  const { queueItem } = await import('../present/bindings/queue-item.mjs');
  const { modelPicker } = await import('../present/bindings/composer-picker.mjs');
  const { threadLayout } = await import('../present/bindings/thread-layout.mjs');
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  const chat = { kind: 'local', placement: 'main', conversationId: 't1' };
  const draft = { type: 'Draft', provider: 'codex', id: 't1' };
  assert.deepEqual(queueItem.subject({ messageId: 'q1' }, ctx, chat), { type: 'QueuedMessage', provider: 'codex', id: 't1:q1' });
  assert.deepEqual(queueItem.place({}, chat), { in: 'Composer', on: draft, slot: 'queue' });
  assert.equal(queueItem.subject({ messageId: 'q1' }, ctx, { ...chat, placement: 'side' }), null, 'a side chat\'s queue is not presented');
  const edits = [];
  assert.equal(queueItem.operations.edit({ messageId: 'q1', onEditMessage: (id) => edits.push(id) }), true);
  assert.deepEqual(edits, ['q1']);
  assert.deepEqual(modelPicker.subject({}, ctx, chat), { type: 'Setting', provider: 'codex', id: 'thread:t1:model' });
  assert.deepEqual(modelPicker.place({}, chat), { in: 'Composer', on: draft, slot: 'pickers' });
  const opened = [];
  assert.equal(modelPicker.operations.open({ onOpenChange: (v) => opened.push(v) }), true);
  assert.deepEqual(opened, [true]);
  assert.ok(modelPicker.operations.open({}).unavailable);
  // E8.3e: the inner composer's plan mode, both ways, among the modes it offers
  const { composerMode } = await import('../present/bindings/composer.mjs');
  const set = [];
  const comp = { collaborationModes: [{ mode: 'plan' }, { mode: 'default' }], setSelectedCollaborationMode: (m) => set.push(m) };
  assert.equal(composerMode.operations.setCollaborationMode(comp, ['plan']), true);
  assert.equal(composerMode.operations.setCollaborationMode({ ...comp, collaborationModes: [{ mode: 'plan' }] }, ['default']), true, 'no default offered: the app\'s own no selection');
  assert.deepEqual(set, ['plan', null]);
  assert.ok(composerMode.operations.setCollaborationMode({ ...comp, collaborationModes: [{ mode: 'default' }] }, ['plan']).unavailable);
  assert.deepEqual(composerMode.subject({}, ctx, { kind: 'new', entrypoint: 'home' }), { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });
  const { composer: composerB, composerRunLocation } = await import('../present/bindings/composer.mjs');
  for (const part of [composerMode, composerRunLocation]) for (const sc of [{ kind: 'new', entrypoint: 'home' }, { kind: 'local', placement: 'main', conversationId: 't1' }]) {
    assert.deepEqual(part.place({}, sc), composerB.place({}, sc), `${part.id}: the composer's own place (one instance with its parts)`);
  }
  // E8.3f: the new chat's access: its permissions menu opened, the app's own row chosen; full access and disabled rows refused
  const { accessMenu } = await import('../present/bindings/composer.mjs');
  const openedMenu = [], chosenAccess = [];
  const rowsNow = [];
  const actx = { mountsOf: (id) => (id === 'access.row' ? rowsNow.map((props) => ({ props })) : []) };
  const menuProps = { conversationId: null, onOpenChange: (v) => { openedMenu.push(v); if (v) rowsNow.push(
    { selection: { disabledReason: null, permissionSelection: { kind: 'agent-mode', agentMode: 'auto' } }, selectPermission: (x) => chosenAccess.push(x) },
    { selection: { disabledReason: 'disabled-by-config', permissionSelection: { kind: 'agent-mode', agentMode: 'guardian-approvals' } }, selectPermission: (x) => chosenAccess.push(x) }); else rowsNow.length = 0; } };
  assert.equal(await accessMenu.operations.setAccess(menuProps, ['ask'], actx), true);
  assert.deepEqual([openedMenu, chosenAccess], [[true, false], [{ kind: 'agent-mode', agentMode: 'auto' }]]);
  assert.match((await accessMenu.operations.setAccess(menuProps, ['approve'], actx)).unavailable, /turned off/);
  assert.ok((await accessMenu.operations.setAccess(menuProps, ['full'], actx)).unavailable, 'full access: the user\'s');
  assert.ok((await accessMenu.operations.setAccess({ ...menuProps, conversationId: 'c1' }, ['ask'], actx)).unavailable, 'a chat\'s is its Setting');
  // the menu's older form: generic items named by their messages' ids, chosen by their own click
  const clicked = [];
  const msg = (id) => ({ props: { id } });
  const legacyNow = [];
  const lctx = { mountsOf: (id) => (id === 'access.legacyRow' ? legacyNow.map((props) => ({ props })) : []) };
  const legacyProps = { conversationId: null, onOpenChange: (v) => { if (v) legacyNow.push(
    { onClick: () => clicked.push('ask'), SubText: { props: { children: msg('composer.permissionsDropdown.default.description') } }, children: msg('composer.permissionsDropdown.default.approvalOptionLabel') },
    { onClick: () => clicked.push('approve'), disabled: false, SubText: { props: { children: msg('composer.permissionsDropdown.guardianApproval.description') } } }); else legacyNow.length = 0; } };
  assert.equal(await accessMenu.operations.setAccess(legacyProps, ['approve'], lctx), true);
  assert.deepEqual(clicked, ['approve']);
  assert.match((await accessMenu.operations.setAccess(legacyProps, ['custom'], lctx)).unavailable, /does not offer/);
  // review 4: another composer's permissions menu already open: refused, nothing opened; a row of another host is not this menu's
  rowsNow.push({ selection: { disabledReason: null, permissionSelection: { kind: 'agent-mode', agentMode: 'auto' } }, selectPermission: () => assert.fail('another menu\'s row') });
  const before = openedMenu.length;
  assert.match((await accessMenu.operations.setAccess(menuProps, ['ask'], actx)).unavailable, /another permissions menu/);
  assert.equal(openedMenu.length, before);
  rowsNow.length = 0;
  const hostRows = [];
  const hctx = { mountsOf: (id) => (id === 'access.row' ? hostRows.map((props) => ({ props })) : []) };
  const hostMenu = { conversationId: null, hostId: 'local', onOpenChange: (v) => { if (v) hostRows.push({ hostId: 'remote-1', selection: { disabledReason: null, permissionSelection: { kind: 'agent-mode', agentMode: 'auto' } }, selectPermission: () => assert.fail('another host\'s row') }); else hostRows.length = 0; } };
  assert.match((await accessMenu.operations.setAccess(hostMenu, ['ask'], hctx)).unavailable, /does not offer/);
  // E8.3g: the starting branch, through the branch picker of the same composer (its scope), waited for after the run location changes
  // the same composer: the Draft its scope names (each component reads its own copy of the scope)
  const mine = { kind: 'new', entrypoint: 'home' }, other = { kind: 'new', entrypoint: 'home', homeDraftKey: 'panel-new-conversation' };
  const started = [];
  let pickers = [{ scope: other, props: { setStartingState: (x) => started.push(['other', x]) } }];
  const bctx = { mountsOf: (id) => (id === 'branch.startingState' ? pickers : []) };
  setTimeout(() => { pickers = [...pickers, { scope: { ...mine }, props: { setStartingState: (x) => started.push(['mine', x]) } }]; }, 120);
  assert.equal(await composerRunLocation.operations.setBranch({}, ['feature'], bctx, { scope: mine }), true);
  assert.deepEqual(started, [['mine', { type: 'branch', branchName: 'feature' }]]);
  // the compact bar's options menu (the picker only while it is open): the setter from the menu's own render of it
  pickers = [];
  const menus = [{ scope: { ...mine }, props: { options: () => ({ props: { children: [{ props: { children: { props: { branchSource: 'worktree', setStartingState: (x) => started.push(['menu', x]) } } } }, null] } }) } }];
  const mctx = { mountsOf: (id) => (id === 'branch.options' ? menus : []) };
  assert.equal(await composerRunLocation.operations.setBranch({}, ['qa'], mctx, { scope: mine }), true);
  assert.deepEqual(started.at(-1), ['menu', { type: 'branch', branchName: 'qa' }]);
  menus[0].props.options = () => null;
  assert.match((await composerRunLocation.operations.setBranch({}, ['feature'], mctx, { scope: mine })).unavailable, /runs locally/);
  // review 4: a render that throws says so; two composers of the draft shown: refused
  menus[0].props.options = () => { throw new Error('boom'); };
  assert.match((await composerRunLocation.operations.setBranch({}, ['feature'], mctx, { scope: mine })).unavailable, /could not be read \(boom\)/);
  const twice = { mountsOf: (id) => (id === 'branch.startingState' ? [{ scope: { ...mine }, props: { setStartingState() {} } }, { scope: { ...mine }, props: { setStartingState() {} } }] : []) };
  assert.match((await composerRunLocation.operations.setBranch({}, ['feature'], twice, { scope: mine })).unavailable, /two composers/);
  // E8.3c: the new chat's model menu presents its draft-scope model Setting; choose is the menu's own onSelectModel, among what it offers
  const home = { kind: 'new', entrypoint: 'home' };
  assert.deepEqual(modelPicker.subject({}, ctx, home), { type: 'Setting', provider: 'codex', id: 'new:app:new-conversation:model' });
  assert.deepEqual(modelPicker.place({}, home), { in: 'Composer', on: { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, slot: 'pickers' });
  const chosen = [];
  const menu = { model: 'gpt-a', reasoningEffort: 'medium', onSelectModel: (m, e) => chosen.push([m, e]),
    models: [{ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }, { model: 'gpt-b', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
  assert.equal(modelPicker.operations.choose(menu, ['gpt-b', 'high'], ctx, { scope: home }), true);
  assert.equal(modelPicker.operations.choose(menu, [null, 'medium'], ctx, { scope: home }), true, 'an effort alone: the chosen model\'s');
  assert.equal(modelPicker.operations.choose(menu, ['gpt-b'], ctx, { scope: home }), true, 'no effort: the app\'s (medium is not gpt-b\'s)');
  assert.deepEqual(chosen, [['gpt-b', 'high'], ['gpt-a', 'medium'], ['gpt-b', undefined]]);
  assert.ok(modelPicker.operations.choose(menu, ['gpt-c'], ctx, { scope: home }).unavailable, 'a model the menu does not offer');
  assert.ok(modelPicker.operations.choose(menu, ['gpt-a', 'high'], ctx, { scope: home }).unavailable, 'an effort the model does not take');
  assert.ok(modelPicker.operations.choose(menu, ['gpt-a'], ctx, { scope: chat }).unavailable, 'a chat\'s model is its Setting\'s');
  assert.deepEqual(threadLayout.subject({}, ctx, { routeKind: 'local-thread', conversationId: 't1' }), { type: 'CodexThread', provider: 'codex', id: 't1' });
  assert.equal(threadLayout.subject({}, ctx, { routeKind: 'remote-thread', conversationId: 't1' }), null);
  assert.deepEqual(Object.keys(threadLayout.slots).sort(), ['aboveComposer', 'transcript']);
  assert.deepEqual(Object.keys(userMessage.slots).sort(), ['actions', 'decorations']);
  assert.deepEqual(agentMessage.twins.map((t) => [t.presentation, Object.keys(t.slots).sort()]), [['TurnView', ['actions', 'afterAnswer', 'badges']]]);
  const tctx = { protocol: (id, native) => (typeof id === 'string' && id ? native(id) : null) };
  assert.deepEqual(agentMessage.twins[0].subject({ turnId: 'u1' }, tctx), { type: 'Turn', provider: 'codex', id: 'u1' });
  assert.equal(agentMessage.twins[0].subject({ sourceTurnId: 'u1' }, tctx), null, 'only the final answer');
});

test('E7.2: a slot is applied once, even when the props it gave come back through it (entries are keyed by mod, rule and item)', async () => {
  const { nodeList, elementList, badgeNode, actionNode } = await import('../present/bindings/slots.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const env = { R, ctx: { token: () => null, exports: () => ({}) } };
  const entries = [{ rule: { mod: 'unit.a', id: 'r' }, item: { id: 'b', text: 'B' } }];
  const header = nodeList('header', ({ R: r, ctx }, item, key) => badgeNode(r, ctx, item, key));
  const once = header.apply({ header: null }, entries, env);
  const twice = header.apply(once, entries, env);
  assert.equal(twice.header, once.header, 'nothing added the second time');
  const more = header.apply(once, [...entries, { rule: { mod: 'unit.b', id: 'r' }, item: { id: 'c', text: 'C' } }], env);
  assert.equal([].concat(more.header.props.children).length, 2, 'only what is new');
  const row = elementList('actions', ({ R: r, ctx }, item, key) => actionNode(r, ctx, item, key));
  const a1 = row.apply({ actions: ['app'] }, [{ rule: { mod: 'unit.a', id: 'r' }, item: { id: 'x', title: 'X' } }], env);
  const a2 = row.apply(a1, [{ rule: { mod: 'unit.a', id: 'r' }, item: { id: 'x', title: 'X' } }], env);
  assert.deepEqual([a1.actions.length, a2.actions.length], [2, 2]);
});

test('E7.3: the frame\'s bindings: a row\'s hover actions, a group\'s header actions and items, the sidebar\'s sections, the page\'s title-bar actions', async () => {
  const fr = await import('../present/bindings/frame.mjs');
  const { sidebarSection } = await import('../present/bindings/sidebar-section.mjs');
  const { SIBLINGS } = await import('../present/bindings/slots.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const env = { R, ctx: { token: () => null, exports: () => ({}) } };
  const entry = (mod, id) => ({ rule: { mod, id: 'r' }, item: { id, title: id, run() {} } });
  // The row's hover actions: the app's own render, then the mods', with room made for them.
  const row = fr.sidebarRow.twins[0];
  assert.deepEqual([row.presentation, row.subject({ conversationId: 'c1' }, { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) })], ['SidebarItem', { type: 'CodexThread', provider: 'codex', id: 'c1' }]);
  const own = () => R.createElement('span', null, 'archive');
  const next = row.slots.trailingActions.apply({ renderActions: own, additionalHoverActionCount: 1 }, [entry('unit.a', 'x')], env);
  assert.equal(next.additionalHoverActionCount, 2);
  const drawn = next.renderActions({ archive: true });
  assert.equal(drawn.type, R.Fragment);
  assert.equal(row.slots.trailingActions.apply({}, [entry('unit.a', 'x')], env).renderActions, undefined, 'a row with no actions of its own: left as it is');
  // A group's header actions beside the app's, its subject the group's local project; its items, threads the app holds.
  const sec = fr.sectionActions.twins[0];
  assert.deepEqual(sec.subject({ group: { projectKind: 'local', projectId: 'p1' } }), { type: 'LocalProject', provider: 'codex', id: 'p1' });
  assert.equal(sec.subject({ group: { projectKind: 'remote', projectId: 'p1' } }), null);
  const ctx = { react: () => R };
  const besideOut = fr.sectionActions.render('Actions', { group: {}, [SIBLINGS]: ['mod'] }, (t, p) => ({ t, p }), ctx);
  assert.deepEqual([].concat(besideOut.props.children).map((c) => c.t ?? c), ['Actions', 'mod']);
  assert.equal(fr.sectionActions.render('Actions', { group: {} }, (t, p) => ({ t, p }), ctx), undefined, 'nothing beside: the app\'s own');
  // E8.9: the group's thread list: its SidebarSection's footer, regions after the list (the group's local project)
  const list = fr.sectionList.twins[0];
  assert.deepEqual([list.presentation, list.subject({ group: { projectKind: 'local', projectId: 'p1' } })], ['SidebarSection', { type: 'LocalProject', provider: 'codex', id: 'p1' }]);
  const footed = list.slots.footer.apply({ group: {} }, ['region'], { R });
  const listOut = fr.sectionList.render('List', footed, (t, p) => ({ t, p }), ctx);
  assert.deepEqual([].concat(listOut.props.children).map((c) => c.t ?? c), ['List', 'region']);
  const group = { projectKind: 'local', projectId: 'p1', threadKeys: ['local:a'] };
  const added = sidebarSection.slots.items.apply({ project: { group } }, [{ item: { type: 'CodexThread', provider: 'codex', id: 'b' } }, { item: { type: 'CodexThread', provider: 'codex', id: 'a' } }, { item: { type: 'X', provider: 'qa', id: 'z' } }]);
  assert.deepEqual(added.project.group.threadKeys, ['local:a', 'local:b'], 'the app\'s own first, none twice, only the app\'s threads');
  assert.deepEqual(sidebarSection.place, { in: 'Sidebar', on: { type: 'App', provider: 'codex', id: 'codex' }, slot: 'sections' });
  // The sidebar's sections after the app's.
  assert.deepEqual(fr.sidebar.slots.sections.apply({ sidebarSectionNodes: ['app'] }, [R.createElement('div', { key: 'unit.a/s' })], env).sidebarSectionNodes.length, 2);
  // The page's title-bar actions: the app's own HeaderAction, in the bar's thread slot.
  const HeaderAction = (p) => p;
  const page = threadView.render('Page', { conversationId: 't', [SIBLINGS]: [R.createElement('button', { key: 'codexmods:unit.a/r/x' })] }, (t, p) => ({ t, p }), { react: () => R, exports: () => ({ appShell: { HeaderAction } }) });
  const [el, act] = [].concat(page.props.children);
  assert.equal(el.t, 'Page');
  assert.deepEqual([act.type, act.props.slotPosition, act.props.align, act.props.actionId], [HeaderAction, 'thread', 'end', 'codexmods:unit.a/r/x']);
  // The palette closes by its own close.
  let closed = 0;
  assert.equal(fr.palette.operations.close({ close: () => { closed++; } }), true);
  assert.equal(closed, 1);
});

test('E7.3: a thread\'s menus take the Menu\'s rules as groups, and a row\'s menu its SidebarItem\'s rules aimed at contextMenu', async () => {
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const k = { kernel: { abi: 1, bindings: [] }, store: { renderers: new Map(), onFault: null, bump() {} }, exports: { react: React } };
  const REF = { type: 'CodexThread', provider: 'codex', id: 'c1' };
  const graph = { types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'CodexThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(q, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [{ ref: REF, liveness: 'live', state: { title: 'T' }, links: {} }] })); return { dispose() {} }; } };
  const p = startPresentation({ kernel: k, graph, bindings: [] });
  const rule = (mod, id, kind, presentation, more) => ({ mod, id, kind, presentation, realm: 'renderer', order: 1, ...more });
  p.rules.put(rule('unit.a', 'm', 'decorate', 'Menu', { data: { actions: [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }] } }));
  p.rules.put(rule('unit.b', 'm', 'add', 'Menu', { slot: 'groups', data: { items: [{ id: 'b1', title: 'B1' }] } }));
  p.rules.put(rule('unit.c', 'row', 'decorate', 'SidebarItem', { slot: 'contextMenu', data: { actions: [{ id: 'c1', title: 'C1' }] } }));
  p.rules.put(rule('unit.c', 'hover', 'decorate', 'SidebarItem', { data: { actions: [{ id: 'h', title: 'Hover' }] } }));   // the row's other slots
  await tick(); await tick();
  const ids = (surface) => k.store.menus({ target: { conversationId: 'c1' }, surface }, [{ id: 'rename-thread' }]).map((x) => x.id ?? x.type);
  assert.deepEqual(ids('header'), ['rename-thread', 'codexmods:separator:0', 'codexmods:unit.a/m/a1', 'codexmods:unit.a/m/a2', 'codexmods:separator:1', 'codexmods:unit.b/m/b1']);
  assert.deepEqual(ids('sidebar').slice(-2), ['codexmods:separator:2', 'codexmods:unit.c/row/c1'], 'the row\'s own menu, its rule\'s group last');
  p.dispose();
});

test('E7.4: the panel\'s bindings name the route\'s thread, a tab\'s subject, a pane\'s folder, a header\'s file; tabs act through the controller', async () => {
  const pn = await import('../present/bindings/panel.mjs');
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  assert.deepEqual(pn.sidePanel.subject({ controller: { panelId: 'right' } }, ctx, route), { type: 'CodexThread', provider: 'codex', id: 't1' });
  assert.equal(pn.sidePanel.subject({ controller: { panelId: 'bottom' } }, ctx, route), null, 'the bottom panel is not on the card');
  assert.equal(pn.sidePanelStrip.twins[0].subject({ focusArea: 'other' }, ctx, route), null);
  const tab = (t) => pn.panelTab.subject({ tab: t }, ctx, route);
  assert.deepEqual(tab({ tabId: 'terminal:s9', kind: 'terminal' }), { type: 'Terminal', provider: 'codex', id: 's9' });
  assert.deepEqual(tab({ tabId: 'b', kind: 'browser', props: { browserTabId: 'bt' } }), { type: 'BrowserTab', provider: 'codex', id: 't1:bt' });
  assert.deepEqual(tab({ tabId: 'f', kind: 'workspace-file', props: { path: '/r/a.txt' } }), { type: 'File', provider: 'codex', id: '/r/a.txt' });
  assert.equal(tab({ tabId: 'd', kind: 'diff' }), null);
  assert.deepEqual(tab({ tabId: 'm', kind: 'codexmods', props: { mod: 'qa.surfaces', view: 'notes' } }), { type: 'Mod', provider: 'codexmods.framework', id: 'qa.surfaces' }, 'a mod\'s view: its Mod (E8 review 3)');
  // E8.9, layouts D4: the right panel's frame resizes its ratio in this window only (the kept width is the layout.panelShare Setting's)
  const sets = [], persisted = [];
  const atoms = { config: { cfg: true }, unified: { uni: true } };
  const panelWidth = { toRatio: (w, total, mode) => `${w}/${total}/${mode}`, persist: (x) => persisted.push(x), get config() { return atoms.config; }, get unified() { return atoms.unified; } };
  const fnode = { get: (a) => (a === atoms.config ? { storageKey: 'app-shell:right-panel-width:v3' } : null) };
  const frameProps = { isContentPaneOpen: true, contentPaneWidthRatio: { set: (v) => sets.push(v) }, workspaceWidth: { get: () => 1400 } };
  assert.equal(pn.sidePanelFrame.operations.resize(frameProps, [500], { exports: () => ({ panelWidth }) }, { scopeNode: fnode }), true);
  assert.deepEqual([sets, persisted], [['500/1400/regular'], []], 'never persisted');
  assert.ok(pn.sidePanelFrame.operations.resize({ ...frameProps, isContentPaneOpen: false }, [500], { exports: () => ({ panelWidth }) }, { scopeNode: fnode }).unavailable, 'closed');
  assert.ok(pn.sidePanelFrame.operations.resize(frameProps, [100], { exports: () => ({ panelWidth }) }, { scopeNode: fnode }).unavailable, 'below the app\'s minimum');
  // WL3 (Window.setRegion, layouts.md D4): the bottom panel by the app's setter
  const bottoms = [];
  const windowRegions = { setBottom: (n, open) => bottoms.push([n, open]) };
  assert.equal(pn.sidePanelFrame.operations.bottom({}, [true], { exports: () => ({ windowRegions }) }, { scopeNode: fnode }), true);
  assert.deepEqual(bottoms, [[fnode, true]]);
  assert.ok(pn.sidePanelFrame.operations.bottom({}, ['yes'], { exports: () => ({ windowRegions }) }, { scopeNode: fnode }).unavailable);
  // the bottom panel's height (layouts WL4b): its frame's motion value, within the app's clamp, never the kept height
  const clampBottom = (e, t) => (Number.isFinite(e) ? Math.max(160, Math.min(e, t * 0.5)) : 280);
  const heights = [];
  const bprops = { bottomPanelHeight: { set: (v) => heights.push(v) }, mainContentHeight: { get: () => 800 } };
  const bctx = { exports: () => ({ bottomHeight: { clamp: clampBottom } }) };
  assert.equal(pn.bottomPanelFrame.operations.bottomHeight(bprops, [300], bctx), true);
  assert.deepEqual(heights, [300]);
  assert.match(pn.bottomPanelFrame.operations.bottomHeight(bprops, [600], bctx).unavailable, /160 to 400 px/, 'over half the main view: refused, not clamped');
  assert.ok(pn.bottomPanelFrame.operations.bottomHeight(bprops, [300], { exports: () => ({}) }).unavailable, 'no clamp exposed: unavailable');
  assert.deepEqual(heights, [300]);
  // beside the chat (layouts WL4b): placed only where the frame's host draws and ReactDOM portals; its width within its bounds
  const touched = [];
  const bctx2 = { local: { read() {}, touch: (k) => touched.push(k) }, react: () => ({ createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }),
    exports: () => ({ reactDom: { createPortal: (el, node) => ({ portal: true, el, node }) } }) };
  assert.match(pn.bottomPanelFrame.operations.bottomAt({}, ['right'], bctx2).unavailable, /cannot hold/, 'no frame host drawn here');
  assert.equal(pn.bottomPanelFrame.operations.bottomAt({}, ['below'], bctx2), true, 'below: always');
  assert.match(pn.bottomPanelFrame.operations.bottomAt({}, ['top'], bctx2).unavailable, /below, left or right/);
  assert.equal(pn.bottomPanelFrame.render('Panel', { isVisible: true, children: 'TABS' }, null, bctx2).type, pn.BottomHost, 'its host from the first render (no remount when it first goes beside)');
  assert.equal(pn.bottomPanelFrame.render('Panel', { isVisible: true, children: 'TABS' }, null, { ...bctx2, exports: () => ({}) }), undefined, 'no portal: the app\'s own');
  assert.match(pn.sidePanelFrame.operations.bottom({}, [false], { exports: () => ({}) }, { scopeNode: fnode }).unavailable, /cannot be set from here/);
  // and the sidebar's live width (its AppScope atom), within the app's bounds
  const fr = await import('../present/bindings/frame.mjs');
  const widths = [];
  const clampSidebar = (e, t = 1 / 0, n = 240) => (Number.isFinite(e) ? Math.max(n, Math.min(e, 520, t - 240)) : Math.max(340, n));
  const sideEx = { windowRegions: { sidebarWidth: 'MAn', clampSidebar } };
  const anyNode = { set: (atom, v) => widths.push([atom, v]) };
  const sw = (px, ex = sideEx) => fr.sidebar.operations.width({}, [px], { exports: () => ex, anyScopeNode: () => anyNode });
  assert.equal(sw(400), true);
  assert.deepEqual(widths, [['MAn', 400]]);
  assert.equal(sw(600).unavailable, 'a width from 240 to 520 px');
  assert.equal(sw(100).unavailable, 'a width from 240 to 520 px');
  assert.match(sw(400, {}).unavailable, /cannot be sized from here/);
  assert.equal(widths.length, 1);
  // WL3: the workspace's layout through the app's guarded setters (exposure workspaceLayout), a non-filling tab refused before anything moves
  const laid = []; let active = { tabType: { allowFullWidth: undefined } };
  const workspaceLayout = { setFull: (n, full) => laid.push(['full', full]), setPanel: (n, open) => laid.push(['panel', open]), activeTab: 'activeTab$' };
  const lnode = { get: (atom) => (atom === 'activeTab$' ? active : null) };
  const lay = (mode, ex = { workspaceLayout }) => pn.sidePanelFrame.operations.layout({}, [mode], { exports: () => ex }, { scopeNode: lnode });
  assert.equal(lay('chat'), true);
  assert.equal(lay('split'), true);
  assert.equal(lay('full'), true);
  assert.deepEqual(laid, [['panel', false], ['panel', true], ['full', false], ['panel', true], ['full', true]]);
  active = { tabType: { allowFullWidth: false } };
  assert.match(lay('full').unavailable, /does not fill the workspace/);
  assert.equal(laid.length, 5, 'refused before anything moved');
  assert.ok(lay('wide').unavailable);
  assert.match(lay('split', {}).unavailable, /cannot be set from here/, 'a build without the setters');
  assert.deepEqual(pn.panelTab.place({}, route), { in: 'SidePanel', on: { type: 'Thread', provider: 'codex', id: 't1' }, slot: 'tabs' });
  const calls = [];
  const node = { get: (atom) => (atom === 'IDS' ? ['a', 'f', 'z'] : null) };
  const controller = { activateTab: (n, id) => calls.push(['activate', id]), closeTab: (n, id) => calls.push(['close', id]), reorderTab: (n, id, to) => calls.push(['reorder', id, to]), tabIds$: 'IDS' };
  const rec = { scopeNode: node, scope: route };
  const fileTab = { controller, tab: { tabId: 'f', kind: 'workspace-file', props: { path: '/r/a.txt' } } };
  assert.equal(pn.panelTab.operations.select(fileTab, [], {}, rec), true);
  assert.equal(pn.panelTab.operations.move(fileTab, [2], {}, rec), true);
  assert.equal(pn.panelTab.operations.close(fileTab, [], {}, rec), true);
  assert.deepEqual(calls, [['activate', 'f'], ['reorder', 'f', 'z'], ['close', 'f']]);
  assert.match(pn.panelTab.operations.close({ controller, tab: { tabId: 'terminal:s9' } }, [], {}, rec).unavailable, /close the Terminal/, 'a terminal closes with its subject');
  assert.ok(pn.panelTab.operations.move(fileTab, [7], {}, rec).unavailable);
  assert.ok(pn.panelTab.operations.select(fileTab, [], {}, {}).unavailable, 'no scope: nothing');
  // The tree's pane: its folder, its toolbar beside the search box, its filter the user's search.
  const typed = [];
  const pane = { search: { onQueryChange: (q) => typed.push(q) }, children: { props: { gitCwd: '/r' } } };
  assert.deepEqual(pn.filesPane.subject(pane), { type: 'Folder', provider: 'codex', id: '/r' });
  assert.equal(pn.filesPane.operations.filter(pane, ['a.t']), true);
  assert.deepEqual(typed, ['a.t']);
  assert.deepEqual(pn.filePreview.subject({ path: '/r/a.txt' }), { type: 'File', provider: 'codex', id: '/r/a.txt' });
  assert.equal(pn.filePreview.subject({ path: '/r/a.txt', hostId: 'remote-1' }), null);
});

test('E7.5: a terminal\'s view and the browser\'s name their Terminal and BrowserTab; the browser focuses its web contents', async () => {
  const pv = await import('../present/bindings/panel-views.mjs');
  const { SIBLINGS } = await import('../present/bindings/slots.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  assert.deepEqual(pv.terminalView.subject({ sessionId: 's1' }), { type: 'Terminal', provider: 'codex', id: 's1' });
  assert.equal(pv.terminalView.subject({ sessionId: 's1', hostId: 'remote' }), null);
  assert.deepEqual(pv.terminalView.place({ sessionId: 's1' }), { in: 'PanelTab', on: { type: 'Terminal', provider: 'codex', id: 's1' }, slot: 'view' });
  const out = pv.terminalView.render('Term', { sessionId: 's1', [SIBLINGS]: ['bar'] }, (t, p) => ({ t, p }), { react: () => R });
  assert.deepEqual([].concat(out.props.children).map((c) => c.t ?? c), ['Term', 'bar'], 'the terminal first, then its regions');
  // A nested mount of the same binding (the panel passes its props on whole) renders none: the provider says an outer one did.
  const inner = pv.terminalView.render('Term', { sessionId: 's1', [SIBLINGS]: ['bar'] }, (t, p) => ({ t, p }), { react: () => ({ ...R, useContext: () => 'terminal.view' }) });
  assert.deepEqual([].concat(inner.props.children).map((c) => c.t ?? c), ['Term'], 'once');
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  assert.deepEqual(pv.browserView.subject({ conversationId: 't1', browserTabId: 'b2' }, ctx), { type: 'BrowserTab', provider: 'codex', id: 't1:b2' });
  let focused = 0;
  assert.equal(pv.browserView.operations.focus({ webContentsRef: { current: { focus: () => { focused++; } } } }), true);
  assert.equal(focused, 1);
  assert.ok(pv.browserView.operations.focus({ webContentsRef: { current: null } }).unavailable);
});

test('E7.2b: the scroll layout scrolls to a turn through the transcript\'s reveal; a terminal focuses and copies its selection through its xterm', async () => {
  const { threadLayout } = await import('../present/bindings/thread-layout.mjs');
  const pv = await import('../present/bindings/panel-views.mjs');
  const revealed = [];
  const atom = { reveal: true };
  const handlers = new Map([['t1', { revealItem: async (x) => { revealed.push(x); } }]]);
  const node = { get: (a, id) => (a === atom ? handlers.get(id) ?? null : undefined) };
  const ctx = { exports: () => ({ transcriptReveal: { atom } }) };
  const rec = { scope: { routeKind: 'local-thread', conversationId: 't1' }, scopeNode: node };
  assert.equal(await threadLayout.operations.scrollTo({}, ['u1'], ctx, rec), true);
  assert.equal(await threadLayout.operations.jumpToLatest({}, ['u9'], ctx, rec), true);
  assert.deepEqual(revealed.map((x) => [x.conversationId, x.turnKey, typeof x.itemId]), [['t1', 'u1', 'string'], ['t1', 'u9', 'string']]);
  assert.ok((await threadLayout.operations.scrollTo({}, ['u1'], ctx, { ...rec, scope: { routeKind: 'local-thread', conversationId: 't2' } })).unavailable, 'its transcript is not shown');
  assert.ok((await threadLayout.operations.scrollTo({}, ['u1'], { exports: () => ({}) }, rec)).unavailable, 'the build does not expose the reveal');
  assert.ok((await threadLayout.operations.scrollTo({}, [null], ctx, rec)).unavailable);
  assert.equal(revealed.length, 2);
  // E8.9: find is the app's own find bar: the conversation's domain, the query, open (the bar searches the pending query)
  const calls = [];
  const threadFind = { setDomain: (sc, d) => calls.push(['domain', sc === fnode, d]), setQuery: (sc, q) => calls.push(['query', q]), open: () => calls.push(['open']) };
  const fnode = { get() {}, set() {} };
  assert.equal(threadLayout.operations.find({}, ['needle'], { exports: () => ({ threadFind }) }, { ...rec, scopeNode: fnode }), true);
  assert.deepEqual(calls, [['domain', true, 'conversation'], ['query', 'needle'], ['open']]);
  assert.match(threadLayout.operations.find({}, ['needle'], { exports: () => ({ threadFind }) }, { ...rec, scopeNode: fnode, pane: 'pane-x-1' }).unavailable, /no find bar/, 'a hosted chat has none: said, never done with nothing on screen');
  assert.ok(threadLayout.operations.find({}, ['needle'], { exports: () => ({}) }, { ...rec, scopeNode: fnode }).unavailable, 'the build does not expose the find bar');
  assert.ok(threadLayout.operations.find({}, ['needle'], { exports: () => ({ threadFind }) }, { scope: { routeKind: 'home' }, scopeNode: fnode }).unavailable, 'no chat\'s transcript');
  const term = { focused: 0, selection: 'ls -la', focus() { this.focused++; }, getSelection() { return this.selection; } };
  const tctx = { exports: () => ({ terminalManager: { renderers: new Map([['s1', { terminal: term }]]) } }) };
  assert.equal(pv.terminalView.operations.focus({ sessionId: 's1' }, [], tctx), true);
  assert.equal(term.focused, 1);
  assert.ok(pv.terminalView.operations.focus({ sessionId: 's2' }, [], tctx).unavailable, 'not rendered');
  const copied = [];
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  try {
    assert.equal(await pv.terminalView.operations.copySelection({ sessionId: 's1' }, [], tctx), true);
    term.selection = '';
    assert.ok(pv.terminalView.operations.copySelection({ sessionId: 's1' }, [], tctx).unavailable, 'nothing selected');
  } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
  assert.deepEqual(copied, ['ls -la']);
});

test('E7.5b: the Changes tab\'s parts are one ChangesView of the chat\'s ChangeSet; a file\'s section and diff one DiffView of its FileChange', async () => {
  const c = await import('../present/bindings/changes.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  const set = { type: 'ChangeSet', provider: 'codex', id: 'thread:t1' };
  for (const b of [c.changesView, c.changesToolbar, c.changesScope, c.changesFiles]) {
    assert.deepEqual([b.presentation, b.subject({}, ctx, route), b.place({}, route)], ['ChangesView', set, { in: 'PanelTab', on: set, slot: 'view' }], b.id);
  }
  assert.equal(c.changesView.subject({}, { thread: (id) => ({ type: 'Thread', provider: 'qa.agent', id }) }, route), null, 'a chat that is not the app\'s has no Codex ChangeSet');
  assert.deepEqual([c.changesView.part, c.changesToolbar.part, c.changesScope.part, c.changesFiles.part], [undefined, true, true, true], 'the body is the presentation; the others its parts');
  assert.throws(() => defineBinding({ id: 'x', presentation: 'ChangesView', presents: ['ChangeSet'], subject: () => null, part: 'yes' }), /part is true or false/);
  assert.throws(() => defineBinding({ id: 'x', presentation: 'DiffView', presents: ['FileChange'], subject: () => null, layout: 'split' }), /layout\(props\)/);
  // header rows after the app's, through its pane layout function
  const calls = [];
  const out = c.changesView.slots.header.apply({ renderSlots: (arg) => { calls.push(arg); return 'laid out'; } }, [R.createElement('b', { key: 'unit.a/h' })]);
  assert.equal(out.renderSlots({ headerRows: [{ id: 'review-controls' }], content: 'x' }), 'laid out');
  assert.deepEqual(calls[0].headerRows.map((r) => [r.id, r.height ?? null]), [['review-controls', null], ['codexmods:unit.a/h', 'content']]);
  assert.equal(calls[0].content, 'x');
  // setScope: the app's own filters
  const picked = [];
  const scope = { onSelectDiffFilter: (f) => picked.push(f), availableDiffFilters: ['last-turn', 'branch', 'uncommitted'] };
  assert.equal(c.changesScope.operations.setScope(scope, ['turn']), true);
  assert.equal(c.changesScope.operations.setScope(scope, ['uncommitted']), true);
  assert.ok(c.changesScope.operations.setScope(scope, ['thread']).unavailable, 'the chat as a whole is not a view of the tab');
  assert.ok(c.changesScope.operations.setScope({ ...scope, availableDiffFilters: ['branch'] }, ['turn']).unavailable);
  assert.deepEqual(picked, ['last-turn', 'uncommitted']);
  // selectFile: by the FileChange's (or File's) absolute path, when the list shows it
  const selected = [];
  const files = { onSelectPath: (p) => selected.push(p), entries: [{ path: '/r/a.js' }] };
  assert.equal(c.changesFiles.operations.selectFile(files, [{ type: 'FileChange', provider: 'codex', id: 'thread:t1:/r/a.js' }]), true);
  assert.equal(c.changesFiles.operations.selectFile(files, [{ type: 'File', provider: 'codex', id: '/r/a.js' }]), true);
  assert.ok(c.changesFiles.operations.selectFile(files, [{ type: 'FileChange', provider: 'codex', id: 'thread:t1:/r/b.js' }]).unavailable, 'not shown');
  assert.ok(c.changesFiles.operations.selectFile(files, [{ type: 'Thread', provider: 'codex', id: 't1' }]).unavailable);
  assert.deepEqual(selected, ['/r/a.js', '/r/a.js']);
  // DiffView: by reviewPath (never the diff's name), local only; layout as the app's mode says; commentOn the app's gutter click
  const fc = { type: 'FileChange', provider: 'codex', id: 'thread:t1:/r/a.js' };
  assert.deepEqual(c.diffView.subject({ reviewPath: '/r/a.js', diff: { metadata: { name: 'src/codex-review-placeholder.ts' } } }, ctx, route), fc);
  assert.equal(c.diffView.subject({ reviewPath: '/r/a.js', hostId: 'remote' }, ctx, route), null);
  assert.equal(c.diffView.subject({ reviewPath: 'a.js' }, ctx, route), null);
  assert.deepEqual(c.diffView.place({}, route), { in: 'ChangesView', on: set, slot: 'files' });
  assert.deepEqual(['split', 'unified', 'auto'].map((v) => c.diffView.layout({ viewType: v })), ['split', 'unified', undefined]);
  assert.deepEqual(c.diffBody.subject({ diffViewProps: { reviewPath: '/r/a.js' } }, ctx, route), fc);
  const clicks = [];
  const body = { diffViewProps: { reviewPath: '/r/a.js', onGutterUtilityClick: (r) => clicks.push(r) } };
  assert.equal(c.diffBody.operations.commentOn(body, [{ start: 3, end: 5 }]), true);
  assert.equal(c.diffBody.operations.commentOn(body, [{ line: 7, side: 'old' }]), true);
  assert.ok(c.diffBody.operations.commentOn(body, [{ start: 5, end: 3 }]).unavailable);
  assert.ok(c.diffBody.operations.commentOn({ diffViewProps: {} }, [{ start: 1 }]).unavailable, 'comments off for this file');
  assert.deepEqual(clicks, [{ start: 3, end: 5, side: 'additions' }, { start: 7, end: 7, side: 'deletions' }]);
  let opened = 0;
  assert.equal(c.diffView.operations.openFile({ headerOpenAction: { onClick: () => { opened++; } } }), true);
  assert.ok(c.diffView.operations.openFile({}).unavailable);
  assert.equal(opened, 1);
  // a mod's file action keeps its click from the header's span (which may toggle the file as viewed)
  const added = c.diffView.slots.fileActions.apply({ headerEndContent: undefined }, [{ rule: { mod: 'unit.a', id: 'r' }, item: { id: 'x', title: 'Lint', run() {} } }], { R, ctx: { token: () => null, exports: () => ({}) } });
  const span = [].concat(added.headerEndContent ?? []).flat(4).find((n) => n && n.type === 'span');
  let stopped = 0;
  span.props.onClick({ stopPropagation: () => { stopped++; } });
  assert.equal(stopped, 1);
});

test('E7.7: the request card hands its Request down to the approval shell, whose body takes the RequestCard rules\' regions', async () => {
  const { requestShell, requestContext } = await import('../present/bindings/request-body.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const req = { type: 'Request', provider: 'codex', id: 'x:s:3' };
  const ctxBase = { react: () => R, request: (id) => ({ ...req, id: `x:${id}` }), subject: (ref) => ({ ref, state: {}, links: {} }) };
  const card = requestCard.render('Card', { conversationId: 't', pendingRequest: { type: 'approval', item: { approvalRequestId: 's:3' } } }, (t, p) => ({ t, p }), ctxBase);
  assert.equal(card.type, requestContext(R).Provider, 'always wrapped the same way');
  assert.deepEqual(card.props.value, req);
  // the shell: the rules' body regions after the app's body, for the Request in context
  let asked = null;
  const ctx = { ...ctxBase, ruled: (p, inst) => { asked = [p, inst.ref.id]; return { regions: { body: ['mod body'] }, actions: [] }; } };
  const Rc = { ...R, useContext: () => req };
  const out = requestShell.render('Shell', { title: 'Run it?', actions: {}, body: 'diff' }, (t, p) => ({ t, p }), { ...ctx, react: () => Rc });
  assert.deepEqual(asked, ['RequestCard', 'x:s:3']);
  assert.deepEqual([out.t, [].concat(out.p.body.props?.children ?? out.p.body)], ['Shell', ['diff', 'mod body']]);
  assert.equal(requestShell.render('Shell', { title: 'x', actions: {} }, (t, p) => ({ t, p }), { ...ctx, react: () => ({ ...R, useContext: () => null }) }), undefined, 'no Request: the app\'s own');
  // E8.9: the mods' actions join the card's button row (the surface's last child, a form): after the leading action, before Deny/Approve
  const { requestSurface } = await import('../present/bindings/request-body.mjs');
  const ran = [];
  const CodexButton = (p) => p;
  const ctxA = { ...ctx, exports: () => ({ CodexButton, Button: () => null }), ruled: () => ({ regions: { actions: ['mod region'] }, actions: [{ key: 'codexmods:m/r/x', title: 'Explain', run: () => ran.push('x') }] }) };
  const form = R.createElement('form', { className: 'row' }, 'lead', 'denyAndApprove');
  const surface = requestSurface.render('Surface', { className: 'c', 'data-codex-approval-surface': true, children: ['header', 'body', form] }, (t, p) => ({ t, p }), { ...ctxA, react: () => Rc });
  const row = surface.p.children[2];
  assert.deepEqual(surface.p.children.slice(0, 2), ['header', 'body']);
  assert.equal(row.type, 'form');
  const [lead, btn, region, rest] = [].concat(row.props.children);
  assert.deepEqual([lead, btn.type, btn.props.color, btn.props.size, btn.props.children, region, rest], ['lead', CodexButton, 'outline', 'composer', 'Explain', 'mod region', 'denyAndApprove']);
  btn.props.onClick();
  assert.deepEqual(ran, ['x']);
  // 22943's form: [leading action as a menu, as a button (one of them false), Deny/Approve]: the mods' go before the last
  const form3 = R.createElement('form', { className: 'row' }, false, 'leadButton', 'denyAndApprove');
  const kids3 = [].concat(requestSurface.render('Surface', { className: 'c', 'data-codex-approval-surface': true, embedded: false, children: ['header', 'body', form3] }, (t, p) => ({ t, p }), { ...ctxA, react: () => Rc }).p.children[2].props.children);
  assert.deepEqual([kids3[0], kids3[1], kids3[2].props.children, kids3[3], kids3[4]], [false, 'leadButton', 'Explain', 'mod region', 'denyAndApprove']);
  assert.equal(requestSurface.render('Surface', { children: ['header', 'body', 'not a form'] }, (t, p) => ({ t, p }), { ...ctxA, react: () => Rc }), undefined, 'no row: the app\'s own');
  assert.equal(requestSurface.render('Surface', { children: ['h', form] }, (t, p) => ({ t, p }), { ...ctxA, ruled: () => ({ regions: {}, actions: [] }), react: () => Rc }), undefined, 'no actions: the app\'s own');
});

test('E7.6: a settings page\'s frame by its title\'s slug (its sections, a card of rows, its toolbar), an automation\'s view, the context meter', async () => {
  const sa = await import('../present/bindings/settings-attention.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const tw = sa.settingsFrame.twins[0];
  const title = R.createElement('T', { slug: 'git-settings' });
  assert.deepEqual(tw.subject({ title }), { type: 'SettingsSection', provider: 'codex', id: 'git-settings' });
  assert.equal(tw.subject({ title: 'A mod\'s page' }), null, 'the framework\'s own pages take nothing');
  assert.equal(tw.subject({ title: R.createElement('T', { slug: 'x', more: 1 }) }), null);
  const Card = 'Card';
  const env = { R, ctx: { exports: () => ({ SettingsCard: Card }), token: () => null } };
  assert.deepEqual(tw.slots.sections.apply({ children: ['a', 'b'] }, ['m'], env).children, ['a', 'b', 'm'], 'after the page\'s own');
  assert.deepEqual(tw.slots.sections.apply({ children: 'a' }, ['m'], env).children, ['a', 'm']);
  const rows = tw.slots.rows.apply({ children: ['a'] }, ['r1', 'r2'], env).children;
  assert.equal(rows[1].type, Card, 'the rows in a card of their own');
  assert.deepEqual(sa.automationView.subject({ automation: { id: 'auto-1' } }), { type: 'Automation', provider: 'codex', id: 'auto-1' });
  // E8.9: a local task's page (its summary card) and its Edit dialog present the task; a cloud task's card nothing
  const auto = { type: 'Automation', provider: 'codex', id: 'auto-1' };
  assert.deepEqual([sa.automationSummary.subject({ automationId: 'auto-1', source: 'local' }), sa.automationSummary.subject({ automationId: 'auto-1', source: 'cloud' })], [auto, null]);
  assert.deepEqual([sa.automationEdit.subject({ draft: { id: 'auto-1' }, executionLocation: 'local' }), sa.automationEdit.subject({ draft: {}, executionLocation: 'local' }), sa.automationEdit.part], [auto, null, true]);
  const Codex = (p) => p;
  const aenv = { R, ctx: { exports: () => ({ CodexButton: Codex }), token: () => null, react: () => R } };
  const entry = { rule: { mod: 'm', id: 'r' }, item: { id: 'x', title: 'Duplicate', run() {} } };
  const withRow = sa.automationSummary.slots.details.apply(sa.automationSummary.slots.actions.apply({ automationId: 'auto-1' }, [entry], aenv), ['region'], aenv);
  const drawn = sa.automationSummary.render('Card', withRow, (t, p) => ({ t, p }), aenv.ctx);
  const [card, row, region] = [].concat(drawn.props.children);
  assert.deepEqual([card.t, row.props['data-codexmods-automation-actions'], region], ['Card', '', 'region'], 'the card, then its actions\' row, then the regions');
  const footer = sa.automationEdit.slots.actions.apply({ statusAction: 'pause' }, [entry], aenv).statusAction;
  const btn = [].concat(footer.props.children)[1];
  assert.deepEqual([btn.type, btn.props.color, btn.props.radius, btn.props.size, btn.props.children], [Codex, 'secondary', 'full', 'dialogAction', 'Duplicate'], 'beside Pause/Resume, drawn as it is');
  // E8.9: a scheduled task's "..." menu: the mods' entries for the Automation after the app's items, drawn with the menu's own items
  const Item = (p) => p; const Separator = () => null;
  const ran = [];
  const mctx = { react: () => R, exports: () => ({ MenuParts: { Item, Separator } }), subjectMenu: (ref) => [[{ id: 'codexmods:m/e/e', message: { defaultMessage: `On ${ref.id}` }, onSelect: () => ran.push(ref.id) }]] };
  const menuProps = { deleteAction: {}, additionalMenuItems: R.createElement('EditShare', { automationId: 'auto-1', source: 'local' }), trailingMenuItems: undefined };
  const menu = sa.automationMenu.render('Menu', menuProps, (t, p) => ({ t, p }), mctx);
  const [sep, item] = [].concat(menu.p.trailingMenuItems.props.children);
  assert.deepEqual([sep.type, item.type, item.props.children], [Separator, Item, 'On auto-1']);
  item.props.onSelect();
  assert.deepEqual(ran, ['auto-1']);
  assert.equal(sa.automationMenu.render('Menu', { ...menuProps, additionalMenuItems: R.createElement('EditShare', { automationId: 'auto-1', source: 'cloud' }) }, (t, p) => ({ t, p }), mctx), undefined, 'a cloud task: the app\'s own');
  assert.equal(sa.automationMenu.render('Menu', menuProps, (t, p) => ({ t, p }), { ...mctx, subjectMenu: () => [] }), undefined, 'no entries: the app\'s own');
  const chat = { kind: 'local', placement: 'main', conversationId: 't1' };
  assert.deepEqual(sa.contextMeter.subject({ contextUsage: {} }, { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) }, chat), { type: 'CodexThread', provider: 'codex', id: 't1' });
  assert.deepEqual(sa.contextMeter.place({}, chat), { in: 'Composer', on: { type: 'Draft', provider: 'codex', id: 't1' }, slot: 'status' });
});

test('E7.6: the runtime resolves a framework-rendered presentation\'s rules (ruled): its replacement, its regions, its actions', async () => {
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const graph = { types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(q, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [] })); return { dispose() {} }; } };
  // A binding's render sees the runtime's ctx, which carries `ruled`.
  let ctx = null;
  const probe = defineBinding({ id: 'probe', presents: ['Thread'], subject: () => null, render: (O, props, f, c) => { ctx = c; return undefined; } });
  const k = { kernel: { abi: 1, bindings: ['probe'] }, store: { renderers: new Map(), onFault: null, bump() {} }, exports: { react: React } };
  const p = startPresentation({ kernel: k, graph, bindings: [probe] });
  const rule = (mod, id, kind, more) => ({ mod, id, kind, presentation: 'DetailView', realm: 'renderer', order: 1, ...more });
  const Region = () => null;
  p.rules.put(rule('unit.a', 'sec', 'host', { slot: 'sections', fns: { render: Region } }));
  p.rules.put(rule('unit.a', 'act', 'decorate', { data: { actions: [{ id: 'go', title: 'Go' }] } }));
  await tick(); await tick();
  k.store.renderers.get('probe')('X', {}, (t, pr) => ({ t, pr }));
  const inst = { ref: { type: 'TestAgentThread', provider: 'qa.test-agent', id: 'x1' }, state: { title: 'X' }, links: {} };
  const out = ctx.ruled('DetailView', inst);
  assert.deepEqual([out.hidden, out.replace, out.regions.sections.length, out.actions.map((a) => a.title)], [false, null, 1, ['Go']]);
  p.rules.put(rule('unit.b', 'swap', 'replace', { order: 0, fns: { render: Region } }));
  await tick();
  assert.ok(ctx.ruled('DetailView', inst).replace, 'a mod\'s replacement');
  assert.equal(ctx.ruled('Nothing', inst), null, 'no rule of that presentation');
  p.dispose();
});

test('E8.7: a file or folder row\'s menu takes the mods\' entries for its subject (by its path), each rule a group behind a separator; the Changes tree adds fileRowActions', () => {
  const k = fakeKernel([]);
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [] });
  const ran = [];
  p.rules.put({ mod: 'unit.c', id: 'f', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'File', realm: 'renderer', order: 1, fns: { items: [{ id: 'f', title: 'On a file', run: (env) => ran.push(env.subject) }] } });
  p.rules.put({ mod: 'unit.c', id: 'd', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'Folder', realm: 'renderer', order: 2, fns: { items: [{ id: 'd', title: 'On a folder', run: () => {} }] } });
  p.rules.put({ mod: 'unit.c', id: 'r', kind: 'add', presentation: 'ChangesView', slot: 'fileRowActions', realm: 'renderer', order: 3, fns: { items: [{ id: 'r', title: 'On a change', run: () => {} }] } });
  p.rules.put({ mod: 'unit.c', id: 'any', kind: 'add', presentation: 'Menu', slot: 'groups', realm: 'renderer', order: 4, fns: { items: [{ id: 'any', title: 'A thread menu entry', run: () => {} }] } });
  const app = [{ id: 'add-to-chat' }, { id: 'copy-path' }];
  const ids = (out) => out.map((x) => x.id);
  const onFile = k.store.menus({ targetPath: '/repo/a.js' }, app, 'file-tree');
  assert.deepEqual(ids(onFile), ['add-to-chat', 'copy-path', 'codexmods:separator:0', 'codexmods:unit.c/f/f'], 'a Menu rule with no `for` stays a thread\'s');
  assert.equal(onFile[3].message.defaultMessage, 'On a file');
  onFile[3].onSelect();
  assert.deepEqual(ran, [{ type: 'File', provider: 'codex', id: '/repo/a.js' }], 'told the file it was opened on');
  assert.deepEqual(ids(k.store.menus({ targetPath: '/repo/src/' }, app, 'file-tree')), ['add-to-chat', 'copy-path', 'codexmods:separator:0', 'codexmods:unit.c/d/d']);
  assert.deepEqual(ids(k.store.menus({ targetPath: '/repo/a.js', onCopyPath: () => {} }, app, 'file-tree')), ['add-to-chat', 'copy-path', 'codexmods:separator:0', 'codexmods:unit.c/f/f'], 'no chat shown: no ChangesView entries');
  assert.deepEqual(k.store.menus({ targetPath: null }, app, 'file-tree'), app, 'no path: the app\'s items');
  p.dispose();
});

test('E8.9: every file tree row takes FilesView\'s rowActions; a file the shown chat\'s Changes list lists also takes ChangesView\'s fileRowActions, for its FileChange', async () => {
  const k = fakeKernel([]);
  const change = { ref: { type: 'FileChange', provider: 'codex', id: 'thread:t1:/repo/a.js' }, liveness: 'live', state: { path: 'a.js' }, links: {} };
  const graph = { ...fakeGraph({ [change.ref.id]: change }), types: async () => [{ id: 'CodexThread', concept: 'Thread' }, { id: 'FileChange', concept: 'FileChange' }, { id: 'File', concept: 'File' }] };
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  k.store.mounted = () => [{ binding: 'thread.layout', scopeNode: { get() {}, value: route } }, { binding: 'changes.files', scope: route, props: { entries: [{ path: '/repo/a.js' }, { path: '/repo/w.js' }] } }];
  const p = startPresentation({ kernel: k, graph, bindings: [] });
  await tick();
  const ran = [];
  p.rules.put({ mod: 'unit.c', id: 'fv', kind: 'add', presentation: 'FilesView', slot: 'rowActions', realm: 'renderer', order: 1, fns: { items: [{ id: 'fv', title: 'On a tree row', run: (env) => ran.push(['fv', env.subject.type]) }] } });
  p.rules.put({ mod: 'unit.c', id: 'r', kind: 'add', presentation: 'ChangesView', slot: 'fileRowActions', realm: 'renderer', order: 2, fns: { items: [{ id: 'r', title: 'On a change', run: (env) => ran.push(['r', env.subject.id]) }] } });
  const app = [{ id: 'copy-path' }];
  const ids = (out) => out.map((x) => x.id);
  // the page names the chat (its protocol id) and reads its FileChange first: a menu opened before has the tree's entries, or the File
  for (let i = 0; i < 2; i++) { k.store.menus({ targetPath: '/repo/a.js' }, app, 'file-tree'); await tick(); await tick(); }
  const changed = k.store.menus({ targetPath: '/repo/a.js' }, app, 'file-tree');
  assert.deepEqual(ids(changed), ['copy-path', 'codexmods:separator:0', 'codexmods:unit.c/fv/fv', 'codexmods:separator:1', 'codexmods:unit.c/r/r']);
  changed[2].onSelect(); changed[4].onSelect();
  assert.deepEqual(ran, [['fv', 'File'], ['r', 'thread:t1:/repo/a.js']], 'the tree\'s entry has the File, the change\'s its FileChange');
  assert.deepEqual(ids(k.store.menus({ targetPath: '/repo/b.js' }, app, 'file-tree')), ['copy-path', 'codexmods:separator:0', 'codexmods:unit.c/fv/fv'], 'a file the Changes list does not list');
  // E8 review 3: a file the Changes list lists that the chat did not change (the repository's own change): its File, never an invented FileChange
  const listed = k.store.menus({ targetPath: '/repo/w.js' }, app, 'file-tree');
  await tick(); await tick();
  const again = k.store.menus({ targetPath: '/repo/w.js' }, app, 'file-tree');
  assert.equal(listed.length, again.length);
  again[4].onSelect();
  assert.deepEqual(ran.at(-1), ['r', '/repo/w.js']);
  p.dispose();
});

test('P5 v2: a Palette rule with its command is a row of the "Mod commands" group (its mod beside it), run through the rule while it is live', () => {
  const k = fakeKernel(['grab']);
  let grabbed = null;
  const grab = defineBinding({ id: 'grab', presents: ['Thread'], render: (O, p, f, ctx) => { grabbed = ctx; return undefined; } });
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [grab] });
  k.store.renderers.get('grab')('X', {}, (t, x) => x, null, null, null);
  const ran = [];
  const rule = { mod: 'unit.m', id: 'sync', kind: 'add', presentation: 'Palette', slot: 'resultSources', realm: 'renderer', order: 1, fns: { command: { title: 'Sync now', keywords: ['refresh'], run: (env) => ran.push(env.via) } } };
  p.rules.put(rule);
  const own = grabbed.paletteSources().sources().find((x) => x.key === 'codexmods.framework/commands');
  const [row] = own.itemsOf();
  assert.deepEqual([row.id, row.title, row.description, row.keywords], ['rule:unit.m/sync', 'Sync now', 'unit.m', ['unit.m', 'sync', 'refresh']]);
  row.run({ via: 'palette' });
  assert.deepEqual(ran, ['palette']);
  p.rules.remove('unit.m/sync');
  row.run({ via: 'palette' });
  assert.deepEqual(ran, ['palette'], 'a row of a rule that went does nothing');
  assert.equal(grabbed.paletteSources().sources().some((x) => x.key === 'codexmods.framework/commands'), false, 'no command left: no group');
  // public hooks §3.14: a command's group is a group of its own, its description beside its mod; one that applies to a subject is offered
  // only while a window shows one
  p.rules.put({ ...rule, id: 'push', fns: { command: { title: 'Push', group: 'Git', description: 'to origin', run: () => {} } } });
  p.rules.put({ ...rule, id: 'pin', fns: { command: { title: 'Pin it', appliesTo: 'Thread', run: () => {} } } });
  const git = grabbed.paletteSources().sources().find((x) => x.key === 'codexmods.framework/commands/Git');
  assert.deepEqual([git.title, git.itemsOf().map((x) => [x.title, x.description])], ['Git', [['Push', 'unit.m · to origin']]]);
  assert.deepEqual(grabbed.paletteSources().sources().find((x) => x.key === 'codexmods.framework/commands').itemsOf(), [], 'no window shows a thread here: not offered');
  p.dispose();
});

test('E8.7b: the project menu binding names the nearest section\'s local project and adds the mods\' groups after the app\'s items (sync or async)', async () => {
  const { projectMenu } = await import('../present/bindings/frame.mjs');
  const near = { binding: 'sidebar.section.actions', site: 'sidebar-project', props: { group: { projectKind: 'local', projectId: 'p1' } } };
  assert.deepEqual(projectMenu.subject({}, {}, null, near), { type: 'LocalProject', provider: 'codex', id: 'p1' });
  assert.equal(projectMenu.subject({}, {}, null, { ...near, props: { group: { projectKind: 'remote', projectId: 'r1' } } }), null);
  assert.equal(projectMenu.subject({}, {}, null, null), null);
  const ctx = { projectMenu: (ref, items) => [...items, { id: `mod:${ref.id}` }] };
  const factory = (type, props) => ({ type, props });
  const el = projectMenu.render('M', { getContextMenuItems: () => [{ id: 'pin' }] }, factory, ctx, null, near);
  assert.deepEqual(el.props.getContextMenuItems().map((x) => x.id), ['pin', 'mod:p1']);
  const asyncEl = projectMenu.render('M', { getContextMenuItems: async () => [{ id: 'pin' }] }, factory, ctx, null, near);
  assert.deepEqual((await asyncEl.props.getContextMenuItems()).map((x) => x.id), ['pin', 'mod:p1']);
  assert.equal(projectMenu.render('M', { getContextMenuItems: () => [] }, factory, ctx, null, null), undefined, 'no project: the app\'s own');
});

test('E8.7b: a file referenced anywhere (a chip, a link, a tab) takes the mods\' entries for its File (its path made absolute with its cwd), a workspace reference its Folder\'s', () => {
  const k = fakeKernel([]);
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [] });
  const ran = [];
  p.rules.put({ mod: 'unit.c', id: 'f', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'File', realm: 'renderer', order: 1, fns: { items: [{ id: 'f', title: 'On a file', run: (env) => ran.push(env.subject) }] } });
  p.rules.put({ mod: 'unit.c', id: 'd', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'Folder', realm: 'renderer', order: 2, fns: { items: [{ id: 'd', title: 'On a folder', run: () => {} }] } });
  p.rules.put({ mod: 'unit.c', id: 'r', kind: 'add', presentation: 'ChangesView', slot: 'fileRowActions', realm: 'renderer', order: 3, fns: { items: [{ id: 'r', title: 'On a change', run: () => {} }] } });
  const app = [{ id: 'workspace-file-copy-path' }];
  const ids = (out) => out.map((x) => x.id);
  const rel = k.store.menus({ path: 'src/a.js', cwd: '/repo/' }, app, 'workspace-file');
  assert.deepEqual(ids(rel), ['workspace-file-copy-path', 'codexmods:separator:0', 'codexmods:unit.c/f/f'], 'only Menu rules for its type (not a tree\'s row actions)');
  rel[2].onSelect();
  assert.deepEqual(ran, [{ type: 'File', provider: 'codex', id: '/repo/src/a.js' }]);
  assert.deepEqual(ids(k.store.menus({ path: '/repo', openMode: 'workspace' }, app, 'workspace-file')), ['workspace-file-copy-path', 'codexmods:separator:0', 'codexmods:unit.c/d/d']);
  assert.deepEqual(k.store.menus({ path: 'a.js' }, app, 'workspace-file'), app, 'a relative path with no cwd: the app\'s items');
  // E8 review 3: another host's file is not this Mac's; `.` and `..` are resolved (above the root: none)
  assert.deepEqual(k.store.menus({ path: '/repo/a.js', hostId: 'remote-1' }, app, 'workspace-file'), app, 'a remote file: the app\'s items');
  k.store.menus({ path: '../b.js', cwd: '/repo/src', hostId: 'local' }, app, 'workspace-file')[2].onSelect();
  assert.deepEqual(ran.at(-1), { type: 'File', provider: 'codex', id: '/repo/b.js' });
  assert.deepEqual(k.store.menus({ path: '../../../x', cwd: '/repo' }, app, 'workspace-file'), app, 'above the root: none');
  p.dispose();
});

test('E8.7b: a panel tab\'s menu: a file\'s tab takes its File\'s entries, another tab its PanelTab\'s (by its kind), the PanelTab the page reports', () => {
  const k = fakeKernel([]);
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [] });
  const ran = [];
  p.rules.put({ mod: 'unit.c', id: 'f', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'File', realm: 'renderer', order: 1, fns: { items: [{ id: 'f', title: 'On a file', run: (env) => ran.push(env.subject) }] } });
  p.rules.put({ mod: 'unit.c', id: 't', kind: 'add', presentation: 'Menu', slot: 'groups', for: 'PanelTab', where: { kind: 'terminal' }, realm: 'renderer', order: 2, fns: { items: [{ id: 't', title: 'On a terminal tab', run: (env) => ran.push(env.subject) }] } });
  const shown = { f1: { tabType: { kind: 'workspace-file' }, props: { path: '/repo/a.js', hostId: 'local' } }, e1: { tabType: { kind: 'text-file-editor' }, props: { path: '/repo/b.js', hostId: 'remote-1' } },
    t1: { tabType: { kind: 'terminal' }, props: {} }, b1: { tabType: { kind: 'browser' }, props: {} } };
  const scope = { get: (atom, id) => (atom === 'presented' ? shown[id] : null) };
  const args = (tabId) => ({ scope, controller: { presentedTabById$: 'presented' }, tab: { tabId } });
  const app = [{ id: 'close-tab' }];
  const ids = (out) => out.map((x) => x.id);
  const onFile = k.store.menus(args('f1'), app, 'tab');
  assert.deepEqual(ids(onFile), ['close-tab', 'codexmods:separator:0', 'codexmods:unit.c/f/f']);
  onFile[2].onSelect();
  assert.deepEqual(ran, [{ type: 'File', provider: 'codex', id: '/repo/a.js' }]);
  assert.deepEqual(k.store.menus(args('e1'), app, 'tab'), app, 'another host\'s file tab: the app\'s items');
  // a tab the page does not report as a PanelTab (no instance the graph has): the app's items, never an invented ref
  assert.deepEqual(k.store.menus(args('t1'), app, 'tab'), app);
  assert.deepEqual(k.store.menus(args('b1'), app, 'tab'), app, 'a browser tab: no rule names it');
  p.dispose();
});

test('E8.9, WL1: the title bar binding draws the TitleBar\'s entries in the app\'s positions (right, left, thread, ...), as the app\'s HeaderActions', async () => {
  const { windowTitleBar } = await import('../present/bindings/frame.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const HeaderAction = function HeaderAction() { return null; };
  const ctx = { react: () => React, exports: () => ({ appShell: { HeaderAction } }), token: () => undefined, guard: (r, fn) => fn };
  const env = { R: React, ctx };
  const rule = (id) => ({ mod: 'unit.t', id });
  let props = { hasPageSurface: false };
  const bar = windowTitleBar.twins[0];
  assert.equal(bar.presentation, 'TitleBar');
  assert.deepEqual(Object.keys(bar.slots), ['left', 'center', 'right', 'main', 'thread', 'threadSummary', 'menu'], 'the app\'s six positions, and its context menu');
  props = bar.slots.right.apply(props, [{ rule: rule('a'), item: { id: 'x', title: 'Bar', run() {} } }], env);
  props = bar.slots.left.apply(props, [{ rule: rule('b'), item: { id: 'y', title: 'Side', run() {} } }], env);
  props = bar.slots.thread.apply(props, [{ rule: rule('c'), item: { id: 'z', title: 'Chat', run() {} } }], env);
  const factory = (type, p) => React.createElement(type, p);
  const out = windowTitleBar.render('TitleBar', props, factory, ctx);
  const [own, ...actions] = out.props.children;
  assert.equal(own.type, 'TitleBar');
  assert.equal('__codexmodsHeader' in own.props, false, 'the title bar gets its own props only');
  assert.deepEqual(actions.map((a) => [a.type, a.props.actionId, a.props.slotPosition, a.props.align, a.props.desktopPlacement]), [
    [HeaderAction, 'codexmods:unit.t/a/x', 'right', 'end', 'titlebar'], [HeaderAction, 'codexmods:unit.t/b/y', 'left', 'end', 'titlebar'],
    [HeaderAction, 'codexmods:unit.t/c/z', 'thread', 'end', 'titlebar']]);
  assert.deepEqual(Object.keys(windowTitleBar.slots), ['status', 'banner'], 'the Window keeps its status and banner');
  assert.equal(windowTitleBar.render('TitleBar', { hasPageSurface: false }, factory, ctx), undefined, 'no entries: the app\'s own');
});

test('WL2: the panels\' strips: the SidePanel\'s before its tabs and empty, the BottomPanel\'s (a twin on the same host) after, before and empty', async () => {
  const { sidePanel } = await import('../present/bindings/panel.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  assert.equal(sidePanel.subjectOnly, true, 'the right panel\'s rules apply only where it names its chat (the host also hosts the bottom panel)');
  assert.deepEqual(Object.keys(sidePanel.slots), ['tabs', 'stripBefore', 'empty']);
  const t = sidePanel.twins[0];
  assert.deepEqual([t.presentation, Object.keys(t.slots)], ['BottomPanel', ['toolbar', 'stripBefore', 'empty']]);
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  assert.equal(t.subject({ controller: { panelId: 'right' } }, ctx, route), null, 'not the right panel\'s');
  assert.deepEqual(t.subject({ controller: { panelId: 'bottom' } }, ctx, route), { type: 'CodexThread', provider: 'codex', id: 't1' });
  const out = t.slots.toolbar.apply({ afterList: 'app' }, ['mine'], { R: React });
  assert.ok(out.afterList, 'after the app\'s own');
  assert.ok(sidePanel.slots.empty.apply({}, ['none yet'], { R: React }).emptyState);
});

test('WL2: the title bar\'s context menu: the mods\' entries as the app\'s own items, one props object while unchanged, the latest run', async () => {
  const { windowTitleBar, menuItemProps } = await import('../present/bindings/frame.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const ran = [];
  const a = menuItemProps('k1', { id: 'x', title: 'QA', run: () => ran.push(1) });
  const b = menuItemProps('k1', { id: 'x', title: 'QA', run: () => ran.push(2) });
  assert.equal(a, b, 'the same object while what it shows is unchanged (no re-registration)');
  b.onSelect();
  assert.deepEqual(ran, [2], 'the latest run');
  assert.deepEqual(a.message, { id: 'codexmods.menu.k1', defaultMessage: 'QA' }, 'a plain-text message');
  const c = menuItemProps('k1', { id: 'x', title: 'QA', checked: true, run() {} });
  assert.notEqual(c, a);
  assert.deepEqual([c.type, c.checked], ['checkbox', true]);
  assert.equal(menuItemProps('k2', { id: 'y', title: 'Off', disabled: true, run: () => ran.push(3) }).enabled, false);
  menuItemProps('k2', { id: 'y', title: 'Off', disabled: true, run: () => ran.push(3) }).onSelect();
  assert.deepEqual(ran, [2], 'a disabled entry runs nothing');
  // drawn beside the title bar as the app's HeaderContextMenuItem
  const HeaderContextMenuItem = function HeaderContextMenuItem() { return null; };
  const ctx = { react: () => React, exports: () => ({ appShell: { HeaderContextMenuItem } }) };
  let props = { hasPageSurface: false };
  props = windowTitleBar.twins[0].slots.menu.apply(props, [{ rule: { mod: 'unit.t', id: 'm' }, item: { id: 'z', title: 'Mine', run() {} } }], { R: React, ctx });
  const out = windowTitleBar.render('TitleBar', props, (t, p) => React.createElement(t, p), ctx);
  const [own, item] = out.props.children;
  assert.equal(own.type, 'TitleBar');
  assert.deepEqual([item.type, item.props.id, item.props.message.defaultMessage], [HeaderContextMenuItem, 'codexmods:unit.t/m/z', 'Mine']);
});

test('WL2: the rail\'s ends: the mods\' regions as its header and after its own footer', async () => {
  const { rail } = await import('../present/bindings/frame.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const t = rail.twins[0];
  assert.deepEqual([t.presentation, Object.keys(t.slots)], ['Rail', ['header', 'footer']]);
  const props = { footer: 'app footer', home: {} };
  assert.equal(t.slots.header.apply(props, [], { R: React }), props, 'none: the app\'s own');
  const out = t.slots.footer.apply(t.slots.header.apply(props, ['top'], { R: React }), ['mine'], { R: React });
  assert.deepEqual([out.header.props.children, out.footer.props.children], [[null, 'top'], ['app footer', 'mine']]);
});

test('E8.3h: the new chat\'s target as its composer shows it is a window fact: where it runs, its starting branch and mode, its model menu\'s model and effort', async () => {
  const { composerRunLocation, newChatTargetOf } = await import('../present/bindings/composer.mjs');
  const home = { kind: 'new', entrypoint: 'home' }, panel = { kind: 'new', entrypoint: 'panel' };
  let mounts = {};
  const ctx = { mountsOf: (id) => mounts[id] ?? [] };
  assert.equal(newChatTargetOf(ctx), null, 'no new chat shown');
  assert.deepEqual(composerRunLocation.windowFacts(ctx), { newChat: null }, 'told when it goes');
  mounts = {
    'composer.runLocation': [{ scope: panel, props: { composerMode: 'cloud' } }, { scope: home, props: { composerMode: 'worktree', asyncThreadStartingState: { type: 'branch', branchName: 'feature' } } }],
    'composer.mode': [{ scope: home, props: { activeCollaborationMode: { mode: 'plan' } } }],
    'picker.model': [{ scope: home, props: { model: 'gpt-x', reasoningEffort: 'high' } }],
  };
  assert.deepEqual(composerRunLocation.windowFacts(ctx), { newChat: { environment: 'worktree', branch: 'feature', mode: 'plan', model: 'gpt-x', effort: 'high' } });
  mounts['composer.runLocation'][1].props = { composerMode: 'local', asyncThreadStartingState: { type: 'branch', branchName: 'feature' } };
  assert.deepEqual(newChatTargetOf(ctx), { environment: 'local', mode: 'plan', model: 'gpt-x', effort: 'high' }, 'a local chat has no starting branch');
  // a part drawn twice in one composer: its first; a second composer of the new chat here (a page kept mounted out of sight): no field
  // from either, never a mix (graph-layers.md §5)
  mounts['composer.mode'].push({ scope: home, props: { activeCollaborationMode: { mode: 'default' } } });
  mounts.composer = [{ scope: home, props: {} }];
  assert.equal(newChatTargetOf(ctx).mode, 'plan');
  mounts.composer.push({ scope: home, props: {} });
  assert.equal(newChatTargetOf(ctx), null);
});

test('H8d: a composer\'s attachments are its tray\'s (a window fact by Draft); an image goes in as the app\'s paste, one comes out by the tray\'s own remove', async () => {
  const { composer, attachmentsOf } = await import('../present/bindings/composer.mjs');
  const chat = { kind: 'local', conversationId: 't1' };
  const removed = [], pasted = [];
  const tray = {
    shownImages: [{ id: 'img-1', src: 'data:image/png;base64,AA==', filename: 'shot.png', localPath: '/tmp/shot.png' }],
    shownFiles: [{ label: 'notes.md', path: '/r/notes.md', fsPath: '/r/notes.md' }], addedFiles: [{ path: '/r/drop.txt' }],
    handleRemoveImage: (id) => removed.push(['image', id]), handleRemoveFileAttachment: (i) => removed.push(['picked', i]), handleRemoveFile: (i) => removed.push(['added', i]),
  };
  const props = { viewProps: { attachments: { props: tray }, editor: { composerController: { eventEmitter: { emit: (name, files) => pasted.push([name, files]) } } } } };
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }), mountsOf: (id) => (id === 'composer' ? [{ scope: chat, props }] : []) };
  assert.deepEqual(attachmentsOf(ctx), { t1: [
    { id: 'image:img-1', kind: 'image', name: 'shot.png', path: '/tmp/shot.png' },
    { id: 'picked:path:/r/notes.md', kind: 'file', name: 'notes.md', path: '/r/notes.md' }, { id: 'added:path:/r/drop.txt', kind: 'file', name: 'drop.txt', path: '/r/drop.txt' },
  ] });
  assert.deepEqual(composer.windowFacts(ctx), { attachments: attachmentsOf(ctx) });
  const ops = composer.operations;
  // a file, told by this very composer: its editor focused and the app's message given in one step, nothing between them
  const told = [];
  const bus = { getInstance: () => ({ dispatchHostMessage: (m) => told.push(['told', m]) }) };
  const rec = { context: { view: { focus: () => told.push(['focused']) } } };
  const file = { label: 'a.txt', path: '/r/a.txt', fsPath: '/r/a.txt' };
  assert.equal(ops.attachFile(props, [file], { exports: () => ({ bus }) }, rec), true);
  assert.deepEqual(told, [['focused'], ['told', { type: 'add-context-file', file }]]);
  assert.equal(ops.attachFile(props, [file], { exports: () => ({}) }, rec), false, 'a build without the bus: the caller\'s other way');
  assert.equal(ops.attachFile(props, [file], { exports: () => ({ bus }) }, {}), false, 'no editor here');
  const hadDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hasFocus: () => false }, configurable: true });
  try {
    // a window not in front moves no focus: with another composer here the app's active one could be that one
    const others = { exports: () => ({ bus }), mountsOf: () => [{}, {}] }, alone = { exports: () => ({ bus }), mountsOf: () => [{}] };
    assert.equal(ops.attachFile(props, [file], others, rec), false);
    assert.equal(ops.focus(props, [], others, rec), false, 'nor is it a step towards the app\'s message');
    assert.equal(told.length, 2);
    assert.equal(ops.attachFile(props, [file], alone, rec), true, 'with this composer alone, only it can take it');
    assert.equal(ops.focus(props, [], alone, rec), true);
    assert.equal(told.length, 5);
  } finally { if (hadDocument) Object.defineProperty(globalThis, 'document', hadDocument); else delete globalThis.document; }
  told.length = 0;
  // a hidden or inert tab's editor takes no focus: the message would reach whichever has it
  const hidden = { context: { view: { focus: () => told.push(['focused']), hasFocus: () => false } } };
  assert.equal(ops.attachFile(props, [file], { exports: () => ({ bus }) }, hidden), false);
  assert.deepEqual(told, [['focused']], 'nothing told');
  assert.equal(ops.focus(props, [], { exports: () => ({ bus }) }, hidden), false, 'and no step towards the app\'s message');
  told.length = 0;
  const queued = { viewProps: { ...props.viewProps, attachments: { props: { ...tray, attachmentOrder: [] } } } };
  assert.deepEqual(ops.attachFile(queued, [file], { exports: () => ({ bus }) }, rec), { unavailable: 'a queued message is being edited in this composer' }, 'its editor is that message\'s');
  assert.deepEqual(told, []);
  assert.equal(ops.attachImage(props, ['data:image/png;base64,iVBORw0KGgo=', 'qa.png']), true);
  assert.deepEqual([pasted[0][0], pasted[0][1][0].name, pasted[0][1][0].type, pasted[0][1][0].size], ['pasted-images', 'qa.png', 'image/png', 8]);
  assert.deepEqual(ops.attachImage(props, ['data:text/html;base64,PGI+', 'x.html']), { unavailable: 'not an image this composer takes' });
  for (const id of ['image:img-1', 'picked:path:/r/notes.md', 'added:path:/r/drop.txt']) assert.equal(ops.removeAttachment(props, [id]), true);
  assert.deepEqual(removed, [['image', 'img-1'], ['picked', 0], ['added', 0]]);
  assert.deepEqual(ops.removeAttachment(props, ['added:path:/r/other.txt']), { unavailable: 'the attachment is gone' });
  // a file that went is never another one: A goes, B takes its place, A's id still names A (gone), and B is removed by its own
  tray.shownFiles = [{ label: 'b.md', path: '/r/b.md' }];
  assert.deepEqual(ops.removeAttachment(props, ['picked:path:/r/notes.md']), { unavailable: 'the attachment is gone' });
  assert.equal(ops.removeAttachment(props, ['picked:path:/r/b.md']), true);
  assert.deepEqual(removed.at(-1), ['picked', 0]);
  // files the tray names no path for: each by an identity of its own, never its place (two of one name stay apart once the first goes)
  const [x1, x2] = [{ label: 'x.txt' }, { label: 'x.txt' }];
  tray.shownFiles = [x1, x2];
  const [id1, id2] = attachmentsOf(ctx).t1.filter((a) => a.name === 'x.txt').map((a) => a.id);
  assert.notEqual(id1, id2);
  tray.shownFiles = [x2];
  assert.deepEqual(ops.removeAttachment(props, [id1]), { unavailable: 'the attachment is gone' });
  assert.equal(ops.removeAttachment(props, [id2]), true);
  // a queued message edited in it: its tray is that message's, so nothing is read from it or done to it
  tray.attachmentOrder = [];
  assert.deepEqual(attachmentsOf(ctx), {});
  assert.equal(ops.attachImage(props, ['data:image/png;base64,iVBORw0KGgo=', 'qa.png']).unavailable, 'a queued message is being edited in this composer');
  assert.ok(ops.removeAttachment(props, ['image:img-1']).unavailable);
});

test('E8.9k: a settings row presents the Setting its title names on the page the route shows; the mods\' actions follow its control', async () => {
  const { settingsRow } = await import('../present/bindings/settings-row.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const asked = [];
  const ctx = { react: () => React, exports: () => ({}), settingNamed: (title, section) => { asked.push([title, section]); return title === 'Branch prefix' && section === 'git-settings' ? { type: 'Setting', provider: 'codex', id: 'git-branch-prefix' } : null; } };
  const route = { pathname: '/settings/git-settings' };
  const label = React.createElement('Msg', { id: 'settings.git.branchPrefix', defaultMessage: 'Branch prefix' });
  assert.deepEqual(settingsRow.subject({ label }, ctx, route), { type: 'Setting', provider: 'codex', id: 'git-branch-prefix' });
  assert.equal(settingsRow.subject({ label: 'Branch prefix' }, ctx, { pathname: '/settings/codexmods/unit.a' }), null, 'a mod\'s page names none');
  assert.deepEqual(settingsRow.place({}, route), { in: 'SettingsPage', on: { type: 'SettingsSection', provider: 'codex', id: 'git-settings' }, slot: 'rows' });
  assert.equal(settingsRow.place({}, { pathname: '/' }), null);
  const entries = [{ rule: { mod: 'unit.a', id: 'r' }, item: { id: 'x', title: 'Reset', run() {} } }];
  const env = { R: React, ctx };
  const el = settingsRow.slots.trailingActions.apply({ label, control: 'the input' }, entries, env);
  assert.deepEqual(el.control.props.children.slice(0, 1), ['the input']);
  assert.equal(el.control.props.children[1].props['aria-label'], 'Reset');
  const fn = settingsRow.slots.trailingActions.apply({ label, control: (aria) => `switch ${aria.id}` }, entries, env);
  const drawn = fn.control({ id: 'a1' });
  assert.equal(drawn.props.children[0], 'switch a1', 'a control of its aria props keeps them');
  assert.equal(settingsRow.slots.trailingActions.apply({ label, control: 'c' }, [], env).control, 'c', 'no actions: the app\'s own');
});

test('E8.9j: the sidebar\'s filter: the window\'s own, a notice naming the mod with the user\'s "Show all"; groups and lists keep the chats that match', async () => {
  const { sidebar } = await import('../present/bindings/frame.mjs');
  const { sidebarSection, sidebarList } = await import('../present/bindings/sidebar-section.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const keys = new Map(); const touched = [];
  const chats = { a: { title: 'Plan the release', status: 'idle', unread: true }, b: { title: 'Fix the build', preview: 'release notes', status: 'working', unread: false }, c: { title: 'Other', status: 'error', unread: false } };
  const ctx = { react: () => React, exports: () => ({}), local: { read: (k) => keys.set(k, true), touch: (k) => touched.push(k) },
    thread: (key) => { const id = key.startsWith('local:') ? key.slice(6) : key; return chats[id] ? { type: 'CodexThread', provider: 'codex', id } : null; },
    subject: (ref) => ({ ref, state: chats[ref.id] }), modName: (id) => (id === 'unit.a' ? 'Unit A' : id) };
  const factory = (type, p) => React.createElement(type, p);
  const sidebarProps = { sidebarSectionNodes: ['s1'] };
  assert.equal(sidebar.render('Sidebar', sidebarProps, factory, ctx), undefined, 'no filter: the app\'s own');
  const group = (ids) => ({ project: { group: { projectId: 'p1', projectKind: 'local', threadKeys: ids.map((i) => `local:${i}`) } } });
  assert.equal(sidebarSection.render('Section', group(['a', 'b']), factory, ctx), undefined);
  // text: the title or the preview
  assert.equal(sidebar.operations.filter(sidebarProps, ['release', 'unit.a'], ctx), true);
  assert.deepEqual(touched, ['local:filter:Sidebar']);
  const out = sidebar.render('Sidebar', sidebarProps, factory, ctx);
  const [notice, ...rest] = out.props.sidebarSectionNodes;
  assert.deepEqual(rest, ['s1']);
  const drawn = notice.type(notice.props);
  assert.equal(drawn.props.children[0].props.children, 'Chats matching “release”, filtered by Unit A');
  assert.deepEqual(sidebarSection.render('Section', group(['a', 'b', 'c']), factory, ctx).props.project.group.threadKeys, ['local:a', 'local:b']);
  assert.equal(sidebarSection.render('Section', group(['c']), factory, ctx), null, 'a group with no chat that matches is not shown');
  const list = { keys: ['local:a', 'local:c', 'chatgpt:1', 'proj:p1', 'proj:p2'], conversationByKey: new Map([['local:a', { source: 'codex', threadKey: 'local:a' }], ['local:c', { source: 'codex', threadKey: 'local:c' }], ['chatgpt:1', { source: 'chatgpt' }]]),
    projectByKey: new Map([['proj:p1', { source: 'codex', group: { threadKeys: ['local:c', 'local:b'] } }], ['proj:p2', { source: 'codex', group: { threadKeys: ['local:c'] } }]]) };
  assert.deepEqual(sidebarList.render('List', list, factory, ctx).props.keys, ['local:a', 'proj:p1'], 'Codex chats that match, groups that hold one');
  // a chat's state fields, in the one grammar (docs/design/public-hooks.md §3.1)
  sidebar.operations.filter(sidebarProps, [{ status: { $in: ['working', 'error'] } }, null], ctx);
  assert.deepEqual(sidebarSection.render('Section', group(['a', 'b', 'c']), factory, ctx).props.project.group.threadKeys, ['local:b', 'local:c']);
  assert.match(sidebar.render('Sidebar', sidebarProps, factory, ctx).props.sidebarSectionNodes[0].props.text, /^Chats matching status: working or error$/);
  // the user's "Show all" clears it
  const clear = sidebar.render('Sidebar', sidebarProps, factory, ctx).props.sidebarSectionNodes[0];
  clear.type(clear.props).props.children[1].props.onClick();
  assert.equal(sidebar.render('Sidebar', sidebarProps, factory, ctx), undefined);
  assert.equal(sidebarList.render('List', list, factory, ctx), undefined);
});

test('E8.9i: the Window\'s banner is the app\'s page banner, one writer: the title bar writes it (the app\'s content first) while the app\'s own writer stands down', async () => {
  const { windowTitleBar, pageBanner } = await import('../present/bindings/frame.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const PageBanner = function PageBanner() { return null; };
  const page = { pathname: '/local/c1', search: '' }, hidden = { pathname: '/local/c0', search: '' };
  let mounts = { 'window.titlebar': [{ props: {}, scope: { ...page } }], 'page.banner': [{ props: { children: 'app notice' }, scope: { ...page } }, { props: { children: 'a hidden page\'s' }, scope: hidden }] };
  let banners = [];
  const ctx = { react: () => React, exports: () => ({ appShell: { PageBanner } }), mountsOf: (id) => mounts[id] ?? [], subject: () => ({ ref: { type: 'App' } }),
    ruled: (p) => (p === 'Window' ? { regions: { banner: banners } } : null) };
  const factory = (type, p) => React.createElement(type, p);
  const props = windowTitleBar.slots.banner.apply({ hasPageSurface: false }, ['mod notice'], { R: React, ctx });
  const out = windowTitleBar.render('TitleBar', props, factory, ctx, page);
  const [bar, banner] = out.props.children;
  assert.equal('__codexmodsBanner' in bar.props, false, 'the title bar gets its own props only');
  assert.equal(banner.type, PageBanner);
  assert.deepEqual(banner.props.children, ['app notice', 'mod notice'], 'the app\'s content of this page first (not a hidden page\'s, review 4), then the mods\'');
  // the app's writer: its own while no mod has a banner, or where this window has no title bar; null (standing down) otherwise
  assert.equal(pageBanner.render(PageBanner, { children: 'app notice' }, factory, ctx, page), undefined);
  banners = ['mod notice'];
  assert.equal(pageBanner.render(PageBanner, { children: 'app notice' }, factory, ctx, page), null);
  assert.equal(pageBanner.render(PageBanner, { children: 'a hidden page\'s' }, factory, ctx, hidden), undefined, 'another page\'s writer keeps its own');
  mounts = { 'page.banner': [] };
  assert.equal(pageBanner.render(PageBanner, { children: 'app notice' }, factory, ctx, page), undefined, 'no title bar here: the app\'s own');
  // no app writer: the mods' alone
  const alone = windowTitleBar.render('TitleBar', props, factory, ctx, page).props.children[1];
  assert.deepEqual(alone.props.children, 'mod notice');
});

test('graph-layers L3: declared sidebar filters are off until turned on in a window; with several on a chat must pass each; the notice names each; "Show all" turns them all off', async () => {
  const { sidebar } = await import('../present/bindings/frame.mjs');
  const { sidebarSection } = await import('../present/bindings/sidebar-section.mjs');
  const { setDeclaredFilter: setFilter } = await import('../present/bindings/list-filter.mjs');
  const setDeclaredFilter = (c, key, on) => setFilter(c, 'Sidebar', key, on);
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const chats = { a: { title: 'Ticket T-1', status: 'idle' }, b: { title: 'Ticket T-2', status: 'working' }, c: { title: 'Other', status: 'working' } };
  const declared = [
    { mod: 'unit.t', id: 'tickets', kind: 'add', presentation: 'Sidebar', slot: 'filter', order: 1, data: { filter: { title: 'Tickets', where: 'ticket' } } },
    { mod: 'unit.w', id: 'busy', kind: 'add', presentation: 'Sidebar', slot: 'filter', order: 2, data: { filter: { title: 'Working' } }, fns: { filter: { keep: (t) => t.state.status === 'working' } } },
    { mod: 'unit.x', id: 'listed', kind: 'add', presentation: 'Sidebar', slot: 'filter', order: 3, data: { filter: { title: 'Listed', threads: [{ type: 'CodexThread', provider: 'codex', id: 'c' }] } } },
  ];
  const ctx = { react: () => React, exports: () => ({}), local: { read() {}, touch() {} }, declared: () => declared, guard: (rule, fn) => fn,
    thread: (key) => { const id = key.startsWith('local:') ? key.slice(6) : key; return chats[id] ? { type: 'CodexThread', provider: 'codex', id } : null; },
    subject: (ref) => ({ ref, state: chats[ref.id] }), modName: (id) => id.toUpperCase() };
  const factory = (type, p) => React.createElement(type, p);
  const group = (ids) => ({ project: { group: { projectId: 'p1', projectKind: 'local', threadKeys: ids.map((i) => `local:${i}`) } } });
  const keysOf = () => { const out = sidebarSection.render('Section', group(['a', 'b', 'c']), factory, ctx); return out === undefined ? ['all'] : out?.props.project.group.threadKeys ?? []; };
  assert.deepEqual(keysOf(), ['all'], 'declared, none on: the app\'s own');
  setDeclaredFilter(ctx, 'unit.t/tickets', true);
  assert.deepEqual(keysOf(), ['local:a', 'local:b']);
  setDeclaredFilter(ctx, 'unit.w/busy', true);
  assert.deepEqual(keysOf(), ['local:b'], 'each one on keeps it');
  const notice = sidebar.render('Sidebar', { sidebarSectionNodes: ['s1'] }, factory, ctx).props.sidebarSectionNodes[0];
  assert.equal(notice.props.text, 'Tickets (UNIT.T); Working (UNIT.W)');
  setDeclaredFilter(ctx, 'unit.t/tickets', false);
  setDeclaredFilter(ctx, 'unit.x/listed', true);
  assert.deepEqual(keysOf(), ['local:c'], 'working and listed');
  notice.type(notice.props).props.children[1].props.onClick();   // the user's "Show all"
  assert.deepEqual(keysOf(), ['all']);
});

test('H7p review round 2: the chat a window shows is never hidden, named as the lists resolve it (its own ref); another provider\'s of the same id is not it', async () => {
  const { hiddenBy, openChats, sidebarHides } = await import('../present/bindings/sidebar-hides.mjs');
  const declared = [{ mod: 'unit.h', id: 'all', kind: 'add', presentation: 'Sidebar', slot: 'hidden', order: 1, data: { hide: { for: 'Thread' } } }];
  let shown = 'local:c1';
  const ctx = { local: { read() {} }, declared: () => declared, whereEnv: () => ({}), chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : [t]),
    mountsOf: (id) => (id === 'thread.view' ? [{ props: { conversationId: shown } }] : []),
    thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) };
  const parts = sidebarHides(ctx);
  const inst = { ref: { type: 'CodexThread', provider: 'codex', id: 'c1' }, state: { status: 'idle' } };
  assert.equal(hiddenBy(ctx, parts, inst, openChats(ctx)), null, 'shown: never hidden');
  shown = 'local:other';
  assert.equal(hiddenBy(ctx, parts, inst, openChats(ctx)), 'unit.h');
  assert.equal(hiddenBy(ctx, parts, { ref: { type: 'CodexThread', provider: 'codex', id: 'other' }, state: { status: 'idle' } }, openChats(ctx)), null, 'Codex\'s own, shown');
  assert.equal(hiddenBy(ctx, parts, { ref: { type: 'Thread', provider: 'mod.y', id: 'other' }, state: { status: 'idle' } }, openChats(ctx)), 'unit.h', 'another provider\'s of the same id is not the one shown');
});

test('public hooks §3.12: chats and projects a mod hides leave the sidebar\'s lists (never the chat shown, nor one busy), counted in its notice with Show', async () => {
  const { sidebar } = await import('../present/bindings/frame.mjs');
  const { sidebarSection, sidebarList } = await import('../present/bindings/sidebar-section.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const chats = { a: { title: 'Helper 1', status: 'idle' }, b: { title: 'Mine', status: 'idle' }, c: { title: 'Helper 2', status: 'working' }, o: { title: 'Helper 3', status: 'idle' }, d: { title: 'Helper 4', status: 'idle' } };
  const declared = [
    { mod: 'unit.h', id: 'helpers', kind: 'add', presentation: 'Sidebar', slot: 'hidden', order: 1, data: { hide: { for: 'Thread', where: { title: { $prefix: 'Helper' } } } } },
    { mod: 'unit.p', id: 'scratch', kind: 'add', presentation: 'Sidebar', slot: 'hidden', order: 2, data: { hide: { for: 'Project', of: [{ type: 'LocalProject', provider: 'codex', id: 'p2' }] } } },
  ];
  let openChat = 'o';
  const groupMount = (id) => ({ props: { project: { group: { projectId: id, projectKind: 'local' } } } });
  const mounted = { 'sidebar.section': [groupMount('p1'), groupMount('p2'), groupMount('p3')], 'sidebar.list': [{ props: { threadContainerId: 'pinned' } }] };
  const ctx = { react: () => React, exports: () => ({}), local: { read() {}, touch() {} }, declared: (p, slot) => (slot === 'hidden' ? declared : []), guard: (rule, fn) => fn,
    chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : t === 'LocalProject' ? ['LocalProject', 'Project'] : [t]), whereEnv: () => ({}),
    mountsOf: (id) => (id === 'thread.view' ? [{ props: { conversationId: openChat } }] : mounted[id] ?? []),
    thread: (key) => { const id = key.startsWith('local:') ? key.slice(6) : key; return chats[id] ? { type: 'CodexThread', provider: 'codex', id } : null; },
    subject: (ref) => (ref.type === 'LocalProject' ? { ref, state: { name: ref.id } } : { ref, state: chats[ref.id] }), modName: (id) => id.toUpperCase() };
  const factory = (type, p) => React.createElement(type, p);
  const group = (id, ids) => ({ project: { group: { projectId: id, projectKind: 'local', threadKeys: ids.map((i) => `local:${i}`) } } });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sidebarSection.render('Section', group('p1', ['a', 'b', 'c', 'o']), factory, ctx).props.project.group.threadKeys, ['local:b', 'local:c', 'local:o'],
    'the helper left out; the busy one and the one shown stay');
  assert.equal(sidebarSection.render('Section', group('p2', ['b']), factory, ctx), null, 'a project hidden: its group goes whole');
  declared[1].data.hide.of.push({ type: 'LocalProject', provider: 'codex', id: 'p3' });
  assert.equal(sidebarSection.render('Section', group('p3', ['c']), factory, ctx), undefined, 'unless it holds a chat that is busy (or waits for the user, or failed)');
  const conversations = new Map([['k-a', { source: 'codex', threadKey: 'local:a' }], ['k-d', { source: 'codex', threadKey: 'local:d' }], ['k-b', { source: 'codex', threadKey: 'local:b' }]]);
  assert.deepEqual(sidebarList.render('List', { keys: ['k-a', 'k-d', 'k-b'], conversationByKey: conversations, threadContainerId: 'pinned' }, factory, ctx).props.keys, ['k-b']);
  await flush();
  const nodes = sidebar.render('Sidebar', { sidebarSectionNodes: ['s1'] }, factory, ctx).props.sidebarSectionNodes;
  const notices = nodes.filter((n) => n?.props?.mod);
  assert.deepEqual(notices.map((n) => [n.props.mod, n.props.n]), [['unit.h', 2], ['unit.p', 1]], 'a, d (a counted once wherever listed); the project');
  mounted['sidebar.list'] = [];
  await flush();
  const unmounted = sidebar.render('Sidebar', { sidebarSectionNodes: ['s1'] }, factory, ctx).props.sidebarSectionNodes.filter((n) => n?.props?.mod);
  assert.deepEqual(unmounted.map((n) => [n.props.mod, n.props.n]), [['unit.h', 1], ['unit.p', 1]], 'a list no longer shown counts nothing');
  mounted['sidebar.list'] = [{ props: { threadContainerId: 'pinned' } }];
  const drawn = notices[0].type(notices[0].props);
  assert.equal(drawn.props.children[0].props.children, '2 hidden by UNIT.H');
  drawn.props.children[1].props.onClick();   // the user's Show: that mod's hides off in this window
  assert.deepEqual(sidebarSection.render('Section', group('p1', ['a', 'b']), factory, ctx), undefined);
  assert.equal(sidebarSection.render('Section', group('p2', ['b']), factory, ctx), null, 'another mod\'s stay');
  openChat = 'b';
  assert.equal(sidebarSection.render('Section', group('p2', ['b']), factory, ctx), undefined, 'a hidden project\'s group holding the chat shown stays');
  await flush();
  assert.deepEqual(sidebar.render('Sidebar', { sidebarSectionNodes: ['s1'] }, factory, ctx), undefined, 'nothing hidden now: no notice');
});

test('public hooks §3.14: the mods\' starters are a row of the app\'s buttons above the new chat\'s composer, on the home route only', async () => {
  const { newThreadComposer } = await import('../present/bindings/new-thread-view.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const ran = [];
  const declared = [{ mod: 'unit.s', id: 'review', kind: 'add', presentation: 'NewThreadView', slot: 'starters', order: 1,
    data: { starter: { title: 'Review my last commit', in: ['newThread', 'palette'], tooltip: 'a review of HEAD' } }, fns: { items: [{ id: 'review', title: 'Review my last commit', run: (env) => ran.push(env) }] } }];
  const P = { type: 'LocalProject', provider: 'codex', id: 'p1' }, W = { type: 'Window', provider: 'codexmods.windows', id: '2' };
  let loaded = true;
  const ctx = { react: () => React, exports: () => ({}), declared: (p, slot) => (p === 'NewThreadView' && slot === 'starters' ? declared : []), guard: (rule, fn) => fn, token: () => null,
    subject: (ref) => (loaded && ref.id === 'new:app:new-conversation' ? { ref, state: { target: { project: P } } } : undefined), windowRef: () => W };
  const factory = (type, p) => React.createElement(type, p);
  assert.equal(newThreadComposer.render('Composer', { aboveComposerContent: null }, factory, ctx, { routeKind: 'local-thread' }), undefined, 'a chat that is starting: none');
  const out = newThreadComposer.render('Composer', { aboveComposerContent: 'app' }, factory, ctx, { routeKind: 'home' });
  const row = [].concat(out.props.aboveComposerContent.props.children).at(-1);
  assert.equal(row.props['data-codexmods'], 'starters');
  const [button] = [].concat(row.props.children);
  const drawn = typeof button.type === 'function' ? button.type(button.props) : button;
  const click = drawn?.props?.onClick ?? button.props.onClick;
  click?.();
  assert.deepEqual(ran, [{ draft: { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, window: W, project: P }], 'this window and the new chat\'s project, as the framework reads them');
  click?.();
  assert.notEqual(ran[0], ran[1], 'each run its own env');
  assert.equal(Object.isFrozen(ran[0]) && Object.isFrozen(ran[0].project), true, 'frozen: no mod\'s code changes what another\'s run is given');
  // the Draft not here yet: its project is not known, so no starter runs
  loaded = false;
  const waiting = [].concat(newThreadComposer.render('Composer', { aboveComposerContent: 'app' }, factory, ctx, { routeKind: 'home' }).props.aboveComposerContent.props.children).at(-1);
  const [off] = [].concat(waiting.props.children);
  assert.equal(off.props.disabled, true);
  loaded = true;
  declared[0].data.starter.in = ['palette'];
  assert.equal(newThreadComposer.render('Composer', { aboveComposerContent: 'app' }, factory, ctx, { routeKind: 'home' }), undefined, 'offered elsewhere only: not here');
  declared.length = 0;
  assert.equal(newThreadComposer.render('Composer', { aboveComposerContent: 'app' }, factory, ctx, { routeKind: 'home' }), undefined, 'none declared: the app\'s own');
});

test('public hooks §3.12: a command a mod hides is not drawn in the palette; the counts say how many each mod hides; Show draws them again here', async () => {
  const { paletteCommand } = await import('../present/bindings/palette-result.mjs');
  const { hiddenCommandCounts, showHiddenCommands, onHiddenCommands } = await import('../present/bindings/palette-hides.mjs');
  const declared = [{ mod: 'unit.c', id: 'nochat', kind: 'add', presentation: 'Palette', slot: 'hidden', order: 1, data: { hide: { for: 'Command', where: { title: { $prefix: 'New' } } } } }];
  const ctx = { local: { read() {}, touch() {} }, declared: (p, slot) => (p === 'Palette' && slot === 'hidden' ? declared : []), chainOf: (t) => [t], whereEnv: () => ({}), subject: () => undefined };
  let told = 0;
  onHiddenCommands(ctx, () => { told++; });
  let mount = 0;
  const row = (id, title, n = ++mount) => paletteCommand.render('Row', { command: { id, title } }, (t, p) => ({ t, p }), ctx, null, null, { n });
  assert.deepEqual([row('newChat', 'New chat'), row('newWindow', 'New window'), row('settings', 'Settings')], [null, null, undefined], 'as the row gives it (the graph holds no Command): its title');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hiddenCommandCounts(ctx, [1, 2, 3]), [['unit.c', 2, ['New chat', 'New window']]], 'with their terms: the notice row is offered where they would have matched');
  assert.deepEqual(hiddenCommandCounts(ctx, [1]), [['unit.c', 1, ['New chat']]], 'a row no longer mounted (the palette closed, the command unavailable) counts nothing');
  row('newChat', 'New chat here', 4);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hiddenCommandCounts(ctx, [1, 4]), [['unit.c', 1, ['New chat', 'New chat here']]], 'one command drawn twice: counted once, found by both rows\' terms');
  assert.deepEqual(hiddenCommandCounts(ctx, [4]), [['unit.c', 1, ['New chat here']]], 'the other row gone: its terms with it');
  assert.ok(told >= 1, 'the palette\'s own sections are told');
  showHiddenCommands(ctx, 'unit.c');
  assert.equal(row('newChat', 'New chat'), undefined, 'shown in this window');
  assert.deepEqual(hiddenCommandCounts(ctx, [1]), []);
});

test('public hooks §3.13: a thread\'s summary is how its sidebar row and its header read: the first title given, the title its list row shows, the header\'s title', async () => {
  const { sidebarRowTitle } = await import('../present/bindings/frame.mjs');
  const rowSlots = sidebarRowTitle.twins[0].slots;
  const near = { binding: 'sidebar.row', props: { conversationId: 't1' } };
  assert.deepEqual(sidebarRowTitle.twins[0].subject({ title: 'x' }, { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }) }, null, near), { type: 'CodexThread', provider: 'codex', id: 't1' }, 'its chat: the sidebar row it is drawn in');
  assert.equal(sidebarRowTitle.twins[0].subject({ title: 'x' }, { thread: () => null }, null, null), null, 'a list row elsewhere: none');
  const { threadHeader } = await import('../present/bindings/thread-header.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const entries = (...items) => items.map((item, i) => ({ rule: { mod: 'm', id: `s${i}` }, item }));
  const row = rowSlots.summary.apply({ conversationId: 't1' }, entries(null, { title: ' [T-1] Fix login ' }, 'later'));
  assert.equal(row.title, '[T-1] Fix login', 'the first title given, trimmed: the title the list row shows');
  assert.equal(rowSlots.summary.apply({ title: 'Own' }, entries({ subtitle: 'no title' })).title, 'Own', 'no title given: the row as it was');
  assert.equal(rowSlots.summary.apply({ title: 'Fix login', ariaLabel: 'Open Fix login' }, entries('[T-1] Fix login')).ariaLabel, 'Open [T-1] Fix login', 'its accessible name reads the same');
  const header = threadHeader.slots.summary.apply({ title: 'Fix login' }, entries('[T-1] Fix login'));
  assert.equal(header.title, '[T-1] Fix login');
  const factory = (type, p) => React.createElement(type, p);
  const out = threadHeader.render('Title', header, factory, { react: () => React });
  const [title] = [].concat(out.props.children);
  assert.equal(title.props.title, '[T-1] Fix login', 'the app\'s title shows the summary');
});

test('public hooks §3.13: the agent\'s message and its turn take badges in their action row, after the actions', async () => {
  const { agentMessage } = await import('../present/bindings/message-block.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const env = { R: React, ctx: { token: () => null, exports: () => ({}) } };
  const entries = (...items) => items.map((item, i) => ({ rule: { mod: 'm', id: `b${i}` }, item }));
  const msg = agentMessage.slots.badges.apply({ additionalActions: ['copy'] }, entries({ id: 'c', text: 'cited' }), env);
  assert.equal(msg.additionalActions.length, 2, 'after the app\'s own');
  const turn = agentMessage.twins[0].slots.badges.apply({ trailingActions: null }, entries({ id: 't', text: '12s' }), env);
  assert.ok(turn.trailingActions, 'the turn\'s badge in the row\'s end');
});

test('public hooks §3.13: a project\'s group reads as its summary says, its labels after its name, its badges beside its actions', async () => {
  const { sidebarSection } = await import('../present/bindings/sidebar-section.mjs');
  const { sectionActions } = await import('../present/bindings/frame.mjs');
  const entries = (...items) => items.map((item, i) => ({ rule: { mod: 'm', id: `p${i}` }, item }));
  const props = { project: { group: { projectId: 'p1', projectKind: 'local', label: 'repo', threadKeys: [] } } };
  const named = sidebarSection.slots.summary.apply(props, entries({ title: 'Repo (prod)' }));
  assert.equal(named.project.group.label, 'Repo (prod)');
  assert.equal(sidebarSection.slots.label.apply(named, entries('main', { text: '3 open' })).project.group.label, 'Repo (prod) · main · 3 open');
  assert.equal(props.project.group.label, 'repo', 'the app\'s own props never changed');
  assert.ok(sectionActions.twins[0].slots.badges, 'its badges beside its header\'s actions');
});

test('graph-layers L2 (built review, round 2): the composer reads its live editor and writes only when it holds what was expected', async () => {
  const { composer } = await import('../present/bindings/composer.mjs');
  let docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mine' }] }] };
  const set = [];
  const controller = { setText: (t) => { set.push(t); docJson = { type: 'doc', content: [{ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }] }; }, view: { state: { get doc() { return { toJSON: () => docJson }; } } } };
  const rec = { context: controller };
  assert.deepEqual(composer.operations.setTextIf({}, ['', 'theirs'], {}, rec), { unavailable: 'changed: the draft holds something else now' }, 'it holds the user\'s text: not written');
  assert.deepEqual(set, []);
  assert.equal(composer.operations.setTextIf({}, ['mine', 'theirs'], {}, rec), true);
  assert.equal(composer.operations.textIs({}, ['theirs'], {}, rec), true);
  docJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'theirs' }, { type: 'mention', attrs: { label: 'file.txt' } }] }] };
  assert.deepEqual(composer.operations.textIs({}, ['theirs'], {}, rec), { unavailable: 'changed: the draft holds something else now' }, 'a mention added is a change');
  assert.equal(composer.operations.textIs({}, ['x'], {}, { context: { setText() {} } }), false, 'an editor that cannot be read: not this binding\'s to say');
});

test('H6m3b: a composer\'s user attaches (picker, paste, drop) are their Draft.attach of the composer nearest where they acted, held while something holds it (answered at once with a promise, attached once let go, never when refused); the app\'s own attaches pass', async () => {
  const k = fakeKernel(['composer']);
  let holdsSink = null;
  const asked = [], done = [];
  let answer = { go: true, token: 't1' };
  const present = {
    holds: (fn) => { holdsSink = fn; return { dispose() {} }; },
    hold: async (ref, operation, args) => { asked.push([ref.id, operation, args]); return answer; },
    done: async (token, outcome) => { done.push([token, outcome.status]); },
    did: async () => {},
  };
  // two composers: the home page's new chat and the side panel's (their editors in two places of the page)
  const node = (parent) => ({ parentElement: parent, contains(x) { for (let n = x; n; n = n.parentElement) if (n === this) return true; return false; } });
  const body = node(null), main = node(body), side = node(body), mainEditor = node(main), sideEditor = node(side), sideButton = node(side);
  k.store.mounted = () => [
    { binding: 'composer', props: {}, scope: { kind: 'new', entrypoint: 'home' }, context: { view: { dom: mainEditor } } },
    { binding: 'composer', props: {}, scope: { kind: 'new', entrypoint: 'panel' }, context: { view: { dom: sideEditor } } },
  ];
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [composer], present });
  const ran = [];
  const methods = { addFiles: (files) => { ran.push(['files', files.length]); return true; }, addImageDataUrls: () => { ran.push(['data']); return true; } };
  // nothing holds it: the app's own at once, its answer kept
  const plain = k.store.attach(methods, {}, { target: { nodeType: 1, ...sideButton } });
  assert.equal(plain.addFiles([{ name: 'a.txt' }]), true);
  holdsSink({ held: ['Draft.attach'], observed: [] });
  // held: the side panel's composer (nearest the press), answered at once with a promise, attached once let go
  const m = k.store.attach(methods, {}, { target: sideButton });
  const r = m.addFiles([{ name: 'secret.env', fsPath: '/repo/secret.env', size: 3 }]);
  assert.equal(typeof r?.then, 'function');
  assert.equal(ran.length, 1);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(asked, [['new:app:panel-new-conversation', 'attach', [{ via: 'addFiles', files: [{ name: 'secret.env', path: '/repo/secret.env', size: 3 }] }]]]);
  assert.deepEqual([ran.at(-1), done], [['files', 1], [['t1', 'done']]]);
  // refused: not attached; the app's own attaches (data it adds) are not held
  answer = { go: false, message: 'no env files' };
  k.store.attach(methods, {}, { target: mainEditor }).addFiles([{ name: '.env' }]);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual([asked.at(-1)[0], ran.length], ['new:app:new-conversation', 2]);
  assert.equal(m.addImageDataUrls(), true);
  assert.deepEqual(ran.at(-1), ['data']);
  // the factory's own scope names its Draft first (built review round 1: a side chat's picker after its gesture expired), and every file
  // reaches the policies; the composer's generation changed while it waited: not attached
  answer = { go: true, token: 't2' };
  const generation = { current: 1 };
  const scoped = k.store.attach(methods, { scope: { value: { kind: 'new', entrypoint: 'panel' } }, attachmentGeneration: generation }, { target: null });
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt` }));
  const settled = scoped.addFiles(many);
  generation.current = 2;
  await new Promise((res) => setImmediate(res));
  assert.deepEqual([asked.at(-1)[0], asked.at(-1)[2][0].files.length], ['new:app:panel-new-conversation', 60]);
  assert.equal(await settled, false, 'the generation changed: not attached, its promise says so');
  // let go, its own failure is the promise's (built review round 2: the caller's catch hears it)
  const failing = k.store.attach({ addFiles: () => Promise.reject(new Error('could not read')) }, {}, { target: null });
  await assert.rejects(failing.addFiles([{ name: 'a.txt' }]), /could not read/);
  assert.equal(ran.length, 3);
  p.dispose();
  assert.equal(k.store.attach, null);
});

test('H6m4: the review panel\'s git actions are the user\'s GitRepository.stage / unstage or Repository.discard (their files) of the repository its folder names, held while something holds them; anything else the app\'s own', async () => {
  const k = fakeKernel([]);
  let holdsSink = null;
  const asked = [];
  let answer = { go: true, token: 't1' };
  const present = { holds: (fn) => { holdsSink = fn; return { dispose() {} }; },
    hold: async (ref, operation, args) => { asked.push([ref, operation, args]); return answer; }, done: async () => {}, did: async () => {} };
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [], present });
  const ran = [];
  const run = (what) => () => { ran.push(what); return Promise.resolve(what); };
  const arg = (action, scope, extra = {}) => ({ cwd: '/repo', params: { action, scope, path: 'src/a.js', hunkIndex: 0 }, reviewFiles: [{ path: 'src/a.js' }, { path: 'b.txt' }], stageFilter: 'unstaged', ...extra });
  // nothing holds it: the app's own at once, its answer kept
  assert.equal(await k.store.reviewAction(arg('stage', 'file'), run('s1')), 's1');
  holdsSink({ held: ['Repository.stage', 'Repository.unstage', 'Repository.discard'], observed: [] });
  const pending = k.store.reviewAction(arg('revert', 'hunk', { stageFilter: 'staged' }), run('r1'));
  assert.deepEqual(ran, ['s1'], 'held: not run yet, the panel kept busy');
  assert.equal(await pending, 'r1', 'its answer once let go');
  assert.deepEqual(asked.at(-1), [{ type: 'Repository', cwd: '/repo' }, 'discard', [['src/a.js'], 'staged']]);
  assert.deepEqual(ran, ['s1', 'r1']);
  // another host's review: the app's own
  assert.equal(k.store.reviewAction({ ...arg('stage', 'file'), hostConfig: { id: 'ssh:box' } }, run('x')), undefined);
  await k.store.reviewAction(arg('unstage', 'section'), run('u1'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.at(-1).slice(1), ['unstage', [['src/a.js', 'b.txt']]], 'a section: its files');
  answer = { go: false, message: 'no' };
  await k.store.reviewAction(arg('stage', 'file'), run('s2'));
  await new Promise((r) => setImmediate(r));
  assert.equal(ran.includes('s2'), false, 'refused: not done');
  // another action, no folder, no file: the app's own
  assert.equal(k.store.reviewAction({ ...arg('other', 'file') }, run('x')), undefined);
  assert.equal(k.store.reviewAction({ ...arg('stage', 'file'), cwd: '' }, run('x')), undefined);
  assert.equal(k.store.reviewAction({ ...arg('stage', 'section'), reviewFiles: [] }, run('x')), undefined);
  // a pull request the user creates: their Branch.openPullRequest of the branch named by the folder and its name; refused, a reason the
  // page throws; a mod's own, its url; the browser's form and another host's: the app's own
  holdsSink({ held: ['Branch.openPullRequest'], observed: [] });
  answer = { go: false, message: 'frozen' };
  const pr = { cwd: '/repo', hostId: 'local', headBranch: 'feat', baseBranch: 'main', isDraft: true, source: 'github-connector' };
  assert.deepEqual(await k.store.pullRequestCreate(pr), { refused: 'No pull request: frozen' });
  assert.deepEqual(asked.at(-1), [{ type: 'Branch', cwd: '/repo', name: 'feat' }, 'openPullRequest', [{ base: 'main', draft: true }]]);
  answer = { go: false, handled: true, value: { type: 'GitHubPullRequest', provider: 'codex', id: 'https://github.com/o/r/pull/12' } };
  assert.deepEqual(await k.store.pullRequestCreate(pr), { handled: { url: 'https://github.com/o/r/pull/12', number: 12 } });
  answer = { go: true, token: 't9' };
  assert.equal(await k.store.pullRequestCreate(pr), undefined, 'let go: the app\'s own route');
  const count = asked.length;
  assert.equal(k.store.pullRequestCreate({ ...pr, openInBrowser: true }), undefined);
  assert.equal(k.store.pullRequestCreate({ ...pr, hostId: 'ssh:box' }), undefined);
  assert.equal(asked.length, count);
  p.dispose();
  assert.equal(k.store.reviewAction, null);
});

/** The page's user actions over a fake Host (its hold, done, did and holds), for the bindings that carry the user's own actions. */
async function fakeUserActions(held, answerOf) {
  const { createUserActions } = await import('../present/user-action.mjs');
  const log = { holds: [], done: [], did: [] };
  let tellHolds = () => {};
  const present = {
    holds: (fn) => { tellHolds = fn; fn({ held, observed: ['CommandApproval.deny'] }); return { dispose() {} }; },
    hold: async (ref, op, args, opts) => { log.holds.push([ref.id, op, args, opts]); return { token: `t${log.holds.length}`, ...answerOf() }; },
    done: async (token, outcome) => { log.done.push([token, outcome.status]); return true; },
    did: async (ref, op, args, outcome) => { log.did.push([ref.id, op, outcome.status]); return true; },
  };
  return { ...createUserActions(present), log, set: (m) => tellHolds(m) };
}

test('public hooks H6 (§3.5): the user\'s own answer on a request card is held first, as the answer with the option the button stands for; a refusal keeps the card with the reason; a go runs the app\'s own; a narrower change runs the card\'s answer for it, said', async () => {
  const { requestShell } = await import('../present/bindings/request-body.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const req = { type: 'CommandApproval', provider: 'codex', id: 'x:s:9' };
  // the request's own options (graph-integrity G1.6): each card button is the answer with one of them
  const options = [{ id: 'accept', label: 'Allow once', kind: 'approve', scope: 'once' }, { id: 'acceptForSession', label: 'Allow for this chat', kind: 'approve', scope: 'thread' },
    { id: 'acceptWithExecpolicyAmendment', label: 'Always', kind: 'approve', scope: 'always' }, { id: 'decline', label: 'No', kind: 'deny' }];
  const ran = [];
  let answer = { go: false, message: 'Never on Fridays (“No Friday runs”, a policy of qa.team)' };
  const touched = [];
  const ua = await fakeUserActions(['CommandApproval.answer'], () => answer);
  const holds = ua.log.holds;
  const ctx = { react: () => ({ ...R, useContext: () => req }),
    subject: (ref) => ({ ref, state: ref.type === 'Mod' && ref.id === 'qa.team' ? { name: 'QA team' } : ref.id === req.id ? { options } : {}, links: {} }),
    ruled: () => ({ regions: {}, actions: [] }), token: () => 'grey', local: { read() {}, touch: (k) => touched.push(k) }, userAction: ua.userAction };
  const actions = { onApprove: (t) => ran.push(['approve', t]), onDeny: () => ran.push(['deny']), scopedApproveAction: { label: 'For this chat', onClick: () => ran.push(['thread']) }, leadingAction: { label: 'Always', onClick: () => ran.push(['always']) } };
  const render = () => requestShell.render('Shell', { title: 'Run it?', actions, body: 'cmd' }, (t, p) => ({ t, p }), ctx);
  let out = render();
  out.p.actions.onApprove(42);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(holds, [['x:s:9', 'answer', ['accept'], { changes: true }]]);
  assert.deepEqual(ran, [], 'refused: the app\'s own answer never ran');
  assert.ok(touched.length, 'the card is told to draw again');
  out = render();
  const note = [].concat(out.p.body.props?.children ?? []).find((x) => x?.props?.['data-codexmods-refused'] !== undefined);
  assert.deepEqual([note.props.children, note.props.style.color], ['Not sent: Never on Fridays (“No Friday runs”, a policy of qa.team)', 'grey']);
  // a decline is an answer too: held like the others
  answer = { go: true, args: ['decline'] };
  out.p.actions.onDeny();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ran, [['deny']]);
  answer = { go: true, args: ['acceptForSession'] };
  out.p.actions.scopedApproveAction.onClick(7);
  await new Promise((r) => setTimeout(r, 0));
  answer = { go: true, args: ['acceptWithExecpolicyAmendment'] };
  out.p.actions.leadingAction.onClick(8);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(holds.slice(1).map(([, op, args]) => [op, args]), [['answer', ['decline']], ['answer', ['acceptForSession']], ['answer', ['acceptWithExecpolicyAmendment']]]);
  assert.deepEqual(ran, [['deny'], ['thread'], ['always']]);
  assert.deepEqual([ua.log.done, ua.log.did], [[['t2', 'done'], ['t3', 'done'], ['t4', 'done']], []], 'the Host is told what each did');
  assert.deepEqual([out.p.actions.scopedApproveAction.label, out.p.actions.leadingAction.label], ['For this chat', 'Always'], 'the app\'s own labels kept');
  assert.equal([].concat(render().p.body ?? []).flat().some((x) => x?.props?.['data-codexmods-refused'] !== undefined), false, 'a later answer that went clears the note');
  // a mod's policy narrowed "always" to once: the card's own Allow once runs, and the card says who changed it
  answer = { go: true, args: ['accept'], changedBy: [{ mod: 'qa.team', policy: 'Only once' }] };
  render().p.actions.leadingAction.onClick(9);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ran.at(-1), ['approve', 9]);
  const changed = [].concat(render().p.body.props?.children ?? []).find((x) => x?.props?.['data-codexmods-refused'] !== undefined);
  assert.equal(changed.props.children, 'Changed by QA team (Only once)', 'the mod by its name');
  const { answerChangedBy } = await import('../present/bindings/request-body.mjs');
  assert.equal(answerChangedBy(req), 'Changed by QA team (Only once)', 'said again on its step\'s row once the card is gone');
  // nothing holds it any more: the app's own at once
  ua.set({ held: [], observed: [] });
  render().p.actions.onApprove(1);
  assert.deepEqual(ran.at(-1), ['approve', 1]);
});

test('public hooks H6 (§3.5): a new chat\'s send, by its Send button or its Enter key, is held as the user\'s Draft.send; a refusal keeps the text with the reason; a chat\'s own sends are left to the mux', async () => {
  const { composer } = await import('../present/bindings/composer.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React: R } = createFakeReact();
  const ran = [], touched = [];
  let answer = { go: false, message: 'Not on main (“Worktrees only”, a policy of qa.team)' };
  const ua = await fakeUserActions(['Draft.send'], () => answer);
  const holds = ua.log.holds;
  const ctx = { react: () => R, thread: () => null, token: () => 'grey', local: { read() {}, touch: (k) => touched.push(k) }, exports: () => ({}), userAction: ua.userAction };
  const scope = { kind: 'new', entrypoint: 'home', homeDraftKey: 'new-conversation' };
  const props = { handleSubmit: () => ran.push('button'), viewProps: { editor: { onSubmit: (e) => ran.push(['enter', e]), placeholder: 'x' } } };
  const render = () => composer.render('Footer', props, (t, p) => ({ t, p }), ctx, scope);
  let out = render();
  out.p.handleSubmit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([holds, ran], [[['new:app:new-conversation', 'send', [], { changes: false }]], []], 'a change cannot be carried out here: the Host refuses one');
  // a composer with its editor: the send names what it sends, the editor's text as it is then (reference-mods.md RM8)
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it' }] }] };
  const live = { ...props, viewProps: { editor: { ...props.viewProps.editor, composerController: { view: { state: { doc: { toJSON: () => doc } } } } } } };
  const shown = composer.render('Footer', live, (t, p) => ({ t, p }), ctx, scope);
  (shown.p ? shown : [].concat(shown.props?.children ?? []).find((x) => x?.p)).p.handleSubmit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(holds.pop(), ['new:app:new-conversation', 'send', [{ content: { parts: [{ kind: 'text', text: 'Ship it' }] } }], { changes: false }]);
  out = render();
  const kids = [].concat(out.props?.children ?? []);
  const note = kids.find((x) => x?.props?.['data-codexmods-refused'] !== undefined);
  assert.equal(note.props.children, 'Not sent: Not on main (“Worktrees only”, a policy of qa.team)');
  answer = { go: true, args: [] };
  const footer = kids.find((x) => x?.t === 'Footer');
  footer.p.viewProps.editor.onSubmit('E');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ran, [['enter', 'E']]);
  assert.equal(footer.p.viewProps.editor.placeholder, 'x', 'the rest of the editor\'s props kept');
  // a chat's composer: its sends are held at the mux (turn/start), not here
  const chat = composer.render('Footer', props, (t, p) => ({ t, p }), { ...ctx, thread: () => null }, { kind: 'local', placement: 'main', conversationId: 'c1' });
  assert.equal(chat, undefined);
});

test('public hooks §3.14: a mod\'s notification is the app\'s own toast, its mod named under it, its first two actions its buttons; what the user did goes back; its end closes it', () => {
  const k = fakeKernel([]);
  const shown = [], answers = [];
  let closed = 0;
  k.exports.toast = { get: () => ({ info: (title, opts) => { shown.push([title, opts]); return { close: () => { closed++; opts.onRemove?.(); } }; } }) };
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [], instances: { noticeAnswer: (gen, id, outcome) => answers.push([gen, id, outcome]) } });
  p.ask({ t: 'notice', id: 'unit.a:n1', token: '1', gen: 3, requester: { id: 'unit.a', name: 'Unit A' }, from: 'Unit A (unit.a)', title: 'Synced', body: '3 files', kind: 'info', actions: [{ id: 'undo', title: 'Undo' }] });
  const [title, opts] = shown[0];
  assert.deepEqual([title, opts.description, opts.id, opts.primaryAction.label, opts.secondaryAction], ['Synced', 'Unit A (unit.a)\n3 files', 'codexmods:unit.a:n1', 'Undo', undefined], 'who sent it first');
  opts.primaryAction.onClick();
  assert.deepEqual(answers, [[3, 'unit.a:n1', { action: 'undo', token: '1' }], [3, 'unit.a:n1', { gone: true, token: '1' }]], 'the action, then it closed');
  p.ask({ t: 'notice', id: 'unit.a:n2', token: '2', gen: 3, requester: { id: 'unit.a', name: 'Unit A' }, from: 'Unit A (unit.a)', title: 'Later', body: '', kind: 'info', sticky: true, actions: [] });
  assert.equal(shown[1][1].duration, 0, 'sticky: until it is closed');
  p.ask({ t: 'noticeEnd', id: 'unit.a:n2', token: '9' });
  assert.equal(closed, 1, 'another showing\'s end does not close this one');
  p.ask({ t: 'noticeEnd', id: 'unit.a:n2', token: '2' });
  assert.equal(closed, 2);
  assert.equal(answers.length, 2, 'ended by the Host: not told back');
  k.exports.toast = undefined;
  p.ask({ t: 'notice', id: 'unit.a:n3', token: '3', gen: 3, requester: { id: 'unit.a', name: 'Unit A' }, title: 'Nowhere', body: '', kind: 'info', actions: [] });
  assert.deepEqual(answers.at(-1), [3, 'unit.a:n3', { gone: true, token: '3' }], 'no toast here: it went at once');
  p.dispose();
});

test('public hooks §3.12: a record of the agent\'s a mod hides is a one-line stub, "Hidden by <mod>" with Show, which draws it again in this window', async () => {
  const k = fakeKernel(['step']);
  const { createFakeReact } = await import('./fake-react.mjs');
  k.exports.react = createFakeReact().React;
  const ref = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const g = fakeGraph({ t1: thread('t1', 'First') });
  const step = defineBinding({ id: 'step', presentation: 'StepBlock', presents: ['Thread'], subject: () => ref });
  const p = startPresentation({ kernel: k, graph: g, bindings: [step] });
  const render = k.store.renderers.get('step');
  render('Orig', { x: 1 }, factory);
  await tick(); await tick(); await tick();
  p.rules.put({ mod: 'unit.h', id: 'h', kind: 'hide', presentation: 'StepBlock', realm: 'renderer', order: 1 });
  render('Orig', { x: 1 }, factory);
  await tick(); await tick(); await tick();
  const stub = render('Orig', { x: 1 }, factory);
  assert.equal(stub?.props?.['data-codexmods-hidden'], 'unit.h', JSON.stringify(stub)?.slice(0, 300));
  const [said, show] = [].concat(stub.props.children);
  assert.equal(said, 'Hidden by unit.h');
  show.props.onClick();
  assert.equal(render('Orig', { x: 1 }, factory)?.type ?? 'Orig', 'Orig', 'shown: the app\'s own again');
  p.dispose();
});

test('public hooks §3.12: a record under way (running, waiting for you) is never hidden', async () => {
  const k = fakeKernel(['step']);
  const { createFakeReact } = await import('./fake-react.mjs');
  k.exports.react = createFakeReact().React;
  const ref = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const g = fakeGraph({ t1: { ...thread('t1', 'Now'), state: { title: 'Now', status: 'waitingForYou' } } });
  const step = defineBinding({ id: 'step', presentation: 'StepBlock', presents: ['Thread'], subject: () => ref });
  const p = startPresentation({ kernel: k, graph: g, bindings: [step] });
  const render = k.store.renderers.get('step');
  render('Orig', { x: 1 }, factory);
  await tick(); await tick(); await tick();
  p.rules.put({ mod: 'unit.h', id: 'h', kind: 'hide', presentation: 'StepBlock', realm: 'renderer', order: 1 });
  render('Orig', { x: 1 }, factory);
  await tick(); await tick();
  const out = render('Orig', { x: 1 }, factory);
  assert.equal(out?.props?.['data-codexmods-hidden'], undefined, 'it waits for the user: shown');
  p.dispose();
});

test('public hooks §3.12: a transcript filter on in this window leaves out the records it does not keep (they keep their place), never one under way; off: drawn again', async () => {
  const k = fakeKernel(['step']);
  const { createFakeReact } = await import('./fake-react.mjs');
  k.exports.react = createFakeReact().React;
  const refOf = (id) => ({ type: 'TestAgentThread', provider: 'qa.test-agent', id });
  const g = fakeGraph({ t1: thread('t1', 'Noise'), t2: thread('t2', 'Keep'), t3: { ...thread('t3', 'Noise'), state: { title: 'Noise', status: 'inProgress' } } });
  let id = 't1';
  const step = defineBinding({ id: 'step', presentation: 'StepBlock', presents: ['Thread'], subject: () => refOf(id) });
  const p = startPresentation({ kernel: k, graph: g, bindings: [step] });
  const render = k.store.renderers.get('step');
  const drawn = async (which) => { id = which; render('Orig', { x: 1 }, factory); await tick(); await tick(); await tick(); const out = render('Orig', { x: 1 }, factory); return out?.type?.name === 'Hidden' ? 'left out' : 'drawn'; };
  await drawn('t1');
  p.rules.put({ mod: 'unit.f', id: 'calm', kind: 'add', presentation: 'ThreadView', slot: 'filter', realm: 'host', order: 1, data: { filter: { title: 'Calm', for: 'TestAgentThread', where: { title: 'Keep' } } } });
  assert.equal(await drawn('t1'), 'drawn', 'declared, not on: the app\'s own');
  assert.equal(p.filterOn('unit.f', 'calm', true), true);
  assert.deepEqual([await drawn('t1'), await drawn('t2'), await drawn('t3')], ['left out', 'drawn', 'drawn'], 'kept; under way: drawn whatever it is');
  assert.equal(p.filterOn('unit.f', 'nope', true), false, 'no filter by that id');
  p.rules.put({ mod: 'unit.g', id: 'msgs', kind: 'add', presentation: 'ThreadView', slot: 'filter', realm: 'host', order: 2, data: { filter: { title: 'Messages', where: { title: 'Nothing' } } } });
  assert.equal(p.filterOn('unit.g', 'msgs', true), true);
  assert.equal(await drawn('t2'), 'drawn', 'a filter of steps and messages (no for) does not test another type of record');
  p.filterOn('unit.f', 'calm', false);
  assert.equal(await drawn('t1'), 'drawn', 'off: drawn again');
  p.dispose();
});

test('public hooks §3.12 (review, round 2): a filter\'s keep is asked once about an item as it is, however many lists ask', async () => {
  const { keepsItem } = await import('../present/bindings/list-filter.mjs');
  const asked = [];
  const part = { key: 'unit.b/spy', reg: 'r1', by: 'unit.b', reads: undefined, where: null, for: null, keep: (x) => { asked.push(x.ref.id); return true; } };
  const ctx = { chainOf: (t) => [t], whereEnv: () => ({}) };
  const a = { ref: { type: 'CodexThread', provider: 'codex', id: 'a' }, state: { title: 'A' } };
  keepsItem(ctx, [part], a);
  keepsItem(ctx, [part], a);
  assert.deepEqual(asked, ['a'], 'the projects\' list, then its group: asked once');
  keepsItem(ctx, [part], { ...a, state: { title: 'A2' } });
  keepsItem(ctx, [{ ...part, reg: 'r2' }], a);
  assert.deepEqual(asked, ['a', 'a', 'a'], 'a new snapshot, or the filter registered again: asked again');
});

test('public hooks §3.12 (review): a filter disposed is forgotten: one declared later under its id starts off; an update keeps it on', async () => {
  const k = fakeKernel(['step']);
  const { createFakeReact } = await import('./fake-react.mjs');
  k.exports.react = createFakeReact().React;
  const ref = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const g = fakeGraph({ t1: thread('t1', 'Noise') });
  const step = defineBinding({ id: 'step', presentation: 'StepBlock', presents: ['Thread'], subject: () => ref });
  const p = startPresentation({ kernel: k, graph: g, bindings: [step] });
  const render = k.store.renderers.get('step');
  const drawn = async () => { render('Orig', { x: 1 }, factory); await tick(); await tick(); await tick(); return render('Orig', { x: 1 }, factory)?.type?.name === 'Hidden' ? 'left out' : 'drawn'; };
  const rule = (title) => ({ mod: 'unit.f', id: 'calm', kind: 'add', presentation: 'ThreadView', slot: 'filter', realm: 'host', order: 1, data: { filter: { title, for: 'TestAgentThread', where: { title: 'Keep' } } } });
  await drawn();
  p.rules.put(rule('Calm'));
  p.filterOn('unit.f', 'calm', true);
  assert.equal(await drawn(), 'left out');
  p.rules.put(rule('Calm 2'));
  assert.equal(await drawn(), 'left out', 'registered again in place (an update): still on');
  p.rules.remove('unit.f/calm');
  p.rules.put(rule('Calm'));
  assert.equal(await drawn(), 'drawn', 'disposed, then declared again: off until turned on');
  p.filterOn('unit.f', 'calm', true);
  p.rules.reset([]);
  p.rules.put(rule('Calm'));
  assert.equal(await drawn(), 'drawn', 'the window\'s rules replaced without it: forgotten');
  p.dispose();
});

test('public hooks §3.12 (review): a filter\'s tests never see what its mod may not read, nor only what another mod\'s filter kept', async () => {
  const { keepsItem } = await import('../present/bindings/list-filter.mjs');
  const { compileWhere } = await import('../../shared/where.mjs');
  const seen = [];
  const msg = (id, text) => ({ ref: { type: 'AgentMessage', provider: 'codex', id }, state: { text } });
  const parts = [
    { key: 'unit.a/mine', by: 'unit.a', reads: ['Thread'], where: compileWhere({ text: 'keep' }), keep: null, for: null },
    { key: 'unit.b/spy', by: 'unit.b', reads: ['Message'], where: null, keep: (m) => { seen.push(m.ref.id); return true; }, for: null },
  ];
  // a mod's reads: its types (and their subtypes, by this chain)
  const ctx = { chainOf: (t) => (t === 'AgentMessage' ? ['AgentMessage', 'Message'] : [t]),
    whereEnv: (rule) => ({ may: (x) => !!x && ctx.chainOf(x.ref.type).some((t) => (rule?.reads ?? []).includes(t)) }) };
  assert.equal(keepsItem(ctx, parts, msg('m1', 'drop')), true, 'unit.a may not read messages: its where keeps it, untested');
  assert.deepEqual(seen, ['m1']);
  parts[0].reads = ['Message'];
  assert.equal(keepsItem(ctx, parts, msg('m2', 'drop')), false);
  assert.deepEqual(seen, ['m1', 'm2'], 'unit.b is asked about m2 though unit.a left it out: it learns nothing of unit.a\'s choice');
  parts[1].reads = ['Thread'];
  keepsItem(ctx, parts, msg('m3', 'keep'));
  assert.deepEqual(seen, ['m1', 'm2'], 'its keep never sees a message it may not read');
});

test('public hooks §3.12: the transcript\'s, the Changes list\'s and the file tree\'s filters: their notice with "Show all", the changed files and the tree\'s paths they keep', async () => {
  const { threadView } = await import('../present/bindings/thread-view.mjs');
  const { changesView, changesFiles, diffView } = await import('../present/bindings/changes.mjs');
  const { filesView } = await import('../present/bindings/files-view.mjs');
  const { filesPane } = await import('../present/bindings/panel.mjs');
  const { setDeclaredFilter } = await import('../present/bindings/list-filter.mjs');
  const { compileWhere } = await import('../../shared/where.mjs');
  const { createFakeReact } = await import('./fake-react.mjs');
  const { React } = createFakeReact();
  const declared = {
    ThreadView: [{ mod: 'unit.t', id: 'quiet', kind: 'add', presentation: 'ThreadView', slot: 'filter', order: 1, data: { filter: { title: 'Quiet' } }, fns: { filter: { keep: () => true } } }],
    ChangesView: [{ mod: 'unit.c', id: 'src', kind: 'add', presentation: 'ChangesView', slot: 'filter', order: 1, data: { filter: { title: 'Source', where: { path: { $prefix: '/r/src/' }, kind: { $ne: 'deleted' } } } } }],
    FilesView: [{ mod: 'unit.f', id: 'md', kind: 'add', presentation: 'FilesView', slot: 'filter', order: 1, data: { filter: { title: 'Markdown', where: { name: { $glob: '*.md' } } } } }],
  };
  assert.ok(compileWhere(declared.ChangesView[0].data.filter.where) && compileWhere(declared.FilesView[0].data.filter.where));
  const ctx = { react: () => React, exports: () => ({}), local: { read() {}, touch() {} }, declared: (p) => declared[p] ?? [], guard: (rule, fn) => fn,
    whereEnv: () => ({}), chainOf: (t) => [t], thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }), modName: (id) => id.toUpperCase() };
  const factory = (type, p) => React.createElement(type, p);
  const route = { routeKind: 'local-thread', conversationId: 'c1' };
  const pane = { binding: 'files.pane', props: { search: {}, children: { props: { root: '/r' } } } };   // the Files tab's tree's nearest site
  // none on: the app's own everywhere
  assert.equal(threadView.render('Thread', { transcriptHeader: null }, factory, ctx), undefined);
  assert.equal(changesFiles.render('Tree', { entries: [{ path: '/r/a.txt' }] }, factory, ctx, route), undefined);
  assert.equal(diffView.render('Diff', { reviewPath: '/r/a.txt' }, factory, ctx, route), undefined);
  assert.equal(filesView.render('Files', { cwd: '/r', paths: ['a.txt'] }, factory, ctx, null, pane), undefined);
  for (const pr of ['ThreadView', 'ChangesView', 'FilesView']) setDeclaredFilter(ctx, pr, `${declared[pr][0].mod}/${declared[pr][0].id}`, true);
  // the transcript's notice, after the app's header
  const header = threadView.render('Thread', { transcriptHeader: 'app' }, factory, ctx).props.transcriptHeader;
  const notice = [].concat(header.props.children).at(-1);
  assert.equal(notice.props['data-codexmods'], 'transcript-filter');
  assert.equal(notice.props.children[0].props.children, 'Filtered: Quiet (UNIT.T)');
  // the Changes list: the files it keeps, in the tree and the diffs alike, and its notice a header row
  const entries = [{ path: '/r/src/a.ts', changeKind: 'modified' }, { path: '/r/src/old.ts', changeKind: 'deleted' }, { path: '/r/README.md', changeKind: 'added' }];
  assert.deepEqual(changesFiles.render('Tree', { entries }, factory, ctx, route).props.entries.map((e) => e.path), ['/r/src/a.ts']);
  assert.deepEqual(['/r/src/a.ts', '/r/README.md'].map((path) => diffView.render('Diff', { reviewPath: path }, factory, ctx, route)), [undefined, null]);
  let rows = null;
  changesView.render('Changes', { renderSlots: (arg) => { rows = arg.headerRows; } }, factory, ctx).props.renderSlots({ headerRows: [{ id: 'review-controls' }] });
  assert.deepEqual(rows.map((r) => r.id), ['review-controls', 'codexmods:filter']);
  // the file tree: the files it keeps, and a folder unless every file listed under it is left out
  const paths = ['docs/', 'docs/a.md', 'docs/b.txt', 'src/', 'src/x.js', 'lazy/', 'top.md'];
  assert.deepEqual(filesView.render('Files', { cwd: '/r', paths }, factory, ctx, null, pane).props.paths, ['docs/', 'docs/a.md', 'lazy/', 'top.md']);
  assert.equal(filesView.render('Files', { cwd: '/r', paths }, factory, ctx, null, null), undefined, 'a tree under no pane is not the Files tab\'s');
  const changesPane = { binding: 'files.pane', props: { search: {}, children: { props: { entries: [] } } } };
  assert.equal(filesView.render('Files', { cwd: '/r', paths }, factory, ctx, null, changesPane), undefined, 'the Changes tab\'s list is the Changes list\'s');
  assert.equal(filesPane.render('Pane', changesPane.props, factory, ctx), undefined, 'nor is the files notice there');
  const sectioned = [{ displayPath: 'All files/n.md', path: '/r/n.md', directory: false }, { displayPath: 'All files/s', path: '/r/s', directory: true }, { displayPath: 'All files/s/y.js', path: '/r/s/y.js' }];
  assert.deepEqual(filesView.render('Files', { cwd: '/r', paths: sectioned }, factory, ctx, null, pane).props.paths.map((e) => e.displayPath), ['All files/n.md']);
  const besideSearch = filesPane.render('Pane', { search: { onQueryChange() {} }, filterActions: null }, factory, ctx).props.filterActions;
  assert.equal(besideSearch.props['data-codexmods'], 'files-filter');
  assert.equal(besideSearch.props.children[0].props.children, 'Filtered', 'beside the search box: compact, the rest its tooltip');
  // the user's "Show all" of a list turns its filters off in this window
  notice.props.children[1].props.onClick();
  assert.equal(threadView.render('Thread', { transcriptHeader: null }, factory, ctx), undefined);
  assert.notEqual(changesFiles.render('Tree', { entries }, factory, ctx, route), undefined, 'another list\'s filters stay on');
});

test('F3 copy redaction (built review round 2): a thread action\'s copy is from where it says (its chat, or not a chat\'s content); else a non-content command\'s copy as it runs is as it is; else its place: the chats its element and its ranges touch; a layer opened from nowhere known, every rule; elsewhere as it is', async () => {
  const k = fakeKernel([]);
  const turn = { ref: { type: 'Turn', provider: 'codex', id: 'u1' }, liveness: 'live', state: {}, links: { thread: { type: 'CodexThread', provider: 'codex', id: 't1' } } };
  const p = startPresentation({ kernel: k, graph: fakeGraph({ u1: turn }), bindings: [] });
  p.rules.put({ mod: 'm', id: 'r', kind: 'add', presentation: 'ContentView', slot: 'redact', realm: 'renderer', order: 1, data: { redact: { match: { source: 'sk-[0-9]+', flags: '' }, as: '[key]' } } });
  await new Promise((r) => setImmediate(r));
  const turnEl = { nodeType: 1, getAttribute: (n) => (n === 'data-turn-key' ? 'history-content:turn:u1' : null), closest: (sel) => (sel === '[data-turn-key]' ? turnEl : null) };
  const doc = { querySelectorAll: (sel) => (sel === '[data-turn-key]' ? [turnEl] : []) };
  const inTranscript = { nodeType: 1, ownerDocument: doc, closest: (sel) => (sel === '[data-turn-key]' ? turnEl : null) };
  const elsewhere = { nodeType: 1, ownerDocument: doc, closest: () => null };
  const at = (target, ranges = []) => ({ target, ranges });
  assert.equal(k.store.copy('sk-1', at(inTranscript)), '[key]', 'a transcript\'s: masked');
  assert.equal(k.store.copy('sk-1', at(elsewhere)), null, 'a path, a link: as it is');
  assert.equal(k.store.copy('sk-1', null), null, 'no place and no chat shown: as it is');
  // a thread action's copy says where it is from, whatever its place and however long it awaited
  assert.equal(k.store.copy('sk-2', at(elsewhere), { chat: 't2' }), '[key]', '"Copy as Markdown": its chat');
  assert.equal(k.store.copy('sk-3', at(inTranscript), { content: false }), null, 'its folder, its link: not a chat\'s content');
  // a layer opened from nowhere known: any chat's (every rule)
  assert.equal(k.store.copy('sk-5', { target: null, ranges: [], layer: true }), '[key]');
  // a command that copies what is not a chat's content, as the page's dispatcher runs it; a content command's copy by its place
  let copied;
  k.store.command('copyDeeplink', undefined, 'keyboard_shortcut', undefined, () => { copied = k.store.copy('sk-6', at(inTranscript)); return true; });
  assert.equal(copied, null);
  k.store.command('copyLastCodeBlock', undefined, 'keyboard_shortcut', undefined, () => { copied = k.store.copy('sk-6', at(inTranscript)); return true; });
  assert.equal(copied, '[key]');
  assert.equal(k.store.copy('sk-6', at(inTranscript)), '[key]', 'the command done: by its place again');
  // a selection's copy: every chat its ranges touch, wherever it is anchored
  const touches = { intersectsNode: (n) => n === turnEl };
  assert.equal(k.store.copyPart('text/plain', 'sk-4', at({ nodeType: 3, parentElement: inTranscript })), '[key]');
  assert.equal(k.store.copyPart('text/plain', 'sk-4', at({ nodeType: 3, parentElement: elsewhere }, [touches])), '[key]', 'anchored elsewhere, touching a transcript');
  assert.equal(k.store.copyPart('text/html', '<b>sk-4</b>', at(inTranscript)), false, 'its html left out');
  assert.equal(k.store.copyPart('text/plain', 'sk-4', at(elsewhere, [{ intersectsNode: () => false }])), null);
  // a thread menu's entries run as the app's (no marks)
  const items = k.store.menus({ target: { conversationId: 't2' } }, [{ id: 'copy-actions', additionalItems: [{ id: 'copy-conversation-markdown', onSelect: () => 'md' }] }]);
  assert.equal(items[0].additionalItems[0].onSelect(), 'md');
  assert.equal(k.store.copy('sk-7', at(elsewhere)), null, 'nothing marked: by its place');
  p.dispose();
  assert.deepEqual([k.store.copy, k.store.copyPart], [null, null]);
});

test('H6m3: a command the user runs in the page is their Command.run: held while something holds it (handled at once, run once the Host lets it go, the reason said when not); main\'s run-command and a run without a source are not the user\'s here', async () => {
  const k = fakeKernel([]);
  let holdsSink = null;
  const asked = [], done = [];
  let answer = { go: true, token: 't1' };
  const present = {
    holds: (fn) => { holdsSink = fn; return { dispose() {} }; },
    hold: async (ref, operation, args) => { asked.push([ref.id, operation, args]); return answer; },
    done: async (token, outcome) => { done.push([token, outcome.status]); },
    did: async () => {},
  };
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [], present });
  const ran = [];
  const run = (id) => () => { ran.push(id); return true; };
  // nothing holds it: the app's own dispatch at once, its answer kept
  assert.equal(k.store.command('newTask', undefined, 'command_menu', undefined, () => false), false);
  holdsSink({ held: ['Command.run'], observed: [] });
  // held: handled at once; run once let go
  assert.equal(k.store.command('deleteChat', undefined, 'keyboard_shortcut', undefined, run('deleteChat')), true);
  assert.deepEqual(ran, []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([asked, ran, done], [[['deleteChat', 'run', []]], ['deleteChat'], [['t1', 'done']]]);
  // refused: not run
  answer = { go: false, message: 'not now' };
  assert.equal(k.store.command('archiveThread', undefined, 'command_menu', undefined, run('archiveThread')), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, ['deleteChat']);
  // not the user's here: main's run-command (the native menu bar, the framework's own runs), a follow-up the page dispatches itself, and a
  // run without a source (built review H6m3a)
  assert.equal(k.store.command('newTask', undefined, 'host_run_command', undefined, run('a')), undefined);
  assert.equal(k.store.command('focusBrowserAddressBar', undefined, 'side_panel_full_width', undefined, run('c')), undefined);
  assert.equal(k.store.command('newTask', undefined, undefined, undefined, run('b')), undefined);
  assert.equal(asked.length, 2);
  // a dispatch while another command runs is its own part: not held again
  answer = { go: true, token: 't3' };
  let inner;
  assert.equal(k.store.command('outer', undefined, 'command_menu', undefined, () => { inner = k.store.command('nested', undefined, 'menu', undefined, run('nested')); return true; }), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([inner, asked.map((a) => a[0])], [undefined, ['deleteChat', 'archiveThread', 'outer']]);
  // let go later, a key chord's run gets a fresh copy of its event (the original was handled when the hold answered)
  const K0 = globalThis.KeyboardEvent;
  class KE { constructor(type, init = {}) { Object.assign(this, { type, ...init, fresh: true }); } }
  globalThis.KeyboardEvent = KE;
  try {
    const original = Object.assign(new KE('keydown', { key: 'b', metaKey: true }), { fresh: false, defaultPrevented: true });
    let got;
    k.store.command('toggleSidebar', original, 'keyboard_shortcut', undefined, (ev) => { got = ev; return true; });
    await new Promise((r) => setImmediate(r));
    assert.ok(got && got !== original && got.fresh === true && got.key === 'b' && got.metaKey === true && got.defaultPrevented === undefined);
  } finally { globalThis.KeyboardEvent = K0; }
  p.dispose();
  assert.equal(k.store.command, null);
});

test('content rules live: the kernel\'s content revision changes only when the redactions or text parts in force change in effect (data, conditions, order, renderer), never for a rule delivered again unchanged nor for another kind of rule', async () => {
  const k = fakeKernel([]);
  const p = startPresentation({ kernel: k, graph: fakeGraph(), bindings: [] });
  await new Promise((r) => setImmediate(r));
  const rev = () => k.store.contentRev | 0;
  const render = () => null;
  const rule = (as, more = {}) => ({ mod: 'm', id: 'r', kind: 'add', presentation: 'ContentView', slot: 'redact', realm: 'renderer', order: 1, data: { redact: { match: { source: 'x', flags: '' }, as } }, ...more });
  const text = (fn) => ({ mod: 'm', id: 't', kind: 'host', presentation: 'ContentView', slot: 'partRenderers', realm: 'renderer', order: 2, data: { part: { kind: 'text', match: { source: 'y', flags: '' } } }, fns: { render: fn } });
  const before = rev();
  p.rules.put(rule('[a]'));
  const added = rev();
  assert.ok(added > before, 'a redaction added');
  p.rules.put(rule('[a]'));
  assert.equal(rev(), added, 'delivered again unchanged (another window\'s start): no change');
  p.rules.put({ mod: 'm', id: 'h', kind: 'hide', presentation: 'Command', realm: 'renderer', order: 3, data: {} });
  p.rules.put({ mod: 'm', id: 'l', kind: 'host', presentation: 'ContentView', slot: 'partRenderers', realm: 'renderer', order: 4, data: { part: { kind: 'link' } }, fns: { render } });
  assert.equal(rev(), added, 'another kind of rule, a link renderer: no change');
  p.rules.put(rule('[a]', { for: 'Thread', where: { title: 'B' } }));
  const scoped = rev();
  assert.ok(scoped > added, 'its conditions changed');
  p.rules.put(text(render));
  const withText = rev();
  p.rules.put(text(render));
  assert.equal(rev(), withText, 'a text part delivered again with the same renderer: no change');
  p.rules.put(text(() => null));
  assert.ok(rev() > withText, 'a new renderer');
  p.dispose();
});

test('graph-integrity G5.1: the app\'s step row tells its StepBlock\'s expansion (its own chevron), and sets it as the user\'s click does', () => {
  let clicks = 0;
  const row = (expanded) => ({ disclosure: { expanded, onToggle: () => { clicks++; } } });
  assert.deepEqual([stepRow.expanded(row(true)), stepRow.expanded(row(false)), stepRow.expanded({})], [true, false, undefined]);
  assert.equal(stepRow.operations.collapse(row(true)), true);
  assert.equal(clicks, 1);
  assert.equal(stepRow.operations.collapse(row(false)), true, 'already collapsed: nothing to do');
  assert.equal(stepRow.operations.expand(row(false)), true);
  assert.equal(clicks, 2);
  assert.match(stepRow.operations.expand({}).unavailable, /nothing to show/, 'a row without a chevron');
});
