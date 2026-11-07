// Migration worker: runs a mod's data/migrate script against a STAGED copy of its data (ARCHITECTURE §8.5, §11.4).
//
// ISOLATION IS API-ONLY. The only framework API this worker is given is MigrationInput over the staged directory: no mux
// client, no services, no processes, no leases, no Keychain. Nothing here removes Node itself: the script can still
// `import 'node:child_process'`, `node:fs`, `node:net`, `fetch`, etc., exactly like any other mod code, because mod code is
// trusted code running with the user's authority (ARCHITECTURE §13). Resource limits and the Host's timeout bound
// accidents, not malice.
import { parentPort, workerData } from 'node:worker_threads';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KvStore } from '../ctx/storage.mjs';
import { declarationsOf, documentOf } from '../packages/settings.mjs';

const { script, stagedDataDir, from, to, schema } = workerData;

function readSettingsSync(file = 'settings.json') {
  try { return JSON.parse(readFileSync(join(stagedDataDir, file), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
function writeSettingsSync(value, file = 'settings.json') {
  JSON.stringify(value); // throws if not JSON
  mkdirSync(stagedDataDir, { recursive: true, mode: 0o700 });
  const tmp = join(stagedDataDir, `.settings-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(stagedDataDir, file));
}

// A migration that never settles must not make the worker exit by itself (Node ends a worker whose event loop is empty
// with code 13): keep it alive so the Host's timeout is what ends it and the outcome is Timeout.
const keepAlive = setInterval(() => {}, 1 << 30);
try {
  const module = await import(script);
  const migrate = typeof module.migrate === 'function' ? module.migrate
    : typeof module.default?.migrate === 'function' ? module.default.migrate
      : typeof module.default === 'function' ? module.default : null;
  if (!migrate) throw new Error('the migration script exports no migrate function');
  const store = new KvStore(join(stagedDataDir, 'store.json'));
  const storage = {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
    list: (p) => store.list(p),
    async transaction(fn) {
      const snap = await store.snapshot();
      const base = new Map(Object.entries(snap.data)); const writes = new Map();
      const tx = {
        get: (k) => (writes.has(k) ? (writes.get(k).delete ? undefined : structuredClone(writes.get(k).value)) : base.has(k) ? structuredClone(base.get(k)) : undefined),
        set: (k, v) => { writes.set(k, { value: structuredClone(v) }); },
        delete: (k) => { writes.set(k, { delete: true }); },
        list: (prefix = '') => { const keys = new Set(base.keys()); for (const [k, w] of writes) { if (w.delete) keys.delete(k); else keys.add(k); } return [...keys].filter((k) => k.startsWith(prefix)).sort(); },
      };
      const r = fn(tx);
      if (writes.size) await store.commit([...writes].map(([key, w]) => (w.delete ? { op: 'delete', key } : { op: 'set', key, value: w.value })), snap.revision);
      return r;
    },
    watch: (prefix, fn) => store.watch(prefix, fn),
  };
  const settings = {
    get: () => documentOf(declarationsOf({ settings: schema }).list, readSettingsSync() ?? {}),
    set: (value) => writeSettingsSync(value),
    // The overrides at narrower scopes (docs/design/systems.md E3: settings.scopes.json): {"<scope key>": {key: value}}.
    scopes: {
      get: () => readSettingsSync('settings.scopes.json') ?? {},
      set: (value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('settings.scopes.set takes an object of scopes');
        writeSettingsSync(value, 'settings.scopes.json');
      },
    },
  };
  await migrate({ from, to, storage, settings, files: join(stagedDataDir, 'files') });
  await store.close();
  clearInterval(keepAlive);
  parentPort.postMessage({ t: 'done' });
} catch (e) {
  clearInterval(keepAlive);
  parentPort.postMessage({ t: 'error', message: String(e?.message ?? e) });
}
