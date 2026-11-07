// A mod's section of the sidebar (ui.sidebar.section, docs/design/public-hooks.md §3.14; scout H3-sidebar §1.4-1.5): an add rule on
// Sidebar `section` (declared, read like the filter), drawn by the framework with the app's own parts: its group shell (the
// `SidebarGroup` exposure: title, chevron, actions on hover, collapse) around its list by key (the `SidebarList` exposure), whose rows are
// the app's own chat rows (status, unread, time, hover actions, menus, the mods' badges). Its chats: those its `where` selects or its
// `of` names, as its mod may read them (a live view, checked again here as the mod sees each chat), in its `sort`, kept by the window's
// filter. The list takes what the app's own lists are given (its map of chats and the rest), read from one of them while the sidebar
// shows one; a chat the app's map has no entry for gets one. Collapsed is the window's own (from the declaration), not kept across a
// reload. A section is a view: its chats stay in the app's own lists. NO NODE API.
import { compileWhere } from '../../../shared/where.mjs';
import { actionNode, badgeNode } from './slots.mjs';
import { sidebarFilter, keeps } from './sidebar-filter.mjs';
import { sidebarHides, hiddenBy, openChats, tally, subjectKey } from './sidebar-hides.mjs';
import { comparatorOf } from './sidebar-order.mjs';
import { createLentParts } from '../lent/index.mjs';
import { createKit } from '../kit/index.mjs';
import { createDialogs } from '../dialogs.mjs';
import { pageParts } from '../page-parts.mjs';

const MAX = 50;
const collapsed = new Map();   // section key -> collapsed, this window's
const CODEX_KEY = (id) => `codex:thread:local:${id}`;
/** What the app's own lists are given that a mod's list takes too (not their keys, paging, drag or empty state). */
const SHARED = ['conversationByKey', 'projectByKey', 'codexProjectKindByThreadKey', 'chatGptSource', 'mode', 'projectSortMode', 'showConversationTypeHoverLabel',
  'showConversationTypeIcons', 'showThreadDetails', 'browserLoadingPlaceholder'];

const SHARED_KEY = 'local:sidebar.sections.shared';
const AGENTS_KEY = 'local:sidebar.agents';
const sharedProps = new WeakMap();   // the runtime's ctx -> the props one of the app's lists was last given
/** One of the app's lists rendered (sidebar.list): what it was given is what the mods' lists take; the sidebar draws them once it has it. */
export function noteShared(ctx, props) {
  if (!props || !(props.conversationByKey instanceof Map)) return;
  const first = !sharedProps.has(ctx);
  sharedProps.set(ctx, props);
  if (first) ctx.local?.touch?.(SHARED_KEY);
}
/** What the app's lists are given, or null while none has rendered in this window. */
export function sharedOf(ctx) { ctx.local?.read?.(SHARED_KEY); return sharedProps.get(ctx) ?? null; }

/** The declared sections in rule order, for one place ('top' or 'end'). */
export function declaredSections(ctx, position) {
  if (typeof ctx.declared !== 'function') return [];
  return ctx.declared('Sidebar', 'section').filter((r) => ((r.data?.section?.position ?? 'end') === position));
}

/** @param {{ R: object, ctx: object }} o */
export function createSidebarSections(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  // the framework's rows for the chats the app's own rows cannot draw (graph-integrity G2.1: the app's store does not hold them)
  let lent = null;
  const parts = () => (lent ??= createLentParts({ react: () => R, exports: () => ctx.exports?.() ?? {}, drops: () => ctx.drops?.() ?? null,
    kit: createKit({ react: () => R, parts: () => { const ex = ctx.exports?.() ?? {}; return { Button: ex.Button, Menu: ex.Menu, MenuItem: ex.MenuParts?.Item, Separator: ex.MenuParts?.Separator }; } }) }));
  let dialogs = null;
  /**
   * A chat the app does not hold, as a row: opened to its registered view; its menu the shared actions it supports (archive or unarchive
   * and mark as read, a Thread's own; mark as unread and delete where it has them), each the user's own act (the Host invokes it as the
   * user's). Delete asks first, in the framework's own Dialog: it cannot be undone. What its provider declares unverified is not offered
   * (graph-integrity G9.3: until a native check shows it).
   */
  function ForeignRow({ chat }) {
    const [confirming, setConfirming] = R.useState(false);
    const s = chat.state ?? {};
    const unverified = new Set(Array.isArray(chat.unverified) ? chat.unverified : []);
    const offered = (op) => !unverified.has(op);
    const supports = (Array.isArray(chat.supports) ? chat.supports : []).filter(offered);
    const title = String(chat.summary?.title ?? s.title ?? '');
    const run = (op) => () => {
      Promise.resolve(ctx.userAct?.(chat.ref, op)).then((out) => { if (out && out.status !== 'done') ctx.log?.('a chat\'s action was not done', { op, out }); });
    };
    const menu = [...(offered(s.archived ? 'restore' : 'archive') ? [{ label: s.archived ? 'Unarchive' : 'Archive', onSelect: run(s.archived ? 'restore' : 'archive') }] : []),
      ...(s.unread && offered('markRead') ? [{ label: 'Mark as read', onSelect: run('markRead') }] : supports.includes('markUnread') ? [{ label: 'Mark as unread', onSelect: run('markUnread') }] : []),
      ...(supports.includes('delete') ? [{ label: 'Delete…', danger: true, onSelect: () => setConfirming(true) }] : [])];
    // selected while its window shows it, anywhere (Window.shows, graph-integrity G4.3): a presentation decision made from what the window shows
    const selected = ctx.use(() => {
      const w = typeof ctx.windowRef === 'function' ? ctx.windowRef() : null;
      const shows = w ? ctx.subject(w)?.state?.shows : null;
      return Array.isArray(shows) && shows.some((r) => r?.provider === chat.ref.provider && r?.id === chat.ref.id && r?.type === chat.ref.type);
    });
    // its marks (graph-integrity G2.2): the badges its sidebar row's rules give it, as on the app's own rows
    const badges = (typeof ctx.threadBadges === 'function' ? ctx.threadBadges(chat.ref) : []).map(({ key, item }) => badgeNode(R, ctx, item, key));
    const row = e(parts().ChatRow, { title, status: s.status, unread: s.unread === true, time: s.updatedAt, selected, drag: chat.ref, onOpen: () => ctx.open?.(chat.ref, chat), menu, badges });
    if (!confirming) return row;
    const ex = ctx.exports?.() ?? {};
    const { ModsDialog } = (dialogs ??= createDialogs({ R, exports: () => ctx.exports?.() ?? {}, ctx }));
    const { button } = pageParts(R, ex);
    const close = () => setConfirming(false);
    return e(R.Fragment, null, row, e(ModsDialog, { title: 'Delete this chat?', onClose: close, subject: chat.ref, purpose: 'confirm',
      footer: [e(R.Fragment, { key: 'cancel' }, button('Cancel', close)), e(R.Fragment, { key: 'delete' }, button('Delete', () => { close(); run('delete')(); }, false, 'danger'))] },
    e('p', { className: 'text-sm' }, `“${title || 'This chat'}” is deleted by its agent. It cannot be undone.`)));
  }
  const foreignRows = (chats) => chats.map((x) => e(ForeignRow, { key: `${x.ref.provider}\n${x.ref.id}`, chat: x }));

  /** The chats a section lists: a live view of its where (or the ones it names), as its mod may read them, sorted. */
  function useMembers(rule, spec) {
    const [items, setItems] = R.useState([]);
    const where = spec.where && typeof spec.where === 'object' ? spec.where : null;
    const of = Array.isArray(spec.of) ? spec.of.slice(0, MAX) : null;
    const key = JSON.stringify(where);
    // the chats it names, observed (the same hooks every render)
    const named = ctx.use(() => (of ? of.map((r) => ctx.subject(r)).filter((x) => x && !x.gone) : []));
    R.useEffect(() => {
      if (!where) return undefined;
      let list = new Map();
      const sub = ctx.view({ type: 'Thread', where, depth: 'core' }, (m) => {
        if (!m) return;
        if (m.type === 'snapshot' || (m.type === 'delta' && Array.isArray(m.items))) list = new Map((m.items ?? []).filter((x) => x && !x.gone).map((x) => [`${x.ref.provider}\n${x.ref.id}`, x]));
        else if (m.type === 'delta' && m.event) {
          const k = `${m.event.ref?.provider}\n${m.event.ref?.id}`;
          if (m.event.kind === 'removed') list.delete(k);
          else if (m.event.instance) list.set(k, m.event.instance);
        }
        setItems([...list.values()]);
      });
      return () => { try { sub.dispose(); } catch { /* gone */ } };
    }, [key]);
    const env = typeof ctx.whereEnv === 'function' ? ctx.whereEnv(rule) : {};
    let test = null;
    if (where) { try { test = compileWhere(where); } catch { test = null; } }
    // every provider's chats (graph-integrity G2.1): the app's own as its rows, any other as the framework's
    const seen = (where ? items : named).filter((x) => x?.ref && (typeof env.may !== 'function' || env.may(x)) && (!where || (test && test.test(x, env))));
    const compare = spec.sort ? comparatorOf(ctx, rule, spec.sort) : null;
    return compare ? [...seen].sort(compare) : seen;
  }

  function Section({ rule, shared }) {
    const ex = ctx.exports?.() ?? {};
    const Group = ex.SidebarGroup, List = ex.SidebarList;
    const spec = rule.data?.section ?? {};
    const members = useMembers(rule, spec);
    const sectionKey = `codexmods:${rule.mod}/${rule.id}`;
    const [expanded, setExpanded] = R.useState(false);
    const [isCollapsed, setCollapsed] = R.useState(() => (collapsed.has(sectionKey) ? collapsed.get(sectionKey) : spec.collapsed === true));
    // the window's filter and the mods' hides (sidebar-hides.mjs), and the chats they read, followed (this component renders outside a
    // binding's wrapper)
    const { f, keys, others } = ctx.use(() => {
      const filter = sidebarFilter(ctx);
      const hides = sidebarHides(ctx);
      const open = hides.length ? openChats(ctx) : null;
      const hidden = new Map();
      // the filter asked about every member first: what the hides leave out is never told to a filter's functions
      const kept = filter ? new Set(members.filter((x) => keeps(ctx, filter, x.ref.id)).map((x) => x.ref.id)) : null;
      const listed = members.filter((x) => {
        const by = hides.length ? hiddenBy(ctx, hides, x, open) : null;
        if (by) { const s = hidden.get(by) ?? new Set(); s.add(subjectKey(x.ref)); hidden.set(by, s); }
        return !by;
      });
      tally(ctx, sectionKey, hidden);
      const shown = listed.filter((x) => !kept || kept.has(x.ref.id)).slice(0, MAX);
      // the app's own rows for the chats it holds; the framework's for the others
      return { f: filter, keys: shown.filter((x) => ctx.holds?.(x.ref) !== false).map((x) => CODEX_KEY(x.ref.id)), others: shown.filter((x) => ctx.holds?.(x.ref) === false) };
    });
    if (typeof Group !== 'function' || typeof List !== 'function') return null;
    if (!keys.length && !others.length && f) return null;   // a filtered sidebar shows no empty section (as the app's project groups)
    // the app's map of chats, with an entry for each of ours it has none for
    const byKey = new Map(shared.conversationByKey instanceof Map ? shared.conversationByKey : []);
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, { source: 'codex', threadKey: k.replace('codex:thread:', '') });
    const onCollapsedChange = (v) => { const next = typeof v === 'boolean' ? v : !isCollapsed; collapsed.set(sectionKey, next); setCollapsed(next); };
    const given = rule.fns?.items ?? rule.data?.items;
    const actions = (Array.isArray(given) ? given : []).map((a, i) => actionNode(R, ctx, { ...a, run: typeof a.run === 'function' ? () => ctx.guard(rule, a.run)({}) : undefined }, `${sectionKey}/a${i}`));
    const label = typeof spec.title === 'string' ? spec.title : rule.id;
    const list = e(List, {
      ...Object.fromEntries(SHARED.filter((k) => shared[k] !== undefined).map((k) => [k, shared[k]])),
      conversationByKey: byKey, projectByKey: shared.projectByKey instanceof Map ? shared.projectByKey : new Map(),
      keys, maxItems: Number.isInteger(spec.limit) ? spec.limit : 10, expanded, onExpandedChange: (v) => setExpanded(typeof v === 'boolean' ? v : !expanded),
      threadContainerId: sectionKey, emptyState: e('div', { className: 'px-row-x py-1 text-sm text-token-text-secondary' }, 'No chats'),
    });
    return e(Group, { sectionKey, heading: label, label, collapsed: isCollapsed, onCollapsedChange, titleActions: actions.length ? e(R.Fragment, null, ...actions) : null, titleActionsOnHover: true },
      others.length ? e(R.Fragment, null, keys.length ? list : null, ...foreignRows(others)) : list);
  }

  /**
   * The chats of each agent the app does not hold (graph-integrity G2.1): a group per agent, after the app's own groups, its chats by recency
   * (archived ones left out), each the framework's row. The app's store never holds them; their provider says what they are.
   */
  // the agents the app does not hold, followed once per window (the sidebar draws their groups only while there are some)
  let agentsList = [], agentsSub = null;
  function watchAgents() {
    if (agentsSub || typeof ctx.view !== 'function') return;
    let list = new Map();
    agentsSub = ctx.view({ type: 'Agent', depth: 'core' }, (m) => {
      if (!m) return;
      if (m.type === 'snapshot' || (m.type === 'delta' && Array.isArray(m.items))) list = new Map((m.items ?? []).filter((x) => x && !x.gone && ctx.holds?.(x.ref) === false).map((x) => [`${x.ref.provider}\n${x.ref.id}`, x]));
      else if (m.type === 'delta' && m.event?.ref) {
        const k = `${m.event.ref.provider}\n${m.event.ref.id}`;
        if (m.event.kind === 'removed') list.delete(k); else if (m.event.instance && ctx.holds?.(m.event.ref) === false) list.set(k, m.event.instance);
      } else return;
      agentsList = [...list.values()];
      ctx.local?.touch?.(AGENTS_KEY);
    });
  }
  function useAgents() { ctx.local?.read?.(AGENTS_KEY); return agentsList; }
  function AgentGroup({ agent }) {
    const ex = ctx.exports?.() ?? {};
    const Group = ex.SidebarGroup;
    const [chats, setChats] = R.useState([]);
    const key = `${agent.ref.provider}\n${agent.ref.id}`;
    R.useEffect(() => {
      let list = new Map();
      const sub = ctx.view({ type: 'Thread', where: { agent: agent.ref, archived: false }, depth: 'core' }, (m) => {
        if (!m) return;
        if (m.type === 'snapshot' || (m.type === 'delta' && Array.isArray(m.items))) list = new Map((m.items ?? []).filter((x) => x && !x.gone).map((x) => [`${x.ref.provider}\n${x.ref.id}`, x]));
        else if (m.type === 'delta' && m.event?.ref) {
          const k = `${m.event.ref.provider}\n${m.event.ref.id}`;
          if (m.event.kind === 'removed' || m.event.instance?.state?.archived) list.delete(k); else if (m.event.instance) list.set(k, m.event.instance);
        } else return;
        setChats([...list.values()]);
      });
      return () => { try { sub.dispose(); } catch { /* gone */ } };
    }, [key]);
    const sectionKey = `codexmods:agent:${key}`;
    const [isCollapsed, setCollapsed] = R.useState(() => collapsed.get(sectionKey) === true);
    const sorted = [...chats].filter((x) => ctx.holds?.(x.ref) === false).sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0)).slice(0, MAX);
    if (!sorted.length || typeof Group !== 'function') return null;
    const label = String(agent.summary?.title ?? agent.state?.name ?? agent.ref.id);
    const onCollapsedChange = (v) => { const next = typeof v === 'boolean' ? v : !isCollapsed; collapsed.set(sectionKey, next); setCollapsed(next); };
    return e(Group, { sectionKey, heading: label, label, collapsed: isCollapsed, onCollapsedChange }, e(R.Fragment, null, ...foreignRows(sorted)));
  }
  function AgentGroups() {
    const agents = useAgents();
    return agents.length ? e(R.Fragment, null, ...agents.map((a) => e(AgentGroup, { key: `${a.ref.provider}\n${a.ref.id}`, agent: a }))) : null;
  }
  return {
    /** Whether there are agents the app does not hold (their groups to draw); following them from the first ask. */
    hasAgents() { watchAgents(); ctx.local?.read?.(AGENTS_KEY); return agentsList.length > 0; },
    /** The groups of the agents the app does not hold (G2.1): one element, after the app's own groups. */
    agentsNode: () => e(AgentGroups, { key: 'codexmods:agents' }),
    dispose() { try { agentsSub?.dispose(); } catch { /* gone */ } agentsSub = null; },
    /** The sections' elements for one place, given what the app's lists are given (empty while none is shown). */
    nodesFor(rules, shared) {
      if (!shared) return [];
      return rules.map((rule) => e(Section, { key: `codexmods:section:${rule.mod}/${rule.id}`, rule, shared }));
    },
  };
}
