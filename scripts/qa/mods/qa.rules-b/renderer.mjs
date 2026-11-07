// qa.rules-b, renderer realm — QA only (docs/design/systems.md E2): a second mod on the same slot, and the claims (hide, replace).
function renderer(ctx) {
  const h = ctx.ui.react.createElement;
  const rules = [
    ctx.ui.decorate('SidebarItem', { id: 'badge', for: 'Thread', badges: [{ id: 'b', text: 'B', tooltip: 'qa.rules-b' }] }),
    ctx.ui.hide('SidebarItem', { id: 'hide', for: 'Thread', where: { title: 'Reply with worktree' } }),
    ctx.ui.replace('SidebarItem', { id: 'replace', for: 'Thread', where: { title: 'Create qa-d7-pr.txt' },
      render: ({ native }) => h('div', { 'data-qa-rules': 'replaced-b' }, h('span', null, 'B: '), native) }),
    // Refused: not granted for ThreadHeader (only SidebarItem).
    ctx.ui.decorate('ThreadHeader', { id: 'denied', badges: [{ id: 'x', text: 'X' }] }),
    ctx.ui.style({ id: 'accent', variables: { '--codex-base-accent': 'success' } }),   // loses to qa.rules-a's while it runs
    // E7.0: its own badge first in the row's badges, before the app's and qa.rules-a's (reorder sees the composed list).
    ctx.ui.reorder('SidebarItem', { id: 'first', slot: 'badges', for: 'Thread',
      order: (items) => [...items.filter((x) => x && x.tooltip === 'qa.rules-b'), ...items.filter((x) => !(x && x.tooltip === 'qa.rules-b'))] }),
  ];
  for (const [i, r] of rules.entries()) r.accepted.then((ok) => console.log(`qa.rules-b rule ${i} accepted ${ok}`));
  return () => { for (const r of rules) r.dispose(); };
}

export default { renderer };
