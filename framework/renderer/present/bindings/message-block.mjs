// MessageBlock (docs/graph/03): a message in the transcript. On 21477 the user's message and the agent's are two components: the user
// message (props item, alwaysShowUserMessageActions, emptyUserMessageOverride, onEditMessage) and the agent's message (item,
// assistantCopyText, showActionRow, trailingActions). Their item has no id; `item.searchItemId` is the message's protocol id (an id within
// its thread). They pass through.
// E7.2: the user's message takes decorations in its header (`userMessageHeader`, above the bubble; the app leaves it empty). The agent's
// final answer (the call that carries its turn's id) is also where its turn's slots are (a twin, TurnView): its action row's end
// (`trailingActions`) is the turn's `actions`, and what follows the answer (`after`, where the app puts the turn's images, resources and
// diff summary) is the turn's `afterAnswer`. A mod's badges (public-hooks.md §3.13) join the agent's message's actions and its turn's, in
// that row, after the actions. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { elementList, nodeList, nodeRegion, actionNode, badgeNode } from './slots.mjs';

const subjectOf = (type) => (props, ctx) => {
  const item = props.item;
  if (!item || item.type !== type || typeof item.searchItemId !== 'string' || typeof props.conversationId !== 'string') return null;
  return ctx.protocol(item.searchItemId, (id) => ({ type: 'Message', provider: 'codex', id: `${props.conversationId}:${id}` }));
};

// A mod's actions join the message's own (the agent's: an element list; the user's: one node).
const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);
const badge = ({ R, ctx }, item, key) => badgeNode(R, ctx, item, key);
const PLACE = { in: 'TurnView', via: 'turn', slot: 'messages' };
export const userMessage = defineBinding({
  id: 'message.user', presentation: 'MessageBlock', presents: ['Message'], subject: subjectOf('user-message'),
  place: PLACE,
  appParts: { edit: (p) => ({ ...p, onEditMessage: undefined }) },   // public-hooks.md §3.10
  slots: {
    actions: nodeList('additionalUserMessageActions', action, { field: 'actions' }),
    decorations: nodeList('userMessageHeader', badge, { field: 'badges' }),
  },
});
export const agentMessage = defineBinding({
  id: 'message.agent', presentation: 'MessageBlock', presents: ['Message'], subject: subjectOf('assistant-message'),
  place: PLACE,
  appParts: { copy: (p) => ({ ...p, assistantCopyText: undefined }), fork: (p) => ({ ...p, onFork: undefined, onForkTurn: undefined }) },   // public-hooks.md §3.10
  slots: { actions: elementList('additionalActions', action, { field: 'actions', budget: 6 }), badges: elementList('additionalActions', badge, { field: 'badges', budget: 4 }) },
  twins: [{
    presentation: 'TurnView',
    // Only the final answer's call carries its turn's id (the others carry `sourceTurnId`, or none).
    subject: (props, ctx) => ctx.protocol(props.turnId, (id) => ({ type: 'Turn', provider: 'codex', id })),
    slots: { actions: nodeList('trailingActions', action, { field: 'actions' }), badges: nodeList('trailingActions', badge, { field: 'badges' }), afterAnswer: nodeRegion('after') },
  }],
});
