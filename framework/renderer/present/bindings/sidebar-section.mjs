// SidebarSection (docs/graph/03): a group in the sidebar. On 21477 a project's section is the component whose props carry chatGptSource,
// locationIdPrefix, mode, project and projectSortMode; `project.group` names the app's project (projectId, projectKind 'local' or 'remote',
// label, rootPaths, threadKeys). A local project's section shows the native LocalProject (the app's id is its id). It passes through.
// E7.3: it sits in the Sidebar (its subject, the App, named outright), and its `items` slot puts threads the app holds in the group (its
// `threadKeys`, `local:<id>`: the app shows them in its own order); a thread the app does not hold shows nothing. `showMore` (E8.9) is
// the group's own "Show more": the app's expander state (`sidebarShowAll`: the AppScope atom of the groups shown in full, set the way its
// button sets it). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { summarySlot } from './slots.mjs';
import { sidebarFilter, keeps } from './sidebar-filter.mjs';
import { sidebarHides, hiddenBy, openChats, tally, subjectKey, protectedChat } from './sidebar-hides.mjs';
import { sidebarOrder, sortKeys, listOf } from './sidebar-order.mjs';
import { noteShared } from './sidebar-sections.mjs';

/** The instance a sidebar key names: a chat's (`local:<id>`), or a local project's group's. */
const chatOf = (ctx, threadKey) => { const ref = typeof threadKey === 'string' ? ctx.thread(threadKey) : null; const x = ref ? ctx.subject(ref) : null; return x && !x.gone ? x : null; };

/** A local project's group's LocalProject, or null. */
const projectOfGroup = (ctx, g) => {
  if (!g || g.projectKind !== 'local' || typeof g.projectId !== 'string' || !g.projectId) return null;
  const x = ctx.subject({ type: 'LocalProject', provider: 'codex', id: g.projectId });
  return x && !x.gone ? x : null;
};
/** Note a subject a mod hides (the tally a list tells the notice). */
const note = (hidden, mod, inst) => { const s = hidden.get(mod) ?? new Set(); s.add(subjectKey(inst.ref)); hidden.set(mod, s); };
/** Does a group hold a chat no hide takes out (the one shown, one that needs the user)? Its group then stays, whoever hides its project. */
const holdsProtected = (ctx, threadKeys, open) => threadKeys.some((k) => protectedChat(chatOf(ctx, k), open));
/** The thread keys the mods' hides (sidebar-hides.mjs) leave out of a list, noting each in `hidden`. */
const unhidden = (ctx, keys, hides, open, hidden) => keys.filter((k) => {
  const c = chatOf(ctx, k);
  const by = c ? hiddenBy(ctx, hides, c, open) : null;
  if (by) note(hidden, by, c);
  return !by;
});

/** The group's own name (its label) changed: a project's summary (its title) or its label (after the name, public-hooks.md §3.13). */
const withLabel = (props, label) => (props.project?.group && typeof props.project.group.label === 'string'
  ? { ...props, project: { ...props.project, group: { ...props.project.group, label } } } : props);
const labels = {
  kind: 'list', field: 'label',
  apply: (props, entries) => {
    const said = entries.map((e) => (typeof e.item === 'string' ? e.item : typeof e.item?.text === 'string' ? e.item.text : '')).map((t) => t.trim().slice(0, 40)).filter(Boolean);
    const own = props.project?.group?.label;
    return said.length && typeof own === 'string' ? withLabel(props, `${own} · ${said.join(' · ')}`) : props;
  },
};

/** The group's thread keys with the added threads' (the app's own first, none twice). */
const items = {
  kind: 'list', field: 'items',
  apply: (props, entries) => {
    const g = props.project && props.project.group;
    if (!g || !Array.isArray(g.threadKeys)) return props;
    // eslint-disable-next-line codexmods/no-provider-identity -- GI2b: shared surfaces list every provider's chats (G2.1)
    const keys = entries.map((e) => e.item).filter((r) => r && typeof r === 'object' && r.provider === 'codex' && typeof r.id === 'string' && r.id)
      .map((r) => `local:${r.id}`).filter((k, i, all) => !g.threadKeys.includes(k) && all.indexOf(k) === i);
    return keys.length ? { ...props, project: { ...props.project, group: { ...g, threadKeys: [...g.threadKeys, ...keys] } } } : props;
  },
};

export const sidebarSection = defineBinding({
  id: 'sidebar.section', presentation: 'SidebarSection',
  place: { in: 'Sidebar', on: { type: 'App', provider: 'codex', id: 'codex' }, slot: 'sections' },
  presents: ['Project'],
  subject(props) {
    const g = props.project?.group;
    return g && g.projectKind === 'local' && typeof g.projectId === 'string' && g.projectId ? { type: 'LocalProject', provider: 'codex', id: g.projectId } : null;
  },
  // a group that holds a chat no hide takes out (the one shown, one that needs the user) is never hidden or replaced whole (layouts.md D9;
  // its chats are hidden one by one, as ui.hide('Thread') does)
  keeps: (props, ctx) => { const g = props.project?.group; return !!g && Array.isArray(g.threadKeys) && holdsProtected(ctx, g.threadKeys, openChats(ctx)); },
  // its name as a mod's summary says it, then the mods' labels after it (public-hooks.md §3.13)
  slots: { items, summary: summarySlot((p, s) => (s.title ? withLabel(p, s.title) : p)), label: labels },
  // the window's sidebar filter (E8.9j): the group lists only the chats that match, and a group with none is not shown; the mods' hides
  // (public-hooks.md §3.12): the chats they hide are not listed, and a project they hide not shown, unless it holds a chat no hide takes
  // out. The filter is asked about every chat of the group first: what the hides leave out is never told to a filter's functions.
  render(Original, props, factory, ctx) {
    const f = sidebarFilter(ctx);
    const hides = sidebarHides(ctx);
    const g = props.project && props.project.group;
    if (!g || !Array.isArray(g.threadKeys)) return undefined;
    const list = `group:${g.projectKind}:${g.projectId}`;
    const hidden = new Map();
    const filtered = f ? new Set(g.threadKeys.filter((k) => keeps(ctx, f, k))) : null;
    let threadKeys = g.threadKeys;
    if (hides.length) {
      const open = openChats(ctx);
      const project = projectOfGroup(ctx, g);
      const by = project && !holdsProtected(ctx, threadKeys, open) ? hiddenBy(ctx, hides, project, open) : null;
      if (by) { note(hidden, by, project); tally(ctx, list, hidden); return null; }
      const kept = unhidden(ctx, threadKeys, hides, open, hidden);
      if (kept.length !== threadKeys.length) threadKeys = kept;
    }
    tally(ctx, list, hidden);
    if (filtered) threadKeys = threadKeys.filter((k) => filtered.has(k));
    if (threadKeys === g.threadKeys) return undefined;
    // filtered to none: not shown; a group only the hides emptied stays as the app shows an empty one
    if (!threadKeys.length && f) return null;
    return factory(Original, { ...props, project: { ...props.project, group: { ...g, threadKeys } } });
  },
  operations: {
    showMore(props, args, ctx) {
      const g = props.project?.group;
      const ex = ctx.exports?.()?.sidebarShowAll;
      const node = typeof ctx.anyScopeNode === 'function' ? ctx.anyScopeNode() : null;
      if (!ex || typeof ex.set !== 'function' || !node || !g || typeof g.projectId !== 'string') return { unavailable: 'this group cannot show more from here' };
      ex.set(node, `project:${g.projectId}`, true);
      return true;
    },
  },
});

// The sidebar's other lists (E8.9j; scout E8-frame-slots §2.2: on 21477 one component lists pinned chats, chats, a custom section's items
// and the projects, by key): while the window's sidebar is filtered, a list keeps the Codex chats that match and the Codex project groups
// that hold one; the rest (ChatGPT conversations and projects, pages) is not listed. The app's paging and empty states stay its own.
// Its order (ui.sidebar.order, sidebar-order.mjs): the keys in the order the first declared order naming the list gives (pinned chats,
// chats, the project groups), after the filter, where the user has not arranged the list by hand (layouts.md D9).
export const sidebarList = defineBinding({
  id: 'sidebar.list', presents: ['App'],
  subject: () => null,
  render(Original, props, factory, ctx) {
    if (!Array.isArray(props.keys)) return undefined;
    // what it is given, the mods' sections take too (ui.sidebar.section): not one of theirs (theirs are the framework's own elements)
    if (typeof props.threadContainerId !== 'string' || !props.threadContainerId.startsWith('codexmods:')) noteShared(ctx, props);
    const f = sidebarFilter(ctx);
    const hides = sidebarHides(ctx);
    const compare = sidebarOrder(ctx, listOf(props), props.keys);
    const list = `list:${typeof props.threadContainerId === 'string' ? props.threadContainerId : 'chats'}`;
    if (!f && !compare && !hides.length) { tally(ctx, list, new Map()); return undefined; }
    const conversations = props.conversationByKey, projects = props.projectByKey;
    const conversation = (key) => (typeof conversations?.get === 'function' ? conversations.get(key) : null);
    const project = (key) => (typeof projects?.get === 'function' ? projects.get(key) : null);
    const keep = (key) => {
      const c = conversation(key);
      if (c) return c.source === 'codex' && keeps(ctx, f, c.threadKey);
      const p = project(key);
      // every chat of the group asked (never stopping at the first kept: which one that was is not told to another filter's mod)
      return !!p && p.source === 'codex' && Array.isArray(p.group?.threadKeys) && p.group.threadKeys.map((k) => keeps(ctx, f, k)).some(Boolean);
    };
    // the filter asked about every key first: what the hides leave out is never told to a filter's functions
    const filtered = f ? new Set(props.keys.filter(keep)) : null;
    // the mods' hides (public-hooks.md §3.12): a chat they hide, and a project's group they hide (unless it holds a chat no hide takes out)
    const hidden = new Map();
    const open = hides.length ? openChats(ctx) : null;
    const shown = (key) => {
      const c = conversation(key);
      if (c) {
        const chat = c.source === 'codex' ? chatOf(ctx, c.threadKey) : null;
        const by = chat ? hiddenBy(ctx, hides, chat, open) : null;
        if (by) note(hidden, by, chat);
        return !by;
      }
      const g = project(key)?.group;
      const inst = g && !holdsProtected(ctx, Array.isArray(g.threadKeys) ? g.threadKeys : [], open) ? projectOfGroup(ctx, g) : null;
      const by = inst ? hiddenBy(ctx, hides, inst, open) : null;
      if (by) note(hidden, by, inst);
      return !by;
    };
    const instanceOf = (key) => {
      const c = conversation(key);
      if (c) return c.source === 'codex' ? chatOf(ctx, c.threadKey) : null;
      const g = project(key)?.group;
      if (!g || g.projectKind !== 'local' || typeof g.projectId !== 'string') return null;
      const x = ctx.subject({ type: 'LocalProject', provider: 'codex', id: g.projectId });
      return x && !x.gone ? x : null;
    };
    let keys = hides.length ? props.keys.filter(shown) : props.keys;
    if (keys.length === props.keys.length) keys = props.keys;
    tally(ctx, list, hidden);
    if (filtered) keys = keys.filter((k) => filtered.has(k));
    if (compare) keys = sortKeys(keys, instanceOf, compare);
    return keys === props.keys ? undefined : factory(Original, { ...props, keys });
  },
});

/** A project group's chats in the first declared order naming it (sidebar.section.list): its keys, which the app then takes as given. */
export function orderedGroup(props, ctx) {
  const g = props.group;
  if (!g || !Array.isArray(props.threadKeys) || g.projectKind !== 'local' || typeof g.projectId !== 'string') return null;
  const compare = sidebarOrder(ctx, { name: 'project', project: { provider: 'codex', id: g.projectId } }, props.threadKeys);
  if (!compare) return null;
  return { ...props, threadKeys: sortKeys(props.threadKeys, (k) => chatOf(ctx, k), compare), threadOrderIsPrecomputed: true };
}
