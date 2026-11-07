// The mods' destinations in the rail and the sidebar's navigation, and a page's own sidebar (docs/design/layouts.md D7, WL5b, WL5c; scout
// docs/research/layouts/wl5-pages.md §3, §4). The app builds its list in a provider that every consumer reads (the rail, the header links,
// the user's pins and order), so the mods' items join it there, before its split (seam destinations): each is the app's item shape, its id
// `codexmods:<mod>/<id>` stable since the user's state is by id, selected by its own flag while its page is shown. A destination that opens a
// page may name a sidebar view: while that page is shown it is the sidebar's body (seam rail-mode gives it the app's contextual column where
// the rail shows; the rail is never turned on). The app reads the rail's mode only as a location changes, so a view that comes or goes
// while its page is shown (a reload, before the mod has started) replaces the location with itself. NO NODE API.
import { pagePath, pageOfPath } from './main-pages.mjs';

const ROUTE_KEY = 'local:destinations-route';

/**
 * @param {{ ctx: object, windowRef: () => object | null, log?: (m: string, d?: object) => void, changed: () => void, routed?: () => boolean,
 *   may?: (rule: object, ref: object) => boolean }} o
 *   `routed`: is the framework's route in the app's tree? Without it a page's destination is not offered: its path would blank the window.
 *   `may`: may this rule's mod read that ref? A destination opens only what its mod may read
 */
export function createDestinations(o) {
  const { ctx } = o;
  let location = null, navigate = null;   // the provider's, from its latest render
  let viewShown = false;                  // has the rail's mode been told this page has a view?
  let dismissed = null;                   // the view by `where` the user went back to the conversations from (till it no longer holds)
  const icons = new Map();                // a destination's key -> its icon component, one each (a new type would remount it)

  const routed = () => o.routed?.() !== false;
  // whose it is comes from the rule alone, never from what it declares
  const declared = () => (typeof ctx.declared === 'function' ? ctx.declared('Window', 'destinations') : []).map((r) => {
    const d = r.data?.destination;
    if (!d || !d.open || (d.open.page && !routed())) return null;
    return { key: `${r.mod}/${r.id}`, rule: r, mod: r.mod, id: r.id, title: d.title, icon: d.icon, open: d.open, sidebar: d.sidebar, iconNode: r.fns?.destination?.iconNode };
  }).filter(Boolean);

  /** The view a path's page brings, as its destination names it: its rule, or null. */
  function viewRule(pathname) {
    const views = (typeof ctx.declared === 'function' ? ctx.declared('Sidebar', 'views') : []).filter((r) => typeof r.fns?.sidebarView?.render === 'function');
    const at = pageOfPath(pathname);
    if (at) {
      const dest = declared().find((d) => d.mod === at.mod && d.open.page === at.id && typeof d.sidebar === 'string');
      if (dest) return views.find((r) => r.mod === at.mod && r.id === dest.sidebar) ?? null;
    }
    return byWhere(views);
  }
  /** The view whose `where` holds now (declared gives only those; D5), one per window: the first, unless the user went back to the conversations from it. */
  function byWhere(views) {
    const v = views.find((r) => r.where !== undefined) ?? null;
    if (!v) { dismissed = null; return null; }
    return dismissed === `${v.mod}/${v.id}` ? null : v;
  }

  function iconOf(d) {
    const was = icons.get(d.key);
    const want = typeof d.iconNode === 'function' ? d.iconNode : d.icon ?? null;
    if (was && was.want === want) { was.rule = d.rule; return was.type; }
    const R = ctx.react();
    const entry = { want, rule: d.rule, type: null };
    let type;
    // a mod's component in its rule's boundary: a fault in it stays the mod's
    if (typeof want === 'function') type = (props) => ctx.modNode(entry.rule, want, props);
    else if (typeof want === 'string') type = (props) => R.createElement('span', { className: props?.className, 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, want);
    else type = (props) => R.createElement('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'none', className: props?.className, 'aria-hidden': true },
      R.createElement('path', { d: 'M6 2.5h2.2a1.3 1.3 0 1 1 2.6 0H13v2.7a1.3 1.3 0 1 1 0 2.6v2.7h-2.7a1.3 1.3 0 1 0-2.6 0H5v-2.7a1.3 1.3 0 1 0 0-2.6V2.5z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }));
    entry.type = type;
    icons.set(d.key, entry);
    return type;
  }

  function select(d, state) {
    const to = d.open;
    if (to.page) { navigate?.(pagePath(d.mod, to.page), { state }); return; }
    const said = (e) => o.log?.('a destination could not open', { destination: d.key, message: String(e?.message ?? e) });
    if (to.command) { ctx.invoke({ type: 'Command', provider: 'codexmods.commands', id: `${d.mod}/${to.command}` }, 'run', []).catch(said); return; }
    if (o.may && !o.may(d.rule, to)) { said(new Error('its mod may not read that')); return; }
    const win = o.windowRef();
    if (win) ctx.invoke(win, 'open', [to]).catch(said);
  }

  return {
    /** The app's list with the mods' items after its own (the seam's hook: during the provider's render). */
    compose(list, arg) {
      const before = location?.pathname;
      location = arg?.location ?? null;
      navigate = arg?.navigate ?? null;
      const pathname = location?.pathname;
      // what reads the shown page's view follows it (not during this render)
      if (pathname !== before) queueMicrotask(() => ctx.local?.touch?.(ROUTE_KEY));
      const mine = declared();
      if (!mine.length) return list;
      return [...list, ...mine.map((d) => {
        const icon = iconOf(d);
        return { id: `codexmods:${d.key}`, label: d.title, icon, largeIcon: icon, visibleByDefault: true, hasUnreadActivity: false,
          isCurrentDestination: !!d.open.page && pathname === pagePath(d.mod, d.open.page), onSelect: (state) => select(d, state) };
      })];
    },
    /** Should this location have the app's contextual sidebar (the seam rail-mode's hook)? */
    railMode(at) {
      const has = pageOfPath(at?.pathname) !== null && viewRule(at?.pathname) !== null;
      if (at?.pathname === location?.pathname || !location) viewShown = has;
      return has;
    },
    /** The view of the page shown now, in its rule's boundary, or null. */
    viewNode() {
      ctx.local?.read?.(ROUTE_KEY);
      const rule = viewRule(location?.pathname);
      if (!rule) return null;
      const at = pageOfPath(location.pathname);
      const R = ctx.react();
      const v = rule.fns.sidebarView;
      const key = `${rule.mod}/${rule.id}`;
      return R.createElement('div', { 'data-codexmods-sidebar-view': key, className: 'flex min-h-0 flex-1 flex-col overflow-auto' },
        // shown by its where: the user's way back to the app's
        rule.where !== undefined && !at ? R.createElement('button', { type: 'button', key: 'back', 'data-codexmods-sidebar-back': key, className: 'self-start px-3 py-1 text-sm text-token-text-secondary underline', onClick: () => { dismissed = key; ctx.local?.touch?.(ROUTE_KEY); } }, 'Show conversations') : null,
        ctx.modNode(rule, v.render, { key, view: { id: rule.id, title: v.title }, page: at ? { mod: at.mod, id: at.id } : null }));
    },
    /** The mods' destinations or views changed: the provider composes again; a view that came or went for the page shown reaches the rail's mode. */
    rulesChanged() {
      o.changed();
      ctx.local?.touch?.(ROUTE_KEY);
      const has = location && pageOfPath(location.pathname) ? viewRule(location.pathname) !== null : false;
      if (has !== viewShown && pageOfPath(location?.pathname) && navigate) {
        viewShown = has;
        navigate(`${location.pathname}${location.search ?? ''}`, { replace: true, state: location.state });
      }
    },
  };
}
