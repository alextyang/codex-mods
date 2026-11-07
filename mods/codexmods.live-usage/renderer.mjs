// codexmods.live-usage, renderer entry (GOAL.md goal 21). Single-file ESM, no imports.
//
// Its page in Settings (a tab of the mod's page): each limit with its estimate between whole points, pace and time left, the reserve and
// the messages it holds, and the chats that used the most. Read from the host's `usage` service, again when the host says it changed.

const pct = (v, digits = 1) => (Number.isFinite(v) ? `${v.toFixed(digits)}%` : '—');
const hours = (h) => (!Number.isFinite(h) ? null : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const call = (method, args) => ctx.services.call(ctx.mod.id, 'usage', method, args ?? {});

  function useUsage() {
    const [data, setData] = R.useState(null);
    const [error, setError] = R.useState(null);
    R.useEffect(() => {
      let live = true;
      const load = async () => {
        try {
          const [snap, threads, kept] = await Promise.all([call('snapshot'), call('threads'), call('kept')]);
          if (live) { setData({ snap, threads, kept }); setError(null); }
        } catch (err) { if (live) setError(String(err?.message ?? err)); }
      };
      load();
      const sub = ctx.events.on(`mod/${ctx.mod.id}/updated`, load);
      const timer = setInterval(load, 15_000);
      return () => { live = false; sub.dispose(); clearInterval(timer); };
    }, []);
    return { data, error };
  }
  /** A chat's title, for the list of the chats that used the most. */
  function useTitle(id) {
    const [title, setTitle] = R.useState(null);
    R.useEffect(() => {
      let live = true;
      ctx.graph.resolve({ type: 'CodexThread', provider: 'codex', id }).then((x) => { if (live) setTitle(x?.state?.title ?? null); }).catch(() => {});
      return () => { live = false; };
    }, [id]);
    return title;
  }
  function ChatLine({ t }) {
    const title = useTitle(t.id);
    return e('div', { className: 'text-sm', style: { display: 'flex', justifyContent: 'space-between', gap: 'calc(var(--spacing) * 3)' } },
      e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title ?? 'A chat'),
      e('span', { style: { color: 'var(--color-text-secondary)' } }, t.share !== null ? `≈ ${pct(t.share, 2)}` : `${Math.round(t.cost).toLocaleString()} units`));
  }
  function Limit({ w }) {
    const left = hours(w.hoursLeft);
    return e('div', { 'data-usage-limit': w.name, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 1)' } },
      e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        e('span', { className: 'text-sm font-medium' }, `${w.name} limit`),
        e('span', { className: 'text-sm' }, w.calibrated ? pct(w.estimate) : pct(w.percent, 0))),
      e('div', { className: 'text-xs', style: { color: 'var(--color-text-secondary)' } }, [
        w.ratePerHour !== null && w.ratePerHour > 0.05 ? `${pct(w.ratePerHour)} an hour` : 'Not moving now',
        left && w.hoursLeft < 24 * 14 ? `about ${left} left at this pace` : null,
        Number.isFinite(w.resetsAt) ? `resets ${new Date(w.resetsAt).toLocaleString()}` : null,
        w.calibrated ? null : 'between points once it has moved',
      ].filter(Boolean).join(' · ')));
  }
  function Page() {
    const { data, error } = useUsage();
    if (error) return e(C.Banner, { tone: 'danger', title: 'Live usage is not answering', message: error });
    if (!data) return e(C.EmptyState, { glyph: 'usage', title: 'Reading your usage…' });
    const { snap, threads, kept } = data;
    const held = kept.reduce((a, k) => a + k.count, 0);
    return e('div', { 'data-live-usage': snap.status, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 6)' } },
      snap.estimates.length
        ? e('section', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 4)' } }, ...snap.estimates.map((w) => e(Limit, { key: w.name, w })))
        : e(C.EmptyState, { glyph: 'usage', title: 'No limits reported yet', description: 'Codex reports your limits after a response; send a message to start.' }),
      snap.reserve.percent > 0 ? e(C.Banner, {
        tone: snap.reserve.holding ? 'warning' : 'neutral',
        title: snap.reserve.holding ? `Past your reserve of ${snap.reserve.percent}%` : `Reserve at ${snap.reserve.percent}%`,
        message: held ? `${held} message${held === 1 ? '' : 's'} held, sent when the limit resets.` : snap.reserve.holding ? 'New messages are held until the limit resets.' : 'Messages are held once your most used limit reaches it.',
        actions: held ? [{ label: 'Release held messages', onClick: () => { void call('release', {}); } }] : [],
      }) : null,
      threads.length ? e('section', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)' } },
        e('div', { className: 'text-sm font-medium' }, 'Chats that used the most'),
        ...threads.slice(0, 8).map((t) => e(ChatLine, { key: t.id, t }))) : null);
  }

  const page = ctx.ui.settings.page({ id: 'usage', title: 'Live usage', render: () => e(Page) });
  return () => page.dispose();
}

export default { renderer };
