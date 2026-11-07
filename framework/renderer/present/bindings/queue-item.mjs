// QueueItem (docs/graph/03): a follow-up waiting to be sent (E7.2). On 21477 the composer's queue renders one row per queued message
// (the component whose props carry messageId, onSendNowMessage, onDeleteMessage and isReorderable); its props say nothing of the chat, so
// the address reads ComposerScope: a chat's main composer's queue names the QueuedMessage `<thread>:<messageId>` (the server queue's
// submission id, as the native provider names it), under that chat's Composer. Editing it is the app's own `onEditMessage(id)` (it puts
// the message back in the composer: what the window shows); sending it now, removing and moving it are the QueuedMessage's own
// operations (the windows provider's routes). It passes through; it is a site, so the row it draws (queue.row) knows its follow-up. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeList, actionNode, badgeNode } from './slots.mjs';

const chatThread = (scope) => (scope && scope.kind === 'local' && scope.placement === 'main' && typeof scope.conversationId === 'string' && scope.conversationId ? scope.conversationId : null);
/** The QueuedMessage a follow-up's row shows: `<thread>:<messageId>` in a Codex chat's main composer. */
function queuedOf(props, ctx, scope) {
  const id = chatThread(scope);
  const thread = id ? ctx.thread(id) : null;
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own queue rows
  return thread && thread.provider === 'codex' && typeof props?.messageId === 'string' && props.messageId
    ? { type: 'QueuedMessage', provider: 'codex', id: `${thread.id}:${props.messageId}` } : null;
}

export const queueItem = defineBinding({
  id: 'queue.item', presentation: 'QueueItem',
  presents: ['QueuedMessage'],
  place: (props, scope) => {
    const id = chatThread(scope);
    return id ? { in: 'Composer', on: { type: 'Draft', provider: 'codex', id }, slot: 'queue' } : { in: null, slot: 'queue' };
  },
  subject: queuedOf,
  operations: {
    edit(props) {
      if (typeof props.onEditMessage !== 'function' || typeof props.messageId !== 'string') return { unavailable: 'this follow-up cannot be edited here' };
      props.onEditMessage(props.messageId);
      return true;
    },
  },
});

// The row a follow-up draws (21477: the composer tray's row, `{className, icon, title, actions}`, a prop set an image markup's row shares,
// which has no follow-up above it): under a follow-up's row (its nearest site, addresses.json), the mods' actions after the app's (send
// now, delete, its menu) and their badges in its secondary text (`meta`) (public-hooks.md §3.13, H7x).
export const queueRow = defineBinding({
  id: 'queue.row', presents: ['QueuedMessage'],
  twins: [{ presentation: 'QueueItem', subject: (props, ctx, scope, near) => (near?.binding === 'queue.item' ? queuedOf(near.props, ctx, scope) : null),
    slots: {
      actions: nodeList('actions', ({ R, ctx }, item, key) => actionNode(R, ctx, item, key), { field: 'actions' }),
      badges: nodeList('meta', ({ R, ctx }, item, key) => badgeNode(R, ctx, item, key), { field: 'badges' }),
    } }],
});
