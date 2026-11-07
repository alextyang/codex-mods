// The window's arrangement its page reports (S10; H7pl; docs/design/layouts.md §4, WL1): its navigation, sidebar, side and bottom panels,
// and the workspace's layout as the workspace shown says it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellFactsOf } from '../core.mjs';

/** A page: the shell's frame, its elements (each with attributes, a width and height, and whether it is shown). */
function page({ sidebar = 'true', pane = false, aside = null, rail = null, navRoot = null, left = 340, bottom = 0, beside = null, workspaces = [], kept = {} } = {}) {
  const frame = { attrs: { 'data-app-shell-sidebar-open': sidebar } };
  const el = (w, h = 0, attrs = {}) => ({ w, h, attrs, shown: true });
  const one = {
    '[data-app-shell-frame]': frame,
    '[data-app-shell-pane-frame]': pane ? el(0) : null,
    'aside[data-app-shell-focus-area="right-panel"]': aside === null ? null : el(aside),
    'nav[data-app-navigation-rail]': rail === null ? null : el(rail),
    '[data-sidebar-navigation-root]': navRoot === null ? null : el(navRoot),
    'aside.app-shell-left-panel': el(left),
    '[data-app-shell-focus-area="bottom-panel"]': beside ? el(beside[1], 900, { 'data-codexmods-bottom-at': beside[0] }) : el(0, bottom),
  };
  // `kept`: a page the app keeps hidden, its own panels first in the document (by selector: [width, height])
  const hidden = (sel) => (kept[sel] ? [{ w: kept[sel][0], h: kept[sel][1] ?? 0, attrs: {}, shown: false }] : []);
  return {
    query: (s) => one[s] ?? null,
    queryAll: (s) => (s === '[data-app-shell-workspace-layout]' ? workspaces.map(([layout, shown, full]) => ({ attrs: { 'data-app-shell-workspace-layout': layout, 'data-app-shell-right-panel-full-width': full ? 'true' : 'false' }, shown }))
      : [...hidden(s), ...(one[s] ? [one[s]] : [])]),
    isShown: (n) => n.shown, attr: (e, name) => e.attrs[name] ?? null, width: (n) => n.w, height: (n) => n.h,
  };
}

test('H7pl review 2: the layout is the shown workspace\'s, not a page the app keeps hidden; none shown: none', () => {
  assert.deepEqual(shellFactsOf(page({ pane: true, aside: 520, workspaces: [['split', false], ['full', true, true]] })).layout, { mode: 'full' }, 'the kept page (split) is hidden');
  assert.equal(shellFactsOf(page({ sidebar: 'false', workspaces: [['split', false]] })).layout, null, 'none shown: none (what was said before no longer holds)');
  assert.equal(shellFactsOf(page({ workspaces: [['wide', true]] })).layout, null, 'one the app does not have: none');
  assert.equal(shellFactsOf({ query: () => null, queryAll: () => [], attr: () => null }), null, 'no shell: no facts');
});

test('layouts WL1-3 review: the side and bottom panels measured are the shown page\'s, never a kept page\'s first in the document', () => {
  const f = shellFactsOf(page({ rail: 52, navRoot: 288, aside: 0, bottom: 0, workspaces: [['split', true]],
    kept: { 'aside[data-app-shell-focus-area="right-panel"]': [520], '[data-app-shell-focus-area="bottom-panel"]': [900, 280] } }));
  assert.deepEqual([f.side, f.bottom, f.layout], [{ open: false }, { open: false }, { mode: 'chat' }]);
});

test('WL1: the arrangement on 21477 (the pane frame while the panel is open, the left panel the sidebar) and on 22943 (the aside, the rail)', () => {
  // 21477: no rail; the pane frame says the panel is open; the workspace says chat itself
  assert.deepEqual(shellFactsOf(page({ pane: true, aside: 480, workspaces: [['split', true]] })),
    { navigation: 'sidebar', sidebar: { open: true, width: 340 }, side: { open: true, size: 480, full: false }, bottom: { open: false }, layout: { mode: 'split' } });
  assert.deepEqual(shellFactsOf(page({ workspaces: [['chat', true]] })).layout, { mode: 'chat' });
  // 22943: the rail beside the sidebar (the navigation root is the sidebar); the aside at no width while the panel is closed
  assert.deepEqual(shellFactsOf(page({ rail: 52, navRoot: 288, left: 340, aside: 0, workspaces: [['split', true]] })),
    { navigation: 'rail-and-sidebar', sidebar: { open: true, width: 288 }, side: { open: false }, bottom: { open: false }, layout: { mode: 'chat' } });
  assert.deepEqual(shellFactsOf(page({ rail: 52, navRoot: 0, left: 52, sidebar: 'false', aside: 520, bottom: 280, workspaces: [['full', true, true]] })),
    { navigation: 'rail', sidebar: { open: false }, side: { open: true, size: 520, full: true }, bottom: { open: true, height: 280 }, layout: { mode: 'full' } });
  // a frame that does not say whether its sidebar is open: no sidebar fact (the Window is not put on a guess)
  assert.equal('sidebar' in shellFactsOf(page({ sidebar: null })), false);
});

test('layouts WL4b: the bottom panel beside the chat is measured by its width; below, by its height', () => {
  assert.deepEqual(shellFactsOf(page({ bottom: 280 })).bottom, { open: true, height: 280 });
  assert.deepEqual(shellFactsOf(page({ beside: ['right', 420] })).bottom, { open: true, width: 420 });
  assert.deepEqual(shellFactsOf(page({ beside: ['left', 0] })).bottom, { open: false });
});

test('layouts WL4b: a page whose window is in the background says so (it draws no frame until it is in front)', () => {
  const p = page({ bottom: 280 });
  assert.equal('hidden' in shellFactsOf(p), false);
  assert.equal(shellFactsOf({ ...p, pageHidden: () => true }).hidden, true);
});

