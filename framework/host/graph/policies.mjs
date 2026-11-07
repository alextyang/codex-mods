// A mod's policies (docs/design/public-hooks.md §3.7): declarative rules the Host runs on every call of an operation, without the mod's
// worker. A policy names the operation (`on: {type, operation}`), which calls it is about (`where` on the instance, `args` by index,
// `origin`, `schedule`) and what it does (`then`): refuse the call with a reason, or ask the user first. It binds every caller but the
// framework, the declaring mod included; the user can turn each one off on its mod's page. A `where` that cannot be decided now (a relation
// not loaded) follows `unknown` (refuse by default). A request policy (`on: {request: Type}`) answers a request before the user is asked
// (`then.answer`: approve once or for the chat, deny, or a question's answer), as its mod's own call (`automatic`: the automatic action it
// names). A rewriting policy (`then.rewrite`) sets argument paths or adds content at either end, before the interceptors; the call keeps
// its origin, records the policy's mod as having changed it, and is authorized as that mod's. Node built-ins only.
import { compileWhere } from '../../shared/where.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ORIGINS = new Set(['user', 'mod', 'agent', 'app', 'any']);
const KEYS = new Set(['id', 'title', 'on', 'where', 'args', 'origin', 'schedule', 'unknown', 'then', 'automatic']);
export const POLICIES_MAX = 64;   // per mod
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (message) => Object.assign(new Error(message), { code: 'Invalid' });

/**
 * A policy as given, checked and compiled: `{id, title, type, operation, request, where, args: [[index, compiled]], origin, schedule,
 * unknown, then, automatic}`. `typeOf(id)` is the type's reflection (null when not registered); `isA(id, other)` whether a type is
 * another or a subtype of it. Throws Invalid with the reason.
 */
export function compilePolicy(spec, typeOf, isA = () => false) {
  if (!isObj(spec)) throw invalid('a policy is an object');
  const extra = Object.keys(spec).find((k) => !KEYS.has(k));
  if (extra) throw invalid(`${extra} is not a field of a policy`);
  if (typeof spec.id !== 'string' || !ID.test(spec.id)) throw invalid('id is 1-64 lowercase letters, digits and "-"');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 100) throw invalid('title says in at most 100 characters what the policy does');
  if (!isObj(spec.on)) throw invalid('on is {type, operation} or {request}');
  if (spec.automatic !== undefined && (typeof spec.automatic !== 'string' || !ID.test(spec.automatic))) throw invalid('automatic names one of the mod\'s automatic actions');
  if (spec.on.request !== undefined) return requestPolicy(spec, typeOf, isA);
  const t = typeof spec.on.type === 'string' ? typeOf(spec.on.type) : null;
  if (!t) throw invalid(`on.type ${JSON.stringify(spec.on.type)} is not a type of the graph`);
  const ops = t.members?.operations;
  const has = typeof spec.on.operation === 'string' && (ops instanceof Map ? ops.has(spec.on.operation) : Boolean(ops?.[spec.on.operation]));
  if (!has) throw invalid(`${spec.on.type} has no operation ${JSON.stringify(spec.on.operation)}`);
  const where = spec.where === undefined ? null : compiled(spec.where, 'where');
  const args = [];
  if (spec.args !== undefined) {
    if (!isObj(spec.args)) throw invalid('args maps argument indexes ("0") to wheres');
    for (const [k, w] of Object.entries(spec.args)) {
      if (!/^[0-9]$/.test(k)) throw invalid(`args: "${k}" is not an argument index`);
      const bare = isBareWhere(w);
      args.push([Number(k), compiled(bare ? { value: w } : w, `args.${k}`), bare]);
    }
  }
  const origin = spec.origin ?? 'any';
  if (!ORIGINS.has(origin)) throw invalid('origin is user, mod, agent, app or any');
  const schedule = spec.schedule === undefined ? null : scheduleOf(spec.schedule);
  const unknown = spec.unknown ?? 'refuse';
  if (unknown !== 'refuse' && unknown !== 'allow') throw invalid('unknown is refuse or allow');
  const then = thenOf(spec.then);
  return Object.freeze({ id: spec.id, title: spec.title.trim(), type: spec.on.type, operation: spec.on.operation, request: false, where, args, origin, schedule, unknown, then,
    automatic: spec.automatic ?? null, spec: structuredClone(spec) });
}
/** A request policy: the request type (Request or a subtype), which requests (`where`, `schedule`), and its answer. */
function requestPolicy(spec, typeOf, isA) {
  const type = spec.on.request;
  if (typeof type !== 'string' || !typeOf(type) || !isA(type, 'Request')) throw invalid(`on.request ${JSON.stringify(type)} is not a request type`);
  if (Object.keys(spec.on).length !== 1) throw invalid('on is {request} alone');
  for (const k of ['args', 'origin']) if (spec[k] !== undefined) throw invalid(`a request policy has no ${k}`);
  // an approval is never given on a guess: a request policy answers only when its where is known to hold
  if (spec.unknown !== undefined) throw invalid('a request policy answers only when its where is known (it has no unknown)');
  const where = spec.where === undefined ? null : compiled(spec.where, 'where');
  const schedule = spec.schedule === undefined ? null : scheduleOf(spec.schedule);
  const a = isObj(spec.then) && Object.keys(spec.then).length === 1 ? spec.then.answer : undefined;
  if (!isObj(a)) throw invalid('a request policy\'s then is {answer: {approve: "once" | "thread"} | {deny: true} | {answers: {<prompt id>: {choices?, text?}}}}');
  let answer;
  // an approval's answer names one of the request's options by what it does (graph-integrity G1.6): the provider's own option of that kind
  if (a.approve !== undefined) {
    if (a.approve !== 'once' && a.approve !== 'thread') throw invalid('then.answer.approve is once or thread ("always" stays the user\'s)');
    answer = { approve: a.approve };
  } else if (a.deny !== undefined) {
    if (a.deny !== true) throw invalid('then.answer.deny is true');
    answer = { deny: true };
  } else if (a.answers !== undefined) {
    if (!isObj(a.answers) || !Object.keys(a.answers).length || Object.keys(a.answers).length > 20) throw invalid('then.answer.answers is {<prompt id>: {choices?, text?}} (1 to 20 prompts)');
    for (const [id, x] of Object.entries(a.answers)) {
      if (!isObj(x)) throw invalid(`then.answer.answers.${id} is {choices?, text?}`);
      if (x.choices !== undefined && (!Array.isArray(x.choices) || x.choices.some((c) => typeof c !== 'string'))) throw invalid(`then.answer.answers.${id}.choices is a list of choice ids`);
      if (x.text !== undefined && (typeof x.text !== 'string' || x.text.length > 4000)) throw invalid(`then.answer.answers.${id}.text is at most 4000 characters`);
      if (x.choices === undefined && x.text === undefined) throw invalid(`then.answer.answers.${id} gives choices or text`);
    }
    answer = { answers: structuredClone(a.answers) };
  } else throw invalid('then.answer approves, denies, or answers per prompt');
  return Object.freeze({ id: spec.id, title: spec.title.trim(), type, operation: 'ask', request: true, where, args: [], origin: 'any', schedule, unknown: 'refuse',
    then: Object.freeze({ answer: Object.freeze(answer) }), automatic: spec.automatic ?? null, spec: structuredClone(spec) });
}
function compiled(w, at) {
  if (!isObj(w)) throw invalid(`${at} is a where (an object)`);
  try { return compileWhere(w); } catch (e) { throw invalid(`${at}: ${e?.message ?? e}`); }
}
function scheduleOf(s) {
  if (!isObj(s) || !Array.isArray(s.between) || s.between.length !== 2 || !s.between.every((x) => typeof x === 'string' && HHMM.test(x))) throw invalid('schedule.between is ["hh:mm", "hh:mm"]');
  let days = null;
  if (s.days !== undefined) {
    if (!Array.isArray(s.days) || !s.days.length) throw invalid('schedule.days is a list of days ("mon" ... "sun")');
    days = new Set(s.days.map((d) => { const i = DAYS.indexOf(String(d).toLowerCase()); if (i < 0) throw invalid(`schedule.days: "${d}" is not a day`); return i; }));
  }
  const min = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
  return { from: min(s.between[0]), to: min(s.between[1]), days };
}
function thenOf(then) {
  if (!isObj(then) || Object.keys(then).length !== 1) throw invalid('then is one of {refuse: reason} or {ask: {title, message}}');
  if (then.refuse !== undefined) {
    if (typeof then.refuse !== 'string' || !then.refuse.trim() || then.refuse.length > 300) throw invalid('then.refuse is the reason the user reads (at most 300 characters)');
    return Object.freeze({ refuse: then.refuse.trim() });
  }
  if (then.ask !== undefined) {
    const a = then.ask;
    if (!isObj(a) || typeof a.title !== 'string' || !a.title.trim() || a.title.length > 200) throw invalid('then.ask.title is the question (at most 200 characters)');
    if (a.message !== undefined && (typeof a.message !== 'string' || a.message.length > 900)) throw invalid('then.ask.message is at most 900 characters');
    return Object.freeze({ ask: Object.freeze({ title: a.title.trim(), message: typeof a.message === 'string' ? a.message.trim() : '' }) });
  }
  if (then.answer !== undefined) throw invalid('then.answer is a request policy\'s (on: {request})');
  if (then.rewrite !== undefined) return Object.freeze({ rewrite: rewriteOf(then.rewrite) });
  throw invalid('then is one of {refuse: reason} or {ask: {title, message}}');
}
const PATH = /^[0-9](\.[A-Za-z0-9_$-]{1,64}){0,6}$/;
// a field name that is an object's own machinery, never a field of an argument (a rewrite never reaches a prototype)
const RESERVED_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const isContent = (c) => isObj(c) && Array.isArray(c.parts) && c.parts.length > 0 && c.parts.length <= 64 && c.parts.every(isObj);
/** A rewrite: `args` sets values at paths (`"1.settings.effort"`: argument 1, then fields); `prepend` / `append` add content parts. */
function rewriteOf(r) {
  if (!isObj(r) || !Object.keys(r).length || Object.keys(r).some((k) => !['args', 'prepend', 'append'].includes(k))) throw invalid('then.rewrite is {args?, prepend?, append?}');
  const sets = [];
  if (r.args !== undefined) {
    if (!isObj(r.args) || !Object.keys(r.args).length) throw invalid('then.rewrite.args maps paths ("1.settings.effort") to values');
    for (const [path, value] of Object.entries(r.args)) {
      if (!PATH.test(path) || path.split('.').some((x) => RESERVED_FIELDS.has(x))) throw invalid(`then.rewrite.args: "${path}" is not a path (an argument index, then fields)`);
      if (JSON.stringify(value) === undefined || JSON.stringify(value).length > 4096) throw invalid(`then.rewrite.args.${path} is a JSON value of at most 4 KB`);
      sets.push([path.split('.'), structuredClone(value)]);
    }
  }
  for (const k of ['prepend', 'append']) if (r[k] !== undefined && !isContent(r[k])) throw invalid(`then.rewrite.${k} is content ({parts: [...]})`);
  return Object.freeze({ sets, prepend: r.prepend ? structuredClone(r.prepend) : null, append: r.append ? structuredClone(r.append) : null });
}

/**
 * A call's arguments as a rewrite leaves them (a copy): its paths set (missing objects made on the way), its content (the first argument
 * that is content) with parts added at either end. Null when nothing applies (no content to add to, a path through a non-object).
 */
export function rewriteArgs(rw, args) {
  const out = structuredClone(Array.isArray(args) ? args : []);
  let changed = false;
  for (const [segs, value] of rw.sets) {
    const i = Number(segs[0]);
    if (segs.length === 1) { out[i] = structuredClone(value); changed = true; continue; }
    if (out[i] === undefined) out[i] = {};
    let cur = out[i];
    if (!isObj(cur)) return null;
    // own fields only, each made a plain field (never a setter or an inherited object)
    for (const seg of segs.slice(1, -1)) {
      if (RESERVED_FIELDS.has(seg)) return null;
      if (!Object.hasOwn(cur, seg)) Object.defineProperty(cur, seg, { value: {}, enumerable: true, writable: true, configurable: true });
      if (!isObj(cur[seg])) return null;
      cur = cur[seg];
    }
    if (RESERVED_FIELDS.has(segs.at(-1))) return null;
    Object.defineProperty(cur, segs.at(-1), { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    changed = true;
  }
  if (rw.prepend || rw.append) {
    const c = out.findIndex((a) => isObj(a) && Array.isArray(a.parts));
    if (c < 0) return null;
    out[c] = { ...out[c], parts: [...(rw.prepend?.parts ?? []), ...out[c].parts, ...(rw.append?.parts ?? [])] };
    changed = true;
  }
  return changed ? out : null;
}

/** Whether `date` (local time) is inside a policy's schedule: `between` wraps past midnight when its end is before its start. */
export function inSchedule(schedule, date) {
  if (!schedule) return true;
  const m = date.getHours() * 60 + date.getMinutes();
  const inside = schedule.from <= schedule.to ? m >= schedule.from && m < schedule.to : m >= schedule.from || m < schedule.to;
  if (!inside) return false;
  // a span past midnight belongs to the day it started
  const day = schedule.from > schedule.to && m < schedule.to ? (date.getDay() + 6) % 7 : date.getDay();
  return !schedule.days || schedule.days.has(day);
}

/** Whether a caller is one a policy's `origin` is about: the user's own action, a mod's call, the agent's; the framework is never bound. */
export function originMatches(origin, caller) {
  if (origin === 'request') return true;   // a request policy: the request the agent opened, whoever shows it
  if (!caller || caller.kind === 'framework' || caller.kind === 'native') return false;
  return origin === 'any' || origin === caller.kind;
}

/** Bare operators (`{$eq: 'x'}`, `{$prefix: 'tmp'}`) are about an argument's own value (a name, a scope): its where reads it as `value`. */
export function isBareWhere(w) {
  return isObj(w) && Object.keys(w).length > 0 && Object.keys(w).every((x) => x.startsWith('$') && x !== '$or' && x !== '$not');
}
// What a where on a plain value reads: its fields as the fields of an instance of no type (no relations, no attached data)
const VALUE_REF = Object.freeze({ type: '', provider: '', id: '' });
const isRefShape = (v) => isObj(v) && typeof v.type === 'string' && typeof v.provider === 'string' && typeof v.id === 'string';
/**
 * The root an argument's where is evaluated on: an argument that is a ref is its instance (`resolve(ref)`: null when it is not known or
 * not readable by the where's reader), a bare where's argument is `{value}`, any other value its own fields (left out: none).
 */
export function argRoot(v, bare, resolve) {
  if (bare) return Object.freeze({ ref: VALUE_REF, state: { value: v } });
  if (isRefShape(v)) return resolve(v) ?? null;
  return Object.freeze({ ref: VALUE_REF, state: isObj(v) ? v : v === undefined ? {} : { value: v } });
}

/**
 * Whether a policy is about this call: true, false, or 'unknown' (a where that cannot be decided now). `env` reads relations and attached
 * data as the policy's mod reads them; `resolve(ref)` gives an argument's instance, null when that mod may not read it.
 */
export function policyMatches(p, { inst, args, caller, date, env, resolve }) {
  if (!originMatches(p.request ? 'request' : p.origin, caller) || !inSchedule(p.schedule, date)) return false;
  let unknown = false;
  const test = (w, x) => {
    const r = w.evaluate(x, env);
    if (r === 'unknown') unknown = true;
    return r === true;
  };
  if (p.where && !test(p.where, inst) && !unknown) return false;
  for (const [i, w, bare] of p.args) {
    const x = argRoot(args[i], bare, resolve);
    if (x === null) { unknown = true; continue; }
    if (!test(w, x) && !unknown) return false;
  }
  return unknown ? 'unknown' : true;
}
