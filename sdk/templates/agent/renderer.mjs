// Renderer entry: runs in the app's page. One file, no imports needed.
//
// Its chats' own view: registered for its kind of chat (`ui.replace('ThreadView', {for: 'EchoThread'})`), so the framework opens its
// chats to it wherever they are listed. It is drawn from the agent's own graph data with the parts the framework lends (the chat's
// header, its transcript of turns and messages, its composer), which take the app's own look on each build and in both themes.

/** A relation of an instance, live: its members as they come, change and go. */
function useRelated(ctx, R, ref, relation) {
  const [items, setItems] = R.useState([]);
  R.useEffect(() => {
    if (!ref) { setItems([]); return undefined; }
    let members = new Map();
    const view = ctx.graph.subscribe(relation ? { ref, relation } : { ref }, (m) => {
      if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
      else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
        if (m.event.kind === 'removed') members.delete(m.event.ref.id);
        else if (m.event.instance) members.set(m.event.ref.id, m.event.instance);
      } else return;
      setItems([...members.values()]);
    });
    return () => view.dispose();
  }, [ref?.id ?? null, relation]);
  return items;
}
const byTime = (a, b) => (a.state?.startedAt ?? a.state?.createdAt ?? 0) - (b.state?.startedAt ?? b.state?.createdAt ?? 0);

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  // a call of the user's own input carries their intent (`asUser`, the composer's last argument): the turn is theirs, through this mod
  const act = (ref, op, args = [], intent = null) => ctx.graph.invoke(ref, op, args, ...(intent?.asUser ? [{ asUser: intent.asUser }] : []));

  function TurnView({ turn }) {
    const [asked] = useRelated(ctx, R, turn.ref, 'input');
    const [answer] = useRelated(ctx, R, turn.links?.answer ?? null);
    return e(C.Turn, { status: turn.state?.status },
      asked ? e(C.Message, { role: 'user', content: asked.state?.content }) : null,
      answer ? e(C.Message, { role: 'agent', content: answer.state?.content, streaming: answer.state?.streaming === true }) : null);
  }
  function View({ subject }) {
    const ref = subject?.ref ?? null;
    const turns = useRelated(ctx, R, ref, 'turns').sort(byTime);
    const unread = subject?.state?.unread === true;
    // shown: what it said is read
    R.useEffect(() => { if (ref && unread) void act(ref, 'markRead'); }, [ref?.id ?? null, unread]);
    if (!ref) return null;
    return e('div', { 'data-echo-view': ref.id, style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      e(C.ThreadHeader, { title: subject.state?.title ?? 'Echo chat', subtitle: 'Echo agent' }),
      e(C.Transcript, null, ...turns.map((t) => e(TurnView, { key: t.ref.id, turn: t }))),
      e(C.Composer, { placeholder: 'Say something', busy: subject.state?.status === 'working', onStop: () => act(ref, 'stop'),
        onSubmit: (text, intent) => act(ref, 'send', [{ parts: [{ kind: 'text', text }] }], intent) }));
  }
  const view = ctx.ui.replace('ThreadView', { id: 'view', for: 'EchoThread', render: View });
  return () => view.dispose();
}

export default { renderer };
