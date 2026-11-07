// ctx.appServer (+ .backends, .clients) → the mod's MuxClient. Permission checks use InstalledMod.record.grants; the Mux
// enforces the same restriction again through the allowedMethods it was given at client creation.
import { admit } from './permissions.mjs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { requireGrant, requireMethods } from './grants.mjs';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = new Set(['clientRequest', 'clientNotification', 'serverResponse', 'serverNotification', 'serverRequest', 'clientResponse']);
const MAX_DEADLINE_MS = 30000;
const DEFAULT_DEADLINE_MS = 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function checkMethod(m) { if (typeof m !== 'string' || !m) throw new CodexModsError('Invalid', 'method must be a non-empty string'); return m; }
function checkKey(key) { if (typeof key !== 'string' || !KEY_RE.test(key)) throw new CodexModsError('Invalid', 'backend key must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}'); return key; }
const mux = (scope) => {
  if (!scope.state.mux) throw new CodexModsError('Unavailable', 'the app-server client is not available');
  return scope.state.mux;
};

/** A mod's request options, as the SDK defines them (sdk/index.d.ts): only `backend` and, for a request, `timeoutMs`. Anything else (the
 *  graph `intent` an operation passes so the mux does not claim it again) is internal and never taken from a mod. */
function modOptions(opts, { timeout = true } = {}) {
  if (!isObject(opts)) return {};
  const out = {};
  if (typeof opts.backend === 'string') out.backend = opts.backend;
  if (timeout && opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
  return out;
}

function stripOwner(key, owner) { return typeof key === 'string' && key.startsWith(`${owner}/`) ? key.slice(owner.length + 1) : key; }

export function createAppServerNs({ permissions = () => null } = {}) {
  // a request under an optional grant the user set to ask every time waits for their answer (framework-ui.md F8)
  const guard = (scope, method) => admit(scope, permissions, (grants) => requireMethods(grants, 'appServer.request', method), `send ${method} to Codex`);
  return {
    calls: {
      async request(scope, method, params, opts) {
        checkMethod(method);
        await guard(scope, method);
        return mux(scope).request(method, params === null ? undefined : params, modOptions(opts));
      },
      async notify(scope, method, params, opts) {
        checkMethod(method);
        await guard(scope, method);
        mux(scope).notify(method, params === null ? undefined : params, modOptions(opts, { timeout: false }));
      },
    },
    subs: {
      observe(scope, [filter, opts], emit) {
        const f = isObject(filter) ? filter : {};
        if (f.methods !== undefined && f.methods !== '*' && !(Array.isArray(f.methods) && f.methods.every((m) => typeof m === 'string'))) {
          throw new CodexModsError('Invalid', 'filter.methods must be "*" or a list of strings');
        }
        requireMethods(scope.state.grants, 'appServer.observe', f.methods);
        const o = isObject(opts) ? opts : {};
        return mux(scope).observe(f, (message, info) => emit({ message, info }), { queue: o.queue, replay: o.replay });
      },
    },
    handlers: {
      intercept(scope, [kind, methods, opts], invoke) {
        if (scope.realm === 'renderer') throw new CodexModsError('Denied', 'renderer realms cannot intercept');
        if (!KINDS.has(kind)) throw new CodexModsError('Invalid', `unknown message kind ${kind}`);
        if (methods !== '*' && !(Array.isArray(methods) && methods.length > 0 && methods.every((m) => typeof m === 'string'))) {
          throw new CodexModsError('Invalid', 'methods must be "*" or a non-empty list of strings');
        }
        requireMethods(scope.state.grants, 'appServer.intercept', methods);
        const o = isObject(opts) ? opts : {};
        const deadline = Math.min(Math.max(Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_DEADLINE_MS, 1), MAX_DEADLINE_MS);
        const proxy = async (message, info) => {
          const r = await invoke([message, info], deadline);
          return r === null ? undefined : r;
        };
        return mux(scope).intercept(kind, methods, proxy, { ...o, timeoutMs: deadline });
      },
    },
  };
}

export function createBackendsNs({ muxGlobal }) {
  const homeOf = (state, key, codexHome) => {
    const rel = codexHome ?? key;
    if (typeof rel !== 'string' || !rel || isAbsolute(rel)) throw new CodexModsError('Invalid', 'codexHome must be a relative path');
    const abs = resolve(state.mod.backendsDir, rel);
    const back = relative(state.mod.backendsDir, abs);
    if (back === '' || back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) {
      throw new CodexModsError('Invalid', 'codexHome escapes the mod backends directory');
    }
    return abs;
  };
  return {
    calls: {
      async define(scope, key, def) {
        requireGrant(scope.state.grants, 'appServer.backends');
        checkKey(key);
        const d = isObject(def) ? def : {};
        const codexHome = homeOf(scope.state, key, d.codexHome);
        await mkdir(codexHome, { recursive: true, mode: 0o700 });
        scope.state.backendHomes.set(key, codexHome);
        await muxGlobal().defineBackend(scope.state.owner, key, { ...d, codexHome });
      },
      async remove(scope, key, opts) {
        requireGrant(scope.state.grants, 'appServer.backends');
        checkKey(key);
        await muxGlobal().removeBackend(scope.state.owner, key);
        if (isObject(opts) && opts.deleteData === true) {
          const home = scope.state.backendHomes.get(key) ?? homeOf(scope.state, key);
          await rm(home, { recursive: true, force: true });
        }
        scope.state.backendHomes.delete(key);
      },
      list(scope) {
        requireGrant(scope.state.grants, 'appServer.backends');
        return muxGlobal().listBackends(scope.state.owner).map((b) => ({ ...b, key: stripOwner(b.key, scope.state.owner) }));
      },
    },
  };
}

export function createClientsNs({ muxGlobal }) {
  return {
    calls: {
      issue(scope, opts) {
        requireGrant(scope.state.grants, 'appServer.clients');
        if (!isObject(opts) || typeof opts.name !== 'string' || !opts.name) throw new CodexModsError('Invalid', 'issue needs {name}');
        scope.state.effects = true;
        const lease = muxGlobal().issueLease(scope.state.owner, opts.name);
        scope.state.leases.add(lease.id);
        return lease;
      },
      revoke(scope, leaseId) {
        requireGrant(scope.state.grants, 'appServer.clients');
        if (!scope.state.leases.has(leaseId)) throw new CodexModsError('Denied', 'that lease was not issued to this mod');
        muxGlobal().revokeLease(leaseId);
        scope.state.leases.delete(leaseId);
      },
    },
  };
}
