// qa.intent, renderer realm — QA only (graph-integrity G7): the pending approvals in a region, each with the framework's card (its click
// attested: `onAnswer(id, {asUser})`, the answer the user's through this mod) and this mod's own plain button (no attestation: the answer
// is this mod's, which the user is asked about).
function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const answer = async (a, id, asUser, how) => {
    const out = await ctx.graph.invoke(a.ref, 'answer', [id], asUser ? { asUser } : undefined);
    console.warn(`qa.intent ${how} ${a.ref.id}: ${out.status}${out.message ? ` (${out.message})` : ''}`);
  };
  function Pending() {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      let list = new Map();
      const sub = ctx.graph.subscribe({ type: 'Approval', where: { status: 'pending' } }, (m) => {
        if (m?.type === 'snapshot') list = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
        else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
          // a named event (opened, answered) is not a change of membership: the change itself comes as its own delta
          if (m.event.kind === 'removed' || m.event.instance?.state?.status !== 'pending') list.delete(m.event.ref.id);
          else list.set(m.event.ref.id, m.event.instance);
        } else return;
        setItems([...list.values()]);
      });
      return () => sub.dispose?.();
    }, []);
    if (!items.length) return e(C.EmptyState, { title: 'No approval waits', description: 'Ask the agent for an escalated command.' });
    return e('div', { 'data-qa-intent': String(items.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 3)', padding: 'calc(var(--spacing) * 3)' } },
      ...items.map((a) => {
        const approve = (a.state.options ?? []).find((o) => o.kind === 'approve' && (o.scope ?? 'once') === 'once');
        return e('div', { key: a.ref.id, 'data-qa-intent-item': a.ref.id },
          e(C.ApprovalCard, { title: `Run ${a.state.command ?? 'it'}?`, options: approve ? [approve] : [], onAnswer: (id, intent) => answer(a, id, intent?.asUser, 'card') }),
          approve ? e('button', { type: 'button', 'data-qa-intent-plain': a.ref.id, onClick: () => answer(a, approve.id, null, 'plain'), className: 'text-sm' }, 'Approve with a plain button') : null);
      }));
  }
  const region = ctx.ui.regions.add({ id: 'intent', title: 'QA intent', edge: 'right', width: { default: 420, min: 320, max: 700 }, render: () => e(Pending) });
  return () => region.dispose();
}

export default { renderer };
