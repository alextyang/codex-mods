// Interceptor registry (method-indexed lookup) and chain runner (ARCHITECTURE §6.4, requirement 6).
import { deepFreeze, isObject, hasId } from './util.mjs';
import { hostDeadline } from '../deadline.mjs';

export const EMPTY = Object.freeze([]);
const MAX_CACHE = 2048;

export function createRegistry() {
  const byKind = new Map(); // kind -> {exact:Map<method,Reg[]>, prefix:{p,reg}[], all:Reg[], count}
  let cache = new Map();
  const slot = (kind) => {
    let s = byKind.get(kind);
    if (!s) byKind.set(kind, (s = { exact: new Map(), prefix: [], all: [], count: 0 }));
    return s;
  };
  const cmp = (a, b) => (b.priority - a.priority) || (a.client.rank < b.client.rank ? -1 : a.client.rank > b.client.rank ? 1 : 0) || (a.seq - b.seq);
  return {
    add(reg) {
      const s = slot(reg.kind);
      s.count++;
      if (reg.methods === '*') s.all.push(reg);
      else for (const m of reg.methods) {
        if (m.endsWith('/')) s.prefix.push({ p: m, reg });
        else { const l = s.exact.get(m); if (l) l.push(reg); else s.exact.set(m, [reg]); }
      }
      cache = new Map();
    },
    remove(reg) {
      const s = byKind.get(reg.kind);
      if (!s) return;
      s.count--;
      s.all = s.all.filter((r) => r !== reg);
      s.prefix = s.prefix.filter((e) => e.reg !== reg);
      for (const [m, l] of s.exact) { const n = l.filter((r) => r !== reg); if (n.length) s.exact.set(m, n); else s.exact.delete(m); }
      cache = new Map();
    },
    invalidate() { cache = new Map(); },
    has(kind) { return (byKind.get(kind)?.count ?? 0) > 0; },
    /** Sorted handlers whose patterns match `method`. Zero allocation when nothing is registered for the kind. */
    lookup(kind, method) {
      const s = byKind.get(kind);
      if (!s || s.count === 0) return EMPTY;
      const ck = kind + '\0' + method;
      const hit = cache.get(ck);
      if (hit) return hit;
      const set = new Set(s.all);
      const ex = s.exact.get(method);
      if (ex) for (const r of ex) set.add(r);
      for (const e of s.prefix) if (method.startsWith(e.p)) set.add(e.reg);
      const list = set.size ? [...set].sort(cmp) : EMPTY;
      if (cache.size >= MAX_CACHE) cache = new Map();
      cache.set(ck, list);
      return list;
    },
  };
}

const jsonRpcErr = (e) => isObject(e) && typeof e.code === 'number' && typeof e.message === 'string';

/** Returns an error message, or null when `repl` is a valid replacement for `cur` of this kind. */
export function validateReplace(kind, cur, repl) {
  if (!isObject(repl)) return 'replace must be an object';
  if (repl.id !== cur.id) return 'replace may not change the id';
  if (repl.params !== undefined && repl.params !== null && typeof repl.params !== 'object') return 'params must be structured';
  switch (kind) {
    case 'clientRequest': case 'serverRequest':
      if (typeof repl.method !== 'string' || !repl.method) return 'request needs a method';
      if (kind === 'serverRequest' && repl.method !== cur.method) return 'method may change only on clientRequest';
      if (!hasId(repl)) return 'request needs an id';
      if ('result' in repl || 'error' in repl) return 'request may not carry result/error';
      return null;
    case 'clientNotification': case 'serverNotification':
      if (typeof repl.method !== 'string' || repl.method !== cur.method) return 'method may change only on clientRequest';
      if (repl.id !== undefined) return 'notification may not carry an id';
      if ('result' in repl || 'error' in repl) return 'notification may not carry result/error';
      return null;
    default: // responses
      if (repl.method !== undefined) return 'response may not carry a method';
      if (!hasId(repl)) return 'response needs an id';
      if ('result' in repl === 'error' in repl) return 'response needs exactly one of result/error';
      if ('error' in repl && !jsonRpcErr(repl.error)) return 'malformed error';
      return null;
  }
}

const RESULT_KINDS = {
  replace: null, // every kind
  drop: ['clientNotification', 'serverNotification'],
  respond: ['clientRequest', 'serverRequest'],
  route: ['clientRequest'],
  defer: ['serverRequest', 'clientRequest'],   // take the request out of the stream; the mux issues a token (G-defer; mux addition 5 for client requests)
};

/**
 * Chain runner. Synchronous handlers complete synchronously (no promise on the hot path).
 * run({regs, msg, kind, skipClient, infoFor(reg), done}) -> done({type:'pass',msg,route?} | {type:'drop'} |
 *   {type:'respond',respond} | {type:'defer',by,reg,msg,route?,info} | {type:'reject',by,message}).
 * A defer carries the message as the deferring handler saw it, the route an earlier handler chose (a clientRequest released later
 * continues as if the chain had passed it) and the info that handler was given.
 */
export function createChain({ onCall, onFault, resolveRoute, onInternalError }) {
  return function run({ regs, msg, kind, skipClient, infoFor, done }) {
    let i = 0, cur = msg, route, info;
    deepFreeze(cur);

    const fail = (reg, faultKind, message) => {
      onFault(reg, faultKind, message);
      return reg.onError === 'reject' ? { type: 'reject', by: reg.client.id, message } : undefined;
    };

    /** Returns a terminal result, or undefined to continue the chain. */
    const apply = (reg, out) => {
      if (out === undefined || out === null) return undefined;
      if (!isObject(out)) return fail(reg, 'invalid', 'handler result must be an object');
      const keys = Object.keys(out);
      if (keys.length !== 1 || !(keys[0] in RESULT_KINDS)) return fail(reg, 'invalid', 'unrecognized handler result');
      const k = keys[0];
      const allowed = RESULT_KINDS[k];
      if (allowed && !allowed.includes(kind)) return fail(reg, 'invalid', `'${k}' is not allowed on ${kind}`);
      switch (k) {
        case 'replace': {
          const bad = validateReplace(kind, cur, out.replace);
          if (bad) return fail(reg, 'invalid', bad);
          cur = deepFreeze(out.replace);
          return undefined;
        }
        case 'drop':
          if (out.drop !== true) return fail(reg, 'invalid', 'drop must be true');
          return { type: 'drop' };
        case 'defer': {
          if (out.defer !== true) return fail(reg, 'invalid', 'defer must be true');
          // The framework's own clients (no restriction) hold requests this way; a mod's never does (graph-integrity G6.4: it stops an app
          // action through the graph, or answers a request later through its instance)
          if (reg.client.allowed && reg.client.allowed.defer !== true) return fail(reg, 'invalid', 'a mod does not defer requests: stop the action through the graph, or answer the request later');
          return { type: 'defer', by: reg.client.id, reg, msg: cur, route, info };
        }
        case 'respond': {
          const r = out.respond;
          if (!isObject(r)) return fail(reg, 'invalid', 'respond must be an object');
          const hasRes = 'result' in r && r.result !== undefined, hasErr = 'error' in r;
          if (hasRes === hasErr || Object.keys(r).length !== 1) return fail(reg, 'invalid', 'respond needs exactly one of result/error');
          if (hasErr && !jsonRpcErr(r.error)) return fail(reg, 'invalid', 'malformed error');
          return { type: 'respond', respond: r };
        }
        case 'route': {
          let backend;
          try { backend = resolveRoute(reg, out.route); } catch (e) { return fail(reg, 'invalid', e.message); }
          route = backend;
          return undefined;
        }
      }
      return undefined;
    };

    const finish = (r) => { try { done(r); } catch (e) { onInternalError(e); } };

    const step = () => {
      for (;;) {
        if (i >= regs.length) return finish({ type: 'pass', msg: cur, route });
        const reg = regs[i++];
        if (reg.disposed || (skipClient && reg.client === skipClient)) continue;
        onCall(reg);
        let out;
        try { info = infoFor(reg); out = reg.handler(cur, info); }
        catch (e) { const t = fail(reg, 'throw', String(e?.message ?? e)); if (t) return finish(t); continue; }
        if (out && typeof out.then === 'function') return waitAsync(reg, out);
        const t = apply(reg, out);
        if (t) return finish(t);
      }
    };

    const waitAsync = (reg, p) => {
      let settled = false;
      // On the Host's own time: a stall of the Host is not the handler's, and a reply queued behind the timer settles first.
      const deadline = hostDeadline(reg.timeoutMs, () => {
        if (settled) return;
        settled = true;
        const t = fail(reg, 'timeout', `handler exceeded ${reg.timeoutMs} ms`);
        if (t) return finish(t);
        resume();
      });
      p.then((v) => {
        if (settled) return; // late result after a timeout: discarded
        settled = true; deadline.stop();
        const t = apply(reg, v);
        if (t) return finish(t);
        resume();
      }, (e) => {
        if (settled) return;
        settled = true; deadline.stop();
        const t = fail(reg, 'throw', String(e?.message ?? e));
        if (t) return finish(t);
        resume();
      });
    };
    const resume = () => { try { step(); } catch (e) { onInternalError(e); } };
    step();
  };
}
