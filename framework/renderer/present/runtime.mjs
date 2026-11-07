// The page side of presentations (docs/design/presentations.md V4, V5, V8). The kernel (framework/preload/preload.cjs) arms the bindings
// before the app's first render and wraps the component types they match; this module, which arrives later with the runtime, gives
// each armed binding its renderer in the kernel's decision store and bumps it, so the wrappers re-render with the framework's
// decisions. Bindings read their subjects from a per-window replica of the graph (framework/shared/graph-replica.mjs) fed through the
// framework's own context on the renderer channel. Every subject a binding reads is recorded with the kernel's store (`read`), and a change
// to one touches it, so only the wrappers that read it re-render (boundary review 4b). A binding that throws, or whose canary failed,
// falls back to the app's own rendering (the kernel catches it) and is off until the page reloads. NO NODE API: bundled into the page.
import { createReplica } from '../../shared/graph-replica.mjs';
import { createThreadSubjects } from './subjects.mjs';
import { createKit } from './kit/index.mjs';
import { createModMedia } from './mod-media.mjs';
import { createSettingControls } from './setting-controls.mjs';
import { threadMenus, withGroups, withParts, withOpenIn } from './menus.mjs';
import { choicesPlan } from './choices.mjs';
import { startSettingsPages, setSettingsPagesStarter, settingsPages, FRAMEWORK_REF, OVERVIEW_PATH, UPDATE_PATH, DEVELOPER_PATH, DETAIL_PATH, ownPageOf, pathOf, pagePathOf } from './settings-pages.mjs';
import { createBand, RECOVERY_PATH } from './band.mjs';
import { FRAMEWORK_BINDINGS } from './reports.mjs';
import { createAsks, ASK_BINDING } from './asks.mjs';
import { createDialogs, frameworkDialogsOpen, onFrameworkDialogs } from './dialogs.mjs';
import { pageParts } from './page-parts.mjs';
import { createRules, valueOf, budgeted, boundaryOf, hasRelative, seenBy } from './rules.mjs';
import { createInstances } from './instances.mjs';
import { createStyles } from './styles.mjs';
import { tabKeyOf } from './mod-panels.mjs';
import { layoutWorkspace } from './bindings/workspace-layout.mjs';
import { setRegion, moveSidebar, shownColumn } from './bindings/frame-regions.mjs';
import { createMainPages } from './main-pages.mjs';
import { createDestinations } from './destinations.mjs';
import { createLayouts, LAYOUT_CONTEXT } from './layouts.mjs';
import { createHostedThreads } from './hosted-thread.mjs';
import { createDrops } from './drops.mjs';
import { setAttestor, newToken, attestNow } from './attest.mjs';
import { createLayoutSwitches } from './layout-switches.mjs';
import { createLayoutsSection, createLayoutPicker } from './layouts-section.mjs';
import { createAllocator } from './allocator.mjs';
import { orderGroups } from './bindings/sidebar-groups.mjs';
import { createTabKinds } from './tab-kinds.mjs';
import { setDeclaredFilter, declaredFilters, keepsRecord, FILTER_LISTS, forgetFilter, pruneFilters } from './bindings/list-filter.mjs';
import { hiddenCommandCounts, showHiddenCommands, onHiddenCommands, forgetRow } from './bindings/palette-hides.mjs';
import { sidebarHides, hiddenBy, openChats, showHidden } from './bindings/sidebar-hides.mjs';
import { actionNode, summaryOf } from './bindings/slots.mjs';
import { createPaletteSources } from './palette-sources.mjs';
import { createSlashItems } from './slash-items.mjs';
import { createMentionSources } from './mention-sources.mjs';
import { createComposerSuggestions } from './composer-suggestions.mjs';
import { createContent } from './content.mjs';
import { createUserActions } from './user-action.mjs';
import { compileWhere } from '../../shared/where.mjs';

// a declaration's where, compiled once per where object
const compiledWheres = new WeakMap();
const compiledWhere = (w) => { let c = compiledWheres.get(w); if (!c) { c = compileWhere(w, { window: true }); compiledWheres.set(w, c); } return c; };

// The app's commands that copy what is not a chat's content (a link, a folder, a path): what they copy as the page's dispatcher runs them is
// copied as it is (the copy seam, F3; the thread actions they run say so themselves: seam copy-origin)
const COPY_NOT_CONTENT = new Set(['copyDeeplink', 'copyWorkingDirectory', 'copyConversationPath', 'copyPageLink']);
const MAX_SUBJECTS = 500;
const SWITCHES_KEY = 'local:layouts-switches';
/** The key of the framework's own window acts (no mod's declaration: not a `<mod>/<id>`), as the windows provider sends them. */
export const WINDOW_ACT = 'codexmods:window';
const FRAMEWORK_MOD = 'codexmods.framework';
const SIDE_CHAT = 'chat';
const args0 = (m) => (m.args && typeof m.args === 'object' ? m.args : {});   // instances a window keeps observed for its bindings (the oldest go first)

/**
 * @param {{ kernel: object | null | undefined, graph: object, bindings: object[], log?: (m: string, d?: object) => void,
 *   onFault?: (bindingId: string, error: Error) => void, schedule?: (fn: () => void) => void }} o
 *   `graph`: the framework's renderer `ctx.graph` (types, subscribe); `present`: its `ctx.present` (request cards' Requests); `tokens`: the
 *   adapter's theme map (token name -> CSS custom property); `bindings`: defineBinding values.
 * @returns {{ replica: object, armed: string[], tripped: () => string[], dispose(): void } | null}  null without a kernel
 */
export function startPresentation(o) {
  const { kernel, graph } = o;
  const log = o.log ?? (() => {});
  const schedule = o.schedule ?? ((fn) => queueMicrotask(fn));
  if (!kernel || !kernel.store || !kernel.kernel) return null;
  const store = kernel.store;
  const armed = new Set(Array.isArray(kernel.kernel.bindings) ? kernel.kernel.bindings : []);

  // The page learns the types' concepts once, before any subject is observed: an instance's key in the replica is its concept, so the
  // key must not change under it. Until then bindings see no subjects (the app's own rendering).
  let concepts = null;
  const conceptOf = (typeId) => (concepts && concepts.get(typeId)) || typeId;
  const replica = createReplica({ subscribe: (query, fn) => graph.subscribe(query, fn), conceptOf, onError: (e) => log('replica', { message: String(e?.message ?? e) }) });

  let queued = false;
  /** Every wrapper re-renders (a renderer came or went, a binding tripped, the types arrived). */
  // what else follows the page's changes (the panels' tab kinds: their epoch moves when a subject their answers read did), set below
  let onTouched = null;
  const bump = () => {
    if (queued) return;
    queued = true;
    schedule(() => { queued = false; try { store.bump(); } catch (e) { log('bump', { message: String(e?.message ?? e) }); } try { onTouched?.(null); } catch { /* its own */ } });
  };
  /** These subjects changed: the wrappers whose binding read one re-render, once per turn for all of them. */
  let touched = null;
  const touch = (key) => {
    if (typeof store.touch !== 'function') { bump(); return; }
    if (touched) { touched.add(key); return; }
    touched = new Set([key]);
    schedule(() => { const keys = touched; touched = null; try { store.touch([...keys]); } catch (e) { log('touch', { message: String(e?.message ?? e) }); } try { onTouched?.([...keys]); } catch { /* its own */ } });
  };
  // the keys read while `track` runs (the tab kinds' answers depend on them: a change of one moves their epoch)
  let recording = null;
  const read = (key) => { if (recording) recording.add(key); try { store.read?.(key); } catch { /* an old kernel */ } };
  /** `fn()` with the keys it read (subjects, protocol ids' answers, the page's own keys); nested runs add theirs to the outer one too. */
  const track = (fn) => {
    const outer = recording, keys = new Set();
    recording = keys;
    try { return { value: fn(), keys }; } finally { recording = outer; if (outer) for (const k of keys) outer.add(k); }
  };
  // The app's Settings by their title (a settings row names its Setting by the title it shows, E8.9k): one view of the codex Settings, made
  // when a row first asks, kept for the window's life.
  const SETTINGS_KEY = 'local:settings.byTitle';
  let settingsByTitle = null;
  function settingNamed(title, section) {
    read(SETTINGS_KEY);
    if (typeof title !== 'string' || !title.trim()) return null;
    if (!settingsByTitle) {
      const all = new Map();
      settingsByTitle = new Map();
      const index = () => {
        settingsByTitle = new Map();
        for (const x of all.values()) {
          const k = String(x.state?.title ?? '').trim().toLowerCase();
          if (!k) continue;
          if (!settingsByTitle.has(k)) settingsByTitle.set(k, []);
          settingsByTitle.get(k).push({ ref: x.ref, section: x.links?.section?.id ?? null });
        }
        touch(SETTINGS_KEY);
      };
      try {
        view({ type: 'Setting', depth: 'core' }, (m) => {
          if (!m) return true;
          // eslint-disable-next-line codexmods/no-provider-identity -- the app's own settings, indexed for search
          if (m.type === 'snapshot') { all.clear(); for (const x of m.items ?? []) if (x?.ref?.provider === 'codex') all.set(x.ref.id, x); }
          // eslint-disable-next-line codexmods/no-provider-identity -- the app's own settings, indexed for search
          else if (m.type === 'delta' && m.event?.ref?.provider === 'codex') { if (m.event.kind === 'removed') all.delete(m.event.ref.id); else if (m.event.instance) all.set(m.event.ref.id, m.event.instance); }
          else return true;
          index();
          return true;
        });
      } catch (e) { log('settings index', { message: String(e?.message ?? e) }); }
    }
    const found = settingsByTitle.get(title.trim().toLowerCase()) ?? [];
    const here = section ? found.filter((x) => x.section === section) : found;
    return here.length === 1 ? here[0].ref : null;
  }
  // The bindings whose mounts someone read (ctx.mountsOf), and each mount's props when last told: a mount that came, went or took other
  // props touches `mounts:<binding>` (a commit that changed none of its props does not).
  const watchedMounts = new Set();
  const toldProps = new WeakMap();
  let mountedCommands = () => {};   // the palette's command rows came or went: the hidden commands' notice is drawn again (set below)
  const mountChanged = (kind, rec) => {
    if ((rec?.binding === 'palette.command' || rec?.binding === 'palette.chat') && kind !== 'update') {
      if (kind === 'unmount' && rec.n !== undefined) forgetRow(ctx, rec.n);
      mountedCommands();
    }
    if (!rec || !watchedMounts.has(rec.binding)) return;
    if (kind === 'update') {
      const a = toldProps.get(rec), b = rec.props;
      toldProps.set(rec, b);
      if (a && b && (a === b || (Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((k) => a[k] === b[k])))) return;
    } else toldProps.set(rec, rec.props);
    touch(`mounts:${rec.binding}`);
  };

  // Subjects the bindings asked for stay observed (oldest out first), and any change to one re-renders the wrappers.
  const observed = new Map();   // ref key -> { view, watch }
  const keyOf = (ref) => `${ref.provider}\u001f${conceptOf(ref.type)}\u001f${ref.id}`;
  function subject(ref) {
    if (!concepts || !ref || typeof ref.id !== 'string' || typeof ref.provider !== 'string' || typeof ref.type !== 'string') return undefined;
    const k = keyOf(ref);
    read(k);
    let e = observed.get(k);
    if (e) { observed.delete(k); observed.set(k, e); }   // most recently used last
    else {
      e = { view: replica.observe(ref), watch: replica.watch(ref, () => touch(k)) };
      observed.set(k, e);
      while (observed.size > MAX_SUBJECTS) {
        const [oldKey, old] = observed.entries().next().value;
        observed.delete(oldKey);
        try { old.watch.dispose(); old.view.dispose(); } catch { /* the replica's own fault */ }
      }
    }
    return replica.get(ref);
  }

  const tripped = new Set();
  const whyTripped = new Map();   // binding id -> why it is off (the feature log's live evidence: its canary tripped)
  const react = () => kernel.exports && kernel.exports.react;
  const threads = createThreadSubjects({ present: o.present, schedule, onChange: (keys) => { for (const k of keys) touch(k); } });
  /** The ref a thread id the app shows stands for (its own chat). */
  const thread = (id) => threads.thread(id);
  /** The ref another id the app shows stands for (a turn's, an item's): `native(id)`, Codex's own. */
  const protocol = (id, native) => threads.of(id, native);
  /** The Request behind a request card, by the request id the app was asked with (reading it re-renders the binding when it comes). */
  const request = (id) => { if (typeof id === 'string' && id) read(`req:${id}`); return threads.request(id); };
  const tokens = o.tokens && typeof o.tokens === 'object' ? o.tokens : {};
  /** A theme token as a CSS value (V9: the theme owns colors and fonts), or undefined when this build's theme has none. */
  const token = (name) => (typeof tokens[name] === 'string' && tokens[name].startsWith('--') ? `var(${tokens[name]})` : undefined);
  // A declaration of the window's own (no instance it is for): not while the user has switched it off (layouts.md D9), and only while its where holds, the window's mode or
  // layout among what it reads (D5)
  const SWITCHED = Object.freeze({ regions: 'region', layouts: 'layout' });
  /** The sidebar open or closed by the app's core setter, a mod's or a layout's and never told for the user's (layouts.md D11). */
  function setSidebarOpen(open) {
    const set = kernel.exports?.responsive?.setSidebar, node = anyScopeNode();
    if (typeof set !== 'function' || !node) return { unavailable: 'this window\'s sidebar has no setter here' };
    layouts.around(() => set(node, open));
    return true;
  }
  function windowAllows(r) {
    if (r.presentation === 'Window' && SWITCHED[r.slot] && switches?.isOff(SWITCHED[r.slot], `${r.mod}/${r.id}`)) return false;
    if (r.where === undefined || (r.presentation !== 'Window' && r.presentation !== 'Sidebar')) return true;
    const ref = instances ? instances.windowRef() : null;
    try { return compiledWhere(r.where).test((ref ? subject(ref) : null) ?? { ref: { type: 'Window', provider: 'codexmods.windows', id: '0' }, state: {} }, whereEnvFor(r)); } catch { return false; }
  }
  /**
   * A hook, for a binding's own components only: the route the app's scope says here, or null: a build without the exposures, or a place the app
   * gives no route scope (its read throws there; the title bar can draw a chat's header before its workspace has one). Read as the kernel's wrappers read it.
   */
  function useRoute() { return useRouteNode()?.value ?? null; }
  /** A hook, as `useRoute`: the app's route scope itself, or null. */
  function useRouteNode() {
    const x = kernel.exports || {};
    if (typeof x.useScope !== 'function' || !x.RouteScope) return null;
    // its read throws before the one hook slot it holds: the slot is taken here, so the hooks after it stay where they are when the scope comes
    try { return x.useScope(x.RouteScope) ?? null; } catch { react()?.useRef?.(null); return null; }
  }
  /**
   * A hook, for a binding's own components only (never in render): the protocol id of the thread the window's route shows, or null.
   * It reads the route through the app's scope hook (the `useScope` and `RouteScope` exposures); a build without them has none.
   */
  function useRouteThread() {
    const route = useRoute();
    return route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null;
  }
  /**
   * A hook, for a binding's own components only (they render outside its wrapper): runs `compute` with its subject reads recorded, and
   * re-renders the component when one of them changes. Without the app's React hooks it only computes.
   */
  function use(compute) {
    const R = react();
    if (!R || typeof R.useRef !== 'function' || typeof R.useSyncExternalStore !== 'function' || typeof store.snapshot !== 'function') return compute();
    const deps = R.useRef(null);
    R.useSyncExternalStore(store.subscribe, () => store.snapshot(deps.current));
    const reading = new Set();
    const outer = store.reading;
    store.reading = reading;
    try { return compute(); } finally { store.reading = outer; deps.current = reading; }
  }
  /** What a binding's render receives besides the element: its subjects, the thread a protocol id stands for, the app's React, tokens. */
  /** Page-local state a binding's render or component follows, by key (`local:…`): `read` records it, `touch` re-renders who read it. */
  const local = Object.freeze({ read: (key) => read(key), touch: (key) => touch(key) });
  const exportsOf = () => kernel.exports || null;
  /** The graph's views and invoke, for the framework's own components that read or act (the composer's pickers, E3). */
  const view = (query, fn) => graph.subscribe(query, fn);
  const invoke = (ref, operation, args) => (typeof graph.invoke === 'function' ? graph.invoke(ref, operation, args ?? []) : Promise.reject(new Error('the graph cannot be acted on here')));
  /** The user's own act on an instance the framework draws a control for (a mod's Account's sign in; a chat's row or view): the Host invokes it as the user's. */
  const userAct = (ref, operation) => Promise.resolve(o.present?.userAct ? o.present.userAct(ref, operation) : { status: 'refused', reason: 'unavailable', message: 'the Host cannot be asked' })
    .catch((e) => ({ status: 'failed', error: { message: String(e?.message ?? e) } }));
  // A mod's notification in this window (public-hooks.md §3.14): the app's own toast, its title the mod's, the mod named by the framework
  // under it; its actions (two at most) the toast's buttons. What the user did goes back to the Host (`noticeAnswer`).
  const shownNotices = new Map();   // notification id -> {t: the app's toast handle, token: its showing's}
  const TOAST_LEVEL = { info: 'info', success: 'success', warning: 'warning', error: 'danger' };
  function notice(m) {
    // each showing has its token: what the user does with this one never answers for a later one of the same id
    const answer = (outcome) => { void Promise.resolve(o.instances?.noticeAnswer?.(m.gen, m.id, { ...outcome, token: m.token })).catch(() => {}); };
    const prev = shownNotices.get(m.id);
    if (m.t === 'noticeEnd') {
      if (prev && prev.token === m.token) { shownNotices.delete(m.id); try { prev.t?.close?.(); } catch { /* gone */ } }
      return;
    }
    shownNotices.delete(m.id);   // its own removal is no longer this notification's end
    let api;
    try { api = kernel.exports?.toast?.get?.() ?? null; } catch { api = null; }
    const show = api && typeof api[TOAST_LEVEL[m.kind] ?? 'info'] === 'function' ? api[TOAST_LEVEL[m.kind] ?? 'info'] : null;
    if (!show) { answer({ gone: true }); return; }
    let t = null;
    const button = (a) => ({ label: a.title, onClick: () => { answer({ action: a.id }); try { t?.close?.(); } catch { /* gone */ } } });
    // who sent it, in the framework's words, first (the mod's name and id); then the mod's text
    const from = typeof m.from === 'string' && m.from ? m.from : String(m.requester?.id ?? '');
    try {
      t = show.call(api, m.title, { description: m.body ? `${from}\n${m.body}` : from, id: `codexmods:${m.id}`, ...(m.sticky ? { duration: 0 } : {}),
        ...(m.actions?.[0] ? { primaryAction: button(m.actions[0]) } : {}), ...(m.actions?.[1] ? { secondaryAction: button(m.actions[1]) } : {}),
        onRemove: () => { if (shownNotices.get(m.id)?.t === t) { shownNotices.delete(m.id); answer({ gone: true }); } } });
    } catch (e) { log('a notification could not be shown', { message: String(e?.message ?? e) }); answer({ gone: true }); return; }
    shownNotices.set(m.id, { t, token: m.token });
  }

  // The user's own actions the framework holds or observes (public-hooks.md §3.4, §3.5): user-action.mjs
  const userActions = createUserActions(o.present);
  const userAction = userActions.userAction;
  /**
   * A command the user runs in the page (the command seam, H6m3: the palette, a key chord the page sees, the app's buttons, a mod's palette
   * row that names one) as the user's Command.run: while something holds it, the dispatch answers handled at once and the app's own runs
   * once the Host lets it go (refused, the window says why); else the app's own dispatch, its answer kept. Let go later, it runs only in the
   * chat it was asked in (the dispatcher finds its handler as the page is then: another chat shown, it is not run), with a fresh copy of a
   * key chord's event (the original was handled when the hold answered). Not the user's here: a `run-command` from main
   * (`host_run_command`: the native menu bar and the floating palette, held in framework-main, and the framework's own runs), a follow-up
   * the page dispatches itself (`side_panel_full_width`), a dispatch while another command runs (its own part), and one without a source.
   * While held, the dispatch answers handled: a caller that falls back when nothing handles a command (the Micro press's voice mode, the
   * palette's retry in another place) does not fall back then.
   */
  let commandNow = null;   // the command the page's dispatcher runs now (what it copies as it runs is classified by it: COPY_NOT_CONTENT)
  const within = (id, run) => (...a) => { const was = commandNow; commandNow = id; try { return run(...a); } finally { commandNow = was; } };
  const NOT_USER_SOURCES = new Set(['host_run_command', 'side_panel_full_width']);
  const commandSaid = (id) => (h) => {
    if (h.go !== false || h.handled) return;
    let api;
    try { api = kernel.exports?.toast?.get?.() ?? null; } catch { api = null; }
    try { api?.warning?.call(api, 'Not run', { description: String(h.message ?? 'not allowed').slice(0, 300), id: `codexmods:command:${id}` }); } catch { /* the toast is best effort */ }
  };
  // where a command acts when it runs: the chat shown and the composer in use (a side chat's, the main one's: the app's composer commands
  // act on the active one), as keys
  const shownKey = () => {
    const t = shownChat();
    const c = nearestComposer(globalThis.document?.activeElement ?? null);
    return `${t ? `${t.type}:${t.id}` : ''}|${c ? `${c.draft?.id ?? ''}` : ''}`;
  };
  /** A copy of a key chord's event (the original was handled when its hold answered), else the event as it was. */
  const freshEvent = (ev) => {
    const K = globalThis.KeyboardEvent;
    if (!ev || typeof K !== 'function' || !(ev instanceof K)) return ev;
    try {
      const out = new K(ev.type, { key: ev.key, code: ev.code, location: ev.location, repeat: ev.repeat, isComposing: ev.isComposing, ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, bubbles: ev.bubbles, cancelable: ev.cancelable, composed: ev.composed });
      // where it was pressed (a handler's guards read it: Enter on a button is not an approval's), as the original says
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      for (const [k, v] of [['target', ev.target], ['srcElement', ev.target], ['currentTarget', ev.currentTarget]]) Object.defineProperty(out, k, { value: v, configurable: true });
      Object.defineProperty(out, 'composedPath', { value: () => path, configurable: true });
      return out;
    } catch { return ev; }
  };
  /** The user's run of a command (`run(event?)` the app's own), held while something holds it; let go later, only in the chat it was asked in. */
  const commandRun = (id, event, run) => {
    const at = shownKey();
    let now = true;
    const go = within(id, () => {
      if (now) return run();
      if (shownKey() !== at) {
        commandSaid(id)({ go: false, message: 'another chat is shown now' });
        throw new Error('not run: another chat is shown now');
      }
      return run(freshEvent(event));
    });
    const out = userAction({ type: 'Command', provider: 'codex', id }, 'run', [], go, { said: commandSaid(id) });
    now = false;
    return out;
  };
  // The approve and decline shortcuts answer the card of the chat the focus is in (graph-integrity G4.4: input goes where the focus is): the
  // app's own answers the card registered last, whichever pane it is in. Each card's keys' answers are noted by chat as it draws (its held
  // answers: request-body.mjs); with cards in more than one place, the focused place's card is answered, and none where it has none.
  const SHORTCUT_ANSWERS = Object.freeze({ 'approval.approve': 'approve', 'approval.decline': 'deny' });
  const cardAnswers = new Map();   // a chat's key -> {ref, approve, deny}: its pending card's answers, as it last drew
  const chatKey = (r) => `${r.provider}\u001f${r.id}`;
  const noteAnswers = (ref, answers) => {
    const inst = replica.get(ref) ?? null;
    const thread = inst?.links?.thread;
    if (thread && typeof thread.id === 'string') cardAnswers.set(chatKey(thread), { ref, ...answers });
  };
  /** The chat the user is in: the focused pane's, else the one the window's main region shows. */
  const focusedChat = () => {
    const f = hostedThreads?.facts?.() ?? null;
    const pane = f?.active ? (f.list ?? []).find((p) => p.token === f.active) : null;
    return pane?.thread ?? shownChat();
  };
  function answerWhereFocus(id, source) {
    const which = SHORTCUT_ANSWERS[id];
    if (!which || source !== 'keyboard_shortcut') return undefined;
    const pending = (c) => { const x = replica.get(c.ref); return !!x && !x.gone && x.state?.status === 'pending'; };
    for (const [k, c] of [...cardAnswers]) if (!pending(c)) cardAnswers.delete(k);   // answered or gone: forgotten
    // the cards of the chats the window shows now (its main region's and its panes'), each still waiting
    const shownKeys = new Set([shownChat(), ...((hostedThreads?.facts?.()?.list ?? []).map((p) => p.thread))].filter(Boolean).map(chatKey));
    const cards = [...cardAnswers].filter(([k, c]) => shownKeys.has(k) && pending(c));
    if (cards.length < 2) return undefined;   // one card shown: the app's own answers it, as ever
    const chat = focusedChat();
    const card = chat ? cardAnswers.get(chatKey(chat)) : null;
    if (card && pending(card) && typeof card[which] === 'function') { try { card[which](); } catch (e) { log('a shortcut\'s answer failed', { message: String(e?.message ?? e) }); } }
    return true;   // handled: the focused place's card, or none where the focus is (never another place's)
  }
  const commandHook = (id, event, source, origin, run) => {
    if (typeof id !== 'string' || !id || typeof source !== 'string' || NOT_USER_SOURCES.has(source) || commandNow !== null || typeof run !== 'function') return undefined;
    const answered = answerWhereFocus(id, source);
    if (answered !== undefined) return answered;
    const out = commandRun(id, event, run);
    return typeof out === 'boolean' ? out : true;
  };
  store.command = (...args) => { layouts?.noteInput(); return commandHook(...args); };
  const commandSeen = store.command;
  /**
   * A composer's attaches (the attach seam, H6m3b): the user's own (a picker's files, a paste, a drop) are their Draft.attach of the
   * composer they are in (the mounted composer whose editor is nearest the place they acted at; the only one when one is mounted), held
   * while something holds it: answered at once (a promise, as the app's own async ones) and attached once the Host lets it go (refused,
   * the window says why); else the app's own at once, its answer kept. The app's own attaches (a file it mentions, data it adds) are not
   * the user's here. Its arguments: `{via, files}` (each file's name, and its path, type and size where it has them).
   */
  const fileOf = (f) => {
    if (!f || typeof f !== 'object') return null;
    const path = typeof (f.fsPath ?? f.path) === 'string' ? f.fsPath ?? f.path : null;
    const name = String(f.name ?? f.label ?? f.filename ?? (path ? path.split('/').pop() : '') ?? '').slice(0, 300);
    return { name, ...(path ? { path } : {}), ...(typeof f.type === 'string' && f.type ? { type: f.type } : {}), ...(Number.isFinite(f.size) ? { size: f.size } : {}) };
  };
  const filesOf = (x) => {
    const list = Array.isArray(x) ? x : x && typeof x === 'object' && Array.isArray(x.files) ? [...x.files, ...(Array.isArray(x.directoryFiles) ? x.directoryFiles : [])] : x ? [x] : [];
    return list.map(fileOf).filter(Boolean);
  };
  const USER_ATTACH = ['addFiles', 'addPickedFiles', 'addImages', 'addDraggedImage', 'addSidebarDroppedFiles', 'addFileMentionsFromFiles', 'addImageAttachment'];
  /** The mounted composer whose editor is nearest an element (its record, and the Draft it writes), or null; the only one, with no element. */
  function nearestComposer(at, { only = false } = {}) {
    const recs = typeof store.mounted === 'function' ? store.mounted().filter((r) => r?.binding === 'composer') : [];
    const b = bindingsById.get('composer');
    if (!recs.length || typeof b?.subject !== 'function') return null;
    let best = only && recs.length === 1 ? recs[0] : null, depth = -1;
    if (at) {
      for (const r of recs) {
        let a = r.context?.view?.dom ?? null;
        while (a && a !== at && !(typeof a.contains === 'function' && a.contains(at))) a = a.parentElement ?? null;
        if (!a) continue;
        let d = 0;
        for (let x = a; x; x = x.parentElement ?? null) d++;
        if (d > depth) { depth = d; best = r; }
      }
    }
    if (!best) return null;
    let draft;
    try { draft = b.subject(best.props ?? {}, ctx, best.scope, best.near) ?? null; } catch { draft = null; }
    return { rec: best, draft };
  }
  /**
   * The Draft an attach is of: its factory's own composer scope (the scope it was made for: a chat's, a side chat's, a new chat's), else
   * the mounted composer nearest the place the user acted at (the only one, when one is mounted).
   */
  const attachDraft = (args, place) => {
    const b = bindingsById.get('composer');
    const own = args?.scope && typeof args.scope === 'object' && args.scope.value && typeof args.scope.value === 'object' ? args.scope.value : null;
    if (own && typeof b?.subject === 'function') {
      try { const d = b.subject({}, ctx, own, null); if (d) return d; } catch { /* named another way */ }
    }
    return nearestComposer(elementOf(place?.target) ?? globalThis.document?.activeElement ?? null, { only: true })?.draft ?? null;
  };
  const attachSaid = (h) => {
    if (h.go !== false || h.handled) return;
    let api;
    try { api = kernel.exports?.toast?.get?.() ?? null; } catch { api = null; }
    try { api?.warning?.call(api, 'Not attached', { description: String(h.message ?? 'not allowed').slice(0, 300), id: 'codexmods:attach' }); } catch { /* the toast is best effort */ }
  };
  /** A drop's data copied now (it cannot be read once the drop event is over: a held attach reads it later), else as it was. */
  const dragCopy = (dt) => {
    const DT = globalThis.DataTransfer;
    if (!dt || typeof DT !== 'function' || typeof dt.getData !== 'function') return dt;
    try {
      const out = new DT();
      for (const type of dt.types ?? []) if (type !== 'Files') out.setData(type, dt.getData(type));
      for (const f of dt.files ?? []) out.items.add(f);
      return out;
    } catch { return dt; }
  };
  const attachHook = (methods, args, place) => {
    let out = null;
    for (const name of USER_ATTACH) {
      const own = methods[name];
      if (typeof own !== 'function') continue;
      out ??= { ...methods };
      out[name] = function held(...a0) {
        const draft = attachDraft(args, place);
        if (!draft) return own.apply(this, a0);
        const a = name === 'addDraggedImage' ? [dragCopy(a0[0]), ...a0.slice(1)] : a0;
        // the composer's attachment generation as asked: changed while it waited (another host, a cleared composer), it is not attached
        const gen = args?.attachmentGeneration && typeof args.attachmentGeneration === 'object' ? args.attachmentGeneration.current : undefined;
        let ran = false, settle = null, fail = null;
        const done = new Promise((res, rej) => { settle = res; fail = rej; });
        void done.catch(() => {});   // a caller that never awaits it is not told of a rejection
        const r = userAction(draft, 'attach', [{ via: name, files: filesOf(a0[0]) }], () => {
          ran = true;
          if (gen !== undefined && args.attachmentGeneration.current !== gen) { settle(false); throw new Error('not attached: the composer changed while it waited'); }
          let v;
          try { v = own.apply(this, a); } catch (e) { fail(e); throw e; }
          Promise.resolve(v).then(settle, fail);
          return v;
        }, { said: (h) => { attachSaid(h); if (h.go === false || h.handled) settle(h.handled === true); } });
        // held: answered with what the attach does once decided (its own answer, or its own failure, once let go; false refused)
        return ran ? r : done;
      };
    }
    return out;
  };
  store.attach = attachHook;
  /**
   * The review panel's git actions (the review action seam, H6m4): a file's, a part of one's or a section's stage, unstage or revert are
   * the user's GitRepository.stage / unstage (their files) or Repository.discard (their files; `staged` when the panel shows the staged
   * changes) of the repository the panel shows (named by its folder: the Host lists it), held while something holds them: answered at
   * once and done once the Host lets it go (refused, the window says why). A part of a file counts as its file. Anything else (another
   * action, no folder, no file) is the app's own.
   */
  const REVIEW_OPS = Object.freeze({ stage: 'stage', unstage: 'unstage', revert: 'discard' });
  const reviewSaid = (h) => {
    if (h.go !== false || h.handled) return;
    let api;
    try { api = kernel.exports?.toast?.get?.() ?? null; } catch { api = null; }
    try { api?.warning?.call(api, 'Not done', { description: String(h.message ?? 'not allowed').slice(0, 300), id: 'codexmods:review-action' }); } catch { /* the toast is best effort */ }
  };
  // this Mac's (a review or a pull request of another host is not one of the app's projects here: the app's own)
  const localHostConfig = (h) => !h || typeof h !== 'object' || h.id === undefined || h.id === null || h.id === 'local';
  const reviewHook = (arg, run) => {
    const p = arg?.params;
    const operation = p && typeof p.action === 'string' && Object.hasOwn(REVIEW_OPS, p.action) ? REVIEW_OPS[p.action] : null;
    if (!operation || typeof arg.cwd !== 'string' || !arg.cwd || typeof run !== 'function' || !localHostConfig(arg.hostConfig)) return undefined;
    const files = p.scope === 'section'
      ? (Array.isArray(arg.reviewFiles) ? arg.reviewFiles : []).map((f) => (typeof f === 'string' ? f : f?.path)).filter((x) => typeof x === 'string' && x)
      : typeof p.path === 'string' && p.path ? [p.path] : [];
    if (!files.length) return undefined;
    const args = operation === 'discard' ? [files, arg.stageFilter === 'staged' ? 'staged' : 'unstaged'] : [files];
    // held: answered with the action once decided (its own answer, or its own failure, once let go; nothing refused), so the panel stays
    // busy meanwhile (its next action waits, as for one under way)
    let ran = false, settle = null, fail = null;
    const done = new Promise((res, rej) => { settle = res; fail = rej; });
    void done.catch(() => {});
    const out = userAction({ type: 'Repository', cwd: arg.cwd }, operation, args, () => {
      ran = true;
      let v;
      try { v = run(); } catch (e) { fail(e); throw e; }
      Promise.resolve(v).then(settle, fail);
      return v;
    }, { said: (h) => { reviewSaid(h); if (h.go === false || h.handled) settle(undefined); } });
    return ran ? out : done;
  };
  store.reviewAction = reviewHook;
  // the conversations sidebar's groups in the mods' order, where the user placed none (layouts.md §4.1)
  const groupsHook = (keys) => orderGroups(ctx, ctx.ruled('Sidebar', null)?.parts, keys);
  store.sidebarGroups = groupsHook;
  /**
   * A pull request the user creates (the pr-create seam, H6m4: either of the app's routes, the gh CLI or the GitHub connector) is their
   * Branch.openPullRequest (the branch named by its project's folder and its name: the Host lists it), held while something holds it:
   * refused, the page shows why (the creation throws it); a mod's own pull request in its place is the creation's answer. Opening the
   * browser's form to create one, and another host's, are the app's own.
   */
  const prHook = (arg) => {
    if (!arg || arg.openInBrowser === true || typeof arg.cwd !== 'string' || !arg.cwd || typeof arg.headBranch !== 'string' || !arg.headBranch) return undefined;
    if (!(arg.hostId === undefined || arg.hostId === null || arg.hostId === 'local')) return undefined;
    const options = {
      ...(typeof arg.baseBranch === 'string' && arg.baseBranch ? { base: arg.baseBranch } : {}),
      ...(typeof arg.titleOverride === 'string' ? { title: arg.titleOverride } : {}),
      ...(typeof arg.bodyOverride === 'string' ? { body: arg.bodyOverride } : {}),
      ...(typeof arg.isDraft === 'boolean' ? { draft: arg.isDraft } : {}),
    };
    return new Promise((resolve) => {
      userAction({ type: 'Branch', cwd: arg.cwd, name: arg.headBranch }, 'openPullRequest', [options], () => { resolve(undefined); }, { said: (h) => {
        if (h.handled) {
          const url = h.value && typeof h.value.id === 'string' ? h.value.id : null;
          const number = url ? Number(/\/pull\/(\d+)/.exec(url)?.[1]) : NaN;
          resolve(url ? { handled: { url, ...(Number.isFinite(number) ? { number } : {}) } } : { refused: 'No pull request: a mod made one, and it could not be named' });
        } else if (h.go === false) resolve({ refused: `No pull request: ${String(h.message ?? 'not allowed').slice(0, 300)}` });
      } });
    });
  };
  store.pullRequestCreate = prHook;
  // The framework's own presentations (E6.5): records its components put while shown, reported through the same registry as the kernel's.
  const reportedRecs = new Set();
  const report = Object.freeze({
    put(rec) { const known = reportedRecs.has(rec); reportedRecs.add(rec); instances?.onMount(known ? 'update' : 'mount', rec); },
    remove(rec) { if (reportedRecs.delete(rec)) instances?.onMount('unmount', rec); },
  });
  // the mods' palette sources (mod-surfaces.md §3.2): the `palette` binding mounts their registrar beside the palette
  let paletteSources = null;
  /** The scope node a mounted binding of this window holds (the palette's AppScope, a route's RouteScope). */
  // a hosted chat's mounts are not the window's page: nothing here takes a pane's scope for the route's (layouts.md D8)
  const scopeNodeOf = (bindingId) => (typeof store.mounted === 'function' ? store.mounted().find((rec) => rec?.binding === bindingId && rec.scopeNode && !rec.pane)?.scopeNode ?? null : null);
  /** Any app scope node a mount of this window holds (any of the app's scopes reaches its AppScope atoms), or null. */
  let destinations = null;   // the mods' destinations (destinations.mjs), made once the rules are
  let mainPages = null;      // the mods' own pages (main-pages.mjs), made with them
  let layouts = null;        // the window's named layouts (layouts.mjs), made with the allocator
  let switches = null;       // the user's switches for them (layout-switches.mjs)
  const anyScopeNode = () => (typeof store.mounted === 'function' ? store.mounted().find((rec) => rec?.scopeNode && !rec.pane && typeof rec.scopeNode.set === 'function')?.scopeNode ?? null : null);
  let slashItems = null;   // the mods' slash commands (mod-surfaces.md §3.6): the `composer.suggest` binding mounts their registrar
  let mentionSources = null;   // the mods' mention sources (§3.6): the `mention.list` binding splices their sections into the "@" list
  let composerSuggestions = null;   // the mods' inline suggestions (ui.composer.suggest, RM8): the composer binding follows each editor
  let layoutPicker = null;   // the title bar's menu of the window's layouts (layouts.md D6)
  let hostedThreadsNow = null;   // the hosted chats (made below), for the instances' `activePane`
  let dropsNow = null;           // the places that take drops (made below), for the lent parts the bindings draw
  const ctx = Object.freeze({ subject, thread, protocol, request, react, token, useRouteThread, use, local, exports: exportsOf, log, view, invoke, userAct, userAction, noteAnswers: (ref, answers) => noteAnswers(ref, answers), report, layoutPicker: () => layoutPicker?.() ?? null, ruled: (p, inst) => ruled(p, inst),
    // graph-integrity G2.1, G2.2: whether the app's own store holds an instance (its rows and menus are the app's), and opening one it does
    // not (its registered view)
    holds: (ref) => threads.holds?.(ref) !== false,
    open: (ref, known) => showDetail(ref, known),
    // the window's facts may have changed (a binding drew what they say): they go with the next report
    windowChanged: () => { try { instances?.windowChanged(); } catch { /* not reporting yet */ } },
    // has the graph answered for this instance (so a subject that reads undefined is absent, not loading)?
    settled: (ref) => { try { return replica.settled(ref); } catch { return false; } },
    // the mods' declarations of a slot that no instance holds (a sidebar filter, graph-layers.md §3.4), in rule order; each guarded
    /** The sidebar view of the mod's page shown now, drawn in its rule's boundary; null on any other route (layouts.md D7, WL5c). */
    pageSidebar: () => destinations?.viewNode() ?? null,
    declared: (presentation, slot) => { const off = new Set(rules.tripped()); return rules.all().filter((r) => r.kind === 'add' && r.presentation === presentation && r.slot === slot && !off.has(`${r.mod}/${r.id}`) && windowAllows(r)).sort((a, b) => a.order - b.order); },
    /** A mod's component drawn as a rule's (its error boundary trips that rule alone): a region's (layouts.md WL4a). */
    modNode: (rule, type, props) => { const R = react(); return R && typeof type === 'function' ? node(R, rule, type, props) : null; },
    guard: (rule, fn) => rules.guard(rule, fn),
    /** What a `where` reads besides its subject, as a mod may see it (public-hooks.md §3.1). */
    whereEnv: (mod) => whereEnvFor(mod),
    /** A type and the types it is a subtype of, from the types' reflection. */
    chainOf: (typeId) => chainOf(typeId),
    /** This window's Window ref (an action's env names it), or null before the Host told it. */
    windowRef: () => (instances ? instances.windowRef() : null),
    drops: () => dropsNow,   // the places that take drops (G5.3), once made
    paletteSources: () => paletteSources, slashItems: () => slashItems, mentionSources: () => mentionSources, composerSuggestions: () => composerSuggestions, scopeNodeOf, anyScopeNode,
    /** The mounts of a binding in this window now (a menu's rows while it is open, for an operation that chooses among them); a render
     *  that reads them renders again when they come, go or take other props. */
    mountsOf: (id) => { watchedMounts.add(id); read(`mounts:${id}`); return typeof store.mounted === 'function' ? store.mounted().filter((r) => r?.binding === id) : []; },
    /** The side panel shows on a page the app keeps no tabs for: the mods' remembered tabs reopen there, after this render. */
    // in the asking panel's own route scope (its mount's), after its render
    restorePanels: (route, panelId, rec) => { if (o.modPanels && (panelId === 'right' || panelId === 'bottom')) schedule(() => { try { o.modPanels.restore(route, panelId, rec?.scopeNode ?? null); } catch (e) { log('panel views could not be restored', { message: String(e?.message ?? e) }); } }); },
    projectMenu: (ref, items) => projectMenu(ref, items), subjectMenu: (ref) => subjectMenu(ref),
    /** A chat's summary, by its protocol id, as its sidebar row's rules give it (`threadSummary`), or null; read. */
    threadSummary: (id) => threadSummary(thread(id)),
    /** A chat's badges, by its ref, as its sidebar row's rules give them (`threadBadges`): a row the framework draws shows them; read. */
    threadBadges: (ref) => threadBadges(ref),
    /** What the mods' defaults give a new automation (public-hooks.md §3.8), for the app's own create form: a promise of its values. */
    automationDefaults: () => Promise.resolve(o.present?.automationDefaults?.()).catch(() => ({})),
    /** The mods' themes (public-hooks.md §3.14, H7y): `{active: {mod, id, applied} | null}`, the Host's, followed (a change draws again). */
    themes: () => themesNow(),
    /** The user turns a mod's theme on (`mod`, `id`), or off (null): the Host writes it as the app's settings. A promise of the outcome. */
    useTheme: (mod, id) => Promise.resolve(o.present?.useTheme?.(mod ?? null, id ?? null)).catch((e) => ({ status: 'failed', error: { message: String(e?.message ?? e) } })),
    /** A mod's name, as its manifest says (its id until the graph has it). */
    modName: (id) => modName(id),
    /** The app's Setting a settings row's title names on a settings page (its section's slug), or null; read again once the Settings come. */
    settingNamed: (title, section) => settingNamed(title, section) });
  // The mods' presentation rules (E2): the window's copy of the accepted rules, applied in the bindings' wrappers.
  const parents = new Map();   // type id -> its parent, from the types' reflection
  const chainOf = (typeId) => { const out = []; for (let t = typeId; t && !out.includes(t); t = parents.get(t)) out.push(t); return out; };
  /**
   * What a rule's `where` reads besides its subject (public-hooks.md §3.1), as the rule's mod may see it: the types' relations (from
   * their reflection), a relation's target from this window's replica (one not here yet is not known now: it is observed, and the
   * subject renders again when it comes; one the mod may not read is not known either: `reads`, from the Host) and attached data (its
   * own and the shared ones). `rule`: `{mod, reads}`, or a mod id (the framework's own: everything).
   */
  const whereEnvFor = (rule) => {
    const mod = typeof rule === 'string' ? rule : rule?.mod ?? null;
    const reads = typeof rule === 'object' && rule ? rule.reads : '*';
    // as the Host's policy: a grant's types, its own instances, and the instances of a type it declared (another mod's too)
    const may = (x) => reads === undefined || reads === '*' || x.ref.provider === mod || (Array.isArray(reads) && chainOf(x.ref.type).some((t) => reads.includes(t)))
      || (typeof mod === 'string' && chainOf(x.ref.type).some((t) => typesById.get(t)?.owner === `mod:${mod}`));
    return {
    /** The window's context a presentation's where may read (layouts.md D5). */
    window: () => layouts?.context() ?? {},
    /** May the rule's mod read this instance? */
    may: (x) => !!x && !!x.ref && may(x),
    /** An instance it names (a status's subject), observed, when its mod may read it and it is here. */
    resolve(ref) { const x = subject(ref); return x && !x.gone && may(x) ? x : undefined; },
    relation: (typeId, name) => !!typesById.get(typeId)?.members?.relations?.[name],
    related(inst, name) {
      const l = inst?.links?.[name];
      if (l === undefined) return undefined;
      if (l === null) return null;
      const one = (r) => { const x = subject(r); return x && !x.gone && may(x) ? x : undefined; };
      if (Array.isArray(l)) { const xs = l.map(one); return xs.includes(undefined) ? undefined : xs; }
      return one(l);
    },
    attached(inst, m) {
      const all = inst?.attached;
      if (!all || !Object.hasOwn(all, m)) return undefined;
      if (m === mod || !Array.isArray(inst.attachedPrivate)) return all[m];
      // another mod's values as this rule's mod may see them: its shared ones (privacy is per value, `<modId>/<name>`)
      const seen = Object.fromEntries(Object.entries(all[m] ?? {}).filter(([name]) => !inst.attachedPrivate.includes(`${m}/${name}`)));
      return Object.keys(seen).length ? seen : undefined;
    },
    };
  };
  // A mod's rules that lost (E6.5b), for its page: a claim (hide, replace) another mod's rule holds on a presentation both cover, found
  // when such a presentation renders in this window; a style variable another mod's rule holds, exact. Kept while both rules are.
  const LOST_KEY = 'local:lost-rules';
  const lostClaims = new Map();   // `${loser}>${winner}` -> { mod, rule, kind, what, to }
  let lostStyles = [];
  const lostChanged = () => { try { touch(LOST_KEY); } catch { /* the page went */ } };
  const forgetLost = (key) => { let gone = false; for (const k of [...lostClaims.keys()]) if (!key || k.startsWith(`${key}>`) || k.endsWith(`>${key}`)) { lostClaims.delete(k); gone = true; } if (gone) lostChanged(); };
  const lostRulesOf = (modId) => { read(LOST_KEY); return [...lostClaims.values(), ...lostStyles].filter((x) => x.mod === modId); };
  let syncPanels = () => {};   // set once the panel views are attached (below): a view whose rule tripped goes off
  const modalViews = new Map();   // a mod's panel views in a modal (public-hooks.md §3.14): `mod/view` -> { C, node, modal, rule }
  let panelHost = null;           // what the panel views are told by (attached below)
  let syncContent = () => {};  // set once the part renderers are attached (below): message content (E8.8)
  let syncGroups = () => {};   // set below: the sidebar's groups' order revision (layouts.md §4.1)
  let syncMainPages = () => {};   // set below: the mods' own pages (layouts.md D7)
  const rules = createRules({
    onFault: (mod, error, key, rule) => { try { o.onModFault?.(mod, error, rule?.presentation ? `${rule.presentation}${rule.slot ? `.${rule.slot}` : ''} (${rule.id})` : undefined); } catch { /* the reporter's own fault */ } bump(); syncPanels(); if (paletteSources) syncPalette(); if (slashItems) syncSlash(); syncContent(); syncGroups(); syncSettings(); syncMainPages(); destinations?.rulesChanged(); },
    onConflict: (loser, winner) => lostClaim(loser, winner),
    log,
    // a host-realm rule's callback runs in its mod's worker, through the Host (mod-surfaces.md P1)
    callback: (key, reg, path, env) => (typeof o.instances?.callback === 'function' ? o.instances.callback(key, reg, path, env) : Promise.resolve(null)),
    whereEnv: (rule) => whereEnvFor(rule),
  });
  // relative times in live text (public-hooks.md §3.13) are drawn again each minute while a rule shows one
  const relativeTick = setInterval(() => { try { if (rules.all().some((r) => hasRelative(r.data))) bump(); } catch { /* the page went */ } }, 60_000);
  relativeTick.unref?.();
  /** A claim a mod's rule lost to another's (or, for a directive name, to the app's own): told on the mod's page. */
  function lostClaim(loser, winner) {
    log('a presentation rule lost its claim to another', { rule: `${loser.mod}/${loser.id}`, to: `${winner.mod}/${winner.id}` });
    lostClaims.set(`${loser.mod}/${loser.id}>${winner.mod}/${winner.id}`, { mod: loser.mod, rule: loser.id, kind: loser.kind, what: loser.presentation, to: winner.mod });
    lostChanged();
  }
  // The mods' `style` rules (S12): the app's own variables set to theme tokens, one owner per variable, in the window's own style sheet.
  const styles = createStyles({ tokens, cssVar: o.cssVar, sink: o.styleSink, appValues: o.appValues, protectRoots: o.protectRoots, appearance: o.appearance, log });
  // A style's `where` (public-hooks.md §3.14) is read on this window's Window (its chat, its project: what its mod may read of them; the
  // refs in its own state, what it shows and showed, only where its mod may read them: H7w review 1); the reads are recorded, so a change
  // of any (another chat shown here, a project renamed) styles the page again, and what they read stays observed for as long as they do
  // (not left to the bindings' recent subjects). Not known yet: not applied. The page's style sheet is written only when the styles that
  // hold change (or a rule or the theme does).
  let styleReads = null, styleSeen = '', styleSig = null;
  const styleHeld = new Map();   // subject key -> {view, watch}: what the styles' wheres read
  const subjectsOf = (keys) => String(store.snapshot(keys)).split('|')[1];
  const holdForStyles = (refs) => {
    const want = new Map(refs.filter((r) => r && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string').map((r) => [keyOf(r), r]));
    for (const [k, h] of [...styleHeld]) if (!want.has(k)) { try { h.watch.dispose(); h.view.dispose(); } catch { /* the replica's own */ } styleHeld.delete(k); }
    for (const [k, r] of want) if (!styleHeld.has(k)) { try { styleHeld.set(k, { view: replica.observe(r), watch: replica.watch(r, () => touch(k)) }); } catch { /* not observable */ } }
  };
  const holdsHere = (r, refs) => {
    if (r.where === undefined) return true;
    const ref = instances ? instances.windowRef() : null;
    if (!ref) return false;
    refs.push(ref);
    const win = subject(ref);
    const base = whereEnvFor(r);
    if (!win || win.gone || !base.may(win)) return false;
    // a ref in a Window's own state is read only where its mod may read what it names, by the type it is known as now (a subtype known
    // since: observed, so its coming is seen); every Window the where reaches (this one, one through a relation) is seen so (H7w review 2)
    const may = (x) => {
      if (!x || typeof x !== 'object' || typeof x.type !== 'string') return false;
      refs.push(x);
      const now = subject(x);
      return base.may(now && !now.gone && now.ref ? now : { ref: x });
    };
    const isWindow = (x) => !!x && typeof x === 'object' && !!x.ref && chainOf(x.ref.type).includes('Window');
    const masked = (x) => {
      if (!isWindow(x)) return x;
      const st = x.state ?? {};
      return { ...x, state: { ...st, current: may(st.current) ? st.current : null, history: Array.isArray(st.history) ? st.history.filter(may) : [] } };
    };
    const env = { ...base, related(inst, name) {
      const l = inst?.links?.[name];
      for (const x of Array.isArray(l) ? l : l ? [l] : []) refs.push(x);
      const out = base.related(inst, name);
      return Array.isArray(out) ? out.map(masked) : out ? masked(out) : out;
    } };
    try { return compiledWhere(r.where).test(masked(win), env) === true; } catch { return false; }
  };
  /** The styles that hold here, applied; `force`: a rule or the theme changed (else only when which styles hold changed). */
  const restyle = (force = true) => {
    const reading = new Set(), outer = store.reading, refs = [];
    let here;
    store.reading = reading;
    try { here = rules.all().filter((x) => x.kind === 'style' && holdsHere(x, refs)); } finally { store.reading = outer; }
    styleReads = reading.size && typeof store.snapshot === 'function' ? reading : null;
    styleSeen = styleReads ? subjectsOf(styleReads) : '';
    if (concepts) holdForStyles(refs);
    const sig = here.map((x) => `${x.mod}/${x.id}/${x.order}`).sort().join('|');
    if (!force && sig === styleSig) return;
    styleSig = sig;
    const r = styles.apply(here.sort((a, b) => a.order - b.order || (a.mod < b.mod ? -1 : a.mod > b.mod ? 1 : a.id < b.id ? -1 : 1)));
    const split = (key) => { const i = String(key).indexOf('/'); return [String(key).slice(0, i), String(key).slice(i + 1)]; };
    const next = (r?.conflicts ?? []).map((c) => { const [mod, rule] = split(c.rule); return { mod, rule, kind: 'style', what: c.variable, to: split(c.holder)[0] }; });
    if (JSON.stringify(next) !== JSON.stringify(lostStyles)) { lostStyles = next; lostChanged(); }
  };
  /** The window's id or the graph's types came: a style with a `where` can be read now. */
  const restyleWhere = () => { if (!disposed && rules.all().some((x) => x.kind === 'style' && x.where !== undefined)) restyle(false); };
  const styleWatch = typeof store.subscribe === 'function' ? store.subscribe(() => { if (styleReads && subjectsOf(styleReads) !== styleSeen) restyle(false); }) : null;
  const plainRef = (x) => (x && typeof x === 'object' && typeof x.type === 'string' && typeof x.provider === 'string' && typeof x.id === 'string' ? { type: x.type, provider: x.provider, id: x.id } : null);
  /**
   * What a mod's callback is given when the user runs it (docs/design/mod-surfaces.md P2), JSON only (a host-realm callback gets it
   * through the Host): the subject the presentation shows, the presentation and its window, the thread or draft it is about, and how
   * it was run.
   */
  function envOf(r, inst, via) {
    const own = plainRef(inst?.ref);
    const isA = (t) => !!own && chainOf(own.type).includes(t);
    const linkOf = (x, name) => { const l = x?.links?.[name]; return Array.isArray(l) ? null : plainRef(l); };
    // a message's or a step's thread is its turn's
    const via2 = (hop, name) => { const h = linkOf(inst, hop); const got = h ? subject(h) : null; return got && !got.gone ? linkOf(got, name) : null; };
    return Object.freeze({
      // the presentation is the mechanism layer's (graph-layers.md §2): `_presentation`
      subject: own, _presentation: r && instances ? instances.refOf(r) : null, window: instances ? instances.windowRef() : null,
      // the hosted chat this callback's control is in (layouts.md D8), captured as it starts; `route` is the window's own page, as an operation names it; null: no control of a page's
      pane: typeof r?.pane === 'string' ? r.pane : r ? 'route' : null,
      thread: isA('Thread') ? own : linkOf(inst, 'thread') ?? via2('turn', 'thread'),
      draft: isA('Draft') ? own : linkOf(inst, 'draft'), via,
    });
  }
  /** A mod's callback the user runs on a presentation: reported as that presentation's `acted` (S10), then run with its env (P2). `rec`
   *  may be a function that finds the record when the user acts (a twin's presentation, reported after the component first rendered). */
  const acting = (rec, rule, itemId, fn, inst = null, via = 'click') => (ev) => {
    const r = typeof rec === 'function' ? rec() : rec;
    // a subject its mod may not read (now) never reaches its callback (built review H7s round 2)
    if (inst && inst.ref && !whereEnvFor(rule).may(inst)) return undefined;
    if (r && instances) instances.acted(r, 'action', `${rule.mod}/${rule.id}/${itemId}`);
    // the user's own input ran a callback of the page's (a renderer rule's): its env carries the attestation (graph-integrity G7.1)
    const asUser = rule.realm === 'renderer' ? attestNow(rule.mod, ev) : null;
    const env = envOf(r, inst, via);
    return fn(asUser ? Object.freeze({ ...env, asUser }) : env);
  };
  let instances = null;
  /** A component that renders nothing: a hidden presentation keeps its place (and its key) in the app's list (integration.md §8). */
  const Hidden = () => null;
  // the agent's records a mod hides (public-hooks.md §3.12) are hidden in place: a one-line stub, "Hidden by <mod> · Show", that shows it
  const RECORDS = new Set(['StepBlock', 'MessageBlock', 'TurnView', 'DiffView']);
  const shownAnyway = new Set();   // `${presentation}\u001f${subject key}` the user showed in this window
  // never hidden (§3.12): a record still under way or waiting on the user (a running turn, a step waiting for you, a streaming answer)
  const FINISHED = new Set(['done', 'completed', 'stopped', 'failed', 'cancelled']);
  const underWay = (inst) => (typeof inst?.state?.status === 'string' && !FINISHED.has(inst.state.status)) || inst?.state?.streaming === true;
  /** Whether a hide claim takes a record out now (the user showed it, or it is under way: it stays). */
  const recordHidden = (presentation, inst) => !(RECORDS.has(presentation) && inst?.ref && (shownAnyway.has(recordKey(presentation, inst)) || underWay(inst)));
  // the transcript's records a filter of the window takes out (public-hooks.md §3.12): not drawn, never one under way
  const TRANSCRIPT = new Set(['StepBlock', 'MessageBlock', 'TurnView']);
  const filtered = (filters, inst) => !underWay(inst) && !keepsRecord(ctx, filters, inst);
  const recordKey = (presentation, inst) => `${presentation}\u001f${inst?.ref ? `${inst.ref.type}\u001f${inst.ref.provider}\u001f${inst.ref.id}` : ''}`;
  function stubOf(R, b, claim, inst) {
    const key = recordKey(b.presentation, inst);
    const color = token('textSecondary');
    // shown: drawn again, and reported shown (its presentation's facts follow what is drawn)
    const show = pageParts(R, kernel.exports ?? {}).button('Show', () => { shownAnyway.add(key); touch(`local:hidden:${key}`); instances?.touch(b.presentation); }, false, 'secondary');
    return R.createElement('div', { 'data-codexmods-hidden': claim.mod, className: 'flex items-center gap-2', ...(color ? { style: { color } } : {}) }, `Hidden by ${modName(claim.mod)}`, show);
  }
  /** One mod node in its own boundary. */
  // a mod's component is given its subject as that mod may see it: its own attached values and the shared ones, never another mod's
  // private ones (review 2026-11-05 #4)
  const forMod = (rule, props) => (props && props.subject && typeof props.subject === 'object' ? { ...props, subject: seenBy(props.subject, rule?.mod) } : props);
  const node = (R, rule, type, props) => R.createElement(boundaryOf(R, rules), { rule, ...(props?.key !== undefined ? { key: props.key } : {}) }, R.createElement(type, forMod(rule, props)));
  // The mods' panel views (mod-surfaces.md §3.1): the app's own tabs of the framework's kind, their views from the rules on SidePanel `tabs`.
  const panels = o.modPanels ?? null;
  const panelRules = () => { const off = new Set(rules.tripped()); return rules.all().filter((r) => r.kind === 'host' && r.presentation === 'SidePanel' && r.slot === 'tabs' && !off.has(`${r.mod}/${r.id}`)); };
  syncPanels = () => {
    try { panels?.setViews(panelRules()); } catch (e) { log('panel views could not be updated', { message: String(e?.message ?? e) }); }
    // a view in a modal goes with its registration: its view gone (the mod off, disposed) or registered again (another token) closes it;
    // the same registration told again (a rank changed, another window registered it) does not
    const sameRegistration = (a, b) => !!a && !!b && (typeof a.reg === 'string' || typeof b.reg === 'string' ? a.reg === b.reg : a === b);
    for (const [key, entry] of [...modalViews]) { const [m, v] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]; if (!sameRegistration(panels?.view(m, v)?.rule, entry.rule)) closeModalView(m, v); }
  };
  if (panels) {
    panelHost = {
      react, node: (rule, type, props) => node(react(), rule, type, props),
      useRoute,
      // the chat beside the panel as the graph names it, never raw route data
      threadOf: (route) => { const id = route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null; const ref = id ? threads.thread(id) : null; return ref ? Object.freeze({ type: ref.type, provider: ref.provider, id: ref.id }) : null; },
      // the Draft beside the panel: its chat's (by the app's id for it), the home page's or the panel page's new chat
      draftOf: (route) => {
        const kind = route && route.routeKind;
        if (kind === 'home') return Object.freeze({ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });
        if (kind === 'new-thread-panel') return Object.freeze({ type: 'Draft', provider: 'codex', id: 'new:app:panel-new-conversation' });
        const id = kind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null;
        return id && threads.thread(id) ? Object.freeze({ type: 'Draft', provider: 'codex', id: id.replace(/^local:/, '') }) : null;
      },
      // the window the panel is in, and the project it is about (public-hooks.md §3.14): its chat's, or the one the new chat targets
      windowOf: () => (instances ? instances.windowRef() : null),
      projectOf: (thread, draft) => {
        const plain = (x) => (x && typeof x === 'object' && typeof x.type === 'string' && typeof x.provider === 'string' && typeof x.id === 'string' ? Object.freeze({ type: x.type, provider: x.provider, id: x.id }) : null);
        const t = thread ? subject(thread) : null;
        if (t && !t.gone) return plain(t.links?.project);
        const d = draft ? subject(draft) : null;
        return d && !d.gone ? plain(d.state?.target?.project) : null;
      },
      openMod: (mod) => openFramework({ mod }),
      // the route scope a tab's page is in now (the presence record tells a close from a navigation by it)
      routeScope: () => routeScope(),
      // a hook: what a view is about (its chat, its Draft, its window, its project), as its mod may read them, computed where its reads are
      // followed (the route's mounts, the chat's and the Draft's instances), so it is drawn again as any changes; `route`: the route a tab
      // is beside, or none for a view above the route (a modal: the window's route now)
      useViewContext: (rule, route) => ctx.use(() => {
        if (route === undefined) for (const id of ROUTE_BINDINGS) ctx.mountsOf(id);
        const at = route === undefined ? routeScope()?.value ?? null : route;
        const host = panelHost;
        const thread = host.threadOf(at), draft = host.draftOf(at);
        // a ref its mod may read, else null (built review H7j-l): the project from each source it may read, on its own
        const may = (ref) => (ref && rule && whereEnvFor(rule).may({ ref }) ? ref : null);
        return Object.freeze({ thread: may(thread), draft: may(draft), window: may(host.windowOf()), project: may(host.projectOf(may(thread), may(draft))) });
      }),
      pageParts: () => { const R = react(); return R ? pageParts(R, kernel.exports ?? {}) : null; },
    };
    panels.attach(panelHost);
  }
  paletteSources = createPaletteSources({
    react, exports: exportsOf, guard: (rule, fn) => rules.guard(rule, fn), live: (rule) => rules.live(rule), log,
    env: (row) => Object.freeze({ subject: row?.ref ?? null, _presentation: null, window: instances ? instances.windowRef() : null, pane: null, thread: null, draft: null, via: 'palette' }),
    // a row that opens an instance: its own `open` (a chat, a project, an automation), as the user's choice
    open: (ref) => { invoke(ref, 'open', []).catch((e) => log('a palette row could not open its instance', { message: String(e?.message ?? e) })); },
    // a mod's row that names one of the app's commands, chosen by the user: their Command.run (held as one they run in the palette)
    runCommand: (id) => { try { commandRun(id, undefined, () => kernel.exports?.commandStack?.run?.(id)); } catch (e) { log('a palette row could not run the app\'s command', { id, message: String(e?.message ?? e) }); } },
  });
  const syncPalette = () => { const off = new Set(rules.tripped()); paletteSources.setSources(rules.all().filter((r) => r.kind === 'add' && r.presentation === 'Palette' && (r.slot === 'resultSources' || r.slot === 'groups') && !off.has(`${r.mod}/${r.id}`))); commandsSync(); };
  // The mods' commands (P5: ui.commands.add, both realms) as a group of the app's own palette: a Palette rule with its `command` is a row, its mod's name beside it,
  // read as the palette draws it (a command's `when` is asked then), run through the rule's guard while the rule is live (its keys are a hidden menu bar entry of the same call)
  const ruleCommands = () => {
    const off = new Set(rules.tripped());
    return rules.all().filter((r) => r.kind === 'add' && r.presentation === 'Palette' && (r.fns?.command ?? r.data?.command) && !off.has(`${r.mod}/${r.id}`));
  };
  const modName = (id) => { const m = subject({ type: 'Mod', provider: 'codexmods.framework', id }); return typeof m?.state?.name === 'string' && m.state.name ? m.state.name : id; };
  // the Host's word on the mods' themes, followed from the first read (H7y)
  let themeState = Object.freeze({ active: null }), themeSub = null;
  const themesNow = () => {
    if (!themeSub && typeof o.present?.themes === 'function') {
      try { themeSub = o.present.themes((s) => { themeState = s && typeof s === 'object' ? Object.freeze({ active: s.active ?? null }) : Object.freeze({ active: null }); bump(); }); } catch (e) { log('themes could not be followed', { message: String(e?.message ?? e) }); }
    }
    return themeState;
  };
  /**
   * Where a command is offered now (public-hooks.md §3.14): its `when` holds on this window, and, when it `appliesTo` a subject type, the
   * window shows one that its `where` keeps (read as its mod reads). `{subject}`: what its run is about; null: not offered.
   */
  const offeredHere = (r, c) => {
    if (!c.when && !c.appliesTo) return {};
    const win = instances ? subject(instances.windowRef()) : null;
    // its conditions read the window only as its mod may (a mod that may not read it: not offered)
    if (!win || win.gone || !whereEnvFor(r).may(win)) return null;
    try {
      if (c.when && compiledWhere(c.when).evaluate(win, whereEnvFor(r)) !== true) return null;
      if (!c.appliesTo) return {};
      const cur = win.state?.current ? subject(win.state.current) : null;
      if (!cur || cur.gone || !chainOf(cur.ref.type).includes(c.appliesTo) || !whereEnvFor(r).may(cur)) return null;
      if (c.where && compiledWhere(c.where).evaluate(cur, whereEnvFor(r)) !== true) return null;
      return { subject: cur.ref };
    } catch { return null; }
  };
  const commandsSync = () => {
    // the rule commands of a group (null: the mods' group), as offered now
    const ruleRows = (group) => ruleCommands().flatMap((r) => {
      const c = r.fns?.command ?? r.data.command;
      if ((typeof c.group === 'string' ? c.group : null) !== group) return [];
      const here = offeredHere(r, c);
      if (!here) return [];
      return [{ id: `rule:${r.mod}/${r.id}`, title: c.title, description: typeof c.description === 'string' ? `${modName(r.mod)} · ${c.description}` : modName(r.mod),
        keywords: [r.mod, r.id, ...(Array.isArray(c.keywords) ? c.keywords : [])], ...(typeof c.icon === 'string' ? { icon: c.icon } : {}),
        run: (env) => { if (rules.live(r) && typeof c.run === 'function') rules.guard(r, c.run)(here.subject ? { ...env, subject: here.subject } : env); } }];
    });
    const groups = [...new Set(ruleCommands().map((r) => (r.fns?.command ?? r.data.command).group).filter((g) => typeof g === 'string'))];
    // the commands and chats the mods hide (ui.hide('Command'), ui.hide('Thread')): a row for each mod hiding any now, its Show (both, in
    // this window: the chats as the sidebar's Show)
    const rows = typeof store.mounted === 'function' ? store.mounted().filter((r) => r?.binding === 'palette.command' || r?.binding === 'palette.chat').map((r) => r.n) : [];
    const hidden = hiddenCommandCounts(ctx, rows);
    paletteSources.setOwn([
      // the chats the app does not hold (graph-integrity G2.1: the palette's own search finds the app's), as the graph's search finds them
      ...(typeof graph.search === 'function' ? [{ key: 'codexmods.framework/chats', title: 'Agents\u2019 chats', items: [], search: (q) => searchChats(q) }] : []),
      ...(ruleCommands().some((r) => typeof (r.fns?.command ?? r.data.command).group !== 'string') ? [{ key: 'codexmods.framework/commands', title: 'Mod commands', items: () => ruleRows(null) }] : []),
      ...groups.map((g) => ({ key: `codexmods.framework/commands/${g}`, title: g, items: () => ruleRows(g) })),
      // the mods' named layouts (layouts.md D6): a row each, picking it here
      ...(layouts?.list().length ? [{ key: 'codexmods.framework/layouts', title: 'Layouts', items: () => [...(layouts?.list() ?? []).map((l) => ({ id: `layout:${l.key}`, title: l.title, description: modName(l.mod), keywords: [l.mod, l.id, 'layout'], run: () => { layouts.pick(l.key); } })),
        // the user's way back to the app's own (D6), while one is picked
        ...(layouts?.facts()?.picked ? [{ id: 'layout:app', title: 'The app\'s own layout', description: 'Ends the layout picked', keywords: ['layout', 'default'], run: () => { layouts.end(); } }] : [])] }] : []),
      // the mods' own pages (layouts.md D7): a row each, opening it here
      ...(mainPages?.list().length ? [{ key: 'codexmods.framework/pages', title: 'Pages', items: () => (mainPages?.list() ?? []).map((p) => ({ id: `page:${p.key}`, title: p.title, description: modName(p.mod), keywords: [p.mod, p.id, 'page'], run: () => { mainPages.open(p.mod, p.id); } })) }] : []),
      // its keywords are every term the hidden commands are found by: it is offered whenever one of them would have matched
      ...(hidden.length ? [{ key: 'codexmods.framework/hidden', title: 'Hidden', items: hidden.map(([mod, n, titles]) => ({ id: `show:${mod}`, title: `Show ${n} hidden by ${modName(mod)}`,
        keywords: ['hidden', mod, ...titles], run: () => { showHiddenCommands(ctx, mod); showHidden(ctx, mod); } })) }] : []),
    ]);
  };
  onHiddenCommands(ctx, () => commandsSync());
  // once per batch of rows mounting or unmounting (the palette opening, closing, filtering), while any command is hidden
  let commandsQueued = false;
  mountedCommands = () => {
    if (commandsQueued || !rules.all().some((r) => (r.presentation === 'Palette' || r.presentation === 'Sidebar') && r.slot === 'hidden')) return;
    commandsQueued = true;
    Promise.resolve().then(() => { commandsQueued = false; commandsSync(); });
  };
  commandsSync();
  slashItems = createSlashItems({
    react, exports: exportsOf, guard: (rule, fn) => rules.guard(rule, fn), live: (rule) => rules.live(rule), log,
    paneContext: () => (typeof kernel.paneContext === 'function' ? kernel.paneContext() : null),
    env: (draft, thread, pane) => Object.freeze({ subject: draft, _presentation: null, window: instances ? instances.windowRef() : null, pane: pane ?? 'route', thread, draft, via: 'slash' }),
    // a command's where on this composer's Draft, as its mod reads it (one not here yet, or not readable: not offered)
    offered: (rule, draft) => {
      const d = draft ? subject(draft) : null;
      if (!d || d.gone || !whereEnvFor(rule).may(d)) return false;
      try { return compiledWhere(rule.where).evaluate(d, whereEnvFor(rule)) === true; } catch { return false; }
    },
    // a prompt command: its text into the composer's Draft, as the user's choice
    insert: (draft, text) => { invoke(draft, 'insert', [{ parts: [{ kind: 'text', text }] }]).catch((e) => log('a slash prompt could not be inserted', { message: String(e?.message ?? e) })); },
  });
  const syncSlash = () => {
    const off = new Set(rules.tripped());
    const mine = rules.all().filter((r) => r.kind === 'add' && r.presentation === 'Palette' && r.for === 'Draft' && !off.has(`${r.mod}/${r.id}`));
    slashItems.setCommands(mine);
    mentionSources.setSources(mine);
    composerSuggestions.setSources(mine);
  };
  composerSuggestions = createComposerSuggestions({
    react, guard: (rule, fn) => rules.guard(rule, fn), live: (rule) => rules.live(rule), log,
    env: (draft, thread, pane) => Object.freeze({ subject: draft, _presentation: null, window: instances ? instances.windowRef() : null, pane: pane ?? 'route', thread, draft }),
  });
  mentionSources = createMentionSources({
    react, guard: (rule, fn) => rules.guard(rule, fn), live: (rule) => rules.live(rule), log,
    paneContext: () => (typeof kernel.paneContext === 'function' ? kernel.paneContext() : null),
    env: (draft, thread, pane) => Object.freeze({ subject: draft, _presentation: null, window: instances ? instances.windowRef() : null, pane: pane ?? 'route', thread, draft, via: 'mention' }),
    // a row with context picked: the Host keeps it for the next message from that composer's Draft (public-hooks.md §3.14)
    mentioned: (draft, entry) => { try { void Promise.resolve(o.present?.mentioned?.(draft, entry)).catch(() => {}); } catch { /* the Host keeps none: the message goes without it */ } },
    // the chats the mods hide (ui.hide('Thread')), as the sidebar's lists leave them out, and each mod's notice with its "Show" (in this
    // window); the list works them out in `use`, so a chat's state, the chat shown and a "Show" draw it again
    use: (compute) => use(compute),
    // a chat's summary (public-hooks.md §3.13): how its row reads in the list, and the chip it puts in the composer
    summary: (threadId) => threadSummary(thread(threadId)),
    hides: Object.freeze({
      by(threadId) {
        const parts = sidebarHides(ctx);
        if (!parts.length) return null;
        const ref = thread(threadId);
        const inst = ref ? ctx.subject(ref) : null;
        return inst && !inst.gone ? hiddenBy(ctx, parts, inst, openChats(ctx)) : null;
      },
      notice: (R, counts) => counts.map(([mod, n]) => {
        const text = `${n} hidden by ${modName(mod)}`;
        // a press keeps the focus in the composer: the list closes when it leaves, before the button's click would run
        return R.createElement('div', { key: `codexmods:hidden:${mod}`, 'data-codexmods': 'mention-hidden', 'data-codexmods-mod': mod, className: 'flex items-center gap-2 px-3 py-1 text-sm text-token-text-secondary',
          onMouseDown: (e) => { e.preventDefault(); } },
          R.createElement('span', { className: 'min-w-0 flex-1 truncate', title: text }, text),
          actionNode(R, ctx, { title: 'Show', run: () => showHidden(ctx, mod) }, `codexmods:mention-hidden-show:${mod}`));
      }),
    }),
  });
  // the panels' tab kinds, hidden and ordered (layouts.md §4.1; tab-kinds.mjs): their kind objects decorated once the registry is there
  const tabKinds = createTabKinds({ exports: () => kernel.exports, resolve: (p, inst) => rules.resolve(p, inst, chainOf, whereEnvFor), thread: (id) => ctx.thread(id),
    subject: (ref) => subject(ref), settled: (ref) => ctx.settled(ref), track, later: (fn, ms) => setTimeout(fn, ms), log: (m, d) => log(m, d) });
  tabKinds.arm();
  onTouched = (keys) => tabKinds.touched(keys);
  // the panels' launcher lists the mods' views (the launcher seam), without the kinds a mod hides there, in the order the mods declare
  const launcher = (list, opts) => tabKinds.launcher(panels ? panels.launcherItems(list, opts, routeScope) : list, opts, routeScope);
  store.launcher = launcher;
  // the window's space while an arrangement of the framework's is active (layouts.md D12, WL4d): the app's narrow-window handler asks it first
  const allocator = createAllocator({ ctx, exports: () => kernel.exports, around: (fn) => (layouts ? layouts.around(fn) : fn()), arranged: () => layouts?.holdsSizes() === true, back: () => layouts?.spaceReturned() });
  let layoutSizes = false;   // what the allocator last saw of a layout's sizes
  let layoutMode = null;     // and of the chat's mode: a tab filling the workspace takes no width of its own
  // the window's named layouts (layouts.md D5, D6, D11): one claim per window, its origins told apart
  layouts = createLayouts({ ctx, exports: () => kernel.exports, log,
    panelOp(id, op, args, node) {
      const key = node?.value?.conversationId ?? node?.value?.pathname;
      const rec = (typeof store.mounted === 'function' ? store.mounted() : []).find((m) => m?.binding === id && (m.scopeNode === node || (m.scopeNode?.value?.conversationId ?? m.scopeNode?.value?.pathname) === key));
      const f = bindingsById.get(id)?.operations?.[op];
      return rec && typeof f === 'function' ? f(rec.props, args, ctx, rec) : { unavailable: 'that panel is not drawn here' };
    },
    // that tab at the front of the panel asked: opened only when there is none; what was at the front said, to give back. The app's activate moves no focus
    openTab(node, kind, target) {
      const x = kernel.exports || {}, pc = x.panelControllers, reg = x.tabRegistry?.registry;
      const ctl = target === 'bottom' ? pc?.bottom : pc?.right, other = target === 'bottom' ? pc?.right : pc?.bottom;
      const front = (id, opened, was) => {
        if (typeof ctl?.activateTab !== 'function' || !ctl.activeTab$) return { id, opened, was };
        ctl.activateTab(node, id, { preserveFocus: true });
        const tab = node.get(ctl.activeTab$);
        return tab?.tabId === id ? { id, opened, was, ...(typeof tab.panelInstanceId === 'string' ? { instance: tab.panelInstanceId } : {}) } : { unavailable: `the tab ${kind} did not come to the front` };
      };
      const wasFront = () => { try { return (ctl?.activeTab$ ? node.get(ctl.activeTab$)?.tabId : null) ?? null; } catch { return null; } };
      if (kind.includes('/')) {
        const [mod, view] = [kind.slice(0, kind.indexOf('/')), kind.slice(kind.indexOf('/') + 1)];
        const props = panels?.propsOf(mod, view);
        if (!props) return { unavailable: `no view ${kind} in this window` };
        if (!panels.allows(panels.view(mod, view), target)) return { unavailable: `the view ${kind} does not open in that panel` };
        const id = tabKeyOf(mod, view), was = wasFront();
        const there = (c) => { try { return !!c?.tabById$ && node.get(c.tabById$, id) != null; } catch { return false; } };
        if (there(ctl)) return front(id, false, was);
        if (there(other)) return { unavailable: `the view ${kind} is open in the other panel` };
        return panels.openIn(node, props, { target, revealAndFocus: false }) ? front(id, true, was) : { unavailable: `the view ${kind} did not open` };
      }
      const type = typeof reg?.get === 'function' ? reg.get(kind) : null;
      if (!type || !pc?.openTab) return { unavailable: `no tab kind ${kind} here` };
      if (target === 'bottom' && !type.dropDestinations?.includes?.('bottom')) return { unavailable: `the tab kind ${kind} does not go in the bottom panel` };
      try { if (typeof type.isAvailable === 'function' && !type.isAvailable(node)) return { unavailable: `the tab kind ${kind} is not available here` }; } catch { /* the app's to say when it opens */ }
      const was = wasFront();
      const open = (node.get(ctl.tabs$) ?? []).find((t) => t?.tabType === type);
      if (open) return front(open.tabId, false, was);
      const id = pc.openTab(node, type, { target, revealAndFocus: false });
      return typeof id === 'string' ? front(id, true, was) : true;
    },
    // what openTab did, undone, where it is still as it left it: what was at the front back there if its tab still is, a tab it opened closed (the app's close, which may ask) if it is that very tab
    giveTab(node, tab) {
      const pc = (kernel.exports || {}).panelControllers, ctl = tab.target === 'bottom' ? pc?.bottom : pc?.right;
      if (!ctl) return;
      const there = ctl.tabById$ ? node.get(ctl.tabById$, tab.id) : null;
      if (tab.was && node.get(ctl.activeTab$)?.tabId === tab.id && typeof ctl.activateTab === 'function' && (!ctl.tabById$ || node.get(ctl.tabById$, tab.was) != null)) ctl.activateTab(node, tab.was, { preserveFocus: true });
      if (tab.opened && typeof ctl.closeTab === 'function' && there != null && (!tab.instance || there.panelInstanceId === tab.instance)) ctl.closeTab(node, tab.id);
    },
    frontTab(node, target) {
      const pc = (kernel.exports || {}).panelControllers, ctl = target === 'bottom' ? pc?.bottom : pc?.right;
      try { return (ctl?.activeTab$ ? node.get(ctl.activeTab$)?.tabId : null) ?? null; } catch { return null; }
    },
    ruleOf: (mod) => rules.all().find((r) => r.mod === mod),
    space: allocator,
    openPage(key) { const i = key.indexOf('/'); return mainPages?.open(key.slice(0, i), key.slice(i + 1)) === true; },
    changed() {
      if (rules.all().some((r) => r.where && typeof r.where.window === 'object')) { bump(); syncMainPages(); destinations?.rulesChanged(); }
      instances?.touch?.();
      const sizes = layouts?.holdsSizes() === true, mode = layouts?.modeNow() ?? null;
      if (sizes !== layoutSizes || mode !== layoutMode) { layoutSizes = sizes; layoutMode = mode; allocator.rearranged(); }
    },
    startsWith: () => switches?.defaultLayout() ?? null,
  });
  switches = createLayoutSwitches({ changed: () => { ctx.local?.touch?.(SWITCHES_KEY); bump(); syncMainPages(); destinations?.rulesChanged(); layouts.rulesChanged(); commandsSync(); } });
  layoutPicker = createLayoutPicker({ ctx, exports: () => kernel.exports, layouts: () => layouts, contextKey: LAYOUT_CONTEXT });
  const responsiveHook = (arg) => { layouts.resizing(); return allocator.handle(arg.width, arg.scope); };
  store.responsive = responsiveHook;
  /** A route scope of this window to open a tab in: one a mounted binding holds, the route's own first. */
  const ROUTE_BINDINGS = ['thread.layout', 'side.panel', 'side.panel.strip', 'thread.header', 'panel.tab'];
  /** Whether the workspace the window shows says this layout, within a few seconds (a page the app keeps for later stays mounted,
   *  hidden: the shown one's, as the window's facts read it). */
  async function shownLayout(mode) {
    const d = globalThis.document;
    if (typeof d?.querySelectorAll !== 'function') return true;   // no page to read (a test's): taken as set
    const says = () => [...d.querySelectorAll('[data-app-shell-workspace-layout]')].find((n) => (typeof n.checkVisibility === 'function' ? n.checkVisibility() : true))
      ?.getAttribute('data-app-shell-workspace-layout') === mode;
    for (let i = 0; i < 30 && !says(); i++) await new Promise((r) => { setTimeout(r, 100); });
    return says();
  }
  function routeScope() {
    if (typeof store.mounted !== 'function') return null;
    const recs = store.mounted().filter((rec) => rec?.scopeNode && !rec.pane && typeof rec.scopeNode.get === 'function');
    return (ROUTE_BINDINGS.map((id) => recs.find((rec) => rec.binding === id)).find(Boolean) ?? recs[0])?.scopeNode ?? null;
  }
  /**
   * The rules for a presentation the framework renders itself (its DetailView of an instance it does not own, E7.6): whether a claim hides
   * it or a mod's component replaces it, each slot's hosted regions, and the actions (decorate's and add's to `actions`); null when no rule
   * of the presentation is in the window. The caller asks only for a subject the framework does not own (E6 decision 6).
   */
  function ruled(presentation, inst) {
    const R = react();
    if (!R || !rules.has(presentation)) return null;
    const r = rules.resolve(presentation, inst, chainOf, whereEnvFor);
    const rec = () => (instances && inst?.ref ? instances.find(presentation, inst.ref) : null);
    const out = { hidden: r.claim?.kind === 'hide', replace: null, regions: {}, actions: [], parts: r.parts };
    if (r.claim && r.claim.kind !== 'hide' && typeof r.claim.fns?.render === 'function') out.replace = node(R, r.claim, r.claim.fns.render, { subject: inst, native: null, decorations: [] });
    for (const [slot, hosted] of r.regions) out.regions[slot] = hosted.map((h) => node(R, h, h.fns?.render ?? Hidden, { key: `${h.mod}/${h.id}`, subject: inst }));
    const push = (rule, items) => (Array.isArray(items) ? items : []).forEach((item, i) => {
      if (item && typeof item.title === 'string') out.actions.push({ key: `codexmods:${rule.mod}/${rule.id}/${item.id ?? i}`, title: item.title, run: acting(rec, rule, item.id ?? i, rules.guard(rule, typeof item.run === 'function' ? item.run : () => {}), inst) });
    });
    for (const d of r.decorations) if (!d.slot || d.slot === 'actions') push(d, valueOf(rules, d, 'actions', inst));
    for (const a of r.adds.get('actions') ?? []) push(a, valueOf(rules, a, 'items', inst));
    return out;
  }

  /**
   * Apply the rules for one presentation instance: a claim gives the element (hidden, or the winning mod's component); otherwise the
   * binding's slots take the decorations, the added items, the reorders and the hosted regions, as new props. A twin (`slotsOnly`: another
   * presentation the component also realizes) takes its slots only: its claims belong to the component that presents it.
   */
  /**
   * The app's parts a binding draws, with the part rules given (public-hooks.md §3.10): a hidden part the binding is ('self', or a function
   * giving null for these props) is not drawn at all ({element}); another is taken out of its props ({props}). A part the binding relabels
   * (`relabelParts`: the component that draws its text, layouts.md D3) takes the first decorate rule's label and tooltip on it.
   */
  function partsApplied(b, partRules, props, factory, inst) {
    let next = props;
    if (!partRules.length) return { props: next };
    const hidden = new Set(partRules.filter((x) => x.kind === 'hide').flatMap((x) => x.part ?? []));
    for (const [name, how] of Object.entries(b.appParts ?? {})) {
      if (!hidden.has(name)) continue;
      if (how === 'self') return { element: factory(Hidden, {}) };
      let out;
      try { out = how(next, { R: react(), ctx, inst }); } catch (e) { log('a part could not be hidden', { binding: b.id, part: name, message: String(e?.message ?? e) }); out = next; }
      if (out === null) return { element: factory(Hidden, {}) };
      next = out ?? next;
    }
    const labels = new Map();
    for (const r of partRules) if (r.kind === 'decorate') for (const n of r.part ?? []) if (!labels.has(n)) labels.set(n, r);
    for (const [name, how] of Object.entries(b.relabelParts ?? {})) {
      const r = labels.get(name);
      if (!r || hidden.has(name)) continue;
      const text = (field) => { const v = valueOf(rules, r, field, inst); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      const label = text('label'), tooltip = text('tooltip');
      if (label === undefined && tooltip === undefined) continue;
      try { next = how(next, { label, tooltip }, { R: react(), ctx, inst }) ?? next; } catch (e) { log('a part could not be relabelled', { binding: b.id, part: name, message: String(e?.message ?? e) }); }
    }
    return { props: next };
  }
  function applyRules(b, Original, props, factory, inst, rec, slotsOnly = false) {
    const R = react();
    if (!R) return {};
    const r = rules.resolve(b.presentation, inst, chainOf, whereEnvFor);
    // what holds what no claim may take (a sidebar group with a chat that needs the user): drawn as the app draws it, its slots still the mods'
    let keeps = false;
    if (r.claim && !slotsOnly && typeof b.keeps === 'function') { try { keeps = b.keeps(props, ctx) === true; } catch { keeps = true; } }
    if (r.claim && !slotsOnly && !keeps) {
      if (r.claim.kind === 'hide' && RECORDS.has(b.presentation) && inst?.ref) {
        read(`local:hidden:${recordKey(b.presentation, inst)}`);
        if (recordHidden(b.presentation, inst)) return { element: stubOf(R, b, r.claim, inst) };
      } else if (r.claim.kind === 'hide') return { element: factory(Hidden, {}) };
      const Comp = r.claim.fns?.render;
      if (typeof Comp === 'function') {
        const decorations = r.decorations.map((d) => ({ mod: d.mod, id: d.id, badges: valueOf(rules, d, 'badges', inst), label: valueOf(rules, d, 'label', inst), tooltip: valueOf(rules, d, 'tooltip', inst) }));
        return { element: node(R, r.claim, Comp, { subject: inst, pane: rec?.pane ?? 'route', native: factory(Original, props), decorations }) };
      }
    }
    let next = props;
    // The app's own parts this binding draws (public-hooks.md §3.10), hidden before the slots take the mods' entries.
    if ((b.appParts || b.relabelParts) && !b.appPartsOf) {
      const hid = partsApplied(b, r.parts, next, factory, inst);
      if (hid.element !== undefined) return hid;
      next = hid.props;
    }
    for (const [name, slot] of Object.entries(b.slots ?? {})) {
      try {
        if (slot.kind === 'external') continue;
        if (slot.kind === 'region') {
          const hosted = [...(r.regions.get(name) ?? []), ...(name === 'body' && r.render ? [r.render] : [])];
          if (!hosted.length) continue;
          next = slot.apply(next, hosted.map((h) => node(R, h, h.fns?.render ?? Hidden, { key: `${h.mod}/${h.id}`, subject: inst, pane: rec?.pane ?? 'route' })), { R, factory, inst, ctx, node: (rule, type, props) => node(R, rule, type, props) });
          continue;
        }
        let items = [];
        for (const d of r.decorations) {
          if (d.slot && d.slot !== name) continue;
          const v = valueOf(rules, d, slot.field ?? name, inst);
          if (v === undefined || v === null) continue;
          for (const item of Array.isArray(v) ? v : [v]) items.push({ rule: d, item });
        }
        for (const a of r.adds.get(name) ?? []) {
          const v = valueOf(rules, a, 'items', inst);
          for (const item of Array.isArray(v) ? v : []) items.push({ rule: a, item });
        }
        // Reorders run last, on the composed list (S7): the app's entries (frozen markers {native: true, index}) with the mods'; an order
        // that is not a permutation of what it was given is ignored.
        const natives = typeof slot.native === 'function' ? slot.native(next) : 0;
        let seq = null;
        // a slot whose values are no one else's to see (a summary: one mod's text, its live text read as that mod) is never reordered
        const reorders = slot.private ? [] : (r.reorders.get(name) ?? []).filter((ro) => typeof ro.fns?.order === 'function');
        // the app's own entries alone are reordered too (two or more of them), not only a composed list with the mods'
        if (reorders.length && (items.length || natives > 1)) {
          seq = [...Array.from({ length: natives }, (_, index) => ({ marker: Object.freeze({ native: true, index }) })), ...items];
          // a reorder sees the app's entries and its own mod's, nothing of another mod's (not its data, not that it is there: a private
          // condition decides that; built review H7j-l, round 2): those keep their places, the ones it sees are reordered among theirs
          for (const ro of reorders) {
            const visible = seq.map((x, i) => [x, i]).filter(([x]) => x.marker || x.rule.mod === ro.mod);
            const given = visible.map(([x]) => x.marker ?? x.item);
            const out = rules.guard(ro, ro.fns.order)(given);
            const used = new Set();
            const picks = Array.isArray(out) && out.length === given.length ? out.map((v) => { const i = given.findIndex((g, j) => g === v && !used.has(j)); if (i >= 0) used.add(i); return i; }) : null;
            if (picks && picks.every((i) => i >= 0)) {
              const next = [...seq];
              visible.forEach(([, at], k) => { next[at] = visible[picks[k]][0]; });
              seq = next;
            } else log('a reorder was ignored: not a permutation of its slot', { slot: `${b.id}.${name}`, rule: `${ro.mod}/${ro.id}` });
          }
          items = seq.filter((x) => !x.marker);
        }
        if (!items.length && !(seq && natives > 1)) continue;
        const { kept, dropped } = budgeted(items, natives, slot.budget);
        if (dropped.length) log('a slot is full: entries left out', { slot: `${b.id}.${name}`, dropped: dropped.map((x) => `${x.rule.mod}/${x.rule.id}`) });
        // A callback an entry hands the app is guarded: a throw trips its rule alone. The user running it is an action on this presentation.
        const guarded = kept.map((x) => ({ ...x, item: x.item && typeof x.item === 'object' && typeof x.item.run === 'function' ? { ...x.item, run: acting(rec, x.rule, x.item.id, rules.guard(x.rule, x.item.run), inst) } : x.item }));
        // The composed order, for the entries kept: the app's at the places the reorders gave them.
        const order = seq ? seq.flatMap((x) => (x.marker ? [{ native: x.marker.index }] : kept.includes(x) ? [{ entry: kept.indexOf(x) }] : [])) : undefined;
        // `node`: a mod's component in its rule's boundary (a declaration whose entry is drawn by the framework around the mod's own)
        next = slot.apply(next, guarded, { R, factory, inst, ctx, node: (rule, type, props) => node(R, rule, type, props) }, order);
      } catch (e) { log('a slot could not be applied', { slot: `${b.id}.${name}`, message: String(e?.message ?? e) }); }
    }
    return { props: next };
  }

  const mine = [];
  // Per binding: how often it matched, and how often its subject resolved (the probe report says which bindings work on this build).
  const stats = new Map();
  for (const b of o.bindings ?? []) {
    if (!b || typeof b.id !== 'string' || (typeof b.render !== 'function' && typeof b.subject !== 'function' && !b.twins?.length) || !armed.has(b.id)) continue;
    const s = { matched: 0, subjects: 0, found: false, applied: false };
    stats.set(b.id, s);
    // `near`: the nearest site a binding that reads one is under (its binding and props), from the kernel
    const render = (Original, props, factory, rec, scope, near) => {
      if (tripped.has(b.id)) return undefined;
      s.matched++;
      // The mods' rules for this presentation (E2): its subject is read only when a rule may apply, so a presentation without rules
      // costs what it did before.
      let ruled = b.presentation && rules.has(b.presentation);
      // the transcript's filters on in this window (public-hooks.md §3.12), when the record is one
      const filters = !b.part && TRANSCRIPT.has(b.presentation) && rules.has('ThreadView') ? declaredFilters(ctx, 'ThreadView') : [];
      let inst = null;
      if (b.subject) {
        const ref = b.subject(props, ctx, scope, near);
        if (ref) {
          s.subjects++;
          // Until one is found, the subject is looked up in the graph: a binding counts as working when it names an instance that exists.
          if (!s.found || ruled || filters.length) { const got = subject(ref); if (got && !got.gone) { s.found = true; inst = got; } }
        }
        // a binding that is its presentation only where it names a subject the graph has (a host every tab's body passes through): elsewhere
        // none of that presentation's rules are its (H7x review 1)
        if (b.subjectOnly && !inst) ruled = false;
      }
      // a record the filters do not keep is not drawn (it keeps its place in the app's list); one under way always is
      if (filters.length && inst && filtered(filters, inst)) { s.applied = true; return factory(Hidden, {}); }
      let next = props;
      // A binding that draws another presentation's parts (the model menu is a part of its Composer): that presentation's part rules,
      // for the subject it sits under (its place's `on`)
      if (b.appPartsOf && rules.has(b.appPartsOf)) {
        const host = b.appPartsSubject ? { in: b.appPartsOf, on: b.appPartsSubject(props, ctx, scope) } : typeof b.place === 'function' ? b.place(props, scope) : b.place;
        if (host && host.in === b.appPartsOf) {
          const got = host.on ? subject(host.on) : null;
          const hid = partsApplied(b, rules.resolve(b.appPartsOf, got && !got.gone ? got : null, chainOf, whereEnvFor).parts, next, factory, got);
          if (hid.element !== undefined) { s.applied = true; return hid.element; }
          next = hid.props;
        }
      }
      if (ruled) {
        const applied = applyRules(b, Original, next, factory, inst, rec, b.part === true);
        if (applied.element !== undefined) { s.applied = true; return applied.element; }
        if (applied.props && applied.props !== props) { s.applied = true; next = applied.props; }
      }
      // The twins (E7): another presentation this component also realizes (the final answer's action row and what follows it are its
      // turn's), whose rules take its slots here, never a claim; a user's action on one of their entries is that presentation's.
      for (const t of b.twins ?? []) {
        if (!rules.has(t.presentation)) continue;
        const ref = t.subject(props, ctx, scope, near);
        if (!ref) continue;
        const got = subject(ref);
        const applied = applyRules(t, Original, next, factory, got && !got.gone ? got : null, () => instances?.find(t.presentation, ref) ?? null, true);
        if (applied.props && applied.props !== next) { s.applied = true; next = applied.props; }
      }
      if (next !== props) {
        const out = b.render ? b.render(Original, next, factory, ctx, scope, near, rec) : undefined;
        return out !== undefined ? out : factory(Original, next);
      }
      return b.render ? b.render(Original, props, factory, ctx, scope, near, rec) : undefined;
    };
    store.renderers.set(b.id, render);
    mine.push([b.id, render]);
  }
  // The mods' entries in a thread's menus, after the app's own, each rule's one group (Menu, slot `groups`: decorate's actions and add's
  // items; E7.3). A sidebar row's menu also takes the SidebarItem's rules for its `contextMenu`. The app's menu items carry intl
  // descriptors, never strings (a plain string took a window down, batch 5 P10).
  /**
   * The mods' groups for a menu of `inst`: each rule's items one group, from the presentations and slots `sources` names. `named`: only rules
   * that name their subject's type (`for`): a rule written for every Menu before files had menus stays a thread's.
   */
  const menuGroups = (inst, on, sources, named = false) => {
    const groups = [];
    const group = (rule, items) => {
      const out = [];
      (Array.isArray(items) ? items : []).forEach((item, i) => {
        if (!item || typeof item.title !== 'string') return;
        const id = `codexmods:${rule.mod}/${rule.id}/${item.id ?? i}`;
        out.push({ id, message: { id, defaultMessage: item.title, description: `${rule.mod}: a mod's menu entry` }, onSelect: acting(on, rule, item.id ?? i, rules.guard(rule, typeof item.run === 'function' ? item.run : () => {}), inst, 'menu') });
      });
      if (out.length) groups.push(out);
    };
    const from = (presentation, slot, slotOnly) => {
      if (!rules.has(presentation)) return;
      const r = rules.resolve(presentation, inst, chainOf, whereEnvFor);
      const keep = (x) => !named || presentation !== 'Menu' || typeof x.for === 'string';
      for (const d of r.decorations) if ((d.slot === slot || (!slotOnly && !d.slot)) && keep(d)) group(d, valueOf(rules, d, 'actions', inst));
      for (const a of r.adds.get(slot) ?? []) if (keep(a)) group(a, valueOf(rules, a, 'items', inst));
    };
    for (const [presentation, slot, slotOnly] of sources) from(presentation, slot, slotOnly);
    return groups;
  };
  const menuEntries = (args) => {
    const row = args && args.surface === 'sidebar';
    if (!rules.has('Menu') && !(row && rules.has('SidebarItem'))) return [];
    const ref = threads.thread(args && args.target ? args.target.conversationId : null);
    const inst = ref ? subject(ref) ?? null : null;
    // Chosen from a row's menu, it acts on that row; from the thread's own menu, on the thread's Menu.
    const on = instances && ref ? instances.find(row ? 'SidebarItem' : 'Menu', ref) : null;
    // a row's own decorations go to its other slots; only those aimed here
    return menuGroups(inst, on, [['Menu', 'groups', false], ...(row ? [['SidebarItem', 'contextMenu', true]] : [])]);
  };
  /**
   * A file or folder row's menu (the file-menu seam, mod-surfaces.md §3.5, E8.7): its subject the row's path (a File, or a Folder when it
   * ends with "/"), matched by its type when the graph does not hold it yet. Every file tree's row is a FilesView row (`rowActions`); a
   * row whose file the shown chat's Changes list lists is also a ChangesView file row (`fileRowActions`, for its FileChange) (E8.9: the
   * Changes and Files tabs draw the same tree, and its menu builder is told no more).
   */
  const fileMenuEntries = (args) => {
    const path = args && typeof args.targetPath === 'string' && args.targetPath.startsWith('/') ? args.targetPath : null;
    if (!path || !(rules.has('Menu') || rules.has('FilesView') || rules.has('ChangesView'))) return [];
    const folder = path.length > 1 && path.endsWith('/');
    const ref = { type: folder ? 'Folder' : 'File', provider: 'codex', id: folder ? path.replace(/\/+$/, '') : path };
    const got = subject(ref);
    const inst = got && !got.gone ? got : { ref, state: {}, links: {} };
    const groups = menuGroups(inst, null, [['Menu', 'groups', false], ['FilesView', 'rowActions', true]], true);
    const change = !folder && rules.has('ChangesView') ? changeOf(path) : null;
    // the chat's FileChange when it changed the file, else the File: the Changes tab also lists the repository's own changes (E8 third
    // review: never a FileChange the graph does not have)
    return change !== null ? [...groups, ...menuGroups(change || inst, null, [['ChangesView', 'fileRowActions', true]], true)] : groups;
  };
  /** For a file the shown chat's Changes list (its `changes.files` mount) lists: the chat's FileChange of it when the graph has one, else
   *  false; null for a file that list does not show. */
  function changeOf(path) {
    const route = routeScope()?.value ?? null;
    const id = route && route.routeKind === 'local-thread' && typeof route.conversationId === 'string' ? route.conversationId : null;
    const t = id ? threads.thread(id) : null;
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own store
    if (!t || t.provider !== 'codex' || typeof store.mounted !== 'function') return null;
    const listed = store.mounted().some((rec) => rec?.binding === 'changes.files' && rec.scope?.conversationId === id
      && Array.isArray(rec.props?.entries) && rec.props.entries.some((x) => x && x.path === path));
    if (!listed) return null;
    const got = subject({ type: 'FileChange', provider: 'codex', id: `thread:${t.id}:${path}` });
    return got && !got.gone ? got : false;
  }
  /** A project's menu (its sidebar row's "..." and right-click, E8.7b): the mods' groups for the Project after the app's items. */
  function projectMenu(ref, items) {
    if (!Array.isArray(items) || !rules.has('Menu')) return items;
    const got = subject(ref);
    const inst = got && !got.gone ? got : { ref, state: {}, links: {} };
    let own;
    try { own = withParts(items, rules.resolve('Menu', inst, chainOf, whereEnvFor).parts); } catch { own = items; }
    return withGroups(own, menuGroups(inst, null, [['Menu', 'groups', false]], true));
  }
  /** An absolute path with `.` and `..` resolved, or null when it climbs above the root. */
  function normalPath(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
    }
    return `/${out.join('/')}${p.endsWith('/') && out.length ? '/' : ''}`;
  }
  /** A subject's menu drawn by its own component (E8.9: a scheduled task's "..." menu): the mods' groups for its type, as entries. */
  /**
   * A chat's summary (decorate's `summary` on Thread, public-hooks.md §3.13) as its sidebar row's rules give it, `{title?, subtitle?,
   * icon?}` or null: for the places that list a chat outside the sidebar (the palette's rows, the "@" list's), which read it the same way.
   * Read: what reads it renders again when the rules or the chat change.
   */
  function threadSummary(ref) {
    if (!ref || !rules.has('SidebarItem')) return null;
    const inst = subject(ref);
    if (!inst || inst.gone) return null;
    const r = rules.resolve('SidebarItem', inst, chainOf, whereEnvFor);
    const entries = [];
    for (const d of r.decorations) {
      if (d.slot && d.slot !== 'summary') continue;
      const item = valueOf(rules, d, 'summary', inst);
      if (item !== undefined && item !== null) entries.push({ item });
    }
    return summaryOf(entries);
  }
  /**
   * A chat's badges (decorate's `badges` on Thread) as its sidebar row's rules give them, for a row the framework draws (a chat the app does
   * not hold: graph-integrity G2.2, a subtype's marks in the shared surfaces): `[{key, item}]`, at most four, as the app's rows take them.
   * Read: what reads them renders again when the rules or the chat change.
   */
  function threadBadges(ref) {
    if (!ref || !rules.has('SidebarItem')) return [];
    const inst = subject(ref);
    if (!inst || inst.gone) return [];
    const out = [];
    for (const d of rules.resolve('SidebarItem', inst, chainOf, whereEnvFor).decorations) {
      if (d.slot && d.slot !== 'badges') continue;
      const list = valueOf(rules, d, 'badges', inst);
      if (!Array.isArray(list)) continue;
      list.forEach((item, i) => { if (item && typeof item === 'object' && out.length < 4) out.push({ key: `codexmods:${d.mod}/${d.id}/${item.id ?? i}`, item }); });
    }
    return out;
  }
  function subjectMenu(ref) {
    if (!rules.has('Menu')) return [];
    const got = subject(ref);
    const inst = got && !got.gone ? got : { ref, state: {}, links: {} };
    return menuGroups(inst, null, [['Menu', 'groups', false]], true);
  }
  /** The mods' rules on a thread menu's own entries (public-hooks.md §3.10): the Menu's part rules for its thread. */
  const menuParts = (args) => {
    if (!rules.has('Menu')) return [];
    const ref = threads.thread(args && args.target ? args.target.conversationId : null);
    const inst = ref ? subject(ref) ?? null : null;
    return inst ? rules.resolve('Menu', inst, chainOf, whereEnvFor).parts : [];
  };
  const menus = threadMenus(menuEntries, menuParts);
  /**
   * A file referenced anywhere else (E8.7b: a chip, a link in a message, a file tab, an attachment; the workspace-file menu seam): its
   * subject the reference's path (made absolute with its cwd), a Folder for a workspace reference; the Menu rules that name that type.
   */
  const workspaceFileEntries = (args) => {
    if (!args || typeof args.path !== 'string' || !args.path || !rules.has('Menu')) return [];
    // a file of another host (a remote project) is not this Mac's: no File of the graph names it (E8 third review)
    if (args.hostId != null && args.hostId !== 'local') return [];
    const joined = args.path.startsWith('/') ? args.path : typeof args.cwd === 'string' && args.cwd.startsWith('/') ? `${args.cwd.replace(/\/+$/, '')}/${args.path}` : null;
    const abs = joined ? normalPath(joined) : null;
    if (!abs) return [];
    const folder = args.openMode === 'workspace' || abs.endsWith('/');
    const ref = { type: folder ? 'Folder' : 'File', provider: 'codex', id: folder ? abs.replace(/\/+$/, '') || '/' : abs };
    const got = subject(ref);
    const inst = got && !got.gone ? got : { ref, state: {}, links: {} };
    return menuGroups(inst, null, [['Menu', 'groups', false]], true);
  };
  /**
   * A panel tab's menu (E8.7b, the tab menu seam): a file's tab is its File (the workspace-file rules); any other tab is a PanelTab of its
   * kind (the app's tab type: 'file', 'browser', 'terminal', a mod's 'codexmods', ...), for the Menu rules that name PanelTab.
   */
  const FILE_TABS = new Set(['workspace-file', 'text-file-editor']);   // 21477's file tabs (their props: path, hostId)
  const tabEntries = (args) => {
    if (!args || !args.tab || typeof args.tab.tabId !== 'string' || !rules.has('Menu')) return [];
    let shown;
    try { shown = args.scope && args.controller && typeof args.scope.get === 'function' ? args.scope.get(args.controller.presentedTabById$, args.tab.tabId) ?? null : null; } catch { shown = null; }
    const kind = typeof shown?.tabType?.kind === 'string' ? shown.tabType.kind : null;
    const props = shown?.props && typeof shown.props === 'object' ? shown.props : {};
    if ((FILE_TABS.has(kind) || kind?.startsWith('workspaceFile:')) && typeof props.path === 'string') return workspaceFileEntries({ path: props.path, cwd: props.cwd, hostId: props.hostId });
    // any other tab: the PanelTab the page reports for it (its tab's label mount), the instance the graph has (E8 third review)
    const rec = typeof store.mounted === 'function' ? store.mounted().find((r) => r?.binding === 'panel.tab' && r.props?.tab?.tabId === args.tab.tabId) ?? null : null;
    const ref = rec && instances ? instances.refOf(rec) : null;
    if (!ref) return [];
    return menuGroups({ ref, state: { kind: kind ?? 'unknown' }, links: {} }, rec, [['Menu', 'groups', false]], true);
  };
  const menusHook = (args, items, kind) => {
    const out = kind === 'file-tree' ? withGroups(items, fileMenuEntries(args)) : kind === 'workspace-file' ? withGroups(items, workspaceFileEntries(args))
      : kind === 'tab' ? withGroups(items, tabEntries(args)) : menus(args, items);
    // the mods' choices of external apps in the menus' "Open in" entries (public-hooks.md §3.11)
    // what the menu was opened on, for a mod's entry's run: the chat (a thread menu's), or the file's path
    const subjectRef = threads.thread(args?.target?.conversationId ?? null);
    const env = { subject: subjectRef ?? null, ...(typeof args?.path === 'string' ? { path: args.path } : {}) };
    try { return withOpenIn(out, choicesPlan(ctx, 'ExternalApp', 'menus'), env); } catch { return out; }
  };
  store.menus = menusHook;

  // The mods' part renderers (mod-surfaces.md §3.3): the kernel's markdown part wrappers and default directives ask them; a markdown site's
  // subject is its binding's.
  const content = createContent({
    react, rules, chainOf, onConflict: (loser, winner) => lostClaim(loser, winner),
    site: () => (typeof kernel.markdownSite === 'function' ? kernel.markdownSite() : null),
    use: (compute) => use(compute),
    subjectOf: (at) => { const b = at ? bindingsById.get(at.binding) : null; return b && typeof b.subject === 'function' ? b.subject(at.props ?? {}, ctx) ?? null : null; },
    instance: (ref) => { const got = subject(ref); return got && !got.gone ? got : null; },
    threadOf: (id) => thread(id),
    // content reaches a rule only where its mod may read the content's subject (built review H7u)
    may: (rule, x) => whereEnvFor(rule).may(x),
    whereEnv: (rule) => whereEnvFor(rule),
  });
  // What the app copies (the copy seam, F3): a chat's content is masked by the mods' redactions of that chat; anything else (a path, a
  // link, a setting) is copied as it is. Where a copy is from:
  // - a thread action's copy says, with its own call (seam copy-origin): "Copy as Markdown" is its chat's, the chat's folder and link are
  //   not a chat's content (the menus, the palette and the keys run these actions);
  // - else a command the page's dispatcher runs that copies what is not a chat's content (COPY_NOT_CONTENT), as it runs;
  // - else the place it was asked at (the kernel's: a floating layer's is where it was opened from): the chats its element and its
  //   selection's ranges are in (a turn's element, `data-turn-key`: every turn a range touches); out of any transcript (but the palette),
  //   not a chat's content; a layer opened from nowhere known, any chat's (every rule);
  // - else (a key, the palette, no gesture) the chat the window shows, if any (masking more is the safe way).
  const elementOf = (node) => (node && node.nodeType === 1 ? node : node?.parentElement ?? null);
  /** A transcript element's chat: its turn's thread (null: a chat's, not known which), or undefined when it is not in a transcript. */
  const turnChat = (el) => {
    const turnEl = el?.closest?.('[data-turn-key]');
    if (!turnEl) return undefined;
    const m = /(?:^|:)turn:([^:]+)$/.exec(turnEl.getAttribute('data-turn-key') ?? '');
    const t = m ? subject({ type: 'Turn', provider: 'codex', id: m[1] }) : null;
    return t && !t.gone && t.links?.thread ? t.links.thread : null;
  };
  const shownChat = () => { const win = instances ? subject(instances.windowRef()) : null; return win && !win.gone ? win.links?.thread ?? null : null; };
  /** The chats a place is in (its element's turn's, and every turn its ranges touch; null: a chat's, not known which), or undefined: none. */
  const turnsOf = (place) => {
    const out = new Set(); let any = false;
    const add = (el) => { const c = turnChat(el); if (c !== undefined) { any = true; out.add(c); } };
    add(elementOf(place.target));
    if (Array.isArray(place.ranges) && place.ranges.length) {
      const doc = elementOf(place.target)?.ownerDocument ?? globalThis.document;
      const turns = doc?.querySelectorAll ? [...doc.querySelectorAll('[data-turn-key]')] : [];
      for (const r of place.ranges) for (const el of turns) { try { if (r.intersectsNode(el)) add(el); } catch { /* a range of another document */ } }
    }
    return any ? [...out] : undefined;
  };
  /** The chats a copy is of (null in it: a chat's, not known which), or null: not a chat's content. */
  function copySource(place, origin) {
    if (origin) {
      if (origin.content === false) return null;
      if (typeof origin.chat === 'string' && origin.chat) return [threads.thread(origin.chat) ?? null];
    }
    if (commandNow !== null && COPY_NOT_CONTENT.has(commandNow)) return null;
    const el = place ? elementOf(place.target) : null;
    if (el && !el.closest?.('[cmdk-root]')) return turnsOf(place) ?? null;
    if (place?.layer) return [null];
    const shown = shownChat();
    return shown ? [shown] : null;
  }
  const copyHook = (copied, place, origin) => { const chats = copySource(place, origin); return chats ? content.copyMasked(copied, chats) : null; };
  // a selection's copy (its own `setData`): the chats the selection is in, when it is in a transcript
  const copyPartHook = (type, data, place) => { const chats = place ? turnsOf(place) : undefined; return chats ? content.copyPart(type, data, chats) : null; };
  store.copy = copyHook;
  store.copyPart = copyPartHook;
  if (typeof kernel.markdownSite === 'function') {
    store.parts = content.parts;
    store.directives = content.directives;
    store.text = content.textRenderer;   // the markdown text seam's (H7u)
  }
  // the rules every content hook reads (the copy seam's too, on a build without the markdown seams)
  // The content rules' revision (the kernel's `contentRev`, which every markdown renderer follows: the text seam): it changes only when
  // the redactions or the text parts in force change in effect: one added or gone, or put again with other data, conditions, order or
  // renderer (a rule delivered again unchanged, as another window's start re-sends it, is no change). The app's markdown renderer keeps
  // what it drew (its own memo) while nothing it reads changes, so it draws again in place then: a redaction added while a chat is shown
  // masks it, one taken away shows it again.
  let contentSig = '';
  const fnIds = new WeakMap();
  let fnSeq = 0;
  const fnId = (f) => { if (typeof f !== 'function') return 0; let id = fnIds.get(f); if (id === undefined) { id = ++fnSeq; fnIds.set(f, id); } return id; };
  const effectOf = (r) => {
    let data;
    try { data = JSON.stringify([r.data ?? null, r.for ?? null, r.where ?? null, r.sites ?? null]); } catch { data = '?'; }
    return `${r.mod}/${r.id}|${r.order}|${fnId(r.fns?.render)}|${data}`;
  };
  let groupsSig = '';
  syncContent = () => {
    const off = new Set(rules.tripped());
    const inForce = rules.all().filter((r) => r.presentation === 'ContentView' && ((r.kind === 'host' && r.slot === 'partRenderers') || (r.kind === 'add' && r.slot === 'redact'))
      && !off.has(`${r.mod}/${r.id}`));
    const renamed = content.setRules(inForce);
    store.partsRev = (store.partsRev | 0) + 1;
    if (renamed) store.directivesRev = (store.directivesRev | 0) + 1;
    const sig = inForce.filter((r) => r.kind === 'add' || r.data?.part?.kind === 'text').map(effectOf).sort().join('\n');
    if (sig !== contentSig) { contentSig = sig; store.contentRev = (store.contentRev | 0) + 1; }
    bump();
  };
  // the sidebar's groups follow their order rules' revision (the seam sidebar-groups, layouts.md §4.1)
  syncGroups = () => {
    const off = new Set(rules.tripped());
    const gsig = rules.all().filter((r) => r.presentation === 'Sidebar' && r.kind === 'reorder' && r.slot === 'groups' && !off.has(`${r.mod}/${r.id}`)).map(effectOf).sort().join('\n');
    if (gsig !== groupsSig) { groupsSig = gsig; store.groupsRev = (store.groupsRev | 0) + 1; bump(); }
  };

  // The window's presentations as graph instances (S10, "E2c in detail"): the kernel's committed mounts, described and reported to the Host.
  const bindingsById = new Map([...(o.bindings ?? []).filter((b) => b && armed.has(b.id)), ...FRAMEWORK_BINDINGS, ASK_BINDING].map((b) => [b.id, b]));
  /** Whether a mod's rule hides the presentation, and the rules that decorate it. */
  const DECORATION_FIELDS = [['badges', 'badge'], ['label', 'label'], ['tooltip', 'tooltip'], ['actions', 'action']];
  const facts = (b, ref, props) => {
    // No rule applies to the framework's own presentations (E6 decision 6): reported as they are, whatever a rule's `for` says.
    if (b.framework) return { hidden: false, decorations: [] };
    // a record the window's transcript filters take out is not drawn: hidden (§3.12)
    if (!b.part && TRANSCRIPT.has(b.presentation) && rules.has('ThreadView') && concepts) {
      const filters = declaredFilters(ctx, 'ThreadView');
      const got = filters.length ? replica.get(ref) : null;
      if (got && !got.gone && filtered(filters, got)) return { hidden: true, decorations: [] };
    }
    if (!rules.has(b.presentation)) return { hidden: false, decorations: [] };
    const inst = concepts ? replica.get(ref) : null;
    const r = rules.resolve(b.presentation, inst && !inst.gone ? inst : null, chainOf);
    const decorations = [];
    for (const d of r.decorations) for (const [f, kind] of DECORATION_FIELDS) if (d.data?.[f] !== undefined || d.fns?.[f] !== undefined) decorations.push({ by: d.mod, kind, rule: d.id });
    // hidden as it is drawn: a record the user showed, or one under way, is not (§3.12); nor what its binding keeps (a sidebar group with a
    // chat that needs the user: layouts D9), drawn whoever hides it
    let keeps = false;
    if (r.claim && typeof b.keeps === 'function' && props) { try { keeps = b.keeps(props, ctx) === true; } catch { keeps = true; } }
    return { hidden: r.claim?.kind === 'hide' && !keeps && recordHidden(b.presentation, inst && !inst.gone ? inst : null), decorations };
  };
  // The window's facts: the shell's (its sidebar), and what the bindings tell from their mounts (the new chat's target, E8.3h)
  const factsOfWindow = () => {
    let out = null;
    try { const own = typeof o.windowFacts === 'function' ? o.windowFacts() : null; if (own && typeof own === 'object') out = { ...own }; } catch { /* the app's shell is not there */ }
    out = { ...(out ?? {}), page: mainPages?.shown() ?? null };   // the mod's page it shows (layouts.md D7)
    out.claim = layouts?.facts() ?? null;   // the named layout it holds (layouts.md D6, D11)
    out.panes = hostedThreads?.facts() ?? null;   // the chats it hosts, and the one the user is in (layouts.md D8)
    for (const b of bindingsById.values()) {
      if (typeof b.windowFacts !== 'function' || tripped.has(b.id)) continue;
      try { const f = b.windowFacts(ctx); if (f && typeof f === 'object') out = { ...(out ?? {}), ...f }; } catch (e) { log('a binding\'s window facts', { binding: b.id, message: String(e?.message ?? e) }); }
    }
    return out;
  };
  instances = o.instances && typeof store.mounted === 'function' && 'onMount' in store
    ? createInstances({ store: { mounted: () => [...store.mounted(), ...reportedRecs], onMount: null }, bindings: bindingsById, ctx, facts, channel: o.instances, windowFacts: factsOfWindow,
      activePane: () => (hostedThreadsNow ? hostedThreadsNow.facts()?.active ?? null : null),
      onWindow: () => restyleWhere(), log: (m, d) => log(m, d) })
    : null;
  const onMount = instances ? (kind, rec) => { instances.onMount(kind, rec); mountChanged(kind, rec); } : null;
  if (instances) { store.onMount = onMount; instances.touch(); }
  // Bindings whose canary failed before this runtime came (the kernel kept them) are reported like any fault.
  for (const [id, why] of kernel.kernel.disarmed instanceof Map ? kernel.kernel.disarmed : []) {
    tripped.add(id); whyTripped.set(id, `its canary failed: ${why}`);
    log('a binding\'s canary failed: it is off until reload', { binding: id, why });
    try { o.onFault?.(id, new Error(`its canary failed: ${why}`)); } catch { /* the reporter's own fault */ }
  }
  const previousFault = store.onFault;
  store.onFault = (id, error) => {
    if (!tripped.has(id)) {
      tripped.add(id); whyTripped.set(id, String(error?.message ?? error));
      log('a binding failed and is off until reload', { binding: id, message: String(error?.message ?? error) });
      try { o.onFault?.(id, error); } catch { /* the reporter's own fault */ }
      bump();
    }
    if (typeof previousFault === 'function') { try { previousFault(id, error); } catch { /* not ours */ } }
  };

  // A mod's page in the app's Settings (docs/design/systems.md E0): it observes the framework's instances, so it starts once the concepts
  // are known, and again from a settings binding's render if the app's exposures were not defined yet (the runtime can arrive before the
  // app's chunks run). What is missing is logged once, when it is still missing then.
  let pages = null, disposed = false, said = false;
  const answered = new Set();   // the acts this page answered (the newest 256): an act is done at most once
  const startPages = (final) => {
    if (pages || disposed || !concepts) return pages;
    try {
      pages = startSettingsPages({
        exports: () => kernel.exports, observe: (ref) => replica.observe(ref), get: (ref) => replica.get(ref), watch: (ref, fn) => replica.watch(ref, fn), ctx, log,
        subscribe: (query, fn) => graph.subscribe(query, fn), ...(typeof graph.invoke === 'function' ? { invoke: (ref, op, args) => graph.invoke(ref, op, args ?? []) } : {}),
        pages: o.pages, ...(typeof o.pickFile === 'function' ? { pickFile: o.pickFile } : {}), lostRulesOf,
        typeOf: (t) => typesById.get(t) ?? null,
        // a mod's own page draws its component in its rule's boundary (E8.9a)
        node: (rule, type, props) => node(react(), rule, type, props),
        // the Layouts section of the Mods list (layouts.md D9): every layout, region and page of the mods here, with its switch
        LayoutsSection: createLayoutsSection({ ctx, exports: () => kernel.exports, switches, modName, stateKey: SWITCHES_KEY, items: () => rules.all().flatMap((r) => {
          const key = `${r.mod}/${r.id}`;
          if (r.presentation === 'Window' && r.slot === 'layouts' && r.kind === 'add') return [{ kind: 'layout', key, mod: r.mod, title: String(r.data?.layout?.title ?? r.id) }];
          if (r.presentation === 'Window' && r.slot === 'regions' && r.kind === 'add') return [{ kind: 'region', key, mod: r.mod, title: String(r.data?.region?.title ?? r.id) }];
          if (r.presentation === 'MainRegion' && r.slot === 'pages' && r.kind === 'host') return [{ kind: 'page', key, mod: r.mod, title: String(r.data?.page?.title ?? r.id) }];
          return [];
        }) }),
        onModFault: (mod, error) => { try { o.onModFault?.(mod, error); } catch { /* the reporter's own fault */ } },
        onMissing: (missing) => { if (final && !said) { said = true; log('settings pages: this build lacks what they need', { missing }); o.pages?.missing(`this build lacks ${missing.join(', ')}`); } },
      });
      syncSettings();
    } catch (e) {
      if (!said) { said = true; log('settings pages did not start', { message: String(e?.message ?? e) }); }
      o.pages?.failed(`they did not start: ${e?.message ?? e}`);
    }
    return pages;
  };
  setSettingsPagesStarter(() => startPages(true));
  const hostedThreads = createHostedThreads({ ctx, exports: () => kernel.exports, observe: (ref) => replica.observe(ref), log, paneContext: () => (typeof kernel.paneContext === 'function' ? kernel.paneContext() : null),
    // which panes there are or the one the user is in moved: the window says so, and the chats' views which one the user is in (G5.1)
    changed: () => { ctx.windowChanged?.(); instances?.touch('ThreadView'); },
    openChat(ref) { const win = instances ? instances.windowRef() : null; if (win) invoke(win, 'open', [ref]).catch((e) => log('a chat could not be opened', { message: String(e?.message ?? e) })); } });
  hostedThreadsNow = hostedThreads;
  // the places the mods draw that take drops (graph-integrity G5.3): the lent DropTarget's, and what is dragged there
  const drops = createDrops({ doc: () => globalThis.document ?? null, chainOf: (t) => chainOf(t), thread: (id) => ctx.thread(id), subject: (ref) => subject(ref), log });
  dropsNow = drops;
  // the user's intent this page attests for a mod (graph-integrity G7.1): minted here, told to the Host before the mod can carry it
  setAttestor((mod) => {
    const token = newToken();
    try { void Promise.resolve(o.present?.attest?.(token, mod)).catch(() => {}); } catch { return null; }
    return token;
  });
  // a chat beside another (Window.open(thread, {placement: 'side'}), layouts.md D8): a tab of the right panel, a view of the framework's whose instance is the chat
  // a chat beside another: its tab's title follows the chat's (the app keeps a tab's title as it was opened with)
  function SideChat({ tab }) {
    const R = react();
    const ref = { type: 'CodexThread', provider: 'codex', id: tab.instance };
    const node = useRouteNode();
    const title = use(() => subject(ref)?.state?.title);
    R.useEffect(() => { if (node && typeof title === 'string' && title) panels?.retitle?.(node, tab, title); }, [node, title]);
    return hostedThreads.thread(ref, { key: tab.tabId ?? tab.instance });
  }
  panels?.setOwnView?.(FRAMEWORK_MOD, SIDE_CHAT, (p) => react()?.createElement(SideChat, { tab: p, key: p.tabId ?? p.instance }) ?? null);
  /** The app's own mode of the workspace shown, a layout having ended (the chat alone needs no panel drawn). */
  function appMode(mode) {
    const node = shownColumn(ctx)?.scope ?? routeScope();
    if (!node) return mode === 'chat' ? true : { unavailable: 'the window shows no workspace with a side panel' };
    return layoutWorkspace(ctx, node, mode);
  }
  function chatBeside(ref) {
    if (!panels || typeof ref?.id !== 'string') return { unavailable: 'this window cannot show a chat beside another' };
    const node = routeScope();
    if (!node) return { unavailable: 'the window shows no route with panels' };
    const title = String(subject(ref)?.state?.title ?? 'Chat').slice(0, 80) || 'Chat';
    if (!panels.openIn(node, { mod: FRAMEWORK_MOD, view: SIDE_CHAT, instance: ref.id, title }, { target: 'right', revealAndFocus: true })) return { unavailable: 'the chat could not be opened beside this one' };
    const out = layoutWorkspace(ctx, node, 'split');
    return out === true ? true : { unavailable: out?.unavailable ?? 'the side panel could not be shown' };
  }
  // A mod's own page in the main region (layouts.md D7, WL5a): the framework's route draws this host (seam page-route)
  const routed = () => kernel.pageRouteOn === true;   // the framework's route is in the app's tree (seam page-route)
  mainPages = createMainPages({ ctx, exports: () => kernel.exports, observe: (ref) => replica.observe(ref), navigate: (path) => o.navigate?.(path), routed,
    useRoute });
  store.pageRoute = mainPages.PageRoute;
  // The mods' destinations (layouts.md D7, WL5b, WL5c): in the app's list before its provider splits it (seam destinations); the page's sidebar view
  destinations = createDestinations({ ctx, windowRef: () => (instances ? instances.windowRef() : null), log, routed, may: (rule, ref) => whereEnvFor(rule).may({ ref }),
    changed: () => { store.destinationsRev = (store.destinationsRev | 0) + 1; bump(); } });
  store.destinations = destinations.compose;
  store.railMode = destinations.railMode;
  syncMainPages = () => {
    const off = new Set(rules.tripped());
    const pageRules = rules.all().filter((r) => r.kind === 'host' && r.presentation === 'MainRegion' && r.slot === 'pages');
    const switchedOff = pageRules.map((r) => `${r.mod}/${r.id}`).filter((key) => switches?.isOff('page', key));
    mainPages.setPages(pageRules.filter((r) => typeof r.fns?.render === 'function' && !off.has(`${r.mod}/${r.id}`) && !switchedOff.includes(`${r.mod}/${r.id}`))
      .map((r) => ({ key: `${r.mod}/${r.id}`, mod: r.mod, id: r.id, title: String(r.data?.page?.title ?? r.id), heading: r.data?.page?.heading, render: r.fns.render, actions: r.fns.actions, rule: r })), [...off], switchedOff);
    commandsSync();
  };
  /** The mods' own settings pages (ui.settings.page, E8.9a), from their rules in this window (their components are here). */
  function syncSettings() {
    if (!pages?.setOwnPages) return;
    const off = new Set(rules.tripped());
    pages.setOwnPages(rules.all().filter((r) => r.kind === 'host' && r.presentation === 'SettingsPage' && r.slot === 'pages' && typeof r.fns?.render === 'function' && !off.has(`${r.mod}/${r.id}`))
      .map((r) => ({ key: `${r.mod}/${r.id}`, mod: r.mod, id: r.id, title: String(r.data?.page?.title ?? r.id), group: r.data?.page?.group ?? 'mods', render: r.fns.render, rule: r })));
  }
  // The framework's roots keep the app's own values of what style rules set: read again when the theme changes (E6.4b).
  const themed = typeof o.onTheme === 'function' ? o.onTheme(() => restyle()) : null;

  // The banner band (E6.4): one component for the window, which the core mounts at the top of its content. Open goes by the framework's
  // own navigation (`o.navigate`: main posts the app's navigate-to-route to this window; no mod intercepts it), to the recovery entry when
  // this window's Mods pages cannot run (failed, or their routes or first read never came).
  let band = null, bandView = null;
  let typesById = new Map();   // the graph's reflection of each type, for the DetailView (S11)
  /**
   * Window.open of an instance the app has no page for (S11): a framework-owned one opens its own page; a subtype's registered view opens
   * it (graph-integrity G2.2: its mod's ThreadView replacement); otherwise the DetailView, a developer inspector, only in developer mode
   * (graph-boundary B2: the framework draws no fallback view of a mod's data).
   */
  /**
   * What a palette search finds among the chats the app does not hold (graph-integrity G2.1): the graph's search of Threads (their
   * titles, and each provider's own search), as rows that open each to its view; the agent's name says whose it is.
   */
  const searchChats = async (q) => {
    const hits = await graph.search(q, { types: ['Thread'], limit: 20 });
    return (Array.isArray(hits) ? hits : []).filter((h) => h?.ref && !threads.holds(h.ref)).slice(0, 8).map((h) => {
      const inst = replica.get(h.ref);
      const agent = inst?.links?.agent ? replica.get(inst.links.agent) : null;
      const name = typeof agent?.state?.name === 'string' && agent.state.name ? agent.state.name : null;
      return { id: `chat:${h.ref.provider}:${h.ref.id}`, title: String(h.title || inst?.state?.title || 'Chat'),
        ...(name ? { description: name } : typeof h.snippet === 'string' && h.snippet ? { description: h.snippet } : {}), ref: h.ref, run: () => { showDetail(h.ref); } };
    });
  };
  const showDetail = (ref, known = null) => {
    if (!ref || typeof ref.type !== 'string' || typeof o.navigate !== 'function') return false;
    const own = ownPageOf(ref, (r) => replica.get(r));
    if (own) { if (ref.type === 'CopyUpdate') settingsPages()?.intend?.('update'); o.navigate(own); return true; }
    // the instance as this window has it, or as the caller read it (a row's, from its list's view)
    const inst = replica.get(ref) ?? (known && !known.gone && known.ref?.id === ref.id && known.ref?.provider === ref.provider ? known : undefined);
    if (inst && !inst.gone && ruled('ThreadView', inst)?.replace) return mainPages?.openView(inst.ref) === true;
    // a type this page has not read yet (a mod's, registered after the page started): the types read again, then decided
    if (!inst && !threads.holds(ref) && !typesById.has(ref.type)) { void readTypes().then(() => { if (typesById.has(ref.type)) showDetail(ref, known); }); return true; }
    // a chat the app does not hold, not read in this window yet (a search's): its view's route reads it, and says so when nothing draws it
    if (!inst && !threads.holds(ref) && chainOf(ref.type).includes('Thread')) return mainPages?.openView(ref) === true;
    if (replica.get(FRAMEWORK_REF)?.state?.developerMode !== true) return false;
    const p = settingsPages();
    if (!p?.setDetail) return false;
    p.setDetail(ref);
    o.navigate(DETAIL_PATH);
    return true;
  };
  const openFramework = (t) => {
    if (typeof o.navigate !== 'function') return;
    const p = o.pages;
    const reachable = Boolean(p) && (p.get() === 'running' || (p.get() !== 'failed' && p.has?.('routes') && p.has?.('read')));
    if (!reachable) { o.navigate(RECOVERY_PATH); return; }
    if (t?.update) settingsPages()?.intend?.('update');
    o.navigate(t?.update ? UPDATE_PATH : t?.developer ? DEVELOPER_PATH : t?.mod ? pathOf(t.mod, t.tab) : OVERVIEW_PATH);
  };
  // the app's modal stack, through a scope node one of this window's mounts holds (any of the app's scopes reaches its AppScope atom)
  const modalStack = () => {
    const modal = kernel.exports?.modal;
    if (!modal || typeof store.mounted !== 'function') return null;
    for (const rec of store.mounted()) if (rec?.scopeNode && typeof rec.scopeNode.set === 'function') return { node: rec.scopeNode, modal };
    return null;
  };
  // A mod's panel views in a modal (public-hooks.md §3.14): one per view, in the framework's dialog (the app's Dialog, its title the view's)
  function openModalView(mod, view, opts) {
    const R = react();
    const v = panels?.view(mod, view);
    const s = modalStack();
    if (!R || !v || typeof v.render !== 'function' || !s) return false;
    const key = `${mod}/${view}`;
    if (modalViews.has(key)) return true;
    const { Frame } = createDialogs({ R, exports: () => kernel.exports, ctx });
    const close = () => closeModalView(mod, view);
    // whose it is, said by the framework outside the mod's content (its id, then its name): a view never passes as the app's or the
    // framework's (built review H7j-l)
    const name = modName(mod);
    const subtitle = `From ${mod}${name && name !== mod ? ` (${name})` : ''}`;
    const C = function CodexmodsModalView() {
      return R.createElement(Frame, { title: v.spec.title.slice(0, 80), subtitle, onClose: close, footer: [], own: false },
        R.createElement(panels.ModalView, { mod, view, instance: opts.instance ?? null, onClose: close }));
    };
    const entry = { C, node: s.node, modal: s.modal, rule: v.rule };
    modalViews.set(key, entry);
    try { s.modal.open(s.node, C, {}, { onDispose: () => { if (modalViews.get(key) === entry) modalViews.delete(key); } }); }
    catch (e) { modalViews.delete(key); log('a view could not open in a modal', { view: key, message: String(e?.message ?? e) }); return false; }
    return true;
  }
  function closeModalView(mod, view) {
    const key = `${mod}/${view}`;
    const entry = modalViews.get(key);
    if (!entry) return false;
    modalViews.delete(key);
    try { entry.modal.close(entry.node, entry.C); } catch (e) { log('a view\'s modal could not close', { view: key, message: String(e?.message ?? e) }); }
    return true;
  }
  // A mod's questions (E7.6c, decision 7): the Host's `ask` and `askEnd`, kept until the band's mount draws them (beside the band).
  let asks = null;
  const early = [];
  const asksOf = (R) => {
    if (asks || !R) return asks;
    const { Frame } = createDialogs({ R, exports: () => kernel.exports, ctx });
    // a question's fields are drawn by the settings' own controls (graph-integrity G4.2)
    const kit = createKit({ react: () => R, parts: () => { const ex = kernel.exports ?? {}; return { Button: ex.Button, Menu: ex.Menu, MenuItem: ex.MenuParts?.Item, Separator: ex.MenuParts?.Separator }; } });
    const controls = createSettingControls({ R, kit, exports: () => kernel.exports ?? {}, useImage: createModMedia({ R, kit, invoke }).useImage });
    asks = createAsks({ R, ctx, log, stack: modalStack, controls, answer: (gen, id, outcome) => o.instances?.askAnswer?.(gen, id, outcome),
      dialogs: { Frame, open: frameworkDialogsOpen, button: (label, onClick, tone) => pageParts(R, kernel.exports ?? {}).button(label, onClick, false, tone), exports: () => kernel.exports ?? {} } });
    onFrameworkDialogs(() => asks.refresh());
    for (const m of early.splice(0)) asks.receive(m);
    return asks;
  };
  function Band() {
    const R = ctx.react();
    if (!R) return null;
    band ??= createBand({ R, ctx, exports: () => kernel.exports, frameworkRef: FRAMEWORK_REF, open: openFramework,
      invoke: typeof graph.invoke === 'function' ? (ref, op, args) => graph.invoke(ref, op, args ?? []) : () => Promise.reject(new Error('the graph cannot be acted on here')) });
    return R.createElement(R.Fragment, null, R.createElement(band.Band), R.createElement(asksOf(R).Asks));
  }
  /** The graph's types as this page knows them (concepts, chains, the DetailView's reflection), read again when asked (one read at a time). */
  let typesRead = null;
  function readTypes() {
    typesRead ??= Promise.resolve().then(() => graph.types()).then((types) => {
      concepts = new Map((Array.isArray(types) ? types : []).map((t) => [t.id, t.concept]));
      typesById = new Map((Array.isArray(types) ? types : []).map((t) => [t.id, t]));
      for (const t of Array.isArray(types) ? types : []) if (t.parent) parents.set(t.id, t.parent);
      return types;
    }).finally(() => { typesRead = null; });
    return typesRead;
  }
  readTypes().then(() => {
    startPages(false);
    restyleWhere();
    if (!disposed && !bandView) { try { bandView = replica.observe(FRAMEWORK_REF); } catch (e) { log('the band cannot observe the framework', { message: String(e?.message ?? e) }); } }
    bump();
    instances?.touch();
  }, (e) => { log('types', { message: String(e?.message ?? e) }); o.pages?.failed(`the graph's types could not be read: ${e?.message ?? e}`); });
  bump();

  return {
    replica,
    /** The banner band's component (E6.4), for the core to mount, and where its Open goes. */
    Band, openFramework,
    /** A mod's question from the Host, or its end (E7.6c): shown by the band's mount, one at a time; a mod's notification, as a toast. */
    ask(m) {
      if (m?.t === 'notice' || m?.t === 'noticeEnd') { notice(m); return; }
      const a = asksOf(ctx.react()); if (a) a.receive(m); else if (early.length < 32) early.push(m);
    },
    /** The framework's own presentations' reporter (E6.5): what its components put through `ctx.report`. */
    reporter: report,
    /** A mod's rules that lost to another mod's (E6.5b), as its page shows them. */
    lostRulesOf,
    /** Show an instance: its own page if the framework's, else the DetailView (S11); false when this window cannot. */
    showDetail,
    /**
     * An operation on one of this window's presentations, sent by the Host ("E7 in detail" decision 3): its binding's operation over the
     * mount's committed props (the app's own callbacks). Answered: done; refused, as stale (another generation, or the mount went) or as
     * unavailable (these props give no way to do it, or its binding is off); failed (it threw). Never a framework presentation's.
     */
    act(m) {
      if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.id) || answered.has(m.id)) return;   // each act is answered once
      answered.add(m.id);
      if (answered.size > 256) answered.delete(answered.values().next().value);
      const answer = (outcome) => {
        Promise.resolve().then(() => o.instances?.answer?.(m.gen, m.id, outcome)).catch((e) => log('an act was not answered', { message: String(e?.message ?? e) }));
      };
      const failure = (e) => (e?.code === 'Unavailable' ? { refused: 'unavailable', message: String(e.message) } : { failed: String(e?.message ?? e) });
      if (Number.isFinite(m.expires) && Date.now() > m.expires) { answer({ refused: 'stale', message: 'the act came too late' }); return; }
      const found = disposed ? null : instances?.byNumber(m.gen, m.n) ?? null;
      if (!found) { answer({ refused: 'stale', message: 'the presentation is no longer shown' }); return; }
      const op = String(m.operation ?? '');
      const can = (r) => { const x = bindingsById.get(r.binding); return x && !x.framework && !tripped.has(x.id) && x.operations && Object.hasOwn(x.operations, op) ? x : null; };
      // The presentation's own mount, else a twin's (another component that presents it and holds the operation, E7.4). Mounts of two
      // composers (a page kept mounted out of sight has its own: another client thread) are one presentation: never which one (review 4)
      const capable = [found, ...instances.twinsOf(found)].filter(can);
      const composers = new Set(capable.map((x) => (x.scope && typeof x.scope.clientThreadId === 'string' ? x.scope.clientThreadId : null)).filter(Boolean));
      if (composers.size > 1) { answer({ refused: 'unavailable', message: 'two of these are mounted here (one out of sight): which one is not known' }); return; }
      const rec = can(found) ? found : instances.twinsOf(found).find(can) ?? found;
      const b = bindingsById.get(rec.binding);
      const fn = can(rec)?.operations[op] ?? null;
      if (typeof fn !== 'function') { answer({ refused: 'unavailable', message: `this ${b?.presentation ?? 'presentation'} cannot ${op} here` }); return; }
      let out;
      try { out = fn(rec.props ?? {}, Array.isArray(m.args) ? m.args : [], ctx, rec); } catch (e) { answer(failure(e)); return; }
      const said = (r) => (r === false ? { refused: 'unavailable', message: `this ${b.presentation} cannot ${op} now` }
        : r && typeof r.unavailable === 'string' ? { refused: 'unavailable', message: r.unavailable.slice(0, 300) } : { ok: true });
      Promise.resolve(out).then((r) => answer(said(r)), (e) => answer(failure(e)));
    },
    /** The window's copy of the mods' presentation rules (E2): the API layer and the Host's snapshots put and remove them. */
    rules: Object.freeze({
      // a list's filter is on only while it is declared: one disposed (or its mod off) is forgotten, so one registered later starts off
      reset: (list, handles) => { rules.reset(list, handles); pruneFilters(ctx, (key) => rules.get(key)?.slot === 'filter'); forgetLost(null); bump(); instances?.touch(); restyle(); syncPanels(); syncPalette(); syncSlash(); syncContent(); syncGroups(); tabKinds.changed(rules.all()); syncSettings(); syncMainPages(); destinations.rulesChanged(); layouts.rulesChanged(); commandsSync(); },
      put: (rule) => { rules.put(rule); bump(); if (rule.kind === 'style') restyle(); else instances?.touch(rule.presentation); if (rule.presentation === 'SidePanel') syncPanels(); if (rule.presentation === 'Palette') { syncPalette(); syncSlash(); } if (rule.presentation === 'ContentView') syncContent(); if (rule.presentation === 'Sidebar') syncGroups(); if (rule.presentation === 'SidePanel' || rule.presentation === 'BottomPanel') tabKinds.changed(rules.all()); if (rule.presentation === 'SettingsPage') syncSettings(); if (rule.presentation === 'MainRegion') syncMainPages(); if (rule.slot === 'destinations' || rule.slot === 'views') destinations.rulesChanged(); if (rule.slot === 'layouts') { layouts.rulesChanged(); commandsSync(); } },
      remove: (key) => { const r = rules.get(key); if (rules.remove(key)) { if (r?.slot === 'filter') forgetFilter(ctx, r.presentation, key); forgetLost(key); bump(); if (r?.kind === 'style') restyle(); else instances?.touch(r?.presentation); if (r?.presentation === 'SidePanel') syncPanels(); if (r?.presentation === 'Palette') { syncPalette(); syncSlash(); } if (r?.presentation === 'ContentView') syncContent(); if (r?.presentation === 'Sidebar') syncGroups(); if (r?.presentation === 'SidePanel' || r?.presentation === 'BottomPanel') tabKinds.changed(rules.all()); if (r?.presentation === 'SettingsPage') syncSettings(); if (r?.presentation === 'MainRegion') syncMainPages(); if (r?.slot === 'destinations' || r?.slot === 'views') destinations.rulesChanged(); if (r?.slot === 'layouts') { layouts.rulesChanged(); commandsSync(); } } },
      all: () => rules.all(), tripped: () => rules.tripped(),
    }),
    /** Does the app's own palette carry the mods' commands here (P5: its sections and row are exposed on this build)? */
    /** Open a mod's page in Settings, or one of its own pages (ui.settings.open, E8.9a): false when that page is not here or Settings cannot be reached. */
    openSettings(mod, page) {
      if (disposed || typeof o.navigate !== 'function') return false;
      const sp = startPages(true);
      if (page != null && !sp?.hasPage?.(mod, page)) return false;
      const path = page != null ? pagePathOf(mod, page) : pathOf(mod);
      // within Settings, through its navigation's own guard for unsaved changes; from elsewhere, the app's navigation
      if (sp?.go?.(path)) return true;
      o.navigate(path);
      return true;
    },
    /** One of the app's chats in a place of a mod's (ui.host.thread, layouts.md D8): an element, one pane. */
    hostThread(ref, opts) { return disposed ? null : hostedThreads.thread(ref, opts); },
    /** The places that take drops and the framework's rows' drags (the lent DropTarget and ChatRow, G5.3). */
    drops,
    hostTab(kind, ref) { return disposed ? null : hostedThreads.tab(kind, ref); },
    hostSupported() { return disposed ? null : hostedThreads.supported(); },
    /** Open a mod's own page in this window (ui.pages.add's handle, layouts.md D7): false when it is not declared here. */
    openPage(mod, id) { return !disposed && typeof o.navigate === 'function' ? mainPages.open(mod, id) : false; },
    /**
     * Open (or focus) a mod's panel view in this window's route (mod-surfaces.md §3.1): `{target?, instance?, placement?}`. False when the
     * view is not here, does not allow that panel, or the window shows no route with panels. `placement: 'modal'` (public-hooks.md §3.14):
     * in the framework's dialog on the app's modal stack, above the route; 'side': a tab of the right panel, the chat beside it (the
     * window's layout); 'full': the tab filling the workspace (a view in its own window: the Host opens the window, then this; that tab is
     * this window's alone, not one the other windows' home pages remember). A side or a full view answers once its layout is set:
     * `{ok}`, or `{failed}` (the tab is open, the layout is not: H7pl review 1).
     */
    openPanel(mod, view, opts = {}) {
      if (!panels || disposed) return false;
      if (opts.placement === 'modal') return openModalView(mod, view, opts);
      const props0 = panels.propsOf(mod, view, opts.instance);
      const v = panels.view(mod, view);
      if (!props0) return false;
      const laid = opts.placement === 'side' || opts.placement === 'full';
      const props = opts.placement === 'full' ? { ...props0, persist: false } : props0;
      // the panel asked, else the view's first (a bottom-only view opens at the bottom); a side or a full view is the right panel's
      const target = laid ? 'right' : opts.target ?? (Array.isArray(v.spec.targets) && v.spec.targets.length ? v.spec.targets[0] : 'right');
      // a panel this view does not allow (as this window registered it): never, here (not a moment's absence)
      if (!panels.allows(v, target)) return { refused: 'invalid', message: `this view does not open in the ${target} panel` };
      const node = routeScope();
      const opened = panels.openIn(node, props, { target, revealAndFocus: opts.focus !== false || laid });
      if (!laid || !opened) return opened;
      // its layout in this page, over the same route scope (a new window's home has the tab but no chat: layouts WL3 review), done once the
      // workspace shown says it (a page the app keeps for later may hold that scope: then it is not, and says so)
      const mode = opts.placement === 'full' ? 'full' : 'split';
      const out = layoutWorkspace(ctx, node, mode);
      if (out !== true) return { failed: `the view is open, but its layout was not set: ${out?.unavailable ?? 'unknown'}` };
      return shownLayout(mode).then((ok) => (ok ? { ok: true } : { failed: `the view is open, but the window does not show it ${mode}` }));
    },
    /** Turn one of a mod's list filters on or off in this window (public-hooks.md §3.12): false when it declared none by that id. */
    filterOn(mod, id, isOn) {
      const r = rules.get(`${mod}/${id}`);
      if (disposed || !r || r.slot !== 'filter' || !Object.hasOwn(FILTER_LISTS, r.presentation)) return false;
      setDeclaredFilter(ctx, r.presentation, `${mod}/${id}`, isOn === true);
      return true;
    },
    /** Close a mod's panel view's tab in this window's route, in whichever panel it is, or its modal. */
    closePanel(mod, view, opts = {}) {
      if (!panels || disposed) return false;
      if (closeModalView(mod, view)) return true;
      return panels.closeIn(routeScope(), tabKeyOf(mod, view, opts.instance));
    },
    /**
     * One of a mod's declarations, acted on in this window for the Host (graph-layers.md §3.1: `ui.panels.open` and a sidebar filter's
     * `on` from the host realm): `{id, gen, key, op, args}`, answered once: done, or refused (the declaration is not here, cannot).
     */
    declAct(m) {
      if (!m || typeof m !== 'object') return;
      if (Number.isSafeInteger(m.id)) {
        if (answered.has(m.id)) return;
        answered.add(m.id);
        if (answered.size > 256) answered.delete(answered.values().next().value);
      }
      const answer = (outcome) => { if (Number.isSafeInteger(m.id)) Promise.resolve().then(() => o.instances?.answer?.(m.gen, m.id, outcome)).catch((e) => log('an act was not answered', { message: String(e?.message ?? e) })); };
      if (Number.isFinite(m.expires) && Date.now() > m.expires) { answer({ refused: 'stale', message: 'it came too late' }); return; }
      // the window's own arrangement, no mod's declaration (Window.setRegion's sidebar edge, layouts.md WL4c): the framework's
      if (m.key === WINDOW_ACT && !disposed) {
        const out = m.op === 'sidebar.edge' ? moveSidebar(ctx, args0(m).edge)
          : m.op === 'layout.set' ? layouts.pick(String(args0(m).id), { by: typeof args0(m).by === 'string' ? args0(m).by : null })
          : m.op === 'layout.end' ? (layouts.end(), true)
          : m.op === 'layout.app' ? layouts.toAppMode(() => appMode(String(args0(m).mode)), { by: typeof args0(m).by === 'string' ? args0(m).by : null })
          : m.op === 'sidebar.open' ? setSidebarOpen(args0(m).open === true)
          : m.op === 'chat.side' ? chatBeside(args0(m).ref)
          : m.op === 'pane.focus' ? hostedThreads.focusPane(typeof args0(m).pane === 'string' ? args0(m).pane : null)
          : { unavailable: 'this window cannot do that' };
        answer(out === true ? { ok: true } : { refused: 'unavailable', message: out.unavailable });
        return;
      }
      const r = typeof m.key === 'string' ? rules.get(m.key) : null;
      if (disposed || !r) { answer({ refused: 'unavailable', message: 'that declaration is not in this window' }); return; }
      // the registration it was sent for (a host rule's token): one registered under its key since is not it
      if (typeof m.reg === 'string' && r.realm === 'host' && r.reg !== m.reg) { answer({ refused: 'stale', message: 'that declaration was registered again' }); return; }
      const args = m.args && typeof m.args === 'object' ? m.args : {};
      let ok = false;
      if (m.op === 'panel.open' || m.op === 'panel.close') {
        if (r.presentation !== 'SidePanel' || r.slot !== 'tabs') { answer({ refused: 'invalid', message: 'that declaration is not a panel view' }); return; }
        const opts = { ...(args.target === 'right' || args.target === 'bottom' ? { target: args.target } : {}), ...(typeof args.instance === 'string' ? { instance: args.instance } : {}), ...(args.focus === false ? { focus: false } : {}),
          ...(['modal', 'side', 'full'].includes(args.placement) ? { placement: args.placement } : {}) };
        ok = m.op === 'panel.open' ? this.openPanel(r.mod, r.id, opts) : this.closePanel(r.mod, r.id, opts);
        // a split or a full view: its answer once its layout is set; a panel it does not allow: refused for good
        if (ok && typeof ok.then === 'function') { ok.then((out) => answer(out.ok ? { ok: true } : { failed: out.failed }), (e) => answer({ failed: String(e?.message ?? e) })); return; }
        if (ok && typeof ok === 'object' && typeof ok.refused === 'string') { answer(ok); return; }
      } else if (m.op === 'region.set') {
        // a mod's region in this window (Window.setRegion, layouts.md WL4a)
        if (r.presentation !== 'Window' || r.slot !== 'regions') { answer({ refused: 'invalid', message: 'that declaration is not a region' }); return; }
        ok = setRegion(ctx, m.key, { ...(typeof args.open === 'boolean' ? { open: args.open } : {}), ...(Number.isFinite(args.size) ? { size: args.size } : {}) });
      } else if (m.op === 'filter.on' || m.op === 'filter.off') {
        if (r.slot !== 'filter' || !Object.hasOwn(FILTER_LISTS, r.presentation)) { answer({ refused: 'invalid', message: 'that declaration is not a list\'s filter' }); return; }
        setDeclaredFilter(ctx, r.presentation, m.key, m.op === 'filter.on');
        ok = true;
      }
      answer(ok ? { ok: true } : { refused: 'unavailable', message: 'this window cannot do that now' });
    },
    /**
     * A renderer-realm rule's function the Host asks this window to run (a menu bar entry chosen here, E8.4; a mod command run through the
     * graph, E8.11): `{id, gen, key, reg, path, env, expires}`; only the framework's own run paths (`menuRun`, `command.run`), and only
     * this window's registration the run names (a run of another, or of none, is stale: review 4, round 2). Answered once: ran (`ok`, its
     * promise settled), not run (refused) or failed (a throw trips the rule alone).
     */
    runRule(m) {
      if (!m || typeof m !== 'object') return;
      if (Number.isSafeInteger(m.id)) {   // each run is done and answered once (its id is the Host's, shared with the acts)
        if (answered.has(m.id)) return;
        answered.add(m.id);
        if (answered.size > 256) answered.delete(answered.values().next().value);
      }
      const answer = (outcome) => {
        if (!Number.isSafeInteger(m.id)) return;
        Promise.resolve().then(() => o.instances?.answer?.(m.gen, m.id, outcome)).catch((e) => log('a run was not answered', { message: String(e?.message ?? e) }));
      };
      if (disposed || typeof m.key !== 'string' || (m.path !== 'menuRun' && m.path !== 'command.run' && m.path !== 'items.0.run')) { answer({ refused: 'unavailable', message: 'nothing here runs that' }); return; }
      if (Number.isFinite(m.expires) && Date.now() > m.expires) { answer({ refused: 'stale', message: 'the run came too late' }); return; }
      const r = rules.get(m.key);
      if (!r || r.realm !== 'renderer' || typeof m.reg !== 'string' || r.reg !== m.reg || !rules.live(r)) { answer({ refused: 'stale', message: 'the mod registered it again, or it went' }); return; }
      // a menu bar entry's run, a mod command run through the graph (Command.run, E8.11) as its palette row runs it, or a link route's run
      // for a link opened in this window (ui.links.route: the only rule whose entry the Host runs by its path)
      const fn = m.path === 'menuRun' ? r.fns?.menuRun : m.path === 'items.0.run' ? (r.presentation === 'Window' && r.slot === 'links' ? r.fns?.items?.[0]?.run : undefined)
        : (r.fns?.command ?? r.data?.command)?.run;
      if (typeof fn !== 'function') { answer({ refused: 'unavailable', message: 'it has nothing to run' }); return; }
      const failedWith = (e) => { rules.trip(r, e); answer({ failed: String(e?.message ?? e).slice(0, 300) }); };
      let out;
      try { out = fn(m.env && typeof m.env === 'object' ? Object.freeze({ ...m.env }) : null); } catch (e) { failedWith(e); return; }
      if (out && typeof out.then === 'function') out.then(() => answer({ ok: true }), failedWith); else answer({ ok: true });
    },
    /** The mods have loaded in this window: a mod tab with no view says so. */
    settlePanels: () => panels?.settle(),
    /** The window's presentations as reported (the cost S10 asks to measure). */
    instances: () => instances?.stats() ?? null,
    /** The window's own facts may have changed (the probe's tick). */
    windowChanged: () => instances?.windowChanged(),
    armed: mine.map(([id]) => id),
    tripped: () => [...tripped],
    /** {bindingId: works}: it matched its component and, when it names a subject, named an instance the graph has; not tripped. */
    works() {
      const out = {};
      for (const b of o.bindings ?? []) {
        const s = stats.get(b.id);
        if (s) out[b.id] = !tripped.has(b.id) && (b.subject ? s.found : s.matched > 0);
      }
      return out;
    },
    /** {bindingId: {state: works | tripped | unseen, why?}}: the feature log's live evidence of each armed binding (E4). */
    states() {
      const out = {};
      const works = this.works();
      for (const id of new Set([...(o.bindings ?? []).map((b) => b.id), ...tripped])) {   // a binding the kernel disarmed first is one too
        out[id] = tripped.has(id) ? { state: 'tripped', why: whyTripped.get(id) ?? 'it failed' } : works[id] ? { state: 'works' } : { state: 'unseen' };
      }
      return out;
    },
    /** The rules in this window for the probe: `rule:<mod>/<id>` (true unless tripped) and `applied:<binding>` (a binding applied one). */
    rulesReport() {
      const out = {};
      const off = new Set(rules.tripped());
      for (const r of rules.all()) out[`rule:${r.mod}/${r.id}`] = !off.has(`${r.mod}/${r.id}`);
      for (const [id, s] of stats) if (s.applied) out[`applied:${id}`] = true;
      return out;
    },
    /** {bindingId: 'armed' | 'matched' | 'subject' | 'tripped'}: matched a component; 'subject' once it named an instance the graph has. */
    report() {
      const out = {};
      for (const b of o.bindings ?? []) {
        const s = stats.get(b.id);
        if (!s) continue;
        out[b.id] = tripped.has(b.id) ? 'tripped' : s.found ? 'subject' : s.matched ? 'matched' : 'armed';
      }
      return out;
    },
    dispose() {
      // the views in a modal go with the page's runtime
      for (const key of [...modalViews.keys()]) closeModalView(key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1));
      try { userActions.dispose(); } catch { /* gone */ }
      try { tabKinds.dispose(); } catch { /* gone */ }
      onTouched = null;
      disposed = true;
      clearInterval(relativeTick);
      try { styleWatch?.(); holdForStyles([]); } catch { /* gone */ }
      setSettingsPagesStarter(null);
      try { pages?.dispose(); } catch { /* the app's tree went first */ }
      pages = null;
      try { bandView?.dispose(); } catch { /* gone */ }
      try { themed?.dispose(); } catch { /* gone */ }
      bandView = null;
      for (const [id, render] of mine) if (store.renderers.get(id) === render) store.renderers.delete(id);
      if (store.menus === menusHook) store.menus = null;
      if (store.copy === copyHook) store.copy = null;
      if (store.copyPart === copyPartHook) store.copyPart = null;
      if (store.command === commandSeen) store.command = null;
      if (store.attach === attachHook) store.attach = null;
      if (store.reviewAction === reviewHook) store.reviewAction = null;
      if (store.sidebarGroups === groupsHook) store.sidebarGroups = null;
      if (store.pullRequestCreate === prHook) store.pullRequestCreate = null;
      if (store.launcher === launcher) store.launcher = null;
      if (store.responsive === responsiveHook) store.responsive = null;
      if (store.pageRoute === mainPages.PageRoute) store.pageRoute = null;
      if (store.destinations === destinations.compose) store.destinations = null;
      if (store.railMode === destinations.railMode) store.railMode = null;
      allocator.dispose();   // what it held for space given back with the page
      layouts.dispose();
      hostedThreads.dispose();
      drops.dispose();
      setAttestor(null);
      switches.dispose();
      if (onMount && store.onMount === onMount) store.onMount = null;
      instances?.dispose();
      try { o.styleSink?.(''); } catch { /* the page went first */ }
      for (const e of observed.values()) { try { e.watch.dispose(); e.view.dispose(); } catch { /* gone */ } }
      observed.clear();
      try { replica.close(); } catch { /* gone */ }
      bump();
    },
  };
}

/**
 * A binding of one presentation type on this build (V4): `id` (its address in present/addresses.json), `presents` (the concepts it
 * shows), `subject(props, ctx, scope)` (the ref of the instance the component shows, or null; `scope` is the value of the app's scope its
 * address names, for a component whose props do not carry its subject), `place` (where its presentation sits, S10:
 * `{in, via?, slot}`, `in` the parent's presentation type or null when the binding cannot tell it, `via` the subject's relation to the
 * parent's subject, none for the same subject; or a function of the props giving one), `selected(props)` where it can tell, and
 * `render(Original, props, factory, ctx)`,
 * which returns an element or undefined (the app's own). A binding with a subject and no render passes through: it names the component
 * and its instance for the rules that act on them. Its address, the prop keys a component's props carry, lives in addresses.json,
 * which framework-main arms before the first render.
 */
export function defineBinding(b) {
  if (!b || typeof b.id !== 'string' || !b.id) throw new Error('a binding needs an id');
  if (b.presentation !== undefined && (typeof b.presentation !== 'string' || !b.presentation)) throw new Error(`binding ${b.id}: presentation names its presentation type`);
  for (const [name, slot] of Object.entries(b.slots ?? {})) {
    // an `external` slot is realized by the framework elsewhere (a panel's tabs: present/mod-panels.mjs), not through the props
    if (slot && slot.kind === 'external') continue;
    if (!slot || typeof slot.apply !== 'function' || !['list', 'region'].includes(slot.kind)) throw new Error(`binding ${b.id}: slot ${name} needs a kind (list, region or external) and apply(props, entries, env)`);
  }
  if (!Array.isArray(b.presents) || !b.presents.length) throw new Error(`binding ${b.id}: presents names the concepts it shows`);
  if (b.render !== undefined && typeof b.render !== 'function') throw new Error(`binding ${b.id}: render(Original, props, factory, ctx) is a function`);
  if (b.subject !== undefined && typeof b.subject !== 'function') throw new Error(`binding ${b.id}: subject(props, ctx) is a function`);
  if (!b.render && !b.subject && !(Array.isArray(b.twins) && b.twins.length)) throw new Error(`binding ${b.id}: it needs a render(Original, props, factory, ctx), a subject(props, ctx) or twins`);
  if (b.place !== undefined && typeof b.place !== 'function' && (typeof b.place !== 'object' || b.place === null || (b.place.in !== null && typeof b.place.in !== 'string'))) {
    throw new Error(`binding ${b.id}: place is {in, via?, slot} (in: the parent's presentation type, or null) or a function of the props giving one`);
  }
  if (b.selected !== undefined && typeof b.selected !== 'function') throw new Error(`binding ${b.id}: selected(props) is a function`);
  // its presentation's user-visible state where its props tell it (graph-integrity G5.1)
  for (const k of ['expanded', 'focused', 'open', 'size']) if (b[k] !== undefined && typeof b[k] !== 'function') throw new Error(`binding ${b.id}: ${k}(props) is a function`);
  if (b.layout !== undefined && typeof b.layout !== 'function') throw new Error(`binding ${b.id}: layout(props) is a function`);
  if (b.part !== undefined && typeof b.part !== 'boolean') throw new Error(`binding ${b.id}: part is true or false`);
  if (b.subjectOnly !== undefined && typeof b.subjectOnly !== 'boolean') throw new Error(`binding ${b.id}: subjectOnly is true or false`);
  if (b.keeps !== undefined && typeof b.keeps !== 'function') throw new Error(`binding ${b.id}: keeps(props, ctx) is a function`);
  for (const [name, how] of Object.entries(b.appParts ?? {})) {
    if (how !== 'self' && typeof how !== 'function') throw new Error(`binding ${b.id}: app part ${name} is 'self' or a function (props, env) giving the props without it`);
  }
  for (const [name, how] of Object.entries(b.relabelParts ?? {})) {
    if (typeof how !== 'function') throw new Error(`binding ${b.id}: relabel part ${name} is a function (props, {label, tooltip}, env) giving the props relabelled`);
  }
  if (b.appPartsOf !== undefined && (typeof b.appPartsOf !== 'string' || !(b.appParts || b.relabelParts))) throw new Error(`binding ${b.id}: appPartsOf names the presentation whose appParts or relabelParts it draws`);
  if (b.appPartsSubject !== undefined && (typeof b.appPartsSubject !== 'function' || !b.appPartsOf)) throw new Error(`binding ${b.id}: appPartsSubject(props, ctx, scope) gives the subject of the presentation appPartsOf names`);
  if (b.windowFacts !== undefined && typeof b.windowFacts !== 'function') throw new Error(`binding ${b.id}: windowFacts(ctx) is a function`);
  for (const [name, fn] of Object.entries(b.operations ?? {})) {
    if (typeof fn !== 'function') throw new Error(`binding ${b.id}: operation ${name} is a function (props, args, ctx, record)`);
  }
  for (const t of b.twins ?? []) {
    if (!t || typeof t.presentation !== 'string' || typeof t.subject !== 'function' || !t.slots || typeof t.slots !== 'object') throw new Error(`binding ${b.id}: a twin is {presentation, subject(props, ctx, scope), slots}`);
    for (const [name, slot] of Object.entries(t.slots)) if (!slot || typeof slot.apply !== 'function' || !['list', 'region'].includes(slot.kind)) throw new Error(`binding ${b.id}: twin slot ${name} needs a kind and apply`);
  }
  return Object.freeze({
    id: b.id, presents: Object.freeze([...b.presents]), ...(b.presentation ? { presentation: b.presentation } : {}),
    ...(b.slots ? { slots: Object.freeze({ ...b.slots }) } : {}),
    ...(b.place !== undefined ? { place: typeof b.place === 'function' ? b.place : Object.freeze({ ...b.place }) } : {}),
    ...(b.selected ? { selected: b.selected } : {}),
    ...Object.fromEntries(['expanded', 'focused', 'open', 'size'].filter((k) => b[k]).map((k) => [k, b[k]])),
    ...(b.layout ? { layout: b.layout } : {}),   // a DiffView's layout, where its props say it (E7.5b)
    // A part of its presentation (E7.5b): another mount of the same presentation (its twin, by identity) whose slots and operations are
    // its own; a rule's claim (hide, replace) is the presentation's main mount's, never a part's.
    ...(b.part ? { part: true } : {}),
    // Its presentation only where it names a subject (H7x review 1): a mount with none takes none of that presentation's rules
    ...(b.subjectOnly ? { subjectOnly: true } : {}),
    // What it holds that no claim may take (layouts.md D9): keeps(props, ctx) true draws it as the app does, whoever hides or replaces it
    ...(b.keeps ? { keeps: b.keeps } : {}),
    // The app's own parts it draws (public-hooks.md §3.10): {name: 'self' (the binding is that part) | (props, env) => props without it}
    ...(b.appParts ? { appParts: Object.freeze({ ...b.appParts }) } : {}),
    // ... and the ones it relabels (layouts.md D3): {name: (props, {label, tooltip}, env) => props relabelled}
    ...(b.relabelParts ? { relabelParts: Object.freeze({ ...b.relabelParts }) } : {}),
    // ... of another presentation it is a part of (the model menu: its Composer's `model`)
    ...(b.appPartsOf ? { appPartsOf: b.appPartsOf } : {}),
    ...(b.appPartsSubject ? { appPartsSubject: b.appPartsSubject } : {}),
    // facts of the window its mounts tell (E8.3h: the new chat's target), sent with the window's reports: {name: value}
    ...(b.windowFacts ? { windowFacts: b.windowFacts } : {}),
    // What only the page can do on its presentation (E7, "E7 in detail" decision 3): each over the mount's committed props; it returns
    // false or {unavailable: why} (or throws Unavailable) when these props give no way to do it.
    ...(b.operations ? { operations: Object.freeze({ ...b.operations }) } : {}),
    // Other presentations the component also realizes, by their slots only (E7): {presentation, subject, slots}.
    ...(b.twins ? { twins: Object.freeze(b.twins.map((t) => Object.freeze({ id: `${b.id}~${t.presentation}`, presentation: t.presentation, subject: t.subject, slots: Object.freeze({ ...t.slots }) }))) } : {}),
    ...(b.render ? { render: b.render } : {}), ...(b.subject ? { subject: b.subject } : {}), ...(b.notes ? { notes: String(b.notes) } : {}),
  });
}
