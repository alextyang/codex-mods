// Small pure helpers shared by the mux modules.
import { CodexModsError } from '../../../sdk/errors.mjs';

export const KINDS = Object.freeze(['clientRequest', 'clientNotification', 'serverResponse', 'serverNotification', 'serverRequest', 'clientResponse']);

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const hasId = (m) => m.id !== undefined && m.id !== null;
export const isResponseShape = (m) => hasId(m) && m.method === undefined && ('result' in m || 'error' in m);

const deepFrozen = new WeakSet();
/** Freeze `root` and everything below it, in place, iteratively (frames can be deep and 16 MB). */
export function deepFreeze(root) {
  if (root === null || typeof root !== 'object' || deepFrozen.has(root)) return root;
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (deepFrozen.has(o)) continue;
    deepFrozen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v !== null && typeof v === 'object' && !deepFrozen.has(v)) stack.push(v);
    }
    Object.freeze(o);
  }
  return root;
}

export function compilePaths(paths) { return (paths ?? []).map((p) => p.split('.')); }
export function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}
/** First non-empty string found at any of the compiled paths. */
export function extractKey(msg, compiled) {
  for (const parts of compiled) {
    const v = getPath(msg, parts);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Does `allowed` (absent | '*' | patterns) cover `pattern` (an exact method, a prefix ending in '/', or '*')? */
export function covers(allowed, pattern) {
  if (allowed === undefined || allowed === '*') return true;
  if (pattern === '*') return false;
  for (const a of allowed) {
    if (a === '*' || a === pattern) return true;
    if (a.endsWith('/') && pattern.startsWith(a)) return true;
  }
  return false;
}
export function assertAllowed(allowed, patterns, what) {
  const list = patterns === '*' ? ['*'] : patterns;
  for (const p of list) {
    if (!covers(allowed, p)) throw new CodexModsError('Denied', `${what} '${p}' is not permitted`);
  }
}

export function rpcError(code, message, data) { return data === undefined ? { code, message } : { code, message, data }; }
/** JSON-RPC error object for a failure the mux itself produced. */
export function rpcErrorFor(err) {
  const code = err instanceof CodexModsError ? err.code : 'Unavailable';
  return rpcError(-32000, err.message, { codexmods: code });
}
/** A server's JSON-RPC error, surfaced to a mod as a CodexModsError (see report: contract question). */
export function errorFromRpc(e) {
  return new CodexModsError('Invalid', e?.message ?? 'app-server error', { rpcError: { code: e?.code ?? -32603, message: e?.message ?? '', ...(e?.data === undefined ? {} : { data: e.data }) } });
}
