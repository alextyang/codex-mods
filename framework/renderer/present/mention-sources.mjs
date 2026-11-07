// Mods' mention sources (docs/design/mod-surfaces.md §3.6; a scout of 21477). A source is one `add`
// rule on the composer's Palette (for Draft, slot `resultSources`) with `mention: {title, search, position?, minQuery?, limit?,
// debounceMs?}`. The app draws its "@" list with one component given the list's sections; the `mention.list` binding renders it with the
// mods' sections spliced in (after the app's leading "Add" section, or last), so the app draws, highlights and keys the rows as its own.
// A source is asked as the query changes (debounced; an older answer never replaces a newer one; its last rows stay while it is asked
// again). Choosing a row inserts what it says through the composer's own controller: the app's file chip (`{file}`, the model gets the
// path), a link or text; or the app's own chip of an instance (`{ref}`, public-hooks.md §3.14: a File or Folder's file chip, an installed
// Skill's skill chip, each named as the app names it, never as the mod says; another's row title as text); the typed `@query` goes first. The mods' attachment sources (`ui.composer.attachSource`, public-hooks.md §3.14;
// rules with `attach`) are rows of the list's leading "Add" section (`context-actions`, the app's own attach rows; one of ours when the
// app's is not shown), each an action as the app's are: the typed `@query` goes, then its run (pick, then attach). The chats the mods hide
// (`ui.hide('Thread')`, public-hooks.md §3.12) are out of the app's Chats section as the sidebar's lists leave them out (never the chat a
// window shows, nor one working, waiting or failed), and the list's footer says how many each mod hides, with its "Show". NO NODE API.

const PREFIX = 'codexmods:';
const MAX_ROWS = 10;

/** A mention source as its rule says it (its data, or its functions in this window): null when the rule is not one. */
export function mentionOf(r) {
  const m = r?.data?.mention ?? r?.fns?.mention;
  if (!m || typeof m !== 'object' || typeof m.title !== 'string' || !m.title.trim() || typeof m.search !== 'function') return null;
  const int = (v, max, dflt) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : dflt);
  return {
    key: `${r.mod}/${r.id}`, rule: r, title: m.title.trim().slice(0, 60), search: m.search, last: m.position === 'last',
    minQuery: int(m.minQuery, 20, 0), limit: Math.max(1, int(m.limit, MAX_ROWS, 5)), debounceMs: int(m.debounceMs, 2000, 120),
  };
}

/** An attachment source as its rule says it: null when the rule is not one (or its run is not in this window). */
export function attachOf(r) {
  const a = r?.data?.attach;
  const items = r?.fns?.items ?? r?.data?.items;
  const run = Array.isArray(items) ? items[0]?.run : undefined;
  if (!a || typeof a !== 'object' || typeof a.title !== 'string' || !a.title.trim() || typeof run !== 'function') return null;
  return { key: `${r.mod}/${r.id}`, rule: r, title: a.title.trim().slice(0, 60), ...(typeof a.description === 'string' && a.description ? { description: a.description.slice(0, 200) } : {}), run };
}

/** A row as a source gave it, checked: null when it is not one. */
export function rowOf(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 128) return null;
  if (typeof x.title !== 'string' || !x.title.trim()) return null;
  const ins = x.insert && typeof x.insert === 'object' ? x.insert : null;
  let insert = null;
  if (ins && typeof ins.file === 'string' && ins.file.startsWith('/')) insert = { file: ins.file, directory: ins.directory === true || ins.file.endsWith('/') };
  else if (ins && ins.link && typeof ins.link === 'object' && typeof ins.link.href === 'string' && /^(https?|codex):/i.test(ins.link.href)) insert = { link: { href: ins.link.href, text: typeof ins.link.text === 'string' && ins.link.text ? ins.link.text : x.title.trim() } };
  else if (ins && typeof ins.text === 'string' && ins.text) insert = { text: ins.text.slice(0, 4096) };
  else if (ins && ins.ref && typeof ins.ref === 'object' && ['type', 'provider', 'id'].every((k) => typeof ins.ref[k] === 'string' && ins.ref[k])) {
    // a chip names its target as the app does: no label of the mod's on it (one could pass a file off as another: built review H7j-l)
    insert = { ref: { type: ins.ref.type, provider: ins.ref.provider, id: ins.ref.id }, label: x.title.trim() };
  }
  // what it carries for the agent (public-hooks.md §3.14): text, or text content, sent with the message that keeps the mention
  const context = contextOf(ins?.context);
  const base = insert ?? { text: x.title.trim() };
  return {
    id: x.id, title: x.title.trim().slice(0, 100), ...(typeof x.description === 'string' && x.description ? { description: x.description.slice(0, 200) } : {}),
    ...(Array.isArray(x.keywords) ? { keywords: x.keywords.filter((k) => typeof k === 'string').slice(0, 10).map((k) => k.slice(0, 60)) } : {}),
    ...(x.disabled === true ? { disabled: true } : {}), insert: context ? { ...base, context } : base,
  };
}

/** A mention's context as text: a string, or content's text parts; at most 4096 characters; null when none. */
function contextOf(v) {
  const text = typeof v === 'string' ? v : v && typeof v === 'object' && Array.isArray(v.parts) ? v.parts.map((p) => (p && p.kind === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '';
  return text.trim() ? text.slice(0, 4096) : null;
}
const baseName = (p) => { const t = p.replace(/\/+$/, ''); return t.slice(t.lastIndexOf('/') + 1) || t; };
const escLabel = (s) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);
/**
 * What choosing a row does in the composer: its insert, after the typed `@query` (the composer's own controller and the list's state). The
 * answer is what the composer shows for it (a chip's name, a link's text, the text), or false when nothing was inserted.
 */
export function insertRow(row, controller, state) {
  const c = controller;
  if (!c || typeof c !== 'object') return false;
  let ins = row.insert;
  // an instance's own chip, where the app has one, named as the app names it: a File or Folder (its path), an installed Skill (its
  // SKILL.md on disk; a library skill not installed has none); else the row's title, as text
  if (ins.ref) {
    const r = ins.ref;
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own mentions of its files and skills
    if (r.provider === 'codex' && (r.type === 'File' || r.type === 'Folder') && r.id.startsWith('/')) ins = { file: r.id, directory: r.type === 'Folder' };
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own mentions of its files and skills
    else if (r.provider === 'codex' && r.type === 'Skill' && r.id.startsWith('/') && /\/SKILL\.md$/i.test(r.id) && typeof c.insertMention === 'function') {
      const name = baseName(r.id.replace(/\/SKILL\.md$/i, ''));
      c.insertMention({ kind: 'skill', name, displayName: name, path: r.id, description: '' }, state);
      return name;
    } else ins = { text: ins.label };
  }
  if (ins.file && typeof c.insertAtMention === 'function') {
    c.insertAtMention({ label: baseName(ins.file), path: ins.file, fsPath: ins.file, matchType: ins.directory ? 'directory' : 'file' }, state);
    return baseName(ins.file);
  }
  if (typeof c.clearSuggestion === 'function') c.clearSuggestion(state);
  if (ins.link && typeof c.insertCompletionTextAtSelection === 'function') { c.insertCompletionTextAtSelection(`[${escLabel(ins.link.text)}](${ins.link.href}) `); return ins.link.text; }
  const text = ins.text ?? row.title;
  if (typeof c.insertTextAtSelection === 'function') { c.insertTextAtSelection(text); return text.trim() || row.title; }
  if (typeof c.insertCompletionTextAtSelection === 'function') { c.insertCompletionTextAtSelection(text); return text.trim() || row.title; }
  return false;
}

/**
 * A chat's row with its summary (public-hooks.md §3.13): its label the title (both titles still find it), its detail the subtitle where
 * the app gives none, its icon the summary's; the chip it puts in the composer says the title too (the app's own insert, its agent
 * mention's `displayName` the summary's: what the chip shows and the message names).
 */
export function summarized(R, it, s) {
  const out = { ...it };
  if (s.title) {
    out.label = s.title;
    out.searchTerms = [...(Array.isArray(it.searchTerms) ? it.searchTerms : []), s.title];
    if (typeof it.ariaLabel === 'string' && typeof it.label === 'string' && it.label) out.ariaLabel = it.ariaLabel.split(it.label).join(s.title);
    if (typeof it.insertMention === 'function') {
      const own = it.insertMention;
      out.insertMention = (args) => own({ ...args, composerController: retitled(args?.composerController, s.title) });
    }
  }
  if (s.subtitle && it.detail == null && it.detailElement == null) out.detail = s.subtitle;
  if (s.icon && R) out.iconElement = R.createElement('span', { 'aria-hidden': true, 'data-codexmods-summary-icon': '' }, s.icon);
  return out;
}
/** The composer's controller with its agent mention named `title` (every other member its own, bound to it). */
function retitled(cc, title) {
  if (!cc || typeof cc !== 'object') return cc;
  return new Proxy(cc, {
    get(t, k) {
      if (k === 'insertAgentMention' && typeof t.insertAgentMention === 'function') {
        return (m, ...rest) => t.insertAgentMention(m && typeof m === 'object' ? { ...m, displayName: title } : m, ...rest);
      }
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * @param {{ react: () => any, guard: (rule: object, fn: Function) => Function, env: (draft: object | null, thread: object | null) => object,
 *   live?: (rule: object) => boolean, log?: Function, schedule?: (fn: Function, ms: number) => unknown, cancel?: (t: unknown) => void,
 *   hides?: { by(threadId: string): string | null, notice(R: any, counts: [string, number][]): any[] }, use?: <T>(compute: () => T) => T,
 *   summary?: (threadId: string) => { title?: string, subtitle?: string, icon?: string } | null,
 *   mentioned?: (draft: object, entry: { mod: string, label: string, context: string }) => void }} o  `hides`: the mod that hides a chat
 *   (a protocol id) from the listings, or null; the footer's notice of each mod's (how many, and its "Show"); `use`: the runtime's hook
 *   that runs `compute` with its reads followed (the list renders again when one changes: a chat's state, the chat shown, a "Show");
 *   `summary`: a chat's summary (public-hooks.md §3.13), how its row reads and what its chip says;
 *   `mentioned`: a row with context was picked (its mod, what the composer shows for it, its context), told to the Host
 */
export function createMentionSources(o) {
  const log = o.log ?? (() => {});
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((t) => clearTimeout(t));
  let sources = [];
  let attaches = [];   // the attachment sources
  let version = 0;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getVersion = () => version;

  /** The app's "@" list with the mods' sections: its own props, its sections with ours spliced in. */
  function Splice({ Original, props, factory, draft, thread }) {
    const R = o.react();
    const v = R.useSyncExternalStore(subscribe, getVersion, getVersion);
    const query = typeof props?.query === 'string' ? props.query : '';
    const [found, setFound] = R.useState({});   // source key -> { q, rows }
    const pending = R.useRef(new Map());          // source key -> the number of its newest search
    const paneOf = o.paneContext?.() ?? null;
    const pane = paneOf ? R.useContext(paneOf) : null;   // the pane this composer is in (layouts.md D8)
    const target = R.useRef({ draft, thread, pane });
    target.current = { draft, thread, pane };
    // a list given another composer's Draft (the app may reuse it) starts with none of the other's rows
    const draftKey = draft ? `${draft.provider}/${draft.id}` : '';
    R.useEffect(() => {
      const timers = [];
      for (const src of sources) {
        if (query.length < src.minQuery) continue;
        const n = (pending.current.get(src.key) ?? 0) + 1;
        pending.current.set(src.key, n);
        const first = found[src.key]?.search !== src.search || found[src.key]?.draft !== draftKey;
        timers.push(schedule(() => {
          const { draft: d, thread: t, pane: p } = target.current;
          Promise.resolve(o.guard(src.rule, src.search)(query, o.env(d, t, p))).then((out) => {
            if (pending.current.get(src.key) !== n) return;   // an older answer never replaces a newer one
            const rows = (Array.isArray(out) ? out.slice(0, MAX_ROWS) : []).map(rowOf).filter(Boolean).slice(0, query ? src.limit : Math.min(src.limit, 4));
            setFound((f) => ({ ...f, [src.key]: { q: query, rows, search: src.search, draft: draftKey } }));
          }, () => {});
        }, first ? 0 : src.debounceMs));
      }
      return () => { for (const t of timers) cancel(t); };
    }, [query, v, draftKey]);
    const mine = [];
    for (const src of sources) {
      if (query.length < src.minQuery) continue;
      const had = found[src.key];
      const got = had && had.search === src.search && had.draft === draftKey ? had : undefined;   // a source registered again, or another Draft: none of the older rows
      const rows = got?.rows ?? [];
      if (!rows.length && got) continue;   // answered with nothing: no section
      mine.push({
        id: `${PREFIX}${src.key}`, title: src.title, isLoading: !got, emptyState: null, queryMatchMode: 'source-ranked', last: src.last,
        items: rows.map((row) => ({
          key: `${PREFIX}${src.key}/${row.id}`, label: row.title, ...(row.description ? { detail: row.description } : {}),
          searchTerms: [row.title, ...(row.keywords ?? [])], ...(row.disabled ? { disabled: true } : {}), type: 'mention',
          insertMention: ({ composerController, mentionState }) => {
            if (o.live && !o.live(src.rule)) { try { composerController?.clearSuggestion?.(mentionState); } catch { /* the composer went */ } return; }
            try {
              const shown = insertRow(row, composerController, mentionState);
              if (!shown) log('a mention could not be inserted', { source: src.key, row: row.id });
              // its context goes with the message that keeps it (the composer's Draft; framework/host/agent)
              else if (row.insert.context && o.mentioned) { const { draft: d } = target.current; if (d) o.mentioned(d, { mod: src.rule.mod, label: shown, context: row.insert.context }); }
            }
            catch (e) { log('a mention could not be inserted', { source: src.key, message: String(e?.message ?? e) }); }
          },
        })),
      });
    }
    // the chats the mods hide: out of whatever section lists them (a row names a chat of this Mac as `thread:local:<id>`), told in the
    // footer; worked out where its reads are followed (`use`), so the list is drawn again as what decides it changes
    const given = Array.isArray(props?.sections) ? props.sections : [];
    const filtered = () => {
      const hidden = new Map();   // mod -> how many
      if (!o.hides && !o.summary) return { sections: given, hidden };
      const idOf = (it) => { const m = typeof it?.key === 'string' ? /^thread:local:(.+)$/.exec(it.key) : null; return m ? m[1] : null; };
      let any = false;
      const sections = given.map((s) => {
        if (!s || !Array.isArray(s.items) || !s.items.some((it) => idOf(it) !== null)) return s;
        let changed = false;
        const items = [];
        for (const it of s.items) {
          const id = idOf(it);
          const mod = id !== null && o.hides ? o.hides.by(id) : null;
          if (mod) { hidden.set(mod, (hidden.get(mod) ?? 0) + 1); changed = true; continue; }
          const sum = id !== null && o.summary ? o.summary(id) : null;
          const next = sum ? summarized(R, it, sum) : it;
          if (next !== it) changed = true;
          items.push(next);
        }
        if (changed) any = true;
        return changed ? { ...s, items } : s;
      });
      return { sections: any ? sections : given, hidden };
    };
    const { sections: kept, hidden: hiddenNow } = o.use ? o.use(filtered) : filtered();
    let app = kept;
    if (hiddenNow.size) props = { ...props, footer: R.createElement(R.Fragment, null, props?.footer ?? null, ...o.hides.notice(R, [...hiddenNow])) };
    // the attachment sources: rows of the "Add" section, as the app's own actions (the typed `@query` goes, then their `action`: on 21477
    // the list makes a chosen row of type `action` a suggestion that runs `item.action`)
    const adds = attaches.filter((a) => !query || a.title.toLowerCase().includes(query.toLowerCase())).map((a) => ({
      key: `${PREFIX}attach:${a.key}`, label: a.title, ...(a.description ? { detail: a.description } : {}), searchTerms: [a.title], type: 'action',
      action: () => {
        if (o.live && !o.live(a.rule)) return;
        const { draft: d, thread: t, pane: p } = target.current;
        Promise.resolve(o.guard(a.rule, a.run)({ ...o.env(d, t, p), via: 'attach' })).catch((e) => log('an attachment source failed', { source: a.key, message: String(e?.message ?? e) }));
      },
    }));
    if (adds.length) {
      const lead = app.findIndex((s) => s?.id === 'context-actions');
      app = lead >= 0 ? app.map((s, i) => (i === lead ? { ...s, items: [...(Array.isArray(s.items) ? s.items : []), ...adds] } : s))
        : [{ id: `${PREFIX}attach`, title: 'Add', isLoading: false, emptyState: null, items: adds }, ...app];
    }
    if (!mine.length) return adds.length || hiddenNow.size || kept !== given ? factory(Original, { ...props, sections: app }) : factory(Original, props);
    const strip = ({ last: _last, ...s }) => s;
    const lead = app.findIndex((s) => s?.id === 'context-actions' || s?.id === `${PREFIX}attach`);
    const at = lead >= 0 ? lead + 1 : 0;
    const sections = [...app.slice(0, at), ...mine.filter((s) => !s.last).map(strip), ...app.slice(at), ...mine.filter((s) => s.last).map(strip)];
    return factory(Original, { ...props, sections });
  }

  return {
    Splice,
    /** The sources of the window's rules (the runtime calls it as rules change). */
    setSources(rules) { sources = rules.map(mentionOf).filter(Boolean); attaches = rules.map(attachOf).filter(Boolean); version++; for (const fn of [...listeners]) { try { fn(); } catch { /* a list's own */ } } },
    sources: () => sources,
  };
}
