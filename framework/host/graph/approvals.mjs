// The user's approval of a mod's one-time action (docs/design/runtime-core.md R17; ARCHITECTURE.md 6.8). Some operations change what lasts
// beyond the call (a standing permission, an app's computer-use level), so a mod that asks for one gets a prompt the user answers each time:
// framework-main shows it as the app's native dialog (framework/main/approvals.cjs), outside every page, so no mod's code can answer it.
// There is no "always allow": each call asks. The prompt says which mod asks and what it would do ("“Mod” wants to <action>."), with
// Don't Allow as the default and a checkbox to stop that mod asking for that operation until the app restarts.
// - One prompt at a time: the others wait, in order (at most QUEUE_MAX); a mod with a request already waiting or shown is answered no at once.
// - A request nobody answers in `timeoutMs`, or whose call is cancelled, closes as not allowed (the dialog closes with it).
// - Without framework-main (headless) nobody can be asked: not allowed.
// Node built-ins only.
import { randomBytes } from 'node:crypto';

const QUEUE_MAX = 8;
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * @param {{ send?: (msg: object) => void, nameOf?: (modId: string) => string, log?: { info(m: string, d?: unknown): void, warn(m: string, d?: unknown): void },
 *   timeoutMs?: number }} [o]
 */
export function createApprovals(o = {}) {
  const log = o.log ?? { info() {}, warn() {} };
  const timeoutMs = o.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const prefix = randomBytes(4).toString('hex');
  const queue = [];               // waiting requests, in order: {requestId, modId, key, msg, resolve, signalSub}
  let shown = null;               // the request on screen, or null
  const stopped = new Set();      // `${modId}\n${operation}` the user asked not to hear about again (this Host's life)
  let seq = 0;
  let disposed = false;

  const nameOf = (modId) => { try { return o.nameOf?.(modId) || modId; } catch { return modId; } };
  function finish(req, approved, reason) {
    if (req.done) return;
    req.done = true;
    clearTimeout(req.timer);
    req.signalSub?.dispose();
    const i = queue.indexOf(req);
    if (i >= 0) queue.splice(i, 1);
    if (shown === req) { shown = null; if (!req.answered && req.sent) post({ type: 'approval-close', requestId: req.requestId }); }   // closed here, not by the user
    log.info('graph approval', { mod: req.modId, operation: req.key, approved, ...(reason ? { reason } : {}) });
    req.resolve(approved ? { approved: true } : { approved: false, reason });
    next();
  }
  function post(msg) { try { o.send?.(msg); return true; } catch (e) { log.warn('approvals: framework-main could not be told', { message: String(e?.message ?? e) }); return false; } }
  function next() {
    if (shown || disposed) return;
    const req = queue.shift();
    if (!req) return;
    shown = req;
    req.sent = post(req.msg);
    if (!req.sent) finish(req, false, 'the user could not be asked');
  }

  return {
    /**
     * Ask the user whether a mod may do something. `operation` names the kind of action (for "don't ask again"), `action` says what it would
     * do in a few words that follow "wants to", `detail` a sentence or two more.
     * @param {{ modId: string, operation: string, action: string, detail?: string, signal?: { aborted?: boolean, onAbort?(fn: () => void): { dispose(): void } } }} q
     * @returns {Promise<{ approved: true } | { approved: false, reason: string }>}
     */
    ask(q) {
      if (disposed) return Promise.resolve({ approved: false, reason: 'the Host is shutting down' });
      if (typeof o.send !== 'function') return Promise.resolve({ approved: false, reason: 'the user cannot be asked here' });
      const key = String(q.operation);
      if (stopped.has(`${q.modId}\n${key}`)) return Promise.resolve({ approved: false, reason: 'the user asked not to be asked again' });
      if ((shown && shown.modId === q.modId) || queue.some((r) => r.modId === q.modId)) return Promise.resolve({ approved: false, reason: 'another request from this mod is waiting for the user' });
      if (queue.length >= QUEUE_MAX) return Promise.resolve({ approved: false, reason: 'too many requests are waiting for the user' });
      if (q.signal?.aborted) return Promise.resolve({ approved: false, reason: 'cancelled' });
      return new Promise((resolve) => {
        const requestId = `${prefix}-${++seq}`;
        const name = nameOf(q.modId);
        // a policy that asks (public-hooks.md §3.7): its own question, said as the mod's policy; no "don't ask again" (turn it off on its page)
        const msg = q.policy ? {
          type: 'approval-ask', requestId,
          message: String(q.policy.title).slice(0, 300),
          detail: [String(q.policy.message ?? '').slice(0, 900), `Asked by “${String(q.policy.name ?? '').slice(0, 100)}”, a policy of “${name}” (${q.modId}). You can turn it off on its page in Settings.`].filter(Boolean).join('\n\n'),
        } : {
          type: 'approval-ask', requestId,
          message: `“${name}” wants to ${String(q.action).slice(0, 300)}.`,
          // A mod names itself, so the prompt also says which mod it is by its id.
          detail: [String(q.detail ?? '').slice(0, 900), `Asked by the mod ${q.modId}. Codex Mods asks you each time.`].filter(Boolean).join('\n\n'),
          checkbox: `Don't ask again for “${name}” until Codex restarts`,
        };
        const req = { requestId, modId: q.modId, key, msg, resolve, done: false, sent: false, timer: null, signalSub: null };
        req.timer = setTimeout(() => finish(req, false, 'nobody answered'), timeoutMs);
        req.timer.unref?.();
        req.signalSub = q.signal?.onAbort?.(() => finish(req, false, 'cancelled')) ?? null;
        queue.push(req);
        next();
      });
    },
    /** framework-main's answer: `{requestId, approved, stopAsking}`. */
    settle(msg) {
      const req = shown && msg?.requestId === shown.requestId ? shown : null;
      if (!req) return;
      req.answered = true;
      if (!msg.approved && msg.stopAsking === true) stopped.add(`${req.modId}\n${req.key}`);
      finish(req, msg.approved === true, msg.approved === true ? undefined : 'the user did not allow it');
    },
    /** What is waiting and shown (diagnostics). */
    status: () => ({ shown: shown ? { mod: shown.modId, operation: shown.key } : null, waiting: queue.length, stopped: stopped.size }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const req of [...queue, ...(shown ? [shown] : [])]) finish(req, false, 'the Host is shutting down');
    },
  };
}
