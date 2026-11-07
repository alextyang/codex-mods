// codexmods.better-questions, host entry (GOAL.md goal 22). Single-file ESM, Node built-ins only.
//
// Questions asked better:
// - its own tool, `ask_user`, which the agent is told to use for the user's input: a form of any setting kinds (a choice, a toggle, a
//   number, a text), asked in this mod's Questions view (a popup window or a tab beside the chat, the renderer); the tool waits for the
//   answer up to ten minutes, then tells the agent the answer comes as the user's next message, which this mod sends when it comes;
// - Codex's own questions (CodexQuestion, pending) shown in the same view, answered there as the user;
// - by iMessage (through the user's own Sendblue account): a question still open after a while is texted, and the first reply answers it
//   (the mod's automatic action `imessage`).
// The pending questions are kept in this mod's storage, so a question survives a restart.
import { createHash, randomBytes } from 'node:crypto';

const TOOL = 'ask_user';
const QUESTIONS_KEY = 'questions';
const WAIT_MS = 10 * 60_000 - 15_000;   // the tool's own limit is ten minutes
const FIELDS_MAX = 12;
const KINDS = new Set(['choice', 'toggle', 'text', 'number']);
const SENDBLUE = 'https://api.sendblue.co';
const POLL_MS = 20_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The namespace of this mod's tools as the agent sees them (the framework's rule: `mod_` and the id, `.` as `_`). */
export function namespaceOf(modId) {
  const id = String(modId), ns = `mod_${id.replace(/[^A-Za-z0-9-]/g, '_')}`;
  if (/^[a-z0-9.-]+$/.test(id) && ns.length <= 63) return ns;
  return `${ns.slice(0, 43).padEnd(43, '_')}_${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
}

export const INPUT = {
  type: 'object',
  required: ['title', 'fields'],
  properties: {
    title: { type: 'string', description: 'The question, in one line.' },
    message: { type: 'string', description: 'What the user needs to know to answer.' },
    fields: {
      type: 'array', minItems: 1, maxItems: FIELDS_MAX, description: 'What to ask, one field per answer.',
      items: {
        type: 'object', required: ['key', 'title', 'kind'],
        properties: {
          key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
          kind: { type: 'string', enum: [...KINDS] },
          options: { type: 'array', items: { type: 'string' }, description: 'A choice\'s options.' },
          other: { type: 'boolean', description: 'A choice also takes the user\'s own words.' },
        },
      },
    },
  },
};
export const INSTRUCTIONS = `When you need the user's input or a decision, call the tool ${TOOL} (in your mod tools) with a short form, instead of asking in plain text or with request_user_input. One field per thing you need; offer choices where you can. Its answer is the user's.`;

/** A question from the tool's arguments: its prompts as the framework's question card takes them, or an error. */
export function questionOf(args) {
  if (!isObj(args)) return { error: 'ask_user takes {title, message?, fields}' };
  const title = clip(args.title, 200);
  if (!title) return { error: 'a question needs a title' };
  if (!Array.isArray(args.fields) || !args.fields.length || args.fields.length > FIELDS_MAX) return { error: `1 to ${FIELDS_MAX} fields` };
  const prompts = [];
  for (const f of args.fields) {
    if (!isObj(f) || !KINDS.has(f.kind)) return { error: `a field's kind is one of ${[...KINDS].join(', ')}` };
    const key = clip(f.key, 64).replace(/[^A-Za-z0-9_-]/g, '_') || `field${prompts.length + 1}`;
    if (prompts.some((p) => p.id === key)) return { error: `${key}: asked twice` };
    const header = clip(f.title, 80) || key;
    const text = clip(f.description, 500);
    const prompt = { id: key, header, prompt: { parts: [{ kind: 'text', text: text || header }] }, kind: f.kind };
    if (f.kind === 'choice') {
      const options = (Array.isArray(f.options) ? f.options : []).map((o) => clip(String(o), 80)).filter(Boolean).slice(0, 12);
      if (options.length < 2) return { error: `${key}: a choice needs at least two options` };
      prompt.choices = options.map((label, i) => ({ id: String(i + 1), label }));
      prompt.other = f.other === true;
    } else if (f.kind === 'toggle') prompt.choices = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
    else prompt.other = true;
    prompts.push(prompt);
  }
  return { question: { title, message: clip(args.message, 2000), prompts } };
}

/** The card's answers as the agent reads them: each field's value by its key. */
export function answersOf(q, answers) {
  const out = {};
  for (const p of q.prompts) {
    const a = isObj(answers?.[p.id]) ? answers[p.id] : {};
    const chosen = (Array.isArray(a.choices) ? a.choices : []).map((id) => p.choices?.find((c) => c.id === id)?.label).filter(Boolean);
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (p.kind === 'toggle') out[p.id] = chosen[0] === 'Yes' ? true : chosen[0] === 'No' ? false : null;
    else if (p.kind === 'number') { const v = Number(text); out[p.id] = text && Number.isFinite(v) ? v : null; }
    else if (p.kind === 'choice') out[p.id] = chosen[0] ?? (text || null);
    else out[p.id] = text || null;
  }
  return out;
}

/** A question as a text message (iMessage), with its code; and a reply read back as answers (one field per line, a number picks a choice). */
export function textOf(q, code) {
  const lines = [`Codex asks (${code}): ${q.title}`];
  if (q.message) lines.push(q.message);
  q.prompts.forEach((p, i) => {
    const label = q.prompts.length > 1 ? `${i + 1}. ${p.header}` : p.header;
    lines.push(p.choices ? `${label}: ${p.choices.map((c, j) => `${j + 1}) ${c.label}`).join('  ')}` : `${label}: (your words)`);
  });
  lines.push(q.prompts.length > 1 ? 'Reply with one answer per line.' : 'Reply with your answer.');
  return lines.join('\n');
}
export function replyAnswers(q, text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const answers = {};
  q.prompts.forEach((p, i) => {
    const line = (lines[i] ?? '').replace(/^\d+[.)]\s*/, (m) => (q.prompts.length > 1 ? '' : m));
    if (!line) return;
    if (p.choices) {
      const n = Number.parseInt(line, 10);
      const byIndex = Number.isInteger(n) && n >= 1 && n <= p.choices.length ? p.choices[n - 1] : null;
      const byLabel = p.choices.find((c) => c.label.toLowerCase() === line.toLowerCase());
      const c = byIndex ?? byLabel;
      answers[p.id] = c ? { choices: [c.id] } : p.other ? { text: line } : {};
    } else answers[p.id] = { text: line };
  });
  return answers;
}

async function host(ctx) {
  const ns = namespaceOf(ctx.mod.id);
  const waiting = new Map();   // question id -> resolve(answers) of a tool call still waiting
  let settings = await ctx.settings.get();
  const sub = ctx.settings.onChange((s) => { settings = s; });
  const listOf = async () => { const v = await ctx.storage.get(QUESTIONS_KEY); return isObj(v) ? v : {}; };
  const put = (id, q) => ctx.storage.transaction((tx) => { const all = isObj(tx.get(QUESTIONS_KEY)) ? tx.get(QUESTIONS_KEY) : {}; if (q) all[id] = q; else delete all[id]; tx.set(QUESTIONS_KEY, all); });
  const told = () => { try { ctx.events.emit(`mod/${ctx.mod.id}/questions`, { at: Date.now() }); } catch { /* no listener */ } };

  // ---- the agent: told to use the tool; the tool at each new thread's start; its calls answered here
  const spec = { type: 'function', name: TOOL, description: 'Ask the user with a form: one field per answer (choice, toggle, number or text). Returns their answers by field key.', inputSchema: INPUT };
  const handles = [
    ctx.graph.intercept('CodexAgent', '_startThread', async (call, next) => {
      const [p] = call.args;
      if (!isObj(p) || p.ephemeral === true) return next();
      const tools = Array.isArray(p.dynamicTools) ? p.dynamicTools : [];
      const mine = tools.find((t) => t?.type === 'namespace' && t.name === ns);
      const dynamicTools = mine ? tools.map((t) => (t === mine ? { ...t, tools: [...(t.tools ?? []).filter((x) => x?.name !== TOOL), spec] } : t))
        : [...tools, { type: 'namespace', name: ns, description: `Tools of the mod ${ctx.mod.id}`, tools: [spec] }];
      const block = `<mod_instructions mod="${ctx.mod.id}">\n${INSTRUCTIONS}\n</mod_instructions>`;
      const developerInstructions = typeof p.developerInstructions === 'string' && p.developerInstructions.includes(block) ? p.developerInstructions : [p.developerInstructions, block].filter(Boolean).join('\n\n');
      return next({ args: [{ ...p, dynamicTools, developerInstructions }] });
    }),
    ctx.graph.intercept('Tool', '_call', async (call, next) => {
      if (call.ref?.id !== `${ns}/${TOOL}`) return next();
      const [args, env] = call.args;
      const made = questionOf(args);
      if (made.error) return { status: 'failed', error: { message: `${TOOL}: ${made.error}` } };
      const id = `q-${randomBytes(6).toString('hex')}`;
      await put(id, { ...made.question, id, thread: env?.thread ?? null, askedAt: Date.now(), via: 'tool', waiting: true });
      told();
      void openFor(env?.thread ?? null);
      const answers = await new Promise((resolve) => { waiting.set(id, resolve); setTimeout(() => resolve(null), WAIT_MS).unref?.(); });
      waiting.delete(id);
      // what the agent gets back: text (the SDK's AgentContent), its answers by field
      if (answers) { await put(id, null); told(); return { status: 'done', value: JSON.stringify({ answers }) }; }
      await put(id, { ...(await listOf())[id], waiting: false });
      return { status: 'done', value: 'The user has not answered yet. Their answer comes as their next message; go on with what does not need it, or stop and wait.' };
    }, { replaces: true, deadlineMs: 10 * 60_000 }),
  ];

  /** Where the questions open: a popup window, or a tab beside the chat; told to the renderer of the window in front. */
  async function openFor(thread) {
    if (settings.popup === 'off') return;
    try { ctx.events.emit(`mod/${ctx.mod.id}/open`, { placement: settings.popup === 'tab' ? 'side' : 'window', thread }); } catch { /* no window */ }
    try { ctx.ui.notify({ id: 'question', dedupe: true, title: 'Codex has a question', body: 'Open it to answer.', surface: 'auto', actions: [] }); } catch { /* no window */ }
  }

  // ---- the answer: from the view (the user's own click) or a reply by iMessage
  async function answer(id, answers, by) {
    const q = (await listOf())[id];
    if (!q) return { status: 'refused', reason: 'unavailable', message: 'this question was answered already' };
    const value = answersOf(q, answers);
    const resolve = waiting.get(id);
    if (resolve) { resolve(value); return { status: 'done' }; }
    // the tool stopped waiting: the answer goes to the chat as the user's next message (G6.3: a later act, with a key)
    if (q.thread) {
      const text = `My answer to "${q.title}": ${JSON.stringify(value)}`;
      const out = await ctx.graph.invoke(q.thread, 'send', [{ parts: [{ kind: 'text', text }] }], by === 'user' ? {} : { automatic: 'imessage', key: `answer:${id}` });
      if (out?.status !== 'done') return out;
    }
    await put(id, null); told();
    return { status: 'done' };
  }
  handles.push(ctx.services.provide('questions', {
    list: async () => Object.values(await listOf()),
    answer: async ({ id, answers } = {}) => answer(String(id), answers, 'user'),
    dismiss: async ({ id } = {}) => { const r = waiting.get(String(id)); if (r) r(null); await put(String(id), null); told(); return true; },
  }));

  // ---- Codex's own questions: told to the view as they come
  handles.push(ctx.graph.subscribe({ type: 'CodexQuestion', where: { status: 'pending' } }, (m) => {
    if (m?.type === 'delta' && m.event?.kind === 'added' && m.event.instance) void openFor(m.event.instance.links?.thread ?? null);
    if (m?.type === 'snapshot' || m?.type === 'delta') told();
  }));

  // ---- iMessage, through the user's own Sendblue account: a question open longer than the setting is texted; the first reply answers it
  const out = new Map();   // question id -> {code, sentAt}
  async function credentials() {
    const [key, secret] = await Promise.all([ctx.secrets.get('sendblue.key').catch(() => null), ctx.secrets.get('sendblue.secret').catch(() => null)]);
    return key && secret && settings.phone ? { key, secret, phone: settings.phone } : null;
  }
  const sendblue = async (c, method, path, body) => {
    const res = await fetch(`${SENDBLUE}${path}`, { method, headers: { 'content-type': 'application/json', 'sb-api-key-id': c.key, 'sb-api-secret-key': c.secret }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`Sendblue answered ${res.status}`);
    return res.json();
  };
  async function poll() {
    if (settings.imessage !== true) return;
    const c = await credentials();
    if (!c) return;
    const all = await listOf();
    const due = Object.values(all).filter((q) => q.via === 'tool' && Date.now() - q.askedAt >= (settings.imessageAfterMinutes ?? 2) * 60_000);
    for (const q of due) {
      if (out.has(q.id) || out.size >= 1) continue;   // one open question per recipient: a reply is matched to it
      const code = q.id.slice(-4).toUpperCase();
      try { await sendblue(c, 'POST', '/api/send-message', { number: c.phone, content: textOf(q, code) }); out.set(q.id, { code, sentAt: Date.now() }); }
      catch (e) { ctx.log.warn('a question was not texted', { error: String(e?.message ?? e) }); }
    }
    for (const [id, o] of out) {
      if (!all[id]) { out.delete(id); continue; }
      try {
        const list = await sendblue(c, 'GET', `/api/v2/messages?number=${encodeURIComponent(c.phone)}&is_outbound=false&created_at_gte=${encodeURIComponent(new Date(o.sentAt).toISOString())}`);
        const reply = (Array.isArray(list?.data) ? list.data : []).find((m) => typeof m?.content === 'string' && m.content.trim());
        if (reply) { out.delete(id); await answer(id, replyAnswers(all[id], reply.content.replace(new RegExp(`\\b${o.code}\\b`, 'i'), '').trim()), 'imessage'); }
      } catch (e) { ctx.log.warn('iMessage replies were not read', { error: String(e?.message ?? e) }); }
    }
  }
  const timer = setInterval(() => { void poll(); }, POLL_MS);
  timer.unref?.();

  return () => { clearInterval(timer); sub.dispose(); for (const h of handles) { try { h.dispose(); } catch { /* gone */ } } for (const r of waiting.values()) r(null); };
}

export default { host };
