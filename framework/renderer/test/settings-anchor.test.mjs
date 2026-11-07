// F7: `settings.section` must resolve INSIDE the Settings page's scrolling content, not the whole main surface (which squeezed the native
// scroller). The fixture reproduces the structure of the 20156 Settings page frame (app-initial `qMs`): page root > [toolbar] > scroller
// (flex-1 overflow-y-auto scrollbar-stable) > content column (class group/settings, data-density) > [title block, sections container]; the
// Settings navigation entries (data-settings-panel-slug) live in the sidebar, outside main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDom } from '../dom.mjs';
import { createAnchors } from '../anchors.mjs';
import { createHostRoot } from '../host-root.mjs';
import { createMountManager, CONTAINER_STYLE } from '../mount.mjs';
import { createFakeReact } from './fake-react.mjs';
import { createShimWindow, flush } from './dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '..', '..', '..', 'adapters', '26.1007.30912-20156', 'adapter.json'), 'utf8'));

const GATE = 'body:has([data-settings-panel-slug="general-settings"][aria-current="page"])';
const SETTINGS = `
<nav role="navigation" class="_Navigation_x"><button data-settings-panel-slug="general-settings" aria-current="page">General</button><button data-settings-panel-slug="agent">Agent</button><button data-settings-panel-slug="computer-use">Computer use</button></nav>
<main data-app-shell-main-surface="default">
  <div class="relative isolate flex h-full min-h-0 min-w-0 flex-col" data-codex-history-swipe-page="true">
    <div id="page-root" class="flex h-full min-h-0 flex-col electron:overflow-hidden">
      <div class="flex items-center px-panel draggable"><h1>Toolbar</h1></div>
      <div id="scroller" class="flex-1 scrollbar-stable overflow-y-auto p-panel">
        <div id="column" class="group/settings mx-auto flex w-full flex-col max-w-3xl" data-density="default">
          <div id="title" class="pb-8"><h1>General</h1></div>
          <div id="sections" class="flex flex-col gap-[var(--settings-section-gap,--spacing(10))]">
            <section id="s1">One</section><section id="s2">Two</section><section id="s3">Three</section>
          </div>
        </div>
      </div>
      <div id="footer" class="flex border-t">Footer</div>
    </div>
  </div>
</main>`;
const CLOSED = `<nav role="navigation" class="_Navigation_x"></nav><main data-app-shell-main-surface="default"><div class="chat">A thread</div></main>`;

function setup(html) {
  const win = createShimWindow({ html });
  const dom = createDom(win);
  const { React, ReactDOM } = createFakeReact();
  const hostRoot = createHostRoot({ react: React, reactDom: ReactDOM, dom, onFault() {} });
  const anchors = createAnchors({ dom, anchors: pack.anchors });
  const mm = createMountManager({ dom, anchors, hostRoot, report() {} });
  return { win, anchors, mm, React };
}

test('settings.section resolves to the sections container inside the scroller, not to the main surface', () => {
  const { anchors, win } = setup(SETTINGS);
  const hit = anchors.resolve('settings.section');
  assert.equal(hit.element.id, 'sections');
  assert.equal(hit.placement, 'inside');
  assert.equal(hit.selector, pack.anchors['settings.section'].selectors[0]);
  assert.ok(win.document.querySelector('#scroller').contains(hit.element), 'inside the scrolling content');
  assert.notEqual(hit.element.tagName, 'MAIN');
  assert.ok(!pack.anchors['settings.section'].selectors.some((s) => /main\[data-app-shell-main-surface\]\s*$/.test(s)), 'the whole-main-surface locator is gone');
});

test('a mount appends after the last native section, inside the scroller, and does not add a sibling of the page root', () => {
  const { win, mm, React } = setup(SETTINGS);
  const main = win.document.querySelector('main');
  const before = { main: main.children.length, pageRoot: win.document.querySelector('#page-root').children.length, scroller: win.document.querySelector('#scroller').children.length, column: win.document.querySelector('#column').children.length };
  const h = mm.mount('codexmods.adjustments', 'settings.section', () => React.createElement('div', null, 'Adjustments'));
  assert.equal(h.degraded, false);
  const sections = win.document.querySelector('#sections');
  const last = sections.children.at(-1);
  assert.equal(last.getAttribute('data-codexmods-mount'), 'codexmods.adjustments', 'the mount container is the last child of the native sections container');
  assert.equal(last.previousSibling.id, 's3', 'right after the last native section');
  assert.ok(win.document.querySelector('#scroller').contains(last));
  assert.deepEqual({ main: main.children.length, pageRoot: win.document.querySelector('#page-root').children.length, scroller: win.document.querySelector('#scroller').children.length, column: win.document.querySelector('#column').children.length }, before, 'no new flex sibling anywhere above the sections container');
});

test('alternatives stay inside the scrolling content: the column, then the scroller', () => {
  const noContainer = SETTINGS.replace('<div id="sections"', '<span id="sections"').replace('</div>\n        </div>\n      </div>\n      <div id="footer"', '</span>\n        </div>\n      </div>\n      <div id="footer"');
  const a = setup(noContainer).anchors.resolve('settings.section');
  assert.ok(['column', 'sections'].includes(a.element.id), a.element.id);
  const onlyScroller = SETTINGS.replace('class="group/settings mx-auto flex w-full flex-col max-w-3xl" data-density="default"', 'class="group/settings mx-auto" data-density="default"');
  assert.ok(setup(onlyScroller).anchors.resolve('settings.section').element.closest('#scroller'));
  const selectors = pack.anchors['settings.section'].selectors;
  assert.equal(selectors.length, 3);
  assert.ok(selectors.every((s) => s.startsWith(GATE)), 'every locator is gated on the General page being the open one');
});

test('it does not resolve when Settings is not open, even though group/settings-like classes could exist elsewhere', () => {
  assert.equal(setup(CLOSED).anchors.resolve('settings.section'), null);
  const stray = CLOSED.replace('<div class="chat">', '<div class="group/settings" data-density="default"><div></div></div><div class="chat">');
  assert.equal(setup(stray).anchors.resolve('settings.section'), null, 'needs the Settings navigation (data-settings-panel-slug) on screen');
});

test('navigating between settings pages re-places the mount in the new page\'s sections container', async () => {
  const { win, mm, React } = setup(SETTINGS);
  mm.mount('m', 'settings.section', () => React.createElement('i', null, 'x'));
  const column = win.document.querySelector('#column');
  const oldSections = win.document.querySelector('#sections');
  const fresh = win.document.createElement('div'); fresh.setAttribute('id', 'sections2'); fresh.setAttribute('class', 'flex flex-col');
  const sec = win.document.createElement('section'); sec.setAttribute('id', 'n1'); fresh.appendChild(sec);
  column.removeChild(oldSections); column.appendChild(fresh);
  await flush(); win.clock.tick(40); await flush();
  assert.equal(fresh.children.at(-1).getAttribute('data-codexmods-mount'), 'm');
  assert.equal(win.document.querySelectorAll('[data-codexmods-mount]').length, 1);
});

// ---- the anchor exists on the General page only; every other settings page has none, and the mount sits in a block of its own

/** The Settings surface with `slug` active in the navigation and a page body shaped like the app's page frame (`kind` picks the sections container's layout). */
function page(slug, { kind = 'col', title = slug } = {}) {
  const nav = ['general-settings', 'agent', 'computer-use', 'plugins-settings']
    .map((s) => `<button data-settings-panel-slug="${s}"${s === slug ? ' aria-current="page"' : ''}>${s}</button>`).join('');
  const layout = { col: 'flex flex-col gap-4', row: 'flex flex-row flex-wrap', grid: 'grid grid-cols-2 gap-4' }[kind];
  return `<nav role="navigation" class="_Navigation_x">${nav}</nav><main data-app-shell-main-surface="default"><div class="flex h-full min-h-0 flex-col"><div id="scroller" class="flex-1 scrollbar-stable overflow-y-auto">`
    + `<div id="column" class="group/settings mx-auto flex w-full flex-col" data-density="default"><div id="title"><h1>${title}</h1></div><div id="sections" class="${layout}"><section id="s1">One</section><section id="s2">Two</section></div></div></div></div></main>`;
}
const mountsIn = (win) => win.document.querySelectorAll('[data-codexmods-mount]');
const tick = async (win) => { await flush(); win.clock.tick(40); await flush(); };

test('General gets the anchor; Computer use and every other settings page do not', () => {
  assert.equal(setup(page('general-settings')).anchors.resolve('settings.section').element.id, 'sections');
  for (const slug of ['computer-use', 'agent', 'plugins-settings']) {
    const { anchors, mm, React } = setup(page(slug));
    assert.equal(anchors.resolve('settings.section'), null, slug);
    const h = mm.mount('m', 'settings.section', () => React.createElement('i', null, 'x'));
    assert.equal(h.degraded, true, `${slug}: a settings.section mod degrades off the General page`);
  }
  // no page marked active at all (e.g. the navigation is collapsed): absent, never guessed
  assert.equal(setup(page('none')).anchors.resolve('settings.section'), null);
  // the alternatives are gated too: a General page without its sections container still resolves, a Computer use page never does
  const noSections = (slug) => page(slug).replace('<div id="sections"', '<span id="sections"').replace('</section></div></div></div></div></main>', '</section></span></div></div></div></main>');
  assert.ok(setup(noSections('general-settings')).anchors.resolve('settings.section'));
  assert.equal(setup(noSections('computer-use')).anchors.resolve('settings.section'), null);
});

test('on General the mount is mounted and not degraded; the container is a full-width block whatever the parent layout (flex column, flex row, grid)', () => {
  for (const kind of ['col', 'row', 'grid']) {
    const { win, mm, React } = setup(page('general-settings', { kind }));
    const h = mm.mount('codexmods.adjustments', 'settings.section', () => React.createElement('div', null, 'Adjustments'));
    assert.equal(h.degraded, false, kind);
    const [c] = mountsIn(win);
    const style = c.getAttribute('style');
    for (const decl of ['display:block', 'width:100%', 'min-width:0']) assert.ok(style.split(';').includes(decl), `${kind}: ${decl} in "${style}"`);
    assert.ok(!/display:\s*contents/.test(style), 'not display:contents, which would make the content a flex/grid item of the page');
    assert.equal(c.parentNode.id, 'sections');
    assert.equal(c.previousSibling.id, 's2');
  }
  assert.equal(CONTAINER_STYLE['settings.section'].split(';')[0], 'display:block');
});

test('other anchors keep the display:contents container', () => {
  const { win, mm, React } = setup(SETTINGS);
  mm.mount('m', 'sidebar', () => React.createElement('i', null, 'x'));
  assert.equal(mountsIn(win)[0].getAttribute('style'), 'display:contents');
});

/** Navigate like the app: flip aria-current, then swap the page body (`swap`) or leave it (the container survives with only attributes changed). */
function navigate(win, slug, { swap }) {
  for (const b of win.document.querySelectorAll('[data-settings-panel-slug]')) {
    if (b.getAttribute('data-settings-panel-slug') === slug) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (!swap) return;
  const old = win.document.querySelector('#column');
  const fresh = win.document.createElement('div'); fresh.setAttribute('id', 'column'); fresh.setAttribute('class', 'group/settings mx-auto flex w-full flex-col'); fresh.setAttribute('data-density', 'default');
  const sections = win.document.createElement('div'); sections.setAttribute('id', 'sections'); sections.setAttribute('class', 'flex flex-col');
  const sec = win.document.createElement('section'); sec.setAttribute('id', `n-${slug}`); sections.appendChild(sec); fresh.appendChild(sections);
  old.parentNode.removeChild(old); win.document.querySelector('#scroller').appendChild(fresh);
}

for (const swap of [true, false]) {
  test(`navigation General → Computer use → General keeps exactly one mount (${swap ? 'page body replaced' : 'only the navigation state changes: the sections container survives'})`, async () => {
    const { win, mm, React } = setup(page('general-settings'));
    const h = mm.mount('codexmods.adjustments', 'settings.section', () => React.createElement('div', null, 'Adjustments'));
    assert.equal(mountsIn(win).length, 1);
    const states = [];
    for (const slug of ['computer-use', 'general-settings', 'agent', 'general-settings']) {
      navigate(win, slug, { swap });
      await tick(win);
      const n = mountsIn(win).length;
      states.push(`${slug}:${n}:${h.degraded ? 'degraded' : 'mounted'}`);
      if (slug === 'general-settings') assert.equal(win.document.querySelector('#sections').lastChild.getAttribute('data-codexmods-mount'), 'codexmods.adjustments', 'appended at the end of the General sections');
      assert.equal(mm.snapshot().length, 1, 'still one contribution');
    }
    assert.deepEqual(states, ['computer-use:0:degraded', 'general-settings:1:mounted', 'agent:0:degraded', 'general-settings:1:mounted']);
    h.dispose();
    assert.equal(mountsIn(win).length, 0);
  });
}

test('a page change while the anchor element is removed by the app leaves no stray container behind', async () => {
  const { win, mm, React } = setup(page('general-settings'));
  mm.mount('m', 'settings.section', () => React.createElement('i', null, 'x'));
  navigate(win, 'computer-use', { swap: true });         // React drops the old page subtree including our container
  await tick(win);
  assert.equal(mountsIn(win).length, 0);
  navigate(win, 'general-settings', { swap: true });
  await tick(win);
  assert.equal(mountsIn(win).length, 1);
  assert.equal(win.document.querySelectorAll('[data-codexmods-anchor="settings.section"]').length, 1);
});

test('observeTree wakes up on aria-current changes (a page change that only flips the navigation state) and on nothing else attribute-wise', async () => {
  const win = createShimWindow({ html: page('general-settings') });
  const dom = createDom(win);
  let n = 0;
  const stop = dom.observeTree(() => { n++; });
  const btn = win.document.querySelector('[data-settings-panel-slug="computer-use"]');
  btn.setAttribute('class', 'x'); btn.setAttribute('data-foo', '1'); await flush();
  assert.equal(n, 0, 'class/data attributes do not wake the observer (streaming UI cost)');
  btn.setAttribute('aria-current', 'page'); await flush();
  assert.equal(n, 1);
  btn.removeAttribute('aria-current'); await flush();
  assert.equal(n, 2);
  stop();
});
