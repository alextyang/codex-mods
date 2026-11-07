// The slash menu's drawer (ui.choices, docs/design/public-hooks.md §3.11; scout H4-choices §2.4): on 21477 the composer's typeahead draws
// its commands with one component (its 4 props exactly: autocomplete, isHomeMenu, keyboardVariant, placement), given the commands the app
// already matched (`autocomplete.commands`: the app's built-ins and the mods' own, each with a stable id: `compact`, `fork`, `model`,
// `skill:<path>`, ...) and the open command's submenu (`autocomplete.submenuSections`: `/model`'s recent configurations and models,
// `/reasoning`'s efforts). A mod hides, relabels and orders slash commands (an order applies while nothing is typed: a typed query is the
// app's ranking; commands of a group stay together), and its choices of models and efforts apply to those submenus too. A relabelled
// command is still found by its own title (the app matched it before). Adding a command is `ui.composer.slash`. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { choicesPlan, applyChoices, memoOne, madeOf } from '../choices.mjs';

const memos = new WeakMap();   // the app's commands array -> its cached rewrite
/** Commands of a group together, the groups in the order they first come. */
function regroup(list) {
  const groups = new Map();
  for (const c of list) { const g = c?.group ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
  return [...groups.values()].flat();
}
const selectedIn = (items) => new Set(items.filter((x) => x && (x.RightIcon != null || x.selected === true)).map((x) => x.id));

/** The commands with the slash commands' choices (an order only while nothing is typed). */
function commandsOf(a, ctx, sp, typed, open) {
  const plan = typed ? { ...sp, order: null } : sp;
  const out = applyChoices(a.commands, plan, {
    idOf: (c) => (c && typeof c.id === 'string' ? c.id : null), keep: new Set(open ? [open] : []),
    instanceOf: (c) => madeOf('SlashCommand', c.id, { title: c.title, description: c.description, group: c.group }),
    relabel: (c, l) => ({ ...c, ...(l.title ? { title: l.title } : {}), ...(l.description ? { description: l.description } : {}) }),
  });
  return plan.order ? regroup(out) : out;
}
/** The open command's submenu with the models' and efforts' choices. */
function sectionsOf(sections, ctx, mp, ep) {
  // a model as the menu shows it (its slug and name): the menu lists one host's catalog, which it does not name (built review H7s round 2)
  const model = (id, title) => madeOf('Model', id, title ? { title } : {});
  const relabel = (x, l) => ({ ...x, ...(l.title ? { title: l.title } : {}), ...(l.description ? { description: l.description } : {}) });
  return sections.map((sec) => {
    if (!sec || !Array.isArray(sec.items)) return sec;
    const keep = selectedIn(sec.items);
    if (sec.id === 'models' && mp) return { ...sec, items: applyChoices(sec.items, mp, { idOf: (x) => x?.id ?? null, keep, relabel, instanceOf: (x) => model(x.id, x.title) }) };
    if (sec.id === 'reasoning-efforts' && ep) return { ...sec, items: applyChoices(sec.items, ep, { idOf: (x) => x?.id ?? null, keep, relabel, instanceOf: (x) => madeOf('Effort', x.id, { title: x.title }) }) };
    // a recent configuration (`model:effort:tier`) goes with its model or its effort; their order is the app's (its number shortcuts)
    if (sec.id === 'recent-model-configurations') {
      return { ...sec, items: sec.items.filter((x) => {
        const [m, effort] = String(x?.id ?? '').split(':');
        return keep.has(x?.id) || !((mp && mp.hides(m, model(m))) || (ep && ep.hides(effort, madeOf('Effort', effort))));
      }) };
    }
    return sec;
  });
}
const sectionMemos = new WeakMap();   // the app's submenu sections array -> its cached rewrite

export const slashMenu = defineBinding({
  id: 'slash.menu', presents: ['Draft'], subject: () => null,
  render(Original, props, factory, ctx) {
    const a = props.autocomplete;
    if (!a || typeof a !== 'object' || !Array.isArray(a.commands)) return undefined;
    const sp = choicesPlan(ctx, 'SlashCommand', 'slashMenu'), mp = choicesPlan(ctx, 'Model', 'slashMenu'), ep = choicesPlan(ctx, 'effort', 'slashMenu');
    if (!sp && !mp && !ep) return undefined;
    const typed = typeof a.ui?.query === 'string' ? a.ui.query : typeof a.query === 'string' ? a.query : '';
    const open = a.submenuCommand?.id ?? null;
    let commands = a.commands, sections = a.submenuSections;
    if (sp) {
      let memo = memos.get(a.commands);
      if (!memo) { memo = memoOne(); memos.set(a.commands, memo); }
      commands = memo([sp.sig, !typed, open], () => commandsOf(a, ctx, sp, typed, open));
    }
    if ((mp || ep) && Array.isArray(a.submenuSections)) {
      let memo = sectionMemos.get(a.submenuSections);
      if (!memo) { memo = memoOne(); sectionMemos.set(a.submenuSections, memo); }
      sections = memo([mp?.sig, ep?.sig], () => sectionsOf(a.submenuSections, ctx, mp, ep));
    }
    if (commands === a.commands && sections === a.submenuSections) return undefined;
    return factory(Original, { ...props, autocomplete: { ...a, commands, submenuSections: sections } });
  },
});

// The new chat's cloud environments (ui.choices of Environment; scout H4-choices §2.3): on 21477 the "Work in" menu's environment panel
// is given the environments it lists (`listToShow`, each `{id, label, ...}`, the selected first) with its own setters; a mod hides, orders
// and relabels them by id (the selected one stays). The run locations themselves (local, worktree, cloud) are drawn inline: not here.
const envMemos = new WeakMap();
export const environmentList = defineBinding({
  id: 'environment.list', presents: ['Draft'], subject: () => null,
  render(Original, props, factory, ctx) {
    if (!Array.isArray(props.listToShow)) return undefined;
    const plan = choicesPlan(ctx, 'Environment', 'newChat');
    if (!plan) return undefined;
    let memo = envMemos.get(props.listToShow);
    if (!memo) envMemos.set(props.listToShow, (memo = memoOne()));
    const list = memo([plan.sig, props.selectedEnvironment?.id], () => applyChoices(props.listToShow, { ...plan, adds: [] }, {
      idOf: (e) => (e && typeof e.id === 'string' ? e.id : null), keep: new Set(props.selectedEnvironment?.id ? [props.selectedEnvironment.id] : []),
      instanceOf: (e) => madeOf('Environment', e.id, { title: e.label, name: e.label }),
      relabel: (e, l) => (l.title ? { ...e, label: l.title } : e),
    }));
    return list === props.listToShow ? undefined : factory(Original, { ...props, listToShow: list, ...(list.length ? {} : { envListState: 'none-found' }) });
  },
});
