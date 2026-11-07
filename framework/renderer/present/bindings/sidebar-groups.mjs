// The app's own groups in the conversations sidebar (docs/design/layouts.md §4.1, D9; scout docs/research/layouts/wl2-groups-footer.md §1):
// `pinned`, `projects` (the app's key `threads`), `chats` (Recents) and `agents`, parts of the Sidebar's `groups` slot.
// - Order (`ui.reorder('Sidebar', {slot: 'groups', order})`): the app's group keys pass the seam `sidebarGroups` before it reads them; the
//   named come first in that order, the others after as they were, and only while the user has placed none of the app's groups (their
//   saved section order names none: exposure `sidebarGroupState`; a custom section of their own alone does not count). What cannot be told
//   counts as placed: the app's order stands.
// - Hide (`ui.hide('Sidebar', {part})`): the groups' sortable container (exposure `SidebarSortable`) leaves a hidden group out, with its
//   drag id, unless it holds a chat that needs the user (the one shown, one working, waiting for the user or failed, or one the graph has
//   not answered for yet: kept whole, as a hidden project's group is); the window's notice says it, with the user's "Show". A list it
//   cannot read is left as it is; the agents' group lists no chats. NO NODE API.

import { applyParts } from '../rules.mjs';
import { protectedChat, openChats, tally, shownMods } from './sidebar-hides.mjs';

/** The app's group key -> its part. */
export const GROUP_PART = Object.freeze({ pinned: 'pinned', threads: 'projects', chats: 'chats', agents: 'agents' });
const partOf = (key) => GROUP_PART[key] ?? null;

/** Has the user placed one of the app's groups (dragged a group: their saved section order names an app's key)? Unreadable: yes. */
export function groupsPlaced(ctx) {
  const ex = ctx.exports?.()?.sidebarGroupState;
  const node = ctx.anyScopeNode?.();
  if (!ex || !node) return true;
  try {
    const order = node.get(ex.sections)?.sectionOrder;
    return !Array.isArray(order) || order.some((k) => typeof k === 'string' && !k.startsWith('custom:'));
  } catch { return true; }
}

/** The group keys in the mods' order (the reorder rules on `groups`), where the user has placed none; else as they are. */
export function orderGroups(ctx, partRules, keys) {
  const reorders = (partRules ?? []).filter((r) => r.kind === 'reorder' && r.slot === 'groups');
  if (!reorders.length || !Array.isArray(keys) || groupsPlaced(ctx)) return keys;
  return applyParts(reorders, 'groups', keys, partOf);
}

/** The chats a group's element lists (the list inside it whose props carry `keys` and `conversationByKey`), or null when none is found. */
function listedChats(R, el, depth = 0) {
  if (!el || depth > 12) return null;
  if (Array.isArray(el)) { for (const x of el) { const r = listedChats(R, x, depth + 1); if (r) return r; } return null; }
  if (!R.isValidElement(el)) return null;
  const p = el.props ?? {};
  if (Array.isArray(p.keys) && typeof p.conversationByKey?.get === 'function') return p;
  return listedChats(R, p.children, depth + 1);
}
/**
 * Does a chat (its thread key) need the user, or is it the one shown? One the graph has not answered for yet (its id's mapping, or its
 * subject) holds its group until it has: a group must not go before the chat in it that needs the user is known. One the graph has
 * answered it has none of (`settled`) holds none. The list renders again when either answer comes (they are read).
 */
function urgent(ctx, threadKey, open) {
  const ref = typeof threadKey === 'string' ? ctx.thread(threadKey) : null;
  if (!ref) return true;
  if (protectedChat({ ref, state: {} }, open)) return true;   // the one shown, known or not
  const x = ctx.subject(ref);
  if (x === undefined) return !ctx.settled?.(ref);
  return !!x && !x.gone && protectedChat(x, open);
}
/** Does a group hold a chat that needs the user (or the one shown)? A list it cannot read: yes (kept). */
function holdsUrgent(R, ctx, el, open) {
  const list = listedChats(R, el);
  if (!list) return true;
  return list.keys.some((k) => {
    const c = list.conversationByKey.get(k);
    if (c && urgent(ctx, c.threadKey, open)) return true;
    const g = list.projectByKey?.get?.(k)?.group;   // a project group in Projects: its chats
    return Array.isArray(g?.threadKeys) && g.threadKeys.some((t) => urgent(ctx, t, open));
  });
}

/**
 * The groups' sortable container without the groups a mod hides (`props.items`: their drag ids `sidebar-section:<key>`; `props.children`:
 * the groups, keyed by their key). Any other sortable list of the app passes as it is (undefined).
 */
export function hideGroups(props, ctx) {
  const R = ctx.react();
  const kids = Array.isArray(props.children) ? props.children : null;
  if (!R || !kids || !Array.isArray(props.items) || !kids.some((k) => R.isValidElement(k) && k.key === 'chats')) return undefined;
  const off = shownMods(ctx);
  const hides = (ctx.ruled?.('Sidebar', null)?.parts ?? []).filter((r) => r.kind === 'hide' && (r.slot === undefined || r.slot === 'groups') && !off.has(r.mod));
  if (!hides.length) return undefined;
  const byPart = new Map();
  for (const r of hides) for (const p of r.part ?? []) if (!byPart.has(p)) byPart.set(p, r.mod);
  const open = openChats(ctx);
  const left = new Set();
  const hidden = new Map();
  for (const k of kids) {
    const part = R.isValidElement(k) ? partOf(k.key) : null;
    const mod = part ? byPart.get(part) : null;
    // the agents' group lists agents, no chats: nothing in it holds it
    if (!mod || (part !== 'agents' && holdsUrgent(R, ctx, k, open))) continue;
    left.add(k.key);
    const s = hidden.get(mod) ?? new Set(); s.add(`group\u001f${part}`); hidden.set(mod, s);
  }
  tally(ctx, 'groups', hidden);
  if (!left.size) return undefined;
  return { ...props, items: props.items.filter((id) => !left.has(String(id).replace(/^sidebar-section:/, ''))), children: kids.filter((k) => !(R.isValidElement(k) && left.has(k.key))) };
}
