// Attached data (docs/graph/04 §7, docs/design/public-hooks.md §3.3, graph-integrity G3.5): the store (attachments.mjs), a mod's named
// values and its declared ones (its settings of a chat or a project), and ctx.graph's attach, attached and reads as each reader may see
// them; the one `where` reaching attached data in list and views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachments, ATTACHED_FILE } from '../attachments.mjs';
import { createGraph } from '../index.mjs';
import { createGraphNs } from '../../ctx/graph.mjs';
import { toDescriptor, defineConcept, s, ev } from '../../../../sdk/graph/define.mjs';

const T = (id) => ({ type: 'Note', provider: 'notes', id });
const withDir = async (fn) => { const d = mkdtempSync(join(tmpdir(), 'cm-attach-')); try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('the store: private and shared values, the reader views, bounds, removal and deletion', () => withDir((dir) => {
  const changes = [];
  const a = createAttachments({ onChange: (ref, c) => changes.push([ref.id, c]), delayMs: 5, limits: { valueBytes: 64, perMod: 2 } });
  a.load('m.one', join(dir, 'one'));
  a.load('m.two', join(dir, 'two'));
  a.set('m.one', T('1'), 'tag', 'red');
  a.set('m.two', T('1'), 'tag', 'blue', { shared: true });
  assert.deepEqual(a.viewFor('m.one', T('1')), { 'm.one': { tag: 'red' }, 'm.two': { tag: 'blue' } }, 'its own and the shared');
  assert.deepEqual(a.viewFor('m.two', T('1')), { 'm.two': { tag: 'blue' } }, 'never another mod\'s private value');
  assert.deepEqual(a.viewFor('m.three', T('1')), { 'm.two': { tag: 'blue' } });
  assert.deepEqual(a.viewFor(null, T('1')), { attached: { 'm.one': { tag: 'red' }, 'm.two': { tag: 'blue' } }, private: ['m.one/tag'] }, 'the framework sees all, and which are private');
  assert.equal(a.viewFor('m.one', T('2')), undefined);
  assert.throws(() => a.set('m.one', T('2'), 'x', 'y'.repeat(100)), /at most 64 bytes/);
  a.set('m.one', T('2'), 'n', 1);
  assert.throws(() => a.set('m.one', T('3'), 'n', 1), /at most 2 values/);
  assert.throws(() => a.set('m.one', { provider: 'notes', id: '4' }, 'n', 1), /needs a ref/);
  assert.throws(() => a.set('m.one', T('2'), 'a.b', 1), /name is 1-64 letters/, 'a where reads `.` as a field');
  assert.throws(() => a.set('m.nobody', T('1'), 'n', 1), /not running/);
  assert.equal(a.set('m.one', T('2'), 'n', null).changed, true);
  assert.equal(a.set('m.one', T('2'), 'n', null).changed, false, 'nothing to remove');
  a.deleted(T('1'));
  assert.equal(a.viewFor(null, T('1')), undefined, 'a deleted instance takes every value with it');
  assert.deepEqual(changes.map(([id, c]) => [id, c.by, c.shared, c.wasShared]), [
    ['1', 'm.one', false, false], ['1', 'm.two', true, false], ['2', 'm.one', false, false], ['2', 'm.one', false, false],
    ['1', 'm.one', false, false], ['1', 'm.two', false, true]]);
}));

test('the store: kept in the mod\'s data directory, back after a restart; a type compared by its concept', () => withDir((dir) => {
  const a = createAttachments({ delayMs: 1 });
  a.load('m.one', dir);
  a.set('m.one', { type: 'CodexThread', provider: 'codex', id: 't1' }, 'tag', 'x', { shared: true });
  a.unload('m.one');
  const saved = JSON.parse(readFileSync(join(dir, ATTACHED_FILE), 'utf8'));
  assert.deepEqual(saved, { v: 2, entries: [{ ref: { type: 'CodexThread', provider: 'codex', id: 't1' }, name: 'tag', value: 'x', shared: true }] });
  const concept = { CodexThread: 'Thread', Thread: 'Thread' };
  const b = createAttachments({ sameConcept: (x, y) => (concept[x] ?? x) === (concept[y] ?? y) });
  b.load('m.one', dir);
  assert.deepEqual(b.viewFor('m.two', { type: 'Thread', provider: 'codex', id: 't1' }), { 'm.one': { tag: 'x' } }, 'a concept ref finds a subtype\'s value');
  assert.equal(b.viewFor('m.two', { type: 'Project', provider: 'codex', id: 't1' }), undefined, 'another concept with the same id does not');
  // a damaged file is left as it is; entries over the bounds are dropped on load
  mkdirSync(join(dir, 'bad'));
  writeFileSync(join(dir, 'bad', ATTACHED_FILE), '{nope');
  const warned = [];
  const c = createAttachments({ log: { warn: (m) => warned.push(m) } });
  c.load('m.bad', join(dir, 'bad'));
  assert.equal(readFileSync(join(dir, 'bad', ATTACHED_FILE), 'utf8'), '{nope');
  assert.equal(warned.length, 1);
}));

// ------------------------------------------------------------------ ctx.graph
const Note = defineConcept('Note', { state: { title: s.string() }, events: { deleted: ev() } });
function setup(dir) {
  const graph = createGraph();
  graph.registerTypes([toDescriptor(Note)], 'native');
  const provider = graph.registerProvider('native', 'notes', { types: { Note: {} } });
  provider.put(T('1'), { state: { title: 'One' } });
  provider.put(T('2'), { state: { title: 'Two' } });
  const ns = createGraphNs({ graph: () => graph });
  const scope = (id, grants, extra = {}) => ({ realm: 'host', state: { id, owner: `mod:${id}`, grants, ...extra } });
  for (const id of ['m.one', 'm.two', 'm.none']) graph.attachments.load(id, join(dir, id));
  return { graph, provider, ns, one: scope('m.one', ['graph', 'graph.read', 'graph.attach:Note']), two: scope('m.two', ['graph', 'graph.read', 'graph.attach']),
    none: scope('m.none', ['graph', 'graph.read']), framework: { realm: 'renderer', state: { id: 'codexmods.framework', framework: true, grants: ['graph'] } } };
}

test('ctx.graph: attach needs graph.attach (or its own instances); reads carry what each reader may see', () => withDir((dir) => {
  const { ns, one, two, none, framework } = setup(dir);
  const c = ns.calls;
  assert.equal(c.attach(none, T('1'), 'tag', 'x').reason, 'notAllowed', 'no graph.attach grant');
  assert.equal(c.attach(one, T('1'), 'tag', 'red').status, 'done');
  assert.equal(c.attach(two, T('1'), 'tag', 'blue', { shared: true }).status, 'done');
  assert.throws(() => c.attach(one, { type: 'Nope', provider: 'x', id: '1' }, 'n', 1), /unknown type/);
  assert.deepEqual(c.resolve(one, T('1')).attached, { 'm.one': { tag: 'red' }, 'm.two': { tag: 'blue' } });
  assert.deepEqual(c.resolve(two, T('1')).attached, { 'm.two': { tag: 'blue' } }, 'another mod\'s private value never leaves the Host');
  assert.deepEqual(c.attached(none, T('1')), { 'm.two': { tag: 'blue' } });
  assert.equal(c.resolve(none, T('2')).attached, undefined, 'none on that instance');
  const fw = c.resolve(framework, T('1'));
  assert.deepEqual([fw.attached, fw.attachedPrivate], [{ 'm.one': { tag: 'red' }, 'm.two': { tag: 'blue' } }, ['m.one/tag']], 'the page gets every value and which are private');
  // the one where reaches attached data, as the reader sees it
  assert.deepEqual(c.list(one, 'Note', { '@m.one/tag': 'red' }).map((x) => x.ref.id), ['1']);
  assert.deepEqual(c.list(two, 'Note', { '@m.one/tag': 'red' }).map((x) => x.ref.id), [], 'a private value does not select for another reader');
  assert.deepEqual(c.list(none, 'Note', { '@m.two/tag': { $exists: true } }).map((x) => x.ref.id), ['1']);
  assert.deepEqual(c.list(none, 'Note', { title: { $prefix: 'T' } }).map((x) => x.ref.id), ['2']);
  assert.throws(() => c.list(none, 'Note', { title: { $nope: 1 } }), /unknown operator/);
}));

test('ctx.graph: a view follows attached changes the reader may see, and membership by attached data', () => withDir(async (dir) => {
  const { ns, provider, one, two } = setup(dir);
  const got = { one: [], two: [] };
  const v1 = ns.subs.subscribe(one, [{ type: 'Note', where: { '@m.one/tag': 'red' } }, {}], (m) => { got.one.push(m); });
  const v2 = ns.subs.subscribe(two, [{ type: 'Note' }, {}], (m) => { got.two.push(m); });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got.one[0].items, []);
  ns.calls.attach(one, T('2'), 'tag', 'red');
  const added = got.one.find((m) => m.type === 'delta');
  assert.equal(added.event.kind, 'added', 'tagging it brings it into the view');
  assert.deepEqual(added.event.instance.attached, { 'm.one': { tag: 'red' } });
  assert.equal(added.event.attached, undefined, 'who changed what stays in the Host');
  assert.equal(got.two.filter((m) => m.type === 'delta').length, 0, 'another mod\'s private change is not told to m.two');
  ns.calls.attach(two, T('2'), 'note', 'mine', { shared: true });
  assert.equal(got.two.filter((m) => m.type === 'delta').length, 1);
  ns.calls.attach(one, T('2'), 'tag', null);
  assert.equal(got.one.at(-1).event.kind, 'removed', 'untagging it takes it out');
  provider.emit(T('2'), 'deleted');
  assert.deepEqual(ns.calls.attached(two, T('2')), {}, 'a deleted instance takes its values with it');
  v1.dispose(); v2.dispose();
}));

test('G3.5: a mod\'s declared values (its settings of a chat) are its shared values there; a declared name is never attached', () => withDir((dir) => {
  const changes = [];
  const a = createAttachments({ onChange: (ref, c) => changes.push([ref.id, c.by, c.shared]) });
  a.load('m.one', join(dir, 'one'));
  const stored = { '1': { 'm.one': { priority: 'high' } } };
  a.declare({ valuesAt: (ref) => stored[ref.id], names: (modId) => new Set(modId === 'm.one' ? ['priority'] : []) });
  a.set('m.one', T('1'), 'tag', 'red');
  assert.deepEqual(a.viewFor('m.two', T('1')), { 'm.one': { priority: 'high' } }, 'every reader sees a declared value; the private one stays');
  assert.deepEqual(a.viewFor('m.one', T('1')), { 'm.one': { tag: 'red', priority: 'high' } });
  assert.deepEqual(a.viewFor(null, T('1')).private, ['m.one/tag'], 'a declared value is never private');
  assert.throws(() => a.set('m.one', T('1'), 'priority', 'low'), /is a setting of this mod/);
  a.declaredChanged(T('1'), 'm.one');
  assert.deepEqual(changes.at(-1), ['1', 'm.one', true], 'its readers are told it changed');
  a.declare(null);
  assert.deepEqual(a.viewFor('m.two', T('1')), undefined);
}));
