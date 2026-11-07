// A mod's own page in the main region (docs/design/layouts.md D7, WL5a): the host draws what the framework's route names, the app's header
// over the mod's component; a page that is not there says so with the mod's name; while it is shown a reload comes back to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText, findAll } from './fake-react.mjs';
import { createMainPages, pagePath, pageOfPath } from '../present/main-pages.mjs';
import { mainPageWhy } from '../../shared/ui-rules-client.mjs';

function setup({ pathname = '/codexmods/page/qa.mod/notes', subjects = {}, settled = true } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const e = React.createElement;
  const navigated = [], touched = [], reported = [];
  const ctx = {
    react: () => React, use: (fn) => fn(), subject: (ref) => subjects[ref.id], settled: () => settled,
    local: { read() {}, touch: (k) => touched.push(k) },
    modNode: (rule, type, props) => e(type, props),
    report: { put: (r) => reported.push(r), remove() {} },
  };
  const appShell = {
    Header: ({ children, className, inline }) => e('header', { className, 'data-inline': inline }, children),
    HeaderToolbar: Object.assign(({ children }) => e('nav', null, children), { Actions: ({ children }) => e('menu', null, children) }),
  };
  const route = { pathname };
  const pages = createMainPages({ ctx, exports: () => ({ appShell }), observe: () => ({ dispose() {} }), useRoute: () => route, navigate: (p) => navigated.push(p) });
  const draw = () => { const root = ReactDOM.createRoot({}); root.render(e(pages.PageRoute)); return root; };
  return { React, pages, draw, navigated, touched, route, reported };
}
const page = (over = {}) => ({ key: 'qa.mod/notes', mod: 'qa.mod', id: 'notes', title: 'Notes', render: ({ page: p }) => `the page ${p.id}`, rule: {}, ...over });

test('WL5a: a page\'s path and what it names', () => {
  assert.equal(pagePath('qa.mod', 'notes'), '/codexmods/page/qa.mod/notes');
  assert.deepEqual(pageOfPath('/codexmods/page/qa.mod/notes'), { mod: 'qa.mod', id: 'notes' });
  assert.equal(pageOfPath('/codexmods/page/qa.mod'), null);
  assert.equal(pageOfPath('/local/1'), null);
  assert.equal(pageOfPath(undefined), null);
});

test('WL5a: a page draws the app\'s header (its title, its actions) over the mod\'s component, and is reported in the main region', () => {
  const t = setup();
  t.pages.setPages([page({ heading: 'My notes', actions: () => 'an action' })]);
  const root = t.draw();
  const text = rootText(root);
  assert.match(text, /My notes/);
  assert.match(text, /an action/);
  assert.match(text, /the page notes/);
  assert.equal(findAll(root.tree, (n) => n.type === 'header')[0].props['data-inline'], true, 'in the page, never under a page banner in the title bar\'s row');
  assert.equal(findAll(root.tree, (n) => n.props?.['data-codexmods-page'] === 'qa.mod/notes').length, 1);
  assert.deepEqual(t.reported.map((r) => [r.binding, r.props.subject.id, r.props.place.slot]), [['framework:Page', 'qa.mod', 'main']]);
});

test('WL5a: a page opens only when it is declared here, by its path', () => {
  const t = setup();
  assert.equal(t.pages.open('qa.mod', 'notes'), false);
  assert.deepEqual(t.navigated, []);
  t.pages.setPages([page()]);
  assert.equal(t.pages.has('qa.mod', 'notes'), true);
  assert.equal(t.pages.open('qa.mod', 'notes'), true);
  assert.deepEqual(t.navigated, ['/codexmods/page/qa.mod/notes']);
});

test('WL5a: a page that is not there stays routable and says why with the mod\'s name; its settings are a click away', () => {
  const off = setup({ subjects: { 'qa.mod': { state: { name: 'QA Mod', status: 'disabled' } } } });
  const root = off.draw();
  assert.match(rootText(root), /QA Mod is off/);
  const [button] = findAll(root.tree, (n) => n.type === 'button');
  button.props.onClick();
  assert.deepEqual(off.navigated, ['/settings/codexmods/qa.mod']);
  const stopped = setup({ subjects: { 'qa.mod': { state: { name: 'QA Mod', status: 'enabled', running: false } } } });
  assert.match(rootText(stopped.draw()), /QA Mod is not running/);
  const removed = setup({ subjects: {} });
  const gone = removed.draw();
  assert.match(rootText(gone), /qa\.mod is not installed/);
  assert.equal(findAll(gone.tree, (n) => n.type === 'button').length, 0, 'no settings to open');
});

test('WL5a: while the graph has not answered, and while a running mod may still declare its page, nothing is claimed', () => {
  const loading = setup({ subjects: {}, settled: false });
  assert.equal(rootText(loading.draw()), '');
  const starting = setup({ subjects: { 'qa.mod': { state: { name: 'QA Mod', status: 'enabled', running: true } } } });
  assert.equal(rootText(starting.draw()), '');
});

test('WL5a: a mod\'s page declaration: a title of at most 80 characters, a heading', () => {
  assert.equal(mainPageWhy({ title: 'Notes' }), null);
  assert.equal(mainPageWhy({ title: 'Notes', heading: 'My notes' }), null);
  assert.match(mainPageWhy({}), /title/);
  assert.match(mainPageWhy({ title: 'x'.repeat(81) }), /80/);
  assert.match(mainPageWhy({ title: 'Notes', heading: '' }), /heading/);
});

test('WL5a: while a page is shown the address holds its path for a reload; going elsewhere takes it out, a reload itself never does', () => {
  const saved = { location: globalThis.location, history: globalThis.history, add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  const listeners = new Map();
  let href = 'app://-/index.html';
  globalThis.location = { get href() { return href; } };
  globalThis.history = { state: null, replaceState: (_, __, u) => { href = u; } };
  globalThis.addEventListener = (n, f) => listeners.set(n, f);
  globalThis.removeEventListener = (n) => listeners.delete(n);
  try {
    const t = setup();
    t.pages.setPages([page()]);
    const root = t.draw();
    assert.equal(new URL(href).searchParams.get('initialRoute'), '/codexmods/page/qa.mod/notes');
    root.unmount();
    assert.equal(new URL(href).searchParams.get('initialRoute'), null, 'gone elsewhere');
    const again = t.draw();
    assert.equal(new URL(href).searchParams.get('initialRoute'), '/codexmods/page/qa.mod/notes');
    listeners.get('pagehide')();
    again.unmount();
    assert.equal(new URL(href).searchParams.get('initialRoute'), '/codexmods/page/qa.mod/notes', 'the page going keeps it');
  } finally {
    globalThis.location = saved.location; globalThis.history = saved.history; globalThis.addEventListener = saved.add; globalThis.removeEventListener = saved.remove;
  }
});

test('WL5a review: leaving takes out only its own path: the app may have written another as it navigated', () => {
  const saved = { location: globalThis.location, history: globalThis.history };
  let href = 'app://-/index.html';
  globalThis.location = { get href() { return href; } };
  globalThis.history = { state: null, replaceState: (_, __, u) => { href = u; } };
  try {
    const t = setup();
    t.pages.setPages([page()]);
    const root = t.draw();
    const u = new URL(href); u.searchParams.set('initialRoute', '/skills'); href = u.toString();
    root.unmount();
    assert.equal(new URL(href).searchParams.get('initialRoute'), '/skills');
  } finally { globalThis.location = saved.location; globalThis.history = saved.history; }
});

test('WL5a review: a page that faulted says so; no route, nothing opens or is listed; the window says which page it shows', () => {
  const t = setup({ subjects: { 'qa.mod': { state: { name: 'QA Mod', status: 'enabled', running: true } } } });
  t.pages.setPages([], ['qa.mod/notes']);
  assert.match(rootText(t.draw()), /This page of QA Mod failed/);
  const shown = setup();
  shown.pages.setPages([page()]);
  assert.equal(shown.pages.shown(), null);
  const root = shown.draw();
  assert.equal(shown.pages.shown(), 'qa.mod/notes');
  root.unmount();
  assert.equal(shown.pages.shown(), null);
  const { React } = createFakeReact();
  const none = createMainPages({ ctx: { react: () => React, local: { read() {}, touch() {} } }, exports: () => ({}), observe: () => ({ dispose() {} }), useRoute: () => null, navigate() { throw new Error('never'); }, routed: () => false });
  none.setPages([page()]);
  assert.equal(none.open('qa.mod', 'notes'), false);
  assert.deepEqual(none.list(), []);
  assert.equal(none.has('qa.mod', 'notes'), false);
});
