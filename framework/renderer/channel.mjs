// The window's renderer channel to the Host (contracts/ipc.d.ts §3), as received from the preload.
// It carries Realm RPC for realm-client.mjs plus this runtime's own messages. One reader, two consumers:
//   - `realmPort`  {post, onMessage}: everything except `modules`, and except the replies to this runtime's own requests;
//   - `onModules`, `request()`: the runtime's own traffic. Request ids live in a high range so they never collide with
//     the ids realm-client allocates on the same channel ("unique per channel and per sender").
import { CodexModsError } from '../../sdk/errors.mjs';

export const REQUEST_ID_BASE = 1_000_000_000;

/**
 * @param {{ postMessage(m: unknown): void, addEventListener?(t: string, f: Function): void, removeEventListener?(t: string, f: Function): void, start?(): void, close?(): void, onmessage?: unknown }} port
 */
export function createHostChannel(port, { setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  const realm = new Set();
  const modules = new Set();
  const details = new Set();
  const acts = new Set();
  const asks = new Set();
  const runs = new Set(), declActs = new Set();
  const closers = new Set();
  const pending = new Map();
  let nextId = REQUEST_ID_BASE;
  let closed = false;

  const dispatch = (ev) => {
    const m = ev?.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'result' && typeof m.id === 'number' && m.id >= REQUEST_ID_BASE) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearT(p.timer);
      if (m.error) p.reject(CodexModsError.fromJSON(m.error)); else p.resolve(m.value);
      return;
    }
    if (m.t === 'modules') { for (const f of [...modules]) f(m.modules); return; }
    if (m.t === 'detail') { for (const f of [...details]) f(m.ref); return; }   // Window.open of an instance the app has no page for (S11)
    if (m.t === 'act') { for (const f of [...acts]) f(m); return; }   // an operation on one of this window's presentations (E7)
    // a mod's question to the user, or its end (E7.6c); a mod's notification as a toast here, or its end (public-hooks.md §3.14)
    if (m.t === 'ask' || m.t === 'askEnd' || m.t === 'notice' || m.t === 'noticeEnd') { for (const f of [...asks]) f(m); return; }
    if (m.t === 'rule-run') { for (const f of [...runs]) f(m); return; }   // a renderer-realm rule's function to run here (a menu bar entry, E8.4)
    if (m.t === 'decl-act') { for (const f of [...declActs]) f(m); return; }   // one of a mod's declarations acted on here (graph-layers.md §3.1)
    for (const f of [...realm]) f(m);
  };
  if (port.addEventListener) { port.addEventListener('message', dispatch); port.addEventListener('close', () => closeAll()); port.start?.(); }
  else port.onmessage = dispatch;

  function closeAll() {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) { clearT(p.timer); p.reject(new CodexModsError('Disposed', 'the renderer channel closed')); }
    pending.clear();
    for (const f of [...closers]) f();
  }
  const sub = (set, fn) => { set.add(fn); return { dispose() { set.delete(fn); } }; };
  const post = (m) => { if (closed) throw new CodexModsError('Disposed', 'the renderer channel is closed'); port.postMessage(m); };

  return {
    post,
    /** Fire-and-forget; never throws (a closed channel drops the message). */
    send(m) { try { post(m); } catch { /* channel closed: nothing to tell */ } },
    /** Send a request whose reply arrives as a Realm `result`. */
    request(message, { timeoutMs = 15_000 } = {}) {
      if (closed) return Promise.reject(new CodexModsError('Disposed', 'the renderer channel is closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setT(() => { if (pending.delete(id)) reject(new CodexModsError('Timeout', `no answer from the Host for ${message.t}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { port.postMessage({ ...message, id }); } catch (e) { pending.delete(id); clearT(timer); reject(e); }
      });
    },
    onModules: (fn) => sub(modules, fn),
    onDetail: (fn) => sub(details, fn),
    onAct: (fn) => sub(acts, fn),
    onAsk: (fn) => sub(asks, fn),
    onRuleRun: (fn) => sub(runs, fn),
    onDeclAct: (fn) => sub(declActs, fn),
    onClose: (fn) => sub(closers, fn),
    /** RealmPort shape for realm-client.mjs. */
    realmPort: { post, onMessage: (fn) => sub(realm, fn), onClose: (fn) => sub(closers, fn) },
    close() { closeAll(); try { port.close?.(); } catch { /* already closed */ } },
    get closed() { return closed; },
  };
}
