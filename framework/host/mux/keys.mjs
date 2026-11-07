// Mux addition 1, key families (docs/design/runtime-core.md R14; integration.md §7 "What the mux needs" 1). Every frame's keys are recorded
// once, as the mux observes it: thread, turn, item, process and watch ids, each with the thread it belongs to and the backend it lives on.
// A key's owner is its thread's owner (the affinity table), read at lookup. Bounded, least recently used first out. It knows paths, not
// threads' meaning.

export const FAMILIES = Object.freeze(['thread', 'turn', 'item', 'process', 'watch']);
export const KEYS_MAX = 100_000;

const str = (v) => (typeof v === 'string' && v ? v : undefined);

/** The keys a frame names: [{family, key, thread?}]. */
export function keysOf(msg) {
  const p = msg?.params ?? {}, r = msg?.result ?? {};
  const thread = str(p.threadId) ?? str(p.thread?.id) ?? str(r.thread?.id);
  const out = [];
  if (thread) out.push({ family: 'thread', key: thread, thread });
  const turn = str(p.turnId) ?? str(p.turn?.id) ?? str(r.turn?.id);
  if (turn) out.push({ family: 'turn', key: turn, thread });
  const item = str(p.itemId) ?? str(p.item?.id);
  if (item) out.push({ family: 'item', key: thread ? `${thread}:${item}` : item, thread });
  const proc = str(p.processId) ?? (typeof p.processId === 'number' ? String(p.processId) : undefined);
  if (proc) out.push({ family: 'process', key: proc, thread });
  const watch = str(p.watchId);
  if (watch) out.push({ family: 'watch', key: watch, thread });
  return out;
}

export function createKeyTable({ max = KEYS_MAX } = {}) {
  const map = new Map();   // `${family}\n${key}` -> {family, key, thread, backend}
  const id = (family, key) => `${family}\n${key}`;
  return {
    /** Record a frame's keys on a backend. A key keeps the thread it was first seen with when a later frame does not name one. */
    note(msg, backend) {
      for (const k of keysOf(msg)) {
        const kid = id(k.family, k.key);
        const prev = map.get(kid);
        if (prev) map.delete(kid);
        map.set(kid, { family: k.family, key: k.key, thread: k.thread ?? prev?.thread, backend });
      }
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get(family, key) { return map.get(id(family, key)) ?? null; },
    dropBackend(backend) { for (const [k, e] of map) if (e.backend === backend) map.delete(k); },
    get size() { return map.size; },
    clear() { map.clear(); },
  };
}
