// Where a link the user opens goes (docs/design/public-hooks.md §3.14, `ui.links.route`, H7lr; the scout H7lr-links): framework-main holds
// the app's `open-in-browser` message (every link the user opens from the app's pages: a chat's messages, the terminal, a pull request's
// link, the link menus) while a route exists, and asks here (`links` area). The mods' routes (add rules on the Window's `links`) are tried
// in the user's order of their mods; the first whose where takes the link decides: open it in the app's own browser or the default
// browser (only when the user did not choose where, and never a link the app routes itself), not at all (whatever the user chose; the window
// the link was opened in says which mod stopped it), or the mod opens it itself with its run (a plain click, a link from a chat it may read;
// one that did not run leaves it to the next route, then to the app; one that may have run keeps it: it is never opened again).
// Node built-ins only.
import { compileWhere } from '../shared/where.mjs';

const isRoute = (r) => !!r && r.kind === 'add' && r.presentation === 'Window' && r.slot === 'links' && !!r.data && typeof r.data.route === 'object' && r.data.route !== null;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.+\.localhost)$/i;
// where the app says a link came from (its `initiator`), as the user sees it
const FROM = { markdown_link_click: 'message', markdown_link_context_menu: 'message', terminal_link_click: 'terminal', pull_request_link: 'pullRequest' };
/** How long a mod's run may take before the link is taken as its own (framework-main waits a little longer, then lets the app open it). */
export const RUN_MS = 3000;

/** A link as a route's where reads it: `{url, scheme, host, path, local, from}`; null when it is not a URL. */
export function linkOf(url, initiator) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.hostname.toLowerCase();
  const local = scheme === 'http' || scheme === 'https' ? LOCAL_HOST.test(host) : scheme === 'file' && (host === '' || host === 'localhost');
  return Object.freeze({ url: u.href, scheme, host, path: u.pathname, local, from: FROM[initiator] ?? 'app' });
}

/**
 * @param {{ rules: { snapshot(): object[], subscribe(fn: (d: object) => void): { dispose(): void },
 *     run(key: string, reg: string, path: string, env: object): Promise<{ ran: boolean, why?: string }> },
 *   mainOps: { op(area: string, op: string, args?: object): Promise<object>, onReport(area: string, fn: (report: object) => void): { dispose(): void } },
 *   windows?: () => ({ runRule?(windowId: number, msg: object): Promise<object>, notify?(requester: object, spec: object): Promise<unknown> } | null),
 *   threadOf?: (conversationId: string) => object | null, chainOf?: (typeId: string) => string[], nameOf?: (modId: string) => string, log?: object,
 *   runMs?: number }} o
 */
export function createLinkRoutes(o) {
  const log = o.log ?? { warn() {}, info() {} };
  const runMs = o.runMs ?? RUN_MS;
  const routes = new Map();   // key -> {rule, test}
  let told = null, disposed = false;
  const nameOf = (id) => { try { return o.nameOf?.(id) || id; } catch { return id; } };
  // framework-main holds the app's links only while a route exists
  const tell = () => {
    const active = routes.size > 0;
    if (active === told || disposed) return;
    told = active;
    Promise.resolve(o.mainOps.op('links', 'routes', { active })).catch((e) => { told = null; log.warn('links: framework-main was not told', { message: String(e?.message ?? e) }); });
  };
  function put(r) {
    const key = `${r.mod}/${r.id}`;
    let test;
    // the one grammar reads an instance's state: the link is one's
    try { const w = compileWhere(r.data.route.where ?? {}); test = (link) => w.test({ ref: { type: 'Link', provider: 'codexmods.links', id: link.url }, state: link }); }
    catch (e) { routes.delete(key); log.warn('links: a route\'s where does not compile', { rule: key, message: String(e?.message ?? e) }); return; }
    routes.set(key, { rule: r, test });
  }
  for (const r of o.rules.snapshot()) if (isRoute(r)) put(r);
  const sub = o.rules.subscribe((d) => {
    if (disposed || !d) return;
    if (d.t === 'remove') routes.delete(d.key);
    else if (d.t === 'put' && d.rule) { if (isRoute(d.rule)) put(d.rule); else routes.delete(`${d.rule.mod}/${d.rule.id}`); }
    tell();
  });
  tell();

  const windowRef = (id) => (Number.isSafeInteger(id) ? Object.freeze({ type: 'Window', provider: 'codexmods.windows', id: String(id) }) : null);
  /**
   * The mod opens the link itself: 'ran', 'not' (it did not run: gone, another registration, not in that window) or 'unknown' (it was
   * started and failed, or its page went before answering: it may have opened it, so the link is never opened again; built review H7lr).
   * Its time is what is left until `until`; still running then is the mod's.
   */
  async function runIt(rule, env, windowId, until) {
    const key = `${rule.mod}/${rule.id}`;
    let running;
    if (rule.realm === 'host') {
      running = o.rules.run(key, rule.reg, 'items.0.run', env).then((out) => (out?.ran === true ? 'ran' : 'not'), () => 'unknown');
    } else {
      // a renderer-realm run is its window's own function: the window the link was opened in
      const w = o.windows?.();
      const reg = Number.isSafeInteger(windowId) ? rule.regs?.[String(windowId)] : undefined;
      if (typeof reg !== 'string' || typeof w?.runRule !== 'function') return 'not';
      running = w.runRule(windowId, { key, reg, path: 'items.0.run', env }).then((out) => (out?.status === 'done' ? 'ran' : out?.status === 'refused' ? 'not' : 'unknown'), () => 'unknown');
    }
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('ran'), Math.max(0, until - Date.now())); timer.unref?.(); });
    try { return await Promise.race([running, late]); } finally { clearTimeout(timer); }
  }
  /** The page the link was opened in says what a route did with it (never another window, nor that window's page after a reload). */
  function say(rule, link, windowId, gen, body) {
    const w = o.windows?.();
    if (typeof w?.notify !== 'function' || !Number.isSafeInteger(windowId)) return;
    Promise.resolve(w.notify({ id: rule.mod, name: nameOf(rule.mod) }, { title: 'Link not opened', body: `${(link.host || link.url).slice(0, 200)} ${body}`, kind: 'info',
      surface: 'toast', dedupe: `codexmods-link-${windowId}` }, { windowId, gen }))
      .catch((e) => log.info('links: the window could not be told', { rule: `${rule.mod}/${rule.id}`, message: String(e?.message ?? e) }));
  }
  /**
   * Whether a route's mod may see a link: one from a chat it may read; one whose chat the app does not say (21477 names none for a
   * message's link, and a composer's or an artifact's could be anyone's) only when it may read every chat (built review H7lr round 2).
   */
  function mayRead(rule, link, thread) {
    if (rule.reads === '*') return true;
    const reads = Array.isArray(rule.reads) ? rule.reads : [];
    if (!thread) return reads.includes('Thread');
    if (thread.provider === rule.mod) return true;
    const chain = o.chainOf?.(thread.type) ?? [thread.type];
    return chain.some((t) => reads.includes(t));
  }
  // a window's own registration of a renderer rule, its where compiled once per where
  const compiled = new Map();
  const testOf = (r) => {
    const k = JSON.stringify(r.data?.route?.where ?? {});
    let t = compiled.get(k);
    if (!t) {
      const w = compileWhere(r.data?.route?.where ?? {});
      t = (link) => w.test({ ref: { type: 'Link', provider: 'codexmods.links', id: link.url }, state: link });
      if (compiled.size > 200) compiled.clear();
      compiled.set(k, t);
    }
    return t;
  };
  // links the app routes itself (its own pages: codex: deep links, chatgpt.com routes): only a route that stops a link takes them
  const appRouted = (link) => link.scheme === 'codex' || link.scheme === 'codex-dev' || (link.scheme === 'https' && (link.host === 'chatgpt.com' || link.host.endsWith('.chatgpt.com')));
  /**
   * What happens to a link the user opens (`chosen`: they said where, with a modifier or a menu's choice): `{open: 'app' | 'browser' |
   * 'none' | 'handled' | null, by?}` (null: as the app would). `claim()`: before a mod's run starts, framework-main confirms it still holds
   * the link (false: it let the app have it, so nothing runs); `expires`: when framework-main stops waiting.
   */
  async function decide({ windowId = null, url, initiator = null, conversationId = null, chosen = false, expires = null }, claim = async () => true) {
    const link = linkOf(url, initiator);
    if (!link || !routes.size) return { open: null };
    if (Number.isFinite(expires) && Date.now() >= expires) return { open: null };
    let thread;
    try { thread = typeof conversationId === 'string' && conversationId ? o.threadOf?.(conversationId) ?? null : null; } catch { thread = null; }
    const own = appRouted(link);
    const gen = Number.isSafeInteger(windowId) ? o.windows?.()?.genOf?.(windowId) ?? null : null;
    // a renderer-realm route holds in the windows that registered it, as that window registered it (its where and its order: built review
    // H7lr rounds 1 and 2)
    const list = [];
    for (const [key, { rule, test }] of routes) {
      if (rule.realm !== 'renderer') { list.push({ rule, test }); continue; }
      const mine = Number.isSafeInteger(windowId) ? o.rules.windowRule?.(key, windowId) : null;
      if (!mine?.data?.route) continue;
      list.push({ rule: mine, test: JSON.stringify(mine.data) === JSON.stringify(rule.data) ? test : testOf(mine) });
    }
    list.sort((a, b) => a.rule.order - b.rule.order || `${a.rule.mod}/${a.rule.id}`.localeCompare(`${b.rule.mod}/${b.rule.id}`));
    let claimed = false, until = null;
    for (const { rule, test } of list) {
      let takes;
      try { takes = test(link); } catch { takes = false; }
      if (!takes) continue;
      const route = rule.data.route;
      const by = Object.freeze({ mod: rule.mod, id: rule.id });
      if (route.open === 'none') { say(rule, link, windowId, gen, 'was stopped by this mod.'); return { open: 'none', by }; }
      if (chosen || own) continue;   // where it opens is the user's when they said so, or the app's own route; a later route may still stop it
      if (route.open === 'app' || route.open === 'browser') return { open: route.open, by };
      if (route.handles !== true || !mayRead(rule, link, thread)) continue;
      // the link is the mod's once its run starts: framework-main must still hold it, and from then on never lets the app open it as well
      if (!claimed) {
        if (!(await claim())) return { open: null };
        claimed = true;
        until = Date.now() + runMs;
      }
      const env = Object.freeze({ link, window: windowRef(windowId), thread: thread && mayRead(rule, link, thread) ? thread : null });
      const ran = await runIt(rule, env, windowId, until);
      if (ran === 'ran') return { open: 'handled', by };
      if (ran === 'unknown') { say(rule, link, windowId, gen, 'may not have opened: this mod did not finish opening it.'); return { open: 'handled', by }; }
      if (Date.now() >= until) return { open: 'handled', by };   // out of time for the next: still the mods'
    }
    return { open: null };
  }
  const reports = o.mainOps.onReport('links', (report) => {
    if (disposed || report?.event !== 'open' || typeof report.requestId !== 'string') return;
    const claim = () => Promise.resolve(o.mainOps.op('links', 'claim', { requestId: report.requestId })).then((r) => r?.ok === true && r.result?.claimed === true, () => false);
    decide(report, claim).catch((e) => { log.warn('links: a link could not be decided', { message: String(e?.message ?? e) }); return { open: null }; })
      .then((answer) => o.mainOps.op('links', 'answer', { requestId: report.requestId, open: answer.open }))
      .catch((e) => log.warn('links: framework-main was not answered', { message: String(e?.message ?? e) }));
  });
  return {
    decide,
    /** framework-main came back: tell it again whether to hold links. */
    resend() { told = null; tell(); },
    dispose() {
      disposed = true;
      sub.dispose();
      reports?.dispose?.();
      if (told) Promise.resolve(o.mainOps.op('links', 'routes', { active: false })).catch(() => {});
    },
  };
}
