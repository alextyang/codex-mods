// The registry of record of the mods' presentation rules (docs/design/systems.md S6, "E2 in detail"), the Host's `ui` namespace over it,
// and the mod-side API (framework/shared/ui-rules-client.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleRegistry, presentationsOf, readPresentations } from '../ui-rules.mjs';
import { createUiNs } from '../ctx/ui.mjs';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';

const PRES = new Map([['SidebarItem', new Set(['badges', 'label'])], ['MessageBlock', new Set(['actions', 'after'])], ['Menu', new Set(['entries'])]]);
const ranks = { 'unit.a': 1, 'unit.b': 2 };
const registry = () => createRuleRegistry({ presentations: PRES, rankOf: (id) => ranks[id] ?? 99, typeExists: (t) => ['Thread', 'CodexThread', 'Message'].includes(t) });
const who = (id, o = {}) => ({ id, grants: ['graph.present'], gen: o.gen ?? `gen-${id}`, realm: o.realm ?? 'renderer', window: o.window ?? 1, ...o });

test('the presentations and their slots come from addresses.json: bindings and rules, not the hosts the framework renders itself', () => {
  const p = presentationsOf({ bindings: [{ presentation: 'SidebarItem', slots: ['badges'] }, { presentation: 'SettingsPage', target: false }, { presentation: 'Chip' }], rules: [{ presentation: 'Menu', slots: ['entries'] }] });
  assert.deepEqual([...p.keys()], ['SidebarItem', 'Chip', 'Menu']);
  assert.deepEqual([...p.get('SidebarItem')], ['badges']);
  const real = readPresentations(new URL('../../renderer/present/addresses.json', import.meta.url));
  assert.ok(real.get('SidebarItem').has('badges') && real.get('Menu').has('groups') && real.get('SidebarItem').has('contextMenu') && !real.has('nothing'));
  assert.deepEqual(readPresentations('/no/such/file'), new Map());
  // A twin's slots (E7.2): the agent's final answer holds its turn's.
  const twin = presentationsOf({ bindings: [{ presentation: 'MessageBlock', slots: ['actions'], twins: [{ presentation: 'TurnView', slots: ['actions', 'afterAnswer'] }] }] });
  assert.deepEqual([...twin.get('TurnView')], ['actions', 'afterAnswer']);
  assert.ok(real.get('TurnView').has('afterAnswer') && !real.get('MessageBlock').has('after'));
  assert.deepEqual([...presentationsOf({ bindings: [{ twins: [{ presentation: 'Sidebar', slots: ['footer'] }] }] }).get('Sidebar')], ['footer'], 'from a binding that presents nothing itself');
  assert.deepEqual([...presentationsOf({ bindings: [{ presentation: 'Sidebar', slots: ['groups'] }, { partsOf: 'Sidebar', partsOnly: true, parts: { footerParts: ['usage'] } }] }).get('Sidebar')],
    ['groups', 'footerParts'], 'from a binding that draws only parts of its slots (the footer\'s banners): what ui.parts offers there can be hidden');
  assert.ok(real.get('Sidebar').has('sections') && real.get('Sidebar').has('footer'));
});

test('a rule is checked: its kind, its presentation and slot on this build, its grant, its realm, its type; then ordered by mod rank and priority', () => {
  const r = registry();
  assert.throws(() => r.register(who('unit.a'), { id: 'x', kind: 'nope', presentation: 'SidebarItem' }), /unknown rule kind/);
  assert.throws(() => r.register(who('unit.a'), { id: 'x', kind: 'hide', presentation: 'DockBadge' }), /no binding presents DockBadge/);
  assert.throws(() => r.register(who('unit.a'), { id: 'x', kind: 'decorate', presentation: 'SidebarItem', slot: 'menu' }), /no slot menu/);
  assert.throws(() => r.register(who('unit.a'), { id: 'x', kind: 'add', presentation: 'Menu' }), /names its slot/);
  assert.throws(() => r.register(who('unit.a', { grants: ['graph.present:MessageBlock'] }), { id: 'x', kind: 'hide', presentation: 'SidebarItem' }), /not been granted graph.present for SidebarItem/);
  assert.throws(() => r.register(who('unit.a', { grants: ['ui'] }), { id: 'x', kind: 'hide', presentation: 'SidebarItem' }), /not been granted/);
  assert.throws(() => r.register(who('unit.a', { realm: 'host' }), { id: 'x', kind: 'replace', presentation: 'SidebarItem' }), /from the renderer realm/);
  assert.throws(() => r.register(who('unit.a'), { id: 'x', kind: 'hide', presentation: 'SidebarItem', for: 'Nope' }), /unknown type Nope/);
  const fw = createRuleRegistry({ presentations: PRES, rankOf: () => 1, typeExists: () => true, frameworkOwned: (t) => t === 'Mod' });
  assert.throws(() => fw.register(who('unit.a'), { id: 'x', kind: 'hide', presentation: 'SidebarItem', for: 'Mod' }), (e) => e.code === 'Denied' && /framework's/.test(e.message), 'E6: no rule is for a framework type');
  assert.ok(fw.register(who('unit.a'), { id: 'x', kind: 'hide', presentation: 'SidebarItem', for: 'Thread' }));
  assert.throws(() => r.register(who('unit.a'), { id: 'bad id!', kind: 'hide', presentation: 'SidebarItem' }), /needs an id/);
  assert.throws(() => r.register(who('unit.a'), { id: 's', kind: 'style', data: { variables: { color: 'x' } } }), /style takes/);
  assert.throws(() => r.register(who('unit.a'), { id: 's', kind: 'style', data: { variables: { '--color-border': '#ff0000' } } }), /a theme token/, 'never a raw value');
  assert.ok(r.register(who('unit.a'), { id: 'ok-style', kind: 'style', data: { variables: { '--color-border': 'accent', '--codex-base-accent': '--color-text-danger' } } }));
  assert.ok(r.register(who('unit.a'), { id: 'ok-style-2', kind: 'style', data: { variables: { '--color-border': { light: 'accent', dark: '--color-text-danger' } } } }), 'one for each appearance');
  r.dispose(who('unit.a'), 'ok-style-2');
  assert.throws(() => r.register(who('unit.a'), { id: 's2', kind: 'style', data: { variables: { '--color-border': { light: 'accent', dark: '#000' } } } }), /a theme token/, 'never a raw value, in either');
  assert.throws(() => r.register(who('unit.a'), { id: 's3', kind: 'style', data: { variables: { '--color-border': { light: 'accent' } } } }), /style takes/);
  r.dispose(who('unit.a'), 'ok-style');
  const a = r.register(who('unit.a'), { id: 'badge', kind: 'decorate', presentation: 'SidebarItem', for: 'Thread', priority: 5 });
  const b = r.register(who('unit.b'), { id: 'badge', kind: 'decorate', presentation: 'SidebarItem' });
  const a2 = r.register(who('unit.a'), { id: 'low', kind: 'decorate', presentation: 'SidebarItem', priority: -5 });
  assert.ok(a.order < a2.order && a2.order < b.order, 'the mod\'s rank first, then the rule\'s priority');
  assert.deepEqual(r.snapshot().map((x) => `${x.mod}/${x.id}`), ['unit.a/badge', 'unit.b/badge', 'unit.a/low']);
});

test('a renderer rule lives while a window holds it; a host rule everywhere; a mod\'s teardown and an older activation are gone', () => {
  const r = registry();
  const seen = [];
  r.subscribe((d) => seen.push(d.t === 'put' ? `put ${d.rule.mod}/${d.rule.id}` : `remove ${d.key}`));
  r.register(who('unit.a', { window: 1 }), { id: 'x', kind: 'hide', presentation: 'SidebarItem', reg: 'w1.a' });
  r.register(who('unit.a', { window: 2 }), { id: 'x', kind: 'hide', presentation: 'SidebarItem', reg: 'w2.a' });
  // each window's registration is told with the rule (a run sent to a window names its own: review 4, round 2)
  assert.deepEqual(r.snapshot()[0].regs, { 1: 'w1.a', 2: 'w2.a' });
  assert.throws(() => r.register(who('unit.a', { window: 2 }), { id: 'x', kind: 'hide', presentation: 'SidebarItem', reg: 'not a token' }), /registration token/);
  r.closeWindow(1);
  assert.equal(r.snapshot().length, 1, 'window 2 still holds it');
  assert.deepEqual(r.snapshot()[0].regs, { 2: 'w2.a' }, 'told again without the closed window\'s');
  r.dispose(who('unit.a', { window: 2 }), 'x');
  assert.equal(r.snapshot().length, 0);
  r.register(who('unit.b', { realm: 'host', window: undefined }), { id: 'h', kind: 'decorate', presentation: 'SidebarItem', data: { badges: [{ id: 'b', text: 'B' }] } });
  r.closeWindow(1);
  assert.equal(r.snapshot().length, 1, 'a host rule does not depend on windows');
  // an older activation cannot dispose a newer one's rule
  r.register(who('unit.a', { gen: 'g2' }), { id: 'y', kind: 'hide', presentation: 'SidebarItem' });
  assert.equal(r.dispose(who('unit.a', { gen: 'g1' }), 'y'), false);
  r.disposeMod('unit.a');
  r.disposeMod('unit.b');
  assert.deepEqual(r.snapshot(), []);
  assert.deepEqual(seen, ['put unit.a/x', 'put unit.a/x', 'put unit.a/x', 'remove unit.a/x', 'put unit.b/h', 'put unit.a/y', 'remove unit.a/y', 'remove unit.b/h']);
});

test('the ui namespace: mods register and dispose; only the page\'s own runtime follows the rules, a snapshot then deltas', async () => {
  const r = registry();
  const ns = createUiNs({ rules: () => r });
  const mod = { state: { id: 'unit.a', grants: ['graph.present'] }, realm: 'renderer', channel: { identity: { windowId: 3 } } };
  const fw = { state: { id: 'framework', framework: true }, realm: 'renderer' };
  assert.deepEqual(ns.calls.register(mod, { id: 'x', kind: 'hide', presentation: 'SidebarItem' }), { order: r.snapshot()[0].order });
  assert.throws(() => ns.calls.register(fw, { id: 'x', kind: 'hide', presentation: 'SidebarItem' }), /registers none/);
  assert.throws(() => ns.calls.register({ ...mod, realm: 'process' }, { id: 'x', kind: 'hide', presentation: 'SidebarItem' }), /process/);
  assert.throws(() => ns.subs.rules(mod, [], () => {}), /page runtime/);
  const got = [];
  const sub = ns.subs.rules(fw, [], (d) => got.push(d));
  assert.deepEqual(got, [], 'nothing before the channel has registered the subscription (it would drop it)');
  await Promise.resolve();
  assert.equal(got[0].t, 'snapshot');
  assert.equal(got[0].rules.length, 1);
  assert.equal(ns.calls.dispose(mod, 'x'), true);
  assert.deepEqual(got[1], { t: 'remove', key: 'unit.a/x' });
  sub.dispose();
  assert.throws(() => createUiNs({ rules: () => null }).calls.register(mod, {}), /not available/);
});

test('E7.6c: ui.ask is checked, named by the framework (the mod\'s id and name, never its text) and goes to the windows provider; the page answers for its window', async () => {
  const asked = [];
  const answered = [];
  const windows = { ask: async (spec) => { asked.push(spec); return { choice: 'yes', by: 'user' }; }, askAnswer: (...a) => { answered.push(a); return true; } };
  const ns = createUiNs({ rules: () => null, windows: () => windows });
  const mod = { state: { id: 'unit.a', grants: [], mod: { manifest: { name: 'Unit A' } } }, realm: 'host' };
  const fw = { state: { id: 'framework', framework: true }, realm: 'renderer', channel: { identity: { windowId: 3 } } };
  const T = { type: 'Thread', provider: 'codex', id: 't1' };
  const spec = { subject: T, purpose: 'confirm', title: 'Delete it?', message: 'It cannot be undone.', actions: [{ id: 'yes', title: 'Delete', extra: 1 }], requester: { id: 'framework', name: 'Codex Mods' } };
  assert.deepEqual(await ns.calls.ask(mod, spec), { choice: 'yes', by: 'user' });
  assert.deepEqual(asked[0], { requester: { id: 'unit.a', name: 'Unit A' }, subject: T, purpose: 'confirm', title: 'Delete it?', message: 'It cannot be undone.', actions: [{ id: 'yes', title: 'Delete' }] });
  for (const [bad, re] of [[{ ...spec, subject: 'x' }, /subject/], [{ ...spec, purpose: 'Not ok!' }, /purpose/], [{ ...spec, actions: [] }, /1 to 3/],
    [{ ...spec, actions: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }, /own id/], [{ ...spec, title: '' }, /title/], [{ ...spec, until: 'soon' }, /until/]]) {
    assert.throws(() => ns.calls.ask(mod, bad), re);
  }
  assert.throws(() => ns.calls.ask(fw, spec), /asks none/);
  assert.equal(ns.calls.askAnswer(fw, 5, 1, { choice: 'yes' }), true);
  assert.deepEqual(answered, [[3, 5, 1, { choice: 'yes' }]]);
  assert.throws(() => ns.calls.askAnswer(mod, 5, 1, {}), /page's runtime/);
  // the mod side: ask goes over the channel, or is unavailable without one
  const api = createRuleApi({ modId: 'unit.a', realm: 'host', channel: { register: async () => ({}), dispose: async () => true, ask: async (x) => ({ asked: x.purpose }) } }).api;
  assert.deepEqual(await api.ask(spec), { asked: 'confirm' });
  assert.throws(() => createRuleApi({ modId: 'unit.a', realm: 'host', channel: { register: async () => ({}), dispose: async () => true } }).api.ask(spec), /not available/);
});

test('E7 review: a question asked during an interception is bound to that call (the mod\'s own only), and ends with it', async () => {
  const { createInterceptions } = await import('../ctx/index.mjs');
  const life = createInterceptions();
  const asked = [];
  const windows = { ask: async (spec) => { asked.push(spec); return { choice: 'ok', by: 'user' }; } };
  const ns = createUiNs({ rules: () => null, windows: () => windows, interceptions: life });
  const state = { id: 'unit.a', grants: [], mod: { manifest: { name: 'Unit A' } } };
  const mod = { state, realm: 'host' };
  const spec = { subject: { type: 'Thread', provider: 'codex', id: 't1' }, purpose: 'confirm', title: 'Send it?', message: 'm', actions: [{ id: 'ok', title: 'OK' }] };
  life.begin('ic-1', state);
  life.begin('ic-2', { id: 'unit.b' });
  await ns.calls.ask(mod, { ...spec, during: 'ic-1' });
  let ended = 0;
  asked[0].during(() => { ended++; });
  life.end('ic-1');
  assert.equal(ended, 1, 'the question hears the call end');
  assert.throws(() => ns.calls.ask(mod, { ...spec, during: 'ic-2' }), /a call this mod is intercepting/, 'another mod\'s call');
  assert.throws(() => ns.calls.ask(mod, { ...spec, during: 'ic-1' }), /a call this mod is intercepting/, 'a call that ended');
  assert.equal(life.onEnd('ic-9', () => {}), null);
});

test('the mod side: data crosses, functions stay in the page\'s handles; the host realm takes data only; a refusal is told and cleans up', async () => {
  const calls = [];
  const local = new Map();
  const channel = { register: async (d) => { calls.push(['register', d]); if (d.id === 'bad') throw new Error('Denied'); return { order: 1 }; }, dispose: async (id) => calls.push(['dispose', id]) };
  const refused = [];
  const page = createRuleApi({ modId: 'unit.a', realm: 'renderer', channel, local: { set: (k, f) => local.set(k, f), delete: (k) => local.delete(k) }, onRefused: (id) => refused.push(id) });
  const badge = (t) => [{ id: 'n', text: t.state.title }];
  const h = page.api.decorate('SidebarItem', { id: 'n', for: 'Thread', badges: badge, label: 'static', priority: 2 });
  assert.equal(await h.accepted, true);
  assert.deepEqual(calls[0], ['register', { kind: 'decorate', presentation: 'SidebarItem', id: 'n', for: 'Thread', priority: 2, data: { label: 'static' }, reg: calls[0][1].reg }]);
  assert.match(calls[0][1].reg, /^[A-Za-z0-9._-]+$/, 'a renderer registration has its own token');
  assert.equal(local.get('unit.a/n').badges, badge, 'the function stays in the page');
  assert.throws(() => page.api.decorate('SidebarItem', { id: 'n' }), /registered already/);
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.ok(!local.has('unit.a/n') && calls.some((c) => c[0] === 'dispose' && c[1] === 'n'));
  const data = page.api.decorate('ThreadHeader', { id: 'data', badges: [{ id: 'x', text: 'X' }] });
  assert.equal(local.get('unit.a/data'), undefined, 'not before the Host accepts it (built review, round 2)');
  await data.accepted;
  assert.deepEqual(local.get('unit.a/data'), {}, 'a data-only renderer rule still has its handle here (it applies in this window)');
  data.dispose();
  const bad = page.api.hide('SidebarItem', { id: 'bad' });
  assert.equal(await bad.accepted, false);
  assert.deepEqual(refused, ['bad']);
  const host = createRuleApi({ modId: 'unit.b', realm: 'host', channel });
  assert.equal(host.api.replace, undefined, 'components are the renderer realm\'s');
  assert.throws(() => host.api.decorate('SidebarItem', { id: 'f', badges: () => [] }), /renderer realm/);
  assert.throws(() => host.api.decorate('Menu', { id: 'a', actions: [{ id: 'x', title: 'X', run() {} }] }), /callbacks are not available here/, 'a channel that serves no callbacks');
  host.api.decorate('SidebarItem', { id: 'd', badges: [{ id: 'b', text: 'B' }] });
  host.disposeAll();
});

test('a rule\'s order is its mod\'s rank when it is sent: a rule registered before the rank was known (while its mod activates) is ordered right later', () => {
  const rank = { 'unit.a': undefined, 'unit.b': 2 };
  const r = createRuleRegistry({ presentations: PRES, rankOf: (id) => rank[id] });
  const sent = [];
  r.subscribe((d) => sent.push(d));
  r.register(who('unit.a', { realm: 'host', window: undefined }), { id: 'early', kind: 'decorate', presentation: 'SidebarItem' });
  r.register(who('unit.b'), { id: 'b', kind: 'decorate', presentation: 'SidebarItem' });
  assert.ok(sent[0].rule.order > sent[1].rule.order, 'unknown rank: last for now');
  rank['unit.a'] = 1;
  assert.deepEqual(r.snapshot().sort((x, y) => x.order - y.order).map((x) => x.mod), ['unit.a', 'unit.b'], 'a later snapshot has the rank');
  r.reorder('unit.a');
  assert.ok(sent.at(-1).rule.order < sent[1].rule.order, 'and reorder sends it to the windows');
});

test('a window\'s presentations are reported by its page\'s runtime only, under the window its channel stands for (S10)', () => {
  const calls = [];
  const w = {
    open: (id, channel) => { calls.push(['open', id, channel.identity.windowId]); return 3; },
    report: (id, gen, batch) => { calls.push(['report', id, gen, batch.puts.length]); return true; },
    acted: (id, gen, events) => { calls.push(['acted', id, gen, events.length]); return events.length; },
    answer: (id, gen, actId, outcome) => { calls.push(['answer', id, gen, actId, outcome.ok]); return true; },
  };
  const ns = createUiNs({ rules: () => registry(), windows: () => w });
  const fw = { state: { id: 'framework', framework: true }, realm: 'renderer', channel: { identity: { windowId: 9 } } };
  assert.deepEqual(ns.calls.window(fw), { gen: 3, windowId: 9 });
  assert.equal(ns.calls.report(fw, 3, { puts: [{}] }), true);
  assert.equal(ns.calls.acted(fw, 3, [{}, {}]), 2);
  assert.equal(ns.calls.answer(fw, 3, 41, { ok: true }), true);
  assert.deepEqual(calls, [['open', 9, 9], ['report', 9, 3, 1], ['acted', 9, 3, 2], ['answer', 9, 3, 41, true]]);
  const mod = { state: { id: 'unit.a', grants: ['graph.present'] }, realm: 'renderer', channel: { identity: { windowId: 9 } } };
  assert.throws(() => ns.calls.report(mod, 3, { puts: [] }), /reported by its page's runtime/);
  assert.throws(() => ns.calls.answer(mod, 3, 41, { ok: true }), /reported by its page's runtime/, 'a mod cannot answer an act');
  assert.throws(() => ns.calls.window({ ...fw, channel: { identity: {} } }), /no window/);
  assert.throws(() => createUiNs({ rules: () => registry() }).calls.window(fw), /graph is off/);
});

test('_read and _act on presentations: the graph\'s list or a subject\'s presentations, by window and subject; act is invoke, as the mod', async () => {
  const W = (id) => ({ type: 'Window', provider: 'codexmods.windows', id });
  const T = { type: 'CodexThread', provider: 'codex', id: 't' };
  const all = [
    { ref: { type: 'SidebarItem', provider: 'codexmods.windows', id: '1.1.1' }, links: { window: W('1'), subject: T } },
    { ref: { type: 'ThreadView', provider: 'codexmods.windows', id: '1.1.2' }, links: { window: W('1'), subject: T } },
    { ref: { type: 'SidebarItem', provider: 'codexmods.windows', id: '2.1.1' }, links: { window: W('2'), subject: { ...T, id: 'u' } } },
  ];
  const calls = [];
  const graph = {
    list: async (type) => { calls.push(['list', type]); return type === 'SidebarItem' ? all.filter((p) => p.ref.type === 'SidebarItem') : all; },
    related: async (ref, name) => { calls.push(['related', name]); return all.filter((p) => p.links.subject.id === ref.id); },
    invoke: async (ref, op, args) => { calls.push(['invoke', ref.id, op, args]); return { status: 'done' }; },
  };
  const { api } = createRuleApi({ modId: 'unit.a', realm: 'host', channel: { register: async () => ({}), dispose: async () => {} }, graph: () => graph });
  assert.equal((await api._read()).length, 3);
  assert.deepEqual((await api._read({ window: 1 })).map((p) => p.ref.id), ['1.1.1', '1.1.2']);
  assert.deepEqual((await api._read({ subject: T })).map((p) => p.ref.id), ['1.1.1', '1.1.2']);
  assert.deepEqual((await api._read({ subject: T, type: 'SidebarItem' })).map((p) => p.ref.id), ['1.1.1'], 'a type with its subtypes, then the subject');
  assert.deepEqual(await api._act(all[0].ref, 'select'), { status: 'done' });
  assert.deepEqual(calls.at(-1), ['invoke', '1.1.1', 'select', []]);
  const none = createRuleApi({ modId: 'unit.a', realm: 'host', channel: { register: async () => ({}), dispose: async () => {} } });
  await assert.rejects(none.api._read(), /needs the graph/);
});

test('E8.1: a host-realm rule\'s callbacks stay in the worker as markers; the Host calls them for the page with the env, only for the registration the entry came from', async () => {
  // the mod side: `run` becomes {$fn: path}, served by the worker under the rule's id and its registration's token
  const bound = new Map(), sent = [], seen = [];
  const channel = {
    register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {},
    callbacks: (id, reg, fn) => { bound.set(id, { reg, fn }); return { dispose() { bound.delete(id); } }; },
  };
  const host = createRuleApi({ modId: 'unit.h', realm: 'host', channel });
  const h = host.api.decorate('MessageBlock', { id: 'save', slot: 'actions', actions: [{ id: 'x', title: 'Save', run(env) { seen.push(env); return { saved: env.subject.id }; } }] });
  assert.equal(await h.accepted, true);
  assert.deepEqual(sent[0].data, { actions: [{ id: 'x', title: 'Save', run: { $fn: 'actions.0.run' } }] });
  assert.deepEqual(sent[0].callbacks, ['actions.0.run']);
  assert.match(sent[0].reg, /^[A-Za-z0-9._-]+$/);
  assert.equal(bound.get('save').reg, sent[0].reg, 'the worker serves that registration');
  assert.deepEqual(await bound.get('save').fn('actions.0.run', { subject: { type: 'Message', provider: 'codex', id: 'm1' }, via: 'click' }), { saved: 'm1' });
  await assert.rejects(async () => bound.get('save').fn('actions.1.run', {}), /no callback/);
  assert.throws(() => host.api.decorate('MessageBlock', { id: 'alias', slot: 'actions', actions: [{ id: 'y', title: 'Y', run() {} }], label: { $fn: 'actions.0.run' } }), /reserves/, 'a mod cannot write a marker');
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.equal(bound.has('save'), false, 'disposing the rule lets its callbacks go');

  // the Host: markers only as an entry's run at their own path, the host realm's only; a call needs the rule's current registration
  const reg = registry();
  const mod = who('unit.h', { realm: 'host', window: undefined });
  const desc = { id: 'save', kind: 'decorate', presentation: 'MessageBlock', slot: 'actions', data: sent[0].data, callbacks: ['actions.0.run'], reg: 'r1' };
  assert.throws(() => reg.register(who('unit.r'), desc), /only a host-realm rule/);
  assert.throws(() => reg.register(mod, { ...desc, callbacks: ['actions.1.run'] }), /paths of the \{\$fn\} markers/);
  assert.throws(() => reg.register(mod, { ...desc, callbacks: undefined }), /paths of the \{\$fn\} markers/);
  assert.throws(() => reg.register(mod, { ...desc, reg: undefined }), /registration token/);
  // aliasing: a marker under another field, or naming another path, is refused
  assert.throws(() => reg.register(mod, { ...desc, data: { ...desc.data, label: { $fn: 'actions.0.run' } } }), /at its own path/);
  assert.throws(() => reg.register(mod, { ...desc, data: { actions: [{ id: 'x', title: 'Save', run: { $fn: 'actions.0.other' } }] } }), /at its own path/);
  reg.register(mod, desc);
  assert.deepEqual([reg.snapshot()[0].callbacks, reg.snapshot()[0].reg], [['actions.0.run'], 'r1'], 'the page learns which markers are callbacks, and the token');
  assert.equal(await reg.callback('unit.h/save', 'r1', 'actions.0.run', {}), null, 'no binding yet: nothing runs');
  const invoked = [];
  reg.bindCallbacks(mod, 'save', 'r1', async (args, ms) => { invoked.push([args, ms]); if (args[1].via === 'boom') throw new Error('boom'); return args[1].via === 'big' ? 'x'.repeat(70000) : { ok: true }; });
  assert.deepEqual(await reg.callback('unit.h/save', 'r1', 'actions.0.run', { via: 'click' }), { ok: true });
  assert.deepEqual(invoked, [[['actions.0.run', { via: 'click' }], 30000]]);
  assert.equal(await reg.callback('unit.h/save', 'r1', 'actions.9.run', {}), null, 'a path the rule did not name');
  await assert.rejects(reg.callback('unit.h/save', 'r1', 'actions.0.run', { via: 'big' }), /at most 64 KiB/);
  // the same id registered again (another token): an entry of the first registration reaches nothing
  reg.register(mod, { ...desc, reg: 'r2' });
  reg.bindCallbacks(mod, 'save', 'r2', async () => ({ second: true }));
  assert.equal(await reg.callback('unit.h/save', 'r1', 'actions.0.run', {}), null, 'a stale click does not run the new registration');
  assert.deepEqual(await reg.callback('unit.h/save', 'r2', 'actions.0.run', {}), { second: true });
  reg.bindCallbacks({ ...mod, gen: 'older' }, 'save', 'r2', async () => ({ stale: true }));
  assert.equal(await reg.callback('unit.h/save', 'r2', 'actions.0.run', {}), null, 'another activation\'s binding is not this rule\'s');
  // a callback that throws is off for every window until the mod registers again
  reg.bindCallbacks(mod, 'save', 'r2', async (args) => { if (args[1].via === 'boom') throw new Error('boom'); return { again: true }; });
  await assert.rejects(reg.callback('unit.h/save', 'r2', 'actions.0.run', { via: 'boom' }), /boom/);
  assert.equal(await reg.callback('unit.h/save', 'r2', 'actions.0.run', {}), null, 'off after its failure');
  reg.dispose(mod, 'save');
  assert.equal(await reg.callback('unit.h/save', 'r2', 'actions.0.run', {}), null, 'a late click after the rule went is a no-op');
  assert.throws(() => reg.bindCallbacks(who('unit.r'), 'save', 'r3', async () => null), /only the host realm/);

  // the namespace: the page's runtime calls, the host realm binds
  const ns = createUiNs({ rules: () => reg });
  assert.throws(() => ns.calls.callback({ state: { id: 'unit.h' }, realm: 'host' }, 'unit.h/save', 'r2', 'actions.0.run', {}), /page's runtime/);
  assert.throws(() => ns.handlers.callbacks({ state: { id: 'unit.r', grants: [] }, realm: 'renderer' }, ['save', 'r3'], async () => null), /only the host realm/);
  const d = ns.handlers.callbacks({ state: { id: 'unit.h', grants: ['graph.present'] }, realm: 'host' }, ['save', 'r3'], async () => 'served');
  d.dispose();
});

test('E8.2: ui.panel is one host rule on SidePanel tabs with its view; the Host checks the view; the handle opens and closes it here', async () => {
  const sent = [], local = new Map(), calls = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {} };
  const page = createRuleApi({ modId: 'unit.p', realm: 'renderer', channel, local: { set: (k, f) => local.set(k, f), delete: (k) => local.delete(k) },
    panels: { open: (id, o) => { calls.push(['open', id, o]); return true; }, close: (id, o) => { calls.push(['close', id, o]); return true; } } });
  const render = () => null;
  const h = page.api.panel({ id: 'notes', title: ' Notes ', icon: 'note', render, targets: 'bottom', persist: false });
  assert.equal(await h.accepted, true);
  assert.deepEqual(sent[0], { kind: 'host', presentation: 'SidePanel', id: 'notes', slot: 'tabs', data: { view: { title: 'Notes', icon: 'note', targets: ['bottom'], persist: false } }, reg: sent[0].reg });
  assert.equal(local.get('unit.p/notes').render, render);
  assert.equal(h.open({ target: 'bottom' }), true);
  assert.equal(h.close(), true);
  assert.deepEqual(calls, [['open', 'notes', { target: 'bottom' }], ['close', 'notes', {}]]);
  assert.throws(() => page.api.panel({ id: 'x', title: 'X' }), /render/);
  assert.throws(() => page.api.panel({ id: 'x', title: 'X', render, targets: ['left'] }), /targets/);
  assert.equal(createRuleApi({ modId: 'unit.h', realm: 'host', channel }).api.panel, undefined, 'a panel view is a component: the renderer realm\'s');

  const reg = createRuleRegistry({ presentations: new Map([['SidePanel', new Set(['tabs', 'toolbar'])]]), rankOf: () => 1 });
  const mod = who('unit.p');
  reg.register(mod, sent[0]);
  assert.throws(() => reg.register(mod, { ...sent[0], id: 'bad', data: { view: { title: '' } } }), /panel view/);
  assert.throws(() => reg.register(mod, { ...sent[0], id: 'bad2', data: { view: { title: 'X', targets: ['top'] } } }), /panel view/);
  assert.throws(() => reg.register(mod, { ...sent[0], id: 'bad3', kind: 'add', data: { items: [] } }), /panel view/);
});

test('E8.8: a part renderer is a host rule on ContentView partRenderers with its part; the Host checks the part (the renderer realm\'s)', () => {
  const reg = createRuleRegistry({ presentations: new Map([['ContentView', new Set(['partRenderers'])]]), rankOf: () => 1 });
  const mod = who('unit.c');
  const ok = { kind: 'host', presentation: 'ContentView', id: 'chart', slot: 'partRenderers', data: { part: { kind: 'code', language: ['chart'], sites: ['agent-message'] } } };
  reg.register(mod, ok);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b1', data: { part: { kind: 'code', language: [] } } }), /ui.content: a code part names its languages/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b2', data: { part: { kind: 'link', scheme: ['file'] } } }), /https, http, codex/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b3', data: { part: { kind: 'inlineCode', match: { source: '(', flags: '' } } } }), /pattern/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b4', data: {} }), /a part is an object/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b5', kind: 'add', data: { items: [] } }), /host rule with its part/);
  assert.throws(() => reg.register({ ...mod, realm: 'host' }, { ...ok, id: 'b6' }), /renderer realm/);
});

test('E8.3: ui.composer.control is a Composer rule: a button decorates its toolbar (both realms); a component is hosted in its place (renderer realm)', async () => {
  const sent = [], local = new Map();
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.c', realm: 'host', channel });
  const b = host.api.composer.control({ id: 'tpl', title: ' Template ', run: () => {} });
  assert.equal(await b.accepted, true);
  assert.deepEqual(sent[0], { kind: 'decorate', presentation: 'Composer', id: 'tpl', data: { actions: [{ id: 'tpl', title: 'Template', run: { $fn: 'actions.0.run' } }] }, callbacks: ['actions.0.run'], reg: sent[0].reg });
  assert.throws(() => host.api.composer.control({ id: 'x', render: () => null }), /renderer realm/);
  assert.throws(() => host.api.composer.control({ id: 'x', title: 'X', run() {}, place: 'pickers' }), /toolbar/);
  const page = createRuleApi({ modId: 'unit.c', realm: 'renderer', channel, local: { set: (k, f) => local.set(k, f), delete: (k) => local.delete(k) } });
  const render = () => null;
  await page.api.composer.control({ id: 'meter', place: 'belowInput', render, for: 'Draft' }).accepted;
  assert.deepEqual(sent[1], { kind: 'host', presentation: 'Composer', id: 'meter', for: 'Draft', slot: 'belowInput', reg: sent[1].reg });
  assert.equal(local.get('unit.c/meter').render, render);
  assert.throws(() => page.api.composer.control({ id: 'y', place: 'header', render }), /place is/);
});

test('E8.4: ui.menus.add is an add rule on the bar\'s Menu (for the App); the host realm\'s run is a callback, the renderer\'s stays in the page; update replaces in place', async () => {
  const sent = [], disposed = [], local = new Map(), bound = new Map();
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async (id) => { disposed.push(id); },
    callbacks: (id, reg, fn) => { bound.set(reg, fn); return { dispose() { bound.delete(reg); } }; } };
  const host = createRuleApi({ modId: 'unit.m', realm: 'host', channel });
  const h = host.api.menus.add({ id: 'pause', title: 'Pause Recording', in: 'view', keys: 'CmdOrCtrl+Alt+P', type: 'checkbox', checked: true, run: (env) => env.checked });
  assert.equal(await h.accepted, true);
  assert.deepEqual(sent[0], { kind: 'add', presentation: 'Menu', id: 'pause', for: 'App', slot: 'groups',
    data: { items: [{ id: 'pause', title: 'Pause Recording', in: 'view', keys: 'CmdOrCtrl+Alt+P', type: 'checkbox', checked: true, run: { $fn: 'items.0.run' } }] },
    callbacks: ['items.0.run'], reg: sent[0].reg });
  const first = sent[0].reg;
  assert.equal(await h.update({ checked: false, title: 'Resume Recording' }), true);
  assert.equal(sent[1].data.items[0].title, 'Resume Recording');
  assert.equal(sent[1].data.items[0].checked, undefined, 'unchecked');
  assert.notEqual(sent[1].reg, first, 'a new registration');
  assert.deepEqual(disposed, [], 'replaced in place: no dispose between');
  assert.equal(bound.has(first), false, 'the older registration\'s callbacks are let go');
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(disposed, ['pause']);
  for (const bad of [{ id: 'x', title: 'X', in: 'tools', run() {} }, { id: 'x', title: 'X', in: 'view' }, { id: 'x', title: '', in: 'view', run() {} }]) assert.throws(() => host.api.menus.add(bad));
  const page = createRuleApi({ modId: 'unit.r', realm: 'renderer', channel, local: { set: (k, f) => local.set(k, f), delete: (k) => local.delete(k) } });
  const run = () => {};
  await page.api.menus.add({ id: 'notes', title: 'New Note', in: { menu: 'Notes' }, run }).accepted;
  assert.deepEqual(sent.at(-1).data, { items: [{ id: 'notes', title: 'New Note', in: { menu: 'Notes' } }] });
  assert.equal(local.get('unit.r/notes').menuRun, run, 'the renderer realm\'s run stays in its window');
});

test('P5 v2: ui.commands.add is a Palette rule with its command (its run a callback in the host realm) and, with keys, a hidden menu bar entry holding the chord', async () => {
  const sent = [], disposed = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async (id) => { disposed.push(id); }, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.m', realm: 'host', channel });
  const h = host.api.commands.add({ id: 'sync', title: ' Sync now ', keys: 'CmdOrCtrl+Alt+Y', keywords: ['refresh'], run: () => {} });
  assert.equal(await h.accepted, true);
  assert.deepEqual(sent.map((d) => [d.presentation, d.id, d.slot]), [['Palette', 'sync', 'resultSources'], ['Menu', 'sync.keys', 'groups']]);
  assert.deepEqual(sent[0].data, { command: { title: 'Sync now', keywords: ['refresh'], run: { $fn: 'command.run' } } });
  assert.deepEqual(sent[0].callbacks, ['command.run']);
  assert.deepEqual(sent[1].data.items[0], { id: 'sync.keys', title: 'Sync now', in: 'view', keys: 'CmdOrCtrl+Alt+Y', visible: false, run: { $fn: 'items.0.run' } });
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(disposed.sort(), ['sync', 'sync.keys']);
  // no keys: the palette row only
  sent.length = 0;
  await host.api.commands.add({ id: 'plain', title: 'Plain', run: () => {} }).accepted;
  assert.deepEqual(sent.map((d) => d.presentation), ['Palette']);
  for (const bad of [{ id: 'x', title: 'X' }, { id: 'x', title: '', run() {} }, { id: 'x', title: 'X', keys: 3, run() {} }]) assert.throws(() => host.api.commands.add(bad), /ui.commands.add/);
});

test('layouts WL6: a named layout\'s entry in the menu bar is the user\'s pick, the framework\'s to run, and only of that mod\'s own layout', async () => {
  const { createMenuBar } = await import('../menu-bar.mjs');
  const reg = createRuleRegistry({ presentations: new Map([['Menu', new Set(['groups'])]]), rankOf: () => 1, typeExists: () => true });
  const picks = [], runs = [];
  let report = null;
  const mainOps = { op: async () => ({ ok: true }), onReport: (area, fn) => { report = fn; return { dispose() {} }; } };
  const entries = [];
  const bar = createMenuBar({ rules: reg, mainOps: { ...mainOps, op: async (a, o, x) => { entries.push(x); return { ok: true }; } }, windows: () => ({ pickLayout: async (w, id) => { picks.push([w, id]); return { status: 'done' }; }, runRule: async (w, m) => { runs.push([w, m]); return { status: 'done' }; } }), schedule: (fn) => { fn(); return 1; } });
  reg.register(who('unit.a', { window: 3 }), { id: 'focus.keys', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'focus.keys', title: 'Focus', in: { menu: 'Layouts' }, keys: 'CmdOrCtrl+9', layout: 'unit.a/focus' }] }, reg: 'p1' });
  reg.register(who('unit.a', { window: 3 }), { id: 'theirs', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'theirs', title: 'Theirs', in: { menu: 'Layouts' }, layout: 'unit.b/focus' }] }, reg: 'p2' });
  await new Promise((r) => setImmediate(r));
  report({ event: 'choose', key: 'unit.a/focus.keys', reg: '3:p1', path: 'menuRun', windowId: 3, via: 'keys' });
  report({ event: 'choose', key: 'unit.a/theirs', reg: '3:p2', path: 'menuRun', windowId: 3, via: 'menu' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(picks, [[3, 'unit.a/focus']], 'another mod\'s layout is not this mod\'s to pick for the user');
  report({ event: 'choose', key: 'unit.a/focus.keys', reg: '3:p-older', path: 'menuRun', windowId: 3, via: 'menu' });
  await new Promise((r) => setImmediate(r));
  assert.equal(picks.length, 1, 'a late choice from a menu built for an older registration is nothing');
  assert.deepEqual(runs, [], 'no mod\'s function runs: no grant is asked of it');
  assert.equal(entries.flatMap((x) => x.entries ?? []).some((e) => 'layout' in e.item), false, 'what framework-main takes has no such field');
  bar.dispose();
});

test('E8.4: the Host\'s menu bar projects the bar\'s rules in order to framework-main and runs a chosen entry where its function is', async () => {
  const { createMenuBar } = await import('../menu-bar.mjs');
  const reg = createRuleRegistry({ presentations: new Map([['Menu', new Set(['groups'])]]), rankOf: (id) => ({ 'unit.a': 1, 'unit.b': 2 })[id] ?? 9, typeExists: () => true });
  const ops = [], runs = [], invoked = [];
  let report = null;
  const mainOps = { op: async (area, op, args) => { ops.push([area, op, args]); return { ok: true }; }, onReport: (area, fn) => { assert.equal(area, 'menus'); report = fn; return { dispose() {} }; } };
  const timers = [];
  const bar = createMenuBar({ rules: reg, mainOps, windows: () => ({ runRule: async (w, m) => { runs.push([w, m]); return { status: 'done' }; } }), schedule: (fn) => { timers.push(fn); return 1; } });
  const flush = async () => { while (timers.length) await timers.shift()(); };
  const hostMod = who('unit.b', { realm: 'host', window: undefined });
  reg.register(hostMod, { id: 'h', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'h', title: 'Host Entry', in: 'file', run: { $fn: 'items.0.run' } }] }, callbacks: ['items.0.run'], reg: 'r1' });
  reg.register(who('unit.a', { window: 3 }), { id: 'p', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'p', title: 'Page Entry', in: 'view' }] }, reg: 'p3' });
  reg.register(who('unit.a', { window: 4 }), { id: 'p', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'p', title: 'Page Entry', in: 'view' }] }, reg: 'p4' });
  reg.register(who('unit.a'), { id: 'thread', kind: 'add', presentation: 'Menu', for: 'Thread', slot: 'groups', data: { items: [{ id: 't', title: 'Thread Entry' }] } });
  await flush();
  assert.deepEqual(ops.at(-1), ['menus', 'set', { entries: [
    { key: 'unit.a/p', reg: '3:p3,4:p4', mod: 'unit.a', realm: 'renderer', path: 'menuRun', item: { id: 'p', title: 'Page Entry', in: 'view' } },
    { key: 'unit.b/h', reg: 'r1', mod: 'unit.b', realm: 'host', path: 'items.0.run', item: { id: 'h', title: 'Host Entry', in: 'file' } },
  ] }], 'in rule order (the mod\'s rank); a thread\'s menu entries are not the bar\'s; no function crosses');
  reg.bindCallbacks(hostMod, 'h', 'r1', async (args) => { invoked.push(args); return null; });
  report({ event: 'choose', key: 'unit.b/h', reg: 'r1', path: 'items.0.run', windowId: 3, checked: null, via: 'keys' });
  report({ event: 'choose', key: 'unit.a/p', reg: '3:p3,4:p4', path: 'menuRun', windowId: 3, checked: true, via: 'menu' });
  report({ event: 'choose', key: 'unit.a/gone', reg: null, path: 'menuRun', windowId: 3 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(invoked[0][0], 'items.0.run');
  assert.deepEqual(invoked[0][1], { subject: { type: 'App', provider: 'codex', id: 'codex' }, _presentation: null, window: { type: 'Window', provider: 'codexmods.windows', id: '3' }, pane: null, thread: null, draft: null, via: 'keys' });
  // a renderer entry runs in the window it was chosen in, naming that window's registration as the menu was built (review 4, round 2)
  assert.deepEqual(runs, [[3, { key: 'unit.a/p', reg: 'p3', path: 'menuRun', env: { subject: { type: 'App', provider: 'codex', id: 'codex' }, _presentation: null, window: { type: 'Window', provider: 'codexmods.windows', id: '3' }, pane: null, thread: null, draft: null, via: 'menu', checked: true } }]]);
  // window 3 registers it again: the bar is built again with the new token; a choice from the older menu still names the older one
  reg.register(who('unit.a', { window: 3 }), { id: 'p', kind: 'add', presentation: 'Menu', for: 'App', slot: 'groups', data: { items: [{ id: 'p', title: 'Page Entry', in: 'view' }] }, reg: 'p3b' });
  await flush();
  assert.equal(ops.at(-1)[2].entries[0].reg, '3:p3b,4:p4');
  report({ event: 'choose', key: 'unit.a/p', reg: '3:p3,4:p4', path: 'menuRun', windowId: 3, via: 'menu' });
  report({ event: 'choose', key: 'unit.a/p', reg: '3:p3,4:p4', path: 'menuRun', windowId: 9, via: 'menu' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs.slice(1).map(([w, m]) => [w, m.reg]), [[3, 'p3'], [9, null]], 'the page compares it with its own (p3b): not run; a window the menu did not know names none');
  const n = ops.length;
  await flush();
  assert.equal(ops.length, n, 'nothing changed: nothing sent');
  reg.disposeMod('unit.a');
  await flush();
  assert.deepEqual(ops.at(-1)[2].entries.map((e) => e.key), ['unit.b/h'], 'a mod that stops: its entries leave');
  bar.dispose();
});

test('E8.5: ui.palette.source is an add rule on Palette resultSources; a host source\'s search and choose are callbacks (search within 3 s)', async () => {
  const sent = [], bound = new Map();
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: (id, reg, fn) => { bound.set(reg, fn); return { dispose() {} }; } };
  const host = createRuleApi({ modId: 'unit.p', realm: 'host', channel });
  const seen = [];
  await host.api.palette.source({ id: 'notes', title: 'Notes', position: 'above', trigger: 'note', search: (q, env) => { seen.push([q, env.via]); return [{ id: 'a', title: `Note ${q}` }]; }, choose: (row) => seen.push(['chose', row.id]),
    items: [{ id: 'new', title: 'New note', run: () => {} }] }).accepted;
  assert.deepEqual(sent[0].data, { source: { title: 'Notes', position: 'above', trigger: 'note', search: { $fn: 'source.search' }, choose: { $fn: 'source.choose' } }, items: [{ id: 'new', title: 'New note', run: { $fn: 'items.0.run' } }] });
  assert.deepEqual(sent[0].callbacks.sort(), ['items.0.run', 'source.choose', 'source.search']);
  const fn = bound.get(sent[0].reg);
  assert.deepEqual(await fn('source.search', { arg: 'milk', env: { via: 'palette' } }), [{ id: 'a', title: 'Note milk' }]);
  await fn('source.choose', { arg: { id: 'a', title: 'Note milk' }, env: { via: 'palette' } });
  assert.deepEqual(seen, [['milk', 'palette'], ['chose', 'a']]);
  for (const bad of [{ id: 'x' }, { id: 'x', title: 'X' }, { id: 'x', group: 'nope', items: [] }, { id: 'x', title: 'X', search: 'no' }]) assert.throws(() => host.api.palette.source(bad));
  // the Host: source.search and source.choose are callback places; search runs within 3 s
  const reg = createRuleRegistry({ presentations: new Map([['Palette', new Set(['resultSources'])]]), rankOf: () => 1 });
  const mod = who('unit.p', { realm: 'host', window: undefined });
  reg.register(mod, { id: 'notes', kind: 'add', presentation: 'Palette', slot: 'resultSources', data: sent[0].data, callbacks: sent[0].callbacks, reg: 'r1' });
  const budgets = [];
  reg.bindCallbacks(mod, 'notes', 'r1', async (args, ms) => { budgets.push([args[0], ms]); return []; });
  await reg.callback('unit.p/notes', 'r1', 'source.search', { arg: 'q', env: {} });
  await reg.callback('unit.p/notes', 'r1', 'items.0.run', {});
  assert.deepEqual(budgets, [['source.search', 3000], ['items.0.run', 30000]]);
  assert.throws(() => reg.register(mod, { id: 'bad', kind: 'add', presentation: 'Palette', slot: 'resultSources', data: { source: { title: 'X', other: { $fn: 'source.other' } } }, callbacks: ['source.other'], reg: 'r2' }), /at its own path/);
});

test('E8.6: ui.composer.slash is an add rule on the Draft\'s Palette; a host command\'s run is a callback; a prompt command is data', async () => {
  const sent = [], bound = new Map();
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: (id, reg, fn) => { bound.set(reg, fn); return { dispose() {} }; } };
  const host = createRuleApi({ modId: 'unit.s', realm: 'host', channel });
  await host.api.composer.slash({ id: 'sum', name: 'summarize', title: 'Summarize', description: 'Summarize the chat', run: (env) => env.draft }).accepted;
  assert.deepEqual(sent[0], { kind: 'add', presentation: 'Palette', id: 'sum', for: 'Draft', slot: 'resultSources',
    data: { slash: { name: 'summarize', title: 'Summarize', description: 'Summarize the chat', run: { $fn: 'slash.run' } } }, callbacks: ['slash.run'], reg: sent[0].reg });
  assert.equal(await bound.get(sent[0].reg)('slash.run', { draft: 'd1' }), 'd1');
  await host.api.composer.slash({ id: 'tpl', name: 'tpl', prompt: 'Review this:' }).accepted;
  assert.deepEqual(sent[1].data, { slash: { name: 'tpl', prompt: 'Review this:' } });
  for (const bad of [{ id: 'x', name: 'Bad Name', run() {} }, { id: 'x', name: 'x' }, { id: 'x', name: 'x', run() {}, prompt: 'p' }]) assert.throws(() => host.api.composer.slash(bad));
  const reg = createRuleRegistry({ presentations: new Map([['Palette', new Set(['resultSources'])]]), rankOf: () => 1, typeExists: () => true });
  reg.register(who('unit.s', { realm: 'host', window: undefined }), { ...sent[0] });
  assert.deepEqual(reg.snapshot()[0].callbacks, ['slash.run']);
});

test('graph-layers L3 (was E8 review): a renderer rule is each window\'s own registration; the newest is told, its regs only the windows that match it', () => {
  const reg = createRuleRegistry({ presentations: new Map([['Menu', new Set(['groups'])]]), rankOf: () => 1 });
  const d = { kind: 'add', presentation: 'Menu', id: 'e', slot: 'groups', data: { items: [{ id: 'a', title: 'A' }] } };
  const b = { ...d, data: { items: [{ id: 'a', title: 'B' }] } };
  const told = () => reg.snapshot().find((r) => r.id === 'e');
  reg.register(who('m', { window: 1, gen: 'g' }), { ...d, reg: 't1' });
  reg.register(who('m', { window: 2, gen: 'g' }), { ...d, reg: 't2' });
  assert.deepEqual(told().regs, { 1: 't1', 2: 't2' });
  // window 2's module updates it: told as window 2 has it; an app-wide run goes to window 2 only until window 1 updates too
  reg.register(who('m', { window: 2, gen: 'g' }), { ...b, reg: 't2b' });
  assert.deepEqual([told().data.items[0].title, told().regs], ['B', { 2: 't2b' }]);
  reg.register(who('m', { window: 1, gen: 'g' }), { ...b, reg: 't1b' });
  assert.deepEqual(told().regs, { 1: 't1b', 2: 't2b' });
  // the newest window goes: the newest remaining is told
  reg.register(who('m', { window: 2, gen: 'g' }), { ...d, reg: 't2c' });
  reg.closeWindow(2);
  assert.deepEqual([told().data.items[0].title, told().regs], ['B', { 1: 't1b' }]);
});

test('E8.9a: a mod\'s settings page is a host rule on SettingsPage pages with its title and group (the renderer realm\'s)', () => {
  const reg = createRuleRegistry({ presentations: new Map([['SettingsPage', new Set(['pages', 'sections'])]]), rankOf: () => 1 });
  const mod = who('unit.s');
  const ok = { kind: 'host', presentation: 'SettingsPage', id: 'p', slot: 'pages', data: { page: { title: 'Sync', group: 'integrations' } } };
  reg.register(mod, ok);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b1', data: { page: { title: '' } } }), /title of at most 80/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b2', data: { page: { title: 'X', group: 'sidebar' } } }), /group is one of mods, personal, integrations, coding/);
  assert.throws(() => reg.register(mod, { ...ok, id: 'b3', kind: 'add', data: { items: [] } }), /host rule with its page/);
});

test('graph-layers L3: ui.decorate(<subject>) puts one rule in each place that presents it, each with the kinds it draws; a kind none draws is said', async () => {
  const sent = [], disposed = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async (id) => { disposed.push(id); }, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.d', realm: 'host', channel });
  const h = host.api.decorate('Thread', { id: 'ticket', badges: [{ id: 'b', text: 'T-1' }], tooltip: 'x', actions: [{ id: 'open', title: 'Open ticket', run: () => {} }] });
  assert.equal(await h.accepted, true);
  assert.deepEqual(sent.map((d) => [d.presentation, d.id, d.for, Object.keys(d.data ?? {}).sort()]), [
    ['SidebarItem', 'ticket.SidebarItem', 'Thread', ['actions', 'badges']], ['ThreadHeader', 'ticket.ThreadHeader', 'Thread', ['actions', 'badges']]]);
  assert.deepEqual([h.places, h.unsupported], [['SidebarItem', 'ThreadHeader'], ['tooltip']], 'a tooltip no place draws: said');
  h.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(disposed.sort(), ['ticket.SidebarItem', 'ticket.ThreadHeader']);
  // `in` narrows; `for` a subtype; a place that draws none of the kinds gets no rule
  sent.length = 0;
  const label = host.api.decorate('Thread', { id: 'tag', label: 'urgent', for: 'CodexThread', in: ['SidebarItem', 'ThreadHeader'] });
  await label.accepted;
  assert.deepEqual(sent.map((d) => [d.presentation, d.for]), [['SidebarItem', 'CodexThread']]);
  assert.deepEqual(label.places, ['SidebarItem']);
  assert.throws(() => host.api.decorate('Thread', { id: 'x', label: 'y', in: ['MessageBlock'] }), /in is among/);
  assert.throws(() => host.api.decorate('Setting', { id: 'x', label: 'y' }), /no place of it draws label/);
  assert.throws(() => host.api.decorate('Thread', { id: 'x' }), /give badges/);
  // a presentation type: the rule as given
  sent.length = 0;
  await host.api.decorate('SidebarItem', { id: 'plain', for: 'Thread', label: 'p' }).accepted;
  assert.deepEqual(sent.map((d) => [d.presentation, d.id]), [['SidebarItem', 'plain']]);
  // public hooks §3.13: a file's preview, a browser tab, the Changes tab and a changed file's diff take actions
  sent.length = 0;
  for (const subject of ['File', 'BrowserTab', 'ChangeSet', 'FileChange']) await host.api.decorate(subject, { id: `a${subject}`, actions: [{ id: 'go', title: 'Go', run: () => {} }] }).accepted;
  assert.deepEqual(sent.map((d) => [d.presentation, d.for]), [['FilePreview', 'File'], ['BrowserView', 'BrowserTab'], ['ChangesView', 'ChangeSet'], ['DiffView', 'FileChange']]);
  // public hooks §3.13: a thread's summary, where its row and its header draw it
  sent.length = 0;
  const sum = host.api.decorate('Thread', { id: 'tk', summary: { title: '[{{@unit.d/ticket}}] {{title}}' } });
  await sum.accepted;
  assert.deepEqual([sum.places, sent.map((d) => [d.presentation, d.data.summary.title])], [['SidebarItem', 'ThreadHeader'], [['SidebarItem', '[{{@unit.d/ticket}}] {{title}}'], ['ThreadHeader', '[{{@unit.d/ticket}}] {{title}}']]]);
  assert.throws(() => host.api.decorate('Step', { id: 'x', summary: 'y' }), /no place of it draws summary/);
  // a message's and a turn's badges (§3.13): the agent's message's action row, its turn's final answer's
  sent.length = 0;
  await host.api.decorate('AgentMessage', { id: 'am', badges: [{ id: 'b', text: 'cited' }] }).accepted;
  await host.api.decorate('Turn', { id: 'tn', badges: [{ id: 'b', text: '12s' }] }).accepted;
  assert.deepEqual(sent.map((d) => [d.presentation, d.for, Object.keys(d.data)]), [['MessageBlock', 'AgentMessage', ['badges']], ['TurnView', 'Turn', ['badges']]]);
  // a project's group: its badges, its label and its summary (§3.13)
  sent.length = 0;
  await host.api.decorate('Project', { id: 'pj', badges: [{ id: 'b', text: 'prod' }], label: 'main', summary: 'Repo (prod)' }).accepted;
  assert.deepEqual(sent.map((d) => [d.presentation, d.for, Object.keys(d.data).sort()]), [['SidebarSection', 'Project', ['badges', 'label', 'summary']]]);
});

test('graph-layers L3, public hooks §3.12: ui.filter and ui.panels: a filter is an add rule on its list\'s filter; on, off and a panel\'s open go to a window through the Host (renderer: its own window here)', async () => {
  const sent = [], asked = [], local = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }),
    inWindow: async (id, op, args, window) => { asked.push([id, op, args, window]); return { status: 'done', value: null }; } };
  const host = createRuleApi({ modId: 'unit.f', realm: 'host', channel });
  const f = host.api.filter('sidebar', { id: 'tickets', title: ' Tickets ', where: 'ticket' });
  assert.equal(await f.accepted, true);
  assert.deepEqual([sent[0].presentation, sent[0].slot, sent[0].data], ['Sidebar', 'filter', { filter: { title: 'Tickets', where: 'ticket' } }]);
  await f.on();
  await f.off({ window: { type: 'Window', provider: 'codexmods.windows', id: '7' } });
  assert.deepEqual(asked, [['tickets', 'filter.on', {}, null], ['tickets', 'filter.off', {}, { type: 'Window', provider: 'codexmods.windows', id: '7' }]]);
  assert.throws(() => host.api.filter('sidebar', { id: 'k', title: 'K', keep: () => true }), /renderer realm/);
  assert.throws(() => host.api.filter('sidebar', { id: 'k', title: 'K' }), /give where, threads or keep/);
  for (const [list, spec, re] of [['inbox', { id: 'k', title: 'K', where: {} }, /one of sidebar, transcript, files, changes/], ['files', { id: 'k', title: 'K', threads: [] }, /threads are the sidebar's/],
    ['changes', { id: 'k', title: 'K', where: {}, for: 'Step' }, /for is the transcript's/], ['transcript', { id: 'k', title: 'K' }, /give where or keep/]]) assert.throws(() => host.api.filter(list, spec), re);
  sent.length = 0;
  const t = host.api.filter('transcript', { id: 'quiet', title: 'Quiet', for: 'Step', where: { kind: 'command' } });
  await t.accepted;
  assert.deepEqual([sent[0].presentation, sent[0].slot, sent[0].data], ['ThreadView', 'filter', { filter: { title: 'Quiet', where: { kind: 'command' }, for: 'Step' } }]);
  await t.on();
  assert.deepEqual(asked.at(-1), ['quiet', 'filter.on', {}, null]);
  for (const [list, presentation] of [['files', 'FilesView'], ['changes', 'ChangesView']]) {
    await host.api.filter(list, { id: list, title: list, where: { path: { $prefix: '/r/' } } }).accepted;
    assert.equal(sent.at(-1).presentation, presentation);
  }
  await host.api.panels.open('notes', { target: 'bottom', window: { type: 'Window', provider: 'codexmods.windows', id: '7' } });
  assert.deepEqual(asked.at(-1), ['notes', 'panel.open', { target: 'bottom' }, { type: 'Window', provider: 'codexmods.windows', id: '7' }]);
  // public hooks §3.14: a view's placement (the Host makes a window for one in its own window)
  for (const placement of ['modal', 'side', 'window']) {
    await host.api.panels.open('notes', { placement });
    assert.deepEqual(asked.at(-1), ['notes', 'panel.open', { placement }, null]);
  }
  await assert.rejects(host.api.panels.open('notes', { placement: 'floating' }), { code: 'Invalid' });
  // the renderer realm: its keep stays in the page (the Host gets the data), and on() with no window is this window's
  const page = createRuleApi({ modId: 'unit.f', realm: 'renderer', channel, local: { set() {}, delete() {} }, filters: { set: (id, on) => { local.push([id, on]); return true; } } });
  sent.length = 0;
  const keep = () => true;
  const g = page.api.filter('sidebar', { id: 'mine', title: 'Mine', keep });
  await g.accepted;
  assert.deepEqual(sent[0].data, { filter: { title: 'Mine' } });
  await g.on();
  assert.deepEqual(local, [['mine', true]]);
  // the Host: only this mod's own declaration, in the window named or in front
  const reg = createRuleRegistry({ presentations: new Map([['Sidebar', new Set(['filter'])], ['ThreadView', new Set(['filter', 'header'])], ['ChangesView', new Set(['filter'])]]), rankOf: () => 1 });
  const acts = [];
  const ns = createUiNs({ rules: () => reg, windows: () => ({ frontWindow: async () => 3, declarationAct: async (...a) => { acts.push(a); return { status: 'done', value: null }; } }) });
  const scope = { state: { id: 'unit.f', grants: ['graph.present'] }, realm: 'host' };
  ns.calls.register(scope, { id: 'tickets', kind: 'add', presentation: 'Sidebar', slot: 'filter', data: { filter: { title: 'Tickets', where: 'ticket' } } });
  assert.equal((await ns.calls.inWindow(scope, 'tickets', 'filter.on', {}, null)).status, 'done');
  assert.deepEqual(acts, [[3, 'unit.f/tickets', 'filter.on', {}, null]]);
  // a registration named: only that one (a dispatch begun before the filter was registered again acts on nothing)
  ns.calls.register(scope, { id: 'tickets', kind: 'add', presentation: 'Sidebar', slot: 'filter', data: { filter: { title: 'Tickets', where: 'ticket' } }, reg: 'r2' });
  await assert.rejects(ns.calls.inWindow(scope, 'tickets', 'filter.on', {}, null, 'r1'), /as that registration/);
  assert.equal((await ns.calls.inWindow(scope, 'tickets', 'filter.on', {}, null, 'r2')).status, 'done');
  assert.deepEqual(acts.at(-1), [3, 'unit.f/tickets', 'filter.on', {}, 'r2']);
  await assert.rejects(ns.calls.inWindow(scope, 'nope', 'filter.on', {}, null), /no rule nope/);
  await assert.rejects(ns.calls.inWindow({ state: { id: 'unit.g', grants: ['graph.present'] }, realm: 'host' }, 'tickets', 'filter.on', {}, null), /no rule tickets/, 'another mod\'s');
  await assert.rejects(ns.calls.inWindow(scope, 'tickets', 'delete', {}, null), /none of/);
  assert.throws(() => ns.calls.register(scope, { id: 'bad', kind: 'add', presentation: 'Sidebar', slot: 'filter', data: { filter: { title: '' } } }), /ui.filter\('sidebar'\): an add rule/);
  // text and chats are the sidebar's; for, the transcript's
  for (const [presentation, filter] of [['ThreadView', { title: 'T', where: 'text' }], ['ChangesView', { title: 'C', threads: [] }], ['ChangesView', { title: 'C', for: 'Step' }], ['ThreadView', { title: 'T', for: 'not a type' }]]) {
    assert.throws(() => ns.calls.register(scope, { id: 'bad2', kind: 'add', presentation, slot: 'filter', data: { filter } }), /ui.filter/);
  }
  ns.calls.register(scope, { id: 'quiet', kind: 'add', presentation: 'ThreadView', slot: 'filter', data: { filter: { title: 'Quiet', for: 'CommandStep', where: { exitCode: 0 } } } });
  assert.equal((await ns.calls.inWindow(scope, 'quiet', 'filter.on', {}, null)).status, 'done');
  assert.deepEqual(acts.at(-1), [3, 'unit.f/quiet', 'filter.on', {}, null]);
});

test('public hooks §3.12: a chat or project hidden from the sidebar is an add rule on Sidebar hidden, its type Thread or Project, its where and of the one grammar', () => {
  const reg = createRuleRegistry({ presentations: new Map([['Sidebar', new Set(['hidden', 'filter'])]]), rankOf: () => 1 });
  const ns = createUiNs({ rules: () => reg, windows: () => null });
  const scope = { state: { id: 'unit.h', grants: ['graph.present'] }, realm: 'host' };
  ns.calls.register(scope, { id: 'helpers', kind: 'add', presentation: 'Sidebar', slot: 'hidden', data: { hide: { for: 'Thread', where: { title: { $prefix: 'Helper' } } } } });
  ns.calls.register(scope, { id: 'scratch', kind: 'add', presentation: 'Sidebar', slot: 'hidden', data: { hide: { for: 'Project', of: [{ type: 'LocalProject', provider: 'codex', id: 'p9' }] } } });
  for (const hide of [{ for: 'Model' }, { for: 'Thread', where: { title: { $nope: 1 } } }, { for: 'Thread', of: [{ id: 'x' }] }, undefined]) {
    assert.throws(() => ns.calls.register(scope, { id: 'bad', kind: 'add', presentation: 'Sidebar', slot: 'hidden', data: { hide } }), /ui.hide\(Thread \| Project\)/);
  }
  assert.throws(() => ns.calls.register(scope, { id: 'bad', kind: 'hide', presentation: 'Sidebar', slot: 'hidden', data: { hide: { for: 'Thread' } } }), { code: 'Invalid' });
});

test('public hooks §3.14: a starter is an add rule on NewThreadView starters with one entry, only from a mod granted to start its chats', () => {
  const reg = createRuleRegistry({ presentations: new Map([['NewThreadView', new Set(['starters'])]]), rankOf: () => 1 });
  const ns = createUiNs({ rules: () => reg, windows: () => null });
  const as = (grants) => ({ state: { id: 'unit.s', grants: ['graph.present', ...grants] }, realm: 'host' });
  const entry = { id: 'st', title: 'Review', run: { $fn: 'items.0.run' } };
  const starter = { title: 'Review', in: ['newThread', 'palette'] };
  const rule = (st, items = [entry]) => ({ id: 'st', kind: 'add', presentation: 'NewThreadView', slot: 'starters', data: { starter: st, ...(items ? { items } : {}) }, ...(items ? { callbacks: ['items.0.run'] } : {}), reg: 'r1' });
  assert.throws(() => ns.calls.register(as([]), rule(starter)), /needs graph.act for Project.newThread and Agent.newThread/);
  assert.throws(() => ns.calls.register(as(['graph.act:Project.newThread']), rule(starter)), { code: 'Denied' }, 'a chat of no project is the agent\'s');
  ns.calls.register(as(['graph.act:LocalProject.newThread,CodexAgent.newThread']), rule(starter));
  ns.calls.register(as(['graph.act']), rule(starter, null));   // a renderer-realm entry stays in its page: the declaration alone
  for (const [st, items] of [[starter, []], [starter, [entry, entry]], [{ ...starter, title: '' }, [entry]], [{ ...starter, in: ['sidebar'] }, [entry]], [{ title: 'R' }, [entry]], [undefined, [entry]]]) {
    assert.throws(() => ns.calls.register(as(['graph.act']), rule(st, items)), { code: 'Invalid' });
  }
});

test('public hooks §3.14: an attachment source is an add rule on the composer\'s Palette with attach and one entry, only from a mod granted Draft.attach', () => {
  const reg = createRuleRegistry({ presentations: new Map([['Palette', new Set(['resultSources'])]]), rankOf: () => 1 });
  const ns = createUiNs({ rules: () => reg, windows: () => null });
  const as = (grants) => ({ state: { id: 'unit.a', grants: ['graph.present', ...grants] }, realm: 'host' });
  const rule = (data, more = {}) => ({ id: 'clip', kind: 'add', presentation: 'Palette', for: 'Draft', slot: 'resultSources', data, callbacks: ['items.0.run'], reg: 'r1', ...more });
  const good = { attach: { title: 'Clipboard' }, items: [{ id: 'clip', title: 'Clipboard', run: { $fn: 'items.0.run' } }] };
  assert.throws(() => ns.calls.register(as([]), rule(good)), /needs graph.act for Draft.attach/);
  ns.calls.register(as(['graph.act:Draft.attach']), rule(good));
  for (const [data, more] of [[{ ...good, attach: { title: '' } }, {}], [{ ...good, items: [] }, {}], [good, { for: 'Thread' }]]) {
    assert.throws(() => ns.calls.register(as(['graph.act']), rule(data, more)), { code: 'Invalid' });
  }
});

test('public hooks §3.14: a redaction is an add rule on ContentView redact with a bounded pattern, at most 40 characters shown and known sites', () => {
  const reg = createRuleRegistry({ presentations: new Map([['ContentView', new Set(['partRenderers', 'redact'])]]), rankOf: () => 1 });
  const ns = createUiNs({ rules: () => reg, windows: () => null });
  const scope = { state: { id: 'unit.r', grants: ['graph.present'] }, realm: 'host' };
  const rule = (redact, kind = 'add') => ({ id: 'keys', kind, presentation: 'ContentView', slot: 'redact', data: { redact } });
  ns.calls.register(scope, rule({ match: { source: 'sk-[a-z0-9]+', flags: 'i' }, as: '[key]', sites: ['agent-message'] }));
  for (const [redact, kind] of [[{ match: { source: '(?=x)', flags: '' } }], [{ match: { source: 'a', flags: '' }, as: 'x'.repeat(41) }], [{ match: { source: 'a', flags: '' }, sites: ['nowhere'] }], [{ match: { source: 'a', flags: '' } }, 'decorate']]) {
    assert.throws(() => ns.calls.register(scope, rule(redact, kind)), /ui.content.redact/);
  }
});

test('graph-layers L3: ui.banner is a host rule on the Window\'s banner (renderer realm)', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const page = createRuleApi({ modId: 'unit.b', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  await page.api.banner({ id: 'notice', render: () => null }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].id], ['host', 'Window', 'banner', 'notice']);
  const host = createRuleApi({ modId: 'unit.b', realm: 'host', channel, callbacks: () => ({ dispose() {} }) });
  assert.throws(() => host.api.banner({ id: 'x', render: () => null }), /renderer realm/);
});

test('public hooks §3.12 (review): a renderer filter turned on at once is on once the Host takes it; one refused is never turned on', async () => {
  const local = [];
  let accept = true;
  const channel = { register: async () => { await new Promise((r) => setTimeout(r, 5)); if (!accept) throw new Error('Denied'); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const page = createRuleApi({ modId: 'unit.f', realm: 'renderer', channel, local: { set() {}, delete() {} }, filters: { set: (id, on) => { local.push([id, on]); return true; } } });
  const f = page.api.filter('transcript', { id: 'calm', title: 'Calm', where: { kind: 'command' } });
  assert.equal(await f.on(), true);
  assert.deepEqual(local, [['calm', true]], 'set after the Host took it, not before');
  accept = false;
  const g = page.api.filter('files', { id: 'no', title: 'No', where: { name: 'x' } });
  await assert.rejects(g.on(), /refused, disposed or registered again/);
  assert.deepEqual(local, [['calm', true]]);
});

test('graph-layers L3 (built review): a disposed or replaced filter handle acts on nothing', async () => {
  const asked = [];
  const channel = { register: async () => ({ order: 1 }), dispose: async () => {}, callbacks: () => ({ dispose() {} }), inWindow: async (...a) => { asked.push(a); return { status: 'done' }; } };
  const host = createRuleApi({ modId: 'unit.f', realm: 'host', channel });
  const f = host.api.filter('sidebar', { id: 'tickets', title: 'Tickets', where: 'T-' });
  await f.accepted;
  f.dispose();
  await assert.rejects(f.on(), /disposed or registered again/);
  const g = host.api.filter('sidebar', { id: 'tickets', title: 'Tickets 2', where: 'T-' });
  await g.accepted;
  await assert.rejects(f.on(), /disposed or registered again/, 'the old handle never turns the new one on');
  await g.on();
  assert.equal(asked.length, 1);
});

test('public hooks §3.13: a handle updates its declaration in place (the same id, the newer registration replacing the older)', async () => {
  const calls = [];
  const channel = { register: async (d) => { calls.push(['register', d]); return {}; }, dispose: async (id) => { calls.push(['dispose', id]); return true; } };
  const { api } = createRuleApi({ modId: 'unit.a', realm: 'host', channel });
  const h = api.decorate('SidebarItem', { id: 'n', for: 'Thread', label: 'one' });
  assert.equal(await h.accepted, true);
  assert.equal(await h.update({ label: 'two', where: { status: 'working' } }), true);
  assert.deepEqual(calls.filter(([k]) => k === 'register').map(([, d]) => [d.id, d.data.label, d.where ?? null]), [['n', 'one', null], ['n', 'two', { status: 'working' }]]);
  assert.equal(calls.some(([k]) => k === 'dispose'), false, 'replaced, never disposed between');
  assert.throws(() => h.update({ id: 'other' }), /cannot change/);
  assert.throws(() => h.update('x'), /fields to change/);
  // a subject decoration: its places follow the patch; a place it no longer draws in goes
  const s = api.decorate('Thread', { id: 'tag', badges: [{ id: 'b', text: 'x' }] });
  assert.deepEqual(s.places, ['SidebarItem', 'ThreadHeader']);
  await s.update({ in: 'SidebarItem' });
  assert.deepEqual(s.places, ['SidebarItem']);
  assert.ok(calls.some(([k, id]) => k === 'dispose' && id === 'tag.ThreadHeader'), 'the header rule went');
  // a list's filter keeps its on and off
  const f = api.filter('sidebar', { id: 'mine', title: 'Mine', where: { pinned: true } });
  assert.equal(typeof f.on, 'function');
  await f.update({ title: 'Pinned' });
  assert.equal(calls.filter(([k, d]) => k === 'register' && d.id === 'mine').at(-1)[1].data.filter.title, 'Pinned');
  assert.equal(typeof f.on, 'function');
  h.dispose();
  assert.equal(await h.update({ label: 'three' }), false, 'a disposed handle updates nothing');
});

test('public hooks §3.10: rules on the app\'s own parts: named, never protected, never a protected holder whole; what the build lacks is said', async () => {
  const presentations = new Map([['Menu', new Set(['groups', 'items'])], ['RequestCard', new Set(['body', 'actions', 'answers'])], ['Composer', new Set(['toolbar', 'pickers', 'aboveInput'])]]);
  const all = new Set(['hide', 'decorate', 'reorder']);
  const parts = new Map([['Menu', new Map([['items', new Map(['rename', 'delete', 'share', 'fork', 'pin'].map((n) => [n, all]))]])]]);
  const reg = createRuleRegistry({ presentations, parts, rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  const ok = reg.register(who, { id: 'h', kind: 'hide', presentation: 'Menu', for: 'Thread', part: ['delete', 'share'] });
  assert.equal(ok.unsupported, undefined, 'nothing unsupported: nothing said');
  assert.deepEqual(reg.register(who, { id: 'h2', kind: 'hide', presentation: 'Menu', part: 'remove' }).unsupported, ['remove'], 'a part this build does not draw is said');
  assert.equal(reg.register(who, { id: 'l', kind: 'decorate', presentation: 'Menu', part: 'rename', data: { label: 'Retitle' } }).unsupported, undefined);
  assert.deepEqual(reg.register(who, { id: 'o', kind: 'reorder', presentation: 'Menu', slot: 'items', data: { order: ['delete', 'mine', 'fork'] } }).unsupported, undefined, 'a mod\'s own entries may be named in an order');
  const refused = (raw, code, re) => assert.throws(() => reg.register(who, { id: 'x', ...raw }), (e) => e.code === code && re.test(e.message), JSON.stringify(raw));
  refused({ kind: 'hide', presentation: 'Menu', part: 'nope' }, 'Invalid', /has no part nope/);
  refused({ kind: 'decorate', presentation: 'Menu', part: 'rename', data: { badges: [] } }, 'Invalid', /relabels it/);
  refused({ kind: 'add', presentation: 'Menu', slot: 'groups', part: 'rename', data: { items: [] } }, 'Invalid', /takes no part/);
  refused({ kind: 'hide', presentation: 'RequestCard', part: 'deny' }, 'Denied', /protected/);
  refused({ kind: 'decorate', presentation: 'RequestCard', part: 'allowAlways', data: { label: 'Sure' } }, 'Invalid', /never relabelled/);
  refused({ kind: 'hide', presentation: 'Composer', part: 'stop' }, 'Denied', /protected/);
  refused({ kind: 'hide', presentation: 'Composer' }, 'Denied', /holds protected parts/);
  refused({ kind: 'hide', presentation: 'RequestCard' }, 'Denied', /holds protected parts/);
  assert.ok(reg.register(who, { id: 'scope', kind: 'hide', presentation: 'RequestCard', part: 'allowAlways' }), 'an optional scope may be hidden');
  // reflection: the catalogue with this build's support
  const menu = reg.parts('Menu');
  assert.deepEqual(menu.filter((p) => p.supported).map((p) => p.part).sort(), ['delete', 'fork', 'pin', 'rename', 'share']);
  assert.equal(menu.find((p) => p.part === 'delete').for[0], 'Thread');
  assert.deepEqual(reg.parts('RequestCard', 'answers').map((p) => [p.part, !!p.protected, !!p.optional]), [['allowOnce', true, false], ['allowThread', false, true], ['allowAlways', false, true], ['deny', true, false]]);
  // the client carries unsupported and the call
  const calls = [];
  const { api } = createRuleApi({ modId: 'unit.a', realm: 'host', channel: { register: async (d) => { calls.push(d); return { order: 1, unsupported: d.part?.includes('remove') ? ['remove'] : [] }; }, dispose: async () => true, parts: async (p, s) => reg.parts(p, s ?? undefined) } });
  const h = api.hide('Menu', { id: 'gone', for: 'Project', part: ['remove'] });
  assert.equal(await h.accepted, true);
  assert.deepEqual(h.unsupported, ['remove']);
  assert.deepEqual(calls[0].part, ['remove']);
  assert.equal((await api.parts('Menu')).length, menu.length);
});

test('public hooks §3.10: what a build supports is per part and per kind (addresses.json parts and partKinds)', async () => {
  const { partsSupported } = await import('../ui-rules.mjs');
  const parts = partsSupported({ bindings: [{ id: 'c', presentation: 'Composer', parts: { toolbar: ['attach'] } }, { id: 'p', presentation: 'ComposerPicker', partsOf: 'Composer', parts: { pickers: ['model'] } }],
    rules: [{ id: 'm', presentation: 'Menu', parts: { items: ['rename'] }, partKinds: ['hide', 'decorate', 'reorder'] }] });
  const reg = createRuleRegistry({ presentations: new Map([['Composer', new Set(['toolbar', 'pickers'])], ['Menu', new Set(['items'])]]), parts, rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  assert.equal(reg.register(who, { id: 'a', kind: 'hide', presentation: 'Composer', part: ['attach', 'model'] }).unsupported, undefined, 'a partsOf entry counts for its presentation');
  assert.deepEqual(reg.register(who, { id: 'b', kind: 'decorate', presentation: 'Composer', part: 'attach', data: { label: 'Add' } }).unsupported, ['attach'], 'hide only: a relabel is said');
  assert.equal(reg.register(who, { id: 'c', kind: 'decorate', presentation: 'Menu', part: 'rename', data: { label: 'Retitle' } }).unsupported, undefined);
  assert.deepEqual(reg.parts('Composer', 'toolbar').find((p) => p.part === 'attach').kinds, ['hide']);
});

test('layouts §4.1: the sidebar footer\'s parts: its banners and buttons hidden; the account and update controls protected', async () => {
  const { partsSupported } = await import('../ui-rules.mjs');
  const addresses = JSON.parse((await import('node:fs')).readFileSync(new URL('../../renderer/present/addresses.json', import.meta.url), 'utf8'));
  const reg = createRuleRegistry({ presentations: presentationsOf(addresses), parts: partsSupported(addresses), rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  assert.equal(reg.register(who, { id: 'i', kind: 'hide', presentation: 'Sidebar', part: ['invite', 'announcement', 'usage', 'gettingStarted', 'updateBanner'] }).unsupported, undefined);
  for (const part of ['account', 'update']) assert.throws(() => reg.register(who, { id: part, kind: 'hide', presentation: 'Sidebar', part }), { code: 'Denied' }, part);
  assert.deepEqual(reg.register(who, { id: 'd', kind: 'decorate', presentation: 'Sidebar', part: 'invite', data: { label: 'Bring your team' } }).unsupported, ['invite'], 'hide only');
  assert.ok(reg.register(who, { id: 'rows', kind: 'add', presentation: 'Sidebar', slot: 'items', data: { items: [{ id: 'a', title: 'QA' }] } }), 'a mod\'s footer rows');
});

test('layouts WL4a: a region is a renderer-realm add rule on the Window\'s regions with its title, edge and width', async () => {
  const reg = createRuleRegistry({ presentations: new Map([['Window', new Set(['regions', 'status'])]]), rankOf: () => 1, typeExists: () => true });
  const who = (realm) => ({ id: 'unit.a', grants: ['graph.present'], realm, gen: 1 });
  const ok = { id: 'r', kind: 'add', presentation: 'Window', slot: 'regions', data: { region: { title: 'Notes', edge: 'right', width: { default: 300 } } } };
  assert.ok(reg.register(who('renderer'), ok));
  assert.throws(() => reg.register(who('host'), { ...ok, id: 'h' }), /renders: register it from the renderer realm/);
  assert.throws(() => reg.register(who('renderer'), { ...ok, id: 'e', data: { region: { title: 'Notes', edge: 'top' } } }), /edge is left or right/);
  assert.throws(() => reg.register(who('renderer'), { ...ok, id: 'w', data: { region: { title: 'Notes', edge: 'left', width: { default: 2000 } } } }), /160 to 960/);
});

test('layouts D9: the sidebar is a protected holder: never hidden or replaced whole (its groups keep the chats that need the user)', async () => {
  const reg = createRuleRegistry({ presentations: new Map([['Sidebar', new Set(['sections'])]]), rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  assert.throws(() => reg.register(who, { id: 'h', kind: 'hide', presentation: 'Sidebar' }), { code: 'Denied' });
});

test('layouts D3: the TitleBar\'s sidebar toggle is relabelled, its other parts only hidden (addresses.json partKinds)', async () => {
  const { partsSupported } = await import('../ui-rules.mjs');
  const addresses = JSON.parse((await import('node:fs')).readFileSync(new URL('../../renderer/present/addresses.json', import.meta.url), 'utf8'));
  const reg = createRuleRegistry({ presentations: presentationsOf(addresses), parts: partsSupported(addresses), rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  const kinds = Object.fromEntries(reg.parts('TitleBar', 'actions').map((p) => [p.part, p.kinds ?? []]));
  assert.deepEqual([kinds.sidebarToggle, kinds.history, kinds.bottomPanelToggle], [['decorate', 'hide'], ['hide'], []]);
  assert.equal(reg.register(who, { id: 's', kind: 'decorate', presentation: 'TitleBar', part: 'sidebarToggle', data: { label: 'Navigator' } }).unsupported, undefined);
  assert.deepEqual(reg.register(who, { id: 'h', kind: 'decorate', presentation: 'TitleBar', part: ['history', 'threadActions'], data: { label: 'Go' } }).unsupported, ['history', 'threadActions'],
    'two buttons, or a composite: no one label, said');
});

test('palette group order and rank (§3.10): the app\'s groups are the palette\'s parts, reordered only (hiding a group\'s commands is ui.hide(\'Command\')); its commands by id; by name lists only', async () => {
  const { partsSupported } = await import('../ui-rules.mjs');
  const addresses = JSON.parse((await import('node:fs')).readFileSync(new URL('../../renderer/present/addresses.json', import.meta.url), 'utf8'));
  const reg = createRuleRegistry({ presentations: presentationsOf(addresses), parts: partsSupported(addresses), rankOf: () => 1, typeExists: () => true });
  const who = { id: 'unit.a', grants: ['graph.present'], realm: 'host', gen: 1 };
  assert.equal(reg.register(who, { id: 'g', kind: 'reorder', presentation: 'Palette', slot: 'groups', data: { order: ['configure', 'app'] } }).unsupported, undefined);
  assert.equal(reg.register(who, { id: 'c', kind: 'reorder', presentation: 'Palette', slot: 'commands', data: { order: ['archiveThread'] } }).unsupported, undefined, 'commands by their ids');
  assert.deepEqual(reg.register(who, { id: 'h', kind: 'hide', presentation: 'Palette', part: 'skills' }).unsupported, ['skills'], 'a group is not hidden as a part: said');
  assert.deepEqual(reg.parts('Palette', 'groups').map((p) => [p.part, p.title, p.supported]), [['thread', 'Chat', true], ['navigation', 'Navigation', true], ['panels', 'Panels', true],
    ['workspace', 'Project', true], ['skills', 'Skills', true], ['configure', 'Configure', true], ['app', 'App', true]]);
  const { api } = createRuleApi({ modId: 'unit.a', realm: 'renderer', channel: { register: async () => ({ order: 1 }), dispose: async () => true, callbacks: () => ({ dispose() {} }) } });
  assert.throws(() => api.reorder('Palette', { id: 'f', slot: 'groups', order: (items) => items }), /ordered by a list of names/);
});

test('public hooks §3.14: ui.status is an add rule on its place\'s status slot, one status, checked alike by the client and the Host', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.s', realm: 'host', channel });
  const usage = { type: 'Usage', provider: 'unit.s', id: 'u' };
  await host.api.status({ id: 'cost', place: 'titleBar', text: '{{spent|number}} spent', tone: 'warning', meter: { value: { bind: 'spent' }, max: 100 }, subject: usage, run() {} }).accepted;
  await host.api.status({ id: 'chat', place: 'titleBar', for: 'Thread', text: { bind: 'status' } }).accepted;
  await host.api.status({ id: 'foot', place: 'sidebarFooter', text: 'Synced' }).accepted;
  await host.api.status({ id: 'ctx', place: 'composer', text: '{{thread.title}}', when: { 'thread.status': 'working' } }).accepted;
  assert.deepEqual(sent.map((d) => [d.kind, d.presentation, d.slot]), [['add', 'Window', 'status'], ['add', 'ThreadHeader', 'status'], ['add', 'Sidebar', 'status'], ['add', 'Composer', 'status']],
    'the title bar: a chat\'s status on its page, the window\'s on every page');
  assert.deepEqual(sent[0].data, { items: [{ id: 'cost', text: '{{spent|number}} spent', tone: 'warning', meter: { value: { bind: 'spent' }, max: 100 }, run: { $fn: 'items.0.run' } }], subject: usage });
  assert.deepEqual(sent[0].callbacks, ['items.0.run']);
  for (const [spec, re] of [
    [{ id: 'x', place: 'dock', text: 'a' }, /place is one of/],
    [{ id: 'x', place: 'titleBar' }, /shows text, a meter or an icon/],
    [{ id: 'x', place: 'titleBar', text: 'a', tone: 'red' }, /tone is one of/],
    [{ id: 'x', place: 'titleBar', text: 'x'.repeat(201) }, /at most 200/],
    [{ id: 'x', place: 'titleBar', meter: { value: 'half' } }, /a meter is/],
    [{ id: 'x', place: 'titleBar', text: 'a', subject: { id: 'u' } }, /subject is a ref/],
    [{ id: 'x', place: 'titleBar', text: 'a', run: 'go' }, /run is a function/],
  ]) assert.throws(() => host.api.status(spec), re, JSON.stringify(spec));
  // its handle changes it in place
  const h = host.api.status({ id: 'live', place: 'sidebarFooter', text: 'one' });
  await h.update({ text: 'two' });
  assert.deepEqual(sent.at(-1).data.items[0].text, 'two');
  // the Host: one status, a ref for its subject (and only a status names one); every rule carries what its mod may read
  const reg = createRuleRegistry({ presentations: new Map([['Window', new Set(['status', 'titleBar'])]]), rankOf: () => 1 });
  const w = (grants) => ({ id: 'unit.s', grants, gen: 'g', realm: 'host' });
  const ok = reg.register(w(['graph.present', 'graph.read:Usage']), { id: 's', kind: 'add', presentation: 'Window', slot: 'status', data: { items: [{ id: 's', text: 'a' }], subject: usage } });
  assert.ok(ok);
  assert.deepEqual(reg.snapshot().find((r) => r.id === 's').reads, ['Usage'], 'a status reads its subject only as its mod may');
  assert.throws(() => reg.register(w(['graph.present']), { id: 't', kind: 'add', presentation: 'Window', slot: 'status', data: { items: [{ text: 'a' }, { text: 'b' }] } }), /one status/);
  assert.throws(() => reg.register(w(['graph.present']), { id: 't', kind: 'add', presentation: 'Window', slot: 'status', data: { items: [{ text: 'a', tone: 'red' }] } }), /tone/);
  assert.throws(() => reg.register(w(['graph.present']), { id: 't', kind: 'add', presentation: 'Window', slot: 'status', data: { items: [{ text: 'a', when: { x: { $nope: 1 } } }] } }), /when is a where/);
  assert.throws(() => reg.register(w(['graph.present']), { id: 't', kind: 'decorate', presentation: 'Window', slot: 'status', data: {} }), /an add rule/);
  assert.throws(() => reg.register(w(['graph.present']), { id: 't', kind: 'add', presentation: 'Window', slot: 'titleBar', data: { items: [], subject: usage } }), /subject is a status's/);
  assert.equal(reg.snapshot().find((r) => r.id === 's').reads.length, 1);
});

test('a content renderer\'s part (its claim) reaches the Host as data: the client never sends it as one of the app\'s parts', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {} };
  const page = createRuleApi({ modId: 'unit.c', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  await page.api.content.code({ id: 'chart', language: 'Chart', render: () => null }).accepted;
  const reg = createRuleRegistry({ presentations: new Map([['ContentView', new Set(['partRenderers'])]]), rankOf: () => 1 });
  assert.ok(reg.register({ id: 'unit.c', grants: ['graph.present'], gen: 'g', realm: 'renderer', window: 1 }, sent[0]));
  assert.deepEqual(reg.snapshot().find((r) => r.id === 'chart').data.part, { kind: 'code', language: ['Chart'] });
});

test('public hooks §3.14: ui.settings.section in either realm is an add rule on SettingsPage section for its page; the Host checks it', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.s', realm: 'host', channel });
  const branch = { type: 'Setting', provider: 'codex', id: 'git-branch-prefix' };
  await host.api.settings.section({ id: 'git', page: 'git-settings', title: ' QA ', settings: [branch] }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].of, sent[0].data],
    ['add', 'SettingsPage', 'section', { type: 'SettingsSection', provider: 'codex', id: 'git-settings' }, { items: [{ id: 'git', title: 'QA', settings: [branch] }] }]);
  assert.equal(host.api.settings.page, undefined, 'a page of its own is the renderer realm\'s');
  for (const [spec, re] of [
    [{ id: 'x', page: 'Git Settings', settings: [branch] }, /slug/],
    [{ id: 'x', page: 'git-settings' }, /give render or settings/],
    [{ id: 'x', page: 'git-settings', render: () => null }, /renderer realm/],
    [{ id: 'x', page: 'git-settings', settings: [{ id: 'x' }] }, /refs/],
    [{ id: 'x', page: 'git-settings', settings: [branch], title: '' }, /title/],
  ]) assert.throws(() => host.api.settings.section(spec), re, JSON.stringify(spec));
  const page = createRuleApi({ modId: 'unit.s', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  sent.length = 0;
  await page.api.settings.section({ id: 'own', page: 'appearance', title: 'Mine', render: () => null }).accepted;
  assert.deepEqual([sent[0].slot, sent[0].of.id, sent[0].data], ['section', 'appearance', undefined], 'its component stays in its window');
  const reg = createRuleRegistry({ presentations: new Map([['SettingsPage', new Set(['section'])]]), rankOf: () => 1 });
  const w = { id: 'unit.s', grants: ['graph.present'], gen: 'g', realm: 'host' };
  assert.ok(reg.register(w, { id: 'a', kind: 'add', presentation: 'SettingsPage', slot: 'section', of: { type: 'SettingsSection', provider: 'codex', id: 'git-settings' }, data: { items: [{ settings: [branch] }] } }));
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'SettingsPage', slot: 'section', data: { items: [{ settings: [branch] }] } }), /names its page/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'SettingsPage', slot: 'section', of: { type: 'SettingsSection', provider: 'codex', id: 'g' }, data: { items: [{ settings: 'all' }] } }), /settings are refs/);
});

test('public hooks §3.14: ui.sidebar.order is an add rule on Sidebar order; a comparator stays in its window; the Host checks the list and path', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.o', realm: 'host', channel });
  await host.api.sidebar.order({ id: 'busy', in: 'chats', by: '-@unit.o/score' }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].data], ['add', 'Sidebar', 'order', { sort: { in: 'chats', by: '-@unit.o/score' } }]);
  for (const [spec, re] of [
    [{ id: 'x' }, /give by/],
    [{ id: 'x', by: (a, b) => a - b }, /renderer realm/],
    [{ id: 'x', in: 'archive', by: 'title' }, /in is one of/],
    [{ id: 'x', by: 'title; drop' }, /by is a path/],
  ]) assert.throws(() => host.api.sidebar.order(spec), re, JSON.stringify(spec));
  const page = createRuleApi({ modId: 'unit.o', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  sent.length = 0;
  await page.api.sidebar.order({ id: 'mine', in: { type: 'Project', provider: 'codex', id: 'p1' }, by: () => 0 }).accepted;
  assert.deepEqual(sent[0].data, { sort: { in: { type: 'Project', provider: 'codex', id: 'p1' } } }, 'its comparator stays in its window');
  const reg = createRuleRegistry({ presentations: new Map([['Sidebar', new Set(['order'])]]), rankOf: () => 1 });
  const w = { id: 'unit.o', grants: ['graph.present'], gen: 'g', realm: 'host' };
  assert.ok(reg.register(w, { id: 'a', kind: 'add', presentation: 'Sidebar', slot: 'order', data: { sort: { by: 'title' } } }));
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'Sidebar', slot: 'order', data: {} }), /an order is/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'Sidebar', slot: 'order', data: { sort: { in: 'nowhere' } } }), /in is one of/);
});

test('public hooks §3.14: ui.sidebar.section is an add rule on Sidebar section with what it lists and its actions; the Host checks it', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.s', realm: 'host', channel });
  await host.api.sidebar.section({ id: 'busy', title: ' Busy ', where: { status: 'working' }, sort: '-title', actions: [{ title: 'Refresh', run() {} }] }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].data],
    ['add', 'Sidebar', 'section', { section: { title: 'Busy', where: { status: 'working' }, sort: '-title' }, items: [{ id: '0', title: 'Refresh', run: { $fn: 'items.0.run' } }] }]);
  for (const [spec, re] of [
    [{ id: 'x', where: {} }, /title/],
    [{ id: 'x', title: 'T' }, /where selects or the ones its of names/],
    [{ id: 'x', title: 'T', of: [{ id: 'a' }] }, /of names chats/],
    [{ id: 'x', title: 'T', where: {}, limit: 0 }, /limit/],
    [{ id: 'x', title: 'T', where: {}, position: 'middle' }, /position/],
    [{ id: 'x', title: 'T', where: {}, actions: [{ title: 'A' }] }, /actions/],
  ]) assert.throws(() => host.api.sidebar.section(spec), re, JSON.stringify(spec));
  const reg = createRuleRegistry({ presentations: new Map([['Sidebar', new Set(['section'])]]), rankOf: () => 1 });
  const w = { id: 'unit.s', grants: ['graph.present'], gen: 'g', realm: 'host' };
  assert.ok(reg.register(w, { id: 'a', kind: 'add', presentation: 'Sidebar', slot: 'section', data: { section: { title: 'A', of: [{ type: 'Thread', provider: 'codex', id: 't' }] } } }));
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'Sidebar', slot: 'section', data: { section: { title: 'B', where: { x: { $nope: 1 } } } } }), /one grammar/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'Sidebar', slot: 'section', data: {} }), /add rule with its section/);
});

test('public hooks §3.11: ui.choices is an add rule on Choices\' subject; what it hides, orders, relabels and adds; the Host checks it', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.c', realm: 'host', channel });
  const h = host.api.choices('Model', { id: 'models', in: ['composer'], hide: ['gpt-old'], order: ['gpt-6-luna'], label: { 'gpt-6-luna': { title: 'Luna', description: 'fast' } }, add: [{ id: 'mine', title: 'Mine', run() {} }] });
  await h.accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].data], ['add', 'Choices', 'Model',
    { choices: { in: ['composer'], hide: ['gpt-old'], order: ['gpt-6-luna'], label: { 'gpt-6-luna': { title: 'Luna', description: 'fast' } } }, items: [{ id: 'mine', title: 'Mine', run: { $fn: 'items.0.run' } }] }]);
  assert.ok(h.unsupported.includes('in settings'), 'what the framework does not do yet is said');
  await host.api.choices({ setting: 'effort' }, { id: 'eff', hide: { id: 'xhigh' } }).accepted;
  assert.equal(sent.at(-1).slot, 'effort');
  for (const [of, spec, re] of [
    ['Agent', { id: 'x' }, /of is/],
    ['Model', { id: 'x', in: ['sidebar'] }, /in names places/],
    ['Model', { id: 'x', hide: 'gpt' }, /hide is ids/],
    ['Model', { id: 'x', where: { a: 1 } }, /narrowing/],
    ['Model', { id: 'x', hide: () => true }, /renderer realm/],
    ['Model', { id: 'x', label: { a: 3 } }, /label maps/],
    ['Model', { id: 'x', add: [{ id: 'bad id', title: 'T', run() {} }] }, /add is at most 10/],
  ]) assert.throws(() => host.api.choices(of, spec), re, JSON.stringify(spec));
  const page = createRuleApi({ modId: 'unit.c', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  sent.length = 0;
  await page.api.choices('SlashCommand', { id: 'sl', hide: (x) => x.state.title === 'Fork', order: ['status'] }).accepted;
  assert.deepEqual(sent[0].data, { choices: { order: ['status'] } }, 'its test stays in its window');
  const reg = createRuleRegistry({ presentations: new Map([['Choices', new Set(['Model'])]]), rankOf: () => 1 });
  const w = { id: 'unit.c', grants: ['graph.present'], gen: 'g', realm: 'host' };
  assert.ok(reg.register(w, { id: 'a', kind: 'add', presentation: 'Choices', slot: 'Model', data: { choices: { hide: ['x'] } } }));
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'Choices', slot: 'Model', data: { choices: { hide: { x: { $nope: 1 } } } } }), /one grammar/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'decorate', presentation: 'Choices', slot: 'Model', data: { choices: {} } }), /add rule/);
});

test('H7y: ui.theme.add in either realm is an add rule on SettingsPage theme for the Appearance page, holding one theme; the Host checks it', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'unit.t', realm: 'host', channel });
  const dark = { surface: '#101418', ink: '#e6e6e6', accent: '#ff8800', code: 'tokyo-night' };
  await host.api.theme.add({ id: 'dusk', title: ' Dusk ', description: 'Warm', dark }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].of, sent[0].data],
    ['add', 'SettingsPage', 'theme', { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, { items: [{ id: 'dusk', title: 'Dusk', description: 'Warm', dark }] }]);
  for (const [spec, re] of [
    [{ title: 'X', dark }, /takes \{id/],
    [{ id: 'x', title: 'X' }, /light variant, a dark one, or both/],
    [{ id: 'x', title: '', dark }, /title/],
    [{ id: 'x', title: 'X', light: { ...dark, surface: 'white' } }, /light\.surface/],
    [{ id: 'x', title: 'X', dark: { ...dark, code: 'Tokyo Night' } }, /code themes/],
  ]) assert.throws(() => host.api.theme.add(spec), re, JSON.stringify(spec));
  const page = createRuleApi({ modId: 'unit.t', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  sent.length = 0;
  await page.api.theme.add({ id: 'paper', title: 'Paper', light: { surface: '#fffdf5', ink: '#222222', accent: '#0066cc' } }).accepted;
  assert.equal(sent[0].slot, 'theme');
  const reg = createRuleRegistry({ presentations: new Map([['SettingsPage', new Set(['theme'])]]), rankOf: () => 1 });
  const w = { id: 'unit.t', grants: ['graph.present'], gen: 'g', realm: 'host' };
  const of = { type: 'SettingsSection', provider: 'codex', id: 'appearance' };
  assert.ok(reg.register(w, { id: 'a', kind: 'add', presentation: 'SettingsPage', slot: 'theme', of, data: { items: [{ id: 'a', title: 'A', dark }] } }));
  assert.throws(() => reg.register({ ...w, realm: 'renderer', window: 1 }, { id: 'b', kind: 'replace', presentation: 'SettingsPage', slot: 'theme', of, data: { items: [{ id: 'b', title: 'B', dark }] } }), /an add rule/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'SettingsPage', slot: 'theme', of: { ...of, id: 'git-settings' }, data: { items: [{ id: 'b', title: 'B', dark }] } }), /Appearance page/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'SettingsPage', slot: 'theme', of, data: { items: [{ id: 'b', title: 'B', dark }, { id: 'c', title: 'C', dark }] } }), /one theme/);
  assert.throws(() => reg.register(w, { id: 'b', kind: 'add', presentation: 'SettingsPage', slot: 'theme', of, data: { items: [{ id: 'b', title: 'B', dark: { ...dark, glow: 1 } }] } }), /ui\.theme\.add/);
});

test('public hooks §3.14: a view in its own window: the Host opens a new window the app\'s way, then asks it for the view filling it, until its page has the declaration', async () => {
  const reg = createRuleRegistry({ presentations: new Map([['SidePanel', new Set(['tabs'])]]), rankOf: () => 1 });
  const acts = [], opened = [];
  let tries = 0;
  const CHAT = { type: 'CodexThread', provider: 'codex', id: 't-3' };
  const ns = createUiNs({ rules: () => reg, windows: () => ({
    frontWindow: async () => 3,
    threadOf: (id) => (id === 3 ? CHAT : null),
    openWindow: async (target, call, opts) => {
      opened.push(target);
      if (!opts?.exact || opts.beforeCreate?.() !== true) return { status: 'refused', reason: 'unavailable', message: 'not exact, or no longer wanted' };
      return { status: 'done', value: { type: 'Window', provider: 'codexmods.windows', id: '9' } };
    },
    declarationAct: async (...a) => { acts.push(a); return ++tries < 3 ? { status: 'refused', reason: 'unavailable', message: 'that declaration is not in this window' } : { status: 'done', value: null }; },
  }) });
  const scope = { state: { id: 'unit.p', grants: ['graph.present'] }, realm: 'renderer', channel: { identity: { windowId: 3 } } };
  ns.calls.register(scope, { id: 'notes', kind: 'host', presentation: 'SidePanel', slot: 'tabs', data: { view: { title: 'Notes' } } });
  const out = await ns.calls.inWindow(scope, 'notes', 'panel.open', { placement: 'window' }, null);
  assert.deepEqual([out.status, out.value], ['done', { type: 'Window', provider: 'codexmods.windows', id: '9' }]);
  assert.deepEqual(opened, [CHAT], 'one new window, on the chat the window in front shows (its context; never a home window the user opens)');
  assert.deepEqual(acts.map((a) => [a[0], a[1], a[2], a[3]]), [9, 9, 9].map((w) => [w, 'unit.p/notes', 'panel.open', { placement: 'full' }]), 'asked again until its page has it');
  // a split: the window in front, as asked
  acts.length = 0;
  tries = 10;
  await ns.calls.inWindow(scope, 'notes', 'panel.open', { placement: 'side' }, null);
  assert.deepEqual(acts.map((a) => [a[0], a[2], a[3]]), [[3, 'panel.open', { placement: 'side' }]]);
  // a view of the bottom panel only: neither, and no window is opened for it
  ns.calls.register(scope, { id: 'log', kind: 'host', presentation: 'SidePanel', slot: 'tabs', data: { view: { title: 'Log', targets: ['bottom'] } } });
  for (const placement of ['side', 'window']) {
    const no = await ns.calls.inWindow(scope, 'log', 'panel.open', { placement }, null);
    assert.deepEqual([no.status, /bottom panel's only/.test(no.message)], ['refused', true]);
  }
  assert.deepEqual(opened, [CHAT], 'no window opened');
  // a refusal that will not change (not a panel view in that window): not asked again; the mod stopped meanwhile: not asked again either
  acts.length = 0;
  tries = 0;
  const once = createUiNs({ rules: () => reg, windows: () => ({ frontWindow: async () => 3, openWindow: async () => ({ status: 'done', value: { type: 'Window', provider: 'codexmods.windows', id: '9' } }),
    declarationAct: async (...a) => { acts.push(a); return { status: 'refused', reason: 'invalid', message: 'that declaration is not a panel view' }; } }) });
  assert.equal((await once.calls.inWindow(scope, 'notes', 'panel.open', { placement: 'window' }, null)).reason, 'invalid');
  assert.equal(acts.length, 1);
  let stop = null;
  const stopping = createUiNs({ rules: () => reg, windows: () => ({ frontWindow: async () => 3, openWindow: async () => ({ status: 'done', value: { type: 'Window', provider: 'codexmods.windows', id: '9' } }),
    declarationAct: async () => { stop?.(); return { status: 'refused', reason: 'unavailable', message: 'not yet' }; } }) });
  stop = () => reg.disposeMod('unit.p');
  const after = await stopping.calls.inWindow(scope, 'notes', 'panel.open', { placement: 'window' }, null);
  assert.deepEqual([after.status, /its mod stopped/.test(after.message)], ['refused', true], 'the mod stopped after the first ask: not asked again');
});

test('layouts WL2-4a review: the parts a rule may name are those whose addresses this build delivers (its seams and exposures): ordering kinds apart from hiding them', async () => {
  const { partsSupported, readPartsSupported } = await import('../ui-rules.mjs');
  const addresses = { rules: [
    { id: 'k', presentation: 'SidePanel', needs: { seams: ['tabVisible'], exposures: ['tabRegistry'] }, parts: { kinds: ['terminal'] }, partKinds: ['hide'] },
    { id: 'o', presentation: 'SidePanel', needs: { seams: ['launcher'], exposures: ['launcherOrder'] }, parts: { kinds: ['terminal'] }, partKinds: ['reorder'] }] };
  const kinds = (hooks) => [...(partsSupported(addresses, hooks).get('SidePanel')?.get('kinds')?.get('terminal') ?? [])].sort();
  assert.deepEqual(kinds(null), ['hide', 'reorder'], 'no pack known: every address');
  assert.deepEqual(kinds({ tabVisible: {}, launcher: {}, exposures: { tabRegistry: 'x', launcherOrder: 'y' } }), ['hide', 'reorder']);
  assert.deepEqual(kinds({ tabVisible: {}, exposures: { tabRegistry: 'x', launcherOrder: 'y' } }), ['hide'], 'no launcher seam: ordering unsupported');
  assert.deepEqual(kinds({ launcher: {}, exposures: { launcherOrder: 'y' } }), ['reorder'], 'no tab-visible seam (20770): hiding unsupported');
  // the framework's own addresses: the side panel's kinds split so
  const file = new URL('../../renderer/present/addresses.json', import.meta.url).pathname;
  const real = readPartsSupported(decodeURIComponent(file), { jsx: {}, launcher: {}, exposures: { launcherOrder: 'y', react: 'r' } }).get('SidePanel')?.get('kinds')?.get('files');
  assert.deepEqual([...(real ?? [])], ['reorder']);
});

test('layouts WL5a: a page is a renderer-realm host rule on MainRegion\'s pages, its id part of its path', async () => {
  const reg = createRuleRegistry({ presentations: new Map([['MainRegion', new Set(['pages'])]]), rankOf: () => 1, typeExists: () => true });
  const who = (realm) => ({ id: 'unit.a', grants: ['graph.present'], realm, gen: 1 });
  const ok = { id: 'notes', kind: 'host', presentation: 'MainRegion', slot: 'pages', data: { page: { title: 'Notes' } } };
  assert.ok(reg.register(who('renderer'), ok));
  assert.throws(() => reg.register(who('host'), { ...ok, id: 'h' }), /register it from the renderer realm/);
  assert.throws(() => reg.register(who('renderer'), { ...ok, id: 'nt', data: { page: {} } }), /has a title/);
  assert.throws(() => reg.register(who('renderer'), { ...ok, id: 'add', kind: 'add' }), /host rule/);
});

test('graph-integrity G2.2: a mod replaces ThreadView whole only for a Thread subtype it registered (its own chats\' view); never Codex\'s, another mod\'s, or a type that is not a chat', () => {
  const owners = { TestAgentThread: ['mod:qa.test-agent', true], OtherThread: ['mod:other.agent', true], TestAgentNote: ['mod:qa.test-agent', false], CodexThread: ['native', true] };
  const reg = createRuleRegistry({ presentations: new Map([['ThreadView', new Set(['header', 'transcript'])]]), rankOf: () => 1, typeExists: (t) => t in owners,
    ownThread: (modId, t) => owners[t]?.[0] === `mod:${modId}` && owners[t][1] === true });
  const who = { id: 'qa.test-agent', grants: ['graph.present:ThreadView'], realm: 'renderer', gen: 1 };
  assert.ok(reg.register(who, { id: 'view', kind: 'replace', presentation: 'ThreadView', for: 'TestAgentThread' }), 'its own chats\' view');
  for (const forType of ['CodexThread', 'OtherThread', 'TestAgentNote', undefined]) {
    assert.throws(() => reg.register(who, { id: `v-${forType}`, kind: 'replace', presentation: 'ThreadView', ...(forType ? { for: forType } : {}) }), (e) => e.code === 'Denied' && /holds protected parts/.test(e.message), String(forType));
  }
});
