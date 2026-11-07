// Fakes of the Host's other module factories (contracts/host.d.ts), injected through startHost's test-only
// `opts.factories`. CODEXMODS_REAL_MODULES=1 runs the integration tests against the real modules by dropping the override.
// The fake mux really pipes bytes between the app socket and a spawned backend, so the Host wiring (sockets, launchFor,
// environment) is exercised end to end.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listenUnix } from '../../../framework/host/sockets.mjs';
import { buildConfigOverrideArgs, withConfigArgs } from '../../../framework/host/mux/config-overrides.mjs';

/** @param {string[]} rec ordered record of what the Host did, for assertions. */
export function createFakeFactories(rec = [], extra = {}) {
  const calls = { mux: null, runtime: null, recovery: null, operations: null, management: null, packages: null, bus: null };
  let sockExists = null;

  const createBus = (opts) => {
    rec.push('createBus');
    const subs = new Set(), states = new Map();
    const match = (pattern, topic) => pattern === '*' || pattern === topic || (pattern.endsWith('/*') && topic.startsWith(pattern.slice(0, -1)));
    const bus = {
      publish(topic, data, o) {
        if (o?.state) states.set(topic, data);
        for (const s of [...subs]) if (match(s.pattern, topic)) s.fn(data, topic);
      },
      subscribe(pattern, fn) { const s = { pattern, fn }; subs.add(s); return { dispose: () => subs.delete(s) }; },
      state: (topic) => states.get(topic),
    };
    calls.bus = { opts, bus };
    return bus;
  };

  const createMux = (opts) => {
    rec.push('createMux');
    const children = new Set();
    const mux = {
      /** v1.2: every app connection is its own session with its own primary backend. */
      attachApp(stream) {
        rec.push('mux.attachApp');
        // contracts/ipc.d.ts section 4: an optional first line {"codexmodsRelay":1|2,"argv":[...],"envHex"?} carries the app's argv
        // (and, v2, its environment, which this fake decodes and spawns from like the real mux).
        let head = Buffer.alloc(0), started = false;
        stream.on('error', () => {});
        const begin = async (session, rest) => {
          if (started) return; started = true;
          try {
          const refuse = await opts.beforePrimaryStart?.();
          if (refuse) { rec.push('mux.refused'); stream.destroy(); return; }
          const launch = opts.launchFor('primary', undefined, session);
          calls.mux.lastLaunch = launch;
          const args = opts.primaryConfig ? withConfigArgs(launch.args, buildConfigOverrideArgs(opts.primaryConfig.overrides, opts.primaryConfig.vars ?? {})) : launch.args;
          const child = spawn(launch.command, args, { env: session?.env ? { ...session.env, ...launch.env } : launch.env, stdio: ['pipe', 'pipe', 'ignore'] });
          children.add(child);
          child.stdin.on('error', () => {});
          if (rest.length) child.stdin.write(rest);
          stream.on('data', (d) => child.stdin.write(d));
          stream.on('end', () => child.stdin.end());
          child.stdout.pipe(stream);
          stream.on('close', () => { child.kill(); children.delete(child); });
          } catch (e) { rec.push(`mux.spawn-refused:${e.code ?? 'Error'}`); stream.destroy(); }
        };
        const onData = (d) => {
          head = Buffer.concat([head, d]);
          const nl = head.indexOf(10);
          if (nl < 0) return;
          stream.off('data', onData);
          let session;
          try {
            const h = JSON.parse(head.subarray(0, nl).toString('utf8'));
            if (h?.codexmodsRelay === 1 && Array.isArray(h.argv)) session = { argv: h.argv };
            else if (h?.codexmodsRelay === 2 && Array.isArray(h.argv) && typeof h.envHex === 'string') {
              const env = Object.fromEntries(Buffer.from(h.envHex, 'hex').toString('utf8').split('\0').filter((e) => e.indexOf('=') > 0).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
              session = { argv: h.argv, env };
            }
          } catch { /* plain JSONL */ }
          void begin(session, session ? head.subarray(nl + 1) : head);
        };
        stream.on('data', onData);
        stream.on('end', () => { if (!started) void begin(undefined, head); });
      },
      client() { throw new Error('fake mux: client() not supported'); },
      defineBackend: async () => {}, removeBackend: async () => {}, listBackends: () => [],
      issueLease: () => { throw new Error('fake'); }, revokeLease() {}, disposeOwner: async () => {},
      setLeaseServiceHandler(fn) { rec.push('mux.setLeaseServiceHandler'); calls.mux.leaseHandler = fn; },
      onFault: () => ({ dispose() {} }), metrics: () => ({}),
      async close() { rec.push('mux.close'); sockExists && rec.push(`mux.close:app.sock=${sockExists()}`); for (const c of children) c.kill(); },
    };
    calls.mux = { opts, mux };
    return mux;
  };

  const createRuntime = (opts) => {
    rec.push('createRuntime');
    const realms = [];
    const runtime = {
      activate: async () => {}, deactivate: async () => {}, status: () => 'inactive', onFault: () => ({ dispose() {} }),
      settingsChanged() {}, handleRealm(realm, port, identity) { const entry = { realm, port, identity, received: [] }; port.onMessage((m) => entry.received.push(m)); realms.push(entry); rec.push(`runtime.handleRealm:${realm}`); return { dispose() { rec.push('runtime.realm.dispose'); } }; },
      runMigration: async () => {}, deleteSecrets: async () => {}, active: () => calls.runtime.active, provideFrameworkService: () => ({ dispose() {} }),
      callServiceForLease: async (owner, call) => ({ owner, call }),
      async close() { rec.push('runtime.close'); sockExists && rec.push(`runtime.close:app.sock=${sockExists()}`); },
    };
    calls.runtime = { opts, runtime, realms, active: [] };
    return runtime;
  };

  const createPackages = (opts) => { rec.push('createPackages'); calls.packages = { opts, gcKeep: [] }; return { verify: async () => { throw new Error('fake'); }, gc: async (keep) => { calls.packages.gcKeep.push(keep); } }; };

  const createRecovery = (opts) => {
    rec.push('createRecovery');
    const reports = [];
    const recovery = {
      beginBoot: async () => { rec.push('recovery.beginBoot'); return { n: 7 }; },
      report: (s) => { rec.push(`recovery.report:${s}`); reports.push(s); },
      lkg: () => undefined, runOp: async () => ({ outcome: 'succeeded' }), reconcileOp: async () => null, appUpdateAvailable: () => null,
    };
    calls.recovery = { opts, recovery, reports };
    return recovery;
  };

  const createOperations = (opts) => {
    rec.push('createOperations');
    const started = [];
    const ops = {
      start: async (input) => { rec.push(`operations.start:${input.type}`); started.push(input); return 'op-fake'; },
      get: () => undefined, list: () => [], subscribe: () => ({ dispose() {} }),
      recover: async () => { rec.push('operations.recover'); sockExists && rec.push(`operations.recover:app.sock=${sockExists()}`); },
      activateAll: async () => { rec.push('operations.activateAll'); },
      reconcileFramework: async () => { rec.push('operations.reconcileFramework'); if (extra.reconcileThrows) throw new Error('reconcile boom'); },
      gcStore: async () => { rec.push('operations.gcStore'); return { removed: [] }; },
      state: () => extra.state ?? { schemaVersion: 1, mods: {}, safeMode: false, nextInstallSeq: 1 },
      // the user's order, else the install ordinal (as ops/index.mjs)
      rankOf: (id) => { const m = (extra.state ?? { mods: {} }).mods[id]; return m ? (Number.isFinite(m.order) ? m.order : m.installSeq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER; },
      installed: () => undefined, compatibility: () => ({ status: 'compatible', missingRequired: [], missingOptional: [] }),
      quarantine(modId, reason) { rec.push(`operations.quarantine:${modId}:${reason}`); }, setSafeMode: async () => {}, restoreFromGeneration: async () => ({ restored: [], leftDisabled: [] }),
    };
    calls.operations = { opts, ops, started };
    return ops;
  };

  const createManagement = (opts) => {
    rec.push('createManagement');
    const attached = [];
    const m = {
      handle: async () => ({}), subscribe: () => ({ dispose() {} }),
      async listen(socketPath, tokenPath) {
        rec.push('management.listen'); sockExists && rec.push(`management.listen:app.sock=${sockExists()}`);
        writeFileSync(tokenPath, 'fake-token\n', { mode: 0o600 });
        const l = await listenUnix(socketPath, (s) => s.on('error', () => {}));
        return { dispose() { rec.push('management.dispose'); l.close(); } };
      },
      attach(port) { const entry = { port, received: [] }; port.onMessage((m) => entry.received.push(m)); attached.push(entry); rec.push('management.attach'); return { dispose() { rec.push('management.detach'); } }; },
    };
    calls.management = { opts, m, attached };
    return m;
  };

  const stockAppConflict = async () => {
    const c = extra.stockAppConflict ?? false;
    return typeof c === 'object' ? c : { conflict: c, processes: c === true ? [{ pid: 4242, command: 'stock' }] : [] };
  };

  // The framework's own types and provider (docs/design/systems.md S1, S3): only with the graph on, after management.
  const frameworkTypes = () => [{ id: 'F' }];
  const createFrameworkSource = (o) => { calls.frameworkSource = o; rec.push('createFrameworkSource'); return { dispose: () => { rec.push('framework.dispose'); } }; };

  const presentationTypes = () => [{ id: 'P' }];
  const createWindowsSource = (o) => { calls.windowsSource = o; rec.push('createWindowsSource'); return (calls.windows = { dispose: () => { rec.push('windows.dispose'); }, closeChannel() {} }); };
  const factories = { createBus, createMux, createRuntime, createPackages, createRecovery, createOperations, createManagement, stockAppConflict, frameworkTypes, createFrameworkSource, presentationTypes, createWindowsSource };
  Object.defineProperty(factories, 'calls', { value: calls, enumerable: false });
  /** Lets fakes record whether app.sock exists at a given moment (ordering proofs). */
  Object.defineProperty(factories, 'watchAppSocket', { value: (layout) => { sockExists = () => existsSync(join(layout.run, 'app.sock')); }, enumerable: false });
  return factories;
}

export default createFakeFactories();
