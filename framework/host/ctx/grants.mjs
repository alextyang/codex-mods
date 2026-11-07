// Permission helpers: InstalledMod.record.grants (contracts/manifest.d.ts Permission) → checks and Mux allowedMethods.
import { CodexModsError } from '../../../sdk/errors.mjs';

/** True if the grants contain `name` bare or with a `:methods` suffix. */
export const hasGrant = (grants, name) => grants.some((g) => g === name || g.startsWith(`${name}:`));

/** Union of the method lists granted for `name`: '*' for a bare grant (or a '*' entry), else an array (empty if none). */
export function grantedMethods(grants, name) {
  const out = new Set();
  for (const g of grants) {
    if (g === name) return '*';
    if (!g.startsWith(`${name}:`)) continue;
    for (const m of g.slice(name.length + 1).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (m === '*') return '*';
      out.add(m);
    }
  }
  return [...out];
}

/** Derived Mux client restriction: appServer.intercept:a,b → intercept:['a','b']; bare → '*'; absent → [] (nothing). */
export function allowedMethodsFor(grants) {
  return {
    observe: grantedMethods(grants, 'appServer.observe'),
    request: grantedMethods(grants, 'appServer.request'),
    intercept: grantedMethods(grants, 'appServer.intercept'),
    // no mod defers a request (graph-integrity G6.4: the mux's defer is the framework's own holds; a mod stops an app's action through the
    // graph, or answers a request later through its instance)
    defer: false,
  };
}

/** `pattern` is a method name or a prefix ending in '/'; allowed is '*' or a list of names/prefixes. */
export function methodAllowed(allowed, pattern) {
  if (allowed === '*') return true;
  return allowed.some((a) => a === pattern || (a.endsWith('/') && pattern.startsWith(a)));
}

/** May the mod run the program `name` on the Mac (graph-integrity G8.2, D4)? A `processes.exec` grant names it; none is ever bare. */
export const execGranted = (grants, name) => grants.some((g) => g.startsWith('processes.exec:') && g.slice('processes.exec:'.length).split(',').includes(name));

export function requireGrant(grants, name, what = name) {
  if (!hasGrant(grants, name)) throw new CodexModsError('Denied', `this mod has not been granted ${what}`);
}

/** Require the grant and, if methods are named, that each one is within the granted list. `methods` may be '*' or undefined (= all). */
export function requireMethods(grants, name, methods) {
  requireGrant(grants, name);
  const allowed = grantedMethods(grants, name);
  if (allowed === '*') return;
  if (methods === undefined || methods === '*') throw new CodexModsError('Denied', `${name} for all methods needs the bare ${name} grant`);
  const list = Array.isArray(methods) ? methods : [methods];
  for (const m of list) {
    if (typeof m !== 'string') throw new CodexModsError('Invalid', 'method must be a string');
    if (!methodAllowed(allowed, m)) throw new CodexModsError('Denied', `${name} is not granted for ${m}`);
  }
}
