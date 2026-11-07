// createTestGraph: the graph a mod meets in the app, offline (docs/design/graph-integrity.md G8.3). It is the real runtime, not a fake:
// - the graph (types, store, authority, policies, interception, attached data, defaults) with the app's own types (sdk/graph/native);
// - the Host's mod runtime, so a mod's host entry runs in a worker with the ctx it gets in the app, and its renderer realm's `ctx.graph`
//   is the one the page gives it.
// The app's own instances come from fake providers the test declares (`provider`); the user and the app act through `invoke`.
// Node built-ins only. A test closes it (`close`), which stops the mods' workers and removes its temporary root.
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { layout as makeLayout } from '../../contracts/layout.mjs';
import { createGraph } from '../../framework/host/graph/index.mjs';
import { createBus } from '../../framework/host/runtime/bus.mjs';
import { createRuntime } from '../../framework/host/runtime/index.mjs';
import { createUserPath } from '../../framework/host/ctx/user-path.mjs';
import { createPolicy } from '../../framework/host/graph/policy.mjs';
import { createRealmClient } from '../../framework/shared/realm-client.mjs';
import { NATIVE_TYPES } from '../graph/native/index.mjs';
import { toDescriptor } from '../graph/define.mjs';
import { CodexModsError } from '../errors.mjs';
import { declarationsOf, documentOf, applyPatches } from '../../framework/host/packages/settings.mjs';
import { types as agentInputTypes } from '../../framework/host/graph/providers/codex/areas/agent-inputs.mjs';
import { sendChange, sendWidens } from '../../framework/host/graph/providers/codex/areas/threads.mjs';

/** The callers a test acts as: the user in the app's interface, and the app itself. */
export const USER = Object.freeze({ kind: 'user', id: 'user', owner: 'app' });
export const APP = Object.freeze({ kind: 'app', id: 'app', owner: 'native' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EFFECTS = new Set(['none', 'local', 'external']);

/** Wait until `fn()` is truthy (it may be async): its value, or a timeout that says what was awaited. 15 s by default: a mod's worker
 *  answers across a thread boundary, which a busy machine (a full test run beside other work) can slow well past a second. */
export async function waitFor(fn, { timeout = 15000, interval = 10, what = 'the condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(interval);
  }
}

function logger(entries, scope = 'test') {
  const at = (level) => (msg, data) => { entries.push({ scope, level, msg: String(msg), ...(data === undefined ? {} : { data }) }); };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: (s) => logger(entries, `${scope}/${s}`) };
}

/** A Mux that serves nothing: a graph mod never reaches the app-server plane (createFakeHostContext tests that plane). */
function inertMux() {
  const refuse = () => { throw new CodexModsError('Unavailable', 'the test graph has no app-server: use createFakeHostContext for the protocol plane'); };
  return {
    client: () => ({ request: refuse, notify: refuse, observe: () => ({ dispose() {} }), intercept: () => ({ dispose() {} }), async dispose() {} }),
    async defineBackend() {}, async removeBackend() {}, listBackends: () => [], issueLease: refuse, revokeLease() {}, async disposeOwner() {},
    setLeaseServiceHandler() {}, onFault: () => ({ dispose() {} }), metrics: () => ({}), async close() {}, attachApp() {},
  };
}

/** Two in-process ends of a realm channel, as a window's page and the Host have them. */
function portPair() {
  const sides = [{ fns: new Set(), closers: new Set() }, { fns: new Set(), closers: new Set() }];
  const mk = (self, other) => ({
    post(m) { const c = JSON.parse(JSON.stringify(m)); queueMicrotask(() => { for (const fn of [...other.fns]) fn(c); }); },
    onMessage(fn) { self.fns.add(fn); return { dispose() { self.fns.delete(fn); } }; },
    onClose(fn) { self.closers.add(fn); return { dispose() { self.closers.delete(fn); } }; },
    close() { for (const fn of [...self.closers]) fn(); for (const fn of [...other.closers]) fn(); },
  });
  return [mk(sides[0], sides[1]), mk(sides[1], sides[0])];
}

/**
 * @param {{ types?: boolean, now?: () => number, timing?: object, path?: string, mux?: object }} [o]  `types: false` starts with no types at
 *   all (a test of a mod's own concepts alone); `now` is the graph's clock; `timing` the runtime's (heartbeats, activation deadline); `path`
 *   the PATH a session's program is found on (a test's own fake of it), in place of the user's; `mux` a real mux (on a fake app-server)
 *   for a mod's `ctx.appServer`, in place of one that refuses every request.
 */
export async function createTestGraph(o = {}) {
  const root = await mkdtemp('/tmp/cm-tg-');   // short: the runtime's Unix sockets live under it
  const layout = makeLayout(root, 'default');
  const entries = [];
  const log = logger(entries);
  // the Host's authority (breadth.md D0.2): what each running mod's grants cover, so a mod's test is refused what the app refuses it
  const mods = new Map();   // id -> the installed record
  let graph = null;
  const policy = createPolicy({ grantsOf: (modId) => mods.get(modId)?.record.grants, typeOf: (typeId) => graph?.type(typeId),
    subjectOf: (ref) => graph?.resolve(ref)?.links?.subject ?? null, canonicalOf: (ref) => graph?.resolve(ref)?.ref?.type ?? null });
  // the automatic actions the user has on (public-hooks.md §3.9), as declared by each running mod: `automatic(modId, id, on)` turns one on
  const automaticOn = new Set();
  const automaticOf = (modId, id) => (automaticOn.has(`${modId}\n${id}`) ? (mods.get(modId)?.manifest.automatic ?? []).find((a) => a?.id === id) ?? null : null);
  graph = createGraph({ log: log.child('graph'), authorize: policy.authorize, automaticOf, ...(o.now ? { now: o.now } : {}) });
  if (o.types !== false) graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const bus = createBus({ log });
  const quarantines = [];
  const runtime = createRuntime({
    mux: o.mux ?? inertMux(), bus, log, layout, rankOf: () => 1, graph,
    onQuarantine: (modId, reason) => quarantines.push({ modId, reason }),
    announceRenderer: () => {},
    views: { async open() { return null; }, async close() {} },
    internals: { timing: { heartbeatTimeoutMs: 600000, ...(o.timing ?? {}) },
      ...(typeof o.path === 'string' ? { userPath: createUserPath({ read: async () => o.path, ttlMs: 0 }) } : {}) },
  });
  const providers = [];
  let windowSeq = 0;
  let closed = false;
  const live = () => { if (closed) throw new CodexModsError('Disposed', 'the test graph is closed'); };
  // a mod's settings at the app, a project or a thread (ctx.settings.set, reset), kept as the app keeps them: its data folder's
  // settings.json and settings.scopes.json, the change told to its realms (graph-integrity G8.3: a contribution's per-chat setting)
  const readStored = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } };
  let opSeq = 0;
  runtime.setSettingsWriter(async (modId, patches) => {
    const m = mods.get(modId);
    if (!m) throw new CodexModsError('Unavailable', `${modId} is not running here`);
    const { list } = declarationsOf(m.manifest);
    const [appFile, scopesFile] = [join(m.dataDir, 'settings.json'), join(m.dataDir, 'settings.scopes.json')];
    const next = applyPatches(list, await readStored(appFile), await readStored(scopesFile), patches);
    await mkdir(m.dataDir, { recursive: true });
    await writeFile(appFile, `${JSON.stringify(next.app, null, 2)}\n`);
    await writeFile(scopesFile, `${JSON.stringify(next.scopes, null, 2)}\n`);
    await runtime.settingsChanged(modId, documentOf(list, next.app), next.changed);
    return { id: `settings-${++opSeq}`, outcome: 'succeeded', ...(next.changed.length ? {} : { unchanged: true }) };
  });

  const callerOf = (as) => (as === undefined || as === 'user' ? USER : as === 'app' ? APP : as);

  return {
    /** The runtime itself: resolve, list, related, referrers, query, can, capabilities, onOperation, subscribe. */
    graph, runtime, layout,
    /** What the runtime logged, and the mods it quarantined. */
    logs: entries, quarantines,
    /**
     * A provider of the app's own instances, as the native provider is (owner `native`): `types` maps a type id to `{operations?: {name:
     * handler | {handler, effect?}}, supports?: [optional member names]}`. A handler gets the call (`{ref, operation, args, caller,
     * origin, instance}`) and returns a value or an outcome. Returns the provider's handle: put, update, remove, emit, setComplete.
     * `opts`: `{owner?, onObserve?, search?, contributes?}` (`contributes`: `[{type, via}]`, asked through onObserve `{target, relation}`).
     */
    provider(id, types = {}, opts = {}) {
      live();
      const spec = {};
      for (const [typeId, impl] of Object.entries(types)) {
        const operations = {};
        for (const [name, op] of Object.entries(impl?.operations ?? {})) {
          const one = typeof op === 'function' ? { handler: op } : op;
          const effect = one?.effect ?? 'local';
          if (!EFFECTS.has(effect)) throw new CodexModsError('Invalid', `${typeId}.${name}: effect is none, local or external`);
          operations[name] = { ...one, effect };
        }
        spec[typeId] = { operations, supports: impl?.supports ?? [] };
      }
      const p = graph.registerProvider(opts.owner ?? 'native', id, { types: spec, ...(opts.onObserve ? { onObserve: opts.onObserve } : {}), ...(opts.search ? { search: opts.search } : {}),
        ...(opts.contributes ? { contributes: opts.contributes } : {}) });
      providers.push(p);
      return p;
    },
    /** Call an operation as the user (default), the app (`'app'`), or any caller; `origin` defaults to the app's own place. */
    invoke(ref, operation, args = [], { as, origin = 'app' } = {}) {
      live();
      return graph.invoke({ ref, operation, args, caller: callerOf(as), origin });
    },
    /**
     * The agent's side, offline (graph-integrity G3.5): the Codex agent and its threads as the native provider puts them, with its
     * referees (a mod adds only its own part of what mods share). Its acts run the chain as the app's own do: `start(params)`,
     * `resume(threadId, params)`, `fork(threadId, options)`, `send(threadId, text, options?)` and `setRoots(roots)` each answer
     * `{params}` (what the source would have been sent, after the mods) or `{refused}`; `call(namespace, tool, args)` is the agent's call
     * of a tool (the mod's answer, or the framework's own while it is off); `thread(id, state?, links?)` puts a chat.
     */
    agent() {
      live();
      const AGENT_REF = Object.freeze({ type: 'CodexAgent', provider: 'codex', id: 'codex' });
      const sent = [];
      const feed = {
        async start(params) { sent.push(['thread/start', params]); return { thread: { id: `thread-${sent.length}` } }; },
        async resume(ref, params) { sent.push(['thread/resume', { ...params, threadId: ref.id }]); return { thread: { id: ref.id } }; },
        async setRoots(roots) { sent.push(['skills/extraRoots/set', { extraRoots: roots }]); p.update(AGENT_REF, { state: { skillRoots: [...roots].sort() } }); return null; },
        unanswered(ref) { return { status: 'refused', reason: 'unavailable', message: `the tool ${String(ref.id).split('/').slice(1).join('/')} is not available now: its mod is not installed or not running` }; },
      };
      const native = agentInputTypes(() => feed);
      const record = (method) => async ({ ref, args }) => { sent.push([method, { threadId: ref.id, args }]); return null; };
      const p = graph.registerProvider('native', 'codex', { types: {
        CodexAgent: native.CodexAgent, Tool: native.Tool,
        // a send is the native provider's: a mod's own send, or its change of the user's, is asked about (R17) unless it is an automatic
        // action the user has on (the test graph has nobody to ask: such a call is refused); a change that widens it is refused
        CodexThread: { operations: { ...native.CodexThread.operations, send: { effect: 'external', change: sendChange, widens: sendWidens,
          approval: ({ instance }) => ({ action: `send a message in "${instance?.state?.title ?? 'a chat'}"` }), handler: record('turn/start') },
        fork: { effect: 'external', handler: record('thread/fork') } } },
      } });
      providers.push(p);
      p.put(AGENT_REF, { state: { name: 'Codex', icon: 'codex', available: true } });
      const threadRef = (id) => Object.freeze({ type: 'CodexThread', provider: 'codex', id: String(id) });
      // the app's own act, held for the chain: what it would send on, or its refusal
      const app = async (ref, operation, args) => {
        let forwarded = null;
        const d = await graph.interceptApp({ ref, operation, args, caller: USER, origin: 'app' }, async (a) => { forwarded = a; return { status: 'done', value: null }; });
        if (d.decision === 'refuse' || d.decision === 'failed') return { refused: d.outcome };
        return { params: forwarded ?? args };
      };
      return {
        ref: AGENT_REF, sent,
        thread(id, state = {}, links = {}) {
          const ref = threadRef(id);
          p.put(ref, { state: { title: 'A chat', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1, ...state }, links: { agent: AGENT_REF, ...links } });
          return ref;
        },
        start: async (params = {}) => { const r = await app(AGENT_REF, '_startThread', [params]); return r.refused ? r : { params: r.params[0] }; },
        resume: async (id, params = {}) => { const r = await app(threadRef(id), '_resume', [params]); return r.refused ? r : { params: r.params[0] }; },
        fork: async (id, options = {}) => { const r = await app(threadRef(id), 'fork', [undefined, options]); return r.refused ? r : { params: r.params[1] ?? {} }; },
        send: async (id, text, options = {}) => {
          const r = await app(threadRef(id), 'send', [{ parts: [{ kind: 'text', text: String(text) }] }, options]);
          return r.refused ? r : { params: r.params[1] ?? {} };
        },
        setRoots: async (roots) => { const r = await app(AGENT_REF, '_setSkillRoots', [roots]); return r.refused ? r : { params: r.params[0] }; },
        call: (namespace, tool, args = {}, env = {}) => {
          const ref = Object.freeze({ type: 'Tool', provider: 'codex', id: `${namespace}/${tool}` });
          if (!graph.resolve(ref) || graph.resolve(ref).gone) p.put(ref, { state: { name: String(tool), description: '', enabled: true, source: 'mod' }, links: {} });
          return graph.invoke({ ref, operation: '_call', args: [args, env], caller: { kind: 'native', id: 'codex', owner: 'native' }, origin: 'agent' });
        },
      };
    },
    /**
     * Install and start a mod from its folder (mod.json, its entries), as the Host runs it: its host entry in a worker. `grants`
     * replaces what the manifest asks (the user's consent), for a test of a mod with fewer grants. Returns `{id, manifest, call,
     * renderer, stop}`: `call(service, method, args)` reaches a service it provides; `renderer()` its renderer realm's ctx.
     */
    async mod(dir, { grants, version, internal = false } = {}) {
      live();
      const packageDir = resolve(String(dir));
      const manifest = JSON.parse(await readFile(join(packageDir, 'mod.json'), 'utf8'));
      if (typeof manifest.id !== 'string' || !manifest.id) throw new CodexModsError('Invalid', `${packageDir}/mod.json has no id`);
      if (mods.has(manifest.id)) throw new CodexModsError('Conflict', `${manifest.id} is already running here`);
      const t = new Date().toISOString();
      const given = grants ?? manifest.permissions ?? [];
      const record = { id: manifest.id, version: version ?? manifest.version ?? '0.0.0', status: 'enabled', publisher: null, grants: given,
        dataSchemaVersion: 0, installedAt: t, updatedAt: t, installSeq: mods.size + 1 };
      // `internal`: run it as the Host runs the framework's internal mods (framework/host/internal-mods.mjs: its threads private)
      const installed = { record, manifest: { ...manifest, permissions: given }, packageDir, ...(internal ? { internal: true } : {}),
        dataDir: join(layout.data, manifest.id), retainedDir: join(layout.retained, manifest.id), backendsDir: join(layout.backends, manifest.id) };
      mods.set(manifest.id, installed);
      try { await runtime.activate(installed); } catch (e) { mods.delete(manifest.id); throw e; }
      const id = manifest.id;
      return {
        id, manifest,
        call: async (service, method, args = null) => runtime.callServiceForLease(`mod:${id}`, { name: service, method, args }),
        /** The mod's renderer realm, as one window's page gives it: `ctx.graph` (its reads and `invoke`), settings, storage, events. */
        renderer: () => {
          const [hostPort, realmPort] = portPair();
          runtime.handleRealm('renderer', hostPort, { windowId: ++windowSeq });
          return createRealmClient(realmPort, {}).context(id, 'renderer', { id, version: record.version, dataDir: installed.dataDir });
        },
        stop: async () => { await runtime.deactivate(id, 'test'); mods.delete(id); },
      };
    },
    waitFor,
    /** The user's switch for one of a mod's automatic actions (mod.json `automatic`): on, the mod's calls and changes naming it go
     *  without asking, within its `perHour`. */
    automatic(modId, id, on = true) { if (on) automaticOn.add(`${modId}\n${id}`); else automaticOn.delete(`${modId}\n${id}`); },
    async close() {
      if (closed) return;
      closed = true;
      try { await runtime.close(); } finally {
        for (const p of providers) p.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
