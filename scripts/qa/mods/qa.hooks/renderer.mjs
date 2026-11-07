// qa.hooks, renderer realm — QA only (docs/design/public-hooks.md §5): the renderer realm's ui has every member of the shared rule API, so
// a status declared here shows as the host realm's does: "R-OK" in the window's title bar.
function renderer(ctx) {
  const h = ctx.ui.status({ id: 'qa-renderer', place: 'titleBar', text: 'R-OK', tooltip: 'qa.hooks, renderer realm' });
  h.accepted.then((ok) => console.warn(`qa.hooks renderer status accepted ${ok}`));
  return () => h.dispose();
}

export default { renderer };
