// The agent's inputs as the source's own acts (graph-integrity G3.5): a thread's start (the agent's), a resume and the session's extra
// skill roots, with the source's own parameters as given. The app's own are held for interceptors at app-ops (and a send's context and a
// fork's parameters ride on Thread.send and Thread.fork), so mods add what they share in the chain, in the user's order. This provider
// referees each change as its changer's own (`change`): a mod adds or changes only its own tools' namespace (`mod_<id>`, the framework's
// names: each one a mod's), never the app's tools or another mod's, never what the thread may reach (its folder, sandbox, approvals), and
// in a turn's context only its own key (`mod:<id>`). The agent's call of a mod's tool is Tool._call on that tool (`<namespace>/<tool>`, put
// when called, index.mjs): the mod answers it (a replacing interceptor, its own namespace only, graph/policy.mjs); unanswered, this
// provider says the mod is not running.
import { refs } from '../map.mjs';
import { namespaceOf, PREFIX } from '../../../../agent/namespace.mjs';

export const realizes = {
  types: ['Tool'],
  operations: { CodexAgent: ['_startThread', '_setSkillRoots'], CodexThread: ['_resume'], Tool: ['_call'] },
  supports: { CodexAgent: ['skillRoots'] },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** What a thread may reach: its folder, its sandbox and approvals, and the config keys that set them. */
const ACCESS = ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'permissions'];
const ACCESS_CONFIG = /sandbox|approval|permission|trust|writable|network/i;

/** A change of the parameters that widens or moves what the thread may reach, or null. */
export function accessChange(before, after) {
  for (const k of ACCESS) if (!same(before?.[k], after?.[k])) return `it changes ${k}`;
  const b = isObj(before?.config) ? before.config : {}, a = isObj(after?.config) ? after.config : {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (ACCESS_CONFIG.test(k) && !same(b[k], a[k])) return `it changes the config's ${k}`;
  return null;
}
/** A change of the dynamic tools that is not the changer's own namespace (added, changed or taken away), or null. */
export function toolsChange(before, after, by) {
  const named = (list) => new Map((Array.isArray(list) ? list : []).filter((t) => typeof t?.name === 'string').map((t) => [t.name, JSON.stringify(t)]));
  const b = named(before), a = named(after);
  const own = by?.kind === 'mod' ? namespaceOf(by.id) : null;
  for (const [name, json] of a) if (b.get(name) !== json && name !== own) return name.startsWith(PREFIX) ? `it adds another mod's tools (${name})` : `it changes the app's tools (${name})`;
  for (const name of b.keys()) if (!a.has(name) && name !== own) return `it takes away tools that are not its own (${name})`;
  return null;
}
/** A change of a turn's context that is not the changer's own key (`mod:<id>`), or null. */
export function contextChange(before, after, by) {
  const b = isObj(before) ? before : {}, a = isObj(after) ? after : {};
  const own = by?.kind === 'mod' ? `mod:${by.id}` : null;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(b[k], a[k]) && k !== own) return `it changes the turn's context under ${k}, not its own`;
  return null;
}

export function types(feed) {
  return {
    CodexAgent: { operations: {
      _startThread: { effect: 'external', handler: ({ args: [params], intent }) => feed().start(params, intent),
        change: ({ before: [b], after: [a], by }) => toolsChange(b?.dynamicTools, a?.dynamicTools, by) ?? accessChange(b, a) },
      _setSkillRoots: { effect: 'external', handler: ({ args: [roots], intent }) => feed().setRoots(roots, intent) },
    } },
    CodexThread: { operations: {
      _resume: { effect: 'external', handler: ({ ref, args: [params], intent }) => feed().resume(ref, params, intent),
        change: ({ before: [b], after: [a] }) => accessChange(b, a) },
    } },
    // the provider's own answer: nobody answered (a mod's tool whose mod is off, or a tool this provider does not know)
    Tool: { operations: { _call: { effect: 'none', handler: ({ ref }) => feed().unanswered(ref) } } },
  };
}

/** @param {{ handle: object, request: Function, resident: Function, serverUp: () => boolean, DOWN: object, modOfNamespace?: (ns: string) => ({id: string, name?: string} | null), log: object }} ctx */
export function createFeed(ctx) {
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  const agentState = () => ctx.resident(refs.agent())?.state ?? null;
  return {
    async start(params, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (!isObj(params)) return refused('invalid', 'a thread\'s start takes its parameters, an object');
      return ctx.request('thread/start', params, intent);
    },
    async resume(ref, params, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (params !== undefined && params !== null && !isObj(params)) return refused('invalid', 'a resume takes its parameters, an object');
      return ctx.request('thread/resume', { ...(params ?? {}), threadId: ref.id }, intent);
    },
    async setRoots(roots, intent) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const list = [...new Set((Array.isArray(roots) ? roots : []).filter((x) => typeof x === 'string' && x.startsWith('/')))].sort();
      await ctx.request('skills/extraRoots/set', { extraRoots: list }, intent);
      try { await ctx.request('skills/list', { forceReload: true }); } catch (e) { ctx.log.warn('codex: the skills were not read again', { message: String(e?.message ?? e) }); }
      const was = agentState();
      if (was) ctx.handle.update(refs.agent(), { state: { skillRoots: list } });
      return null;
    },
    unanswered(ref) {
      const [ns, ...rest] = String(ref.id).split('/');
      const name = rest.join('/') || ref.id;
      if (!ns.startsWith(PREFIX)) return refused('unsupported', `the tool ${name} is the app's own`);
      // the installed mod whose namespace it is: the framework's Mod instances name every installed mod, on or off
      let mod = ctx.modOfNamespace?.(ns) ?? null;
      if (!mod) { try { const m = (ctx.graph.list?.('Mod') ?? []).find((x) => namespaceOf(x.ref.id) === ns); mod = m ? { id: m.ref.id, name: m.state?.name } : null; } catch { mod = null; } }
      return refused('unavailable', mod ? `${mod.name ?? mod.id} is not running, so its tool ${name} is not available now` : `the tool ${name} is not available now: its mod is not installed or not running`);
    },
  };
}
