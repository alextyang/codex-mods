// Thread subscriptions per client (mux additions 11 and 4b, docs/design/runtime-core.md R12, R13). A client is subscribed to a thread
// after a successful thread/start, thread/resume, thread/fork or turn/start on it, until its own thread/unsubscribe, its disconnection, or
// the backend holding the thread restarts. The first subscriber is kept first (insertion order). It knows keys and client ids, not threads.

/**
 * @param {{ onChange?: (key: string, open: boolean) => void }} [o]  told when a key gains its first subscriber (open) or loses its last
 *   (closed), whatever the cause: a request, an unsubscribe, a disconnection or a backend restart
 */
export function createSubscriptions(o = {}) {
  const byKey = new Map();      // key -> Set<clientId>
  const byClient = new Map();   // clientId -> Set<key>
  const changed = (key, open) => { try { o.onChange?.(key, open); } catch { /* the listener's fault is its own */ } };
  const link = (m, a, b) => { let s = m.get(a); if (!s) m.set(a, (s = new Set())); s.add(b); };
  const unlink = (m, a, b) => { const s = m.get(a); if (!s) return false; const had = s.delete(b); if (!s.size) m.delete(a); return had; };
  /** Unlink a client from a key on the key side, telling when the key closes. */
  const unlinkKey = (key, clientId) => { const had = unlink(byKey, key, clientId); if (had && !byKey.has(key)) changed(key, false); return had; };
  return {
    add(key, clientId) { const fresh = !byKey.has(key); link(byKey, key, clientId); link(byClient, clientId, key); if (fresh) changed(key, true); },
    /** True when the client was subscribed. */
    remove(key, clientId) { unlink(byClient, clientId, key); return unlinkKey(key, clientId); },
    has(key, clientId) { return byKey.get(key)?.has(clientId) === true; },
    /** Subscribed client ids, first subscriber first. */
    clientsOf(key) { return [...(byKey.get(key) ?? [])]; },
    size(key) { return byKey.get(key)?.size ?? 0; },
    removeClient(clientId) {
      const keys = [...(byClient.get(clientId) ?? [])];
      byClient.delete(clientId);
      for (const key of keys) unlinkKey(key, clientId);
    },
    /** Forget every subscription to the keys `drop(key)` selects (their backend restarted). */
    dropKeys(drop) {
      for (const key of [...byKey.keys()]) {
        if (!drop(key)) continue;
        for (const clientId of byKey.get(key)) unlink(byClient, clientId, key);
        byKey.delete(key);
        changed(key, false);
      }
    },
    clear() { byKey.clear(); byClient.clear(); },
  };
}
