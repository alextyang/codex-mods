'use strict';
// The Dock's badge as the graph's DockBadge sets it (docs/design/systems.md "E7 in detail" decision 5, E7.6b): a mod's value shows while
// the mod holds it, the latest holder's first; a holder letting go (`null`, or stopping: the Host lets go for it) gives the badge back
// to the previous holder, then to the app's own count, which the adapter keeps from the start (the app's setBadgeCount calls pass
// through only while no one holds it).
const kit = require('../area-kit.cjs');

const HOLDER = /^[A-Za-z0-9._-]{1,128}(:[A-Za-z0-9._-]{1,64})?$/;   // a mod, and its badge's key
const isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 99999;
// a count, text, or `{add: n}`: the app's own count and n (public-hooks.md §3.14 `combine: 'add'`)
const isValue = (v) => isCount(v) || (typeof v === 'string' && v.length > 0 && v.length <= 16)
  || (v !== null && typeof v === 'object' && Object.keys(v).length === 1 && isCount(v.add));

function register(hooks) {
  const holders = new Map();   // holder -> value, the latest last
  const hookOf = () => (hooks.electron && typeof hooks.electron.badge === 'function' ? hooks.electron.badge() : null);
  // the app's own count is kept from framework-main's start, before any mod holds the badge
  try { hookOf(); } catch (e) { try { hooks.log?.warn('dock: the badge could not be kept', { message: String(e?.message ?? e) }); } catch { /* logging is best effort */ } }
  hooks.onAreaOp('dock', async (op, args = {}) => {
    if (op === 'attention') {
      if (args?.kind !== 'informational' && args?.kind !== 'critical') throw kit.refusal('attention is informational or critical');
      const attention = hooks.electron && typeof hooks.electron.attention === 'function' ? hooks.electron.attention : null;
      if (!attention || attention(args.kind) !== true) throw kit.refusal('the Dock cannot ask for attention here');
      return {};
    }
    if (op !== 'badge') throw kit.refusal(`unknown operation ${op}`);
    const holder = args && args.holder;
    if (typeof holder !== 'string' || !HOLDER.test(holder)) throw kit.refusal('a holder is needed');
    const value = args.value === undefined ? null : args.value;
    if (value !== null && !isValue(value)) throw kit.refusal('a badge is a count (0 to 99999), text of at most 16 characters, {add: count}, or null');
    const badge = hookOf();
    if (!badge) throw kit.refusal('the Dock badge is not available here');
    if (value !== null && typeof value === 'string' && !badge.text) throw kit.refusal('this system shows only a count in the Dock');
    holders.delete(holder);
    if (value !== null) holders.set(holder, value);
    const latest = [...holders.values()].pop();
    badge.hold(latest === undefined ? null : latest);
    return { showing: latest === undefined ? 'app' : 'held' };
  });
}

module.exports = { register };
