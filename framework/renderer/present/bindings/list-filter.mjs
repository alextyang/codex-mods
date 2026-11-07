// The mods' filters over the app's lists (docs/design/public-hooks.md §3.12, `ui.filter(list, {id, title, where? | keep?})`): add rules on
// a list's presentation, slot `filter` (`sidebar`: Sidebar, `transcript`: ThreadView, `files`: FilesView, `changes`: ChangesView), each
// off until its mod or the Host turns it on in a window. The window's filter of a list is every part on there: an item is listed when
// every part keeps it, and the list's notice names each part (its title and its mod) with the user's "Show all", which turns them all off
// in that window. Kept until then or the page reloads. What one part keeps: its `for` (the transcript's records: a type and its subtypes;
// a record of another type is not its to filter), its `where` (the one grammar, §3.1, never over what its mod may not read: then it keeps
// it) and its `keep` (the renderer realm's own test: what it throws trips its rule, and keeps nothing out). NO NODE API.

import { compileWhere } from '../../../shared/where.mjs';
import { seenBy } from '../rules.mjs';
import { actionNode } from './slots.mjs';

/** The lists, by the presentation their filters are declared on. */
export const FILTER_LISTS = Object.freeze({ Sidebar: 'sidebar', ThreadView: 'transcript', FilesView: 'files', ChangesView: 'changes' });
/** The records a transcript filter tests unless its `for` names another (a turn is filtered only when one asks for turns). */
const RECORD_TYPES = Object.freeze(['Step', 'Message']);
const on = new WeakMap();     // the runtime's ctx (one per window) -> presentation -> the keys (`mod/id`) of the filters on in this window
// a keep's answer for an instance as it is now (its snapshot object): asked once, so where an item is asked about again (a project's chats
// by the projects' list, then by its group) never tells a mod which items another kept
const kept = new WeakMap();   // instance -> `mod/id|registration` -> its answer

/** The key a list's filter is read under: a render that reads it renders again when a filter of that list goes on or off. */
export const filterKey = (presentation) => `local:filter:${presentation}`;

/** The declared filters of a list on in this window, each `{key, by, reads, title, where, query, for, threads, keep}`; read (see filterKey). */
export function declaredFilters(ctx, presentation) {
  ctx.local?.read?.(filterKey(presentation));
  const keys = on.get(ctx)?.get(presentation);
  if (!keys || !keys.size || typeof ctx.declared !== 'function') return [];
  const parts = [];
  for (const r of ctx.declared(presentation, 'filter')) {
    const key = `${r.mod}/${r.id}`;
    if (!keys.has(key)) continue;
    const f = r.data?.filter ?? {};
    const keep = typeof r.fns?.filter?.keep === 'function' && typeof ctx.guard === 'function' ? ctx.guard(r, r.fns.filter.keep) : null;
    let where = null;
    if (f.where && typeof f.where === 'object') { try { where = compileWhere(f.where); } catch { where = null; } }
    parts.push(Object.freeze({ key, reg: r.reg ?? null, by: r.mod, reads: r.reads, title: typeof f.title === 'string' ? f.title : r.id, query: typeof f.where === 'string' ? f.where : null, where,
      for: typeof f.for === 'string' ? f.for : null,
      threads: Array.isArray(f.threads) ? new Set(f.threads.filter((t) => t && typeof t.id === 'string' && typeof t.provider === 'string').map((t) => `${t.provider}\n${t.id}`)) : null, keep }));
  }
  return parts;
}
/** Turn a declared filter (`mod/id`) of a list on or off in this window. */
export function setDeclaredFilter(ctx, presentation, key, isOn) {
  let lists = on.get(ctx);
  if (!lists) on.set(ctx, (lists = new Map()));
  let keys = lists.get(presentation);
  if (!keys) lists.set(presentation, (keys = new Set()));
  if (isOn) keys.add(key); else keys.delete(key);
  ctx.local?.touch?.(filterKey(presentation));
}
/** A declaration gone (disposed, or its mod off): its filter is no longer on here, so one registered under its id later starts off. */
export function forgetFilter(ctx, presentation, key) {
  const keys = on.get(ctx)?.get(presentation);
  if (keys?.delete(key)) ctx.local?.touch?.(filterKey(presentation));
}
/** The window's rules were replaced: a filter whose declaration is not among them (`declared(key)`) is no longer on. */
export function pruneFilters(ctx, declared) {
  for (const [presentation, keys] of on.get(ctx) ?? []) for (const key of [...keys]) if (!declared(key)) forgetFilter(ctx, presentation, key);
}
/** The user's "Show all" of a list: every declared filter of it off in this window. */
export function clearDeclaredFilters(ctx, presentation) {
  on.get(ctx)?.delete(presentation);
  ctx.local?.touch?.(filterKey(presentation));
}
/** May a part's mod read an instance (`env(rule)`: what its where reads, as that mod may see it)? A part of no mod may. */
export function partMay(part, inst, env) {
  if (!part.by) return true;
  const e = typeof env === 'function' ? env({ mod: part.by, reads: part.reads }) : {};
  return typeof e.may !== 'function' || e.may(inst);
}
/**
 * Does one part keep an instance? An instance its mod may not read is kept, before any of its tests runs (none of its functions ever
 * sees it); then its `for` (`types`: what it tests when it names none), its where and its keep.
 */
export function partKeeps(part, inst, { env, chainOf, types } = {}) {
  if (!partMay(part, inst, env)) return true;
  const chain = typeof chainOf === 'function' && inst?.ref ? chainOf(inst.ref.type) : [inst?.ref?.type];
  if (part.for ? !chain.includes(part.for) : Array.isArray(types) && !types.some((t) => chain.includes(t))) return true;
  if (part.where) {
    const e = typeof env === 'function' ? env(part.by ? { mod: part.by, reads: part.reads } : null) : {};
    if (!part.where.test(inst, e)) return false;
  }
  if (part.keep) { if (askKeep(part, inst) === false) return false; }
  return true;
}
/** A part's keep asked about an instance, once for each snapshot of it (a function throwing trips its rule, and keeps it). */
function askKeep(part, inst) {
  const id = `${part.key}|${part.reg ?? ''}`;
  let answers = inst && typeof inst === 'object' ? kept.get(inst) : null;
  if (answers?.has(id)) return answers.get(id);
  const r = part.keep(seenBy(inst, part.by));
  if (inst && typeof inst === 'object') { if (!answers) kept.set(inst, (answers = new Map())); answers.set(id, r); }
  return r;
}
/** Every part asked, each over the same item (never one only because another kept it: what one mod keeps is not told to another). */
export const allKeep = (parts, keeps) => parts.map(keeps).every(Boolean);
/** Does the transcript's filter keep a record (a Step or Message unless a part names another type)? */
export function keepsRecord(ctx, parts, inst) {
  return allKeep(parts, (p) => partKeeps(p, inst, { env: ctx.whereEnv, chainOf: ctx.chainOf, types: RECORD_TYPES }));
}
/** Does a list's filter keep an item (the instance it lists, or the list's own account of it: a changed file's path and kind)? */
export function keepsItem(ctx, parts, inst) {
  return allKeep(parts, (p) => partKeeps(p, inst, { env: ctx.whereEnv, chainOf: ctx.chainOf }));
}
/** What a list's notice says: each part's title and the mod that set it. */
export function describeFilters(parts, modName) {
  return parts.map((p) => `${p.title} (${modName(p.by)})`).join('; ');
}
/**
 * A list's notice while filters of it are on (`parts`): what they are and who set them, with the user's "Show all" (the app's own
 * button), which turns them all off in this window; marked for the probes as its list's (`data-codexmods="transcript-filter"`).
 * `compact`: beside a search box, the word "Filtered" with the rest as its tooltip.
 */
export function filterNotice(R, ctx, presentation, parts, { key = 'codexmods:filter', compact = false } = {}) {
  const text = `Filtered: ${describeFilters(parts, (id) => ctx.modName?.(id) ?? id)}`;
  return R.createElement('div', { key, 'data-codexmods': `${FILTER_LISTS[presentation]}-filter`, className: `flex items-center gap-2 ${compact ? 'shrink-0' : 'px-3 py-1'} text-sm text-token-text-secondary` },
    R.createElement('span', { className: compact ? 'whitespace-nowrap' : 'min-w-0 flex-1 truncate', title: text }, compact ? 'Filtered' : text),
    actionNode(R, ctx, { title: 'Show all', run: () => clearDeclaredFilters(ctx, presentation) }, `${key}-clear`));
}
