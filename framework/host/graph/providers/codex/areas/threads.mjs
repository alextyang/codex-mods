// Thread operations (breadth step D5): protocol writes with the app's pin, archive and worktree bookkeeping, and pins from its service.
import { randomUUID } from 'node:crypto';
import { refs, userInput } from '../map.mjs';
import { sendParams, restoreParams, SEND_KEYS } from '../turn-params.mjs';
import { contextChange } from './agent-inputs.mjs';

export const realizes = {
  operations: { Thread: ['send', 'stop', 'steer', 'archive', 'restore', 'open', 'fork', 'delete', 'compact', 'setModel', 'pin', 'unpin', 'export'] },
  supports: { Thread: ['pinned'] },
};

// What a change of a send does more than the send did (public-hooks.md §3.5: refused, whoever changed it): more access than it named (the
// chat's own when it named none, so only read-only is surely not more; leaving out what it named is the chat's own, which may be more),
// out of the plan mode it named (or a mode where it named none), its settings kept for the chat.
const ACCESS_RANK = { 'read-only': 0, workspace: 1, full: 2 };
/**
 * A change of a send as its changer's own (graph-integrity G3.5): in the turn's context a mod adds or changes only its own key (`mod:<id>`);
 * a change that does only that is quiet (the user granted it at install: it sends nothing new), anything else is asked about as usual.
 */
export function sendChange({ before, after, by }) {
  const why = contextChange(before?.[1]?.additionalContext, after?.[1]?.additionalContext, by);
  if (why) return why;
  const strip = (args) => { const [content, options] = args ?? []; const { additionalContext: _c, ...rest } = options ?? {}; return JSON.stringify([content ?? null, rest]); };
  return strip(before) === strip(after) ? { quiet: true } : null;
}

export function sendWidens({ original, args }) {
  const was = original?.[1] ?? {}, now = args?.[1] ?? {};
  const a = now.settings?.access, b = was.settings?.access;
  if (a !== b) {
    if (a === undefined) return `it leaves out the ${b} access the send named`;
    const lower = Object.hasOwn(ACCESS_RANK, a) && (b === undefined ? ACCESS_RANK[a] === 0 : Object.hasOwn(ACCESS_RANK, b) && ACCESS_RANK[a] < ACCESS_RANK[b]);
    if (!lower) return `it asks for ${a} access`;
  }
  const m = now.settings?.mode, n = was.settings?.mode;
  if (m !== n && m !== 'plan') return m === undefined ? `it leaves out the ${n} mode the send named` : `it sends in ${m} mode${n ? ` where the send was in ${n} mode` : ''}`;
  if (now.sticky === true && was.sticky !== true) return 'it keeps its settings for the chat';
  return null;
}

export function types(feed) {
  return { Thread: { operations: {
    send: { effect: 'external', approval: ({ instance, args }) => feed().prompt('send', instance, args[0], args[1]), widens: sendWidens, change: sendChange,
      handler: ({ ref, args, intent, caller, key }) => feed().send(ref, args[0], intent, args[1], caller, key) },
    steer: { effect: 'external', approval: ({ instance, args }) => feed().prompt('steer', instance, args[0]), handler: ({ ref, args, intent }) => feed().steer(ref, args[0], intent) },
    stop: { effect: 'external', handler: ({ ref, intent, caller }) => feed().stop(ref, intent, caller) },
    archive: { effect: 'external', handler: ({ ref, intent }) => feed().archive(ref, intent) },
    restore: { effect: 'external', handler: ({ ref, intent }) => feed().restore(ref, intent) },
    open: { effect: 'local', handler: ({ ref }) => feed().open(ref) },
    fork: { effect: 'external', handler: ({ ref, args, intent }) => feed().fork(ref, args[0], intent, args[1]) },
    delete: { effect: 'external', approval: ({ instance }) => feed().prompt('delete', instance), handler: ({ ref }) => feed().delete(ref) },
    compact: { effect: 'external', approval: ({ instance }) => feed().prompt('compact', instance), handler: ({ ref, intent }) => feed().compact(ref, intent) },
    setModel: { effect: 'external', handler: ({ ref, args, intent }) => feed().setModel(ref, args[0], intent) },
    pin: { effect: 'external', handler: ({ ref }) => feed().pin(ref, true) },
    unpin: { effect: 'external', handler: ({ ref }) => feed().pin(ref, false) },
    export: { effect: 'none', handler: ({ ref }) => feed().export(ref) },
  } } };
}

/** A transcript's resolved input messages and answer, as Content values, in turn order. */
export function markdownOf(title, turns) {
  const text = (content) => (content?.parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text).join('');
  const blocks = [`# ${title}`];
  for (const turn of turns) {
    blocks.push(`**You:** ${turn.input.map(text).join('\n\n')}`);
    if (turn.answer) blocks.push(`**Codex:** ${text(turn.answer)}`);
  }
  return blocks.join('\n\n');
}

export function createFeed(ctx) {
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  const turnsOf = (ref) => ctx.graph.referrers(ref, 'thread').filter((x) => ctx.graph.type(x.ref.type)?.concept === 'Turn' && x.ref.provider === ref.provider && !x.gone);
  /** The thread's own settings now (its Settings' values), and the models this provider offers with their efforts. */
  const settingsOf = (threadId) => Object.fromEntries(SEND_KEYS.map((k) => [k, ctx.resident(refs.threadSetting(threadId, k))?.state.value ?? null]));
  const offeredModels = () => ctx.graph.list('Model').filter((m) => m.ref.provider === refs.agent().provider && !m.gone && m.state.available !== false)
    .map((m) => ({ id: m.ref.id, efforts: (m.state.efforts ?? []).map((e) => e.id) }));
  const running = (ref) => turnsOf(ref).filter((x) => x.state.status === 'running').sort((a, b) => b.state.startedAt - a.state.startedAt)[0] ?? null;
  const state = (ref) => ctx.resident(ref)?.state ?? {};
  const isRef = (ref, type) => ref && ref.provider === refs.agent().provider && typeof ref.id === 'string' && ref.id.length > 0 && (ref.type === type || ctx.graph.type(ref.type)?.concept === type);
  let pins = null, reading = null, timer = null, afterMove = null, disposed = false;

  function applyPins(threadId) {
    if (!pins || disposed) return;
    const threads = threadId ? [ctx.resident(refs.thread(threadId))].filter(Boolean) : ctx.graph.list('CodexThread');
    for (const thread of threads) {
      if (thread.gone || thread.ref.provider !== refs.agent().provider) continue;
      const pinned = pins.has(thread.ref.id);
      if (thread.state.pinned !== pinned) ctx.updateThread(thread.ref.id, { pinned });
    }
  }
  async function readPins() {
    if (disposed) return;
    if (reading) return reading;
    reading = (async () => {
      try {
        const r = await ctx.mainOp('pinned', {});
        if (!r.ok) throw new Error(r.error);
        if (disposed || !Array.isArray(r.result?.threadIds)) return;
        pins = new Set(r.result.threadIds.filter((id) => typeof id === 'string'));
        applyPins();
      } catch (e) { ctx.log.warn('threads: pins could not be read', { message: String(e?.message ?? e) }); }
    })().finally(() => { reading = null; });
    return reading;
  }
  async function bestEffort(what, fn) {
    try {
      const r = await fn();
      if (r?.ok === false) throw new Error(r.error);
    } catch (e) { ctx.log.warn(`threads: ${what} failed`, { message: String(e?.message ?? e) }); }
  }

  return {
    start() {
      if (disposed) return;
      if (!timer) { timer = setInterval(readPins, 60_000); timer.unref?.(); }
      return readPins();
    },
    serverUp: readPins,
    notified(method, p) { if (method === 'thread/started') applyPins(p?.thread?.id); },
    responded(method) {
      if (disposed) return;
      if (method === 'thread/section/move') {
        clearTimeout(afterMove);
        afterMove = setTimeout(() => { afterMove = null; readPins(); }, 500);
        afterMove.unref?.();
      }
      // The core's whole-thread reads replace its state, including pins; keep the last service snapshot on those threads too.
      if (['thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/list'].includes(method)) applyPins();
    },
    prompt(op, instance, content, options) {
      if (!ctx.serverUp()) return null;
      const ref = instance.ref, title = instance.state.title;
      if (op === 'send' || op === 'steer') {
        if (!userInput(content).length || (op === 'send' ? running(ref) : !running(ref))) return null;
        const own = op === 'send' && options?.settings && typeof options.settings === 'object' ? Object.entries(options.settings).map(([k, v]) => `${k} ${v}`).join(', ') : '';
        return { action: op === 'send' ? `send a message in “${title}”${own ? ` (${own})` : ''}` : `steer “${title}”`, detail: "Codex works on it with this chat's permissions, and it counts toward your usage." };
      }
      if (op === 'compact' && !running(ref)) return { action: `compact the chat “${title}”`, detail: 'Codex summarizes it to free context, which counts toward your usage.' };
      if (op === 'delete' && instance.state.archived) return { action: `delete the chat “${title}”`, detail: 'It cannot be restored.' };
      return null;
    },
    /**
     * A send, with its own settings when given (`options.settings`: the thread's Setting keys model, effort, mode, access): they apply to
     * this turn, and the thread's values are put back once it started unless `options.sticky` (the protocol keeps them otherwise).
     */
    async send(ref, content, intent, options, caller, key = null) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (running(ref)) return refused('unavailable', 'a turn is running: steer or enqueue instead');
      const input = userInput(content);
      if (!input.length) return refused('invalid', 'a message is needed');
      // the options are CodexThread's own (the concept's send takes the provider's): {settings?: an object, sticky?: a boolean,
      // additionalContext?: the turn's context as the source has it (G3.5), {[key]: {kind, value}}}, nothing else
      const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (options !== undefined && options !== null && (!isObj(options) || Object.keys(options).some((k) => k !== 'settings' && k !== 'sticky' && k !== 'additionalContext')
        || (options.settings !== undefined && !isObj(options.settings))
        || (options.sticky !== undefined && typeof options.sticky !== 'boolean')
        || (options.additionalContext !== undefined && (!isObj(options.additionalContext) || Object.values(options.additionalContext).some((x) => !isObj(x) || typeof x.kind !== 'string' || typeof x.value !== 'string')))))
        return refused('invalid', 'options is {settings?, sticky?, additionalContext?}');
      const current = settingsOf(ref.id);
      const plan = sendParams(options?.settings, { current, models: offeredModels() });
      if (plan.refused) return plan.refused;
      const clientUserMessageId = randomUUID();
      // the turn it starts is the mod's, with its key when the call had one (G6.3)
      if (caller?.kind === 'mod') ctx.noteSend(clientUserMessageId, { kind: 'mod', id: caller.id, ...(typeof key === 'string' && key ? { key } : {}) });
      // the user's through the graph: theirs, through the mod whose surface they acted in when they did (G7.3)
      else if (caller?.kind === 'user' || caller?.kind === 'framework') ctx.noteSend(clientUserMessageId, { kind: 'user', ...(typeof caller.through === 'string' && caller.through ? { through: caller.through } : {}) });
      const context = options?.additionalContext && Object.keys(options.additionalContext).length ? { additionalContext: options.additionalContext } : {};
      const r = await ctx.withLoadedThread(ref.id, () => ctx.request('turn/start', { threadId: ref.id, input, clientUserMessageId, ...plan.params, ...context }, intent), intent);
      const back = options?.sticky === true ? null : restoreParams(ref.id, plan.changed, current);
      if (back) await ctx.request('thread/settings/update', back, intent).catch((e) => ctx.log.warn('a send\'s settings could not be put back', { thread: ref.id, message: String(e?.message ?? e) }));
      return refs.turn(r.turn.id);
    },
    async steer(ref, content, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const turn = running(ref);
      if (!turn) return refused('unavailable', 'no turn is running');
      const input = userInput(content);
      if (!input.length) return refused('invalid', 'a message is needed');
      await ctx.request('turn/steer', { threadId: ref.id, expectedTurnId: turn.ref.id, input, clientUserMessageId: randomUUID() }, intent);
      return null;
    },
    async stop(ref, intent, caller) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const turn = running(ref);
      if (!turn) return null;
      if (state(ref).goal?.status === 'active') await ctx.request('thread/goal/set', { threadId: ref.id, status: 'paused' }, intent);
      ctx.noteStop?.(turn.ref.id, caller);
      await ctx.request('turn/interrupt', { threadId: ref.id, turnId: turn.ref.id }, intent);
      await bestEffort('background terminals clean', () => ctx.request('thread/backgroundTerminals/clean', { threadId: ref.id }, intent));
      return null;
    },
    async archive(ref, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (state(ref).archived) return null;
      await bestEffort('archive preparation', () => ctx.mainOp('archive-prepare', { threadId: ref.id, cwd: ctx.cwdOf(ref.id) }));
      try { await ctx.request('thread/archive', { threadId: ref.id }, intent); } catch (e) {
        if (!/no rollout found/i.test(String(e?.message ?? e))) throw e;
        const r = await ctx.mainOp('archive-inactive', { threadId: ref.id });
        if (!r.ok) throw new Error(r.error, { cause: e });
      }
      if (state(ref).pinned) await bestEffort('archive unpin', () => ctx.mainOp('pin', { threadId: ref.id, pinned: false }));
      await readPins();
      return null;
    },
    async restore(ref, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (!state(ref).archived) return null;
      await bestEffort('restore preparation', () => ctx.mainOp('restore-prepare', { threadId: ref.id }));
      await ctx.request('thread/unarchive', { threadId: ref.id }, intent);
      return null;
    },
    async open(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      try {
        const r = await ctx.mainOp('open', { threadId: ref.id });
        return r.ok ? null : refused('unavailable', r.error);
      } catch (e) { return refused('unavailable', String(e?.message ?? e)); }
    },
    async fork(ref, at, intent, options) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (at !== undefined && at !== null) {
        const thread = isRef(at, 'Turn') && ctx.resident(at)?.links.thread;
        if (!thread || thread.provider !== ref.provider || thread.id !== ref.id) return refused('invalid', 'a turn of this thread is needed');
      }
      // the options are the source's fork parameters (G3.5: its developer instructions, config...), the thread and the turn are the call's
      if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) return refused('invalid', 'options are the fork\'s parameters, an object');
      const { threadId: _t, lastTurnId: _l, beforeTurnId: _b, ...rest } = options ?? {};
      const r = await ctx.request('thread/fork', { ...rest, threadId: ref.id, ...(at ? { lastTurnId: at.id } : {}) }, intent);
      return refs.thread(r.thread.id);
    },
    async delete(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (!state(ref).archived) return refused('unsupported', 'the app deletes only archived chats');
      const r = await ctx.mainOp('delete', { threadId: ref.id });
      if (!r.ok) {
        if (r.refused) return refused('unavailable', r.error);
        throw new Error(r.error);
      }
      if (!r.result?.deletedThreadIds?.includes(ref.id)) throw new Error('the app did not delete the thread');
      return null;
    },
    async compact(ref, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (running(ref)) return refused('unavailable', 'the app compacts a chat between turns');
      await ctx.withLoadedThread(ref.id, () => ctx.request('thread/compact/start', { threadId: ref.id }, intent), intent);
      return null;
    },
    async setModel(ref, model, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (!isRef(model, 'Model')) return refused('invalid', 'a Codex model is needed');
      await ctx.withLoadedThread(ref.id, () => ctx.request('thread/settings/update', { threadId: ref.id, model: model.id }, intent), intent);
      return null;
    },
    async pin(ref, pinned) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (state(ref).pinned === pinned) return null;
      const r = await ctx.mainOp('pin', { threadId: ref.id, pinned });
      if (!r.ok) {
        if (r.refused) return refused('unavailable', r.error);
        throw new Error(r.error);
      }
      ctx.updateThread(ref.id, { pinned });
      await readPins();
      return null;
    },
    async export(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      await ctx.loadThread(ref.id);
      const turns = turnsOf(ref).sort((a, b) => a.state.startedAt - b.state.startedAt).map((turn) => {
        const input = Array.isArray(turn.links.input)
          ? turn.links.input.map((r) => ctx.resident(r)).filter(Boolean)
          : ctx.graph.referrers(turn.ref, 'turn').filter((x) => x.ref.type === 'UserMessage' && x.ref.provider === ref.provider);
        const answer = turn.links.answer && ctx.resident(turn.links.answer);
        return { input: input.map((x) => x.state.content), answer: answer?.state.content ?? null };
      });
      return { parts: [{ kind: 'text', text: markdownOf(state(ref).title, turns) }] };
    },
    dispose() { disposed = true; clearInterval(timer); clearTimeout(afterMove); },
  };
}
