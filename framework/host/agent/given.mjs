// What each mod gave the agent (the framework's own product, its Mod page; graph-integrity G3.5), read from the graph's records of the
// agent's inputs as they went: the tools of its namespace in the last thread start, its marked block in the last start's, resume's or
// fork's developer instructions, its key in the last turn's context. Nothing is registered with the framework: this is what happened.
// Node built-ins only.
import { namespaceOf } from './namespace.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MARKER = /<mod_instructions mod="([a-z0-9][a-z0-9.-]*)">/g;
const CONTEXT = /^mod:([a-z0-9][a-z0-9.-]*)$/;

/** @param {{ graph: object, modIds: () => string[], log?: object }} o */
export function createAgentGiven({ graph, modIds, log = { warn() {} } }) {
  const by = new Map();   // mod id -> {tools: [{name, description}], text: boolean, perTurn: boolean}
  const listeners = new Set();
  const entry = (id) => { let e = by.get(id); if (!e) by.set(id, (e = { tools: [], text: false, perTurn: false })); return e; };
  const changed = (ids) => { for (const id of ids) for (const fn of [...listeners]) { try { fn(id); } catch (e) { log.warn('an agent listener failed', { message: String(e?.message ?? e) }); } } };
  const marked = (text) => new Set(typeof text === 'string' ? [...text.matchAll(MARKER)].map((m) => m[1]) : []);

  /** The Codex agent's own acts only: its provider's instances of those types, never an operation another provider named alike (review
   *  2026-11-05 #5). */
  const isA = (ref, typeId) => !!ref && ref.provider === 'codex' && (graph.type?.(ref.type)?.chain ?? [ref.type]).includes(typeId);
  const sub = graph.onOperation?.((e) => {
    if (e?.outcome?.status !== 'done') return;
    const on = e.operation === '_startThread' ? 'CodexAgent' : e.operation === '_resume' || e.operation === 'send' ? 'CodexThread' : null;
    if (!on || !isA(e.ref, on)) return;
    const [first, second] = Array.isArray(e.effectiveArgs) ? e.effectiveArgs : Array.isArray(e.args) ? e.args : [];
    const touched = new Set();
    if (e.operation === '_startThread' && isObj(first)) {
      // the tools each mod's namespace had (a start without them takes none of its tools)
      const spaces = new Map((Array.isArray(first.dynamicTools) ? first.dynamicTools : []).filter((t) => t?.type === 'namespace' && typeof t.name === 'string').map((t) => [t.name, t]));
      for (const id of modIds()) {
        const t = spaces.get(namespaceOf(id));
        const tools = Array.isArray(t?.tools) ? t.tools.filter((x) => typeof x?.name === 'string').map((x) => ({ name: x.name, description: String(x.description ?? '') })) : [];
        if (JSON.stringify(entry(id).tools) !== JSON.stringify(tools)) { entry(id).tools = tools; touched.add(id); }
      }
    }
    if ((e.operation === '_startThread' || e.operation === '_resume') && isObj(first) && typeof first.developerInstructions === 'string') {
      const ids = marked(first.developerInstructions);
      for (const id of modIds()) if (entry(id).text !== ids.has(id)) { entry(id).text = ids.has(id); touched.add(id); }
    }
    if (e.operation === 'send' && isObj(second?.additionalContext)) {
      const ids = new Set(Object.keys(second.additionalContext).map((k) => CONTEXT.exec(k)?.[1]).filter(Boolean));
      for (const id of modIds()) if (entry(id).perTurn !== ids.has(id)) { entry(id).perTurn = ids.has(id); touched.add(id); }
    }
    changed(touched);
  });
  return {
    /** What a mod gave the agent last: its tools, and its instructions (a chat's text, each turn's). */
    of(id) {
      const e = by.get(id);
      return { tools: e ? e.tools : [], skills: [], instructions: e ? [...(e.text ? ['text'] : []), ...(e.perTurn ? ['perTurn'] : [])] : [] };
    },
    onChange(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    dispose() { sub?.dispose?.(); listeners.clear(); },
  };
}
