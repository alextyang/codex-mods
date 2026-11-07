import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDom } from '../dom.mjs';
import { createAnchors } from '../anchors.mjs';
import { createHostRoot } from '../host-root.mjs';
import { createMountManager } from '../mount.mjs';
import { createFakeReact, rootText, textOf } from './fake-react.mjs';
import { createShimWindow, flush } from './dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '..', '..', '..', 'adapters', '26.1007.21159-20052', 'adapter.json'), 'utf8'));
const SHELL = `<main data-app-shell-main-surface="x"><div data-app-shell-workspace-layout="w"><div id="comp" data-codex-composer-root=""></div></div></main>`;

function setup(html = SHELL) {
  const win = createShimWindow({ html });
  const dom = createDom(win);
  const { React, ReactDOM } = createFakeReact();
  const faults = [];
  const hostRoot = createHostRoot({ react: React, reactDom: ReactDOM, dom, onFault: (modId, err) => faults.push([modId, err.message]) });
  // a locator placed before its element, as a build could name one: the manager reads placements from the locator
  const anchors = createAnchors({ dom, anchors: { ...pack.anchors, sidebar: { selectors: ['[data-codex-composer-root]'], placement: 'before' } } });
  const events = [];
  const mm = createMountManager({ dom, anchors, hostRoot, report: (kind, modId, anchor) => events.push(`${kind}:${modId}:${anchor}`) });
  const settle = async () => { await flush(); win.clock.tick(20); await flush(); };
  return { win, dom, React, hostRoot, mm, faults, events, settle, rootText: () => rootText(hostRoot.root) };
}
const comp = (React, text) => function Probe() { return React.createElement('b', null, text); };

test('mount renders a portal into a container placed at the anchor and reports mounted', () => {
  const { win, mm, React, events, hostRoot } = setup();
  const h = mm.mount('mod.a', 'workspace', comp(React, 'hello'));
  assert.equal(h.degraded, false);
  assert.deepEqual(events, ['mounted:mod.a:workspace']);
  const ws = win.document.querySelector('[data-app-shell-workspace-layout]');
  const box = ws.querySelector('[data-codexmods-mount]');
  assert.ok(box, 'container appended inside the anchor');
  assert.equal(box.getAttribute('data-codexmods-mount'), 'mod.a');
  assert.equal(textOf(hostRoot.root.portals.get(box)), 'hello');
});

test('placement comes from the locator by default (this locator: before) and from opts.position when given', () => {
  const { win, mm, React } = setup();
  mm.mount('m', 'sidebar', comp(React, 'a'));
  mm.mount('m', 'sidebar', comp(React, 'b'), { position: 'after' });
  mm.mount('m', 'workspace', comp(React, 'c'), { position: 'prepend' });
  const comp0 = win.document.querySelector('#comp');
  assert.equal(comp0.previousSibling.getAttribute('data-codexmods-anchor'), 'sidebar');
  assert.equal(comp0.nextSibling.getAttribute('data-codexmods-anchor'), 'sidebar');
  assert.equal(win.document.querySelector('[data-app-shell-workspace-layout]').firstChild.getAttribute('data-codexmods-anchor'), 'workspace');
});

test('an anchor that is absent at mount time yields a degraded contribution, reported once', () => {
  const { mm, React, events } = setup();
  const h = mm.mount('m', 'settings.section', comp(React, 'x'));
  assert.equal(h.degraded, true);
  assert.deepEqual(events, ['degraded:m:settings.section']);
  mm.reconcile(); mm.reconcile();
  assert.deepEqual(events, ['degraded:m:settings.section']);
});

test('anchor disappears → unmounted + degraded; anchor reappears → remounted + mounted (shared observer)', async () => {
  const { win, mm, React, events, settle, hostRoot } = setup();
  const h = mm.mount('m', 'sidebar', comp(React, 'band'));
  const parent = win.document.querySelector('[data-app-shell-workspace-layout]');
  const comp0 = win.document.querySelector('#comp');
  parent.removeChild(comp0);
  await settle();
  assert.equal(h.degraded, true);
  assert.equal(win.document.querySelector('[data-codexmods-mount]'), null);
  assert.equal(hostRoot.root.portals.size, 0);
  const again = win.document.createElement('div');
  again.setAttribute('data-codex-composer-root', '');
  parent.appendChild(again);
  await settle();
  assert.equal(h.degraded, false);
  assert.equal(again.previousSibling.getAttribute('data-codexmods-mount'), 'm');
  assert.deepEqual(events, ['mounted:m:sidebar', 'degraded:m:sidebar', 'mounted:m:sidebar']);
});

test('the app replacing the anchor element moves the contribution to the new element', async () => {
  const { win, mm, React, settle } = setup();
  mm.mount('m', 'workspace', comp(React, 'x'));
  const old = win.document.querySelector('[data-app-shell-workspace-layout]');
  const fresh = win.document.createElement('div');
  fresh.setAttribute('data-app-shell-workspace-layout', 'n');
  old.parentNode.insertBefore(fresh, old);
  old.parentNode.removeChild(old);
  await settle();
  assert.ok(fresh.querySelector('[data-codexmods-mount]'));
});

test('if the app strips our container out of the anchor, it is put back', async () => {
  const { win, mm, React, settle } = setup();
  mm.mount('m', 'workspace', comp(React, 'x'));
  const box = win.document.querySelector('[data-codexmods-mount]');
  box.parentNode.removeChild(box);
  await settle();
  assert.ok(win.document.querySelector('[data-codexmods-mount]'));
});

test('dispose removes the container; disposeMod removes only that mod; the observer is shared', async () => {
  const { win, mm, React, settle } = setup();
  const a = mm.mount('mod.a', 'workspace', comp(React, 'a'));
  mm.mount('mod.b', 'workspace', comp(React, 'b'));
  mm.mount('mod.b', 'sidebar', comp(React, 'b2'));
  assert.equal(win.document._observers.size, 1, 'one MutationObserver for the window');
  a.dispose();
  assert.equal(win.document.querySelectorAll('[data-codexmods-mount]').length, 2);
  mm.disposeMod('mod.b');
  assert.equal(win.document.querySelectorAll('[data-codexmods-mount]').length, 0);
  assert.equal(mm.count(), 0);
  await settle();
});

test('error boundary: a throwing component is attributed to its mod, others keep rendering', () => {
  const { mm, React, faults, rootText } = setup();
  mm.mount('mod.bad', 'workspace', function Bad() { throw new Error('render boom'); });
  mm.mount('mod.good', 'sidebar', comp(React, 'fine'));
  assert.deepEqual(faults, [['mod.bad', 'render boom']]);
  assert.equal(rootText(), 'fine');
});

test('mount validates its inputs: unknown anchor, non-component, bad position', () => {
  const { mm, React } = setup();
  assert.throws(() => mm.mount('m', 'nowhere', comp(React, 'x')), { code: 'Invalid' });
  assert.throws(() => mm.mount('m', 'workspace', 'text'), { code: 'Invalid' });
  assert.throws(() => mm.mount('m', 'workspace', comp(React, 'x'), { position: 'sideways' }), { code: 'Invalid' });
  assert.equal(mm.count(), 0);
});

test('props are passed to the component', () => {
  const { mm, React, rootText } = setup();
  mm.mount('m', 'workspace', function P({ label }) { return React.createElement('i', null, label); }, { props: { label: 'L' } });
  assert.equal(rootText(), 'L');
});

test('the host root container is re-attached if the app wipes <body>', async () => {
  const { win, mm, React, settle, hostRoot } = setup();
  mm.mount('m', 'workspace', comp(React, 'x'));
  const rootBox = hostRoot.container;
  win.document.body.removeChild(rootBox);
  win.document.body.appendChild(win.document.createElement('p'));
  await settle();
  assert.ok(win.document.body.contains(rootBox));
});

test('dispose of the manager disconnects the observer and clears containers', () => {
  const { win, mm, React } = setup();
  mm.mount('m', 'workspace', comp(React, 'x'));
  mm.dispose();
  assert.equal(win.document._observers.size, 0);
  assert.equal(win.document.querySelectorAll('[data-codexmods-mount]').length, 0);
});
