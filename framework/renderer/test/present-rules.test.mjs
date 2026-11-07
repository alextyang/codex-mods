// The mods' presentation rules in the page (docs/design/systems.md S7 to S9, "E2 in detail"): applied in a binding's wrapper through its
// slots, ordered, claimed, budgeted, isolated; and the thread menus' entries. A fake kernel and graph stand in for the preload's kernel and
// the renderer channel, a fake React for the app's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPresentation, defineBinding } from '../present/runtime.mjs';
import { dataList, nodeRegion, siblingList, withoutSiblings } from '../present/bindings/slots.mjs';
import { threadMenus } from '../present/menus.mjs';
import { covers, budgeted, createRules } from '../present/rules.mjs';
import { createFakeReact } from './fake-react.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const REF = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 't1' };
const thread = (title, extra = {}) => ({ ref: REF, liveness: 'live', state: { title, ...extra }, links: {} });

/** The subject arrives after the first render observes it (the wrapper re-renders then): render once, then let it arrive. */
async function primed(s) { s.render(); await tick(); await tick(); }

function setup({ budget = 3, instances } = {}) {
  const { React } = createFakeReact();
  let bumps = 0;
  const store = { renderers: new Map(), onFault: null, bump() { bumps++; } };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }, { id: 'Message', concept: 'Message' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [thread('First', { unread: true })] })); return { dispose() {} }; },
  };
  const row = defineBinding({
    id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF,
    slots: {
      badges: dataList('extraIconBadges', ({ rule, item }) => ({ id: `${rule.mod}/${item.id}`, text: item.text, onClick: item.run }), { field: 'badges', budget }),
      header: nodeRegion('header'),
      beside: siblingList((env, item, key) => ({ key, text: item.text }), { field: 'label' }),
    },
    render(Original, props, f) { const [own, sib] = withoutSiblings(props); return sib.length ? { type: 'frag', children: [f(Original, own), ...sib] } : undefined; },
  });
  const faults = [];
  const p = startPresentation({ kernel: k, graph, bindings: [row], onModFault: (mod, e) => faults.push([mod, e.message]), ...(instances ? { instances } : {}) });
  const render = (props = { extraIconBadges: [] }) => store.renderers.get('row')('Row', props, (type, pr) => ({ type, props: pr }));
  const rule = (mod, id, kind, more = {}) => ({ mod, id, kind, presentation: 'SidebarItem', realm: 'renderer', order: more.order ?? 0, ...more });
  return { p, render, rule, faults, React, get bumps() { return bumps; } };
}

test('no rule: the binding costs what it did; a decorate rule adds its badges through the slot, after the app\'s own, as new props', async () => {
  const s = setup();
  await tick(); await tick();
  assert.equal(s.render(), undefined, 'the app\'s own rendering');
  s.p.rules.put(s.rule('unit.a', 'n', 'decorate', { fns: { badges: (t) => [{ id: 'b', text: t.state.title }] } }));
  await tick(); await tick();
  const native = { extraIconBadges: [{ id: 'app' }] };
  const out = s.render(native);
  assert.equal(out.type, 'Row');
  assert.deepEqual(out.props.extraIconBadges.map((b) => b.id), ['app', 'unit.a/b']);
  assert.notEqual(out.props.extraIconBadges, native.extraIconBadges, 'a new array, so the app\'s caches see the change');
  assert.equal(out.props.extraIconBadges[1].text, 'First');
});

test('order and budget: lists follow the rules\' order within the slot\'s budget, which counts the app\'s entries; reorder applies last', async () => {
  const s = setup({ budget: 3 });
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.b', 'late', 'decorate', { order: 20, data: { badges: [{ id: 'b', text: 'B' }] } }));
  s.p.rules.put(s.rule('unit.a', 'early', 'decorate', { order: 10, data: { badges: [{ id: 'a', text: 'A' }, { id: 'a2', text: 'A2' }] } }));
  await tick();
  assert.deepEqual(s.render({ extraIconBadges: [{ id: 'app' }] }).props.extraIconBadges.map((b) => b.id), ['app', 'unit.a/a', 'unit.a/a2'], 'unit.b\'s badge did not fit');
  // a reorder orders its own mod's entries (and the app's) among their places; another mod's keep theirs
  s.p.rules.put(s.rule('unit.a', 'flip', 'reorder', { slot: 'badges', order: 30, fns: { order: (items) => [...items].reverse() } }));
  await tick();
  assert.deepEqual(s.render({ extraIconBadges: [] }).props.extraIconBadges.map((b) => b.id), ['unit.a/a2', 'unit.a/a', 'unit.b/b']);
  assert.deepEqual(budgeted([1, 2, 3], 1, 3), { kept: [1, 2], dropped: [3] });
});

test('reorder orders the composed list: the app\'s entries (as frozen markers) with the mods\'; an order that is not a permutation is ignored', async () => {
  const s = setup({ budget: 5 });
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.a', 'mine', 'decorate', { order: 10, data: { badges: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] } }));
  let seen = null;
  s.p.rules.put(s.rule('unit.a', 'first', 'reorder', { slot: 'badges', order: 30, fns: { order: (items) => { seen = items; return [items[2], items[0], items[1], items[3]]; } } }));
  await tick();
  const ids = (props) => s.render(props).props.extraIconBadges.map((b) => b.id);
  assert.deepEqual(ids({ extraIconBadges: [{ id: 'app1' }, { id: 'app2' }] }), ['unit.a/a', 'app1', 'app2', 'unit.a/b'], 'a mod\'s entry before the app\'s');
  assert.deepEqual(seen.slice(0, 2), [{ native: true, index: 0 }, { native: true, index: 1 }]);
  assert.ok(Object.isFrozen(seen[0]));
  // Dropping or inventing an entry is not an order: the rule is ignored, the entries keep their order.
  s.p.rules.put(s.rule('unit.a', 'first', 'reorder', { slot: 'badges', order: 30, fns: { order: (items) => items.slice(1) } }));
  await tick();
  assert.deepEqual(ids({ extraIconBadges: [{ id: 'app1' }] }), ['app1', 'unit.a/a', 'unit.a/b']);
});

test('E7 review: a reorder orders the app\'s own entries alone, with no mod\'s entry in the slot', async () => {
  const s = setup({ budget: 5 });
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.c', 'flip', 'reorder', { slot: 'badges', order: 30, fns: { order: (items) => [...items].reverse() } }));
  await tick();
  assert.deepEqual(s.render({ extraIconBadges: [{ id: 'app1' }, { id: 'app2' }] }).props.extraIconBadges.map((b) => b.id), ['app2', 'app1']);
});

test('claims: hide and replace are one claim, the first in order wins; replace gets the app\'s rendering and the subject', async () => {
  const s = setup();
  await tick(); await tick();
  const Replacement = (props) => props;
  s.p.rules.put(s.rule('unit.b', 'hide', 'hide', { order: 20 }));
  s.p.rules.put(s.rule('unit.a', 'mine', 'replace', { order: 10, fns: { render: Replacement } }));
  await primed(s);
  const out = s.render();
  const inner = out.props.children;   // the mod's node inside its boundary
  assert.equal(inner.type, Replacement);
  assert.equal(inner.props.subject.state.title, 'First');
  assert.equal(inner.props.native.type, 'Row', 'the app\'s own rendering, to show or not');
  s.p.rules.remove('unit.a/mine');
  await tick();
  const hidden = s.render();
  assert.equal(hidden.type.name, 'Hidden', 'unit.b\'s hide takes the claim once unit.a\'s replace is gone');
  assert.equal(hidden.type(), null, 'a hidden presentation renders nothing in its place (its element stays)');
});

test('for and where: a rule covers the subject\'s type with its subtypes, and equal state fields', async () => {
  const chain = (t) => (t === 'TestAgentThread' ? ['TestAgentThread', 'Thread'] : [t]);
  const inst = thread('First', { unread: true });
  assert.equal(covers({ for: 'Thread' }, inst, chain), true);
  assert.equal(covers({ for: 'Message' }, inst, chain), false);
  assert.equal(covers({ where: { unread: true } }, inst, chain), true);
  assert.equal(covers({ where: { unread: false } }, inst, chain), false);
  assert.equal(covers({ for: 'Thread' }, null, chain), false);
  // E6, decision 6: a framework-owned subject (its provider's) is covered by no rule, with or without `for`
  const fwSubject = { ref: { type: 'SettingsSection', provider: 'codexmods.framework', id: 'mod:unit.a' }, state: {} };
  assert.equal(covers({}, fwSubject, chain), false);
  assert.equal(covers({ for: 'SettingsSection' }, fwSubject, chain), false);
  assert.equal(covers({}, { ref: { type: 'SettingsSection', provider: 'codex', id: 'general' }, state: {} }, chain), true);
  // a rule that draws for a subject goes only where its mod may read it; a status that reads nothing of its place's subject shows anyway
  const may = () => ({ may: () => false });
  const status = (item, extra = {}) => ({ kind: 'add', slot: 'status', data: { items: [{ id: 's', ...item }] }, ...extra });
  assert.equal(covers({ kind: 'decorate', data: { badges: [] } }, inst, chain, may), false, 'a decoration: not where its mod may not read');
  assert.equal(covers(status({ text: 'Weekly 27%', tooltip: 'used', meter: { value: 0.27 } }), inst, chain, may), true, 'fixed text and meter');
  for (const item of [{ text: '{{title}}' }, { text: { bind: 'title' } }, { text: 'x', when: { unread: true } }, { text: 'x', meter: { value: { bind: 'n' } } }, { text: 'x', run: { $fn: 'items.0.run' } }]) {
    assert.equal(covers(status(item), inst, chain, may), false, `reads or is handed its subject: ${JSON.stringify(item)}`);
  }
  assert.equal(covers(status({ text: 'x' }, { callbacks: ['items.0.run'] }), inst, chain, may), false, 'a host rule with a run');
  assert.equal(covers(status({ text: 'x' }, { fns: { items: () => [] } }), inst, chain, may), false, 'a renderer rule with functions');
  const s = setup();
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.a', 'msg', 'decorate', { for: 'Message', data: { badges: [{ id: 'm', text: 'M' }] } }));
  s.p.rules.put(s.rule('unit.a', 'unread', 'decorate', { for: 'Thread', where: { unread: true }, order: 1, data: { badges: [{ id: 'u', text: 'U' }] } }));
  await primed(s);
  assert.deepEqual(s.render().props.extraIconBadges.map((b) => b.id), ['unit.a/u']);
});

test('isolation: a rule whose function throws is off alone and counts a fault for its mod; a callback it handed the app is guarded', async () => {
  const s = setup();
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.a', 'boom', 'decorate', { order: 1, fns: { badges: () => { throw new Error('boom'); } } }));
  let ran = 0;
  s.p.rules.put(s.rule('unit.b', 'ok', 'decorate', { order: 2, fns: { badges: () => [{ id: 'k', text: 'K', run: () => { ran++; throw new Error('click'); } }] } }));
  await primed(s);
  const out = s.render();
  assert.deepEqual(out.props.extraIconBadges.map((b) => b.id), ['unit.b/k'], 'the other rule still applies');
  assert.deepEqual(s.faults, [['unit.a', 'boom']]);
  assert.deepEqual(s.p.rules.tripped(), ['unit.a/boom']);
  out.props.extraIconBadges[0].onClick();
  assert.equal(ran, 1);
  assert.deepEqual(s.faults.map((f) => f[0]), ['unit.a', 'unit.b'], 'the throwing callback counted for its mod');
  assert.equal(s.render(), undefined, 'unit.b is off too now: the app\'s own rendering');
});

test('regions and siblings: host rules render each mod\'s component in its boundary; a binding renders siblings it was given, never passed to the app', async () => {
  const s = setup();
  await tick(); await tick();
  const Panel = () => 'panel';
  s.p.rules.put(s.rule('unit.a', 'panel', 'host', { slot: 'header', fns: { render: Panel } }));
  s.p.rules.put(s.rule('unit.a', 'label', 'decorate', { data: { label: [{ text: 'L' }] }, order: 1 }));
  await tick();
  const out = s.render({ extraIconBadges: [], header: 'native header' });
  assert.equal(out.type, 'frag');
  const [row, sibling] = out.children;
  assert.ok(!('__codexmodsSiblings' in row.props), 'the private prop never reaches the app\'s component');
  assert.equal(sibling.text, 'L');
  const header = row.props.header;   // a fragment of the app's header and the hosted node
  assert.equal(header.props.children[0], 'native header');
  assert.equal(header.props.children[1].props.children.type, Panel);
});

test('the thread menus: the mods\' entries come after the app\'s, behind a separator, as intl descriptors; none without rules', () => {
  const items = [{ id: 'rename-thread' }, { id: 'pin-thread' }];
  assert.deepEqual(threadMenus()({ target: { conversationId: 'codex-1' } }, items), items);
  const entry = (id) => ({ id, message: { id, defaultMessage: 'Do it' }, onSelect() {} });
  const extra = () => [[entry('codexmods:unit.a/x/0')]];
  const out = threadMenus(extra)({ target: { conversationId: 'codex-1' } }, items);
  assert.deepEqual(out.map((x) => x.id ?? x.type), ['rename-thread', 'pin-thread', 'codexmods:separator:0', 'codexmods:unit.a/x/0'], 'a separator with an id (the app\'s DOM menu keys by it)');
  assert.equal(typeof out[3].message, 'object');
  // Each rule's entries are a group of their own (E7.3), behind its separator; an empty group adds nothing.
  const two = threadMenus(() => [[entry('a/1'), entry('a/2')], [], [entry('b/1')]])({ target: { conversationId: 'codex-1' } }, items);
  assert.deepEqual(two.map((x) => x.id ?? x.type), ['rename-thread', 'pin-thread', 'codexmods:separator:0', 'a/1', 'a/2', 'codexmods:separator:1', 'b/1']);
  assert.deepEqual(threadMenus(() => { throw new Error('x'); })({ target: {} }, items), items, 'a failing source leaves the app\'s items');
});

test('the bindings\' slots and presentation types are the ones addresses.json declares (the Host checks a rule against that file)', async () => {
  const { readFileSync } = await import('node:fs');
  const { BINDINGS } = await import('../present/bindings/index.mjs');
  const addresses = JSON.parse(readFileSync(new URL('../present/addresses.json', import.meta.url), 'utf8'));
  for (const b of BINDINGS) {
    const a = addresses.bindings.find((x) => x.id === b.id);
    assert.ok(a, `${b.id} has an address`);
    if (a.target === false) { assert.equal(b.presentation, undefined, `${b.id} is a framework host, no rule target`); continue; }
    assert.equal(b.presentation, a.presentation, `${b.id}: its presentation type`);
    assert.deepEqual(Object.keys(b.slots ?? {}).sort(), [...(a.slots ?? [])].sort(), `${b.id}: its slots`);
    // A twin (E7): another presentation the component also realizes, by its slots
    assert.deepEqual((b.twins ?? []).map((t) => [t.presentation, Object.keys(t.slots).sort()]), (a.twins ?? []).map((t) => [t.presentation, [...t.slots].sort()]), `${b.id}: its twins`);
  }
});

test('style: the app\'s own variables set to theme tokens, one owner per variable in order, the next owner or the app\'s value on removal', async () => {
  const { stylesOf } = await import('../present/styles.mjs');
  const tokens = { accent: '--codex-base-accent', danger: '--color-text-danger', success: '--color-text-success' };
  const known = (v) => ['--codex-base-accent', '--color-text-danger', '--color-text-success', '--color-border'].includes(v);
  const a = { mod: 'unit.a', id: 's', kind: 'style', order: 1, data: { variables: { '--codex-base-accent': 'danger', '--nope': 'danger', '--color-border': '#ff0000' } } };
  const b = { mod: 'unit.b', id: 's', kind: 'style', order: 2, data: { variables: { '--codex-base-accent': 'success', '--color-border': '--color-text-success' } } };
  const r = stylesOf([a, b], { tokens, known });
  assert.equal(r.css, ':root, :root * { --codex-base-accent: var(--color-text-danger) !important; --color-border: var(--color-text-success) !important; }');
  assert.deepEqual(r.conflicts, [{ rule: 'unit.b/s', variable: '--codex-base-accent', holder: 'unit.a/s' }]);
  assert.deepEqual(r.refused.map((x) => x.variable), ['--nope', '--color-border'], 'not the app\'s variable; a raw value');
  // public hooks §3.14: one token for each appearance, the one the theme shows now
  const c = { mod: 'unit.c', id: 's', kind: 'style', order: 1, data: { variables: { '--codex-base-accent': { light: 'danger', dark: 'success' }, '--color-border': { light: 'danger', dark: '#000' } } } };
  assert.equal(stylesOf([c], { tokens, known, appearance: 'dark' }).css, ':root, :root * { --codex-base-accent: var(--color-text-success) !important; }');
  assert.equal(stylesOf([c], { tokens, known }).css, ':root, :root * { --codex-base-accent: var(--color-text-danger) !important; --color-border: var(--color-text-danger) !important; }', 'light by default');
  // E6.4b: at the framework's roots each variable set is declared again with the app's own value (an unsafe value is not written)
  const asked = [];
  const kept = stylesOf([a, b], { tokens, known, appValues: (vars) => { asked.push(vars); return { '--codex-base-accent': '#0169cc', '--color-border': 'rgba(0, 0, 0, 0.1)}x{' }; } });
  assert.deepEqual(asked, [['--codex-base-accent', '--color-border']]);
  assert.equal(kept.css, ':root, :root * { --codex-base-accent: var(--color-text-danger) !important; --color-border: var(--color-text-success) !important; } '
    + '[data-codexmods-framework], [data-codexmods-framework] * { --codex-base-accent: #0169cc !important; }');
  assert.equal(stylesOf([], { tokens, known, appValues: () => { throw new Error('not asked without rules'); } }).css, '');
  // E6 review: every variable the rules change, an alias defined from an overridden one included, keeps the app's value at the roots
  const roots = [];
  const aliased = stylesOf([a], { tokens, known, protectRoots: (css) => { roots.push(css); return { '--codex-base-accent': '#0169cc', '--wb-accent': '#0169cc', '--bad': 'x}y' }; } });
  assert.deepEqual(roots, [':root { --codex-base-accent: var(--color-text-danger) !important; }']);
  assert.match(aliased.css, /\[data-codexmods-framework\], \[data-codexmods-framework\] \* \{ --codex-base-accent: #0169cc !important; --wb-accent: #0169cc !important; \}$/);
  // In the runtime: the window's style sheet follows the rules.
  const sheets = [];
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const p = startPresentation({ kernel: { kernel: { abi: 1, bindings: [] }, store, exports: { react: React } }, graph: { types: async () => [], subscribe: () => ({ dispose() {} }) }, bindings: [],
    tokens, cssVar: (v) => (known(v) ? 'x' : ''), styleSink: (css) => sheets.push(css) });
  p.rules.put({ ...b, realm: 'renderer' });
  p.rules.put({ ...a, realm: 'host' });
  assert.match(sheets.at(-1), /--codex-base-accent: var\(--color-text-danger\)/, 'unit.a holds it (first in order)');
  p.rules.remove('unit.a/s');
  assert.match(sheets.at(-1), /--codex-base-accent: var\(--color-text-success\)/, 'the next owner takes it');
  p.rules.remove('unit.b/s');
  assert.equal(sheets.at(-1), '', 'the app\'s own value');
  p.dispose();
  // E6.4b: the framework's roots keep the app's own value, read again when the theme changes
  let appAccent = '#0169cc', onTheme = null, themeGone = false;
  const q = startPresentation({ kernel: { kernel: { abi: 1, bindings: [] }, store: { renderers: new Map(), onFault: null, bump() {} }, exports: { react: React } },
    graph: { types: async () => [], subscribe: () => ({ dispose() {} }) }, bindings: [], tokens, cssVar: (v) => (known(v) ? 'x' : ''), styleSink: (css) => sheets.push(css),
    appValues: (vars) => Object.fromEntries(vars.map((v) => [v, v === '--codex-base-accent' ? appAccent : ''])),
    onTheme: (fn) => { onTheme = fn; return { dispose() { themeGone = true; } }; } });
  q.rules.put({ ...a, realm: 'host' });
  assert.match(sheets.at(-1), /\[data-codexmods-framework\], \[data-codexmods-framework\] \* \{ --codex-base-accent: #0169cc !important; \}/);
  appAccent = '#339cff';   // dark
  onTheme();
  assert.match(sheets.at(-1), /\[data-codexmods-framework\], \[data-codexmods-framework\] \* \{ --codex-base-accent: #339cff !important; \}/);
  q.dispose();
  assert.equal(themeGone, true);
});

test('E7.2: a twin takes its own presentation\'s rules in its slots, never their claims; the component\'s own rules stay its own', async () => {
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['answer'] }, store, exports: { react: React } };
  const MSG = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 'm1' };
  const TURN = { type: 'TestAgentThread', provider: 'qa.test-agent', id: 'u1' };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [MSG, TURN].map((ref) => ({ ref, liveness: 'live', state: { title: ref.id }, links: {} })) })); return { dispose() {} }; },
  };
  const answer = defineBinding({
    id: 'answer', presentation: 'MessageBlock', presents: ['Thread'], subject: () => MSG,
    slots: { actions: dataList('actions', ({ rule, item }) => `${rule.mod}:${item.id}:message`, { field: 'actions' }) },
    twins: [{ presentation: 'TurnView', subject: (props) => (props.turnId ? TURN : null), slots: {
      actions: dataList('trailing', ({ rule, item }) => `${rule.mod}:${item.id}:turn`, { field: 'actions' }),
      afterAnswer: nodeRegion('after'),
    } }],
  });
  const p = startPresentation({ kernel: k, graph, bindings: [answer] });
  const rule = (mod, id, kind, presentation, more = {}) => ({ mod, id, kind, presentation, realm: 'renderer', order: 1, ...more });
  p.rules.put(rule('unit.a', 'm', 'decorate', 'MessageBlock', { data: { actions: [{ id: 'x', title: 'X' }] } }));
  p.rules.put(rule('unit.b', 't', 'decorate', 'TurnView', { data: { actions: [{ id: 'y', title: 'Y' }] } }));
  p.rules.put(rule('unit.b', 'hide', 'hide', 'TurnView'));   // a turn's claim: never the answer's to apply
  const Region = () => null;
  p.rules.put(rule('unit.c', 'after', 'host', 'TurnView', { slot: 'afterAnswer', fns: { render: Region } }));
  const render = (props) => store.renderers.get('answer')('Answer', props, (type, pr) => ({ type, props: pr }));
  render({ actions: [], trailing: [] }); await tick(); await tick();
  const out = render({ turnId: 'u1', actions: [], trailing: [], after: null });
  assert.equal(out.type, 'Answer', 'the turn\'s hide is not applied here');
  assert.deepEqual([out.props.actions, out.props.trailing], [['unit.a:x:message'], ['unit.b:y:turn']]);
  assert.ok(out.props.after, 'the turn\'s region after the answer');
  // Without its turn (an answer that is not the final one), only the message's own slots.
  const plain = render({ actions: [], trailing: [], after: null });
  assert.deepEqual([plain.props.actions, plain.props.trailing, plain.props.after], [['unit.a:x:message'], [], null]);
  assert.throws(() => defineBinding({ id: 'bad', presents: ['Thread'], subject: () => null, twins: [{ presentation: 'TurnView', slots: {} }] }), /a twin is/);
});

test('E8.1: a host-realm rule\'s callback runs through the Host with the action\'s env; a renderer callback gets the same env', async () => {
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [thread('First')] })); return { dispose() {} }; },
  };
  const row = defineBinding({
    id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF,
    slots: { badges: dataList('extraIconBadges', ({ rule, item }) => ({ id: `${rule.mod}/${item.id}`, onClick: item.run }), { field: 'badges' }) },
  });
  const calls = [];
  const p = startPresentation({ kernel: k, graph, bindings: [row], instances: { callback: async (key, reg, path, env) => { calls.push([key, reg, path, env]); return null; } } });
  await tick(); await tick();
  p.rules.put({ mod: 'unit.h', id: 'cb', kind: 'decorate', presentation: 'SidebarItem', realm: 'host', order: 1,
    data: { badges: [{ id: 'k', text: 'K', run: { $fn: 'badges.0.run' } }, { id: 'fake', text: 'F', run: { $fn: 'badges.9.run' } }], label: { $fn: 'badges.0.run' } }, callbacks: ['badges.0.run'], reg: 'r1' });
  let got = null;
  p.rules.put({ mod: 'unit.r', id: 'local', kind: 'decorate', presentation: 'SidebarItem', realm: 'renderer', order: 2, fns: { badges: () => [{ id: 'r', text: 'R', run: (env) => { got = env; } }] } });
  const render = () => store.renderers.get('row')('Row', { extraIconBadges: [] }, (type, pr) => ({ type, props: pr }));
  render(); await tick(); await tick();
  const out = render();
  const [hosted, fake, local] = out.props.extraIconBadges;
  assert.deepEqual([hosted.id, fake.id, local.id], ['unit.h/k', 'unit.h/fake', 'unit.r/r']);
  assert.equal(fake.onClick, undefined, 'a marker the rule did not name as a callback is nothing');
  await hosted.onClick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['unit.h/cb', 'r1', 'badges.0.run']);
  const env = calls[0][3];
  assert.deepEqual(env.subject, REF);
  assert.deepEqual(env.thread, REF, 'the subject is a thread (a subtype of Thread)');
  assert.equal(env.draft, null);
  assert.equal(env.via, 'click');
  assert.doesNotThrow(() => JSON.stringify(env), 'the env is JSON (it crosses to the worker)');
  local.onClick();
  assert.deepEqual(got, env, 'the renderer realm\'s callback gets the same env');
});

test('E8 review: a guarded function from a registration that is gone or replaced does nothing (renderer: its functions; host realm: its token)', () => {
  const rules = createRules({});
  const fnsA = { run: () => 'a' };
  rules.reset([{ mod: 'm', id: 'r', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'renderer', fns: fnsA }]);
  const old = rules.get('m/r');
  const run = rules.guard(old, () => 'ran');
  assert.equal(run(), 'ran');
  rules.put({ mod: 'm', id: 'r', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'renderer', fns: { run: () => 'b' } });
  assert.equal(run(), undefined, 'registered again in this window: the older function does nothing');
  assert.equal(rules.live(rules.get('m/r')), true);
  rules.remove('m/r');
  assert.equal(rules.live(old), false);
  rules.reset([{ mod: 'h', id: 'x', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'host', reg: 't1', data: {} }]);
  const h = rules.guard(rules.get('h/x'), () => 'h');
  rules.put({ mod: 'h', id: 'x', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'host', reg: 't2', data: {} });
  assert.equal(h(), undefined, 'another token: nothing');
});

test('E8 review 2: a late failure of an older renderer registration does not trip the newer one; a tripped rule is not live', () => {
  const faults = [];
  const rules = createRules({ onFault: (mod, e, key) => faults.push(key) });
  rules.reset([{ mod: 'm', id: 'r', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'renderer', fns: { a: 1 } }]);
  const old = rules.get('m/r');
  rules.put({ mod: 'm', id: 'r', kind: 'add', presentation: 'Menu', slot: 'groups', order: 1, realm: 'renderer', fns: { a: 2 } });
  rules.trip(old, new Error('late'));
  assert.deepEqual(faults, [], 'the older registration\'s failure');
  const now = rules.get('m/r');
  assert.equal(rules.live(now), true);
  rules.trip(now, new Error('its own'));
  assert.deepEqual(faults, ['m/r']);
  assert.equal(rules.live(now), false, 'tripped: not live');
});

test('E8 review 4: a menu bar choice runs the renderer rule only for the registration its menu was built from', async () => {
  const s = setup();
  await tick(); await tick();
  const ran = [];
  s.p.rules.put(s.rule('unit.a', 'm', 'add', { presentation: 'Menu', slot: 'groups', reg: 'r2', fns: { menuRun: (env) => ran.push(env.via) } }));
  s.p.runRule({ key: 'unit.a/m', reg: 'r1', path: 'menuRun', env: { via: 'menu' } });
  assert.deepEqual(ran, [], 'a choice from the menu of an older registration');
  s.p.runRule({ key: 'unit.a/m', reg: 'r2', path: 'menuRun', env: { via: 'keys' } });
  assert.deepEqual(ran, ['keys']);
});

test('E8.11: a mod command run through the graph runs its renderer rule\'s own function in the page, for its registration only', async () => {
  const s = setup();
  await tick(); await tick();
  const ran = [];
  s.p.rules.put(s.rule('unit.a', 'c', 'add', { presentation: 'Palette', slot: 'resultSources', reg: 'r1', data: { command: { title: 'C' } }, fns: { command: { title: 'C', run: (env) => ran.push(env.via) } } }));
  s.p.runRule({ key: 'unit.a/c', reg: 'r0', path: 'command.run', env: { via: 'graph' } });
  s.p.runRule({ key: 'unit.a/c', reg: 'r1', path: 'command.run', env: { via: 'graph' } });
  s.p.runRule({ key: 'unit.a/c', reg: 'r1', path: 'other', env: { via: 'graph' } });
  assert.deepEqual(ran, ['graph']);
});

test('H7lr: a link route\'s run for a link opened in this window runs its own function, for its registration only; no other rule\'s entry runs by that path', async () => {
  const s = setup();
  await tick(); await tick();
  const ran = [];
  s.p.rules.put(s.rule('unit.a', 'l', 'add', { presentation: 'Window', slot: 'links', reg: 'r1', data: { route: { handles: true } }, fns: { items: [{ id: 'l', run: (env) => ran.push(['link', env.link.host]) }] } }));
  s.p.rules.put(s.rule('unit.a', 'other', 'add', { presentation: 'Palette', slot: 'resultSources', reg: 'o1', fns: { items: [{ id: 'x', run: () => ran.push(['other']) }] } }));
  s.p.runRule({ key: 'unit.a/l', reg: 'r0', path: 'items.0.run', env: { link: { host: 'old' } } });
  s.p.runRule({ key: 'unit.a/l', reg: 'r1', path: 'items.0.run', env: { link: { host: 'a.test' } } });
  s.p.runRule({ key: 'unit.a/other', reg: 'o1', path: 'items.0.run', env: {} });
  assert.deepEqual(ran, [['link', 'a.test']]);
});

test('review 4, round 2: a run the Host sends is answered once: ran, not run (another registration, none named, gone) or failed', async () => {
  const answers = [];
  const s = setup({ instances: { answer: (gen, id, outcome) => answers.push([id, outcome]) } });
  await tick(); await tick();
  const ran = [];
  s.p.rules.put(s.rule('unit.a', 'c', 'add', { presentation: 'Palette', slot: 'resultSources', reg: 'r1', fns: { command: { title: 'C', run: (env) => ran.push(env.via) } } }));
  s.p.rules.put(s.rule('unit.a', 'bad', 'add', { presentation: 'Palette', slot: 'resultSources', reg: 'b1', fns: { command: { title: 'B', run: () => { throw new Error('boom'); } } } }));
  s.p.rules.put(s.rule('unit.a', 'slow', 'add', { presentation: 'Palette', slot: 'resultSources', reg: 's1', fns: { command: { title: 'S', run: () => Promise.reject(new Error('later')) } } }));
  const run = (id, key, reg, path = 'command.run') => s.p.runRule({ id, gen: 1, key, reg, path, env: { via: 'graph' }, expires: Date.now() + 5000 });
  run(1, 'unit.a/c', 'r1');
  run(2, 'unit.a/c', 'r0');
  run(3, 'unit.a/c', undefined);
  run(4, 'unit.a/gone', 'r1');
  run(5, 'unit.a/bad', 'b1');
  run(6, 'unit.a/bad', 'b1');
  run(7, 'unit.a/slow', 's1');
  run(1, 'unit.a/c', 'r1');
  await tick(); await tick();
  assert.deepEqual(ran, ['graph'], 'once, for its own registration');
  const by = new Map(answers.map(([id, o]) => [id, o]));
  assert.equal(answers.filter(([id]) => id === 1).length, 1, 'each run answered once');
  assert.deepEqual(by.get(1), { ok: true });
  assert.deepEqual([2, 3, 4].map((id) => by.get(id).refused), ['stale', 'stale', 'stale'], 'another registration, none named, or gone: not run');
  assert.deepEqual(by.get(5), { failed: 'boom' });
  assert.equal(by.get(6).refused, 'stale', 'tripped by its failure: off');
  assert.deepEqual(by.get(7), { failed: 'later' }, 'its promise rejected: failed');
});

test('graph-layers L3: a declaration acted on here for the Host: a list\'s filter turned on; one that is not here, or not that kind, refused; answered once', async () => {
  const answers = [];
  const s = setup({ instances: { answer: (gen, id, outcome) => answers.push([id, outcome]) } });
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.f', 'tickets', 'add', { presentation: 'Sidebar', slot: 'filter', realm: 'host', data: { filter: { title: 'Tickets', where: 'T-' } } }));
  s.p.rules.put(s.rule('unit.f', 'quiet', 'add', { presentation: 'ThreadView', slot: 'filter', realm: 'host', data: { filter: { title: 'Quiet', where: { kind: 'command' } } } }));
  s.p.rules.put(s.rule('unit.f', 'note', 'add', { presentation: 'ThreadView', slot: 'header', realm: 'host', data: { items: [] } }));
  const act = (id, key, op) => s.p.declAct({ id, gen: 1, key, op, args: {}, expires: Date.now() + 5000 });
  act(1, 'unit.f/tickets', 'filter.on');
  act(2, 'unit.f/gone', 'filter.on');
  act(3, 'unit.f/tickets', 'panel.open');
  act(1, 'unit.f/tickets', 'filter.off');
  act(4, 'unit.f/quiet', 'filter.on');
  act(5, 'unit.f/note', 'filter.on');
  await tick();
  assert.deepEqual(answers.map(([id, o]) => [id, o.ok === true ? 'ok' : o.refused]), [[1, 'ok'], [2, 'unavailable'], [3, 'invalid'], [4, 'ok'], [5, 'invalid']], 'not here (yet): unavailable; not that kind: invalid (never)');
});

test('graph-layers L3 (built review): a renderer rule is drawn as this window registered it, whatever the newest window\'s says', async () => {
  const { joinWindowRule } = await import('../present/rules.mjs');
  const newest = { mod: 'm', id: 'e', kind: 'decorate', presentation: 'SidebarItem', realm: 'renderer', order: 3, for: 'Thread', where: { archived: true }, data: { label: 'B' }, regs: { 2: 't2' } };
  const fns = { badges: () => [] };
  const mine = joinWindowRule(newest, { fns, reg: 't1', desc: { kind: 'decorate', presentation: 'SidebarItem', id: 'e', for: 'Thread', where: { archived: false }, data: { label: 'A' }, reg: 't1' } });
  assert.deepEqual([mine.where, mine.data, mine.reg, mine.order, mine.fns === fns, 'regs' in mine], [{ archived: false }, { label: 'A' }, 't1', 3, true, false]);
  assert.equal(joinWindowRule(newest, undefined), null, 'not held here');
  const old = joinWindowRule(newest, { fns, reg: 't9' });
  assert.deepEqual([old.where, old.data], [{ archived: true }, { label: 'B' }], 'a handle without its registration: the Host\'s');
  // the same hide id for the terminal here and the browser in the newest window: this window's part (and `of`) (layouts WL2-4a review)
  const hideB = { mod: 'm', id: 'k', kind: 'hide', presentation: 'SidePanel', realm: 'renderer', part: ['browser'], of: { type: 'Thread', provider: 'codex', id: 'b' } };
  const hideA = joinWindowRule(hideB, { fns: {}, reg: 't1', desc: { kind: 'hide', presentation: 'SidePanel', id: 'k', part: 'terminal', of: { type: 'Thread', provider: 'codex', id: 'a' } } });
  assert.deepEqual([hideA.part, hideA.of.id], [['terminal'], 'a']);
  assert.equal('of' in joinWindowRule(hideB, { fns: {}, reg: 't1', desc: { kind: 'hide', presentation: 'SidePanel', id: 'k', part: ['terminal'] } }), false, 'none declared here: none');
});

test('layouts WL2-4a review round 2: a rule updated without its `of` is no longer restricted by the old one (the record is replaced, its handle kept)', async () => {
  const { createRules } = await import('../present/rules.mjs');
  const rules = createRules({});
  const fns = { render: () => null };
  rules.put({ mod: 'm', id: 'k', kind: 'hide', presentation: 'SidePanel', part: ['terminal'], of: { type: 'Thread', provider: 'codex', id: 'a' }, fns, reg: 't1' });
  rules.put({ mod: 'm', id: 'k', kind: 'hide', presentation: 'SidePanel', part: ['terminal'] });
  const r = rules.get(rules.keyOf({ mod: 'm', id: 'k' }));
  assert.deepEqual(['of' in r, r.fns === fns, r.reg], [false, true, 't1']);
});

test('graph-layers L3 (built review, round 2): a window\'s own priority orders its registration, whatever the newest window\'s', async () => {
  const { joinWindowRule } = await import('../present/rules.mjs');
  const newest = { mod: 'm', id: 'x', kind: 'hide', presentation: 'SidebarItem', realm: 'renderer', priority: 50, order: 1e6 + 1000 - 50 };
  const mine = joinWindowRule(newest, { fns: {}, reg: 't1', desc: { kind: 'hide', presentation: 'SidebarItem', id: 'x' } });
  assert.deepEqual([mine.order, mine.priority], [1e6 + 1000, 0], 'its own priority 0, not the other window\'s 50');
});

test('layouts WL4c: the window\'s own act moves the sidebar where the frame allows it (no rail: refused, said)', async () => {
  const answers = [];
  const s = setup({ instances: { answer: (gen, id, outcome) => answers.push([id, outcome]) } });
  await tick(); await tick();
  s.p.declAct({ id: 1, gen: 1, key: 'codexmods:window', op: 'sidebar.edge', args: { edge: 'right' }, expires: Date.now() + 5000 });
  s.p.declAct({ id: 2, gen: 1, key: 'codexmods:window', op: 'sidebar.edge', args: { edge: 'left' }, expires: Date.now() + 5000 });
  s.p.declAct({ id: 3, gen: 1, key: 'codexmods:window', op: 'other', args: {}, expires: Date.now() + 5000 });
  await tick();
  assert.deepEqual(answers.map(([id, o]) => [id, o.ok === true ? 'ok' : o.refused, o.message ?? null]),
    [[1, 'unavailable', 'the sidebar goes to the right only where the app shows its rail'], [2, 'ok', null], [3, 'unavailable', 'this window cannot do that']]);
});

test('graph-layers L3 (built review, round 2): a declaration act for a host rule names its registration; another registered since is not acted on', async () => {
  const answers = [];
  const s = setup({ instances: { answer: (gen, id, outcome) => answers.push([id, outcome]) } });
  await tick(); await tick();
  s.p.rules.put(s.rule('unit.f', 'tickets', 'add', { presentation: 'Sidebar', slot: 'filter', realm: 'host', reg: 'r2', data: { filter: { title: 'Tickets', where: 'T-' } } }));
  s.p.declAct({ id: 1, gen: 1, key: 'unit.f/tickets', op: 'filter.on', args: {}, reg: 'r1', expires: Date.now() + 5000 });
  s.p.declAct({ id: 2, gen: 1, key: 'unit.f/tickets', op: 'filter.on', args: {}, reg: 'r2', expires: Date.now() + 5000 });
  await tick();
  assert.deepEqual(answers.map(([id, o]) => [id, o.ok === true ? 'ok' : o.refused]), [[1, 'stale'], [2, 'ok']]);
});

test('public hooks §3.10: the app\'s own parts a binding draws are hidden before its slots, without claiming the whole', async () => {
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['footer', 'menuPart'] }, store, exports: { react: React } };
  const graph = { types: async () => [{ id: 'Draft', concept: 'Draft' }], subscribe() { return { dispose() {} }; } };
  const footer = defineBinding({
    id: 'footer', presentation: 'Composer', presents: ['Draft'],
    appParts: { attach: (p) => ({ ...p, plus: null }), dictate: (p) => ({ ...p, voice: { ...p.voice, visible: false } }) },
    slots: { toolbar: nodeRegion('plus') }, render: () => undefined,
  });
  const menuPart = defineBinding({ id: 'menuPart', presentation: 'Composer', part: true, presents: ['Draft'], appParts: { access: 'self' }, render: () => undefined });
  assert.throws(() => defineBinding({ id: 'bad', presentation: 'Composer', presents: ['Draft'], appParts: { x: 'no' }, render: () => undefined }), /'self' or a function/);
  const p = startPresentation({ kernel: k, graph, bindings: [footer, menuPart] });
  await tick(); await tick();
  const draw = (id, props) => store.renderers.get(id)('C', props, (type, pr) => ({ type, props: pr }));
  const rule = (id, kind, more) => ({ mod: 'unit.a', id, kind, presentation: 'Composer', realm: 'host', order: 1, ...more });
  assert.equal(draw('footer', { plus: 'P', voice: { visible: true } }), undefined, 'no rule: as it was');
  p.rules.put(rule('h', 'hide', { part: ['attach', 'dictate', 'access'] }));
  p.rules.put(rule('r', 'host', { slot: 'toolbar', fns: { render: () => 'mine' } }));
  await tick();
  const out = draw('footer', { plus: 'P', voice: { visible: true } });
  assert.equal(out.type, 'C', 'the composer itself is still drawn');
  assert.equal(out.props.voice.visible, false);
  assert.notEqual(out.props.plus, 'P', 'the app\'s "+" is gone');
  assert.ok(out.props.plus, 'the mods\' toolbar entry is still there');
  assert.equal(draw('menuPart', {}).type.name, 'Hidden', 'a part the binding is: not drawn');
});

test('layouts D3: a TitleBar part is relabelled through the component that draws its text (the sidebar toggle\'s button)', async () => {
  const { titleSidebarToggle } = await import('../present/bindings/frame.mjs');
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['title.sidebarToggle'] }, store, exports: { react: React } };
  const graph = { types: async () => [{ id: 'App', concept: 'App' }], subscribe() { return { dispose() {} }; } };
  const p = startPresentation({ kernel: k, graph, bindings: [titleSidebarToggle] });
  await tick(); await tick();
  const draw = (props) => store.renderers.get('title.sidebarToggle')('C', props, (type, pr) => ({ type, props: pr }));
  const toggle = { isSidebarTrigger: true, viewTransitionName: 'sidebar-trigger', ariaLabel: 'Hide sidebar', tooltipContent: 'Toggle sidebar', onClick() {} };
  assert.equal(draw(toggle), undefined, 'no rule: as it was');
  const rule = (id, kind, more) => ({ mod: 'unit.a', id, kind, presentation: 'TitleBar', realm: 'host', order: 1, ...more });
  p.rules.put(rule('l', 'decorate', { part: ['sidebarToggle'], data: { label: 'Navigator' } }));
  await tick();
  const t = draw(toggle);
  assert.deepEqual([t.props.ariaLabel, t.props.tooltipContent], ['Navigator', 'Navigator'], 'its name and its tooltip: the label');
  const back = draw({ ariaLabel: 'Back', tooltipContent: 'Back', onClick() {}, children: null });
  assert.ok(back === undefined || back.props.ariaLabel === 'Back', 'the same button drawing Back: as it was');
  p.rules.put(rule('t', 'decorate', { part: ['sidebarToggle'], order: 0, data: { tooltip: 'Show the navigator' } }));
  await tick();
  const t2 = draw(toggle);
  assert.deepEqual([t2.props.ariaLabel, t2.props.tooltipContent], ['Hide sidebar', 'Show the navigator'], 'the first rule on a part wins; a tooltip alone keeps the name');
  p.rules.put(rule('h', 'hide', { part: ['sidebarToggle'] }));
  await tick();
  assert.equal(draw(toggle), undefined, 'hidden (by its HeaderAction): not relabelled');
  assert.throws(() => defineBinding({ id: 'bad', presents: ['App'], relabelParts: { x: 'no' }, render: () => undefined }), /relabel part x is a function/);
});

test('layouts D9: a binding that keeps what no claim may take (a sidebar group with a chat that needs the user) is drawn whoever hides or replaces it', async () => {
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['group'] }, store, exports: { react: React } };
  const graph = { types: async () => [{ id: 'Project', concept: 'Project' }], subscribe() { return { dispose() {} }; } };
  const group = defineBinding({ id: 'group', presentation: 'SidebarSection', presents: ['Project'], keeps: (props) => props.urgent === true, render: () => undefined });
  const p = startPresentation({ kernel: k, graph, bindings: [group] });
  await tick(); await tick();
  const draw = (props) => store.renderers.get('group')('G', props, (type, pr) => ({ type, props: pr }));
  p.rules.put({ mod: 'unit.a', id: 'h', kind: 'hide', presentation: 'SidebarSection', realm: 'host', order: 1 });
  await tick();
  assert.equal(draw({ urgent: false }).type.name, 'Hidden');
  assert.equal(draw({ urgent: true }), undefined, 'kept: the app\'s own');
  assert.throws(() => defineBinding({ id: 'bad', presentation: 'SidebarSection', presents: ['Project'], keeps: true, render: () => undefined }), /keeps\(props, ctx\) is a function/);
});

test('layouts §4.1: a sidebar footer part a mod hides is not drawn; the rest of the footer is the app\'s', async () => {
  const { footerParts } = await import('../present/bindings/frame.mjs');
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const ids = footerParts.map((b) => b.id);
  const k = { kernel: { abi: 1, bindings: ids }, store, exports: { react: React } };
  const graph = { types: async () => [{ id: 'App', concept: 'App' }], subscribe() { return { dispose() {} }; } };
  const p = startPresentation({ kernel: k, graph, bindings: footerParts });
  await tick(); await tick();
  const draw = (id) => store.renderers.get(id)('C', {}, (type, pr) => ({ type, props: pr }));
  assert.equal(draw('sidebar.footer.invite'), undefined, 'no rule: the app\'s');
  p.rules.put({ mod: 'unit.a', id: 'h', kind: 'hide', presentation: 'Sidebar', part: ['invite', 'gettingStarted'], realm: 'host', order: 1 });
  await tick();
  assert.deepEqual(['sidebar.footer.invite', 'sidebar.footer.checklist', 'sidebar.footer.financeChecklist', 'sidebar.footer.usageAlert'].map((id) => draw(id)?.type?.name ?? 'drawn'), ['Hidden', 'Hidden', 'Hidden', 'drawn']);
});

test('public hooks §3.14: a panel view opened in a modal is on the app\'s modal stack in the framework\'s dialog, once; closing it takes it off', async () => {
  const { React } = createFakeReact();
  const opened = [], closed = [];
  const node = { set() {}, get() {} };
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => [{ binding: 'x', scopeNode: node }] };
  const k = { kernel: { abi: 1, bindings: [] }, store, exports: { react: React, modal: { open: (n, C, props, opts) => opened.push([n, C, opts]), close: (n, C) => closed.push([n, C]) } } };
  const graph = { types: async () => [], subscribe: () => ({ dispose() {} }) };
  const views = new Map([['unit.p/notes', { spec: { title: 'Notes' }, render: () => null, rule: { mod: 'unit.p', id: 'notes' } }]]);
  const modPanels = { attach() {}, setViews() {}, settle() {}, restore() {}, launcherItems: (l) => l, view: (m, v) => views.get(`${m}/${v}`) ?? null, ModalView: () => null,
    propsOf: () => null, allows: () => true, openIn: () => false, closeIn: () => false };
  const p = startPresentation({ kernel: k, graph, bindings: [], modPanels, modName: () => 'Unit P' });
  assert.equal(p.openPanel('unit.p', 'notes', { placement: 'modal' }), true);
  assert.equal(p.openPanel('unit.p', 'notes', { placement: 'modal' }), true, 'already open: the same one');
  assert.equal(opened.length, 1);
  const [n, C] = opened[0];
  assert.equal(n, node);
  const drawn = C();
  assert.deepEqual([drawn.props.title, drawn.props.own, drawn.props.children.props.mod, drawn.props.children.props.view], ['Notes', false, 'unit.p', 'notes'], 'the framework\'s dialog, the mod\'s own content');
  assert.match(drawn.props.subtitle, /^From unit\.p/, 'whose it is, said by the framework: its id first');
  assert.equal(p.openPanel('unit.p', 'gone', { placement: 'modal' }), false, 'a view not here');
  assert.equal(p.closePanel('unit.p', 'notes'), true);
  assert.deepEqual(closed, [[node, C]]);
  // it goes with its registration (a rule change that removes or replaces its view), and with the page's runtime
  p.openPanel('unit.p', 'notes', { placement: 'modal' });
  views.set('unit.p/notes', { ...views.get('unit.p/notes'), rule: { mod: 'unit.p', id: 'notes', again: true } });
  p.rules.reset([]);
  assert.equal(closed.length, 2, 'registered again: closed');
  p.openPanel('unit.p', 'notes', { placement: 'modal' });
  p.dispose();
  assert.equal(closed.length, 3, 'the runtime went: closed');
});

test('public hooks (review H7j-l): a reorder sees its own mod\'s entries, nothing of another mod\'s', async () => {
  const s = setup();
  await tick(); await tick();
  const seen = [];
  s.p.rules.put(s.rule('unit.a', 'mine', 'decorate', { data: { badges: [{ id: 'b1', text: 'A-private' }] } }));
  s.p.rules.put(s.rule('unit.b', 'theirs', 'decorate', { order: 1, data: { badges: [{ id: 'b2', text: 'B-own' }] } }));
  s.p.rules.put(s.rule('unit.b', 'order', 'reorder', { slot: 'badges', order: 2, fns: { order: (items) => { seen.push(items); return [...items].reverse(); } } }));
  s.render();
  const given = seen.at(-1);
  assert.deepEqual(given.map((x) => x?.text ?? (x?.native ? 'native' : x)), ['B-own'], 'its own entry as it is; another mod\'s not even as being there');
});

/** A window with a Window instance, its projects, a kernel store as the preload's, and the page's style sheets (for `where` on styles). */
function styleWindow({ bindings = [], kernelBindings = [], types: moreTypes = [], insts: moreInsts = [] } = {}) {
  const { React } = createFakeReact();
  // a kernel store as the preload's: reads recorded while computing, touches tell who read them
  const listeners = new Set(), versions = new Map();
  let onMount = null;
  const store = { renderers: new Map(), onFault: null, reading: null, mounted: () => [], get onMount() { return onMount; }, set onMount(f) { onMount = f; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    bump() { for (const fn of [...listeners]) fn(); },
    touch(keys) { for (const k of keys) versions.set(k, (versions.get(k) ?? 0) + 1); for (const fn of [...listeners]) fn(); },
    read(k) { if (store.reading) store.reading.add(k); },
    snapshot(keys) { let n = 0; for (const k of keys ?? []) n += versions.get(k) ?? 0; return `0|${n}`; } };
  const WIN = { type: 'Window', provider: 'codexmods.windows', id: '4' };
  const P1 = { type: 'Project', provider: 'codex', id: 'p1' }, P2 = { type: 'Project', provider: 'codex', id: 'p2' };
  const insts = new Map([
    ['4', { ref: WIN, liveness: 'live', state: { current: null }, links: { thread: null, project: P1 } }],
    ['p1', { ref: P1, liveness: 'live', state: { name: 'Prod' }, links: {} }],
    ['p2', { ref: P2, liveness: 'live', state: { name: 'Play' }, links: {} }],
    ...moreInsts.map((x) => [x.ref.id, { liveness: 'live', links: {}, ...x }]),
  ]);
  const views = new Map();
  let seq = 1;
  const graph = {
    types: async () => [
      { id: 'Presentation', concept: 'Presentation', members: { relations: { window: {} } } },
      { id: 'Window', concept: 'Presentation', parent: 'Presentation', members: { relations: { thread: {}, project: {} } } },
      { id: 'Project', concept: 'Project', members: { relations: {} } },
      ...moreTypes,
    ],
    subscribe(query, fn) {
      const id = query.ref?.id;
      views.set(id, fn);
      queueMicrotask(() => fn({ type: 'snapshot', seq: seq++, items: insts.has(id) ? [insts.get(id)] : [] }));
      return { dispose() { views.delete(id); } };
    },
  };
  const change = (inst) => { insts.set(inst.ref.id, inst); views.get(inst.ref.id)?.({ type: 'delta', seq: seq++, event: { kind: 'changed', ref: inst.ref, instance: inst } }); };
  const tokens = { danger: '--color-text-danger' };
  const sheets = [], probes = { n: 0 };
  const p = startPresentation({ kernel: { kernel: { abi: 1, bindings: kernelBindings }, store, exports: { react: React } }, graph, bindings,
    instances: { window: async () => ({ gen: 1, windowId: 4 }), report: async () => {}, acted: async () => {} },
    tokens, cssVar: (v) => (v === '--codex-base-accent' ? 'x' : ''), styleSink: (css) => sheets.push(css), appValues: () => { probes.n++; return {}; } });
  return { p, store, insts, change, sheets, probes, WIN, P1, P2 };
}

test('a style\'s where is read on this window\'s Window (its chat, its project, as its mod may read them), and followed as they change', async () => {
  const { p, insts, change, sheets, P1, P2 } = styleWindow();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const prod = { mod: 'unit.a', id: 'prod', kind: 'style', realm: 'host', order: 1, reads: '*', where: { 'project.name': 'Prod' }, data: { variables: { '--codex-base-accent': 'danger' } } };
  p.rules.put(prod);
  await settle();
  assert.match(sheets.at(-1), /--codex-base-accent: var\(--color-text-danger\)/, 'this window shows a chat of Prod');
  // another project shown here: the style goes; back: it comes again
  change({ ...insts.get('4'), links: { thread: null, project: P2 } });
  await settle();
  assert.equal(sheets.at(-1), '');
  change({ ...insts.get('4'), links: { thread: null, project: P1 } });
  await settle();
  assert.match(sheets.at(-1), /--color-text-danger/);
  // the project renamed: followed too
  change({ ...insts.get('p1'), state: { name: 'Staging' } });
  await settle();
  assert.equal(sheets.at(-1), '');
  // a mod that may not read Projects: its where never holds through one
  p.rules.remove('unit.a/prod');
  p.rules.put({ ...prod, mod: 'unit.b', reads: ['Thread'], where: { 'project.name': 'Staging' } });
  await settle();
  assert.equal(sheets.at(-1), '', 'not read: not applied');
  p.rules.put({ ...prod, mod: 'unit.c', reads: '*', where: { 'project.name': 'Staging' } });
  await settle();
  assert.match(sheets.at(-1), /--color-text-danger/);
  p.dispose();
});

test('H7w review: a where reads the refs in the Window\'s own state only where its mod may; what it reads stays observed; nothing is restyled while the styles that hold are the same', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // a binding that reads more subjects than a window keeps observed for its bindings
  const many = defineBinding({ id: 'many', presentation: 'SidebarItem', presents: ['Thread'], subject: () => null,
    render(Original, props, factory, ctx) { for (let i = 0; i < 520; i++) ctx.subject({ type: 'Project', provider: 'codex', id: `other-${i}` }); return undefined; } });
  const { p, store, insts, change, sheets, probes, P2 } = styleWindow({ bindings: [many], kernelBindings: ['many'] });
  const SECRET = { type: 'Thread', provider: 'codex', id: 'secret' };
  change({ ...insts.get('4'), state: { current: SECRET, history: [SECRET] } });
  const style = { kind: 'style', realm: 'host', order: 1, data: { variables: { '--codex-base-accent': 'danger' } } };
  p.rules.put({ ...style, mod: 'unit.a', id: 'peek', reads: ['Presentation', 'Project'], where: { 'current.id': 'secret' } });
  await settle();
  assert.equal(sheets.at(-1) ?? '', '', 'a chat its mod may not read: not told it is shown');
  p.rules.remove('unit.a/peek');
  p.rules.put({ ...style, mod: 'unit.b', id: 'prod', reads: '*', where: { 'project.name': 'Prod' } });
  await settle();
  assert.match(sheets.at(-1), /--color-text-danger/);
  // another field of the project changes: the same styles hold, the sheet is not written again
  const [n, probed] = [sheets.length, probes.n];
  change({ ...insts.get('p1'), state: { name: 'Prod', description: 'the live one' } });
  await settle();
  assert.deepEqual([sheets.length, probes.n], [n, probed], 'nothing restyled: the page\'s values not probed again');
  // the bindings read many other subjects; the Window's project changes after: still followed
  store.renderers.get('many')('Row', {}, (T, q) => ({ T, q }), {}, null);
  await settle();
  change({ ...insts.get('4'), links: { thread: null, project: P2 } });
  await settle();
  assert.equal(sheets.at(-1), '', 'still observed: the style went');
  p.dispose();
});

test('public hooks §3.14: a panel view in a split is a tab of the right panel with the window\'s layout split; one filling the workspace, full', async () => {
  const { React } = createFakeReact();
  let onMount = null;
  // the page's route scope (a mounted binding's), over which the tab opens and the layout is set (layouts WL1-3 review: a home page has no chat)
  const laid = [];
  let active = { tabType: {} };
  const node = { get: (a) => (a === 'activeTab$' ? active : null), set() {} };
  const workspaceLayout = { setFull: (n, full) => laid.push(['full', full]), setPanel: (n, open) => laid.push(['panel', open]), activeTab: 'activeTab$' };
  const store = { renderers: new Map(), onFault: null, bump() {}, mounted: () => [{ binding: 'side.panel.frame', scopeNode: node }], get onMount() { return onMount; }, set onMount(f) { onMount = f; } };
  const into = [], placed = [];
  const graph = { types: async () => [], subscribe: () => ({ dispose() {} }) };
  const views = new Map([['unit.p/notes', { spec: { title: 'Notes', targets: ['bottom', 'right'] }, render: () => null, rule: { mod: 'unit.p', id: 'notes' } }]]);
  const modPanels = { attach() {}, setViews() {}, settle() {}, restore() {}, launcherItems: (l) => l, view: (m, v) => views.get(`${m}/${v}`) ?? null, ModalView: () => null,
    propsOf: (m, v) => (views.has(`${m}/${v}`) ? { mod: m, view: v } : null), allows: (v, t) => allowed.includes(t), openIn: (scope, props, opts) => { into.push([scope, opts]); placed.push(props); return true; }, closeIn: () => false };
  let allowed = ['right', 'bottom'];
  const p = startPresentation({ kernel: { kernel: { abi: 1, bindings: [] }, store, exports: { react: React, workspaceLayout } }, graph, bindings: [], modPanels,
    instances: { window: async () => ({ gen: 1, windowId: 6 }), report: async () => {}, acted: async () => {} } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await p.openPanel('unit.p', 'notes', { placement: 'side', focus: false }), { ok: true }, 'answered once its layout is set');
  assert.deepEqual(await p.openPanel('unit.p', 'notes', { placement: 'full' }), { ok: true });
  assert.equal(p.openPanel('unit.p', 'notes', {}), true);
  assert.deepEqual(into.map(([sc, o]) => [sc === node, o]), [[true, { target: 'right', revealAndFocus: true }], [true, { target: 'right', revealAndFocus: true }], [true, { target: 'bottom', revealAndFocus: true }]],
    'a split or a full view: the right panel, shown; a tab: the view\'s own first panel');
  assert.deepEqual(laid, [['panel', true], ['full', false], ['panel', true], ['full', true]], 'its layout through the app\'s guarded setters, in this page');
  assert.deepEqual(placed.map((x) => x.persist), [undefined, false, undefined], 'a view filling its own window is not one the home pages remember');
  // the tab open, its layout not set (its kind does not fill the workspace): failed (not a refusal: it is there)
  active = { tabType: { allowFullWidth: false } };
  assert.match((await p.openPanel('unit.p', 'notes', { placement: 'full' })).failed, /the view is open, but its layout was not set: the tab it shows does not fill the workspace/);
  // a panel the view does not allow here (as this window registered it): refused for good, not as a moment's absence
  allowed = ['bottom'];
  assert.deepEqual(p.openPanel('unit.p', 'notes', { placement: 'full' }), { refused: 'invalid', message: 'this view does not open in the right panel' });
  p.dispose();
});

test('H7w review 2: a Window reached through a relation is masked as this one is; a ref in it is read by the type it is known as now', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const SECRET = { type: 'Thread', provider: 'codex', id: 'secret' };
  const PEER = { type: 'Window', provider: 'codexmods.windows', id: '8' };
  const { p, insts, change, sheets } = styleWindow({
    types: [{ id: 'PeerProject', concept: 'Project', parent: 'Project', members: { relations: { peer: {} } } }, { id: 'Thread', concept: 'Thread', members: { relations: {} } },
      { id: 'CodexThread', concept: 'Thread', parent: 'Thread', members: { relations: {} } }],
    insts: [{ ref: PEER, state: { current: SECRET, history: [] } }, { ref: { type: 'CodexThread', provider: 'codex', id: 'secret' }, state: { title: 'Secret' } }],
  });
  // this window shows a project of a subtype that relates another Window, which shows a chat the mod may not read
  change({ ...insts.get('p1'), ref: { type: 'PeerProject', provider: 'codex', id: 'p1' }, links: { peer: PEER } });
  const style = { kind: 'style', realm: 'host', order: 1, data: { variables: { '--codex-base-accent': 'danger' } } };
  p.rules.put({ ...style, mod: 'unit.a', id: 'peek', reads: ['Presentation', 'Project'], where: { 'project.peer.current.id': 'secret' } });
  await settle();
  assert.equal(sheets.at(-1) ?? '', '', 'not told through the relation either');
  p.rules.remove('unit.a/peek');
  // a mod that may read the chat by the type it is known as now (CodexThread), though the Window names it as a Thread
  change({ ...insts.get('4'), state: { current: SECRET, history: [] } });
  p.rules.put({ ...style, mod: 'unit.b', id: 'sees', reads: ['Presentation', 'CodexThread'], where: { 'current.id': 'secret' } });
  await settle();
  assert.match(sheets.at(-1), /--color-text-danger/);
  p.dispose();
});

test('review 2026-11-05 #4: a mod\'s component gets its subject as that mod may see it: its own attached values and the shared ones, never another mod\'s private ones', async () => {
  const { React } = createFakeReact();
  const store = { renderers: new Map(), onFault: null, bump() {} };
  const k = { kernel: { abi: 1, bindings: ['row'] }, store, exports: { react: React } };
  const subjectItem = { ...thread('First'), attached: { 'unit.a': { mine: 1 }, 'unit.b': { secret: 2, open: 3 } }, attachedPrivate: ['unit.b/secret'] };
  const graph = {
    types: async () => [{ id: 'Thread', concept: 'Thread' }, { id: 'TestAgentThread', concept: 'Thread', parent: 'Thread' }],
    subscribe(query, fn) { queueMicrotask(() => fn({ type: 'snapshot', seq: 1, items: [subjectItem] })); return { dispose() {} }; },
  };
  const row = defineBinding({ id: 'row', presentation: 'SidebarItem', presents: ['Thread'], subject: () => REF, slots: { header: nodeRegion('header') } });
  const p = startPresentation({ kernel: k, graph, bindings: [row] });
  const render = (props = {}) => store.renderers.get('row')('Row', props, (type, pr) => ({ type, props: pr }));
  await tick(); await tick();
  const Replacement = (props) => props;
  p.rules.put({ mod: 'unit.a', id: 'mine', kind: 'replace', presentation: 'SidebarItem', realm: 'renderer', order: 10, fns: { render: Replacement } });
  render(); await tick(); await tick();
  const inner = render().props.children;
  assert.deepEqual(inner.props.subject.attached, { 'unit.a': { mine: 1 }, 'unit.b': { open: 3 } });
  assert.equal(inner.props.subject.attachedPrivate, undefined);
});
