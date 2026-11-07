import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDom } from '../dom.mjs';
import { createAnchors, ANCHOR_NAMES } from '../anchors.mjs';
import { createTheme } from '../theme.mjs';
import { createShimWindow, flush } from './dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '..', '..', '..', 'adapters', '26.1007.21159-20052', 'adapter.json'), 'utf8'));

// A small fixture shaped like the stock 20052 shell, built from the attributes the bundle renders (see adapters/…/NOTES.md).
const SHELL = `
<div id="root">
  <header data-app-shell-titlebar="true" class="drag"><span data-app-shell-titlebar-content="true">Codex</span></header>
  <nav role="navigation" aria-label="Chat history" class="_Navigation_1uxfp_2 flex">
    <div data-app-action-sidebar-scroll="true"><a data-app-action-sidebar-thread-id="t1" data-app-action-sidebar-thread-row="true">One</a></div>
    <div class="absolute inset-x-0 bottom-0 z-20"><button id="acct">Account</button></div>
  </nav>
  <main data-app-shell-main-surface="default">
    <div data-app-shell-workspace-layout="split" data-app-shell-main-content-layout="full">
      <div data-app-shell-header-toolbar="true"></div>
      <section id="s1">Section</section>
      <div data-codex-composer-root="" data-composer-placement="home"><div data-codex-composer="true"><div class="ProseMirror" contenteditable="true"></div></div></div>
    </div>
  </main>
</div>`;

function setup(html = SHELL) {
  const win = createShimWindow({ html });
  const dom = createDom(win);
  const logs = [];
  const anchors = createAnchors({ dom, anchors: pack.anchors, log: (m, d) => logs.push([m, d]) });
  return { win, dom, anchors, logs };
}

test('every anchor resolves on the 20052-shaped shell', () => {
  const { anchors, win } = setup(SHELL.replace('<main', '<aside data-settings-panel-slug="general"></aside><main'));
  const expected = {
    'settings.section': 'main', sidebar: 'nav', workspace: 'div',
  };
  for (const [name, tag] of Object.entries(expected)) {
    const hit = anchors.resolve(name);
    assert.ok(hit, `${name} should resolve`);
    assert.equal(hit.element.tagName.toLowerCase(), tag, name);
  }
  assert.deepEqual(ANCHOR_NAMES, ['settings.section', 'sidebar', 'workspace']);
  assert.equal(win.document.querySelector('main').getAttribute('data-app-shell-main-surface'), 'default');
});

test('settings.section only resolves while the Settings navigation is on screen', () => {
  const { anchors } = setup();
  assert.equal(anchors.resolve('settings.section'), null);
  const open = setup(SHELL.replace('<main', '<aside data-settings-panel-slug="agent"></aside><main'));
  assert.equal(open.anchors.resolve('settings.section').element.tagName, 'MAIN');
});

test('alternatives are tried in adapter order; placement comes from the winning locator', () => {
  const html = '<div data-app-shell-main-content-layout="x" id="alt"></div>';
  const { anchors } = setup(html);
  const hit = anchors.resolve('workspace');
  assert.equal(hit.element.id, 'alt');
  assert.equal(hit.selector, '[data-app-shell-main-content-layout]');
  assert.equal(hit.placement, 'inside');
});

test('a position overrides the placement', () => {
  const { anchors } = setup();
  assert.equal(anchors.placementFor('workspace'), 'append');
  assert.equal(anchors.placementFor('workspace', 'prepend'), 'prepend');
  assert.throws(() => anchors.placementFor('workspace', 'middle'), { code: 'Invalid' });
});

test('an invalid selector is skipped and logged once, never thrown', () => {
  const win = createShimWindow({ html: '<p id="ok"></p>' });
  const logs = [];
  const anchors = createAnchors({ dom: createDom(win), anchors: { sidebar: { selectors: ['p:nth-child(', 'p#ok'], placement: 'inside' } }, log: (m) => logs.push(m) });
  assert.equal(anchors.resolve('sidebar').element.id, 'ok');
  anchors.resolve('sidebar');
  assert.equal(logs.length, 1);
});

test('theme: tokens read the mapped custom properties live', () => {
  const { win, dom } = setup();
  for (const [token, prop] of Object.entries(pack.theme)) win.setVar(prop, `v-${token}`);
  const theme = createTheme({ dom, tokens: pack.theme });
  const t = theme.tokens();
  assert.deepEqual(Object.keys(t).sort(), Object.keys(pack.theme).sort());
  assert.equal(t.text, 'v-text');
  assert.equal(t.fontFamily, 'v-fontFamily');
});

test('theme: appearance follows data-theme, then class, then the media query', () => {
  const { win, dom } = setup();
  const theme = createTheme({ dom, tokens: pack.theme });
  assert.equal(theme.appearance, 'light');
  win.document.documentElement.setAttribute('data-theme', 'dark');
  assert.equal(theme.appearance, 'dark');
  win.document.documentElement.removeAttribute('data-theme');
  win.document.documentElement.setAttribute('class', 'electron-dark');
  assert.equal(theme.appearance, 'dark');
  win.document.documentElement.setAttribute('class', '');
  win.setDark(true);
  assert.equal(theme.appearance, 'dark');
});

test('theme: onChange fires on <html> attribute and variable changes, not on unrelated mutations, and stops after dispose', async () => {
  const { win, dom } = setup();
  win.setVar('--color-text', '#000');
  const theme = createTheme({ dom, tokens: { text: '--color-text' } });
  const seen = [];
  const sub = theme.onChange((t) => seen.push(t.text));
  await flush();
  win.setVar('--color-text', '#fff');
  await flush();
  assert.deepEqual(seen, ['#fff']);
  win.document.documentElement.setAttribute('data-theme', 'dark');   // appearance flips, tokens unchanged → still reported (appearance is part of the state)
  await flush();
  assert.equal(seen.length, 2);
  win.document.body.appendChild(win.document.createElement('p'));    // unrelated mutation: observer is root-attribute only
  await flush();
  assert.equal(seen.length, 2);
  sub.dispose();
  win.setVar('--color-text', '#abc');
  await flush();
  assert.equal(seen.length, 2);
});

test('theme: a throwing listener does not stop the others', async () => {
  const { win, dom } = setup();
  const theme = createTheme({ dom, tokens: { text: '--color-text' } });
  const seen = [];
  theme.onChange(() => { throw new Error('boom'); });
  theme.onChange((t) => seen.push(t.text));
  win.setVar('--color-text', 'x');
  await flush();
  assert.deepEqual(seen, ['x']);
});

test('dom accessors and the theme are null-safe while <html> does not exist yet', async () => {
  const win = createShimWindow({});
  const html = win.document.documentElement;
  win.document.removeChild(html);
  win.document.documentElement = null;
  win.document.head = null; win.document.body = null;
  const dom = createDom(win);
  assert.equal(dom.rootTheme(), null);
  assert.equal(dom.cssVar('--color-text'), '');
  assert.doesNotThrow(() => dom.addStyle('x{}', 's')());
  assert.equal(dom.body(), null);
  assert.doesNotThrow(() => dom.observeRoot(() => {})());
  const theme = createTheme({ dom, tokens: pack.theme });
  assert.equal(theme.appearance, 'light');
  assert.equal(theme.tokens().text, '');
  const seen = [];
  theme.onChange(() => seen.push(1));
  win.document.documentElement = html;
  win.document.appendChild(html);                       // <html> appears: the root observer wakes the theme
  win.setVar('--color-text', '#fff');
  await flush();
  assert.ok(seen.length >= 1);
});

test('an anchor names the element shown: the app keeps other pages\' columns mounted out of sight; none shown, the first that matches', () => {
  const hidden = { name: 'hidden', shown: false }, shown = { name: 'shown', shown: true };
  const lists = { '.a': [hidden, shown], '.b': [hidden], '.c': [{ name: 'other', shown: true }], '.bad': null };
  const dom = { queryAll: (s) => { if (lists[s] === null) throw new SyntaxError('bad'); return lists[s] ?? []; }, isShown: (n) => n.shown };
  const anchors = createAnchors({ dom, anchors: { one: { selectors: ['.a'], placement: 'inside' }, later: { selectors: ['.bad', '.b', '.c'], placement: 'inside' }, none: { selectors: ['.b'], placement: 'inside' }, gone: { selectors: ['.z'], placement: 'inside' } } });
  assert.equal(anchors.resolve('one').element, shown);
  assert.equal(anchors.resolve('later').selector, '.c', 'a later selector\'s shown element before an earlier one\'s hidden');
  assert.equal(anchors.resolve('none').element, hidden, 'none shown: the first that matches');
  assert.equal(anchors.resolve('gone'), null);
});
