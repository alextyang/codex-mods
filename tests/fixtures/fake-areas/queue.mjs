// The fake app-server's follow-up queue, one per thread (breadth step D5; the experimental thread/queue methods):
//   add {threadId, input, clientUserMessageId} -> {queuedSubmission: {id: "q-<n>", input, clientUserMessageId}}.
//   list {threadId, cursor?} -> {data: QueuedSubmission[], nextCursor}: queue order, pages of 50; cursor is the next offset as a string.
//   update {threadId, queuedSubmissionId, input} -> {queuedSubmission}; delete {threadId, queuedSubmissionId} -> {deleted}.
//   reorder {threadId, queuedSubmissionIds} -> {}: the full order, a permutation of the queue's ids, else error -32600.
//   start {threadId, queuedSubmissionId?} -> {turn}: removes that submission (the first when omitted), then turn/started with a Turn
//     "turn-q-<n>" in progress, also recorded in history. Unknown threads or submissions are error -32600.
// Every mutation replies before thread/queue/changed {threadId}; start sends turn/started before the change. No live model traffic.
export default function queue(f) {
  const queues = new Map();
  let seq = 0, turnSeq = 0;
  function queueFor(m, p) {
    const t = f.threadFor(m, p);
    if (!t) return null;
    if (!queues.has(t.id)) queues.set(t.id, []);
    return queues.get(t.id);
  }
  function submissionFor(m, p, submissions) {
    const s = submissions.find((s) => s.id === p.queuedSubmissionId);
    if (!s) f.fail(m.id, -32600, `queued submission not found: ${p.queuedSubmissionId}`);
    return s ?? null;
  }
  const changed = (threadId) => f.notify('thread/queue/changed', { threadId });
  return {
    'thread/queue/add': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      if (!Array.isArray(p.input) || typeof p.clientUserMessageId !== 'string') return f.fail(m.id, -32602, 'Invalid params: input and clientUserMessageId are needed');
      const queuedSubmission = { id: `q-${++seq}`, input: structuredClone(p.input), clientUserMessageId: p.clientUserMessageId };
      submissions.push(queuedSubmission);
      f.reply(m.id, { queuedSubmission });
      return changed(p.threadId);
    },
    'thread/queue/list': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      if (p.cursor != null && (typeof p.cursor !== 'string' || !/^\d+$/.test(p.cursor) || !Number.isSafeInteger(Number(p.cursor)))) return f.fail(m.id, -32600, 'invalid queue cursor');
      const offset = Number(p.cursor ?? 0), data = submissions.slice(offset, offset + 50);
      return f.reply(m.id, { data, nextCursor: offset + data.length < submissions.length ? String(offset + data.length) : null });
    },
    'thread/queue/update': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      const s = submissionFor(m, p, submissions); if (!s) return;
      if (!Array.isArray(p.input)) return f.fail(m.id, -32602, 'Invalid params: input must be a list');
      s.input = structuredClone(p.input);
      f.reply(m.id, { queuedSubmission: s });
      return changed(p.threadId);
    },
    'thread/queue/delete': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      const s = submissionFor(m, p, submissions); if (!s) return;
      submissions.splice(submissions.indexOf(s), 1);
      f.reply(m.id, { deleted: true });
      return changed(p.threadId);
    },
    'thread/queue/reorder': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      const ids = p.queuedSubmissionIds;
      const byId = new Map(submissions.map((s) => [s.id, s]));
      if (!Array.isArray(ids) || ids.length !== submissions.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) return f.fail(m.id, -32600, 'queue order must be a permutation');
      queues.set(p.threadId, ids.map((id) => byId.get(id)));
      f.reply(m.id, {});
      return changed(p.threadId);
    },
    'thread/queue/start': (m, p) => {
      const submissions = queueFor(m, p); if (!submissions) return;
      const s = submissionFor(m, { ...p, queuedSubmissionId: p.queuedSubmissionId ?? submissions[0]?.id }, submissions); if (!s) return;
      submissions.splice(submissions.indexOf(s), 1);
      const id = `turn-q-${++turnSeq}`;
      const turn = { ...f.turnOf(id, 'inProgress'), items: [{ type: 'userMessage', id: `${id}-user`, content: s.input }], itemsView: 'full', startedAt: f.T0, completedAt: null, durationMs: null, rootTurnId: null };
      f.historyOf(p.threadId).push(structuredClone(turn));
      f.reply(m.id, { turn });
      f.notify('turn/started', { threadId: p.threadId, turn });
      return changed(p.threadId);
    },
  };
}
