// Integrated terminal sessions from main, and the agent's commands that outlive their turn (breadth step D8).
import { basename } from 'node:path';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Terminal'],
  operations: { Terminal: ['run', 'write', 'clear', 'stop', 'close', 'focus', 'tail'] },
  supports: { Terminal: ['tail'] },
  events: { Terminal: ['output', 'exited', 'closed'] },
  links: { Terminal: ['project', 'thread'], CodexCommandRun: ['terminal'] },
};

/** The app's fallback label; only its page knows a shell's own title. */
export function titleOf(session, sessions) {
  if (!session.cwd) return `Terminal ${sessions.findIndex((s) => s.id === session.id) + 1}`;
  const folder = basename(session.cwd) || session.cwd;
  const same = sessions.filter((s) => s.cwd && s.conversationId === session.conversationId && (basename(s.cwd) || s.cwd) === folder);
  return same.length > 1 ? `${folder} ${same.findIndex((s) => s.id === session.id) + 1}` : folder;
}

// Terminal escapes (CSI, OSC, the two-character ones) and carriage returns: a line is what is left after its last return.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** The last `n` lines of a terminal's output, as plain text (Terminal.tail; the agent's from its CommandRun's output). */
export function lastLines(text, n) {
  const lines = String(text).replace(ESCAPES, '').replace(/\r\n/g, '\n').split('\n').map((l) => l.slice(l.lastIndexOf('\r') + 1));
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** A manager session, or (`agent`) a commandExecution item with its threadId attached. A session in a chat names its chat too. */
export function terminalData(session, { title, project, thread, agent = false }) {
  return { ref: agent ? refs.agentTerminal(session.threadId, session.id) : refs.terminal(session.id), state: {
    title,
    // The integrated terminal's cwd is where it started; the app does not follow `cd`.
    directory: session.cwd ?? '', running: true, startedBy: agent ? 'agent' : 'you', shell: agent ? '' : session.shell ?? '',
  }, links: { project, thread } };
}

export function types(feed) {
  return { Terminal: { operations: {
    run: { effect: 'external', approval: ({ ref, args }) => feed().prompt('run', ref, args[0]), handler: ({ ref, args, intent }) => feed().act('run', ref, args[0], intent) },
    write: { effect: 'external', approval: ({ ref, args }) => feed().prompt('write', ref, args[0]), handler: ({ ref, args, intent }) => feed().act('write', ref, args[0], intent) },
    clear: { effect: 'local', handler: ({ ref }) => feed().act('clear', ref) },
    stop: { effect: 'external', handler: ({ ref, intent }) => feed().act('stop', ref, undefined, intent) },
    close: { effect: 'external', handler: ({ ref, intent }) => feed().act('close', ref, undefined, intent) },
    focus: { effect: 'local', handler: ({ ref }) => feed().act('focus', ref) },
    tail: { effect: 'none', handler: ({ ref, args }) => feed().tail(ref, args[0]) },
  } } };
}

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  const sessions = new Map(), commands = new Map(), terminals = new Map(), turns = new Map(), latest = new Map(), pending = new Map();
  const closing = new Set(), endedDuringRead = new Set();
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  let reading = null, reread = false, finishedAt = -Infinity, timer = null, attached = null, scheduled = false, disposed = false;

  function remove(ref, event) {
    if (!ctx.graph.resolve(ref)) return;
    ctx.emitEvent(ref, event);
    if (ctx.resident(ref)) ctx.handle.remove(ref);
  }
  function removeSession(id, event = closing.has(id) ? 'closed' : 'exited') {
    if (!sessions.delete(id)) return;
    closing.delete(id);
    remove(refs.terminal(id), event);
  }
  function putSession(session) {
    const threadId = session.threadId ?? (session.conversationId && !session.conversationId.startsWith('client-new-thread:') ? session.conversationId : null);
    const thread = threadId ? ctx.resident(refs.thread(threadId)) : null;
    const project = ctx.graph.list('LocalProject').filter((p) => {
      const root = p.state.location;
      return session.cwd && (session.cwd === root || session.cwd.startsWith(root === '/' ? '/' : `${root}/`));
    }).sort((a, b) => b.state.location.length - a.state.location.length)[0]?.ref ?? thread?.links.project ?? null;
    const d = terminalData(session, { title: titleOf(session, [...sessions.values()]), project, thread: thread?.ref ?? null });
    ctx.handle.put(d.ref, { state: d.state, links: d.links });
  }
  function unlink(entry) {
    const command = ctx.resident(refs.item('CommandRun', entry.threadId, entry.id));
    if (command?.links.terminal?.id === refs.agentTerminal(entry.threadId, entry.id).id) ctx.handle.update(command.ref, { links: { terminal: null } });
  }
  function reconcile() {
    if (disposed) return;
    for (const [id, { turn, page }] of pending) {
      const threadId = ctx.resident(refs.turn(id))?.links.thread?.id;
      if (threadId) { pending.delete(id); learnTurn(threadId, turn); latestFromPage(threadId, page); }
    }
    for (const s of sessions.values()) putSession(s);
    const present = new Set();
    for (const entry of commands.values()) {
      const thread = ctx.resident(refs.thread(entry.threadId));
      const turn = turns.get(entry.turnId);
      const earlier = latest.has(entry.threadId) && latest.get(entry.threadId) !== entry.turnId;
      const ended = turn?.status && turn.status !== 'inProgress';
      if (!thread || !(earlier || ended)) continue;
      const d = terminalData(entry, { title: ctx.resident(refs.item('CommandRun', entry.threadId, entry.id))?.state.command ?? entry.command ?? '', project: thread.links.project ?? null, thread: thread.ref, agent: true });
      present.add(d.ref.id);
      terminals.set(d.ref.id, entry);
      ctx.handle.put(d.ref, { state: d.state, links: d.links });
      const command = ctx.resident(refs.item('CommandRun', entry.threadId, entry.id));
      if (command && command.links.terminal?.id !== d.ref.id) ctx.handle.update(command.ref, { links: { terminal: d.ref } });
    }
    for (const [id, entry] of terminals) if (!present.has(id)) {
      terminals.delete(id);
      remove(refs.agentTerminal(entry.threadId, entry.id), 'exited');
      unlink(entry);
    }
  }
  function schedule() {
    if (disposed || scheduled) return;
    scheduled = true;
    // Core puts replace item links, including the continuation of a turns/list response. Apply ours after those puts.
    queueMicrotask(() => { scheduled = false; if (!disposed) ctx.safe('terminal links', reconcile); });
  }
  function learnItem(threadId, turnId, item) {
    if (item?.type !== 'commandExecution' || !item.id) return;
    const key = refs.agentTerminal(threadId, item.id).id;
    if (item.status === 'inProgress' && item.processId != null) commands.set(key, { id: item.id, command: item.command, cwd: item.cwd, processId: item.processId, threadId, turnId });
    else commands.delete(key);
  }
  function learnTurn(threadId, turn) {
    if (!turn?.id) return;
    turns.set(turn.id, { id: turn.id, status: turn.status, startedAt: turn.startedAt, threadId });
    if (!latest.has(threadId)) latest.set(threadId, turn.id);
    else {
      const last = turns.get(latest.get(threadId));
      if (turn.startedAt != null && (last?.startedAt == null || turn.startedAt > last.startedAt)) latest.set(threadId, turn.id);
    }
    for (const item of turn.items ?? []) learnItem(threadId, turn.id, item);
  }
  function latestFromPage(threadId, page) {
    // turns/list is newest first. Timestamps can tie; an older page must not replace a latest turn outside that page.
    const candidate = page.find((id) => ctx.resident(refs.turn(id))?.links.thread?.id === threadId);
    if (candidate && (!latest.has(threadId) || page.includes(latest.get(threadId)))) latest.set(threadId, candidate);
  }
  function forgetThread(threadId) {
    latest.delete(threadId);
    for (const [id, t] of turns) if (t.threadId === threadId) turns.delete(id);
    for (const [id, c] of commands) if (c.threadId === threadId) commands.delete(id);
  }

  function read(again = false) {
    if (disposed) return Promise.resolve();
    if (reading) { if (again) reread = true; return reading; }
    reading = (async () => {
      do {
        reread = false;
        endedDuringRead.clear();
        try {
          const r = await ctx.mainOp('list', {});
          if (!r.ok) throw new Error(r.error);
          if (disposed) return;
          const next = new Map(r.result.sessions.filter((s) => typeof s.id === 'string' && !endedDuringRead.has(s.id)).map((s) => [s.id, s]));
          for (const id of sessions.keys()) if (!next.has(id)) removeSession(id);
          sessions.clear();
          for (const [id, s] of next) sessions.set(id, s);
          reconcile(); // The first list is a sync, with no named terminal events.
        } catch (e) { if (!disposed) ctx.log.warn('terminals: the terminals could not be read', { message: String(e?.message ?? e) }); }
        finally { finishedAt = now(); }
      } while (reread && !disposed);
    })().finally(() => { reading = null; endedDuringRead.clear(); });
    return reading;
  }
  const reports = ctx.onMainReport((report) => {
    if (disposed || typeof report?.sessionId !== 'string') return;
    const { sessionId, event } = report;
    if (event === 'attached') {
      const session = sessions.get(sessionId);
      if (session) { Object.assign(session, { cwd: report.cwd, shell: report.shell }); putSession(session); }
      clearTimeout(attached);
      attached = setTimeout(() => { attached = null; read(true); }, 300);
      attached.unref?.();
    } else if (event === 'exit') {
      if (reading) endedDuringRead.add(sessionId);
      removeSession(sessionId, closing.has(sessionId) || report.code === null && report.signal === null ? 'closed' : 'exited');
      reconcile();
    } else if (event === 'output' && sessions.has(sessionId)) ctx.emitEvent(refs.terminal(sessionId), 'output');
    else if (event === 'error') ctx.log.warn('terminals: terminal error', { message: report.message });
  });
  const graphSub = ctx.graph.onEvent((e) => {
    if (disposed || e.ref?.provider !== refs.agent().provider) return;
    if (e.ref.type === 'CodexThread' && e.kind === 'removed') forgetThread(e.ref.id);
    if (['CodexThread', 'LocalProject', 'Turn'].includes(e.ref.type)) schedule();
    if (ctx.graph.type(e.ref.type)?.chain?.includes('CommandRun') && ['added', 'changed'].includes(e.kind)) {
      const entry = [...terminals.values()].find((c) => refs.item('CommandRun', c.threadId, c.id).id === e.ref.id);
      if (entry && e.instance?.links.terminal?.id !== refs.agentTerminal(entry.threadId, entry.id).id) schedule();
    }
  });

  function plan(op, ref, text) {
    const session = sessions.get(ref.id), agent = terminals.get(ref.id), instance = ctx.resident(ref);
    if (disposed || !instance || !session && !agent) return refused('unavailable', 'the terminal is no longer available');
    if (agent && !['stop', 'close', 'tail'].includes(op)) return refused('unsupported', "the agent's terminal is read-only in the app");
    if ((op === 'run' || op === 'write') && (typeof text !== 'string' || !text)) return refused('invalid', 'non-empty terminal text is needed');
    if (session && (ref.id.length > 200 || !ref.id.trim())) return refused('unavailable', 'the terminal cannot be reached');
    if (session && (op === 'run' || op === 'write') && text.length + (op === 'run' ? 1 : 0) > 100_000) return refused('invalid', 'terminal data must be at most 100000 characters');
    const threadId = instance.links.thread?.id;
    if (op === 'focus' && (!threadId || !threadId.trim() || threadId.length > 200 || threadId.startsWith('client-new-thread:'))) return refused('unavailable', 'the app shows a terminal beside a chat');
    if (agent && op !== 'tail' && !ctx.serverUp()) return ctx.DOWN;
    return { session, agent, instance, threadId };
  }
  return {
    start() {
      if (!timer && !disposed) { timer = setInterval(read, 30_000); timer.unref?.(); }
      return read();
    },
    observe(_ref, concept) { return concept === 'Terminal' ? reading ?? (now() - finishedAt > 10_000 ? read() : Promise.resolve()) : undefined; },
    notified(method, p) {
      if (disposed) return;
      if (method === 'item/started' || method === 'item/completed') learnItem(p.threadId, p.turnId, p.item);
      else if (method === 'turn/started' || method === 'turn/completed') {
        learnTurn(p.threadId, p.turn);
        if (method === 'turn/started' && p.turn?.id) latest.set(p.threadId, p.turn.id);
      } else if (method === 'thread/deleted' || method === 'thread/closed' && !ctx.resident(refs.thread(p.threadId))) forgetThread(p.threadId);
      reconcile();
      schedule();
    },
    responded(method, result) {
      if (disposed) return;
      if (method === 'thread/read' || method === 'thread/resume') {
        const thread = result.thread;
        for (const turn of thread?.turns ?? []) learnTurn(thread.id, turn);
        if (thread?.turns?.length) latest.set(thread.id, thread.turns.at(-1).id);
      } else if (method === 'thread/turns/list') {
        const page = (result.data ?? []).map((turn) => turn.id);
        for (const turn of [...(result.data ?? [])].reverse()) {
          const threadId = ctx.resident(refs.turn(turn.id))?.links.thread?.id;
          if (threadId) { learnTurn(threadId, turn); latestFromPage(threadId, page); }
          else pending.set(turn.id, { turn, page }); // Its thread link arrives when the core puts this page.
        }
      }
      reconcile();
      schedule();
    },
    prompt(op, ref, text) {
      const p = plan(op, ref, text);
      if (p.status === 'refused' || !p.session) return null;
      return {
        action: op === 'run' ? `run “${text.slice(0, 80)}” in the terminal “${p.instance.state.title}”` : `type into the terminal “${p.instance.state.title}”`,
        detail: `It runs in your shell in ${p.instance.state.directory}, with your permissions.`,
      };
    },
    /** Terminal.tail: the app's own terminal's last lines from framework-main (which keeps its recent output), an agent's from its CommandRun. */
    async tail(ref, lines = 100) {
      if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) return refused('invalid', 'from 1 to 1000 lines');
      const p = plan('tail', ref);
      if (p.status === 'refused') return p;
      if (p.agent) return lastLines(ctx.resident(refs.item('CommandRun', p.agent.threadId, p.agent.id))?.state.output ?? '', lines);
      const r = await ctx.mainOp('tail', { sessionId: p.session.id, lines });
      if (r.ok) return typeof r.result?.text === 'string' ? r.result.text : '';
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    async act(op, ref, text, intent) {
      const p = plan(op, ref, text);
      if (p.status === 'refused') return p;
      if (p.agent) {
        const r = await ctx.request('thread/backgroundTerminals/terminate', { threadId: p.agent.threadId, processId: p.agent.processId }, intent);
        return r.terminated ? null : refused('unavailable', 'the command has already ended');
      }
      const args = { sessionId: p.session.id };
      let mainOp = op;
      if (['run', 'write', 'clear', 'stop'].includes(op)) {
        mainOp = 'write';
        args.data = op === 'run' ? `${text}\r` : op === 'write' ? text : op === 'clear' ? '\x0c' : '\x03';
      } else if (op === 'focus') args.threadId = p.threadId;
      if (op === 'close') closing.add(ref.id); // The app can report its exit before answering the operation.
      let r;
      try { r = await ctx.mainOp(mainOp, args); }
      catch (e) { if (op === 'close') closing.delete(ref.id); throw e; }
      if (r.ok) return null;
      if (op === 'close') closing.delete(ref.id);
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    },
    dispose() { disposed = true; clearInterval(timer); clearTimeout(attached); reports.dispose(); graphSub.dispose(); },
  };
}
