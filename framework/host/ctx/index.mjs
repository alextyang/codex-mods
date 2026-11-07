// The Host-side context namespaces, as one table the Realm RPC channels dispatch into.
// Each entry: { calls: {method(scope, ...args)}, subs: {method(scope, args, emit) → Disposable},
//               handlers: {method(scope, args, invoke) → Disposable} }.
// scope = { state: ModState, realm: 'host'|'renderer'|'process', channel }.
import { createAttestations } from './attestations.mjs';
import { createLogNs } from './log.mjs';
import { createSettingsNs } from './settings.mjs';
import { createStorageNs } from './storage.mjs';
import { createSecretsNs } from './secrets.mjs';
import { createPermissionsNs } from './permissions.mjs';
import { createEventsNs } from './events.mjs';
import { createServicesNs } from './services.mjs';
import { createAppServerNs, createBackendsNs, createClientsNs } from './appserver.mjs';
import { createProcessesNs, createProcessRealmNs } from './processes.mjs';
import { createGraphNs } from './graph.mjs';
import { createPresentNs } from './present.mjs';
import { createUiNs } from './ui.mjs';

/** The interceptions running in mods' workers, by their call token: a mod's question asked during one ends with it (E7.6c). */
export function createInterceptions() {
  const live = new Map();   // token -> { state, ends: Set<fn> }
  return {
    begin(token, state) { live.set(token, { state, ends: new Set() }); },
    end(token) { const e = live.get(token); live.delete(token); for (const fn of e?.ends ?? []) { try { fn(); } catch { /* a listener's own fault */ } } },
    /** The state (the mod's) of a running interception, or null. */
    stateOf: (token) => live.get(token)?.state ?? null,
    /** `fn()` when it ends; returns the unsubscribe (null when it is not running). */
    onEnd(token, fn) { const e = live.get(token); if (!e) return null; e.ends.add(fn); return () => e.ends.delete(fn); },
  };
}

export function createNamespaces({ permissions = () => null, bus, services, keychain, muxGlobal, serviceDeadlineMs, graph = () => null, requests = () => null, uiRules = () => null, windows = () => null, settingsNs = null, agent = () => null, themes = () => null }) {
  const interceptions = createInterceptions();
  // the user's intent a page attests for a mod (graph-integrity G7): told by the page as it is minted, taken by the mod's call
  const attestations = createAttestations();
  return {
    log: createLogNs(),
    settings: settingsNs ?? createSettingsNs(),
    storage: createStorageNs('main'),
    'storage.retained': createStorageNs('retained'),
    secrets: createSecretsNs({ keychain, permissions }),
    permissions: createPermissionsNs({ permissions }),
    events: createEventsNs({ bus }),
    services: createServicesNs({ services, deadlineMs: serviceDeadlineMs }),
    appServer: createAppServerNs({ permissions }),
    'appServer.backends': createBackendsNs({ muxGlobal }),
    'appServer.clients': createClientsNs({ muxGlobal }),
    processes: createProcessesNs(),
    process: createProcessRealmNs(),
    graph: createGraphNs({ graph, interceptions, attestations }),
    present: createPresentNs({ requests, graph, agent, themes, attestations }),
    ui: createUiNs({ rules: uiRules, windows, interceptions }),
  };
}
