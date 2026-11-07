// Mod runtime (contracts/host.d.ts Runtime).
// One worker thread per mod host entry; Realm RPC for worker threads, window renderers and mod processes; the context
// namespaces live in ../ctx. See ARCHITECTURE §7 and §8.
import { Worker } from 'node:worker_threads';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { newId } from '../fsutil.mjs';
import { Channel } from './channel.mjs';
import { socketPort } from './socket-port.mjs';
import { runMigration as migrate } from './migration.mjs';
import { createNamespaces } from '../ctx/index.mjs';
import { createThemes } from '../themes.mjs';
import { createAgentHost } from '../agent/index.mjs';
import { createRuleRegistry, readPresentations, readPartsSupported } from '../ui-rules.mjs';
import { createModCommands } from '../mod-commands.mjs';
import { createLinkRoutes } from '../link-routes.mjs';
import { createServiceRegistry } from '../ctx/services.mjs';
import { createKeychain } from '../ctx/secrets.mjs';
import { createProcessManager } from '../ctx/processes.mjs';
import { hiddenRootOf } from '../internal-mods.mjs';
import { createModLogger } from '../ctx/log.mjs';
import { createSettingsNs, changesOf } from '../ctx/settings.mjs';
import { mergeLive } from '../features/status.mjs';
import { allowedMethodsFor, hasGrant } from '../ctx/grants.mjs';
import { asksOf } from '../permissions.mjs';
import { hostDeadline } from '../deadline.mjs';
import { createMenuBar } from '../menu-bar.mjs';

export const TIMING = Object.freeze({
  activationMs: 10000,       // activate must settle
  heartbeatMs: 1000,         // worker heartbeat period
  heartbeatTimeoutMs: 5000,  // no heartbeat for this long of the Host's own time → terminate + quarantine
  hostStallMs: 2000,         // a watchdog tick this late: the Host itself stalled, and the gap is not the mod's silence
  drainMs: 5000,             // deactivate drain before terminate
  faultLimit: 3,
  faultWindowMs: 600000,
});
export const WORKER_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256 });
/** The modId the page's own runtime uses on the renderer channel (see scopeFor). Not a mod: no mod may have this id. */
export const FRAMEWORK_MOD_ID = 'codexmods.framework';
/** The framework scope's state (see scopeFor): not a mod's, so it has no logger, stores, mux or provider; `framework` marks it. */
const FRAMEWORK_STATE = Object.freeze({ id: 'framework', owner: 'framework', grants: Object.freeze(['graph']), framework: true });

/**
 * The namespace table with every namespace but `graph` and `present` refusing the framework scope (Denied), so the page runtime's id
 * reaches only the graph's reads, `invoke` and the page's own presentation calls; a namespace added later is refused to it until it is let through here.
 */
function onlyGraphForFramework(table) {
  const guard = (fn) => (scope, ...rest) => {
    if (scope.state.framework === true) throw new CodexModsError('Denied', 'the framework scope reaches the reads of ctx.graph and invoke only');
    return fn(scope, ...rest);
  };
  const out = {};
  for (const [ns, groups] of Object.entries(table)) {
    if (ns === 'graph' || ns === 'present' || ns === 'ui') { out[ns] = groups; continue; }   // present and ui check the framework scope themselves
    out[ns] = Object.fromEntries(Object.entries(groups).map(([kind, fns]) =>
      [kind, Object.fromEntries(Object.entries(fns).map(([name, fn]) => [name, typeof fn === 'function' ? guard(fn) : fn]))]));
  }
  return out;
}
const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Parameters<import('../../../contracts/host.js').createRuntime>[0] & {internals?: object}} opts
 *   internals (tests only): {timing, processes, secretsServicePrefix, securityRun}
 * @returns {import('../../../contracts/host.js').Runtime}
 */
export function createRuntime(opts) {
  const { mux, bus, log, layout, rankOf, onQuarantine, announceRenderer } = opts;
  const internals = opts.internals ?? {};
  const T = { ...TIMING, ...(internals.timing ?? {}) };

  /** @type {Map<string, any>} */ const mods = new Map();
  /** @type {Map<number, {windowId: number, channel: Channel, probe: any}>} */ const windows = new Map();
  const faultListeners = new Set();
  const services = createServiceRegistry();
  const keychain = createKeychain({ servicePrefix: internals.secretsServicePrefix ?? 'codexmods', profile: layout.profile, run: internals.securityRun });
  let closed = false;

  // ------------------------------------------------------------------ faults and quarantine
  /** count:false publishes the fault but does not count it toward the three-in-ten-minutes quarantine (process exits are
   *  supervised by their own restart budget). */
  function recordFault(modId, realm, kind, message, { count = true, stack, where } = {}) {
    const event = { modId, realm, kind, message: String(message ?? '').slice(0, 2000), ...(typeof stack === 'string' ? { stack: stack.slice(0, 8000) } : {}), ...(typeof where === 'string' ? { where: where.slice(0, 200) } : {}) };
    bus.publish('framework/fault', event);
    for (const fn of [...faultListeners]) { try { fn(event); } catch (e) { log.warn('fault listener threw', { message: String(e?.message ?? e) }); } }
    const state = mods.get(modId);
    if (!state || state.quarantined || !count) return;
    const t = Date.now();
    state.faults = state.faults.filter((x) => t - x < T.faultWindowMs);
    state.faults.push(t);
    if (state.faults.length >= T.faultLimit) quarantine(state, 'faults');
  }
  function quarantine(state, reason) {
    if (state.quarantined) return;
    state.quarantined = true;
    log.warn('mod quarantined', { modId: state.id, reason });
    bus.publish('framework/quarantine', { modId: state.id, reason });
    try { onQuarantine(state.id, reason); } catch (e) { log.error('onQuarantine threw', { message: String(e?.message ?? e) }); }
  }
  const muxFault = mux.onFault((e) => {
    const m = /^mod:(.+)$/.exec(e.clientId ?? '');
    if (m) recordFault(m[1], 'mux', e.kind, e.message);
  });

  // ------------------------------------------------------------------ Realm RPC plumbing
  const processes = createProcessManager({
    layout, log: log.child?.('processes') ?? log, internals,
    fault: recordFault,
    authenticated(socket, rest, identity) { attachProcess(socketPort(socket, rest), identity); },
  });

  /**
   * The scope a message runs in: the mod it names (the worker and process channels are bound to their one mod by `Channel`'s
   * boundModId, checked before this is called) and the channel's realm.
   *
   * The reserved id FRAMEWORK_MOD_ID is the page's own runtime, not a mod (docs/design/presentations.md V6). Only the renderer channel
   * resolves it, to the framework scope: realm renderer, grants ['graph'], owner 'framework', caller {kind: 'framework', id: 'framework'}
   * for `invoke`. That scope reaches the `graph` namespace's reads and `invoke` and nothing else: `ctx/graph.mjs` refuses it the
   * writes, and `onlyGraphForFramework` refuses it every other namespace.
   *
   * TRUST BOUNDARY: the renderer channel is the window's page realm, which is trusted as in v1 (ARCHITECTURE §7.3: renderer isolation is
   * best-effort). The Host cannot tell the page runtime from any other code in that realm, so nothing here authenticates the id: a
   * renderer module that talked to the channel's port directly could claim it and read the graph, or invoke as the framework, without
   * the `graph` grant. That is accepted for the page realm; what the id grants is the least the page runtime needs. It cannot be
   * claimed from a worker or a process (their channels are bound to their own mod, and `Channel` refuses any other modId before this
   * is called), and `activate` refuses a mod with this id, so a mod can neither shadow it nor be shadowed by it.
   */
  function scopeFor(channel, modId) {
    if (modId === FRAMEWORK_MOD_ID) {
      if (channel.kind !== 'renderer') throw new CodexModsError('Denied', `${FRAMEWORK_MOD_ID} is reserved for the page's runtime on the renderer channel`);
      return { state: FRAMEWORK_STATE, realm: 'renderer', channel };
    }
    const state = mods.get(modId);
    if (!state) throw new CodexModsError('Unavailable', `mod ${modId} is not active`);
    if (channel.kind === 'renderer') {
      if (state.status !== 'active') throw new CodexModsError('Unavailable', `mod ${modId} is not active`);
      if (!state.mod.manifest.entry.renderer) throw new CodexModsError('Denied', `mod ${modId} has no renderer entry`);
    } else if (state.status === 'stopping' && channel.kind === 'process') {
      throw new CodexModsError('Unavailable', `mod ${modId} is stopping`);
    }
    return { state, realm: channel.realm, channel };
  }
  // The mods' presentation rules (docs/design/systems.md S6): the registry of record, with what the framework's bindings realize.
  const uiRules = createRuleRegistry({
    presentations: internals.presentations ?? readPresentations(fileURLToPath(new URL('../../renderer/present/addresses.json', import.meta.url))),
    parts: internals.parts ?? readPartsSupported(fileURLToPath(new URL('../../renderer/present/addresses.json', import.meta.url)), opts.seamHooks ?? null),
    rankOf: (id) => rankOf(id), typeExists: (t) => !opts.graph || !!opts.graph.type(t),
    frameworkOwned: (t) => { const c = opts.graph?.type(t)?.chain; return Array.isArray(c) && c.some((id) => opts.graph.type(id)?.owner === 'framework'); },
    ownThread: (modId, t) => { const x = opts.graph?.type(t); return !!x && x.owner === `mod:${modId}` && Array.isArray(x.chain) && x.chain.includes('Thread'); },
    log: log.child?.('ui-rules') ?? log,
  });
  // The menu bar's mod entries (mod-surfaces.md §3.4): projected to framework-main, chosen entries run where their function is.
  const menuBar = opts.mainOps ? createMenuBar({ rules: uiRules, mainOps: opts.mainOps, windows: () => opts.windows ?? null, log: log.child?.('menu-bar') ?? log }) : null;
  // The mods' commands as graph Commands (E8.11): run as the palette's row runs them.
  let modCommands = null;
  if (opts.graph) {
    try { modCommands = createModCommands({ graph: opts.graph, rules: uiRules, windows: () => opts.windows ?? null, nameOf: (id) => mods.get(id)?.mod?.manifest?.name || id, log: log.child?.('mod-commands') ?? log }); }
    catch (e) { log.warn?.('the mods\' commands are not in the graph', { message: String(e?.message ?? e) }); }
  }
  // Where a link the user opens goes (public-hooks.md §3.14, ui.links.route): framework-main holds the app's links while a route exists.
  let linkRoutes = null;
  if (opts.mainOps) {
    // the chat a link was opened in: the app's own (a mod's chats are drawn in its own view, not the app's thread view)
    const threadOf = (id) => {
      const snap = opts.graph?.resolve(Object.freeze({ type: 'CodexThread', provider: 'codex', id }));
      return snap && !snap.gone ? snap.ref : null;
    };
    try {
      linkRoutes = createLinkRoutes({ rules: uiRules, mainOps: opts.mainOps, windows: () => opts.windows ?? null, threadOf, chainOf: (t) => opts.graph?.type(t)?.chain ?? [t],
        nameOf: (id) => mods.get(id)?.mod?.manifest?.name || id, log: log.child?.('links') ?? log });
    } catch (e) { log.warn?.('links: the mods\' routes are off', { message: String(e?.message ?? e) }); }
  }
  // The mods' themes (public-hooks.md §3.14, H7y): the one the user chose, written as the app's appearance settings while it is on.
  const themes = opts.graph ? createThemes({ rules: uiRules, graph: () => opts.graph ?? null, file: opts.layout?.graph ? join(opts.layout.graph, 'themes.json') : undefined,
    log: log.child?.('themes') ?? log }) : null;
  // ctx.settings (E3): a thread's project from the graph, and scoped patches through management once main hands the writer over.
  let settingsWriter = null;
  const settingsNs = createSettingsNs({ graph: () => opts.graph ?? null, write: () => settingsWriter });
  // What the framework keeps of the agent's inputs (graph-integrity G3.5: the `mod_` names on the app's starts, a mention's context): made
  // now, again later if it could not be made then.
  let agentHost = null;
  const agent = () => {
    if (!agentHost && !closed) agentHost = createAgentHost({ mux, log: log.child?.('agent') ?? log, nameOf: (id) => mods.get(id)?.mod?.manifest?.name || id });
    return agentHost;
  };
  try { agent(); } catch (e) { log.warn('the agent part is not running yet', { message: String(e?.message ?? e) }); }
  const namespaces = onlyGraphForFramework(createNamespaces({ permissions: () => opts.permissions ?? null, bus, services, keychain, muxGlobal: () => mux, serviceDeadlineMs: internals.serviceDeadlineMs, graph: () => opts.graph ?? null, requests: () => opts.requests ?? null, uiRules: () => uiRules, windows: () => opts.windows ?? null, settingsNs, agent, themes: () => themes }));
  const rt = { namespaces, scopeFor, log };

  // ------------------------------------------------------------------ renderer modules, probes
  function modulesList() {
    const list = [];
    for (const state of mods.values()) {
      const entry = state.mod.manifest.entry.renderer;
      if (state.status !== 'active' || !entry || !state.rev) continue;
      const path = entry.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/');
      list.push({ modId: state.id, url: `codexmod://${state.id}/${state.rev}/${path}`, version: state.mod.record.version, dataDir: state.mod.dataDir });
    }
    return list;
  }
  function pushModules() {
    const modules = modulesList();
    for (const w of windows.values()) w.channel.post({ t: 'modules', modules });
  }
  function publishProbe() {
    // Only complete reports feed compatibility; bootstrap/mod-view probes (complete !== true) are kept per window but never published.
    const reports = [...windows.values()].map((w) => w.probe).filter((r) => r && r.complete === true);
    if (reports.length === 0) return; // nothing complete yet (or no window left): publish nothing / keep the last union (the Bus cannot unset a state topic)
    const items = {};
    for (const r of reports) for (const [k, v] of Object.entries(r.items ?? {})) items[k] = items[k] === true || v === true;
    const latest = reports.reduce((a, b) => (String(b.at) > String(a.at) ? b : a));
    // Each binding's state across the live windows (the feature log's live evidence, E4): a trip in any window wins.
    const { bindings } = mergeLive(reports);
    bus.publish('framework/probe', { appBuild: latest.appBuild, at: latest.at, items, bindings, complete: true }, { state: true });
  }
  function onRendererMessage(w, msg) {
    switch (msg.t) {
      case 'fault':
        if (typeof msg.modId === 'string') recordFault(msg.modId, 'renderer', 'throw', msg.message, { stack: msg.stack, where: msg.where });
        return;
      case 'probe':
        if (isObject(msg.report)) { w.probe = msg.report; publishProbe(); }
        return;
      case 'theme':   // the app's theme as the window shows it (breadth.md D4): the native provider's Theme follows it
        if (isObject(msg.tokens)) bus.publish('framework/theme', { windowId: w.windowId, tokens: msg.tokens, appearance: msg.appearance === 'dark' ? 'dark' : 'light' });
        return;
      default: log.debug('unknown renderer message', { type: String(msg.t) });
    }
  }

  function attachRenderer(port, identity) {
    const prev = windows.get(identity.windowId);
    if (prev) prev.channel.close();
    const w = { windowId: identity.windowId, channel: null, probe: null };
    const channel = new Channel({ rt, port, kind: 'renderer', identity, onControl: (msg) => onRendererMessage(w, msg) });
    w.channel = channel;
    channel.onClosed = () => {
      if (windows.get(w.windowId) === w) windows.delete(w.windowId);
      uiRules.closeWindow(w.windowId);
      try { opts.windows?.closeChannel(channel); } catch (e) { log.warn('the window\'s presentations were not closed', { message: String(e?.message ?? e) }); }
      publishProbe();
    };
    windows.set(w.windowId, w);
    channel.post({ t: 'modules', modules: modulesList() });
    return { dispose: () => channel.close() };
  }

  function attachProcess(port, identity) {
    const state = mods.get(identity.modId);
    if (!state || state.status === 'stopping' || !state.mod.manifest.processes || !Object.hasOwn(state.mod.manifest.processes, identity.process)) {
      port.close?.();
      return { dispose() {} };
    }
    const channel = new Channel({
      rt, port, kind: 'process', boundModId: identity.modId, identity,
      onControl: (msg) => { if (msg.t === 'fault') recordFault(identity.modId, 'process', 'throw', msg.message); },
    });
    state.procs.connected(identity.process, channel);
    channel.onClosed = () => state.procs.disconnected(identity.process, channel);
    return { dispose: () => channel.close() };
  }

  // ------------------------------------------------------------------ host worker
  function launchWorker(state) {
    const worker = new Worker(WORKER_URL, { resourceLimits: { ...WORKER_LIMITS }, workerData: { heartbeatMs: T.heartbeatMs }, stdout: false, stderr: false });
    const port = {
      post: (m) => worker.postMessage(m),
      onMessage: (fn) => { worker.on('message', fn); return { dispose: () => { worker.off('message', fn); } }; },
      onClose: (fn) => { worker.on('exit', fn); return { dispose: () => { worker.off('exit', fn); } }; },
    };
    internals.onWorker?.(state.id, worker);
    const ctrl = { worker, channel: null, last: performance.now(), stalled: 0, alive: true, hbTimer: null, lastError: null, onActivated: null, onFailed: null };
    ctrl.exited = new Promise((res) => { worker.once('exit', (code) => { ctrl.alive = false; res(code); }); });
    ctrl.channel = new Channel({
      rt, port, kind: 'worker', boundModId: state.id, identity: { modId: state.id },
      onControl(msg) {
        switch (msg.t) {
          case 'heartbeat': ctrl.last = performance.now(); ctrl.stalled = 0; return;
          case 'activated': ctrl.onActivated?.(); return;
          case 'activate-failed': ctrl.onFailed?.(msg.error); return;
          case 'fault':
            recordFault(state.id, 'host', 'throw', msg.message, { stack: msg.stack });
            return;
          default: log.debug('unknown worker message', { type: String(msg.t) });
        }
      },
    });
    worker.on('error', (e) => { ctrl.lastError = e; log.warn('worker error', { modId: state.id, message: String(e?.message ?? e) }); });
    worker.on('exit', (code) => {
      if (state.status === 'activating') ctrl.onFailed?.({ code: 'Unavailable', message: `the mod's worker exited during activation (${code}${ctrl.lastError ? `: ${ctrl.lastError.message}` : ''})` });
      else if (state.status === 'active') workerDied(state, code, ctrl);
    });
    return ctrl;
  }

  function startHostWorker(state) {
    const entry = state.mod.manifest.entry.host;
    const abs = resolve(state.mod.packageDir, entry);
    const rel = relative(state.mod.packageDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new CodexModsError('Invalid', 'the host entry is outside the package');
    const ctrl = launchWorker(state);
    state.ctrl = ctrl;
    return new Promise((resolveP, rejectP) => {
      const deadline = hostDeadline(T.activationMs, () => rejectP(new CodexModsError('Timeout', `activation did not settle within ${T.activationMs} ms`)), { unref: false });
      ctrl.onActivated = () => { deadline.stop(); resolveP(); };
      ctrl.onFailed = (err) => { deadline.stop(); rejectP(new CodexModsError(err?.code ?? 'Invalid', err?.message ?? 'activation failed')); };
      ctrl.worker.postMessage({
        t: 'activate', modId: state.id, entry: pathToFileURL(abs).href,
        info: { id: state.id, version: state.mod.record.version, dataDir: state.mod.dataDir },
      });
    }).then(() => {
      ctrl.last = performance.now();
      ctrl.stalled = 0;
      let tickedAt = ctrl.last, waited = false;
      ctrl.hbTimer = setInterval(() => {
        const now = performance.now(), gap = now - tickedAt;
        tickedAt = now;
        if (state.status !== 'active') return;
        // Silence counts only the Host's own time. A tick this late means the Host itself stalled (a long synchronous job, the machine
        // asleep): the stall is not the mod's silence, and the heartbeats the worker sent meanwhile are still queued behind this tick,
        // so it leaves the judgement to the next tick. It waits once in a row: a Host that stays that slow still has every second tick
        // judge, and a worker that is really stuck still runs out of time.
        if (gap > T.hostStallMs) {
          ctrl.stalled += gap - T.heartbeatMs;
          if (!waited) { waited = true; return; }
        }
        waited = false;
        if (now - ctrl.last - ctrl.stalled <= T.heartbeatTimeoutMs) return;
        clearInterval(ctrl.hbTimer);
        unresponsive(state, ctrl);
      }, T.heartbeatMs);
      ctrl.hbTimer.unref?.();
    });
  }

  async function unresponsive(state, ctrl) {
    log.warn('mod worker missed heartbeats; terminating', { modId: state.id });
    state.stopRequested = true;
    await ctrl.worker.terminate().catch(() => {});
    recordFault(state.id, 'host', 'unresponsive', `no heartbeat for more than ${T.heartbeatTimeoutMs} ms`);
    quarantine(state, 'unresponsive');
    await teardown(state, { immediate: true });
  }
  async function workerDied(state, code, ctrl) {
    if (state.stopRequested || state.status !== 'active') return;
    log.warn('mod worker exited unexpectedly', { modId: state.id, code });
    recordFault(state.id, 'host', 'crash', `the mod's worker exited unexpectedly (${code}${ctrl.lastError ? `: ${ctrl.lastError.message}` : ''})`);
    quarantine(state, 'crashed');
    await teardown(state, { immediate: true });
  }

  // ------------------------------------------------------------------ activate / deactivate
  async function attempt(what, state, fn) {
    try { await fn(); } catch (e) { log.warn(`${what} failed`, { modId: state.id, message: String(e?.message ?? e) }); }
  }
  async function teardown(state, { immediate = false } = {}) {
    state.teardown ??= (async () => {
      state.status = 'stopping';
      state.stopRequested = true;
      const ctrl = state.ctrl;
      if (ctrl) {
        clearInterval(ctrl.hbTimer);
        if (ctrl.alive) {
          if (!immediate) {
            try { ctrl.worker.postMessage({ t: 'deactivate' }); } catch { /* worker already gone */ }
            let timer;
            await Promise.race([ctrl.exited, new Promise((r) => { timer = setTimeout(r, T.drainMs); })]);
            clearTimeout(timer);
          }
          if (ctrl.alive) await ctrl.worker.terminate().catch(() => {});
        }
        await ctrl.exited.catch(() => {});
        ctrl.channel.close();
      }
      services.removeMod(state.id);
      await attempt('mux client dispose', state, () => state.mux?.dispose());
      await attempt('mux disposeOwner', state, () => mux.disposeOwner(state.owner));
      // Its types and its provider go with it; the provider's instances are removed (every surface that lists them drops them).
      if (opts.graph) await attempt('graph disposeOwner', state, () => opts.graph.disposeOwner(state.owner));
      // its attached data is written to its data directory and leaves memory (kept or deleted with that directory, 04 §9)
      if (opts.graph?.attachments) await attempt('attached data', state, () => opts.graph.attachments.unload(state.id));
      await attempt('presentation rules', state, () => uiRules.disposeMod(state.id));
      await attempt('questions', state, () => opts.windows?.cancelAsks?.(state.id));
      await attempt('the Dock badge', state, () => opts.windows?.releaseBadge?.(state.id));
      await attempt('stopping processes', state, () => state.procs?.stopAll());
      for (const w of windows.values()) w.channel.closeMod(state.id);
      state.settingsListeners.clear();
      await attempt('permission prompts', state, () => opts.permissions?.ended?.(state.id));
      await Promise.allSettled(Object.values(state.stores).map((s) => s.close()));
      await state.logger.flush().catch(() => {});
      if (mods.get(state.id) === state) mods.delete(state.id);
      if (state.rev) announceRenderer(state.id, null);
      state.status = 'inactive';
      pushModules();
    })();
    return state.teardown;
  }

  async function doActivate(state) {
    const manifest = state.mod.manifest;
    try {
      // a request under an `ask` grant is held by the ctx gate; once that let it through, the mux carries it
      // an internal mod's threads under its data folder's `threads` are private (the mux's private threads: reference-mods.md §2)
      state.mux = mux.client(state.owner, { rank: rankOf(state.id), allowedMethods: allowedMethodsFor([...state.grants, ...asksOf(state.mod.record).filter((g) => g.startsWith('appServer.request'))]),
        ...(state.mod.internal === true && state.mod.dataDir ? { hiddenRoot: hiddenRootOf(state.mod.dataDir) } : {}) });
      state.procs = processes.forMod(state);
      // Its attached data (public-hooks.md §3.3) comes back from its data directory before its code runs.
      if (opts.graph?.attachments && state.mod.dataDir) opts.graph.attachments.load(state.id, state.mod.dataDir);
      await state.procs.startAuto('worker');
      if (manifest.entry.host) await startHostWorker(state);
      if (state.stopRequested) throw new CodexModsError('Disposed', 'the mod was deactivated while activating');
      state.status = 'active';
      // a session that starts with the mod starts once its host code ran, so the listeners that code set up hear its first lines, and
      // after the activation, which finding its program on the user's PATH must not hold up (G8.2); a failure is the mod's fault to see
      state.procs.startAuto('session').catch((e) => {
        if (state.status === 'active') recordFault(state.id, 'process', 'start', `a session that starts with the mod did not start: ${e?.message ?? e}`, { count: false });
      });
      // Its host-realm rules were registered while it activated: windows get them again with its rank, known now (ui-rules.mjs).
      uiRules.reorder(state.id);
      if (manifest.entry.renderer) {
        state.rev = newId('rev');
        announceRenderer(state.id, { packageDir: state.mod.packageDir, entry: manifest.entry.renderer, rev: state.rev });
      }
      pushModules();
    } catch (e) {
      const code = e instanceof CodexModsError ? e.code : 'Invalid';
      const message = String(e?.message ?? e);
      const effectsAttempted = state.effects || state.mux?.hasTransmitted === true;
      await teardown(state, { immediate: true });
      throw new CodexModsError(code, `activation of ${state.id} failed: ${message}`, { code, message, effectsAttempted });
    }
  }

  const runtime = {
    async activate(mod) {
      const refuse = (code, message) => new CodexModsError(code, message, { code, message, effectsAttempted: false });
      if (closed) throw refuse('Unavailable', 'the runtime is closed');
      const id = mod?.manifest?.id;
      if (!id || !mod.record) throw refuse('Invalid', 'activate needs an InstalledMod');
      if (id === FRAMEWORK_MOD_ID) throw refuse('Invalid', `${id} is reserved for the framework's page runtime and cannot be a mod`);
      const entry = mod.manifest.entry ?? {};
      if (!entry.host && !entry.renderer) throw refuse('Invalid', 'the mod has no entry');
      if (Object.keys(mod.manifest.processes ?? {}).length > 0 && !hasGrant(mod.record.grants ?? [], 'processes')) {
        throw refuse('Denied', 'the mod declares processes but has not been granted processes');
      }
      const existing = mods.get(id);
      if (existing) {
        if (existing.status === 'activating') return existing.activation;
        if (existing.status === 'active') return;
        await existing.teardown;
      }
      const state = {
        id, mod, grants: [...(mod.record.grants ?? [])], owner: `mod:${id}`, status: 'activating', rev: null,
        mux: null, procs: null, ctrl: null, effects: false, faults: [], quarantined: false, stopRequested: false, teardown: null,
        logger: createModLogger({ file: join(layout.logs, `${id}.log`), onWrite: () => opts.activity?.touch(id) }),
        stores: {}, settingsValue: undefined, settingsListeners: new Set(),
        backendHomes: new Map(), leases: new Set(), graphProvider: null,
      };
      mods.set(id, state);
      state.activation = doActivate(state);
      return state.activation;
    },

    async deactivate(modId, reason) {
      const state = mods.get(modId);
      if (!state) return;
      log.info('deactivating mod', { modId, reason: String(reason ?? '') });
      if (state.status === 'activating') {
        state.stopRequested = true;
        try { await state.ctrl?.worker.terminate(); } catch { /* ignore */ }
        await state.activation?.catch(() => {});
      }
      await teardown(state);
    },

    status(modId) { return mods.get(modId)?.status ?? 'inactive'; },
    /** Ask a window's page to show an instance (Window.open, S11): its own page if the framework's, else the DetailView. */
    showDetail(windowId, ref) { const w = windows.get(windowId); if (!w?.channel) return false; w.channel.post({ t: 'detail', ref }); return true; },
    /** The user's order changed (E6): every window gets each running mod's rules with its new rank. */
    reranked() { for (const id of mods.keys()) uiRules.reorder(id); },
    /** An active mod's display name (its manifest's), or null. */
    nameOf(modId) { const n = mods.get(modId)?.mod?.manifest?.name; return typeof n === 'string' && n ? n : null; },


    onFault(fn) { faultListeners.add(fn); return { dispose: () => { faultListeners.delete(fn); } }; },

    /** framework-main's settings writer (main.mjs, once management exists): scoped patches as the mod (ctx.settings.set, reset). */
    setSettingsWriter(fn) { settingsWriter = typeof fn === 'function' ? fn : null; },

    /** A mod's settings changed: its whole document, and for patches what changed (E3: [{key, scope}]), told to every realm. */
    async settingsChanged(modId, value, changes) {
      const state = mods.get(modId);
      if (!state) return;
      state.settingsValue = structuredClone(value) ?? {};
      state.settingsStored = undefined;
      const told = changes ? await changesOf(settingsNs, state, changes) : [];
      for (const l of [...state.settingsListeners]) {
        try {
          if (!told.length) l(structuredClone(state.settingsValue));
          for (const c of told) l(structuredClone(state.settingsValue), structuredClone(c));
        } catch { /* listener */ }
      }
      if (state.mod.manifest.entry.renderer) {
        for (const w of windows.values()) w.channel.post({ t: 'settings', modId, value: state.settingsValue });
      }
    },

    handleRealm(realm, port, identity) {
      if (realm === 'renderer') return attachRenderer(port, identity);
      if (realm === 'process') return attachProcess(port, identity);
      throw new CodexModsError('Invalid', `unknown realm ${String(realm)}`);
    },

    runMigration(o) { return migrate(o); },

    deleteSecrets(modId, publisherFingerprint) { return keychain.deleteAll(modId, publisherFingerprint); },

    active() { return [...mods.values()].filter((s) => s.status === 'active' || s.status === 'activating').map((s) => s.id); },
    /** The mods' presentation rules the Host holds (diagnostics): `mod/id`, kind, presentation and realm. */
    /** A mod's rules as places (framework-ui.md F13): what each declares it presents and where, from the registry; not where it drew. */
    rulesOf(modId) { return uiRules.snapshot().filter((r) => r.mod === modId).map((r) => ({ kind: r.kind, ...(r.presentation ? { presentation: r.presentation } : {}), ...(r.slot ? { slot: r.slot } : {}) })); },
    /** The rules changed (a mod's registered or gone, a window's). */
    onRulesChange(fn) { return uiRules.subscribe(() => fn()); },
    presentationRules() { return uiRules.snapshot().map((r) => ({ rule: `${r.mod}/${r.id}`, kind: r.kind, ...(r.presentation ? { presentation: r.presentation } : {}), realm: r.realm, order: r.order })); },

    provideFrameworkService(name, handlers) { return services.provideFramework(name, handlers); },

    callServiceForLease(leaseOwner, call) {
      const modId = typeof leaseOwner === 'string' && leaseOwner.startsWith('mod:') ? leaseOwner.slice(4) : leaseOwner;
      if (!isObject(call)) throw new CodexModsError('Invalid', 'call must be {name, method, args}');
      return services.call(modId, call.name, call.method, call.args === undefined ? null : call.args, `lease:${leaseOwner}`);
    },


    async close() {
      menuBar?.dispose();
      themes?.dispose();
      modCommands?.dispose();
      linkRoutes?.dispose();
      closed = true;
      muxFault.dispose();
      await Promise.allSettled([...mods.keys()].map((id) => runtime.deactivate(id, 'runtime closing')));
      for (const w of [...windows.values()]) w.channel.close();
      await processes.close();
      agentHost?.dispose();
    },
  };
  return runtime;
}
