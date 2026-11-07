// codexmods.thread-settings, renderer entry (GOAL.md goal 18). Single-file ESM, no imports.
//
// A chat's settings in one tab of the side panel: everything in the chat's `settings` relation, grouped by what defines each one. Codex's
// own settings of the chat come first, then each mod's chat-scope settings, then each skill's switch and parameters (put by this mod's
// host entry). Each row is the framework's SettingRow, so it reads, sets, resets and explains a setting as the Mods pages do; another
// mod's setting is set as the user (the row carries the user's own click), never by this mod alone. A chat's header has an action that
// opens the tab, and so does a command.

const RANK = { Agent: 0, Mod: 1, Skill: 2 };
const kindOf = (ref) => (/Agent$/.test(ref?.type ?? '') ? 'Agent' : ref?.type === 'Mod' ? 'Mod' : ref?.type === 'Skill' ? 'Skill' : 'Other');
const keyOf = (ref) => (ref ? `${ref.provider}:${ref.type}:${ref.id}` : 'none');

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
        if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [keyOf(x.ref), x]));
        else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
          if (m.event.kind === 'removed') members.delete(keyOf(m.event.ref));
          else if (m.event.instance) members.set(keyOf(m.event.ref), m.event.instance);
        } else return;
        setItems([...members.values()]);
      });
      return () => view.dispose();
    }, [ref ? keyOf(ref) : null, relation]);
    return items;
  }

  /** What defines each group, by its ref: its name as the graph summarizes it (a mod's name, a skill's name, the agent's name). */
  function useTitles(refs) {
    const [titles, setTitles] = R.useState({});
    const wanted = refs.map(keyOf).join('|');
    R.useEffect(() => {
      let live = true;
      Promise.all(refs.map(async (r) => {
        try { const x = await ctx.graph.resolve(r); return [keyOf(r), x?.state?.name ?? x?.state?.title ?? null]; } catch { return [keyOf(r), null]; }
      })).then((pairs) => { if (live) setTitles(Object.fromEntries(pairs.filter(([, t]) => typeof t === 'string'))); });
      return () => { live = false; };
    }, [wanted]);
    return titles;
  }

  /** The chat's settings in groups, by what defines them: the agent first, then mods, then skills, each by name. */
  function groupsOf(settings, titles) {
    const groups = new Map();
    for (const s of settings) {
      if (s.state?.active === false) continue;
      const by = s.links?.definedBy ?? null;
      const kind = kindOf(by);
      const k = kind === 'Skill' ? 'skills' : keyOf(by);   // every skill in one group, each skill's rows together
      if (!groups.has(k)) groups.set(k, { key: k, by: kind === 'Skill' ? null : by, kind, items: [] });
      groups.get(k).items.push(s);
    }
    const name = (g) => (g.kind === 'Skill' ? 'Skills' : titles[g.key] ?? (g.kind === 'Mod' ? g.by?.id : 'Other settings'));
    return [...groups.values()].map((g) => ({ ...g, title: name(g) }))
      .sort((a, b) => (RANK[a.kind] ?? 3) - (RANK[b.kind] ?? 3) || String(a.title).localeCompare(String(b.title)));
  }

  /** The skills group's rows: each skill's switch (by its name), then, while it is on for this chat, its parameters under it. */
  function skillRows(items) {
    const bySkill = new Map();
    for (const s of items) { const k = keyOf(s.links?.definedBy); if (!bySkill.has(k)) bySkill.set(k, []); bySkill.get(k).push(s); }
    const skills = [...bySkill.values()].map((rows) => ({ toggle: rows.find((s) => s.state?.key === 'enabled') ?? null, params: rows.filter((s) => s.state?.key !== 'enabled') }))
      .sort((a, b) => String(a.toggle?.state?.title ?? '').localeCompare(String(b.toggle?.state?.title ?? '')));
    const out = [];
    for (const x of skills) {
      if (x.toggle) out.push(e(C.SettingRow, { key: keyOf(x.toggle.ref), setting: x.toggle }));
      if (x.toggle?.state?.value === false || !x.params.length) continue;
      out.push(e('div', { key: `${keyOf(x.toggle?.ref)}-params`, 'data-skill-params': x.toggle?.state?.title ?? '', style: { display: 'flex', flexDirection: 'column', paddingInlineStart: 'calc(var(--spacing) * 4)' } },
        ...x.params.map((s) => e(C.SettingRow, { key: keyOf(s.ref), setting: s }))));
    }
    return out;
  }

  function Group({ group }) {
    const skills = group.kind === 'Skill';
    return e('section', { 'data-chat-settings-group': group.kind, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 1)' } },
      e('div', { className: 'text-sm font-medium', style: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)', padding: '0 calc(var(--spacing) * 1)' } },
        e('span', null, group.title),
        group.kind === 'Mod' ? e(C.Badge, { label: 'Mod', tone: 'neutral' }) : null),
      skills ? e('div', { className: 'text-xs', style: { color: 'var(--color-text-secondary)', padding: '0 calc(var(--spacing) * 1)' } },
        'Turned off, a skill is not used in this chat unless you name it. Its settings go with each message you send.') : null,
      ...(skills ? skillRows(group.items) : group.items.map((s) => e(C.SettingRow, { key: keyOf(s.ref), setting: s }))));
  }

  function Panel({ thread }) {
    const settings = useRelated(thread, 'settings');
    const owners = [];
    const seen = new Set();
    for (const s of settings) { const by = s.links?.definedBy; if (by && !seen.has(keyOf(by))) { seen.add(keyOf(by)); owners.push(by); } }
    const titles = useTitles(owners);
    const [filter, setFilter] = R.useState('');
    if (!thread) return e(C.EmptyState, { glyph: 'gear', title: 'No chat here', description: 'Open a chat to see its settings.' });
    const q = filter.trim().toLowerCase();
    const groups = groupsOf(settings, titles)
      .map((g) => (q && !String(g.title).toLowerCase().includes(q) ? { ...g, items: g.items.filter((s) => String(s.state?.title ?? '').toLowerCase().includes(q)) } : g))
      .filter((g) => g.items.length > 0);
    return e('div', { 'data-chat-settings': thread.id, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 4)', padding: 'calc(var(--spacing) * 3)' } },
      settings.length > 8 ? e(C.SearchField, { value: filter, onChange: setFilter, placeholder: 'Find a setting', ariaLabel: 'Find a setting' }) : null,
      groups.length
        ? groups.map((g) => e(Group, { key: g.key, group: g }))
        : e(C.EmptyState, { glyph: 'gear', title: q ? 'No setting matches' : 'This chat has no settings', description: q ? 'Try another word.' : 'Settings that mods and skills give a chat show here.' }));
  }

  const panel = ctx.ui.panel({ id: 'chat', title: 'Chat settings', icon: 'gear', render: ({ thread }) => e(Panel, { thread }) });
  const open = () => { panel.open({ focus: true }); };
  const header = ctx.ui.decorate('Thread', { id: 'open', in: 'ThreadHeader', actions: [{ id: 'open', title: 'Chat settings', run: open }] });
  const command = ctx.ui.commands.add({ id: 'open', title: 'Chat settings', description: 'This chat\'s settings: Codex\'s, mods\' and skills\'', when: { 'current.type': 'CodexThread' }, run: open });
  return () => { command.dispose(); header.dispose(); panel.dispose(); };
}

export default { renderer };
