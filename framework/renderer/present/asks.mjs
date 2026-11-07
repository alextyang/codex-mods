// A mod's questions in this window (docs/design/systems.md "E7 in detail" decision 7, E7.6c). The Host sends `ask` (who asks, as the
// framework names it; the subject and purpose; the mod's title, message and actions) and `askEnd` (it settled the question: the
// requester's confirm or cancel, its time, its subject or the requester going). The page shows one question at a time, in order, and
// none while one of the framework's own Dialogs is open (consent and recovery come first: one on the app's stack leaves it meanwhile);
// it answers the user's choice, the user's cancel (the Dialog's close, Escape, outside) or its own end (it could not be shown, the app
// removed it from its modal stack). It opens on the app's modal stack (above any route) through a scope node the window's bindings hold
// (any of the app's scopes reaches the stack's AppScope atom), drawn with the app's Dialog; with no node, the framework's root draws
// the fallback Dialog. Always as the mod's and never as the framework's: the requester's name in its own line, the mod's text as plain
// text, no framework marker.
// Reported as a Dialog of its subject, its purpose its slot, with the question's id: only the requester acts on it (the Host checks).
// Other mods' rules add to its `body` (hosted regions) and `actions` (ctx.ruled, by its subject's type). NO NODE API.

import { attestNow } from './attest.mjs';

/** The reporting binding of a mod's Dialog: not the framework's (decision 6 keeps the framework's own; this one its requester settles). */
export const ASK_BINDING = Object.freeze({
  id: 'framework:ask', presentation: 'Dialog',
  subject: (props) => props?.subject ?? null,
  place: (props) => props?.place ?? {},
  ask: (props) => props?.ask ?? null,
});

/**
 * @param {{ R: object, ctx: object, dialogs: { Frame: Function, open: () => number, button: Function }, answer: (gen: number, id: number, outcome: object) => unknown,
 *   controls?: ReturnType<typeof import('./setting-controls.mjs').createSettingControls>,
 *   stack?: () => ({ node: object, modal: { open: Function, close: Function } } | null), log?: (m: string, d?: unknown) => void }} o
 *   `dialogs.Frame` draws a Dialog (`{title, subtitle, onClose, footer, children, own: false, plain?}`; `plain`: the fallback drawing),
 *   `dialogs.open()` counts the framework's own Dialogs open in this window, `dialogs.button(label, onClick, tone)` is the app's button;
 *   `stack()` the app's modal controller and a live scope node of this window, or null
 * @returns {{ receive(m: object): void, Asks: Function, pending(): number[] }}
 */
export function createAsks(o) {
  const { R } = o;
  const e = R.createElement;
  const log = o.log ?? (() => {});
  const queue = [];   // questions in order: {id, gen, requester, subject, purpose, title, message, actions}
  const listeners = new Set();
  const changed = () => { sync(); for (const f of [...listeners]) { try { f(); } catch { /* a listener's own fault */ } } };
  const drop = (id) => { const i = queue.findIndex((q) => q.id === id); if (i >= 0) { queue.splice(i, 1); changed(); } };
  const answer = (q, outcome) => {
    if (!queue.includes(q)) return;   // answered once (or ended by the Host)
    drop(q.id);
    Promise.resolve().then(() => o.answer(q.gen, q.id, outcome)).catch((err) => log('a question was not answered', { message: String(err?.message ?? err) }));
  };
  const valid = (m) => Number.isSafeInteger(m.id) && Number.isSafeInteger(m.gen) && m.requester && typeof m.requester.name === 'string'
    && m.subject && typeof m.subject.type === 'string' && typeof m.title === 'string' && typeof m.message === 'string'
    && Array.isArray(m.actions) && m.actions.length > 0 && m.actions.every((a) => a && typeof a.id === 'string' && typeof a.title === 'string');

  // Its own end: a question that could not be drawn is cancelled, and the next one shows.
  const Boundary = typeof R.Component === 'function' ? class CodexmodsAskBoundary extends R.Component {
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { try { this.props.onFail(error); } catch { /* reporting must not throw */ } }
    render() { return this.state?.failed ? null : this.props.children; }
  } : null;

  function Report({ q }) {
    R.useEffect(() => {
      const reporter = o.ctx?.report;
      if (!reporter) return undefined;
      const rec = { binding: ASK_BINDING.id, props: { subject: q.subject, place: { in: 'Window', slot: q.purpose }, ask: q.id } };
      reporter.put(rec);
      return () => reporter.remove(rec);
    }, [q.id]);
    return null;
  }

  /**
   * A question's field (public-hooks.md §3.14; graph-integrity G4.2): a setting's declaration, drawn by the settings' own control for its kind
   * (a choice's choices by their values as JSON, as a Setting's; a text's secret masked).
   */
  function Field({ f, value, onChange }) {
    const s = { kind: f.kind, value, ...(f.control ? { control: f.control } : {}),
      ...(Array.isArray(f.choices) ? { choices: f.choices.map((c) => ({ id: JSON.stringify(c.value), label: c.label, ...(c.media ? { media: c.media } : {}) })) } : {}),
      ...Object.fromEntries(['min', 'max', 'step', 'unit', 'placeholder', 'schema'].filter((k) => f[k] !== undefined).map((k) => [k, f[k]])) };
    const control = o.controls?.control({ s, label: f.title, write: onChange }) ?? null;
    if (!control) return null;
    return e('label', { className: 'flex flex-col gap-1', 'data-codexmods-field': f.key }, e('span', { className: 'text-secondary' }, f.title),
      typeof f.description === 'string' ? e('span', { className: 'text-sm text-secondary' }, f.description) : null,
      // a switch keeps its own size (the column would stretch it, and its focus ring with it)
      f.kind === 'toggle' ? e('span', { style: { alignSelf: 'flex-start', display: 'inline-flex' } }, control) : control);
  }
  function Question({ q, plain }) {
    const inst = o.ctx?.use ? o.ctx.use(() => o.ctx.subject?.(q.subject) ?? null) : null;
    const ruled = typeof o.ctx?.ruled === 'function' ? o.ctx.ruled('Dialog', inst && !inst.gone ? inst : null) : null;
    // the fields' values as the user gives them, from their defaults; kept on the question, so a framework Dialog that takes its place for
    // a while (and unmounts it) never loses what the user entered
    const [values, setValues] = R.useState(() => q.values ?? Object.fromEntries(q.fields.map((f) => [f.key, f.default])));
    // what the user gave, kept on the question as it is given (a text commits as it loses focus, just before an action's click reads it)
    const given = () => q.values ?? values;
    const put = (key, v) => { const next = { ...given(), [key]: v }; q.values = next; setValues(next); };
    const button = (key, title, onClick, primary) => e(R.Fragment, { key }, o.dialogs.button(title, onClick, primary ? 'primary' : 'secondary'));
    const footer = [
      ...(ruled?.actions ?? []).map((a) => button(a.key, a.title, () => a.run(), false)),
      button('codexmods:cancel', 'Cancel', () => answer(q, { cancelled: true, by: 'user', reason: 'cancelled' }), false),
      // the user's own click: its asking mod's attestation goes with the answer (graph-integrity G7.1; a renderer-realm requester gets it)
      ...q.actions.slice().reverse().map((a, i) => button(a.id, a.title, (ev) => { const asUser = attestNow(q.requester.id, ev); answer(q, { choice: a.id, ...(q.fields.length ? { values: given() } : {}), ...(asUser ? { asUser } : {}) }); }, i === q.actions.length - 1)),
    ];
    return e(R.Fragment, null,
      e(Report, { q }),
      e(o.dialogs.Frame, { title: q.title, subtitle: `${q.requester.name} asks`, own: false, plain, onClose: () => answer(q, { cancelled: true, by: 'user', reason: 'dismissed' }), footer },
        e('p', { key: 'message', style: { whiteSpace: 'pre-wrap', margin: 0 } }, q.message),
        ...q.fields.map((f) => e(Field, { key: `field:${f.key}`, f, value: values[f.key], onChange: (v) => put(f.key, v) })),
        ...(ruled?.regions?.body ?? [])));
  }

  const guarded = (q, shown) => (Boundary ? e(Boundary, { key: q.id, onFail: (error) => { log('a question could not be shown', { message: String(error?.message ?? error) }); answer(q, { cancelled: true, reason: 'it could not be shown' }); } }, shown) : shown);
  /** The question to show now: the first, unless one of the framework's own Dialogs is open. */
  const wanted = () => { const q = queue[0]; return q && o.dialogs.open() === 0 ? q : null; };

  // On the app's modal stack: the question there now, under a component of its own (the stack keys its entries by component).
  let entry = null;
  let stackFailed = false;
  let syncing = false;
  function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const want = wanted();
      if (entry && entry.q !== want) {   // answered, ended, or a framework Dialog opened: off the stack (unanswered when it waits)
        const x = entry; entry = null;
        try { x.modal.close(x.node, x.C); } catch (err) { log('a question could not leave the stack', { message: String(err?.message ?? err) }); }
      }
      const s = want && !entry && !stackFailed ? o.stack?.() ?? null : null;
      if (!s || !s.node || typeof s.modal?.open !== 'function') return;
      const q = want;
      const C = function CodexmodsQuestion() { return guarded(q, e(Question, { q })); };
      entry = { q, C, node: s.node, modal: s.modal };
      // Removed by the app (its closeAll, a replacement) while it waits for its answer: cancelled, as its own end.
      const onDispose = () => { if (entry?.C !== C) return; entry = null; answer(q, { cancelled: true, reason: 'the app closed it' }); };
      try { s.modal.open(s.node, C, {}, { blocksOtherModals: true, onDispose }); }
      catch (err) { entry = null; stackFailed = true; log('the app\'s modal stack took no question; the framework draws them', { message: String(err?.message ?? err) }); }
    } finally { syncing = false; }
  }

  /** The window's questions where the app's stack cannot take them: drawn in the framework's root, the fallback Dialog. */
  function Asks() {
    const [, bump] = R.useState(0);
    R.useEffect(() => { const f = () => bump((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
    R.useEffect(() => { if (!entry) sync(); });
    const q = wanted();
    if (!q || entry?.q === q || (!stackFailed && o.stack?.())) return null;
    return guarded(q, e(Question, { key: q.id, q, plain: true }));
  }

  return {
    /** The Host's `ask` (queued) and `askEnd` (closed: the Host settled it). */
    receive(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'askEnd') { drop(m.id); return; }
      if (m.t !== 'ask' || !valid(m) || queue.some((q) => q.id === m.id)) return;
      queue.push({ id: m.id, gen: m.gen, requester: { id: String(m.requester.id ?? ''), name: m.requester.name }, subject: m.subject, purpose: String(m.purpose ?? ''),
        title: m.title, message: m.message, actions: m.actions.map((a) => ({ id: a.id, title: a.title })), fields: Array.isArray(m.fields) ? m.fields : [] });
      changed();
    },
    /** A framework Dialog opened or closed: the first question may show now. */
    refresh: changed,
    Asks,
    pending: () => queue.map((q) => q.id),
  };
}
