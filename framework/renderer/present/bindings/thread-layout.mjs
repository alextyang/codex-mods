// ThreadView (docs/graph/03), its transcript's own layout (E7.2). On 21477 each page that shows a transcript renders the shared scroll
// layout (the component whose props carry `scrollToBottomButton`: every call passes it with its children), whose props say nothing of the
// thread: the address reads RouteScope, so it presents the route's local chat only, as a second mount of that chat's ThreadView (its
// twin: the page component presents it too). Its slots: `transcript`, the end of the transcript inside the scroll area
// (`threadEndContent`, which the chat page leaves empty), and `aboveComposer`, above the chat's composer (`footerLeadingContent`, unset
// by the app). It passes through. Scrolling to a turn (E7.2b) is the transcript's own reveal (the registry the transcript fills per chat in
// RouteScope, exposed as `transcriptReveal`): the Host gives the app's turn id (for jumpToLatest, the chat's latest turn's). The reveal
// takes an item and its turn; no item has this id, so it scrolls to the turn (and waits up to a second for the item). Finding text (E8.9)
// is the app's own find bar (its store in RouteScope, exposed as `threadFind`), as its own Cmd+F handler does: the conversation's domain,
// the query, open; the bar then searches the pending query, highlights the matches and selects the first. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeRegion } from './slots.mjs';

const localThread = (route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null);
const NO_ITEM = 'codexmods:turn';

async function reveal(ctx, rec, turnId) {
  const conversationId = localThread(rec?.scope);
  const ex = ctx.exports?.()?.transcriptReveal;
  if (!ex || !rec?.scopeNode || !conversationId) return { unavailable: 'this transcript cannot scroll from here' };
  if (typeof turnId !== 'string' || !turnId) return { unavailable: 'the app does not show this turn' };
  const h = rec.scopeNode.get(ex.atom, conversationId);
  if (!h || typeof h.revealItem !== 'function') return { unavailable: 'the chat\'s transcript is not shown' };
  await h.revealItem({ conversationId, itemId: NO_ITEM, turnKey: turnId });
  return true;
}

export const threadLayout = defineBinding({
  id: 'thread.layout', presentation: 'ThreadView',
  place: { in: 'Window', slot: 'main' },
  presents: ['Thread'],
  subject: (props, ctx, route) => (localThread(route) ? ctx.thread(localThread(route)) : null),
  slots: { transcript: nodeRegion('threadEndContent'), aboveComposer: nodeRegion('footerLeadingContent') },
  operations: {
    scrollTo: (props, [turnId], ctx, rec) => reveal(ctx, rec, turnId),
    jumpToLatest: (props, [turnId], ctx, rec) => reveal(ctx, rec, turnId),
    find(props, [text], ctx, rec) {
      // the app draws its find bar on a window's route, none in a hosted chat: said, not answered done with nothing on screen
      if (rec?.pane) return { unavailable: "a chat in a pane has no find bar: name {pane: 'route'} for the chat the window shows" };
      const f = ctx.exports?.()?.threadFind;
      const scope = rec?.scopeNode;
      if (!f || !scope || typeof scope.set !== 'function' || !localThread(rec.scope)) return { unavailable: 'this transcript cannot find from here' };
      f.setDomain(scope, 'conversation');
      f.setQuery(scope, text);
      f.open(scope);
      return true;
    },
  },
});
