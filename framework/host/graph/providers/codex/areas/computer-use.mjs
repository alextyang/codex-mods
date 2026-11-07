// Computer use is a chat's activity, from its ComputerAction steps until the turn ends (breadth D8). The app stops it by interrupting
// that turn; it has no separate session object, pause or resume.
import { refs } from '../map.mjs';

export const realizes = {
  types: ['ComputerUseSession'],
  operations: { ComputerUseSession: ['stop'] },
  events: { ComputerUseSession: ['started', 'actionTaken', 'stopped'] },
  links: { ComputerUseSession: ['app', 'thread'] },
};

export function sessionData(threadId, { status, app }) {
  return { ref: refs.computerUseSession(threadId), state: { status }, links: { thread: refs.thread(threadId), app } };
}

export function types(feed) {
  return { ComputerUseSession: { operations: {
    stop: { effect: 'external', handler: ({ ref, intent }) => feed().stop(ref, intent) },
  } } };
}

export function createFeed(ctx) {
  const actions = new Map(), runningTurns = new Map();
  let disposed = false;

  function put(threadId, status, app) {
    const d = sessionData(threadId, { status, app });
    ctx.handle.put(d.ref, { state: d.state, links: d.links });
  }
  function learn(action) {
    const turn = action.links.turn && ctx.resident(action.links.turn), threadId = turn?.links.thread?.id;
    if (!threadId || turn.ref.provider !== refs.agent().provider || !ctx.resident(refs.thread(threadId))) return;
    const ref = refs.computerUseSession(threadId), previous = ctx.resident(ref), fresh = !actions.has(action.ref.id);
    // History arrives newest turn first. Within a turn the core puts its items in order; updating an action keeps that order.
    actions.set(action.ref.id, { threadId, turnStartedAt: turn.state.startedAt, startedAt: action.state.startedAt, app: action.links.app });
    const latest = [...actions.values()].filter((a) => a.threadId === threadId && a.app)
      .sort((a, b) => a.turnStartedAt - b.turnStartedAt || a.startedAt - b.startedAt).at(-1);
    const running = fresh && turn.state.status === 'running';
    if (running) runningTurns.set(threadId, turn.ref.id);
    put(threadId, runningTurns.has(threadId) ? 'running' : 'stopped', latest?.app ?? previous?.links.app ?? null);
    if (running) {
      if (previous?.state.status !== 'running') ctx.emitEvent(ref, 'started');
      ctx.emitEvent(ref, 'actionTaken');
    }
  }
  function stopped(threadId) {
    if (!runningTurns.delete(threadId)) return;
    const ref = refs.computerUseSession(threadId), previous = ctx.resident(ref);
    if (previous) put(threadId, 'stopped', previous.links.app);
    // On deletion (or an ephemeral chat's close) the core has already removed the session with its thread.
    ctx.emitEvent(ref, 'stopped');
  }

  const sub = ctx.graph.onEvent((e) => {
    if (disposed || e.ref?.provider !== refs.agent().provider || e.ref.type !== 'ComputerAction' || !['added', 'changed'].includes(e.kind)) return;
    learn(e.instance);
  });

  return {
    notified(method, p) {
      if (disposed) return;
      if (method === 'turn/completed' && runningTurns.get(p.threadId) === p.turn?.id) stopped(p.threadId);
      if (['thread/archived', 'thread/closed', 'thread/deleted'].includes(method)) stopped(p.threadId);
      if (method === 'thread/deleted') {
        const ref = refs.computerUseSession(p.threadId);
        if (ctx.resident(ref)) ctx.handle.remove(ref);
        for (const [id, a] of actions) if (a.threadId === p.threadId) actions.delete(id);
      }
    },
    observe(ref, concept) {
      if (concept !== 'ComputerUseSession') return undefined;
      return disposed ? Promise.resolve() : ctx.loadThread(ref.id);
    },
    async stop(ref, intent) {
      const turnId = runningTurns.get(ref.id);
      if (disposed || ctx.resident(ref)?.state.status !== 'running' || !turnId) {
        return { status: 'refused', reason: 'unavailable', message: 'Codex is not using the computer in this chat' };
      }
      if (!ctx.serverUp()) return ctx.DOWN;
      await ctx.request('turn/interrupt', { threadId: ref.id, turnId }, intent);
      return null;
    },
    dispose() { disposed = true; sub.dispose(); actions.clear(); runningTurns.clear(); },
  };
}
