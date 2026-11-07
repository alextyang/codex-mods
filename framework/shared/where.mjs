// One way to say which instances (docs/design/public-hooks.md §3.1): the `where` of rules, filters, sections, choices, policies, defaults,
// `list`, `query` and `subscribe`, evaluated the same way in the Host and in the page. A `where` maps paths to literals or operators:
//   path      a state field (`status`, `context.used`); a relation, then its target's path, at most three hops (`project.title`); a mod's
//             attached data (`@<modId>/<key>`, `@<modId>/<key>.<field>`)
//   operator  an object whose keys start with `$`: $eq $ne $in $nin $gt $gte $lt $lte $exists $contains $prefix $glob $matches $any $all;
//             any other value, objects included, is a literal compared by equality; $any and $all take a where over a many relation's
//             targets, or over the entries of a list of objects in the state (a Usage's limits: `{limits: {$any: {percent: {$gte: 80}}}}`)
//   combined  `$or: [where, ...]`, `$not: where`, beside the paths (all must hold)
// A path that cannot be resolved now (a relation's target not loaded) is unknown: it matches nothing but `{$exists: false}`, and
// `evaluate` says 'unknown' so a policy can decide it. A field the instance does not have is absent (known): `$exists: false` holds.
// An environment gives what the instance does not carry: env.relation(typeId, name) (is it a relation of that type), env.related(inst,
// name) (its target instance, a list of them, null for none, undefined when not known now) and env.attached(inst, modId) (that mod's
// value as the reader may see it, or undefined). NO NODE API (shared by the Host and the page).

import { compilePattern } from './bounded-pattern.mjs';

const OPS = new Set(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists', '$contains', '$prefix', '$glob', '$matches', '$any', '$all']);
const MAX_HOPS = 3;
const MAX_SEGMENTS = 8;
const MAX_NODES = 256;     // paths and operators in one where, nested ones included
const MAX_DEPTH = 4;       // nesting of $or, $not, $any, $all
const MAX_LIST = 256;      // values in $in, $nin, $or
const UNKNOWN = Symbol('unknown');
const ENTRY_REF = Object.freeze({ type: '', provider: '', id: '' });   // an entry of a state list, read as a record
const ABSENT = Symbol('absent');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (message) => Object.assign(new Error(message), { code: 'Invalid' });
const isOperator = (v) => isObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
const isInstance = (v) => isObject(v) && isObject(v.ref) && typeof v.ref.id === 'string';
const refOf = (v) => (isInstance(v) ? v.ref : isObject(v) && typeof v.id === 'string' && typeof v.provider === 'string' ? v : null);

/** Structural equality of JSON values; a ref equals an instance or ref with the same provider and id (and type, when both say it). */
function same(a, b) {
  const ra = refOf(a), rb = refOf(b);
  if (ra && rb) return ra.provider === rb.provider && ra.id === rb.id && (!ra.type || !rb.type || ra.type === rb.type || isInstance(a) || isInstance(b));
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return false;
}

/** A glob (`*` any run, `?` one character) as a bounded pattern. */
function globPattern(glob) {
  const src = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return compilePattern(`^${src}$`, '');
}

/** A path, parsed: an attached head (`@mod/key`) or none, then its segments. */
function parsePath(path) {
  if (typeof path !== 'string' || !path) throw invalid('a where path is a non-empty string');
  let attached = null, rest = path;
  if (path.startsWith('@')) {
    const slash = path.indexOf('/');
    if (slash < 2) throw invalid(`"${path}": an attached path is @<modId>/<key>`);
    const mod = path.slice(1, slash);
    const tail = path.slice(slash + 1).split('.');
    if (!tail[0] || tail.some((s) => !s)) throw invalid(`"${path}": an attached path is @<modId>/<key>[.<field>]`);
    attached = { mod, key: tail[0] };
    rest = tail.slice(1).join('.');
  }
  const segments = rest ? rest.split('.') : [];
  if (segments.some((s) => !s || s.startsWith('$'))) throw invalid(`"${path}": empty or operator segment`);
  if (segments.length > MAX_SEGMENTS) throw invalid(`"${path}": at most ${MAX_SEGMENTS} segments`);
  return { attached, segments };
}

/**
 * Compile a where; throws Invalid (code 'Invalid') on a malformed one. `{window: true}`: a presentation's where may also name the window it is shown in
 * (docs/design/layouts.md D5): a top-level `window: {mode?, layout?}`, read from `env.window()` (unknown without it, never the instance's fields). Anywhere
 * else it is refused: it would never hold.
 */
export function compileWhere(where, opts = {}) {
  let nodes = 0;
  const paths = new Map();   // each of its paths (its segments), the ones a $any or $all reads too: what it reads through
  let usesWindow = false;
  const count = () => { if (++nodes > MAX_NODES) throw invalid(`a where has at most ${MAX_NODES} parts`); };

  function compileOp(op, depth, path) {
    const tests = [];
    for (const [k, v] of Object.entries(op)) {
      count();
      if (!OPS.has(k)) throw invalid(`${path}: unknown operator ${k}`);
      switch (k) {
        case '$in': case '$nin': {
          if (!Array.isArray(v) || v.length > MAX_LIST) throw invalid(`${path}: ${k} takes a list (at most ${MAX_LIST})`);
          const list = v;
          tests.push(k === '$in' ? (x) => (x === UNKNOWN ? UNKNOWN : list.some((w) => same(x, w))) : (x) => (x === UNKNOWN ? UNKNOWN : !list.some((w) => same(x, w))));
          break;
        }
        case '$exists': {
          if (typeof v !== 'boolean') throw invalid(`${path}: $exists takes true or false`);
          tests.push((x) => (x === UNKNOWN ? (v ? UNKNOWN : true) : v === (x !== ABSENT && x !== null && x !== undefined)));
          break;
        }
        case '$gt': case '$gte': case '$lt': case '$lte': {
          if (typeof v !== 'number' && typeof v !== 'string') throw invalid(`${path}: ${k} takes a number or a string`);
          const cmp = { $gt: (a) => a > v, $gte: (a) => a >= v, $lt: (a) => a < v, $lte: (a) => a <= v }[k];
          tests.push((x) => (x === UNKNOWN ? UNKNOWN : typeof x === typeof v && cmp(x)));
          break;
        }
        case '$contains': tests.push((x) => (x === UNKNOWN ? UNKNOWN : typeof x === 'string' ? typeof v === 'string' && x.includes(v) : Array.isArray(x) && x.some((e) => same(e, v)))); break;
        case '$prefix': {
          if (typeof v !== 'string') throw invalid(`${path}: $prefix takes a string`);
          tests.push((x) => (x === UNKNOWN ? UNKNOWN : typeof x === 'string' && x.startsWith(v)));
          break;
        }
        case '$glob': case '$matches': {
          let spec;
          try {
            spec = k === '$glob' ? (typeof v === 'string' ? globPattern(v) : null)
              : typeof v === 'string' ? compilePattern(v, '') : isObject(v) && typeof v.pattern === 'string' ? compilePattern(v.pattern, typeof v.flags === 'string' ? v.flags : '') : null;
          } catch (e) { throw invalid(`${path}: ${k}: ${e?.message ?? e}`); }
          if (!spec) throw invalid(`${path}: ${k} takes a pattern`);
          tests.push((x) => (x === UNKNOWN ? UNKNOWN : typeof x === 'string' && spec.test(x)));
          break;
        }
        case '$any': case '$all': {
          if (depth >= MAX_DEPTH) throw invalid(`${path}: nested too deep`);
          const inner = compileNode(v, depth + 1);
          tests.push((x, env) => {
            if (x === UNKNOWN) return UNKNOWN;
            const items = Array.isArray(x) ? x : x === ABSENT || x === null || x === undefined ? [] : [x];
            let unknown = false;
            for (const item of items) {
              // a relation's target, or an entry of a list of objects in the state (a Usage's limits: its fields read as a record's); a
              // bare ref (an argument's, its instance not read) is not a record: unknown (built review H6m2b)
              const r = isInstance(item) ? inner(item, env) : isObject(item) && !refOf(item) ? inner({ ref: ENTRY_REF, state: item }, env) : UNKNOWN;
              if (r === UNKNOWN) unknown = true;
              else if (k === '$any' && r) return true;
              else if (k === '$all' && !r) return false;
            }
            return unknown ? UNKNOWN : k === '$all';
          });
          break;
        }
        case '$eq': tests.push((x) => (x === UNKNOWN ? UNKNOWN : same(x === ABSENT ? undefined : x, v))); break;
        case '$ne': tests.push((x) => (x === UNKNOWN ? UNKNOWN : !same(x === ABSENT ? undefined : x, v))); break;
      }
    }
    return (x, env) => and(tests.map((t) => () => t(x, env)));
  }

  function compileNode(w, depth) {
    if (!isObject(w)) throw invalid('a where is an object');
    const parts = [];
    for (const [k, v] of Object.entries(w)) {
      count();
      if (k === '$or') {
        if (!Array.isArray(v) || !v.length || v.length > MAX_LIST || depth >= MAX_DEPTH) throw invalid('$or takes a non-empty list of wheres');
        const alts = v.map((x) => compileNode(x, depth + 1));
        parts.push((inst, env) => or(alts.map((a) => () => a(inst, env))));
      } else if (k === '$not') {
        if (depth >= MAX_DEPTH) throw invalid('$not nested too deep');
        const inner = compileNode(v, depth + 1);
        parts.push((inst, env) => { const r = inner(inst, env); return r === UNKNOWN ? UNKNOWN : !r; });
      } else if (k.startsWith('$')) {
        throw invalid(`unknown combinator ${k}`);
      } else if (k === 'window' && isObject(v) && !isOperator(v)) {
        if (!opts.window || depth !== 0) throw invalid('window: the window\'s context is for a presentation\'s where, at its top');
        if (!Object.keys(v).length || Object.keys(v).some((x) => x !== 'mode' && x !== 'layout')) throw invalid('window: its context is {mode?, layout?}');
        const inner = compileNode(v, depth + 1);
        usesWindow = true;
        parts.push((inst, env) => { const w = typeof env.window === 'function' ? env.window() : undefined; return isObject(w) ? inner({ ref: ENTRY_REF, state: w }, env) : UNKNOWN; });
      } else {
        const p = parsePath(k);
        if (!p.attached && p.segments.length) paths.set(p.segments.join('.'), p.segments);
        const test = isOperator(v) ? compileOp(v, depth, k) : (x) => (x === UNKNOWN ? UNKNOWN : same(x === ABSENT ? undefined : x, v));
        parts.push((inst, env) => test(valueAt(inst, p, env), env));
      }
    }
    return (inst, env) => and(parts.map((f) => () => f(inst, env)));
  }

  const root = compileNode(where ?? {}, 0);
  return Object.freeze({
    /** Its paths, as their segments (a relation's name among them is a hop it reads through). */
    paths: Object.freeze([...paths.values()].map((x) => Object.freeze([...x]))),
    /** Does it read the window's context? */
    usesWindow,
    /** true, false or 'unknown'. */
    evaluate(inst, env = {}) { const r = root(inst, env); return r === UNKNOWN ? 'unknown' : r; },
    /** Does it hold (unknown does not)? */
    test(inst, env = {}) { return root(inst, env) === true; },
  });
}

function and(fns) { let unknown = false; for (const f of fns) { const r = f(); if (r === false) return false; if (r === UNKNOWN) unknown = true; } return unknown ? UNKNOWN : true; }
function or(fns) { let unknown = false; for (const f of fns) { const r = f(); if (r === true) return true; if (r === UNKNOWN) unknown = true; } return unknown ? UNKNOWN : false; }

/** The value a path reaches from an instance: a JSON value, an instance (or a list of them) for a relation, ABSENT or UNKNOWN. */
function valueAt(inst, { attached, segments }, env) {
  if (!isInstance(inst)) return UNKNOWN;
  let cur, hops = 0, i = 0;
  if (attached) {
    const all = typeof env.attached === 'function' ? env.attached(inst, attached.mod) : undefined;
    cur = isObject(all) && Object.hasOwn(all, attached.key) ? all[attached.key] : ABSENT;
  } else cur = inst;
  for (; i < segments.length; i++) {
    const seg = segments[i];
    if (cur === ABSENT || cur === null || cur === undefined) return ABSENT;
    if (isInstance(cur)) {
      const isRel = typeof env.relation === 'function' && env.relation(cur.ref.type, seg);
      if (isRel) {
        if (++hops > MAX_HOPS) return UNKNOWN;
        const r = typeof env.related === 'function' ? env.related(cur, seg) : undefined;
        if (r === undefined) return UNKNOWN;
        cur = r === null ? ABSENT : r;
        if (Array.isArray(cur) && i < segments.length - 1) return UNKNOWN;   // a path goes through one target, not a list ($any/$all do)
        continue;
      }
      const st = cur.state;
      cur = isObject(st) && Object.hasOwn(st, seg) ? st[seg] : ABSENT;
      continue;
    }
    if (isObject(cur)) { cur = Object.hasOwn(cur, seg) ? cur[seg] : ABSENT; continue; }
    return ABSENT;
  }
  return cur;
}

/** Check a where without an instance (at registration): throws Invalid with the reason. */
export function validateWhere(where, opts = {}) { compileWhere(where, opts); return true; }

/**
 * Does a rule's `of` (a ref or a list of refs) name this instance? Absent `of` names every instance. A ref's type, when it has one, is
 * the instance's type or one of its concepts (`chainOf(typeId)`: the type and its ancestors; without it, the same type).
 */
export function namesInstance(of, inst, chainOf = (t) => [t]) {
  if (of === undefined || of === null) return true;
  if (!isInstance(inst)) return false;
  const list = Array.isArray(of) ? of : [of];
  return list.some((r) => isObject(r) && r.provider === inst.ref.provider && r.id === inst.ref.id && (!r.type || chainOf(inst.ref.type).includes(r.type)));
}

/** Check a rule's `of`: a ref or a list of at most 1000 refs. */
export function validateOf(of) {
  if (of === undefined || of === null) return true;
  const list = Array.isArray(of) ? of : [of];
  if (list.length > 1000 || !list.every((r) => isObject(r) && typeof r.id === 'string' && typeof r.provider === 'string')) throw invalid('of is a ref {type?, provider, id} or a list of them (at most 1000)');
  return true;
}

/**
 * The value a path reaches from an instance (the grammar's paths), or undefined when absent or not known now; an instance reached
 * through a relation reads as its summary title. For live text (docs/design/public-hooks.md §3.13).
 */
export function readPath(inst, path, env = {}) {
  let p;
  try { p = parsePath(path); } catch { return undefined; }
  const v = valueAt(inst, p, env);
  if (v === ABSENT || v === UNKNOWN) return undefined;
  if (isInstance(v)) return typeof v.summary?.title === 'string' ? v.summary.title : undefined;
  if (Array.isArray(v) && v.some(isInstance)) return v.length;
  return v;
}
