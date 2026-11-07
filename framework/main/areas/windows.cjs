'use strict';
// The app's windows as the graph's Window acts on them (docs/design/systems.md S10): by the window's id (its webContents id, by which the
// framework knows every window), the messages the app's main sends its pages, which the page handles itself: open a thread (as a sidebar
// row does: `threadSelection`) or a settings section, back and forward, the sidebar and side panel toggles, the composer's focus, the
// rename dialog of the chat the window shows (`rename-thread`, the command its overflow menu registers); the app's own sidebar actions
// run in that window (a project group's collapse and show-all: E7.1); and what only main can do: bringing the window to the front, and
// closing it (the app's own close handler then hides its last window on macOS, or asks first when the user set it to); a new window,
// asked of a window's page (its preload sends the app's own request). A message tells the page and says nothing back: the Host's caller
// sees the effect in the window's presentations.
const { randomUUID } = require('node:crypto');
const kit = require('../area-kit.cjs');

const THREAD_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SECTION = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;   // a mod's page, `<mod>/<id>` (layouts.md D7)
const MESSAGES = { back: 'navigate-back', forward: 'navigate-forward', toggleSidebar: 'toggle-sidebar', togglePanel: 'toggle-diff-panel', focusComposer: 'focus-composer', renameThread: 'rename-thread', newChat: 'new-chat' };
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** The app's actions a window runs for the graph (`appAction`), each with the arguments it takes beside its project. */
const APP_ACTIONS = { 'windows.sidebar.project_set_collapsed': 'collapsed', 'windows.sidebar.project_set_show_all': 'showAll' };
const FILE_PATH = /^\/[^\0]{0,4095}$/;
const NEW_WINDOW_PATH = /^\/(?:local\/[A-Za-z0-9._:-]{1,200})?$/;   // the app's home, or a chat (what the preload sends, framework/preload)
/** The panel's tab for a file or the review (`windows.tabs.open`): its target, checked, or null. */
const tabTarget = (t) => (t && t.type === 'file' && typeof t.path === 'string' && FILE_PATH.test(t.path) ? { type: 'file', path: t.path }
  : t && t.type === 'review' ? { type: 'review' } : null);

function register(hooks) {
  hooks.onAreaOp('windows', async (op, args = {}) => {
    // The window the user is in (a mod's Dialog opens there): the focused app window, else the one focused last; null when none is open.
    if (op === 'focused') {
      return { windowId: hooks.electron && typeof hooks.electron.focusedWindow === 'function' ? hooks.electron.focusedWindow() : null,
        ...(hooks.electron && typeof hooks.electron.appFocused === 'function' ? { appFocused: hooks.electron.appFocused() === true } : {}) };
    }
    // A new window, the app's own way (App.openWindow): a window's page (the one named, else the one the user is in) sends the app's
    // main its own request for one, on a chat's path or the app's home; the window comes as the app opens it (window/created).
    if (op === 'newWindow') {
      if (typeof args.path !== 'string' || !NEW_WINDOW_PATH.test(args.path)) throw kit.refusal('a chat\'s path or the app\'s home is needed');
      const e = hooks.electron;
      const from = Number.isSafeInteger(args.windowId) ? args.windowId : e && typeof e.focusedWindow === 'function' ? e.focusedWindow() : null;
      if (!Number.isSafeInteger(from) || !e || typeof e.hasWindow !== 'function' || !e.hasWindow(from)) throw kit.refusal('no window of the app is open to ask');
      e.postToWindow(from, 'codexmods:new-window', { path: args.path });
      return {};
    }
    const winId = args && args.windowId;
    if (!Number.isSafeInteger(winId)) throw kit.refusal('a window id is needed');
    if (!hooks.electron || typeof hooks.electron.hasWindow !== 'function' || !hooks.electron.hasWindow(winId)) throw kit.refusal('the window is not open');
    if (op === 'focus') {
      if (!hooks.electron.focusWindow(winId)) throw kit.refusal('the window is not open');
      return {};
    }
    if (op === 'close') {
      if (typeof hooks.electron.closeWindow !== 'function' || !hooks.electron.closeWindow(winId)) throw kit.refusal('the window is not open');
      return {};
    }
    if (op === 'palette') {   // the command palette, searching for a query when given (the app's own message, which opens it on that search)
      if (args.query !== undefined && (typeof args.query !== 'string' || !args.query || args.query.length > 500)) throw kit.refusal('a query of 1 to 500 characters');
      kit.postToView(hooks, winId, { type: 'command-menu', ...(args.query !== undefined ? { query: args.query } : {}) });
      return {};
    }
    if (op === 'openBrowser') {   // a page in a new tab of the window's in-app browser (the app's own message, as a link it opens there)
      if (typeof args.url !== 'string' || args.url.length > 4096 || !/^https?:\/\//i.test(args.url)) throw kit.refusal('an http or https URL is needed');
      const browserTabId = randomUUID();   // the tab's id, named here: the caller waits for this tab, not any new one
      kit.postToView(hooks, winId, { type: 'open-browser-tab', source: 'manual', initialUrl: args.url, active: true, browserTabId });
      return { browserTabId };
    }
    if (op === 'setPanel') {   // the right panel open or closed (the app's own toggle, told which)
      if (typeof args.open !== 'boolean') throw kit.refusal('open or closed (a boolean) is needed');
      kit.postToView(hooks, winId, { type: 'toggle-diff-panel', open: args.open, codexmods: true });   // not the user's (layouts.md D11)
      return {};
    }
    if (op === 'appAction' && args.action && args.action.type === 'windows.tabs.open') {
      const target = args.action.windowId === 'current' ? tabTarget(args.action.target) : null;
      if (!target) throw kit.refusal('not an action a window runs for the graph');
      await kit.appActionIn(hooks, winId, { type: 'windows.tabs.open', windowId: 'current', target });
      return {};
    }
    if (op === 'appAction') {
      const a = args.action;
      const flag = a && Object.hasOwn(APP_ACTIONS, a.type) ? APP_ACTIONS[a.type] : null;
      if (!flag || a.windowId !== 'current' || !a.project || typeof a.project.projectId !== 'string' || !PROJECT_ID.test(a.project.projectId) || typeof a[flag] !== 'boolean') {
        throw kit.refusal('not an action a window runs for the graph');
      }
      await kit.appActionIn(hooks, winId, { type: a.type, windowId: 'current', project: { projectId: a.project.projectId }, [flag]: a[flag] });
      return {};
    }
    if (op === 'open') {
      if (typeof args.threadId === 'string' && THREAD_ID.test(args.threadId)) {
        kit.postToView(hooks, winId, { type: 'navigate-to-route', path: `/local/${args.threadId}`, threadSelection: { kind: 'local', conversationId: args.threadId, hostId: 'local' } });
        return {};
      }
      if (typeof args.settings === 'string' && SECTION.test(args.settings)) { kit.navigate(hooks, winId, `/settings/${args.settings}`); return {}; }
      if (typeof args.page === 'string' && PAGE.test(args.page)) {
        // only where the app's route tree has the framework's route: a path with no route blanks the window
        if (!hooks.adapter?.seams?.hooks?.pageRoute) throw kit.refusal('this build has no route for a mod\'s page');
        kit.navigate(hooks, winId, `/codexmods/page/${args.page}`);
        return {};
      }
      throw kit.refusal('open takes a thread id, a settings section or a mod\'s page');
    }
    if (!Object.hasOwn(MESSAGES, op)) throw kit.refusal(`unknown operation ${op}`);
    kit.postToView(hooks, winId, { type: MESSAGES[op], codexmods: true });   // a mod's or the framework's, not the user's (layouts.md D11)
    return {};
  });
}

module.exports = { register };
