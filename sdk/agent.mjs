// What the agent gets from a mod (graph-integrity G3.5): SDK conveniences built only on the graph's public primitives. The agent's inputs
// are the source's own acts (CodexAgent._startThread, CodexThread._resume, Thread.fork's options, Thread.send's additionalContext,
// CodexAgent._setSkillRoots); each helper intercepts them and adds this mod's part, so mods' parts come in the user's order with each
// other's (the chain is the referee, and the provider refuses a change that is not the mod's own). Each returns a Disposable; the mod's stop
// ends them with it. They need the grants their acts need: `graph.intercept` and `graph.act` for the operations they change
// (`CodexAgent._startThread`, `CodexThread._resume`, `Thread.fork`, `Thread.send`, `CodexAgent._setSkillRoots`). Host realm.
import { fileURLToPath } from 'node:url';
import { namespaceOf } from '../framework/host/agent/namespace.mjs';

const AGENT = Object.freeze({ type: 'CodexAgent', provider: 'codex', id: 'codex' });
const MAX_TEXT = 16 * 1024;
/** A resume that sends none of these reuses the running thread as it is (the app's own, for an idle thread): nothing is added to it. */
const INSTRUCTION_FIELDS = ['baseInstructions', 'developerInstructions', 'config'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const marker = (modId) => `<mod_instructions mod="${modId}">`;
/** A mod's text as it goes to the agent: bounded, with no marker of a block in it. */
const clean = (text) => String(text).replace(/mod_instructions/gi, 'mod-instructions').slice(0, MAX_TEXT).trim();
const many = (ds) => ({ dispose() { for (const d of ds) { try { d?.dispose?.(); } catch { /* gone with the mod */ } } } });
const idOf = (ctx) => { const id = ctx?.mod?.id; if (typeof id !== 'string' || !id) throw new TypeError('the mod\'s ctx is needed (ctx.mod.id)'); return id; };

/** Whether a thread is one a scope's where keeps (none: every thread), as this mod reads it (its attached data too). */
async function kept(ctx, scope, thread) {
  if (!scope?.where) return true;
  const list = await ctx.graph.list(thread.type, scope.where).catch(() => []);
  return list.some((x) => x?.ref?.id === thread.id && x.ref.provider === thread.provider);
}
/** Whether a thread with this folder is in the scope's project (none: every thread). */
async function inScope(ctx, scope, cwd) {
  if (!scope?.project) return true;
  if (typeof cwd !== 'string' || !cwd) return false;
  const p = await ctx.graph.resolve(scope.project);
  const loc = p?.state?.location;
  return typeof loc === 'string' && !!loc && (cwd === loc || cwd.startsWith(loc.endsWith('/') ? loc : `${loc}/`));
}

/**
 * Instructions the agent follows, from this mod: a text joins the developer instructions of each thread's start, resume (one that sends
 * instructions) and fork, once, in a block marked as this mod's; a function's text (`(env) => string`, env `{thread}`) goes with each turn
 * as the turn's additional context under `mod:<id>`. `scope.project`: only threads in that project; `scope.where` (a function's text):
 * only the threads it keeps, as this mod reads them (its attached data too: a role it keeps on a chat). The app's own helpers' threads
 * (ephemeral) get nothing.
 * @param {object} ctx  the mod's host ctx
 * @param {string | ((env: { thread: object }) => string | Promise<string>)} text
 * @param {{ scope?: { project?: object } }} [opts]
 */
export function instructions(ctx, text, { scope } = {}) {
  const modId = idOf(ctx);
  if (typeof text === 'function') {
    return many([ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
      const [content, options] = call.args;
      if (!(await inScope(ctx, scope, call.instance?.state?.cwd)) || !(await kept(ctx, scope, call.ref))) return next();
      let said;
      try { said = clean(await text({ thread: call.ref }) ?? ''); } catch { said = ''; }
      if (!said) return next();
      const context = { ...(isObj(options?.additionalContext) ? options.additionalContext : {}), [`mod:${modId}`]: { kind: 'application', value: said } };
      return next({ args: [content, { ...(isObj(options) ? options : {}), additionalContext: context }] });
    })]);
  }
  const body = clean(text);
  if (!body) throw new TypeError('instructions need a text');
  const block = `${marker(modId)}\n${body}\n</mod_instructions>`;
  const add = (current) => (typeof current === 'string' && current.includes(marker(modId)) ? current : [typeof current === 'string' ? current : '', block].filter(Boolean).join('\n\n'));
  return many([
    ctx.graph.intercept('CodexAgent', '_startThread', async (call, next) => {
      const [p] = call.args;
      if (!isObj(p) || p.ephemeral === true || !(await inScope(ctx, scope, p.cwd))) return next();
      return next({ args: [{ ...p, developerInstructions: add(p.developerInstructions) }] });
    }),
    ctx.graph.intercept('CodexThread', '_resume', async (call, next) => {
      const [p] = call.args;
      if (!isObj(p) || !INSTRUCTION_FIELDS.some((k) => k in p) || call.instance?.state?.ephemeral === true || !(await inScope(ctx, scope, p.cwd ?? call.instance?.state?.cwd))) return next();
      return next({ args: [{ ...p, developerInstructions: add(p.developerInstructions) }] });
    }),
    ctx.graph.intercept('CodexThread', 'fork', async (call, next) => {
      const [turn, options] = call.args;
      if (!(await inScope(ctx, scope, call.instance?.state?.cwd))) return next();
      const o = isObj(options) ? options : {};
      return next({ args: [turn ?? null, { ...o, developerInstructions: add(o.developerInstructions) }] });
    }),
  ]);
}

/** A tool's input as JSON Schema: an SDK schema (s.object(...)) converted, a plain JSON Schema as it is, none as an empty object. */
export function jsonSchemaOf(input) {
  if (input === undefined || input === null) return { type: 'object', properties: {} };
  if (input?.member !== 'state') return input;
  const of = (x) => {
    switch (x.t) {
      case 'string': case 'content': return { type: 'string' };
      case 'url': return { type: 'string', format: 'uri' };
      case 'number': case 'time': return { type: 'number' };
      case 'boolean': return { type: 'boolean' };
      case 'enum': return { type: 'string', enum: [...x.values] };
      case 'list': return { type: 'array', items: of(x.of) };
      case 'record': return { type: 'object', additionalProperties: of(x.of) };
      case 'object': {
        const fields = Object.entries(x.fields);
        return { type: 'object', properties: Object.fromEntries(fields.map(([k, f]) => [k, of(f.schema)])), required: fields.filter(([, f]) => !f.optional).map(([k]) => k), additionalProperties: false };
      }
      case 'ref': return { type: 'object', properties: { type: { type: 'string' }, provider: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'provider', 'id'] };
      default: return {};
    }
  };
  return of(input.schema);
}

/**
 * A tool the agent may call in the threads started from now on: `{name, description, input?, scope?, run(args, env)}`. It is added to each
 * thread's start under this mod's namespace (`mod_<id>`, the framework's: only this mod adds it); the agent's calls of it come here (only
 * this mod answers them), and while this mod is off the framework answers that it is not running. `run` answers text, `{text}`,
 * `{image: url}` or a list of them, and throws to fail; env `{thread, turn, call}`.
 */
export function tool(ctx, { name, description, input, scope, run } = {}) {
  const modId = idOf(ctx);
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new TypeError('a tool\'s name is 1-64 letters, digits, _ or -');
  if (typeof description !== 'string' || !description.trim()) throw new TypeError('a tool needs a description the agent reads');
  if (typeof run !== 'function') throw new TypeError('a tool runs: run(args, env)');
  const ns = namespaceOf(modId);
  const spec = { type: 'function', name, description: description.slice(0, 4096), inputSchema: jsonSchemaOf(input) };
  return many([
    ctx.graph.intercept('CodexAgent', '_startThread', async (call, next) => {
      const [p] = call.args;
      if (!isObj(p) || p.ephemeral === true || !(await inScope(ctx, scope, p.cwd))) return next();
      const tools = Array.isArray(p.dynamicTools) ? p.dynamicTools : [];
      const mine = tools.find((t) => t?.type === 'namespace' && t.name === ns);
      const withMine = mine
        ? tools.map((t) => (t === mine ? { ...t, tools: [...(Array.isArray(t.tools) ? t.tools : []).filter((x) => x?.name !== name), spec] } : t))
        : [...tools, { type: 'namespace', name: ns, description: `Tools of the mod ${modId}`, tools: [spec] }];
      return next({ args: [{ ...p, dynamicTools: withMine }] });
    }),
    ctx.graph.intercept('Tool', '_call', async (call, next) => {
      if (call.ref?.id !== `${ns}/${name}`) return next();
      const [args, env] = call.args;
      try { return { status: 'done', value: (await run(args ?? null, isObj(env) ? env : {})) ?? null }; }
      catch (e) { return { status: 'failed', error: { message: `${name} failed: ${String(e?.message ?? e).slice(0, 2000)}` } }; }
    }, { replaces: true, deadlineMs: 10 * 60_000 }),
  ]);
}

/**
 * A folder of skills for the agent in every chat (`<folder>/<skill>/SKILL.md`): added to the session's extra skill roots whenever they are
 * set, and set now so the agent has them. `folder`: an absolute path or a file URL (`new URL('./skills', import.meta.url)`).
 */
export function skills(ctx, folder) {
  idOf(ctx);
  const root = folder instanceof URL || (typeof folder === 'string' && folder.startsWith('file:')) ? fileURLToPath(folder) : folder;
  if (typeof root !== 'string' || !root.startsWith('/')) throw new TypeError('a skill folder is an absolute path or a file URL');
  const d = ctx.graph.intercept('CodexAgent', '_setSkillRoots', (call, next) => {
    const [roots] = call.args;
    const list = Array.isArray(roots) ? roots : [];
    return list.includes(root) ? next() : next({ args: [[...list, root]] });
  });
  // set now: the session's roots as they are with this one (a mod's call skips its own interceptor; every other mod's adds its own)
  const now = async () => {
    const agent = await ctx.graph.resolve(AGENT);
    if (!agent || agent.gone) return;
    // none set yet (the app sets extra roots only when it has some): this mod's alone, to which every other mod's interceptor adds its own
    const roots = Array.isArray(agent.state?.skillRoots) ? agent.state.skillRoots : [];
    if (!roots.includes(root)) await ctx.graph.invoke(AGENT, '_setSkillRoots', [[...roots, root]]);
  };
  const ready = now().catch(() => {});
  return Object.assign(many([d]), { ready });
}
