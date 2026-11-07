'use strict';
// Shared pieces for framework-main's feature-area modules (breadth.md D5, D10; index.cjs `onAreaOp`): the services of the window an
// operation runs in, the app's own refresh of its pages after a change made outside them, and opening one of its pages.
// - `refusal(message)`: an error that says nothing was tried (the Host reports the operation refused, not failed).
// - `windowServices(hooks)`: the first live window's id and AppHost services (`host.services`), or a refusal.
// - `service(hooks, name, methods)`: one service of that window with the methods named, or a refusal naming what is missing.
// - `invalidate(hooks, queryKeys)`: the app's own refresh (21477: the AppHost service `queryCache.invalidateQueryCache({queryKey, reset})`,
//   which every open page applies as a prefix match; main uses it itself after the config writes it makes). Protocol writes made through
//   the Host are not pushed to the app's pages (they cache config and MCP status for minutes and plugin lists for hours): an area module
//   calls this after each change. Keys must start with one of KEY_ROOTS.
// - `clearPrewarmed(hooks)`: every window's prewarmed new chats dropped (21477: its AppView's service
//   `clientCoordination.clearPrewarmedThreads({hostId})`, as the app's main does after a change its prewarmed threads would not see): the
//   next new chat starts with the settings as they are now. Best effort: a window that does not answer keeps its own.
// - `navigate(hooks, winId, path, state?)`: open one of the app's pages in the window, as the app's main does (`navigate-to-route` on its
//   channel to its pages, which the census of every supported build checks).
// - `postToView(hooks, winId, message)`: any host message the app's main sends its pages (21477: `run-command`, `focus-composer`,
//   `codex-micro-insert-composer-text`, `add-context-file`, ...: breadth.md D5 scout).
// - `runCommand(hooks, winId, id)`: one of the app's commands, as its menu runs it (`run-command {id}`): it acts only where a mounted
//   component handles it, and says nothing otherwise, so a caller checks the effect.
// - `appAction(hooks, action)`: one of the app's own actions in its primary window (AppHost `appActions.runInPrimaryWindow({action})`).
// - `globalState(hooks)`: the app's global state store (the projects manager's `globalState`: `get(key)`, `onDidChange(key, fn)`).
// - `threadIdOf(hooks, conversationId)`: the thread a page's conversation id names. A chat begun in this profile keeps the client id it
//   had before it was created (`client-new-thread:<uuid>`) in its page; the app maps the thread to it in its persisted-atom state
//   (`thread-client-id-v1:` + encodeURIComponent('local:' + threadId)). Any other id is the thread's own; an unknown client id is null.
// - `followerRequest(hooks, threadId, method, params, ms?)`: one of the app's thread-follower requests (21477: `thread-follower-edit-last-
//   user-turn`, ...), run by the window whose page owns the chat, as the app's main sends them (its owner lookup `getThreadOwnerView`): each
//   window's AppView `services.clientCoordination.getThreadRole({hostId, conversationId})` answers `owner` for that window, and its
//   `requestThreadFollower({hostId, request: {method, params}})` runs the request there and answers `{method, result}`. When no window owns
//   the chat, it is shown (`windows.show_thread`, as opening it does) and the windows are asked again for a while. Answers the `result`; the
//   app's own error is thrown as it is. The AppView is Cap'n Web RPC: calls are pipelined on `services` and disposed after, as the app does.
// - `withTimeout(promise, ms?)`.

const VIEW_CHANNEL = 'codex_desktop:message-for-view';
const OP_TIMEOUT_MS = 15_000;
const HOST_ID = 'local';   // the app's own host (the Mac it runs on)
const OWNER_WAIT_MS = 8_000;
const KEY_ROOTS = new Set(['config', 'user-saved-config', 'mcp', 'skills', 'plugins', 'apps', 'recommendedSkills', 'experimental-features', 'hooks', 'vscode']);

function refusal(message) {
  const e = new Error(message);
  e.refused = true;
  return e;
}

function windowServices(hooks) {
  const w = hooks.appHost && typeof hooks.appHost.first === 'function' ? hooks.appHost.first() : null;
  const s = w && w.host && w.host.services;
  if (!s) throw refusal('the app has no window');
  return { winId: w.id, services: s };
}

function service(hooks, name, methods = []) {
  const { winId, services } = windowServices(hooks);
  const svc = services[name];
  if (!svc || typeof svc !== 'object') throw refusal(`the app has no ${name} service`);
  for (const m of methods) if (typeof svc[m] !== 'function') throw refusal(`the app's ${name} service has no ${m}`);
  return { winId, svc };
}

function withTimeout(p, ms = OP_TIMEOUT_MS) {
  let t = null;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`the app did not answer in ${ms} ms`)), ms); if (t.unref) t.unref(); }),
  ]);
}

async function invalidate(hooks, queryKeys) {
  const keys = (Array.isArray(queryKeys) ? queryKeys : []).filter((k) => Array.isArray(k) && k.length > 0 && KEY_ROOTS.has(k[0]));
  if (!keys.length) return 0;
  const { svc } = service(hooks, 'queryCache', ['invalidateQueryCache']);
  for (const queryKey of keys) await withTimeout(svc.invalidateQueryCache({ queryKey, reset: false }));
  return keys.length;
}

async function clearPrewarmed(hooks) {
  const windows = hooks.appHost && typeof hooks.appHost.windows === 'function' ? hooks.appHost.windows() : [];
  let cleared = 0;
  for (const w of windows) {
    const svc = w?.view?.services?.clientCoordination;
    if (!svc || typeof svc.clearPrewarmedThreads !== 'function') continue;
    try { await call(svc.clearPrewarmedThreads({ hostId: HOST_ID }), 5000); cleared++; } catch { /* that window keeps its own */ }
  }
  return cleared;
}

function postToView(hooks, winId, message) {
  if (!hooks.electron || typeof hooks.electron.postToWindow !== 'function') throw refusal('the app\'s pages cannot be reached');
  hooks.electron.postToWindow(winId, VIEW_CHANNEL, message);
}

function navigate(hooks, winId, path, state) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw refusal('a page path is needed');
  postToView(hooks, winId, { type: 'navigate-to-route', path, ...(state && typeof state === 'object' ? { state } : {}) });
}

function runCommand(hooks, winId, id) {
  if (typeof id !== 'string' || !id) throw refusal('a command id is needed');
  postToView(hooks, winId, { type: 'run-command', id });
}

async function appAction(hooks, action) {
  const { svc } = service(hooks, 'appActions', ['runInPrimaryWindow']);
  return withTimeout(svc.runInPrimaryWindow({ action }));
}

/** One of the app's actions run in the given window (its AppView's own `appActions.run`), not in the app's primary window (E7.1). */
async function appActionIn(hooks, winId, action) {
  const w = (hooks.appHost && typeof hooks.appHost.windows === 'function' ? hooks.appHost.windows() : []).find((x) => x.id === winId);
  const services = w && w.view && w.view.services;
  if (!services || !services.appActions || typeof services.appActions.run !== 'function') throw refusal('the window\'s actions cannot be reached (the adapter pack is older)');
  return call(services.appActions.run({ action }), 10_000);   // the envelope main's own runInPrimaryWindow hands it
}

function globalState(hooks) {
  const { services } = windowServices(hooks);
  const store = services.projects && services.projects.globalState;
  if (!store || typeof store.get !== 'function') throw refusal('the app\'s global state is not available');
  return store;
}

const CLIENT_PREFIX = 'client-new-thread:';
const CLIENT_KEY = 'thread-client-id-v1:';
function threadIdOf(hooks, conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return null;
  if (!conversationId.startsWith(CLIENT_PREFIX)) return conversationId;
  let atoms;
  try { atoms = globalState(hooks).get('electron-persisted-atom-state'); } catch { return null; }
  if (!atoms || typeof atoms !== 'object') return null;
  for (const [key, value] of Object.entries(atoms)) {
    if (value !== conversationId || !key.startsWith(CLIENT_KEY)) continue;
    const local = decodeURIComponent(key.slice(CLIENT_KEY.length));
    if (local.startsWith('local:')) return local.slice('local:'.length);
  }
  return null;
}

const release = (p) => { try { if (p && typeof p.then === 'function') p.then((x) => x?.[Symbol.dispose]?.(), () => undefined); } catch { /* gone */ } };
async function call(p, ms) {
  try { return await withTimeout(p, ms); } finally { try { p?.[Symbol.dispose]?.(); } catch { /* settled or gone */ } }
}

/** The window whose page owns the chat, with its services (to release once used), or null. */
async function threadOwner(hooks, threadId) {
  const windows = hooks.appHost && typeof hooks.appHost.windows === 'function' ? hooks.appHost.windows() : [];
  for (const w of windows) {
    const services = w.view && w.view.services;
    if (!services) continue;
    let role = null;
    try { role = await call(services.clientCoordination.getThreadRole({ hostId: HOST_ID, conversationId: threadId }), 3_000); } catch { /* a window that is closing or not ready */ }
    if (role === 'owner') return { winId: w.id, services };
    release(services);
  }
  return null;
}

async function followerRequest(hooks, threadId, method, params, ms = 30_000) {
  if (typeof threadId !== 'string' || !threadId) throw refusal('a thread id is needed');
  let owner = await threadOwner(hooks, threadId);
  if (!owner) {
    if (!(hooks.appHost?.windows?.() ?? []).some((w) => w.view)) throw refusal('the app\'s windows cannot be reached for this (the adapter pack is older)');
    await appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId });
    for (const until = Date.now() + OWNER_WAIT_MS; !owner && Date.now() < until;) {
      await new Promise((r) => { const t = setTimeout(r, 250); if (t.unref) t.unref(); });
      owner = await threadOwner(hooks, threadId);
    }
    if (!owner) throw refusal('no window of the app holds the chat');
  }
  try {
    const answer = await call(owner.services.clientCoordination.requestThreadFollower({ hostId: HOST_ID, request: { method, params } }), ms);
    return answer && typeof answer === 'object' ? answer.result : undefined;
  } finally { release(owner.services); }
}

module.exports = { refusal, windowServices, service, withTimeout, invalidate, clearPrewarmed, navigate, postToView, runCommand, appAction, appActionIn, globalState, threadIdOf, followerRequest, VIEW_CHANNEL, KEY_ROOTS };
