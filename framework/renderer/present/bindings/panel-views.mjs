// The panel's views (docs/graph/03 TerminalView, BrowserView; systems.md E7.5, from a scout of 21477). Their tabs are created outside the JSX seam, so each binding sits on the view the tab renders. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeList, actionNode, siblingRegion, besideOnce } from './slots.mjs';

const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);

// A local terminal (its panel: the component whose props carry its session and its key events) presents its Terminal (the session id is
// the native provider's id); its toolbar is regions beside it, rendered by its outermost mount (the panel passes its props on whole to
// the terminal inside it, a second and third mount of the same binding) and never remounting the terminal. Focusing it and copying its
// selection (E7.2b) are its xterm's own, through the app's terminal manager (exposed as `terminalManager`: its renderers by session id);
// the copy goes to the clipboard the way the app's own copy key does.
const terminalOf = (props, ctx) => {
  const r = ctx.exports?.()?.terminalManager?.renderers?.get?.(props.sessionId);
  const t = r && r.terminal;
  return t && typeof t.focus === 'function' && typeof t.getSelection === 'function' ? t : null;
};
export const terminalView = defineBinding({
  id: 'terminal.view', presentation: 'TerminalView',
  presents: ['Terminal'],
  place: (props) => (typeof props.sessionId === 'string' && props.sessionId ? { in: 'PanelTab', on: { type: 'Terminal', provider: 'codex', id: props.sessionId }, slot: 'view' } : { in: null, slot: 'view' }),
  subject: (props) => (typeof props.sessionId === 'string' && props.sessionId && (props.hostId == null || props.hostId === 'local') ? { type: 'Terminal', provider: 'codex', id: props.sessionId } : null),
  slots: { toolbar: siblingRegion() },
  operations: {
    focus(props, args, ctx) {
      const t = terminalOf(props, ctx);
      if (!t) return { unavailable: 'the terminal is not shown yet' };
      t.focus();
      return true;
    },
    copySelection(props, args, ctx) {
      const t = terminalOf(props, ctx);
      if (!t) return { unavailable: 'the terminal is not shown yet' };
      const text = t.getSelection();
      if (typeof text !== 'string' || !text) return { unavailable: 'nothing is selected in the terminal' };
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return { unavailable: 'the clipboard is not available' };
      return clipboard.writeText(text).then(() => true);
    },
  },
  render(Original, props, factory, ctx) {
    const R = ctx.react();
    return R ? besideOnce(R, 'terminal.view', factory, Original, props) : undefined;
  },
});

// The in-app browser's view (the component whose props carry its tab's id and its web contents' ref) presents its BrowserTab
// (`<thread>:<tab>`, as the native provider names it): its toolbar is the address bar's row (`toolbar`), and focusing it is the app's own
// call on its web contents.
const browserTab = (props, ctx) => {
  const thread = typeof props.conversationId === 'string' && props.conversationId ? ctx.thread(props.conversationId) : null;
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own browser tabs
  return thread && thread.provider === 'codex' && typeof props.browserTabId === 'string' && props.browserTabId ? { type: 'BrowserTab', provider: 'codex', id: `${thread.id}:${props.browserTabId}` } : null;
};
export const browserView = defineBinding({
  id: 'browser.view', presentation: 'BrowserView',
  presents: ['BrowserTab'],
  place: { in: null, slot: 'view' },
  subject: browserTab,
  slots: { toolbar: nodeList('toolbar', action, { field: 'actions' }) },
  operations: {
    focus(props) {
      const wc = props.webContentsRef && props.webContentsRef.current;
      if (!wc || typeof wc.focus !== 'function') return { unavailable: 'the page is not shown yet' };
      wc.focus();
      return true;
    },
  },
});
