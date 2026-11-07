// The mods' choices (ui.choices, docs/design/public-hooks.md §3.11; scout H4-choices): what a picker or list offers, keyed by the subject
// offered (a model, an effort, an access mode, a slash command, ...), not by the picker. A declaration is an add rule on `Choices` whose
// slot is the subject, read like the sidebar's (`ctx.declared`): `{in?, hide?: ids | where, order?: ids, label?: {id: text | {title?,
// description?}}}` and its added entries (`items`: `{id, title, description?, run}`), or the renderer realm's `hide(subject) => boolean`.
// Each place that offers the subject applies the plan of the rules naming it (or every place) to its own list:
// - hide: an entry any rule hides is not offered (the one selected never goes: it stays selected and shown);
// - order: the first rule's order puts those ids first, in its order, the others after as they were;
// - label: the first rule that relabels an id says what it shows (the entry is still the app's: choosing it does what it did);
// - add: every rule's entries, after the app's; choosing one runs its mod's callback, never the app's choice.
// A `where` reads the offered entry as an instance: the graph's (a Model) or one made of the entry (its id, title and description), as
// the rule's mod may read it. NO NODE API.
import { compileWhere } from '../../shared/where.mjs';
import { seenBy } from './rules.mjs';

const wheres = new WeakMap();
const compiled = (w) => { if (!wheres.has(w)) { let c; try { c = compileWhere(w); } catch { c = null; } wheres.set(w, c); } return wheres.get(w); };

/**
 * The plan of the rules declaring choices of `subject` in `place`: `{hides(id, inst), order, labelOf(id), adds, sig}`, or null when no
 * rule names it there. `sig` changes when the plan does (a place memoizes its rewritten list on it with the list's own identity).
 */
export function choicesPlan(ctx, subject, place) {
  if (typeof ctx.declared !== 'function') return null;
  const rules = ctx.declared('Choices', subject).filter((r) => {
    const where = r.data?.choices?.in;
    return !Array.isArray(where) || where.includes(place);
  });
  if (!rules.length) return null;
  const hideIds = new Set(), hideWheres = [], hideFns = [], labels = new Map(), adds = [];
  let order = null;
  for (const r of rules) {
    const c = r.data?.choices ?? {};
    if (Array.isArray(c.hide)) for (const id of c.hide) hideIds.add(String(id));
    else if (c.hide && typeof c.hide === 'object') { const w = compiled(c.hide); if (w) hideWheres.push([r, w]); }
    if (typeof r.fns?.choices?.hide === 'function') hideFns.push([r, typeof ctx.guard === 'function' ? ctx.guard(r, r.fns.choices.hide) : r.fns.choices.hide]);
    if (!order && Array.isArray(c.order) && c.order.length) order = c.order.map(String);
    if (c.label && typeof c.label === 'object') for (const [id, l] of Object.entries(c.label)) if (!labels.has(id)) labels.set(id, typeof l === 'string' ? { title: l } : l);
    const given = r.fns?.items ?? r.data?.items;
    for (const a of Array.isArray(given) ? given : []) {
      if (a && typeof a.title === 'string') adds.push({ id: `codexmods:${r.mod}/${r.id}/${a.id}`, title: a.title, description: typeof a.description === 'string' ? a.description : undefined,
        run: typeof a.run === 'function' ? (env) => (typeof ctx.guard === 'function' ? ctx.guard(r, a.run) : a.run)(env && typeof env === 'object' ? env : {}) : null });
    }
  }
  const envOf = (r) => (typeof ctx.whereEnv === 'function' ? ctx.whereEnv(r) : {});
  return {
    hides(id, inst) {
      if (hideIds.has(id)) return true;
      // an entry made of what the picker shows (`made`) holds nothing its mod may not read; a graph instance is read as its mod may
      if (inst && hideWheres.some(([r, w]) => { const env = envOf(r); return (inst.made === true || typeof env.may !== 'function' || env.may(inst)) && w.test(inst, env); })) return true;
      // a function reads it only where its mod may (H7z review 1: a Model of the graph, not only one made of the entry)
      return !!inst && hideFns.some(([r, fn]) => { const env = envOf(r); return (inst.made === true || typeof env.may !== 'function' || env.may(inst)) && fn(seenBy(inst, r.mod)) === true; });
    },
    /** Whether hiding reads the entries as instances (a where, a function): a place that caches its list keys it on them too. */
    reads: hideWheres.length + hideFns.length > 0,
    order,
    labelOf: (id) => labels.get(id) ?? null,
    adds,
    sig: rules.map((r) => `${r.mod}/${r.id}/${r.reg ?? ''}`).join('|'),
  };
}

/**
 * A list with a plan applied: `idOf(item)` its entry's id (null: not an entry, left in its place), `instanceOf(item)` the instance a where
 * reads, `keep` the ids never hidden (the selected), `relabel(item, {title, description})` the entry relabelled, `make(add)` an added
 * entry (or null: this place adds none). Hidden entries go, the order applies among the entries, labels apply, the added ones follow.
 */
export function applyChoices(items, plan, { idOf, instanceOf = () => null, keep = new Set(), relabel = (x) => x, make = null }) {
  if (!plan || !Array.isArray(items)) return items;
  let out = items.filter((it) => { const id = idOf(it); return id == null || keep.has(id) || !plan.hides(id, instanceOf(it)); });
  if (plan.order) {
    const rank = new Map(plan.order.map((id, i) => [id, i]));
    const slots = out.map((it, i) => (idOf(it) != null ? i : -1)).filter((i) => i >= 0);
    const entries = slots.map((i) => out[i]);
    const sorted = entries.map((it, i) => ({ it, i, r: rank.get(idOf(it)) })).sort((a, b) => (a.r ?? Infinity) - (b.r ?? Infinity) || a.i - b.i).map((x) => x.it);
    out = [...out];
    slots.forEach((at, k) => { out[at] = sorted[k]; });
  }
  out = out.map((it) => { const id = idOf(it); const l = id != null ? plan.labelOf(id) : null; return l ? relabel(it, l) : it; });
  if (make) for (const a of plan.adds) { const x = make(a); if (x != null) out.push(x); }
  return out;
}

/** An instance made of an offered entry (no graph instance stands for it): its id, title and description, for a where to read. */
export const madeOf = (type, id, state = {}) => Object.freeze({ ref: { type, provider: 'codex', id }, state: { id, ...state }, links: {}, made: true });

/** One cached result per place: the same output while the source list and the plan are the same (the app's caches compare identity). */
export function memoOne() {
  let last = null;
  return (inputs, compute) => {
    if (last && last.inputs.length === inputs.length && last.inputs.every((x, i) => x === inputs[i])) return last.out;
    const out = compute();
    last = { inputs, out };
    return out;
  };
}
