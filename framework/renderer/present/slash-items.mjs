// Mods' slash commands (docs/design/mod-surfaces.md §3.6; a scout of 21477). A command is one `add` rule
// on the composer's Palette (for Draft, slot `resultSources`) with `slash: {name, title?, description?, arguments?, prompt?}` and its `run`.
// The app's slash menu has a registry that its own commands, skills and saved prompts register into through hooks (the `slashHooks` and
// `slashRegistry` exposures); a registrar the `composer.suggest` binding mounts beside each composer's suggestion overlay registers the
// mods' commands there as the app's own items, so the app filters, ranks, draws and keys them, on every composer it shows. Choosing one
// removes the typed `/name` (the app's own path) and runs the command with the composer's Draft and thread in its env, and its arguments
// (`env.args`: what was typed after the name; the app keeps its menu open over letters, digits, spaces and `. : _ \ -`, and asks each
// item for its search key with the typed query, so the command's row stays matched while its arguments are typed); a `prompt` command
// inserts its text into the Draft instead, its arguments after it on a line of their own (the app's rule for its saved prompts). Item ids carry the app's `custom-prompt:` prefix, which the app's telemetry collapses, so a
// mod's names never leave the machine in the app's events. NO NODE API.

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** A command's arguments in the query the menu matched: what follows its name or one of its aliases (nothing when the query is not this command's). */
export function argsOf(query, name, aliases = []) {
  const q = String(query ?? '').trimStart();
  const [head] = q.split(/\s/, 1);
  if (!head || ![name, ...aliases].some((n) => head.toLowerCase() === n.toLowerCase())) return '';
  return q.slice(head.length).trim().slice(0, 1000);
}

/** A slash command as its rule says it, checked: null when the rule is not one. */
export function slashOf(r) {
  const sl = r?.data?.slash ?? r?.fns?.slash;
  if (!sl || typeof sl !== 'object' || typeof sl.name !== 'string' || !NAME.test(sl.name)) return null;
  const run = typeof sl.run === 'function' ? sl.run : null;
  const prompt = typeof sl.prompt === 'string' && sl.prompt.trim() ? sl.prompt.slice(0, 16 * 1024) : null;
  if (!run && !prompt) return null;
  return {
    key: `${r.mod}/${r.id}`, rule: r, name: sl.name, title: typeof sl.title === 'string' && sl.title.trim() ? sl.title.trim().slice(0, 80) : sl.name,
    description: typeof sl.description === 'string' ? sl.description.slice(0, 200) : undefined, args: typeof sl.arguments === 'string' ? sl.arguments.slice(0, 80) : undefined,
    aliases: Array.isArray(sl.aliases) ? sl.aliases.filter((a) => typeof a === 'string' && NAME.test(a)).slice(0, 5) : [],
    group: typeof sl.group === 'string' && sl.group.trim() ? sl.group.trim().slice(0, 40) : undefined, whenEmpty: sl.whenEmpty === true,
    run, prompt,
  };
}

/**
 * @param {{ react: () => any, exports: () => object, guard: (rule: object, fn: Function) => Function, env: (draft: object | null, thread: object | null) => object,
 *   insert: (draft: object, text: string) => void, log?: Function, offered?: (rule: object, draft: object | null) => boolean }} o  `offered`: a
 *   command's `where` holds on this composer's Draft (its mod reading it)
 */
export function createSlashItems(o) {
  const log = o.log ?? (() => {});
  let commands = [];
  let version = 0;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getVersion = () => version;

  /** Beside a composer's suggestion overlay: the mods' commands registered as this composer's slash items (the same hooks on every render). */
  function Registrar({ draft, thread }) {
    const R = o.react();
    const hooks = o.exports()?.slashHooks;
    const v = R.useSyncExternalStore(subscribe, getVersion, getVersion);
    const paneOf = o.paneContext?.() ?? null;
    const pane = paneOf ? R.useContext(paneOf) : null;   // the pane this composer is in (layouts.md D8)
    const target = R.useRef({ draft, thread, pane });
    target.current = { draft, thread, pane };
    const draftKey = draft ? `${draft.provider}/${draft.id}` : '';
    // the query the app last matched this composer's items against (it asks each item for its search key with it); another Draft's none
    const typed = R.useRef('');
    const typedFor = R.useRef(draftKey);
    if (typedFor.current !== draftKey) { typedFor.current = draftKey; typed.current = ''; }
    // which commands this Draft offers now (a `where` on it): asked on every render, so a change of the Draft changes the menu
    const offeredHere = (c) => !c.rule?.where || !o.offered || o.offered(c.rule, target.current.draft);
    const offered = commands.filter(offeredHere);
    const offeredKey = offered.map((c) => c.key).join('\n');
    const items = R.useMemo(() => offered.map((c) => ({
      id: `custom-prompt:codexmods/${c.key}`, title: c.title, ...(c.description ? { description: c.description } : {}), ...(c.group ? { group: c.group } : {}),
      searchAliases: [c.name, ...c.aliases], requiresEmptyComposer: c.whenEmpty, enabled: true,
      // the name alone is the row's search key, so "/name some words" keeps it matched
      getSearchQuery: (q) => { typed.current = typeof q === 'string' ? q : ''; return typed.current.trimStart().split(/\s+/)[0] ?? ''; },
      onSelect: () => {
        const { draft: d, thread: t, pane: p } = target.current;
        const args = argsOf(typed.current, c.name, c.aliases);
        typed.current = '';
        try {
          if (o.live && !o.live(c.rule)) return;   // its command went (or was registered again) while the menu was open
          if (!offeredHere(c)) return;   // its Draft no longer one it is offered on
          if (c.prompt) { if (d) o.insert(d, args ? `${c.prompt}\n${args}` : c.prompt); return; }
          o.guard(c.rule, c.run)({ ...o.env(d, t, p), args });
        } catch (e) { log('a slash command could not run', { command: c.key, message: String(e?.message ?? e) }); }
      },
    })), [v, draftKey, offeredKey]);
    if (hooks && typeof hooks.useComposerItems === 'function') hooks.useComposerItems(items, [v, draftKey, offeredKey]);
    return null;
  }

  return {
    Registrar,
    /** The commands of the window's rules (the runtime calls it as rules change). */
    setCommands(rules) { commands = rules.map(slashOf).filter(Boolean); version++; for (const fn of [...listeners]) { try { fn(); } catch { /* a registrar's own */ } } },
    commands: () => commands,
  };
}
