// Draft diff comments in the app's composer and their blocks in sent user messages (breadth D7).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { refs, userInput, userContent } from '../map.mjs';

export const realizes = {
  types: ['Comment'],
  operations: { Comment: ['edit', 'send', 'resolve', 'delete'], Hunk: ['comment'], Finding: ['comment'] },
  events: { Comment: ['sent', 'resolved'] },
  links: { Comment: ['thread', 'fileChange', 'finding'] },
};

const textOf = (comment) => (comment.content ?? []).filter((c) => c.content_type === 'text').map((c) => c.text).join('\n');
const letter = (side) => side === 'left' ? 'L' : 'R';
const linesOf = (p) => (p.start_side ?? p.side) !== p.side ? `${letter(p.start_side)}${p.start_line ?? p.line}-${letter(p.side)}${p.line}`
  : p.start_line === undefined || p.start_line === p.line ? String(p.line) : `${p.start_line}-${p.line}`;
const refused = (reason, message) => ({ status: 'refused', reason, message });
const validThread = (id) => typeof id === 'string' && !!id.trim() && id.length <= 200 && !id.startsWith('client-new-thread:');

export function keyOf(comment) {
  const p = comment.position;
  return createHash('sha1').update(`${p.path}|${p.side}|${linesOf(p)}|${textOf(comment)}`).digest('hex').slice(0, 16);
}

/** The app's exact block, including its leading and trailing newlines. */
export function commentBlock(comment, n) {
  const p = comment.position, start = p.start_side ?? p.side;
  const side = start === p.side ? letter(p.side) : `${letter(start)}-${letter(p.side)}`;
  return `\n## User Comment ${n}\nFile: ${p.path}\n${comment.localWorkspaceRoot ? `Workspace: ${comment.localWorkspaceRoot}\n` : ''}Side: ${side}\nLines: ${linesOf(p)}\n`
    + (comment.localDiffHunk?.trim() ? `Diff hunk:\n\`\`\`diff\n${comment.localDiffHunk}\n\`\`\`\n` : '') + `Comment:\n${textOf(comment)}\n`;
}

/** Read only the context before the user's request; a hunk is metadata, not part of the comment's text. */
export function parseSent(text) {
  const context = String(text ?? '').split(/(?:^|\n)## My request:\n/, 1)[0];
  const block = /(?:^|\n)## User Comment (\d+)\nFile: ([^\n]+)\n(?:Workspace: ([^\n]*)\n)?Side: (L-R|R-L|L|R)\nLines: (\d+(?:-\d+)?|[LR]\d+-[LR]\d+)\n(?:Diff hunk:\n```diff\n[\s\S]*?\n```\n)?Comment:\n([\s\S]*?)(?:\n(?=\n## User Comment \d+\n|$)|$)/g;
  return [...context.matchAll(block)].map((m) => ({ n: Number(m[1]), path: m[2], workspace: m[3], side: m[4], lines: m[5], text: m[6] }));
}

export function commentData(threadId, comment, { state, author, fileChange = null, finding = null, id } = {}) {
  const p = comment.position;
  return { ref: refs.comment(threadId, id ?? keyOf(comment)), state: {
    content: userContent([{ type: 'text', text: textOf(comment) }]), author: author ?? (comment.reviewThreadId ? 'reviewer' : 'you'),
    anchor: { path: p.path, line: p.start_line ?? p.line, ...(p.start_line === undefined ? {} : { endLine: p.line }) },
    state: state ?? (comment.reviewThreadId ? comment.isResolved ? 'resolved' : 'sent' : 'draft'),
  }, links: { thread: refs.thread(threadId), fileChange, finding } };
}

export function types(feed) {
  const comment = { effect: 'local', handler: ({ ref, args: [content] }) => feed().comment(ref, content) };
  return {
    Hunk: { operations: { comment } }, Finding: { operations: { comment } },
    Comment: { operations: {
      edit: { effect: 'local', handler: ({ ref, args: [content] }) => feed().edit(ref, content) },
      delete: { effect: 'local', handler: ({ ref }) => feed().delete(ref) },
      send: { effect: 'external', approval: ({ ref }) => feed().prompt(ref), handler: ({ ref, intent }) => feed().send(ref, intent) },
      resolve: { effect: 'local', handler: () => refused('unsupported', "a draft is deleted, not resolved; a pull request's review threads are resolved on GitHub") },
    } },
  };
}

export function createFeed(ctx) {
  const threads = new Map(), findings = new Map(), sending = new Set();
  let disposed = false;
  function record(threadId) {
    let r = threads.get(threadId);
    if (!r) { r = { drafts: [], sent: new Map() }; threads.set(threadId, r); }
    return r;
  }
  function data(threadId, comment, id) {
    const root = comment.localWorkspaceRoot || ctx.cwdOf(threadId);
    const absolute = path.isAbsolute(comment.position.path) ? comment.position.path : root ? path.resolve(root, comment.position.path) : null;
    const file = absolute && refs.fileChange(refs.changeSet('thread', threadId).id, absolute);
    return commentData(threadId, comment, { ...(id ? { id, state: 'sent', author: 'you' } : {}),
      fileChange: file && ctx.resident(file) ? file : null, finding: findings.get(`${threadId}:${keyOf(comment)}`) ?? null });
  }
  function put(d) {
    const old = ctx.resident(d.ref);
    if (!old || JSON.stringify(old.state) !== JSON.stringify(d.state) || JSON.stringify(old.links) !== JSON.stringify(d.links)) ctx.handle.put(d.ref, { state: d.state, links: d.links });
  }
  function drafts(threadId, comments) {
    if (disposed || !validThread(threadId) || !Array.isArray(comments)) return;
    const sync = !threads.has(threadId), r = record(threadId), before = new Map(r.drafts.map((c) => [keyOf(c), c]));
    r.drafts = comments.filter((c) => c?.type === 'comment' && typeof c.position?.path === 'string' && Array.isArray(c.content));
    for (const c of r.drafts) {
      const key = keyOf(c), old = before.get(key), d = data(threadId, c);
      put(d);
      if (!sync && old?.reviewThreadId && !old.isResolved && c.isResolved) ctx.emitEvent(d.ref, 'resolved');
      before.delete(key);
    }
    for (const key of before.keys()) if (ctx.resident(refs.comment(threadId, key))) ctx.handle.remove(refs.comment(threadId, key));
  }
  function learn(threadId) {
    if (disposed || !validThread(threadId) || !ctx.resident(refs.thread(threadId))) return;
    const sync = !threads.has(threadId), r = record(threadId);
    for (const turn of ctx.graph.referrers(refs.thread(threadId), 'thread')) {
      if (ctx.graph.type(turn.ref.type)?.concept !== 'Turn' || turn.ref.provider !== refs.agent().provider || turn.gone) continue;
      for (const message of ctx.graph.referrers(turn.ref, 'turn')) {
        if (message.ref.type !== 'UserMessage' || message.ref.provider !== refs.agent().provider || message.gone) continue;
        const text = message.state.content.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
        for (const b of parseSent(text)) {
          const id = `sent-${message.ref.id}-${b.n}`, previous = r.sent.has(id);
          const range = /^(?:([LR]))?(\d+)(?:-(?:([LR]))?(\d+))?$/.exec(b.lines);
          const end = b.side.at(-1), start = b.side[0];
          const c = { type: 'comment', content: [{ content_type: 'text', text: b.text }], position: {
            path: b.path, side: end === 'L' ? 'left' : 'right', line: Number(range[4] ?? range[2]),
            ...(range[4] === undefined ? {} : { start_line: Number(range[2]) }),
            ...(start === end ? {} : { start_side: start === 'L' ? 'left' : 'right' }),
          }, ...(b.workspace === undefined ? {} : { localWorkspaceRoot: b.workspace }) };
          r.sent.set(id, c);
          const d = data(threadId, c, id);
          put(d);
          if (!previous) {
            const pending = [...sending].find((p) => p.threadId === threadId && p.key === keyOf(c) && !p.before.has(id));
            if (pending) { clearTimeout(pending.timer); sending.delete(pending); }
            if (pending ? !pending.emitted : !sync) ctx.emitEvent(d.ref, 'sent');
            if (pending) pending.emitted = true;
          }
        }
      }
    }
  }
  function later(threadId, turnId) {
    queueMicrotask(() => ctx.safe('comments learning', () => learn(threadId ?? ctx.resident(refs.turn(turnId))?.links.thread?.id)));
  }
  function draft(ref, send = false) {
    if (disposed || !ctx.resident(ref)) return { no: refused('unavailable', 'the comment is gone') };
    if (ctx.resident(ref).state.state !== 'draft') return { no: refused('unsupported', 'a sent comment cannot be changed') };
    const threadId = ref.id.slice(0, ref.id.indexOf(':')), r = threads.get(threadId);
    const index = r?.drafts.findIndex((c) => refs.comment(threadId, keyOf(c)).id === ref.id) ?? -1;
    if (index < 0) return { no: refused('unavailable', 'the draft is gone') };
    if (send && !ctx.resident(refs.thread(threadId))) return { no: refused('unavailable', 'the thread is gone') };
    if (send && !ctx.serverUp()) return { no: ctx.DOWN };
    return { threadId, r, index, comment: r.drafts[index] };
  }
  async function appEdit(threadId, removed, added) {
    const answer = await ctx.mainOp('edit', { threadId, removed, added });
    if (!answer.ok) {
      if (answer.refused) return refused('unavailable', answer.error);
      throw new Error(answer.error);
    }
    drafts(threadId, answer.result.comments);
    return null;
  }
  const reports = ctx.onMainReport((report) => drafts(report?.conversationId, report?.comments));
  const sub = ctx.graph.onEvent((e) => {
    if (disposed || e.ref?.provider !== refs.agent().provider) return;
    if (e.kind === 'removed' && e.ref.type === 'CodexThread') {
      const r = threads.get(e.ref.id);
      threads.delete(e.ref.id);
      if (r) for (const d of [...r.drafts.map((c) => data(e.ref.id, c)), ...[...r.sent].map(([id, c]) => data(e.ref.id, c, id))]) if (ctx.resident(d.ref)) ctx.handle.remove(d.ref);
      for (const key of findings.keys()) if (key.startsWith(`${e.ref.id}:`)) findings.delete(key);
      for (const p of sending) if (p.threadId === e.ref.id) { clearTimeout(p.timer); sending.delete(p); }
    } else if (e.ref.type === 'FileChange' && ['added', 'changed', 'removed'].includes(e.kind)) {
      for (const [id, r] of threads) {
        for (const c of r.drafts) put(data(id, c));
        for (const [key, c] of r.sent) put(data(id, c, key));
      }
    }
  });
  return {
    notified(method, p) { if (method === 'item/completed' && p.item?.type === 'userMessage') later(p.threadId, p.turnId); },
    responded(method, result) {
      if (!['thread/read', 'thread/resume', 'thread/turns/list'].includes(method)) return;
      for (const turn of result.thread?.turns ?? result.data ?? []) later(result.thread?.id, turn.id);
    },
    observe(ref, concept) {
      if (concept !== 'Comment') return undefined;
      if (disposed) return Promise.resolve();
      const threadId = ref.id.slice(0, ref.id.indexOf(':'));
      if (!validThread(threadId)) return Promise.resolve();
      return (async () => {
        const answer = await ctx.mainOp('read', { threadId });
        if (answer.ok) drafts(threadId, answer.result.comments);
        else if (!answer.refused) throw new Error(answer.error);
        await ctx.loadThread(threadId);
        learn(threadId);
      })();
    },
    async comment(ref, content) {
      const text = userInput(content).find((p) => p.type === 'text')?.text;
      if (!text?.trim()) return refused('invalid', 'a comment needs text');
      const instance = ctx.resident(ref);
      let threadId, position;
      if (ref.type === 'Hunk') {
        const file = instance && ctx.resident(instance.links.fileChange), set = file && ctx.resident(file.links.changeSet);
        threadId = set?.links.thread?.id;
        if (!threadId) return refused('unavailable', 'the hunk has no thread');
        let p = file.state.path;
        const cwd = ctx.cwdOf(threadId);
        if (cwd && path.isAbsolute(p)) {
          const relative = path.relative(cwd, p);
          if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) p = relative;
        }
        const after = instance.state.after;
        position = { side: 'right', path: p, line: after.start + Math.max(after.lines, 1) - 1, ...(after.lines > 1 ? { start_line: after.start } : {}) };
      } else {
        if (!instance?.state.location) return refused('unavailable', 'the finding has no location');
        threadId = ctx.resident(instance.links.review)?.links.thread?.id;
        if (!threadId) return refused('unavailable', 'the finding has no thread');
        position = { side: 'right', path: instance.state.location.path, line: instance.state.location.line };
      }
      const c = { type: 'comment', content: [{ content_type: 'text', text }], position, localWorkspaceRoot: ctx.cwdOf(threadId) };
      const key = `${threadId}:${keyOf(c)}`, previous = findings.get(key);
      if (ref.type === 'Finding') findings.set(key, ref);
      try {
        const no = await appEdit(threadId, [], [{ comment: c, index: threads.get(threadId)?.drafts.length ?? 0 }]);
        if (!no) return refs.comment(threadId, keyOf(c));
        if (previous) findings.set(key, previous); else findings.delete(key);
        return no;
      } catch (e) { if (previous) findings.set(key, previous); else findings.delete(key); throw e; }
    },
    async edit(ref, content) {
      const at = draft(ref);
      if (at.no) return at.no;
      const text = userInput(content).find((p) => p.type === 'text')?.text;
      if (!text?.trim()) return refused('invalid', 'a comment needs text');
      const comment = { ...at.comment, content: [{ content_type: 'text', text }] }, key = `${at.threadId}:${keyOf(comment)}`;
      const finding = findings.get(ref.id), previous = findings.get(key);
      if (finding) findings.set(key, finding);
      try {
        const no = await appEdit(at.threadId, [at.comment], [{ comment, index: at.index }]);
        if (no) { if (previous) findings.set(key, previous); else findings.delete(key); }
        return no;
      } catch (e) { if (previous) findings.set(key, previous); else findings.delete(key); throw e; }
    },
    async delete(ref) {
      const at = draft(ref);
      return at.no ?? appEdit(at.threadId, [at.comment], []);
    },
    prompt(ref) {
      const at = draft(ref, true);
      return at.no ? null : { action: `send a comment to Codex in “${ctx.resident(refs.thread(at.threadId)).state.title}”`,
        detail: 'Codex reads it as your message: it may change files and counts toward your usage.' };
    },
    async send(ref, intent) {
      const at = draft(ref, true);
      if (at.no) return at.no;
      const pending = { threadId: at.threadId, key: keyOf(at.comment), before: new Set(at.r.sent.keys()), emitted: false, timer: null };
      sending.add(pending);
      try {
        await ctx.withLoadedThread(at.threadId, () => ctx.request('turn/start', { threadId: at.threadId,
          input: [{ type: 'text', text: '\n# Diff comments:\n' + commentBlock(at.comment, 1) + '\n## My request:\n\n', text_elements: [] }] }, intent), intent);
      } catch (e) { sending.delete(pending); throw e; }
      if (!disposed && sending.has(pending)) {
        pending.timer = setTimeout(() => { if (!disposed) { pending.emitted = true; ctx.emitEvent(ref, 'sent'); } }, 10_000);
        pending.timer.unref?.();
      }
      const no = await appEdit(at.threadId, [at.comment], []);
      if (no) throw new Error(`the comment was sent but its draft could not be removed: ${no.message}`);
      return null;
    },
    dispose() { disposed = true; reports.dispose(); sub.dispose(); for (const p of sending) clearTimeout(p.timer); sending.clear(); threads.clear(); findings.clear(); },
  };
}
