// Mods' palette sources (docs/design/mod-surfaces.md §3.2; a scout of 21477). A source is one `add`
// rule on Palette's `resultSources` slot: `source` (its title or the app group it joins, its place, its trigger, its limits; and, as
// functions, `search(query, env)` and `choose(item, env)`) and `items` (rows the palette filters itself, each with its `run`). While the
// palette is open (the Cmd+K dialog or the floating search window), a registrar the `palette` binding mounts beside it writes one section
// per source into the app's own sections (an AppScope atom the palette reads), so the rows are drawn by the app's own row component in
// the app's cmdk list: its look, its highlight, its keyboard. Static rows are filtered and ranked by the palette; searched rows carry the
// app's async-result value (always shown, counted, after the app's matches) and come from the source as the text changes (debounced; an
// older answer never replaces a newer one). The text is read from cmdk's own state. NO NODE API.

const PREFIX = 'codexmods:';
const ZWSP = '​';
const MAX_ROWS = 50;
const GROUPS = ['suggested', 'thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app'];

/**
 * A row as a source gave it, checked: null when it is not one. A mod's row has at most 10 keywords of 60 characters; the framework's own
 * may give every term it is found by (`whole`: the hidden commands' notice).
 */
export function rowOf(x, { whole = false } = {}) {
  const maxKeywords = whole ? Infinity : 10, maxKeyword = whole ? Infinity : 60;
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 128) return null;
  if (typeof x.title !== 'string' || !x.title.trim()) return null;
  return {
    id: x.id, title: x.title.trim().slice(0, 100), ...(typeof x.description === 'string' && x.description ? { description: x.description.slice(0, 200) } : {}),
    ...(Array.isArray(x.keywords) ? { keywords: x.keywords.filter((k) => typeof k === 'string').slice(0, maxKeywords).map((k) => k.slice(0, maxKeyword)) } : {}),
    ...(x.disabled === true ? { disabled: true } : {}), ...(x.ref && typeof x.ref === 'object' && typeof x.ref.type === 'string' ? { ref: { type: x.ref.type, provider: String(x.ref.provider), id: String(x.ref.id) } } : {}),
    ...(typeof x.run === 'function' ? { run: x.run } : {}),
    ...(x.choose && typeof x.choose === 'object' ? { choose: x.choose } : {}),
  };
}

/** A source as its rule says it (the rule's data, or its functions in this window): null when the rule is not one. */
export function sourceOf(r) {
  const src = r?.data?.source ?? r?.fns?.source;
  if (!src || typeof src !== 'object') return null;
  const items = r.data?.items ?? r.fns?.items;
  const group = GROUPS.includes(src.group) ? src.group : null;
  const title = typeof src.title === 'string' && src.title.trim() ? src.title.trim().slice(0, 60) : null;
  if (!group && !title) return null;
  return {
    key: `${r.mod}/${r.id}`, rule: r, group, title, above: src.position === 'above',
    items: (Array.isArray(items) ? items : []).map(rowOf).filter(Boolean).slice(0, MAX_ROWS),
    search: typeof src.search === 'function' ? src.search : null, choose: typeof src.choose === 'function' ? src.choose : null,
    trigger: typeof src.trigger === 'string' && src.trigger.trim() ? src.trigger.trim().toLowerCase() : null,
    minQuery: Number.isInteger(src.minQuery) && src.minQuery >= 0 ? src.minQuery : 1,
    limit: Number.isInteger(src.limit) && src.limit > 0 ? Math.min(src.limit, MAX_ROWS) : 8,
    debounceMs: Number.isInteger(src.debounceMs) && src.debounceMs >= 0 ? Math.min(src.debounceMs, 2000) : 120,
  };
}

/**
 * @param {{ react: () => any, exports: () => object, guard: (rule: object, fn: Function) => Function, env: (row: object | null) => object,
 *   live?: (rule: object) => boolean, open?: (ref: object) => void, runCommand?: (id: string) => void, log?: Function, schedule?: (fn: Function, ms: number) => unknown, cancel?: (t: unknown) => void }} o
 */
export function createPaletteSources(o) {
  const log = o.log ?? (() => {});
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((t) => clearTimeout(t));
  let sources = [];
  let ruled = [], own = [];   // the mods' rules' sources, the framework's own
  let version = 0;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getVersion = () => version;

  // Drill-in pages (§3.2, E8.5b): a row whose choose is `{page: {title, placeholder?}}` pushes a page onto the app's own page stack (its
  // title, its search placeholder and the app's Back row); while that page is on top, the source's section is the page (exclusive, as the
  // app's own pages) and its `search(query, env)` answers it, `env.page` naming the row drilled into.
  let pageScope = null;   // the open palette's scope node (the registrar's)
  const pageIdOf = (src, rowId) => `${PREFIX}${src.key}/${rowId}`;
  const stackOf = () => { const atom = o.exports()?.commandMenuPages; try { const s = atom && pageScope ? pageScope.get(atom) : null; return Array.isArray(s) ? s : []; } catch { return []; } };
  /** The page of this source on top of the stack ({id: the row's, title}), null when none is, false when another's is. */
  const pageOf = (src) => {
    const top = stackOf().at(-1);
    if (!top || typeof top.id !== 'string') return null;
    const prefix = `${PREFIX}${src.key}/`;
    return top.id.startsWith(prefix) ? { id: top.id.slice(prefix.length), title: typeof top.title === 'string' ? top.title : '' } : false;
  };
  function drill(src, row, page, reset) {
    const atom = o.exports()?.commandMenuPages;
    if (!atom || !pageScope || typeof pageScope.set !== 'function') return false;
    try { reset?.(); } catch { /* the palette's own */ }
    pageScope.set(atom, [...stackOf(), { id: pageIdOf(src, row.id), searchPlaceholder: typeof page.placeholder === 'string' ? page.placeholder.slice(0, 80) : '',
      title: typeof page.title === 'string' && page.title.trim() ? page.title.trim().slice(0, 60) : row.title }]);
    return true;
  }

  /** What choosing a row does: its own run, the source's choose, open an instance, or one of the app's commands; then the palette closes. */
  function choose(src, row, close, reset) {
    const env = o.env(row);
    const done = () => { try { close?.(); } catch { /* the palette went */ } };
    if (!src.framework && o.live && !o.live(src.rule)) return done();   // its source went (or was registered again) while the palette was open
    // a drill-in page: the palette stays open on it
    if (row.choose && typeof row.choose.page === 'object' && row.choose.page !== null && src.search) { if (drill(src, row, row.choose.page, reset)) return undefined; }
    try {
      // the framework's own rows (the mods' commands, P5) run through their registry, which counts a mod's fault itself
      if (src.framework && typeof row.run === 'function') { row.run(env); return done(); }
      if (typeof row.run === 'function') { o.guard(src.rule, row.run)(env); return done(); }
      const c = row.choose ?? {};
      if (c.run === true && src.choose) { o.guard(src.rule, src.choose)({ id: row.id, title: row.title, ...(row.ref ? { ref: row.ref } : {}) }, env); return done(); }
      if (c.open && typeof c.open === 'object' && o.open) { o.open(c.open); return done(); }
      if (typeof c.command === 'string' && o.runCommand) { o.runCommand(c.command); return done(); }
      if (src.choose) { o.guard(src.rule, src.choose)({ id: row.id, title: row.title, ...(row.ref ? { ref: row.ref } : {}) }, env); return done(); }
    } catch (e) { log('a palette row could not be chosen', { source: src.key, message: String(e?.message ?? e) }); }
    return undefined;
  }

  /** One source's rows: the app's own row component, in a group of its own or (joining an app group) as rows. */
  function ModSection({ src, close, reset }) {
    const R = o.react();
    const x = o.exports() ?? {};
    const Command = x.commandMenu, Row = x.commandMenuItem;
    const useCommandState = x.commandMenuState;
    // cmdk's own text (always read: the same hooks on every render)
    const typed = typeof useCommandState === 'function' ? useCommandState((s) => s.search) : '';
    const [found, setFound] = R.useState({ q: null, rows: [], search: null, page: null });
    const seq = R.useRef(0);
    const page = pageOf(src);   // read as the palette draws (it draws again when its page stack changes)
    const pageId = page ? page.id : null;
    const text = String(typed ?? '').trim();
    let query = text;
    let wanted = !!src.search && page !== false;
    if (!page && src.trigger) { const lower = text.toLowerCase(); wanted = wanted && (lower === src.trigger || lower.startsWith(`${src.trigger} `)); query = wanted ? text.slice(src.trigger.length).trim() : ''; }
    if (!page && wanted && query.length < src.minQuery && !src.trigger) wanted = false;
    R.useEffect(() => {
      if (!wanted) return undefined;
      const n = ++seq.current;
      const env = page ? Object.freeze({ ...o.env(null), page: { id: page.id, title: page.title } }) : o.env(null);
      const t = schedule(() => {
        // the framework's own source's search is its own (no mod's rule it could trip); a mod's runs guarded, as its rule's
        const ask = src.framework ? src.search : o.guard(src.rule, src.search);
        Promise.resolve().then(() => ask(query, env)).then((out) => {
          if (n !== seq.current) return;   // an older answer never replaces a newer one
          const rows = (Array.isArray(out) ? out.slice(0, MAX_ROWS) : []).map(rowOf).filter(Boolean).slice(0, src.limit);
          setFound({ q: query, rows, search: src.search, page: pageId });
        }, () => {});
      }, found.q === null ? 0 : src.debounceMs);
      return () => cancel(t);
    }, [wanted, query, src.search, pageId]);
    if (page === false) return null;   // another source's page, or the app's own
    if (!Command || typeof Row !== 'function') return null;
    const asyncValue = typeof x.commandMenuAsyncValue === 'function' ? x.commandMenuAsyncValue : (v) => `command-menu-async-result:${v}`;
    const rowEl = (row, searched) => R.createElement(Row, {
      key: `${src.key}/${row.id}`, title: row.title, ...(row.description ? { description: row.description } : {}),
      value: searched ? asyncValue(`${PREFIX}${src.key}/${row.id}`) : `${row.title}${ZWSP}${src.key}/${row.id}`,
      ...(searched ? {} : { keywords: row.keywords ?? [] }), ...(row.disabled ? { disabled: true } : {}),
      onSelect: () => choose(src, row, close, reset),
    });
    // the rows of this registration's search for the text typed now only (a source registered again starts with none; an older query's
    // rows are not chosen while the newer one is asked)
    // on its page: the page's searched rows only; else its rows and its searched rows
    const items = page ? [] : typeof src.itemsOf === 'function' ? src.itemsOf() : src.items;
    const rows = [...items.map((r) => rowEl(r, false)), ...(wanted && found.search === src.search && found.q === query && found.page === pageId ? found.rows.map((r) => rowEl(r, true)) : [])];
    if (!rows.length) return null;
    if (src.group) return R.createElement(R.Fragment, null, ...rows);
    return R.createElement(Command.Group, {
      value: `${PREFIX}${src.key}`, className: 'flex flex-col', style: { gap: 'var(--spacing)' },
      heading: R.createElement('span', { className: 'block px-2 pt-2 text-sm text-codex-description' }, src.title),
    }, ...rows);
  }

  /** Beside the open palette: the mods' sources as sections of the app's own, while it is open. */
  function Registrar({ scopeNode, close }) {
    const R = o.react();
    const v = R.useSyncExternalStore(subscribe, getVersion, getVersion);
    const closeRef = R.useRef(close);
    closeRef.current = close;
    R.useLayoutEffect(() => {
      const atom = o.exports()?.commandMenuSections;
      if (!atom || !scopeNode || typeof scopeNode.set !== 'function') return undefined;
      pageScope = scopeNode;
      const mine = sources.map((src) => ({
        id: `${PREFIX}${src.key}`, order: src.above ? -1 : 0, ...(src.group ? { groupKey: src.group } : {}), enabled: true,
        // the only section shown while its drill-in page is on top, as the app's own pages (read when the palette draws)
        get exclusive() { return !!pageOf(src); },
        // called by the palette as a plain function: it only makes the source's own component
        render: (close2, reset) => R.createElement(ModSection, { key: src.key, src, close: close2 ?? closeRef.current, reset }),
      }));
      const ours = (s) => typeof s?.id === 'string' && s.id.startsWith(PREFIX);
      const sort = (list) => [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      try { scopeNode.set(atom, (list) => sort([...(Array.isArray(list) ? list : []).filter((s) => !ours(s)), ...mine])); } catch (e) { log('the palette\'s sections could not be written', { message: String(e?.message ?? e) }); }
      return () => { try { scopeNode.set(atom, (list) => (Array.isArray(list) ? list.filter((s) => !ours(s)) : list)); } catch { /* the palette went */ } };
    }, [v, scopeNode]);
    return null;
  }

  return {
    Registrar,
    /**
     * A hook, for a component of the framework's own inside the palette's cmdk (never a binding's render, which a bound wrapper calls only
     * once the runtime is there): the text typed in it now (cmdk's own state, so a search the palette clears itself is read as cleared;
     * '' on a build without it). Its hook is the same on every render.
     */
    useSearch() {
      const h = o.exports()?.commandMenuState;
      return typeof h === 'function' ? String(h((s) => s.search) ?? '') : '';
    },
    /** What choosing a row of a source does (its run, the source's choose, an instance's open or an app command), then `close`. */
    choose,
    /** The sources of the window's rules (the runtime calls it as rules change). */
    setSources(rules) { ruled = rules.map(sourceOf).filter(Boolean); sources = [...own, ...ruled]; version++; for (const fn of [...listeners]) { try { fn(); } catch { /* a registrar's own */ } } },
    /** The framework's own sources (the mods' commands, P5; the chats the app does not hold): `{key, title, items, search?}`, before the mods' rules. */
    setOwn(list) {
      // a framework source's items may be read as the palette draws them (a function: the mods' commands, whose `when` is asked then)
      // a framework row may be found by many terms (the hidden commands' notice: every one of theirs)
      const rowsOf = (items) => (Array.isArray(items) ? items : []).map((x) => rowOf(x, { whole: true })).filter(Boolean).slice(0, MAX_ROWS);
      own = (Array.isArray(list) ? list : []).map((x) => ({ key: x.key, rule: { mod: 'codexmods.framework', id: x.key }, framework: true, group: null, title: x.title, above: false,
        items: typeof x.items === 'function' ? [] : rowsOf(x.items), ...(typeof x.items === 'function' ? { itemsOf: () => { try { return rowsOf(x.items()); } catch { return []; } } } : {}),
        search: typeof x.search === 'function' ? x.search : null, choose: null, trigger: null, minQuery: 1, limit: 8, debounceMs: 120 }));
      sources = [...own, ...ruled]; version++;
      for (const fn of [...listeners]) { try { fn(); } catch { /* a registrar's own */ } }
    },
    sources: () => sources,
  };
}
