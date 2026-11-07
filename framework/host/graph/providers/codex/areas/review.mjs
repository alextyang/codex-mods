// A code review is the app's review-prompt turn; its model-comment directives are the findings (breadth step D7).
import path from 'node:path';
import { refs, userContent } from '../map.mjs';

export const realizes = {
  types: ['Review', 'Finding'],
  operations: { Review: ['stop'], Finding: ['open', 'dismiss'] },
  supports: { Review: ['overview'], Finding: ['location'] },
  events: { Review: ['started', 'findingAdded', 'done'] },
  links: { Review: ['thread', 'turn'], Finding: ['review'] },
};

const DIRECTIVE = /^[ \t]*:{1,3}code-comment\{((?:"(?:\\["']|[^"])*"|'(?:\\["']|[^'])*'|[^"'}])*)\}/;
const textOf = (content) => content?.parts?.filter((p) => p.kind === 'text').map((p) => p.text).join('') ?? '';
const contentOf = (text) => userContent([{ type: 'text', text }]);

function decode(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (Object.hasOwn(named, name)) return named[name];
    if (!name.startsWith('#')) return entity;
    const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}

/** The app's one-line directive grammar, including quoted attributes and their two quote escapes. */
export function parseFindings(text, cwd) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const directive = DIRECTIVE.exec(line);
    if (!directive) continue;
    const attrs = new Map();
    const attribute = /[ \t]*([^\s=]+)[ \t]*=[ \t]*(?:"((?:\\["']|[^"])*)"|'((?:\\["']|[^'])*)'|([^\s"'=<>`]+))/y;
    let pos = 0, valid = true;
    while (pos < directive[1].length && directive[1].slice(pos).trim()) {
      attribute.lastIndex = pos;
      const a = attribute.exec(directive[1]);
      if (!a) { valid = false; break; }
      const value = a[2] ?? a[3] ?? a[4];
      attrs.set(a[1], decode(a[4] === undefined ? value.replace(/\\(["'])/g, '$1') : value));
      pos = attribute.lastIndex;
      if (pos < directive[1].length && !/[ \t]/.test(directive[1][pos])) { valid = false; break; }
    }
    const title = attrs.get('title')?.trim(), body = attrs.get('body')?.trim(), file = attrs.get('file')?.trim();
    if (!valid || !title || !body || !file) continue;
    const integer = (key) => /^[+-]?\d+$/.test(attrs.get(key) ?? '') && Number.isInteger(Number(attrs.get(key))) ? Number(attrs.get(key)) : undefined;
    const priority = integer('priority');
    const startLine = Math.max(1, integer('start') ?? 1);
    const lineNumber = Math.max(startLine, integer('end') ?? startLine);
    let filePath = file;
    if (path.isAbsolute(file)) {
      filePath = path.normalize(file);
      if (cwd) {
        const relative = path.relative(cwd, filePath);
        if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) filePath = relative;
      }
    }
    const shown = priority === undefined || /^(?:<sub>\s*)*\[P\d+\]/i.test(title) ? title : `[P${priority}] ${title}`;
    // The app's model comment carries the workspace root it found the file in (the thread's working directory): part of its key.
    const root = typeof cwd === 'string' && cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : null;
    out.push({ title, shown, body, priority, path: filePath, startLine, line: lineNumber, root });
  }
  return out;
}

/** The app's identity of a model comment (21477 `Kx`): its workspace root when it has one, its path, side, lines and text. */
export function commentKey(finding) {
  const lines = finding.startLine === finding.line ? String(finding.line) : `${finding.startLine}-${finding.line}`;
  return `${finding.root ? `${finding.root}|` : ''}${finding.path}|right|${lines}|${finding.shown}\n\n${finding.body}`;
}

export function severityOf(priority) {
  return priority === 0 || priority === 1 ? 'high' : priority >= 3 ? 'low' : 'medium';
}

export function reviewTarget(prompt) {
  if (prompt.includes('Review the current code changes')) return { kind: 'uncommitted' };
  const branch = /against the base branch '([^']+)'/.exec(prompt);
  return branch ? { kind: 'branch', name: branch[1] } : null;
}

export function types(feed) {
  return {
    Review: { operations: { stop: { effect: 'external', handler: ({ ref, intent }) => feed().stop(ref, intent) } } },
    Finding: { operations: {
      open: { effect: 'local', handler: ({ ref }) => feed().open(ref) },
      dismiss: { effect: 'external', approval: ({ instance }) => feed().prompt(instance), handler: ({ ref }) => feed().dismiss(ref) },
    } },
  };
}

export function createFeed(ctx) {
  const known = new Map(), threads = new Map(), commentary = new Map();
  let disposed = false;
  const refused = (message) => ({ status: 'refused', reason: 'unavailable', message });
  const parts = (turnId) => {
    const order = known.get(turnId)?.order;
    return ctx.graph.referrers(refs.turn(turnId), 'turn').filter((x) => !x.gone && x.ref.provider === refs.agent().provider)
      .sort((a, b) => (a.state.createdAt ?? 0) - (b.state.createdAt ?? 0)
        || (order?.get(a.ref.id) ?? Number.MAX_SAFE_INTEGER) - (order?.get(b.ref.id) ?? Number.MAX_SAFE_INTEGER));
  };
  function put(data) {
    const before = ctx.resident(data.ref);
    if (before?.liveness === 'live' && JSON.stringify(before.state) === JSON.stringify(data.state) && JSON.stringify(before.links) === JSON.stringify(data.links)) return;
    ctx.safe('review', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
  }
  function putFindings(record) {
    record.findings.forEach((f, index) => put({
      ref: refs.finding(record.turnId, index),
      state: { title: f.shown, detail: contentOf(f.body), severity: severityOf(f.priority), state: record.dismissed.has(commentKey(f)) ? 'dismissed' : 'open', location: { path: f.path, line: f.line } },
      links: { review: refs.review(record.turnId) },
    }));
  }
  function remove(turnId) {
    const record = known.get(turnId);
    if (!record) return;
    known.delete(turnId);
    clearTimeout(record.timer);
    record.findings.forEach((_, i) => ctx.safe('finding removal', () => ctx.handle.remove(refs.finding(turnId, i))));
    ctx.safe('review removal', () => ctx.handle.remove(refs.review(turnId)));
    commentary.delete(turnId);
  }
  function readDismissed(record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(async () => {
      record.timer = null;
      const revision = record.revision;
      try {
        const r = await ctx.mainOp('dismissed', { threadId: record.threadId, keys: record.findings.map(commentKey) });
        if (!r.ok) throw new Error(r.error);
        if (disposed || known.get(record.turnId) !== record || revision !== record.revision) return;
        record.dismissed = new Set(r.result.dismissed);
        putFindings(record);
      } catch (e) { ctx.log.warn('review: dismissals could not be read', { message: String(e?.message ?? e) }); }
    }, 200);
    record.timer.unref?.();
  }
  function learn(turnId) {
    if (disposed) return;
    const turn = ctx.resident(refs.turn(turnId));
    const threadId = turn?.links.thread?.id ?? threads.get(turnId);
    if (threadId) threads.set(turnId, threadId);
    const thread = threadId && ctx.resident(refs.thread(threadId));
    if (!turn || !thread) { remove(turnId); return; }
    const messages = parts(turnId);
    const prompt = textOf(messages.find((m) => m.ref.type === 'UserMessage')?.state.content);
    if (!prompt.includes('## Code review guidelines:')) { remove(turnId); return; }
    const target = reviewTarget(prompt), before = known.get(turnId);
    const record = before ?? { turnId, threadId, findings: [], dismissed: new Set(), order: new Map(), revision: 0, started: false, timer: null };
    for (const message of messages) if (!record.order.has(message.ref.id)) record.order.set(message.ref.id, record.order.size);
    const findings = messages.filter((m) => m.ref.type === 'AgentMessage' && !commentary.get(turnId)?.has(m.ref.id.slice(threadId.length + 1)))
      .flatMap((m) => parseFindings(textOf(m.state.content), ctx.cwdOf(threadId)));
    const priorKeys = record.findings.map(commentKey), keys = findings.map(commentKey);
    if (JSON.stringify(priorKeys) !== JSON.stringify(keys)) record.revision += 1;
    const oldLength = record.findings.length;
    record.findings = findings;
    record.target = target;
    const status = turn.state.status === 'running' ? 'running' : turn.state.status === 'completed' ? 'done' : 'failed';
    const priorStatus = record.status;
    record.status = status;
    known.set(turnId, record);
    // A turn/completed frame replaces the core turn without its answer link. Keep the answer already learned from that link.
    if (turn.links.answer) record.answer = turn.links.answer;
    const answer = record.answer && ctx.resident(record.answer);
    put({ ref: refs.review(turnId), state: {
      status, target: target?.kind === 'uncommitted' ? refs.changeSet('thread', threadId) : target?.kind === 'branch' ? thread.links.project ? refs.branch(thread.links.project.id, target.name) : target.name : null,
      reviewer: refs.agent(),
      ...(answer ? { overview: contentOf(textOf(answer.state.content).split(/\r?\n/).filter((line) => !DIRECTIVE.test(line)).join('\n')) } : {}),
    }, links: { thread: refs.thread(threadId), turn: refs.turn(turnId) } });
    putFindings(record);
    for (let i = findings.length; i < oldLength; i++) ctx.safe('finding removal', () => ctx.handle.remove(refs.finding(turnId, i)));
    if (before) {
      if (status === 'running' && !record.started) { record.started = true; ctx.emitEvent(refs.review(turnId), 'started'); }
      for (const key of keys) if (!priorKeys.includes(key)) ctx.emitEvent(refs.review(turnId), 'findingAdded');
      if (priorStatus === 'running' && status !== 'running') ctx.emitEvent(refs.review(turnId), 'done');
    }
    readDismissed(record);
  }
  function phase(turnId, item) {
    if (item?.type !== 'agentMessage') return;
    const excluded = commentary.get(turnId) ?? new Set();
    if (item.phase === 'commentary') excluded.add(item.id); else excluded.delete(item.id);
    commentary.set(turnId, excluded);
  }
  function later(turnId, threadId) {
    if (!turnId) return;
    if (threadId) threads.set(turnId, threadId);
    queueMicrotask(() => ctx.safe('review learning', () => learn(turnId)));
  }
  function finding(ref) {
    const split = ref.id.lastIndexOf('#');
    const record = known.get(ref.id.slice(0, split));
    const value = record?.findings[Number(ref.id.slice(split + 1))];
    return value ? { record, value } : null;
  }
  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return null;
    if (r.refused) return refused(r.error);
    throw new Error(r.error);
  }
  const sub = ctx.graph.onEvent((e) => {
    if (e.kind !== 'removed' || e.ref.provider !== refs.agent().provider) return;
    if (ctx.graph.type(e.ref.type)?.concept === 'Turn') remove(e.ref.id);
    if (e.ref.type === 'CodexThread') for (const [turnId, threadId] of threads) if (threadId === e.ref.id) { remove(turnId); threads.delete(turnId); commentary.delete(turnId); }
  });
  return {
    notified(method, p) {
      if (disposed || !['item/completed', 'item/started', 'turn/started', 'turn/completed'].includes(method)) return;
      const turnId = p.turnId ?? p.turn?.id;
      phase(turnId, p.item);
      for (const item of p.turn?.items ?? []) phase(turnId, item);
      later(turnId, p.threadId);
    },
    responded(method, result) {
      if (disposed || !['thread/read', 'thread/resume', 'thread/turns/list'].includes(method)) return;
      const turns = result.thread?.turns ?? result.data ?? [];
      for (const turn of turns) {
        const threadId = result.thread?.id ?? ctx.resident(refs.turn(turn.id))?.links.thread?.id ?? threads.get(turn.id);
        for (const item of turn.items ?? []) phase(turn.id, item);
        later(turn.id, threadId);
      }
    },
    observe(ref, concept) {
      if (concept !== 'Review' && concept !== 'Finding') return undefined;
      const turnId = concept === 'Review' ? ref.id : ref.id.slice(0, ref.id.lastIndexOf('#'));
      const threadId = ctx.resident(refs.turn(turnId))?.links.thread?.id ?? threads.get(turnId);
      return threadId ? ctx.loadThread(threadId).then(() => learn(turnId)) : Promise.resolve();
    },
    prompt(instance) {
      if (instance.state.state === 'dismissed' || !finding(instance.ref)) return null;
      return { action: `dismiss the finding “${instance.state.title}”`, detail: 'The app stops showing it in the diff of this chat.' };
    },
    async stop(ref, intent) {
      const record = known.get(ref.id);
      if (!record || record.status !== 'running') return refused('the review is not running');
      if (!ctx.serverUp()) return ctx.DOWN;
      await ctx.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }, intent);
      return null;
    },
    async open(ref) {
      const f = finding(ref);
      if (!f || !f.record.target) return refused('the review has no diff target');
      const cwd = ctx.cwdOf(f.record.threadId);
      if (!cwd && !path.isAbsolute(f.value.path)) return refused("the chat's working directory is not available");
      return appOp('open', { threadId: f.record.threadId, path: path.resolve(cwd ?? '/', f.value.path), view: f.record.target.kind === 'uncommitted' ? 'unstaged' : 'branch' });
    },
    async dismiss(ref) {
      const f = finding(ref);
      if (!f) return refused('the finding is gone');
      const key = commentKey(f.value);
      if (f.record.dismissed.has(key)) return null;
      const result = await appOp('dismiss', { threadId: f.record.threadId, key });
      if (result) return result;
      if (disposed || known.get(f.record.turnId) !== f.record) return null;
      f.record.revision += 1;
      f.record.dismissed.add(key);
      putFindings(f.record);
      readDismissed(f.record);
      return null;
    },
    dispose() { disposed = true; sub.dispose(); for (const record of known.values()) clearTimeout(record.timer); },
  };
}
