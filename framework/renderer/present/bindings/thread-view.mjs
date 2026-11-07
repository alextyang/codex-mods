// ThreadView (docs/graph/03): the main view of a thread. On 21477 it is the thread page component whose props carry conversationId,
// renderComposer, isTranscriptVisible and usesUnifiedTimeline. It passes through; a mod's region above the transcript goes after the app's
// own (`transcriptHeader`), and while filters of the transcript are on in the window (`ui.filter('transcript', ...)`, public-hooks.md
// §3.12; its records are left out where they are drawn, runtime.mjs) their notice goes there too.
// E7.3: the page is also where its thread's header takes actions (a twin ThreadHeader): each is the app's own title-bar action
// (`AppShell.HeaderAction`, in the bar's thread slot at its end, as the page's own share and overflow actions are), rendered beside the
// page (the page element stays first and unkeyed). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeRegion, siblingList, actionNode, withoutSiblings, statusList, appendNodes } from './slots.mjs';
import { declaredFilters, filterNotice } from './list-filter.mjs';

// Its ThreadHeader's `status` (ui.status for a chat, public-hooks.md §3.14): the mods' statuses of this chat, in the title bar's right slot
// (before the app's panel toggles, whose orders start at 200) while its page is shown.
const STATUS = '__codexmodsStatus';

export const threadView = defineBinding({
  id: 'thread.view', presentation: 'ThreadView',
  place: { in: 'Window', slot: 'main' },
  presents: ['Thread'],
  subject: (props, ctx) => ctx.thread(props.conversationId),
  // `filter`: the mods' transcript filters, read where the records are drawn (runtime.mjs) and for the notice (render)
  slots: { header: nodeRegion('transcriptHeader'), filter: { kind: 'list', field: 'filter', apply: (props) => props } },
  twins: [{ presentation: 'ThreadHeader', subject: (props, ctx) => ctx.thread(props.conversationId),
    slots: {
      actions: siblingList(({ R, ctx }, item, key) => actionNode(R, ctx, item, key), { field: 'actions' }),
      status: statusList((props, nodes) => ({ ...props, [STATUS]: [...(props[STATUS] ?? []), ...nodes] })),
    } }],
  render(Original, props, factory, ctx) {
    const [{ [STATUS]: statuses = [], ...rest }, actions] = withoutSiblings(props);
    const filters = declaredFilters(ctx, 'ThreadView');
    if (!actions.length && !statuses.length && !filters.length) return undefined;
    const R = ctx.react();
    if (!R) return factory(Original, rest);
    const own = filters.length ? { ...rest, transcriptHeader: appendNodes(R, rest.transcriptHeader, [filterNotice(R, ctx, 'ThreadView', filters)]) } : rest;
    const page = factory(Original, own);
    if (!actions.length && !statuses.length) return page;
    const HeaderAction = ctx.exports?.()?.appShell?.HeaderAction;
    if (!HeaderAction) return page;   // a build without the app's title-bar actions: none shown
    return R.createElement(R.Fragment, null, page, ...actions.map((node, i) => R.createElement(HeaderAction, {
      key: `header:${node.key}`, actionId: String(node.key), align: 'end', slotPosition: 'thread', order: 500 + i, children: node,
    })), ...statuses.map((node, i) => R.createElement(HeaderAction, {
      key: `status:${node.key}`, actionId: String(node.key), align: 'end', slotPosition: 'right', desktopPlacement: 'titlebar', order: 150 + i, children: node,
    })));
  },
});
