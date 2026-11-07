// codexmods.project-orchestrator, host entry (GOAL.md goal 25). Single-file ESM, Node built-ins only.
//
// A project's orchestrator: a Codex chat in the project with the role `orchestrator` (this mod's attached data on the chat, so it keeps
// everything a Codex chat is). It is started from a project's menu (the renderer: the user's own act).
// - **It learns the project first.** Its first message has it read the project's goals and plans, its progress and its chats, then settle
//   the open questions with the user with the grill-me skill (this mod's, among the session's skills).
// - **It hears of the project's chats.** Each of its turns carries what changed in the project's other chats since its last one (a chat
//   started, waiting for the user, finished) and a digest of them all; while the user has its automatic action `update` on, the mod also
//   tells it when a chat finishes, so it can act on it.
// - **Its tools** (its own, given at its start only): the project's chats, one chat's recent turns, a message to a chat, a new chat. A
//   message or a new chat is this mod's act on the user's behalf: Codex Mods asks the user each time, which is the orchestrator coordinating
//   with them.
import { fileURLToPath } from 'node:url';

export const ROLE = 'role';
export const KICKOFF = 'You are this project\'s orchestrator. First learn the project: read its goals and plans (GOAL.md, README, docs and '
  + 'plans, whatever it keeps), what is done and what is not, and the project\'s current chats (call project_chats, then chat_read on the '
  + 'ones that matter). Then use the grill-me skill to settle the open questions with me, one at a time. Keep your answers short.';
export const INSTRUCTIONS = 'You are the orchestrator of this project, coordinating its work with the user. You hear what happens in the '
  + 'project\'s other chats with each message (in this mod\'s context). Keep track of goals, decisions and who is doing what; point out '
  + 'conflicts and gaps; suggest the next chats to start or the next message to send. Your tools: project_chats (the project\'s chats now), '
  + 'chat_read (a chat\'s recent turns), chat_message (send a message to one of the project\'s chats) and chat_new (start a chat in the project '
  + 'with a prompt); the user is asked before a message is sent or a chat started. Settle open questions with the grill-me skill.';
const MAX_CONTEXT = 6000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content?.parts) ? content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');
/** The namespace of this mod's dynamic tools (the framework's: `mod_` and its id with anything but letters, digits and `-` as `_`). */
export const namespaceOf = (modId) => `mod_${String(modId).replace(/[^A-Za-z0-9-]/g, '_')}`;
/** Whether a thread's folder is in a project's. */
export const inFolder = (cwd, loc) => typeof cwd === 'string' && typeof loc === 'string' && !!loc && (cwd === loc || cwd.startsWith(loc.endsWith('/') ? loc : `${loc}/`));

/** A chat's line in a digest. */
const lineOf = (t) => `- "${clip(t.state?.title ?? 'A chat', 80)}" (${t.ref.id}): ${t.state?.status ?? 'idle'}${t.state?.archived ? ', archived' : ''}${t.state?.preview ? `: ${clip(t.state.preview, 120)}` : ''}`;
/** What changed in a chat between two of its states, as an update (null: nothing worth saying). */
export function changeOf(before, after) {
  const was = before?.state?.status, now = after?.state?.status;
  if (!after || was === now) return null;
  const name = `"${clip(after.state?.title ?? 'A chat', 80)}"`;
  if (now === 'working' && was !== 'waitingForYou') return `${name} started working`;
  if (now === 'waitingForYou') return `${name} is waiting for the user${after.state?.waitingOn ? ` (${after.state.waitingOn})` : ''}`;
  if (now === 'idle' && (was === 'working' || was === 'waitingForYou')) return `${name} finished${after.state?.preview ? `: ${clip(after.state.preview, 160)}` : ''}`;
  if (now === 'error') return `${name} failed`;
  return null;
}
/** The orchestrator's context for a turn: what changed since its last one, and the project's chats now; at most MAX_CONTEXT characters. */
export function contextOf(updates, chats) {
  const parts = [];
  if (updates.length) parts.push(`Since your last message:\n${updates.map((u) => `- ${u}`).join('\n')}`);
  parts.push(chats.length ? `The project's other chats now:\n${chats.map(lineOf).join('\n')}` : 'The project has no other chats now.');
  return clip(parts.join('\n\n'), MAX_CONTEXT);
}

async function host(ctx) {
  const me = ctx.mod.id;
  const ns = namespaceOf(me);
  const skillsRoot = fileURLToPath(new URL('./skills', import.meta.url));
  const AGENT = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  const kept = (await ctx.storage.get('orchestrators')) ?? {};   // thread id -> {project}
  const orchestrators = new Map(Object.entries(kept).filter(([, v]) => isObj(v?.project)));
  const updates = new Map();   // orchestrator thread id -> [text]
  const chats = new Map();     // thread id -> its last state (every chat this mod reads)
  let pending = null;          // {location, until}: the next thread started there is the orchestrator the user just asked for
  const save = () => ctx.storage.set('orchestrators', Object.fromEntries(orchestrators)).catch(() => {});
  const projectOf = async (ref) => ctx.graph.resolve(ref).catch(() => null);
  /** The project's chats now (its own thread left out): those whose project link is the project, or whose folder is in it. */
  async function projectChats(project, self) {
    const p = await projectOf(project);
    const loc = p?.state?.location;
    return [...chats.values()].filter((t) => t.ref.id !== self && !t.gone && (t.links?.project?.id === project.id || inFolder(t.state?.cwd, loc)))
      .sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0)).slice(0, 40);
  }

  // ---- the skill: grill-me among the session's skills (for every chat; the orchestrator is told to use it)
  const skills = ctx.graph.intercept('CodexAgent', '_setSkillRoots', (call, next) => {
    const [roots] = call.args;
    const list = Array.isArray(roots) ? roots : [];
    return list.includes(skillsRoot) ? next() : next({ args: [[...list, skillsRoot]] });
  });
  (async () => {
    const agent = await ctx.graph.resolve(AGENT).catch(() => null);
    if (!agent || agent.gone) return;
    // none set yet (the app sets extra roots only when it has some): this mod's alone, to which every other mod's interceptor adds its own
    const roots = Array.isArray(agent.state?.skillRoots) ? agent.state.skillRoots : [];
    if (!roots.includes(skillsRoot)) await ctx.graph.invoke(AGENT, '_setSkillRoots', [[...roots, skillsRoot]]).catch((e) => ctx.log.warn('its skills were not added', { message: String(e?.message ?? e) }));
  })();

  // ---- its start: the instructions and its tools, for the start the user just asked for only
  const TOOLS = [
    { type: 'function', name: 'project_chats', description: 'The project\'s other chats now: title, id, status and what each last said.', inputSchema: { type: 'object', properties: {} } },
    { type: 'function', name: 'chat_read', description: 'A chat\'s recent turns: what was asked and answered.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, turns: { type: 'number' } }, required: ['id'] } },
    { type: 'function', name: 'chat_message', description: 'Send a message to one of the project\'s chats (the user is asked first).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    { type: 'function', name: 'chat_new', description: 'Start a chat in the project with a prompt (the user is asked first).', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  ];
  const start = ctx.graph.intercept('CodexAgent', '_startThread', async (call, next) => {
    const [p] = call.args;
    if (!pending || Date.now() > pending.until || !isObj(p) || p.ephemeral === true || !inFolder(p.cwd, pending.location)) return next();
    pending = null;
    const marker = `<mod_instructions mod="${me}">`;
    const developerInstructions = [typeof p.developerInstructions === 'string' ? p.developerInstructions : '', `${marker}\n${INSTRUCTIONS}\n</mod_instructions>`].filter(Boolean).join('\n\n');
    const tools = Array.isArray(p.dynamicTools) ? p.dynamicTools.filter((t) => t?.name !== ns) : [];
    return next({ args: [{ ...p, developerInstructions, dynamicTools: [...tools, { type: 'namespace', name: ns, description: 'The project orchestrator\'s tools', tools: TOOLS }] }] });
  });

  // ---- each of its turns: what changed in the project since its last one, and the project's chats now
  const turn = ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
    const o = orchestrators.get(call.ref.id);
    if (!o) return next();
    const said = contextOf(updates.get(call.ref.id) ?? [], await projectChats(o.project, call.ref.id));
    updates.set(call.ref.id, []);
    const [content, options] = call.args;
    const opts = isObj(options) ? options : {};
    const context = { ...(isObj(opts.additionalContext) ? opts.additionalContext : {}), [`mod:${me}`]: { kind: 'application', value: said } };
    return next({ args: [content, { ...opts, additionalContext: context }] });
  });

  // ---- the project's chats as they change: updates for their orchestrators, and a word to an idle one when a chat finishes
  const pendingTell = new Map();   // orchestrator id -> timer
  const tell = (id) => {
    if (pendingTell.has(id)) return;
    pendingTell.set(id, setTimeout(async () => {
      pendingTell.delete(id);
      const list = updates.get(id) ?? [];
      const self = chats.get(id);
      if (!list.length || self?.state?.status !== 'idle') return;
      const ref = { type: 'CodexThread', provider: 'codex', id };
      const content = { parts: [{ kind: 'text', text: `Update from the project's chats:\n${list.map((u) => `- ${u}`).join('\n')}` }] };
      const may = await ctx.graph.assess(ref, 'send', [content], { automatic: 'update' }).catch(() => null);
      if (may?.status !== 'allowed') return;   // off: the orchestrator hears of it with the user's next message
      updates.set(id, []);
      await ctx.graph.invoke(ref, 'send', [content], { automatic: 'update' }).catch((e) => ctx.log.warn('the orchestrator could not be told', { message: String(e?.message ?? e) }));
    }, 15_000));
  };
  async function changed(before, after) {
    const text = changeOf(before, after);
    if (!text) return;
    for (const [id, o] of orchestrators) {
      if (id === after.ref.id) continue;
      const p = await projectOf(o.project);
      if (after.links?.project?.id !== o.project.id && !inFolder(after.state?.cwd, p?.state?.location)) continue;
      updates.set(id, [...(updates.get(id) ?? []), text].slice(-30));
      if (/ finished/.test(text)) tell(id);
    }
  }
  let members = new Map();
  const view = ctx.graph.subscribe({ type: 'CodexThread' }, (m) => {
    if (m?.type === 'snapshot') {
      members = new Map((m.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
      for (const [id, x] of members) chats.set(id, x);
    } else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
      const id = m.event.ref.id;
      const before = chats.get(id);
      if (m.event.kind === 'removed') { chats.delete(id); return; }
      if (!m.event.instance) return;
      chats.set(id, m.event.instance);
      void changed(before, m.event.instance);
    }
  });

  // ---- its tools: only an orchestrator calls them, on its own project
  const tools = ctx.graph.intercept('Tool', '_call', async (call, next) => {
    const [ns0, name] = String(call.ref?.id ?? '').split('/');
    if (ns0 !== ns) return next();
    const [args, env] = call.args;
    const self = env?.thread?.id;
    const o = self ? orchestrators.get(self) : null;
    if (!o) return { status: 'refused', reason: 'notAllowed', message: 'only a project\'s orchestrator chat uses these tools' };
    const a = isObj(args) ? args : {};
    const text = (v) => ({ status: 'done', value: typeof v === 'string' ? v : JSON.stringify(v) });
    const inProject = async (id) => (await projectChats(o.project, self)).find((t) => t.ref.id === id) ?? null;
    if (name === 'project_chats') return text((await projectChats(o.project, self)).map((t) => ({ id: t.ref.id, title: t.state?.title, status: t.state?.status, updatedAt: t.state?.updatedAt, preview: t.state?.preview ?? null })));
    if (name === 'chat_read') {
      const t = await inProject(String(a.id ?? ''));
      if (!t) return text('No such chat in this project.');
      const turns = (await ctx.graph.related(t.ref, 'turns').catch(() => [])).sort((x, y) => (x.state?.startedAt ?? 0) - (y.state?.startedAt ?? 0)).slice(-Math.min(Math.max(Number(a.turns) || 3, 1), 10));
      const out = [];
      for (const tu of turns) {
        const asked = (await ctx.graph.related(tu.ref, 'input').catch(() => [])).map((m) => textOf(m.state?.content)).join('\n');
        const answer = tu.links?.answer ? textOf((await ctx.graph.resolve(tu.links.answer).catch(() => null))?.state?.content) : '';
        out.push({ status: tu.state?.status, asked: clip(asked, 2000), answer: clip(answer, 4000) });
      }
      return text({ title: t.state?.title, turns: out });
    }
    if (name === 'chat_message') {
      const t = await inProject(String(a.id ?? ''));
      if (!t || typeof a.text !== 'string' || !a.text.trim()) return text('No such chat in this project, or no text.');
      const outcome = await ctx.graph.invoke(t.ref, 'send', [{ parts: [{ kind: 'text', text: a.text.trim() }] }]).catch((e) => ({ status: 'failed', message: String(e?.message ?? e) }));
      return text(outcome?.status === 'done' ? 'Sent.' : `Not sent: ${outcome?.message ?? outcome?.error?.message ?? outcome?.status}`);
    }
    if (name === 'chat_new') {
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) return text('A prompt is needed.');
      const outcome = await ctx.graph.invoke(o.project, 'newThread', [{ prompt: a.prompt.trim(), send: true, open: false }])
        .catch((e) => ({ status: 'failed', message: String(e?.message ?? e) }));
      return text(outcome?.status === 'done' ? `Started: ${outcome.value?.id ?? 'a new chat'}.` : `Not started: ${outcome?.message ?? outcome?.error?.message ?? outcome?.status}`);
    }
    return text(`No tool ${name}.`);
  }, { replaces: true, deadlineMs: 10 * 60_000 });

  // ---- the renderer's acts: it is about to start an orchestrator; then the chat that started is one
  const svc = ctx.services.provide('orchestrator', {
    async prepare({ project }, { caller }) {
      if (caller?.kind !== 'mod' || caller.id !== me) return { ok: false };
      const p = await projectOf(project);
      if (typeof p?.state?.location !== 'string') return { ok: false, message: 'the project has no folder' };
      pending = { location: p.state.location, until: Date.now() + 60_000 };
      return { ok: true, prompt: KICKOFF };
    },
    async adopt({ thread, project }, { caller }) {
      if (caller?.kind !== 'mod' || caller.id !== me || !isObj(thread) || !isObj(project)) return { ok: false };
      orchestrators.set(thread.id, { project: { type: project.type, provider: project.provider, id: project.id } });
      updates.set(thread.id, []);
      await ctx.graph.attach(thread, ROLE, 'orchestrator', { shared: true }).catch((e) => ctx.log.warn('the orchestrator\'s role was not kept on its chat', { message: String(e?.message ?? e) }));
      save();
      return { ok: true };
    },
    list: () => [...orchestrators].map(([id, o]) => ({ id, project: o.project })),
  });
  return () => { for (const t of pendingTell.values()) clearTimeout(t); svc.dispose(); tools.dispose(); view.dispose(); turn.dispose(); start.dispose(); skills.dispose(); };
}

export default { host };
