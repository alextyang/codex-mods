// qa.later, host realm — QA only (graph-integrity G6): stop now, act later. While `holding` is on, the user's send in a chat is stopped
// (quietly: the composer keeps nothing it should not, as this mod clears it once the message is kept), the message kept in this mod's
// storage with a job scheduled a minute on; the job sends it as this mod with its key, and after an uncertain delivery looks the key up
// first, so a message is never sent twice. What waits is the mod's own data: its renderer shows it above that chat's composer.
// Also (G6.4, G6.1): a pending approval answered by this mod eleven minutes on, unless the user did first; the agent's own turn stopped.
const DELAY_MS = 60_000;
const PREFIX = 'later/';

export default {
  async host(ctx) {
    const handlers = new Map();
    const sendLater = (id) => async (job) => {
      const item = await ctx.storage.get(PREFIX + id);
      if (!item) return;
      if (job.delivery === 'uncertain') {
        const was = await ctx.graph.made(id);
        ctx.log.info(`qa.later: ${id} delivered again after a crash; the key says ${was?.status ?? 'nothing'}`);
        if (was && (was.status === 'done' || was.status === 'started' || was.status === 'uncertain')) { await ctx.storage.delete(PREFIX + id); return; }
      }
      const out = await ctx.graph.invoke(item.thread, 'send', [item.content], { key: id });
      ctx.log.info(`qa.later: sent ${id}: ${out.status}${out.message ? ` (${out.message})` : ''}`);
      if (out.status !== 'refused') await ctx.storage.delete(PREFIX + id);
    };
    const follow = (id) => { if (!handlers.has(id)) handlers.set(id, ctx.scheduler.on(id, sendLater(id))); };
    // what waited across a restart: its jobs' handlers again
    for (const key of await ctx.storage.list(`${PREFIX}send-`)) follow(key.slice(PREFIX.length));
    const ic = ctx.graph.intercept('Draft', 'send', async (call, next) => {
      if ((await ctx.settings.get('holding')) !== true) return next();
      const thread = call.instance?.links?.thread ?? null;
      const content = call.instance?.state?.content ?? null;
      if (!thread || !content || !Array.isArray(content.parts) || !content.parts.length) return next();   // a new chat's: as it is
      const id = `send-${Date.now().toString(36)}`;
      // kept durably first: the stop follows the write
      await ctx.storage.set(PREFIX + id, { thread, content, at: Date.now(), due: Date.now() + DELAY_MS });
      follow(id);
      await ctx.scheduler.schedule({ id, at: Date.now() + DELAY_MS });
      ctx.log.info(`qa.later: kept ${id} for ${thread.id}`);
      // the composer is this mod's to clear, once the message is kept (after the stop is answered)
      setTimeout(() => { ctx.graph.invoke(call.ref, 'clear', []).catch((e) => ctx.log.warn(`qa.later: not cleared: ${e?.message ?? e}`)); }, 0);
      return { status: 'stopped', message: 'kept: sent in a minute' };
    });
    // answered later (G6.4): a pending approval waits at its source; eleven minutes on this mod approves it once, unless the user did first
    const ANSWER_MS = 11 * 60_000;
    const answerLater = (id) => async () => {
      const item = await ctx.storage.get(PREFIX + id);
      if (!item) return;
      await ctx.storage.delete(PREFIX + id);
      const out = await ctx.graph.invoke(item.approval, 'answer', [item.option], { key: id });
      ctx.log.info(`qa.later: answered ${id} ${Math.round((Date.now() - item.at) / 60000)} min on: ${out.status}${out.message ? ` (${out.message})` : ''}`);
    };
    const followAnswer = (id) => { if (!handlers.has(id)) handlers.set(id, ctx.scheduler.on(id, answerLater(id))); };
    for (const key of await ctx.storage.list(`${PREFIX}answer-`)) followAnswer(key.slice(PREFIX.length));
    const kept = new Set();
    const approvals = ctx.graph.subscribe({ type: 'Approval', where: { status: 'pending' } }, async (m) => {
      if ((await ctx.settings.get('answerLater')) !== true) return;
      const list = m?.type === 'snapshot' ? m.items ?? [] : m?.type === 'delta' && m.event?.instance ? [m.event.instance] : [];
      for (const a of list) {
        if (!a?.ref || a.state?.status !== 'pending' || kept.has(a.ref.id)) continue;
        const option = (a.state.options ?? []).find((o) => o.kind === 'approve' && (o.scope ?? 'once') === 'once') ?? (a.state.options ?? []).find((o) => o.kind === 'approve');
        if (!option) continue;
        kept.add(a.ref.id);
        const id = `answer-${Date.now().toString(36)}`;
        await ctx.storage.set(PREFIX + id, { approval: a.ref, option: option.id, at: Date.now() });
        followAnswer(id);
        await ctx.scheduler.schedule({ id, at: Date.now() + ANSWER_MS });
        ctx.log.info(`qa.later: ${a.ref.id} will be answered at ${new Date(Date.now() + ANSWER_MS).toISOString()} (${id})`);
      }
    });
    // the agent's own turn (G6.1, G1.7): stopped as it starts, on its event
    const stopping = new Set();
    const turns = ctx.graph.subscribe({ type: 'Turn', where: { status: 'running' } }, async (m) => {
      if ((await ctx.settings.get('stopAgent')) !== true) return;
      const list = m?.type === 'snapshot' ? m.items ?? [] : m?.type === 'delta' && m.event?.instance ? [m.event.instance] : [];
      for (const t of list) {
        if (!t?.ref || t.state?.status !== 'running' || t.state?.startedBy?.kind !== 'agent' || stopping.has(t.ref.id) || !t.links?.thread) continue;
        stopping.add(t.ref.id);
        const out = await ctx.graph.invoke(t.links.thread, 'stop', []);
        ctx.log.info(`qa.later: the agent's own turn ${t.ref.id} stopped: ${out.status}${out.message ? ` (${out.message})` : ''}`);
      }
    });
    return () => { ic.dispose(); approvals.dispose(); turns.dispose(); for (const h of handlers.values()) h.dispose(); };
  },
};
