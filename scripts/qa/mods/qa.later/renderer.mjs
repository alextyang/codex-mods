// qa.later, renderer realm — QA only (graph-integrity G6.5): what this mod keeps, shown by its own design: a band above the composer of the
// chat a kept message is for (its storage, followed as it changes).
const PREFIX = 'later/';

function renderer(ctx) {
  const R = ctx.ui.react;
  const e = R.createElement;
  function Band({ subject }) {
    const [items, setItems] = R.useState([]);
    const thread = subject?.links?.thread ?? null;
    R.useEffect(() => {
      let live = true;
      const read = async () => {
        const keys = await ctx.storage.list(PREFIX);
        const all = await Promise.all(keys.map((k) => ctx.storage.get(k)));
        if (live) setItems(all.filter((x) => x && thread && x.thread?.id === thread.id));
      };
      void read();
      const w = ctx.storage.watch(PREFIX, () => { void read(); });
      return () => { live = false; w.dispose(); };
    }, [thread?.id ?? '']);
    if (!items.length) return null;
    const text = (c) => (Array.isArray(c?.parts) ? c.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
    return e('div', { 'data-qa-later': String(items.length), className: 'text-sm text-token-text-secondary', style: { padding: 'calc(var(--spacing) * 2) calc(var(--spacing) * 3)' } },
      `${items.length === 1 ? 'One message waits' : `${items.length} messages wait`} to be sent: ${items.map((x) => `“${text(x.content).slice(0, 60)}”`).join(', ')}`);
  }
  const band = ctx.ui.host('Composer', { id: 'later', slot: 'aboveInput', render: Band });
  return () => band.dispose();
}

export default { renderer };
