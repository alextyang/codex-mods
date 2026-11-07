// How a mod's rule entries land in an app component's props (docs/design/systems.md "E2 in detail"): small slot builders the bindings
// share. A list slot gets `{rule, item}` entries in order (already within the slot's budget), and, when reorder rules ran, the composed
// order (`[{native: index} | {entry: index}]`: the app's entries with the mods', S7) to lay them out in; a list slot that says how many
// entries the app has (`native`) lets a reorder move them too. A region slot gets elements, each in its mod's boundary. Every slot
// returns NEW props (and new arrays), so the app's compiled caches, which compare by identity, see the change.
// Colors come from the theme's tokens (V9). NO NODE API.

const keyOf = (rule, item, i) => `codexmods:${rule.mod}/${rule.id}/${item && item.id != null ? item.id : i}`;

/** A badge as an element: its text (and icon, an element the mod gave), in the theme's secondary text color, its tooltip as the title. */
export function badgeNode(R, ctx, item, key) {
  const color = ctx.token?.('textSecondary');
  return R.createElement('span', {
    key, 'data-codexmods-badge': key, title: typeof item.tooltip === 'string' ? item.tooltip : undefined, ...(color ? { style: { color } } : {}),
  }, R.isValidElement?.(item.icon) ? item.icon : null, typeof item.text === 'string' ? item.text : null);
}

/** An action as the Codex app's own toolbar button (the CodexButton exposure; the shared design system's Button on a build without it), or
 *  a plain button when the build lacks both. */
export function actionNode(R, ctx, item, key) {
  const ex = ctx.exports?.() ?? {};
  const Button = ex.CodexButton ?? ex.Button;
  const disabled = item.disabled === true;
  const onClick = typeof item.run === 'function' && !disabled ? () => item.run() : undefined;
  const label = typeof item.title === 'string' ? item.title : '';
  // its tooltip, whether it is off or on (a toggle), and a short badge after its label in the theme's secondary text (public-hooks.md §3.14)
  const extra = { ...(typeof item.tooltip === 'string' && item.tooltip ? { title: item.tooltip } : {}), ...(disabled ? { disabled: true } : {}),
    ...(typeof item.pressed === 'boolean' ? { 'aria-pressed': item.pressed } : {}) };
  const badge = typeof item.badge === 'string' || typeof item.badge === 'number' ? String(item.badge) : '';
  const color = badge ? ctx.token?.('textSecondary') : null;
  const kids = badge ? [label, ' ', R.createElement('span', { key: 'badge', 'data-codexmods-badge': '', ...(color ? { style: { color } } : {}) }, badge)] : [label];
  return Button
    ? R.createElement(Button, { key, color: 'ghost', size: 'toolbar', onClick, 'aria-label': label, 'data-codexmods-action': key, ...extra }, ...kids)
    : R.createElement('button', { key, type: 'button', onClick, 'aria-label': label, 'data-codexmods-action': key, ...extra }, ...kids);
}

/** A status's tones and the theme tokens that color them (public-hooks.md §3.14). */
const TONE_TOKENS = Object.freeze({ neutral: 'textSecondary', accent: 'accent', success: 'success', warning: 'warning', danger: 'danger' });
/** A meter as a small ring in the status's own color: `{value, max?}` (max 1 by default); null when it is not a number. */
function meterNode(R, meter) {
  const value = Number(meter?.value), max = meter?.max === undefined ? 1 : Number(meter.max);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  const r = 6, c = 2 * Math.PI * r, f = Math.min(1, Math.max(0, value / max));
  const ring = (extra) => R.createElement('circle', { cx: 8, cy: 8, r, fill: 'none', stroke: 'currentColor', strokeWidth: 2, ...extra });
  return R.createElement('svg', { key: 'meter', width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, className: 'shrink-0' },
    ring({ key: 'track', strokeOpacity: 0.25 }),
    ring({ key: 'fill', strokeDasharray: `${f * c} ${c}`, strokeLinecap: 'round', transform: 'rotate(-90 8 8)' }));
}
/**
 * A status (ui.status) as the app draws one: the app's own toolbar button when it has `run`, else its text in the place's own metrics;
 * its icon (an element the mod gave), its meter and its text, in its tone's theme color, its tooltip as the title. Null when it shows
 * nothing (an empty text and no meter or icon): its place draws no gap.
 */
export function statusNode(R, ctx, item, key) {
  if (!item || typeof item !== 'object') return null;
  const text = typeof item.text === 'string' ? item.text : '';
  const icon = R.isValidElement?.(item.icon) ? item.icon : null;
  const meter = item.meter !== undefined ? meterNode(R, item.meter) : null;
  if (!text && !icon && !meter) return null;
  const color = ctx.token?.(TONE_TOKENS[item.tone] ?? TONE_TOKENS.neutral);
  const tooltip = typeof item.tooltip === 'string' && item.tooltip ? item.tooltip : undefined;
  const parts = [icon, meter, text ? R.createElement('span', { key: 'text', className: 'truncate' }, text) : null];
  const common = { key, title: tooltip, 'data-codexmods-status': key, ...(color ? { style: { color } } : {}) };
  if (typeof item.run === 'function') {
    const ex = ctx.exports?.() ?? {};
    const Button = ex.CodexButton ?? ex.Button;
    const props = { ...common, onClick: () => item.run(), 'aria-label': tooltip ?? text };
    return Button ? R.createElement(Button, { ...props, color: 'ghost', size: 'toolbar' }, ...parts) : R.createElement('button', { ...props, type: 'button' }, ...parts);
  }
  return R.createElement('span', { ...common, role: 'status', className: 'inline-flex min-w-0 items-center gap-1 text-sm' }, ...parts);
}

/** A list slot of statuses (ui.status): each drawn by statusNode (one showing nothing is left out), the nodes placed by `place(props, nodes,
 *  env)`; at most three a place (the title bar and the composer's footer have no room to spare). */
export const statusList = (place, opts = {}) => ({
  kind: 'list', budget: opts.budget ?? 3,
  apply: (props, entries, env) => {
    const nodes = entries.map((e, i) => statusNode(env.R, env.ctx, e.item, keyOf(e.rule, e.item, i))).filter(Boolean);
    return nodes.length ? place(props, nodes, env) : props;
  },
});

/** The app's entries and the mods' mapped ones: the mods' after the app's, or in the composed order a reorder gave. */
const laidOut = (own, entries, order, map) => (Array.isArray(order)
  ? order.map((o) => (o.native !== undefined ? own[o.native] : map(entries[o.entry], o.entry))).filter((x) => x !== undefined)
  : [...own, ...entries.map((e, i) => map(e, i))]);

/** The keys of the elements a node holds (itself, an array's, a fragment's children's). */
function keysIn(R, node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) keysIn(R, n, out); return out; }
  if (node.key != null) out.add(String(node.key));
  if (node.type === R.Fragment) keysIn(R, node.props?.children, out);
  return out;
}
/** The entries not there yet: a slot is applied once, even when the props it gave come back through it (E7.2: a component that passes
 *  its props on to a second mount of itself, or renders them again). Entries are keyed by their mod, rule and item. */
const fresh = (R, existing, nodes) => {
  if (existing == null) return nodes;
  const have = keysIn(R, existing);
  return nodes.filter((n) => !(n && typeof n === 'object' && n.key != null && have.has(String(n.key))));
};
/** A node prop that gets the entries after what it holds (`after`, `transcriptHeader`, a title suffix): a fragment of both. */
export const appendNodes = (R, existing, nodes) => {
  const add = fresh(R, existing, nodes);
  if (!add.length) return existing;
  return existing == null ? (add.length === 1 ? add[0] : R.createElement(R.Fragment, null, ...add)) : R.createElement(R.Fragment, null, existing, ...add);
};

/** A list slot whose app prop is an array of data items: the rules' items are mapped and appended after the app's own. */
export const dataList = (prop, toItem, opts = {}) => ({
  kind: 'list', field: opts.field, budget: opts.budget,
  native: (props) => (Array.isArray(props[prop]) ? props[prop].length : 0),
  apply: (props, entries, env, order) => ({ ...props, [prop]: laidOut(Array.isArray(props[prop]) ? props[prop] : [], entries, order, (e, i) => toItem(e, i, env)) }),
});

/** A list slot whose app prop is an array of elements. */
export const elementList = (prop, toNode, opts = {}) => ({
  kind: 'list', field: opts.field, budget: opts.budget,
  native: (props) => (Array.isArray(props[prop]) ? props[prop].length : 0),
  apply: (props, entries, env, order) => {
    const own = Array.isArray(props[prop]) ? props[prop] : [];
    const have = keysIn(env.R, own);
    const kept = entries.filter((e, i) => !have.has(keyOf(e.rule, e.item, i)));   // applied once (above)
    return { ...props, [prop]: laidOut(own, kept, order && kept.length === entries.length ? order : undefined, (e, i) => toNode(env, e.item, keyOf(e.rule, e.item, i))) };
  },
});

/** A list slot whose app prop is one node (one entry of the app's, when present): the entries' nodes go after it, or in the composed order. */
export const nodeList = (prop, toNode, opts = {}) => ({
  kind: 'list', field: opts.field, budget: opts.budget,
  native: (props) => (props[prop] == null ? 0 : 1),
  apply: (props, entries, env, order) => {
    const nodes = entries.map((e, i) => toNode(env, e.item, keyOf(e.rule, e.item, i)));
    if (!Array.isArray(order)) return { ...props, [prop]: appendNodes(env.R, props[prop], nodes) };
    const all = order.map((o) => (o.native !== undefined ? props[prop] : nodes[o.entry])).filter((x) => x != null);
    return { ...props, [prop]: all.length === 1 ? all[0] : env.R.createElement(env.R.Fragment, null, ...all) };
  },
});

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
/**
 * A subject's summary (public-hooks.md §3.13, decorate's `summary`: `{title?, subtitle?, icon?}` or the title alone; data, live text or a
 * function of the subject): each field the first rule's in order that gives it; `icon` an emoji (the places that draw one draw a
 * character). Null when none gives anything.
 */
export function summaryOf(entries) {
  const out = {};
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  for (const { item } of entries) {
    const s = typeof item === 'string' ? { title: item } : item && typeof item === 'object' ? item : {};
    if (out.title === undefined) { const t = text(s.title, 120); if (t) out.title = t; }
    if (out.subtitle === undefined) { const t = text(s.subtitle, 160); if (t) out.subtitle = t; }
    if (out.icon === undefined) { const t = text(s.icon, 16); if (t && EMOJI.test(t) && [...t].length <= 8) out.icon = t; }
  }
  return Object.keys(out).length ? out : null;
}
/** The summary slot: how a subject reads here, without renaming it, drawn by `apply(props, summary)` (`summaryOf`'s). */
export const summarySlot = (apply) => ({
  kind: 'list', field: 'summary', private: true,   // never reordered: one mod's text is no other's to see
  apply: (props, entries) => { const s = summaryOf(entries); return s ? apply(props, s) : props; },
});

/** A region slot whose app prop is one node: the hosted elements go after it. */
export const nodeRegion = (prop) => ({
  kind: 'region',
  apply: (props, nodes, env) => ({ ...props, [prop]: appendNodes(env.R, props[prop], nodes) }),
});

/** A label: a string, or `{text}`, shown after a separator in the theme's secondary color. */
export function labelNode(R, ctx, item, key) {
  const text = typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '';
  const color = ctx.token?.('textSecondary');
  return R.createElement('span', { key, 'data-codexmods-label': key, ...(color ? { style: { color } } : {}) }, ` · ${text}`);
}

/** A list slot whose app prop is a render function (a row's hover actions, E7.3): its result gets the entries' nodes after it, and the
 *  count prop, when given, how many the app should make room for. */
export const renderedList = (prop, toNode, opts = {}) => ({
  kind: 'list', field: opts.field, budget: opts.budget,
  apply: (props, entries, env) => {
    const own = props[prop];
    if (typeof own !== 'function' || !entries.length) return props;
    const nodes = entries.map((e, i) => toNode(env, e.item, keyOf(e.rule, e.item, i)));
    const out = { ...props, [prop]: (...a) => appendNodes(env.R, own(...a), nodes) };
    if (opts.count) out[opts.count] = (Number(props[opts.count]) || 0) + nodes.length;
    return out;
  },
});
/** A region slot whose app prop is an array of nodes (the sidebar's sections): the hosted elements go after the app's. */
export const arrayRegion = (prop) => ({
  kind: 'region',
  apply: (props, nodes, env) => ({ ...props, [prop]: [...(Array.isArray(props[prop]) ? props[prop] : []), ...fresh(env.R, props[prop], nodes)] }),
});
/** A region slot beside the bound component (rendered by its binding, never passed to the app's). */
export const siblingRegion = () => ({ kind: 'region', apply: (props, nodes) => ({ ...props, [SIBLINGS]: [...(props[SIBLINGS] ?? []), ...nodes] }) });

/** The private prop a binding renders itself from (a sibling beside the app's element); never passed on to the app's component. */
export const SIBLINGS = '__codexmodsSiblings';
export const siblingList = (toNode, opts = {}) => ({
  kind: 'list', field: opts.field, budget: opts.budget,
  apply: (props, entries, env) => ({ ...props, [SIBLINGS]: [...(props[SIBLINGS] ?? []), ...entries.map((e, i) => toNode(env, e.item, keyOf(e.rule, e.item, i)))] }),
});
const besideContexts = new WeakMap();   // React -> the context that says which binding's regions an outer mount renders
/**
 * The bound component with the regions beside it, rendered by its outermost mount only: a component whose props reach a second mount of
 * the same binding inside it (passed on whole) renders them once (E7.5). Always the same shape (a provider, the component first and
 * unkeyed, then the regions), so the component keeps its state whether regions come or go.
 */
export function besideOnce(R, id, factory, Original, props) {
  const [own, after] = withoutSiblings(props);
  let C = besideContexts.get(R);
  if (!C) besideContexts.set(R, (C = R.createContext(null)));
  const outer = typeof R.useContext === 'function' ? R.useContext(C) : null;
  return R.createElement(C.Provider, { value: id }, factory(Original, own), ...(outer === id ? [] : after));
}

/** The props without the private sibling list, and that list. */
export function withoutSiblings(props) {
  if (!props || !(SIBLINGS in props)) return [props, []];
  const { [SIBLINGS]: siblings, ...rest } = props;
  return [rest, siblings ?? []];
}
