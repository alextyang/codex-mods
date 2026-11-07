// The sidebar's filter (docs/graph/03 Sidebar `filter`, E8.9j; scout E8-frame-slots §2.2; declared: docs/design/public-hooks.md §3.12): which
// chats the sidebar lists. The app has no text filter of its own (its search is the command palette) and its own filters live inside its
// list model, so the lists' keys are what is filtered: the project groups' thread keys (`sidebar.section`), and the other lists' keys
// (`sidebar.list`: pinned, chats, a custom section's, the projects). The app's own paging, "Show more" and empty states stay as they are.
// The window's filter is every part that is on: the mods' declared filters (`ui.filter('sidebar', ...)`, list-filter.mjs) a mod or the Host
// turned on in this window, and the mechanism's one (`Sidebar._filter`); a chat is listed when every part keeps it. The user's "Show all"
// turns every part off in this window. Kept until then or the page reloads. NO NODE API.

import { compileWhere } from '../../../shared/where.mjs';
import { declaredFilters, clearDeclaredFilters, filterKey, partKeeps as declaredKeeps, partMay, allKeep } from './list-filter.mjs';

const KEY = filterKey('Sidebar');
const own = new WeakMap();    // the runtime's ctx (one per window) -> the mechanism's filter { query, by }

/** The window's filter (its parts), or null; a render that reads it renders again when it changes. */
export function sidebarFilter(ctx) {
  const parts = declaredFilters(ctx, 'Sidebar');
  const mine = own.get(ctx);
  if (mine) parts.unshift(mine);
  return parts.length ? Object.freeze({ parts }) : null;
}
/** Set the mechanism's filter (`query` null: none) and re-render the sidebar's lists. */
export function setSidebarFilter(ctx, query, by = null) {
  if (query === null || query === undefined) own.delete(ctx);
  else {
    let where = null;
    if (query && typeof query === 'object') { try { where = compileWhere(query); } catch { where = null; } }
    own.set(ctx, Object.freeze({ query: typeof query === 'string' ? query : null, where, describe: query, by: typeof by === 'string' && by ? by : null }));
  }
  ctx.local?.touch?.(KEY);
}
/** The user's "Show all": every part off in this window. */
export function clearSidebarFilter(ctx) {
  own.delete(ctx);
  clearDeclaredFilters(ctx, 'Sidebar');
}
/** Does one part keep a chat (its instance and id)? `env(mod)`: what a where reads besides the chat, as that mod may see it. */
function partKeeps(part, inst, ref, env) {
  // a chat its mod may not read is kept, before any of its tests (its text, its chats, its where, its keep)
  if (part.key && !partMay(part, inst, env)) return true;
  if (part.threads && !part.threads.has(`${ref.provider}\n${ref.id}`)) return false;
  const q = part.query;
  if (typeof q === 'string') {
    const needle = q.toLowerCase();
    if (![inst.state.title, inst.state.preview].some((t) => typeof t === 'string' && t.toLowerCase().includes(needle))) return false;
  }
  // the one grammar (docs/design/public-hooks.md §3.1); the mechanism's own filter is equality on state fields, the same thing
  if (!part.key) return !part.where || part.where.test(inst, typeof env === 'function' ? env(part.by ? { mod: part.by, reads: [] } : null) : {});
  return declaredKeeps(part, inst, { env });
}
/** Does the chat a sidebar key names (`local:<id>`, or its id) pass every part? A key that names no chat the graph holds does not. */
export function keeps(ctx, filter, key) {
  const ref = typeof key === 'string' && key ? ctx.thread(key) : null;
  const inst = ref ? ctx.subject(ref) : null;
  if (!inst || inst.gone || !inst.state) return false;
  return allKeep(filter.parts, (p) => partKeeps(p, inst, ref, ctx.whereEnv));
}
/** What the notice says: each part, and the mod that set it. */
export function describe(filter, modName) {
  const one = (p) => {
    if (p.title) return `${p.title} (${modName(p.by)})`;
    const q = p.describe ?? p.query;
    const what = typeof q === 'string' ? `“${q}”` : Object.entries(q ?? {}).map(([k, v]) => `${k}: ${v && typeof v === 'object' && Array.isArray(v.$in) ? v.$in.join(' or ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
    return p.by ? `chats matching ${what}, filtered by ${modName(p.by)}` : `chats matching ${what}`;
  };
  const said = filter.parts.map(one).join('; ');
  return said.charAt(0).toUpperCase() + said.slice(1);
}
