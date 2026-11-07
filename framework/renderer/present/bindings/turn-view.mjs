// TurnView (docs/graph/03): one turn of the transcript. On 21477 it is the turn component whose props carry turnId, turn,
// isMostRecentTurn and messageActions (the turn object itself has no id). It passes through. Folding its steps (E7.1) is the app's own `onSetCollapsed(collapsed)`, as the group's toggle calls it: what the window
// shows only (the app keeps it per turn in memory); a turn without an id has none, and the app may show a turn unfolded anyway (its most
// recent turn, before its answer). NO NODE API.
import { defineBinding } from '../runtime.mjs';

export const turnView = defineBinding({
  id: 'turn.view', presentation: 'TurnView',
  place: { in: 'ThreadView', via: 'thread', slot: 'transcript' },
  presents: ['Turn'],
  subject: (props, ctx) => ctx.protocol(props.turnId, (id) => ({ type: 'Turn', provider: 'codex', id })),
  operations: { collapse: (props) => setCollapsed(props, true), expand: (props) => setCollapsed(props, false) },
  // its steps unfolded, where the app says (its `isCollapsed`; absent while the app decides by itself)
  expanded: (props) => (typeof props.isCollapsed === 'boolean' ? !props.isCollapsed : undefined),
});

function setCollapsed(props, collapsed) {
  if (typeof props.onSetCollapsed !== 'function') return { unavailable: 'this turn\'s steps cannot be folded' };
  props.onSetCollapsed(collapsed);
  return true;
}
