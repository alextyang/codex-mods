// What the tests of the framework's pages share: the app's settings parts as plain elements, the framework's graph as a map of subjects, and the page's kit and Dialogs on them.
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createDialogs } from '../present/dialogs.mjs';
import { createKit } from '../present/kit/index.mjs';
import { createPageCommon } from '../present/mods-common.mjs';

export const P = 'codexmods.framework';
export const FW = Object.freeze({ type: 'CodexMods', provider: P, id: 'codexmods' });
export const COPY = Object.freeze({ type: 'CopyUpdate', provider: P, id: 'copy' });
export const APP = Object.freeze({ type: 'App', provider: 'codex', id: 'app' });
export const modRef = (id) => ({ type: 'Mod', provider: P, id });
export const opRef = (id) => ({ type: 'Operation', provider: P, id });
export const at = (iso) => Date.parse(iso);
export const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
/** What the Host's projection says of a mod's facts (the framework provider's modStateOf, tested there). */
export const stateOf = (s) => (s.reloading ? 'reloading' : s.status === 'pendingConsent' || s.consentRequest ? 'consent' : s.problem ? 'missing' : s.compatibility === 'blocked' ? 'incompatible'
  : s.status === 'quarantined' ? 'stopped' : s.status === 'enabled' ? 'on' : 'off');
export const textOf = (n) => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''));

/** @returns the fixture, and `mount(element)`: the page drawn, with what its tests look for */
export function pagesFixture({ mods = {}, order = Object.keys(mods), ops = [], fw = {}, update = null, threads = [], invoke, pickFile = async () => null, noFramework = false, appDialog = true, app = null } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const h = (tag) => ({ children, ...p }) => e(tag, p, children);
  const Section = Object.assign(h('section'), { Header: ({ title, subtitle, actions }) => e('h2', null, title, subtitle ? ` / ${subtitle}` : '', actions ?? null), Content: h('div') });
  const exports = {
    SettingsPageFrame: ({ title, action, backSlot, children }) => e('main', null, backSlot ?? null, title ? e('h1', null, title) : null, action ?? null, children),
    SettingsSection: Section, SettingsCard: h('ul'),
    SettingsRow: ({ label, description, control }) => e('li', { 'data-row': label }, label, ' | ', description ?? '', ' | ', control ?? null),
    Button: ({ children, onClick, disabled, color, ...rest }) => e('button', { onClick, disabled, color, 'aria-label': rest['aria-label'] }, children),
    Switch: ({ checked, onChange, disabled, ariaLabel }) => e('switch', { checked, onChange, disabled, 'aria-label': ariaLabel }),
    Menu: ({ triggerButton, children }) => e('menu', null, triggerButton, children),
    MenuParts: { Item: ({ onClick, disabled, children }) => e('menuitem', { onClick, disabled }, children), Separator: () => e('hr') },
    ...(appDialog ? { Dialog: h('dialog'), DialogParts: { Header: ({ title, subtitle }) => e('header', null, title, subtitle ? ` — ${subtitle}` : ''), Body: h('div'), Footer: h('footer') } } : {}),
    // the app's toasts, recorded: [level, title, options]
    toast: { get: () => Object.fromEntries(['info', 'success', 'warning', 'danger'].map((l) => [l, (title, opts) => { toasts.push([l, title, opts]); return { close() {} }; }])) },
  };
  const toasts = [];
  const subjects = new Map();
  const key = (ref) => `${ref.type}:${ref.id}`;
  const put = (ref, snap) => subjects.set(key(ref), { ref, ...snap });
  const putFw = (extra = {}) => put(FW, { state: { version: '1.0.0', safeMode: false, updatePolicy: 'offer', ...fw, ...extra }, links: { mods: order.map(modRef), operations: ops.map((o) => opRef(o.id)), ...(update ? { update: COPY } : {}), ...(app ? { app: APP } : {}) } });
  if (!noFramework) putFw();
  if (app) put(APP, { state: app });
  const setUpdate = (s) => put(COPY, { state: { version: '26.1017 with framework 1.0.1', state: 'ready', mods: [], held: false, risks: [], checked: 'static', dismissed: false, ...s } });
  if (update) setUpdate(update);
  const setMod = (id, state, links = {}) => { const all = { name: id, status: 'enabled', running: true, compatibility: 'compatible', reasons: [], ...state }; put(modRef(id), { state: { state: stateOf(all), ...all }, links }); };
  for (const [id, state] of Object.entries(mods)) { const { $links, ...rest } = state; setMod(id, rest, $links ?? {}); }
  for (const o of ops) put(opRef(o.id), { state: { startedAt: at('2026-10-28T00:00:00Z'), ...o.state }, links: o.mod ? { mod: modRef(o.mod) } : {} });
  const reported = new Map();
  const ctx = { use: (fn) => fn(), subject: (ref) => subjects.get(key(ref)), report: { put: (rec) => reported.set(rec, rec), remove: (rec) => reported.delete(rec) } };
  const calls = [], navigated = [], picks = [], queries = [];
  const act = async (ref, op, args) => { calls.push([ref.type, ref.id, op, args]); return invoke ? invoke(ref, op, args) : { status: 'done', value: opRef('op-new') }; };
  const dialogs = createDialogs({ R: React, exports: () => exports, ctx });
  const kit = createKit({ react: () => React, parts: () => ({ Button: exports.Button, Menu: exports.Menu, MenuItem: exports.MenuParts.Item, Separator: exports.MenuParts.Separator }) });
  const common = createPageCommon({ R: React, kit, exports: () => exports, invoke: act, frameworkRef: FW, dialogs });
  const base = { R: React, ctx, kit, common, exports: () => exports, dialogs, invoke: act, frameworkRef: FW, navigate: (p) => navigated.push(p),
    pickFile: pickFile && (async (o) => { picks.push(o); return pickFile(o); }),
    subscribe: (query, fn) => { queries.push(query); fn({ type: 'snapshot', items: threads.map((t, i) => ({ ref: { type: 'Thread', provider: 'codex', id: `t${i}` }, state: t })) }); return { dispose() {} }; } };
  const mount = (make) => {
    const root = ReactDOM.createRoot({});
    const show = () => root.render(make());
    show();
    const all = (pred) => root.trees().flatMap((t) => findAll(t, pred));
    const row = (label) => all((n) => n.type === 'li' && n.props['data-row'] === label)[0];
    const buttonIn = (node, label) => (node ? findAll(node, (n) => n.type === 'button' && textOf(n) === label)[0] : undefined);
    const dialog = () => all((n) => n.type === 'dialog')[0] ?? all((n) => n.props?.role === 'dialog')[0];
    return { root, show, all, row, buttonIn, dialog, text: () => rootText(root), inDialog: (label) => buttonIn(dialog(), label), dialogText: () => (dialog() ? textOf(dialog()) : ''),
      switchIn: (label) => findAll(row(label), (n) => n.type === 'switch')[0],
      menuItem: (node, label) => findAll(node, (n) => n.type === 'menuitem' && textOf(n) === label)[0] };
  };
  return { React, e, exports, ctx, base, kit, common, dialogs, put, putFw, setMod, setUpdate, calls, navigated, picks, queries, mount, toasts,
    reported: () => [...reported.values()].map((r) => [r.binding.slice(10), r.props.subject.type, r.props.subject.id, r.props.place.via ?? r.props.place.in, r.props.place.slot]) };
}
