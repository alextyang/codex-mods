// ctx.storage / ctx.storage.retained → one JSON file per store, written atomically (fsutil.writeJsonAtomic).
//
// Concurrency: every store has an in-memory revision counter (not persisted). A plain set/delete bumps it. A realm-side
// transaction takes a snapshot {revision, data}, runs its function in the realm, then asks the Host to commit its writes
// with the revision it saw; the Host applies them only if the revision is unchanged (otherwise Conflict). All writes are
// serialized by a per-store queue, so check-and-apply is atomic.
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { readJson, writeJsonAtomic } from '../fsutil.mjs';

const MAX_KEY = 1024;

function checkKey(key) {
  if (typeof key !== 'string' || key === '' || key.length > MAX_KEY) throw new CodexModsError('Invalid', 'storage key must be a non-empty string of at most 1024 characters');
  return key;
}
function checkValue(value) {
  if (value === undefined) throw new CodexModsError('Invalid', 'storage value must be JSON');
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new CodexModsError('Invalid', 'storage value must be JSON'); }
}

export class KvStore {
  constructor(path) {
    this.path = path;
    this.revision = 0;
    this.data = null;                 // Map<string, Json>, loaded lazily
    this.watchers = new Set();        // {prefix, fn}
    this.loading = null;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async load() {
    if (this.data) return;
    this.loading ??= (async () => {
      let raw;
      try { raw = await readJson(this.path, undefined); }
      catch (e) { throw new CodexModsError('Unavailable', `store file is unreadable: ${e.message}`); }
      const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : {};
      this.data = new Map(Object.entries(data));
    })();
    try { await this.loading; } finally { if (!this.data) this.loading = null; }
  }

  async get(key) { await this.load(); checkKey(key); return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined; }
  async list(prefix = '') {
    await this.load();
    if (typeof prefix !== 'string') throw new CodexModsError('Invalid', 'prefix must be a string');
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async snapshot() {
    await this.load();
    return { revision: this.revision, data: Object.fromEntries(this.data) };
  }

  /** ops: [{op:'set', key, value} | {op:'delete', key}]. expectedRevision: undefined = unconditional. */
  commit(ops, expectedRevision) {
    const run = async () => {
      await this.load();
      if (this.closed) throw new CodexModsError('Disposed', 'store is closed');
      if (expectedRevision !== undefined && expectedRevision !== this.revision) {
        throw new CodexModsError('Conflict', 'storage changed since the transaction snapshot');
      }
      const next = new Map(this.data);
      const touched = new Set();
      for (const o of ops) {
        checkKey(o.key);
        if (o.op === 'set') next.set(o.key, checkValue(o.value));
        else if (o.op === 'delete') next.delete(o.key);
        else throw new CodexModsError('Invalid', 'unknown storage operation');
        touched.add(o.key);
      }
      if (touched.size === 0) return;
      await writeJsonAtomic(this.path, { format: 1, data: Object.fromEntries(next) });
      this.data = next;
      this.revision += 1;
      const keys = [...touched].sort();
      for (const w of [...this.watchers]) {
        const hit = keys.filter((k) => k.startsWith(w.prefix));
        if (hit.length) { try { w.fn(hit); } catch { /* a watcher must not break commits */ } }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  set(key, value) { return this.commit([{ op: 'set', key, value }]); }
  delete(key) { return this.commit([{ op: 'delete', key }]); }

  watch(prefix, fn) {
    if (typeof prefix !== 'string') throw new CodexModsError('Invalid', 'prefix must be a string');
    const w = { prefix, fn };
    this.watchers.add(w);
    return { dispose: () => { this.watchers.delete(w); } };
  }
  async close() { await this.queue; this.closed = true; this.watchers.clear(); }
}

/** Store for a mod, cached on its runtime state: kind 'main' → data/<id>/store.json, 'retained' → retained/<id>/store.json. */
export function storeFor(state, kind) {
  state.stores[kind] ??= new KvStore(join(kind === 'retained' ? state.mod.retainedDir : state.mod.dataDir, 'store.json'));
  return state.stores[kind];
}

export function createStorageNs(kind) {
  const s = (scope) => storeFor(scope.state, kind);
  return {
    calls: {
      get: (scope, key) => s(scope).get(key),
      set: (scope, key, value) => s(scope).set(key, value),
      delete: (scope, key) => s(scope).delete(key),
      list: (scope, prefix) => s(scope).list(prefix),
      snapshot: (scope) => s(scope).snapshot(),
      commit(scope, revision, ops) {
        if (!Number.isInteger(revision) || !Array.isArray(ops)) throw new CodexModsError('Invalid', 'commit needs (revision, ops[])');
        return s(scope).commit(ops, revision);
      },
    },
    subs: {
      watch: (scope, [prefix], emit) => s(scope).watch(prefix, (keys) => emit(keys)),
    },
  };
}
