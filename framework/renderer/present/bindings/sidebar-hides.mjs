// The chats and projects mods hide from the sidebar's listings (docs/design/public-hooks.md §3.12, `ui.hide('Thread' | 'Project', {id,
// where?, of?})`): add rules on Sidebar `hidden`, each `{hide: {for, where?, of?}}`, on in every window. The lists leave out what one
// covers, as a filter's do (sidebar.section, sidebar.list, the mods' sections), but never the chat a window shows, nor one working, waiting
// for the user or failed; a project's group goes whole unless it holds such a chat. The window's notice says how many each mod hides ("2
// hidden by <mod>") with "Show", which shows that mod's again in this window until the page reloads. What a list leaves out is told here
// as it renders (`tally`): the notice counts what the lists shown now hide, each subject once, for the mods hiding now. NO NODE API.

import { compileWhere, namesInstance } from '../../../shared/where.mjs';

const KEY = 'local:sidebar.hidden';          // the hides on in this window changed (a mod's shown, rules)
const COUNT_KEY = 'local:sidebar.hidden.count';   // what the lists hide changed
const shown = new WeakMap();    // the runtime's ctx (one per window) -> the mods whose hides the user showed here
const told = new WeakMap();     // ctx -> list id -> mod -> the subjects (`type\u001fprovider\u001fid`) it hides there now
/** A chat that needs the user, or is under way, is never hidden. */
const BUSY = new Set(['working', 'waitingForYou', 'error']);

/** The hides on in this window, each `{key, by, reads, for, where, of}`; read (a render that reads them renders again when they change). */
export function sidebarHides(ctx) {
  ctx.local?.read?.(KEY);
  if (typeof ctx.declared !== 'function') return [];
  const off = shown.get(ctx);
  const parts = [];
  for (const r of ctx.declared('Sidebar', 'hidden')) {
    const h = r.data?.hide;
    if (!h || (h.for !== 'Thread' && h.for !== 'Project') || off?.has(r.mod)) continue;
    let where = null;
    if (h.where && typeof h.where === 'object') { try { where = compileWhere(h.where); } catch { continue; } }
    parts.push(Object.freeze({ key: `${r.mod}/${r.id}`, by: r.mod, reads: r.reads, for: h.for, where, of: h.of ?? null }));
  }
  return parts;
}
/**
 * The mod that hides an instance from the sidebar, or null: the first part for its type (and subtypes) whose `of` names it and whose where
 * holds, as its mod may read it (one its mod may not read is not hidden). `open`: the chats the window shows (`openChats`).
 */
export function hiddenBy(ctx, parts, inst, open) {
  if (!parts.length || !inst?.ref || inst.gone) return null;
  const chain = typeof ctx.chainOf === 'function' ? ctx.chainOf(inst.ref.type) : [inst.ref.type];
  if (chain.includes('Thread') && (BUSY.has(inst.state?.status) || open?.has(openKey(inst.ref)))) return null;
  for (const p of parts) {
    if (!chain.includes(p.for)) continue;
    const env = typeof ctx.whereEnv === 'function' ? ctx.whereEnv({ mod: p.by, reads: p.reads }) : {};
    if (typeof env.may === 'function' && !env.may(inst)) continue;
    if (p.of && !namesInstance(p.of, inst, ctx.chainOf)) continue;
    if (p.where && !p.where.test(inst, env)) continue;
    return p.by;
  }
  return null;
}
/** A chat no hide takes out: the one a window shows, or one working, waiting for the user or failed. */
export const protectedChat = (inst, open) => !!inst?.ref && (BUSY.has(inst.state?.status) || !!open?.has(openKey(inst.ref)));
/** A chat as `openChats` names it: its graph ref's provider and id (the type aside: a CodexThread is a Thread). */
const openKey = (ref) => `${ref.provider}\u001f${ref.id}`;
/**
 * The chats the window shows (its thread pages), each named by the graph ref its id stands for (the app's own chats), read: a list
 * renders again when they change.
 */
export function openChats(ctx) {
  const recs = typeof ctx.mountsOf === 'function' ? ctx.mountsOf('thread.view') : [];
  const out = new Set();
  for (const raw of recs.map((r) => r?.props?.conversationId)) {
    if (typeof raw !== 'string' || !raw) continue;
    const id = raw.startsWith('local:') ? raw.slice(6) : raw;
    const ref = typeof ctx.thread === 'function' ? ctx.thread(id) : null;
    out.add(openKey(ref && typeof ref.id === 'string' && typeof ref.provider === 'string' ? ref : { provider: 'codex', id }));
  }
  return out;
}
/** What one list hides now (`hidden`: mod -> subject keys), told as it renders; the notice is told after this render when it changed. */
export function tally(ctx, list, hidden) {
  let lists = told.get(ctx);
  if (!lists) told.set(ctx, (lists = new Map()));
  const before = lists.get(list);
  const same = before && before.size === hidden.size && [...hidden].every(([m, s]) => before.get(m)?.size === s.size && [...s].every((k) => before.get(m).has(k)));
  if (same || (!before && !hidden.size)) return;
  if (hidden.size) lists.set(list, hidden); else lists.delete(list);
  Promise.resolve().then(() => ctx.local?.touch?.(COUNT_KEY));
}
/** The lists the window shows now: the project groups and lists mounted (their bindings' mounts) and the mods' sections declared; read. */
function shownLists(ctx) {
  const mounts = (id) => (typeof ctx.mountsOf === 'function' ? ctx.mountsOf(id) : []);
  const ids = new Set();
  for (const r of mounts('sidebar.section')) { const g = r?.props?.project?.group; if (g) ids.add(`group:${g.projectKind}:${g.projectId}`); }
  for (const r of mounts('sidebar.list')) ids.add(`list:${typeof r?.props?.threadContainerId === 'string' ? r.props.threadContainerId : 'chats'}`);
  for (const r of typeof ctx.declared === 'function' ? ctx.declared('Sidebar', 'section') : []) ids.add(`codexmods:${r.mod}/${r.id}`);
  return ids;
}
/** How many subjects each mod hides in the window's lists now, `[[mod, n]]` (each subject once; only lists shown, mods hiding); read. */
export function hiddenCounts(ctx) {
  ctx.local?.read?.(COUNT_KEY);
  const off = shown.get(ctx);
  // a mod shown here, or whose hides went, counts nothing; a mod hiding the app's groups (sidebar-groups.mjs, the `groups` list: drawn
  // while the sidebar is) counts too
  const groupHides = (ctx.ruled?.('Sidebar', null)?.parts ?? []).filter((r) => r.kind === 'hide' && (r.slot === undefined || r.slot === 'groups') && !off?.has(r.mod)).map((r) => r.mod);
  const hiding = new Set([...sidebarHides(ctx).map((p) => p.by), ...groupHides]);
  if (!hiding.size) return [];
  const lists = new Set([...shownLists(ctx), ...(groupHides.length ? ['groups'] : [])]);
  const by = new Map();
  for (const [list, hidden] of told.get(ctx) ?? []) {
    if (!lists.has(list)) continue;
    for (const [m, keys] of hidden) { if (!hiding.has(m)) continue; const s = by.get(m) ?? new Set(); for (const k of keys) s.add(k); by.set(m, s); }
  }
  return [...by].filter(([, s]) => s.size).map(([m, s]) => [m, s.size]);
}
/** The mods whose hides the user showed again in this window (read: a render that reads it renders again when it changes). */
export function shownMods(ctx) { ctx.local?.read?.(KEY); return shown.get(ctx) ?? new Set(); }
/** The user's "Show" of one mod's hides in this window. */
export function showHidden(ctx, mod) {
  let off = shown.get(ctx);
  if (!off) shown.set(ctx, (off = new Set()));
  off.add(mod);
  ctx.local?.touch?.(KEY);
}
/** A subject's key in a tally. */
export const subjectKey = (ref) => `${ref.type}\u001f${ref.provider}\u001f${ref.id}`;
