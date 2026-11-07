// A chat of the app's in a mod's place (docs/design/layouts.md D8, WL7; scout docs/research/layouts/wl7-hosted.md): `ui.host.thread(ref, {composer?})`, inside a mod's page,
// panel tab, region or modal. Each is one pane: the app's own scopes for that chat under a RouteScope of its own (a route record of the framework's with a pathname no route has,
// so the pane's find, shell registries and composer atoms are its own), around the app's own host of a second chat, which provides its composer's scope, resumes the chat and
// draws its transcript, composer and requests. That host resumes only a chat already in the app's store, so a chat not opened this run comes in first, the way the app's own opener of
// that host brings it. A chat the app cannot show there (gone, archived, not a local one) says so; a fault in the app's view stays in this boundary. NO NODE API.

// the app's panel kinds that draw by the chat's scopes alone (native census on 22943 and 21477): the others keep their record in the panel's controller, or need props made as they open
export const HOSTABLE = new Set(['review', 'subagents']);
const WAIT_MS = 15000;   // how long the app's lazy chunk may take before the pane says it could not be shown
// a token names one pane of this page, in this window: a page's own prefix, so one kept across a reload or from another window names nothing here
export const pageToken = Math.random().toString(36).slice(2, 10);
let seq = 0;
const nextToken = () => `pane-${pageToken}-${++seq}`;
/** One request's own, as the app keys its panel: a new one draws anew, none of a form's state carried over. */
export const requestKey = (conv, r) => `${conv}:${r.type ?? ''}:${r.item?.requestId ?? r.item?.approvalRequestId ?? r.item?.callId ?? r.requestId ?? r.turnId ?? r.id ?? r.item?.id ?? ''}`;

/**
 * @param {{ ctx: object, exports: () => object, observe: (ref: object) => { dispose(): void }, log?: (m: string, d?: object) => void, paneContext?: () => object | null, changed?: () => void, openChat?: (ref: object) => void, waitMs?: number }} o
 *   `paneContext`: the kernel's, which each mount inside a pane reads; `changed`: which panes there are, or the one the user is in, moved; `openChat`: the user's way to a chat from a pane; `waitMs`: a test's WAIT_MS
 */
export function createHostedThreads(o) {
  const { ctx } = o;
  let Boundary = null;
  const boundaryOf = (R) => {
    if (Boundary || typeof R.Component !== 'function') return Boundary;
    Boundary = class CodexmodsPaneBoundary extends R.Component {
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error) { if (!this.props.quiet) o.log?.('a hosted chat: a fault', { message: String(error?.message ?? error) }); }
      render() { return this.state?.error ? this.props.fallback : this.props.children; }
    };
    return Boundary;
  };
  const panes = new Map();   // a pane's token -> the chat it shows
  let active = null;         // the pane the user was last in: null, the window's own page
  const inPane = (e) => { const el = e?.target?.closest?.('[data-codexmods-pane]'); const t = el?.getAttribute?.('data-codexmods-pane') ?? null; if (t !== active) { active = t; o.changed?.(); } };
  const doc = globalThis.document;
  doc?.addEventListener?.('pointerdown', inPane, true);
  doc?.addEventListener?.('focusin', inPane, true);
  const notice = (R, text) => R.createElement('div', { 'data-codexmods-pane-off': '', className: 'p-panel text-sm text-token-text-secondary' }, text);

  /** The chat's id on this machine, or null when it is not one of the app's local chats. */
  // eslint-disable-next-line codexmods/no-provider-identity -- hosts the app's own chats
  const localId = (ref) => (ref && typeof ref === 'object' && ref.provider === 'codex' && typeof ref.id === 'string' && ref.id ? ref.id : null);

  /** The app's scope this place is in, or null outside its tree. */
  const scopeHere = (x) => { try { return typeof x.useScope === 'function' && x.AppScope ? x.useScope(x.AppScope) ?? null : null; } catch { ctx.react()?.useRef?.(null); return null; } };   // its read throws before its one hook slot: taken here

  /**
   * What a chat asks of the user, in a pane without its composer: the app's own panel, which its composer would have drawn. Answered by the chat and the request's id, so a card
   * in another pane of the chat goes with it. A plan to implement sends a message of the composer's: the pane says so, with the way to the chat.
   */
  function PaneRequest({ thread, conv, scope }) {
    const R = ctx.react();
    const e = R.createElement;
    const x = o.exports() ?? {};
    const [request, setRequest] = R.useState(null);
    R.useEffect(() => {
      if (!x.pendingRequest || typeof scope?.watch !== 'function') return undefined;
      let off = false;
      // the watch runs inside the app's write: the pane follows after it
      const stop = scope.watch(({ get }) => { const v = get(x.pendingRequest, conv) ?? null; queueMicrotask(() => { if (!off) setRequest(v); }); });
      return () => { off = true; stop?.(); };
    }, [conv]);
    if (!request || !x.PendingRequestPanel) return null;
    if (request.type === 'implementPlan') return e('div', { 'data-codexmods-pane-plan': '', className: 'flex items-center gap-2 p-panel text-sm text-token-text-secondary' }, 'This chat has a plan to implement.', o.openChat ? e('button', { type: 'button', className: 'underline', onClick: () => o.openChat(thread) }, 'Open the chat') : null);
    return e('div', { 'data-codexmods-pane-request': '', className: 'relative flex flex-col gap-2 p-panel' },
      e(x.PendingRequestPanel, { key: requestKey(conv, request), conversationId: conv, cwd: null, hostId: 'local', pendingRequest: request, onSubmitLocalFollowup: () => {} }));
  }

  function HostedThread({ thread, composer = true }) {
    const R = ctx.react();
    const e = R.createElement;
    const conv = localId(thread);
    const token = R.useRef(null);
    if (token.current === null) token.current = nextToken();
    // one route record per pane and chat: the app's compiler memoizes on it, and a new object would make its scopes fight
    const route = R.useMemo(() => (conv ? { routeKind: 'local-thread', conversationId: conv, hostId: 'local', projectContext: null, pathname: `/codexmods/pane/${token.current}`, routeTemplate: '/codexmods/pane/:pane', search: '' } : null), [conv]);
    R.useEffect(() => { if (!thread || !conv) return undefined; const v = o.observe(thread); return () => v.dispose(); }, [conv]);
    R.useEffect(() => {
      if (!conv) return undefined;
      const t = token.current;
      panes.set(t, thread);
      o.changed?.();
      return () => { panes.delete(t); if (active === t) active = null; o.changed?.(); };
    }, [conv]);
    const x = o.exports() ?? {};
    const [late, setLate] = R.useState(false);
    const Tab = x.conversationTab;
    // the app's lazy host: brought in once a chat is hosted (it swallows a failed load, so readiness is what its chunk then defines)
    R.useEffect(() => {
      Tab?.prefetch?.();
      const t = setTimeout(() => setLate(true), o.waitMs ?? WAIT_MS);
      return () => clearTimeout(t);
    }, []);
    // into the app's store first, with its first page: its host would otherwise wait for ever on a chat not opened this run
    const scope = scopeHere(x);
    const [loaded, setLoaded] = R.useState(null);   // the chat brought in, or `failed:<chat>`
    R.useEffect(() => {
      if (!conv || !scope || typeof x.hostClient !== 'function') return undefined;
      let off = false;
      const failed = (e) => { if (off) return; if (e) o.log?.('a hosted chat: not loaded', { message: String(e?.message ?? e) }); setLoaded(`failed:${conv}`); };
      (async () => {
        const client = x.hostClient(scope, 'local');
        await client.activateThreadSummary(conv, { addToRecent: false });
        if (await client.ensureConversationFirstPage(conv)) { if (!off) setLoaded(conv); } else failed();
      })().catch(failed);
      return () => { off = true; };
    }, [conv, !!scope]);
    const state = ctx.use(() => (thread ? ctx.subject(thread) : null));
    if (!conv) return notice(R, 'Only a chat on this computer can be shown here.');
    if (state?.gone) return notice(R, 'This chat is no longer here.');
    if (state?.state?.archived === true) return notice(R, 'This chat is archived.');
    if (!x.routeScopes || !Tab || !x.hostClient || !scope) return notice(R, 'This build cannot show a chat here.');
    if (loaded === `failed:${conv}`) return notice(R, 'This chat could not be loaded.');
    if (loaded !== conv) return late ? notice(R, 'This chat could not be loaded.') : null;
    if (composer === false && (!x.threadView || !x.ScopeProvider || !x.ComposerScope || !x.composerScopeValue)) return late ? notice(R, 'This chat could not be loaded.') : null;
    const B = boundaryOf(R);
    const body = composer === false
      ? e(x.ScopeProvider, { scope: x.ComposerScope, value: x.composerScopeValue(conv, 'main', conv) },
        e(x.threadView, { shouldResume: true, allowMissingConversation: true, showUtilityBar: false, showSummaryPanel: false, restoreScrollPosition: false, hideWhenCoveredByRightPanel: false, showComposer: false, footerContent: e(PaneRequest, { thread, conv, scope }) }))
      : e(Tab, { conversationId: conv, hostId: 'local' });
    const Pane = o.paneContext?.() ?? null;
    const scoped = e(x.routeScopes, { route }, body);
    const pane = e('div', { 'data-codexmods-pane': token.current, 'data-codexmods-pane-chat': conv, className: 'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden' }, Pane ? e(Pane.Provider, { value: token.current }, scoped) : scoped);
    return B ? e(B, { fallback: notice(R, 'This chat could not be shown here.') }, pane) : pane;
  }

  /**
   * One of the app's panel kinds for a chat, in a mod's place (ui.host.tab): the kind's component under the chat's scopes, with what its panel would give it, a pane like a chat's
   * (a transcript it opens is its own, not the route's). A kind that keeps its record in the panel's controller (a file's viewer, a terminal's session) does not stand alone, so only
   * the kinds checked natively are drawn; the others say so.
   */
  function HostedTab({ kind, thread }) {
    const R = ctx.react();
    const e = R.createElement;
    const x = o.exports() ?? {};
    const conv = localId(thread);
    const token = R.useRef(null);
    if (token.current === null) token.current = nextToken();
    // a kind's own state of where it is, which its panel keeps in the tab's props: the subagent opened from its list, and the way back
    const [agent, setAgent] = R.useState(null);
    const [agentIn, setAgentIn] = R.useState(null);
    // what the pane shows: the agent, once it is in the store, under its own scopes; the chat stays the kind's parent
    const shown = agent && agentIn === agent.id ? agent.id : conv;
    const route = R.useMemo(() => (shown ? { routeKind: 'local-thread', conversationId: shown, hostId: 'local', projectContext: null, pathname: `/codexmods/pane/${token.current}`, routeTemplate: '/codexmods/pane/:pane', search: '' } : null), [shown]);
    R.useEffect(() => {
      if (!conv || !HOSTABLE.has(kind)) return undefined;
      const t = token.current;
      panes.set(t, shown === conv ? thread : { type: 'CodexThread', provider: 'codex', id: shown });
      o.changed?.();
      return () => { panes.delete(t); if (active === t) active = null; o.changed?.(); };
    }, [conv, kind, shown]);
    const type = HOSTABLE.has(kind) ? x.tabRegistry?.registry?.get?.(kind) : null;
    const [tabState, setTabState] = R.useState(() => { try { return type?.defaultState?.() ?? null; } catch { return null; } });
    const scope = scopeHere(x);
    // into the app's store, as a pane's chat comes: what a kind lists is read from there. The agent a kind's list opens comes in the same way before its transcript draws
    const bringIn = (id) => { const client = x.hostClient(scope, 'local'); return Promise.resolve(client.activateThreadSummary(id, { addToRecent: false })).then(() => client.ensureConversationFirstPage(id)); };
    R.useEffect(() => {
      if (!conv || !scope || typeof x.hostClient !== 'function' || !HOSTABLE.has(kind)) return;
      bringIn(conv).catch((err) => o.log?.('a hosted chat: not loaded', { message: String(err?.message ?? err) }));
    }, [conv, !!scope]);
    R.useEffect(() => {
      if (!agent || !scope || typeof x.hostClient !== 'function') return undefined;
      let off = false;
      const done = (err) => { if (off) return; if (err) o.log?.('a hosted chat: not loaded', { message: String(err?.message ?? err) }); setAgentIn(agent.id); };
      bringIn(agent.id).then(() => done(), done);
      return () => { off = true; };
    }, [agent?.id, !!scope]);
    if (!HOSTABLE.has(kind)) return notice(R, `This view (${kind}) is not shown outside a panel.`);
    if (!conv) return notice(R, 'Only a chat on this computer can be shown here.');
    if (!x.routeScopes || !scope || typeof type?.Component !== 'function') return notice(R, 'This build cannot show that view here.');
    const B = boundaryOf(R);
    const propsOf = () => (kind === 'subagents' ? { parentConversationId: conv, hostId: 'local', requestedConversationId: agent?.id ?? null, requestedDisplayName: agent?.name ?? null, isLoading: !!agent && agentIn !== agent.id, onSelect: (id, name) => setAgent(id == null ? null : { id, name: name ?? null }) } : {});
    // the rows its panel would draw above it: a kind's heading and its way back live there; one that needs what only its panel gives is dropped alone, the view stays
    const renderSlots = ({ headerRows, content }) => e(R.Fragment, null, ...(headerRows ?? []).map((row) => { const box = e('div', { className: 'shrink-0' }, row.content); const key = `${row.id}:${agent?.id ?? ''}`; return B ? e(B, { key, fallback: null, quiet: true }, box) : e(R.Fragment, { key }, box); }), content);
    const Pane = o.paneContext?.() ?? null;
    const scoped = e(x.routeScopes, { route }, e(type.Component, { ...propsOf(), tabId: `codexmods:${token.current}`, isActive: true, isVisible: true, onClose: () => {}, renderSlots, tabState, setTabState }));
    const body = e('div', { 'data-codexmods-pane': token.current, 'data-codexmods-hosted-tab': kind, className: 'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden' }, Pane ? e(Pane.Provider, { value: token.current }, scoped) : scoped);
    return B ? e(B, { fallback: notice(R, 'This view could not be shown here.') }, body) : body;
  }

  /** A pane's element on the page, or null. */
  const paneEl = (token) => [...(doc?.querySelectorAll?.('[data-codexmods-pane]') ?? [])].find((el) => el.getAttribute('data-codexmods-pane') === token) ?? null;
  /** The panes' tokens in their order on the page (the document's), those not drawn after. */
  const ordered = () => {
    const drawn = [...(doc?.querySelectorAll?.('[data-codexmods-pane]') ?? [])].map((el) => el.getAttribute('data-codexmods-pane')).filter((t) => panes.has(t));
    return [...new Set([...drawn, ...panes.keys()])];
  };
  /** Where the keyboard goes in a place: its composer's editor, else the place itself (made focusable). */
  const focusIn = (el) => {
    const editor = el.querySelector?.('[contenteditable="true"], textarea');
    if (editor && typeof editor.focus === 'function') { editor.focus(); return true; }
    if (typeof el.focus !== 'function') return false;
    if (!el.hasAttribute?.('tabindex')) el.setAttribute?.('tabindex', '-1');
    el.focus();
    return true;
  };
  /** The window's own page: its composer outside every pane, else its main column (the app's own `main`). */
  const focusMain = () => {
    const editors = [...(doc?.querySelectorAll?.('[contenteditable="true"], textarea') ?? [])].filter((x) => !x.closest?.('[data-codexmods-pane]') && !x.closest?.('[data-codexmods-region]') && x.getClientRects?.().length);
    const main = doc?.querySelector?.('main');
    const editor = editors.find((x) => !main || main.contains(x)) ?? null;
    if (editor) { editor.focus(); return true; }
    return main ? focusIn(main) : false;
  };

  return {
    /** What the window says of its panes: each one's token and chat in their order on the page, and the one the user is in; null with none. */
    facts: () => (panes.size ? { list: ordered().map((token) => { const thread = panes.get(token); return { token, thread: { type: thread.type, provider: thread.provider, id: thread.id } }; }), active } : null),
    /**
     * The keyboard into a pane (Window.focusPane, graph-integrity G5.1): its composer's editor, else the pane; null, the window's own page.
     * True once it is there (the user is then in that pane), else `{unavailable}`.
     */
    focusPane(token) {
      if (token === null) {
        if (!focusMain()) return { unavailable: 'the window\'s own page has nothing to take the keyboard' };
        if (active !== null) { active = null; o.changed?.(); }
        return true;
      }
      const el = typeof token === 'string' && panes.has(token) ? paneEl(token) : null;
      if (!el) return { unavailable: 'that pane is not shown' };
      if (!focusIn(el)) return { unavailable: 'that pane cannot take the keyboard' };
      if (active !== token) { active = token; o.changed?.(); }
      return true;
    },
    dispose() { doc?.removeEventListener?.('pointerdown', inPane, true); doc?.removeEventListener?.('focusin', inPane, true); panes.clear(); },
    /** What this build can host (ui.host.supported): a chat with its composer, a chat alone, and which panel kinds. */
    supported() {
      const x = o.exports() ?? {};
      const thread = !!(x.routeScopes && x.conversationTab && x.hostClient);
      return { thread, transcript: thread && !!(x.threadView && x.ScopeProvider && x.ComposerScope && x.composerScopeValue), tabs: x.routeScopes ? [...HOSTABLE].filter((k) => typeof x.tabRegistry?.registry?.get?.(k)?.Component === 'function') : [] };
    },
    /** The element for one of the app's panel kinds for a chat in this place (ui.host.tab). */
    tab(kind, ref) {
      const R = ctx.react();
      return R ? R.createElement(HostedTab, { kind: String(kind), thread: ref, key: `${kind}:${ref?.provider}:${ref?.id}` }) : null;
    },
    /** The element for a chat in this place (ui.host.thread). */
    thread(ref, opts = {}) {
      const R = ctx.react();
      return R ? R.createElement(HostedThread, { thread: ref, composer: opts?.composer !== false, key: opts?.key ?? `${ref?.provider}:${ref?.id}` }) : null;
    },
  };
}
