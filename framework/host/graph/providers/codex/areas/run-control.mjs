// Copying held chat content, editing the last message through the app, and stopping one background command (breadth step D7, F5).
import { refs, userInput } from '../map.mjs';

export const realizes = {
  operations: { Turn: ['copy', 'retry', 'rewind'], Message: ['copy'], Step: ['copy'], CommandRun: ['copyCommand', 'copyOutput', 'stop'] },
};

/** Content as the text the app reads, including code, links and mention labels. */
export function copyText(content) {
  return userInput(content).find((p) => p.type === 'text')?.text ?? '';
}

/** The request after the app's context wrapper, using the last request heading when there is one. */
export function requestOf(text) {
  const short = '## My request:', long = '## My request for Codex:';
  const at = Math.max(text.lastIndexOf(short), text.lastIndexOf(long));
  if (at >= 0) return text.slice(at + (text.startsWith(long, at) ? long.length : short.length)).trim();
  const end = '\n</page-comment-context>\n';
  if (text.startsWith('<page-comment-context>\n') && text.includes(end)) return text.slice(text.indexOf(end) + end.length).trim();
  return text;
}

/** A step's useful copy text, rather than the common Step title when its subtype has more. */
const STEP_KINDS = ['CommandRun', 'Reasoning', 'Plan', 'FileEdit', 'Search', 'WebLookup', 'ToolCall', 'ComputerAction', 'Delegation'];
export function stepText(step, graph) {
  const s = step.state;
  // by its kind, whatever subtype of it the step is (CodexCommandRun is a CommandRun)
  const chain = graph?.type?.(step.ref.type)?.chain ?? [step.ref.type];
  switch ([...chain].reverse().find((t) => STEP_KINDS.includes(t)) ?? step.ref.type) {
    case 'CommandRun': return s.command;
    case 'Reasoning': return copyText(s.thinking);
    case 'Plan': return graph.referrers(step.ref, 'plan').filter((t) => t.ref.type === 'PlanTask')
      .map((t) => `- [${t.state.status === 'done' ? 'x' : ' '}] ${t.state.text}`).join('\n');
    case 'FileEdit': return step.links.file?.id ?? '';
    case 'Search': return s.query;
    case 'WebLookup': return s.url;
    case 'ToolCall': return copyText(s.output ?? s.input);
    case 'ComputerAction': return s.action;
    case 'Delegation': return copyText(s.task);
    default: return s.title;
  }
}

export function types(feed) {
  return {
    Turn: { operations: {
      copy: { effect: 'local', handler: ({ ref }) => feed().copy(ref, 'turn') },
      retry: { effect: 'external', approval: ({ instance }) => feed().prompt('retry', instance), handler: ({ ref }) => feed().edit(ref) },
      rewind: { effect: 'external', approval: ({ instance, args }) => feed().prompt('rewind', instance, args[0]), handler: ({ ref, args }) => feed().edit(ref, args[0]) },
    } },
    Message: { operations: { copy: { effect: 'local', handler: ({ ref }) => feed().copy(ref, 'message') } } },
    Step: { operations: { copy: { effect: 'local', handler: ({ ref }) => feed().copy(ref, 'step') } } },
    CommandRun: { operations: {
      copyCommand: { effect: 'local', handler: ({ ref }) => feed().copy(ref, 'command') },
      copyOutput: { effect: 'local', handler: ({ ref }) => feed().copy(ref, 'output') },
      stop: { effect: 'external', handler: ({ ref, intent }) => feed().stop(ref, intent) },
    } },
  };
}

export function createFeed(ctx) {
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  const waits = new Set();
  let disposed = false;

  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return null;
    if (r.refused) return refused('unavailable', r.error);
    throw new Error(r.error);
  }

  function editArgs(ref, content) {
    const turn = ctx.resident(ref);
    if (!turn || disposed) return refused('unavailable', 'the turn is not available');
    if (turn.state.status === 'running') return refused('unavailable', 'the turn is still running');
    const thread = turn.links.thread;
    if (!thread) return refused('unavailable', 'the turn has no thread');
    let message;
    if (content !== undefined) {
      message = copyText(content);
      if (!message) return refused('invalid', "rewind takes the message's new text");
    } else {
      const first = (ctx.graph.related(turn.ref, 'input') ?? []).sort((a, b) => a.state.createdAt - b.state.createdAt)[0];
      message = first ? requestOf(copyText(first.state.content)) : '';
      if (!message) return refused('unavailable', 'the turn has no input message');
    }
    return { threadId: thread.id, turnId: turn.ref.id, message };
  }

  return {
    async copy(ref, kind) {
      const instance = ctx.resident(ref);
      if (!instance) return refused('unavailable', 'the instance is not available');
      let text;
      if (kind === 'turn') {
        const answer = instance.links.answer && ctx.resident(instance.links.answer);
        if (!answer) return refused('unavailable', 'the turn has no answer yet');
        text = copyText(answer.state.content);
      } else if (kind === 'message') text = copyText(instance.state.content);
      else if (kind === 'step') text = stepText(instance, ctx.graph);
      else if (kind === 'command') text = instance.state.command;
      else {
        text = instance.state.output;
        if (!text) return refused('unavailable', 'the command has no output yet');
      }
      if (!text) return refused('unavailable', 'there is nothing to copy');
      return appOp('copy', { text });
    },
    prompt(op, instance, content) {
      const args = editArgs(instance.ref, content);
      if (args.status === 'refused') return null;
      const title = ctx.resident(instance.links.thread)?.state.title ?? args.threadId;
      return {
        action: op === 'retry' ? `run the last message of “${title}” again` : `edit the last message of “${title}” and run it again`,
        detail: 'Codex removes that turn and any after it from the chat, then runs the message again, which counts toward your usage. Files it changed stay as they are.',
      };
    },
    async edit(ref, content) {
      const args = editArgs(ref, content);
      if (args.status === 'refused') return args;
      let resolve, timer = null;
      const next = new Promise((r) => { resolve = r; });
      const wait = { threadId: args.threadId, finish(value) {
        if (!waits.delete(wait)) return;
        clearTimeout(timer);
        resolve(value);
      } };
      // The app can announce the new turn before its edit reply. Retain only starts after this call begins, even in that case.
      waits.add(wait);
      // the app's edit is this call, which passed the mods already: its revert and its send are not held again as the user's
      const own = ctx.expectApp?.([{ method: 'thread/revert', match: { threadId: args.threadId, beforeTurnId: args.turnId } },
        { method: 'turn/start', match: { threadId: args.threadId, turnTrigger: 'edit_user_message' } }], 20_000);
      try {
        const no = await appOp('edit-last-turn', args);
        if (no) return no;
        if (waits.has(wait)) {
          timer = setTimeout(() => wait.finish(null), 20_000);
          timer.unref?.();
        }
        return await next;
      } finally { own?.dispose(); wait.finish(null); }
    },
    async stop(ref, intent) {
      const command = ctx.resident(ref);
      if (!command) return refused('unavailable', 'the instance is not available');
      if (command.state.status !== 'running') return refused('unavailable', 'the command is not running');
      const at = ref.id.indexOf(':');
      const threadId = ref.id.slice(0, at), itemId = ref.id.slice(at + 1);
      let cursor = null, terminal;
      do {
        const r = await ctx.request('thread/backgroundTerminals/list', { threadId, cursor }, intent);
        terminal = r.data.find((t) => t.itemId === itemId);
        cursor = r.nextCursor ?? null;
      } while (!terminal && cursor !== null);
      if (!terminal) return refused('unsupported', 'it is not running in the background: stop the turn to stop it');
      const r = await ctx.request('thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId }, intent);
      return r.terminated ? null : refused('unavailable', 'the command has already ended');
    },
    notified(method, p) {
      if (method !== 'turn/started' || !p?.turn?.id) return;
      for (const wait of waits) if (wait.threadId === p.threadId) wait.finish(refs.turn(p.turn.id));
    },
    dispose() { disposed = true; for (const wait of waits) wait.finish(null); },
  };
}
