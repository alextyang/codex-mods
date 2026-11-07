// ui.choices (docs/design/public-hooks.md §3.11): the plan of the rules naming a subject in a place, and the places that apply it: the
// model menu (rows and slider stops), the slash menu (commands and the /model and /reasoning submenus), the access menu (its container).
// The client and the Host: framework/host/test/ui-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { choicesPlan, applyChoices, madeOf } from '../present/choices.mjs';
import { modelPicker } from '../present/bindings/composer-picker.mjs';
import { slashMenu } from '../present/bindings/slash-menu.mjs';
import { accessMenu } from '../present/bindings/composer.mjs';

const rule = (subject, choices, extra = {}) => ({ mod: 'unit.c', id: extra.id ?? 'c', slot: subject, data: { choices, ...(extra.items ? { items: extra.items } : {}) }, ...extra });
const ctxWith = (bySubject, more = {}) => ({
  declared: (p, s) => (p === 'Choices' ? bySubject[s] ?? [] : []), guard: (r, fn) => fn, whereEnv: () => ({}), subject: () => undefined, use: (fn) => fn(), react: () => null, ...more,
});

test('the plan: hide by id, where or test; the first order; the first label per id; every added entry; only the rules naming the place', () => {
  const ctx = ctxWith({ Model: [
    rule('Model', { hide: ['a'], order: ['c', 'b'], label: { b: 'Bee' } }),
    rule('Model', { hide: { title: { $prefix: 'Old' } }, order: ['b'], label: { b: 'Not this one', c: { title: 'Sea', description: 'deep' } } }, { id: 'd', items: [{ id: 'x', title: 'Mine', run: () => 'ran' }] }),
    rule('Model', { in: ['slashMenu'], hide: ['c'] }, { id: 'e' }),
  ] });
  const plan = choicesPlan(ctx, 'Model', 'composer');
  assert.equal(plan.hides('a', null), true);
  assert.equal(plan.hides('c', null), false, 'a rule for another place');
  assert.equal(plan.hides('z', madeOf('Model', 'z', { title: 'Old z' })), true, 'a where on the offered entry');
  assert.deepEqual(plan.order, ['c', 'b']);
  assert.deepEqual([plan.labelOf('b'), plan.labelOf('c')], [{ title: 'Bee' }, { title: 'Sea', description: 'deep' }]);
  assert.deepEqual(plan.adds.map((a) => [a.id, a.title, a.run()]), [['codexmods:unit.c/d/x', 'Mine', 'ran']]);
  assert.equal(choicesPlan(ctx, 'effort', 'composer'), null);
  const list = ['a', 'b', 'sep', 'c', 'd'].map((id) => ({ id }));
  const out = applyChoices(list, plan, { idOf: (x) => (x.id === 'sep' ? null : x.id), keep: new Set(['a']), relabel: (x, l) => ({ ...x, title: l.title }), make: (a) => ({ id: a.id }) });
  assert.deepEqual(out.map((x) => x.id + (x.title ? `=${x.title}` : '')), ['c=Sea', 'b=Bee', 'sep', 'a', 'd', 'codexmods:unit.c/d/x'], 'the named first, in order; the kept one stays, after them; a non-entry keeps its place');
  const fn = choicesPlan(ctxWith({ SlashCommand: [{ mod: 'unit.c', id: 'f', data: { choices: {} }, fns: { choices: { hide: (x) => x.state.title === 'Fork' } } }] }), 'SlashCommand', 'slashMenu');
  assert.equal(fn.hides('fork', madeOf('SlashCommand', 'fork', { title: 'Fork' })), true, 'the renderer realm\'s test');
});

test('the model menu: rows and stops follow; the selected stays; at least two stops; an added model runs its callback, never the app\'s choice', () => {
  const model = (m, efforts = ['low', 'high']) => ({ model: m, displayName: m.toUpperCase(), supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e })) });
  const models = [model('a'), model('b'), model('c')];
  const props = {
    model: 'a', reasoningEffort: 'low', models, modelOptions: models.map((m) => ({ model: m, disabledReason: null })),
    powerSelections: ['a', 'b', 'c'].flatMap((m) => ['low', 'high'].map((e) => ({ id: `${m}:${e}`, model: m, modelLabel: m.toUpperCase(), reasoningEffort: e }))),
    onBeforeSelectModel: () => true, onOpenChange: () => {}, onSelectModel: () => {},
  };
  const ran = [];
  const ctx = ctxWith({
    Model: [rule('Model', { hide: ['a', 'b'], order: ['c'], label: { c: 'Sea' } }, { items: [{ id: 'mine', title: 'Mine', run: () => ran.push('mine') }] })],
    effort: [rule('effort', { hide: ['high'], label: { low: 'Light' } }, { id: 'e' })],
  });
  const factory = (type, p) => ({ type, props: p });
  const out = modelPicker.render('Menu', props, factory, ctx, { kind: 'local', placement: 'main', conversationId: 't1' }).props;
  assert.deepEqual(out.modelOptions.map((o) => [o.model.model, o.model.displayName]), [['c', 'Sea'], ['a', 'A'], ['codexmods:unit.c/c/mine', 'Mine']], 'a (selected) stays; b goes; c first and relabelled; the added one');
  assert.deepEqual(out.powerSelections.map((x) => x.id), ['a:low', 'c:low'], 'b\'s stops go; high goes (the selected a:low stays)');
  assert.deepEqual(out.powerSelections.map((x) => x.sliderLabel), ['A Light', 'Sea Light']);
  assert.equal(out.models.find((m) => m.model === 'c').displayName, 'Sea', 'the trigger reads its new name');
  assert.equal(out.onBeforeSelectModel('codexmods:unit.c/c/mine'), false, 'the app\'s choice is vetoed');
  assert.deepEqual(ran, ['mine']);
  assert.equal(out.onBeforeSelectModel('c'), true, 'the app\'s own models go on as before');
  // never fewer than two stops: hiding every effort but the selected one is not applied
  const few = modelPicker.render('Menu', props, factory, ctxWith({ effort: [rule('effort', { hide: ['high'] })], Model: [rule('Model', { hide: ['b', 'c'] })] }), { kind: 'new', entrypoint: 'home' }).props;
  assert.deepEqual(few.powerSelections.map((x) => x.id), ['a:low', 'a:high']);
  assert.equal(modelPicker.render('Menu', props, factory, ctxWith({}), null), undefined, 'no choices: the app\'s menu as it is');
  const again = modelPicker.render('Menu', props, factory, ctx, { kind: 'local', placement: 'main', conversationId: 't1' }).props;
  assert.equal(again.modelOptions, out.modelOptions, 'the same arrays while nothing changed (the menu\'s caches)');
});

test('the slash menu: commands hidden, relabelled and ordered (groups together, only before typing); /model and /reasoning follow the choices', () => {
  const cmd = (id, group) => ({ id, title: id, group, onSelect() {} });
  const autocomplete = { commands: [cmd('compact'), cmd('fork'), cmd('status'), cmd('skill:a', 'Skills'), cmd('skill:b', 'Skills')], ui: { query: '' },
    submenuSections: [{ id: 'recent-model-configurations', items: [{ id: 'a:low:x' }, { id: 'b:high:x' }] }, { id: 'models', items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', RightIcon: 'check' }] }, { id: 'reasoning-efforts', items: [{ id: 'low' }, { id: 'high' }] }] };
  const ctx = ctxWith({
    SlashCommand: [rule('SlashCommand', { hide: ['fork'], order: ['skill:b', 'status'], label: { status: { title: 'Where am I', description: 'the chat\'s state' } } })],
    Model: [rule('Model', { hide: ['b', 'a'] })], effort: [rule('effort', { hide: ['low'], label: { high: 'Deep' } })],
  });
  const factory = (type, p) => ({ type, props: p });
  const a = slashMenu.render('Drawer', { autocomplete, isHomeMenu: false }, factory, ctx).props.autocomplete;
  assert.deepEqual(a.commands.map((c) => c.id), ['skill:b', 'skill:a', 'status', 'compact'], 'ordered, a group\'s commands together (in the order the groups first come)');
  assert.deepEqual([a.commands[2].title, a.commands[2].description], ['Where am I', 'the chat\'s state']);
  assert.equal(typeof a.commands[2].onSelect, 'function', 'still the app\'s command');
  const [recent, models, efforts] = a.submenuSections;
  assert.deepEqual(recent.items.map((x) => x.id), [], 'a recent configuration goes with its model or its effort');
  assert.deepEqual(models.items.map((x) => x.id), ['b'], 'the selected model stays');
  assert.deepEqual(efforts.items.map((x) => [x.id, x.title]), [['high', 'Deep']]);
  const typed = slashMenu.render('Drawer', { autocomplete: { ...autocomplete, ui: { query: 'st' } } }, factory, ctx).props.autocomplete;
  assert.deepEqual(typed.commands.map((c) => c.id), ['compact', 'status', 'skill:a', 'skill:b'], 'typed: the app\'s ranking stands');
  const open = slashMenu.render('Drawer', { autocomplete: { ...autocomplete, submenuCommand: { id: 'fork' } } }, factory, ctx).props.autocomplete;
  assert.ok(open.commands.some((c) => c.id === 'fork'), 'the command whose submenu is open stays');
});

test('the access menu: the framework\'s container rewrites the finished menu\'s rows; the selected stays; a mod\'s entry is the app\'s item', () => {
  const { React: R } = createFakeReact();
  const e = R.createElement;
  const Item = function Item() {};
  const msg = (id) => e('FormattedMessage', { id });
  const ran = [];
  const ctx = ctxWith({ access: [rule('access', { hide: ['full', 'ask'], order: ['custom', 'approve'], label: { approve: { title: 'Reviewed by an agent' } } }, { items: [{ id: 'p', title: 'Policy', run: () => ran.push('p') }] })] },
    { react: () => R, exports: () => ({ MenuParts: { Item } }) });
  const factory = (type, p) => ({ type, props: p });
  const out = accessMenu.render('Dropdown', { conversationId: null, onOpenChange() {} }, factory, ctx);
  const Container = out.props.DropdownContainer;
  const rows = [e('Title', { key: 't' }, 'Approvals'), e(Item, { key: 'a', onClick() {}, RightIcon: 'check' }, msg('composer.permissionsDropdown.default.title')),
    e(Item, { key: 'g', onClick() {} }, msg('composer.permissionsDropdown.guardianApproval.title')), e(Item, { key: 'f', onClick() {} }, msg('composer.permissionsDropdown.fullAccess.title')),
    e(Item, { key: 'c', onClick() {} }, msg('composer.permissionsDropdown.custom.title'))];
  const menu = e('Menu', { triggerButton: 'trigger' }, ...rows);
  const shown = Container({ children: e(R.Fragment, null, menu) });
  const items = [].concat(shown.props.children.props.children);
  assert.deepEqual(items.map((x) => x.key), ['t', 'c', 'g', 'a', 'codexmods:unit.c/c/p'], 'full goes; custom, approve first in order; ask (selected) stays, after them; the added one');
  assert.equal(items[2].props.children, 'Reviewed by an agent');
  items[4].props.onClick();
  assert.deepEqual(ran, ['p']);
  assert.equal(accessMenu.render('Dropdown', { conversationId: null }, factory, ctxWith({})), undefined, 'no choices: the app\'s menu, no container');
});

test('Open in: a menu\'s external apps hidden, ordered and relabelled by target; a mod\'s entry runs its callback; the other entries stay', async () => {
  const { withOpenIn } = await import('../present/menus.mjs');
  const ran = [];
  const ctx = ctxWith({ ExternalApp: [rule('ExternalApp', { hide: ['terminal'], order: ['fileManager'], label: { vscode: 'Code (QA)' } }, { items: [{ id: 'mine', title: 'My editor', run: () => ran.push('mine') }] })] });
  const plan = choicesPlan(ctx, 'ExternalApp', 'menus');
  const target = (prefix, t) => ({ id: `${prefix}${t}`, message: { id: 'm', defaultMessage: t }, messageValues: { target: t }, onSelect() {} });
  const thread = [{ id: 'rename-thread' }, { id: 'open-workspace-in', submenu: ['vscode', 'terminal', 'fileManager'].map((t) => target('open-workspace-in-', t)) }];
  const out = withOpenIn(thread, plan);
  assert.equal(out[0].id, 'rename-thread');
  const sub = out[1].submenu;
  assert.deepEqual(sub.map((x) => x.id), ['open-workspace-in-fileManager', 'open-workspace-in-vscode', 'codexmods:unit.c/c/mine']);
  assert.equal(sub[1].message.defaultMessage, 'Code (QA)');
  sub[2].onSelect();
  assert.deepEqual(ran, ['mine']);
  const file = [{ id: 'file-link-primary' }, { id: 'file-link-targets', items: ['vscode', 'terminal'].map((t) => target('file-link-target-', t)) }];
  assert.deepEqual(withOpenIn(file, plan)[1].items.map((x) => x.id), ['file-link-target-vscode', 'codexmods:unit.c/c/mine'], 'a file\'s "Open in" too; its primary entry stays');
  assert.equal(withOpenIn(thread, null), thread, 'no choices: the menu as it is');
});

test('cloud environments: hidden, ordered and relabelled by id; the selected stays; none left says so', async () => {
  const { environmentList } = await import('../present/bindings/slash-menu.mjs');
  const envs = [{ id: 'e1', label: 'Alpha' }, { id: 'e2', label: 'Beta' }, { id: 'e3', label: 'Gamma' }];
  const factory = (type, p) => ({ type, props: p });
  const ctx = ctxWith({ Environment: [rule('Environment', { hide: { title: 'Alpha' }, order: ['e3'], label: { e2: 'Bee' } })] });
  const out = environmentList.render('Panel', { listToShow: envs, selectedEnvironment: null, envListState: 'list' }, factory, ctx).props;
  assert.deepEqual(out.listToShow.map((e) => [e.id, e.label]), [['e3', 'Gamma'], ['e2', 'Bee']]);
  const kept = environmentList.render('Panel', { listToShow: envs, selectedEnvironment: { id: 'e1' } }, factory, ctx).props;
  assert.ok(kept.listToShow.some((e) => e.id === 'e1'), 'the selected stays');
  const none = environmentList.render('Panel', { listToShow: [envs[0]], envListState: 'list' }, factory, ctx).props;
  assert.deepEqual([none.listToShow, none.envListState], [[], 'none-found']);
});

test('H7z review 1: a function hiding a Model of the graph reads it only where its mod may; the menu of this Mac\'s catalog reads its Models\' versions every render', () => {
  const seen = [];
  const model = { ref: { type: 'Model', provider: 'codex', id: 'gpt-x' }, state: { name: 'X' }, links: {}, version: 1 };
  const r = { mod: 'unit.c', id: 'f', slot: 'Model', data: { choices: {} }, fns: { choices: { hide: (x) => { seen.push(x.ref.id); return true; } } } };
  const may = { yes: true };
  const ctx = ctxWith({ Model: [r] }, { whereEnv: () => ({ may: () => may.yes }) });
  const plan = choicesPlan(ctx, 'Model', 'composer');
  assert.equal(plan.reads, true);
  assert.equal(plan.hides('gpt-x', model), true);
  may.yes = false;
  assert.equal(plan.hides('gpt-x', model), false, 'not readable: the function never sees it');
  assert.equal(plan.hides('gpt-x', madeOf('Model', 'gpt-x', { title: 'X' })), true, 'what the picker shows of it is always readable');
  assert.deepEqual(seen, ['gpt-x', 'gpt-x']);
  // the model menu: a Model's change (its version) gives a new list, read on every render
  const read = [];
  const versions = { 'gpt-x': 1 };
  const mctx = ctxWith({ Model: [{ mod: 'unit.c', id: 'g', slot: 'Model', data: { choices: { hide: { name: 'Hidden' } } } }] }, {
    react: () => createFakeReact().React, whereEnv: () => ({}), subject: (ref) => { read.push(ref.id); return { ref, state: { name: versions[ref.id] > 1 ? 'Hidden' : 'X' }, links: {}, version: versions[ref.id] }; } });
  const props = { hostId: 'local', model: 'gpt-y', modelOptions: [{ model: { model: 'gpt-x', displayName: 'X' } }, { model: { model: 'gpt-y', displayName: 'Y' } }], onOpenChange: () => {}, onSelectModel: () => {} };
  const factory = (T, p) => ({ type: T, props: p });
  const first = modelPicker.render('Menu', props, factory, mctx, { kind: 'local', placement: 'main', conversationId: 't1' });
  assert.equal(first.props.modelOptions.length, 2);
  versions['gpt-x'] = 2;
  const next = modelPicker.render('Menu', props, factory, mctx, { kind: 'local', placement: 'main', conversationId: 't1' });
  assert.deepEqual(next.props.modelOptions.map((o) => o.model.model), ['gpt-y'], 'its change is seen though the menu\'s props are the same');
  assert.ok(read.length >= 4, 'read on every render');
});

test('H7z review 2: the model menu works out which models it hides on every render: what they relate to and their data as each mod sees it', () => {
  const agents = new Map();
  const attached = { value: null, private: true };
  // the renderer's snapshot: every mod's data, those kept private named (its version is the instance's, not the data's)
  const model = (id) => ({ ref: { type: 'Model', provider: 'codex', id }, state: { name: id }, links: { agent: { type: 'Agent', provider: 'codex', id: 'codex' } }, version: 1,
    ...(attached.value ? { attached: { 'unit.a': attached.value }, attachedPrivate: attached.private ? Object.keys(attached.value).map((n) => `unit.a/${n}`) : [] } : {}) });
  const subject = (ref) => (ref.type === 'Agent' ? agents.get(ref.id) ?? null : model(ref.id));
  const rules = [
    { mod: 'unit.b', id: 'rel', slot: 'Model', data: { choices: { hide: { 'agent.name': 'Codex' } } } },
    { mod: 'unit.c', id: 'att', slot: 'Model', data: { choices: {} }, fns: { choices: { hide: (x) => x.attached?.['unit.a']?.hidden === true && x.ref.id === 'gpt-y' } } },
  ];
  const ctx = ctxWith({ Model: rules }, { react: () => createFakeReact().React, subject, whereEnv: () => ({
    relation: (t, name) => t === 'Model' && name === 'agent', related: (inst, name) => (name === 'agent' ? subject(inst.links.agent) : undefined) }) });
  const props = { hostId: 'local', model: 'gpt-z', modelOptions: ['gpt-x', 'gpt-y', 'gpt-z'].map((m) => ({ model: { model: m, displayName: m } })), onOpenChange: () => {}, onSelectModel: () => {} };
  const factory = (T, p) => ({ type: T, props: p });
  const draw = () => modelPicker.render('Menu', props, factory, ctx, { kind: 'local', placement: 'main', conversationId: 't1' }).props.modelOptions.map((o) => o.model.model);
  assert.deepEqual(draw(), ['gpt-x', 'gpt-y', 'gpt-z']);
  // the Agent arrives: the Models (unchanged) relate to it
  agents.set('codex', { ref: { type: 'Agent', provider: 'codex', id: 'codex' }, state: { name: 'Codex' }, links: {}, version: 1 });
  assert.deepEqual(draw(), ['gpt-z'], 'a relation\'s target seen (the selected one stays)');
  agents.clear();
  // a mod's data, private to it, is shared: another mod's function now sees it, though the Models' versions are the same
  attached.value = { hidden: true };
  assert.deepEqual(draw(), ['gpt-x', 'gpt-y', 'gpt-z']);
  attached.private = false;
  assert.deepEqual(draw(), ['gpt-x', 'gpt-z']);
});
