// The mods' settings as graph Settings (docs/design/systems.md S13, S14, "E3 in detail"): sections under the Mods section, a Setting per
// declaration at the app scope and at the scopes where a value is stored or whose `settings` are read (contributed, graph-integrity G3.4),
// effective values through a thread's project, the values set on a chat or a project as the mod's shared attached values there (G3.5),
// `set` and `reset` as scoped patches answered when their operation ends, and who may read and act on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { createPolicy } from '../../../policy.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { FRAMEWORK_TYPES } from '../../../../../../sdk/graph/framework.mjs';
import { createFrameworkSource, PROVIDER } from '../index.mjs';
import { declarationsOf, applyPatches, documentOf, invalidStored } from '../../../../packages/settings.mjs';

const USER = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });
const DECLS = [
  { key: 'model', kind: 'choice', title: 'Model', description: 'Which model', default: 'a', scope: 'thread', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { group: 'More', icon: 'bell', description: 'And the rest', media: { id: 'pic', src: 'pic.png', caption: 'A picture' }, items: [
    { key: 'limit', kind: 'number', control: 'slider', title: 'Limit', description: 'How many', default: 3, min: 1, max: 9, step: 2, unit: 'items' },
    { key: 'flag', kind: 'toggle', title: 'Flag', default: false },
    { key: 'extra', kind: 'text', title: 'Extra', default: '', placeholder: 'Say', requires: 'flag' },
    { key: 'rows', kind: 'list', title: 'Rows', default: [], schema: { type: 'object' } },
    { key: 'names', kind: 'list', title: 'Names', default: [] },
  ] },
];
const S = (id) => ({ type: 'Setting', provider: PROVIDER, id });

/** A management stand-in with one mod with settings; `mods.configure` applies patches and finishes its operation. */
function fakeManagement(decls = DECLS) {
  const manifest = { id: 'unit.a', name: 'Unit A', permissions: [], settings: decls };
  const store = { app: {}, scopes: { 'project:codex:p1': { model: 'b' } } };
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  let next = 1;
  const record = { id: 'unit.a', name: 'Unit A', version: '1.0.0', status: 'enabled', dev: false, publisherFingerprint: null, compatibility: 'compatible', hasSettings: true, pendingUpdate: null, quarantine: null };
  const results = {
    'mods.list': () => ({ mods: [record] }),
    'mods.inspect': () => ({ ...record, manifest, grants: [] }),
    'compat.report': () => ({ mods: {} }),
    'ops.list': () => ({ ops: [] }),
    'ops.get': ({ opId }) => ({ id: opId, input: { type: 'configure', modId: 'unit.a' }, outcome: 'running', phases: [], startedAt: '2026-10-27T10:00:00.000Z' }),
    'diagnostics': () => ({ host: { safeMode: false } }),
    'updates.status': () => ({ framework: { current: '0.9.0' }, lkg: null }),
    'mods.settings': () => {
      const { list, groups } = declarationsOf(manifest);
      return { modId: 'unit.a', declarations: list, groups, app: store.app, scopes: store.scopes, document: documentOf(list, store.app), invalid: invalidStored(list, store.app, store.scopes) };
    },
  };
  return {
    store,
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    async handle({ id, method, params }) {
      if (results[method]) return { id, ok: true, result: results[method](params ?? {}) };
      if (method === 'mods.configure') {
        const { list } = declarationsOf(manifest);
        let r;
        try { r = applyPatches(list, store.app, store.scopes, params.patches); } catch (e) { return { id, ok: false, error: { code: e.code, message: e.message } }; }
        if (!r.changed.length) return { id, ok: true, result: { opId: null, unchanged: true } };
        const opId = `op-${String(next++).padStart(16, '0')}`;
        setTimeout(() => {
          store.app = r.app; store.scopes = r.scopes;
          emit({ event: 'op', data: { id: opId, input: { type: 'configure', modId: 'unit.a' }, outcome: 'succeeded', phases: [], startedAt: '2026-10-27T10:00:00.000Z' } });
          emit({ event: 'settings', data: { modId: 'unit.a' } });
        }, 5);
        return { id, ok: true, result: { opId } };
      }
      return { id, ok: false, error: { code: 'Invalid', message: `unknown ${method}` } };
    },
  };
}

async function setup(grants = new Map(), decls = DECLS) {
  let graph = null;
  const policy = createPolicy({ grantsOf: (id) => grants.get(id), typeOf: (id) => graph.type(id) });
  graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  graph.registerTypes(FRAMEWORK_TYPES.map(toDescriptor), 'framework');
  const management = fakeManagement(decls);
  const source = createFrameworkSource({ graph, management, frameworkVersion: '0.9.0' });
  await source.ready;
  await new Promise((r) => setTimeout(r, 10));
  return { graph, management, source, policy, grants };
}

test('a mod\'s settings: its section under the Mods section, a Setting per declaration at the app scope, linked from its Mod', async () => {
  const { graph } = await setup();
  const modSnap = graph.resolve({ type: 'Mod', provider: PROVIDER, id: 'unit.a' });
  assert.deepEqual(modSnap.links.settings, { type: 'SettingsSection', provider: PROVIDER, id: 'mod:unit.a' });
  const section = graph.resolve(modSnap.links.settings);
  assert.deepEqual([section.state.title, section.links.parent.id], ['Unit A', 'codexmods']);
  assert.deepEqual(graph.related(modSnap.links.settings, 'settings').map((x) => x.ref.id), ['unit.a/model']);
  const limit = graph.resolve(S('unit.a/limit'));
  assert.deepEqual([limit.state.value, limit.state.scope, limit.state.overridden, limit.state.scopes, limit.links.section.id], [3, 'app', false, ['app'], 'mod:unit.a:more']);
  const model = graph.resolve(S('unit.a/model'));
  assert.deepEqual([model.state.choices.map((c) => c.id), model.links.definedBy, model.state.key, model.state.scopes],
    [['"a"', '"b"'], { type: 'Mod', provider: PROVIDER, id: 'unit.a' }, 'model', ['app', 'project', 'thread']]);
  assert.equal(graph.resolve(S('unit.a/model@project:codex:p1')), null, 'a stored override of a project not in the graph: no instance (the value stays)');
});

test('G3.4: a chat\'s instances are contributed when its settings are read: its project\'s value until it has its own; set and reset answer when their operation ends', async () => {
  const { graph, management } = await setup();
  // a chat of the native provider's in project p1 (whose value is stored), as the graph has them
  const codex = graph.registerProvider('native', 'codex', { types: { CodexAgent: {}, CodexThread: {}, Project: {} } });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  const TH = { type: 'CodexThread', provider: 'codex', id: 't2' }, PJ = { type: 'Project', provider: 'codex', id: 'p1' };
  codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(PJ, { state: { name: 'P1', location: '/p1' } });
  codex.put(TH, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent, project: PJ } });
  const mine = () => graph.related(TH, 'settings').find((x) => x.links.definedBy?.id === 'unit.a' && x.state.key === 'model') ?? null;
  assert.equal(mine(), null, 'nothing of the chat\'s until its settings are read');
  await graph.materialize(TH, 'settings');
  let inst = mine();
  assert.deepEqual([inst.state.value, inst.state.overridden, inst.state.scope, inst.links.thread.id], ['b', false, 'thread', 't2'], 'the project\'s value');
  // a mod's value set on the project is its shared attached value there (G3.5), as any reader sees it
  assert.deepEqual(graph.attachments.viewFor('another.mod', PJ), { 'unit.a': { model: 'b' } });
  assert.equal(graph.attachments.viewFor('another.mod', TH), undefined, 'none set on the chat yet');
  const out = await graph.invoke({ ref: inst.ref, operation: 'set', args: ['a'], caller: USER });
  assert.equal(out.status, 'done');
  assert.deepEqual(management.store.scopes['thread:codex:t2'], { model: 'a' });
  inst = mine();
  assert.deepEqual([inst.state.value, inst.state.overridden], ['a', true]);
  assert.deepEqual(graph.attachments.viewFor('another.mod', TH), { 'unit.a': { model: 'a' } }, 'set on the chat: its value there');
  assert.deepEqual(graph.list('CodexThread', { '@unit.a/model': 'a' }, (x, m) => graph.attachments.viewFor('another.mod', x.ref)?.[m]).map((x) => x.ref.id), ['t2'], 'a query finds chats by it');
  assert.equal((await graph.invoke({ ref: inst.ref, operation: 'set', args: ['a'], caller: USER })).status, 'done', 'unchanged: no operation');
  assert.equal((await graph.invoke({ ref: inst.ref, operation: 'reset', caller: USER })).status, 'done');
  assert.deepEqual([mine().state.value, mine().state.overridden], ['b', false]);
  assert.equal(graph.attachments.viewFor('another.mod', TH), undefined);
  const bad = await graph.invoke({ ref: S('unit.a/limit'), operation: 'set', args: ['x'], caller: USER });
  assert.equal(bad.status, 'failed');
});

test('graph-integrity G4.1: every kind at a chat\'s scope round-trips through Setting.set and reset, each value of its kind', async () => {
  const decls = [
    { key: 'budget', kind: 'number', title: 'Budget', default: 3, min: 1, max: 9, scope: 'thread' },
    { key: 'note', kind: 'text', title: 'Note', default: '', scope: 'thread' },
    { key: 'tags', kind: 'list', title: 'Tags', default: [], scope: 'thread' },
    { key: 'when', kind: 'time', title: 'When', default: '09:00', scope: 'thread' },
  ];
  const { graph, management } = await setup(new Map(), decls);
  const codex = graph.registerProvider('native', 'codex', { types: { CodexAgent: {}, CodexThread: {} } });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  const TH = { type: 'CodexThread', provider: 'codex', id: 't7' };
  codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(TH, { state: { title: 'Kinds', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent } });
  await graph.materialize(TH, 'settings');
  const of = (key) => graph.related(TH, 'settings').find((x) => x.links.definedBy?.id === 'unit.a' && x.state.key === key);
  assert.deepEqual(['budget', 'note', 'tags', 'when'].map((k) => [k, of(k)?.state.kind, of(k)?.state.scope]), [['budget', 'number', 'thread'], ['note', 'text', 'thread'], ['tags', 'list', 'thread'], ['when', 'time', 'thread']]);
  for (const [key, value] of [['budget', 7], ['note', 'Only for this chat'], ['tags', ['a', 'b']], ['when', '18:30']]) {
    assert.equal((await graph.invoke({ ref: of(key).ref, operation: 'set', args: [value], caller: USER })).status, 'done', key);
    assert.deepEqual([of(key).state.value, of(key).state.overridden], [value, true], key);
  }
  assert.deepEqual(management.store.scopes['thread:codex:t7'], { budget: 7, note: 'Only for this chat', tags: ['a', 'b'], when: '18:30' });
  for (const [key, value] of [['budget', 12], ['budget', 'x'], ['when', '25:00'], ['tags', 'a']]) {
    assert.equal((await graph.invoke({ ref: of(key).ref, operation: 'set', args: [value], caller: USER })).status, 'failed', `${key} ${JSON.stringify(value)}`);
  }
  assert.equal((await graph.invoke({ ref: of('note').ref, operation: 'reset', caller: USER })).status, 'done');
  assert.deepEqual([of('note').state.value, of('note').state.overridden], ['', false]);
});

test('F7: a Setting says how it is drawn and whether it is active at its scope; a section says what it says of itself; a row that goes inactive keeps its value', async () => {
  const { graph, management } = await setup();
  const section = graph.resolve({ type: 'SettingsSection', provider: PROVIDER, id: 'mod:unit.a:more' });
  assert.deepEqual([section.state.title, section.state.description, section.state.icon, section.state.media], ['More', 'And the rest', 'bell', { id: 'pic', caption: 'A picture' }], 'its package path stays in the Host');
  const limit = graph.resolve(S('unit.a/limit')).state;
  assert.deepEqual([limit.control, limit.min, limit.max, limit.step, limit.unit, limit.group, limit.active], ['slider', 1, 9, 2, 'items', 'more', true]);
  const extra = () => graph.resolve(S('unit.a/extra')).state;
  assert.deepEqual([extra().placeholder, extra().requires, extra().active], ['Say', { key: 'flag' }, false]);
  assert.equal(graph.resolve(S('unit.a/rows')).state.structured, true);
  assert.equal(graph.resolve(S('unit.a/names')).state.structured, undefined);
  assert.equal((await graph.invoke({ ref: S('unit.a/extra'), operation: 'set', args: ['kept'], caller: USER })).status, 'done', 'a row not active can still be set');
  assert.equal((await graph.invoke({ ref: S('unit.a/flag'), operation: 'set', args: [true], caller: USER })).status, 'done');
  assert.equal(extra().active, true);
  assert.equal((await graph.invoke({ ref: S('unit.a/flag'), operation: 'reset', args: [], caller: USER })).status, 'done');
  assert.deepEqual([extra().active, extra().value], [false, 'kept']);
  assert.equal(management.store.app.extra, 'kept');
});

test('F7: resetAll takes every value stored at the app scope in its section, hidden rows included, and no project\'s or chat\'s', async () => {
  const { graph, management } = await setup();
  const SECTION = { type: 'SettingsSection', provider: PROVIDER, id: 'mod:unit.a:more' };
  management.store.scopes = { 'thread:codex:t1': { model: 'b' } };
  for (const [k, v] of [['extra', 'x'], ['limit', 5]]) assert.equal((await graph.invoke({ ref: S(`unit.a/${k}`), operation: 'set', args: [v], caller: USER })).status, 'done');
  assert.equal((await graph.invoke({ ref: S('unit.a/model'), operation: 'set', args: ['b'], caller: USER })).status, 'done', 'of another section');
  assert.equal((await graph.invoke({ ref: SECTION, operation: 'resetAll', args: [], caller: USER })).status, 'done');
  assert.deepEqual(management.store.app, { model: 'b' });
  assert.deepEqual(management.store.scopes, { 'thread:codex:t1': { model: 'b' } });
  assert.equal((await graph.invoke({ ref: SECTION, operation: 'resetAll', args: [], caller: USER })).status, 'done', 'nothing stored: nothing to do');
  assert.equal((await graph.invoke({ ref: SECTION, operation: 'resetAll', args: [], caller: mod('other.mod') })).status, 'refused', 'a mod does not act on another\'s');
});

test('who may: a mod reads and acts on its own settings only; another mod\'s with graph.read to read, never to act; no interceptor sees them', async () => {
  const grants = new Map([['unit.a', []], ['unit.b', ['graph.read', 'graph.act', 'graph.intercept']]]);
  const { graph, policy } = await setup(grants);
  const limit = graph.resolve(S('unit.a/limit')).ref;
  assert.equal(policy.allows(mod('unit.a'), 'read', 'Setting', limit), true, 'its own');
  assert.equal(policy.allows(mod('unit.a'), 'act', 'Setting', limit, 'set'), true);
  assert.equal(policy.allows(mod('unit.b'), 'read', 'Setting', limit), true, 'another\'s, with graph.read');
  assert.equal(policy.allows(mod('unit.b'), 'act', 'Setting', limit, 'set'), false, 'never another\'s, whatever it was granted');
  assert.equal(policy.allows(mod('unit.b'), 'intercept', 'Setting', limit, 'set'), false);
  assert.equal(policy.allows(mod('unit.a'), 'intercept', 'Setting', limit, 'set'), false, 'not even its own');
  assert.equal(policy.allows(mod('unit.a.x'), 'act', 'Setting', limit, 'set'), false, 'the mod is decoded exactly');
  assert.equal(policy.allows(mod('unit.c'), 'read', 'SettingsSection', { type: 'SettingsSection', provider: PROVIDER, id: 'codexmods' }), true, 'the Mods section');
  assert.equal(policy.allows(mod('unit.c'), 'read', 'SettingsSection', { type: 'SettingsSection', provider: PROVIDER, id: 'mod:unit.a' }), false);
  assert.equal((await graph.invoke({ ref: limit, operation: 'set', args: [5], caller: mod('unit.b') })).reason, 'notAllowed');
});
