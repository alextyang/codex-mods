'use strict';
// Observe the app's shared desktop notification manager; operations use the held window's own services.
const kit = require('../area-kit.cjs');
const { userHoldsOf } = require('../user-holds.cjs');
const WRAPPED = Symbol.for('codexmods.notifications.observer');

function register(hooks) {
  let bound = null, logged = false;
  // the app's own notification held before it shows (public-hooks.md §3.5): only while the Host says something holds App.notify, so a
  // notification nothing intercepts shows at once, as before (and is reported after while a mod observes it)
  const holds = userHoldsOf(hooks);
  const APP = { type: 'App', provider: 'codex', id: 'codex' }, NOTIFY = 'App.notify';
  const noticeOf = (payload) => ({ title: typeof payload?.title === 'string' ? payload.title : '', ...(typeof payload?.body === 'string' ? { body: payload.body } : {}),
    ...(typeof payload?.kind === 'string' ? { kind: payload.kind } : {}),
    ...(typeof payload?.conversationId === 'string' ? { thread: { type: 'CodexThread', provider: 'codex', id: payload.conversationId } } : {}) });
  function warn(error) {
    if (logged) return;
    logged = true;
    try { hooks.log?.warn('notifications: observation failed', { message: String(error?.message ?? error) }); } catch { /* observation never breaks the app */ }
  }
  function wrap(manager) {
    if (manager[WRAPPED]) return;
    const originals = { showNotification: manager.showNotification, createNotification: manager.createNotification };
    const remembered = new Map();
    manager[WRAPPED] = originals;
    manager.showNotification = function (payload, ..._rest) {
      let data = null;
      try {
        data = { at: Date.now() };
        for (const key of ['id', 'kind', 'title', 'body', 'conversationId', 'requestId']) {
          const value = payload?.[key];
          data[key] = typeof value === 'string' ? value : null;
        }
        remembered.delete(data.id);
        remembered.set(data.id, data);
        if (remembered.size > 200) remembered.delete(remembered.keys().next().value);
      } catch (e) { warn(e); }
      if (!holds.held(NOTIFY)) {
        const r = originals.showNotification.apply(this, arguments);
        if (holds.observed(NOTIFY)) holds.did({ ref: APP, operation: 'notify', args: [noticeOf(payload)], origin: 'app', outcome: { status: 'done' } });
        return r;
      }
      // held: the mods' interceptors and policies decide first; it shows as they leave it (its title and body), or not at all
      const self = this, rest = Array.prototype.slice.call(arguments, 1);
      return holds.ask({ prefix: 'un', ref: APP, operation: 'notify', args: [noticeOf(payload)], origin: 'app' }).then((a) => {
        if (a.go === false) { try { hooks.log?.info('notifications: kept from showing', { kind: payload?.kind ?? null, why: a.handled ? 'a mod showed it' : String(a.message ?? '') }); } catch { /* logging only */ } return undefined; }
        const changed = Array.isArray(a.args) && a.args[0] && typeof a.args[0] === 'object' ? a.args[0] : null;
        // a change names who made it, in the framework's words, where it shows (public-hooks.md §3.7)
        const by = Array.isArray(a.changedBy) && a.changedBy.length
          ? `Changed by ${a.changedBy.map((c) => `${c.name ?? c.mod}${c.policy ? ` (${c.policy})` : ''}`).join(', ')}` : null;
        const body = changed && typeof changed.body === 'string' ? changed.body : payload?.body;
        const shown = changed ? { ...payload, ...(typeof changed.title === 'string' ? { title: changed.title } : {}), ...(by ? { body: typeof body === 'string' && body ? `${body}\n${by}` : by } : typeof changed.body === 'string' ? { body: changed.body } : {}) } : payload;
        if (changed && data) { data.title = typeof shown.title === 'string' ? shown.title : data.title; data.body = typeof shown.body === 'string' ? shown.body : data.body; }   // reported as shown
        let r;
        try { r = originals.showNotification.call(self, shown, ...rest); } catch (e) { holds.done(a.requestId, { status: 'failed', error: { message: String(e?.message ?? e) } }); throw e; }
        holds.done(a.requestId, { status: 'done' });
        return r;
      });
    };
    manager.createNotification = function (...args) {
      const notification = originals.createNotification.apply(this, args);
      try {
        let opened = false;
        function report(event) {
          try {
            for (const [id, entry] of manager.notifications) {
              if (entry?.notification !== notification) continue;
              const payload = remembered.get(id);
              if (payload) hooks.areaReport('notifications', { event, notification: payload });
              return;
            }
          } catch (e) { warn(e); }
        }
        notification.on('show', () => report('shown'));
        notification.on('click', () => { opened = true; report('opened'); });
        notification.on('action', () => { opened = true; report('opened'); });
        notification.on('close', () => { if (!opened) report('dismissed'); });
      } catch (e) { warn(e); }
      return notification;
    };
  }
  function bind() {
    try {
      if (bound) return;
      for (const w of hooks.appHost?.windows?.() ?? []) {
        const manager = w.host?.services?.notifications?.desktopNotificationManager;
        if (!manager || typeof manager.showNotification !== 'function' || typeof manager.createNotification !== 'function') continue;
        wrap(manager);
        bound = { winId: w.id };
        return;
      }
    } catch (e) { warn(e); }
  }
  hooks.appHost?.subscribe?.((e) => {
    if (e.type === 'removed' && bound?.winId === e.id) bound = null;
    bind();
  });
  bind();

  hooks.onAreaOp('notifications', async (op, args = {}) => {
    // a mod's notification (public-hooks.md §3.14): the app's own desktop notification, by the app's manager's own show (never held as the
    // app's: it is the mod's); its buttons and a click on it go to the Host, and so does its going
    if (op === 'show') {
      if (typeof args?.id !== 'string' || !args.id.startsWith('codexmods:') || args.id.length > 200) throw kit.refusal('a mod notification\'s id is needed');
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200) throw kit.refusal('a title of at most 200 characters is needed');
      const actions = Array.isArray(args.actions) ? args.actions.slice(0, 4).filter((a) => a && typeof a.id === 'string' && typeof a.title === 'string') : [];
      const { winId, svc } = kit.service(hooks, 'notifications', ['hide']);
      const manager = svc.desktopNotificationManager;
      const show = manager?.[WRAPPED]?.showNotification ?? manager?.showNotification;
      if (typeof show !== 'function') throw kit.refusal('the app\'s notifications are not available here');
      // the window it belongs to (the app's manager reads its web contents): the one whose services show it
      const target = hooks.appHost?.senderOf?.(winId) ?? null;
      if (!target) throw kit.refusal('no app window to show it from');
      const tell = (msg) => { try { hooks.sendToHost(msg); } catch { /* the Host went */ } };
      show.call(manager, { id: args.id, kind: 'codexmods', title: args.title, body: typeof args.body === 'string' ? args.body.slice(0, 2000) : '',
        actions: actions.map((a) => ({ id: a.id, title: a.title.slice(0, 40), actionType: 'button' })) }, target,
      (e) => { tell({ type: 'notice-action', id: args.id, action: e?.actionType === 'open' ? null : (typeof e?.actionId === 'string' ? e.actionId : null) }); return undefined; },
      () => tell({ type: 'notice-gone', id: args.id }));
      return {};
    }
    if (op !== 'open' && op !== 'dismiss') throw kit.refusal(`unknown operation ${op}`);
    if (typeof args?.id !== 'string' || !args.id.trim() || args.id.length > 400) throw kit.refusal('a notification id of at most 400 characters is needed');
    if (op === 'open' && typeof args.conversationId === 'string') {
      await kit.appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId: args.conversationId });
    }
    const { svc } = kit.service(hooks, 'notifications', ['hide']);
    await kit.withTimeout(svc.hide({ notificationId: args.id }));
    return {};
  });
}

module.exports = { register };
