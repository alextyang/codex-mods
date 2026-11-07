// The app's settings pages' slots, the automations' view and the composer's context meter (docs/graph/03 SettingsPage, AutomationView,
// StatusItem; systems.md E7.6, from a scout of 21477). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeList, nodeRegion, actionNode, siblingRegion, withoutSiblings, appendNodes, SIBLINGS } from './slots.mjs';
import { createSettingsSections } from '../settings-sections.mjs';
import { themesSection } from '../themes-section.mjs';
import { createAccountsSection } from '../accounts-section.mjs';

const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);
/** The frame's children with the nodes after them (the app's own keep their places). */
const afterChildren = (props, nodes) => {
  const own = props.children;
  return { ...props, children: own == null ? nodes : Array.isArray(own) ? [...own, ...nodes] : [own, ...nodes] };
};

// An app's settings page's frame (by identity: the frame the pack exposes, its props too generic for an address): a twin of the page's
// SettingsPage, named by its title (the settings title component with only the page's slug: the framework's own pages pass a string and
// take nothing). `sections` after the page's own, `rows` in a card of their own after them, `pageActions` in the frame's toolbar.
const pageOf = (props) => {
  const t = props.title;
  const slug = t && typeof t === 'object' && t.props && Object.keys(t.props).length === 1 ? t.props.slug : null;
  return typeof slug === 'string' && slug ? { type: 'SettingsSection', provider: 'codex', id: slug } : null;
};
const sections = new WeakMap();   // the runtime's ctx -> its mods' settings sections (one per window)
/** `section` (ui.settings.section, public-hooks.md §3.14): the mods' sections after the page's own, drawn in the app's SettingsSection. */
const sectionList = {
  kind: 'list',
  apply: (props, entries, env) => {
    if (!entries.length) return props;
    let s = sections.get(env.ctx);
    if (!s) { s = createSettingsSections({ R: env.R, ctx: env.ctx }); sections.set(env.ctx, s); }
    const page = env.inst?.ref?.id ?? null;
    return afterChildren(props, entries.map((x, i) => s.nodeFor(x.rule, x.item, `codexmods:${x.rule.mod}/${x.rule.id}/${x.item?.id ?? i}`, env.node, page)));
  },
};
const accounts = new WeakMap();   // the runtime's ctx -> its Accounts section's component (one per window)
export const settingsFrame = defineBinding({
  id: 'settings.frame', presents: ['SettingsSection'],
  // the mods' Accounts (public-hooks.md §3.15, H7pc): the framework's own section on the Account page, after the page's own (the app lists
  // no other account anywhere); it draws nothing while there is none
  render(Original, props, factory, ctx) {
    if (pageOf(props)?.id !== 'account') return undefined;
    const R = ctx.react?.();
    if (!R) return undefined;
    let A = accounts.get(ctx);
    if (!A) { A = createAccountsSection(R, ctx); accounts.set(ctx, A); }
    return factory(Original, afterChildren(props, [R.createElement(A, { key: 'codexmods-accounts' })]));
  },
  twins: [{ presentation: 'SettingsPage', subject: pageOf, slots: {
    section: sectionList,
    // the mods' themes (ui.theme.add, H7y): the framework's own section on the Appearance page, after the page's own and the mods' sections
    theme: { kind: 'list', apply: (props, entries, env) => { const s = entries.length && env.R ? themesSection(env.R, env.ctx, entries) : null; return s ? afterChildren(props, [s]) : props; } },
    sections: { kind: 'region', apply: (props, nodes) => afterChildren(props, nodes) },
    rows: { kind: 'region', apply: (props, nodes, env) => {
      const Card = env.ctx.exports?.()?.SettingsCard;
      return Card ? afterChildren(props, [env.R.createElement(Card, { key: 'codexmods-rows' }, ...nodes)]) : afterChildren(props, nodes);
    } },
    pageActions: nodeList('toolbarActions', action, { field: 'actions' }),
  } }],
});

// An automation's view (its detail panel: the component whose props carry the automation, its schedule's summary and its actions):
// presents the Automation (its id, the native provider's); `actions` after its menu, `details` after its runs.
export const automationView = defineBinding({
  id: 'automation.view', presentation: 'AutomationView',
  place: { in: 'Window', slot: 'main' },
  presents: ['Automation'],
  subject: (props) => (props.automation && typeof props.automation.id === 'string' && props.automation.id ? { type: 'Automation', provider: 'codex', id: props.automation.id } : null),
  slots: { actions: nodeList('actions', action, { field: 'actions' }), details: nodeRegion('children') },
});

// E8.9 (scout E8-automation-view): on 21477 a local scheduled task is its page (`/scheduled?automationId=<id>`, its prompt, its schedule
// and a summary card that opens the Edit task dialog) and that dialog; the detail panel above is the app's former layout. The summary card
// (the component whose props are exactly its automation's id, source, whether its editor opens first and where it was opened from) is the
// task's AutomationView: its `details` regions and a row of its `actions` (the Codex app's buttons) after the card. A cloud task's card
// presents nothing (another source).
const localTask = (id, source) => (source === 'local' && typeof id === 'string' && id ? { type: 'Automation', provider: 'codex', id } : null);
/** The actions after the card: one row of the app's buttons (in the card's list of siblings, before the regions). */
const actionRow = {
  kind: 'list', field: 'actions',
  apply: (props, entries, env) => {
    if (!entries.length) return props;
    const nodes = entries.map((e, i) => actionNode(env.R, env.ctx, e.item, `codexmods:${e.rule.mod}/${e.rule.id}/${e.item?.id ?? i}`));
    const row = env.R.createElement('div', { key: 'codexmods:automation-actions', 'data-codexmods-automation-actions': '', className: 'flex flex-wrap items-center gap-2 pt-2' }, ...nodes);
    return { ...props, [SIBLINGS]: [row, ...(props[SIBLINGS] ?? [])] };
  },
};
export const automationSummary = defineBinding({
  id: 'automation.summary', presentation: 'AutomationView',
  place: { in: 'Window', slot: 'main' },
  presents: ['Automation'],
  subject: (props) => localTask(props.automationId, props.source),
  slots: { actions: actionRow, details: siblingRegion() },
  render(Original, props, factory, ctx) {
    const [own, after] = withoutSiblings(props);
    const R = ctx.react();
    if (!after.length || !R) return after.length ? factory(Original, own) : undefined;
    return R.createElement(R.Fragment, null, factory(Original, own), ...after);
  },
});
// The local Edit task dialog's frame (its 12 props exactly; its draft is the task, by id): a part of the task's AutomationView. Its
// `actions` go beside the app's Pause/Resume in the footer (its `statusAction`), drawn as that button is; its `details` at the end of the
// form (`advanced`).
const dialogAction = ({ R, ctx }, item, key) => {
  const ex = ctx.exports?.() ?? {};
  const Button = ex.CodexButton ?? ex.Button;
  const label = typeof item.title === 'string' ? item.title : '';
  const p = { key, type: 'button', onClick: typeof item.run === 'function' ? () => item.run() : undefined, 'aria-label': label, 'data-codexmods-action': key };
  return Button ? R.createElement(Button, { ...p, color: 'secondary', radius: 'full', size: 'dialogAction' }, label) : R.createElement('button', p, label);
};
export const automationEdit = defineBinding({
  id: 'automation.edit', presentation: 'AutomationView', part: true,
  place: { in: 'Window', slot: 'main' },
  presents: ['Automation'],
  subject: (props) => localTask(props.draft?.id, props.executionLocation),
  slots: { actions: nodeList('statusAction', dialogAction, { field: 'actions' }), details: nodeRegion('advanced') },
});

// A scheduled task's "..." menu in the Scheduled sidebar section (the app's shared automation menu as that row calls it: its 12 props
// exactly; it names the task only in its Edit and Share items, an element of its own whose props carry the id): the mods' Menu entries
// for an Automation (`ui.contextMenu.add({for: 'Automation'})`), each mod's in a section of its own after the app's items, drawn with the
// menu's own items (MenuParts).
const menuTask = (props) => { const p = props.additionalMenuItems && props.additionalMenuItems.props; return p ? localTask(p.automationId, p.source) : null; };
export const automationMenu = defineBinding({
  id: 'automation.menu', presents: ['Automation'],
  render(Original, props, factory, ctx) {
    const ref = menuTask(props);
    const groups = ref && typeof ctx.subjectMenu === 'function' ? ctx.subjectMenu(ref) : [];
    const P = ctx.exports?.()?.MenuParts;
    const R = ctx.react?.();
    if (!groups.length || !P || typeof P.Item !== 'function' || !R) return undefined;
    const nodes = groups.flatMap((g, i) => [
      ...(P.Separator ? [R.createElement(P.Separator, { key: `codexmods:separator:${i}` })] : []),
      ...g.map((e) => R.createElement(P.Item, { key: e.id, 'data-codexmods-action': e.id, onSelect: () => e.onSelect() }, e.message?.defaultMessage ?? '')),
    ]);
    return factory(Original, { ...props, trailingMenuItems: appendNodes(R, props.trailingMenuItems, nodes) });
  },
});

// The composer's context meter (its one prop is the context's usage): a StatusItem of the chat its composer belongs to (ComposerScope).
const chat = (scope) => (scope && scope.kind === 'local' && scope.placement === 'main' && typeof scope.conversationId === 'string' && scope.conversationId ? scope.conversationId : null);
export const contextMeter = defineBinding({
  id: 'status.context', presentation: 'StatusItem',
  presents: ['Thread'],
  place: (props, scope) => (chat(scope) ? { in: 'Composer', on: { type: 'Draft', provider: 'codex', id: chat(scope) }, slot: 'status' } : { in: null, slot: 'status' }),
  subject: (props, ctx, scope) => (chat(scope) ? ctx.thread(chat(scope)) : null),
});
