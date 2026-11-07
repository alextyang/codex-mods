// ctx.settings → one flat document, every declared key's app value (data/<id>/settings.json holds those set; docs/design/framework-ui.md F7), a key's effective value at a project or a
// thread (settings.scopes.json holds the overrides; docs/design/systems.md S14, "E3 in detail"), `set` and `reset` at a scope (scoped patches through management, as the mod itself:
// resolved when the operation ends), and onChange with what changed: `{document, change: {key, scope, value}}`, the scope where it changed and the new effective value there. The mod is
// always the scope's own (authenticated by its channel); no grant is needed for its own settings.
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { readJson } from '../fsutil.mjs';
import { declarationsOf, effectiveOf, documentOf, scopeKeyOf, scopeOfPatch, parseScopeKey } from '../packages/settings.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const settingsFile = (mod) => join(mod.dataDir, 'settings.json');
const scopesFile = (mod) => join(mod.dataDir, 'settings.scopes.json');

export async function loadSettings(state) {
  if (state.settingsValue === undefined) {
    state.settingsValue = documentOf(declarationsOf(state.mod.manifest).list, await readJson(settingsFile(state.mod), {}));
  }
  return state.settingsValue;
}

/** The stored values (the app map and the overrides), cached until they change. */
async function loadStored(state) {
  if (state.settingsStored === undefined) {
    state.settingsStored = { app: await readJson(settingsFile(state.mod), {}), scopes: await readJson(scopesFile(state.mod), {}) };
  }
  return state.settingsStored;
}
const isRef = (v) => isObject(v) && typeof v.provider === 'string' && typeof v.id === 'string' && v.id.length > 0;

/**
 * @param {{ graph?: () => object | null, write?: () => ((modId: string, patches: object[]) => Promise<object>) | null }} [o]
 *   `graph`: a thread's project; `write`: scoped patches through management, as the mod
 */
export function createSettingsNs(o = {}) {
  /** A key's effective value at the app, a project or a thread (a thread brings its own project). */
  async function effective(state, key, where = {}) {
    const { list } = declarationsOf(state.mod.manifest);
    const d = list.find((x) => x.key === key);
    if (!d) throw new CodexModsError('Invalid', `settings: ${key} is not a setting of this mod`);
    const stored = await loadStored(state);
    let projectKey = null, threadKey = null;
    if (where.thread !== undefined) {
      if (where.project !== undefined) throw new CodexModsError('Invalid', 'settings: a thread brings its own project; give one of them');
      if (!isRef(where.thread)) throw new CodexModsError('Invalid', 'settings: thread is a ref');
      threadKey = scopeKeyOf('thread', where.thread);
      // The thread's project is its own link in the graph (a mod may give a thread as {provider, id}: the graph keys it by its concept).
      const project = o.graph?.()?.resolve({ type: typeof where.thread.type === 'string' ? where.thread.type : 'Thread', provider: where.thread.provider, id: where.thread.id })?.links?.project;
      if (isRef(project)) projectKey = scopeKeyOf('project', project);
    } else if (where.project !== undefined) {
      if (!isRef(where.project)) throw new CodexModsError('Invalid', 'settings: project is a ref');
      projectKey = scopeKeyOf('project', where.project);
    }
    return effectiveOf(d, stored.app, stored.scopes, { projectKey, threadKey }).value;
  }
  /** The patch through management, as the mod itself; resolved when its operation ends, with the operation's refusal or failure thrown. */
  async function write(scope, patch) {
    const w = o.write?.();
    if (!w) throw new CodexModsError('Unavailable', 'settings cannot be changed here');
    if (!scope.state.mod.manifest.settings) throw new CodexModsError('Invalid', 'this mod declares no settings');
    scopeOfPatch(patch.scope);   // throws Invalid
    const op = await w(scope.state.id, [patch]);
    if (op && op.outcome && op.outcome !== 'succeeded') throw new CodexModsError(op.error?.code ?? 'Failed', op.error?.message ?? op.note ?? `the settings were not changed (${op.outcome})`);
    return { opId: op?.id ?? null, ...(op?.unchanged || op?.note === 'Unchanged.' ? { unchanged: true } : {}) };
  }
  const scopeArg = (opts) => (opts && opts.scope !== undefined ? opts.scope : 'app');
  const ns = {
    calls: {
      /** No key: the effective app document; a key: its effective value at {project?, thread?}. */
      async get(scope, key, opts) {
        if (key === undefined || key === null) return structuredClone(await loadSettings(scope.state));
        return effective(scope.state, String(key), isObject(opts) ? opts : {});
      },
      set(scope, key, value, opts) { return write(scope, { key: String(key), scope: scopeArg(opts), value }); },
      reset(scope, key, opts) { return write(scope, { key: String(key), scope: scopeArg(opts), unset: true }); },
    },
    subs: {
      /** `{document, change}` events. */
      onChange(scope, args, emit) {
        const l = (value, change) => emit({ document: value, ...(change ? { change } : {}) });
        scope.state.settingsListeners.add(l);
        return { dispose: () => { scope.state.settingsListeners.delete(l); } };
      },
    },
  };
  // For the runtime (what a change is worth to the mod), not a member of the namespace.
  Object.defineProperty(ns, 'effective', { value: effective, enumerable: false });
  return ns;
}

/** What a patch changed, as a mod sees it: the key, the scope ('app' or {project | thread: ref}) and the new effective value there. */
export async function changesOf(ns, state, changes) {
  const out = [];
  for (const c of changes ?? []) {
    const parsed = c.scope === 'app' ? null : parseScopeKey(c.scope);
    const ref = parsed ? { provider: parsed.provider, id: parsed.id } : null;
    const scope = parsed ? { [parsed.kind]: ref } : 'app';
    let value;
    try { value = await ns.effective(state, c.key, parsed ? { [parsed.kind]: ref } : {}); } catch { continue; }
    out.push({ key: c.key, scope, value });
  }
  return out;
}

