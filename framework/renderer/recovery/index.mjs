// The recovery entry (docs/design/systems.md S22, E6.1; ARCHITECTURE §9.5): a small view at the top of Settings › General, over the
// management port alone, so it works when the graph, the page runtime or the Mods pages do not. Safe mode, restoring last-known-good, the
// operations that need attention (acknowledged here), the latest activity. It shows in a window unless that window's Mods pages run
// (`pages`, the window's own report: ../pages-status.mjs), and never needs to be told why. Adjustments keeps its own views until the Mods
// pages replace them (E6.2 to E6.6).
// A privileged built-in module, loaded by loadFrameworkModule('recovery/index.mjs', { pages }) with { ui, management, pages }. One file and
// no imports, so it depends on nothing that may have failed; it uses only ui.react and ui.components, with the app's own classes (theme
// tokens, no literal colors). NO NODE API.

/** The latest operations the activity shows. */
export const ACTIVITY = 8;
/**
 * The pages report running once the settings navigation has rendered, in the same commit as Settings › General or just after: the view
 * waits this long before it shows for pages still missing, so it does not flash where they run. It shows at once for pages that failed.
 */
export const SETTLE_MS = 600;

const LABELS = {
  install: 'Install', update: 'Update', enable: 'Turn on', disable: 'Turn off', remove: 'Remove', rollback: 'Roll back', reattach: 'Reattach data',
  consent: 'Consent', configure: 'Settings', 'clear-quarantine': 'Turn back on', 'set-automatic': 'Automatic action', 'set-policy': 'Policy', 'safe-mode': 'Safe mode', 'lkg-restore': 'Restore last-known-good',
  'copy-update': 'Update the app', 'framework-update': 'Update the framework', 'app-prepare': 'Prepare the app update',
};
/** An operation's label, from its input. */
export function labelOf(op) {
  const input = op?.input ?? {};
  const base = input.type === 'safe-mode' ? (input.enter ? 'Safe mode on' : 'Safe mode off') : LABELS[input.type] ?? String(input.type ?? 'Operation');
  return input.modId ? `${base} · ${input.modId}` : base;
}
/** What an operation says in the activity. */
export function outcomeText(op) {
  const label = labelOf(op);
  switch (op?.outcome) {
    case 'running': return `${label}…`;
    case 'succeeded': return op.awaiting === 'consent' ? `${label}: waiting for consent` : op.note ? `${label}: ${op.note}` : `${label}: done`;
    case 'failed': return `${label} failed${op.error?.message ? `: ${op.error.message}` : ''}`;
    case 'reverted': return `${label} was reverted${op.note ? `: ${op.note}` : ''}`;
    case 'needs-attention': return `${label} needs attention${op.note ? `: ${op.note}` : ''}`;
    default: return label;
  }
}
const toneClass = (op) => (op?.outcome === 'failed' ? 'text-danger' : op?.outcome === 'needs-attention' || op?.outcome === 'reverted' ? 'text-warning'
  : op?.outcome === 'running' ? 'text-tertiary' : 'text-secondary');
const errText = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
const byNewest = (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0);

// =====================================================================================================================
// Store: state and actions, no React
// =====================================================================================================================

/** @param {{ management: object, schedule?: (fn: () => void) => void }} o */
export function createStore({ management, schedule = (fn) => setTimeout(fn, 0) }) {
  if (!management) throw new TypeError('the recovery entry needs a management client');
  const call = (method, params) => Promise.resolve().then(() => (management.call ? management.call(method, params) : management.request(method, params)));
  // `errors`: the reads that failed (each load replaces them); `refused`: why the last action was refused (the next action clears it).
  let state = Object.freeze({ loaded: false, safe: false, lkg: null, ops: [], errors: [], refused: null, confirmLkg: false, confirmSafe: null, started: null, acknowledging: Object.freeze([]) });
  const listeners = new Set();
  const set = (patch) => { state = Object.freeze({ ...state, ...patch }); for (const fn of [...listeners]) fn(); };
  let disposed = false, queued = false;

  /** What the view needs: safe mode, last-known-good and the operations, each on its own (one failing does not hide the others). */
  async function load() {
    const [diag, upd, list] = await Promise.allSettled([call('diagnostics', {}), call('updates.status', {}), call('ops.list', {})]);
    if (disposed) return;
    const errors = [diag, upd, list].filter((r) => r.status === 'rejected').map((r) => errText(r.reason));
    set({
      loaded: true, errors,
      ...(diag.status === 'fulfilled' ? { safe: Boolean(diag.value?.host?.safeMode) } : {}),
      ...(upd.status === 'fulfilled' ? { lkg: upd.value?.lkg ?? null } : {}),
      ...(list.status === 'fulfilled' ? { ops: (Array.isArray(list.value?.ops) ? list.value.ops : []).slice().sort(byNewest) } : {}),
    });
  }
  const reload = () => { if (queued || disposed) return; queued = true; schedule(() => { queued = false; load(); }); };

  /** A recovery operation: it answers with its id at once; its progress and outcome come as `op` events. */
  async function run(method, params) {
    set({ started: method, refused: null });
    try { await call(method, params); } catch (e) { set({ refused: errText(e) }); } finally { set({ started: null }); reload(); }
  }
  const actions = {
    load,
    setSafeMode: (enter) => run('recovery.safeMode', { enter: Boolean(enter) }),
    // safe mode restarts ChatGPT: asked first (E6 review), as last-known-good is
    askSafeMode: (enter) => set({ confirmSafe: Boolean(enter), confirmLkg: false }),
    cancelSafeMode: () => set({ confirmSafe: null }),
    confirmSafeMode: () => { const enter = state.confirmSafe; set({ confirmSafe: null }); return enter === null ? null : run('recovery.safeMode', { enter }); },
    askLkg: () => set({ confirmLkg: true, confirmSafe: null }),
    cancelLkg: () => set({ confirmLkg: false }),
    restoreLkg: () => { set({ confirmLkg: false }); return run('recovery.lkg', {}); },
    /** The operation keeps its outcome; it no longer needs attention once the Host has written that it was seen. */
    async acknowledge(opId) {
      if (state.acknowledging.includes(opId)) return;
      set({ acknowledging: Object.freeze([...state.acknowledging, opId]), refused: null });
      try { await call('ops.acknowledge', { opId }); } catch (e) { set({ refused: errText(e) }); } finally {
        set({ acknowledging: Object.freeze(state.acknowledging.filter((x) => x !== opId)) });
        reload();
      }
    },
  };

  let sub = null;
  async function start() {
    // Once it has loaded (it loads when it shows), an operation's progress or the health changing loads it again.
    const onEvent = (e) => { if (!disposed && state.loaded && (e?.event === 'op' || e?.event === 'health')) reload(); };
    sub = management.subscribe ? management.subscribe(onEvent) : management.onEvent ? management.onEvent(onEvent) : null;
    try { await call('events.subscribe', {}); } catch { /* the view still loads on demand */ }
  }
  function dispose() { disposed = true; sub?.dispose?.(); listeners.clear(); }
  return {
    getState: () => state,
    /** React's external store contract: returns the unsubscribe function. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    actions, start, dispose,
  };
}

// =====================================================================================================================
// View: a pure function of the store's state, with the app's components
// =====================================================================================================================

export function createView({ react, components: C }) {
  const h = react.createElement;
  /** A confirmation in place: an alertdialog named by its question, focus on its first button when it shows and back where it was when it
   * goes, Escape cancels (E6 review: the recovery entry has no page runtime, so no ModsDialog). */
  function Confirm({ id, question, buttons, onCancel }) {
    const box = react.useRef ? react.useRef(null) : { current: null };
    react.useEffect?.(() => {
      const node = box.current;
      const before = node?.ownerDocument?.activeElement ?? null;
      node?.querySelector?.('button')?.focus?.();
      // a framework Dialog of the window's while it shows: no mod's question covers it (the count present/dialogs.mjs keeps)
      const shared = (globalThis[Symbol.for('codexmods.frameworkDialogs')] ??= { open: 0, listeners: new Set() });
      const changed = (d) => { shared.open += d; for (const f of [...shared.listeners]) { try { f(); } catch { /* its own fault */ } } };
      changed(1);
      return () => { changed(-1); if (before && typeof before.focus === 'function' && before.isConnected !== false) before.focus(); };
    }, []);
    return h('div', { ref: box, className: 'flex flex-col gap-2', role: 'alertdialog', 'aria-labelledby': `${id}-q`, 'data-confirm': 'true',
      onKeyDown: (ev) => { if (ev.key === 'Escape') { ev.preventDefault?.(); ev.stopPropagation?.(); onCancel(); } } },
    h('span', { id: `${id}-q`, className: 'font-medium' }, question), h('div', { className: rowCls }, ...buttons));
  }
  const rowCls = 'flex flex-row flex-wrap items-center gap-2';
  const muted = (text, key) => h('span', { className: 'text-sm text-tertiary', key, style: { minWidth: 0 } }, text);
  const danger = (text, key) => h('span', { className: 'text-sm text-danger', role: 'alert', key }, text);
  const Button = ({ label, onClick, disabled, primary }) => h(C.Button, { color: primary ? 'primary' : 'secondary', disabled: Boolean(disabled), onClick, 'aria-label': label }, label);
  const Switch = ({ checked, disabled, onChange, label }) => h(C.Switch, { checked: Boolean(checked), disabled: Boolean(disabled), 'aria-label': label,
    onChange: (v) => onChange(typeof v === 'boolean' ? v : Boolean(v?.target?.checked)) });
  const Row = ({ label, description, control, key }) => (C.SettingsRow ? h(C.SettingsRow, { label, description, control, key })
    : h('div', { key, className: rowCls }, h('span', { className: 'font-medium' }, label), description ? muted(description) : null, control ?? null));
  function Section({ title, children, key }) {
    const S = C.SettingsSection;
    if (S && S.Header && S.Content) return h(S, { key }, h(S.Header, { title }), h(S.Content, null, ...children.filter(Boolean)));
    return h('section', { key, className: 'flex flex-col gap-3' }, h('h2', { className: 'heading-md' }, title), ...children.filter(Boolean));
  }

  function render(s, a) {
    // an operation of the Host running does not disable safe mode or last-known-good: they are the way out of a stuck one (E6 review);
    // the Host says when it cannot
    const busy = Boolean(s.started);
    const attention = s.ops.filter((o) => o.outcome === 'needs-attention' && !o.acknowledgedAt);
    const lkg = s.lkg;
    return h('div', { className: 'flex w-full flex-col gap-5', 'data-codexmods-recovery': 'true', 'data-codexmods-framework': '', style: { width: '100%', minWidth: 0, boxSizing: 'border-box', marginBottom: '32px' } },
      Section({ key: 'recovery', title: 'Mods recovery', children: [
        muted('The Mods pages are not available in this window. These controls work without them.', 'why'),
        ...s.errors.map((t, i) => danger(t, `e${i}`)),
        s.refused ? danger(s.refused, 'refused') : null,
        Row({ key: 'safe', label: 'Safe mode', description: s.safe ? 'On: no mods are running. Turn it off to bring your mods back.' : 'Starts ChatGPT with the framework but without any mods.',
          control: Switch({ checked: s.safe, disabled: busy || !s.loaded, label: 'Safe mode', onChange: (v) => a.askSafeMode(v) }) }),
        s.confirmSafe !== null && s.confirmSafe !== undefined ? h(Confirm, { key: 'safec', id: 'codexmods-recovery-safe', onCancel: () => a.cancelSafeMode(),
          question: s.confirmSafe ? 'Turn on safe mode? ChatGPT restarts without any mod; your mods and their data stay as they are.' : 'Turn off safe mode? ChatGPT restarts with your mods that are on.',
          buttons: [Button({ label: s.confirmSafe ? 'Turn on and restart' : 'Turn off and restart', primary: true, disabled: busy, onClick: () => a.confirmSafeMode() }), Button({ label: 'Cancel', onClick: () => a.cancelSafeMode() })] }) : null,
        Row({ key: 'lkg', label: 'Last-known-good', description: lkg ? `Generation ${lkg.n}: ChatGPT ${lkg.appBuild}, framework ${lkg.frameworkVersion}` : 'No healthy generation has been recorded yet.',
          control: Button({ label: 'Restore last-known-good…', disabled: !lkg || busy, onClick: () => a.askLkg() }) }),
        s.confirmLkg ? h(Confirm, { key: 'lkgc', id: 'codexmods-recovery-lkg', onCancel: () => a.cancelLkg(),
          question: 'Restore the last-known-good framework, mods and settings? Mod data is never rolled back; a mod whose data format changed stays off.',
          buttons: [Button({ label: 'Restore', primary: true, disabled: busy, onClick: () => a.restoreLkg() }), Button({ label: 'Cancel', onClick: () => a.cancelLkg() })] }) : null,
      ] }),
      Section({ key: 'attention', title: 'Needs attention', children: attention.length === 0 ? [muted(s.loaded ? 'Nothing needs attention.' : 'Loading…', 'none')]
        : attention.map((o) => Row({ key: o.id, label: labelOf(o), description: o.note ?? 'Local state is consistent, but it may have had effects outside the app.',
          control: Button({ label: 'Acknowledge', disabled: s.acknowledging.includes(o.id), onClick: () => a.acknowledge(o.id) }) })) }),
      s.ops.length ? Section({ key: 'activity', title: 'Activity', children: [
        h('div', { key: 'list', className: 'flex flex-col gap-1', 'data-activity': 'true' },
          ...s.ops.slice(0, ACTIVITY).map((o) => h('span', { key: o.id, className: `text-sm ${toneClass(o)}`, role: o.outcome === 'failed' ? 'alert' : 'status' }, outcomeText(o)))),
      ] }) : null);
  }
  return { render };
}

// =====================================================================================================================
// Entry
// =====================================================================================================================

/** Build the recovery entry without mounting it (tests and activate). `pages` absent: the window has no report, and the view shows. */
export function createRecovery(ctx) {
  const { ui, management, pages } = ctx;
  const R = ui.react;
  const store = createStore({ management, schedule: ctx.schedule });
  const view = createView({ react: R, components: ui.components });
  const later = ctx.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const pagesNow = () => (pages ? pages.get() : 'missing');
  const pagesSubscribe = (fn) => { const s = pages?.subscribe(fn); return () => s?.dispose(); };
  const useExternal = (subscribe, get) => {
    if (typeof R.useSyncExternalStore === 'function') return R.useSyncExternalStore(subscribe, get);
    const [v, setV] = R.useState(get());
    R.useEffect(() => subscribe(() => setV(get())), []);
    return v;
  };
  function Root() {
    const pagesState = useExternal(pagesSubscribe, pagesNow);
    const s = useExternal(store.subscribe, store.getState);
    const [settled, setSettled] = R.useState(false);
    R.useEffect(() => later(() => setSettled(true), SETTLE_MS), []);
    const shown = pagesState === 'failed' || (pagesState === 'missing' && settled);
    R.useEffect(() => { if (shown) store.actions.load(); }, [shown]);
    return shown ? view.render(s, store.actions) : null;
  }
  return { store, view, Root, render: () => view.render(store.getState(), store.actions) };
}

/** Called by loadFrameworkModule: mounts the entry at the top of Settings › General and returns a disposable. */
export function activate(ctx) {
  const rec = createRecovery(ctx);
  rec.store.start();
  const mount = ctx.mountSettings(rec.Root, { position: 'prepend' });
  return {
    degraded: Boolean(mount?.degraded),
    dispose() { rec.store.dispose(); return mount?.dispose?.(); },
  };
}

export const renderer = activate;
export default { renderer: activate, activate };
