// qa.rules-a, renderer realm — QA only (docs/design/systems.md E2): one rule of each kind the existing bindings take. What each rule does
// is visible in the app (badges with data-codexmods-badge, a menu entry, an action, a banner with data-qa-rules); what ran is logged to
// the page console with the prefix "qa.rules-a".
function renderer(ctx) {
  const h = ctx.ui.react.createElement;
  const log = (m) => console.warn(`qa.rules-a ${m}`);   // warn: the QA probe keeps warnings and errors
  const rules = [
    ctx.ui.decorate('SidebarItem', { id: 'badge', for: 'Thread', badges: (t) => [{ id: 'a', text: 'A', tooltip: `qa.rules-a on ${t.state.title}` }] }),
    ctx.ui.decorate('SidebarItem', { id: 'boom', for: 'Thread', badges: (t) => { if (/Read Calculator/.test(t.state.title ?? '')) throw new Error('qa.rules-a boom'); return []; } }),
    ctx.ui.decorate('SidebarItem', { id: 'label', for: 'Thread', where: { pinned: true }, label: 'pinned (A)' }),
    ctx.ui.decorate('ThreadHeader', { id: 'header', badges: [{ id: 'h', text: 'rules-a' }] }),
    ctx.ui.decorate('Menu', { id: 'menu', actions: [{ id: 'act', title: 'QA rules A action', run: () => log('menu action ran') }] }),
    ctx.ui.decorate('MessageBlock', { id: 'message', for: 'AgentMessage', actions: [{ id: 'act', title: 'QA A', run: () => log('message action ran') }] }),
    ctx.ui.host('ThreadView', { id: 'banner', slot: 'header', render: () => h('div', { 'data-qa-rules': 'banner-a' }, 'QA rules A above the transcript') }),
  ];
  for (const [i, r] of rules.entries()) r.accepted.then((ok) => log(`rule ${i} accepted ${ok}`));
  return () => { for (const r of rules) r.dispose(); };
}

export default { renderer };
