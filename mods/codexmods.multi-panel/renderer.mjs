// codexmods.multi-panel ("Split view"), renderer entry (GOAL.md goal 19). Single-file ESM, no imports. Two or more chats open at once,
// built only from public calls:
// - a region at the window's right edge, beside the chat you are in and the sidebar, holding up to three panes, each one of your chats live
//   with its own composer (`ui.host.thread`); a chat dropped on a pane (from the sidebar, or a chat row that can be dragged) goes there;
//   the panes and their sizes are this mod's own data, kept in its storage, so they come back after a relaunch and in every window;
// - commands: "Open in split view" (a chat's context menu and the palette), "Show or hide split view" (its key), "Next pane" and
//   "Previous pane" (the keyboard between the chat you are in and the panes, `Window.focusPane`), and "Open chat beside" (the app's own
//   side panel: `Window.open(thread, {placement: 'side'})`).

export const KEYS = 'CmdOrCtrl+\\';              // open the chat beside, in the side panel
export const SPLIT_KEYS = 'CmdOrCtrl+Shift+\\';   // show or hide the split view
const REGION = 'split';
const STORE = 'panes';
const MAX = 3;
const MIN_SHARE = 0.15;
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';
const same = (a, b) => isRef(a) && isRef(b) && a.provider === b.provider && a.type === b.type && a.id === b.id;

/** The arrangement as kept: `{panes: [ref | null], shares: [number]}`, each pane's share of the height summing to 1. */
export function arrangementOf(v, count) {
  const n = Math.min(MAX, Math.max(1, count));
  const panes = Array.from({ length: n }, (_, i) => (Array.isArray(v?.panes) && isRef(v.panes[i]) ? v.panes[i] : null));
  let shares = Array.isArray(v?.shares) && v.shares.length === n && v.shares.every((x) => typeof x === 'number' && x >= MIN_SHARE) ? v.shares : null;
  if (shares) { const sum = shares.reduce((a, b) => a + b, 0); shares = shares.map((x) => x / sum); } else shares = panes.map(() => 1 / n);
  return { panes, shares };
}

/** A chat placed in the panes: where it already is, else the first empty pane, else the last; the others as they were. */
export function placed(arr, ref) {
  if (arr.panes.some((p) => same(p, ref))) return arr;
  const i = arr.panes.findIndex((p) => p === null);
  const at = i === -1 ? arr.panes.length - 1 : i;
  return { ...arr, panes: arr.panes.map((p, j) => (j === at ? ref : p)) };
}

/** Two neighbouring panes' shares after the divider between them moved by `delta` (a share of the height), each kept above the minimum. */
export function resized(shares, i, delta) {
  const a = shares[i], b = shares[i + 1];
  const d = Math.max(MIN_SHARE - a, Math.min(b - MIN_SHARE, delta));
  return shares.map((x, j) => (j === i ? a + d : j === i + 1 ? b - d : x));
}

async function renderer(ctx) {
  const { ui } = ctx;
  const R = ui.react;
  const C = ui.components;
  const e = R.createElement;
  let settings = await ctx.settings.get();
  const count = () => (Number.isInteger(settings.panes) ? settings.panes : 2);
  let arr = arrangementOf(await ctx.storage.get(STORE).catch(() => null), count());
  const subs = new Set();
  const changed = () => { for (const fn of [...subs]) fn(); };
  const save = (next) => { arr = next; changed(); ctx.storage.set(STORE, arr).catch((err) => ctx.log.warn('the split view was not kept', { message: String(err?.message ?? err) })); };
  // another window changed the panes: follow
  const watch = ctx.storage.watch(STORE, () => { ctx.storage.get(STORE).then((v) => { arr = arrangementOf(v, count()); changed(); }).catch(() => {}); });

  const say = (title, kind) => { try { ui.notify({ title, kind, surface: 'toast' }); } catch { /* no window to say it in */ } };
  const outcome = (out, what) => { if (out?.status !== 'done') say(`${what}: ${out?.message ?? out?.error?.message ?? out?.status}`, 'error'); return out?.status === 'done'; };
  const act = async (ref, op, args, what) => { try { return outcome(await ctx.graph.invoke(ref, op, args), what); } catch (err) { say(`${what}: ${err?.message ?? err}`, 'error'); return false; } };
  const regionOf = async (window) => {
    try { return (await ctx.graph.resolve(window))?.state?.regions?.[`${ctx.mod.id}/${REGION}`] ?? null; } catch { return null; }   // unknown: shown
  };
  const show = (window, open = true) => act(window, 'setRegion', [`${ctx.mod.id}/${REGION}`, { open }], open ? 'The split view could not open' : 'The split view could not close');

  /** One pane's chat title, live. */
  function useTitle(ref) {
    const [title, setTitle] = R.useState(null);
    R.useEffect(() => {
      if (!ref || typeof ctx.graph.subscribe !== 'function') { setTitle(null); return undefined; }
      const view = ctx.graph.subscribe({ ref, depth: 'core' }, (m) => {
        const inst = m?.type === 'snapshot' ? m.items?.[0] : m?.type === 'delta' ? m.event?.instance : null;
        if (inst?.state?.title !== undefined) setTitle(inst.state.title);
      });
      return () => view.dispose();
    }, [ref ? `${ref.provider}:${ref.id}` : null]);
    return title;
  }

  function Pane({ i, chat, share }) {
    const title = useTitle(chat);
    const close = () => save({ ...arr, panes: arr.panes.map((p, j) => (j === i ? null : p)) });
    const header = e('div', { className: 'text-sm', style: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)', padding: 'calc(var(--spacing) * 1) calc(var(--spacing) * 2)', borderBottom: '1px solid var(--color-border)' } },
      e('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, chat ? (title ?? 'Chat') : `Pane ${i + 1}`),
      chat ? e(C.MenuButton, { ariaLabel: 'Pane actions', icon: 'more', items: [
        { label: 'Open in the main view', onSelect: () => act(chat, 'open', [], 'The chat could not open') },
        { label: 'Close pane', onSelect: close },
      ] }) : null);
    return e(C.DropTarget, { accepts: ['Thread'], onDrop: ({ ref }) => save({ ...arr, panes: arr.panes.map((p, j) => (j === i ? ref : same(p, ref) ? null : p)) }),
      style: { display: 'flex', flexDirection: 'column', flex: `${share} 1 0`, minHeight: 0, minWidth: 0 } },
      header,
      e('div', { 'data-split-pane': String(i), style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } },
        chat ? ui.host.thread(chat, { key: `pane-${i}-${chat.id}`, composer: true })
          : e(C.EmptyState, { glyph: 'sidebar', title: 'Drop a chat here', description: 'Drag one from the sidebar, or choose "Open in split view" in a chat\'s menu.' })));
  }

  function Divider({ i, box }) {
    // the pointer captured by the divider while it is held: its moves share the two panes' height, its release keeps the shares
    const drag = R.useRef(null);
    const onPointerDown = (ev) => {
      const el = box.current;
      if (!el) return;
      ev.preventDefault();
      try { ev.currentTarget.setPointerCapture?.(ev.pointerId); } catch { /* the moves still come to the divider while over it */ }
      drag.current = { y: ev.clientY, height: el.getBoundingClientRect().height || 1, shares: arr.shares };
    };
    const onPointerMove = (ev) => {
      const d = drag.current;
      if (!d) return;
      d.shares = resized(d.shares, i, (ev.clientY - d.y) / d.height);
      d.y = ev.clientY;
      arr = { ...arr, shares: d.shares };
      changed();
    };
    const onPointerUp = (ev) => {
      const d = drag.current;
      drag.current = null;
      try { ev.currentTarget.releasePointerCapture?.(ev.pointerId); } catch { /* released already */ }
      if (d) save({ ...arr, shares: d.shares });
    };
    return e('div', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize panes', onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
      style: { flex: '0 0 calc(var(--spacing) * 2)', cursor: 'row-resize', borderTop: '1px solid var(--color-border)', touchAction: 'none' } });
  }

  function Split() {
    const [, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => { subs.add(bump); return () => { subs.delete(bump); }; }, []);
    const box = R.useRef(null);
    const kids = [];
    arr.panes.forEach((chat, i) => {
      if (i > 0) kids.push(e(Divider, { key: `d${i}`, i: i - 1, box }));
      kids.push(e(Pane, { key: `p${i}`, i, chat, share: arr.shares[i] }));
    });
    return e('div', { ref: box, 'data-split-view': String(arr.panes.filter(Boolean).length), style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, ...kids);
  }

  const region = ui.regions.add({ id: REGION, title: 'Split view', icon: 'sidebar', edge: 'right', width: { default: 560, min: 360, max: 960 }, render: () => e(Split) });

  async function openInSplit(env) {
    if (!env?.window || !isRef(env.subject)) { say('Choose a chat to open in the split view.', 'info'); return; }
    save(placed(arr, env.subject));
    await show(env.window, true);
  }
  async function toggle(env) {
    if (!env?.window) return;
    const r = await regionOf(env.window);
    await show(env.window, !(r?.open === true));
  }
  async function openBeside(env) {
    // the chat the command applies to: the window's, or the one whose menu it was chosen in
    if (!env?.window || !env.subject) { say('Open a chat first, then open a chat beside it.', 'info'); return; }
    try {
      const out = await ctx.graph.invoke(env.window, 'open', [env.subject, { placement: 'side' }]);
      if (out?.status !== 'done') say(`The chat could not open beside this one: ${out?.message ?? out?.error?.message ?? out?.status}`, 'error');
    } catch (err) { say(`The chat could not open beside this one: ${err?.message ?? err}`, 'error'); }
  }
  const pane = (dir) => (env) => (env?.window ? act(env.window, 'focusPane', [dir], 'The keyboard could not move') : undefined);

  let commands = [];
  const registerCommands = () => {
    for (const c of commands) c.dispose();
    const keys = settings.keyboardShortcut !== false;
    commands = [
      ui.commands.add({ id: 'beside', title: 'Open chat beside', appliesTo: 'CodexThread', ...(keys ? { keys: KEYS } : {}), run: openBeside }),
      ui.commands.add({ id: 'open-split', title: 'Open in split view', appliesTo: 'Thread', run: openInSplit }),
      ui.commands.add({ id: 'toggle', title: 'Show or hide split view', ...(keys ? { keys: SPLIT_KEYS } : {}), run: toggle }),
      ui.commands.add({ id: 'next', title: 'Next pane', description: 'Move the keyboard to the next chat on the screen', run: pane('next') }),
      ui.commands.add({ id: 'previous', title: 'Previous pane', description: 'Move the keyboard to the previous chat on the screen', run: pane('previous') }),
    ];
  };
  registerCommands();
  const sub = ctx.settings.onChange((next) => {
    const before = settings;
    settings = next;
    if ((next.keyboardShortcut === false) !== (before.keyboardShortcut === false)) registerCommands();
    if (count() !== arr.panes.length) save(arrangementOf(arr, count()));
  });

  return () => { sub.dispose(); watch.dispose(); for (const c of commands) c.dispose(); region.dispose(); };
}

export default { renderer };
