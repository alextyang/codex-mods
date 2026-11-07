// More decoration subjects (public-hooks.md §3.13, H7s): a setting's row takes badges, a skill's card on the Skills page is a ListItem (its
// badges); a tool server's row and a model's label wait for seams that carry their host and identity (review round 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { settingsRow } from '../present/bindings/settings-row.mjs';
import { skillCard, branchRow } from '../present/bindings/list-items.mjs';
import { queueRow } from '../present/bindings/queue-item.mjs';
import { composerSuggest, mentionList, composer } from '../present/bindings/composer.mjs';
import { modelRow } from '../present/bindings/composer-picker.mjs';
import { panelTabBody, panelTab, terminalBackground } from '../present/bindings/panel.mjs';
import { DECORATION_PLACES } from '../../shared/ui-rules-client.mjs';

const { React } = createFakeReact();
const env = { R: React, ctx: { token: () => undefined } };
const entries = (...texts) => texts.map((text, i) => ({ rule: { mod: 'm', id: `r${i}` }, item: { id: `b${i}`, text } }));

test('H7s: a setting\'s row takes badges after its label; a tool server\'s row presents nothing (no key nor host in its props, review round 1)', () => {
  const ctx = { settingNamed: (title, slug) => (title === 'Theme' && slug === 'appearance' ? { type: 'Setting', provider: 'codex', id: 'appearanceTheme' } : null) };
  assert.deepEqual(settingsRow.subject({ label: 'Theme' }, ctx, { pathname: '/settings/appearance' }), { type: 'Setting', provider: 'codex', id: 'appearanceTheme' });
  const nested = React.createElement('span', null, React.createElement('span', null, React.createElement('span', null, 'code-review')));
  assert.equal(settingsRow.subject({ label: nested }, ctx, { pathname: '/settings/mcp-settings' }), null, 'no identity props: nothing');
  // H7v: the pack's identity props name it: a server of this Mac's by its key (not the name it shows), another host's none, a project's
  // (read only) none, and only when the graph holds it as the same kind (a plugin's or a config's)
  const mcp = { pathname: '/settings/mcp-settings' };
  const servers = { production: { state: { source: 'user' }, links: {} }, 'code-review': { state: { source: 'plugin' }, links: { plugin: { type: 'Plugin', provider: 'codex', id: 'cr' } } },
    db: { state: { source: 'project' }, links: {} } };
  ctx.subject = (ref) => (servers[ref.id] ? { ref, ...servers[ref.id] } : null);
  assert.deepEqual(settingsRow.subject({ label: 'Staging', serverKey: 'production', hostId: 'local' }, ctx, mcp), { type: 'ToolServer', provider: 'codex', id: 'production' });
  assert.equal(settingsRow.subject({ label: 'staging', serverKey: 'production', hostId: 'devbox' }, ctx, mcp), null, 'another host\'s');
  assert.equal(settingsRow.subject({ label: 'db', serverKey: 'production', hostId: 'local', serverReadOnly: true }, ctx, mcp), null, 'a project\'s, whose key the graph keeps the user\'s of');
  assert.deepEqual(settingsRow.subject({ label: 'code-review', serverKey: 'code-review', hostId: 'local', fromPlugin: true }, ctx, mcp), { type: 'ToolServer', provider: 'codex', id: 'code-review' });
  assert.equal(settingsRow.subject({ label: 'production', serverKey: 'production', hostId: 'local', fromPlugin: true }, ctx, mcp), null, 'a plugin\'s row of a config\'s key');
  assert.equal(settingsRow.subject({ label: 'x', serverKey: 'unknown', hostId: 'local' }, ctx, mcp), null, 'one the graph does not hold');
  // round 2: a key a project's config touches (any field, the row not read only) is the graph's project kind: not named
  assert.equal(settingsRow.subject({ label: 'db', serverKey: 'db', hostId: 'local' }, ctx, mcp), null);
  const out = settingsRow.slots.badges.apply({ label: 'Theme', control: null }, entries('OK'), env);
  assert.equal(out.label.type, React.Fragment);
  assert.deepEqual([out.label.props.children[0], out.label.props.children[1].props.children[1]], ['Theme', 'OK']);
  assert.deepEqual([DECORATION_PLACES.Setting, DECORATION_PLACES.ToolServer, DECORATION_PLACES.Model], [{ SettingsRow: ['actions', 'badges'] }, { SettingsRow: ['actions', 'badges'] }, { ListItem: ['badges'] }]);
});

test('H7s: a skill\'s card of this Mac is a ListItem of the Skill its path names, its badges after the app\'s', () => {
  const skill = { path: '/u/.codex/skills/review/SKILL.md', name: 'review' };
  assert.deepEqual(skillCard.subject({ skill, displayName: 'review', hostId: 'local', scopeBadges: [] }), { type: 'Skill', provider: 'codex', id: skill.path });
  assert.equal(skillCard.subject({ skill, displayName: 'review', hostId: 'devbox', scopeBadges: [] }), null, 'another host\'s');
  const own = React.createElement('span', { key: 'repo' }, 'repo');
  const out = skillCard.slots.badges.apply({ skill, scopeBadges: [own] }, entries('Trusted'), env);
  assert.equal(out.scopeBadges.length, 2);
  assert.equal(out.scopeBadges[0], own);
});

test('H7s review round 1: a subject\'s decoration is drawn only where its mod may read the subject, with or without a where', async () => {
  const { covers } = await import('../present/rules.mjs');
  const inst = { ref: { type: 'Skill', provider: 'codex', id: '/s/SKILL.md' }, state: {} };
  const chainOf = (t) => [t];
  const rule = { mod: 'm', id: 'b', kind: 'decorate', for: 'Skill', data: { badges: [{ id: 'x', text: 'X' }] } };
  assert.equal(covers(rule, inst, chainOf, () => ({ may: () => true })), true);
  assert.equal(covers(rule, inst, chainOf, () => ({ may: () => false })), false, 'no read: not drawn');
  // round 2: without `for` too (a presentation's decoration on the subject it shows); a hide or a part rule is not the subject's
  assert.equal(covers({ mod: 'm', id: 'c', kind: 'decorate', data: { actions: [] } }, inst, chainOf, () => ({ may: () => false })), false);
  assert.equal(covers({ mod: 'm', id: 'h', kind: 'hide' }, inst, chainOf, () => ({ may: () => false })), true);
  assert.equal(covers({ mod: 'm', id: 'p', kind: 'hide', part: 'status' }, inst, chainOf, () => ({ may: () => false })), true);
});

test('H7x review 1: a branch\'s row, under the switcher\'s list, is a ListItem of the Branch of the repository the list shows (the route\'s project\'s own, on this Mac); badges after its own line', () => {
  const chat = { routeKind: 'local-thread', conversationId: 't1' }, home = { routeKind: 'home' };
  const inst = { 't1': { links: { project: { type: 'LocalProject', provider: 'codex', id: 'p1' } } }, 'new:app:new-conversation': { state: { target: { project: { type: 'LocalProject', provider: 'codex', id: 'p2' } } } },
    p1: { state: { location: '/repos/a' } }, p2: { state: { location: '/repos/b/' } } };
  const ctx = { thread: (id) => (id === 't1' ? { type: 'CodexThread', provider: 'codex', id } : id === 'x1' ? { type: 'Thread', provider: 'mod.a', id } : null), subject: (ref) => inst[ref.id] ?? null };
  const list = (gitRoot, id = 'local') => ({ binding: 'branch.list', props: { gitRoot, hostConfig: { id } } });
  assert.deepEqual(branchRow.subject({ branch: 'main', subText: null }, ctx, chat, list('/repos/a')), { type: 'Branch', provider: 'codex', id: 'p1:main' });
  assert.deepEqual(branchRow.subject({ branch: 'dev' }, ctx, home, list('/repos/b')), { type: 'Branch', provider: 'codex', id: 'p2:dev' });
  assert.equal(branchRow.subject({ branch: 'main' }, ctx, chat, list('/repos/other')), null, 'another repository (a file\'s, a worktree\'s): none');
  assert.equal(branchRow.subject({ branch: 'main' }, ctx, chat, list('/repos/a', 'devbox')), null, 'a remote host\'s');
  assert.equal(branchRow.subject({ branch: 'main' }, ctx, chat, null), null, 'a picker that names no repository (a comparison\'s base)');
  assert.equal(branchRow.subject({ branch: 'main' }, ctx, { routeKind: 'local-thread', conversationId: 'x1' }, list('/repos/a')), null, 'a provided chat names no project of Codex');
  const out = branchRow.slots.badges.apply({ branch: 'main', subText: 'checked out' }, entries('CI'), env);
  assert.equal(out.subText.type, React.Fragment);
  assert.equal(out.subText.props.children[0], 'checked out');
  assert.equal(branchRow.slots.badges.apply({ branch: 'main', subText: null }, entries('CI'), env).subText.type, 'span', 'no line of its own: the badges alone');
  assert.deepEqual(DECORATION_PLACES.Branch, { ListItem: ['badges'] });
});

test('H7x: a queued follow-up\'s row (under its site) takes the QueuedMessage\'s actions after the app\'s and badges in its secondary text', () => {
  const scope = { kind: 'local', placement: 'main', conversationId: 't1' };
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }), exports: () => ({}), token: () => undefined };
  const twin = queueRow.twins[0];
  assert.equal(twin.presentation, 'QueueItem');
  assert.deepEqual(twin.subject({}, ctx, scope, { binding: 'queue.item', props: { messageId: 'q1' } }), { type: 'QueuedMessage', provider: 'codex', id: 't1:q1' });
  assert.equal(twin.subject({}, ctx, scope, null), null, 'an image markup\'s row: no follow-up above it');
  assert.equal(twin.subject({}, ctx, { ...scope, placement: 'side' }, { binding: 'queue.item', props: { messageId: 'q1' } }), null);
  const own = React.createElement('button', { key: 'send' }, 'Send now');
  const out = twin.slots.badges.apply({ title: 'Follow up', actions: own, meta: null }, entries('Later'), { ...env, ctx });
  assert.equal(out.meta.props['data-codexmods-badge'] !== undefined || out.meta.type === React.Fragment, true);
  assert.deepEqual(DECORATION_PLACES.QueuedMessage, { QueueItem: ['actions', 'badges'] });
});

test('H7x: a panel tab\'s body: a plan\'s tab is the PlanView of its turn in a Codex chat; a terminal\'s takes its TerminalView\'s actions; both as a header row', () => {
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  const ctx = { thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }), exports: () => ({}), token: () => undefined };
  const plan = { tabId: 'plan', tabType: { kind: 'plan' }, props: { conversationId: 't1', planKey: 'turn-9' } };
  assert.deepEqual(panelTabBody.subject({ tab: plan }, ctx, route), { type: 'Turn', provider: 'codex', id: 'turn-9' });
  assert.deepEqual(panelTabBody.place({ tab: plan }, route), { in: 'PanelTab', on: { type: 'Turn', provider: 'codex', id: 'turn-9' }, slot: 'view' });
  assert.deepEqual(panelTab.subject({ tab: plan }, ctx, route), { type: 'Turn', provider: 'codex', id: 'turn-9' }, 'its tab presents the turn too (the PlanView\'s parent)');
  assert.equal(panelTabBody.subject({ tab: plan }, { ...ctx, thread: (id) => ({ type: 'Thread', provider: 'mod.a', id }) }, route), null, 'a provided chat\'s');
  // the editable plan (the desktop's): its PLAN.md in the route's chat's plans, under its File's tab
  const file = { tabId: 'plan', tabType: { kind: 'text-file-editor' }, props: { path: '/u/.codex/plans/t1/turn-9/PLAN.md', hostId: 'local' } };
  assert.deepEqual(panelTabBody.subject({ tab: file }, ctx, route), { type: 'Turn', provider: 'codex', id: 'turn-9' });
  assert.deepEqual(panelTabBody.place({ tab: file }, route).on, { type: 'File', provider: 'codex', id: '/u/.codex/plans/t1/turn-9/PLAN.md' });
  assert.equal(panelTabBody.subject({ tab: file }, ctx, { ...route, conversationId: 't2' }), null, 'another chat\'s plan');
  assert.equal(panelTabBody.subject({ tab: { ...file, tabId: 'file:x' } }, ctx, route), null, 'a file tab that is not the plan');
  assert.deepEqual(panelTab.subject({ tab: file }, ctx, route), { type: 'File', provider: 'codex', id: '/u/.codex/plans/t1/turn-9/PLAN.md' }, 'its tab presents its file');
  const term = { tabId: 'terminal:s1', tabType: { kind: 'terminal' }, props: { sessionId: 's1', hostId: 'local' } };
  assert.equal(panelTabBody.subject({ tab: term }, ctx, route), null);
  assert.deepEqual(panelTabBody.twins[0].subject({ tab: term }), { type: 'Terminal', provider: 'codex', id: 's1' });
  assert.equal(panelTabBody.twins[0].subject({ tab: { ...term, props: { hostId: 'devbox' } } }), null, 'another host\'s');
  let laid = null;
  const props = { tab: plan, renderSlots: (arg) => { laid = arg; return null; } };
  const out = panelTabBody.slots.actions.apply(props, [{ rule: { mod: 'm', id: 'a' }, item: { id: 'x', title: 'Export' } }], { ...env, ctx });
  out.renderSlots({ headerRows: [{ id: 'app' }], content: 'body' });
  assert.deepEqual(laid.headerRows.map((r) => r.id), ['app', 'codexmods:actions']);
  assert.equal(laid.content, 'body');
  assert.equal(panelTabBody.slots.actions.apply(props, [], { ...env, ctx }), props, 'none: the app\'s own');
  // 22943: the body takes no renderSlots; the row goes into the layout function it hands its tab's renderPanel
  const panelArgs = [];
  const tab22943 = { ...plan, renderPanel: (scope, onClose, renderSlots, isVisible, isActive) => { panelArgs.push([scope, onClose, isVisible, isActive]); return renderSlots({ headerRows: [{ id: 'app' }], content: 'body' }); } };
  laid = null;
  const out2 = panelTabBody.slots.actions.apply({ tab: tab22943, controller: {}, isVisible: true, isActive: true }, [{ rule: { mod: 'm', id: 'a' }, item: { id: 'x', title: 'Export' } }], { ...env, ctx });
  assert.notEqual(out2.tab, tab22943, 'its own tab object is left as it was');
  assert.equal(out2.tab.tabId, plan.tabId);
  out2.tab.renderPanel('scope', 'close', (arg) => { laid = arg; return null; }, true, false);
  assert.deepEqual(laid.headerRows.map((r) => r.id), ['app', 'codexmods:actions']);
  assert.deepEqual(panelArgs, [['scope', 'close', true, false]]);
  assert.deepEqual([DECORATION_PLACES.Terminal, DECORATION_PLACES.Turn], [{ TerminalView: ['actions'] }, { TurnView: ['actions', 'badges'], PlanView: ['actions'] }]);
});

test('H5x review 1: a provided chat\'s composer gives its slash commands and mention sources the chat as the graph names it (its provider\'s Thread)', () => {
  const theirs = { type: 'Thread', provider: 'mod.a', id: 'x1' };
  const ctx = { thread: (id) => (id === 'pid-1' ? theirs : { type: 'CodexThread', provider: 'codex', id }), react: () => React,
    slashItems: () => ({ Registrar: 'Registrar' }), mentionSources: () => ({ Splice: 'Splice' }) };
  const scope = { kind: 'local', placement: 'main', conversationId: 'pid-1' };
  const factory = (T, p) => React.createElement(T, p);
  const slash = composerSuggest.render('List', {}, factory, ctx, scope);
  const registrar = slash.props.children.find((c) => c?.type === 'Registrar');
  assert.deepEqual([registrar.props.draft, registrar.props.thread], [{ type: 'Draft', provider: 'codex', id: 'pid-1' }, theirs]);
  assert.deepEqual(mentionList.render('List', {}, factory, ctx, scope).props.thread, theirs);
  assert.deepEqual(mentionList.render('List', {}, factory, ctx, { ...scope, conversationId: 't1' }).props.thread, { type: 'CodexThread', provider: 'codex', id: 't1' });
});

test('H7z: a model\'s row in the composer\'s model menu (marked by the pack, under a menu of this Mac\'s catalog) is a ListItem of this Mac\'s Model, its badges beside its name', () => {
  const near = (hostId) => ({ binding: 'picker.model', props: { hostId } });
  const row = { pickerRow: true, model: 'gpt-6-luna', displayName: 'GPT-6 Luna', stripGptPrefix: true };
  assert.deepEqual(modelRow.subject(row, {}, null, near('local')), { type: 'Model', provider: 'codex', id: 'gpt-6-luna' });
  assert.equal(modelRow.subject(row, {}, null, near('devbox')), null, 'another host\'s catalog');
  assert.equal(modelRow.subject(row, {}, null, near(undefined)), null, 'a pack without the identity props: no host, nothing');
  assert.equal(modelRow.subject({ ...row, pickerRow: undefined }, {}, null, near('local')), null, 'the menu\'s trigger or slider label');
  const ctx = { react: () => React, token: () => undefined };
  const out = modelRow.slots.badges.apply(row, entries('Cheap'), { R: React, ctx });
  const el = modelRow.render('Label', out, (T, p) => React.createElement(T, p), ctx);
  assert.equal(el.props.children.length, 2, 'the label, then its badge');
  assert.equal(modelRow.render('Label', row, () => assert.fail('no badges: the app\'s own'), ctx), undefined);
});

test('H5x review 2: a composer\'s own send is its editor\'s submit (it finishes a dictation first), else its Send button\'s; a skill\'s chip is put by its own controller', () => {
  const ran = [];
  const props = { viewProps: { editor: { onSubmit: () => ran.push('editor') } }, handleSubmit: () => ran.push('button') };
  assert.equal(composer.operations.submit(props), true);
  assert.equal(composer.operations.submit({ handleSubmit: () => ran.push('button') }), true);
  assert.deepEqual(ran, ['editor', 'button']);
  assert.equal(composer.operations.submit({}), false);
  const put = [];
  const rec = { context: { insertMentionAtSelection: (m) => put.push(m) } };
  assert.equal(composer.operations.insertSkill({}, [{ name: 'review', path: '/s/review/SKILL.md' }], {}, rec), true);
  assert.deepEqual(put, [{ kind: 'skill', name: 'review', displayName: 'review', path: '/s/review/SKILL.md', description: '', iconSmall: null }]);
  assert.equal(composer.operations.insertSkill({}, [{ name: 'x' }], {}, rec).unavailable, 'not a skill');
  assert.equal(composer.operations.insertSkill({}, [{ name: 'x', path: '/p' }], {}, { context: {} }), false);
});

test('H7x review 1: an agent\'s background terminal tab is the TerminalView of that command\'s Terminal; the tab host is a PlanView only where it names a plan', () => {
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  const body = { itemKey: 'k', terminalId: 'item-7', hostId: 'local', renderSlots: () => null, setTabState: () => {}, conversationId: 't1' };
  assert.deepEqual(terminalBackground.subject(body, {}, route), { type: 'Terminal', provider: 'codex', id: 'agent:t1:item-7' });
  assert.deepEqual(terminalBackground.place(body, route), { in: 'PanelTab', on: { type: 'Terminal', provider: 'codex', id: 'agent:t1:item-7' }, slot: 'view' });
  assert.equal(terminalBackground.subject({ ...body, hostId: 'devbox' }, {}, route), null);
  const tab = { tabId: 'background-terminal:t1:item-7', tabType: { kind: 'background-terminal' }, props: { conversationId: 't1', hostId: 'local', terminalId: 'item-7', itemKey: 'k' } };
  assert.deepEqual(panelTab.subject({ tab }, {}, route), { type: 'Terminal', provider: 'codex', id: 'agent:t1:item-7' }, 'its tab presents it too');
  assert.equal(terminalBackground.subjectOnly, true);
  assert.equal(panelTabBody.subjectOnly, true, 'the tab host takes PlanView\'s rules only where it names a plan the graph has');
});
