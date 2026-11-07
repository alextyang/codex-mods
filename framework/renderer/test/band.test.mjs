// The band (docs/design/systems.md E6 decision 4, E6.4; docs/design/framework-ui.md F15, F16): one line for what needs you, one source as itself and
// several by how many of each; Open goes to its place; Dismiss where the state allows; nothing when all is well; a mod stopping toasts in the window in front.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createBand, bannersOf, lineOf } from '../present/band.mjs';

const P = 'codexmods.framework';
const FW = Object.freeze({ type: 'CodexMods', provider: P, id: 'codexmods' });
const COPY = Object.freeze({ type: 'CopyUpdate', provider: P, id: 'copy' });
const modRef = (id) => ({ type: 'Mod', provider: P, id });
const opRef = (id) => ({ type: 'Operation', provider: P, id });

function setup({ mods = {}, ops = [], fw = {}, update = null, invoke, focused = true } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const toasts = [];
  const exports = { Button: ({ children, onClick, disabled }) => React.createElement('button', { onClick, disabled }, children),
    toast: { get: () => ({ warning: (title, opts) => { toasts.push([title, opts]); return { close() {} }; } }) } };
  const subjects = new Map();
  const put = (ref, snap) => subjects.set(`${ref.type}:${ref.id}`, { ref, ...snap });
  const putAll = () => {
    put(FW, { state: { version: '1.0.0', safeMode: false, ...fw.state }, links: { mods: Object.keys(mods).map(modRef), operations: ops.map((o) => opRef(o.id)), ...(update ? { update: COPY } : {}) } });
    if (update) put(COPY, { state: { version: '26.1017', state: 'ready', held: false, dismissed: false, ...update } });
    for (const [id, state] of Object.entries(mods)) put(modRef(id), { state: { name: id, status: 'enabled', ...state } });
    for (const o of ops) put(opRef(o.id), { state: { kind: 'update', outcome: 'needsAttention', ...o.state }, links: o.mod ? { mod: modRef(o.mod) } : {} });
  };
  putAll();
  const reported = new Set();
  const ctx = { use: (fn) => fn(), subject: (ref) => subjects.get(`${ref.type}:${ref.id}`), report: { put: (rec) => reported.add(rec), remove: (rec) => reported.delete(rec) } };
  const calls = [], opened = [];
  const band = createBand({ R: React, ctx, exports: () => exports, frameworkRef: FW, open: (t) => opened.push(t), focused: () => focused,
    invoke: async (ref, op, args) => { calls.push([ref.type, ref.id, op, args]); return invoke ? invoke(ref, op, args) : { status: 'done' }; } });
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(band.Band));
  const all = (pred) => root.trees().flatMap((t) => findAll(t, pred));
  const textOf = (n) => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''));
  const lines = () => all((n) => n.props?.role === 'status').map(textOf);
  const buttonsOf = (i) => findAll(all((n) => n.props?.role === 'status')[i], (n) => n.type === 'button');
  const setMod = (id, state) => { mods[id] = { ...mods[id], ...state }; putAll(); root.render(React.createElement(band.Band)); };
  return { root, text: () => rootText(root), lines, buttonsOf, calls, opened, all, toasts, setMod, reported: () => [...reported].map((r) => [r.binding, r.props.subject.type, r.props.place.slot]) };
}

test('nothing shows when all is well: it is not a status bar; an update ready waits on its page, a stop looked at is on its page', () => {
  const t = setup({ mods: { 'a.one': {} }, update: { state: 'available' } });
  assert.equal(t.text(), '');
  assert.equal(setup({ update: { held: true, dismissed: true } }).text(), '', 'an update put off with Later');
  assert.equal(setup({ update: { state: 'ready', held: false } }).text(), '', 'a ready update is on the Update page (its nav row says Ready)');
  assert.equal(setup({ ops: [{ id: 'op-1', state: { acknowledgedAt: 5 } }] }).text(), '', 'an acknowledged operation');
  assert.equal(setup({ mods: { 'a.one': { status: 'quarantined', stopSeen: true } } }).text(), '', 'a stop you looked at');
});

test('F15: one line: one source as itself; several by how many of each, Open to the most severe\'s place; each source reported', () => {
  const t = setup({
    mods: { 'a.one': { name: 'One', status: 'quarantined', quarantine: { reason: 'unresponsive' }, stopSeen: false }, 'b.two': { name: 'Two', status: 'quarantined' } },
    ops: [{ id: 'op-1', mod: 'a.one', state: { message: 'it sent requests before reverting' } }],
    fw: { state: { safeMode: true } }, update: { held: true },
  });
  assert.deepEqual(t.lines(), ['One operation needs your attention, 2 mods stopped, safe mode is on and an update is held.Open']);
  t.buttonsOf(0)[0].props.onClick();
  assert.deepEqual(t.opened, [{ mod: 'a.one', tab: 'activity' }], 'the most severe\'s place');
  assert.deepEqual(t.reported(), [['framework:NotificationBanner', 'Operation', 'banner'], ['framework:NotificationBanner', 'Mod', 'banner'], ['framework:NotificationBanner', 'Mod', 'banner'],
    ['framework:NotificationBanner', 'CodexMods', 'banner'], ['framework:NotificationBanner', 'CopyUpdate', 'banner']], 'each source is a NotificationBanner of the window (E6.5)');
  const region = t.all((n) => n.props?.['data-codexmods-band'] !== undefined)[0];
  assert.equal(region.props.role, 'region');
  assert.equal(region.props['data-codexmods-framework'], '', 'a framework root: no mod restyles it');
  assert.doesNotMatch(String(region.props.className), /#|rgb|px/, 'theme classes only');
  const stopped = setup({ mods: { 'a.one': { status: 'quarantined' }, 'b.two': { status: 'quarantined' }, 'c.three': { status: 'quarantined' } } });
  assert.deepEqual(stopped.lines(), ['3 mods stopped.Open']);
  stopped.buttonsOf(0)[0].props.onClick();
  assert.deepEqual(stopped.opened, [{ overview: true }], 'mods: the list');
  assert.equal(lineOf([]), null);
});

test('Open goes to its place; Dismiss acknowledges the operation or puts a held update off; a refusal is said on its line', async () => {
  const t = setup({ ops: [{ id: 'op-1' }], invoke: () => ({ status: 'refused', message: 'not now' }) });
  t.buttonsOf(0)[0].props.onClick();
  assert.deepEqual(t.opened, [{ developer: true }], 'an operation of no installed mod is on Developer');
  const own = setup({ mods: { 'a.one': { name: 'One' } }, ops: [{ id: 'op-2', mod: 'a.one' }] });
  own.buttonsOf(0)[0].props.onClick();
  assert.deepEqual(own.opened, [{ mod: 'a.one', tab: 'activity' }], 'a mod\'s is on its Activity');
  await t.buttonsOf(0)[1].props.onClick();
  assert.deepEqual(t.calls, [['Operation', 'op-1', 'acknowledge', []]]);
  assert.match(t.lines()[0], /not now/);
  const m = setup({ mods: { 'a.one': { name: 'One', status: 'quarantined', quarantine: { reason: 'unresponsive' } } } });
  assert.deepEqual(m.lines(), ['One was turned off after faults: unresponsiveOpen']);
  m.buttonsOf(0)[0].props.onClick();
  assert.deepEqual(m.opened, [{ mod: 'a.one' }]);
  const u = setup({ update: { version: '26.1017 with framework 1.0.1', held: true } });
  assert.deepEqual(u.lines(), ['An update is held: 26.1017 with framework 1.0.1. Some mods may not work on it.OpenDismiss']);
  u.buttonsOf(0)[0].props.onClick();
  await u.buttonsOf(0)[1].props.onClick();
  assert.deepEqual(u.opened, [{ update: true }]);
  assert.deepEqual(u.calls, [['CopyUpdate', 'copy', 'later', []]]);
});

test('F16: a mod that stops while the window is shown toasts there when it is in front, with Open; one stopped before only shows in the line', () => {
  const t = setup({ mods: { 'a.one': { name: 'One' }, 'b.two': { name: 'Two', status: 'quarantined', quarantine: { at: 1 } } } });
  assert.deepEqual(t.toasts, [], 'stopped before: not toasted');
  t.setMod('a.one', { status: 'quarantined', quarantine: { reason: 'unresponsive', at: 5 } });
  assert.deepEqual(t.toasts.map(([title, o]) => [title, o.description, o.id, o.primaryAction.label]), [['One stopped', 'It was turned off after faults: unresponsive', 'codexmods:framework:stopped:a.one', 'Open']]);
  t.toasts[0][1].primaryAction.onClick();
  assert.deepEqual(t.opened, [{ mod: 'a.one' }]);
  t.setMod('a.one', { name: 'One' });
  assert.equal(t.toasts.length, 1, 'once');
  const back = setup({ mods: { 'a.one': { name: 'One' } }, focused: false });
  back.setMod('a.one', { status: 'quarantined', quarantine: { at: 7 } });
  assert.deepEqual(back.toasts, [], 'a window behind does not toast');
});

test('bannersOf reads the framework\'s state alone', () => {
  const data = { fw: { state: { safeMode: false } }, mods: [], ops: [], update: { ref: COPY, state: { state: 'downloading' } } };
  assert.deepEqual(bannersOf(data, (x) => x), [], 'an update being prepared is not yet yours to act on');
});
