// Renderer entry: runs in the app's page. One file, no imports needed (with a bundler, `import { defineMod } from '@codexmods/sdk'`;
// a plain object is the same).
//
// A tab of the side panel beside a chat: what was asked in each of the chat's turns, kept live as the chat goes on. It reads the graph
// as this mod (`ctx.graph`, under its `graph.read` grant), follows a relation with `subscribe`, and draws with the framework's kit
// (`ctx.ui.components`), which takes the app's own look in both themes. The panel tab gets the chat beside it as `thread`.

/** What a message says, as plain text. */
const textOf = (content) => (Array.isArray(content?.parts) ? content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const byStart = (a, b) => (a.state?.startedAt ?? 0) - (b.state?.startedAt ?? 0);

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;

  /** A relation of an instance, live: its members as they come, change and go. */
  function useRelated(ref, relation) {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      if (!ref) { setItems([]); return undefined; }
      let members = new Map();
      const view = ctx.graph.subscribe({ ref, relation }, (m) => {
        if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
        else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
          if (m.event.kind === 'removed') members.delete(m.event.ref.id);
          else if (m.event.instance) members.set(m.event.ref.id, m.event.instance);
        } else return;
        setItems([...members.values()]);
      });
      return () => view.dispose();
    }, [ref?.id ?? null]);
    return items;
  }

  function Asked({ turn }) {
    const [message] = useRelated(turn.ref, 'input');
    return e('span', null, textOf(message?.state?.content).slice(0, 120) || '…');
  }
  function Outline({ thread }) {
    const turns = useRelated(thread, 'turns').sort(byStart);
    if (!thread) return e(C.EmptyState, { title: 'No chat here', description: 'Open a chat to see its outline.' });
    if (!turns.length) return e(C.EmptyState, { title: 'Nothing asked yet', description: 'Each message you send is listed here.' });
    return e('ol', { 'data-outline': thread.id, className: 'text-sm', style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)', padding: 'calc(var(--spacing) * 3)' } },
      ...turns.map((t) => e('li', { key: t.ref.id, style: { display: 'flex', gap: 'calc(var(--spacing) * 2)', alignItems: 'baseline' } },
        e(Asked, { turn: t }),
        t.state?.status === 'running' ? e(C.Badge, { label: 'Working', tone: 'info' }) : null)));
  }

  const panel = ctx.ui.panel({ id: 'outline', title: 'Outline', icon: 'list', render: ({ thread }) => e(Outline, { thread }) });
  return () => panel.dispose();
}

export default { renderer };
