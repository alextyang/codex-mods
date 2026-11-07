// The recovery entry (docs/design/systems.md S22, E6.1): over the management port alone, shown unless the window's Mods pages run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from '../../test/fake-react.mjs';
import { createPagesStatus, PAGE_PARTS } from '../../pages-status.mjs';
import definition, { activate, createRecovery, ACTIVITY, SETTLE_MS, outcomeText } from '../index.mjs';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const op = (o) => ({ id: `op-${o.n}`, input: { type: 'enable', modId: 'acme.demo' }, outcome: 'succeeded', startedAt: `2026-10-28T00:00:0${o.n}Z`, ...o });

function management(handlers = {}) {
  const calls = [];
  const listeners = new Set();
  const all = {
    diagnostics: { host: { safeMode: false } },
    'updates.status': { lkg: { n: 4, appBuild: '26.1016', frameworkVersion: '1.0.0' } },
    'ops.list': { ops: [] },
    'events.subscribe': { subscribed: true },
    ...handlers,
  };
  return {
    calls, callsTo: (m) => calls.filter((c) => c.method === m),
    async call(method, params) {
      calls.push({ method, params });
      const h = all[method];
      if (h === undefined) throw { code: 'Invalid', message: `no handler for ${method}` };
      return typeof h === 'function' ? h(params) : h;
    },
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    emit(e) { for (const fn of [...listeners]) fn(e); },
    get listeners() { return listeners.size; },
  };
}

function setup({ handlers, pages, withPages = true } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const Section = ({ children }) => React.createElement('section', null, children);
  Section.Header = ({ title }) => React.createElement('h2', null, title);
  Section.Content = ({ children }) => React.createElement('div', null, children);
  const components = { Button: 'Button', Switch: 'Switch', SettingsSection: Section, SettingsRow: ({ label, description, control }) => React.createElement('row', null, label, ' — ', description ?? '', control ?? null) };
  const m = management(handlers);
  const timers = [];
  const status = pages ?? createPagesStatus({ schedule: () => {} });
  const rec = createRecovery({ ui: { react: React, components }, management: m, ...(withPages ? { pages: status } : {}),
    schedule: (fn) => Promise.resolve().then(fn), later: (fn) => { timers.push(fn); return () => {}; } });
  const root = ReactDOM.createRoot({});
  const show = () => { root.render(React.createElement(rec.Root)); return root; };
  return { React, rec, m, status, timers, root, show, text: () => rootText(root), settle: () => { for (const t of timers.splice(0)) t(); } };
}
const buttons = (root) => root.trees().flatMap((t) => findAll(t, (n) => n.type === 'Button'));
const button = (root, label) => buttons(root).find((b) => b.props['aria-label'] === label);
const shown = (root) => root.trees().some((t) => findAll(t, (n) => n.props?.['data-codexmods-recovery'] === 'true').length > 0);

test('shown at once when the window\'s Mods pages failed, never while they run, and for missing pages only after they had time to report', async () => {
  const t = setup();
  t.show();
  assert.equal(shown(t.root), false, 'starting: nothing yet');
  t.status.failed('a fault');
  assert.equal(shown(t.root), true, 'failed: at once');
  assert.ok(t.root.trees().some((tr) => findAll(tr, (n) => n.props?.['data-codexmods-framework'] === '').length > 0), 'a framework root (E6.4b)');

  const u = setup({ pages: createPagesStatus({ schedule: (fn) => fn() }) });   // the grace already over: missing
  assert.equal(u.status.get(), 'missing');
  u.show();
  assert.equal(shown(u.root), false, 'missing, but the navigation may report in the same commit: it waits');
  u.settle();
  assert.equal(shown(u.root), true);
  for (const p of PAGE_PARTS) u.status.mounted(p);
  assert.equal(shown(u.root), false, 'the pages run: it goes');

  const v = setup({ pages: createPagesStatus({ schedule: (fn) => fn() }) });
  for (const p of PAGE_PARTS) v.status.mounted(p);
  v.show(); v.settle();
  assert.equal(shown(v.root), false, 'running: never shown');

  const w = setup({ withPages: false });
  w.show(); w.settle();
  assert.equal(shown(w.root), true, 'a window with no report shows it');
});

test('it reads safe mode, last-known-good and the operations; needs attention lists the unacknowledged ones, each acknowledged here', async () => {
  const ops = [
    op({ n: 1, outcome: 'needs-attention', note: 'sent requests before reverting', input: { type: 'update', modId: 'acme.demo' } }),
    op({ n: 2, outcome: 'needs-attention', note: 'seen already', acknowledgedAt: '2026-10-28T01:00:00Z' }),
    op({ n: 3, outcome: 'failed', error: { message: 'no space' }, input: { type: 'install' } }),
    op({ n: 4, outcome: 'succeeded', input: { type: 'safe-mode', enter: false } }),
  ];
  let acked = null;
  const t = setup({ handlers: { 'ops.list': { ops }, 'ops.acknowledge': (p) => { acked = p.opId; ops[0] = { ...ops[0], acknowledgedAt: 'now' }; return { op: ops[0] }; } } });
  t.status.failed('x');
  t.show();
  await flush();
  const text = t.text();
  assert.match(text, /Mods recovery/);
  assert.match(text, /Generation 4: ChatGPT 26\.1016, framework 1\.0\.0/);
  assert.match(text, /Update · acme\.demo — sent requests before reverting/);
  assert.doesNotMatch(text, /seen already —/, 'an acknowledged operation no longer needs attention');
  assert.match(text, /Install failed: no space/);
  assert.match(text, /Safe mode off: done/);
  assert.ok(text.indexOf('Safe mode off: done') < text.indexOf('Install failed'), 'the newest first');
  await button(t.root, 'Acknowledge').props.onClick();
  await flush();
  assert.equal(acked, 'op-1');
  assert.deepEqual(t.m.callsTo('ops.acknowledge')[0].params, { opId: 'op-1' });
  assert.match(t.text(), /Nothing needs attention/);
});

test('safe mode and last-known-good run their operations, each after a confirmation; a running operation never holds them (the way out)', async () => {
  let ops = [];
  const t = setup({ handlers: { 'ops.list': () => ({ ops }), 'recovery.safeMode': { opId: 'op-9' }, 'recovery.lkg': { opId: 'op-10' } } });
  t.status.failed('x');
  t.show();
  await flush();
  const sw = () => t.root.trees().flatMap((tr) => findAll(tr, (n) => n.type === 'Switch'))[0];
  assert.equal(sw().props.checked, false);
  await sw().props.onChange(true);
  assert.equal(t.m.callsTo('recovery.safeMode').length, 0, 'it asks first (E6 review)');
  assert.match(t.text(), /Turn on safe mode\? ChatGPT restarts without any mod/);
  const confirm = t.root.trees().flatMap((tr) => findAll(tr, (n) => n.props?.role === 'alertdialog'))[0];
  assert.equal(confirm.props['aria-labelledby'], 'codexmods-recovery-safe-q', 'named by its question');
  await button(t.root, 'Turn on and restart').props.onClick();
  assert.deepEqual(t.m.callsTo('recovery.safeMode')[0].params, { enter: true });
  ops = [op({ n: 9, outcome: 'running', input: { type: 'safe-mode', enter: true } })];
  t.m.emit({ event: 'op', data: ops[0] });
  await flush();
  assert.equal(sw().props.disabled, false, 'an operation runs: safe mode is still the way out; the Host says when it cannot');
  assert.equal(button(t.root, 'Restore last-known-good…').props.disabled, false);
  ops = [op({ n: 9, outcome: 'succeeded', input: { type: 'safe-mode', enter: true } })];
  t.m.emit({ event: 'op', data: ops[0] });
  await flush();
  await button(t.root, 'Restore last-known-good…').props.onClick();
  assert.equal(t.m.callsTo('recovery.lkg').length, 0, 'it asks first');
  await button(t.root, 'Restore').props.onClick();
  assert.deepEqual(t.m.callsTo('recovery.lkg')[0].params, {});
});

test('one read that fails does not hide the others; a refused operation says why', async () => {
  const t = setup({ handlers: { diagnostics: () => { throw { code: 'Unavailable', message: 'the Host is restarting' }; }, 'recovery.lkg': () => { throw { code: 'Busy', message: 'an operation runs' }; } } });
  t.status.failed('x');
  t.show();
  await flush();
  assert.match(t.text(), /the Host is restarting/);
  assert.match(t.text(), /Generation 4/);
  await button(t.root, 'Restore last-known-good…').props.onClick();
  await button(t.root, 'Restore').props.onClick();
  await flush();
  assert.match(t.text(), /an operation runs/);
  assert.equal(outcomeText({ input: { type: 'lkg-restore' }, outcome: 'running' }), 'Restore last-known-good…');
  assert.equal(ACTIVITY, 8);
  assert.ok(SETTLE_MS > 0);
});

test('activate mounts it at the top of Settings › General over the management port, and disposes cleanly', async () => {
  const { React } = createFakeReact();
  const mounts = [];
  const m = management();
  const mountSettings = (component, opts) => { const x = { component, opts, disposed: false }; mounts.push(x); return { dispose() { x.disposed = true; }, degraded: false }; };
  const handle = activate({ ui: { react: React, components: {} }, management: m, mountSettings });
  await flush();
  assert.deepEqual(mounts.map((x) => x.opts.position), ['prepend']);
  assert.equal(m.listeners, 1);
  assert.deepEqual(m.callsTo('events.subscribe').length, 1);
  await handle.dispose();
  assert.equal(mounts[0].disposed, true);
  assert.equal(m.listeners, 0);
  assert.equal(definition.renderer, activate);
});
