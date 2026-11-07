// ui.status (docs/design/public-hooks.md §3.14): how a status is drawn, where each place puts it, what it reads (its place's subject or
// the one it names, as its mod may read it). The client and the Host: framework/host/test/ui-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { statusNode, actionNode, SIBLINGS } from '../present/bindings/slots.mjs';
import { valueOf, covers } from '../present/rules.mjs';

const { React: R } = createFakeReact();
const ctx = ({ exports, ...o } = {}) => ({ token: (n) => `var(--${n})`, exports: () => exports ?? {}, react: () => R, ...o });
const entry = (item, id = 's') => ({ rule: { mod: 'unit.s', id }, item: { id, ...item } });
const kids = (el) => [].concat(el.props.children ?? []).filter(Boolean);

test('a status is drawn the app\'s way: text in its tone\'s theme color, a meter ring, a button when it runs; nothing when empty', () => {
  const span = statusNode(R, ctx(), { text: 'Synced', tone: 'success', tooltip: 'All pushed' }, 'k');
  assert.deepEqual([span.type, span.props.role, span.props.title, span.props.style.color, span.key], ['span', 'status', 'All pushed', 'var(--success)', 'k']);
  assert.equal(kids(span).at(-1).props.children, 'Synced');
  assert.equal(statusNode(R, ctx(), { text: 'x' }, 'k').props.style.color, 'var(--textSecondary)', 'neutral: the secondary text');
  const metered = statusNode(R, ctx(), { meter: { value: '30', max: 120 } }, 'k');
  const ring = kids(metered)[0];
  assert.equal(ring.type, 'svg');
  const fill = kids(ring)[1];
  assert.match(fill.props.strokeDasharray, /^9\.42\d* 37\.69/, 'a quarter of the ring (live values arrive as text)');
  assert.equal(fill.props.stroke, 'currentColor', 'in the status\'s own color');
  let ran = 0;
  const Button = function CodexButton() {};
  const button = statusNode(R, ctx({ exports: { CodexButton: Button } }), { text: '3 open', run: () => ran++ }, 'k');
  assert.deepEqual([button.type, button.props.color, button.props.size, button.props['aria-label']], [Button, 'ghost', 'toolbar', '3 open']);
  button.props.onClick();
  assert.equal(ran, 1);
  assert.equal(statusNode(R, ctx(), { text: '' }, 'k'), null, 'live text that came out empty: no gap');
  assert.equal(statusNode(R, ctx(), { meter: { value: 'n/a' } }, 'k'), null);
});

test('the four places: the window\'s title bar, a chat\'s (its page\'s title bar), the sidebar\'s footer, a composer\'s footer', async () => {
  const { windowTitleBar, sidebarFooter } = await import('../present/bindings/frame.mjs');
  const { threadView } = await import('../present/bindings/thread-view.mjs');
  const { composer } = await import('../present/bindings/composer.mjs');
  const HeaderAction = function HeaderAction() {};
  const c = ctx({ exports: { appShell: { HeaderAction } }, mountsOf: () => [] });
  const env = { R, ctx: c };
  const factory = (type, props) => ({ type, props });
  // the window's: a HeaderAction in the right slot, with the mods' actions there
  const w = windowTitleBar.slots.status.apply({}, [entry({ text: 'A' }, 'a'), entry({ text: '' }, 'empty')], env);
  const out = windowTitleBar.render('Bar', w, factory, c, null);
  const [bar, ...actions] = kids(out);
  assert.equal(bar.type, 'Bar');
  assert.deepEqual(actions.map((a) => [a.type, a.props.slotPosition, a.props.desktopPlacement]), [[HeaderAction, 'right', 'titlebar']], 'one shown: the empty one draws nothing');
  // a chat's: in the right slot too, before the app's panel toggles (200 on), the page element first and unkeyed
  const tv = threadView.twins[0].slots.status.apply({ conversationId: 't1' }, [entry({ text: 'B' })], env);
  const page = threadView.render('Page', tv, factory, c);
  const [el, status] = kids(page);
  assert.deepEqual([el.type, '__codexmodsStatus' in el.props], ['Page', false], 'never passed to the app');
  assert.deepEqual([status.props.slotPosition, status.props.order < 200, status.props.desktopPlacement], ['right', true, 'titlebar']);
  // the sidebar's footer: one row beside it
  const f = sidebarFooter.twins[0].slots.status.apply({}, [entry({ text: 'C' }, 'c'), entry({ text: 'D' }, 'd')], env);
  assert.equal(f[SIBLINGS].length, 1);
  assert.equal(f[SIBLINGS][0].props['data-codexmods'], 'sidebar-status');
  assert.equal(kids(f[SIBLINGS][0]).length, 2);
  // a composer's: in its footer's inline controls, after the app's own (budget: three)
  const p = composer.slots.status.apply({ hotkeyWindowHomeFooterControls: 'app' }, [entry({ text: 'E' })], env);
  assert.equal(p.hotkeyWindowHomeFooterControls.type, R.Fragment);
  assert.equal(composer.slots.status.budget, 3);
});

test('what a status reads: its place\'s subject, or the one it names, and only as its mod may read it', () => {
  const usage = { ref: { type: 'Usage', provider: 'unit.s', id: 'u' }, state: { spent: 12 } };
  const app = { ref: { type: 'App', provider: 'codex', id: 'codex' }, state: { version: '26.1' } };
  const reads = new Set(['App']);
  const env = { may: (x) => x.ref.provider === 'unit.s' || reads.has(x.ref.type), resolve: (ref) => (ref.id === 'u' ? usage : undefined) };
  const rules = { env: () => env, guard: (r, fn) => fn };
  const rule = (data) => ({ mod: 'unit.s', data });
  assert.deepEqual(valueOf(rules, rule({ items: [{ text: 'v{{version}}' }] }), 'items', app), [{ text: 'v26.1' }], 'its place\'s subject');
  assert.deepEqual(valueOf(rules, rule({ items: [{ text: '{{spent}} spent' }], subject: usage.ref }), 'items', app), [{ text: '12 spent' }], 'the one it names');
  assert.deepEqual(valueOf(rules, rule({ items: [{ text: '[{{spent}}]' }], subject: { type: 'Usage', provider: 'x', id: 'gone' } }), 'items', app), [{ text: '[]' }], 'not here (yet): empty');
  reads.delete('App');
  assert.deepEqual(valueOf(rules, rule({ items: [{ text: 'v{{version}}' }] }), 'items', app), [{ text: 'v' }], 'a subject its mod may not read reads as nothing');
  // a where reads the subject too
  const w = { mod: 'unit.s', where: { version: '26.1' } };
  assert.equal(covers(w, app, (t) => [t], () => env), false);
  reads.add('App');
  assert.equal(covers(w, app, (t) => [t], () => env), true);
});

test('a composer control drawn the app\'s way with its tooltip, off or pressed, and a badge in the secondary text (public-hooks.md §3.14)', () => {
  const Button = function CodexButton() {};
  let ran = 0;
  const c = ctx({ exports: { CodexButton: Button } });
  const on = actionNode(R, c, { title: 'Watch', tooltip: 'Watch this chat', pressed: true, badge: 3, run: () => ran++ }, 'k');
  assert.deepEqual([on.type, on.props.title, on.props['aria-pressed'], on.props.disabled], [Button, 'Watch this chat', true, undefined]);
  const [label, gap, badge] = [].concat(on.props.children);
  assert.deepEqual([label, gap, badge.props.children, badge.props.style.color], ['Watch', ' ', '3', 'var(--textSecondary)']);
  on.props.onClick();
  const off = actionNode(R, c, { title: 'Watch', disabled: true, run: () => ran++ }, 'k');
  assert.deepEqual([off.props.disabled, off.props.onClick, ran], [true, undefined, 1], 'off: it does not run');
});
