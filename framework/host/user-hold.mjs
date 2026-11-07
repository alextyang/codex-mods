// An action framework-main held before it happens (docs/design/public-hooks.md §3.5: a setting the user changes, the app's own
// notification, the user's unpins, marks read and automations): it passes the mods' interceptors and policies, with the user (or the app,
// for its notification) as the caller. The answer is go (with the arguments as they ended and who changed them), not (and why), or handled
// (a mod did it in the app's place: what it made goes back). `changes: false`: a place that cannot show who changed it, so a change is
// refused. Once it went, framework-main says what it did (`user-hold-done`): the mods' `after` records say that.
// A held action is never let through undecided (§3.7 "Faults"): it goes on unchanged only when nothing holds it now (the graph's own
// release codes say so, never an error's text). An instance the graph did not have yet is read first and decided again (an automation
// made a moment ago); one it still lacks then, an interceptor that failed before deciding, or arguments that do not map, refuse it.
// Node built-ins only.
import { createAbort } from './graph/abort.mjs';

/** The graph's release codes that let a held action go on unchanged: nothing holds it now, nor can (the graph is gone, its type has no
 * such operation, no caller). Any other release (an unknown instance once read, invalid arguments, undecided) refuses it. */
const GOES_ON = new Set(['no-interceptor', 'no-operation', 'no-caller', 'closed']);
const LOAD_MS = 5000;   // how long an unknown instance is waited for

/** The mods (and their policies) that changed a call, as the place it happened names them: `[{mod, name, policy?}]`. */
export const changersOf = (call, nameOf = (id) => id) => (Array.isArray(call?.changers) ? call.changers : []).map((ch) => {
  const mod = String(ch.owner).replace(/^mod:/, '');
  return { mod, name: nameOf(mod) ?? mod, ...(ch.policy ? { policy: ch.policy.title } : {}) };
});

/**
 * @param {{ requestId: string, ref: object, operation: string, args?: unknown[], origin?: string, changes?: boolean }} msg  framework-main's `user-hold`
 * @param {{ graph: object | null, heldMain: ReturnType<typeof import('./graph/held-actions.mjs').createHeldActions>, heldAborts: Map<string, object>,
 *   post: (msg: object) => void, log: object, nameOf?: (modId: string) => string, fresh?: (ref: object) => Promise<unknown> | unknown }} o
 *   `fresh(ref)`: the instance read again before it is decided on (a repository's branch): false when it could not be (then refused, as
 *   is one not read in time), null when it need not be; `refused(msg, message)`: a refusal told
 * @returns {Promise<void>} settles once the answer was posted
 */
export function decideUserHold(msg, { graph, heldMain, heldAborts, post, log, nameOf = (id) => id, fresh = null, refused = null }) {
  // a refusal the page does not show itself is told (`refused(msg, message)`: a skill's install, whose page only stops its spinner)
  const answer = (fields) => {
    post({ type: 'user-hold-answer', requestId: msg.requestId, ...fields });
    if (fields.go === false && !fields.handled && !fields.stopped && typeof refused === 'function') { try { refused(msg, fields.message ?? 'not allowed'); } catch { /* telling is best effort */ } }
  };
  const ref = msg.ref && typeof msg.ref === 'object' ? msg.ref : null;
  if (!graph || !ref || typeof msg.operation !== 'string' || typeof msg.requestId !== 'string') { answer({ go: true }); return Promise.resolve(); }
  // the user's own action, or the app's own (a notification it shows: origin app)
  const caller = msg.origin === 'app' ? { kind: 'app', id: 'app', owner: 'app' } : { kind: 'user', id: 'user', owner: 'app' };
  const args = Array.isArray(msg.args) ? msg.args : [];
  let went = false;
  const abort = createAbort();
  heldAborts.set(msg.requestId, abort);
  const decide = () => graph.interceptApp({ ref, operation: msg.operation, args, caller, origin: 'app', signal: abort.signal }, (a, call) => {
    const changedBy = changersOf(call, (id) => { try { return nameOf(id); } catch { return id; } });
    if (changedBy.length && msg.changes === false) return { status: 'refused', reason: 'unsupported', message: `${changedBy.map((c) => c.mod).join(', ')} would change it, and a change cannot be shown here` };
    went = true;
    answer({ go: true, args: a, ...(changedBy.length ? { changedBy } : {}) });
    return heldMain.completion(msg.requestId);
  });
  // an instance the graph does not have yet is read first (a full view: its provider loads it; a core view asks only for a message's or a
  // step's) and decided again
  const decided = () => decide().then((d) => {
    if (d.decision !== 'release' || d.code !== 'unknown-instance' || abort.signal.aborted || typeof graph.subscribe !== 'function') return d;
    const view = graph.subscribe({ ref }, () => true);
    return Promise.race([view.loaded, new Promise((r) => { const t = setTimeout(r, LOAD_MS); t.unref?.(); })]).finally(() => view.dispose()).then(() => decide());
  });
  // the instance as it is now first (a repository's branch: its provider reads it again; built review H6m2a), within LOAD_MS; never decided
  // on what was read before (round 2: a read that failed or did not come in time refuses it)
  const now = typeof fresh === 'function'
    ? Promise.race([Promise.resolve().then(() => fresh(ref)).catch(() => false), new Promise((r) => { const t = setTimeout(() => r(false), LOAD_MS); t.unref?.(); })])
    : Promise.resolve(null);
  return now.then((read) => (read === false ? { decision: 'stale' } : decided())).finally(() => heldAborts.delete(msg.requestId)).then((d) => {
    if (went || abort.signal.aborted) return;
    if (d.decision === 'stale') {
      log.warn('a held app action\'s instance could not be read now: refused', { operation: msg.operation });
      answer({ go: false, message: 'it could not be decided (it could not be read as it is now)' });
      return;
    }
    if (d.decision === 'release' && !GOES_ON.has(d.code)) {
      log.warn('a held app action was not decided: refused', { operation: msg.operation, why: d.reason ?? null });
      answer({ go: false, message: `it could not be decided (${d.reason ?? 'no answer'})` });
      return;
    }
    if (d.decision === 'release') { heldMain.released(msg.requestId, { ref, operation: msg.operation, args, caller, origin: 'app' }); answer({ go: true }); return; }
    // a mod did it in the app's place: what it made goes back (an automation's ref, for the app's own answer)
    if (d.decision === 'handled') { answer({ go: false, handled: true, ...(d.outcome?.value !== undefined ? { value: d.outcome.value } : {}) }); return; }
    // a mod stopped it (graph-integrity G6.2): the place ends its action without an error and keeps what the user had
    if (d.decision === 'stopped') { answer({ go: false, stopped: true, by: d.outcome?.by?.id ?? null, ...(d.outcome?.message ? { message: d.outcome.message } : {}) }); return; }
    answer({ go: false, message: d.outcome?.message ?? d.outcome?.error?.message ?? d.reason ?? 'not allowed' });
  }, (e) => {
    log.warn('a held app action could not be decided: refused', { message: String(e?.message ?? e) });
    if (!went) answer({ go: false, message: 'it could not be decided' });
  });
}

/**
 * A held click on one of the app's menu bar entries (H6m3b: framework/main/areas/menus.cjs asks with `{type: 'MenuEntry', provider:
 * 'framework', path}`): the user's run of the Command the entry names (`windows.menuEntryCommand(path)`), marked `menu` (a refusal is told
 * in the window, the menu having closed); an entry that names none, or one not known, has no ref (it goes on). Any other message as it is.
 */
export function menuEntryHold(msg, windows) {
  if (msg?.ref?.type !== 'MenuEntry' || msg.ref.provider !== 'framework') return msg;
  let ref;
  try { ref = windows?.menuEntryCommand?.(msg.ref.path) ?? null; } catch { ref = null; }
  return { ...msg, ref, operation: 'run', menu: true };
}
