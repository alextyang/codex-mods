// Test harness for the operations tests: temp root, fake Runtime/Bus/Mux/Recovery, real signed packages.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { layout } from '../../../../contracts/layout.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';
import { CodexModsError } from '../../../../sdk/errors.mjs';
import { createPackages } from '../../packages/index.mjs';
import { tempRoot, baseManifest, buildSigned, writeModDir, keygen } from '../../packages/testkit.mjs';
import { createOperations } from '../index.mjs';

export { baseManifest, keygen };

export class FakeBus {
  constructor() { this.states = new Map(); this.published = []; this.subs = []; }
  publish(topic, data, o) { this.published.push({ topic, data }); if (o?.state) this.states.set(topic, data); for (const s of this.subs) if (s.pattern === topic) s.fn(data, topic); }
  subscribe(pattern, fn) { const s = { pattern, fn }; this.subs.push(s); return { dispose: () => { this.subs = this.subs.filter((x) => x !== s); } }; }
  state(topic) { return this.states.get(topic); }
}

export class FakeRuntime {
  constructor() {
    this.calls = [];
    this.active = new Set();
    this.faultFns = [];
    this.activateErrors = new Map();     // modId → Error | (mod) => Error|undefined
    this.activateGate = null;            // async (mod) => void, to block/observe an activation
    this.migrate = async () => {};       // async (opts) => void
    this.onActivate = null;              // (mod) => void, called on successful activation
  }
  log(fn, ...args) { this.calls.push({ fn, args }); }
  names(fn) { return this.calls.filter((c) => c.fn === fn).map((c) => c.args); }
  status(id) { return this.active.has(id) ? 'active' : 'inactive'; }
  async activate(mod) {
    this.log('activate', mod.record.id, mod.record.version);
    if (this.activateGate) await this.activateGate(mod);
    const e = this.activateErrors.get(mod.record.id);
    const err = typeof e === 'function' ? e(mod) : e;
    if (err) throw err;
    this.active.add(mod.record.id);
    this.onActivate?.(mod);
  }
  async deactivate(id, reason) { this.log('deactivate', id, reason); this.active.delete(id); }
  onFault(fn) { this.faultFns.push(fn); return { dispose: () => { this.faultFns = this.faultFns.filter((f) => f !== fn); } }; }
  emitFault(modId, message = 'boom') { for (const f of this.faultFns) f({ modId, realm: 'host', kind: 'throw', message }); }
  settingsChanged(id, value, changes) { if (changes === undefined) this.log('settingsChanged', id, value); else this.log('settingsChanged', id, value, changes); if (this.settingsError) throw this.settingsError; }
  async runMigration(o) { this.log('runMigration', o.mod.record.id, o.from, o.to, o.script, o.timeoutMs); await this.migrate(o); }
  async deleteSecrets(id, fp) { this.log('deleteSecrets', id, fp); if (this.deleteSecretsError) throw this.deleteSecretsError; }
}

export class FakeRecovery {
  constructor() { this.ran = []; this.reconciled = []; this.runOpImpl = async () => ({ outcome: 'succeeded' }); this.reconcileImpl = async () => null; }
  async runOp(op, journal) { this.ran.push(op); return this.runOpImpl(op, journal); }
  async reconcileOp(op) { this.reconciled.push(op); return this.reconcileImpl(op); }
}

export const activationError = (effectsAttempted, message = 'activation failed') =>
  new CodexModsError('Unavailable', message, { code: 'Unavailable', message, effectsAttempted });

export const ADAPTER = {
  adapterVersion: '1.0.0',
  protocol: { methods: { clientRequests: ['thread/start', 'thread/compact/start'], clientNotifications: ['initialized'], serverRequests: ['item/approval'], serverNotifications: ['turn/completed'] } },
};

/** A fresh root with all fakes and a factory for Operations instances on the same root. */
export async function harness({ safeMode = false, healthWindowMs = 40, frameworkVersion = '1.0.0', patchWaitMs } = {}) {
  const t = await tempRoot();
  const L = layout(t.root);
  const log = createTestLog();
  const packages = createPackages({ layout: L, log, frameworkVersion });
  const key = keygen();
  const H = {
    root: t.root, L, log, packages, key, bus: new FakeBus(), runtime: new FakeRuntime(), recovery: new FakeRecovery(),
    mux: { disposed: [], async disposeOwner(o) { this.disposed.push(o); } },
    adapter: ADAPTER, cleanup: t.cleanup, ops: null,
    create(extra = {}) {
      return createOperations({ layout: L, log, packages, runtime: H.runtime, bus: H.bus, mux: H.mux, adapter: H.adapter, safeMode, recovery: H.recovery, healthWindowMs, migrationTimeoutMs: 5000, ...(patchWaitMs ? { patchWaitMs } : {}), ...extra });
    },
    /** Builds a signed archive for a manifest (defaults filled). */
    async pack(over = {}, files = {}, k = H.key) {
      const manifest = baseManifest(over);
      return (await buildSigned(t.root, manifest, k, files)).archive;
    },
    async devDir(over = {}, files = {}) { return writeModDir(t.root, baseManifest(over), files); },
    async run(input, ops = H.ops) { const id = await ops.start(input); return ops.whenSettled(id); },
    async installApprove(over = {}, { files, enable = false, k } = {}, ops = H.ops) {
      const archive = await H.pack(over, files, k);
      const i = await H.run({ type: 'install', source: archive }, ops);
      if (i.outcome !== 'succeeded') throw new Error(`install: ${JSON.stringify(i)}`);
      const modId = baseManifest(over).id;
      const c = await H.run({ type: 'consent', modId, approve: true, enable }, ops);
      if (c.outcome !== 'succeeded') throw new Error(`consent: ${JSON.stringify(c)}`);
      return modId;
    },
    async readState() { return JSON.parse(await readFile(L.state, 'utf8')); },
    async readData(id, name = 'store.json') { try { return await readFile(join(L.data, id, name), 'utf8'); } catch { return undefined; } },
    async writeData(id, text, name = 'store.json') { await mkdir(join(L.data, id), { recursive: true }); await writeFile(join(L.data, id, name), text); },
    async ls(dir) { try { return (await readdir(dir)).sort(); } catch { return []; } },
    /** Orphaned generations of a mod (names, oldest first) and the content of a file in one of them (newest by default). */
    async orphanGens(id) { return (await H.ls(join(L.orphaned, id))).filter((n) => /^\d{4}-\d\d-\d\dT/.test(n)); },
    async orphanData(id, at, name = 'store.json') {
      const gens = await H.orphanGens(id);
      const use = at ?? gens.at(-1);
      if (!use) return undefined;
      try { return await readFile(join(L.orphaned, id, use, name), 'utf8'); } catch { return undefined; }
    },
    async exists(p) { return stat(p).then(() => true, () => false); },
  };
  /** A crashAt hook that kills the instance at `point`, plus a promise that resolves once it has. */
  H.crashAt = (point) => {
    let resolve; const crashed = new Promise((r) => { resolve = r; });
    return { crashed, crashAt: (n) => { if (n === point) { resolve(); throw new Error(`injected crash at ${n}`); } } };
  };
  /** Resolves when `ops` has recorded (persisted and announced) an op update carrying `note` — e.g. a framework op left 'running'. */
  H.recorded = (ops, opId, note) => new Promise((resolve) => {
    const sub = ops.subscribe((o) => { if (o.id === opId && o.note === note) { sub.dispose(); resolve(o); } });
    const cur = ops.get(opId); if (cur?.note === note) { sub.dispose(); resolve(cur); }
  });
  H.ops = H.create();
  return H;
}
