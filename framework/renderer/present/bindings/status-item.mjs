// StatusItem (docs/graph/03): a small indicator with details. On 21477 the composer's context meter carries no chat; its details, the
// /status panel, do: `sessionId` is the chat's id (with its context usage and the account's rate limits). It names the Thread. It passes
// through. NO NODE API.
import { defineBinding } from '../runtime.mjs';

export const statusItem = defineBinding({
  id: 'status.item', presentation: 'StatusItem',
  place: { in: null, slot: 'status' },   // in the composer, which is not presented yet
  presents: ['Thread'],
  subject: (props, ctx) => (typeof props.sessionId === 'string' && props.sessionId ? ctx.thread(props.sessionId) : null),
});
