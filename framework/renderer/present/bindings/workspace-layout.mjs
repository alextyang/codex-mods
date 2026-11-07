// The workspace's layout through the app's guarded setters (layouts.md D6, WL3), for the bindings and the runtime alike. NO NODE API.

/**
 * The workspace's layout (Window.setLayout; layouts.md D6, WL3), over a page's route scope: the chat alone (its panel closed), beside its
 * tabs, or its tab filling the workspace, through the app's own guarded setters (exposure `workspaceLayout`): a tab whose kind does not
 * fill the workspace (`allowFullWidth: false`) is refused before anything moves. The SidePanel's frame and a panel tab offer it (a home
 * page has tabs but no chat), and a view opened split or full sets it in its own page.
 */
export function layoutWorkspace(ctx, node, mode) {
  const ex = ctx.exports?.()?.workspaceLayout;
  if (!['chat', 'split', 'full'].includes(mode)) return { unavailable: 'a layout is chat, split or full' };
  if (!ex || typeof ex.setFull !== 'function' || typeof ex.setPanel !== 'function' || !node) return { unavailable: 'this window\'s layout cannot be set from here' };
  if (mode === 'chat') { ex.setPanel(node, false); return true; }
  if (mode === 'full' && node.get(ex.activeTab)?.tabType?.allowFullWidth === false) return { unavailable: 'the tab it shows does not fill the workspace' };
  ex.setPanel(node, true);
  ex.setFull(node, mode === 'full');
  return true;
}
