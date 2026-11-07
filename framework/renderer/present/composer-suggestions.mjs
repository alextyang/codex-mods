// Mods' inline suggestions in the composer (`ui.composer.suggest`; docs/design/reference-mods.md RM8,
// docs/research/reference-mods/composer-suggestions.md). A source is one `add` rule on the composer's Palette (for Draft, slot
// `resultSources`) with `suggest: {provide, debounceMs?, minChars?}`. When the user pauses at the end of a line, the first source the user's
// order puts first is asked (`provide(env)`, env.before and env.after the text around the caret, env.draft and env.thread the composer's);
// its answer is drawn as ghost text right after the caret, in the editor's own font and the theme's tertiary text colour. Tab takes it (one
// step of the editor's undo, through the composer's own controller), Escape leaves it, and anything else typed clears it (the next pause
// asks again). An older answer never replaces a newer one, and an answer to text that has changed since is dropped. Nothing is shown while
// a mention or a slash command is being typed (the app's own menus), during an input method's composition, or with a selection.
//
// The ghost is an overlay over the editor, not a node of its document: the app's editor state is the app's (rebuilt as it likes), and the
// suggestion is never part of the Draft until it is taken. NO NODE API.

const MAX = 500;   // characters of a suggestion
const int = (v, min, max, dflt) => (Number.isInteger(v) ? Math.min(Math.max(v, min), max) : dflt);

/** A suggestion source as its rule says it (its data, or its functions in this window): null when the rule is not one. */
export function suggestOf(r) {
  const s = r?.data?.suggest ?? r?.fns?.suggest;
  if (!s || typeof s !== 'object' || typeof s.provide !== 'function') return null;
  return { key: `${r.mod}/${r.id}`, rule: r, provide: s.provide, debounceMs: int(s.debounceMs, 150, 3000, 500), minChars: int(s.minChars, 1, 200, 4) };
}

/** What the composer offers a source at its caret: the text before and after it, when a suggestion may be shown there; else null. */
export function contextAt(view) {
  const st = view?.state;
  const sel = st?.selection;
  if (!st || !sel || sel.empty !== true || typeof st.doc?.textBetween !== 'function') return null;
  const size = st.doc.content?.size ?? 0;
  const before = st.doc.textBetween(0, sel.from, '\n', ' ');
  const after = st.doc.textBetween(sel.from, size, '\n', ' ');
  if (after.split('\n')[0].trim()) return null;   // only at the end of a line
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if (/(^|\s)[@$][^\s]*$/.test(line) || /^\/[^\s]*$/.test(line)) return null;   // a mention or a slash command being typed: the app's menus
  return { before, after, at: sel.from };
}

/** A source's answer as a suggestion: its text, at most MAX characters, never only spaces; null when there is none. */
export function suggestionOf(out) {
  const text = typeof out === 'string' ? out : out && typeof out === 'object' && typeof out.text === 'string' ? out.text : null;
  if (!text || !text.trim()) return null;
  return text.slice(0, MAX);
}

/**
 * The suggestions of every composer in this window. `o`: {guard(rule, fn), live(rule), env(draft, thread, pane), log, schedule(fn, ms),
 * cancel(t), react}. `setSources(rules)` takes the window's Palette rules; `Attach` is an element a composer renders (its controller, Draft
 * and thread), which follows its editor while it is mounted.
 */
export function createComposerSuggestions(o) {
  let sources = [];
  const engines = new Set();
  const log = o.log ?? (() => {});
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((t) => clearTimeout(t));

  /** One composer's editor: its ghost, its keys, its asking. */
  function engine(controller, target) {
    const view = controller?.view;
    const dom = view?.dom;
    if (!dom || typeof dom.addEventListener !== 'function') return null;
    const d = dom.ownerDocument;
    let ghost = null;      // {text, at, before}: what is shown
    let el = null;
    let timer = null, seq = 0, composing = false;
    const hide = () => { ghost = null; if (el) el.style.display = 'none'; };
    const draw = () => {
      if (!ghost || !d) return;
      let at;
      try { at = view.coordsAtPos(ghost.at); } catch { return hide(); }
      if (!el) {
        el = d.createElement('span');
        el.setAttribute('data-codexmods', 'composer-suggestion');
        el.setAttribute('aria-hidden', 'true');
        Object.assign(el.style, { position: 'fixed', pointerEvents: 'none', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', zIndex: '1',
          color: 'var(--color-text-tertiary)' });
        d.body?.appendChild(el);
      }
      // the editor's own font (its computed style): the ghost reads as the rest of the line
      const cs = d.defaultView?.getComputedStyle?.(dom);
      if (cs) Object.assign(el.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing });
      const box = dom.getBoundingClientRect?.();
      const firstLine = ghost.text.split('\n')[0];
      el.textContent = firstLine || ghost.text.trimStart().split('\n')[0];
      Object.assign(el.style, { display: 'block', left: `${at.left}px`, top: `${at.top}px`, maxWidth: box ? `${Math.max(0, box.right - at.left)}px` : 'none' });
    };
    const source = () => sources.find((s) => !o.live || o.live(s.rule)) ?? null;
    const ask = () => {
      timer = null;
      const src = source();
      const c = composing ? null : contextAt(view);
      if (!src || !c || c.before.trim().length < src.minChars) return hide();
      const n = ++seq;
      const env = Object.freeze({ ...o.env(target.current.draft, target.current.thread, target.current.pane), via: 'suggest', before: c.before, after: c.after });
      Promise.resolve(o.guard(src.rule, src.provide)(env)).then((out) => {
        if (n !== seq) return;   // an older answer never replaces a newer one
        const now = contextAt(view);
        if (!now || now.before !== c.before || now.at !== c.at) return;   // the text changed since it was asked
        const text = suggestionOf(out);
        if (!text) return hide();
        ghost = { text, at: c.at, before: c.before };
        draw();
      }, (e) => { if (n === seq) log('a composer suggestion failed', { source: src.key, message: String(e?.message ?? e) }); });
    };
    const again = () => {
      seq += 1;   // what was asked before is stale now
      hide();
      if (timer) cancel(timer);
      const src = source();
      if (src) timer = schedule(ask, src.debounceMs);
    };
    const onKey = (e) => {
      if (!ghost) return;
      if (e.isComposing || e.keyCode === 229) return hide();
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        const text = ghost.text;
        hide();
        try { controller.insertTextAtSelection(text); } catch (err) { log('a suggestion could not be taken', { message: String(err?.message ?? err) }); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); seq += 1; hide(); return; }
      if (!['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) hide();
    };
    const listeners = [
      ['keydown', onKey, true], ['input', again, false], ['compositionstart', () => { composing = true; hide(); }, false],
      ['compositionend', () => { composing = false; again(); }, false], ['blur', () => { seq += 1; hide(); }, false],
      ['mouseup', () => { if (ghost) again(); }, false],
    ];
    for (const [type, fn, capture] of listeners) dom.addEventListener(type, fn, capture);
    return {
      refresh() { if (!source()) { seq += 1; hide(); } },
      dispose() {
        for (const [type, fn, capture] of listeners) dom.removeEventListener(type, fn, capture);
        if (timer) cancel(timer);
        seq += 1;
        el?.remove?.();
        el = null;
      },
      get shown() { return ghost?.text ?? null; },
    };
  }

  /** A composer's suggestions while it is mounted: its controller's editor, with its Draft and thread (the env a source is given). */
  function Attach({ controller, draft, thread, pane }) {
    const R = o.react();
    const target = R.useRef({ draft, thread, pane });
    target.current = { draft, thread, pane };
    // always following the editor (its listeners only): a source registered later is asked at the next pause
    R.useEffect(() => {
      const e = engine(controller, target);
      if (!e) return undefined;
      engines.add(e);
      return () => { engines.delete(e); e.dispose(); };
    }, [controller]);
    return null;
  }

  return {
    setSources(rules) {
      sources = (Array.isArray(rules) ? rules : []).map(suggestOf).filter(Boolean);
      for (const e of engines) e.refresh();
    },
    get count() { return sources.length; },
    Attach,
    /** For tests: an engine on a controller, without React. */
    engine,
  };
}
