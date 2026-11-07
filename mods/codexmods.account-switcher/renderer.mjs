// codexmods.account-switcher, renderer entry (GOAL.md goal 26). Single-file ESM, no imports.
//
// Its Accounts page in Settings: each account with its usage (its most used limit and when its weekly limit resets), whether it is near
// or out, how many chats run on it, and where new chats start; "Add account" (its sign-in opens in the browser), sign in again, sign out
// and remove, each the user's own act. A chat's menu moves it to another account (the user's act; the native menu asks them to confirm).

const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
const STANDING = { out: ['danger', 'Out'], near: ['warning', 'Near its limit'], ok: ['success', 'Has room'], unknown: ['neutral', 'Reading usage'] };

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const status = () => ctx.services.call(ctx.mod.id, 'switcher', 'status', {});
  const act = (ref, op, args, intent) => ctx.graph.invoke(ref, op, args, ...(intent?.asUser ? [{ asUser: intent.asUser }] : []));
  const AGENT = { type: 'CodexAgent', provider: 'codex', id: 'codex' };

  function useStatus() {
    const [data, setData] = R.useState(null);
    const [error, setError] = R.useState(null);
    R.useEffect(() => {
      let live = true;
      const load = () => status().then((d) => { if (live) { setData(d); setError(null); } }, (err) => { if (live) setError(String(err?.message ?? err)); });
      load();
      const sub = ctx.events.on(`mod/${ctx.mod.id}/updated`, load);
      const timer = setInterval(load, 20_000);
      return () => { live = false; sub.dispose(); clearInterval(timer); };
    }, []);
    return { data, error };
  }
  function Account({ a, start, onAct }) {
    const [tone, label] = STANDING[a.standing] ?? STANDING.unknown;
    const resets = Number.isFinite(a.limit?.resetsAt) ? `resets ${new Date(a.limit.resetsAt).toLocaleString()}` : null;
    const items = [
      ...(a.signedIn ? [] : [{ label: 'Sign in', onSelect: (...x) => onAct(a.ref, 'signIn', [], x.at(-1)) }]),
      ...(a.added && a.signedIn ? [{ label: 'Sign out', onSelect: (...x) => onAct(a.ref, 'signOut', [], x.at(-1)) }] : []),
      ...(a.added ? [{ separator: true }, { label: 'Remove', danger: true, onSelect: (...x) => onAct(a.ref, 'remove', [], x.at(-1)) }] : []),
    ];
    return e('div', { 'data-account': a.ref.id, style: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 3)' } },
      e(C.IconTile, { glyph: 'account', size: 'sm' }),
      e('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
        e('span', { className: 'text-sm font-medium', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name, a.added ? '' : ' (the app\'s)'),
        e('span', { className: 'text-xs', style: { color: 'var(--color-text-secondary)' } }, [
          a.plan, a.limit ? `${pct(a.limit.used)} used` : null, resets, `${a.chats} chat${a.chats === 1 ? '' : 's'}`, a.ref.id === start ? 'new chats start here' : null,
        ].filter(Boolean).join(' · '))),
      e(C.Badge, { label, tone }),
      items.length ? e(C.MenuButton, { items, ariaLabel: `${a.name}'s actions` }) : null);
  }
  function Page() {
    const { data, error } = useStatus();
    const [problem, setProblem] = R.useState(null);
    const onAct = (ref, op, args, intent) => {
      setProblem(null);
      act(ref, op, args, intent).then((out) => { if (out?.status !== 'done') setProblem(out?.message ?? out?.status ?? 'it did not happen'); }, (err) => setProblem(String(err?.message ?? err)));
    };
    if (error) return e(C.Banner, { tone: 'danger', title: 'The account switcher is not answering', message: error });
    if (!data) return e(C.EmptyState, { glyph: 'account', title: 'Reading your accounts…' });
    // a kit callback's last argument is the user's intent its input attests (after the event)
    const add = (...x) => onAct(AGENT, 'addAccount', [], x.at(-1));
    return e('div', { 'data-account-switcher': String(data.accounts.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 5)' } },
      problem ? e(C.Banner, { tone: 'warning', message: problem }) : null,
      data.accounts.length < 2
        ? e(C.EmptyState, { glyph: 'account', title: 'One account', description: 'Add another ChatGPT account. Your chats then move to whichever has room.', actions: [{ label: 'Add account', primary: true, onClick: add }] })
        : e(C.Banner, { tone: 'neutral', title: `${data.accounts.length} accounts`, message: `Chats move off an account at ${data.near}% and to the one whose limit resets soonest after they compact.`, actions: [{ label: 'Add account', onClick: add }] }),
      e('section', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 3)' } },
        ...data.accounts.map((a) => e(Account, { key: a.ref.id, a, start: data.start, onAct }))));
  }

  const page = ctx.ui.settings.page({ id: 'accounts', title: 'Accounts', render: () => e(Page) });
  // a chat's menu: run it on another account (the user's act)
  const entries = new Map();
  function sync(accounts) {
    const ids = new Set(accounts.filter((a) => a.signedIn).map((a) => a.ref.id));
    for (const [id, d] of [...entries]) if (!ids.has(id)) { d.dispose(); entries.delete(id); }
    for (const a of accounts) {
      if (!a.signedIn || entries.has(a.ref.id)) continue;
      entries.set(a.ref.id, ctx.ui.contextMenu.add({
        id: `move-${a.ref.id}`, for: 'Thread', title: `Run on ${a.name}`,
        run: async (env) => {
          const out = await act(env?.subject, 'moveToAccount', [a.ref], env);
          if (out?.status !== 'done') { try { ctx.ui.notify({ title: 'The chat did not move', body: String(out?.message ?? out?.status ?? ''), kind: 'warning', surface: 'toast', dedupe: 'move' }); } catch { /* no window */ } }
          return null;
        },
      }));
    }
  }
  const refresh = () => status().then((d) => sync(d.accounts), () => {});
  refresh();
  const sub = ctx.events.on(`mod/${ctx.mod.id}/updated`, refresh);
  return () => { sub.dispose(); for (const d of entries.values()) d.dispose(); page.dispose(); };
}

export default { renderer };
