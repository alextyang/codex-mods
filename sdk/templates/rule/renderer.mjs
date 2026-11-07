// Renderer entry: runs in the app's page. One file, no imports needed.
//
// A presentation rule: it adds to what the app shows, wherever the app shows it. `ui.decorate('Thread', ...)` puts badges on a chat in
// the sidebar and in its header (the places that present a chat); the framework draws them with the app's own badge, in every window,
// and keeps them as the chat changes. `badges` is a function of the chat (its `ref`, `state` and `links`, as this mod may read them), so
// it decides per chat; a host entry could give the same rule as data, with `when` on each badge.

/** The badge for a chat that did not start from the user, by how it started (Thread.origin). */
const ORIGINS = {
  fork: { text: 'Fork', tooltip: 'Forked from another chat' },
  delegation: { text: 'Delegated', tooltip: 'Started by another chat\'s agent' },
  automation: { text: 'Scheduled', tooltip: 'Started by a scheduled task' },
};

/** The badges a chat gets: none for one the user started. */
export function originBadges(thread) {
  const o = ORIGINS[thread?.state?.origin];
  return o ? [{ id: `origin-${thread.state.origin}`, ...o }] : [];
}

function renderer(ctx) {
  const rule = ctx.ui.decorate('Thread', { id: 'origin', badges: originBadges });
  return () => rule.dispose();
}

export default { renderer };
