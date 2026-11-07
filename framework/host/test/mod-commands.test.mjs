// The mods' commands as graph Commands (E8.11): one per `ui.commands.add` rule, run as the palette's row runs it, gone with its rule.
// Through the real registration path: the mod's `ui.commands.add` (both realms), the Host's registry, the projector (review 4, round 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../graph/index.mjs';
import { createPolicy } from '../graph/policy.mjs';
import { createRuleRegistry } from '../ui-rules.mjs';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';
import { toDescriptor } from '../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../sdk/graph/native/index.mjs';
import { createModCommands, PROVIDER } from '../mod-commands.mjs';

const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });
const settle = () => new Promise((r) => setImmediate(r));

function setup() {
  const grants = { 'unit.b': ['graph.read:Command', 'graph.act:Command.run'] };
  const policy = createPolicy({ grantsOf: (id) => grants[id] ?? [], typeOf: (t) => graph.type(t) });
  const graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const registry = createRuleRegistry({ presentations: new Map([['Palette', new Set(['resultSources'])], ['Menu', new Set(['groups'])]]), rankOf: () => 1, typeExists: () => true });
  // the mod's host realm: its callbacks served by its worker (here, the client's own function)
  const hostWho = { id: 'unit.a', grants: ['graph.present'], gen: 'g1', realm: 'host' };
  const host = createRuleApi({ modId: 'unit.a', realm: 'host', channel: {
    register: async (d) => registry.register(hostWho, d), dispose: async (id) => registry.dispose(hostWho, id),
    callbacks: (id, reg, fn) => registry.bindCallbacks(hostWho, id, reg, async ([path, env]) => fn(path, env)),
  } });
  // the mod's renderer realm in window 7: its functions and its token stay in that page, which answers a run as the page runtime does
  const pageWho = { id: 'unit.a', grants: ['graph.present'], gen: 'g1', realm: 'renderer', window: 7 };
  const page = new Map();
  const renderer = createRuleApi({ modId: 'unit.a', realm: 'renderer', channel: { register: async (d) => registry.register(pageWho, d), dispose: async (id) => registry.dispose(pageWho, id) },
    local: { set: (k, fns, reg) => page.set(k, { fns, reg }), delete: (k) => page.delete(k) } });
  let front = 7;
  const runs = [];
  const windows = {
    frontWindow: async () => front,
    runRule: async (windowId, m) => {
      runs.push([windowId, m.key, m.reg]);
      const h = windowId === 7 ? page.get(m.key) : null;
      if (!h || h.reg !== m.reg) return { status: 'refused', reason: 'unavailable', message: 'the mod registered it again, or it went' };
      h.fns.command.run(m.env);
      return { status: 'done', value: null };
    },
  };
  const c = createModCommands({ graph, rules: registry, windows: () => windows, nameOf: (id) => (id === 'unit.a' ? 'Unit A' : id) });
  const run = (id, caller = mod('unit.b')) => graph.invoke({ ref: { type: 'Command', provider: PROVIDER, id }, operation: 'run', args: [], caller });
  return { graph, registry, host: host.api, renderer: renderer.api, page, runs, windows, c, run, setFront: (w) => { front = w; } };
}

test('E8.11: a mod\'s command is a Command (its mod\'s name its category), from either realm\'s ui.commands.add; another mod with the grant runs it', async () => {
  const s = setup();
  const ran = [];
  await s.host.commands.add({ id: 'sync', title: 'Sync now', run: (env) => { ran.push(['host', env.via, env.subject.id]); } }).accepted;
  await s.renderer.commands.add({ id: 'page', title: 'Page thing', keywords: ['pg'], run: (env) => { ran.push(['page', env.via, env.window?.id]); } }).accepted;
  const sync = s.graph.resolve({ type: 'Command', provider: PROVIDER, id: 'unit.a/sync' });
  const pg = s.graph.resolve({ type: 'Command', provider: PROVIDER, id: 'unit.a/page' });
  assert.deepEqual([sync.state.title, sync.state.category, sync.state.enabled], ['Sync now', 'Unit A', true]);
  assert.equal(pg?.state.title, 'Page thing', 'a renderer realm\'s command is a Command too: its title and keywords cross, its run stays in the page');
  assert.equal(s.page.get('unit.a/page').fns.command.title, 'Page thing');
  assert.equal((await s.run('unit.a/sync')).status, 'done');
  assert.equal((await s.run('unit.a/page')).status, 'done');
  assert.deepEqual(ran, [['host', 'graph', 'unit.a/sync'], ['page', 'graph', '7']]);
  assert.deepEqual(s.runs, [[7, 'unit.a/page', s.page.get('unit.a/page').reg]], 'the window in front, named by its own registration');
  assert.equal((await s.run('unit.a/sync', mod('unit.c'))).reason, 'notAllowed', 'unit.c has no grant');
  s.c.dispose();
});

test('E8.11: run is done only when the command ran: a callback that failed is off (refused), a window that does not hold it refuses, a page that did not run it says so', async () => {
  const s = setup();
  let calls = 0;
  await s.host.commands.add({ id: 'flaky', title: 'Flaky', run: () => { calls++; throw new Error('boom'); } }).accepted;
  const first = await s.run('unit.a/flaky');
  assert.equal(first.status, 'failed', 'it threw: failed, not done');
  const second = await s.run('unit.a/flaky');
  assert.deepEqual([second.status, second.reason, calls], ['refused', 'unavailable', 1], 'off since it failed: refused, and not called');
  // a renderer command: the window in front holds no registration of it
  await s.renderer.commands.add({ id: 'page', title: 'Page thing', run: () => {} }).accepted;
  s.setFront(8);
  assert.equal((await s.run('unit.a/page')).status, 'refused');
  assert.deepEqual(s.runs, [], 'nothing sent to a window that does not hold it');
  s.setFront(null);
  assert.equal((await s.run('unit.a/page')).status, 'refused', 'no window in front');
  // the page says it did not run (its registration changed meanwhile): refused, never done
  s.setFront(7);
  const realRun = s.windows.runRule;
  s.windows.runRule = async () => ({ status: 'refused', reason: 'unavailable', message: 'the mod registered it again, or it went' });
  assert.equal((await s.run('unit.a/page')).status, 'refused');
  s.windows.runRule = async () => ({ status: 'failed', error: { message: 'the window did not answer in time: whether it was done is not known' } });
  assert.equal((await s.run('unit.a/page')).status, 'failed', 'a page gone before answering: not known (failed)');
  s.windows.runRule = realRun;
  s.c.dispose();
});

test('E8.11: a registration again runs the new one; the Command goes with its rule; a mod may not claim the provider', async () => {
  const s = setup();
  const ran = [];
  const h1 = s.renderer.commands.add({ id: 'page', title: 'Page thing', run: () => ran.push('first') });
  await h1.accepted;
  const tok1 = s.page.get('unit.a/page').reg;
  h1.dispose();
  await settle();
  assert.equal(s.graph.resolve({ type: 'Command', provider: PROVIDER, id: 'unit.a/page' })?.gone ?? !s.graph.resolve({ type: 'Command', provider: PROVIDER, id: 'unit.a/page' }), true, 'gone with its rule');
  await s.renderer.commands.add({ id: 'page', title: 'Page thing', run: () => ran.push('second') }).accepted;
  const tok2 = s.page.get('unit.a/page').reg;
  assert.notEqual(tok1, tok2);
  assert.equal((await s.run('unit.a/page')).status, 'done');
  assert.deepEqual(ran, ['second']);
  assert.deepEqual(s.runs.at(-1), [7, 'unit.a/page', tok2]);
  s.c.dispose();
});

test('public hooks §3.14: a command with several key chords, a group, a description and a subject it applies to: a hidden entry per chord and the subject\'s context menu entry, all accepted, all gone with it', async () => {
  const s = setup();
  const live = new Map();   // the registry's rules, as its subscribers see them
  s.registry.subscribe((e) => { if (e.t === 'put') live.set(`${e.rule.mod}/${e.rule.id}`, e.rule); else live.delete(e.key); });
  const h = s.host.commands.add({ id: 'pin', title: 'Pin it', keys: ['CmdOrCtrl+Alt+P', 'CmdOrCtrl+Shift+9'], group: 'Pins', description: 'keeps it on top',
    appliesTo: 'Thread', where: { archived: false }, run: () => {} });
  assert.equal(await h.accepted, true);
  const own = () => [...live.values()].filter((r) => r.mod === 'unit.a').map((r) => [r.presentation, r.id, r.for ?? null, r.where ?? null]).sort((x, y) => (x[1] < y[1] ? -1 : 1));
  assert.deepEqual(own(), [['Palette', 'pin', null, null], ['Menu', 'pin.keys', 'App', null], ['Menu', 'pin.keys2', 'App', null], ['Menu', 'pin.menu', 'Thread', { archived: false }]]);
  const row = live.get('unit.a/pin');
  assert.deepEqual([row.data.command.group, row.data.command.description, row.data.command.appliesTo], ['Pins', 'keeps it on top', 'Thread']);
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(own(), []);
  for (const bad of [{ keys: ['a', 'b', 'c', 'd', 'e'] }, { keys: [''] }, { where: { a: 1 } }, { when: 'x' }, { group: '' }, { appliesTo: 3 }]) {
    assert.throws(() => s.host.commands.add({ id: 'x', title: 'X', run: () => {}, ...bad }), { code: 'Invalid' });
  }
  s.c.dispose();
});

test('review: updating a command to fewer key chords drops the ones taken away; an icon this build cannot draw is said', async () => {
  const s = setup();
  const live = new Map();
  s.registry.subscribe((e) => { if (e.t === 'put') live.set(`${e.rule.mod}/${e.rule.id}`, e.rule); else live.delete(e.key); });
  const h = s.host.commands.add({ id: 'go', title: 'Go', keys: ['CmdOrCtrl+Alt+G', 'CmdOrCtrl+Alt+H'], icon: 'rocket', run: () => {} });
  assert.equal(await h.accepted, true);
  assert.deepEqual(h.unsupported, ['icon']);
  await s.host.menus.add({ id: 'go.keysHint', title: 'Hint', in: 'view', run: () => {} }).accepted;   // another declaration of the mod's
  await h.update({ keys: 'CmdOrCtrl+Alt+G' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...live.keys()].filter((k) => k.startsWith('unit.a/go')).sort(), ['unit.a/go', 'unit.a/go.keys', 'unit.a/go.keysHint'], 'only its own taken away');
  s.c.dispose();
});
