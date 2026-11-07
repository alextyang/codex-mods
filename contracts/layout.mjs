// On-disk layout (ARCHITECTURE.md §10.1). Every module resolves paths only through this one.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** Canonical publisher fingerprint: first 16 hex of sha256 over the base64 key string; 'dev' for developer packages. */
export const publisherFingerprint = (publisherKey) =>
  publisherKey ? createHash('sha256').update(publisherKey).digest('hex').slice(0, 16) : 'dev';

export const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'CodexMods');
export const DEFAULT_PROFILE = 'default';

/** root: CODEX_MODS_ROOT or DEFAULT_ROOT. profile: CODEX_MODS_PROFILE or DEFAULT_PROFILE. */
export function resolveRoot(env = process.env) {
  return { root: env.CODEX_MODS_ROOT || DEFAULT_ROOT, profile: env.CODEX_MODS_PROFILE || DEFAULT_PROFILE };
}

export function layout(root, profile = DEFAULT_PROFILE) {
  const p = join(root, 'profiles', profile);
  return Object.freeze({
    root,
    profile,
    framework: join(root, 'framework'),                 // <version>/ dirs
    frameworkCurrent: join(root, 'framework', 'current'),   // text file: version
    frameworkPrevious: join(root, 'framework', 'previous'), // text file: version
    frameworkLkg: join(root, 'framework', 'lkg'),           // text file: version of the last healthy boot (written by recovery, read by the loader)
    adapters: join(root, 'adapters'),                   // <appBuild>/adapter.json
    apps: join(root, 'apps'),                           // <build>-<inputsHash>/<App>.app candidates and LKG (v1.4: inputsHash = first 16 hex of sha256 over
                                                        //   adapter.json bytes, loader, relay, signing identity, framework version); the stable launch path is a symlink into here
    store: join(root, 'store'),                         // <modId>/<version>/
    updates: join(root, 'updates'),                     // E5 staging: stock/<build>/ (snapshots of the stock app), framework/<version>/ (verified release trees), git/ (a cache)
    profileDir: p,
    userData: join(p, 'userData'),
    codexHome: join(p, 'codex-home'),                   // unless the profile config points elsewhere (daily: ~/.codex)
    profileConfig: join(p, 'profile.json'),             // ProfileConfig (contracts/state.d.ts)
    state: join(p, 'state.json'),                       // ProfileState
    ops: join(p, 'ops'),                                // <opId>.json
    generations: join(p, 'generations'),                // <n>.json and lkg (text file: n)
    data: join(p, 'data'),                              // <modId>/{store.json,settings.json,files/}
    retained: join(p, 'retained'),                      // <modId>/store.json
    snapshots: join(p, 'snapshots'),                    // <modId>/<fromVersion>/
    orphaned: join(p, 'orphaned'),                      // <modId>/
    backends: join(p, 'backends'),                      // <modId>/<key>/ (CODEX_HOME)
    flags: join(p, 'flags'),                            // disabled, safe, graph, boot markers
    graph: join(p, 'graph'),                            // the graph runtime's intent journal (intents.jsonl); never in the Codex home
    computerUse: join(p, 'computer-use'),               // v1.13: the copy's OWN Computer Use helper install (never <codexHome>/computer-use)
    profileUpdates: join(p, 'updates'),                 // E5: state.json (policy, checks, dismissals, auto attempts) and <planHash>/plan.json
    lkgApp: join(p, 'lkg-app'),                         // v1.6: text file, absolute path of THIS profile's LKG copy (written by recovery on healthy, read by the loader)
    logs: join(p, 'logs'),                              // host.log, <modId>.log
    run: join(p, 'run'),                                // sockets, see SOCKETS
  });
}

export const SOCKETS = Object.freeze({
  app: 'app.sock',          // relay → mux (raw app-server JSONL)
  management: 'mgmt.sock',  // CLI/tools (JSONL, token in mgmt.token, mode 0600)
  clients: 'clients.sock',  // external client leases (first line: {"lease": id, "token": t}; then app-server JSONL)
  processes: 'proc.sock',   // mod processes (first line: {"process": name, "mod": id, "token": t}; then ctx JSON-RPC)
});

export const FLAGS = Object.freeze({
  disabled: 'disabled',   // presence = framework disabled (loader passthrough, relay execs the real binary)
  safe: 'safe',           // presence = safe mode for the next boot (JSON body: {reason})
  graphOff: 'graph-off',  // E6: presence = do not start the graph runtime (it is on by default; the framework's UI needs it, the recovery entry does not)
  bootMarker: 'boot.json',// BootMarker (contracts/state.d.ts), rewritten each boot
  swapReceipt: (opId) => `swap-${opId}.json`, // written by the swap helper: {ok, error?, at}
});
