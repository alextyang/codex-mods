// The app's own steps (docs/design/public-hooks.md §3.15, §3.10; scout H3-steps): the transcript's rows for a command run, a file edit,
// an MCP tool call, reasoning and a delegation are StepBlocks of their graph Steps, so a mod hides, replaces, decorates and names their
// parts as it does a mod's own step. On 21477 each kind has its own component (the props below); each binding names the Step from the
// item the app gives it (its protocol id, in the conversation the row is in: `${conversation}:${item id}`, a file edit's
// `${conversation}:${call id}:${index of its path}`) and draws the parts it owns by its own props. The row most kinds draw with is the
// app's shared activity row (the `activityRow` exposure): its binding (`step.row`, a part of the StepBlock) finds the Step of the kind
// above it (the kind's site: its props, by which the kind recorded the Step) and puts the mods' badges and actions in the row's
// accessory, their regions in its body (with its own chevron when the row has none), and draws the row's chevron and icon as parts.
// A row of a group the app keeps collapsed is not drawn: its decorations show when it is. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { badgeNode, actionNode } from './slots.mjs';
import { answerChangedBy } from './request-body.mjs';

const BODY = '__codexmodsStepBody';
const ACTIONS = '__codexmodsStepActions';
const BADGES = '__codexmodsStepBadges';
const place = { in: 'TurnView', via: 'turn', slot: 'steps' };
/** The Step each kind's mount named, by the props object the kernel also gives the rows below it as their site. */
const stepOfProps = new WeakMap();

/** A Step of the conversation by its protocol item id; `suffix`: a file edit's `:<index>`. */
const stepRef = (ctx, conversation, id, suffix = '') => (typeof conversation === 'string' && conversation && typeof id === 'string' && id
  ? ctx.protocol(id, (pid) => ({ type: 'Step', provider: 'codex', id: `${conversation}:${pid}${suffix}` })) ?? null : null);
const named = (props, ref) => { if (props && typeof props === 'object') stepOfProps.set(props, ref); return ref; };
/** An item's copy without the given fields (an app's own part drawn from its item). */
const without = (item, ...fields) => (item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([k]) => !fields.includes(k))) : item);

// A command run (CommandRun): the command row switch, its 11 props exactly. A command the app split into several rows is one Step on each.
export const stepCommand = defineBinding({
  id: 'step.command', presentation: 'StepBlock', presents: ['Step'], place,
  subject: (props, ctx) => named(props, stepRef(ctx, props.conversationId, props.item?.commandExecutionItemId ?? props.item?.callId)),
  appParts: {
    icon: (p) => ({ ...p, showSummaryIcon: false }),
    details: (p) => ({ ...p, hideRawCommand: true }),
    duration: (p) => ({ ...p, item: without(p.item, 'durationMs', 'startedAtMs') }),
  },
});
// Reasoning (Reasoning): its 5 props exactly; its summary is a markdown site of its own.
export const stepReasoning = defineBinding({
  id: 'step.reasoning', presentation: 'StepBlock', presents: ['Step'], place,
  subject: (props, ctx) => named(props, stepRef(ctx, props.conversationId, props.item?.sourceItemId)),
  appParts: { code: (p) => ({ ...p, hideCodeBlocks: true }) },
});
// An MCP tool call (ToolCall, or ComputerAction for computer use): the item names its own thread; remote work (ChatGPT's) is not ours.
export const stepTool = defineBinding({
  id: 'step.tool', presentation: 'StepBlock', presents: ['Step'], place,
  subject: (props, ctx) => named(props, props.item?.threadId === 'chatgpt' ? null : stepRef(ctx, props.item?.threadId ?? props.conversationId, props.item?.callId)),
  appParts: { app: (p) => ({ ...p, renderMcpApps: false }) },
});
// A delegation to other agents (Delegation): its 3 props exactly, its one item.
export const stepDelegation = defineBinding({
  id: 'step.delegation', presentation: 'StepBlock', presents: ['Step'], place,
  subject: (props, ctx) => named(props, stepRef(ctx, props.conversationId, Array.isArray(props.items) ? props.items[0]?.id : null)),
});
// A file edit's rows: the edit's container (its 6 props exactly; it names no Step, it tells its rows their call), then one row per file
// (its 9 props exactly: FileEdit by the index of its path among the call's changes). Neither carries the conversation: the route's.
export const stepEdits = defineBinding({ id: 'step.edits', presents: ['Step'], subject: () => null });
const routeConversation = (route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null);
export const stepFileEdit = defineBinding({
  id: 'step.fileEdit', presentation: 'StepBlock', presents: ['Step'], place,
  subject(props, ctx, route, near) {
    const item = near && near.binding === 'step.edits' ? near.props?.item : null;
    const i = item && item.changes && typeof item.changes === 'object' ? Object.keys(item.changes).indexOf(props.path) : -1;
    return named(props, i >= 0 ? stepRef(ctx, routeConversation(route), item.callId, `:${i}`) : null);
  },
  appParts: { details: (p) => ({ ...p, showDiffDetails: false }) },
});

const expanded = new Set();   // the rows this page opened for the mods' regions (a row of the app's keeps its own state)
const keyOf = (ref) => `${ref.type}\u001f${ref.provider}\u001f${ref.id}`;
const localKey = (ref) => `local:step-row:${keyOf(ref)}`;
const privateList = (prop, toNode, field) => ({
  kind: 'list', field,
  apply: (props, entries, env) => ({ ...props, [prop]: [...(props[prop] ?? []), ...entries.map((e, i) => toNode(env.R, env.ctx, e.item, `${e.rule.mod}/${e.rule.id}/${e.item?.id ?? i}`))] }),
});
const privateRegion = (prop) => ({ kind: 'region', apply: (props, nodes) => ({ ...props, [prop]: [...(props[prop] ?? []), ...nodes] }) });
/**
 * Who answered the request a step waited on, when a mod did it in the user's place (public-hooks.md §3.6): "Approved by <mod>",
 * "Declined by <mod>" or "Answered by <mod>" (": <rule>" when a policy did), in the framework's words beside the row's own accessory; or
 * who changed the user's own answer in this window (§3.5: "Changed by <mod>"). Null otherwise.
 */
function answeredNote(R, ctx, ref) {
  const step = ref && typeof ctx.subject === 'function' ? ctx.subject(ref) : null;
  const req = step?.links?.request ? ctx.subject(step.links.request) : null;
  const by = req && !req.gone ? req.state?.answeredBy : null;
  const color = ctx.token?.('textSecondary');
  const note = (id, text) => R.createElement('span', { key: 'codexmods-answered', 'data-codexmods-answered': id, ...(color ? { style: { color } } : {}) }, text);
  if (by && by.kind !== 'mod') { const changed = answerChangedBy(req.ref); return changed ? note('changed', changed) : null; }
  if (!by || typeof by.id !== 'string') return null;
  const mod = ctx.subject({ type: 'Mod', provider: 'codexmods.framework', id: by.id });
  const who = typeof mod?.state?.name === 'string' && mod.state.name ? mod.state.name : by.id;
  const d = req.state.outcome?.decision;
  return note(by.id, `${d === 'approved' ? 'Approved' : d === 'denied' ? 'Declined' : 'Answered'} by ${who}${typeof by.rule === 'string' && by.rule ? `: ${by.rule}` : ''}`);
}
/** The Step a row is the row of: the kind above it named one (a group's header, under no kind, has none). */
const rowStep = (near) => (near && near.props && typeof near.props === 'object' ? stepOfProps.get(near.props) ?? null : null);
/** The row's own chevron (the app's disclosure), open or closed as the user would set it (graph-integrity G5.1). */
function setRowOpen(props, open) {
  const d = props && props.disclosure;
  if (!d || typeof d.onToggle !== 'function' || typeof d.expanded !== 'boolean') return { unavailable: 'this step has nothing to show' };
  if (d.expanded !== open) d.onToggle();
  return true;
}

// The shared activity row (by identity): a part of its kind's StepBlock (its rules' slots and parts, never a claim of its own).
export const stepRow = defineBinding({
  id: 'step.row', presentation: 'StepBlock', part: true, presents: ['Step'], place,
  subject: (props, ctx, scope, near) => rowStep(near),
  slots: { body: privateRegion(BODY), actions: privateList(ACTIONS, actionNode, 'actions'), badges: privateList(BADGES, badgeNode, 'badges') },
  // its StepBlock's expansion is the row's own chevron where it has one (G5.1): told, and set as the user's click sets it
  expanded: (props) => (props && props.disclosure && typeof props.disclosure.expanded === 'boolean' ? props.disclosure.expanded : undefined),
  operations: { expand: (props) => setRowOpen(props, true), collapse: (props) => setRowOpen(props, false) },
  appParts: {
    icon: (p) => ({ ...p, icon: null }),
    details: (p) => ({ ...p, disclosure: undefined, body: null }),
  },
  render(Original, props, factory, ctx, scope, near) {
    const { [BODY]: body = [], [ACTIONS]: actions = [], [BADGES]: badges = [], ...own } = props;
    const R = ctx.react?.();
    const note = R ? answeredNote(R, ctx, rowStep(near)) : null;
    if (!body.length && !actions.length && !badges.length && !note) return [BODY, ACTIONS, BADGES].some((k) => k in props) ? factory(Original, own) : undefined;
    if (!R) return factory(Original, own);
    const accessory = badges.length || actions.length || note
      ? R.createElement('span', { key: 'codexmods-accessory', className: 'flex items-center gap-1' }, own.accessory ?? null, ...(note ? [note] : []), ...badges, ...actions) : own.accessory;
    if (!body.length) return factory(Original, { ...own, accessory });
    // the mods' regions: in the row's body while the app's chevron has it open; a row without one gets the page's own
    if (own.disclosure) return factory(Original, { ...own, accessory, body: own.body == null ? null : R.createElement(R.Fragment, null, own.body, ...body) });
    const ref = rowStep(near);
    if (!ref) return factory(Original, { ...own, accessory });
    ctx.local?.read(localKey(ref));
    const open = expanded.has(keyOf(ref));
    const toggle = () => { if (open) expanded.delete(keyOf(ref)); else expanded.add(keyOf(ref)); ctx.local?.touch(localKey(ref)); };
    return factory(Original, { ...own, accessory, disclosure: { expanded: open, onToggle: toggle, accessibleLabel: open ? 'Hide details' : 'Show details' },
      body: open ? R.createElement(R.Fragment, null, own.body ?? null, ...body) : own.body ?? null });
  },
});
