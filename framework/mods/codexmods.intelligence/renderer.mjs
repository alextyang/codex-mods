// codexmods.intelligence, renderer entry: its overview in Settings (GOAL.md goal 16). Every mod that declares model use, with its switch,
// its model, what it used this hour and today against its allowance, and Stop while a call runs; the total under them. Each mod's own
// page in Settings, Mods has the same controls and its allowances (the framework draws that section from the mod's ModelUse). Each act
// is the user's own input, carried to the graph as theirs (`asUser`). Single-file ESM, no imports.

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const act = (ref, op, args, intent) => ctx.graph.invoke(ref, op, args ?? [], ...(intent?.asUser ? [{ asUser: intent.asUser }] : []))
    .then((out) => { if (out?.status !== 'done') ctx.log.warn(`${op} was not done`, { message: out?.message ?? out?.error?.message }); return out; }, () => null);

  function useUses() {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      let members = new Map();
      const view = ctx.graph.subscribe({ type: 'ModelUse' }, (m) => {
        if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
        else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
          if (m.event.kind === 'removed') members.delete(m.event.ref.id); else if (m.event.instance) members.set(m.event.ref.id, m.event.instance);
        } else return;
        setItems([...members.values()].sort((a, b) => String(a.state?.name).localeCompare(String(b.state?.name))));
      });
      return () => view.dispose();
    }, []);
    return items;
  }
  const on = (v) => (typeof v === 'boolean' ? v : Boolean(v?.target?.checked));
  // the app's own settings layout: a row per mod, its use and allowance below its name, the app's Switch on the right
  function Row({ use }) {
    const s = use.state ?? {};
    return e(C.SettingsRow, {
      label: s.name,
      description: `${s.why} · ${fmt(s.usedHour)} of ${fmt(s.perHour)} this hour · ${fmt(s.usedDay)} of ${fmt(s.perDay)} today`,
      control: e('span', { 'data-model-use': s.modId, style: { display: 'inline-flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)' } },
        e(C.Badge, { label: s.model }),
        e(C.Switch, { checked: s.enabled === true, ariaLabel: `Model use for ${s.name}`, 'aria-label': `Model use for ${s.name}`, onChange: (...a) => act(use.ref, 'setEnabled', [on(a[0])], a.at(-1)) })),
    });
  }
  function Overview() {
    const uses = useUses();
    if (!uses.length) return e(C.EmptyState, { glyph: 'sparkle', title: 'No mod uses models', description: 'A mod that asks to use models shows here, off until you turn it on.' });
    const total = uses.reduce((n, u) => n + (u.state?.usedDay ?? 0), 0);
    const S = C.SettingsSection;
    return e('div', { 'data-model-uses': String(uses.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 3)' } },
      // a mod's calls under way, each stopped at once by its Stop
      ...uses.filter((u) => u.state?.running > 0).map((u) => e(C.Banner, { key: `run-${u.ref.id}`, tone: 'info', message: `${u.state.name} is using a model now`,
        actions: [{ label: 'Stop', danger: true, onClick: (intent) => act(u.ref, 'stop', [], intent) }] })),
      e(S, null,
        e(S.Header, {
          title: 'Mods that use models',
          subtitle: 'Through your Codex account, each only while you have it on, within the allowance you give it. Set its model, allowances and tools on its page in Mods.',
          actions: e('span', { className: 'text-sm text-secondary', 'data-model-use-total': String(total) }, `${fmt(total)} tokens today in all`),
        }),
        e(S.Content, null, e(C.SettingsCard, null, ...uses.map((u) => e(Row, { key: u.ref.id, use: u }))))));
  }
  const page = ctx.ui.settings.page({ id: 'overview', title: 'Mod intelligence', group: 'personal', render: () => e(Overview) });
  return () => page.dispose();
}

export default { renderer };
