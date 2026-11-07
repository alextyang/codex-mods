// Contributions (graph-integrity G3): a mod's instances linked to another provider's, under authority (`graph.read` for the target's type,
// `graph.contribute` for its concept, G3.2); asked for when someone reads what they add to (G3.4: an inverse relation, or a type's instances
// pinned to the target); gone with their contributor; relations to a list of concepts (G3.3: Setting.definedBy) queried as any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../index.mjs';
import { createPolicy } from '../policy.mjs';
import { createGraphNs } from '../../ctx/graph.mjs';
import { toDescriptor, defineConcept, r, s } from '../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../sdk/graph/native/index.mjs';
import { FRAMEWORK_TYPES } from '../../../../sdk/graph/framework.mjs';

const AGENT = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
const CHAT = { type: 'CodexThread', provider: 'codex', id: 't1' };
const SECTION = { type: 'SettingsSection', provider: 'codex', id: 'agent' };
const Note = defineConcept('Note', { state: { text: s.string() }, relations: { thread: r.one('Thread') } });

/** A graph with the real policy, the native chat it adds to, and a mod's scope through ctx.graph. */
function setup() {
  const grants = new Map();
  let graph = null;
  const policy = createPolicy({ grantsOf: (id) => grants.get(id), typeOf: (id) => graph.type(id), canonicalOf: (r) => graph.resolve(r)?.ref?.type ?? null });
  graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  graph.registerTypes(FRAMEWORK_TYPES.map(toDescriptor), 'framework');
  const codex = graph.registerProvider('native', 'codex', { types: { CodexAgent: {}, CodexThread: {}, SettingsSection: {} } });
  codex.put(AGENT, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(CHAT, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent: AGENT } });
  codex.put(SECTION, { state: { title: 'Agent' }, links: {} });
  const ns = createGraphNs({ graph: () => graph });
  const scope = (id, granted) => { grants.set(id, granted); return { realm: 'host', state: { id, owner: `mod:${id}`, grants: granted } }; };
  return { graph, ns, scope, grants, codex };
}
/** A mod's provider through ctx.graph: its observe calls recorded, answered by `onObserve`. */
function provide(ns, sc, spec, onObserve = () => null) {
  const asked = [];
  const handle = ns.handlers.provide(sc, [spec], async ([kind, query]) => { if (kind === 'observe') { asked.push(query); return onObserve(query); } return null; });
  return { asked, handle };
}
const NOTE = (id) => ({ type: 'Note', provider: 'acme.notes', id });

test('G3.2: a link to another provider\'s instance needs graph.read for its type and graph.contribute for its concept; its own Mod needs neither', () => {
  const { graph, ns, scope } = setup();
  graph.registerTypes([toDescriptor(Note)], 'mod:acme.notes');
  const put = (sc) => ns.calls.put(sc, NOTE('n1'), { state: { text: 'hi' }, links: { thread: CHAT } });
  const none = scope('acme.notes', ['graph']);
  provide(ns, none, { types: { Note: {} } });
  assert.throws(() => put(none), (e) => e.code === 'Denied' && /linking needs graph\.read/.test(e.message));
  none.state.grants = ['graph', 'graph.read:Thread', 'graph.contribute:Project'];
  scope('acme.notes', none.state.grants);
  assert.throws(() => put(none), (e) => e.code === 'Denied' && /needs graph\.contribute:Thread/.test(e.message), 'a grant for another concept is not one for this');
  scope('acme.notes', ['graph', 'graph.read:Thread', 'graph.contribute:Thread']);
  put(none);
  assert.deepEqual(graph.referrers(CHAT, 'thread').map((x) => x.ref.id), ['n1'], 'its note is the chat\'s now, as any referrer is');
  // a mod's own Setting may name its own Mod (what defined it) and its own section, with no grant for either; another mod's Mod, never
  const own = scope('acme.own', ['graph']);
  provide(ns, own, { types: { Setting: {}, SettingsSection: {} } });
  const mine = { type: 'SettingsSection', provider: 'acme.own', id: 's' };
  ns.calls.put(own, mine, { state: { title: 'Own' }, links: {} });
  const setting = (by) => ({ state: { title: 'Mode', key: 'mode', value: 'a', default: 'a', scope: 'app', kind: 'text' }, links: { section: mine, definedBy: by } });
  ns.calls.put(own, { type: 'Setting', provider: 'acme.own', id: 'mode' }, setting({ type: 'Mod', provider: 'codexmods.framework', id: 'acme.own' }));
  assert.throws(() => ns.calls.put(own, { type: 'Setting', provider: 'acme.own', id: 'x' }, setting({ type: 'Mod', provider: 'codexmods.framework', id: 'other.mod' })), (e) => e.code === 'Denied');
});

test('G3.4: a contributor is asked when what it adds to is read (an inverse relation, or its type pinned to the target), and its instances go with it', async () => {
  const { graph, ns, scope } = setup();
  const sc = scope('acme.modes', ['graph', 'graph.read', 'graph.contribute:Thread']);
  const own = { type: 'SettingsSection', provider: 'acme.modes', id: 's' }, by = { type: 'Mod', provider: 'codexmods.framework', id: 'acme.modes' };
  const { asked, handle } = provide(ns, sc, { types: { Setting: {}, SettingsSection: {} }, contributes: [{ type: 'Setting', via: 'thread' }] }, (q) => {
    // its value for that chat, put when asked (and only then: a chat no one reads gets none); its own section and Mod need no grant
    ns.calls.put(sc, { type: 'Setting', provider: 'acme.modes', id: `mode@${q.target.id}` }, { state: { title: 'Mode', key: 'mode', value: 'fast', default: 'slow', scope: 'thread', kind: 'text' },
      links: { section: own, definedBy: by, thread: q.target } });
  });
  ns.calls.put(sc, own, { state: { title: 'Modes' }, links: {} });
  assert.equal(graph.list('Setting').length, 0, 'nothing until a read');
  const settings = await ns.calls.related(sc, CHAT, 'settings');
  assert.deepEqual(asked, [{ target: { type: 'CodexThread', provider: 'codex', id: 't1' }, relation: 'thread' }], 'asked for that chat, through its relation');
  assert.deepEqual(settings.map((x) => [x.state.key, x.state.value]), [['mode', 'fast']], 'and the read has it');
  // a query pinned to the chat asks too; a view's `loaded` waits for it
  const page = await ns.calls.query(sc, { type: 'Setting', where: { thread: CHAT } });
  assert.deepEqual(page.items.map((x) => x.ref.id), ['mode@t1']);
  assert.equal(asked.length, 2);
  const view = graph.subscribe({ ref: CHAT, relation: 'settings' }, () => true);
  await view.loaded;
  assert.equal(asked.length, 3);
  view.dispose?.();
  // a provider that contributes says what to, and is asked for it
  assert.throws(() => graph.registerProvider('native', 'x', { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'section' }] }), /onObserve/);
  assert.throws(() => graph.registerProvider('native', 'y', { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'nope' }], onObserve() {} }), /contributes is a list/);
  // its stop takes its contributions away (G3.1: they are its own)
  handle.dispose();
  assert.deepEqual(graph.related(CHAT, 'settings'), []);
});

test('G3.4: a slow contributor adds nothing to the read past its deadline; a failing one is logged and the read goes on', async () => {
  const warned = [];
  const graph = createGraph({ log: { info() {}, warn: (m) => warned.push(m), error() {}, debug() {} } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const codex = graph.registerProvider('native', 'codex', { types: { CodexAgent: {}, CodexThread: {} } });
  codex.put(AGENT, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(CHAT, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent: AGENT } });
  graph.registerProvider('native', 'slow', { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'thread' }], onObserve: () => new Promise(() => {}) });
  graph.registerProvider('native', 'bad', { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'thread' }], onObserve: () => { throw new Error('no'); } });
  const t0 = Date.now();
  await graph.materialize(CHAT, 'settings');
  const took = Date.now() - t0;
  assert.ok(took >= 1900 && took < 4000, `bounded by the read's deadline (${took} ms)`);
  assert.deepEqual(warned, ['a provider did not put its contributions']);
  assert.equal(graph.materialize(AGENT, 'threads'), null, 'nothing contributes there: the read goes on at once');
});

test('G3.3: a relation to a list of concepts takes an instance of any of them and no other, and a where filters on it', () => {
  const { graph, ns, scope, codex } = setup();
  graph.registerProvider('native', 'set', { types: { Setting: {} } });
  const p = graph.registerProvider('native', 'defs', { types: { Setting: {} } });
  const put = (id, by) => p.put({ type: 'Setting', provider: 'defs', id }, { state: { title: id, key: id, value: 1, default: 1, scope: 'app', kind: 'number' }, links: { section: SECTION, definedBy: by } });
  put('a', AGENT);
  put('b', { type: 'App', provider: 'codex', id: 'codex' });
  assert.throws(() => put('c', CHAT), /refers to a CodexThread, not a App or Agent or Plugin or Skill or Mod/);
  const sc = scope('acme.reader', ['graph', 'graph.read']);
  assert.deepEqual(ns.calls.list(sc, 'Setting', { definedBy: AGENT }).map((x) => x.ref.id), ['a'], 'the settings an agent defines, whoever provides them');
  assert.deepEqual(graph.referrers({ type: 'App', provider: 'codex', id: 'codex' }, 'definedBy').map((x) => x.ref.id), ['b']);
  assert.equal(graph.types().find((t) => t.id === 'Setting').members.relations.definedBy.resolved, true);
  void codex;
});

test('G3.5: a mod\'s change that adds only its own context to a send is quiet (no ask for it); another key of the context is refused; any other change is asked', async () => {
  const { sendChange } = await import('../providers/codex/areas/threads.mjs');
  const asked = [];
  const graph = createGraph({ approvals: { ask: async (q) => { asked.push(q.modId); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const sent = [];
  const codex = graph.registerProvider('native', 'codex', { types: { CodexAgent: {}, CodexThread: { operations: {
    send: { effect: 'external', approval: () => ({ action: 'send a message' }), change: sendChange, handler: async ({ args }) => { sent.push(args[1] ?? null); return null; } },
  } } } });
  codex.put(AGENT, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(CHAT, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent: AGENT } });
  const content = { parts: [{ kind: 'text', text: 'hi' }] };
  let mode = 'own';
  graph.intercept('mod:acme.ctx', 'CodexThread', 'send', (call, next) => {
    const [c, o] = call.args;
    const context = { ...(o?.additionalContext ?? {}), [mode === 'other' ? 'mod:someone.else' : 'mod:acme.ctx']: { kind: 'application', value: 'mine' } };
    return next({ args: [mode === 'content' ? { parts: [{ kind: 'text', text: 'changed' }] } : c, { ...(o ?? {}), additionalContext: context }] });
  });
  const user = { kind: 'user', id: 'user', owner: 'app' };
  assert.equal((await graph.invoke({ ref: CHAT, operation: 'send', args: [content, {}], caller: user })).status, 'done');
  assert.deepEqual([asked, sent.at(-1)], [[], { additionalContext: { 'mod:acme.ctx': { kind: 'application', value: 'mine' } } }], 'its own context: nobody asked');
  mode = 'other';
  const other = await graph.invoke({ ref: CHAT, operation: 'send', args: [content, {}], caller: user });
  assert.match(other.message ?? '', /changed by acme\.ctx: it changes the turn's context under mod:someone\.else, not its own/);
  mode = 'content';
  assert.equal((await graph.invoke({ ref: CHAT, operation: 'send', args: [content, {}], caller: user })).status, 'done');
  assert.deepEqual(asked, ['acme.ctx'], 'a change of what is sent is asked about as that mod\'s');
});

test('review 2026-11-05 #2: a subtype a mod declares does not make another provider\'s instance its own: no link, no attached value, no read through it', () => {
  const { graph, ns, scope } = setup();
  graph.registerTypes([toDescriptor(Note)], 'mod:acme.notes');
  graph.registerTypes([{ id: 'NoteThread', kind: 'subtype', parent: 'Thread', spec: {} }], 'mod:acme.notes');
  const sc = scope('acme.notes', ['graph']);
  provide(ns, sc, { types: { Note: {} } });
  const forged = { type: 'NoteThread', provider: 'codex', id: 't1' };   // the native chat, named as the mod's own subtype
  assert.throws(() => ns.calls.put(sc, NOTE('n1'), { state: { text: 'hi' }, links: { thread: forged } }), (e) => e.code === 'Denied', 'no link');
  const out = ns.calls.attach(sc, forged, 'mark', 1, {});
  assert.deepEqual([out.status, out.reason], ['refused', 'notAllowed'], 'no attached value');
  assert.equal(graph.attachments?.viewFor?.(null, CHAT)?.attached?.['acme.notes'], undefined);
  assert.equal(ns.calls.resolve(sc, forged), null, 'no read');
});


test('review 2026-11-05 #6: a contributor that may not read or add to an instance is not told it is read', async () => {
  const { ns, scope } = setup();
  const reader = scope('acme.reader', ['graph', 'graph.read']);
  const nosy = scope('acme.nosy', ['graph']);   // no graph.read for chats, no graph.contribute
  const { asked } = provide(ns, nosy, { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'thread' }] }, () => null);
  await ns.calls.related(reader, CHAT, 'settings');
  assert.deepEqual(asked, [], 'it learns nothing of the chat read');
  const allowed = scope('acme.allowed', ['graph', 'graph.read:Thread', 'graph.contribute:Thread']);
  const { asked: asked2 } = provide(ns, allowed, { types: { Setting: {} }, contributes: [{ type: 'Setting', via: 'thread' }] }, () => null);
  await ns.calls.related(reader, CHAT, 'settings');
  assert.deepEqual(asked2.map((q) => q.target.id), ['t1'], 'one that may is asked');
});
