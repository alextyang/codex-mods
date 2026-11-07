// qa.rules-a, host realm — QA only (docs/design/systems.md E2): a data rule, which the Host sends to every window.
async function host(ctx) {
  const rule = ctx.ui.decorate('SidebarItem', { id: 'host-badge', badges: [{ id: 'h', text: 'H', tooltip: 'qa.rules-a, from the host realm' }] });
  // A style (systems.md S12): the app's accent set to its danger token; qa.rules-b asks for success and loses while this one runs.
  const style = ctx.ui.style({ id: 'accent', variables: { '--codex-base-accent': 'danger' } });
  return () => { rule.dispose(); style.dispose(); };
}

export default { host };
