// A window's presentations as its page reports them (docs/design/systems.md S10, "E2c in detail"): the kernel's committed mounts become
// presentations with their subject, place, hidden and decorations; a generation first, then a snapshot, then batched deltas within their
// limits; user actions as ordered events of their own. Fake kernel store, channel and timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstances, BATCH_MS, MAX_PUTS, MAX_INSPECT } from '../present/instances.mjs';
import { startPresentation, defineBinding } from '../present/runtime.mjs';
import { dataList } from '../present/bindings/slots.mjs';
import { createFakeReact } from './fake-react.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const thread = (id) => ({ type: 'CodexThread', provider: 'codex', id });

function setup({ mounted = [], gen = 5, refuse = false, shell = null } = {}) {
  const sent = [];
  const channel = {
    window: async () => { if (refuse) throw new Error('Unavailable'); sent.push(['window']); return gen; },
    report: async (g, batch) => { sent.push(['report', g, batch]); },
    acted: async (g, events) => { sent.push(['acted', g, events]); },
  };
  let clock = 1000;
  const timers = [];
  const row = { id: 'row', presentation: 'SidebarItem', subject: (props) => (props.id ? thread(props.id) : null), place: { in: 'SidebarSection', via: 'project', slot: 'items' }, selected: (p) => p.active };
  const plain = { id: 'plain', presents: ['Thread'] };   // no presentation type: not reported
  const store = { mounted: () => mounted };
  const facts = { hidden: false, decorations: [] };
  const inst = createInstances({
    store, bindings: new Map([['row', row], ['plain', plain]]), ctx: {}, facts: () => facts, channel, windowFacts: () => shell?.(),
    schedule: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; }, cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }, now: () => clock,
  });
  /** Let the clock pass and run the timers that are due. */
  const advance = async (ms) => { clock += ms; for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); } await tick(); };
  return { inst, sent, facts, advance, timers, reports: () => sent.filter((x) => x[0] === 'report').map((x) => x[2]) };
}
const rec = (n, props, binding = 'row') => ({ n, binding, props });

test('a generation first, then every record mounted before (the snapshot), then only what changed', async () => {
  const a = rec(1, { id: 'a', active: true }), b = rec(2, { id: 'b' }), p = rec(3, {}, 'plain');
  const s = setup({ mounted: [a, b, p] });
  s.inst.touch();
  await tick(); await tick();
  assert.deepEqual(s.sent[0], ['window']);
  const [first] = s.reports();
  assert.deepEqual(first.puts.map((x) => x.n), [1, 2]);
  assert.deepEqual(first.puts[0], { n: 1, type: 'SidebarItem', subject: thread('a'), place: { in: 'SidebarSection', via: 'project' }, slot: 'items', hidden: false, decorations: [], selected: true });
  assert.equal('selected' in first.puts[1], false, 'where the binding cannot tell, nothing');
  // A commit that changes nothing reported sends nothing; one that does, sends that one.
  s.inst.onMount('update', a);
  await s.advance(BATCH_MS);
  assert.equal(s.reports().length, 1);
  a.props = { id: 'a', active: false };
  s.inst.onMount('update', a);
  await s.advance(BATCH_MS);
  assert.deepEqual(s.reports()[1].puts.map((x) => [x.n, x.selected]), [[1, false]]);
  // An unmount removes it; a subject that is no longer known removes it too; a new mount is put.
  s.inst.onMount('unmount', b);
  b.props = {};
  const c = rec(4, { id: 'c' });
  s.inst.onMount('mount', c);
  await s.advance(BATCH_MS);
  assert.deepEqual([s.reports()[2].removes, s.reports()[2].puts.map((x) => x.n)], [[2], [3]], 'numbered when first reported');
  c.props = {};
  s.inst.onMount('update', c);
  await s.advance(BATCH_MS);
  assert.deepEqual(s.reports()[3].removes, [3]);
  assert.equal(s.inst.stats().gen, 5);
});

test('batches: at most one report per BATCH_MS, at most MAX_PUTS presentations in one; the rest follow', async () => {
  const many = Array.from({ length: 450 }, (_, i) => rec(i + 1, { id: `t${i}` }));
  const s = setup({ mounted: many });
  s.inst.touch();
  await tick(); await tick();
  assert.equal(s.reports()[0].puts.length, MAX_PUTS);
  await s.advance(BATCH_MS - 1);
  assert.equal(s.reports().length, 1, 'not before the interval');
  await s.advance(1);
  await s.advance(BATCH_MS);
  assert.deepEqual(s.reports().map((r) => r.puts.length), [200, 200, 50]);
});

test('a user action is its own event, sent at once after the deltas it needs, in order; nothing goes once the Host refuses', async () => {
  const a = rec(1, { id: 'a' });
  const s = setup({ mounted: [] });
  s.inst.touch();
  await tick(); await tick();
  s.inst.onMount('mount', a);
  s.inst.acted(a, 'action', 'unit.a/badge/x');
  s.inst.acted(a, 'action', 'unit.a/badge/y');
  await tick();
  assert.deepEqual(s.sent.map((x) => x[0]), ['window', 'report', 'acted', 'acted']);
  assert.equal(s.sent[1][2].puts[0].n, 1, 'the presentation first');
  assert.deepEqual(s.sent.filter((x) => x[0] === 'acted').flatMap((x) => x[2].map((e) => e.action)), ['unit.a/badge/x', 'unit.a/badge/y']);
  s.inst.acted(rec(9, { id: 'z' }), 'action', 'not mine');
  assert.equal(s.sent.filter((x) => x[0] === 'acted').length, 2, 'a record it does not know');
  const off = setup({ mounted: [a], refuse: true });
  off.inst.touch();
  await tick(); await tick();
  assert.equal(off.sent.length, 0);
  assert.equal(off.inst.stats().state, 'off');
});

test('in the runtime: a rule changes what a presentation says (hidden, its decorations); a badge the user clicks is that presentation\'s action', async () => {
  const { React } = createFakeReact();
  const sent = [];
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const REF = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [{ ref: REF, liveness: 'live', state: { title: 'T' }, links: {} }] })); return { dispose() {} }; },
  };
  const row = defineBinding({
    id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF, place: { in: null, slot: 'items' },
    slots: { badges: dataList('extraIconBadges', ({ rule, item }) => ({ id: `${rule.mod}/${item.id}`, onClick: item.run }), { field: 'badges' }) },
  });
  const instances = { window: async () => 1, report: async (g, b) => { sent.push(['report', b]); }, acted: async (g, e) => { sent.push(['acted', e]); } };
  const p = startPresentation({ kernel: k, graph, bindings: [row], instances });
  const r1 = { n: 1, binding: 'row', props: { extraIconBadges: [] } };
  mounts.push(r1);
  await tick(); await tick(); await tick();
  assert.equal(typeof onMount, 'function');
  assert.deepEqual(sent[0][1].puts[0].decorations, []);
  let ran = 0;
  p.rules.put({ mod: 'unit.a', id: 'n', kind: 'decorate', presentation: 'SidebarItem', realm: 'renderer', order: 1, fns: { badges: () => [{ id: 'x', run: () => { ran++; } }] } });
  await new Promise((r) => setTimeout(r, 300));
  const last = sent.filter((x) => x[0] === 'report').at(-1)[1].puts[0];
  assert.deepEqual(last.decorations, [{ by: 'unit.a', kind: 'badge', rule: 'n' }]);
  // The wrapper renders with the mount's record: the badge's callback reports the action, then runs.
  const out = store.renderers.get('row')('Row', r1.props, (type, pr) => ({ type, props: pr }), r1);
  out.props.extraIconBadges[0].onClick();
  await tick();
  assert.equal(ran, 1);
  assert.deepEqual(sent.find((x) => x[0] === 'acted')[1], [{ n: 1, operation: 'action', action: 'unit.a/n/x' }]);
  p.rules.put({ mod: 'unit.b', id: 'h', kind: 'hide', presentation: 'SidebarItem', realm: 'renderer', order: 0 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.filter((x) => x[0] === 'report').at(-1)[1].puts[0].hidden, true);
  assert.equal(p.instances().records, 1);
  p.dispose();
  assert.equal(onMount, null);
});

test('the window\'s own facts go with a report when they change, and only then', async () => {
  let open = true;
  const s = setup({ mounted: [rec(1, { id: 'a' })], shell: () => ({ sidebar: { open } }) });
  s.inst.touch();
  await tick(); await tick();
  assert.deepEqual(s.reports()[0].window, { sidebar: { open: true } });
  s.inst.windowChanged();
  await s.advance(BATCH_MS);
  assert.equal(s.reports().length, 1, 'unchanged: nothing sent');
  open = false;
  s.inst.windowChanged();
  await s.advance(BATCH_MS);
  const { page, ...rest } = s.reports()[1];
  assert.deepEqual(rest, { puts: [], removes: [], window: { sidebar: { open: false } } });
  assert.equal(page.records, 1, 'the page\'s counters go along');
});

test('an action goes with its presentation: one not reported yet is put first in the same flush, whatever the backlog', async () => {
  const many = Array.from({ length: 450 }, (_, i) => rec(i + 1, { id: `t${i}` }));
  const s = setup({ mounted: many });
  s.inst.touch();
  s.inst.acted(many[449], 'action', 'unit.a/b/x');   // before the generation: it waits
  await tick(); await tick();
  const [first] = s.reports();
  const acted = s.sent.find((x) => x[0] === 'acted')[2][0];
  assert.equal(first.puts[0].subject.id, 't449', 'the action\'s presentation first');
  assert.equal(acted.n, first.puts[0].n);
  assert.ok(s.sent.findIndex((x) => x[0] === 'report') < s.sent.findIndex((x) => x[0] === 'acted'));
  // An action on a record whose subject is not known is dropped, never sent without its presentation.
  const none = rec(999, {});
  s.inst.onMount('mount', none);
  s.inst.acted(none, 'action', 'unit.a/b/y');
  await tick();
  assert.equal(s.sent.filter((x) => x[0] === 'acted').length, 1);
  assert.equal(s.inst.stats().dropped, 1);
});

test('a mount whose subject changes is another presentation: the old number goes, a new one is put', async () => {
  const a = rec(1, { id: 'a' });
  const s = setup({ mounted: [a] });
  s.inst.touch();
  await tick(); await tick();
  a.props = { id: 'b' };
  s.inst.onMount('update', a);
  await s.advance(BATCH_MS);
  const r = s.reports()[1];
  assert.deepEqual([r.removes, r.puts.map((x) => [x.n, x.subject.id])], [[1], [[2, 'b']]]);
});

test('bounded work: at most MAX_INSPECT records looked at in one flush, even when nothing changed', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => rec(i + 1, { id: `t${i}` }));
  const s = setup({ mounted: many });
  s.inst.touch();
  await tick(); await tick();
  for (let i = 0; i < 4; i++) await s.advance(BATCH_MS);
  const before = s.inst.stats().inspected;
  s.inst.touch();   // a rule came: every record is looked at again, and nothing changed
  await s.advance(BATCH_MS);
  assert.equal(s.inst.stats().inspected - before, MAX_INSPECT);
  assert.equal(s.reports().length, 5, 'nothing to send');
});

test('a report that fails is sent again; one the Host refuses as stale starts a new generation with a snapshot', async () => {
  const a = rec(1, { id: 'a' });
  let fail = true, stale = false, gens = 0;
  const sent = [];
  const inst = createInstances({
    store: { mounted: () => [a] }, bindings: new Map([['row', { id: 'row', presentation: 'SidebarItem', subject: (p) => thread(p.id), place: { in: null } }]]), ctx: {},
    facts: () => ({ hidden: false, decorations: [] }),
    channel: {
      window: async () => ++gens,
      report: async (g, batch) => { sent.push([g, batch.puts.map((x) => x.n)]); if (fail) { fail = false; throw new Error('the channel hiccuped'); } return !(stale && g === 1); },
      acted: async () => {},
    },
    schedule: (fn) => setTimeout(fn, 1),
  });
  inst.touch();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [[1, [1]], [1, [1]]], 'sent again after the failure');
  stale = true;   // the Host has forgotten generation 1 (it refuses its reports)
  a.props = { id: 'b' };
  inst.touch();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gens, 2, 'a new generation');
  assert.equal(sent.at(-1)[0], 2);
  assert.equal(sent.at(-1)[1].length, 1, 'with the snapshot');
  assert.equal(inst.stats().resnapshots, 1);
  inst.dispose();
});

test('one presentation per identity: a second mount with the same type, subject, place and slot is a twin, reported when the first goes', async () => {
  const a = rec(1, { id: 'a' }), b = rec(2, { id: 'a' });
  const s = setup({ mounted: [a, b] });
  s.inst.touch();
  await tick(); await tick();
  assert.deepEqual(s.reports()[0].puts.map((x) => x.n), [1], 'the twin is not another presentation');
  s.inst.acted(b, 'action', 'unit.a/x/0');
  await tick();
  assert.equal(s.sent.find((x) => x[0] === 'acted')[2][0].n, 1, 'an action on the twin is on the presentation');
  s.inst.onMount('unmount', a);
  await s.advance(BATCH_MS);
  const r = s.reports().at(-1);
  assert.deepEqual([r.removes, r.puts.map((x) => [x.n, x.subject.id])], [[1], [[2, 'a']]], 'the twin is the presentation now');
  s.inst.onMount('unmount', b);
  await s.advance(BATCH_MS);
  assert.equal(s.inst.stats().twins, 0, 'no empty twin sets kept (E6 review)');
});

test('E6.5: the framework\'s own presentations go through the same registry, with the parent named outright; no rule applies to them', async () => {
  const sent = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => [], onMount: null };
  const k = { kernel: { abi: 1, bindings: [] }, store, exports: {} };
  const graph = { types: async () => [], subscribe: () => ({ dispose() {} }) };
  const instances = { window: async () => 1, report: async (g, b) => { sent.push(b); }, acted: async () => {} };
  const p = startPresentation({ kernel: k, graph, bindings: [], instances });
  const FW = { type: 'CodexMods', provider: 'codexmods.framework', id: 'codexmods' };
  const MOD = { type: 'Mod', provider: 'codexmods.framework', id: 'acme.demo' };
  const SETTING = { type: 'Setting', provider: 'codexmods.framework', id: 'acme.demo/mode' };
  // a mod's rule for every SettingsPage would hide the app's own; never the framework's
  p.rules.put({ mod: 'unit.b', id: 'h', kind: 'hide', presentation: 'SettingsPage', realm: 'renderer', order: 0 });
  const page = { binding: 'framework:SettingsPage', props: { subject: MOD, place: { in: 'Window', slot: 'main' } } };
  const row = { binding: 'framework:SettingsRow', props: { subject: SETTING, place: { in: 'SettingsPage', on: MOD, slot: 'settings' } } };
  p.reporter.put(page);
  p.reporter.put(row);
  await new Promise((r) => setTimeout(r, 300));
  const puts = sent.flatMap((b) => b.puts);
  assert.deepEqual(puts.map((x) => [x.type, x.subject.id, x.place, x.slot, x.hidden]), [
    ['SettingsPage', 'acme.demo', { in: 'Window' }, 'main', false],
    ['SettingsRow', 'acme.demo/mode', { in: 'SettingsPage', on: MOD }, 'settings', false],
  ]);
  p.reporter.remove(row);
  p.reporter.remove(row);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(sent.at(-1).removes, [puts[1].n], 'gone once');
  assert.equal(FW.type, 'CodexMods');
  p.dispose();
});

test('E6.5b: a mod\'s rules that lost, for its page: a claim another\'s holds where both render, a style variable another\'s holds; kept while both are', async () => {
  const { React } = createFakeReact();
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const REF = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [{ ref: REF, liveness: 'live', state: { title: 'T' }, links: {} }] })); return { dispose() {} }; },
  };
  const row = defineBinding({ id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF, place: { in: null, slot: 'items' } });
  const instances = { window: async () => 1, report: async () => {}, acted: async () => {} };
  const tokens = { danger: '--color-text-danger', success: '--color-text-success' };
  const p = startPresentation({ kernel: k, graph, bindings: [row], instances, tokens, cssVar: () => 'x', styleSink: () => {} });
  mounts.push({ n: 1, binding: 'row', props: {} });
  p.rules.put({ mod: 'unit.a', id: 'hide', kind: 'hide', presentation: 'SidebarItem', realm: 'renderer', order: 1 });
  p.rules.put({ mod: 'unit.b', id: 'swap', kind: 'replace', presentation: 'SidebarItem', realm: 'renderer', order: 2, fns: { render: () => null } });
  await tick(); await tick(); await tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(p.lostRulesOf('unit.b'), [{ mod: 'unit.b', rule: 'swap', kind: 'replace', what: 'SidebarItem', to: 'unit.a' }]);
  assert.deepEqual(p.lostRulesOf('unit.a'), [], 'the first in order holds it');
  p.rules.put({ mod: 'unit.a', id: 's', kind: 'style', realm: 'renderer', order: 1, data: { variables: { '--color-border': 'danger' } } });
  p.rules.put({ mod: 'unit.b', id: 's', kind: 'style', realm: 'renderer', order: 2, data: { variables: { '--color-border': 'success' } } });
  assert.deepEqual(p.lostRulesOf('unit.b').map((x) => [x.kind, x.what, x.to]), [['replace', 'SidebarItem', 'unit.a'], ['style', '--color-border', 'unit.a']]);
  p.rules.remove('unit.a/hide');
  p.rules.remove('unit.a/s');
  assert.deepEqual(p.lostRulesOf('unit.b'), [], 'what held them went');
  p.rules.put({ mod: 'unit.a', id: 'hide', kind: 'hide', presentation: 'SidebarItem', realm: 'renderer', order: 1 });
  store.renderers.get('row')('Row', {}, (type, pr) => ({ type, props: pr }), mounts[0]);
  assert.deepEqual(p.lostRulesOf('unit.b').map((x) => x.rule), ['swap'], 'told again when it comes back');
  p.dispose();
});

test('E7: an act runs the binding\'s operation over the mount\'s committed props and is answered once; stale, late, unknown and framework acts are refused', async () => {
  const { React } = createFakeReact();
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['turn'] }, store, exports: { react: React } };
  const graph = { types: async () => [], subscribe(q, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [] })); return { dispose() {} }; } };
  const calls = [];
  const turn = defineBinding({
    id: 'turn', presentation: 'TurnView', presents: ['Turn'], subject: (props) => (props.turnId ? { type: 'Turn', provider: 'codex', id: props.turnId } : null),
    place: { in: 'ThreadView', via: 'thread', slot: 'transcript' },
    operations: {
      collapse(props, args) { if (typeof props.onSetCollapsed !== 'function') return false; props.onSetCollapsed(true, ...args); return true; },
      boom() { throw new Error('it threw'); },
    },
  });
  const answers = [];
  const instances = { window: async () => 7, report: async () => {}, acted: async () => {}, answer: async (g, id, outcome) => { answers.push([g, id, outcome]); } };
  const p = startPresentation({ kernel: k, graph, bindings: [turn], instances });
  const r1 = { n: 1, binding: 'turn', props: { turnId: 'u1', onSetCollapsed: (v) => calls.push(v) } };
  mounts.push(r1);
  onMount?.('mount', r1);
  await new Promise((r) => setTimeout(r, 300));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  // The page numbered it 1 in generation 7: the act runs the committed props' callback.
  p.act({ id: 11, gen: 7, n: 1, operation: 'collapse', args: [], expires: Date.now() + 5000 });
  await settle();
  assert.deepEqual(calls, [true]);
  assert.deepEqual(answers.at(-1), [7, 11, { ok: true }]);
  p.act({ id: 11, gen: 7, n: 1, operation: 'collapse', args: [], expires: Date.now() + 5000 });
  await settle();
  assert.deepEqual([calls.length, answers.length], [1, 1], 'an act is done and answered once');
  // Refused: another generation, a number it never gave, an operation the binding does not have, props that cannot do it, a late act.
  const outcome = async (m) => { p.act({ expires: Date.now() + 5000, args: [], ...m }); await settle(); return answers.at(-1)[2]; };
  assert.equal((await outcome({ id: 12, gen: 6, n: 1, operation: 'collapse' })).refused, 'stale');
  assert.equal((await outcome({ id: 13, gen: 7, n: 9, operation: 'collapse' })).refused, 'stale');
  assert.equal((await outcome({ id: 14, gen: 7, n: 1, operation: 'scrollTo' })).refused, 'unavailable');
  assert.equal((await outcome({ id: 15, gen: 7, n: 1, operation: 'boom' })).failed, 'it threw');
  assert.equal((await outcome({ id: 16, gen: 7, n: 1, operation: 'collapse', expires: Date.now() - 1 })).refused, 'stale', 'too late');
  r1.props = { turnId: 'u1' };
  assert.equal((await outcome({ id: 17, gen: 7, n: 1, operation: 'collapse' })).refused, 'unavailable', 'these props give no way to do it');
  // The mount now presents another turn (its report has not caught up): the number no longer names it.
  r1.props = { turnId: 'u2', onSetCollapsed: (v) => calls.push(v) };
  assert.equal((await outcome({ id: 18, gen: 7, n: 1, operation: 'collapse' })).refused, 'stale');
  assert.equal(calls.length, 1);
  // A framework presentation takes no act.
  p.reporter.put({ binding: 'framework:Dialog', props: { subject: { type: 'Mod', provider: 'codexmods.framework', id: 'm' }, place: { in: 'Window', slot: 'consent' } } });
  await new Promise((r) => setTimeout(r, 300));
  // (the page numbered it 2: the second presentation it reported)
  assert.equal((await outcome({ id: 19, gen: 7, n: 2, operation: 'confirm' })).refused, 'unavailable');
  p.dispose();
});

test('E7.3: a user action on a twin\'s entry is its own presentation\'s, found when the user acts (it may be reported after the component first rendered)', async () => {
  const { React } = createFakeReact();
  const sent = [];
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['row', 'item'] }, store, exports: { react: React } };
  const REF = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [{ ref: REF, liveness: 'live', state: { title: 'T' }, links: {} }] })); return { dispose() {} }; },
  };
  // `row` only realizes the SidebarItem's hover actions (a twin); `item` presents the SidebarItem.
  const row = defineBinding({ id: 'row', presents: ['Thread'], twins: [{ presentation: 'SidebarItem', subject: () => REF, slots: { trailingActions: dataList('actions', ({ rule, item }) => ({ id: `${rule.mod}/${item.id}`, onClick: item.run }), { field: 'actions' }) } }] });
  const item = defineBinding({ id: 'item', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF, place: { in: null, slot: 'items' } });
  const instances = { window: async () => 1, report: async (g, b) => { sent.push(['report', b]); }, acted: async (g, e) => { sent.push(['acted', e]); } };
  const p = startPresentation({ kernel: k, graph, bindings: [row, item], instances });
  let ran = 0;
  p.rules.put({ mod: 'unit.a', id: 'h', kind: 'decorate', presentation: 'SidebarItem', realm: 'renderer', order: 1, fns: { actions: () => [{ id: 'x', title: 'X', run: () => { ran++; } }] } });
  await tick(); await tick(); await tick();
  // The row renders first, before the item's presentation is reported.
  const out = store.renderers.get('row')('Row', { actions: [] }, (type, pr) => ({ type, props: pr }), { n: 9, binding: 'row', props: {} });
  const r1 = { n: 1, binding: 'item', props: {} };
  mounts.push(r1);
  onMount('mount', r1);
  await new Promise((r) => setTimeout(r, 300));
  out.props.actions[0].onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, 1);
  const acted = sent.filter((x) => x[0] === 'acted').flatMap((x) => x[1]);
  assert.deepEqual(acted.map((e) => [e.n, e.operation, e.action]), [[1, 'action', 'unit.a/h/x']], 'on the SidebarItem, found when the user acted');
  p.dispose();
});

test('E7.4: an act its presentation\'s own mount cannot do goes to a twin\'s that can (another component that presents it)', async () => {
  const { React } = createFakeReact();
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['tree', 'pane'] }, store, exports: { react: React } };
  const graph = { types: async () => [], subscribe(q, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [] })); return { dispose() {} }; } };
  const FOLDER = { type: 'Folder', provider: 'codex', id: '/r' };
  const typed = [];
  const tree = defineBinding({ id: 'tree', presentation: 'FilesView', presents: ['Folder'], subject: () => FOLDER, place: { in: null, slot: 'panel' } });
  const pane = defineBinding({ id: 'pane', presentation: 'FilesView', presents: ['Folder'], subject: () => FOLDER, place: { in: null, slot: 'panel' }, operations: { filter: (props, [q]) => { typed.push(q); return true; } } });
  const answers = [];
  const instances = { window: async () => 3, report: async () => {}, acted: async () => {}, answer: async (g, id, outcome) => { answers.push(outcome); } };
  const p = startPresentation({ kernel: k, graph, bindings: [tree, pane], instances });
  const a = { n: 1, binding: 'tree', props: {} }, b = { n: 2, binding: 'pane', props: {} };
  mounts.push(a, b);
  onMount?.('mount', a); onMount?.('mount', b);
  await new Promise((r) => setTimeout(r, 300));
  p.act({ id: 1, gen: 3, n: 1, operation: 'filter', args: ['x'], expires: Date.now() + 5000 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([typed, answers], [['x'], [{ ok: true }]], 'the presentation is the tree\'s; its pane holds the filter');
  p.dispose();
});

test('E8 review 4: mounts of two composers that are one presentation (a page kept out of sight) take no act; mounts of one composer do', async () => {
  const { React } = createFakeReact();
  let onMount = null;
  const mounts = [];
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['comp'] }, store, exports: { react: React } };
  const graph = { types: async () => [], subscribe(q, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [] })); return { dispose() {} }; } };
  const wrote = [];
  const comp = defineBinding({
    id: 'comp', presentation: 'Composer', presents: ['Draft'], subject: () => ({ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }),
    place: { in: 'NewThreadView', slot: 'composer' },
    operations: { setText(props, [t]) { props.write(t); return true; } },
  });
  const answers = [];
  const instances = { window: async () => 7, report: async () => {}, acted: async () => {}, answer: async (g, id, outcome) => { answers.push(outcome); } };
  const p = startPresentation({ kernel: k, graph, bindings: [comp], instances });
  const shown = { n: 1, binding: 'comp', props: { write: (t) => wrote.push(['shown', t]) }, scope: { clientThreadId: 'client-new-thread:a' } };
  const again = { n: 2, binding: 'comp', props: { write: (t) => wrote.push(['again', t]) }, scope: { clientThreadId: 'client-new-thread:a' } };
  for (const r of [shown, again]) { mounts.push(r); onMount?.('mount', r); }
  await new Promise((r) => setTimeout(r, 300));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  p.act({ id: 1, gen: 7, n: 1, operation: 'setText', args: ['x'], expires: Date.now() + 5000 });
  await settle();
  assert.deepEqual([answers.at(-1), wrote], [{ ok: true }, [['shown', 'x']]], 'one composer mounted twice: its own mount');
  const hidden = { n: 3, binding: 'comp', props: { write: (t) => wrote.push(['hidden', t]) }, scope: { clientThreadId: 'client-new-thread:b' } };
  mounts.push(hidden); onMount?.('mount', hidden);
  await new Promise((r) => setTimeout(r, 300));
  p.act({ id: 2, gen: 7, n: 1, operation: 'setText', args: ['y'], expires: Date.now() + 5000 });
  await settle();
  assert.match(answers.at(-1).message ?? '', /two of these/);
  assert.equal(wrote.length, 1);
  p.dispose();
});

test('layouts WL5, native: a place the app gives no route scope: the route\'s hook reads nothing and never throws into the app (a chat\'s header drawn before its workspace has one); the app\'s read throws before its one hook slot, so the slot is taken here and the hooks after it stay where they are when the scope comes', async () => {
  const { React, ReactDOM } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {}, subscribe: () => () => {}, version: () => 0, mounted: () => [], onMount: null };
  const scope = { throws: true };
  // as the app's: its context, the throw, then its one hook slot
  const useScope = () => { React.useContext(null); if (scope.throws) throw new Error('Missing scope instance'); React.useRef(null); return { value: { routeKind: 'local-thread', conversationId: 'th-1' } }; };
  const k = { kernel: { abi: 1, bindings: ['probe'] }, store, exports: { react: React, useScope, RouteScope: {} } };
  let seen = null;
  const probe = defineBinding({ id: 'probe', presents: ['App'], render(Original, props, factory, ctx) { seen = ctx; return undefined; } });
  const graph = { types: async () => [], subscribe() { return { dispose() {} }; } };
  startPresentation({ kernel: k, graph, bindings: [probe] });
  store.renderers.get('probe')('P', {}, (type, pr) => ({ type, props: pr }), { n: 1 });
  let read = [], setCount = null;
  function Chat() { const thread = seen.useRouteThread(); const [n, set] = React.useState(7); setCount = set; read = [thread, n]; return null; }
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(Chat));
  assert.deepEqual(read, [null, 7], 'no scope: nothing read, nothing thrown');
  setCount(9);
  assert.deepEqual(read, [null, 9]);
  scope.throws = false;
  root.render(React.createElement(Chat));
  assert.deepEqual(read, ['th-1', 9], 'the scope comes: the state after the hook is still its own');
});

test('layouts WL7: a mount inside a pane is its own presentation, never a twin of the same chat\'s elsewhere; what enumerates the window\'s page skips it', async () => {
  const { React } = createFakeReact();
  const sent = [];
  const nodes = { pane: { get: () => null, set() {}, value: { pathname: '/codexmods/pane/pane-1' } }, route: { get: () => null, set() {}, value: { pathname: '/local/t1' } } };
  const mounts = [{ n: 1, binding: 'row', props: {}, pane: 'pane-1', scopeNode: nodes.pane }];
  let onMount = null;
  const store = { renderers: new Map(), onFault: null, bump() {}, subscribe: () => () => {}, version: () => 0, mounted: () => mounts, get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const REF = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [{ ref: REF, liveness: 'live', state: { title: 'T' }, links: {} }] })); return { dispose() {} }; },
  };
  let seen = null;
  const row = defineBinding({ id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF, place: { in: null, slot: 'items' }, render(O, p, f, ctx) { seen = ctx; return undefined; } });
  const instances = { window: async () => 1, report: async (g, b) => { sent.push(b); }, acted: async () => {} };
  startPresentation({ kernel: k, graph, bindings: [row], instances });
  await new Promise((r) => setTimeout(r, 5));
  store.renderers.get('row')('R', {}, (t, p) => ({ t, p }), mounts[0]);
  assert.equal(seen.anyScopeNode(), null, 'a pane\'s scope is not the window\'s');
  assert.equal(seen.scopeNodeOf('row'), null);
  mounts.push({ n: 2, binding: 'row', props: {}, scopeNode: nodes.route });
  assert.equal(seen.anyScopeNode(), nodes.route);
  assert.equal(seen.scopeNodeOf('row'), nodes.route);
});

test('graph-integrity G5.1: a presentation\'s state where any of its mounts can tell it (the app\'s step row inside its kind\'s), and a chat\'s view is focused while its pane is the one the user is in', async () => {
  const sent = [];
  const channel = { window: async () => 5, report: async (g, batch) => { sent.push(batch); }, acted: async () => {} };
  const step = { type: 'CodexCommandRun', provider: 'codex', id: 's1' };
  const place = { in: 'TurnView', via: 'turn', slot: 'steps' };
  const kind = { id: 'kind', presentation: 'StepBlock', subject: (p) => p.step ?? null, place };
  const row = { id: 'row', presentation: 'StepBlock', part: true, subject: (p) => p.step ?? null, place, expanded: (p) => p.disclosure?.expanded };
  const view = { id: 'view', presentation: 'ThreadView', subject: (p) => p.chat ?? null, place: { in: 'Window', slot: 'main' } };
  let active = null;
  const k = { n: 1, binding: 'kind', props: { step } }, r = { n: 2, binding: 'row', props: { step, disclosure: { expanded: false } } };
  const main = { n: 3, binding: 'view', props: { chat: thread('a') } }, pane = { n: 4, binding: 'view', props: { chat: thread('b') }, pane: 'pane-1' };
  let mounted = [k, r, main, pane];
  const inst = createInstances({ store: { mounted: () => mounted }, bindings: new Map([['kind', kind], ['row', row], ['view', view]]), ctx: {}, facts: () => ({ hidden: false, decorations: [] }),
    channel, activePane: () => active, schedule: (fn) => { setTimeout(fn, 0); return 1; }, cancel: () => {}, now: () => Date.now() });
  inst.touch();
  for (let i = 0; i < 6; i++) await tick();
  const last = () => Object.fromEntries(sent.flatMap((b) => b.puts).map((x) => [x.subject.id, x]));
  assert.deepEqual([last().s1?.expanded, new Set(sent.flatMap((b) => b.puts).filter((x) => x.type === 'StepBlock').map((x) => x.n)).size, sent[0].puts.filter((x) => x.type === 'StepBlock').length], [false, 1, 1],
    'one presentation: its kind\'s, with what its row tells (put once in a batch)');
  assert.deepEqual([last().a.focused, last().b.focused], [true, false], 'the window\'s own page: its main chat');
  r.props = { step, disclosure: { expanded: true } };
  inst.onMount('update', r);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(last().s1.expanded, true, 'the row\'s change is its presentation\'s');
  active = 'pane-1';
  inst.touch('ThreadView');
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([last().a.focused, last().b.focused], [false, true], 'the pane the user is in');
  mounted = [];
});
