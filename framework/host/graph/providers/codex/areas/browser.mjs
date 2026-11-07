// Tabs beside chats, read and operated through the app's in-app browser (breadth D8).
import { isDeepStrictEqual } from 'node:util';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['BrowserTab'],
  operations: { BrowserTab: ['navigate', 'reload', 'back', 'forward', 'close', 'openExternally'] },
  events: { BrowserTab: ['navigated', 'loaded', 'closed'] },
  links: { BrowserTab: ['thread'] },
};

export function tabData(tab, { thread }) {
  return { ref: refs.browserTab(tab.conversationId, tab.browserTabId), state: {
    url: tab.url, title: tab.title, loading: tab.loading, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward,
    controlledBy: tab.agent ? 'agent' : 'you',
  }, links: { thread } };
}

export function types(feed) {
  return { BrowserTab: { operations: {
    navigate: { effect: 'external', approval: ({ ref, args }) => feed().prompt(ref, args[0]), handler: ({ ref, args }) => feed().run(ref, 'navigate', args[0]) },
    reload: { effect: 'local', handler: ({ ref }) => feed().run(ref, 'reload') },
    back: { effect: 'local', handler: ({ ref }) => feed().run(ref, 'back') },
    forward: { effect: 'local', handler: ({ ref }) => feed().run(ref, 'forward') },
    close: { effect: 'local', handler: ({ ref }) => feed().run(ref, 'close') },
    openExternally: { effect: 'local', handler: ({ ref }) => feed().run(ref, 'openExternally') },
  } } };
}

const refused = (reason, message) => ({ status: 'refused', reason, message });
function validUrl(url) {
  if (typeof url !== 'string' || url.length > 8_000) return false;
  try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; }
}

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  let tabs = new Map(), reading = null, again = false, timer = null, debounce = null, disposed = false, heard = false, finishedAt = -Infinity;

  function apply(rows) {
    if (disposed) return;
    const next = new Map();
    for (const tab of rows) {
      // A chat begun in this profile names its tabs by its client id: framework-main gives the thread it maps to.
      const thread = refs.thread(tab.threadId ?? tab.conversationId), data = tabData(tab, { thread: ctx.resident(thread) ? thread : null });
      const before = tabs.get(data.ref.id);
      if (!before || !isDeepStrictEqual(before.data, data) || !ctx.resident(data.ref)) {
        ctx.safe('browser tab', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
      }
      next.set(data.ref.id, { tab, data });
      if (heard && before) {
        if (before.data.state.url !== data.state.url) ctx.emitEvent(data.ref, 'navigated');
        if (before.data.state.loading && !data.state.loading) ctx.emitEvent(data.ref, 'loaded');
      }
    }
    for (const [id, { data }] of tabs) if (!next.has(id)) {
      ctx.safe('browser tab removal', () => ctx.handle.remove(data.ref));
      ctx.emitEvent(data.ref, 'closed');
    }
    tabs = next;
    heard = true;
  }

  // A call during a read shares its promise and queues one more pass. Failures keep the last good instances.
  function read() {
    if (disposed) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        try {
          const r = await ctx.mainOp('tabs', {});
          if (!r.ok) throw new Error(r.error);
          if (!Array.isArray(r.result?.tabs)) throw new Error('the app did not return browser tabs');
          apply(r.result.tabs);
        } catch (e) { ctx.log.warn('browser: the tabs could not be read', { message: String(e?.message ?? e) }); }
        finally { finishedAt = now(); }
      } while (again && !disposed);
    })().finally(() => { reading = null; });
    return reading;
  }

  function plan(ref, op, url) {
    const entry = tabs.get(ref.id);
    if (disposed || !entry || !ctx.resident(ref)) return { no: refused('unavailable', 'the browser tab is gone') };
    if (op === 'navigate') {
      if (!validUrl(url)) return { no: refused('invalid', 'an https or http URL of at most 8000 characters is needed') };
      if (entry.tab.agent) return { no: refused('unavailable', 'Codex is using this tab') };
    }
    if (op === 'back' && !entry.tab.canGoBack) return { no: refused('unavailable', 'the tab cannot go back') };
    if (op === 'forward' && !entry.tab.canGoForward) return { no: refused('unavailable', 'the tab cannot go forward') };
    const { conversationId, browserTabId } = entry.tab;
    if (op === 'openExternally') return { entry, op: 'open-external', args: { url: entry.tab.url } };
    const args = { conversationId, browserTabId };
    if (op === 'close') return { entry, op: 'close', args };
    args.command = { type: op === 'back' ? 'go-back' : op === 'forward' ? 'go-forward' : op, ...(op === 'navigate' ? { url } : {}) };
    return { entry, op: 'command', args };
  }

  const reports = ctx.onMainReport((report) => {
    if (disposed || report?.event !== 'invalidated') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; read(); }, 300);
    debounce.unref?.();
  });

  return {
    read,
    start() {
      if (!disposed && !timer) { timer = setInterval(() => { read(); }, 15_000); timer.unref?.(); }
      return read();
    },
    observe(_ref, concept) {
      if (concept !== 'BrowserTab') return undefined;
      return reading ?? (now() - finishedAt > 5_000 ? read() : Promise.resolve());
    },
    prompt(ref, url) {
      const p = plan(ref, 'navigate', url);
      if (p.no) return null;
      return { action: `open ${url} in the browser tab “${p.entry.tab.title || p.entry.tab.url}”`,
        detail: 'The in-app browser loads it with its own sign-ins and cookies.' };
    },
    async run(ref, op, url) {
      const p = plan(ref, op, url);
      if (p.no) return p.no;
      try {
        const r = await ctx.mainOp(p.op, p.args);
        if (!r.ok) {
          if (r.refused) return refused('unavailable', r.error);
          throw new Error(r.error);
        }
        return null;
      } finally { await read(); }
    },
    dispose() { disposed = true; clearInterval(timer); clearTimeout(debounce); reports.dispose(); tabs.clear(); },
  };
}
