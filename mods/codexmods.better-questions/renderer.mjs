// codexmods.better-questions, renderer entry (GOAL.md goal 22). Single-file ESM, no imports.
//
// The Questions view: every open question, its own tool's and Codex's, each drawn with the framework's question card (the app's look)
// and answered there as the user (the card's callback carries the user's intent: G7). It opens by itself in the window in front, as a
// popup window or a tab beside the chat (the host says when). Its iMessage page keeps the Sendblue key in the Keychain.

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const call = (method, args) => ctx.services.call(ctx.mod.id, 'questions', method, args ?? {});

  function useOwn() {
    const [list, setList] = R.useState([]);
    R.useEffect(() => {
      let live = true;
      const load = () => call('list').then((v) => { if (live) setList(Array.isArray(v) ? v : []); }).catch(() => {});
      load();
      const sub = ctx.events.on(`mod/${ctx.mod.id}/questions`, load);
      return () => { live = false; sub.dispose(); };
    }, []);
    return list;
  }
  function useNative() {
    const [list, setList] = R.useState([]);
    R.useEffect(() => {
      let members = new Map();
      const view = ctx.graph.subscribe({ type: 'CodexQuestion', where: { status: 'pending' } }, (m) => {
        if (m?.type === 'snapshot') members = new Map((m.items ?? []).filter((x) => !x.gone).map((x) => [x.ref.id, x]));
        else if (m?.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
          if (m.event.kind === 'removed' || m.event.instance?.state?.status !== 'pending') members.delete(m.event.ref.id);
          else members.set(m.event.ref.id, m.event.instance);
        } else return;
        setList([...members.values()]);
      });
      return () => view.dispose();
    }, []);
    return list;
  }

  function Own({ q }) {
    const [busy, setBusy] = R.useState(false);
    const [error, setError] = R.useState(null);
    const send = (method, args) => { setBusy(true); setError(null); call(method, args).then((out) => { if (out?.status && out.status !== 'done') setError(out.message ?? out.status); }).catch((err) => setError(String(err?.message ?? err))).finally(() => setBusy(false)); };
    return e('div', { 'data-question': q.id, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)' } },
      e('div', { className: 'text-sm font-medium' }, q.title),
      q.message ? e('div', { className: 'text-sm', style: { color: 'var(--color-text-secondary)' } }, q.message) : null,
      e(C.QuestionCard, { prompts: q.prompts, busy, onAnswer: (answers) => send('answer', { id: q.id, answers }), onSkip: () => send('dismiss', { id: q.id }) }),
      error ? e(C.Banner, { tone: 'danger', message: error }) : null);
  }
  function Native({ q }) {
    const [busy, setBusy] = R.useState(false);
    const act = (op, args, intent) => { setBusy(true); ctx.graph.invoke(q.ref, op, args, ...(intent?.asUser ? [{ asUser: intent.asUser }] : [])).catch(() => {}).finally(() => setBusy(false)); };
    return e('div', { 'data-question': q.ref.id, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)' } },
      e('div', { className: 'text-sm font-medium' }, 'Codex asks'),
      e(C.QuestionCard, { prompts: q.state?.prompts ?? [], busy, onAnswer: (answers, intent) => act('answer', [answers], intent), onSkip: (intent) => act('skip', [], intent) }));
  }
  function Questions() {
    const own = useOwn();
    const native = useNative();
    if (!own.length && !native.length) return e(C.EmptyState, { glyph: 'mention', title: 'No questions', description: 'When the agent asks you something, it opens here.' });
    return e('div', { 'data-questions': String(own.length + native.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 6)', padding: 'calc(var(--spacing) * 3)' } },
      ...own.map((q) => e(Own, { key: q.id, q })), ...native.map((q) => e(Native, { key: q.ref.id, q })));
  }

  function IMessage() {
    const [key, setKey] = R.useState('');
    const [secret, setSecret] = R.useState('');
    const [saved, setSaved] = R.useState(null);
    const save = async () => {
      try {
        if (key) await ctx.secrets.set('sendblue.key', key);
        if (secret) await ctx.secrets.set('sendblue.secret', secret);
        setKey(''); setSecret(''); setSaved('Kept in your Keychain.');
      } catch (err) { setSaved(`Not kept: ${err?.message ?? err}`); }
    };
    return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 3)' } },
      e('div', { className: 'text-sm', style: { color: 'var(--color-text-secondary)' } }, 'Questions still open after a while are texted to your phone through your own Sendblue account; your first reply answers. Turn it on, set your phone and the delay in this mod\'s settings.'),
      e('label', { className: 'text-sm' }, 'Sendblue API key id', e(C.TextField ?? 'input', { type: 'password', value: key, onChange: (ev) => setKey(ev?.target?.value ?? ev ?? ''), 'aria-label': 'Sendblue API key id' })),
      e('label', { className: 'text-sm' }, 'Sendblue API secret', e(C.TextField ?? 'input', { type: 'password', value: secret, onChange: (ev) => setSecret(ev?.target?.value ?? ev ?? ''), 'aria-label': 'Sendblue API secret' })),
      e(C.Button ?? 'button', { type: 'button', onClick: save }, 'Keep in the Keychain'),
      saved ? e('div', { className: 'text-sm' }, saved) : null);
  }

  const panel = ctx.ui.panel({ id: 'questions', title: 'Questions', icon: 'mention', render: () => e(Questions) });
  const page = ctx.ui.settings.page({ id: 'imessage', title: 'iMessage', render: () => e(IMessage) });
  // the host says a question came: the window in front opens the view where the user set it to open; a popup window it opened before
  // and that is still there is brought forward instead of opening another
  let popup = null;
  const open = ctx.events.on(`mod/${ctx.mod.id}/open`, async (data) => {
    if (typeof globalThis.document?.hasFocus === 'function' && !globalThis.document.hasFocus()) return;
    const placement = data?.placement === 'side' ? 'side' : 'window';
    try {
      if (placement === 'window' && popup) {
        const w = await ctx.graph.resolve(popup).catch(() => null);
        if (w && !w.gone && (await ctx.graph.invoke(popup, 'focus', []))?.status === 'done') return;
        popup = null;
      }
      const out = await ctx.ui.panels.open('questions', { placement, focus: true });
      if (placement === 'window' && out?.status === 'done' && out.value?.type === 'Window') popup = out.value;
    } catch { /* no window to open it in */ }
  });
  return () => { open.dispose(); page.dispose(); panel.dispose(); };
}

export default { renderer };
