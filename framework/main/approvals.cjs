'use strict';
// The user's approval of a mod's one-time action, shown in framework-main (docs/design/runtime-core.md R17; the Host's side is
// framework/host/graph/approvals.mjs). The Host sends `approval-ask` with the prompt's text; this module shows it as the app's native dialog
// (the Electron adapter's `askUser`), outside every page, so no mod's code can answer it, and answers `approval-answer` with what the user
// chose. `approval-close` closes a prompt nobody answered (its call was cancelled or timed out); a closed prompt gets no answer.
// Without the adapter's dialog nothing can be asked: every request is answered no.

const MAX = { message: 400, detail: 1200, checkbox: 200 };
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @param {{ askUser?: (o: object) => Promise<{ allowed: boolean, checked: boolean }>, send(msg: object): void, log?: { info(m: string, d?: unknown): void, warn?(m: string, d?: unknown): void } }} o
 * @returns {{ ask(msg: object): Promise<void>, close(msg: object): void, open(): number }}
 */
function createApprovalPrompts(o) {
  const open = new Map();   // requestId -> AbortController
  const say = (m, d) => { try { (o.log?.warn ?? o.log?.info)?.call(o.log, m, d); } catch { /* logging never breaks this module */ } };
  const note = (m, d) => { try { o.log?.info?.(m, d); } catch { /* ditto */ } };
  const answer = (requestId, approved, stopAsking) => { try { o.send({ type: 'approval-answer', requestId, approved, stopAsking }); } catch (e) { say('approvals: the answer to the Host failed', { message: String(e && e.message || e) }); } };
  return {
    async ask(msg) {
      const requestId = msg && typeof msg.requestId === 'string' && msg.requestId.length <= 200 ? msg.requestId : null;
      if (!requestId || open.has(requestId)) return;
      const message = text(msg.message, MAX.message);
      if (!message || typeof o.askUser !== 'function') { answer(requestId, false, false); return; }
      const ac = new AbortController();
      open.set(requestId, ac);
      note('approvals: prompt shown', { requestId });
      try {
        const r = await o.askUser({ message, detail: text(msg.detail, MAX.detail), checkboxLabel: text(msg.checkbox, MAX.checkbox) || undefined, signal: ac.signal });
        if (open.get(requestId) !== ac) { note('approvals: prompt closed unanswered', { requestId }); return; }   // closed by the Host: no answer
        note('approvals: prompt answered', { requestId, allowed: r && r.allowed === true, stopAsking: r && r.checked === true });
        answer(requestId, r && r.allowed === true, r && r.checked === true);
      } catch (e) {
        say('approvals: the dialog failed', { message: String(e && e.message || e) });
        if (open.get(requestId) === ac) answer(requestId, false, false);
      } finally {
        if (open.get(requestId) === ac) open.delete(requestId);
      }
    },
    close(msg) {
      const ac = msg && open.get(msg.requestId);
      if (!ac) return;
      open.delete(msg.requestId);
      ac.abort();
    },
    open: () => open.size,
  };
}

/** framework-main module entry (contracts/main-hooks.d.ts): must not throw. */
function register(hooks) {
  try {
    const e = hooks.electron;
    const prompts = createApprovalPrompts({ askUser: e && typeof e.askUser === 'function' ? (x) => e.askUser(x) : undefined, send: hooks.sendToHost, log: hooks.log });
    hooks.onHostMessage('approval-ask', (msg) => { prompts.ask(msg); });
    hooks.onHostMessage('approval-close', (msg) => prompts.close(msg));
  } catch (err) {
    try { hooks.log.error('approvals register failed', { message: String((err && err.message) || err) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, createApprovalPrompts };
