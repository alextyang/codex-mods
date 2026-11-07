// FilesView (docs/graph/03): a tree of a folder's files. On 21477 the file tree's base component (the review panel's files pane uses it)
// carries the folder it shows (`cwd`) and its host; it names that Folder on this Mac. It passes through. Selecting a file (E7.1) is the
// app's own `onSelectionChange([path])`, the tree's own path of the file (a sectioned tree's display path, under its section), as a
// click on its row does (the app then previews it); a folder's
// selection lives in the tree's own model, out of reach. The mods' filters of the list (`ui.filter('files', ...)`, public-hooks.md §3.12)
// leave out of the Files tab's tree (the tree under its pane, `files.pane`, the nearest site: the Changes tab's list is that pane too, and
// its tree this component, which are the Changes list's) the files they do not keep (each tests the File as the tree gives it: its absolute `path` and its `name`),
// and a folder all of whose listed files are left out; the notice is the pane's (panel.mjs). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { declaredFilters, keepsItem } from './list-filter.mjs';
import { filesTabPane } from './panel.mjs';

/** A tree's entry: its absolute path and whether it is a folder (a plain tree's paths are within its folder; a folder's ends in `/`). */
function entryOf(x, root) {
  if (typeof x === 'string') return { abs: `${root}/${x.replace(/\/+$/, '')}`, folder: x.endsWith('/') };
  if (x && typeof x === 'object' && typeof x.path === 'string') return { abs: x.path.replace(/\/+$/, ''), folder: x.directory === true };
  return null;
}
/** The tree's paths the window's filters keep: the files they keep, and a folder unless every file listed under it is left out. */
function keptPaths(ctx, props, filters) {
  const root = props.cwd.replace(/\/+$/, '');
  const entries = props.paths.map((x) => [x, entryOf(x, root)]);
  const keptFiles = new Set(), listed = new Set();
  for (const [, e] of entries) {
    if (!e || e.folder) continue;
    listed.add(e.abs);
    const name = e.abs.slice(e.abs.lastIndexOf('/') + 1);
    if (keepsItem(ctx, filters, { ref: { type: 'File', provider: 'codex', id: e.abs }, state: { path: e.abs, name } })) keptFiles.add(e.abs);
  }
  const under = (folder, set) => { for (const f of set) if (f.startsWith(`${folder}/`)) return true; return false; };
  return entries.filter(([, e]) => !e || (e.folder ? under(e.abs, keptFiles) || !under(e.abs, listed) : keptFiles.has(e.abs))).map(([x]) => x);
}

export const filesView = defineBinding({
  id: 'files.view', presentation: 'FilesView',
  place: { in: null, slot: 'panel' },   // its panel tab presents no instance yet
  presents: ['Folder'],
  slots: { filter: { kind: 'list', field: 'filter', apply: (props) => props } },   // the mods' files filters, read by render
  // it reads its nearest site (addresses.json): the Files tab's pane, or none
  render(Original, props, factory, ctx, scope, near) {
    if (near?.binding !== 'files.pane' || !filesTabPane(near.props) || !Array.isArray(props.paths) || typeof props.cwd !== 'string' || !props.cwd.startsWith('/')) return undefined;
    const filters = declaredFilters(ctx, 'FilesView');
    if (!filters.length) return undefined;
    const paths = keptPaths(ctx, props, filters);
    return paths.length === props.paths.length ? undefined : factory(Original, { ...props, paths });
  },
  subject(props) {
    const cwd = props.cwd;
    if (props.hostId != null && props.hostId !== 'local') return null;
    return typeof cwd === 'string' && cwd.startsWith('/') ? { type: 'Folder', provider: 'codex', id: cwd } : null;
  },
  operations: {
    select(props, [target]) {
      if (typeof props.onSelectionChange !== 'function' || typeof props.cwd !== 'string') return { unavailable: 'this tree cannot select from here' };
      // eslint-disable-next-line codexmods/no-provider-identity -- a file of this Mac
      if (!target || typeof target !== 'object' || target.type !== 'File' || target.provider !== 'codex' || typeof target.id !== 'string') return { unavailable: 'the tree selects a file of this Mac' };
      const root = props.cwd.replace(/\/+$/, '');
      if (!target.id.startsWith(`${root}/`) || target.id.split('/').includes('..')) return { unavailable: 'the file is not in this tree' };
      const rel = target.id.slice(root.length + 1);
      // The tree's own path for it: a plain tree lists paths within it; a sectioned tree lists entries {displayPath ("All files/a.txt"),
      // path (absolute), directory}, and selects by the display path.
      const list = Array.isArray(props.paths) ? props.paths : [];
      const entry = list.find((x) => x && typeof x === 'object' && x.path === target.id && x.directory !== true && typeof x.displayPath === 'string');
      const path = entry ? entry.displayPath : list.includes(rel) || !list.length ? rel : null;
      if (!path) return { unavailable: 'the file is not in this tree' };
      props.onSelectionChange([path]);
      return true;
    },
  },
});
