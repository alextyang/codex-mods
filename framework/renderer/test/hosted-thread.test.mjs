// A chat of the app's in a mod's place (docs/design/layouts.md D8, WL7): one pane, its own route record under the app's scopes, around the app's host of a second chat. A chat not opened
// this run comes into the app's store first; what the pane cannot show it says; a fault in the app's view stays in the pane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createHostedThreads, requestKey, pageToken } from '../present/hosted-thread.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const REF = { type: 'Thread', provider: 'codex', id: 'c1' };

function setup({ subject = { state: {} }, ensure = async () => true, activate = async () => {}, over = {}, inTree = true } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const calls = [], log = [], observed = [], opened = [];
  const pending = {}, watchers = new Set();
  const ask = (id, req) => { pending[id] = req; for (const w of [...watchers]) w({ get: (a, k) => (a === 'PENDING' ? pending[k] ?? null : null) }); };
  let changed = 0;
  const Pane = React.createContext(null);
  const Tab = (p) => e('section', { 'data-tab': p.conversationId, 'data-host': p.hostId }, 'the chat');
  const exports = {
    tabRegistry: { registry: new Map([['review', { Component: (p) => e('section', { 'data-kind-tab': p.tabId, 'data-active': p.isActive }, 'the changes'), defaultState: () => ({}) }], ['subagents', { Component: () => { throw new Error('no record'); } }]]) },
    useScope: (s) => { if (!inTree) throw new Error('Missing scope instance'); return { def: s, watch: (fn) => { watchers.add(fn); fn({ get: (a, id) => (a === 'PENDING' ? pending[id] ?? null : null) }); return () => watchers.delete(fn); } }; }, AppScope: 'app', ComposerScope: 'composer',
    routeScopes: ({ route, children }) => e('main', { 'data-route': route.pathname, 'data-template': route.routeTemplate, 'data-conv': route.conversationId, 'data-kind': route.routeKind }, children),
    conversationTab: Object.assign(Tab, { prefetch: () => { calls.push(['prefetch']); } }),
    hostClient: (scope, host) => { calls.push(['client', scope.def, host]); return {
      activateThreadSummary: (id, opts) => { calls.push(['activate', id, opts]); return activate(id); },
      ensureConversationFirstPage: (id) => { calls.push(['ensure', id]); return ensure(id); },
    }; },
    ScopeProvider: ({ scope, value, children }) => e('div', { 'data-scope': scope, 'data-value': JSON.stringify(value) }, children),
    composerScopeValue: (conv, placement, route) => ({ conv, placement, route }),
    threadView: (p) => e('article', { 'data-view': JSON.stringify({ ...p, footerContent: undefined }) }, 'the transcript', p.footerContent),
    pendingRequest: 'PENDING',
    PendingRequestPanel: (p) => e('section', { 'data-request': p.conversationId, 'data-host': p.hostId, 'data-type': p.pendingRequest.type }, 'the card'),
    ...(typeof over === 'function' ? over(React, Pane) : over),
  };
  const ctx = { react: () => React, use: (fn) => fn(), subject: () => subject };
  const hosted = createHostedThreads({ ctx, exports: () => exports, observe: (r) => { observed.push(r); return { dispose() { observed.push('off'); } }; }, log: (m, d) => log.push([m, d]), paneContext: () => Pane, changed: () => { changed++; }, openChat: (r) => opened.push(r), waitMs: 5 });
  const draw = (ref = REF, opts) => { const root = ReactDOM.createRoot({}); root.render(hosted.thread(ref, opts)); return root; };
  const drawTab = (kind, ref = REF) => { const root = ReactDOM.createRoot({}); root.render(hosted.tab(kind, ref)); return root; };
  return { hosted, draw, drawTab, calls, log, observed, changed: () => changed, Pane, ask, opened };
}

test('WL7: a chat comes into the app\'s store before its host draws it, the way the app\'s own opener brings it', async () => {
  let release;
  const t = setup({ ensure: () => new Promise((r) => { release = r; }) });
  const root = t.draw();
  await tick();
  assert.deepEqual(t.calls.filter((c) => c[0] !== 'prefetch'), [['client', 'app', 'local'], ['activate', 'c1', { addToRecent: false }], ['ensure', 'c1']], 'never added to the user\'s recents');
  assert.equal(findAll(root.tree, (n) => n.props?.['data-tab']).length, 0, 'its host would wait for ever on a chat not in the store');
  release(true);
  await tick();
  assert.equal(findAll(root.tree, (n) => n.props?.['data-tab'] === 'c1').length, 1);
  assert.equal(findAll(root.tree, (n) => n.props?.['data-tab'] === 'c1')[0].props['data-host'], 'local');
});

test('WL7: a pane is its own route: a pathname no route has, under the framework\'s pane marker', async () => {
  const t = setup();
  const root = t.draw();
  await tick();
  const [main] = findAll(root.tree, (n) => n.props?.['data-route']);
  assert.match(main.props['data-route'], /^\/codexmods\/pane\/pane-[a-z0-9]+-\d+$/);
  assert.equal(main.props['data-template'], '/codexmods/pane/:pane');
  assert.equal(main.props['data-conv'], 'c1');
  assert.equal(main.props['data-kind'], 'local-thread');
  const [pane] = findAll(root.tree, (n) => n.props?.['data-codexmods-pane']);
  assert.equal(pane.props['data-codexmods-pane-chat'], 'c1');
  assert.equal(main.props['data-route'], `/codexmods/pane/${pane.props['data-codexmods-pane']}`);
  assert.deepEqual(t.hosted.facts(), { list: [{ token: pane.props['data-codexmods-pane'], thread: REF }], active: null });
  assert.equal(t.observed[0], REF);
});

test('WL7: a chat that does not come in says so, with no spinner for ever', async () => {
  const refused = setup({ ensure: async () => false });
  assert.match((await settle(refused)), /could not be loaded/);
  const thrown = setup({ activate: async () => { throw new Error('no host'); } });
  assert.match((await settle(thrown)), /could not be loaded/);
  assert.deepEqual(thrown.log.map((l) => [l[0], l[1].message]), [['a hosted chat: not loaded', 'no host']]);
  async function settle(t) { const root = t.draw(); await tick(); return rootText(root); }
});

test('WL7: a chat that takes too long says so, and still comes in when it does', async () => {
  let release;
  const t = setup({ ensure: () => new Promise((r) => { release = r; }) });
  const root = t.draw();
  await new Promise((r) => setTimeout(r, 15));
  assert.match(rootText(root), /could not be loaded/);
  release(true);
  await tick();
  assert.match(rootText(root), /the chat/);
});

test('WL7: what a pane cannot show it says', async () => {
  const text = async (t, ref) => { const root = t.draw(ref); await tick(); return rootText(root); };
  assert.match(await text(setup(), { type: 'Thread', provider: 'cloud' }), /Only a chat on this computer/);
  assert.match(await text(setup({ subject: { gone: true } })), /no longer here/);
  assert.match(await text(setup({ subject: { state: { archived: true } } })), /is archived/);
  for (const miss of ['routeScopes', 'conversationTab', 'hostClient']) assert.match(await text(setup({ over: { [miss]: undefined } })), /This build cannot/, miss);
  assert.match(await text(setup({ inTree: false })), /This build cannot/, 'outside the app\'s tree');
});

test('WL7: without its composer a chat is the app\'s thread view under a composer scope of the framework\'s, live and never leaving the window', async () => {
  const t = setup();
  const root = t.draw(REF, { composer: false });
  await tick();
  const [scope] = findAll(root.tree, (n) => n.props?.['data-scope']);
  assert.equal(scope.props['data-scope'], 'composer');
  assert.deepEqual(JSON.parse(scope.props['data-value']), { conv: 'c1', placement: 'main', route: 'c1' });
  const view = JSON.parse(findAll(root.tree, (n) => n.props?.['data-view'])[0].props['data-view']);
  assert.equal(view.shouldResume, true);
  assert.equal(view.allowMissingConversation, true, 'else the app sends the window home when the chat is gone');
  assert.equal(view.showComposer, false);
  assert.equal(view.hideWhenCoveredByRightPanel, false);
});

test('WL7: a pane without its composer shows what the chat asks, the app\'s own panel; a plan to implement needs the chat itself', async () => {
  const t = setup();
  const root = t.draw(REF, { composer: false });
  await tick();
  assert.equal(findAll(root.tree, (n) => n.props?.['data-request']).length, 0);
  t.ask('c1', { type: 'approval', id: 'r1' });
  await tick();
  const [card] = findAll(root.tree, (n) => n.props?.['data-request']);
  assert.deepEqual([card.props['data-request'], card.props['data-host'], card.props['data-type']], ['c1', 'local', 'approval']);
  t.ask('c1', null);
  await tick();
  assert.equal(findAll(root.tree, (n) => n.props?.['data-request']).length, 0, 'answered: it goes');
  t.ask('c1', { type: 'implementPlan', turnId: 't1' });
  await tick();
  assert.equal(findAll(root.tree, (n) => n.props?.['data-request']).length, 0);
  assert.match(rootText(root), /a plan to implement/);
  findAll(root.tree, (n) => n.type === 'button')[0].props.onClick();
  assert.deepEqual(t.opened, [REF]);
});

test('WL7: a fault in the app\'s view stays in the pane', async () => {
  const t = setup({ over: { conversationTab: Object.assign(() => { throw new Error('boom'); }, {}) } });
  const root = t.draw();
  await tick();
  assert.match(rootText(root), /could not be shown here/);
  assert.equal(t.log.some((l) => l[0] === 'a hosted chat: a fault' && l[1].message === 'boom'), true);
});

test('WL7: two panes of one chat are two: their own tokens and routes', async () => {
  const t = setup();
  const a = t.draw(), b = t.draw();
  await tick();
  const routes = [a, b].map((r) => findAll(r.tree, (n) => n.props?.['data-route'])[0].props['data-route']);
  assert.notEqual(routes[0], routes[1]);
  assert.equal(t.hosted.facts().list.length, 2);
});

test('WL7: one of the app\'s panel kinds for a chat, in a mod\'s place: only the kinds that draw alone; the others say so; a fault stays in its place', () => {
  const t = setup();
  const root = t.drawTab('review');
  assert.match(rootText(root), /the changes/);
  assert.match(findAll(root.tree, (n) => n.props?.['data-kind-tab'])[0].props['data-kind-tab'], /^codexmods:pane-[a-z0-9]+-\d+$/);
  assert.equal(findAll(root.tree, (n) => n.props?.['data-route']).length, 1, 'under the chat\'s own scopes');
  assert.match(rootText(t.drawTab('terminal')), /not shown outside a panel/);
  assert.match(rootText(t.drawTab('subagents')), /could not be shown here/);
  assert.match(rootText(t.drawTab('review', { type: 'Thread', provider: 'cloud', id: 'x' })), /Only a chat on this computer/);
  assert.match(rootText(setup({ over: { tabRegistry: undefined } }).drawTab('review')), /This build cannot/);
});

test('WL7 review: a token is this page\'s own: one kept across a reload or from another window names nothing here', async () => {
  const t = setup();
  const root = t.draw();
  await tick();
  const mine = findAll(root.tree, (n) => n.props?.['data-codexmods-pane'])[0].props['data-codexmods-pane'];
  const another = await import('../present/hosted-thread.mjs?another-page');
  assert.match(mine, new RegExp(`^pane-${pageToken}-\\d+$`));
  assert.notEqual(another.pageToken, pageToken, 'another page: another prefix, so its first pane is not this page\'s');
  assert.ok(mine.length <= 64, 'within what a report keeps');
});

test('WL7 review: a request is its own by the app\'s key, so a new one draws anew with none of a form\'s state', () => {
  const k = (r, conv = 'c1') => requestKey(conv, r);
  assert.notEqual(k({ type: 'userInput', item: { requestId: 'r1' } }), k({ type: 'userInput', item: { requestId: 'r2' } }), 'two questions in turn');
  assert.notEqual(k({ type: 'approval', item: { approvalRequestId: 'a1', callId: 'c' } }), k({ type: 'approval', item: { approvalRequestId: 'a2', callId: 'c' } }));
  assert.notEqual(k({ type: 'approval', item: { callId: 'c1' } }), k({ type: 'approval', item: { callId: 'c2' } }), 'an approval with no id of its own: its call');
  assert.notEqual(k({ type: 'permissionRequest', item: { requestId: 'p1' } }), k({ type: 'permissionRequest', item: { requestId: 'p2' } }));
  assert.notEqual(k({ type: 'optionPicker', requestId: 'o1' }), k({ type: 'optionPicker', requestId: 'o2' }));
  assert.notEqual(k({ type: 'implementPlan', turnId: 't1' }), k({ type: 'implementPlan', turnId: 't2' }));
  assert.notEqual(k({ type: 'userInput', item: { requestId: 'r1' } }, 'c1'), k({ type: 'userInput', item: { requestId: 'r1' } }, 'c2'), 'and the chat\'s');
});

test('WL7 review: a panel kind in a mod\'s place is a pane: what it mounts is not the route\'s; the rows its panel would draw, a kind\'s way back among them, are drawn above it', async () => {
  let inside = 'unset';
  const t = setup({ over: (React, Pane) => ({ tabRegistry: { registry: new Map([['subagents', { defaultState: () => ({}), Component: (p) => { inside = React.useContext(Pane); return p.renderSlots({ headerRows: [{ id: 'back', height: 'content', content: 'BACK' }], content: 'BODY' }); } }]]) } }) });
  const root = t.drawTab('subagents');
  await tick();
  const [box] = findAll(root.tree, (n) => n.props?.['data-hosted-tab'] !== undefined || n.props?.['data-codexmods-hosted-tab']);
  const token = box.props['data-codexmods-pane'];
  assert.match(token, /^pane-[a-z0-9]+-\d+$/);
  assert.equal(inside, token, 'its mounts carry its token');
  assert.match(rootText(root), /BACK.*BODY/s);
  assert.deepEqual(t.hosted.facts().list.map((x) => x.token), [token], 'listed as a pane');
  root.unmount();
  await tick();
  assert.equal(t.hosted.facts(), null, 'gone with it');
});

test('WL7 review: what this build can host is said', () => {
  const full = setup().hosted.supported();
  assert.deepEqual([full.thread, full.transcript], [true, true]);
  assert.deepEqual([setup({ over: { threadView: undefined } }).hosted.supported().transcript], [false], 'a chat alone needs the app\'s thread view');
  assert.ok(full.tabs.includes('review'));
  const none = setup({ over: { routeScopes: undefined } }).hosted.supported();
  assert.deepEqual(none, { thread: false, transcript: false, tabs: [] });
});

test('WL7 review, native: the subagents kind lists this chat\'s, from the app\'s store; one opened comes in first, its row above it holds the way back', async () => {
  let seen = null;
  let release = null;
  const t = setup({
    ensure: (id) => (id === 'sub-1' ? new Promise((r) => { release = r; }) : true),
    over: () => ({ tabRegistry: { registry: new Map([['subagents', { defaultState: () => ({}), Component: (p) => { seen = p; return p.renderSlots({ headerRows: p.requestedConversationId ? [{ id: 'subagent-detail', content: 'BACK' }] : [], content: p.requestedConversationId ? 'TRANSCRIPT' : 'LIST' }); } }]]) } }),
  });
  const root = t.drawTab('subagents');
  await tick();
  assert.deepEqual([seen.parentConversationId, seen.hostId, seen.requestedConversationId], ['c1', 'local', null], 'its chat, not an empty list');
  assert.deepEqual(t.calls.filter((c) => c[0] === 'activate').map((c) => [c[1], c[2]]), [['c1', { addToRecent: false }]], 'the chat comes in, never into the recents');
  assert.match(rootText(root), /LIST/);
  seen.onSelect('sub-1', 'Math answer');
  await tick();
  assert.deepEqual([seen.requestedConversationId, seen.requestedDisplayName, seen.isLoading], ['sub-1', 'Math answer', true], 'in the store first');
  assert.ok(t.calls.some((c) => c[0] === 'activate' && c[1] === 'sub-1'));
  release(true);
  await tick();
  assert.equal(seen.isLoading, false);
  assert.match(rootText(root), /BACK.*TRANSCRIPT/s);
  // what is shown now is the agent: its own scopes and what the Window says, the chat staying its list's parent
  assert.equal(findAll(root.tree, (n) => n.props?.['data-route'])[0].props['data-conv'], 'sub-1');
  assert.equal(seen.parentConversationId, 'c1');
  assert.deepEqual(t.hosted.facts().list.map((x) => x.thread.id), ['sub-1']);
  seen.onSelect(null, null);
  await tick();
  assert.equal(seen.requestedConversationId, null, 'back to the list');
  assert.equal(findAll(root.tree, (n) => n.props?.['data-route'])[0].props['data-conv'], 'c1');
  assert.deepEqual(t.hosted.facts().list.map((x) => x.thread.id), ['c1']);
  assert.match(rootText(root), /LIST/);
});

test('graph-integrity G5.1: the keyboard into a pane (its composer\'s editor), or into the window\'s own page (its composer outside every pane); the panes in their order on the page', async () => {
  const focused = [];
  const editorOf = (name, pane) => ({ name, focus() { focused.push(name); }, closest: (sel) => (sel === '[data-codexmods-pane]' ? pane : null), getClientRects: () => [1] });
  const drawn = [];
  const paneEl = (token, name) => { const el = { getAttribute: (k) => (k === 'data-codexmods-pane' ? token : null), hasAttribute: () => true }; el.editor = editorOf(name, el); el.querySelector = () => el.editor; return el; };
  const mainEditor = editorOf('main', null);
  const main = { contains: (x) => x === mainEditor };
  const doc = {
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: (sel) => (sel === '[data-codexmods-pane]' ? drawn : sel.startsWith('[contenteditable') ? [...drawn.map((p) => p.editor), mainEditor] : []),
    querySelector: (sel) => (sel === 'main' ? main : null),
  };
  const was = globalThis.document;
  globalThis.document = doc;
  try {
    const t = setup();
    t.draw(); t.draw({ ...REF, id: 'c2' });
    await tick();
    const [a, b] = t.hosted.facts().list.map((p) => p.token);
    drawn.push(paneEl(b, 'b'), paneEl(a, 'a'));
    assert.deepEqual(t.hosted.facts().list.map((p) => p.token), [b, a], 'as the page draws them');
    const before = t.changed();
    assert.equal(t.hosted.focusPane(a), true);
    assert.deepEqual([focused, t.hosted.facts().active, t.changed() > before], [['a'], a, true], 'the user is in it now');
    assert.equal(t.hosted.focusPane(null), true);
    assert.deepEqual([focused, t.hosted.facts().active], [['a', 'main'], null], 'the window\'s own page');
    assert.match(t.hosted.focusPane('pane-elsewhere').unavailable, /not shown/);
  } finally { globalThis.document = was; }
});
