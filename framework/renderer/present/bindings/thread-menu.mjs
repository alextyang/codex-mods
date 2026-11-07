// Menu (docs/graph/03): a chat's own menu. On 21477 the thread's overflow menu (the "…" of the chat's titlebar, its header, a remote
// chat's page) carries the chat it acts on (`conversationId`) with its folder, title and trigger; it names that thread. It passes
// through. NO NODE API.
import { defineBinding } from '../runtime.mjs';

export const threadMenu = defineBinding({
  id: 'menu.thread', presentation: 'Menu',
  place: { in: 'ThreadHeader', slot: 'menu' },   // the thread's menu, where its header opens it
  presents: ['Thread'],
  subject: (props, ctx) => ctx.thread(props.conversationId),
});
