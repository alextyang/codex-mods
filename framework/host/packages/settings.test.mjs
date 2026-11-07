// A mod's settings as declarations, stored and effective values, and patches (docs/design/framework-ui.md F7; systems.md S13, S14, "E3 in detail").
import test from 'node:test';
import assert from 'node:assert/strict';
import { declarationsOf, checkDeclarations, applyPatches, effectiveOf, activeOf, documentOf, invalidStored, storedAt, validateValue, instanceId, parseInstanceId, scopeKeyOf, parseScopeKey, storedOverrides } from './settings.mjs';

const MODEL = { key: 'model', kind: 'choice', title: 'Model', description: 'Which model answers', default: 'sonnet', scope: 'thread', options: [{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }] };
const NOTES = { key: 'notes', kind: 'text', title: 'Notes', description: 'For a project', default: '', scope: 'project' };
const LIMIT = { key: 'limit', kind: 'number', title: 'Limit', default: 3, min: 1, max: 9 };
const FORM = [MODEL, { group: 'More', icon: 'bell', description: 'And the rest', items: [NOTES, LIMIT] }];
const T = { type: 'CodexThread', provider: 'codex', id: 't1' }, P = { type: 'LocalProject', provider: 'codex', id: 'p1' };

test('F7: a list of items and groups is checked: what a setting says, its default for its kind; any kind at any scope (graph-integrity G4.1)', () => {
  checkDeclarations(FORM);
  checkDeclarations([{ ...MODEL, kind: 'text', options: undefined, default: '' }, { ...LIMIT, scope: 'thread' }, { key: 'when', kind: 'time', title: 'When', default: '09:00', scope: 'thread' }]);
  const bad = (d, re) => assert.throws(() => checkDeclarations([{ ...MODEL, ...d }]), re);
  bad({ title: '' }, /title: is required/);
  bad({ default: 'opus' }, /must be one of/);
  bad({ key: '1x' }, /letters, digits/);
  bad({ other: 1 }, /other: is not a field of a setting/);
  bad({ control: 'slider' }, /control: must be one of select, segmented, thumbnails/);
  bad({ kind: 'toggle', options: undefined, default: true, control: 'select' }, /a toggle has one control/);
  bad({ min: 1 }, /min: is a number bound of a number/);
  bad({ unit: 'x' }, /only a number has a unit/);
  bad({ placeholder: 'x' }, /only a text or a list has a placeholder/);
  assert.throws(() => checkDeclarations([MODEL, MODEL]), /declared twice/);
  assert.throws(() => checkDeclarations([{ ...LIMIT, default: 12 }]), /must be <= 9/);
  assert.throws(() => checkDeclarations([{ ...LIMIT, step: 0 }]), /step: must be more than 0/);
  assert.throws(() => checkDeclarations({ type: 'object' }), /must be a list of settings and groups/, 'one form');
  assert.throws(() => checkDeclarations([{ group: 'A', items: [LIMIT] }, { group: 'a', items: [NOTES] }]), /a is a group already/);
  assert.throws(() => checkDeclarations([{ group: 'A', other: 1, items: [] }]), /other: is not a field of a group/);
  assert.throws(() => checkDeclarations([{ group: 'A', items: 'x' }]), /items: must be a list of settings/);
});

test('F7: declarations in one list, loose items first; a string option is its own value and label; scope is app when absent', () => {
  const { list, groups } = declarationsOf({ settings: [{ group: 'More', icon: 'bell', description: 'And the rest', media: { id: 'm', src: 'm.png' }, items: [NOTES] }, LIMIT, { key: 'seg', kind: 'choice', title: 'Seg', default: 'A', options: ['A', 'B'] }] });
  assert.deepEqual(list.map((d) => [d.key, d.scope, d.scopes.join(','), d.group ?? null]), [['limit', 'app', 'app', null], ['seg', 'app', 'app', null], ['notes', 'project', 'app,project', 'more']]);
  assert.deepEqual(list.find((d) => d.key === 'seg').choices, [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
  assert.equal(list.find((d) => d.key === 'notes').groupTitle, 'More');
  assert.deepEqual(groups, [{ id: 'more', title: 'More', icon: 'bell', description: 'And the rest', media: { id: 'm', src: 'm.png' } }]);
  assert.deepEqual(declarationsOf({}), { list: [], groups: [] });
});

test('F7: the new kinds check their values: a color, a time, a time range', () => {
  const ok = (kind, v) => validateValue({ key: 'x', kind }, v);
  const no = (kind, v, re) => assert.throws(() => ok(kind, v), re);
  assert.equal(ok('color', '#3A83f7'), '#3A83f7');
  for (const v of ['#FFF', 'red', 5]) no('color', v, /expected a color/);
  assert.equal(ok('time', '09:30'), '09:30');
  for (const v of ['9:30', '24:00', '09:60', 930]) no('time', v, /expected a time/);
  assert.deepEqual(ok('timerange', { from: '22:00', to: '07:00' }), { from: '22:00', to: '07:00' });
  for (const v of [{ from: '22:00' }, { from: '22:00', to: 'x' }, { from: '22:00', to: '07:00', on: 1 }, '22:00']) no('timerange', v, /expected \{from/);
});

test('F7: `requires` names a key it declares and no cycle; a row is active by what it requires at its own scope, and its parent; no value changes', () => {
  const a = { key: 'a', kind: 'toggle', title: 'A', default: false, scope: 'thread' };
  const b = { key: 'b', kind: 'text', title: 'B', default: '', requires: 'a' };
  const c = { key: 'c', kind: 'number', title: 'C', default: 1, requires: { key: 'b', not: '' } };
  checkDeclarations([a, b, c]);
  assert.throws(() => checkDeclarations([{ ...b, requires: 'gone' }]), /gone is not a setting of this mod/);
  assert.throws(() => checkDeclarations([{ ...b, requires: 'c' }, { ...c, requires: 'b' }]), /depends on itself/);
  assert.throws(() => checkDeclarations([{ ...b, requires: 'b' }]), /depends on itself/);
  assert.throws(() => checkDeclarations([a, { ...b, requires: { key: 'a' } }]), /requires: is a setting's key, or \{key, not\}/);
  const { list } = declarationsOf({ settings: [a, b, c] });
  const [da, db, dc] = list;
  assert.equal(activeOf(da, list, {}, {}), true, 'it requires nothing');
  assert.equal(activeOf(db, list, {}, {}), false);
  assert.equal(activeOf(db, list, { a: true }, {}), true);
  assert.equal(activeOf(dc, list, { a: true }, {}), false, '`not`: its value is that');
  assert.equal(activeOf(dc, list, { a: true, b: 'x' }, {}), true);
  assert.equal(activeOf(dc, list, { b: 'x' }, {}), false, 'its parent is not active');
  const tk = scopeKeyOf('thread', T);
  assert.equal(activeOf(db, list, {}, { [tk]: { a: true } }, { threadKey: tk }), true, 'at its instance\'s scope');
  assert.equal(activeOf(db, list, {}, { [tk]: { a: true } }, {}), false, 'and not at the app');
  assert.deepEqual(documentOf(list, { b: 'x' }), { a: false, b: 'x', c: 1 }, 'a row not active keeps its value');
});

test('F7: `needs` names a permission it declares', () => {
  checkDeclarations([{ ...LIMIT, needs: 'ui' }], 'settings', { permissions: ['ui'] });
  assert.throws(() => checkDeclarations([{ ...LIMIT, needs: 'network' }], 'settings', { permissions: ['ui'] }), /network is not a permission this mod declares/);
  assert.throws(() => checkDeclarations([{ ...LIMIT, needs: 5 }]), /needs: names a permission/);
});

test('effective values: thread, then its project, then the app, then the default; overridden means stored there, equal to the default or not; invalid values are passed over and reported', () => {
  const { list } = declarationsOf({ settings: FORM });
  const model = list.find((d) => d.key === 'model');
  const tk = scopeKeyOf('thread', T), pk = scopeKeyOf('project', P);
  let app = {}, scopes = {};
  ({ app, scopes } = applyPatches(list, app, scopes, [{ key: 'model', scope: 'app', value: 'haiku' }]));
  assert.deepEqual(effectiveOf(model, app, scopes, { threadKey: tk, projectKey: pk }), { value: 'haiku', source: 'app', overridden: false });
  ({ app, scopes } = applyPatches(list, app, scopes, [{ key: 'model', scope: { project: P }, value: 'sonnet' }]));
  assert.equal(effectiveOf(model, app, scopes, { threadKey: tk, projectKey: pk }).source, 'project', 'the thread inherits its project\'s');
  assert.deepEqual(effectiveOf(model, app, scopes, { at: 'project', projectKey: pk }), { value: 'sonnet', source: 'project', overridden: true }, 'stored there, though it equals the default: it shadows the app\'s');
  ({ app, scopes } = applyPatches(list, app, scopes, [{ key: 'model', scope: { thread: T }, value: 'haiku' }]));
  assert.deepEqual(effectiveOf(model, app, scopes, { threadKey: tk, projectKey: pk }), { value: 'haiku', source: 'thread', overridden: true });
  assert.equal(effectiveOf(model, app, scopes, { at: 'thread', threadKey: tk }).overridden, true);
  // A changed declaration: the stored value is kept and ignored, and reported.
  const narrowed = declarationsOf({ settings: [{ ...MODEL, options: [{ value: 'sonnet', label: 'Sonnet' }] }, NOTES, LIMIT] });
  const m2 = narrowed.list.find((d) => d.key === 'model');
  assert.deepEqual(effectiveOf(m2, app, scopes, { threadKey: tk, projectKey: pk }), { value: 'sonnet', source: 'project', overridden: false });
  assert.deepEqual(storedAt(m2, app, scopes, tk), { present: true, value: 'haiku' }, 'not deleted');
  assert.deepEqual(invalidStored(narrowed.list, { ...app, gone: 1 }, scopes).map((x) => `${x.key}@${x.scope}:${x.reason}`).sort(),
    ['gone@app:not declared', `model@${tk}:does not validate`, 'model@app:does not validate'].sort());
  // Unset removes the override; an empty scope map goes.
  ({ app, scopes } = applyPatches(list, app, scopes, [{ key: 'model', scope: { thread: T }, unset: true }]));
  assert.equal(scopes[tk], undefined);
  assert.deepEqual(documentOf(list, app), { model: 'haiku', notes: '', limit: 3 });
  assert.throws(() => applyPatches(list, app, scopes, [{ key: 'limit', scope: { thread: T }, value: 1 }]), /not set at a thread scope/);
  assert.deepEqual(applyPatches(list, { limit: 2 }, {}, [{ key: 'limit', scope: 'app', value: 2 }]).changed, [], 'what is stored changes nothing');
});

test('ids and scope keys: escaped, so no key reads as a scope; decoded exactly', () => {
  const id = instanceId('unit.a', 'x@thread:codex:t1', scopeKeyOf('thread', { provider: 'codex', id: 'a:b' }));
  assert.equal(id, 'unit.a/x%40thread%3Acodex%3At1@thread:codex:a%3Ab');
  assert.deepEqual(parseInstanceId(id), { modId: 'unit.a', key: 'x@thread:codex:t1', scopeKey: 'thread:codex:a%3Ab' });
  assert.deepEqual(parseScopeKey('thread:codex:a%3Ab'), { kind: 'thread', provider: 'codex', id: 'a:b' });
  assert.deepEqual(parseInstanceId('unit.a/limit'), { modId: 'unit.a', key: 'limit', scopeKey: null });
  assert.equal(parseInstanceId('unit.a/x/y'), null);
  assert.equal(parseInstanceId('Unit/x'), null);
});

test('E6: stored overrides as stored, valid or not; a clear patch removes one without judging it, only at a project\'s or a thread\'s scope', () => {
  const { list } = declarationsOf({ settings: [
    { key: 'mode', kind: 'choice', title: 'Mode', default: 'a', scope: 'thread', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'limit', kind: 'number', title: 'Limit', default: 1, scope: 'app' },
  ] });
  const t1 = scopeKeyOf('thread', { provider: 'codex', id: 't1' }), p1 = scopeKeyOf('project', { provider: 'codex', id: 'p1' });
  const scopes = { [t1]: { mode: 'b', gone: 1 }, [p1]: { limit: 5 } };
  assert.deepEqual(storedOverrides(list, {}, scopes).map((x) => [x.scope === t1 ? 't1' : 'p1', x.key, x.value, x.valid]),
    [['t1', 'mode', 'b', true], ['t1', 'gone', 1, false], ['p1', 'limit', 5, false]], 'not declared; not allowed at a project');
  const r = applyPatches(list, {}, scopes, [{ key: 'gone', scope: t1, clear: true }, { key: 'limit', scope: { project: { provider: 'codex', id: 'p1' } }, clear: true }]);
  assert.deepEqual(r.scopes, { [t1]: { mode: 'b' } });
  assert.deepEqual(r.changed, [{ key: 'gone', scope: t1 }, { key: 'limit', scope: p1 }]);
  assert.deepEqual(applyPatches(list, {}, scopes, [{ key: 'nothing', scope: t1, clear: true }]).changed, [], 'nothing stored: nothing changes');
  assert.throws(() => applyPatches(list, {}, scopes, [{ key: 'limit', scope: 'app', clear: true }]), /a clear patch is for a project's or a thread's scope/);
});
