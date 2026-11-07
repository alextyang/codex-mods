// RequestCard's body (docs/graph/03; E7.7, a scout of 21477). On 21477 the approval family
// (commands, edits, network, permissions, tool and computer-use approvals) ends in one shell component whose props carry title,
// headerContent and actions, with `body`, a node between its header and its buttons; the shell names no request, so the card's binding
// (`request.card`, on the panel that holds the pending request) hands its Request down in a React context of the framework's, and this
// binding reads it and adds the RequestCard rules' `body` regions after the app's own (ctx.ruled, as for the framework's own views).
// `actions` (E8.9; scout E8-frame-slots §4): the shell builds its button row from a config object (its leading action, Deny, Approve), so
// the mods' actions (and regions hosted in `actions`) go in through the card's surface (`request.surface`): the row is the last child the
// shell hands it, a form, which gets the mods' buttons (the app's own outline buttons, the card's size) after the leading action and before
// Deny and Approve, which the row pushes to its end. The user's own answer on the card (its buttons and its keys call the same actions) is
// held before the app sends it (public-hooks.md §3.5): it passes the mods' interceptors and policies as the user's; one that refuses it
// keeps the card, with the reason under its body. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { appendNodes } from './slots.mjs';

const contexts = new WeakMap();   // React -> the context the card's Request is handed down in
/** The context of the card's Request for this React (one per React, created on first use). */
export function requestContext(R) {
  let c = contexts.get(R);
  if (!c && typeof R.createContext === 'function') { c = R.createContext(null); contexts.set(R, c); }
  return c ?? null;
}

export const requestShell = defineBinding({
  id: 'request.shell',
  presents: ['Request'],
  render(Original, props, factory, ctx) {
    const R = ctx.react?.();
    const c = R ? requestContext(R) : null;
    if (!c || typeof R.useContext !== 'function') return undefined;
    const ref = R.useContext(c);   // always read (the same hooks on every render)
    if (!ref || typeof ctx.ruled !== 'function') return undefined;
    const inst = ctx.subject(ref);
    const ruled = ctx.ruled('RequestCard', inst && !inst.gone ? inst : null);
    const body = [...(ruled?.regions?.body ?? []), ...refusalNote(R, ctx, ref)];
    // the card's optional answers (public-hooks.md §3.10): "for this chat" and "always" may be hidden; Allow once and Deny never are
    const hidden = new Set((ruled?.parts ?? []).filter((r) => r.kind === 'hide').flatMap((r) => r.part ?? []));
    const actions = props.actions && typeof props.actions === 'object' && (hidden.has('allowThread') || hidden.has('allowAlways')) ? { ...props.actions } : null;
    if (actions) {
      if (hidden.has('allowThread')) delete actions.scopedApproveAction;
      if (hidden.has('allowAlways')) delete actions.leadingAction;
    }
    const answers = heldAnswers(ctx, ref, actions ?? props.actions);
    if (!body.length && !actions && !answers) return undefined;
    return factory(Original, { ...props, ...(body.length ? { body: appendNodes(R, props.body, body) } : {}), ...(answers || actions ? { actions: answers ?? actions } : {}) });
  },
});

// request key -> what the card says about the user's last answer, until the next: why it was refused, or who changed it
const notes = new Map();
const changes = new Map();   // request key -> who changed the user's answer that went (said again on its step's row, once the card is gone)
const keyOf = (ref) => `${ref.type}\u001f${ref.provider}\u001f${ref.id}`;
/** Who changed the user's answer to this request in this window ("Changed by QA hooks (Only once)"), or null. */
export const answerChangedBy = (ref) => (ref ? changes.get(keyOf(ref)) ?? null : null);
/** Who changed an action, as the place it happened says it: "QA hooks (Only once)" (each mod by its name, as the page knows it). */
export const changedByText = (ctx, changedBy) => changedBy.map((c) => {
  const mod = typeof ctx.subject === 'function' ? ctx.subject({ type: 'Mod', provider: 'codexmods.framework', id: c.mod }) : null;
  const name = typeof mod?.state?.name === 'string' && mod.state.name ? mod.state.name : c.mod;
  return c.policy ? `${name} (${c.policy})` : name;
}).join(', ');
/**
 * The card's answers, each the user's own action, held as the request's answer with the option that button stands for (graph-integrity
 * G1.6: Allow once, for the chat and always are the approving options of those scopes; Deny the decline); null when the card has none. A
 * mod's change of the answer (a narrower option: the Host refuses a wider) is carried out by the card's own button for that option.
 */
function heldAnswers(ctx, ref, actions) {
  if (!actions || typeof actions !== 'object' || typeof ctx.userAction !== 'function') return null;
  const k = keyOf(ref);
  const say = (h) => {
    const note = h.go === false ? (h.handled ? null : `Not sent: ${h.message ?? 'not allowed'}`) : Array.isArray(h.changedBy) && h.changedBy.length ? `Changed by ${changedByText(ctx, h.changedBy)}` : null;
    if (h.go !== false) { if (note) changes.set(k, note); else changes.delete(k); }
    if (note) notes.set(k, note); else if (!notes.delete(k)) return;
    ctx.local?.touch(`local:request-note:${k}`);
  };
  const options = () => { const inst = typeof ctx.subject === 'function' ? ctx.subject(ref) : null; return Array.isArray(inst?.state?.options) ? inst.state.options : []; };
  const optionOf = (kind, scope) => options().find((o) => o?.kind === kind && (kind !== 'approve' || (o.scope ?? 'once') === scope))
    ?? (kind === 'deny' ? options().find((o) => o?.kind === 'cancel') : null);
  const byScope = { once: actions.onApprove, thread: actions.scopedApproveAction?.onClick, always: actions.leadingAction?.onClick };
  const buttonFor = (id) => { const o = options().find((x) => x?.id === id); return !o ? null : o.kind === 'approve' ? byScope[o.scope ?? 'once'] : actions.onDeny; };
  const held = (kind, scope, fn) => {
    if (typeof fn !== 'function') return fn;
    return (...a) => {
      const o = optionOf(kind, scope);
      if (!o) return fn(...a);   // the request offers no such option: the card's own answer, as the app's
      return ctx.userAction(ref, 'answer', [o.id], () => fn(...a), {
        said: say,
        carry: ([id]) => { const other = buttonFor(id); if (typeof other !== 'function') throw new Error(`this card cannot answer ${id}`); return other(...a); },
      });
    };
  };
  const out = { ...actions };
  if (typeof actions.onApprove === 'function') out.onApprove = held('approve', 'once', actions.onApprove);
  if (typeof actions.onDeny === 'function') out.onDeny = held('deny', null, actions.onDeny);
  if (actions.scopedApproveAction && typeof actions.scopedApproveAction.onClick === 'function') out.scopedApproveAction = { ...actions.scopedApproveAction, onClick: held('approve', 'thread', actions.scopedApproveAction.onClick) };
  if (actions.leadingAction && typeof actions.leadingAction.onClick === 'function') out.leadingAction = { ...actions.leadingAction, onClick: held('approve', 'always', actions.leadingAction.onClick) };
  // its keys' answers, for the window's shortcuts to reach the card where the focus is (graph-integrity G4.4)
  ctx.noteAnswers?.(ref, { approve: out.onApprove, deny: out.onDeny });
  return out;
}
/** What the card says about the user's last answer (refused, and why; changed, and by whom), under its body in the theme's secondary text. */
function refusalNote(R, ctx, ref) {
  const k = keyOf(ref);
  ctx.local?.read(`local:request-note:${k}`);
  const note = notes.get(k);
  if (!note) return [];
  const color = ctx.token?.('textSecondary');
  return [R.createElement('div', { key: 'codexmods-refused', 'data-codexmods-refused': '', ...(color ? { style: { color } } : {}) }, note)];
}

/** The mods' actions on the card as the app's own outline buttons (the card's: CodexButton), then the regions hosted in `actions`. */
function actionNodes(R, ctx, actions, hosted) {
  const ex = ctx.exports?.() ?? {};
  const Button = ex.CodexButton ?? ex.Button;
  const buttons = actions.map((a) => {
    const p = { key: a.key, type: 'button', onClick: () => a.run(), 'data-codexmods-action': a.key };
    return Button ? R.createElement(Button, { ...p, color: 'outline', size: 'composer', className: '@max-md/approval-card:justify-center' }, a.title)
      : R.createElement('button', p, a.title);
  });
  return [...buttons, ...hosted];
}

// The approval card's surface: its children are the header, the body and the button row (a form). The mods' actions join that row.
export const requestSurface = defineBinding({
  id: 'request.surface',
  presents: ['Request'],
  render(Original, props, factory, ctx) {
    const R = ctx.react?.();
    const c = R ? requestContext(R) : null;
    if (!c || typeof R.useContext !== 'function') return undefined;
    const ref = R.useContext(c);   // always read (the same hooks on every render)
    if (!ref || typeof ctx.ruled !== 'function' || !Array.isArray(props.children)) return undefined;
    const kids = props.children;
    const form = kids[kids.length - 1];
    if (!form || typeof form !== 'object' || form.type !== 'form' || !form.props) return undefined;
    const inst = ctx.subject(ref);
    const ruled = ctx.ruled('RequestCard', inst && !inst.gone ? inst : null);
    const mine = actionNodes(R, ctx, ruled?.actions ?? [], ruled?.regions?.actions ?? []);
    if (!mine.length) return undefined;
    // before the form's last child, its Deny/Approve row (21477: [leading action, row]; 22943: [leading action as a menu, as a button,
    // row], one of the two false)
    const own = [].concat(form.props.children);
    return factory(Original, { ...props, children: [...kids.slice(0, -1), R.cloneElement(form, undefined, ...own.slice(0, -1), ...mine, ...own.slice(-1))] });
  },
});
