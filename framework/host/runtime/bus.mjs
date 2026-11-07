// Event bus (contracts/host.d.ts Bus).
//
// - Exact topics and trailing-`*` prefix patterns.
// - State topics (publish with {state:true}) are remembered; subscribers may ask for replay:'state'.
// - Every subscriber has its own bounded queue (default 1000). When it is full, further matching messages are dropped and a
//   single {gap:{from,to,reason:'overflow'}} marker is delivered in their place, so a slow subscriber never slows the publisher.
// - Dispatch cost: exact subscribers are found with one Map lookup and prefix subscribers with one Map lookup per prefix length
//   of the published topic, so cost is independent of the number of subscribers that do NOT match.
import { CodexModsError } from '../../../sdk/errors.mjs';

export const DEFAULT_QUEUE = 1000;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
function snapshot(data) {
  if (data === null || typeof data !== 'object') return data;
  try { return deepFreeze(structuredClone(data)); }
  catch { throw new CodexModsError('Invalid', 'bus data must be JSON'); }
}

/** @param {{log?: import('../../../contracts/host.js').Log}} opts */
export function createBus({ log } = {}) {
  /** @type {Map<string, Set<any>>} */ const exact = new Map();
  /** @type {Map<string, Set<any>>} */ const prefixes = new Map();
  /** @type {Map<string, any>} */ const states = new Map();
  let maxPrefixLen = -1;

  function enqueue(sub, topic, data) {
    if (sub.closed) return;
    const pending = sub.queue.length - sub.head;
    sub.seq += 1;
    if (pending >= sub.cap) {
      if (sub.openGap) sub.openGap.to = sub.seq;
      else {
        sub.openGap = { from: sub.seq, to: sub.seq };
        sub.queue.push({ gap: sub.openGap, topic: sub.pattern });
      }
    } else {
      sub.openGap = null;
      sub.queue.push({ data, topic });
    }
    if (!sub.scheduled) { sub.scheduled = true; queueMicrotask(() => drain(sub)); }
  }

  function drain(sub) {
    sub.scheduled = false;
    while (sub.head < sub.queue.length && !sub.closed) {
      const item = sub.queue[sub.head++];
      if (item.gap && sub.openGap === item.gap) sub.openGap = null;
      const payload = item.gap ? { gap: { from: item.gap.from, to: item.gap.to, reason: 'overflow' } } : item.data;
      try { sub.fn(payload, item.topic); }
      catch (e) { log?.warn?.('bus subscriber threw', { pattern: sub.pattern, message: String(e?.message ?? e) }); }
    }
    sub.queue.length = 0; sub.head = 0;
  }

  return {
    publish(topic, data, opts = {}) {
      if (typeof topic !== 'string' || !topic) throw new CodexModsError('Invalid', 'topic must be a non-empty string');
      let shared;
      let get = () => (shared ??= snapshot(data));
      if (opts.state) { shared = snapshot(data); states.set(topic, shared); get = () => shared; }
      const e = exact.get(topic);
      if (e) for (const sub of [...e]) enqueue(sub, topic, get());
      if (maxPrefixLen >= 0) {
        const top = Math.min(topic.length, maxPrefixLen);
        for (let len = 0; len <= top; len++) {
          const set = prefixes.get(topic.slice(0, len));
          if (set) for (const sub of [...set]) enqueue(sub, topic, get());
        }
      }
    },

    subscribe(pattern, fn, opts = {}) {
      if (typeof pattern !== 'string' || !pattern) throw new CodexModsError('Invalid', 'pattern must be a non-empty string');
      const star = pattern.indexOf('*');
      if (star !== -1 && star !== pattern.length - 1) throw new CodexModsError('Invalid', 'only a trailing * is allowed in a topic pattern');
      const isPrefix = star !== -1;
      const key = isPrefix ? pattern.slice(0, -1) : pattern;
      const cap = Number.isInteger(opts.queue) && opts.queue > 0 ? opts.queue : DEFAULT_QUEUE;
      const sub = { fn, pattern, cap, queue: [], head: 0, seq: 0, openGap: null, scheduled: false, closed: false };
      const index = isPrefix ? prefixes : exact;
      let set = index.get(key);
      if (!set) { set = new Set(); index.set(key, set); }
      set.add(sub);
      if (isPrefix) maxPrefixLen = Math.max(maxPrefixLen, key.length);
      if (opts.replay === 'state') {
        if (isPrefix) { for (const [topic, value] of states) if (topic.startsWith(key)) enqueue(sub, topic, value); }
        else if (states.has(key)) enqueue(sub, key, states.get(key));
      }
      return {
        dispose() {
          if (sub.closed) return;
          sub.closed = true;
          const s = index.get(key);
          if (s) { s.delete(sub); if (s.size === 0) index.delete(key); }
          sub.queue.length = 0; sub.head = 0;
        },
      };
    },

    state(topic) { return states.get(topic); },
  };
}
