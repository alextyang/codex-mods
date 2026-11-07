// Host side of one Realm RPC channel (contracts/ipc.d.ts §2): a worker thread, a window's renderer runtime, or a mod process.
// Wire conventions beyond the contract (refused registrations, event data shapes) are documented in framework/shared/realm-client.mjs.
// A Channel owns the subscriptions and handler registrations the realm made through it, and the host→realm `invoke`s in flight.
import { CodexModsError } from '../../../sdk/errors.mjs';

const REALM_OF = { worker: 'host', renderer: 'renderer', process: 'process' };
// Flow control (contracts/ipc.d.ts §2, docs/design/breadth.md D0.3): a crediting subscription's source is told to pause once this many of
// its events are unacknowledged, and resumed when the realm has caught up to FLOW_RESUME.
export const FLOW_WINDOW = 256;
const FLOW_RESUME = 64;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class Channel {
  /**
   * @param {object} o
   * @param {object} o.rt            runtime internals: {namespaces, scopeFor(channel, modId), log}
   * @param {import('../../../contracts/host.js').RealmPort} o.port
   * @param {'worker'|'renderer'|'process'} o.kind
   * @param {string} [o.boundModId]  worker and process channels: the only modId this channel may name
   * @param {{windowId?: number, modId?: string, process?: string}} [o.identity]
   * @param {(msg: any) => void} [o.onControl]  messages the channel does not handle itself (heartbeat, fault, probe, ...)
   */
  constructor({ rt, port, kind, boundModId, identity = {}, onControl }) {
    this.rt = rt; this.port = port; this.kind = kind; this.boundModId = boundModId; this.identity = identity;
    this.onControl = onControl;
    this.realm = REALM_OF[kind];
    this.closed = false;
    this.onClosed = undefined;
    this.regs = new Map();          // sub/handler number → {kind:'sub'|'handler', modId, dispose}
    this.pending = new Map();       // invoke id → {resolve, reject, timer}
    this.nextInvoke = 1;
    this.subMsg = port.onMessage((m) => { this.#dispatch(m).catch((e) => rt.log.error('realm dispatch failed', { message: String(e?.message ?? e) })); });
    this.subClose = port.onClose?.(() => this.close());
  }

  /**
   * A subscription's event. Returns false when the source should pause: the channel is closed, or a crediting realm has FLOW_WINDOW events
   * unacknowledged (its `ack` resumes the source). Events before the registration is recorded are dropped (the source holds its first ones).
   */
  #emit(number, data) {
    const r = this.regs.get(number);
    if (!r) return true;
    if (!this.post({ t: 'event', sub: number, data })) return false;
    if (!r.credit || ++r.inflight < FLOW_WINDOW) return true;
    r.paused = true;
    return false;
  }

  /** @returns {boolean} true if the message was handed to the port */
  post(message) {
    if (this.closed) return false;
    try { this.port.post(message); return true; } catch (e) { this.rt.log.warn('realm post failed', { message: String(e?.message ?? e) }); return false; }
  }

  #reply(id, value, error) {
    if (error) {
      const e = error instanceof CodexModsError ? error : this.#internal(error);
      this.post({ t: 'result', id, error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } });
    } else this.post(value === undefined ? { t: 'result', id } : { t: 'result', id, value });
  }
  #internal(e) {
    this.rt.log.error('internal error in a context call', { message: String(e?.message ?? e) });
    return new CodexModsError('Unavailable', 'internal error');
  }
  #regError(number, e) {
    const err = e instanceof CodexModsError ? e : this.#internal(e);
    this.post({ t: 'event', sub: number, error: { code: err.code, message: err.message } });
  }

  #scope(modId) {
    if (typeof modId !== 'string' || !modId) throw new CodexModsError('Invalid', 'modId is required');
    if (this.boundModId !== undefined && modId !== this.boundModId) {
      throw new CodexModsError('Denied', `this channel is bound to ${this.boundModId}, not ${modId}`);
    }
    return this.rt.scopeFor(this, modId);
  }
  #entry(kind, ns, method) {
    const table = typeof ns === 'string' && Object.hasOwn(this.rt.namespaces, ns) ? this.rt.namespaces[ns] : undefined;
    const group = table?.[kind];
    const fn = group && typeof method === 'string' && Object.hasOwn(group, method) ? group[method] : undefined;
    if (typeof fn !== 'function') {
      const what = kind === 'calls' ? 'method' : kind === 'subs' ? 'subscription' : 'handler';
      throw new CodexModsError('Invalid', `unknown ${what} ${String(ns)}.${String(method)}`);
    }
    return fn;
  }

  async #dispatch(msg) {
    if (this.closed || !isObject(msg)) return;
    switch (msg.t) {
      case 'call': {
        if (!posInt(msg.id)) return;
        try {
          if (!Array.isArray(msg.args)) throw new CodexModsError('Invalid', 'args must be an array');
          const scope = this.#scope(msg.modId);
          const fn = this.#entry('calls', msg.ns, msg.method);
          this.#reply(msg.id, await fn(scope, ...msg.args));
        } catch (e) { this.#reply(msg.id, undefined, e); }
        return;
      }
      case 'sub': {
        if (!posInt(msg.sub)) return;
        try {
          if (!Array.isArray(msg.args)) throw new CodexModsError('Invalid', 'args must be an array');
          if (this.regs.has(msg.sub)) throw new CodexModsError('Conflict', 'registration number already in use');
          const scope = this.#scope(msg.modId);
          const fn = this.#entry('subs', msg.ns, msg.method);
          const number = msg.sub;
          const d = fn(scope, msg.args, (data) => this.#emit(number, data));
          this.regs.set(number, { kind: 'sub', modId: msg.modId, dispose: () => d?.dispose?.(), resume: () => d?.resume?.(), credit: msg.credit === true, inflight: 0, paused: false });
        } catch (e) { this.#regError(msg.sub, e); }
        return;
      }
      case 'handler': {
        if (!posInt(msg.handler)) return;
        try {
          if (!Array.isArray(msg.args)) throw new CodexModsError('Invalid', 'args must be an array');
          if (this.regs.has(msg.handler)) throw new CodexModsError('Conflict', 'registration number already in use');
          const scope = this.#scope(msg.modId);
          const fn = this.#entry('handlers', msg.ns, msg.method);
          const number = msg.handler;
          const d = fn(scope, msg.args, (args, deadlineMs, deadlineCode) => this.invoke(number, args, deadlineMs, deadlineCode));
          this.regs.set(number, { kind: 'handler', modId: msg.modId, dispose: () => d?.dispose?.() });
        } catch (e) { this.#regError(msg.handler, e); }
        return;
      }
      case 'ack': {
        const r = this.regs.get(msg.sub);
        if (!r || r.kind !== 'sub' || !r.credit || !posInt(msg.n)) return;
        r.inflight = Math.max(0, r.inflight - msg.n);
        if (r.paused && r.inflight <= FLOW_RESUME) { r.paused = false; try { r.resume(); } catch (e) { this.rt.log.warn('resuming a subscription failed', { message: String(e?.message ?? e) }); } }
        return;
      }
      case 'unsub': case 'unhandler': {
        const number = msg.t === 'unsub' ? msg.sub : msg.handler;
        const r = this.regs.get(number);
        if (r) { this.regs.delete(number); try { r.dispose(); } catch { /* ignore */ } }
        return;
      }
      case 'return': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new CodexModsError(msg.error.code, msg.error.message, msg.error.details));
        else p.resolve(msg.value === undefined ? null : msg.value);
        return;
      }
      default:
        this.onControl?.(msg);
    }
  }

  /**
   * Call a handler registered in the realm. Outcome truthfulness: if the invoke was never handed to the realm the call fails
   * Unavailable (nothing ran); once it has been dispatched, the realm going away or the reply deadline passing is
   * OutcomeUnknown (the handler may have run and had effects).
   */
  invoke(handler, args, deadlineMs, deadlineCode = 'OutcomeUnknown') {
    if (this.closed) return Promise.reject(new CodexModsError('Unavailable', 'the realm is gone'));
    return new Promise((resolve, reject) => {
      const id = this.nextInvoke++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexModsError(deadlineCode, 'the realm did not answer within its deadline; the handler may have run'));
      }, deadlineMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.post({ t: 'invoke', id, handler, args, deadlineMs })) {
        this.pending.delete(id); clearTimeout(timer);
        reject(new CodexModsError('Unavailable', 'the invocation could not be dispatched'));
      }
    });
  }

  /** Dispose every subscription and handler this channel holds for one mod (mod deactivated). */
  closeMod(modId) {
    for (const [number, r] of [...this.regs]) {
      if (r.modId !== modId) continue;
      this.regs.delete(number);
      try { r.dispose(); } catch { /* ignore */ }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.subMsg?.dispose?.(); this.subClose?.dispose?.();
    for (const r of this.regs.values()) { try { r.dispose(); } catch { /* ignore */ } }
    this.regs.clear();
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new CodexModsError('OutcomeUnknown', 'the realm went away after the invocation was dispatched; it may have run')); this.pending.delete(id); }
    this.onClosed?.();
  }
}
