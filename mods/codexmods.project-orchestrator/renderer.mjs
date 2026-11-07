// codexmods.project-orchestrator, renderer entry (GOAL.md goal 25). Single-file ESM, no imports.
//
// "New project orchestrator" in a project's menu: the user's own act (the menu's intent), so the new chat is theirs, started in that
// project with the orchestrator's first message and opened. The host is told first (its start gets the orchestrator's instructions and
// tools) and after (the chat is the project's orchestrator). An "Orchestrator" badge marks its chats in the sidebar and their header.

function renderer(ctx) {
  const call = (method, args) => ctx.services.call(ctx.mod.id, 'orchestrator', method, args);
  const entry = ctx.ui.contextMenu.add({
    id: 'new', for: 'Project', title: 'New project orchestrator',
    run: async (env) => {
      const project = env?.subject;
      if (!project || typeof project.id !== 'string') return null;
      const ready = await call('prepare', { project });
      if (!ready?.ok) { ctx.log.warn('no orchestrator', { message: ready?.message }); return null; }
      const out = await ctx.graph.invoke(project, 'newThread', [{ prompt: ready.prompt, send: true, open: true }], ...(env.asUser ? [{ asUser: env.asUser }] : []));
      if (out?.status === 'done' && out.value && typeof out.value.id === 'string') { await call('adopt', { thread: out.value, project }); return null; }
      // not started (the new chat holds the user's own text, which is never written over; or the user said no): they are told why
      const why = out?.message ?? out?.error?.message ?? out?.status;
      ctx.log.warn('the orchestrator did not start', { status: out?.status, message: why });
      try { ctx.ui.notify({ title: 'The project orchestrator did not start', body: /holds the user's text/.test(String(why)) ? 'The new chat holds text of yours. Send or clear it, then try again.' : String(why ?? ''), kind: 'warning', surface: 'toast', dedupe: 'not-started' }); } catch { /* no window */ }
      return null;
    },
  });
  const badge = ctx.ui.decorate('Thread', { id: 'role', where: { [`@${ctx.mod.id}/role`]: 'orchestrator' }, badges: [{ id: 'orchestrator', text: 'Orchestrator', tooltip: 'This project\'s orchestrator' }] });
  return () => { badge.dispose(); entry.dispose(); };
}

export default { renderer };
