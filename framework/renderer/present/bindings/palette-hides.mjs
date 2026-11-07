// The app's commands mods hide from the palette (docs/design/public-hooks.md §3.12, `ui.hide('Command', {id, where?, of?})`): add rules on
// Palette `hidden`, each `{hide: {for: 'Command', where?, of?}}`, on in every window. The chats the mods hide from the sidebar
// (`ui.hide('Thread')`, sidebar-hides.mjs) leave its chat rows too (`palette.chat`, H7t), told here the same way (ids `chat:<id>`). A command's row (`palette.command`) is not drawn while
// one covers it (its Command as the graph holds it, else as the row gives it: its id and title); the palette's own section "Hidden" says
// how many each mod hides, each row "Show N hidden by <mod>", which shows that mod's again in this window until the page reloads. What the
// rows leave out is told here as they render (`tallyCommand`, with every term the palette would have matched them by), and counted while
// they are mounted (the palette open, the command available there). NO NODE API.

import { compileWhere } from '../../../shared/where.mjs';
import { hiddenBy, sidebarHides } from './sidebar-hides.mjs';

const KEY = 'local:palette.hidden';
const shown = new WeakMap();    // the runtime's ctx (one per window) -> the mods whose hides the user showed here
const told = new WeakMap();     // ctx -> mod -> the rows of commands it hides (a row's mount -> {id, terms}: one command may be drawn twice)
const listeners = new WeakMap();   // ctx -> what to tell when the counts change (the palette's own sections)

/** The command hides on in this window, each `{key, by, reads, for, where, of}`; read. */
export function paletteHides(ctx) {
  const declared = typeof ctx.declared === 'function' ? ctx.declared('Palette', 'hidden') : [];
  if (!declared.length) return [];   // none declared: nothing read (a declaration coming draws every row again)
  ctx.local?.read?.(KEY);
  const off = shown.get(ctx);
  const parts = [];
  for (const r of declared) {
    const h = r.data?.hide;
    if (!h || h.for !== 'Command' || off?.has(r.mod)) continue;
    let where = null;
    if (h.where && typeof h.where === 'object') { try { where = compileWhere(h.where); } catch { continue; } }
    parts.push(Object.freeze({ key: `${r.mod}/${r.id}`, by: r.mod, reads: r.reads, for: 'Command', where, of: h.of ?? null }));
  }
  return parts;
}
/** The chat hides on in this window (the sidebar's, `ui.hide('Thread')`); none declared: nothing read. */
export function chatHides(ctx) {
  const declared = typeof ctx.declared === 'function' ? ctx.declared('Sidebar', 'hidden') : [];
  return declared.length ? sidebarHides(ctx).filter((p) => p.for === 'Thread') : [];
}
/** The mod that hides a command's row, or null (`inst`: its Command, or the row's account of it). */
export const commandHiddenBy = (ctx, parts, inst) => hiddenBy(ctx, parts, inst, null);
/**
 * A row (`row`: its mount's number) tells whether its command is hidden now (`by` null: not), with its search terms; the counts' listener
 * is told after this render when they changed.
 */
export function tallyCommand(ctx, row, id, by, terms = [id]) {
  let byMod = told.get(ctx);
  if (!byMod) told.set(ctx, (byMod = new Map()));
  let changed = false;
  for (const [m, rows] of byMod) if (m !== by && rows.delete(row)) changed = true;
  if (by) {
    const rows = byMod.get(by) ?? new Map();
    const was = rows.get(row);
    if (!was || was.id !== id || was.terms.join('\n') !== terms.join('\n')) { rows.set(row, { id, terms }); changed = true; }
    byMod.set(by, rows);
  }
  if (changed) { const fn = listeners.get(ctx); if (fn) Promise.resolve().then(fn); }
}
/** The terms a command's row is found by in the palette: its title, its description and its keywords, as the row gives them. */
export function termsOf(props) {
  const c = props?.command ?? {};
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim()); };
  for (const x of [c.title, props?.title, c.description, props?.description]) add(x);   // whole: a word late in one still finds the notice
  for (const k of [c.keywords, c.searchKeywords, props?.searchKeywords, props?.keywords]) if (Array.isArray(k)) k.forEach(add);
  return out.length ? out : [String(c.id)];
}
/** A row gone (unmounted): what it told goes with it (built review H7s round 2: a session's palettes kept every row's). */
export function forgetRow(ctx, row) {
  const byMod = told.get(ctx);
  if (!byMod) return;
  for (const [m, rows] of byMod) { rows.delete(row); if (!rows.size) byMod.delete(m); }
}
/** What to call when the counts change (the runtime rebuilds the palette's own sections). */
export function onHiddenCommands(ctx, fn) { listeners.set(ctx, fn); }
/**
 * How many commands each mod hides among the rows mounted now (`mountedRows`: their mounts' numbers), `[[mod, n, terms]]` (each command
 * once, however many rows draw it; the terms of every row of them), for the mods hiding now.
 */
export function hiddenCommandCounts(ctx, mountedRows = []) {
  const hiding = new Set([...paletteHides(ctx), ...chatHides(ctx)].map((p) => p.by));
  const mounted = new Set(mountedRows);
  const out = [];
  for (const [m, rows] of told.get(ctx) ?? new Map()) {
    if (!hiding.has(m)) continue;
    const here = [...rows].filter(([row]) => mounted.has(row)).map(([, x]) => x);
    if (here.length) out.push([m, new Set(here.map((x) => x.id)).size, [...new Set(here.flatMap((x) => x.terms))]]);
  }
  return out;
}
/** The user's "Show" of one mod's hidden commands in this window. */
export function showHiddenCommands(ctx, mod) {
  let off = shown.get(ctx);
  if (!off) shown.set(ctx, (off = new Set()));
  off.add(mod);
  told.get(ctx)?.delete(mod);   // its rows are drawn again, and tell again
  ctx.local?.touch?.(KEY);
  const fn = listeners.get(ctx);
  if (fn) Promise.resolve().then(fn);
}
