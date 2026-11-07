// codexmods.smart-composer, host entry (GOAL.md goal 24). Single-file ESM, no imports.
//
// Luna in the composer, through mod intelligence (`ctx.intelligence`; its model use is the user's to turn on):
// - **Clarifying questions.** When the user sends in a chat (its composer's Draft.send, held first), one short review of the message asks
//   the model what is unclear. If anything is, the send is stopped quietly (the text stays in the composer) and its questions show above the
//   composer (the renderer); answered, the answers go into the message and it is sent as the user's; skipped, it is sent as it was. A new
//   chat's first message goes as it is: the app makes the chat as the message is sent, and stopping it would leave an empty chat.
// - **Effort per message.** The same review says how much reasoning the task needs; the message's send (CodexThread.send) takes that effort,
//   among those the chat's model offers. The model stays the chat's own: changing it would lose the conversation's prompt cache, and the
//   effort keeps it. On a chat's first message, where there is no cache yet, the review may also pick between the two models the user sets.
//   Changing the user's send is this mod's act: it is made only while the user has its automatic action `effort` on (its page's "What it
//   may do without asking"), never asking at each message.
// - **Autocomplete** is the renderer's (`ui.composer.suggest`).
// A review that is off, refused (model use off, an allowance used) or slow lets the message go as it is.

export const REVIEW = 'You review a message a user is about to send to Codex, a coding agent, before it is sent. Reply with JSON only, no prose: '
  + '{"questions": [...], "effort": "low" | "medium" | "high" | "xhigh", "size": "small" | "large"}. '
  + '"questions": at most 3 short questions whose answers would change what the agent does; an empty list when the message is clear enough to act on. '
  + 'Never ask about details the agent can find out itself in the code. '
  + '"effort": how much reasoning the task needs: low for a quick question, lookup or small edit; medium for an ordinary change; high for a multi-step change or debugging; xhigh for hard design or a deep investigation. '
  + '"size": small when a fast model is enough, large when the task needs the strongest one.';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const FRESH_MS = 120_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content?.parts) ? content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');

/** The review's answer, read leniently (the first JSON object in it): its questions, effort and size, each checked. */
export function reviewOf(text) {
  const s = String(text ?? '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  let v;
  try { v = i >= 0 && j > i ? JSON.parse(s.slice(i, j + 1)) : null; } catch { v = null; }
  const questions = (Array.isArray(v?.questions) ? v.questions : []).filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim().slice(0, 200)).slice(0, 3);
  return { questions, effort: EFFORTS.includes(v?.effort) ? v.effort : null, size: v?.size === 'small' || v?.size === 'large' ? v.size : null };
}

/** The effort to send with: the one the review chose if the model offers it, else the nearest it offers (none: unchanged). */
export function effortFor(chosen, offered) {
  if (!chosen || !Array.isArray(offered) || !offered.length) return null;
  if (offered.includes(chosen)) return chosen;
  const want = EFFORTS.indexOf(chosen);
  const known = offered.filter((e) => EFFORTS.includes(e));
  if (!known.length) return null;
  return known.reduce((best, e) => (Math.abs(EFFORTS.indexOf(e) - want) < Math.abs(EFFORTS.indexOf(best) - want) ? e : best));
}

async function host(ctx) {
  const me = ctx.mod.id;
  let settings = await ctx.settings.get();
  const pending = new Map();    // draft id -> {draft, text, questions}
  const cleared = new Map();    // draft id -> the text that goes as it is (answered or skipped)
  const reviewed = new Map();   // message text -> {effort, size, at}
  const now = () => Date.now();

  async function review(text) {
    const out = await ctx.intelligence.ask({ prompt: text.slice(0, 20_000), instructions: REVIEW, timeoutMs: 10_000 });
    const r = reviewOf(out.text);
    reviewed.set(text, { effort: r.effort, size: r.size, at: now() });
    if (reviewed.size > 200) reviewed.delete(reviewed.keys().next().value);
    return r;
  }
  const freshReview = (text) => { const r = reviewed.get(text); return r && now() - r.at < FRESH_MS ? r : null; };

  // the user's send from a composer: the questions first, when there are any
  const send = ctx.graph.intercept('Draft', 'send', async (call, next) => {
    if (!settings.clarify) return next();
    // the user's send from this mod's own question card: the answered (or skipped) message, as they chose it
    if (call.caller?.through === me) { cleared.delete(call.ref.id); return next(); }
    const d = await ctx.graph.resolve(call.ref).catch(() => null);
    if (!d?.links?.thread) return next();   // a new chat's first message (see above)
    // what it sends: the composer's text as the send names it (the Draft's own content is saved a moment later)
    const text = (textOf(call.args?.[0]?.content) || textOf(d?.state?.content)).trim();
    if (!text) return next();
    if (cleared.get(call.ref.id) === text) { cleared.delete(call.ref.id); return next(); }
    let r;
    try { r = await review(text); } catch (e) { ctx.log.info('no review: the message goes as it is', { message: String(e?.message ?? e) }); return next(); }
    if (!r.questions.length) return next();
    pending.set(call.ref.id, { draft: call.ref, text, questions: r.questions });
    ctx.events.emit(`mod/${me}/questions`, { draft: call.ref.id });
    return { status: 'stopped' };
  });

  // the message as it goes: its effort (and on a chat's first message its model), as the review chose
  const effort = ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
    const [content, options] = call.args;
    const text = textOf(content).trim();
    if (!text) return next();
    let r = freshReview(text);
    if (!r) { try { r = await review(text); } catch { return next(); } }
    const o = isObj(options) ? options : {};
    const chat = await ctx.graph.resolve(call.ref).catch(() => null);
    const change = {};
    if (r.effort) {
      const model = chat?.links?.model ? await ctx.graph.resolve(chat.links.model).catch(() => null) : null;
      const offered = (Array.isArray(model?.state?.efforts) ? model.state.efforts : []).map((x) => (typeof x === 'string' ? x : x?.id)).filter((x) => typeof x === 'string');
      const e = effortFor(r.effort, offered);
      if (e) change.effort = e;
    }
    if (settings.pickModel && r.size) {
      const first = (await ctx.graph.related(call.ref, 'turns').catch(() => [])).length === 0;
      const model = r.size === 'small' ? settings.smallModel : settings.largeModel;
      if (first && typeof model === 'string' && model.trim()) change.model = model.trim();
    }
    if (!Object.keys(change).length) return next();
    const args = [content, { ...o, settings: { ...(isObj(o.settings) ? o.settings : {}), ...change } }];
    // changing the user's send is this mod's act: made only while the user has its automatic action on (never asking at each message)
    const may = await ctx.graph.assess(call.ref, 'send', args, { automatic: 'effort' }).catch(() => null);
    if (may?.status !== 'allowed') return next();
    ctx.log.info('a message sent with what its task needs', change);
    return next({ args, automatic: 'effort' });
  });

  const svc = ctx.services.provide('clarify', {
    /** The questions waiting on a composer's message (null: none). */
    get: ({ draft }) => { const p = pending.get(String(draft)); return p ? { text: p.text, questions: p.questions } : null; },
    /** The text that now goes as it is (the answered message, or the message itself when skipped): the next send of it passes. */
    clear: ({ draft, text }) => { const id = String(draft); pending.delete(id); if (typeof text === 'string') cleared.set(id, text.trim()); ctx.events.emit(`mod/${me}/questions`, { draft: id }); return null; },
  });
  const watch = ctx.settings.onChange((next) => { settings = next; });
  return () => { watch.dispose(); svc.dispose(); effort.dispose(); send.dispose(); };
}

export default { host };
