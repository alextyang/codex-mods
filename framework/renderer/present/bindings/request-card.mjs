// RequestCard (docs/graph/03): the card a pending request shows above the composer. On 21477 it is the panel whose props carry
// pendingRequest ({type, item}), conversationId and onSubmitLocalFollowup; the item names the request by the id the app was asked with
// (`approvalRequestId`), which the Host resolves to the Request, Codex's or a mod's. It passes through: the app's own card shows both; it
// hands its Request down to the approval shell inside it (E7.7, request-body.mjs), always wrapped the same way. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { requestContext } from './request-body.mjs';

/** The Request a pending request's item names (by the id the app was asked with), or null. */
function requestOf(props, ctx) {
  const item = props.pendingRequest && props.pendingRequest.item;
  const id = item && (item.approvalRequestId ?? item.requestId);
  return typeof id === 'string' ? ctx.request(id) : null;
}

export const requestCard = defineBinding({
  id: 'request.card', presentation: 'RequestCard',
  place: { in: 'TurnView', via: 'turn', slot: 'requests' },
  presents: ['Request'],
  subject: requestOf,
  render(Original, props, factory, ctx) {
    const R = ctx.react?.();
    const c = R ? requestContext(R) : null;
    return c ? R.createElement(c.Provider, { value: requestOf(props, ctx) }, factory(Original, props)) : undefined;
  },
});
