// qa.test-agent — renderer entry (graph-integrity G2.2, G2.3): its chats' own view, registered for its subtype (`ui.replace('ThreadView',
// {for: 'TestAgentThread'})`) and drawn from its own graph data with the parts the framework lends: the header, the turns (the message, the
// steps, the reply streaming, an open approval or question answered in its card), the composer with its own picker (the chat's tone). The
// framework opens it from the agent's chats wherever they are listed. It reads and acts on its own instances only.

/** A live list of a relation of an instance (or one instance), as this mod reads it. */
function useLive(ctx, R, query, key) {
  const [items, setItems] = R.useState([]);
  R.useEffect(() => {
    if (!query) { setItems([]); return undefined; }
    let list = new Map();
    const k = (r) => `${r.type}\u001f${r.id}`;
    const sub = ctx.graph.subscribe(query, (m) => {
      if (!m) return;
      if (m.type === 'snapshot') list = new Map((m.items ?? (m.instance ? [m.instance] : [])).filter((x) => x && !x.gone && x.ref).map((x) => [k(x.ref), x]));
      else if (m.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
        if (m.event.kind === 'removed') list.delete(k(m.event.ref)); else if (m.event.instance) list.set(k(m.event.ref), m.event.instance);
      } else return;
      setItems([...list.values()]);
    });
    return () => sub.dispose?.();
  }, [key]);
  return items;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c?.parts) ? c.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const content = (t) => ({ parts: [{ kind: 'text', text: t }] });
const STEP_STATUS = { running: 'running', waitingForYou: 'running', done: 'completed', failed: 'failed', cancelled: 'failed' };
const byTime = (a, b) => (a.state?.startedAt ?? a.state?.createdAt ?? 0) - (b.state?.startedAt ?? b.state?.createdAt ?? 0);

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const act = (ref, op, args = []) => ctx.graph.invoke(ref, op, args).catch((err) => console.warn(`test agent: ${op} failed: ${err?.message ?? err}`));

  function Step({ step }) {
    const s = step.state ?? {};
    const status = STEP_STATUS[s.status] ?? 'completed';
    if (step.ref.type === 'CommandRun') return e(C.StepRow, { kind: 'command', title: s.command ?? s.title, status, output: s.output ?? '' });
    if (step.ref.type === 'TestAgentEdit') return e(C.StepRow, { kind: 'edit', title: s.title, status, diff: s.diff, expanded: true });
    if (step.ref.type === 'Reasoning') return e(C.StepRow, { kind: 'reasoning', title: s.title ?? 'Thinking', status, detail: textOf(s.thinking) || undefined });
    return e(C.StepRow, { kind: 'tool', title: s.title, status });
  }
  function Request({ request }) {
    const s = request.state ?? {};
    if (s.status !== 'pending') return null;
    if (Array.isArray(s.prompts)) return e(C.QuestionCard, { prompts: s.prompts, onAnswer: (answers) => act(request.ref, 'answer', [answers]), onSkip: () => act(request.ref, 'skip') });
    return e(C.ApprovalCard, { title: s.command ? `Run ${s.command}?` : String(s.title ?? 'Approve?'), detail: s.reason ?? undefined, options: s.options ?? [], onAnswer: (id) => act(request.ref, 'answer', [id]) });
  }
  function TurnView({ turn }) {
    const input = useLive(ctx, R, { ref: turn.ref, relation: 'input' }, `in:${turn.ref.id}`);
    const steps = useLive(ctx, R, { ref: turn.ref, relation: 'steps' }, `st:${turn.ref.id}`);
    const requests = useLive(ctx, R, { ref: turn.ref, relation: 'requests' }, `rq:${turn.ref.id}`);
    const answerRef = turn.links?.answer ?? null;
    const answer = useLive(ctx, R, answerRef ? { ref: answerRef } : null, `an:${answerRef?.id ?? ''}`)[0];
    return e(C.Turn, { status: turn.state?.status === 'running' ? 'running' : turn.state?.status },
      ...[...input].sort(byTime).map((m) => e(C.Message, { key: m.ref.id, role: 'user', content: m.state?.content })),
      ...[...steps].sort(byTime).map((x) => e(Step, { key: x.ref.id, step: x })),
      ...requests.map((x) => e(Request, { key: x.ref.id, request: x })),
      answer ? e(C.Message, { key: 'answer', role: 'agent', content: answer.state?.content, streaming: answer.state?.streaming === true }) : null);
  }
  function View({ subject }) {
    const ref = subject?.ref;
    const turns = useLive(ctx, R, ref ? { ref, relation: 'turns' } : null, `tu:${ref?.id ?? ''}`);
    const settings = useLive(ctx, R, ref ? { ref, relation: 'settings' } : null, `se:${ref?.id ?? ''}`);
    const tone = settings.find((x) => x.ref.provider === ref?.provider && x.state?.key === 'tone');
    if (!ref) return null;
    const s = subject.state ?? {};
    const working = s.status === 'working';
    const pickers = tone ? [e(C.EffortPicker, { key: 'tone', label: 'Tone', efforts: (tone.state.choices ?? []).map((c) => ({ id: c.id, label: c.label })), value: tone.state.value,
      onChange: (v) => act(tone.ref, 'set', [v]) })] : [];
    return e('div', { 'data-test-agent-view': ref.id, style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      e(C.ThreadHeader, { title: s.title ?? 'Test agent chat', subtitle: 'Test agent' }),
      e(C.Transcript, null, ...[...turns].sort(byTime).map((t) => e(TurnView, { key: t.ref.id, turn: t }))),
      e(C.Composer, { placeholder: 'Message the test agent', busy: working, onStop: () => act(ref, 'stop'), onSubmit: (text) => act(ref, 'send', [content(text)]), pickers }));
  }
  const view = ctx.ui.replace('ThreadView', { id: 'view', for: 'TestAgentThread', render: View });
  return () => view.dispose();
}

export default { renderer };
