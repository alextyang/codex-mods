// NewThreadView (docs/graph/03): where you start a new chat; it presents the new chat's Draft (E8.3, mod-surfaces.md §3.6), whose target
// names the project the chat starts in (the app's selected project; none: a project-less chat). On 21477 the home page's heading ("What
// should we build in repo?") is its anchor: one draft, `new-conversation`, whatever the project (the app keeps one new-chat text, and the
// new chat's run location per project). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeRegion, actionNode, appendNodes } from './slots.mjs';

export const NEW_DRAFT = Object.freeze({ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });

export const newThreadView = defineBinding({
  id: 'new.thread', presentation: 'NewThreadView',
  place: { in: 'Window', slot: 'main' },
  presents: ['Draft'],
  subject: (props) => (Array.isArray(props.resolvedProjects) ? NEW_DRAFT : null),
});

// Its `aboveComposer` slot (E8.9): the home page hands its composer the content it shows right above the composer card
// (`aboveComposerContent`: the app's own announcements, the git checkout warning); the mods' regions go after the app's. The composer's
// wrapper and the composer take the same props (one spreads them into the other): the slot is applied once. A part of the page's
// NewThreadView (the heading presents it). The same page also draws a chat that is starting (and another agent's chat), whose composer
// is not the new chat's: the address reads RouteScope, and only the home route's composer presents the new chat (the slot applies only
// there). The hotkey window's home draws no such content. Its `starters` (ui.newThread.starter, public-hooks.md §3.14): the mods'
// starting points, a row of the app's buttons after the regions, each starting its chat (its run, in the mod's realm).
const above = nodeRegion('aboveComposerContent');
export const newThreadComposer = defineBinding({
  id: 'new.thread.composer', presentation: 'NewThreadView', part: true,
  place: { in: 'Window', slot: 'main' },
  presents: ['Draft'],
  subject: (props, ctx, route) => (route && route.routeKind === 'home' ? NEW_DRAFT : null),
  slots: { aboveComposer: { kind: 'region', apply: (props, nodes, env) => (env.inst ? above.apply(props, nodes, env) : props) },
    starters: { kind: 'list', field: 'items', apply: (props) => props } },
  render(Original, props, factory, ctx, route) {
    if (!route || route.routeKind !== 'home' || typeof ctx.declared !== 'function') return undefined;
    const starters = ctx.declared('NewThreadView', 'starters');
    const R = ctx.react();
    if (!starters.length || !R) return undefined;
    // the run's env: this window and the new chat's project as the framework reads it (none: a chat of no project), so the starter starts
    // there whatever its mod may read; a fresh frozen env for each run (no mod's code can change what another's run is given), and none
    // until the Draft is here (an unknown project is never taken for none)
    const draft = ctx.subject(NEW_DRAFT);
    const known = !!draft && !draft.gone && !!draft.state;
    const ref = (r) => (r && typeof r === 'object' && typeof r.id === 'string' ? Object.freeze({ type: r.type, provider: r.provider, id: r.id }) : null);
    const envOf = () => Object.freeze({ draft: ref(NEW_DRAFT), window: ref(ctx.windowRef?.()), project: ref(draft?.state?.target?.project) });
    const buttons = starters.flatMap((rule) => {
      const s = rule.data?.starter;
      const run = (rule.fns?.items ?? rule.data?.items)?.[0]?.run;
      // a starter offered here (its declaration says where: the palette and the project menus have their own entries)
      if (!s || typeof s.title !== 'string' || !Array.isArray(s.in) || !s.in.includes('newThread') || typeof run !== 'function') return [];
      return [actionNode(R, ctx, { title: s.title, ...(typeof s.tooltip === 'string' ? { tooltip: s.tooltip } : {}), ...(s.icon !== undefined ? { icon: s.icon } : {}),
        ...(known ? {} : { disabled: true }), run: () => ctx.guard(rule, run)(envOf()) }, `codexmods:starter:${rule.mod}/${rule.id}`)];
    });
    if (!buttons.length) return undefined;
    const row = R.createElement('div', { key: 'codexmods:starters', 'data-codexmods': 'starters', className: 'flex flex-wrap items-center gap-2' }, ...buttons);
    return factory(Original, { ...props, aboveComposerContent: appendNodes(R, props.aboveComposerContent, [row]) });
  },
});
