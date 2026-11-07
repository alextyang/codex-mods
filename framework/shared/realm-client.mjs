// Realm side of Realm RPC (contracts/ipc.d.ts §2).
//
// NO NODE API HERE. This file runs in the mod worker thread, in the browser renderer and in mod processes, so it uses
// only ECMAScript built-ins. The one import, sdk/errors.mjs, is likewise Node-free.
//
// createRealmClient(port) takes a RealmPort-shaped object {post(message), onMessage(fn) → Disposable, onClose?(fn)} and
// returns {context(modId, realm, info), disposeAll(), close()}. One client serves one channel; on the renderer channel
// several mods share it (every message carries its modId).
//
// Wire conventions beyond contracts/ipc.d.ts (private to this file and framework/host/runtime/channel.mjs):
//   - sub and handler numbers come from one counter, so a registration number is unique across both kinds;
//   - `event.data` shapes: events.on → {topic, data}; appServer.observe → {message, info}; settings.onChange → the value;
//     storage.watch → string[]; processes.on → the event payload;
//   - the page's own runtime (not a mod) names the reserved modId 'codexmods.framework' on the renderer channel: the Host maps it to a
//     framework scope that reaches the reads of ctx.graph and `invoke` and nothing else (docs/design/presentations.md V6;
//     framework/host/runtime/index.mjs scopeFor), so `client.context('codexmods.framework', 'renderer', info).graph` is its graph;
//   - a registration the Host refuses (Denied, Conflict, ...) cannot throw synchronously, because the SDK returns a
//     Disposable. The Host sends {t:'event', sub, error:{code,message}} and the client reports it through opts.onError
//     (default: an asynchronous unhandled rejection, which the worker turns into a fault).
import { CodexModsError } from '../../sdk/errors.mjs';
import { RULES, createRuleApi } from './ui-rules-client.mjs';

const toError = (e) => {
  if (e instanceof CodexModsError) return { code: e.code, message: e.message };
  return { code: 'Invalid', message: String(e?.message ?? e) };
};
const isOutcome = (v) => v !== null && typeof v === 'object' && (v.status === 'done' || v.status === 'refused' || v.status === 'failed' || v.status === 'uncertain' || v.status === 'stopped');
/** Events of one subscription acknowledged at once; well below the Host's window (runtime/channel.mjs FLOW_WINDOW). */
const ACK_EVERY = 32;
/** A call's cancellation, shaped like the runtime's (contracts/graph.d.ts CancelSignal; ECMAScript only, so no AbortController). */
function createCancel() {
  const fns = new Set();
  const signal = {
    aborted: false, reason: null,
    onAbort(fn) { if (signal.aborted) { Promise.resolve().then(fn); return { dispose() {} }; } fns.add(fn); return { dispose() { fns.delete(fn); } }; },
  };
  return {
    signal,
    abort(reason) { if (signal.aborted) return; signal.aborted = true; signal.reason = reason; for (const fn of [...fns]) { try { fn(); } catch { /* the listener's own fault */ } } fns.clear(); },
  };
}
const disposable = (fn) => { let done = false; return { dispose() { if (done) return; done = true; return fn(); } }; };

/**
 * @param {{post(m: any): void, onMessage(fn: (m: any) => void): any, onClose?(fn: () => void): any}} port
 * @param {{onError?: (e: Error) => void, createScheduler?: typeof import('../../sdk/scheduler.mjs').createScheduler}} [opts]
   *   createScheduler: the worker passes sdk/scheduler.mjs (it needs timers, which this file may not name); without it a host
   *   context has no ctx.scheduler.
 */
export function createRealmClient(port, opts = {}) {
  let nextCall = 1;
  let nextReg = 1;
  const pending = new Map();      // call id → {resolve, reject}
  const regs = new Map();         // registration number → {kind:'sub'|'handler', fn, modId, unacked?}
  const owned = new Map();        // modId → Set<Disposable>
  let closed = false;
  const onError = opts.onError ?? ((e) => { Promise.reject(e); });

  const post = (m) => { if (!closed) port.post(m); };

  function call(modId, ns, method, args = []) {
    if (closed) return Promise.reject(new CodexModsError('Disposed', 'realm channel is closed'));
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      pending.set(id, { resolve, reject });
      try { port.post({ t: 'call', id, modId, ns, method, args }); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }
  /** Fire and forget: errors are swallowed (log, notify, emit). */
  const send = (modId, ns, method, args) => { call(modId, ns, method, args).catch(() => {}); };

  function track(modId, d) {
    let set = owned.get(modId);
    if (!set) owned.set(modId, (set = new Set()));
    const wrapped = disposable(() => { set.delete(wrapped); return d(); });
    set.add(wrapped);
    return wrapped;
  }
  function subscribe(modId, ns, method, args, fn) {
    const sub = nextReg++;
    regs.set(sub, { kind: 'sub', fn, modId, unacked: 0 });
    post({ t: 'sub', sub, modId, ns, method, args, credit: true });
    return track(modId, () => { if (regs.delete(sub)) post({ t: 'unsub', sub }); });
  }
  function register(modId, ns, method, args, fn) {
    const handler = nextReg++;
    regs.set(handler, { kind: 'handler', fn, modId });
    post({ t: 'handler', handler, modId, ns, method, args });
    return track(modId, () => { if (regs.delete(handler)) post({ t: 'unhandler', handler }); });
  }

  async function onInvoke(msg) {
    const reg = regs.get(msg.handler);
    if (!reg || reg.kind !== 'handler') {
      post({ t: 'return', id: msg.id, error: { code: 'Unavailable', message: 'handler is not registered' } });
      return;
    }
    try {
      const value = await reg.fn(msg.args ?? []);
      post({ t: 'return', id: msg.id, value: value === undefined ? null : value });
    } catch (e) {
      post({ t: 'return', id: msg.id, error: toError(e) });
    }
  }

  const messageSub = port.onMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'result': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(CodexModsError.fromJSON(msg.error)); else p.resolve(msg.value);
        return;
      }
      case 'event': {
        const reg = regs.get(msg.sub);
        if (!reg) return;
        if (msg.error) { regs.delete(msg.sub); onError(CodexModsError.fromJSON(msg.error)); return; }
        if (reg.kind !== 'sub') return;
        try { reg.fn(msg.data); } catch (e) { onError(e); }
        // Flow control (contracts/ipc.d.ts §2): handled events are acknowledged in batches; fewer than a batch never pause the Host.
        if (++reg.unacked >= ACK_EVERY) { post({ t: 'ack', sub: msg.sub, n: reg.unacked }); reg.unacked = 0; }
        return;
      }
      case 'invoke': onInvoke(msg); return;
      default: return; // modules/settings/activate/deactivate are handled by the embedder
    }
  });
  const closeSub = port.onClose?.(() => closeAll(new CodexModsError('Disposed', 'realm channel closed')));

  function closeAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    closed = true;
  }

  // ------------------------------------------------------------------ storage
  function storageApi(modId, ns) {
    const c = (method, ...args) => call(modId, ns, method, args);
    return {
      get: (key) => c('get', key),
      set: (key, value) => c('set', key, value),
      delete: (key) => c('delete', key),
      list: (prefix) => c('list', ...(prefix === undefined ? [] : [prefix])),
      async transaction(fn) {
        if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'transaction needs a function');
        const snap = await c('snapshot');
        const base = new Map(Object.entries(snap.data));
        const writes = new Map();           // key → {value} | {delete:true}
        const view = () => {
          const keys = new Set(base.keys());
          for (const [k, w] of writes) { if (w.delete) keys.delete(k); else keys.add(k); }
          return keys;
        };
        const tx = {
          get(key) {
            const w = writes.get(key);
            if (w) return w.delete ? undefined : structuredClone(w.value);
            return base.has(key) ? structuredClone(base.get(key)) : undefined;
          },
          set(key, value) {
            if (typeof key !== 'string' || key === '') throw new CodexModsError('Invalid', 'storage key must be a non-empty string');
            if (value === undefined) throw new CodexModsError('Invalid', 'storage value must be JSON');
            writes.set(key, { value: structuredClone(value) });
          },
          delete(key) { writes.set(key, { delete: true }); },
          list(prefix = '') { return [...view()].filter((k) => k.startsWith(prefix)).sort(); },
        };
        const result = fn(tx);
        if (result && typeof result.then === 'function') {
          throw new CodexModsError('Invalid', 'a transaction function must be synchronous');
        }
        if (writes.size) {
          const ops = [...writes].map(([key, w]) => (w.delete ? { op: 'delete', key } : { op: 'set', key, value: w.value }));
          await c('commit', snap.revision, ops);
        }
        return result;
      },
      watch: (prefix, fn) => subscribe(modId, ns, 'watch', [prefix], fn),
    };
  }

  // ------------------------------------------------------------------ mod intelligence (GOAL.md goal 16; reference-mods.md §2)
  /**
   * `ctx.intelligence`: the mod's model use, through the framework's internal mod `codexmods.intelligence`. `ask(spec)` starts a call (its
   * `model` service, which knows the caller) and serves it here, in this realm, through a service of the mod's own for that call alone
   * (only mod intelligence may call it): the tools the mod gives it (`tools: {name: {description, input, run(args)}}`, its actions), its
   * own storage (`storage: true`) and settings (`settings: true`) as tools, the text as it streams (`onText`), and the call's end. Its
   * answer is `{text, usage: {tokens}}`; a refusal (model use off, an allowance used, a limit) or a failure throws, saying why.
   */
  function intelligenceOf(ctx) {
    const INTELLIGENCE = 'codexmods.intelligence';
    const fromIntelligence = (caller) => caller?.kind === 'mod' && caller.id === INTELLIGENCE;
    const builtins = (storage, settings) => ({
      ...(storage ? {
        storage_get: { description: 'Read a value the mod keeps in its storage, by its key.', input: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
          run: async ({ key }) => ({ value: (await ctx.storage.get(String(key))) ?? null }) },
        storage_set: { description: 'Keep a value (JSON) in the mod\'s storage under a key.', input: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] },
          run: async ({ key, value }) => { await ctx.storage.set(String(key), value ?? null); return { value: 'kept' }; } },
        storage_keys: { description: 'List the keys the mod keeps in its storage, those starting with a prefix.', input: { type: 'object', properties: { prefix: { type: 'string' } } },
          run: async ({ prefix }) => ({ value: await ctx.storage.list(String(prefix ?? '')) }) },
      } : {}),
      ...(settings ? {
        settings_get: { description: 'Read the mod\'s settings (one by its key, or all).', input: { type: 'object', properties: { key: { type: 'string' } } },
          run: async ({ key }) => ({ value: typeof key === 'string' && key ? await ctx.settings.get(key) : await ctx.settings.get() }) },
        settings_set: { description: 'Change one of the mod\'s settings.', input: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] },
          run: async ({ key, value }) => { await ctx.settings.set(String(key), value); return { value: 'changed' }; } },
      } : {}),
    });
    let seq = 0;
    return {
      ask(spec = {}) {
        const { tools = {}, storage = false, settings = false, onText, ...rest } = spec ?? {};
        if (typeof rest.prompt !== 'string' || !rest.prompt.trim()) return Promise.reject(new CodexModsError('Invalid', 'ask needs a prompt'));
        const all = { ...builtins(storage === true, settings === true), ...(tools ?? {}) };
        const service = `intelligence:${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return new Promise((resolve, reject) => {
          // it ends when mod intelligence says so: its answer, a failure, its own time limit, the user's switch, or its stopping
          let handle = null, settled = false;
          const finish = (fn, v) => { if (settled) return; settled = true; try { handle?.dispose(); } catch { /* gone */ } fn(v); };
          handle = ctx.services.provide(service, {
            tool: async ({ name, args }, { caller }) => {
              if (!fromIntelligence(caller)) throw new CodexModsError('Denied', 'only mod intelligence answers here');
              const t = Object.hasOwn(all, name) ? all[name] : null;
              if (!t || typeof t.run !== 'function') return { ok: false, text: `no tool ${name}` };
              try { const v = await t.run(args ?? {}); return typeof v === 'string' ? { text: v } : { value: v?.value !== undefined ? v.value : v ?? null }; }
              catch (e) { return { ok: false, text: String(e?.message ?? e) }; }
            },
            text: ({ delta }, { caller }) => { if (fromIntelligence(caller) && typeof onText === 'function' && typeof delta === 'string') { try { onText(delta); } catch { /* the mod's */ } } return null; },
            done: (out, { caller }) => { if (fromIntelligence(caller)) finish(resolve, { text: String(out?.text ?? ''), usage: { tokens: Number(out?.usage?.tokens ?? 0) } }); return null; },
            failed: (out, { caller }) => { if (fromIntelligence(caller)) finish(reject, new CodexModsError('Unavailable', String(out?.message ?? 'the call failed'))); return null; },
          });
          const specs = Object.entries(all).map(([name, t]) => ({ name, description: String(t?.description ?? ''), inputSchema: t?.input ?? { type: 'object', properties: {} } }));
          ctx.services.call(INTELLIGENCE, 'model', 'start', { ...rest, tools: specs, service, stream: typeof onText === 'function' }).then((out) => {
            if (out?.status !== 'started') finish(reject, new CodexModsError(out?.reason === 'invalid' ? 'Invalid' : 'Denied', String(out?.message ?? 'mod intelligence did not start the call')));
            return null;
          }, (e) => finish(reject, e));
        });
      },
      /** This mod's model use: whether the user has it on, its model, its allowances and what it used (`declared: false` without one). */
      status: () => ctx.services.call(INTELLIGENCE, 'model', 'status', null),
    };
  }

  // ------------------------------------------------------------------ context
  function context(modId, realm, info) {
    if (realm !== 'host' && realm !== 'renderer' && realm !== 'process') throw new CodexModsError('Invalid', `unknown realm ${realm}`);
    const c = (ns, method, ...args) => call(modId, ns, method, args);
    const ctx = {
      mod: Object.freeze({ id: info.id, version: info.version, dataDir: info.dataDir }),
      log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) =>
        [level, (message, data) => send(modId, 'log', 'write', [level, String(message), data === undefined ? null : data])])),
      // get() is one flat document; get(key, {project?, thread?}), set and reset at a scope (docs/design/systems.md E3); onChange's second argument is what changed ({key, scope, value}).
      settings: {
        get: (key, opts) => (key === undefined ? c('settings', 'get') : c('settings', 'get', key, opts ?? {})),
        set: (key, value, opts) => c('settings', 'set', key, value, opts ?? {}),
        reset: (key, opts) => c('settings', 'reset', key, opts ?? {}),
        onChange: (fn) => subscribe(modId, 'settings', 'onChange', [], (d) => fn(d?.document, d?.change)),
      },
      storage: { ...storageApi(modId, 'storage'), retained: storageApi(modId, 'storage.retained') },
      // framework-ui.md F8: what it holds of its permissions, a request for an optional one, a change while it runs
      permissions: {
        state: (grant) => c('permissions', 'state', grant),
        request: (grant, text) => c('permissions', 'request', grant, text ?? {}),
        onChange: (fn) => subscribe(modId, 'permissions', 'onChange', [], (d) => fn(d?.grant, d?.decision)),
      },
      secrets: {
        get: (name) => c('secrets', 'get', name),
        set: (name, value) => c('secrets', 'set', name, value),
        delete: (name) => c('secrets', 'delete', name),
      },
      events: {
        on(topic, fn, o) {
          return subscribe(modId, 'events', 'on', [topic, o ?? {}], (d) => fn(d.data, d.topic));
        },
        emit(topic, data) {
          const own = `mod/${info.id}/`;
          if (typeof topic !== 'string' || !topic.startsWith(own) || topic.includes('*')) {
            throw new CodexModsError('Denied', `a mod may only emit topics under ${own}`);
          }
          send(modId, 'events', 'emit', [topic, data]);
        },
        state: (topic) => c('events', 'state', topic),
      },
      services: {
        provide(name, handlers) {
          if (!handlers || typeof handlers !== 'object') throw new CodexModsError('Invalid', 'handlers must be an object');
          const names = Object.keys(handlers);
          // a handler is told who called it (`{caller}`: `{kind: 'mod', id}`, `{kind: 'client', mod}` or `{kind: 'app'}`)
          return register(modId, 'services', 'provide', [name, names], ([method, args, caller]) => {
            if (!Object.hasOwn(handlers, method) || typeof handlers[method] !== 'function') {
              throw new CodexModsError('Invalid', `service ${name} has no method ${method}`);
            }
            return handlers[method](args, Object.freeze({ caller: caller ?? Object.freeze({ kind: 'app' }) }));
          });
        },
        call: (target, name, method, args) => c('services', 'call', target, name, method, args === undefined ? null : args),
      },
      appServer: {
        request: (method, params, o) => c('appServer', 'request', method, params === undefined ? null : params, o ?? {}),
        notify: (method, params, o) => send(modId, 'appServer', 'notify', [method, params === undefined ? null : params, o ?? {}]),
        observe: (filter, listener, o) => subscribe(modId, 'appServer', 'observe', [filter ?? {}, o ?? {}], (d) => listener(d.message, d.info)),
        backends: {
          define: (key, def) => c('appServer.backends', 'define', key, def ?? {}),
          remove: (key, o) => c('appServer.backends', 'remove', key, o ?? {}),
          list: () => c('appServer.backends', 'list'),
        },
        clients: {
          issue: (o) => c('appServer.clients', 'issue', o),
          revoke: (leaseId) => c('appServer.clients', 'revoke', leaseId),
        },
      },
    };
    ctx.intelligence = intelligenceOf(ctx);
    if (realm !== 'renderer') {
      ctx.appServer.intercept = (kind, methods, handler, o) =>
        register(modId, 'appServer', 'intercept', [kind, methods, o ?? {}], ([message, i]) => handler(message, i));
    }
    // ctx.graph, the members of the host and renderer realms (docs/design/presentations.md V6; needs the `graph` permission): the reads
    // and `invoke`, which the Host makes as the mod. The rest of ctx.graph is the host realm's only (below); the Host refuses it to a
    // renderer with Denied, and a renderer's ctx.graph does not offer it.
    const graphReads = {
      invoke: (ref, operation, args, opts) => (opts === undefined ? c('graph', 'invoke', ref, operation, args ?? []) : c('graph', 'invoke', ref, operation, args ?? [], opts)),
      can: (ref, operation) => c('graph', 'can', ref, operation),
      /** What a call would meet, nothing run (public-hooks.md §3.7): {status, reason?, by?}. */
      assess: (ref, operation, args, opts) => c('graph', 'assess', ref, operation, args ?? [], opts ?? {}),
      resolve: (ref) => c('graph', 'resolve', ref),
      list: (typeId, where) => c('graph', 'list', typeId, where ?? null),
      /** A page of a type's instances (public-hooks.md §3.2): {items, next?}; pass `next` as the cursor for the page after. */
      query: (q) => c('graph', 'query', q ?? {}),
      /** What matches a text among the searchable types: [{ref, title, field, snippet?}]. */
      search: (text, opts) => c('graph', 'search', text, opts ?? {}),
      /** The attached values on an instance this mod may see (docs/design/public-hooks.md §3.3). */
      attached: (ref) => c('graph', 'attached', ref),
      related: (ref, name) => c('graph', 'related', ref, name),
      types: () => c('graph', 'types'),
      /**
       * A realm view (R6): fn gets {type: 'snapshot' | 'delta' | 'complete' | 'stale', seq, ...}. The query may set `depth: 'core'`, and
       * `event` (entered, left, changed or a named event, or a list): only those deltas, each with `on` saying which, and no snapshot.
       */
      subscribe: (query, fn, o) => subscribe(modId, 'graph', 'subscribe', [query, o ?? {}], fn),
    };
    if (realm === 'renderer') ctx.graph = graphReads;
    // a mod's process reads and acts on the graph as its mod, under its grants (graph-integrity G8.2): the reads, a view and `invoke`
    if (realm === 'process') ctx.graph = graphReads;
    // The page's own runtime only (docs/design/presentations.md V6): the user's acts held for the mods, the Request behind a request card.
    // The Host refuses it to every other caller.
    if (realm === 'renderer' && modId === 'codexmods.framework') {
      ctx.present = { requestsOf: (ids) => c('present', 'requestsOf', Array.isArray(ids) ? ids : []),
        hold: (ref, operation, args, opts) => c('present', 'hold', ref, operation, Array.isArray(args) ? args : [], opts ?? {}),
        done: (token, outcome) => c('present', 'done', token, outcome ?? null),
        did: (ref, operation, args, outcome) => c('present', 'did', ref, operation, Array.isArray(args) ? args : [], outcome ?? null),
        mentioned: (draft, entry) => c('present', 'mentioned', draft, entry),
        automationDefaults: () => c('present', 'automationDefaults'),
        useTheme: (mod, id) => c('present', 'useTheme', mod ?? null, id ?? null),
        userAct: (ref, operation) => c('present', 'userAct', ref, operation),
        // the user's intent the page attests for a mod (graph-integrity G7.1), told to the Host as it is minted
        attest: (token, mod) => c('present', 'attest', token, mod),
        themes: (fn) => subscribe(modId, 'present', 'themes', [], fn),
        holds: (fn) => subscribe(modId, 'present', 'holds', [], fn) };
    }
    // The presentation rules (docs/design/systems.md S5, S6): the Host's `ui` namespace, behind a symbol (not an SDK member): the page builds
    // a mod's `ctx.ui` rule methods on it, and the page's own runtime follows every rule through it. The host realm gets its data rules
    // here, as `ctx.ui`.
    if (realm !== 'process') {
      ctx[RULES] = Object.freeze({
        register: (desc) => c('ui', 'register', desc),
        dispose: (id) => c('ui', 'dispose', id),
        inWindow: (id, op, args, window, reg) => c('ui', 'inWindow', id, op, args ?? {}, window ?? null, reg ?? null),
        parts: (presentation, slot) => c('ui', 'parts', presentation, slot ?? null),
        // A host-realm rule's callbacks (mod-surfaces.md P1): the Host invokes fn(path, env) here; the page reaches them by `callback`.
        callbacks: (id, reg, fn) => register(modId, 'ui', 'callbacks', [id, reg], ([path, env]) => fn(path, env)),
        callback: (key, reg, path, env) => c('ui', 'callback', key, reg, path, env),
        follow: (fn) => subscribe(modId, 'ui', 'rules', [], fn),
        // The page's own runtime reports its window's presentations (systems.md S10); the Host refuses every other caller.
        window: () => c('ui', 'window'),
        report: (gen, batch) => c('ui', 'report', gen, batch),
        acted: (gen, events) => c('ui', 'acted', gen, events),
        answer: (gen, id, outcome) => c('ui', 'answer', gen, id, outcome),
        // A mod's question to the user ("E7 in detail" decision 7), and the page's end of one in its window.
        ask: (spec) => c('ui', 'ask', spec),
        askWithdraw: (token) => c('ui', 'askWithdraw', token),
        askAnswer: (gen, id, outcome) => c('ui', 'askAnswer', gen, id, outcome),
        // A mod's notification (public-hooks.md §3.14): shown, ended, and what the user did with this mod's ones; the page's end of a toast.
        notify: (spec) => c('ui', 'notify', spec),
        notifyEnd: (id, token) => c('ui', 'notifyEnd', id, token ?? null),
        notices: (fn) => subscribe(modId, 'ui', 'notices', [], fn),
        noticeAnswer: (gen, id, outcome) => c('ui', 'noticeAnswer', gen, id, outcome),
      });
    }
    if (realm === 'host') {
      const rules = createRuleApi({ modId, realm: 'host', channel: ctx[RULES], graph: () => ctx.graph, onRefused: (id, e) => send(modId, 'log', 'write', ['warn', `presentation rule ${id} refused: ${String(e?.message ?? e)}`, null]) });
      track(modId, () => rules.disposeAll());
      ctx.ui = rules.api;
    }
    if (realm === 'host') {
      // ctx.scheduler (gate G-sched): durable jobs in the retained store, built lazily so a mod that never schedules pays nothing.
      // Recovery (started → uncertain) runs when the engine is first used, which for a scheduling mod is its activation.
      let engine;
      const sched = () => {
        if (!engine) {
          engine = opts.createScheduler({ store: ctx.storage.retained, onError: (e) => send(modId, 'log', 'write', ['error', `scheduler: ${String(e?.message ?? e)}`, null]) });
          track(modId, () => engine.close());
        }
        return engine;
      };
      if (opts.createScheduler) {
        ctx.scheduler = {
          schedule: (spec) => sched().schedule(spec),
          cancel: (id) => sched().cancel(id),
          on: (id, handler) => sched().on(id, handler),
          get: (id) => sched().get(id),
          list: (o) => sched().list(o),
        };
      }
      ctx.processes = {
        // a session's start may give more arguments and its folder (graph-integrity G8.2)
        start: (name, opts) => (opts === undefined ? c('processes', 'start', name) : c('processes', 'start', name, opts)),
        stop: (name) => c('processes', 'stop', name),
        /** A session's input, in order (G8.2). */
        write: (name, data) => c('processes', 'write', name, data),
        call: (name, method, params) => c('processes', 'call', name, method, params === undefined ? null : params),
        on: (name, event, fn) => subscribe(modId, 'processes', 'on', [name, event], fn),
      };
      // ctx.graph (runtime-core.md; docs/graph/04): the graph runtime; needs the `graph` permission. A definition crosses as its
      // descriptor, the same JSON copy without the builders' methods that the SDK's toDescriptor makes.
      const descriptor = (d) => JSON.parse(JSON.stringify(d));
      ctx.graph = {
        registerTypes: (defs) => c('graph', 'registerTypes', (Array.isArray(defs) ? defs : [defs]).map(descriptor)),
        /** This mod's value of a name on an instance, private unless `{shared: true}`; null removes it (docs/design/public-hooks.md §3.3). */
        attach: (ref, name, value, opts) => c('graph', 'attach', ref, name, value === undefined ? null : value, opts ?? {}),
        /**
         * Serve types: {types: {typeId: {operations?: {name: {effect, handler(call)}}, supports?}}, onObserve?(query), contributes?,
         * unverified?: {typeId: [member names]}}.
         * `contributes` (graph-integrity G3.4): [{type, via}], instances it links to others' through `via`, put when onObserve is asked
         * `{target, relation}`.
         */
        provide(spec) {
          if (!spec || typeof spec !== 'object' || !spec.types || typeof spec.types !== 'object') throw new CodexModsError('Invalid', 'provide needs {types}');
          const types = {};
          const handlers = new Map();
          for (const [typeId, impl] of Object.entries(spec.types)) {
            const operations = {};
            for (const [name, d] of Object.entries(impl?.operations ?? {})) {
              if (typeof d?.handler !== 'function') throw new CodexModsError('Invalid', `${typeId}.${name} needs a handler`);
              operations[name] = { effect: d.effect };
              handlers.set(`${typeId}\u0000${name}`, d.handler);
            }
            types[typeId] = { operations, supports: Array.isArray(impl?.supports) ? [...impl.supports] : [] };
          }
          const onObserve = typeof spec.onObserve === 'function' ? spec.onObserve : null;
          const contributes = Array.isArray(spec.contributes) ? spec.contributes.map((x) => ({ type: x?.type, via: x?.via })) : [];
          if (contributes.length && !onObserve) throw new CodexModsError('Invalid', 'a provider that contributes is asked for its contributions: it needs onObserve');
          // what it realizes that its own checks have not shown yet (graph-integrity G9.3): {type: [member names]}
          const unverified = spec.unverified && typeof spec.unverified === 'object' && !Array.isArray(spec.unverified) ? spec.unverified : null;
          const reg = register(modId, 'graph', 'provide', [{ types, observe: !!onObserve, ...(contributes.length ? { contributes } : {}), ...(unverified ? { unverified } : {}) }], ([kind, a, b, call]) => {
            if (kind === 'observe') return onObserve?.(a);
            const h = handlers.get(`${a}\u0000${b}`);
            if (!h) throw new CodexModsError('Unavailable', `no handler for ${a}.${b}`);
            return h(call);
          });
          return {
            put: (ref, data) => c('graph', 'put', ref, data ?? {}),
            update: (ref, data) => c('graph', 'update', ref, data ?? {}),
            remove: (ref) => c('graph', 'remove', ref),
            setComplete: (typeId, complete = true) => c('graph', 'setComplete', typeId, complete),
            markStale: (ids) => c('graph', 'markStale', ids ?? null),
            markLive: (ids) => c('graph', 'markLive', ids ?? null),
            emit: (ref, name, payload) => c('graph', 'emit', ref, name, payload ?? null),
            dispose: () => reg.dispose(),
          };
        },
        ...graphReads,
        /**
         * A policy (public-hooks.md §3.7): the Host runs it on every call of the operation, without this worker, this mod's own calls
         * included. `{id, accepted, dispose()}`: `accepted` rejects with the reason a policy is not one. Registering the same id replaces it.
         */
        policy(spec) {
          const accepted = c('graph', 'policy', spec);
          accepted.catch(() => {});
          const id = spec && typeof spec === 'object' ? spec.id : undefined;
          return { id, accepted, dispose: () => c('graph', 'unpolicy', id) };
        },
        /** This mod's policies, each with whether the user has it on (its page lists them with a switch). */
        policies: () => c('graph', 'policies'),
        /**
         * What a new chat starts with until the user chooses (public-hooks.md §3.8): `{id, of: 'Draft', where?, target?, content?}`.
         * `{id, accepted, dispose()}`; registering the same id replaces it.
         */
        defaults(spec) {
          const accepted = c('graph', 'defaults', spec);
          accepted.catch(() => {});
          const id = spec && typeof spec === 'object' ? spec.id : undefined;
          return { id, accepted, dispose: () => c('graph', 'undefaults', id) };
        },
        /**
         * Several changes, one approval (public-hooks.md §3.14): `[{ref, operation, args?}]`, made in order as the mod after the user
         * is asked once for all of them. The first outcome that is not done, with every call's in `outcomes`.
         */
        invokeAll: (calls, opts) => c('graph', 'invokeAll', calls, opts ?? {}),
        /** This mod's call by its own key (graph-integrity G6.3: `invoke(ref, op, args, {key})`): `{status, made?, at}` of the newest, or null. */
        made: (key) => c('graph', 'made', key),
        /**
         * A temporary change of Settings (public-hooks.md §3.14): `{id, set: [{ref, value}], until?}`. `{id, applied, restore()}`:
         * `applied` resolves with its outcome (the user is asked once for all of it); restore() gives the user's values back, as the
         * mod's stop, `until` and a restart after a crash do. The same id again replaces it.
         */
        override(spec) {
          const applied = c('graph', 'override', spec);
          applied.catch(() => {});
          const id = spec && typeof spec === 'object' ? spec.id : undefined;
          return { id, applied, restore: () => c('graph', 'unoverride', id) };
        },
        /**
         * After an operation (public-hooks.md §3.4): fn(record) once each call of it on an instance of the type this mod may read has
         * completed, whatever its outcome and whoever made it: {id, ref, operation, origin, args, effectiveArgs, changedBy?, outcome},
         * or {gap: n} when n were dropped. It never holds the call. opts: {where?}.
         */
        after(typeId, operation, fn, o) {
          if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'after takes a function (record) => void');
          return register(modId, 'graph', 'after', [typeId, operation, o ?? {}], async ([rec]) => { await fn(rec); return null; });
        },
        /**
         * Intercept an operation on a type and its subtypes (docs/design/interception.md I10): fn(call, next) runs here; `next(change?)`
         * ({args} to change the call) runs the rest of the chain in the Host and resolves with its outcome. fn returns that outcome, a
         * refusal, or (with `replaces`) an outcome of its own. A return value that is not an outcome stands for next()'s outcome when fn
         * called next. opts: {priority?, replaces?, deadlineMs?}.
         */
        intercept(typeId, operation, fn, o) {
          if (typeof typeId !== 'string' || typeof operation !== 'string') throw new CodexModsError('Invalid', 'intercept needs a type id and an operation name');
          if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'an interceptor is a function (call, next) => outcome');
          const opts = {};
          if (o && typeof o === 'object') for (const k of ['priority', 'replaces', 'deadlineMs', 'onFailure']) if (o[k] !== undefined) opts[k] = o[k];
          const running = new Map();   // call token -> its cancellation, while fn runs
          return register(modId, 'graph', 'intercept', [typeId, operation, opts], async ([kind, token, call]) => {
            // The Host cancels a call it holds (the user's Stop during a held send): the call's signal aborts here.
            if (kind === 'cancel') { running.get(token)?.abort('cancelled'); return null; }
            if (kind !== 'intercept') throw new CodexModsError('Unavailable', `unknown interceptor message ${String(kind)}`);
            const cancel = createCancel();
            running.set(token, cancel);
            let nexted = null;      // the promise of the first next() this call made
            const next = (change) => { const p = c('graph', 'next', token, change === undefined ? null : change); nexted ??= p; return p; };
            try {
              // Not enumerable: the call stays plain data a mod may store or send on (the signal and ask are functions). `ask` asks the
              // user about this call (ui.ask's spec): the question ends with the call (decided, expired, cancelled; E7.6c).
              const held = Object.defineProperties({ ...call }, {
                signal: { value: cancel.signal, enumerable: false },
                ask: { value: (spec) => c('ui', 'ask', { ...(spec && typeof spec === 'object' ? spec : {}), during: token }), enumerable: false },
              });
              const out = await fn(held, next);
              if (nexted && !isOutcome(out)) return nexted;
              return out;
            } finally { running.delete(token); }
          });
        },
      };
    }
    if (realm === 'process') {
      // Not in sdk/index.d.ts: how a mod process answers `ctx.processes.call` and emits `message` events (see report).
      ctx.process = {
        serve(handlers) {
          return register(modId, 'process', 'serve', [Object.keys(handlers)], ([method, params]) => {
            if (!Object.hasOwn(handlers, method)) throw new CodexModsError('Invalid', `unknown remote method ${method}`);
            return handlers[method](params);
          });
        },
        emit: (data) => send(modId, 'process', 'emit', [data]),
      };
    }
    return ctx;
  }

  /** Dispose every registration made through any context of this client (worker deactivation). */
  async function disposeAll() {
    const all = [];
    for (const set of owned.values()) all.push(...set);
    await Promise.allSettled(all.map((d) => d.dispose()));
  }
  function close() {
    messageSub?.dispose?.();
    closeSub?.dispose?.();
    closeAll(new CodexModsError('Disposed', 'realm client closed'));
  }
  return { context, disposeAll, close };
}
