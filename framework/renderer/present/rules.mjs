// The page's copy of the mods' presentation rules (docs/design/systems.md S5 to S9, "E2 in detail"), and how a binding applies them.
// The Host keeps the registry of record and gives each rule its order; a window holds the accepted rules (from the Host's snapshot and
// deltas), each with the functions and components its mod registered in this window, and applies them at render time in the binding's
// wrapper:
// - claims: for one presentation instance, `hide` and `replace` are one claim, the first rule in order wins (hidden, or rendered by that
//   mod's component, given the app's own rendering as `Native`); the others are told;
// - lists (`decorate`'s badges, labels, tooltips and actions; `add`'s items) concatenate in order after the app's own entries, within the
//   slot's budget (it counts the app's entries; what does not fit is dropped and told); `reorder` applies last, to the list as composed;
// - regions (`host`) render each rule's component in the slot, in order.
// A rule that throws (its function, its component, a callback it handed the app, a promise it returned) is off until reload, alone, and
// counts one fault for its mod. Every mod node handed to the app sits in its own error boundary. NO NODE API.

import { modContextOf } from './attest.mjs';
import { CALLBACK_PATH, ARG_PATHS } from '../../shared/ui-rules-client.mjs';
import { compileWhere, namesInstance, readPath } from '../../shared/where.mjs';
import { PARTS } from '../../shared/parts.mjs';

/** Is this a slot of the app's own parts (public-hooks.md §3.10)? */
const partSlot = (presentation, slot) => !!PARTS[presentation]?.[slot];

export const KINDS = Object.freeze(['decorate', 'hide', 'replace', 'host', 'render', 'add', 'reorder', 'style']);
const CLAIMS = new Set(['hide', 'replace']);
/** The framework's provider: its instances (the framework, the mods, their operations and settings) are the user's (E6, decision 6). */
const FRAMEWORK_PROVIDER = 'codexmods.framework';

const compiledWheres = new WeakMap();   // a rule's where -> compiled (the Host checked it; one that does not compile covers nothing)
const compiledOf = (where) => {
  if (!compiledWheres.has(where)) { let c; try { c = compileWhere(where, { window: true }); } catch { c = null; } compiledWheres.set(where, c); }
  return compiledWheres.get(where);
};
/**
 * Does the rule's `for` (a type with its subtypes), `of` (the instances it names) and `where` (docs/design/public-hooks.md §3.1)
 * cover this subject? `whereEnv(rule)`: what a where reads besides the instance, as the rule's mod may see it. Never a framework-owned
 * subject: no mod hides, replaces or decorates the presentation of the framework's own instances (systems.md "E6 in detail", decision 6).
 */
const SUBJECT_KINDS = new Set(['decorate', 'add', 'host', 'replace', 'render']);
/** A value that reads its subject: a template (`{{path}}`) or a binding (`{bind}`). */
const readsSubject = (v) => (typeof v === 'string' ? v.includes('{{') : !!v && typeof v === 'object' && !Array.isArray(v) && 'bind' in v);
/**
 * A status (ui.status: an `add` to a place's `status` slot) that reads nothing of its place's subject and is handed none: fixed text,
 * tooltip and meter, no `when`, no run (whose env names the subject). It shows in its place whatever its mod may read there, as it says
 * nothing of the subject: a usage mod's "Weekly 27%" needs no read of the chat's draft.
 */
export function readsNothing(rule) {
  if (rule?.kind !== 'add' || rule.slot !== 'status' || rule.subject !== undefined || rule.data?.subject !== undefined) return false;
  if ((rule.callbacks?.length ?? 0) > 0 || (rule.fns && Object.keys(rule.fns).length)) return false;
  const items = rule.data?.items;
  return Array.isArray(items) && items.length > 0 && items.every((x) => !!x && typeof x === 'object' && x.when === undefined && x.run === undefined
    && !readsSubject(x.text) && !readsSubject(x.tooltip) && !readsSubject(x.meter?.value) && !readsSubject(x.meter?.max));
}
export function covers(rule, inst, chainOf, whereEnv) {
  // eslint-disable-next-line codexmods/no-provider-identity -- no mod covers the framework's own instances
  if (inst?.ref?.provider === FRAMEWORK_PROVIDER) return false;
  if (rule.for) {
    if (!inst || !inst.ref) return false;
    if (!chainOf(inst.ref.type).includes(rule.for)) return false;
  }
  // what draws a mod's content for a subject or hands its code the subject (a decoration, an added entry, a hosted region, a component)
  // goes only where its mod may read that subject, with or without `for` or a where (built review H7s, rounds 1 and 2); a part rule and
  // a hide name the app's own parts and presentations, not the subject's content
  if (inst && inst.ref && rule.part === undefined && SUBJECT_KINDS.has(rule.kind) && !readsNothing(rule)) {
    const env = typeof whereEnv === 'function' ? whereEnv(rule) : {};
    if (typeof env.may === 'function' && !env.may(inst)) return false;
  }
  if (rule.of !== undefined && !namesInstance(rule.of, inst, chainOf)) return false;
  if (rule.where && typeof rule.where === 'object') {
    const w = compiledOf(rule.where);
    const env = typeof whereEnv === 'function' ? whereEnv(rule) : {};
    // a where reads its subject too: never one its mod may not read
    if (!w || (typeof env.may === 'function' && !env.may(inst)) || !w.test(inst, env)) return false;
  }
  return true;
}

/**
 * An instance as one mod may see it (public-hooks.md §3.3): the page holds every mod's attached data with `attachedPrivate`; a mod's
 * function gets its own values and the shared ones only.
 */
export function seenBy(inst, mod) {
  if (!inst || typeof inst !== 'object' || (inst.attached === undefined && inst.attachedPrivate === undefined)) return inst;
  const priv = new Set(Array.isArray(inst.attachedPrivate) ? inst.attachedPrivate : []);   // `<modId>/<name>`: privacy is per value
  const attached = {};
  for (const [m, v] of Object.entries(inst.attached ?? {})) {
    const seen = m === mod ? v : Object.fromEntries(Object.entries(v ?? {}).filter(([name]) => !priv.has(`${m}/${name}`)));
    if (Object.keys(seen ?? {}).length) attached[m] = seen;
  }
  const { attachedPrivate: _p, attached: _a, ...rest } = inst;
  return Object.freeze(Object.keys(attached).length ? { ...rest, attached: Object.freeze(attached) } : rest);
}

/**
 * A host-realm rule's data with its callback markers `{$fn: path}` made functions that run the callback in the mod's worker through the
 * Host (docs/design/mod-surfaces.md P1), with the env they are given (P2). A rule with no callbacks is returned as it is.
 */
/**
 * A renderer rule as this window draws it (docs/design/graph-layers.md §2): the whole of its registration here (its kind, presentation,
 * slot, `for`, `where`, `of`, part, data), its functions and its token, with the Host's order (the Host's record is the newest window's); null when
 * this window holds none. `handle`: `{fns, reg, desc}`.
 */
export function joinWindowRule(rule, handle) {
  if (!handle) return null;
  const { regs: _regs, slot: _slot, for: _for, where: _where, data: _data, of: _of, part: _part, ...base } = rule;
  const d = handle.desc ?? rule;
  // every declared field this window's (a part as the Host normalizes it: a list)
  const own = { ...(d.kind !== undefined ? { kind: d.kind } : {}), ...(d.presentation !== undefined ? { presentation: d.presentation } : {}),
    ...(d.slot !== undefined ? { slot: d.slot } : {}), ...(d.for !== undefined ? { for: d.for } : {}), ...(d.where !== undefined ? { where: d.where } : {}),
    ...(d.of !== undefined ? { of: d.of } : {}), ...(d.part !== undefined ? { part: Object.freeze(Array.isArray(d.part) ? [...d.part] : [d.part]) } : {}),
    ...(d.data !== undefined ? { data: d.data } : {}) };
  // its order is its own priority's: the Host's order is rank and priority (host/ui-rules.mjs orderOf), so this window's is the Host's moved
  // by the difference of the two priorities (another window's raised priority never reorders this one's)
  const clamp = (p) => Math.max(-999, Math.min(999, Math.trunc(Number.isFinite(p) ? p : 0)));
  const order = Number.isFinite(rule.order) && handle.desc ? rule.order + clamp(rule.priority) - clamp(handle.desc.priority) : rule.order;
  return { ...base, ...own, ...(order !== undefined ? { order } : {}), ...(handle.desc ? { priority: clamp(handle.desc.priority) } : {}),
    fns: handle.fns, ...(typeof handle.reg === 'string' ? { reg: handle.reg } : {}) };
}
export function hydrate(rule, call) {
  if (!rule || !Array.isArray(rule.callbacks) || !rule.callbacks.length || typeof call !== 'function') return rule;
  const key = `${rule.mod}/${rule.id}`;
  const paths = new Set(rule.callbacks);
  const reg = rule.reg;
  // a marker becomes a callback only as an entry's `run`, at the path it names (as the Host checked); anything else is nothing
  const walk = (v, depth, at) => {
    if (!v || typeof v !== 'object' || depth > 8) return v;
    if (!Array.isArray(v) && Object.keys(v).length === 1 && '$fn' in v) {
      if (v.$fn !== at || !paths.has(at) || !CALLBACK_PATH.test(at)) return undefined;
      // a source's search and choose (and a mention source's search) take their argument, then the env; an entry's run takes the env
      return ARG_PATHS.has(at) ? (arg, env) => call(key, reg, at, { arg: arg ?? null, env: env ?? null }) : (env) => call(key, reg, at, env === undefined ? null : env);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, depth + 1, `${at}.${i}`));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1, at ? `${at}.${k}` : k);
    return out;
  };
  return { ...rule, data: walk(rule.data, 0, '') };
}

/**
 * @param {{ onFault?: (mod: string, error: Error, rule: string) => void, onConflict?: (loser: object, winner: object) => void,
 *   log?: (m: string, d?: object) => void, callback?: (key: string, reg: string, path: string, env: object | null) => Promise<unknown> }} [o]
 *   `callback(key, reg, path, env)`: runs a host-realm rule's callback (P1), for the registration `reg`
 */
export function createRules(o = {}) {
  const rules = new Map();        // key `${mod}/${id}` -> rule (accepted, with its page handles when it is this window's)
  const tripped = new Set();      // keys of rules that threw: off until reload
  const told = new Set();         // conflicts already told, so a render loop tells each once
  let sorted = new Map();         // presentation -> rules in order
  const keyOf = (r) => `${r.mod}/${r.id}`;
  const reindex = () => {
    const out = new Map();
    for (const r of [...rules.values()].sort((a, b) => a.order - b.order || keyOf(a).localeCompare(keyOf(b)))) {
      if (!r.presentation) continue;
      let l = out.get(r.presentation);
      if (!l) out.set(r.presentation, (l = []));
      l.push(r);
    }
    sorted = out;
  };

  /**
   * Is this the rule as it is now: still registered, by the same registration (a host-realm rule's token, a renderer rule's functions in
   * this window)? An action the user took on what an older registration drew is nothing.
   */
  function live(rule) {
    const now = rules.get(keyOf(rule));
    if (!now || tripped.has(keyOf(rule))) return false;
    if (rule.reg !== undefined && now.reg !== rule.reg) return false;
    if (rule.fns !== undefined && now.fns !== rule.fns) return false;
    return true;
  }
  /** A rule's function or callback, guarded: a throw (or a rejected promise) trips the rule alone and counts for its mod; a rule that is
   *  gone or registered again since the function was handed out does nothing. */
  function guard(rule, fn) {
    if (typeof fn !== 'function') return fn;
    return (...args) => {
      if (tripped.has(keyOf(rule)) || !live(rule)) return undefined;
      try {
        const out = fn(...args);
        if (out && typeof out.then === 'function') out.then(undefined, (e) => trip(rule, e));
        return out;
      } catch (e) { trip(rule, e); return undefined; }
    };
  }
  function trip(rule, error) {
    const key = keyOf(rule);
    if (tripped.has(key)) return;
    // a late failure of a rule that was registered again since (another token, or other functions in this window) is not the new one's
    const now = rules.get(key);
    if (now && rule.reg !== undefined && now.reg !== rule.reg) return;
    if (now && rule.fns !== undefined && now.fns !== rule.fns) return;
    tripped.add(key);
    o.log?.('a presentation rule failed and is off until reload', { rule: key, message: String(error?.message ?? error) });
    try { o.onFault?.(rule.mod, error instanceof Error ? error : new Error(String(error)), key, rule); } catch { /* the reporter's own fault */ }
  }

  return {
    keyOf,
    guard,
    live,
    trip,
    /** Replace every rule (the Host's snapshot), keeping the page handles of the ones this window registered. */
    reset(list, handles = new Map()) {
      told.clear();
      rules.clear();
      for (const r of list ?? []) rules.set(keyOf(r), { ...hydrate(r, o.callback), ...(handles.get(keyOf(r)) ?? {}) });
      reindex();
    },
    /** A rule's new record replaces its old one: every declared field is the new one's (one it no longer names goes); only the page's own
     *  handle (its functions, its registration) stays where the new record carries none. */
    put(rule) {
      const k = keyOf(rule), prev = rules.get(k), next = hydrate(rule, o.callback);
      const kept = prev ? Object.fromEntries(['fns', 'reg', 'desc'].filter((f) => prev[f] !== undefined && next[f] === undefined).map((f) => [f, prev[f]])) : {};
      rules.set(k, { ...kept, ...next });
      reindex();
    },
    remove(key) {
      const had = rules.delete(key); tripped.delete(key);
      // a conflict it took part in is over: told again if it comes back
      for (const k of [...told]) if (k.startsWith(`${key}>`) || k.endsWith(`>${key}`)) told.delete(k);
      if (had) reindex();
      return had;
    },
    get: (key) => rules.get(key),
    /** Is there any rule for this presentation type? (A binding reads its subject for the rules only then.) */
    has: (presentation) => (sorted.get(presentation)?.length ?? 0) > 0,
    all: () => [...rules.values()],
    tripped: () => [...tripped],
    /** What a rule's where and live text read besides its subject, as its mod may see it (the runtime's). */
    env: (rule) => (typeof o.whereEnv === 'function' ? o.whereEnv(rule) : {}),
    /**
     * The rules for one presentation instance: `claim` (the winner of hide or replace, or null), `lists` per slot (decorate and add,
     * in order) and `regions` per slot (host), `reorders` per slot, `render` (the body rule of the subject's own subtype), and `parts`:
     * the rules on the app's own parts (public-hooks.md §3.10), in order, for the binding that draws them.
     */
    resolve(presentation, inst, chainOf, whereEnv) {
      const out = { claim: null, decorations: [], adds: new Map(), regions: new Map(), reorders: new Map(), render: null, parts: [] };
      for (const r of sorted.get(presentation) ?? []) {
        if (tripped.has(keyOf(r)) || !covers(r, inst, chainOf, whereEnv)) continue;
        if (r.part !== undefined || (r.kind === 'reorder' && Array.isArray(r.data?.order) && r.slot && partSlot(presentation, r.slot))) { out.parts.push(r); continue; }
        if (CLAIMS.has(r.kind)) {
          if (!out.claim) out.claim = r;
          else {
            const k = `${keyOf(r)}>${keyOf(out.claim)}`;
            if (!told.has(k)) { told.add(k); try { o.onConflict?.(r, out.claim); } catch { /* the reporter's own fault */ } }
          }
        } else if (r.kind === 'decorate') out.decorations.push(r);
        else if (r.kind === 'add') { const l = out.adds.get(r.slot) ?? []; l.push(r); out.adds.set(r.slot, l); }
        else if (r.kind === 'host') { const l = out.regions.get(r.slot) ?? []; l.push(r); out.regions.set(r.slot, l); }
        else if (r.kind === 'reorder') { const l = out.reorders.get(r.slot) ?? []; l.push(r); out.reorders.set(r.slot, l); }
        else if (r.kind === 'render' && !out.render) out.render = r;
      }
      return out;
    },
  };
}

/**
 * The value of a decoration field for a subject: static data, or (renderer realm) a function of the subject, guarded.
 * @returns {any} undefined when absent or when the function threw
 */
export function valueOf(rules, rule, field, inst) {
  const v = rule.data?.[field] ?? rule.fns?.[field];
  if (typeof v !== 'function' && !isLive(v)) return v;
  const env = typeof rules.env === 'function' ? rules.env(rule) : {};
  // what it reads: the instance it names (a status's subject), else its place's; never one its mod may not read
  const named = rule.data?.subject ?? rule.fns?.subject;
  let target = named !== undefined ? (typeof env.resolve === 'function' ? env.resolve(named) : undefined) : inst;
  if (target && typeof env.may === 'function' && !env.may(target)) target = undefined;
  if (typeof v === 'function') return rules.guard(rule, v)(seenBy(target, rule.mod));
  return liveValue(v, target, env, Date.now());
}

// ---------------------------------------------------------------- live text (docs/design/public-hooks.md §3.13)
// A host-realm declaration's text follows its subject with no call per row: a string may hold `{{path}}` or `{{path|format}}`, a field
// may be `{bind: path, format?}`, and an entry of a list may carry `when` (a where on the subject). The page evaluates them from its
// replica, through the same paths and reader rules as a where (an unloaded or unreadable value is empty); the result is text only.
const TEMPLATE = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const liveScan = new WeakMap();
/** Does a declaration's data hold live text (a template, a bind or a when)? Scanned once per data object. */
export function isLive(v, depth = 0) {
  if (typeof v === 'string') return v.includes('{{');
  if (!v || typeof v !== 'object' || depth > 6) return false;
  if (depth === 0 && liveScan.has(v)) return liveScan.get(v);
  const out = Array.isArray(v) ? v.some((x) => isLive(x, depth + 1))
    : (typeof v.bind === 'string' || v.when !== undefined || Object.values(v).some((x) => isLive(x, depth + 1)));
  if (depth === 0) liveScan.set(v, out);
  return out;
}
const pad = (n) => String(n);
function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${pad(s % 60)}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${pad(m % 60)}m` : ''}`;
}
function relativeText(t, now) {
  const d = now - t, a = Math.abs(d);
  const unit = a < 60_000 ? null : a < 3_600_000 ? [Math.round(a / 60_000), 'm'] : a < 86_400_000 ? [Math.round(a / 3_600_000), 'h'] : [Math.round(a / 86_400_000), 'd'];
  if (!unit) return d >= 0 ? 'just now' : 'in a moment';
  return d >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}
const FORMATS = {
  number: (v) => (typeof v === 'number' ? v.toLocaleString() : ''),
  percent: (v) => (typeof v === 'number' ? `${Math.round(v <= 1 && v >= -1 ? v * 100 : v)}%` : ''),
  duration: (v) => (typeof v === 'number' ? durationText(v) : ''),
  relative: (v, now) => (typeof v === 'number' ? relativeText(v, now) : ''),
};
function asText(v, format, now) {
  if (v === undefined || v === null) return '';
  if (format && FORMATS[format]) return FORMATS[format](v, now);
  return typeof v === 'object' ? '' : String(v);
}
const whens = new WeakMap();
function holds(when, inst, env) {
  if (!isObj(when)) return false;
  if (!whens.has(when)) { let c; try { c = compileWhere(when); } catch { c = null; } whens.set(when, c); }
  const c = whens.get(when);
  return !!c && c.test(inst, env);
}
/** A declaration's data with its live text evaluated for one subject (functions and callback markers pass through). */
export function liveValue(v, inst, env, now, depth = 0) {
  if (depth > 6) return v;
  if (typeof v === 'string') return v.includes('{{') ? v.replace(TEMPLATE, (_, path, format) => asText(readPath(inst, path, env), format, now)) : v;
  if (Array.isArray(v)) return v.filter((x) => !isObj(x) || x.when === undefined || holds(x.when, inst, env)).map((x) => liveValue(x, inst, env, now, depth + 1));
  if (isObj(v)) {
    if (typeof v.bind === 'string' && Object.keys(v).every((k) => k === 'bind' || k === 'format')) return asText(readPath(inst, v.bind, env), v.format, now);
    if (depth === 0 && v.when !== undefined && !holds(v.when, inst, env)) return undefined;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'when') continue;
      out[k] = typeof x === 'function' || k === '$fn' ? x : liveValue(x, inst, env, now, depth + 1);
    }
    return out;
  }
  return v;
}
/**
 * The app's own entries of one slot with the part rules applied (public-hooks.md §3.10), for a binding whose slot is a list: `items` the
 * app's entries, `partOf(item)` an entry's part name (or null: not a named part, left as it is), `relabel(item, {label, icon, tooltip},
 * rule)` an entry relabelled. Hide drops the named entries; a decoration relabels them (the first rule in order wins); a reorder puts the
 * named ones first, in its order, the others after as they were. Returns the items unchanged when no rule applies.
 */
export function applyParts(rules, slot, items, partOf, relabel) {
  if (!Array.isArray(items) || !rules.length) return items;
  const mine = rules.filter((r) => (r.slot === undefined || r.slot === slot));
  if (!mine.length) return items;
  const hidden = new Set(), labels = new Map();
  for (const r of mine) {
    const names = r.part ?? [];
    if (r.kind === 'hide') for (const n of names) hidden.add(n);
    else if (r.kind === 'decorate') for (const n of names) if (!labels.has(n)) labels.set(n, r);
  }
  let out = items.filter((x) => !hidden.has(partOf(x)));
  if (labels.size && typeof relabel === 'function') {
    out = out.map((x) => { const r = labels.get(partOf(x)); return r ? relabel(x, { label: r.data?.label, icon: r.data?.icon, tooltip: r.data?.tooltip }, r) : x; });
  }
  for (const r of mine) {
    if (r.kind !== 'reorder' || !Array.isArray(r.data?.order)) continue;
    const order = r.data.order;
    const first = [];
    for (const n of order) for (const x of out) if (partOf(x) === n && !first.includes(x)) first.push(x);
    out = [...first, ...out.filter((x) => !first.includes(x))];
  }
  return out;
}

/** Does a declaration's data show a relative time (it is drawn again each minute)? */
export const hasRelative = (data) => !!data && /\|\s*relative\b|"format":"relative"/.test(JSON.stringify(data));

/** A list slot's entries: the rules' items in order after the app's `native` count, within the budget; the rest is reported dropped. */
export function budgeted(items, native, budget) {
  if (!Number.isFinite(budget)) return { kept: items, dropped: [] };
  const room = Math.max(0, budget - native);
  return { kept: items.slice(0, room), dropped: items.slice(room) };
}

/** One error boundary class per React: a mod's node that throws renders nothing and counts for its mod (and trips its rule). */
const boundaries = new WeakMap();
export function boundaryOf(R, rules) {
  let byRules = boundaries.get(R);
  if (!byRules) boundaries.set(R, (byRules = new WeakMap()));
  let B = byRules.get(rules);
  if (!B) {
    B = class CodexmodsRuleBoundary extends R.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { rules.trip(this.props.rule, error); } catch { /* reporting must not throw */ } }
      // what it draws is its mod's: the kit's and the lent parts' controls in it attest the user's input for that mod (graph-integrity G7.1)
      render() {
        if (this.state.failed) return null;
        const M = modContextOf(R);
        return M && typeof this.props.rule?.mod === 'string' ? R.createElement(M.Provider, { value: this.props.rule.mod }, this.props.children) : this.props.children;
      }
    };
    byRules.set(rules, B);
  }
  return B;
}
