// ThreadHeader (docs/graph/03): the thread's title in the window's titlebar. On 21477 the chat titlebar reads its thread from the
// route (RouteScope), not from props, and shows the project, the title (the component whose props carry title, titleActivator and
// variant) and the environment side by side. Mods' badges sit beside the title; a mod's summary says the title. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { siblingList, withoutSiblings, badgeNode, summarySlot } from './slots.mjs';

export const threadHeader = defineBinding({
  id: 'thread.header', presentation: 'ThreadHeader',
  place: { in: 'ThreadView', slot: 'header' },
  presents: ['Thread'],
  // Its thread is the route's (the title's props carry none): the address reads RouteScope.
  subject: (props, ctx, route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? ctx.thread(route.conversationId) : null),
  // A mod's badges sit beside the title. Its title as a mod's summary says it (public-hooks.md §3.13): the title the header shows.
  slots: { badges: siblingList(({ R, ctx }, item, key) => badgeNode(R, ctx, item, key), { field: 'badges' }),
    summary: summarySlot((p, s) => (s.title ? { ...p, title: s.title } : p)) },
  render(Original, props, factory, ctx) {
    // Always the same shape (the title, then the badges), so the title element is never remounted when its thread changes.
    const R = ctx.react();
    if (!R) return undefined;
    const [own, badges] = withoutSiblings(props);
    return R.createElement(R.Fragment, null, factory(Original, own), ...badges);
  },
});
