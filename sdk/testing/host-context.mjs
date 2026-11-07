// createFakeHostContext: a faithful HostContext plus a control surface for driving the app-server plane.
//
// deliver(kind, message, info?) models Mux mediation for ONE mod (ARCHITECTURE §6.3–6.4):
//   - interceptors for `kind` whose methods match, ordered priority desc then registration order; each handler gets a
//     deep-frozen copy of the CURRENT message and its info; the mod's own origin ('mod:<id>') is skipped;
//   - results: undefined | {replace} | {drop} | {respond} | {route}; respond/drop end the chain; `{defer: true}` is an invalid result,
//     as the Mux's for any mod (graph-integrity G6.4: a mod stops an app action through the graph, or answers a request later through
//     its instance); an invalid result, a throw or a timeout applies onError ('pass' continues as before that handler; 'reject'
//     answers/drops per §6.4);
//   - observers (granted appServer.observe) then see the final forwarded message (or the synthesized response).
// Returned: {outcome: 'forward'|'drop'|'respond'|'reject', message?, response?, route?, info, faults}.
import path from 'node:path';
import fs from 'node:fs';
import { CodexModsError } from '../errors.mjs';
import { createCore, registrationCounts, clone, deepFreeze, toJson, plain } from './core.mjs';
import { createScheduler } from '../scheduler.mjs';

const KINDS = ['clientRequest', 'clientNotification', 'serverResponse', 'serverNotification', 'serverRequest', 'clientResponse'];
const REQUEST_KINDS = new Set(['clientRequest', 'serverRequest']);
const NOTIFICATION_KINDS = new Set(['clientNotification', 'serverNotification']);
const RESPONSE_KINDS = new Set(['serverResponse', 'clientResponse']);

export const rpcRequest = (id, method, params) => ({ id, method, ...(params === undefined ? {} : { params }) });
export const rpcNotification = (method, params) => ({ method, ...(params === undefined ? {} : { params }) });
export const rpcResponse = (id, result) => ({ id, result });
export const rpcError = (id, code, message, data) => ({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });

const methodMatches = (methods, method) =>
  methods === '*' || methods.some((m) => m === method || (m.endsWith('/') && method.startsWith(m)));

function validateReplace(kind, original, next) {
  if (!plain(next)) return 'replace must be an object';
  if (original.id !== undefined || next.id !== undefined) { if (next.id !== original.id) return 'replace may not change the id'; }
  if (RESPONSE_KINDS.has(kind)) {
    if (next.method !== undefined) return 'a response has no method';
    if (!('result' in next) === !('error' in next)) return 'a response needs exactly one of result or error';
  } else {
    if (typeof next.method !== 'string') return 'replace needs a method';
    if (kind !== 'clientRequest' && next.method !== original.method) return 'method may change only on client requests';
  }
  try { JSON.stringify(next); } catch { return 'replace is not JSON'; }
  return null;
}

function validateRespond(kind, original, value) {
  if (!REQUEST_KINDS.has(kind)) return 'respond is only allowed on requests';
  if (!plain(value) || (('result' in value) === ('error' in value))) return 'respond needs exactly one of result or error';
  if ('error' in value && !(Number.isFinite(value.error?.code) && typeof value.error?.message === 'string')) return 'error needs code and message';
  return null;
}


export function createFakeHostContext({ manifest, grants, settings, dataDir, storage, retained, secrets } = {}) {
  const core = createCore({ manifest, grants, settings, dataDir, initialStorage: storage, initialRetained: retained, initialSecrets: secrets, kind: 'host' });
  const id = core.id;
  let activation = null;

  // a program on the Mac a session runs (graph-integrity G8.2, D4): a `processes.exec` grant names it
  const execGranted = (exe) => [...core.granted.flags].some((g) => g.startsWith('processes.exec:') && g.slice('processes.exec:'.length).split(',').includes(exe));
  const processesApi = {
    async start(name, opts) {
      core.guard(); core.need('processes'); const d = declared(name);
      if (d.executable !== undefined && !execGranted(d.executable)) throw new CodexModsError('Denied', `this mod has not been granted running ${d.executable} (processes.exec:${d.executable})`);
      if (opts !== undefined && d.kind !== 'session') throw new CodexModsError('Invalid', `process ${name} is not a session: it takes no options at its start`);
      const base = String(name).split('#')[0], limit = Number.isInteger(d.instances) ? d.instances : 1;
      if (core.processes.scripts.get(name) !== 'running' && [...core.processes.scripts].filter(([n, st]) => st === 'running' && n.split('#')[0] === base).length >= limit) {
        throw new CodexModsError('Busy', `process ${base} runs at most ${limit} at once: stop one first`);
      }
      core.processes.scripts.set(name, 'running');
      core.processes.starts.push({ name, opts: opts === undefined ? null : clone(opts) });
    },
    async stop(name) { core.guard(); core.need('processes'); declared(name); core.processes.scripts.set(name, 'stopped'); },
    /** A session's input (G8.2): kept for the test, and given to its `onInput` (which may answer with `emit(name, 'output', ...)`). */
    async write(name, data) {
      core.guard(); core.need('processes'); const d = declared(name);
      if (d.kind !== 'session') throw new CodexModsError('Invalid', `process ${name} is not a session: it takes no input`);
      if (typeof data !== 'string') throw new CodexModsError('Invalid', 'input is a string');
      if (core.processes.scripts.get(name) !== 'running') throw new CodexModsError('Unavailable', `process ${name} is not running (or closed its input)`);
      if (!core.processes.written.has(name)) core.processes.written.set(name, []);
      core.processes.written.get(name).push(data);
      await core.processes.inputs.get(name)?.(data);
    },
    async call(name, method, params) {
      core.guard(); core.need('processes'); const d = declared(name);
      if (d.executable !== undefined) throw new CodexModsError('Invalid', `process ${name} runs ${d.executable}: it is fed through write, and answers on its output`);
      const h = core.processes.handlers.get(name);
      if (!h) throw new CodexModsError('Unavailable', `process ${name} is not running`);
      return toJson((await h(method, clone(params))) ?? null);
    },
    on(name, event, fn) {
      core.guard(); core.need('processes'); declared(name);
      const sub = { name, event, fn }; (core.processSubs ??= []).push(sub);
      return core.track('processes.on', `${name}:${event}`, () => core.processSubs.splice(core.processSubs.indexOf(sub), 1));
    },
  };
  // a session declared with `instances` runs as several, each `name#key`, as the Host runs them
  function declared(name) {
    const [base, key, extra] = String(name).split('#');
    const d = Object.hasOwn(core.manifest.processes ?? {}, base) ? core.manifest.processes[base] : undefined;
    if (!d || extra !== undefined) throw new CodexModsError('Invalid', `process "${name}" is not declared`);
    if (key !== undefined && (!Number.isInteger(d.instances) || !/^[A-Za-z0-9_-]{1,64}$/.test(key))) throw new CodexModsError('Invalid', `process ${base} runs as one: it is addressed by its name alone`);
    return d;
  }

  // ctx.scheduler runs the real engine on the fake retained store (real clock; use short delays in tests).
  let engine;
  const sched = () => {
    core.guard();
    if (!engine) {
      engine = createScheduler({ store: core.api.storage.retained, onError: (e) => core.logs.push({ level: 'error', message: `scheduler: ${String(e?.message ?? e)}` }) });
      core.track('scheduler', '', () => engine.close());
    }
    return engine;
  };
  const schedulerApi = {
    schedule: (spec) => sched().schedule(spec), cancel: (id) => sched().cancel(id), on: (id, h) => sched().on(id, h),
    get: (id) => sched().get(id), list: (o) => sched().list(o),
  };
  const ctx = Object.freeze({ ...core.api, processes: processesApi, scheduler: schedulerApi });

  // ------------------------------------------------------------ deliver
  const fault = (kind, message, method) => { const f = { kind, message, method }; core.faults.push(f); return f; };

  async function runHandler(i, message, info) {
    let timer;
    try {
      const run = Promise.resolve().then(() => i.handler(deepFreeze(structuredClone(message)), deepFreeze(structuredClone(info))));
      return await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`interceptor exceeded ${i.timeoutMs}ms`), { __timeout: true })), i.timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async function deliver(kind, message, info = {}) {
    if (!KINDS.includes(kind)) throw new CodexModsError('Invalid', `unknown kind "${kind}"`);
    let current = toJson(message, 'message');
    const method = info.method ?? current.method;
    if (typeof method !== 'string') throw new CodexModsError('Invalid', 'info.method is required for responses');
    const baseFor = (msg) => ({ kind, method, origin: info.origin ?? 'app', backend: info.backend ?? 'primary',
      ...(info.affinityKey !== undefined ? { affinityKey: info.affinityKey } : (msg.params?.threadId !== undefined ? { affinityKey: msg.params.threadId } : {})) });
    const base = baseFor(current);
    const faults = [];
    let route;
    const chain = core.interceptors
      .filter((i) => i.kind === kind && methodMatches(i.methods, method) && base.origin !== `mod:${id}`)
      .sort((a, b) => b.priority - a.priority || a.rank - b.rank);

    const finish = async (outcome, extra = {}) => {
      const result = { outcome, info: { ...base, ...(route ? { backend: route } : {}) }, faults, ...(route ? { route } : {}), ...extra };
      if (outcome === 'forward' || outcome === 'respond' || outcome === 'reject') {
        const seen = outcome === 'forward' ? { kind, message: current } : { kind: kind === 'serverRequest' ? 'clientResponse' : 'serverResponse', message: extra.response };
        notifyObservers(seen.kind, seen.message, { ...result.info, kind: seen.kind });
      }
      return result;
    };

    for (const i of chain) {
      let r;
      try {
        r = await runHandler(i, current, { ...base, ...(route ? { backend: route } : {}) });
        if (r !== undefined && r !== null) {
          const keys = Object.keys(r);
          if ('defer' in r) throw Object.assign(new Error('a mod does not defer requests: stop the action through the graph, or answer the request later'), { __invalid: true });
          if (keys.length !== 1 || !['replace', 'drop', 'respond', 'route'].includes(keys[0])) throw Object.assign(new Error('unknown intercept result'), { __invalid: true });
          if ('replace' in r) { const why = validateReplace(kind, current, r.replace); if (why) throw Object.assign(new Error(why), { __invalid: true }); }
          if ('drop' in r && !(r.drop === true && NOTIFICATION_KINDS.has(kind))) throw Object.assign(new Error('drop is only allowed on notifications'), { __invalid: true });
          if ('respond' in r) { const why = validateRespond(kind, current, r.respond); if (why) throw Object.assign(new Error(why), { __invalid: true }); }
          if ('route' in r) {
            if (kind !== 'clientRequest') throw Object.assign(new Error('route is only allowed on client requests'), { __invalid: true });
            if (typeof r.route !== 'string' || (r.route !== 'primary' && !core.backends.has(r.route))) throw Object.assign(new Error(`route target "${r.route}" is not a defined backend`), { __invalid: true });
          }
          r = toJson(r, 'intercept result');
        }
      } catch (e) {
        const f = fault(e.__timeout ? 'timeout' : e.__invalid ? 'invalid' : 'throw', e.message, method);
        faults.push(f);
        if (i.onError === 'reject') {
          const msg = { code: -32000, message: `interceptor failed: ${f.kind}` };
          if (kind === 'serverNotification' || kind === 'clientNotification') return finish('drop');
          if (RESPONSE_KINDS.has(kind)) { current = { id: current.id, error: msg }; continue; }
          const response = { id: current.id, error: msg };
          return finish('reject', { response });
        }
        continue;
      }
      if (r === undefined || r === null) continue;
      if ('replace' in r) current = r.replace;
      else if ('route' in r) route = r.route;
      else if ('drop' in r) return finish('drop');
      else if ('respond' in r) return finish('respond', { response: { id: current.id, ...r.respond } });
    }
    return finish('forward', { message: current });
  }

  function notifyObservers(kind, message, info) {
    for (const o of [...core.observers]) {
      if (o.kinds && !o.kinds.has(kind)) continue;
      if (o.methods !== '*' && !methodMatches(o.methods, info.method)) continue;
      try { o.listener(deepFreeze(structuredClone(message)), deepFreeze(structuredClone(info))); }
      catch (e) { core.logs.push({ level: 'error', message: `observer threw: ${e.message}` }); }
    }
  }

  // ------------------------------------------------------------ control
  const control = {
    ctx,
    deliver,
    /** Mod intelligence, faked: `answer(fn)` answers each `ctx.intelligence.ask` (fn(spec, {tool(name, args), text(delta)})), `asks()` lists
     *  them (each with the tool names it was given), `enable(on)` is the user's switch for the mod's model use. */
    intelligence: {
      answer(fn) { core.intelligence.answer = fn; },
      asks: () => core.intelligence.asks.map((x) => clone(x)),
      enable(on) { core.intelligence.enabled = on !== false; },
    },
    /** Deliver a gap marker to every observer (overflow / restart). */
    gap(gap) { for (const o of [...core.observers]) { try { o.listener(deepFreeze({ gap: clone(gap) }), null); } catch { /* ignore */ } } },
    onRequest(method, fn, opts = {}) {
      const s = { method, fn, backend: opts.backend, calls: [] }; core.scripts.push(s);
      return { calls: s.calls, remove() { core.scripts.splice(core.scripts.indexOf(s), 1); } };
    },
    get requests() { return core.requests; },
    clearRequests() { core.requests.length = 0; },
    get faults() { return core.faults; },
    get logs() { return core.logs; },
    backends: {
      list: () => [...core.backends.values()].map((b) => ({ key: b.key, owner: `mod:${id}`, state: b.state, def: clone(b.def) })),
      keys: () => [...core.backends.keys()],
      has: (k) => core.backends.has(k),
      setState(key, state) { const b = core.backends.get(key); if (!b) throw new Error(`no backend ${key}`); b.state = state; core.publish(`backend/${key}/${state}`, { key }); },
      /** Definitions removed by dispose (data retained, ARCHITECTURE §6: disposeOwner does not delete data). */
      get retained() { return Object.fromEntries(core.removedBackends); },
      get removals() { return core.removedBackendsLog ?? []; },
    },
    leases: {
      all: () => [...core.leases.values()].map((l) => ({ id: l.id, name: l.name, token: l.token, revoked: l.revoked, descriptor: clone(l.descriptor) })),
      active: () => [...core.leases.values()].filter((l) => !l.revoked).map((l) => ({ id: l.id, name: l.name, descriptor: clone(l.descriptor) })),
      /** Simulates an external client calling `codexmods/services.call` on its lease connection (ipc.d.ts §4). */
      async call(leaseId, token, call) {
        const l = core.leases.get(leaseId);
        if (!l || l.revoked || l.token !== token) throw new CodexModsError('Denied', 'invalid or revoked lease');
        return core.callService(id, call.name, call.method, call.args, { kind: 'client', mod: id });
      },
    },
    /** Register a service owned by another mod (or 'framework') for ctx.services.call. */
    provideService(modId, name, handlers) { core.services.set(`${modId}/${name}`, handlers); },
    publish: (topic, data, opts) => core.publish(topic, data, opts),
    events: { publish: (topic, data, opts) => core.publish(topic, data, opts), subscribers: () => core.topics.subs.size },
    settings: {
      set: (value) => core.setSettings(value),
      patch: (partial) => core.setSettings({ ...core.settingsValue, ...partial }),
      get: () => clone(core.settingsValue),
    },
    storage: {
      export: () => core.store.export(),
      exportRetained: () => core.retained.export(),
      /** Runs between a transaction's snapshot and its commit; use raw writes to simulate a concurrent commit. */
      beforeCommit(fn) { core.store.beforeCommit = fn; },
      raw: { set: (k, v) => core.store.commit(new Map([[k, { op: 'set', value: toJson(v) }]])), delete: (k) => core.store.commit(new Map([[k, { op: 'delete' }]])) },
    },
    /** F8: an optional permission's decision as the user makes it (its listeners hear it), and the answers the user gives the mod's requests, in order (true: Allow). */
    permissions: { decide: (grant, decision) => core.decidePermission(grant, decision), answer: (...answers) => { core.permissionAnswers.push(...answers); }, state: (g) => core.permissionDecisions.get(g) },
    /** The fake Keychain: export() for a simulated relaunch (pass as `secrets`), history = every value ever set. */
    secrets: { get: (n) => core.secretsMap.get(n), names: () => [...core.secretsMap.keys()], export: () => Object.fromEntries(core.secretsMap), history: () => [...core.secretsHistory] },
    processes: {
      handle(name, fn) { core.processes.handlers.set(name, fn); },
      state: (name) => core.processes.scripts.get(name) ?? 'stopped',
      emit(name, event, data) { for (const s of core.processSubs ?? []) if (s.name === name && s.event === event) s.fn(clone(data)); },
      /** A session's starts, `{name, opts}` in order, and what was written to it (G8.2). */
      starts: () => core.processes.starts.map((x) => clone(x)),
      written: (name) => [...(core.processes.written.get(name) ?? [])],
      /** What the session does with its input: `fn(data)`, e.g. `emit(name, 'output', {stream: 'stdout', line})`. */
      onInput(name, fn) { core.processes.inputs.set(name, fn); },
    },
    registrations: () => registrationCounts(core),
    registrationList: () => [...core.registry.values()].map((r) => `${r.kind}:${r.desc}`),
    get dataDir() { return core.dataDir; },
    filePath: (...parts) => path.join(core.dataDir, 'files', ...parts),
    /** Runs the mod's host entry (a ModDefinition or its host function) and remembers its disposer. */
    async activate(definition) {
      const fn = typeof definition === 'function' ? definition : (definition.default ?? definition).host;
      if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'definition has no host entry');
      const r = await fn(ctx);
      activation = r;
      return r;
    },
    /** Disable path (ARCHITECTURE §7.4): run the returned disposer, then dispose every tracked registration. */
    async deactivate() {
      const r = activation; activation = null;
      try {
        if (typeof r === 'function') await r();
        else if (r && typeof r.dispose === 'function') await r.dispose();
      } finally {
        await disposeAll();
        core.disposed = true;
      }
    },
    cleanup() { if (core.ownsDataDir) fs.rmSync(core.dataDir, { recursive: true, force: true }); },
    core,
  };

  async function disposeAll() {
    // Every registration made through ctx is tracked and disposed automatically (ARCHITECTURE §7.2).
    for (const reg of [...core.registry.values()]) { try { await reg.dispose(); } catch { /* keep going */ } }
  }

  return { ctx, control };
}
