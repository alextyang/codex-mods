// codexmods.claude-code, host entry (GOAL.md goal 23). Single-file ESM, Node built-ins only.
//
// A Claude Code agent. Its kinds (ClaudeAgent, a subtype of Agent; ClaudeThread, of Thread; ClaudeEdit and ClaudeTool, of Step) are
// registered with the graph and their instances are this mod's: the agent and its models, its chats, each turn with what was asked, its
// steps (commands, edits, other tools, thinking), the approvals Claude Code asks and the answer as it streams. The framework lists its chats
// with Codex's (the sidebar's group for the agent, search, the palette, notifications) and opens them to the view the renderer registers.
//
// Each chat runs a real Claude Code session: the program `claude` (found on the user's PATH; consent names it) as one instance of this mod's
// session process, `claude#<chat>`, in the chat's project folder, spoken to in stream-json: a user line per message, its events read line
// by line, an approval it asks (`can_use_tool`, as it asks an SDK host: `--permission-prompt-tool stdio`) answered on its input, Stop as an
// interrupt (after which it ends). The user's own Claude Code settings apply (their permission mode, their allowed tools). The session's id
// is kept with the chat, so a chat goes on (`--resume`) after its session ends: when the app restarts, when it was idle a while (it is
// stopped then) or when another chat needed its place (as many run at once as mod.json declares). What it provides is kept in its storage.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const AGENT = 'ClaudeAgent', THREAD = 'ClaudeThread', EDIT = 'ClaudeEdit', TOOL = 'ClaudeTool';
const str = (tier = 'core') => ({ member: 'state', schema: { t: 'string' }, tier });
const TYPES = [
  { id: AGENT, kind: 'subtype', parent: 'Agent', spec: { relations: { models: { member: 'relation', target: 'Model', cardinality: 'many', tier: 'core', owned: false, inverseOf: 'agent' } } } },
  // its Claude Code session (what `--resume` goes on with) and the folder it works in
  { id: THREAD, kind: 'subtype', parent: 'Thread', spec: { state: { sessionId: str('optional'), cwd: str('optional') } } },
  { id: EDIT, kind: 'subtype', parent: 'Step', spec: { state: { path: str(), diff: str() } } },
  { id: TOOL, kind: 'subtype', parent: 'Step', spec: { state: { tool: str() } } },
];
export const MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet', description: 'Claude Code\'s everyday model', default: true },
  { id: 'opus', name: 'Claude Opus', description: 'The most capable' },
  { id: 'haiku', name: 'Claude Haiku', description: 'The fastest' },
];
export const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--permission-prompt-tool', 'stdio'];
/** How long a chat's session runs with nothing to do before it is stopped (its next message resumes it). */
export const IDLE_MS = 10 * 60_000;
export const OPTIONS = [
  { id: 'once', label: 'Allow once', kind: 'approve', scope: 'once' },
  { id: 'thread', label: 'Allow for this chat', kind: 'approve', scope: 'thread' },
  { id: 'deny', label: "Don't allow", kind: 'deny' },
];
const STORE = 'chats';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const said = (text) => ({ parts: [{ kind: 'text', text: String(text) }] });
const textOf = (content) => (Array.isArray(content?.parts) ? content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');

/** A unified diff of an edit Claude Code made, from its tool's input (Edit, MultiEdit, Write). */
export function diffOf(name, input) {
  const path = String(input?.file_path ?? input?.path ?? 'file');
  const lines = (s) => String(s ?? '').split('\n');
  const hunk = (a, b) => [`@@ -1,${lines(a).length} +1,${lines(b).length} @@`, ...lines(a).map((l) => `-${l}`), ...lines(b).map((l) => `+${l}`)].join('\n');
  const body = name === 'Write' ? hunk('', input?.content)
    : name === 'MultiEdit' ? (Array.isArray(input?.edits) ? input.edits : []).map((e) => hunk(e.old_string, e.new_string)).join('\n')
      : hunk(input?.old_string, input?.new_string);
  return { path, diff: `--- a/${path}\n+++ b/${path}\n${body}` };
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write']);
/** What a tool call is, as a step: a command (Bash), run in `dir`; an edit (Edit, MultiEdit, Write); or another tool. */
export function stepOf(name, input, dir) {
  if (name === 'Bash') return { type: 'CommandRun', state: { title: clip(input?.description || `Run ${input?.command ?? ''}`, 200), command: String(input?.command ?? ''), directory: String(dir), output: '' } };
  if (EDITS.has(name)) {
    const { path, diff } = diffOf(name, input);
    return { type: EDIT, state: { title: `${name === 'Write' ? 'Wrote' : 'Edited'} ${path.split('/').pop()}`, path, diff } };
  }
  const what = input?.pattern ?? input?.file_path ?? input?.path ?? input?.url ?? input?.query ?? '';
  return { type: TOOL, state: { title: clip(`${name}${what ? ` ${what}` : ''}`, 200), tool: String(name) } };
}
/** The approval a tool's use asks, by its tool: a command's (run in `dir`), an edit's (the file it writes), another tool's (its input). */
export function requestOf(name, input, dir) {
  if (name === 'Bash') return { type: 'CommandApproval', state: { command: String(input?.command ?? ''), directory: String(dir) } };
  if (EDITS.has(name)) return { type: 'EditApproval', state: { files: [{ path: String(input?.file_path ?? input?.path ?? 'file'), change: name === 'Write' ? 'add' : 'update' }] } };
  return { type: 'ToolApproval', state: { input: said(clip(JSON.stringify(input ?? {}), 4000)) } };
}

/** Claude Code's input lines: a user message, an answer to a control request, an interrupt. */
export const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
export const answerLine = (requestId, allow, input) => `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
  response: allow ? { behavior: 'allow', updatedInput: input ?? {} } : { behavior: 'deny', message: 'The user did not allow it.' } } })}\n`;
export const interruptLine = (id) => `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })}\n`;

async function host(ctx) {
  const me = ctx.mod.id;
  const ref = (type, id) => ({ type, provider: me, id });
  const agent = ref(AGENT, 'claude');
  const records = new Map();   // id -> {ref, state, links}
  const live = new Map();      // chat id -> {key, turn, answer, steps: Map(tool_use_id -> step ref), allowed: Set(tool names), listeners}
  const waiting = new Map();   // request id -> {chat, requestId, input, tool}
  let seq = 0;
  let provider = null;
  const nid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  // kept only once the graph took it (a put it refused is not kept, nor saved)
  async function put(r, state, links = {}) { await provider.put(r, { state, links }); records.set(r.id, { ref: r, state, links }); }
  async function update(r, state, links) {
    await provider.update(r, { state, ...(links ? { links } : {}) });
    const rec = records.get(r.id);
    if (rec) { rec.state = { ...rec.state, ...state }; if (links) rec.links = { ...rec.links, ...links }; }
  }
  let saving = null;
  const save = () => { saving ??= setTimeout(() => { saving = null; ctx.storage.set(STORE, { seq, records: [...records.values()] }).catch(() => {}); }, 300); };
  const keyOf = (chatId) => chatId.replace(/[^A-Za-z0-9_-]/g, '_').slice(-64);
  const answeredBy = (c) => ({ ...startedBy(c), at: Date.now() });
  const startedBy = (c) => (c?.kind === 'mod' ? { kind: 'mod', id: String(c.id) }
    : c?.kind === 'user' || c?.kind === 'framework' ? { kind: 'user', ...(typeof c.through === 'string' ? { through: c.through } : {}) } : { kind: 'app' });

  // ---- a chat's session: started for its first message (or after it ended), its output read here
  async function session(chat) {
    const rec = records.get(chat.id);
    let s = live.get(chat.id);
    if (!s) { s = { key: keyOf(chat.id), turn: null, answer: null, text: '', steps: new Map(), allowed: new Set(), listeners: [], running: false, stopping: false, idle: null, usedAt: 0, chain: Promise.resolve() }; live.set(chat.id, s); }
    clearTimeout(s.idle); s.idle = null; s.usedAt = Date.now();
    if (s.running) return s;
    const name = `claude#${s.key}`;
    for (const l of s.listeners) l.dispose();
    // its lines are taken one after another (each may write to the graph), its end after them
    const next = (fn) => { s.chain = s.chain.then(fn).catch((e) => ctx.log.warn('a line of Claude Code was not taken', { message: String(e?.message ?? e) })); };
    s.listeners = [
      ctx.processes.on(name, 'output', (d) => { if (d?.stream === 'stdout') next(() => onLine(chat, s, d.line)); else if (d?.line) ctx.log.debug('claude says', { line: clip(d.line, 300) }); }),
      ctx.processes.on(name, 'exited', () => { s.running = false; clearTimeout(s.idle); s.idle = null; next(() => ended(chat, s)); }),
    ];
    const model = rec?.links?.model?.id ?? 'sonnet';
    const sid = rec?.state?.sessionId;
    const args = [...BASE_ARGS, '--model', model, ...(sid ? ['--resume', sid] : ['--session-id', randomUUID()])];
    const cwd = dirOf(rec);
    const start = () => ctx.processes.start(name, { args, ...(cwd ? { cwd } : {}) });
    try { await start(); } catch (e) {
      // as many as run at once: the session idle longest gives its place (its chat resumes it at its next message)
      const idle = [...live.values()].filter((x) => x !== s && x.running && !x.turn).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (e?.code !== 'Busy' || !idle) throw e;
      await ctx.processes.stop(`claude#${idle.key}`).catch(() => {});
      idle.running = false;
      await start();
    }
    s.running = true;
    return s;
  }
  /** A session with nothing to do is stopped after a while. */
  function rest(s) {
    clearTimeout(s.idle);
    s.usedAt = Date.now();
    s.idle = setTimeout(() => { s.idle = null; if (s.running && !s.turn) ctx.processes.stop(`claude#${s.key}`).catch(() => {}); }, IDLE_MS);
    s.idle.unref?.();
  }
  const dirOf = (rec) => (typeof rec?.state?.cwd === 'string' && rec.state.cwd.startsWith('/') ? rec.state.cwd : undefined);
  // the session ended: a turn it was on was stopped (Claude Code ends after an interrupt) or cut short
  async function ended(chat, s) {
    if (s.turn && records.get(s.turn.id)?.state.status === 'running') await finish(chat, s, s.stopping ? 'stopped' : 'failed', s.stopping ? undefined : 'Claude Code ended');
  }
  async function finish(chat, s, status, error) {
    const now = Date.now();
    if (s.answer) await update(s.answer, { streaming: false });
    if (s.turn) await update(s.turn, { status, endedAt: now, ...(error ? { error } : {}), ...(status === 'stopped' && s.stoppedBy ? { stoppedBy: s.stoppedBy } : {}) });
    for (const [id, w] of waiting) if (w.chat.id === chat.id) { waiting.delete(id); await update(ref(w.type, id), { status: 'cancelled' }).catch(() => {}); }
    for (const step of s.steps.values()) if (['running', 'waitingForYou'].includes(records.get(step.id)?.state.status)) await update(step, { status: 'cancelled', endedAt: now });
    s.turn = null; s.answer = null; s.text = ''; s.stopping = false; s.stoppedBy = null; s.steps.clear();
    if (s.running) rest(s);
    await update(chat, { status: 'idle', unread: true, updatedAt: now });
    save();
  }

  /** One line of Claude Code's output: its stream-json events, mapped onto the chat's turn. */
  async function onLine(chat, s, line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!isObj(e)) return;
    if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') {
      await update(chat, { sessionId: e.session_id }); save(); return;
    }
    const turn = s.turn;
    if (!turn) return;
    if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta' && typeof e.event.delta.text === 'string') {
      s.text += e.event.delta.text;
      if (!s.answer) { s.answer = ref('AgentMessage', nid('reply')); await put(s.answer, { content: said(s.text), createdAt: Date.now(), phase: 'final', streaming: true }, { turn }); await update(turn, {}, { answer: s.answer }); }
      else await update(s.answer, { content: said(s.text) });
      return;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          await put(ref('Reasoning', nid('step')), { status: 'done', title: 'Thinking', startedAt: Date.now(), endedAt: Date.now(), thinking: said(block.thinking) }, { turn });
        } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const st = stepOf(String(block.name), block.input, dirOf(records.get(chat.id)) ?? homedir());
          const step = ref(st.type, nid('step'));
          s.steps.set(block.id, step);
          await put(step, { status: 'running', startedAt: Date.now(), ...st.state }, { turn });
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          s.text = block.text;   // the message whole: what streamed, or the text when nothing streamed
          if (!s.answer) { s.answer = ref('AgentMessage', nid('reply')); await put(s.answer, { content: said(s.text), createdAt: Date.now(), phase: 'final', streaming: true }, { turn }); await update(turn, {}, { answer: s.answer }); }
          else await update(s.answer, { content: said(s.text) });
        }
      }
      return;
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type !== 'tool_result') continue;
        const step = s.steps.get(block.tool_use_id);
        if (!step) continue;
        const out = Array.isArray(block.content) ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : String(block.content ?? '');
        await update(step, { status: block.is_error ? 'failed' : 'done', endedAt: Date.now(), ...(step.type === 'CommandRun' ? { output: clip(out, 64_000) } : {}) });
      }
      return;
    }
    if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && typeof e.request_id === 'string') {
      const tool = String(e.request.tool_name ?? 'tool');
      const shown = typeof e.request.display_name === 'string' && e.request.display_name ? e.request.display_name : tool;
      if (s.allowed.has(tool)) { await ctx.processes.write(`claude#${s.key}`, answerLine(e.request_id, true, e.request.input)); return; }
      const rq = requestOf(tool, e.request.input, dirOf(records.get(chat.id)) ?? homedir());
      const r = ref(rq.type, nid('req'));
      const step = s.steps.get(e.request.tool_use_id);
      waiting.set(r.id, { chat, requestId: e.request_id, input: e.request.input, tool, type: rq.type, step });
      if (step) await update(step, { status: 'waitingForYou' });
      await put(r, { status: 'pending', from: 'agent', askedAt: Date.now(), reason: clip(`Claude Code wants to use ${shown}${typeof e.request.description === 'string' && e.request.description ? `: ${e.request.description}` : ''}`, 500), options: OPTIONS, ...rq.state },
        { thread: chat, turn, ...(step ? { step } : {}) });
      await update(chat, { status: 'waitingForYou' });
      return;
    }
    if (e.type === 'result') {
      const failed = !s.stopping && (e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'));
      await finish(chat, s, s.stopping ? 'stopped' : failed ? 'failed' : 'completed',
        failed ? clip(String(e.result ?? e.subtype ?? 'Claude Code failed'), 500) : undefined);
    }
  }

  // ---- what the user and other mods do
  // a new chat from a Draft (its target's project and model) or a spec ({project}): in that project's folder
  async function newThread({ args: [given] }) {
    const now = Date.now();
    const t = ref(THREAD, nid('chat'));
    let cwd = null, project = null, model = MODELS.find((m) => m.default).id;
    const d = given?.type === 'Draft' ? await ctx.graph.resolve(given).catch(() => null) : null;
    if (d && !d.gone) {
      project = d.state?.target?.project ?? null;
      const m = d.state?.target?.model;
      if (m?.provider === me && MODELS.some((x) => x.id === m.id)) model = m.id;
    } else if (isObj(given) && isObj(given.project) && typeof given.project.id === 'string') project = { type: given.project.type, provider: given.project.provider, id: given.project.id };
    if (project) cwd = (await ctx.graph.resolve(project).catch(() => null))?.state?.location ?? null;
    await put(t, { title: 'New Claude Code chat', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: now, updatedAt: now,
      ...(typeof cwd === 'string' && cwd.startsWith('/') ? { cwd } : {}) }, { agent, model: ref('Model', model), ...(project ? { project } : {}) });
    save();
    return t;
  }
  async function send({ ref: chat, args: [content], caller }) {
    const text = textOf(content).trim();
    if (!text) return { status: 'refused', reason: 'invalid', message: 'a message is needed' };
    const rec = records.get(chat.id);
    if (!rec) return { status: 'refused', reason: 'unavailable', message: 'no such chat' };
    if (rec.state.status === 'working' || rec.state.status === 'waitingForYou') return { status: 'refused', reason: 'unavailable', message: 'Claude Code is still on the last message' };
    let s;
    try { s = await session(chat); } catch (e) { return { status: 'failed', error: { message: `Claude Code did not start: ${String(e?.message ?? e)}` } }; }
    const now = Date.now();
    const turn = ref('Turn', nid('turn'));
    await put(turn, { status: 'running', startedAt: now, startedBy: startedBy(caller) }, { thread: chat });
    await put(ref('UserMessage', nid('msg')), { content: said(text), createdAt: now, steering: false }, { turn });
    s.turn = turn; s.answer = null; s.text = '';
    await update(chat, { status: 'working', updatedAt: now, preview: clip(text, 80), ...(rec.state.title === 'New Claude Code chat' ? { title: clip(text, 60) } : {}) });
    await ctx.processes.write(`claude#${s.key}`, userLine(text));
    save();
    return turn;
  }
  async function stop({ ref: chat, caller }) {
    const s = live.get(chat.id);
    if (!s?.running || !s.turn) return null;
    s.stopping = true; s.stoppedBy = startedBy(caller);
    await ctx.processes.write(`claude#${s.key}`, interruptLine(`stop-${Date.now()}`)).catch(() => {});
    return null;
  }
  async function answer({ ref: r, args: [optionId], caller }) {
    const w = waiting.get(r.id);
    if (!w) return { status: 'refused', reason: 'unavailable', message: 'the request is no longer open' };
    const option = OPTIONS.find((o) => o.id === optionId);
    if (!option) return { status: 'refused', reason: 'unsupported', message: `no option ${optionId}` };
    waiting.delete(r.id);
    const s = live.get(w.chat.id);
    const allow = option.kind === 'approve';
    if (allow && option.scope === 'thread') s?.allowed.add(w.tool);
    await ctx.processes.write(`claude#${s?.key ?? keyOf(w.chat.id)}`, answerLine(w.requestId, allow, w.input));
    await update(r, { status: allow ? 'answered' : 'declined', answeredAt: Date.now(),
      outcome: { decision: allow ? 'approved' : 'denied', ...(option.scope ? { scope: option.scope } : {}), option: option.id }, answeredBy: answeredBy(caller) });
    if (w.step && allow) await update(w.step, { status: 'running' });
    if (s?.turn) await update(w.chat, { status: 'working' });
    return null;
  }
  const change = (patch) => async ({ ref: t }) => { await update(t, { ...patch, updatedAt: Date.now() }); save(); return null; };
  async function setModel({ ref: chat, args: [model] }) {
    if (model?.provider !== me || !MODELS.some((m) => m.id === model.id)) return { status: 'refused', reason: 'invalid', message: `${model?.id ?? 'that'} is not one of Claude Code's models` };
    await update(chat, {}, { model: ref('Model', model.id) });
    const s = live.get(chat.id);
    if (s?.running && !s.turn) await ctx.processes.stop(`claude#${s.key}`).catch(() => {});   // the next message starts it with the new model
    save();
    return null;
  }

  await ctx.graph.registerTypes(TYPES);
  provider = ctx.graph.provide({
    types: {
      [AGENT]: { operations: { newThread: { effect: 'local', handler: newThread } } },
      Model: {},
      [THREAD]: {
        operations: {
          send: { effect: 'external', handler: send },
          stop: { effect: 'local', handler: stop },
          setModel: { effect: 'local', handler: setModel },
          rename: { effect: 'local', handler: ({ ref: t, args: [title] }) => change({ title: clip(String(title), 120) })({ ref: t }) },
          archive: { effect: 'local', handler: change({ archived: true }) },
          restore: { effect: 'local', handler: change({ archived: false }) },
          markRead: { effect: 'local', handler: change({ unread: false }) },
        },
      },
      Turn: {}, UserMessage: {}, AgentMessage: {}, Reasoning: {}, CommandRun: {}, [EDIT]: {}, [TOOL]: {},
      CommandApproval: { operations: { answer: { effect: 'local', handler: answer } } },
      EditApproval: { operations: { answer: { effect: 'local', handler: answer } } },
      ToolApproval: { operations: { answer: { effect: 'local', handler: answer } } },
    },
  });
  await provider.put(agent, { state: { name: 'Claude Code', icon: 'terminal', available: true }, links: {} });
  for (const m of MODELS) await provider.put(ref('Model', m.id), { state: { name: m.name, description: m.description, efforts: [], default: m.default === true, available: true }, links: { agent } });
  await provider.setComplete(AGENT, true);
  await provider.setComplete('Model', true);
  // its chats as it kept them; what a restart cut short ends there, and each chat goes on in its session (--resume) at its next message
  const kept = await ctx.storage.get(STORE);
  seq = Number.isSafeInteger(kept?.seq) ? kept.seq : 0;
  for (const r of Array.isArray(kept?.records) ? kept.records : []) {
    const state = { ...r.state };
    if (r.ref.type === 'Turn' && state.status === 'running') Object.assign(state, { status: 'failed', endedAt: Date.now(), error: 'The app restarted' });
    if (r.ref.type === THREAD) state.status = 'idle';
    if (state.status === 'pending') state.status = 'cancelled';
    if (state.status === 'running' || state.status === 'waitingForYou') state.status = 'cancelled';
    if (state.streaming === true) state.streaming = false;
    await put(ref(r.ref.type, r.ref.id), state, r.links ?? {});
  }
  await provider.setComplete(THREAD, true);
  return async () => {
    clearTimeout(saving);
    await ctx.storage.set(STORE, { seq, records: [...records.values()] });
    for (const s of live.values()) { clearTimeout(s.idle); for (const l of s.listeners) l.dispose(); }
  };
}

export default { host };
