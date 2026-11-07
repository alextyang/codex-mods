// Affinity table: key -> {client, backend}, bounded, LRU (ARCHITECTURE §6.3, requirement 5). It knows paths, not threads.
export const AFFINITY_MAX = 100_000;

export function createAffinity({ max = AFFINITY_MAX } = {}) {
  const map = new Map(); // insertion order == recency order
  function touch(key, e) { map.delete(key); map.set(key, e); }
  function evict() { while (map.size > max) map.delete(map.keys().next().value); }
  return {
    get size() { return map.size; },
    /** Reads and refreshes recency. */
    get(key) { const e = map.get(key); if (e) touch(key, e); return e; },
    peek(key) { return map.get(key); },
    set(key, entry) { map.delete(key); map.set(key, { client: entry.client, backend: entry.backend }); evict(); },
    /** Change the backend only; keep the owner. Missing keys are created unowned. */
    repin(key, backend) {
      const e = map.get(key);
      if (e) { e.backend = backend; touch(key, e); } else { map.set(key, { client: null, backend }); evict(); }
    },
    unownClient(clientId) { for (const e of map.values()) if (e.client === clientId) e.client = null; },
    delete(key) { return map.delete(key); },
    /** Re-pin entries from one backend to another (or delete them when `to` is null). */
    moveBackend(from, to) { for (const [k, e] of map) if (e.backend === from) { if (to) e.backend = to; else map.delete(k); } },
    dropBackend(backendId) { for (const [k, e] of map) if (e.backend === backendId) map.delete(k); },
    clear() { map.clear(); },
  };
}
