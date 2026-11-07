// A fake ElectronAdapter + MainHooks (contracts/main-hooks.d.ts) for the framework-main tests.
export function createFakeElectron({ appUrl = 'app://-/index.html' } = {}) {
  const calls = [];
  const handlers = new Map();
  const windowListeners = [];
  const posted = [];
  const ports = [];
  const e = {
    calls, handlers, posted, ports,
    app: { on() {}, getAppPath: () => '/app', quit() {}, relaunch() {}, exit() {} },
    session: { registerPreloadScript: (o) => calls.push(['registerPreloadScript', o]) },
    createChannel: () => { const c = { port1: { id: `p${ports.length}a` }, port2: { id: `p${ports.length}b` } }; ports.push(c); return c; },
    onWindowCreated: (fn) => windowListeners.push(fn),
    postToWindow: (windowId, channel, message, transfer) => posted.push({ windowId, channel, message, transfer }),
    handle: (channel, fn) => handlers.set(channel, fn),
    syncHandlers: new Map(),
    handleSync: (channel, fn) => e.syncHandlers.set(channel, fn),
    showOpenDialog: async (windowId, opts) => { calls.push(['showOpenDialog', windowId, opts]); return e.dialogResult ?? null; },
    showMessageBox: async () => 0,
    appUrl: () => appUrl,
    /** Test helper: a window appears. */
    addWindow(windowId, size = { width: 1000, height: 600 }) { const win = fakeWin(size); for (const fn of windowListeners) fn(win, windowId); return win; },
  };
  return e;
}

export function fakeWin(size) {
  const listeners = new Map();
  return {
    size: { ...size },
    getContentBounds() { return { x: 0, y: 0, ...this.size }; },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
    fire(ev) { for (const f of listeners.get(ev) ?? []) f(); },
    resize(width, height) { this.size = { width, height }; this.fire('resize'); },
  };
}

export function createFakeHooks({ adapter, electron = createFakeElectron(), safe = false } = {}) {
  const toHost = [];
  const bridged = [];
  const hostHandlers = new Map();
  const logs = { info: [], error: [] };
  return {
    electron, toHost, bridged, hostHandlers, logs,
    hooks: {
      electron, layout: {}, adapter, frameworkDir: '/fw', safe,
      sendToHost: (msg) => toHost.push({ msg }),
      bridgeRealm: (windowId, channel, port) => bridged.push({ windowId, channel, port }),
      onHostMessage: (type, fn) => hostHandlers.set(type, fn),
      log: { info: (m, d) => logs.info.push([m, d]), error: (m, d) => logs.error.push([m, d]) },
    },
    fromHost: (msg) => hostHandlers.get(msg.type)?.(msg),
  };
}
