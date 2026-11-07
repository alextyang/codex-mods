// Which graph instance an id the app shows stands for (docs/design/presentations.md V6). Every chat, turn and item the app shows is Codex's
// own (the app's store holds no other provider's chat: graph-integrity G2.1), whose graph ref the caller builds (a thread's is its
// protocol id). A request card's id is the one the app was asked with: the Host knows which Request it is, which the page asks once per id
// (batched, through the framework's ctx.present). Until that answer arrives the binding sees no subject (the app's own rendering).
// NO NODE API.

/**
 * @param {{ present: { requestsOf?(ids: string[]): Promise<object> } | null | undefined,
 *   schedule: (fn: () => void) => void, onChange: (keys: string[]) => void, native?: (id: string) => object }} o
 *   `onChange` gets the keys that were answered: `req:<id>` for request ids.
 */
export function createThreadSubjects(o) {
  const nativeThread = o.native ?? ((id) => ({ type: 'CodexThread', provider: 'codex', id }));
  /** One batched lookup: id -> answer (a ref, or null), asked once, asked again only after a failed batch. */
  function lookups(ask, key) {
    const known = new Map();
    const asked = new Set();
    let queue = [];
    let scheduled = false;
    function flush() {
      scheduled = false;
      const ids = queue;
      queue = [];
      if (!ids.length) return;
      const ready = (map) => { for (const id of ids) known.set(id, (map && map[id]) || null); o.onChange(ids.map(key)); };
      if (!o.present || !ask()) { ready(null); return; }
      Promise.resolve().then(() => ask()(ids)).then(ready, () => { for (const id of ids) asked.delete(id); });   // asked again on the next render
    }
    /** The answer for an id, or undefined while it is being looked up. */
    return (id) => {
      if (known.has(id)) return known.get(id);
      if (!asked.has(id)) {
        asked.add(id);
        queue.push(id);
        if (!scheduled) { scheduled = true; o.schedule(flush); }
      }
      return undefined;
    };
  }
  const requests = lookups(() => o.present?.requestsOf && ((ids) => o.present.requestsOf(ids)), (id) => `req:${id}`);
  const bare = (id) => (id.startsWith('local:') ? id.slice(6) : id);
  return {
    /** The ref for a thread id the app shows (its own chat), or null for none. */
    thread(id) {
      if (typeof id !== 'string' || !id) return null;
      return nativeThread(bare(id));
    },
    /** Whether the app's own store holds this chat (a ref this map gave for the app's own id): its own entries all work on it. */
    holds: (ref) => !!ref && ref.provider === nativeThread('x').provider,
    /** The ref for any other id the app shows (a turn's, an item's): `native(id)`, Codex's own; null for none. */
    of(id, native) {
      if (typeof id !== 'string' || !id) return null;
      return native(id);
    },
    /** The Request a request card shows, by the id the app was asked with, or null (not known yet, or not a pending request). */
    request(id) {
      if (typeof id !== 'string' || !id) return null;
      return requests(id) ?? null;
    },
  };
}
