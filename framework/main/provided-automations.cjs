'use strict';
// A mod's Automations in the app's Scheduled page (public-hooks.md §3.15, H7pa; the Host's provided-automations.mjs): what the Host says
// they are now, as the app's own items. The automations service's `list` adds them for the app's pages, never for framework-main's own
// reads or the agent's tool (the codex provider and the agent see only the app's own). An app id of one starts with `codexmods-`: the
// service's update, delete and run now of one are its provider's operations, asked of the Host as the user's (never the app's own call:
// its files and scheduler know nothing of them). Their runs are their provider's chats, not the app's, so none is in its history.
const PREFIX = 'codexmods-';
const clone = (x) => JSON.parse(JSON.stringify(x));

function createProvided() {
  let items = [], json = '[]';
  // every app id the Host ever said is a mod's (built review H7pa round 1): one gone since (its mod removed, the Host away) is still
  // routed to the Host, which refuses it, never to the app's own service; another's id that only looks like one is the app's
  const ids = new Set();
  const take = (i) => {
    const j = JSON.stringify(i);
    if (j === json) return false;
    items = i; json = j;
    for (const x of i) ids.add(x.id);
    return true;
  };
  return {
    /** The Host's word on them now: whether it changed. */
    set(next) {
      return take(Array.isArray(next && next.items) ? next.items.filter((x) => x && typeof x.id === 'string' && x.id.startsWith(PREFIX)) : []);
    },
    /** The Host went: none of them is shown (they are still its to refuse). Whether it changed. */
    hostDown: () => take([]),
    isProvided: (id) => typeof id === 'string' && ids.has(id),
    item: (id) => { const x = items.find((it) => it.id === id); return x ? clone(x) : null; },
    /** The service's list with theirs after the app's own. */
    addToList(result) {
      if (!result || !Array.isArray(result.items) || !items.length) return result;
      const own = new Set(result.items.map((x) => x && x.id));
      return { ...result, items: [...result.items, ...items.filter((x) => !own.has(x.id)).map(clone)] };
    },
  };
}

const shared = new WeakMap();
/** One per framework-main (its hooks). */
function providedOf(hooks) {
  let p = shared.get(hooks);
  if (!p) { p = createProvided(); shared.set(hooks, p); }
  return p;
}

module.exports = { createProvided, providedOf, PREFIX };
