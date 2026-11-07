// A thread's follow-up queue (breadth step D5): the app-server's queue, read on observation and thread/queue/changed. A complete list
// replaces this area's messages for the thread; its first read is a sync, later reads say what was queued, sent or removed. The server
// starts queued messages itself: a queued message is `sent` on the source's own signal, a user message whose `clientId` is the
// submission's `clientUserMessageId` (graph-integrity G1.2), whichever comes first; a removal without it is `removed`, which says nothing
// about why. Operations use the same queue methods as the app;
// sendNow steers a running turn before deleting the queued submission. A mod's enqueue, edit and sendNow ask the user first (R17).
import { randomUUID } from 'node:crypto';
import { refs, userContent, userInput } from '../map.mjs';

export const realizes = {
  types: ['QueuedMessage'],
  operations: { QueuedMessage: ['edit', 'sendNow', 'remove', 'move'], Thread: ['enqueue'] },
  events: { QueuedMessage: ['queued', 'sent', 'removed'] },
  links: { QueuedMessage: ['thread', 'attachments'] },
};

/** An app-server QueuedSubmission as a QueuedMessage. */
export function queuedData(threadId, submission) {
  return { ref: refs.queuedMessage(threadId, submission.id), state: { content: userContent(submission.input) }, links: { thread: refs.thread(threadId), attachments: [] } };
}

export function types(feed) {
  return {
    Thread: { operations: {
      enqueue: { effect: 'external', approval: ({ ref, args: [content] }) => feed().prompt('enqueue', ref, content), handler: ({ ref, args: [content], intent }) => feed().enqueue(ref, content, intent) },
    } },
    QueuedMessage: { operations: {
      edit: { effect: 'external', approval: ({ ref, args: [content] }) => feed().prompt('edit', ref, content), handler: ({ ref, args: [content], intent }) => feed().edit(ref, content, intent) },
      sendNow: { effect: 'external', approval: ({ ref }) => feed().prompt('sendNow', ref), handler: ({ ref, intent }) => feed().sendNow(ref, intent) },
      remove: { effect: 'external', handler: ({ ref, intent }) => feed().remove(ref, intent) },
      move: { effect: 'external', handler: ({ ref, args: [position], intent }) => feed().move(ref, position, intent) },
    } },
  };
}

const refused = (reason, message) => ({ status: 'refused', reason, message });
const missing = () => refused('unavailable', 'the message is no longer queued');
const empty = () => refused('invalid', 'the message is empty');
const threadOf = (ref) => ref.id.slice(0, ref.id.lastIndexOf(':'));
const capped = (m, max = 500) => { while (m.size > max) m.delete(m.keys().next().value); };

export function createFeed(ctx) {
  const queues = new Map();       // threadId -> submissions, in queue order (including their input and clientUserMessageId)
  const reading = new Map();      // threadId -> one read, with a further read when called while it runs
  const timers = new Map();       // threadId -> the debounced change notification
  const sentIds = new Map();      // `${threadId}\n${clientUserMessageId}` -> true: user messages the server started, by the client id they carry
  const gone = new Map();         // `${threadId}\n${clientUserMessageId}` -> the ref of a submission removed before its user message was seen
  const ephemeral = new Set();    // thread ids whose queue list was refused for being ephemeral
  let disposed = false;

  async function read(threadId, intent) {
    if (ctx.resident(refs.thread(threadId))?.state.archived === true || ephemeral.has(threadId)) return;
    try {
      const submissions = [];
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const r = await ctx.request('thread/queue/list', { threadId, cursor }, intent);
        if (disposed) return;
        submissions.push(...r.data);
        cursor = r.nextCursor ?? null;
        if (!cursor) break;
      }
      if (cursor) throw new Error('the queue list exceeds 20 pages');
      const previous = queues.get(threadId);
      const before = new Set((previous ?? []).map((s) => s.id));
      const keep = new Set(submissions.map((s) => s.id));
      for (const submission of submissions) {
        const d = queuedData(threadId, submission);
        ctx.safe('queued message', () => ctx.handle.put(d.ref, { state: d.state, links: d.links }));
        if (previous && !before.has(submission.id)) ctx.emitEvent(d.ref, 'queued');
      }
      for (const submission of previous ?? []) {
        if (keep.has(submission.id)) continue;
        const ref = refs.queuedMessage(threadId, submission.id);
        const key = `${threadId}\n${submission.clientUserMessageId}`;
        if (sentIds.has(key)) ctx.emitEvent(ref, 'sent');
        else { ctx.emitEvent(ref, 'removed'); gone.set(key, ref); capped(gone); }
        ctx.safe('queued message removal', () => ctx.handle.remove(ref));
      }
      queues.set(threadId, submissions);
    } catch (e) {
      const message = String(e?.message ?? e);
      if (/ephemeral thread/i.test(message)) { ephemeral.add(threadId); return; }
      ctx.log.warn('queue: the queue could not be read', { threadId, message });
    }
  }

  function list(threadId, intent) {
    if (disposed || !ctx.serverUp()) return Promise.resolve();
    const current = reading.get(threadId);
    if (current) { current.again = true; current.intent = intent ?? current.intent; return current.promise; }
    const job = { again: false, intent, promise: null };
    job.promise = (async () => {
      do { job.again = false; await read(threadId, job.intent); } while (job.again && !disposed && ctx.serverUp());
    })().finally(() => reading.delete(threadId));
    reading.set(threadId, job);
    return job.promise;
  }

  function known(ref) {
    if (!ctx.resident(ref)) return null;
    const threadId = threadOf(ref);
    const submission = queues.get(threadId)?.find((s) => refs.queuedMessage(threadId, s.id).id === ref.id);
    return submission ? { threadId, submission } : null;
  }

  return {
    list,
    notified(method, p) {
      if (disposed || !p?.threadId) return;
      // the server started a user message: the queued submission with its client id was sent (said now, if it went already)
      if (method === 'item/started' && p.item?.type === 'userMessage' && typeof p.item.clientId === 'string' && p.item.clientId) {
        const key = `${p.threadId}\n${p.item.clientId}`;
        sentIds.set(key, true); capped(sentIds);
        const ref = gone.get(key);
        if (ref) { gone.delete(key); ctx.emitEvent(ref, 'sent'); }
        return;
      }
      if (method !== 'thread/queue/changed') return;
      clearTimeout(timers.get(p.threadId));
      const timer = setTimeout(() => { timers.delete(p.threadId); list(p.threadId); }, 200);
      timer.unref?.();
      timers.set(p.threadId, timer);
    },
    observe(ref, concept) {
      if (concept === 'QueuedMessage') return list(threadOf(ref));
      if (concept === 'Thread') list(ref.id);
      return undefined;
    },
    serverUp() { for (const [threadId, submissions] of queues) if (submissions.length) list(threadId); },
    prompt(operation, ref, content) {
      if (!ctx.serverUp()) return null;
      const q = operation === 'enqueue' ? null : known(ref);
      if (operation !== 'enqueue' && !q) return null;
      if (operation !== 'sendNow' && !userInput(content).length) return null;
      const title = ctx.resident(refs.thread(q?.threadId ?? ref.id))?.state.title ?? 'New thread';
      const action = operation === 'enqueue' ? 'queue a message' : operation === 'edit' ? 'change a queued message' : 'send a queued message now';
      return { action: `${action} in “${title}”`, detail: 'Codex sends it with this chat\'s permissions, and it counts toward your usage.' };
    },
    async enqueue(ref, content, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const input = userInput(content);
      if (!input.length) return empty();
      const r = await ctx.request('thread/queue/add', { threadId: ref.id, input, clientUserMessageId: randomUUID() }, intent);
      await list(ref.id, intent);
      return refs.queuedMessage(ref.id, r.queuedSubmission.id);
    },
    async edit(ref, content, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const q = known(ref);
      if (!q) return missing();
      const input = userInput(content);
      if (!input.length) return empty();
      await ctx.request('thread/queue/update', { threadId: q.threadId, queuedSubmissionId: q.submission.id, input }, intent);
      await list(q.threadId, intent);
      return null;
    },
    async remove(ref, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const q = known(ref);
      if (!q) return missing();
      await ctx.request('thread/queue/delete', { threadId: q.threadId, queuedSubmissionId: q.submission.id }, intent);
      await list(q.threadId, intent);
      return null;
    },
    async move(ref, position, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const q = known(ref);
      if (!q) return missing();
      if (!Number.isInteger(position)) return refused('invalid', 'the position must be an integer');
      const order = queues.get(q.threadId).map((s) => s.id);
      const from = order.indexOf(q.submission.id), to = Math.max(0, Math.min(position, order.length - 1));
      if (from === to) return null;
      order.splice(from, 1);
      order.splice(to, 0, q.submission.id);
      await ctx.request('thread/queue/reorder', { threadId: q.threadId, queuedSubmissionIds: order }, intent);
      await list(q.threadId, intent);
      return null;
    },
    async sendNow(ref, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const q = known(ref);
      if (!q) return missing();
      const running = (ctx.graph.related(refs.thread(q.threadId), 'turns') ?? []).filter((t) => t.state.status === 'running').sort((a, b) => b.state.startedAt - a.state.startedAt)[0];
      // the server's answer is its signal that the message was sent (a steer accepted, or the turn started from it)
      const sent = () => { sentIds.set(`${q.threadId}\n${q.submission.clientUserMessageId}`, true); capped(sentIds); };
      if (running) {
        await ctx.request('turn/steer', { threadId: q.threadId, expectedTurnId: running.ref.id, input: q.submission.input, clientUserMessageId: q.submission.clientUserMessageId }, intent);
        sent();
        await ctx.request('thread/queue/delete', { threadId: q.threadId, queuedSubmissionId: q.submission.id }, intent);
      } else {
        try {
          await ctx.withLoadedThread(q.threadId, () => ctx.request('thread/queue/start', { threadId: q.threadId, queuedSubmissionId: q.submission.id }, intent), intent);
          sent();
        } catch (e) {
          // Resuming a thread can start its queue (natively the app-server did as it loaded the thread): done when the message is gone.
          if (!/queued submission not found/i.test(String(e?.message ?? e))) throw e;
          await list(q.threadId, intent);
          if (queues.get(q.threadId)?.some((x) => x.id === q.submission.id)) throw e;
          return null;
        }
      }
      await list(q.threadId, intent);
      return null;
    },
    dispose() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
