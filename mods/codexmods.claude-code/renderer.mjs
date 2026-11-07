// codexmods.claude-code, renderer entry (GOAL.md goal 23). Single-file ESM, no imports.
//
// The view its chats open to (`ui.replace('ThreadView', {for: 'ClaudeThread'})`), drawn with the parts the framework lends, so it looks
// like a Codex chat: the header, the transcript of turns (what was asked, the steps with a command's output or an edit's diff, an
// approval's card, the answer as it streams) and the composer with its model picker. Every act is the user's own click carried to the
// graph (`asUser`). Its chats start from its own command, "New Claude Code chat" (the palette): in the project of the window's new chat,
// opened in that window (the app's own new chat is Codex's).

function useRelated(ctx, R, ref, relation) {
  const [items, setItems] = R.useState([]);
  R.useEffect(() => {
    if (!ref) { setItems([]); return undefined; }
    let members = new Map();
    const view = ctx.graph.subscribe(relation ? { ref, relation } : { ref }, (m) => {
      if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [`${x.ref.type}:${x.ref.id}`, x]));
      else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
        const k = `${m.event.ref.type}:${m.event.ref.id}`;
        if (m.event.kind === 'removed') members.delete(k); else if (m.event.instance) members.set(k, m.event.instance);
      } else return;
      setItems([...members.values()]);
    });
    return () => view.dispose();
  }, [ref?.id ?? null, relation ?? null]);
  return items;
}
const byTime = (a, b) => (a.state?.startedAt ?? a.state?.askedAt ?? a.state?.createdAt ?? 0) - (b.state?.startedAt ?? b.state?.askedAt ?? b.state?.createdAt ?? 0);
const STATUS = { running: 'running', waitingForYou: 'running', done: 'completed', failed: 'failed', cancelled: 'failed' };

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const act = (ref, op, args = [], intent = null) => ctx.graph.invoke(ref, op, args, ...(intent?.asUser ? [{ asUser: intent.asUser }] : []))
    .then((out) => { if (out?.status !== 'done') ctx.log.warn(`${op} was not done`, { status: out?.status, message: out?.message ?? out?.error?.message }); return out; },
      (err) => { ctx.log.warn(`${op} failed`, { message: String(err?.message ?? err) }); return null; });

  function Step({ step }) {
    const s = step.state ?? {};
    const status = STATUS[s.status] ?? 'completed';
    if (step.ref.type === 'CommandRun') return e(C.StepRow, { kind: 'command', title: s.title, status, output: s.output ?? '' });
    if (step.ref.type === 'ClaudeEdit') return e(R.Fragment, null, e(C.StepRow, { kind: 'edit', title: s.title, status, diff: s.diff }), s.path ? e(C.FileChip, { path: s.path }) : null);
    if (step.ref.type === 'Reasoning') return e(C.StepRow, { kind: 'reasoning', title: s.title ?? 'Thinking', status, detail: s.thinking ?? undefined });
    return e(C.StepRow, { kind: 'tool', title: s.title, status });
  }
  function Request({ request }) {
    const s = request.state ?? {};
    if (s.status !== 'pending') return null;
    const file = s.files?.[0]?.path;
    const title = s.command ? `Run ${s.command}?` : file ? `${s.files[0].change === 'add' ? 'Create' : 'Change'} ${file.split('/').pop()}?` : `${s.reason ?? 'Let Claude Code use a tool'}?`;
    const detail = request.ref.type === 'ToolApproval' ? s.input : s.reason;
    return e(C.ApprovalCard, { title, detail, options: s.options ?? [], onAnswer: (id, intent) => act(request.ref, 'answer', [id], intent) });
  }
  function TurnView({ turn }) {
    const [asked] = useRelated(ctx, R, turn.ref, 'input');
    const steps = useRelated(ctx, R, turn.ref, 'steps').sort(byTime);
    const requests = useRelated(ctx, R, turn.ref, 'requests').sort(byTime);
    const [answer] = useRelated(ctx, R, turn.links?.answer ?? null);
    return e(C.Turn, { status: turn.state?.status },
      asked ? e(C.Message, { key: 'asked', role: 'user', content: asked.state?.content }) : null,
      ...steps.map((x) => e(Step, { key: x.ref.id, step: x })),
      ...requests.map((x) => e(Request, { key: x.ref.id, request: x })),
      answer ? e(C.Message, { key: 'answer', role: 'agent', content: answer.state?.content, streaming: answer.state?.streaming === true }) : null,
      turn.state?.status === 'failed' && turn.state?.error ? e(C.Banner, { key: 'error', tone: 'danger', message: turn.state.error }) : null);
  }
  function View({ subject }) {
    const ref = subject?.ref ?? null;
    const [chat] = useRelated(ctx, R, ref);
    const live = chat ?? subject;
    const turns = useRelated(ctx, R, ref, 'turns').sort(byTime);
    const [agent] = useRelated(ctx, R, live?.links?.agent ?? null);
    const models = useRelated(ctx, R, agent?.ref ?? null, 'models');
    // shown: what it said is read
    const unread = live?.state?.unread === true;
    R.useEffect(() => { if (ref && unread) void act(ref, 'markRead'); }, [ref?.id ?? null, unread]);
    if (!ref) return null;
    const st = live?.state ?? {};
    const picker = e(C.ModelPicker, { key: 'model', models: models.map((m) => ({ id: m.ref.id, label: m.state?.name })), value: live?.links?.model?.id,
      onChange: (id, intent) => act(ref, 'setModel', [{ type: 'Model', provider: ctx.mod.id, id }], intent) });
    return e('div', { 'data-claude-view': ref.id, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      e(C.ThreadHeader, { title: st.title ?? 'Claude Code', subtitle: st.cwd ? `Claude Code · ${st.cwd.split('/').pop()}` : 'Claude Code' }),
      turns.length ? e(C.Transcript, null, ...turns.map((t) => e(TurnView, { key: t.ref.id, turn: t })))
        : e(C.EmptyState, { glyph: 'terminal', title: 'A Claude Code session', description: st.cwd ? `It works in ${st.cwd}.` : 'It works in your home folder; start it from a project to work there.' }),
      e(C.Composer, { placeholder: 'Message Claude Code', busy: st.status === 'working' || st.status === 'waitingForYou', pickers: [picker],
        onSubmit: (text, intent) => act(ref, 'send', [{ parts: [{ kind: 'text', text }] }], intent),
        onStop: (intent) => act(ref, 'stop', [], intent) }));
  }
  const view = ctx.ui.replace('ThreadView', { id: 'view', for: 'ClaudeThread', render: View });
  const agent = { type: 'ClaudeAgent', provider: ctx.mod.id, id: 'claude' };
  const start = ctx.ui.commands.add({ id: 'new', title: 'New Claude Code chat', description: 'A Claude Code session in this project', keywords: ['claude', 'agent'], icon: 'terminal',
    run: async (env) => {
      const intent = env?.asUser ? { asUser: env.asUser } : null;
      // the project of what the window shows (a chat's, the new chat's), else the draft's
      const w = env?.window ? await ctx.graph.resolve(env.window).catch(() => null) : null;
      const project = w?.links?.project ?? null;
      const made = await act(agent, 'newThread', [project ? { project } : env?.draft ?? null], intent);
      if (made?.status === 'done' && env?.window) await ctx.graph.invoke(env.window, 'open', [made.value]).catch(() => null);
      return null;
    } });
  return () => { start.dispose(); view.dispose(); };
}

export default { renderer };
