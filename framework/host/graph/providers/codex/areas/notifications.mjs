// The app's desktop notifications, observed by framework-main at the shared notification manager (breadth.md D9).
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Notification'],
  operations: { Notification: ['open', 'dismiss'] },
  supports: { Notification: ['source'] },
  events: { Notification: ['shown', 'opened', 'dismissed'] },
  links: {},
};

export function types(feed) {
  return { Notification: { operations: {
    open: { effect: 'local', handler: ({ ref }) => feed().open(ref) },
    dismiss: { effect: 'local', handler: ({ ref }) => feed().dismiss(ref) },
  } } };
}

export function notificationData(payload, { read, createdAt, failed }) {
  const kind = payload.kind === 'turn-complete' ? (failed ? 'failed' : 'finished')
    : payload.kind === 'permission' ? 'approval' : payload.kind === 'question' ? 'question' : 'other';
  return { ref: refs.notification(payload.id), state: {
    title: payload.title ?? '', body: payload.body ?? '', kind, createdAt, read,
    ...(payload.conversationId ? { source: refs.thread(payload.conversationId) } : {}),
  }, links: {} };
}

export function createFeed(ctx) {
  const notifications = new Map();
  let disposed = false;
  const missing = () => ({ status: 'refused', reason: 'unavailable', message: 'the notification is gone' });
  function put(entry) {
    const d = notificationData(entry.payload, entry);
    ctx.handle.put(d.ref, { state: d.state, links: d.links });
  }
  const reports = ctx.onMainReport((report) => {
    const { event, notification: payload } = report ?? {};
    if (disposed || !['shown', 'opened', 'dismissed'].includes(event) || typeof payload?.id !== 'string' || !payload.id) return;
    let entry = notifications.get(payload.id);
    if (!entry) {
      const latest = (payload.conversationId ? ctx.graph.related(refs.thread(payload.conversationId), 'turns') ?? [] : [])
        .sort((a, b) => b.state.startedAt - a.state.startedAt)[0];
      entry = { payload, createdAt: payload.at, read: false, failed: latest?.state.status === 'failed' };
      notifications.set(payload.id, entry);
    }
    if (event === 'opened' || event === 'dismissed') entry.read = true;
    put(entry);
    ctx.emitEvent(refs.notification(payload.id), event);
    for (const old of [...notifications.values()].sort((a, b) => b.createdAt - a.createdAt).slice(100)) {
      notifications.delete(old.payload.id);
      ctx.handle.remove(refs.notification(old.payload.id));
    }
  });

  async function act(ref, op) {
    const entry = notifications.get(ref.id);
    if (disposed || !entry || !ctx.resident(ref)) return missing();
    const r = await ctx.mainOp(op, { id: ref.id, ...(op === 'open' ? { conversationId: entry.payload.conversationId } : {}) });
    if (!r.ok) {
      if (r.refused) return { status: 'refused', reason: 'unavailable', message: r.error };
      throw new Error(r.error);
    }
    // A close report can arrive before the answer; an eviction while it runs must not put the notification back.
    if (!disposed && notifications.get(ref.id) === entry && ctx.resident(ref)) {
      entry.read = true;
      put(entry);
      if (op === 'dismiss') ctx.emitEvent(ref, 'dismissed');
    }
    return null;
  }
  return {
    open: (ref) => act(ref, 'open'),
    dismiss: (ref) => act(ref, 'dismiss'),
    dispose() { disposed = true; reports.dispose(); notifications.clear(); },
  };
}
