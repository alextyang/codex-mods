// Shared fake state behind createFakeHostContext and createFakeRendererContext. Implements the realm-independent
// namespaces of sdk/index.d.ts faithfully: grants (Denied), storage transactions (Conflict), events with prefix topics,
// settings with their defaults, services, secrets, app-server (request / observe / intercept / backends / clients).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CodexModsError } from '../errors.mjs';

export const clone = (v) => (v === undefined ? undefined : structuredClone(v));
export function toJson(value, what = 'value') {
  let s;
  try { s = JSON.stringify(value); } catch (e) { throw new CodexModsError('Invalid', `${what} is not JSON: ${e.message}`); }
  if (s === undefined) throw new CodexModsError('Invalid', `${what} is not JSON`);
  return JSON.parse(s);
}
export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v)) deepFreeze(c); }
  return v;
}
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ grants
const FLAG_PERMS = new Set(['appServer.backends', 'appServer.clients', 'ui', 'secrets', 'processes', 'network', 'framework.updates', 'graph']);

/** Permission grammar (contracts/manifest.d.ts). `appServer.X` bare = any explicit method; `appServer.X:a,b/` = those
 *  methods/prefixes only. The wildcard `'*'` additionally needs an explicit `appServer.X:*` grant. */
export function parseGrants(list) {
  const methods = {}; const flags = new Set();
  for (const p of list) {
    const m = /^appServer\.(observe|request|intercept)(?::(.*))?$/.exec(p);
    if (m) {
      const e = methods[m[1]] ?? (methods[m[1]] = { bare: false, lists: [] });
      if (m[2] === undefined) e.bare = true; else e.lists.push(...m[2].split(',').map((s) => s.trim()).filter(Boolean));
    } else if (FLAG_PERMS.has(p) || /^graph\.(read|act|present|intercept|attach|contribute)(:.+)?$/.test(p) || /^processes\.exec:[^,\s]+(,[^,\s]+)*$/.test(p)) flags.add(p);
    else throw new CodexModsError('Invalid', `unknown permission "${p}"`);
  }
  return { methods, flags };
}
function covers(entry, pattern, perm) {
  if (pattern === '*') return perm === 'intercept' ? entry.lists.includes('*') : (entry.bare || entry.lists.includes('*'));
  if (entry.bare || entry.lists.includes('*')) return true;
  return entry.lists.some((g) => g === pattern || (g.endsWith('/') && pattern.startsWith(g)));
}

// ------------------------------------------------------------------ storage
class Store {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial).map(([k, v]) => [k, toJson(v)]));
    this.versions = new Map(); this.version = 0; this.watchers = new Set(); this.beforeCommit = null;
  }
  commit(writes) {
    if (!writes.size) return;
    this.version += 1;
    const keys = [];
    for (const [k, w] of writes) {
      if (w.op === 'set') this.data.set(k, w.value); else this.data.delete(k);
      this.versions.set(k, this.version); keys.push(k);
    }
    for (const w of [...this.watchers]) {
      const hit = keys.filter((k) => k.startsWith(w.prefix));
      if (hit.length) queueMicrotask(() => { if (this.watchers.has(w)) { try { w.fn(hit); } catch { /* watcher faults are the mod's */ } } });
    }
  }
  api(guard, track) {
    const self = this;
    return {
      async get(key) { guard(); return clone(self.data.get(String(key))); },
      async set(key, value) { guard(); self.commit(new Map([[String(key), { op: 'set', value: toJson(value, `storage value for "${key}"`) }]])); },
      async delete(key) { guard(); self.commit(new Map([[String(key), { op: 'delete' }]])); },
      async list(prefix = '') { guard(); return [...self.data.keys()].filter((k) => k.startsWith(prefix)).sort(); },
      async transaction(fn) {
        guard();
        const snapVersion = self.version; const snap = new Map(self.data);
        const reads = new Set(); const prefixes = new Set(); const writes = new Map();
        const tx = {
          get(k) { reads.add(k); if (writes.has(k)) { const w = writes.get(k); return w.op === 'set' ? clone(w.value) : undefined; } return clone(snap.get(k)); },
          set(k, v) { writes.set(String(k), { op: 'set', value: toJson(v, `storage value for "${k}"`) }); },
          delete(k) { writes.set(String(k), { op: 'delete' }); },
          list(prefix = '') {
            prefixes.add(prefix);
            const keys = new Set([...snap.keys()].filter((k) => k.startsWith(prefix)));
            for (const [k, w] of writes) if (k.startsWith(prefix)) { if (w.op === 'set') keys.add(k); else keys.delete(k); }
            return [...keys].sort();
          },
        };
        const result = fn(tx);
        if (result && typeof result.then === 'function') throw new CodexModsError('Invalid', 'transaction fn must be synchronous');
        await Promise.resolve();
        if (self.beforeCommit) await self.beforeCommit(self);
        const touched = (k) => (self.versions.get(k) ?? 0) > snapVersion;
        for (const k of [...reads, ...writes.keys()]) if (touched(k)) throw new CodexModsError('Conflict', `concurrent commit touched "${k}"`);
        for (const prefix of prefixes) {
          for (const [k, v] of self.versions) if (k.startsWith(prefix) && v > snapVersion) throw new CodexModsError('Conflict', `concurrent commit touched "${k}"`);
        }
        self.commit(writes);
        return result;
      },
      watch(prefix, fn) {
        guard();
        const w = { prefix: String(prefix), fn }; self.watchers.add(w);
        return track('storage.watch', prefix, () => self.watchers.delete(w));
      },
    };
  }
  export() { return Object.fromEntries([...this.data].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, clone(v)])); }
}

// ------------------------------------------------------------------ core
const BACKEND_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const matchTopic = (pattern, topic) => (pattern.endsWith('*') ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic);

export function createCore({ manifest, grants, settings, dataDir, initialStorage, initialRetained, initialSecrets, kind }) {
  if (!manifest || typeof manifest.id !== 'string') throw new CodexModsError('Invalid', 'manifest with an id is required');
  const id = manifest.id;
  const granted = parseGrants(grants ?? manifest.permissions ?? []);
  const ownsDataDir = !dataDir;
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codexmods-fake-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const core = {
    id, manifest, granted, dataDir: dir, ownsDataDir, kind,
    disposed: false, seq: 0,
    registry: new Map(),            // regId -> {kind, desc}
    logs: [], faults: [], requests: [],
    store: new Store(initialStorage), retained: new Store(initialRetained),
    settingsValue: undefined, settingsListeners: new Set(),
    secretsMap: new Map(Object.entries(initialSecrets ?? {})), secretsHistory: [],
    topics: { subs: new Set(), state: new Map() },
    services: new Map(),             // `${modId}/${name}` -> handlers
    ownServices: new Set(),
    interceptors: [], observers: [],
    scripts: [],                     // onRequest scripts
    backends: new Map(),             // key -> {key, def, state}
    removedBackends: new Map(),      // key -> def (data retained)
    leases: new Map(),
    processes: { scripts: new Map(), handlers: new Map(), starts: [], written: new Map(), inputs: new Map() },
  };

  const guard = () => { if (core.disposed) throw new CodexModsError('Disposed', 'the mod scope has ended'); };
  core.guard = guard;
  const track = (kindName, desc, fn) => {
    const regId = ++core.seq;
    let done = false;
    const handle = { dispose() { if (done) return; done = true; core.registry.delete(regId); return fn(); } };
    core.registry.set(regId, { kind: kindName, desc: String(desc), dispose: handle.dispose });
    return handle;
  };
  core.track = track;
  const need = (flag) => { if (!granted.flags.has(flag)) throw new CodexModsError('Denied', `permission "${flag}" is not granted`); };
  core.need = need;
  const needMethods = (perm, patterns) => {
    const e = granted.methods[perm];
    const list = patterns === '*' ? ['*'] : patterns;
    if (!e) throw new CodexModsError('Denied', `permission "appServer.${perm}" is not granted`);
    for (const p of list) if (!covers(e, p, perm)) throw new CodexModsError('Denied', `appServer.${perm} does not cover "${p}"`);
  };
  core.needMethods = needMethods;

  // ---- settings
  // The kit keeps a mod's app values and its values per scope (no thread's project: give the project).
  const decls = (Array.isArray(manifest.settings) ? manifest.settings : []).flatMap((x) => (x && typeof x === 'object' && Array.isArray(x.items) ? x.items : [x]));
  const optionValue = (c) => (c && typeof c === 'object' ? c.value : c);
  /** What the Host's declarations refuse of a value, for the kinds a test sets. */
  const checkValue = (d, v) => {
    const bad = d.kind === 'choice' ? !d.options.some((c) => optionValue(c) === v)
      : d.kind === 'number' ? typeof v !== 'number' || (d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)
        : d.kind === 'toggle' ? typeof v !== 'boolean' : d.kind === 'text' ? typeof v !== 'string' : false;
    if (bad) throw new CodexModsError('Invalid', `settings: ${d.key} cannot be ${JSON.stringify(v)}`);
  };
  const docOf = (app) => Object.fromEntries(decls.map((d) => { const v = app?.[d.key]; if (v === undefined) return [d.key, d.default]; checkValue(d, v); return [d.key, v]; }));
  core.settingsValue = docOf(settings ?? {});
  core.settingsScoped = {};   // "project:<provider>:<id>" | "thread:<provider>:<id>" -> {key: value}
  core.setSettings = (value) => {
    const next = docOf(toJson(value, 'settings'));
    core.settingsValue = next;
    for (const fn of [...core.settingsListeners]) { try { fn(clone(next)); } catch { /* mod's fault */ } }
  };
  const scopeKey = (scope) => (scope && typeof scope === 'object' ? (scope.thread ? `thread:${scope.thread.provider}:${scope.thread.id}` : scope.project ? `project:${scope.project.provider}:${scope.project.id}` : null) : null);
  const declOf = (key) => {
    const d = decls.find((x) => x.key === key);
    if (!d) throw new CodexModsError('Invalid', `settings: ${key} is not a setting of this mod`);
    return d;
  };
  /** A key's value at a scope: the thread's, the project's, the app's, its default. */
  const valueAt = (key, where = {}) => {
    const d = declOf(key);
    for (const sk of [scopeKey(where.thread ? { thread: where.thread } : null), scopeKey(where.project ? { project: where.project } : null)]) {
      if (sk && core.settingsScoped[sk] && Object.hasOwn(core.settingsScoped[sk], key)) return core.settingsScoped[sk][key];
    }
    return core.settingsValue[key] ?? d.default;
  };
  const scopedChange = (key, scope) => {
    const value = clone(valueAt(key, typeof scope === 'object' ? scope : {}));
    for (const fn of [...core.settingsListeners]) { try { fn(clone(core.settingsValue), { key, scope, value }); } catch { /* mod's fault */ } }
  };
  const settingsApi = {
    async get(key, where) { guard(); return key === undefined ? clone(core.settingsValue) : clone(valueAt(key, where ?? {})); },
    async set(key, value, opts = {}) {
      guard();
      const d = declOf(key);
      checkValue(d, value);
      const sk = scopeKey(opts.scope);
      if (sk) (core.settingsScoped[sk] ??= {})[key] = clone(value); else core.settingsValue = { ...core.settingsValue, [key]: clone(value) };
      scopedChange(key, opts.scope ?? 'app');
      return { opId: null };
    },
    async reset(key, opts = {}) {
      guard();
      const d = declOf(key);
      const sk = scopeKey(opts.scope);
      if (sk) delete core.settingsScoped[sk]?.[key]; else core.settingsValue = { ...core.settingsValue, [key]: d.default };
      scopedChange(key, opts.scope ?? 'app');
      return { opId: null };
    },
    onChange(fn) { guard(); core.settingsListeners.add(fn); return track('settings.onChange', '', () => core.settingsListeners.delete(fn)); },
  };

  // ---- storage
  const retainedApi = core.retained.api(guard, track);
  const storageApi = { ...core.store.api(guard, track), retained: retainedApi };

  // ---- secrets
  const secretsApi = {
    async get(name) { guard(); need('secrets'); return core.secretsMap.get(name); },
    async set(name, value) { guard(); need('secrets'); if (typeof value !== 'string') throw new CodexModsError('Invalid', 'secret must be a string'); core.secretsMap.set(name, value); core.secretsHistory.push(value); },
    async delete(name) { guard(); need('secrets'); core.secretsMap.delete(name); },
  };

  // ---- events
  core.publish = (topic, data, opts) => {
    if (opts?.state) core.topics.state.set(topic, toJson(data));
    for (const s of [...core.topics.subs]) {
      if (matchTopic(s.pattern, topic)) { try { s.fn(clone(toJson(data)), topic); } catch (e) { core.logs.push({ level: 'error', message: `event handler threw: ${e.message}` }); } }
    }
  };
  const eventsApi = {
    on(topic, fn, opts) {
      guard();
      const sub = { pattern: String(topic), fn }; core.topics.subs.add(sub);
      if (opts?.replay === 'state') for (const [t, v] of core.topics.state) if (matchTopic(sub.pattern, t)) { try { fn(clone(v), t); } catch { /* ignore */ } }
      return track('events.on', topic, () => core.topics.subs.delete(sub));
    },
    emit(topic, data) {
      guard();
      if (typeof topic !== 'string' || !topic.startsWith(`mod/${id}/`)) throw new CodexModsError('Denied', `only mod/${id}/... topics may be emitted`);
      core.publish(topic, data);
    },
    async state(topic) { guard(); return clone(core.topics.state.get(topic)); },
  };

  // ---- services
  const servicesApi = {
    provide(name, handlers) {
      guard();
      const key = `${id}/${name}`;
      if (core.services.has(key)) throw new CodexModsError('Conflict', `service "${name}" already provided`);
      core.services.set(key, handlers); core.ownServices.add(key);
      return track('services.provide', name, () => { core.services.delete(key); core.ownServices.delete(key); });
    },
    async call(modId, name, method, args, caller = { kind: 'mod', id }) {
      guard();
      const h = core.services.get(`${modId}/${name}`);
      if (!h || typeof h[method] !== 'function') throw new CodexModsError('Unavailable', `service ${modId}/${name}.${method} is not provided`);
      return toJson(await h[method](args === undefined ? null : clone(toJson(args, 'service args')), Object.freeze({ caller: Object.freeze({ ...caller }) })) ?? null, 'service result');
    },
  };
  core.callService = servicesApi.call;

  // ---- mod intelligence (GOAL.md goal 16), faked: the test answers each ask (`control.intelligence.answer(fn)`: fn(spec, {tool, text})
  // may call the mod's tools and stream text as the model would) and says whether the user has the mod's model use on
  core.intelligence = { answer: null, asks: [], enabled: true };
  const intelligenceApi = {
    async ask(spec = {}) {
      guard();
      const { tools = {}, storage = false, settings = false, onText, ...rest } = spec ?? {};
      if (typeof rest.prompt !== 'string' || !rest.prompt.trim()) throw new CodexModsError('Invalid', 'ask needs a prompt');
      if (!manifest.intelligence) throw new CodexModsError('Denied', 'this mod has not declared model use in its manifest (intelligence: {why})');
      if (!core.intelligence.enabled) throw new CodexModsError('Denied', 'model use is off for this mod: turn it on on its page in Settings, Mods');
      const all = {
        ...(storage ? { storage_get: { run: async ({ key }) => ({ value: (await storageApi.get(String(key))) ?? null }) },
          storage_set: { run: async ({ key, value }) => { await storageApi.set(String(key), value ?? null); return { value: 'kept' }; } },
          storage_keys: { run: async ({ prefix }) => ({ value: await storageApi.list(String(prefix ?? '')) }) } } : {}),
        ...(settings ? { settings_get: { run: async ({ key }) => ({ value: key ? await settingsApi.get(String(key)) : await settingsApi.get() }) },
          settings_set: { run: async ({ key, value }) => { await settingsApi.set(String(key), value); return { value: 'changed' }; } } } : {}),
        ...(tools ?? {}),
      };
      core.intelligence.asks.push({ ...clone(toJson(rest, 'ask')), tools: Object.keys(all) });
      const fn = core.intelligence.answer;
      if (typeof fn !== 'function') throw new CodexModsError('Unavailable', 'no model in this test: control.intelligence.answer(fn) answers asks');
      const out = await fn(clone(toJson(rest, 'ask')), {
        tool: async (name, args) => { const t = all[name]; if (!t) return { ok: false, text: `no tool ${name}` }; return toJson((await t.run(clone(args ?? {}))) ?? null, 'tool result'); },
        text: (delta) => { if (typeof onText === 'function') onText(String(delta)); },
      });
      return { text: String(typeof out === 'string' ? out : out?.text ?? ''), usage: { tokens: Number(out?.tokens ?? 0) } };
    },
    async status() { guard(); return manifest.intelligence ? { enabled: core.intelligence.enabled } : { enabled: false, declared: false }; },
  };

  // ---- app-server
  const backendOf = (b) => {
    if (b === undefined || b === 'primary') return 'primary';
    if (!core.backends.has(b)) throw new CodexModsError('Unavailable', `backend "${b}" is not defined`);
    return b;
  };
  core.backendOf = backendOf;
  const racing = (p, ms, timeoutError) => {
    if (!ms) return p;
    let timer;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(timeoutError()), ms); })]).finally(() => clearTimeout(timer));
  };
  core.racing = racing;

  const appServerApi = {
    async request(method, params, opts) {
      guard(); needMethods('request', [method]);
      const backend = backendOf(opts?.backend);
      const entry = { method, params: clone(params), backend, opts: clone(opts), at: Date.now() };
      core.requests.push(entry);
      const script = [...core.scripts].reverse().find((s) => s.method === method && (s.backend === undefined || s.backend === backend));
      if (!script) throw new CodexModsError('Unavailable', `no scripted reply for ${method} on ${backend}`);
      script.calls.push(entry);
      const run = Promise.resolve().then(() => (typeof script.fn === 'function' ? script.fn(clone(params), { backend, method, opts }) : script.fn));
      const result = await racing(run, opts?.timeoutMs, () => new CodexModsError('OutcomeUnknown', `${method} timed out after transmission`));
      return toJson(result ?? null, 'request result');
    },
    notify(method, params, opts) {
      guard(); needMethods('request', [method]);
      core.requests.push({ method, params: clone(params), backend: backendOf(opts?.backend), notify: true, at: Date.now() });
    },
    observe(filter, listener, opts) {
      guard();
      const f = filter ?? {};
      const methods = f.methods ?? '*';
      needMethods('observe', methods === '*' ? '*' : methods);
      const o = { kinds: f.kinds ? new Set(f.kinds) : null, methods, listener, opts };
      core.observers.push(o);
      return track('appServer.observe', JSON.stringify(f), () => { core.observers.splice(core.observers.indexOf(o), 1); });
    },
    intercept(kindName, methods, handler, opts = {}) {
      guard();
      if (!['clientRequest', 'clientNotification', 'serverResponse', 'serverNotification', 'serverRequest', 'clientResponse'].includes(kindName)) {
        throw new CodexModsError('Invalid', `unknown message kind "${kindName}"`);
      }
      if (methods !== '*' && (!Array.isArray(methods) || methods.some((m) => typeof m !== 'string'))) throw new CodexModsError('Invalid', 'methods must be a string array or "*"');
      needMethods('intercept', methods === '*' ? '*' : methods);
      if (typeof handler !== 'function') throw new CodexModsError('Invalid', 'handler must be a function');
      const timeoutMs = opts.timeoutMs ?? 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new CodexModsError('Invalid', 'timeoutMs must be 1..30000');
      if (opts.onError !== undefined && !['pass', 'reject'].includes(opts.onError)) throw new CodexModsError('Invalid', 'onError must be pass|reject');
      const i = { kind: kindName, methods, handler, priority: opts.priority ?? 0, timeoutMs, onError: opts.onError ?? 'pass', rank: ++core.seq };
      core.interceptors.push(i);
      return track('appServer.intercept', `${kindName} ${methods === '*' ? '*' : methods.join(',')}`, () => { core.interceptors.splice(core.interceptors.indexOf(i), 1); });
    },
    backends: {
      async define(key, def = {}) {
        guard(); need('appServer.backends');
        if (typeof key !== 'string' || key === 'primary' || !BACKEND_KEY.test(key)) throw new CodexModsError('Invalid', `invalid backend key "${key}"`);
        if (def.codexHome !== undefined && (typeof def.codexHome !== 'string' || path.isAbsolute(def.codexHome) || def.codexHome.split('/').includes('..'))) {
          throw new CodexModsError('Invalid', 'codexHome must be relative to the backends dir');
        }
        const existing = core.backends.get(key);
        const record = existing ?? { key, state: 'stopped', reg: null };
        record.def = clone(def);
        core.backends.set(key, record);
        core.removedBackends.delete(key);
        if (!existing) record.reg = track('backend', key, () => { core.backends.delete(key); core.removedBackends.set(key, record.def); });
      },
      async remove(key, opts) {
        guard(); need('appServer.backends');
        const rec = core.backends.get(key);
        if (!rec) throw new CodexModsError('Unavailable', `backend "${key}" is not defined`);
        rec.reg.dispose();
        if (opts?.deleteData) core.removedBackends.delete(key);
        core.removedBackendsLog = [...(core.removedBackendsLog ?? []), { key, deleteData: Boolean(opts?.deleteData) }];
      },
      async list() { guard(); need('appServer.backends'); return [...core.backends.values()].map((b) => ({ key: b.key, owner: `mod:${id}`, state: b.state })); },
    },
    clients: {
      async issue(opts) {
        guard(); need('appServer.clients');
        if (!opts || typeof opts.name !== 'string' || !opts.name) throw new CodexModsError('Invalid', 'name is required');
        const leaseId = `lease-${++core.seq}`;
        const token = crypto.randomBytes(16).toString('hex');
        const descriptor = { id: leaseId, socketPath: path.join(dir, '..', 'clients.sock'), token };
        const rec = { id: leaseId, name: opts.name, descriptor, token, revoked: false, reg: null };
        rec.reg = track('lease', `${leaseId}:${opts.name}`, () => { rec.revoked = true; });
        core.leases.set(leaseId, rec);
        return clone(descriptor);
      },
      async revoke(leaseId) {
        guard(); need('appServer.clients');
        const rec = core.leases.get(leaseId);
        if (!rec) throw new CodexModsError('Unavailable', `unknown lease "${leaseId}"`);
        rec.reg.dispose();
      },
    },
  };

  // ---- permissions (framework-ui.md F8): a required one is allow, an optional one its decision (control.permissions.decide); a request is answered as the test says
  const optionalOf = () => manifest.optionalPermissions ?? [];
  core.permissionDecisions = new Map();
  core.permissionAnswers = [];
  core.permissionListeners = new Set();
  const defaultDecision = (g) => (/^(graph\.act|secrets|appServer\.request)(:|$)/.test(g) ? 'ask' : 'deny');
  const permissionState = (grant) => {
    if ((manifest.permissions ?? []).includes(grant)) return 'allow';
    if (!optionalOf().includes(grant)) throw new CodexModsError('Invalid', `permissions: ${grant} is not a permission this mod declares`);
    return core.permissionDecisions.get(grant) ?? defaultDecision(grant);
  };
  core.decidePermission = (grant, decision) => {
    permissionState(grant);
    core.permissionDecisions.set(grant, decision);
    for (const fn of [...core.permissionListeners]) { try { fn(grant, decision); } catch { /* mod's fault */ } }
  };
  const permissionsApi = {
    async state(grant) { guard(); return permissionState(grant); },
    async request(grant) {
      guard();
      if (permissionState(grant) === 'allow') return { granted: true };
      const answer = core.permissionAnswers.length ? core.permissionAnswers.shift() : false;
      if (answer) core.decidePermission(grant, 'allow');
      return { granted: Boolean(answer) };
    },
    onChange(fn) { guard(); core.permissionListeners.add(fn); return track('permissions.onChange', '', () => core.permissionListeners.delete(fn)); },
  };

  // ---- log
  const mk = (level) => (message, data) => { core.logs.push({ level, message, ...(data === undefined ? {} : { data: clone(data) }) }); };
  const logApi = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };

  core.api = {
    mod: Object.freeze({ id, version: manifest.version ?? '0.0.0', dataDir: dir }),
    log: logApi, settings: settingsApi, storage: storageApi, secrets: secretsApi, permissions: permissionsApi, events: eventsApi,
    services: servicesApi, intelligence: intelligenceApi, appServer: appServerApi,
  };
  return core;
}

export function registrationCounts(core) {
  const out = {};
  for (const r of core.registry.values()) out[r.kind] = (out[r.kind] ?? 0) + 1;
  out.total = core.registry.size;
  return out;
}

export { plain, matchTopic };
