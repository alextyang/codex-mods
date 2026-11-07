// SidebarItem (docs/graph/03): the thread row of the app's sidebar. On 21477 the row that decides its actions is the component whose
// props carry conversationId, canPin, showPinActionOnHover and preferClickActions; it builds the row's menu and hands titleSuffix and
// the indicator nodes on to the row it renders. Its rows are the app's own chats; a chat the app does not hold has a row the framework
// draws (bindings/sidebar-sections.mjs). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { dataList, nodeList, badgeNode, labelNode } from './slots.mjs';

export const sidebarItem = defineBinding({
  id: 'sidebar.item', presentation: 'SidebarItem',
  // the row's pin on hover (public-hooks.md §3.10): hidden, the row keeps its resting indicator
  appParts: { pin: (p) => ({ ...p, canPin: false, showPinActionOnHover: false, indicatorHoverNode: p.indicatorRestNode }) },
  // A pinned row is in the pinned section, which presents no instance; any other is in its project's section.
  place: (props) => (props.isPinned === true ? { in: null, slot: 'items' } : { in: 'SidebarSection', via: 'project', slot: 'items' }),
  selected: (props) => (typeof props.isActive === 'boolean' ? props.isActive : undefined),
  presents: ['Thread'],
  subject: (props, ctx) => ctx.thread(props.conversationId),
  // A mod's badges join the row's icon badges (data whose icon is an element: the app drops one that is not), at most four in all;
  // its labels go after the title.
  slots: {
    badges: dataList('extraIconBadges', ({ rule, item }, i, { R, ctx }) => {
      const id = `codexmods:${rule.mod}/${rule.id}/${item?.id ?? i}`;
      return {
        id, icon: badgeNode(R, ctx, item ?? {}, id), ariaLabel: item?.tooltip ?? item?.text ?? rule.id,
        ...(typeof item?.tooltip === 'string' ? { tooltipContent: item.tooltip } : {}), ...(typeof item?.run === 'function' ? { onClick: () => item.run() } : {}),
      };
    }, { field: 'badges', budget: 4 }),
    label: nodeList('titleSuffix', ({ R, ctx }, item, key) => labelNode(R, ctx, item, key), { field: 'label' }),
  },
});
