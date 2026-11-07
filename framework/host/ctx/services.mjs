// ctx.services: a registry of provide(name) per mod, plus framework services (modId 'framework').
import { CodexModsError } from '../../../sdk/errors.mjs';

export const SERVICE_DEADLINE_MS = 30000;

/** Who called a service, as its handler is told: a mod (`{kind: 'mod', id}`), a client holding a mod's lease (`{kind: 'client', mod}`),
 *  else the app (the framework, the user's own surfaces). */
export function callerOf(c) {
  if (typeof c === 'string' && c.startsWith('mod:')) return Object.freeze({ kind: 'mod', id: c.slice(4) });
  if (typeof c === 'string' && c.startsWith('lease:')) { const o = c.slice(6); return Object.freeze({ kind: 'client', mod: o.startsWith('mod:') ? o.slice(4) : o }); }
  return Object.freeze({ kind: 'app' });
}

export function createServiceRegistry() {
  /** @type {Map<string, Map<string, {kind: string, tag: unknown, methods: Set<string>, invoke: (method: string, args: any) => Promise<any>}[]>>} */
  const byMod = new Map();
  /** @type {Map<string, Record<string, Function>>} */
  const framework = new Map();

  return {
    /** kind: 'host' | 'renderer' | 'process'. Only renderer providers of different windows may share a name. */
    provide(modId, name, methods, kind, tag, invoke) {
      if (typeof name !== 'string' || !name) throw new CodexModsError('Invalid', 'service name must be a non-empty string');
      if (!Array.isArray(methods) || methods.some((m) => typeof m !== 'string' || !m)) throw new CodexModsError('Invalid', 'service methods must be names');
      let names = byMod.get(modId);
      if (!names) byMod.set(modId, (names = new Map()));
      const list = names.get(name) ?? [];
      if (list.some((p) => p.tag === tag || p.kind !== 'renderer' || kind !== 'renderer')) {
        throw new CodexModsError('Conflict', `service ${name} is already provided by ${modId}`);
      }
      const entry = { kind, tag, methods: new Set(methods), invoke };
      list.push(entry);
      names.set(name, list);
      return {
        dispose() {
          const l = byMod.get(modId)?.get(name);
          if (!l) return;
          const i = l.indexOf(entry);
          if (i !== -1) l.splice(i, 1);
          if (l.length === 0) { byMod.get(modId).delete(name); if (byMod.get(modId).size === 0) byMod.delete(modId); }
        },
      };
    },
    removeMod(modId) { byMod.delete(modId); },
    has(modId, name) { return (byMod.get(modId)?.get(name)?.length ?? 0) > 0; },

    provideFramework(name, handlers) {
      if (framework.has(name)) throw new CodexModsError('Conflict', `framework service ${name} already exists`);
      framework.set(name, handlers);
      return { dispose() { if (framework.get(name) === handlers) framework.delete(name); } };
    },

    async call(modId, name, method, args, caller) {
      if (typeof modId !== 'string' || typeof name !== 'string' || typeof method !== 'string') {
        throw new CodexModsError('Invalid', 'services.call needs (modId, name, method, args)');
      }
      if (modId === 'framework') {
        const h = framework.get(name);
        if (!h) throw new CodexModsError('Unavailable', `framework service ${name} is not provided`);
        if (!Object.hasOwn(h, method) || typeof h[method] !== 'function') throw new CodexModsError('Invalid', `framework service ${name} has no method ${method}`);
        return h[method](args, caller);
      }
      const list = byMod.get(modId)?.get(name);
      if (!list || list.length === 0) throw new CodexModsError('Unavailable', `${modId} does not provide service ${name}`);
      const p = list.find((x) => x.kind !== 'renderer') ?? list[0];
      if (!p.methods.has(method)) throw new CodexModsError('Invalid', `service ${name} has no method ${method}`);
      return p.invoke(method, args, callerOf(caller));
    },
  };
}

export function createServicesNs({ services, deadlineMs = SERVICE_DEADLINE_MS }) {
  return {
    calls: {
      async call(scope, modId, name, method, args) {
        scope.state.effects = true;
        return services.call(modId, name, method, args === undefined ? null : args, `mod:${scope.state.id}`);
      },
    },
    handlers: {
      provide(scope, [name, methods], invoke) {
        const kind = scope.realm;
        return services.provide(scope.state.id, name, methods, kind, scope.channel,
          (method, args, caller) => invoke([method, args, caller ?? callerOf(null)], deadlineMs, 'OutcomeUnknown'));
      },
    },
  };
}
