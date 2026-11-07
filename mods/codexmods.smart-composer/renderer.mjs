// codexmods.smart-composer, renderer entry (GOAL.md goal 24). Single-file ESM, no imports.
//
// - **Autocomplete:** an inline suggestion in every composer (`ui.composer.suggest`): at a pause at the end of a line, Luna continues what
//   the user is typing; Tab takes it.
// - **Clarifying questions:** above a composer whose message the host stopped to ask about (its `clarify` service), the framework's
//   question card; answered, the answers go into the message and it is sent as the user's; skipped, it is sent as it was.

export const COMPLETE = 'You continue a message a user is typing to Codex, a coding agent. Reply with only the next few words that continue it, '
  + 'at most one sentence, without repeating what is already written and without quotes. If nothing useful would follow, reply with nothing.';

/** The model's continuation as a suggestion: its first line, no quotes, a space before it when the text needs one; null when empty. */
export function completionOf(text, before) {
  let s = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  s = s.replace(/^["'`]+|["'`]+$/g, '').trimEnd();
  if (!s.trim()) return null;
  const tail = String(before ?? '').slice(-200);
  if (tail && s.trimStart() && tail.endsWith(s.trimStart())) return null;   // it only repeated what was typed
  if (tail && !/\s$/.test(tail) && !/^[\s.,;:!?)]/.test(s)) s = ` ${s.trimStart()}`;
  else if (/\s$/.test(tail)) s = s.trimStart();
  return s.slice(0, 300);
}

/** The message with the answers given to its questions (the question card's answers, by prompt id `q<n>`; an empty one left out). */
export function clarified(text, questions, answers) {
  const said = questions.map((q, i) => [q, String(answers?.[`q${i}`]?.text ?? '').trim()]).filter(([, a]) => a);
  if (!said.length) return text;
  return `${text.trimEnd()}\n\nAnswers to questions about this request:\n${said.map(([q, a]) => `- ${q} ${a}`).join('\n')}`;
}

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  let settings = {};
  ctx.settings.get().then((s) => { settings = s ?? {}; }, () => {});
  const watch = ctx.settings.onChange((s) => { settings = s ?? {}; });
  const call = (method, args) => ctx.services.call(ctx.mod.id, 'clarify', method, args);

  const suggest = ctx.ui.composer.suggest({
    id: 'complete', debounceMs: 700, minChars: 12,
    provide: async ({ before }) => {
      if (settings.autocomplete === false) return null;
      try {
        const out = await ctx.intelligence.ask({ prompt: before.slice(-4000), instructions: COMPLETE, timeoutMs: 8000 });
        return completionOf(out.text, before);
      } catch { return null; }   // model use off, an allowance used: no suggestion
    },
  });

  function Clarify({ subject }) {
    const draft = subject?.ref ?? null;
    const [q, setQ] = R.useState(null);
    const [busy, setBusy] = R.useState(false);
    R.useEffect(() => {
      if (!draft) return undefined;
      let live = true;
      const load = () => call('get', { draft: draft.id }).then((v) => { if (live) setQ(v ?? null); }, () => {});
      load();
      const sub = ctx.events.on(`mod/${ctx.mod.id}/questions`, (d) => { if (d?.draft === draft.id) load(); });
      return () => { live = false; sub.dispose(); };
    }, [draft?.id ?? null]);
    if (!draft || !q) return null;
    const go = async (text, intent) => {
      setBusy(true);
      try {
        await call('clear', { draft: draft.id, text });
        if (text !== q.text) await ctx.graph.invoke(draft, 'setContent', [{ parts: [{ kind: 'text', text }] }]);
        await ctx.graph.invoke(draft, 'send', [], ...(intent?.asUser ? [{ asUser: intent.asUser }] : []));
      } catch (err) { ctx.log.warn('the message could not be sent', { message: String(err?.message ?? err) }); } finally { setBusy(false); }
    };
    return e('div', { 'data-smart-composer': 'questions', style: { padding: 'calc(var(--spacing) * 2)' } },
      e('div', { className: 'text-sm', style: { color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing)' } }, 'Before this goes, a few questions would make it clearer:'),
      e(C.QuestionCard, { busy, prompts: q.questions.map((question, i) => ({ id: `q${i}`, header: `Question ${i + 1}`, prompt: question, other: true })),
        onAnswer: (answers, intent) => go(clarified(q.text, q.questions, answers), intent), onSkip: (intent) => go(q.text, intent) }));
  }
  const questions = ctx.ui.composer.control({ id: 'questions', place: 'aboveInput', render: Clarify });
  return () => { questions.dispose(); suggest.dispose(); watch.dispose(); };
}

export default { renderer };
