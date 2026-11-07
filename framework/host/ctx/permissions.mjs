// ctx.permissions (docs/design/framework-ui.md F8): what the mod holds of each of its permissions, a request for an optional one, and a change while it runs. A required one is
// `allow`; an optional one is its decision. `request` asks the user (Allow, Don't allow) in the window in front and answers {granted}; a grant not declared is refused without a prompt.
// A decision that takes something away restarts the mod, so `onChange` hears only what it gains while it runs. Node built-ins only (none needed).
import { CodexModsError } from '../../../sdk/errors.mjs';

/** @param {{ permissions: () => ReturnType<import('../permissions.mjs').createPermissionGate> | null }} o */
export function createPermissionsNs(o) {
  const gate = (scope) => {
    if (scope.state.framework === true) throw new CodexModsError('Denied', 'the page\'s runtime has no permissions of a mod');
    const p = o.permissions();
    if (!p) throw new CodexModsError('Unavailable', 'permissions are not available here');
    return p;
  };
  const grantOf = (g) => { if (typeof g !== 'string' || !g || g.length > 512) throw new CodexModsError('Invalid', 'permissions: a grant is a permission string'); return g; };
  const textOf = (t) => {
    const x = t && typeof t === 'object' ? t : {};
    const one = (k, max) => (x[k] === undefined ? undefined : typeof x[k] === 'string' && x[k].length <= max ? x[k] : (() => { throw new CodexModsError('Invalid', `permissions.request: ${k} is text of at most ${max} characters`); })());
    return { title: one('title', 200), subtitle: one('subtitle', 400), body: one('body', 4000) };
  };
  return {
    calls: {
      state(scope, grant) { return gate(scope).state(scope.state.id, grantOf(grant), scope.state.mod.manifest); },
      request(scope, grant, text) {
        if (scope.state.status !== 'active') throw new CodexModsError('Unavailable', 'permissions.request: not while the mod starts');
        return gate(scope).request(scope.state.id, grantOf(grant), scope.state.mod.manifest, textOf(text));
      },
    },
    subs: {
      onChange(scope, args, emit) { return gate(scope).onChange(scope.state.id, (grant, decision) => emit({ grant, decision })); },
    },
  };
}

/**
 * A call that may wait for the user: let through when the held grants admit it; under an `ask` grant, held for the user; refused as `check` refuses otherwise.
 * @param {object} scope @param {() => object | null} permissions @param {(grants: string[]) => void} check  throws when a list does not admit the call @param {string} what  the call in words
 */
export async function admit(scope, permissions, check, what) {
  const test = (grants) => { try { check(grants); return true; } catch { return false; } };
  if (test(scope.state.grants)) return;
  const p = scope.state.framework === true ? null : permissions();
  const g = p?.askFor(scope.state.id, scope.state.grants, test) ?? null;
  if (!g) { check(scope.state.grants); return; }
  await p.hold(scope.state.id, g, { what });
}
