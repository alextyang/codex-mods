// qa.conformance, renderer entry — QA only (graph-integrity G9.1, G9.2): its chats' variation, as a mod's is: its view, registered for
// its own kind of chat (`ui.replace('ThreadView', {for: 'ConfThread'})`) and drawn with every part the framework lends, fed with this mod's
// own graph data (its header, its turns with their messages, a command step, an edit with its diff and its file, each pending request's
// card, its composer with its models and efforts); its mark on its chats wherever the app shows a chat; and a region of its chats as the
// lent ChatRow draws them, with a DropTarget that takes a chat. Every part is wrapped in `data-conf-part="<name>"`, so a native check
// counts what each drew. It reads and acts on its own instances only.

/** A relation of an instance (or the instance itself), live. */
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
    .then((out) => { console.warn(`qa.conformance ${op} ${ref.type}:${ref.id}: ${out.status}`); return out; });
  const part = (name, child, key) => e('div', { key: key ?? name, 'data-conf-part': name }, child);

  function Step({ step }) {
    const s = step.state ?? {};
    if (step.ref.type === 'CommandRun') return part('StepRow', e(C.StepRow, { kind: 'command', title: s.title, status: STATUS[s.status] ?? 'completed', output: s.output ?? '' }));
    if (step.ref.type === 'ConfEdit') {
      return e(R.Fragment, null,
        part('StepRow', e(C.StepRow, { kind: 'edit', title: s.title, status: STATUS[s.status] ?? 'completed', diff: s.diff }), 'step'),
        part('DiffView', e(C.DiffView, { diff: s.diff }), 'diff'),
        part('FileChip', e(C.FileChip, { path: s.path, onOpen: () => console.warn(`qa.conformance opened ${s.path}`) }), 'file'));
    }
    return part('StepRow', e(C.StepRow, { kind: 'tool', title: s.title, status: STATUS[s.status] ?? 'completed' }));
  }
  function Request({ request }) {
    const s = request.state ?? {};
    if (s.status !== 'pending') return null;
    if (Array.isArray(s.prompts)) {
      return part('QuestionCard', e(C.QuestionCard, { prompts: s.prompts, onAnswer: (answers, intent) => act(request.ref, 'answer', [answers], intent), onSkip: (intent) => act(request.ref, 'skip', [], intent) }));
    }
    const title = s.command ? `Run ${s.command}?` : s.host ? `Reach ${s.host}?` : s.action ? `Let the agent ${s.action}?` : s.files ? 'Apply these edits?' : 'Use the tool?';
    return part('ApprovalCard', e(C.ApprovalCard, { title, options: s.options ?? [], onAnswer: (id, intent) => act(request.ref, 'answer', [id], intent) }));
  }
  function TurnView({ turn }) {
    const [asked] = useRelated(ctx, R, turn.ref, 'input');
    const steps = useRelated(ctx, R, turn.ref, 'steps').sort(byTime);
    const requests = useRelated(ctx, R, turn.ref, 'requests').sort(byTime);
    const [answer] = useRelated(ctx, R, turn.links?.answer ?? null);
    return part('Turn', e(C.Turn, { status: turn.state?.status },
      asked ? part('Message', e(C.Message, { role: 'user', content: asked.state?.content }), 'asked') : null,
      ...steps.map((x) => e(Step, { key: x.ref.id, step: x })),
      ...requests.map((x) => e(Request, { key: x.ref.id, request: x })),
      answer ? part('Message', e(C.Message, { role: 'agent', content: answer.state?.content, streaming: answer.state?.streaming === true }), 'answer') : null));
  }
  function View({ subject }) {
    const ref = subject?.ref ?? null;
    const turns = useRelated(ctx, R, ref, 'turns').sort(byTime);
    const [agent] = useRelated(ctx, R, subject?.links?.agent ?? null);
    const models = useRelated(ctx, R, agent?.ref ?? null, 'models');
    const [model, setModel] = R.useState(subject?.links?.model?.id ?? null);
    const [effort, setEffort] = R.useState(null);
    if (!ref) return null;
    const current = models.find((m) => m.ref.id === model) ?? models.find((m) => m.state?.default) ?? null;
    const pickers = [
      part('ModelPicker', e(C.ModelPicker, { models: models.map((m) => ({ id: m.ref.id, label: m.state?.name })), value: current?.ref.id, onChange: (v) => { setModel(v); setEffort(null); } }), 'model'),
      part('EffortPicker', e(C.EffortPicker, { efforts: current?.state?.efforts ?? [], value: effort ?? current?.state?.efforts?.[0]?.id, onChange: setEffort }), 'effort'),
    ];
    return e('div', { 'data-conf-view': ref.id, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      part('ThreadHeader', e(C.ThreadHeader, { title: subject.state?.title ?? 'Conformance chat', subtitle: 'Conformance',
        actions: [{ id: 'open-requests', label: 'More requests', onClick: () => void ctx.services.call('qa.conformance', 'conformance', 'openRequests', {}).catch(() => {}) }] })),
      part('Transcript', e(C.Transcript, null, ...turns.map((t) => e(TurnView, { key: t.ref.id, turn: t })))),
      part('Composer', e(C.Composer, { placeholder: 'Message the conformance agent', busy: subject.state?.status === 'working', onStop: (intent) => act(ref, 'stop', [], intent),
        onSubmit: (text, intent) => act(ref, 'send', [{ parts: [{ kind: 'text', text }] }], intent), pickers })),
      e('div', { hidden: true, 'data-conf-pickers': `${current?.ref.id ?? ''}/${effort ?? ''}` }));
  }
  function Rows() {
    const chats = useRelated(ctx, R, { type: 'ConfAgent', provider: ctx.mod.id, id: 'agent' }, 'threads');
    const [dropped, setDropped] = R.useState(null);
    return e('div', { 'data-conf-rows': String(chats.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)', padding: 'calc(var(--spacing) * 2)' } },
      ...chats.map((c) => part('ChatRow', e(C.ChatRow, { title: c.state?.title, status: c.state?.status, unread: c.state?.unread === true, time: c.state?.updatedAt,
        onOpen: (intent) => act(c.ref, 'markRead', [], intent), drag: c.ref }), c.ref.id)),
      part('DropTarget', e(C.DropTarget, { accepts: ['Thread'], onDrop: ({ ref }) => { setDropped(ref); console.warn(`qa.conformance dropped ${ref.type}:${ref.id}`); } },
        e('div', { className: 'text-sm', style: { padding: 'calc(var(--spacing) * 3)' } }, dropped ? `Dropped ${dropped.id}` : 'Drop a chat here'))));
  }
  const view = ctx.ui.replace('ThreadView', { id: 'view', for: 'ConfThread', render: View });
  // its variation's mark, wherever the app shows one of its chats
  const mark = ctx.ui.decorate('Thread', { id: 'mark', for: 'ConfThread', badges: [{ id: 'conf', text: 'Conformance' }] });
  const rows = ctx.ui.regions.add({ id: 'rows', title: 'Conformance rows', edge: 'right', width: { default: 360, min: 280, max: 600 }, render: () => e(Rows) });
  return () => { view.dispose(); mark.dispose(); rows.dispose(); };
}

export default { renderer };
