// ListItem (docs/design/public-hooks.md §3.13, H7s; scout H7s-decorations): a subject's entry in one of the app's own lists outside the
// sidebar and settings, where a mod's badges sit beside it: a Skill's card on the Skills page, a Branch's row in a branch picker (H7x). (A Model's label in the model picker carries
// neither its host, whose catalog it is from, nor which of the picker's places it is: it waits for a seam that gives both, H7s review
// round 1.) NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { badgeNode } from './slots.mjs';

const keyOf = (e, i) => `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`;

// A Skill's card on the Skills page (21477: its skill, the name it shows, its host and `scopeBadges`, the badges the app draws on the card:
// its repository's): the mods' badges after the app's. A skill of this Mac (codex's Skill ids are their SKILL.md paths).
export const skillCard = defineBinding({
  id: 'skill.card', presentation: 'ListItem', presents: ['Skill'],
  place: { in: 'Window', slot: 'skills' },   // the window's Skills page (each card its own skill)
  subject: (props) => {
    const path = props.skill && typeof props.skill === 'object' ? props.skill.path : null;
    return typeof path === 'string' && path && (props.hostId == null || props.hostId === 'local') ? { type: 'Skill', provider: 'codex', id: path } : null;
  },
  slots: {
    badges: {
      kind: 'list', field: 'badges',
      apply: (props, entries, env) => {
        const nodes = entries.map((e, i) => badgeNode(env.R, env.ctx, e.item, keyOf(e, i)));
        if (!nodes.length || !env.R) return props;
        const own = Array.isArray(props.scopeBadges) ? props.scopeBadges : props.scopeBadges != null ? [props.scopeBadges] : [];
        return { ...props, scopeBadges: [...own, ...nodes] };
      },
    },
  },
});

const localThread = (route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' && route.conversationId ? route.conversationId : null);
const NEW_DRAFT = Object.freeze({ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });
/** The local project a route's branch pickers are about: its chat's, or on the home page the new chat's. */
function projectOf(ctx, route) {
  const id = localThread(route);
  const thread = id ? ctx.thread(id) : null;
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own projects
  const at = thread && thread.provider === 'codex' ? ctx.subject(thread)?.links?.project : route?.routeKind === 'home' ? ctx.subject(NEW_DRAFT)?.state?.target?.project : null;
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own projects
  return at && at.type === 'LocalProject' && at.provider === 'codex' && typeof at.id === 'string' ? at.id : null;
}
// The composer's branch switcher's list (21477: the one picker list given `repositoryName`, and by the pack's identity props the repository
// it lists and its host, `gitRoot` and `hostConfig`): a site, so its rows know their repository (H7x review 1). It draws nothing itself.
export const branchList = defineBinding({ id: 'branch.list', presents: ['Branch'], render: () => undefined });
/** The Branch a row of the switcher's list shows: of the route's project (a chat's, else the new chat's) when the repository the list shows
 *  is that project's own, on this Mac; else none (another repository, a worktree's, a remote host's, a list that names none). */
function branchOf(ctx, route, near, name) {
  const list = near?.binding === 'branch.list' ? near.props : null;
  const root = list && typeof list.gitRoot === 'string' && list.gitRoot ? list.gitRoot : null;
  if (!root || list.hostConfig?.id !== 'local' || typeof name !== 'string' || !name) return null;
  const project = projectOf(ctx, route);
  const at = project ? ctx.subject({ type: 'LocalProject', provider: 'codex', id: project })?.state?.location : null;
  return at && at.replace(/\/+$/, '') === root.replace(/\/+$/, '') ? { type: 'Branch', provider: 'codex', id: `${project}:${name}` } : null;
}
// A branch's row in the composer's branch switcher (21477: `{branch, disabled, onSelect, selected, subText}`, one component for every branch
// picker; `branch` its name): under the switcher's list (its nearest site), a ListItem of the Branch of the repository the list shows, the
// mods' badges under its name, after the app's own line (`subText`).
export const branchRow = defineBinding({
  id: 'branch.row', presentation: 'ListItem', presents: ['Branch'],
  place: { in: 'Window', slot: 'branches' },
  subject: (props, ctx, route, near) => branchOf(ctx, route, near, props.branch),
  slots: {
    badges: {
      kind: 'list', field: 'badges',
      apply: (props, entries, env) => {
        const nodes = entries.map((e, i) => badgeNode(env.R, env.ctx, e.item, keyOf(e, i)));
        if (!nodes.length || !env.R) return props;
        const row = env.R.createElement('span', { className: 'inline-flex flex-wrap items-center gap-1' }, ...nodes);
        return { ...props, subText: props.subText == null ? row : env.R.createElement(env.R.Fragment, null, props.subText, ' ', row) };
      },
    },
  },
});
