// Acting through the graph from the framework's own pages (docs/design/systems.md E6.2): what an operation's outcome says when it did not
// do the thing, and a hook that runs operations by key and keeps what each one last said. NO NODE API.

/** What an outcome says when the operation did not happen: null when it did. */
export function refusalOf(out) {
  if (!out || typeof out !== 'object' || !out.status || out.status === 'done') return null;
  if (out.status === 'uncertain') return 'It is not known whether it happened.';
  return String(out.error?.message ?? out.message ?? (out.status === 'refused' ? 'Not allowed now' : 'It failed'));
}

/**
 * A hook: `run(key, ref, operation, args)` invokes it through the graph and answers `{ ok, message, value }` (`value`: an Operation's
 * ref for the framework's lifecycle operations); `busy(key)` while it runs; `error(key)` what the last one said when it did not happen; `clear(key)` forgets
 * that, as a Dialog opened again starts with nothing said.
 * @param {object} R  the app's React
 * @param {(ref: object, operation: string, args?: unknown[]) => Promise<object>} invoke
 */
export function useActing(R, invoke) {
  const [state, setState] = R.useState(() => ({ busy: {}, errors: {} }));
  async function run(key, ref, operation, args = []) {
    setState((s) => ({ busy: { ...s.busy, [key]: true }, errors: { ...s.errors, [key]: null } }));
    let message = null, value = null;
    try { const out = await invoke(ref, operation, args); message = refusalOf(out); value = out?.value ?? null; } catch (e) { message = String(e?.message ?? e); }
    setState((s) => ({ busy: { ...s.busy, [key]: false }, errors: { ...s.errors, [key]: message } }));
    return { ok: message === null, message, value };
  }
  const clear = (key) => setState((s) => (s.errors[key] == null ? s : { ...s, errors: { ...s.errors, [key]: null } }));
  return { run, clear, busy: (key) => state.busy[key] === true, error: (key) => state.errors[key] ?? null };
}
