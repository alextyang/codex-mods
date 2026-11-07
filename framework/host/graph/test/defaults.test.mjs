// A mod's defaults (docs/design/public-hooks.md §3.8): checked; which apply to a new chat's Draft, in the mods' order, by their where.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDefaults, flatTarget, nestTarget, automationValues } from '../defaults.mjs';
import { createGraph } from '../index.mjs';
import { createPolicy } from '../policy.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { PRESENTATION_TYPES } from '../../../../sdk/graph/presentations.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';

const throwsInvalid = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });
const project = (id) => ({ type: 'LocalProject', provider: 'codex', id });

test('defaults: what a Draft\'s default is, field by field; a target as flat fields and back', () => {
  assert.equal(compileDefaults({ id: 'a', of: 'Draft', target: { settings: { effort: 'high' } } }).id, 'a');
  // a provided agent's own settings by id (public-hooks.md §3.15, H7pn review 1): a name, a number or a boolean
  assert.deepEqual(compileDefaults({ id: 'p', of: 'Draft', target: { settings: { tone: 'detailed', loud: true, level: 2, effort: 3, mode: false } } }).target.settings, { tone: 'detailed', loud: true, level: 2, effort: 3, mode: false }, 'an agent\'s own effort or mode may be a number or a boolean (H7pn review 2)');
  for (const [spec, re] of [[{ id: 'A', of: 'Draft', target: {} }, /^id/], [{ id: 'a', of: 'Thread', target: {} }, /of is "Draft"/], [{ id: 'a', of: 'Draft' }, /target or content/],
    [{ id: 'a', of: 'Draft', target: { agent: project('x') } }, /target\.agent/], [{ id: 'a', of: 'Draft', target: { model: 'gpt' } }, /target\.model is a ref/],
    [{ id: 'a', of: 'Draft', target: { settings: { access: 'full' } } }, /access is the user's/], [{ id: 'a', of: 'Draft', target: { settings: { effort: [2] } } }, /settings is \{id: value\}/], [{ id: 'a', of: 'Draft', content: 'hi' }, /content is/],
    [{ id: 'a', of: 'Draft', target: { environment: 'cloud' } }, /environment/], [{ id: 'a', of: 'Draft', where: { $nope: 1 }, content: { parts: [{ kind: 'text', text: 'x' }] } }, /where/]]) throwsInvalid(() => compileDefaults(spec), re);
  const t = { project: project('p'), settings: { effort: 'high', mode: 'plan' } };
  assert.deepEqual(flatTarget(t), { project: project('p'), 'settings.effort': 'high', 'settings.mode': 'plan' });
  assert.deepEqual(nestTarget(flatTarget(t)), t);
});

test('defaultsFor: those whose where holds on the Draft, in the order they came; a mod\'s go with it', () => {
  const g = createGraph();
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  g.defaults('mod:a', { id: 'p1', of: 'Draft', where: { 'target.project.id': 'p1' }, target: { settings: { effort: 'high' } } });
  g.defaults('mod:b', { id: 'all', of: 'Draft', content: { parts: [{ kind: 'text', text: 'Hi' }] } });
  const draft = (projectId) => ({ ref: { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, state: { content: { parts: [] }, dictating: false, target: { project: project(projectId), settings: {} } }, links: {} });
  assert.deepEqual(g.defaultsFor('Draft', draft('p1')).map((d) => [d.mod, d.id]), [['a', 'p1'], ['b', 'all']]);
  assert.deepEqual(g.defaultsFor('Draft', draft('p2')).map((d) => d.mod), ['b']);
  assert.throws(() => g.defaults('mod:a', { id: 'bad', of: 'Draft' }), /defaults:/);
  g.disposeOwner('mod:b');
  assert.deepEqual(g.defaultsFor('Draft', draft('p2')), []);
});

test('H6i: a Setting\'s default (its key and a JSON value) and an Automation\'s (the fields it may give); each needs the act grant its effect does', () => {
  assert.deepEqual(compileDefaults({ id: 's', of: 'Setting', key: 'appearanceTheme', value: 'dark' }).value, 'dark');
  assert.deepEqual(compileDefaults({ id: 'w', of: 'Automation', where: { 'project.id': 'p1' }, values: { where: 'worktree', notifications: 'failures', settings: { effort: 'high' } } }).values,
    { where: 'worktree', notifications: 'failures', settings: { effort: 'high' } });
  for (const [spec, re] of [[{ id: 's', of: 'Setting', key: 'k' }, /value/], [{ id: 's', of: 'Setting', key: 'k', value: null }, /value/], [{ id: 's', of: 'Setting', value: 1 }, /key/],
    [{ id: 's', of: 'Setting', key: 'k', value: 1, target: {} }, /target is not a field/], [{ id: 'w', of: 'Automation', values: { prompt: 'x' } }, /values\.prompt/],
    [{ id: 'w', of: 'Automation', values: { where: 'cloud' } }, /values\.where/], [{ id: 'w', of: 'Automation', values: {} }, /values give/]]) throwsInvalid(() => compileDefaults(spec), re);
  // allowed to act on settings and automations: registered; else refused
  const g = createGraph({ authorize: (caller, req) => caller.id !== 'mod:plain' || req.use !== 'act' });
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  g.defaults('mod:ok', { id: 's', of: 'Setting', key: 'appearanceTheme', value: 'dark' });
  g.defaults('mod:ok', { id: 'w', of: 'Automation', values: { archiveRuns: true } });
  assert.throws(() => g.defaults('mod:plain', { id: 's', of: 'Setting', key: 'appearanceTheme', value: 'dark' }), /graph\.act grant for Setting\.set/);
  assert.throws(() => g.defaults('mod:plain', { id: 'w', of: 'Automation', values: { archiveRuns: true } }), /graph\.act grant for Automation\.edit/);
  const setting = { ref: { type: 'Setting', provider: 'codex', id: 'appearanceTheme' }, state: {}, links: {} };
  assert.deepEqual(g.defaultsFor('Setting', setting).map((d) => [d.mod, d.key, d.value]), [['ok', 'appearanceTheme', 'dark']]);
  assert.deepEqual(g.defaultsFor('Automation', { ref: { type: 'Automation', provider: 'codex', id: '(new)' }, state: {}, links: {} }).map((d) => d.values), [{ archiveRuns: true }]);
});

test('H6j: an automation\'s defaults as one set of values: each field the first mod\'s, never one the spec gives, none of a chat run\'s when it watches a chat', () => {
  const list = [{ mod: 'a', values: { enabled: false, settings: { effort: 'low' } } }, { mod: 'b', values: { enabled: true, notifications: 'failures', project: { type: 'LocalProject', provider: 'codex', id: 'p' } } }];
  assert.deepEqual(automationValues(list), { enabled: false, settings: { effort: 'low' }, notifications: 'failures', project: { type: 'LocalProject', provider: 'codex', id: 'p' } });
  assert.deepEqual(automationValues(list, { notifications: 'all' }), { enabled: false, settings: { effort: 'low' }, project: { type: 'LocalProject', provider: 'codex', id: 'p' } });
  assert.deepEqual(automationValues(list, {}, true), { enabled: false, notifications: 'failures' });
});

test('graph-integrity G5.2: a presentation\'s default gives whether a new one is expanded, for its subject\'s type and where; its type is one the user expands, and its mod may run the operation it takes', () => {
  for (const [spec, re] of [
    [{ id: 'a', of: 'StepBlock', state: {} }, /state gives expanded/],
    [{ id: 'a', of: 'StepBlock', state: { size: { width: 3 } } }, /state\.size has no default/],
    [{ id: 'a', of: 'StepBlock', state: { expanded: 'yes' } }, /state\.expanded is not a valid/],
    [{ id: 'a', of: 'StepBlock', for: ['lower'], state: { expanded: true } }, /for is a type/],
    [{ id: 'a', of: 'StepBlock', where: { $nope: 1 }, state: { expanded: true } }, /where/],
    [{ id: 'a', of: 'StepBlock', target: {}, state: { expanded: true } }, /target is not a field/],
  ]) throwsInvalid(() => compileDefaults(spec), re);
  const d = compileDefaults({ id: 'a', of: 'StepBlock', for: 'CommandRun', state: { expanded: false } });
  assert.deepEqual([d.presentation, d.for, d.state], [true, ['CommandRun'], { expanded: false }]);
  const grants = { a: ['graph.read', 'graph.act:StepBlock._collapse'], b: ['graph.act:StepBlock._expand'] };
  const policy = createPolicy({ grantsOf: (id) => grants[id] ?? [], typeOf: (t) => g.type(t) });
  const g = createGraph({ authorize: policy.authorize });
  g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  g.registerTypes(PRESENTATION_TYPES.map(toDescriptor), 'native');
  assert.throws(() => g.defaults('mod:a', { id: 'x', of: 'Thread', state: { expanded: true } }), /not a presentation type/);
  assert.throws(() => g.defaults('mod:a', { id: 'x', of: 'Composer', state: { expanded: true } }), /not expanded or collapsed by the user/);
  assert.throws(() => g.defaults('mod:a', { id: 'x', of: 'StepBlock', for: 'Nope', state: { expanded: true } }), /for names Nope/);
  assert.throws(() => g.defaults('mod:a', { id: 'x', of: 'StepBlock', state: { expanded: true } }), /graph\.act grant for StepBlock\._expand/);
  g.defaults('mod:a', { id: 'done-shut', of: 'StepBlock', for: 'CommandRun', where: { status: 'done' }, state: { expanded: false } });
  g.defaults('mod:b', { id: 'all-open', of: 'StepBlock', state: { expanded: true } });
  const step = (type, status) => ({ ref: { type, provider: 'codex', id: 's1' }, state: { status }, links: {} });
  const of = (inst) => g.presentationDefaults('StepBlock', inst).map((x) => [x.mod, x.id, x.state.expanded]);
  assert.deepEqual(of(step('CodexCommandRun', 'done')), [['a', 'done-shut', false], ['b', 'all-open', true]], 'in the mods\' order');
  assert.deepEqual(of(step('CodexCommandRun', 'running')), [['b', 'all-open', true]], 'its where on the subject');
  assert.deepEqual(of(step('CodexReasoning', 'done')), [['b', 'all-open', true]], 'its for: the subject\'s type or concept');
  assert.deepEqual(g.presentationDefaults('TurnView', step('CodexCommandRun', 'done')), [], 'another presentation type');
  assert.deepEqual(g.defaultsFor('StepBlock', step('CodexCommandRun', 'done')), [], 'not a Draft\'s, a Setting\'s or an Automation\'s');
});
