// A mod's own page in the window's main region (docs/design/layouts.md D7, WL5a; scout docs/research/layouts/wl5-pages.md): one route of the
// framework's, `/codexmods/page/:mod/:page`, is in the app's route tree from module load (seam page-route), so the app's history, its first
// navigation and a reload always find it. The host draws what the path names inside the app's shell: the app's own page header (its title and
// the mod's actions, inline at the page's top, as the app's automations and canvas pages draw theirs: in the title bar's row it would sit under a
// page banner) and the mod's component in its rule's boundary. A page that is not there (its mod off, not
// running, removed, or the page no longer declared) stays routable and says so with the mod's name, never a blank window. While a page is
// shown the window's address holds its path, the app's own way to come back to a route on reload (`initialRoute`); leaving takes it out, so
// a later reload goes where the app would. NO NODE API.
import { createReport } from './reports.mjs';
import { modRef, pathOf } from './settings-pages.mjs';

export const pagePath = (mod, id) => `/codexmods/page/${mod}/${id}`;
/**
 * A subtype's registered view of one instance (graph-integrity G2.2): its mod's ThreadView replacement (`ui.replace('ThreadView', {for:
 * <its subtype>, render})`), drawn in the main region on this route, under its provider (a mod's instances are its own). One route of the
 * framework's carries it, so the app's history, back and forward and a reload find it as they find a page.
 */
export const VIEW = 'view~';
export const MAX_VIEW_ID = 1400;   // the longest view page id framework-main navigates to (main/views: VIEW_PATH)
// its ref as JSON in base64url (UTF-8): a page id of letters, digits, "-" and "_" only, as framework-main lets the framework navigate to
const b64url = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
/** The path of an instance's registered view: under its provider (a mod's instances are its own), the ref in base64url. */
export const viewPath = (ref) => pagePath(ref.provider, `${VIEW}${b64url(JSON.stringify([ref.provider, ref.type, ref.id]))}`);
/** The instance a view's page id names, or null. */
export function refOfView(id) {
  if (typeof id !== 'string' || !id.startsWith(VIEW) || id.length > MAX_VIEW_ID || !/^[A-Za-z0-9_-]+$/.test(id.slice(VIEW.length))) return null;
  try {
    const [provider, type, rid] = JSON.parse(unb64url(id.slice(VIEW.length)));
    return [provider, type, rid].every((x) => typeof x === 'string' && x) ? { type, provider, id: rid } : null;
  } catch { return null; }
}
/** The mod and page a path names, or null. */
export function pageOfPath(pathname) {
  const m = /^\/codexmods\/page\/([^/]+)\/([^/]+)\/?$/.exec(typeof pathname === 'string' ? pathname : '');
  return m ? { mod: m[1], id: m[2] } : null;
}

const STATE_KEY = 'local:main-pages';
const WAIT_MS = 5000;   // how long a running mod may take to declare its page before it is said to have none (a window's mods start after its page)

/** The address's `initialRoute`, which the app reads on the next load: this path in it; or, with `leaving`, this path taken out (the app may have
 *  written its own as it navigated: that stays). */
function keepRoute(path, leaving = false) {
  const loc = globalThis.location, hist = globalThis.history;
  if (!loc?.href || typeof hist?.replaceState !== 'function') return;
  const u = new URL(loc.href);
  if (leaving) { if (u.searchParams.get('initialRoute') !== path) return; u.searchParams.delete('initialRoute'); } else u.searchParams.set('initialRoute', path);
  hist.replaceState(hist.state, '', u.toString());
}

/**
 * @param {{ ctx: object, exports: () => object, observe: (ref: object) => { dispose(): void }, useRoute: () => object | null,
 *   navigate: (path: string) => unknown, routed?: () => boolean }} o
 *   `routed`: is the framework's route in the app's tree (seam page-route)? Without it nothing navigates to a page: it would blank the window
 */
export function createMainPages(o) {
  const { ctx } = o;
  let pages = new Map();   // `${mod}/${id}` -> { key, mod, id, title, heading, render, actions, rule }
  let failed = new Set();  // the keys of those that faulted: off until a reload, as every rule
  let off = new Set();     // the keys of those the user switched off in the framework's settings
  let shown = null;        // the page's key this window's route shows now
  const routed = () => o.routed?.() !== false;

  /** The window's pages, from the mods' rules here (their components are in this window), and the keys of those that faulted. */
  function setPages(list, faults = [], switchedOff = []) {
    pages = new Map(list.map((p) => [p.key, p]));
    failed = new Set(faults);
    off = new Set(switchedOff);
    ctx.local?.touch?.(STATE_KEY);
  }

  /** While a page is shown a reload comes back to it; going elsewhere takes it out, a reload itself never does. The window says which it shows. */
  // at the commit, not after it: the app writes the next page's route before it navigates, and a passive effect flushed then would write this one over it
  function useShown(R, key, path) {
    (R.useLayoutEffect ?? R.useEffect)(() => {
      if (!path) return undefined;
      keepRoute(path);
      shown = key;
      ctx.windowChanged?.();
      let going = false;
      const away = () => { going = true; };
      globalThis.addEventListener?.('pagehide', away);
      return () => {
        globalThis.removeEventListener?.('pagehide', away);
        if (!going) keepRoute(path, true);
        if (shown === key) { shown = null; ctx.windowChanged?.(); }
      };
    }, [path]);
  }

  /** What a page that is not there says: its mod by name, and the way to it. */
  function NotHere({ R, mod, says, gone }) {
    const e = R.createElement;
    return e('div', { 'data-codexmods-page-off': mod, className: 'flex flex-col gap-2 p-panel text-sm' },
      e('div', { className: 'text-token-foreground' }, says),
      gone ? null : e('button', { type: 'button', className: 'self-start underline text-token-text-secondary', onClick: () => o.navigate(pathOf(mod)) }, 'Open its settings'));
  }

  /** A registered view of an instance (G2.2): the window's chrome with its title, and its mod's component; said when there is none now. */
  function ViewRoute({ R, at, subject }) {
    const e = R.createElement;
    R.useEffect(() => { const v = o.observe(subject); return () => v.dispose(); }, [at.id]);
    useShown(R, `${at.mod}/${at.id}`, pagePath(at.mod, at.id));
    const inst = ctx.use(() => ctx.subject(subject) ?? null);
    // shown, it is read (the concept's read state, graph-integrity G2.2): the user's own act, each time it is unread while shown
    const unread = !!inst && !inst.gone && inst.state?.unread === true;
    R.useEffect(() => { if (unread) void ctx.userAct?.(subject, 'markRead'); }, [at.id, unread]);
    const ruled = inst && !inst.gone && typeof ctx.ruled === 'function' ? ctx.ruled('ThreadView', inst) : null;
    const Report = (reportOf ??= createReport(R, ctx));
    const report = e(Report, { type: 'ThreadView', subject, place: { in: 'Window', slot: 'main' } });
    if (!ruled?.replace) {
      const says = inst?.gone ? 'This chat is not there any more.' : inst ? 'Nothing shows this chat now: the mod that provides it registers its view, and it is off or has none.' : null;
      return e(R.Fragment, null, says ? e('div', { 'data-codexmods-view-off': subject.provider, className: 'flex flex-col gap-2 p-panel text-sm' }, says) : null, report);
    }
    const shell = o.exports()?.appShell;
    const Toolbar = shell?.HeaderToolbar;
    const title = String(inst.summary?.title ?? inst.state?.title ?? '');
    return e(R.Fragment, null,
      shell?.Header && Toolbar ? e(shell.Header, { inline: true, className: 'flex shrink-0 px-panel' }, e(Toolbar, null, title)) : null,
      e('div', { 'data-codexmods-view': `${subject.provider}/${subject.id}`, className: 'flex min-h-0 flex-1 flex-col' }, ruled.replace),
      report);
  }

  function PageRoute() {
    const R = ctx.react();
    const route = o.useRoute();
    const at = pageOfPath(route?.pathname);
    const viewed = at ? refOfView(at.id) : null;
    if (viewed) return R.createElement(ViewRoute, { key: at.id, R, at, subject: viewed });
    const key = at ? `${at.mod}/${at.id}` : null;
    const ref = at ? modRef(at.mod) : null;
    useShown(R, key, at ? pagePath(at.mod, at.id) : null);
    R.useEffect(() => { if (!ref) return undefined; const v = o.observe(ref); return () => v.dispose(); }, [at?.mod]);
    const [waited, setWaited] = R.useState(false);
    R.useEffect(() => { setWaited(false); const t = setTimeout(() => setWaited(true), WAIT_MS); return () => clearTimeout(t); }, [key]);
    const { page, says, gone } = ctx.use(() => {
      ctx.local?.read?.(STATE_KEY);
      const p = key ? pages.get(key) ?? null : null;
      if (p || !ref) return { page: p, says: null, gone: false };
      const m = ctx.subject(ref);
      const settled = typeof ctx.settled === 'function' ? ctx.settled(ref) : true;
      if (!m || m.gone) return { page: null, says: settled ? `The mod ${at.mod} is not installed, so this page is not available.` : null, gone: true };
      const name = (typeof m.state?.name === 'string' && m.state.name) || at.mod;
      if (off.has(key)) return { page: null, says: `This page of ${name} is switched off. You can turn it on in the Mods settings, under Layouts.`, gone: true };
      if (failed.has(key)) return { page: null, says: `This page of ${name} failed. It stays off until the mod restarts or this window reloads.`, gone: false };
      if (m.state?.status !== 'enabled') return { page: null, says: `${name} is off. Its page comes back when you turn it on.`, gone: false };
      if (m.state?.running === false) return { page: null, says: `${name} is not running now, so its page is not available.`, gone: false };
      return { page: null, says: waited ? `${name} has no page “${at.id}” now.` : null, gone: false };
    });
    if (!at) return null;
    const e = R.createElement;
    const Report = (reportOf ??= createReport(R, ctx));
    const report = e(Report, { type: 'Page', subject: ref, place: { in: 'Window', slot: 'main' } });
    if (!page) return e(R.Fragment, null, says ? e(NotHere, { R, mod: at.mod, says, gone }) : null, report);
    const shell = o.exports()?.appShell;
    const Toolbar = shell?.HeaderToolbar;
    const actions = typeof page.actions === 'function' ? ctx.modNode(page.rule, page.actions, { page: { id: page.id, title: page.title } }) : null;
    return e(R.Fragment, null,
      shell?.Header && Toolbar ? e(shell.Header, { inline: true, className: 'flex shrink-0 px-panel' }, e(Toolbar, null, page.heading ?? page.title, actions && Toolbar.Actions ? e(Toolbar.Actions, null, actions) : null)) : null,
      e('div', { 'data-codexmods-page': key, className: 'flex min-h-0 flex-1 flex-col overflow-auto' }, ctx.modNode(page.rule, page.render, { key, page: { id: page.id, title: page.title } })),
      report);
  }
  let reportOf = null;

  return {
    PageRoute, setPages,
    /** Open an instance's registered view in this window (G2.2); false without the framework's route. */
    openView(ref) { if (!routed()) return false; o.navigate(viewPath(ref)); return true; },
    has: (mod, id) => routed() && pages.has(`${mod}/${id}`),
    list: () => (routed() ? [...pages.values()] : []),
    /** The key of the page this window shows now, or null: its facts say it, so opening one is done once it shows. */
    shown: () => shown,
    /** Open a page in this window: false when it is not declared here, or there is no route for it. */
    open(mod, id) { if (!routed() || !pages.has(`${mod}/${id}`)) return false; o.navigate(pagePath(mod, id)); return true; },
  };
}
