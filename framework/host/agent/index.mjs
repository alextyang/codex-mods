// What the framework keeps of the agent's inputs (graph-integrity G3.5): the agent's inputs are the source's own acts in the graph
// (CodexAgent._startThread, CodexThread._resume, Thread.fork's options, Thread.send's additionalContext, CodexAgent._setSkillRoots), held
// from the app at app-ops, and mods add to them in the interceptor chain (the SDK's instructions, tool and skills helpers). What stays here
// is the referee's and the composer's own:
// - The `mod_` names are the framework's on every start: a start the app makes with a namespace of that name has it left out, so each one a
//   thread has was added by its mod (the provider refuses a change adding another mod's) and the agent's calls of it go to that mod
//   (the native provider routes them: Tool._call).
// - A mod's mention picked in a composer (public-hooks.md §3.14) carries its context to the next message from that composer's draft that
//   still has the mention's text, as data (untrusted), under `mention:<mod>`, naming the mod; taken once, forgotten after an hour.
// Node built-ins only.
import { PREFIX, namespaceOf } from './namespace.mjs';

export { namespaceOf };
/** Before the mods' own interceptors and the framework's holds. */
const PRIORITY = 1000;
/** How long a mod's tool may run (the interceptor's own bound, interception.md I6). */
export const TOOL_DEADLINE_MS = 10 * 60_000;
const MAX_TEXT = 16 * 1024;     // a mention's context
const MAX_RESULT = 8 * 1024 * 1024;
const MAX_ITEMS = 64;
const MENTION_MS = 60 * 60_000; // how long a mention's context waits for its message
const MENTIONS = 20;            // a draft's waiting at once (the oldest go)

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (message) => Object.assign(new Error(message), { code: 'Invalid' });

/** What a tool answered, as the protocol's content items: text, `{text}`, `{image: url}`, or a list of them. */
export function contentItems(value) {
  const list = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  if (list.length > MAX_ITEMS) throw invalid(`a tool's result has at most ${MAX_ITEMS} items`);
  const items = list.map((v) => {
    if (typeof v === 'string') return { type: 'inputText', text: v };
    if (isObject(v) && typeof v.text === 'string') return { type: 'inputText', text: v.text };
    if (isObject(v) && typeof v.image === 'string' && /^(data:image\/|https:\/\/)/.test(v.image)) return { type: 'inputImage', imageUrl: v.image };
    throw invalid('a tool\'s result is text, {text}, {image: url} (a data: or https: URL), or a list of them');
  });
  if (JSON.stringify(items).length > MAX_RESULT) throw invalid('a tool\'s result is larger than 8 MB');
  return items;
}

/** A mention's text as it may go to the agent: bounded. */
const clean = (text) => String(text).slice(0, MAX_TEXT).trim();

/** @param {{ mux: object, log?: object, nameOf?: (modId: string) => string }} o */
export function createAgentHost({ mux, log = console, nameOf = (id) => id }) {
  const client = mux.client('framework:agent');
  const names = new Map();   // mod id -> its name when it gave a mention
  let closed = false;

  // ---------------------------------------------------------------- the `mod_` names, the framework's on every start
  const starts = client.intercept('clientRequest', ['thread/start'], (m, info) => {
    if (closed || info.backend !== 'primary' || info.origin !== 'app' || !isObject(m.params) || !Array.isArray(m.params.dynamicTools)) return undefined;
    const given = m.params.dynamicTools;
    const own = given.filter((t) => !(typeof t?.name === 'string' && t.name.startsWith(PREFIX)));
    return own.length !== given.length ? { replace: { ...m, params: { ...m.params, dynamicTools: own } } } : undefined;
  }, { priority: PRIORITY, timeoutMs: 1000, onError: 'pass' });

  // ---------------------------------------------------------------- a mention's context (public-hooks.md §3.14)
  const pending = new Map();   // draft id -> [{mod, label, text, at}]
  const inputText = (input) => (Array.isArray(input) ? input : []).map((x) => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('\n');
  function takeMentions(threadId, text, have) {
    const now = Date.now();
    const out = new Map();   // mod -> values
    for (const [draft, list] of pending) {
      if (draft !== threadId && !draft.startsWith('new:')) continue;
      const left = [];
      for (const e of list) {
        if (now - e.at > MENTION_MS) continue;
        if (!text.includes(e.label) || `mention:${e.mod}` in have) { left.push(e); continue; }
        const vs = out.get(e.mod) ?? [];
        vs.push(`“${e.label}” (mentioned in this message; context from ${names.get(e.mod) ?? nameOf(e.mod)}):\n${e.text}`);
        out.set(e.mod, vs);
      }
      if (left.length) pending.set(draft, left); else pending.delete(draft);
    }
    return [...out].map(([mod, vs]) => [`mention:${mod}`, { kind: 'untrusted', value: vs.join('\n\n').slice(0, MAX_TEXT) }]);
  }
  const turns = client.intercept('clientRequest', ['turn/start', 'turn/steer'], (m, info) => {
    if (closed || info.backend !== 'primary' || !isObject(m.params) || typeof m.params.threadId !== 'string' || !pending.size) return undefined;
    const p = m.params;
    const have = isObject(p.additionalContext) ? p.additionalContext : {};
    const mentioned = takeMentions(p.threadId, inputText(p.input), have);
    if (!mentioned.length) return undefined;
    return { replace: { ...m, params: { ...p, additionalContext: { ...have, ...Object.fromEntries(mentioned) } } } };
  }, { priority: PRIORITY, timeoutMs: 1000, onError: 'pass' });

  return {
    /**
     * A mod's mention picked in a composer (public-hooks.md §3.14): `{mod, label, context}`, the text the composer shows for it and what it
     * carries for the agent; `draftId` the composer's draft (a chat's thread id, or a new chat's `new:` id).
     */
    mentioned(draftId, entry) {
      if (typeof draftId !== 'string' || !draftId || !isObject(entry) || typeof entry.mod !== 'string' || typeof entry.label !== 'string' || typeof entry.context !== 'string') return false;
      const label = entry.label.trim().slice(0, 300), text = clean(entry.context);
      if (!label || !text) return false;
      if (!names.has(entry.mod)) names.set(entry.mod, nameOf(entry.mod));
      const list = (pending.get(draftId) ?? []).concat({ mod: entry.mod, label, text, at: Date.now() }).slice(-MENTIONS);
      pending.delete(draftId);
      pending.set(draftId, list);
      if (pending.size > 200) pending.delete(pending.keys().next().value);
      return true;
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const d of [starts, turns]) { try { d?.dispose(); } catch { /* gone with the mux */ } }
      pending.clear();
      void log;
    },
  };
}
