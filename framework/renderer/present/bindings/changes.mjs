// The side panel's Changes (docs/graph/03 ChangesView, DiffView; systems.md E7.5b, from a scout of 21477). The panel host creates the Changes tab outside the JSX seam, so the bindings sit on its parts, each reading the route's
// chat from RouteScope: the tab's body (its header rows), the controls row (its actions), the scope picker and the changed files' list
// are one ChangesView of the chat's ChangeSet (`thread:<id>`, the union of its turns' changes; the tab may show the working tree or the
// latest turn, which have no ChangeSet of their own), the parts after the first are its `part`s (slots and operations only, never a
// rule's claim). Each file's section is a DiffView of its FileChange (`thread:<id>:<absolute path>`, named by `reviewPath`, never by the
// diff's name, a placeholder while it loads), with its body (the diff, which takes `commentOn`) as its part. The mods' filters of the list
// (`ui.filter('changes', ...)`, public-hooks.md §3.12) leave out the files they do not keep, in the file tree and the diffs alike, with
// their notice as a header row; each tests the changed file as the list gives it (its absolute `path` and its `kind`). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { nodeList, actionNode } from './slots.mjs';
import { declaredFilters, keepsItem, filterNotice } from './list-filter.mjs';

const localThread = (route) => (route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' && route.conversationId ? route.conversationId : null);
/** The chat's ChangeSet, when the route shows one of Codex's chats. */
function changeSetOf(ctx, route) {
  const id = localThread(route);
  const thread = id ? ctx.thread(id) : null;
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own Changes panel, for its own chats
  return thread && thread.provider === 'codex' ? { type: 'ChangeSet', provider: 'codex', id: `thread:${thread.id}` } : null;
}
/** The ChangeSet of the route's chat, as a place names its parent's subject (the chat's own provider decides its subject). */
const setOn = (route) => (localThread(route) ? { type: 'ChangeSet', provider: 'codex', id: `thread:${localThread(route)}` } : null);
const viewPlace = (props, route) => ({ in: 'PanelTab', on: setOn(route), slot: 'view' });
const action = ({ R, ctx }, item, key) => actionNode(R, ctx, item, key);

/** The tab's header rows: the hosted regions as rows after the app's own (its pane layout function, wrapped). */
const headerRows = {
  kind: 'region',
  apply: (props, nodes) => (typeof props.renderSlots === 'function' && nodes.length ? {
    ...props,
    renderSlots: (arg) => props.renderSlots({ ...arg, headerRows: [...(Array.isArray(arg?.headerRows) ? arg.headerRows : []),
      ...nodes.map((node, i) => ({ id: `codexmods:${node?.key ?? i}`, height: 'content', content: node }))] }),
  } : props),
};

const presentsChanges = { presentation: 'ChangesView', presents: ['ChangeSet'], place: viewPlace, subject: (props, ctx, route) => changeSetOf(ctx, route) };

/** A changed file as the list's filters test it: its FileChange in the route's chat (a working-tree file has none: its path), its path and kind. */
const changedFile = (ctx, route, path, kind) => ({ ref: fileChangeOf(path, null, ctx, route) ?? { type: 'FileChange', provider: 'codex', id: path },
  state: { path, ...(typeof kind === 'string' ? { kind } : {}) } });
/** Whether the window's filters of the list keep a changed file (none on: every one). */
const keepsChange = (ctx, route, path, kind) => {
  const filters = declaredFilters(ctx, 'ChangesView');
  return !filters.length || typeof path !== 'string' || !path.startsWith('/') || keepsItem(ctx, filters, changedFile(ctx, route, path, kind));
};
const FILTER_ROW = 'codexmods:filter';

// The tab's body: header rows after the app's, and the filters' notice last while any is on.
export const changesView = defineBinding({ id: 'changes.view', ...presentsChanges, slots: { header: headerRows, filter: { kind: 'list', field: 'filter', apply: (props) => props } },
  render(Original, props, factory, ctx) {
    const filters = declaredFilters(ctx, 'ChangesView');
    const R = ctx.react();
    if (!filters.length || !R || typeof props.renderSlots !== 'function') return undefined;
    const notice = filterNotice(R, ctx, 'ChangesView', filters);
    return factory(Original, { ...props, renderSlots: (arg) => {
      const rows = Array.isArray(arg?.headerRows) ? arg.headerRows : [];
      return props.renderSlots({ ...arg, headerRows: rows.some((x) => x?.id === FILTER_ROW) ? rows : [...rows, { id: FILTER_ROW, height: 'content', content: notice }] });
    } });
  } });
// The controls row: actions after the app's (copy, refresh, the file tree's toggle, the git actions).
export const changesToolbar = defineBinding({ id: 'changes.toolbar', ...presentsChanges, part: true,
  slots: { toolbarActions: nodeList('actions', action, { field: 'actions' }) } });

/** The app's scope of a ChangesView for the card's: the latest turn, the working tree's uncommitted changes (the chat as a whole has none). */
const SCOPES = { turn: 'last-turn', uncommitted: 'uncommitted' };
// The scope picker: setScope is the app's own choice of what the tab shows (it remembers the last one, as its choices of view).
export const changesScope = defineBinding({ id: 'changes.scope', ...presentsChanges, part: true,
  operations: {
    setScope(props, [scope]) {
      if (scope === 'thread') return { unavailable: 'the app\'s Changes shows a turn or the working tree, not the chat\'s changes as a whole' };
      const filter = SCOPES[scope];
      if (!filter) return { unavailable: 'the scope is turn or uncommitted' };
      if (typeof props.onSelectDiffFilter !== 'function') return { unavailable: 'this Changes cannot change what it shows' };
      const offered = Array.isArray(props.availableDiffFilters) ? props.availableDiffFilters.map((f) => (typeof f === 'string' ? f : f?.id ?? f?.value)) : null;
      if (offered && offered.length && !offered.includes(filter)) return { unavailable: `this Changes does not offer ${scope}` };
      props.onSelectDiffFilter(filter);
      return true;
    },
  },
});

/** A FileChange's (`<changeSet>:<absolute path>`) or a File's absolute path, or null. */
function pathOf(target) {
  // eslint-disable-next-line codexmods/no-provider-identity -- the app's own Changes panel, for its own chats
  if (!target || typeof target !== 'object' || target.provider !== 'codex' || typeof target.id !== 'string') return null;
  if (target.type === 'File') return target.id.startsWith('/') ? target.id : null;
  const at = target.id.indexOf(':/');
  return target.type === 'FileChange' && at > 0 ? target.id.slice(at + 1) : null;
}
// The changed files' list: selectFile is the list's own selection (it scrolls the diff to the file).
// `fileRowActions`: entries of a changed file row's own menu (the file-menu seam, mod-surfaces.md §3.5), not through these props
// The filters leave out of its entries the files they do not keep.
export const changesFiles = defineBinding({ id: 'changes.files', ...presentsChanges, part: true, slots: { fileRowActions: { kind: 'external' } },
  render(Original, props, factory, ctx, route) {
    if (!Array.isArray(props.entries) || !declaredFilters(ctx, 'ChangesView').length) return undefined;
    const entries = props.entries.filter((x) => !x || keepsChange(ctx, route, x.path, x.changeKind));
    return entries.length === props.entries.length ? undefined : factory(Original, { ...props, entries });
  },
  operations: {
    selectFile(props, [target]) {
      const path = pathOf(target);
      if (!path) return { unavailable: 'selectFile takes a FileChange or a File of this Mac' };
      if (typeof props.onSelectPath !== 'function' || !Array.isArray(props.entries)) return { unavailable: 'this list cannot select from here' };
      if (!props.entries.some((x) => x && x.path === path)) return { unavailable: 'the file is not in what Changes shows' };
      props.onSelectPath(path);
      return true;
    },
  },
});

/** A file section's FileChange in the chat's ChangeSet, by its absolute review path. */
function fileChangeOf(path, hostId, ctx, route) {
  const set = changeSetOf(ctx, route);
  return set && typeof path === 'string' && path.startsWith('/') && (hostId == null || hostId === 'local') ? { type: 'FileChange', provider: 'codex', id: `${set.id}:${path}` } : null;
}
const diffPlace = (props, route) => ({ in: 'ChangesView', on: setOn(route), slot: 'files' });
/** A mod's file action in the header: its clicks stay its own (the header's span may toggle the file as viewed). */
const fileAction = ({ R, ctx }, item, key) => R.createElement('span', { key, style: { display: 'contents' }, onClick: (ev) => ev?.stopPropagation?.() }, actionNode(R, ctx, item, key));

// One file's section: its header's actions after the app's (before the open-in button), its layout as the app's diff mode says; openFile
// is the header's own open (a tab in the panel: what the window shows), for a working-tree file too (which has no FileChange yet).
export const diffView = defineBinding({
  id: 'diff.view', presentation: 'DiffView', presents: ['FileChange'], place: diffPlace,
  subject: (props, ctx, route) => fileChangeOf(props.reviewPath, props.hostId, ctx, route),
  slots: { fileActions: nodeList('headerEndContent', fileAction, { field: 'actions' }) },
  layout: (props) => (props.viewType === 'unified' || props.viewType === 'split' ? props.viewType : undefined),   // `auto`: the app decides by width
  // a file the filters do not keep is not drawn
  render: (Original, props, factory, ctx, route) => (keepsChange(ctx, route, props.reviewPath, props.fileEntry?.changeKind ?? props.changeKind) ? undefined : null),
  operations: {
    openFile(props) {
      const open = props.headerOpenAction?.onClick;
      if (typeof open !== 'function') return { unavailable: 'this file cannot be opened from here' };
      open();
      return true;
    },
  },
});
// Its diff: commentOn opens the app's comment editor at those lines (the comment is made when the user sends it).
export const diffBody = defineBinding({
  id: 'diff.body', presentation: 'DiffView', presents: ['FileChange'], place: diffPlace, part: true,
  subject: (props, ctx, route) => fileChangeOf(props.diffViewProps?.reviewPath, null, ctx, route),
  operations: {
    commentOn(props, [lines]) {
      const click = props.diffViewProps?.onGutterUtilityClick;
      if (typeof click !== 'function') return { unavailable: 'this diff takes no comments now' };
      const start = Number(lines?.start ?? lines?.line), end = Number(lines?.end ?? lines?.start ?? lines?.line);
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return { unavailable: 'commentOn takes {start, end?, side?}: lines from 1' };
      click({ start, end, side: lines?.side === 'old' || lines?.side === 'deletions' ? 'deletions' : 'additions' });
      return true;
    },
  },
});
