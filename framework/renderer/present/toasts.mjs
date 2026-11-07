// The framework's toasts (docs/design/framework-ui.md F16): the app's own toast, as a mod's notification uses it (runtime.mjs), with up to two actions
// where the build has them. Nothing when the build has no toast: what a toast says is never its only record. NO NODE API.

const LEVEL = Object.freeze({ info: 'info', success: 'success', warning: 'warning', error: 'danger' });

/**
 * Show one. `id`: the same id replaces the one shown; an action closes the toast after it runs. Answers the toast's handle, or null when it could not show.
 * @param {object} ex  the app's exports
 * @param {{ kind?: 'info' | 'success' | 'warning' | 'error', title: string, body?: string, id: string, action?: { label: string, onClick: Function }, secondary?: { label: string, onClick: Function } }} t
 */
export function toast(ex, t) {
  let api;
  try { api = ex?.toast?.get?.() ?? null; } catch { api = null; }
  const show = api && typeof api[LEVEL[t.kind ?? 'info']] === 'function' ? api[LEVEL[t.kind ?? 'info']] : null;
  if (!show) return null;
  let handle = null;
  const button = (a) => ({ label: a.label, onClick: () => { try { a.onClick(); } finally { try { handle?.close?.(); } catch { /* gone */ } } } });
  try {
    handle = show.call(api, t.title, { ...(t.body ? { description: t.body } : {}), id: `codexmods:framework:${t.id}`,
      ...(t.action ? { primaryAction: button(t.action) } : {}), ...(t.secondary ? { secondaryAction: button(t.secondary) } : {}) });
  } catch { return null; }
  return handle;
}

/** How long a switch's Undo stays on its page. */
export const UNDO_MS = 10_000;

/**
 * A mod's switch, turned (F16), on the framework's own pages: Settings has no toast viewport (the app's toasts wait there until a chat is shown), so the
 * page says it itself, with Undo, which turns it back through the graph; refused while that mod has an operation running (the one the switch started
 * included), which it says. It goes after a while, or when dismissed.
 * @param {object} R  the app's React  @param {object} kit
 * @param {{ invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>, running: (modId: string) => boolean }} o  `running`: read when Undo is pressed
 * @returns {{ switched: (ref: object, name: string, on: boolean) => void, notice: object | null }}
 */
export function useSwitchUndo(R, kit, o) {
  const [n, setN] = R.useState(null);
  R.useEffect(() => {
    if (!n || n.said) return undefined;
    const t = setTimeout(() => setN((cur) => (cur === n ? null : cur)), UNDO_MS);
    return () => clearTimeout(t);
  }, [n]);
  const undo = async () => {
    const cur = n;
    if (!cur) return;
    if (o.running(cur.ref.id)) { setN({ ...cur, said: `${cur.name} has an operation running; try again when it ends.` }); return; }
    let out;
    try { out = await o.invoke(cur.ref, cur.on ? 'disable' : 'enable', []); } catch (e) { setN({ ...cur, said: String(e?.message ?? e) }); return; }
    if (out && out.status && out.status !== 'done') setN({ ...cur, said: String(out.error?.message ?? out.message ?? 'It was not allowed now.') });
    else setN(null);
  };
  const notice = n ? R.createElement(kit.Banner, { key: 'undo', glyph: 'check', title: `${n.name} is ${n.on ? 'on' : 'off'}`, message: n.said ?? undefined,
    actions: [{ label: 'Undo', onClick: () => { void undo(); } }], onClose: () => setN(null) }) : null;
  return { switched: (ref, name, on) => setN({ ref, name, on }), notice };
}
