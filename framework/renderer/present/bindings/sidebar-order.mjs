// The sidebar's order (ui.sidebar.order, docs/design/public-hooks.md §3.14): the mods' declared orders of the sidebar's lists, add rules on
// Sidebar `order` that no instance holds (read like the filter: `ctx.declared`). A list takes the first that names it (in rule order):
// `in` omitted names every list of chats (pinned, chats, a custom section's, each project's group); 'pinned', 'chats', 'projects' (the
// project groups themselves), 'project' (every project's group) or a Project's ref (its group) name one. `by` is a path on the listed
// instances (`-path` descending), as its mod may read them, or (renderer realm) the mod's own `(a, b) => number`; an entry whose value is
// not known sorts after the others, and equal ones keep the app's order. The user's arrangement wins (layouts.md D9): a declared order
// applies only to a list the user has not arranged by hand (`arranged`). NO NODE API.
import { readPath } from '../../../shared/where.mjs';
import { seenBy } from '../rules.mjs';

const CHAT_LISTS = new Set(['pinned', 'chats', 'custom', 'project']);

/** Does a declared order's `in` name this list (`{name, project?}`)? A project's ref names its group by provider and id. */
function names(where, list) {
  if (where === undefined || where === null) return CHAT_LISTS.has(list.name);
  if (typeof where === 'string') return where === list.name;
  return list.name === 'project' && !!list.project && where.provider === list.project.provider && where.id === list.project.id;
}
const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
function compareValues(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a - b;
  if (ra === 1) return a.localeCompare(b);
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}

/**
 * Has the user arranged this list by hand (layouts.md D9; scout docs/research/layouts/wl2-d9-orders.md)? The app's own state says it
 * (exposure `sidebarOrderState`, watched): the chats and a project's chats while the user's sort is "Manual order", the pinned chats while
 * theirs is manual (the app's default), the project groups once the user dragged one of those listed, a custom section always (its order
 * is where the user put each chat). A build without that state: the chats by their props (the app gives them `onOrderChange` only in
 * "Manual order", though its unread view leaves it out too), the rest as arranged. What cannot be told counts as arranged: the app's
 * order stands.
 */
function arranged(ctx, list, keys) {
  if (list.name === 'custom') return true;
  const ex = ctx.exports?.()?.sidebarOrderState;
  const node = ctx.anyScopeNode?.();
  if (!ex || !node) return list.name === 'chats' && typeof list.hand === 'boolean' ? list.hand : true;
  watchState(ctx, ex, node);
  try {
    if (list.name === 'chats') return node.get(ex.prefs)?.chatSortMode !== 'updated_at';
    if (list.name === 'project') return node.get(ex.prefs)?.projectSortMode !== 'updated_at';
    if (list.name === 'pinned') return node.get(ex.pinnedSortMode) !== 'updated_at';
    const order = node.get(ex.projectOrder);
    return !Array.isArray(order) || !Array.isArray(keys) || keys.some((k) => order.includes(k));
  } catch { return true; }
}

const STATE_KEY = 'local:sidebar.order.state';
const watched = new WeakMap();   // a scope node -> its watch of the app's sidebar state
/** The lists that read the app's sidebar state render again when it changes (the user picks a sort, drags a group): their props need not. */
function watchState(ctx, ex, node) {
  ctx.local?.read?.(STATE_KEY);
  if (watched.has(node) || typeof node.watch !== 'function') return;
  let first = true;
  try {
    watched.set(node, node.watch((g) => {
      g.get(ex.prefs); g.get(ex.pinnedSortMode); g.get(ex.projectOrder);
      if (first) first = false; else ctx.local?.touch?.(STATE_KEY);
    }));
  } catch { watched.set(node, null); }
}

/**
 * The comparator for one list of the window's sidebar, over instances (or null: no declared order names it, or the user arranged it;
 * `keys`: the list's keys, the project groups'). A render that calls it renders again when a declared order comes or goes, or when an
 * instance it read changes.
 */
export function sidebarOrder(ctx, list, keys) {
  if (typeof ctx.declared !== 'function') return null;
  const rule = ctx.declared('Sidebar', 'order').find((r) => names((r.data?.sort ?? r.fns?.sort ?? {}).in, list));
  if (!rule || arranged(ctx, list, keys)) return null;
  return comparatorOf(ctx, rule, rule.fns?.sort?.by ?? rule.data?.sort?.by);
}

/** A comparator over instances for a rule's `by`: a path (`-path` descending, as its mod may read) or its comparator; null for neither. */
export function comparatorOf(ctx, rule, by) {
  if (typeof by === 'function') {
    const fn = typeof ctx.guard === 'function' ? ctx.guard(rule, by) : by;
    return (a, b) => { const r = Number(fn(seenBy(a, rule.mod), seenBy(b, rule.mod))); return Number.isFinite(r) ? r : 0; };
  }
  if (typeof by !== 'string' || !by) return null;
  const desc = by.startsWith('-');
  const path = desc ? by.slice(1) : by;
  const env = typeof ctx.whereEnv === 'function' ? ctx.whereEnv(rule) : {};
  const valueOf = (x) => {
    if (!x || (typeof env.may === 'function' && !env.may(x))) return undefined;
    const v = readPath(x, path, env);
    return v === null || (typeof v === 'object') ? undefined : v;
  };
  return (a, b) => {
    const va = valueOf(a), vb = valueOf(b);
    if (va === undefined || vb === undefined) return va === undefined ? (vb === undefined ? 0 : 1) : -1;   // the unknown last, either way
    const c = compareValues(va, vb);
    return desc ? -c : c;
  };
}

/** `keys` in the declared order: each key's instance from `instanceOf(key)` (null: not known, after the others); stable. */
export function sortKeys(keys, instanceOf, compare) {
  const known = keys.map((key, i) => ({ key, i, inst: instanceOf(key) }));
  known.sort((x, y) => {
    if (!x.inst || !y.inst) return (x.inst ? 0 : 1) - (y.inst ? 0 : 1) || x.i - y.i;
    return compare(x.inst, y.inst) || x.i - y.i;
  });
  return known.map((x) => x.key);
}

/** The list a keyed sidebar list is, by the container the app gives it (21477: `threadContainerId`); the chats say whether they take the
 *  user's drags (the app gives them `onOrderChange` only in "Manual order"). */
export function listOf(props) {
  const c = props.threadContainerId;
  if (c === 'pinned' || c === 'projects') return { name: c };
  if (typeof c === 'string' && c.startsWith('custom:')) return { name: 'custom' };
  return { name: 'chats', hand: typeof props.onOrderChange === 'function' };
}
