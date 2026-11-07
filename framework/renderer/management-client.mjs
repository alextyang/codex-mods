// Client for the Adjustments management port (contracts/management.d.ts over a MessagePort: same objects as the CLI socket,
// no token). Handed to the built-in Adjustments module as `management`.
//   call(method, params) → Promise<result>      rejects CodexModsError (the Host's {code,message,details})
//   subscribe(fn) → Disposable                  ManagementEvent lines ({event:'op'|'mods'|'compat'|'health', data}); sends events.subscribe once
import { CodexModsError } from '../../sdk/errors.mjs';

export function createManagementClient(port, { setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout, timeoutMs = 30_000 } = {}) {
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  let subscribed = null;
  let closed = false;

  const onMessage = (ev) => {
    const m = ev?.data;
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearT(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(CodexModsError.fromJSON(m.error ?? { code: 'Unavailable', message: 'management call failed' }));
    } else if (typeof m.event === 'string') {
      for (const f of [...listeners]) { try { f(m); } catch { /* subscriber fault */ } }
    }
  };
  if (port.addEventListener) { port.addEventListener('message', onMessage); port.start?.(); } else port.onmessage = onMessage;

  function call(method, params) {
    if (closed) return Promise.reject(new CodexModsError('Disposed', 'the management channel is closed'));
    const id = `m${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setT(() => { if (pending.delete(id)) reject(new CodexModsError('Timeout', `management ${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage(params === undefined ? { id, method } : { id, method, params }); } catch (e) { pending.delete(id); clearT(timer); reject(e); }
    });
  }
  return {
    call,
    request: call,
    subscribe(fn) {
      listeners.add(fn);
      subscribed ??= call('events.subscribe', {}).catch(() => { subscribed = null; });
      return { dispose() { listeners.delete(fn); } };
    },
    close() { closed = true; for (const [, p] of pending) { clearT(p.timer); p.reject(new CodexModsError('Disposed', 'the management channel closed')); } pending.clear(); listeners.clear(); try { port.close?.(); } catch { /* gone */ } },
  };
}
