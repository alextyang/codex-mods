'use strict';
// The held windows' in-app browser services (breadth D8). The manager's checked fields supply the tabs of every window.
const kit = require('../area-kit.cjs');

function register(hooks) {
  const subscriptions = new Map();
  let logged = false, reportedAt = -Infinity;
  function warn(error) {
    if (logged) return;
    logged = true;
    try { hooks.log?.warn('browser: the browser could not be observed', { message: String(error?.message ?? error) }); } catch { /* never break the app */ }
  }
  function bind() {
    try {
      const services = new Set();
      for (const w of hooks.appHost?.windows?.() ?? []) {
        try {
          const service = w.host?.services?.browserTabs;
          if (!service || typeof service.subscribeInvalidations !== 'function') continue;
          services.add(service);
          if (subscriptions.has(service)) continue;
          const entry = { active: true, remove: null };
          const cb = () => {
            try {
              if (!entry.active || Date.now() - reportedAt < 500) return;
              reportedAt = Date.now();
              hooks.areaReport('browser', { event: 'invalidated' });
            } catch (e) { warn(e); }
          };
          cb.dup = () => cb;
          cb.onRpcBroken = () => {};
          cb[Symbol.dispose] = () => {};
          subscriptions.set(service, entry);
          entry.remove = service.subscribeInvalidations(cb);
        } catch (e) { warn(e); }
      }
      for (const [service, entry] of subscriptions) {
        if (services.has(service)) continue;
        subscriptions.delete(service);
        entry.active = false;
        try { if (typeof entry.remove === 'function') entry.remove(); } catch (e) { warn(e); }
      }
    } catch (e) { warn(e); }
  }
  try { hooks.appHost?.subscribe?.(bind); } catch (e) { warn(e); }
  bind();

  hooks.onAreaOp('browser', async (op, args = {}) => {
    if (op === 'tabs') {
      const manager = hooks.appHost?.first?.()?.host?.services?.browserHost?.browserHostManager;
      if (!(manager?.windows instanceof Map)) {
        warn('the app has no browser manager');
        return { tabs: [] };
      }
      const tabs = [];
      for (const window of manager.windows.values()) {
        if (!(window?.threads instanceof Map)) continue;
        for (const page of window.threads.values()) {
          if (!page || page.pendingTeardown || typeof page.conversationId !== 'string' || !page.conversationId
            || typeof page.browserTabId !== 'string' || !page.browserTabId) continue;
          const snapshot = page.snapshot;
          if (!snapshot || typeof snapshot !== 'object') continue;
          tabs.push({ conversationId: page.conversationId, threadId: kit.threadIdOf(hooks, page.conversationId), browserTabId: page.browserTabId,
            url: typeof snapshot.url === 'string' ? snapshot.url : '', title: typeof snapshot.title === 'string' ? snapshot.title : '',
            loading: snapshot.isLoading === true, canGoBack: snapshot.canGoBack === true, canGoForward: snapshot.canGoForward === true,
            agent: page.isBrowserUsePage === true });
        }
      }
      return { tabs };
    }
    if (op === 'command' || op === 'close') {
      for (const key of ['conversationId', 'browserTabId']) {
        if (typeof args?.[key] !== 'string' || !args[key].trim() || args[key].length > 200) throw kit.refusal(`a ${key} of at most 200 characters is needed`);
      }
      const { conversationId, browserTabId } = args;
      if (op === 'close') {
        for (const w of hooks.appHost?.windows?.() ?? []) kit.postToView(hooks, w.id, { type: 'close-browser-tab', browserTabId, conversationId });
        return {};
      }
      const type = args.command?.type;
      if (!['navigate', 'reload', 'go-back', 'go-forward'].includes(type)) throw kit.refusal('an available browser command is needed');
      const command = { type };
      if (type === 'navigate') {
        const url = args.command.url;
        let parsed;
        try { if (typeof url === 'string' && url.length <= 8_000) parsed = new URL(url); } catch { /* refused below */ }
        if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) throw kit.refusal('an https or http URL of at most 8000 characters is needed');
        Object.assign(command, { url, hostId: 'local', source: 'manual', initiator: 'toggle_browser_command' });
      }
      let answer = 'page-unavailable';
      for (const w of hooks.appHost?.windows?.() ?? []) {
        const service = w.host?.services?.browserHost;
        if (typeof service?.runPageCommand !== 'function') continue;
        answer = await kit.withTimeout(service.runPageCommand({ conversationId, browserTabId, command }));
        if (answer === 'accepted') return {};
        if (answer !== 'wrong-window') break;
      }
      throw kit.refusal(String(answer));
    }
    if (op === 'open-external') {
      if (typeof hooks.electron?.openExternal !== 'function') throw kit.refusal('the default browser cannot be reached');
      await kit.withTimeout(hooks.electron.openExternal(args?.url));
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
